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
  const executable = await (options.resolveExecutable ?? resolveCodexDesktopExecutable)();
  if (executable === undefined) return { ready: false, reason: "未找到 Codex 桌面版安装包" };
  const processes = await (options.listProcesses ?? listCodexDesktopProcesses)();
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
  if (!latest.ready) throw new Error(`Codex 桌面版启动后未就绪：${latest.reason}`);
  return latest;
}

async function resolveCodexDesktopExecutable(): Promise<string | undefined> {
  try {
    const { stdout } = await execute("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      "(Get-AppxPackage -Name OpenAI.Codex | Select-Object -First 1 -ExpandProperty InstallLocation)"],
      { windowsHide: true, timeout: 10_000, maxBuffer: 16_000 });
    const root = stdout.trim();
    return root.length === 0 ? undefined : join(root, "app", "ChatGPT.exe");
  } catch {
    return undefined;
  }
}

async function listCodexDesktopProcesses(): Promise<readonly CodexDesktopProcess[]> {
  const script = [
    "$items = Get-CimInstance Win32_Process -Filter \"Name='ChatGPT.exe'\" -ErrorAction SilentlyContinue | ForEach-Object {",
    "  $p = Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue",
    "  if ($null -ne $p) { [pscustomobject]@{ pid = [int]$_.ProcessId; executable = [string]$_.ExecutablePath; mainWindowHandle = [int64]$p.MainWindowHandle; title = [string]$p.MainWindowTitle } }",
    "}",
    "$items | ConvertTo-Json -Compress",
  ].join(" ");
  try {
    const { stdout } = await execute("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script],
      { windowsHide: true, timeout: 10_000, maxBuffer: 64_000 });
    const parsed: unknown = JSON.parse(stdout.trim() || "[]");
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
  } catch {
    return [];
  }
}
