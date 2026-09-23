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
  type RuntimeMetadata,
} from "@pi-remote/protocol";
import WebSocket from "ws";

export type HostRelayState = "connecting" | "connected" | "reconnecting" | "closed";

export type HostRelayClientOptions = {
  relayUrl: string;
  credential: string;
  runtime: RuntimeMetadata;
  /** 收到对端（手机）发来的 v2 帧。 */
  onFrame: (envelope: EnvelopeV2) => void;
  onStateChange?: (state: HostRelayState) => void;
  /** Relay 明确回绝了一次转发，例如目标设备不在线、或下载路由已丢失（`transferId` 随附）。 */
  onProtocolError?: (code: string, message: string, transferId?: string, targetDeviceId?: string) => void;
  reconnect?: boolean;
  /** 覆盖重连退避上限，测试里用来缩短等待。 */
  maxReconnectDelayMs?: number;
  /** 空闲心跳间隔（协议层 ping）。默认 30s；设 0 关闭。 */
  heartbeatIntervalMs?: number;
};

const INITIAL_RECONNECT_DELAY_MS = 1_000;
const DEFAULT_MAX_RECONNECT_DELAY_MS = 30_000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;

type PendingReady = {
  resolve: () => void;
  reject: (error: unknown) => void;
};

export class HostRelayClient {
  readonly #options: HostRelayClientOptions;
  #socket: WebSocket | undefined;
  #state: HostRelayState = "closed";
  #stopped = false;
  #attempt = 0;
  #pendingReady: PendingReady | undefined;
  #reconnectTimer: NodeJS.Timeout | undefined;
  #heartbeatTimer: NodeJS.Timeout | undefined;
  #awaitingPong = false;

  constructor(options: HostRelayClientOptions) {
    this.#options = options;
  }

  get state(): HostRelayState {
    return this.#state;
  }

  /** 连接并等待 Relay 确认 runtime 身份。首次失败直接抛出，不静默重试。 */
  async start(): Promise<void> {
    this.#stopped = false;
    this.#attempt = 0;
    await this.#open();
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#reconnectTimer !== undefined) {
      clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = undefined;
    }
    this.#stopHeartbeat();
    const socket = this.#socket;
    this.#socket = undefined;
    this.#setState("closed");
    if (socket === undefined) return;
    await new Promise<void>((resolve) => {
      socket.once("close", () => resolve());
      socket.close(1000, "host shutdown");
    });
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

  /** 发送一条 v2 帧。连接未就绪时抛错——调用方此刻应当先让设备重试，而不是缓存。 */
  send(envelope: EnvelopeV2): void {
    const socket = this.#socket;
    if (socket === undefined || socket.readyState !== WebSocket.OPEN || this.#state !== "connected") {
      throw new Error("Relay 连接未就绪，无法发送 v2 帧");
    }
    socket.send(JSON.stringify({ type: "v2.frame", protocolVersion: PROTOCOL_VERSION, envelope }));
  }

  #open(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.#setState(this.#attempt === 0 ? "connecting" : "reconnecting");
      const socket = new WebSocket(`${this.#options.relayUrl.replace(/\/$/u, "")}/v1/runtime`);
      this.#socket = socket;
      let settled = false;

      this.#pendingReady = {
        resolve: () => {
          if (settled) return;
          settled = true;
          resolve();
        },
        reject: (error: unknown) => {
          if (settled) return;
          settled = true;
          reject(error);
        },
      };

      socket.on("open", () => {
        this.#startHeartbeat(socket);
        socket.send(JSON.stringify({
          type: "runtime.authenticate",
          protocolVersion: PROTOCOL_VERSION,
          credential: this.#options.credential,
          // Host 在 Relay 眼里是一条 runtime —— 那只是为了让手机能把帧路由到它
          // （`hdr.to = hostId`）。它对手机不是一条「进程」，所以说清楚自己是网关，
          // 免得中继把它当成进程目录里的一条播出去（见 RuntimeRoleSchema）。
          role: "host",
          runtime: this.#options.runtime,
        }));
      });

      socket.on("message", (raw, isBinary) => {
        if (isBinary) return;
        this.#handleMessage(raw);
      });

      socket.on("error", (error: unknown) => {
        this.#pendingReady?.reject(error);
      });

      socket.on("pong", () => {
        this.#awaitingPong = false;
      });

      socket.on("close", () => {
        this.#stopHeartbeat();
        this.#pendingReady?.reject(new Error("Relay 连接在就绪前关闭"));
        this.#pendingReady = undefined;
        if (this.#socket === socket) this.#socket = undefined;
        if (this.#stopped) {
          this.#setState("closed");
          return;
        }
        this.#scheduleReconnect();
      });
    });
  }

  #handleMessage(raw: WebSocket.RawData): void {
    let parsed: ReturnType<typeof RelayToRuntimeMessageSchema.safeParse>;
    try {
      parsed = RelayToRuntimeMessageSchema.safeParse(JSON.parse(raw.toString()) as unknown);
    } catch {
      return;
    }
    if (!parsed.success) return;
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
        return;
      default:
        return;
    }
  }

  #scheduleReconnect(): void {
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
