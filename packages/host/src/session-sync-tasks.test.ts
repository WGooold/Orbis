import { afterEach, describe, expect, it, vi } from "vitest";
import type { RuntimeEvent, SessionSyncRequest } from "@orbis/protocol";
import { SESSION_SYNC_WIRE_LIMIT_BYTES } from "./device-link.js";
import { SessionSyncTasks } from "./session-sync-tasks.js";

const managers: SessionSyncTasks[] = [];
afterEach(() => { for (const manager of managers.splice(0)) manager.close(); });
const request = (syncId = "sync", range: SessionSyncRequest["range"] = "preview"): SessionSyncRequest =>
  ({ type: "session.sync", sessionId: "session", syncId, range, targetLeafId: "leaf", maxEntries: 100 });
const snapshot = (syncId: string): Extract<RuntimeEvent, { type: "session.snapshot" }> => ({ type: "session.snapshot", sessionId: "session", syncId,
  mode: "replace", range: "preview", cursor: { leafId: "leaf" }, targetLeafId: "leaf", entries: [], complete: true });
function harness(synchronous = false, options: Partial<ConstructorParameters<typeof SessionSyncTasks>[0]> = {}) {
  let now = 0;
  let available = true;
  let accept = true;
  const sends: { deviceId: string; payload: Buffer; done: (written: boolean) => void; onProgress: (() => void) | undefined; range?: SessionSyncRequest["range"] }[] = [];
  const dispatches: { runtimeId: string; id: string; command: SessionSyncRequest }[] = [];
  const error = vi.fn();
  const log = vi.fn();
  const sendEvent = vi.fn();
  const manager = new SessionSyncTasks({
    now: () => now,
    link: (deviceId) => ({ active: available ? "relay" : undefined, sessionSyncQueuedBytes: 0,
      sendSessionSnapshot: (payload, done, onProgress, _source, range) => {
        if (!accept) return false;
        sends.push({ deviceId, payload: Buffer.from(payload), done, onProgress, ...(range === undefined ? {} : { range }) });
        return true;
      } }),
    dispatch: (runtimeId, id, command) => {
      dispatches.push({ runtimeId, id, command });
      if (synchronous) manager.handleEvent(runtimeId, { ...snapshot(command.syncId), range: command.range } as RuntimeEvent);
      return "handled";
    },
    encodeEvent: (runtimeId, event) => Buffer.from(JSON.stringify({ runtimeId, event })), error, sendEvent, log, ...options,
  });
  managers.push(manager);
  return { manager, sends, dispatches, error, sendEvent, log,
    time: (value: number) => { now = value; }, offline: () => { available = false; }, reject: () => { accept = false; } };
}

describe("SessionSyncTasks", () => {
  // FT-G12-COMPAT-02: released adapters may return 64 KiB–1 MiB pages. Ordinary
  // reads preserve them; only negotiated historyWindow requests tighten this cap.
  it.each(["preview", "history", "catchup"] as const)("preserves a released adapter's larger %s page", range => {
    const h = harness();
    h.manager.request("a", "runtime", "command", request("legacy", range)); h.manager.tick();
    const event = { ...snapshot(h.dispatches[0]!.id), range, entries: [{ entryId: "leaf", parentId: null,
      type: "message", timestamp: "1", data: { text: "x".repeat(128 * 1024) } }] };
    h.manager.handleEvent("runtime", event);
    expect(h.error).not.toHaveBeenCalled();
    expect(h.sends).toHaveLength(1);
    expect(h.sends[0]!.payload.byteLength).toBeGreaterThan(64 * 1024);
    expect(JSON.parse(h.sends[0]!.payload.toString()).event).toEqual({ ...event, syncId: "legacy" });
    expect(h.manager.stats("a").reservedBytes).toBeGreaterThan(h.sends[0]!.payload.byteLength);
  });

  // ADR-0069: Host enforces exact final-envelope bytes and does not replay more reserved pages
  // than the client could afford, even if ACK was lost or the request is duplicated.
  it("bounds reserved history responses and preserves the nearest boundary suffix", () => {
    const h = harness();
    const command = { ...request("window", "history"), targetLeafId: "e4", beforeEntryId: "e4",
      historyWindow: { format: "v1" as const, maxBytes: 8192, maxDeliveries: 1 } };
    h.manager.request("a", "runtime", "command", command); h.manager.tick();
    const entries = [1, 2, 3].map(n => ({ entryId: `e${n}`, parentId: n === 1 ? null : `e${n - 1}`,
      type: "message", timestamp: "1", data: { text: "界".repeat(1100) } }));
    h.manager.handleEvent("runtime", { ...snapshot(h.dispatches[0]!.id), range: "history", mode: "prepend",
      cursor: { leafId: "e4" }, targetLeafId: "e4", beforeEntryId: "e4", entries, hasOlder: false });
    expect(h.sends).toHaveLength(1);
    expect(h.sends[0]!.payload.byteLength).toBeLessThanOrEqual(8192);
    expect(JSON.parse(h.sends[0]!.payload.toString()).event).toMatchObject({
      entries: entries.slice(1), hasOlder: true, complete: false, rangeStatus: "older_available", beforeEntryId: "e4",
    });
    h.sends[0]!.done(true); h.time(31_000);
    h.manager.request("a", "runtime", "command", command); h.manager.tick();
    expect(h.error).toHaveBeenLastCalledWith("a", "command", "session_sync_retry_exhausted");
    expect(h.sends).toHaveLength(1);
    h.manager.request("a", "runtime", "command", { ...command, historyWindow: { ...command.historyWindow, maxDeliveries: 2 } });
    expect(h.error).toHaveBeenLastCalledWith("a", "command", "session_sync_id_conflict");
  });
  it.each(["history", "catchup"] as const)("rebuilds Host state privately before %s without changing the device request", async range => {
    // DSH-SYNC-09：Host重启后先取完整preview；只把原range交给原设备，迟到的内部回应不再生效。
    let needsBaseline = true;
    const acceptSnapshot = vi.fn((_runtimeId: string, event: Extract<RuntimeEvent, { type: "session.snapshot" }>) => {
      if (event.range === "preview") needsBaseline = false;
      return true;
    });
    const h = harness(false, { needsBaseline: () => needsBaseline, acceptSnapshot });
    const command = { ...request("original", range), knownLeafId: "known", beforeEntryId: "before" };
    h.manager.request("a", "runtime", "cmd", command); h.manager.tick();
    const first = h.dispatches[0]!;
    expect(first.command).toEqual({ type: "session.sync", sessionId: "session", syncId: first.id, range: "preview" });
    h.manager.handleEvent("runtime", { type: "command.result", commandId: first.id, ok: true });
    expect(h.sendEvent).not.toHaveBeenCalled();
    const reserved = h.manager.stats("a").reservedBytes;
    h.manager.handleEvent("runtime", snapshot(first.id));
    expect(h.sends).toHaveLength(0);
    expect(h.manager.stats("a")).toMatchObject({ active: 1, reservedBytes: reserved });
    await Promise.resolve();
    const second = h.dispatches[1]!;
    expect(second.id).not.toBe(first.id);
    expect(second.command).toEqual({ ...command, syncId: second.id });
    h.manager.handleEvent("runtime", snapshot(first.id));
    h.manager.handleEvent("runtime", { type: "command.result", commandId: first.id, ok: false });
    expect(acceptSnapshot).toHaveBeenCalledTimes(1);
    h.manager.handleEvent("runtime", { ...snapshot(second.id), range } as RuntimeEvent);
    expect(h.sends).toHaveLength(1);
    expect(h.sends[0]!.range).toBe(range);
    expect(JSON.parse(h.sends[0]!.payload.toString())).toMatchObject({ event: { syncId: "original", range } });
    expect(h.error).not.toHaveBeenCalled();
  });

  it("forwards the original range success after its snapshot while keeping private preview success internal", async () => {
    // DSH-SYNC-13：后端通常先发快照再发成功回执；保留原请求回执与内部preview的隔离。
    let needsBaseline = true;
    const h = harness(false, { needsBaseline: () => needsBaseline, acceptSnapshot: () => { needsBaseline = false; return true; } });
    h.manager.request("a", "runtime", "cmd", request("sync", "catchup")); h.manager.tick();
    const first = h.dispatches[0]!;
    h.manager.handleEvent("runtime", snapshot(first.id));
    h.manager.handleEvent("runtime", { type: "command.result", commandId: first.id, ok: true });
    expect(h.sendEvent.mock.calls.filter(([, , event]) => event.type === "command.result")).toHaveLength(0);
    await Promise.resolve();
    const second = h.dispatches[1]!;
    h.manager.handleEvent("runtime", { ...snapshot(second.id), range: "catchup" });
    h.manager.handleEvent("runtime", { type: "command.result", commandId: second.id, ok: true });
    expect(h.sendEvent).toHaveBeenLastCalledWith("a", "runtime", { type: "command.result", commandId: "cmd", ok: true });
    expect(h.sends).toHaveLength(1);
    h.sends[0]!.done(true);
    h.manager.acknowledge("a", "sync", "applied");
    const accepted = h.sendEvent.mock.calls.length;
    h.manager.handleEvent("runtime", { type: "command.result", commandId: second.id, ok: true });
    expect(h.sendEvent).toHaveBeenCalledTimes(accepted);
    expect(h.error).not.toHaveBeenCalled();
  });

  it("registers both recovery stages before synchronous responses", async () => {
    // DSH-SYNC-10：内存后端可在dispatch返回前同时完成preview与range。
    let needsBaseline = true;
    const h = harness(true, { needsBaseline: () => needsBaseline, acceptSnapshot: () => { needsBaseline = false; return true; } });
    h.manager.request("a", "runtime", "cmd", request("sync", "catchup")); h.manager.tick();
    await Promise.resolve();
    expect(h.dispatches.map(item => item.command.range)).toEqual(["preview", "catchup"]);
    expect(h.sends).toHaveLength(1);
    expect(h.error).not.toHaveBeenCalled();
  });

  it.each(["rejected", "not-ready", "offline", "expired"] as const)("releases recovery resources when the baseline is %s", failure => {
    // DSH-SYNC-11：未建好基线、断线和租约过期均有界终止；迟到preview不能复活模型。
    const acceptSnapshot = vi.fn(() => failure !== "rejected");
    const h = harness(false, { needsBaseline: () => true, acceptSnapshot });
    h.manager.request("a", "runtime", "cmd", request("sync", "catchup")); h.manager.tick();
    const first = h.dispatches[0]!;
    if (failure === "offline") h.manager.runtimeOffline("runtime");
    else if (failure === "expired") { h.time(120_000); h.manager.tick(); }
    else h.manager.handleEvent("runtime", snapshot(first.id));
    expect(h.error).toHaveBeenCalledTimes(1);
    expect(h.error).toHaveBeenCalledWith("a", "cmd", failure === "offline" ? "runtime_offline" :
      failure === "expired" ? "session_sync_lease_expired" : "session_sync_model_rejected", undefined);
    const accepted = acceptSnapshot.mock.calls.length;
    h.manager.handleEvent("runtime", snapshot(first.id));
    expect(acceptSnapshot).toHaveBeenCalledTimes(accepted);
    expect(h.dispatches).toHaveLength(1);
    expect(h.sends).toHaveLength(0);
    expect(h.manager.stats("a")).toMatchObject({ active: 0, pending: 0, reservedBytes: 0 });
  });

  it.each(["offline", "clear", "close"] as const)("cancels the continuation between recovery stages on %s", async cancellation => {
    // DSH-SYNC-12：内部preview完成后的调度间隙也遵守会话生命周期。
    let needsBaseline = true;
    const h = harness(false, { needsBaseline: () => needsBaseline, acceptSnapshot: () => { needsBaseline = false; return true; } });
    h.manager.request("a", "runtime", "cmd", request("sync", "catchup")); h.manager.tick();
    h.manager.handleEvent("runtime", snapshot(h.dispatches[0]!.id));
    if (cancellation === "offline") h.manager.runtimeOffline("runtime");
    else if (cancellation === "clear") h.manager.clearDevice("a");
    else h.manager.close();
    await Promise.resolve();
    expect(h.dispatches).toHaveLength(1);
    expect(h.sends).toHaveLength(0);
    expect(h.manager.stats("a").reservedBytes).toBe(0);
  });

  it.each(["preview", "history", "catchup"] as const)("passes the registered %s range to delivery without trusting response routing", (range) => {
    const h = harness();
    h.manager.request("a", "runtime", "cmd", request("sync", range));
    h.manager.tick();
    // A backend response's range cannot change the immutable transport classification.
    h.manager.handleEvent("runtime", snapshot(h.dispatches[0]!.command.syncId));
    expect(h.sends).toHaveLength(1);
    expect(h.sends[0]!.range).toBe(range);
  });

  it("keeps the applied baseline immutable across retry and rejects changed progress on the same ID", () => {
    const h = harness();
    const command = { ...request(), knownState: { epoch: "epoch", seq: 7, head: { leafId: "leaf" } } };
    h.manager.request("a", "runtime", "cmd", command);
    h.manager.tick();
    expect(h.dispatches[0]?.command.knownState).toEqual(command.knownState);
    h.manager.request("a", "runtime", "cmd", { ...command, knownState: { ...command.knownState, seq: 8 } });
    expect(h.error).toHaveBeenLastCalledWith("a", "cmd", "session_sync_id_conflict");
    expect(h.dispatches).toHaveLength(1);
  });
  it("answers a duplicate request with pending instead of staying silent", () => {
    const h = harness();
    h.manager.request("a", "runtime", "cmd", request());
    h.manager.tick();
    expect(h.dispatches).toHaveLength(1);
    h.manager.request("a", "runtime", "cmd", request());
    expect(h.sendEvent).toHaveBeenLastCalledWith("a", "runtime", {
      type: "session.sync.pending", commandId: "cmd", syncId: "sync", stage: "processing", leaseMs: 120_000,
    });
    expect(h.dispatches).toHaveLength(1);
  });

  it("aborts only when a stage stops making progress, not when it is merely slow", () => {
    const h = harness();
    h.manager.request("a", "runtime", "cmd", request());
    h.manager.tick();
    expect(h.manager.stats("a").reservedBytes).toBeGreaterThan(0);

    h.time(60_000);
    h.manager.tick();
    expect(h.error).not.toHaveBeenCalled();
    expect(h.manager.stats("a").reservedBytes).toBeGreaterThan(0);

    h.time(121_000);
    h.manager.tick();
    expect(h.error).toHaveBeenLastCalledWith("a", "cmd", "session_sync_lease_expired", undefined);
    expect(h.manager.stats("a").reservedBytes).toBe(0);

    h.manager.request("a", "runtime", "cmd-2", { ...request(), syncId: "sync-2" });
    h.manager.tick();
    h.manager.handleEvent("runtime", snapshot(h.dispatches.at(-1)!.command.syncId));
    expect(h.sends).toHaveLength(1);
    h.time(175_000);
    h.sends[0]!.onProgress?.();
    h.manager.tick();
    expect(h.error).not.toHaveBeenLastCalledWith("a", "cmd-2", "session_sync_lease_expired", undefined);
    h.time(240_000);
    h.manager.tick();
    expect(h.error).toHaveBeenLastCalledWith("a", "cmd-2", "session_sync_lease_expired", undefined);
  });

  it("commits on the device ack and retries a delivered page that is never acknowledged", () => {
    const h = harness();
    h.manager.request("a", "runtime", "cmd", request());
    h.manager.tick();
    h.manager.handleEvent("runtime", snapshot(h.dispatches.at(-1)!.command.syncId));
    h.sends.at(-1)!.done(true);
    h.manager.acknowledge("a", "sync", "applied");
    expect(h.error).not.toHaveBeenCalled();

    h.manager.request("a", "runtime", "cmd-2", { ...request(), syncId: "sync-2" });
    h.manager.tick();
    h.manager.handleEvent("runtime", snapshot(h.dispatches.at(-1)!.command.syncId));
    h.sends.at(-1)!.done(true);
    h.time(200_000);
    h.manager.tick();
    expect(h.error).toHaveBeenLastCalledWith("a", "cmd-2", "session_sync_ack_timeout", undefined);
  });

  it("keeps the first ACK terminal even when a socket callback or conflicting ACK arrives later", () => {
    const committed = harness(true);
    committed.manager.request("a", "runtime", "cmd", request());
    committed.manager.tick();
    committed.manager.acknowledge("a", "sync", "applied");
    committed.sends[0]!.done(false);
    committed.manager.acknowledge("a", "sync", "rejected");
    committed.manager.acknowledge("a", "sync", "applied");
    committed.time(200_000); committed.manager.tick();
    committed.manager.request("a", "runtime", "cmd", request());
    committed.manager.tick();
    expect(committed.dispatches).toHaveLength(1);
    expect(committed.sends).toHaveLength(1);
    expect(committed.sendEvent).toHaveBeenLastCalledWith("a", "runtime", expect.objectContaining({
      type: "session.sync.pending", syncId: "sync", stage: "delivered",
    }));
    expect(committed.error).not.toHaveBeenCalled();
    expect(committed.log.mock.calls.filter(([line]) => line.includes("stage=ack"))).toHaveLength(1);
    expect(committed.manager.stats("a").reservedBytes).toBe(0);

    const rejected = harness(true);
    rejected.manager.request("a", "runtime", "cmd", request());
    rejected.manager.tick();
    rejected.manager.acknowledge("a", "sync", "rejected");
    rejected.sends[0]!.done(true);
    rejected.manager.acknowledge("a", "sync", "rejected");
    rejected.manager.acknowledge("a", "sync", "applied");
    expect(rejected.error).toHaveBeenCalledTimes(1);
    expect(rejected.error).toHaveBeenCalledWith("a", "cmd", "session_sync_device_rejected", undefined);
    expect(rejected.log.mock.calls.some(([line]) => line.includes("stage=ack"))).toBe(false);
    rejected.manager.request("a", "runtime", "cmd", request());
    expect(rejected.error).toHaveBeenLastCalledWith("a", "cmd", "session_sync_retry_exhausted");
  });

  it("ignores ACKs before a response is sent and after the coordinator aborts", () => {
    const h = harness();
    h.manager.request("a", "runtime", "cmd", request());
    h.manager.acknowledge("a", "sync", "rejected");
    h.manager.tick();
    h.manager.acknowledge("a", "sync", "applied");
    expect(h.error).not.toHaveBeenCalled();
    expect(h.manager.stats("a").active).toBe(1);
    h.time(120_000); h.manager.tick();
    h.manager.acknowledge("a", "sync", "rejected");
    h.manager.acknowledge("a", "sync", "applied");
    expect(h.error).toHaveBeenCalledTimes(1);
    expect(h.error).toHaveBeenCalledWith("a", "cmd", "session_sync_lease_expired", undefined);
    expect(h.log.mock.calls.some(([line]) => line.includes("stage=ack"))).toBe(false);
  });

  it.each([false, true])("accepts a prior response ACK while an unacknowledged retry is preparing (processing=%s)", (processing) => {
    const h = harness();
    h.manager.request("a", "runtime", "cmd", request()); h.manager.tick();
    h.manager.handleEvent("runtime", snapshot(h.dispatches[0]!.command.syncId));
    h.time(10_000); h.sends[0]!.onProgress?.(); h.sends[0]!.done(true);
    h.time(30_000); h.manager.request("a", "runtime", "cmd", request());
    if (processing) h.manager.tick();
    h.manager.acknowledge("a", "sync", "applied");
    h.manager.tick();
    if (processing) h.manager.handleEvent("runtime", snapshot(h.dispatches[1]!.command.syncId));
    h.manager.acknowledge("a", "sync", "rejected");
    expect(h.dispatches).toHaveLength(processing ? 2 : 1);
    expect(h.sends).toHaveLength(1);
    expect(h.error).not.toHaveBeenCalled();
    expect(h.manager.stats("a")).toMatchObject({ pending: 0, active: 0, reservedBytes: 0 });
    expect(h.log.mock.calls.filter(([line]) => line.includes("stage=ack"))).toHaveLength(1);
  });

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
    for (let i = 0; i < 40; i += 1) h.manager.request("a", "runtime", `c${i}`, request(`s${i}`));
    h.manager.tick();
    expect(h.dispatches.map((item) => item.command.range)).toEqual(["history", "preview", "preview", "catchup"]);
    expect(h.manager.stats("a")).toMatchObject({ records: 32, pending: 32, active: 4 });
    expect(h.manager.stats("a").reservedBytes).toBeLessThanOrEqual(SESSION_SYNC_WIRE_LIMIT_BYTES);
    expect(h.error).toHaveBeenCalledTimes(10);
    expect(h.log).toHaveBeenCalledWith(expect.stringContaining("code=session_sync_busy reason=pending_limit path=relay records=32 pending=32"));
  });

  it("logs the backend failure reason on the failed stage line", () => {
    // CODEX-HISTORY-01：同一 session_sync_backend_failed 可来自不同后端原因，诊断日志需保留原因且保持单行。
    const h = harness();
    h.manager.request("a", "runtime", "cmd", request()); h.manager.tick();
    h.manager.handleEvent("runtime", { type: "command.result", commandId: h.dispatches[0]!.id, ok: false, error: "codex_native_history_unstable\nnext" });
    expect(h.error).toHaveBeenLastCalledWith("a", "cmd", "session_sync_backend_failed", "codex_native_history_unstable\nnext");
    expect(h.log).toHaveBeenCalledWith(expect.stringMatching(/stage=failed .* code=session_sync_backend_failed sinceProgressMs=0 error="codex_native_history_unstable next"$/u));
  });

  it("queue refusal and path loss return correlated errors and release budget", () => {
    const h = harness();
    h.manager.request("a", "runtime", "cmd", request()); h.manager.tick();
    h.reject();
    h.manager.handleEvent("runtime", snapshot(h.dispatches[0]!.command.syncId));
    expect(h.error).toHaveBeenLastCalledWith("a", "cmd", "session_sync_busy_or_unavailable", undefined);
    expect(h.log).toHaveBeenCalledWith(expect.stringContaining("stage=rejected device=a runtime=runtime command=cmd sync=sync range=preview attempt=1 reason=unknown path=relay"));
    expect(h.log).toHaveBeenCalledWith(expect.stringContaining("stage=failed device=a runtime=runtime command=cmd sync=sync range=preview attempt=1 code=session_sync_busy_or_unavailable"));
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
    for (let i = 0; i < 200; i += 1) {
      h.manager.request("a", "runtime", `c${i}`, request(`s${i}`));
      h.manager.tick();
      h.sends.at(-1)!.done(true);
    }
    expect(h.manager.stats("a")).toEqual({ records: 128, pending: 0, active: 0, reservedBytes: 0 });
    h.time(300_000); h.manager.tick();
    expect(h.manager.stats("a").records).toBe(0);
  });
});
