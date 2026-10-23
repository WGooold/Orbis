import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import type { ChatMessage, RemoteSessionEntry, RuntimeSlashCommandOption } from "@pi-remote/protocol";
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

const treeEventLabels: Record<string, string> = {
  "turn/start": "回合开始",
  "turn/end": "回合结束",
  "tool/call": "工具调用",
  "session/title": "会话标题",
};

const entryMessage = (entry: RemoteSessionEntry): JsonObject | undefined => {
  const message = entry.data.message;
  return message !== null && typeof message === "object" && !Array.isArray(message) ? message as JsonObject : undefined;
};

/** 条目正文（只取 text 块）：历史页的预览与「编辑并重新开始」的原文都用它。 */
export function dshWebEntryText(entry: RemoteSessionEntry): string {
  const content = entryMessage(entry)?.content;
  return (Array.isArray(content) ? content : [])
    .flatMap(part => {
      const block = part !== null && typeof part === "object" ? part as JsonObject : {};
      return block.type === "text" && typeof block.text === "string" ? [block.text] : [];
    })
    .join("\n")
    .trim();
}

/** 只有思考、没有正文的助手条目仍然是一条记录，只是默认收进「细节」。 */
const entryHasThinking = (entry: RemoteSessionEntry): boolean => {
  const content = entryMessage(entry)?.content;
  return (Array.isArray(content) ? content : []).some(part => {
    const block = part !== null && typeof part === "object" ? part as JsonObject : {};
    return block.type === "thinking" && typeof block.thinking === "string" && block.thinking.trim().length > 0;
  });
};

/**
 * 历史树的窗口上限：整张树随 capabilities 下发，手机每次同步都会重读一遍。
 *
 * 2026-10-23 真机实测：2,000 条时单帧约 640KB，而 `capabilities` 会随每条 durable 事件变化一次，
 * 于是 Host 向手机反复推送 640KB 的 `agent.state.snapshot`（出站队列里一分钟堆到 20MB，手机
 * 入站 msg 面连续丢帧）。降到 500 条把单帧压到约 160KB，树页仍是「最近 500 条 + 更早的靠上翻补」
 * 的有界视图，语义不变（`packages/host/src/dsh-web-history.test.ts` 要求 ≥ 500）。
 */
export const DSH_WEB_TREE_MAX_ENTRIES = 500;

/**
 * DSH 的 durable 日志是线性的：每条事件只跟上一条相连，分支发生在**会话层面**——原生
 * `session/fork` 从某个事件切点复制前缀，得到一个新会话。所以这张树只有一条主线，
 * `parentId` 就是原生顺序，`role` 只表示这条记录能不能从它切出去。
 *
 * 只有最后 [limit] 条进树。窗口首条的 `parentId` 指向表外，手机据此说「更早的还没读到」，
 * 而不是把窗口起点伪装成会话起点；在聊天页向上翻、Host 读到更早的页之后它会自己进树。
 */
export function dshWebTreeOptions(
  entries: readonly RemoteSessionEntry[],
  limit = DSH_WEB_TREE_MAX_ENTRIES,
): RuntimeSlashCommandOption[] {
  const window = entries.length > limit ? entries.slice(-limit) : entries;
  const currentId = entries.at(-1)?.entryId;
  return window.map(entry => {
    const message = entryMessage(entry);
    const role = typeof message?.role === "string" ? message.role : undefined;
    const text = dshWebEntryText(entry);
    const event = typeof entry.data.dshEvent === "string" ? entry.data.dshEvent : undefined;
    const toolName = typeof message?.toolName === "string" ? message.toolName : undefined;
    const label = text.replace(/\s+/gu, " ").trim()
      || toolName
      || (entryHasThinking(entry) ? "思考" : undefined)
      || (event === undefined ? undefined : treeEventLabels[event] ?? event)
      || entry.type;
    return {
      value: entry.entryId,
      label: label.slice(0, 160),
      description: role ?? event ?? entry.type,
      tree: {
        parentId: entry.parentId,
        entryType: event ?? entry.type,
        ...(role === undefined ? {} : { role }),
        // 工具结果、日志事件，以及只有思考没有正文的助手条目默认收进「细节」。
        defaultHidden: role === "toolResult" || role === undefined || (role === "assistant" && text.length === 0),
        isCurrent: entry.entryId === currentId,
        isOnActivePath: true,
      },
    };
  });
}
