/** DeepSeek Harness 0.1.7 ACP v1, over an owned Windows Node subprocess. */
import { spawn, type ChildProcess } from "node:child_process";
import { access } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";
import { setTimeout as delay } from "node:timers/promises";
import { resolveNodePackageCli, type PiCommand } from "./spawner.js";

export const DSH_VERSION = "0.1.7-rc.1";
export type JsonObject = Record<string, unknown>;
export const record = (value: unknown): JsonObject => value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};

export async function resolveDshCommand(env: NodeJS.ProcessEnv = process.env): Promise<PiCommand> {
  const entry = env.ORBIS_DSH_ENTRY ?? await resolveNodePackageCli(env, ["@deepseek-ai", "dsh", "lib", "bin.js"]);
  if (!entry) throw new Error(`未找到 DeepSeek Harness，请安装 @deepseek-ai/dsh@${DSH_VERSION}，或设置 ORBIS_DSH_ENTRY`);
  await access(entry);
  return { command: process.execPath, prefixArgs: [entry] };
}

export type DshRequest = {
  method: string;
  params: JsonObject;
  respond: (result: unknown) => void;
  reject: (message: string) => void;
};
export interface DshConnection {
  request(method: string, params: JsonObject, timeoutMs?: number): Promise<unknown>;
  notify(method: string, params: JsonObject): void;
  onNotification: ((method: string, params: JsonObject) => void) | undefined;
  onRequest: ((request: DshRequest) => void) | undefined;
  onExit: ((reason: string) => void) | undefined;
  stop(): Promise<void>;
}

export class DshAcpClient implements DshConnection {
  onNotification: DshConnection["onNotification"];
  onRequest: DshConnection["onRequest"];
  onExit: DshConnection["onExit"];
  readonly #child: ChildProcess;
  readonly #pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout | undefined }>();
  #nextId = 0;
  #closed = false;
  #stopping: Promise<void> | undefined;
  #tail = "";

  private constructor(child: ChildProcess) {
    this.#child = child;
    const decoder = new StringDecoder("utf8");
    let buffered = "";
    child.stdout!.on("data", (chunk: Buffer) => {
      buffered += decoder.write(chunk);
      let end: number;
      while ((end = buffered.indexOf("\n")) >= 0) {
        const line = buffered.slice(0, end).trim();
        buffered = buffered.slice(end + 1);
        if (!line) continue;
        try {
          if (Buffer.byteLength(line) > 16 * 1024 * 1024) throw new Error("ACP frame too large");
          this.#receive(JSON.parse(line));
        }
        catch { this.#fail("DSH 返回了无效的 ACP 消息"); child.kill(); return; }
      }
      if (Buffer.byteLength(buffered) > 16 * 1024 * 1024) { this.#fail("DSH ACP 消息超过 16 MiB"); child.kill(); }
    });
    child.stderr!.on("data", (chunk: Buffer) => { this.#tail = (this.#tail + chunk.toString("utf8")).slice(-2000); });
    child.stdin!.on("error", (error: Error) => this.#fail(`DSH 输入管道关闭：${error.message}`));
    child.on("error", (error) => this.#fail(`DSH 启动失败：${error.message}`));
    child.on("exit", (code, signal) => this.#fail(`DSH 已退出（${code ?? signal}）`));
  }

  static async create(options: { cli?: PiCommand; cwd?: string; env?: NodeJS.ProcessEnv; patches?: string[]; timeoutMs?: number } = {}): Promise<DshAcpClient> {
    const cli = options.cli ?? await resolveDshCommand(options.env);
    const child = spawn(cli.command, [...cli.prefixArgs, "--profile", "acp", ...(options.patches ?? []).flatMap(path => ["--patch", path])], {
      stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options.env === undefined ? {} : { env: options.env }),
    });
    const client = new DshAcpClient(child);
    try {
      const result = record(await client.request("initialize", {
        protocolVersion: 1, clientInfo: { name: "orbis", version: "0.1.0" }, clientCapabilities: {},
      }, options.timeoutMs ?? 60_000));
      const caps = record(record(result.agentCapabilities).sessionCapabilities);
      if (result.protocolVersion !== 1 || !caps.resume || !caps.list || !caps.close) throw new Error(`DSH ACP 能力不足，请安装 ${DSH_VERSION} 或兼容版本`);
      return client;
    } catch (error) {
      await client.stop();
      // Diagnostics stay local; do not expose model credentials through protocol errors.
      const detail = /API.?key|credential|token/i.test(client.#tail) ? "（请检查 dsh 的模型凭据配置）" : "";
      throw new Error(`${error instanceof Error ? error.message : String(error)}${detail}`, { cause: error });
    }
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
        const request: DshRequest = { method: frame.method, params: record(frame.params),
          respond: result => reply({ result }), reject: message => reply({ error: { code: -32601, message } }) };
        if (this.onRequest) this.onRequest(request); else request.reject("Unsupported client method");
      } else this.onNotification?.(frame.method, record(frame.params));
      return;
    }
    if (typeof frame.id !== "number") return;
    const pending = this.#pending.get(frame.id);
    if (!pending) return;
    this.#pending.delete(frame.id);
    clearTimeout(pending.timer);
    if (frame.error) pending.reject(new Error(String(record(frame.error).message ?? "DSH ACP request failed")));
    else pending.resolve(frame.result);
  }

  request(method: string, params: JsonObject, timeoutMs = 30_000): Promise<unknown> {
    if (this.#closed) return Promise.reject(new Error("DSH 已离线"));
    const id = ++this.#nextId;
    return new Promise((resolve, reject) => {
      const timer = timeoutMs > 0 ? setTimeout(() => {
        this.#pending.delete(id);
        try { this.notify("$/cancel_request", { requestId: id }); } catch { /* Already disconnected. */ }
        reject(new Error(`DSH ${method} 超时`));
        // A timed-out mutation may already have taken effect. Disconnecting tears
        // down all connection-owned agents, including unpublished late sessions.
        if (method !== "session/list") {
          this.#fail(`DSH ${method} 超时，连接已关闭；请重启 Host 后恢复会话`);
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
    if (this.#closed) throw new Error("DSH 已离线");
    this.#child.stdin!.write(`${JSON.stringify(frame)}\n`);
  }
  #fail(reason: string): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const pending of this.#pending.values()) { clearTimeout(pending.timer); pending.reject(new Error(reason)); }
    this.#pending.clear();
    this.onExit?.(reason);
  }
  stop(): Promise<void> {
    return this.#stopping ??= (async () => {
      const child = this.#child;
      const exited = () => child.exitCode !== null || child.signalCode !== null || child.pid === undefined;
      // ACP has no shutdown request. Its official launcher quiesces on stdin EOF.
      child.stdin?.end();
      for (let i = 0; i < 150 && !exited(); i++) await delay(100);
      if (!exited()) child.kill();
      for (let i = 0; i < 30 && !exited(); i++) await delay(100);
      if (!exited()) throw new Error("DSH 子进程未退出");
      this.#fail("DSH 已停止");
    })();
  }
}
