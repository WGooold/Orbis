/** Read canonical logs through DSH's own versioned, read-only persistence API. */
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { ChatMessage, RemoteContent, RemoteSessionEntry } from "@pi-remote/protocol";
import { record } from "./dsh-client.js";

export type DshHeader = { id: string; cwd?: string; createdAt: number };
export type DshLog = { header: DshHeader; events: Array<{ seq: number; time?: number; type: string; data: unknown }> };
export interface DshHistory {
  list(): Promise<DshHeader[]>;
  read(sessionId: string): Promise<DshLog>;
  close(): Promise<void>;
}

/** Resolve from the selected CLI, so decoder and writer always use the same DSH release. */
export async function openDshHistory(cliEntry: string, root = process.env.ORBIS_DSH_SESSIONS_ROOT ?? join(process.env.DSH_HOME ?? join(homedir(), ".dsh"), "sessions")): Promise<DshHistory> {
  const require = createRequire(cliEntry);
  const cordis = await import(pathToFileURL(require.resolve("@deepseek-ai/cordis")).href);
  const persistence = await import(pathToFileURL(require.resolve("@deepseek-ai/dsh-session-persistence-jsonl")).href);
  const ctx = new cordis.Context();
  try { await ctx.plugin(persistence.default, { root }); }
  catch (error) { await ctx.fiber.dispose(); throw error; }
  return {
    async list() { return (await ctx.sessionPersistence.list()).map((item: { header: DshHeader }) => item.header); },
    async read(sessionId) {
      const handle = await ctx.sessionPersistence.open(sessionId, "read");
      try {
        const { events } = await handle.read();
        return { header: handle.header, events } as DshLog;
      } finally { await handle.close(); }
    },
    async close() { await ctx.fiber.dispose(); },
  };
}

export function dshContent(value: unknown): RemoteContent[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((raw): RemoteContent[] => {
    const block = record(raw);
    if (block.type === "text" && typeof block.text === "string") return [{ type: "text", text: block.text }];
    if (block.type === "reasoning" && typeof block.text === "string") return [{ type: "thinking", text: block.text }];
    if (block.type === "tool-call") {
      let args = block.arguments ?? block.input;
      if (typeof args === "string") { try { args = JSON.parse(args); } catch { /* Preserve malformed model output. */ } }
      return [{ type: "tool_call", toolCallId: String(block.id), toolName: String(block.name), arguments: args ?? {} }];
    }
    if (block.type === "image") return [{ type: "text", text: "[图片：请在 DeepSeek Harness 中查看]" }];
    if (block.type === "file") return [{ type: "text", text: `[文件：${String(record(block.attachment).name ?? "请在 DeepSeek Harness 中查看")}]` }];
    return [];
  });
}

/** ACP does not replay history. Source seqs, IDs and event times stay stable across every read. */
export function dshEntries(log: DshLog): RemoteSessionEntry[] {
  const entries: RemoteSessionEntry[] = [];
  const tools = new Map<string, string>();
  for (const event of log.events) {
    if (event.type === "tool/call") {
      const call = record(event.data);
      tools.set(String(call.callId), String(call.name));
    }
    if (!["user/message", "assistant/message", "tool/result"].includes(event.type)) continue;
    const data = record(event.data);
    const raw = event.type === "user/message" ? data : record(data.message);
    const entryId = `dsh:${log.header.id}:${event.seq}`;
    const source = record(raw.source);
    const role = event.type === "user/message" ? source.kind && source.kind !== "user" ? "custom" : "user" : event.type === "assistant/message" ? "assistant" : "tool";
    const time = typeof event.time === "number" && Number.isSafeInteger(event.time) && event.time >= 0 ? event.time : 0;
    const message: ChatMessage = {
      messageId: typeof raw.id === "string" ? raw.id : entryId,
      role, content: dshContent(raw.content), timestamp: time,
      ...(role === "tool" ? { toolCallId: String(raw.toolCallId), toolName: tools.get(String(raw.toolCallId)) ?? "tool", isError: raw.isError === true } : {}),
    };
    entries.push({ entryId, parentId: entries.at(-1)?.entryId ?? null, type: "message", timestamp: new Date(time).toISOString(), data: { message } });
  }
  return entries;
}
