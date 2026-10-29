import { createToolSummary, type ToolSummary } from "./tool-activity.js";
import type { AgentKey } from "./agent-state.js";
import type { ChatMessage, RemoteContent, RemoteSessionEntry } from "./index.js";

const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value)
  ? value as Record<string, unknown> : {};
export type ToolMessageProjectionContext = { agent: AgentKey; order: number; entryId?: string;
  phase?: ToolSummary["phase"]; readCapability?: "range" | "whole-source" | "none"; contents?: ToolSummary["contents"] };

/** Shared Pi/DSH facts only. Unknown tool inputs never become serialized JSON previews. */
export function messageToolSummary(context: ToolMessageProjectionContext, callId: string, name: string,
  args?: unknown, isError?: boolean): ToolSummary {
  const input = record(args);
  const path = typeof input.path === "string" ? input.path : typeof input.file_path === "string" ? input.file_path
    : typeof input.notebook_path === "string" ? input.notebook_path : undefined;
  // Claude Code names its tools in PascalCase and its paths `file_path`.
  const inputSummary = ["bash", "shell", "execute", "commandExecution", "Bash"].includes(name) && typeof input.command === "string" ? input.command
    : ["read", "write", "edit", "Read", "Write", "Edit", "MultiEdit", "NotebookEdit"].includes(name) && path !== undefined ? path
      : ["Grep", "Glob"].includes(name) && typeof input.pattern === "string" ? input.pattern
        : undefined;
  const phase = context.phase ?? "started", terminal = phase === "finished" || phase === "cancelled";
  const capability = context.readCapability ?? "none";
  return createToolSummary({ tool: { agent: context.agent, toolCallId: callId }, toolName: name, phase,
    order: context.order, ...(context.entryId === undefined ? {} : { entryId: context.entryId }),
    ...(isError === undefined ? {} : { isError }), ...(inputSummary === undefined ? {} : { inputSummary }),
    contents: context.contents ?? (terminal ? ["result"] as const : ["arguments"] as const).map(part => ({
      part, format: "json", availability: capability === "none" ? "temporarily-unavailable" : "readable", readCapability: capability,
    })) });
}

/** ADR-0045 §1/§3：工具结果没有正文副本；调用位置只保留有界摘要与身份。 */
export function projectToolMessage(context: ToolMessageProjectionContext, message: ChatMessage): ChatMessage {
  if (message.role === "tool" && message.toolCallId) {
    const toolSummary = message.toolSummary ?? messageToolSummary({ ...context, phase: "finished" },
      message.toolCallId, message.toolName ?? "tool", undefined, message.isError);
    return { messageId: message.messageId, role: "tool", timestamp: message.timestamp, toolCallId: message.toolCallId,
      toolName: toolSummary.toolName, ...(toolSummary.isError === undefined ? {} : { isError: toolSummary.isError }),
      content: [], toolSummary };
  }
  if (!message.content.some(part => part.type === "tool_call")) return message;
  return { ...message, content: message.content.map(part => part.type !== "tool_call" ? part : {
    type: "tool_call", toolCallId: part.toolCallId, toolName: part.toolName,
    summary: part.summary ?? messageToolSummary(context, part.toolCallId, part.toolName, part.arguments),
  }) };
}

export function projectToolEntry(context: ToolMessageProjectionContext, entry: RemoteSessionEntry): RemoteSessionEntry {
  const raw = record(entry.data.message);
  if (typeof raw.role !== "string" || !Array.isArray(raw.content)) return entry;
  const toolResult = raw.role === "tool" || raw.role === "toolResult";
  const hasCall = raw.content.some(value => ["toolCall", "tool_call"].includes(String(record(value).type)));
  if (!toolResult && !hasCall) return entry;
  const content: RemoteContent[] = toolResult ? [] : raw.content.flatMap<RemoteContent>(value => {
    const part = record(value);
    if (part.type === "toolCall" || part.type === "tool_call") return [{ type: "tool_call" as const,
      toolCallId: String(part.toolCallId ?? part.id), toolName: String(part.toolName ?? part.name), arguments: part.arguments,
      ...(part.summary === undefined ? {} : { summary: part.summary as ToolSummary }) }];
    if (part.type === "thinking") return [{ type: "thinking" as const, text: String(part.thinking ?? part.text ?? "") }];
    if (part.type === "artifact" && part.artifact) return [value as RemoteContent];
    return part.type === "text" ? [{ type: "text" as const, text: String(part.text ?? "") }] : [];
  });
  const message = projectToolMessage({ ...context, entryId: entry.entryId }, {
    messageId: typeof raw.messageId === "string" ? raw.messageId : entry.entryId,
    role: toolResult ? "tool" : "assistant", timestamp: typeof raw.timestamp === "number" ? raw.timestamp : Date.parse(entry.timestamp),
    content, ...(toolResult ? { toolCallId: typeof raw.toolCallId === "string" ? raw.toolCallId : entry.entryId } : {}),
    ...(typeof raw.toolName === "string" ? { toolName: raw.toolName } : {}),
    ...(typeof raw.isError === "boolean" ? { isError: raw.isError } : {}),
    ...(raw.toolSummary === undefined ? {} : { toolSummary: raw.toolSummary as ToolSummary }),
  });
  // Canonical metadata and non-tool blocks (including ADR-0034 image references) retain their
  // original representation. Only tool bodies change projection version.
  const canonical = toolResult ? { ...message, role: "toolResult" } : { ...raw, content: raw.content.map(value => {
    const part = record(value);
    if (part.type !== "toolCall" && part.type !== "tool_call") return value;
    return message.content.find(block => block.type === "tool_call" && block.toolCallId === String(part.toolCallId ?? part.id));
  }) };
  return { ...entry, data: { ...entry.data, message: canonical } };
}
