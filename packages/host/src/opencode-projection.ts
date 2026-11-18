import { createHash } from "node:crypto";
import { createToolSummary, type ChatMessage, type InteractionRequest, type QuestionnaireQuestion, type RemoteSessionEntry,
  type SessionLiveState, type SessionLiveTurn, type ToolSummary } from "@orbis/protocol";
import type { OpenCodeClient } from "./opencode-service-connection.js";

export type NativeSession = Awaited<ReturnType<OpenCodeClient["session"]["get"]>>;
export type NativeMessage = Awaited<ReturnType<OpenCodeClient["session"]["message"]["get"]>>;
export type NativeAssistant = Extract<NativeMessage, { type: "assistant" }>;
export type NativePermission = Awaited<ReturnType<OpenCodeClient["permission"]["list"]>>[number];
export type NativeForm = Awaited<ReturnType<OpenCodeClient["session"]["form"]["get"]>>;
export type NativeField = NativeForm["fields"][number];

type ToolPart = Extract<NativeAssistant["content"][number], { type: "tool" }>;
const INTERACTION_MS = 300_000;
export const time = (value: number | undefined): number => Number.isSafeInteger(value) && value! >= 0 ? value! : 0;
export const wireId = (id: string): string => id.length <= 256 ? id : "opencode:" + createHash("sha256").update(id).digest("hex");

function toolSummary(hostId: string, sessionId: string, messageId: string, part: ToolPart, order: number): ToolSummary {
  const phase = part.state.status === "completed" || part.state.status === "error" ? "finished"
    : part.state.status === "running" ? "running" : "started";
  const startedAt = time(part.time.ran ?? part.time.created);
  // Do not copy tool-native input, content, metadata, or structured errors into any device projection.
  return createToolSummary({ tool: { agent: { hostId, agentKind: "opencode", sessionId }, toolCallId: wireId(part.id) },
    toolName: part.name.slice(0, 256) || "tool", phase, order, messageId: wireId(messageId),
    ...(part.state.status === "error" ? { isError: true } : {}),
    ...(part.time.completed === undefined ? {} : { durationMs: Math.max(0, time(part.time.completed) - startedAt) }),
    contents: [
      { part: "arguments", format: "json", availability: "unrecoverable", readCapability: "none" },
      ...(phase === "finished" ? [{ part: "result" as const, format: "json" as const, availability: "unrecoverable" as const, readCapability: "none" as const }] : []),
    ],
  });
}

export function projectAssistant(hostId: string, sessionId: string, native: NativeAssistant): ChatMessage {
  const content: ChatMessage["content"] = [];
  for (const [order, part] of native.content.entries()) {
    if (part.type === "tool") {
      const summary = toolSummary(hostId, sessionId, native.id, part, order);
      content.push({ type: "tool_call", toolCallId: summary.tool.toolCallId, toolName: summary.toolName, summary });
    } else if (part.text) content.push({ type: part.type === "text" ? "text" : "thinking", text: part.text });
  }
  return { messageId: wireId(native.id), role: "assistant", content, timestamp: time(native.time.created),
    ...(native.error === undefined ? {} : { isError: true }) };
}

export function projectHistory(hostId: string, sessionId: string, messages: readonly NativeMessage[], active: boolean): RemoteSessionEntry[] {
  const entries: RemoteSessionEntry[] = [];
  for (const native of messages) {
    // Preserve the native ordering of displayable entries. Internal config/skill/shell/system rows may contain
    // prompts or tool results, so keep only their identity and type, not their payload.
    if (active && native.type === "assistant" && native.time.completed === undefined) continue;
    const entryId = wireId(native.id);
    const createdAt = "time" in native && "created" in native.time ? time(native.time.created) : 0;
    const previous = entries.at(-1)?.entryId ?? null;
    let type: string = `opencode.${native.type}`;
    let data: RemoteSessionEntry["data"] = {};
    if (native.type === "user") {
      type = "message";
      const content: ChatMessage["content"] = native.text ? [{ type: "text", text: native.text }] : [];
      data = { message: { messageId: entryId, role: "user", content, timestamp: createdAt } satisfies ChatMessage };
    } else if (native.type === "assistant") {
      type = "message";
      data = { message: projectAssistant(hostId, sessionId, native) };
    } else if (native.type === "compaction" && native.status === "completed") {
      type = "compaction";
      data = { summary: native.summary };
    }
    entries.push({ entryId, parentId: previous, type, timestamp: String(createdAt), data });
  }
  return entries;
}

export function projectLive(turn: SessionLiveTurn | null, assistant: ChatMessage | undefined): SessionLiveState {
  const summaries = assistant?.content.flatMap(block => block.type === "tool_call" && block.summary !== undefined ? [block.summary] : []) ?? [];
  const tools: SessionLiveState["tools"] = summaries.slice(-256).map(summary => ({
    toolCallId: summary.tool.toolCallId, toolName: summary.toolName, summary,
    state: summary.phase === "finished" ? "finished" : summary.phase === "running" ? "updated" : "started",
    ...(summary.isError === undefined ? {} : { isError: summary.isError }),
  }));
  return { turn, complete: summaries.length <= 256, tools,
    messages: assistant ? [{ message: assistant, finished: false, contentComplete: true }] : [] };
}

export function permissionRequest(runtimeId: string, permission: NativePermission, now: number): InteractionRequest {
  return { kind: "confirm", runtimeId, requestId: permission.id, extensionId: "opencode.permission",
    title: permission.action.slice(0, 256) || "OpenCode permission", toolName: permission.action.slice(0, 256) || "permission",
    confirmLabel: "Allow once", cancelLabel: "Reject",
    ...(permission.message === undefined ? {} : { description: permission.message.slice(0, 4_000) }),
    expiresAt: now + INTERACTION_MS };
}

function question(field: NativeField): QuestionnaireQuestion | undefined {
  if (field.type === "external" || !field.key || field.key.length > 256) return undefined;
  const base = { id: field.key, question: (field.title || field.key).slice(0, 4_000),
    ...(field.description === undefined ? {} : { header: field.description.slice(0, 100) }) };
  if (field.type === "boolean") return { ...base, options: [{ value: "true", label: "Yes" }, { value: "false", label: "No" }] };
  const native = (field.type === "string" || field.type === "multiselect") ? field.options ?? [] : [];
  if (native.length > 32 || native.some(option => !option.value || option.value.length > 256) ||
      new Set(native.map(option => option.value)).size !== native.length) return undefined;
  const options = native.map(({ value, label, description }) => ({ value, label: label.slice(0, 512) || value,
    ...(description === undefined ? {} : { description: description.slice(0, 4_000) }) }));
  const allowOther = options.length === 0 || ("custom" in field && field.custom === true);
  return { ...base, options, ...(allowOther ? { allowOther: true } : {}), ...(field.type === "multiselect" ? { multiSelect: true } : {}) };
}

export function formRequest(runtimeId: string, form: NativeForm, now: number): InteractionRequest | undefined {
  // The current App questionnaire cannot reproduce conditional, hidden, or external inputs.
  if (form.state.status !== "pending" || form.fields.length > 16 || form.fields.some(field =>
    field.type === "external" || field.hidden || field.when?.length)) return undefined;
  const questions = form.fields.map(question).filter((item): item is QuestionnaireQuestion => item !== undefined);
  if (questions.length === 0 || questions.length !== form.fields.length || new Set(questions.map(item => item.id)).size !== questions.length) return undefined;
  return { kind: "questionnaire", runtimeId, requestId: form.id, extensionId: "opencode.form", title: form.title.slice(0, 256) || "OpenCode question",
    questions, expiresAt: now + INTERACTION_MS };
}
