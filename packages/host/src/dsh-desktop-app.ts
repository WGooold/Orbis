/**
 * DeepSeek Harness Desktop installation, Orbis-owned launch and endpoint recovery
 * (ADR-0076 DSH-DESKTOP-01/02/07).
 *
 * Desktop owns its backend, profile and authentication. Its Host prints the
 * authenticated loopback URL (`dsh web: …`) to stdout, and Electron main pipes
 * that stdout to its own. Only a Desktop process started by Orbis has a stdout
 * Orbis can read, so Orbis records the URL for the instance it started and never
 * scans ports, reads cookie stores or uses private Electron IPC. A Desktop the
 * user opened elsewhere is reported as running but not connectable. Nothing here
 * terminates Desktop.
 */
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, mkdir, open, readdir, readFile, rename, stat, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { AsarArchive } from "./asar-archive.js";
import { DSH_DESKTOP_HOST_PACKAGE_DIR, DSH_DESKTOP_PACKAGE_DIR } from "./dsh-desktop-protocol.js";
import { DSH_PROVIDER_ENV } from "./dsh-web-provider.js";

const execute = promisify(execFile);
export const DSH_DESKTOP_PRODUCT = "DeepSeek Harness";
const URL_LINE = /(?:^|\r?\n)dsh web: (http:\/\/127\.0\.0\.1:\d{1,5}\/\?token=[A-Za-z0-9_-]{16,})/gu;
const MAX_LOG_SCAN_BYTES = 4 * 1024 * 1024;

export type DshDesktopInstallation = {
  /** Windows install directory or macOS `.app` bundle. */
  root: string;
  executable: string;
  archive: string;
  /** `@deepseek-ai/dsh` version inside this Desktop (Desktop and dsh are released together). */
  version: string;
};

export type DshDesktopDiscoveryOptions = {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  /** Explicit install root (Windows directory / macOS bundle) from settings or `ORBIS_DSH_DESKTOP_PATH`. */
  explicitPath?: string;
  registryInstallLocations?: () => Promise<string[]>;
  /** macOS folders checked before the bundle-ID lookup; defaults to `/Applications` and `~/Applications`. */
  applicationFolders?: string[];
  /** macOS bundles registered for {@link DSH_DESKTOP_BUNDLE_IDS}; defaults to LaunchServices plus Spotlight. */
  bundleLocations?: () => Promise<string[]>;
};

/**
 * macOS bundle IDs: official releases (`com.deepseek.dsh`, read from the installed 0.2.2-rc.2) and
 * upstream local builds (`com.deepseek.harness`, apps/desktop/packaging/README). A match is only a
 * candidate; it still has to pass {@link inspectDshDesktopInstallation}.
 */
export const DSH_DESKTOP_BUNDLE_IDS = ["com.deepseek.dsh", "com.deepseek.harness"] as const;

// `URLsForApplicationsWithBundleIdentifier:` needs macOS 12; older systems get the preferred copy only.
const LAUNCH_SERVICES_SCRIPT = String.raw`
ObjC.import("AppKit");
function run(ids) {
  const workspace = $.NSWorkspace.sharedWorkspace;
  const all = workspace.respondsToSelector("URLsForApplicationsWithBundleIdentifier:");
  const paths = [];
  for (const id of ids) {
    if (all) {
      const urls = workspace.URLsForApplicationsWithBundleIdentifier(id);
      for (let i = 0; i < urls.count; i++) paths.push(urls.objectAtIndex(i).path.js);
    } else {
      const url = workspace.URLForApplicationWithBundleIdentifier(id);
      if (!url.isNil()) paths.push(url.path.js);
    }
  }
  return JSON.stringify(paths);
}`;

/**
 * Desktop bundles anywhere on the Mac, e.g. an external volume: LaunchServices knows every copy that was
 * opened or seen by Finder; Spotlight adds indexed copies that never were. Either source may fail alone.
 */
async function macBundleLocations(): Promise<string[]> {
  const [launchServices, spotlight] = await Promise.allSettled([
    execute("/usr/bin/osascript", ["-l", "JavaScript", "-e", LAUNCH_SERVICES_SCRIPT, ...DSH_DESKTOP_BUNDLE_IDS],
      { timeout: 5_000, maxBuffer: 256 * 1024, encoding: "utf8" }),
    execute("/usr/bin/mdfind", [DSH_DESKTOP_BUNDLE_IDS.map(id => `kMDItemCFBundleIdentifier == "${id}"`).join(" || ")],
      { timeout: 5_000, maxBuffer: 256 * 1024, encoding: "utf8" }),
  ]);
  const paths: string[] = [];
  if (launchServices.status === "fulfilled") {
    try {
      const value: unknown = JSON.parse(launchServices.value.stdout.trim() || "[]");
      if (Array.isArray(value)) paths.push(...value.filter((item): item is string => typeof item === "string"));
    } catch { /* Spotlight below still applies. */ }
  }
  if (spotlight.status === "fulfilled") paths.push(...spotlight.value.stdout.split("\n").map(line => line.trim()));
  return paths.filter(path => path.startsWith("/"));
}

/**
 * Trashed copies are never launched. Read-only copies (a mounted installer image, an App Translocation
 * path) stay usable but come after a copy the user installed.
 */
async function orderBundleLocations(paths: string[]): Promise<string[]> {
  const kept = paths.filter(path => !/\/\.Trash(?:es)?\//u.test(path));
  const writable = await Promise.all(kept.map(path => access(path, fsConstants.W_OK).then(() => true, () => false)));
  return [...kept.filter((_, index) => writable[index]), ...kept.filter((_, index) => !writable[index])];
}

export function supportsDshDesktop(target: NodeJS.Platform = process.platform): boolean {
  return target === "win32" || target === "darwin";
}

function layout(root: string, target: NodeJS.Platform): { executable: string; archive: string } {
  return target === "darwin"
    ? { executable: join(root, "Contents", "MacOS", DSH_DESKTOP_PRODUCT), archive: join(root, "Contents", "Resources", "app.asar") }
    : { executable: join(root, `${DSH_DESKTOP_PRODUCT}.exe`), archive: join(root, "resources", "app.asar") };
}

const isFile = async (path: string): Promise<boolean> => (await stat(path).catch(() => undefined))?.isFile() === true;

/** A candidate is Desktop only when its executable and archive exist and the archive carries dsh plus the Desktop Host. */
export async function inspectDshDesktopInstallation(root: string, target: NodeJS.Platform = process.platform): Promise<DshDesktopInstallation | undefined> {
  const paths = layout(resolve(root), target);
  if (!await isFile(paths.executable) || !await isFile(paths.archive)) return undefined;
  let archive: AsarArchive;
  try { archive = await AsarArchive.open(paths.archive); } catch { return undefined; }
  if (!archive.isFile(`${DSH_DESKTOP_HOST_PACKAGE_DIR}/package.json`)) return undefined;
  const manifest = await archive.readJson(`${DSH_DESKTOP_PACKAGE_DIR}/package.json`).catch(() => undefined);
  const version = manifest !== null && typeof manifest === "object" && typeof (manifest as { version?: unknown }).version === "string"
    ? (manifest as { version: string }).version : undefined;
  if (version === undefined) return undefined;
  return { root: resolve(root), ...paths, version };
}

/** Per-user uninstall entries written by the official NSIS installer (`InstallLocation`). */
async function windowsInstallLocations(env: NodeJS.ProcessEnv): Promise<string[]> {
  const script = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$roots = @('HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall', 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall')
$found = foreach ($root in $roots) {
  if (Test-Path $root) {
    Get-ChildItem $root | ForEach-Object { Get-ItemProperty $_.PSPath } |
      Where-Object { $_.DisplayName -like 'DeepSeek Harness*' -and $_.InstallLocation } |
      ForEach-Object { [string]$_.InstallLocation }
  }
}
ConvertTo-Json -Compress -InputObject @($found)
`;
  const { stdout } = await execute(join(env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
    { windowsHide: true, timeout: 15_000, maxBuffer: 256 * 1024, encoding: "utf8" });
  const value: unknown = JSON.parse(stdout.trim() || "[]");
  return (Array.isArray(value) ? value : [value]).filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    .map(item => item.trim().replace(/^"(.*)"$/u, "$1"));
}

/** Installed Desktop candidates in preference order; the first valid one is used. */
export async function findDshDesktopInstallation(options: DshDesktopDiscoveryOptions = {}): Promise<DshDesktopInstallation | undefined> {
  const target = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  if (!supportsDshDesktop(target)) return undefined;
  const explicit = options.explicitPath?.trim() || env.ORBIS_DSH_DESKTOP_PATH?.trim();
  // An explicit choice is authoritative: never silently fall back to another install.
  if (explicit) return inspectDshDesktopInstallation(explicit, target);
  const seen = new Set<string>();
  const firstValid = async (candidates: string[]): Promise<DshDesktopInstallation | undefined> => {
    for (const candidate of candidates) {
      const key = resolve(candidate).toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      const installation = await inspectDshDesktopInstallation(candidate, target);
      if (installation !== undefined) return installation;
    }
    return undefined;
  };
  if (target === "win32") {
    const candidates: string[] = [];
    try { candidates.push(...await (options.registryInstallLocations ?? (() => windowsInstallLocations(env)))()); }
    catch { /* Registry access failures still allow the default per-user location below. */ }
    const programs = join(env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "Programs");
    for (const entry of await readdir(programs, { withFileTypes: true }).catch(() => [])) {
      if (entry.isDirectory()) candidates.push(join(programs, entry.name));
    }
    return firstValid(candidates);
  }
  // The usual folders need no process; the bundle-ID lookup runs only when they hold no Desktop.
  const folders = options.applicationFolders ?? ["/Applications", join(homedir(), "Applications")];
  const standard = await firstValid(folders.map(folder => join(folder, `${DSH_DESKTOP_PRODUCT}.app`)));
  if (standard !== undefined) return standard;
  const located = await (options.bundleLocations ?? macBundleLocations)().catch(() => []);
  return firstValid(await orderBundleLocations(located));
}

/** Whether Desktop's main process is running. Detection only: Orbis never terminates Desktop by name. */
export async function isDshDesktopRunning(installation: DshDesktopInstallation, target: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  const wanted = installation.executable.replaceAll("/", "\\").toLowerCase();
  if (target === "win32") {
    const script = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
ConvertTo-Json -Compress -InputObject @(Get-CimInstance Win32_Process -Filter "Name = 'DeepSeek Harness.exe'" | ForEach-Object { [string]$_.ExecutablePath })
`;
    const { stdout } = await execute(join(env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
      ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
      { windowsHide: true, timeout: 15_000, maxBuffer: 256 * 1024, encoding: "utf8" });
    const value: unknown = JSON.parse(stdout.trim() || "[]");
    return (Array.isArray(value) ? value : [value]).some(item => typeof item === "string" && item.replaceAll("/", "\\").toLowerCase() === wanted);
  }
  const { stdout } = await execute("/bin/ps", ["-axww", "-o", "comm="], { timeout: 5_000, maxBuffer: 8 * 1024 * 1024 });
  return stdout.split("\n").some(line => line.trim() === installation.executable);
}

export type DshDesktopDescriptor = {
  version: 1;
  owner: "orbis";
  pid: number;
  executable: string;
  archive: string;
  logPath: string;
  launchedAt: number;
  /** Last authenticated launch URL. Private: never logged or sent to devices. */
  url?: string;
};

export function dshDesktopStateDirectory(stateDir: string): string { return join(stateDir, "dsh-desktop"); }
const descriptorPath = (stateDir: string): string => join(dshDesktopStateDirectory(stateDir), "endpoint.json");

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return !(error instanceof Error && "code" in error && error.code === "ESRCH"); }
}

/** A launch token is valid only for its process; the root exchange mints a stateless cookie and creates no Peer. */
export async function dshDesktopUrlAuthenticates(url: string, timeoutMs = 3_000): Promise<boolean> {
  try {
    const response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
    const cookie = response.headers.getSetCookie().some(value => value.startsWith("dsh-auth-"));
    await response.body?.cancel();
    return (response.status === 303 || response.status === 302) && cookie;
  } catch { return false; }
}

/** The latest URL in the private stdout log: Desktop restarts its Host (for example after update recovery) in place. */
export async function latestDshDesktopUrl(logPath: string): Promise<string | undefined> {
  let text: string;
  try {
    const handle = await open(logPath, "r");
    try {
      const size = (await handle.stat()).size;
      const length = Math.min(size, MAX_LOG_SCAN_BYTES);
      const buffer = Buffer.alloc(length);
      // The first line is normally at the start; a long-running Desktop may also print a newer one near the end.
      await handle.read(buffer, 0, length, size > MAX_LOG_SCAN_BYTES ? size - length : 0);
      text = buffer.toString("utf8");
      if (size > MAX_LOG_SCAN_BYTES) {
        const head = Buffer.alloc(Math.min(size, 256 * 1024));
        await handle.read(head, 0, head.length, 0);
        text = `${head.toString("utf8")}\n${text}`;
      }
    } finally { await handle.close(); }
  } catch { return undefined; }
  let latest: string | undefined;
  for (const match of text.matchAll(URL_LINE)) latest = match[1];
  return latest;
}

async function writeDescriptor(stateDir: string, descriptor: DshDesktopDescriptor): Promise<void> {
  const path = descriptorPath(stateDir);
  await mkdir(dshDesktopStateDirectory(stateDir), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  const file = await open(temporary, "wx", 0o600);
  try { await file.writeFile(JSON.stringify(descriptor)); } finally { await file.close(); }
  await rename(temporary, path);
}

async function readDescriptor(stateDir: string): Promise<DshDesktopDescriptor | undefined> {
  let value: Record<string, unknown>;
  try { value = JSON.parse(await readFile(descriptorPath(stateDir), "utf8")) as Record<string, unknown>; }
  catch { return undefined; }
  if (value === null || typeof value !== "object" || value.version !== 1 || value.owner !== "orbis" || !Number.isSafeInteger(value.pid) || Number(value.pid) <= 0
    || typeof value.executable !== "string" || typeof value.archive !== "string" || typeof value.logPath !== "string" || !Number.isSafeInteger(value.launchedAt)) return undefined;
  return { version: 1, owner: "orbis", pid: Number(value.pid), executable: value.executable, archive: value.archive, logPath: value.logPath,
    launchedAt: Number(value.launchedAt), ...(typeof value.url === "string" ? { url: value.url } : {}) };
}

export type DshDesktopEndpoint = { url: string; descriptor: DshDesktopDescriptor };

/**
 * Recover the endpoint of the Desktop instance Orbis launched, without starting anything.
 * The stored URL is re-read from the log when Desktop has restarted its Host.
 */
export async function readDshDesktopEndpoint(stateDir: string, installation: DshDesktopInstallation): Promise<DshDesktopEndpoint | undefined> {
  const descriptor = await readDescriptor(stateDir);
  if (descriptor === undefined || !alive(descriptor.pid)) return undefined;
  // A different install (moved, reinstalled) is a different Desktop.
  if (resolve(descriptor.executable).toLowerCase() !== resolve(installation.executable).toLowerCase()) return undefined;
  if (descriptor.url !== undefined && await dshDesktopUrlAuthenticates(descriptor.url)) return { url: descriptor.url, descriptor };
  const latest = await latestDshDesktopUrl(descriptor.logPath);
  if (latest === undefined || latest === descriptor.url || !await dshDesktopUrlAuthenticates(latest)) return undefined;
  const updated = { ...descriptor, url: latest };
  await writeDescriptor(stateDir, updated);
  return { url: latest, descriptor: updated };
}

/** Short state shared by the Host UI and phones: a Desktop Orbis did not open cannot be attached (DSH-DESKTOP-09). */
export const DSH_DESKTOP_OPEN_FROM_ORBIS = "DeepSeek 桌面版需由 Orbis 打开";

export class DshDesktopRunningElsewhereError extends Error {
  constructor(message = DSH_DESKTOP_OPEN_FROM_ORBIS) { super(message); }
}

/**
 * Bring the Desktop Orbis opened forward. A second launch hands off to the running owner through Electron's
 * single-instance lock: the owner focuses or recreates its window and the new process quits
 * (upstream `single-instance.ts`, and "relaunching the application still focuses it" for a window hidden to the tray).
 * The handoff process writes nothing Orbis reads, so the endpoint record stays the owner's.
 */
export function revealDshDesktop(installation: DshDesktopInstallation, options: { env?: NodeJS.ProcessEnv; spawnDesktop?: typeof spawn } = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = (options.spawnDesktop ?? spawn)(installation.executable, [], {
      cwd: homedir(), detached: true, env: dshDesktopLaunchEnvironment(options.env ?? process.env), stdio: "ignore",
    });
    child.once("error", error => { reject(new Error(`无法打开 DeepSeek 桌面版：${error.message}`)); });
    child.once("spawn", () => { child.unref(); resolve(); });
  });
}

/** Desktop must not inherit Orbis's Node runtime switches or managed provider credentials (DSH-DESKTOP-05). */
export function dshDesktopLaunchEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const launch = { ...env };
  for (const key of ["ELECTRON_RUN_AS_NODE", "NODE_OPTIONS", "ORBIS_DSH_WEB_URL", "ORBIS_DSH_ENTRY", DSH_PROVIDER_ENV]) delete launch[key];
  return launch;
}

const launches = new Map<string, Promise<DshDesktopEndpoint>>();

/** The Orbis launch in progress for this state directory, if any. */
export function pendingDshDesktopLaunch(stateDir: string): Promise<DshDesktopEndpoint> | undefined {
  return launches.get(resolve(stateDir));
}

/**
 * Start Desktop so that its forwarded Host stdout lands in a private file, then wait for its URL.
 * The process is detached: Host exit or update never takes Desktop down, and a file never raises EPIPE.
 * Concurrent callers for one state directory (an App request, the Host UI, a paused Host's open) share
 * one launch: a second spawn would replace the shared log and endpoint record with a handoff process.
 */
export function launchDshDesktop(installation: DshDesktopInstallation, stateDir: string, options: { env?: NodeJS.ProcessEnv; timeoutMs?: number; spawnDesktop?: typeof spawn } = {}): Promise<DshDesktopEndpoint> {
  const key = resolve(stateDir);
  const existing = launches.get(key);
  if (existing !== undefined) return existing;
  const pending = launchOnce(installation, stateDir, options).finally(() => { if (launches.get(key) === pending) launches.delete(key); });
  launches.set(key, pending);
  return pending;
}

async function launchOnce(installation: DshDesktopInstallation, stateDir: string, options: { env?: NodeJS.ProcessEnv; timeoutMs?: number; spawnDesktop?: typeof spawn }): Promise<DshDesktopEndpoint> {
  const directory = dshDesktopStateDirectory(stateDir);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const logPath = join(directory, "desktop-output.log");
  await unlink(logPath).catch(() => {});
  const output = await open(logPath, "wx", 0o600);
  let exitCode: number | null | undefined;
  let spawnError: Error | undefined;
  const child = (options.spawnDesktop ?? spawn)(installation.executable, [], {
    cwd: homedir(), detached: true, env: dshDesktopLaunchEnvironment(options.env ?? process.env), stdio: ["ignore", output.fd, output.fd],
  });
  child.once("error", error => { spawnError = error; });
  child.once("exit", code => { exitCode = code; });
  await output.close();
  if (child.pid === undefined) {
    await delay(0);
    throw new Error(`无法打开 DeepSeek 桌面版：${spawnError?.message ?? "启动失败"}`);
  }
  const descriptor: DshDesktopDescriptor = { version: 1, owner: "orbis", pid: child.pid, executable: installation.executable,
    archive: installation.archive, logPath, launchedAt: Date.now() };
  await writeDescriptor(stateDir, descriptor);
  child.unref();
  const deadline = Date.now() + (options.timeoutMs ?? 120_000);
  while (Date.now() < deadline) {
    if (spawnError) throw new Error(`无法打开 DeepSeek 桌面版：${spawnError.message}`);
    const url = await latestDshDesktopUrl(logPath);
    if (url !== undefined && await dshDesktopUrlAuthenticates(url)) {
      const ready = { ...descriptor, url };
      await writeDescriptor(stateDir, ready);
      return { url, descriptor: ready };
    }
    if (exitCode !== undefined) {
      // Electron's single-instance handoff focuses the existing window and quits this one cleanly.
      if (exitCode === 0) throw new DshDesktopRunningElsewhereError();
      throw new Error(`DeepSeek 桌面版启动后退出（${exitCode ?? "signal"}）`);
    }
    await delay(200);
  }
  // First-run setup has no backend yet; the endpoint is recovered once Desktop prints it.
  throw new Error("等待 DeepSeek 桌面版完成设置");
}
