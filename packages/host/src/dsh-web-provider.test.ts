import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { DshWebConnection } from "./dsh-web-client.js";
import { applyDshWebProvider, dshWebLaunchEnvironment, prepareDshWebModelCatalog } from "./dsh-web-provider.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "dsh-provider-")); roots.push(root);
  await writeFile(join(root, "cordis.patch.yml"), '- id: llm-pi-ai\n  config:\n    providers:\n      test:\n        apiKeyEnv: TEST_KEY\n        baseURL: http://localhost/v2\n');
  return { DSH_HOME: root, ORBIS_DSH_PROVIDER_ENV: JSON.stringify({ TEST_KEY: "new-secret" }) };
}

it("keeps managed credentials out of a persistent Web process environment", () => {
  expect(dshWebLaunchEnvironment({ TEST_KEY: "secret", PATH: "kept", ORBIS_DSH_PROVIDER_ENV: '{"TEST_KEY":"secret"}' })).toEqual({ PATH: "kept" });
});

it("waits for native HMR to replace routes before installing the new credential", async () => {
  const env = await fixture();
  const request = vi.fn().mockResolvedValueOnce({ namespaces: [{ ns: "llm-pi-ai", value: { providers: { old: {} } } }] })
    .mockResolvedValueOnce({ namespaces: [{ ns: "llm-pi-ai", value: { providers: { test: { apiKeyEnv: "TEST_KEY", baseURL: "http://localhost/v2" } } } }] })
    .mockResolvedValue(undefined);
  await applyDshWebProvider({ request } as unknown as DshWebConnection, env);
  expect(request.mock.calls.map(call => call[0])).toEqual(["settings/describe", "settings/describe", "credentials/set"]);
  expect(request).toHaveBeenLastCalledWith("credentials/set", { ref: "TEST_KEY", value: "new-secret" });
});

it("fails closed when native reload rejects the patch and never writes its credential", async () => {
  const request = vi.fn().mockResolvedValue({ namespaces: [] });
  await expect(applyDshWebProvider({ request } as unknown as DshWebConnection, await fixture(), 0)).rejects.toThrow("未应用供应商补丁");
  expect(request).toHaveBeenCalledTimes(1);
});

// DSH-ACCOUNT-01/02: only native account availability admits initialization;
// DSH retains authority over configured keys, model order and profile persistence.
const accountCatalog = { default: { provider: "deepseek-official", model: "deepseek-flash" },
  groups: [{ id: "deepseek-account", models: [{ id: "account-model" }] }] };

it("initializes a keyless Web profile through DSH and rereads its confirmed account default", async () => {
  const confirmed = { ...accountCatalog, default: { provider: "deepseek-account", model: "account-model", reasoningEffort: "high" } };
  const request = vi.fn().mockResolvedValueOnce(accountCatalog).mockResolvedValueOnce(undefined).mockResolvedValueOnce(confirmed);
  expect(await prepareDshWebModelCatalog({ request } as unknown as DshWebConnection)).toEqual(confirmed);
  expect(request.mock.calls).toEqual([["session/modelCatalog", {}], ["session/initializeDefaultModel", {}], ["session/modelCatalog", {}]]);
});

it.each([
  { default: accountCatalog.default, groups: [] }, // signed out, or pre-account DSH
  { default: accountCatalog.default, groups: [{ id: "deepseek-account", models: [] }] },
  { ...accountCatalog, default: { provider: "deepseek-account", model: "chosen-account-model" } },
  { ...accountCatalog, default: { provider: "custom", model: "chosen-custom-model" } },
  { ...accountCatalog, groups: [...accountCatalog.groups, { id: "deepseek-official", models: [{ id: "key-model" }] }] },
])("retains native defaults without an account-only initialization condition: %j", async catalog => {
  const request = vi.fn().mockResolvedValue(catalog);
  expect(await prepareDshWebModelCatalog({ request } as unknown as DshWebConnection)).toEqual(catalog);
  expect(request.mock.calls).toEqual([["session/modelCatalog", {}]]);
});

it("honors a native no-op when an API key exists but its model catalog is unavailable", async () => {
  const request = vi.fn().mockResolvedValue(accountCatalog);
  expect(await prepareDshWebModelCatalog({ request } as unknown as DshWebConnection)).toEqual(accountCatalog);
  expect(request.mock.calls.map(call => call[0])).toEqual(["session/modelCatalog", "session/initializeDefaultModel", "session/modelCatalog"]);
});

it("propagates failed native initialization without inventing a confirmed model", async () => {
  const request = vi.fn().mockResolvedValueOnce(accountCatalog).mockRejectedValueOnce(new Error("profile write refused"));
  await expect(prepareDshWebModelCatalog({ request } as unknown as DshWebConnection)).rejects.toThrow("profile write refused");
  expect(request).toHaveBeenCalledTimes(2);
});
