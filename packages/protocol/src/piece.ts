/**
 * 写入层切片：把一条**已封好的信封**切成小片交付给 socket（issue 03）。
 *
 * ## 为什么需要它
 *
 * 出站多路复用器（`outbound-mux.ts`）的水位判据是「每次取帧之前查一次 socket 积压」，
 * 所以「一次写入有多大」直接决定水位是否有效：一条 `bin` 信封的 `ct` 约 1.34 MB
 * （实测 `bufferedAmount` = 1,398,495，出自当时本地部署链路写下的运行日志），放进去就把
 * `bulk`(64 KiB) 与 `msg`(1 MiB) 两个水位**同时**跨过，闸门关死到它被链路排空为止。
 * 弱链路上那就是秒级的控制帧延迟。
 *
 * 修法不是改传输层的片大小（那会同时改变 pull 请求粒度、窗口在途量与中继护栏的含义，
 * 见 issue 03 的「方案 A」），而是**在写入 socket 之前把一条消息切成小片**：水位于是
 * 重新变回一个精细的节拍器，而传输层片大小与"一次交付给 socket 的量"彻底解耦。
 *
 * ## 切的是 `ct`，不是明文
 *
 * 必须切**已封好**的字节：切开明文逐片加密会让每一小片各背一份 AEAD tag 与信封头。
 * 这里进一步选择切 `ct`（`base64url` 文本）而不是整条信封的 JSON 文本：
 *
 * - base64url 是纯 ASCII 且不含 `"` / `\`，所以片载荷在 JSON 里**不需要任何转义**
 *   （切 JSON 文本的话，每一片都满是引号，转义开销可达 20%+）；
 * - 重组就是字符串拼接，不需要重新解析 JSON。
 *
 * ## 片仍然是一条 `v2.frame`
 *
 * 片的 `hdr.k = "piece"`，而它本身照旧包在 `{type:"v2.frame", …}` 里。这不是随手的选择：
 * 中继的路由（`hdr.to`）与排队（`hdr.ch`）因此**一行都不用改**——它照旧只看 `hdr`，
 * 既不重组也不需要知道 `ct` 里是什么。`hdr` 里的 `ik`/`n` 是**原信封**的 `k` 与序号，
 * 接收侧据此把 `ct` 拼回去、重建出原来的信封，再走完全没变过的解密路径。
 *
 * ## 有界与超时
 *
 * 重组缓冲是新的内存面，所以并发条数与总字节都有上限；超过或超时就丢掉那一条消息。
 * 丢掉是安全的：接收侧只查高水位线（issue 04），没见过的 `n` 照常接受，半条消息
 * 不会毒化任何 channel——丢 `ctl`/`msg` 的应用层后果由各自的上层兜底（交互超时、
 * 会话同步），bulk 则由 offset 幂等吸收。
 */

import type { EnvelopeChannel, EnvelopeKind, EnvelopeV2 } from "./index.js";

/** 一片能装多少 `ct` 字符。判据与取值见 issue 03「切片取值的判据与建议取值」。 */
export const PIECE_MAX_CT_CHARS = 8 * 1024;

/**
 * 片头（`hdr` 里的片字段 + JSON 外壳）的字节数粗估。
 *
 * 它不进水位判据的精确值，只用于「封帧之前」的空间检查与记账：宁大勿小。
 */
export const PIECE_HEADER_BYTES = 256;

/** 同时重组的消息条数上限。超过就丢掉最旧的一条。 */
export const PIECE_REASSEMBLY_MAX_MESSAGES = 4;
/** 重组缓冲的总上限（`ct` 字符数，≈ 线上字节数）。 */
export const PIECE_REASSEMBLY_MAX_CT_CHARS = 32 * 1024 * 1024;
/** 一条消息从首片到末片的最长等待。超时即丢弃——大消息在慢链路上也要给足时间。 */
export const PIECE_REASSEMBLY_TIMEOUT_MS = 60_000;

/** 是不是一条片帧。 */
export function isPieceEnvelope(envelope: EnvelopeV2): boolean {
  return envelope.hdr.k === "piece";
}

/** 只有加密帧会被切片：`hs`/`pair` 是握手帧，本来就很小，而且它们不走加密流。 */
const FRAGMENTABLE_KINDS: readonly EnvelopeKind[] = ["data", "bin", "ping"];

/**
 * 把一条信封切成片。小消息**原样返回**（不切），否则每条控制帧都要多背一个片头。
 *
 * `mid` 由调用方注入（缺省随机），这样发送侧能控制其可读性与可测性。
 */
export function fragmentEnvelope(
  envelope: EnvelopeV2,
  options: { mid?: string; maxCtChars?: number; nextMid?: () => string } = {},
): EnvelopeV2[] {
  if (isPieceEnvelope(envelope)) {
    throw new Error("片帧不能再被切片");
  }
  const maxCtChars = options.maxCtChars ?? PIECE_MAX_CT_CHARS;
  if (!FRAGMENTABLE_KINDS.includes(envelope.hdr.k)) return [envelope];
  if (envelope.hdr.ch === undefined) {
    throw new Error(`加密帧 ${envelope.hdr.k} 缺少 hdr.ch，无法判断它的 channel`);
  }
  const ct = envelope.ct;
  if (ct.length <= maxCtChars) return [envelope];

  const mid = options.mid ?? options.nextMid?.() ?? randomPieceId();
  const channel: EnvelopeChannel = envelope.hdr.ch;
  const pieces: EnvelopeV2[] = [];
  const total = Math.ceil(ct.length / maxCtChars);
  for (let index = 0; index < total; index += 1) {
    pieces.push({
      v: envelope.v,
      hdr: {
        k: "piece",
        room: envelope.hdr.room,
        from: envelope.hdr.from,
        to: envelope.hdr.to,
        // 原信封的序号：重组后要原样放回去，AAD 与 nonce 都由它算出。
        n: envelope.hdr.n,
        ch: channel,
        ik: envelope.hdr.k,
        mid,
        idx: index,
        last: index === total - 1,
      },
      ct: ct.slice(index * maxCtChars, (index + 1) * maxCtChars),
    });
  }
  return pieces;
}

/** 一条消息的片按 UTF-8 字符集随机生成的可打印 id。 */
function randomPieceId(): string {
  // 不用 `crypto.randomUUID()`：这个模块在浏览器/测试里也要能跑，而 `mid` 只要求唯一。
  let id = "";
  while (id.length < 16) id += Math.random().toString(36).slice(2);
  return id.slice(0, 16);
}

type PartialMessage = {
  innerKind: EnvelopeKind;
  channel: EnvelopeChannel;
  room: string;
  from: string;
  to: string;
  n: number;
  /** 已收到的片：`idx` → 该片。乱序到达也能接住（换路径时会出现）。 */
  parts: Map<number, string>;
  receivedChars: number;
  /** 已经知道的总片数（收到末片时确定）。 */
  total: number | undefined;
  lastSeenAt: number;
};

export type ReassemblyRejection =
  | "duplicate"
  | "conflict"
  | "budget"
  | "timeout"
  | "gap";

export type EnvelopeReassemblerOptions = {
  maxMessages?: number;
  maxCtChars?: number;
  timeoutMs?: number;
  now?: () => number;
  /** 丢了一条消息（越界/超时/冲突）。用于观测「片层真的丢东西了」。 */
  onRejected?: (reason: ReassemblyRejection, mid: string) => void;
};

/**
 * 把片拼回信封。**只拼，不判合法性**：拼出来的信封照旧要过 `E2eChannel.open()`，
 * 序号、AEAD 标签、`ch` 都在那里查——这里多判一次只会制造第二份真相。
 *
 * 位置无关：片按 `idx` 存，收到末片时若 `0..total-1` 齐全就交付，否则继续等
 * （缺片等超时，见 `sweep`）。
 */
export class EnvelopeReassembler {
  readonly #maxMessages: number;
  readonly #maxCtChars: number;
  readonly #timeoutMs: number;
  readonly #now: () => number;
  readonly #onRejected: ((reason: ReassemblyRejection, mid: string) => void) | undefined;
  readonly #partials = new Map<string, PartialMessage>();
  #bufferedChars = 0;

  constructor(options: EnvelopeReassemblerOptions = {}) {
    this.#maxMessages = options.maxMessages ?? PIECE_REASSEMBLY_MAX_MESSAGES;
    this.#maxCtChars = options.maxCtChars ?? PIECE_REASSEMBLY_MAX_CT_CHARS;
    this.#timeoutMs = options.timeoutMs ?? PIECE_REASSEMBLY_TIMEOUT_MS;
    this.#now = options.now ?? Date.now;
    this.#onRejected = options.onRejected;
  }

  get bufferedChars(): number {
    return this.#bufferedChars;
  }

  get pendingMessages(): number {
    return this.#partials.size;
  }

  /** 会话重置（重新握手）时调用：旧的半截消息与新会话无关。 */
  clear(): void {
    this.#partials.clear();
    this.#bufferedChars = 0;
  }

  /**
   * 收一片。返回重组完成的信封，或 `undefined`（还没齐）。
   *
   * 非片帧直接原样返回——调用方因此可以对任何信封都先过这里一遍。
   */
  accept(envelope: EnvelopeV2): EnvelopeV2 | undefined {
    if (!isPieceEnvelope(envelope)) return envelope;
    const now = this.#now();
    this.sweep(now);

    const { mid, idx, last, ik, ch } = envelope.hdr;
    if (mid === undefined || idx === undefined || last === undefined || ik === undefined || ch === undefined) {
      // schema 已经保证片字段齐全；走到这里说明调用方绕过了校验。
      this.#onRejected?.("conflict", mid ?? "<missing>");
      return undefined;
    }
    const key = `${envelope.hdr.from}\u0000${mid}`;
    let partial = this.#partials.get(key);
    if (partial === undefined) {
      if (!this.#hasRoom(envelope.ct.length)) {
        this.#onRejected?.("budget", mid);
        this.#evictOldest();
        if (!this.#hasRoom(envelope.ct.length)) return undefined;
      }
      partial = {
        innerKind: ik,
        channel: ch,
        room: envelope.hdr.room,
        from: envelope.hdr.from,
        to: envelope.hdr.to,
        n: envelope.hdr.n,
        parts: new Map(),
        receivedChars: 0,
        total: undefined,
        lastSeenAt: now,
      };
      this.#partials.set(key, partial);
    } else if (
      partial.room !== envelope.hdr.room ||
      partial.to !== envelope.hdr.to ||
      partial.n !== envelope.hdr.n ||
      partial.innerKind !== ik ||
      partial.channel !== ch
    ) {
      // 同一个 mid 却带着不同的信封身份：不是同一条消息，丢弃整条（重放或 bug）。
      this.#drop(key, "conflict");
      return undefined;
    }

    partial.lastSeenAt = now;
    const known = partial.parts.get(idx);
    if (known !== undefined) {
      // 重传（发送侧重试了被拒的那一片）：同内容就当无事发生，不同内容说明身份冲突。
      if (known === envelope.ct) return this.#finishIfComplete(key, partial);
      this.#drop(key, "conflict");
      return undefined;
    }
    partial.parts.set(idx, envelope.ct);
    partial.receivedChars += envelope.ct.length;
    this.#bufferedChars += envelope.ct.length;
    if (last) partial.total = idx + 1;
    if (partial.receivedChars > this.#maxCtChars) {
      this.#drop(key, "budget");
      return undefined;
    }

    const completed = this.#finishIfComplete(key, partial);
    if (completed !== undefined) return completed;

    if (partial.total !== undefined && partial.parts.size === partial.total) {
      // 片数对得上但序号不连续（例如 0,1,3 却声称 total=3）——只能等超时，不用瞎猜。
      return undefined;
    }
    return undefined;
  }

  /** 丢掉超时的半截消息。调用方可以挂在定时器上；`accept` 每次也会顺手扫一遍。 */
  sweep(now: number = this.#now()): void {
    for (const [key, partial] of this.#partials) {
      if (now - partial.lastSeenAt < this.#timeoutMs) continue;
      this.#drop(key, "timeout");
    }
  }

  #hasRoom(chars: number): boolean {
    if (this.#partials.size >= this.#maxMessages) return false;
    return this.#bufferedChars + chars <= this.#maxCtChars;
  }

  #evictOldest(): void {
    let oldestKey: string | undefined;
    let oldestAt = Number.POSITIVE_INFINITY;
    for (const [key, partial] of this.#partials) {
      if (partial.lastSeenAt < oldestAt) {
        oldestAt = partial.lastSeenAt;
        oldestKey = key;
      }
    }
    if (oldestKey !== undefined) this.#drop(oldestKey, "budget");
  }

  #finishIfComplete(key: string, partial: PartialMessage): EnvelopeV2 | undefined {
    const total = partial.total;
    if (total === undefined || partial.parts.size !== total) return undefined;
    const slices: string[] = [];
    for (let index = 0; index < total; index += 1) {
      const slice = partial.parts.get(index);
      if (slice === undefined) return undefined;
      slices.push(slice);
    }
    this.#partials.delete(key);
    this.#bufferedChars -= partial.receivedChars;
    return {
      v: 2,
      hdr: {
        k: partial.innerKind,
        room: partial.room,
        from: partial.from,
        to: partial.to,
        n: partial.n,
        ch: partial.channel,
      },
      ct: slices.join(""),
    };
  }

  #drop(key: string, reason: ReassemblyRejection): void {
    const partial = this.#partials.get(key);
    if (partial === undefined) return;
    this.#partials.delete(key);
    this.#bufferedChars -= partial.receivedChars;
    this.#onRejected?.(reason, key.slice(key.indexOf("\u0000") + 1));
  }
}
