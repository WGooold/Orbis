import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import { RuntimeCommandSchema, RuntimeEventSchema, RuntimeWireEventSchema, SessionConfigurationCatalogSchema, type RuntimeEvent } from "@orbis/protocol";
import { HermesAgentBackend } from "./hermes-agent-backend.js";
import type { HermesGatewayEndpoint, HermesGatewayRuntimeDescriptor } from "./hermes-gateway-bootstrap.js";
import { HermesGatewayRpcError, type HermesGatewayEvent, type HermesJsonObject } from "./hermes-gateway-rpc.js";
import { hermesModelValue } from "./hermes-session-configuration.js";
import { AgentConversationState } from "./agent-conversation-state.js";
import { AgentStateRegistry, type StateScope } from "./agent-state-registry.js";
import { AgentToolInventory } from "./agent-tool-inventory.js";
import { ToolInventoryIngestion } from "./tool-inventory-ingestion.js";

const fixtureCwd = process.platform === "win32" ? "C:\\workspace\\project" : "/workspace/project";
const endpoint: HermesGatewayEndpoint = {
  profile_id: "/fixture/hermes-home",
  instance_id: "fixture-instance",
  authority_epoch: 1,
  runtime_protocol: 1,
  api_origin: "http://127.0.0.1:43121",
  supervisor: "fixture",
  capabilities: ["session-authority-v1"],
};
const runtime: HermesGatewayRuntimeDescriptor = {
  profile_id: endpoint.profile_id,
  instance_id: endpoint.instance_id,
  authority_epoch: endpoint.authority_epoch,
  capabilities: ["session-authority-v1", "durable-admission-v1", "event-replay-v1"],
  session_create: { sources: ["tui"], parameters: ["source", "cwd", "request_id"] },
};

function snapshot(sessionId = "stored-session", gatewaySessionId = sessionId) {
  return {
    session_id: gatewaySessionId,
    stored_session_id: sessionId,
    subscription_id: `sub-${gatewaySessionId}`,
    messages: [
      { role: "user", text: "Earlier question", row_id: 1, timestamp: 1_700_000_000 },
      { role: "assistant", text: "Earlier answer", row_id: 2, timestamp: 1_700_000_001 },
    ],
    info: { cwd: fixtureCwd, title: "Fixture session", provider: "openai", model: "gpt-fixture" },
    message_count: 2,
    running: false,
    execution_generation: 0,
    last_sequence: 0,
    authority_epoch: endpoint.authority_epoch,
    prompts: [],
    replay_epoch: "replay-1",
  };
}

class GatewayFixture {
  readonly calls: Array<{ method: string; params: HermesJsonObject }> = [];
  readonly handlers = new Map<string, (params: HermesJsonObject) => unknown | Promise<unknown>>();
  closed = false;
  readyState = 1;

  async request<T = unknown>(method: string, params: HermesJsonObject = {}): Promise<T> {
    this.calls.push({ method, params });
    const handler = this.handlers.get(method);
    if (handler) return await handler(params) as T;
    if (method === "session.events.since") return { events: [], latest_seq: params.last_sequence, last_sequence: params.last_sequence, epoch: "replay-1", replay_epoch: "replay-1", truncated: false, snapshot_required: false } as T;
    if (method === "session.detach") return { detached: true } as T;
    throw new Error(`unhandled fixture RPC: ${method}`);
  }
}

function makeBackend(gateway = new GatewayFixture(), extra: Partial<ConstructorParameters<typeof HermesAgentBackend>[0]> = {}) {
  const events: RuntimeEvent[] = [];
  const backend = new HermesAgentBackend({
    client: gateway,
    endpoint,
    runtime,
    hostId: "fixture-host",
    onEvent: (_runtimeId, event) => events.push(event),
    ...extra,
  });
  return { backend, gateway, events };
}

const sessionId = "stored-session";
const nativeId = "gateway-resumed";
const frame = (seq: number, type: string, payload: HermesJsonObject, stamp: HermesJsonObject = {}): HermesGatewayEvent => ({
  session_id: nativeId, type, seq, replay_epoch: "replay-1", admission_id: "admission-1", execution_generation: 1,
  authority_epoch: endpoint.authority_epoch, payload, ...stamp,
});
const nativeCall = { id: "call-secret", type: "function", function: { name: "read", arguments: '{"secret":"private-input"}' } };
const nativeApproval = { kind: "approval", prompt_id: "permit-1", command: "read fixture.txt", execution_generation: 1,
  choices: ["once", "deny", "session", "always"] };
const selectionRuntime = { ...runtime, session_create: { ...runtime.session_create, parameters: [...runtime.session_create.parameters, "model", "provider"] } };

function preview(backend: HermesAgentBackend, runtimeId: string, id: string) {
  return backend.dispatchCommand(runtimeId, id, { type: "session.sync", sessionId, syncId: id, range: "preview" });
}

describe("HermesAgentBackend", () => {
  it("creates a Gateway-owned TUI session with a stable launch request id", async () => {
    const gateway = new GatewayFixture();
    gateway.handlers.set("session.create", () => snapshot("stored-created", "gateway-created"));
    const onCreated = vi.fn(async () => undefined);
    const { backend, events } = makeBackend(gateway);

    const activation = await backend.activate({ type: "new", cwd: tmpdir() }, { launchId: "launch-42", onCreated });

    expect(activation).toEqual({ sessionId: "stored-created", spawnMode: "headless" });
    expect(gateway.calls.find(call => call.method === "session.create")?.params).toMatchObject({
      source: "tui", cwd: tmpdir(), request_id: "launch-42",
    });
    expect(onCreated).toHaveBeenCalledWith({ sessionId: "stored-created", spawnMode: "headless" });
    expect(backend.directoryEntries()).toMatchObject([{ sessionId: "stored-created", cwd: fixtureCwd, status: "idle" }]);
    expect(events.some(event => event.type === "runtime.metadata")).toBe(true);
  });

  it("lists live and resumable history without claiming archived coverage", async () => {
    const gateway = new GatewayFixture();
    gateway.handlers.set("session.list", params => params.scope === "live"
      ? { scope: "live", sessions: [{ session_id: "shared", id: "shared", title: "Live title", started_at: 1_700_000_100, message_count: 4, running: true }] }
      : { scope: "stored", sessions: [
        { session_id: "shared", id: "shared", title: "Stale title", started_at: 1_700_000_000, message_count: 3 },
        { session_id: "saved", resolved_id: "saved", id: "saved-root", title: "Saved title", started_at: 1_700_000_050, message_count: 2 },
      ] });
    const { backend } = makeBackend(gateway);

    const sessions = await backend.catalog();

    expect(sessions.map(item => item.sessionId)).toEqual(["shared", "saved"]);
    expect(sessions[0]).toMatchObject({ name: "Live title", messageCount: 4, archived: false, cwd: "" });
    expect(sessions[1]).toMatchObject({ name: "Saved title", messageCount: 2, archived: false });
    expect(backend.archivedCatalogSupported).toBe(false);
    expect(await backend.catalog(true)).toEqual([]);
    await expect(backend.setArchived("saved", true)).rejects.toMatchObject({ code: "unsupported" });
  });

  it("keeps a full 200-row Gateway page marked partial because this contract has no cursor", async () => {
    const gateway = new GatewayFixture();
    gateway.handlers.set("session.list", params => ({
      scope: params.scope,
      sessions: Array.from({ length: params.scope === "live" ? 200 : 0 }, (_, index) => ({
        session_id: `live-${index}`, id: `live-${index}`, title: "Session", started_at: index, message_count: 1,
      })),
    }));
    const { backend } = makeBackend(gateway);

    expect(await backend.catalog()).toHaveLength(200);
    expect(backend.catalogComplete).toBe(false);
  });

  it("resumes native history and emits an Orbis display snapshot", async () => {
    const gateway = new GatewayFixture();
    gateway.handlers.set("session.resume", params => snapshot(String(params.session_id), "gateway-resumed"));
    const { backend, events } = makeBackend(gateway);
    const activation = await backend.activate({ type: "resume", sessionId: "stored-session" });
    const runtimeId = backend.directoryEntries()[0]!.runtimeId;

    backend.dispatchCommand(runtimeId, "sync-command", RuntimeCommandSchema.parse({
      type: "session.sync", sessionId: activation.sessionId, syncId: "sync-1", range: "preview",
    }));
    const emitted = events.find((event): event is Extract<RuntimeEvent, { type: "session.snapshot" }> =>
      event.type === "session.snapshot" && event.syncId === "sync-1");

    expect(emitted?.entries).toHaveLength(2);
    expect(emitted?.display?.entries.map(entry => entry.message?.role)).toEqual(["user", "assistant"]);
    expect(RuntimeEventSchema.safeParse(emitted).success).toBe(true);
  });

  it("projects Hermes tool history before a session snapshot reaches the wire", async () => {
    const gateway = new GatewayFixture();
    gateway.handlers.set("session.resume", params => ({ ...snapshot(String(params.session_id), "gateway-resumed"), messages: [
      { role: "user", text: "Inspect the project", row_id: 1, timestamp: 1_700_000_000 },
      { role: "assistant", row_id: 2, timestamp: 1_700_000_001, content: [
        { type: "tool_call", id: "call-secret", name: "read", arguments: { path: "/private/secret.txt", token: "do-not-broadcast" } },
      ] },
      { role: "tool", tool_call_id: "call-secret", name: "read", is_error: false, row_id: 3, timestamp: 1_700_000_002,
        content: [{ type: "text", text: "private tool output must not be broadcast" }] },
      { role: "assistant", row_id: 4, timestamp: 1_700_000_003, content: [{ type: "text", text: "Done" },
        { type: "image_url", image_url: "private-media-url" }] },
    ] }));
    const { backend, events } = makeBackend(gateway);
    const activation = await backend.activate({ type: "resume", sessionId: "stored-session" });
    const runtimeId = backend.directoryEntries()[0]!.runtimeId;

    backend.dispatchCommand(runtimeId, "sync-tools", RuntimeCommandSchema.parse({
      type: "session.sync", sessionId: activation.sessionId, syncId: "sync-tools", range: "preview",
    }));
    const emitted = events.find((event): event is Extract<RuntimeEvent, { type: "session.snapshot" }> =>
      event.type === "session.snapshot" && event.syncId === "sync-tools");
    expect(emitted?.display?.entries.at(-1)?.message?.content).toEqual([
      { type: "text", text: "Done" }, { type: "render", renderKind: "image", text: "图片内容暂不可显示" },
    ]);
    expect(JSON.stringify(emitted)).not.toContain("private-media-url");
    const toolCall = emitted?.display?.entries.find(entry => entry.message?.content.some(part => part.type === "tool_call"))?.message?.content
      .find(part => part.type === "tool_call");
    const toolResult = emitted?.entries.find(entry => (entry.data.message as { role?: string }).role === "toolResult")?.data.message;

    expect(RuntimeWireEventSchema.safeParse(emitted).success).toBe(true);
    expect(toolCall).toMatchObject({ type: "tool_call", toolCallId: "call-secret", toolName: "read",
      summary: { tool: { agent: { agentKind: "hermes", sessionId: "stored-session" } }, toolName: "read" } });
    expect(toolCall && "arguments" in toolCall).toBe(false);
    expect(toolResult).toMatchObject({ role: "toolResult", content: [], toolCallId: "call-secret",
      toolSummary: { tool: { agent: { agentKind: "hermes", sessionId: "stored-session" } }, phase: "finished" } });
    expect(JSON.stringify(emitted)).not.toContain("do-not-broadcast");
    expect(JSON.stringify(emitted)).not.toContain("private tool output must not be broadcast");
  });

  it("reconciles streamed output to native row ids and correlates the optimistic user message", async () => {
    const gateway = new GatewayFixture();
    gateway.handlers.set("session.resume", params => snapshot(String(params.session_id), "gateway-resumed"));
    gateway.handlers.set("prompt.submit", () => ({ admission_id: "admission-1", ref: { profile_id: endpoint.profile_id, session_id: "gateway-resumed" },
      sequence: 1, status: "started", outcome: null, authority_epoch: 1, execution_generation: 1 }));
    const { backend, events } = makeBackend(gateway);
    await backend.activate({ type: "resume", sessionId: "stored-session" });
    const runtimeId = backend.directoryEntries()[0]!.runtimeId;
    backend.dispatchCommand(runtimeId, "send-1", RuntimeCommandSchema.parse({
      type: "user_message", text: "New question", messageId: "optimistic-message-1",
    }));
    await vi.waitFor(() => expect(events.some(event => event.type === "command.result" && event.commandId === "send-1")).toBe(true));

    await backend.handleGatewayEvent({ type: "message.start", session_id: "gateway-resumed", seq: 1, replay_epoch: "replay-1",
      admission_id: "admission-1", execution_generation: 1, payload: {} });
    await backend.handleGatewayEvent({ type: "message.delta", session_id: "gateway-resumed", seq: 2, replay_epoch: "replay-1",
      admission_id: "admission-1", execution_generation: 1, payload: { text: "New answer" } });
    await backend.handleGatewayEvent({ type: "message.complete", session_id: "gateway-resumed", seq: 3, replay_epoch: "replay-1",
      admission_id: "admission-1", execution_generation: 1, payload: { text: "New answer", status: "complete",
        persisted_turn: { row_ids: [3, 4], user_row_id: 3, final_assistant_row_id: 4, user_row_ids: [3], submission_id: "send-1", complete: true } } });

    backend.dispatchCommand(runtimeId, "sync-command", RuntimeCommandSchema.parse({
      type: "session.sync", sessionId: "stored-session", syncId: "sync-after-turn", range: "preview",
    }));
    const snapshotEvent = events.find((event): event is Extract<RuntimeEvent, { type: "session.snapshot" }> =>
      event.type === "session.snapshot" && event.syncId === "sync-after-turn");
    const user = snapshotEvent?.display?.entries.find(entry => entry.message?.clientMessageId === "optimistic-message-1");

    expect(user?.message?.content).toEqual([{ type: "text", text: "New question" }]);
    expect(snapshotEvent?.display?.entries.at(-1)?.message?.content).toEqual([{ type: "text", text: "New answer" }]);
    expect(snapshotEvent?.entries.at(-1)?.entryId).toContain(":4");
  });

  it("does not resend a prompt when the Gateway response is uncertain", async () => {
    const gateway = new GatewayFixture();
    gateway.handlers.set("session.resume", params => snapshot(String(params.session_id), "gateway-resumed"));
    gateway.handlers.set("prompt.submit", () => { throw new Error("socket dropped after write"); });
    const { backend, events } = makeBackend(gateway);
    await backend.activate({ type: "resume", sessionId: "stored-session" });
    const runtimeId = backend.directoryEntries()[0]!.runtimeId;

    backend.dispatchCommand(runtimeId, "send-unknown", RuntimeCommandSchema.parse({ type: "user_message", text: "Do not duplicate" }));
    await vi.waitFor(() => expect(events.some(event => event.type === "command.result" && event.commandId === "send-unknown" && event.status === "unconfirmed")).toBe(true));

    expect(gateway.calls.filter(call => call.method === "prompt.submit")).toHaveLength(1);
  });

  it("does not use prompt or event replay methods absent their negotiated capabilities", async () => {
    const gateway = new GatewayFixture();
    gateway.handlers.set("session.resume", params => snapshot(String(params.session_id), "gateway-resumed"));
    const limitedRuntime = { ...runtime, capabilities: ["session-authority-v1"] };
    const { backend } = makeBackend(gateway, { runtime: limitedRuntime });
    await backend.activate({ type: "resume", sessionId: "stored-session" });
    const runtimeId = backend.directoryEntries()[0]!.runtimeId;

    expect(backend.dispatchCommand(runtimeId, "send", RuntimeCommandSchema.parse({ type: "user_message", text: "Hello" }))).toBe("unsupported");
    expect(gateway.calls.some(call => call.method === "session.events.since" || call.method === "prompt.submit")).toBe(false);
  });

  // HERMES-CONTENT-01: the actual Host source transaction must ingest live summaries and retire them at the native commit.
  it("reconciles native tool rows and a queued cancellation without exposing any tool body", async () => {
    const gateway = new GatewayFixture();
    const initial = snapshot(sessionId, nativeId);
    gateway.handlers.set("session.resume", () => initial);
    const { backend, events } = makeBackend(gateway);
    const registry = new AgentStateRegistry();
    const conversations = new AgentConversationState(registry);
    const inventory = new AgentToolInventory(registry);
    const ingestion = new ToolInventoryIngestion(inventory);
    const scope: StateScope = { kind: "agent", key: { hostId: "fixture-host", agentKind: "hermes", sessionId } };
    const rejections: string[] = [];
    backend.setEventSink((event, runtimeId) => {
      if (event.type === "session.tools.produced") {
        if (!ingestion.accept(runtimeId, scope.key, event)) rejections.push("producer page");
      } else if (event.type === "session.patch" || event.type === "session.snapshot") {
        conversations.accept(scope, event, ready => ready && event.source && event.live?.toolInventory
          ? ingestion.prepare(runtimeId, scope.key, event.source, event.live.toolInventory) : undefined, reason => rejections.push(reason));
      }
    });
    await backend.activate({ type: "resume", sessionId });
    const runtimeId = backend.directoryEntries()[0]!.runtimeId;
    preview(backend, runtimeId, "baseline");
    await backend.handleGatewayEvent(frame(1, "message.start", {}));
    await backend.handleGatewayEvent(frame(2, "tool.start", { tool_id: "call-secret", name: "read", args: { secret: "private-input" } }));
    preview(backend, runtimeId, "tool-running");
    expect(inventory.reference(scope.key)?.totalCount).toBe(1);
    await backend.handleGatewayEvent(frame(3, "message.complete", { outcome: "cancelled" }, { admission_id: "queued-2", execution_generation: undefined }));
    expect(backend.directoryEntries()[0]?.status).toBe("running");
    const completed = frame(4, "tool.complete", { tool_id: "call-secret", name: "read", result: "private-output",
      inline_diff: "private-diff", duration_s: 0.25, is_error: false });
    await backend.handleGatewayEvent(completed);
    await backend.handleGatewayEvent(completed);
    preview(backend, runtimeId, "tool-finished");
    expect(events).toContainEqual(expect.objectContaining({ type: "session.tools.produced", page: expect.objectContaining({ tools: [
      expect.objectContaining({ phase: "finished", isError: false, durationMs: 250, tool: { agent: scope.key, toolCallId: "call-secret" } }),
    ] }) }));

    gateway.handlers.set("session.resume", () => ({ ...initial, last_sequence: 5, execution_generation: 1, messages: [
      ...(initial.messages as unknown[]),
      { row_id: 3, role: "user", content: "Check the fixture", timestamp: 1_700_000_002 },
      { row_id: 4, role: "assistant", content: null, tool_calls: [nativeCall], timestamp: 1_700_000_003 },
      { row_id: 5, role: "tool", tool_call_id: "call-secret", content: "private-output", timestamp: 1_700_000_004 },
      { row_id: 6, role: "assistant", content: "Done", timestamp: 1_700_000_005 },
    ] }));
    await backend.handleGatewayEvent(frame(5, "message.complete", { status: "complete", text: "Done",
      persisted_turn: { row_ids: [3, 4, 5, 6], user_row_ids: [3], user_row_id: 3, final_assistant_row_id: 6, complete: true } }));
    preview(backend, runtimeId, "tool-history");
    const history = events.find(event => event.type === "session.snapshot" && event.syncId === "tool-history");
    expect(history).toMatchObject({ entries: expect.arrayContaining([
      expect.objectContaining({ data: { message: expect.objectContaining({ role: "toolResult", toolName: "read", content: [] }) } }),
    ]), live: { toolInventory: { totalCount: 0 } } });
    expect(inventory.reference(scope.key)?.totalCount).toBe(0);
    expect(gateway.calls.filter(call => call.method === "session.resume")).toHaveLength(2);
    expect(rejections).toEqual([]);
    for (const event of events) expect(RuntimeWireEventSchema.safeParse(event).success).toBe(true);
    expect(JSON.stringify(events)).not.toMatch(/private-(input|output|diff)/u);
  });

  // HERMES-CONTENT-01: the resume watermark covers an active tool start but provides no live tool inventory.
  it.each([true, false])("keeps a running resume partial and recovers only covered tool summaries (prefix retained: %s)", async covered => {
    const gateway = new GatewayFixture();
    gateway.handlers.set("session.resume", () => ({ ...snapshot(sessionId, nativeId), running: true, execution_generation: 2, last_sequence: 4 }));
    const replay = [frame(1, "tool.start", { tool_id: "previous", name: "read" }),
      frame(2, "message.start", {}, { execution_generation: 2 }),
      frame(3, "tool.start", { tool_id: "active", name: "read", args: "private-before-resume" }, { execution_generation: 2 }),
      frame(4, "message.delta", { text: "not from the snapshot" }, { execution_generation: 2 })];
    gateway.handlers.set("session.events.since", ({ last_sequence: since }) => ({
      events: since === 0 && covered ? replay : [], latest_seq: 4, replay_epoch: "replay-1", truncated: since === 0 && !covered,
    }));
    const { backend, events } = makeBackend(gateway);
    await backend.activate({ type: "resume", sessionId });
    const runtimeId = backend.directoryEntries()[0]!.runtimeId;
    await backend.handleGatewayEvent(frame(4, "message.delta", { text: "duplicate" }, { execution_generation: 2 }));
    preview(backend, runtimeId, "mounted");
    const mounted = events.find((event): event is Extract<RuntimeEvent, { type: "session.snapshot" }> =>
      event.type === "session.snapshot" && event.syncId === "mounted");
    expect(mounted?.live?.complete).toBe(false);
    expect(mounted?.live?.toolInventory?.totalCount ?? 0).toBe(covered ? 1 : 0);
    await backend.handleGatewayEvent(frame(5, "tool.progress", { tool_id: "active", name: "read", progress: 1, message: "private-progress" }, { execution_generation: 2 }));
    preview(backend, runtimeId, "progress");
    expect(events).toContainEqual(expect.objectContaining({ type: "session.tools.produced", page: expect.objectContaining({ tools: [
      expect.objectContaining({ phase: "running", tool: expect.objectContaining({ toolCallId: "active" }) }),
    ] }) }));
    expect(JSON.stringify(events)).not.toMatch(/private-before-resume|private-progress|not from the snapshot|"toolCallId":"previous"/u);
  });

  // HERMES-INTERACTION-01: an in-flight response cannot authorize a second option or be mistaken for native success.
  it("admits only explicit allow-once/deny and waits for the exact generation-bound receipt", async () => {
    const gateway = new GatewayFixture();
    gateway.handlers.set("session.resume", () => ({ ...snapshot(sessionId, nativeId), running: true, execution_generation: 1, prompts: [nativeApproval] }));
    const { backend, events } = makeBackend(gateway);
    await backend.activate({ type: "resume", sessionId });
    const runtimeId = backend.directoryEntries()[0]!.runtimeId;
    const request = events.find(event => event.type === "interaction.snapshot")?.requests[0];
    expect(request).toMatchObject({ kind: "select", options: [{ value: "once" }, { value: "deny" }] });
    const command = { type: "interaction.respond" as const, extensionId: "hermes", requestId: request!.requestId };
    let resolveReply!: (value: unknown) => void;
    const reply = new Promise<unknown>(resolve => { resolveReply = resolve; });
    gateway.handlers.set("approval.respond", () => reply);
    backend.dispatchCommand(runtimeId, "reject-escalation", { ...command, response: { kind: "select", value: "always" } });
    backend.dispatchCommand(runtimeId, "approve", { ...command, response: { kind: "select", value: "once" } });
    backend.dispatchCommand(runtimeId, "deny-twice", { ...command, response: { kind: "cancel" } });
    await backend.handleGatewayEvent(frame(1, "approval.settled", { prompt_id: nativeApproval.prompt_id, execution_generation: 1 }));
    expect(events.some(event => event.type === "interaction.resolved")).toBe(false);
    expect(gateway.calls.filter(call => call.method === "approval.respond")).toEqual([{ method: "approval.respond", params: {
      session_id: nativeId, execution_generation: 1, prompt_id: nativeApproval.prompt_id, choice: "once",
    } }]);
    resolveReply({ status: "resolved", prompt_id: nativeApproval.prompt_id });
    await vi.waitFor(() => expect(events).toContainEqual({ type: "command.result", commandId: "approve", ok: true, status: "success" }));
    expect(events).toContainEqual({ type: "interaction.resolved", requestId: request!.requestId, source: "remote" });
  });

  it("withdraws invalidated approvals and does not resend either an uncertain answer or an expired prompt", async () => {
    vi.useFakeTimers();
    try {
      const gateway = new GatewayFixture();
      const base = { ...snapshot(sessionId, nativeId), running: true, execution_generation: 1, prompts: [
        { ...nativeApproval, timeout_s: 10 }, { ...nativeApproval, prompt_id: "short-expiry", timeout_s: 1 },
      ] };
      gateway.handlers.set("session.resume", () => base);
      gateway.handlers.set("approval.respond", () => { throw new Error("connection lost after write"); });
      const { backend, events } = makeBackend(gateway);
      await backend.activate({ type: "resume", sessionId });
      const runtimeId = backend.directoryEntries()[0]!.runtimeId;
      const [first, second] = events.find(event => event.type === "interaction.snapshot")!.requests;
      const deny = (requestId: string, id: string) => backend.dispatchCommand(runtimeId, id, { type: "interaction.respond", extensionId: "hermes", requestId, response: { kind: "cancel" } });
      deny(first!.requestId, "first");
      await vi.advanceTimersByTimeAsync(1000);
      expect(events).toContainEqual(expect.objectContaining({ type: "command.result", commandId: "first", status: "unconfirmed" }));
      expect(events).toContainEqual({ type: "interaction.cancelled", requestId: second!.requestId, reason: "timeout" });
      gateway.handlers.set("session.resume", () => ({ ...base, replay_epoch: "replay-2", last_sequence: 1 }));
      await backend.handleGatewayEvent(frame(1, "session.info", {}, { replay_epoch: "replay-2" }));
      deny(first!.requestId, "retry-uncertain");
      deny(second!.requestId, "retry-expired");
      await vi.advanceTimersByTimeAsync(0);
      expect(gateway.calls.filter(call => call.method === "approval.respond")).toEqual([{ method: "approval.respond",
        params: { session_id: nativeId, execution_generation: 1, prompt_id: nativeApproval.prompt_id, choice: "deny" } }]);
    } finally { vi.useRealTimers(); }
  });

  it("never opens a replayed, already-settled card and uses native clarify choice values", async () => {
    const gateway = new GatewayFixture();
    gateway.handlers.set("session.resume", () => ({ ...snapshot(sessionId, nativeId), running: true, execution_generation: 1 }));
    const question = { kind: "clarify", prompt_id: "q-1", execution_generation: 1, question: "Which files?", choices: ["a,b", "x"], multi_select: true };
    gateway.handlers.set("session.events.since", () => ({ latest_seq: 3, replay_epoch: "replay-1", events: [
      frame(1, "approval.request", nativeApproval),
      frame(2, "approval.settled", { prompt_id: nativeApproval.prompt_id, execution_generation: 1 }),
      frame(3, "clarify.request", question),
    ] }));
    gateway.handlers.set("clarify.respond", () => ({ status: "resolved", prompt_id: "q-1" }));
    const { backend, events } = makeBackend(gateway);
    await backend.activate({ type: "resume", sessionId });
    await backend.handleGatewayEvent(frame(3, "clarify.request", question));
    expect(events.filter(event => event.type === "interaction.requested")).toEqual([]);
    const active = events.filter(event => event.type === "interaction.snapshot").at(-1)!.requests;
    expect(active).toEqual([expect.objectContaining({ title: question.question, kind: "multi-select" })]);
    backend.dispatchCommand(backend.directoryEntries()[0]!.runtimeId, "clarify", { type: "interaction.respond", extensionId: "hermes",
      requestId: active[0]!.requestId, response: { kind: "multi-select", values: ["choice-0", "choice-1"] } });
    expect(gateway.calls.at(-1)).toEqual({ method: "clarify.respond", params: { session_id: nativeId,
      execution_generation: 1, prompt_id: "q-1", answer: '["a,b","x"]' } });
  });

  // HERMES-CONFIG-01: the opaque value selects a provider+model pair; unrelated native settings never enter the wire.
  it("creates with an advertised model and waits for native readback before returning ready", async () => {
    const gateway = new GatewayFixture();
    gateway.handlers.set("model.options", () => ({ provider: "openai", model: "shared-model", providers: [
      { slug: "openai", name: "OpenAI", models: ["shared-model"], api_url: "https://private.example" },
      { slug: "custom:local", name: "Local", models: ["shared-model"] },
      { slug: "disabled", authenticated: false, models: ["disabled-model"] },
    ] }));
    gateway.handlers.set("session.create", () => snapshot(sessionId, nativeId));
    gateway.handlers.set("session.info", () => ({ provider: "custom:local", model: "shared-model", reasoning_effort: "low" }));
    const { backend } = makeBackend(gateway, { runtime: selectionRuntime });
    const catalog = SessionConfigurationCatalogSchema.parse(await backend.sessionConfiguration(tmpdir()));
    expect(catalog.models).toHaveLength(2);
    expect(catalog.defaults.model).toBe(catalog.models[0]!.value);
    expect(JSON.stringify(catalog)).not.toContain("private.example");
    expect(catalog.permissions).toEqual([]);
    const model = catalog.models[1]!.value;
    await expect(backend.activate({ type: "new", cwd: tmpdir() }, { launchId: "create-1", configuration: { model, thinking: "high" } }))
      .rejects.toMatchObject({ code: "configuration_stale" });
    expect(gateway.calls.some(call => call.method === "session.create")).toBe(false);
    await expect(backend.activate({ type: "new", cwd: tmpdir() }, { launchId: "create-2", configuration: { model } }))
      .resolves.toEqual({ sessionId, spawnMode: "headless" });
    expect(gateway.calls).toContainEqual({ method: "session.create", params: { source: "tui", cwd: tmpdir(),
      provider: "custom:local", model: "shared-model", request_id: "create-2" } });
    expect(backend.directoryEntries()[0]).toMatchObject({ model: { provider: "custom:local", id: "shared-model" }, thinkingLevel: "low" });
  });

  it("records a minted session without treating a mismatched model as ready or creating another session", async () => {
    const gateway = new GatewayFixture();
    gateway.handlers.set("model.options", () => ({ providers: [{ slug: "openai", models: ["expected"] }] }));
    gateway.handlers.set("session.create", () => snapshot(sessionId, nativeId));
    gateway.handlers.set("session.info", () => ({ provider: "openai", model: "unexpected" }));
    const { backend } = makeBackend(gateway, { runtime: selectionRuntime });
    const configuration = { model: (await backend.sessionConfiguration(tmpdir())).models[0]!.value };
    const onCreated = vi.fn();
    await expect(backend.activate({ type: "new", cwd: tmpdir() }, { launchId: "create", configuration, onCreated }))
      .rejects.toMatchObject({ code: "configuration_unconfirmed" });
    expect(onCreated).toHaveBeenCalledExactlyOnceWith({ sessionId, spawnMode: "headless" });
    expect(backend.directoryEntries()).toEqual([]);
    expect(gateway.calls.filter(call => call.method === "session.create")).toHaveLength(1);
    expect(gateway.calls.some(call => ["config.set", "prompt.submit", "session.mutate"].includes(call.method))).toBe(false);
  });

  const selection = { provider: "custom:fixture", model: "target" };
  const modelOptions = { providers: [{ slug: selection.provider, authenticated: true, models: [selection.model] }] };
  const initialModelSnapshot = { ...snapshot(sessionId, nativeId), revision: 10, execution_generation: 2 };
  const modelReceipt = { session_id: nativeId, operation: "model", revision: 11, execution_generation: 3, ...selection };

  function setupModel() {
    const gateway = new GatewayFixture();
    gateway.handlers.set("session.resume", () => initialModelSnapshot);
    gateway.handlers.set("model.options", () => modelOptions);
    return makeBackend(gateway, { runtime: selectionRuntime });
  }

  function switchModel(backend: HermesAgentBackend, runtimeId: string, commandId = "switch-model") {
    return backend.dispatchCommand(runtimeId, commandId, { type: "slash.execute", name: "model", args: hermesModelValue(selection) });
  }

  // HERMES-CONFIG-01: native notification and delayed readback can arrive in either order.
  it("fences a model change and waits for native readback before accepting the next prompt", async () => {
    const { gateway, backend, events } = setupModel();
    gateway.handlers.set("session.mutate", () => modelReceipt);
    let confirm!: (info: typeof selection) => void;
    gateway.handlers.set("session.info", () => new Promise<typeof selection>(resolve => { confirm = resolve; }));
    await backend.activate({ type: "resume", sessionId });
    const runtimeId = backend.directoryEntries()[0]!.runtimeId;
    preview(backend, runtimeId, "model-options");
    await vi.waitFor(() => expect(events).toContainEqual({ type: "runtime.capabilities", capabilities: { commands: [
      { name: "model", source: "builtin", argument: { kind: "select", required: true, options: [{ value: hermesModelValue(selection), label: "target · custom:fixture" }] } },
    ] } }));
    expect(switchModel(backend, runtimeId)).toBe("handled");
    const notification = backend.handleGatewayEvent(frame(1, "session.info", selection, { execution_generation: 3 }));
    await vi.waitFor(() => expect(confirm).toBeTypeOf("function"));
    expect(gateway.calls).toContainEqual({ method: "session.mutate", params: { session_id: nativeId, request_id: expect.any(String),
      operation: "model", expected_revision: 10, expected_generation: 2, payload: selection } });
    backend.dispatchCommand(runtimeId, "too-early", { type: "user_message", text: "Hold until readback" });
    expect(events).toContainEqual(expect.objectContaining({ type: "command.result", commandId: "too-early", status: "failure" }));
    expect(events.some(event => event.type === "command.result" && event.commandId === "switch-model")).toBe(false);
    expect(backend.directoryEntries()[0]?.model?.id).toBe("gpt-fixture");
    expect(gateway.calls.filter(call => call.method === "prompt.submit")).toHaveLength(0);
    confirm(selection);
    await notification;
    await vi.waitFor(() => expect(events).toContainEqual({ type: "command.result", commandId: "switch-model", ok: true, status: "success" }));
    expect(backend.directoryEntries()[0]?.model).toEqual({ provider: selection.provider, id: selection.model });
  });

  it.each([
    ["guarded selection", () => ({ ...modelReceipt, status: "confirmation_required", confirm: "private-confirm-token" })],
    ["native refusal", () => { throw new HermesGatewayRpcError("revision_conflict", 4001); }],
  ] as const)("does not retry or commit a %s", async (_kind, reply) => {
    const { gateway, backend, events } = setupModel();
    gateway.handlers.set("session.mutate", reply);
    await backend.activate({ type: "resume", sessionId });
    switchModel(backend, backend.directoryEntries()[0]!.runtimeId);
    await vi.waitFor(() => expect(events).toContainEqual(expect.objectContaining({ type: "command.result", commandId: "switch-model", ok: false, status: "failure" })));
    expect(gateway.calls.filter(call => call.method === "session.mutate")).toHaveLength(1);
    expect(gateway.calls.filter(call => call.method === "session.info")).toHaveLength(0);
    expect(backend.directoryEntries()[0]?.model?.id).toBe("gpt-fixture");
    expect(JSON.stringify(events)).not.toContain("private-confirm-token");
  });

  // Deferred writes and lost replies can commit later. Old or merely matching values with an old revision are not proof.
  it.each(["deferred", "lost write reply", "mismatched readback", "readback refusal"] as const)("keeps a %s fenced until a newer exact native snapshot", async failure => {
    const { gateway, backend, events } = setupModel();
    gateway.handlers.set("session.mutate", () => {
      if (failure === "lost write reply") throw new HermesGatewayRpcError("Connection closed");
      return failure === "deferred" ? { ...modelReceipt, status: "deferred", revision: 10 } : modelReceipt;
    });
    gateway.handlers.set("session.info", () => {
      if (failure === "readback refusal") throw new HermesGatewayRpcError("not_found", 4001);
      return initialModelSnapshot.info;
    });
    await backend.activate({ type: "resume", sessionId });
    const runtimeId = backend.directoryEntries()[0]!.runtimeId;
    switchModel(backend, runtimeId);
    await vi.waitFor(() => expect(events).toContainEqual(expect.objectContaining({ type: "command.result", commandId: "switch-model", ok: false, status: "unconfirmed" })));
    preview(backend, runtimeId, "old-readback");
    await vi.waitFor(() => expect(events).toContainEqual(expect.objectContaining({ type: "session.snapshot", syncId: "old-readback" })));
    expect(backend.directoryEntries()[0]?.model).toBeUndefined();
    gateway.handlers.set("session.resume", () => ({ ...initialModelSnapshot, info: { ...initialModelSnapshot.info, ...selection } }));
    preview(backend, runtimeId, "stale-match");
    await vi.waitFor(() => expect(events).toContainEqual(expect.objectContaining({ type: "session.snapshot", syncId: "stale-match" })));
    backend.dispatchCommand(runtimeId, "still-blocked", { type: "user_message", text: "Do not send under the wrong model" });
    expect(events).toContainEqual(expect.objectContaining({ type: "command.result", commandId: "still-blocked", status: "failure" }));
    expect(gateway.calls.filter(call => call.method === "prompt.submit")).toHaveLength(0);
    gateway.handlers.set("session.resume", () => ({ ...initialModelSnapshot, revision: 11, execution_generation: 3,
      info: { ...initialModelSnapshot.info, ...selection } }));
    preview(backend, runtimeId, "confirmed-native");
    await vi.waitFor(() => expect(events).toContainEqual(expect.objectContaining({ type: "session.snapshot", syncId: "confirmed-native" })));
    expect(backend.directoryEntries()[0]?.model).toEqual({ provider: selection.provider, id: selection.model });
    expect(gateway.calls.filter(call => call.method === "session.mutate")).toHaveLength(1);
  });
});
