import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProviderManager, type ProviderHooks } from "./provider-manager.js";
import { applyProviderFields, newProviderConfig, providerFields } from "./provider-form.js";
import { parseProviderRequest, providerResult } from "./provider-messages.js";
import { installPackage } from "./agent-installation.js";
import { PROTOCOL_VERSION } from "@pi-remote/protocol";
import { parse as parseToml } from "smol-toml";
import { parse as parseYaml } from "yaml";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture(hooks: ProviderHooks = {}) {
  const root = await mkdtemp(join(tmpdir(), "orbis-providers-")); roots.push(root);
  const paths = { pi: join(root, "pi"), codex: join(root, "codex"), dsh: join(root, "dsh") };
  for (const path of Object.values(paths)) await mkdir(path);
  return { root, paths, manager: new ProviderManager(join(root, "state"), paths, hooks) };
}
const codex = (provider: string, key: string) => ({ auth: { OPENAI_API_KEY: key }, config: `model_provider = "${provider}"\nmodel = "test-model"\n[model_providers.${provider}]\nname = "${provider}"\nwire_api = "responses"\nbase_url = "https://example.com/v1"\n` });

describe("CC Switch provider configuration semantics", () => {
  it("round-trips routing form options and rejects malformed overrides before saving", () => {
    const config = { ...codex("custom", "key"), apiFormat: "openai_chat", isFullUrl: true, promptCacheRouting: "disabled", codexChatReasoning: { supportsThinking: false, supportsEffort: true, thinkingParam: "none", effortParam: "reasoning.effort", effortValueMode: "openrouter" }, requestOverrides: { body: { service_tier: "priority" }, headers: { "x-custom": "kept" } }, chatOptions: { supportsStrictMode: false }, future: { value: 42 } };
    const fields = providerFields({ kind: "codex", id: "custom", name: "Custom", config });
    const next = applyProviderFields("codex", config, fields);
    expect(next).toMatchObject({ ...fields.routing, apiFormat: "openai_chat", future: { value: 42 } });
    expect(fields.api).toBe("openai-completions");
    expect(() => applyProviderFields("codex", config, { ...fields, routing: { promptCacheRouting: "typo" } })).toThrow("cache routing");
    expect(() => applyProviderFields("codex", config, { ...fields, routing: { requestOverrides: { body: [] } } })).toThrow("JSON object");
  });
  it("round-trips a Pi built-in override without turning inheritance into explicit defaults", () => {
    for (const config of [{ apiKey: "ENV_KEY", future: true }, { apiKey: "!custom-command", models: [], compat: {} }]) {
      const fields = providerFields({ id: "anthropic", kind: "pi", name: "Anthropic", config });
      expect(applyProviderFields("pi", config, fields)).toEqual(config);
      expect(() => applyProviderFields("pi", config, fields, true)).toThrow("新建供应商");
    }
    const config = { api: "future-api", models: [{ id: " Case-Sensitive ", future: true }] };
    expect(applyProviderFields("pi", config, providerFields({ id: "custom", kind: "pi", name: "Custom", config }))).toEqual(config);
  });
  it("preserves secondary DSH models and the existing credential environment key", () => {
    const config = { env: { CUSTOM_KEY: "old" }, patch: '- id: llm-pi-ai\n  config:\n    providers:\n      custom:\n        apiKeyEnv: CUSTOM_KEY\n        models:\n          - id: secondary\n            keep: true\n          - id: selected\n            keep: 42\n- id: acp\n  config:\n    provider: custom\n    model: selected\n' };
    const fields = providerFields({ kind: "dsh", id: "dsh", name: "DSH", config });
    const next = applyProviderFields("dsh", config, { ...fields, model: "renamed", apiKey: "new" });
    expect(next.env).toEqual({ CUSTOM_KEY: "new" });
    const rows = parseYaml(String(next.patch));
    expect(rows[0].config.providers.custom).toMatchObject({ apiKeyEnv: "CUSTOM_KEY", models: [{ id: "secondary", keep: true }, { id: "renamed", keep: 42 }] });
    expect(rows).toContainEqual({ id: "agent-default-model", config: { provider: "custom", model: "renamed" } });
    expect(rows).toContainEqual({ id: "acp", config: { provider: "custom", model: "renamed" } });
  });
  it("prefers DSH's shared Web default and preserves unrelated patch configuration", () => {
    const rows = [
      { id: "llm-pi-ai", config: { providers: {
        web: { apiKeyEnv: "WEB_KEY", baseURL: "https://example.com/v1", api: "openai-responses", models: [{ id: "web-model", reasoningEfforts: { high: "high" } }, { id: "secondary" }], compat: { supportsMaxOutputTokens: false } },
        legacy: { apiKeyEnv: "LEGACY_KEY", models: [{ id: "legacy-model" }] },
      }, future: true } },
      { id: "agent-default-model", config: { provider: "web", model: "web-model", reasoningEffort: "high", future: "keep" } },
      { id: "acp", config: { provider: "legacy", model: "legacy-model", timeout: 12 } },
      { id: "unrelated", config: { nested: ["preserved"] }, disabled: true },
      { insert: [{ id: "custom-plugin", name: "custom-plugin", config: { retain: true } }] },
    ];
    const config = { env: { WEB_KEY: "web-key", LEGACY_KEY: "legacy-key" }, patch: JSON.stringify(rows) };
    const fields = providerFields({ kind: "dsh", id: "dsh", name: "DSH", config });
    expect(fields).toMatchObject({ providerKey: "web", model: "web-model", baseUrl: "https://example.com/v1", api: "openai-responses", apiKey: "web-key" });
    const next = applyProviderFields("dsh", config, { ...fields, model: "updated" });
    const updated = parseYaml(String(next.patch));
    expect(updated[0].config).toEqual({ ...rows[0]!.config, providers: { ...rows[0]!.config!.providers, web: { ...rows[0]!.config!.providers!.web, models: [{ id: "updated", reasoningEfforts: { high: "high" } }, { id: "secondary" }] } } });
    expect(updated[1]).toEqual({ id: "agent-default-model", config: { provider: "web", model: "updated", reasoningEffort: "high", future: "keep" } });
    expect(updated[2]).toEqual({ id: "acp", config: { provider: "web", model: "updated", timeout: 12 } });
    expect(updated.slice(3)).toEqual(rows.slice(3));
    expect(next.env).toEqual(config.env);
  });
  it("creates DSH shared defaults without adding an ACP-only row or changing the API root", () => {
    const fields = { providerKey: "custom", model: "custom-model", baseUrl: "https://example.com/", api: "openai-responses", apiKey: "key" };
    const config = applyProviderFields("dsh", newProviderConfig("dsh"), fields, true);
    const rows = parseYaml(String(config.patch));
    expect(rows).toContainEqual({ id: "agent-default-model", config: { provider: "custom", model: "custom-model" } });
    expect(rows.some((row: { id?: string }) => row.id === "acp")).toBe(false);
    expect(providerFields({ kind: "dsh", id: "dsh", name: "DSH", config })).toEqual(fields);
  });
  it("imports native Codex auth/config and backfills external changes before switching", async () => {
    const { manager, paths } = await fixture();
    const original = codex("original", "first-secret");
    await writeFile(join(paths.codex, "config.toml"), original.config);
    await writeFile(join(paths.codex, "auth.json"), JSON.stringify(original.auth));
    const [imported] = await manager.list("codex");
    expect(imported?.enabled).toBe(true);
    await manager.save("codex", "custom", "Custom", codex("custom", "second-secret"), true);
    await writeFile(join(paths.codex, "auth.json"), JSON.stringify({ OPENAI_API_KEY: "rotated-secret" }));
    await manager.switch("codex", "custom");
    await expect(readFile(join(paths.codex, "auth.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(parseToml(await readFile(join(paths.codex, "config.toml"), "utf8"))).toMatchObject({ model_providers: { custom: { experimental_bearer_token: "second-secret" } } });
    await manager.switch("codex", imported!.id);
    expect(parseToml(await readFile(join(paths.codex, "config.toml"), "utf8"))).toMatchObject({ model_providers: { original: { experimental_bearer_token: "rotated-secret" } } });
    expect(JSON.stringify(await manager.list("codex"))).not.toContain("secret");
  });
  it("treats built-in Pi IDs as explicit nodes, preserves unknown fields and leaves auth/defaults untouched", async () => {
    const { manager, paths } = await fixture();
    const native = { extra: { keep: 1 }, providers: { anthropic: { apiKey: "secret", future: true, models: [{ id: "Case-Sensitive", future: 2 }] }, other: { apiKey: "other" } } };
    await writeFile(join(paths.pi, "models.json"), JSON.stringify(native));
    await writeFile(join(paths.pi, "auth.json"), "private OAuth data");
    await writeFile(join(paths.pi, "settings.json"), "default model untouched");
    expect(await manager.list("pi")).toHaveLength(2);
    await manager.switch("pi", "anthropic", false);
    const removed = JSON.parse(await readFile(join(paths.pi, "models.json"), "utf8"));
    expect(removed).toEqual({ extra: { keep: 1 }, providers: { other: { apiKey: "other" } } });
    await manager.switch("pi", "anthropic", true);
    expect(JSON.parse(await readFile(join(paths.pi, "models.json"), "utf8"))).toEqual(native);
    expect(await readFile(join(paths.pi, "auth.json"), "utf8")).toBe("private OAuth data");
    expect(await readFile(join(paths.pi, "settings.json"), "utf8")).toBe("default model untouched");
  });
  it("rolls back both live files and current identity when backend reload fails", async () => {
    const reload = vi.fn().mockResolvedValue(undefined);
    const { manager, paths } = await fixture({ afterApply: reload });
    await manager.save("codex", "a", "A", codex("a", "a-secret"), true);
    await manager.save("codex", "b", "B", codex("b", "b-secret"), true);
    await manager.switch("codex", "a");
    const auth = await readFile(join(paths.codex, "auth.json"), "utf8").catch(() => null);
    const config = await readFile(join(paths.codex, "config.toml"), "utf8");
    reload.mockRejectedValueOnce(new Error("bad backend"));
    await expect(manager.switch("codex", "b")).rejects.toThrow("已恢复原配置");
    expect(await readFile(join(paths.codex, "auth.json"), "utf8").catch(() => null)).toBe(auth);
    expect(await readFile(join(paths.codex, "config.toml"), "utf8")).toBe(config);
    expect((await manager.list("codex")).filter(p => p.enabled).map(p => p.id)).toEqual(["a"]);
  });
  it("serializes concurrent edits and rejects invalid configs without touching native files", async () => {
    const { manager, paths } = await fixture();
    await Promise.all(["a", "b"].map(id => manager.save("pi", id, id, { models: [{ id }] }, true)));
    await Promise.all(["a", "b"].map(id => manager.switch("pi", id)));
    expect(Object.keys(JSON.parse(await readFile(join(paths.pi, "models.json"), "utf8")).providers)).toEqual(["a", "b"]);
    expect(() => manager.save("codex", "broken", "Broken", { auth: {}, config: "token = SECRET invalid" }, true)).toThrow("格式无效");
    await manager.remove("pi", "a");
    expect(Object.keys(JSON.parse(await readFile(join(paths.pi, "models.json"), "utf8")).providers)).toEqual(["b"]);
    expect((await manager.list("pi")).map(p => p.id)).toEqual(["b"]);
    await expect(manager.save("pi", "b", "Again", {}, true)).rejects.toThrow("已存在");
  });
  it("creates live Pi providers, keeps a copied card disabled, and validates all structured models", async () => {
    const { manager, paths } = await fixture();
    const initial = { name: "Original", baseUrl: "https://example.com/v1", apiKey: "secret", api: "google-generative-ai", headers: { "X-Test": "value" }, compat: { future: true }, models: [{ id: "one", name: "One", reasoning: true, input: ["text", "image"], contextWindow: 32000, maxTokens: 8000, future: "keep" }, { id: "two", input: ["text"] }] };
    const fields = { providerKey: "custom", baseUrl: initial.baseUrl, apiKey: initial.apiKey, model: "one", api: initial.api, headers: initial.headers, compat: initial.compat, models: initial.models };
    await manager.save("pi", "custom", "Original", applyProviderFields("pi", {}, fields), true);
    expect(JSON.parse(await readFile(join(paths.pi, "models.json"), "utf8")).providers.custom).toEqual(initial);
    const copied = await manager.copy("pi", "custom");
    expect(copied.find(p => p.id === "custom-copy")?.enabled).toBe(false);
    expect((await manager.get("pi", "custom-copy")).config.models).toEqual(initial.models);
    expect(() => applyProviderFields("pi", {}, { ...fields, models: [{ id: "one" }, { id: "one" }] })).toThrow("不能重复");
    expect(() => applyProviderFields("pi", {}, { ...fields, models: [{ id: "one", maxTokens: "0" }] })).toThrow("正整数");
  });
  it("projects full Codex configs without dropping unrelated settings and supports DSH credentials locally", async () => {
    const fields = { baseUrl: "https://example.com/v1", apiKey: "local-secret", model: "custom-model", api: "openai-completions", providerKey: "custom" };
    const projected = applyProviderFields("codex", { auth: {}, config: '[mcp_servers.test]\nurl = "https://example.com/mcp"\n' }, fields);
    expect(projected.config).toContain("mcp_servers.test");
    expect(projected.config).toContain('wire_api = "responses"');
    const { manager, paths } = await fixture();
    await manager.save("dsh", "one", "One", applyProviderFields("dsh", newProviderConfig("dsh"), fields), true);
    await manager.switch("dsh", "one");
    expect((await manager.environment("dsh")).ORBIS_DSH_API_KEY).toBe("local-secret");
    expect(await readFile(join(paths.dsh, "cordis.patch.yml"), "utf8")).not.toContain("local-secret");
    expect(JSON.stringify(await manager.list("dsh"))).not.toContain("local-secret");
  });
  it("keeps DeepSeek custom YAML tags intact when importing and editing advanced config", async () => {
    const { manager, paths } = await fixture();
    const patch = "- id: hmr\n  disabled: !!js \"!ctx.get('profileContext')\"\n";
    await writeFile(join(paths.dsh, "cordis.patch.yml"), patch);
    const [imported] = await manager.list("dsh");
    expect(imported?.enabled).toBe(true);
    expect((await manager.get("dsh", imported!.id)).config.patch).toBe(patch);
    await manager.save("dsh", imported!.id, "Native patch", { patch, env: {} });
    expect(await readFile(join(paths.dsh, "cordis.patch.yml"), "utf8")).toBe(patch);
  });
  it("refuses an external edit between the initial read and the switch without erasing it", async () => {
    const beforeApply = vi.fn().mockResolvedValue(undefined);
    const { manager, paths } = await fixture({ beforeApply });
    await manager.save("pi", "test", "Test", { models: [{ id: "a" }] }, true, false);
    const external = JSON.stringify({ providers: { outside: { models: [{ id: "external" }] } }, outside: true });
    beforeApply.mockImplementationOnce(() => writeFile(join(paths.pi, "models.json"), external));
    await expect(manager.switch("pi", "test")).rejects.toThrow("外部修改");
    expect(await readFile(join(paths.pi, "models.json"), "utf8")).toBe(external);
    expect((await manager.list("pi")).find(p => p.id === "test")?.enabled).toBe(false);
  });
  it("carries added and removed common preferences across Codex switches and preserves CLI-rotated login", async () => {
    const { manager, paths } = await fixture();
    await manager.saveCodexPreferences({ commonConfig: '[features]\na = true\n', commonCleared: false, preserveOfficialLogin: true });
    await manager.save("codex", "a", "A", codex("a", "key-a"), true, true, { commonConfigEnabled: true });
    await manager.save("codex", "b", "B", codex("b", "key-b"), true, true, { commonConfigEnabled: true });
    const rotated = JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: "rotated", refresh_token: "fresh" } });
    await writeFile(join(paths.codex, "auth.json"), rotated);
    await writeFile(join(paths.codex, "config.toml"), (await readFile(join(paths.codex, "config.toml"), "utf8")).replace("a = true", "b = true"));
    await manager.switch("codex", "b");
    expect(parseToml(await readFile(join(paths.codex, "config.toml"), "utf8")).features).toEqual({ b: true });
    expect(await readFile(join(paths.codex, "auth.json"), "utf8")).toBe(rotated);
    expect((await manager.get("codex", "a")).config.auth).toEqual({ OPENAI_API_KEY: "key-a" });
    expect(await manager.codexPreferences()).toMatchObject({ preserveOfficialLogin: true });
  });
  it("projects Codex model capabilities atomically and backfills native catalog edits", async () => {
    const reload = vi.fn().mockResolvedValue(undefined);
    const { manager, paths } = await fixture({ afterApply: reload });
    await manager.save("codex", "custom", "Custom", { ...codex("custom", "test-key"), modelCatalog: { models: [{ model: "vision-test", contextWindow: 64000, inputModalities: ["text", "image"], reasoningLevels: ["low", "high"], future: true }] } }, true);
    const catalogPath = join(paths.codex, "orbis-model-catalog.json");
    const catalog = JSON.parse(await readFile(catalogPath, "utf8"));
    expect(catalog.models[0]).toMatchObject({ slug: "vision-test", context_window: 64000, input_modalities: ["text", "image"], default_reasoning_level: "high" });
    expect(parseToml(await readFile(join(paths.codex, "config.toml"), "utf8")).model_catalog_json).toBe(catalogPath);
    catalog.models[0].context_window = 96000;
    await writeFile(catalogPath, JSON.stringify(catalog));
    expect((await manager.get("codex", "custom")).config.modelCatalog).toMatchObject({ models: [{ model: "vision-test", contextWindow: 96000, future: true }] });
    await manager.save("codex", "other", "Other", codex("other", "other-key"), true);
    reload.mockRejectedValueOnce(new Error("reload failed"));
    await expect(manager.switch("codex", "other")).rejects.toThrow("已恢复原配置");
    expect(JSON.parse(await readFile(catalogPath, "utf8"))).toEqual(catalog);
    await manager.switch("codex", "other");
    await expect(readFile(catalogPath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("bounded remote provider and installation inputs", () => {
  it("accepts saved identities only and rejects remote config/commands", () => {
    const request = { type: "provider.switch", protocolVersion: PROTOCOL_VERSION, requestId: "r", kind: "codex", id: "saved", enabled: true };
    expect(parseProviderRequest(request)).toEqual(request);
    for (const bad of [{ ...request, config: {} }, { ...request, command: "npm" }, { ...request, enabled: false }, { ...request, kind: "shell" }, { ...request, protocolVersion: -1 }]) expect(parseProviderRequest(bad)).toBeUndefined();
    expect(providerResult(parseProviderRequest(request)!, [])).toMatchObject({ type: "provider.result", requestId: "r", providers: [] });
  });
  it("pins executable packages and rejects npm option injection", () => {
    expect(installPackage("codex", "latest")).toBe("@openai/codex@latest");
    expect(installPackage("dsh", "0.1.7-rc.1")).toBe("@deepseek-ai/dsh@0.1.7-rc.1");
    for (const version of ["--global", "file:evil", "https://example.com", "latest && calc", ""]) expect(() => installPackage("pi", version)).toThrow();
    expect(() => installPackage("arbitrary", "latest")).toThrow();
  });
});
