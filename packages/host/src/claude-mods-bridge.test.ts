import { describe, expect, it, vi } from "vitest";

import { RuntimeEventSchema, type RuntimeEvent } from "@orbis/protocol";
import { CLAUDE_BRIDGE_CAPABILITIES, ClaudeModsBridge } from "./claude-mods-bridge.js";

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
    const bridge = new ClaudeModsBridge();
    expect(bridge.hello(hello({ claudeVersion: "2.1.286" }))).toEqual({ ok: false, error: "claude_version_too_old:2.1.287" });
    expect(bridge.hello(hello({ claudeVersion: "dev-build-999" }))).toEqual({ ok: false, error: "invalid_hello" });
    expect(bridge.hello(hello({ capabilities: ["prompt.submit"] }))).toEqual({ ok: false, error: "missing_capability:turn.abort" });
    expect(bridge.hello(hello({ capabilities: ["turn.abort", "prompt.submit", "session.append", "turn.start", "turn.complete", "tool.call"] })))
      .toEqual({ ok: false, error: "missing_capability:turn.step.delta" });
    expect(bridge.hello(hello({ bridgeVersion: "2" }))).toEqual({ ok: false, error: "bridge_version_unsupported:1" });
  });

  it("keeps commands bound to a generation and requires a native result before retiring them", () => {
    const events: RuntimeEvent[] = [];
    const bridge = new ClaudeModsBridge({ onEvent: (_id, event) => events.push(event) });
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
    const bridge = new ClaudeModsBridge({ onEvent: (_id, event) => events.push(event) });
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
    expect(events.some(event => event.type === "turn.finished" && event.turnId === "turn-1")).toBe(true);
    expect(events.every(event => RuntimeEventSchema.safeParse(event).success)).toBe(true);
    expect(bridge.receiveEvent(current.runtimeId, current.generation, { type: "turn.complete", turnId: "turn-1", isAborted: true,
      reason: "aborted", durationMs: 25, answer: "" })).toBe("accepted");
    expect(events.filter(event => event.type === "turn.finished" && event.turnId === "turn-1")).toHaveLength(1);
    expect(events.filter(event => event.type === "command.result" && event.commandId === "stop-1")).toHaveLength(2);
  });

  it("maps canonical session rows and streamed text without making prompt.submit a duplicate message", () => {
    const events: RuntimeEvent[] = [];
    const bridge = new ClaudeModsBridge({ onEvent: (_id, event) => events.push(event) });
    const current = online(bridge);
    expect(bridge.receiveEvent(current.runtimeId, current.generation, { type: "prompt.submit", text: "hello", origin: "composer", wait: false })).toBe("accepted");
    expect(events.some(event => event.type === "message.finished")).toBe(false);
    expect(bridge.receiveEvent(current.runtimeId, current.generation, { type: "turn.start", turnId: "turn-1", startedAt: 10 })).toBe("accepted");
    expect(bridge.receiveEvent(current.runtimeId, current.generation, { type: "turn.step.chunks", turnId: "turn-1", stepIndex: 2,
      chunks: [{ blockIndex: 0, contentType: "text", delta: "Hello" }, { blockIndex: 0, contentType: "text", delta: " world" }] })).toBe("accepted");
    expect(bridge.receiveEvent(current.runtimeId, current.generation, { type: "session.append", uuid: "native-row-1", door: "reply",
      message: { type: "assistant", role: "assistant", content: [{ type: "text", text: "Hello world" }] } })).toBe("accepted");
    expect(bridge.receiveEvent(current.runtimeId, current.generation, { type: "turn.complete", turnId: "turn-1", durationMs: 20,
      answer: "Hello world", reason: "answer", isAborted: false })).toBe("accepted");
    expect(events).toContainEqual({ type: "message.started", message: { messageId: "turn-1:2", role: "assistant", content: [], timestamp: expect.any(Number) } });
    expect(events).toContainEqual({ type: "message.delta", messageId: "turn-1:2", contentType: "text", contentIndex: 0, delta: "Hello" });
    expect(events).toContainEqual({ type: "message.delta", messageId: "turn-1:2", contentType: "text", contentIndex: 0, delta: " world" });
    expect(events).toContainEqual(expect.objectContaining({ type: "turn.finished", persistedMessages: [{ messageId: "turn-1:2", entryId: "native-row-1" }] }));
    expect(events.filter(event => event.type === "message.finished")).toHaveLength(1);
    expect(events.every(event => RuntimeEventSchema.safeParse(event).success)).toBe(true);
  });

  it("disconnects the previous Session when the same Mods instance changes session and expires silent clients", () => {
    const offline = vi.fn();
    const bridge = new ClaudeModsBridge({ onRuntimeOffline: offline });
    const first = online(bridge);
    const second = online(bridge, hello({ sessionId: "session-2" }));
    expect(bridge.runtimeIds()).toEqual([second.runtimeId]);
    expect(offline).toHaveBeenCalledWith(first.runtimeId, "session_changed");
    expect(bridge.expireStale(Date.now() + 20_000, 15_000)).toBe(1);
    expect(bridge.isOnline(second.runtimeId)).toBe(false);
  });

  it("rejects malformed event payloads and bounds the pending queue", () => {
    const bridge = new ClaudeModsBridge();
    const current = online(bridge);
    expect(bridge.receiveRequest({ runtimeId: current.runtimeId, generation: current.generation, event: { type: "nope" } })).toBe("invalid");
    for (let index = 0; index < 64; index++) expect(bridge.sendCommand(current.runtimeId, `c-${index}`, { type: "user_message", text: "x" })).toBe("accepted");
    expect(bridge.sendCommand(current.runtimeId, "overflow", { type: "user_message", text: "x" })).toBe("queue_full");
  });
});
