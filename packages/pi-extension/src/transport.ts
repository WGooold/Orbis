import {
  decodeJson,
  PROTOCOL_VERSION,
  RelayToRuntimeMessageSchema,
  type RuntimeCommand,
  type RuntimeEvent,
  type RuntimeMetadata,
} from "@pi-remote/protocol";
import type { RuntimeBridgeTransport } from "@pi-remote/runtime-bridge";
import WebSocket from "ws";

import { safeValue } from "./safe-value.js";

export type RelayRuntimeConnectionState = "connecting" | "connected" | "reconnecting" | "error" | "closed";

export interface RelayRuntimeTransportOptions {
  relayUrl: string;
  credential: string;
  /** 端点路径。默认是 Relay 的 runtime 端点；loopback 传 `LOOPBACK_PATH`。 */
  path?: string;
  /**
   * 每次（重）连接前重新解析端点；返回 `undefined` 表示「没有新信息，按现状连」。
   *
   * loopback 用它重读发现文件：Host 重启会换一个随机端口，只认构造时那一个地址的话，
   * 还活着的 Pi 会永远重连一个死端口——进程在跑，Host 却再也发现不了它。
   */
  resolveEndpoint?: () => Promise<{ relayUrl: string; credential: string } | undefined>;
  reconnect?: boolean;
  initialReconnectDelayMs?: number;
  maxReconnectDelayMs?: number;
  heartbeatIntervalMs?: number;
  onConnectionStateChange?: (state: RelayRuntimeConnectionState) => void;
}

const DEFAULT_RUNTIME_PATH = "/v1/runtime";

const RUNTIME_SEQUENCE_STORE = Symbol.for("@pi-remote/runtime-sequences");

type RuntimeSequenceScope = { [key: symbol]: unknown };

const nextRuntimeSequence = (runtimeId: string): number => {
  const scope = globalThis as RuntimeSequenceScope;
  const sequences = scope[RUNTIME_SEQUENCE_STORE] instanceof Map
    ? scope[RUNTIME_SEQUENCE_STORE] as Map<string, number>
    : new Map<string, number>();
  scope[RUNTIME_SEQUENCE_STORE] = sequences;
  // Start above any sequence emitted by pre-upgrade transports, which used small
  // connection-local counters. This lets the first /reload adopt process-wide
  // sequencing without requiring the Pi process to restart once.
  const previous = sequences.get(runtimeId);
  const next = previous === undefined ? Date.now() : previous + 1;
  sequences.set(runtimeId, next);
  return next;
};

type Handlers = {
  connected: () => void;
  disconnected?: () => void;
  resync: (reason: string) => void;
  command: (commandId: string, runtimeId: string, command: RuntimeCommand) => void;
  error?: (message: string, recoverable: boolean) => void;
};

/** Outbound-only WebSocket adapter. Incremental events are dropped while offline; a reconnect snapshot repairs state. */
export class RelayRuntimeTransport implements RuntimeBridgeTransport {
  readonly #options: RelayRuntimeTransportOptions;
  #metadata: RuntimeMetadata | undefined;
  #handlers: Handlers | undefined;
  #socket: WebSocket | undefined;
  #ready = false;
  #closed = false;
  #reconnectDelayMs: number;
  #reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  #connecting = false;
  #heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  #awaitingPong = false;
  #hasConnected = false;
  #lastRecoverableProtocolError: string | undefined;

  constructor(options: RelayRuntimeTransportOptions) {
    this.#options = options;
    this.#reconnectDelayMs = options.initialReconnectDelayMs ?? 500;
  }

  async start(metadata: RuntimeMetadata, handlers: Handlers): Promise<void> {
    if (this.#socket || this.#closed) return;
    this.#metadata = metadata;
    this.#handlers = handlers;
    void this.#connect();
  }

  publish(event: RuntimeEvent): void {
    if (event.type === "runtime.status" && this.#metadata) {
      this.#metadata = { ...this.#metadata, status: event.status };
    }
    if (event.type === "runtime.metadata") {
      // Keep the latest metadata for the next authenticate.
      this.#metadata = event.metadata;
    }
    if (!this.#ready || !this.#socket || this.#socket.readyState !== WebSocket.OPEN || !this.#metadata) return;
    const sequence = nextRuntimeSequence(this.#metadata.runtimeId);
    try {
      const safeEvent = safeValue(event);
      this.#socket.send(JSON.stringify({
        type: "runtime.event",
        protocolVersion: PROTOCOL_VERSION,
        runtimeId: this.#metadata.runtimeId,
        sequence,
        event: safeEvent,
      }));
    } catch (error) {
      this.#handlers?.error?.(error instanceof Error ? error.message : "Unable to serialize runtime event", true);
    }
  }

  close(): void {
    this.#closed = true;
    this.#ready = false;
    this.#options.onConnectionStateChange?.("closed");
    if (this.#reconnectTimer) clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = undefined;
    this.#stopHeartbeat();
    this.#socket?.close(1000, "runtime shutdown");
    this.#socket = undefined;
  }

  async #connect(): Promise<void> {
    if (this.#closed || !this.#metadata || !this.#handlers) return;
    // 端点解析是异步的：两次重连可能叠在一起，这里挡掉第二个。
    if (this.#connecting || this.#socket !== undefined) return;
    this.#connecting = true;
    let relayUrl = this.#options.relayUrl;
    let credential = this.#options.credential;
    try {
      const resolved = await this.#options.resolveEndpoint?.();
      if (resolved !== undefined) {
        relayUrl = resolved.relayUrl;
        credential = resolved.credential;
      }
    } catch {
      // 读不到新端点不是错误：按构造时的端点继续重试，等下一次机会。
    } finally {
      this.#connecting = false;
    }
    if (this.#closed || this.#socket !== undefined || !this.#metadata || !this.#handlers) return;
    this.#options.onConnectionStateChange?.(this.#hasConnected ? "reconnecting" : "connecting");
    const socket = new WebSocket(`${relayUrl.replace(/\/$/, "")}${this.#options.path ?? DEFAULT_RUNTIME_PATH}`);
    this.#socket = socket;

    socket.on("open", () => {
      if (this.#socket !== socket || !this.#metadata) return;
      this.#startHeartbeat(socket);
      socket.send(JSON.stringify({
        type: "runtime.authenticate",
        protocolVersion: PROTOCOL_VERSION,
        credential,
        // 必填（ADR-0008）：Pi 扩展是 agent，网关（Host）自己声明 host。
        role: "agent",
        runtime: this.#metadata,
      }));
    });

    socket.on("message", (raw) => {
      if (this.#socket !== socket) return;
      let parsed: ReturnType<typeof RelayToRuntimeMessageSchema.safeParse>;
      try {
        parsed = RelayToRuntimeMessageSchema.safeParse(decodeJson(raw));
      } catch {
        this.#handlers?.error?.("Relay returned invalid JSON", true);
        return;
      }
      if (!parsed.success) {
        this.#handlers?.error?.("Relay returned an invalid protocol message", true);
        return;
      }
      const message = parsed.data;
      if (message.type === "runtime.ready") {
        if (message.runtimeId !== this.#metadata?.runtimeId) {
          this.#stopWithError(socket, "Relay returned a runtime identity mismatch");
          return;
        }
        this.#lastRecoverableProtocolError = undefined;
        this.#ready = true;
        this.#hasConnected = true;
        this.#reconnectDelayMs = this.#options.initialReconnectDelayMs ?? 500;
        this.#options.onConnectionStateChange?.("connected");
        this.#handlers?.connected();
      } else if (message.type === "runtime.resync") {
        if (message.runtimeId === this.#metadata?.runtimeId) this.#handlers?.resync(message.reason);
      } else if (message.type === "runtime.command") {
        // 本机 Host 经 loopback 投来的命令（中继不再代传命令，见 protocol 里的注释）。
        this.#handlers?.command(message.commandId, message.runtimeId, message.command);
      } else if (message.type === "protocol.error") {
        const recoverable = message.code !== "unauthorized" && message.code !== "runtime_mismatch";
        if (recoverable) {
          // Relay may repeat the same recoverable protocol error while a client
          // retries a rejected payload. One terminal error event is enough for
          // the mobile UI; a new connection resets this suppression.
          if (this.#lastRecoverableProtocolError !== message.message) {
            this.#lastRecoverableProtocolError = message.message;
            this.#handlers?.error?.(message.message, true);
          }
        } else {
          this.#stopWithError(socket, message.message);
        }
      }
    });

    socket.on("pong", () => {
      if (this.#socket === socket) this.#awaitingPong = false;
    });

    socket.on("close", () => {
      if (this.#socket !== socket) return;
      this.#stopHeartbeat();
      this.#socket = undefined;
      this.#ready = false;
      this.#handlers?.disconnected?.();
      if (!this.#closed) this.#options.onConnectionStateChange?.("reconnecting");
      this.#scheduleReconnect();
    });

    socket.on("error", (error) => {
      this.#handlers?.error?.(error.message || "Relay transport error", true);
      // close drives reconnect; transport errors must not terminate the Pi process.
    });
  }

  #startHeartbeat(socket: WebSocket): void {
    this.#stopHeartbeat();
    const heartbeatIntervalMs = this.#options.heartbeatIntervalMs ?? 30_000;
    this.#heartbeatTimer = setInterval(() => {
      if (this.#socket !== socket || socket.readyState !== WebSocket.OPEN) return;
      if (this.#awaitingPong) {
        socket.terminate();
        return;
      }
      this.#awaitingPong = true;
      socket.ping();
    }, heartbeatIntervalMs);
    this.#heartbeatTimer.unref?.();
  }

  #stopHeartbeat(): void {
    if (this.#heartbeatTimer) clearInterval(this.#heartbeatTimer);
    this.#heartbeatTimer = undefined;
    this.#awaitingPong = false;
  }

  #stopWithError(socket: WebSocket, message: string): void {
    if (this.#socket !== socket) return;
    this.#stopHeartbeat();
    this.#ready = false;
    this.#closed = true;
    this.#options.onConnectionStateChange?.("error");
    this.#handlers?.error?.(message, false);
    socket.close(1008, message);
  }

  #scheduleReconnect(): void {
    if (this.#closed || this.#options.reconnect === false || this.#reconnectTimer) return;
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = undefined;
      void this.#connect();
    }, this.#reconnectDelayMs);
    this.#reconnectTimer.unref?.();
    this.#reconnectDelayMs = Math.min(
      this.#reconnectDelayMs * 2,
      this.#options.maxReconnectDelayMs ?? 30_000,
    );
  }
}
