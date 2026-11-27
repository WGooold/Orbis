import { execFile, spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { agentCommandForEntry, cliSearchDirs, findExternalAgentEntries, stopAgentProcess } from "./agent-command.js";
import { findKimiDesktopBundle, supportsKimiDesktop, verifyKimiDesktopBundle } from "./kimi-desktop-owner.js";
import { KIMI_WEB_VERSION, KimiWebError, type KimiSource } from "./kimi-web-client.js";

const run = promisify(execFile);
type LaunchRequest = {
  signal: AbortSignal;
  /** Re-probe after inspecting the executable, then check the request's authorization immediately before opening. */
  shouldStart: () => Promise<boolean>;
  waitForConnection: (checkChild?: () => void) => Promise<number>;
};
export type KimiLauncher = {
  available: () => Promise<boolean>;
  start: (request: LaunchRequest) => Promise<void>;
};

/** Known local installations only. No installs, alternate source, shell command, or args from the phone. */
export function createKimiLauncher(options: { source?: KimiSource; homeDir: string; endpoint?: string; env?: NodeJS.ProcessEnv }): KimiLauncher | undefined {
  // An explicit origin belongs to its original launcher; never silently start a different service.
  if (options.endpoint !== undefined || !isAbsolute(options.homeDir)) return undefined;
  const home = homedir();
  if (options.source === "desktop") {
    // The app opens the OS user’s Desktop profile. Non-default homes remain attach-only.
    if (!supportsKimiDesktop || options.homeDir !== join(home, ".kimi-code")) return undefined;
    return {
      available: async () => await findKimiDesktopBundle() !== undefined,
      start: async ({ signal, shouldStart, waitForConnection }) => {
        const bundle = await findKimiDesktopBundle();
        if (!bundle) throw new KimiWebError("not_installed", "未找到 Kimi Code 桌面版，请先在电脑上安装");
        if (!await verifyKimiDesktopBundle(bundle, signal)) throw new KimiWebError("unsupported", "Kimi Code 桌面版的版本或签名不受支持");
        if (!await shouldStart()) return;
        signal.throwIfAborted();
        // Background open, with no new-instance flag. An already-open app is neither duplicated nor quit.
        try {
          if (process.platform === "win32") {
            const env = Object.fromEntries(Object.entries(options.env ?? process.env).filter(([key]) => !/^(?:ORBIS_|ELECTRON_|NODE_OPTIONS$|NODE_PATH$|KIMI_CODE_HOME$)/iu.test(key)));
            const child = spawn(bundle, [], { cwd: dirname(bundle), env, detached: true, windowsHide: true, stdio: "ignore" });
            await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.on("error", reject); });
            child.unref();
          } else await run("/usr/bin/open", ["-g", "-a", bundle], { signal, timeout: 5000, maxBuffer: 8192 });
        } catch { throw new KimiWebError("unavailable", "无法打开 Kimi Code 桌面版"); }
        await waitForConnection();
      },
    };
  }

  const env = { ...(options.env ?? process.env) };
  for (const key of Object.keys(env)) if (/^orbis_/iu.test(key) || (key.toUpperCase() === "PATH" && key !== "PATH")) delete env[key];
  const dirs = cliSearchDirs("kimi", options.env ?? process.env, process.platform, home);
  env.PATH = dirs.join(delimiter);
  env.KIMI_CODE_HOME = options.homeDir;
  const find = async () => {
    for (const candidate of await findExternalAgentEntries("kimi", env, process.platform, home)) {
      // Official Windows installs are an exe or a resolved npm JS bin; don't leave cmd or PowerShell as a server parent.
      if (process.platform === "win32" && !/\.(?:exe|[cm]?js)$/iu.test(candidate.entry)) continue;
      if (await stat(candidate.entry).then(info => info.isFile(), () => false)) return candidate;
    }
    return undefined;
  };
  return {
    available: async () => await find() !== undefined,
    start: async ({ signal, shouldStart, waitForConnection }) => {
      const installed = await find();
      if (!installed) throw new KimiWebError("not_installed", "未找到 Kimi Code CLI，请先在电脑上安装");
      const cli = await agentCommandForEntry(installed.entry, env).catch(() => { throw new KimiWebError("unavailable", "Kimi Code CLI 启动入口不可用"); });
      let version: string;
      try {
        version = (await run(cli.command, [...cli.prefixArgs, "--version"], { cwd: home, env, signal, windowsHide: true, timeout: 5000, maxBuffer: 8192 })).stdout.trim();
      } catch { throw new KimiWebError("unavailable", "无法检查 Kimi Code CLI 版本"); }
      if (version !== KIMI_WEB_VERSION && version !== `kimi ${KIMI_WEB_VERSION}` && version !== `Kimi Code ${KIMI_WEB_VERSION}`)
        throw new KimiWebError("unsupported", "Kimi Code CLI 版本不受支持");
      if (!await shouldStart()) return;
      signal.throwIfAborted();
      // The startup banner prints the local bearer token. Discard both streams, never surface their content.
      const child = spawn(cli.command, [...cli.prefixArgs, "web", "--host", "127.0.0.1", "--no-open"], {
        cwd: home, env, detached: true, windowsHide: true, stdio: "ignore",
      });
      let failed = false;
      child.on("error", () => { failed = true; });
      const checkChild = () => {
        if (failed || child.pid === undefined || child.exitCode !== null || child.signalCode !== null)
          throw new KimiWebError("unavailable", "Kimi Code Web 启动失败，请检查电脑端安装和配置");
      };
      let keep = false;
      try {
        const pid = await waitForConnection(checkChild);
        signal.throwIfAborted();
        // Only transfer the lifetime of the process that actually served the authenticated listener.
        // An existing instance can win the race; in that case discard only the child we attempted.
        keep = pid === child.pid;
      } finally {
        if (!keep) {
          const exited = child.pid === undefined || child.exitCode !== null || child.signalCode !== null
            ? Promise.resolve() : new Promise<void>(resolve => child.once("exit", () => resolve()));
          await stopAgentProcess(child, env).catch(() => {});
          if (!await Promise.race([exited.then(() => true), delay(2000, false, { ref: false })])) {
            child.kill("SIGKILL");
            await Promise.race([exited, delay(1000)]);
          }
        }
        // Once attached, the native service can keep serving the user independently of Orbis.
        child.unref();
      }
    },
  };
}
