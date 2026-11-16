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

  it("closes the phone card when the TUI ran the same tool call first, and leaves other calls pending", async () => {
    const events: RuntimeEvent[] = [];
    const bridge = new ClaudeHookBridge({ onEvent: (_runtimeId, event) => events.push(event) });
    const first = bridge.accept(permission());
    const other = bridge.accept({ ...permission(), tool_input: { command: "rm -rf build" } });
    await Promise.resolve();
    const [firstRequest, otherRequest] = events.filter((event): event is Extract<RuntimeEvent, { type: "interaction.requested" }> => event.type === "interaction.requested");
    // A different tool, or different arguments, is not the call that ran.
    bridge.resolveLocally("claude:session-1", "Read", { command: "echo ok" });
    bridge.resolveLocally("claude:session-1", "Bash", { command: "echo different" });
    expect(bridge.pendingRequests("claude:session-1")).toHaveLength(2);
    bridge.resolveLocally("claude:session-1", "Bash", { command: "echo ok", agentId: "main-loop-field" });
    await expect(first).resolves.toEqual({});
    expect(events).toContainEqual({ type: "interaction.resolved", requestId: firstRequest!.request.requestId, source: "local" });
    expect(bridge.pendingRequests("claude:session-1").map(request => request.requestId)).toEqual([otherRequest!.request.requestId]);
    // A late phone answer is refused; Claude already decided.
    expect(bridge.respond(firstRequest!.request.requestId, bridge.generation, { kind: "confirm", value: true })).toBe("conflict");
    bridge.resolveLocally("claude:session-1");
    await expect(other).resolves.toEqual({});
    expect(bridge.runtimeIds()).toEqual([]);
  });

  it("hands every pending question back to the TUI when the person asks to answer there", async () => {
    const events: RuntimeEvent[] = [];
    const bridge = new ClaudeHookBridge({ onEvent: (_runtimeId, event) => events.push(event) });
    const pending = bridge.accept(ask());
    await Promise.resolve();
    bridge.deferToLocal("claude:other");
    expect(bridge.pendingRequests("claude:session-1")).toHaveLength(1);
    bridge.deferToLocal("claude:session-1");
    await expect(pending).resolves.toEqual({});
    expect(events).toContainEqual(expect.objectContaining({ type: "interaction.resolved", source: "local" }));
  });
  // CLAUDE-QUESTION-RACE-02: a raced question is on the phone while the TUI dialog stays open. The same
  // call's classic Hook must not block it, and the phone answer is kept for polls until the call finishes.
  it("shows a raced question on the phone without blocking its classic Hook", async () => {
    const events: RuntimeEvent[] = [];
    const bridge = new ClaudeHookBridge({ onEvent: (_runtimeId, event) => events.push(event) });
    const raced = { sessionId: "session-1", cwd: "C:\\work", toolCallId: "toolu_q1", questions };
    expect(bridge.raceQuestion(raced)).toBe(true);
    expect(bridge.raceQuestion(raced)).toBe(true);
    const request = interaction(events).request;
    if (request.kind !== "questionnaire") throw new Error("expected questionnaire");
    expect(events.filter(event => event.type === "interaction.requested")).toHaveLength(1);
    expect(bridge.blockingRequestCount("claude:session-1")).toBe(0);
    expect(bridge.pendingRequests("claude:session-1")).toHaveLength(1);
    await expect(bridge.accept({ ...ask(), tool_use_id: "toolu_q1" })).resolves.toEqual({});

    const [first, second] = request.questions;
    if (first === undefined || second === undefined) throw new Error("expected two questions");
    expect(bridge.respond(request.requestId, bridge.generation, { kind: "questionnaire",
      answers: [{ id: first.id, values: ["prod"] }, { id: second.id, values: [], other: "none" }] })).toBe("accepted");
    // The answer is recorded once the settled Hook output resolves, before any later poll request.
    await new Promise(resolve => setImmediate(resolve));
    expect(bridge.questionAnswers("claude:session-1")).toEqual([{ toolCallId: "toolu_q1", answers: { "环境？": "prod", "备注？": "none" } }]);
    bridge.resolveLocally("claude:session-1", "AskUserQuestion", { questions }, undefined, "toolu_q1");
    expect(bridge.questionAnswers("claude:session-1")).toEqual([]);
  });

  // CLAUDE-QUESTION-RACE-01: a subagent question needs the Mods session as its parent and closes
  // only with that agent's finished call, not with a main-loop call of the same tool.
  it("races a subagent question under its parent Mods session", () => {
    const events: RuntimeEvent[] = [];
    const online = new Set<string>();
    const bridge = new ClaudeHookBridge({ hasSession: runtimeId => online.has(runtimeId), onEvent: (_runtimeId, event) => events.push(event) });
    const child = { sessionId: "session-1", cwd: "C:\\work", toolCallId: "toolu_child", agentId: "agent-1", questions };
    expect(bridge.raceQuestion(child)).toBe(true);
    expect(events).toEqual([]);
    online.add("claude:session-1");
    expect(bridge.raceQuestion({ ...child, toolCallId: "toolu_child_2" })).toBe(true);
    const requestId = interaction(events).request.requestId;
    bridge.resolveLocally("claude:session-1", "AskUserQuestion", { questions }, undefined, "toolu_child_2");
    expect(bridge.pendingRequests("claude:session-1")).toHaveLength(1);
    bridge.resolveLocally("claude:session-1", "AskUserQuestion", { questions }, "agent-1", "toolu_child_2");
    expect(events).toContainEqual({ type: "interaction.resolved", requestId, source: "local" });
    expect(bridge.pendingRequests("claude:session-1")).toEqual([]);
  });

  // CLAUDE-QUESTION-RACE-03: Claude Code 2.1.325 raises PermissionRequest for the open question dialog.
  // It must not become a second, answerless confirm card on the phone.
  it("leaves the AskUserQuestion permission prompt to the native dialog", async () => {
    const events: RuntimeEvent[] = [];
    const bridge = new ClaudeHookBridge({ onEvent: (_runtimeId, event) => events.push(event) });
    await expect(bridge.accept({ ...permission(), tool_name: "AskUserQuestion", tool_input: { questions } })).resolves.toEqual({});
    expect(events).toEqual([]);
  });

  // CLAUDE-QUESTION-RACE-01: the TUI answered first, so only that exact call's phone card closes as local;
  // a phone cancellation becomes a refusal and a lost plugin connection withdraws the card.
  it("closes a raced question answered in the TUI, and maps cancel and disconnect", async () => {
    const events: RuntimeEvent[] = [];
    const bridge = new ClaudeHookBridge({ onEvent: (_runtimeId, event) => events.push(event) });
    const base = { sessionId: "session-1", cwd: "C:\\work", questions };
    expect(bridge.raceQuestion({ ...base, toolCallId: "toolu_a" })).toBe(true);
    expect(bridge.raceQuestion({ ...base, toolCallId: "toolu_b" })).toBe(true);
    expect(bridge.raceQuestion({ ...base, toolCallId: "toolu_c" })).toBe(true);
    const [a, b] = events.filter(event => event.type === "interaction.requested").map(event => event.type === "interaction.requested" ? event.request.requestId : "");
    bridge.resolveLocally("claude:session-1", "AskUserQuestion", { questions }, undefined, "toolu_a");
    expect(events).toContainEqual({ type: "interaction.resolved", requestId: a, source: "local" });
    expect(bridge.pendingRequests("claude:session-1")).toHaveLength(2);

    expect(bridge.respond(b!, bridge.generation, { kind: "cancel" })).toBe("accepted");
    // The answer is recorded once the settled Hook output resolves, before any later poll request.
    await new Promise(resolve => setImmediate(resolve));
    expect(bridge.questionAnswers("claude:session-1")).toEqual([{ toolCallId: "toolu_b", deny: "Claude Code 问题已取消" }]);

    bridge.cancelRaced("claude:session-1");
    expect(events).toContainEqual(expect.objectContaining({ type: "interaction.cancelled", reason: "disconnected" }));
    expect(bridge.pendingRequests("claude:session-1")).toEqual([]);
    expect(bridge.questionAnswers("claude:session-1")).toEqual([]);
    expect(bridge.raceQuestion({ ...base, toolCallId: "toolu_bad", questions: [{ question: "?", options: [], allowNotes: true }] })).toBe(false);
  });
});
