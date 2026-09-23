/**
 * Host 的本机 loopback 端点（spec §7.3）。
 *
 * 它是**本机的一条「本地 Relay」**：说的就是 runtime 侧那套既有协议
 * （`runtime.authenticate` / `runtime.event` / `runtime.command` / `runtime.ready` …）。
 * 之所以复用而不是另起一套，是因为 Pi 扩展那侧只需要换 URL 与凭据，
 * `RuntimeBridgeTransport` 之上的全部语义一行不改——另起一套只会让两侧的语义漂移。
 *
 * loopback 上**不再套 v2 Envelope**。E2E 的边界是「手机 ↔ Host」：Host 已经在明文域里
 * 持有全部会话内容，再在 127.0.0.1 上包一层 AEAD 不增加任何边界，只是自我安慰。
 *
 * 临时 token 的性质是**防手滑，不是安全边界**（见 `LoopbackDescriptorSchema` 的注释）。
 */
import { randomBytes } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";

import {
  LOOPBACK_DESCRIPTOR_FILE,
  LOOPBACK_PATH,
  LoopbackInboundSchema,
  PROTOCOL_VERSION,
  type LoopbackDescriptor,
  type RuntimeCommand,
  type RuntimeEvent,
  type RuntimeMetadata,
} from "@pi-remote/protocol";
import WebSocket, { WebSocketServer } from "ws";

export type HostLoopbackServerOptions = {
  stateDir: string;
  hostId: string;
  log?: (line: string) => void;
  /** 本机 runtime 注册（含 `/reload` 之后带着同一个 runtimeId 重新注册）。 */
  onRuntimeOnline?: (runtime: RuntimeMetadata) => void;
  onRuntimeOffline?: (runtimeId: string, reason: string) => void;
  /** 本机 runtime 推上来的一条事件。 */
  onRuntimeEvent?: (runtimeId: string, sequence: number, event: RuntimeEvent) => void;
  /** 本机 runtime 推上来的二进制帧（artifact 分片）。 */
  onRuntimeFrame?: (runtimeId: string, frame: Buffer) => void;
};

type LocalRuntime = {
  metadata: RuntimeMetadata;
  socket: WebSocket;
  /**
   * 最近一次 `runtime.capabilities`（slash 命令词表）。
   *
   * 目录重播只带 metadata，而手机侧的 `device.ready` / `runtime.online` 会把 capabilities
   * 清掉——不清就会拿着上一个 session 的命令词表。所以重连后必须把这份词表补发一次，
   * 否则 `/` 菜单要等到下一轮 turn 结束（agent_settled 刷新 capabilities）才回来。
   */
  capabilities?: Extract<RuntimeEvent, { type: "runtime.capabilities" }>;
};

const INITIAL_RECONNECT_HINT = "Host 已退出，Pi 扩展会回落到 Relay";

/**
 * 一台机器上跑多个 Host 是合法的（不同 stateDir 就是不同的 Host），
 * 所以 loopback 端口不能固定：固定端口会让第二个 Host 起不来，或者让扩展接到错的那个。
 */
export class HostLoopbackServer {
  readonly #options: HostLoopbackServerOptions;
  readonly #token = randomBytes(32).toString("base64url");
  readonly #runtimes = new Map<string, LocalRuntime>();
  #server: Server | undefined;
  #wss: WebSocketServer | undefined;
  #descriptor: LoopbackDescriptor | undefined;
  #descriptorPath: string | undefined;

  constructor(options: HostLoopbackServerOptions) {
    this.#options = options;
  }

  get descriptor(): LoopbackDescriptor | undefined {
    return this.#descriptor;
  }

  /** 当前在线（已注册且 socket 未关）的本机 runtime。 */
  get runtimes(): readonly RuntimeMetadata[] {
    return [...this.#runtimes.values()].map((entry) => entry.metadata);
  }

  /**
   * 在线 runtime 最近一次上报的命令词表，按 registration 顺序。
   *
   * 手机重连时用它补发：目录只带 metadata，capabilities 靠这个字段单独重播。
   * 没上报过 capabilities 的 runtime（老版扩展）不在结果里。
   */
  runtimeCapabilities(): readonly { runtimeId: string; event: Extract<RuntimeEvent, { type: "runtime.capabilities" }> }[] {
    return [...this.#runtimes.entries()]
      .flatMap(([runtimeId, entry]) => entry.capabilities === undefined
        ? []
        : [{ runtimeId, event: entry.capabilities }]);
  }

  isOnline(runtimeId: string): boolean {
    return this.#runtimes.has(runtimeId);
  }

  /** 绑定 127.0.0.1 上的随机端口，写发现文件。 */
  async start(): Promise<LoopbackDescriptor> {
    if (this.#server !== undefined) throw new Error("loopback 服务已经在运行");

    const wss = new WebSocketServer({ noServer: true });
    const server = createServer();
    server.on("upgrade", (request, socket, head) => {
      if (new URL(request.url ?? "/", "ws://127.0.0.1").pathname !== LOOPBACK_PATH) {
        socket.destroy();
        return;
      }
      wss.handleUpgrade(request, socket, head, (client) => wss.emit("connection", client, request));
    });
    wss.on("connection", (socket) => this.#handleConnection(socket));

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      // 只监听回环地址：这条通道的定位就是「本机」。
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });

    this.#server = server;
    this.#wss = wss;
    const { port } = server.address() as AddressInfo;
    const descriptor: LoopbackDescriptor = {
      version: 1,
      url: `ws://127.0.0.1:${port}`,
      token: this.#token,
      hostId: this.#options.hostId,
      pid: process.pid,
    };
    this.#descriptor = descriptor;
    this.#descriptorPath = join(this.#options.stateDir, LOOPBACK_DESCRIPTOR_FILE);
    await writePrivateJson(this.#descriptorPath, descriptor);
    this.#options.log?.(`loopback 监听 ${descriptor.url}${LOOPBACK_PATH}`);
    return descriptor;
  }

  async stop(): Promise<void> {
    for (const entry of [...this.#runtimes.values()]) {
      entry.socket.close(1001, "host shutdown");
    }
    this.#runtimes.clear();

    const wss = this.#wss;
    const server = this.#server;
    this.#wss = undefined;
    this.#server = undefined;
    this.#descriptor = undefined;

    await new Promise<void>((resolve) => wss?.close(() => resolve()) ?? resolve());
    await new Promise<void>((resolve) => server?.close(() => resolve()) ?? resolve());

    // 发现文件必须比服务先消失：留着一个指向死端口的文件，扩展会连上去然后空等。
    if (this.#descriptorPath !== undefined) {
      await rm(this.#descriptorPath, { force: true });
      this.#descriptorPath = undefined;
    }
  }

  /** 向下行一条命令。目标不在线时返回 `false`，由调用方决定怎么回报设备。 */
  sendCommand(runtimeId: string, commandId: string, command: RuntimeCommand): boolean {
    return this.#send(runtimeId, {
      type: "runtime.command",
      protocolVersion: PROTOCOL_VERSION,
      runtimeId,
      commandId,
      command,
    });
  }

  sendResync(runtimeId: string, reason: string): boolean {
    return this.#send(runtimeId, { type: "runtime.resync", runtimeId, reason });
  }

  /** 关闭一台本机 runtime 的通道（例如它对应的设备会话已经断开）。 */
  disconnect(runtimeId: string, reason: string): void {
    this.#runtimes.get(runtimeId)?.socket.close(1000, reason);
  }

  // ─────────────────────────────────────────────────────────────────────────────

  #handleConnection(socket: WebSocket): void {
    let runtimeId: string | undefined;
    // 注册之前不允许发任何东西：一条未认证的连接不该能把事件灌进设备会话。
    let authenticated = false;

    socket.on("message", (raw, isBinary) => {
      if (isBinary) {
        if (!authenticated || runtimeId === undefined) return;
        this.#options.onRuntimeFrame?.(runtimeId, Buffer.from(raw as ArrayBuffer));
        return;
      }

      let parsed: ReturnType<typeof LoopbackInboundSchema.safeParse>;
      try {
        parsed = LoopbackInboundSchema.safeParse(JSON.parse(raw.toString()) as unknown);
      } catch {
        return;
      }
      if (!parsed.success) {
        this.#options.log?.("loopback 收到不认识的消息，已忽略");
        return;
      }
      const message = parsed.data;

      if (!authenticated) {
        if (message.type !== "runtime.authenticate") {
          socket.close(1008, "loopback 首帧必须是 runtime.authenticate");
          return;
        }
        if (message.credential !== this.#token) {
          // 过期文件 / 认错 Host。这不是攻击面，是「连上了但没有会话」的常见原因。
          socket.send(JSON.stringify({
            type: "protocol.error",
            code: "unauthorized",
            message: "loopback token 不匹配，请确认连的是当前正在运行的 Host",
          }));
          socket.close(1008, "loopback token 不匹配");
          return;
        }
        authenticated = true;
        runtimeId = message.runtime.runtimeId;
        this.#register(socket, message.runtime);
        return;
      }

      const activeRuntimeId = runtimeId;
      if (activeRuntimeId === undefined) {
        socket.close(1008, "loopback 连接状态异常");
        return;
      }
      if (message.type === "runtime.authenticate") {
        socket.close(1008, "loopback 连接不允许重复注册");
        return;
      }
      if (message.type === "v2.frame") {
        // loopback 是本机明文域，没有 Envelope 要搬。
        return;
      }
      if (message.runtimeId !== activeRuntimeId) {
        // 一条连接只代表一个 runtime，否则事件会串味。
        socket.close(1008, "loopback 连接只能上报它自己注册的 runtimeId");
        return;
      }

      switch (message.type) {
        case "runtime.event": {
          const current = this.#runtimes.get(activeRuntimeId);
          if (current !== undefined) {
            // 这份目录是 Host 对「本机有哪些 runtime」的唯一副本，手机每次重连都整份重播。
            // `runtime.status` 必须和 `runtime.metadata` 一样落进缓存：turn 结束时那份 metadata
            // 采样自「run 仍活跃」，状态是 running；紧接着 agent_settled 发的 idle 是状态事件。
            // 只认 metadata 的话缓存就永远停在 running——手机每次重连都收到一份「运行中」的
            // 目录，而 Pi 空闲时不再有事件能纠正它（中继侧缓存就是这么做的，两边对齐）。
            if (message.event.type === "runtime.metadata") {
              current.metadata = message.event.metadata;
            } else if (message.event.type === "runtime.status") {
              current.metadata = { ...current.metadata, status: message.event.status };
            } else if (message.event.type === "runtime.capabilities") {
              // 词表也要落缓存：手机重连后目录重播不会带它，没有缓存就只能等下一次 turn 结束。
              current.capabilities = message.event;
            }
          }
          this.#options.onRuntimeEvent?.(activeRuntimeId, message.sequence, message.event);
          return;
        }
        default:
          return;
      }
    });

    socket.on("close", () => {
      if (runtimeId === undefined) return;
      const entry = this.#runtimes.get(runtimeId);
      if (entry?.socket !== socket) return;
      this.#runtimes.delete(runtimeId);
      this.#options.onRuntimeOffline?.(runtimeId, INITIAL_RECONNECT_HINT);
    });

    socket.on("error", () => {
      // close 事件负责收尾，这里只是别让错误冒到进程顶层。
    });
  }

  #register(socket: WebSocket, metadata: RuntimeMetadata): void {
    const previous = this.#runtimes.get(metadata.runtimeId);
    if (previous !== undefined && previous.socket !== socket) {
      // 同一个 runtimeId 重新注册（典型是 `/reload`）：旧连接先让位。
      previous.socket.close(1000, "loopback 被同一 runtime 的新连接取代");
    }
    this.#runtimes.set(metadata.runtimeId, { metadata, socket });
    socket.send(JSON.stringify({
      type: "runtime.ready",
      protocolVersion: PROTOCOL_VERSION,
      runtimeId: metadata.runtimeId,
    }));
    this.#options.log?.(`loopback 已接入 runtime ${metadata.runtimeId}`);
    this.#options.onRuntimeOnline?.(metadata);
  }

  #send(runtimeId: string, message: unknown): boolean {
    const entry = this.#runtimes.get(runtimeId);
    if (entry === undefined || entry.socket.readyState !== WebSocket.OPEN) return false;
    entry.socket.send(JSON.stringify(message));
    return true;
  }
}

async function writePrivateJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}
