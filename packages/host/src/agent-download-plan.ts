/**
 * Agent 安装的下载进度。
 *
 * npm 在非 TTY 下不报任何字节进度：`--progress=always` 不画条，silly 日志只有 URL 没有字节，
 * 缓存里的 tarball 要么是 0 字节要么在完成时一次性出现（实测），`npm pack` 也不增量落盘。
 * 所以要给出进度只能自己算：先用 npm 自己解析依赖闭包（`--package-lock-only`，只取元数据、
 * 不下 tarball），再用范围请求问每个 tarball 的大小，最后按 npm 日志里"哪个 tarball 取完了"
 * 逐包累加。
 *
 * 粒度就是"每个包"：单个巨大的 tarball（例如 Codex 的平台包有 200MB 级）在下载期间不会推进
 * 百分比——这是 npm 不给在途字节的直接后果，不是这里漏了什么。所以进度里同时带着"已完成/总数"
 * 与时间，让用户看得出它还在动。
 *
 * 一切都是尽力而为：计划拿不到、大小问不出来、日志格式变了，都只是没有进度数字，安装本身照常。
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { InstallRun } from "./agent-installation.js";

export type AgentDownloadPackage = {
  name: string;
  version: string;
  url: string;
  /** tarball 字节数；问不到时为 undefined（只计数、不计重）。 */
  size?: number;
};

export type AgentDownloadPlan = {
  packages: AgentDownloadPackage[];
  /** 所有已知大小之和；一个都问不到时为 0。 */
  totalBytes: number;
};

export type AgentDownloadProgress = {
  receivedBytes: number;
  totalBytes: number;
  donePackages: number;
  totalPackages: number;
};

type LockEntry = { resolved?: unknown; version?: unknown; name?: unknown };

/** 从 npm 的 lockfile 里取出要下载的 tarball 列表（v3 的 `packages`，兼容 v2 的 `dependencies`）。 */
export function parseLockTarballs(text: string): { name: string; version: string; url: string }[] {
  let lock: unknown;
  try { lock = JSON.parse(text); } catch { return []; }
  if (lock === null || typeof lock !== "object") return [];
  const found: { name: string; version: string; url: string }[] = [];
  const seen = new Set<string>();
  const push = (name: unknown, entry: LockEntry, pathKey: string): void => {
    const url = entry.resolved;
    if (typeof url !== "string" || !url.startsWith("http")) return;
    if (seen.has(url)) return;
    seen.add(url);
    const version = typeof entry.version === "string" ? entry.version : "";
    const label = typeof name === "string" && name.length > 0 ? name : pathKey.replace(/^.*node_modules\//u, "");
    found.push({ name: label, version, url });
  };
  const packages = (lock as { packages?: unknown }).packages;
  if (packages !== null && typeof packages === "object") {
    for (const [pathKey, entry] of Object.entries(packages as Record<string, LockEntry>)) {
      if (pathKey.length === 0) continue;
      push(undefined, entry, pathKey);
    }
  }
  const dependencies = (lock as { dependencies?: unknown }).dependencies;
  if (dependencies !== null && typeof dependencies === "object") {
    for (const [name, entry] of Object.entries(dependencies as Record<string, LockEntry>)) push(name, entry, name);
  }
  return found;
}

/** 问一个 tarball 的字节数：先范围请求（CDN/代理常丢掉 HEAD 的 content-length），再退回 HEAD。 */
async function probeSize(url: string, timeoutMs: number): Promise<number | undefined> {
  const ask = async (method: "GET" | "HEAD"): Promise<number | undefined> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        method,
        ...(method === "GET" ? { headers: { Range: "bytes=0-0" } } : {}),
        signal: controller.signal,
        redirect: "follow",
      });
      const usable = response.ok || response.status === 206;
      const range = usable ? response.headers.get("content-range") : undefined;
      const total = range?.match(/\/(\d+)\s*$/u)?.[1];
      const length = total ?? (usable ? response.headers.get("content-length") ?? undefined : undefined);
      // 只问大小：不把 tarball 读进内存。
      await response.body?.cancel().catch(() => undefined);
      if (length === undefined) return undefined;
      const size = Number(length);
      return Number.isFinite(size) ? size : undefined;
    } catch { return undefined; }
    finally { clearTimeout(timer); }
  };
  return await ask("GET") ?? await ask("HEAD");
}

async function mapLimited<T, R>(items: readonly T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next++;
      const item = items[index];
      if (item === undefined) return;
      results[index] = await worker(item);
    }
  });
  await Promise.all(runners);
  return results;
}

export type AgentDownloadPlanOptions = {
  run: InstallRun;
  npm: { command: string; args: string[] };
  spec: string;
  /** 只用来放解析用的 lockfile，不是真正的安装目标。 */
  planDir: string;
  signal: AbortSignal;
  timeoutMs?: number;
  probeTimeoutMs?: number;
  /** 测试注入：绕过网络问大小。 */
  probe?: (url: string) => Promise<number | undefined>;
};

/** 用 npm 自己解析依赖闭包并问出体积；任何一步不配合就返回 undefined（不报进度）。 */
export async function planAgentDownload(options: AgentDownloadPlanOptions): Promise<AgentDownloadPlan | undefined> {
  const { run, npm, spec, planDir, signal } = options;
  try {
    signal.throwIfAborted();
    await run(npm.command, [
      ...npm.args, "install", "--package-lock-only", "--no-audit", "--no-fund",
      "--prefix", planDir, "--", spec,
    ], { signal, timeout: options.timeoutMs ?? 180_000, cwd: planDir });
    const lock = await readFile(join(planDir, "package-lock.json"), "utf8");
    const tarballs = parseLockTarballs(lock);
    if (tarballs.length === 0) return undefined;
    signal.throwIfAborted();
    const probe = options.probe ?? ((url: string) => probeSize(url, options.probeTimeoutMs ?? 8_000));
    // 单个 tarball 问不到大小不该拖累整份计划：包数仍然有用，少一个体积只是少一点精度。
    const sizes = await mapLimited(tarballs, 8, async entry => await probe(entry.url).catch(() => undefined));
    const packages = tarballs.map((entry, index) => ({ ...entry, ...(sizes[index] === undefined ? {} : { size: sizes[index]! }) }));
    return { packages, totalBytes: packages.reduce((sum, entry) => sum + (entry.size ?? 0), 0) };
  } catch {
    // 计划失败只是没有进度数字：安装照旧走 npm 自己的路。
    return undefined;
  }
}

/** npm 的 http 日志行：`npm http fetch GET 200 <url> 1234ms (cache miss)`。 */
const FETCH_LINE = /\bGET\s+\d{3}\s+(\S+)/u;

/**
 * 按 npm 的 fetch 日志累加完成量。返回 undefined 表示这一行与已知 tarball 无关。
 *
 * 只有"取完了"才计数：npm 不报在途字节，所以大包会表现为长时间不动、然后一次跳满。
 */
export function createAgentDownloadTracker(plan: AgentDownloadPlan): (line: string) => AgentDownloadProgress | undefined {
  const remaining = new Map<string, AgentDownloadPackage>();
  for (const entry of plan.packages) remaining.set(entry.url, entry);
  let receivedBytes = 0;
  let donePackages = 0;
  return (line: string): AgentDownloadProgress | undefined => {
    const match = FETCH_LINE.exec(line);
    if (match === null) return undefined;
    const entry = remaining.get(match[1]!);
    if (entry === undefined) return undefined;
    remaining.delete(entry.url);
    receivedBytes += entry.size ?? 0;
    donePackages += 1;
    return { receivedBytes, totalBytes: plan.totalBytes, donePackages, totalPackages: plan.packages.length };
  };
}
