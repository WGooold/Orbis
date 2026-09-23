/**
 * 扫码配对的密码学部分（spec §4）。
 *
 * 所有公式都是两端必须逐字节一致的互操作契约。上层（Host 的 `pi-remote pair`、
 * 手机 APP）只负责搬运 `PairRequestBody` / `PairAcceptBody` 与决定何时关窗，
 * 密钥推导与校验都收在这里，避免两端各写一遍。
 */
import type { KeyObject } from "node:crypto";

import type { EnvelopeV2 } from "@pi-remote/protocol";

import { E2eError } from "./error.js";
import { buildPlaintextEnvelope, readPlaintextEnvelope } from "./session.js";
import {
  X25519_KEY_BYTES,
  constantTimeEqual,
  deriveSharedSecret,
  fromBase64Url,
  fromBase64UrlFixed,
  hkdfSha256,
  hmacSha256,
  randomKey,
  toBase64Url,
  utf8,
  type X25519KeyPair,
} from "./primitives.js";

/** 配对窗口时长。spec §4.1：120 秒，不是常驻监听。 */
export const PAIRING_WINDOW_SECONDS = 120;
/** `pskRoot` 的 HKDF salt。字面常量，两端一致。 */
export const PAIRING_SALT = "pi-remote/v2";

/**
 * 配对帧的正文。`ct` 是**明文**（spec §5.2）：Host 必须先读到 `devicePub` 才能算出
 * `pskRoot`，加密会让这条消息无法自举。里面全是公开值——公钥、nonce、MAC。
 */
export type PairRequestBody = {
  type: "pair-request";
  devicePub: string;
  deviceId: string;
  nonceD: string;
  macD: string;
};

export type PairAcceptBody = {
  type: "pair-accept";
  hostId: string;
  nonceH: string;
  macH: string;
};

export function buildPairEnvelope(input: {
  room: string;
  from: string;
  to: string;
  body: PairRequestBody | PairAcceptBody;
}): EnvelopeV2 {
  return buildPlaintextEnvelope({ ...input, kind: "pair" });
}

export function readPairEnvelope(envelope: EnvelopeV2): PairRequestBody | PairAcceptBody {
  const body = readPlaintextEnvelope(envelope, "pair");
  if (body === null || typeof body !== "object") {
    throw new E2eError("malformed", "配对帧正文不是对象");
  }
  const type = (body as { type?: unknown }).type;
  if (type !== "pair-request" && type !== "pair-accept") {
    throw new E2eError("malformed", `不认识的配对帧类型：${String(type)}`);
  }
  return body as PairRequestBody | PairAcceptBody;
}

/** `pskRoot = HKDF(ikm = ss, salt = "pi-remote/v2", info = "root|" + hostPub + devicePub)` */
export function derivePskRoot(input: {
  sharedSecret: Uint8Array;
  hostPublicRaw: Uint8Array;
  devicePublicRaw: Uint8Array;
}): Buffer {
  const info = `root|${toBase64Url(input.hostPublicRaw)}${toBase64Url(input.devicePublicRaw)}`;
  return hkdfSha256(input.sharedSecret, utf8(PAIRING_SALT), info);
}

/** `confirmKey = HKDF(ikm = psk, salt = pskRoot, info = "pair-confirm|" + hostPub + devicePub)` */
export function deriveConfirmKey(input: {
  psk: Uint8Array;
  pskRoot: Uint8Array;
  hostPublicRaw: Uint8Array;
  devicePublicRaw: Uint8Array;
}): Buffer {
  const info = `pair-confirm|${toBase64Url(input.hostPublicRaw)}${toBase64Url(input.devicePublicRaw)}`;
  return hkdfSha256(input.psk, input.pskRoot, info);
}

/** `mac_d = HMAC(confirmKey, "device|" + nonce_d)`。`"device"` 是字面标签，不是 `deviceId`。 */
export function pairMacFromDevice(confirmKey: Uint8Array, nonceD: string): Buffer {
  return hmacSha256(confirmKey, "device|", nonceD);
}

/** `mac_h = HMAC(confirmKey, "host|" + nonce_d + nonce_h)` —— 覆盖两个 nonce，顺带确认收到了 `nonce_d`。 */
export function pairMacFromHost(confirmKey: Uint8Array, nonceD: string, nonceH: string): Buffer {
  return hmacSha256(confirmKey, "host|", nonceD, nonceH);
}

// ───────────────────────────────────────────────────────────────────────────────
// Host 侧：配对窗口
// ───────────────────────────────────────────────────────────────────────────────

export type PairingWindow = {
  readonly hostId: string;
  readonly hostPublicRaw: Buffer;
  readonly psk: Buffer;
  readonly expiresAtMs: number;
  used: boolean;
};

export function openPairingWindow(input: {
  hostId: string;
  hostPublicRaw: Uint8Array;
  now?: number;
  ttlSeconds?: number;
}): PairingWindow {
  const now = input.now ?? Date.now();
  const ttlSeconds = input.ttlSeconds ?? PAIRING_WINDOW_SECONDS;
  return {
    hostId: input.hostId,
    hostPublicRaw: Buffer.from(input.hostPublicRaw),
    psk: randomKey(),
    expiresAtMs: now + ttlSeconds * 1_000,
    used: false,
  };
}

export type PairingAccepted = {
  ok: true;
  accept: PairAcceptBody;
  device: { deviceId: string; devicePub: string; pskRoot: string };
};

export type PairingRejected = {
  ok: false;
  code: "window_closed" | "expired" | "already_used" | "mac_mismatch" | "malformed";
  message: string;
};

/**
 * 校验 `PAIR_REQUEST` 并产出 `PAIR_ACCEPT`。
 *
 * 只做必要的那几条（spec §4.5）：窗口开着、没过期、`psk` 没用过、`mac_d` 对得上。
 * 成功之后 `psk` 被就地清零——它是一次性口令，使命到此结束。
 */
export function acceptPairRequest(input: {
  window: PairingWindow;
  hostPrivateKey: KeyObject;
  request: PairRequestBody;
  now?: number;
}): PairingAccepted | PairingRejected {
  const { window: pairingWindow, request } = input;
  const now = input.now ?? Date.now();

  if (pairingWindow.used) {
    return { ok: false, code: "already_used", message: "这个 psk 已经用过了" };
  }
  if (now > pairingWindow.expiresAtMs) {
    return { ok: false, code: "expired", message: "配对窗口已过期，请重新执行配对命令" };
  }

  let devicePublicRaw: Buffer;
  try {
    devicePublicRaw = fromBase64UrlFixed(request.devicePub, X25519_KEY_BYTES, "devicePub");
  } catch (error) {
    return { ok: false, code: "malformed", message: error instanceof Error ? error.message : String(error) };
  }

  const sharedSecret = deriveSharedSecret(input.hostPrivateKey, devicePublicRaw);
  const pskRoot = derivePskRoot({
    sharedSecret,
    hostPublicRaw: pairingWindow.hostPublicRaw,
    devicePublicRaw,
  });
  const confirmKey = deriveConfirmKey({
    psk: pairingWindow.psk,
    pskRoot,
    hostPublicRaw: pairingWindow.hostPublicRaw,
    devicePublicRaw,
  });

  const expected = pairMacFromDevice(confirmKey, request.nonceD);
  if (!constantTimeEqual(expected, fromBase64Url(request.macD, "macD"))) {
    return { ok: false, code: "mac_mismatch", message: "mac_d 校验失败：对方没有 psk 或拿不到 hostPub 对应的私钥" };
  }

  const nonceH = toBase64Url(randomKey());
  const accept: PairAcceptBody = {
    type: "pair-accept",
    hostId: pairingWindow.hostId,
    nonceH,
    macH: toBase64Url(pairMacFromHost(confirmKey, request.nonceD, nonceH)),
  };

  pairingWindow.psk.fill(0);
  pairingWindow.used = true;

  return {
    ok: true,
    accept,
    device: { deviceId: request.deviceId, devicePub: request.devicePub, pskRoot: toBase64Url(pskRoot) },
  };
}

// ───────────────────────────────────────────────────────────────────────────────
// 手机侧：发起与验证
// ───────────────────────────────────────────────────────────────────────────────

export type DevicePairingSession = {
  readonly request: PairRequestBody;
  readonly nonceD: string;
  readonly pskRoot: Buffer;
  readonly confirmKey: Buffer;
};

/**
 * 手机扫到 QR 之后的本地计算。**这一步一个字节都不上网。**
 * 手机自己的长期密钥对由调用方传入（首次配对时生成，之后长期复用）。
 */
export function createDevicePairingSession(input: {
  hostPublicRaw: Uint8Array;
  psk: Uint8Array;
  deviceId: string;
  deviceKeyPair: X25519KeyPair;
  nonceD?: string;
}): DevicePairingSession {
  const devicePublicRaw = input.deviceKeyPair.publicRaw;
  if (devicePublicRaw.length !== X25519_KEY_BYTES) {
    throw new E2eError("invalid_key_length", "设备公钥长度不对");
  }
  const sharedSecret = deriveSharedSecret(input.deviceKeyPair.privateKey, input.hostPublicRaw);
  const pskRoot = derivePskRoot({
    sharedSecret,
    hostPublicRaw: input.hostPublicRaw,
    devicePublicRaw,
  });
  const confirmKey = deriveConfirmKey({
    psk: input.psk,
    pskRoot,
    hostPublicRaw: input.hostPublicRaw,
    devicePublicRaw,
  });
  const nonceD = input.nonceD ?? toBase64Url(randomKey());
  return {
    nonceD,
    pskRoot,
    confirmKey,
    request: {
      type: "pair-request",
      devicePub: toBase64Url(devicePublicRaw),
      deviceId: input.deviceId,
      nonceD,
      macD: toBase64Url(pairMacFromDevice(confirmKey, nonceD)),
    },
  };
}

/** 校验 `mac_h`：通过即证明对面确实持有 `host_priv` —— 这就是「没被中间人」的全部内容。 */
export function verifyPairAccept(session: DevicePairingSession, accept: PairAcceptBody): void {
  if (accept.hostId.length === 0) {
    throw new E2eError("malformed", "PAIR_ACCEPT 缺少 hostId");
  }
  const expected = pairMacFromHost(session.confirmKey, session.nonceD, accept.nonceH);
  if (!constantTimeEqual(expected, fromBase64Url(accept.macH, "macH"))) {
    throw new E2eError("mac_mismatch", "mac_h 校验失败：对面不是持有 hostPub 对应私钥的那台电脑");
  }
}
