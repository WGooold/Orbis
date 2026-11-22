// Orbis 测试用途（场景与判定见本文件断言）：
// - OPT-H1 Host 设备回执
/**
 * Host 的端到端验证（spec §10 的 M1 / M2 验收）。
 *
 * 这里起的是真的 Relay、真的 HostService，以及一个用同一套 e2e 原语实现的假手机。
 * 两端各自独立推导密钥，不共享任何中间值——这正是互操作契约的意义所在。
 *
 * 假手机同时是**手机侧行为的参考实现**：它按 `device.path` 的宣布切换出站路径、
 * 自动回声 `ping` 探针。Android 侧要做的也是这两件事。
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { createServer, connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { inflateRawSync } from "node:zlib";
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
  loadDeviceStore,
  readHandshakeEnvelope,
  readPairEnvelope,
  verifyPairAccept,
  type PairingQrPayload,
} from "@orbis/e2e";
import {
  applyStateDelta, type AgentStateDomainSnapshot, type CatalogQueryPage,
  LOOPBACK_PATH,
  DEVICE_FEATURE_MESSAGE_RENDER,
  DEVICE_FEATURE_COMPACT_BOOTSTRAP,
  DEVICE_FEATURE_CLAUDE_SEND_NOW,
  RUNTIME_CLOSE_FEATURE,
  CODEX_UNIFIED_HISTORY,
  PROTOCOL_VERSION,
  HOST_FEATURE_IMPORT_TARGET,
  HOST_FEATURE_WEB_PREVIEW, HOST_FEATURE_NATIVE_FILE_PREVIEW, NATIVE_FILE_PREVIEW_BYTES, FILE_PREVIEW_CHUNK_BYTES,
  RelayToDeviceMessageSchema,
  ToolInventorySource, createToolSummary, createToolContentPage,
  selectSessionSyncSnapshot,
  EnvelopeReassembler,
  fragmentEnvelope,
  decodeArtifactChunkFrame,
  encodeArtifactChunkFrame,
  type ChatMessage,
  type CodexDesktopAttach,
  type EnvelopeV2,
  type PathKind,
  type RuntimeCommand,
  type RuntimeEvent,
  type RuntimeMetadata,
  type ToolContentReadRequest, type ToolInventorySnapshot,
} from "@orbis/protocol";
import { type RelayServer } from "@orbis/relay";
import { createBusinessRelayServer as createRelayServer, relayBusinessHostOptions, restartBusinessHostQUIC } from "./fixtures/relay-business-transport.js";

import type { HermesGatewayRpcClient } from "./hermes-gateway-rpc.js";
import { HostService, channelForDeviceMessage } from "./host-service.js";
import { HostRelayClient } from "./relay-client.js";
import * as pushRelayConfig from "./config.js";
import type { ActivePathChange } from "./device-link.js";
import { CodexAppServer } from "./codex-daemon.js";
import { CodexRuntime } from "./codex-runtime.js";
import { codexHistoryId } from "./codex-history-catalog.js";
import { KimiRuntime } from "./kimi-runtime.js";
import { KimiWebClient } from "./kimi-web-client.js";
import { DshRuntime } from "./dsh-runtime.js";
import { DSH_DESKTOP_FLAVOR } from "./dsh-web-runtime.js";
import type { DshConnection } from "./dsh-client.js";
import type { DshWebConnection } from "./dsh-web-client.js";
import { ActivationError, type SessionSpawner } from "./spawner.js";
import { ProviderManager } from "./provider-manager.js";
import { SessionConfigurationStore } from "./session-configuration-store.js";
import { AgentEnablementController, AgentEnablementStore } from "./agent-enablement.js";
import { OpenCodeServiceConnection, type OpenCodeClient } from "./opencode-service-connection.js";
import { relayBusinessDeviceURL, stopRelayBusinessTransports } from "./fixtures/relay-business-transport.js";

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
  | { kind: PathKind; payload: Buffer; channel?: string };

/** 一条路径的假手机端：一个 socket + 一套只属于这条路径的会话密钥。 */
class TestPath {
  readonly kind: PathKind;
  readonly socket: WebSocket;
  readonly #onIncoming: (incoming: Incoming) => void;
  /** 已到达但还没拆的帧。拆封顺序必须与到达顺序一致（见 `#drain`）。 */
  readonly #pending: EnvelopeV2[] = [];
  readonly #reassembler = new EnvelopeReassembler();
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
        // Match the released phones: HS1 retires the old keys. A prior-session
        // RTT/path update can already be in flight on this same socket; it is
        // neither HS2 nor decryptable with the new session, so ignore it here.
        if (envelope.hdr.k === "data" || envelope.hdr.k === "bin" || envelope.hdr.k === "ping") return;
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
        const complete = this.#reassembler.accept(envelope);
        if (!complete) continue;
        const payload = this.open(complete);
        if (envelope.hdr.k === "ping") {
          this.seal("ping", payload);
          continue;
        }
        this.#onIncoming({ kind: this.kind, payload, channel: complete.hdr.ch! });
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
    const handshake = new DeviceHandshake(pskRoot, this.kind === "relay" && process.env.ORBIS_TEST_HISTORY_STREAMS === "1");
    this.#room = room;
    this.#hostId = hostId;
    this.#deviceId = deviceId;
    this.#channel = undefined;
    this.#reassembler.clear();
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
    if (this.kind === "relay") {
      // Match released Android/iOS: HS3 is followed by an authenticated LAN refresh.
      this.seal("data", Buffer.from(JSON.stringify({ type: "host.lan.request", protocolVersion: PROTOCOL_VERSION })));
    }
  }

  send(envelope: EnvelopeV2): void {
    for (const piece of fragmentEnvelope(envelope)) {
      this.socket.send(JSON.stringify({ type: "v2.frame", protocolVersion: PROTOCOL_VERSION, envelope: piece }));
    }
  }

  seal(kind: "data" | "bin" | "ping", payload: Uint8Array, lane: "ctl" | "bulk" = "ctl"): EnvelopeV2 {
    const channel = this.#channel;
    if (channel === undefined) throw new Error(`${this.kind} 上的握手尚未完成`);
    const envelope = channel.seal(
      { k: kind, room: this.#room, from: this.#deviceId, to: this.#hostId, n: channel.nextSequence(lane), ch: lane },
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
  #initialLanRefreshReplies = 0;
  readonly deviceId: string;
  readonly #paths = new Map<PathKind, TestPath>();
  /** 手机侧认定的「现在该往哪条路发」——来自 Host 的 `device.path` 宣布。 */
  #active: PathKind | undefined;
  readonly #inbox: Incoming[] = [];
  readonly #waiters = new Set<(incoming: Incoming) => void>();

  private constructor(deviceId: string, private readonly relayURL: string, private readonly credential: string) {
    this.deviceId = deviceId;
  }

  async reopenRelay(pskRoot: Buffer, hostId: string): Promise<TestDevice> {
    this.close();
    const next = new TestDevice(this.deviceId, this.relayURL, this.credential);
    try { await next.reconnectRelay(pskRoot, hostId); return next; }
    catch (error) { next.close(); throw error; }
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

    const socket = new WebSocket(await relayBusinessDeviceURL(`${input.relayUrl}/v1/device`));
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    socket.send(JSON.stringify({
      type: "device.authenticate",
      protocolVersion: PROTOCOL_VERSION,
      credential: paired.credential,
    }));

    const device = new TestDevice(paired.deviceId, `${input.relayUrl}/v1/device`, paired.credential);
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
    if (kind === "relay") this.#initialLanRefreshReplies += 1;
    await this.#require(kind).openChannel(pskRoot, room, hostId, this.deviceId);
  }

  /** Reference-phone handover: prepare unauthed, join old socket, then authenticate with the same identity. */
  async replaceRelay(mode: "ws" | "quic", pskRoot: Buffer, hostId: string): Promise<void> {
    const socket = new WebSocket(await relayBusinessDeviceURL(this.relayURL, mode));
    try {
      await new Promise<void>((resolve, reject) => {
        socket.once("open", resolve); socket.once("error", reject);
      });
      const old = this.#require("relay");
      await new Promise<void>(resolve => { old.socket.once("close", resolve); old.close(); });
      this.#install("relay", socket);
      socket.send(JSON.stringify({ type: "device.authenticate", protocolVersion: PROTOCOL_VERSION, credential: this.credential }));
      await this.openChannel("relay", pskRoot, hostId, hostId);
    } catch (error) { socket.close(); throw error; }
  }

  /** 中继掉线后重新连上：socket 打开即认证并发 HS1，与 App 的 socket.open 一致。 */
  async reconnectRelay(pskRoot: Buffer, hostId: string): Promise<void> {
    const socket = new WebSocket(await relayBusinessDeviceURL(this.relayURL));
    await new Promise<void>((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
    this.#install("relay", socket);
    socket.send(JSON.stringify({ type: "device.authenticate", protocolVersion: PROTOCOL_VERSION, credential: this.credential }));
    await this.openChannel("relay", pskRoot, hostId, hostId);
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
  sendBinary(payload: Uint8Array, lane: "ctl" | "bulk" = "ctl"): EnvelopeV2 {
    return this.#outbound().seal("bin", payload, lane);
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
  async receiveMessage(includeNotifications = false): Promise<Record<string, unknown>> {
    const { payload } = await this.receivePayloadWithPath();
    const message = JSON.parse(payload.toString("utf8")) as Record<string, unknown>;
    if (!includeNotifications && message.type === "notification.snapshot") return this.receiveMessage();
    // 手机跟着 Host 的宣布切换出站路径——这就是 §14 B4「当前链路可见」背后的机制。
    if (message.type === "device.path" && typeof message.path === "string") {
      this.#active = message.path as PathKind;
    }
    return message;
  }

  /** Correlated replies may be interleaved with authenticated path/notification
   * updates. Validate those updates without extending the original 5s budget. */
  async receiveReply(requestId: string): Promise<Record<string, unknown>> {
    const deadline = Date.now() + 5_000;
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`等待 ${requestId} 回复超时（5000ms）`);
      const incoming = await this.nextIncoming(remaining);
      if (!("payload" in incoming)) throw new Error("期待回复，收到握手帧");
      const message = JSON.parse(incoming.payload.toString("utf8")) as Record<string, unknown>;
      if (message.type === "device.path" || message.type === "notification.snapshot") {
        const validated = RelayToDeviceMessageSchema.parse(message);
        if (validated.type === "device.path") this.#active = validated.path;
        continue;
      }
      expect(message.requestId).toBe(requestId);
      return message;
    }
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
    if (this.#initialLanRefreshReplies > 0 && "payload" in incoming && incoming.payload[0] === 0x7b) {
      const message = JSON.parse(incoming.payload.toString("utf8")) as { type?: string; protocolVersion?: number };
      if (message.type === "host.lan") {
        // Endpoint refresh is a transport control and can return on the active LAN path.
        expect(message.protocolVersion).toBe(PROTOCOL_VERSION);
        this.#initialLanRefreshReplies -= 1;
        return;
      }
    }
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

describe("device model channel routing", () => {
  it("puts initial and updated execution-only snapshots on ctl, including missing and unchanged responses", () => {
    expect(channelForDeviceMessage({ type: "agent.state.snapshot", scope: "agent", domains: [{ domain: "execution" }] })).toBe("ctl");
    expect(channelForDeviceMessage({ type: "agent.state.snapshot", scope: "agent", missing: [{ domain: "execution" }] })).toBe("ctl");
    expect(channelForDeviceMessage({ type: "agent.state.snapshot", scope: "agent", unchanged: ["execution"] })).toBe("ctl");
    expect(channelForDeviceMessage({ type: "agent.state.snapshot", scope: "agent", domains: [{ domain: "execution" }, { domain: "live" }] })).toBe("msg");
    expect(channelForDeviceMessage({ type: "agent.state.snapshot", scope: "agent", domains: [{ domain: "execution" }], unchanged: ["model"] })).toBe("msg");
    expect(channelForDeviceMessage({ type: "agent.state.snapshot", scope: "agent", domains: [{ domain: "execution" }], missing: [{ domain: "live" }] })).toBe("msg");
    expect(channelForDeviceMessage({ type: "agent.state.snapshot", scope: "host", missing: [{ domain: "execution" }] })).toBe("msg");
    expect(channelForDeviceMessage({ type: "agent.state.range.page" })).toBe("msg");
    expect(channelForDeviceMessage({ type: "session.catalog.page" })).toBe("msg");
  });
});

describe("host end-to-end over relay", () => {
  let relay: RelayServer | undefined;
  let host: HostService | undefined;
  let device: TestDevice | undefined;
  let runtime: TestRuntime | undefined;
  let stateDir: string | undefined;
  let proxy: TcpProxy | undefined;

  it("persists Android version reports received only through the encrypted device channel", async () => {
    stateDir = await mkdtemp(join(tmpdir(), "orbis-android-version-e2e-"));
    relay = await startRelay(stateDir);
    host = await HostService.create({ relayUrl: relay.url, ...relayBusinessHostOptions(relay.url), credential: "runtime-secret", adminToken: "owner-secret", stateDir, reconnect: false, lan: false });
    await host.start();
    const paired = await pairDevice({ relay, host });
    device = paired.device;
    await device.openChannel("relay", paired.pskRoot, paired.payload.hostId, paired.payload.hostId);
    await device.receiveMessage();
    await device.receiveMessage();

    const encrypted = device.sendData(JSON.stringify({
      type: "device.version.report",
      protocolVersion: PROTOCOL_VERSION,
      version: "0.1.49",
      versionCode: 50,
    }));
    expect(JSON.stringify(encrypted)).not.toContain("0.1.49");
    await vi.waitFor(() => expect(host!.devices.find(item => item.deviceId === device!.deviceId)).toMatchObject({ appVersion: "0.1.49", appVersionCode: 50 }));

    await host.stop();
    host = undefined;
    const store = await loadDeviceStore(stateDir);
    expect(store.devices.find(item => item.deviceId === device!.deviceId)).toMatchObject({ appVersion: "0.1.49", appVersionCode: 50 });
  });

  it("lists and switches local provider profiles over an authenticated encrypted channel without exposing secrets", async () => {
    stateDir = await mkdtemp(join(tmpdir(), "orbis-provider-e2e-"));
    relay = await startRelay(stateDir);
    const paths = { pi: join(stateDir, "pi"), codex: join(stateDir, "codex"), dsh: join(stateDir, "dsh") };
    const providers = new ProviderManager(stateDir, paths);
    await providers.save("pi", "custom", "Custom", { apiKey: "never-send-this", baseUrl: "https://example.com/v1", api: "openai-completions", models: [{ id: "model" }] }, true, false, { notes: "private-notes-never-send", usageScript: { enabled: false, language: "javascript", timeout: 10, code: "private-script-never-send" } });
    host = await HostService.create({ relayUrl: relay.url, ...relayBusinessHostOptions(relay.url), credential: "runtime-secret", adminToken: "owner-secret", stateDir, reconnect: false, lan: false, providers });
    await host.start();
    const paired = await pairDevice({ relay, host }); device = paired.device;
    await device.openChannel("relay", paired.pskRoot, paired.payload.hostId, paired.payload.hostId);
    await device.receiveMessage(); await device.receiveMessage();
    device.sendData(JSON.stringify({ type: "provider.list", protocolVersion: PROTOCOL_VERSION, requestId: "list", kind: "pi" }));
    const list = await device.receiveReply("list");
    expect(list).toMatchObject({ type: "provider.result", requestId: "list", providers: [{ id: "custom", enabled: false }] });
    expect(JSON.stringify(list)).not.toContain("never-send-this");
    expect(JSON.stringify(list)).not.toContain("private-notes-never-send");
    expect(JSON.stringify(list)).not.toContain("private-script-never-send");
    // FT-VOICE-PROVIDER-01: authenticated discovery returns only saved profile identity, not credentials.
    device.sendData(JSON.stringify({ type: "voice.cleanup.provider.request", protocolVersion: PROTOCOL_VERSION, requestId: "voice-providers", action: "providers" }));
    expect(await device.receiveReply("voice-providers")).toMatchObject({ type: "voice.cleanup.provider.result", providers: [{ id: "custom", kind: "pi", name: "Custom" }] });
    device.sendData(JSON.stringify({ type: "voice.cleanup.provider.request", protocolVersion: PROTOCOL_VERSION, requestId: "voice-injected", action: "models", kind: "pi", id: "custom", endpoint: "https://another.test/" }));
    expect(await device.receiveReply("voice-injected")).toMatchObject({ type: "protocol.error", code: "invalid_request" });
    device.sendData(JSON.stringify({ type: "provider.switch", protocolVersion: PROTOCOL_VERSION, requestId: "switch", kind: "pi", id: "custom", enabled: true }));
    const switched = await device.receiveReply("switch");
    expect(switched).toMatchObject({ type: "provider.result", requestId: "switch", providers: [{ id: "custom", enabled: true }] });
    expect(JSON.parse(readFileSync(join(paths.pi, "models.json"), "utf8")).providers.custom.apiKey).toBe("never-send-this");
    expect(JSON.stringify(switched)).not.toContain("never-send-this");
    device.sendData(JSON.stringify({ type: "provider.switch", protocolVersion: PROTOCOL_VERSION, requestId: "missing", kind: "pi", id: "missing", enabled: true }));
    expect(await device.receiveReply("missing")).toMatchObject({ type: "provider.result", requestId: "missing", error: expect.any(String) });
    const claude = (await providers.list("claude"))[0]!;
    await providers.save("claude", "vendor", "Vendor", { env: { ANTHROPIC_BASE_URL: "https://vendor.test", ANTHROPIC_AUTH_TOKEN: "claude-secret-never-send" } }, true);
    device.sendData(JSON.stringify({ type: "provider.switch", protocolVersion: PROTOCOL_VERSION, requestId: "claude-switch", kind: "claude", id: "vendor", enabled: true }));
    const claudeResult = await device.receiveReply("claude-switch");
    expect(claudeResult).toMatchObject({ type: "provider.result", requestId: "claude-switch", kind: "claude" });
    expect(JSON.stringify(claudeResult)).not.toContain("claude-secret-never-send");
    await providers.switch("claude", claude.id);
    const quota = { checkedAt: 100, windows: [{ name: "five_hour" as const, remainingPercent: 75, resetsAt: 200 }, { name: "seven_day" as const, remainingPercent: null, resetsAt: null }] };
    const query = vi.spyOn(providers, "querySubscription").mockResolvedValue(quota);
    device.sendData(JSON.stringify({ type: "provider.subscription", protocolVersion: PROTOCOL_VERSION, requestId: "quota", kind: "claude", id: claude.id }));
    expect(await device.receiveReply("quota")).toMatchObject({ type: "provider.subscription.result", requestId: "quota", kind: "claude", id: claude.id, quota });
    expect(query).toHaveBeenCalledWith("claude", claude.id);
    query.mockRejectedValueOnce(new Error("secret-upstream-body"));
    device.sendData(JSON.stringify({ type: "provider.subscription", protocolVersion: PROTOCOL_VERSION, requestId: "quota-failed", kind: "claude", id: claude.id }));
    const failure = await device.receiveReply("quota-failed");
    expect(failure).toMatchObject({ type: "provider.subscription.result", requestId: "quota-failed", id: claude.id, error: expect.any(String) });
    expect(JSON.stringify(failure)).not.toContain("secret-upstream-body");
    query.mockRestore();
  });

  afterEach(async () => {
    runtime?.close();
    device?.close();
    const transportCleanup = await stopRelayBusinessTransports().then(() => undefined, error => error);
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
    if (transportCleanup) throw transportCleanup;
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

  // Default runs exercise WS reconnection; the QUIC run exercises QUIC→WS→QUIC
  // with the same assertions. These are real Host tests, not native mobile/UI tests.
  const handoverModes = (side: "device" | "host"): ("ws" | "quic")[] => ["ws",
    (side === "host" ? process.env.ORBIS_TEST_HOST_TRANSPORT : process.env.ORBIS_TEST_RELAY_TRANSPORT) === "quic" ? "quic" : "ws"];
  const handover = async (side: "device" | "host", mode: "ws" | "quic", psk: Buffer, hostId: string): Promise<void> => {
    if (side === "device") await device!.replaceRelay(mode, psk, hostId);
    else {
      await host!.setRelayTransportMode(mode);
      expect(host!.relayTransportKind).toBe(mode);
      await device!.openChannel("relay", psk, hostId, hostId);
    }
  };
  const readMatching = async (phone: TestDevice, predicate: (message: Record<string, unknown>) => boolean): Promise<Record<string, unknown>> => {
    for (let count = 0; count < 100; count++) {
      const message = await phone.receiveMessage();
      if (message.type === "protocol.error") throw new Error(JSON.stringify(message));
      if (predicate(message)) return message;
    }
    throw new Error("Expected handover business message did not arrive");
  };

  // IMPORT-06: use the real paired link and loopback adapter. A target mismatch must stop both
  // the Host file write and the agent message, even when the supplied runtime ID is valid.
  it("fences external imports at the paired Host and retains legacy command dispatch", async () => {
    stateDir = await mkdtemp(join(tmpdir(), "orbis-import-target-")); relay = await startRelay(stateDir);
    host = await HostService.create({ relayUrl: relay.url, ...relayBusinessHostOptions(relay.url), credential: "runtime-secret",
      adminToken: "owner-secret", stateDir, reconnect: false, lan: false });
    await host.start(); const paired = await pairDevice({ relay, host }); device = paired.device;
    await device.openChannel("relay", paired.pskRoot, paired.payload.hostId, paired.payload.hostId);
    expect(await readMatching(device, message => message.type === "device.ready"))
      .toMatchObject({ hostFeatures: expect.arrayContaining([HOST_FEATURE_IMPORT_TARGET]) });
    await readMatching(device, message => message.type === "device.path");
    const descriptor = host.loopback!.descriptor!;
    const target = { sessionId: "intended", cwd: stateDir };
    const runtimeId = "pi-import";
    runtime = await TestRuntime.connect({ url: descriptor.url, token: descriptor.token,
      metadata: { runtimeId, name: "Import target", status: "idle", ...target } });
    await runtime.next(); await readMatching(device, message => message.type === "runtime.online");
    const receive = async (key: string, id: string) => {
      for (let i = 0; i < 40; ++i) {
        const message = await device!.receiveMessage();
        if (message[key] === id || (message.event as Record<string, unknown> | undefined)?.[key] === id) return message;
      }
      throw new Error(`No correlated reply (${id})`);
    };
    const command = { type: "user_message", text: "Synthetic imported text", messageId: "import-message" } as const;
    const submit = (commandId: string, importTarget: typeof target, body: RuntimeCommand = command) => device!.sendData(JSON.stringify({
      type: "runtime.command", protocolVersion: PROTOCOL_VERSION, runtimeId, commandId, command: body, importTarget,
    }));
    submit("wrong-session", { ...target, sessionId: "different" });
    expect(await receive("commandId", "wrong-session")).toMatchObject({ type: "protocol.error", code: "import_target_changed" });
    submit("steer", target, { ...command, delivery: "steer" });
    expect(await receive("commandId", "steer")).toMatchObject({ type: "protocol.error", code: "invalid_command" });
    submit("unverified-file", target, { ...command, attachments: [join(stateDir, "unverified.txt")] });
    expect(await receive("commandId", "unverified-file")).toMatchObject({ type: "protocol.error", code: "import_attachments_unverified" });
    const bytes = Buffer.from("local fixture file");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const invalidDirectory = join(stateDir, "outside-import-folder");
    device.sendData(JSON.stringify({ type: "file.upload.init", protocolVersion: PROTOCOL_VERSION, runtimeId, requestId: "wrong-directory",
      importTarget: target, fileName: "fixture.txt", directory: invalidDirectory, size: bytes.length, sha256 }));
    expect(await receive("requestId", "wrong-directory")).toMatchObject({ type: "file.upload.failed", code: "import_target_changed" });
    expect(existsSync(invalidDirectory)).toBe(false);

    const directory = join(target.cwd, ".orbis-uploads", sha256);
    device.sendData(JSON.stringify({ type: "file.upload.init", protocolVersion: PROTOCOL_VERSION, runtimeId, requestId: "safe-file",
      importTarget: target, fileName: "fixture.txt", directory, size: bytes.length, sha256 }));
    const { uploadId } = await receive("requestId", "safe-file");
    expect(await readMatching(device, message => message.type === "file.upload.read")).toMatchObject({ uploadId, offset: 0 });
    device.sendBinary(encodeArtifactChunkFrame({ runtimeId, transferId: uploadId as string, offset: 0, data: bytes }));
    const finished = await readMatching(device, message => message.type === "file.upload.finished");
    expect(finished).toMatchObject({ uploadId, sha256, fileName: "fixture.txt" });
    const path = finished.path as string;
    expect(await readFile(path)).toEqual(bytes);
    const withFile = { ...command, attachments: [path] };
    submit("confirmed-import", target, withFile);
    await expect(runtime.next()).resolves.toMatchObject({ commandId: "confirmed-import", command: withFile });
    runtime.publish(1, { type: "command.result", commandId: "confirmed-import", ok: true, status: "success" });
    expect(await receive("commandId", "confirmed-import")).toMatchObject({ event: { ok: true, status: "success" } });
    const read = (id: string, importTarget: typeof target) => device!.sendData(JSON.stringify({ type: "external-import.result.read",
      protocolVersion: PROTOCOL_VERSION, runtimeId, commandId: id, importTarget }));
    await handover("device", "ws", paired.pskRoot, paired.payload.hostId);
    expect(await readMatching(device, message => message.type === "device.ready"))
      .toMatchObject({ hostFeatures: expect.arrayContaining([HOST_FEATURE_IMPORT_TARGET]) });
    await readMatching(device, message => message.type === "device.path");
    await expect(runtime.next()).resolves.toMatchObject({ type: "runtime.resync", reason: "device_reconnected" });
    read("confirmed-import", target);
    expect(await receive("commandId", "confirmed-import")).toMatchObject({ type: "external-import.result", status: "accepted" });
    read("confirmed-import", { ...target, sessionId: "different" });
    expect(await receive("commandId", "confirmed-import")).toMatchObject({ type: "external-import.result", status: "unknown" });
    read("unknown-import", target);
    expect(await receive("commandId", "unknown-import")).toMatchObject({ type: "external-import.result", status: "unknown" });
    device.sendCommand(runtimeId, "legacy-barrier", { type: "stop" });
    await expect(runtime.next()).resolves.toMatchObject({ commandId: "legacy-barrier", command: { type: "stop" } });
  });

  it.each(["device", "host"] as const)("keeps accepted commands and pending interaction results across Relay handovers without dispatching twice (%s)", async side => {
    stateDir = await mkdtemp(join(tmpdir(), "orbis-handover-command-")); relay = await startRelay(stateDir);
    host = await HostService.create({ relayUrl: relay.url, ...relayBusinessHostOptions(relay.url), credential: "runtime-secret", adminToken: "owner-secret", stateDir, reconnect: false, lan: false });
    await host.start(); const paired = await pairDevice({ relay, host }); device = paired.device;
    await device.openChannel("relay", paired.pskRoot, paired.payload.hostId, paired.payload.hostId);
    await readMatching(device, message => message.type === "device.path");
    const descriptor = host.loopback!.descriptor!;
    runtime = await TestRuntime.connect({ url: descriptor.url, token: descriptor.token,
      metadata: { runtimeId: "pi-handover", name: "handover", cwd: stateDir, status: "idle", sessionId: "s" } });
    await runtime.next(); await readMatching(device, message => message.type === "runtime.online");
    let sequence = 0;
    for (const [index, mode] of handoverModes(side).entries()) {
      const requestId = `question-${index}`; const commandId = `accepted-${index}`;
      runtime.publish(++sequence, { type: "interaction.requested", request: { runtimeId: "pi-handover", requestId,
        extensionId: "ask", kind: "confirm", title: "Continue?", expiresAt: Date.now() + 60_000 } });
      await readMatching(device, message => (message.event as Record<string, unknown>)?.type === "interaction.requested");
      device.sendCommand("pi-handover", commandId, { type: "stop" });
      await expect(runtime.next()).resolves.toMatchObject({ commandId, command: { type: "stop" } });
      // The backend accepted the command, but neither its result nor the pending interaction's terminal event has been sent.
      await handover(side, mode, paired.pskRoot, paired.payload.hostId);
      await readMatching(device, message => message.type === "device.path");
      await expect(runtime.next()).resolves.toMatchObject({ type: "runtime.resync", reason: "device_reconnected" });
      runtime.publish(++sequence, { type: "command.result", commandId, ok: true });
      expect(await readMatching(device, message => (message.event as Record<string, unknown>)?.type === "command.result"))
        .toMatchObject({ event: { commandId, ok: true } });
      runtime.publish(++sequence, { type: "interaction.resolved", requestId, source: "remote" });
      expect(await readMatching(device, message => (message.event as Record<string, unknown>)?.type === "interaction.resolved"))
        .toMatchObject({ event: { requestId, source: "remote" } });
      // A later command on the same backend connection is a FIFO barrier: a replay would be observed before it.
      device.sendCommand("pi-handover", `barrier-${index}`, { type: "stop" });
      await expect(runtime.next()).resolves.toMatchObject({ commandId: `barrier-${index}` });
      runtime.publish(++sequence, { type: "command.result", commandId: `barrier-${index}`, ok: true });
      await readMatching(device, message => (message.event as Record<string, unknown>)?.commandId === `barrier-${index}`);
    }
  });

  it.each(["device", "host"] as const)("recovers an unacknowledged snapshot across Relay handover without a permanently busy sync (%s)", async side => {
    stateDir = await mkdtemp(join(tmpdir(), "orbis-handover-sync-")); relay = await startRelay(stateDir);
    host = await HostService.create({ relayUrl: relay.url, ...relayBusinessHostOptions(relay.url), credential: "runtime-secret", adminToken: "owner-secret", stateDir, reconnect: false, lan: false });
    await host.start(); const paired = await pairDevice({ relay, host }); device = paired.device;
    await device.openChannel("relay", paired.pskRoot, paired.payload.hostId, paired.payload.hostId);
    await readMatching(device, message => message.type === "device.path");
    const descriptor = host.loopback!.descriptor!;
    runtime = await TestRuntime.connect({ url: descriptor.url, token: descriptor.token,
      metadata: { runtimeId: "pi-handover-sync", name: "sync", cwd: stateDir, status: "idle", sessionId: "s" } });
    await runtime.next(); await readMatching(device, message => message.type === "runtime.online");
    device.sendCommand("pi-handover-sync", "ack-capability", { type: "session.snapshot.ack", syncId: "prior-session", result: "applied" });
    const request = { type: "session.sync", sessionId: "s", syncId: "pending-snapshot", range: "preview" };
    device.sendCommand("pi-handover-sync", "sync-command", request);
    const forwarded = await runtime.next();
    runtime.publish(1, { type: "session.snapshot", sessionId: "s", syncId: (forwarded.command as { syncId: string }).syncId,
      range: "preview", cursor: { leafId: null }, mode: "replace", entries: [], complete: true,
      source: { epoch: "handover-source", seq: 0, ready: true }, checkpoint: { checkpointId: "c", head: { leafId: null }, headCompleteness: "complete", inventoryComplete: true },
      live: { complete: true, turn: null, messages: [], tools: [] } });
    const original = await readMatching(device, message => (message.event as Record<string, unknown>)?.type === "session.snapshot");
    // Deliberately withhold applied. The reference client only retries this read-only sync, never a user command.
    for (const mode of handoverModes(side)) {
      await handover(side, mode, paired.pskRoot, paired.payload.hostId);
      await readMatching(device, message => message.type === "device.path");
      device.sendCommand("pi-handover-sync", "sync-command", request);
      const recovered = await readMatching(device, message => (message.event as Record<string, unknown>)?.type === "session.snapshot");
      const snapshot = original.event as Record<string, unknown>;
      expect(recovered.event).toEqual({ ...snapshot,
        checkpoint: { ...(snapshot.checkpoint as Record<string, unknown>), checkpointId: "host:handover-source:0" },
        hasOlder: false, rangeStatus: "complete", selection: "snapshot", turnTimings: [] });
    }
    device.sendCommand("pi-handover-sync", "applied", { type: "session.snapshot.ack", syncId: request.syncId, result: "applied" });
    device.sendCommand("pi-handover-sync", "after-applied", { ...request, syncId: "after-applied" });
    expect(await readMatching(device, message => (message.event as Record<string, unknown>)?.type === "session.snapshot"))
      .toMatchObject({ event: { syncId: "after-applied", source: { epoch: "handover-source", seq: 0 } } });
  });

  // 易错点：中继不通知手机掉线，Host 的 RTT 探针持续换回 device_offline，日志每 10 秒刷一行。
  // 覆盖真实中继往返：掉线后停探、只报一次；手机重连发 HS1 后恢复探测与业务下发；再掉线重新报一次。
  it("pauses Relay probes for a phone that left the Relay and resumes them after it reconnects", async () => {
    stateDir = await mkdtemp(join(tmpdir(), "orbis-offline-probe-")); relay = await startRelay(stateDir);
    const logs: string[] = [];
    host = await HostService.create({ relayUrl: relay.url, ...relayBusinessHostOptions(relay.url), credential: "runtime-secret",
      adminToken: "owner-secret", stateDir, reconnect: false, lan: false, probeIntervalMs: 20, log: line => logs.push(line) });
    await host.start(); const paired = await pairDevice({ relay, host }); device = paired.device;
    const { pskRoot, payload: { hostId } } = paired;
    await device.openChannel("relay", pskRoot, hostId, hostId);
    await readMatching(device, message => message.type === "device.path");
    const sent = vi.spyOn(HostRelayClient.prototype, "send");
    const pings = (): number => sent.mock.calls.filter(([envelope]) => envelope.hdr.k === "ping" && envelope.hdr.to === device!.deviceId).length;
    const offlineLogs = (): number => logs.filter(line => line.includes(`设备 ${device!.deviceId} 不在中继上`)).length;
    try {
      await vi.waitFor(() => expect(pings()).toBeGreaterThan(2));
      device.closePath("relay");
      await vi.waitFor(() => expect(offlineLogs()).toBe(1));
      const pausedAt = pings();
      await new Promise(resolve => setTimeout(resolve, 300));
      expect(pings()).toBe(pausedAt);
      expect(offlineLogs()).toBe(1);
      expect(logs.filter(line => line.includes("不在中继上")).at(-1)).toBe(`设备 ${device.deviceId} 不在中继上`);

      await device.reconnectRelay(pskRoot, hostId);
      await vi.waitFor(() => expect(pings()).toBeGreaterThan(pausedAt + 2));
      const descriptor = host.loopback!.descriptor!;
      runtime = await TestRuntime.connect({ url: descriptor.url, token: descriptor.token,
        metadata: { runtimeId: "pi-offline-probe", name: "probe", cwd: stateDir, status: "idle", sessionId: "s" } });
      await runtime.next(); await readMatching(device, message => message.type === "runtime.online");

      device.closePath("relay");
      await vi.waitFor(() => expect(offlineLogs()).toBe(2));
    } finally { sent.mockRestore(); }
  });

  it("recovers independent notification state and device dismissals over encrypted relay sockets", async () => {
    stateDir = await mkdtemp(join(tmpdir(), "orbis-notices-")); relay = await startRelay(stateDir);
    host = await HostService.create({ relayUrl: relay.url, ...relayBusinessHostOptions(relay.url), credential: "runtime-secret", adminToken: "owner-secret", stateDir, reconnect: false, lan: false });
    await host.start(); const paired = await pairDevice({ relay, host }); device = paired.device;
    await device.openChannel("relay", paired.pskRoot, paired.payload.hostId, paired.payload.hostId);
    const ready = await device.receiveMessage(); await device.receiveMessage();
    const descriptor = host.loopback!.descriptor!;
    runtime = await TestRuntime.connect({ url: descriptor.url, token: descriptor.token,
      metadata: { runtimeId: "pi-notices", name: "notices", cwd: "/work", status: "idle", sessionId: "s" } });
    await runtime.next(); await device.receiveMessage();
    const notice = (code: string) => ({ code, occurrenceId: "one", scope: { turnId: "t" }, lifecycle: "condition" as const, severity: "warning" as const, message: code });
    runtime.publish(1, { type: "notification.source", producerEpoch: "source", sessionId: "s", revision: 1, complete: true,
      notifications: [notice("retry"), notice("sandbox")] });
    const readSnapshot = async (predicate: (message: Record<string, unknown>) => boolean) => {
      for (let n = 0; n < 30; ++n) { const message = await device!.receiveMessage(true); if (message.type === "notification.snapshot" && predicate(message)) return message; }
      throw new Error("notification snapshot not received");
    };
    const active = await readSnapshot(message => (message.notifications as unknown[]).length === 2);
    expect(active.hostEpoch).toBe(ready.notificationEpoch);
    runtime.publish(2, { type: "notification.source", producerEpoch: "source", sessionId: "s", revision: 4, complete: true, notifications: [notice("sandbox")] });
    const recovered = await readSnapshot(message => (message.notifications as unknown[]).length === 1);
    const sandbox = (recovered.notifications as { code: string; notificationId: string }[])[0]!;
    expect(sandbox.code).toBe("sandbox");
    device.sendPayload(Buffer.from(JSON.stringify({ type: "notification.sync", protocolVersion: PROTOCOL_VERSION, runtimeId: "pi-notices" })));
    expect(await readSnapshot(message => message.revision === recovered.revision)).toMatchObject({ notifications: [sandbox] });
    device.sendPayload(Buffer.from(JSON.stringify({ type: "notification.dismiss", protocolVersion: PROTOCOL_VERSION, runtimeId: "pi-notices", hostEpoch: active.hostEpoch, notificationId: sandbox.notificationId })));
    await readSnapshot(message => (message.notifications as unknown[]).length === 0);
    const second = await pairDevice({ relay, host });
    try {
      await second.device.openChannel("relay", second.pskRoot, second.payload.hostId, second.payload.hostId);
      for (let n = 0; n < 10; ++n) {
        const message = await second.device.receiveMessage(true);
        if (message.type === "notification.snapshot" && message.runtimeId === "pi-notices") {
          expect(message.notifications).toEqual([sandbox]); break;
        }
        if (n === 9) throw new Error("second device did not receive its notification view");
      }
      device.sendPayload(Buffer.from(JSON.stringify({ type: "notification.sync", protocolVersion: PROTOCOL_VERSION, runtimeId: "pi-notices" })));
      expect(await readSnapshot(message => (message.notifications as unknown[]).length === 0)).toMatchObject({ notifications: [] });
    } finally { second.device.close(); }
  });

  it.each([
    { terminal: { type: "interaction.resolved", requestId: "answer", source: "remote" }, message: undefined },
    { terminal: { type: "interaction.resolved", requestId: "answer", source: "local" }, message: "交互已在电脑端完成" },
    { terminal: { type: "interaction.cancelled", requestId: "answer", reason: "timeout" }, message: "交互已超时" },
    { terminal: { type: "interaction.cancelled", requestId: "answer", reason: "cancelled" }, message: "交互已取消" },
  ] as const)("keeps only the appropriate interaction feedback for $terminal", async ({ terminal, message }) => {
    stateDir = await mkdtemp(join(tmpdir(), "orbis-interaction-notices-")); relay = await startRelay(stateDir);
    host = await HostService.create({ relayUrl: relay.url, ...relayBusinessHostOptions(relay.url), credential: "runtime-secret", adminToken: "owner-secret", stateDir, reconnect: false, lan: false });
    await host.start(); const paired = await pairDevice({ relay, host }); device = paired.device;
    await device.openChannel("relay", paired.pskRoot, paired.payload.hostId, paired.payload.hostId);
    await device.receiveMessage(); await device.receiveMessage();
    const descriptor = host.loopback!.descriptor!;
    runtime = await TestRuntime.connect({ url: descriptor.url, token: descriptor.token,
      metadata: { runtimeId: "pi-answer", name: "answer", cwd: "/work", status: "idle", sessionId: "s" } });
    await runtime.next(); await device.receiveMessage();
    runtime.publish(1, { type: "interaction.requested", request: { runtimeId: "pi-answer", requestId: "answer",
      extensionId: "ask", kind: "confirm", title: "Continue?", expiresAt: Date.now() + 60_000 } });
    expect(await device.receiveMessage()).toMatchObject({ type: "runtime.event", event: { type: "interaction.requested" } });
    for (const sequence of [2, 3]) {
      runtime.publish(sequence, terminal);
      // Inspect every frame before the terminal event: a duplicate banner must never flash.
      for (;;) {
        const frame = await device.receiveMessage(true);
        if (frame.type === "notification.snapshot" && message === undefined) expect(frame.notifications).toEqual([]);
        if (frame.type === "runtime.event") { expect(frame.event).toEqual(terminal); break; }
      }
      device.sendData(JSON.stringify({ type: "notification.sync", protocolVersion: PROTOCOL_VERSION, runtimeId: "pi-answer" }));
      for (;;) {
        const frame = await device.receiveMessage(true);
        if (frame.type !== "notification.snapshot") continue;
        if (message === undefined) expect(frame.notifications).toEqual([]);
        else expect(frame.notifications).toEqual([expect.objectContaining({ code: "interaction.result", message,
          scope: { requestId: "answer" }, severity: terminal.type === "interaction.cancelled" && terminal.reason === "timeout" ? "warning" : "info" })]);
        break;
      }
    }
  });

  it.each(["shared", "background"] as const)("%s history mode preserves encrypted preview/history/catchup and applied ACKs", async historyMode => {
    stateDir = await mkdtemp(join(tmpdir(), "orbis-history-isolation-")); relay = await startRelay(stateDir);
    host = await HostService.create({ relayUrl: relay.url, ...relayBusinessHostOptions(relay.url),
      relayHistoryMode: historyMode, credential: "runtime-secret", adminToken: "owner-secret", stateDir,
      reconnect: false, lan: false });
    await host.start();
    const paired = await pairDevice({ relay, host }); device = paired.device;
    await device.openChannel("relay", paired.pskRoot, paired.payload.hostId, paired.payload.hostId);
    await device.receiveMessage(); await device.receiveMessage();
    const descriptor = host.loopback!.descriptor!;
    runtime = await TestRuntime.connect({ url: descriptor.url, token: descriptor.token,
      metadata: { runtimeId: "pi-history", name: "history", cwd: "/work", status: "idle", sessionId: "s" } });
    await runtime.next(); await device.receiveMessage();
    let sequence = 0;
    for (const range of ["preview", "history", "catchup"] as const) {
      device.sendCommand("pi-history", range, { type: "session.sync", sessionId: "s", syncId: range, range });
      const forwarded = await runtime.next();
      const command = forwarded.command as { syncId: string; range: string };
      expect(command.range).toBe(range);
      runtime.publish(++sequence, { type: "session.snapshot", sessionId: "s", syncId: command.syncId, range,
        cursor: { leafId: null }, mode: range === "preview" ? "replace" : "prepend", entries: [], complete: true,
        source: { epoch: "isolation-source", seq: 0, ready: true },
        ...(range !== "preview" ? {} : {
          checkpoint: { checkpointId: "isolation-source:0", head: { leafId: null }, headCompleteness: "complete", inventoryComplete: true },
          live: { complete: true, turn: null, messages: [], tools: [] },
        }),
      });
      let received = false;
      for (let i = 0; i < 10; i++) {
        const incoming = await device.nextIncoming();
        if (!("payload" in incoming)) throw new Error("unexpected handshake");
        const message = JSON.parse(incoming.payload.toString()) as { event?: { type: string; syncId?: string; range?: string } };
        if (message.event?.type !== "session.snapshot" || message.event.syncId !== range) continue;
        expect(message.event.range).toBe(range);
        const independent = historyMode === "background" && process.env.ORBIS_TEST_HISTORY_STREAMS === "1";
        expect(incoming.channel).toBe(independent && range === "history" ? "history" : historyMode === "background" && range === "catchup" ? (independent ? "catchup" : "bulk") : "msg");
        received = true; break;
      }
      expect(received).toBe(true);
      device.sendCommand("pi-history", `${range}-applied`, { type: "session.snapshot.ack", syncId: range, result: "applied" });
    }
    runtime.publish(++sequence, { type: "runtime.status", status: "running" });
    const status = await device.receiveMessage();
    expect(status).toMatchObject({ type: "runtime.event", event: { type: "runtime.status", status: "running" } });
  });

  it("privately rebuilds a lost Host baseline before returning the requested catchup", async () => {
    // DSH-SYNC-09：模擬Host已快取手機會話、但目前Host没有conversation baseline的重启恢复路径。
    stateDir = await mkdtemp(join(tmpdir(), "orbis-sync-baseline-recovery-")); relay = await startRelay(stateDir);
    host = await HostService.create({ relayUrl: relay.url, ...relayBusinessHostOptions(relay.url), credential: "runtime-secret", adminToken: "owner-secret",
      stateDir, reconnect: false, lan: false }); await host.start();
    const paired = await pairDevice({ relay, host }); device = paired.device;
    await device.openChannel("relay", paired.pskRoot, paired.payload.hostId, paired.payload.hostId);
    await device.receiveMessage(); await device.receiveMessage();
    const descriptor = host.loopback!.descriptor!;
    runtime = await TestRuntime.connect({ url: descriptor.url, token: descriptor.token,
      metadata: { runtimeId: "pi-baseline-recovery", name: "recovery", cwd: "/work", status: "idle", sessionId: "session" } });
    await runtime.next(); await device.receiveMessage();
    device.sendCommand("pi-baseline-recovery", "catchup-original", { type: "session.sync", sessionId: "session", syncId: "catchup-original",
      range: "catchup", knownLeafId: "phone-leaf", targetLeafId: "target-leaf", beforeEntryId: "before-entry", maxEntries: 17 });
    const baseline = await runtime.next().catch(error => { throw new Error("private Host baseline preview", { cause: error }); });
    expect(baseline.command).toMatchObject({ type: "session.sync", sessionId: "session", range: "preview" });
    expect(baseline.command).not.toHaveProperty("knownState");
    expect(baseline.command).not.toHaveProperty("beforeEntryId");
    runtime.publish(2, { type: "session.snapshot", sessionId: "session", syncId: (baseline.command as { syncId: string }).syncId,
      range: "preview", mode: "replace", cursor: { leafId: "target-leaf" }, entries: [], complete: true,
      source: { epoch: "new-host-source", seq: 0, ready: true },
      checkpoint: { checkpointId: "new-host-source:0", head: { leafId: "target-leaf" }, headCompleteness: "complete", inventoryComplete: true },
      live: { complete: true, turn: null, messages: [], tools: [] } });
    const recovered = await runtime.next();
    const command = recovered.command as Record<string, unknown>;
    expect(command).toMatchObject({ type: "session.sync", sessionId: "session", range: "catchup", syncId: expect.any(String),
      knownLeafId: "phone-leaf", targetLeafId: "target-leaf", beforeEntryId: "before-entry", maxEntries: 17 });
    expect(command.syncId).not.toBe("catchup-original");
    runtime.publish(3, { type: "session.snapshot", sessionId: "session", syncId: command.syncId as string, range: "catchup",
      mode: "prepend", cursor: { leafId: "target-leaf" }, entries: [], complete: true,
      source: { epoch: "new-host-source", seq: 0, ready: true } });
    let delivered: Record<string, unknown>;
    do { delivered = await device.receiveMessage(); } while ((delivered.event as { type?: string } | undefined)?.type === "session.sync.pending");
    expect(delivered).toMatchObject({ event: { type: "session.snapshot", syncId: "catchup-original", range: "catchup" } });
  });

  it("rebuilds a stale source baseline and retries the original history request", async () => {
    stateDir = await mkdtemp(join(tmpdir(), "orbis-sync-epoch-recovery-")); relay = await startRelay(stateDir);
    host = await HostService.create({ relayUrl: relay.url, ...relayBusinessHostOptions(relay.url), credential: "runtime-secret", adminToken: "owner-secret",
      stateDir, reconnect: false, lan: false }); await host.start();
    const paired = await pairDevice({ relay, host }); device = paired.device;
    await device.openChannel("relay", paired.pskRoot, paired.payload.hostId, paired.payload.hostId);
    await readMatching(device, message => message.type === "device.path");
    const descriptor = host.loopback!.descriptor!;
    runtime = await TestRuntime.connect({ url: descriptor.url, token: descriptor.token,
      metadata: { runtimeId: "pi-epoch-recovery", name: "epoch recovery", cwd: "/work", status: "idle", sessionId: "session" } });
    await runtime.next(); await readMatching(device, message => message.type === "runtime.online");

    const baselineRequest = { type: "session.sync", sessionId: "session", syncId: "old-preview", range: "preview" } as const;
    device.sendCommand("pi-epoch-recovery", "old-preview-command", baselineRequest);
    const initial = await runtime.next();
    runtime.publish(1, { type: "session.snapshot", sessionId: "session", syncId: (initial.command as { syncId: string }).syncId,
      range: "preview", mode: "replace", cursor: { leafId: "tail" }, targetLeafId: "tail", entries: [],
      complete: true, hasOlder: false, rangeStatus: "complete",
      source: { epoch: "source-before-restart", seq: 8, ready: true },
      checkpoint: { checkpointId: "old:8", head: { leafId: "tail" }, headCompleteness: "complete", inventoryComplete: true },
      live: { complete: true, turn: null, messages: [], tools: [] } });
    expect(await readMatching(device, message => (message.event as { syncId?: string } | undefined)?.syncId === "old-preview"))
      .toMatchObject({ event: { type: "session.snapshot", source: { epoch: "source-before-restart" } } });
    device.sendCommand("pi-epoch-recovery", "old-preview-applied", { type: "session.snapshot.ack", syncId: "old-preview", result: "applied" });

    device.sendCommand("pi-epoch-recovery", "history-original", { type: "session.sync", sessionId: "session", syncId: "history-original",
      range: "history", targetLeafId: "tail", beforeEntryId: "tail", maxEntries: 30 });
    const staleRangeRequest = await runtime.next();
    const staleRange = staleRangeRequest.command as { syncId: string };
    runtime.publish(2, { type: "session.snapshot", sessionId: "session", syncId: staleRange.syncId,
      range: "history", mode: "prepend", cursor: { leafId: "tail" }, targetLeafId: "tail", beforeEntryId: "tail",
      entries: [], complete: true, hasOlder: false, rangeStatus: "complete",
      source: { epoch: "source-after-restart", seq: 1, ready: true } });

    const rebuild = await runtime.next();
    expect(rebuild.command).toMatchObject({ type: "session.sync", sessionId: "session", range: "preview" });
    expect(rebuild.command).not.toHaveProperty("knownState");
    expect(rebuild.command).not.toHaveProperty("beforeEntryId");
    runtime.publish(3, { type: "session.snapshot", sessionId: "session", syncId: (rebuild.command as { syncId: string }).syncId,
      range: "preview", mode: "replace", cursor: { leafId: "tail" }, targetLeafId: "tail", entries: [],
      complete: true, hasOlder: false, rangeStatus: "complete",
      source: { epoch: "source-after-restart", seq: 1, ready: true },
      checkpoint: { checkpointId: "new:1", head: { leafId: "tail" }, headCompleteness: "complete", inventoryComplete: true },
      live: { complete: true, turn: null, messages: [], tools: [] } });

    const retriedHistory = await runtime.next();
    expect(retriedHistory.command).toMatchObject({ type: "session.sync", sessionId: "session", range: "history",
      targetLeafId: "tail", beforeEntryId: "tail", maxEntries: 30 });
    const retriedSyncId = (retriedHistory.command as { syncId: string }).syncId;
    runtime.publish(4, { type: "session.snapshot", sessionId: "session", syncId: retriedSyncId,
      range: "history", mode: "prepend", cursor: { leafId: "tail" }, targetLeafId: "tail", beforeEntryId: "tail",
      entries: [], complete: true, hasOlder: false, rangeStatus: "complete",
      source: { epoch: "source-after-restart", seq: 1, ready: true } });

    const delivered = await readMatching(device, message => {
      const event = message.event as { syncId?: string; type?: string } | undefined;
      return event?.type === "session.snapshot" && event.syncId === "history-original";
    });
    expect(delivered).toMatchObject({ event: { type: "session.snapshot", range: "history", source: { epoch: "source-after-restart" } } });
    expect(delivered.type).not.toBe("protocol.error");
    device.sendCommand("pi-epoch-recovery", "history-applied", { type: "session.snapshot.ack", syncId: "history-original", result: "applied" });
  });

  // CODEX-SOURCE-02：一块补丁被拒之后，被改回 ready=false 的旧基线会永久拒收后续补丁
  // （现场 1076 条 handshake_base_mismatch，同一 epoch、seq 一路递增全被拒）。
  // 作废时必须连 epoch/seq 一起丢掉，下一块补丁才能重新进入会话流。
  it("resumes a session after a rejected patch by retiring the stale baseline", async () => {
    stateDir = await mkdtemp(join(tmpdir(), "orbis-sync-stuck-baseline-")); relay = await startRelay(stateDir);
    host = await HostService.create({ relayUrl: relay.url, ...relayBusinessHostOptions(relay.url), credential: "runtime-secret", adminToken: "owner-secret",
      stateDir, reconnect: false, lan: false }); await host.start();
    const paired = await pairDevice({ relay, host }); device = paired.device;
    await device.openChannel("relay", paired.pskRoot, paired.payload.hostId, paired.payload.hostId);
    await readMatching(device, message => message.type === "device.path");
    const descriptor = host.loopback!.descriptor!;
    runtime = await TestRuntime.connect({ url: descriptor.url, token: descriptor.token,
      metadata: { runtimeId: "pi-stuck-baseline", name: "stuck baseline", cwd: "/work", status: "idle", sessionId: "session" } });
    await runtime.next(); await readMatching(device, message => message.type === "runtime.online");

    device.sendCommand("pi-stuck-baseline", "preview-command", { type: "session.sync", sessionId: "session", syncId: "preview", range: "preview" });
    const request = await runtime.next();
    runtime.publish(1, { type: "session.snapshot", sessionId: "session", syncId: (request.command as { syncId: string }).syncId,
      range: "preview", mode: "replace", cursor: { leafId: null }, targetLeafId: null, entries: [], complete: true, hasOlder: false,
      rangeStatus: "complete", source: { epoch: "E1", seq: 8, ready: true },
      checkpoint: { checkpointId: "E1:8", head: { leafId: null }, headCompleteness: "complete", inventoryComplete: true },
      live: { complete: true, turn: null, messages: [], tools: [] } });
    await readMatching(device, message => (message.event as { syncId?: string } | undefined)?.syncId === "preview");
    device.sendCommand("pi-stuck-baseline", "preview-applied", { type: "session.snapshot.ack", syncId: "preview", result: "applied" });

    const patch = (epoch: string, seq: number): Extract<RuntimeEvent, { type: "session.patch" }> => ({
      type: "session.patch", sessionId: "session", source: { epoch, seq, ready: true }, baseSeq: seq - 1, seq,
      checkpointId: `${epoch}:${seq}`, head: { leafId: null }, headCompleteness: "complete",
      live: { complete: true, turn: null, messages: [], tools: [] } });
    // 换了 epoch 的补丁接不上旧基线：被拒，并作废那条基线。
    runtime.publish(2, patch("E2", 1));
    // 下一块补丁必须重新出现在设备的会话流里，而不是继续撞同一个拒绝。
    runtime.publish(3, patch("E2", 2));
    const delivered = await readMatching(device, message =>
      (message.event as { source?: { epoch?: string } } | undefined)?.source?.epoch === "E2");
    expect(delivered.event).toMatchObject({ type: "session.patch", source: { epoch: "E2", seq: 2 } });
  });

  // CODEX-SOURCE-02：一块补丁被拒之后，被改回 ready=false 的旧基线会永久拒收后续补丁
  // （现场 1076 条 handshake_base_mismatch，同一 epoch、seq 一路递增全被拒）。
  // 作废时必须连 epoch/seq 一起丢掉，下一块补丁才能重新进入会话流。
  it("resumes a session after a rejected patch by retiring the stale baseline", async () => {
    stateDir = await mkdtemp(join(tmpdir(), "orbis-sync-stuck-baseline-")); relay = await startRelay(stateDir);
    host = await HostService.create({ relayUrl: relay.url, ...relayBusinessHostOptions(relay.url), credential: "runtime-secret", adminToken: "owner-secret",
      stateDir, reconnect: false, lan: false }); await host.start();
    const paired = await pairDevice({ relay, host }); device = paired.device;
    await device.openChannel("relay", paired.pskRoot, paired.payload.hostId, paired.payload.hostId);
    await readMatching(device, message => message.type === "device.path");
    const descriptor = host.loopback!.descriptor!;
    runtime = await TestRuntime.connect({ url: descriptor.url, token: descriptor.token,
      metadata: { runtimeId: "pi-stuck-baseline", name: "stuck baseline", cwd: "/work", status: "idle", sessionId: "session" } });
    await runtime.next(); await readMatching(device, message => message.type === "runtime.online");

    device.sendCommand("pi-stuck-baseline", "preview-command", { type: "session.sync", sessionId: "session", syncId: "preview", range: "preview" });
    const request = await runtime.next();
    runtime.publish(1, { type: "session.snapshot", sessionId: "session", syncId: (request.command as { syncId: string }).syncId,
      range: "preview", mode: "replace", cursor: { leafId: null }, targetLeafId: null, entries: [], complete: true, hasOlder: false,
      rangeStatus: "complete", source: { epoch: "E1", seq: 8, ready: true },
      checkpoint: { checkpointId: "E1:8", head: { leafId: null }, headCompleteness: "complete", inventoryComplete: true },
      live: { complete: true, turn: null, messages: [], tools: [] } });
    await readMatching(device, message => (message.event as { syncId?: string } | undefined)?.syncId === "preview");
    device.sendCommand("pi-stuck-baseline", "preview-applied", { type: "session.snapshot.ack", syncId: "preview", result: "applied" });

    const patch = (epoch: string, seq: number): Extract<RuntimeEvent, { type: "session.patch" }> => ({
      type: "session.patch", sessionId: "session", source: { epoch, seq, ready: true }, baseSeq: seq - 1, seq,
      checkpointId: `${epoch}:${seq}`, head: { leafId: null }, headCompleteness: "complete",
      live: { complete: true, turn: null, messages: [], tools: [] } });
    // 换了 epoch 的补丁接不上旧基线：被拒，并作废那条基线。
    runtime.publish(2, patch("E2", 1));
    // 下一块补丁必须重新出现在设备的会话流里，而不是继续撞同一个拒绝。
    runtime.publish(3, patch("E2", 2));
    const delivered = await readMatching(device, message =>
      (message.event as { source?: { epoch?: string } } | undefined)?.source?.epoch === "E2");
    expect(delivered.event).toMatchObject({ type: "session.patch", source: { epoch: "E2", seq: 2 } });
  });

  it("targets sync snapshots and acknowledgements to their requesting device over real encrypted relay sockets", async () => {
    stateDir = await mkdtemp(join(tmpdir(), "orbis-sync-"));
    relay = await startRelay(stateDir);
    host = await HostService.create({ relayUrl: relay.url, ...relayBusinessHostOptions(relay.url), credential: "runtime-secret", adminToken: "owner-secret",
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
        range: "preview", cursor: { leafId: null }, mode: "replace", entries: [], complete: true,
        source: { epoch: "source", seq: 0, ready: true }, checkpoint: { checkpointId: "c", head: { leafId: null }, headCompleteness: "complete", inventoryComplete: true },
        live: { complete: true, turn: null, messages: [], tools: [] } });
      const received = [await device.receiveMessage(), await device.receiveMessage()];
      expect(received).toEqual(expect.arrayContaining([
        expect.objectContaining({ event: expect.objectContaining({ type: "command.result", commandId: "original" }) }),
        expect.objectContaining({ event: expect.objectContaining({ type: "session.snapshot", syncId: "requested" }) }),
      ]));
      runtime.publish(3, { type: "session.snapshot", sessionId: "s", syncId: "unsolicited",
        cursor: { leafId: null }, mode: "replace", entries: [] });
      runtime.publish(4, { type: "message.started", message: { messageId: "barrier", role: "assistant", timestamp: 1, content: [] } });
      // A marker on the same msg channel proves all earlier unwanted snapshots were suppressed.
      await expect(second.device.receiveMessage()).resolves.toMatchObject({ event: { type: "message.started", message: { messageId: "barrier" } } });
      await expect(device.receiveMessage()).resolves.toMatchObject({ event: { type: "message.started", message: { messageId: "barrier" } } });
      // Keep these reads pending at the runtime: the completed preview above can be served from the Host cache.
      for (let index = 0; index < 33; index++) {
        device.sendPayload(Buffer.from(JSON.stringify({ ...command, commandId: `busy-${index}`,
          command: { ...command.command, syncId: `busy-sync-${index}`, targetLeafId: "uncached-busy-target" } })));
      }
      let busy: Record<string, unknown> | undefined;
      const busyDeadline = Date.now() + 5_000;
      while (Date.now() < busyDeadline) {
        const message = await device.expectOn("relay", Math.max(1, busyDeadline - Date.now()));
        if (message.type === "protocol.error" && message.code === "session_sync_busy") { busy = message; break; }
      }
      expect(busy).toMatchObject({ type: "protocol.error", code: "session_sync_busy", commandId: "busy-32" });
      const diagnostics = host.readDiagnostics({ category: "session.sync" });
      expect(diagnostics.records).toEqual(expect.arrayContaining([expect.objectContaining({
        operationId: "busy-32", message: "session_sync_busy", detail: expect.objectContaining({ path: "relay", pending: "32" }),
      })]));
      const persisted = (await readFile(join(stateDir, "diagnostics.ndjson"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
      expect(persisted).toEqual(expect.arrayContaining([expect.objectContaining({ operationId: "busy-32", message: "session_sync_busy" })]));
    } finally { second.device.close(); }
  });

  it("privately pages Pi tool inventories and details through two real authenticated encrypted devices", async () => {
    stateDir = await mkdtemp(join(tmpdir(), "orbis-private-tools-")); relay = await startRelay(stateDir);
    host = await HostService.create({ relayUrl: relay.url, ...relayBusinessHostOptions(relay.url), credential: "runtime-secret", adminToken: "owner-secret", stateDir,
      reconnect: false, lan: false }); await host.start();
    const first = await pairDevice({ relay, host }); device = first.device;
    await device.openChannel("relay", first.pskRoot, first.payload.hostId, first.payload.hostId);
    await device.receiveMessage(); await device.receiveMessage();
    const second = await pairDevice({ relay, host });
    try {
      await second.device.openChannel("relay", second.pskRoot, second.payload.hostId, second.payload.hostId);
      await second.device.receiveMessage(); await second.device.receiveMessage();
      const descriptor = host.loopback!.descriptor!;
      runtime = await TestRuntime.connect({ url: descriptor.url, token: descriptor.token,
        metadata: { runtimeId: "pi-tools", name: "tools", cwd: "/work", status: "running", sessionId: "s" } });
      await runtime.next(); await device.receiveMessage(); await second.device.receiveMessage();
      device.sendPayload(Buffer.from(JSON.stringify({ type: "runtime.command", protocolVersion: PROTOCOL_VERSION,
        runtimeId: "pi-tools", commandId: "baseline", command: { type: "session.sync", sessionId: "s", syncId: "baseline", range: "preview" } })));
      const baseline = await runtime.next();
      expect(baseline).toMatchObject({ command: { type: "session.sync" } });
      runtime.publish(1, { type: "session.snapshot", sessionId: "s", range: "preview", syncId: (baseline.command as { syncId: string }).syncId,
        cursor: { leafId: null }, mode: "replace", entries: [], complete: true, source: { epoch: "source", seq: 0, ready: true },
        checkpoint: { checkpointId: "source:0", head: { leafId: null }, headCompleteness: "complete", inventoryComplete: true },
        live: { complete: true, turn: null, messages: [], tools: [] } });
      expect(await device.receiveMessage().catch(error => { throw new Error("private tools initial baseline", { cause: error }); })).toMatchObject({ event: { type: "session.snapshot" } });
      const agent = { hostId: first.payload.hostId, agentKind: "pi" as const, sessionId: "s" };
      let sequence = 1;
      const summaries = Array.from({ length: 200 }, (_, i) => createToolSummary({ tool: { agent, toolCallId: `t${i}` },
        toolName: "read", order: i, phase: "running", contents: [] }));
      const producer = new ToolInventorySource(event => runtime!.publish(++sequence, event));
      const reference = producer.prepare("pi-tools", { epoch: "source", seq: 1 }, summaries)!;
      runtime.publish(++sequence, { type: "session.patch", sessionId: "s", source: { epoch: "source", seq: 1, ready: true }, baseSeq: 0, seq: 1,
        checkpointId: "source:1", head: { leafId: null }, headCompleteness: "complete",
        live: { complete: true, turn: null, messages: [], tools: [], toolInventory: reference } });
      for (const phone of [device, second.device]) {
        const messages = [await phone.receiveMessage().catch(error => { throw new Error("private tools publication 1", { cause: error }); }), await phone.receiveMessage().catch(error => { throw new Error("private tools publication 2", { cause: error }); })];
        expect(messages.some(message => (message.event as RuntimeEvent)?.type === "session.tools.changed")).toBe(true);
        expect(messages.find(message => (message.event as RuntimeEvent)?.type === "session.patch")).toMatchObject({ event: { live: { tools: [], toolInventory: reference } } });
      }
      const send = (command: unknown) => device!.sendPayload(Buffer.from(JSON.stringify({ type: "runtime.command", protocolVersion: PROTOCOL_VERSION,
        runtimeId: "pi-tools", commandId: "private", command })));
      send({ type: "session.tools.open", requestId: "open", runtimeId: "pi-tools", reference });
      const opened = await device.receiveMessage(); const snapshot = (opened.event as { snapshot: ToolInventorySnapshot }).snapshot;
      let cursor: string | null = null, count = 0;
      do {
        send({ type: "session.tools.read", requestId: `page${count}`, runtimeId: "pi-tools", snapshot, cursor, maxItems: 128 });
        const event = (await device.receiveMessage()).event as Extract<RuntimeEvent, { type: "session.tools.page" }>;
        expect(event.type).toBe("session.tools.page"); count += event.tools.length; cursor = event.nextCursor;
      } while (cursor);
      expect(count).toBe(200);
      const request: ToolContentReadRequest = { type: "session.tool.content.read", requestId: "private-content", runtimeId: "pi-tools", viewerId: "v",
        locator: { projectionVersion: 1, tool: { agent, toolCallId: "t0" }, part: "output" }, read: null, offset: 0, maxBytes: 16_384 };
      send(request); const forwarded = (await runtime.next()).command as ToolContentReadRequest;
      expect(forwarded.requestId).not.toBe(request.requestId);
      runtime.publish(++sequence, createToolContentPage({ type: "session.tool.content.page", requestId: forwarded.requestId, runtimeId: "pi-tools", locator: forwarded.locator,
        read: { readId: "read-private", contentEpoch: "content", throughOffset: 16_384 }, format: "text", representation: "utf8-fragment", fromOffset: 0,
        availableFromOffset: 0, availableThroughOffset: 16_384, observedThroughOffset: 16_384, contentFinal: false, gaps: [] }, "private-output".repeat(1260).slice(0, 16_384)));
      expect(await device.receiveMessage()).toMatchObject({ event: { type: "session.tool.content.page", requestId: "private-content" } });
      // The other device receives neither the private inventory pages nor the raw content.
      await expect(second.device.nextIncoming(150)).rejects.toThrow("超时");
    } finally { second.device.close(); }
  });

  it("pairs a device, completes the handshake, and carries ciphertext only", async () => {
    stateDir = await mkdtemp(join(tmpdir(), "orbis-host-"));
    relay = await startRelay(stateDir);

    const receivedByHost: string[] = [];
    const pairedDeviceIds: string[] = [];
    host = await HostService.create({
      relayUrl: relay.url, ...relayBusinessHostOptions(relay.url),
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

  it("publishes recurring RTT samples over a single relay path without changing routes", async () => {
    stateDir = await mkdtemp(join(tmpdir(), "orbis-host-rtt-"));
    relay = await startRelay(stateDir);
    const pathChanges: ActivePathChange[] = [];
    host = await HostService.create({ relayUrl: relay.url, ...relayBusinessHostOptions(relay.url), credential: "runtime-secret", adminToken: "owner-secret",
      stateDir, reconnect: false, lan: false, probeIntervalMs: 30,
      onPathChange: (_deviceId, change) => pathChanges.push(change) });
    await host.start();
    const paired = await pairDevice({ relay, host }); device = paired.device;
    await device.openChannel("relay", paired.pskRoot, paired.payload.hostId, paired.payload.hostId);
    expect(await device.receiveMessage()).toMatchObject({ type: "device.ready" });
    expect(await device.receiveMessage()).toMatchObject({ type: "device.path", path: "relay" });
    for (let sample = 0; sample < 2; sample++) {
      const announcement = await device.receiveMessage();
      expect(announcement).toMatchObject({ type: "device.path", path: "relay", rttMs: expect.any(Number) });
      expect(announcement.rttMs).toBeGreaterThanOrEqual(0);
    }
    expect(pathChanges).toHaveLength(1);
    expect(host.activePathOf(device.deviceId)).toBe("relay");
  });

  it("closes the pairing window once consumed and supports revoking the device", async () => {
    stateDir = await mkdtemp(join(tmpdir(), "orbis-host-"));
    relay = await startRelay(stateDir);

    host = await HostService.create({
      relayUrl: relay.url, ...relayBusinessHostOptions(relay.url),
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
    stateDir = await mkdtemp(join(tmpdir(), "orbis-host-"));
    relay = await startRelay(stateDir);

    host = await HostService.create({
      relayUrl: relay.url, ...relayBusinessHostOptions(relay.url),
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
    stateDir = await mkdtemp(join(tmpdir(), "orbis-host-"));
    relay = await startRelay(stateDir);

    host = await HostService.create({
      relayUrl: relay.url, ...relayBusinessHostOptions(relay.url),
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

  it("returns a new session's execution separately and keeps publishing status on the same subscription", async () => {
    stateDir = await mkdtemp(join(tmpdir(), "orbis-host-"));
    relay = await startRelay(stateDir);
    host = await HostService.create({ relayUrl: relay.url, ...relayBusinessHostOptions(relay.url), credential: "runtime-secret", adminToken: "owner-secret",
      stateDir, reconnect: false, lan: false });
    await host.start();
    const paired = await pairDevice({ relay, host });
    device = paired.device;
    await device.openChannel("relay", paired.pskRoot, paired.payload.hostId, paired.payload.hostId);
    await expect(device.receiveMessage()).resolves.toMatchObject({ type: "device.ready" });
    await device.receiveMessage();

    const descriptor = host.loopback?.descriptor;
    if (descriptor === undefined) throw new Error("loopback descriptor 缺失");
    runtime = await TestRuntime.connect({ url: descriptor.url, token: descriptor.token,
      metadata: { runtimeId: "pi-1", name: "pi", cwd: "/work/project", status: "idle", sessionId: "s1" } });
    await expect(runtime.next()).resolves.toMatchObject({ type: "runtime.ready", runtimeId: "pi-1" });
    await expect(device.receiveMessage()).resolves.toMatchObject({ type: "runtime.online" });

    device.sendData(JSON.stringify({ type: "agent.state.request", protocolVersion: PROTOCOL_VERSION, requestId: "model-1",
      scope: "agent", runtimeId: "pi-1", sessionId: "s1", agentKind: "pi", subscribe: true, domains: ["execution", "history", "live"] }));
    const initialFrames = [await device.receiveMessage(), await device.receiveMessage()] as Array<{ domains?: Array<{ domain: string }> }>;
    expect(initialFrames.map(frame => frame.domains?.map(domain => domain.domain))).toContainEqual(["execution"]);
    expect(initialFrames.flatMap(frame => frame.domains?.map(domain => domain.domain) ?? []).sort()).toEqual(["execution", "history", "live"]);
    expect(initialFrames.find(frame => frame.domains?.[0]?.domain === "execution")).toMatchObject({ requestId: "model-1",
      runtimeId: "pi-1", sessionId: "s1", domains: [{ availability: "ready", value: { phase: "idle" } }] });

    runtime.publish(1, { type: "runtime.status", status: "running" });
    const updates = [await device.receiveMessage(), await device.receiveMessage()] as Array<{ domains?: Array<{ domain: string }> }>;
    expect(updates.map(frame => frame.domains?.map(domain => domain.domain))).toContainEqual(["execution"]);
    expect(updates.flatMap(frame => frame.domains?.map(domain => domain.domain) ?? [])).toEqual(["execution"]);
    expect(updates.find(frame => frame.domains?.[0]?.domain === "execution")).toMatchObject({ requestId: "model-1", update: true,
      domains: [{ availability: "ready", value: { phase: "running" } }] });
  });

  it("runtime 不在线时由 Host 就地读盘服务下载（不再依赖产生文件的 Pi 进程）", async () => {
    stateDir = await mkdtemp(join(tmpdir(), "orbis-host-"));
    relay = await startRelay(stateDir);

    host = await HostService.create({
      relayUrl: relay.url, ...relayBusinessHostOptions(relay.url),
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

  it("暂停后删除、完成后取消及过期下载的取消不回落到 runtime", async () => {
    stateDir = await mkdtemp(join(tmpdir(), "orbis-host-"));
    relay = await startRelay(stateDir);
    host = await HostService.create({
      relayUrl: relay.url, ...relayBusinessHostOptions(relay.url), credential: "runtime-secret", adminToken: "owner-secret",
      stateDir, reconnect: false, lan: false,
    });
    await host.start();
    const paired = await pairDevice({ relay, host });
    device = paired.device;
    await device.openChannel("relay", paired.pskRoot, paired.payload.hostId, paired.payload.hostId);
    await device.receiveMessage(); // device.ready
    await device.receiveMessage(); // device.path
    const filePath = join(stateDir, "unfinished.bin");
    await writeFile(filePath, Buffer.from([1, 2, 3, 4]));

    for (const terminal of ["cancelled", "completed"]) {
      device.sendCommand(paired.payload.hostId, `download-${terminal}`, { type: "file.download", path: filePath });
      const started = await device.receiveMessage();
      expect(started).toMatchObject({ type: "runtime.event", event: { type: "artifact.started" } });
      const transferId = (started.event as Record<string, unknown>).transferId as string;
      if (terminal === "cancelled") {
        device.sendCommand(paired.payload.hostId, "pause", { type: "artifact.cancel", transferId });
      } else {
        device.sendData(JSON.stringify({ type: "artifact.done", protocolVersion: PROTOCOL_VERSION, transferId }));
      }
      device.sendCommand(paired.payload.hostId, `delete-${terminal}`, { type: "artifact.cancel", transferId });
      device.sendCommand(paired.payload.hostId, `stale-${terminal}`, { type: "artifact.cancel", transferId: "expired-transfer" });
      // A read response acts as an ordering barrier: no runtime error may precede it.
      device.sendData(JSON.stringify({ type: "artifact.read", protocolVersion: PROTOCOL_VERSION,
        transferId, requestId: `read-${terminal}`, offset: 0, length: 4 }));
      await expect(device.receiveMessage()).resolves.toMatchObject({
        type: "artifact.read.failed", transferId, requestId: `read-${terminal}`, reason: "unknown_transfer",
      });
    }
  });

  // SC121: an actual local adapter's completed output must hand off a device-owned reference to the file receiver.
  it("resolves an explicit workspace delivery from the authenticated model message", async () => {
    stateDir = await mkdtemp(join(tmpdir(), "orbis-output-card-"));
    relay = await startRelay(stateDir);
    const cwd = join(stateDir, "workspace");
    await mkdir(join(cwd, "reports"), { recursive: true });
    const text = "A saved proof report";
    await writeFile(join(cwd, "reports", "summary.txt"), text);
    host = await HostService.create({ relayUrl: relay.url, ...relayBusinessHostOptions(relay.url), credential: "runtime-secret",
      adminToken: "owner-secret", stateDir, reconnect: false, lan: false, probeIntervalMs: 0 });
    await host.start();
    const paired = await pairDevice({ relay, host });
    device = paired.device;
    await device.openChannel("relay", paired.pskRoot, host.hostId, host.hostId);
    await readMatching(device, msg => msg.type === "device.path");
    device.sendData(JSON.stringify({ type: "device.features", protocolVersion: PROTOCOL_VERSION, features: [DEVICE_FEATURE_MESSAGE_RENDER] }));
    await readMatching(device, msg => msg.type === "device.ready");
    const descriptor = host.loopback?.descriptor;
    if (!descriptor) throw new Error("loopback descriptor missing");
    runtime = await TestRuntime.connect({ url: descriptor.url, token: descriptor.token,
      metadata: { runtimeId: "pi-output-fixture", name: "Pi", cwd, status: "idle", sessionId: "output-session" } });
    await runtime.next();
    await readMatching(device, msg => msg.type === "runtime.online");
    const message: ChatMessage = { messageId: "delivery", role: "assistant", timestamp: 1,
      content: [{ type: "text", text: "[报告](reports/summary.txt)" }] };
    runtime.publish(1, { type: "message.finished", message });
    const outcome = RelayToDeviceMessageSchema.parse(await readMatching(device, msg => (msg.event as RuntimeEvent | undefined)?.type === "message.finished"));
    if (outcome.type !== "runtime.event" || outcome.event.type !== "message.finished") throw new Error("completed reply missing");
    const file = outcome.event.message.content.find(block => block.type === "render" && block.purpose === "output");
    expect(file).toMatchObject({ renderKind: "file_reference", file: { fileName: "summary.txt", referenceId: expect.stringMatching(/^orbis-message-file:/) } });
    if (file?.type !== "render" || !file.file?.referenceId) throw new Error("reference missing");
    expect(JSON.stringify(outcome)).not.toContain(text);
    await expect(device.nextIncoming(100)).rejects.toThrow("超时");
    device.sendCommand(host.hostId, "preview:reply-card", { type: "file.download", path: file.file.referenceId,
      maxBytes: NATIVE_FILE_PREVIEW_BYTES.text, previewFormat: "text" });
    const reply = RelayToDeviceMessageSchema.parse(await readMatching(device, msg => msg.type === "file.preview.started"));
    if (reply.type !== "file.preview.started") throw new Error("offer missing");
    expect(reply).toMatchObject({ referenceId: file.file.referenceId, format: "text", size: text.length });
    device.sendData(JSON.stringify({ type: "artifact.read", protocolVersion: PROTOCOL_VERSION,
      transferId: reply.transferId, requestId: "reply-card", offset: 0, length: reply.size }));
    const data = await device.nextIncoming();
    if (!("payload" in data)) throw new Error("preview chunk missing");
    expect(data.channel).toEqual("bulk");
    expect(Buffer.from(decodeArtifactChunkFrame(data.payload).data).toString()).toEqual(text);
  }, 15_000);

  // FILE-PREVIEW-02/03 / SC116, SC118, SC122, SC126: exercise actual E2E envelopes and the existing receiver-driven path.
  it.each([
    ["relay", "web"], ["lan", "web"], ["relay", "text"], ["lan", "text"],
  ] as const)("serves selected preview ranges over %s (%s) on bulk only", async (path, format) => {
    stateDir = await mkdtemp(join(tmpdir(), "orbis-preview-wire-"));
    relay = await startRelay(stateDir);
    const artifactId = randomUUID();
    const web = format === "web";
    const fileName = web ? "report.html" : "report.txt";
    const file = join(stateDir, fileName);
    // Web bodies are compressed; random text still needs more than the range sent with the reply.
    const body = web ? randomBytes(200 * 1024).toString("base64") : "x".repeat(FILE_PREVIEW_CHUNK_BYTES);
    const original = web ? `<h1>Preview fixture</h1><pre>${body}</pre>` : `Preview fixture\n${body}`;
    await writeFile(file, original);
    await writeFile(join(stateDir, "artifacts.json"), JSON.stringify({ version: 1, artifacts: [{
      artifactId, path: file, runtimeId: "fixture", seenAt: Date.now(), fileName, mimeType: web ? "text/html" : "text/plain",
      size: Buffer.byteLength(original), sha256: createHash("sha256").update(original).digest("hex"),
    }] }));
    host = await HostService.create({ relayUrl: relay.url, ...relayBusinessHostOptions(relay.url), credential: "runtime-secret",
      adminToken: "owner-secret", stateDir, reconnect: false, lan: path === "lan", lanPort: 0, probeIntervalMs: 0 });
    await host.start();
    const lanPort = host.lan?.port;
    if (path === "lan" && lanPort === undefined) throw new Error("LAN fixture did not start");
    const lan = path === "lan" && lanPort !== undefined ? [{ host: "127.0.0.1", port: lanPort }] : [];
    const paired = await pairDevice({ relay, host, lan });
    device = paired.device;
    if (path === "lan") await device.openLanPath(`ws://127.0.0.1:${lan[0]!.port}/v1/lan`);
    await device.openChannel(path, paired.pskRoot, host.hostId, host.hostId);
    expect(await device.receiveMessage()).toMatchObject({ type: "device.ready", hostFeatures: expect.arrayContaining([HOST_FEATURE_WEB_PREVIEW, HOST_FEATURE_NATIVE_FILE_PREVIEW]) });
    expect(await device.receiveMessage()).toMatchObject({ type: "device.path", path });
    await expect(device.nextIncoming(100)).rejects.toThrow("超时");
    const request = (message: Record<string, unknown>) => device!.sendData(JSON.stringify({ protocolVersion: PROTOCOL_VERSION, ...message }));
    device.sendCommand(host.hostId, "ordinary-before", { type: "artifact.download", artifactId });
    const before = await device.receiveMessage();
    expect(before).toMatchObject({ type: "runtime.event", sequence: expect.any(Number), event: { type: "artifact.started" } });
    const transferId = randomUUID();
    device.sendCommand(host.hostId, "preview:fixture", { type: "artifact.download", artifactId,
      ...(web ? { web: { page: randomUUID(), transferId } } : { maxBytes: NATIVE_FILE_PREVIEW_BYTES.text, previewFormat: format }) });
    const offer = await device.nextIncoming();
    if (!("payload" in offer)) throw new Error("preview offer not received");
    expect(offer.channel).toBe("ctl"); expect(offer.kind).toBe(path);
    const ready = RelayToDeviceMessageSchema.parse(JSON.parse(offer.payload.toString()));
    expect(ready).toMatchObject({ type: "file.preview.started", commandId: "preview:fixture", artifactId, format });
    if (ready.type !== "file.preview.started") throw new Error("preview rejected");
    const chunks: Uint8Array[] = [];
    let start = 0;
    if (web) {
      // FILE-PREVIEW-03: the first range follows the reply on bulk, owned by the transfer id the device chose.
      expect(ready).toMatchObject({ transferId, encoding: "deflate-raw", resource: fileName, contentSize: Buffer.byteLength(original) });
      const pushed = await device.nextIncoming();
      if (!("payload" in pushed)) throw new Error("first preview range not received");
      expect(pushed.channel).toBe("bulk");
      const chunk = decodeArtifactChunkFrame(pushed.payload);
      expect(chunk).toMatchObject({ transferId, offset: 0 });
      chunks.push(chunk.data); start = chunk.data.byteLength;
      expect(start).toBe(FILE_PREVIEW_CHUNK_BYTES);
    }
    await expect(device.nextIncoming(100)).rejects.toThrow("超时");
    for (let offset = start; offset < ready.size; offset += FILE_PREVIEW_CHUNK_BYTES) {
      const length = Math.min(FILE_PREVIEW_CHUNK_BYTES, ready.size - offset);
      request({ type: "artifact.read", transferId: ready.transferId, requestId: `range:${offset}`, offset, length });
      const incoming = await device.nextIncoming();
      if (!("payload" in incoming)) throw new Error("preview chunk not received");
      expect(incoming.channel).toBe("bulk"); expect(incoming.kind).toBe(path);
      const chunk = decodeArtifactChunkFrame(incoming.payload);
      expect(chunk).toMatchObject({ runtimeId: host.hostId, transferId: ready.transferId, offset });
      expect(chunk.data.byteLength).toBe(length);
      chunks.push(chunk.data);
    }
    const received = Buffer.concat(chunks);
    const prepared = web ? inflateRawSync(received) : received;
    expect(createHash("sha256").update(prepared).digest("hex")).toBe(ready.sha256);
    expect(prepared.toString()).toBe(original);
    request({ type: "artifact.done", transferId: ready.transferId });
    request({ type: "artifact.read", transferId: ready.transferId, requestId: "after-done", offset: 0, length: 1 });
    expect(await device.receiveMessage()).toMatchObject({ type: "artifact.read.failed", reason: "unknown_transfer" });
    device.sendCommand(host.hostId, "ordinary", { type: "artifact.download", artifactId });
    expect(await device.receiveMessage()).toMatchObject({ type: "runtime.event", sequence: (before.sequence as number) + 1,
      event: { type: "artifact.started", commandId: "ordinary", artifact: { artifactId, size: Buffer.byteLength(original) } } });
  }, 30_000);

  it("pull 模式：设备按范围索取，Host 只回被请求的那一段", async () => {
    stateDir = await mkdtemp(join(tmpdir(), "orbis-host-"));
    relay = await startRelay(stateDir);
    host = await HostService.create({
      relayUrl: relay.url, ...relayBusinessHostOptions(relay.url),
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
    stateDir = await mkdtemp(join(tmpdir(), "orbis-host-"));
    relay = await startRelay(stateDir);

    host = await HostService.create({
      relayUrl: relay.url, ...relayBusinessHostOptions(relay.url),
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
    stateDir = await mkdtemp(join(tmpdir(), "orbis-host-"));
    relay = await startRelay(stateDir);

    // WS 掐 TCP 代理；QUIC 关闭并重开独立 Host 接入端。Node Relay 与手机连接
    // 均保持，验证 Host 断链后出口重挂，手机无需重新连接才能再次握手。
    const quicHost = process.env.ORBIS_TEST_HOST_TRANSPORT === "quic";
    if (!quicHost) proxy = await TcpProxy.listen(relay.url);

    const relayStates: string[] = [];
    host = await HostService.create({
      relayUrl: proxy?.url ?? relay.url,
      ...relayBusinessHostOptions(relay.url),
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

    if (quicHost) await restartBusinessHostQUIC(relay.url);
    else proxy!.dropAll();
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

  // FT-G09-WIRE: records only follow active interests; the explicit field report
  // travels over E2E and contains counts/paths, never source content or credentials.
  it("FT-G09 scopes records and exposes bounded field statistics over E2E", async () => {
    stateDir = await mkdtemp(join(tmpdir(), "orbis-fields-wire-")); relay = await startRelay(stateDir);
    host = await HostService.create({ relayUrl: relay.url, ...relayBusinessHostOptions(relay.url), credential: "runtime-secret", adminToken: "owner-secret",
      stateDir, reconnect: false, lan: false }); await host.start();
    const paired = await pairDevice({ relay, host }); device = paired.device;
    await device.openChannel("relay", paired.pskRoot, paired.payload.hostId, paired.payload.hostId);
    await readMatching(device, message => message.type === "device.path");
    const descriptor = host.loopback!.descriptor!;
    runtime = await TestRuntime.connect({ url: descriptor.url, token: descriptor.token,
      metadata: { runtimeId: "pi-fields", sessionId: "fields", name: "private-content-name", cwd: stateDir, status: "idle" } });
    await runtime.next(); await readMatching(device, message => message.type === "runtime.online");
    const read = (id: string, domains: string[]) => device!.sendData(JSON.stringify({ type: "agent.state.request", protocolVersion: 19,
      requestId: id, runtimeId: "pi-fields", scope: "agent", stateFormat: "compact-v2", domains, subscribe: true }));
    read("records-open", ["records", "identity"]);
    await readMatching(device, message => message.requestId === "records-open");
    host.recordDiagnostic({ scope: "host", agentKind: null, sessionId: null, category: "transport", severity: "info", message: "synthetic record" });
    const update = await readMatching(device, message => message.requestId === "records-open");
    expect(update).toMatchObject({ update: true, domains: [{ domain: "records" }] });
    read("records-closed", ["identity"]);
    await readMatching(device, message => message.requestId === "records-closed");
    host.recordDiagnostic({ scope: "host", agentKind: null, sessionId: null, category: "transport", severity: "info", message: "second record" });
    device.sendData(JSON.stringify({ type: "transport.fields.read", protocolVersion: 19, requestId: "field-report", backend: "pi", cursor: null, limit: 100 }));
    const report = await device.receiveMessage();
    expect(report.type).toBe("transport.fields.page"); expect(report.requestId).toBe("field-report");
    expect((report.rows as unknown[]).length).toBeGreaterThan(0);
    expect(Buffer.byteLength(JSON.stringify(report))).toBeLessThan(64 * 1024);
    for (const secret of ["private-content-name", "runtime-secret", "owner-secret", "synthetic record", "second record"])
      expect(JSON.stringify(report)).not.toContain(secret);
  });

  // FT-G07-WIRE: negotiate the representation, deliver a shared checkpoint
  // through the real sync coordinator, then append live text with an exact base.
  it.each(["FT-G07", "FT-G08"])("%s shares public checkpoint bodies and streams exact text over E2E", async scenario => {
    stateDir = await mkdtemp(join(tmpdir(), "orbis-content-wire-")); relay = await startRelay(stateDir);
    host = await HostService.create({ relayUrl: relay.url, ...relayBusinessHostOptions(relay.url), credential: "runtime-secret", adminToken: "owner-secret",
      stateDir, reconnect: false, lan: false }); await host.start();
    const paired = await pairDevice({ relay, host }); device = paired.device;
    await device.openChannel("relay", paired.pskRoot, paired.payload.hostId, paired.payload.hostId);
    await readMatching(device, message => message.type === "device.path");
    const descriptor = host.loopback!.descriptor!;
    runtime = await TestRuntime.connect({ url: descriptor.url, token: descriptor.token,
      metadata: { runtimeId: "runtime", sessionId: "session", name: "Pi", cwd: stateDir, status: "idle" } });
    await runtime.next(); await readMatching(device, message => message.type === "runtime.online");
    device.sendData(JSON.stringify({ type: "agent.state.request", protocolVersion: 19, requestId: "content-format", scope: "agent",
      runtimeId: "runtime", stateFormat: "compact-v2", domains: ["identity"], subscribe: true }));
    await readMatching(device, message => message.requestId === "content-format");
    // FT-G07 remains a deployed client without history-interest negotiation.
    if (scenario === "FT-G08") {
    device.sendData(JSON.stringify({ type: "session.history.capabilities.request", protocolVersion: 19, requestId: "history-format" }));
    expect(await readMatching(device, message => message.requestId === "history-format"))
      .toMatchObject({ type: "session.history.capabilities", format: "v1", maxPageBytes: 65536 });
    // FT-G12-INTEREST-01: capability discovery is not an accepted interest. Lost replies
    // and a temporarily rejected target must keep the deployed broadcast recovery path alive.
    runtime.publish(1, { type: "message.delta", messageId: "negotiating", delta: "before interest" });
    expect(await readMatching(device, message => (message.event as RuntimeEvent | undefined)?.type === "message.delta"))
      .toMatchObject({ event: { delta: "before interest" } });
    device.sendData(JSON.stringify({ type: "session.history.interest", protocolVersion: 19, requestId: "history-rejected",
      runtimeId: "runtime", sessionId: "wrong-session" }));
    expect(await readMatching(device, message => message.requestId === "history-rejected")).toMatchObject({ accepted: false });
    runtime.publish(2, { type: "message.delta", messageId: "negotiating", delta: "after rejection" });
    expect(await readMatching(device, message => (message.event as RuntimeEvent | undefined)?.type === "message.delta"))
      .toMatchObject({ event: { delta: "after rejection" } });
    device.sendData(JSON.stringify({ type: "session.history.interest", protocolVersion: 19, requestId: "history-interest",
      runtimeId: "runtime", sessionId: "session" }));
    expect(await readMatching(device, message => message.requestId === "history-interest"))
      .toMatchObject({ type: "session.history.interest.result", accepted: true });
    }
    device.sendCommand("runtime", "content-sync", { type: "session.sync", sessionId: "session", syncId: "sync", range: "preview" });
    const request = await runtime.next();
    const fixture = JSON.parse(await readFile(new URL("../../../ios/Orbis/Tests/Fixtures/field-transport-session.json", import.meta.url), "utf8"));
    if (scenario === "FT-G08") {
      fixture.initial.event.entries[0].data.nativePrivate = "raw-native-data".repeat(5000);
      fixture.initial.event.entries[0].data.message.nativeUsage = { trace: "private-trace".repeat(5000) };
    }
    runtime.publish(1, { ...fixture.initial.event, syncId: (request.command as { syncId: string }).syncId });
    const checkpoint = await readMatching(device, message => (message.event as RuntimeEvent | undefined)?.type === "session.snapshot");
    expect(checkpoint.sharedContent).toEqual(fixture.wireInitial.sharedContent);
    expect(checkpoint.event).toEqual({ ...fixture.wireInitial.event, syncId: "sync" });
    if (scenario === "FT-G08") {
      device.sendCommand("runtime", "native-detail", { type: "session.entry.request", sessionId: "session", requestId: "native-detail", entryId: "entry-1" });
      const detail = await readMatching(device, message => (message.event as RuntimeEvent | undefined)?.type === "session.entry.result");
      expect((detail.event as { entry: unknown }).entry).toEqual(fixture.initial.event.entries[0]);
    }
    runtime.publish(2, fixture.patch.event);
    const patch = await readMatching(device, message => (message.event as RuntimeEvent | undefined)?.type === "session.patch");
    expect(patch.sharedContent).toEqual(fixture.wirePatch.sharedContent);
    const delta = (patch.sharedContent as { liveDelta: { operations: Parameters<typeof applyStateDelta>[1] } }).liveDelta;
    expect(applyStateDelta(fixture.initial.event.live, delta.operations)).toEqual(fixture.patch.event.live);
    if (scenario === "FT-G08") {
      device.sendData(JSON.stringify({ type: "session.history.interest", protocolVersion: 19, requestId: "history-close",
        runtimeId: null, sessionId: null }));
      expect(await readMatching(device, message => message.requestId === "history-close")).toMatchObject({ accepted: true });
      // Duplicate capability probes must not reopen an explicitly closed interest.
      device.sendData(JSON.stringify({ type: "session.history.capabilities.request", protocolVersion: 19, requestId: "history-format-again" }));
      await readMatching(device, message => message.requestId === "history-format-again");
      const next = structuredClone(fixture.patch.event);
      next.source.seq = 3; next.baseSeq = 2; next.seq = 3; next.checkpointId = "checkpoint-3";
      next.live.messages[0].finished = true;
      runtime.publish(3, next);
      runtime.publish(4, { type: "message.delta", messageId: "stream", delta: "hidden legacy body" });
      // A backend FIFO barrier proves the hidden patch was processed. Control replies and
      // notifications remain allowed; none may contain chat content after closing interest.
      device.sendCommand("runtime", "history-barrier", { type: "stop" });
      expect(await runtime.next()).toMatchObject({ commandId: "history-barrier" });
      runtime.publish(5, { type: "command.result", commandId: "history-barrier", ok: true });
      for (;;) {
        const message = await device.receiveMessage();
        expect(["session.patch", "message.delta"]).not.toContain((message.event as RuntimeEvent | undefined)?.type);
        if ((message.event as { commandId?: string } | undefined)?.commandId === "history-barrier") break;
      }
      // msg and ctl have independent scheduling: also inspect delayed msg frames.
      for (;;) {
        const incoming = await device.nextIncoming(200).catch(() => undefined);
        if (!incoming) break;
        if ("payload" in incoming) expect(["session.patch", "message.delta"]).not.toContain(JSON.parse(incoming.payload.toString()).event?.type);
      }
      device.sendData(JSON.stringify({ type: "session.history.interest", protocolVersion: 19, requestId: "history-reopen",
        runtimeId: "runtime", sessionId: "session" }));
      expect(await readMatching(device, message => message.requestId === "history-reopen")).toMatchObject({ accepted: true });
      // FT-G12-RESUME-01: the App reconciles after its current interest is accepted.
      // A reply that finished while hidden must be recoverable without another live event.
      device.sendCommand("runtime", "history-resume", { type: "session.sync", sessionId: "session", syncId: "history-resume",
        range: "preview", knownState: { epoch: "source", seq: 2, head: { leafId: "entry-1" } } });
      expect(await readMatching(device, message => (message.event as { syncId?: string } | undefined)?.syncId === "history-resume"))
        .toMatchObject({ event: { type: "session.snapshot", source: { epoch: "source", seq: 3 }, selection: "state",
          live: { messages: [{ finished: true }] } } });
      next.source.seq = 4; next.baseSeq = 3; next.seq = 4; next.checkpointId = "checkpoint-4";
      runtime.publish(6, next);
      expect(await readMatching(device, message => (message.event as RuntimeEvent | undefined)?.type === "session.patch"))
        .toMatchObject({ event: { seq: 4 } });
      runtime.publish(7, { type: "message.delta", messageId: "stream", delta: "visible legacy body" });
      expect(await readMatching(device, message => (message.event as RuntimeEvent | undefined)?.type === "message.delta"))
        .toMatchObject({ event: { delta: "visible legacy body" } });
    }
  });

  // FT-G12-DETAIL-01: real E2E detail reads must reach the native Pi transcript after
  // the Host has only a truncated preview, including a deployed non-compact client.
  it.each([false, true])("reads full native text after a truncated snapshot (compact=%s)", async compact => {
    stateDir = await mkdtemp(join(tmpdir(), "orbis-full-entry-"));
    const sessionsRoot = join(stateDir, "sessions"), group = join(sessionsRoot, "work");
    await mkdir(group, { recursive: true });
    const text = "完整回复🙂".repeat(10_000);
    const native = { id: "long", parentId: null, type: "message", timestamp: "2026-11-14T00:00:00.000Z",
      message: { role: "assistant", content: [{ type: "text", text }] } };
    await writeFile(join(group, "history.jsonl"), [JSON.stringify({ type: "session", id: "session", cwd: stateDir }), JSON.stringify(native)].join("\n") + "\n");
    relay = await startRelay(stateDir);
    host = await HostService.create({ relayUrl: relay.url, ...relayBusinessHostOptions(relay.url), credential: "runtime-secret", adminToken: "owner-secret",
      stateDir, sessionsRoot, reconnect: false, lan: false }); await host.start();
    const paired = await pairDevice({ relay, host }); device = paired.device;
    await device.openChannel("relay", paired.pskRoot, paired.payload.hostId, paired.payload.hostId);
    await readMatching(device, message => message.type === "device.path");
    const descriptor = host.loopback!.descriptor!;
    runtime = await TestRuntime.connect({ url: descriptor.url, token: descriptor.token,
      metadata: { runtimeId: "runtime", sessionId: "session", name: "Pi", cwd: stateDir, status: "idle" } });
    await runtime.next(); await readMatching(device, message => message.type === "runtime.online");
    if (compact) {
      device.sendData(JSON.stringify({ type: "agent.state.request", protocolVersion: 19, requestId: "format", scope: "agent",
        runtimeId: "runtime", stateFormat: "compact-v2", domains: ["identity"], subscribe: true }));
      await readMatching(device, message => message.requestId === "format");
    }
    device.sendCommand("runtime", "sync", { type: "session.sync", sessionId: "session", syncId: "sync", range: "preview" });
    const forwarded = await runtime.next();
    const original = { entryId: native.id, parentId: native.parentId, type: native.type, timestamp: native.timestamp, data: { message: native.message } };
    const snapshot = selectSessionSyncSnapshot([original], "session", "long", { sessionId: "session", syncId: (forwarded.command as { syncId: string }).syncId, range: "preview" }, [], {
      version: { epoch: "source", seq: 1, ready: true }, live: { complete: true, turn: null, messages: [], tools: [] },
      checkpoint: { checkpointId: "source:1", head: { leafId: "long" }, headCompleteness: "complete", inventoryComplete: true },
    });
    runtime.publish(1, snapshot);
    const preview = await readMatching(device, message => (message.event as RuntimeEvent | undefined)?.type === "session.snapshot");
    expect((preview.event as typeof snapshot).display?.entries[0]?.message?.content[0]).toMatchObject({ truncated: true });
    device.sendCommand("runtime", "detail", { type: "session.entry.request", sessionId: "session", requestId: "detail", entryId: "long" });
    const detail = await readMatching(device, message => (message.event as RuntimeEvent | undefined)?.type === "session.entry.result");
    expect(detail.event).toEqual({ type: "session.entry.result", requestId: "detail", entryId: "long", entry: original });
    device.sendCommand("runtime", "wrong", { type: "session.entry.request", sessionId: "other", requestId: "wrong", entryId: "long" });
    expect(await readMatching(device, message => (message.event as { requestId?: string } | undefined)?.requestId === "wrong"))
      .toMatchObject({ event: { error: "session_mismatch" } });
  });

  // FT-G12-COMPAT-01 / ADR-0064: bounded history is a Host transaction option, not a
  // field that can be sent through an unchanged released adapter's strict parser.
  it("FT-G12 strips history transaction limits before dispatching to an adapter", async () => {
    stateDir = await mkdtemp(join(tmpdir(), "orbis-history-adapter-wire-")); relay = await startRelay(stateDir);
    host = await HostService.create({ relayUrl: relay.url, ...relayBusinessHostOptions(relay.url), credential: "runtime-secret", adminToken: "owner-secret",
      stateDir, reconnect: false, lan: false }); await host.start();
    const paired = await pairDevice({ relay, host }); device = paired.device;
    await device.openChannel("relay", paired.pskRoot, paired.payload.hostId, paired.payload.hostId);
    await readMatching(device, message => message.type === "device.path");
    const descriptor = host.loopback!.descriptor!;
    runtime = await TestRuntime.connect({ url: descriptor.url, token: descriptor.token,
      metadata: { runtimeId: "history-adapter", sessionId: "session", name: "Pi", cwd: stateDir, status: "idle" } });
    await runtime.next(); await readMatching(device, message => message.type === "runtime.online");
    device.sendCommand("history-adapter", "history-window", { type: "session.sync", sessionId: "session", syncId: "history-window",
      range: "history", targetLeafId: "entry-9", beforeEntryId: "entry-4", maxEntries: 30,
      historyWindow: { format: "v1", maxBytes: 65536, maxDeliveries: 2 } });
    const baseline = await runtime.next();
    expect(baseline.command).toMatchObject({ type: "session.sync", range: "preview" });
    const fixture = JSON.parse(await readFile(new URL("../../../ios/Orbis/Tests/Fixtures/field-transport-session.json", import.meta.url), "utf8"));
    runtime.publish(1, { ...fixture.initial.event, syncId: (baseline.command as { syncId: string }).syncId });
    const forwarded = await runtime.next();
    expect(forwarded.command).toMatchObject({ type: "session.sync", sessionId: "session", range: "history",
      targetLeafId: "entry-9", beforeEntryId: "entry-4", maxEntries: 30 });
    expect(forwarded.command).not.toHaveProperty("historyWindow");
  });

  // FT-G06-WIRE: exercise negotiated patches through real encrypted delivery,
  // then recover an intentionally missed update with a full read.
  it("FT-G06 sends collection deltas and recovers full state over E2E", async () => {
    stateDir = await mkdtemp(join(tmpdir(), "orbis-deltas-wire-")); relay = await startRelay(stateDir);
    host = await HostService.create({ relayUrl: relay.url, ...relayBusinessHostOptions(relay.url), credential: "runtime-secret", adminToken: "owner-secret",
      stateDir, reconnect: false, lan: false }); await host.start();
    const paired = await pairDevice({ relay, host }); device = paired.device;
    await device.openChannel("relay", paired.pskRoot, paired.payload.hostId, paired.payload.hostId);
    await readMatching(device, message => message.type === "device.path");
    const descriptor = host.loopback!.descriptor!;
    runtime = await TestRuntime.connect({ url: descriptor.url, token: descriptor.token,
      metadata: { runtimeId: "pi-deltas", sessionId: "deltas", name: "Pi", cwd: stateDir, status: "idle" } });
    await runtime.next(); await readMatching(device, message => message.type === "runtime.online");
    const commands = Array.from({ length: 100 }, (_, i) => ({ name: `command-${i}`, source: "builtin" as const }));
    runtime.publish(1, { type: "runtime.capabilities", capabilities: { commands } });
    await readMatching(device, message => (message.event as RuntimeEvent | undefined)?.type === "runtime.capabilities");
    const read = (id: string) => device!.sendData(JSON.stringify({ type: "agent.state.request", protocolVersion: 19, requestId: id,
      scope: "agent", runtimeId: "pi-deltas", stateFormat: "compact-v2", domains: ["capabilities"], subscribe: true }));
    read("delta-baseline");
    const baseline = await readMatching(device, message => message.requestId === "delta-baseline");
    const old = (baseline.domains as AgentStateDomainSnapshot[])[0]!;
    runtime.publish(2, { type: "runtime.capabilities", capabilities: { commands: commands.slice(1) } });
    const update = await readMatching(device, message => message.requestId === "delta-baseline");
    const row = (update.domains as AgentStateDomainSnapshot[])[0]!;
    expect(row.delta?.baseRevision).toBe(old.revision); expect(row.value).toBeNull();
    const reconstructed = applyStateDelta(old.value, row.delta!.operations);
    expect(reconstructed).not.toHaveProperty("command-0"); expect(Object.keys(reconstructed as object)).toHaveLength(99);
    expect(Buffer.byteLength(JSON.stringify(update))).toBeLessThan(Buffer.byteLength(JSON.stringify(baseline)) / 2);
    read("delta-recovery");
    const recovered = await readMatching(device, message => message.requestId === "delta-recovery");
    expect((recovered.domains as AgentStateDomainSnapshot[])[0]!.value).toEqual(reconstructed);
    expect((recovered.domains as AgentStateDomainSnapshot[])[0]!.delta).toBeUndefined();
  });

  // FT-G11-WIRE: source invalidation publishes without another phone poll;
  // a lost publication then reconciles the actual old applied revision.
  it("FT-G11 reconciles a missed catalog publication over encrypted delivery", async () => {
    stateDir = await mkdtemp(join(tmpdir(), "orbis-catalog-read-wire-")); relay = await startRelay(stateDir);
    const sessionsRoot = join(stateDir, "sessions"), group = join(sessionsRoot, "repo");
    await mkdir(group, { recursive: true });
    const writeSession = async (n: number, name = `Session ${n} ${"title ".repeat(28)}`) => {
      const id = `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
      const path = join(group, `${id}.jsonl`);
      await writeFile(path, JSON.stringify({ type: "session", version: 3, id,
        name, cwd: "/repo/" + "workspace/".repeat(20) }) + "\n");
      // This scenario changes a title only. Concurrent file writes otherwise create mtime
      // ties and Date round-tripping can move the renamed row, testing a different workload.
      const time = new Date(Date.UTC(2026, 10, 7, 0, 0, n));
      await utimes(path, time, time);
    };
    await Promise.all(Array.from({ length: 180 }, (_, n) => writeSession(n)));
    host = await HostService.create({ relayUrl: relay.url, ...relayBusinessHostOptions(relay.url), credential: "runtime-secret", adminToken: "owner-secret",
      stateDir, sessionsRoot, reconnect: false, lan: false }); await host.start();
    const paired = await pairDevice({ relay, host }); device = paired.device;
    await device.openChannel("relay", paired.pskRoot, paired.payload.hostId, paired.payload.hostId);
    await readMatching(device, message => message.type === "device.path");
    const read = (id: string, known: unknown[] = [], compact = true) => device!.sendData(JSON.stringify({ type: "agent.state.request",
      protocolVersion: PROTOCOL_VERSION, requestId: id, scope: "host", domains: ["catalog"], subscribe: true, known,
      ...(compact ? { stateFormat: "compact-v2" } : {}) }));
    read("catalog-before");
    const initial = await readMatching(device, message => message.requestId === "catalog-before");
    const before = (initial.domains as AgentStateDomainSnapshot[])[0]!;
    expect((before.value as { sessions: unknown[]; nextCursor: string | null }).sessions.length).toBeLessThan(180);
    expect((before.value as { nextCursor: string | null }).nextCursor).toBeTruthy();
    expect(Buffer.byteLength(JSON.stringify(initial))).toBeLessThan(32 * 1024);
    const firstSession = ((before.value as { sessions: Array<{ sessionId: string }> }).sessions[0]!);
    const firstSessionNumber = Number(firstSession.sessionId.slice(-12));
    const firstSessionPath = join(group, `${firstSession.sessionId}.jsonl`);
    const firstSessionMtime = (await stat(firstSessionPath)).mtime;
    await writeSession(firstSessionNumber, "Renamed without changing directory order");
    await utimes(firstSessionPath, firstSessionMtime, firstSessionMtime);
    await host.reloadProviderConfiguration("pi", {});
    const published = await readMatching(device, message => message.requestId === "catalog-before" && message.update === true);
    const current = (published.domains as AgentStateDomainSnapshot[])[0]!;
    const value = current.delta ? applyStateDelta(before.value, current.delta.operations) : current.value;
    expect((value as { sessions: Array<{ sessionId: string; name?: string }> }).sessions.find(session => session.sessionId === firstSession.sessionId)?.name)
      .toBe("Renamed without changing directory order");
    read("catalog-after-loss", [{ domain: "catalog", modelEpoch: before.modelEpoch, revision: before.revision }]);
    const recovered = await readMatching(device, message => message.requestId === "catalog-after-loss");
    const delta = (recovered.domains as AgentStateDomainSnapshot[])[0]!;
    expect(delta.delta?.baseRevision).toBe(before.revision);
    expect(applyStateDelta(before.value, delta.delta!.operations)).toEqual(value);
    expect(Buffer.byteLength(JSON.stringify(recovered))).toBeLessThan(4_096);
    const collect = async (domain: Record<string, unknown>): Promise<unknown[]> => {
      let cursor = domain.nextCursor as string | null; let offset = (domain.sessions as unknown[]).length;
      const sessions = [...domain.sessions as unknown[]]; let pageNumber = 0;
      while (cursor) {
        const requestId = `catalog-range-${pageNumber++}`;
        device!.sendData(JSON.stringify({ type: "agent.state.range.request", protocolVersion: PROTOCOL_VERSION, requestId,
          scope: "host", domain: "catalog", cursor, limit: 200 }));
        const response = await readMatching(device!, message => message.requestId === requestId);
        const page = response.page as { offset: number; sessions: unknown[]; nextCursor: string | null };
        expect(page.offset).toBe(offset);
        expect(Buffer.byteLength(JSON.stringify(response))).toBeLessThan(32 * 1024);
        sessions.push(...page.sessions); offset += page.sessions.length; cursor = page.nextCursor;
      }
      return sessions;
    };
    expect(await collect(value as Record<string, unknown>)).toHaveLength(180);
    read("catalog-old-peer", [], false);
    const legacy = await readMatching(device, message => message.requestId === "catalog-old-peer");
    expect((legacy.domains as AgentStateDomainSnapshot[])[0]!.delta).toBeUndefined();
    expect(Buffer.byteLength(JSON.stringify(legacy))).toBeLessThan(32 * 1024);
    expect(await collect((legacy.domains as AgentStateDomainSnapshot[])[0]!.value as Record<string, unknown>)).toHaveLength(180);
    device.sendData(JSON.stringify({ type: "session.catalog.capabilities.request", protocolVersion: PROTOCOL_VERSION, requestId: "query-capability" }));
    expect(await readMatching(device, message => message.requestId === "query-capability"))
      .toMatchObject({ type: "session.catalog.capabilities", format: "v1" });
    const query = { text: "Renamed without changing directory order", agentKind: "pi", archived: false, provider: "all" };
    device.sendData(JSON.stringify({ type: "session.catalog.query", protocolVersion: PROTOCOL_VERSION, requestId: "query-global", format: "v1",
      query, cursor: null, limit: 100 }));
    const result = await readMatching(device, message => message.requestId === "query-global");
    expect(result).toMatchObject({ type: "session.catalog.page", query, page: { offset: 0, totalSessions: 1,
      sessions: [{ sessionId: firstSession.sessionId }], nextCursor: null, complete: true } });
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(64 * 1024);
  });

  // FT-G05-WIRE: options travel only in requested bounded pages, invocation is
  // validated against the selected catalog, and new model clients avoid old menu replay.
  it("FT-G05 pages a long menu and validates exact versioned dispatch over E2E", async () => {
    stateDir = await mkdtemp(join(tmpdir(), "orbis-options-wire-")); relay = await startRelay(stateDir);
    host = await HostService.create({ relayUrl: relay.url, ...relayBusinessHostOptions(relay.url), credential: "runtime-secret", adminToken: "owner-secret",
      stateDir, reconnect: false, lan: false }); await host.start();
    const paired = await pairDevice({ relay, host }); device = paired.device;
    await device.openChannel("relay", paired.pskRoot, paired.payload.hostId, paired.payload.hostId);
    await readMatching(device, message => message.type === "device.path");
    const descriptor = host.loopback!.descriptor!;
    runtime = await TestRuntime.connect({ url: descriptor.url, token: descriptor.token,
      metadata: { runtimeId: "pi-options", sessionId: "options", name: "Pi", cwd: stateDir, status: "idle" } });
    await runtime.next(); await readMatching(device, message => message.type === "runtime.online");
    const options = Array.from({ length: 2009 }, (_, i) => ({ value: `native:${i}`, label: `节点 ${i}`, tree: {
      parentId: i ? `native:${i - 1}` : null, entryType: "message", role: "assistant", defaultHidden: false, isCurrent: i === 2008, isOnActivePath: true,
    } }));
    runtime.publish(1, { type: "runtime.capabilities", capabilities: { commands: [{ name: "tree", source: "builtin", argument: { kind: "tree", required: true, options } }] } });
    await readMatching(device, message => (message.event as RuntimeEvent | undefined)?.type === "runtime.capabilities");
    device.sendData(JSON.stringify({ type: "agent.state.request", protocolVersion: 19, requestId: "menu-catalog", scope: "agent", runtimeId: "pi-options",
      stateFormat: "compact-v1", domains: ["capabilities"], subscribe: true }));
    const snapshot = await readMatching(device, message => message.requestId === "menu-catalog");
    const ref = (snapshot.domains as Array<{ value: { tree: { argument: { optionCatalog: { id: string; count: number } } } } }>)[0]!.value.tree.argument.optionCatalog;
    expect(ref.count).toBe(2009); expect(Buffer.byteLength(JSON.stringify(snapshot))).toBeLessThan(4 * 1024);
    let cursor: string | null = null; const collected: unknown[] = [];
    do {
      device.sendData(JSON.stringify({ type: "agent.menu.options.read", protocolVersion: 19, requestId: "options-page", runtimeId: "pi-options",
        commandName: "tree", catalogId: ref.id, cursor }));
      const page = await readMatching(device, message => message.requestId === "options-page");
      expect(page.error).toBeUndefined(); expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(64 * 1024);
      collected.push(...page.options as unknown[]); cursor = page.nextCursor as string | null;
    } while (cursor);
    expect(collected).toEqual(options);
    device.sendData(JSON.stringify({ type: "runtime.command", protocolVersion: 19, runtimeId: "pi-options", commandId: "exact-option",
      command: { type: "slash.execute", name: "tree", args: "native:2008", optionCatalogId: ref.id } }));
    const forwarded = await runtime.next();
    expect(forwarded).toMatchObject({ commandId: "exact-option", command: { type: "slash.execute", name: "tree", args: "native:2008" } });
    expect(forwarded.command).not.toHaveProperty("optionCatalogId"); // private to the Host's validation boundary
    runtime.publish(2, { type: "runtime.capabilities", capabilities: { commands: [{ name: "tree", source: "builtin", argument: { kind: "tree", required: true, options: options.slice(0, 2) } }] } });
    const update = await device.receiveMessage();
    expect(update).toMatchObject({ type: "agent.state.snapshot", update: true, stateFormat: "compact-v1" });
    device.sendData(JSON.stringify({ type: "runtime.command", protocolVersion: 19, runtimeId: "pi-options", commandId: "stale-option",
      command: { type: "slash.execute", name: "tree", args: "native:2008", optionCatalogId: ref.id } }));
    const failed = await readMatching(device, message => (message.event as RuntimeEvent | undefined)?.type === "command.result");
    expect(failed.event).toMatchObject({ commandId: "stale-option", ok: false, error: "stale_menu_options" });
  });

  // FT-G04-WIRE: representation is explicitly selected per read and old clients
  // keep the full identity. Token updates cannot invalidate compact identity.
  it("FT-G04 versions static identity independently over the encrypted link", async () => {
    stateDir = await mkdtemp(join(tmpdir(), "orbis-compact-wire-")); relay = await startRelay(stateDir);
    host = await HostService.create({ relayUrl: relay.url, ...relayBusinessHostOptions(relay.url), credential: "runtime-secret", adminToken: "owner-secret",
      stateDir, reconnect: false, lan: false }); await host.start();
    const paired = await pairDevice({ relay, host }); device = paired.device;
    await device.openChannel("relay", paired.pskRoot, paired.payload.hostId, paired.payload.hostId);
    await readMatching(device, message => message.type === "device.path");
    const descriptor = host.loopback!.descriptor!;
    const metadata: RuntimeMetadata = { runtimeId: "pi-static", sessionId: "static", name: "Pi", cwd: stateDir, status: "idle",
      model: { provider: "p", id: "m" }, contextUsage: { tokens: 1, contextWindow: 100, percent: 1 } };
    runtime = await TestRuntime.connect({ url: descriptor.url, token: descriptor.token, metadata });
    await runtime.next(); await readMatching(device, message => message.type === "runtime.online");
    const read = (requestId: string, extra: object = {}) => device!.sendData(JSON.stringify({ type: "agent.state.request", protocolVersion: PROTOCOL_VERSION,
      scope: "agent", runtimeId: "pi-static", domains: ["identity"], requestId, ...extra }));
    read("compact-first", { stateFormat: "compact-v1", subscribe: true });
    const first = await readMatching(device, message => message.requestId === "compact-first");
    expect(first.stateFormat).toBe("compact-v1");
    const identity = (first.domains as Array<{ modelEpoch: string; revision: number; value: object }>)[0]!;
    expect(identity.value).toMatchObject({ runtimeId: "pi-static", name: "Pi", cwd: stateDir });
    expect(identity.value).not.toHaveProperty("status");
    expect(identity.value).not.toHaveProperty("contextUsage");
    runtime.publish(1, { type: "runtime.metadata", metadata: { ...metadata, status: "running", contextUsage: { tokens: 2, contextWindow: 100, percent: 2 } } });
    await readMatching(device, message => (message.event as RuntimeEvent | undefined)?.type === "runtime.metadata");
    read("compact-known", { stateFormat: "compact-v1", known: [{ domain: "identity", modelEpoch: identity.modelEpoch, revision: identity.revision }] });
    expect(await readMatching(device, message => message.requestId === "compact-known")).toMatchObject({ stateFormat: "compact-v1", domains: [], unchanged: ["identity"] });
    read("legacy-read");
    const legacy = await readMatching(device, message => message.requestId === "legacy-read");
    expect(legacy).not.toHaveProperty("stateFormat");
    expect((legacy.domains as Array<{ value: object }>)[0]!.value).toMatchObject({ status: "running", contextUsage: { tokens: 2 } });
  });

  // FT-G02-WIRE: a confirmed known-version read must not solicit a producer-wide
  // replay; a command on the same ordered loopback connection is the barrier.
  it("FT-G02 reads known versions without resync and still publishes real menu changes", async () => {
    stateDir = await mkdtemp(join(tmpdir(), "orbis-model-menu-")); relay = await startRelay(stateDir);
    host = await HostService.create({ relayUrl: relay.url, ...relayBusinessHostOptions(relay.url),
      credential: "runtime-secret", adminToken: "owner-secret", stateDir, reconnect: false, lan: false });
    await host.start();
    const paired = await pairDevice({ relay, host }); device = paired.device;
    await device.openChannel("relay", paired.pskRoot, paired.payload.hostId, paired.payload.hostId);
    await readMatching(device, message => message.type === "device.path");
    const descriptor = host.loopback!.descriptor!;
    runtime = await TestRuntime.connect({ url: descriptor.url, token: descriptor.token,
      metadata: { runtimeId: "pi-confirmed", sessionId: "confirmed", name: "Pi", cwd: stateDir, status: "idle" } });
    await runtime.next(); await readMatching(device, message => message.type === "runtime.online");
    const command = { name: "mcp:server:search", source: "mcp" as const };
    runtime.publish(1, { type: "runtime.capabilities", capabilities: { commands: [command] } });
    await readMatching(device, message => (message.event as RuntimeEvent | undefined)?.type === "runtime.capabilities");
    runtime.publish(2, { type: "interaction.snapshot", requests: [] });
    await readMatching(device, message => (message.event as RuntimeEvent | undefined)?.type === "interaction.snapshot");
    const requested = ["capabilities", "resources", "interactions"];
    const read = (requestId: string, known?: object[]) => device!.sendData(JSON.stringify({ type: "agent.state.request", protocolVersion: PROTOCOL_VERSION,
      scope: "agent", runtimeId: "pi-confirmed", domains: requested, subscribe: true, requestId, ...(known ? { known } : {}) }));
    read("confirmed-first");
    const first = await readMatching(device, message => message.requestId === "confirmed-first");
    const domains = first.domains as Array<{ domain: string; modelEpoch: string; revision: number }>;
    expect(domains.map(domain => domain.domain).sort()).toEqual([...requested].sort());
    read("confirmed-again", domains.map(({ domain, modelEpoch, revision }) => ({ domain, modelEpoch, revision })));
    const second = await readMatching(device, message => message.requestId === "confirmed-again");
    expect(second).toMatchObject({ domains: [], missing: [], truncated: false, unchanged: expect.arrayContaining(requested) });
    device.sendData(JSON.stringify({ type: "runtime.command", protocolVersion: PROTOCOL_VERSION, runtimeId: "pi-confirmed", commandId: "read-barrier",
      command: { type: "slash.execute", name: command.name, args: "exact" } }));
    expect(await runtime.next()).toMatchObject({ type: "runtime.command", commandId: "read-barrier" });

    runtime.publish(3, { type: "runtime.capabilities", capabilities: { commands: [command, { name: "new-skill", source: "skill" }] } });
    const changed = await readMatching(device, message => message.type === "agent.state.snapshot" && message.update === true);
    const capabilities = (changed.domains as Array<{ domain: string; revision: number; value: object }>).find(domain => domain.domain === "capabilities")!;
    expect(capabilities.revision).toBeGreaterThan(domains.find(domain => domain.domain === "capabilities")!.revision);
    expect(capabilities.value).toHaveProperty("new-skill");
  });

  // FT-G01-WIRE: verify the real encrypted Host exit, model response, reconnect
  // seed, and exact dispatch target; a helper-only projection test cannot cover wiring.
  it("FT-G01/FT-G10 project menus, suppress compact bootstrap replay, and preserve exact dispatch", async () => {
    stateDir = await mkdtemp(join(tmpdir(), "orbis-menu-wire-"));
    relay = await startRelay(stateDir);
    host = await HostService.create({ relayUrl: relay.url, ...relayBusinessHostOptions(relay.url),
      credential: "runtime-secret", adminToken: "owner-secret", stateDir, reconnect: false, lan: false });
    await host.start();
    const paired = await pairDevice({ relay, host }); device = paired.device;
    await device.openChannel("relay", paired.pskRoot, paired.payload.hostId, paired.payload.hostId);
    await readMatching(device, message => message.type === "device.path");
    const descriptor = host.loopback!.descriptor!;
    const metadata: RuntimeMetadata = { runtimeId: "pi-menu", sessionId: "menu-session", name: "Pi", cwd: stateDir, status: "idle",
      permissions: { sandbox: "read-only", approvalPolicy: "on-request" },
      permissionManagement: { summary: "Restricted", details: "权限风险必须保留", tone: "restricted", settings: [
        { id: "mode", label: "Mode", disabledReason: "禁止修改", options: [{ value: "safe", label: "Safe", description: "可省略选项说明" }] },
      ] } };
    runtime = await TestRuntime.connect({ url: descriptor.url, token: descriptor.token, metadata });
    await runtime.next();
    const online = await readMatching(device, message => message.type === "runtime.online");
    const checkMetadata = (value: unknown): void => {
      const management = (value as RuntimeMetadata).permissionManagement!;
      expect(management.details).toBe("权限风险必须保留");
      expect(management.settings[0]).toMatchObject({ disabledReason: "禁止修改", options: [{ value: "safe", label: "Safe" }] });
      expect(management.settings[0]!.options[0]).not.toHaveProperty("description");
    };
    checkMetadata(online.runtime);
    const command = { name: "mcp:server-one:search", source: "mcp" as const, description: "很长的 MCP 说明", argument: {
      kind: "select" as const, required: true, hint: "提示", options: [{ value: "native:exact-id", label: "准确目标", description: "选项说明" }],
    } };
    const expected = { ...command, argument: { kind: "select", required: true, options: [{ value: "native:exact-id", label: "准确目标" }] } } as Record<string, unknown>;
    delete expected.description;
    runtime.publish(1, { type: "runtime.capabilities", capabilities: { commands: [command] } });
    const menu = await readMatching(device, message => (message.event as RuntimeEvent | undefined)?.type === "runtime.capabilities");
    expect(menu.event).toEqual({ type: "runtime.capabilities", capabilities: { commands: [expected] } });
    device.sendData(JSON.stringify({ type: "agent.state.request", protocolVersion: PROTOCOL_VERSION, requestId: "menu-read",
      scope: "agent", runtimeId: "pi-menu", domains: ["identity", "capabilities", "resources", "permissions"] }));
    const model = await readMatching(device, message => message.requestId === "menu-read");
    const domains = new Map((model.domains as Array<{ domain: string; value: unknown }>).map(domain => [domain.domain, domain.value]));
    expect(domains.get("resources")).toEqual({ [command.name]: expected });
    expect(domains.get("capabilities")).toEqual({ [command.name]: { ...expected, argumentKind: "select", argumentRequired: true, optionCount: 1 } });
    checkMetadata(domains.get("identity"));
    expect((domains.get("permissions") as { management: object }).management).toEqual((online.runtime as RuntimeMetadata).permissionManagement);
    expect(host.localRuntimes[0]!.permissionManagement!.settings[0]!.options[0]).toHaveProperty("description");
    expect(command.description).toBe("很长的 MCP 说明");

    // The App submits the exact name and option; Host routes it without substituting a display label.
    device.sendData(JSON.stringify({ type: "runtime.command", protocolVersion: PROTOCOL_VERSION, runtimeId: "pi-menu", commandId: "exact-call",
      command: { type: "slash.execute", name: command.name, args: "native:exact-id" } }));
    let dispatched: Record<string, unknown>;
    do { dispatched = await runtime.next(); } while (dispatched.type === "runtime.resync");
    expect(dispatched).toMatchObject({ type: "runtime.command", commandId: "exact-call", command: { type: "slash.execute", name: command.name, args: "native:exact-id" } });

    await device.openChannel("relay", paired.pskRoot, paired.payload.hostId, paired.payload.hostId);
    const ready = await readMatching(device, message => message.type === "device.ready");
    checkMetadata((ready.runtimes as unknown[])[0]);
    device.sendData(JSON.stringify({ type: "agent.state.request", protocolVersion: PROTOCOL_VERSION, requestId: "menu-compact-reconnect",
      scope: "agent", runtimeId: "pi-menu", stateFormat: "compact-v2", domains: ["capabilities"], subscribe: true }));
    const compactReplay = await readMatching(device, message => message.requestId === "menu-compact-reconnect");
    expect(compactReplay).toMatchObject({ type: "agent.state.snapshot", stateFormat: "compact-v2",
      domains: [{ domain: "capabilities", value: { [command.name]: expect.objectContaining({ optionCount: 1 }) } }] });

    // FT-G10: the scoped compact menu satisfies bootstrap. The delayed legacy
    // compatibility replay must not enqueue the same 634 KB-class catalog.
    const deadline = Date.now() + 1_200;
    const legacyMenuEvents: Record<string, unknown>[] = [];
    while (Date.now() < deadline) {
      try {
        const incoming = await device.nextIncoming(deadline - Date.now());
        if (!("payload" in incoming)) continue;
        const message = JSON.parse(incoming.payload.toString("utf8")) as Record<string, unknown>;
        const event = message.event as RuntimeEvent | undefined;
        if (message.type === "runtime.event" && message.runtimeId === "pi-menu" && event?.type === "runtime.capabilities")
          legacyMenuEvents.push(message);
      } catch (error) {
        if (error instanceof Error && error.message.includes("超时")) break;
        throw error;
      }
    }
    expect(legacyMenuEvents).toEqual([]);
  });

  it("FT-G10 legacy client gets menu and directory after same-relay reconnect", async () => {
    stateDir = await mkdtemp(join(tmpdir(), "orbis-host-"));
    relay = await startRelay(stateDir);

    host = await HostService.create({
      relayUrl: relay.url, ...relayBusinessHostOptions(relay.url),
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
    // FT-G10 legacy fallback: without compact model reads, the delayed replay still
    // restores the slash menu for older clients. Host also asks Pi to replay pending
    // interaction details, which remain authoritative in the runtime.
    await expect(runtime.next()).resolves.toEqual({
      type: "runtime.resync",
      runtimeId: "pi-restart",
      reason: "device_reconnected",
    });
  });

  it("cancels legacy bootstrap replay on state.compact-bootstrap.v1 and gates steerSupported on claude.send-now.v1", async () => {
    stateDir = await mkdtemp(join(tmpdir(), "orbis-host-"));
    relay = await startRelay(stateDir);
    host = await HostService.create({
      relayUrl: relay.url, ...relayBusinessHostOptions(relay.url),
      credential: "runtime-secret", adminToken: "owner-secret", stateDir,
      reconnect: false, lan: false, bootstrapReplayDelayMs: 60,
    });
    await host.start();

    const paired = await pairDevice({ relay, host });
    device = paired.device;
    const descriptor = host.loopback?.descriptor;
    if (descriptor === undefined) throw new Error("loopback 端点没有启动");
    runtime = await TestRuntime.connect({
      url: descriptor.url, token: descriptor.token,
      metadata: { runtimeId: "pi-compact", name: "pi", cwd: "/work/repo", status: "idle", hostname: "devbox" },
    });
    await expect(runtime.next()).resolves.toMatchObject({ type: "runtime.ready" });
    runtime.publish(1, {
      type: "runtime.capabilities",
      capabilities: { commands: [{ name: "model", description: "切换模型", source: "builtin" }] },
    });
    const claudeHelloResponse = await fetch(descriptor.url.replace(/^ws/u, "http") + "/v1/claude/mods/hello", {
      method: "POST",
      headers: { authorization: `Bearer ${descriptor.token}`, "content-type": "application/json" },
      body: JSON.stringify({
        type: "hello", instanceId: "claude-inst", sessionId: "claude-send-now", cwd: "/work/repo",
        claudeVersion: "2.1.312", bridgeVersion: "4", interactive: true,
        capabilities: [
          "prompt.submit", "prompt.sendNow", "turn.abort", "session.append",
          "turn.start", "turn.complete", "turn.step.delta", "tool.call", "turn.step.identity", "agent.list",
        ],
      }),
    });
    expect(await claudeHelloResponse.json()).toMatchObject({ ok: true });

    await device.openChannel("relay", paired.pskRoot, paired.payload.hostId, paired.payload.hostId);
    const initialReady = await readMatching(device, message => message.type === "device.ready");
    expect(initialReady.hostFeatures).toEqual(expect.arrayContaining([
      DEVICE_FEATURE_COMPACT_BOOTSTRAP,
      DEVICE_FEATURE_CLAUDE_SEND_NOW,
    ]));
    expect((initialReady.runtimes as Array<Record<string, unknown>>).find(r => r.runtimeId === "claude:claude-send-now"))
      .not.toHaveProperty("steerSupported");

    device.sendData(JSON.stringify({
      type: "device.features", protocolVersion: PROTOCOL_VERSION,
      features: [DEVICE_FEATURE_COMPACT_BOOTSTRAP, DEVICE_FEATURE_CLAUDE_SEND_NOW],
    }));
    const upgradedReady = await readMatching(device, message => message.type === "device.ready");
    expect((upgradedReady.runtimes as Array<Record<string, unknown>>).find(r => r.runtimeId === "claude:claude-send-now"))
      .toMatchObject({ steerSupported: true });

    const deadline = Date.now() + 200;
    const legacyMenuEvents: Record<string, unknown>[] = [];
    while (Date.now() < deadline) {
      try {
        const incoming = await device.nextIncoming(deadline - Date.now());
        if (!("payload" in incoming)) continue;
        const message = JSON.parse(incoming.payload.toString("utf8")) as Record<string, unknown>;
        const event = message.event as RuntimeEvent | undefined;
        if (message.type === "runtime.event" && event?.type === "runtime.capabilities") legacyMenuEvents.push(message);
      } catch (error) {
        if (error instanceof Error && error.message.includes("超时")) break;
        throw error;
      }
    }
    expect(legacyMenuEvents).toEqual([]);
  });

  it("同局域网的设备先握 LAN 就直接走 LAN，拔掉 LAN 立刻回落 Relay", async () => {
    stateDir = await mkdtemp(join(tmpdir(), "orbis-host-"));
    relay = await startRelay(stateDir);

    const receivedByHost: string[] = [];
    const pathChanges: string[] = [];
    host = await HostService.create({
      relayUrl: relay.url, ...relayBusinessHostOptions(relay.url),
      credential: "runtime-secret",
      adminToken: "owner-secret",
      stateDir,
      reconnect: false,
      // 端口交给系统分配：CI 上 42130 可能已被别的进程占着。
      lanPort: 0,
      // 此用例按次序核对握手与换路帧；周期 RTT 公告由独立用例覆盖。
      probeIntervalMs: 0,
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

    // Obsolete controls reach only the generic unknown-payload callback, never the selector.
    const obsoleteControls = [
      { type: "device.pathPreference", preference: ["relay", "lan"] },
      { type: "device.pathPreference", preference: ["unsupported", "relay", "lan"] },
      { type: "transport.unsupported.request" }, { type: "transport.unsupported.answer", sdp: "obsolete" },
    ].map(message => JSON.stringify({ ...message, protocolVersion: PROTOCOL_VERSION }));
    for (const payload of obsoleteControls) device.sendData(payload);
    await vi.waitFor(() => expect(receivedByHost).toEqual(obsoleteControls));
    expect(host.activePathOf(device.deviceId)).toBe("lan");
    receivedByHost.length = 0;

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

    // LAN recovery restores the fixed priority without a preference message or re-pairing.
    await device.openLanPath(`ws://127.0.0.1:${lanPort}/v1/lan`);
    await device.openChannel("lan", paired.pskRoot, paired.payload.hostId, paired.payload.hostId);
    await expect(device.expectOn("lan")).resolves.toMatchObject({ type: "device.ready" });
    await expect(device.expectOn("lan")).resolves.toMatchObject({ type: "device.path", path: "lan" });
    expect(host.activePathOf(device.deviceId)).toBe("lan");
  });

  it("拒绝未配对设备的 LAN 连接", async () => {
    stateDir = await mkdtemp(join(tmpdir(), "orbis-host-"));
    relay = await startRelay(stateDir);

    host = await HostService.create({
      relayUrl: relay.url, ...relayBusinessHostOptions(relay.url),
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
    stateDir = await mkdtemp(join(tmpdir(), "orbis-host-"));
    relay = await startRelay(stateDir);
    const lanPort = await freeTcpPort();
    host = await HostService.create({
      relayUrl: relay.url, ...relayBusinessHostOptions(relay.url),
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
      relayUrl: relay.url, ...relayBusinessHostOptions(relay.url),
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
    const uploadDir = (dir: string): string => join(dir, ".orbis-uploads");

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
      state: { served: number; wrongOffset?: boolean; tamper?: boolean; lane?: "ctl" | "bulk" },
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
        }), state.lane);
      }
    };

    it.each(["device", "host"] as const)("keeps an upload durable prefix and downloads only missing ranges across Relay handovers (%s)", async side => {
      stateDir = await mkdtemp(join(tmpdir(), "orbis-handover-files-")); relay = await startRelay(stateDir);
      host = await HostService.create({ relayUrl: relay.url, ...relayBusinessHostOptions(relay.url), credential: "runtime-secret", adminToken: "owner-secret", stateDir, reconnect: false, lan: false });
      await host.start(); const paired = await pairDevice({ relay, host }); device = paired.device;
      await device.openChannel("relay", paired.pskRoot, paired.payload.hostId, paired.payload.hostId);
      await readMatching(device, message => message.type === "device.path");
      const bytes = randomBytes(1024 * 1024 + 4096); const expectedHash = createHash("sha256").update(bytes).digest("hex");
      initUpload(device, uploadDir(stateDir), "handover.bin", bytes);
      const ready = await readMatching(device, message => message.type === "file.upload.ready");
      const uploadId = ready.uploadId as string;
      const first = await readMatching(device, message => message.type === "file.upload.read");
      expect(first.offset).toBe(0);
      device.sendBinary(encodeArtifactChunkFrame({ runtimeId: "runtime-a", transferId: uploadId, offset: 0,
        data: bytes.subarray(0, first.length as number) }), "bulk");
      const pending = await readMatching(device, message => message.type === "file.upload.read");
      expect(pending.offset).toBe(first.length); // A second read proves the first prefix was durably written.
      await handover(side, handoverModes(side)[0]!, paired.pskRoot, paired.payload.hostId);
      await readMatching(device, message => message.type === "device.path");
      device.sendBinary(encodeArtifactChunkFrame({ runtimeId: "runtime-a", transferId: uploadId, offset: pending.offset as number,
        data: bytes.subarray(pending.offset as number, (pending.offset as number) + (pending.length as number)) }), "bulk");
      const finished = await nextOutcome(device, bytes, uploadId, { served: 0, lane: "bulk" });
      expect(finished).toMatchObject({ type: "file.upload.finished", uploadId, fileName: "handover.bin" });
      expect(createHash("sha256").update(await readFile(finished.path as string)).digest("hex")).toBe(expectedHash);

      device.sendCommand(paired.payload.hostId, "handover-download", { type: "file.download", path: finished.path });
      const started = await readMatching(device, message => (message.event as Record<string, unknown>)?.type === "artifact.started");
      const transferId = (started.event as Record<string, unknown>).transferId as string;
      const downloaded = Buffer.alloc(bytes.length);
      const readRange = async (offset: number): Promise<void> => {
        const length = Math.min(16 * 1024, bytes.length - offset);
        device!.sendData(JSON.stringify({ type: "artifact.read", protocolVersion: PROTOCOL_VERSION, transferId,
          requestId: `range-${offset}`, offset, length }));
        const chunk = decodeArtifactChunkFrame(await device!.receivePayload());
        expect(chunk).toMatchObject({ transferId, offset }); expect(chunk.data.byteLength).toBe(length);
        downloaded.set(chunk.data, offset);
      };
      await readRange(0);
      await handover(side, handoverModes(side)[1]!, paired.pskRoot, paired.payload.hostId);
      await readMatching(device, message => message.type === "device.path");
      // Keep the saved prefix and request only the remaining holes using the same transfer identity.
      for (let offset = 16 * 1024; offset < bytes.length; offset += 16 * 1024) await readRange(offset);
      expect(createHash("sha256").update(downloaded).digest("hex")).toBe(expectedHash);
      device.sendData(JSON.stringify({ type: "artifact.done", protocolVersion: PROTOCOL_VERSION, transferId }));
      device.sendData(JSON.stringify({ type: "artifact.read", protocolVersion: PROTOCOL_VERSION, transferId,
        requestId: "after-done", offset: 0, length: 1 }));
      expect(await readMatching(device, message => message.type === "artifact.read.failed"))
        .toMatchObject({ transferId, requestId: "after-done", reason: "unknown_transfer" });
    }, 30_000);

    it("read 拉取 → 应答 → 收齐自动校验落地；确认收到的字节是原始内容", async () => {
      stateDir = await mkdtemp(join(tmpdir(), "orbis-host-"));
      relay = await startRelay(stateDir);
      host = await HostService.create({
        relayUrl: relay.url, ...relayBusinessHostOptions(relay.url), credential: "runtime-secret", adminToken: "owner-secret",
        stateDir, reconnect: false, lan: false,
      });
      await host.start();
      const paired = await pairDevice({ relay, host });
      device = paired.device;
      await device.openChannel("relay", paired.pskRoot, paired.payload.hostId, paired.payload.hostId);
      await device.receiveMessage(); // device.ready
      await device.receiveMessage(); // device.path

      // 目录故意不存在：Host 必须自己建出 `.orbis-uploads`。
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
      stateDir = await mkdtemp(join(tmpdir(), "orbis-host-"));
      relay = await startRelay(stateDir);
      host = await HostService.create({
        relayUrl: relay.url, ...relayBusinessHostOptions(relay.url), credential: "runtime-secret", adminToken: "owner-secret",
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
      stateDir = await mkdtemp(join(tmpdir(), "orbis-host-"));
      relay = await startRelay(stateDir);
      host = await HostService.create({
        relayUrl: relay.url, ...relayBusinessHostOptions(relay.url), credential: "runtime-secret", adminToken: "owner-secret",
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
    const transportCleanup = await stopRelayBusinessTransports().then(() => undefined, error => error);
    await host?.stop();
    await relay?.close();
    if (stateDir !== undefined) await rm(stateDir, { recursive: true, force: true });
    for (const dir of extraDirs.splice(0)) await rm(dir, { recursive: true, force: true });
    relay = undefined;
    host = undefined;
    device = undefined;
    stateDir = undefined;
    if (transportCleanup) throw transportCleanup;
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

  it("gates OpenCode by device feature and keeps deduplicated command receipts private", async () => {
    stateDir = await mkdtemp(join(tmpdir(), "orbis-host-opencode-feature-"));
    relay = await startRelayLocal(stateDir);
    const info = { id: "oc-session", title: "OpenCode fixture", location: { directory: stateDir }, time: { created: 1000, updated: 2000 } };
    const selected = { providerID: "fixture-provider", id: "fixture-model" };
    const newId = "oc-configured";
    let nativeSelection: typeof selected | undefined;
    const get = vi.fn(async ({ sessionID }: { sessionID: string }) => sessionID === newId ? { ...info, id: newId, model: nativeSelection } : info);
    const create = vi.fn(async () => ({ ...info, id: newId }));
    const switchModel = vi.fn(async ({ model }: { model: typeof selected }) => { nativeSelection = model; });
    const prompt = vi.fn(async ({ sessionID, text, metadata }: { sessionID: string; text: string; metadata?: unknown }) =>
      ({ id: "oc-inbox", sessionID, type: "user", delivery: "queue", time: { created: 3000 }, payload: { text, metadata } }));
    const client = {
      server: { info: async () => ({ version: "2.3.2", pid: 1 }) },
      event: { async *subscribe({ signal }: { signal: AbortSignal }) {
        yield { type: "server.connected", data: {} };
        if (!signal.aborted) await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
      } },
      session: { get, create, switchModel, active: async () => ({}), list: async () => ({ data: [info], cursor: {} }), prompt,
        form: { list: async () => [] }, inbox: { list: async () => [] } },
      message: { list: async () => ({ data: [], cursor: {} }) }, permission: { list: async () => [] },
      model: { list: async () => ({ data: [{ ...selected, enabled: true, name: "Fixture model", variants: [] }] }),
        default: async () => ({ data: selected }) }, agent: { list: async () => ({ data: [] }) },
    };
    const discover = vi.fn(async () => ({ url: "http://127.0.0.1:4096" }));
    const createOpenCodeConnection = vi.fn(() => new OpenCodeServiceConnection({ discover,
      createClient: () => client as unknown as OpenCodeClient }));
    const policy = new AgentEnablementController(new AgentEnablementStore(stateDir), () => {});
    host = await HostService.create({ relayUrl: relay.url, ...relayBusinessHostOptions(relay.url), credential: "runtime-secret",
      adminToken: "owner-secret", stateDir, sessionsRoot: join(stateDir, "sessions"), reconnect: false, lan: false, agentEnablement: policy, createOpenCodeConnection });
    await host.start();
    expect(createOpenCodeConnection).not.toHaveBeenCalled();
    expect(discover).not.toHaveBeenCalled();
    await policy.set({ kind: "pi", enabled: true, expectedRevision: 0 });
    await policy.set({ kind: "opencode", enabled: true, expectedRevision: 1 });
    await vi.waitFor(() => expect(host!.opencodeServiceStatus.state).toBe("ready"));
    device = await readyDevice({ host, relay });
    const owner = device;
    const other = await readyDevice({ host, relay });
    try {
      const until = async (phone: TestDevice, predicate: (message: Record<string, unknown>) => boolean) => {
        for (let i = 0; i < 100; i++) {
          const message = await phone.receiveMessage(true);
          if (predicate(message)) return message;
        }
        throw new Error("OpenCode E2E response missing");
      };
      const request = (phone: TestDevice, payload: Record<string, unknown>) => sendRequest(phone, { protocolVersion: PROTOCOL_VERSION, ...payload });
      const reply = (phone: TestDevice, requestId: string) => until(phone, message => message.requestId === requestId);
      const runtimeId = "opencode:oc-session";
      const kind = { agentKind: "opencode", cwd: stateDir };
      const launches = new SessionConfigurationStore(join(stateDir, "opencode-session-configuration.json"));
      await launches.begin(owner.deviceId, { type: "session.launch", requestId: "seed", launchId: "known-opencode-launch",
        agentKind: "opencode", cwd: stateDir, binding: "fixture", revision: 0, values: {} });
      await launches.update(owner.deviceId, "known-opencode-launch", { phase: "ready", sessionId: info.id, spawnMode: "headless" });

      for (const [requestId, payload] of [
        ["config-hidden", { type: "session.configuration.read", ...kind }],
        ["launch-hidden", { type: "session.launch", ...kind, binding: "fixture", revision: 0, values: {}, launchId: "hidden-launch" }],
        ["archive-hidden", { type: "session.archive", agentKind: "opencode", sessionId: info.id, archived: true }],
        ["resume-hidden", { type: "session.activate", target: { type: "resume", sessionId: info.id, agentKind: "opencode" } }],
      ] as const) {
        request(owner, { requestId, ...payload });
        await expect(reply(owner, requestId)).resolves.toMatchObject({ type: "protocol.error", code: "agent_feature_required" });
      }
      request(owner, { type: "session.launch.read", requestId: "launch-read-hidden", launchId: "known-opencode-launch" });
      await expect(reply(owner, "launch-read-hidden")).resolves.toMatchObject({ type: "session.launch.result", phase: "absent" });
      request(owner, { type: "session.activate", requestId: "resume-legacy", target: { type: "resume", sessionId: info.id } });
      await expect(reply(owner, "resume-legacy")).resolves.toMatchObject({ type: "protocol.error", code: "session_not_found" });
      const input = { type: "runtime.command", runtimeId, commandId: "oc-input",
        command: { type: "user_message", text: "Fixture prompt", messageId: "app-id" } };
      request(owner, input);
      await expect(until(owner, message => message.commandId === input.commandId)).resolves.toMatchObject({ type: "protocol.error", code: "agent_feature_required" });
      expect(get).not.toHaveBeenCalled();
      expect(prompt).not.toHaveBeenCalled();

      request(owner, { type: "device.features", features: ["agent.opencode"] });
      await until(owner, message => message.type === "device.ready");
      request(owner, { type: "session.configuration.read", requestId: "config-visible", ...kind });
      const config = await reply(owner, "config-visible");
      expect(config).toMatchObject({ type: "session.configuration.result", agentKind: "opencode" });
      request(owner, { type: "session.launch", requestId: "launch-visible", launchId: "stable-opencode-launch", ...kind,
        binding: config.binding, revision: config.revision, values: config.values });
      const unknown = await until(owner, message => message.requestId === "launch-visible" && message.phase === "unknown");
      expect(unknown).toMatchObject({ sessionId: newId, agentKind: "opencode" });
      request(owner, { type: "session.launch.read", requestId: "restore-config", launchId: "stable-opencode-launch" });
      await expect(reply(owner, "restore-config")).resolves.toMatchObject({ phase: "ready", sessionId: newId, agentKind: "opencode" });
      expect(create).toHaveBeenCalledTimes(1);
      expect(switchModel).toHaveBeenCalledExactlyOnceWith({ sessionID: newId, model: selected }, expect.anything());
      request(owner, { type: "session.launch.read", requestId: "lookup-visible", launchId: "known-opencode-launch" });
      await expect(reply(owner, "lookup-visible")).resolves.toMatchObject({ phase: "ready", sessionId: info.id, agentKind: "opencode" });
      const receipt = (phone: TestDevice) => until(phone, message =>
        message.type === "runtime.event" && (message.event as { commandId?: string })?.commandId === input.commandId);
      request(owner, input);
      await expect(receipt(owner)).resolves.toMatchObject({ runtimeId, event: { type: "command.result", ok: true, status: "success" } });
      request(owner, input);
      await expect(receipt(owner)).resolves.toMatchObject({ runtimeId, event: { type: "command.result", ok: true, status: "success" } });
      expect(prompt).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ metadata: { "orbis.clientMessageId": "app-id" } }), expect.anything());

      // For the other device, the E2E payloads sent before opting in contain neither the runtime nor the private receipt.
      request(other, { type: "session.list", requestId: "legacy-list" });
      const legacy = await until(other, message => {
        expect(JSON.stringify(message)).not.toMatch(/oc-session|oc-input|opencode/);
        return message.requestId === "legacy-list";
      });
      expect(legacy.sessions).toEqual([]);
      request(other, { type: "device.features", features: ["agent.opencode"] });
      await until(other, message => message.type === "device.ready");
      request(other, input);
      const conflict = await until(other, message => {
        expect((message.event as { commandId?: string } | undefined)?.commandId).not.toBe(input.commandId);
        return message.commandId === input.commandId;
      });
      expect(conflict).toMatchObject({ type: "protocol.error", code: "command_id_conflict" });
      expect(prompt).toHaveBeenCalledTimes(1);
      await policy.set({ kind: "opencode", enabled: false, expectedRevision: 2, confirmDisable: true });
      await vi.waitFor(() => expect(host!.opencodeServiceStatus.state).toBe("closed"));
      request(owner, { type: "session.configuration.read", requestId: "config-disabled", ...kind });
      await expect(reply(owner, "config-disabled")).resolves.toMatchObject({ type: "protocol.error", code: "agent_feature_required" });
      expect(host.readHostState(["backends"]).domains[0]?.value).toMatchObject({ agents: expect.arrayContaining(["pi"]) });
      await policy.set({ kind: "opencode", enabled: true, expectedRevision: 3 });
      await vi.waitFor(() => expect(host!.opencodeServiceStatus.state).toBe("ready"));
      expect(createOpenCodeConnection).toHaveBeenCalledTimes(2);
      expect(create).toHaveBeenCalledTimes(1);
    } finally { other.close(); }
  });

  it("session.browse 返回目录和可下载文件，并标出有会话历史的目录", async () => {
    stateDir = await mkdtemp(join(tmpdir(), "orbis-host-"));
    const sessionsRoot = await mkdtemp(join(tmpdir(), "orbis-sessions-"));
    extraDirs.push(sessionsRoot);
    const projectDir = join(sessionsRoot, "with-history");
    await mkdir(projectDir, { recursive: true });
    await mkdir(join(sessionsRoot, "empty"), { recursive: true });
    await writeFile(join(sessionsRoot, "report 中文.txt"), "download contents", "utf8");
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
      relayUrl: relay.url, ...relayBusinessHostOptions(relay.url),
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
        { name: "report 中文.txt", isDir: false, hasSessions: false },
      ]),
    });
    sendRequest(device, { type: "session.browse", protocolVersion: PROTOCOL_VERSION, requestId: "r2", path: projectDir });
    await expect(device.receiveMessage()).resolves.toMatchObject({
      type: "session.browse.result", requestId: "r2", path: projectDir, parent: sessionsRoot, entries: [],
    });
    sendRequest(device, { type: "session.browse", protocolVersion: PROTOCOL_VERSION, requestId: "r3", path: join(sessionsRoot, "missing") });
    await expect(device.receiveMessage()).resolves.toMatchObject({ type: "protocol.error", requestId: "r3" });
  });

  it("session.list 返回磁盘扫描出的历史会话", async () => {
    stateDir = await mkdtemp(join(tmpdir(), "orbis-host-"));
    const sessionsRoot = await mkdtemp(join(tmpdir(), "orbis-sessions-"));
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
      relayUrl: relay.url, ...relayBusinessHostOptions(relay.url),
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

    // ADR-0049 §7.6：归档请求按 requestId 写设备私有回执；失败带原因码。
    sendRequest(device, {
      type: "session.archive", protocolVersion: PROTOCOL_VERSION, requestId: "archive-unsupported",
      agentKind: "dsh", sessionId: "missing", archived: true,
    });
    expect(await device.receiveMessage()).toMatchObject({ type: "protocol.error", requestId: "archive-unsupported" });
    sendRequest(device, {
      type: "session.activate", protocolVersion: PROTOCOL_VERSION, requestId: "activate-missing",
      target: { type: "resume", sessionId: "99999999-2222-3333-4444-555555555555", agentKind: "pi" },
    });
    expect(await device.receiveMessage()).toMatchObject({ type: "protocol.error", requestId: "activate-missing" });
    sendRequest(device, { type: "agent.state.request", protocolVersion: PROTOCOL_VERSION, requestId: "receipts",
      scope: "device", domains: ["operations"] });
    const snapshot = await device.receiveMessage();
    expect(snapshot).toMatchObject({ type: "agent.state.snapshot", requestId: "receipts", scope: "device" });
    const operations = (snapshot.domains as { domain: string; value: Record<string, { state: string; detail?: string; requestId?: string }> }[])
      .find(domain => domain.domain === "operations")?.value;
    expect(operations?.["archive-true"]).toMatchObject({ state: "success", requestId: "archive-true" });
    expect(operations?.["archive-false"]).toMatchObject({ state: "success" });
    expect(operations?.["archive-unsupported"]).toMatchObject({ state: "failure", detail: "agent_unsupported" });
    expect(operations?.["activate-missing"]).toMatchObject({ state: "failure", detail: "session_not_found" });
  });

  it("session.list 短 TTL 内复用扫描结果（并发请求不各扫一遍）", async () => {
    stateDir = await mkdtemp(join(tmpdir(), "orbis-host-"));
    relay = await startRelayLocal(stateDir);

    // 用可数的 spawner 站不住脚：这里要数的是 **catalog 被调用几次**，所以换 Pi 后端的
    // sessionsRoot 指向一个真实目录，再用文件变化证明「第二次请求没重扫」。
    const sessionsRoot = await mkdtemp(join(tmpdir(), "orbis-sessions-"));
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
      relayUrl: relay.url, ...relayBusinessHostOptions(relay.url),
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
    stateDir = await mkdtemp(join(tmpdir(), "orbis-host-"));
    relay = await startRelayLocal(stateDir);

    const sessionsRoot = await mkdtemp(join(tmpdir(), "orbis-sessions-"));
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
      relayUrl: relay.url, ...relayBusinessHostOptions(relay.url),
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
    stateDir = await mkdtemp(join(tmpdir(), "orbis-host-"));
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
      relayUrl: relay.url, ...relayBusinessHostOptions(relay.url),
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
      relayUrl: relay.url, ...relayBusinessHostOptions(relay.url),
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
    const transportCleanup = await stopRelayBusinessTransports().then(() => undefined, error => error);
    await host?.stop();
    await relay?.close();
    if (stateDir !== undefined) await rm(stateDir, { recursive: true, force: true });
    relay = undefined;
    host = undefined;
    device = undefined;
    stateDir = undefined;
    if (transportCleanup) throw transportCleanup;
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

  // CODEX-UNIFIED-01/02/03: the encrypted device view, not just the adapter's
  // raw list, must expose unopened history and select exactly one native route.
  it("negotiates desktop-only Codex history, binds resume and archive to the same thread, and rolls back the view", async () => {
    stateDir = await mkdtemp(join(tmpdir(), "orbis-codex-unified-"));
    relay = await startRelayLocal(stateDir);
    const historyHome = join(stateDir, "codex");
    const id = "before-pairing";
    const thread = { id, cwd: stateDir, name: "Before pairing", createdAt: 1_780_000_000, updatedAt: 1_780_000_001,
      modelProvider: "fixture", status: { type: "notLoaded" } };
    let archived = false, loaded = false;
    const rpc = vi.fn(async (method: string, params?: { threadId?: string; archived?: boolean }) => {
      const saved = { ...thread, path: join(historyHome, archived ? "archived_sessions" : "sessions", "rollout-fixture.jsonl") };
      if (method === "thread/list") return { data: (params?.archived === true) === archived ? [saved] : [], nextCursor: null };
      if (method === "thread/loaded/list") return { data: loaded ? [id] : [] };
      if (method === "thread/read") return { thread: saved };
      if (method === "thread/resume") { loaded = true; return { thread: { ...saved, turns: [], status: { type: "idle" } } }; }
      if (method === "thread/archive" || method === "thread/unarchive") { archived = method === "thread/archive"; loaded = false; return {}; }
      if (method === "config/read") return { config: { model_provider: "fixture" } };
      return { data: [] };
    });
    const desktop = new CodexRuntime({ server: { mode: "desktop", historyHome, request: rpc, notify: vi.fn(), stop: vi.fn(async () => {}) } as unknown as CodexAppServer,
      onEvent: () => {} });
    const ensureCodexRuntime = vi.fn();
    host = await HostService.create({ relayUrl: relay.url, ...relayBusinessHostOptions(relay.url), credential: "runtime-secret",
      adminToken: "owner-secret", stateDir, sessionsRoot: join(stateDir, "pi"), reconnect: false, lan: false, codexDesktopRuntime: desktop, ensureCodexRuntime });
    await host.start();
    const connected = await readyDeviceCapturing({ host, relay }); device = connected.device;
    const send = (message: Record<string, unknown>) => sendRequest(device!, { ...message, protocolVersion: PROTOCOL_VERSION });
    const next = async (matches: (row: Record<string, unknown>) => boolean) => {
      for (let i = 0; i < 55; i++) { const row = await device!.receiveMessage() as Record<string, unknown>; if (matches(row)) return row; }
      throw new Error("Expected correlated Codex response");
    };
    const reply = (requestId: string) => next(row => row.requestId === requestId);
    const idOnWire = codexHistoryId(host.hostId, `local:${historyHome}`, id);
    const query = (requestId: string, archived: boolean) => send({ type: "session.catalog.query", requestId, format: "v1", limit: 1, cursor: null,
      query: { text: "before", agentKind: "codex", provider: "provider:fixture", archived } });
    expect(connected.ready.hostFeatures).toContain(CODEX_UNIFIED_HISTORY);
    expect(connected.ready.deviceFeatures ?? []).not.toContain(CODEX_UNIFIED_HISTORY);
    send({ type: "session.list", requestId: "legacy" });
    expect(await reply("legacy")).toMatchObject({ sessions: [] });
    send({ type: "device.features", features: [CODEX_UNIFIED_HISTORY] });
    expect(await next(row => row.type === "device.ready")).toMatchObject({ deviceFeatures: [CODEX_UNIFIED_HISTORY], runtimes: [] });
    send({ type: "session.catalog.capabilities.request", requestId: "capabilities" }); await reply("capabilities");
    send({ type: "agent.state.range.request", requestId: "range", scope: "host", domain: "catalog", limit: 1 });
    expect(await reply("range")).toMatchObject({ page: { sessions: [{ sessionId: idOnWire, agentKind: "codex", codexLaunchModes: ["desktop"] }] } });
    query("query", false);
    expect(await reply("query")).toMatchObject({ page: { totalSessions: 1, sessions: [{ sessionId: idOnWire }] } });
    expect(rpc.mock.calls.some(([method]) => method === "thread/resume" || method === "thread/start")).toBe(false);
    expect(ensureCodexRuntime).not.toHaveBeenCalled();
    expect(existsSync(join(stateDir, "codex-desktop-threads.json"))).toBe(false);
    send({ type: "session.archive", requestId: "archive", agentKind: "codex", sessionId: idOnWire, archived: true });
    expect(await reply("archive")).toMatchObject({ type: "session.archive.changed", sessionId: idOnWire, archived: true });
    query("archived", true);
    expect(await reply("archived")).toMatchObject({ page: { sessions: [{ sessionId: idOnWire, archived: true }] } });
    send({ type: "session.archive", requestId: "unarchive", agentKind: "codex", sessionId: idOnWire, archived: false });
    await reply("unarchive");
    const resume = (requestId: string, codexLaunchMode?: string) => send({ type: "session.activate", requestId,
      target: { type: "resume", agentKind: "codex", sessionId: idOnWire }, spawnMode: "headless", codexLaunchMode });
    resume("wrong-mode", "terminal");
    expect(await reply("wrong-mode")).toMatchObject({ type: "protocol.error", code: "agent_unsupported" });
    expect(ensureCodexRuntime).not.toHaveBeenCalled();
    send({ type: "session.activate", requestId: "new-wrong-mode", spawnMode: "headless", codexLaunchMode: "terminal",
      target: { type: "new", agentKind: "codexDesktop", cwd: stateDir } });
    expect(await reply("new-wrong-mode")).toMatchObject({ type: "protocol.error", code: "agent_feature_required" });
    expect(rpc.mock.calls.some(([method]) => method === "thread/start")).toBe(false);
    resume("resume", "desktop");
    expect(await next(row => row.type === "runtime.online")).toMatchObject({ runtime: { sessionId: `codex-desktop:${id}`, codexCatalogId: idOnWire } });
    expect(await reply("resume")).toMatchObject({ type: "session.activated", sessionId: `codex-desktop:${id}`, codexCatalogId: idOnWire });
    resume("resume-again");
    expect(await reply("resume-again")).toMatchObject({ type: "session.activated", codexCatalogId: idOnWire });
    expect(rpc.mock.calls.filter(([method]) => method === "thread/resume").map(([, params]) => params)).toEqual([{ threadId: id }]);
    send({ type: "device.features", features: [] });
    const downgrade = await next(row => row.type === "device.ready");
    expect(JSON.stringify(downgrade)).not.toContain("codexCatalogId");
    send({ type: "session.list", requestId: "downgrade" });
    expect(await reply("downgrade")).toMatchObject({ sessions: [{ agentKind: "codexDesktop", sessionId: `codex-desktop:${id}` }] });
  });

  // CODEX-SOURCE-04: the real Host/Relay must replace a capped Desktop checkpoint
  // and its tool inventory together, including a history request racing native reconciliation.
  it("recovers latest messages, history and live updates after the Desktop epoch budget is full", async () => {
    stateDir = await mkdtemp(join(tmpdir(), "orbis-codex-epoch-cap-"));
    relay = await startRelayLocal(stateDir);
    const thread = { id: "capped", cwd: stateDir, status: { type: "idle" }, turns: [] };
    const sessionId = `codex-desktop:${thread.id}`;
    const route = { threadId: thread.id, turnId: "active" };
    const turns = (version: number) => [
      { id: "older", status: "completed", items: [{ type: "agentMessage", id: "ancestor", text: "older message" },
        { type: "agentMessage", id: "tail", text: `verified version ${version}` }] },
      { id: route.turnId, status: "inProgress", startedAt: 1, items: [{ id: "cmd", type: "commandExecution", status: "inProgress", command: "fixture" }] },
    ];
    let version = 0;
    let pendingRead: ((reply: unknown) => void) | undefined;
    const request = vi.fn(async (method: string) => {
      if (method === "thread/resume") return { thread };
      if (method === "thread/loaded/list") return { data: [thread.id] };
      if (method === "thread/turns/list") return version === 65
        ? new Promise(resolve => { pendingRead = resolve; }) : { data: turns(version) };
      return { data: [] };
    });
    const server = { mode: "desktop", request, notify: vi.fn(), stop: vi.fn(async () => {}) } as unknown as CodexAppServer;
    const codex = new CodexRuntime({ server, rolloutRoot: join(stateDir, "rollouts"), onEvent: () => {} });
    host = await HostService.create({ relayUrl: relay.url, ...relayBusinessHostOptions(relay.url), credential: "runtime-secret", adminToken: "owner-secret",
      stateDir, sessionsRoot: join(stateDir, "pi-sessions"), reconnect: false, lan: false, codexDesktopRuntime: codex });
    try {
      await host.start();
      codex.seedDesktopThreads([thread.id]);
      await codex.activate({ type: "resume", sessionId });
      const runtimeId = codex.runtimeIdFor(thread.id);
      device = await readyDeviceLocal({ host, relay });
      const receive = async <Event extends RuntimeEvent>(label: string, matches: (event: RuntimeEvent) => event is Event): Promise<Event> => {
        const deadline = Date.now() + 2_000;
        for (let index = 0; index < 80; index++) {
          const incoming = await device!.nextIncoming(Math.max(1, deadline - Date.now()))
            .catch(cause => { throw new Error(`No Desktop session event: ${label}`, { cause }); });
          if (!("payload" in incoming)) throw new Error("Expected a secured Desktop session event");
          const message = JSON.parse(incoming.payload.toString()) as { type: string; runtimeId?: string; event?: RuntimeEvent };
          if (message.type === "protocol.error") throw new Error(JSON.stringify(message));
          if (message.runtimeId === runtimeId && message.event && matches(message.event)) return message.event;
        }
        throw new Error(`No Desktop session event: ${label}`);
      };
      type Snapshot = Extract<RuntimeEvent, { type: "session.snapshot" }>;
      type Patch = Extract<RuntimeEvent, { type: "session.patch" }>;
      const boundaryAfter = (priorEpoch: string) => receive("unverified source boundary", (event): event is Patch =>
        event.type === "session.patch" && !event.source.ready && event.source.epoch !== priorEpoch);
      const load = async (id: string, range: "preview" | "history") => {
        device!.sendCommand(runtimeId, id, { type: "session.sync", sessionId, syncId: id, range, maxEntries: 1,
          ...(range === "history" ? { beforeEntryId: "tail", targetLeafId: "tail" } : {}) });
        const reply = await receive(id, (event): event is Snapshot => event.type === "session.snapshot" && event.syncId === id);
        device!.sendCommand(runtimeId, `${id}-ack`, { type: "session.snapshot.ack", syncId: id, result: "applied" });
        return reply;
      };
      let previous = await load("preview-0", "preview");
      expect(previous).toMatchObject({ selection: "snapshot", live: { toolInventory: { totalCount: 1 } } });
      for (version = 1; version <= 64; version++) {
        const priorEpoch = previous.source!.epoch;
        server.onNotification?.("thread/reverted", { threadId: thread.id });
        await boundaryAfter(priorEpoch);
        previous = await load(`preview-${version}`, "preview");
        expect(previous).toMatchObject({ source: { ready: true }, hasOlder: true, entries: [{ entryId: "tail" }], live: { toolInventory: { totalCount: 1 } } });
        expect(previous.source!.epoch).not.toBe(priorEpoch);
      }

      // This time history is the first request. Its private replacement preview
      // must wait for the native read, then continue the original page request.
      const dispatch = vi.spyOn(codex, "dispatchCommand");
      server.onNotification?.("thread/reverted", { threadId: thread.id });
      const boundary = await boundaryAfter(previous.source!.epoch);
      expect(host.readDiagnostics({ category: "recovery", sessionId }).records).toEqual(expect.arrayContaining([
        expect.objectContaining({ detail: expect.objectContaining({ reason: "registry_source_epoch_limit:history" }) }),
      ]));
      const history = load("after-limit-history", "history");
      // Attach a rejection handler while the native fixture deliberately waits.
      void history.catch(() => undefined);
      await vi.waitFor(() => expect(dispatch).toHaveBeenCalledWith(runtimeId, expect.any(String), expect.objectContaining({ range: "preview" })));
      expect(pendingRead).toBeDefined();
      pendingRead!({ data: turns(version) });
      expect(await history).toMatchObject({ range: "history", source: { epoch: boundary.source.epoch, ready: true },
        entries: [{ entryId: "ancestor" }] });
      const latest = await load("after-limit-preview", "preview");
      expect(latest).toMatchObject({ source: { epoch: boundary.source.epoch, ready: true }, live: { toolInventory: { totalCount: 1 } },
        entries: [{ entryId: "tail", data: { message: { content: [{ text: "verified version 65" }] } } }] });

      server.onNotification?.("item/completed", { ...route, item: { type: "agentMessage", id: "progress", text: "new message" } });
      const live = await receive("live progress", (event): event is Patch => event.type === "session.patch" &&
        event.live.messages.some(item => item.message.messageId === "progress"));
      expect(live).toMatchObject({ source: { epoch: latest.source!.epoch, ready: true }, baseSeq: latest.source!.seq,
        head: { leafId: "tail" }, live: { messages: [{ message: { messageId: "progress", content: [{ text: "new message" }] } }] } });
      // The reply initially waits behind the running tool, then both become canonical.
      server.onNotification?.("item/completed", { ...route, item: { type: "commandExecution", id: "cmd", command: "fixture", status: "completed" } });
      const patch = await receive("committed progress", (event): event is Patch => event.type === "session.patch" && event.head.leafId === "progress");
      expect(patch).toMatchObject({ source: { epoch: latest.source!.epoch, ready: true }, baseSeq: live.seq,
        entries: [{ entryId: "cmd", parentId: "tail" }, { entryId: "cmd:result", parentId: "cmd" }, { entryId: "progress", parentId: "cmd:result" }] });
    } finally {
      pendingRead?.({ data: turns(version) });
      await codex.stop();
    }
  });

  // S51 / SC73: the durable snapshot precedes native create; lost receipts and
  // failed configuration recover the same native identity without a second start.
  it.each(["codex", "codexDesktop"] as const)("recovers configured %s launch by exact identity after a lost receipt and configuration refusal", async kind => {
    stateDir = await mkdtemp(join(tmpdir(), "orbis-configured-host-"));
    relay = await startRelayLocal(stateDir);
    let refuse = true; let created = false;
    const settings = { model: "model-a", reasoningEffort: "high", modelProvider: "fixture", approvalPolicy: "never",
      approvalsReviewer: "user", sandboxPolicy: { type: "readOnly", networkAccess: false } };
    const thread = { id: "configured-thread", cwd: stateDir, status: { type: "idle" }, turns: [] };
    const sessionId = kind === "codexDesktop" ? `codex-desktop:${thread.id}` : thread.id;
    const request = vi.fn(async (method: string) => {
      if (method === "model/list") return { data: [{ id: "model-a", model: "model-a", displayName: "Fixture A", isDefault: true,
        defaultReasoningEffort: "high", supportedReasoningEfforts: [{ reasoningEffort: "high", description: "High" }] }] };
      if (method === "config/read") return { config: { model: "model-a", model_reasoning_effort: "high", model_provider: "fixture" } };
      if (method === "thread/start") {
        const disk = JSON.parse(await readFile(join(stateDir!, "session-configuration.json"), "utf8"));
        expect(Object.values(disk.launches)).toMatchObject([{ phase: "preparing", values: { model: "model-a", thinking: "high" } }]);
        created = true; return { thread, ...settings, reasoningEffort: "low" };
      }
      if (method === "thread/settings/update") { if (refuse) throw new Error("synthetic managed refusal"); return {}; }
      if (method === "thread/resume" || method === "thread/read") return { thread, ...settings };
      if (method === "thread/loaded/list") return { data: created ? [thread.id] : [] };
      return { data: [] };
    });
    const runtime = new CodexRuntime({ server: { mode: kind === "codexDesktop" ? "desktop" : "owned", request, notify: vi.fn(), stop: vi.fn(async () => {}) } as unknown as CodexAppServer,
      onEvent: () => {}, rolloutRoot: join(stateDir, "rollouts") });
    host = await HostService.create({ relayUrl: relay.url, ...relayBusinessHostOptions(relay.url), credential: "runtime-secret", adminToken: "owner-secret",
      stateDir, sessionsRoot: join(stateDir, "pi-sessions"), reconnect: false, lan: false, ...(kind === "codexDesktop" ? { codexDesktopRuntime: runtime } : { codexRuntime: runtime }) });
    await host.start();
    const connected = await readyDeviceCapturing({ host, relay }); device = connected.device;
    expect(connected.ready.sessionConfiguration).toBe(1);
    const response = async (id: string, phase?: string): Promise<Record<string, unknown>> => {
      for (let index = 0; index < 80; index++) {
        const message = await device!.receiveMessage() as Record<string, unknown>;
        if (message.requestId === id && (phase === undefined || message.phase === phase)) return message;
      }
      throw new Error(`missing configured launch result ${id} ${phase}`);
    };
    sendRequest(device, { type: "session.configuration.read", protocolVersion: PROTOCOL_VERSION, requestId: "config", agentKind: kind, cwd: stateDir });
    const config = await response("config");
    const launch = { type: "session.launch", protocolVersion: PROTOCOL_VERSION, requestId: "launch", launchId: "stable-launch", agentKind: kind,
      cwd: stateDir, binding: config.binding, revision: config.revision, values: config.values, spawnMode: "tui" };
    sendRequest(device, launch);
    expect(await response("launch", "unknown")).toMatchObject({ sessionId, error: "synthetic managed refusal" });
    refuse = false;
    sendRequest(device, { type: "session.launch.read", protocolVersion: PROTOCOL_VERSION, requestId: "lost-receipt", launchId: "stable-launch" });
    expect(await response("lost-receipt", "ready")).toMatchObject({ sessionId, values: config.values });
    sendRequest(device, { ...launch, requestId: "duplicate" });
    expect(await response("duplicate", "ready")).toMatchObject({ sessionId });
    expect(request.mock.calls.filter(([method]) => method === "thread/start")).toHaveLength(1);
    expect(request.mock.calls.filter(([method]) => method === "thread/resume")).toHaveLength(1);
    sendRequest(device, { type: "session.launch.read", protocolVersion: PROTOCOL_VERSION, requestId: "absent", launchId: "never-sent" });
    expect(await response("absent")).toMatchObject({ type: "session.launch.result", phase: "absent", launchId: "never-sent" });
    sendRequest(device, { ...launch, requestId: "changed-identity", values: {} });
    expect(await response("changed-identity")).toMatchObject({ type: "protocol.error", code: "launch_id_conflict" });
    // A final catalog refusal remains final when a delayed duplicate arrives
    // with the now-current binding; it cannot create a second native session.
    sendRequest(device, { ...launch, launchId: "refused-launch", requestId: "refused", binding: "stale-binding" });
    expect(await response("refused", "failed")).toMatchObject({ error: expect.stringContaining("刷新启动配置") });
    sendRequest(device, { ...launch, launchId: "refused-launch", requestId: "refused-duplicate", binding: "stale-binding" });
    expect(await response("refused-duplicate", "failed")).toMatchObject({ launchId: "refused-launch" });
    sendRequest(device, { ...launch, launchId: "refused-launch", requestId: "refused-changed" });
    expect(await response("refused-changed")).toMatchObject({ type: "protocol.error", code: "launch_id_conflict" });
    expect(request.mock.calls.filter(([method]) => method === "thread/start")).toHaveLength(1);
  });

  it("lets DSH saves reach provider validation while busy, but still blocks switches", async () => {
    stateDir = await mkdtemp(join(tmpdir(), "orbis-dsh-save-gate-"));
    relay = await startRelayLocal(stateDir);
    host = await HostService.create({ relayUrl: relay.url, ...relayBusinessHostOptions(relay.url), credential: "runtime-secret", adminToken: "owner-secret", stateDir,
      sessionsRoot: join(stateDir, "pi-sessions"), reconnect: false, lan: false });
    const guard = vi.spyOn(host, "assertProviderSwitchReady").mockRejectedValue(new Error("browser session running"));
    const save = vi.fn(async () => "saved");
    await expect(host.changeProvider("dsh", save, "save")).resolves.toBe("saved");
    expect(guard).not.toHaveBeenCalled();
    const activate = vi.fn(async () => {});
    await expect(host.changeProvider("dsh", activate)).rejects.toThrow("browser session running");
    expect(activate).not.toHaveBeenCalled();
    await expect(host.changeProvider("codex", save, "save")).rejects.toThrow("browser session running");
    // A failed transaction must not block the next queued save.
    await expect(host.changeProvider("dsh", async () => { throw new Error("invalid config"); }, "save")).rejects.toThrow("invalid config");
    await expect(host.changeProvider("dsh", save, "save")).resolves.toBe("saved");
    guard.mockRestore();
  });

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
    host = await HostService.create({ relayUrl: relay.url, ...relayBusinessHostOptions(relay.url), credential: "runtime-secret", adminToken: "owner-secret", stateDir,
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
      expect(await until(message => (message.event as { commandId?: string } | undefined)?.commandId === "stop-dsh")).toMatchObject({
        event: { commandId: "stop-dsh", ok: false, status: "not_cancelable" },
      });
      expect(client.notify).not.toHaveBeenCalled();
    } finally { await runtime.stop(); }
  });

  // HOST-PREP-05 (ADR-0081 §5-3): DeepSeek session discovery used to run before relay.start(), so a slow
  // Web handshake kept phones away from the whole Host. Discovery now follows the Relay and never holds a pause.
  it("connects the Relay and pauses without waiting for a slow DeepSeek discovery", async () => {
    stateDir = await mkdtemp(join(tmpdir(), "orbis-dsh-after-relay-"));
    relay = await startRelayLocal(stateDir);
    const client: DshConnection = { onNotification: undefined, onRequest: undefined, onExit: undefined,
      request: vi.fn(async () => ({ sessions: [] })), notify: vi.fn(), stop: vi.fn(async () => {}) };
    const runtime = new DshRuntime(client, { list: async () => [],
      read: async id => ({ header: { id, cwd: stateDir!, createdAt: 1 }, events: [] }), close: async () => {} });
    let discovered!: () => void;
    const discovery = vi.spyOn(runtime, "start").mockImplementation(() => new Promise<void>(resolve => { discovered = resolve; }));
    host = await HostService.create({ relayUrl: relay.url, ...relayBusinessHostOptions(relay.url), credential: "runtime-secret", adminToken: "owner-secret", stateDir,
      sessionsRoot: join(stateDir, "pi-sessions"), reconnect: false, lan: false, dshRuntime: runtime });
    try {
      await host.start();
      expect(host.relayState).toBe("connected");
      await vi.waitFor(() => expect(discovery).toHaveBeenCalledTimes(1));
      const stopping = Date.now();
      await host.stop();
      expect(Date.now() - stopping).toBeLessThan(2_000);
      host = undefined;
    } finally { discovered?.(); await runtime.stop(); }
  });

  it.each(["prestarted", "recovered"])("announces %s browser DSH sessions and shares messages over E2E without APP activation", async mode => {
    stateDir = await mkdtemp(join(tmpdir(), "orbis-dsh-discovery-host-"));
    relay = await startRelayLocal(stateDir);
    const follows = new Map<string, (value: unknown) => void>();
    let workspace: ((value: unknown) => void) | undefined;
    const row = (sessionId: string, running = false) => ({ sessionId, cwd: stateDir, agentAvailable: true, running, updatedAt: 1000 });
    const request = vi.fn<(method: string, args?: unknown) => Promise<unknown>>(async method => method === "session/list" ? { items: [row("existing", true)] } : {});
    const client: DshWebConnection = {
      onEvent: undefined, onExit: undefined, onReconnect: undefined,
      request: request as DshWebConnection["request"], respondEvent: vi.fn(async () => {}), stop: vi.fn(async () => {}),
      subscribe(method, args, frame) {
        if (method === "session/control") return () => {};
        if (method === "workspace/follow") {
          workspace = frame;
          queueMicrotask(() => frame({ type: "baseline", value: { archivedSessionIds: [] } }));
          return () => {};
        }
        const id = (args.request as { address: { sessionId: string } }).address.sessionId;
        follows.set(id, frame);
        // Native follow opens with a verified tail before delivering new events.
        queueMicrotask(() => frame({ type: "snapshot", header: { createdAt: 1000 }, cursor: -1, records: [], assistantStream: { revision: 0 } }));
        return () => { follows.delete(id); };
      },
    };
    const runtime = new DshRuntime(client);
    const recoverDshRuntime = vi.fn(async () => runtime);
    const ensureDshRuntime = vi.fn(async () => { throw new Error("automatic recovery must not launch DSH"); });
    host = await HostService.create({ relayUrl: relay.url, ...relayBusinessHostOptions(relay.url), credential: "runtime-secret", adminToken: "owner-secret", stateDir,
      sessionsRoot: join(stateDir, "pi-sessions"), reconnect: false, lan: false, ensureDshRuntime,
      ...(mode === "prestarted" ? { dshRuntime: runtime } : { recoverDshRuntime }) });
    try {
      await host.start();
      await vi.waitFor(() => expect(runtime.directoryEntries().some(row => row.runtimeId === "dsh:existing")).toBe(true));
      client.onDiagnostic?.({ event: "socket.closed", code: "1001", reason: "peer left" });
      client.onDiagnostic?.({ event: "socket.error", code: "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH", reason: "Max payload size exceeded", maxFrameBytes: 104857600 });
      client.onDiagnostic?.({ event: "reconnected" });
      await new Promise(resolve => setTimeout(resolve, 10));
      client.onReconnect?.();
      workspace!({ type: "baseline", value: { archivedSessionIds: [] } });
      await new Promise(resolve => setTimeout(resolve, 20));
      const transport = host.readDiagnostics({ category: "backend.transport" }).records;
      expect(transport).toEqual(expect.arrayContaining([
        expect.objectContaining({ agentKind: "dsh", message: "DSH Web socket.closed", detail: { code: "1001", reason: "peer left" } }),
        expect.objectContaining({ message: "DSH Web socket.error", detail: { code: "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH", reason: "Max payload size exceeded", maxFrameBytes: "104857600" } }),
        expect.objectContaining({ agentKind: "dsh", message: "DSH Web reconnected", severity: "info" }),
      ]));
      const persisted = await readFile(join(stateDir, "diagnostics.ndjson"), "utf8");
      expect(persisted).toContain('"category":"backend.transport"');
      const ready = await readyDeviceCapturing({ host, relay }); device = ready.device;
      expect(ready.ready).toMatchObject({ runtimes: [expect.objectContaining({ runtimeId: "dsh:existing" })] });
      const until = async (predicate: (message: Record<string, unknown>) => boolean) => {
        for (let i = 0; i < 60; i++) {
          const message = await device!.receiveMessage() as Record<string, unknown>;
          expect(message.type).not.toBe("protocol.error");
          if (predicate(message)) return message;
        }
        throw new Error("Expected DSH discovery message not received");
      };
      client.onEvent?.({ type: "emit", event: "api-session/added", args: [row("browser", true)] });
      expect(await until(message => message.type === "runtime.online" && (message.runtime as RuntimeMetadata)?.runtimeId === "dsh:browser"))
        .toMatchObject({ runtime: { sessionId: "dsh:browser", status: "running" } });
      follows.get("browser")!({ type: "event", event: { seq: 0, time: 1000, type: "user/message",
        data: { role: "user", source: { kind: "user", rpcId: "web-1" }, content: [{ type: "text", text: "browser message" }] } } });
      expect(await until(message => message.runtimeId === "dsh:browser" && (message.event as RuntimeEvent)?.type === "session.patch" &&
        ((message.event as Extract<RuntimeEvent, { type: "session.patch" }>).entries ?? []).some(entry => JSON.stringify(entry).includes("browser message"))))
        .toMatchObject({ event: { entries: [expect.objectContaining({ data: { message: expect.objectContaining({ content: [{ type: "text", text: "browser message" }] }) } })], live: { messages: [] } } });
      sendRequest(device, { type: "runtime.command", protocolVersion: PROTOCOL_VERSION, runtimeId: "dsh:browser", commandId: "app-send",
        command: { type: "user_message", text: "phone message", messageId: "app-1" } });
      await vi.waitFor(() => expect(request).toHaveBeenCalledWith("session/prompt", { request: expect.objectContaining({ sessionId: "browser", content: [{ type: "text", text: "phone message" }] }) }));
      workspace!({ type: "archived", archivedSessionIds: ["browser"] });
      // Native archive notification and live-directory removal are independent events.
      // Keep both observations instead of discarding the first while waiting for the other.
      const archived: Record<string, unknown>[] = [];
      while (archived.length < 2) archived.push(await until(message =>
        message.type === "runtime.offline" && message.runtimeId === "dsh:browser" ||
        message.type === "session.archive.changed" && message.sessionId === "dsh:browser"));
      expect(archived).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: "runtime.offline", runtimeId: "dsh:browser" }),
        expect.objectContaining({ type: "session.archive.changed", sessionId: "dsh:browser", archived: true, agentKind: "dsh" }),
      ]));
      expect(request.mock.calls.some(([method]) => method === "session/create")).toBe(false);
      expect(ensureDshRuntime).not.toHaveBeenCalled();
      expect(recoverDshRuntime).toHaveBeenCalledTimes(mode === "recovered" ? 1 : 0);
    } finally { await runtime.stop(); }
  });

  // KIMI-06: use the real encrypted transport and verify both directions, including a same-device downgrade.
  it("gates Kimi discovery, commands, scoped diagnostics, launch recovery and receipts on the current handshake", async () => {
    stateDir = await mkdtemp(join(tmpdir(), "orbis-kimi-host-"));
    relay = await startRelayLocal(stateDir);
    const cwd = join(stateDir, "kimi-only-workspace"); await mkdir(cwd);
    const id = "kimi-code:fixture:session_host_wire";
    const kimi = new KimiRuntime({ stateDir });
    let events: (event: RuntimeEvent, runtimeId: string) => void = () => {};
    let online = false;
    const metadata = { name: "Kimi Code", runtimeId: id, sessionId: id, cwd, status: "idle" as const, sessionGraphSync: true };
    vi.spyOn(kimi, "start").mockImplementation(() => {});
    vi.spyOn(kimi, "setEventSink").mockImplementation(sink => { events = sink; });
    vi.spyOn(kimi, "isReady").mockReturnValue(true);
    vi.spyOn(kimi, "ownsRuntime").mockImplementation(runtimeId => online && runtimeId === id);
    vi.spyOn(kimi, "directoryEntries").mockImplementation(() => online ? [metadata] : []);
    vi.spyOn(kimi, "catalogCoverage").mockImplementation(async archived => ({ complete: true, sessions: archived ? [] : [
      { agentKind: "kimiCode", sessionId: id, cwd, hostname: "fixture", createdAt: 1, modifiedAt: 2, messageCount: 0 },
    ] }));
    vi.spyOn(kimi, "sessionConfiguration").mockResolvedValue({ defaults: {}, models: [], permissions: [], binding: "kimi-code:fixture:local" });
    const activate = vi.spyOn(kimi, "activate").mockImplementation(async (_target, context) => {
      online = true; kimi.onMetadataChange?.(metadata);
      const activation = { sessionId: id, spawnMode: "headless" as const };
      await context?.onCreated?.(activation); return activation;
    });
    const dispatched = vi.spyOn(kimi, "dispatchCommand").mockImplementation((_id, commandId) => {
      events({ type: "command.result", commandId, ok: true, status: "success" }, id); return "handled";
    });
    host = await HostService.create({ relayUrl: relay.url, ...relayBusinessHostOptions(relay.url), credential: "runtime-secret", adminToken: "owner-secret", stateDir,
      sessionsRoot: join(stateDir, "pi-sessions"), reconnect: false, lan: false, kimiCodeRuntime: kimi });
    await host.start();
    const opened = await host.openPairingWindow();
    const connected = await TestDevice.connect({ relayUrl: relay.url, relayHttpBase: relay.url.replace(/^ws/u, "http"),
      qrText: encodePairingQrText(opened.payload), deviceName: "Kimi fixture" });
    device = connected.device;
    const pskRoot = await device.pair(opened.payload);
    const handshake = () => device!.openChannel("relay", pskRoot, opened.payload.hostId, opened.payload.hostId);
    const wait = async (predicate: (message: Record<string, unknown>) => boolean, forbidden = false) => {
      for (let i = 0; i < 100; i++) {
        const message = await device!.receiveMessage() as Record<string, unknown>;
        if (forbidden) expect(JSON.stringify(message)).not.toMatch(/kimi-code:fixture|kimi-only-workspace|"agentKind":"kimiCode"|native diagnostic/u);
        if (predicate(message)) return message;
      }
      throw new Error("Kimi fixture did not receive expected message");
    };
    const send = (type: string, params: object) => sendRequest(device!, { type, protocolVersion: PROTOCOL_VERSION, ...params });
    const read = (requestId: string, scope = "host", known?: unknown[]) => {
      send("agent.state.request", { requestId, scope, stateFormat: "compact-v2", subscribe: true,
        domains: scope === "host" ? ["backends", "workspaces", "catalog", "diagnostics", "management"] : ["operations"], ...(known ? { known } : {}) });
      return wait(message => message.requestId === requestId, requestId !== "host-full");
    };
    const launch = { requestId: "launch", launchId: "kimi-launch", agentKind: "kimiCode", cwd, binding: "kimi-code:fixture:local", revision: 0, values: {}, spawnMode: "headless" };
    await handshake();
    const initial = await wait(message => message.type === "device.ready", true);
    expect(initial.hostFeatures).toEqual([
      "device.features",
      HOST_FEATURE_IMPORT_TARGET,
      HOST_FEATURE_WEB_PREVIEW,
      HOST_FEATURE_NATIVE_FILE_PREVIEW,
      "message.content-render.v1",
      "agent.openclaw",
      "agent.hermes",
      "agent.opencode",
      "state.compact-bootstrap.v1",
      "claude.send-now.v1",
      RUNTIME_CLOSE_FEATURE,
      "agent.kimiCode",
    ]);
    expect(initial.agents).not.toContain("kimiCode");
    const hidden = await read("host-hidden");
    for (const [type, body] of [
      ["session.configuration.read", { requestId: "config-no", agentKind: "kimiCode", cwd }],
      ["session.launch", launch],
      ["session.activate", { requestId: "resume-no", target: { type: "resume", sessionId: id } }],
      ["session.archive", { requestId: "archive-no", sessionId: id, agentKind: "kimiCode", archived: true }],
      ["runtime.command", { commandId: "history-no", runtimeId: id, command: { type: "session.sync", sessionId: id, syncId: "history", range: "preview" } }],
      ["runtime.command", { commandId: "answer-no", runtimeId: id, command: { type: "interaction.respond", requestId: "approval", extensionId: "kimiCode", response: { kind: "confirm", value: true } } }],
    ] as const) {
      send(type, body);
      const reply = await wait(message => message.requestId === ("requestId" in body ? body.requestId : body.commandId) || message.commandId === ("commandId" in body ? body.commandId : "never"), true);
      expect(reply).toMatchObject({ type: "protocol.error", code: "agent_feature_required" });
    }
    expect(activate).not.toHaveBeenCalled(); expect(dispatched).not.toHaveBeenCalled();
    send("device.features", { features: ["agent.kimiCode"] });
    const full = await wait(message => message.type === "device.ready" && (message.launchableAgents as string[]).includes("kimiCode"));
    expect(full.modelEpoch).not.toBe(initial.modelEpoch);
    expect(full).not.toHaveProperty("dshDesktop");
    const known = (hidden.domains as AgentStateDomainSnapshot[]).map(({ domain, modelEpoch, revision }) => ({ domain, modelEpoch, revision }));
    const snapshot = await read("host-full", "host", known);
    expect(snapshot.unchanged).toBeUndefined();
    expect(snapshot.domains).toEqual(expect.arrayContaining([expect.objectContaining({ domain: "catalog", modelEpoch: full.modelEpoch,
      value: expect.objectContaining({ totalSessions: 1, sessions: [expect.objectContaining({ sessionId: id })] }) })]));
    expect((snapshot.domains as AgentStateDomainSnapshot[]).every(domain => domain.delta === undefined)).toBe(true);
    send("session.launch", launch);
    expect(await wait(message => message.requestId === "launch" && message.phase === "ready")).toMatchObject({ sessionId: id, spawnMode: "headless" });
    expect(activate).toHaveBeenCalledExactlyOnceWith({ type: "new", cwd }, expect.objectContaining({ nativeLaunchMarker: expect.any(String), spawnMode: "headless" }));
    await expect(readFile(join(stateDir, "session-configuration.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(stateDir, "kimi-session-configuration.json"), "utf8")).toContain('"agentKind":"kimiCode"');
    host.recordDiagnostic({ scope: "agent", agentKind: "kimiCode", sessionId: id, category: "fixture", severity: "info", message: "native diagnostic" });
    send("runtime.command", { commandId: "native-stop", runtimeId: id, command: { type: "stop" } });
    await wait(message => (message.event as { commandId?: string } | undefined)?.commandId === "native-stop");
    expect(dispatched).toHaveBeenCalledTimes(1);
    await handshake();
    const downgraded = await wait(message => message.type === "device.ready" && message.modelEpoch !== full.modelEpoch, true);
    expect(downgraded.agents).not.toContain("kimiCode");
    send("session.launch.read", { launchId: launch.launchId, requestId: "recover-no" });
    expect(await wait(message => message.requestId === "recover-no", true)).toMatchObject({ type: "session.launch.result", phase: "absent" });
    await read("private-downgraded", "device");
    send("diagnostics.request", { requestId: "diagnostics-no", category: "fixture" });
    expect(await wait(message => message.requestId === "diagnostics-no", true)).toMatchObject({ page: { records: [] } });
    expect(activate).toHaveBeenCalledTimes(1);
  });

  // KIMI-09/11: opt-in real Kimi Web/Desktop and released Orbis runtime probes. The fixture owns the isolated native server.
  it.skipIf(!process.env.ORBIS_TEST_KIMI_FIXTURE)("drives real Kimi Web through the encrypted Relay channel", async () => {
    const fixture = JSON.parse(await readFile(process.env.ORBIS_TEST_KIMI_FIXTURE!, "utf8")) as {
      homeDir: string; endpoint?: string; source?: "desktop"; cwd: string; oldRelay?: string; oldHost?: string; result: string;
    };
    stateDir = await mkdtemp(join(tmpdir(), "orbis-kimi-chain-"));
    const options = { port: 0, runtimeCredentials: ["runtime-secret"], adminToken: "owner-secret", stateFile: join(stateDir, "relay.json") };
    const releasedRelay = fixture.oldRelay ? await import(/* @vite-ignore */ fixture.oldRelay) as { createRelayServer: typeof createRelayServer } : undefined;
    relay = await (releasedRelay?.createRelayServer ?? createRelayServer)(options);
    const nativeOptions = { homeDir: fixture.homeDir, ...(fixture.endpoint ? { endpoint: fixture.endpoint } : {}), ...(fixture.source ? { source: fixture.source } : {}) };
    const kimi = new KimiRuntime({ stateDir, ...nativeOptions });
    const hostOptions = { relayUrl: relay.url, credential: "runtime-secret", adminToken: "owner-secret", stateDir,
      sessionsRoot: join(stateDir, "pi-sessions"), reconnect: false, lan: false };
    host = await HostService.create({ ...hostOptions, kimiCodeRuntime: kimi });
    await host.start();
    await vi.waitFor(() => expect(kimi.isReady(), kimi.reason ?? "Kimi not ready").toBe(true), { timeout: 12_000 });
    const opened = await host.openPairingWindow();
    const connected = await TestDevice.connect({ relayUrl: relay.url, relayHttpBase: relay.url.replace(/^ws/u, "http"),
      qrText: encodePairingQrText(opened.payload), deviceName: "Isolated Kimi wire client" });
    device = connected.device;
    const psk = await device.pair(opened.payload);
    const handshake = () => device!.openChannel("relay", psk, opened.payload.hostId, opened.payload.hostId);
    const wait = async (label: string, predicate: (message: Record<string, unknown>, event?: Partial<RuntimeEvent>) => boolean,
      legacy = false) => {
      const deadline = Date.now() + 10_000;
      const seen = new Set<string>();
      while (Date.now() < deadline) {
        const message = await device!.receiveMessage().catch(() => { throw new Error(`Missing ${label}; saw ${[...seen].join(", ")}`); });
        const e = message.event as Partial<RuntimeEvent> | undefined;
        seen.add(e?.type === "command.result" ? `${e.commandId}:${e.status}:${e.error ?? ""}` : String(e?.type ?? message.type));
        if (legacy) expect(JSON.stringify({ ...message, hostFeatures: undefined })).not.toMatch(/"kimiCode"|kimi-code:/u);
        if (predicate(message, message.event as Partial<RuntimeEvent> | undefined)) return message;
        if (message.type === "protocol.error") throw new Error(`${label}: ${JSON.stringify(message)}`);
      }
      throw new Error(`Missing ${label}; saw ${[...seen].join(", ")}`);
    };
    const send = (type: string, fields: object) => sendRequest(device!, { type, protocolVersion: PROTOCOL_VERSION, ...fields });
    const ready = (negotiated: boolean) => wait("device ready", m => m.type === "device.ready"
      && (m.launchableAgents as string[]).includes("kimiCode") === negotiated, !negotiated);
    const reply = (id: string, phase?: string) => wait(id, m => m.requestId === id && (phase === undefined || m.phase === phase));
    const event = async <T extends RuntimeEvent["type"]>(type: T, match: (value: Extract<RuntimeEvent, { type: T }>) => boolean) =>
      (await wait(type, (m, e) => m.runtimeId === id && e?.type === type && match(e as Extract<RuntimeEvent, { type: T }>))).event as Extract<RuntimeEvent, { type: T }>;
    const receipt = (commandId: string) => event("command.result", e => e.commandId === commandId && e.status !== "pending");
    const snapshot = async (syncId: string) => {
      device!.sendCommand(id, syncId, { type: "session.sync", sessionId: id, syncId, range: "preview", maxEntries: 100 });
      const response = await event("session.snapshot", e => e.syncId === syncId);
      device!.sendCommand(id, `${syncId}-ack`, { type: "session.snapshot.ack", syncId, result: "applied" });
      return response;
    };
    let id: string;
    await handshake();
    expect((await ready(false)).hostFeatures).toContain("agent.kimiCode");
    send("device.features", { features: ["agent.kimiCode"] });
    await ready(true);
    // Open a native-owned session before Orbis requests activation, while an approval is live.
    const nativePeer = await KimiWebClient.connect(nativeOptions);
    try {
      const existing = await nativePeer.requestJson("/api/v1/sessions", { method: "POST", body: {
        metadata: { cwd: fixture.cwd }, environment_id: "local",
      } }) as { id: string };
      const configForResume = await kimi.sessionConfiguration(fixture.cwd);
      id = `${configForResume.binding.slice(0, -"local".length)}${existing.id}`;
      if (fixture.source === "desktop") expect(id).toMatch(/^kimi-code:desktop-/u);
      const frames: Record<string, unknown>[] = [];
      const peer = nativePeer.openSocket(frame => frames.push(frame), () => {});
      await vi.waitFor(() => expect(peer.readyState).toBe(WebSocket.OPEN));
      peer.send(JSON.stringify({ type: "subscribe", request_id: "peer-subscribe", session_id: existing.id }));
      await vi.waitFor(() => expect(frames).toContainEqual(expect.objectContaining({ type: "turns", session_id: existing.id })));
      await nativePeer.requestJson(`/api/v1/sessions/${existing.id}/prompts`, { method: "POST", body: {
        agent_id: "main", prompt_id: "peer-prompt", content: [{ type: "text", text: "native-approval-existing-fixture" }],
      } });
      await vi.waitFor(() => expect(frames).toContainEqual(expect.objectContaining({ type: "interaction", kind: "approval", status: "pending" })), { timeout: 5000 });
      send("session.activate", { requestId: "attach-existing", target: { type: "resume", agentKind: "kimiCode", sessionId: id }, spawnMode: "headless" });
      let attached = false;
      let pending: Extract<RuntimeEvent, { type: "interaction.requested" | "interaction.snapshot" }> | undefined;
      await wait("native activation and pending interaction", (m, e) => {
        if (m.requestId === "attach-existing") {
          expect(m).toMatchObject({ type: "session.activated", sessionId: id });
          attached = true;
        }
        if (m.runtimeId === id && (e?.type === "interaction.requested" || e?.type === "interaction.snapshot" && e.requests?.length === 1)) {
          pending = e as typeof pending;
        }
        return attached && pending !== undefined;
      });
      const e = pending!;
      const approval = e.type === "interaction.requested" ? e.request : e.requests[0]!;
      device.sendCommand(id, "peer-answer", { type: "interaction.respond", extensionId: approval.extensionId, requestId: approval.requestId, response: { kind: "confirm", value: false } });
      expect(await receipt("peer-answer")).toMatchObject({ status: "success" });
      await vi.waitFor(() => expect(frames).toContainEqual(expect.objectContaining({ type: "interaction", kind: "approval", outcome: "rejected", status: "ended" })));
      expect(JSON.stringify(await snapshot("peer-history"))).toContain("native-approval-existing-fixture");
    } finally { nativePeer.close(); }
    send("session.configuration.read", { requestId: "config", agentKind: "kimiCode", cwd: fixture.cwd });
    const config = await reply("config");
    expect(config).toMatchObject({ type: "session.configuration.result", agentKind: "kimiCode" });
    send("session.launch", { requestId: "launch", launchId: "kimi-wire", agentKind: "kimiCode", cwd: fixture.cwd,
      binding: config.binding, revision: config.revision, values: config.values, spawnMode: "headless" });
    const launched = await reply("launch", "ready");
    expect(launched.sessionId).toMatch(/^kimi-code:/u);
    id = launched.sessionId as string;
    send("session.launch.read", { requestId: "recover", launchId: "kimi-wire" });
    expect(await reply("recover", "ready")).toMatchObject({ sessionId: id });
    await snapshot("initial");
    device.sendCommand(id, "send-1", { type: "user_message", messageId: "client-kimi-wire", text: "native-approval-fixture" });
    // Receipts and the native interaction are independently ordered on the channel.
    const observed: Record<string, unknown>[] = [];
    await wait("prompt receipt and native approval", (m, e) => {
      if (m.runtimeId === id && (e?.type === "interaction.requested" || e?.type === "command.result" && e.commandId === "send-1" && e.status !== "pending")) observed.push(m);
      return observed.some(row => (row.event as RuntimeEvent).type === "interaction.requested")
        && observed.some(row => (row.event as RuntimeEvent).type === "command.result");
    });
    expect(observed).toContainEqual(expect.objectContaining({ event: expect.objectContaining({ type: "command.result", status: "success" }) }));
    const card = (observed.find(row => (row.event as RuntimeEvent).type === "interaction.requested")!.event as Extract<RuntimeEvent, { type: "interaction.requested" }>).request;
    expect(card.kind).toBe("confirm");
    device.sendCommand(id, "answer", { type: "interaction.respond", extensionId: card.extensionId, requestId: card.requestId, response: { kind: "confirm", value: false } });
    const terminal: RuntimeEvent[] = [];
    await wait("approval acknowledgement and native terminal transcript", (m, e) => {
      if (m.runtimeId === id && (e?.type === "session.patch" && e.live?.turn?.outcome === "completed"
        || e?.type === "command.result" && e.commandId === "answer" && e.status !== "pending")) terminal.push(e as RuntimeEvent);
      return terminal.some(row => row.type === "command.result") && terminal.some(row => row.type === "session.patch");
    });
    expect(terminal).toContainEqual(expect.objectContaining({ type: "command.result", status: "success" }));
    const before = await snapshot("before");
    expect(JSON.stringify(before)).toContain("client-kimi-wire");
    expect(JSON.stringify(before)).toContain("fixture reply");
    await handshake();
    await ready(false);
    send("session.launch.read", { requestId: "legacy-recovery", launchId: "kimi-wire" });
    expect(await wait("legacy isolation", m => m.requestId === "legacy-recovery", true)).toMatchObject({ phase: "absent" });
    send("device.features", { features: ["agent.kimiCode"] });
    await ready(true);
    const after = await snapshot("after");
    expect(after.display?.entries.map(row => row.entryId)).toEqual(before.display?.entries.map(row => row.entryId));
    device.sendCommand(id, "idle-stop", { type: "stop" });
    expect(await receipt("idle-stop")).toMatchObject({ status: "not_cancelable" });
    // Keep the current turn at an actual approval; a second native client queues its successor.
    device.sendCommand(id, "running", { type: "user_message", messageId: "running", text: "native-approval-stop-fixture" });
    await event("interaction.requested", e => e.request.kind === "confirm" && e.request.requestId !== card.requestId);
    const native = await KimiWebClient.connect(nativeOptions);
    try {
      const path = `/api/v1/sessions/${id.split(":").at(-1)}/prompts`;
      const queued = await native.requestJson(path, { method: "POST", body: { prompt_id: "native-queued", agent_id: "main",
        content: [{ type: "text", text: "native-next-fixture" }] } });
      expect(queued).toMatchObject({ prompt_id: "native-queued", status: "queued" });
      await event("delivery.snapshot", e => e.complete === true && e.items.some(item => item.text === "native-next-fixture"));
      device.sendCommand(id, "busy-send", { type: "user_message", messageId: "busy-send", text: "must not enqueue" });
      expect(await receipt("busy-send")).toMatchObject({ status: "failure", error: "runtime_busy" });
      device.sendCommand(id, "running-stop", { type: "stop" });
      const stopEvidence = new Set<string>();
      await wait("exact stop and queued successor", (m, e) => {
        if (m.runtimeId !== id) return false;
        if (e?.type === "command.result" && e.commandId === "running-stop" && e.status !== "pending") {
          expect(e.status).toBe("success"); stopEvidence.add("receipt");
        }
        if (e?.type === "session.patch" && e.live?.turn?.outcome === "cancelled") stopEvidence.add("cancelled");
        if (e?.type === "session.patch" && e.live?.turn?.outcome === "completed") stopEvidence.add("successor");
        return stopEvidence.size === 3;
      });
      const final = JSON.stringify(await snapshot("after-stop"));
      expect(final).toContain("native-next-fixture");
      expect(final).not.toContain("must not enqueue");
    } finally { native.close(); }
    const report = { relay: fixture.oldRelay ? "released" : "current", checks: ["resume a native-owned active session and resolve its pending approval", "configuration", "launch and exact recovery", "prompt identity",
      "native approval rejection", "history and reconnect", "unnegotiated isolation", "idle stop rejected", "exact running stop and queued successor"], releasedHost: false };
    if (fixture.oldHost) {
      const ledgerPath = join(stateDir, "kimi-session-configuration.json");
      const ledger = await readFile(ledgerPath);
      device.close();
      await host.stop();
      const released = await import(/* @vite-ignore */ fixture.oldHost) as { HostService: typeof HostService };
      host = await released.HostService.create(hostOptions);
      await host.start();
      // Discard the reference phone's queue along with its old socket, like an App process restart.
      device = await device.reopenRelay(psk, opened.payload.hostId);
      const oldReady = await ready(false);
      expect(oldReady.hostFeatures).toEqual(expect.arrayContaining(["device.features"]));
      expect(oldReady.hostFeatures).not.toContain("agent.kimiCode");
      expect(oldReady.agents).toContain("pi");
      send("session.launch.read", { requestId: "rolled-back", launchId: "kimi-wire" });
      expect(await wait("old Host launch ledger", m => m.requestId === "rolled-back", true)).toMatchObject({ phase: "absent" });
      send("session.list", { requestId: "legacy-list" });
      expect(await wait("old Host catalog", m => m.requestId === "legacy-list", true)).toMatchObject({ type: "session.list.result" });
      expect(await readFile(ledgerPath)).toEqual(ledger);
      report.releasedHost = true;
    }
    await writeFile(fixture.result, JSON.stringify(report, null, 2) + "\n");
  }, 90_000);

  // ADR-0076 DSH-DESKTOP-03 / 06: Web and Desktop expose the same native id as two routes, and a device sees
  // `dshDesktop` only after declaring it on its current handshake. Released Apps keep the pre-Desktop view.
  it("negotiates the Desktop entry per device and routes the same native id to separate entries", async () => {
    stateDir = await mkdtemp(join(tmpdir(), "orbis-dsh-desktop-host-"));
    relay = await startRelayLocal(stateDir);
    const fake = (label: string) => {
      const row = (sessionId: string) => ({ sessionId, cwd: stateDir!, agentAvailable: true, running: true, updatedAt: 1000 });
      const request = vi.fn<(method: string, args?: unknown) => Promise<unknown>>(async method => method === "session/list" ? { items: [row("shared")] } : {});
      const client: DshWebConnection = {
        onEvent: undefined, onExit: undefined, onReconnect: undefined,
        request: request as DshWebConnection["request"], respondEvent: vi.fn(async () => {}), stop: vi.fn(async () => {}),
        subscribe(method, _args, frame) {
          if (method === "workspace/follow") queueMicrotask(() => frame({ type: "baseline", value: { archivedSessionIds: [] } }));
          if (method === "session/follow") queueMicrotask(() => frame({ type: "snapshot", header: { createdAt: 1000 }, cursor: -1, records: [], assistantStream: { revision: 0 } }));
          return () => {};
        },
      };
      return { client, request, row, label };
    };
    const web = fake("web"); const desktop = fake("desktop");
    const webRuntime = new DshRuntime(web.client);
    const desktopRuntime = new DshRuntime(desktop.client, undefined, { flavor: DSH_DESKTOP_FLAVOR });
    host = await HostService.create({ relayUrl: relay.url, ...relayBusinessHostOptions(relay.url), credential: "runtime-secret", adminToken: "owner-secret", stateDir,
      sessionsRoot: join(stateDir, "pi-sessions"), reconnect: false, lan: false, dshRuntime: webRuntime, dshDesktopRuntime: desktopRuntime,
      dshDesktopLaunchable: true, dshDesktopStatus: () => ({ state: "attached", reason: "已接入 DeepSeek Harness Desktop", version: "0.2.2-rc.2" }) });
    try {
      await host.start();
      await vi.waitFor(() => expect(desktopRuntime.directoryEntries().map(row => row.runtimeId)).toEqual(["dsh-desktop:shared"]));
      await vi.waitFor(() => expect(webRuntime.directoryEntries().map(row => row.runtimeId)).toEqual(["dsh:shared"]));
      const opened = await host.openPairingWindow();
      const connected = await TestDevice.connect({ relayUrl: relay.url, relayHttpBase: relay.url.replace(/^ws/u, "http"),
        qrText: encodePairingQrText(opened.payload), deviceName: "Released App" });
      device = connected.device;
      const pskRoot = await device.pair(opened.payload);
      await device.openChannel("relay", pskRoot, opened.payload.hostId, opened.payload.hostId);
      const ready = { ready: await device.receiveMessage() as Record<string, unknown> };
      const legacyRuntimes = (ready.ready.runtimes as RuntimeMetadata[]).map(row => row.runtimeId);
      expect(legacyRuntimes).toContain("dsh:shared");
      expect(legacyRuntimes).not.toContain("dsh-desktop:shared");
      expect(ready.ready.agents).not.toContain("dshDesktop");
      expect(ready.ready.launchableAgents).not.toContain("dshDesktop");
      expect(ready.ready).not.toHaveProperty("dshDesktop");
      expect(ready.ready.hostFeatures).toEqual(expect.arrayContaining(["device.features", HOST_FEATURE_IMPORT_TARGET]));
      expect(ready.ready.hostFeatures).toContain("agent.openclaw");
      RelayToDeviceMessageSchema.parse(ready.ready);
      const until = async (predicate: (message: Record<string, unknown>) => boolean) => {
        for (let i = 0; i < 80; i++) {
          const message = await device!.receiveMessage() as Record<string, unknown>;
          expect(message.type).not.toBe("protocol.error");
          if (predicate(message)) return message;
        }
        throw new Error("Expected Desktop negotiation message not received");
      };
      const hostState = async (requestId: string, known?: unknown[]) => {
        sendRequest(device!, { type: "agent.state.request", protocolVersion: PROTOCOL_VERSION, requestId, scope: "host", domains: ["catalog", "backends"], ...(known ? { known } : {}) });
        return until(message => message.requestId === requestId);
      };
      const legacy = await hostState("legacy-host");
      const legacyDomains = new Map((legacy.domains as AgentStateDomainSnapshot[]).map(domain => [domain.domain, domain]));
      const legacyCatalog = legacyDomains.get("catalog")!.value as { sessions: Array<{ sessionId: string; agentKind: string }>; totalSessions: number; nextCursor: string | null };
      expect(legacyCatalog.sessions.map(session => session.sessionId)).toEqual(["dsh:shared"]);
      expect(legacyCatalog.totalSessions).toBe(1);
      expect(legacyCatalog.nextCursor).toBeNull();
      expect(JSON.stringify(legacyDomains.get("backends")!.value)).not.toContain("dshDesktop");
      // Catalog query support and Desktop visibility are independent capabilities.
      sendRequest(device, { type: "session.catalog.capabilities.request", protocolVersion: PROTOCOL_VERSION, requestId: "catalog-capabilities" });
      await until(message => message.requestId === "catalog-capabilities");
      const queryCatalog = async (requestId: string) => {
        sendRequest(device!, { type: "session.catalog.query", protocolVersion: PROTOCOL_VERSION, requestId, format: "v1",
          query: { text: "", agentKind: null, archived: false, provider: "all" }, cursor: null, limit: 100 });
        return await until(message => message.requestId === requestId) as unknown as CatalogQueryPage;
      };
      const filteredQuery = await queryCatalog("filtered-query");
      expect(filteredQuery.page.sessions.map(row => row.sessionId)).toEqual(["dsh:shared"]);
      expect(filteredQuery.page.totalSessions).toBe(1);
      // The released App never hears Desktop runtime traffic.
      desktop.client.onEvent?.({ type: "emit", event: "api-session/added", args: [desktop.row("desktop-only")] });
      web.client.onEvent?.({ type: "emit", event: "api-session/added", args: [web.row("web-only")] });
      const seen: string[] = [];
      await until(message => {
        if (typeof message.runtimeId === "string") seen.push(message.runtimeId);
        if (message.type === "runtime.online") seen.push((message.runtime as RuntimeMetadata).runtimeId);
        return message.type === "runtime.online" && (message.runtime as RuntimeMetadata).runtimeId === "dsh:web-only";
      });
      expect(seen.filter(id => id.startsWith("dsh-desktop:"))).toEqual([]);

      // Declaring the feature replaces this handshake's filtered view with the full one.
      sendRequest(device, { type: "device.features", protocolVersion: PROTOCOL_VERSION, features: ["agent.dshDesktop"] });
      const full = await until(message => message.type === "device.ready");
      expect((full.runtimes as RuntimeMetadata[]).map(row => row.runtimeId)).toEqual(expect.arrayContaining(["dsh:shared", "dsh-desktop:shared", "dsh-desktop:desktop-only"]));
      expect(full.agents).toContain("dshDesktop");
      expect(full.launchableAgents).toContain("dshDesktop");
      expect(full.dshDesktop).toEqual({ state: "attached", reason: "已接入 DeepSeek Harness Desktop", version: "0.2.2-rc.2" });
      // Revisions read under the filtered view are not trusted for the full one.
      const known = (legacy.domains as AgentStateDomainSnapshot[]).map(domain => ({ domain: domain.domain, modelEpoch: domain.modelEpoch, revision: domain.revision }));
      const upgraded = await hostState("full-host", known);
      const catalog = (upgraded.domains as AgentStateDomainSnapshot[]).find(domain => domain.domain === "catalog")!.value as { sessions: Array<{ sessionId: string; agentKind: string }> };
      expect(catalog.sessions.map(session => [session.sessionId, session.agentKind])).toEqual(expect.arrayContaining([["dsh:shared", "dsh"], ["dsh-desktop:shared", "dshDesktop"]]));
      const fullQuery = await queryCatalog("full-query");
      expect(fullQuery.page.sessions.map(row => [row.sessionId, row.agentKind])).toEqual(expect.arrayContaining([["dsh:shared", "dsh"], ["dsh-desktop:shared", "dshDesktop"]]));

      // The same native id reaches only the entry that owns the public id.
      sendRequest(device, { type: "runtime.command", protocolVersion: PROTOCOL_VERSION, runtimeId: "dsh-desktop:shared", commandId: "desktop-send",
        command: { type: "user_message", text: "to desktop", messageId: "desktop-1" } });
      await vi.waitFor(() => expect(desktop.request).toHaveBeenCalledWith("session/prompt", { request: expect.objectContaining({ sessionId: "shared" }) }));
      expect(web.request.mock.calls.some(([method]) => method === "session/prompt")).toBe(false);

      // A new handshake may be an older App build: it starts filtered again until it declares.
      await device.openChannel("relay", pskRoot, opened.payload.hostId, opened.payload.hostId);
      const again = await until(message => message.type === "device.ready");
      expect((again.runtimes as RuntimeMetadata[]).map(row => row.runtimeId)).not.toContain("dsh-desktop:shared");
    } finally { await webRuntime.stop(); await desktopRuntime.stop(); }
  });

  // HERMES-COMPAT-01: run the same encrypted fixture against the candidate or a separately built release Relay.
  // ORBIS_HERMES_COMPAT_RELEASE_ROOT points to a compiled, isolated checkout of the comparison tag.
  const releaseRoot = process.env.ORBIS_HERMES_COMPAT_RELEASE_ROOT;
  const startHermesCompatRelay = async (dir: string): Promise<RelayServer> => {
    if (!releaseRoot) return startRelayLocal(dir);
    const released = await import(pathToFileURL(join(releaseRoot, "packages/relay/dist/index.js")).href) as typeof import("@orbis/relay");
    return released.createRelayServer({ port: 0, runtimeCredentials: ["runtime-secret"], adminToken: "owner-secret",
      stateFile: join(dir, "relay-state.json") });
  };

  // HERMES-GATEWAY-01: exercise the real E2E Host/Relay router without touching a user Gateway.
  it("connects Hermes only for negotiated requests and resets its visibility on rehandshake", async () => {
    stateDir = await mkdtemp(join(tmpdir(), "orbis-hermes-host-"));
    relay = await startHermesCompatRelay(stateDir);
    const profile_id = join(stateDir, "fixture-hermes");
    const sessionId = "hermes-private-id";
    const endpoint = { profile_id, instance_id: "fixture", authority_epoch: 1, runtime_protocol: 1,
      api_origin: "http://127.0.0.1:1", supervisor: "fixture", capabilities: ["session-authority-v1"] };
    const close = vi.fn(async () => undefined);
    const request = vi.fn(async (method: string, args: Record<string, unknown>) => {
      if (method === "session.list") return { sessions: args.scope === "live" ? [] : [{ id: sessionId, title: "Synthetic Hermes", started_at: 1000 }] };
      if (method === "prompt.submit") return { admission_id: "hermes-fixture-admission", status: "started" };
      if (method === "session.resume") return { session_id: sessionId, stored_session_id: sessionId, running: false,
        messages: [], prompts: [], last_sequence: 0, execution_generation: 0, replay_epoch: "initial", authority_epoch: 1,
        info: { cwd: stateDir } };
      throw new Error(`Unimplemented fixture method ${method}`);
    });
    const client = { request, close, closed: false, readyState: 1 } as unknown as HermesGatewayRpcClient;
    const connectHermes = vi.fn(async () => ({ client, endpoint, serverRequests: [], runtime: {
      ...endpoint, capabilities: [...endpoint.capabilities, "durable-admission-v1"], session_create: { sources: ["tui"], parameters: ["cwd"] },
    } }));
    host = await HostService.create({ relayUrl: relay.url, ...relayBusinessHostOptions(relay.url), credential: "runtime-secret",
      adminToken: "owner-secret", stateDir, sessionsRoot: join(stateDir, "pi-sessions"), reconnect: false, lan: false,
      hermes: { command: { command: "fixture-only", prefixArgs: [] }, connect: connectHermes } });
    await host.start();
    const opened = await host.openPairingWindow();
    device = (await TestDevice.connect({ relayUrl: relay.url, relayHttpBase: relay.url.replace(/^ws/u, "http"),
      qrText: encodePairingQrText(opened.payload), deviceName: "Hermes fixture" })).device;
    const pskRoot = await device.pair(opened.payload);
    const open = () => device!.openChannel("relay", pskRoot, opened.payload.hostId, opened.payload.hostId);
    const next = async (predicate: (row: Record<string, unknown>) => boolean, inspect?: (row: Record<string, unknown>) => void) => {
      for (let i = 0; i < 80; i++) {
        const row = await device!.receiveMessage() as Record<string, unknown>;
        inspect?.(row);
        if (predicate(row)) return row;
      }
      throw new Error("Hermes fixture reply not received");
    };
    const send = (value: Record<string, unknown>) => sendRequest(device!, { protocolVersion: PROTOCOL_VERSION, ...value });
    const lookup = (requestId: string, agentKind: string | null, cursor: string | null = null) => {
      send({ type: "session.catalog.query", requestId, format: "v1", query: { text: "", agentKind, archived: false, provider: "all" }, cursor, limit: 1 });
      return next(row => row.requestId === requestId);
    };
    const declare = (features: string[]) => {
      send({ type: "device.features", features });
      return next(row => row.type === "device.ready");
    };
    await open();
    const legacy = await next(row => row.type === "device.ready");
    expect(legacy.launchableAgents).not.toContain("hermes");
    send({ type: "session.activate", requestId: "blocked", target: { type: "resume", sessionId, agentKind: "hermes" } });
    expect(await next(row => row.requestId === "blocked")).toMatchObject({ type: "protocol.error", code: "agent_feature_required" });
    expect(connectHermes).not.toHaveBeenCalled();

    const hermesOnly = await declare(["agent.hermes"]);
    expect(hermesOnly.launchableAgents).toContain("hermes");
    expect(hermesOnly.agents).not.toContain("hermes");
    expect(hermesOnly).not.toHaveProperty("dshDesktop");
    expect(connectHermes).not.toHaveBeenCalled();
    send({ type: "session.catalog.capabilities.request", requestId: "capabilities" });
    await next(row => row.requestId === "capabilities");
    expect(await lookup("hermes-catalog", "hermes")).toMatchObject({ type: "session.catalog.page", page: { sessions: [{ sessionId, agentKind: "hermes" }] } });
    send({ type: "session.activate", requestId: "resume", target: { type: "resume", sessionId, agentKind: "hermes" } });
    let runtimeId = "";
    expect(await next(row => row.requestId === "resume", row => {
      if (row.type === "runtime.online") runtimeId = (row.runtime as RuntimeMetadata).runtimeId;
    })).toMatchObject({ type: "session.activated", agentKind: "hermes", sessionId, spawnMode: "headless" });
    expect(runtimeId).toMatch(/^hermes:/u);
    expect(connectHermes).toHaveBeenCalledTimes(1);

    send({ type: "runtime.command", runtimeId, commandId: "allowed-send", command: { type: "user_message", text: "fixture prompt" } });
    expect(await next(row => row.type === "runtime.event" && (row.event as RuntimeEvent).type === "command.result")).toMatchObject({
      runtimeId, event: { commandId: "allowed-send", ok: true, status: "success" },
    });

    const both = await declare(["agent.hermes", "agent.dshDesktop"]);
    expect(both.agents).toContain("hermes");
    expect(both).toHaveProperty("dshDesktop", null);
    const dshOnly = await declare(["agent.dshDesktop"]);
    expect(dshOnly.agents).not.toContain("hermes");
    expect(dshOnly.runtimes).not.toContainEqual(expect.objectContaining({ runtimeId }));
    expect(dshOnly).toHaveProperty("dshDesktop", null);
    expect(await lookup("not-visible", null)).toMatchObject({ type: "session.catalog.page", page: { sessions: [], totalSessions: 0 } });
    await declare(["agent.hermes", "agent.dshDesktop"]);
    await open();
    const downgraded = await next(row => row.type === "device.ready");
    expect(downgraded.agents).not.toContain("hermes");
    send({ type: "runtime.command", runtimeId, commandId: "blocked-send", command: { type: "user_message", text: "must not send" } });
    expect(await next(row => row.commandId === "blocked-send")).toMatchObject({ type: "protocol.error", code: "agent_feature_required" });
    expect(request.mock.calls.filter(([method]) => method === "prompt.submit").map(([method, params]) => [method, params])).toEqual([
      ["prompt.submit", { session_id: sessionId, submission_id: "allowed-send", text: "fixture prompt" }],
    ]);
    await host.stop(); host = undefined;
    expect(close).toHaveBeenCalledOnce();
  });

  // A current device declaration remains legal against a pre-Hermes Host; a reconnect receives its normal catalog.
  it.skipIf(!releaseRoot)("preserves current device negotiation and fallback on the released Host and Relay", async () => {
    stateDir = await mkdtemp(join(tmpdir(), "orbis-hermes-fallback-"));
    relay = await startHermesCompatRelay(stateDir);
    const released = await import(pathToFileURL(join(releaseRoot!, "packages/host/dist/host-service.js")).href) as { HostService: typeof HostService };
    const oldHost = await released.HostService.create({ relayUrl: relay.url, credential: "runtime-secret", adminToken: "owner-secret",
      stateDir, sessionsRoot: join(stateDir, "pi-sessions"), reconnect: false, lan: false });
    host = oldHost;
    await oldHost.start();
    const opened = await oldHost.openPairingWindow();
    device = (await TestDevice.connect({ relayUrl: relay.url, relayHttpBase: relay.url.replace(/^ws/u, "http"),
      qrText: encodePairingQrText(opened.payload), deviceName: "Rollback fixture" })).device;
    const pskRoot = await device.pair(opened.payload);
    const next = async (predicate: (row: Record<string, unknown>) => boolean) => {
      for (let i = 0; i < 40; i++) {
        const row = await device!.receiveMessage() as Record<string, unknown>;
        expect(row.type).not.toBe("protocol.error");
        if (predicate(row)) return row;
      }
      throw new Error("Released Host fixture reply not received");
    };
    for (const requestId of ["fallback-one", "fallback-reconnected"]) {
      await device.openChannel("relay", pskRoot, opened.payload.hostId, opened.payload.hostId);
      const ready = await next(row => row.type === "device.ready");
      expect(ready.hostFeatures).toEqual(["device.features"]);
      expect(ready.launchableAgents).not.toContain("hermes");
      sendRequest(device, { type: "device.features", protocolVersion: PROTOCOL_VERSION, features: ["agent.dshDesktop", "agent.hermes"] });
      const negotiated = await next(row => row.type === "device.ready");
      expect(negotiated).toHaveProperty("dshDesktop", null);
      expect(negotiated.launchableAgents).not.toContain("hermes");
      sendRequest(device, { type: "session.list", protocolVersion: PROTOCOL_VERSION, requestId });
      expect(await next(row => row.requestId === requestId)).toMatchObject({ type: "session.list.result", sessions: [] });
    }
  });

  it("reopens a quit DSH browser session over E2E when Codex is also enabled", async () => {
    stateDir = await mkdtemp(join(tmpdir(), "orbis-dsh-reopen-host-"));
    relay = await startRelayLocal(stateDir);
    const codexRequest = vi.fn(async (method: string) => {
      if (method === "thread/resume") throw new Error("Codex cannot resume a DSH session");
      return { data: [] };
    });
    const codex = new CodexRuntime({
      server: { request: codexRequest, notify: vi.fn() } as unknown as CodexAppServer,
      onEvent: () => {}, rolloutRoot: join(stateDir, "codex-sessions"),
    });
    const request = vi.fn(async (method: string) => {
      if (method === "session/list") return { items: [{ sessionId: "browser", cwd: stateDir, agentAvailable: true, running: true }] };
      if (method === "workspace/create") return { workspace: { workspaceId: "workspace" } };
      return {};
    });
    const client: DshWebConnection = {
      onEvent: undefined, onExit: undefined, onReconnect: undefined,
      request: request as DshWebConnection["request"], respondEvent: vi.fn(async () => {}), stop: vi.fn(async () => {}),
      subscribe(method, _args, frame) {
        if (method === "workspace/follow") queueMicrotask(() => frame({ type: "baseline", value: { archivedSessionIds: [] } }));
        return () => {};
      },
    };
    const runtime = new DshRuntime(client);
    host = await HostService.create({ relayUrl: relay.url, ...relayBusinessHostOptions(relay.url), credential: "runtime-secret", adminToken: "owner-secret", stateDir,
      sessionsRoot: join(stateDir, "pi-sessions"), reconnect: false, lan: false, codexRuntime: codex, dshRuntime: runtime });
    try {
      await host.start();
      const ready = await readyDeviceCapturing({ host, relay }); device = ready.device;
      expect(ready.ready).toMatchObject({ agents: ["pi", "codex", "dsh"], runtimes: [expect.objectContaining({ runtimeId: "dsh:browser" })] });
      const until = async (predicate: (message: Record<string, unknown>) => boolean) => {
        for (let i = 0; i < 30; i++) {
          const message = await device!.receiveMessage() as Record<string, unknown>;
          if (message.type === "protocol.error" || predicate(message)) return message;
        }
        throw new Error("Expected DSH reopen response not received");
      };
      sendRequest(device, { type: "runtime.command", protocolVersion: PROTOCOL_VERSION, runtimeId: "dsh:browser", commandId: "quit-dsh",
        command: { type: "slash.execute", name: "quit", args: "" } });
      expect(await until(message => message.type === "runtime.offline")).toMatchObject({ type: "runtime.offline", runtimeId: "dsh:browser" });
      sendRequest(device, { type: "session.activate", protocolVersion: PROTOCOL_VERSION, requestId: "reopen-dsh",
        target: { type: "resume", sessionId: "dsh:browser" }, spawnMode: "tui" });
      expect(await until(message => message.type === "runtime.online")).toMatchObject({ type: "runtime.online", runtime: { runtimeId: "dsh:browser" } });
      expect(await until(message => message.type === "session.activated")).toMatchObject({ type: "session.activated", requestId: "reopen-dsh", agentKind: "dsh", sessionId: "dsh:browser" });
      expect(codexRequest.mock.calls.some(([method]) => method === "thread/resume")).toBe(false);
      sendRequest(device, { type: "runtime.command", protocolVersion: PROTOCOL_VERSION, runtimeId: "dsh:browser", commandId: "reopened-send",
        command: { type: "user_message", text: "after quit", messageId: "reopened-send" } });
      await vi.waitFor(() => expect(request).toHaveBeenCalledWith("session/prompt", { request: expect.objectContaining({ sessionId: "browser", content: [{ type: "text", text: "after quit" }] }) }));
    } finally { await runtime.stop(); }
  });

  it.each([false, true])("advertises automatic session spawn only when enabled (%s)", async preferAutoSessionSpawn => {
    stateDir = await mkdtemp(join(tmpdir(), "orbis-spawn-capability-"));
    relay = await startRelayLocal(stateDir);
    host = await HostService.create({ relayUrl: relay.url, ...relayBusinessHostOptions(relay.url),
      credential: "runtime-secret", adminToken: "owner-secret", stateDir, sessionsRoot: join(stateDir, "sessions"),
      reconnect: false, lan: false, preferAutoSessionSpawn });
    await host.start();
    const result = await readyDeviceCapturing({ host, relay });
    device = result.device;
    const ready = RelayToDeviceMessageSchema.parse(result.ready);
    expect(ready.type).toBe("device.ready");
    if (ready.type !== "device.ready") throw new Error("expected device.ready");
    expect(ready.hostFeatures).toContain("device.features");
    expect(ready.hostFeatures?.includes("session.spawn.auto")).toBe(preferAutoSessionSpawn);
  });

  it("device.ready 带上这台电脑支持的 agent：没启用 Codex 就只有 pi", async () => {
    stateDir = await mkdtemp(join(tmpdir(), "orbis-host-"));
    relay = await startRelayLocal(stateDir);
    host = await HostService.create({
      relayUrl: relay.url, ...relayBusinessHostOptions(relay.url),
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
    stateDir = await mkdtemp(join(tmpdir(), "orbis-host-"));
    relay = await startRelayLocal(stateDir);
    const runtime = new CodexRuntime({
      server: { request: vi.fn(), notify: vi.fn() } as unknown as CodexAppServer,
      onEvent: () => {},
      // 磁盘 rollout 扫描指到不存在的目录：测试不读本机真实的 ~/.codex/sessions。
      rolloutRoot: join(tmpdir(), "orbis-test-no-rollout"),
    });
    host = await HostService.create({
      relayUrl: relay.url, ...relayBusinessHostOptions(relay.url),
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

  it("separates online desktop agents from agents that can be launched on demand", async () => {
    stateDir = await mkdtemp(join(tmpdir(), "orbis-desktop-capabilities-"));
    relay = await startRelayLocal(stateDir);
    const desktop = new CodexRuntime({
      server: {
        mode: "desktop",
        request: vi.fn(async (method: string) => {
          if (["model/list", "skills/list", "mcpServerStatus/list", "thread/loaded/list"].includes(method)) return { data: [] };
          return {};
        }),
        notify: vi.fn(),
        stop: vi.fn(async () => {}),
      } as unknown as CodexAppServer,
      onEvent: () => {},
      rolloutRoot: join(stateDir, "desktop-rollouts"),
    });
    // 桌面接入分档由 Host 下发给手机，且它变了就要主动重播：手机别的地方看不到它。
    let attach: CodexDesktopAttach = { state: "closed", reason: "Codex 桌面版未打开可见窗口" };
    host = await HostService.create({ relayUrl: relay.url, ...relayBusinessHostOptions(relay.url), credential: "runtime-secret", adminToken: "owner-secret", stateDir,
      reconnect: false, lan: false, codexDesktopLaunchable: true, codexDesktopStatus: () => attach });
    await host.start();
    const connected = await readyDeviceCapturing({ host, relay });
    device = connected.device;
    expect(connected.ready).toMatchObject({ agents: ["pi"], launchableAgents: ["pi", "codexDesktop"], codexDesktop: attach });

    const nextReady = async () => {
      for (;;) {
        const message = await connected.device.receiveMessage() as Record<string, unknown>;
        if (message.type === "device.ready") return message;
      }
    };

    // 接入分档与进程目录是两件事：错误分档不会走 attach/detach，所以它需要单独的入口。
    // 手机状态页只读分档，会话列表只读目录，两者必须能各自单独更新。
    attach = { state: "attached", reason: "已接入 Codex 桌面版 app-server" };
    host.announceCodexDesktopStatus();
    expect(await nextReady()).toMatchObject({ type: "device.ready", agents: ["pi"], launchableAgents: ["pi", "codexDesktop"], codexDesktop: attach });
    host.attachCodexDesktopRuntime(desktop);
    expect(await nextReady()).toMatchObject({ type: "device.ready", agents: ["pi", "codexDesktop"], launchableAgents: ["pi", "codexDesktop"], codexDesktop: attach });
    host.detachCodexDesktopRuntime(desktop);
    expect(await nextReady()).toMatchObject({ type: "device.ready", agents: ["pi"], launchableAgents: ["pi", "codexDesktop"], codexDesktop: attach });
    await desktop.stop();
  });

  it("starts a launchable DeepSeek backend only when the App requests a session", async () => {
    stateDir = await mkdtemp(join(tmpdir(), "orbis-dsh-lazy-start-"));
    relay = await startRelayLocal(stateDir);
    const client: DshConnection = {
      onNotification: undefined, onRequest: undefined, onExit: undefined,
      request: vi.fn(async method => method === "session/new" ? { sessionId: "dsh-lazy-thread", configOptions: [] } : { sessions: [] }),
      notify: vi.fn(), stop: vi.fn(async () => {}),
    };
    const runtime = new DshRuntime(client, {
      list: async () => [], read: async id => ({ header: { id, cwd: stateDir!, createdAt: 1 }, events: [] }), close: async () => {},
    });
    const ensureDshRuntime = vi.fn(async () => runtime);
    try {
      host = await HostService.create({ relayUrl: relay.url, ...relayBusinessHostOptions(relay.url), credential: "runtime-secret", adminToken: "owner-secret", stateDir,
        sessionsRoot: join(stateDir, "pi-sessions"), reconnect: false, lan: false, dshLaunchable: true, ensureDshRuntime });
      await host.start();
      const connected = await readyDeviceCapturing({ host, relay }); device = connected.device;
      expect(connected.ready).toMatchObject({ agents: ["pi"], launchableAgents: ["pi", "dsh"] });

      sendRequest(device, { type: "session.activate", protocolVersion: PROTOCOL_VERSION, requestId: "dsh-lazy-new",
        target: { type: "new", agentKind: "dsh", cwd: stateDir } });
      let attachedReady: Record<string, unknown> | undefined;
      const until = async (requestId: string) => {
        for (let i = 0; i < 20; i++) {
          const message = await device!.receiveMessage() as Record<string, unknown>;
          if (message.type === "device.ready" && (message.agents as string[] | undefined)?.includes("dsh")) attachedReady = message;
          if (message.requestId === requestId) return message;
          if (message.type === "protocol.error") throw new Error(`Unexpected protocol error: ${JSON.stringify(message)}`);
        }
        throw new Error(`Expected response ${requestId} not received`);
      };
      expect(await until("dsh-lazy-new")).toMatchObject({ type: "session.activated", agentKind: "dsh", sessionId: "dsh:dsh-lazy-thread" });
      expect(ensureDshRuntime).toHaveBeenCalledTimes(1);
      expect(attachedReady).toMatchObject({ launchableAgents: ["pi", "dsh"] });
    } finally { await runtime.stop(); }
  });

  it.each(["absent", "failed", "ready"])("preserves an App DSH activation racing an %s recovery probe", async outcome => {
    stateDir = await mkdtemp(join(tmpdir(), "orbis-dsh-recovery-activation-"));
    relay = await startRelayLocal(stateDir);
    const request = vi.fn(async (method: string) => method === "session/new"
      ? { sessionId: "recovered-or-new", configOptions: [] } : { sessions: [] });
    const client: DshConnection = { onNotification: undefined, onRequest: undefined, onExit: undefined,
      request, notify: vi.fn(), stop: vi.fn(async () => {}) };
    const runtime = new DshRuntime(client, {
      list: async () => [], read: async id => ({ header: { id, cwd: stateDir!, createdAt: 1 }, events: [] }), close: async () => {},
    });
    let finish!: (value: DshRuntime | undefined) => void;
    let fail!: (error: Error) => void;
    const opening = new Promise<DshRuntime | undefined>((resolve, reject) => { finish = resolve; fail = reject; });
    const recoverDshRuntime = vi.fn(() => opening);
    const ensureDshRuntime = vi.fn(async () => runtime);
    host = await HostService.create({ relayUrl: relay.url, credential: "runtime-secret", adminToken: "owner-secret", stateDir,
      sessionsRoot: join(stateDir, "pi-sessions"), reconnect: false, lan: false, dshLaunchable: true,
      recoverDshRuntime, ensureDshRuntime });
    try {
      await host.start();
      const ready = await readyDeviceCapturing({ host, relay }); device = ready.device;
      expect(recoverDshRuntime).toHaveBeenCalledTimes(1);
      sendRequest(device, { type: "session.activate", protocolVersion: PROTOCOL_VERSION, requestId: "recover-race",
        target: { type: "new", agentKind: "dsh", cwd: stateDir } });
      if (outcome === "failed") fail(new Error("probe authentication failed"));
      else finish(outcome === "ready" ? runtime : undefined);
      let activated: Record<string, unknown> | undefined;
      for (let i = 0; i < 30; i++) {
        const message = await device.receiveMessage() as Record<string, unknown>;
        if (message.requestId === "recover-race") { activated = message; break; }
      }
      expect(activated).toMatchObject({ type: "session.activated", sessionId: "dsh:recovered-or-new" });
      expect(ensureDshRuntime).toHaveBeenCalledTimes(outcome === "ready" ? 0 : 1);
      expect(request.mock.calls.filter(([method]) => method === "session/new")).toHaveLength(1);
    } finally { finish(undefined); await runtime.stop(); }
  });

  it("controls already attached DeepSeek and Codex Desktop runtimes without launching another instance", async () => {
    stateDir = await mkdtemp(join(tmpdir(), "orbis-attached-desktop-agents-"));
    relay = await startRelayLocal(stateDir);
    const dshRequest = vi.fn(async (method: string) => {
      if (method === "session/list") return { sessions: [] };
      if (method === "session/new") return { sessionId: "dsh-already-attached", configOptions: [] };
      throw new Error(`unexpected DSH request: ${method}`);
    });
    const dshClient: DshConnection = {
      onNotification: undefined, onRequest: undefined, onExit: undefined,
      request: dshRequest, notify: vi.fn(), stop: vi.fn(async () => {}),
    };
    const dsh = new DshRuntime(dshClient, {
      list: async () => [], read: async id => ({ header: { id, cwd: stateDir!, createdAt: 1 }, events: [] }), close: async () => {},
    });
    const desktopRequest = vi.fn(async (method: string) => {
      if (method === "thread/loaded/list") return { data: [] };
      if (method === "thread/start") return { thread: { id: "desktop-already-attached", cwd: stateDir, status: { type: "idle" }, turns: [] } };
      if (method === "config/read") return { config: { projects: { [stateDir!]: { trust_level: "trusted" } } } };
      if (["model/list", "thread/list", "thread/turns/list", "skills/list", "mcpServerStatus/list"].includes(method)) return { data: [] };
      throw new Error(`unexpected Codex Desktop RPC: ${method}`);
    });
    const desktop = new CodexRuntime({
      server: { mode: "desktop", request: desktopRequest, notify: vi.fn(), stop: vi.fn(async () => {}) } as unknown as CodexAppServer,
      onEvent: () => {}, rolloutRoot: join(stateDir, "rollouts"),
    });
    const ensureDshRuntime = vi.fn(async () => { throw new Error("must reuse the attached DSH runtime"); });
    const ensureCodexDesktop = vi.fn(async () => { throw new Error("must reuse the attached Codex Desktop runtime"); });
    try {
      host = await HostService.create({ relayUrl: relay.url, ...relayBusinessHostOptions(relay.url), credential: "runtime-secret", adminToken: "owner-secret", stateDir,
        sessionsRoot: join(stateDir, "pi-sessions"), reconnect: false, lan: false,
        dshRuntime: dsh, codexDesktopRuntime: desktop, dshLaunchable: true, codexDesktopLaunchable: true,
        ensureDshRuntime, ensureCodexDesktop });
      await host.start();
      const connected = await readyDeviceCapturing({ host, relay }); device = connected.device;
      expect(connected.ready.agents).toEqual(expect.arrayContaining(["dsh", "codexDesktop"]));

      sendRequest(device, { type: "session.activate", protocolVersion: PROTOCOL_VERSION, requestId: "attached-dsh-new",
        target: { type: "new", agentKind: "dsh", cwd: stateDir } });
      for (let i = 0; i < 30; i++) {
        const message = await device.receiveMessage() as Record<string, unknown>;
        if (message.requestId === "attached-dsh-new") {
          expect(message).toMatchObject({ type: "session.activated", agentKind: "dsh", sessionId: "dsh:dsh-already-attached" });
          break;
        }
        if (i === 29) throw new Error("Expected attached DeepSeek session activation not received");
      }

      sendRequest(device, { type: "session.activate", protocolVersion: PROTOCOL_VERSION, requestId: "attached-desktop-new",
        target: { type: "new", agentKind: "codexDesktop", cwd: stateDir } });
      for (let i = 0; i < 30; i++) {
        const message = await device.receiveMessage() as Record<string, unknown>;
        if (message.requestId === "attached-desktop-new") {
          expect(message).toMatchObject({ type: "session.activated", agentKind: "codexDesktop", sessionId: "codex-desktop:desktop-already-attached" });
          break;
        }
        if (i === 29) throw new Error("Expected attached Codex Desktop session activation not received");
      }

      expect(dshRequest).toHaveBeenCalledWith("session/new", expect.objectContaining({ cwd: stateDir }), expect.any(Number));
      expect(desktopRequest).toHaveBeenCalledWith("thread/start", expect.objectContaining({ cwd: stateDir }));
      expect(ensureDshRuntime).not.toHaveBeenCalled();
      expect(ensureCodexDesktop).not.toHaveBeenCalled();
    } finally {
      await dsh.stop();
      await desktop.stop();
    }
  });

  it("opens a launchable Codex Desktop backend on demand without the terminal Codex backend", async () => {
    stateDir = await mkdtemp(join(tmpdir(), "orbis-codex-desktop-lazy-start-"));
    relay = await startRelayLocal(stateDir);
    const thread = { id: "desktop-lazy", cwd: stateDir, status: { type: "idle" }, turns: [] };
    const request = vi.fn(async (method: string) => {
      if (method === "thread/loaded/list") return { data: [] };
      if (method === "thread/start") return { thread };
      if (method === "thread/read" || method === "thread/resume") return { thread };
      if (["model/list", "thread/list", "thread/turns/list", "skills/list", "mcpServerStatus/list"].includes(method)) return { data: [] };
      if (method === "config/read") return { config: {} };
      throw new Error(`unexpected desktop RPC: ${method}`);
    });
    const desktop = new CodexRuntime({
      server: { mode: "desktop", request, notify: vi.fn(), stop: vi.fn(async () => {}) } as unknown as CodexAppServer,
      onEvent: () => {}, rolloutRoot: join(stateDir, "rollouts"),
    });
    const ensureCodexDesktop = vi.fn(async () => desktop);
    try {
      host = await HostService.create({ relayUrl: relay.url, ...relayBusinessHostOptions(relay.url), credential: "runtime-secret", adminToken: "owner-secret", stateDir,
        sessionsRoot: join(stateDir, "pi-sessions"), reconnect: false, lan: false,
        codexDesktopLaunchable: true, ensureCodexDesktop });
      await host.start();
      const connected = await readyDeviceCapturing({ host, relay }); device = connected.device;
      expect(connected.ready).toMatchObject({ agents: ["pi"], launchableAgents: ["pi", "codexDesktop"] });

      sendRequest(device, { type: "session.activate", protocolVersion: PROTOCOL_VERSION, requestId: "desktop-lazy-new",
        target: { type: "new", agentKind: "codexDesktop", cwd: stateDir } });
      for (let i = 0; i < 30; i++) {
        const message = await device.receiveMessage() as Record<string, unknown>;
        if (message.requestId === "desktop-lazy-new") {
          expect(message).toMatchObject({ type: "session.activated", agentKind: "codexDesktop", sessionId: "codex-desktop:desktop-lazy" });
          break;
        }
        if (i === 29) throw new Error("Expected Codex Desktop session activation not received");
      }
      expect(ensureCodexDesktop).toHaveBeenCalledTimes(1);
      expect(request).toHaveBeenCalledWith("thread/start", expect.objectContaining({ cwd: stateDir }));
    } finally { await desktop.stop(); }
  });

  it("runtime.command 按 runtimeId 路由给 Codex 后端；不支持的命令回 unsupported_command", async () => {
    stateDir = await mkdtemp(join(tmpdir(), "orbis-host-"));
    relay = await startRelayLocal(stateDir);
    const events: RuntimeEvent[] = [];
    const runtime = new CodexRuntime({
      server: { request: vi.fn(), notify: vi.fn() } as unknown as CodexAppServer,
      onEvent: (event) => events.push(event),
      rolloutRoot: join(tmpdir(), "orbis-test-no-rollout"),
    });
    host = await HostService.create({
      relayUrl: relay.url, ...relayBusinessHostOptions(relay.url),
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

    // ADR-0055: idle stop has a deterministic not_cancelable receipt.
    sendRequest(device, {
      type: "runtime.command",
      protocolVersion: PROTOCOL_VERSION,
      runtimeId: "codex",
      commandId: "c2",
      command: { type: "stop" },
    });
    await expect(device.receiveMessage()).resolves.toMatchObject({
      type: "runtime.event", event: { type: "command.result", commandId: "c2", ok: false, status: "not_cancelable" },
    });
  });

  it("slash.execute：未声明的命令回 unsupported_command；已声明但无会话回 command.result 失败", async () => {
    stateDir = await mkdtemp(join(tmpdir(), "orbis-host-"));
    relay = await startRelayLocal(stateDir);
    const runtime = new CodexRuntime({
      server: { request: vi.fn(), notify: vi.fn() } as unknown as CodexAppServer,
      onEvent: () => {},
      rolloutRoot: join(tmpdir(), "orbis-test-no-rollout"),
    });
    host = await HostService.create({
      relayUrl: relay.url, ...relayBusinessHostOptions(relay.url),
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

  // MSG-RENDER-01: exercise the real Codex adapter and encrypted download route, not a loopback Pi impersonating Codex.
  it.each([false, true])("delivers Codex output references with capability %s", async rich => {
    stateDir = await mkdtemp(join(tmpdir(), "orbis-message-render-wire-"));
    relay = await startRelayLocal(stateDir);
    const fileName = "论文问题备选.md";
    await writeFile(join(stateDir, fileName), "# Draft\n");
    const thread = { id: "render-thread", cwd: stateDir, turns: [], status: { type: "idle" } };
    const server = { mode: "owned", request: vi.fn(async (method: string) => {
      if (["thread/start", "thread/read", "thread/resume"].includes(method)) return { thread };
      if (method === "config/read") return { config: {} };
      return { data: [] };
    }), notify: vi.fn(), stop: vi.fn(async () => {}) } as unknown as CodexAppServer;
    const runtime = new CodexRuntime({ server, onEvent: () => {}, rolloutRoot: join(stateDir, "rollouts") });
    host = await HostService.create({ relayUrl: relay.url, ...relayBusinessHostOptions(relay.url), credential: "runtime-secret", adminToken: "owner-secret",
      stateDir, reconnect: false, lan: false, codexRuntime: runtime });
    await host.start(); device = await readyDeviceLocal({ host, relay });
    const next = async (predicate: (message: Record<string, unknown>) => boolean) => {
      for (let i = 0; i < 50; i++) { const message = await device!.receiveMessage(); if (predicate(message)) return message; }
      throw new Error("missing rendering fixture response");
    };
    if (rich) sendRequest(device, { type: "device.features", protocolVersion: PROTOCOL_VERSION, features: [DEVICE_FEATURE_MESSAGE_RENDER] });
    sendRequest(device, { type: "session.activate", protocolVersion: PROTOCOL_VERSION, requestId: "activate-render",
      target: { type: "new", agentKind: "codex", cwd: stateDir } });
    expect(await next(message => message.requestId === "activate-render")).toMatchObject({ type: "session.activated" });
    const notify = server.onNotification!;
    const native = `:codex-file-citation{path="${fileName}" purpose="output"}`;
    const route = { threadId: thread.id, turnId: "turn-render" };
    notify("turn/started", { threadId: thread.id, turn: { id: route.turnId } });
    notify("item/agentMessage/delta", { ...route, itemId: "reply", delta: native.slice(0, 11) });
    const delta = (message: Record<string, unknown>) => (message.event as RuntimeEvent | undefined)?.type === "message.delta";
    expect(await next(delta)).toMatchObject({ event: { delta: "" } });
    notify("item/agentMessage/delta", { ...route, itemId: "reply", delta: native.slice(11) });
    expect(await next(delta)).toMatchObject({ event: { delta: fileName } });
    notify("item/completed", { ...route, item: { type: "agentMessage", id: "reply", text: native } });
    const finish = await next(message => (message.event as RuntimeEvent | undefined)?.type === "message.finished");
    const block = (finish.event as Extract<RuntimeEvent, { type: "message.finished" }>).message.content[0];
    expect(block).toMatchObject(rich ? { type: "render", renderKind: "file_reference", text: fileName } : { type: "text", text: fileName });
    if (block?.type === "render") {
      const referenceId = block.file?.referenceId;
      expect(referenceId).toMatch(/^orbis-message-file:[a-f0-9]{64}$/);
      device.sendCommand(runtime.runtimeIdFor(thread.id), "download-reference", { type: "file.download", path: referenceId });
      const offer = await next(message => {
        const event = message.event as RuntimeEvent | undefined;
        return event?.type === "artifact.started" || event?.type === "command.result" && event.commandId === "download-reference";
      });
      expect(offer).toMatchObject({ event: { type: "artifact.started", artifact: { fileName, path: referenceId, size: 8 } } });
      expect(JSON.stringify(offer)).not.toContain(stateDir);
    }
    const imagePath = join(stateDir, "生成图.png");
    await writeFile(imagePath, "fixture image");
    notify("item/completed", { ...route, item: { id: "generated", type: "imageGeneration", status: "completed", savedPath: imagePath, fileId: "private-native-id" } });
    const image = await next(message => (message.event as RuntimeEvent | undefined)?.type === "message.finished");
    const imageBlock = (image.event as Extract<RuntimeEvent, { type: "message.finished" }>).message.content[0];
    expect(imageBlock).toMatchObject(rich ? { type: "render", renderKind: "file_reference", text: "生成图.png" } : { type: "text", text: "生成图片暂不可显示" });
    expect(JSON.stringify(image)).not.toMatch(/private-native-id/);
    expect(JSON.stringify(image)).not.toContain(imagePath);
    if (imageBlock?.type === "render") {
      const referenceId = imageBlock.file?.referenceId;
      expect(referenceId).toMatch(/^orbis-message-file:[a-f0-9]{64}$/);
      device.sendCommand(runtime.runtimeIdFor(thread.id), "download-image", { type: "file.download", path: referenceId });
      const offer = await next(message => (message.event as RuntimeEvent | undefined)?.type === "artifact.started");
      expect(offer).toMatchObject({ event: { artifact: { fileName: "生成图.png", path: referenceId, size: 13 } } });
    }
  });

  it("rejects malformed and future inputs with their original command identity", async () => {
    stateDir = await mkdtemp(join(tmpdir(), "orbis-host-invalid-input-"));
    relay = await startRelayLocal(stateDir);
    host = await HostService.create({ relayUrl: relay.url, ...relayBusinessHostOptions(relay.url), credential: "runtime-secret", adminToken: "owner-secret", stateDir, reconnect: false, lan: false });
    await host.start(); device = await readyDeviceLocal({ host, relay });
    for (const [commandId, command] of [["future", { type: "future.input" }], ["invalid", { type: "user_message", text: "" }]] as const) {
      sendRequest(device, { type: "runtime.command", protocolVersion: PROTOCOL_VERSION, runtimeId: "offline", commandId, command });
      await expect(device.receiveMessage()).resolves.toMatchObject({ type: "protocol.error", code: "invalid_command", commandId });
    }
  });

  it("session.list 合并 Codex 目录（catalog 失败时降级为纯 Pi 并不炸）", async () => {
    stateDir = await mkdtemp(join(tmpdir(), "orbis-host-"));
    relay = await startRelayLocal(stateDir);
    let currentProvider = "custom";
    const listRequests: unknown[] = [];
    const runtime = new CodexRuntime({
      server: {
        request: vi.fn(async (method: string, params: unknown) => {
          if (method === "config/read") return { config: { model_provider: currentProvider } };
          if (method === "thread/list") {
            listRequests.push(params);
            return {
              data: [{ id: "th-codex-1", modelProvider: "custom", cwd: "D:/codex-repo", preview: "codex 会话", createdAt: 1_782_812_705, updatedAt: 1_782_812_800, turns: [] }],
            };
          }
          throw new Error(`unexpected ${method}`);
        }),
        notify: vi.fn(),
      } as unknown as CodexAppServer,
      onEvent: () => {},
      rolloutRoot: join(tmpdir(), "orbis-test-no-rollout"),
    });
    host = await HostService.create({
      relayUrl: relay.url, ...relayBusinessHostOptions(relay.url),
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
      sessions: [expect.objectContaining({ sessionId: "th-codex-1", agentKind: "codex", modelProvider: "custom" })],
      currentProviders: [{ agentKind: "codex", provider: "custom" }],
    });
    currentProvider = "switched";
    sendRequest(device, { type: "session.list", protocolVersion: PROTOCOL_VERSION, requestId: "r2" });
    await expect(device.receiveMessage()).resolves.toMatchObject({
      currentProviders: [{ agentKind: "codex", provider: "switched" }],
    });
    expect(listRequests).toHaveLength(2);
  });

  it("keeps active sessions visible while marking an unsupported archived catalog incomplete", async () => {
    stateDir = await mkdtemp(join(tmpdir(), "orbis-partial-agent-catalog-"));
    relay = await startRelayLocal(stateDir);
    const client: DshConnection = {
      onNotification: undefined, onRequest: undefined, onExit: undefined,
      request: vi.fn(async () => ({ sessions: [] })), notify: vi.fn(), stop: vi.fn(async () => {}),
    };
    const runtime = new DshRuntime(client, {
      list: async () => [],
      read: async id => ({ header: { id, cwd: stateDir!, createdAt: 1 }, events: [] }),
      close: async () => {},
    });
    Object.defineProperty(runtime, "archivedCatalogSupported", { value: false });
    const catalog = vi.spyOn(runtime, "catalog").mockImplementation(async archived => archived ? [] : [{
      sessionId: "dsh:active", agentKind: "dsh", hostname: "fixture-host", cwd: stateDir!,
      createdAt: 1, modifiedAt: 2, messageCount: 1, archived: false,
    }]);
    host = await HostService.create({ relayUrl: relay.url, ...relayBusinessHostOptions(relay.url), credential: "runtime-secret", adminToken: "owner-secret", stateDir,
      sessionsRoot: join(stateDir, "pi-sessions"), reconnect: false, lan: false, dshRuntime: runtime });
    try {
      await host.start();
      device = await readyDeviceLocal({ host, relay });
      sendRequest(device, { type: "session.list", protocolVersion: PROTOCOL_VERSION, requestId: "partial-catalog-list" });
      await expect(device.receiveMessage()).resolves.toMatchObject({
        type: "session.list.result", sessions: [expect.objectContaining({ sessionId: "dsh:active" })],
      });
      sendRequest(device, { type: "agent.state.request", protocolVersion: PROTOCOL_VERSION, requestId: "partial-catalog-state",
        scope: "host", domains: ["catalog"] });
      const state = await device.receiveMessage() as { domains: AgentStateDomainSnapshot[] };
      const catalogState = state.domains.find(domain => domain.domain === "catalog")?.value as {
        backends: Array<{ kind: string; complete: boolean; error?: string }>;
        sessions: Array<{ sessionId: string }>;
      };
      expect(catalogState.sessions.map(session => session.sessionId)).toContain("dsh:active");
      expect(catalogState.backends.find(backend => backend.kind === "dsh")).toMatchObject({
        complete: false, error: "archived_catalog_unsupported",
      });
      expect(catalog.mock.calls).toEqual([[]]);
    } finally { await runtime.stop(); }
  });

  it("keeps terminal and desktop Codex identities separate over the device protocol", async () => {
    stateDir = await mkdtemp(join(tmpdir(), "orbis-dual-codex-host-"));
    relay = await startRelayLocal(stateDir);
    const entry = (id: string) => ({ id, cwd: "D:/repo", createdAt: 1_780_000_000, updatedAt: 1_780_000_001, turns: [] });
    const terminalRequest = vi.fn(async (method: string, params?: { archived?: boolean }) => {
      if (method === "thread/list") return { data: params?.archived ? [] : [entry("terminal-thread"), entry("desktop-thread")] };
      if (method === "config/read") return { config: {} };
      throw new Error(`unexpected terminal RPC: ${method}`);
    });
    const desktopRequest = vi.fn(async (method: string, params?: { threadId?: string; archived?: boolean }) => {
      if (method === "thread/loaded/list") return { data: ["desktop-thread"] };
      if (method === "thread/list") return { data: params?.archived ? [] : [entry("terminal-thread"), entry("desktop-thread")] };
      if (method === "model/list" || method === "skills/list" || method === "mcpServerStatus/list") return { data: [] };
      if (method === "config/read") return { config: {} };
      if (method === "thread/read" || method === "thread/resume") return {
        thread: { id: params?.threadId, cwd: "D:/repo", status: { type: "idle" }, turns: [] },
      };
      if (method === "thread/unsubscribe") return {};
      throw new Error(`unexpected desktop RPC: ${method}`);
    });
    const terminal = new CodexRuntime({
      server: { mode: "owned", request: terminalRequest, notify: vi.fn() } as unknown as CodexAppServer,
      onEvent: () => {}, rolloutRoot: join(stateDir, "terminal-rollouts"),
    });
    const desktop = new CodexRuntime({
      server: { mode: "desktop", request: desktopRequest, notify: vi.fn(), stop: vi.fn(async () => {}) } as unknown as CodexAppServer,
      onEvent: () => {}, rolloutRoot: join(stateDir, "desktop-rollouts"),
    });
    try {
      host = await HostService.create({ relayUrl: relay.url, ...relayBusinessHostOptions(relay.url), credential: "runtime-secret", adminToken: "owner-secret", stateDir,
        sessionsRoot: join(stateDir, "pi-sessions"), reconnect: false, lan: false,
        codexRuntime: terminal, codexDesktopRuntime: desktop,
        providers: { proxyTakeoverActive: true } as ProviderManager });
      await host.start();
      await vi.waitFor(() => expect(desktop.directoryEntries().map(item => item.runtimeId)).toEqual(["codex-desktop:desktop-thread"]));
      await expect(host.changeProvider("codex", async () => {})).rejects.toThrow("共享后端");
      const connected = await readyDeviceCapturing({ host, relay });
      device = connected.device;
      expect(connected.ready).toMatchObject({ agents: ["pi", "codex", "codexDesktop"] });
      await device.receiveMessage();
      const response = async (requestId: string): Promise<Record<string, unknown>> => {
        for (let i = 0; i < 20; i += 1) {
          const message = await device!.receiveMessage() as Record<string, unknown>;
          if (message.requestId === requestId) return message;
        }
        throw new Error(`no response for ${requestId}`);
      };
      sendRequest(device, { type: "session.list", protocolVersion: PROTOCOL_VERSION, requestId: "dual-list" });
      const listed = await response("dual-list");
      expect(listed.type).toBe("session.list.result");
      expect((listed.sessions as Array<{ sessionId: string; agentKind: string }>).map(item => [item.sessionId, item.agentKind]))
        .toEqual([["terminal-thread", "codex"], ["codex-desktop:desktop-thread", "codexDesktop"]]);

      const terminalResumeCount = terminalRequest.mock.calls.filter(([method]) => method === "thread/resume").length;
      const desktopResumeCount = desktopRequest.mock.calls.filter(([method]) => method === "thread/resume").length;
      sendRequest(device, { type: "session.activate", protocolVersion: PROTOCOL_VERSION, requestId: "dual-resume",
        target: { type: "resume", agentKind: "codexDesktop", sessionId: "codex-desktop:desktop-thread" } });
      expect(await response("dual-resume")).toMatchObject({ type: "session.activated", agentKind: "codexDesktop",
        sessionId: "codex-desktop:desktop-thread", spawnMode: "headless" });
      expect(terminalRequest.mock.calls.filter(([method]) => method === "thread/resume")).toHaveLength(terminalResumeCount);
      expect(desktopRequest.mock.calls.filter(([method]) => method === "thread/resume")).toHaveLength(desktopResumeCount + 1);

      sendRequest(device, { type: "session.activate", protocolVersion: PROTOCOL_VERSION, requestId: "wrong-backend",
        target: { type: "resume", agentKind: "codex", sessionId: "desktop-thread" } });
      expect(await response("wrong-backend")).toMatchObject({ type: "protocol.error", code: "session_not_found" });
      expect(terminalRequest.mock.calls.filter(([method]) => method === "thread/resume")).toHaveLength(terminalResumeCount);
      await host.stop();
      host = undefined;
      expect(JSON.parse(await readFile(join(stateDir, "codex-desktop-threads.json"), "utf8"))).toEqual(["desktop-thread"]);
    } finally {
      await desktop.stop();
    }
  });

  // CODEX-DESKTOP-DRAFT-01: Both mobile launch APIs must keep the empty runtime
  // usable without a native history row, including the first input on that ID.
  it.each((["codex", "codexDesktop"] as const).flatMap(kind => [false, true].map(configured => ({ kind, configured }))))(
    "pre-creates $kind over the device protocol (configured=$configured), syncs and sends on the same thread", async ({ kind, configured }) => {
    stateDir = await mkdtemp(join(tmpdir(), "orbis-desktop-new-home-"));
    relay = await startRelayLocal(stateDir);
    const thread = { id: "desktop-new", cwd: stateDir, status: { type: "idle" }, turns: [] };
    let created = false;
    const request = vi.fn<(method: string, params?: unknown) => Promise<unknown>>(async (method) => {
      if (method === "thread/loaded/list") return { data: created ? [thread.id] : [] };
      if (method === "thread/start") { created = true; return { thread }; }
      if (method === "thread/read" || method === "thread/resume") return { thread };
      if (method === "thread/turns/list") throw new Error(
        `thread ${thread.id} is not materialized yet; thread/turns/list is unavailable before first user message`,
      );
      if (method === "turn/start") return { turn: { id: "first", status: "inProgress" } };
      if (method === "config/read") return { config: {} };
      if (["model/list", "thread/list", "skills/list", "mcpServerStatus/list"].includes(method)) return { data: [] };
      throw new Error(`unexpected Codex RPC: ${method}`);
    });
    const desktop = new CodexRuntime({
      server: { mode: kind === "codexDesktop" ? "desktop" : "owned", request, notify: vi.fn(),
        stop: vi.fn(async () => {}) } as unknown as CodexAppServer,
      onEvent: () => {}, rolloutRoot: join(stateDir, "rollouts"),
    });
    try {
      host = await HostService.create({ relayUrl: relay.url, ...relayBusinessHostOptions(relay.url), credential: "runtime-secret", adminToken: "owner-secret",
        stateDir, sessionsRoot: join(stateDir, "pi-sessions"), reconnect: false, lan: false,
        ...(kind === "codexDesktop" ? { codexDesktopRuntime: desktop } : { codexRuntime: desktop }) });
      await host.start();
      const connected = await readyDeviceCapturing({ host, relay });
      device = connected.device;
      expect(connected.ready).toMatchObject({ runtimes: [] });
      const until = async (predicate: (message: Record<string, unknown>) => boolean): Promise<Record<string, unknown>> => {
        for (let i = 0; i < 40; i += 1) {
          const message = await device!.receiveMessage() as Record<string, unknown>;
          expect(message.type).not.toBe("protocol.error");
          if (predicate(message)) return message;
        }
        throw new Error("missing Codex device response");
      };
      const response = (requestId: string) => until(message => message.requestId === requestId);
      const sessionId = kind === "codexDesktop" ? "codex-desktop:desktop-new" : "desktop-new";
      const runtimeId = desktop.runtimeIdFor(thread.id);
      if (configured) {
        sendRequest(device, { type: "session.configuration.read", protocolVersion: PROTOCOL_VERSION, requestId: "config", agentKind: kind, cwd: thread.cwd });
        const config = await response("config");
        const launch = { type: "session.launch", protocolVersion: PROTOCOL_VERSION, requestId: "launch",
          launchId: "pre-create", agentKind: kind, cwd: thread.cwd, binding: config.binding, revision: config.revision, values: config.values,
          spawnMode: "headless" };
        sendRequest(device, launch);
        expect(await until(message => message.requestId === "launch" && message.phase === "ready")).toMatchObject({ sessionId, agentKind: kind });
        sendRequest(device, { ...launch, requestId: "retry" });
        expect(await response("retry")).toMatchObject({ phase: "ready", sessionId });
      } else {
        sendRequest(device, { type: "session.activate", protocolVersion: PROTOCOL_VERSION, requestId: "desktop-create",
          target: { type: "new", agentKind: kind, cwd: thread.cwd }, spawnMode: "headless" });
        expect(await response("desktop-create")).toMatchObject({ type: "session.activated", agentKind: kind, sessionId });
      }
      expect(request.mock.calls.filter(([method]) => method === "thread/start")).toHaveLength(1);
      expect(request.mock.calls.some(([method]) => method === "turn/start")).toBe(false);
      for (const requestId of ["desktop-first-read", "desktop-retry"]) {
        sendRequest(device, { type: "agent.state.request", protocolVersion: PROTOCOL_VERSION, requestId,
          scope: "agent", runtimeId, sessionId, ...(requestId === "desktop-retry" ? { agentKind: kind } : {}),
          subscribe: true, domains: ["identity", "execution", "interactions"] });
        const domains = new Map<string, Record<string, unknown>>();
        while (domains.size < 3) {
          const message = await response(requestId);
          expect(message.error).toBeUndefined();
          for (const domain of message.domains as Array<Record<string, unknown> & { domain: string }>) domains.set(domain.domain, domain);
        }
        for (const name of ["identity", "execution", "interactions"]) {
          expect(domains.get(name)?.availability, `${kind} ${requestId} ${name}`).toBe("ready");
          expect(domains.get(name)?.projectionComplete).toBe(true);
        }
        expect(domains.get("identity")?.value).toMatchObject({ runtimeId, sessionId, agentKind: kind });
        expect(domains.get("interactions")?.value).toEqual({});
      }
      sendRequest(device, { type: "runtime.command", protocolVersion: PROTOCOL_VERSION, runtimeId, commandId: "sync-empty",
        command: { type: "session.sync", sessionId, syncId: "empty", range: "preview" } });
      expect(await until(message => (message.event as RuntimeEvent | undefined)?.type === "session.snapshot"))
        .toMatchObject({ runtimeId, event: { syncId: "empty", sessionId, entries: [], source: { ready: true } } });
      sendRequest(device, { type: "runtime.command", protocolVersion: PROTOCOL_VERSION, runtimeId, commandId: "first-send",
        command: { type: "user_message", text: "fixture first message", messageId: "phone-1" } });
      expect(await until(message => {
        const event = message.event as RuntimeEvent | undefined;
        return event?.type === "command.result" && event.commandId === "first-send" && event.status !== "pending";
      })).toMatchObject({ runtimeId, event: { type: "command.result", ok: true, status: "success" } });
      expect(request).toHaveBeenCalledWith("turn/start", expect.objectContaining({ threadId: thread.id }));
      expect(request.mock.calls.filter(([method]) => method === "thread/start" || method === "thread/resume").map(([method]) => method))
        .toEqual(["thread/start"]);
    } finally {
      await desktop.stop();
    }
  });

  it("Codex 空壳不进进程目录；会话激活后 runtime.online 如实重播 cwd", async () => {
    process.env.ORBIS_CODEX_HEAD = "0"; // 别在测试机上真开终端窗口
    stateDir = await mkdtemp(join(tmpdir(), "orbis-host-"));
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
          if (method === "thread/turns/list") return { data: [] };
          throw new Error(`unexpected ${method}`);
        }),
        notify: vi.fn(),
      } as unknown as CodexAppServer,
      onEvent: () => {},
      rolloutRoot: join(tmpdir(), "orbis-test-no-rollout"),
    });
    host = await HostService.create({
      relayUrl: relay.url, ...relayBusinessHostOptions(relay.url),
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
    for (let i = 0; i < 8; i += 1) {
      const message = (await codexDevice.receiveMessage()) as Record<string, unknown>;
      types.push(message.type as string);
      if (message.type === "runtime.online") online = message;
      if (message.type === "session.activated") break;
    }
    expect(types.filter(type => type !== "runtime.event")).toEqual(["runtime.online", "session.activated"]);
    expect(online).toMatchObject({
      runtime: { runtimeId: "codex:th-new-1", cwd: "D:/work/demo" },
    });

    sendRequest(codexDevice, {
      type: "runtime.command", protocolVersion: PROTOCOL_VERSION,
      runtimeId: "codex:th-new-1", commandId: "new-thread-sync",
      command: { type: "session.sync", sessionId: "th-new-1", syncId: "empty-preview", range: "preview" },
    });
    let snapshot: Record<string, unknown> | undefined;
    const syncMessages: Record<string, unknown>[] = [];
    let syncAccepted = false;
    for (let i = 0; i < 4; i += 1) {
      const message = await codexDevice.receiveMessage() as Record<string, unknown>;
      syncMessages.push(message);
      expect(message.type, JSON.stringify(message)).not.toBe("protocol.error");
      const event = message.event as Record<string, unknown> | undefined;
      // ctl acceptance can precede msg snapshot on independent QUIC streams.
      // Keep the four business-frame bound; validate the one permitted receipt
      // separately, without treating it as the required snapshot / applied state.
      if (event?.type === "command.result") {
        expect(syncAccepted).toBe(false);
        expect(event).toMatchObject({ commandId: "new-thread-sync", ok: true });
        syncAccepted = true;
        i -= 1;
        continue;
      }
      if (event?.type === "session.snapshot") { snapshot = message; break; }
    }
    expect(snapshot, JSON.stringify(syncMessages)).toMatchObject({
      type: "runtime.event", runtimeId: "codex:th-new-1",
      event: {
        type: "session.snapshot", sessionId: "th-new-1", syncId: "empty-preview",
        entries: [], cursor: { leafId: null }, complete: true, hasOlder: false, rangeStatus: "complete",
      },
    });
    codexDevice.close();
  });

  it("FT-G10 legacy device receives active Codex menu after delayed reconnect bootstrap", async () => {
    process.env.ORBIS_CODEX_HEAD = "0";
    stateDir = await mkdtemp(join(tmpdir(), "orbis-host-"));
    relay = await startRelayLocal(stateDir);
    const runtime = new CodexRuntime({
      server: {
        request: vi.fn(async (method: string) => {
          if (method === "model/list") return { data: [{ id: "gpt-5.5", displayName: "GPT-5.5", isDefault: true }] };
          if (method === "thread/start") return { thread: { id: "th-reann", cwd: "D:/work/demo", turns: [] } };
          if (method === "thread/turns/list") return { data: [] };
          throw new Error(`unexpected ${method}`);
        }),
        notify: vi.fn(),
      } as unknown as CodexAppServer,
      onEvent: () => {},
      rolloutRoot: join(tmpdir(), "orbis-test-no-rollout"),
    });
    host = await HostService.create({
      relayUrl: relay.url, ...relayBusinessHostOptions(relay.url),
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

describe("Claude Code TUI 接线（ADR-0033）", () => {
  let relay: RelayServer | undefined;
  let host: HostService | undefined;
  let device: TestDevice | undefined;
  let stateDir: string | undefined;

  afterEach(async () => {
    device?.close();
    const transportCleanup = await stopRelayBusinessTransports().then(() => undefined, error => error);
    await host?.stop();
    await relay?.close();
    if (stateDir !== undefined) await rm(stateDir, { recursive: true, force: true });
    relay = undefined; host = undefined; device = undefined; stateDir = undefined;
    if (transportCleanup) throw transportCleanup;
  });

  it("captures a turn at authenticated barriers and serves frozen diffs only after an encrypted detail request", async () => {
    stateDir = await mkdtemp(join(tmpdir(), "orbis-review-e2e-"));
    const workspace = join(stateDir, "workspace"), config = join(stateDir, "claude-config");
    await mkdir(workspace); await mkdir(join(config, "projects", "-workspace"), { recursive: true });
    await writeFile(join(workspace, "example.ts"), "preexisting dirty content\n");
    const transcript = join(config, "projects", "-workspace", "review-session.jsonl");
    const user = { type: "user", uuid: "user-1", cwd: workspace, timestamp: "2026-10-30T00:00:00.000Z", message: { role: "user", content: "change the file" } };
    await writeFile(transcript, JSON.stringify(user) + "\n");
    relay = await createRelayServer({ port: 0, runtimeCredentials: ["runtime-secret"], adminToken: "owner-secret", stateFile: join(stateDir, "relay-state.json") });
    host = await HostService.create({ relayUrl: relay.url, ...relayBusinessHostOptions(relay.url), credential: "runtime-secret", adminToken: "owner-secret", stateDir,
      sessionsRoot: join(stateDir, "pi-sessions"), reconnect: false, lan: false });
    await host.start();
    const opened = await host.openPairingWindow();
    device = (await TestDevice.connect({ relayUrl: relay.url, relayHttpBase: relay.url.replace(/^ws/u, "http"),
      qrText: encodePairingQrText(opened.payload), deviceName: "Review fixture" })).device;
    const psk = await device.pair(opened.payload);
    await device.openChannel("relay", psk, opened.payload.hostId, opened.payload.hostId);
    const received: Record<string, unknown>[] = [];
    const until = async (predicate: (message: Record<string, unknown>) => boolean) => {
      for (let i = 0; i < 200; i++) { const message = await device!.receiveMessage() as Record<string, unknown>;
        received.push(message); if (predicate(message)) return message; }
      throw new Error("Missing expected review event");
    };
    await until(message => message.type === "device.ready");
    const descriptor = JSON.parse(await readFile(join(stateDir, "loopback.json"), "utf8")) as { url: string; token: string };
    const post = async (path: string, body: unknown) => (await fetch(descriptor.url.replace(/^ws/u, "http") + path,
      { method: "POST", headers: { authorization: `Bearer ${descriptor.token}`, "content-type": "application/json" }, body: JSON.stringify(body) })).json() as Promise<Record<string, unknown>>;
    const hello = await post("/v1/claude/mods/hello", { type: "hello", instanceId: "review-instance", sessionId: "review-session",
      cwd: workspace, configDir: config, claudeVersion: "2.1.312", bridgeVersion: "4", interactive: true,
      capabilities: ["prompt.submit", "turn.abort", "session.append", "turn.start", "turn.complete", "turn.step.delta", "tool.call", "turn.step.identity", "agent.list"] });
    const runtimeId = "claude:review-session", agent = { hostId: opened.payload.hostId, agentKind: "claude", sessionId: "review-session" };
    await until(message => message.type === "runtime.online" && (message.runtime as RuntimeMetadata).runtimeId === runtimeId);
    const emit = (event: unknown) => post("/v1/claude/mods/event", { runtimeId, generation: hello.generation, event });
    const command = (requestId: string, body: unknown) => device!.sendPayload(Buffer.from(JSON.stringify({ type: "runtime.command",
      protocolVersion: PROTOCOL_VERSION, runtimeId, commandId: requestId, command: body })));
    command("list", { type: "session.changes.list", requestId: "list", runtimeId, agent, entryIds: [], turnIds: ["turn-review"], cursor: null });
    await until(message => (message.event as RuntimeEvent | undefined)?.type === "session.changes.summaries");
    expect(await emit({ type: "turn.start", turnId: "turn-review", startedAt: Date.now() })).toEqual({ result: "accepted" });
    await writeFile(join(workspace, "example.ts"), "this turn only\n");
    const answer = { type: "assistant", uuid: "answer-1", parentUuid: "user-1", timestamp: "2026-10-30T00:00:01.000Z",
      message: { role: "assistant", content: [{ type: "text", text: "done" }] } };
    await writeFile(transcript, JSON.stringify(user) + "\n" + JSON.stringify(answer) + "\n");
    await emit({ type: "session.append", uuid: "answer-1", door: "assistant" });
    expect(await emit({ type: "turn.complete", turnId: "turn-review", durationMs: 10 })).toEqual({ result: "accepted" });
    const ready = await until(message => { const event = message.event as RuntimeEvent | undefined;
      return event?.type === "session.changes.updated" && event.summary.state === "ready" && event.summary.anchorEntryId === "answer-1"; });
    const summary = (ready.event as Extract<RuntimeEvent, { type: "session.changes.updated" }>).summary;
    expect(summary).toMatchObject({ fileCount: 1, additions: 1, deletions: 1, coverage: "complete", anchorEntryId: "answer-1" });
    expect(JSON.stringify(ready)).not.toContain("this turn only");
    expect(received.some(message => (message.event as RuntimeEvent | undefined)?.type === "session.change.detail.page")).toBe(false);
    await writeFile(join(workspace, "example.ts"), "later edit must not leak into old turn\n");
    const file = summary.preview[0]!;
    command("detail", { type: "session.change.detail.read", requestId: "detail", runtimeId, agent,
      changeSetId: summary.changeSetId, manifestVersion: summary.manifestVersion, fileId: file.fileId,
      contentVersion: file.contentVersion, viewerId: "viewer", readId: null, cursor: null, maxBytes: 49152 });
    const page = (await until(message => (message.event as RuntimeEvent | undefined)?.type === "session.change.detail.page")).event as Extract<RuntimeEvent, { type: "session.change.detail.page" }>;
    expect(page.text).toContain("-preexisting dirty content"); expect(page.text).toContain("+this turn only");
    expect(page.text).not.toContain("later edit"); expect(page.eof).toBe(true);
  });

  // A preflight failure is final before opening. Even an old plugin reusing its
  // launch token after /clear must only recover the durably reserved native UUID.
  it.each([false, true])("settles Claude preflight failure and recovers a late configured launch without reopening (restart=%s)", async restart => {
    const { ClaudeStartupBlocked } = await import("./claude-startup.js");
    stateDir = await mkdtemp(join(tmpdir(), "orbis-claude-recovery-"));
    relay = await createRelayServer({ port: 0, runtimeCredentials: ["runtime-secret"], adminToken: "owner-secret", stateFile: join(stateDir, "relay.json") });
    let prepared = false;
    let expectedSessionId: string | undefined;
    const launchNative = vi.fn(async (request: import("./claude-launcher.js").ClaudeLaunchRequest) => {
      expectedSessionId = request.sessionId;
      throw prepared ? new Error("synthetic bridge timeout") : new ClaudeStartupBlocked("native login required");
    });
    const createHost = () => HostService.create({ relayUrl: relay!.url, ...relayBusinessHostOptions(relay!.url), credential: "runtime-secret", adminToken: "owner-secret",
      stateDir: stateDir!, sessionsRoot: join(stateDir!, "pi"), reconnect: false, lan: false,
      claude: { configDir: join(stateDir!, "claude"), launcher: { unavailable: async () => undefined, launch: launchNative,
        sessionConfiguration: async () => ({ binding: "fixture", defaults: {}, models: [], permissions: [] }) } } });
    host = await createHost();
    await host.start();
    const opened = await host.openPairingWindow();
    device = (await TestDevice.connect({ relayUrl: relay.url, relayHttpBase: relay.url.replace(/^ws/u, "http"),
      qrText: encodePairingQrText(opened.payload), deviceName: "Recovery fixture" })).device;
    const psk = await device.pair(opened.payload);
    await device.openChannel("relay", psk, opened.payload.hostId, opened.payload.hostId);
    const sendRequest = (target: TestDevice, payload: unknown) => target.sendPayload(Buffer.from(JSON.stringify(payload)));
    const response = async (id: string, phase: string) => {
      for (let i = 0; i < 80; i++) {
        const item = await device!.receiveMessage() as Record<string, unknown>;
        if (item.requestId === id && item.type === "protocol.error") throw new Error(JSON.stringify(item));
        if (item.requestId === id && item.phase === phase) return item;
      }
      throw new Error(`missing ${id}/${phase}`);
    };
    while ((await device.receiveMessage() as Record<string, unknown>).type !== "device.ready") { /* handshake */ }
    const request = { type: "session.launch", protocolVersion: PROTOCOL_VERSION, agentKind: "claude", cwd: stateDir,
      binding: "fixture", revision: 0, values: {}, spawnMode: "tui" };
    sendRequest(device, { ...request, requestId: "preflight", launchId: "preflight" });
    expect(await response("preflight", "failed")).toMatchObject({ error: "native login required" });
    prepared = true;
    sendRequest(device, { ...request, requestId: "late", launchId: "late" });
    await response("late", "unknown");
    let descriptor = JSON.parse(await readFile(join(stateDir, "loopback.json"), "utf8"));
    expect(expectedSessionId).toMatch(/^[0-9a-f-]{36}$/u);
    const hello = async (sessionId: string) => {
      const result = await fetch(descriptor.url.replace(/^ws/u, "http") + "/v1/claude/mods/hello", { method: "POST",
        headers: { authorization: `Bearer ${descriptor.token}`, "content-type": "application/json" },
        body: JSON.stringify({ type: "hello", instanceId: "late-tui", sessionId, launchId: "late", cwd: stateDir,
          claudeVersion: "2.1.322", bridgeVersion: "4", interactive: true,
          capabilities: ["prompt.submit", "turn.abort", "session.append", "turn.start", "turn.complete", "turn.step.delta", "tool.call", "turn.step.identity", "agent.list"] }) });
      expect(await result.json()).toMatchObject({ ok: true });
    };
    await hello(expectedSessionId!);
    await hello("another-session");
    if (restart) {
      await host.stop();
      host = await createHost();
      await host.start();
      await device.openChannel("relay", psk, opened.payload.hostId, opened.payload.hostId);
      while ((await device.receiveMessage() as Record<string, unknown>).type !== "device.ready") { /* new Host generation */ }
      descriptor = JSON.parse(await readFile(join(stateDir, "loopback.json"), "utf8"));
      await hello("another-session");
    }
    sendRequest(device, { type: "session.launch.read", protocolVersion: PROTOCOL_VERSION, requestId: "switched", launchId: "late" });
    expect((await response("switched", "unknown")).sessionId).toBeUndefined();
    expect(launchNative).toHaveBeenCalledTimes(2);
    await hello(expectedSessionId!);
    await hello(expectedSessionId!);
    sendRequest(device, { type: "session.launch.read", protocolVersion: PROTOCOL_VERSION, requestId: "check", launchId: "late" });
    expect(await response("check", "ready")).toMatchObject({ sessionId: expectedSessionId });
    expect(launchNative).toHaveBeenCalledTimes(2);
  });

  it("carries a Claude TUI's directory, slash menu, commands and tool activity over the encrypted device channel", async () => {
    stateDir = await mkdtemp(join(tmpdir(), "orbis-claude-host-"));
    const config = join(stateDir, "claude-config");
    await mkdir(join(config, "projects", "-repo"), { recursive: true });
    await writeFile(join(config, "projects", "-repo", "saved-session.jsonl"), [
      { type: "user", uuid: "u", cwd: stateDir, timestamp: "2026-10-01T00:00:00.000Z", message: { content: "earlier work" } },
      { type: "ai-title", aiTitle: "Earlier" },
    ].map(row => JSON.stringify(row)).join("\n") + "\n");
    relay = await createRelayServer({ port: 0, runtimeCredentials: ["runtime-secret"], adminToken: "owner-secret", stateFile: join(stateDir, "relay-state.json") });
    const launches: unknown[] = [];
    host = await HostService.create({ relayUrl: relay.url, ...relayBusinessHostOptions(relay.url), credential: "runtime-secret", adminToken: "owner-secret", stateDir,
      sessionsRoot: join(stateDir, "pi-sessions"), reconnect: false, lan: false,
      claude: { configDir: config, launcher: { unavailable: async () => undefined, launch: async request => { launches.push(request); } } } });
    await host.start();
    const opened = await host.openPairingWindow();
    const connected = await TestDevice.connect({ relayUrl: relay.url, relayHttpBase: relay.url.replace(/^ws/u, "http"),
      qrText: encodePairingQrText(opened.payload), deviceName: "Pixel 9" });
    device = connected.device;
    const pskRoot = await device.pair(opened.payload);
    await device.openChannel("relay", pskRoot, opened.payload.hostId, opened.payload.hostId);
    const until = async (predicate: (message: Record<string, unknown>) => boolean, label: string) => {
      for (let i = 0; i < 80; i++) {
        const message = await device!.receiveMessage().catch((error: unknown) => { throw new Error(`Waiting for ${label}`, { cause: error }); }) as Record<string, unknown>;
        if (predicate(message)) return message;
      }
      throw new Error(`Expected ${label}`);
    };
    const ready = await until(message => message.type === "device.ready" && (message.launchableAgents as string[] | undefined)?.includes("claude") === true, "claude launchable");
    expect(ready.agents).toContain("claude");

    device.sendPayload(Buffer.from(JSON.stringify({ type: "session.list", protocolVersion: PROTOCOL_VERSION, requestId: "list-1" })));
    const listed = await until(message => message.type === "session.list.result", "session.list.result");
    expect(listed.sessions).toContainEqual(expect.objectContaining({ sessionId: "saved-session", agentKind: "claude", name: "Earlier", firstMessage: "earlier work" }));

    const descriptor = JSON.parse(await readFile(join(stateDir, "loopback.json"), "utf8")) as { url: string; token: string };
    const post = async (path: string, body: unknown) => {
      const response = await fetch(`${descriptor.url.replace(/^ws/u, "http")}${path}`, { method: "POST",
        headers: { authorization: `Bearer ${descriptor.token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
      return await response.json() as Record<string, unknown>;
    };
    const hello = await post("/v1/claude/mods/hello", { type: "hello", instanceId: "tui-1", sessionId: "live-session", cwd: stateDir,
      claudeVersion: "2.1.312", bridgeVersion: "4", interactive: true, configDir: config,
      capabilities: ["prompt.submit", "turn.abort", "session.append", "turn.start", "turn.complete", "turn.step.delta", "tool.call", "turn.step.identity", "agent.list"] });
    expect(hello).toMatchObject({ ok: true, runtimeId: "claude:live-session" });
    const generation = hello.generation as string;
    expect(await until(message => message.type === "runtime.online" && (message.runtime as RuntimeMetadata).runtimeId === "claude:live-session", "runtime.online"))
      .toMatchObject({ runtime: { sessionGraphSync: true } });
    const event = (body: unknown) => post("/v1/claude/mods/event", { runtimeId: "claude:live-session", generation, event: body });

    // Home must be ready before any chat/history sync, including an explicitly empty interaction list.
    device.sendPayload(Buffer.from(JSON.stringify({ type: "agent.state.request", protocolVersion: PROTOCOL_VERSION,
      requestId: "claude-home", scope: "agent", runtimeId: "claude:live-session", sessionId: "live-session", agentKind: "claude",
      subscribe: true, domains: ["identity", "execution", "interactions"] })));
    const homeDomains: Record<string, unknown>[] = [];
    while (homeDomains.length < 3) {
      const part = await until(message => message.type === "agent.state.snapshot" && message.requestId === "claude-home", "Claude home baseline");
      expect(part.missing).toEqual([]);
      homeDomains.push(...part.domains as Record<string, unknown>[]);
    }
    for (const domain of homeDomains) expect(domain).toMatchObject({ availability: "ready", completeness: "complete" });
    expect(homeDomains.find(domain => domain.domain === "interactions")?.value).toEqual({});

    expect(await event({ type: "session.state", state: { model: "claude-opus-5-5", modelName: "Opus 5.5", modelOptions: ["sonnet", "opus"],
      context: { tokens: 1000, window: 200000, percent: 0.5 }, commands: [{ name: "compact", description: "Free up context", source: "builtin" }] } }))
      .toEqual({ result: "accepted" });
    const capabilities = await until(message => message.runtimeId === "claude:live-session" &&
      (message.event as RuntimeEvent | undefined)?.type === "runtime.capabilities", "runtime.capabilities");
    expect((capabilities.event as Extract<RuntimeEvent, { type: "runtime.capabilities" }>).capabilities.commands.map(command => command.name))
      .toEqual(["model", "effort", "compact"]);

    device.sendPayload(Buffer.from(JSON.stringify({ type: "runtime.command", protocolVersion: PROTOCOL_VERSION, runtimeId: "claude:live-session",
      commandId: "slash-1", command: { type: "slash.execute", name: "compact", args: "" } })));
    await vi.waitFor(async () => expect(await post("/v1/claude/mods/poll", { runtimeId: "claude:live-session", generation }))
      .toMatchObject({ ok: true, commands: [{ commandId: "slash-1", command: { type: "slash", name: "compact", args: "" } }] }));

    device.sendPayload(Buffer.from(JSON.stringify({ type: "runtime.command", protocolVersion: PROTOCOL_VERSION, runtimeId: "claude:live-session",
      commandId: "sync-1", command: { type: "session.sync", sessionId: "live-session", syncId: "sync-1", range: "preview" } })));
    expect(await until(message => (message.event as RuntimeEvent | undefined)?.type === "session.snapshot", "session.snapshot"))
      .toMatchObject({ runtimeId: "claude:live-session", event: { sessionId: "live-session", syncId: "sync-1" } });
    await event({ type: "turn.start", turnId: "turn-1", startedAt: Date.now() });
    await event({ type: "tool.started", toolCallId: "toolu_1", toolName: "Bash", arguments: { command: "ls -la", description: "List" } });
    // ADR-0045: the patch only references the tool inventory; the phone pages summaries and reads bodies on demand.
    const patch = await until(message => message.runtimeId === "claude:live-session" && (message.event as RuntimeEvent | undefined)?.type === "session.patch" &&
      (message.event as Extract<RuntimeEvent, { type: "session.patch" }>).live?.toolInventory !== undefined, "tool inventory patch");
    const reference = (patch.event as Extract<RuntimeEvent, { type: "session.patch" }>).live!.toolInventory!;
    expect(reference).toMatchObject({ agent: { agentKind: "claude", sessionId: "live-session" }, totalCount: 1 });
    const send = (command: unknown) => device!.sendPayload(Buffer.from(JSON.stringify({ type: "runtime.command", protocolVersion: PROTOCOL_VERSION,
      runtimeId: "claude:live-session", commandId: "tools", command })));
    send({ type: "session.tools.open", requestId: "open", runtimeId: "claude:live-session", reference });
    const inventory = await until(message => (message.event as RuntimeEvent | undefined)?.type === "session.tools.opened", "tools opened");
    send({ type: "session.tools.read", requestId: "page", runtimeId: "claude:live-session",
      snapshot: (inventory.event as { snapshot: ToolInventorySnapshot }).snapshot, cursor: null, maxItems: 16 });
    const page = (await until(message => (message.event as RuntimeEvent | undefined)?.type === "session.tools.page", "tools page"))
      .event as Extract<RuntimeEvent, { type: "session.tools.page" }>;
    expect(page.tools).toEqual([expect.objectContaining({ toolName: "Bash", inputSummary: expect.objectContaining({ text: "ls -la" }), phase: "started" })]);
    send({ type: "session.tool.content.read", requestId: "args", runtimeId: "claude:live-session", viewerId: "v",
      locator: { projectionVersion: 1, tool: { agent: reference.agent, toolCallId: "toolu_1" }, part: "arguments" }, read: null, offset: 0, maxBytes: 16_384 });
    const content = await until(message => (message.event as RuntimeEvent | undefined)?.type === "session.tool.content.page", "tool content");
    expect(JSON.stringify(content.event)).toContain("ls -la");
    expect(host.readDiagnostics({ category: "recovery" }).records.filter(record => record.message.includes("Rejected conversation"))).toEqual([]);

    // A Hook shares the Mods runtime: its waiting status must not erase history capability.
    const hookReply = post("/v1/claude/hook", { hook_event_name: "PermissionRequest", session_id: "live-session",
      cwd: stateDir, tool_name: "Bash", tool_input: { command: "fixture-only" } });
    const waiting = await until(message => message.runtimeId === "claude:live-session" &&
      (message.event as RuntimeEvent | undefined)?.type === "runtime.metadata" &&
      (message.event as Extract<RuntimeEvent, { type: "runtime.metadata" }>).metadata.status === "waiting_local_interaction", "hook metadata");
    await event({ type: "interactions.local" });
    await hookReply;
    expect(waiting).toMatchObject({ event: { metadata: { sessionGraphSync: true } } });


    // A refused bridge leaves a diagnostic instead of failing silently.
    expect(await post("/v1/claude/mods/hello", { type: "hello", instanceId: "old", sessionId: "old-session", cwd: stateDir,
      claudeVersion: "2.1.100", bridgeVersion: "4", interactive: true, capabilities: [] })).toMatchObject({ ok: false, error: "claude_version_too_old:2.1.287" });
    expect(host.readDiagnostics({ category: "backend.transport" }).records).toContainEqual(expect.objectContaining({ agentKind: "claude",
      message: "Claude Code bridge refused", detail: expect.objectContaining({ reason: "claude_version_too_old:2.1.287", claudeVersion: "2.1.100" }) }));
    expect(launches).toEqual([]);
  });
});

// SC113: real isolated pairing/AEAD/Relay traffic; only HTTPS wake is captured.
describe("APNS-L18/L19 per-phone push routing", () => {
  let relay: RelayServer;
  let host: HostService;
  let runtime: TestRuntime;
  let directory: string;
  const phones: TestDevice[] = [];
  const logs: string[] = [];
  const setup = async () => {
    directory = await mkdtemp(join(tmpdir(), "orbis-push-audit-"));
    relay = await createRelayServer({ port: 0, runtimeCredentials: ["runtime-secret"], adminToken: "owner-secret" });
    host = await HostService.create({ relayUrl: relay.url, credential: "runtime-secret", adminToken: "owner-secret",
      stateDir: directory, reconnect: false, relayTransport: "ws", lan: false, probeIntervalMs: 20, log: line => logs.push(line) });
    await host.start();
  };
  const pair = async () => {
    const opened = await host.openPairingWindow();
    const connected = await TestDevice.connect({ relayUrl: relay.url, relayHttpBase: relay.url.replace(/^ws/u, "http"),
      qrText: encodePairingQrText(opened.payload), deviceName: "synthetic phone" });
    phones.push(connected.device);
    const pskRoot = await connected.device.pair(connected.payload);
    return { device: connected.device, pskRoot, payload: opened.payload };
  };
  const until = async (phone: TestDevice, predicate: (message: any) => boolean) => {
    for (let index = 0; index < 100; index++) {
      const message = await phone.receiveMessage();
      if (predicate(message)) return message;
    }
    throw new Error("Expected FIFO barrier did not arrive");
  };
  const open = async (paired: { device: TestDevice; pskRoot: Buffer; payload: PairingQrPayload }) => {
    await paired.device.openChannel("relay", paired.pskRoot, paired.payload.hostId, paired.payload.hostId);
    await until(paired.device, message => message.type === "device.path");
  };
  const backend = async (runtimeId = "runtime") => {
    const descriptor = host.loopback!.descriptor!;
    runtime = await TestRuntime.connect({ url: descriptor.url, token: descriptor.token,
      metadata: { runtimeId, sessionId: "session", name: "Synthetic Pi", cwd: directory, status: "idle" } });
    await runtime.next();
  };
  const captureWake = () => {
    vi.spyOn(pushRelayConfig, "relayHttpBase").mockReturnValue("https://push-audit.invalid");
    return vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));
  };
  afterEach(async () => {
    vi.restoreAllMocks();
    runtime?.close(); phones.splice(0).forEach(phone => phone.close());
    await host?.stop(); await relay?.close();
    if (directory) await rm(directory, { recursive: true, force: true });
    runtime = undefined!; logs.length = 0;
  });

  it("does not send OpenCode APNs wake requests to devices without its handshake feature", async () => {
    await setup();
    const legacy = await pair(); await open(legacy);
    const aware = await pair(); await open(aware);
    aware.device.sendData(JSON.stringify({ type: "device.features", protocolVersion: PROTOCOL_VERSION, features: ["agent.opencode"] }));
    await until(aware.device, message => message.type === "device.ready");
    aware.device.sendData(JSON.stringify({ type: "session.history.capabilities.request", protocolVersion: PROTOCOL_VERSION, requestId: "history-enabled" }));
    await until(aware.device, message => message.requestId === "history-enabled");
    aware.device.sendData(JSON.stringify({ type: "session.history.interest", protocolVersion: PROTOCOL_VERSION,
      requestId: "not-viewing", runtimeId: null, sessionId: null }));
    expect(await until(aware.device, message => message.requestId === "not-viewing")).toMatchObject({ accepted: true });
    const runtimeId = "opencode:synthetic-opencode";
    await backend(runtimeId);
    await until(aware.device, message => message.type === "runtime.online");
    const wake = captureWake();
    runtime.publish(1, { type: "interaction.requested", request: { runtimeId, requestId: "approval-opencode",
      extensionId: "opencode.permission", kind: "confirm", title: "Continue?", expiresAt: Date.now() + 60_000 } });
    await vi.waitFor(() => expect(wake).toHaveBeenCalledTimes(1));
    expect(JSON.parse(wake.mock.calls[0]![1]!.body as string)).toMatchObject({ category: "approval-requested", deviceIds: [aware.device.deviceId] });
  });

  it("wakes both a disconnected retained session and a never-connected phone", async () => {
    await setup();
    const disconnected = await pair(); await open(disconnected);
    const control = await pair();
    await backend();
    await until(disconnected.device, message => message.type === "runtime.online");
    const wake = captureWake();
    disconnected.device.closePath("relay");
    await vi.waitFor(() => expect(logs.some(line => line.includes(`设备 ${disconnected.device.deviceId} 不在中继上`))).toBe(true));
    expect(host.activePathOf(disconnected.device.deviceId)).toBe("relay");
    runtime.publish(1, { type: "interaction.requested", request: { runtimeId: "runtime", requestId: "approval-offline",
      extensionId: "ask", kind: "confirm", title: "Continue?", expiresAt: Date.now() + 60_000 } });
    await vi.waitFor(() => expect(wake).toHaveBeenCalledTimes(1));
    const body = JSON.parse(wake.mock.calls[0]![1]!.body as string);
    expect(body.category).toBe("approval-requested");
    expect(body.deviceIds.sort()).toEqual([control.device.deviceId, disconnected.device.deviceId].sort());
  });

  it("wakes the phone viewing another Host without resuming its hidden chat stream", async () => {
    await setup();
    const online = await pair(); await open(online);
    const control = await pair();
    const viewing = await pair(); await open(viewing);
    await backend();
    await until(online.device, message => message.type === "runtime.online");
    online.device.sendData(JSON.stringify({ type: "session.history.capabilities.request", protocolVersion: PROTOCOL_VERSION, requestId: "capability" }));
    await until(online.device, message => message.requestId === "capability");
    viewing.device.sendData(JSON.stringify({ type: "session.history.capabilities.request", protocolVersion: PROTOCOL_VERSION, requestId: "viewer-capability" }));
    await until(viewing.device, message => message.requestId === "viewer-capability");
    viewing.device.sendData(JSON.stringify({ type: "session.history.interest", protocolVersion: PROTOCOL_VERSION,
      requestId: "viewing", runtimeId: "runtime", sessionId: "session" }));
    expect(await until(viewing.device, message => message.requestId === "viewing")).toMatchObject({ accepted: true });
    const fixture = JSON.parse(await readFile(new URL("../../../ios/Orbis/Tests/Fixtures/field-transport-session.json", import.meta.url), "utf8"));
    fixture.initial.event.live.turn = { turnId: "completed-hidden", startedAt: 1000 };
    // Publish a real accepted baseline through the sync coordinator first.
    online.device.sendCommand("runtime", "sync", { type: "session.sync", sessionId: "session", syncId: "sync", range: "preview" });
    let request: any;
    do { request = await runtime.next(2000); } while (request.type !== "runtime.command");
    runtime.publish(1, { ...fixture.initial.event, syncId: request.command.syncId });
    await until(online.device, message => message.event?.type === "session.snapshot");
    // Seed the running turn before simulating navigation away from this Host.
    online.device.sendData(JSON.stringify({ type: "session.history.interest", protocolVersion: PROTOCOL_VERSION,
      requestId: "hidden", runtimeId: null, sessionId: null }));
    expect(await until(online.device, message => message.requestId === "hidden")).toMatchObject({ accepted: true });
    const wake = captureWake();
    const patch = structuredClone(fixture.patch.event);
    patch.live.turn = { turnId: "completed-hidden", startedAt: 1000, durationMs: 100, outcome: "completed" };
    runtime.publish(2, patch);
    await vi.waitFor(() => expect(wake).toHaveBeenCalledTimes(1));
    const body = JSON.parse(wake.mock.calls[0]![1]!.body as string);
    expect(body.category).toBe("task-completed");
    expect(body.deviceIds).not.toContain(viewing.device.deviceId);
    expect(body.deviceIds.sort()).toEqual([control.device.deviceId, online.device.deviceId].sort());
    online.device.sendCommand("runtime", "barrier", { type: "stop" });
    expect(await runtime.next()).toMatchObject({ commandId: "barrier" });
    runtime.publish(3, { type: "command.result", commandId: "barrier", ok: true });
    for (;;) {
      const message: any = await online.device.receiveMessage();
      expect(message.event?.type).not.toBe("session.patch");
      if (message.event?.commandId === "barrier") break;
    }
    // RTT announcements may arrive every 20ms. Observe a fixed time window;
    // waiting for an idle interval would make this audit hang on a healthy link.
    const deadline = Date.now() + 200;
    while (Date.now() < deadline) {
      const incoming = await online.device.nextIncoming(Math.max(1, deadline - Date.now())).catch(() => undefined);
      if (!incoming) break;
      if ("payload" in incoming) expect(JSON.parse(incoming.payload.toString()).event?.type).not.toBe("session.patch");
    }
  });

  // The same Host decides separately for each pairing; a legacy subscriber
  // receives the edge over E2E, even while the other phone needs APNs.
  it("keeps reachable legacy subscribers on E2E and deduplicates approval edges", async () => {
    await setup();
    const online = await pair(); await open(online);
    const offline = await pair(); await backend();
    await until(online.device, message => message.type === "runtime.online");
    const wake = captureWake();
    const event = { type: "interaction.requested" as const, request: { runtimeId: "runtime", requestId: "same-request",
      extensionId: "ask", kind: "confirm" as const, title: "Continue?", expiresAt: Date.now() + 60_000 } };
    runtime.publish(1, event);
    await vi.waitFor(() => expect(wake).toHaveBeenCalledTimes(1));
    expect(JSON.parse(wake.mock.calls[0]![1]!.body as string).deviceIds).toEqual([offline.device.deviceId]);
    runtime.publish(2, event);
    online.device.sendCommand("runtime", "replay-barrier", { type: "stop" });
    expect(await runtime.next()).toMatchObject({ commandId: "replay-barrier" });
    expect(wake).toHaveBeenCalledTimes(1);
  });

  // No periodic probe has observed device_offline yet: the event's own bounded
  // probe must discover loss without destroying the retained E2E session.
  it("falls back when completion delivery races the first offline report", async () => {
    await setup();
    const phone = await pair(); await open(phone); await backend();
    await until(phone.device, message => message.type === "runtime.online");
    const wake = captureWake();
    phone.device.closePath("relay");
    runtime.publish(1, { type: "interaction.requested", request: { runtimeId: "runtime", requestId: "race-request",
      extensionId: "ask", kind: "confirm", title: "Continue?", expiresAt: Date.now() + 60_000 } });
    await vi.waitFor(() => expect(wake).toHaveBeenCalledTimes(1), { timeout: 2500 });
    expect(JSON.parse(wake.mock.calls[0]![1]!.body as string).deviceIds).toEqual([phone.device.deviceId]);
    expect(host.activePathOf(phone.device.deviceId)).toBe("relay");
  });
});
