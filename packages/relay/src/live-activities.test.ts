import { readFile, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { testDirectory } from "../../../scripts/test-fixtures/temp-directory.js";
import { RelayLiveActivities, parseLiveActivityUpdate, type LiveActivityPush, type LiveActivityUpdate } from "./live-activities.js";

vi.mock("node:fs/promises", async original => {
  const fs = await original<typeof import("node:fs/promises")>();
  return { ...fs, rename: vi.fn(fs.rename) };
});

const oldToken = "a".repeat(64), newToken = "b".repeat(64);
const update = (revision = 1, patch: Partial<LiveActivityUpdate["contentState"]> = {}): LiveActivityUpdate => ({
  version: 1, hostId: "host", producerId: "producer", revision, event: patch.phase === "ended" ? "end" : "update",
  contentState: { version: 1, phase: "running", runningCount: 1, pendingCount: 0,
    focusKey: "c".repeat(64), agentKind: "codex", startedAt: Date.now() - 120_000, updatedAt: Date.now(), outcome: null, ...patch },
});
const registration = (token: string | null = oldToken, activityId = "activity-one", environment = "production") => ({ version: 1, activityId, token, environment });
const startRegistration = (token = "d".repeat(64), inputPushToken = true) => ({ version: 1, token, environment: "production", inputPushToken });
const claimRequest = { version: 1, environment: "production" };
const pairingRef = "e".repeat(64);
const nativeImport = createRequire(import.meta.url)("../../../scripts/test-fixtures/import-native.cjs") as
  (file: string) => Promise<{ RelayLiveActivities: typeof RelayLiveActivities }>;
const releaseRoot = process.env.ORBIS_LIVE_ACTIVITY_REFERENCE_RUNTIME;
const released = releaseRoot ? (await nativeImport(pathToFileURL(join(releaseRoot, "packages/relay/dist/live-activities.js")).href)).RelayLiveActivities : undefined;

// LA-R01/04: synthetic registry tests target lost token rotations, revocation,
// unordered source revisions and seconds-based APNs coalescing. No Apple or
// production network is used; state files live in the shared test fixture area.
describe("live activity registry", () => {
  const open: RelayLiveActivities[] = [];
  const create = async (persist = false) => {
    const connection = {};
    const connections = new Map<string, object>([["host", connection]]);
    const paired = new Set(["phone:host", "tablet:host", "other:other-host"]);
    const send = vi.fn<(_environment: string, _token: string, _push: LiveActivityPush) => Promise<"sent" | "invalid-token">>().mockResolvedValue("sent");
    const stateFile = persist ? join(await testDirectory(join(tmpdir(), "orbis-live-activities-")), "state.json") : undefined;
    const options = { ...(stateFile ? { stateFile } : {}), isPaired: (d: string, h: string) => paired.has(`${d}:${h}`),
      currentConnection: (h: string) => connections.get(h), hasEnvironment: (e: string) => e === "production", send };
    const registry = await RelayLiveActivities.create(options); open.push(registry);
    return { registry, connection, connections, paired, send, options, stateFile };
  };
  const settle = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };
  afterEach(async () => {
    await Promise.all(open.splice(0).map(r => r.close())); vi.restoreAllMocks(); vi.useRealTimers();
  });

  it("rejects extra private text, invalid counts and inconsistent end events", () => {
    const valid = update();
    expect(parseLiveActivityUpdate(valid)).toEqual(valid);
    for (const invalid of [
      { ...update(), title: "private title" },
      update(1, { runningCount: 2049 }), update(1, { pendingCount: 131_073 }),
      update(1, { runningCount: 0 }), update(1, { pendingCount: 1 }),
      update(1, { outcome: "completed" }), update(1, { phase: "stale", outcome: "completed" }),
      { ...update(), contentState: { ...update().contentState, tool: "private tool args" } },
      { ...update(), event: "end" }, update(1, { phase: "attention" }),
      update(1, { phase: "ended", runningCount: 1 }),
    ]) expect(() => parseLiveActivityUpdate(invalid)).toThrow();
    expect(parseLiveActivityUpdate(update(1, { phase: "attention", runningCount: 2048, pendingCount: 131_072 }))).toBeDefined();
    for (const agentKind of ["hermes", "openclaw", "arbitrary"]) {
      expect(() => parseLiveActivityUpdate({ ...valid, contentState: { ...valid.contentState, agentKind } })).toThrow();
    }
  });

  // LA-COMPAT-01: both historical producer extensions still parse, but neither leaks to a v1 widget.
  it.each(["kimiCode", "opencode"] as const)("projects a %s producer into the legacy widget and claim formats", async agentKind => {
    const f = await create();
    await f.registry.register("phone", "host", registration(), () => true);
    const message = parseLiveActivityUpdate(update(1, { agentKind }));
    expect(message.contentState.agentKind).toBe(agentKind);
    expect(await f.registry.publish(message, f.connection, 1)).toEqual({ sent: ["phone"], failed: [] });
    expect(f.send.mock.calls[0]?.[2].contentState).toEqual({ ...message.contentState, agentKind: null });
    expect(await f.registry.claim("tablet", "host", claimRequest, () => true)).toMatchObject({
      contentState: { ...message.contentState, agentKind: null, sessionCount: 1 },
    });
  });

  it("registers only live paired devices and scopes cleanup by activity identity", async () => {
    const f = await create();
    await expect(f.registry.register("phone", "host", registration(), () => false)).rejects.toMatchObject({ status: 401 });
    await expect(f.registry.register("phone", "host", registration(oldToken, "first", "sandbox"), () => true)).rejects.toMatchObject({ status: 409 });
    await f.registry.register("phone", "host", registration(), () => true);
    await f.registry.register("phone", "host", registration(newToken, "activity-two"), () => true);
    await f.registry.register("phone", "host", registration(null), () => true);
    await f.registry.publish(update(), f.connection);
    expect(f.send).toHaveBeenCalledExactlyOnceWith("production", newToken, expect.objectContaining({ priority: 5 }));
  });

  it("preserves fresh token registration when an older in-flight push returns invalid", async () => {
    const f = await create();
    await f.registry.register("phone", "host", registration(), () => true);
    let finish!: (value: "invalid-token") => void;
    f.send.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const pushing = f.registry.publish(update(), f.connection);
    await vi.waitFor(() => expect(f.send).toHaveBeenCalledTimes(1));
    await f.registry.register("phone", "host", registration(newToken), () => true);
    finish("invalid-token"); await pushing;
    await vi.waitFor(() => expect(f.send).toHaveBeenCalledTimes(2));
    expect(f.send.mock.calls[1]![1]).toBe(newToken);
  });

  it("accepts variable-size activity tokens without changing the legacy alert contract", async () => {
    const f = await create(true);
    await f.registry.register("phone", "host", registration("a".repeat(1024)), () => true);
    await expect(f.registry.register("phone", "host", registration("b".repeat(1025)), () => true)).rejects.toMatchObject({ status: 400 });
    await f.registry.publish(update(), f.connection);
    expect(f.send.mock.calls[0]![1]).toHaveLength(1024);
    expect(JSON.parse(await readFile(f.stateFile!, "utf8")).registrations[0].token).toHaveLength(1024);
  });

  it("retries a refreshed same-value token after the prior registration's 410", async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-11-17T00:00:00.000Z"));
    const f = await create();
    await f.registry.register("phone", "host", registration(), () => true);
    let finish!: (value: "invalid-token") => void;
    f.send.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const pushing = f.registry.publish(update(), f.connection);
    await settle();
    await f.registry.register("phone", "host", registration(), () => true);
    finish("invalid-token"); await pushing;
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.send).toHaveBeenCalledTimes(2);
    expect(f.send.mock.calls[1]![1]).toBe(oldToken);
    expect(f.send.mock.calls[1]![2].timestamp).toBeGreaterThan(f.send.mock.calls[0]![2].timestamp);
  });

  it("keeps a publish result when registration replay arrives during same-second coalescing", async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-11-17T00:00:00.000Z"));
    const f = await create();
    await f.registry.register("phone", "host", registration(), () => true);
    await f.registry.publish(update(), f.connection);
    const pushing = f.registry.publish(update(2, { runningCount: 2 }), f.connection);
    await settle();
    await f.registry.register("phone", "host", registration(), () => true);
    await vi.advanceTimersByTimeAsync(1000);
    await expect(pushing).resolves.toEqual({ sent: ["phone"], failed: [] });
    expect(f.send).toHaveBeenCalledTimes(2);
    expect(f.send.mock.calls[1]![2].contentState.runningCount).toBe(2);
  });

  it("coalesces same-second changes, uses low priority for repeats, and ends once", async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-11-17T00:00:00.000Z"));
    const f = await create();
    await f.registry.register("phone", "host", registration(), () => true);
    await f.registry.publish(update(), f.connection);
    const older = f.registry.publish(update(2, { runningCount: 2 }), f.connection);
    const newer = f.registry.publish(update(3, { phase: "attention", pendingCount: 1 }), f.connection);
    await vi.advanceTimersByTimeAsync(1000); await Promise.all([older, newer]);
    expect(f.send).toHaveBeenCalledTimes(2);
    expect(f.send.mock.calls[1]![2]).toMatchObject({ timestamp: Math.floor(Date.now() / 1000), priority: 10,
      contentState: { phase: "attention", pendingCount: 1 } });
    const heartbeat = f.registry.publish(update(4, { phase: "attention", pendingCount: 1 }), f.connection);
    await vi.advanceTimersByTimeAsync(1000); await heartbeat;
    expect(f.send.mock.calls[2]![2].priority).toBe(5);
    const end = f.registry.publish(update(5, { phase: "ended", runningCount: 0, outcome: "completed" }), f.connection);
    await vi.advanceTimersByTimeAsync(1000); await end;
    expect(f.send.mock.calls[3]![2]).toMatchObject({ event: "end", priority: 10 });
    await f.registry.publish(update(6, { phase: "ended", runningCount: 0, outcome: "completed" }), f.connection);
    await f.registry.register("phone", "host", registration(newToken, "activity-two"), () => true);
    await settle();
    expect(f.send).toHaveBeenCalledTimes(4);
  });

  // LIVE-ACTIVITY-02: the last approval clearing outranks the cooldown.
  it("prioritizes approval clear and not a subsequent ordinary update", async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-11-17T00:00:00.000Z"));
    const f = await create();
    await f.registry.register("phone", "host", registration(), () => true);
    await f.registry.publish(update(1, { phase: "attention", pendingCount: 2 }), f.connection);
    const clear = f.registry.publish(update(2), f.connection);
    await vi.advanceTimersByTimeAsync(1_000); await clear;
    const ordinary = f.registry.publish(update(3, { runningCount: 2 }), f.connection);
    await vi.advanceTimersByTimeAsync(1_000); await ordinary;
    expect(f.send.mock.calls.map(([, , push]) => push.priority)).toEqual([10, 10, 5]);
  });

  // The Relay never makes an independent focus choice. Only the winner of
  // foreground/background arbitration gets this exact Host summary.
  it("claims the Host snapshot before start and does not let a heartbeat create another activity", async () => {
    const f = await create();
    const host = update(1, { focusKey: "b".repeat(64), agentKind: "pi", runningCount: 2 });
    await f.registry.publish(host, f.connection, 2);
    const claim = await f.registry.claim("phone", "host", claimRequest, () => true);
    expect(claim?.contentState).toEqual({ ...host.contentState, sessionCount: 2 });
    await f.registry.registerStart("phone", "host", pairingRef, startRegistration(), () => true);
    await f.registry.publish(update(2), f.connection, 1);
    expect(f.send).not.toHaveBeenCalled();
    expect(await f.registry.claim("phone", "host", claimRequest, () => true)).toBeUndefined();
    await f.registry.cancelClaim("phone", "host", { version: 1, launchId: claim!.launchId }, () => true);
    await f.registry.publish(update(3), f.connection);
    await vi.waitFor(() => expect(f.send).toHaveBeenCalledTimes(1));
    expect(f.send.mock.calls[0]![2]).toMatchObject({ event: "start", attributes: { hostId: "host", pairingRef } });
    expect(await f.registry.claim("phone", "host", claimRequest, () => true)).toBeUndefined();
  });

  // Keep the exact end even if a phone obtains its update token after a new
  // run, and also after the Relay process has been restarted during handoff.
  it("replays an end matching a late push-start token across restart and rejects an old registration after replacement", async () => {
    const f = await create(true);
    await f.registry.registerStart("phone", "host", pairingRef, startRegistration(), () => true);
    await f.registry.publish(update(), f.connection);
    await vi.waitFor(() => expect(f.send).toHaveBeenCalledTimes(1));
    const start = f.send.mock.calls[0]![2];
    if (start.event !== "start") throw new Error("expected a start");
    const completion = update(2, { phase: "ended", outcome: "completed", runningCount: 0, agentKind: "kimiCode" });
    await f.registry.publish(parseLiveActivityUpdate(completion), f.connection);
    await f.registry.close();
    const restored = await RelayLiveActivities.create(f.options); open.push(restored);
    const activity = { ...registration(), launchId: start.attributes.launchId };
    await restored.register("phone", "host", activity, () => true);
    await vi.waitFor(() => expect(f.send).toHaveBeenCalledTimes(2), { timeout: 2_000 });
    expect(f.send.mock.calls[1]![2]).toMatchObject({ event: "end", priority: 10, contentState: { ...completion.contentState, agentKind: null } });
    expect(f.send.mock.calls[1]![2].timestamp).toBeGreaterThan(start.timestamp);
    await vi.waitFor(async () => expect(JSON.parse(await readFile(f.stateFile!, "utf8")).registrations).toEqual([]));
    await restored.register("phone", "host", activity, () => true); // refresh before iOS displays the end
    await restored.publish(update(3), f.connection);
    await vi.waitFor(() => expect(f.send).toHaveBeenCalledTimes(3));
    expect(f.send.mock.calls[2]![2]).toMatchObject({ event: "start" });
    await expect(restored.register("phone", "host", activity, () => true)).rejects.toMatchObject({ status: 410 });
  });

  it("keeps a dismissal across heartbeats, while a confirmed new batch can start again", async () => {
    const f = await create();
    await f.registry.registerStart("phone", "host", pairingRef, startRegistration(), () => true);
    await f.registry.publish(update(), f.connection);
    await vi.waitFor(() => expect(f.send).toHaveBeenCalledTimes(1));
    const first = f.send.mock.calls[0]![2];
    if (first.event !== "start") throw new Error("expected a start");
    await f.registry.register("phone", "host", { ...registration(null), launchId: first.attributes.launchId }, () => true);
    await f.registry.publish(update(2, { runningCount: 2 }), f.connection);
    expect(await f.registry.claim("phone", "host", claimRequest, () => true)).toBeUndefined();
    expect(f.send).toHaveBeenCalledTimes(1);
    await f.registry.publish(update(3, { phase: "ended", runningCount: 0, outcome: "completed" }), f.connection);
    await f.registry.publish(update(4), f.connection);
    await vi.waitFor(() => expect(f.send).toHaveBeenCalledTimes(2));
  });

  it("starts per pairing even when two computers share the same iPhone start token", async () => {
    const f = await create();
    const other = {}; f.connections.set("other-host", other);
    await f.registry.registerStart("phone", "host", pairingRef, startRegistration(), () => true);
    await f.registry.registerStart("other", "other-host", "f".repeat(64), startRegistration(undefined, false), () => true);
    await f.registry.publish(update(), f.connection);
    await f.registry.publish({ ...update(), hostId: "other-host" }, other);
    await vi.waitFor(() => expect(f.send).toHaveBeenCalledTimes(2));
    expect(f.send.mock.calls.map(([, , push]) => push)).toEqual(expect.arrayContaining([
      expect.objectContaining({ event: "start", inputPushToken: true, attributes: expect.objectContaining({ hostId: "host" }) }),
      expect.objectContaining({ event: "start", inputPushToken: false, attributes: expect.objectContaining({ hostId: "other-host" }) }),
    ]));
  });

  it("binds delivery failures and revocation to the original start-token registration", async () => {
    const f = await create();
    await f.registry.registerStart("phone", "host", pairingRef, startRegistration(), () => true);
    let reply!: (result: "invalid-token") => void;
    f.send.mockImplementationOnce(() => new Promise(resolve => { reply = resolve; }));
    await f.registry.publish(update(), f.connection);
    await vi.waitFor(() => expect(reply).toBeDefined());
    await f.registry.registerStart("phone", "host", pairingRef, startRegistration(newToken), () => true);
    reply("invalid-token");
    await vi.waitFor(() => expect(f.send).toHaveBeenCalledTimes(2));
    expect(f.send.mock.calls[1]![1]).toBe(newToken);
    f.paired.delete("phone:host"); await f.registry.removeDevice("phone");
    await expect(f.registry.registerStart("phone", "host", pairingRef, startRegistration(), () => true)).rejects.toMatchObject({ status: 401 });
    await f.registry.publish(update(2), f.connection);
    expect(f.send).toHaveBeenCalledTimes(2);
  });

  it("does not let a late old producer, revision, or connection overwrite the current Host", async () => {
    const f = await create();
    await f.registry.publish(update(10), f.connection);
    await expect(f.registry.publish(update(9), f.connection)).rejects.toMatchObject({ status: 409 });
    await expect(f.registry.publish({ ...update(11), producerId: "other" }, f.connection)).rejects.toMatchObject({ status: 409 });
    const replacement = {}; f.connections.set("host", replacement);
    await expect(f.registry.publish(update(11), f.connection)).rejects.toMatchObject({ status: 409 });
    await expect(f.registry.publish({ ...update(), producerId: "replacement" }, replacement)).resolves.toEqual({ sent: [], failed: [] });
  });

  it("serializes equal tokens after re-pairing and never crosses Host boundaries", async () => {
    const f = await create();
    await f.registry.register("phone", "host", registration(), () => true);
    await f.registry.register("tablet", "host", registration(), () => true);
    await expect(f.registry.register("other", "other-host", registration(), () => true)).rejects.toMatchObject({ status: 409 });
    await f.registry.register("other", "other-host", registration(newToken), () => true);
    await f.registry.publish(update(), f.connection);
    expect(f.send).toHaveBeenCalledTimes(1);
    expect(f.send.mock.calls[0]![1]).toBe(oldToken);
  });

  // LA-COMPAT-02: the released writer rewrites the v1 file during rollback, even for a token refresh.
  it.each(["same activity", "replacement", "removed"] as const)("reconciles %s after a rollback writer rewrites registrations", async variant => {
    const f = await create(true);
    await f.registry.publish(update(), f.connection);
    await f.registry.registerStart("tablet", "host", pairingRef, startRegistration(), () => true);
    const claim = await f.registry.claim("phone", "host", claimRequest, () => true);
    expect(claim).toBeDefined();
    const bound = { ...registration(), launchId: claim!.launchId };
    await f.registry.register("phone", "host", bound, () => true);
    const path = f.stateFile!;
    const initial = JSON.parse(await readFile(path, "utf8"));
    expect(Object.keys(initial).sort()).toEqual(["registrations", "version"]);
    const launchPath = `${path}.launches.json`;
    const sidecar = await readFile(launchPath, "utf8");
    await f.registry.close();
    const activity = variant === "same activity" ? bound.activityId : "replacement";
    const legacyInfo = registration(variant === "removed" ? null : newToken, variant === "removed" ? bound.activityId : activity);
    if (released) {
      const old = await released.create(f.options); open.push(old);
      await old.register("phone", "host", legacyInfo, () => true);
      await old.close();
    } else {
      const prior = initial.registrations.find((target: { deviceId: string }) => target.deviceId === "phone");
      delete prior.launchId; // The released writer drops the field when it changes a registration.
      await writeFile(path, JSON.stringify({ version: 1, registrations: variant === "removed" ? [] : [{ ...prior, activityId: activity, token: newToken }] }));
    }
    expect(await readFile(launchPath, "utf8")).toBe(sidecar);
    const restored = await RelayLiveActivities.create(f.options); open.push(restored);
    if (variant === "same activity") {
      const disk = JSON.parse(await readFile(path, "utf8"));
      expect(disk.registrations).toContainEqual(expect.objectContaining({ activityId: bound.activityId, token: newToken, launchId: bound.launchId }));
      await expect(restored.register("phone", "host", { ...bound, token: newToken }, () => true)).resolves.toBeUndefined();
    } else {
      await expect(restored.register("phone", "host", bound, () => true)).rejects.toMatchObject({ status: 410 });
      const disk = JSON.parse(await readFile(path, "utf8"));
      expect(disk.registrations.filter((target: { deviceId: string }) => target.deviceId === "phone")).toEqual(variant === "removed" ? [] : [expect.objectContaining({ activityId: activity, token: newToken })]);
    }
    expect(JSON.parse(await readFile(launchPath, "utf8")).startTargets).toContainEqual(expect.objectContaining({ deviceId: "tablet" }));
  });

  it("keeps a bound activity eligible to rotate an invalid token after restart", async () => {
    const f = await create(true);
    await f.registry.publish(update(), f.connection);
    const claim = await f.registry.claim("phone", "host", claimRequest, () => true);
    expect(claim).toBeDefined();
    f.send.mockResolvedValueOnce("invalid-token");
    const bound = { ...registration(), launchId: claim!.launchId };
    await f.registry.register("phone", "host", bound, () => true);
    await vi.waitFor(async () => expect(JSON.parse(await readFile(f.stateFile!, "utf8")).registrations).toEqual([]), { timeout: 2_000 });
    await f.registry.close();
    const restored = await RelayLiveActivities.create(f.options); open.push(restored);
    await expect(restored.register("phone", "host", { ...bound, activityId: "different", token: newToken }, () => true)).rejects.toMatchObject({ status: 410 });
    await expect(restored.register("phone", "host", { ...bound, token: newToken }, () => true)).resolves.toBeUndefined();
    const sidecar = JSON.parse(await readFile(`${f.stateFile!}.launches.json`, "utf8"));
    expect(sidecar.launches[0]).not.toHaveProperty("invalidToken");
  });

  it("migrates the original combined file and does not revive entries dropped by the sidecar", async () => {
    const f = await create(true);
    const path = f.stateFile!;
    const launchPath = `${path}.launches.json`;
    const id = "35d0dd4c-f37b-4a9d-ae9c-75fdd37d75a6";
    const combined = { version: 1, registrations: [{ deviceId: "phone", hostId: "host", activityId: "activity-one",
      token: oldToken, environment: "production", expiresAt: Date.now() + 15_000, launchId: id }],
      startTargets: [], launches: [{ deviceId: "phone", hostId: "host", id, via: "app", issuedAt: Date.now() }] };
    await writeFile(path, JSON.stringify(combined));
    const migrated = await RelayLiveActivities.create(f.options); open.push(migrated);
    expect(JSON.parse(await readFile(path, "utf8"))).not.toHaveProperty("launches");
    expect(JSON.parse(await readFile(launchPath, "utf8")).launches).toContainEqual(expect.objectContaining({ id, activityId: "activity-one" }));
    await migrated.close();
    await writeFile(path, JSON.stringify(combined)); // interrupted or stale legacy rewrite
    await writeFile(launchPath, JSON.stringify({ version: 1, startTargets: [], launches: [] }));
    const restarted = await RelayLiveActivities.create(f.options); open.push(restarted);
    await expect(restarted.register("phone", "host", { ...registration(), launchId: id }, () => true)).rejects.toMatchObject({ status: 410 });
  });

  // LA-COMPAT-02: a process stop between the two renames cannot restore
  // a staged binding without the matching committed registration.
  it("does not revive a binding interrupted before the registration rename", async () => {
    const f = await create(true);
    await f.registry.publish(update(), f.connection);
    const claim = await f.registry.claim("phone", "host", claimRequest, () => true);
    expect(claim).toBeDefined();
    const bound = { ...registration(), launchId: claim!.launchId };
    await f.registry.register("phone", "host", bound, () => true);
    await f.registry.close();
    const path = f.stateFile!;
    await writeFile(path, JSON.stringify({ version: 1, registrations: [] }));
    const restored = await RelayLiveActivities.create(f.options); open.push(restored);
    f.send.mockClear();
    expect(await restored.publish(update(2), f.connection)).toEqual({ sent: [], failed: [] });
    await expect(restored.register("phone", "host", bound, () => true)).rejects.toMatchObject({ status: 410 });
    expect(f.send).not.toHaveBeenCalled();
  });

  // LA-COMPAT-02: if the legacy-file rename fails after staging a binding,
  // a restart must recover the original reservation, not a phantom activity.
  it("rolls back a staged binding when committing the registration fails", async () => {
    const f = await create(true);
    await f.registry.publish(update(), f.connection);
    const claim = await f.registry.claim("phone", "host", claimRequest, () => true);
    expect(claim).toBeDefined();
    const bound = { ...registration(), launchId: claim!.launchId };
    const path = f.stateFile!, launchPath = `${path}.launches.json`;
    const reservation = await readFile(launchPath, "utf8");
    const realRename = (await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")).rename;
    vi.mocked(rename).mockImplementationOnce(realRename).mockRejectedValueOnce(new Error("registration commit failed"));
    await expect(f.registry.register("phone", "host", bound, () => true)).rejects.toThrow("registration commit failed");
    expect(await readFile(launchPath, "utf8")).toBe(reservation);
    expect(f.send).not.toHaveBeenCalled();
    await f.registry.close();
    const restored = await RelayLiveActivities.create(f.options); open.push(restored);
    await restored.register("phone", "host", bound, () => true);
    expect(JSON.parse(await readFile(path, "utf8")).registrations).toContainEqual(expect.objectContaining({ activityId: bound.activityId, launchId: bound.launchId }));
  });

  it("restores registrations, removes revoked devices, and prevents failed disk rollback from deleting a later token", async () => {
    const f = await create(true);
    await f.registry.register("phone", "host", registration(), () => true);
    let fail!: (reason: Error) => void;
    vi.mocked(rename).mockImplementationOnce(() => new Promise((_, reject) => { fail = reject; }));
    const older = f.registry.register("phone", "host", registration(newToken), () => true).catch(error => error);
    await vi.waitFor(() => expect(fail).toBeDefined());
    const newer = f.registry.register("phone", "host", registration("c".repeat(64)), () => true);
    fail(new Error("disk failure"));
    expect(await older).toBeInstanceOf(Error); await newer;
    await f.registry.close();
    const restored = await RelayLiveActivities.create(f.options); open.push(restored);
    await restored.publish(update(), f.connection);
    expect(f.send.mock.calls.at(-1)![1]).toBe("c".repeat(64));
    f.paired.delete("phone:host"); await restored.removeDevice("phone");
    expect(JSON.parse(await readFile(f.stateFile!, "utf8")).registrations).toEqual([]);
  });
});
