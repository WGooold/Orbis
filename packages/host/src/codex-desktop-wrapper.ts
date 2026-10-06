/**
 * Codex 桌面版包装器：让桌面版自己的 app-server 也能被 Orbis 接上。
 *
 * 为什么需要它：桌面版（Windows）永远用 stdio 与它自己的 `codex app-server` 说话，
 * 而那条唯一的 WebSocket/守护进程分支被 `process.platform !== "win32"` 关掉了
 * （见 ADR-0022 的 Known limitation）。于是这个进程站在中间，给同一个 app-server
 * 多开一个本地 WebSocket：
 *
 *   桌面版 GUI <--stdio--> 本进程 <--websocket--> codex app-server --listen
 *
 * GUI 的行为一点不变（它仍然走 stdio），Orbis 作为**第二个** ws 客户端接同一个
 * app-server，于是手机与桌面版看到并驱动同一批 thread。
 *
 * 入口是 `codex-launcher.exe`（桌面版不带 shell 启动 CLI，`.cmd` 不可用），
 * 它把同样的 argv 与继承来的 stdio 交给本文件。**除 `app-server` 外的任何调用
 * （`login`、`exec`、`--version` …）都原样转发**，因为桌面版也会用它们。
 *
 * 失败语义：这里只允许失败在“接不上”，不允许让桌面版用不了——任何一步出错都退回
 * 与真实 CLI 一模一样的 stdio 行为，只是这一轮没有可接入端点。
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, Socket } from "node:net";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import WebSocket from "ws";

import { resolveCodexCommand, type CodexCommand } from "./codex-daemon.js";

/** 端点描述文件：Host 每 2s 读它，所以它必须是原子、只属于当前桥接的一份。 */
export type CodexDesktopEndpointFile = {
  schema: 1;
  url: string;
  codexPid: number | undefined;
  bridgePid: number;
  startedAt: string;
};

function log(line: string): void {
  process.stderr.write(`[orbis-codex-wrapper] ${line}\n`);
}

export function endpointFilePath(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.ORBIS_CODEX_DESKTOP_ENDPOINT?.trim();
  if (explicit) return explicit;
  const stateDir = env.ORBIS_HOST_STATE_DIR?.trim() || join(homedir(), ".pi-remote");
  return join(stateDir, "codex-desktop-endpoint.json");
}

/** 桌面版是否在让它的 CLI 跑 app-server（而不是 `login`、`exec` 之类）。 */
export function isAppServerInvocation(args: readonly string[]): boolean {
  return args.includes("app-server");
}

/** The desktop CLI enables this when its app-server needs the separate code-mode host. */
export function requestsCodeModeHost(args: readonly string[]): boolean {
  return isAppServerInvocation(args) && args.some(arg => arg.replaceAll(" ", "") === "features.code_mode_host=true");
}

export type ResolveRealCodexOptions = {
  requireCodeModeHost?: boolean;
  waitMs?: number;
  pollMs?: number;
};

const DEFAULT_CODE_MODE_RUNTIME_WAIT_MS = 120_000;
const DEFAULT_CODE_MODE_RUNTIME_POLL_MS = 100;
const CODE_MODE_HOST_NAME = "codex-code-mode-host.exe";

/**
 * 真正的 CLI：Host 会把桌面版本该用的那份显式交给我们；没交就找桌面版自己下载的
 * 最新副本（`%LOCALAPPDATA%\OpenAI\Codex\bin\...`），最后才退回 PATH 上的 codex。
 *
 * Desktop can start this wrapper before its primary runtime installer has finished. When
 * code-mode is enabled, starting an older CLI during that window is not equivalent to
 * starting no CLI: the app-server comes up, but its later code-mode host spawn is doomed.
 */
export async function resolveRealCodex(
  env: NodeJS.ProcessEnv = process.env,
  options: ResolveRealCodexOptions = {},
): Promise<CodexCommand> {
  const explicit = env.ORBIS_CODEX_REAL?.trim();
  if (explicit) {
    if (!existsSync(explicit)) throw new Error(`ORBIS_CODEX_REAL 指向的文件不存在：${explicit}`);
    return { command: explicit, prefixArgs: [] };
  }

  const root = join(env.LOCALAPPDATA?.trim() || join(homedir(), "AppData", "Local"), "OpenAI", "Codex", "bin");
  const requireCodeModeHost = options.requireCodeModeHost === true;
  const waitMs = options.waitMs ?? DEFAULT_CODE_MODE_RUNTIME_WAIT_MS;
  const pollMs = options.pollMs ?? DEFAULT_CODE_MODE_RUNTIME_POLL_MS;
  const deadline = Date.now() + (requireCodeModeHost ? waitMs : 0);

  while (true) {
    const candidates = findCodexCandidates(root);
    const compatible = requireCodeModeHost
      ? candidates.filter(candidate => existsSync(join(dirname(candidate), CODE_MODE_HOST_NAME)))
      : candidates;
    const selected = newestCodex(compatible);
    if (selected !== undefined) return { command: selected, prefixArgs: [] };
    if (!requireCodeModeHost || candidates.length === 0 || Date.now() >= deadline) break;
    await delay(Math.min(pollMs, Math.max(1, deadline - Date.now())));
  }

  const fallback = newestCodex(findCodexCandidates(root));
  if (fallback !== undefined) return { command: fallback, prefixArgs: [] };
  return resolveCodexCommand(env);
}

function findCodexCandidates(root: string): string[] {
  if (!existsSync(root)) return [];
  try {
    const candidates: string[] = [];
    for (const entry of readdirSync(root)) {
      const direct = join(root, entry, "codex.exe");
      if (existsSync(direct)) candidates.push(direct);
    }
    const top = join(root, "codex.exe");
    if (existsSync(top)) candidates.push(top);
    return candidates;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
}

function newestCodex(candidates: readonly string[]): string | undefined {
  return [...candidates].sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs)[0];
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>(resolve => server.close(() => resolve()));
  return port;
}

/** 等 app-server 真的在监听：能连上才算。能 bind 这个端口恰恰说明它还没起来。 */
async function waitForPort(port: number, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const alive = await new Promise<boolean>(resolve => {
      const socket = new Socket();
      const settle = (value: boolean) => { socket.destroy(); resolve(value); };
      socket.setTimeout(500, () => settle(false));
      socket.once("connect", () => settle(true));
      socket.once("error", () => settle(false));
      socket.connect(port, "127.0.0.1");
    });
    if (alive) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`app-server 未在 ${port} 上监听`);
}

/** 原样转发：桌面版用的其他 CLI 调用（登录、exec、版本查询）不受包装器影响。 */
export function runPassthrough(codex: CodexCommand, args: readonly string[]): void {
  const child = spawn(codex.command, [...codex.prefixArgs, ...args], { stdio: "inherit", windowsHide: false });
  child.on("exit", (code, signal) => process.exit(code ?? (signal === null ? 0 : 1)));
  child.on("error", error => { log(`无法启动 ${codex.command}：${error.message}`); process.exit(127); });
}

type BridgeOptions = {
  codex: CodexCommand;
  args: readonly string[];
  endpointFile: string;
  maxPayloadBytes?: number;
};

/**
 * 给 GUI 提供 stdio，同时把同一个 app-server 暴露成一个本地 ws 端点。
 * 返回的 promise 在会话结束时 resolve（进程退出由调用方决定）。
 */
export async function runBridge({ codex, args, endpointFile, maxPayloadBytes = 64 * 1024 * 1024 }: BridgeOptions): Promise<void> {
  const port = await freePort();
  const url = `ws://127.0.0.1:${port}`;
  const child = spawn(codex.command, [...codex.prefixArgs, ...args, "--listen", url], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  child.stdout?.on("data", chunk => process.stderr.write(chunk));
  child.stderr?.on("data", chunk => process.stderr.write(chunk));
  child.on("error", error => { log(`app-server 启动失败：${error.message}`); process.exitCode = 127; });
  await waitForPort(port);
  const socket = await openSocket(url, maxPayloadBytes);
  const descriptor: CodexDesktopEndpointFile = { schema: 1, url, codexPid: child.pid, bridgePid: process.pid, startedAt: new Date().toISOString() };
  writeEndpointFile(endpointFile, descriptor);
  log(`已就绪：桌面版走 stdio，Orbis 可接 ${url}`);
  await bridgeStdio(child, socket, endpointFile, descriptor);
}

/** 读回自己发布的内容，用来判断是否需要重发。 */
function readEndpointFile(path: string): string | undefined {
  try { return readFileSync(path, "utf8"); }
  catch { return undefined; }
}

function writeEndpointFile(path: string, value: CodexDesktopEndpointFile): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    // 先写临时文件再改名：Host 每 2s 就会读一次，读到半截的 JSON 会让它误判端点消失。
    const temporary = `${path}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, path);
  } catch (error) {
    log(`无法写入端点文件（不影响桌面版使用）：${error instanceof Error ? error.message : String(error)}`);
  }
}

function clearEndpointFile(path: string): void {
  try { rmSync(path, { force: true }); } catch { /* 收尾失败不影响桌面版 */ }
}

function openSocket(url: string, maxPayload: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { maxPayload });
    socket.once("open", () => resolve(socket));
    socket.once("error", error => reject(error));
  });
}

/** GUI 的 stdio 与 app-server 的 ws 帧一一对应：两边都是「一帧一行」。 */
async function bridgeStdio(child: ChildProcess, socket: WebSocket, endpointFile: string, descriptor: CodexDesktopEndpointFile): Promise<void> {
  await new Promise<void>(resolve => {
    let pending = "";
    let finished = false;
    // 端点文件是 Host 找到我们的唯一线索：被删或被清理后就再也没人知道这个端点。
    // 定期重发（内容一致则不重写），Host 的 2s 轮询就能自愈。
    const republish = setInterval(() => {
      if (readEndpointFile(endpointFile) === JSON.stringify(descriptor, null, 2)) return;
      writeEndpointFile(endpointFile, descriptor);
    }, 5_000);
    republish.unref?.();
    const finish = () => {
      if (finished) return;
      finished = true;
      clearInterval(republish);
      clearEndpointFile(endpointFile);
      try { socket.close(); } catch { /* 已经关了 */ }
      child.kill();
      resolve();
    };

    process.stdin.setEncoding("utf8");
    process.stdin.on("data", chunk => {
      pending += chunk;
      let index = pending.indexOf("\n");
      while (index >= 0) {
        const line = pending.slice(0, index).trim();
        pending = pending.slice(index + 1);
        if (line.length > 0 && socket.readyState === socket.OPEN) socket.send(line);
        index = pending.indexOf("\n");
      }
    });
    process.stdin.on("end", () => { log("桌面版关闭了 stdio，收起桥接"); finish(); });
    socket.on("message", data => { process.stdout.write(`${data.toString()}\n`); });
    socket.on("close", () => { log("app-server 连接已关闭"); finish(); });
    socket.on("error", error => { log(`WebSocket 错误：${error.message}`); finish(); });
    child.on("exit", (code, signal) => {
      log(`app-server 退出 code=${code ?? "signal"} signal=${signal ?? "-"}`);
      process.exitCode = code ?? 0;
      finish();
    });
  });
}

/** 入口：判断这是不是 app-server 调用，失败则退回原样转发。 */
export async function main(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const endpointFile = endpointFilePath(env);
  let codex: CodexCommand;
  try {
    codex = await resolveRealCodex(env, { requireCodeModeHost: requestsCodeModeHost(argv) });
  } catch (error) {
    log(`找不到真实 Codex CLI：${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 127;
    return;
  }
  if (!isAppServerInvocation(argv)) { runPassthrough(codex, argv); return; }
  try {
    await runBridge({ codex, args: argv, endpointFile });
  } catch (error) {
    // 只失败在“接不上”：退回真实 CLI 的 stdio 行为，桌面版照常工作。
    log(`桥接启动失败，回退到真实 CLI：${error instanceof Error ? error.message : String(error)}`);
    runPassthrough(codex, argv);
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main(process.argv.slice(2));
}
