/**
 * 会话发现与只读目录浏览（spec §8.1 的 M3 / Node 侧）。
 *
 * 两个职责，一个共同的数据源：
 * - `listPiSessions`：扫 `~/.pi/agent/sessions/<编码后的 cwd>/*.jsonl`。**权威数据是会话
 *   文件的首行**（`{"type":"session","id":...,"cwd":...}`）——目录名是有损编码（cwd 里的
 *   `-` 和分隔符的 `-` 无法区分），所以 cwd 必须读文件，不能从目录名反解。
 * - `browseDirectory`：§8.1 的 `browse { path? }`。空路径返回盘符 / 根；`hasSessions`
 *   用扫描出的 cwd 集合判定，比目录名匹配准。
 */
import { open, readdir, stat, access } from "node:fs/promises";
import { homedir, hostname, platform } from "node:os";
import { dirname, join, resolve } from "node:path";

import type { AgentSessionSummary, BrowseEntry } from "@pi-remote/protocol";

/** 单次扫描最多读的会话文件数：磁盘扫描是给人看列表用的，不是索引重建。 */
const MAX_SESSION_FILES = 500;
/** 会话首行只是元数据；上限只为防御异常文件，读超了也只丢后面。 */
const HEADER_BYTES = 64 * 1024;

export function defaultPiSessionsRoot(): string {
  return join(homedir(), ".pi", "agent", "sessions");
}

/**
 * 本机主机名。会话条目靠它区分不同电脑（手机侧栏按主机分组）。
 *
 * `os.hostname()` 可能抛，而 schema 里 `hostname` 是必填的非空串——所以兜底一个
 * 明确的占位值，而不是漏字段（ADR-0008 之后不存在“省略它”的旧对端）。
 */
export function localHostname(): string {
  try {
    return hostname().trim() || "unknown";
  } catch {
    return "unknown";
  }
}

export type PiSessionScan = {
  sessions: AgentSessionSummary[];
  /** 有过会话的 cwd 集合（`browse` 的 hasSessions 数据源）。 */
  cwds: Set<string>;
  /** sessionId → 会话文件绝对路径。L1 激活要传给 `pi --session <path>`（§8.2）。 */
  files: Map<string, string>;
};

/**
 * 扫描本机 Pi 会话。每个 encoded 目录里，同目录下会话的 cwd 相同，读最新一个文件
 * 就足以拿到 cwd；sessionId 是每会话一个的，完整列表要逐文件读首行。
 * 文件多于预算时按 mtime 取最近的（列表语义：最近优先）。
 */
export async function listPiSessions(options?: {
  root?: string;
  /** 只要 cwd 集合（`browse` 的 hasSessions 用），跳过逐文件读取。 */
  summaries?: boolean;
}): Promise<PiSessionScan> {
  const root = options?.root ?? defaultPiSessionsRoot();
  const summaries = options?.summaries ?? true;
  const scan: PiSessionScan = { sessions: [], cwds: new Set(), files: new Map() };

  let groups: string[];
  try {
    groups = await readdir(root);
  } catch {
    // 没装过 Pi / 没有任何会话：空列表，不是错误。
    return scan;
  }

  for (const group of groups) {
    const groupDir = join(root, group);
    const files = await listSessionFiles(groupDir);
    const newestFile = files[0];
    if (newestFile === undefined) continue;
    const newest = await readSessionHeader(newestFile.path);
    if (newest?.id === undefined || newest.cwd === undefined) continue;
    scan.cwds.add(normalizeCwdKey(newest.cwd));
    if (!summaries) continue;

    let budget = MAX_SESSION_FILES - scan.sessions.length;
    for (const file of files) {
      if (budget <= 0) break;
      budget -= 1;
      const header = file.path === newestFile.path ? newest : await readSessionHeader(file.path);
      if (header?.id === undefined || header.cwd === undefined) continue;
      scan.files.set(header.id, file.path);
      scan.sessions.push({
        agentKind: "pi",
        sessionId: header.id,
        cwd: header.cwd,
        hostname: localHostname(),
        ...(header.name === undefined ? {} : { name: header.name }),
        // 协议里这两个字段是 int：mtimeMs 在 Windows 上带小数，浮点会让 APP 的
        // kotlinx Long 解码抛异常——一条坏条目就把整个 session.list.result 报废。
        createdAt: Math.round(header.timestamp ?? file.mtimeMs),
        modifiedAt: Math.round(file.mtimeMs),
        // 磁盘扫描不数行数：它是给 L1 激活定位用的摘要，不是完整目录。
        messageCount: 0,
      });
    }
  }

  scan.sessions.sort((a, b) => b.modifiedAt - a.modifiedAt);
  return scan;
}

type SessionFile = { path: string; mtimeMs: number };
type SessionHeader = { id?: string; cwd?: string; timestamp?: number; name?: string };

async function listSessionFiles(groupDir: string): Promise<SessionFile[]> {
  let entries: string[];
  try {
    entries = await readdir(groupDir);
  } catch {
    return [];
  }
  const files: SessionFile[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".jsonl")) continue;
    const path = join(groupDir, entry);
    try {
      const info = await stat(path);
      if (!info.isFile()) continue;
      files.push({ path, mtimeMs: info.mtimeMs });
    } catch {
      // 文件在扫描中途消失：跳过，不让一次 browse 失败。
    }
  }
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return files;
}

async function readSessionHeader(path: string): Promise<SessionHeader | undefined> {
  let buffer: Buffer;
  try {
    const handle = await open(path, "r");
    try {
      const chunk = Buffer.alloc(HEADER_BYTES);
      const { bytesRead } = await handle.read(chunk, 0, HEADER_BYTES, 0);
      buffer = chunk.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
  } catch {
    return undefined;
  }
  const firstLine = buffer.toString("utf8").split("\n", 1)[0] ?? "";
  let parsed: unknown;
  try {
    parsed = JSON.parse(firstLine) as unknown;
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object") return undefined;
  const record = parsed as Record<string, unknown>;
  if (record.type !== "session") return undefined;
  const id = typeof record.id === "string" ? record.id : undefined;
  const cwd = typeof record.cwd === "string" && record.cwd.length > 0 ? record.cwd : undefined;
  const timestamp = typeof record.timestamp === "string" ? Date.parse(record.timestamp) : undefined;
  const name = typeof record.name === "string" ? record.name : undefined;
  return {
    ...(id === undefined ? {} : { id }),
    ...(cwd === undefined ? {} : { cwd }),
    ...(timestamp !== undefined && Number.isFinite(timestamp) ? { timestamp } : {}),
    ...(name === undefined ? {} : { name }),
  };
}

/** Windows 路径大小写不敏感：hasSessions 的比较按平台归一。 */
function normalizeCwdKey(cwd: string): string {
  return platform() === "win32" ? cwd.toUpperCase() : cwd;
}

/**
 * §8.1 的 `browse`。`path` 为空返回盘符（Windows）或根（POSIX）。
 * 只读：readdir + stat，不读文件内容。
 */
export async function browseDirectory(
  rawPath: string | undefined,
  cwds: Set<string>,
): Promise<{ path: string; parent?: string; entries: BrowseEntry[] }> {
  const target = normalizeDir(rawPath);
  if (target === undefined) {
    const entries: BrowseEntry[] =
      platform() === "win32" ? await listWindowsDrives(cwds) : [{ name: "/", isDir: true, hasSessions: cwds.has("/") }];
    return { path: "", entries };
  }
  const names = await readdir(target);
  const entries: BrowseEntry[] = [];
  for (const name of names) {
    const full = join(target, name);
    let isDir: boolean;
    try {
      isDir = (await stat(full)).isDirectory();
    } catch {
      continue;
    }
    if (!isDir) continue;
    entries.push({ name, isDir, hasSessions: cwds.has(normalizeCwdKey(full)) });
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  const parent = dirname(target);
  return {
    path: target,
    ...(parent !== target ? { parent } : {}),
    entries,
  };
}

/**
 * 浏览入口的归一化：空串 / 空白视为「根」；相对路径按 Host 自己的 cwd 解。
 * 只保证它是个「可以 readdir 的路径」，不做更多——安全由配对与 E2E 提供（§8.4）。
 */
function normalizeDir(rawPath: string | undefined): string | undefined {
  if (rawPath === undefined || rawPath.trim().length === 0) return undefined;
  return resolve(rawPath);
}

async function listWindowsDrives(cwds: Set<string>): Promise<BrowseEntry[]> {
  const drives: BrowseEntry[] = [];
  // 26 次 access 比拉子进程便宜，也绕开了「禁止 shell」的约束。
  const probes = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("").map(async (letter) => {
    const root = `${letter}:\\`;
    try {
      await access(root);
    } catch {
      return;
    }
    drives.push({
      name: root,
      isDir: true,
      hasSessions: [...cwds].some((cwd) => cwd.startsWith(normalizeCwdKey(root))),
    });
  });
  await Promise.all(probes);
  drives.sort((a, b) => a.name.localeCompare(b.name));
  return drives;
}
