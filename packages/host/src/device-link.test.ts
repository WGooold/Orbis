/**
 * `DeviceLink` 的行为单测（spec §5.3 / §6.2）。
 *
 * 这里用真的握手与真的 AEAD，只把底层 socket 换成内存里的两口箱子——因为要验的正是
 * 「哪条路上的会话在说话」和「探针的回声算不算得对」，这两件事在假的密码学上验不出来。
 */
import { describe, expect, it, vi } from "vitest";

import {
  DeviceHandshake,
  E2eChannel,
  buildPlaintextEnvelope,
  generateX25519KeyPair,
  randomKey,
  readHandshakeEnvelope,
  toBase64Url,
  type DeviceRecord,
} from "@pi-remote/e2e";
import { EnvelopeReassembler, type EnvelopeV2, type PathKind } from "@pi-remote/protocol";

import { DeviceLink, SESSION_SYNC_WIRE_LIMIT_BYTES, type PathSink } from "./device-link.js";

const HOST_ID = "host-1";
const DEVICE_ID = "device-1";
const ROOM = "room-1";
/** 对端（设备）用 'D' 标自己的探针：host 侧只认自己的 'H'，用它验"不是自己的就原样回一遍"。 */
const PROBE_TAG_DEVICE = 0x44;

/** 假手机的一条路径：会握手、会回声探针、会发业务帧，其余什么都不做。 */
class FakePeer {
  readonly kind: PathKind;
  readonly #handshake: DeviceHandshake;
  #channel: E2eChannel | undefined;
  #probeCounter = 0;
  pingsSeen = 0;

  constructor(kind: PathKind, pskRoot: Buffer) {
    this.kind = kind;
    this.#handshake = new DeviceHandshake(pskRoot);
  }

  get ready(): boolean {
    return this.#channel !== undefined;
  }

  hello(): EnvelopeV2 {
    return this.#plain(this.#handshake.start());
  }

  /** 读 HS2、回来 HS3，并落下这条路径自己的会话密钥。 */
  accept(envelope: EnvelopeV2): EnvelopeV2 {
    const body = readHandshakeEnvelope(envelope);
    if (body.type !== "hs2") throw new Error(`期望 hs2，收到 ${body.type}`);
    const hs3 = this.#handshake.accept(body);
    this.#channel = new E2eChannel({ keys: this.#handshake.keys, role: "device" });
    return this.#plain(hs3);
  }

  /** 原样回声 —— 探针测的就是这条路自己的往返。 */
  echoPing(envelope: EnvelopeV2): EnvelopeV2 {
    const channel = this.#require();
    const payload = channel.open(envelope);
    if (payload === undefined) throw new Error("unexpected stale ping in test");
    this.pingsSeen += 1;
    return this.#seal("ping", payload, "ctl");
  }

  /** 对端自己的探针，标签是 'D'。 */
  buildProbe(): EnvelopeV2 {
    const token = Buffer.alloc(8);
    token.writeBigUInt64BE(BigInt(this.#probeCounter));
    this.#probeCounter += 1;
    return this.#seal("ping", Buffer.concat([Buffer.from([PROBE_TAG_DEVICE]), token]), "ctl");
  }

  sendData(text: string): EnvelopeV2 {
    return this.#seal("data", Buffer.from(text, "utf8"), "ctl");
  }

  open(envelope: EnvelopeV2): Buffer {
    const payload = this.#require().open(envelope);
    // 测试里没有重放场景：拿到 undefined 说明用例本身发错了帧。
    if (payload === undefined) throw new Error("unexpected stale frame in test");
    return payload;
  }

  #plain(body: unknown): EnvelopeV2 {
    return buildPlaintextEnvelope({ kind: "hs", room: ROOM, from: DEVICE_ID, to: HOST_ID, body });
  }

  #seal(kind: "data" | "ping", payload: Uint8Array, ch: "ctl" | "msg" | "bulk"): EnvelopeV2 {
    const channel = this.#require();
    return channel.seal(
      { k: kind, room: ROOM, from: DEVICE_ID, to: HOST_ID, n: channel.nextSequence(ch), ch },
      payload,
    );
  }

  #require(): E2eChannel {
    if (this.#channel === undefined) throw new Error("还没握手");
    return this.#channel;
  }
}

function deviceRecord(pskRoot: Buffer): DeviceRecord {
  return {
    deviceId: DEVICE_ID,
    devicePub: toBase64Url(generateX25519KeyPair().publicRaw),
    pskRoot: toBase64Url(pskRoot),
    label: "",
    createdAt: 0,
    revoked: false,
  };
}

/** 把 DeviceLink 与一组假手机接起来：出站的帧进 `outbox`，测试再手动喂回去。 */
function harness(input: { probeIntervalMs?: number; pskRoot: Buffer; bulkQueueLimitBytes?: number }) {
  const outbox: { kind: PathKind; envelope: EnvelopeV2 }[] = [];
  const payloads: string[] = [];
  const changes: { from: PathKind | undefined; to: PathKind | undefined }[] = [];
  /** 每一次「握手完成」通知，按路径记（同一条路上重新握手会出现两次）。 */
  const sessions: PathKind[] = [];
  const peers = new Map<PathKind, FakePeer>();
  const record = (change: { from: PathKind | undefined; to: PathKind | undefined }): void => {
    changes.push({ from: change.from, to: change.to });
  };
  const link = new DeviceLink({
    hostId: HOST_ID,
    device: deviceRecord(input.pskRoot),
    probeIntervalMs: input.probeIntervalMs ?? 0,
    ...(input.bulkQueueLimitBytes === undefined ? {} : { bulkQueueLimitBytes: input.bulkQueueLimitBytes }),
    onPayload: (payload) => payloads.push(payload.toString("utf8")),
    // 生效路径的宣布有两个来源：握手完成（`onSessionReady`）与之后换路（`onActivePathChange`）。
    // 这个装置关心的是「宣布过哪些路径」，所以两条都记进来。
    onActivePathChange: record,
    onSessionReady: (kind, _active, change) => {
      sessions.push(kind);
      if (change.changed) record(change);
    },
  });

  const attach = (
    kind: PathKind,
    backlog?: () => number,
    onWrite?: (envelope: EnvelopeV2) => void,
  ): FakePeer => {
    const peer = new FakePeer(kind, input.pskRoot);
    peers.set(kind, peer);
    const sink: PathSink = (envelope) => {
      outbox.push({ kind, envelope });
      onWrite?.(envelope);
    };
    // 多路复用器靠它判水位：`bulk` 只在「socket 还没发出去的字节」低的时候才写得进去。
    if (backlog !== undefined) sink.backlog = backlog;
    link.attach(kind, sink);
    return peer;
  };

  /**
   * 出口上出现了哪些**消息**（按 channel + 序号归组）。
   *
   * 大消息现在会被切成多片（issue 03），所以「一条消息」不再等于「一个出口条目」：
   * 同一片的所有片共用原信封的 `n`。断言必须按消息算，否则重建粒度一改这些用例就假红。
   */
  const messagesSent = (): string[] => [
    ...new Set(outbox.map((entry) => `${entry.envelope.hdr.ch}:${entry.envelope.hdr.n}`)),
  ];

  const peer = (kind: PathKind): FakePeer => {
    const existing = peers.get(kind);
    if (existing !== undefined) return existing;
    throw new Error(`${kind} 上没有对端`);
  };

  /** 在这条路径上跑完 HS1 / HS2 / HS3。 */
  const handshake = (kind: PathKind): void => {
    const target = peers.get(kind) ?? attach(kind);
    link.handle(kind, target.hello());
    const hs2 = shift("relay 或 lan 上的 HS2");
    link.handle(kind, target.accept(hs2.envelope));
  };

  const shift = (what: string): { kind: PathKind; envelope: EnvelopeV2 } => {
    const entry = outbox.shift();
    if (entry === undefined) throw new Error(`没有收到${what}`);
    return entry;
  };

  /** 让主机探一次，并把回声喂回去。 */
  const probeRoundTrip = (): void => {
    link.probeNow();
    for (const probe of outbox.splice(0, outbox.length)) {
      link.handle(probe.kind, peer(probe.kind).echoPing(probe.envelope));
    }
  };

  return { link, outbox, payloads, changes, sessions, attach, handshake, probeRoundTrip, peer, shift, messagesSent };
}

describe("DeviceLink", () => {
  it("admits sync pages before sealing, retains every slice under backlog, and releases only after the last write", async () => {
    const h = harness({ pskRoot: randomKey() });
    let backlog = 10_000_000;
    h.attach("relay", () => backlog);
    h.handshake("relay");
    const done = vi.fn();
    const payload = Buffer.alloc(1024 * 1024, 65);
    try {
      expect(h.link.sendSessionSnapshot(payload, done)).toBe(true);
      expect(h.link.sendSessionSnapshot(payload, done)).toBe(true);
      expect(h.link.sendSessionSnapshot(payload, done)).toBe(false);
      expect(h.link.sessionSyncQueuedBytes).toBeLessThanOrEqual(SESSION_SYNC_WIRE_LIMIT_BYTES);
      expect(done).not.toHaveBeenCalled();
      expect(h.outbox).toHaveLength(0);
      backlog = 0;
      await vi.waitFor(() => expect(done).toHaveBeenCalledTimes(2));
      expect(done.mock.calls).toEqual([[true], [true]]);
      expect(h.link.sessionSyncQueuedBytes).toBe(0);
      const reassembler = new EnvelopeReassembler();
      const messages: Buffer[] = [];
      for (const { envelope } of h.outbox) {
        const full = reassembler.accept(envelope);
        if (full !== undefined) messages.push(h.peer("relay").open(full));
      }
      expect(messages).toEqual([payload, payload]);
      expect(h.messagesSent()).toEqual(["msg:1", "msg:2"]);
      h.link.sendSessionSnapshot(Buffer.from("next"), done);
      expect(h.messagesSent()).toEqual(["msg:1", "msg:2", "msg:3"]);
    } finally { h.link.close(); }
  });

  it("path switch preserves sealed slices and rehandshake or revocation releases their reservations", () => {
    const h = harness({ pskRoot: randomKey() });
    h.attach("relay", () => 10_000_000);
    h.handshake("relay");
    const done = vi.fn();
    h.link.sendSessionSnapshot(Buffer.alloc(100_000), done);
    h.handshake("lan");
    expect(h.link.active).toBe("lan");
    expect(done).not.toHaveBeenCalled();
    h.attach("relay", () => 10_000_000);
    h.handshake("relay");
    expect(done.mock.calls).toEqual([[false]]);
    expect(h.link.sessionSyncQueuedBytes).toBe(0);
    h.link.setPathPreference(["relay", "lan", "p2p"]);
    h.link.sendSessionSnapshot(Buffer.alloc(100_000), done);
    h.link.close();
    expect(done.mock.calls).toEqual([[false], [false]]);
    expect(h.link.sessionSyncQueuedBytes).toBe(0);
  });
  it("每条路径各有一套会话密钥，握手完成才算这条路可用", () => {
    const harnessed = harness({ pskRoot: randomKey() });
    harnessed.attach("relay");

    expect(harnessed.link.active).toBeUndefined();

    harnessed.handshake("relay");
    expect(harnessed.link.active).toBe("relay");
    expect(harnessed.changes).toEqual([{ from: undefined, to: "relay" }]);

    // LAN 也握上手：它档位比 Relay 高，所以当拍顶替（优先级压过「先到先得」）。
    harnessed.handshake("lan");
    expect(harnessed.link.paths).toEqual(["lan", "relay"]);
    expect(harnessed.link.active).toBe("lan");
    expect(harnessed.changes).toEqual([
      { from: undefined, to: "relay" },
      { from: "relay", to: "lan" },
    ]);
  });

  it("设备上报优先级顺序后当场换路，并宣布给手机", () => {
    const harnessed = harness({ pskRoot: randomKey() });
    harnessed.handshake("lan");
    harnessed.handshake("relay");
    expect(harnessed.link.active).toBe("lan");

    // 用户把中继排到第一位：LAN 虽然可用且档位更高，也必须让位。
    harnessed.link.setPathPreference(["relay", "lan", "p2p"]);
    expect(harnessed.link.active).toBe("relay");
    expect(harnessed.changes.at(-1)).toEqual({ from: "lan", to: "relay" });

    // 排回默认顺序：LAN 重新当选，同样要宣布。
    harnessed.link.setPathPreference(["lan", "p2p", "relay"]);
    expect(harnessed.link.active).toBe("lan");
    expect(harnessed.changes.at(-1)).toEqual({ from: "relay", to: "lan" });
  });

  it("同一条路上重新握手也算「刚接上」：路径没变，但要再通知一次", () => {
    const harnessed = harness({ pskRoot: randomKey() });
    harnessed.attach("relay");
    harnessed.handshake("relay");
    expect(harnessed.sessions).toEqual(["relay"]);
    expect(harnessed.changes).toEqual([{ from: undefined, to: "relay" }]);

    // 手机重开：连的还是同一条路，Host 这边什么都不知道（会话按要求换一套新密钥）。
    harnessed.handshake("relay");
    // 通知必须照样来一次——补 runtime 目录就挂在它上面。
    expect(harnessed.sessions).toEqual(["relay", "relay"]);
    // 而生效路径确实没变，所以不算「换路」。
    expect(harnessed.changes).toEqual([{ from: undefined, to: "relay" }]);
  });

  it("可以指定路径发送：握手回执要走刚证明能通的那条路", () => {
    const harnessed = harness({ pskRoot: randomKey() });
    harnessed.handshake("lan");
    harnessed.handshake("relay");
    expect(harnessed.link.active).toBe("lan");

    // 指定 relay：出站必须落在 relay 上，而不是生效路径 lan —— Host 手里那条「生效路径」
    // 可能早就死了，而刚握完手的那条一定通。
    expect(harnessed.link.sendOn("relay", Buffer.from("走 relay", "utf8"), "ctl")).toBe(true);
    const sent = harnessed.shift("指定路径的帧");
    expect(sent.kind).toBe("relay");
    expect(harnessed.peer("relay").open(sent.envelope).toString("utf8")).toBe("走 relay");
  });

  it("入站跟着来路走，出站跟着生效路径走", () => {
    const harnessed = harness({ pskRoot: randomKey() });
    harnessed.handshake("lan");
    expect(harnessed.link.active).toBe("lan");

    // 对端从 LAN 发业务帧：Host 收下明文。
    harnessed.link.handle("lan", harnessed.peer("lan").sendData("从 LAN 上来"));
    expect(harnessed.payloads).toEqual(["从 LAN 上来"]);

    // 出站落在生效路径（LAN）上，且能被对端解开。
    expect(harnessed.link.send(Buffer.from("出站", "utf8"), "ctl")).toBe(true);
    const sent = harnessed.shift("出站帧");
    expect(sent.kind).toBe("lan");
    expect(harnessed.peer("lan").open(sent.envelope).toString("utf8")).toBe("出站");
  });

  it("对端的探针必须原样回声，否则对端测不出这条路自己的往返", () => {
    const harnessed = harness({ pskRoot: randomKey() });
    harnessed.handshake("relay");

    harnessed.link.handle("relay", harnessed.peer("relay").buildProbe());
    const echo = harnessed.shift("探针回声");
    expect(echo.kind).toBe("relay");
    // 回声必须能被对端解开、且内容逐字节相同——它拿这个算自己的 RTT。
    expect(harnessed.peer("relay").open(echo.envelope)).toEqual(
      Buffer.concat([Buffer.from([PROBE_TAG_DEVICE]), Buffer.alloc(8)]),
    );
  });

  it("自己的探针拿回声算出 RTT", () => {
    const harnessed = harness({ pskRoot: randomKey() });
    harnessed.handshake("relay");
    harnessed.handshake("lan");

    expect(harnessed.link.activeRttMs).toBeUndefined();
    harnessed.probeRoundTrip();
    // 基准值只能来自它自己的回声：没有回声就永远是 undefined。生效路径是 lan（默认最高档）。
    expect(harnessed.link.active).toBe("lan");
    expect(harnessed.link.activeRttMs).toBeGreaterThanOrEqual(0);
  });

  it("只有一条路径时不发探针——没有可比较的对象，探了纯属浪费流量", async () => {
    const harnessed = harness({ pskRoot: randomKey(), probeIntervalMs: 10 });
    harnessed.handshake("relay");

    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(harnessed.outbox).toHaveLength(0);

    harnessed.handshake("lan");
    await vi.waitFor(() => {
      expect(harnessed.outbox.length).toBeGreaterThan(0);
    });
    // 两条路都要探，而不是只探候选那条——当前路径的数值是比较的基准。
    expect(new Set(harnessed.outbox.map((entry) => entry.kind))).toEqual(new Set(["lan", "relay"]));
  });

  it("一条路径断开就立刻从候选里摘掉，会话也随之作废", () => {
    const harnessed = harness({ pskRoot: randomKey() });
    harnessed.handshake("lan");
    harnessed.handshake("relay");
    expect(harnessed.link.active).toBe("lan");

    harnessed.link.detach("lan");
    expect(harnessed.link.active).toBe("relay");
    expect(harnessed.changes).toEqual([
      { from: undefined, to: "lan" },
      { from: "lan", to: "relay" },
    ]);
    // 会话一起丢掉：重连要有新密钥，不能沿用旧的（§6.2），所以旧的对端帧不再被消化。
    expect(harnessed.link.handle("lan", harnessed.peer("lan").sendData("旧会话的帧"))).toBe(false);
    expect(harnessed.payloads).toEqual([]);
  });

  it("没有可用路径时出站明确失败，而不是静默丢掉", () => {
    const harnessed = harness({ pskRoot: randomKey() });
    expect(harnessed.link.send(Buffer.from("没人可送", "utf8"), "ctl")).toBe(false);
  });

  /**
   * 票 07 那条一直没打勾的验收项：**大文件传输期间控制帧的延迟不劣化**。
   *
   * `hdr.ch` 只把序号分开了，投递顺序一点没变——所有帧仍然依次写进同一条 socket，后写的
   * 超不过先写的。所以「控制帧排在分片后面」只能靠出站多路复用器解决：分片留在应用层等水位，
   * 控制帧绕过水位直接交付。这组用例把那个行为钉死在 `DeviceLink` 这一层——它正是当初
   * 「下载一开，控制全废」缺的那一环。
   */
  describe("下载期间控制帧不被分片堵住", () => {
    it("控制帧越过已排队的 bulk 先出去", async () => {
      const harnessed = harness({ pskRoot: randomKey() });
      /** 模拟 socket 的待发字节：0 = 链路通畅，大数 = 手机读不过来。 */
      let backlog = 0;
      harnessed.attach("relay", () => backlog);
      harnessed.handshake("relay");
      harnessed.outbox.length = 0;

      const chunk = new Uint8Array(64 * 1024);
      // 第一片走得掉（链路空）。注意一条 64 KiB 的分片现在会拆成多片：这正是票 03 的落点
      // ——一次交付远小于水位，闸门才真的是节拍器。
      expect(harnessed.link.sendBinary(chunk)).toBe(true);
      expect(harnessed.messagesSent()).toEqual(["bulk:1"]);
      const firstMessagePieces = harnessed.outbox.length;
      expect(firstMessagePieces).toBeGreaterThan(1);
      backlog = 4 * 1024 * 1024;

      // 链路堵住之后，后面几片只能留在应用层排队——它们根本没有写进 socket。
      for (let i = 0; i < 5; i += 1) expect(harnessed.link.sendBinary(chunk)).toBe(true);
      expect(harnessed.outbox).toHaveLength(firstMessagePieces);

      // 关键断言：控制帧不等分片消化，当场出去——它排在队尾，而分片还压在应用层。
      expect(harnessed.link.send(Buffer.from("用户发的消息", "utf8"), "ctl")).toBe(true);
      expect(harnessed.outbox).toHaveLength(firstMessagePieces + 1);
      expect(harnessed.messagesSent()).toEqual(["bulk:1", "ctl:1"]);
      expect(harnessed.outbox.at(-1)?.envelope.hdr.k).toBe("data");
      expect(harnessed.outbox.at(-1)?.envelope.hdr.ch).toBe("ctl");

      // 链路恢复后才轮到被压住的分片。
      backlog = 0;
      await vi.waitFor(() => {
        expect(harnessed.messagesSent()).toEqual(["bulk:1", "ctl:1", "bulk:2", "bulk:3", "bulk:4", "bulk:5", "bulk:6"]);
      });
    });

    /**
     * 票 03 的验收量：**弱链路下一件有多大、控制帧前面最多排多少字节**。
     *
     * 真正的验收是「88 MB 下载期间 ctl/msg 的 P95 延迟 ≤ 空闲基线 2 倍」（ADR-0007 里那条
     * 一直没打勾的项），那需要在真实弱链路上实测。这里把它的**算术前提**钉住：一次写进
     * socket 的字节数由片大小封顶，于是控制帧前面最多是「水位 + 一件」——而不是一整条
     * 1.34 MB 的信封。前者在 1 Mbit/s 上是 0.6 s 的上界，后者是 11 s。
     */
    it("一件的大小被封顶：控制帧前面最多是「水位 + 一件」，不是一整条信封", async () => {
      const harnessed = harness({ pskRoot: randomKey() });
      let backlog = 0;
      // 真实 socket 会把写出去的字节记进「还没交给内核」的积压里——水位判据看的正是它。
      // 不模拟这一步，闸门就永远开着，这条用例也就测不到任何东西。
      harnessed.attach("relay", () => backlog, (envelope) => {
        backlog += JSON.stringify(envelope).length;
      });
      harnessed.handshake("relay");
      harnessed.outbox.length = 0;

      const wireBytes = (index: number): number =>
        JSON.stringify(harnessed.outbox[index]?.envelope ?? {}).length;
      // 链路先通畅：水位以内的片进 socket，之后闸门自然关死（积压已经超过水位）。
      const chunk = new Uint8Array(1024 * 1024);
      expect(harnessed.link.sendBinary(chunk)).toBe(true);
      expect(harnessed.outbox.length).toBeGreaterThan(1);
      const piecesWritten = harnessed.outbox.length;

      // 控制帧插队：它前面只有已经写进 socket 的那点字节（收不回来），而后面排着整条分片。
      expect(harnessed.link.send(Buffer.from("ping", "utf8"), "ctl")).toBe(true);
      const controlIndex = harnessed.outbox.findIndex((entry) => entry.envelope.hdr.ch === "ctl");
      expect(controlIndex).toBeGreaterThan(0);

      // 闸门关死之后，后面 160 多片一片都没写出去——它们只是留在应用层。
      expect(controlIndex).toBe(piecesWritten);

      // ① 一次写出的字节数：没有任何一条超过「一件」的量级（片 = 8 KiB 的 ct + 片头）。
      const biggestWrite = Math.max(...Array.from({ length: controlIndex }, (_, i) => wireBytes(i)));
      expect(biggestWrite).toBeLessThan(9 * 1024);

      // ② 控制帧前面的字节数 ≤ bulk 水位 + 一件：这就是它要等的东西的上界。
      const bytesAhead = Array.from({ length: controlIndex }, (_, i) => wireBytes(i)).reduce((a, b) => a + b, 0);
      expect(bytesAhead).toBeLessThanOrEqual(64 * 1024 + 9 * 1024);
    });

    it("队列排满时在封帧之前丢片，而不是封了再丢（后者会留永久空洞）", async () => {
      const harnessed = harness({ pskRoot: randomKey(), bulkQueueLimitBytes: 4 * 1024 * 1024 });
      let backlog = 1024 * 1024 * 1024;
      harnessed.attach("relay", () => backlog);
      harnessed.handshake("relay");
      harnessed.outbox.length = 0;

      const chunk = new Uint8Array(1024 * 1024);
      // 队列上限 4 MiB、每条消息（含片头）约 1.4 MiB：前两条进队列，第三条必须在**封帧之前**
      // 被拒。封了再丢会推进发送序号却到不了对端——那条数据就永久丢了（接收侧只查高水位线，
      // 不会报错，也不会毒化 channel），所以必须在封帧前拦下。
      // 这个上限是刻意调小的：缺省值比任何一条传输自己的在途窗口都大得多（正常撞不到它），
      // 这里要逼出来的正是「撞到护栏时怎么退化」。
      expect(harnessed.link.sendBinary(chunk)).toBe(true);
      expect(harnessed.link.sendBinary(chunk)).toBe(true);
      expect(harnessed.link.sendBinary(chunk)).toBe(false);

      // 被拒的那一片没有消耗任何序号：放行后 bulk 上只有 `n = 1` 和 `n = 2`。
      backlog = 0;
      await vi.waitFor(() => {
        expect(harnessed.messagesSent()).toEqual(["bulk:1", "bulk:2"]);
      });
      expect(harnessed.outbox.every((entry) => entry.envelope.hdr.ch === "bulk")).toBe(true);
    });
  });

  /**
   * `attach` 的幂等性。
   *
   * LAN / P2P 的调用方是**每收到一帧**就 attach 一次（`host-service` 的 `onEnvelope` 把随帧传下来
   * 的出口原样转给 `DeviceLink`）。所以 `attach` 一旦有「重建调度器」这种副作用，下载期间每一次
   * 读盘请求都会把队列里已封好的分片清掉——而它们的发送序号早就消耗了，对端收到的是**永久**
   * 空洞。这组用例把「旧队列只在**新会话确认**时才作废」钉死。
   */
  describe("attach 幂等：重复挂出口不许动队列", () => {
    it("重复 attach 之后，被水位压住的分片照样按序号连续发出", async () => {
      const harnessed = harness({ pskRoot: randomKey() });
      /** 模拟 socket 的待发字节：0 = 链路通畅，大数 = 手机读不过来。 */
      let backlog = 0;
      harnessed.attach("relay", () => backlog);
      harnessed.handshake("relay");
      harnessed.outbox.length = 0;

      const chunk = new Uint8Array(64 * 1024);
      // 链路空，第一条消息当场出去（它由多片组成）。
      expect(harnessed.link.sendBinary(chunk)).toBe(true);
      expect(harnessed.messagesSent()).toEqual(["bulk:1"]);
      const firstMessagePieces = harnessed.outbox.length;

      // 链路堵住：后两条只能留在应用层队列里。
      backlog = 4 * 1024 * 1024;
      expect(harnessed.link.sendBinary(chunk)).toBe(true);
      expect(harnessed.link.sendBinary(chunk)).toBe(true);
      expect(harnessed.outbox).toHaveLength(firstMessagePieces);

      // 手机这时又发来一帧（读盘请求 / 心跳），调用方于是在同一条路上再挂一次出口。
      harnessed.attach("relay", () => backlog);

      // 链路恢复：三条消息必须都到，且序号连续 —— 缺一个就是接收侧的永久空洞。
      backlog = 0;
      await vi.waitFor(() => {
        expect(harnessed.messagesSent()).toEqual(["bulk:1", "bulk:2", "bulk:3"]);
      });
      expect(harnessed.outbox.every((entry) => entry.envelope.hdr.ch === "bulk")).toBe(true);
    });

    it("同一条路上重新握手：旧会话排队的帧作废，新会话序号从 1 重新开始", async () => {
      const harnessed = harness({ pskRoot: randomKey() });
      let backlog = 0;
      harnessed.attach("relay", () => backlog);
      harnessed.handshake("relay");
      harnessed.outbox.length = 0;

      const chunk = new Uint8Array(1024 * 1024);
      expect(harnessed.link.sendBinary(chunk)).toBe(true);
      backlog = 4 * 1024 * 1024;
      expect(harnessed.link.sendBinary(chunk)).toBe(true);
      expect(harnessed.link.sendBinary(chunk)).toBe(true);
      expect(harnessed.messagesSent()).toEqual(["bulk:1"]);

      // 手机重连到同一条路：新 socket、新出口，并且重跑一遍握手（每次 HS1 都换一套密钥）。
      // 清空 outbox 只是脚手架需要 —— `shift` 拿的是队首，而被压住的那两片在 mux 队列里、不在
      // outbox 里。
      harnessed.outbox.length = 0;
      harnessed.attach("relay", () => backlog);
      harnessed.handshake("relay");
      harnessed.outbox.length = 0;

      // 上一条会话压在队列里的 `n = 2` / `n = 3` 属于死掉的会话，只能丢掉：
      // 灌进新 socket 会被对端当成新会话的帧，反而污染新会话。
      backlog = 0;
      expect(harnessed.link.sendBinary(chunk)).toBe(true);
      await vi.waitFor(() => {
        expect(harnessed.messagesSent()).toEqual(["bulk:1"]);
      });
    });
  });
});
