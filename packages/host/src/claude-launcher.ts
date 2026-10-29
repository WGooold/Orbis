import { spawn } from "node:child_process";
import { access, chmod, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { CLAUDE_MARKETPLACE, CLAUDE_PLUGIN, findClaudeExecutable } from "./claude-integration-install.js";
import { hasDesktopSession, resolveTerminalCommand } from "./spawner.js";

/**
 * Opens Claude Code's official TUI in a terminal window on this computer (ADR-0033 §1:
 * the phone attaches to the same native instance the person can see). There is no
 * headless fallback: a Session the Host ran without a TUI would be an Agent SDK backend.
 *
 * macOS uses Terminal.app, which every Mac has; Windows uses Windows Terminal when it is
 * installed and the console host otherwise. Other systems report unavailable instead of
 * guessing an emulator.
 */
export type ClaudeLaunchRequest = {
  cwd: string;
  /** Session to resume; absent starts a new Session in `cwd`. */
  resume?: string;
  /** Echoed by the bridge's hello so the Host can match the TUI it opened. */
  launchId: string;
};

export interface ClaudeLauncher {
  /** A reason the Host cannot open a terminal window here, or undefined when it can. */
  unavailable(): Promise<string | undefined>;
  launch(request: ClaudeLaunchRequest): Promise<void>;
}

export type ClaudeLauncherOptions = {
  stateDir: string;
  /** The Claude config directory whose settings tell whether the Orbis plugin is installed. */
  configDir: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  pluginDir?: string;
  /** Home directory searched for the native installer's `claude`; the user's own by default. */
  home?: string;
  /** Test seam: runs the terminal opener. */
  run?: (command: string, args: readonly string[]) => Promise<void>;
};

export function defaultClaudePluginDir(): string {
  return fileURLToPath(new URL("../../claude-mod/", import.meta.url));
}

export class TerminalClaudeLauncher implements ClaudeLauncher {
  readonly #options: ClaudeLauncherOptions;

  constructor(options: ClaudeLauncherOptions) { this.#options = options; }

  async unavailable(): Promise<string | undefined> {
    const platform = this.#options.platform ?? process.platform;
    const env = this.#options.env ?? process.env;
    if (platform !== "darwin" && platform !== "win32") return "这台电脑的系统没有 Orbis 能打开的终端窗口，请在电脑上运行 claude";
    if (platform === "win32" && !hasDesktopSession(env)) return "Host 没有运行在桌面会话里，无法在电脑上打开终端窗口";
    if (await this.#claude() === undefined) return "没有找到 Claude Code（claude 命令），请先在电脑上安装";
    return undefined;
  }

  async launch(request: ClaudeLaunchRequest): Promise<void> {
    const reason = await this.unavailable();
    if (reason !== undefined) throw new Error(reason);
    const platform = this.#options.platform ?? process.platform;
    const env = this.#options.env ?? process.env;
    const claude = (await this.#claude())!;
    const args = [...(request.resume === undefined ? [] : ["--resume", request.resume])];
    // Without the installed plugin, load it for this TUI only; never both, or one process
    // would run two bridges for the same Session.
    if (!await this.#pluginInstalled()) {
      const pluginDir = this.#options.pluginDir ?? defaultClaudePluginDir();
      try { await access(join(pluginDir, ".claude-plugin", "plugin.json")); }
      catch { throw new Error("找不到 Orbis 的 Claude Code 插件，请在电脑端 Host 设置里开启 Claude Code 连接"); }
      args.push("--plugin-dir", pluginDir);
    }
    const scripts = join(this.#options.stateDir, "tmp");
    await mkdir(scripts, { recursive: true, mode: 0o700 });
    const run = this.#options.run ?? spawnDetached;
    if (platform === "darwin") {
      const script = join(scripts, `claude-${request.launchId}.command`);
      await writeFile(script, posixScript({ cwd: request.cwd, claude, args, launchId: request.launchId, stateDir: this.#options.stateDir }), { mode: 0o700 });
      await chmod(script, 0o700);
      try { await run("/usr/bin/open", ["-a", "Terminal", script]); }
      catch (error) { await unlink(script).catch(() => undefined); throw error; }
      return;
    }
    const script = join(scripts, `claude-${request.launchId}.cmd`);
    await writeFile(script, windowsScript({ cwd: request.cwd, claude, args, launchId: request.launchId, stateDir: this.#options.stateDir }));
    const terminal = await resolveTerminalCommand(env);
    if (terminal !== undefined) await run(terminal, ["-w", "new", "-d", request.cwd, "cmd.exe", "/k", script]);
    // cmd.exe takes its command line verbatim: one pre-quoted argument.
    else await run(env.ComSpec ?? "cmd.exe", ["/c", `start "Claude Code" /D "${request.cwd}" cmd.exe /k "${script}"`]);
  }

  #claude(): Promise<string | undefined> {
    const env = this.#options.env ?? process.env;
    const platform = this.#options.platform ?? process.platform;
    return this.#options.home === undefined ? findClaudeExecutable(env, platform) : findClaudeExecutable(env, platform, this.#options.home);
  }

  async #pluginInstalled(): Promise<boolean> {
    try {
      const settings: unknown = JSON.parse(await readFile(join(this.#options.configDir, "settings.json"), "utf8"));
      const enabled = typeof settings === "object" && settings !== null ? (settings as Record<string, unknown>).enabledPlugins : undefined;
      return typeof enabled === "object" && enabled !== null && (enabled as Record<string, unknown>)[`${CLAUDE_PLUGIN}@${CLAUDE_MARKETPLACE}`] === true;
    } catch { return false; }
  }
}

type ScriptInput = { cwd: string; claude: string; args: readonly string[]; launchId: string; stateDir: string };

/** Terminal runs it in the person's login shell; it removes itself before handing over to Claude. */
export function posixScript(input: ScriptInput): string {
  const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
  return [
    "#!/bin/sh",
    `cd -- ${quote(input.cwd)} || exit 1`,
    `export ORBIS_CLAUDE_LAUNCH_ID=${quote(input.launchId)}`,
    `export ORBIS_STATE_DIR=${quote(input.stateDir)}`,
    "rm -f -- \"$0\"",
    `exec ${[input.claude, ...input.args].map(quote).join(" ")}`,
    "",
  ].join("\n");
}

export function windowsScript(input: ScriptInput): string {
  // `%` is the only character cmd still expands inside quotes; paths and ids carry no quotes.
  const quote = (value: string): string => `"${value.replaceAll("%", "%%")}"`;
  return [
    "@echo off",
    `cd /d ${quote(input.cwd)}`,
    `set ${quote(`ORBIS_CLAUDE_LAUNCH_ID=${input.launchId}`)}`,
    `set ${quote(`ORBIS_STATE_DIR=${input.stateDir}`)}`,
    `${[input.claude, ...input.args].map(quote).join(" ")}`,
    "",
  ].join("\r\n");
}

function spawnDetached(command: string, args: readonly string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], { detached: true, stdio: "ignore", windowsHide: false,
      windowsVerbatimArguments: process.platform === "win32" && command.toLowerCase().endsWith("cmd.exe") });
    child.once("error", reject);
    child.once("spawn", () => { child.unref(); resolve(); });
  });
}
