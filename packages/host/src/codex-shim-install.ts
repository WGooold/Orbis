import { execFile } from "node:child_process";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
function orbisBin(): string { return join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "Orbis", "bin"); }
function shimPath(): string { return join(orbisBin(), "codex.cmd"); }
function manifestPath(): string { return join(orbisBin(), "codex-shim.json"); }

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
  const owned = await readFile(shimPath(), "utf8").catch(() => "");
  if (owned.includes("ORBIS_CODEX_RUNTIME=")) await rm(shimPath(), { force: true });
  await rm(manifestPath(), { force: true });
}

export type CodexTerminalIntegration = { state: "enabled" | "pending" | "repair" | "disabled"; detail: string };
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
      return { state: "repair", detail: `当前 PATH 优先命中 ${first ?? "其他入口"}；请检查系统 PATH 顺序` };
    }
    return { state: "pending", detail: "已写入用户 PATH；请重新打开终端后检查 codex 命中位置" };
  } catch {
    return { state: "repair", detail: "无法读取用户 PATH，请检查权限" };
  }
}

async function firstCodexOnPath(path: string): Promise<string | undefined> {
  for (const dir of splitPath(path)) {
    const expanded = dir.replace(/%([^%]+)%/gu, (_, name: string) => Object.entries(process.env).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1] ?? `%${name}%`);
    for (const ext of [".COM", ".EXE", ".BAT", ".CMD"]) {
      const candidate = join(expanded.replace(/^"|"$/gu, ""), `codex${ext.toLowerCase()}`);
      if (await exists(candidate)) return candidate;
    }
  }
  return undefined;
}
async function exists(path: string): Promise<boolean> { try { await access(path); return true; } catch { return false; } }

async function updateUserPath(current: string[], update: (path: string[]) => string[]): Promise<void> {
  const next = update(current);
  if (next.join(";") === current.join(";")) return;
  if (next.length === 0) {
    await execFileAsync("reg.exe", ["delete", "HKCU\\Environment", "/v", "Path", "/f"], { windowsHide: true });
  } else {
    await execFileAsync("reg.exe", ["add", "HKCU\\Environment", "/v", "Path", "/t", "REG_EXPAND_SZ", "/d", next.join(";"), "/f"], { windowsHide: true });
  }
  await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
    'Add-Type -Namespace Orbis -Name EnvNotify -MemberDefinition \'[DllImport("user32.dll", CharSet = CharSet.Auto)] public static extern System.IntPtr SendMessageTimeout(System.IntPtr hwnd, int msg, System.IntPtr wp, string lp, int flags, int timeout, out System.IntPtr result);\' -UsingNamespace System.Runtime.InteropServices; $result = [IntPtr]::Zero; [void][Orbis.EnvNotify]::SendMessageTimeout([IntPtr]0xffff, 0x1a, [IntPtr]::Zero, "Environment", 2, 5000, [ref]$result)',
  ], { windowsHide: true, timeout: 10_000 }).catch(() => {});
}

async function readUserPath(): Promise<string[]> {
  const { stdout } = await execFileAsync("reg.exe", ["query", "HKCU\\Environment"], { windowsHide: true });
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
