import { spawn } from "node:child_process";
import { access, chmod, mkdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { findClaudeExecutable } from "./claude-integration-install.js";
import { checkClaudeAuthentication, claudeStartupSettings, claudeManagedSettingsPath } from "./claude-startup.js";
import { hasDesktopSession, resolveTerminalCommand } from "./spawner.js";
import { claudeLaunchConfig, trustClaudeWorkspace } from "./claude-workspace-trust.js";
import { waitForMacTerminalScriptStart } from "./macos-agent-terminal.js";
import { AGENT_LAUNCH_ENV_KEYS, agentPowerShellScript } from "./agent-command.js";

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
  /** User-selected workspace; launching authorizes this project's native workspace trust. */
  cwd: string;
  /** Session to resume; absent starts a new Session in `cwd`. */
  resume?: string;
  /** Echoed by the bridge's hello so the Host can match the TUI it opened. */
  launchId: string;
  /** Explicit local setup may show native account/onboarding UI instead of requiring login. */
  setup?: boolean;
  configuration?: import("@orbis/protocol").SessionConfigurationValues;
};

export interface ClaudeLauncher {
  /** A reason the Host cannot open a terminal window here, or undefined when it can. */
  unavailable(): Promise<string | undefined>;
  launch(request: ClaudeLaunchRequest): Promise<void>;
  sessionConfiguration?(cwd: string): Promise<import("@orbis/protocol").SessionConfigurationCatalog>;
}

export type ClaudeLauncherOptions = {
  stateDir: string;
  /** The Claude config directory whose settings tell whether the Orbis plugin is installed. */
  configDir: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  pluginDir?: string;
  /** User home for native executable discovery and default trust config; the current user's by default. */
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

  async sessionConfiguration(cwd: string): Promise<import("@orbis/protocol").SessionConfigurationCatalog> {
    const cli = await this.#claude();
    if (cli === undefined) throw new Error("找不到 Claude Code");
    const { claudeSessionConfiguration } = await import("./session-configuration-probe.js");
    const env = { ...(this.#options.env ?? process.env) };
    const config = claudeLaunchConfig(this.#options.configDir, env, this.#options.home);
    if (config.directory === undefined) delete env.CLAUDE_CONFIG_DIR; else env.CLAUDE_CONFIG_DIR = config.directory;
    return claudeSessionConfiguration(cli, cwd, env);
  }

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
    const startup = await claudeStartupSettings({ cwd: request.cwd, configDir: this.#options.configDir, env, platform,
      managedSettingsPath: claudeManagedSettingsPath(platform, env) });
    const args = [...(request.resume === undefined ? [] : ["--resume", request.resume]), ...startup.args];
    if (request.configuration?.model !== undefined) args.push("--model", request.configuration.model);
    if (request.configuration?.thinking !== undefined) args.push("--effort", request.configuration.thinking);
    if (request.configuration?.permissions?.mode !== undefined) args.push("--permission-mode", request.configuration.permissions.mode === "default" ? "manual" : request.configuration.permissions.mode);
    // Without the installed plugin, load it for this TUI only; never both, or one process
    // would run two bridges for the same Session.
    if (!startup.installed) {
      const pluginDir = this.#options.pluginDir ?? defaultClaudePluginDir();
      try { await access(join(pluginDir, ".claude-plugin", "plugin.json")); }
      catch { throw new Error("找不到 Orbis 的 Claude Code 插件，请在电脑端 Host 设置里开启 Claude Code 连接"); }
      args.push("--plugin-dir", pluginDir);
    }
    const config = claudeLaunchConfig(this.#options.configDir, env, this.#options.home);
    const launchEnv = { ...env };
    if (config.directory === undefined) delete launchEnv.CLAUDE_CONFIG_DIR;
    else launchEnv.CLAUDE_CONFIG_DIR = config.directory;
    if (!request.setup) await checkClaudeAuthentication(claude, request.cwd, launchEnv);
    if (request.configuration?.permissions?.mode !== undefined) {
      const { claudeSessionConfiguration } = await import("./session-configuration-probe.js");
      const checked = await claudeSessionConfiguration(claude, request.cwd, launchEnv, request.configuration);
      if (checked.defaults.permissions?.mode !== request.configuration.permissions.mode)
        throw new Error("Claude 原生启动参数未确认所选权限模式，已停止启动");
    }
    await trustClaudeWorkspace({ cwd: request.cwd, configFile: config.file, env,
      ...(this.#options.home === undefined ? {} : { home: this.#options.home }) });
    const scripts = join(this.#options.stateDir, "tmp");
    await mkdir(scripts, { recursive: true, mode: 0o700 });
    // Pass JSON by private file: cmd.exe would otherwise reinterpret embedded quotes.
    const settingsFile = startup.args.length === 0 ? undefined : join(scripts, `claude-${request.launchId}.settings.json`);
    if (settingsFile !== undefined) {
      await writeFile(settingsFile, startup.args[1]!, { mode: 0o600, flag: "wx" });
      args[args.indexOf("--settings") + 1] = settingsFile;
    }
    const configDir = config.directory;
    const run = this.#options.run ?? spawnDetached;
    if (platform === "darwin") {
      const script = join(scripts, `claude-${request.launchId}.command`);
      const startedFile = `${script}.started`;
      await writeFile(script, posixScript({ cwd: request.cwd, claude, args, launchId: request.launchId, stateDir: this.#options.stateDir, configDir, settingsFile, startedFile, env: launchEnv }), { mode: 0o700, flag: "wx" });
      await chmod(script, 0o700);
      try {
        await run("/usr/bin/open", ["-a", "Terminal", script]);
        await waitForMacTerminalScriptStart(startedFile, "Terminal 未确认执行 Claude Code 启动脚本，请在电脑上检查终端窗口或系统提示后重试");
      }
      catch (error) {
        await unlink(script).catch(() => undefined);
        if (settingsFile) await unlink(settingsFile).catch(() => undefined);
        throw error;
      } finally { await unlink(startedFile).catch(() => undefined); }
      return;
    }
    const script = join(scripts, `claude-${request.launchId}.cmd`);
    await writeFile(script, windowsScript({ cwd: request.cwd, claude, args, launchId: request.launchId, stateDir: this.#options.stateDir, configDir, settingsFile, env: launchEnv }));
    try {
      const terminal = await resolveTerminalCommand(env);
      if (terminal !== undefined) await run(terminal, ["-w", "new", "-d", request.cwd, "cmd.exe", "/k", script]);
      // cmd.exe takes its command line verbatim: one pre-quoted argument.
      else await run(env.ComSpec ?? "cmd.exe", ["/c", `start "Claude Code" /D "${request.cwd}" cmd.exe /k "${script}"`]);
    } catch (error) {
      await unlink(script).catch(() => undefined);
      if (settingsFile) await unlink(settingsFile).catch(() => undefined);
      throw error;
    }
  }

  #claude(): Promise<string | undefined> {
    const env = this.#options.env ?? process.env;
    const platform = this.#options.platform ?? process.platform;
    return this.#options.home === undefined ? findClaudeExecutable(env, platform) : findClaudeExecutable(env, platform, this.#options.home);
  }

}

type ScriptInput = { cwd: string; claude: string; args: readonly string[]; launchId: string; stateDir: string; configDir?: string | undefined; settingsFile?: string | undefined; startedFile?: string | undefined; env?: NodeJS.ProcessEnv };

/** Terminal runs it in the person's login shell; it removes itself before handing over to Claude. */
export function posixScript(input: ScriptInput): string {
  const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
  return [
    "#!/bin/sh",
    `cd -- ${quote(input.cwd)} || exit 1`,
    `export ORBIS_CLAUDE_LAUNCH_ID=${quote(input.launchId)}`,
    `export ORBIS_STATE_DIR=${quote(input.stateDir)}`,
    ...AGENT_LAUNCH_ENV_KEYS.flatMap(key => input.env?.[key] === undefined ? [] : [`export ${key}=${quote(input.env[key])}`]),
    ...(input.configDir === undefined ? ["unset CLAUDE_CONFIG_DIR"] : [`export CLAUDE_CONFIG_DIR=${quote(input.configDir)}`]),
    ...(input.startedFile === undefined ? [] : ["[ -t 0 ] || exit 1", `/usr/bin/touch -- ${quote(input.startedFile)} || exit 1`]),
    "rm -f -- \"$0\"",
    ...(input.settingsFile === undefined ? [`exec ${[input.claude, ...input.args].map(quote).join(" ")}`]
      : [`trap ${quote(`rm -f -- ${quote(input.settingsFile)}`)} EXIT`, [input.claude, ...input.args].map(quote).join(" "), "result=$?", 'exit "$result"']),
    "",
  ].join("\n");
}

export function windowsScript(input: ScriptInput): string {
  // `%` is the only character cmd still expands inside quotes; paths and ids carry no quotes.
  const quote = (value: string): string => `"${value.replaceAll("%", "%%")}"`;
  const invocation = agentPowerShellScript({ command: input.claude, prefixArgs: [] }, input.args, input.env);
  const encoded = Buffer.from(invocation + "; exit $LASTEXITCODE", "utf16le").toString("base64");
  return [
    "@echo off",
    `cd /d ${quote(input.cwd)} || exit /b 1`,
    `set ${quote(`ORBIS_CLAUDE_LAUNCH_ID=${input.launchId}`)}`,
    `set ${quote(`ORBIS_STATE_DIR=${input.stateDir}`)}`,
    `set ${quote(`CLAUDE_CONFIG_DIR=${input.configDir ?? ""}`)}`,
    // A child interpreter returns to this script, so .cmd wrappers cannot skip cleanup.
    /\.(?:cmd|bat|ps1)$/iu.test(input.claude) ? `powershell.exe -NoProfile -NonInteractive -EncodedCommand ${encoded}`
      : [input.claude, ...input.args].map(quote).join(" "),
    ...(input.settingsFile === undefined ? [] : ['set "ORBIS_CLAUDE_EXIT=%ERRORLEVEL%"', `del /q ${quote(input.settingsFile)}`, "exit /b %ORBIS_CLAUDE_EXIT%"]),
    "",
  ].join("\r\n");
}

function spawnDetached(command: string, args: readonly string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    // `open` merely hands the script to Terminal. Its spawn event is not an
    // opener result, and even a successful exit still needs the script receipt.
    if (command === "/usr/bin/open") {
      const child = spawn(command, [...args], { stdio: "ignore", timeout: 15_000 });
      child.once("error", reject);
      child.once("exit", code => code === 0 ? resolve() : reject(new Error("无法打开 macOS 终端，请检查 Terminal 是否可用")));
      return;
    }
    const child = spawn(command, [...args], { detached: true, stdio: "ignore", windowsHide: false,
      windowsVerbatimArguments: process.platform === "win32" && command.toLowerCase().endsWith("cmd.exe") });
    child.once("error", reject);
    child.once("spawn", () => { child.unref(); resolve(); });
  });
}
