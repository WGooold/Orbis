import { describe, expect, it } from "vitest";

import {
  E2eError,
  acceptPairRequest,
  createDevicePairingSession,
  deriveConfirmKey,
  derivePskRoot,
  deriveSharedSecret,
  generateX25519KeyPair,
  openPairingWindow,
  pairMacFromHost,
  toBase64Url,
  verifyPairAccept,
  fromBase64UrlFixed,
  X25519_KEY_BYTES,
} from "./index.js";

function setup(now = 0) {
  const hostKeyPair = generateX25519KeyPair();
  const deviceKeyPair = generateX25519KeyPair();
  const window = openPairingWindow({ hostId: "host-1", hostPublicRaw: hostKeyPair.publicRaw, now });
  return { hostKeyPair, deviceKeyPair, window };
}

function deviceSession(hostPublicRaw: Uint8Array, psk: Uint8Array, deviceKeyPair: ReturnType<typeof generateX25519KeyPair>) {
  return createDevicePairingSession({
    hostPublicRaw,
    psk,
    deviceId: "device-1",
    deviceKeyPair,
  });
}

describe("扫码配对握手", () => {
  it("正常路径：双方算出同一个 pskRoot 并完成双向确认", () => {
    const { hostKeyPair, deviceKeyPair, window } = setup();
    const session = deviceSession(hostKeyPair.publicRaw, window.psk, deviceKeyPair);

    const result = acceptPairRequest({
      window,
      hostPrivateKey: hostKeyPair.privateKey,
      request: session.request,
      now: 1_000,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.device.pskRoot).toBe(toBase64Url(session.pskRoot));
    expect(() => verifyPairAccept(session, result.accept)).not.toThrow();
  });

  it("成功后 psk 被就地清零：它是一次性口令，使命结束即销毁", () => {
    const { hostKeyPair, deviceKeyPair, window } = setup();
    const session = deviceSession(hostKeyPair.publicRaw, window.psk, deviceKeyPair);

    acceptPairRequest({ window, hostPrivateKey: hostKeyPair.privateKey, request: session.request, now: 1_000 });

    expect(window.used).toBe(true);
    expect(window.psk.every((byte) => byte === 0)).toBe(true);
  });

  it("psk 重放被拒：同一个窗口不能用第二次", () => {
    const { hostKeyPair, deviceKeyPair, window } = setup();
    const session = deviceSession(hostKeyPair.publicRaw, window.psk, deviceKeyPair);

    const first = acceptPairRequest({ window, hostPrivateKey: hostKeyPair.privateKey, request: session.request, now: 1_000 });
    expect(first.ok).toBe(true);

    const second = acceptPairRequest({ window, hostPrivateKey: hostKeyPair.privateKey, request: session.request, now: 1_001 });
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.code).toBe("already_used");
    }
  });

  it("窗口过期后拒绝，且校验用的是 Host 的时间", () => {
    const { hostKeyPair, deviceKeyPair, window } = setup();
    const session = deviceSession(hostKeyPair.publicRaw, window.psk, deviceKeyPair);

    const result = acceptPairRequest({
      window,
      hostPrivateKey: hostKeyPair.privateKey,
      request: session.request,
      now: 121_000,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("expired");
    }
  });

  it("拿不到 psk 的一方算不出 confirmKey，mac_d 必然失败", () => {
    const { hostKeyPair, deviceKeyPair, window } = setup();
    const session = deviceSession(hostKeyPair.publicRaw, Buffer.alloc(32, 7), deviceKeyPair);

    const result = acceptPairRequest({ window, hostPrivateKey: hostKeyPair.privateKey, request: session.request, now: 1_000 });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("mac_mismatch");
    }
  });

  it("中间人冒充 Host：mac_h 失败，因为手机 pin 的是 QR 里的 hostPub", () => {
    const { hostKeyPair, deviceKeyPair, window } = setup();
    const session = deviceSession(hostKeyPair.publicRaw, window.psk, deviceKeyPair);

    // 攻击者自己有一对密钥、也偷到了 psk，但它算出的 ss 与手机不同。
    const attackerKeyPair = generateX25519KeyPair();
    const devicePublicRaw = fromBase64UrlFixed(session.request.devicePub, X25519_KEY_BYTES, "devicePub");
    const attackerShared = deriveSharedSecret(attackerKeyPair.privateKey, devicePublicRaw);
    const attackerPskRoot = derivePskRoot({
      sharedSecret: attackerShared,
      hostPublicRaw: attackerKeyPair.publicRaw,
      devicePublicRaw,
    });
    const attackerConfirmKey = deriveConfirmKey({
      psk: window.psk,
      pskRoot: attackerPskRoot,
      hostPublicRaw: attackerKeyPair.publicRaw,
      devicePublicRaw,
    });
    const forgedAccept = {
      type: "pair-accept",
      hostId: "host-1",
      nonceH: toBase64Url(Buffer.alloc(32, 3)),
      macH: toBase64Url(pairMacFromHost(attackerConfirmKey, session.nonceD, toBase64Url(Buffer.alloc(32, 3)))),
    } as const;

    expect(() => verifyPairAccept(session, forgedAccept)).toThrowError(E2eError);
    try {
      verifyPairAccept(session, forgedAccept);
    } catch (error) {
      expect((error as E2eError).code).toBe("mac_mismatch");
    }
  });

  it("篡改 mac_h 会被恒定时间比较挡下", () => {
    const { hostKeyPair, deviceKeyPair, window } = setup();
    const session = deviceSession(hostKeyPair.publicRaw, window.psk, deviceKeyPair);
    const result = acceptPairRequest({ window, hostPrivateKey: hostKeyPair.privateKey, request: session.request, now: 1_000 });
    if (!result.ok) {
      throw new Error("前置配对失败");
    }

    const tampered = { ...result.accept, macH: toBase64Url(Buffer.alloc(32, 9)) };
    expect(() => verifyPairAccept(session, tampered)).toThrow();
  });

  it("每设备独立 pskRoot：撤销一台不牵动另一台", () => {
    const hostKeyPair = generateX25519KeyPair();
    const first = setupDevice(hostKeyPair, "device-1");
    const second = setupDevice(hostKeyPair, "device-2");

    expect(first.pskRoot.equals(second.pskRoot)).toBe(false);
  });
});

function setupDevice(hostKeyPair: ReturnType<typeof generateX25519KeyPair>, deviceId: string) {
  const deviceKeyPair = generateX25519KeyPair();
  const window = openPairingWindow({ hostId: "host-1", hostPublicRaw: hostKeyPair.publicRaw, now: 0 });
  return createDevicePairingSession({
    hostPublicRaw: hostKeyPair.publicRaw,
    psk: window.psk,
    deviceId,
    deviceKeyPair,
  });
}
