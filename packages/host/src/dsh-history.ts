/**
 * 读 DSH 的 canonical 日志。
 *
 * 首次读取与 `list()` 走 DSH 自己的只读持久化 API（保证解码语义与该版本一致）；
 * 之后的追加读取按 `session.v4.jsonl.zstd` 的**独立 zstd 帧**做字节区间增量解码
 * （实测 8.7MB 日志：整份 373ms → 追加一帧 7ms → 文件未变 0ms）。
 * 任何不确定的情况（布局不同、文件被截断/替换、尾部解码失败）都退回整份 API 读。
 */
import { closeSync, openSync, readSync, readdirSync, statSync } from "node:fs";
import { zstdDecompressSync } from "node:zlib";
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


/** zstd 帧起始 magic（0x28 B5 2F FD）。DSH v4 每次追加写一个**独立**帧。 */
const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd] as const;

/**
 * 把一段字节切成 zstd 帧并逐帧解压（帧之间互不依赖，已用本机 8.7MB 日志验证）。
 *
 * 只用于 `session.v4.jsonl.zstd`；其它版本的布局不同，一律走 DSH 自己的持久化 API。
 */
export function dshDecodeFrames(bytes: Buffer): string[] {
  const starts: number[] = [0];
  for (let index = 1; index + 3 < bytes.length; index += 1) {
    if (bytes[index] === ZSTD_MAGIC[0] && bytes[index + 1] === ZSTD_MAGIC[1] &&
      bytes[index + 2] === ZSTD_MAGIC[2] && bytes[index + 3] === ZSTD_MAGIC[3]) starts.push(index);
  }
  const out: string[] = [];
  for (let index = 0; index < starts.length; index += 1) {
    const frame = bytes.subarray(starts[index]!, starts[index + 1] ?? bytes.length);
    if (frame.length === 0) continue;
    out.push(zstdDecompressSync(frame).toString("utf8"));
  }
  return out;
}

/** 解析 JSONL 文本块为事件数组；坏行直接跳过（与 DSH 的宽容读法一致）。 */
export function dshEventsFromText(text: string): DshLog["events"] {
  const events: DshLog["events"] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      const parsed = JSON.parse(trimmed) as { seq?: unknown };
      if (typeof parsed.seq === "number" && Number.isSafeInteger(parsed.seq)) events.push(parsed as DshLog["events"][number]);
    } catch { /* 半行或损坏：下次读到完整帧时再补 */ }
  }
  return events;
}

/** 从 `offset` 起读取文件尾部字节（返回尾部内容与新的偏移）。 */
export function dshReadTail(file: string, offset: number): { bytes: Buffer; offset: number } | undefined {
  let size: number;
  try { size = statSync(file).size; } catch { return undefined; }
  if (size <= offset) return undefined;
  const handle = openSync(file, "r");
  try {
    const bytes = Buffer.allocUnsafe(size - offset);
    const read = readSync(handle, bytes, 0, bytes.length, offset);
    return { bytes: bytes.subarray(0, read), offset };
  } finally { closeSync(handle); }
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
  // 增量读的会话状态：已解析事件、已消费的字节偏移、以及文件是否还是同一条（截断/替换要重读）。
  const caches = new Map<string, { key: string; log: DshLog; offset: number }>();
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
      // 文件没变：直接复用（最常见的情况，≈0ms）。
      if (cached !== undefined && key !== undefined && cached.key === key) return cached.log;
      // 只对 v4 的单文件布局做增量读；文件被截断/替换（变小）或布局不同都退回整份 API 读。
      const size = key === undefined ? -1 : Number(key.split(":")[0]);
      if (cached !== undefined && file !== undefined && size >= cached.offset) {
        const tail = dshReadTail(file, cached.offset);
        if (tail !== undefined && tail.bytes.length > 0) {
          let appended: DshLog["events"] | undefined;
          try { appended = dshDecodeFrames(tail.bytes).flatMap(dshEventsFromText); }
          catch { appended = undefined; }        // 半帧或格式变化：下面整份重读
          if (appended !== undefined) {
            const merged = appended.length === 0 ? cached.log
              : { header: cached.log.header, events: [...cached.log.events, ...appended] };
            caches.set(sessionId, { key: key!, log: merged, offset: cached.offset + tail.bytes.length });
            return merged;
          }
          caches.delete(sessionId);
        }
      }
      const handle = await ctx.sessionPersistence.open(sessionId, "read");
      try {
        const { events } = await handle.read();
        const log = { header: handle.header, events } as DshLog;
        if (key !== undefined && file !== undefined) {
          let offset = 0;
          try { offset = statSync(file).size; } catch { /* 读不到就下次重来 */ }
          caches.set(sessionId, { key, log, offset });
        }
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
