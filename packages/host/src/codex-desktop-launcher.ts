/**
 * Orbis 包装器在 Host 这一侧的接线：找到它、用它拉起桌面版、读它发布的端点。
 *
 * 包装器本体是 `codex-launcher.exe` + `codex-desktop-wrapper.js`（随 Host 运行时
 * 一起分发）。通过用户级 `CODEX_CLI_PATH` 接入包装器，GUI 使用 Windows 注册的
 * 应用标识启动，保留正式图标和不依赖安装版本目录的任务栏快捷方式。
 *
 * macOS 不分发 launcher：暂存时生成一段 sh 脚本（见 `renderMacCodexLauncher`），
 * 它直接用运行 Host 的那个 node 跑包装器。
 */
import { randomUUID } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { launchCodexDesktopApp } from "./codex-desktop-app.js";
import { renderMacCodexLauncher } from "./codex-desktop-macos.js";
import { ensureCodexDesktopEntry, readWindowsCodexDesktopEntry, suspendCodexDesktopEntry } from "./codex-shim-install.js";
import type { DesktopRefreshEndpoint } from "./codex-desktop-refresh-bridge.js";
import { windowsDesktopCliCandidates } from "./codex-desktop-cli.js";
import { selectStartupCli, startupProbeArgs } from "./codex-desktop-startup.js";
import { desktopDigestCachePath, markDesktopRecoveryRetry, nativeDesktopEnvironment, readDesktopRecoveryReason, recoverNativeDesktop } from "./codex-desktop-recovery.js";

export type CodexDesktopWrapper = {
  /** 桌面版要启动的 CLI（我们的包装器，不是真 codex）。 */
  launcher: string;
  /** 跑包装器脚本的 node。 */
  node: string;
  /** 包装器脚本（`codex-desktop-wrapper.js`）。 */
  script: string;
};

/** 端点描述文件的位置：Host 状态目录下的固定名字，包装器与 Host 必须一致。 */
export function codexDesktopEndpointPath(stateDir: string): string {
  return join(stateDir, "codex-desktop-endpoint.json");
}

/**
 * 包装器运行时的落地目录：**必须在 Host 安装目录之外**。
 *
 * 桌面版一启动，launcher 与 node 就整个会话期常驻，于是它们会被锁住；如果它们就住在
 * Host 的 runtime 里，Host 升级时安装器替换不掉那两个文件（用户会看到“文件被占用”）。
 */
export function codexWrapperRoot(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  const explicit = env.ORBIS_CODEX_WRAPPER_ROOT?.trim();
  if (explicit) return explicit;
  if (platform === "darwin") return join(homedir(), "Library", "Application Support", "Orbis", "wrapper");
  return join(env.LOCALAPPDATA ?? homedir(), "Orbis", "wrapper");
}

/**
 * 已复制过的源文件身份（大小 + mtime）。用它而不是比较目标 mtime：`utimes` 在 Windows 上
 * 会被截断到更粗的粒度，拷完再比 mtime 永远不相等，结果就是每次拉起桌面版都重拷 80MB+。
 */
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

/** The registered Windows launcher can read the stub concurrently with Host staging. */
function replaceWindowsStub(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, content, { flag: "wx" });
    renameSync(temporary, path);
  } finally {
    try { rmSync(temporary, { force: true }); } catch { /* Preserve the original staging error. */ }
  }
}

/**
 * 把包装器运行时搬到安装目录之外。
 *
 * 只搬**会被锁住**的那两个文件：launcher 与 node 在整个桌面版会话期间常驻（所以如果它们
 * 住在 Host 安装目录里，升级就替换不掉）；而 `codex-desktop-wrapper.js` 与它的兄弟模块只
 * 在启动时被读一次，文件并不会被持着，所以它们可以留在安装目录里，永远是最新的。
 *
 * 布局保持与打包 runtime 一致（`bin/` + `node/` + `packages/host/dist/`），并在脚本位置上
 * 放一个转发到真实实现的 stub：launcher 的“相对自身解析”回退因此仍然能用（用户自己带
 * 持久环境变量启动桌面版的场景）。
 */
export function stageCodexWrapper(wrapper: CodexDesktopWrapper, root = codexWrapperRoot(), endpointPath?: string,
  platform: NodeJS.Platform = process.platform): CodexDesktopWrapper {
  if (platform === "darwin") return stageMacCodexWrapper(wrapper, root, endpointPath);
  const staged = windowsStagedWrapper(root);
  if (isInsideDirectory(wrapper.launcher, root)) {
    // A staged launcher is also a valid source for its own binary files, never for its stub.
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
  for (const [key, source, target] of copies) {
    const from = statSync(source, { throwIfNoEntry: false });
    if (from === undefined) continue;
    const known = stamp[key];
    if (known !== undefined && known.size === from.size && known.mtimeMs === from.mtimeMs && existsSync(target)) continue;
    try {
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(source, target);
      next[key] = { size: from.size, mtimeMs: from.mtimeMs };
    } catch {
      // 目标可能正被运行中的桌面版占用：本次不记身份，下次启动再试。
    }
  }
  const known = stamp.script;
  let currentStub: string | undefined;
  try { currentStub = readFileSync(staged.script, "utf8"); } catch { /* First staging or unreadable entry. */ }
  const stub = windowsWrapperStub(wrapper.script, endpointPath ?? savedEndpointDefault(currentStub));
  if (currentStub !== stub || known === undefined || known.size !== source.size || known.mtimeMs !== source.mtimeMs) {
    replaceWindowsStub(staged.script, stub);
  }
  checkWindowsWrapperFiles(staged);
  next.script = { size: source.size, mtimeMs: source.mtimeMs };
  const merged: WrapperStamp = {};
  for (const key of ["launcher", "node", "script"] as const) {
    const entry = next[key] ?? stamp[key];
    if (entry !== undefined) merged[key] = entry;
  }
  try { writeFileSync(stampPath, JSON.stringify(merged)); }
  catch { /* 写不了只影响下次是否重拷，不影响能不能用 */ }
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

/**
 * macOS 的暂存：文件被运行中的进程打开时照样能替换，所以不复制 node，也不需要身份戳；
 * 只生成两样东西——转发到安装目录实现的 stub，以及桌面版经 `CODEX_CLI_PATH` 执行的
 * sh launcher。内容不变就不重写，避免每次拉起都改动 mtime。
 */
function stageMacCodexWrapper(wrapper: CodexDesktopWrapper, root: string, endpointPath?: string): CodexDesktopWrapper {
  const script = isInsideDirectory(wrapper.script, root) ? wrapper.script : join(root, "packages", "host", "dist", "codex-desktop-wrapper.js");
  const staged: CodexDesktopWrapper = { launcher: join(root, "bin", "codex-launcher"), node: wrapper.node, script };
  const writeIfChanged = (path: string, content: string, mode: number) => {
    let current: string | undefined;
    try { current = readFileSync(path, "utf8"); } catch { /* 首次暂存 */ }
    if (current !== content) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, content, { mode });
    }
    chmodSync(path, mode);
  };
  try {
    if (script !== wrapper.script) writeIfChanged(script, macWrapperStub(wrapper.script, endpointPath), 0o644);
    writeIfChanged(staged.launcher, renderMacCodexLauncher(staged.node, staged.script), 0o755);
  } catch {
    // 写不进去时 launcher 不存在：入口不会指向它，拉起也会回退到普通应用激活。
  }
  return staged;
}

/** 这个路径是否落在某个目录里（都取绝对路径比较，不管结尾斜杠与大小写）。 */
function isInsideDirectory(path: string, directory: string): boolean {
  const target = join(directory).replaceAll("/", "\\").replace(/[\\]+$/u, "").toLowerCase();
  const candidate = join(path).replaceAll("/", "\\").toLowerCase();
  return candidate === target || candidate.startsWith(`${target}\\`);
}

/** 转发到安装目录里那份实现；自己跑 `main`，不依赖“模块即入口”的判定。 */
function macWrapperStub(source: string, endpointPath?: string): string {
  return [
    "// 由 Orbis Host 生成：真正的包装器实现住在 Host 安装目录里（只读一次，不会被锁住）。",
    `import { main } from ${JSON.stringify(pathToFileURL(source).href)};`,
    // Shell 激活不依赖 Host 的临时环境；自定义状态目录也必须让包装器找得到。
    ...(endpointPath === undefined ? [] : [`${ENDPOINT_DEFAULT}${JSON.stringify(endpointPath)};`]),
    "await main(process.argv.slice(2));",
    "",
  ].join("\n");
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

/**
 * 包装器随 Host 运行时一起分发；缺任何一件就当没有包装器。
 * 环境变量只用于开发/测试时的显式覆盖。
 */
export function resolveCodexWrapper(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): CodexDesktopWrapper | undefined {
  const runtimeRoot = fileURLToPath(new URL("../../../", import.meta.url));
  const node = env.ORBIS_CODEX_WRAPPER_NODE?.trim() || process.execPath;
  const script = env.ORBIS_CODEX_WRAPPER_SCRIPT?.trim() || fileURLToPath(new URL("./codex-desktop-wrapper.js", import.meta.url));
  // macOS 的 launcher 在暂存时生成，这里只给出它将要在的位置。
  const launcher = env.ORBIS_CODEX_WRAPPER?.trim()
    || (platform === "darwin" ? join(codexWrapperRoot(env, platform), "bin", "codex-launcher") : join(runtimeRoot, "bin", "codex-launcher.exe"));
  if (!existsSync(script) || (platform === "darwin" ? !existsSync(node) : !existsSync(launcher))) return undefined;
  return { launcher, node, script };
}

/** 包装器发布端点、Host 读端点，两边靠同一个文件对齐。 */
export type CodexDesktopEndpoint = { url: string; bridgePid: number; refresh?: DesktopRefreshEndpoint };

function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // 权限不足说明进程还在（只是我们看不见它）；ESRCH 才是真没了。
    return (error as { code?: unknown }).code === "EPERM";
  }
}

/**
 * 读包装器发布的端点。
 *
 * 只认 `127.0.0.1` 的 ws：app-server 本来就只绑回环，把别的地址当端点等于给
 * Host 开一条通往任意地址的连接。桥接进程已经退出时也必须当作没有端点，否则
 * 会对着一个死端口反复重试，状态页会一直停在“接入失败”。
 */
export function readCodexDesktopEndpoint(path: string): CodexDesktopEndpoint | undefined {
  let text: string;
  try { text = readFileSync(path, "utf8"); }
  catch { return undefined; }
  let parsed: unknown;
  try { parsed = JSON.parse(text); }
  catch { return undefined; }
  if (parsed === null || typeof parsed !== "object") return undefined;
  const value = parsed as { url?: unknown; bridgePid?: unknown; schema?: unknown; refresh?: unknown };
  if (value.schema !== 1 || typeof value.url !== "string" || !/^ws:\/\/127\.0\.0\.1:\d{1,5}$/.test(value.url)) return undefined;
  const bridgePid = Number(value.bridgePid);
  if (!Number.isInteger(bridgePid) || !processAlive(bridgePid)) return undefined;
  const refresh = value.refresh as Partial<DesktopRefreshEndpoint> | undefined;
  if (refresh != null && typeof refresh === "object" && typeof refresh.url === "string" && /^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(refresh.url)
    && typeof refresh.token === "string" && /^[a-f0-9-]{36}$/u.test(refresh.token)
    && typeof refresh.instanceId === "string" && /^[a-f0-9-]{36}$/u.test(refresh.instanceId)) {
    return { url: value.url, bridgePid, refresh: refresh as DesktopRefreshEndpoint };
  }
  return { url: value.url, bridgePid };
}

/**
 * 准备包装器后通过 Windows 注册的应用标识打开桌面版 GUI。
 *
 * 用的是安装目录之外的那份包装器运行时（见 `stageCodexWrapper`），所以桌面版活着的时候
 * 不会锁住 Host 安装目录里任何文件。
 *
 * 返回 `false` 时调用方应回退到普通应用激活：宁可打开一个接不上的桌面版，
 * 也不要因为包装器缺失而让用户打不开它。
 */
export async function launchCodexDesktopThroughWrapper(
  wrapper: CodexDesktopWrapper,
  endpointPath: string,
  root?: string,
  signal?: AbortSignal,
): Promise<boolean> {
  signal?.throwIfAborted();
  const recovering = process.platform === "win32" && readDesktopRecoveryReason(endpointPath) !== undefined;
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
      return true;
    }
  }
  signal?.throwIfAborted();
  let staged: CodexDesktopWrapper;
  try { staged = stageCodexWrapper(wrapper, root, endpointPath); }
  catch (error) {
    if (process.platform !== "win32") return false;
    signal?.throwIfAborted();
    // Failure to record the recovery must not prevent an attempt to open the native app.
    const launcher = windowsStagedWrapper(root ?? codexWrapperRoot()).launcher;
    await recoverNativeDesktop(endpointPath, error, () => suspendCodexDesktopEntry(launcher), "wrapper").catch(() => {});
    signal?.throwIfAborted();
    await launchCodexDesktopApp(nativeDesktopEnvironment(process.env), signal);
    return true;
  }
  const effective = process.platform === "win32" || [staged.launcher, staged.node].every(existsSync) ? staged : wrapper;
  try {
    // 等待用户入口就位，避免首次打开时 Shell 先启动了未包装的 GUI。
    const entry = await ensureCodexDesktopEntry(effective.launcher);
    signal?.throwIfAborted();
    if (entry.state !== "enabled") return false;
    if (recovering) markDesktopRecoveryRetry(endpointPath);
    await launchCodexDesktopApp({
      ...process.env,
      CODEX_CLI_PATH: effective.launcher,
      ORBIS_CODEX_WRAPPER_NODE: effective.node,
      ORBIS_CODEX_WRAPPER_SCRIPT: effective.script,
      ORBIS_CODEX_DESKTOP_ENDPOINT: endpointPath,
    }, signal);
  } catch {
    signal?.throwIfAborted();
    return false;
  }
  return true;
}

if (process.platform === "win32" && process.argv[2] === "--repair-windows-entry"
  && process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try { await repairWindowsCodexDesktopEntry(resolveCodexWrapper({}, "win32")); }
  catch (error) {
    process.stderr.write(`[orbis-codex-wrapper] 无法刷新已注册的启动入口：${String(error)}\n`);
    process.exitCode = 1;
  }
}
