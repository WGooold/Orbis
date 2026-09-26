import { execFile } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const ORBIS_BIN = join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "Orbis", "bin");
const SHIM_PATH = join(ORBIS_BIN, "codex.cmd");
const MANIFEST_PATH = join(ORBIS_BIN, "codex-shim.json");

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
  await mkdir(ORBIS_BIN, { recursive: true });
  await writeFile(SHIM_PATH, renderCodexShim(runtimeRoot), "utf8");
  await writeFile(MANIFEST_PATH, `${JSON.stringify({ version: 1, bin: ORBIS_BIN }, null, 2)}\n`, "utf8");
  await updateUserPath(path => [ORBIS_BIN, ...path.filter(entry => !samePath(entry, ORBIS_BIN))]);
}

export async function uninstallCodexShim(): Promise<void> {
  await updateUserPath(path => path.filter(entry => !samePath(entry, ORBIS_BIN)));
  await rm(SHIM_PATH, { force: true });
  await rm(MANIFEST_PATH, { force: true });
}

async function updateUserPath(update: (path: string[]) => string[]): Promise<void> {
  const current = await readUserPath();
  const next = update(current);
  if (next.join(";") === current.join(";")) return;
  if (next.length === 0) {
    await execFileAsync("reg.exe", ["delete", "HKCU\\Environment", "/v", "Path", "/f"], { windowsHide: true });
    return;
  }
  await execFileAsync("reg.exe", ["add", "HKCU\\Environment", "/v", "Path", "/t", "REG_EXPAND_SZ", "/d", next.join(";"), "/f"], { windowsHide: true });
}

async function readUserPath(): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync("reg.exe", ["query", "HKCU\\Environment", "/v", "Path"], { windowsHide: true });
    const match = stdout.match(/^\s*Path\s+REG_\w+\s+(.*)$/imu);
    if (match?.[1] !== undefined) return splitPath(match[1]);
  } catch {
    // A missing user Path is valid; use the inherited value as a conservative fallback.
  }
  return splitPath(process.env.Path ?? process.env.PATH ?? "");
}

function splitPath(value: string): string[] {
  return value.split(";").map(entry => entry.trim()).filter(entry => entry.length > 0);
}

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
