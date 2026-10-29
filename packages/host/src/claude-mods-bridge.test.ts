import { describe, expect, it, vi } from "vitest";

import { RuntimeEventSchema, type RuntimeEvent } from "@orbis/protocol";
import { CLAUDE_BRIDGE_CAPABILITIES, ClaudeModsBridge, claudeCapabilities, type ClaudeModsBridgeOptions } from "./claude-mods-bridge.js";
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
  it("advertises Host-owned quit only after process identity is verified and shares concurrent closes", async () => {
    let finish!: () => void;
    const stopped = new Promise<void>(resolve => { finish = resolve; });
    const identity = { pid: 4242, started: "start-1", executable: "claude", command: "claude" };
    const terminate = vi.fn(() => stopped);
    const bridge = bridgeWith({ processControl: { capture: async () => identity, terminate } });
    const current = online(bridge, hello({ processId: 4242 }));
    expect(bridge.hasCommand(current.runtimeId, "quit")).toBe(false);
    await Promise.resolve();
    expect(bridge.hasCommand(current.runtimeId, "quit")).toBe(true);
    const first = bridge.quit(current.runtimeId), duplicate = bridge.quit(current.runtimeId);
    expect(terminate).toHaveBeenCalledTimes(1);
    expect(bridge.isOnline(current.runtimeId)).toBe(true);
    finish(); await Promise.all([first, duplicate]);
    bridge.close();
  });

  it("does not publish a delayed process identity into a replacement generation", async () => {
    let finish!: (value: { pid: number; started: string; executable: string; command: string }) => void;
    const capture = new Promise<{ pid: number; started: string; executable: string; command: string }>(resolve => { finish = resolve; });
    const bridge = bridgeWith({ processControl: { capture: () => capture, terminate: vi.fn() } });
    const current = online(bridge, hello({ processId: 4242 }));
    online(bridge, hello());
    finish({ pid: 4242, started: "old", executable: "claude", command: "claude" });
    await Promise.resolve();
    expect(bridge.hasCommand(current.runtimeId, "quit")).toBe(false);
    await expect(bridge.quit(current.runtimeId)).rejects.toThrow("无法核对");
    bridge.close();
  });
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

  it("publishes the TUI's model, effort, context and slash menu as metadata and capabilities", () => {
    const events: RuntimeEvent[] = [];
    const bridge = bridgeWith({ onEvent: (_id, event) => events.push(event) });
    const current = online(bridge);
    expect(bridge.receiveEvent(current.runtimeId, current.generation, { type: "session.state", state: {
      model: "claude-opus-5-5", modelName: "Opus 5.5", modelOptions: ["default", "sonnet", "opus"], modelSetting: "opus", effort: "xhigh",
      context: { tokens: 50_000, window: 200_000, percent: 25 },
      commands: [{ name: "compact", description: "Free up context", source: "builtin" }, { name: "config", description: "Open settings", source: "builtin" },
        { name: "pdf", description: "PDF skill", source: "user" }, { name: "diff", description: "Toggle diff", source: "plugin" },
        { name: "orbis-local", description: "ours", source: "plugin" }, { name: "model", description: "Set model", source: "builtin" }],
    } })).toBe("accepted");
    const metadata = events.filter(event => event.type === "runtime.metadata").at(-1);
    expect(metadata).toMatchObject({ metadata: { runtimeId: current.runtimeId, model: { provider: "claude-code", id: "claude-opus-5-5", name: "Opus 5.5" },
      thinkingLevel: "xhigh", contextUsage: { tokens: 50_000, contextWindow: 200_000, percent: 25 } } });
    const capabilities = events.filter(event => event.type === "runtime.capabilities").at(-1);
    expect(capabilities).toMatchObject({ capabilities: { commands: [
      { name: "model", argument: { kind: "select", options: [{ value: "default" }, { value: "sonnet" }, { value: "opus", description: "当前设置" }] } },
      { name: "effort", argument: { kind: "select" } },
      { name: "compact", source: "builtin" }, { name: "pdf", source: "prompt" }, { name: "diff", source: "extension" },
    ] } });
    expect((capabilities as Extract<RuntimeEvent, { type: "runtime.capabilities" }>).capabilities.commands.map(command => command.name))
      .toEqual(["model", "effort", "compact", "pdf", "diff"]);
    expect(events.every(event => RuntimeEventSchema.safeParse(event).success)).toBe(true);
    // An unchanged report publishes nothing new.
    const count = events.length;
    bridge.receiveEvent(current.runtimeId, current.generation, { type: "session.state", state: { effort: "xhigh" } });
    expect(events).toHaveLength(count);
    expect(bridge.hasCommand(current.runtimeId, "compact")).toBe(true);
    expect(bridge.hasCommand(current.runtimeId, "config")).toBe(false);
    expect(bridge.receiveEvent(current.runtimeId, current.generation, { type: "session.state", state: { commands: "nope" } })).toBe("invalid");
  });

  it("queues slash commands for the TUI and reports compaction as execution activity", () => {
    const events: RuntimeEvent[] = [];
    const bridge = bridgeWith({ onEvent: (_id, event) => events.push(event) });
    const current = online(bridge);
    expect(bridge.sendCommand(current.runtimeId, "slash-1", { type: "slash", name: "compact", args: "keep the plan" })).toBe("accepted");
    expect(bridge.poll(current.runtimeId, current.generation)).toMatchObject({ commands: [{ commandId: "slash-1", command: { type: "slash", name: "compact" } }] });
    expect(bridge.receiveEvent(current.runtimeId, current.generation, { type: "compaction", phase: "running" })).toBe("accepted");
    expect(events.at(-1)).toEqual({ type: "execution.activity", retry: "unavailable", compaction: { phase: "running" } });
    expect(bridge.receiveEvent(current.runtimeId, current.generation, { type: "command.result", commandId: "slash-1", ok: true, status: "success",
      result: { text: "Compacted" } })).toBe("accepted");
    expect(events).toContainEqual({ type: "command.result", commandId: "slash-1", ok: true, status: "success", result: { text: "Compacted" } });
    expect(bridge.activity(current.runtimeId)).toMatchObject({ compaction: { phase: "running" } });
  });

  it("matches a TUI the Host opened by its launch id", async () => {
    const bridge = bridgeWith();
    const waiting = bridge.waitForLaunch("launch-1", 1_000);
    online(bridge, hello({ sessionId: "other" }));
    online(bridge, hello({ instanceId: "instance-2", sessionId: "launched", launchId: "launch-1" }));
    await expect(waiting).resolves.toMatchObject({ runtimeId: "claude:launched", sessionId: "launched" });
    await expect(bridge.waitForLaunch("never", 5)).resolves.toBeUndefined();
  });

  it("tells the Hook side when the TUI ran a tool or ended a turn, and when the person takes interactions back", () => {
    const finished = vi.fn();
    const turns = vi.fn();
    const local = vi.fn();
    const bridge = bridgeWith({ onToolFinished: finished, onTurnFinished: turns, onLocalInteractions: local, pendingInteractions: () => 2 });
    const current = online(bridge);
    bridge.receiveEvent(current.runtimeId, current.generation, { type: "turn.start", turnId: "t1" });
    bridge.receiveEvent(current.runtimeId, current.generation, { type: "tool.started", toolCallId: "toolu_1", toolName: "Bash", arguments: { command: "ls" } });
    bridge.receiveEvent(current.runtimeId, current.generation, { type: "tool.finished", toolCallId: "toolu_1", toolName: "Bash", result: "a" });
    expect(finished).toHaveBeenCalledWith(current.runtimeId, "Bash", { command: "ls" });
    bridge.receiveEvent(current.runtimeId, current.generation, { type: "interactions.local" });
    expect(local).toHaveBeenCalledWith(current.runtimeId);
    expect(bridge.poll(current.runtimeId, current.generation)).toMatchObject({ pendingInteractions: 2 });
    bridge.receiveEvent(current.runtimeId, current.generation, { type: "turn.complete", turnId: "t1" });
    expect(turns).toHaveBeenCalledWith(current.runtimeId);
  });

  it("reports why a hello was refused", () => {
    const rejected = vi.fn();
    const bridge = bridgeWith({ onRejected: rejected });
    bridge.hello(hello({ claudeVersion: "2.1.200" }));
    expect(rejected).toHaveBeenCalledWith("claude_version_too_old:2.1.287", expect.objectContaining({ claudeVersion: "2.1.200", sessionId: "session-1" }));
  });

  it("keeps the effort choice even before the TUI reports its model list", () => {
    expect(claudeCapabilities({}).commands.map(command => command.name)).toEqual(["effort"]);
  });
});
