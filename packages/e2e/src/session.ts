/**
 * 连接级会话：握手（HS1/HS2/HS3）与加密流（spec §5.3 / §5.4）。
 *
 * 关键点：`ee`、`pskRoot`、`k_h2d`、`k_d2h` 都**从不上网**，网络上只有临时公钥与 MAC。
 * 每次建立或更换 Path 都重跑一次握手 —— 「换网络不掉线」和「前向保密」都来自这里。
 */
import { canonEnvelopeAad, envelopeNonce, ENVELOPE_HANDSHAKE_SEQUENCE, type EnvelopeChannel, type EnvelopeV2, type RoutingHeaderV2 } from "@pi-remote/protocol";

import { E2eError } from "./error.js";
import {
  SYMMETRIC_KEY_BYTES,
  X25519_KEY_BYTES,
  constantTimeEqual,
  decodePlaintextJson,
  deriveSharedSecret,
  encodePlaintextJson,
  fromBase64Url,
  fromBase64UrlFixed,
  generateX25519KeyPair,
  hkdfSha256,
  hmacSha256,
  openAead,
  sealAead,
  toBase64Url,
  type X25519KeyPair,
} from "./primitives.js";

export type E2eRole = "host" | "device";

export type SessionKeys = {
  kHostToDevice: Buffer;
  kDeviceToHost: Buffer;
};

export type HandshakeHello = {
  type: "hs1";
  ePubD: string;
};
export type HandshakeAcceptBody = { type: "hs2"; ePubH: string; macH: string };
export type HandshakeConfirmBody = { type: "hs3"; macD: string };
export type HandshakeBody = HandshakeHello | HandshakeAcceptBody | HandshakeConfirmBody;

/** `info` 里两个临时公钥**固定 `e_pub_h` 在前**，写反会导致两端派生出不同密钥。 */
export function deriveSessionKeys(input: {
  sharedSecret: Uint8Array;
  pskRoot: Uint8Array;
  hostEphemeralPublic: Uint8Array;
  deviceEphemeralPublic: Uint8Array;
}): SessionKeys {
  const hostPub = toBase64Url(input.hostEphemeralPublic);
  const devicePub = toBase64Url(input.deviceEphemeralPublic);
  return {
    kHostToDevice: hkdfSha256(input.sharedSecret, input.pskRoot, `h2d|${hostPub}${devicePub}`),
    kDeviceToHost: hkdfSha256(input.sharedSecret, input.pskRoot, `d2h|${hostPub}${devicePub}`),
  };
}

/**
 * `mac_h = HMAC(k_h2d, "hs-h|" + e_pub_h + e_pub_d)`
 *
 * 每个确认 MAC 都用**发送方自己方向**的会话密钥：Host 用 `k_h2d`（它发数据用的），
 * 手机用 `k_d2h`。这样「谁确认」和「谁用哪把钥匙」是同一个事实，不需要额外解释。
 */
export function handshakeMacFromHost(
  keys: SessionKeys,
  hostEphemeralPublic: Uint8Array,
  deviceEphemeralPublic: Uint8Array,
): Buffer {
  return hmacSha256(keys.kHostToDevice, "hs-h|", toBase64Url(hostEphemeralPublic), toBase64Url(deviceEphemeralPublic));
}

export function handshakeMacFromDevice(
  keys: SessionKeys,
  hostEphemeralPublic: Uint8Array,
  deviceEphemeralPublic: Uint8Array,
): Buffer {
  return hmacSha256(keys.kDeviceToHost, "hs-d|", toBase64Url(hostEphemeralPublic), toBase64Url(deviceEphemeralPublic));
}

/**
 * 未加密帧：`hdr.n = 0`，`ct` 装 base64url 明文 JSON。
 *
 * 目前有两种，共同点是**对端必须能读懂它才能建立密钥**：
 * `hs`（连接握手）与 `pair`（配对请求 / 响应，Host 要先拿到 `devicePub` 才能算出
 * `pskRoot`）。两者装的内容都是公开值——公钥、nonce、MAC——秘密从不进去。
 */
export function buildPlaintextEnvelope(input: {
  kind: "pair" | "hs";
  room: string;
  from: string;
  to: string;
  body: unknown;
}): EnvelopeV2 {
  return {
    v: 2,
    hdr: { k: input.kind, room: input.room, from: input.from, to: input.to, n: ENVELOPE_HANDSHAKE_SEQUENCE },
    ct: encodePlaintextJson(input.body),
  };
}

export function readPlaintextEnvelope(envelope: EnvelopeV2, expected: "pair" | "hs"): unknown {
  if (envelope.hdr.k !== expected) {
    throw new E2eError("malformed", `期望 ${expected} 帧，收到 ${envelope.hdr.k}`);
  }
  return decodePlaintextJson(envelope.ct, `${expected}.ct`);
}

export function buildHandshakeEnvelope(input: {
  room: string;
  from: string;
  to: string;
  body: HandshakeBody;
}): EnvelopeV2 {
  return buildPlaintextEnvelope({ ...input, kind: "hs" });
}

export function readHandshakeEnvelope(envelope: EnvelopeV2): HandshakeBody {
  const body = readPlaintextEnvelope(envelope, "hs") as HandshakeBody;
  if (body === null || typeof body !== "object" || typeof body.type !== "string") {
    throw new E2eError("malformed", "握手帧正文不是合法对象");
  }
  return body;
}

// ───────────────────────────────────────────────────────────────────────────────
// 握手状态机
// ───────────────────────────────────────────────────────────────────────────────

/** 手机侧：发 HS1 → 收 HS2 → 验 `mac_h` → 产出 HS3。 */
export class DeviceHandshake {
  readonly #keyPair: X25519KeyPair = generateX25519KeyPair();
  readonly #pskRoot: Buffer;
  #keys: SessionKeys | null = null;

  constructor(pskRoot: Uint8Array) {
    this.#pskRoot = Buffer.from(pskRoot);
    if (this.#pskRoot.length !== SYMMETRIC_KEY_BYTES) {
      throw new E2eError("invalid_key_length", "pskRoot 必须是 32 字节");
    }
  }

  get ephemeralPublicRaw(): Buffer {
    return this.#keyPair.publicRaw;
  }

  start(): HandshakeHello {
    return {
      type: "hs1",
      ePubD: toBase64Url(this.#keyPair.publicRaw),
    };
  }

  /** 校验 `mac_h` 通过才落密钥 —— 这一步就是「对面确实是那台电脑」。 */
  accept(body: HandshakeAcceptBody): HandshakeConfirmBody {
    const hostEphemeralPublic = fromBase64UrlFixed(body.ePubH, X25519_KEY_BYTES, "ePubH");
    const sharedSecret = deriveSharedSecret(this.#keyPair.privateKey, hostEphemeralPublic);
    const keys = deriveSessionKeys({
      sharedSecret,
      pskRoot: this.#pskRoot,
      hostEphemeralPublic,
      deviceEphemeralPublic: this.#keyPair.publicRaw,
    });
    const expected = handshakeMacFromHost(keys, hostEphemeralPublic, this.#keyPair.publicRaw);
    if (!constantTimeEqual(expected, fromBase64Url(body.macH, "macH"))) {
      throw new E2eError("mac_mismatch", "mac_h 校验失败：对面拿不出这台电脑的 pskRoot");
    }
    this.#keys = keys;
    return {
      type: "hs3",
      macD: toBase64Url(handshakeMacFromDevice(keys, hostEphemeralPublic, this.#keyPair.publicRaw)),
    };
  }

  get keys(): SessionKeys {
    if (this.#keys === null) {
      throw new E2eError("not_ready", "握手尚未完成");
    }
    return this.#keys;
  }
}

/** Host 侧：收 HS1 → 发 HS2 → 收 HS3 → 验 `mac_d`。 */
export class HostHandshake {
  readonly #keyPair: X25519KeyPair = generateX25519KeyPair();
  readonly #pskRoot: Buffer;
  #deviceEphemeralPublic: Buffer | null = null;
  #keys: SessionKeys | null = null;
  #confirmed = false;

  constructor(pskRoot: Uint8Array) {
    this.#pskRoot = Buffer.from(pskRoot);
    if (this.#pskRoot.length !== SYMMETRIC_KEY_BYTES) {
      throw new E2eError("invalid_key_length", "pskRoot 必须是 32 字节");
    }
  }

  get confirmed(): boolean {
    return this.#confirmed;
  }

  acceptHello(body: HandshakeHello): HandshakeAcceptBody {
    const deviceEphemeralPublic = fromBase64UrlFixed(body.ePubD, X25519_KEY_BYTES, "ePubD");
    const sharedSecret = deriveSharedSecret(this.#keyPair.privateKey, deviceEphemeralPublic);
    const keys = deriveSessionKeys({
      sharedSecret,
      pskRoot: this.#pskRoot,
      hostEphemeralPublic: this.#keyPair.publicRaw,
      deviceEphemeralPublic,
    });
    this.#deviceEphemeralPublic = deviceEphemeralPublic;
    this.#keys = keys;
    return {
      type: "hs2",
      ePubH: toBase64Url(this.#keyPair.publicRaw),
      macH: toBase64Url(handshakeMacFromHost(keys, this.#keyPair.publicRaw, deviceEphemeralPublic)),
    };
  }

  confirm(body: HandshakeConfirmBody): void {
    const keys = this.#keys;
    const deviceEphemeralPublic = this.#deviceEphemeralPublic;
    if (keys === null || deviceEphemeralPublic === null) {
      throw new E2eError("not_ready", "还没收到 HS1，无法校验 HS3");
    }
    const expected = handshakeMacFromDevice(keys, this.#keyPair.publicRaw, deviceEphemeralPublic);
    if (!constantTimeEqual(expected, fromBase64Url(body.macD, "macD"))) {
      throw new E2eError("mac_mismatch", "mac_d 校验失败：对面没有同一份 pskRoot");
    }
    this.#confirmed = true;
  }

  get keys(): SessionKeys {
    if (this.#keys === null) {
      throw new E2eError("not_ready", "握手尚未完成");
    }
    return this.#keys;
  }
}

// ───────────────────────────────────────────────────────────────────────────────
// 加密流
// ───────────────────────────────────────────────────────────────────────────────

/**
 * 一个方向的加密流。发送序号按 channel 各自从 1 开始、严格递增（spec §5.3 / §5.4）。
 *
 * 接收侧**只查高水位线**（`n > last` 才收）：nonce 的唯一性由 `(channel 槽位, n)`
 * 共同保证（见 protocol 的 `envelopeNonce`），不依赖接收侧的连续性，所以丢一帧
 * 只是丢那一帧，不会把计数器卡死、更不会把这条 channel 毒成永久空洞（issue 04）。
 * 重放（`n <= last`）落在水位线以下，静默丢弃——对幂等的载荷这是正确行为，
 * 对"中继用重放刷错误"也是釜底抽薪。不做应用层重传、不做乱序重排：
 * 底层是有序可靠传输，丢的帧不会迟到。
 */
export class E2eChannel {
  readonly #sendKey: Buffer;
  readonly #receiveKey: Buffer;
  /**
   * 序号按 channel 各自计数。
   *
   * 这是多路复用的全部要害：`bulk` 丢一帧只影响 `bulk`，`ctl` / `msg` 的序列照常推进。
   * 每个加密帧都必须携带 `ch`（ADR-0008 取消了"缺省 = 单流"）。
   */
  readonly #sendSequences = new Map<string, number>();
  readonly #receiveSequences = new Map<string, number>();
  readonly #onStale: ((channel: string, n: number, last: number) => void) | undefined;

  constructor(input: { keys: SessionKeys; role: E2eRole; onStale?: (channel: string, n: number, last: number) => void }) {
    this.#sendKey = input.role === "host" ? input.keys.kHostToDevice : input.keys.kDeviceToHost;
    this.#receiveKey = input.role === "host" ? input.keys.kDeviceToHost : input.keys.kHostToDevice;
    this.#onStale = input.onStale;
  }

  /** 下一条该用的序号。调用方把它填进 `hdr.n`；同一条 channel 上必须严格递增。 */
  nextSequence(channel: EnvelopeChannel): number {
    return (this.#sendSequences.get(channel) ?? 0) + 1;
  }

  seal(hdr: RoutingHeaderV2, payload: Uint8Array): EnvelopeV2 {
    if (hdr.k === "hs" || hdr.k === "pair") {
      throw new E2eError("malformed", `${hdr.k} 帧不加密，请用 buildPlaintextEnvelope`);
    }
    const key = requireChannel(hdr);
    if (hdr.n !== (this.#sendSequences.get(key) ?? 0) + 1) {
      throw new E2eError(
        "sequence_out_of_order",
        `${key} channel 的发送序号必须是 ${(this.#sendSequences.get(key) ?? 0) + 1}，收到 ${hdr.n}`,
      );
    }
    const sealed = sealAead({
      key: this.#sendKey,
      nonce: envelopeNonce(key, hdr.n),
      aad: canonEnvelopeAad(hdr),
      plaintext: payload,
    });
    this.#sendSequences.set(key, hdr.n);
    return { v: 2, hdr, ct: toBase64Url(sealed) };
  }

  /**
   * 解开一条加密帧。
   *
   * 返回 `undefined` 表示这条帧是**重放**（`n <= last`）：它已被处理过，按幂等丢弃，
   * 不是故障——调用方不要把它当错误上报（否则中继可以用重放把接收方刷进错误处理）。
   */
  open(envelope: EnvelopeV2): Buffer | undefined {
    const { hdr } = envelope;
    if (hdr.k === "hs" || hdr.k === "pair") {
      throw new E2eError("malformed", `${hdr.k} 帧不是密文，请用 readPlaintextEnvelope`);
    }
    const channel = requireChannel(hdr);
    const last = this.#receiveSequences.get(channel) ?? 0;
    if (hdr.n <= last) {
      this.#onStale?.(channel, hdr.n, last);
      return undefined;
    }
    const plaintext = openAead({
      key: this.#receiveKey,
      nonce: envelopeNonce(channel, hdr.n),
      aad: canonEnvelopeAad(hdr),
      sealed: fromBase64Url(envelope.ct, "ct"),
    });
    this.#receiveSequences.set(channel, hdr.n);
    return plaintext;
  }
}

/** 加密帧必须携带 `ch`（ADR-0008 取消了"缺省 = 单流"）。 */
function requireChannel(hdr: RoutingHeaderV2): EnvelopeChannel {
  const channel = hdr.ch;
  if (channel === undefined) {
    throw new E2eError("malformed", `加密帧 ${hdr.k} 缺少 hdr.ch`);
  }
  return channel;
}
