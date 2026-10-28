import { randomUUID } from "node:crypto";
import {
  InteractionResponseSchema,
  type InteractionRequest,
  type InteractionResponse,
  type QuestionnaireAnswer,
  type QuestionnaireQuestion,
  type RuntimeEvent,
  type RuntimeMetadata,
} from "@pi-remote/protocol";

export type ClaudeHookDecision = "allow" | "deny";

export type ClaudeHookOutput = {
  hookSpecificOutput?: {
    hookEventName: "PermissionRequest";
    decision: { behavior: ClaudeHookDecision; message?: string };
  } | {
    hookEventName: "PreToolUse";
    permissionDecision: ClaudeHookDecision;
    permissionDecisionReason?: string;
    updatedInput?: { questions: readonly unknown[]; answers: Record<string, string> };
  };
};

type HookKind = "PermissionRequest" | "AskUserQuestion";

type Pending = {
  request: InteractionRequest;
  hook: HookKind;
  sessionId: string;
  generation: string;
  settle: (output: ClaudeHookOutput, fingerprint?: string, reason?: "timeout" | "disconnected" | "cancelled" | "owner_closed") => void;
  timer: ReturnType<typeof setTimeout>;
  fingerprint: string;
  rawToolInput: Record<string, unknown>;
  rawQuestions?: readonly unknown[];
  abortCleanup: () => void;
};

type ClaudeSession = { runtimeId: string; sessionId: string; cwd: string };

export type ClaudeHookBridgeOptions = {
  timeoutMs?: number;
  onRuntimeOnline?: (runtime: RuntimeMetadata) => void;
  onRuntimeOffline?: (runtimeId: string, reason: string) => void;
  onEvent?: (runtimeId: string, event: RuntimeEvent) => void;
};

/**
 * Synchronous Claude Code Hook requests are held here until the Host receives an
 * ordinary `interaction.respond` command.  This class deliberately knows nothing
 * about HTTP or devices, which keeps fail-closed and generation checks testable.
 */
export class ClaudeHookBridge {
  readonly #options: ClaudeHookBridgeOptions;
  readonly #generation = randomUUID();
  readonly #pending = new Map<string, Pending>();
  readonly #finished = new Map<string, { generation: string; fingerprint?: string; output: ClaudeHookOutput }>();
  readonly #sessions = new Map<string, ClaudeSession>();
  readonly #statuses = new Map<string, "idle" | "running" | "waiting_local_interaction">();

  constructor(options: ClaudeHookBridgeOptions = {}) {
    this.#options = options;
  }

  get generation(): string { return this.#generation; }
  runtimeIds(): readonly string[] { return [...this.#sessions.keys()]; }

  runtimeMetadata(): RuntimeMetadata[] {
    return [...this.#sessions.values()].map(session => ({
      runtimeId: session.runtimeId,
      name: "Claude Code",
      cwd: session.cwd,
      status: this.#statuses.get(session.runtimeId) ?? "idle",
      sessionId: session.sessionId,
    }));
  }

  async accept(input: unknown, signal?: AbortSignal): Promise<ClaudeHookOutput> {
    const parsed = parseHookInput(input);
    if (parsed === undefined) throw new ClaudeHookInputError("invalid Claude Hook input");
    const runtimeId = `claude:${parsed.sessionId}`;
    if (!this.#sessions.has(runtimeId)) {
      const session = { runtimeId, sessionId: parsed.sessionId, cwd: parsed.cwd };
      this.#sessions.set(runtimeId, session);
      this.#statuses.set(runtimeId, "idle");
      this.#options.onRuntimeOnline?.({ runtimeId, name: "Claude Code", cwd: session.cwd, status: "idle", sessionId: session.sessionId });
    }
    const requestId = `claude-hook:${randomUUID()}`;
    const timeoutMs = this.#timeoutMs();
    const expiresAt = Date.now() + timeoutMs;
    const request = makeInteraction(parsed, runtimeId, requestId, expiresAt);
    const fingerprint = JSON.stringify({ hook: parsed.hook, sessionId: parsed.sessionId, request: parsed.request });
    const requestWithExpiry = { ...request, expiresAt } as InteractionRequest;
    return await new Promise<ClaudeHookOutput>((resolve) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let abortCleanup = (): void => undefined;
      const finish = (output: ClaudeHookOutput, finishedFingerprint?: string, reason?: "timeout" | "disconnected" | "cancelled" | "owner_closed") => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        abortCleanup();
        this.#pending.delete(requestId);
        this.#finished.set(requestId, { generation: this.#generation,
          ...(finishedFingerprint === undefined ? {} : { fingerprint: finishedFingerprint }), output });
        if (reason !== undefined) this.#options.onEvent?.(runtimeId, { type: "interaction.cancelled", requestId, reason });
        this.#emitStatus(runtimeId, this.#pendingForRuntime(runtimeId) ? "waiting_local_interaction" : "idle");
        resolve(output);
      };
      timer = setTimeout(() => {
        const output = failClosed(parsed.hook, "Orbis interaction timed out");
        finish(output, undefined, "timeout");
      }, timeoutMs);
      const onAbort = () => finish(failClosed(parsed.hook, "Claude Hook 请求已断开"), undefined, "disconnected");
      abortCleanup = () => signal?.removeEventListener("abort", onAbort);
      if (signal?.aborted) {
        onAbort();
        return;
      }
      signal?.addEventListener("abort", onAbort, { once: true });
      this.#pending.set(requestId, { request: requestWithExpiry, hook: parsed.hook, sessionId: parsed.sessionId,
        generation: this.#generation, settle: (output, responseFingerprint, reason) => {
          finish(output, responseFingerprint, reason);
        }, timer, fingerprint, rawToolInput: parsed.toolInput,
        ...(parsed.rawQuestions === undefined ? {} : { rawQuestions: parsed.rawQuestions }), abortCleanup });
      this.#options.onEvent?.(runtimeId, { type: "interaction.requested", request: requestWithExpiry });
      this.#emitStatus(runtimeId, "waiting_local_interaction");
    });
  }

  respond(requestId: string, generation: string, response: InteractionResponse): "accepted" | "duplicate" | "conflict" | "stale" | "unknown" {
    const pending = this.#pending.get(requestId);
    const parsed = InteractionResponseSchema.safeParse(response);
    if (!parsed.success) return "conflict";
    const fingerprint = JSON.stringify(parsed.data);
    if (pending === undefined) {
      const finished = this.#finished.get(requestId);
      if (finished === undefined) return "unknown";
      if (generation !== finished.generation) return "stale";
      return finished.fingerprint !== undefined && finished.fingerprint === fingerprint ? "duplicate" : "conflict";
    }
    if (generation !== pending.generation) return "stale";
    const data = parsed.data;
    if (pending.hook === "PermissionRequest") {
      if (data.kind !== "confirm" && data.kind !== "cancel") return "conflict";
    } else {
      if (data.kind === "cancel") {
        const output = failClosed(pending.hook, "Claude Code 问题已取消");
        pending.settle(output, fingerprint, "cancelled");
        return "accepted";
      }
      if (data.kind !== "questionnaire") return "conflict";
      if (!validAnswers(pending.request, data)) return "conflict";
    }
    const output = pending.hook === "PermissionRequest"
      ? permissionOutput(data.kind === "confirm" && data.value)
      : questionnaireOutput(pending.request, data.kind === "questionnaire" ? data.answers : [], pending.rawToolInput);
    const runtimeId = `claude:${pending.sessionId}`;
    pending.settle(output, fingerprint);
    this.#options.onEvent?.(runtimeId, { type: "interaction.resolved", requestId, source: "remote" });
    return "accepted";
  }

  cancelRuntime(runtimeId: string, reason: "cancelled" | "disconnected" | "owner_closed" = "disconnected"): void {
    for (const pending of this.#pending.values()) {
      if (`claude:${pending.sessionId}` !== runtimeId) continue;
      const output = failClosed(pending.hook, `Claude runtime ${reason}`);
      pending.settle(output, undefined, reason);
    }
    this.#sessions.delete(runtimeId);
    this.#statuses.delete(runtimeId);
    this.#options.onRuntimeOffline?.(runtimeId, reason);
  }

  close(): void {
    for (const runtimeId of this.#sessions.keys()) this.cancelRuntime(runtimeId, "owner_closed");
  }

  #pendingForRuntime(runtimeId: string): boolean {
    return [...this.#pending.values()].some(item => `claude:${item.sessionId}` === runtimeId);
  }

  #emitStatus(runtimeId: string, status: "idle" | "running" | "waiting_local_interaction"): void {
    if (this.#sessions.has(runtimeId)) this.#statuses.set(runtimeId, status);
    this.#options.onEvent?.(runtimeId, { type: "runtime.status", status });
  }

  #timeoutMs(): number {
    const value = this.#options.timeoutMs;
    return value !== undefined && Number.isFinite(value) && value > 0
      ? Math.max(1, Math.floor(value))
      : 600_000;
  }
}

export class ClaudeHookInputError extends Error {
  constructor(message: string) { super(message); this.name = "ClaudeHookInputError"; }
}

type ParsedHook = {
  hook: HookKind;
  sessionId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  request: Record<string, unknown>;
  cwd: string;
  rawQuestions?: readonly unknown[];
};

function parseHookInput(input: unknown): ParsedHook | undefined {
  if (!isRecord(input)) return undefined;
  const value = input as Record<string, unknown>;
  const hookEvent = value.hook_event_name ?? value.event_name;
  const sessionId = value.session_id;
  const toolName = value.tool_name;
  const toolInput = value.tool_input;
  const cwd = value.cwd;
  if (typeof sessionId !== "string" || !boundedText(sessionId, 256) ||
      typeof toolName !== "string" || !boundedText(toolName, 256) ||
      !isRecord(toolInput)) return undefined;
  const resolvedCwd = cwd === undefined ? "claude-code" :
    typeof cwd === "string" && boundedText(cwd, 4096) ? cwd : undefined;
  if (resolvedCwd === undefined) return undefined;
  if (hookEvent === "PermissionRequest") return { hook: hookEvent, sessionId, toolName, toolInput: toolInput as Record<string, unknown>, request: value, cwd: resolvedCwd };
  if (hookEvent === "PreToolUse" && toolName === "AskUserQuestion") {
    const questions = (toolInput as Record<string, unknown>).questions;
    if (!Array.isArray(questions) || questions.length === 0 || questions.length > 4 || !questions.every(validQuestionInput)) return undefined;
    const texts = questions.map(question => (question as Record<string, unknown>).question as string);
    if (new Set(texts).size !== texts.length) return undefined;
    return { hook: "AskUserQuestion", sessionId, toolName, toolInput: toolInput as Record<string, unknown>, request: value, cwd: resolvedCwd, rawQuestions: questions };
  }
  return undefined;
}

function makeInteraction(parsed: ParsedHook, runtimeId: string, requestId: string, expiresAt: number): InteractionRequest {
  if (parsed.hook === "PermissionRequest") {
    return { kind: "confirm", runtimeId, requestId, extensionId: "claude-code", title: `允许 Claude 使用 ${parsed.toolName}？`,
      description: "Claude Code 请求工具权限。", toolName: parsed.toolName, argumentSummary: safeSummary(parsed.toolInput),
      confirmLabel: "允许", cancelLabel: "拒绝", expiresAt };
  }
  const questions = (parsed.toolInput.questions as unknown[]).map((question) => toQuestion(question));
  return { kind: "questionnaire", runtimeId, requestId, extensionId: "claude-code", title: "Claude Code 需要你的回答", description: "请回答 Claude Code 的问题。", questions, expiresAt };
}

function toQuestion(value: unknown): QuestionnaireQuestion {
  const question = typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
  const options = Array.isArray(question.options) ? question.options.flatMap((item) => {
    if (typeof item !== "object" || item === null) return [];
    const option = item as Record<string, unknown>;
    const label = typeof option.label === "string" ? option.label : undefined;
    if (!label) return [];
    return [{ value: label, label, ...(typeof option.description === "string" ? { description: option.description } : {}) }];
  }) : [];
  const text = typeof question.question === "string" ? question.question : "Claude Code question";
  return { id: text, ...(typeof question.header === "string" && question.header ? { header: question.header } : {}),
    question: text, options, multiSelect: question.multiSelect === true,
    ...(question.allowOther === true ? { allowOther: true } : {}), ...(question.allowNotes === true ? { allowNotes: true } : {}) };
}

function validAnswers(request: InteractionRequest, response: Extract<InteractionResponse, { kind: "questionnaire" }>): boolean {
  if (request.kind !== "questionnaire") return false;
  if (response.answers.length !== request.questions.length) return false;
  const seen = new Set<string>();
  return response.answers.every(answer => {
    if (seen.has(answer.id)) return false;
    seen.add(answer.id);
    const question = request.questions.find(candidate => candidate.id === answer.id);
    if (!question || new Set(answer.values).size !== answer.values.length) return false;
    if (answer.values.some(value => !question.options.some(option => option.value === value))) return false;
    if (answer.other !== undefined && (!question.allowOther || answer.other.trim().length === 0)) return false;
    if (answer.notes !== undefined && !question.allowNotes) return false;
    const count = answer.values.length + (answer.other === undefined ? 0 : 1);
    if (count === 0 || (!question.multiSelect && count !== 1)) return false;
    return true;
  }) && seen.size === request.questions.length;
}

function questionnaireOutput(request: InteractionRequest, answers: readonly QuestionnaireAnswer[], original: Record<string, unknown>): ClaudeHookOutput {
  const questions = request.kind === "questionnaire" ? request.questions : [];
  const mappedAnswers: Record<string, string> = {};
  for (const question of questions) {
    const answer = answers.find(item => item.id === question.id);
    if (answer === undefined) continue;
    mappedAnswers[question.question] = [...answer.values, ...(answer.other === undefined ? [] : [answer.other])].join(", ");
  }
  return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow",
    updatedInput: { questions: original.questions as readonly unknown[], answers: mappedAnswers } } };
}

function validQuestionInput(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const question = value as Record<string, unknown>;
  if (typeof question.question !== "string" || !boundedText(question.question, 4_000)) return false;
  if (question.header !== undefined && (typeof question.header !== "string" || !boundedText(question.header, 100))) return false;
  if (question.allowOther !== undefined && typeof question.allowOther !== "boolean") return false;
  // Claude's Hook input has no response field for notes. Reject this explicitly
  // instead of exposing an Orbis question that questionnaireOutput would truncate.
  if (question.allowNotes === true) return false;
  if (question.allowNotes !== undefined && typeof question.allowNotes !== "boolean") return false;
  if (!Array.isArray(question.options)) return false;
  if (question.options.length === 0 && question.allowOther !== true) return false;
  if (question.options.length > 32) return false;
  if (question.multiSelect !== undefined && typeof question.multiSelect !== "boolean") return false;
  const labels = question.options.map(option => {
    if (!isRecord(option)) return undefined;
    const description = option.description;
    if (description !== undefined && (typeof description !== "string" || !boundedText(description, 4_000))) return undefined;
    return typeof option.label === "string" && boundedText(option.label, 512) ? option.label : undefined;
  });
  return labels.every(label => label !== undefined) && new Set(labels).size === labels.length;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedText(value: string, max: number): boolean {
  return value.trim().length > 0 && value.length <= max;
}

function permissionOutput(allow: boolean): ClaudeHookOutput {
  return { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: allow ? "allow" : "deny", ...(allow ? {} : { message: "Orbis 拒绝了 Claude Code 工具权限请求" }) } } };
}

function failClosed(hook: HookKind, reason: string): ClaudeHookOutput {
  return hook === "PermissionRequest" ? permissionOutput(false) : { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } };
}

function safeSummary(input: Record<string, unknown>): string {
  try { return JSON.stringify(input).slice(0, 4_000); } catch { return "工具参数不可序列化"; }
}
