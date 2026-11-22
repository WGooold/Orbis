/**
 * How one Codex Desktop CLI invocation runs (ADR-0022, ADR-0096). Loaded by the entry
 * codex-desktop-wrapper.ts, which Codex runs through `CODEX_CLI_PATH` (via `codex-launcher.exe` on
 * Windows, a generated launcher on macOS).
 *
 * Every invocation runs the CLI that belongs to the launching Desktop, never a PATH or terminal CLI:
 * - `app-server --print-startup-config` is a read-only probe; the selected CLI's output and status are
 *   forwarded byte for byte, and only this probe may be retried with another candidate;
 * - other commands (`login`, `exec`, `--version`, sign-out) run once and are never replayed after spawn;
 * - a long-running `app-server` from the Desktop GUI is bridged (codex-desktop-bridge.ts). Orphaned
 *   backends of earlier bridges are stopped first, because they hold native thread writer locks.
 *
 * Failure order: another candidate when the OS cannot start a CLI; the same CLI on native stdio when
 * the bridge cannot be set up; only when nothing can start, suspend the Orbis entry and exit 127 so the
 * user's next launch is native.
 */
import { DesktopBridgeSetupError, runBridge } from "./codex-desktop-bridge.js";
import { reapOrphanedDesktopBackends } from "./codex-desktop-backends.js";
import { resolveDesktopCli, type DesktopCli, type DesktopCliCandidate, type DesktopCliOptions } from "./codex-desktop-cli.js";
import { wrapperEndpointPath } from "./codex-desktop-endpoint.js";
import { nativeLauncher, runWithoutOrbis } from "./codex-desktop-native-fallback.js";
import { desktopDigestCachePath, recordDesktopStartupFailure, recordDesktopStdioFallback, recordDesktopUnattached, recoverNativeDesktop } from "./codex-desktop-recovery.js";
import { suspendCodexDesktopEntry } from "./codex-shim-install.js";
import { DesktopCliSpawnError, desktopVersionFromArgs, isStartupPolicyQuery, passthroughCandidates, selectStartupCli, startDesktopCli, startupProbeArgs } from "./codex-desktop-startup.js";

export { DesktopBridgeSetupError, runBridge } from "./codex-desktop-bridge.js";

function log(line: string): void {
  process.stderr.write(`[orbis-codex-wrapper] ${line}\n`);
}

/** `app-server` one-shot queries must be forwarded, not bridged as a long-running server. */
const ONE_SHOT_APP_SERVER_ARGS = new Set(["--print-startup-config", "--startup-sign-out"]);

export function isAppServerInvocation(args: readonly string[]): boolean {
  return args.includes("app-server") && !args.some(arg => ONE_SHOT_APP_SERVER_ARGS.has(arg));
}

/** The Desktop enables this when its app-server needs the separate code-mode host. */
export function requestsCodeModeHost(args: readonly string[]): boolean {
  return isAppServerInvocation(args) && args.some(arg => arg.replaceAll(" ", "") === "features.code_mode_host=true");
}

type Invocation = "startup-query" | "sign-out" | "server" | "command";

function classify(args: readonly string[]): Invocation {
  if (isStartupPolicyQuery(args)) return "startup-query";
  if (args.includes("--startup-sign-out")) return "sign-out";
  return isAppServerInvocation(args) ? "server" : "command";
}

export type WrapperOptions = DesktopCliOptions & {
  recover?: typeof recoverNativeDesktop;
  reap?: (endpointFile: string) => Promise<unknown>;
  /** macOS last resort before suspending the entry; see codex-desktop-native-fallback.ts. */
  runNative?: (argv: readonly string[], env: NodeJS.ProcessEnv) => Promise<number | undefined>;
};

/** Native stdio keeps the backend's lifetime tied to the GUI pipe; forward termination signals too. */
async function runNativeStdio(cli: DesktopCli, args: readonly string[], env: NodeJS.ProcessEnv): Promise<{ code: number; stopped: boolean }> {
  const { child, closed } = await startDesktopCli(cli, args, { env, stdio: "inherit", windowsHide: false });
  const signals = ["SIGTERM", "SIGINT", "SIGHUP"] as const;
  let stopped = false;
  const forward = (signal: NodeJS.Signals): void => { stopped = true; try { child.kill(signal); } catch { /* exited */ } };
  const exitHook = (): void => { try { child.kill("SIGKILL"); } catch { /* exited */ } };
  for (const signal of signals) process.on(signal, forward);
  process.on("exit", exitHook);
  try {
    const code = await closed;
    return { code, stopped: stopped || child.signalCode !== null };
  } finally {
    for (const signal of signals) process.off(signal, forward);
    process.off("exit", exitHook);
  }
}

async function serveDesktop(candidates: readonly DesktopCliCandidate[], argv: readonly string[], env: NodeJS.ProcessEnv,
  endpointFile: string, windows: boolean, report: (message: string) => void): Promise<number> {
  let remaining = [...candidates];
  while (remaining.length > 0) {
    // Windows validates the protocol with the read-only probe; never by signing out or serving.
    const selected = windows ? (await selectStartupCli(remaining, startupProbeArgs(argv), env, log)).cli : remaining[0]!;
    remaining = remaining.slice(remaining.indexOf(selected) + 1);
    try {
      return await runBridge({ codex: selected, args: argv, endpointFile, env, log });
    } catch (error) {
      if (error instanceof DesktopCliSpawnError || error instanceof DesktopBridgeSetupError && error.cliUnavailable) {
        report(error.message);
        continue;
      }
      if (!(error instanceof DesktopBridgeSetupError)) throw error;
      log(`桥接建立失败，已停止本次后端，回退到同一 CLI 的原生 stdio：${error.message}`);
      try { recordDesktopStdioFallback(endpointFile, `${selected.command}：${error.message}`); }
      catch (recordError) { log(`无法记录桌面恢复状态：${String(recordError)}`); }
      const native = await runNativeStdio(selected, argv, env);
      if (!native.stopped && native.code !== 0) {
        const detail = `Codex 原生 CLI ${selected.command} 退出（code=${native.code}）`;
        log(detail);
        try { recordDesktopStartupFailure(endpointFile, "Codex 原生进程已异常退出。请完全退出后重新打开 Codex；仍失败时，请检查桌面版安装。", detail); }
        catch (recordError) { log(`无法记录桌面恢复状态：${String(recordError)}`); }
      }
      return native.code;
    }
  }
  throw new Error("没有可启动的 Codex CLI");
}

let stdioGuarded = false;

/** Entry: decides how this Desktop invocation runs and sets `process.exitCode`. */
export async function main(argv: readonly string[], env: NodeJS.ProcessEnv = process.env, options: WrapperOptions = {}): Promise<void> {
  if (!stdioGuarded) {
    // Codex may close our pipes first. A write error must never crash past backend cleanup; the bridge
    // also watches stdout and shuts down on its own error.
    for (const stream of [process.stdout, process.stderr]) stream.on("error", () => {});
    stdioGuarded = true;
  }
  const endpointFile = wrapperEndpointPath(env);
  const platform = options.platform ?? process.platform;
  const windows = platform === "win32";
  const invocation = classify(argv);
  const failures: string[] = [];
  const report = (message: string): void => { failures.push(message); log(message); };
  try {
    const version = desktopVersionFromArgs(argv);
    const { candidates, fromDesktop, uncertain } = await resolveDesktopCli(env, {
      ...options, platform, log: report,
      ...(windows ? { requireCodeModeHost: requestsCodeModeHost(argv), digestCacheFile: desktopDigestCachePath(endpointFile) } : {}),
      ...(version === undefined ? {} : { desktopVersion: version }),
    });
    switch (invocation) {
      case "startup-query": {
        const { result } = await selectStartupCli(candidates, argv, env, report);
        process.stdout.write(result.stdout);
        process.stderr.write(result.stderr);
        process.exitCode = result.code;
        return;
      }
      case "command":
        process.exitCode = await passthroughCandidates(candidates, argv, env, report);
        return;
      case "sign-out": {
        // Probe with the read-only query, then sign out exactly once with a CLI that started.
        let remaining = [...candidates];
        while (remaining.length > 0) {
          const selected = windows ? (await selectStartupCli(remaining, startupProbeArgs(argv), env, report)).cli : remaining[0]!;
          remaining = remaining.slice(remaining.indexOf(selected) + 1);
          try {
            process.exitCode = await (await startDesktopCli(selected, argv, { env, stdio: "inherit", windowsHide: false })).closed;
            return;
          } catch (error) {
            if (!(error instanceof DesktopCliSpawnError)) throw error;
            report(error.message);
          }
        }
        throw new Error("没有可启动的 Codex CLI");
      }
      case "server":
        if (!fromDesktop) {
          // Another client honouring CODEX_CLI_PATH must not be published as the Desktop backend.
          log("调用方不是 Codex 桌面版，透明转发，不接入 Orbis");
          // When the caller could not be checked at all, it may well be the Desktop: say so.
          if (uncertain !== undefined) {
            try { recordDesktopUnattached(endpointFile, `无法确认 Codex 桌面版进程（${uncertain.slice(0, 80)}），本次未接入 Orbis。请完全退出 Codex 后重新打开。`); }
            catch { /* Diagnostic only. */ }
          }
          process.exitCode = await passthroughCandidates(candidates, argv, env, report);
          return;
        }
        try { await (options.reap ?? (file => reapOrphanedDesktopBackends(file, { log })))(endpointFile); }
        catch (error) { log(`回收遗留桌面后端失败（继续启动）：${String(error)}`); }
        process.exitCode = await serveDesktop(candidates, argv, env, endpointFile, windows, report);
        return;
    }
  } catch (error) {
    // Nothing has started for this invocation. On macOS let the launcher try the Desktop's own CLI
    // first: an Orbis fault must not cost the user this launch.
    const launcher = options.runNative === undefined ? nativeLauncher(env, platform) : undefined;
    const native = options.runNative ?? (launcher === undefined ? undefined
      : (args: readonly string[], target: NodeJS.ProcessEnv) => runWithoutOrbis(launcher, args, target));
    if (!windows && native !== undefined) {
      log(`Orbis 无法运行此次调用（${String(error).slice(0, 160)}），改用 Codex 自带 CLI，本次未接入 Orbis。`);
      const code = await native(argv, env).catch(() => undefined);
      // 127 is the launcher's own "no runnable CLI in the launching bundle".
      if (code !== undefined && code !== 127) {
        if (invocation === "server") {
          try { recordDesktopUnattached(endpointFile, "Orbis 未能接管本次 Codex 启动，已改用 Codex 自带 CLI 运行，本次未接入。请完全退出 Codex 后重新打开；仍未接入时，请重新安装 Orbis Host。", [String(error), ...failures].join("\n")); }
          catch { /* Diagnostic only. */ }
        }
        process.exitCode = code;
        return;
      }
    }
    let recovery: string | undefined;
    // Only a Desktop server start that found nothing runnable suspends the entry; one-shot commands
    // report their own failure to the GUI.
    if (windows || invocation === "server" || invocation === "startup-query") {
      try {
        const recover = options.recover ?? recoverNativeDesktop;
        recovery = windows ? await recover(endpointFile, error)
          : await recover(endpointFile, new Error([String(error), ...failures].join("\n")), () => suspendCodexDesktopEntry(env.CODEX_CLI_PATH?.trim() ?? ""), "cli", platform);
      } catch (recoveryError) { log(`无法记录桌面恢复状态：${String(recoveryError)}`); }
    }
    // Desktop shows only the last stderr chunk: the next step first, then the decisive cause.
    const cause = [String(error), failures.at(-1)].filter(Boolean).join("；").slice(0, 240);
    log(`${recovery ?? "Orbis 未能启动 Codex CLI。请完全退出 Codex 后从程序坞或开始菜单重新打开。"}（${cause}）`);
    process.exitCode = 127;
  }
}
