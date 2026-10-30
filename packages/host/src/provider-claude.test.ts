import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProviderManager, type ProviderHooks } from "./provider-manager.js";
import { applyProviderFields, newProviderConfig, providerFields } from "./provider-form.js";
import { backfillClaude, claudeOfficial, prepareClaude } from "./provider-claude.js";
import { claudeProviderPresets } from "./claude-provider-presets.js";
import { parseProviderRequest, providerResult } from "./provider-messages.js";
import { PROTOCOL_VERSION } from "@orbis/protocol";

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture(hooks: ProviderHooks = {}) {
  const root = await mkdtemp(join(tmpdir(), "orbis-claude-providers-")); roots.push(root);
  const paths = { pi: join(root, "pi"), codex: join(root, "codex"), dsh: join(root, "dsh"), claude: join(root, "claude") };
  await mkdir(paths.claude);
  const path = join(paths.claude, "settings.json");
  return { root, paths, path, manager: new ProviderManager(join(root, "state"), paths, hooks) };
}
const thirdParty = { env: { ANTHROPIC_BASE_URL: "https://example.test/anthropic", ANTHROPIC_AUTH_TOKEN: "secret", ANTHROPIC_DEFAULT_SONNET_MODEL: "vendor-model" } };

describe("Claude Code native provider switching", () => {
  it("imports official defaults, preserves shared settings and OAuth, and backfills outgoing routes", async () => {
    const { manager, path, paths } = await fixture();
    const shared = { hooks: { Stop: [{ matcher: "", hooks: [] }] }, permissions: { allow: ["Read"] }, enabledPlugins: { orbis: true }, futurePreference: true, env: { SHARED_VALUE: "keep" } };
    await writeFile(path, JSON.stringify(shared));
    await writeFile(join(paths.claude, ".credentials.json"), "oauth-secret-never-copy");
    const official = (await manager.list("claude"))[0]!;
    expect(official).toMatchObject({ enabled: true, mode: "exclusive", subscriptionSupported: true });
    await manager.save("claude", "third", "Third", thirdParty, true);
    await manager.switch("claude", "third");
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ ...shared, env: { ...shared.env, ...thirdParty.env } });
    const edited = { ...shared, env: { ...shared.env, ...thirdParty.env, ANTHROPIC_AUTH_TOKEN: "rotated", ANTHROPIC_MODEL: "changed" } };
    await writeFile(path, JSON.stringify(edited));
    await manager.switch("claude", official.id);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(shared);
    expect((await manager.get("claude", "third")).config.env).toMatchObject({ ANTHROPIC_AUTH_TOKEN: "rotated", ANTHROPIC_MODEL: "changed" });
    expect(await readFile(join(paths.claude, ".credentials.json"), "utf8")).toBe("oauth-secret-never-copy");
    const publicState = JSON.stringify(await manager.publicState("claude"));
    expect(publicState).not.toMatch(/secret|rotated|example\.test|SHARED_VALUE/);
    expect(publicState).toContain('"subscriptionSupported":true');
  });

  it("removes fields deleted from an active profile and rolls back on reload failure", async () => {
    let fail = false;
    const { manager, path } = await fixture({ afterApply: async () => { if (fail) { fail = false; throw new Error("reload"); } } });
    await manager.list("claude");
    await manager.save("claude", "third", "Third", { ...thirdParty, env: { ...thirdParty.env, VENDOR_SETTING: "owned" }, vendorSetting: 42 }, true);
    await manager.switch("claude", "third");
    await manager.save("claude", "third", "Third", thirdParty);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(thirdParty);
    const before = await readFile(path, "utf8");
    fail = true;
    await expect(manager.save("claude", "third", "Third", { env: { ...thirdParty.env, ANTHROPIC_AUTH_TOKEN: "bad" } })).rejects.toThrow("恢复原配置");
    expect(await readFile(path, "utf8")).toBe(before);
    expect((await manager.get("claude", "third")).config).toEqual(thirdParty);
  });

  it("refuses conflicting external edits and malformed env without replacing live files", async () => {
    let path = "";
    const f = await fixture({ beforeApply: async () => { if (path) await writeFile(path, '{"external":true}'); } });
    await f.manager.list("claude");
    await f.manager.save("claude", "third", "Third", thirdParty, true);
    path = f.path;
    await expect(f.manager.switch("claude", "third")).rejects.toThrow("外部修改");
    expect(await readFile(path, "utf8")).toBe('{"external":true}');
    expect(() => f.manager.save("claude", "bad", "Bad", { env: { ANTHROPIC_BASE_URL: 42 } }, true)).toThrow("字符串");
  });

  it("round-trips Claude forms, credential fields and model aliases", () => {
    const config = { env: { ...thirdParty.env, ANTHROPIC_DEFAULT_HAIKU_MODEL: "small", FUTURE_ENV: "keep" }, vendorFlag: true };
    const fields = providerFields({ kind: "claude", id: "third", name: "Third", config });
    expect(applyProviderFields("claude", config, fields)).toEqual(config);
    const changed = applyProviderFields("claude", config, { ...fields, apiKey: "new-key", model: "default", claude: { ...fields.claude!, apiKeyField: "ANTHROPIC_API_KEY", opus: "large" } });
    expect(changed).toMatchObject({ vendorFlag: true, env: { ANTHROPIC_API_KEY: "new-key", ANTHROPIC_MODEL: "default", ANTHROPIC_DEFAULT_OPUS_MODEL: "large", FUTURE_ENV: "keep" } });
    expect(changed.env).not.toHaveProperty("ANTHROPIC_AUTH_TOKEN");
    expect(claudeOfficial(newProviderConfig("claude"))).toBe(false);
    expect(claudeOfficial({ env: {} })).toBe(true);
    expect(claudeOfficial({ env: { CLAUDE_CODE_USE_POWERSHELL_TOOL: "1", CLAUDE_CODE_USE_NATIVE_FILE_SEARCH: "1" } })).toBe(true);
    expect(prepareClaude({}, { env: { CLAUDE_CODE_USE_POWERSHELL_TOOL: "1", API_TIMEOUT_MS: "600000", AWS_ACCESS_KEY_ID: "vendor" } }).env).toEqual({ CLAUDE_CODE_USE_POWERSHELL_TOOL: "1", API_TIMEOUT_MS: "600000" });
    for (const env of [{ ANTHROPIC_AUTH_TOKEN: "key" }, { ANTHROPIC_BASE_URL: "https://api.anthropic.com.attacker.test" }, { CLAUDE_CODE_USE_BEDROCK: "1" }, { ANTHROPIC_API_KEY: "" }]) expect(claudeOfficial({ env })).toBe(false);
    expect(prepareClaude({}, { hooks: { keep: true }, model: "old", env: thirdParty.env })).toEqual({ hooks: { keep: true }, env: {} });
    expect(backfillClaude({ hooks: { keep: true }, env: thirdParty.env })).toEqual(thirdParty);
  });

  it("accepts Claude and bounded subscription requests without remote configuration", () => {
    const request = { type: "provider.subscription", protocolVersion: PROTOCOL_VERSION, requestId: "query", kind: "claude", id: "official" };
    expect(parseProviderRequest(request)).toEqual(request);
    for (const extra of [{ enabled: true }, { apiKey: "secret" }, { kind: "pi" }, { id: "" }]) expect(parseProviderRequest({ ...request, ...extra })).toBeUndefined();
    expect(parseProviderRequest({ ...request, type: "provider.switch", enabled: true })).toBeDefined();
    expect(JSON.stringify(providerResult({ ...request, type: "provider.list", kind: "claude" }, [{ id: "a", kind: "claude", name: "Official", enabled: true, mode: "exclusive", subscriptionSupported: true }]))).toContain('"subscriptionSupported":true');
  });

  it("imports only native presets and retains the official subscription template", () => {
    expect(claudeProviderPresets.length).toBeGreaterThan(10);
    const official = claudeProviderPresets.find(preset => preset.category === "official")!;
    expect(claudeOfficial(official.config)).toBe(true);
    expect(claudeProviderPresets.every(preset => preset.kind === "claude" && !preset.requiresOAuth)).toBe(true);
  });
});
