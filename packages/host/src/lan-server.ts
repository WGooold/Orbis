/**
 * LAN 直连端点（spec §6.1 的第一级 Path）。
 *
 * 两条设计选择，都是刻意的：
 *
 * 1. **说 WS，不说裸 TCP。** 对端要的东西是「把信封一条条送过去」，而 WS 已经免费提供了
 *    分帧、探活、与 Relay 完全相同的外壳（`v2.frame`）。裸 TCP 要自己写长度前缀和半包处理，
 *    多出来的全是没人看的代码。§6.1 说的「TCP over LAN」是这一级的网络位置，不是要手搓协议。
 * 2. **端口固定、地址来自 QR 或已认证会话。** `pi-remote pair` 是个短命进程，必须在
 *    常驻 Host 还没跑时就能把地址写进二维码，因此端口走配置（默认 42130）。已有配对
 *    通过加密的 host.lan.request 刷新网卡地址，不依赖旧二维码里的 IP。
 *
 * 不设共享密钥：这一级的身份就是 §5.3 的握手本身。首帧的 `hdr.from` 只用来**查出该用哪份
 * `pskRoot`**，真正证明「我是这台设备」的是 HS3 的 MAC。所以未配对的 `deviceId` 直接断开，
 * 理由是不给未认证的连接留会话位，不是怕它伪造。
 */
import { networkInterfaces } from "node:os";
import { WebSocketServer, type WebSocket } from "ws";

import type { PairingQrLanEndpoint } from "@pi-remote/e2e";
import { PROTOCOL_VERSION, V2FrameSchema, type EnvelopeV2 } from "@pi-remote/protocol";

import type { PathSink } from "./device-link.js";
import { describeError } from "./describe-error.js";

/** 默认 LAN 端点端口。写在 spec §4.2 的 `lan[].port` 里，因此要稳定。 */
export const DEFAULT_LAN_PORT = 42130;

/**
 * 设备连 LAN 端点用的路径。
 *
 * 与 Relay 的 `/v1/device` 分开，是因为两者语义不同：Relay 那条要先 `device.authenticate`
 * 换管道身份，LAN 这条直接就从握手开始——同一个端口上不该有两种开场白。
 */
export const LAN_PATH = "/v1/lan";

// Host-only encrypted control messages; the Relay only forwards the opaque envelope.
export type LanDiscoveryRequest = { type: "host.lan.request"; protocolVersion: number };

export function parseLanDiscoveryRequest(value: unknown): LanDiscoveryRequest | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const message = value as Record<string, unknown>;
  if (message.type !== "host.lan.request" || message.protocolVersion !== PROTOCOL_VERSION) return undefined;
  if (Object.keys(message).some((key) => key !== "type" && key !== "protocolVersion")) return undefined;
  return { type: "host.lan.request", protocolVersion: PROTOCOL_VERSION };
}

export type LanConnectionHandler = (deviceId: string, envelope: EnvelopeV2, sink: PathSink) => void;

export type HostLanServerOptions = {
  /** 0 表示让系统分配（测试用）；正式运行时用配置里的固定端口。 */
  port?: number;
  /** 只有已配对且未被撤销的设备才配得到一条 LAN 路径。 */
  resolveDevice: (deviceId: string) => { deviceId: string } | undefined;
  onEnvelope: LanConnectionHandler;
  /** 某台设备的 LAN 连接断开。HostService 据此立刻回落 Relay。 */
  onDeviceOffline?: (deviceId: string) => void;
  log?: (line: string) => void;
};

export class HostLanServer {
  readonly #options: HostLanServerOptions;
  readonly #connections = new Map<string, WebSocket>();
  #server: WebSocketServer | undefined;

  constructor(options: HostLanServerOptions) {
    this.#options = options;
  }

  get port(): number | undefined {
    const address = this.#server?.address();
    return typeof address === "object" && address !== null ? address.port : undefined;
  }

  /** 供二维码使用的 LAN 地址表。未启动或没有非回环网卡时为空。 */
  get endpoints(): readonly PairingQrLanEndpoint[] {
    const port = this.port;
    return port === undefined ? [] : localLanEndpoints(port);
  }

  async start(): Promise<void> {
    const server = new WebSocketServer({ port: this.#options.port ?? DEFAULT_LAN_PORT });
    await new Promise<void>((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
    });
    this.#server = server;
    server.on("connection", (socket) => {
      this.#handleConnection(socket);
    });
    server.on("error", (error: unknown) => {
      this.#options.log?.(`LAN 端点出错：${describeError(error)}`);
    });
  }

  async stop(): Promise<void> {
    for (const socket of this.#connections.values()) socket.terminate();
    this.#connections.clear();
    const server = this.#server;
    this.#server = undefined;
    if (server === undefined) return;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }

  #handleConnection(socket: WebSocket): void {
    let deviceId: string | undefined;
    let closed = false;

    const sink: PathSink = (envelope: EnvelopeV2): void => {
      if (closed) return;
      socket.send(JSON.stringify({ type: "v2.frame", protocolVersion: PROTOCOL_VERSION, envelope }));
    };
    // 交给多路复用器当水位判据：它决定分片什么时候才能写进这条 socket。
    sink.backlog = () => socket.bufferedAmount;

    socket.on("message", (raw, isBinary) => {
      if (isBinary) {
        socket.close(1008, "LAN 端点只接受文本帧");
        return;
      }
      let parsed: ReturnType<typeof V2FrameSchema.safeParse>;
      try {
        parsed = V2FrameSchema.safeParse(JSON.parse(raw.toString()) as unknown);
      } catch {
        return;
      }
      if (!parsed.success) return;
      const { envelope } = parsed.data;

      if (deviceId === undefined) {
        // 首帧只能是握手的第一条：在那之前这条连接没有任何身份，不该被当成一条路径。
        if (envelope.hdr.k !== "hs") {
          socket.close(1008, "LAN 端点首帧必须是握手帧");
          return;
        }
        if (this.#options.resolveDevice(envelope.hdr.from) === undefined) {
          this.#options.log?.(`拒绝未配对设备的 LAN 连接：${envelope.hdr.from}`);
          socket.close(1008, "设备未配对");
          return;
        }
        deviceId = envelope.hdr.from;
        // 同一台设备新开一条连接：旧的让位。两条并存只会让「哪条是活的」变得不可判定。
        const previous = this.#connections.get(deviceId);
        if (previous !== undefined && previous !== socket) previous.close(1000, "被同一设备的新连接替换");
        this.#connections.set(deviceId, socket);
      } else if (envelope.hdr.from !== deviceId) {
        // 一条连接只代表一台设备，否则两条路径的会话会串味。
        socket.close(1008, "LAN 连接不能中途更换设备身份");
        return;
      }

      this.#options.onEnvelope(deviceId, envelope, sink);
    });

    socket.on("close", () => {
      closed = true;
      if (deviceId === undefined) return;
      if (this.#connections.get(deviceId) !== socket) return;
      this.#connections.delete(deviceId);
      this.#options.onDeviceOffline?.(deviceId);
    });

    socket.on("error", () => {
      // 断开已经由 close 处理，这里只负责不让它冒到进程层。
    });
  }
}

/** 本机能被局域网访问到的 IPv4 地址。回环与 APIPA 不算——它们到不了手机。 */
export function localLanEndpoints(
  port: number,
  interfaces: ReturnType<typeof networkInterfaces> = networkInterfaces(),
): PairingQrLanEndpoint[] {
  const seen = new Set<string>();
  const endpoints: PairingQrLanEndpoint[] = [];
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.internal) continue;
      if (entry.family !== "IPv4") continue;
      if (entry.address.startsWith("169.254.")) continue;
      if (seen.has(entry.address)) continue;
      seen.add(entry.address);
      endpoints.push({ host: entry.address, port });
    }
  }
  return endpoints;
}
