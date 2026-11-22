import { readFile, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
    for (const agentKind of ["kimiCode", "hermes", "openclaw"]) {
      expect(() => parseLiveActivityUpdate({ ...valid, contentState: { ...valid.contentState, agentKind } })).toThrow();
    }
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
    const completion = update(2, { phase: "ended", outcome: "completed", runningCount: 0 });
    await f.registry.publish(completion, f.connection);
    await f.registry.close();
    const restored = await RelayLiveActivities.create(f.options); open.push(restored);
    const activity = { ...registration(), launchId: start.attributes.launchId };
    await restored.register("phone", "host", activity, () => true);
    await vi.waitFor(() => expect(f.send).toHaveBeenCalledTimes(2), { timeout: 2_000 });
    expect(f.send.mock.calls[1]![2]).toMatchObject({ event: "end", priority: 10, contentState: completion.contentState });
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
