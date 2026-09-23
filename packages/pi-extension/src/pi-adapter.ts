import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import {
  RuntimeTurnTimingSchema,
  selectSessionSyncSnapshot,
  type ChatMessage,
  type RemoteContent,
  type RuntimeContextUsage,
  type RuntimeEvent,
  type RuntimeModelInfo,
  type RuntimeTurnTiming,
  type SessionCatalogEntry,
} from "@pi-remote/protocol";
import type {
  RuntimeSessionSync,
  RuntimeSessionSyncRequest,
} from "@pi-remote/runtime-bridge";

import { safeValue } from "./safe-value.js";

const PROCESS_RUNTIME_ID = Symbol.for("@pi-remote/pi-runtime-id");

type ProcessScope = { [key: symbol]: unknown };

export function processRuntimeId(scope: object = globalThis): string {
  const processScope = scope as ProcessScope;
  const existing = processScope[PROCESS_RUNTIME_ID];
  if (typeof existing === "string") return existing;
  const created = randomUUID();
  processScope[PROCESS_RUNTIME_ID] = created;
  return created;
}

/**
 * OS hostname of the machine running Pi. Sent as the Runtime's device identity so the APP can
 * separate Pi processes on different devices without any user configuration.
 */
export function runtimeHostname(): string | undefined {
  try {
    const value = hostname().trim();
    return value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

/** Structural view of the Pi values the remote composer status needs, so tests can stub them. */
export type RemoteContextSource = {
  model?: unknown;
  thinkingLevel?: unknown;
  getContextUsage?: () => unknown;
};

export type RemoteContextSnapshot = {
  model?: RuntimeModelInfo;
  thinkingLevel?: string;
  contextUsage?: RuntimeContextUsage;
};

/**
 * Active model, thinking level, and context utilization reported to paired devices. All halves are
 * optional: Pi may have no model selected, may not expose a thinking level, and its token estimate
 * is `null` right after compaction. Returning an empty object instead of null-ish fields keeps
 * `RuntimeMetadata` unchanged for older APP versions.
 */
export function runtimeContextSnapshot(context: RemoteContextSource): RemoteContextSnapshot {
  const model = remoteModelInfo(context.model);
  const thinkingLevel = trimmedText(context.thinkingLevel, 64);
  const contextUsage = remoteContextUsage(context.getContextUsage?.());
  return {
    ...(model === undefined ? {} : { model }),
    ...(thinkingLevel === undefined ? {} : { thinkingLevel }),
    ...(contextUsage === undefined ? {} : { contextUsage }),
  };
}

function remoteModelInfo(value: unknown): RuntimeModelInfo | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const candidate = value as { provider?: unknown; id?: unknown; name?: unknown };
  const provider = trimmedText(candidate.provider, 128);
  const id = trimmedText(candidate.id, 256);
  if (provider === undefined || id === undefined) return undefined;
  const name = trimmedText(candidate.name, 256);
  return { provider, id, ...(name === undefined ? {} : { name }) };
}

function remoteContextUsage(value: unknown): RuntimeContextUsage | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const candidate = value as { tokens?: unknown; contextWindow?: unknown; percent?: unknown };
  const contextWindow = safeInteger(candidate.contextWindow);
  // A window of 0 would make every percentage meaningless, so treat it as unknown instead.
  if (contextWindow === undefined || contextWindow <= 0) return undefined;
  const tokens = safeInteger(candidate.tokens);
  const reported = typeof candidate.percent === "number" && Number.isFinite(candidate.percent)
    ? candidate.percent
    : undefined;
  const percent = tokens === undefined
    ? null
    : clampPercent(reported ?? (tokens / contextWindow) * 100);
  return { tokens: tokens ?? null, contextWindow, percent };
}

function trimmedText(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed.slice(0, maxLength);
}

function safeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.round(value)
    : undefined;
}

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value));
}

type PiContent = {
  type?: unknown;
  text?: unknown;
  thinking?: unknown;
  id?: unknown;
  name?: unknown;
  arguments?: unknown;
  mimeType?: unknown;
};

type PiMessage = {
  role?: unknown;
  content?: unknown;
  provider?: unknown;
  model?: unknown;
  api?: unknown;
  diagnostics?: unknown;
  timestamp?: unknown;
  toolCallId?: unknown;
  toolName?: unknown;
  isError?: unknown;
  stopReason?: unknown;
  errorMessage?: unknown;
  command?: unknown;
  output?: unknown;
  customType?: unknown;
  summary?: unknown;
};

type PiEntry = {
  type?: unknown;
  id?: unknown;
  parentId?: unknown;
  message?: unknown;
  customType?: unknown;
  content?: unknown;
  details?: unknown;
  data?: unknown;
  timestamp?: unknown;
};

export const REMOTE_TURN_STARTED_CUSTOM_TYPE = "pi_remote_turn_started";
export const REMOTE_TURN_TIMING_CUSTOM_TYPE = "pi_remote_turn_timing";

type AssistantDelta = {
  type?: unknown;
  delta?: unknown;
  contentIndex?: unknown;
};

const contentBlocks = (message: PiMessage): RemoteContent[] => {
  if (typeof message.content === "string") return [{ type: "text", text: message.content }];
  if (!Array.isArray(message.content)) {
    if (typeof message.summary === "string") return [{ type: "text", text: message.summary }];
    if (typeof message.output === "string") return [{ type: "text", text: message.output }];
    return [];
  }

  return message.content.flatMap((raw): RemoteContent[] => {
    if (!raw || typeof raw !== "object") return [];
    const block = raw as PiContent;
    if (block.type === "text" && typeof block.text === "string") return [{ type: "text", text: block.text }];
    if (block.type === "thinking" && typeof block.thinking === "string") {
      return [{ type: "thinking", text: block.thinking }];
    }
    if (
      block.type === "toolCall" &&
      typeof block.id === "string" &&
      typeof block.name === "string"
    ) {
      return [{
        type: "tool_call",
        toolCallId: block.id,
        toolName: block.name,
        arguments: block.arguments,
      }];
    }
    if (block.type === "image") {
      return [{ type: "text", text: `[Image omitted${typeof block.mimeType === "string" ? `: ${block.mimeType}` : ""}]` }];
    }
    return [];
  });
};

const remoteRole = (role: unknown): ChatMessage["role"] => {
  if (role === "user" || role === "assistant") return role;
  if (role === "toolResult") return "tool";
  if (role === "custom" || role === "bashExecution") return "custom";
  return "system";
};

type PiDiagnostic = {
  type?: unknown;
  error?: unknown;
  details?: unknown;
};

const diagnosticDetailKeys = [
  "provider", "model", "url", "status", "statusText", "phase", "configuredTransport",
  "fallbackTransport", "eventsEmitted", "requestBytes", "requestId",
] as const;

const diagnosticValue = (value: unknown): string | undefined => {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? undefined : serialized;
  } catch {
    return undefined;
  }
};

/** Keeps provider diagnostics useful without forwarding stacks, bodies, or credentials. */
const failureText = (message: PiMessage): string => {
  const base = typeof message.errorMessage === "string" && message.errorMessage.trim()
    ? message.errorMessage.trim()
    : "Provider request failed";
  const provider = typeof message.provider === "string" ? message.provider : undefined;
  const model = typeof message.model === "string" ? message.model : undefined;
  const api = typeof message.api === "string" ? message.api : undefined;
  const context = provider === undefined && model === undefined && api === undefined
    ? undefined
    : `provider=${provider ?? "?"}, model=${model ?? "?"}${api === undefined ? "" : `, api=${api}`}`;
  const diagnostics = Array.isArray(message.diagnostics) ? message.diagnostics : [];
  const diagnosticLines = diagnostics.flatMap((raw): string[] => {
    if (!raw || typeof raw !== "object") return [];
    const diagnostic = raw as PiDiagnostic;
    const parts: string[] = [];
    if (typeof diagnostic.type === "string" && diagnostic.type.trim()) parts.push(diagnostic.type.trim());
    if (diagnostic.error && typeof diagnostic.error === "object") {
      const error = diagnostic.error as { name?: unknown; message?: unknown; code?: unknown };
      const errorMessage = typeof error.message === "string" ? error.message.trim() : undefined;
      const errorCode = diagnosticValue(error.code);
      const errorName = typeof error.name === "string" ? error.name.trim() : undefined;
      if (errorName && errorName !== "Error") parts.push(errorName);
      if (errorMessage && errorMessage !== base) parts.push(errorMessage);
      if (errorCode) parts.push(`code=${errorCode}`);
    }
    if (diagnostic.details && typeof diagnostic.details === "object") {
      const details = diagnostic.details as Record<string, unknown>;
      for (const key of diagnosticDetailKeys) {
        const value = diagnosticValue(details[key]);
        if (value !== undefined) parts.push(`${key}=${value}`);
      }
    }
    return parts.length > 0 ? [parts.join("; ")] : [];
  });
  return [base, context, ...diagnosticLines].filter((line): line is string => line !== undefined).join("\n").slice(0, 4_000);
};

export function messageToRemote(messageId: string, raw: unknown): ChatMessage {
  const message = (raw && typeof raw === "object" ? raw : {}) as PiMessage;
  const content = contentBlocks(message);
  const failed = message.isError === true || message.stopReason === "error" || message.stopReason === "aborted";
  if (failed && (message.role === "assistant" || typeof message.errorMessage === "string" || Array.isArray(message.diagnostics))) {
    const error = failureText(message);
    if (!content.some((block) => block.type === "text" && block.text === error)) {
      content.push({ type: "text", text: error });
    }
  }
  return {
    messageId,
    role: remoteRole(message.role),
    content,
    timestamp: typeof message.timestamp === "number" ? message.timestamp : Date.now(),
    ...(typeof message.toolCallId === "string" ? { toolCallId: message.toolCallId } : {}),
    ...(typeof message.toolName === "string" ? { toolName: message.toolName } : {}),
    ...(typeof message.isError === "boolean" || failed ? { isError: failed || message.isError === true } : {}),
  };
}

export function turnTimingsFromEntries(entries: readonly unknown[]): RuntimeTurnTiming[] {
  const timings = new Map<string, RuntimeTurnTiming>();
  for (const raw of entries) {
    if (!raw || typeof raw !== "object") continue;
    const entry = raw as PiEntry;
    if (entry.type !== "custom" || entry.customType !== REMOTE_TURN_TIMING_CUSTOM_TYPE) continue;
    const timing = RuntimeTurnTimingSchema.safeParse(entry.data);
    if (timing.success) timings.set(timing.data.turnId, timing.data);
  }
  return [...timings.values()];
}

export function mergeTurnTimings(
  ...sources: readonly (readonly RuntimeTurnTiming[])[]
): RuntimeTurnTiming[] {
  const timings = new Map<string, RuntimeTurnTiming>();
  for (const source of sources) {
    for (const timing of source) {
      timings.set(timing.turnId, timing);
    }
  }
  return [...timings.values()];
}

const sessionEntryData = (entry: Record<string, unknown>): Record<string, unknown> => {
  const data: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(entry)) {
    if (key === "type" || key === "id" || key === "parentId" || key === "timestamp") continue;
    const safe = safeValue(value);
    if (safe !== undefined) data[key] = safe;
  }
  // The APP renders the chat from persisted entries, so the reason a provider request failed has
  // to travel with the entry. Without it a failed turn projects to a message with no content and
  // the phone silently shows nothing (the live stream carries the same text via `messageToRemote`).
  const failure = entry.type === "message" ? failureTextForEntry(entry.message) : undefined;
  if (failure !== undefined) data.remoteFailure = failure;
  return data;
};

/** Same failure text the live `message.started/finished` events carry, so both paths agree byte for byte. */
function failureTextForEntry(raw: unknown): string | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const message = raw as PiMessage;
  const failed = message.isError === true || message.stopReason === "error" || message.stopReason === "aborted";
  if (!failed) return undefined;
  if (message.role !== "assistant" && typeof message.errorMessage !== "string" && !Array.isArray(message.diagnostics)) {
    return undefined;
  }
  return failureText(message);
}

type RemoteSessionEntryInput = {
  entryId: string;
  parentId: string | null;
  type: string;
  timestamp: string;
  data: Record<string, unknown>;
};

export function sessionCatalogFromInfos(infos: readonly unknown[]): SessionCatalogEntry[] {
  return infos.flatMap((raw): SessionCatalogEntry[] => {
    if (!raw || typeof raw !== "object") return [];
    const info = raw as {
      id?: unknown;
      name?: unknown;
      cwd?: unknown;
      firstMessage?: unknown;
      created?: unknown;
      modified?: unknown;
      messageCount?: unknown;
    };
    const createdAt = info.created instanceof Date ? info.created.getTime() : NaN;
    const modifiedAt = info.modified instanceof Date ? info.modified.getTime() : NaN;
    if (typeof info.id !== "string" || typeof info.cwd !== "string" ||
      !Number.isSafeInteger(createdAt) || !Number.isSafeInteger(modifiedAt) ||
      typeof info.messageCount !== "number" || !Number.isSafeInteger(info.messageCount) || info.messageCount < 0) {
      return [];
    }
    return [{
      sessionId: info.id,
      ...(typeof info.name === "string" && info.name.trim() ? { name: info.name.trim().slice(0, 256) } : {}),
      cwd: info.cwd,
      ...(typeof info.firstMessage === "string" && info.firstMessage ? { firstMessage: info.firstMessage.slice(0, 4_000) } : {}),
      createdAt,
      modifiedAt,
      messageCount: info.messageCount,
    }];
  });
}

export function sessionEntriesFromEntries(entries: readonly unknown[]): RemoteSessionEntryInput[] {
  return entries.flatMap((raw): RemoteSessionEntryInput[] => {
    if (!raw || typeof raw !== "object") return [];
    const entry = raw as PiEntry;
    if (typeof entry.id !== "string" || typeof entry.type !== "string" || typeof entry.timestamp !== "string") return [];
    return [{
      entryId: entry.id,
      parentId: typeof entry.parentId === "string" ? entry.parentId : null,
      type: entry.type,
      timestamp: entry.timestamp,
      data: sessionEntryData(entry as Record<string, unknown>),
    }];
  });
}

/** Both backends page the same canonical Entry format under the same byte budget. */
export function sessionGraphFromEntries(
  entries: readonly unknown[],
  sessionId: string,
  leafId: string | null,
  request: RuntimeSessionSyncRequest,
  turnTimings: readonly RuntimeTurnTiming[] = [],
): RuntimeSessionSync {
  return selectSessionSyncSnapshot(
    sessionEntriesFromEntries(entries), sessionId, leafId, request,
    mergeTurnTimings(turnTimings, turnTimingsFromEntries(entries)),
  );
}
/** Upper bound on remembered persisted entry ids, so a long session cannot grow unbounded. */
const MAX_REPORTED_ENTRY_IDS = 4_096;

export class PiMessageStream {
  readonly #createId: () => string;
  readonly #finishedMessageIds = new WeakMap<object, string>();
  readonly #activeMessageIds = new WeakMap<object, string>();
  readonly #activeMessages = new Set<object>();
  /** Ids of messages that started but have not finished yet, oldest first. */
  readonly #startedMessageIds: string[] = [];
  /** Entry ids already announced, so each turn only reports the entries it appended. */
  readonly #reportedEntryIds = new Set<string>();
  #lastMessageId: string | undefined;

  constructor(createId: () => string = randomUUID) {
    this.#createId = createId;
  }

  started(message: unknown, persistedId?: string): Extract<RuntimeEvent, { type: "message.started" }> {
    const messageId = persistedId ?? this.#createId();
    if (!this.#startedMessageIds.includes(messageId)) this.#startedMessageIds.push(messageId);
    this.#lastMessageId = messageId;
    if (message !== null && typeof message === "object") {
      this.#activeMessageIds.set(message, messageId);
      this.#activeMessages.add(message);
    }
    return {
      type: "message.started",
      message: messageToRemote(messageId, message),
    };
  }

  updated(event: AssistantDelta, message?: unknown): Extract<RuntimeEvent, { type: "message.delta" }> | undefined {
    const hasMessageObject = message !== null && typeof message === "object";
    // Pi emits message_start and every message_update with a fresh shallow copy of the partial
    // message, so object identity cannot correlate the stream. Prefer a known mapping, then fall
    // back to the most recently started message; assistant deltas only belong to that stream.
    const activeMessageId = (hasMessageObject ? this.#activeMessageIds.get(message) : undefined)
      ?? this.#lastMessageId;
    if (!activeMessageId || typeof event.delta !== "string") return undefined;
    const contentType = event.type === "thinking_delta"
      ? "thinking"
      : event.type === "toolcall_delta"
        ? "tool_call"
        : event.type === "text_delta"
          ? "text"
          : undefined;
    if (!contentType) return undefined;
    return {
      type: "message.delta",
      messageId: activeMessageId,
      contentType,
      ...(typeof event.contentIndex === "number" ? { contentIndex: event.contentIndex } : {}),
      delta: event.delta,
    };
  }

  finished(message: unknown): Extract<RuntimeEvent, { type: "message.finished" }> {
    const objectMessage = message !== null && typeof message === "object" ? message : undefined;
    const mappedMessageId = objectMessage === undefined
      ? undefined
      : this.#finishedMessageIds.get(objectMessage) ?? this.#activeMessageIds.get(objectMessage);
    // Pi emits `message_start` and `message_end` with different shallow copies of the same message,
    // so the identity recorded at start is not enough to pair the end. Falling back to the newest
    // started-but-unfinished message keeps one id across the whole stream; a fresh id here would
    // make the APP render the streamed row and the finished row as two separate replies.
    const messageId = mappedMessageId
      ?? this.#startedMessageIds[this.#startedMessageIds.length - 1]
      ?? this.#createId();
    if (objectMessage) {
      this.#finishedMessageIds.set(objectMessage, messageId);
    }
    this.#forget(messageId);
    return { type: "message.finished", message: messageToRemote(messageId, message) };
  }

  /**
   * Retires one message from the pending registry. Object identity alone is not enough: the copy Pi
   * passes to `message_end` differs from the copy passed to `message_start`, so the start would stay
   * registered and every later end would look ambiguous. Dropping stale copies by id keeps the
   * registry (and the "newest unfinished message") accurate for the rest of the turn.
   */
  #forget(messageId: string): void {
    const index = this.#startedMessageIds.lastIndexOf(messageId);
    if (index >= 0) this.#startedMessageIds.splice(index, 1);
    for (const tracked of this.#activeMessages) {
      if (this.#activeMessageIds.get(tracked) !== messageId) continue;
      this.#activeMessageIds.delete(tracked);
      this.#activeMessages.delete(tracked);
    }
    this.#lastMessageId = this.#startedMessageIds[this.#startedMessageIds.length - 1];
  }

  messageIdFor(message: unknown): string | undefined {
    if (message === null || typeof message !== "object") return undefined;
    return this.#finishedMessageIds.get(message);
  }

  /**
   * Pairs the temporary ids this stream handed out with the Pi session entry ids their messages were
   * persisted under. Pi stores the exact object it passed to `message_end` (`appendMessage` keeps the
   * reference) and hands the same object to `turn_end`, so this is a plain identity lookup: the
   * Runtime can resolve the mapping exactly, where a device could only guess by matching message
   * content. Entries already announced are skipped so a turn reports only what it appended.
   */
  persistedMessageMappings(entries: readonly unknown[]): { messageId: string; entryId: string }[] {
    const mappings: { messageId: string; entryId: string }[] = [];
    for (const raw of entries) {
      if (!raw || typeof raw !== "object") continue;
      const entry = raw as PiEntry;
      if (entry.type !== "message" || typeof entry.id !== "string") continue;
      if (this.#reportedEntryIds.has(entry.id)) continue;
      const messageId = this.messageIdFor(entry.message);
      if (messageId === undefined) continue;
      this.#rememberReportedEntryId(entry.id);
      mappings.push({ messageId, entryId: entry.id });
    }
    return mappings;
  }

  #rememberReportedEntryId(entryId: string): void {
    if (this.#reportedEntryIds.size >= MAX_REPORTED_ENTRY_IDS) {
      const oldest = this.#reportedEntryIds.values().next().value;
      if (oldest !== undefined) this.#reportedEntryIds.delete(oldest);
    }
    this.#reportedEntryIds.add(entryId);
  }
}
