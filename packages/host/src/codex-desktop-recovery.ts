/**
 * Why the last Desktop launch is not attached, persisted beside the endpoint descriptor so Host can say
 * so after the wrapper has gone (ADR-0022 2026-11-14, ADR-0096).
 *
 * Phases keep the schema-1 names written by earlier wrappers:
 * - `unattached`: Codex runs natively (stdio fallback or a native open); usable, not attached.
 * - `retrying`: Host re-enabled the wrapper and is waiting for its endpoint.
 * - `failed`: Codex could not be opened or its native CLI exited abnormally.
 * - `native`: no CLI could start through the wrapper; the Orbis entry was suspended so the next
 *   launch is native.
 * A live endpoint always takes precedence, and the bridge clears the record once it is ready.
 */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { CodexDesktopAttach } from "@orbis/protocol";
import { looksLikeOrbisWrapperEntry, suspendCodexDesktopEntry } from "./codex-shim-install.js";

export type DesktopRecoveryPhase = "unattached" | "retrying" | "failed" | "native";

export function desktopRecoveryPath(endpointFile: string): string {
  return join(dirname(endpointFile), "codex-desktop-recovery.json");
}

export function desktopDigestCachePath(endpointFile: string): string {
  return join(dirname(endpointFile), "codex-desktop-cli-digests.json");
}

export function readDesktopRecoveryPhase(endpointFile: string): DesktopRecoveryPhase | undefined {
  try {
    const record = JSON.parse(readFileSync(desktopRecoveryPath(endpointFile), "utf8")) as { schema?: unknown; phase?: unknown };
    return record.schema === 1 && typeof record.phase === "string" && ["unattached", "retrying", "failed", "native"].includes(record.phase)
      ? record.phase as DesktopRecoveryPhase : undefined;
  } catch { return undefined; }
}

/** `duringStartup` ignores Host's own retry marker while it waits for the endpoint it asked for. */
export function readDesktopRecoveryStatus(endpointFile: string, duringStartup = false): CodexDesktopAttach | undefined {
  try {
    const record = JSON.parse(readFileSync(desktopRecoveryPath(endpointFile), "utf8")) as { schema?: unknown; reason?: unknown; phase?: unknown };
    if (record.schema !== 1 || typeof record.reason !== "string") return undefined;
    if (duringStartup && record.phase === "retrying") return undefined;
    return { state: record.phase === "unattached" || record.phase === "retrying" ? "closed" : "error", reason: record.reason };
  } catch { return undefined; }
}

function writeRecovery(endpointFile: string, phase: DesktopRecoveryPhase, reason: string, detail?: unknown): void {
  const file = desktopRecoveryPath(endpointFile), temporary = `${file}.${process.pid}.tmp`;
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(temporary, JSON.stringify({ schema: 1, phase, reason,
      ...(detail === undefined ? {} : { detail: String(detail).slice(0, 4000) }), at: new Date().toISOString() }), { mode: 0o600 });
    renameSync(temporary, file);
  } finally {
    try { rmSync(temporary, { force: true }); } catch { /* Preserve the original failure. */ }
  }
}

export function clearDesktopRecovery(endpointFile: string): void {
  try { rmSync(desktopRecoveryPath(endpointFile), { force: true }); } catch { /* A live endpoint takes precedence. */ }
}

export function markDesktopRecoveryRetry(endpointFile: string,
  reason = "正在等待 Codex 桌面版接入；如果它已用原生方式打开，请完全退出后从 Orbis 打开。"): void {
  writeRecovery(endpointFile, "retrying", reason);
}

export function recordDesktopUnattached(endpointFile: string, reason: string, detail?: unknown): void {
  writeRecovery(endpointFile, "unattached", reason, detail);
}

export function recordDesktopStdioFallback(endpointFile: string, detail: unknown): void {
  recordDesktopUnattached(endpointFile, "Codex 已改用原生连接，未接入 Orbis；需要手机接入时，请完全退出 Codex 后从 Orbis 打开。", detail);
}

export function recordDesktopStartupFailure(endpointFile: string, reason: string, detail: unknown): void {
  writeRecovery(endpointFile, "failed", reason, detail);
}

/**
 * Last resort when no CLI could start through the wrapper. Never terminates Desktop or Host; restores
 * only the Orbis-owned entry so the user's next launch is native, and reports a failed restore.
 */
export async function recoverNativeDesktop(endpointFile: string, error: unknown,
  suspend: () => Promise<void> = suspendCodexDesktopEntry, cause: "cli" | "wrapper" = "cli", platform = process.platform): Promise<string> {
  let suspendFailure: unknown;
  try { await suspend(); } catch (failure) { suspendFailure = failure; }
  const subject = cause === "wrapper" ? "Orbis 未能准备好 Codex 包装器" : "Orbis 未找到可运行的匹配 CLI";
  const app = platform === "darwin" ? "程序坞" : "开始菜单";
  const reason = suspendFailure === undefined
    ? `${subject}，已暂停桌面接入。请自行完全退出 Codex，再从${app}重新打开；无需重启 Host。`
    : `${subject}，且未能恢复原生启动入口。请检查用户环境变量 CODEX_CLI_PATH 中的 Orbis 入口；无需重启 Host。`;
  writeRecovery(endpointFile, "native", reason, [String(error), ...(suspendFailure === undefined ? [] : [String(suspendFailure)])].join("\n"));
  return reason;
}

/** Environment for a native launch: drop Orbis wrapper variables and an inherited Orbis CLI override. */
export function nativeDesktopEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const native = { ...env };
  for (const key of ["ORBIS_CODEX_WRAPPER_NODE", "ORBIS_CODEX_WRAPPER_SCRIPT", "ORBIS_CODEX_DESKTOP_ENDPOINT"]) delete native[key];
  if (native.CODEX_CLI_PATH && looksLikeOrbisWrapperEntry(native.CODEX_CLI_PATH)) delete native.CODEX_CLI_PATH;
  return native;
}
