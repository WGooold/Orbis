/**
 * The endpoint descriptor is the only interface between the Desktop wrapper and Host (ADR-0096).
 *
 * The wrapper publishes it atomically once its bridge is ready and withdraws it only while it still
 * names that bridge, so a wrapper that is shutting down cannot hide its successor. Host accepts a
 * descriptor only for a live bridge and backend that started during the current boot. Schema 1 stays
 * readable by released Hosts; fields added later are optional.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { uptime } from "node:os";
import { dirname, join } from "node:path";
import { resolveStateDir } from "@orbis/e2e";

import type { DesktopRefreshEndpoint } from "./codex-desktop-refresh-bridge.js";

export type CodexDesktopEndpointRecord = {
  schema: 1;
  url: string;
  codexPid: number | undefined;
  bridgePid: number;
  startedAt: string;
  /** Added by ADR-0096; absent in descriptors from earlier wrappers. */
  instanceId?: string;
  refresh?: DesktopRefreshEndpoint;
};

/** What Host needs from a live descriptor. */
export type CodexDesktopEndpoint = { url: string; bridgePid: number; refresh?: DesktopRefreshEndpoint };

const LOOPBACK_WS = /^ws:\/\/127\.0\.0\.1:\d{1,5}$/u;
const LOOPBACK_HTTP = /^http:\/\/127\.0\.0\.1:\d{1,5}$/u;
const UUID = /^[a-f0-9-]{36}$/u;
/** A descriptor written before this boot names a PID that may now belong to anything. */
const BOOT_SKEW_MS = 60_000;

export function codexDesktopEndpointPath(stateDir: string): string {
  return join(stateDir, "codex-desktop-endpoint.json");
}

/** The wrapper's view: the launcher or Host passes the path; otherwise the default Host state directory. */
export function wrapperEndpointPath(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.ORBIS_CODEX_DESKTOP_ENDPOINT?.trim();
  if (explicit) return explicit;
  return codexDesktopEndpointPath(resolveStateDir(env.ORBIS_HOST_STATE_DIR?.trim() || undefined));
}

export function processAlive(pid: number | undefined): boolean {
  if (pid === undefined || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM still proves the PID exists; only ESRCH means it is gone.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function refreshOf(value: unknown): DesktopRefreshEndpoint | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const refresh = value as Partial<DesktopRefreshEndpoint>;
  return typeof refresh.url === "string" && LOOPBACK_HTTP.test(refresh.url)
    && typeof refresh.token === "string" && UUID.test(refresh.token)
    && typeof refresh.instanceId === "string" && UUID.test(refresh.instanceId)
    ? { url: refresh.url, token: refresh.token, instanceId: refresh.instanceId } : undefined;
}

/** Syntactic validation only: the reaper also needs descriptors whose bridge has died. */
export function readEndpointRecord(path: string): CodexDesktopEndpointRecord | undefined {
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(path, "utf8")); }
  catch { return undefined; }
  if (parsed === null || typeof parsed !== "object") return undefined;
  const value = parsed as Record<string, unknown>;
  // Only loopback: the descriptor must never point Host at an arbitrary address.
  if (value.schema !== 1 || typeof value.url !== "string" || !LOOPBACK_WS.test(value.url)) return undefined;
  const bridgePid = Number(value.bridgePid);
  if (!Number.isInteger(bridgePid) || bridgePid <= 0) return undefined;
  const codexPid = Number(value.codexPid);
  const refresh = refreshOf(value.refresh);
  return {
    schema: 1, url: value.url, bridgePid,
    codexPid: Number.isInteger(codexPid) && codexPid > 0 ? codexPid : undefined,
    startedAt: typeof value.startedAt === "string" ? value.startedAt : "",
    ...(typeof value.instanceId === "string" && UUID.test(value.instanceId) ? { instanceId: value.instanceId } : {}),
    ...(refresh === undefined ? {} : { refresh }),
  };
}

function startedBeforeBoot(startedAt: string, now = Date.now()): boolean {
  const started = Date.parse(startedAt);
  return Number.isFinite(started) && started < now - uptime() * 1000 - BOOT_SKEW_MS;
}

/** A descriptor names a bridge that can still serve Host. */
export function endpointRecordLive(record: CodexDesktopEndpointRecord): boolean {
  return processAlive(record.bridgePid) && (record.codexPid === undefined || processAlive(record.codexPid))
    && !startedBeforeBoot(record.startedAt);
}

/** Host only attaches to a live bridge; a dead one would leave status stuck on a refused port. */
export function readCodexDesktopEndpoint(path: string): CodexDesktopEndpoint | undefined {
  const record = readEndpointRecord(path);
  if (record === undefined || !endpointRecordLive(record)) return undefined;
  return { url: record.url, bridgePid: record.bridgePid, ...(record.refresh === undefined ? {} : { refresh: record.refresh }) };
}

export function endpointText(record: CodexDesktopEndpointRecord): string {
  return `${JSON.stringify(record, null, 2)}\n`;
}

/** Atomic replace: Host polls the file and must never read half a descriptor. */
export function publishEndpoint(path: string, record: CodexDesktopEndpointRecord): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, endpointText(record), { mode: 0o600, flag: "wx" });
    renameSync(temporary, path);
  } finally {
    try { rmSync(temporary, { force: true }); } catch { /* Preserve the original failure. */ }
  }
}

export function sameBridge(left: CodexDesktopEndpointRecord, right: CodexDesktopEndpointRecord): boolean {
  return left.bridgePid === right.bridgePid && left.url === right.url && left.startedAt === right.startedAt;
}

/** Remove the descriptor only while it still names this bridge. */
export function withdrawEndpoint(path: string, record: CodexDesktopEndpointRecord): void {
  const current = readEndpointRecord(path);
  if (current === undefined || !sameBridge(current, record)) return;
  try { rmSync(path, { force: true }); } catch { /* Host also rejects a descriptor whose bridge has exited. */ }
}
