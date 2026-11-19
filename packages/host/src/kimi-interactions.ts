import { createHash } from "node:crypto";
import { z } from "zod";
import { InteractionRequestSchema, type InteractionRequest, type InteractionResponse, type RuntimeCommand, type RuntimeEvent } from "@orbis/protocol";
import { kimiObject, type KimiFrame } from "./kimi-conversation.js";
import { kimiSessionPath } from "./kimi-sessions.js";
import { KimiBusinessError, type KimiWebClient } from "./kimi-web-client.js";

const id = z.string().min(1).max(256);
const date = z.iso.datetime({ offset: true });
const interaction = z.object({ type: z.literal("interaction"), session_id: id, agent_id: z.literal("main"), interaction_id: id,
  kind: z.enum(["approval", "question"]), status: z.enum(["pending", "ended"]), outcome: z.string().optional() });
const approval = z.object({ tool_name: id, action: z.string().min(1).max(512), expires_at: date, tool_input_display: z.unknown() });
const questions = z.object({ questions: z.array(z.object({ id, header: z.string().optional(), question: z.string().min(1), body: z.string().optional(),
  options: z.array(z.object({ id, label: z.string(), description: z.string().optional() })).min(2).max(4),
  multi_select: z.boolean().optional(), allow_other: z.boolean().optional(), other_label: z.string().optional(), other_description: z.string().optional(),
})).min(1).max(4) });
const reply = z.object({ outcome: z.string(), ended_at: date });
const EXTENSION = "kimiCode";
const MAX_PENDING = 64;
const terminal = new Set(["approved", "rejected", "answered", "dismissed", "cancelled"]);

type NativeAnswer = { kind: "single"; option_id: string } | { kind: "multi"; option_ids: string[] }
  | { kind: "other"; text: string } | { kind: "multi_with_other"; option_ids: string[]; other_text: string };
type Reply = { outcome: string; body: Record<string, unknown> };
type Card = { nativeId: string; kind: "approval" | "question"; request: InteractionRequest };
type Submission = { commandId: string; outcome: string; confirmed?: boolean; ended?: string; timer?: ReturnType<typeof setTimeout> };

function projectApproval(request: unknown): Omit<Extract<InteractionRequest, {kind: "confirm"}>, "runtimeId" | "requestId" | "extensionId"> | undefined {
  const payload = approval.safeParse(request);
  if (!payload.success) return;
  const value = payload.data;
  const display = kimiObject(value.tool_input_display);
  let summary: string;
  // Don't convert bespoke approvals (plan choices, goals, etc.) into a simple yes/no.
  // Never shorten the target of an actionable approval. Unrepresentable actions stay in Kimi.
  if (display.kind === "command" && typeof display.command === "string" && display.command.trim()) {
    summary = [typeof display.cwd === "string" ? `目录：${display.cwd}` : "", display.command].filter(Boolean).join("\n");
  } else if (display.kind === "file_io" && typeof display.path === "string" && display.path.trim()
      && ["read", "glob", "grep"].includes(String(display.operation))) {
    summary = [display.path, typeof display.detail === "string" ? display.detail : ""].filter(Boolean).join("\n");
  } else return;
  if (summary.length > 4000 || display.truncated === true) return;
  return { kind: "confirm", title: `允许 ${value.tool_name}？`, description: value.action, argumentSummary: summary, toolName: value.tool_name,
    confirmLabel: "允许一次", cancelLabel: "拒绝", expiresAt: Date.parse(value.expires_at) };
}

function projectQuestion(request: unknown): Omit<Extract<InteractionRequest, {kind: "questionnaire"}>, "runtimeId" | "requestId" | "extensionId"> | undefined {
  const payload = questions.safeParse(request);
  if (!payload.success) return;
  const items = payload.data.questions;
  // Native answers are eventually keyed by question text, not just by the wire ID.
  if (new Set(items.map(row => row.question)).size !== items.length || new Set(items.map(row => row.id)).size !== items.length
      || items.some(row => Object.hasOwn(Object.prototype, row.question) || new Set(row.options.map(option => option.id)).size !== row.options.length)) return;
  return { kind: "questionnaire", title: "Kimi Code 提问", expiresAt: Number.MAX_SAFE_INTEGER,
    questions: items.map(row => ({ id: row.id, ...(row.header ? { header: row.header } : {}),
      question: [row.question, row.body, row.allow_other === true && [row.other_label, row.other_description].filter(Boolean).join("：")].filter(Boolean).join("\n"),
      options: row.options.map(option => ({ value: option.id, label: option.label, ...(option.description ? { description: option.description } : {}) })),
      multiSelect: row.multi_select === true, allowOther: row.allow_other === true,
    })) };
}

function nativeReply(card: Card, response: InteractionResponse): Reply | undefined {
  if (card.request.kind === "confirm") {
    const outcome = response.kind === "confirm" ? response.value ? "approved" : "rejected" : response.kind === "cancel" ? "cancelled" : undefined;
    if (outcome) return { outcome, body: { kind: "approval", decision: outcome } };
  } else if (card.request.kind === "questionnaire") {
    if (response.kind === "cancel") return { outcome: "dismissed", body: { kind: "question", dismissed: true } };
    if (response.kind !== "questionnaire" || response.answers.length !== card.request.questions.length) return;
    const answers = new Map<string, NativeAnswer>();
    for (const { id, values, other, notes } of response.answers) {
      const item = card.request.questions.find(row => row.id === id);
      if (!item || answers.has(id) || notes !== undefined || new Set(values).size !== values.length
          || values.some(value => !item.options.some(option => option.value === value))
          || (other !== undefined && (!item.allowOther || !other.trim())) || (!item.multiSelect && values.length + Number(other !== undefined) !== 1)) return;
      if (values.length) answers.set(id, item.multiSelect ? other === undefined ? { kind: "multi", option_ids: values }
        : { kind: "multi_with_other", option_ids: values, other_text: other } : { kind: "single", option_id: values[0]! });
      else if (other !== undefined) answers.set(id, { kind: "other", text: other });
      else return;
    }
    return { outcome: "answered", body: { kind: "question", answers: Object.fromEntries(answers), method: "click" } };
  }
}

/** One subscription generation. The pending replay ends at the main agent's baseline. */
export class KimiInteractions {
  readonly #cards = new Map<string, Card>();
  readonly #writes = new Map<string, Submission>();
  readonly #ended = new Set<string>();
  #replaying = true;
  #closed = false;

  constructor(readonly options: { runtimeId: string; nativeId: string; client: Pick<KimiWebClient, "requestJson">;
    verifyLocal: () => Promise<void>; emit: (event: RuntimeEvent) => void; resubscribe: () => void; }) {}

  #requestId(nativeId: string): string {
    return `kimi-interaction:${createHash("sha256").update(JSON.stringify([this.options.runtimeId, "main", nativeId])).digest("base64url")}`;
  }
  announce(): void {
    if (!this.#replaying && !this.#closed) this.options.emit({ type: "interaction.snapshot",
      requests: [...this.#cards].filter(([, card]) => card.request.expiresAt > Date.now())
        .map(([id, card]) => ({ ...card.request, submitted: this.#writes.has(id) })) });
  }
  finishReplay(): void { if (this.#replaying) { this.#replaying = false; this.announce(); } }

  frame(frame: KimiFrame): void {
    if (this.#closed) return;
    const parsed = interaction.safeParse(frame);
    if (!parsed.success || parsed.data.session_id !== this.options.nativeId) return;
    const event = parsed.data;
    const requestId = this.#requestId(event.interaction_id);
    if (event.status === "ended") {
      const outcome = event.outcome;
      if (!outcome || !terminal.has(outcome)) return;
      const write = this.#writes.get(requestId);
      if (write) write.ended = outcome;
      this.#finish(requestId, outcome, write ? "remote" : "local");
      if (write?.confirmed) this.#settle(requestId, write, write.outcome === outcome ? "success" : "unconfirmed");
      return;
    }
    if (this.#ended.has(requestId) || this.#cards.has(requestId) || this.#cards.size >= MAX_PENDING) return;
    const fields = event.kind === "approval" ? projectApproval(frame.request) : projectQuestion(frame.request);
    const request = InteractionRequestSchema.safeParse({ ...fields, runtimeId: this.options.runtimeId, requestId, extensionId: EXTENSION });
    if (!request.success || request.data.expiresAt <= Date.now()) return;
    this.#cards.set(requestId, { nativeId: event.interaction_id, kind: event.kind, request: request.data });
    if (!this.#replaying) this.options.emit({ type: "interaction.requested", request: request.data });
  }

  #finish(id: string, outcome: string | undefined, source: "local" | "remote"): void {
    this.#ended.add(id);
    if (this.#ended.size > 256) this.#ended.delete(this.#ended.values().next().value!);
    const present = this.#cards.delete(id);
    if (!present || this.#replaying) return;
    this.options.emit(outcome && outcome !== "cancelled" ? { type: "interaction.resolved", requestId: id, source }
      : { type: "interaction.cancelled", requestId: id, reason: "cancelled" });
  }

  #result(commandId: string, status: "success" | "failure" | "unconfirmed", error?: string): void {
    this.options.emit({ type: "command.result", commandId, ok: status === "success", status, ...(error ? { error } : {}) });
  }
  #settle(id: string, write: Submission, status: "success" | "failure" | "unconfirmed", reason?: string): void {
    if (this.#writes.get(id) !== write) return;
    this.#writes.delete(id);
    clearTimeout(write.timer);
    this.#result(write.commandId, status, reason);
    if (this.#cards.has(id)) this.announce();
  }

  async respond(commandId: string, command: Extract<RuntimeCommand, {type: "interaction.respond"}>): Promise<void> {
    const { requestId } = command;
    const card = this.#cards.get(requestId);
    if (this.#closed || this.#replaying || command.extensionId !== EXTENSION || !card || card.request.expiresAt <= Date.now()) {
      this.#result(commandId, "failure", "Kimi Code 交互已失效"); return;
    }
    if (this.#writes.has(requestId)) { this.#result(commandId, "failure", "Kimi Code 正在确认上一条回答"); return; }
    const answer = nativeReply(card, command.response);
    if (!answer) { this.#result(commandId, "failure", "此回答不符合 Kimi Code 的选项"); return; }
    const write: Submission = { commandId, outcome: answer.outcome };
    this.#writes.set(requestId, write);
    this.announce();
    try {
      await this.options.verifyLocal();
    } catch {
      this.#settle(requestId, write, "failure", "未确认 Kimi Code 会话在本机执行"); return;
    }
    if (this.#closed || this.#cards.get(requestId) !== card) {
      this.#settle(requestId, write, "failure", "Kimi Code 已结束此交互"); return;
    }
    try {
      const result = reply.parse(await this.options.client.requestJson(`${kimiSessionPath(this.options.nativeId)}/interactions/${encodeURIComponent(card.nativeId)}`,
        { method: "POST", body: answer.body }));
      if (this.#writes.get(requestId) !== write) return;
      if (result.outcome !== answer.outcome) throw new Error();
      write.confirmed = true;
      if (write.ended !== undefined) this.#settle(requestId, write, write.ended === answer.outcome ? "success" : "unconfirmed");
      else {
        write.timer = setTimeout(() => {
          this.#settle(requestId, write, "unconfirmed", "未收到 Kimi Code 的交互终态");
          this.options.resubscribe();
        }, 4000);
        write.timer.unref();
      }
    } catch (error) {
      if (this.#writes.get(requestId) !== write) return;
      if (error instanceof KimiBusinessError && (error.code === 40902 || error.code === 40404)) {
        this.#finish(requestId, undefined, "local");
        this.#settle(requestId, write, "failure", "Kimi Code 已结束此交互");
      } else if (error instanceof KimiBusinessError) this.#settle(requestId, write, "failure", "Kimi Code 未接受此回答");
      else {
        this.#settle(requestId, write, "unconfirmed", "Kimi Code 回答结果待核对");
        this.options.resubscribe();
      }
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const [id, write] of this.#writes) this.#settle(id, write, "unconfirmed", "Kimi Code 连接已改变，回答待核对");
    this.#cards.clear();
    this.options.emit({ type: "interaction.snapshot", requests: [] });
  }
}
