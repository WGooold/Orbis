import { afterEach, describe, expect, it, vi } from "vitest";
import { RuntimeEventSchema, type InteractionRequest, type InteractionResponse, type RuntimeEvent } from "@pi-remote/protocol";
import { CodexAsyncInputs, codexQuestionReplyText } from "./codex-async-input.js";
import { CodexRuntime } from "./codex-runtime.js";
import type { CodexAppServer } from "./codex-daemon.js";

const question = { type: "agentMessage", id: "question-item", delivery: "async", text: "请回答以下问题", questions: [
  { title: "需要修复哪些端？", options: ["App 和 Host（推荐）", "仅 App"] },
  { title: "还有哪些要求？", options: null },
] };
const questionId = (index: number) => JSON.stringify(["request_user_input_async", question.id, index]);
const reply = (index = 0, answer = "仅 App") => `<send_user_message_question_reply>\n${JSON.stringify([
  { questionItemId: questionId(index), question: question.questions[index]!.title, answer },
])}\n</send_user_message_question_reply>`;
const nativeAnswer = (text: string, id = "answer") => ({ type: "userMessage", id, content: [{ type: "text", text }] });
const choose = (index = "0") => ({ kind: "questionnaire" as const, answers: [{ id: "0", values: [index] }] });
const cleanups: Array<() => void> = [];
afterEach(() => { cleanups.splice(0).forEach(fn => fn()); vi.useRealTimers(); });

async function harness(turns: unknown[] = []) {
  const events: RuntimeEvent[] = [];
  const request = vi.fn(async (method: string, params: Record<string, unknown>) => {
    if (method === "thread/resume") return { thread: { id: params.threadId, cwd: "D:/test", turns: [] }, model: "test" };
    if (method === "thread/turns/list") return { data: turns };
    if (method === "turn/start" || method === "turn/steer") return { turn: { id: "next" } };
    return { data: [] };
  });
  const server = { mode: "external", request } as unknown as CodexAppServer;
  const runtime = new CodexRuntime({ server, onEvent: event => events.push(event), rolloutRoot: "D:/not-existing-async-input-rollouts" });
  runtime.seedDesktopThreads(["a", "b"]);
  cleanups.push(() => server.onExit?.(0));
  await runtime.activate({ type: "resume", sessionId: "codex-desktop:a" });
  const notify = (method: string, params: Record<string, unknown>) => server.onNotification?.(method, { threadId: "a", ...params });
  const prompts = () => events.flatMap(e => e.type === "interaction.requested" ? [e.request] : []);
  const answer = (prompt: InteractionRequest, response: InteractionResponse = choose(), commandId = "answer-1", runtimeId = "codex-desktop:a") => {
    runtime.dispatchCommand(runtimeId, commandId, { type: "interaction.respond", requestId: prompt.requestId, extensionId: "codex", response });
  };
  return { events, request, runtime, server, notify, prompts, answer, replaceTurns: (next: unknown[]) => { turns = next; } };
}

describe("Codex desktop async user input", () => {
  it("forwards native questions/options with free text and restores them through session sync", async () => {
    const h = await harness();
    h.notify("item/completed", { turnId: "turn-1", item: question });
    expect(h.prompts()).toHaveLength(2);
    const first = h.prompts()[0]!;
    expect(first).toMatchObject({ kind: "questionnaire", runtimeId: "codex-desktop:a", extensionId: "codex",
      expiresAt: Number.MAX_SAFE_INTEGER, questions: [{ id: "0", question: "需要修复哪些端？", allowOther: true,
        options: [{ value: "0", label: "App 和 Host（推荐）" }, { value: "1", label: "仅 App" }],
      }],
    });
    expect(h.prompts()[1]).toMatchObject({ questions: [{ id: "1", options: [], allowOther: true }] });
    h.runtime.handleCommand({ type: "session.sync", sessionId: "codex-desktop:a", syncId: "sync", range: "preview" }, "sync", "a");
    expect(h.events).toContainEqual({ type: "interaction.snapshot", requests: h.prompts().map(p => ({ ...p, submitted: false })) });
    expect(h.events.some(e => e.type === "message.finished" && JSON.stringify(e).includes("需要修复哪些端"))).toBe(true);
    expect(h.events.some(e => e.type === "message.finished" && JSON.stringify(e).includes("App 和 Host（推荐）"))).toBe(true);
    h.events.forEach(event => expect(RuntimeEventSchema.safeParse(event).success).toBe(true));
  });

  it("uses same-turn steering for answers while desktop work continues, without interrupting it", async () => {
    const h = await harness();
    h.notify("turn/started", { turn: { id: "turn-1", startedAt: 1_800_000_000 } });
    h.notify("item/completed", { turnId: "turn-1", item: question });
    const prompt = h.prompts()[0]!;
    h.answer(prompt, choose("1"));
    h.answer(prompt, choose("1"), "retry");
    await vi.waitFor(() => expect(h.request).toHaveBeenCalledWith("turn/steer", {
      threadId: "a", expectedTurnId: "turn-1", input: [{ type: "text", text: reply() }], clientUserMessageId: prompt.requestId,
    }));
    expect(h.request.mock.calls.filter(([method]) => method === "turn/steer")).toHaveLength(1);
    expect(h.request.mock.calls.some(([method]) => method === "turn/interrupt")).toBe(false);
    h.notify("item/completed", { turnId: "turn-1", item: nativeAnswer(reply()) });
    expect(h.events).toContainEqual({ type: "interaction.resolved", requestId: prompt.requestId, source: "remote" });
    expect(h.events).toContainEqual({ type: "command.result", commandId: "retry", ok: true });
  });

  it("starts a turn for an idle answer and sends free text with the desktop question ID", async () => {
    const h = await harness([{ id: "turn-1", status: "completed", items: [question] }]);
    const prompt = h.prompts()[1]!;
    h.answer(prompt, { kind: "questionnaire", answers: [{ id: "1", values: [], other: "保留当前连接" }] });
    await vi.waitFor(() => expect(h.request).toHaveBeenCalledWith("turn/start", expect.objectContaining({
      threadId: "a", input: [{ type: "text", text: reply(1, "保留当前连接") }],
    })));
  });

  it("keeps async questions after turn completion and beyond the approval TTL", async () => {
    vi.useFakeTimers();
    const h = await harness();
    h.notify("item/completed", { turnId: "turn-1", item: question });
    h.notify("turn/completed", { turn: { id: "turn-1", status: "completed" } });
    await vi.advanceTimersByTimeAsync(600_000);
    h.runtime.announce("a");
    expect(h.events).toContainEqual({ type: "interaction.snapshot", requests: h.prompts().map(p => ({ ...p, submitted: false })) });
  });

  it("clears a desktop answer and avoids replaying already answered questions on Host attach", async () => {
    const h = await harness([{ id: "turn-1", status: "completed", items: [question, nativeAnswer(reply())] }]);
    expect(h.prompts()).toHaveLength(1);
    expect(h.prompts()[0]).toMatchObject({ questions: [{ id: "1" }] });
    h.notify("item/completed", { turnId: "turn-2", item: nativeAnswer(reply(1, "保留数据"), "answer-2") });
    expect(h.events).toContainEqual({ type: "interaction.resolved", requestId: h.prompts()[0]!.requestId, source: "local" });
    h.runtime.announce("a");
    expect(h.events).toContainEqual({ type: "interaction.snapshot", requests: [] });
  });

  it("rejects forged answers and cross-thread requests without sending any turn RPC", async () => {
    const h = await harness([{ id: "turn-1", status: "completed", items: [question] }]);
    await h.runtime.activate({ type: "resume", sessionId: "codex-desktop:b" });
    const prompt = h.prompts()[0]!;
    h.answer(prompt, choose("999"));
    h.answer(prompt, choose(), "other-thread", "codex-desktop:b");
    expect(h.events.filter(e => e.type === "command.result" && !e.ok)).toHaveLength(2);
    expect(h.request.mock.calls.some(([method]) => method === "turn/start" || method === "turn/steer")).toBe(false);
  });

  it("leaves failed submissions editable and retries delivery", async () => {
    const h = await harness([{ id: "turn-1", status: "completed", items: [question] }]);
    const original = h.request.getMockImplementation()!;
    h.request.mockImplementationOnce(async () => { throw new Error("temporary failure"); });
    const prompt = h.prompts()[0]!;
    h.answer(prompt);
    await vi.waitFor(() => expect(h.events).toContainEqual({ type: "command.result", commandId: "answer-1", ok: false, error: "temporary failure" }));
    h.request.mockImplementation(original);
    h.answer(prompt, choose("1"), "retry");
    await vi.waitFor(() => expect(h.events).toContainEqual({ type: "command.result", commandId: "retry", ok: true }));
  });
});

describe("native async question reconciliation", () => {
  it("does not replay an accepted answer before its native user item arrives", async () => {
    const events: RuntimeEvent[] = [];
    const state = new CodexAsyncInputs("codex-desktop:a", e => events.push(e));
    state.replace([question]);
    const id = state.snapshot()[0]!.requestId;
    const send = vi.fn(async () => {});
    state.respond(id, choose(), "first", send);
    await vi.waitFor(() => expect(events).toContainEqual({ type: "interaction.resolved", requestId: id, source: "remote" }));
    state.replace([question]);
    expect(state.snapshot()).toHaveLength(1);
    state.respond(id, choose(), "retry", send);
    expect(send).toHaveBeenCalledTimes(1);
    expect(events).toContainEqual({ type: "command.result", commandId: "retry", ok: true });
  });

  it("restores questions when revert removes an answer and cancels removed questions", () => {
    const events: RuntimeEvent[] = [];
    const state = new CodexAsyncInputs("codex-desktop:a", e => events.push(e));
    state.replace([question]);
    const id = state.snapshot()[0]!.requestId;
    state.replace([question, nativeAnswer(reply())]);
    expect(state.snapshot()).toHaveLength(1);
    state.replace([question]);
    expect(state.snapshot()).toHaveLength(2);
    expect(state.snapshot().some(q => q.requestId === id)).toBe(true);
    state.replace([]);
    expect(state.snapshot()).toEqual([]);
    expect(events).toContainEqual({ type: "interaction.cancelled", requestId: id, reason: "cancelled" });
  });

  it("does not consume answers from ordinary messages or unaccepted steering", () => {
    const state = new CodexAsyncInputs("codex-desktop:a", () => {});
    state.replace([question, nativeAnswer("仅 App"), { type: "steeringUserMessage", id: "steer", status: "pending",
      input: [{ type: "text", text: reply() }],
    }]);
    expect(state.snapshot()).toHaveLength(2);
    state.upsert({ type: "steeringUserMessage", id: "steer", status: "accepted", input: [{ type: "text", text: reply() }] });
    expect(state.snapshot()).toHaveLength(1);
  });

  it("dismisses an async question locally without injecting cancellation text into the agent", () => {
    const state = new CodexAsyncInputs("codex-desktop:a", () => {});
    state.replace([question]);
    const send = vi.fn();
    state.respond(state.snapshot()[0]!.requestId, { kind: "cancel" }, "cancel", send);
    state.replace([question]);
    expect(state.snapshot()).toHaveLength(1);
    expect(send).not.toHaveBeenCalled();
  });

  it("displays human-readable replies while leaving ordinary messages unchanged", () => {
    expect(codexQuestionReplyText(reply())).toBe("需要修复哪些端？\n仅 App");
    expect(codexQuestionReplyText("ordinary text")).toBe("ordinary text");
    expect(codexQuestionReplyText("<send_user_message_question_reply>broken</send_user_message_question_reply>"))
      .toContain("broken");
  });
});
