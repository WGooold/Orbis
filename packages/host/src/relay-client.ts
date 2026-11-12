/**
 * Host 侧的 Relay 通道（spec §6.1 的 Relay 兜底 Path）。
 *
 * 这个类只做两件事：维持一条已认证的 runtime 连接；搬运 v2 Envelope。
 * 它不解析 Envelope 的内容，也不该解析——这正是「Relay 零知识」的桌面侧一半。
 */
import {
  PROTOCOL_VERSION,
  RelayToRuntimeMessageSchema,
  type EnvelopeV2,
  type EnvelopeChannel,
  type RuntimeMetadata,
} from "@orbis/protocol";
import WebSocket from "ws";
import { NativeQuicSocket, closeRelaySocket, prepareRelaySocket, relayTransportMode,
  type RelaySocket, type RelaySocketOptions, type RelayTransportMode, type RelayTransportKind } from "./relay-socket.js";

export type HostRelayState = "connecting" | "connected" | "reconnecting" | "closed";

export type HostRelayClientOptions = {
  relayUrl: string;
  transportMode?: RelayTransportMode;
  socketOptions?: RelaySocketOptions;
  credential: string;
  runtime: RuntimeMetadata;
  /** 收到对端（手机）发来的 v2 帧。 */
  onFrame: (envelope: EnvelopeV2) => void;
  onStateChange?: (state: HostRelayState) => void;
  /** Relay 明确回绝了一次转发，例如目标设备不在线、或下载路由已丢失（`transferId` 随附）。 */
  onProtocolError?: (code: string, message: string, transferId?: string, targetDeviceId?: string) => void;
  /** Authentication refusals include reconnects, separately from forwarding errors. */
  onAuthenticationError?: (error: RelayAuthenticationError) => void;
  reconnect?: boolean;
  /** 覆盖重连退避上限，测试里用来缩短等待。 */
  maxReconnectDelayMs?: number;
  /** 空闲心跳间隔（协议层 ping）。默认 30s；设 0 关闭。 */
  heartbeatIntervalMs?: number;
};

const INITIAL_RECONNECT_DELAY_MS = 1_000;
const DEFAULT_MAX_RECONNECT_DELAY_MS = 30_000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;
const PROTOCOL_MISMATCH_MESSAGE = "Host 与 Relay 的协议版本不兼容，请将 Orbis Host 和 Relay 更新到最新版本后重试。";

type PendingReady = {
  resolve: () => void;
  reject: (error: unknown) => void;
};

export class RelayAuthenticationError extends Error {
  constructor(readonly code: string, message: string) {
    super(`Relay 认证失败：${code} ${message}`);
    this.name = "RelayAuthenticationError";
  }
}

export class HostRelayClient {
  readonly #options: HostRelayClientOptions;
  #socket: RelaySocket | undefined;
  #mode: RelayTransportMode;
  #kind: RelayTransportKind | undefined;
  #generation = 0;
  #preparation: AbortController | undefined;
  #tasks = new Set<Promise<void>>();
  #handoff: Promise<void> = Promise.resolve();
  #state: HostRelayState = "closed";
  #stopped = true;
  #attempt = 0;
  #pendingReady: PendingReady | undefined;
  #reconnectTimer: NodeJS.Timeout | undefined;
  #heartbeatTimer: NodeJS.Timeout | undefined;
  #awaitingPong = false;

  constructor(options: HostRelayClientOptions) {
    this.#options = options;
    this.#mode = relayTransportMode(options.transportMode);
  }

  get state(): HostRelayState {
    return this.#state;
  }

  get transportMode(): RelayTransportMode { return this.#mode; }
  get transportKind(): RelayTransportKind | undefined { return this.#kind; }

  /** Prepare before retiring the incumbent; only the last requested mode authenticates. */
  setTransportMode(mode: RelayTransportMode): Promise<void> {
    this.#mode = relayTransportMode(mode);
    if (this.#stopped) return Promise.resolve();
    if (this.#state === "connected" && this.#kind === (mode === "quic" ? "quic" : "ws")) {
      this.#generation++;
      this.#preparation?.abort(new Error("Relay transport selection superseded"));
      return Promise.allSettled([...this.#tasks]).then(() => undefined);
    }
    return this.#open();
  }

  /** 连接并等待 Relay 确认 runtime 身份。首次失败直接抛出，不静默重试。 */
  async start(): Promise<void> {
    this.#stopped = false;
    this.#attempt = 0;
    await this.#open();
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    this.#generation++;
    this.#preparation?.abort(new Error("Host Relay stopped"));
    this.#clearReconnect();
    this.#stopHeartbeat();
    this.#pendingReady?.reject(new Error("Host Relay stopped"));
    this.#pendingReady = undefined;
    const socket = this.#socket;
    this.#socket = undefined;
    this.#kind = undefined;
    this.#setState("closed");
    if (socket !== undefined) await closeRelaySocket(socket);
    await Promise.allSettled([...this.#tasks]);
  }

  /**
   * 这条中继连接上**还没发出去的字节数**。
   *
   * 多路复用器拿它当水位判据：`bulk` 只在它低的时候才写进 socket，于是控制帧前面最多
   * 只剩水位那点字节。没有它，分片会一路堆在 socket 里、把后面所有帧（含控制帧）拖住。
   */
  get bufferedAmount(): number {
    const socket = this.#socket;
    if (socket === undefined || socket.readyState !== WebSocket.OPEN) return 0;
    return socket.bufferedAmount;
  }

  get supportsHistoryStreams(): boolean {
    return this.#socket instanceof NativeQuicSocket ? this.#socket.supportsHistoryStreams : this.#socket?.readyState === WebSocket.OPEN;
  }

  /** WS has one shared buffer; QUIC writers account independently per stream. */
  bufferedAmountFor(channel: EnvelopeChannel): number {
    const socket = this.#socket;
    if (socket === undefined || socket.readyState !== WebSocket.OPEN) return 0;
    return socket instanceof NativeQuicSocket ? socket.bufferedAmountFor(channel) : socket.bufferedAmount;
  }

  /** 发送一条 v2 帧。连接未就绪时抛错——调用方此刻应当先让设备重试，而不是缓存。 */
  send(envelope: EnvelopeV2): void {
    const socket = this.#socket;
    if (socket === undefined || socket.readyState !== WebSocket.OPEN || this.#state !== "connected") {
      throw new Error("Relay 连接未就绪，无法发送 v2 帧");
    }
    socket.send(JSON.stringify({ type: "v2.frame", protocolVersion: PROTOCOL_VERSION, envelope }));
  }

  #clearReconnect(): void {
    if (this.#reconnectTimer !== undefined) clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = undefined;
  }

  #open(): Promise<void> {
    this.#clearReconnect();
    const generation = ++this.#generation;
    this.#preparation?.abort(new Error("Relay transport selection superseded"));
    const controller = new AbortController();
    this.#preparation = controller;
    const mode = this.#mode;
    if (this.#socket === undefined) this.#setState(this.#attempt === 0 ? "connecting" : "reconnecting");
    const current = (): boolean => !this.#stopped && generation === this.#generation;
    const operation = (async () => {
      const prepared = await prepareRelaySocket(this.#options.relayUrl, mode, controller.signal, this.#options.socketOptions);
      let owned = false;
      try {
        const handoff = this.#handoff.catch(() => undefined).then(async () => {
          if (!current()) throw new Error("Relay transport selection superseded");
          const old = this.#socket;
          this.#socket = undefined;
          this.#kind = undefined;
          this.#pendingReady?.reject(new Error("Relay transport replaced"));
          this.#pendingReady = undefined;
          this.#stopHeartbeat();
          this.#setState("connecting");
          if (old !== undefined) await closeRelaySocket(old);
          if (!current()) throw new Error("Relay transport selection superseded");
          if (prepared.socket.readyState !== WebSocket.OPEN) throw new Error("Prepared Relay transport closed");
          this.#socket = prepared.socket;
          this.#kind = prepared.kind;
          owned = true;
          try { await this.#authenticate(prepared.socket, controller.signal); }
          catch (error) {
            if (this.#socket === prepared.socket) {
              this.#socket = undefined;
              this.#kind = undefined;
              this.#stopHeartbeat();
            }
            await closeRelaySocket(prepared.socket);
            throw error;
          }
        });
        this.#handoff = handoff;
        await handoff;
      } finally { if (!owned) await closeRelaySocket(prepared.socket); }
    })().finally(() => {
      if (this.#preparation === controller) {
        this.#preparation = undefined;
        if (this.#socket === undefined && !this.#stopped) this.#scheduleReconnect();
      }
    });
    this.#tasks.add(operation);
    void operation.then(() => this.#tasks.delete(operation), () => this.#tasks.delete(operation));
    return operation;
  }

  #authenticate(socket: RelaySocket, signal: AbortSignal): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => pending.reject(new Error("Relay authentication timed out")), 10000);
      const finish = (error?: unknown): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        if (this.#pendingReady === pending) this.#pendingReady = undefined;
        if (error === undefined) resolve(); else reject(error);
      };
      const pending: PendingReady = { resolve: () => finish(), reject: error => finish(error) };
      const abort = (): void => pending.reject(signal.reason);
      this.#pendingReady = pending;
      signal.addEventListener("abort", abort, { once: true });
      socket.on("message", (raw: WebSocket.RawData, isBinary: boolean) => {
        if (this.#socket === socket && !isBinary) this.#handleMessage(raw);
      });
      socket.on("error", (error: unknown) => {
        if (this.#socket === socket) { pending.reject(error); socket.terminate(); }
      });
      socket.on("pong", () => { if (this.#socket === socket) this.#awaitingPong = false; });
      socket.on("close", () => {
        pending.reject(new Error("Relay 连接在就绪前关闭"));
        if (this.#socket !== socket) return;
        this.#socket = undefined;
        this.#kind = undefined;
        this.#stopHeartbeat();
        this.#setState(this.#stopped ? "closed" : "reconnecting");
        if (!this.#stopped && this.#preparation === undefined) this.#scheduleReconnect();
      });
      if (signal.aborted) { abort(); return; }
      if (socket instanceof NativeQuicSocket) socket.activate();
      else this.#startHeartbeat(socket);
      try {
        socket.send(JSON.stringify({
          type: "runtime.authenticate", protocolVersion: PROTOCOL_VERSION,
          credential: this.#options.credential, role: "host", runtime: this.#options.runtime,
        }));
      } catch (error) { pending.reject(error); }
    });
  }

  #handleMessage(raw: WebSocket.RawData): void {
    let parsed: ReturnType<typeof RelayToRuntimeMessageSchema.safeParse>;
    let decoded: unknown;
    try {
      decoded = JSON.parse(raw.toString()) as unknown;
      parsed = RelayToRuntimeMessageSchema.safeParse(decoded);
    } catch {
      return;
    }
    if (!parsed.success) {
      if (decoded !== null && typeof decoded === "object" && "type" in decoded && decoded.type === "runtime.ready" &&
        "protocolVersion" in decoded && decoded.protocolVersion !== PROTOCOL_VERSION) {
        this.#pendingReady?.reject(new Error(PROTOCOL_MISMATCH_MESSAGE));
      }
      return;
    }
    const message = parsed.data;
    switch (message.type) {
      case "runtime.ready":
        this.#attempt = 0;
        this.#setState("connected");
        this.#pendingReady?.resolve();
        this.#pendingReady = undefined;
        return;
      case "v2.frame":
        this.#options.onFrame(message.envelope);
        return;
      case "protocol.error":
        this.#options.onProtocolError?.(message.code, message.message, message.transferId, message.targetDeviceId);
        if (this.#pendingReady !== undefined) {
          const versionMismatch = message.code === "protocol_version_mismatch" ||
            (message.code === "invalid_message" && /issuePaths=[^)]*\bprotocolVersion\b/u.test(message.message));
          const error = versionMismatch ? new Error(PROTOCOL_MISMATCH_MESSAGE) : new RelayAuthenticationError(message.code, message.message);
          this.#pendingReady.reject(error);
          if (error instanceof RelayAuthenticationError) this.#options.onAuthenticationError?.(error);
        }
        return;
      default:
        return;
    }
  }

  #scheduleReconnect(): void {
    if (this.#stopped || this.#reconnectTimer !== undefined) return;
    if (this.#options.reconnect === false) {
      this.#setState("closed");
      return;
    }
    const ceiling = this.#options.maxReconnectDelayMs ?? DEFAULT_MAX_RECONNECT_DELAY_MS;
    const delay = Math.min(INITIAL_RECONNECT_DELAY_MS * 2 ** this.#attempt, ceiling);
    this.#attempt += 1;
    this.#setState("reconnecting");
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = undefined;
      if (this.#stopped) return;
      // 重连期间的失败已经被 socket 的 close 事件接住，这里只需吞掉这次 ready 等待。
      void this.#open().catch(() => undefined);
    }, delay);
    this.#reconnectTimer.unref?.();
  }

  /**
   * 空闲心跳：没有它，代理和负载均衡会把「看起来没事做」的 WS 掐掉。
   * 连续一拍没等到 pong 就主动 terminate——让 close → 重连的既有路径去收拾，
   * 而不是留一条半死的连接让设备帧发出去石沉大海。
   */
  #startHeartbeat(socket: WebSocket): void {
    const intervalMs = this.#options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
    if (intervalMs <= 0) return;
    this.#stopHeartbeat();
    this.#heartbeatTimer = setInterval(() => {
      if (this.#socket !== socket || socket.readyState !== WebSocket.OPEN) return;
      if (this.#awaitingPong) {
        socket.terminate();
        return;
      }
      this.#awaitingPong = true;
      socket.ping();
    }, intervalMs);
  }

  #stopHeartbeat(): void {
    if (this.#heartbeatTimer !== undefined) {
      clearInterval(this.#heartbeatTimer);
      this.#heartbeatTimer = undefined;
    }
    this.#awaitingPong = false;
  }

  #setState(state: HostRelayState): void {
    if (this.#state === state) return;
    this.#state = state;
    this.#options.onStateChange?.(state);
  }
}
