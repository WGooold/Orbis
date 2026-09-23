import { afterEach, describe, expect, it, vi } from "vitest";
import type { RuntimeEvent, SessionSyncRequest } from "@pi-remote/protocol";
import { SESSION_SYNC_WIRE_LIMIT_BYTES } from "./device-link.js";
import { SessionSyncTasks } from "./session-sync-tasks.js";

const managers: SessionSyncTasks[] = [];
afterEach(() => { for (const manager of managers.splice(0)) manager.close(); });
const request = (syncId = "sync", range: SessionSyncRequest["range"] = "preview"): SessionSyncRequest =>
  ({ type: "session.sync", sessionId: "session", syncId, range, targetLeafId: "leaf", maxEntries: 100 });
const snapshot = (syncId: string): RuntimeEvent => ({ type: "session.snapshot", sessionId: "session", syncId,
  mode: "replace", range: "preview", cursor: { leafId: "leaf" }, targetLeafId: "leaf", entries: [], complete: true });
function harness(synchronous = false) {
  let now = 0;
  let available = true;
  let accept = true;
  const sends: { deviceId: string; payload: Buffer; done: (written: boolean) => void }[] = [];
  const dispatches: { runtimeId: string; id: string; command: SessionSyncRequest }[] = [];
  const error = vi.fn();
  const sendEvent = vi.fn();
  const manager = new SessionSyncTasks({
    now: () => now,
    link: (deviceId) => ({ active: available ? "relay" : undefined, sessionSyncQueuedBytes: 0,
      sendSessionSnapshot: (payload, done) => {
        if (!accept) return false;
        sends.push({ deviceId, payload: Buffer.from(payload), done });
        return true;
      } }),
    dispatch: (runtimeId, id, command) => {
      dispatches.push({ runtimeId, id, command });
      if (synchronous) manager.handleEvent(runtimeId, snapshot(command.syncId));
      return "handled";
    },
    encodeEvent: (runtimeId, event) => Buffer.from(JSON.stringify({ runtimeId, event })), error, sendEvent,
  });
  managers.push(manager);
  return { manager, sends, dispatches, error, sendEvent,
    time: (value: number) => { now = value; }, offline: () => { available = false; }, reject: () => { accept = false; } };
}

describe("SessionSyncTasks", () => {
  it("registers before synchronous dispatch and only sends to the requesting device", () => {
    const h = harness(true);
    h.manager.request("a", "runtime", "cmd", request());
    h.manager.tick();
    expect(h.sends.map((send) => send.deviceId)).toEqual(["a"]);
    expect(JSON.parse(h.sends[0]!.payload.toString()).event.syncId).toBe("sync");
    expect(h.dispatches[0]!.command.syncId).not.toBe("sync");
    expect(h.manager.handleEvent("runtime", snapshot("unsolicited-codex"))).toBe(true);
    expect(h.sends).toHaveLength(1);
    h.manager.request("b", "runtime", "cmd", request());
    h.manager.tick();
    expect(h.sends.map((send) => send.deviceId)).toEqual(["a", "b"]);
    expect(h.dispatches[0]!.id).not.toBe(h.dispatches[1]!.id);
  });

  it("deduplicates processing and sending but permits bounded regeneration after socket delivery", () => {
    const h = harness();
    h.manager.request("a", "runtime", "cmd", request());
    h.manager.tick();
    const first = h.dispatches[0]!;
    h.manager.handleEvent("runtime", { type: "command.result", commandId: first.id, ok: true });
    expect(h.sendEvent).toHaveBeenCalledWith("a", "runtime", { type: "command.result", commandId: "cmd", ok: true });
    h.time(30_000);
    h.manager.request("a", "runtime", "cmd", request());
    h.manager.tick();
    expect(h.dispatches).toHaveLength(1);
    expect(h.manager.stats("a").reservedBytes).toBeGreaterThan(0);
    h.manager.handleEvent("runtime", snapshot(first.command.syncId));
    h.manager.request("a", "runtime", "cmd", request());
    expect(h.sends).toHaveLength(1);
    h.sends[0]!.done(true);
    expect(h.manager.stats("a").reservedBytes).toBe(0);
    for (let attempt = 2; attempt <= 4; attempt += 1) {
      h.time(30_000 * attempt);
      h.manager.request("a", "runtime", "cmd", request());
      h.manager.tick();
      const next = h.dispatches.at(-1)!;
      h.manager.handleEvent("runtime", snapshot(next.command.syncId));
      h.sends.at(-1)!.done(true);
    }
    h.time(150_000);
    h.manager.request("a", "runtime", "cmd", request());
    h.manager.tick();
    expect(h.dispatches).toHaveLength(4);
    expect(h.error).toHaveBeenLastCalledWith("a", "cmd", "session_sync_retry_exhausted");
  });

  it("rejects reused IDs with changed immutable boundaries", () => {
    const h = harness();
    h.manager.request("a", "runtime", "cmd", request());
    h.manager.request("a", "runtime", "cmd", { ...request(), targetLeafId: "other" });
    h.manager.request("a", "runtime", "cmd2", request());
    h.manager.tick();
    expect(h.error.mock.calls).toEqual([
      ["a", "cmd", "session_sync_id_conflict"], ["a", "cmd2", "session_sync_id_conflict"],
    ]);
    expect(h.dispatches).toHaveLength(1);
  });

  it("prioritizes foreground with bounded pending tasks and progress for background", () => {
    const h = harness();
    h.manager.request("a", "runtime", "bg", request("bg", "catchup"));
    h.manager.request("a", "runtime", "fg", request("fg", "history"));
    for (let i = 0; i < 10; i += 1) h.manager.request("a", "runtime", `c${i}`, request(`s${i}`));
    h.manager.tick();
    expect(h.dispatches.map((item) => item.command.range)).toEqual(["history", "catchup"]);
    expect(h.manager.stats("a")).toMatchObject({ records: 8, pending: 8, active: 2 });
    expect(h.manager.stats("a").reservedBytes).toBeLessThanOrEqual(SESSION_SYNC_WIRE_LIMIT_BYTES);
    expect(h.error).toHaveBeenCalledTimes(4);
  });

  it("queue refusal and path loss return correlated errors and release budget", () => {
    const h = harness();
    h.manager.request("a", "runtime", "cmd", request()); h.manager.tick();
    h.reject();
    h.manager.handleEvent("runtime", snapshot(h.dispatches[0]!.command.syncId));
    expect(h.error).toHaveBeenLastCalledWith("a", "cmd", "session_sync_busy_or_unavailable", undefined);
    expect(h.manager.stats("a").reservedBytes).toBe(0);
    h.offline();
    h.manager.request("b", "runtime", "offline", request());
    expect(h.error).toHaveBeenLastCalledWith("b", "offline", "session_sync_path_unavailable");
    expect(h.manager.stats("b").records).toBe(0);
  });

  it("new connection isolates old callbacks even when the device reuses its IDs", () => {
    const h = harness();
    h.manager.request("a", "runtime", "cmd", request()); h.manager.tick();
    const old = h.dispatches[0]!;
    h.manager.clearDevice("a");
    h.manager.request("a", "runtime", "cmd", request()); h.manager.tick();
    expect(h.manager.handleEvent("runtime", snapshot(old.command.syncId))).toBe(true);
    expect(h.manager.handleEvent("runtime", { type: "runtime.error", commandId: old.id, message: "old", recoverable: true })).toBe(true);
    expect(h.sends).toHaveLength(0);
    expect(h.error).not.toHaveBeenCalled();
    h.manager.handleEvent("runtime", snapshot(h.dispatches[1]!.command.syncId));
    h.sends[0]!.done(false);
    expect(h.error).toHaveBeenLastCalledWith("a", "cmd", "session_sync_path_lost", undefined);
  });

  it("retained records are bounded and expire without retaining page bodies", () => {
    const h = harness(true);
    for (let i = 0; i < 100; i += 1) {
      h.manager.request("a", "runtime", `c${i}`, request(`s${i}`));
      h.manager.tick();
      h.sends.at(-1)!.done(true);
    }
    expect(h.manager.stats("a")).toEqual({ records: 32, pending: 0, active: 0, reservedBytes: 0 });
    h.time(300_000); h.manager.tick();
    expect(h.manager.stats("a").records).toBe(0);
  });
});
