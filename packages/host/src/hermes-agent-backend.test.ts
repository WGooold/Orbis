import { describe, expect, it, vi } from "vitest";
import { RuntimeCommandSchema, RuntimeEventSchema, RuntimeWireEventSchema, type RuntimeEvent } from "@orbis/protocol";
import { HermesAgentBackend } from "./hermes-agent-backend.js";
import type { HermesGatewayEndpoint, HermesGatewayRuntimeDescriptor } from "./hermes-gateway-bootstrap.js";
import type { HermesJsonObject } from "./hermes-gateway-rpc.js";

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

function snapshot(sessionId = "stored-session", gatewaySessionId = sessionId): Record<string, unknown> {
  return {
    session_id: gatewaySessionId,
    stored_session_id: sessionId,
    subscription_id: `sub-${gatewaySessionId}`,
    messages: [
      { role: "user", text: "Earlier question", row_id: 1, timestamp: 1_700_000_000 },
      { role: "assistant", text: "Earlier answer", row_id: 2, timestamp: 1_700_000_001 },
    ],
    info: { cwd: "/workspace/project", title: "Fixture session", provider: "openai", model: "gpt-fixture" },
    message_count: 2,
    running: false,
    execution_generation: 0,
    last_sequence: 0,
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
    if (method === "session.events.since") return { events: [], latest_seq: 0, last_sequence: 0, epoch: "replay-1", replay_epoch: "replay-1", truncated: false, snapshot_required: false } as T;
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

describe("HermesAgentBackend", () => {
  it("creates a Gateway-owned TUI session with a stable launch request id", async () => {
    const gateway = new GatewayFixture();
    gateway.handlers.set("session.create", () => snapshot("stored-created", "gateway-created"));
    const onCreated = vi.fn(async () => undefined);
    const { backend, events } = makeBackend(gateway);

    const activation = await backend.activate({ type: "new", cwd: "/tmp" }, { launchId: "launch-42", onCreated });

    expect(activation).toEqual({ sessionId: "stored-created", spawnMode: "headless" });
    expect(gateway.calls.find(call => call.method === "session.create")?.params).toMatchObject({
      source: "tui", cwd: "/tmp", request_id: "launch-42",
    });
    expect(onCreated).toHaveBeenCalledWith({ sessionId: "stored-created", spawnMode: "headless" });
    expect(backend.directoryEntries()).toMatchObject([{ sessionId: "stored-created", cwd: "/workspace/project", status: "idle" }]);
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
      { role: "assistant", text: "Done", row_id: 4, timestamp: 1_700_000_003 },
    ] }));
    const { backend, events } = makeBackend(gateway);
    const activation = await backend.activate({ type: "resume", sessionId: "stored-session" });
    const runtimeId = backend.directoryEntries()[0]!.runtimeId;

    backend.dispatchCommand(runtimeId, "sync-tools", RuntimeCommandSchema.parse({
      type: "session.sync", sessionId: activation.sessionId, syncId: "sync-tools", range: "preview",
    }));
    const emitted = events.find((event): event is Extract<RuntimeEvent, { type: "session.snapshot" }> =>
      event.type === "session.snapshot" && event.syncId === "sync-tools");
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
});
