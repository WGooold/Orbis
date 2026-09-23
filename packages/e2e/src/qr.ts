/**
 * QR v2 载荷（spec §4.2）。
 *
 * 这是整个信任链的起点：`hostPub` 只经由「屏幕 → 摄像头」这条物理路径到达手机，
 * 不经过任何网络。所以这个载荷的解析必须**明确拒绝**自己看不懂的版本，而不是
 * 兜底成别的行为。
 */
import { E2eError } from "./error.js";
import { SYMMETRIC_KEY_BYTES, X25519_KEY_BYTES, fromBase64UrlFixed, randomKey, toBase64Url } from "./primitives.js";

export const PAIRING_QR_VERSION = 2 as const;

export type PairingQrLanEndpoint = {
  host: string;
  port: number;
};

export type PairingQrPayload = {
  v: typeof PAIRING_QR_VERSION;
  relayUrl: string;
  code: string;
  hostId: string;
  hostName: string;
  hostPub: string;
  psk: string;
  exp: number;
  lan?: PairingQrLanEndpoint[];
};

export function buildPairingQrPayload(input: {
  relayUrl: string;
  code: string;
  hostId: string;
  hostName: string;
  hostPublicRaw: Uint8Array;
  psk: Uint8Array;
  expiresAt: number;
  lan?: readonly PairingQrLanEndpoint[];
}): PairingQrPayload {
  const payload: PairingQrPayload = {
    v: PAIRING_QR_VERSION,
    relayUrl: input.relayUrl,
    code: input.code,
    hostId: input.hostId,
    hostName: input.hostName,
    hostPub: toBase64Url(input.hostPublicRaw),
    psk: toBase64Url(input.psk),
    exp: input.expiresAt,
  };
  if (input.lan !== undefined && input.lan.length > 0) {
    payload.lan = input.lan.map((entry) => ({ host: entry.host, port: entry.port }));
  }
  return payload;
}

export function encodePairingQrText(payload: PairingQrPayload): string {
  return JSON.stringify(payload);
}

/**
 * 解析扫码结果。
 * `v` 不是 2 就报错——旧客户端遇到 v2 必须明确提示「APP 需要升级」，
 * 而新客户端遇到 v1 也不能假装看得懂密码学材料不存在的载荷。
 */
export function decodePairingQrText(text: string, now?: number): PairingQrPayload {
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch (cause) {
    throw new E2eError("malformed", "二维码内容不是合法 JSON", { cause });
  }
  const payload = raw as Partial<PairingQrPayload> | null;
  if (payload === null || typeof payload !== "object") {
    throw new E2eError("malformed", "二维码内容不是对象");
  }
  if (payload.v !== PAIRING_QR_VERSION) {
    throw new E2eError(
      "unsupported_version",
      payload.v === 1
        ? "这是一个 v1 的二维码，缺少端到端加密材料；APP 需要升级后才能配对"
        : `不认识的二维码版本：${String(payload.v)}`,
    );
  }
  const relayUrl = requireString(payload.relayUrl, "relayUrl");
  const code = requireString(payload.code, "code");
  const hostId = requireString(payload.hostId, "hostId");
  const hostName = requireString(payload.hostName, "hostName");
  const hostPub = requireString(payload.hostPub, "hostPub");
  const psk = requireString(payload.psk, "psk");
  const exp = requireNumber(payload.exp, "exp");

  // 长度在这里就验掉：后面每一步都会用这两个值，早失败比晚失败好定位。
  fromBase64UrlFixed(hostPub, X25519_KEY_BYTES, "hostPub");
  fromBase64UrlFixed(psk, SYMMETRIC_KEY_BYTES, "psk");

  const result: PairingQrPayload = {
    v: PAIRING_QR_VERSION,
    relayUrl,
    code,
    hostId,
    hostName,
    hostPub,
    psk,
    exp,
  };
  const lan = payload.lan;
  if (Array.isArray(lan)) {
    result.lan = lan
      .filter((entry): entry is PairingQrLanEndpoint =>
        typeof entry === "object" && entry !== null
        && typeof (entry as PairingQrLanEndpoint).host === "string"
        && typeof (entry as PairingQrLanEndpoint).port === "number")
      .map((entry) => ({ host: entry.host, port: entry.port }));
  }
  if (now !== undefined && result.exp * 1_000 < now) {
    throw new E2eError("expired", "这个二维码已经过期，请在电脑上重新执行配对命令");
  }
  return result;
}

export function createPairingSecret(): Buffer {
  return randomKey();
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new E2eError("malformed", `二维码缺少字段 ${field}`);
  }
  return value;
}

function requireNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new E2eError("malformed", `二维码缺少字段 ${field}`);
  }
  return value;
}
