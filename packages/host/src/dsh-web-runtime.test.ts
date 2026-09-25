import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RuntimeEventSchema, type RuntimeEvent } from "@pi-remote/protocol";
import type { DshWebConnection } from "./dsh-web-client.js";
import { DshWebRuntime } from "./dsh-web-runtime.js";

const roots: string[] = [];
const runtimes: DshWebRuntime[] = [];
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.stop();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("DeepSeek Web runtime adapter", () => {
  it("maps the shared Web session stream to Pi-shaped turns, tools, queue delivery, and IDs", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "orbis-dsh-web-runtime-")); roots.push(cwd);
    let follow: ((frame: unknown) => void) | undefined;
    const requestMock = vi.fn(async (method: string) => method === "session/create" ? { sessionId: "web-1" } : method === "skills/list" ? { skills: [] } : {});
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
    await vi.waitFor(() => expect(events.some(item => item.type === "turn.finished")).toBe(true));
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "tool.started", toolCallId: "call-1", toolName: "bash" }),
      expect.objectContaining({ type: "tool.finished", toolCallId: "call-1", toolName: "bash", isError: false }),
      expect.objectContaining({ type: "message.queued", queueId: "mobile-1", state: "delivered" }),
      expect.objectContaining({
        type: "turn.finished",
        persistedMessages: expect.arrayContaining([{ messageId: "mobile-1", entryId: "dsh:web-1:web:1" }]),
        durationMs: 100,
      }),
    ]));
    expect(request).toHaveBeenCalledWith("session/prompt", expect.objectContaining({ request: expect.objectContaining({ requestId: "mobile-1", mode: "queue" }) }));
  });

  it("rejects a reused message ID whose payload changed", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "orbis-dsh-web-runtime-")); roots.push(cwd);
    let follow: ((frame: unknown) => void) | undefined;
    const requestMock = vi.fn(async (method: string) => method === "session/create" ? { sessionId: "web-2" } : {});
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
    const requestMock = vi.fn(async (method: string) => method === "session/create"
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
    const requestMock = vi.fn(async (method: string) => method === "session/create"
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
    const requestMock = vi.fn(async (method: string) => method === "session/create" ? { sessionId: "web-approval" } : {});
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
