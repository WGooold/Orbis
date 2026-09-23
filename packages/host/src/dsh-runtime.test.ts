import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentKindSchema, RuntimeEventSchema, type RuntimeCommand, type RuntimeEvent } from "@pi-remote/protocol";
import { DshRuntime } from "./dsh-runtime.js";
import { dshEntries, type DshHistory, type DshLog } from "./dsh-history.js";
import type { DshConnection, JsonObject } from "./dsh-client.js";

const roots: string[] = [];
const runtimes: DshRuntime[] = [];
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.stop();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture() {
  const cwd = await mkdtemp(join(tmpdir(), "orbis-dsh-")); roots.push(cwd);
  const log: DshLog = { header: { id: "one", cwd, createdAt: 1000 }, events: [] };
  let next = 0;
  const options = [{ id: "model", name: "Model", type: "select", currentValue: "opaque-model",
    options: [{ group: "p", name: "Provider", options: [{ value: "opaque-model", name: "Test model" }, { value: "next-model", name: "Next model" }] }] }];
  const client: DshConnection = {
    onNotification: undefined, onRequest: undefined, onExit: undefined,
    request: vi.fn(async (method: string, params: JsonObject) => {
      if (method === "session/new") return { sessionId: ++next === 1 ? "one" : "two", configOptions: options };
      if (method === "session/list") return { sessions: [{ sessionId: "old", cwd }] };
      if (method === "session/resume") return { configOptions: options };
      if (method === "session/set_config_option") return { configOptions: [{ ...options[0], currentValue: params.value }] };
      return {};
    }),
    notify: vi.fn(), stop: vi.fn(async () => { client.onExit?.("stopped"); }),
  };
  const history: DshHistory = { list: vi.fn(async () => [log.header]), read: vi.fn(async id => ({ ...log, header: { ...log.header, id } })), close: vi.fn(async () => {}) };
  const runtime = new DshRuntime(client, history); runtimes.push(runtime);
  const events: { event: RuntimeEvent; runtimeId: string }[] = [];
  runtime.setEventSink((event, runtimeId) => { RuntimeEventSchema.parse(event); events.push({ event: structuredClone(event), runtimeId }); });
  await runtime.activate({ type: "new", cwd });
  const command = async (value: RuntimeCommand, id = "cmd", runtimeId = "dsh:one") => {
    expect(runtime.dispatchCommand(runtimeId, id, value)).toBe("handled");
    await vi.waitFor(() => expect(events.some(item => item.event.type === "command.result" && item.event.commandId === id && item.event.status !== "pending")).toBe(true));
    return events.flatMap(item => item.event.type === "command.result" && item.event.commandId === id ? [item.event] : []).at(-1)!;
  };
  return { runtime, client, history, cwd, events, command, log };
}

describe("DeepSeek Harness backend", () => {
  it("advertises dsh, namespaces sessions, combines live/listed sessions and routes only owned runtimes", async () => {
    const { runtime, client, cwd } = await fixture();
    expect(AgentKindSchema.parse("dsh")).toBe("dsh");
    expect(runtime.directoryEntries()[0]).toMatchObject({ runtimeId: "dsh:one", sessionId: "dsh:one", cwd });
    expect((await runtime.catalog()).map(item => item.sessionId)).toEqual(["dsh:old", "dsh:one"]);
    expect(await runtime.catalog(true)).toEqual([]);
    expect(runtime.dispatchCommand("codex:one", "cmd", { type: "stop" })).toBe("offline");
    await expect(runtime.activate({ type: "resume", sessionId: "one" })).rejects.toMatchObject({ code: "session_not_found" });
    await expect(runtime.activate({ type: "new", cwd: "relative" })).rejects.toMatchObject({ code: "cwd_missing" });
    await runtime.activate({ type: "resume", sessionId: "dsh:one" });
    expect(client.request).not.toHaveBeenCalledWith("session/resume", expect.anything(), expect.anything());
    await Promise.all([runtime.activate({ type: "resume", sessionId: "dsh:old" }), runtime.activate({ type: "resume", sessionId: "dsh:old" })]);
    expect(vi.mocked(client.request).mock.calls.filter(args => args[0] === "session/resume")).toHaveLength(1);
  });

  it("paginates the directory and rejects looping cursors", async () => {
    const { runtime, client } = await fixture();
    vi.mocked(client.request).mockResolvedValue({ sessions: [], nextCursor: "repeat" });
    await expect(runtime.catalog()).rejects.toThrow("重复");
  });

  it("serializes activation limits and refuses new work during shutdown", async () => {
    const { runtime, client, cwd } = await fixture();
    let sequence = 0;
    const request = vi.mocked(client.request).getMockImplementation()!;
    vi.mocked(client.request).mockImplementation((method, params, timeout) => method === "session/new"
      ? Promise.resolve({ sessionId: `extra-${++sequence}`, configOptions: [] }) : request(method, params, timeout));
    const results = await Promise.allSettled(Array.from({ length: 9 }, () => runtime.activate({ type: "new", cwd })));
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(7);
    expect(runtime.directoryEntries()).toHaveLength(8);
    const stopping = runtime.stop();
    await expect(runtime.activate({ type: "resume", sessionId: "dsh:one" })).rejects.toMatchObject({ code: "agent_unsupported" });
    await stopping;
  });

  it("changes only advertised opaque configuration choices and closes one session", async () => {
    const { runtime, client, command, cwd } = await fixture();
    await runtime.activate({ type: "new", cwd });
    expect((await command({ type: "slash.execute", name: "model", args: JSON.stringify("next-model") })).ok).toBe(true);
    expect(client.request).toHaveBeenCalledWith("session/set_config_option", { sessionId: "one", configId: "model", value: "next-model" });
    expect((await command({ type: "slash.execute", name: "model", args: "invented" }, "bad")).ok).toBe(false);
    expect((await command({ type: "slash.execute", name: "fork", args: "" }, "fork")).ok).toBe(false);
    await command({ type: "slash.execute", name: "quit", args: "" }, "quit");
    expect(runtime.ownsRuntime("dsh:one")).toBe(false);
    expect(runtime.ownsRuntime("dsh:two")).toBe(true);
  });

  it("translates committed updates, persists identities, and prevents duplicate prompt execution", async () => {
    const { runtime, client, command, events, log } = await fixture();
    vi.mocked(client.request).mockImplementation(async method => {
      if (method !== "session/prompt") return {};
      log.events = [
        { seq: 1, type: "user/message", data: { id: "u1", content: [{ type: "text", text: "hello" }] } },
        { seq: 2, type: "assistant/message", data: { message: { id: "a1", content: [{ type: "text", text: "你好" }] } } },
        { seq: 3, type: "turn/end", data: { turn: 1, reason: { kind: "completed" } } },
      ];
      client.onNotification?.("session/update", { sessionId: "one", update: { sessionUpdate: "agent_message_chunk", messageId: "a1", content: { type: "text", text: "你好" } } });
      return { stopReason: "end_turn" };
    });
    const prompt: RuntimeCommand = { type: "user_message", text: "hello", messageId: "phone-1", attachments: ["C:\\note.txt"] };
    expect((await command(prompt)).ok).toBe(true);
    expect(events).toContainEqual({ runtimeId: "dsh:one", event: { type: "message.delta", messageId: "a1", contentType: "text", contentIndex: 0, delta: "你好" } });
    const finished = events.find(item => item.event.type === "turn.finished")!.event;
    expect(finished).toMatchObject({ persistedMessages: expect.arrayContaining([{ messageId: "phone-1", entryId: "dsh:one:1" }, { messageId: "a1", entryId: "dsh:one:2" }]) });
    expect((await command(prompt, "retry")).ok).toBe(true);
    expect(vi.mocked(client.request).mock.calls.filter(args => args[0] === "session/prompt")).toHaveLength(1);
    expect((await command({ ...prompt, text: "changed" }, "conflict")).status).toBe("message_id_conflict");
    expect(runtime.directoryEntries()[0]?.status).toBe("idle");
  });

  it("keeps stop usable while a prompt waits and reports prompt failure", async () => {
    const { runtime, client, command, events } = await fixture();
    let rejectPrompt: ((error: Error) => void) | undefined;
    vi.mocked(client.request).mockImplementation(async method => method === "session/prompt" ? new Promise((_resolve, reject) => { rejectPrompt = reject; }) : {});
    runtime.dispatchCommand("dsh:one", "prompt", { type: "user_message", text: "work" });
    await vi.waitFor(() => expect(rejectPrompt).toBeDefined());
    expect((await command({ type: "user_message", text: "interrupt", delivery: "steer" }, "steer")).ok).toBe(false);
    await command({ type: "stop" }, "stop");
    expect(client.notify).toHaveBeenCalledWith("session/cancel", { sessionId: "one" });
    rejectPrompt!(new Error("test failure"));
    await vi.waitFor(() => expect(events).toContainEqual(expect.objectContaining({ event: expect.objectContaining({ type: "command.result", commandId: "prompt", ok: false }) })));
  });

  it("honors stop during history admission and preserves cancelled duplicate receipts", async () => {
    const { runtime, client, history, command, events, log } = await fixture();
    let release: ((value: DshLog) => void) | undefined;
    vi.mocked(history.read).mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const prompt: RuntimeCommand = { type: "user_message", text: "do not run", messageId: "cancelled-message" };
    runtime.dispatchCommand("dsh:one", "admission", prompt);
    await command({ type: "stop" }, "early-stop");
    release!(log);
    await vi.waitFor(() => expect(events.some(item => item.event.type === "command.result" && item.event.commandId === "admission" && item.event.status === "cancelled")).toBe(true));
    expect(vi.mocked(client.request).mock.calls.filter(args => args[0] === "session/prompt")).toHaveLength(0);
    expect((await command(prompt, "retry-cancelled")).status).toBe("cancelled");
    expect(events.filter(item => item.event.type === "turn.finished")).toHaveLength(1);
  });

  it("finishes the turn even when history cannot be read", async () => {
    const { runtime, history, command, events } = await fixture();
    vi.mocked(history.read).mockRejectedValue(new Error("history unavailable"));
    expect((await command({ type: "user_message", text: "work" })).ok).toBe(false);
    expect(events.filter(item => item.event.type === "turn.finished")).toHaveLength(1);
    expect(runtime.directoryEntries()[0]?.status).toBe("idle");
  });

  it("preserves source times, injected context, reasoning and named tool results", () => {
    const entries = dshEntries({ header: { id: "source", createdAt: 0 }, events: [
      { seq: 1, time: 1720000000100, type: "user/message", data: { id: "context", source: { kind: "system" }, content: [{ type: "text", text: "injected" }] } },
      { seq: 2, time: 1720000000200, type: "assistant/message", data: { message: { id: "assistant", content: [{ type: "reasoning", text: "thinking" }, { type: "tool-call", id: "call", name: "read", arguments: "{\"path\":\"README.md\"}" }] } } },
      { seq: 3, time: 1720000000300, type: "tool/call", data: { callId: "call", name: "read" } },
      { seq: 4, time: 1720000000400, type: "tool/result", data: { message: { id: "result", toolCallId: "call", isError: false, content: [{ type: "text", text: "file contents" }] } } },
    ] });
    expect(entries[0]?.data.message).toMatchObject({ role: "custom", timestamp: 1720000000100 });
    expect(entries[1]?.data.message).toMatchObject({ content: [{ type: "thinking", text: "thinking" }, { type: "tool_call", toolName: "read", arguments: { path: "README.md" } }] });
    expect(entries[2]).toMatchObject({ entryId: "dsh:source:4", parentId: "dsh:source:2", timestamp: new Date(1720000000400).toISOString(), data: { message: { role: "tool", toolName: "read", toolCallId: "call", timestamp: 1720000000400 } } });
  });

  it("binds one-shot approvals to their session, replays them and cancels on stop", async () => {
    const { runtime, client, command, events, cwd } = await fixture();
    await runtime.activate({ type: "new", cwd });
    const respond = vi.fn();
    client.onRequest?.({ method: "session/request_permission", params: { sessionId: "one", toolCall: { toolCallId: "t1" }, options: [{ optionId: "allow-once", name: "Allow once" }, { optionId: "reject-once", name: "Reject" }] }, respond, reject: vi.fn() });
    const event = events.find(item => item.event.type === "interaction.requested")!.event;
    if (event.type !== "interaction.requested") throw new Error("missing approval");
    const response: RuntimeCommand = { type: "interaction.respond", requestId: event.request.requestId, extensionId: "dsh", response: { kind: "select", value: "allow-once" } };
    expect((await command(response, "foreign", "dsh:two")).ok).toBe(false);
    expect(respond).not.toHaveBeenCalled();
    await command({ type: "session.sync", sessionId: "dsh:one", syncId: "sync", range: "preview" }, "sync");
    expect(events.some(item => item.event.type === "interaction.snapshot" && item.event.requests.length === 1)).toBe(true);
    await command(response, "approve");
    expect(respond).toHaveBeenCalledExactlyOnceWith({ outcome: { outcome: "selected", optionId: "allow-once" } });
    expect((await command(response, "duplicate")).ok).toBe(false);
    client.onRequest?.({ method: "session/request_permission", params: { sessionId: "one", options: [{ optionId: "reject-once", name: "Reject" }] }, respond, reject: vi.fn() });
    await command({ type: "stop" }, "stop");
    expect(respond).toHaveBeenLastCalledWith({ outcome: { outcome: "cancelled" } });
  });

  it("keeps history canonical across preview and catch-up and rejects cross-session sync", async () => {
    const { command, events, log } = await fixture();
    log.events = [{ seq: 5, type: "user/message", data: { id: "u", content: [{ type: "text", text: "你好" }] } }];
    await command({ type: "session.sync", sessionId: "dsh:one", syncId: "preview", range: "preview" });
    const first = events.find(item => item.event.type === "session.snapshot")!.event;
    log.events.push({ seq: 10, type: "assistant/message", data: { message: { id: "a", content: [{ type: "tool-call", id: "t", name: "read", arguments: "{}" }] } } });
    await command({ type: "session.sync", sessionId: "dsh:one", syncId: "history", range: "history" }, "history");
    const history = events.find(item => item.event.type === "session.snapshot" && item.event.syncId === "history")!.event;
    if (first.type !== "session.snapshot" || history.type !== "session.snapshot") throw new Error("missing snapshot");
    expect(history.entries[0]).toEqual(first.entries[0]);
    expect(history.entries[1]?.parentId).toBe("dsh:one:5");
    expect((await command({ type: "session.sync", sessionId: "dsh:two", syncId: "bad", range: "preview" }, "bad")).ok).toBe(false);
    expect(dshEntries(log)).toEqual(history.entries);
  });
});
