/**
 * Host side of the Codex Desktop wrapper (ADR-0022, ADR-0096): stage the entry Codex runs through
 * `CODEX_CLI_PATH`, register it, and open the registered application.
 *
 * Opening Codex never depends on Orbis: whenever the wrapper cannot be prepared or registered, Host
 * opens Codex natively and records why it is not attached.
 *
 * Windows ships `codex-launcher.exe`; it and node stay resident for the whole Desktop session, so both
 * are staged outside the install directory and a stub forwards to the installed implementation. macOS
 * can replace files held open by running processes, so Host only generates a launcher that executes the
 * installed node and wrapper directly.
 */
import { randomUUID } from "node:crypto";
import { accessSync, chmodSync, constants, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { launchCodexDesktopApp } from "./codex-desktop-app.js";
import { windowsDesktopCliCandidates } from "./codex-desktop-cli.js";
import { launcherEndpoint, macDesktopCliCandidates, readLaunchdEnvironment, renderMacCodexLauncher } from "./codex-desktop-macos.js";
import { desktopDigestCachePath, markDesktopRecoveryRetry, nativeDesktopEnvironment, readDesktopRecoveryPhase, recordDesktopStartupFailure, recordDesktopUnattached, recoverNativeDesktop } from "./codex-desktop-recovery.js";
import { selectStartupCli, startupProbeArgs } from "./codex-desktop-startup.js";
import { CODEX_DESKTOP_ENTRY_NAME, ensureCodexDesktopEntry, looksLikeOrbisWrapperEntry, readWindowsCodexDesktopEntry, suspendCodexDesktopEntry } from "./codex-shim-install.js";

export { codexDesktopEndpointPath, readCodexDesktopEndpoint, type CodexDesktopEndpoint } from "./codex-desktop-endpoint.js";

export type CodexDesktopWrapper = {
  /** What Codex runs as its CLI (the Orbis launcher, not the real codex). */
  launcher: string;
  /** Node that runs the wrapper script. */
  node: string;
  /** `codex-desktop-wrapper.js`. */
  script: string;
};

/**
 * Where the staged entry lives: always outside the Host install directory, because Windows locks the
 * launcher and node for the whole Desktop session and a Host update could not replace them.
 */
export function codexWrapperRoot(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  const explicit = env.ORBIS_CODEX_WRAPPER_ROOT?.trim();
  if (explicit) return explicit;
  if (platform === "darwin") return join(homedir(), "Library", "Application Support", "Orbis", "wrapper");
  return join(env.LOCALAPPDATA ?? homedir(), "Orbis", "wrapper");
}

/** Copied-source identity (size + mtime); Windows truncates copied mtimes, so the target cannot be compared. */
type WrapperStamp = Record<string, { size: number; mtimeMs: number }>;
const WINDOWS_STUB_MARKER = "// Orbis Codex Desktop bootstrap (Windows)";
const ENDPOINT_DEFAULT = "process.env.ORBIS_CODEX_DESKTOP_ENDPOINT ??= ";

function windowsStagedWrapper(root: string): CodexDesktopWrapper {
  return {
    launcher: join(root, "bin", "codex-launcher.exe"),
    node: join(root, "node", "node.exe"),
    script: join(root, "packages", "host", "dist", "codex-desktop-wrapper.js"),
  };
}

function checkWindowsWrapperFiles(wrapper: CodexDesktopWrapper): void {
  for (const path of [wrapper.launcher, wrapper.node, wrapper.script]) {
    if (!statSync(path, { throwIfNoEntry: false })?.isFile()) throw new Error(`缺少 Codex 包装器文件：${path}`);
  }
}

/** Codex may read the staged launcher or stub while Host replaces it. */
function replaceStagedFile(path: string, content: string, mode = 0o644): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, content, { flag: "wx", mode });
    renameSync(temporary, path);
  } finally {
    try { rmSync(temporary, { force: true }); } catch { /* Preserve the original staging error. */ }
  }
}

/** Whether a path lies in a directory (absolute, separator- and case-insensitive). */
function isInsideDirectory(path: string, directory: string): boolean {
  const target = join(directory).replaceAll("/", "\\").replace(/[\\]+$/u, "").toLowerCase();
  const candidate = join(path).replaceAll("/", "\\").toLowerCase();
  return candidate === target || candidate.startsWith(`${target}\\`);
}

/**
 * Stage the entry Codex runs. Windows copies only the two files Codex keeps locked (launcher and node)
 * and writes a stub that forwards to the installed implementation; macOS generates the launcher only.
 */
export function stageCodexWrapper(wrapper: CodexDesktopWrapper, root = codexWrapperRoot(), endpointPath?: string,
  platform: NodeJS.Platform = process.platform): CodexDesktopWrapper {
  return platform === "darwin" ? stageMacCodexWrapper(wrapper, root, endpointPath) : stageWindowsCodexWrapper(wrapper, root, endpointPath);
}

function stageWindowsCodexWrapper(wrapper: CodexDesktopWrapper, root: string, endpointPath?: string): CodexDesktopWrapper {
  const staged = windowsStagedWrapper(root);
  if (isInsideDirectory(wrapper.launcher, root)) {
    // A staged launcher is a valid source for its own binaries, never for its stub.
    checkWindowsWrapperFiles(staged);
    if (!readFileSync(staged.script, "utf8").startsWith(WINDOWS_STUB_MARKER + "\n")) {
      throw new Error("Codex 包装器必须从 Host 安装目录重新暂存");
    }
    return staged;
  }
  if (isInsideDirectory(wrapper.script, root)) throw new Error("Codex 包装器不能指向自己的暂存脚本");
  const source = statSync(wrapper.script);
  if (!source.isFile()) throw new Error(`无效的 Codex 包装器脚本：${wrapper.script}`);
  const stampPath = join(root, "wrapper-stamp.json");
  let stamp: WrapperStamp = {};
  try { stamp = (JSON.parse(readFileSync(stampPath, "utf8")) as WrapperStamp | null) ?? {}; }
  catch { /* The stamp is only an optimization. */ }
  const next: WrapperStamp = {};
  const copies: ReadonlyArray<readonly [string, string, string]> = [
    ["launcher", wrapper.launcher, staged.launcher],
    ["node", wrapper.node, staged.node],
  ];
  for (const [key, from, target] of copies) {
    const info = statSync(from, { throwIfNoEntry: false });
    if (info === undefined) continue;
    const known = stamp[key];
    if (known !== undefined && known.size === info.size && known.mtimeMs === info.mtimeMs && existsSync(target)) continue;
    try {
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(from, target);
      next[key] = { size: info.size, mtimeMs: info.mtimeMs };
    } catch {
      // A running Desktop may hold the target open: keep the old copy and retry next time.
    }
  }
  const known = stamp.script;
  let currentStub: string | undefined;
  try { currentStub = readFileSync(staged.script, "utf8"); } catch { /* First staging or unreadable entry. */ }
  const stub = windowsWrapperStub(wrapper.script, endpointPath ?? savedEndpointDefault(currentStub));
  if (currentStub !== stub || known === undefined || known.size !== source.size || known.mtimeMs !== source.mtimeMs) {
    replaceStagedFile(staged.script, stub);
  }
  checkWindowsWrapperFiles(staged);
  next.script = { size: source.size, mtimeMs: source.mtimeMs };
  const merged: WrapperStamp = {};
  for (const key of ["launcher", "node", "script"] as const) {
    const entry = next[key] ?? stamp[key];
    if (entry !== undefined) merged[key] = entry;
  }
  try { writeFileSync(stampPath, JSON.stringify(merged)); }
  catch { /* Only affects whether the next staging copies again. */ }
  return staged;
}

/** Preserve the custom Host state directory when an installer refreshes an existing stub. */
function savedEndpointDefault(stub: string | undefined): string | undefined {
  const line = stub?.split(/\r?\n/u).find(value => value.startsWith(ENDPOINT_DEFAULT));
  if (!line?.endsWith(";")) return undefined;
  try {
    const value: unknown = JSON.parse(line.slice(ENDPOINT_DEFAULT.length, -1));
    return typeof value === "string" ? value : undefined;
  } catch { return undefined; }
}

/** Keep the legacy launcher filename; use only syntax valid in both CommonJS and ESM. */
function windowsWrapperStub(source: string, endpointPath?: string): string {
  return [
    WINDOWS_STUB_MARKER,
    ...(endpointPath === undefined ? [] : [`${ENDPOINT_DEFAULT}${JSON.stringify(endpointPath)};`]),
    `void import(${JSON.stringify(pathToFileURL(source).href)})`,
    "  .then(({ main }) => main(process.argv.slice(2)))",
    "  .catch(error => {",
    '    process.stderr.write(`[orbis-codex-wrapper] 无法加载 Host 包装器：${error.stack ?? error}\\n`);',
    "    process.exitCode = 127;",
    "  });",
    "",
  ].join("\n");
}

/** CODEX-DESKTOP-BOOTSTRAP-01: the installer only refreshes a previously registered staged entry. */
export async function repairWindowsCodexDesktopEntry(wrapper: CodexDesktopWrapper | undefined, root = codexWrapperRoot()): Promise<void> {
  const current = await readWindowsCodexDesktopEntry();
  if (current === undefined || resolve(current.trim()).toLowerCase() !== resolve(windowsStagedWrapper(root).launcher).toLowerCase()) return;
  try {
    if (wrapper === undefined) throw new Error("Host 安装目录缺少 Codex 包装器");
    stageCodexWrapper(wrapper, root, undefined, "win32");
  } catch (error) {
    // Do not leave the old broken override active when an upgrade cannot refresh it.
    await suspendCodexDesktopEntry(current.trim());
    throw error;
  }
}

/** macOS: one generated launcher that runs the installed wrapper and carries the Host endpoint. */
function stageMacCodexWrapper(wrapper: CodexDesktopWrapper, root: string, endpointPath?: string): CodexDesktopWrapper {
  const launcher = join(root, "bin", "codex-launcher");
  let current: string | undefined;
  try { current = readFileSync(launcher, "utf8"); } catch { /* First staging. */ }
  const endpoint = endpointPath ?? launcherEndpoint(current);
  const content = renderMacCodexLauncher({ node: wrapper.node, script: wrapper.script, ...(endpoint === undefined ? {} : { endpoint }) });
  // Unchanged content keeps its mtime: Codex may be reading it right now.
  if (current !== content) replaceStagedFile(launcher, content, 0o755);
  chmodSync(launcher, 0o755);
  // Earlier launchers executed a forwarding stub here; the launcher above no longer references it.
  try { rmSync(join(root, "packages", "host", "dist", "codex-desktop-wrapper.js"), { force: true }); } catch { /* Harmless leftover. */ }
  return { launcher, node: wrapper.node, script: wrapper.script };
}

/**
 * The wrapper ships with the Host runtime; anything missing means there is no wrapper. Environment
 * overrides exist for development and tests, but never name a staged artifact as the source.
 */
export function resolveCodexWrapper(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): CodexDesktopWrapper | undefined {
  const root = codexWrapperRoot(env, platform);
  const override = (value: string | undefined): string | undefined => {
    const path = value?.trim();
    return path && !isInsideDirectory(path, root) ? path : undefined;
  };
  const runtimeRoot = fileURLToPath(new URL("../../../", import.meta.url));
  const node = override(env.ORBIS_CODEX_WRAPPER_NODE) ?? process.execPath;
  const script = override(env.ORBIS_CODEX_WRAPPER_SCRIPT) ?? fileURLToPath(new URL("./codex-desktop-wrapper.js", import.meta.url));
  // macOS generates its launcher while staging; this is only where it will be.
  const launcher = env.ORBIS_CODEX_WRAPPER?.trim()
    || (platform === "darwin" ? join(root, "bin", "codex-launcher") : join(runtimeRoot, "bin", "codex-launcher.exe"));
  if (!existsSync(script) || (platform === "darwin" ? !existsSync(node) : !existsSync(launcher))) return undefined;
  return { launcher, node, script };
}

export type LaunchCodexDesktopOptions = { root?: string; signal?: AbortSignal };

/** The user-facing reason Codex was opened without Orbis, recorded for Host and the phone. */
class UnattachedLaunch extends Error {}

function unattachedReason(error: unknown): string {
  if (error instanceof UnattachedLaunch) return error.message;
  const cause = (error instanceof Error ? error.message : String(error)).slice(0, 120);
  return `Orbis 未能启用桌面接入（${cause}），已以原生方式打开 Codex，本次未接入。请检查 Orbis Host 安装后，完全退出 Codex 再从 Orbis 打开。`;
}

const WRAPPER_MISSING = "Orbis 安装中缺少 Codex 包装器，已以原生方式打开 Codex，本次未接入。请重新安装 Orbis Host。";

function entryRefused(detail: string): UnattachedLaunch {
  return new UnattachedLaunch(`Orbis 无法登记桌面接入入口（${detail}），已以原生方式打开 Codex，本次未接入。`);
}

/**
 * Open the registered Codex Desktop, through the wrapper when it can be prepared and registered,
 * natively otherwise. Rejects only when Codex itself cannot be opened or the launch was cancelled.
 */
export async function launchCodexDesktop(wrapper: CodexDesktopWrapper | undefined, endpointPath: string,
  options: LaunchCodexDesktopOptions = {}): Promise<void> {
  options.signal?.throwIfAborted();
  if (process.platform === "darwin") return launchMacCodexDesktop(wrapper, endpointPath, options);
  if (process.platform === "win32") return launchWindowsCodexDesktop(wrapper, endpointPath, options);
  throw new Error("Codex 桌面版只支持 Windows 与 macOS");
}

async function launchMacCodexDesktop(wrapper: CodexDesktopWrapper | undefined, endpointPath: string, { root, signal }: LaunchCodexDesktopOptions): Promise<void> {
  let failure: unknown;
  const phase = readDesktopRecoveryPhase(endpointPath);
  // These phases are cleared only by a passing preflight (or a ready bridge), never by a native open.
  const suspended = phase === "native" || phase === "failed";
  try {
    if (wrapper === undefined) throw new UnattachedLaunch(WRAPPER_MISSING);
    const staged = stageCodexWrapper(wrapper, root, endpointPath, "darwin");
    for (const [file, mode] of [[staged.launcher, constants.X_OK], [staged.node, constants.X_OK], [staged.script, constants.R_OK]] as const) {
      if (!statSync(file, { throwIfNoEntry: false })?.isFile()) throw new Error(`缺少 Codex 包装器文件：${file}`);
      accessSync(file, mode);
    }
    signal?.throwIfAborted();
    if (suspended) {
      // Re-enable the entry only when the installed Desktop's CLI answers the read-only probe.
      const { candidates } = await macDesktopCliCandidates(process.env, { launchingPid: 0 });
      signal?.throwIfAborted();
      await selectStartupCli(candidates, startupProbeArgs([]), process.env, () => {});
      signal?.throwIfAborted();
    }
    const entry = await ensureCodexDesktopEntry(staged.launcher);
    if (entry.state !== "enabled") throw entryRefused(entry.detail);
    signal?.throwIfAborted();
    // From here a fresh wrapper result, not the old record, describes this launch.
    if (phase !== undefined) {
      try { markDesktopRecoveryRetry(endpointPath); } catch { /* Diagnostics never block a launch. */ }
    }
    await launchCodexDesktopApp({ ...process.env, CODEX_CLI_PATH: staged.launcher, ORBIS_CODEX_DESKTOP_ENDPOINT: endpointPath }, signal);
    return;
  } catch (error) {
    signal?.throwIfAborted();
    failure = error;
  }

  const env = nativeDesktopEnvironment(process.env);
  const installed = await readLaunchdEnvironment(CODEX_DESKTOP_ENTRY_NAME).catch(() => undefined);
  signal?.throwIfAborted();
  // LaunchServices passes the login-session override, not our unset: neutralize only an Orbis value.
  if (installed !== undefined) {
    if (looksLikeOrbisWrapperEntry(installed)) env.CODEX_CLI_PATH = "";
    else delete env.CODEX_CLI_PATH;
  }
  try { await launchCodexDesktopApp(env, signal); }
  catch (error) {
    signal?.throwIfAborted();
    try { recordDesktopStartupFailure(endpointPath, "无法打开 Codex 桌面版，请检查桌面版安装。", `${String(failure)}\n${String(error)}`); }
    catch { /* Preserve the launch error. */ }
    throw error;
  }
  if (suspended) return;
  try { recordDesktopUnattached(endpointPath, unattachedReason(failure), failure); }
  catch { /* Codex is already open; the record is diagnostic only. */ }
}

async function launchWindowsCodexDesktop(wrapper: CodexDesktopWrapper | undefined, endpointPath: string, { root, signal }: LaunchCodexDesktopOptions): Promise<void> {
  const phase = readDesktopRecoveryPhase(endpointPath);
  const recovering = phase === "native" || phase === "retrying";
  if (recovering) {
    try {
      const candidates = await windowsDesktopCliCandidates(process.env, { parentPid: 0, digestCacheFile: desktopDigestCachePath(endpointPath) });
      signal?.throwIfAborted();
      await selectStartupCli(candidates, startupProbeArgs([]), process.env, () => {});
    } catch (error) {
      signal?.throwIfAborted();
      await recoverNativeDesktop(endpointPath, error);
      signal?.throwIfAborted();
      await launchCodexDesktopApp(nativeDesktopEnvironment(process.env), signal);
      return;
    }
  }
  signal?.throwIfAborted();
  const openNatively = async (reason: unknown): Promise<void> => {
    await launchCodexDesktopApp(process.env, signal);
    try { recordDesktopUnattached(endpointPath, unattachedReason(reason), reason); } catch { /* Diagnostic only. */ }
  };
  if (wrapper === undefined) {
    await openNatively(new UnattachedLaunch(WRAPPER_MISSING));
    return;
  }
  let staged: CodexDesktopWrapper;
  try { staged = stageCodexWrapper(wrapper, root, endpointPath, "win32"); }
  catch (error) {
    signal?.throwIfAborted();
    // Failing to record recovery must not prevent opening the native app.
    const launcher = windowsStagedWrapper(root ?? codexWrapperRoot()).launcher;
    await recoverNativeDesktop(endpointPath, error, () => suspendCodexDesktopEntry(launcher), "wrapper").catch(() => {});
    signal?.throwIfAborted();
    await launchCodexDesktopApp(nativeDesktopEnvironment(process.env), signal);
    return;
  }
  let refused: unknown;
  try {
    // Register the user entry first so Shell activation never starts an unwrapped GUI.
    const entry = await ensureCodexDesktopEntry(staged.launcher);
    signal?.throwIfAborted();
    refused = entryRefused(entry.detail);
    if (entry.state === "enabled") {
      if (recovering) markDesktopRecoveryRetry(endpointPath, "匹配 CLI 已通过启动检查，正在等待桌面接入。若 Codex 已在原生模式运行，请自行完全退出，再从 Orbis 打开；无需重启 Host。");
      await launchCodexDesktopApp({
        ...process.env,
        CODEX_CLI_PATH: staged.launcher,
        ORBIS_CODEX_WRAPPER_NODE: staged.node,
        ORBIS_CODEX_WRAPPER_SCRIPT: staged.script,
        ORBIS_CODEX_DESKTOP_ENDPOINT: endpointPath,
      }, signal);
      return;
    }
  } catch (error) {
    signal?.throwIfAborted();
    refused = error;
  }
  // A foreign or unwritable entry, or a failed wrapped activation: open Codex as the Start menu would.
  await openNatively(refused);
}

if (process.platform === "win32" && process.argv[2] === "--repair-windows-entry"
  && process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try { await repairWindowsCodexDesktopEntry(resolveCodexWrapper({}, "win32")); }
  catch (error) {
    process.stderr.write(`[orbis-codex-wrapper] 无法刷新已注册的启动入口：${String(error)}\n`);
    process.exitCode = 1;
  }
}
