import { describe, expect, it, vi } from "vitest";

import { ClaudeHookBridge, ClaudeHookInputError } from "./claude-hook-bridge.js";
import type { RuntimeEvent } from "@orbis/protocol";

const permission = (sessionId = "session-1") => ({
  hook_event_name: "PermissionRequest",
  session_id: sessionId,
  cwd: "C:\\work",
  tool_name: "Bash",
  tool_input: { command: "echo ok" },
});

const questions = [
  { question: "环境？", header: "env", options: [{ label: "dev", description: "开发环境" }, { label: "prod" }] },
  { question: "备注？", options: [], allowOther: true },
];

const ask = (sessionId = "session-1") => ({
  hook_event_name: "PreToolUse",
  session_id: sessionId,
  cwd: "C:\\work",
  tool_name: "AskUserQuestion",
  tool_input: { questions },
});

function interaction(events: RuntimeEvent[]): Extract<RuntimeEvent, { type: "interaction.requested" }> {
  const event = events.find((candidate): candidate is Extract<RuntimeEvent, { type: "interaction.requested" }> => candidate.type === "interaction.requested");
  if (event === undefined) throw new Error("interaction.requested not emitted");
  return event;
}

describe("ClaudeHookBridge", () => {
  it("holds PermissionRequest and returns the official allow decision", async () => {
    const events: RuntimeEvent[] = [];
    const bridge = new ClaudeHookBridge({ onEvent: (_runtimeId, event) => events.push(event) });
    const pending = bridge.accept(permission());
    await Promise.resolve();
    const request = interaction(events).request;
    expect(request.kind).toBe("confirm");
    expect(bridge.respond(request.requestId, bridge.generation, { kind: "confirm", value: true })).toBe("accepted");
    await expect(pending).resolves.toEqual({
      hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } },
    });
  });

  it("returns deny for a rejected permission and deduplicates the same response", async () => {
    const events: RuntimeEvent[] = [];
    const bridge = new ClaudeHookBridge({ onEvent: (_runtimeId, event) => events.push(event) });
    const pending = bridge.accept(permission());
    await Promise.resolve();
    const requestId = interaction(events).request.requestId;
    const response = { kind: "confirm" as const, value: false };
    expect(bridge.respond(requestId, bridge.generation, response)).toBe("accepted");
    expect(bridge.respond(requestId, bridge.generation, response)).toBe("duplicate");
    await expect(pending).resolves.toMatchObject({ hookSpecificOutput: { decision: { behavior: "deny" } } });
  });

  it("maps AskUserQuestion answers to the official PreToolUse updatedInput shape", async () => {
    const events: RuntimeEvent[] = [];
    const bridge = new ClaudeHookBridge({ onEvent: (_runtimeId, event) => events.push(event) });
    const pending = bridge.accept(ask());
    await Promise.resolve();
    const request = interaction(events).request;
    expect(request.kind).toBe("questionnaire");
    if (request.kind !== "questionnaire") throw new Error("expected questionnaire");
    const first = request.questions[0];
    const second = request.questions[1];
    if (first === undefined || second === undefined) throw new Error("expected two questions");
    expect(second).toMatchObject({ question: "备注？", allowOther: true, options: [] });
    expect(bridge.respond(request.requestId, bridge.generation, {
      kind: "questionnaire",
      answers: [
        { id: first.id, values: ["dev"] },
        { id: second.id, values: [], other: "临时环境" },
      ],
    })).toBe("accepted");
    await expect(pending).resolves.toEqual({ hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      updatedInput: { questions, answers: { "环境？": "dev", "备注？": "临时环境" } },
    } });
  });

  it("rejects incomplete or invalid questionnaire answers", async () => {
    const events: RuntimeEvent[] = [];
    const bridge = new ClaudeHookBridge({ onEvent: (_runtimeId, event) => events.push(event) });
    const pending = bridge.accept(ask());
    await Promise.resolve();
    const requestId = interaction(events).request.requestId;
    expect(bridge.respond(requestId, bridge.generation, { kind: "questionnaire", answers: [] })).toBe("conflict");
    expect(bridge.respond(requestId, bridge.generation, { kind: "confirm", value: true })).toBe("conflict");
    bridge.cancelRuntime("claude:session-1");
    await expect(pending).resolves.toEqual({});
  });

  it("defers to the native dialog on timeout and on an aborted Hook request", async () => {
    vi.useFakeTimers();
    try {
      const timeoutEvents: RuntimeEvent[] = [];
      const timeoutBridge = new ClaudeHookBridge({ timeoutMs: 10, onEvent: (_runtimeId, event) => timeoutEvents.push(event) });
      const timeoutPending = timeoutBridge.accept(permission());
      await vi.advanceTimersByTimeAsync(10);
      await expect(timeoutPending).resolves.toEqual({});
      expect(timeoutEvents).toContainEqual(expect.objectContaining({ type: "interaction.cancelled", reason: "timeout" }));

      const controller = new AbortController();
      const disconnectEvents: RuntimeEvent[] = [];
      const disconnectBridge = new ClaudeHookBridge({ onEvent: (_runtimeId, event) => disconnectEvents.push(event) });
      const disconnectPending = disconnectBridge.accept(permission("session-2"), controller.signal);
      await Promise.resolve();
      controller.abort();
      await expect(disconnectPending).resolves.toEqual({});
      expect(disconnectEvents).toContainEqual(expect.objectContaining({ type: "interaction.cancelled", reason: "disconnected" }));
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects malformed Hook payloads and stale generations", async () => {
    const bridge = new ClaudeHookBridge();
    await expect(bridge.accept({ hook_event_name: "PreToolUse", session_id: "s", tool_name: "AskUserQuestion", tool_input: { questions: [] } })).rejects.toBeInstanceOf(ClaudeHookInputError);
    await expect(bridge.accept({ ...permission(), tool_input: [] })).rejects.toBeInstanceOf(ClaudeHookInputError);
    await expect(bridge.accept({ ...ask(), tool_input: { questions: [{ question: "问题", options: [{ label: "是" }], allowNotes: true }] } })).rejects.toBeInstanceOf(ClaudeHookInputError);
    await expect(bridge.accept({ ...ask(), tool_input: { questions: [{ question: "问题", options: [{ label: "" }] }] } })).rejects.toBeInstanceOf(ClaudeHookInputError);
    await expect(bridge.accept({ ...permission(), session_id: "  " })).rejects.toBeInstanceOf(ClaudeHookInputError);
    const pending = bridge.accept(permission());
    await Promise.resolve();
    const requestId = [...(bridge.runtimeMetadata())][0]?.runtimeId;
    expect(requestId).toBe("claude:session-1");
    // The request is deliberately left unresolved; closing the bridge defers it to the native dialog.
    bridge.cancelRuntime(requestId!, "owner_closed");
    await expect(pending).resolves.toEqual({});
  });

  it("denies a question the phone explicitly cancelled", async () => {
    const events: RuntimeEvent[] = [];
    const bridge = new ClaudeHookBridge({ onEvent: (_runtimeId, event) => events.push(event) });
    const pending = bridge.accept(ask());
    await Promise.resolve();
    expect(bridge.respond(interaction(events).request.requestId, bridge.generation, { kind: "cancel" })).toBe("accepted");
    await expect(pending).resolves.toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
  });

  it("makes no decision and publishes nothing when no device can answer", async () => {
    const online = vi.fn();
    const events: RuntimeEvent[] = [];
    const bridge = new ClaudeHookBridge({ hasRemoteDevice: () => false, onRuntimeOnline: online, onEvent: (_id, event) => events.push(event) });
    await expect(bridge.accept(permission())).resolves.toEqual({});
    await expect(bridge.accept(ask())).resolves.toEqual({});
    expect(online).not.toHaveBeenCalled();
    expect(events).toEqual([]);
    expect(bridge.runtimeIds()).toEqual([]);
  });

  it("publishes the runtime only while interactions are pending and restores the Mods status", async () => {
    const events: RuntimeEvent[] = [];
    const offline = vi.fn();
    const bridge = new ClaudeHookBridge({ baseStatus: () => "running", onRuntimeOffline: offline,
      onEvent: (_id, event) => events.push(event) });
    const first = bridge.accept(permission());
    const second = bridge.accept(permission());
    await Promise.resolve();
    const [a, b] = events.filter((event): event is Extract<RuntimeEvent, { type: "interaction.requested" }> => event.type === "interaction.requested");
    expect(bridge.runtimeMetadata()).toMatchObject([{ runtimeId: "claude:session-1", status: "waiting_local_interaction" }]);
    bridge.respond(a!.request.requestId, bridge.generation, { kind: "confirm", value: true });
    await first;
    expect(bridge.runtimeIds()).toEqual(["claude:session-1"]);
    expect(offline).not.toHaveBeenCalled();
    bridge.respond(b!.request.requestId, bridge.generation, { kind: "confirm", value: true });
    await second;
    expect(bridge.runtimeIds()).toEqual([]);
    expect(offline).toHaveBeenCalledWith("claude:session-1", "interaction_settled");
    expect(events.filter(event => event.type === "runtime.status").at(-1)).toEqual({ type: "runtime.status", status: "running" });
    expect(events.some(event => event.type === "runtime.status" && event.status === "idle")).toBe(false);
  });
});
