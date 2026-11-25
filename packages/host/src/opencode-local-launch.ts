import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { agentTerminalEnvironment, type AgentCommand } from "./agent-command.js";
import { checkServiceCliVersion, launchLocalService, serviceCli } from "./local-agent-start.js";
import { OPENCODE_CLIENT_VERSION, openCodeTerminalService, type OpenCodeLocalLauncher, type OpenCodeServiceIdentity } from "./opencode-service-connection.js";

export const OPENCODE_TUI_ENV_KEYS = ["HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME",
  "OPENCODE_CONFIG_DIR", "SystemRoot", "WINDIR", "COMSPEC", "PATHEXT", "TMP", "TEMP", "TMPDIR", "LANG", "LC_ALL", "LC_CTYPE"] as const;
export type OpenCodeTerminalTarget = { sessionId: string; directory: string; workspace: string; service: OpenCodeServiceIdentity };
type OpenCodeTerminalHandoff = { target: OpenCodeTerminalTarget; cliCommand: AgentCommand };

function decodeHandoff(value: string | undefined): OpenCodeTerminalHandoff {
  try {
    if (!value || value.length > 16_384) throw new Error();
    const { target, cliCommand } = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as OpenCodeTerminalHandoff;
    if (![target.directory, target.workspace].every(path => isAbsolute(path) && !/[\0\r\n]/u.test(path)) ||
        typeof target.sessionId !== "string" || !target.sessionId || target.sessionId.length > 128 || /^-|[\0\r\n]/u.test(target.sessionId) ||
        typeof target.service.origin !== "string" || !Number.isSafeInteger(target.service.pid) || target.service.pid <= 0 ||
        (target.service.registrationId !== undefined && typeof target.service.registrationId !== "string") ||
        !isAbsolute(cliCommand.command) || !Array.isArray(cliCommand.prefixArgs) || !cliCommand.prefixArgs.every(arg => typeof arg === "string")) throw new Error();
    return { target, cliCommand };
  } catch { throw new Error("OpenCode 终端交接参数无效，请从 Host 重试"); }
}

/** Only the non-secret handoff target and CLI invocation go into the terminal launch arguments. */
export async function prepareOpenCodeTerminalLaunch(target: OpenCodeTerminalTarget, signal: AbortSignal, env: NodeJS.ProcessEnv = process.env) {
  const cli = serviceCli("opencode", env);
  const entry = await cli.find(OPENCODE_CLIENT_VERSION);
  signal.throwIfAborted();
  if (!entry) throw new Error(`未找到兼容的 OpenCode ${OPENCODE_CLIENT_VERSION} CLI`);
  const cliCommand = await cli.resolve(entry);
  const environment = agentTerminalEnvironment(cli.env, OPENCODE_TUI_ENV_KEYS);
  if (process.platform === "win32") {
    for (const key of OPENCODE_TUI_ENV_KEYS) {
      const value = Object.entries(cli.env).find(([name]) => name.toUpperCase() === key.toUpperCase())?.[1];
      if (value !== undefined) environment[key] ??= value;
    }
  }
  environment[process.platform === "win32" ? "USERPROFILE" : "HOME"] ??= cli.cwd;
  await checkServiceCliVersion(cliCommand, cli.cwd, environment, signal, "OpenCode", OPENCODE_CLIENT_VERSION);
  const handoff = Buffer.from(JSON.stringify({ target, cliCommand })).toString("base64url");
  decodeHandoff(handoff);
  return { args: [fileURLToPath(new URL("./opencode-terminal-entry.js", import.meta.url)), handoff], environment };
}

/** Runs inside the visible console. Recheck the original ID, never substitute another session. */
export async function runOpenCodeTerminalHandoff(handoff: string | undefined): Promise<number> {
  const { target, cliCommand } = decodeHandoff(handoff);
  const { directory, workspace, sessionId, service } = target;
  const resolved = await realpath(directory).catch(() => undefined);
  if (resolved !== workspace || !(await stat(workspace).catch(() => undefined))?.isDirectory())
    throw new Error("OpenCode 工作区已变化或不可用，请从 Host 重试");
  const { client, password } = await openCodeTerminalService(service);
  try {
    const session = await client.session.get({ sessionID: sessionId }, { signal: AbortSignal.timeout(5_000) });
    if (session.id !== sessionId || session.location.directory !== directory || session.parentID != null || session.time.archived != null) throw new Error();
  } catch { throw new Error("无法恢复原 OpenCode 会话：会话已删除、归档、移动或暂不可读取，请从 Host 重试"); }

  // Explicit --server cannot auto-start or replace the service. The native --session option
  // has no atomic attach-only mode; the read above is the last check before spawning.
  const args = [...cliCommand.prefixArgs, workspace, "--session", sessionId, "--server", service.origin];
  const cliEnv = agentTerminalEnvironment(process.env, [...OPENCODE_TUI_ENV_KEYS, "TERM", "COLORTERM", "TERM_PROGRAM", "TERM_PROGRAM_VERSION"]);
  cliEnv.TERM ??= "xterm-256color";
  // A desktop handoff must not auto-update the user's pinned CLI or trigger service replacement.
  cliEnv.OPENCODE_DISABLE_AUTOUPDATE = "1";
  if (password !== undefined) cliEnv.OPENCODE_PASSWORD = password;
  return new Promise((resolve, reject) => {
    const child = spawn(cliCommand.command, args, { cwd: workspace, env: cliEnv, stdio: "inherit" });
    // The foreground console delivers Ctrl-C to the CLI as well; let the CLI decide whether to exit.
    const interrupt = () => {};
    process.on("SIGINT", interrupt);
    child.once("error", () => {
      process.off("SIGINT", interrupt);
      reject(new Error("无法运行 OpenCode CLI，请检查电脑端安装"));
    });
    child.once("exit", (code, signal) => {
      process.off("SIGINT", interrupt);
      resolve(code ?? (signal === "SIGINT" ? 130 : 1));
    });
  });
}

// OpenCode 2.3.2's stable service uses this file and a fixed per-user service port. Keep that
// native collision check; never substitute a random port, the standalone mode, or SDK ensure/stop.
async function checkServiceConfig(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0)).catch(error => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error("无法读取 OpenCode 共享服务配置");
  });
  if (!handle) return;
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 128 * 1024) throw new Error();
    const value: unknown = JSON.parse(await handle.readFile("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    const config = value as Record<string, unknown>;
    if (config.disabled === true || config.remote !== undefined && config.remote !== false ||
        config.hostname !== undefined && config.hostname !== "127.0.0.1") throw new Error();
  } catch { throw new Error("OpenCode 的共享服务已禁用、使用远程配置或配置无效；Orbis 只接入已有服务"); }
  finally { await handle.close(); }
}

export function createOpenCodeLocalLauncher(env: NodeJS.ProcessEnv = process.env): OpenCodeLocalLauncher {
  const cli = serviceCli("opencode", env);
  delete cli.env.OPENCODE_PTY_HANDOFF;
  const configPath = join(env.OPENCODE_CONFIG_DIR || join(env.XDG_CONFIG_HOME || join(cli.cwd, ".config"), "opencode"), "service.json");
  const find = () => cli.find(OPENCODE_CLIENT_VERSION);
  return {
    available: async () => await checkServiceConfig(configPath).then(find, () => undefined) !== undefined,
    start: async (guard, shouldStart, confirm) => {
      await checkServiceConfig(configPath);
      const entry = await find();
      if (!entry) throw new Error(`未找到兼容的 OpenCode ${OPENCODE_CLIENT_VERSION} CLI`);
      const command = await cli.resolve(entry);
      await checkServiceCliVersion(command, cli.cwd, cli.env, guard.signal, "OpenCode", OPENCODE_CLIENT_VERSION);
      await checkServiceConfig(configPath);
      if (!await shouldStart()) return;
      guard.check();
      await launchLocalService(command, ["serve", "--service", "--hostname", "127.0.0.1"], cli, confirm);
    },
  };
}
