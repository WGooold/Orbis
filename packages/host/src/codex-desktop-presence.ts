import { execFile } from "node:child_process";
import { platform } from "node:os";
import { promisify } from "node:util";
import { join } from "node:path";

const execute = promisify(execFile);

export type CodexDesktopProcess = {
  pid: number;
  executable: string;
  mainWindowHandle: number;
  title: string;
};

export type CodexDesktopPresence = {
  ready: boolean;
  executable?: string;
  pid?: number;
  title?: string;
  reason: string;
  /**
   * 探测本身失败（查询安装位置或进程表出错）时的原始原因。
   *
   * 它与「桌面版没打开」必须是两件事：把子进程查询的失败读成「没开窗」，用户会去
   * 重开一个本来就开着的桌面版，而真正坏掉的是这条查询。
   */
  scanError?: string;
};

export type CodexDesktopPresenceOptions = {
  platform?: NodeJS.Platform;
  resolveExecutable?: () => Promise<string | undefined>;
  listProcesses?: () => Promise<readonly CodexDesktopProcess[]>;
};

/**
 * Detect the real Codex desktop window. The app-server daemon and the proxy are
 * deliberately not considered here: they can run while the GUI is completely
 * closed.
 */
export async function detectCodexDesktopPresence(options: CodexDesktopPresenceOptions = {}): Promise<CodexDesktopPresence> {
  if ((options.platform ?? platform()) !== "win32") return { ready: false, reason: "Codex 桌面版只支持 Windows" };
  let executable: string | undefined;
  try {
    executable = await (options.resolveExecutable ?? resolveCodexDesktopExecutable)();
  } catch (error) {
    return { ready: false, reason: "无法查询 Codex 桌面版安装位置", scanError: describeError(error) };
  }
  if (executable === undefined) return { ready: false, reason: "未找到 Codex 桌面版安装包" };
  let processes: readonly CodexDesktopProcess[];
  try {
    processes = await (options.listProcesses ?? listCodexDesktopProcesses)();
  } catch (error) {
    return { ready: false, executable, reason: "无法查询 Codex 桌面版进程", scanError: describeError(error) };
  }
  const normalized = executable.toLowerCase().replaceAll("/", "\\");
  const process = processes.find(candidate => candidate.executable.toLowerCase().replaceAll("/", "\\") === normalized
    && candidate.mainWindowHandle !== 0);
  if (process === undefined) return { ready: false, executable, reason: "Codex 桌面版未打开可见窗口" };
  return { ready: true, executable: process.executable, pid: process.pid, title: process.title, reason: "Codex 桌面版已就绪" };
}

export async function waitForCodexDesktop(options: CodexDesktopPresenceOptions = {}, timeoutMs = 30_000, intervalMs = 250): Promise<CodexDesktopPresence> {
  const deadline = Date.now() + timeoutMs;
  let latest = await detectCodexDesktopPresence(options);
  while (!latest.ready && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, intervalMs));
    latest = await detectCodexDesktopPresence(options);
  }
  if (!latest.ready) throw new Error(`Codex 桌面版启动后未就绪：${latest.reason}${latest.scanError === undefined ? "" : `（${latest.scanError}）`}`);
  return latest;
}

/** 查不到安装位置是「没装」；查询本身报错必须抛出，那是两种不同的结论。 */
async function resolveCodexDesktopExecutable(): Promise<string | undefined> {
  const { stdout, stderr } = await runPowerShell(
    "(Get-AppxPackage -Name OpenAI.Codex | Select-Object -First 1 -ExpandProperty InstallLocation)",
  );
  const root = stdout.trim();
  if (root.length > 0) return join(root, "app", "ChatGPT.exe");
  if (stderr.trim().length > 0) throw new Error(stderr.trim().slice(0, 300));
  return undefined;
}

/**
 * 桌面版的 GUI 可执行文件路径，仅供安装探测和进程匹配。
 * GUI 启动应使用注册的应用标识，避免任务栏固定到带版本号的 EXE 路径。
 */
export async function resolveCodexDesktopExecutablePath(options: CodexDesktopPresenceOptions = {}): Promise<string | undefined> {
  if ((options.platform ?? platform()) !== "win32") return undefined;
  return (options.resolveExecutable ?? resolveCodexDesktopExecutable)();
}

/** 导出给回归测试：这条查询脚本的语句边界必须留在文本里（见 `runPowerShell`）。 */
export async function listCodexDesktopProcesses(): Promise<readonly CodexDesktopProcess[]> {
  const script = [
    "$items = Get-CimInstance Win32_Process -Filter \"Name='ChatGPT.exe'\" -ErrorAction SilentlyContinue | ForEach-Object {",
    "  $p = Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue",
    "  if ($null -ne $p) { [pscustomobject]@{ pid = [int]$_.ProcessId; executable = [string]$_.ExecutablePath; mainWindowHandle = [int64]$p.MainWindowHandle; title = [string]$p.MainWindowTitle } }",
    "}",
    "$items | ConvertTo-Json -Compress",
  ].join("\n");
  const { stdout, stderr } = await runPowerShell(script);
  const text = stdout.trim();
  if (text.length === 0) {
    if (stderr.trim().length > 0) throw new Error(stderr.trim().slice(0, 300));
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`Codex 桌面版进程查询结果不是 JSON：${text.slice(0, 200)}`);
  }
  const items = Array.isArray(parsed) ? parsed : [parsed];
  return items.flatMap(item => {
    if (item === null || typeof item !== "object") return [];
    const value = item as Record<string, unknown>;
    const pid = Number(value.pid);
    const executable = typeof value.executable === "string" ? value.executable : "";
    const mainWindowHandle = Number(value.mainWindowHandle);
    const title = typeof value.title === "string" ? value.title : "";
    return Number.isInteger(pid) && executable.length > 0 && Number.isFinite(mainWindowHandle)
      ? [{ pid, executable, mainWindowHandle, title }]
      : [];
  });
}

/**
 * `-Command` 收到的是一段**脚本文本**，多条语句必须各自占一行（或显式用 `;` 分隔）。
 *
 * 用空格把它们拼成一行会吃掉语句边界：`Get-Process -Id $_.ProcessId ... if (...) { ... }`
 * 会被解析成一整条命令，PowerShell 报「Id 是空值」到 stderr、stdout 为空、退出码却是 0。
 * 那份历史实现把这种结果当成「没有这个进程」，于是桌面版开着一律显示未接入。
 * 所以这里同时读 stderr：非空即视为查询失败，绝不静默降级成空表。
 */
async function runPowerShell(script: string): Promise<{ stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execute("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script],
      { windowsHide: true, timeout: 10_000, maxBuffer: 64_000 });
    return { stdout, stderr };
  } catch (error) {
    const stderr = (error as { stderr?: unknown }).stderr;
    throw new Error(typeof stderr === "string" && stderr.trim().length > 0 ? stderr.trim().slice(0, 300) : describeError(error));
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
