import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { InteractionRequestSchema, type InteractionRequest, type InteractionResponse, type RuntimeEvent } from "@pi-remote/protocol";
import { object } from "./codex-interactions.js";

const OPEN = "<send_user_message_question_reply>";
const CLOSE = "</send_user_message_question_reply>";
type Reply = { questionItemId: string; question: string; answer: string };
type Question = { request: Extract<InteractionRequest, { kind: "questionnaire" }>; questionItemId: string; turnId: string };
type Submission = { text: string; commandIds: Set<string>; accepted: boolean };

/** Native desktop async questions are agentMessage items, not server requests.
 * These IDs and the reply envelope match the desktop client's question projection.
 */
function questions(item: Record<string, unknown>, runtimeId: string, turnId: string): Question[] {
  if (item.type !== "agentMessage" || typeof item.id !== "string" || !Array.isArray(item.questions)) return [];
  return item.questions.flatMap((raw, index) => {
    const q = object(raw);
    const questionItemId = JSON.stringify(["request_user_input_async", item.id, index]);
    const parsed = InteractionRequestSchema.safeParse({
      kind: "questionnaire", runtimeId, extensionId: "codex", title: "Codex 需要你的回答",
      requestId: `codex-async:${createHash("sha256").update(JSON.stringify([runtimeId, questionItemId])).digest("hex")}`,
      expiresAt: Number.MAX_SAFE_INTEGER,
      questions: [{ id: String(index), question: q.title, allowOther: true,
        options: Array.isArray(q.options) ? q.options.map((label, i) => ({ value: String(i), label })) : [],
      }],
    });
    return parsed.success && parsed.data.kind === "questionnaire" ? [{ request: parsed.data, questionItemId, turnId }] : [];
  });
}

function parseReply(text: unknown): Reply[] {
  if (typeof text !== "string") return [];
  const value = text.trim();
  if (!value.startsWith(OPEN) || !value.endsWith(CLOSE)) return [];
  try {
    const parsed: unknown = JSON.parse(value.slice(OPEN.length, -CLOSE.length));
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    return rows.length > 0 && rows.every(row => {
      const r = object(row);
      return typeof r.questionItemId === "string" && typeof r.question === "string" && typeof r.answer === "string";
    }) ? rows as Reply[] : [];
  } catch { return []; }
}

function itemReplies(item: Record<string, unknown>): Reply[] {
  if (item.type !== "userMessage" && item.type !== "steeringUserMessage") return [];
  if (item.type === "steeringUserMessage" && item.status !== "accepted") return [];
  const content = item.type === "userMessage" ? item.content : item.input;
  if (!Array.isArray(content) || content.length !== 1 || object(content[0]).type !== "text") return [];
  return parseReply(object(content[0]).text);
}

export function codexAsyncQuestionText(item: Record<string, unknown>): string {
  if (!Array.isArray(item.questions)) return "";
  return item.questions.map(raw => {
    const q = object(raw);
    return [typeof q.title === "string" ? q.title : "",
      ...(Array.isArray(q.options) ? q.options.filter((o): o is string => typeof o === "string").map((o, i) => `${i + 1}. ${o}`) : []),
    ].filter(Boolean).join("\n");
  }).filter(Boolean).join("\n\n");
}

export function codexQuestionReplyText(text: string): string {
  const replies = parseReply(text);
  return replies.length ? replies.map(r => `${r.question}\n${r.answer}`).join("\n\n") : text;
}

/** Mirrors desktop answerability: an unanswered question is actionable only while
 * its own turn is inProgress. The desktop's 30-second panel timer merely minimizes
 * the composer; it does not expire the question or belong in the shared state.
 */
export class CodexAsyncInputs {
  readonly #items = new Map<string, { item: Record<string, unknown>; turnId: string }>();
  readonly #turns = new Map<string, unknown>();
  readonly #pending = new Map<string, Question>();
  readonly #submissions = new Map<string, Submission>();
  readonly #dismissed = new Set<string>();
  #answered = new Set<string>();
  #closed = false;

  constructor(readonly runtimeId: string, readonly emit: (event: RuntimeEvent) => void) {}

  has(requestId: string): boolean { return this.#pending.has(requestId); }
  turnId(requestId: string): string | undefined { return this.#pending.get(requestId)?.turnId; }
  snapshot(): InteractionRequest[] {
    return [...this.#pending.values()].filter(q => !this.#submissions.get(q.request.requestId)?.accepted)
      .map(q => ({ ...q.request, submitted: this.#submissions.has(q.request.requestId) }));
  }

  replace(turns: unknown[]): void {
    this.#items.clear();
    this.#turns.clear();
    for (const value of turns) {
      const turn = object(value);
      if (typeof turn.id !== "string") continue;
      this.#turns.set(turn.id, turn.status);
      for (const item of Array.isArray(turn.items) ? turn.items : []) this.#store(object(item), turn.id);
    }
    this.#reconcile(true);
  }

  updateTurn(turnId: string, status: unknown): void {
    this.#turns.set(turnId, status);
    this.#reconcile(false);
  }

  upsert(item: Record<string, unknown>, turnId: string): void {
    if (!this.#store(item, turnId)) return;
    this.#reconcile(false);
  }

  #store(item: Record<string, unknown>, turnId: string): boolean {
    if (typeof item.id !== "string" || !["agentMessage", "userMessage", "steeringUserMessage"].includes(String(item.type))) return false;
    // Ordinary conversation items need no second history copy.
    if (!Array.isArray(item.questions) && itemReplies(item).length === 0 && !this.#items.has(item.id)) return false;
    this.#items.set(item.id, { item, turnId });
    return true;
  }

  #reconcile(replaced: boolean): void {
    const native = new Map<string, Question>();
    const answered = new Set<string>();
    for (const { item, turnId } of this.#items.values()) {
      for (const q of questions(item, this.runtimeId, turnId)) native.set(q.questionItemId, q);
      for (const reply of itemReplies(item)) if (native.has(reply.questionItemId)) answered.add(reply.questionItemId);
    }
    if (replaced) {
      // A revert that removes a previously persisted answer restores the question.
      for (const id of this.#answered) if (!answered.has(id)) this.#dismissed.delete(id);
    }
    const available = new Map([...native.values()]
      .filter(q => this.#turns.get(q.turnId) === "inProgress"
        && !answered.has(q.questionItemId) && !this.#dismissed.has(q.questionItemId))
      .slice(-64).map(q => [q.request.requestId, q]));
    for (const [id, q] of this.#pending) {
      if (available.has(id)) continue;
      this.#pending.delete(id);
      const submission = this.#submissions.get(id);
      this.#submissions.delete(id);
      if (answered.has(q.questionItemId)) {
        if (!submission?.accepted) this.emit({ type: "interaction.resolved", requestId: id, source: submission ? "remote" : "local" });
        for (const commandId of submission?.commandIds ?? []) this.emit({ type: "command.result", commandId, ok: true });
      } else {
        this.emit({ type: "interaction.cancelled", requestId: id, reason: "cancelled" });
        for (const commandId of submission?.commandIds ?? []) this.emit({ type: "command.result", commandId, ok: false, error: "提问已失效，请刷新会话" });
      }
    }
    for (const [id, q] of available) {
      const previous = this.#pending.get(id);
      this.#pending.set(id, q);
      if (!previous || !isDeepStrictEqual(previous.request, q.request)) this.emit({ type: "interaction.requested", request: q.request });
    }
    this.#answered = answered;
  }

  respond(requestId: string, response: InteractionResponse, commandId: string | undefined,
    send: (text: string, messageId: string) => Promise<void>): void {
    const q = this.#pending.get(requestId);
    if (!q) throw new Error("提问已结束，请刷新会话");
    if (response.kind === "cancel") {
      if (this.#submissions.has(requestId)) throw new Error("答案已提交，正在等待电脑确认");
      this.#dismissed.add(q.questionItemId);
      this.#pending.delete(requestId);
      this.emit({ type: "interaction.cancelled", requestId, reason: "cancelled" });
      if (commandId) this.emit({ type: "command.result", commandId, ok: true });
      return;
    }
    const question = q.request.questions[0]!;
    const a = response.kind === "questionnaire" && response.answers.length === 1 ? response.answers[0] : undefined;
    const count = (a?.values.length ?? 0) + (a?.other?.trim() ? 1 : 0);
    if (!a || a.id !== question.id || count !== 1 || a.notes || a.other !== undefined && !a.other.trim()
      || a.values.some(value => !question.options.some(option => option.value === value))) throw new Error("请选择一个答案或填写内容");
    const answer = a.other?.trim() ?? question.options.find(option => option.value === a.values[0])!.label;
    const text = `${OPEN}\n${JSON.stringify([{ questionItemId: q.questionItemId, question: question.question, answer }])}\n${CLOSE}`;
    const previous = this.#submissions.get(requestId);
    if (previous && previous.text !== text) throw new Error("答案已提交，正在等待电脑确认");
    if (previous?.accepted) {
      if (commandId) this.emit({ type: "command.result", commandId, ok: true });
      return;
    }
    const submission = previous ?? { text, commandIds: new Set<string>(), accepted: false };
    if (commandId) submission.commandIds.add(commandId);
    this.#submissions.set(requestId, submission);
    if (commandId) this.emit({ type: "command.result", commandId, ok: true, status: "pending" });
    if (previous) return;
    void send(text, requestId).then(() => {
      if (this.#closed || this.#submissions.get(requestId) !== submission) return;
      submission.accepted = true;
      // RPC acceptance confirms delivery for every paired device. Retain the
      // submission until native history catches up to suppress reconnect replays.
      this.emit({ type: "interaction.resolved", requestId, source: "remote" });
      for (const id of submission.commandIds) this.emit({ type: "command.result", commandId: id, ok: true });
      submission.commandIds.clear();
    }).catch((error: unknown) => {
      if (this.#closed || this.#submissions.get(requestId) !== submission) return;
      this.#submissions.delete(requestId);
      for (const id of submission.commandIds) this.emit({ type: "command.result", commandId: id, ok: false,
        error: error instanceof Error ? error.message : String(error) });
      this.emit({ type: "interaction.requested", request: q.request });
    });
  }

  close(reason: "disconnected" | "owner_closed"): void {
    this.#closed = true;
    for (const id of this.#pending.keys()) if (!this.#submissions.get(id)?.accepted) {
      this.emit({ type: "interaction.cancelled", requestId: id, reason });
    }
    for (const submission of this.#submissions.values()) for (const commandId of submission.commandIds) {
      this.emit({ type: "command.result", commandId, ok: false, error: "Codex 会话已断开" });
    }
    this.#pending.clear();
    this.#submissions.clear();
    this.#items.clear();
    this.#turns.clear();
  }
}
