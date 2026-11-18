/** JSON-RPC transport for Hermes' TUI Gateway WebSocket. Authentication/bootstrap is handled separately. */
import { randomUUID } from "node:crypto";
import WebSocket from "ws";

export const HERMES_GATEWAY_WS_PROTOCOL = "hermes-gateway-v1";

export type HermesJsonRpcId = string | number;
export type HermesJsonObject = Record<string, unknown>;
export type HermesGatewayEvent = HermesJsonObject & { type: string };
export type HermesServerRequest = { id: HermesJsonRpcId; method: string; params: HermesJsonObject };
export type HermesServerRequestHandler = (request: HermesServerRequest) => Promise<unknown> | unknown;

export type HermesGatewayRpcOptions = {
  requestTimeoutMs?: number;
  maxPayloadBytes?: number;
  requestIdPrefix?: string;
  onEvent?: (event: HermesGatewayEvent) => void;
  onServerRequest?: HermesServerRequestHandler;
  onTransportError?: (error: HermesGatewayRpcError) => void;
};

export class HermesGatewayRpcError extends Error {
  constructor(
    message: string,
    readonly code?: number,
    readonly data?: HermesJsonObject,
  ) {
    super(message);
    this.name = "HermesGatewayRpcError";
  }
}

export class HermesGatewayRpcClient {
  readonly #socket: WebSocket;
  readonly #requestTimeoutMs: number;
  readonly #onEvent: ((event: HermesGatewayEvent) => void) | undefined;
  readonly #onServerRequest: HermesServerRequestHandler | undefined;
  readonly #onTransportError: ((error: HermesGatewayRpcError) => void) | undefined;
  readonly #pending = new Map<HermesJsonRpcId, {
    resolve(value: unknown): void;
    reject(error: Error): void;
    timer: NodeJS.Timeout;
  }>();
  readonly #clientPrefix: string;
  #nextId = 0;
  #closed = false;
  #fatal: HermesGatewayRpcError | undefined;
  #closePromise: Promise<void> | undefined;

  private constructor(socket: WebSocket, options: HermesGatewayRpcOptions = {}) {
    this.#socket = socket;
    this.#requestTimeoutMs = options.requestTimeoutMs ?? 120_000;
    this.#onEvent = options.onEvent;
    this.#onServerRequest = options.onServerRequest;
    this.#onTransportError = options.onTransportError;
    this.#clientPrefix = options.requestIdPrefix ?? `orbis-${randomUUID()}`;
    socket.on("message", (data, isBinary) => this.#onMessage(data, isBinary));
    socket.on("error", error => this.#fail(new HermesGatewayRpcError(`Hermes Gateway WebSocket failed: ${error.message}`)));
    socket.on("close", (code, reason) => {
      const suffix = reason.length ? ` (${reason.toString("utf8").slice(0, 160)})` : "";
      this.#fail(new HermesGatewayRpcError(`Hermes Gateway WebSocket closed (${code})${suffix}`));
    });
  }

  /** Opens a Gateway WebSocket. The caller obtains the URL and ticket from Hermes' bootstrap flow. */
  static async connect(
    url: string,
    protocols: string | string[] | undefined,
    options: HermesGatewayRpcOptions = {},
  ): Promise<HermesGatewayRpcClient> {
    const maxPayload = options.maxPayloadBytes ?? 8 * 1024 * 1024;
    const socket = new WebSocket(url, protocols, {
      handshakeTimeout: 10_000,
      maxPayload,
      perMessageDeflate: false,
    });
    const client = new HermesGatewayRpcClient(socket, options);
    try {
      await new Promise<void>((resolve, reject) => {
        const onOpen = () => { cleanup(); resolve(); };
        const onError = (error: Error) => { cleanup(); reject(new HermesGatewayRpcError(`Hermes Gateway connection failed: ${error.message}`)); };
        const onClose = (code: number) => { cleanup(); reject(new HermesGatewayRpcError(`Hermes Gateway closed during handshake (${code})`)); };
        const cleanup = () => {
          socket.off("open", onOpen);
          socket.off("error", onError);
          socket.off("close", onClose);
        };
        socket.once("open", onOpen);
        socket.once("error", onError);
        socket.once("close", onClose);
      });
      if (protocols && socket.protocol !== HERMES_GATEWAY_WS_PROTOCOL) {
        throw new HermesGatewayRpcError("Hermes Gateway negotiated an unexpected WebSocket protocol");
      }
      return client;
    } catch (error) {
      await client.close().catch(() => undefined);
      throw error;
    }
  }

  get readyState(): number { return this.#socket.readyState; }
  get closed(): boolean { return this.#closed; }

  request<T = unknown>(method: string, params: HermesJsonObject = {}, timeoutMs = this.#requestTimeoutMs): Promise<T> {
    if (this.#fatal) return Promise.reject(this.#fatal);
    if (this.#closed || this.#socket.readyState !== WebSocket.OPEN)
      return Promise.reject(new HermesGatewayRpcError("Hermes Gateway is not connected"));
    if (!method || method.length > 160) return Promise.reject(new HermesGatewayRpcError("Invalid Hermes Gateway method"));
    const id = `${this.#clientPrefix}:${++this.#nextId}`;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new HermesGatewayRpcError(`Hermes Gateway request timed out: ${method}`));
      }, Math.max(1, timeoutMs));
      timer.unref?.();
      this.#pending.set(id, { resolve: value => resolve(value as T), reject, timer });
      try {
        this.#socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }), error => {
          if (!error) return;
          const pending = this.#pending.get(id);
          if (!pending) return;
          clearTimeout(pending.timer);
          this.#pending.delete(id);
          pending.reject(new HermesGatewayRpcError(`Hermes Gateway send failed: ${error.message}`));
        });
      } catch (error) {
        clearTimeout(timer);
        this.#pending.delete(id);
        reject(new HermesGatewayRpcError(`Hermes Gateway send failed: ${error instanceof Error ? error.message : String(error)}`));
      }
    });
  }

  /** Hermes may issue server→client requests (approval, clarify, secret, ...). */
  setServerRequestHandler(handler: HermesServerRequestHandler | undefined): void {
    this.#serverRequestHandler = handler;
  }

  #serverRequestHandler: HermesServerRequestHandler | undefined;

  async #onMessage(data: WebSocket.RawData, isBinary: boolean): Promise<void> {
    if (isBinary) return this.#protocolFailure("Hermes Gateway sent an unexpected binary frame");
    const text = typeof data === "string" ? data : Buffer.isBuffer(data) ? data.toString("utf8")
      : Array.isArray(data) ? Buffer.concat(data).toString("utf8") : Buffer.from(data).toString("utf8");
    let frame: unknown;
    try { frame = JSON.parse(text) as unknown; }
    catch { return this.#protocolFailure("Hermes Gateway sent invalid JSON"); }
    if (!isRecord(frame) || frame.jsonrpc !== "2.0") return this.#protocolFailure("Hermes Gateway sent an invalid JSON-RPC frame");

    if (isRpcId(frame.id) && typeof frame.method === "string") {
      const params = isRecord(frame.params) ? frame.params : {};
      void this.#answerServerRequest({ id: frame.id, method: frame.method, params });
      return;
    }
    if (frame.id !== undefined) {
      if (!isRpcId(frame.id)) return this.#protocolFailure("Hermes Gateway response has an invalid id");
      const pending = this.#pending.get(frame.id);
      if (!pending) return; // Late or duplicate response; the request already settled.
      clearTimeout(pending.timer);
      this.#pending.delete(frame.id);
      if (isRecord(frame.error)) {
        const code = typeof frame.error.code === "number" && Number.isInteger(frame.error.code) ? frame.error.code : undefined;
        const message = safeErrorText(frame.error.message);
        pending.reject(new HermesGatewayRpcError(message, code,
          isRecord(frame.error.data) ? safeErrorData(frame.error.data) : undefined));
      } else {
        pending.resolve(frame.result);
      }
      return;
    }
    if (typeof frame.method === "string") {
      if (frame.method === "event" && isRecord(frame.params) && typeof frame.params.type === "string") {
        try { this.#onEvent?.(frame.params as HermesGatewayEvent); }
        catch (error) { this.#onTransportError?.(new HermesGatewayRpcError(`Hermes event handler failed: ${errorText(error)}`)); }
      }
    }
  }

  async #answerServerRequest(request: HermesServerRequest): Promise<void> {
    const handler = this.#serverRequestHandler ?? this.#onServerRequest;
    if (!handler) return this.#sendError(request.id, -32601, "Request method not implemented");
    try {
      const result = await handler(request);
      this.#socket.send(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: result ?? {} }));
    } catch {
      // Handler diagnostics may contain prompt or approval details; do not echo them onto the Gateway.
      this.#sendError(request.id, -32603, "Request handler failed");
    }
  }

  #sendError(id: HermesJsonRpcId, code: number, message: string, data?: HermesJsonObject): void {
    if (this.#socket.readyState !== WebSocket.OPEN) return;
    try { this.#socket.send(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message, ...(data ? { data } : {}) } })); }
    catch { /* A closed peer cannot receive a reply. */ }
  }

  #protocolFailure(message: string): void {
    const error = new HermesGatewayRpcError(message);
    this.#fail(error);
    if (this.#socket.readyState === WebSocket.OPEN) this.#socket.close(1002, "invalid gateway JSON-RPC");
  }

  #fail(error: HermesGatewayRpcError): void {
    if (this.#fatal) return;
    this.#fatal = error;
    this.#closed = true;
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
    try { this.#onTransportError?.(error); } catch { /* Diagnostics must not destabilize settlement. */ }
  }

  close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    this.#closed = true;
    this.#closePromise = new Promise(resolve => {
      if (this.#socket.readyState === WebSocket.CLOSED) { this.#fail(new HermesGatewayRpcError("Hermes Gateway closed")); resolve(); return; }
      const finish = () => { this.#fail(new HermesGatewayRpcError("Hermes Gateway closed")); resolve(); };
      this.#socket.once("close", finish);
      try { this.#socket.close(1000, "Orbis disconnect"); }
      catch { finish(); }
      const timer = setTimeout(() => {
        if (this.#socket.readyState !== WebSocket.CLOSED) this.#socket.terminate();
        finish();
      }, 2_000);
      timer.unref?.();
      this.#socket.once("close", () => clearTimeout(timer));
    });
    return this.#closePromise;
  }
}

function isRecord(value: unknown): value is HermesJsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function isRpcId(value: unknown): value is HermesJsonRpcId {
  return typeof value === "string" || (typeof value === "number" && Number.isFinite(value));
}
function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function safeErrorText(value: unknown): string { return typeof value === "string" ? value.slice(0, 512) : "Hermes Gateway request failed"; }
function safeErrorData(value: HermesJsonObject): HermesJsonObject {
  const out: HermesJsonObject = {};
  for (const [key, item] of Object.entries(value)) {
    if (Object.keys(out).length >= 16 || key.length > 64) break;
    if (item === null || typeof item === "boolean" || (typeof item === "number" && Number.isFinite(item)) ||
      (typeof item === "string" && item.length <= 200)) out[key] = item;
  }
  return out;
}
