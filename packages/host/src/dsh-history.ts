/** Read canonical logs through DSH's own versioned, read-only persistence API. */
import { readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { ChatMessage, RemoteContent, RemoteSessionEntry } from "@pi-remote/protocol";
import { record } from "./dsh-client.js";

export type DshHeader = { id: string; cwd?: string; createdAt: number };
export type DshLog = { header: DshHeader; events: Array<{ seq: number; time?: number; type: string; data: unknown }> };
/**
 * 日志文件的廉价变更判据：`size:mtimeMs`。
 *
 * DSH 的持久化 API 只提供整份读（实测 8.7MB 日志一次约 420ms，跑在 Host 事件循环上），
 * 因此"文件没变就复用上次解析结果"必须靠文件系统事实，而不是再读一遍。
 */
export function dshLogStatKey(file: string | undefined): string | undefined {
  if (file === undefined) return undefined;
  try { const info = statSync(file); return `${info.size}:${info.mtimeMs}`; } catch { return undefined; }
}

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
  // ADR-0035 §11：DSH 的 API 只给整份日志，而实测 8.7MB 日志一次 read 要 ~420ms
  // （5240 个 zstd 帧解压 163ms + 11,978 行逐行解析 261ms）。它跑在 Host 的事件循环上，
  // 单线程会连带卡住所有设备的事件。这里用文件 stat 做廉价判据：文件没变就复用上次的解析结果。
  const caches = new Map<string, { key: string; log: DshLog }>();
  const paths = new Map<string, string | undefined>();
  const fileFor = (sessionId: string): string | undefined => {
    if (paths.has(sessionId)) return paths.get(sessionId);
    let found: string | undefined;
    try {
      for (const project of readdirSync(root)) {
        const candidate = join(root, project, `session-${sessionId}`, "session.v4.jsonl.zstd");
        try { if (statSync(candidate).isFile()) { found = candidate; break; } } catch { /* 不是这个项目目录 */ }
      }
    } catch { /* 目录不可读：退回 API 读取 */ }
    paths.set(sessionId, found);
    return found;
  };
  return {
    async list() { return (await ctx.sessionPersistence.list()).map((item: { header: DshHeader }) => item.header); },
    async read(sessionId) {
      const file = fileFor(sessionId);
      const key = dshLogStatKey(file);
      const cached = key === undefined ? undefined : caches.get(sessionId);
      if (cached !== undefined && key !== undefined && cached.key === key) return cached.log;
      const handle = await ctx.sessionPersistence.open(sessionId, "read");
      try {
        const { events } = await handle.read();
        const log = { header: handle.header, events } as DshLog;
        if (key !== undefined) caches.set(sessionId, { key, log });
        return log;
      } finally { await handle.close(); }
    },
    async close() { caches.clear(); await ctx.fiber.dispose(); },
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

/**
 * ACP does not replay history. Source seqs, IDs and event times stay stable across every read,
 * so a per-seq cache lets an incremental refresh reuse the entry objects it already produced.
 * 复用对象是 ADR-0035 §1/§2 的前提：`reconcile` 才能用引用相等判断"没变"。
 */
export function dshEntries(log: DshLog, cache?: Map<number, RemoteSessionEntry>): RemoteSessionEntry[] {
  const entries: RemoteSessionEntry[] = [];
  const tools = new Map<string, string>();
  for (const event of log.events) {
    if (event.type === "tool/call") {
      const call = record(event.data);
      tools.set(String(call.callId), String(call.name));
    }
    if (!["user/message", "assistant/message", "tool/result"].includes(event.type)) continue;
    const cached = cache?.get(event.seq);
    if (cached !== undefined) { entries.push(cached); continue; }
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
    const entry: RemoteSessionEntry = { entryId, parentId: entries.at(-1)?.entryId ?? null, type: "message", timestamp: new Date(time).toISOString(), data: { message } };
    cache?.set(event.seq, entry);
    entries.push(entry);
  }
  return entries;
}
