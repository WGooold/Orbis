/**
 * 从访达、程序坞或登录项打开的 macOS 应用只拿到 launchd 的最小环境（`/usr/bin:/bin:/usr/sbin:/sbin`），
 * 用户在 `~/.zprofile`、`~/.zshrc`、`~/.bash_profile`、fish 配置里加的 PATH 和变量一概没有。
 * Host 因此看不见 nvm、fnm、Volta、Homebrew 或 npm 全局装的 Agent，也读不到 `PI_CODING_AGENT_DIR`。
 *
 * 这里用用户自己的登录 shell 跑一次 `env`（与 VS Code 解析 shell 环境的方式相同），只取需要的
 * 几个变量合并进来。任何一步失败都只是保持原样：超时、shell 卡在交互提示、输出不可解析都不能挡住
 * Host 启动。
 */
import { spawn } from "node:child_process";
import { delimiter } from "node:path";
import { userInfo } from "node:os";

const MARKER = "__ORBIS_LOGIN_ENV__";

/** 只合并这些：其余变量（代理、语言等）Host 自己的行为不依赖，也不该被用户 shell 随意改写。 */
const ADOPTED = ["PI_CODING_AGENT_DIR", "CLAUDE_CONFIG_DIR", "NVM_DIR", "VOLTA_HOME", "FNM_DIR", "PNPM_HOME", "BUN_INSTALL", "npm_config_prefix", "NPM_CONFIG_PREFIX"] as const;

export type LoginShellOptions = {
  shell?: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
};

export function loginShell(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.SHELL?.trim();
  if (configured && configured.startsWith("/")) return configured;
  try {
    const shell = userInfo().shell;
    if (shell && shell.startsWith("/")) return shell;
  } catch { /* 拿不到用户记录就用系统默认 */ }
  return "/bin/zsh";
}

/** `env -0` 的输出夹在两个标记之间：shell 启动脚本自己打印的内容（欢迎语、提示）都被丢掉。 */
export function parseLoginEnvironment(output: string): Record<string, string> | undefined {
  const start = output.indexOf(MARKER);
  const end = output.lastIndexOf(MARKER);
  if (start < 0 || end <= start) return undefined;
  const result: Record<string, string> = {};
  for (const item of output.slice(start + MARKER.length, end).split("\0")) {
    const index = item.indexOf("=");
    if (index > 0) result[item.slice(0, index)] = item.slice(index + 1);
  }
  return result.PATH === undefined ? undefined : result;
}

export async function readLoginShellEnvironment(options: LoginShellOptions = {}): Promise<Record<string, string> | undefined> {
  const shell = options.shell ?? loginShell(options.env);
  // `-l` 读登录配置，`-i` 读交互配置（nvm 之类通常写在 .zshrc / .bashrc 里）。fish 也接受这两个参数。
  const script = `/usr/bin/printf '%s' ${MARKER}; /usr/bin/env -0; /usr/bin/printf '%s' ${MARKER}`;
  return new Promise(resolve => {
    let output = "";
    let settled = false;
    const finish = (value: Record<string, string> | undefined) => { if (!settled) { settled = true; resolve(value); } };
    let child;
    try {
      child = spawn(shell, ["-l", "-i", "-c", script], {
        stdio: ["ignore", "pipe", "ignore"],
        // 让用户的启动脚本可以识别这次调用，跳过交互式的初始化（与 VSCODE_RESOLVING_ENVIRONMENT 同理）。
        env: { ...(options.env ?? process.env), ORBIS_RESOLVING_ENVIRONMENT: "1" },
        detached: true,
      });
    } catch {
      finish(undefined);
      return;
    }
    const timer = setTimeout(() => {
      try { if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL"); } catch { /* 已经退出 */ }
      finish(undefined);
    }, options.timeoutMs ?? 10_000);
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => { output += chunk; if (output.length > 4_000_000) child.kill("SIGKILL"); });
    child.once("error", () => { clearTimeout(timer); finish(undefined); });
    child.once("close", () => { clearTimeout(timer); finish(parseLoginEnvironment(output)); });
  });
}

/**
 * 登录 shell 的 PATH 排在前面（用户自己的优先级），原有但登录 shell 里没有的条目追加在后面；
 * 其余只补 Host 进程里还没有的变量，显式传给 Host 的值不会被覆盖。
 */
export function mergeLoginEnvironment(target: NodeJS.ProcessEnv, login: Record<string, string>): void {
  const entries = [...(login.PATH ?? "").split(delimiter), ...(target.PATH ?? "").split(delimiter)].filter(Boolean);
  target.PATH = [...new Set(entries)].join(delimiter);
  for (const key of ADOPTED) {
    const value = login[key];
    if (value !== undefined && value.length > 0 && target[key] === undefined) target[key] = value;
  }
}

/** macOS 上把登录 shell 的环境并入当前进程；其他平台的 GUI 进程本来就继承完整的用户环境。 */
export async function adoptLoginShellEnvironment(log?: (line: string) => void, platform: NodeJS.Platform = process.platform): Promise<boolean> {
  if (platform !== "darwin") return false;
  const login = await readLoginShellEnvironment();
  if (login === undefined) {
    log?.("未能读取登录 shell 的环境，Agent 检测只使用系统默认 PATH");
    return false;
  }
  mergeLoginEnvironment(process.env, login);
  return true;
}
