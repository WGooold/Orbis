import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RuntimeEventSchema, type RuntimeEvent } from "@pi-remote/protocol";
import type { DshWebConnection } from "./dsh-web-client.js";
import { DshWebRuntime } from "./dsh-web-runtime.js";

const roots: string[] = [];
const runtimes: DshWebRuntime[] = [];
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function discoveryFixture() {
  let items: Record<string, unknown>[] = [];
  const subscriptions: { method: string; args: Record<string, unknown>; frame: (value: unknown) => void; fail?: ((error: Error) => void) | undefined; closed: boolean }[] = [];
  const request = vi.fn<(method: string, args?: unknown) => Promise<unknown>>(async method => {
    if (method === "session/list") return { items };
    if (method === "workspace/create") return { workspace: { workspaceId: "workspace" } };
    if (method === "session/page") return { records: [] };
    return {};
  });
  const client: DshWebConnection = {
    onEvent: undefined, onExit: undefined, onReconnect: undefined,
    request: request as DshWebConnection["request"],
    subscribe(method, args, frame, fail) {
      const subscription = { method, args, frame, fail, closed: false }; subscriptions.push(subscription);
      if (method === "workspace/follow") queueMicrotask(() => frame({ type: "baseline", value: { archivedSessionIds: ["archived"] } }));
      return () => { subscription.closed = true; };
    },
    respondEvent: vi.fn(async () => {}), stop: vi.fn(async () => {}),
  };
  const runtime = new DshWebRuntime(client); runtimes.push(runtime);
  const events: { event: RuntimeEvent; runtimeId: string }[] = [];
  runtime.setEventSink((event, runtimeId) => { RuntimeEventSchema.parse(event); events.push({ event: structuredClone(event), runtimeId }); });
  const offline = vi.fn(); runtime.onOffline = offline;
  const archives = vi.fn(); runtime.onArchiveChange = archives;
  const metadata = vi.fn(); runtime.onMetadataChange = metadata;
  const changed = vi.fn(); runtime.onCatalogChange = changed;
  const emit = (event: string, ...args: unknown[]) => client.onEvent?.({ type: "emit", event, args });
  const live = (id: string, running = false) => ({ sessionId: id, cwd: "D:/work", title: `Title ${id}`, updatedAt: 1000, agentAvailable: true, running });
  const follows = () => subscriptions.filter(item => item.method === "session/follow" && !item.closed);
  return { runtime, client, events, offline, archives, metadata, changed, emit, live, follows, subscriptions, request,
    list: (next: Record<string, unknown>[]) => { items = next; } };
}
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.stop();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("DeepSeek Web runtime adapter", () => {
  it("keeps recovery active until a valid current follow snapshot and isolates catalog recovery", async () => {
    const f = discoveryFixture(); f.list([f.live("browser", true)]);
    const base = f.request.getMockImplementation()!; let badSkills = true; let badModels = true;
    f.request.mockImplementation(async (method, args) => {
      if (method === "skills/list" && badSkills) throw new Error("skills unavailable");
      if (method === "session/modelCatalog" && badModels) throw new Error("models unavailable");
      return base(method, args);
    });
    await f.runtime.start();
    const codes = () => f.events.filter(({event}) => event.type === "notification.source").at(-1)!.event;
    await vi.waitFor(() => expect(codes()).toMatchObject({ notifications: expect.arrayContaining([
      expect.objectContaining({code: "dsh.skills"}), expect.objectContaining({code: "dsh.models"}),
    ]) }));
    const old = f.follows()[0]!; f.client.onReconnect?.();
    expect(codes()).toMatchObject({ notifications: expect.arrayContaining([expect.objectContaining({code: "dsh.recovery"})]) });
    const snapshot = { type: "snapshot", header: {createdAt: 1000, cwd: "D:/work"}, cursor: -1, records: [] };
    old.frame(snapshot);
    f.subscriptions.find(item => item.method === "workspace/follow")!.frame({ type: "baseline", value: {archivedSessionIds: []} });
    await vi.waitFor(() => expect(f.follows()).toHaveLength(1));
    f.follows()[0]!.frame({ type: "snapshot" });
    expect(codes()).toMatchObject({ notifications: expect.arrayContaining([expect.objectContaining({code: "dsh.recovery"})]) });
    f.follows()[0]!.frame(snapshot);
    expect(codes()).toMatchObject({ notifications: expect.not.arrayContaining([expect.objectContaining({code: "dsh.recovery"})]) });
    badSkills = false; f.runtime.syncNotifications("dsh:browser");
    await vi.waitFor(() => expect(codes()).toMatchObject({ notifications: [expect.objectContaining({code: "dsh.models"})] }));
    badModels = false; f.runtime.syncNotifications("dsh:browser");
    await vi.waitFor(() => expect(codes()).toMatchObject({ notifications: [] }));
  });
  it("only follows Agents that are working at startup and keeps cold, idle, archived, and child sessions in the catalog", async () => {
    const f = discoveryFixture();
    f.list([f.live("busy", true), f.live("idle"), { ...f.live("cold"), agentAvailable: false }, f.live("archived"), { ...f.live("child"), origin: "subagent" }]);
    await f.runtime.start();
    expect(f.runtime.directoryEntries()).toEqual([
      expect.objectContaining({ sessionId: "dsh:busy", status: "running", sessionName: "Title busy" }),
    ]);
    expect(f.follows()).toHaveLength(1);
    expect((await f.runtime.catalog()).map(item => item.sessionId)).toContain("dsh:idle");
    expect(f.request.mock.calls.some(([method]) => method === "session/create" || method === "workspace/create")).toBe(false);
    expect(f.metadata).toHaveBeenCalled();
  });

  it("follows a browser Agent once it starts working, shares both directions, and keeps it online after it finishes", async () => {
    const f = discoveryFixture(); await f.runtime.start();
    f.emit("api-session/added", f.live("browser"));
    f.emit("api-session/added", f.live("browser"));
    expect(f.follows()).toHaveLength(0);
    expect(f.runtime.ownsRuntime("dsh:browser")).toBe(false);
    f.emit("api-session/status", "browser", true);
    expect(f.follows()).toHaveLength(1);
    expect(f.runtime.directoryEntries()[0]?.status).toBe("running");
    const follow = f.follows()[0]!;
    follow.frame({ type: "event", event: { seq: 0, time: 1000, type: "user/message", data: { role: "user", source: { kind: "user", rpcId: "web-1" }, content: [{ type: "text", text: "from browser" }] } } });
    expect(f.events).toContainEqual(expect.objectContaining({ runtimeId: "dsh:browser", event: expect.objectContaining({ type: "session.patch", entries: [expect.objectContaining({ data: { message: expect.objectContaining({ content: [{ type: "text", text: "from browser" }] }) } })], live: expect.objectContaining({ messages: [] }) }) }));
    expect(f.runtime.dispatchCommand("dsh:browser", "mobile-1", { type: "user_message", text: "from phone", messageId: "mobile-1" })).toBe("handled");
    await vi.waitFor(() => expect(f.request).toHaveBeenCalledWith("session/prompt", { request: expect.objectContaining({ sessionId: "browser", content: [{ type: "text", text: "from phone" }] }) }));
    f.emit("api-session/status", "browser", false);
    expect(f.runtime.directoryEntries()[0]?.status).toBe("idle");
    f.emit("api-session/removed", "browser");
    expect(f.runtime.directoryEntries()).toEqual([]);
    expect(f.offline).toHaveBeenCalledWith(expect.any(String), [expect.objectContaining({ runtimeId: "dsh:browser" })]);
    const count = f.events.length;
    follow.frame({ type: "event", event: { seq: 1, time: 1001, type: "turn/start", data: { turn: 1 } } });
    expect(f.events).toHaveLength(count);
  });

  it("reconciles missed additions and removals when the Web connection reconnects", async () => {
    const f = discoveryFixture(); f.list([f.live("old", true)]); await f.runtime.start();
    f.list([f.live("new", true), { ...f.live("old"), agentAvailable: false }]);
    f.client.onReconnect?.();
    f.subscriptions[0]!.frame({ type: "baseline", value: { archivedSessionIds: [] } });
    await vi.waitFor(() => expect(f.runtime.directoryEntries().map(item => item.sessionId)).toEqual(["dsh:new"]));
    expect(f.follows()).toHaveLength(1);
    expect(f.offline).toHaveBeenCalled();
  });

  it("does not let an older list response undo notifications received during that request", async () => {
    const f = discoveryFixture(); f.list([f.live("old")]); await f.runtime.start();
    const pending = deferred<unknown>();
    f.request.mockImplementationOnce(() => pending.promise);
    f.client.onReconnect?.();
    f.subscriptions[0]!.frame({ type: "baseline", value: { archivedSessionIds: [] } });
    expect(f.follows()).toHaveLength(0);
    f.emit("api-session/removed", "old");
    f.emit("api-session/added", f.live("new", true));
    pending.resolve({ items: [f.live("old")] });
    await vi.waitFor(() => expect(f.changed).toHaveBeenCalledTimes(4));
    expect(f.runtime.directoryEntries().map(item => item.sessionId)).toEqual(["dsh:new"]);
    expect(f.follows()).toHaveLength(1);
  });

  it("waits for the fresh archive baseline before following Agents after reconnect", async () => {
    const f = discoveryFixture(); f.list([f.live("browser", true)]); await f.runtime.start();
    f.client.onReconnect?.();
    await vi.waitFor(() => expect(f.changed).toHaveBeenCalledTimes(2));
    expect(f.follows()).toHaveLength(0);
    f.subscriptions[0]!.frame({ type: "baseline", value: { archivedSessionIds: ["browser"] } });
    expect(f.follows()).toHaveLength(0);
    expect(f.runtime.ownsRuntime("dsh:browser")).toBe(false);
  });

  it("retries a failed follow only after rechecking that its native Agent is still live", async () => {
    const f = discoveryFixture(); f.list([f.live("browser", true)]); await f.runtime.start();
    vi.useFakeTimers();
    try {
      f.follows()[0]!.fail!(new Error("follow interrupted"));
      expect(f.follows()).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(f.follows()).toHaveLength(1);
      f.follows()[0]!.fail!(new Error("follow ended"));
      f.list([{ ...f.live("browser"), agentAvailable: false }]);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(f.follows()).toHaveLength(0);
      expect(f.runtime.ownsRuntime("dsh:browser")).toBe(false);
    } finally { vi.useRealTimers(); }
  });

  it("mirrors browser archive changes and keeps a quit Agent detached until it works again or the APP reopens it", async () => {
    const f = discoveryFixture(); f.list([f.live("browser", true)]); await f.runtime.start();
    const workspace = f.subscriptions.find(item => item.method === "workspace/follow")!;
    workspace.frame({ type: "archived", archivedSessionIds: ["browser"] });
    expect(f.runtime.directoryEntries()).toEqual([]);
    expect(f.archives).toHaveBeenCalledWith("dsh:browser", true);
    workspace.frame({ type: "archived", archivedSessionIds: [] });
    expect(f.runtime.ownsRuntime("dsh:browser")).toBe(true);
    f.runtime.dispatchCommand("dsh:browser", "quit", { type: "slash.execute", name: "quit", args: "" });
    await vi.waitFor(() => expect(f.runtime.ownsRuntime("dsh:browser")).toBe(false));
    // The work this Agent already had running is not new activity, so it stays detached.
    f.emit("api-session/added", f.live("browser", true));
    f.emit("api-session/status", "browser", true);
    f.client.onReconnect?.();
    workspace.frame({ type: "baseline", value: { archivedSessionIds: [] } });
    await vi.waitFor(() => expect(f.request.mock.calls.filter(([method]) => method === "session/list")).toHaveLength(2));
    expect(f.runtime.ownsRuntime("dsh:browser")).toBe(false);
    workspace.frame({ type: "archived", archivedSessionIds: ["browser"] });
    workspace.frame({ type: "archived", archivedSessionIds: [] });
    expect(f.runtime.ownsRuntime("dsh:browser")).toBe(false);
    // New browser work revives it without an APP action, and an explicit APP reopen always works.
    f.emit("api-session/status", "browser", false);
    f.emit("api-session/status", "browser", true);
    expect(f.runtime.ownsRuntime("dsh:browser")).toBe(true);
    f.runtime.dispatchCommand("dsh:browser", "quit", { type: "slash.execute", name: "quit", args: "" });
    await vi.waitFor(() => expect(f.runtime.ownsRuntime("dsh:browser")).toBe(false));
    await f.runtime.activate({ type: "resume", sessionId: "dsh:browser" });
    expect(f.follows()).toHaveLength(1);
    expect(f.request.mock.calls.some(([method]) => method === "workspace/archiveSession")).toBe(false);
  });

  it("reuses the browser-discovered subscription when an APP activation races its creation event", async () => {
    const f = discoveryFixture(); await f.runtime.start();
    f.list([f.live("browser")]);
    const request = f.request.getMockImplementation()!;
    f.request.mockImplementation(async (method, args) => {
      if (method === "session/create") f.emit("api-session/added", f.live("browser"));
      return request(method, args);
    });
    await f.runtime.activate({ type: "resume", sessionId: "dsh:browser" });
    expect(f.follows()).toHaveLength(1);
    expect(f.subscriptions.filter(item => item.method === "session/follow")).toHaveLength(1);
  });

  it("ignores late discovery results and notifications after stop", async () => {
    const f = discoveryFixture();
    const pending = deferred<unknown>();
    f.request.mockImplementationOnce(() => pending.promise);
    const start = f.runtime.start();
    await vi.waitFor(() => expect(f.request).toHaveBeenCalledWith("session/list", expect.anything()));
    await f.runtime.stop();
    pending.resolve({ items: [f.live("late")] }); await start;
    f.emit("api-session/added", f.live("later"));
    expect(f.runtime.directoryEntries()).toEqual([]);
    expect(f.follows()).toEqual([]);
    expect(f.subscriptions.every(item => item.closed)).toBe(true);
  });

  it("restores an in-progress browser reply and replays it when the APP opens the discovered session", async () => {
    const f = discoveryFixture(); f.list([f.live("browser", true)]); await f.runtime.start();
    const follow = f.follows()[0]!;
    follow.frame({ type: "snapshot", header: { createdAt: 1000, cwd: "D:/work" }, cursor: 0,
      records: [{ type: "event", event: { seq: 0, time: 1000, type: "turn/start", data: { turn: 1 } } }],
      assistantStream: { revision: 2, activeAttempt: { attemptId: "attempt-1", turn: 1, step: 1, nextIndex: 1, startedAfterSeq: 0,
        stream: [{ time: 1001, chunk: { type: "text-delta", text: "already sent " } }] } } });
    follow.frame({ type: "assistant-stream", frame: { type: "chunk", attemptId: "attempt-1", index: 1, chunk: { type: "text-delta", text: "and still streaming" } } });
    f.events.length = 0;
    f.runtime.dispatchCommand("dsh:browser", "sync", { type: "session.sync", sessionId: "dsh:browser", syncId: "sync", range: "preview" });
    await vi.waitFor(() => expect(f.events.some(({ event }) => event.type === "session.snapshot")).toBe(true));
    const restored = f.events.find(({ event }) => event.type === "session.snapshot")?.event;
    expect(restored).toMatchObject({ live: { messages: [expect.objectContaining({ message: expect.objectContaining({ messageId: "attempt-1", content: [{ type: "text", text: "already sent " }, { type: "text", text: "and still streaming" }] }) })] } });
    follow.frame({ type: "assistant-stream", frame: { type: "end", attemptId: "attempt-1", outcome: { kind: "committed", seq: 1 } } });
    // An ended but uncommitted attempt stays recoverable until its canonical record arrives.
    expect(f.events.filter(({ event }) => event.type === "session.patch").at(-1)?.event).toMatchObject({ live: { messages: [expect.objectContaining({ finished: true })] } });
    follow.frame({ type: "event", event: { seq: 1, time: 1090, type: "assistant/message", data: { message: { id: "native-1", content: [{ type: "text", text: "already sent and still streaming" }] } } } });
    const commit = f.events.filter(({ event }) => event.type === "session.patch").at(-1)?.event;
    expect(commit).toMatchObject({ entries: [expect.objectContaining({ entryId: "dsh:browser:web:1" })], live: { messages: [] } });
    follow.frame({ type: "event", event: { seq: 2, time: 1100, type: "turn/end", data: { turn: 1 } } });
    expect(f.events.filter(({ event }) => event.type === "session.patch").at(-1)?.event).toMatchObject({ live: { turn: null, messages: [] } });
  });

  it("repairs silently missed native completion on a periodic check and rejects the replaced follow's late frames", async () => {
    const f = discoveryFixture(); f.list([f.live("browser", true)]); await f.runtime.start();
    const opening = f.follows()[0]!;
    const record = (seq: number, type: string, data: unknown) => ({ event: { seq, time: 1000 + seq, type, data } });
    opening.frame({ type: "snapshot", header: { createdAt: 1000, cwd: "D:/work" }, cursor: 0, records: [record(0, "turn/start", { turn: 1 })],
      assistantStream: { activeAttempt: { attemptId: "attempt", stream: [{ time: 1001, chunk: { type: "text-delta", text: "partial" } }] } } });
    const original = f.events.filter(({ event }) => event.type === "session.patch").at(-1)!.event;
    if (original.type !== "session.patch") throw new Error("missing baseline");
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 16_000);
    try {
      f.runtime.dispatchCommand("dsh:browser", "check", { type: "session.sync", sessionId: "dsh:browser", syncId: "check", range: "preview",
        knownState: { epoch: original.source.epoch, seq: original.seq, head: original.head } });
      const fresh = f.follows()[0]!;
      expect(fresh).not.toBe(opening);
      // The native source contains completion, but its previous notifications never reached adapter.
      fresh.frame({ type: "snapshot", header: { createdAt: 1000, cwd: "D:/work" }, cursor: 2, records: [record(0, "turn/start", { turn: 1 }),
        record(1, "assistant/message", { message: { id: "native", content: [{ type: "text", text: "complete" }] } }),
        record(2, "turn/end", { turn: 1 })], assistantStream: { revision: 3 } });
      await vi.waitFor(() => expect(f.events.some(({ event }) => event.type === "session.snapshot" && event.syncId === "check")).toBe(true));
      const repaired = f.events.find(({ event }) => event.type === "session.snapshot" && event.syncId === "check")!.event;
      expect(repaired).toMatchObject({ source: { ready: true }, live: { complete: true, turn: null, messages: [] } });
      if (repaired.type !== "session.snapshot") throw new Error("missing repair");
      expect(repaired.entries.some(entry => entry.entryId === "dsh:browser:web:1")).toBe(true);
      const count = f.events.length;
      opening.frame({ type: "assistant-stream", frame: { type: "chunk", attemptId: "attempt", chunk: { type: "text-delta", text: "late" } } });
      expect(f.events).toHaveLength(count);
      clock.mockReturnValue(Date.now() + 16_000);
      f.runtime.dispatchCommand("dsh:browser", "same", { type: "session.sync", sessionId: "dsh:browser", syncId: "same", range: "preview",
        knownState: { epoch: repaired.source!.epoch, seq: repaired.source!.seq, head: repaired.checkpoint!.head } });
      f.follows()[0]!.frame({ type: "snapshot", header: { createdAt: 1000, cwd: "D:/work" }, cursor: 2, records: [record(0, "turn/start", { turn: 1 }),
        record(1, "assistant/message", { message: { id: "native", content: [{ type: "text", text: "complete" }] } }),
        record(2, "turn/end", { turn: 1 })], assistantStream: { revision: 3 } });
      await vi.waitFor(() => expect(f.events.some(({ event }) => event.type === "session.snapshot" && event.syncId === "same" && event.selection === "unchanged")).toBe(true));
    } finally { clock.mockRestore(); }
  });

  it("returns a verified bounded native tail without claiming its missing ancestors are cached", async () => {
    const f = discoveryFixture(); f.list([f.live("browser", true)]); await f.runtime.start();
    const record = (seq: number, type = "custom") => ({ event: { seq, time: 1000 + seq, type, data: {} } });
    f.follows()[0]!.frame({ type: "snapshot", header: { createdAt: 1000 }, cursor: 12,
      records: [record(10), record(11), record(12, "turn/end")], assistantStream: { revision: 0 } });
    f.runtime.dispatchCommand("dsh:browser", "tail", { type: "session.sync", sessionId: "dsh:browser", syncId: "tail", range: "preview" });
    await vi.waitFor(() => expect(f.events.some(({ event }) => event.type === "session.snapshot" && event.syncId === "tail")).toBe(true));
    const tail = f.events.find(({ event }) => event.type === "session.snapshot" && event.syncId === "tail")!.event;
    expect(tail).toMatchObject({ entries: [expect.objectContaining({ entryId: "dsh:browser:web:10", parentId: "dsh:browser:web:9" }), expect.anything(), expect.anything()], hasOlder: true, complete: false, live: { complete: true } });
    f.request.mockImplementation(async method => method === "session/page" ? { records: Array.from({ length: 10 }, (_, seq) => record(seq)) } : {});
    f.runtime.dispatchCommand("dsh:browser", "history", { type: "session.sync", sessionId: "dsh:browser", syncId: "history", range: "history", beforeEntryId: "dsh:browser:web:10" });
    await vi.waitFor(() => expect(f.events.some(({ event }) => event.type === "session.snapshot" && event.syncId === "history")).toBe(true));
    const history = f.events.find(({ event }) => event.type === "session.snapshot" && event.syncId === "history")!.event;
    expect(history).toMatchObject({ complete: true, hasOlder: false });
    if (history.type !== "session.snapshot") throw new Error("missing history");
    expect(history.live).toBeUndefined();
    expect(history.checkpoint).toBeUndefined();
    expect(history.entries).toHaveLength(10);
  });

  it("reads the native archive set and blocks switching during browser-only work", async () => {
    const request = vi.fn(async (method: string) => method === "session/list" ? { items: [
      { sessionId: "saved", cwd: "D:/work", updatedAt: 10, running: false },
      { sessionId: "browser", cwd: "D:/work", updatedAt: 20, running: true },
    ] } : {});
    const client: DshWebConnection = {
      onEvent: undefined, onExit: undefined, onReconnect: undefined,
      request: request as unknown as DshWebConnection["request"],
      subscribe: (_method, _args, onFrame) => { queueMicrotask(() => onFrame({ type: "baseline", value: { archivedSessionIds: ["saved"] } })); return () => {}; },
      respondEvent: vi.fn(async () => {}), stop: vi.fn(async () => {}),
    };
    const runtime = new DshWebRuntime(client); runtimes.push(runtime);
    expect((await runtime.catalog()).map(item => item.sessionId)).toEqual(["dsh:browser"]);
    expect((await runtime.catalog(true)).map(item => item.sessionId)).toEqual(["dsh:saved"]);
    await expect(runtime.assertProviderSwitchReady()).rejects.toThrow("浏览器会话正在工作");
  });

  it("puts app-created sessions in the matching Web workspace and keeps quit separate from archive", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "orbis-dsh-web-workspace-")); roots.push(cwd);
    let follow: ((frame: unknown) => void) | undefined;
    const request = vi.fn(async (method: string) => {
      if (method === "workspace/create") return { workspace: { workspaceId: "workspace-app", path: cwd } };
      if (method === "session/create") return { sessionId: "web-workspace" };
      return {};
    });
    const client: DshWebConnection = {
      onEvent: undefined, onExit: undefined, onReconnect: undefined,
      request: request as unknown as DshWebConnection["request"],
      subscribe: vi.fn((_method, _args, onFrame) => { follow = onFrame; return () => { follow = undefined; }; }),
      respondEvent: vi.fn(async () => {}), stop: vi.fn(async () => {}),
    };
    const runtime = new DshWebRuntime(client); runtimes.push(runtime);
    const events: RuntimeEvent[] = [];
    runtime.setEventSink(event => { RuntimeEventSchema.parse(event); events.push(event); });
    await runtime.activate({ type: "new", cwd });
    expect(request).toHaveBeenCalledWith("workspace/create", { request: { path: cwd } });
    expect(request).toHaveBeenCalledWith("session/create", { request: { workspaceId: "workspace-app" } });
    follow!({ type: "snapshot", header: { createdAt: 1000, cwd }, cursor: -1, records: [], hasMore: false, projections: { asOfSeq: -1, values: {} }, assistantStream: { revision: 0 } });

    runtime.dispatchCommand("dsh:web-workspace", "quit", { type: "slash.execute", name: "quit", args: "" });
    await vi.waitFor(() => expect(events.some(event => event.type === "command.result" && event.commandId === "quit" && event.ok)).toBe(true));
    expect(request.mock.calls.some(([method]) => method === "workspace/archiveSession")).toBe(false);
    expect(runtime.ownsRuntime("dsh:web-workspace")).toBe(false);
  });

  it("archives an active Web runtime only through the sidebar archive operation", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "orbis-dsh-web-archive-")); roots.push(cwd);
    const request = vi.fn(async (method: string) => method === "workspace/create"
      ? { workspace: { workspaceId: "workspace-archive", path: cwd } }
      : method === "session/create" ? { sessionId: "web-archive" } : {});
    const client: DshWebConnection = {
      onEvent: undefined, onExit: undefined, onReconnect: undefined,
      request: request as unknown as DshWebConnection["request"],
      subscribe: vi.fn(() => () => {}), respondEvent: vi.fn(async () => {}), stop: vi.fn(async () => {}),
    };
    const runtime = new DshWebRuntime(client); runtimes.push(runtime);
    await runtime.activate({ type: "new", cwd });
    await runtime.setArchived("dsh:web-archive", true);
    expect(request).toHaveBeenCalledWith("workspace/archiveSession", { request: { sessionId: "web-archive" } });
    expect(runtime.ownsRuntime("dsh:web-archive")).toBe(false);
  });
  it("maps the shared Web session stream to Pi-shaped turns, tools, queue delivery, and IDs", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "orbis-dsh-web-runtime-")); roots.push(cwd);
    let follow: ((frame: unknown) => void) | undefined;
    const requestMock = vi.fn(async (method: string) => method === "workspace/create" ? { workspace: { workspaceId: "workspace-1" } } : method === "session/create" ? { sessionId: "web-1" } : method === "skills/list" ? { skills: [] } : {});
    const request = requestMock as unknown as DshWebConnection["request"];
    const client: DshWebConnection = {
      onEvent: undefined, onExit: undefined, onReconnect: undefined,
      request,
      subscribe: vi.fn((_method, _args, onFrame) => { follow = onFrame; return () => { follow = undefined; }; }),
      respondEvent: vi.fn(async () => {}), stop: vi.fn(async () => {}),
    };
    const runtime = new DshWebRuntime(client); runtimes.push(runtime);
    const events: RuntimeEvent[] = [];
    runtime.setEventSink((event) => { RuntimeEventSchema.parse(event); events.push(event); });
    await runtime.activate({ type: "new", cwd });
    follow!({ type: "snapshot", header: { createdAt: 1000, cwd }, cursor: -1, records: [], hasMore: false, projections: { asOfSeq: -1, values: {} }, assistantStream: { revision: 0 } });
    await vi.waitFor(() => expect(request).toHaveBeenCalledWith("skills/list", expect.anything()));
    expect(runtime.dispatchCommand("dsh:web-1", "send", { type: "user_message", messageId: "mobile-1", text: "hello", delivery: "followUp" })).toBe("handled");
    await vi.waitFor(() => expect(events.some(event => event.type === "message.queued" && event.state === "accepted")).toBe(true));
    const event = (seq: number, type: string, data: unknown, time = 1100) => follow!({ type: "event", event: { seq, type, time, data } });
    event(0, "turn/start", { turn: 1 });
    event(1, "user/message", { id: "u1", role: "user", source: { kind: "user", rpcId: "mobile-1" }, content: [{ type: "text", text: "hello" }] });
    event(2, "tool/call", { turn: 1, step: 1, callId: "call-1", name: "bash", arguments: '{"command":"echo ok"}' });
    event(3, "tool/result", { turn: 1, step: 1, message: { id: "tool-1", role: "tool", source: { kind: "tool", callId: "call-1" }, toolCallId: "call-1", content: [{ type: "text", text: "ok" }] } });
    event(4, "assistant/message", { turn: 1, step: 1, message: { id: "a1", role: "assistant", source: { kind: "model", provider: "p", model: "m" }, content: [{ type: "text", text: "done" }] }, stream: [] });
    event(5, "turn/end", { turn: 1, reason: { kind: "completed" } }, 1200);
    const final = events.filter(item => item.type === "session.patch").at(-1);
    expect(final).toMatchObject({ live: { turn: null, messages: [], tools: [] }, head: { leafId: "dsh:web-1:web:5" } });
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "session.patch", live: expect.objectContaining({ tools: [expect.objectContaining({ toolCallId: "call-1", toolName: "bash", state: "started" })] }) }),
      expect.objectContaining({ type: "message.queued", queueId: "mobile-1", state: "delivered" }),
    ]));
    const committed = events.flatMap(item => item.type === "session.patch" ? item.entries ?? [] : []);
    expect(committed.find(entry => entry.entryId === "dsh:web-1:web:3")?.data.message).toMatchObject({ toolCallId: "call-1", isError: false });
    expect(request).toHaveBeenCalledWith("session/prompt", expect.objectContaining({ request: expect.objectContaining({ requestId: "mobile-1", mode: "queue" }) }));
  });

  it("rejects a reused message ID whose payload changed", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "orbis-dsh-web-runtime-")); roots.push(cwd);
    let follow: ((frame: unknown) => void) | undefined;
    const requestMock = vi.fn(async (method: string) => method === "workspace/create" ? { workspace: { workspaceId: "workspace-2" } } : method === "session/create" ? { sessionId: "web-2" } : {});
    const request = requestMock as unknown as DshWebConnection["request"];
    const client: DshWebConnection = {
      onEvent: undefined, onExit: undefined, onReconnect: undefined,
      request,
      subscribe: vi.fn((_method, _args, onFrame) => { follow = onFrame; return () => {}; }),
      respondEvent: vi.fn(async () => {}), stop: vi.fn(async () => {}),
    };
    const runtime = new DshWebRuntime(client); runtimes.push(runtime);
    const events: RuntimeEvent[] = [];
    runtime.setEventSink(event => events.push(event));
    await runtime.activate({ type: "new", cwd });
    follow!({ type: "snapshot", header: { createdAt: 1000, cwd }, cursor: -1, records: [], hasMore: false, projections: { asOfSeq: -1, values: {} }, assistantStream: { revision: 0 } });
    runtime.dispatchCommand("dsh:web-2", "first", { type: "user_message", messageId: "same", text: "one" });
    await vi.waitFor(() => expect(events.some(event => event.type === "command.result" && event.commandId === "first" && event.status === "success")).toBe(true));
    runtime.dispatchCommand("dsh:web-2", "second", { type: "user_message", messageId: "same", text: "two" });
    await vi.waitFor(() => expect(events.some(event => event.type === "command.result" && event.commandId === "second" && event.status === "message_id_conflict")).toBe(true));
    expect(requestMock.mock.calls.filter(call => call[0] === "session/prompt")).toHaveLength(1);
  });

  it("retains the durable prefix when follow reopens after a reconnect", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "orbis-dsh-web-runtime-")); roots.push(cwd);
    let follow: ((frame: unknown) => void) | undefined;
    const requestMock = vi.fn(async (method: string) => method === "workspace/create" ? { workspace: { workspaceId: "workspace-reconnect" } } : method === "session/create"
      ? { sessionId: "web-reconnect" }
      : method === "session/page" ? { records: [] } : {});
    const client: DshWebConnection = {
      onEvent: undefined, onExit: undefined, onReconnect: undefined,
      request: requestMock as unknown as DshWebConnection["request"],
      subscribe: vi.fn((_method, _args, onFrame) => { follow = onFrame; return () => {}; }),
      respondEvent: vi.fn(async () => {}), stop: vi.fn(async () => {}),
    };
    const runtime = new DshWebRuntime(client); runtimes.push(runtime);
    const events: RuntimeEvent[] = [];
    runtime.setEventSink(event => events.push(event));
    await runtime.activate({ type: "new", cwd });
    const record = (seq: number, type: string, data: unknown) => ({ type: "event", event: { seq, time: 1_000 + seq, type, data } });
    follow!({ type: "snapshot", header: { createdAt: 1_000, cwd }, cursor: 0, records: [record(0, "turn/start", { turn: 1 })], hasMore: false, projections: { asOfSeq: 0, values: {} }, assistantStream: { revision: 0 } });
    follow!(record(1, "user/message", { id: "u1", source: { kind: "user" }, content: [{ type: "text", text: "hello" }] }));
    // A reconnect opening is only a bounded tail. The old seq 0 must survive it.
    follow!({ type: "snapshot", header: { createdAt: 1_000, cwd }, cursor: 2, records: [record(1, "user/message", { id: "u1", source: { kind: "user" }, content: [{ type: "text", text: "hello" }] }), record(2, "turn/end", { turn: 1, reason: { kind: "completed" } })], hasMore: false, projections: { asOfSeq: 2, values: {} }, assistantStream: { revision: 0 } });
    runtime.dispatchCommand("dsh:web-reconnect", "sync", { type: "session.sync", sessionId: "dsh:web-reconnect", syncId: "sync", range: "preview" });
    await vi.waitFor(() => expect(events.some(event => event.type === "session.snapshot" && event.syncId === "sync")).toBe(true));
    const snapshot = [...events].reverse().find(event => event.type === "session.snapshot");
    expect(snapshot?.type === "session.snapshot" ? snapshot.entries.map(entry => entry.entryId) : []).toEqual([
      "dsh:web-reconnect:web:0", "dsh:web-reconnect:web:1", "dsh:web-reconnect:web:2",
    ]);
  });

  it("uses the empty-session cursor when syncing a new session", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "orbis-dsh-web-runtime-")); roots.push(cwd);
    let follow: ((frame: unknown) => void) | undefined;
    const requestMock = vi.fn(async (method: string) => method === "workspace/create" ? { workspace: { workspaceId: "workspace-empty" } } : method === "session/create"
      ? { sessionId: "web-empty" }
      : method === "session/page" ? { records: [] } : {});
    const client: DshWebConnection = {
      onEvent: undefined, onExit: undefined, onReconnect: undefined,
      request: requestMock as unknown as DshWebConnection["request"],
      subscribe: vi.fn((_method, _args, onFrame) => { follow = onFrame; return () => {}; }),
      respondEvent: vi.fn(async () => {}), stop: vi.fn(async () => {}),
    };
    const runtime = new DshWebRuntime(client); runtimes.push(runtime);
    const events: RuntimeEvent[] = [];
    runtime.setEventSink(event => events.push(event));
    await runtime.activate({ type: "new", cwd });
    follow!({ type: "snapshot", header: { createdAt: 1_000, cwd }, cursor: -1, records: [], hasMore: false, projections: { asOfSeq: -1, values: {} }, assistantStream: { revision: 0 } });
    runtime.dispatchCommand("dsh:web-empty", "sync", { type: "session.sync", sessionId: "dsh:web-empty", syncId: "sync", range: "preview" });
    await vi.waitFor(() => expect(events.some(event => event.type === "session.snapshot" && event.syncId === "sync")).toBe(true));
    expect(requestMock).toHaveBeenCalledWith("session/page", { request: expect.objectContaining({ throughSeq: -1 }) });
  });

  it("deduplicates a replayed approval after the Web carrier reconnects", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "orbis-dsh-web-runtime-")); roots.push(cwd);
    const requestMock = vi.fn(async (method: string) => method === "workspace/create" ? { workspace: { workspaceId: "workspace-approval" } } : method === "session/create" ? { sessionId: "web-approval" } : {});
    const client: DshWebConnection = {
      onEvent: undefined, onExit: undefined, onReconnect: undefined,
      request: requestMock as unknown as DshWebConnection["request"],
      subscribe: vi.fn(() => () => {}),
      respondEvent: vi.fn(async () => {}), stop: vi.fn(async () => {}),
    };
    const runtime = new DshWebRuntime(client); runtimes.push(runtime);
    const events: RuntimeEvent[] = [];
    runtime.setEventSink(event => events.push(event));
    await runtime.activate({ type: "new", cwd });
    const waterfall = { type: "waterfall" as const, event: "approval/request", eventId: "approval-1", agentId: "web-approval", request: {} };
    client.onEvent?.(waterfall);
    client.onEvent?.(waterfall);
    expect(events.filter(event => event.type === "interaction.requested")).toHaveLength(1);
    runtime.dispatchCommand("dsh:web-approval", "answer", {
      type: "interaction.respond", requestId: "approval-1", extensionId: "dsh", response: { kind: "select", value: "allowed-once" },
    });
    await vi.waitFor(() => expect(client.respondEvent).toHaveBeenCalledOnce());
  });
});
