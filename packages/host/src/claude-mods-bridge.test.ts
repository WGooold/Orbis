import { describe, expect, it, vi } from "vitest";

import { RuntimeEventSchema, type RuntimeEvent } from "@orbis/protocol";
import { CLAUDE_BRIDGE_CAPABILITIES, ClaudeModsBridge, type ClaudeModsBridgeOptions } from "./claude-mods-bridge.js";
import { ClaudeSessionHistory } from "./claude-session-history.js";

/** Never touches the real ~/.claude: an absent transcript is an empty, ready history. */
const noTranscript: NonNullable<ClaudeModsBridgeOptions["createHistory"]> = (sessionId, configDir, publish) =>
  new ClaudeSessionHistory(sessionId, configDir, publish, { locate: async () => undefined, settleTimeoutMs: 0 });

function bridgeWith(options: ClaudeModsBridgeOptions = {}): ClaudeModsBridge {
  return new ClaudeModsBridge({ createHistory: noTranscript, ...options });
}

function hello(overrides: Record<string, unknown> = {}) {
  return { type: "hello", instanceId: "instance-1", sessionId: "session-1", cwd: "C:\\work", claudeVersion: "2.1.310",
    bridgeVersion: "1", capabilities: CLAUDE_BRIDGE_CAPABILITIES, ...overrides };
}

function online(bridge: ClaudeModsBridge, input: unknown = hello()) {
  const result = bridge.hello(input);
  if (!result.ok) throw new Error(result.error);
  return result;
}

describe("ClaudeModsBridge", () => {
  it("validates the Claude version and every required native capability", () => {
    const bridge = bridgeWith();
    expect(bridge.hello(hello({ claudeVersion: "2.1.286" }))).toEqual({ ok: false, error: "claude_version_too_old:2.1.287" });
    expect(bridge.hello(hello({ claudeVersion: "dev-build-999" }))).toEqual({ ok: false, error: "invalid_hello" });
    expect(bridge.hello(hello({ capabilities: ["prompt.submit"] }))).toEqual({ ok: false, error: "missing_capability:turn.abort" });
    expect(bridge.hello(hello({ capabilities: ["turn.abort", "prompt.submit", "session.append", "turn.start", "turn.complete", "tool.call"] })))
      .toEqual({ ok: false, error: "missing_capability:turn.step.delta" });
    expect(bridge.hello(hello({ bridgeVersion: "2" }))).toEqual({ ok: false, error: "bridge_version_unsupported:1" });
  });

  it("keeps commands bound to a generation and requires a native result before retiring them", () => {
    const events: RuntimeEvent[] = [];
    const bridge = bridgeWith({ onEvent: (_id, event) => events.push(event) });
    const current = online(bridge);
    const runtimeId = current.runtimeId;
    expect(bridge.sendCommand(runtimeId, "message-1", { type: "user_message", text: "hello" })).toBe("accepted");
    expect(bridge.sendCommand(runtimeId, "message-1", { type: "user_message", text: "hello" })).toBe("accepted");
    expect(bridge.sendCommand(runtimeId, "message-1", { type: "user_message", text: "different" })).toBe("id_conflict");
    expect(bridge.poll(runtimeId, "stale-generation")).toEqual({ ok: false, error: "stale_generation" });
    expect(bridge.poll(runtimeId, current.generation)).toMatchObject({ ok: true, commands: [{ commandId: "message-1" }] });
    // Repeated polls are at-least-once; a successful HTTP response does not remove the native command.
    expect(bridge.poll(runtimeId, current.generation)).toMatchObject({ ok: true, commands: [{ commandId: "message-1" }] });
    expect(bridge.receiveEvent(runtimeId, "stale-generation", { type: "command.result", commandId: "message-1", ok: true, status: "success" })).toBe("stale");
    expect(bridge.poll(runtimeId, current.generation)).toMatchObject({ ok: true, commands: [{ commandId: "message-1" }] });
    expect(bridge.receiveEvent(runtimeId, current.generation, { type: "command.result", commandId: "message-1", ok: true, status: "success" })).toBe("accepted");
    expect(bridge.poll(runtimeId, current.generation)).toEqual({ ok: true, generation: current.generation, commands: [] });
    expect(events).toContainEqual({ type: "command.result", commandId: "message-1", ok: true, status: "success" });
  });

  it("rejects stop without an active native turn and acknowledges stop only on turn.complete", () => {
    const events: RuntimeEvent[] = [];
    const bridge = bridgeWith({ onEvent: (_id, event) => events.push(event) });
    const current = online(bridge);
    expect(bridge.sendCommand(current.runtimeId, "stop-early", { type: "stop" })).toBe("not_cancelable");
    expect(bridge.receiveEvent(current.runtimeId, current.generation, { type: "turn.start", turnId: "turn-1", startedAt: 100 })).toBe("accepted");
    expect(bridge.sendCommand(current.runtimeId, "stop-1", { type: "stop" })).toBe("accepted");
    expect(bridge.poll(current.runtimeId, current.generation)).toMatchObject({ commands: [{ commandId: "stop-1" }] });
    expect(bridge.receiveEvent(current.runtimeId, current.generation,
      { type: "command.result", commandId: "stop-1", ok: true, status: "success" })).toBe("invalid");
    expect(bridge.receiveEvent(current.runtimeId, current.generation, { type: "turn.complete", turnId: "turn-1", isAborted: true,
      reason: "aborted", durationMs: 25, answer: "" })).toBe("accepted");
    expect(events).toContainEqual({ type: "command.result", commandId: "stop-1", ok: true, status: "success" });
    expect(bridge.poll(current.runtimeId, current.generation)).toMatchObject({ commands: [] });
    expect(events.every(event => RuntimeEventSchema.safeParse(event).success)).toBe(true);
    const patches = events.filter(event => event.type === "session.patch").length;
    expect(bridge.receiveEvent(current.runtimeId, current.generation, { type: "turn.complete", turnId: "turn-1", isAborted: true,
      reason: "aborted", durationMs: 25, answer: "" })).toBe("accepted");
    // A replayed turn.complete only replays the stop result; it is not a new turn transition.
    expect(events.filter(event => event.type === "session.patch")).toHaveLength(patches);
    expect(events.filter(event => event.type === "command.result" && event.commandId === "stop-1")).toHaveLength(2);
  });

  it("publishes streamed output as versioned live state and never turns prompt.submit or session.append into messages", () => {
    const events: RuntimeEvent[] = [];
    const bridge = bridgeWith({ onEvent: (_id, event) => events.push(event) });
    const current = online(bridge);
    expect(bridge.receiveEvent(current.runtimeId, current.generation, { type: "prompt.submit", text: "hello", origin: "composer", wait: false })).toBe("accepted");
    expect(bridge.receiveEvent(current.runtimeId, current.generation, { type: "turn.start", turnId: "turn-1", startedAt: 10 })).toBe("accepted");
    expect(bridge.receiveEvent(current.runtimeId, current.generation, { type: "turn.step.chunks", turnId: "turn-1", stepIndex: 2,
      chunks: [{ blockIndex: 0, contentType: "text", delta: "Hello" }, { blockIndex: 0, contentType: "text", delta: " world" }] })).toBe("accepted");
    expect(bridge.receiveEvent(current.runtimeId, current.generation, { type: "session.append", uuid: "native-row-1", door: "reply" })).toBe("accepted");
    expect(events.some(event => event.type.startsWith("message.") || event.type.startsWith("turn."))).toBe(false);
    const live = events.filter((event): event is Extract<RuntimeEvent, { type: "session.patch" }> => event.type === "session.patch").at(-1)?.live;
    expect(live?.turn).toMatchObject({ turnId: "turn-1", startedAt: 10 });
    expect(live?.messages).toMatchObject([{ message: { messageId: "turn-1:2", role: "assistant", content: [{ type: "text", text: "Hello world" }] } }]);
    expect(events.every(event => RuntimeEventSchema.safeParse(event).success)).toBe(true);
  });

  it("answers session.sync only for the attached Session", async () => {
    const bridge = bridgeWith();
    const current = online(bridge);
    const request = { type: "session.sync" as const, sessionId: "session-1", syncId: "sync-1", range: "preview" as const };
    await expect(bridge.sync(current.runtimeId, { ...request, sessionId: "other" })).resolves.toBeUndefined();
    await expect(bridge.sync(current.runtimeId, request)).resolves.toMatchObject({ type: "session.snapshot", sessionId: "session-1", syncId: "sync-1", entries: [] });
  });

  it("retires queued commands with an unknown-delivery failure when the bridge disconnects or reconnects", () => {
    const events: RuntimeEvent[] = [];
    const bridge = bridgeWith({ onEvent: (_id, event) => events.push(event) });
    const first = online(bridge);
    bridge.sendCommand(first.runtimeId, "message-1", { type: "user_message", text: "hello" });
    const second = online(bridge);
    expect(events).toContainEqual({ type: "command.result", commandId: "message-1", ok: false, status: "failure",
      error: "claude_bridge_disconnected_result_unknown" });
    expect(bridge.poll(second.runtimeId, second.generation)).toMatchObject({ ok: true, commands: [] });
    bridge.sendCommand(second.runtimeId, "message-2", { type: "user_message", text: "again" });
    bridge.disconnect(second.runtimeId);
    expect(events).toContainEqual(expect.objectContaining({ type: "command.result", commandId: "message-2", ok: false }));
  });

  it("disconnects the previous Session when the same Mods instance changes session and expires silent clients", () => {
    const offline = vi.fn();
    const bridge = bridgeWith({ onRuntimeOffline: offline });
    const first = online(bridge);
    const second = online(bridge, hello({ sessionId: "session-2" }));
    expect(bridge.runtimeIds()).toEqual([second.runtimeId]);
    expect(offline).toHaveBeenCalledWith(first.runtimeId, "session_changed");
    expect(bridge.expireStale(Date.now() + 20_000, 15_000)).toBe(1);
    expect(bridge.isOnline(second.runtimeId)).toBe(false);
  });

  it("rejects malformed event payloads and bounds the pending queue", () => {
    const bridge = bridgeWith();
    const current = online(bridge);
    expect(bridge.receiveRequest({ runtimeId: current.runtimeId, generation: current.generation, event: { type: "nope" } })).toBe("invalid");
    for (let index = 0; index < 64; index++) expect(bridge.sendCommand(current.runtimeId, `c-${index}`, { type: "user_message", text: "x" })).toBe("accepted");
    expect(bridge.sendCommand(current.runtimeId, "overflow", { type: "user_message", text: "x" })).toBe("queue_full");
  });
});
