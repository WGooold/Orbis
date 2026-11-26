import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { parse as parseYaml } from "yaml";
import { afterEach, describe, expect, it } from "vitest";
import { parseJson5 } from "./json5-document.js";
import { applyProviderFields, newProviderConfig, providerFields } from "./provider-form.js";
import { agentKind, ProviderManager, providerKind } from "./provider-manager.js";
import { parseProviderRequest } from "./provider-messages.js";
import { nativeProviderFile, nativeProviderKinds, readNativeProviders, selectNativeProvider, writeNativeProvider, type NativeProviderKind } from "./provider-native.js";
import { hermesBuiltinProviderIds, nativeProviderPresets } from "./provider-native-presets.js";
import { providerPresets } from "./provider-presets.js";
import { claudeProviderPresets } from "./claude-provider-presets.js";
import { PROTOCOL_VERSION } from "@orbis/protocol";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture(sources: Partial<Record<NativeProviderKind, string>> = {}) {
  const root = await mkdtemp(join(tmpdir(), "orbis-native-")); roots.push(root);
  const paths = { pi: join(root, "pi"), codex: join(root, "codex"), dsh: join(root, "dsh"), opencode: join(root, "opencode"), openclaw: join(root, "openclaw"), hermes: join(root, "hermes"), kimiCode: join(root, "kimi") };
  const file = (kind: NativeProviderKind): string => nativeProviderFile(kind, paths[kind]);
  for (const [kind, source] of Object.entries(sources)) { const path = file(kind as NativeProviderKind); await mkdir(dirname(path), { recursive: true }); await writeFile(path, source); }
  return { manager: new ProviderManager(join(root, "state"), paths), read: (kind: NativeProviderKind) => readFile(file(kind), "utf8") };
}
const samples: Record<NativeProviderKind, string> = {
  opencode: `{\n  // theme\n  "theme": "x",\n  "model": "relay/m1",\n  "provider": {\n    "relay": { "npm": "@ai-sdk/openai-compatible", "name": "Relay", "options": { "baseURL": "https://r/v1", "apiKey": "{env:KEY}", "future": 1 }, "models": { "m1": { "name": "One", "future": true } } }, // relay\n  },\n}\n`,
  openclaw: `{\n  // gateway\n  gateway: { port: 18789 },\n  models: { mode: 'merge', providers: { relay: { baseUrl: 'https://r/v1', apiKey: { source: 'env', id: 'KEY' }, api: 'openai-completions', models: [{ id: 'm1', name: 'One', input: ['text', 'audio'], cost: { input: 1, output: 2 } }] } } },\n  agents: { defaults: { model: { primary: 'relay/m1', fallbacks: ['x/y'] }, models: { 'relay/m1': {} } } },\n}\n`,
  hermes: `# top comment\nmodel:\n  default: m1  # chosen\n  provider: relay\n  base_url: https://keep\nagent:\n  flag: yes\n  at: 12:30\n# providers below\ncustom_providers:\n- name: relay\n  base_url: https://r/v1\n  api_key: secret  # key\n  model: m1\n  models:\n    m1:\n      context_length: 1000\n      future: 1\n  request_timeout_seconds: 9\nproviders:\n  overlay:\n    base_url: https://o/v1\n    models: {o1: {}}\n# trailing\n`,
  kimiCode: `# kimi\ndefault_model = "relay/m1"\ntheme = "dark"\n\n[providers.relay]\ntype = "openai"\nbase_url = "https://r/v1"\napi_key = "secret"\nfuture = 1\n\n[providers."managed:kimi-code"]\ntype = "kimi"\nbase_url = "https://api.kimi.com/coding/v1"\napi_key = ""\noauth = { storage = "file", key = "oauth/kimi-code" }\n\n[models."relay/m1"]\nprovider = "relay"\nmodel = "m1"\nmax_context_size = 1000\ncapabilities = ["tool_use", "video_in"]\n\n[models."kimi-code/k3"]\nprovider = "managed:kimi-code"\nmodel = "k3"\nmax_context_size = 262144\n\n[loop]\nmax = 3\n`,
};
const parse: Record<NativeProviderKind, (text: string) => any> = { opencode: parseJson5, openclaw: parseJson5, hermes: text => parseYaml(text, { version: "1.1" }), kimiCode: parseToml };
const added = (kind: NativeProviderKind) => {
  const base = { providerKey: "fresh", baseUrl: "https://f/v1", apiKey: "k", model: "", api: "openai-completions", headers: {} };
  return applyProviderFields(kind, newProviderConfig(kind), { ...base, models: [{ id: "f1", name: "F One", input: ["text", "image"], contextWindow: 2000, maxTokens: 500, reasoning: true }] }, true);
};

describe("native additive providers", () => {
  it("imports existing nodes, their default and their credentials references without writing", async () => {
    const { manager, read } = await fixture(samples);
    for (const kind of nativeProviderKinds) {
      const rows = await manager.list(kind);
      expect(rows.find(row => row.id === "relay"), kind).toMatchObject({ enabled: true, mode: "additive", globalDefault: true, canSetDefault: false });
      expect(await read(kind)).toBe(samples[kind]);
    }
    expect((await manager.list("hermes")).find(row => row.id === "overlay")).toMatchObject({ enabled: true, readOnly: true });
    expect((await manager.list("kimiCode")).find(row => row.id === "managed:kimi-code")).toMatchObject({ official: true, category: "official" });
  });
  it("is a no-op for an unchanged form and keeps fields outside the form", () => {
    for (const kind of nativeProviderKinds) {
      const config = readNativeProviders(kind, samples[kind]).providers.relay!;
      const fields = providerFields({ kind, id: "relay", name: "relay", config });
      expect(applyProviderFields(kind, config, fields), kind).toEqual(config);
      const edited = applyProviderFields(kind, config, { ...fields, baseUrl: "https://new/v1", apiKey: "changed" });
      expect(JSON.stringify(edited), kind).toContain("https://new/v1");
      expect(JSON.stringify(edited).replace("https://new/v1", "https://r/v1"), kind).toContain("changed");
    }
  });
  it("round-trips the form, adds, renames, defaults and removes only its own nodes", async () => {
    const { manager, read } = await fixture(samples);
    for (const kind of nativeProviderKinds) {
      const config = added(kind);
      const fields = providerFields({ kind, id: "fresh", name: "Fresh", config });
      expect(fields, kind).toMatchObject({ providerKey: "fresh", baseUrl: "https://f/v1", apiKey: "k", api: "openai-completions" });
      expect(fields.models![0], kind).toMatchObject({ id: "f1", input: ["text", "image"], contextWindow: 2000 });
      let rows = await manager.save(kind, "fresh", "Fresh", config, true);
      expect(rows.find(row => row.id === "fresh"), kind).toMatchObject({ enabled: true, globalDefault: false, name: "Fresh" });
      rows = await manager.setDefault(kind, "fresh");
      expect(rows.find(row => row.id === "fresh")!.globalDefault, kind).toBe(true);
      expect(rows.find(row => row.id === "relay")!.globalDefault, kind).toBe(false);
      rows = await manager.setDefault(kind, "relay");
      rows = await manager.switch(kind, "fresh", false);
      expect(rows.find(row => row.id === "fresh"), kind).toMatchObject({ enabled: false, name: "Fresh" });
      rows = await manager.copy(kind, "relay");
      expect(rows.find(row => row.id === "relay-copy"), kind).toMatchObject({ enabled: false });
      rows = await manager.switch(kind, "relay-copy", true);
      expect(rows.find(row => row.id === "relay-copy")!.enabled, kind).toBe(true);
      rows = await manager.remove(kind, "relay-copy"); rows = await manager.remove(kind, "fresh");
      const before = parse[kind](samples[kind]), after = parse[kind](await read(kind));
      if (kind === "openclaw") delete after.agents.defaults.models["fresh/f1"];
      expect(after, kind).toEqual(before);
    }
    expect(await read("opencode")).toContain("// theme"); expect(await read("opencode")).toContain("// relay");
    expect(await read("openclaw")).toContain("// gateway");
    for (const comment of ["# top comment", "# chosen", "# providers below", "# key", "# trailing", "flag: yes", "at: 12:30"]) expect(await read("hermes")).toContain(comment);
    expect(await read("kimiCode")).toContain("# kimi");
  });
  it("creates each native file from nothing and can enable the first provider", async () => {
    const { manager, read } = await fixture();
    for (const kind of nativeProviderKinds) {
      expect(await manager.list(kind)).toEqual([]);
      await manager.save(kind, "fresh", "Fresh", added(kind), true);
      expect((await manager.setDefault(kind, "fresh"))[0], kind).toMatchObject({ enabled: true, globalDefault: true });
      expect(readNativeProviders(kind, await read(kind)).defaultId).toBe("fresh");
    }
    expect(parseJson5(await read("openclaw"))).toMatchObject({ models: { mode: "merge" }, agents: { defaults: { model: { primary: "fresh/f1" } } } });
    expect(parse.hermes(await read("hermes"))).toMatchObject({ model: { provider: "fresh", default: "f1" }, custom_providers: [{ name: "fresh", model: "f1", models: { f1: { context_length: 2000, supports_vision: true } } }] });
  });
  it("keeps Agent-owned selections valid", async () => {
    const { manager } = await fixture(samples);
    await expect(manager.switch("kimiCode", "relay", false)).rejects.toThrow("设为默认");
    await expect(manager.remove("kimiCode", "relay")).rejects.toThrow("设为默认");
    await expect(manager.remove("hermes", "overlay")).rejects.toThrow("Hermes");
    expect((await manager.setDefault("hermes", "overlay")).find(row => row.id === "overlay")).toMatchObject({ globalDefault: true, readOnly: true });
    await expect(manager.save("hermes", "openrouter", "OpenRouter", added("hermes"), true)).rejects.toThrow("内置");
    const official = (await manager.get("kimiCode", "managed:kimi-code")).config as any;
    await manager.save("kimiCode", "managed:kimi-code", "Kimi", { ...official, provider: { ...official.provider, base_url: "https://evil", oauth: { key: "other" } } });
    expect(((await manager.get("kimiCode", "managed:kimi-code")).config as any).provider).toEqual(official.provider);
    // Selecting one of several models of the same provider is the Agent's choice, not ours to reset.
    expect(selectNativeProvider("kimiCode", samples.kimiCode, "relay")).toBe(samples.kimiCode);
    expect(() => writeNativeProvider("kimiCode", samples.kimiCode, "other", { provider: { type: "openai", api_key: "k" }, models: { "relay/m1": { model: "m1", max_context_size: 1 } } })).toThrow("其他供应商");
  });
  it("prefers valid OpenCode V2 declarations and keeps their format", async () => {
    const source = `{"provider":{"a":{"npm":"x","models":{"m":{}}}},"providers":{"a":{"package":"aisdk:x","models":{"m":{}}},"bad":{"models":[]}}}`;
    const { manager, read } = await fixture({ opencode: source });
    expect((await manager.list("opencode")).map(row => row.id)).toEqual(["a"]);
    await manager.save("opencode", "a", "A", { package: "aisdk:y", models: { m: {} } });
    expect(parseJson5(await read("opencode"))).toMatchObject({ provider: { a: { npm: "x" } }, providers: { a: { package: "aisdk:y" } } });
    await manager.switch("opencode", "a", false);
    expect(parseJson5(await read("opencode"))).toEqual({ provider: {}, providers: { bad: { models: [] } } });
    await manager.switch("opencode", "a", true);
    expect(parseJson5(await read("opencode"))).toMatchObject({ providers: { a: { package: "aisdk:y" } } });
  });
  it("rejects malformed native files without changing them or echoing their content", async () => {
    for (const [kind, source] of Object.entries({ opencode: `{"provider": secret-value`, openclaw: "{models: [secret-value}", hermes: "a: [secret-value\n", kimiCode: "x = = secret-value" }) as [NativeProviderKind, string][]) {
      const { manager, read } = await fixture({ [kind]: source });
      const error = await manager.list(kind).then(() => undefined, (reason: Error) => reason);
      expect(error?.message, kind).toContain("格式无法识别"); expect(error?.message).not.toContain("secret-value");
      expect(await read(kind)).toBe(source);
    }
  });
  it("projects every imported preset through the form and into a fresh native file", () => {
    for (const preset of nativeProviderPresets) {
      const kind = preset.kind as NativeProviderKind, id = preset.providerKey!;
      expect(id.length).toBeLessThanOrEqual(128);
      if (kind === "hermes") expect(hermesBuiltinProviderIds.has(id), id).toBe(false);
      const fields = providerFields({ kind, id, name: preset.name, config: preset.config }, true);
      const config = applyProviderFields(kind, preset.config, { ...fields, apiKey: fields.apiKey || "k", baseUrl: fields.baseUrl.includes("${") ? "" : fields.baseUrl }, true, false);
      if (!fields.baseUrl || fields.baseUrl.includes("${") || !fields.models!.length) continue;
      const written = writeNativeProvider(kind, kind === "hermes" ? "" : null, id, config);
      expect(Object.keys(readNativeProviders(kind, written).providers), preset.id).toEqual([id]);
      expect(readNativeProviders(kind, selectNativeProvider(kind, written, id)).defaultId, preset.id).toBe(id);
    }
  });
  // The upstream catalog mixes in sponsored resellers; regenerating a file must not bring them or their referral links back.
  it("ships curated presets only", async () => {
    const script = new URL("../../../scripts/curated-presets.mjs", import.meta.url).href;
    const { curatedPresets } = await import(/* @vite-ignore */ script) as { curatedPresets: <T>(presets: T[]) => T[] };
    for (const presets of [providerPresets, claudeProviderPresets, nativeProviderPresets]) expect(curatedPresets(presets)).toEqual(presets);
    const row = (name: string, category: string, websiteUrl = "https://example.com/") => ({ name, category, websiteUrl });
    expect(curatedPresets([row("PackyCode", "third_party"), row("AiHubMix", "aggregator"), row("TokenPlus", "aggregator"), row("Qiniu", "aggregator"), row("PPIO", "aggregator"), row("DigitalOcean", "cloud_provider"), row("AICoding", "custom")])).toEqual([]);
    expect(curatedPresets([row("OpenRouter", "aggregator", "https://openrouter.ai/?aff=x&keep=1")])).toEqual([row("OpenRouter", "aggregator", "https://openrouter.ai/?keep=1")]);
    expect(new Set(nativeProviderPresets.map(preset => preset.kind))).toEqual(new Set(nativeProviderKinds));
  });
  // ADR-0064: released Apps only know the four provider groups; the new ones stay on the computer.
  it("stays off the device protocol and out of installation", () => {
    for (const kind of nativeProviderKinds) {
      expect(providerKind(kind)).toBe(kind); expect(() => agentKind(kind)).toThrow();
      expect(parseProviderRequest({ type: "provider.list", protocolVersion: PROTOCOL_VERSION, requestId: "r", kind })).toBeUndefined();
    }
  });
});
