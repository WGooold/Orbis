import { execFile } from "node:child_process";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
function orbisBin(): string { return join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "Orbis", "bin"); }
function shimPath(): string { return join(orbisBin(), "codex.cmd"); }
function manifestPath(): string { return join(orbisBin(), "codex-shim.json"); }

/** 机器 PATH 里的 Orbis 终端入口；用 `%LOCALAPPDATA%` 让同一项对每个用户各自展开。 */
const MACHINE_PATH_ENTRY = "%LOCALAPPDATA%\\Orbis\\bin";
const MACHINE_ENVIRONMENT_KEY = "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment";

export function renderCodexShim(runtimeRoot: string): string {
  const escapedRuntime = resolve(runtimeRoot).replace(/"/gu, "");
  return [
    "@echo off",
    "setlocal",
    `set "ORBIS_CODEX_RUNTIME=${escapedRuntime}"`,
    `"%ORBIS_CODEX_RUNTIME%\\node\\node.exe" "%ORBIS_CODEX_RUNTIME%\\packages\\host\\dist\\codex-shim.js" %*`,
    "exit /b %errorlevel%",
    "",
  ].join("\r\n");
}

export async function installCodexShim(runtimeRoot: string): Promise<void> {
  const prior = await readFile(shimPath(), "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (prior && !prior.includes("ORBIS_CODEX_RUNTIME=")) throw new Error("Orbis bin 中已有非 Orbis 的 codex.cmd，未覆盖");
  await access(join(runtimeRoot, "node", "node.exe"));
  await access(join(runtimeRoot, "packages", "host", "dist", "codex-shim.js"));
  const current = await readUserPath();
  await mkdir(orbisBin(), { recursive: true });
  await writeFile(shimPath(), renderCodexShim(runtimeRoot), "utf8");
  await writeFile(manifestPath(), `${JSON.stringify({ version: 1, bin: orbisBin(), runtimeRoot: resolve(runtimeRoot) }, null, 2)}\n`, "utf8");
  await updateUserPath(current, path => [orbisBin(), ...path.filter(entry => !samePath(entry, orbisBin()))]);
}

export async function uninstallCodexShim(): Promise<void> {
  const current = await readUserPath();
  await updateUserPath(current, path => path.filter(entry => !samePath(entry, orbisBin())));
  // 提权失败不该让卸载失败：临时 PATH 项没了，杀余的机器 PATH 项只是指向不存在的目录。
  await dropOrbisFromMachinePath().catch(() => {});
  const owned = await readFile(shimPath(), "utf8").catch(() => "");
  if (owned.includes("ORBIS_CODEX_RUNTIME=")) await rm(shimPath(), { force: true });
  await rm(manifestPath(), { force: true });
}

export type CodexTerminalIntegration = {
  state: "enabled" | "pending" | "repair" | "disabled";
  detail: string;
  /** 机器 PATH 抢在用户 PATH 前面：只有一次提权能修，所以交给设置页的用户确认。 */
  needsElevation?: boolean;
};
export async function codexShimStatus(expectedRuntimeRoot?: string): Promise<CodexTerminalIntegration> {
  if (process.platform !== "win32") return { state: "disabled", detail: "仅支持 Windows 终端" };
  let manifest: { runtimeRoot?: unknown };
  let script: string;
  try {
    script = await readFile(shimPath(), "utf8");
    manifest = JSON.parse(await readFile(manifestPath(), "utf8")) as { runtimeRoot?: unknown };
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return { state: "disabled", detail: "尚未启用终端接入" };
    return { state: "repair", detail: "终端接入文件不可读，请修复" };
  }
  if (typeof manifest.runtimeRoot !== "string" || script !== renderCodexShim(manifest.runtimeRoot)
    || expectedRuntimeRoot && !samePath(manifest.runtimeRoot, expectedRuntimeRoot)
    || !await exists(join(manifest.runtimeRoot, "node", "node.exe"))
    || !await exists(join(manifest.runtimeRoot, "packages", "host", "dist", "codex-shim.js"))) {
    return { state: "repair", detail: "终端入口与当前安装不一致，请修复" };
  }
  try {
    const userPath = await readUserPath();
    if (!samePath(userPath[0] ?? "", orbisBin())) return { state: "repair", detail: "用户 PATH 未优先指向 Orbis，请修复" };
    const first = await firstCodexOnPath(process.env.Path ?? process.env.PATH ?? "");
    if (first && samePath(first, shimPath())) return { state: "enabled", detail: "当前终端已解析到 Orbis" };
    if ((process.env.Path ?? process.env.PATH ?? "").split(";").some(entry => samePath(entry, orbisBin()))) {
      // 用户 PATH 已经排好了，所以抢先的只能是系统 PATH（机器 PATH 永远排在用户 PATH 前）。
      // 已经修过就只是当前进程还没重读环境变量。
      const freshFirst = await firstCodexOnPath([...await readRegistryPath(MACHINE_ENVIRONMENT_KEY), ...userPath].join(";"));
      if (freshFirst !== undefined && samePath(freshFirst, shimPath())) return { state: "pending", detail: "已调整系统 PATH 顺序；重新打开终端后生效" };
      return { state: "repair", detail: `系统 PATH 里的 ${first ?? "其他入口"} 抢先于 Orbis`, needsElevation: true };
    }
    return { state: "pending", detail: "已写入用户 PATH；请重新打开终端后检查 codex 命中位置" };
  } catch {
    return { state: "repair", detail: "无法读取用户 PATH，请检查权限" };
  }
}

async function firstCodexOnPath(path: string): Promise<string | undefined> {
  for (const dir of splitPath(path)) {
    const expanded = expandVariables(dir);
    for (const ext of [".COM", ".EXE", ".BAT", ".CMD"]) {
      const candidate = join(expanded.replace(/^"|"$/gu, ""), `codex${ext.toLowerCase()}`);
      if (await exists(candidate)) return candidate;
    }
  }
  return undefined;
}
async function exists(path: string): Promise<boolean> { try { await access(path); return true; } catch { return false; } }
function expandVariables(value: string): string {
  return value.replace(/%([^%]+)%/gu, (_, name: string) =>
    Object.entries(process.env).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1] ?? `%${name}%`);
}

/** 通知已运行的资源管理器／终端重新读取环境变量。失败无害：新进程总会读到新值。 */
const ENVIRONMENT_BROADCAST = 'Add-Type -Namespace Orbis -Name EnvNotify -MemberDefinition \'[DllImport("user32.dll", CharSet = CharSet.Auto)] public static extern System.IntPtr SendMessageTimeout(System.IntPtr hwnd, int msg, System.IntPtr wp, string lp, int flags, int timeout, out System.IntPtr result);\'; $result = [IntPtr]::Zero; [void][Orbis.EnvNotify]::SendMessageTimeout([IntPtr]0xffff, 0x1a, [IntPtr]::Zero, "Environment", 2, 5000, [ref]$result)';

/**
 * Windows 的有效 PATH 是「机器 PATH + 用户 PATH」，所以机器 PATH 里任何 codex
 * （例如 nvm 写进 HKLM 的 `C:\nvm4w\nodejs`）都排在用户 PATH 的 Orbis shim 之前，
 * 用户 PATH 排第一也没用。机器 PATH 在 HKLM 下，只能提权改写一次；把 Orbis bin
 * 放到机器 PATH 最前，shim 才是任何终端里 `codex` 的第一个命中。
 *
 * 已经命中 shim、或机器 PATH 里已经有这一项时什么都不做，所以重复点修复是安全的。
 * 返回值表示这次是否真的改了机器 PATH（改完要重开终端才看得到）。
 */
export async function ensureCodexShimWinsPath(): Promise<boolean> {
  if (process.platform !== "win32") return false;
  const first = await firstCodexOnPath(process.env.Path ?? process.env.PATH ?? "");
  if (first !== undefined && samePath(first, shimPath())) return false;
  if (await machinePathHasOrbisBin()) return false;
  await runElevatedPathChange("add");
  return true;
}

/** 卸载时把机器 PATH 里的这一项拿掉；本来就没改过就不提权。 */
async function dropOrbisFromMachinePath(): Promise<void> {
  if (process.platform !== "win32") return;
  if (!await machinePathHasOrbisBin()) return;
  await runElevatedPathChange("remove");
}

async function machinePathHasOrbisBin(): Promise<boolean> {
  const entries = await readRegistryPath(MACHINE_ENVIRONMENT_KEY);
  return entries.some(entry => samePath(expandVariables(entry), orbisBin()));
}

async function runElevatedPathChange(action: "add" | "remove"): Promise<void> {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `$entry = '${MACHINE_PATH_ENTRY}'`,
    `$key = '${MACHINE_ENVIRONMENT_KEY.replace(/^HKLM/u, "HKLM:")}'`,
    "$target = [Environment]::ExpandEnvironmentVariables($entry)",
    "$current = (Get-ItemProperty -Path $key -Name Path).Path",
    "$kept = @($current -split ';' | Where-Object { $_.Trim() } | Where-Object { [Environment]::ExpandEnvironmentVariables($_.Trim()) -ne $target })",
    `$next = if ($${action === "add" ? "true" : "false"}) { @($entry) + $kept } else { @($kept) }`,
    "if (($next -join ';') -eq $current) { exit 0 }",
    "Set-ItemProperty -Path $key -Name Path -Value ($next -join ';') -Type ExpandString",
    // 广播只是尽力而为：注册表已经改好了，通知失败不该让整次修复报失败。
    `try { ${ENVIRONMENT_BROADCAST} } catch { }`,
  ].join("; ");
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  const launcher = `$ErrorActionPreference = 'Stop'; $p = Start-Process -FilePath 'powershell.exe' -Verb RunAs -WindowStyle Hidden -PassThru -Wait -ArgumentList '-NoProfile','-NonInteractive','-EncodedCommand','${encoded}'; exit $p.ExitCode`;
  try {
    await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", launcher], { windowsHide: true, timeout: 120_000 });
  } catch {
    throw new Error("需要管理员权限才能把 Orbis 终端入口放到系统 PATH 最前，本次操作已取消");
  }
}

async function updateUserPath(current: string[], update: (path: string[]) => string[]): Promise<void> {
  const next = update(current);
  if (next.join(";") === current.join(";")) return;
  if (next.length === 0) {
    await execFileAsync("reg.exe", ["delete", "HKCU\\Environment", "/v", "Path", "/f"], { windowsHide: true });
  } else {
    await execFileAsync("reg.exe", ["add", "HKCU\\Environment", "/v", "Path", "/t", "REG_EXPAND_SZ", "/d", next.join(";"), "/f"], { windowsHide: true });
  }
  await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ENVIRONMENT_BROADCAST], { windowsHide: true, timeout: 10_000 }).catch(() => {});
}

async function readUserPath(): Promise<string[]> {
  return await readRegistryPath("HKCU\\Environment");
}
async function readRegistryPath(key: string): Promise<string[]> {
  const { stdout } = await execFileAsync("reg.exe", ["query", key], { windowsHide: true });
  const match = stdout.match(/^\s*Path\s+REG_\w+\s+(.*)$/imu);
  return match ? splitPath(match[1]!) : [];
}
function splitPath(value: string): string[] { return value.split(";").map(entry => entry.trim()).filter(Boolean); }
function samePath(left: string, right: string): boolean {
  return resolve(left).replaceAll("/", "\\").replace(/[\\]+$/u, "").toLowerCase()
    === resolve(right).replaceAll("/", "\\").replace(/[\\]+$/u, "").toLowerCase();
}

if (process.argv[1]?.endsWith("codex-shim-install.js") === true) {
  const option = process.argv[2];
  const operation = option === "--uninstall" ? uninstallCodexShim() : option === "--install" && process.argv[3]
    ? installCodexShim(process.argv[3])
    : Promise.reject(new Error("Usage: codex-shim-install --install <runtime-root> | --uninstall"));
  operation.catch(error => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
