/** Authenticated transport for the existing DSH Web process, never its owner. */
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import WebSocket from "ws";
import { record, resolveDshCommand, type JsonObject } from "./dsh-client.js";
import type { PiCommand } from "./spawner.js";

type RemoteFailure = { code: string; message: string; details: JsonObject };
type RpcResponse = { type: "server-response"; rpcId: string; result: { ok: true; value: unknown } | { ok: false; error: RemoteFailure } };
type StreamFrame = { type: "item"; streamId: string; value?: unknown } | { type: "end"; streamId: string } | { type: "error"; streamId: string; error: RemoteFailure };
export type DshWebEvent =
  | { type: "emit"; event: string; args: unknown[] }
  | { type: "waterfall"; event: string; eventId: string; agentId: string; request: JsonObject }
  | { type: "cancel"; eventId: string };
export type DshWebEventOutcome = { kind: "next" } | { kind: "result"; value?: unknown } | { kind: "rejected"; error: { name: string; message: string; code?: string; details?: unknown } };

export interface DshWebConnection {
  request<T = unknown>(method: string, args: JsonObject, timeoutMs?: number): Promise<T>;
  subscribe(method: string, args: JsonObject, onFrame: (frame: unknown) => void, onError?: (error: Error) => void): () => void;
  respondEvent(eventId: string, outcome: DshWebEventOutcome): Promise<void>;
  onEvent: ((event: DshWebEvent) => void) | undefined;
  onExit: ((reason: string) => void) | undefined;
  onReconnect: (() => void) | undefined;
  stop(): Promise<void>;
}

/** Validators are loaded from the selected CLI installation, matching its wire version. */
export interface DshWebProtocol {
  parseStream(text: string): StreamFrame;
  parseResponse(value: unknown): RpcResponse;
  parseEventResult(value: unknown): unknown;
  muxPath: string;
  eventEndpoint: string;
  eventResultEndpoint: string;
}

export async function loadDshWebProtocol(cliEntry: string): Promise<DshWebProtocol> {
  const require = createRequire(cliEntry);
  const stream = await import(pathToFileURL(require.resolve("@deepseek-ai/dsh-api-gateway/stream-protocol")).href);
  const connection = await import(pathToFileURL(require.resolve("@deepseek-ai/dsh-client-connection")).href);
  return {
    parseStream: stream.parseRemoteStreamServerMessage,
    parseResponse: value => connection.serverResponseSchema.parse(value) as RpcResponse,
    parseEventResult: stream.parseRemoteEventResult,
    muxPath: stream.REMOTE_STREAM_MUX_PATH as string,
    eventEndpoint: stream.REMOTE_EVENT_STREAM_ENDPOINT as string,
    eventResultEndpoint: stream.REMOTE_EVENT_RESULT_ENDPOINT as string,
  };
}

export interface DshWebClientOptions {
  url?: string;
  cookie?: string;
  env?: NodeJS.ProcessEnv;
  cli?: PiCommand;
  cliEntry?: string;
  timeoutMs?: number;
  reconnectDelayMs?: number;
  protocol?: DshWebProtocol;
}

export class DshWebRemoteError extends Error {
  constructor(readonly code: string, message: string, readonly details: JsonObject = {}) { super(message); this.name = "DshWebRemoteError"; }
}

type Subscription = { method: string; args: JsonObject; onFrame: (frame: unknown) => void; onError: ((error: Error) => void) | undefined; streamId?: string };
const MAX_FRAME_BYTES = 16 * 1024 * 1024;

export class DshWebClient implements DshWebConnection {
  onEvent: DshWebConnection["onEvent"];
  onExit: DshWebConnection["onExit"];
  onReconnect: DshWebConnection["onReconnect"];
  readonly url: string;
  readonly #base: URL;
  readonly #protocol: DshWebProtocol;
  readonly #timeoutMs: number;
  readonly #reconnectDelayMs: number | undefined;
  readonly #subscriptions = new Set<Subscription>();
  readonly #streams = new Map<string, Subscription>();
  readonly #requests = new Set<AbortController>();
  readonly #pendingEvents = new Map<string, string>();
  #cookie: string;
  #socket: WebSocket | undefined;
  #closed = false;
  #ready = false;
  #connectedOnce = false;
  #clientId: string | undefined;
  #eventsStream: string | undefined;
  #reconnectTimer: NodeJS.Timeout | undefined;
  #reconnectAttempt = 0;
  #initialResolve: (() => void) | undefined;
  #initialReject: ((error: Error) => void) | undefined;
  #handshakeTimer: NodeJS.Timeout | undefined;
  #stopping: Promise<void> | undefined;

  private constructor(base: URL, cookie: string, protocol: DshWebProtocol, options: DshWebClientOptions) {
    this.#base = base;
    this.url = base.href;
    this.#cookie = cookie;
    this.#protocol = protocol;
    this.#timeoutMs = options.timeoutMs ?? 15_000;
    this.#reconnectDelayMs = options.reconnectDelayMs;
  }

  static async connect(options: DshWebClientOptions = {}): Promise<DshWebClient> {
    const env = options.env ?? process.env;
    const launch = loopbackUrl(options.url ?? env.ORBIS_DSH_WEB_URL ?? "http://127.0.0.1:3080/");
    const base = new URL(launch);
    base.search = "";
    base.hash = "";
    if (!base.pathname.endsWith("/")) base.pathname += "/";
    const cliEntry = options.cliEntry ?? options.cli?.prefixArgs[0] ?? (options.protocol ? undefined : (await resolveDshCommand(env)).prefixArgs[0]);
    if (!options.protocol && !cliEntry) throw new Error("DSH Web requires the installed DSH CLI protocol libraries");
    const protocol = options.protocol ?? await loadDshWebProtocol(cliEntry!);
    const client = new DshWebClient(base, options.cookie ?? env.ORBIS_DSH_WEB_COOKIE ?? "", protocol, options);
    try {
      if (launch.searchParams.has("token")) await client.#authenticate(launch);
      await new Promise<void>((resolve, reject) => {
        client.#initialResolve = resolve;
        client.#initialReject = reject;
        client.#openSocket();
      });
      return client;
    } catch (error) {
      await client.stop();
      throw error;
    }
  }

  async #authenticate(launch: URL): Promise<void> {
    const response = await fetch(launch, { redirect: "manual", signal: AbortSignal.timeout(this.#timeoutMs) });
    try {
      if (response.status !== 302 && response.status !== 303) throw new Error("DSH Web authentication failed; use the current Web launch URL containing its token");
      const location = response.headers.get("location");
      if (!location || new URL(location, launch).origin !== this.#base.origin) throw new Error("DSH Web refused an authentication redirect to another origin");
      const cookies = response.headers.getSetCookie().map(value => value.split(";", 1)[0]).filter((value): value is string => Boolean(value));
      if (cookies.length === 0) throw new Error("DSH Web did not return an authentication cookie");
      this.#cookie = cookies.join("; ");
    } finally { await response.body?.cancel(); }
  }

  #openSocket(): void {
    if (this.#closed) return;
    const endpoint = new URL(this.#protocol.muxPath.replace(/^\//, ""), this.#base);
    endpoint.protocol = endpoint.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(endpoint, {
      headers: { Cookie: this.#cookie, Origin: this.#base.origin },
      followRedirects: false, maxPayload: MAX_FRAME_BYTES, handshakeTimeout: this.#timeoutMs,
    });
    this.#socket = socket;
    this.#handshakeTimer = setTimeout(() => {
      if (this.#socket !== socket || this.#ready) return;
      if (!this.#connectedOnce) this.#fail(new Error("DSH Web did not complete its event-stream handshake"));
      else socket.terminate();
    }, this.#timeoutMs);
    this.#handshakeTimer.unref();
    socket.on("open", () => {
      if (this.#socket !== socket || this.#closed) return;
      this.#eventsStream = randomUUID();
      this.#send({ type: "open", streamId: this.#eventsStream, endpoint: this.#protocol.eventEndpoint, payload: { args: {} } });
    });
    socket.on("message", (data, binary) => {
      if (this.#socket !== socket || this.#closed) return;
      try {
        if (binary) throw new Error("DSH Web returned a binary Remote stream frame");
        this.#receive(this.#protocol.parseStream(data.toString()));
      } catch { this.#fail(new Error("DSH Web returned an invalid Remote stream frame")); }
    });
    socket.on("unexpected-response", (_request, response) => {
      response.resume();
      this.#fail(new Error(response.statusCode === 401
        ? "DSH Web authentication required; connect with its current launch URL or a valid local browser-session cookie"
        : `DSH Web connection failed: HTTP ${response.statusCode ?? "unknown"}`));
    });
    socket.on("error", () => {
      if (!this.#connectedOnce && !this.#closed) this.#fail(new Error("Cannot connect to DSH Web; start DeepSeek Harness Web and check its local address"));
    });
    socket.on("close", () => {
      if (this.#socket !== socket) return;
      clearTimeout(this.#handshakeTimer);
      this.#socket = undefined;
      this.#ready = false;
      this.#clientId = undefined;
      this.#streams.clear();
      // The DSH Gateway keeps a pending waterfall after a carrier generation
      // disappears and replays it to the next generation. Do not tell the
      // application that it was cancelled merely because this socket rotated.
      this.#pendingEvents.clear();
      for (const request of this.#requests) request.abort();
      if (this.#closed) return;
      if (!this.#connectedOnce) { this.#fail(new Error("DSH Web disconnected before its handshake completed")); return; }
      const cap = Math.min(10_000, 500 * 2 ** Math.min(this.#reconnectAttempt++, 5));
      const delay = this.#reconnectDelayMs ?? Math.round(cap * (0.5 + Math.random() * 0.5));
      this.#reconnectTimer = setTimeout(() => this.#openSocket(), delay);
      this.#reconnectTimer.unref();
    });
  }

  #receive(frame: StreamFrame): void {
    if (frame.streamId === this.#eventsStream) {
      if (frame.type !== "item") throw new Error("DSH Web event stream ended");
      const event = record(frame.value);
      if (!this.#ready) {
        if (event.type !== "ready" || typeof event.clientId !== "string" || typeof record(event.host).home !== "string") throw new Error("DSH Web event stream did not start with ready");
        this.#clientId = event.clientId;
        this.#ready = true;
        this.#reconnectAttempt = 0;
        clearTimeout(this.#handshakeTimer);
        for (const subscription of this.#subscriptions) this.#openSubscription(subscription);
        const reconnecting = this.#connectedOnce;
        this.#connectedOnce = true;
        this.#initialResolve?.();
        this.#initialResolve = undefined;
        this.#initialReject = undefined;
        if (reconnecting) this.onReconnect?.();
        return;
      }
      this.#receiveEvent(event);
      return;
    }
    const subscription = this.#streams.get(frame.streamId);
    if (!subscription) return;
    if (frame.type === "item") { subscription.onFrame(frame.value); return; }
    this.#streams.delete(frame.streamId);
    this.#subscriptions.delete(subscription);
    subscription.onError?.(frame.type === "error" ? new DshWebRemoteError(frame.error.code, safeMessage(frame.error.message), frame.error.details) : new Error(`DSH Web ${subscription.method} stream ended`));
  }

  #receiveEvent(value: JsonObject): void {
    let event: DshWebEvent;
    if (value.type === "emit" && typeof value.event === "string" && Array.isArray(value.args)) {
      event = { type: "emit", event: value.event, args: value.args };
    } else if (value.type === "waterfall" && typeof value.event === "string" && typeof value.eventId === "string" && typeof value.agentId === "string" && value.request !== null && typeof value.request === "object" && !Array.isArray(value.request)) {
      event = { type: "waterfall", event: value.event, eventId: value.eventId, agentId: value.agentId, request: record(value.request) };
      this.#pendingEvents.set(event.eventId, this.#clientId!);
      if (!this.onEvent) { void this.respondEvent(event.eventId, { kind: "next" }).catch(() => {}); return; }
    } else if (value.type === "cancel" && typeof value.eventId === "string") {
      this.#pendingEvents.delete(value.eventId);
      event = { type: "cancel", eventId: value.eventId };
    } else throw new Error("Invalid DSH Web forwarded event");
    try {
      this.onEvent?.(event);
    } catch (error) {
      // A Host event listener is application code. Contain a bad listener so it
      // cannot tear down the shared WebSocket; a waterfall still needs an
      // explicit rejection to release the DSH turn.
      if (event.type === "waterfall") {
        const reason = error instanceof Error ? error : new Error(String(error));
        void this.respondEvent(event.eventId, {
          kind: "rejected",
          error: { name: reason.name, message: reason.message },
        }).catch(() => {});
      }
    }
  }

  async request<T = unknown>(method: string, args: JsonObject, timeoutMs = 30_000): Promise<T> {
    if (this.#closed || !this.#ready) throw new Error("DSH Web is disconnected");
    if (!/^[a-zA-Z0-9_$.-]+(?:\/[a-zA-Z0-9_$.-]+)*$/.test(method) || method.split("/").some(part => part === "." || part === "..")) throw new Error("Invalid DSH Web RPC method");
    const rpcId = randomUUID();
    const controller = new AbortController();
    this.#requests.add(controller);
    const timer = timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : undefined;
    timer?.unref();
    try {
      const response = await fetch(new URL(`api/${method}`, this.#base), {
        method: "POST", redirect: "manual", signal: controller.signal,
        headers: { Cookie: this.#cookie, Origin: this.#base.origin, "Content-Type": "application/json" },
        body: JSON.stringify({ type: "client-request", rpcId, method, payload: { args } }),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`DSH Web ${method}: HTTP ${response.status}${response.status === 401 ? " (authentication expired)" : ""}`);
      }
      const parsed = this.#protocol.parseResponse(await readJson(response));
      if (parsed.rpcId !== rpcId) throw new Error("DSH Web response correlation mismatch");
      if (!parsed.result.ok) throw new DshWebRemoteError(parsed.result.error.code, safeMessage(parsed.result.error.message), parsed.result.error.details);
      return parsed.result.value as T;
    } catch (error) {
      if (controller.signal.aborted) throw new Error(`DSH Web ${method} was interrupted or timed out; refresh before retrying a mutation`);
      throw error;
    } finally { clearTimeout(timer); this.#requests.delete(controller); }
  }

  subscribe(method: string, args: JsonObject, onFrame: (frame: unknown) => void, onError?: (error: Error) => void): () => void {
    if (this.#closed) throw new Error("DSH Web is disconnected");
    const subscription: Subscription = { method, args, onFrame, onError };
    this.#subscriptions.add(subscription);
    if (this.#ready) this.#openSubscription(subscription);
    return () => {
      if (!this.#subscriptions.delete(subscription)) return;
      if (subscription.streamId) {
        this.#streams.delete(subscription.streamId);
        if (this.#ready) this.#send({ type: "cancel", streamId: subscription.streamId });
      }
    };
  }

  #openSubscription(subscription: Subscription): void {
    subscription.streamId = randomUUID();
    this.#streams.set(subscription.streamId, subscription);
    this.#send({ type: "open", streamId: subscription.streamId, endpoint: subscription.method, payload: { args: subscription.args } });
  }

  async respondEvent(eventId: string, outcome: DshWebEventOutcome): Promise<void> {
    const clientId = this.#pendingEvents.get(eventId);
    if (!clientId || clientId !== this.#clientId) throw new Error("DSH Web interaction is no longer pending");
    const result = this.#protocol.parseEventResult({ clientId, eventId, outcome });
    await this.request(this.#protocol.eventResultEndpoint, record(result));
    if (this.#pendingEvents.get(eventId) === clientId) this.#pendingEvents.delete(eventId);
  }

  #send(frame: JsonObject): void {
    if (!this.#socket || this.#socket.readyState !== WebSocket.OPEN) throw new Error("DSH Web socket is disconnected");
    this.#socket.send(JSON.stringify(frame));
  }

  #cancelEvents(): void {
    const events = [...this.#pendingEvents.keys()];
    this.#pendingEvents.clear();
    for (const eventId of events) this.onEvent?.({ type: "cancel", eventId });
  }

  #fail(error: Error): void {
    if (this.#closed) return;
    this.#initialReject?.(error);
    this.#initialReject = undefined;
    this.#initialResolve = undefined;
    this.onExit?.(error.message);
    void this.stop();
  }

  stop(): Promise<void> {
    return this.#stopping ??= (async () => {
      this.#closed = true;
      this.#ready = false;
      clearTimeout(this.#handshakeTimer);
      clearTimeout(this.#reconnectTimer);
      this.#cancelEvents();
      for (const request of this.#requests) request.abort();
      this.#subscriptions.clear();
      this.#streams.clear();
      const socket = this.#socket;
      this.#socket = undefined;
      if (!socket || socket.readyState === WebSocket.CLOSED) return;
      await new Promise<void>(resolve => {
        const timer = setTimeout(() => { socket.terminate(); resolve(); }, 1_000);
        socket.once("close", () => { clearTimeout(timer); resolve(); });
        if (socket.readyState === WebSocket.OPEN) socket.close(); else socket.terminate();
      });
    })();
  }
}

function loopbackUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("DSH Web address must be a local HTTP URL"); }
  if (!["http:", "https:"].includes(url.protocol) || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || url.username || url.password) throw new Error("DSH Web address must use loopback HTTP or HTTPS without URL credentials");
  return url;
}

function safeMessage(value: string): string {
  return /<!doctype|<html[\s>]/i.test(value) ? "DSH returned an HTML error page; check the model provider endpoint" : value.slice(0, 4_000);
}

async function readJson(response: Response): Promise<unknown> {
  if (!response.headers.get("content-type")?.toLowerCase().includes("application/json")) { await response.body?.cancel(); throw new Error("DSH Web returned a non-JSON response"); }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("DSH Web returned an empty response");
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > MAX_FRAME_BYTES) throw new Error("DSH Web response exceeds 16 MiB");
      chunks.push(chunk.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } finally { await reader.cancel(); }
}
