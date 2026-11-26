import { describe, expect, it, vi } from "vitest";
import { RuntimeEventSchema, type RuntimeEvent } from "@orbis/protocol";
import { AcpUnconfirmedError, type AcpConnection } from "./acp-client.js";
import { AgyRuntime } from "./agy-runtime.js";

const configuration = (currentValue = "mdl-a") => [{ type: "select", id: "nativeModel", category: "model", currentValue,
  options: [{ group: "Gemini", name: "Gemini", options: [{ value: "mdl-a", name: "A" }, { value: "mdl-b", name: "B" }] }] }];

function setup() {
  let finish!: (value: unknown) => void;
  let fail!: (reason: unknown) => void;
  const update = (sessionId: string, sessionUpdate: string, text: string) => client.onNotification?.("session/update", { sessionId, update: { sessionUpdate, content: { type: "text", text } } });
  const client: AcpConnection = { supportsClose: true, onNotification: undefined, onExit: undefined, onRequest: undefined, stop: vi.fn(async () => {}), notify: vi.fn(),
    request: vi.fn(async (method, params) => {
      if (method === "session/list") return { sessions: [{ sessionId: "existing", cwd: process.cwd(), title: "Existing" }] };
      if (method === "session/new") return { sessionId: "fresh", configOptions: configuration() };
      if (method === "session/set_config_option") return { configOptions: configuration(String(params.value)) };
      if (method === "session/close") return {};
      if (method === "session/load") {
        expect(params).toMatchObject({ sessionId: "existing", mcpServers: [] });
        update("other", "agent_message_chunk", "wrong session");
        update("existing", "user_message_chunk", "question");
        update("existing", "agent_message_chunk", "first ");
        update("existing", "agent_message_chunk", "answer");
        client.onNotification?.("session/update", { sessionId: "existing", update: { sessionUpdate: "tool_call", toolCallId: "t1", title: "Read", status: "pending", rawInput: "private-tool-input" } });
        client.onNotification?.("session/update", { sessionId: "existing", update: { sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed", rawOutput: "private-tool-output" } });
        return {};
      }
      if (method === "session/prompt") return new Promise((resolve, reject) => { finish = resolve; fail = reject; });
      throw new Error(method);
    }),
  };
  const runtime = new AgyRuntime(async () => client), events: RuntimeEvent[] = [];
  runtime.setEventSink(event => { RuntimeEventSchema.parse(event); events.push(event); });
  return { client, runtime, events, update, fail: (value: unknown) => fail(value), finish: (value: unknown) => finish(value) };
}

describe("Antigravity ACP backend", () => {
  // ACP history is replayed before the load result; unrelated sessions must never mix.
  it("lists, coalesces concurrent load, and pages native replay", async () => {
    const { runtime, client, events } = setup();
    await runtime.start();
    expect(await runtime.catalog()).toEqual([expect.objectContaining({ agentKind: "agy", sessionId: "agy:existing" })]);
    try {
      const target = { type: "resume", sessionId: "agy:existing" } as const;
      expect(await Promise.all([runtime.activate(target), runtime.activate(target)])).toEqual(Array(2).fill({ sessionId: "agy:existing", spawnMode: "headless" }));
      expect(vi.mocked(client.request).mock.calls.filter(([method]) => method === "session/load")).toHaveLength(1);
      runtime.dispatchCommand("agy:existing", "read", { type: "session.sync", sessionId: "agy:existing", syncId: "preview", range: "preview" });
      expect(JSON.stringify(events.find(event => event.type === "session.snapshot"))).toContain("first answer");
      expect(JSON.stringify(events)).not.toContain("wrong session");
      expect(JSON.stringify(events.find(event => event.type === "session.snapshot"))).toContain("Read");
      expect(JSON.stringify(events)).not.toContain("private-tool-");
    } finally { await runtime.stop(); }
  });

  // A stop is pending until ACP confirms it; an ambiguous send is never repeated on this connection.
  it("creates, streams and reconciles cancellation and duplicate sends", async () => {
    const { runtime, client, events, update, finish } = setup();
    await runtime.start();
    try {
      const created = vi.fn(async () => {});
      expect(await runtime.activate({ type: "new", cwd: process.cwd() }, { onCreated: created })).toEqual({ sessionId: "agy:fresh", spawnMode: "headless" });
      expect(created).toHaveBeenCalledOnce();
      const prompt = { type: "user_message", text: "question", messageId: "same" } as const;
      expect(runtime.dispatchCommand("agy:fresh", "write", prompt)).toBe("handled");
      runtime.dispatchCommand("agy:fresh", "duplicate", prompt);
      update("fresh", "agent_message_chunk", "partial answer");
      runtime.dispatchCommand("agy:fresh", "stop", { type: "stop" });
      expect(events).toContainEqual(expect.objectContaining({ commandId: "stop", status: "pending" }));
      expect(client.notify).toHaveBeenCalledWith("session/cancel", { sessionId: "fresh" });
      finish({ stopReason: "cancelled" });
      await vi.waitFor(() => expect(events).toContainEqual(expect.objectContaining({ commandId: "stop", status: "success" })));
      expect(events).toContainEqual(expect.objectContaining({ type: "turn.finished", outcome: "cancelled" }));
      expect(events).toContainEqual(expect.objectContaining({ commandId: "duplicate", status: "cancelled" }));
      expect(vi.mocked(client.request).mock.calls.filter(([method]) => method === "session/prompt")).toHaveLength(1);
    } finally { await runtime.stop(); }
  });

  // Apps always send the permission container, while ACP has no pre-session catalog: an empty selection must not block launch.
  it("accepts an empty pre-session selection and still refuses chosen settings", async () => {
    const { runtime } = setup();
    await runtime.start();
    try {
      expect(await runtime.activate({ type: "new", cwd: process.cwd() }, { configuration: { permissions: {} } }))
        .toEqual({ sessionId: "agy:fresh", spawnMode: "headless" });
      await expect(runtime.activate({ type: "new", cwd: process.cwd() }, { configuration: { model: "mdl-a" } }))
        .rejects.toThrow("未提供新建前的模型或权限目录");
      await expect(runtime.activate({ type: "new", cwd: process.cwd() }, { configuration: { permissions: { sandbox: "readOnly" } } }))
        .rejects.toThrow("未提供新建前的模型或权限目录");
    } finally { await runtime.stop(); }
  });
});

// AGY-12: only the exact native prompt's offered one-time choice is accepted.
it("routes a bounded permission and rejects a forged or stale result", async () => {
  const { client, runtime, events, finish } = setup();
  const respond = vi.fn(), reject = vi.fn();
  await runtime.start();
  try {
    await runtime.activate({ type: "new", cwd: process.cwd() });
    runtime.dispatchCommand("agy:fresh", "prompt", { type: "user_message", text: "please edit" });
    client.onRequest?.({ method: "session/request_permission", params: { sessionId: "fresh", toolCall: { title: "Edit" }, options: [
      { optionId: "native-once", kind: "allow_once", name: "Allow once" }, { optionId: "native-always", kind: "allow_always", name: "Allow always" },
    ] }, respond, reject });
    const card = events.find(event => event.type === "interaction.requested")?.request;
    expect(card?.kind).toBe("select");
    if (card?.kind !== "select") throw new Error("Permission not projected");
    expect(card.options).toHaveLength(1);
    const choose = (commandId: string, value: string) => runtime.dispatchCommand("agy:fresh", commandId,
      { type: "interaction.respond", requestId: card.requestId, extensionId: card.extensionId, response: { kind: "select", value } });
    choose("forged", "native-always");
    expect(respond).not.toHaveBeenCalled();
    choose("valid", card.options[0]!.value); choose("repeat", card.options[0]!.value);
    expect(respond).toHaveBeenCalledExactlyOnceWith({ outcome: { outcome: "selected", optionId: "native-once" } });
    finish({ stopReason: "end_turn" });
  } finally { await runtime.stop(); }
});

it("serializes follow-ups and interrupt-send and does not replay on an unconfirmed turn", async () => {
  const { client, runtime, events, finish, fail } = setup();
  const calls = () => vi.mocked(client.request).mock.calls.filter(([method]) => method === "session/prompt");
  await runtime.start();
  try {
    await runtime.activate({ type: "new", cwd: process.cwd() });
    const send = (id: string, delivery?: "followUp" | "steer") => runtime.dispatchCommand("agy:fresh", id,
      { type: "user_message", text: id, messageId: id, ...(delivery ? { delivery } : {}) });
    send("first"); send("later", "followUp"); send("withdraw", "followUp"); send("urgent", "steer");
    runtime.dispatchCommand("agy:fresh", "remove", { type: "user_message.cancel", messageId: "withdraw" });
    expect(events).toContainEqual(expect.objectContaining({ queueId: "withdraw", state: "cancelled" }));
    expect(client.notify).toHaveBeenCalledExactlyOnceWith("session/cancel", { sessionId: "fresh" });
    expect(calls()).toHaveLength(1);
    finish({ stopReason: "cancelled" });
    await vi.waitFor(() => expect(calls().at(-1)?.[1]).toMatchObject({ prompt: [{ text: "urgent" }] }));
    fail(new AcpUnconfirmedError("unconfirmed"));
    await vi.waitFor(() => expect(events).toContainEqual(expect.objectContaining({ queueId: "later", state: "rejected" })));
    expect(calls()).toHaveLength(2);
    send("urgent", "steer");
    expect(events).toContainEqual(expect.objectContaining({ commandId: "urgent", status: "unconfirmed" }));
    expect(calls()).toHaveLength(2);
  } finally { await runtime.stop(); }
});

it("confirms an advertised model, scopes close to the attachment and retains history identity", async () => {
  const { client, runtime, events } = setup();
  await runtime.start();
  try {
    await runtime.activate({ type: "new", cwd: process.cwd() });
    const session = "agy:fresh";
    expect(runtime.directoryEntries()).toContainEqual(expect.objectContaining({ model: { provider: "agy", id: "mdl-a", name: "A" } }));
    runtime.dispatchCommand(session, "model", { type: "slash.execute", name: "model", args: "mdl-b" });
    await vi.waitFor(() => expect(events).toContainEqual(expect.objectContaining({ commandId: "model", status: "success" })));
    expect(client.request).toHaveBeenCalledWith("session/set_config_option", { sessionId: "fresh", configId: "nativeModel", value: "mdl-b" });
    expect(runtime.directoryEntries()).toContainEqual(expect.objectContaining({ modelSelection: { model: "mdl-b" } }));
    const generation = events.find(event => event.type === "runtime.capabilities")?.capabilities.commands.find(command => command.name === "orbis-close")?.closeGeneration;
    expect(generation).toBeTruthy();
    const close = { type: "session.close", sessionId: session, confirmed: false } as const;
    expect(runtime.dispatchCommand(session, "stale", { ...close, closeGeneration: "stale" })).toBe("unsupported");
    runtime.dispatchCommand(session, "close", { ...close, closeGeneration: generation! });
    await vi.waitFor(() => expect(events).toContainEqual(expect.objectContaining({ commandId: "close", status: "success" })));
    expect(client.request).toHaveBeenCalledWith("session/close", { sessionId: "fresh" });
    expect(runtime.directoryEntries()).toEqual([]);
    expect(runtime.archivedCatalogSupported).toBe(false);
  } finally { await runtime.stop(); }
});
