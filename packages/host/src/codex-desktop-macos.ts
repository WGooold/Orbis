/**
 * Codex 桌面版在 macOS 上的接线：找到应用包、它自带的 CLI、它的主进程，以及让它走 Orbis
 * 包装器的入口。
 *
 * 与 Windows 一样，macOS 桌面版默认用 stdio 起它自己的 app-server：WebSocket/守护进程分支
 * 只有在 `CODEX_APP_SERVER_USE_LOCAL_DAEMON=1` 且**没有** `CODEX_CLI_PATH` 时才走（验证于
 * `com.openai.codex` 26.1023.50603）。所以接入方式与 Windows 相同——`CODEX_CLI_PATH` 指向
 * 包装器——只是三处不同：
 *
 * - 应用包叫 `ChatGPT.app`，但同名的还有普通 ChatGPT（`com.openai.chat`），只能按 bundle id 认；
 * - launcher 是一段 sh 脚本：macOS 上 `spawn` 能直接执行带 `#!` 的文件，不需要原生二进制；
 * - 入口是 launchd 的用户会话环境（`launchctl setenv`），从 Dock/Finder/Spotlight 打开的应用
 *   都从这里继承环境；再用一个 LaunchAgent 在每次登录时重设，重启后也不分先后。
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path/posix";
import { promisify } from "node:util";

const execute = promisify(execFile);

export const CODEX_DESKTOP_BUNDLE_ID = "com.openai.codex";

/** 常见安装位置；都不是时才问 Spotlight（它可能被关掉，也可能还没建好索引）。 */
export function codexDesktopAppCandidates(home = homedir()): string[] {
  return ["/Applications", join(home, "Applications")].flatMap(root => ["ChatGPT.app", "Codex.app"].map(name => join(root, name)));
}

async function bundleValue(app: string, key: string): Promise<string | undefined> {
  try {
    const { stdout } = await execute("/usr/bin/plutil", ["-extract", key, "raw", "-o", "-", join(app, "Contents", "Info.plist")], { timeout: 5_000 });
    const value = stdout.trim();
    return value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

/** 应用包主可执行文件（`<app>/Contents/MacOS/<CFBundleExecutable>`），只认 Codex 的 bundle id。 */
export async function codexDesktopExecutableOf(app: string): Promise<string | undefined> {
  if (!existsSync(join(app, "Contents", "Info.plist"))) return undefined;
  if (await bundleValue(app, "CFBundleIdentifier") !== CODEX_DESKTOP_BUNDLE_ID) return undefined;
  const name = await bundleValue(app, "CFBundleExecutable");
  return name === undefined ? undefined : join(app, "Contents", "MacOS", name);
}

/** 查不到是「没装」；Spotlight 查询出错也只算没找到，常见位置已经确定地查过了。 */
export async function resolveMacCodexDesktopExecutable(candidates = codexDesktopAppCandidates()): Promise<string | undefined> {
  for (const app of candidates) {
    const executable = await codexDesktopExecutableOf(app);
    if (executable !== undefined) return executable;
  }
  let found: string[] = [];
  try {
    const { stdout } = await execute("/usr/bin/mdfind", [`kMDItemCFBundleIdentifier == "${CODEX_DESKTOP_BUNDLE_ID}"`], { timeout: 5_000 });
    found = stdout.split("\n").map(line => line.trim()).filter(line => line.endsWith(".app"));
  } catch { /* Spotlight 不可用 */ }
  for (const app of found) {
    const executable = await codexDesktopExecutableOf(app);
    if (executable !== undefined) return executable;
  }
  return undefined;
}

/** `<app>/Contents/MacOS/<exe>` → `<app>`；不是应用包里的可执行文件就返回 undefined。 */
export function appBundleOf(executable: string): string | undefined {
  const macos = dirname(executable);
  const contents = dirname(macos);
  if (!macos.endsWith("/Contents/MacOS") || !contents.endsWith(".app/Contents")) return undefined;
  return dirname(contents);
}

/** 桌面版自己带的 CLI：没有覆盖时 GUI 用的就是它。 */
export function bundledCodexCli(app: string): string {
  return join(app, "Contents", "Resources", "codex-cli", "bin", "codex");
}

/**
 * 主进程才算「桌面版在运行」：Electron 的 Helper 进程住在 `Contents/Frameworks/…` 里，
 * 路径不同，自然不会被当成主进程。macOS 的 `ps -o comm=` 给的是完整可执行路径。
 */
export async function listMacProcesses(): Promise<Array<{ pid: number; executable: string }>> {
  const { stdout } = await execute("/bin/ps", ["-axww", "-o", "pid=,comm="], { timeout: 10_000, maxBuffer: 4_000_000 });
  return stdout.split("\n").flatMap(line => {
    const match = /^\s*(\d+)\s+(.+)$/u.exec(line);
    return match === null ? [] : [{ pid: Number(match[1]), executable: match[2]!.trim() }];
  });
}

/** 某个进程的可执行路径；包装器用它从父进程（桌面版 GUI）找回应用包。 */
export async function processExecutable(pid: number): Promise<string | undefined> {
  try {
    const { stdout } = await execute("/bin/ps", ["-o", "comm=", "-p", String(pid)], { timeout: 5_000 });
    const value = stdout.trim();
    return value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * macOS 的 launcher：与 `codex-launcher.c` 同一套查找顺序，只多一条回退。
 *
 * node 或脚本不在了（Host 被移走、node 被卸载）时，从父进程——也就是桌面版 GUI——找回它
 * 自带的 CLI 直接执行：桌面版因此永远打得开，最坏情况只是这一轮接不上。
 */
export function renderMacCodexLauncher(node: string, script: string): string {
  return [
    "#!/bin/sh",
    "# 由 Orbis Host 生成：Codex 桌面版经 CODEX_CLI_PATH 执行这里，再交给 Orbis 包装器。",
    // 默认值单独赋值：写进双引号里的 `${…:-'…'}` 会把单引号当成字面字符留下来。
    `node=${shellQuote(node)}`,
    `script=${shellQuote(script)}`,
    "if [ -n \"${ORBIS_CODEX_WRAPPER_NODE:-}\" ]; then node=\"$ORBIS_CODEX_WRAPPER_NODE\"; fi",
    "if [ -n \"${ORBIS_CODEX_WRAPPER_SCRIPT:-}\" ]; then script=\"$ORBIS_CODEX_WRAPPER_SCRIPT\"; fi",
    "if [ -x \"$node\" ] && [ -f \"$script\" ]; then exec \"$node\" \"$script\" \"$@\"; fi",
    "real=\"${ORBIS_CODEX_REAL:-}\"",
    "if [ -z \"$real\" ]; then",
    "  parent=$(/bin/ps -o comm= -p \"$PPID\" 2>/dev/null || true)",
    "  case \"$parent\" in */Contents/MacOS/*) real=\"${parent%/Contents/MacOS/*}/Contents/Resources/codex-cli/bin/codex\" ;; esac",
    "fi",
    "if [ -n \"$real\" ] && [ -x \"$real\" ]; then exec \"$real\" \"$@\"; fi",
    "echo \"[orbis-codex-launcher] 找不到 node、包装器脚本或真实 Codex CLI\" >&2",
    "exit 127",
    "",
  ].join("\n");
}

/** 登录时重设入口的 LaunchAgent：`launchctl setenv` 只活到注销/重启。 */
export const CODEX_DESKTOP_ENTRY_AGENT = "dev.orbis.codex-desktop-entry";

export function codexDesktopEntryAgentPath(home = homedir()): string {
  return join(home, "Library", "LaunchAgents", `${CODEX_DESKTOP_ENTRY_AGENT}.plist`);
}

function xmlEscape(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

export function renderCodexDesktopEntryAgent(name: string, value: string): string {
  return [
    "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
    "<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">",
    "<plist version=\"1.0\">",
    "<dict>",
    "  <key>Label</key>",
    `  <string>${CODEX_DESKTOP_ENTRY_AGENT}</string>`,
    "  <key>ProgramArguments</key>",
    "  <array>",
    "    <string>/bin/launchctl</string>",
    "    <string>setenv</string>",
    `    <string>${xmlEscape(name)}</string>`,
    `    <string>${xmlEscape(value)}</string>`,
    "  </array>",
    "  <key>RunAtLoad</key>",
    "  <true/>",
    "</dict>",
    "</plist>",
    "",
  ].join("\n");
}

export async function readLaunchdEnvironment(name: string): Promise<string | undefined> {
  const { stdout } = await execute("/bin/launchctl", ["getenv", name], { timeout: 5_000 }).catch(() => ({ stdout: "" }));
  const value = stdout.trim();
  return value.length > 0 ? value : undefined;
}

/**
 * 写入（或清除）用户会话的环境，并让登录项保持一致。只有 `launchctl` 本身失败才抛出：
 * LaunchAgent 写不进去只影响下次登录，本次会话已经生效。
 */
export async function writeLaunchdEnvironment(name: string, value: string | undefined, home = homedir()): Promise<void> {
  const agent = codexDesktopEntryAgentPath(home);
  if (value === undefined) {
    await execute("/bin/launchctl", ["unsetenv", name], { timeout: 5_000 });
    await rm(agent, { force: true }).catch(() => {});
    return;
  }
  await execute("/bin/launchctl", ["setenv", name, value], { timeout: 5_000 });
  const content = renderCodexDesktopEntryAgent(name, value);
  const current = await readFile(agent, "utf8").catch(() => undefined);
  if (current === content) return;
  try {
    await mkdir(dirname(agent), { recursive: true });
    await writeFile(agent, content, { mode: 0o644 });
  } catch { /* 下次登录前 Host 启动时还会再写一次 */ }
}
