import { describe, expect, it } from "vitest";
import { EnvelopeV2Schema, envelopeNonce } from "@pi-remote/protocol";

import {
  DeviceHandshake,
  E2eChannel,
  E2eError,
  HostHandshake,
  buildHandshakeEnvelope,
  randomKey,
  readHandshakeEnvelope,
  toBase64Url,
  utf8,
  type E2eRole,
} from "./index.js";

const ROOM = "room-1";
const HOST_ID = "host-1";
const DEVICE_ID = "device-1";

type Peer = { channel: E2eChannel; role: E2eRole };

function establish(pskRoot: Buffer = randomKey(), peerPskRoot: Buffer = pskRoot): { device: Peer; host: Peer } {
  const deviceHandshake = new DeviceHandshake(pskRoot);
  const hostHandshake = new HostHandshake(peerPskRoot);

  const hello = deviceHandshake.start();
  const accept = hostHandshake.acceptHello(hello);
  const confirm = deviceHandshake.accept(accept);
  hostHandshake.confirm(confirm);

  return {
    device: { channel: new E2eChannel({ keys: deviceHandshake.keys, role: "device" }), role: "device" },
    host: { channel: new E2eChannel({ keys: hostHandshake.keys, role: "host" }), role: "host" },
  };
}

function sealFrom(peer: Peer, payload: string) {
  const from = peer.role === "device" ? DEVICE_ID : HOST_ID;
  const to = peer.role === "device" ? HOST_ID : DEVICE_ID;
  return peer.channel.seal({ k: "data", room: ROOM, from, to, n: peer.channel.nextSequence("ctl"), ch: "ctl" }, utf8(payload));
}

describe("连接握手", () => {
  it("双方导出同一对方向性密钥，且序号都从 1 开始", () => {
    const { device, host } = establish();

    expect(device.channel.nextSequence("ctl")).toBe(1);
    expect(host.channel.nextSequence("ctl")).toBe(1);

    const envelope = sealFrom(device, "继续");
    expect(envelope.hdr.n).toBe(1);
    expect(host.channel.open(envelope)?.toString("utf8")).toBe("继续");
  });

  it("握手帧符合 protocol 的 EnvelopeV2 契约（relay 会用同一份 schema 校验）", () => {
    const deviceHandshake = new DeviceHandshake(randomKey());
    const envelope = buildHandshakeEnvelope({
      room: ROOM,
      from: DEVICE_ID,
      to: HOST_ID,
      body: deviceHandshake.start(),
    });

    expect(EnvelopeV2Schema.safeParse(envelope).success).toBe(true);
    expect(envelope.hdr.k).toBe("hs");
    expect(envelope.hdr.n).toBe(0);
    expect(readHandshakeEnvelope(envelope)).toEqual({
      type: "hs1",
      ePubD: toBase64Url(deviceHandshake.ephemeralPublicRaw),
    });
  });

  it("pskRoot 不一致时 mac_h 失败 —— 对面不是那台已配对设备", () => {
    const deviceHandshake = new DeviceHandshake(randomKey());
    const hostHandshake = new HostHandshake(randomKey());

    const accept = hostHandshake.acceptHello(deviceHandshake.start());

    expect(() => deviceHandshake.accept(accept)).toThrowError(E2eError);
    try {
      deviceHandshake.accept(accept);
    } catch (error) {
      expect((error as E2eError).code).toBe("mac_mismatch");
    }
  });

  it("篡改 mac_d 会被 Host 挡下", () => {
    const deviceHandshake = new DeviceHandshake(randomKey());
    const hostHandshake = new HostHandshake(randomKey());
    hostHandshake.acceptHello(deviceHandshake.start());

    expect(() => hostHandshake.confirm({ type: "hs3", macD: toBase64Url(Buffer.alloc(32, 1)) })).toThrowError(E2eError);
    expect(hostHandshake.confirmed).toBe(false);
  });

  it("没收到 HS1 就送 HS3 会被拒", () => {
    const hostHandshake = new HostHandshake(randomKey());
    expect(() => hostHandshake.confirm({ type: "hs3", macD: toBase64Url(Buffer.alloc(32, 1)) })).toThrow();
  });
});

describe("加密流", () => {
  it("双向各发 100 条，序号严格递增、内容不丢不错", () => {
    const { device, host } = establish();

    for (let index = 1; index <= 100; index += 1) {
      const outgoing = sealFrom(device, `手机 ${index}`);
      expect(host.channel.open(outgoing)?.toString("utf8")).toBe(`手机 ${index}`);

      const reply = sealFrom(host, `电脑 ${index}`);
      expect(device.channel.open(reply)?.toString("utf8")).toBe(`电脑 ${index}`);
    }
  });

  it("篡改 AAD 里的 to（恶意 relay 改投）→ 解密失败", () => {
    const { device, host } = establish();
    const envelope = sealFrom(device, "继续");

    const redirected = { ...envelope, hdr: { ...envelope.hdr, to: "other-device" } };

    expect(() => host.channel.open(redirected)).toThrowError(E2eError);
    try {
      host.channel.open(redirected);
    } catch (error) {
      expect((error as E2eError).code).toBe("aead_failed");
    }
  });

  it("篡改序号也会失败：n 在 AAD 里", () => {
    const { device, host } = establish();
    const envelope = sealFrom(device, "继续");
    const tampered = { ...envelope, hdr: { ...envelope.hdr, n: envelope.hdr.n + 1 } };

    expect(() => host.channel.open(tampered)).toThrow();
  });

  it("重放同一条密文被静默丢弃（返回 undefined，不是错误）", () => {
    const { device, host } = establish();
    const envelope = sealFrom(device, "继续");
    host.channel.open(envelope);

    // 高水位线语义：n <= last 一律按幂等丢弃。不能当错误上报，否则中继可以用
    // 重放把接收方刷进错误处理。
    expect(host.channel.open(envelope)).toBeUndefined();
  });

  it("跳号（丢帧）不毒化通道：后面的帧照常接受", () => {
    const { device, host } = establish();
    sealFrom(device, "第一条");
    const second = sealFrom(device, "第二条");
    const third = sealFrom(device, "第三条");

    // 第二条在路上丢了。接收侧只查 n > last：第三条照常解开，
    // 不再存在"计数器卡死、这条 channel 从此作废"的状态（issue 04）。
    expect(host.channel.open(third)?.toString("utf8")).toBe("第三条");
    // 丢了的第二条再到达时已落在水位线以下，按重放丢弃。
    expect(host.channel.open(second)).toBeUndefined();
  });

  it("同一 n 在两条 channel 上得到不同的 nonce（issue 01 的原始复现转正）", () => {
    const { device, host } = establish();
    // ctl 与 bulk 各自的第 1 帧：升级前它们的 nonce 完全相同，
    // 两条密文异或 = 两条明文异或（keystream 重合）。
    const ctl = device.channel.seal({ k: "data", room: ROOM, from: DEVICE_ID, to: HOST_ID, n: 1, ch: "ctl" }, utf8("AAAA"));
    const bulk = device.channel.seal({ k: "bin", room: ROOM, from: DEVICE_ID, to: HOST_ID, n: 1, ch: "bulk" }, utf8("BBBB"));

    // 密文不同是必要条件；真正的判据在下面：两条都能被对端按各自的 channel 解开。
    expect(ctl.ct).not.toBe(bulk.ct);
    expect(host.channel.open(ctl)?.toString("utf8")).toBe("AAAA");
    expect(host.channel.open(bulk)?.toString("utf8")).toBe("BBBB");

    // 直接锁死 nonce 布局：前四字节是槽位（ctl=1, bulk=3），后八字节是 n。
    expect(Buffer.from(envelopeNonce("ctl", 1)).toString("hex")).toBe("000000010000000000000001");
    expect(Buffer.from(envelopeNonce("bulk", 1)).toString("hex")).toBe("000000030000000000000001");
  });

  it("篡改 ch（恶意 relay 改道）→ 解密失败：ch 在 nonce 与 AAD 里", () => {
    const { device, host } = establish();
    const envelope = device.channel.seal(
      { k: "data", room: ROOM, from: DEVICE_ID, to: HOST_ID, n: 1, ch: "ctl" },
      utf8("继续"),
    );
    const rerouted = { ...envelope, hdr: { ...envelope.hdr, ch: "bulk" } };

    expect(() => host.channel.open(rerouted as typeof envelope)).toThrowError(E2eError);
  });

  it("发送侧序号写错会立刻报错，而不是悄悄错位", () => {
    const { device } = establish();
    expect(() =>
      device.channel.seal({ k: "data", room: ROOM, from: DEVICE_ID, to: HOST_ID, n: 7 }, utf8("x")),
    ).toThrowError(E2eError);
  });

  it("握手帧不能当密文解，密文也不能当握手帧读", () => {
    const { device, host } = establish();
    const handshake = buildHandshakeEnvelope({ room: ROOM, from: DEVICE_ID, to: HOST_ID, body: { type: "hs1", ePubD: toBase64Url(Buffer.alloc(32, 2)) } });

    expect(() => host.channel.open(handshake)).toThrow();
    expect(() => readHandshakeEnvelope(sealFrom(device, "x"))).toThrow();
  });

  it("换 Path 重握手：新密钥解不开旧连接的密文（前向保密的实际含义）", () => {
    const first = establish();
    const oldEnvelope = sealFrom(first.device, "旧连接上的消息");

    // 换一根管子 = 重跑一次握手，`ee` 全新 → 密钥全新。
    const second = establish();

    try {
      second.host.channel.open(oldEnvelope);
      throw new Error("旧密文居然被新连接解开了");
    } catch (error) {
      expect((error as E2eError).code).toBe("aead_failed");
    }

    // 新连接上的一切照常工作。
    expect(second.host.channel.open(sealFrom(second.device, "新连接上的消息"))?.toString("utf8")).toBe("新连接上的消息");
  });

  it("两条方向性密钥互不相同（每个方向一把）", () => {
    const pskRoot = randomKey();
    const deviceHandshake = new DeviceHandshake(pskRoot);
    const hostHandshake = new HostHandshake(pskRoot);
    const accept = hostHandshake.acceptHello(deviceHandshake.start());
    deviceHandshake.accept(accept);

    expect(deviceHandshake.keys.kHostToDevice.equals(deviceHandshake.keys.kDeviceToHost)).toBe(false);
  });
});

describe("逻辑多路复用（票 07）", () => {
  const sealOn = (peer: Peer, channel: "ctl" | "msg" | "bulk", payload: string) => {
    const from = peer.role === "device" ? DEVICE_ID : HOST_ID;
    const to = peer.role === "device" ? HOST_ID : DEVICE_ID;
    return peer.channel.seal(
      { k: channel === "bulk" ? "bin" : "data", room: ROOM, from, to, n: peer.channel.nextSequence(channel), ch: channel },
      utf8(payload),
    );
  };

  // 这条就是整张票的收益：`bulk` 丢一帧只卡 `bulk`。升级前所有流量共用一个序号，
  // 分片丢一帧会让后面的 `ctl` / `msg` 全部卡在 sequence_gap 上——现场表现是
  // 「下载一开，聊天记录不刷新、消息发不出去」。
  it("a bulk gap does not block the control channel", () => {
    const { device, host } = establish();

    expect(host.channel.open(sealOn(device, "bulk", "chunk-1"))?.toString("utf8")).toBe("chunk-1");
    expect(host.channel.open(sealOn(device, "ctl", "status"))?.toString("utf8")).toBe("status");
    expect(host.channel.open(sealOn(device, "msg", "delta"))?.toString("utf8")).toBe("delta");

    // bulk 上丢一帧：发送方自己不会跳号，所以这里把 chunk-2 封好但**不投递**，
    // 模拟它在路上丢了。高水位线语义下 chunk-3 照常解开（issue 04：丢帧不再毒化通道）。
    const chunk2 = sealOn(device, "bulk", "chunk-2");
    const chunk3 = sealOn(device, "bulk", "chunk-3");
    expect(host.channel.open(chunk3)?.toString("utf8")).toBe("chunk-3");

    // 控制面完全不受影响：序号各自推进。
    expect(host.channel.open(sealOn(device, "ctl", "status-2"))?.toString("utf8")).toBe("status-2");
    expect(host.channel.open(sealOn(device, "msg", "delta-2"))?.toString("utf8")).toBe("delta-2");
    // 丢失的那一帧再到达时已落在水位线以下，按重放丢弃；后续照常。
    expect(host.channel.open(chunk2)).toBeUndefined();
    expect(host.channel.open(sealOn(device, "bulk", "chunk-4"))?.toString("utf8")).toBe("chunk-4");
  });

  it("keeps every channel's numbering independent in both directions", () => {
    const { device, host } = establish();

    // 两条 channel 都从 1 开始计数。
    expect(device.channel.nextSequence("ctl")).toBe(1);
    expect(device.channel.nextSequence("bulk")).toBe(1);
    device.channel.seal({ k: "data", room: ROOM, from: DEVICE_ID, to: HOST_ID, n: 1, ch: "ctl" }, utf8("a"));
    expect(device.channel.nextSequence("ctl")).toBe(2);
    expect(device.channel.nextSequence("bulk")).toBe(1);

    // 不携带 `ch` 的加密帧现在是协议错误（ADR-0008：不存在"缺省 = 单流"）。
    expect(() =>
      device.channel.seal(
        { k: "data", room: ROOM, from: DEVICE_ID, to: HOST_ID, n: device.channel.nextSequence("ctl") },
        utf8("x"),
      ),
    ).toThrowError(/缺少 hdr\.ch/);
    expect(() =>
      host.channel.open({ v: 2, hdr: { k: "data", room: ROOM, from: DEVICE_ID, to: HOST_ID, n: 1 }, ct: "AAAA" }),
    ).toThrowError(/缺少 hdr\.ch/);
  });
});
