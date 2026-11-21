/**
 * CODEX-DESKTOP-SUPERVISION-01 (ADR-0096): every `app-server --listen` started by the wrapper belongs
 * to exactly one live bridge.
 *
 * `--listen` makes the backend ignore stdin, so it outlives a bridge that was killed (SIGKILL, crash,
 * an older wrapper without exit handling) and keeps native thread writer locks. The next Desktop
 * backend then fails with "thread … already has an active writer". Such orphans are stopped before a
 * wrapper starts another backend and by Host's periodic sweep.
 *
 * Ownership evidence, never a process name:
 * - a lease written by the bridge (`codex-desktop-backends/<instance>.json`), checked against the
 *   live process table and the backend's own `--listen <url>` argument;
 * - the previous endpoint descriptor, for backends of wrappers that predate leases;
 * - on macOS, an orphan (parent launchd) whose environment carries this Host's endpoint path, which
 *   every wrapper generation passes to its backend.
 * A backend whose bridge is still its parent is never touched.
 */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

import { endpointRecordLive, processAlive, readEndpointRecord } from "./codex-desktop-endpoint.js";
import { isProcessChild, processCommand, processTable, sameProcess, type ProcessIdentity } from "./owned-processes.js";

const execute = promisify(execFile);

/** Set on every backend the bridge starts, together with ORBIS_CODEX_DESKTOP_ENDPOINT. */
export const DESKTOP_BACKEND_MARKER = "ORBIS_CODEX_DESKTOP_BACKEND";
export const DESKTOP_ENDPOINT_MARKER = "ORBIS_CODEX_DESKTOP_ENDPOINT";

export type DesktopBackendLease = {
  schema: 1;
  instanceId: string;
  codexPid: number;
  bridgePid: number;
  url: string;
  startedAt: string;
};

export function backendLeaseDirectory(endpointFile: string): string {
  return join(dirname(endpointFile), "codex-desktop-backends");
}

function leasePath(endpointFile: string, instanceId: string): string {
  return join(backendLeaseDirectory(endpointFile), `${instanceId}.json`);
}

export function recordBackendLease(endpointFile: string, lease: DesktopBackendLease): void {
  const path = leasePath(endpointFile, lease.instanceId);
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(lease), { mode: 0o600, flag: "wx" });
    renameSync(temporary, path);
  } finally {
    try { rmSync(temporary, { force: true }); } catch { /* Preserve the original failure. */ }
  }
}

export function releaseBackendLease(endpointFile: string, instanceId: string): void {
  try { rmSync(leasePath(endpointFile, instanceId), { force: true }); } catch { /* A stale lease is re-validated before use. */ }
}

/** A bridge that has started its backend but not published an endpoint yet. */
export function startingBackendLease(endpointFile: string): DesktopBackendLease | undefined {
  return readLeases(endpointFile).find(lease => processAlive(lease.bridgePid) && processAlive(lease.codexPid));
}

function readLeases(endpointFile: string): DesktopBackendLease[] {
  let names: string[];
  try { names = readdirSync(backendLeaseDirectory(endpointFile)).filter(name => /^[a-f0-9-]{36}\.json$/u.test(name)); }
  catch { return []; }
  return names.flatMap(name => {
    try {
      const value = JSON.parse(readFileSync(join(backendLeaseDirectory(endpointFile), name), "utf8")) as Partial<DesktopBackendLease>;
      return value.schema === 1 && typeof value.instanceId === "string" && `${value.instanceId}.json` === name
        && Number.isSafeInteger(value.codexPid) && Number.isSafeInteger(value.bridgePid)
        && typeof value.url === "string" && /^ws:\/\/127\.0\.0\.1:\d{1,5}$/u.test(value.url)
        ? [value as DesktopBackendLease] : [];
    } catch { return []; }
  });
}

/** Whether a process command line is a listening app-server for exactly this URL. */
export function listensAt(command: string, url: string): boolean {
  return /(^|\s)app-server(\s|$)/u.test(command) && new RegExp(`(^|\\s)--listen(\\s+|=)${url.replaceAll(".", "\\.")}(\\s|$)`, "u").test(command);
}

/** Every wrapper generation passes this Host's endpoint path to its backend. */
export function carriesEndpointMarker(environment: string, endpointFile: string): boolean {
  const marker = `${DESKTOP_ENDPOINT_MARKER}=${endpointFile}`;
  for (let index = environment.indexOf(marker); index >= 0; index = environment.indexOf(marker, index + 1)) {
    const before = index === 0 ? " " : environment[index - 1]!;
    const after = environment[index + marker.length];
    if (/\s/u.test(before) && (after === undefined || /\s/u.test(after))) return true;
  }
  return false;
}

export type ReapDependencies = {
  platform: NodeJS.Platform;
  table: () => Promise<ProcessIdentity[]>;
  /** macOS: every process's arguments in one query. */
  arguments: () => Promise<Map<number, string>>;
  command: (pid: number) => Promise<string>;
  environment: (pid: number) => Promise<string>;
  signal: (pid: number, signal: NodeJS.Signals) => void;
  wait: (ms: number) => Promise<void>;
};

async function macArguments(): Promise<Map<number, string>> {
  const { stdout } = await execute("/bin/ps", ["-axww", "-o", "pid=,args="], { timeout: 5_000, maxBuffer: 16 * 1024 * 1024 });
  const result = new Map<number, string>();
  for (const line of stdout.split("\n")) {
    const match = /^\s*(\d+)\s+(.*)$/u.exec(line);
    if (match) result.set(Number(match[1]), match[2]!);
  }
  return result;
}

async function macEnvironment(pid: number): Promise<string> {
  try { return (await execute("/bin/ps", ["-ww", "-E", "-o", "command=", "-p", String(pid)], { timeout: 5_000, maxBuffer: 4 * 1024 * 1024 })).stdout; }
  catch { return ""; }
}

const defaultDependencies = (): ReapDependencies => ({
  platform: process.platform,
  table: processTable,
  arguments: macArguments,
  command: processCommand,
  environment: macEnvironment,
  signal: (pid, signal) => { process.kill(pid, signal); },
  wait: ms => delay(ms),
});

export type ReapResult = { stopped: number[]; remaining: number[] };
type Target = { row: ProcessIdentity; instanceId?: string; evidence: string };

/**
 * Stop Desktop backends whose bridge is gone. Returns quickly when there is nothing to inspect; on
 * Windows the process table is only read when a lease or a dead previous descriptor exists.
 */
export async function reapOrphanedDesktopBackends(endpointFile: string, options: {
  log?: (line: string) => void;
  graceMs?: number;
  dependencies?: Partial<ReapDependencies>;
} = {}): Promise<ReapResult> {
  const deps = { ...defaultDependencies(), ...options.dependencies };
  const log = options.log ?? (() => {});
  const mac = deps.platform === "darwin";
  const leases = readLeases(endpointFile);
  const previous = readEndpointRecord(endpointFile);
  const previousDead = previous?.codexPid !== undefined && !endpointRecordLive(previous);
  if (!mac && leases.length === 0 && !previousDead) return { stopped: [], remaining: [] };

  const rows = await deps.table();
  const byPid = new Map(rows.map(row => [row.pid, row]));
  const args = mac ? await deps.arguments() : undefined;
  const commandOf = async (pid: number): Promise<string> => args?.get(pid) ?? await deps.command(pid).catch(() => "");
  const bridged = (backend: ProcessIdentity, bridgePid: number): boolean => {
    const bridge = byPid.get(bridgePid);
    return bridge !== undefined && isProcessChild(bridge, backend);
  };
  const targets = new Map<number, Target>();

  for (const lease of leases) {
    const backend = byPid.get(lease.codexPid);
    if (backend === undefined) { releaseBackendLease(endpointFile, lease.instanceId); continue; }
    if (bridged(backend, lease.bridgePid)) continue;
    // A reused PID cannot also listen at the leased loopback port.
    if (!listensAt(await commandOf(backend.pid), lease.url)) { releaseBackendLease(endpointFile, lease.instanceId); continue; }
    targets.set(backend.pid, { row: backend, instanceId: lease.instanceId, evidence: `lease ${lease.instanceId}` });
  }

  if (previous?.codexPid !== undefined && !targets.has(previous.codexPid)) {
    const backend = byPid.get(previous.codexPid);
    if (backend !== undefined && !bridged(backend, previous.bridgePid) && listensAt(await commandOf(backend.pid), previous.url)) {
      targets.set(backend.pid, { row: backend, evidence: "endpoint descriptor" });
    }
  }

  if (mac && args !== undefined) {
    for (const row of rows) {
      if (row.parent !== 1 || targets.has(row.pid)) continue;
      const command = args.get(row.pid) ?? "";
      if (!/(^|\s)app-server(\s|$)/u.test(command) || !/(^|\s)--listen(\s+|=)ws:\/\/127\.0\.0\.1:\d+/u.test(command)) continue;
      if (!carriesEndpointMarker(await deps.environment(row.pid), endpointFile)) continue;
      targets.set(row.pid, { row, evidence: `orphan ${basename(row.executable)}` });
    }
  }

  if (targets.size === 0) return { stopped: [], remaining: [] };
  const result = await stopBackends([...targets.values()], deps, options.graceMs ?? 3_000, log);
  for (const target of targets.values()) {
    if (target.instanceId !== undefined && result.stopped.includes(target.row.pid)) releaseBackendLease(endpointFile, target.instanceId);
  }
  return result;
}

async function stopBackends(targets: Target[], deps: ReapDependencies, graceMs: number, log: (line: string) => void): Promise<ReapResult> {
  const alive = async (): Promise<Target[]> => {
    const rows = await deps.table();
    return targets.filter(target => rows.some(row => sameProcess(row, target.row)));
  };
  const send = async (signal: NodeJS.Signals): Promise<void> => {
    // Re-check identity immediately before signalling: a PID may have been reused meanwhile.
    for (const target of await alive()) {
      if (target.row.pid <= 1 || target.row.pid === process.pid) continue;
      log(`回收无人持有的 Codex 桌面后端 pid=${target.row.pid}（${target.evidence}）：${signal}`);
      try { deps.signal(target.row.pid, signal); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") log(`无法结束 pid=${target.row.pid}：${String(error)}`); }
    }
  };
  const settle = async (deadlineMs: number): Promise<Target[]> => {
    const deadline = Date.now() + deadlineMs;
    let remaining = await alive();
    while (remaining.length > 0 && Date.now() < deadline) {
      await deps.wait(100);
      remaining = await alive();
    }
    return remaining;
  };
  await send("SIGTERM");
  let remaining = await settle(graceMs);
  if (remaining.length > 0) {
    await send("SIGKILL");
    remaining = await settle(2_000);
  }
  const left = new Set(remaining.map(target => target.row.pid));
  return { stopped: targets.map(target => target.row.pid).filter(pid => !left.has(pid)), remaining: [...left] };
}
