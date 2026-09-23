import { describe, expect, it } from "vitest";

import {
  E2eError,
  PAIRING_QR_VERSION,
  buildPairingQrPayload,
  createPairingSecret,
  decodePairingQrText,
  encodePairingQrText,
  generateX25519KeyPair,
  SYMMETRIC_KEY_BYTES,
  X25519_KEY_BYTES,
  fromBase64UrlFixed,
} from "./index.js";

function samplePayload(now = 1_700_000_000) {
  const hostKeyPair = generateX25519KeyPair();
  return buildPairingQrPayload({
    relayUrl: "wss://relay.example",
    code: "AB12-CD34",
    hostId: "host-1",
    hostName: "workstation",
    hostPublicRaw: hostKeyPair.publicRaw,
    psk: createPairingSecret(),
    expiresAt: now + 120,
    lan: [{ host: "192.168.1.23", port: 42130 }],
  });
}

describe("QR v2 载荷", () => {
  it("编解码往返，且两个密钥字段都是 32 字节", () => {
    const payload = samplePayload();
    const decoded = decodePairingQrText(encodePairingQrText(payload));

    expect(decoded.v).toBe(PAIRING_QR_VERSION);
    expect(fromBase64UrlFixed(decoded.hostPub, X25519_KEY_BYTES, "hostPub").length).toBe(X25519_KEY_BYTES);
    expect(fromBase64UrlFixed(decoded.psk, SYMMETRIC_KEY_BYTES, "psk").length).toBe(SYMMETRIC_KEY_BYTES);
    expect(decoded.lan).toEqual([{ host: "192.168.1.23", port: 42130 }]);
  });

  it("没有 lan 字段时不会写出一个空数组", () => {
    const hostKeyPair = generateX25519KeyPair();
    const payload = buildPairingQrPayload({
      relayUrl: "wss://relay.example",
      code: "AB12-CD34",
      hostId: "host-1",
      hostName: "workstation",
      hostPublicRaw: hostKeyPair.publicRaw,
      psk: createPairingSecret(),
      expiresAt: 1_700_000_120,
    });

    expect(payload.lan).toBeUndefined();
    const parsed = JSON.parse(encodePairingQrText(payload)) as Record<string, unknown>;
    expect("lan" in parsed).toBe(false);
  });

  it("v1 载荷明确报「APP 需要升级」，不静默失败", () => {
    try {
      decodePairingQrText(JSON.stringify({ v: 1, relayUrl: "wss://relay.example", code: "AB12" }));
      throw new Error("v1 载荷居然通过了");
    } catch (error) {
      expect(error).toBeInstanceOf(E2eError);
      expect((error as E2eError).code).toBe("unsupported_version");
      expect((error as E2eError).message).toContain("升级");
    }
  });

  it("过期的二维码被拒（手机侧也能先给出友好提示）", () => {
    const payload = samplePayload(1_700_000_000);
    expect(() => decodePairingQrText(encodePairingQrText(payload), 1_700_000_121_000)).toThrowError(E2eError);
  });

  it("psk 长度不对时在解析阶段就失败", () => {
    const payload = samplePayload();
    const broken = { ...payload, psk: Buffer.alloc(16, 1).toString("base64url") };

    try {
      decodePairingQrText(JSON.stringify(broken));
      throw new Error("短 psk 居然通过了");
    } catch (error) {
      expect((error as E2eError).code).toBe("invalid_key_length");
    }
  });

  it("非法 base64url 被拒（Node 自带解码会静默忽略非法字符）", () => {
    const payload = samplePayload();
    const broken = { ...payload, hostPub: "!!!not-base64!!!" };

    expect(() => decodePairingQrText(JSON.stringify(broken))).toThrowError(E2eError);
  });

  it("非 JSON 内容给出明确错误", () => {
    expect(() => decodePairingQrText("hello")).toThrowError(E2eError);
  });
});
