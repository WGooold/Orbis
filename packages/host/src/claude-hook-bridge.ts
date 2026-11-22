import { randomUUID } from "node:crypto";
import {
  InteractionResponseSchema,
  type InteractionRequest,
  type InteractionResponse,
  type QuestionnaireAnswer,
  type QuestionnaireQuestion,
  type RuntimeEvent,
  type RuntimeMetadata,
} from "@orbis/protocol";

export type ClaudeHookDecision = "allow" | "deny";
type RuntimeStatus = "idle" | "running" | "waiting_local_interaction";

export type ClaudeHookOutput = {
  hookSpecificOutput?: {
    hookEventName: "PermissionRequest";
    decision: { behavior: "deny"; message: string } | {
      behavior: "allow";
      updatedPermissions?: [{ type: "setMode"; mode: "acceptEdits"; destination: "session" }];
    };
  } | {
    hookEventName: "PreToolUse";
    permissionDecision: ClaudeHookDecision;
    permissionDecisionReason?: string;
    updatedInput?: { questions: readonly unknown[]; answers: Record<string, string> };
  };
};

type HookKind = "PermissionRequest" | "AskUserQuestion";
type PermissionChoice = "allow-once" | "allow-and-accept-edits" | "deny";
type ResponseTarget = Pick<InteractionRequest, "runtimeId" | "extensionId">;

/** A phone answer the Mods plugin returns as the native AskUserQuestion result. */
export type ClaudeQuestionAnswer = { toolCallId: string; answers: Record<string, string> } | { toolCallId: string; deny: string };

/** An AskUserQuestion call the Mods plugin shows on the phone while its native dialog stays open. */
export type ClaudeRacedQuestion = { sessionId: string; cwd: string; toolCallId: string; agentId?: string; questions: unknown };

type Pending = {
  request: InteractionRequest;
  hook: HookKind;
  sessionId: string;
  toolName: string;
  agentId?: string;
  toolCallId?: string;
  generation: string;
  settle: (output: ClaudeHookOutput, fingerprint?: string, reason?: "timeout" | "disconnected" | "cancelled" | "owner_closed") => void;
  timer: ReturnType<typeof setTimeout>;
  fingerprint: string;
  rawToolInput: Record<string, unknown>;
  rawQuestions?: readonly unknown[];
  modeUpdateGeneration?: string;
  abortCleanup: () => void;
  /** Registered by the Mods plugin, which keeps the native dialog open; it never blocks Claude Code. */
  raced?: true;
};

type ClaudeSession = { runtimeId: string; sessionId: string; cwd: string };

const FINISHED_LIMIT = 256;
const RACED_LIMIT = 256;

export type ClaudeHookBridgeOptions = {
  timeoutMs?: number;
  /** Without a connected device nobody can answer remotely; the Hook then defers to the native TUI dialog. */
  hasRemoteDevice?: () => boolean;
  /** Status owned by the Mods bridge, restored once no Hook interaction is pending. */
  baseStatus?: (runtimeId: string) => RuntimeStatus | undefined;
  /** Explicit child Hooks can only use an already identified parent Session. */
  hasSession?: (runtimeId: string) => boolean;
  /** Only advertise a session-wide change to a native version verified to apply it. */
  acceptEditsApprovalGeneration?: (runtimeId: string) => string | undefined;
  onRuntimeOnline?: (runtime: RuntimeMetadata) => void;
  onRuntimeOffline?: (runtimeId: string, reason: string) => void;
  onEvent?: (runtimeId: string, event: RuntimeEvent) => void;
};

/**
 * Synchronous Claude Code Hook requests are held here until the Host receives an
 * ordinary `interaction.respond` command.  This class deliberately knows nothing
 * about HTTP or devices, which keeps decision and generation checks testable.
 *
 * Only an explicit remote answer produces allow/deny. Timeout, disconnect and
 * shutdown return an empty output, which leaves the decision to Claude Code's
 * native dialog instead of locking the local user out.
 *
 * A Session is published here only while it has pending interactions; the Mods
 * bridge owns the long-lived runtime presence.
 */
export class ClaudeHookBridge {
  readonly #options: ClaudeHookBridgeOptions;
  readonly #generation = randomUUID();
  readonly #pending = new Map<string, Pending>();
  readonly #finished = new Map<string, { generation: string; target: ResponseTarget; fingerprint?: string; output: ClaudeHookOutput }>();
  readonly #sessions = new Map<string, ClaudeSession>();
  /** Raced questions by tool call: kept until the plugin reports the call finished, so a lost poll reply is resent. */
  readonly #raced = new Map<string, { runtimeId: string; agentId?: string; answer?: ClaudeQuestionAnswer }>();

  constructor(options: ClaudeHookBridgeOptions = {}) {
    this.#options = options;
  }

  get generation(): string { return this.#generation; }
  runtimeIds(): readonly string[] { return [...this.#sessions.keys()]; }
  pendingRequests(runtimeId: string): InteractionRequest[] {
    return [...this.#pending.values()].filter(item => `claude:${item.sessionId}` === runtimeId).map(item => item.request);
  }

  runtimeMetadata(): RuntimeMetadata[] {
    return [...this.#sessions.values()].map(session => ({
      runtimeId: session.runtimeId,
      name: "Claude Code",
      cwd: session.cwd,
      status: "waiting_local_interaction" as const,
      sessionId: session.sessionId,
    }));
  }

  /** Questions Claude Code is blocked on, which the TUI status line offers to take back. Raced ones are visible there. */
  blockingRequestCount(runtimeId: string): number {
    return [...this.#pending.values()].filter(item => `claude:${item.sessionId}` === runtimeId && item.raced !== true).length;
  }

  async accept(input: unknown, signal?: AbortSignal): Promise<ClaudeHookOutput> {
    // The plugin already put this exact call on the phone and keeps the native dialog open.
    if (isRecord(input) && (input.hook_event_name ?? input.event_name) === "PreToolUse" && typeof input.tool_use_id === "string" &&
        this.#raced.get(input.tool_use_id)?.runtimeId === `claude:${String(input.session_id)}`) return passthrough();
    return await this.#accept(input, signal);
  }

  /**
   * Shows a native AskUserQuestion on the phone without blocking Claude Code: the plugin keeps
   * the TUI dialog open and returns the first answer from either side. It registers before the
   * native call starts, so that call's classic PreToolUse Hook passes straight through.
   */
  raceQuestion(question: ClaudeRacedQuestion): boolean {
    const runtimeId = `claude:${question.sessionId}`;
    const existing = this.#raced.get(question.toolCallId);
    if (existing !== undefined) return existing.runtimeId === runtimeId;
    const input = { hook_event_name: "PreToolUse", session_id: question.sessionId, cwd: question.cwd, tool_name: "AskUserQuestion",
      tool_input: { questions: question.questions }, tool_use_id: question.toolCallId,
      ...(question.agentId === undefined ? {} : { agent_id: question.agentId }) };
    if (parseHookInput(input) === undefined) return false;
    const entry: { runtimeId: string; agentId?: string; answer?: ClaudeQuestionAnswer } = { runtimeId,
      ...(question.agentId === undefined ? {} : { agentId: question.agentId }) };
    this.#raced.set(question.toolCallId, entry);
    while (this.#raced.size > RACED_LIMIT) this.#raced.delete(this.#raced.keys().next().value!);
    void this.#accept(input, undefined, true).then(output => {
      const decided = output.hookSpecificOutput;
      if (decided?.hookEventName !== "PreToolUse" || this.#raced.get(question.toolCallId) !== entry) return;
      entry.answer = decided.permissionDecision === "allow" && decided.updatedInput !== undefined
        ? { toolCallId: question.toolCallId, answers: decided.updatedInput.answers }
        : { toolCallId: question.toolCallId, deny: decided.permissionDecisionReason ?? "Claude Code 问题已取消" };
    }, () => undefined);
    return true;
  }

  /** Phone answers the plugin has not yet applied; repeated in every poll until the call finishes. */
  questionAnswers(runtimeId: string): ClaudeQuestionAnswer[] {
    return [...this.#raced.values()].flatMap(entry => entry.runtimeId === runtimeId && entry.answer !== undefined ? [entry.answer] : []);
  }

  /** The plugin's Host connection ended: nothing can return a phone answer to its dialogs. */
  cancelRaced(runtimeId: string): void {
    for (const pending of [...this.#pending.values()]) {
      if (pending.raced === true && `claude:${pending.sessionId}` === runtimeId) pending.settle(passthrough(), undefined, "disconnected");
    }
    for (const [toolCallId, entry] of [...this.#raced]) if (entry.runtimeId === runtimeId) this.#raced.delete(toolCallId);
  }

  async #accept(input: unknown, signal?: AbortSignal, raced = false): Promise<ClaudeHookOutput> {
    const parsed = parseHookInput(input);
    if (parsed === undefined) throw new ClaudeHookInputError("invalid Claude Hook input");
    if (this.#options.hasRemoteDevice?.() === false) return passthrough();
    // The question dialog is AskUserQuestion's own permission prompt. A phone allow/deny has no answers
    // to give it; the question itself reaches the phone through PreToolUse or the Mods race.
    if (parsed.hook === "PermissionRequest" && parsed.toolName === "AskUserQuestion") return passthrough();
    const runtimeId = `claude:${parsed.sessionId}`;
    const childTranscript = isRecord(input) && typeof input.transcript_path === "string" && /[\\/]subagents[\\/]/u.test(input.transcript_path);
    if (childTranscript && parsed.agentId === undefined) return passthrough();
    if (parsed.agentId !== undefined && this.#options.hasSession?.(runtimeId) !== true) return passthrough();
    if (!this.#sessions.has(runtimeId)) {
      const session = { runtimeId, sessionId: parsed.sessionId, cwd: parsed.cwd };
      this.#sessions.set(runtimeId, session);
      this.#options.onRuntimeOnline?.({ runtimeId, name: "Claude Code", cwd: session.cwd, status: "waiting_local_interaction", sessionId: session.sessionId });
    }
    const requestId = `claude-hook:${randomUUID()}`;
    const timeoutMs = this.#timeoutMs();
    const expiresAt = Date.now() + timeoutMs;
    // CLAUDE-PERMISSION-01: only a verified main-session approval in Manual may change the mode.
    const modeUpdateGeneration = parsed.hook === "PermissionRequest" && parsed.request.permission_mode === "default" &&
      !childTranscript && parsed.agentId === undefined && parsed.toolName !== "EnterPlanMode" && parsed.toolName !== "ExitPlanMode"
      ? this.#options.acceptEditsApprovalGeneration?.(runtimeId) : undefined;
    const request = makeInteraction(parsed, runtimeId, requestId, expiresAt, modeUpdateGeneration !== undefined);
    const fingerprint = JSON.stringify({ hook: parsed.hook, sessionId: parsed.sessionId, request: parsed.request });
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
        this.#finished.set(requestId, { generation: this.#generation, target: { runtimeId, extensionId: request.extensionId },
          ...(finishedFingerprint === undefined ? {} : { fingerprint: finishedFingerprint }), output });
        while (this.#finished.size > FINISHED_LIMIT) this.#finished.delete(this.#finished.keys().next().value!);
        if (reason !== undefined) this.#options.onEvent?.(runtimeId, { type: "interaction.cancelled", requestId, reason });
        if (!this.#pendingForRuntime(runtimeId)) this.#release(runtimeId, reason ?? "interaction_settled");
        resolve(output);
      };
      timer = setTimeout(() => finish(passthrough(), undefined, "timeout"), timeoutMs);
      const onAbort = () => finish(passthrough(), undefined, "disconnected");
      abortCleanup = () => signal?.removeEventListener("abort", onAbort);
      if (signal?.aborted) {
        onAbort();
        return;
      }
      signal?.addEventListener("abort", onAbort, { once: true });
      this.#pending.set(requestId, { request, hook: parsed.hook, sessionId: parsed.sessionId, toolName: parsed.toolName,
        ...(parsed.agentId === undefined ? {} : { agentId: parsed.agentId }),
        ...(parsed.toolCallId === undefined ? {} : { toolCallId: parsed.toolCallId }),
        generation: this.#generation, settle: (output, responseFingerprint, reason) => {
          finish(output, responseFingerprint, reason);
        }, timer, fingerprint, rawToolInput: parsed.toolInput,
        ...(modeUpdateGeneration === undefined ? {} : { modeUpdateGeneration }),
        ...(parsed.rawQuestions === undefined ? {} : { rawQuestions: parsed.rawQuestions }), abortCleanup, ...(raced ? { raced: true as const } : {}) });
      this.#options.onEvent?.(runtimeId, { type: "interaction.requested", request });
      this.#options.onEvent?.(runtimeId, { type: "runtime.status", status: "waiting_local_interaction" });
    });
  }

  respond(requestId: string, generation: string, response: InteractionResponse, target: ResponseTarget): "accepted" | "duplicate" | "conflict" | "stale" | "unknown" {
    const pending = this.#pending.get(requestId);
    const parsed = InteractionResponseSchema.safeParse(response);
    if (!parsed.success) return "conflict";
    const fingerprint = JSON.stringify(parsed.data);
    if (pending === undefined) {
      const finished = this.#finished.get(requestId);
      if (finished === undefined) return "unknown";
      if (generation !== finished.generation) return "stale";
      if (!sameTarget(finished.target, target)) return "conflict";
      return finished.fingerprint !== undefined && finished.fingerprint === fingerprint ? "duplicate" : "conflict";
    }
    if (generation !== pending.generation) return "stale";
    if (!sameTarget(pending.request, target)) return "conflict";
    if (Date.now() >= pending.request.expiresAt) {
      pending.settle(passthrough(), undefined, "timeout");
      return "conflict";
    }
    const data = parsed.data;
    let output: ClaudeHookOutput;
    if (pending.hook === "PermissionRequest") {
      const choice = permissionChoice(pending.request, data);
      if (choice === undefined || (choice === "allow-and-accept-edits" &&
          (pending.modeUpdateGeneration === undefined ||
           this.#options.acceptEditsApprovalGeneration?.(target.runtimeId) !== pending.modeUpdateGeneration))) return "conflict";
      output = permissionOutput(choice);
    } else {
      if (data.kind === "cancel") {
        const output = denyQuestion("Claude Code 问题已取消");
        pending.settle(output, fingerprint, "cancelled");
        return "accepted";
      }
      if (data.kind !== "questionnaire") return "conflict";
      if (!validAnswers(pending.request, data)) return "conflict";
      output = questionnaireOutput(pending.request, data.answers, pending.rawToolInput);
    }
    const runtimeId = `claude:${pending.sessionId}`;
    this.#options.onEvent?.(runtimeId, { type: "interaction.resolved", requestId, source: "remote" });
    pending.settle(output, fingerprint);
    return "accepted";
  }

  /**
   * The TUI decided first: a native tool finished, or the turn ended, while its Hook still
   * waited for a phone. Claude ignores the Hook's late empty output; the phone card closes
   * as answered on the computer. Without a tool name every pending Hook of that exact loop closes.
   */
  resolveLocally(runtimeId: string, toolName?: string, input?: unknown, agentId?: string, toolCallId?: string): void {
    // A finished call, or the end of its loop, ends a raced question: no answer is resent after it.
    for (const [id, entry] of [...this.#raced]) {
      if (entry.runtimeId === runtimeId && entry.agentId === agentId && (toolName === undefined || id === toolCallId)) this.#raced.delete(id);
    }
    for (const pending of [...this.#pending.values()]) {
      if (`claude:${pending.sessionId}` !== runtimeId) continue;
      if (pending.agentId !== agentId) continue;
      const exactTool = pending.toolCallId !== undefined && toolCallId !== undefined;
      if (exactTool && pending.toolCallId !== toolCallId) continue;
      if (toolName !== undefined && pending.toolName !== toolName) continue;
      // A blocking question Hook holds its tool, so only a raced question's own call can finish first.
      if (toolName !== undefined && pending.hook !== "PermissionRequest" && !(pending.raced === true && exactTool)) continue;
      if (toolName !== undefined && !exactTool && !sameInput(pending.rawToolInput, input)) continue;
      this.#options.onEvent?.(runtimeId, { type: "interaction.resolved", requestId: pending.request.requestId, source: "local" });
      pending.settle(passthrough());
    }
  }

  /** The person at the computer asked to answer there: every pending Hook makes no decision now. */
  deferToLocal(runtimeId: string): void {
    for (const pending of [...this.#pending.values()]) {
      if (`claude:${pending.sessionId}` === runtimeId) this.resolveLocally(runtimeId, undefined, undefined, pending.agentId);
    }
  }

  /** Defers every pending interaction of the runtime to the native TUI dialog. */
  cancelRuntime(runtimeId: string, reason: "cancelled" | "disconnected" | "owner_closed" = "disconnected"): void {
    for (const pending of [...this.#pending.values()]) {
      if (`claude:${pending.sessionId}` === runtimeId) pending.settle(passthrough(), undefined, reason);
    }
    for (const [toolCallId, entry] of [...this.#raced]) if (entry.runtimeId === runtimeId) this.#raced.delete(toolCallId);
    this.#release(runtimeId, reason);
  }

  close(): void {
    for (const runtimeId of [...this.#sessions.keys()]) this.cancelRuntime(runtimeId, "owner_closed");
  }

  #release(runtimeId: string, reason: string): void {
    if (!this.#sessions.delete(runtimeId)) return;
    this.#options.onEvent?.(runtimeId, { type: "runtime.status", status: this.#options.baseStatus?.(runtimeId) ?? "idle" });
    this.#options.onRuntimeOffline?.(runtimeId, reason);
  }

  #pendingForRuntime(runtimeId: string): boolean {
    return [...this.#pending.values()].some(item => `claude:${item.sessionId}` === runtimeId);
  }

  #timeoutMs(): number {
    const value = this.#options.timeoutMs;
    // Must expire before the plugin script's fetch (590 s) and the Hook timeout (600 s),
    // so the phone sees an accurate expiresAt and the Host owns the timeout outcome.
    return value !== undefined && Number.isFinite(value) && value > 0
      ? Math.max(1, Math.floor(value))
      : 570_000;
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
  agentId?: string;
  toolCallId?: string;
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
  if (value.agent_id !== undefined && (typeof value.agent_id !== "string" || !boundedText(value.agent_id, 256))) return undefined;
  const owner = { ...(typeof value.agent_id === "string" ? { agentId: value.agent_id } : {}),
    ...(typeof value.tool_use_id === "string" && boundedText(value.tool_use_id, 256) ? { toolCallId: value.tool_use_id } : {}) };
  if (hookEvent === "PermissionRequest") return { hook: hookEvent, sessionId, toolName, toolInput: toolInput as Record<string, unknown>, request: value, cwd: resolvedCwd, ...owner };
  if (hookEvent === "PreToolUse" && toolName === "AskUserQuestion") {
    const questions = (toolInput as Record<string, unknown>).questions;
    if (!Array.isArray(questions) || questions.length === 0 || questions.length > 4 || !questions.every(validQuestionInput)) return undefined;
    const texts = questions.map(question => (question as Record<string, unknown>).question as string);
    if (new Set(texts).size !== texts.length) return undefined;
    return { hook: "AskUserQuestion", sessionId, toolName, toolInput: toolInput as Record<string, unknown>, request: value, cwd: resolvedCwd, rawQuestions: questions, ...owner };
  }
  return undefined;
}

function makeInteraction(parsed: ParsedHook, runtimeId: string, requestId: string, expiresAt: number, offerAcceptEdits: boolean): InteractionRequest {
  if (parsed.hook === "PermissionRequest") {
    const base = { runtimeId, requestId, extensionId: "claude-code", title: `允许 Claude 使用 ${parsed.toolName}？`,
      description: "Claude Code 请求工具权限。", toolName: parsed.toolName, argumentSummary: safeSummary(parsed.toolInput), expiresAt };
    if (offerAcceptEdits) return { ...base, kind: "select", options: [
      { value: "allow-once", label: "允许一次" },
      { value: "allow-and-accept-edits", label: "允许并自动接受本会话的后续编辑" },
      { value: "deny", label: "拒绝" },
    ] };
    return { ...base, kind: "confirm", confirmLabel: "允许", cancelLabel: "拒绝" };
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

/**
 * A tool's Mods arguments against the Hook's `tool_input`. A bounded (truncated) or missing
 * copy cannot tell two calls of the same tool apart, so it matches by name alone.
 */
function sameInput(hookInput: Record<string, unknown>, modsInput: unknown): boolean {
  if (!isRecord(modsInput) || modsInput.truncated === true || modsInput.unavailable === true) return true;
  const own = Object.fromEntries(Object.entries(modsInput).filter(([key]) => !["agentId", "requestMeta", "consent"].includes(key)));
  return canonical(hookInput) === canonical(own);
}

function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => isRecord(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : item) ?? "null";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedText(value: string, max: number): boolean {
  return value.trim().length > 0 && value.length <= max;
}

function sameTarget(a: ResponseTarget, b: ResponseTarget): boolean {
  return a.runtimeId === b.runtimeId && a.extensionId === b.extensionId;
}

function permissionChoice(request: InteractionRequest, response: InteractionResponse): PermissionChoice | undefined {
  if (response.kind === "cancel") return "deny"; // Preserve the existing explicit-cancel decision.
  if (request.kind === "confirm" && response.kind === "confirm") return response.value ? "allow-once" : "deny";
  if (request.kind !== "select" || response.kind !== "select" || !request.options.some(option => option.value === response.value)) return undefined;
  switch (response.value) {
    case "allow-once": case "allow-and-accept-edits": case "deny": return response.value;
    default: return undefined;
  }
}

function permissionOutput(choice: PermissionChoice): ClaudeHookOutput {
  return { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: choice === "deny"
    ? { behavior: "deny", message: "Orbis 拒绝了 Claude Code 工具权限请求" }
    : { behavior: "allow", ...(choice === "allow-and-accept-edits" ? {
      updatedPermissions: [{ type: "setMode", mode: "acceptEdits", destination: "session" }],
    } : {}) } } };
}

function denyQuestion(reason: string): ClaudeHookOutput {
  return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } };
}

/** No decision: Claude Code continues with its native permission dialog or question. */
function passthrough(): ClaudeHookOutput { return {}; }

function safeSummary(input: Record<string, unknown>): string {
  try { return JSON.stringify(input).slice(0, 4_000); } catch { return "工具参数不可序列化"; }
}
