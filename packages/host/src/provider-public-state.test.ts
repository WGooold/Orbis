import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ProviderManager, type ProviderProfile } from "./provider-manager.js";
import { publicProviderAuthentication, publicProviderHealth, publicProviderRouting, publicProviderUsage } from "./provider-public-state.js";
import { defaultProxyPreferences } from "./provider-proxy-config.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
const profile = (over: Partial<ProviderProfile> = {}): ProviderProfile => ({ id: "p", kind: "codex", name: "P", config: { auth: { OPENAI_API_KEY: "sk-never-publish" }, config: 'model_provider="custom"\n[model_providers.custom]\nbase_url="https://private.test/v1"\n' }, ...over });

describe("provider public facts", () => {
  it("distinguishes a missing managed account, native credentials and unverified resolver references", () => {
    const managed = profile({ authBinding: { source: "managed_account", authProvider: "codex_oauth", accountId: "account-secret" } });
    expect(publicProviderAuthentication(managed, new Set())).toEqual({ availability: "ready", method: "managed_account", credentialPresent: false, bindingReady: false, verified: null });
    expect(publicProviderAuthentication(managed, new Set(["account-secret"]))).toMatchObject({ credentialPresent: true, bindingReady: true, verified: null });
    expect(publicProviderAuthentication(profile(), new Set())).toMatchObject({ method: "api_key", credentialPresent: true, verified: null });
    expect(publicProviderAuthentication(profile({ kind: "pi", config: { apiKey: "!credential-helper", models: [] } }), new Set())).toMatchObject({ availability: "unknown", credentialPresent: null });
  });

  it("publishes finite quota numbers while suppressing arbitrary script output and errors", () => {
    const usage = publicProviderUsage({ attemptedAt: 200, updatedAt: 100, error: "secret request-header", data: [{ remaining: 12, total: 20, used: 8, unit: "secret", account: "private", apiKey: "secret" }, { remaining: Number.NaN }, { total: Number.POSITIVE_INFINITY }] });
    expect(usage).toEqual({ availability: "ready", detail: null, rows: [{ remaining: 12, total: 20, used: 8 }], attemptedAt: 200, updatedAt: 100, error: "query_failed" });
    expect(JSON.stringify(usage)).not.toContain("secret");
    expect(publicProviderUsage()).toMatchObject({ availability: "unknown", rows: [], updatedAt: null });
  });

  it("keeps circuit and route identities public without exposing credentials or endpoint text", () => {
    const status = { running: true, activeRequests: 1, totalRequests: 3, successfulRequests: 2, failoverCount: 1, lastProviderId: "b", health: [{ id: "a", state: "open" as const, failures: 2, lastSuccessAt: 0, lastFailureAt: 100 }], requests: [{ requestId: "request", providerId: "a", startedAt: 10, routeProviderIds: ["a", "b"] }] };
    expect(publicProviderHealth("codex", status)).toMatchObject({ availability: "ready", circuits: [{ providerId: "a", state: "open", lastSuccessAt: null, lastFailureAt: 100 }] });
    expect(publicProviderRouting("codex", { ...defaultProxyPreferences(), enabled: true, queue: ["b"] }, status)).toMatchObject({ queue: ["b"], requests: [{ providerId: "a", routeProviderIds: ["a", "b"] }] });
    expect(publicProviderRouting("pi", defaultProxyPreferences(), status)).toMatchObject({ availability: "unavailable", activeRequests: null });
  });

  it("reads active native configuration, authentication and usage together through ProviderManager", async () => {
    const root = await mkdtemp(join(tmpdir(), "orbis-public-provider-")); roots.push(root);
    const paths = { codex: join(root, "codex"), pi: join(root, "pi"), dsh: join(root, "dsh") };
    for (const path of Object.values(paths)) await mkdir(path);
    const manager = new ProviderManager(join(root, "state"), paths);
    await manager.save("codex", "custom", "Custom", profile().config, true);
    const first = await manager.publicState("codex", { usage: () => ({ attemptedAt: 20, updatedAt: 10, data: [{ remaining: 7, apiKey: "leak-me" }] }) });
    expect(first).toMatchObject({ current: "custom", authenticated: true, authentication: { method: "api_key", verified: null }, usage: { rows: [{ remaining: 7 }] }, profiles: [{ mode: "exclusive" }] });
    expect(JSON.stringify(first)).not.toMatch(/sk-never-publish|private\.test|leak-me|authBinding/);
    await writeFile(join(paths.codex, "auth.json"), "{}");
    await writeFile(join(paths.codex, "config.toml"), String(profile().config.config));
    expect(await manager.publicState("codex")).toMatchObject({ authenticated: false, authentication: { credentialPresent: false } });
  });
});
