import { clawMessage } from "./openclaw-history.js";
import { expect, test, vi } from "vitest";
import { RuntimeWireEventSchema, type RuntimeEvent, type RuntimeMetadata } from "@orbis/protocol";
import { OpenClawBackend } from "./openclaw-backend.js";
import type { OpenClawGatewayEvents, OpenClawMethod } from "./openclaw-gateway.js";

const key = "agent:main:dashboard:existing";
const nativeId = "native-1";
const cwd = "/work/openclaw";
const message = (id: string, role: string, content: unknown, extra = {}) => ({ role, content, timestamp: 120,
  __openclaw: { id, ...extra } });
const row = { key, sessionId: nativeId, agentId: "main", workspaceDir: cwd, updatedAt: 120, archived: false };
const page = (messages: unknown[], fields = {}) => ({ sessionKey: key, sessionId: nativeId, messages, hasMore: false,
  sessionInfo: { hasActiveRun: false }, ...fields });

async function fixture(rpc: (method: OpenClawMethod, args: Record<string, unknown>) => unknown) {
  let connection!: OpenClawGatewayEvents;
  let ready = false;
  const events: RuntimeEvent[] = [], runtimes: RuntimeMetadata[] = [];
  const offline = vi.fn();
  const request = vi.fn(async (method: OpenClawMethod, params: object, options?: { onSent?: () => void }) => {
    options?.onSent?.();
    if (method === "sessions.subscribe" || method === "sessions.messages.subscribe") return { subscribed: true, key };
    if (method === "sessions.messages.unsubscribe") return { unsubscribed: true, key };
    return await rpc(method, params as Record<string, unknown>);
  });
  const backend = await OpenClawBackend.create({ url: "ws://127.0.0.1:18789" }, "/unused", "host-a", {
    ready: vi.fn(), catalog: vi.fn(), online: runtime => runtimes.push(runtime), offline,
    event: (_id, event) => { RuntimeWireEventSchema.parse(event); events.push(event); },
  }, async hooks => {
    connection = hooks;
    return { get ready() { return ready; }, start: () => { ready = true; hooks.online(); }, stop: async () => { ready = false; },
      request: request as unknown as import("./openclaw-backend.js").OpenClawConnection["request"] };
  });
  backend.start(); await vi.waitFor(() => expect(backend.isReady()).toBe(true));
  return { backend, request, runtimes, events, offline, connection, drop: () => { ready = false; connection.offline(); }, reconnect: () => { ready = true; connection.online(); } };
}

// HOST-RUNNING-01: recent, idle, or archived Gateway records must not light up Host.
test("reports native active runs without opening OpenClaw sessions", async () => {
  const f = await fixture((method, args) => method === "sessions.list" ? { hasMore: false, sessions: args.activeOnly ? [
    { ...row, workspaceDir: undefined, displayName: "Native run", activeRunIds: ["run-1"] },
    { ...row, sessionId: "idle", hasActiveRun: false }, { ...row, sessionId: "recent" },
    { ...row, sessionId: "archived", archived: true, hasActiveRun: true },
  ] : [] } : {});
  try {
    await expect(f.backend.readRunningSessions()).resolves.toEqual([{ sessionId: expect.stringMatching(/^openclaw:/u), name: "Native run" }]);
    expect(f.backend.directoryEntries()).toEqual([]);
    expect(f.runtimes).toEqual([]);
    expect(f.request.mock.calls.map(call => call[0])).toEqual(["sessions.subscribe", "sessions.list", "sessions.list"]);
  } finally { await f.backend.stop(); }
});

// OPENCLAW-02: overlap is identified by native occurrence, not equal text; only confirmed
// user rows retire the phone's optimistic message. Events from another session are ignored.
test("maps Gateway chat and older anchored pages to the common recoverable source", async () => {
  const latest = [message("one", "user", "same text"), message("two", "assistant", [{ type: "text", text: "answer" }, { type: "toolCall", arguments: { private: true } }])];
  let tail = [...latest];
  let runId: string | undefined;
  let busy = false;
  const f = await fixture((method, args) => {
    if (method === "sessions.list") return { sessions: args.archived === true ? [] : [row], hasMore: false };
    if (method === "chat.history") return args.cursor === "anchor-1"
      ? page([message("earliest", "user", "older"), message("older", "assistant", "old")])
      : page(tail, { hasMore: true, olderCursor: "anchor-1", sessionInfo: { hasActiveRun: busy } });
    if (method === "chat.send") { runId = String(args.idempotencyKey); busy = true; return { runId, status: "started" }; }
    if (method === "chat.abort") { return { ok: true, aborted: args.runId === runId }; }
    return {};
  });
  try {
    const [entry] = await f.backend.catalog(); expect(entry).toMatchObject({ agentKind: "openclaw", cwd });
    await f.backend.activate({ type: "resume", sessionId: entry!.sessionId });
    const { runtimeId, sessionId } = f.runtimes[0]!;
    const sync = (range: "history" | "preview", syncId: string, beforeEntryId?: string, targetLeafId?: string) => {
      expect(f.backend.dispatchCommand(runtimeId, syncId, { type: "session.sync", sessionId: sessionId!, syncId, range,
        ...(beforeEntryId ? { beforeEntryId } : {}), ...(targetLeafId ? { targetLeafId } : {}) })).toBe("handled");
      return vi.waitFor(() => {
        const snapshot = f.events.find(event => event.type === "session.snapshot" && event.syncId === syncId);
        expect(snapshot).toBeDefined();
        return snapshot as Extract<RuntimeEvent, { type: "session.snapshot" }>;
      });
    };
    const preview = await sync("preview", "first");
    expect(preview).toMatchObject({ range: "preview", hasOlder: true, source: { ready: true } });
    expect(preview.entries).toHaveLength(2);
    expect(JSON.stringify(preview)).not.toContain('"private"');
    const older = await sync("history", "older", preview.entries[0]!.entryId, preview.cursor.leafId!);
    expect(older.entries).toHaveLength(2);
    expect(older.entries.at(-1)?.entryId).toBe(preview.entries[0]?.parentId);
    expect(older.hasOlder).toBe(false);

    expect(f.backend.dispatchCommand(runtimeId, "send", { type: "user_message", messageId: "phone-message", text: "same text" })).toBe("handled");
    await vi.waitFor(() => expect(f.events).toContainEqual(expect.objectContaining({ type: "command.result", commandId: "send", status: "success" })));
    expect(f.request).toHaveBeenCalledWith("chat.send", expect.objectContaining({ sessionId: nativeId, deliver: false, message: "same text" }), expect.any(Object));
    const emit = (params: object) => f.connection.event({ event: "chat", payload: { sessionKey: key, agentId: "main", runId, ...params } });
    emit({ state: "delta", seq: 1, deltaText: "hel" });
    emit({ state: "delta", seq: 2, deltaText: "lo" });
    emit({ state: "delta", seq: 1, deltaText: "stale" });
    emit({ sessionKey: "agent:main:unrelated", state: "delta", seq: 3, deltaText: "unrelated" });
    await vi.waitFor(() => expect(JSON.stringify(f.events)).toContain('"hello"'));
    expect(JSON.stringify(f.events)).not.toMatch(/stale|unrelated/);
    expect(f.backend.dispatchCommand(runtimeId, "stop", { type: "stop" })).toBe("handled");
    await vi.waitFor(() => expect(f.events).toContainEqual(expect.objectContaining({ type: "command.result", commandId: "stop", status: "success" })));
    expect(f.request).toHaveBeenCalledWith("chat.abort", expect.objectContaining({ sessionId: nativeId, runId }), expect.any(Object));
    tail = [...latest, message("three", "user", "same text", { idempotencyKey: `${runId}:user` }), message("four", "assistant", "hello", { runId })];
    busy = false; emit({ state: "aborted", seq: 3 });
    await vi.waitFor(() => expect(JSON.stringify(f.events)).toContain('"clientMessageId":"phone-message"'));
    const final = await sync("preview", "final");
    const userIds = final.entries.flatMap(e => (e.data.message as { role?: string; clientMessageId?: string })?.role === "user"
      ? [(e.data.message as { clientMessageId?: string }).clientMessageId ?? null] : []);
    expect(userIds).toEqual([null, null, "phone-message"]);
    expect(final.live?.messages).toEqual([]);
    expect(final.live?.turn?.outcome).toBe("cancelled");
  } finally { await f.backend.stop(); }
});

// OPENCLAW-02: a lost acknowledgement is not a definitive failure and never replays a write.
// Session reset can reuse a native key, but cannot rebind the old Orbis identity.
test("does not replay an unconfirmed write or adopt a replaced native session", async () => {
  let reply = page([]);
  const f = await fixture((method, args) => {
    if (method === "sessions.list") return { sessions: args.archived ? [] : [row], hasMore: false };
    if (method === "chat.history") return reply;
    if (method === "chat.send") throw new Error("failed with synthetic secret");
    return {};
  });
  try {
    const [entry] = await f.backend.catalog(); await f.backend.activate({ type: "resume", sessionId: entry!.sessionId });
    const { runtimeId } = f.runtimes[0]!;
    f.backend.dispatchCommand(runtimeId, "one", { type: "user_message", text: "prompt" });
    await vi.waitFor(() => expect(f.events).toContainEqual(expect.objectContaining({ type: "command.result", commandId: "one", status: "unconfirmed" })));
    expect(JSON.stringify(f.events)).not.toContain("synthetic secret");
    reply = page([], { sessionId: "replacement" }); f.connection.gap();
    await vi.waitFor(() => expect(f.offline).toHaveBeenCalledWith(runtimeId, expect.stringContaining("replaced")));
    expect(f.backend.dispatchCommand(runtimeId, "two", { type: "user_message", text: "prompt" })).toBe("offline");
    expect(f.request.mock.calls.filter(([method]) => method === "chat.send")).toHaveLength(1);
  } finally { await f.backend.stop(); }
});

// OPENCLAW-02: a reset drops the old runtime, never the durable session ID; the
// resumed subscription can open history independently of the original socket.
test("rebinds the same native session after a Gateway reconnect", async () => {
  const f = await fixture((method, params) => {
    if (method === "sessions.list") return { sessions: params.archived ? [] : [row], hasMore: false };
    if (method === "chat.history") return page([message("one", "assistant", "recovered")]);
    throw new Error(`Unexpected ${method}`);
  });
  try {
    const [entry] = await f.backend.catalog();
    await f.backend.activate({ type: "resume", sessionId: entry!.sessionId });
    const first = f.runtimes[0]!;
    f.drop();
    expect(f.offline).toHaveBeenCalledWith(first.runtimeId, expect.stringContaining("disconnected"));
    expect(f.backend.directoryEntries()).toEqual([]);
    f.reconnect();
    await vi.waitFor(() => expect(f.runtimes).toHaveLength(2));
    expect(f.runtimes[1]?.sessionId).toBe(first.sessionId);
    expect(f.runtimes[1]?.runtimeId).not.toBe(first.runtimeId);
    expect(f.request.mock.calls.filter(([method]) => method === "sessions.messages.subscribe")).toHaveLength(2);
    expect(f.request.mock.calls.some(([method]) => method === "sessions.create" || method === "chat.send")).toBe(false);
  } finally { await f.backend.stop(); }
});

// MSG-RENDER-01: the shared history/live projection preserves media order without payloads.
test("keeps native OpenClaw image blocks in order without forwarding data", () => {
  expect(clawMessage({ role: "assistant", content: [{ type: "text", text: "Before" },
    { type: "image", mimeType: "image/png", data: "private-data" }, { type: "text", text: "After" }] }, "test")?.content).toEqual([
    { type: "text", text: "Before" }, { type: "render", renderKind: "image", text: "图片内容暂不可显示" }, { type: "text", text: "After" },
  ]);
});

// SHARED-VIEW-01/03: detach is a subscription operation; explicit resume gets a fresh baseline.
test("detaches only the OpenClaw view and reopens the exact native session", async () => {
  const f = await fixture((method, args) => {
    if (method === "sessions.list") return { sessions: args.archived ? [] : [row], hasMore: false };
    if (method === "chat.history") return page([], { sessionInfo: { hasActiveRun: false, activeRunIds: [] } });
    return {};
  });
  try {
    const [entry] = await f.backend.catalog(); await f.backend.activate({ type: "resume", sessionId: entry!.sessionId });
    const runtime = f.runtimes[0]!;
    const capabilities = [...f.events].reverse().find(event => event.type === "runtime.capabilities") as Extract<RuntimeEvent, { type: "runtime.capabilities" }>;
    const close = capabilities.capabilities.commands.find(command => command.name === "orbis-exit-view");
    expect(close?.closeGeneration).toBeTruthy();
    expect(f.backend.dispatchCommand(runtime.runtimeId, "close", { type: "session.close", sessionId: runtime.sessionId!, confirmed: true,
      closeGeneration: close!.closeGeneration })).toBe("handled");
    await vi.waitFor(() => expect(f.events).toContainEqual(expect.objectContaining({ type: "command.result", commandId: "close", ok: true })));
    expect(f.request).toHaveBeenCalledWith("sessions.messages.unsubscribe", expect.objectContaining({ key, subscriptionId: expect.any(String) }));
    expect(f.offline).toHaveBeenCalledWith(runtime.runtimeId, "view_closed");
    expect(f.backend.directoryEntries()).toEqual([]);
    await f.backend.activate({ type: "resume", sessionId: runtime.sessionId! });
    expect(f.runtimes).toHaveLength(2);
    expect(f.runtimes[1]?.sessionId).toBe(runtime.sessionId);
  } finally { await f.backend.stop(); }
});

// SHARED-VIEW-02: an exact active-run transition, not an old run, brings a hidden view back.
test("does not revive an OpenClaw view for the old run but adopts a new active run", async () => {
  const f = await fixture((method, args) => {
    if (method === "sessions.list") return { sessions: args.archived ? [] : [row], hasMore: false };
    if (method === "chat.history") return page([], { sessionInfo: { hasActiveRun: true, activeRunIds: ["run-old"] } });
    return {};
  });
  try {
    const [entry] = await f.backend.catalog(); await f.backend.activate({ type: "resume", sessionId: entry!.sessionId });
    const runtime = f.runtimes[0]!;
    const capabilities = [...f.events].reverse().find(event => event.type === "runtime.capabilities") as Extract<RuntimeEvent, { type: "runtime.capabilities" }>;
    const close = capabilities.capabilities.commands.find(command => command.name === "orbis-exit-view");
    f.backend.dispatchCommand(runtime.runtimeId, "close", { type: "session.close", sessionId: runtime.sessionId!, confirmed: true, closeGeneration: close!.closeGeneration });
    await vi.waitFor(() => expect(f.offline).toHaveBeenCalledWith(runtime.runtimeId, "view_closed"));
    const change = (activeRunIds: string[]) => f.connection.event({ event: "sessions.changed", payload: {
      sessionKey: key, sessionId: nativeId, agentId: "main", session: { ...row, activeRunIds, hasActiveRun: activeRunIds.length > 0 },
    } });
    change(["run-old"]);
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(f.runtimes).toHaveLength(1);
    change([]);
    change(["run-new"]);
    await vi.waitFor(() => expect(f.runtimes).toHaveLength(2));
    expect(f.runtimes[1]?.sessionId).toBe(runtime.sessionId);
  } finally { await f.backend.stop(); }
});
