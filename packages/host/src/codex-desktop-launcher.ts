/**
 * Orbis 包装器在 Host 这一侧的接线：找到它、用它拉起桌面版、读它发布的端点。
 *
 * 包装器本体是 `codex-launcher.exe` + `codex-desktop-wrapper.js`（随 Host 运行时
 * 一起分发）。桌面版只认一个「CLI 可执行文件」入口，而 `CODEX_CLI_PATH` 是进程
 * 环境变量，所以**必须由我们直接 CreateProcess 桌面版**才能生效——走 `codex://`
 * 协议激活会把环境丢掉（`codex app` 就是那条路）。
 */
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { resolveCodexDesktopExecutablePath } from "./codex-desktop-presence.js";

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
export function codexWrapperRoot(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.ORBIS_CODEX_WRAPPER_ROOT?.trim();
  if (explicit) return explicit;
  return join(env.LOCALAPPDATA ?? homedir(), "Orbis", "wrapper");
}

/**
 * 已复制过的源文件身份（大小 + mtime）。用它而不是比较目标 mtime：`utimes` 在 Windows 上
 * 会被截断到更粗的粒度，拷完再比 mtime 永远不相等，结果就是每次拉起桌面版都重拷 80MB+。
 */
type WrapperStamp = Record<string, { size: number; mtimeMs: number }>;

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
export function stageCodexWrapper(wrapper: CodexDesktopWrapper, root = codexWrapperRoot()): CodexDesktopWrapper {
  // 已经是暂存目录里的那份：再 stage 一次会把 stub 指向它自己（自引用 import → 包装器
  // 进程爆栈 → 桌面版 app-server 起不来 → 应用退到内存兜底 → “组织设置无法加载”。
  if (isInsideDirectory(wrapper.launcher, root)) return wrapper;
  const staged: CodexDesktopWrapper = {
    launcher: join(root, "bin", "codex-launcher.exe"),
    node: join(root, "node", "node.exe"),
    // 真实实现在安装目录里；这里用的是 stub 路径，供 launcher 的回退查找。
    script: join(root, "packages", "host", "dist", "codex-desktop-wrapper.js"),
  };
  const stampPath = join(root, "wrapper-stamp.json");
  let stamp: WrapperStamp = {};
  try { stamp = JSON.parse(readFileSync(stampPath, "utf8")) as WrapperStamp; }
  catch { stamp = {}; }
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
  const source = statSync(wrapper.script, { throwIfNoEntry: false });
  if (source !== undefined && !isInsideDirectory(wrapper.script, root)) {
    const known = stamp.script;
    if (known === undefined || known.size !== source.size || known.mtimeMs !== source.mtimeMs || !existsSync(staged.script)) {
      try {
        mkdirSync(dirname(staged.script), { recursive: true });
        writeFileSync(staged.script, wrapperStub(wrapper.script));
        next.script = { size: source.size, mtimeMs: source.mtimeMs };
      } catch { /* 写不了就靠 Host 传的 ORBIS_CODEX_WRAPPER_SCRIPT */ }
    } else {
      next.script = known;
    }
  }
  const merged: WrapperStamp = {};
  for (const key of ["launcher", "node", "script"] as const) {
    const entry = next[key] ?? stamp[key];
    if (entry !== undefined) merged[key] = entry;
  }
  try { writeFileSync(stampPath, JSON.stringify(merged)); }
  catch { /* 写不了只影响下次是否重拷，不影响能不能用 */ }
  return staged;
}

/** 这个路径是否落在某个目录里（都取绝对路径比较，不管结尾斜杠与大小写）。 */
function isInsideDirectory(path: string, directory: string): boolean {
  const target = join(directory).replaceAll("/", "\\").replace(/[\\]+$/u, "").toLowerCase();
  const candidate = join(path).replaceAll("/", "\\").toLowerCase();
  return candidate === target || candidate.startsWith(`${target}\\`);
}

/** 转发到安装目录里那份实现；自己跑 `main`，不依赖“模块即入口”的判定。 */
function wrapperStub(source: string): string {
  return [
    "// 由 Orbis Host 生成：真正的包装器实现住在 Host 安装目录里（只读一次，不会被锁住）。",
    `import { main } from ${JSON.stringify(pathToFileURL(source).href)};`,
    "await main(process.argv.slice(2));",
    "",
  ].join("\n");
}

/**
 * 包装器随 Host 运行时一起分发；缺任何一件就当没有包装器。
 * 环境变量只用于开发/测试时的显式覆盖。
 */
export function resolveCodexWrapper(env: NodeJS.ProcessEnv = process.env): CodexDesktopWrapper | undefined {
  const runtimeRoot = fileURLToPath(new URL("../../../", import.meta.url));
  const launcher = env.ORBIS_CODEX_WRAPPER?.trim() || join(runtimeRoot, "bin", "codex-launcher.exe");
  const node = env.ORBIS_CODEX_WRAPPER_NODE?.trim() || process.execPath;
  const script = env.ORBIS_CODEX_WRAPPER_SCRIPT?.trim() || fileURLToPath(new URL("./codex-desktop-wrapper.js", import.meta.url));
  if (!existsSync(launcher) || !existsSync(script)) return undefined;
  return { launcher, node, script };
}

/** 包装器发布端点、Host 读端点，两边靠同一个文件对齐。 */
export type CodexDesktopEndpoint = { url: string; bridgePid: number };

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
  const value = parsed as { url?: unknown; bridgePid?: unknown; schema?: unknown };
  if (value.schema !== 1 || typeof value.url !== "string" || !/^ws:\/\/127\.0\.0\.1:\d{1,5}$/.test(value.url)) return undefined;
  const bridgePid = Number(value.bridgePid);
  if (!Number.isInteger(bridgePid) || !processAlive(bridgePid)) return undefined;
  return { url: value.url, bridgePid };
}

/**
 * 带包装器环境直接拉起桌面版 GUI。
 *
 * 用的是安装目录之外的那份包装器运行时（见 `stageCodexWrapper`），所以桌面版活着的时候
 * 不会锁住 Host 安装目录里任何文件。
 *
 * 返回 `false` 时调用方应回退到 `codex app`：宁可打开一个接不上的桌面版，
 * 也不要因为包装器缺失而让用户打不开它。
 */
export async function launchCodexDesktopThroughWrapper(
  wrapper: CodexDesktopWrapper,
  endpointPath: string,
  root?: string,
): Promise<boolean> {
  let executable: string | undefined;
  try { executable = await resolveCodexDesktopExecutablePath(); }
  catch { return false; }
  if (executable === undefined) return false;
  // 两个二进制擕不过去（目标被占/权限）就用安装目录里那份现成副本：宁可暂时锁着，
  // 也不要因为“刷新失败”而不开窗。JS 一直用安装目录里的真实实现（只读一次，不会被锁）。
  const staged = stageCodexWrapper(wrapper, root);
  const effective = [staged.launcher, staged.node].every(existsSync)
    ? { launcher: staged.launcher, node: staged.node, script: wrapper.script }
    : wrapper;
  try {
    const child = spawn(executable, [], {
      detached: true,
      stdio: "ignore",
      windowsHide: false,
      cwd: homedir(),
      env: {
        ...process.env,
        CODEX_CLI_PATH: effective.launcher,
        ORBIS_CODEX_WRAPPER_NODE: effective.node,
        ORBIS_CODEX_WRAPPER_SCRIPT: effective.script,
        ORBIS_CODEX_DESKTOP_ENDPOINT: endpointPath,
      },
    });
    child.unref();
  } catch {
    return false;
  }
  return true;
}
