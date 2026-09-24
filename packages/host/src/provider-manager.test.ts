import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProviderManager, type ProviderHooks } from "./provider-manager.js";
import { applyProviderFields, newProviderConfig } from "./provider-form.js";
import { parseProviderRequest, providerResult } from "./provider-messages.js";
import { installPackage } from "./agent-installation.js";
import { PROTOCOL_VERSION } from "@pi-remote/protocol";

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
    expect(JSON.parse(await readFile(join(paths.codex, "auth.json"), "utf8"))).toEqual({ OPENAI_API_KEY: "second-secret" });
    await manager.switch("codex", imported!.id);
    expect(JSON.parse(await readFile(join(paths.codex, "auth.json"), "utf8"))).toEqual({ OPENAI_API_KEY: "rotated-secret" });
    expect(await readFile(join(paths.codex, "config.toml"), "utf8")).toBe(original.config);
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
    const auth = await readFile(join(paths.codex, "auth.json"), "utf8");
    const config = await readFile(join(paths.codex, "config.toml"), "utf8");
    reload.mockRejectedValueOnce(new Error("bad backend"));
    await expect(manager.switch("codex", "b")).rejects.toThrow("已恢复原配置");
    expect(await readFile(join(paths.codex, "auth.json"), "utf8")).toBe(auth);
    expect(await readFile(join(paths.codex, "config.toml"), "utf8")).toBe(config);
    expect((await manager.list("codex")).filter(p => p.enabled).map(p => p.id)).toEqual(["a"]);
  });
  it("serializes concurrent edits and rejects invalid configs without touching native files", async () => {
    const { manager, paths } = await fixture();
    await Promise.all(["a", "b"].map(id => manager.save("pi", id, id, { models: [{ id }] }, true)));
    await Promise.all(["a", "b"].map(id => manager.switch("pi", id)));
    expect(Object.keys(JSON.parse(await readFile(join(paths.pi, "models.json"), "utf8")).providers)).toEqual(["a", "b"]);
    expect(() => manager.save("codex", "broken", "Broken", { auth: {}, config: "token = SECRET invalid" }, true)).toThrow("格式无效");
    await expect(manager.remove("pi", "a")).rejects.toThrow("先停用");
    await expect(manager.save("pi", "a", "Again", {}, true)).rejects.toThrow("已存在");
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
