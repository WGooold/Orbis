/**
 * P2P 管理器测试：进程内 WebRTC 回环（无 STUN，host candidate 直连）。
 * 验证的是信令状态机与帧搬运，不是打洞本身——打洞只在真机/跨网环境有意义。
 */
import { PeerConnection } from "node-datachannel";
import { describe, expect, it } from "vitest";

import { PROTOCOL_VERSION, type EnvelopeV2 } from "@pi-remote/protocol";

import { HostP2pManager } from "./p2p-manager.js";

/** 等待一个可能要若干次轮询才成立的条件（WebRTC 连接是异步的）。 */
async function waitFor<T>(produce: () => T | undefined, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = produce();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error("等待超时");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** 假手机：answerer 侧的 PeerConnection，直接跟 manager 交换 SDP。 */
class FakeDevice {
  readonly incoming: string[] = [];
  /** 数据通道真正 open 过的次数——用它判断「这次打洞成了」，而不是只看 manager.has()。 */
  readonly opened: boolean[] = [];
  #peer: PeerConnection;
  #channel: ReturnType<PeerConnection["createDataChannel"]> | undefined;
  /** 当前这一代连接的数据通道开通信号（每次 acceptOffer 换一代）。 */
  #ready: Promise<void> = Promise.resolve();
  #markReady: (() => void) | undefined;
  /** 连接代数。旧一代的迟到回调靠它辨认——不能拿 `this.#peer` 比，那会误伤新一代。 */
  #generation = 0;

  constructor(private readonly sendToHost: (message: Record<string, unknown>) => void) {
    this.#peer = this.#newPeer();
  }

  /**
   * 等当前这一代的数据通道真正开通。
   *
   * 发送前**必须**等：`onDataChannel` 是异步来的，通道还没赋值时 `sendMessage` 会被
   * `#channel?.` **静默丢弃**，于是发送方只能干等超时——症状是「偶发 15 秒超时」，
   * 而且现场什么都不报。别用「offer 到手」当就绪信号：那只代表 gather 完了。
   */
  async waitChannel(timeoutMs = 10_000): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.#ready,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error(`假手机的数据通道 ${timeoutMs}ms 内未开通`)), timeoutMs);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /**
   * 收到 Host 的 offer。
   *
   * **一份 offer = 一条全新的连接**，所以这里要换代：真机发 `p2p.request` 之前一定先
   * `closeP2p()`，PeerConnection 是新建的（见 `RelayClient.startP2pIfPossible`），永远不会
   * 把新 offer 当成旧连接的 renegotiation。把另一条连接的 SDP（不同 ICE ufrag/pwd、不同
   * DTLS 指纹）喂进已连上的 PeerConnection，libdatachannel 会**直接崩掉整个 worker**——
   * 无堆栈、`Tests (3)` 但 `tests 0ms`，在 CI 上就是那个查不出来的 flake。
   */
  acceptOffer(sdp: string): void {
    this.#recreate();
    this.#peer.setRemoteDescription(sdp, "offer");
  }

  sendEnvelope(envelope: EnvelopeV2): void {
    this.#channel?.sendMessage(JSON.stringify({ type: "v2.frame", protocolVersion: PROTOCOL_VERSION, envelope }));
  }

  close(): void {
    this.#closeCurrent();
  }

  #newPeer(): PeerConnection {
    const generation = (this.#generation += 1);
    const peer = new PeerConnection("fake-device", { iceServers: [] });
    this.#ready = new Promise<void>((resolve) => {
      this.#markReady = resolve;
    });
    peer.onGatheringStateChange((state) => {
      if (state !== "complete") return;
      // 读闭包里的 peer：换代之后，旧连接的迟到回调不能去读新连接的本地描述。
      const local = peer.localDescription();
      if (local === undefined || local === null) return;
      this.sendToHost({ type: "p2p.answer", sdp: local.sdp });
    });
    peer.onDataChannel((channel) => {
      if (generation !== this.#generation) return;
      this.#channel = channel;
      channel.onOpen(() => {
        this.opened.push(true);
        this.#markReady?.();
      });
      channel.onMessage((raw) => {
        if (typeof raw === "string") this.incoming.push(raw);
      });
    });
    return peer;
  }

  #closeCurrent(): void {
    try {
      this.#channel?.close();
    } catch {
      // 换代时旧通道可能已经坏了，关不掉就算了。
    }
    try {
      this.#peer.close();
    } catch {
      // 同上。
    }
    this.#channel = undefined;
  }

  #recreate(): void {
    this.#closeCurrent();
    this.#peer = this.#newPeer();
  }
}

function hsEnvelope(from: string): EnvelopeV2 {
  return {
    v: 2,
    hdr: { k: "hs", room: "room-1", from, to: "host-1", n: 0 },
    ct: "aGFsbG8", // 未加密帧：pair|hs 序号 0，ct 是明文
  };
}

describe("HostP2pManager", () => {
  it("手机 answer 后数据通道开通，信封双向可达", { timeout: 30_000 }, async () => {
    let device: FakeDevice | undefined;
    const offers: string[] = [];
    const envelopes: Array<{ deviceId: string; envelope: EnvelopeV2 }> = [];
    const manager = new HostP2pManager({
      stunServers: [],
      sendToDevice: (_deviceId, message) => {
        if (message["type"] === "p2p.offer") {
          offers.push(message["sdp"] as string);
          device?.acceptOffer(message["sdp"] as string);
        }
      },
      onEnvelope: (deviceId, envelope, sink) => {
        envelopes.push({ deviceId, envelope });
        // 原路回一帧，验证 sink 方向。
        sink(hsEnvelope("host-1"));
      },
      onPathDown: () => {},
    });

    device = new FakeDevice((message) => {
      if (message["type"] === "p2p.answer") manager.acceptAnswer("device-1", message["sdp"] as string);
    });
    try {
      manager.startOffer("device-1");
      await waitFor(() => (offers.length > 0 ? offers : undefined));
      await device.waitChannel(); // 通道开通才发帧：早了会被静默丢掉，然后干等超时

      // 手机发 HS1：到达 host 的 onEnvelope，并收到 host 的回帧。
      device.sendEnvelope(hsEnvelope("device-1"));
      const received = await waitFor(() => envelopes[0]);
      expect(received.deviceId).toBe("device-1");
      expect(received.envelope.hdr.k).toBe("hs");
      expect(received.envelope.hdr.from).toBe("device-1");

      const echoed = await waitFor(() => device?.incoming[0]);
      const parsed = JSON.parse(echoed) as { envelope: EnvelopeV2 };
      expect(parsed.envelope.hdr.from).toBe("host-1");
      expect(manager.has("device-1")).toBe(true);
    } finally {
      device.close();
      manager.stopAll();
    }
  });

  it("answer 没有对应 offer 时被丢弃，不崩", () => {
    const manager = new HostP2pManager({
      stunServers: [],
      sendToDevice: () => {},
      onEnvelope: () => {},
      onPathDown: () => {},
    });
    expect(() => manager.acceptAnswer("ghost", "v=0")).not.toThrow();
    expect(manager.has("ghost")).toBe(false);
    manager.stopAll();
  });

  it("重建：同一设备再次 startOffer 时旧连接让位", { timeout: 30_000 }, async () => {
    const offers: string[] = [];
    let device: FakeDevice | undefined;
    const manager = new HostP2pManager({
      stunServers: [],
      sendToDevice: (_deviceId, message) => {
        if (message["type"] === "p2p.offer") {
          offers.push(message["sdp"] as string);
          device?.acceptOffer(message["sdp"] as string);
        }
      },
      onEnvelope: () => {},
      onPathDown: () => {},
    });
    device = new FakeDevice((message) => {
      if (message["type"] === "p2p.answer") manager.acceptAnswer("device-1", message["sdp"] as string);
    });
    try {
      manager.startOffer("device-1");
      await waitFor(() => (offers.length > 0 ? offers : undefined));
      await device.waitChannel();
      const firstPeerConnected = manager.has("device-1");

      manager.startOffer("device-1"); // 重建
      await waitFor(() => (offers.length >= 2 ? offers : undefined));
      await device.waitChannel(); // 换过代之后这一条也要真的连上，不是「谁都不通」也算让位
      expect(firstPeerConnected).toBe(true);
      expect(manager.has("device-1")).toBe(true);
      expect(device.opened.length).toBeGreaterThanOrEqual(2);
    } finally {
      device.close();
      manager.stopAll();
    }
  });

  // ── 「P2P 优先、失败降级中继」的策略层（借鉴 RustDesk 的尝试上限 + direct_failures）──

  it("打洞超时：到点仍未连接就判失败并回落", { timeout: 10_000 }, async () => {
    const downs: string[] = [];
    const logs: string[] = [];
    const manager = new HostP2pManager({
      stunServers: [],
      sendToDevice: () => {}, // 对端永远不 answer：这是「打洞不通」的最小复现
      onEnvelope: () => {},
      onPathDown: (deviceId) => downs.push(deviceId),
      attemptTimeoutMs: 150,
      log: (line) => logs.push(line),
    });

    expect(manager.startOffer("device-1")).toBeUndefined();
    expect(manager.has("device-1")).toBe(true);

    await waitFor(() => (downs.length > 0 ? downs : undefined));
    expect(manager.has("device-1")).toBe(false);
    expect(logs.some((line) => line.includes("判失败"))).toBe(true);
    expect(manager.consecutiveFailures("device-1")).toBe(1);
    manager.stopAll();
  });

  it("连续失败到阈值后进入冷却，冷却期内拒绝新的打洞请求", { timeout: 10_000 }, async () => {
    const manager = new HostP2pManager({
      stunServers: [],
      sendToDevice: () => {},
      onEnvelope: () => {},
      onPathDown: () => {},
      attemptTimeoutMs: 120,
      maxConsecutiveFailures: 2,
      cooldownMs: 60_000,
    });

    manager.startOffer("device-1");
    await waitFor(() => (manager.consecutiveFailures("device-1") >= 1 ? true : undefined));
    // 阈值前还允许重试。
    expect(manager.cooldownRemainingMs("device-1")).toBe(0);

    manager.startOffer("device-1");
    await waitFor(() => (manager.consecutiveFailures("device-1") >= 2 ? true : undefined));
    expect(manager.cooldownRemainingMs("device-1")).toBeGreaterThan(0);

    // 第三次：拒绝，且不建 peer——冷却的意义就是「别再白跑一遍完整超时」。
    const refusal = manager.startOffer("device-1");
    expect(refusal?.reason).toBe("cooldown");
    expect(refusal?.retryInMs).toBeGreaterThan(0);
    expect(manager.has("device-1")).toBe(false);
    manager.stopAll();
  });

  it("成功连接清零失败计数：之后的失败重新从第 1 次算", { timeout: 30_000 }, async () => {
    let device: FakeDevice | undefined;
    const manager = new HostP2pManager({
      stunServers: [],
      sendToDevice: (_deviceId, message) => {
        if (message["type"] === "p2p.offer") device?.acceptOffer(message["sdp"] as string);
      },
      onEnvelope: () => {},
      onPathDown: () => {},
      // CI WebRTC loopback setup can exceed 200ms under load; only the failure count matters here.
      attemptTimeoutMs: 5_000,
      maxConsecutiveFailures: 2,
      cooldownMs: 60_000,
    });

    try {
      // 先失败一次（没有对端）。
      manager.startOffer("device-1");
      await waitFor(() => (manager.consecutiveFailures("device-1") >= 1 ? true : undefined));

      // 再连一次真对端：成功即清零。
      device = new FakeDevice((message) => {
        if (message["type"] === "p2p.answer") manager.acceptAnswer("device-1", message["sdp"] as string);
      });
      manager.startOffer("device-1");
      await waitFor(() => (device?.opened.length ? true : undefined));
      await waitFor(() => (manager.consecutiveFailures("device-1") === 0 ? true : undefined));

      // 再失败一次：若清零没生效，这里就该到阈值并进冷却了。
      device.close();
      device = undefined;
      manager.startOffer("device-1");
      await waitFor(() => (manager.consecutiveFailures("device-1") >= 1 ? true : undefined));
      expect(manager.consecutiveFailures("device-1")).toBe(1);
      expect(manager.cooldownRemainingMs("device-1")).toBe(0);
    } finally {
      device?.close();
      manager.stopAll();
    }
  });
});
