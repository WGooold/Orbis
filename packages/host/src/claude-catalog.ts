import { mkdir, open, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/**
 * Claude Code Session directory read from the native transcripts
 * (`<config>/projects/<project>/<sessionId>.jsonl`). Subagent transcripts live one level
 * deeper and are not Sessions of their own. Only a bounded head and tail of each file are
 * read; a file whose size and mtime are unchanged is not read again.
 */

const SESSION_FILE = /^([A-Za-z0-9][A-Za-z0-9-]{0,127})\.jsonl$/u;
const HEAD_BYTES = 64 * 1024;
const TAIL_BYTES = 32 * 1024;
const MAX_SESSIONS = 2_000;
const FIRST_MESSAGE_LIMIT = 500;

export type ClaudeSessionFile = {
  sessionId: string;
  path: string;
  cwd: string;
  name?: string;
  firstMessage?: string;
  createdAt: number;
  modifiedAt: number;
};

type Cached = { mtimeMs: number; size: number; file: ClaudeSessionFile | undefined };

export class ClaudeSessionCatalog {
  readonly #cache = new Map<string, Cached>();

  /** Newest first, at most 2000; a missing config or projects directory is an empty list. */
  async scan(configDirs: readonly string[]): Promise<ClaudeSessionFile[]> {
    const candidates: { path: string; sessionId: string; mtimeMs: number; size: number }[] = [];
    for (const configDir of new Set(configDirs)) {
      const projects = join(configDir, "projects");
      let names: string[];
      try { names = await readdir(projects); } catch { continue; }
      for (const name of names) {
        let files: string[];
        try { files = await readdir(join(projects, name)); } catch { continue; }
        for (const file of files) {
          const sessionId = SESSION_FILE.exec(file)?.[1];
          if (sessionId === undefined) continue;
          const path = join(projects, name, file);
          try {
            const info = await stat(path);
            if (info.isFile()) candidates.push({ path, sessionId, mtimeMs: info.mtimeMs, size: info.size });
          } catch { /* removed while scanning */ }
        }
      }
    }
    candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const sessions: ClaudeSessionFile[] = [];
    const seen = new Set<string>();
    for (const candidate of candidates) {
      if (sessions.length >= MAX_SESSIONS) break;
      if (seen.has(candidate.sessionId)) continue;
      const file = await this.#read(candidate);
      if (file === undefined) continue;
      seen.add(candidate.sessionId);
      sessions.push(file);
    }
    const live = new Set(candidates.map(candidate => candidate.path));
    for (const path of this.#cache.keys()) if (!live.has(path)) this.#cache.delete(path);
    return sessions;
  }

  async find(sessionId: string, configDirs: readonly string[]): Promise<ClaudeSessionFile | undefined> {
    return (await this.scan(configDirs)).find(file => file.sessionId === sessionId);
  }

  async #read(candidate: { path: string; sessionId: string; mtimeMs: number; size: number }): Promise<ClaudeSessionFile | undefined> {
    const cached = this.#cache.get(candidate.path);
    if (cached !== undefined && cached.mtimeMs === candidate.mtimeMs && cached.size === candidate.size) return cached.file;
    let file: ClaudeSessionFile | undefined;
    try { file = await readSessionFile(candidate.path, candidate.sessionId, candidate.size, candidate.mtimeMs); }
    catch { file = undefined; }
    this.#cache.set(candidate.path, { mtimeMs: candidate.mtimeMs, size: candidate.size, file });
    return file;
  }
}

async function readSessionFile(path: string, sessionId: string, size: number, mtimeMs: number): Promise<ClaudeSessionFile | undefined> {
  const handle = await open(path, "r");
  let head: string;
  let tail = "";
  try {
    const headBuffer = Buffer.alloc(Math.min(size, HEAD_BYTES));
    const { bytesRead } = await handle.read(headBuffer, 0, headBuffer.length, 0);
    head = headBuffer.subarray(0, bytesRead).toString("utf8");
    if (size > HEAD_BYTES) {
      const length = Math.min(TAIL_BYTES, size - HEAD_BYTES);
      const tailBuffer = Buffer.alloc(length);
      const read = await handle.read(tailBuffer, 0, length, size - length);
      tail = tailBuffer.subarray(0, read.bytesRead).toString("utf8");
    }
  } finally {
    await handle.close();
  }
  // A cut-off first or last line is not JSON and is skipped by the parser below.
  const rows = [...parseRows(head), ...parseRows(tail)];
  let cwd: string | undefined;
  let createdAt: number | undefined;
  let firstMessage: string | undefined;
  let aiTitle: string | undefined;
  let customTitle: string | undefined;
  let conversation = false;
  for (const row of rows) {
    if (row.type === "custom-title" && typeof row.customTitle === "string" && row.customTitle.trim()) customTitle = row.customTitle.trim();
    if (row.type === "ai-title" && typeof row.aiTitle === "string" && row.aiTitle.trim()) aiTitle = row.aiTitle.trim();
    if (row.isSidechain === true) continue;
    if (cwd === undefined && typeof row.cwd === "string" && row.cwd.length > 0) cwd = row.cwd;
    if (createdAt === undefined && typeof row.timestamp === "string") {
      const parsed = Date.parse(row.timestamp);
      if (Number.isSafeInteger(parsed) && parsed > 0) createdAt = parsed;
    }
    if (row.type === "user" || row.type === "assistant") conversation = true;
    if (firstMessage === undefined && row.type === "user" && row.isMeta !== true && row.isCompactSummary !== true) {
      firstMessage = userText(row.message);
    }
  }
  if (cwd === undefined || !conversation) return undefined;
  const name = (customTitle ?? aiTitle)?.slice(0, 256);
  return {
    sessionId, path, cwd,
    ...(name === undefined ? {} : { name }),
    ...(firstMessage === undefined ? {} : { firstMessage }),
    createdAt: Math.round(createdAt ?? mtimeMs),
    // Integer milliseconds: Windows mtimes carry fractions the apps' Long decoders reject.
    modifiedAt: Math.round(mtimeMs),
  };
}

function parseRows(text: string): Record<string, unknown>[] {
  return text.split("\n").flatMap(line => {
    if (line.trim().length === 0) return [];
    try {
      const value: unknown = JSON.parse(line);
      return typeof value === "object" && value !== null && !Array.isArray(value) ? [value as Record<string, unknown>] : [];
    } catch { return []; }
  });
}

/** Plain prompt text; tool results and Claude's tagged command rows are not a first message. */
function userText(message: unknown): string | undefined {
  if (typeof message !== "object" || message === null) return undefined;
  const content = (message as Record<string, unknown>).content;
  const text = typeof content === "string" ? content : Array.isArray(content)
    ? content.flatMap(block => typeof block === "object" && block !== null && (block as Record<string, unknown>).type === "text" &&
      typeof (block as Record<string, unknown>).text === "string" ? [(block as Record<string, unknown>).text as string] : []).join("\n")
    : "";
  const trimmed = text.trim();
  if (trimmed.length === 0) return undefined;
  if (trimmed.startsWith("<")) {
    const command = /<command-name>([\s\S]*?)<\/command-name>/u.exec(trimmed)?.[1]?.trim();
    if (command === undefined || command.length === 0) return undefined;
    const args = /<command-args>([\s\S]*?)<\/command-args>/u.exec(trimmed)?.[1]?.trim();
    return `${command.startsWith("/") ? command : `/${command}`}${args ? ` ${args}` : ""}`.slice(0, FIRST_MESSAGE_LIMIT);
  }
  return trimmed.slice(0, FIRST_MESSAGE_LIMIT);
}

/**
 * Claude Code has no archive of its own. Orbis keeps the archived Session ids beside its
 * other Host state; the transcripts are never moved or rewritten.
 */
export class ClaudeArchiveStore {
  readonly #path: string;
  #ids: Set<string> | undefined;
  #write: Promise<void> = Promise.resolve();

  constructor(path: string) { this.#path = path; }

  async archived(): Promise<ReadonlySet<string>> { return await this.#load(); }

  async set(sessionId: string, archived: boolean): Promise<void> {
    const ids = await this.#load();
    if (archived === ids.has(sessionId)) return;
    if (archived) ids.add(sessionId); else ids.delete(sessionId);
    const content = `${JSON.stringify({ version: 1, sessionIds: [...ids].sort() })}\n`;
    const write = this.#write.then(async () => {
      await mkdir(dirname(this.#path), { recursive: true });
      const temporary = `${this.#path}.${process.pid}.tmp`;
      await writeFile(temporary, content, { mode: 0o600 });
      await rename(temporary, this.#path);
    });
    this.#write = write.catch(() => undefined);
    await write;
  }

  async #load(): Promise<Set<string>> {
    if (this.#ids !== undefined) return this.#ids;
    let ids: string[] = [];
    try {
      const parsed: unknown = JSON.parse(await readFile(this.#path, "utf8"));
      const list = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>).sessionIds : undefined;
      if (Array.isArray(list)) ids = list.filter((id): id is string => typeof id === "string" && SESSION_FILE.test(`${id}.jsonl`));
    } catch { /* absent or unreadable: nothing archived */ }
    this.#ids ??= new Set(ids);
    return this.#ids;
  }
}
