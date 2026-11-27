import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, fstatSync, mkdirSync, openSync, readFileSync, readdirSync, readSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, win32 } from "node:path";
import { promisify } from "node:util";

import { macDesktopCliCandidates, type MacDesktopCliOptions } from "./codex-desktop-macos.js";

export type DesktopCli = { command: string; prefixArgs: string[] };
export type DesktopCliCandidate = DesktopCli & { source: string };
export type WindowsDesktopDiscovery = {
  ancestorExecutable?: string;
  packages: readonly { installLocation: string; packageFullName: string; signatureKind?: string }[];
};
export type WindowsDesktopCliOptions = {
  requireCodeModeHost?: boolean;
  desktopVersion?: string;
  /** Zero skips ancestry when Host checks the next registered application launch. */
  parentPid?: number;
  discover?: () => Promise<WindowsDesktopDiscovery>;
  digestCacheFile?: string;
  log?: (message: string) => void;
};

const run = promisify(execFile);
const PACKAGE_NAME = /^OpenAI\.Codex_(\d+(?:\.\d+)*)_(x64|arm64)__/iu;
const STORE_PACKAGE = /^OpenAI\.Codex_\d+(?:\.\d+){3}_(?:x64|arm64)__2p2nqsd0c76g0$/iu;
const COMPANIONS = ["codex-code-mode-host.exe", "codex-command-runner.exe", "codex-windows-sandbox-setup.exe"];

/** Read the launching GUI first; never choose another user's newer AppX package. */
export async function discoverWindowsDesktop(parentPid = process.ppid): Promise<WindowsDesktopDiscovery> {
  if (process.platform !== "win32") return { packages: [] };
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "[Console]::OutputEncoding = [Text.UTF8Encoding]::new()",
    "$ancestor = $null",
    "$next = " + Math.max(0, Math.trunc(parentPid)),
    "$seen = @{}",
    "for ($i = 0; $i -lt 8 -and $next -gt 0 -and -not $seen.ContainsKey($next); $i++) {",
    "  $seen[$next] = $true",
    "  try { $p = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $next) -ErrorAction Stop } catch { break }",
    "  if ($null -eq $p) { break }",
    "  if ($p.ExecutablePath -match '[\\\\/]OpenAI\\.Codex_[^\\\\/]+[\\\\/]app[\\\\/]ChatGPT\\.exe$') { $ancestor = [string]$p.ExecutablePath; break }",
    "  $next = [int]$p.ParentProcessId",
    "}",
    "$packages = @()",
    "if ($null -eq $ancestor) { $packages = @(Get-AppxPackage -Name OpenAI.Codex | ForEach-Object { @{ installLocation = [string]$_.InstallLocation; packageFullName = [string]$_.PackageFullName; signatureKind = [string]$_.SignatureKind } }) }",
    "@{ ancestorExecutable = $ancestor; packages = $packages } | ConvertTo-Json -Compress",
  ].join("\n");
  const { stdout } = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
    { windowsHide: true, timeout: 8_000, maxBuffer: 64 * 1024 });
  const value = JSON.parse(stdout.trim()) as Record<string, unknown>;
  const packages = Array.isArray(value.packages) ? value.packages.flatMap((item: unknown) => {
    if (item === null || typeof item !== "object") return [];
    const entry = item as Record<string, unknown>;
    return typeof entry.installLocation === "string" && typeof entry.packageFullName === "string"
      ? [{ installLocation: entry.installLocation, packageFullName: entry.packageFullName,
        ...(typeof entry.signatureKind === "string" ? { signatureKind: entry.signatureKind } : {}) }] : [];
  }) : [];
  return { packages, ...(typeof value.ancestorExecutable === "string" ? { ancestorExecutable: value.ancestorExecutable } : {}) };
}

function sameVersion(left: string, right: string): boolean {
  const a = left.split(".").map(Number), b = right.split(".").map(Number);
  return Array.from({ length: Math.max(a.length, b.length) }, (_, index) => (a[index] ?? 0) === (b[index] ?? 0)).every(Boolean);
}

export function desktopInstallationCli(discovery: WindowsDesktopDiscovery, version?: string): string | undefined {
  const ancestor = discovery.ancestorExecutable;
  if (ancestor && /[\\/]OpenAI\.Codex_[^\\/]+[\\/]app[\\/]ChatGPT\.exe$/iu.test(ancestor)) {
    return join(dirname(ancestor), "resources", "codex.exe");
  }
  const installed = discovery.packages.filter(entry => {
    const match = PACKAGE_NAME.exec(entry.packageFullName);
    return match !== null && (version === undefined || sameVersion(match[1]!, version));
  });
  // The current-user registration is authoritative only if it identifies one installation.
  const unique = [...new Map(installed.map(entry => [resolve(entry.installLocation).toLowerCase(), entry])).values()];
  return unique.length === 1 ? join(unique[0]!.installLocation, "app", "resources", "codex.exe") : undefined;
}

/** A path that merely looks like WindowsApps is not proof that it belongs to the registered app. */
export async function isRegisteredWindowsDesktopCli(value: string): Promise<boolean> {
  const path = value.trim().replaceAll("/", "\\");
  if (!/^[a-z]:\\/iu.test(path) || !/\\app\\resources\\codex\.exe$/iu.test(path)) return false;
  try {
    const { packages } = await discoverWindowsDesktop(0);
    const [installed] = packages;
    return packages.length === 1 && installed?.signatureKind === "Store" && STORE_PACKAGE.test(installed.packageFullName)
      && /^[a-z]:[\\/]/iu.test(installed.installLocation)
      && path.toLowerCase() === win32.join(installed.installLocation, "app", "resources", "codex.exe").toLowerCase();
  } catch { return false; }
}

function isFile(path: string): boolean {
  try { return statSync(path).isFile(); } catch { return false; }
}

type DigestEntry = { stamp: string; digest: string };
/** Only metadata and hashes are cached. No executable is copied or downloaded. */
class Digests {
  #values: Record<string, DigestEntry> = Object.create(null) as Record<string, DigestEntry>;
  #used: Record<string, DigestEntry> = Object.create(null) as Record<string, DigestEntry>;
  constructor(readonly file?: string) {
    if (file === undefined) return;
    try {
      const value = JSON.parse(readFileSync(file, "utf8")) as { schema?: unknown; entries?: unknown };
      if (value.schema === 1 && value.entries !== null && typeof value.entries === "object") {
        this.#values = value.entries as Record<string, DigestEntry>;
      }
    } catch { /* A missing/stale cache requires hashing the existing files. */ }
  }
  hash(path: string): string {
    const fd = openSync(path, "r");
    try {
      const before = fstatSync(fd);
      if (!before.isFile()) throw new Error("CLI 组件不是文件：" + path);
      const stamp = [before.size, before.mtimeMs, before.ctimeMs, before.birthtimeMs].join(":");
      const key = resolve(path).toLowerCase(), cached = this.#values[key];
      if (cached?.stamp === stamp && /^[a-f0-9]{64}$/u.test(cached.digest)) {
        this.#used[key] = cached;
        return cached.digest;
      }
      const hash = createHash("sha256"), buffer = Buffer.allocUnsafe(256 * 1024);
      for (;;) {
        const length = readSync(fd, buffer);
        if (length === 0) break;
        hash.update(buffer.subarray(0, length));
      }
      const after = fstatSync(fd);
      if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
        throw new Error("校验期间 CLI 组件发生变化：" + path);
      }
      const entry = { stamp, digest: hash.digest("hex") };
      this.#used[key] = entry;
      return entry.digest;
    } finally { closeSync(fd); }
  }
  save(): void {
    if (this.file === undefined) return;
    const temporary = this.file + "." + process.pid + ".tmp";
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(temporary, JSON.stringify({ schema: 1, entries: this.#used }));
      renameSync(temporary, this.file);
    } catch { /* Cache persistence is never a prerequisite for Desktop startup. */ }
    finally { try { rmSync(temporary, { force: true }); } catch { /* Best effort. */ } }
  }
}

function officialCopies(root: string): string[] {
  try {
    return [...readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory())
      .map(entry => join(root, entry.name, "codex.exe")), join(root, "codex.exe")].filter(isFile).sort();
  } catch { return []; }
}

/**
 * ADR-0022: select existing official files for the launching GUI, without maintaining another runtime.
 * Companion matching follows what that installed package actually ships, not a hard-coded cache key.
 */
export async function windowsDesktopCliCandidates(env: NodeJS.ProcessEnv, options: WindowsDesktopCliOptions = {}): Promise<DesktopCliCandidate[]> {
  const log = options.log ?? (() => {});
  const candidates: DesktopCliCandidate[] = [];
  const seen = new Set<string>();
  const add = (command: string | undefined, source: string): void => {
    if (!command) return;
    const key = resolve(command).toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    // During Host's next-launch preflight there is no wrapper to recurse into via the inherited override.
    if (/^codex-launcher(?:\.exe)?$/iu.test(basename(command))
      || options.parentPid !== 0 && env.CODEX_CLI_PATH && key === resolve(env.CODEX_CLI_PATH).toLowerCase()) {
      log("忽略指回包装器的 CLI：" + command);
      return;
    }
    if (!isFile(command)) { log(source + " 文件不存在或不可读：" + command); return; }
    if (options.requireCodeModeHost && !isFile(join(dirname(command), "codex-code-mode-host.exe"))) {
      log(source + " 缺少 codex-code-mode-host.exe：" + command);
      return;
    }
    candidates.push({ command, prefixArgs: [], source });
  };
  const explicit = env.ORBIS_CODEX_REAL?.trim();
  const desktopOverride = env.ORBIS_CODEX_DESKTOP_CLI?.trim();
  let packaged = desktopOverride && isFile(desktopOverride) ? desktopOverride : undefined;
  if (packaged === undefined) {
    if (desktopOverride) log("ORBIS_CODEX_DESKTOP_CLI 文件不存在：" + desktopOverride);
    try {
      const discovery = await (options.discover ?? (() => discoverWindowsDesktop(options.parentPid)))();
      packaged = desktopInstallationCli(discovery, options.desktopVersion);
      if (!discovery.ancestorExecutable) log("未确认 GUI 祖先进程，使用当前用户的唯一匹配安装；未按最高版本猜测");
      if (packaged === undefined) log("无法唯一确认当前 Codex 桌面安装包");
    } catch (error) {
      log("读取当前 Codex 桌面安装失败：" + (error instanceof Error ? error.message : String(error)));
    }
  }
  if (packaged === undefined) {
    // A deliberate manual override is still useful when installation discovery is unavailable.
    add(explicit, "ORBIS_CODEX_REAL");
    return candidates;
  }
  const digests = new Digests(options.digestCacheFile);
  try {
    // Match the companion group actually shipped by this version.
    const names = ["codex.exe", ...COMPANIONS.filter(name => isFile(join(dirname(packaged), name)))];
    const source = names.map(name => ({ name, size: statSync(join(dirname(packaged!), name)).size, digest: digests.hash(join(dirname(packaged!), name)) }));
    const matches = (command: string): boolean => source.every(component => {
      const path = join(dirname(command), component.name === "codex.exe" ? basename(command) : component.name);
      return isFile(path) && statSync(path).size === component.size && digests.hash(path) === component.digest;
    });
    if (explicit) {
      try {
        if (matches(explicit)) add(explicit, "ORBIS_CODEX_REAL");
        else log("ORBIS_CODEX_REAL 已失效或与当前桌面安装不匹配，跳过：" + explicit);
      } catch (error) { log("无法校验 ORBIS_CODEX_REAL，跳过：" + String(error)); }
    }
    const root = join(env.LOCALAPPDATA?.trim() || join(homedir(), "AppData", "Local"), "OpenAI", "Codex", "bin");
    for (const copied of officialCopies(root)) {
      try {
        if (matches(copied)) add(copied, "desktop-cache");
      } catch (error) { log("跳过无法校验的官方副本：" + copied + "；" + String(error)); }
    }
  } catch (error) { log("无法校验桌面包的本地副本：" + String(error)); }
  finally { digests.save(); }
  add(packaged, packaged === desktopOverride ? "ORBIS_CODEX_DESKTOP_CLI" : "desktop-package");
  return candidates;
}

export type DesktopCliOptions = WindowsDesktopCliOptions & MacDesktopCliOptions & { platform?: NodeJS.Platform };
export type DesktopCliResolution = {
  candidates: DesktopCliCandidate[];
  /**
   * The invocation was started by the Codex Desktop GUI whose CLI these candidates belong to. Only
   * then may the wrapper publish its backend as the Desktop endpoint (ADR-0096).
   */
  fromDesktop: boolean;
  /** Whether the caller is the Desktop could not be checked (macOS process table unreadable). */
  uncertain?: string;
};

/**
 * ADR-0096: the CLI that belongs to the launching Desktop, never a PATH or terminal CLI. Windows keeps
 * the package/official-copy matching of ADR-0022; macOS uses the bundle among the process ancestors.
 */
export async function resolveDesktopCli(env: NodeJS.ProcessEnv, options: DesktopCliOptions = {}): Promise<DesktopCliResolution> {
  const platform = options.platform ?? process.platform;
  if (platform === "win32") return { candidates: await windowsDesktopCliCandidates(env, options), fromDesktop: true };
  if (platform === "darwin") {
    const resolved = await macDesktopCliCandidates(env, options);
    return { candidates: resolved.candidates, fromDesktop: resolved.origin === "ancestor" || resolved.origin === "explicit",
      ...(resolved.uncertain === undefined ? {} : { uncertain: resolved.uncertain }) };
  }
  // No Desktop exists here; an explicit CLI keeps development and isolated tests runnable.
  const explicit = env.ORBIS_CODEX_REAL?.trim();
  if (explicit && isFile(explicit)) return { candidates: [{ command: explicit, prefixArgs: [], source: "ORBIS_CODEX_REAL" }], fromDesktop: true };
  options.log?.(explicit ? "ORBIS_CODEX_REAL 文件不存在：" + explicit : "当前平台没有 Codex 桌面版");
  return { candidates: [], fromDesktop: false };
}
