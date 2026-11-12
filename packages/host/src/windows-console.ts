import { spawn } from "node:child_process";
import { win32 } from "node:path";

/**
 * Visible Windows console windows for agent TUIs (WIN-CONSOLE-01, ADR-0074).
 *
 * Orbis never asks `wt.exe` for these windows. When the default Windows Terminal profile
 * runs as Administrator, a non-elevated Terminal hands the tab to an elevated window and
 * re-serializes the child command as one quoted program name (`-- "cmd.exe /k …"`), which
 * fails with 0x80070002. Even when it launches, the agent runs elevated behind a UAC prompt
 * that nobody at the phone can answer.
 *
 * ShellExecute creates an ordinary console window instead. The Windows default-terminal
 * setting may still host it in Windows Terminal; such handoffs never elevate.
 * ProcessStartInfo keeps the working directory literal, where Start-Process would treat
 * `[` and `]` as wildcards.
 */
export type WindowsConsoleRequest = {
  /** Program located by ShellExecute: a name on PATH or an absolute path. */
  file: string;
  /** Exact command-line tail the program receives; the caller owns its quoting. */
  argumentLine: string;
  /** Working directory of the new window, used literally. */
  cwd: string;
};

/** The launcher ran but Windows did not create the window; callers add which agent it was for. */
export class WindowsConsoleLaunchError extends Error {}

/** PowerShell treats typographic single quotes as quotes too; doubling escapes all of them. */
function quotePowerShell(value: string): string {
  return `'${value.replace(/['\u2018\u2019\u201A\u201B]/gu, "$&$&")}'`;
}

/** The hidden launcher process that opens the window; pure, so tests can decode it. */
export function windowsConsoleLaunch(request: WindowsConsoleRequest, env: NodeJS.ProcessEnv = process.env): { command: string; args: string[] } {
  if (request.file === "" || request.cwd === "" || [request.file, request.argumentLine, request.cwd].some(value => /[\0\r\n]/u.test(value))) {
    throw new Error("Windows 终端窗口的启动参数无效");
  }
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$orbisConsole = New-Object System.Diagnostics.ProcessStartInfo",
    `$orbisConsole.FileName = ${quotePowerShell(request.file)}`,
    `$orbisConsole.Arguments = ${quotePowerShell(request.argumentLine)}`,
    `$orbisConsole.WorkingDirectory = ${quotePowerShell(request.cwd)}`,
    "$orbisConsole.UseShellExecute = $true",
    "$orbisConsole.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Normal",
    "$orbisWindow = [System.Diagnostics.Process]::Start($orbisConsole)",
    "if ($orbisWindow) { [Console]::Out.Write($orbisWindow.Id) }",
  ].join("; ");
  return {
    command: win32.join(env.SystemRoot || env.SYSTEMROOT || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    args: ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
  };
}

/**
 * Opens the window and resolves with its process ID once Windows has created it (the
 * launcher's own ID when the window's is unavailable). The launcher's exit code is the only
 * success signal; a spawn event alone proves nothing.
 */
export function openWindowsConsole(request: WindowsConsoleRequest,
  options: { env?: NodeJS.ProcessEnv; spawnProcess?: typeof spawn } = {}): Promise<number | undefined> {
  const env = options.env ?? process.env;
  const launch = windowsConsoleLaunch(request, env);
  return new Promise((resolve, reject) => {
    const child = (options.spawnProcess ?? spawn)(launch.command, launch.args, {
      env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true, timeout: 15_000,
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => { if (stdout.length < 64) stdout += chunk.toString("utf8"); });
    child.stderr?.on("data", (chunk: Buffer) => { if (stderr.length < 2_000) stderr += chunk.toString("utf8"); });
    child.once("error", reject);
    child.once("close", (code: number | null) => {
      if (code === 0) {
        const pid = Number(stdout.trim());
        resolve(Number.isSafeInteger(pid) && pid > 0 ? pid : child.pid);
        return;
      }
      const detail = stderr.split(/\r?\n/u).map(line => line.trim()).find(line => line !== "");
      reject(new WindowsConsoleLaunchError(`${code === null ? "终端启动器超时" : `终端启动器退出（${code}）`}${detail === undefined ? "" : `：${detail.slice(0, 200)}`}`));
    });
  });
}
