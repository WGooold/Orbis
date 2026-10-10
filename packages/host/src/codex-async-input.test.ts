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
const running = (items: unknown[], id = "turn-1") => [{ id, status: "inProgress", items }];
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
    h.notify("turn/started", { turn: { id: "turn-1" } });
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

  it("sends free text to the question's running turn with the desktop question ID", async () => {
    const h = await harness(running([question]));
    const prompt = h.prompts()[1]!;
    h.answer(prompt, { kind: "questionnaire", answers: [{ id: "1", values: [], other: "保留当前连接" }] });
    await vi.waitFor(() => expect(h.request).toHaveBeenCalledWith("turn/steer", expect.objectContaining({
      threadId: "a", expectedTurnId: "turn-1", input: [{ type: "text", text: reply(1, "保留当前连接") }],
    })));
  });

  it("keeps running questions after the desktop panel timer and approval TTL", async () => {
    vi.useFakeTimers();
    const h = await harness();
    h.notify("turn/started", { turn: { id: "turn-1" } });
    h.notify("item/completed", { turnId: "turn-1", item: question });
    await vi.advanceTimersByTimeAsync(600_000);
    h.runtime.announce("a");
    expect(h.events).toContainEqual({ type: "interaction.snapshot", requests: h.prompts().map(p => ({ ...p, submitted: false })) });
  });

  it.each(["completed", "interrupted", "failed"])("cancels unanswered questions when the owning turn is %s and rejects late answers", async status => {
    const h = await harness(running([question]));
    const prompts = h.prompts();
    h.notify("turn/completed", { turn: { id: "turn-1", status } });
    for (const prompt of prompts) expect(h.events).toContainEqual({
      type: "interaction.cancelled", requestId: prompt.requestId, reason: "cancelled",
    });
    h.runtime.announce("a");
    expect(h.events).toContainEqual({ type: "interaction.snapshot", requests: [] });
    h.answer(prompts[0]!);
    expect(h.events.some(e => e.type === "command.result" && e.commandId === "answer-1" && !e.ok)).toBe(true);
    expect(h.request.mock.calls.some(([method]) => method === "turn/start" || method === "turn/steer")).toBe(false);
    // Delayed completion of the question item cannot resurrect an ended turn.
    h.notify("item/completed", { turnId: "turn-1", item: question });
    expect(h.prompts()).toHaveLength(2);
  });

  it("attaches with only running-turn questions and recovers missed completion from native history", async () => {
    const stale = { ...question, id: "old-question" };
    const h = await harness([{ id: "old", status: "completed", items: [stale] }, ...running([question])]);
    expect(h.prompts()).toHaveLength(2);
    h.replaceTurns([{ id: "turn-1", status: "completed", items: [question] }]);
    h.notify("thread/reverted", {});
    await vi.waitFor(() => expect(h.events.filter(e => e.type === "interaction.cancelled")).toHaveLength(2));
    h.runtime.announce("a");
    expect(h.events).toContainEqual({ type: "interaction.snapshot", requests: [] });
  });

  it("refuses to steer an old question into a different active turn", async () => {
    const h = await harness(running([question]));
    const prompt = h.prompts()[0]!;
    h.notify("turn/started", { turn: { id: "turn-2" } });
    h.answer(prompt);
    await vi.waitFor(() => expect(h.events).toContainEqual({ type: "command.result", commandId: "answer-1", ok: false,
      error: "提问已失效，请刷新会话" }));
    expect(h.request.mock.calls.some(([method]) => method === "turn/start" || method === "turn/steer")).toBe(false);
  });

  it("clears a desktop answer and avoids replaying already answered questions on Host attach", async () => {
    const h = await harness(running([question, nativeAnswer(reply())]));
    expect(h.prompts()).toHaveLength(1);
    expect(h.prompts()[0]).toMatchObject({ questions: [{ id: "1" }] });
    h.notify("item/completed", { turnId: "turn-1", item: nativeAnswer(reply(1, "保留数据"), "answer-2") });
    expect(h.events).toContainEqual({ type: "interaction.resolved", requestId: h.prompts()[0]!.requestId, source: "local" });
    h.runtime.announce("a");
    expect(h.events).toContainEqual({ type: "interaction.snapshot", requests: [] });
  });

  it("rejects forged answers and cross-thread requests without sending any turn RPC", async () => {
    const h = await harness(running([question]));
    await h.runtime.activate({ type: "resume", sessionId: "codex-desktop:b" });
    const prompt = h.prompts()[0]!;
    h.answer(prompt, choose("999"));
    h.answer(prompt, choose(), "other-thread", "codex-desktop:b");
    expect(h.events.filter(e => e.type === "command.result" && !e.ok)).toHaveLength(2);
    expect(h.request.mock.calls.some(([method]) => method === "turn/start" || method === "turn/steer")).toBe(false);
  });

  it("leaves failed submissions editable and retries delivery", async () => {
    const h = await harness(running([question]));
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
    state.replace(running([question]));
    const id = state.snapshot()[0]!.requestId;
    const send = vi.fn(async () => {});
    state.respond(id, choose(), "first", send);
    await vi.waitFor(() => expect(events).toContainEqual({ type: "interaction.resolved", requestId: id, source: "remote" }));
    state.replace(running([question]));
    expect(state.snapshot()).toHaveLength(1);
    state.respond(id, choose(), "retry", send);
    expect(send).toHaveBeenCalledTimes(1);
    expect(events).toContainEqual({ type: "command.result", commandId: "retry", ok: true });
  });

  it("restores questions when revert removes an answer and cancels removed questions", () => {
    const events: RuntimeEvent[] = [];
    const state = new CodexAsyncInputs("codex-desktop:a", e => events.push(e));
    state.replace(running([question]));
    const id = state.snapshot()[0]!.requestId;
    state.replace(running([question, nativeAnswer(reply())]));
    expect(state.snapshot()).toHaveLength(1);
    state.replace(running([question]));
    expect(state.snapshot()).toHaveLength(2);
    expect(state.snapshot().some(q => q.requestId === id)).toBe(true);
    state.replace([]);
    expect(state.snapshot()).toEqual([]);
    expect(events).toContainEqual({ type: "interaction.cancelled", requestId: id, reason: "cancelled" });
  });

  it("does not consume answers from ordinary messages or unaccepted steering", () => {
    const state = new CodexAsyncInputs("codex-desktop:a", () => {});
    state.replace(running([question, nativeAnswer("仅 App"), { type: "steeringUserMessage", id: "steer", status: "pending",
      input: [{ type: "text", text: reply() }],
    }]));
    expect(state.snapshot()).toHaveLength(2);
    state.upsert({ type: "steeringUserMessage", id: "steer", status: "accepted", input: [{ type: "text", text: reply() }] }, "turn-1");
    expect(state.snapshot()).toHaveLength(1);
  });

  it("dismisses an async question locally without injecting cancellation text into the agent", () => {
    const state = new CodexAsyncInputs("codex-desktop:a", () => {});
    state.replace(running([question]));
    const send = vi.fn();
    state.respond(state.snapshot()[0]!.requestId, { kind: "cancel" }, "cancel", send);
    state.replace(running([question]));
    expect(state.snapshot()).toHaveLength(1);
    expect(send).not.toHaveBeenCalled();
  });

  it("does not expire unanswered running questions on ordinary input or newer questions", () => {
    const state = new CodexAsyncInputs("codex-desktop:a", () => {});
    state.replace(running([question]));
    const original = state.snapshot().map(q => q.requestId);
    state.upsert(nativeAnswer("先继续处理别的事情"), "turn-1");
    state.upsert({ ...question, id: "new-question" }, "turn-1");
    expect(state.snapshot()).toHaveLength(4);
    expect(state.snapshot().map(q => q.requestId)).toEqual(expect.arrayContaining(original));
  });

  it("requires a known running turn and restores answerability from an authoritative replay", () => {
    const state = new CodexAsyncInputs("codex-desktop:a", () => {});
    state.upsert(question, "turn-1");
    expect(state.snapshot()).toEqual([]);
    state.updateTurn("turn-1", "inProgress");
    expect(state.snapshot()).toHaveLength(2);
    state.updateTurn("turn-1", "interrupted");
    expect(state.snapshot()).toEqual([]);
    state.replace(running([question]));
    expect(state.snapshot()).toHaveLength(2);
    state.replace([{ id: "turn-1", items: [question] }]);
    expect(state.snapshot()).toEqual([]);
  });

  it.each([false, true])("does not resurrect a stale question when pending delivery settles (reject=%s)", async reject => {
    const events: RuntimeEvent[] = [];
    const state = new CodexAsyncInputs("codex-desktop:a", e => events.push(e));
    state.replace(running([question]));
    const id = state.snapshot()[0]!.requestId;
    let settle!: () => void;
    state.respond(id, choose(), "answer", () => new Promise<void>((resolve, fail) => {
      settle = () => reject ? fail(new Error("late failure")) : resolve();
    }));
    state.updateTurn("turn-1", "completed");
    const boundary = events.length;
    settle();
    await Promise.resolve();
    await Promise.resolve();
    expect(state.snapshot()).toEqual([]);
    expect(events.slice(boundary)).toEqual([]);
    expect(events).toContainEqual({ type: "command.result", commandId: "answer", ok: false,
      error: "提问已失效，请刷新会话" });
  });

  it("displays human-readable replies while leaving ordinary messages unchanged", () => {
    expect(codexQuestionReplyText(reply())).toBe("需要修复哪些端？\n仅 App");
    expect(codexQuestionReplyText("ordinary text")).toBe("ordinary text");
    expect(codexQuestionReplyText("<send_user_message_question_reply>broken</send_user_message_question_reply>"))
      .toContain("broken");
  });
});
