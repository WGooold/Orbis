/**
 * Host 的端到端验证（spec §10 的 M1 / M2 验收）。
 *
 * 这里起的是真的 Relay、真的 HostService，以及一个用同一套 e2e 原语实现的假手机。
 * 两端各自独立推导密钥，不共享任何中间值——这正是互操作契约的意义所在。
 *
 * 假手机同时是**手机侧行为的参考实现**：它按 `device.path` 的宣布切换出站路径、
 * 自动回声 `ping` 探针。Android 侧要做的也是这两件事。
 */
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket, { type RawData } from "ws";

import {
  DeviceHandshake,
  E2eChannel,
  buildPairEnvelope,
  buildPlaintextEnvelope,
  createDevicePairingSession,
  decodePairingQrText,
  encodePairingQrText,
  fromBase64Url,
  generateX25519KeyPair,
  readHandshakeEnvelope,
  readPairEnvelope,
  verifyPairAccept,
  type PairingQrPayload,
} from "@pi-remote/e2e";
import {
  LOOPBACK_PATH,
  PROTOCOL_VERSION,
  decodeArtifactChunkFrame,
  encodeArtifactChunkFrame,
  type EnvelopeV2,
  type PathKind,
  type RuntimeEvent,
  type RuntimeMetadata,
} from "@pi-remote/protocol";
import { createRelayServer, type RelayServer } from "@pi-remote/relay";

import { HostService } from "./host-service.js";
import { CodexAppServer } from "./codex-daemon.js";
import { CodexRuntime } from "./codex-runtime.js";
import { DshRuntime } from "./dsh-runtime.js";
import type { DshConnection } from "./dsh-client.js";
import { ActivationError, type SessionSpawner } from "./spawner.js";

type EnvelopeFrame = { type?: unknown; envelope?: unknown };

/** 单条路径上的信封队列。只在握手阶段用——握手之后帧直接交给设备层。 */
class EnvelopeQueue {
  readonly #items: EnvelopeV2[] = [];
  readonly #waiters = new Set<(envelope: EnvelopeV2) => void>();

  get size(): number {
    return this.#items.length;
  }

  push(envelope: EnvelopeV2): void {
    for (const waiter of this.#waiters) {
      this.#waiters.delete(waiter);
      waiter(envelope);
      return;
    }
    this.#items.push(envelope);
  }

  async next(timeoutMs = 5_000): Promise<EnvelopeV2> {
    const queued = this.#items.shift();
    if (queued !== undefined) return queued;
    return await new Promise<EnvelopeV2>((resolve, reject) => {
      const waiter = (envelope: EnvelopeV2): void => {
        clearTimeout(timer);
        resolve(envelope);
      };
      const timer = setTimeout(() => {
        this.#waiters.delete(waiter);
        reject(new Error(`等待 v2 帧超时（${timeoutMs}ms）`));
      }, timeoutMs);
      this.#waiters.add(waiter);
    });
  }
}

/**
 * 裸 TCP 代理，只为「把 Host 到中继的连接掐一次」而存在。
 *
 * 选 TCP 层而不是 ws 层：WebSocket 的握手、帧、ping/pong 本来就都是字节，原样转发就够，
 * 不必理解协议语义。测试里只有 Host 走这条路，所以掐它绝不会碰到手机那条连接。
 */
class TcpProxy {
  readonly url: string;
  readonly #server: ReturnType<typeof createServer>;
  readonly #sockets: Set<Socket>;

  private constructor(input: { server: ReturnType<typeof createServer>; sockets: Set<Socket>; url: string }) {
    this.#server = input.server;
    this.#sockets = input.sockets;
    this.url = input.url;
  }

  static async listen(targetUrl: string): Promise<TcpProxy> {
    const target = new URL(targetUrl);
    const sockets = new Set<Socket>();
    const server = createServer((client) => {
      const peer = connect({ host: target.hostname, port: Number(target.port) });
      sockets.add(client);
      sockets.add(peer);
      client.on("close", () => sockets.delete(client));
      peer.on("close", () => sockets.delete(peer));
      // 任一侧出错就把一对连接一起拆掉，不留半死状态。
      client.on("error", () => peer.destroy());
      peer.on("error", () => client.destroy());
      client.pipe(peer);
      peer.pipe(client);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("代理没拿到端口");
    return new TcpProxy({ server, sockets, url: `ws://127.0.0.1:${address.port}` });
  }

  /** 掐掉当前所有连接（含 Host 那条中继 WebSocket）。 */
  dropAll(): void {
    for (const socket of [...this.#sockets]) socket.destroy();
    this.#sockets.clear();
  }

  async close(): Promise<void> {
    this.dropAll();
    await new Promise<void>((resolve) => {
      this.#server.close(() => resolve());
    });
  }
}

/**
 * 到达手机侧的一帧。
 *
 * 分成两支，是因为**拆封必须按到达顺序完成**：AEAD 的序号是强制的，先拆后拆会影响校验。
 * 而测试是「按需取用」的，所以这里在帧到达的那一刻就拆开它（探针就地回声），业务载荷的
 * 明文再交给测试取用。否则只要有一帧没被及时取走，后面同一路径上的探针就会撞上「序号
 * 空洞」——一个与被测行为毫无关系的异常，却会把整轮测试染红。
 */
type Incoming =
  | { kind: PathKind; envelope: EnvelopeV2 }
  | { kind: PathKind; payload: Buffer };

/** 一条路径的假手机端：一个 socket + 一套只属于这条路径的会话密钥。 */
class TestPath {
  readonly kind: PathKind;
  readonly socket: WebSocket;
  readonly #onIncoming: (incoming: Incoming) => void;
  /** 已到达但还没拆的帧。拆封顺序必须与到达顺序一致（见 `#drain`）。 */
  readonly #pending: EnvelopeV2[] = [];
  #draining = false;
  #channel: E2eChannel | undefined;
  #room = "";
  #hostId = "";
  #deviceId = "";
  /** 握手阶段帧归自己；握手完成后交给设备层。 */
  #handshaking = false;
  readonly #queue = new EnvelopeQueue();

  constructor(kind: PathKind, socket: WebSocket, onIncoming: (incoming: Incoming) => void) {
    this.kind = kind;
    this.socket = socket;
    this.#onIncoming = onIncoming;
    socket.on("message", (raw: RawData, isBinary: boolean) => {
      if (isBinary) return;
      let decoded: EnvelopeFrame;
      try {
        decoded = JSON.parse(raw.toString()) as EnvelopeFrame;
      } catch {
        return;
      }
      if (decoded.type !== "v2.frame") return;
      const envelope = decoded.envelope as EnvelopeV2;
      if (this.#handshaking) {
        this.#queue.push(envelope);
        return;
      }
      this.#pending.push(envelope);
      this.#drain();
    });
  }

  /**
   * 按到达顺序拆帧：探针就地原样回声（让对端算得出这条路自己的往返，§6.2 选路的输入），
   * 业务帧把明文交给上层。
   */
  #drain(): void {
    if (this.#draining) return;
    this.#draining = true;
    try {
      for (let envelope = this.#pending.shift(); envelope !== undefined; envelope = this.#pending.shift()) {
        // 配对与握手帧本来就没有会话密钥，原样转交。
        if (envelope.hdr.k === "pair" || envelope.hdr.k === "hs") {
          this.#onIncoming({ kind: this.kind, envelope });
          continue;
        }
        const payload = this.open(envelope);
        if (envelope.hdr.k === "ping") {
          this.seal("ping", payload);
          continue;
        }
        this.#onIncoming({ kind: this.kind, payload });
      }
    } finally {
      this.#draining = false;
    }
  }

  static async open(input: {
    kind: PathKind;
    url: string;
    onIncoming: (incoming: Incoming) => void;
  }): Promise<TestPath> {
    const socket = new WebSocket(input.url);
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    return new TestPath(input.kind, socket, input.onIncoming);
  }

  get ready(): boolean {
    return this.#channel !== undefined;
  }

  /** HS1 → HS2 → HS3，密钥全部由自己这一侧算出来。 */
  async openChannel(pskRoot: Buffer, room: string, hostId: string, deviceId: string): Promise<void> {
    const handshake = new DeviceHandshake(pskRoot);
    this.#room = room;
    this.#hostId = hostId;
    this.#deviceId = deviceId;
    this.#handshaking = true;

    this.send(buildPlaintextEnvelope({
      kind: "hs",
      room,
      from: deviceId,
      to: hostId,
      body: handshake.start(),
    }));
    const accept = readHandshakeEnvelope(await this.#queue.next());
    if (accept.type !== "hs2") throw new Error(`期望 hs2，收到 ${accept.type}`);
    this.send(buildPlaintextEnvelope({
      kind: "hs",
      room,
      from: deviceId,
      to: hostId,
      body: handshake.accept(accept),
    }));

    this.#channel = new E2eChannel({ keys: handshake.keys, role: "device" });
    // 从这里起这条路径上的帧都是业务帧，交给设备层。
    this.#handshaking = false;
  }

  send(envelope: EnvelopeV2): void {
    this.socket.send(JSON.stringify({ type: "v2.frame", protocolVersion: PROTOCOL_VERSION, envelope }));
  }

  seal(kind: "data" | "bin" | "ping", payload: Uint8Array): EnvelopeV2 {
    const channel = this.#channel;
    if (channel === undefined) throw new Error(`${this.kind} 上的握手尚未完成`);
    const envelope = channel.seal(
      { k: kind, room: this.#room, from: this.#deviceId, to: this.#hostId, n: channel.nextSequence("ctl"), ch: "ctl" },
      payload,
    );
    this.send(envelope);
    return envelope;
  }

  open(envelope: EnvelopeV2): Buffer {
    const channel = this.#channel;
    if (channel === undefined) throw new Error(`${this.kind} 上的握手尚未完成`);
    const payload = channel.open(envelope);
    // 测试里没有重放场景：拿到 undefined 说明用例本身发错了帧。
    if (payload === undefined) throw new Error("unexpected stale frame in test");
    return payload;
  }

  close(): void {
    this.socket.close();
  }
}

/** 模拟手机：只持有 QR 里带过来的东西，其余全部自己算。 */
class TestDevice {
  readonly deviceId: string;
  readonly #paths = new Map<PathKind, TestPath>();
  /** 手机侧认定的「现在该往哪条路发」——来自 Host 的 `device.path` 宣布。 */
  #active: PathKind | undefined;
  readonly #inbox: Incoming[] = [];
  readonly #waiters = new Set<(incoming: Incoming) => void>();

  private constructor(deviceId: string) {
    this.deviceId = deviceId;
  }

  /** 扫二维码 → 用 code 换管道凭据 → 连上 Relay。 */
  static async connect(input: {
    relayUrl: string;
    relayHttpBase: string;
    qrText: string;
    deviceName: string;
  }): Promise<{ device: TestDevice; payload: PairingQrPayload }> {
    const payload = decodePairingQrText(input.qrText);

    const response = await fetch(`${input.relayHttpBase}/v1/pairings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: payload.code, deviceName: input.deviceName }),
    });
    if (!response.ok) throw new Error(`配对码兑换失败：HTTP ${response.status}`);
    const paired = await response.json() as { deviceId: string; credential: string };

    const socket = new WebSocket(`${input.relayUrl}/v1/device`);
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    socket.send(JSON.stringify({
      type: "device.authenticate",
      protocolVersion: PROTOCOL_VERSION,
      credential: paired.credential,
    }));

    const device = new TestDevice(paired.deviceId);
    device.#install("relay", socket);
    return { device, payload };
  }

  /** 按二维码里的 LAN 地址再开一条直连路径。 */
  async openLanPath(url: string): Promise<void> {
    const path = await TestPath.open({
      kind: "lan",
      url,
      onIncoming: (incoming) => this.#deliver(incoming),
    });
    this.#paths.set("lan", path);
  }

  /** 走完 PAIR_REQUEST / PAIR_ACCEPT，返回供后续握手使用的 pskRoot。 */
  async pair(payload: PairingQrPayload): Promise<Buffer> {
    const session = createDevicePairingSession({
      hostPublicRaw: fromBase64Url(payload.hostPub, "hostPub"),
      psk: fromBase64Url(payload.psk, "psk"),
      deviceId: this.deviceId,
      deviceKeyPair: generateX25519KeyPair(),
    });
    this.#require("relay").send(buildPairEnvelope({
      room: payload.hostId,
      from: this.deviceId,
      to: payload.hostId,
      body: session.request,
    }));

    const accept = readPairEnvelope(await this.nextEnvelope());
    if (accept.type !== "pair-accept") throw new Error(`期望 pair-accept，收到 ${accept.type}`);
    verifyPairAccept(session, accept);
    return session.pskRoot;
  }

  async openChannel(kind: PathKind, pskRoot: Buffer, room: string, hostId: string): Promise<void> {
    await this.#require(kind).openChannel(pskRoot, room, hostId, this.deviceId);
  }

  get active(): PathKind | undefined {
    return this.#active;
  }

  /** 发一条加密业务消息，并把封好的信封原样返回，供「线上只有密文」的断言使用。 */
  sendData(text: string): EnvelopeV2 {
    return this.sendPayload(Buffer.from(text, "utf8"));
  }

  sendPayload(payload: Uint8Array): EnvelopeV2 {
    return this.#outbound().seal("data", payload);
  }

  /** 上传分片走的是 `bin` 帧：与下载回程同一条路、同一套密钥，只是方向相反。 */
  sendBinary(payload: Uint8Array): EnvelopeV2 {
    return this.#outbound().seal("bin", payload);
  }

  sendCommand(runtimeId: string, commandId: string, command: unknown): EnvelopeV2 {
    return this.sendPayload(Buffer.from(JSON.stringify({
      type: "runtime.command",
      protocolVersion: PROTOCOL_VERSION,
      runtimeId,
      commandId,
      command,
    }), "utf8"));
  }

  /** 收到 Host 发来的加密业务消息，同时报告它落在哪条路上。 */
  async receivePayloadWithPath(): Promise<{ kind: PathKind; payload: Buffer }> {
    const incoming = await this.nextIncoming();
    if (!("payload" in incoming)) throw new Error("期待业务帧，收到握手/配对帧");
    return { kind: incoming.kind, payload: incoming.payload };
  }

  async receivePayload(): Promise<Buffer> {
    return (await this.receivePayloadWithPath()).payload;
  }

  /** 停止从 socket 读取（模拟慢网络/手机来不及收），Relay 侧 bufferedAmount 会堆积。 */
  pauseIncoming(): void {
    for (const path of this.#paths.values()) path.socket.pause();
  }

  resumeIncoming(): void {
    for (const path of this.#paths.values()) path.socket.resume();
  }

  async receiveData(): Promise<string> {
    return (await this.receivePayload()).toString("utf8");
  }

  /** 收到 Host 发来的明文 JSON 载荷（`device.ready` / `device.path` / `runtime.event` …）。 */
  async receiveMessage(): Promise<Record<string, unknown>> {
    const { payload } = await this.receivePayloadWithPath();
    const message = JSON.parse(payload.toString("utf8")) as Record<string, unknown>;
    // 手机跟着 Host 的宣布切换出站路径——这就是 §14 B4「当前链路可见」背后的机制。
    if (message.type === "device.path" && typeof message.path === "string") {
      this.#active = message.path as PathKind;
    }
    return message;
  }

  /** 等一条**握手/配对**帧（那时还没有会话密钥，拿到的是信封本身）。 */
  async nextEnvelope(timeoutMs = 5_000): Promise<EnvelopeV2> {
    const incoming = await this.nextIncoming(timeoutMs);
    if (!("envelope" in incoming)) throw new Error("期待握手/配对帧，收到业务帧");
    return incoming.envelope;
  }

  async nextIncoming(timeoutMs = 5_000): Promise<Incoming> {
    const queued = this.#inbox.shift();
    if (queued !== undefined) return queued;
    return await new Promise((resolve, reject) => {
      const waiter = (incoming: Incoming): void => {
        clearTimeout(timer);
        resolve(incoming);
      };
      const timer = setTimeout(() => {
        this.#waiters.delete(waiter);
        reject(new Error(`等待 v2 帧超时（${timeoutMs}ms）`));
      }, timeoutMs);
      this.#waiters.add(waiter);
    });
  }

  /** 等的必须是某条指定路径上的帧。用来断言「Host 确实把这条消息发到了这条路上」。 */
  async expectOn(kind: PathKind, timeoutMs = 5_000): Promise<Record<string, unknown>> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`等 ${kind} 上的帧超时（${timeoutMs}ms）`);
      const incoming = await this.nextIncoming(remaining);
      if (incoming.kind !== kind) continue;
      // 拆封已经在 TestPath 里按到达顺序做过了，这里只关心「这条路上送来了什么」。
      if (!("payload" in incoming)) continue;
      const message = JSON.parse(incoming.payload.toString("utf8")) as Record<string, unknown>;
      if (message.type === "device.path" && typeof message.path === "string") {
        this.#active = message.path as PathKind;
      }
      return message;
    }
  }

  close(): void {
    for (const path of this.#paths.values()) path.close();
  }

  closePath(kind: PathKind): void {
    const path = this.#paths.get(kind);
    if (path === undefined) return;
    this.#paths.delete(kind);
    path.close();
  }

  #install(kind: PathKind, socket: WebSocket): void {
    this.#paths.set(kind, new TestPath(kind, socket, (incoming) => this.#deliver(incoming)));
  }

  #deliver(incoming: Incoming): void {
    for (const waiter of this.#waiters) {
      this.#waiters.delete(waiter);
      waiter(incoming);
      return;
    }
    this.#inbox.push(incoming);
  }

  #require(kind: PathKind): TestPath {
    const path = this.#paths.get(kind);
    if (path === undefined) throw new Error(`没有 ${kind} 路径`);
    return path;
  }

  /** 出站路径：优先用 Host 宣布的那条，还没宣布过就随便挑一条已经握好手的。 */
  #outbound(): TestPath {
    if (this.#active !== undefined) {
      const path = this.#paths.get(this.#active);
      if (path?.ready === true) return path;
    }
    for (const path of this.#paths.values()) {
      if (path.ready) return path;
    }
    throw new Error("还没有任何一条路径完成握手");
  }
}

/**
 * 模拟跑在同一台电脑上的 Pi 进程：它就是 `LoopbackHostTransport` 的对端。
 * 这里直接说协议，是为了让 Host 的 loopback 端点契约被独立验证一次——
 * 扩展那侧的薄封装另有测试覆盖。
 */
class TestRuntime {
  readonly runtimeId: string;
  readonly socket: WebSocket;
  readonly #inbox: Record<string, unknown>[] = [];
  readonly #waiters = new Set<(message: Record<string, unknown>) => void>();

  private constructor(socket: WebSocket, runtimeId: string) {
    this.socket = socket;
    this.runtimeId = runtimeId;
    socket.on("message", (raw: RawData, isBinary: boolean) => {
      if (isBinary) return;
      try {
        this.#push(JSON.parse(raw.toString()) as Record<string, unknown>);
      } catch {
        // 忽略坏帧
      }
    });
  }

  static async connect(input: {
    url: string;
    token: string;
    metadata: RuntimeMetadata;
    credential?: string;
  }): Promise<TestRuntime> {
    const socket = new WebSocket(`${input.url}${LOOPBACK_PATH}`);
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    const runtime = new TestRuntime(socket, input.metadata.runtimeId);
    socket.send(JSON.stringify({
      type: "runtime.authenticate",
      role: "host",
      protocolVersion: PROTOCOL_VERSION,
      credential: input.credential ?? input.token,
      runtime: input.metadata,
    }));
    return runtime;
  }

  async next(timeoutMs = 5_000): Promise<Record<string, unknown>> {
    const queued = this.#inbox.shift();
    if (queued !== undefined) return queued;
    return await new Promise<Record<string, unknown>>((resolve, reject) => {
      const waiter = (message: Record<string, unknown>): void => {
        clearTimeout(timer);
        resolve(message);
      };
      const timer = setTimeout(() => {
        this.#waiters.delete(waiter);
        reject(new Error(`等待 loopback 消息超时（${timeoutMs}ms）`));
      }, timeoutMs);
      this.#waiters.add(waiter);
    });
  }

  publish(sequence: number, event: RuntimeEvent): void {
    this.socket.send(JSON.stringify({
      type: "runtime.event",
      protocolVersion: PROTOCOL_VERSION,
      runtimeId: this.runtimeId,
      sequence,
      event,
    }));
  }

  close(): void {
    this.socket.close();
  }

  #push(message: Record<string, unknown>): void {
    for (const waiter of this.#waiters) {
      this.#waiters.delete(waiter);
      waiter(message);
      return;
    }
    this.#inbox.push(message);
  }
}

describe("host end-to-end over relay", () => {
  let relay: RelayServer | undefined;
  let host: HostService | undefined;
  let device: TestDevice | undefined;
  let runtime: TestRuntime | undefined;
  let stateDir: string | undefined;
  let proxy: TcpProxy | undefined;

  afterEach(async () => {
    runtime?.close();
    device?.close();
    await host?.stop();
    await proxy?.close();
    await relay?.close();
    if (stateDir !== undefined) await rm(stateDir, { recursive: true, force: true });
    relay = undefined;
    host = undefined;
    device = undefined;
    runtime = undefined;
    stateDir = undefined;
    proxy = undefined;
  });

  const startRelay = async (dir: string): Promise<RelayServer> => await createRelayServer({
    port: 0,
    runtimeCredentials: ["runtime-secret"],
    adminToken: "owner-secret",
    stateFile: join(dir, "relay-state.json"),
  });

  /** 配对一台设备并（可选）把它的 LAN 路径也开起来。这一套在下面每个用例里都要走一遍。 */
  const pairDevice = async (input: {
    relay: RelayServer;
    host: HostService;
    deviceName?: string;
    lan?: { host: string; port: number }[];
  }): Promise<{ device: TestDevice; payload: PairingQrPayload; pskRoot: Buffer }> => {
    const opened = await input.host.openPairingWindow(
      input.lan === undefined ? undefined : { lan: input.lan },
    );
    const connected = await TestDevice.connect({
      relayUrl: input.relay.url,
      relayHttpBase: input.relay.url.replace(/^ws/u, "http"),
      qrText: encodePairingQrText(opened.payload),
      deviceName: input.deviceName ?? "Pixel 9",
    });
    const pskRoot = await connected.device.pair(connected.payload);
    return { device: connected.device, payload: opened.payload, pskRoot };
  };

  it("targets sync snapshots and acknowledgements to their requesting device over real encrypted relay sockets", async () => {
    stateDir = await mkdtemp(join(tmpdir(), "pi-remote-sync-"));
    relay = await startRelay(stateDir);
    host = await HostService.create({ relayUrl: relay.url, credential: "runtime-secret", adminToken: "owner-secret",
      stateDir, reconnect: false, lan: false });
    await host.start();
    const first = await pairDevice({ relay, host });
    device = first.device;
    await device.openChannel("relay", first.pskRoot, first.payload.hostId, first.payload.hostId);
    await device.receiveMessage(); await device.receiveMessage();
    const second = await pairDevice({ relay, host });
    try {
      await second.device.openChannel("relay", second.pskRoot, second.payload.hostId, second.payload.hostId);
      await second.device.receiveMessage(); await second.device.receiveMessage();
      const descriptor = host.loopback!.descriptor!;
      runtime = await TestRuntime.connect({ url: descriptor.url, token: descriptor.token,
        metadata: { runtimeId: "pi-sync", name: "sync", cwd: "/work", status: "idle", sessionId: "s" } });
      await runtime.next();
      await device.receiveMessage(); await second.device.receiveMessage();
      const command = { type: "runtime.command", protocolVersion: PROTOCOL_VERSION, runtimeId: "pi-sync", commandId: "original",
        command: { type: "session.sync", sessionId: "s", syncId: "requested", range: "preview", maxEntries: 100 } };
      device.sendPayload(Buffer.from(JSON.stringify(command)));
      const forwarded = await runtime.next();
      expect(forwarded.commandId).not.toBe("original");
      const request = forwarded.command as { syncId: string };
      runtime.publish(1, { type: "command.result", commandId: forwarded.commandId as string, ok: true });
      runtime.publish(2, { type: "session.snapshot", sessionId: "s", syncId: request.syncId,
        range: "preview", cursor: { leafId: null }, mode: "replace", entries: [], complete: true });
      const received = [await device.receiveMessage(), await device.receiveMessage()];
      expect(received).toEqual(expect.arrayContaining([
        expect.objectContaining({ event: expect.objectContaining({ type: "command.result", commandId: "original" }) }),
        expect.objectContaining({ event: expect.objectContaining({ type: "session.snapshot", syncId: "requested" }) }),
      ]));
      runtime.publish(3, { type: "session.snapshot", sessionId: "s", syncId: "unsolicited",
        cursor: { leafId: null }, mode: "replace", entries: [] });
      runtime.publish(4, { type: "tool.started", toolCallId: "barrier", toolName: "test", arguments: {} });
      // A marker on the same msg channel proves all earlier unwanted snapshots were suppressed.
      await expect(second.device.receiveMessage()).resolves.toMatchObject({ event: { type: "tool.started", toolCallId: "barrier" } });
      await expect(device.receiveMessage()).resolves.toMatchObject({ event: { type: "tool.started", toolCallId: "barrier" } });
    } finally { second.device.close(); }
  });

  it("pairs a device, completes the handshake, and carries ciphertext only", async () => {
    stateDir = await mkdtemp(join(tmpdir(), "pi-remote-host-"));
    relay = await startRelay(stateDir);

    const receivedByHost: string[] = [];
    const pairedDeviceIds: string[] = [];
    host = await HostService.create({
      relayUrl: relay.url,
      credential: "runtime-secret",
      adminToken: "owner-secret",
      stateDir,
      reconnect: false,
      lan: false,
      onData: (_deviceId, payload) => {
        receivedByHost.push(payload.toString("utf8"));
      },
      onPaired: (record) => {
        pairedDeviceIds.push(record.deviceId);
      },
    });
    await host.start();

    const paired = await pairDevice({ relay, host });
    device = paired.device;
    expect(pairedDeviceIds).toEqual([device.deviceId]);
    expect(host.devices.map((record) => record.deviceId)).toEqual([device.deviceId]);

    await device.openChannel("relay", paired.pskRoot, paired.payload.hostId, paired.payload.hostId);
    // 握手一完成，Host 就把本机 runtime 目录推过来；此刻还没有 Pi 进程接上。
    await expect(device.receiveMessage()).resolves.toMatchObject({ type: "device.ready", runtimes: [] });
    // 紧接着宣布当前生效路径：只有 Relay 一条可用时它就是 relay（§14 B4）。
    await expect(device.receiveMessage()).resolves.toMatchObject({ type: "device.path", path: "relay" });

    const plaintext = "只在两端存在的明文 ✨";
    const onTheWire = device.sendData(plaintext);
    // Relay 能看到的一切就是 hdr + 一段不透明 base64url：明文一个字节都不出现。
    expect(JSON.stringify(onTheWire)).not.toContain(plaintext);
    expect(onTheWire.ct).not.toContain(Buffer.from(plaintext, "utf8").toString("base64url"));

    await vi.waitFor(() => {
      expect(receivedByHost).toEqual([plaintext]);
    });

    host.sendData(device.deviceId, Buffer.from("回声", "utf8"), "ctl");
    await expect(device.receiveData()).resolves.toBe("回声");
  });

  it("closes the pairing window once consumed and supports revoking the device", async () => {
    stateDir = await mkdtemp(join(tmpdir(), "pi-remote-host-"));
    relay = await startRelay(stateDir);

    host = await HostService.create({
      relayUrl: relay.url,
      credential: "runtime-secret",
      adminToken: "owner-secret",
      stateDir,
      reconnect: false,
      lan: false,
    });
    await host.start();

    const paired = await pairDevice({ relay, host });
    device = paired.device;

    expect(host.pairing.active).toBe(false);
    expect(await host.revokeDevice(device.deviceId)).toBe(true);
    expect(host.devices[0]?.revoked).toBe(true);
  });

  it("把手机的 runtime.command 送到本机 Pi，并把 Pi 的事件送回手机", async () => {
    stateDir = await mkdtemp(join(tmpdir(), "pi-remote-host-"));
    relay = await startRelay(stateDir);

    host = await HostService.create({
      relayUrl: relay.url,
      credential: "runtime-secret",
      adminToken: "owner-secret",
      stateDir,
      reconnect: false,
      lan: false,
    });
    await host.start();

    const paired = await pairDevice({ relay, host });
    device = paired.device;
    await device.openChannel("relay", paired.pskRoot, paired.payload.hostId, paired.payload.hostId);
    await device.receiveMessage();
    await device.receiveMessage();

    const descriptor = host.loopback?.descriptor;
    expect(descriptor).toBeDefined();
    if (descriptor === undefined) throw new Error("loopback 端点没有启动");

    // 认错 Host 的 token 必须在注册之前就被挡掉，否则会静默连上却没有会话。
    const impostor = await TestRuntime.connect({
      url: descriptor.url,
      token: descriptor.token,
      credential: "not-the-token",
      metadata: { runtimeId: "pi-impostor", name: "pi", cwd: "/work", status: "idle" },
    });
    await expect(impostor.next()).resolves.toMatchObject({ type: "protocol.error", code: "unauthorized" });
    impostor.close();

    runtime = await TestRuntime.connect({
      url: descriptor.url,
      token: descriptor.token,
      metadata: { runtimeId: "pi-1", name: "pi", cwd: "/work/project", status: "idle" },
    });
    await expect(runtime.next()).resolves.toMatchObject({ type: "runtime.ready", runtimeId: "pi-1" });
    await expect(device.receiveMessage()).resolves.toMatchObject({
      type: "runtime.online",
      runtime: { runtimeId: "pi-1", cwd: "/work/project" },
    });

    // Git queries terminate at Host and correlate to the registered runtime, without sending
    // anything to the agent. A non-repository returns an explicit empty identity.
    device.sendData(JSON.stringify({
      type: "runtime.git.request", protocolVersion: PROTOCOL_VERSION, runtimeId: "pi-1", requestId: "git-1",
    }));
    await expect(device.receiveMessage()).resolves.toMatchObject({
      type: "runtime.git", requestId: "git-1", runtimeId: "pi-1", cwd: "/work/project", branch: null, commit: null,
    });

    // 手机 → Host → 本机 Pi
    device.sendCommand("pi-1", "cmd-1", { type: "stop" });
    await expect(runtime.next()).resolves.toMatchObject({
      type: "runtime.command",
      runtimeId: "pi-1",
      commandId: "cmd-1",
      command: { type: "stop" },
    });

    // 本机 Pi → Host → 手机
    runtime.publish(1, { type: "runtime.status", status: "running" });
    const statusEvent = (await device.receiveMessage()) as { sequence: number };
    expect(statusEvent).toMatchObject({
      type: "runtime.event",
      runtimeId: "pi-1",
      event: { type: "runtime.status", status: "running" },
    });
    // 序号由 Host 权威重编（issue 02）：不再采纳 Pi 的本机流水，首次用 Date.now() 起步。
    expect(statusEvent.sequence).toBeGreaterThan(0);

    // 目标 runtime 不在线时必须明确回报，手机侧才能据此去拉起进程（§8）。
    device.sendCommand("pi-never-started", "cmd-2", { type: "stop" });
    await expect(device.receiveMessage()).resolves.toMatchObject({
      type: "protocol.error",
      code: "runtime_offline",
      commandId: "cmd-2",
    });
  });

  // issue 02 的验收：`ctl` 插队是常态（mux 让它越过被水位压住的 `msg`），如果事件序号
  // 是全局一条流水，后到的 `ctl` 会把先发出的 `msg` 的水位线永久抬高，手机从此丢掉
  // 所有更小的 `msg` 序号。序号按 (runtimeId, channel) 各自递增之后，跨道倒挂无害。
  it("事件序号按 channel 各自递增：ctl 与 msg 互不挤占", async () => {
    stateDir = await mkdtemp(join(tmpdir(), "pi-remote-host-"));
    relay = await startRelay(stateDir);

    host = await HostService.create({
      relayUrl: relay.url,
      credential: "runtime-secret",
      adminToken: "owner-secret",
      stateDir,
      reconnect: false,
      lan: false,
    });
    await host.start();

    const paired = await pairDevice({ relay, host });
    device = paired.device;
    await device.openChannel("relay", paired.pskRoot, paired.payload.hostId, paired.payload.hostId);
    await expect(device.receiveMessage()).resolves.toMatchObject({ type: "device.ready" });
    await device.receiveMessage(); // device.path

    // 先发一条 msg（会被手机慢慢消费），再插一条 ctl，最后再发 msg。
    // 旧实现里第三条的序号如果全局单调，会比第一条 msg 大——手机的高水位线
    // 由此把还没消费的 msg 全部判旧。
    const descriptor = host.loopback?.descriptor;
    if (descriptor === undefined) throw new Error("loopback descriptor 缺失");
    runtime = await TestRuntime.connect({
      url: descriptor.url,
      token: descriptor.token,
      metadata: { runtimeId: "pi-1", name: "pi", cwd: "/work/project", status: "idle" },
    });
    await expect(runtime.next()).resolves.toMatchObject({ type: "runtime.ready", runtimeId: "pi-1" });
    await expect(device.receiveMessage()).resolves.toMatchObject({ type: "runtime.online" });

    runtime.publish(1, { type: "runtime.status", status: "running" });
    const ctl1 = (await device.receiveMessage()) as { sequence: number };
    runtime.publish(2, {
      type: "message.queued", queueId: "q-1", text: "hi", delivery: "steer", state: "accepted",
    });
    const msg1 = (await device.receiveMessage()) as { sequence: number };
    runtime.publish(3, { type: "runtime.status", status: "idle" });
    const ctl2 = (await device.receiveMessage()) as { sequence: number };

    expect(ctl1).toMatchObject({ event: { type: "runtime.status" } });
    expect(msg1).toMatchObject({ event: { type: "message.queued" } });
    expect(ctl2).toMatchObject({ event: { type: "runtime.status" } });
    // 同一道内严格递增；跨道互不挤占。
    expect(ctl2.sequence - ctl1.sequence).toBe(1);
    expect(msg1.sequence).toBeGreaterThan(0);
  });

  it("runtime 不在线时由 Host 就地读盘服务下载（不再依赖产生文件的 Pi 进程）", async () => {
    stateDir = await mkdtemp(join(tmpdir(), "pi-remote-host-"));
    relay = await startRelay(stateDir);

    host = await HostService.create({
      relayUrl: relay.url,
      credential: "runtime-secret",
      adminToken: "owner-secret",
      stateDir,
      reconnect: false,
      lan: false,
    });
    await host.start();

    const paired = await pairDevice({ relay, host });
    device = paired.device;
    await device.openChannel("relay", paired.pskRoot, paired.payload.hostId, paired.payload.hostId);
    // 此刻 loopback 上**一个 Pi 进程都没有**——下载能不能成，全看 Host 自己。
    await expect(device.receiveMessage()).resolves.toMatchObject({ type: "device.ready", runtimes: [] });
    await device.receiveMessage(); // device.path

    const contents = Buffer.from("Host 就地读盘下载的内容 ✨".repeat(128), "utf8");
    const filePath = join(stateDir, "报告.txt");
    await writeFile(filePath, contents);

    // 手机用它记忆里的那个 runtimeId 发起下载——那个进程早就退出了。
    device.sendCommand("pi-already-gone", "dl-1", { type: "file.download", path: filePath });

    const started = await device.receiveMessage();
    expect(started).toMatchObject({
      type: "runtime.event",
      runtimeId: "pi-already-gone",
      event: { type: "artifact.started", commandId: "dl-1", offset: 0 },
    });
    const startedEvent = started.event as Record<string, unknown>;
    const artifact = startedEvent.artifact as Record<string, unknown>;
    expect(artifact.size).toBe(contents.length);
    expect(artifact.path).toBe(filePath);
    expect(artifact.sha256).toMatch(/^[0-9a-f]{64}$/u);
    const transferId = startedEvent.transferId as string;

    // 范围下载：设备索取，Host 只回这一段。分片必须是裸字节（`bin` 帧），
    // 不是被当成 JSON 文本的 `data` 帧——后者正是以前「收到无效的中继服务器消息」的根源。
    device.sendPayload(Buffer.from(JSON.stringify({
      type: "artifact.read",
      protocolVersion: PROTOCOL_VERSION,
      transferId,
      requestId: "r1",
      offset: 0,
      length: contents.length,
    }), "utf8"));
    const chunk = decodeArtifactChunkFrame(await device.receivePayload());
    expect(chunk).toMatchObject({ runtimeId: "pi-already-gone", transferId, offset: 0 });
    expect(Buffer.from(chunk.data)).toEqual(contents);

    // 完成判定在接收方（ADR-0005）：设备声明 done 之后 Host 释放上下文，
    // 之后的 read 必须被明确回绝，不能让设备对着黑洞重传。
    device.sendPayload(Buffer.from(JSON.stringify({
      type: "artifact.done", protocolVersion: PROTOCOL_VERSION, transferId,
    }), "utf8"));
    device.sendPayload(Buffer.from(JSON.stringify({
      type: "artifact.read",
      protocolVersion: PROTOCOL_VERSION,
      transferId,
      requestId: "r2",
      offset: 0,
      length: contents.length,
    }), "utf8"));
    await expect(device.receiveMessage()).resolves.toMatchObject({
      type: "artifact.read.failed",
      transferId,
      requestId: "r2",
      reason: "unknown_transfer",
    });

    // Host 读不到文件（不在索引、路径不存在）时**如实回报失败**，不再回落给 runtime：
    // 下载是 Host→APP，Host 就是这条路上的唯一服务方（spec §9.4）。
    device.sendCommand("pi-already-gone", "dl-2", {
      type: "file.download",
      path: join(stateDir, "not-there.bin"),
    });
    await expect(device.receiveMessage()).resolves.toMatchObject({
      type: "runtime.event",
      runtimeId: "pi-already-gone",
      event: { type: "command.result", commandId: "dl-2", ok: false, status: "failure" },
    });
  });

  it("pull 模式：设备按范围索取，Host 只回被请求的那一段", async () => {
    stateDir = await mkdtemp(join(tmpdir(), "pi-remote-host-"));
    relay = await startRelay(stateDir);
    host = await HostService.create({
      relayUrl: relay.url,
      credential: "runtime-secret",
      adminToken: "owner-secret",
      stateDir,
      reconnect: false,
      lan: false,
    });
    await host.start();
    const paired = await pairDevice({ relay, host });
    device = paired.device;
    await device.openChannel("relay", paired.pskRoot, paired.payload.hostId, paired.payload.hostId);
    await device.receiveMessage(); // device.ready
    await device.receiveMessage(); // device.path

    const filePath = join(stateDir, "pull.bin");
    await writeFile(filePath, Buffer.from([0, 1, 2, 3, 4, 5, 6, 7]));
    device.sendCommand(paired.payload.hostId, "dl-pull", { type: "file.download", path: filePath });
    const started = (await device.receiveMessage()) as { event?: Record<string, unknown> };
    expect(started.event).toMatchObject({ type: "artifact.started" });
    const transferId = started.event?.transferId as string;

    const read = (requestId: string, offset: number, length: number): void => {
      paired.device.sendPayload(Buffer.from(JSON.stringify({
        type: "artifact.read",
        protocolVersion: PROTOCOL_VERSION,
        transferId,
        requestId,
        offset,
        length,
      }), "utf8"));
    };

    // 只请求 [2, 6)：Host 只能回这一段，而不是从头流式推。
    read("r1", 2, 4);
    const chunk = decodeArtifactChunkFrame(await device.receivePayload());
    expect(chunk).toMatchObject({ transferId, offset: 2 });
    expect([...chunk.data]).toEqual([2, 3, 4, 5]);

    // 越界必须回 read.failed，而不是发一段短字节当成功。
    read("r2", 6, 4);
    await expect(device.receiveMessage()).resolves.toMatchObject({
      type: "artifact.read.failed",
      transferId,
      requestId: "r2",
    });

    // done 释放上下文；之后同一 transferId 的 read 必须被明确回绝（不能让设备对着黑洞重传）。
    device.sendPayload(Buffer.from(JSON.stringify({ type: "artifact.done", protocolVersion: PROTOCOL_VERSION, transferId }), "utf8"));
    read("r3", 0, 4);
    await expect(device.receiveMessage()).resolves.toMatchObject({
      type: "artifact.read.failed",
      transferId,
      requestId: "r3",
      reason: "unknown_transfer",
    });
  }, 30_000);

  it("下载以 Host 为寻址目标（runtimeId = hostId）：Host 直接读盘服务，与任何 runtime 无关", async () => {
    stateDir = await mkdtemp(join(tmpdir(), "pi-remote-host-"));
    relay = await startRelay(stateDir);

    host = await HostService.create({
      relayUrl: relay.url,
      credential: "runtime-secret",
      adminToken: "owner-secret",
      stateDir,
      reconnect: false,
      lan: false,
    });
    await host.start();

    const paired = await pairDevice({ relay, host });
    device = paired.device;
    await device.openChannel("relay", paired.pskRoot, paired.payload.hostId, paired.payload.hostId);
    await expect(device.receiveMessage()).resolves.toMatchObject({ type: "device.ready" });
    await device.receiveMessage(); // device.path

    const contents = Buffer.from("这是对 Host 的下载请求\n".repeat(64), "utf8");
    const filePath = join(stateDir, "host-addressed.txt");
    await writeFile(filePath, contents);

    // 手机把下载请求**直接发给 Host**（runtimeId = hostId），而不是发给某个 agent 进程。
    device.sendCommand(paired.payload.hostId, "h-dl-1", { type: "file.download", path: filePath });

    const started = await device.receiveMessage();
    expect(started).toMatchObject({
      type: "runtime.event",
      runtimeId: paired.payload.hostId,
      event: { type: "artifact.started", commandId: "h-dl-1", offset: 0 },
    });
    const startedEvent = started.event as Record<string, unknown>;
    const transferId = startedEvent.transferId as string;
    device.sendPayload(Buffer.from(JSON.stringify({
      type: "artifact.read",
      protocolVersion: PROTOCOL_VERSION,
      transferId,
      requestId: "hr-1",
      offset: 0,
      length: contents.length,
    }), "utf8"));
    const chunk = decodeArtifactChunkFrame(await device.receivePayload());
    expect(Buffer.from(chunk.data)).toEqual(contents);
  });

  it("中继链路抖动重连后要能重新握手（出口必须重挂，否则手机 HS1 石沉大海）", async () => {
    stateDir = await mkdtemp(join(tmpdir(), "pi-remote-host-"));
    relay = await startRelay(stateDir);

    // 一个裸 TCP 代理挡在 Host 和 Relay 之间。掐掉它就等于「Host 那条中继连接断了一次」，
    // 而手机那条连接（直连 Relay）毫发无伤——这正是真实世界里 Host 侧链路抖动的样子：
    // 中继进程自己没重启，只有 Host 这边的 socket 掉了，所以手机不会主动重连。
    proxy = await TcpProxy.listen(relay.url);

    const relayStates: string[] = [];
    host = await HostService.create({
      relayUrl: proxy.url,
      credential: "runtime-secret",
      adminToken: "owner-secret",
      stateDir,
      lan: false,
      onStateChange: (state) => relayStates.push(state),
    });
    await host.start();

    const paired = await pairDevice({ relay, host });
    device = paired.device;
    await device.openChannel("relay", paired.pskRoot, paired.payload.hostId, paired.payload.hostId);
    await expect(device.receiveMessage()).resolves.toMatchObject({ type: "device.ready" });
    await expect(device.receiveMessage()).resolves.toMatchObject({ type: "device.path", path: "relay" });

    proxy.dropAll();
    await vi.waitFor(() => {
      expect(relayStates).toContain("reconnecting");
    }, { timeout: 5_000 });
    await vi.waitFor(() => {
      expect(host?.relayState).toBe("connected");
    }, { timeout: 5_000 });

    // 手机在**同一条**中继连接上重新握手（它压根不知道 Host 那边断过）。
    // Host 侧入口必须还在：链路对象留在地图里不会重建，出口却会随 detach 一起被摘掉。
    await device.openChannel("relay", paired.pskRoot, paired.payload.hostId, paired.payload.hostId);
    await expect(device.receiveMessage()).resolves.toMatchObject({ type: "device.ready" });
    await expect(device.receiveMessage()).resolves.toMatchObject({ type: "device.path", path: "relay" });

    // 通道真的又能干活：一条业务消息走通整条路。
    host.sendData(device.deviceId, Buffer.from("抖动之后还能说话", "utf8"), "ctl");
    await expect(device.receiveData()).resolves.toBe("抖动之后还能说话");
  });

  it("手机重开（同一条中继路上重新握手）也要重新拿到 runtime 目录", async () => {
    stateDir = await mkdtemp(join(tmpdir(), "pi-remote-host-"));
    relay = await startRelay(stateDir);

    host = await HostService.create({
      relayUrl: relay.url,
      credential: "runtime-secret",
      adminToken: "owner-secret",
      stateDir,
      reconnect: false,
      lan: false,
    });
    await host.start();

    const paired = await pairDevice({ relay, host });
    device = paired.device;
    await device.openChannel("relay", paired.pskRoot, paired.payload.hostId, paired.payload.hostId);
    await expect(device.receiveMessage()).resolves.toMatchObject({ type: "device.ready", runtimes: [] });
    await expect(device.receiveMessage()).resolves.toMatchObject({ type: "device.path", path: "relay" });

    // 电脑上跑着一个 Pi 进程。
    const descriptor = host.loopback?.descriptor;
    if (descriptor === undefined) throw new Error("loopback 端点没有启动");
    runtime = await TestRuntime.connect({
      url: descriptor.url,
      token: descriptor.token,
      metadata: {
        runtimeId: "pi-restart",
        name: "pi",
        cwd: "/work/repo",
        status: "idle",
        hostname: "devbox",
      },
    });
    await expect(runtime.next()).resolves.toMatchObject({ type: "runtime.ready" });
    await expect(device.receiveMessage()).resolves.toMatchObject({
      type: "runtime.online",
      runtime: { runtimeId: "pi-restart" },
    });

    // 一轮对话结束：turn_end 那份 metadata 采样自「run 仍活跃」（status=running），
    // 随后 agent_settled 发的是状态事件 idle。目录会被整份重播，所以两者必须同源，
    // 否则手机每次重连都收到一份「运行中」的目录，而 Pi 空闲时再没有事件能纠正它。
    runtime.publish(1, {
      type: "runtime.metadata",
      metadata: { runtimeId: "pi-restart", name: "pi", cwd: "/work/repo", status: "running", hostname: "devbox" },
    });
    await expect(device.receiveMessage()).resolves.toMatchObject({
      type: "runtime.event",
      event: { type: "runtime.metadata" },
    });
    runtime.publish(2, { type: "runtime.status", status: "idle" });
    await expect(device.receiveMessage()).resolves.toMatchObject({
      type: "runtime.event",
      event: { type: "runtime.status", status: "idle" },
    });

    // slash 命令词表：目录重播不带它，而手机侧的 device.ready / runtime.online 会把它清掉，
    // 所以重连后必须单独补发一次——否则 `/` 菜单要等下一轮 turn 结束才回来。
    runtime.publish(3, {
      type: "runtime.capabilities",
      capabilities: { commands: [{ name: "model", description: "切换模型", source: "builtin" }] },
    });
    await expect(device.receiveMessage()).resolves.toMatchObject({
      type: "runtime.event",
      event: { type: "runtime.capabilities" },
    });

    // Pi 仍持有一个未完成交互。手机关闭期间它不会重新发送 requested，
    // 因而重开必须由 Host 反向请求 resync，而不是只依赖目录重播。
    runtime.publish(4, {
      type: "interaction.requested",
      request: {
        runtimeId: "pi-restart",
        requestId: "request-reconnect",
        extensionId: "ask-user-question",
        kind: "confirm",
        title: "Continue after reconnect?",
        expiresAt: Date.now() + 60_000,
      },
    });
    await expect(device.receiveMessage()).resolves.toMatchObject({
      type: "runtime.event",
      event: { type: "interaction.requested", request: { requestId: "request-reconnect" } },
    });

    // 手机被关掉再打开：它连的还是那条中继，而 Host 这边**没有任何路径变化**——

    // 链路对象还在（`#links` 从不重建），生效路径也还是 relay（`detach` 从未发生，
    // 因为 Host 根本不知道手机的 socket 断过）。这是用户实际遇到的场景：
    // 「第一次打开没问题，重开就只剩一个 cwd 是用户目录的假进程」。
    expect(host.activePathOf(device.deviceId)).toBe("relay");
    await device.openChannel("relay", paired.pskRoot, paired.payload.hostId, paired.payload.hostId);

    // 目录必须**重新**送到，而且状态要是刚发过的 idle（不是上一份 metadata 的 running）。
    // 挂在「路径变了」上的话，这里一条消息都不会来。
    await expect(device.receiveMessage()).resolves.toMatchObject({
      type: "device.ready",
      runtimes: [expect.objectContaining({ runtimeId: "pi-restart", status: "idle" })],
    });
    await expect(device.receiveMessage()).resolves.toMatchObject({ type: "device.path", path: "relay" });
    // 词表和目录一样是「本机事实」，重连后一并补上，`/` 菜单才不会空着。
    await expect(device.receiveMessage()).resolves.toMatchObject({
      type: "runtime.event",
      runtimeId: "pi-restart",
      event: { type: "runtime.capabilities", capabilities: { commands: [expect.objectContaining({ name: "model" })] } },
    });
    // 手机重开时，Host 还必须让 Pi 重播当前交互；否则目录和 waiting 状态都恢复了，
    // 但待回答问题本身只存在于 Pi SDK 内存，手机无法渲染详情页。
    await expect(runtime.next()).resolves.toEqual({
      type: "runtime.resync",
      runtimeId: "pi-restart",
      reason: "device_reconnected",
    });
  });

  it("同局域网的设备先握 LAN 就直接走 LAN，拔掉 LAN 立刻回落 Relay", async () => {
    stateDir = await mkdtemp(join(tmpdir(), "pi-remote-host-"));
    relay = await startRelay(stateDir);

    const receivedByHost: string[] = [];
    const pathChanges: string[] = [];
    host = await HostService.create({
      relayUrl: relay.url,
      credential: "runtime-secret",
      adminToken: "owner-secret",
      stateDir,
      reconnect: false,
      // 端口交给系统分配：CI 上 42130 可能已被别的进程占着。
      lanPort: 0,
      // 探测间隔调小，让「两条路都有基准」这件事在测试里是确定的。
      probeIntervalMs: 30,
      onData: (_deviceId, payload) => {
        receivedByHost.push(payload.toString("utf8"));
      },
      onPathChange: (_deviceId, change) => {
        pathChanges.push(String(change.to));
      },
    });
    await host.start();
    const lanPort = host.lan?.port;
    if (lanPort === undefined) throw new Error("LAN 端点没有启动");

    const paired = await pairDevice({
      relay,
      host,
      lan: [{ host: "127.0.0.1", port: lanPort }],
    });
    device = paired.device;

    // 新配对可直接用二维码里的地址；已有配对可通过加密会话刷新地址。
    expect(paired.payload.lan).toEqual([{ host: "127.0.0.1", port: lanPort }]);

    // 手机先连上 LAN 并在那条路上握手：Host 首次选路就该选 LAN（§6.2 的优先级）。
    await device.openLanPath(`ws://127.0.0.1:${lanPort}/v1/lan`);
    await device.openChannel("lan", paired.pskRoot, paired.payload.hostId, paired.payload.hostId);
    await expect(device.receiveMessage()).resolves.toMatchObject({ type: "device.ready" });
    await expect(device.receiveMessage()).resolves.toMatchObject({ type: "device.path", path: "lan" });
    expect(device.active).toBe("lan");
    expect(host.activePathOf(device.deviceId)).toBe("lan");

    // 之后 Relay 那条也握上手：已经生效的 LAN 不该被换掉（换路要有证据，不是先到先得）。
    await device.openChannel("relay", paired.pskRoot, paired.payload.hostId, paired.payload.hostId);
    // 每次握手完成都会收到一份回执（目录 + 生效路径），而且走的是**刚握好的那条路**——
    // Host 手里那条「生效路径」可能早就死了。这里它宣布的仍是 lan（路径并没有变）。
    await expect(device.expectOn("relay")).resolves.toMatchObject({ type: "device.ready" });
    await expect(device.expectOn("relay")).resolves.toMatchObject({ type: "device.path", path: "lan" });
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(host.activePathOf(device.deviceId)).toBe("lan");

    device.sendData(JSON.stringify({ type: "host.lan.request", protocolVersion: PROTOCOL_VERSION }));
    await expect(device.receiveMessage()).resolves.toEqual({
      type: "host.lan",
      protocolVersion: PROTOCOL_VERSION,
      endpoints: host.lan?.endpoints,
    });

    // LAN 上的业务帧确实是通的，Host 的出站推送也落在 LAN 上。
    device.sendData("走局域网的一条消息");
    await vi.waitFor(() => {
      expect(receivedByHost).toEqual(["走局域网的一条消息"]);
    });
    host.sendData(device.deviceId, Buffer.from("LAN 上的回声", "utf8"), "ctl");
    await expect(device.receivePayloadWithPath()).resolves.toMatchObject({ kind: "lan" });

    // 拔掉 LAN：必须**立刻**回落 Relay，并且明确告诉手机（§14 B3）。
    device.closePath("lan");
    await expect(device.expectOn("relay")).resolves.toMatchObject({ type: "device.path", path: "relay" });
    const service = host;
    const subject = paired.device;
    await vi.waitFor(() => {
      expect(service.activePathOf(subject.deviceId)).toBe("relay");
    });
    expect(pathChanges).toContain("lan");
    expect(pathChanges).toContain("relay");

    // 回落之后业务照旧，不需要重新配对，也不需要重新握手。
    host.sendData(device.deviceId, Buffer.from("回到中继", "utf8"), "ctl");
    await expect(device.receiveData()).resolves.toBe("回到中继");
  });

  it("拒绝未配对设备的 LAN 连接", async () => {
    stateDir = await mkdtemp(join(tmpdir(), "pi-remote-host-"));
    relay = await startRelay(stateDir);

    host = await HostService.create({
      relayUrl: relay.url,
      credential: "runtime-secret",
      adminToken: "owner-secret",
      stateDir,
      reconnect: false,
      lanPort: 0,
    });
    await host.start();
    const lanPort = host.lan?.port;
    if (lanPort === undefined) throw new Error("LAN 端点没有启动");

    // 谁都能连上这个端口，但拿不出 pskRoot 就换不到一条会话——所以不认识的 deviceId 直接断开，
    // 免得给未认证的连接留会话位。
    const socket = new WebSocket(`ws://127.0.0.1:${lanPort}/v1/lan`);
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    const closed = new Promise<number>((resolve) => {
      socket.once("close", (code) => resolve(code));
    });
    socket.send(JSON.stringify({
      type: "v2.frame",
      protocolVersion: PROTOCOL_VERSION,
      envelope: buildPlaintextEnvelope({
        kind: "hs",
        room: "h",
        from: "device-never-paired",
        to: "host",
        body: { type: "hs1", ePubD: "AAAA" },
      }),
    }));
    await expect(closed).resolves.toBe(1008);
  });

  /** 取一个空闲端口：LAN 端点必须绑在**固定**端口上，重复实例才能被认出来。 */
  async function freeTcpPort(): Promise<number> {
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
    const address = probe.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    return port;
  }

  it("同一个 LAN 端口上的第二个 Host 直接拒绝启动，不去抢中继身份", async () => {
    stateDir = await mkdtemp(join(tmpdir(), "pi-remote-host-"));
    relay = await startRelay(stateDir);
    const lanPort = await freeTcpPort();
    host = await HostService.create({
      relayUrl: relay.url,
      credential: "runtime-secret",
      adminToken: "owner-secret",
      stateDir,
      reconnect: false,
      lanPort,
      log: () => {},
    });
    await host.start();
    expect(host.lan?.port).toBe(lanPort);

    // 上一个 Host 没退干净就被再次拉起（CI 里很常见）：第二个实例必须报错退出。
    // 静默降级去连中继会让两个 Host 用同一个 runtime 身份互相踢，手机端表现为
    // 状态卡在「运行中」、聊天不再更新。
    const duplicate = await HostService.create({
      relayUrl: relay.url,
      credential: "runtime-secret",
      adminToken: "owner-secret",
      stateDir,
      reconnect: false,
      lanPort,
      log: () => {},
    });
    await expect(duplicate.start()).rejects.toThrow(/已被占用/);
    await duplicate.stop();
    // 第一个实例仍然服务：拒绝启动的第二个不能把它的路径或 loopback 发现文件弄坏。
    expect(host.lan?.port).toBe(lanPort);
  });
  describe("手机上传文件（接收方驱动：Host 拉，手机应答）", () => {
    const uploadDir = (dir: string): string => join(dir, ".pi-remote-uploads");

    const initUpload = (device: TestDevice, directory: string, fileName: string, data: Buffer): void => {
      device.sendPayload(Buffer.from(JSON.stringify({
        type: "file.upload.init",
        protocolVersion: PROTOCOL_VERSION,
        requestId: "up-1",
        runtimeId: "runtime-a",
        directory,
        fileName,
        size: data.byteLength,
        sha256: createHash("sha256").update(data).digest("hex"),
      }), "utf8"));
    };

    /**
     * 消费 Host 的拉取循环：收到 `file.upload.read` 就应答对应范围的数据；
     * 收到 finished / failed 就原样返回。options 用来注入坏应答（错偏移 / 篡改内容）。
     */
    const nextOutcome = async (
      device: TestDevice,
      data: Buffer,
      uploadId: string,
      state: { served: number; wrongOffset?: boolean; tamper?: boolean },
    ): Promise<Record<string, unknown>> => {
      for (;;) {
        const message = (await device.receiveMessage()) as Record<string, unknown>;
        if (message.type !== "file.upload.read") {
          // 中间的 progress 是纯 UI 事件，继续等真正的收尾消息。
          if (message.type === "file.upload.finished" || message.type === "file.upload.failed") return message;
          continue;
        }
        const offset = message.offset as number;
        const length = message.length as number;
        const slice = data.subarray(offset, offset + length);
        const payload = state.tamper && offset === 0
          ? Buffer.from(slice.map((byte, index) => (index === 0 ? byte ^ 0xff : byte)))
          : Buffer.from(slice);
        const declaredOffset = state.wrongOffset && state.served === 0 ? offset + 1 : offset;
        state.served += 1;
        device.sendBinary(encodeArtifactChunkFrame({
          runtimeId: "runtime-a", transferId: uploadId, offset: declaredOffset, data: payload,
        }));
      }
    };

    it("read 拉取 → 应答 → 收齐自动校验落地；确认收到的字节是原始内容", async () => {
      stateDir = await mkdtemp(join(tmpdir(), "pi-remote-host-"));
      relay = await startRelay(stateDir);
      host = await HostService.create({
        relayUrl: relay.url, credential: "runtime-secret", adminToken: "owner-secret",
        stateDir, reconnect: false, lan: false,
      });
      await host.start();
      const paired = await pairDevice({ relay, host });
      device = paired.device;
      await device.openChannel("relay", paired.pskRoot, paired.payload.hostId, paired.payload.hostId);
      await device.receiveMessage(); // device.ready
      await device.receiveMessage(); // device.path

      // 目录故意不存在：Host 必须自己建出 `.pi-remote-uploads`。
      const directory = uploadDir(stateDir);
      const data = randomBytes(4096);
      initUpload(device, directory, "shot.bin", data);
      const ready = (await device.receiveMessage()) as Record<string, unknown>;
      expect(ready).toMatchObject({ type: "file.upload.ready", receivedBytes: 0 });
      const uploadId = ready.uploadId as string;

      // 不需要手机喊 done：Host 拉满 durableBytes == size 后自己校验、落地。
      const finished = await nextOutcome(device, data, uploadId, { served: 0 });
      expect(finished).toMatchObject({ type: "file.upload.finished", uploadId, fileName: "shot.bin" });
      expect(readFileSync(finished.path as string).equals(data)).toBe(true);
    }, 30_000);

    it("答错偏移的应答被忽略：持久前缀不回退，重拉后照常完成", async () => {
      stateDir = await mkdtemp(join(tmpdir(), "pi-remote-host-"));
      relay = await startRelay(stateDir);
      host = await HostService.create({
        relayUrl: relay.url, credential: "runtime-secret", adminToken: "owner-secret",
        stateDir, reconnect: false, lan: false,
      });
      await host.start();
      const paired = await pairDevice({ relay, host });
      device = paired.device;
      await device.openChannel("relay", paired.pskRoot, paired.payload.hostId, paired.payload.hostId);
      await device.receiveMessage();
      await device.receiveMessage();

      const directory = uploadDir(stateDir);
      const data = randomBytes(2048);
      initUpload(device, directory, "hole.bin", data);
      const ready = (await device.receiveMessage()) as Record<string, unknown>;
      const uploadId = ready.uploadId as string;

      // 第一次应答把偏移写错（模拟迟到/乱序的应答）：Host 忽略它，重拉同一块，仍能收齐。
      const finished = await nextOutcome(device, data, uploadId, { served: 0, wrongOffset: true });
      expect(finished).toMatchObject({ type: "file.upload.finished" });
      expect(readFileSync(finished.path as string).equals(data)).toBe(true);
    }, 30_000);

    it("哈希不匹配：不落地、删临时文件、如实回报", async () => {
      stateDir = await mkdtemp(join(tmpdir(), "pi-remote-host-"));
      relay = await startRelay(stateDir);
      host = await HostService.create({
        relayUrl: relay.url, credential: "runtime-secret", adminToken: "owner-secret",
        stateDir, reconnect: false, lan: false,
      });
      await host.start();
      const paired = await pairDevice({ relay, host });
      device = paired.device;
      await device.openChannel("relay", paired.pskRoot, paired.payload.hostId, paired.payload.hostId);
      await device.receiveMessage();
      await device.receiveMessage();

      const directory = uploadDir(stateDir);
      const data = randomBytes(1024);
      initUpload(device as TestDevice, directory, "bad.bin", data);
      const ready = (await device.receiveMessage()) as Record<string, unknown>;
      const uploadId = ready.uploadId as string;

      // 声明的哈希是 data 的，实际应答的是 tampered：接收方算出来的对不上。
      const failed = await nextOutcome(device, data, uploadId, { served: 0, tamper: true });
      expect(failed).toMatchObject({
        type: "file.upload.failed",
        uploadId,
        code: "hash_mismatch",
      });
      // 坏文件不许以最终名字出现。
      expect(existsSync(join(directory, "bad.bin"))).toBe(false);
    }, 30_000);
  });
});

describe("host 进程激活（spec §8 的 M3 验收）", () => {
  let relay: RelayServer | undefined;
  let host: HostService | undefined;
  let device: TestDevice | undefined;
  let stateDir: string | undefined;
  const extraDirs: string[] = [];

  // 外层 describe 的 startRelay 在自己的作用域里；这里需要一样的 Relay。
  const startRelayLocal = async (dir: string): Promise<RelayServer> => await createRelayServer({
    port: 0,
    runtimeCredentials: ["runtime-secret"],
    adminToken: "owner-secret",
    stateFile: join(dir, "relay-state.json"),
  });

  afterEach(async () => {
    device?.close();
    await host?.stop();
    await relay?.close();
    if (stateDir !== undefined) await rm(stateDir, { recursive: true, force: true });
    for (const dir of extraDirs.splice(0)) await rm(dir, { recursive: true, force: true });
    relay = undefined;
    host = undefined;
    device = undefined;
    stateDir = undefined;
  });

  /** 配对 + 握手 + 吃掉 device.ready / device.path 两条欢迎消息。 */
  const readyDevice = async (input: { host: HostService; relay: RelayServer }): Promise<TestDevice> => {
    const opened = await input.host.openPairingWindow();
    const connected = await TestDevice.connect({
      relayUrl: input.relay.url,
      relayHttpBase: input.relay.url.replace(/^ws/u, "http"),
      qrText: encodePairingQrText(opened.payload),
      deviceName: "Pixel 9",
    });
    const pskRoot = await connected.device.pair(opened.payload);
    await connected.device.openChannel("relay", pskRoot, opened.payload.hostId, opened.payload.hostId);
    await connected.device.receiveMessage(); // device.ready
    await connected.device.receiveMessage(); // device.path
    return connected.device;
  };

  const sendRequest = (device: TestDevice, message: Record<string, unknown>): void => {
    device.sendPayload(Buffer.from(JSON.stringify(message), "utf8"));
  };

  it("session.browse 返回子目录并标出有会话历史的目录", async () => {
    stateDir = await mkdtemp(join(tmpdir(), "pi-remote-host-"));
    const sessionsRoot = await mkdtemp(join(tmpdir(), "pi-remote-sessions-"));
    extraDirs.push(sessionsRoot);
    const projectDir = join(sessionsRoot, "with-history");
    await mkdir(projectDir, { recursive: true });
    await mkdir(join(sessionsRoot, "empty"), { recursive: true });
    // 造一个真会话文件：cwd 的权威来源是文件首行（§8.1）。
    const groupDir = join(sessionsRoot, `--${projectDir.replaceAll(/[\\/:]/gu, "-")}--`);
    await mkdir(groupDir, { recursive: true });
    await writeFile(
      join(groupDir, "2099-01-01T00-00-00-000Z_11111111-2222-3333-4444-555555555555.jsonl"),
      `${JSON.stringify({ type: "session", version: 3, id: "11111111-2222-3333-4444-555555555555", cwd: projectDir })}\n`,
      "utf8",
    );

    relay = await startRelayLocal(stateDir);
    host = await HostService.create({
      relayUrl: relay.url,
      credential: "runtime-secret",
      adminToken: "owner-secret",
      stateDir,
      reconnect: false,
      lan: false,
      sessionsRoot,
    });
    await host.start();
    device = await readyDevice({ host, relay });

    sendRequest(device, { type: "session.browse", protocolVersion: PROTOCOL_VERSION, requestId: "r1", path: sessionsRoot });
    await expect(device.receiveMessage()).resolves.toMatchObject({
      type: "session.browse.result",
      requestId: "r1",
      entries: expect.arrayContaining([
        { name: "with-history", isDir: true, hasSessions: true },
        { name: "empty", isDir: true, hasSessions: false },
      ]),
    });
  });

  it("session.list 返回磁盘扫描出的历史会话", async () => {
    stateDir = await mkdtemp(join(tmpdir(), "pi-remote-host-"));
    const sessionsRoot = await mkdtemp(join(tmpdir(), "pi-remote-sessions-"));
    extraDirs.push(sessionsRoot, `${sessionsRoot}-archived`);
    const groupDir = join(sessionsRoot, "--D--demo--");
    await mkdir(groupDir, { recursive: true });
    await writeFile(
      join(groupDir, "2099-01-01T00-00-00-000Z_11111111-2222-3333-4444-555555555555.jsonl"),
      `${JSON.stringify({ type: "session", version: 3, id: "11111111-2222-3333-4444-555555555555", cwd: "D:\\demo" })}\n`,
      "utf8",
    );

    relay = await startRelayLocal(stateDir);
    host = await HostService.create({
      relayUrl: relay.url,
      credential: "runtime-secret",
      adminToken: "owner-secret",
      stateDir,
      reconnect: false,
      lan: false,
      sessionsRoot,
    });
    await host.start();
    device = await readyDevice({ host, relay });

    sendRequest(device, { type: "session.list", protocolVersion: PROTOCOL_VERSION, requestId: "r2" });
    const message = await device.receiveMessage();
    expect(message).toMatchObject({ type: "session.list.result", requestId: "r2" });
    const sessions = message.sessions as { sessionId: string; cwd: string; agentKind: string }[];
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ sessionId: "11111111-2222-3333-4444-555555555555", cwd: "D:\\demo", agentKind: "pi" });

    for (const archived of [true, false]) {
      sendRequest(device, {
        type: "session.archive", protocolVersion: PROTOCOL_VERSION, requestId: `archive-${archived}`,
        agentKind: "pi", sessionId: "11111111-2222-3333-4444-555555555555", archived,
      });
      expect(await device.receiveMessage()).toMatchObject({ type: "session.archive.changed", archived });
      sendRequest(device, { type: "session.list", protocolVersion: PROTOCOL_VERSION, requestId: `list-${archived}` });
      expect(await device.receiveMessage()).toMatchObject({
        type: "session.list.result", sessions: [{ sessionId: "11111111-2222-3333-4444-555555555555", archived }],
      });
    }
  });

  it("session.list 短 TTL 内复用扫描结果（并发请求不各扫一遍）", async () => {
    stateDir = await mkdtemp(join(tmpdir(), "pi-remote-host-"));
    relay = await startRelayLocal(stateDir);

    // 用可数的 spawner 站不住脚：这里要数的是 **catalog 被调用几次**，所以换 Pi 后端的
    // sessionsRoot 指向一个真实目录，再用文件变化证明「第二次请求没重扫」。
    const sessionsRoot = await mkdtemp(join(tmpdir(), "pi-remote-sessions-"));
    extraDirs.push(sessionsRoot);
    const groupDir = join(sessionsRoot, "--D--demo--");
    await mkdir(groupDir, { recursive: true });
    const writeSession = async (id: string): Promise<void> => {
      await writeFile(
        join(groupDir, `2099-01-01T00-00-00-000Z_${id}.jsonl`),
        `${JSON.stringify({ type: "session", version: 3, id, cwd: "D:\\demo" })}\n`,
        "utf8",
      );
    };
    await writeSession("11111111-2222-3333-4444-555555555555");

    host = await HostService.create({
      relayUrl: relay.url,
      credential: "runtime-secret",
      adminToken: "owner-secret",
      stateDir,
      reconnect: false,
      lan: false,
      sessionsRoot,
    });
    await host.start();
    device = await readyDevice({ host, relay });

    sendRequest(device, { type: "session.list", protocolVersion: PROTOCOL_VERSION, requestId: "c1" });
    const first = await device.receiveMessage();
    expect((first.sessions as unknown[]).length).toBe(1);

    // TTL 内新增一个会话文件：第二次请求应当命中缓存，看不到新文件。
    await writeSession("99999999-8888-7777-6666-555555555555");
    sendRequest(device, { type: "session.list", protocolVersion: PROTOCOL_VERSION, requestId: "c2" });
    const second = await device.receiveMessage();
    expect((second.sessions as unknown[]).length).toBe(1);
  });

  it("session.activate 会失效目录缓存（新建的会话立刻可见）", async () => {
    stateDir = await mkdtemp(join(tmpdir(), "pi-remote-host-"));
    relay = await startRelayLocal(stateDir);

    const sessionsRoot = await mkdtemp(join(tmpdir(), "pi-remote-sessions-"));
    extraDirs.push(sessionsRoot);
    const groupDir = join(sessionsRoot, "--D--proj--");
    await mkdir(groupDir, { recursive: true });
    const writeSession = async (id: string): Promise<void> => {
      await writeFile(
        join(groupDir, `2099-01-01T00-00-00-000Z_${id}.jsonl`),
        `${JSON.stringify({ type: "session", version: 3, id, cwd: "D:\\proj" })}\n`,
        "utf8",
      );
    };
    await writeSession("11111111-2222-3333-4444-555555555555");

    host = await HostService.create({
      relayUrl: relay.url,
      credential: "runtime-secret",
      adminToken: "owner-secret",
      stateDir,
      reconnect: false,
      lan: false,
      sessionsRoot,
      spawner: {
        activate: vi.fn(async () => ({
          pid: 1,
          agentKind: "pi",
          cwd: "D:/proj",
          sessionId: "new-uuid",
          spawnMode: "tui",
          startedAt: 0,
        }) as never),
      } as unknown as SessionSpawner,
    });
    await host.start();
    device = await readyDevice({ host, relay });

    sendRequest(device, { type: "session.list", protocolVersion: PROTOCOL_VERSION, requestId: "a1" });
    await device.receiveMessage();

    sendRequest(device, {
      type: "session.activate",
      protocolVersion: PROTOCOL_VERSION,
      requestId: "a2",
      target: { type: "new", agentKind: "pi", cwd: "D:/proj" },
    });
    expect((await device.receiveMessage()).type).toBe("session.activated");

    // 激活后新增一个会话：缓存已失效，第三次请求必须看到它。
    await writeSession("99999999-8888-7777-6666-555555555555");
    sendRequest(device, { type: "session.list", protocolVersion: PROTOCOL_VERSION, requestId: "a3" });
    const after = await device.receiveMessage();
    expect((after.sessions as unknown[]).length).toBe(2);
  });

  it("session.activate 走注入的 spawner 并回执；失败回 protocol.error 带回 requestId", async () => {
    stateDir = await mkdtemp(join(tmpdir(), "pi-remote-host-"));
    relay = await startRelayLocal(stateDir);

    const activated: Record<string, unknown> = {
      pid: 4321,
      agentKind: "pi",
      cwd: "D:/proj",
      sessionId: "new-uuid",
      spawnMode: "tui",
      startedAt: 0,
    };
    const activate = vi.fn(async () => activated as never);
    host = await HostService.create({
      relayUrl: relay.url,
      credential: "runtime-secret",
      adminToken: "owner-secret",
      stateDir,
      reconnect: false,
      lan: false,
      // mock spawner：不真开进程
      spawner: { activate } as unknown as SessionSpawner,
    });
    await host.start();
    device = await readyDevice({ host, relay });

    sendRequest(device, {
      type: "session.activate",
      protocolVersion: PROTOCOL_VERSION,
      requestId: "r3",
      target: { type: "new", agentKind: "pi", cwd: "D:/proj" },
    });
    await expect(device.receiveMessage()).resolves.toMatchObject({
      type: "session.activated",
      requestId: "r3",
      pid: 4321,
      spawnMode: "tui",
    });
    expect(activate).toHaveBeenCalledWith(expect.objectContaining({
      deviceId: device.deviceId,
      target: { type: "new", agentKind: "pi", cwd: "D:/proj" },
    }));

    // 失败路径：spawner 抛 ActivationError → protocol.error 带回 requestId
    const failing = vi.fn(async () => {
      throw new ActivationError("cwd_missing", "目录不存在：D:/gone");
    });
    const host2 = await HostService.create({
      relayUrl: relay.url,
      credential: "runtime-secret",
      adminToken: "owner-secret",
      stateDir,
      reconnect: false,
      lan: false,
      spawner: { activate: failing } as unknown as SessionSpawner,
    });
    // 复用同一个 Relay；先停掉旧 host 再起第二个，避免互踢。
    await host?.stop();
    host = host2;
    await host.start();
    device = await readyDevice({ host, relay });

    sendRequest(device, {
      type: "session.activate",
      protocolVersion: PROTOCOL_VERSION,
      requestId: "r4",
      // new 目标直达 spawner，正好验证 spawner 抛出的 ActivationError 被映射成 protocol.error。
      target: { type: "new", agentKind: "pi", cwd: "D:/gone" },
    });
    await expect(device.receiveMessage()).resolves.toMatchObject({
      type: "protocol.error",
      code: "cwd_missing",
      requestId: "r4",
    });
  });
});

describe("Codex 虚拟 runtime 接线（spec §7.4 的 M4 验收）", () => {
  let relay: RelayServer | undefined;
  let host: HostService | undefined;
  let device: TestDevice | undefined;
  let stateDir: string | undefined;

  const startRelayLocal = async (dir: string): Promise<RelayServer> => await createRelayServer({
    port: 0,
    runtimeCredentials: ["runtime-secret"],
    adminToken: "owner-secret",
    stateFile: join(dir, "relay-state.json"),
  });

  afterEach(async () => {
    device?.close();
    await host?.stop();
    await relay?.close();
    if (stateDir !== undefined) await rm(stateDir, { recursive: true, force: true });
    relay = undefined;
    host = undefined;
    device = undefined;
    stateDir = undefined;
  });

  /** 配对 + 握手，并把第一条 `device.ready` 原样交出来（`device.path` 留在队列里）。 */
  const readyDeviceCapturing = async (input: {
    host: HostService;
    relay: RelayServer;
  }): Promise<{ device: TestDevice; ready: Record<string, unknown> }> => {
    const opened = await input.host.openPairingWindow();
    const connected = await TestDevice.connect({
      relayUrl: input.relay.url,
      relayHttpBase: input.relay.url.replace(/^ws/u, "http"),
      qrText: encodePairingQrText(opened.payload),
      deviceName: "Pixel 9",
    });
    const pskRoot = await connected.device.pair(opened.payload);
    await connected.device.openChannel("relay", pskRoot, opened.payload.hostId, opened.payload.hostId);
    const ready = (await connected.device.receiveMessage()) as Record<string, unknown>;
    return { device: connected.device, ready };
  };

  /** 配对 + 握手 + 吃掉 device.ready / device.path 两条欢迎消息。 */
  const readyDeviceLocal = async (input: { host: HostService; relay: RelayServer }): Promise<TestDevice> => {
    const { device: connected } = await readyDeviceCapturing(input);
    await connected.receiveMessage(); // device.path
    return connected;
  };

  const sendRequest = (target: TestDevice, message: Record<string, unknown>): void => {
    target.sendPayload(Buffer.from(JSON.stringify(message), "utf8"));
  };

  it("routes DSH activation, bounded sync and stop over the encrypted Host connection", async () => {
    stateDir = await mkdtemp(join(tmpdir(), "orbis-dsh-host-"));
    relay = await startRelayLocal(stateDir);
    const client: DshConnection = {
      onNotification: undefined, onRequest: undefined, onExit: undefined,
      request: vi.fn(async method => method === "session/new" ? { sessionId: "dsh-thread", configOptions: [] } : { sessions: [] }),
      notify: vi.fn(), stop: vi.fn(async () => {}),
    };
    const runtime = new DshRuntime(client, {
      list: async () => [], read: async id => ({ header: { id, cwd: stateDir!, createdAt: 1 }, events: [] }), close: async () => {},
    });
    host = await HostService.create({ relayUrl: relay.url, credential: "runtime-secret", adminToken: "owner-secret", stateDir,
      sessionsRoot: join(stateDir, "pi-sessions"), reconnect: false, lan: false, dshRuntime: runtime });
    try {
      await host.start();
      const ready = await readyDeviceCapturing({ host, relay });
      device = ready.device;
      expect(ready.ready).toMatchObject({ type: "device.ready", agents: ["pi", "dsh"], runtimes: [] });
      await device.receiveMessage();
      sendRequest(device, { type: "session.activate", protocolVersion: PROTOCOL_VERSION, requestId: "dsh-new", target: { type: "new", agentKind: "dsh", cwd: stateDir } });
      const until = async (predicate: (message: Record<string, unknown>) => boolean) => {
        for (let i = 0; i < 16; i++) {
          const message = await device!.receiveMessage() as Record<string, unknown>;
          expect(message.type).not.toBe("protocol.error");
          if (predicate(message)) return message;
        }
        throw new Error("Expected Host response not received");
      };
      expect(await until(message => message.type === "session.activated")).toMatchObject({ agentKind: "dsh", sessionId: "dsh:dsh-thread", spawnMode: "headless" });
      sendRequest(device, { type: "runtime.command", protocolVersion: PROTOCOL_VERSION, runtimeId: "dsh:dsh-thread", commandId: "sync-dsh",
        command: { type: "session.sync", sessionId: "dsh:dsh-thread", syncId: "sync-dsh", range: "preview" } });
      expect(await until(message => (message.event as RuntimeEvent | undefined)?.type === "session.snapshot")).toMatchObject({
        runtimeId: "dsh:dsh-thread", event: { sessionId: "dsh:dsh-thread", entries: [], syncId: "sync-dsh" },
      });
      sendRequest(device, { type: "runtime.command", protocolVersion: PROTOCOL_VERSION, runtimeId: "dsh:dsh-thread", commandId: "stop-dsh", command: { type: "stop" } });
      await until(message => (message.event as { commandId?: string } | undefined)?.commandId === "stop-dsh");
      expect(client.notify).toHaveBeenCalledWith("session/cancel", { sessionId: "dsh-thread" });
    } finally { await runtime.stop(); }
  });

  it("device.ready 带上这台电脑支持的 agent：没启用 Codex 就只有 pi", async () => {
    stateDir = await mkdtemp(join(tmpdir(), "pi-remote-host-"));
    relay = await startRelayLocal(stateDir);
    host = await HostService.create({
      relayUrl: relay.url,
      credential: "runtime-secret",
      adminToken: "owner-secret",
      stateDir,
      reconnect: false,
      lan: false,
    });
    await host.start();
    const { ready } = await readyDeviceCapturing({ host, relay });

    // 手机据此把「新建 Codex 会话」置灰，而不是让人点了再吃一个 agent_unsupported。
    // 这份答案是 Host 独有的事实：Relay 那份种子目录里没有这一项（它也不知道）。
    expect(ready).toMatchObject({ type: "device.ready", agents: ["pi"] });
  });

  it("device.ready 带上的 agent 列表会跟着 Codex 后端打开而变", async () => {
    stateDir = await mkdtemp(join(tmpdir(), "pi-remote-host-"));
    relay = await startRelayLocal(stateDir);
    const runtime = new CodexRuntime({
      server: { request: vi.fn(), notify: vi.fn() } as unknown as CodexAppServer,
      onEvent: () => {},
      // 磁盘 rollout 扫描指到不存在的目录：测试不读本机真实的 ~/.codex/sessions。
      rolloutRoot: join(tmpdir(), "pi-remote-test-no-rollout"),
    });
    host = await HostService.create({
      relayUrl: relay.url,
      credential: "runtime-secret",
      adminToken: "owner-secret",
      stateDir,
      reconnect: false,
      lan: false,
      codexRuntime: runtime,
    });
    await host.start();
    const { ready } = await readyDeviceCapturing({ host, relay });

    expect(ready).toMatchObject({ type: "device.ready", agents: ["pi", "codex"] });
  });

  it("runtime.command 按 runtimeId 路由给 Codex 后端；不支持的命令回 unsupported_command", async () => {
    stateDir = await mkdtemp(join(tmpdir(), "pi-remote-host-"));
    relay = await startRelayLocal(stateDir);
    const events: RuntimeEvent[] = [];
    const runtime = new CodexRuntime({
      server: { request: vi.fn(), notify: vi.fn() } as unknown as CodexAppServer,
      onEvent: (event) => events.push(event),
      rolloutRoot: join(tmpdir(), "pi-remote-test-no-rollout"),
    });
    host = await HostService.create({
      relayUrl: relay.url,
      credential: "runtime-secret",
      adminToken: "owner-secret",
      stateDir,
      reconnect: false,
      lan: false,
      codexRuntime: runtime,
    });
    await host.start();
    device = await readyDeviceLocal({ host, relay });
    events.length = 0;

    // 不认识的命令 → protocol.error（下载类命令不走这里：它们在 Host 层就由下载服务
    // 认领，天然对 codex 可用——见上面「Host 就地读盘」那条用例）。
    sendRequest(device, {
      type: "runtime.command",
      protocolVersion: PROTOCOL_VERSION,
      runtimeId: "codex",
      commandId: "c1",
      command: { type: "slash.execute", name: "clone", args: "" },
    });
    await expect(device.receiveMessage()).resolves.toMatchObject({
      type: "protocol.error",
      code: "unsupported_command",
      commandId: "c1",
    });

    // 认识的命令（stop）→ 不回错误；stop 在没有 turn 时是 no-op。
    sendRequest(device, {
      type: "runtime.command",
      protocolVersion: PROTOCOL_VERSION,
      runtimeId: "codex",
      commandId: "c2",
      command: { type: "stop" },
    });
    await expect(
      Promise.race([
        device.receiveMessage().then((message) => message.type),
        new Promise((resolve) => setTimeout(() => resolve("silence"), 300)),
      ]),
    ).resolves.toBe("silence");
  });

  it("slash.execute：未声明的命令回 unsupported_command；已声明但无会话回 command.result 失败", async () => {
    stateDir = await mkdtemp(join(tmpdir(), "pi-remote-host-"));
    relay = await startRelayLocal(stateDir);
    const runtime = new CodexRuntime({
      server: { request: vi.fn(), notify: vi.fn() } as unknown as CodexAppServer,
      onEvent: () => {},
      rolloutRoot: join(tmpdir(), "pi-remote-test-no-rollout"),
    });
    host = await HostService.create({
      relayUrl: relay.url,
      credential: "runtime-secret",
      adminToken: "owner-secret",
      stateDir,
      reconnect: false,
      lan: false,
      codexRuntime: runtime,
    });
    await host.start();
    device = await readyDeviceLocal({ host, relay });

    // 未声明的 slash 命令（clone）→ 后端认领了 slash 但不认识这条 → unsupported_command。
    sendRequest(device, {
      type: "runtime.command",
      protocolVersion: PROTOCOL_VERSION,
      runtimeId: "codex",
      commandId: "c3",
      command: { type: "slash.execute", name: "clone", args: "" },
    });
    await expect(device.receiveMessage()).resolves.toMatchObject({
      type: "protocol.error",
      code: "unsupported_command",
      commandId: "c3",
    });

    // 已声明的 slash 命令（model）但无活跃会话 → handled，回 command.result 失败。
    sendRequest(device, {
      type: "runtime.command",
      protocolVersion: PROTOCOL_VERSION,
      runtimeId: "codex",
      commandId: "c4",
      command: { type: "slash.execute", name: "model", args: "gpt-5-codex" },
    });
    await expect(device.receiveMessage()).resolves.toMatchObject({
      type: "runtime.event",
      event: { type: "command.result", commandId: "c4", ok: false },
    });
  });

  it("session.list 合并 Codex 目录（catalog 失败时降级为纯 Pi 并不炸）", async () => {
    stateDir = await mkdtemp(join(tmpdir(), "pi-remote-host-"));
    relay = await startRelayLocal(stateDir);
    const runtime = new CodexRuntime({
      server: {
        request: vi.fn(async (method: string) => {
          if (method === "thread/list") {
            return {
              data: [{ id: "th-codex-1", cwd: "D:/codex-repo", preview: "codex 会话", createdAt: 1_782_812_705, updatedAt: 1_782_812_800, turns: [] }],
            };
          }
          throw new Error(`unexpected ${method}`);
        }),
        notify: vi.fn(),
      } as unknown as CodexAppServer,
      onEvent: () => {},
      rolloutRoot: join(tmpdir(), "pi-remote-test-no-rollout"),
    });
    host = await HostService.create({
      relayUrl: relay.url,
      credential: "runtime-secret",
      adminToken: "owner-secret",
      stateDir,
      reconnect: false,
      lan: false,
      sessionsRoot: join(stateDir, "no-such-sessions"),
      codexRuntime: runtime,
    });
    await host.start();
    device = await readyDeviceLocal({ host, relay });

    sendRequest(device, { type: "session.list", protocolVersion: PROTOCOL_VERSION, requestId: "r1" });
    await expect(device.receiveMessage()).resolves.toMatchObject({
      type: "session.list.result",
      requestId: "r1",
      sessions: [expect.objectContaining({ sessionId: "th-codex-1", agentKind: "codex" })],
    });
  });

  it("Codex 空壳不进进程目录；会话激活后 runtime.online 如实重播 cwd", async () => {
    process.env.PI_REMOTE_CODEX_HEAD = "0"; // 别在测试机上真开终端窗口
    stateDir = await mkdtemp(join(tmpdir(), "pi-remote-host-"));
    relay = await startRelayLocal(stateDir);
    const runtime = new CodexRuntime({
      server: {
        request: vi.fn(async (method: string) => {
          if (method === "model/list") {
            return { data: [{ id: "gpt-5.5", displayName: "GPT-5.5", isDefault: true }] };
          }
          if (method === "thread/start") {
            return { thread: {
              id: "th-new-1", cwd: "D:/work/demo", turns: [],
              path: join(stateDir!, "not-yet-created", "rollout-th-new-1.jsonl"),
            } };
          }
          throw new Error(`unexpected ${method}`);
        }),
        notify: vi.fn(),
      } as unknown as CodexAppServer,
      onEvent: () => {},
      rolloutRoot: join(tmpdir(), "pi-remote-test-no-rollout"),
    });
    host = await HostService.create({
      relayUrl: relay.url,
      credential: "runtime-secret",
      adminToken: "owner-secret",
      stateDir,
      reconnect: false,
      lan: false,
      codexRuntime: runtime,
    });
    await host.start();
    const { ready, device: codexDevice } = await readyDeviceCapturing({ host, relay });
    await codexDevice.receiveMessage(); // device.path

    // 启动时没有活跃 thread：目录里不许出现 cwd=homedir 的空壳 Codex（假进程）。
    expect(ready).toMatchObject({ type: "device.ready" });
    expect((ready as { runtimes: Array<{ runtimeId: string }> }).runtimes.map((r) => r.runtimeId))
      .not.toContain("codex");

    // 手机新建 codex 会话 → 激活路径上依次：status + metadata + capabilities 三个事件 →
    // runtime.online 重播（真实 cwd）→ session.activated 回执，快照由 session.sync 单独请求。
    sendRequest(codexDevice, {
      type: "session.activate",
      protocolVersion: PROTOCOL_VERSION,
      requestId: "rc1",
      target: { type: "new", agentKind: "codex", cwd: "D:/work/demo" },
    });
    const types: string[] = [];
    let online: Record<string, unknown> | undefined;
    for (let i = 0; i < 5; i += 1) {
      const message = (await codexDevice.receiveMessage()) as Record<string, unknown>;
      types.push(message.type as string);
      if (message.type === "runtime.online") online = message;
    }
    expect(types).toEqual([
      "runtime.event", // runtime.status
      "runtime.event", // runtime.metadata（模型名/上下文占用，APP 靠它显示）
      "runtime.event", // runtime.capabilities（slash 菜单词表）
      "runtime.online",
      "session.activated",
    ]);
    expect(online).toMatchObject({
      runtime: { runtimeId: "codex:th-new-1", cwd: "D:/work/demo" },
    });

    sendRequest(codexDevice, {
      type: "runtime.command", protocolVersion: PROTOCOL_VERSION,
      runtimeId: "codex:th-new-1", commandId: "new-thread-sync",
      command: { type: "session.sync", sessionId: "th-new-1", syncId: "empty-preview", range: "preview" },
    });
    let snapshot: Record<string, unknown> | undefined;
    for (let i = 0; i < 4; i += 1) {
      const message = await codexDevice.receiveMessage() as Record<string, unknown>;
      expect(message.type, JSON.stringify(message)).not.toBe("protocol.error");
      const event = message.event as Record<string, unknown> | undefined;
      if (event?.type === "session.snapshot") { snapshot = message; break; }
    }
    expect(snapshot).toMatchObject({
      type: "runtime.event", runtimeId: "codex:th-new-1",
      event: {
        type: "session.snapshot", sessionId: "th-new-1", syncId: "empty-preview",
        entries: [], cursor: { leafId: null }, complete: true, hasOlder: false, rangeStatus: "complete",
      },
    });
    codexDevice.close();
  });

  it("手机重连握手后，Host 为活跃 Codex thread 重播 capabilities（slash 菜单不丢）", async () => {
    process.env.PI_REMOTE_CODEX_HEAD = "0";
    stateDir = await mkdtemp(join(tmpdir(), "pi-remote-host-"));
    relay = await startRelayLocal(stateDir);
    const runtime = new CodexRuntime({
      server: {
        request: vi.fn(async (method: string) => {
          if (method === "model/list") return { data: [{ id: "gpt-5.5", displayName: "GPT-5.5", isDefault: true }] };
          if (method === "thread/start") return { thread: { id: "th-reann", cwd: "D:/work/demo", turns: [] } };
          throw new Error(`unexpected ${method}`);
        }),
        notify: vi.fn(),
      } as unknown as CodexAppServer,
      onEvent: () => {},
      rolloutRoot: join(tmpdir(), "pi-remote-test-no-rollout"),
    });
    host = await HostService.create({
      relayUrl: relay.url,
      credential: "runtime-secret",
      adminToken: "owner-secret",
      stateDir,
      reconnect: false,
      lan: false,
      codexRuntime: runtime,
    });
    await host.start();
    const { device: first } = await readyDeviceCapturing({ host, relay });
    await first.receiveMessage(); // device.path
    sendRequest(first, {
      type: "session.activate",
      protocolVersion: PROTOCOL_VERSION,
      requestId: "rc-reann",
      target: { type: "new", agentKind: "codex", cwd: "D:/work/demo" },
    });
    // 等到激活回执（session.activated）为止，不数死帧数。
    for (;;) {
      const message = (await first.receiveMessage()) as Record<string, unknown>;
      if (message.type === "session.activated") break;
    }
    first.close();

    // 第二台设备握手：device.ready/device.path 之后必须收到该 thread 的 capabilities
    // （否则 runtime.online 会像重连那样把菜单清空，slash 又出不来）。
    // announce 走 broadcast（所有设备），这里只关心第二台新设备收到了什么。
    const second = await readyDeviceLocal({ host, relay });
    const seen: string[] = [];
    let capabilities: Record<string, unknown> | undefined;
    // 握手后 Host 会补发固定几条（capabilities + metadata），收集到就够了。
    for (let i = 0; i < 2; i += 1) {
      let message: Record<string, unknown>;
      try {
        message = (await second.receiveMessage()) as Record<string, unknown>;
      } catch {
        break; // 没有更多补发了
      }
      if (message.type === "runtime.event") {
        const event = message.event as Record<string, unknown>;
        seen.push(String(event.type));
        if (event.type === "runtime.capabilities") capabilities = event;
        continue;
      }
      seen.push(String(message.type));
    }
    expect(seen).toContain("runtime.capabilities");
    expect(seen).toContain("runtime.metadata");
    const commands = (capabilities?.capabilities as { commands?: Array<{ name: string }> } | undefined)?.commands ?? [];
    expect(commands.map((command) => command.name)).toContain("model");
    second.close();
  });
});
