import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import type { ChatMessage, RemoteSessionEntry } from "@pi-remote/protocol";
import { record, type JsonObject } from "./dsh-client.js";
import { dshContent } from "./dsh-history.js";

export type DshWebLogEvent = { seq: number; time: number; type: string; data: unknown };
export type DshStreamDecoder = (stream: unknown[]) => { time: number; chunk: JsonObject }[];

export async function loadDshStreamDecoder(cliEntry: string): Promise<DshStreamDecoder> {
  const require = createRequire(cliEntry);
  const library = await import(pathToFileURL(require.resolve("@deepseek-ai/dsh-llm/assistant-stream")).href);
  return library.expandAssistantStream as DshStreamDecoder;
}

export function dshErrorText(error: unknown): string {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : String(record(error).message ?? "DSH request failed");
  if (/<(?:html|!doctype|head|body)\b/i.test(message)) {
    const status = message.match(/\b([45]\d\d)\b/)?.[1];
    return `模型服务返回${status ? ` HTTP ${status}` : ""} HTML 页面。请检查供应商 API 地址（通常以 /v1 结尾）和 API 格式。`;
  }
  return message.replace(/sk-[\w-]+/g, "[redacted]").slice(0, 2000);
}

// Web projections have their own versioned IDs: old ACP cache entries remain immutable.
export const dshWebEntryId = (id: string, seq: number): string => `dsh:${id}:web:${seq}`;

export function dshWebMessage(id: string, event: DshWebLogEvent, toolNames: ReadonlyMap<string, string>): ChatMessage | undefined {
  const data = record(event.data);
  const raw = event.type === "user/message" ? data : record(data.message);
  const source = record(raw.source);
  if (event.type === "user/message" && source.kind !== undefined && source.kind !== "user") return undefined;
  if (event.type === "turn/end") {
    const reason = record(data.reason);
    if (reason.kind !== "error") return undefined;
    return { messageId: dshWebEntryId(id, event.seq), role: "assistant", timestamp: event.time,
      content: [{ type: "text", text: dshErrorText(record(reason.error).message) }], isError: true };
  }
  if (!["user/message", "assistant/message", "tool/result"].includes(event.type)) return undefined;
  return {
    messageId: dshWebEntryId(id, event.seq), role: event.type === "user/message" ? "user" : event.type === "tool/result" ? "tool" : "assistant",
    timestamp: event.time, content: dshContent(raw.content),
    ...(event.type === "tool/result" ? { toolCallId: String(raw.toolCallId), toolName: toolNames.get(String(raw.toolCallId)) ?? "tool", isError: raw.isError === true } : {}),
  };
}

/** The phone consumes Pi-shaped message entries. Internal context stays out of the transcript. */
export function dshWebEntries(id: string, events: readonly DshWebLogEvent[]): RemoteSessionEntry[] {
  const tools = new Map<string, string>();
  return events.map(event => {
    const data = record(event.data);
    if (event.type === "tool/call") tools.set(String(data.callId), String(data.name));
    const message = dshWebMessage(id, event, tools);
    return {
      entryId: dshWebEntryId(id, event.seq), parentId: event.seq === 0 ? null : dshWebEntryId(id, event.seq - 1),
      timestamp: new Date(event.time).toISOString(), type: message ? "message" : "custom",
      data: message ? { message: { ...message, role: message.role === "tool" ? "toolResult" : message.role,
        content: message.content.map(block => block.type === "thinking" ? { type: "thinking", thinking: block.text } : block) } }
        : { dshEvent: event.type },
    };
  });
}
