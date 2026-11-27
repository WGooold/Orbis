/**
 * The one place Host wires the Codex Desktop lifecycle to the wrapper's files (ADR-0096): endpoint
 * discovery, launch records, refresh bridge, launch, orphan reaping and the precise reason a running
 * Desktop is not attached. The headless CLI Host and the desktop Host share it.
 */
import { join } from "node:path";

import type { CodexDesktopAttach } from "@orbis/protocol";
import { reapOrphanedDesktopBackends, startingBackendLease } from "./codex-desktop-backends.js";
import { isRegisteredWindowsDesktopCli } from "./codex-desktop-cli.js";
import { codexDesktopEndpointPath, readCodexDesktopEndpoint } from "./codex-desktop-endpoint.js";
import { launchCodexDesktop, resolveCodexWrapper } from "./codex-desktop-launcher.js";
import { CodexDesktopLifecycle, type CodexDesktopLifecycleOptions } from "./codex-desktop-lifecycle.js";
import { readLaunchdEnvironment } from "./codex-desktop-macos.js";
import { readDesktopRecoveryStatus } from "./codex-desktop-recovery.js";
import { CODEX_DESKTOP_ENTRY_NAME, looksLikeOrbisWrapperEntry, readWindowsCodexDesktopEntry } from "./codex-shim-install.js";

export type CodexDesktopIntegrationOptions = Pick<CodexDesktopLifecycleOptions, "onReady" | "onOffline" | "onStatusChange"> & {
  stateDir: string;
  log: (line: string) => void;
};

export type NoEndpointDiagnosis = { status: CodexDesktopAttach; pending?: boolean };

/**
 * Why a running Codex Desktop has no endpoint (ADR-0096 CODEX-DESKTOP-LAUNCH-02). Recorded launch
 * outcomes are read before this; here only live facts: a wrapper still starting, and the entry
 * Codex read at startup (absent, someone else's, or ours).
 */
export async function diagnoseNoEndpoint(endpointPath: string, options: {
  platform?: NodeJS.Platform;
  readEntry?: () => Promise<string | undefined>;
  starting?: () => boolean;
} = {}): Promise<NoEndpointDiagnosis | undefined> {
  const platform = options.platform ?? process.platform;
  if ((options.starting ?? (() => startingBackendLease(endpointPath) !== undefined))()) {
    return { status: { state: "closed", reason: "Codex 桌面版正在启动 Orbis 接入，请稍候。" }, pending: true };
  }
  const readEntry = options.readEntry ?? (platform === "darwin" ? () => readLaunchdEnvironment(CODEX_DESKTOP_ENTRY_NAME)
    : platform === "win32" ? readWindowsCodexDesktopEntry : undefined);
  if (readEntry === undefined) return undefined;
  let entry: string | undefined;
  try { entry = (await readEntry())?.trim() || undefined; }
  catch { return undefined; }
  const quit = platform === "darwin" ? "完全退出 Codex（⌘Q）" : "从托盘完全退出 Codex";
  if (entry !== undefined && !looksLikeOrbisWrapperEntry(entry)) {
    if (platform === "win32" && await isRegisteredWindowsDesktopCli(entry)) {
      return { status: { state: "closed", reason: `Codex 桌面版以原生方式运行，尚未接入。请${quit}，再从 Orbis 打开。` } };
    }
    return { status: { state: "error", reason: `${CODEX_DESKTOP_ENTRY_NAME} 已被其他程序设置为 ${entry}，Orbis 没有改动它，因此无法接入 Codex 桌面版。如需接入，请移除该设置，再${quit}后从 Orbis 打开。` } };
  }
  if (entry === undefined) {
    return { status: { state: "closed", reason: `Orbis 的桌面接入入口尚未登记，当前 Codex 未接入。请${quit}后从 Orbis 打开。` } };
  }
  return { status: { state: "closed", reason: `Codex 桌面版是以未接入方式打开的（早于接入入口登记，或接入曾被暂停）。请${quit}后从 Orbis 或程序坞重新打开。` } };
}

export function createCodexDesktopLifecycle({ stateDir, log, ...callbacks }: CodexDesktopIntegrationOptions): CodexDesktopLifecycle {
  const endpointPath = codexDesktopEndpointPath(stateDir);
  if (resolveCodexWrapper() === undefined) log("未找到 Orbis 包装器（codex-launcher 或 codex-desktop-wrapper.js），Codex 桌面版将以原生方式打开，无法接入");
  // Reading the system entry costs a process: reuse a settled diagnosis briefly while the status polls.
  let cached: { at: number; value: NoEndpointDiagnosis | undefined } | undefined;
  return new CodexDesktopLifecycle({
    ...callbacks,
    log,
    resolveEndpoint: async () => readCodexDesktopEndpoint(endpointPath)?.url,
    resolveStartupFailure: waiting => readDesktopRecoveryStatus(endpointPath, waiting),
    desktopRefresh: { journalDirectory: join(stateDir, "codex-desktop-refresh"), resolveBridge: () => readCodexDesktopEndpoint(endpointPath)?.refresh },
    // Resolve on every launch: a Host update or move changes where the wrapper lives.
    launchApp: signal => launchCodexDesktop(resolveCodexWrapper(), endpointPath, signal === undefined ? {} : { signal }),
    reapBackends: () => reapOrphanedDesktopBackends(endpointPath, { log }),
    diagnoseNoEndpoint: async () => {
      if (startingBackendLease(endpointPath) !== undefined) return diagnoseNoEndpoint(endpointPath);
      if (cached !== undefined && Date.now() - cached.at < 10_000) return cached.value;
      const value = await diagnoseNoEndpoint(endpointPath, { starting: () => false });
      cached = { at: Date.now(), value };
      return value;
    },
  });
}

/** Open Codex from the Host UI while no lifecycle exists (Host paused or Desktop integration off). */
export function openCodexDesktop(stateDir: string, signal?: AbortSignal): Promise<void> {
  return launchCodexDesktop(resolveCodexWrapper(), codexDesktopEndpointPath(stateDir), signal === undefined ? {} : { signal });
}
