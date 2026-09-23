/**
 * 一台设备的链路聚合：把该设备的多条 Path 收成一条「能收发字节的通道」（spec §6.2）。
 *
 * 三条不变量：
 * 1. **每条路径一套独立的会话密钥。** §6.2 要求「每次切换重跑一次握手，不沿用密钥」，
 *    所以换路不是换个 socket，而是换一整套 `k_h2d` / `k_d2h`。这里因此按路径存会话，
 *    而不是按设备存会话。
 * 2. **入站跟着来路回，出站跟着生效路径走。** 握手应答必须原路返回（对端只在等那条路），
 *    而主动推送（`device.ready` / `runtime.event`）走当前认定的最优路径。
 * 3. **探测只在真正需要选路时跑。** 只有一条路径可用时没有可比较的对象，探了纯属浪费流量。
 */
import { E2eError, type DeviceRecord } from "@pi-remote/e2e";
import {
  EnvelopeReassembler,
  OutboundChannelMux,
  PIECE_HEADER_BYTES,
  PIECE_MAX_CT_CHARS,
  fragmentEnvelope,
  isPieceEnvelope,
  type EnvelopeChannel,
  type EnvelopeV2,
  type PathKind,
} from "@pi-remote/protocol";

import { HostDeviceSession } from "./device-session.js";
import { PathSelector, type PathChange } from "./path.js";

/**
 * 一条路径的出站出口。谁提供的不重要，重要的是它只说「把这条信封送出去」。
 *
 * `backlog` 是这条路径**还没发出去的字节数**（`ws.bufferedAmount` / `bufferedAmount`）。
 * 它在多路复用里是水位判据：`bulk` 只在 backlog 低时才往 socket 里写，这样一条新产生的
 * 控制帧前面最多只剩水位那点字节。不提供就退化成「只按优先级重排，不做水位控制」。
 */
export type PathSink = ((envelope: EnvelopeV2) => void) & { backlog?: () => number };

export const SESSION_SYNC_WIRE_LIMIT_BYTES = 6 * 1024 * 1024;
/** Includes AEAD/base64 and conservative escaped routing headers on every slice. */
export function sessionSyncWireBytes(payloadBytes: number): number {
  const ctChars = Math.ceil((payloadBytes + 16) * 4 / 3);
  return ctChars + Math.max(1, Math.ceil(ctChars / PIECE_MAX_CT_CHARS)) * 4096;
}
type SyncDelivery = { kind: PathKind; bytes: number; remaining: number; done: (written: boolean) => void };

/**
 * 探针载荷的首字节。
 *
 * 两端各自只认**自己的**标签：是自己的就说明这是自己那条的回声（算 RTT），不是就原样回一遍。
 * 之所以要标签而不是「在待测表里找得到」：两边计数器都从 0 开始，靠数值判身份必然撞车，
 * 撞车的表现是「对端永远收不到回声、延迟越测越大」。
 */
export const PROBE_TAG_HOST = 0x48; // 'H'
const PROBE_BYTES = 9;
const DEFAULT_PROBE_INTERVAL_MS = 2_000;

export type ActivePathChange = {
  from: PathKind | undefined;
  to: PathKind | undefined;
  rttMs: number | undefined;
};

export type DeviceLinkOptions = {
  hostId: string;
  device: DeviceRecord;
  /** 0 表示不探测（单路径场景没有可比较的对象）。 */
  probeIntervalMs?: number;
  /** 该设备的路径优先级顺序（第 1 位最优先）。缺省 [lan, p2p, relay]。 */
  pathPreference?: readonly PathKind[];
  /** 生效路径变了。HostService 据此给手机发 `device.path`（§6.2 / §14 B4）。 */
  onActivePathChange?: (change: ActivePathChange) => void;
  /**
   * 一条路径上的握手**刚刚完成**——包括在**同一条**路上重新握手（手机重开就是这样：
   * 它连的还是那条中继，Host 这边压根不知道中间断过）。
   *
   * 与 `onActivePathChange` 分开，是因为这两件事的触发条件不同：重新握手不改变生效路径，
   * 但对端在断开期间错过的东西一样多（`runtime.online` / `offline`），需要同样被补一次。
   */
  onSessionReady?: (kind: PathKind, active: PathKind, change: PathChange) => void;
  /** 收到业务载荷（`data` 帧解密后的明文）。`frame` 区分 JSON 文本与裸字节。 */
  onPayload?: (payload: Buffer, frame: "data" | "bin") => void;
  /**
   * 一片分片因为 `bulk` 限速被丢掉（见 `BulkTokenBucket`）。
   *
   * 给它一个回调而不是静默丢弃：限速是「主动降速」，不是故障，但运维时得看得见它，
   * 否则「速度上不去」会被当成链路问题查。
   */
  onBulkThrottled?: (bytes: number) => void;
  /**
   * 一片 `bulk` 在应用层队列里等了超过一秒（链路积压把水位顶住）。
   *
   * 这是「控制面为什么还慢」的直接证据：分片排队说明 socket 还没消化完，而此时一条控制帧
   * 虽然能插队，但它前面那点**已经写进 socket、收不回来**的字节就是它要等的。
   */
  onBulkQueuedTooLong?: (kind: PathKind, queuedMs: number, queuedBytes: number) => void;
  /** 一条入站帧被判重放丢弃（限频后回调）：水位线错位的唯一可见信号。 */
  onStaleFrame?: (kind: PathKind, info: { channel: string; n: number; last: number }) => void;
  /**
   * `bulk` 等待队列的字节上限（见 `OutboundChannelMux`）。缺省 `DEFAULT_BULK_QUEUE_LIMIT_BYTES`。
   *
   * 它是**内存护栏**，比任何一条传输自己的在途窗口都大得多，正常传输撞不到它；调小它只会让
   * `sendBinary` 更早丢片（丢片由 pull 重传自愈，代价是一次 RTO）。测试用它把丢片路径逼出来。
   */
  bulkQueueLimitBytes?: number;
  /** `bulk` channel 的速率上限（字节/秒）。`0`/缺省 = 不限速。 */
  bulkBytesPerSecond?: number;
  /**
   * 一条路径的底层写入**重试耗尽**——那几帧已经丢了，而它们的序号已经消耗。
   *
   * 调用方应当判死这条路径（`detach`）让选路回落：重发只会换一个新序号，接收侧的洞
   * 永远补不上。正常情况不该触发（写被拒先重试，见 `OutboundChannelMux`）。
   */
  onPathWriteAbandoned?: (kind: PathKind, error: unknown) => void;
  onError?: (error: unknown) => void;
};

/**
 * `bulk` channel 的令牌桶。
 *
 * 「channel 可以控制传输速率」的落地形态：桶空就丢这一片。丢分片在这个协议里是便宜的
 * ——pull 调度器按 chunk 重传（ADR-0005），一次丢片的代价是一次 RTO，而不是一次重连。
 *
 * `bytesPerSecond <= 0` 表示不限速（默认），此时永远有令牌，等于没有这道闸门。
 */
class BulkTokenBucket {
  #bytesPerSecond: number;
  #tokens: number;
  #updatedAt: number;
  readonly #now: () => number;

  constructor(bytesPerSecond: number, now: () => number = Date.now) {
    this.#bytesPerSecond = bytesPerSecond;
    this.#now = now;
    // 满桶开局：第一次发送不该被自己卡住。
    this.#tokens = Math.max(bytesPerSecond, 0);
    this.#updatedAt = now();
  }

  /** 桶最多攒一秒的量：允许一小段突发，但不允许攒出一次大爆发。 */
  #capacity(): number {
    return Math.max(this.#bytesPerSecond, 0);
  }

  take(bytes: number): boolean {
    if (this.#bytesPerSecond <= 0) return true;
    const now = this.#now();
    this.#tokens = Math.min(this.#capacity(), this.#tokens + ((now - this.#updatedAt) / 1000) * this.#bytesPerSecond);
    this.#updatedAt = now;
    if (this.#tokens < bytes) return false;
    this.#tokens -= bytes;
    return true;
  }
}

/**
 * 信封上该按哪个 channel 调度。
 *
 * **加密帧必须携带 `ch`**（ADR-0008 取消了"缺省 = 单流"）。缺失就是发送侧的 bug：
 * 这里直接抛，而不是默默当成 `ctl`——默默降级正是当初难查的那类问题。
 */
function muxChannelOf(envelope: EnvelopeV2): EnvelopeChannel {
  const channel = envelope.hdr.ch;
  if (channel === undefined) {
    throw new Error(`加密帧 ${envelope.hdr.k} 缺少 hdr.ch`);
  }
  return channel;
}

/** 路由头与 JSON 外壳的粗估开销。只用于队列记账，宁大勿小。 */
const ENVELOPE_HEADER_BYTES = 512;

/**
 * 明文 `payload` 封成信封、再切成片之后的线上字节数粗估：
 * `ct` 是 base64url（4/3），而每一片还要背一个片头（见 `piece.ts`）。
 *
 * 片头必须算进去：它决定 `hasBulkRoom()` 是否会提前丢掉一片合法分片。
 */
function envelopeBytesForPayload(payloadBytes: number): number {
  const ctChars = Math.ceil((payloadBytes + 32) / 3) * 4;
  const pieces = Math.max(1, Math.ceil(ctChars / PIECE_MAX_CT_CHARS));
  return ctChars + ENVELOPE_HEADER_BYTES + pieces * PIECE_HEADER_BYTES;
}

export class DeviceLink {
  readonly #options: DeviceLinkOptions;
  /** `bulk` channel 的限速令牌桶（见 `BulkTokenBucket`）。 */
  readonly #bulkBucket: BulkTokenBucket;
  readonly #deviceId: string;
  readonly #pskRoot: Buffer;
  readonly #selector: PathSelector;
  readonly #sessions = new Map<PathKind, HostDeviceSession>();
  readonly #sinks = new Map<PathKind, PathSink>();
  /**
   * 每条路径一个出站多路复用器（见 `OutboundChannelMux`）。
   *
   * 它存在的唯一理由是**延迟**：`hdr.ch` 把序号分开了，但所有 channel 的帧最终都写进同一个
   * socket，后写的超不过先写的。要让控制帧不排在分片后面，就必须在**写 socket 之前**把分片
   * 留下来——分片排队、控制插队。
   */
  readonly #muxes = new Map<PathKind, OutboundChannelMux<EnvelopeV2>>();
  readonly #syncDeliveries = new Set<SyncDelivery>();
  readonly #syncPieces = new WeakMap<EnvelopeV2, SyncDelivery>();
  #syncBytes = 0;
  /**
   * 入站片的重组缓冲（见 `piece.ts`）。
   *
   * 放在 link 上而不是每条路径一份：**一条消息的所有片只会在一条路径上**（发送时
   * 一次性入队到当刻生效路径的 mux），所以拆开反而会弄丢掉属于另一条路径的半截消息。
   */
  readonly #reassembler: EnvelopeReassembler;
  /** 尚未回来的探测：`key` → 发出时刻与所属路径。 */
  readonly #pending = new Map<string, { sentAt: number; kind: PathKind }>();
  #probeTimer: NodeJS.Timeout | undefined;
  #probeCounter = 0;
  #closed = false;

  constructor(options: DeviceLinkOptions) {
    this.#options = options;
    this.#deviceId = options.device.deviceId;
    this.#pskRoot = Buffer.from(options.device.pskRoot, "base64url");
    if (this.#pskRoot.length !== 32) {
      throw new E2eError("invalid_key_length", `设备 ${this.#deviceId} 的 pskRoot 不是 32 字节`);
    }
    this.#selector = new PathSelector({
      ...(options.pathPreference === undefined ? {} : { preference: options.pathPreference }),
    });
    this.#bulkBucket = new BulkTokenBucket(options.bulkBytesPerSecond ?? 0);
    this.#reassembler = new EnvelopeReassembler({
      onRejected: (reason) => this.#options.onError?.(
        new Error(`片层丢弃了一条未完成的消息（${reason}）`),
      ),
    });
  }

  /** 当前生效路径。`undefined` 表示所有路径都不可用。 */
  get active(): PathKind | undefined {
    return this.#selector.active;
  }

  get activeRttMs(): number | undefined {
    return this.#selector.activeRttMs;
  }

  get paths(): readonly PathKind[] {
    return this.#selector.available;
  }

  /**
   * 设备改了优先级顺序（§6.2）。生效路径可能因此换掉，Host 照常 announce——
   * 手机侧把自己的出站路径也切过去。
   */
  setPathPreference(preference: readonly PathKind[]): void {
    this.#announce(this.#selector.setPreference(preference));
  }

  /**
   * 一条路径的出站出口（重新）挂上。**幂等**：同一个 `kind` 重复调用只更新出口引用。
   *
   * ## 为什么必须幂等
   *
   * LAN / P2P 的调用方是**每收到一帧**就调一次（`host-service` 的 `onEnvelope` 把随帧传下来的
   * 出口原样转给这里）。如果这里顺手重建多路复用器，`stop()` 会清掉队列里已封好、还没写进
   * socket 的 `bulk` 帧——它们的发送序号在 `seal()` 时就消耗掉了，对端收到的是一个**永久**
   * 空洞（见 `outbound-mux.ts` 文件头），表现为「下载卡死，重连才好」。
   *
   * ## 旧队列什么时候才该丢
   *
   * 不是「attach 时」，而是「**新会话确认时**」：每次 HS1 都换一套临时密钥、两侧序号从 0 重新
   * 开始（见 `HostDeviceSession`），那一刻旧会话的帧才真的作废。所以重建只发生在 `#resetMux`
   * 的两个调用点：`detach()`（这条 socket 死了）与 `handle()` 的 `confirmed`。
   */
  attach(kind: PathKind, sink: PathSink): void {
    this.#sinks.set(kind, sink);
    if (!this.#muxes.has(kind)) this.#muxes.set(kind, this.#createMux(kind));
  }

  #lastStaleReportAt = 0;

  #reportStale(kind: PathKind, info: { channel: string; n: number; last: number }): void {
    const now = Date.now();
    if (now - this.#lastStaleReportAt < 10_000) return;
    this.#lastStaleReportAt = now;
    this.#options.onStaleFrame?.(kind, info);
  }

  /** 一条路径的出站多路复用器。出口是**动态**读的——理由见 `attach`。 */
  #createMux(kind: PathKind): OutboundChannelMux<EnvelopeV2> {
    return new OutboundChannelMux<EnvelopeV2>({
      // 出口不能在这里捕获：调用方会逐帧换一个新的 sink 对象（`p2p-manager` 每个消息都新建
      // 一个），捕获构造时那一个会把帧写进一条已经作废的 socket。
      write: (envelope) => {
        const sink = this.#sinks.get(kind);
        if (sink === undefined) throw new Error("path_unavailable");
        sink(envelope);
        const delivery = this.#syncPieces.get(envelope);
        if (delivery !== undefined) {
          this.#syncPieces.delete(envelope);
          delivery.remaining -= 1;
          if (delivery.remaining === 0) this.#finishSyncDelivery(delivery, true);
        }
      },
      backlog: () => this.#sinks.get(kind)?.backlog?.() ?? 0,
      ...(this.#options.bulkQueueLimitBytes === undefined
        ? {}
        : { bulkQueueLimitBytes: this.#options.bulkQueueLimitBytes }),
      // 主机侧要丢 `bulk` 就在**封帧之前**丢（`#sendSealed` 里问 `hasBulkRoom`）。这里的帧
      // 已经封好了，丢弃会让发送序号推进却到不了对端——接收侧就是一个永久空洞。
      onWriteAbandoned: (_channel, _attempts, error) => {
        this.detach(kind);
        this.#options.onPathWriteAbandoned?.(kind, error);
      },
      ...(this.#options.onBulkQueuedTooLong === undefined
        ? {}
        : { onBulkQueuedTooLong: (queuedMs: number, queuedBytes: number) => {
          this.#options.onBulkQueuedTooLong?.(kind, queuedMs, queuedBytes);
        } }),
    });
  }

  /**
   * 一条路径上刚确认了一次**新会话**：旧队列里压着的帧属于已经死掉的会话，在这里丢掉。
   *
   * 两个调用点都满足「新会话 = 新序号空间」：`detach()`（socket 死了，重连必然重跑握手）与
   * `handle()` 的 `confirmed`（每次 HS1 都换密钥、`E2eChannel` 序号从 0 开始）。只有在这两处
   * 丢已封帧才留不下空洞；在别处丢（例如逐帧的 `attach`）就是那个永久空洞。
   */
  #resetMux(kind: PathKind): void {
    this.#muxes.get(kind)?.stop();
    this.#loseSyncDeliveries(kind);
    this.#muxes.set(kind, this.#createMux(kind));
  }

  /**
   * 一条路径的入站连接断开。
   * 如果它正是生效路径，选路器会**立刻**换到剩下的最优路径——不等采样。
   */
  detach(kind: PathKind): void {
    this.#sinks.delete(kind);
    this.#sessions.delete(kind);
    this.#muxes.get(kind)?.stop();
    this.#muxes.delete(kind);
    this.#loseSyncDeliveries(kind);
    for (const [key, pending] of this.#pending) {
      if (pending.kind === kind) this.#pending.delete(key);
    }
    this.#announce(this.#selector.markUnavailable(kind));
    this.#syncProbeTimer();
  }

  /** 处理一条入站帧。返回它是否被某条路径消化掉。 */
  handle(kind: PathKind, envelope: EnvelopeV2): boolean {
    const sink = this.#sinks.get(kind);
    if (sink === undefined) return false;
    // 片先拼回整条信封：解密、序号检查、`ch` 校验都只认完整信封——片层自己什么都不判
    // （见 `piece.ts`），否则就会存在第二份合法性真相。
    const complete = this.#reassembler.accept(envelope);
    if (complete === undefined) return isPieceEnvelope(envelope);
    const session = this.#session(kind);
    const outcome = session.handle(complete);
    if (outcome.kind === "handshake-reply") {
      sink(outcome.envelope);
      return true;
    }
    if (outcome.kind === "confirmed") {
      // 新会话确认：序号空间从头开始（每次 HS1 都换一套临时密钥），所以旧队列里那些属于上一条
      // 会话的帧在这里作废。必须排在 `onSessionReady` **之前**——那个回调会立刻发出
      // `device.ready` / runtime 目录，它们得走新的调度器，否则会被随旧队列一起丢掉。
      this.#resetMux(kind);
      // 新会话 = 新的序号空间：上一条会话留下的半截消息永远凑不齐了。
      this.#reassembler.clear();
      // 握手走完才算这条路可用：在那之前它只是个 socket，不是一条能承载业务的路。
      const change = this.#selector.markAvailable(kind);
      this.#syncProbeTimer();
      // 刻意走 `onSessionReady` 而不是 `onActivePathChange`：一条路上**重新**握手时生效路径
      // 不变（`markAvailable` 会返回「没变」），但对端同样是「刚接上来」——它需要一份新的
      // runtime 目录。把它挂在「路径变了」上，手机重开就永远补不到（实测症状：多出一个 cwd
      // 是用户目录的进程，真正的 Pi 进程看起来全不在线）。
      this.#options.onSessionReady?.(kind, this.#selector.active ?? kind, change);
      return true;
    }
    if (outcome.kind === "stale") {
      // 重放帧：已被处理过，按幂等丢弃。通道健康，别让上层把它当故障。
      // 但**完全静默**会让「发送端的序号计数与接收端水位线错位」这类问题不可诊断
      // （2026-09-17：上传分片全部被当重放丢弃，进度永远 0%，日志里一个字都没有），
      // 所以限频留痕。
      this.#reportStale(kind, outcome);
      return true;
    }
    if (outcome.frame === "ping") {
      this.#handleProbe(kind, outcome.payload, session);
      return true;
    }
    this.#options.onPayload?.(outcome.payload, outcome.frame === "bin" ? "bin" : "data");
    return true;
  }

  /**
   * 用当前生效路径发一条业务载荷。没有可用路径时返回 `false`——
   * 调用方据此决定是记账重发还是回报，而不是静默丢掉。
   *
   * [channel] **必填**（ADR-0008）：不再有"对端不支持就降回单流"这回事。
   */
  send(payload: Uint8Array, channel: EnvelopeChannel): boolean {
    return this.#sendSealed("data", payload, this.#selector.active, channel);
  }

  get sessionSyncQueuedBytes(): number { return this.#syncBytes; }

  /** Admission happens before seal consumes a nonce. A delivery owns all of its slices until
   * the last socket write, or until its entire path session is invalidated. */
  sendSessionSnapshot(payload: Uint8Array, done: (written: boolean) => void): boolean {
    const kind = this.#selector.active;
    if (kind === undefined || this.#closed) return false;
    const session = this.#sessions.get(kind);
    const mux = this.#muxes.get(kind);
    const bytes = sessionSyncWireBytes(payload.byteLength);
    if (session === undefined || mux === undefined || this.#syncDeliveries.size >= 8 ||
      this.#syncBytes + bytes > SESSION_SYNC_WIRE_LIMIT_BYTES ||
      mux.queuedBytes + bytes > SESSION_SYNC_WIRE_LIMIT_BYTES) return false;
    this.#syncBytes += bytes;
    let delivery: SyncDelivery | undefined;
    try {
      const pieces = fragmentEnvelope(session.seal("data", payload, "msg"));
      delivery = { kind, bytes, remaining: pieces.length, done };
      this.#syncDeliveries.add(delivery);
      for (const piece of pieces) this.#syncPieces.set(piece, delivery);
      for (const piece of pieces) {
        if (!mux.enqueue("msg", piece, piece.ct.length + PIECE_HEADER_BYTES)) {
          this.detach(kind);
          return false;
        }
      }
      return true;
    } catch (error) {
      if (delivery === undefined) this.#syncBytes -= bytes;
      else this.detach(kind);
      this.#options.onError?.(error);
      return false;
    }
  }

  #finishSyncDelivery(delivery: SyncDelivery, written: boolean): void {
    if (!this.#syncDeliveries.delete(delivery)) return;
    this.#syncBytes -= delivery.bytes;
    delivery.done(written);
  }

  #loseSyncDeliveries(kind: PathKind): void {
    for (const delivery of this.#syncDeliveries) {
      if (delivery.kind === kind) this.#finishSyncDelivery(delivery, false);
    }
  }

  /**
   * 同上，但封成 `bin` 帧。artifact 分片走这里，channel = `bulk`。
   *
   * 两者在**路由**上完全一样（同一条生效路径、同一套密钥），区别只在收端怎么解读明文：
   * `data` 是 JSON，`bin` 是裸字节。序号则按 channel 各自推进（票 07）。
   *
   * 分片还要过一道**限速令牌桶**：桶空就丢这一片并返回 `false`。丢分片是安全的——
   * pull 调度器等不到推进就会重请求这一段（ADR-0005 的重传本来就是按 chunk 的）。
   * 拿「丢一片、等重传」代替「排队等发送」，是因为排队会把内存变成链路的缓冲，
   * 而那条路已经在 `cdc1d80` 里翻过车。
   */
  sendBinary(payload: Uint8Array): boolean {
    if (!this.#bulkBucket.take(payload.byteLength)) {
      this.#options.onBulkThrottled?.(payload.byteLength);
      return false;
    }
    // 队列也已经排满：**在封帧之前**丢掉这一片。封了再丢虽然不再毒化通道（接收侧只查
    // 高水位线，见 issue 04），但那条 nonce 和那点带宽白白烧掉，省下来没有任何代价。
    const mux = this.#muxForActivePath();
    if (mux !== undefined && !mux.hasBulkRoom(envelopeBytesForPayload(payload.byteLength))) {
      this.#options.onBulkThrottled?.(payload.byteLength);
      return false;
    }
    return this.#sendSealed("bin", payload, this.#selector.active, "bulk");
  }

  /**
   * 在**指定**路径上发一条业务载荷（不经过选路）。
   *
   * 握手刚完成时用得上：那一刻「生效路径」可能还停在一条其实已经死掉的路上——Host 不可能
   * 知道手机的 socket 断过（中继不会替它转告），而这条路刚刚证明了自己能通。跟握手应答
   * 原路返回是同一个理由。
   */
  sendOn(kind: PathKind, payload: Uint8Array, channel: EnvelopeChannel): boolean {
    return this.#sendSealed("data", payload, kind, channel);
  }

  #sendSealed(
    frame: "data" | "bin",
    payload: Uint8Array,
    kind = this.#selector.active,
    channel: EnvelopeChannel,
  ): boolean {
    if (kind === undefined) return false;
    const session = this.#sessions.get(kind);
    const mux = this.#muxes.get(kind);
    if (session === undefined || mux === undefined) return false;
    try {
      const envelope = session.seal(frame, payload, channel);
      return this.#enqueueSealed(mux, envelope);
    } catch (error) {
      this.#options.onError?.(error);
      return false;
    }
  }

  /**
   * 把一条已封好的信封交给多路复用器——**大消息先切成片**。
   *
   * 这是 issue 03 的落点：不改传输层片大小，而是把「一次交付给 socket 的量」与它解耦。
   * 一片一条队列项，水位（`OutboundChannelMux` 的 64 KiB / 1 MiB）因此重新变成一个
   * 精细的节拍器——否则一条 1.34 MB 的信封会把两个水位同时跨过，闸门关死到它被链路排空，
   * 弱链路上就是秒级的控制帧延迟。
   */
  #enqueueSealed(mux: OutboundChannelMux<EnvelopeV2>, envelope: EnvelopeV2): boolean {
    let accepted = true;
    for (const piece of fragmentEnvelope(envelope)) {
      const ok = mux.enqueue(muxChannelOf(piece), piece, piece.ct.length + PIECE_HEADER_BYTES);
      accepted = accepted && ok;
    }
    return accepted;
  }

  /** 当前生效路径上的多路复用器。没有可用路径时 `undefined`。 */
  #muxForActivePath(): OutboundChannelMux<EnvelopeV2> | undefined {
    const kind = this.#selector.active;
    return kind === undefined ? undefined : this.#muxes.get(kind);
  }

  close(): void {
    this.#closed = true;
    for (const [kind, mux] of this.#muxes) {
      mux.stop();
      this.#loseSyncDeliveries(kind);
    }
    this.#muxes.clear();
    this.#reassembler.clear();
    if (this.#probeTimer !== undefined) {
      clearInterval(this.#probeTimer);
      this.#probeTimer = undefined;
    }
    this.#pending.clear();
  }

  // ─────────────────────────────────────────────────────────────────────────────

  #session(kind: PathKind): HostDeviceSession {
    const existing = this.#sessions.get(kind);
    if (existing !== undefined) return existing;
    const session = new HostDeviceSession({ hostId: this.#options.hostId, device: this.#options.device });
    this.#sessions.set(kind, session);
    return session;
  }

  /**
   * `ping` 的两种身份：自己那条探针的回声，或者对端的探针。
   *
   * 判据是首字节而不是「这个 token 在不在待测表里」——见 `PROBE_TAG_HOST` 的注释。
   */
  #handleProbe(kind: PathKind, payload: Buffer, session: HostDeviceSession): void {
    if (payload.length === PROBE_BYTES && payload[0] === PROBE_TAG_HOST) {
      const key = payload.subarray(1).toString("hex");
      const pending = this.#pending.get(key);
      if (pending === undefined) return;
      this.#pending.delete(key);
      this.#announce(this.#selector.observeRtt(kind, Date.now() - pending.sentAt));
      return;
    }
    // 对端在探我：原样回一遍，它才算得出这条路自己的往返。
    try {
      this.#sinks.get(kind)?.(session.seal("ping", payload, "ctl"));
    } catch (error) {
      this.#options.onError?.(error);
    }
  }

  /**
   * 探测只在有两条以上路径时开——一条路径时没有可比较的对象，
   * 继续发探针只是在为没人看的数字付流量。
   */
  #syncProbeTimer(): void {
    const interval = this.#options.probeIntervalMs ?? DEFAULT_PROBE_INTERVAL_MS;
    const shouldProbe = !this.#closed && interval > 0 && this.#readyPaths().length >= 2;
    if (!shouldProbe) {
      if (this.#probeTimer !== undefined) {
        clearInterval(this.#probeTimer);
        this.#probeTimer = undefined;
      }
      return;
    }
    if (this.#probeTimer !== undefined) return;
    this.#probeTimer = setInterval(() => {
      this.#probe();
    }, interval);
    this.#probeTimer.unref?.();
  }

  #probe(): void {
    // 每拍都探两条路：候选的路要拿证据，当前的路要更新比较基准——
    // 只探候选那条会让基准永远停在第一次的数值上。
    this.#probeOnce();
  }

  /** 对外暴露一次同步探测，测试用它把「等 3 拍」压缩成确定性的一步。 */
  probeNow(): void {
    this.#probeOnce();
  }

  #probeOnce(): void {
    for (const kind of this.#readyPaths()) {
      const session = this.#sessions.get(kind);
      const sink = this.#sinks.get(kind);
      if (session === undefined || sink === undefined) continue;
      const token = Buffer.alloc(8);
      token.writeBigUInt64BE(BigInt(this.#probeCounter++));
      const payload = Buffer.concat([Buffer.from([PROBE_TAG_HOST]), token]);
      try {
        sink(session.seal("ping", payload, "ctl"));
        this.#pending.set(token.toString("hex"), { sentAt: Date.now(), kind });
      } catch (error) {
        this.#options.onError?.(error);
      }
    }
  }

  #readyPaths(): PathKind[] {
    return this.#selector.available.filter((kind) => this.#sessions.get(kind)?.state === "ready");
  }

  #announce(change: PathChange): void {
    if (!change.changed) return;
    this.#options.onActivePathChange?.({
      from: change.from,
      to: change.to,
      rttMs: change.to === undefined ? undefined : this.#selector.rttOf(change.to),
    });
  }
}
