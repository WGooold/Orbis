import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";

const exec = promisify(execFile);
export type ClaudeProcessIdentity = { pid: number; started: string; executable: string; command: string };
export interface ClaudeProcessControl {
  capture(pid: number): Promise<ClaudeProcessIdentity | undefined>;
  terminate(identity: ClaudeProcessIdentity, isCurrent: () => boolean): Promise<void>;
}

/** The PID comes from the authenticated local Mod, never from a phone command. */
export class LocalClaudeProcessControl implements ClaudeProcessControl {
  constructor(private readonly read = readProcess,
    private readonly signal: (pid: number, signal: NodeJS.Signals) => void = (pid, signal) => { process.kill(pid, signal); }) {}

  async capture(pid: number): Promise<ClaudeProcessIdentity | undefined> {
    if (!Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid || pid === process.ppid) return undefined;
    const identity = await this.read(pid);
    if (identity === undefined) return undefined;
    const executable = identity.executable.replaceAll("\\", "/");
    const native = /(?:^|\/)claude(?:\.exe)?$/iu.test(executable) || /\/claude\/versions\/[\w.-]+$/u.test(executable);
    const npm = /(?:^|\/)node(?:\.exe)?$/iu.test(executable) && /[\\/]@anthropic-ai[\\/]claude-code[\\/]cli\.js(?:["\s]|$)/u.test(identity.command);
    return native || npm ? identity : undefined;
  }

  async terminate(identity: ClaudeProcessIdentity, isCurrent: () => boolean): Promise<void> {
    const same = (current: ClaudeProcessIdentity): boolean => current.started === identity.started &&
      current.executable === identity.executable;
    for (const signal of ["SIGTERM", "SIGKILL"] as const) {
      const current = await this.read(identity.pid);
      if (current === undefined) return;
      if (!isCurrent() || !same(current)) throw new Error("Claude Code 进程身份已变化，请刷新后重试。");
      try { this.signal(identity.pid, signal); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return; throw error; }
      for (let attempt = 0; attempt < 10; attempt++) {
        await delay(100);
        const remaining = await this.read(identity.pid);
        if (remaining === undefined || !same(remaining)) return;
      }
    }
    throw new Error("Claude Code 进程尚未退出，请稍后重试。");
  }
}

async function readProcess(pid: number): Promise<ClaudeProcessIdentity | undefined> {
  const options = { timeout: 5_000, maxBuffer: 32_768, windowsHide: true };
  if (process.platform === "win32") {
    const script = `$p = Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}'; if ($null -ne $p) { @{ started = $p.CreationDate.ToUniversalTime().Ticks.ToString(); executable = $p.ExecutablePath; command = $p.CommandLine } | ConvertTo-Json -Compress }`;
    const { stdout } = await exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], options);
    if (!stdout.trim()) return undefined;
    const value = JSON.parse(stdout) as Record<string, unknown>;
    if (typeof value.started !== "string" || typeof value.executable !== "string" || typeof value.command !== "string") throw new Error("无法核对 Claude Code 进程。");
    return { pid, started: value.started, executable: value.executable, command: value.command };
  }
  try {
    const [metadata, argv] = await Promise.all([
      exec("/bin/ps", ["-p", String(pid), "-o", "lstart=", "-o", "comm="], options),
      exec("/bin/ps", ["-p", String(pid), "-o", "stat=", "-o", "args="], options),
    ]);
    const line = metadata.stdout.trim();
    if (!line || argv.stdout.trim().startsWith("Z")) return undefined;
    return { pid, started: line.slice(0, 24), executable: line.slice(24).trim(), command: argv.stdout.trim().replace(/^\S+\s+/u, "") };
  } catch (error) {
    if ((error as { code?: unknown }).code === 1) return undefined;
    throw error;
  }
}
