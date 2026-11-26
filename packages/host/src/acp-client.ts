/** Newline-delimited ACP v1 JSON-RPC over an owned subprocess. */
import { spawn, type ChildProcess } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { setTimeout as delay } from "node:timers/promises";
import type { PiCommand } from "./spawner.js";
import { agentInvocation, stopAgentProcess } from "./agent-command.js";

export type JsonObject = Record<string, unknown>;
export const record = (value: unknown): JsonObject => value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
type AcpLaunchOptions = {
  cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number;
  validate: (result: JsonObject) => void;
  signal?: AbortSignal;
  redact?: (line: string) => string;
};

export type AcpRequest = {
  method: string;
  params: JsonObject;
  respond: (result: unknown) => void;
  reject: (message: string) => void;
};
export interface AcpConnection {
  request(method: string, params: JsonObject, timeoutMs?: number): Promise<unknown>;
  readonly supportsClose?: boolean;
  readonly connected?: boolean;
  notify(method: string, params: JsonObject): void;
  onNotification: ((method: string, params: JsonObject) => void) | undefined;
  onRequest: ((request: AcpRequest) => void) | undefined;
  onExit: ((reason: string) => void) | undefined;
  stop(): Promise<void>;
}

export class AcpUnconfirmedError extends Error {}
export class AcpCleanupError extends Error {}
export class AcpResponseError extends Error {
  constructor(readonly code: number | undefined) { super("Antigravity ACP rejected the request"); }
}

export class AcpClient implements AcpConnection {
  onNotification: AcpConnection["onNotification"];
  onRequest: AcpConnection["onRequest"];
  onExit: AcpConnection["onExit"];
  readonly #child: ChildProcess;
  readonly #pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout | undefined }>();
  #nextId = 0;
  #closed = false;
  #stopping: Promise<void> | undefined;
  supportsClose = false;
  get connected(): boolean { return !this.#closed; }

  private constructor(child: ChildProcess, private readonly label: string, redact?: (line: string) => string) {
    this.#child = child;
    const decoder = new StringDecoder("utf8");
    let buffered = "";
    child.stdout!.on("data", (chunk: Buffer) => {
      if (this.#closed) return;
      buffered += decoder.write(chunk);
      let end: number;
      while ((end = buffered.indexOf("\n")) >= 0) {
        const line = buffered.slice(0, end).trim();
        buffered = buffered.slice(end + 1);
        if (!line) continue;
        try {
          if (Buffer.byteLength(line) > 16 * 1024 * 1024) throw new Error("ACP frame too large");
          this.#receive(JSON.parse(redact ? redact(line) : line));
        }
        catch { this.#fail(`${this.label} 返回了无效的 ACP 消息`); void this.stop().catch(() => {}); return; }
      }
      if (Buffer.byteLength(buffered) > 16 * 1024 * 1024) { this.#fail(`${this.label} ACP 消息超过 16 MiB`); void this.stop().catch(() => {}); }
    });
    // Native stderr and errors may contain credentials, local paths or prompt text.
    child.stderr!.resume();
    child.stdout!.on("error", () => { this.#fail(`${this.label} 输出管道关闭`); void this.stop().catch(() => {}); });
    child.stdin!.on("error", () => this.#fail(`${this.label} 输入管道关闭`));
    child.on("error", () => this.#fail(`${this.label} 启动失败`));
    child.on("close", (code, signal) => this.#fail(`${this.label} 已退出（${code ?? signal}）`));
  }

  static async launch(cli: PiCommand, args: string[], label: string, options: AcpLaunchOptions): Promise<AcpClient> {
    options.signal?.throwIfAborted();
    const invocation = agentInvocation(cli, args, options.env);
    const child = spawn(invocation.command, invocation.args, {
      ...(invocation.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options.env === undefined ? {} : { env: options.env }),
    });
    const client = new AcpClient(child, label, options.redact);
    const abort = () => { void client.stop().catch(() => {}); };
    options.signal?.addEventListener("abort", abort, { once: true });
    try {
      const result = record(await client.request("initialize", {
        protocolVersion: 1, clientInfo: { name: "orbis", version: "0.1.0" }, clientCapabilities: { elicitation: { form: {} } },
      }, options.timeoutMs ?? 60_000));
      options.signal?.throwIfAborted();
      options.validate(result);
      const close = record(record(result.agentCapabilities).sessionCapabilities).close;
      client.supportsClose = close !== null && typeof close === "object" && !Array.isArray(close);
      return client;
    } catch (error) {
      await client.stop();
      throw error;
    } finally { options.signal?.removeEventListener("abort", abort); }
  }

  #receive(value: unknown): void {
    const frame = record(value);
    if (frame.jsonrpc !== "2.0") throw new Error("invalid ACP frame");
    if (typeof frame.method === "string") {
      if (typeof frame.id === "number" || typeof frame.id === "string") {
        let answered = false;
        const reply = (value: JsonObject) => {
          if (answered || this.#closed) return;
          answered = true;
          this.#send({ jsonrpc: "2.0", id: frame.id, ...value });
        };
        const request: AcpRequest = { method: frame.method, params: record(frame.params),
          respond: result => reply({ result }), reject: message => reply({ error: { code: -32601, message } }) };
        if (this.onRequest) this.onRequest(request);
        else if (request.method === "session/request_permission") request.respond({ outcome: { outcome: "cancelled" } });
        else if (request.method === "elicitation/create") request.respond({ action: "decline" });
        else request.reject("Unsupported ACP client method");
      } else this.onNotification?.(frame.method, record(frame.params));
      return;
    }
    if (typeof frame.id !== "number") return;
    const pending = this.#pending.get(frame.id);
    if (!pending) return;
    this.#pending.delete(frame.id);
    clearTimeout(pending.timer);
    if (frame.error) {
      const code = record(frame.error).code;
      pending.reject(new AcpResponseError(typeof code === "number" ? code : undefined));
    } else if (Object.hasOwn(frame, "result")) pending.resolve(frame.result);
    else pending.reject(new AcpUnconfirmedError("Invalid ACP response"));
  }

  request(method: string, params: JsonObject, timeoutMs = 30_000): Promise<unknown> {
    if (this.#closed) return Promise.reject(new Error(`${this.label} 已离线`));
    if (this.#pending.size >= 64) return Promise.reject(new Error("ACP request limit reached"));
    const id = ++this.#nextId;
    return new Promise((resolve, reject) => {
      const timer = timeoutMs > 0 ? setTimeout(() => {
        this.#pending.delete(id);
        try { this.notify("$/cancel_request", { requestId: id }); } catch { /* Already disconnected. */ }
        reject(new AcpUnconfirmedError(`${this.label} ${method} 超时`));
        // A timed-out mutation may already have taken effect. Disconnecting tears
        // down all connection-owned agents, including unpublished late sessions.
        if (method !== "session/list") {
          this.#fail(`${this.label} ${method} 超时，连接已关闭；请重启 Host 后恢复会话`);
          void this.stop().catch(() => this.#child.kill());
        }
      }, timeoutMs) : undefined;
      this.#pending.set(id, { resolve, reject, timer });
      try { this.#send({ jsonrpc: "2.0", id, method, params }); }
      catch (error) { clearTimeout(timer); this.#pending.delete(id); reject(error); }
    });
  }

  notify(method: string, params: JsonObject): void { this.#send({ jsonrpc: "2.0", method, params }); }
  #send(frame: JsonObject): void {
    if (this.#closed) throw new Error(`${this.label} 已离线`);
    const line = `${JSON.stringify(frame)}\n`;
    if (Buffer.byteLength(line) + this.#child.stdin!.writableLength > 16 * 1024 * 1024) throw new Error("ACP write limit reached");
    this.#child.stdin!.write(line);
  }
  #fail(reason: string): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const pending of this.#pending.values()) { clearTimeout(pending.timer); pending.reject(new AcpUnconfirmedError(reason)); }
    this.#pending.clear();
    this.onExit?.(reason);
  }
  stop(): Promise<void> {
    return this.#stopping ??= Promise.resolve().then(async () => {
      this.#fail(`${this.label} 已停止`);
      const child = this.#child;
      const exited = () => child.exitCode !== null || child.signalCode !== null || child.pid === undefined;
      // ACP has no shutdown request. Its official launcher quiesces on stdin EOF.
      child.stdin?.end();
      for (let i = 0; i < 20 && !exited(); i++) await delay(100);
      if (!exited()) await stopAgentProcess(child);
      for (let i = 0; i < 30 && !exited(); i++) await delay(100);
      if (!exited()) throw new AcpCleanupError(`${this.label} 子进程未退出`);
    });
  }
}
