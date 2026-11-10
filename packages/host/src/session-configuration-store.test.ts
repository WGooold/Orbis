// S51 / SC73: disk recovery, immutable operation identity and native-confirmation barriers.
import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConfiguredSessionLaunch, SessionConfigurationCatalog } from "@orbis/protocol";
import { SessionConfigurationStore, validateSessionConfiguration } from "./session-configuration-store.js";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
const request: ConfiguredSessionLaunch = { type: "session.launch", requestId: "request", launchId: "launch",
  agentKind: "codex", cwd: "/fixture", binding: "provider", revision: 0,
  values: { model: "a", thinking: "high", permissions: { sandbox: "readOnly", network: "restricted" } } };
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "orbis-configured-launch-")); dirs.push(dir);
  const path = join(dir, "configuration.json"); return { path, store: new SessionConfigurationStore(path) };
}
describe("recoverable configured launch", () => {
  it("persists before execution and executes a concurrent duplicate only once", async () => {
    const { path, store } = await fixture();
    const results = await Promise.all(Array.from({ length: 12 }, () => store.begin("device", request)));
    expect(results.filter(item => item.execute)).toHaveLength(1);
    const disk = JSON.parse(await readFile(path, "utf8"));
    expect(Object.values(disk.launches)).toMatchObject([{ phase: "preparing", values: request.values }]);
    expect(await store.read("codex", "/fixture", "provider")).toEqual({ revision: 1, values: request.values });
    await expect(store.begin("device", { ...request, values: { model: "b" } })).rejects.toMatchObject({ code: "launch_id_conflict" });
  });
  it("treats reordered permission fields and a lost save receipt as the same selection", async () => {
    const { store } = await fixture();
    await store.begin("device", request);
    const values = { permissions: { network: "restricted", sandbox: "readOnly" }, thinking: "high", model: "a" };
    expect((await store.begin("device", { ...request, values })).execute).toBe(false);
    expect(await store.save("codex", "/fixture", "provider", 0, values)).toMatchObject({ revision: 1 });
    await expect(store.save("codex", "/fixture", "provider", 0, { model: "b" })).rejects.toMatchObject({ code: "configuration_conflict" });
  });
  it("keeps a crash without native identity unknown and never claims it for recreate", async () => {
    const { path, store } = await fixture(); await store.begin("device", request);
    const restarted = new SessionConfigurationStore(path);
    expect(await restarted.result("device", "launch", "read")).toMatchObject({ phase: "unknown" });
    expect(await restarted.recover("device", "launch")).toBeUndefined();
    expect((await restarted.begin("device", request)).execute).toBe(false);
  });
  it("persists final preflight refusal so a delayed duplicate cannot become a new launch", async () => {
    const { path, store } = await fixture();
    await store.reject("device", request, "catalog changed");
    const restarted = new SessionConfigurationStore(path);
    expect(await restarted.result("device", "launch", "read")).toMatchObject({ phase: "failed", error: "catalog changed" });
    expect((await restarted.begin("device", request)).execute).toBe(false);
    expect(await restarted.recover("device", "launch")).toBeUndefined();
  });
  it("recovers an exact recorded identity and blocks messages until native confirmation", async () => {
    const { path, store } = await fixture(); await store.begin("device", request);
    await store.update("device", "launch", { sessionId: "native-a", phase: "configuring", spawnMode: "tui" });
    const restarted = new SessionConfigurationStore(path);
    expect(await restarted.blocks("native-a")).toBe(true);
    await expect(restarted.update("device", "launch", { sessionId: "wrong-session" })).rejects.toMatchObject({ code: "launch_identity_conflict" });
    expect(await restarted.recover("device", "launch")).toMatchObject({ sessionId: "native-a", values: request.values });
    expect(await restarted.recover("device", "launch")).toBeUndefined();
    await restarted.update("device", "launch", { phase: "ready" });
    expect(await restarted.blocks("native-a")).toBe(false);
    expect(await new SessionConfigurationStore(path).result("device", "launch", "read")).toMatchObject({ phase: "ready", sessionId: "native-a" });
    expect(await restarted.result("another-device", "launch", "read")).toBeUndefined();
  });
  it("distinguishes authoritative absence from corrupt storage and isolates provider defaults", async () => {
    const { path, store } = await fixture();
    expect(await store.result("device", "absent", "read")).toBeUndefined();
    await store.save("codex", "/fixture", "provider", 0, { model: "a" });
    expect(await store.read("codex", "/fixture", "other-provider")).toEqual({ revision: 0, values: {} });
    await writeFile(path, "truncated");
    await expect(new SessionConfigurationStore(path).begin("device", request)).rejects.toMatchObject({ code: "configuration_store_unavailable" });
  });
  it("rejects stale choices and incompatible permissions at the side-effect boundary", () => {
    const catalog: SessionConfigurationCatalog = { binding: "provider", defaults: {}, models: [
      { value: "a", label: "A", thinking: [{ value: "high", label: "High" }] }], permissions: [
      { id: "sandbox", label: "Files", options: [{ value: "dangerFullAccess", label: "Full" }] },
      { id: "network", label: "Network", options: [{ value: "restricted", label: "Restricted" }] }] };
    expect(() => validateSessionConfiguration(catalog, { model: "b" })).toThrow("模型选项");
    expect(() => validateSessionConfiguration(catalog, { model: "a", thinking: "max" })).toThrow("思考深度");
    expect(() => validateSessionConfiguration(catalog, { permissions: { sandbox: "dangerFullAccess", network: "restricted" } })).toThrow("权限组合");
  });
});
