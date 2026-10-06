/**
 * Codex app-server 的 JSON-RPC 客户端（spec §7.4 的 M4 接入）。
 *
 * 设计要点与坑：
 * - **终端 backend 传输走 WebSocket**：`codex app-server --listen ws://127.0.0.1:<port>`
 *   会**取代** stdio（实测 stdio 上不再有任何 JSON-RPC 帧）。开 listen 是有意的——
 *   只有这样官方 TUI 才能 `codex resume <id> --remote ws://…` attach 上来，与手机
 *   订阅**同一个内存里的 thread**（双同步的关键，spec §7.4）。
 * - Desktop mode uses `codex app-server proxy` to join an existing daemon through
 *   its control socket. The proxy's official stdio stream carries newline-delimited
 *   JSON frames. The Host owns only the proxy connection, never the daemon.
 * - `.cmd` 禁令：Windows 上全局安装的 `codex` 是 `.cmd`，spawn 必须经 shell；所以和
 *   pi 一样定位 JS 入口用 node 直接拉（见 `resolveCodexCommand`）。
 * - 线格式是**不带 `jsonrpc:"2.0"` 键**的 JSON-RPC：请求 `{id, method, params}`、
 *   响应 `{id, result|error}`、通知 `{method, params}`；服务端请求带 id，需要回帧。
 * - 握手：`initialize`（clientInfo）→ 通知 `initialized`。之后 thread/*、turn/* 才可用。
 * - 服务端请求（审批等）不回会**挂死当前 turn**（spec §7.4），所以 onServerRequest
 *   必须由上层保证响应；这里只负责把响应帧送回去。
 * - 就绪判定：app-server 就绪后 stderr 打 banner 并提供 `healthz` HTTP 端点，
 *   轮询到 200 才连 WebSocket，避免连接被拒。
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type AddressInfo } from "node:net";
import { platform } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import WebSocket from "ws";

import { resolveNodePackageCli } from "./spawner.js";
import { readCodexSelection } from "./codex-selection.js";

export const CODEX_RUNTIME_ID = "codex";
export const CODEX_DESKTOP_RUNTIME_ID = "codex-desktop";

/**
 * 这条连接是不是「桌面版那条后端」：官方 proxy（`desktop`）与 Orbis 包装器给的外部端点
 * （`external`）都是桌面版自己的 app-server，于是命名空间、桌面 thread 发现、headless
 * 拉起这些语义对两者完全一样。只有它才用 `codex-desktop:` 前缀。
 */
export function isDesktopAppServer(server: { mode: CodexAppServer["mode"] }): boolean {
  return server.mode === "desktop" || server.mode === "external";
}

/** 一条服务端 → 客户端的请求（审批等）。`respond` / `fail` 只生效一次。 */
export type CodexServerRequest = {
  id: string | number;
  method: string;
  params: unknown;
  respond: (result: unknown) => void;
  fail: (message: string) => void;
};

/**
 * JSON-RPC 的底层传输。终端 backend 生产是 WebSocket（一帧一条消息），桌面
 * proxy 生产是 stdio 行协议；测试可注入假传输。
 * 文本容忍一帧多行（按行拆分解析），与旧 stdio 行协议兼容。
 */
export type CodexTransport = {
  send: (text: string) => void;
  close: () => Promise<void>;
  onMessage: (handler: (text: string) => void) => void;
  onClose: (handler: (code: number | null) => void) => void;
};

export type CodexAppServerOptions = {
  /**
   * `owned` = 自己 spawn 一个 app-server；`desktop` = 用官方 proxy 接桌面版守护进程；
   * `external` = 接一个已经在跑的 ws 端点（`endpoint` 必填），自己不拥有任何进程。
   */
  mode?: "owned" | "desktop" | "external";
  /** `external` 模式下要接的 WebSocket 端点。 */
  endpoint?: string;
  /**
   * 注入传输（测试）：提供后**不 spawn 子进程、不探测 healthz**。
   * 缺省 spawn `codex app-server --listen ws://127.0.0.1:<空闲端口>` 并连上它。
   */
  transportImpl?: () => Promise<CodexTransport>;
  /** 测试注入 endpoint 文案；只影响 `endpoint` 的返回值。 */
  endpointOverride?: string;
  /** 直接注入子进程（测试/特殊场景）；缺省按 `resolveCodexCommand` spawn 真进程。 */
  spawnImpl?: (command: string, args: readonly string[]) => ChildProcess;
  /** 禁用 AppServer 的实验性 API 之外的默认值；当前只传 clientInfo。 */
  clientName?: string;
  requestTimeoutMs?: number;
  log?: (line: string) => void;
  onNotification?: (method: string, params: unknown) => void;
  onServerRequest?: (request: CodexServerRequest) => void;
  onExit?: (code: number | null) => void;
};

type PendingRequest = {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout | undefined;
};

export class CodexAppServer {
  readonly #options: CodexAppServerOptions;
  readonly #pending = new Map<string | number, PendingRequest>();
  #child: ChildProcess | undefined;
  #transport: CodexTransport | undefined;
  #endpoint: string | undefined;
  #codexCommand: CodexCommand | undefined;
  #nextId = 0;
  #stopped = false;
  #closed = false;
  /** 上层（CodexRuntime）接管后替换；缺省落到 options 里的同名回调。 */
  onNotification: ((method: string, params: unknown) => void) | undefined;
  onServerRequest: ((request: CodexServerRequest) => void) | undefined;
  onExit: ((code: number | null) => void) | undefined;
  onDiagnostic: ((message: string) => void) | undefined;

  private constructor(options: CodexAppServerOptions) {
    this.#options = options;
    // `external` 用的是别人给的端点：不是自己选的端口，更不该被“owned 的占位端口”盖掉。
    this.#endpoint = options.endpointOverride
      ?? (options.mode === "external" ? options.endpoint : options.mode === "desktop" ? undefined : "ws://127.0.0.1:0");
  }

  /** TUI attach 用的端点：`codex resume <id> --remote <endpoint>`。 */
  get endpoint(): string | undefined {
    return this.#endpoint;
  }

  get mode(): "owned" | "desktop" | "external" {
    return this.#options.mode ?? "owned";
  }

  /** Exact CLI entry used by the app-server, for TUI attach on Windows. */
  get codexCommand(): CodexCommand | undefined {
    return this.#codexCommand;
  }

  /**
   * 启动 app-server 子进程（带 ws listen）并完成 `initialize` 握手。
   * 握手失败（codex 未安装、版本太旧）直接抛错，让上层决定是否降级为「无 Codex」。
   */
  static async create(options: CodexAppServerOptions = {}): Promise<CodexAppServer> {
    const server = new CodexAppServer(options);
    const timeoutMs = options.requestTimeoutMs ?? 30_000;
    try {
      if (options.transportImpl !== undefined) {
        server.#transport = await options.transportImpl();
      } else if (options.mode === "external") {
        if (options.endpoint === undefined || options.endpoint.length === 0) throw new Error("external app-server 缺少端点");
        server.#transport = await wsTransport(options.endpoint, timeoutMs);
      } else if (options.mode === "desktop") {
        server.#transport = await desktopTransport(options);
      } else {
        const { command, prefixArgs } = await resolveCodexCommand();
        server.#codexCommand = { command, prefixArgs: [...prefixArgs] };
        const port = await freePort();
        server.#endpoint = `ws://127.0.0.1:${port}`;
        const spawnFn = options.spawnImpl ?? ((cmd: string, args: readonly string[]) =>
          spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true }));
        const child = spawnFn(command, [...prefixArgs, "app-server", "--listen", server.#endpoint]);
        server.#child = child;
        server.#attachChildLogging(child);
        await waitHealthz(port, timeoutMs);
        server.#transport = await wsTransport(server.#endpoint, timeoutMs);
      }
      server.#attachTransport();
      await server.request("initialize", {
        capabilities: { experimentalApi: true },
        clientInfo: {
          name: options.clientName ?? "pi-remote-host",
          title: "Orbis Host",
          version: "0.1.0",
        },
      }, timeoutMs);
      server.notify("initialized");
      return server;
    } catch (error) {
      await server.stop();
      throw error;
    }
  }

  static async createDesktop(options: CodexAppServerOptions = {}): Promise<CodexAppServer> {
    const desktop = await CodexAppServer.create({ ...options, mode: "desktop", requestTimeoutMs: 4_000 });
    try {
      await desktop.request("thread/loaded/list", {}, 4_000);
      return desktop;
    } catch (error) {
      await desktop.stop();
      throw error;
    }
  }

  /**
   * 接一个别人已经在跑的 app-server（桌面版包装器开的 `--listen` 端点）。
   *
   * 与 `createDesktop` 一样，只有 `initialize` 与 `thread/loaded/list` 都成功才算接上：
   * 端口开着但不是一个能用的 app-server，不能算接入成功。
   */
  static async createExternal(options: CodexAppServerOptions & { endpoint: string }): Promise<CodexAppServer> {
    const external = await CodexAppServer.create({ ...options, mode: "external", requestTimeoutMs: options.requestTimeoutMs ?? 8_000 });
    try {
      await external.request("thread/loaded/list", {}, 8_000);
      return external;
    } catch (error) {
      await external.stop();
      throw error;
    }
  }

  /** 自有终端 app-server 的 RPC 走 WS；其 stdout/stderr 只当日志看。 */
  #attachChildLogging(child: ChildProcess): void {
    (child.stderr ?? process.stdin).on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8").trim();
      if (text.length > 0) this.#options.log?.(`[codex] ${text.slice(0, 500)}`);
      if (/windows sandbox|setup refresh had errors|helper_unknown_error/i.test(text)) this.onDiagnostic?.(text);
    });
    (child.stdout ?? process.stdin).on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8").trim();
      if (text.length > 0) this.#options.log?.(`[codex:out] ${text.slice(0, 300)}`);
    });
    child.on("exit", (code) => {
      if (this.#closed) return;
      this.#handleClosed(code);
    });
  }

  #attachTransport(): void {
    const transport = this.#requireTransport();
    transport.onMessage((text) => {
      // WS 正常一帧一条消息；容错按行拆，兼容粘行。
      for (const line of text.split("\n")) {
        const trimmed = line.trim();
        if (trimmed.length === 0) continue;
        let message: Record<string, unknown>;
        try {
          message = JSON.parse(trimmed) as Record<string, unknown>;
        } catch {
          this.#options.log?.(`app-server 输出不是 JSON，已忽略：${trimmed.slice(0, 200)}`);
          continue;
        }
        this.#dispatch(message);
      }
    });
    transport.onClose((code) => {
      if (this.#closed) return;
      this.#handleClosed(code ?? null);
    });
  }

  #handleClosed(code: number | null): void {
    this.#closed = true;
    this.#rejectAll(new Error(`codex app-server 已退出（code=${code ?? "signal"}）`));
    if (!this.#stopped) (this.onExit ?? this.#options.onExit)?.(code);
  }

  #dispatch(message: Record<string, unknown>): void {
    const id = message.id;
    if (id !== undefined && id !== null) {
      // 带 id 的两种可能：对我们请求的响应，或服务端发来的请求。
      // Request IDs belong to each direction independently. A server request can reuse an
      // outstanding client request's numeric ID; inspect the frame type before correlating it.
      if (typeof message.method === "string") {
        let answered = false;
        const reply = (frame: Record<string, unknown>) => {
          if (answered || this.#closed) return;
          this.#send(frame);
          answered = true;
        };
        const handler = this.onServerRequest ?? this.#options.onServerRequest;
        if (handler === undefined) {
          reply({ id, error: { code: -32601, message: `Unsupported server request: ${message.method}` } });
        } else {
          handler({ id: id as string | number, method: message.method, params: message.params,
            respond: (result) => reply({ id, result }),
            fail: (errorMessage) => reply({ id, error: { code: -32000, message: errorMessage } }),
          });
        }
        return;
      }
      const pending = this.#pending.get(id as string | number);
      if (pending !== undefined) {
        this.#pending.delete(id as string | number);
        if (pending.timer !== undefined) clearTimeout(pending.timer);
        if (message.error !== undefined && message.error !== null) {
          pending.reject(new Error(describeJsonRpcError(message.error)));
        } else {
          pending.resolve(message.result);
        }
        return;
      }
      return;
    }
    if (typeof message.method === "string") {
      (this.onNotification ?? this.#options.onNotification)?.(message.method, message.params);
    }
  }

  request(method: string, params?: unknown, timeoutMs = 30_000): Promise<unknown> {
    this.#requireTransport();
    const id = ++this.#nextId;
    return new Promise((resolve, reject) => {
      const timer = timeoutMs > 0
        ? setTimeout(() => {
          this.#pending.delete(id);
          reject(new Error(`app-server 请求 ${method} 超时（${timeoutMs}ms）`));
        }, timeoutMs)
        : undefined;
      this.#pending.set(id, { resolve, reject, timer });
      this.#send({ id, method, ...(params === undefined ? {} : { params }) });
    });
  }

  notify(method: string, params?: unknown): void {
    this.#send({ method, ...(params === undefined ? {} : { params }) });
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    this.#rejectAll(new Error("codex app-server 已被关闭"));
    const transport = this.#transport;
    const child = this.#child;
    this.#transport = undefined;
    this.#child = undefined;
    if (transport !== undefined) {
      try {
        await transport.close();
      } catch {
        // 关闭失败不影响收尾。
      }
    }
    if (child === undefined) return;
    await new Promise<void>((resolve) => {
      child.once("exit", () => resolve());
      child.kill();
      // Windows 上 kill 后事件可能不触发兜底；给进程 1s 自行退出。
      setTimeout(resolve, 1_000).unref();
    });
  }

  #requireTransport(): CodexTransport {
    if (this.#transport === undefined) throw new Error("codex app-server 未启动或已退出");
    return this.#transport;
  }

  #send(frame: Record<string, unknown>): void {
    if (this.#closed) return;
    try {
      this.#requireTransport().send(JSON.stringify(frame));
    } catch (error) {
      // 发送失败通常意味着连接已断；统一走关闭路径，让在途请求立刻 reject。
      this.#handleClosed(null);
      this.#options.log?.(`发往 app-server 的帧发送失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  #rejectAll(error: Error): void {
    for (const pending of this.#pending.values()) {
      if (pending.timer !== undefined) clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
  }
}

/** 借一个当前空闲的 TCP 端口（有微小竞态，可接受；app-server 抢不到会自己报错）。 */
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

/** app-server 就绪后提供 /healthz；轮询到 200 为止。 */
async function waitHealthz(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = "";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (response.ok) return;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await delay(150);
  }
  throw new Error(`codex app-server 的 healthz 一直未就绪（${lastError}）`);
}

function wsTransport(url: string, timeoutMs: number): Promise<CodexTransport> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const socket = new WebSocket(url);
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        socket.close();
      } catch {
        // 尚未建立时的 close 报错可忽略。
      }
      reject(new Error(`连接 app-server WebSocket 超时（${url}）`));
    }, timeoutMs).unref();
    socket.addEventListener("open", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(makeTransport(socket));
    });
    socket.addEventListener("error", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`连接 app-server WebSocket 失败（${url}）`));
    });
  });
}

async function desktopTransport(options: CodexAppServerOptions): Promise<CodexTransport> {
  const { command, prefixArgs } = await resolveCodexCommand();
  const child = (options.spawnImpl ?? ((cmd, args) => spawn(cmd, args, {
    stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
  })))(command, [...prefixArgs, "app-server", "proxy"]);
  const stdin = child.stdin;
  const stdout = child.stdout;
  if (stdin === null || stdout === null) {
    child.kill();
    throw new Error("Codex desktop proxy 未提供 stdio 通道");
  }
  child.stderr?.on("data", (chunk: Buffer) => options.log?.(`[codex:proxy] ${chunk.toString("utf8").trim().slice(0, 300)}`));

  // `codex app-server proxy` is the official stdio bridge to the desktop
  // daemon. It forwards the app-server's newline-delimited JSON frames; it
  // does not speak WebSocket on its stdio streams.
  const messageHandlers: Array<(text: string) => void> = [];
  const closeHandlers: Array<(code: number | null) => void> = [];
  let buffer = "";
  let closed = false;
  const emitClose = (code: number | null): void => {
    if (closed) return;
    closed = true;
    const trailing = buffer.trim();
    buffer = "";
    if (trailing.length > 0) for (const handler of [...messageHandlers]) handler(trailing);
    for (const handler of [...closeHandlers]) handler(code);
  };
  stdout.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line.length > 0) for (const handler of [...messageHandlers]) handler(line);
      newline = buffer.indexOf("\n");
    }
  });
  child.on("error", error => {
    options.log?.(`Codex desktop proxy 进程错误：${error.message}`);
    emitClose(null);
  });
  child.on("exit", code => emitClose(code));

  return {
    send: text => {
      if (closed || stdin.destroyed) throw new Error("Codex desktop proxy 已关闭");
      stdin.write(`${text}\n`);
    },
    close: async () => {
      if (closed) return;
      try { stdin.end(); } catch { /* 进程可能已先退出。 */ }
      if (child.exitCode === null) child.kill();
      await new Promise<void>(resolve => {
        if (child.exitCode !== null) { resolve(); return; }
        child.once("exit", () => resolve());
        setTimeout(resolve, 1_000).unref();
      });
    },
    onMessage: handler => messageHandlers.push(handler),
    onClose: handler => closeHandlers.push(handler),
  };
}

function makeTransport(socket: WebSocket): CodexTransport {
  const messageHandlers: Array<(text: string) => void> = [];
  const closeHandlers: Array<(code: number | null) => void> = [];
  socket.addEventListener("message", (event) => {
    const text = typeof event.data === "string" ? event.data : String(event.data);
    for (const handler of [...messageHandlers]) handler(text);
  });
  socket.addEventListener("close", (event) => {
    const code = typeof event.code === "number" ? event.code : null;
    for (const handler of [...closeHandlers]) handler(code);
  });
  return {
    send: (text) => {
      if (socket.readyState !== socket.OPEN) throw new Error("codex app-server 的 WebSocket 已关闭");
      socket.send(text);
    },
    close: () =>
      new Promise<void>((resolve) => {
        if (socket.readyState === socket.CLOSED) {
          resolve();
          return;
        }
        socket.addEventListener("close", () => resolve(), { once: true });
        try {
          socket.close();
        } catch {
          resolve();
        }
      }),
    onMessage: (handler) => messageHandlers.push(handler),
    onClose: (handler) => closeHandlers.push(handler),
  };
}

export type CodexCommand = {
  command: string;
  prefixArgs: string[];
};

/**
 * 解析 `codex` 的启动命令（与 `resolvePiCommand` 同一套思路）。
 * Windows 上全局安装的是 `codex.cmd`（spawn 必须经 shell，违反「禁止 shell」），
 * 定位 npm 包里的 `bin/codex.js` 用 node 直接拉；非 Windows 直接用 PATH 上的 `codex`。
 *
 * 入口按 **PATH 顺序**找（见 `resolveNodePackageCli`），不是只认 `%APPDATA%\npm`：
 * 用 nvm-windows 时 PATH 里更靠前的 `C:\nvm4w\nodejs` 下往往还装着另一个副本，只认
 * `%APPDATA%\npm` 会让 Host 跑起旧的那份，于是「APP 里的 codex 能选的模型」和终端
 * 里的对不上——两边其实是两个不同版本的 codex。
 */
export async function resolveCodexCommand(env: Record<string, string | undefined> = process.env): Promise<CodexCommand> {
  if (env === process.env && !env.ORBIS_CODEX_ENTRY) {
    const selected = await readCodexSelection();
    if (selected) env = { ...env, ORBIS_CODEX_ENTRY: selected };
  }
  if (env.ORBIS_CODEX_ENTRY) {
    const { access } = await import("node:fs/promises");
    await access(env.ORBIS_CODEX_ENTRY);
    return { command: process.execPath, prefixArgs: [env.ORBIS_CODEX_ENTRY] };
  }
  if (platform() !== "win32") return { command: "codex", prefixArgs: [] };
  const entry = await resolveNodePackageCli(env, ["@openai", "codex", "bin", "codex.js"]);
  if (entry === undefined) {
    throw new Error(
      "未找到 codex 的 JS 入口（PATH 与 %APPDATA%\\npm 下都没有 node_modules\\@openai\\codex）。请确认已全局安装 codex-cli。",
    );
  }
  return { command: process.execPath, prefixArgs: [entry] };
}

function describeJsonRpcError(error: unknown): string {
  if (error !== null && typeof error === "object") {
    const record = error as { message?: unknown; code?: unknown };
    if (typeof record.message === "string") {
      return typeof record.code === "number" ? `${record.message}（code=${record.code}）` : record.message;
    }
  }
  return JSON.stringify(error);
}
