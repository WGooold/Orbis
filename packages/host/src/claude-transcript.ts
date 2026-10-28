import { open, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { RemoteSessionEntry } from "@orbis/protocol";

/**
 * Claude Code's native transcript (`<config>/projects/<project>/<sessionId>.jsonl`) is the
 * persistent history authority (ADR-0033 §3). This module projects its rows into the
 * standard entry shape; it never writes the file and never infers identity from text.
 */

const TOOL_RESULT_TEXT_LIMIT = 256 * 1024;
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/u;

type Row = Record<string, unknown>;

/** Incremental projection state; rows must be fed in file order. */
export class ClaudeTranscriptProjection {
  readonly entries: RemoteSessionEntry[] = [];
  /** Every row uuid (rendered or not) → nearest rendered ancestor entry id. */
  readonly #anchor = new Map<string, string | null>();
  readonly #toolNames = new Map<string, string>();
  readonly #ids = new Set<string>();
  #leaf: string | null = null;

  get leafId(): string | null { return this.#leaf; }
  has(uuid: string): boolean { return this.#anchor.has(uuid); }

  push(row: Row): void {
    const uuid = text(row.uuid);
    if (uuid === undefined || this.#anchor.has(uuid)) return;
    const parentUuid = text(row.parentUuid);
    const parent = parentUuid === undefined ? null : this.#anchor.get(parentUuid) ?? null;
    // Sidechains are subagent transcripts; they never join the main conversation path.
    if (row.isSidechain === true) { this.#anchor.set(uuid, parent); return; }
    const timestamp = text(row.timestamp) ?? new Date(0).toISOString();
    const produced = this.#project(row, uuid, timestamp);
    let previous = parent;
    for (const entry of produced) {
      if (this.#ids.has(entry.entryId)) continue;
      this.#ids.add(entry.entryId);
      this.entries.push({ ...entry, parentId: previous });
      previous = entry.entryId;
    }
    this.#anchor.set(uuid, previous);
    if (produced.length > 0) this.#leaf = previous;
  }

  #project(row: Row, uuid: string, timestamp: string): Omit<RemoteSessionEntry, "parentId">[] {
    const message = record(row.message);
    if (message === undefined || row.isMeta === true) return [];
    const millis = Date.parse(timestamp);
    const at = Number.isSafeInteger(millis) && millis >= 0 ? millis : 0;
    if (row.type === "user") {
      const summary = row.isCompactSummary === true ? plainText(message.content) : undefined;
      if (summary !== undefined) return [{ entryId: uuid, type: "compaction", timestamp, data: { summary } }];
      const content = message.content;
      if (typeof content === "string") {
        return content.trim().length === 0 ? [] : [messageEntry(uuid, timestamp, { role: "user", content, timestamp: at })];
      }
      if (!Array.isArray(content)) return [];
      const texts = content.flatMap(block => {
        const item = record(block);
        return item?.type === "text" && typeof item.text === "string" && item.text.trim().length > 0 ? [{ type: "text", text: item.text }] : [];
      });
      const result: Omit<RemoteSessionEntry, "parentId">[] = [];
      if (texts.length > 0) result.push(messageEntry(uuid, timestamp, { role: "user", content: texts, timestamp: at }));
      const results = content.filter(block => record(block)?.type === "tool_result");
      results.forEach((block, index) => {
        const item = record(block)!;
        const toolCallId = text(item.tool_use_id);
        if (toolCallId === undefined) return;
        const toolName = this.#toolNames.get(toolCallId);
        const id = results.length === 1 && texts.length === 0 ? uuid : `${uuid}:result:${index}`;
        result.push(messageEntry(id, timestamp, { role: "toolResult", toolCallId, ...(toolName === undefined ? {} : { toolName }),
          content: [{ type: "text", text: clip(plainText(item.content) ?? "") }], isError: item.is_error === true, timestamp: at }));
      });
      return result;
    }
    if (row.type === "assistant") {
      if (!Array.isArray(message.content)) return [];
      const blocks = message.content.flatMap((block): Record<string, unknown>[] => {
        const item = record(block);
        if (item?.type === "text" && typeof item.text === "string" && item.text.length > 0) return [{ type: "text", text: item.text }];
        // Hidden thinking is persisted as an empty string plus a signature; there is nothing to show.
        if (item?.type === "thinking" && typeof item.thinking === "string" && item.thinking.length > 0) return [{ type: "thinking", thinking: item.thinking }];
        if (item?.type === "tool_use" && typeof item.id === "string" && typeof item.name === "string") {
          this.#toolNames.set(item.id, item.name);
          return [{ type: "toolCall", id: item.id, name: item.name, arguments: item.input ?? {} }];
        }
        return [];
      });
      if (blocks.length === 0) return [];
      const model = text(message.model);
      return [messageEntry(uuid, timestamp, { role: "assistant", content: blocks, timestamp: at, ...(model === undefined ? {} : { model }) })];
    }
    return [];
  }
}

/**
 * Reads appended transcript bytes. A shrunk or replaced file restarts the projection;
 * an unterminated last line waits for the next read.
 */
export class ClaudeTranscriptReader {
  readonly #path: string;
  #projection = new ClaudeTranscriptProjection();
  #offset = 0;
  #pending = "";
  #inode: number | undefined;

  constructor(path: string) { this.#path = path; }
  get path(): string { return this.#path; }
  get projection(): ClaudeTranscriptProjection { return this.#projection; }

  /** Returns true when previously read entries were discarded (the source must re-baseline). */
  async read(): Promise<boolean> {
    const info = await stat(this.#path);
    let reset = false;
    if (info.size < this.#offset || (this.#inode !== undefined && info.ino !== this.#inode)) {
      this.#projection = new ClaudeTranscriptProjection();
      this.#offset = 0;
      this.#pending = "";
      reset = true;
    }
    this.#inode = info.ino;
    if (info.size === this.#offset) return reset;
    const handle = await open(this.#path, "r");
    try {
      const length = info.size - this.#offset;
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, this.#offset);
      this.#offset += bytesRead;
      const chunk = this.#pending + buffer.subarray(0, bytesRead).toString("utf8");
      const lines = chunk.split("\n");
      this.#pending = lines.pop() ?? "";
      for (const line of lines) {
        if (line.trim().length === 0) continue;
        let row: unknown;
        try { row = JSON.parse(line); } catch { continue; }
        const value = record(row);
        if (value !== undefined) this.#projection.push(value);
      }
    } finally {
      await handle.close();
    }
    return reset;
  }
}

/** `CLAUDE_CONFIG_DIR` reported by the bridge, else the default `~/.claude`. */
export function claudeConfigDir(reported?: string): string {
  return reported !== undefined && reported.trim().length > 0 ? reported : join(homedir(), ".claude");
}

/** Locates the Session's transcript without re-deriving Claude's project-directory encoding. */
export async function findClaudeTranscript(sessionId: string, configDir: string): Promise<string | undefined> {
  if (!SESSION_ID.test(sessionId)) return undefined;
  const projects = join(configDir, "projects");
  let names: string[];
  try { names = await readdir(projects); } catch { return undefined; }
  for (const name of names) {
    const candidate = join(projects, name, `${sessionId}.jsonl`);
    try { if ((await stat(candidate)).isFile()) return candidate; } catch { /* not this project */ }
  }
  return undefined;
}

function messageEntry(entryId: string, timestamp: string, message: Record<string, unknown>): Omit<RemoteSessionEntry, "parentId"> {
  return { entryId, type: "message", timestamp, data: { message } };
}

function plainText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return undefined;
  const parts = value.flatMap(block => {
    const item = record(block);
    return item?.type === "text" && typeof item.text === "string" ? [item.text] : [];
  });
  return parts.length === 0 ? undefined : parts.join("\n");
}

function clip(value: string): string {
  return value.length <= TOOL_RESULT_TEXT_LIMIT ? value : `${value.slice(0, TOOL_RESULT_TEXT_LIMIT)}… [truncated]`;
}

function record(value: unknown): Row | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Row : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= 256 ? value : undefined;
}
