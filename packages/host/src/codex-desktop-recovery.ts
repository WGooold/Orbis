import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { looksLikeOrbisWrapperEntry, suspendCodexDesktopEntry } from "./codex-shim-install.js";

export function desktopRecoveryPath(endpointFile: string): string {
  return join(dirname(endpointFile), "codex-desktop-recovery.json");
}
export function desktopDigestCachePath(endpointFile: string): string {
  return join(dirname(endpointFile), "codex-desktop-cli-digests.json");
}
export function readDesktopRecoveryReason(endpointFile: string, duringStartup = false): string | undefined {
  try {
    const record = JSON.parse(readFileSync(desktopRecoveryPath(endpointFile), "utf8")) as { schema?: unknown; reason?: unknown; phase?: unknown };
    if (duringStartup && record.phase === "retrying") return undefined;
    return record.schema === 1 && typeof record.reason === "string" ? record.reason : undefined;
  } catch { return undefined; }
}
function writeRecovery(endpointFile: string, record: Record<string, unknown>): void {
  const file = desktopRecoveryPath(endpointFile), temporary = file + "." + process.pid + ".tmp";
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(temporary, JSON.stringify({ schema: 1, ...record, at: new Date().toISOString() }));
    renameSync(temporary, file);
  } finally {
    try { rmSync(temporary, { force: true }); } catch { /* Preserve the original failure. */ }
  }
}

export function markDesktopRecoveryRetry(endpointFile: string): void {
  writeRecovery(endpointFile, { phase: "retrying", reason: "匹配 CLI 已通过启动检查，正在等待桌面接入。若 Codex 已在原生模式运行，请自行完全退出，再从 Orbis 打开；无需重启 Host。" });
}
export function clearDesktopRecovery(endpointFile: string): void {
  try { rmSync(desktopRecoveryPath(endpointFile), { force: true }); } catch { /* A live endpoint takes precedence. */ }
}

/** Do not terminate Desktop or Host. Restore only the Orbis-owned entry for the next GUI launch. */
export async function recoverNativeDesktop(endpointFile: string, error: unknown,
  suspend: () => Promise<void> = suspendCodexDesktopEntry): Promise<string> {
  let restored = true;
  try { await suspend(); } catch { restored = false; }
  const reason = restored
    ? "Orbis 未找到可运行的匹配 CLI，已暂停桌面接入。请自行完全退出并从开始菜单重新打开 Codex，完成后再从 Orbis 接入；无需重启 Host。"
    : "Orbis 未找到可运行的匹配 CLI，且未能恢复原生启动入口。请检查用户环境变量 CODEX_CLI_PATH 中的 Orbis 入口；无需重启 Host。";
  writeRecovery(endpointFile, { phase: "native", reason, detail: String(error).slice(0, 4000) });
  return reason;
}

export function nativeDesktopEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const native = { ...env };
  // Caller uses this only while recovery is active, after checking persistent entry ownership.
  for (const key of ["ORBIS_CODEX_WRAPPER_NODE", "ORBIS_CODEX_WRAPPER_SCRIPT", "ORBIS_CODEX_DESKTOP_ENDPOINT"]) delete native[key];
  if (native.CODEX_CLI_PATH && looksLikeOrbisWrapperEntry(native.CODEX_CLI_PATH)) delete native.CODEX_CLI_PATH;
  return native;
}
