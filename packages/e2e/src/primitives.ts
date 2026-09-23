/**
 * 密码学原语封装。桌面侧只用 `node:crypto`，零新依赖（spec §5.3「实现选型」）。
 *
 * 本文件里的所有编码选择都是**互操作契约**的一部分：X25519 私钥/公钥是 32 字节裸
 * 值，而出现在 `info` 串或 wire 字段里的公钥一律是 **base64url（无 padding）文本**。
 * Android 侧必须按同样规则编码，否则两端会派生出不同的密钥。
 */
import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
  type KeyObject,
} from "node:crypto";

import { E2eError } from "./error.js";

export const X25519_KEY_BYTES = 32;
export const SYMMETRIC_KEY_BYTES = 32;
export const AEAD_NONCE_BYTES = 12;
export const AEAD_TAG_BYTES = 16;

/**
 * RFC 8410：32 字节裸 X25519 密钥的 DER 包裹前缀。
 * Node 不接受裸密钥，所以导入时手工拼前缀，导出时按同样的长度切回来。
 */
const PKCS8_PREFIX = Buffer.from("302e020100300506032b656e04220420", "hex");
const SPKI_PREFIX = Buffer.from("302a300506032b656e032100", "hex");

const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/u;

export function utf8(value: string): Buffer {
  return Buffer.from(value, "utf8");
}

export function toBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

/** 严格解码：Node 自带的 base64 解码会静默忽略非法字符，这里必须先拒掉。 */
export function fromBase64Url(value: string, label: string): Buffer {
  if (!BASE64URL_PATTERN.test(value)) {
    throw new E2eError("malformed", `${label} 不是合法的 base64url`);
  }
  return Buffer.from(value, "base64url");
}

export function fromBase64UrlFixed(value: string, bytes: number, label: string): Buffer {
  const decoded = fromBase64Url(value, label);
  if (decoded.length !== bytes) {
    throw new E2eError("invalid_key_length", `${label} 必须是 ${bytes} 字节，实际 ${decoded.length}`);
  }
  return decoded;
}

export function randomKey(): Buffer {
  return randomBytes(SYMMETRIC_KEY_BYTES);
}

export function isAllZero(bytes: Uint8Array): boolean {
  for (const byte of bytes) {
    if (byte !== 0) {
      return false;
    }
  }
  return true;
}

export function constantTimeEqual(left: Uint8Array, right: Uint8Array): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  if (a.length !== b.length) {
    return false;
  }
  return timingSafeEqual(a, b);
}

export type X25519KeyPair = {
  /** 32 字节裸私钥，永不外传、永不落盘明文（手机侧由 Keystore 封装）。 */
  privateRaw: Buffer;
  /** 32 字节裸公钥，可以公开。 */
  publicRaw: Buffer;
  privateKey: KeyObject;
};

export function generateX25519KeyPair(): X25519KeyPair {
  const { privateKey, publicKey } = generateKeyPairSync("x25519");
  const privateRaw = exportPrivateRaw(privateKey);
  return { privateRaw, publicRaw: exportPublicRaw(publicKey), privateKey };
}

export function exportPrivateRaw(key: KeyObject): Buffer {
  const der = key.export({ format: "der", type: "pkcs8" });
  if (!der.subarray(0, PKCS8_PREFIX.length).equals(PKCS8_PREFIX)) {
    throw new E2eError("malformed", "不是预期的 X25519 PKCS8 结构");
  }
  return Buffer.from(der.subarray(der.length - X25519_KEY_BYTES));
}

export function exportPublicRaw(key: KeyObject): Buffer {
  const der = key.export({ format: "der", type: "spki" });
  if (!der.subarray(0, SPKI_PREFIX.length).equals(SPKI_PREFIX)) {
    throw new E2eError("malformed", "不是预期的 X25519 SPKI 结构");
  }
  return Buffer.from(der.subarray(der.length - X25519_KEY_BYTES));
}

export function privateKeyFromRaw(raw: Uint8Array): KeyObject {
  const bytes = Buffer.from(raw);
  if (bytes.length !== X25519_KEY_BYTES) {
    throw new E2eError("invalid_key_length", `X25519 私钥必须是 ${X25519_KEY_BYTES} 字节`);
  }
  return createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, bytes]), format: "der", type: "pkcs8" });
}

export function publicKeyFromRaw(raw: Uint8Array): KeyObject {
  const bytes = Buffer.from(raw);
  if (bytes.length !== X25519_KEY_BYTES) {
    throw new E2eError("invalid_key_length", `X25519 公钥必须是 ${X25519_KEY_BYTES} 字节`);
  }
  return createPublicKey({ key: Buffer.concat([SPKI_PREFIX, bytes]), format: "der", type: "spki" });
}

/** 从裸私钥推出对应的裸公钥。用于校验落盘的密钥对是否自洽。 */
export function publicRawFromPrivateRaw(raw: Uint8Array): Buffer {
  return exportPublicRaw(createPublicKey(privateKeyFromRaw(raw)));
}

/**
 * `ss = X25519(自己的私钥, 对方的公钥)`。
 *
 * **拒绝全零输出**是刻意保留的一条可移植规则：OpenSSL 遇到退化点（例如全零公钥）
 * 会直接抛错，而 BouncyCastle 会安静地返回全零。两端必须表现一致，所以这里既接住
 * 异常、也显式检查全零。
 */
export function deriveSharedSecret(privateKey: KeyObject, peerPublicRaw: Uint8Array): Buffer {
  const peer = Buffer.from(peerPublicRaw);
  if (peer.length !== X25519_KEY_BYTES) {
    throw new E2eError("invalid_key_length", `对方 X25519 公钥必须是 ${X25519_KEY_BYTES} 字节`);
  }
  let secret: Buffer;
  try {
    secret = diffieHellman({ privateKey, publicKey: publicKeyFromRaw(peer) });
  } catch (cause) {
    throw new E2eError("degenerate_public_key", "X25519 拒绝了这个公钥（退化点或小群元素）", { cause });
  }
  if (secret.length !== X25519_KEY_BYTES) {
    throw new E2eError("malformed", `X25519 输出长度异常：${secret.length}`);
  }
  if (isAllZero(secret)) {
    throw new E2eError("degenerate_shared_secret", "X25519 输出全零，公钥是退化点");
  }
  return secret;
}

export function hkdfSha256(
  ikm: Uint8Array,
  salt: Uint8Array,
  info: string,
  length: number = SYMMETRIC_KEY_BYTES,
): Buffer {
  const output = hkdfSync("sha256", Buffer.from(ikm), Buffer.from(salt), utf8(info), length);
  return Buffer.from(output);
}

/** 各部分按顺序直接拼接后取 HMAC —— 也就是 `HMAC(key, "label|" + value + ...)`。 */
export function hmacSha256(key: Uint8Array, ...parts: readonly string[]): Buffer {
  const mac = createHmac("sha256", Buffer.from(key));
  for (const part of parts) {
    mac.update(part, "utf8");
  }
  return mac.digest();
}

/** 返回 `ciphertext || tag`：nonce 由序号派生，不随报文传输（见 protocol 的 `envelopeNonce`）。 */
export function sealAead(input: {
  key: Uint8Array;
  nonce: Uint8Array;
  aad: Uint8Array;
  plaintext: Uint8Array;
}): Buffer {
  const key = Buffer.from(input.key);
  const nonce = Buffer.from(input.nonce);
  if (key.length !== SYMMETRIC_KEY_BYTES) {
    throw new E2eError("invalid_key_length", `AEAD 密钥必须是 ${SYMMETRIC_KEY_BYTES} 字节`);
  }
  if (nonce.length !== AEAD_NONCE_BYTES) {
    throw new E2eError("malformed", `AEAD nonce 必须是 ${AEAD_NONCE_BYTES} 字节`);
  }
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(input.aad));
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(input.plaintext)), cipher.final()]);
  return Buffer.concat([ciphertext, cipher.getAuthTag()]);
}

export function openAead(input: {
  key: Uint8Array;
  nonce: Uint8Array;
  aad: Uint8Array;
  sealed: Uint8Array;
}): Buffer {
  const key = Buffer.from(input.key);
  const nonce = Buffer.from(input.nonce);
  const sealed = Buffer.from(input.sealed);
  if (key.length !== SYMMETRIC_KEY_BYTES) {
    throw new E2eError("invalid_key_length", `AEAD 密钥必须是 ${SYMMETRIC_KEY_BYTES} 字节`);
  }
  if (nonce.length !== AEAD_NONCE_BYTES) {
    throw new E2eError("malformed", `AEAD nonce 必须是 ${AEAD_NONCE_BYTES} 字节`);
  }
  if (sealed.length < AEAD_TAG_BYTES) {
    throw new E2eError("malformed", "密文短于认证标签长度");
  }
  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAAD(Buffer.from(input.aad));
  decipher.setAuthTag(sealed.subarray(sealed.length - AEAD_TAG_BYTES));
  try {
    return Buffer.concat([decipher.update(sealed.subarray(0, sealed.length - AEAD_TAG_BYTES)), decipher.final()]);
  } catch (cause) {
    throw new E2eError("aead_failed", "AEAD 认证失败：密文、AAD 或密钥不匹配", { cause });
  }
}

export function encodePlaintextJson(value: unknown): string {
  return toBase64Url(utf8(JSON.stringify(value)));
}

export function decodePlaintextJson(ct: string, label: string): unknown {
  return JSON.parse(fromBase64Url(ct, label).toString("utf8")) as unknown;
}
