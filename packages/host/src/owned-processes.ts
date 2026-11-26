import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";

const execute = promisify(execFile);
export type ProcessIdentity = { pid: number; parent: number; started: string; executable: string };
const options = { windowsHide: true, timeout: 5_000, maxBuffer: 4 * 1024 * 1024 };

/** HOST-EXIT-01: ownership uses a captured creation time and executable, never a process name. */
export async function processTable(): Promise<ProcessIdentity[]> {
  if (process.platform === "win32") {
    const { stdout } = await execute("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      "@(Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,CreationDate,ExecutablePath | Where-Object { $_.ExecutablePath -and $_.CreationDate } | ForEach-Object { @{ pid=[int]$_.ProcessId; parent=[int]$_.ParentProcessId; started=$_.CreationDate.ToUniversalTime().Ticks.ToString(); executable=$_.ExecutablePath } }) | ConvertTo-Json -Compress"], options);
    const value: unknown = JSON.parse(stdout || "[]");
    const rows = Array.isArray(value) ? value : [value];
    return rows.filter((row): row is ProcessIdentity => row && Number.isSafeInteger(row.pid) && Number.isSafeInteger(row.parent)
      && typeof row.started === "string" && typeof row.executable === "string");
  }
  const { stdout } = await execute("/bin/ps", ["-axo", "pid=,ppid=,uid=,lstart=,stat=,comm="], options);
  return stdout.split("\n").flatMap(line => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.{24})\s+(\S+)\s+(.+)$/u.exec(line);
    if (!match || Number(match[3]) !== process.getuid?.() || match[5]!.startsWith("Z")) return [];
    return [{ pid: Number(match[1]), parent: Number(match[2]), started: match[4]!, executable: match[6]! }];
  });
}

export async function processCommand(pid: number): Promise<string> {
  if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error("无效的后台进程记录");
  if (process.platform === "win32") {
    const { stdout } = await execute("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      `(Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}').CommandLine`], options);
    return stdout.trim();
  }
  try { return (await execute("/bin/ps", ["-p", String(pid), "-o", "args="], options)).stdout.trim(); }
  catch (error) { if ((error as { code?: unknown }).code === 1) return ""; throw error; }
}

export function sameProcess(a: ProcessIdentity, b: ProcessIdentity): boolean {
  return a.pid === b.pid && a.started === b.started && a.executable === b.executable;
}

export function isProcessChild(parent: ProcessIdentity, child: ProcessIdentity): boolean {
  if (child.parent !== parent.pid) return false;
  // Windows retains the original parent PID after exit, so that PID may now name a newer process.
  // CIM CreationDate ticks exceed Number precision; other platforms retain their existing format.
  return !/^\d+$/u.test(parent.started) || !/^\d+$/u.test(child.started)
    || BigInt(parent.started) <= BigInt(child.started);
}

export function processTree(rows: ProcessIdentity[], root: ProcessIdentity, preserved: readonly ProcessIdentity[] = []): ProcessIdentity[] {
  const protectedProcess = (row: ProcessIdentity) => preserved.some(entry => sameProcess(entry, row));
  if (protectedProcess(root) || !rows.some(row => sameProcess(row, root))) return [];
  const result = [root]; const seen = new Set([root.pid]);
  for (let i = 0; i < result.length; i++) for (const row of rows) {
    if (isProcessChild(result[i]!, row) && !seen.has(row.pid) && !protectedProcess(row)) { seen.add(row.pid); result.push(row); }
  }
  return result;
}

export async function listeningPids(port: number): Promise<number[]> {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("无效的后台端口记录");
  if (process.platform === "win32") {
    // Ask only for this port: enumerating every TCP connection can exceed the
    // command timeout on a loaded hosted runner even when the listener exists.
    const command = `$ErrorActionPreference = 'Stop'; Get-NetTCPConnection -State Listen -LocalPort ${port} | Select-Object -ExpandProperty OwningProcess`;
    let stdout: string;
    try {
      ({ stdout } = await execute("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], options));
    } catch {
      // A transient CIM failure during desktop shutdown must not be read as an
      // empty port (which could leave an unverified owner) or kill an unrelated
      // process. Retry once with a longer bound before surfacing the error.
      await delay(100);
      ({ stdout } = await execute("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], { ...options, timeout: 10_000 }));
    }
    return stdout.trim().split(/\s+/u).map(Number).filter(pid => pid > 1);
  }
  try {
    const { stdout } = await execute(process.platform === "darwin" ? "/usr/sbin/lsof" : "lsof",
      ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fp"], options);
    return stdout.split("\n").filter(line => /^p\d+$/u.test(line)).map(line => Number(line.slice(1)));
  } catch (error) { if ((error as { code?: unknown }).code === 1) return []; throw error; }
}

/** Capture descendants before killing a root, then re-check each identity before every signal. */
export async function stopOwnedProcesses(owned: ProcessIdentity[], dependencies = {
  table: processTable, signal: (pid: number, signal: NodeJS.Signals) => { process.kill(pid, signal); },
  wait: () => delay(100),
}, preserve?: (rows: ProcessIdentity[]) => Promise<readonly ProcessIdentity[]>): Promise<void> {
  const tracked = new Map(owned.map(row => [row.pid, row]));
  const snapshot = async () => {
    const rows = await dependencies.table();
    const preserved = await preserve?.(rows) ?? [];
    // HOST-EXIT-07: a late Desktop record can revoke a previously captured ownership claim.
    for (const [pid, owner] of tracked) if (preserved.some(row => sameProcess(owner, row))) tracked.delete(pid);
    return { rows, preserved };
  };
  for (const signal of ["SIGTERM", "SIGKILL"] as const) {
    const { rows, preserved } = await snapshot();
    for (const owner of [...tracked.values()]) for (const row of processTree(rows, owner, preserved)) tracked.set(row.pid, row);
    // Parents first prevents them from replacing children while the tree is being stopped.
    for (const owner of tracked.values()) {
      if (owner.pid <= 1 || owner.pid === process.pid || owner.pid === process.ppid) throw new Error("拒绝关闭当前收尾进程或其父进程");
      const { preserved: currentPreserved } = await snapshot();
      if (currentPreserved.some(row => sameProcess(owner, row))) continue;
      // Reading a protection record can yield. Re-check the signal target afterwards so a PID
      // replaced during that I/O never inherits the earlier process's termination permission.
      const current = (await dependencies.table()).find(row => row.pid === owner.pid);
      if (!current || !sameProcess(owner, current)) continue;
      try { dependencies.signal(owner.pid, signal); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
    }
    for (let attempt = 0; attempt < 15; attempt++) {
      const { rows: remaining } = await snapshot();
      if (![...tracked.values()].some(owner => remaining.some(row => sameProcess(owner, row)))) return;
      await dependencies.wait();
    }
  }
  throw new Error("相关后台尚未退出，请重试；本次未继续安装");
}
