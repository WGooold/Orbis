/**
 * The Desktop bridge (ADR-0096): the GUI keeps its stdio transport while the same app-server listens on
 * a loopback WebSocket that Host joins as a second client.
 *
 *   Desktop GUI <--stdio--> bridge <--ws--> codex app-server --listen ws://127.0.0.1:<port>
 *
 * Supervision invariants (CODEX-DESKTOP-SUPERVISION-01):
 * - The backend never outlives its bridge. Every shutdown path (GUI SIGTERM/SIGHUP/SIGINT, stdin end or
 *   error, stdout EPIPE, WebSocket close, backend exit, an internal bridge error) runs one coordinator
 *   that stops the backend and escalates to SIGKILL. A synchronous `exit` hook covers anything that
 *   skips the coordinator; a bridge killed outright is covered by its lease and the reaper.
 * - The endpoint is published only after the backend answers and withdrawn only while it still names
 *   this bridge.
 * - A setup failure stops the backend before it is reported and consumes no GUI input, so the caller
 *   may fall back to native stdio without a second writer for the same threads.
 */
import { type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer, Socket } from "node:net";
import { StringDecoder } from "node:string_decoder";
import { setTimeout as delay } from "node:timers/promises";
import WebSocket from "ws";

import { CodexAppServer } from "./codex-daemon.js";
import { DESKTOP_BACKEND_MARKER, DESKTOP_ENDPOINT_MARKER, recordBackendLease, releaseBackendLease } from "./codex-desktop-backends.js";
import type { DesktopCli } from "./codex-desktop-cli.js";
import { endpointRecordLive, publishEndpoint, readEndpointRecord, sameBridge, withdrawEndpoint, type CodexDesktopEndpointRecord } from "./codex-desktop-endpoint.js";
import { clearDesktopRecovery } from "./codex-desktop-recovery.js";
import { CodexDesktopRefreshBridge } from "./codex-desktop-refresh-bridge.js";
import { startDesktopCli } from "./codex-desktop-startup.js";

/** The backend was stopped before this was thrown, and no GUI input was read. */
export class DesktopBridgeSetupError extends Error {
  /** The CLI could not exec (126/127 before listening): try another candidate rather than native stdio. */
  readonly cliUnavailable: boolean;
  constructor(message: string, options: { cause?: unknown; cliUnavailable?: boolean } = {}) {
    super(message, { cause: options.cause });
    this.cliUnavailable = options.cliUnavailable ?? false;
  }
}

export type BridgeOptions = {
  codex: DesktopCli;
  args: readonly string[];
  endpointFile: string;
  env?: NodeJS.ProcessEnv;
  maxPayloadBytes?: number;
  /** The GUI transport; the wrapper process's stdio by default. */
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  /** Install signal and uncaught-error handlers on this process (the real wrapper does). */
  processEvents?: boolean;
  listenTimeoutMs?: number;
  stopGraceMs?: number;
  republishIntervalMs?: number;
  log?: (line: string) => void;
};

const SIGNAL_EXIT: Partial<Record<NodeJS.Signals, number>> = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 };

function exitCodeOf(code: number | null, signal: NodeJS.Signals | null): number {
  if (code !== null) return code;
  return signal === null ? 1 : SIGNAL_EXIT[signal] ?? 137;
}

/** One backend process and its termination, observable from any shutdown path. */
class Backend {
  readonly child: ChildProcess;
  readonly exited: Promise<void>;
  #status: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  #stoppedByBridge = false;
  readonly #exitHook = (): void => { if (this.running) { try { this.child.kill("SIGKILL"); } catch { /* already gone */ } } };

  constructor(child: ChildProcess) {
    this.child = child;
    process.on("exit", this.#exitHook);
    this.exited = new Promise(resolve => {
      const done = (code: number | null, signal: NodeJS.Signals | null) => {
        this.#status ??= { code, signal };
        process.off("exit", this.#exitHook);
        resolve();
      };
      if (child.exitCode !== null || child.signalCode !== null) done(child.exitCode, child.signalCode);
      else child.once("exit", done);
    });
  }

  get running(): boolean { return this.#status === undefined && this.child.exitCode === null && this.child.signalCode === null; }
  /** Set only when the backend ended by itself, not because the bridge stopped it. */
  get ownExit(): number | undefined { return this.#status !== undefined && !this.#stoppedByBridge ? exitCodeOf(this.#status.code, this.#status.signal) : undefined; }
  get exitCode(): number | null | undefined { return this.#status?.code; }

  /**
   * `pendingExitMs`: when the backend side closed first, its own exit is usually already in flight; the
   * WebSocket close can arrive before the child's exit event. Wait for it so its status is not lost.
   */
  async stop(graceMs: number, pendingExitMs = 0): Promise<boolean> {
    const settled = (ms: number) => Promise.race([this.exited.then(() => true), delay(ms).then(() => false)]);
    if (!this.running || pendingExitMs > 0 && await settled(pendingExitMs)) return true;
    this.#stoppedByBridge = true;
    try { this.child.kill("SIGTERM"); } catch { /* exited meanwhile */ }
    if (await settled(graceMs)) return true;
    try { this.child.kill("SIGKILL"); } catch { /* exited meanwhile */ }
    return settled(2_000);
  }
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const port = (server.address() as { port: number }).port;
  await new Promise<void>(resolve => server.close(() => resolve()));
  return port;
}

/** Listening means a connection succeeds; being able to bind the port proves the opposite. */
async function waitForPort(port: number, backend: Backend, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!backend.running) throw new Error(`app-server 在监听前退出（code=${backend.exitCode ?? "signal"}）`);
    const listening = await new Promise<boolean>(resolve => {
      const socket = new Socket();
      const settle = (value: boolean) => { socket.destroy(); resolve(value); };
      socket.setTimeout(500, () => settle(false));
      socket.once("connect", () => settle(true));
      socket.once("error", () => settle(false));
      socket.connect(port, "127.0.0.1");
    });
    if (listening) return;
    await delay(100);
  }
  throw new Error(`app-server 未在 ${port} 上监听`);
}

function openSocket(url: string, maxPayload: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { maxPayload, handshakeTimeout: 5_000 });
    socket.once("open", () => { socket.off("error", reject); resolve(socket); });
    socket.once("error", reject);
  });
}

/**
 * Run one bridge session and resolve with the wrapper's exit code. Rejects with
 * `DesktopBridgeSetupError` before the GUI transport is touched, or with the spawn error of a CLI the
 * OS could not start.
 */
export async function runBridge(options: BridgeOptions): Promise<number> {
  const log = options.log ?? ((line: string) => { process.stderr.write(`[orbis-codex-wrapper] ${line}\n`); });
  const { endpointFile } = options;
  const instanceId = randomUUID();
  let port: number;
  try { port = await freePort(); }
  catch (error) { throw new DesktopBridgeSetupError(`无法分配本地端口：${String(error)}`, { cause: error }); }
  const url = `ws://127.0.0.1:${port}`;
  // Codex may stop the transport while the bridge is still starting. The default signal action would
  // exit without running any exit hook; the backend has served nobody yet, so stop it at once.
  const processEvents = options.processEvents ?? true;
  let spawned: ChildProcess | undefined;
  const onSetupSignal = (signal: NodeJS.Signals): void => {
    log(`启动期间收到 ${signal}，结束后端并退出`);
    try { spawned?.kill("SIGKILL"); } catch { /* already gone */ }
    releaseBackendLease(endpointFile, instanceId);
    process.exit(SIGNAL_EXIT[signal] ?? 1);
  };
  const setupSignals = ["SIGTERM", "SIGINT", "SIGHUP"] as const;
  if (processEvents) for (const signal of setupSignals) process.on(signal, onSetupSignal);
  const endSetup = (): void => { if (processEvents) for (const signal of setupSignals) process.off(signal, onSetupSignal); };
  // Both markers let a later reaper prove this backend belongs to this Host's Desktop wrapper.
  const env = { ...(options.env ?? process.env), [DESKTOP_ENDPOINT_MARKER]: endpointFile, [DESKTOP_BACKEND_MARKER]: instanceId };
  let started: Awaited<ReturnType<typeof startDesktopCli>>;
  try { started = await startDesktopCli(options.codex, [...options.args, "--listen", url], { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true }); }
  catch (error) { endSetup(); throw error; }
  spawned = started.child;
  const backend = new Backend(started.child);
  // The backend's own logs reach the GUI's stderr exactly as they would natively.
  started.child.stdout?.on("data", (chunk: Buffer) => { process.stderr.write(chunk); });
  started.child.stderr?.on("data", (chunk: Buffer) => { process.stderr.write(chunk); });
  const startedAt = new Date().toISOString();
  if (started.child.pid !== undefined) {
    try { recordBackendLease(endpointFile, { schema: 1, instanceId, codexPid: started.child.pid, bridgePid: process.pid, url, startedAt }); }
    catch (error) { log(`无法记录后端租约（退出路径仍会结束它）：${String(error)}`); }
  }
  const release = async (pendingExitMs = 0): Promise<void> => {
    if (await backend.stop(options.stopGraceMs ?? 3_000, pendingExitMs)) releaseBackendLease(endpointFile, instanceId);
    else log(`app-server pid=${started.child.pid} 未能结束，保留租约供回收`);
  };
  let socket: WebSocket;
  try {
    await waitForPort(port, backend, options.listenTimeoutMs ?? 15_000);
    socket = await openSocket(url, options.maxPayloadBytes ?? 64 * 1024 * 1024);
  } catch (error) {
    endSetup();
    const code = backend.exitCode;
    // Never hand the GUI to native stdio while a listening backend may still own its threads.
    await release();
    throw new DesktopBridgeSetupError(error instanceof Error ? error.message : String(error), { cause: error, cliUnavailable: code === 126 || code === 127 });
  }

  const descriptor: CodexDesktopEndpointRecord = { schema: 1, url, codexPid: started.child.pid, bridgePid: process.pid, startedAt, instanceId };
  let refresh: CodexDesktopRefreshBridge | undefined;
  let control: CodexAppServer | undefined;
  try {
    control = await CodexAppServer.createExternal({ endpoint: url, clientName: "orbis-desktop-refresh" });
    const server = control;
    refresh = new CodexDesktopRefreshBridge((method, params) => server.request(method, params, 0));
    descriptor.refresh = await refresh.listen();
  } catch (error) {
    refresh?.close();
    await control?.stop().catch(() => {});
    refresh = undefined; control = undefined;
    log(`桌面刷新控制不可用，仍保留桥接：${error instanceof Error ? error.message : String(error)}`);
  }
  // pump installs its own handlers synchronously, so no signal falls between the two.
  endSetup();
  return pump({ ...options, log, backend, socket, descriptor, refresh, control, release });
}

type PumpContext = BridgeOptions & {
  log: (line: string) => void;
  backend: Backend;
  socket: WebSocket;
  descriptor: CodexDesktopEndpointRecord;
  refresh: CodexDesktopRefreshBridge | undefined;
  control: CodexAppServer | undefined;
  release: (pendingExitMs?: number) => Promise<void>;
};

/** Frames are one JSON message per line on stdio and one message per WebSocket frame. */
function pump(context: PumpContext): Promise<number> {
  const { backend, socket, descriptor, refresh, endpointFile, log } = context;
  const input = context.input ?? process.stdin;
  const output = context.output ?? process.stdout;
  const processEvents = context.processEvents ?? true;

  return new Promise<number>(resolve => {
    let stopping = false;
    let pending = "";
    const decoder = new StringDecoder("utf8");

    const publish = (): void => {
      try {
        publishEndpoint(endpointFile, descriptor);
        clearDesktopRecovery(endpointFile);
      } catch (error) { log(`无法写入端点文件（不影响桌面版使用）：${String(error)}`); }
    };
    // Host finds the bridge only through this file; restore it if it was removed, unless a newer live
    // bridge has replaced it.
    const republish = setInterval(() => {
      const current = readEndpointRecord(endpointFile);
      if (current !== undefined && (sameBridge(current, descriptor) || endpointRecordLive(current))) return;
      publish();
    }, context.republishIntervalMs ?? 5_000);
    republish.unref();

    const onData = (chunk: Buffer | string): void => {
      pending += typeof chunk === "string" ? chunk : decoder.write(chunk);
      for (let index = pending.indexOf("\n"); index >= 0; index = pending.indexOf("\n")) {
        const line = pending.slice(0, index).trim();
        pending = pending.slice(index + 1);
        if (line.length > 0 && socket.readyState === WebSocket.OPEN) { refresh?.guiRequest(line); socket.send(line); }
      }
    };
    const onMessage = (data: WebSocket.RawData): void => {
      if (stopping) return;
      const line = data.toString();
      const flushed = output.write(`${line}\n`, error => {
        if (error == null) refresh?.guiResponse(line);
        else shutdown(`写回桌面版失败：${error.message}`, 0);
      });
      // Respect the GUI pipe instead of buffering an unbounded transcript in this process.
      if (!flushed && !stopping) {
        socket.pause();
        output.once("drain", () => { if (!stopping) socket.resume(); });
      }
    };
    const onSignal = (signal: NodeJS.Signals): void => shutdown(`收到 ${signal}，收起桥接`, SIGNAL_EXIT[signal] ?? 1);
    const onFatal = (error: unknown): void => shutdown(`包装器内部错误：${error instanceof Error ? error.stack ?? error.message : String(error)}`, 70);
    const onInputEnd = (): void => shutdown("桌面版关闭了 stdio，收起桥接", 0);
    const onInputError = (error: Error): void => shutdown(`桌面版 stdio 错误：${error.message}`, 0);
    const onOutputError = (error: Error): void => shutdown(`桌面版输出管道已关闭：${error.message}`, 0);
    const onSocketClose = (): void => shutdown("app-server 连接已关闭", 1, true);
    const onSocketError = (error: Error): void => shutdown(`WebSocket 错误：${error.message}`, 1, true);
    const signals = ["SIGTERM", "SIGINT", "SIGHUP"] as const;

    /** `backendSide`: the backend closed first, so let its own exit status arrive before stopping it. */
    function shutdown(reason: string, code: number, backendSide = false): void {
      if (stopping) return;
      stopping = true;
      log(reason);
      clearInterval(republish);
      input.off("data", onData); input.off("end", onInputEnd); input.off("error", onInputError);
      input.pause();
      socket.off("message", onMessage); socket.off("close", onSocketClose);
      withdrawEndpoint(endpointFile, descriptor);
      void (async () => {
        try {
          refresh?.close();
          try { socket.terminate(); } catch { /* already closed */ }
          await context.control?.stop().catch(() => {});
          await context.release(backendSide ? 1_000 : 0);
        } catch (error) {
          log(`收尾失败：${String(error)}`);
        } finally {
          if (processEvents) {
            for (const signal of signals) process.off(signal, onSignal);
            process.off("uncaughtException", onFatal);
            process.off("unhandledRejection", onFatal);
          }
          // onOutputError stays attached: a late EPIPE from a write already in flight must not crash.
          // A backend that ended by itself reports its own status to the GUI.
          resolve(backend.ownExit ?? code);
        }
      })();
    }

    if (processEvents) {
      for (const signal of signals) process.on(signal, onSignal);
      process.on("uncaughtException", onFatal);
      process.on("unhandledRejection", onFatal);
    }
    output.on("error", onOutputError);
    socket.on("message", onMessage);
    socket.on("close", onSocketClose);
    socket.on("error", onSocketError);
    void backend.exited.then(() => shutdown(`app-server 已退出（code=${backend.exitCode ?? "signal"}）`, 1));
    input.on("data", onData);
    input.on("end", onInputEnd);
    input.on("error", onInputError);
    if ("readableEnded" in input && (input as { readableEnded?: boolean }).readableEnded) { onInputEnd(); return; }
    if (socket.readyState !== WebSocket.OPEN) { onSocketClose(); return; }
    if (!backend.running) { shutdown("app-server 在就绪前退出", 1); return; }
    publish();
    log(`已就绪：桌面版走 stdio，Orbis 可接 ${descriptor.url}`);
  });
}
