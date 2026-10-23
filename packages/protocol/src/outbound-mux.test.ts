import { describe, expect, it, vi } from "vitest";

import { OutboundChannelMux, type OutboundQueueDiagnostic } from "./outbound-mux.js";

/** 造一个长度恰好是 `bytes` 的「帧」——测试里用它的长度当字节数，避免声明与事实不符。 */
const frame = (bytes: number, tag = ""): string => tag.padEnd(bytes, "x").slice(0, bytes);

describe("outbound queue diagnostic attribution", () => {
  const MiB = 1024 * 1024;

  it("samples queued ciphertext by source, limits frequency, and measures admitted versus written bytes", () => {
    vi.useFakeTimers({ now: 1_000 });
    let backlog = 2 * MiB;
    const samples: OutboundQueueDiagnostic[] = [];
    const written: number[] = [];
    const mux = new OutboundChannelMux<number>({ write: bytes => { written.push(bytes); }, backlog: () => backlog,
      onQueueDiagnostic: sample => { samples.push(sample); } });
    const a = { type: "runtime.event", eventType: "session.patch", runtimeId: "a", sessionId: "sa", payloadBytes: 700_000 };
    const b = { ...a, runtimeId: "b", sessionId: "sb", payloadBytes: 750_000 };
    try {
      mux.enqueue("msg", MiB / 2, MiB / 2, a);
      expect(samples).toHaveLength(0);
      mux.enqueue("msg", MiB / 2, MiB / 2, a);
      expect(samples).toHaveLength(1);
      mux.enqueue("msg", MiB, MiB, b);
      mux.enqueue("bulk", 3 * MiB, 3 * MiB);
      mux.enqueue("ctl", 128, 128, { type: "device.path", payloadBytes: 64 });
      mux.notifyDrained();
      expect(samples).toHaveLength(1);
      expect(written).toEqual([128]);
      vi.setSystemTime(6_000);
      mux.notifyDrained();
      expect(samples).toHaveLength(2);
      expect(samples[1]).toMatchObject({ queuedBytes: 5 * MiB, nonBulkQueuedBytes: 2 * MiB, bulkQueuedBytes: 3 * MiB,
        transportBacklogBytes: 2 * MiB, oldestQueuedMs: 5_000, windowMs: 5_000,
        nonBulkEnqueuedBytes: MiB + 128, nonBulkWrittenBytes: 128, otherSourceBytes: 0, sourcesTruncated: false });
      expect(samples[1]!.sources).toEqual([
        { channel: "msg", type: a.type, eventType: a.eventType, runtimeId: "a", sessionId: "sa", queuedBytes: MiB, queuedPieces: 2, oldestQueuedMs: 5_000, maxPayloadBytes: 700_000 },
        { channel: "msg", type: b.type, eventType: b.eventType, runtimeId: "b", sessionId: "sb", queuedBytes: MiB, queuedPieces: 1, oldestQueuedMs: 5_000, maxPayloadBytes: 750_000 },
      ]);
      backlog = 0;
      mux.notifyDrained();
      expect(mux.queuedBytes).toBe(0);
      expect(samples).toHaveLength(2);
      backlog = 2 * MiB;
      vi.setSystemTime(11_000);
      mux.enqueue("msg", MiB, MiB, a);
      expect(samples[2]).toMatchObject({ nonBulkEnqueuedBytes: MiB, nonBulkWrittenBytes: 2 * MiB, windowMs: 5_000 });
    } finally { mux.stop(); vi.useRealTimers(); }
  });

  it("reports overflow explicitly and keeps source aggregation and output bounded", () => {
    vi.useFakeTimers({ now: 1_000 });
    const samples: OutboundQueueDiagnostic[] = [];
    const mux = new OutboundChannelMux<number>({ write: () => {}, backlog: () => 2 * MiB,
      onQueueDiagnostic: sample => { samples.push(sample); } });
    try {
      mux.enqueue("msg", MiB, MiB);
      for (let i = 0; i < 300; i++) mux.enqueue("msg", 1_000, 1_000, { type: "runtime.event", runtimeId: `runtime-${i}`, payloadBytes: 700 });
      vi.setSystemTime(6_000);
      mux.notifyDrained();
      const sample = samples[1]!;
      expect(sample.sources).toHaveLength(8);
      expect(sample.sourcesTruncated).toBe(true);
      expect(sample.sources[0]).toMatchObject({ type: "unattributed", queuedBytes: MiB });
      expect(sample.otherSourceBytes).toBe(293_000);
      expect(sample.sources.reduce((bytes, source) => bytes + source.queuedBytes, sample.otherSourceBytes)).toBe(mux.queuedBytes);
    } finally { mux.stop(); vi.useRealTimers(); }
  });

  it("does not count rejected writes as sent or allow a diagnostic callback to interrupt delivery", () => {
    vi.useFakeTimers({ now: 1_000 });
    const samples: OutboundQueueDiagnostic[] = [];
    let reject = true;
    let backlog = 0;
    const write = vi.fn(() => { if (reject) throw new Error("blocked"); });
    const mux = new OutboundChannelMux<number>({ write, backlog: () => backlog, onQueueDiagnostic: sample => {
      samples.push(sample); throw new Error("diagnostic unavailable");
    } });
    try {
      expect(mux.enqueue("msg", MiB, MiB)).toBe(true);
      expect(samples[0]).toMatchObject({ writeErrors: 1, nonBulkWrittenBytes: 0, nonBulkQueuedBytes: MiB });
      reject = false;
      mux.notifyDrained();
      expect(write).toHaveBeenCalledTimes(2);
      expect(mux.queuedBytes).toBe(0);
      backlog = 2 * MiB;
      vi.setSystemTime(6_000);
      expect(mux.enqueue("msg", MiB, MiB)).toBe(true);
      expect(samples[1]).toMatchObject({ writeErrors: 0, nonBulkWrittenBytes: MiB, nonBulkQueuedBytes: MiB });
      mux.stop();
      vi.advanceTimersByTime(10_000);
      expect(samples).toHaveLength(2);
    } finally { mux.stop(); vi.useRealTimers(); }
  });
});

describe("bounded ordinary queue admission", () => {
  it("keeps ctl and msg budgets independent", () => {
    const mux = new OutboundChannelMux<string>({
      write: () => { throw new Error("blocked"); },
      backlog: () => Number.MAX_SAFE_INTEGER,
      ctlQueueLimitBytes: 10,
      msgQueueLimitBytes: 20,
      bulkQueueLimitBytes: 30,
      bulkLowWaterBytes: 0,
      msgLowWaterBytes: 0,
    });
    try {
      expect(mux.hasRoom("ctl", 10)).toBe(true);
      expect(mux.enqueue("ctl", "ctl", 10)).toBe(true);
      expect(mux.hasRoom("ctl", 1)).toBe(false);
      expect(mux.hasRoom("msg", 20)).toBe(true);
      expect(mux.enqueue("msg", "msg", 20)).toBe(true);
      expect(mux.hasRoom("msg", 1)).toBe(false);
      expect(mux.ctlQueuedBytes).toBe(10);
      expect(mux.msgQueuedBytes).toBe(20);
      expect(mux.queuedBytes).toBe(30);
    } finally { mux.stop(); }
  });

  it("does not silently drop an already sealed frame when a budget is reached", () => {
    const written: string[] = [];
    const mux = new OutboundChannelMux<string>({
      write: frame => written.push(frame),
      backlog: () => 1,
      msgLowWaterBytes: 0,
      msgQueueLimitBytes: 3,
    });
    try {
      expect(mux.enqueue("msg", "one", 3)).toBe(true);
      // Admission is the caller's responsibility; enqueue still retains the sealed frame.
      expect(mux.enqueue("msg", "two", 3)).toBe(true);
      expect(mux.msgQueuedBytes).toBe(6);
    } finally { mux.stop(); }
  });
});

/**
 * 这一组用例锁的是票 07 那条**没打勾**的验收项：「大文件传输期间 `ctl` 的延迟不劣化」。
 *
 * `ch` 只管序号，管不了延迟——帧最终都要依次写进同一个 socket，后写的超不过先写的。
 * 所以延迟只能靠这个调度器：`bulk` 排队等水位，`ctl` 绕过水位直接交付。下面用
 * 「模拟 socket 的待发字节数」把这件事变成可断言的行为。
 */
const harness = (options: {
  bulkLowWater?: number;
  msgLowWater?: number;
  limit?: number;
} = {}) => {
  /** 模拟 socket：写进去就变成待发字节，由测试手动消化。 */
  let backlog = 0;
  const written: string[] = [];
  const mux = new OutboundChannelMux<string>({
    write: (f) => {
      written.push(f);
      backlog += f.length;
    },
    backlog: () => backlog,
    ...(options.bulkLowWater === undefined ? {} : { bulkLowWaterBytes: options.bulkLowWater }),
    ...(options.msgLowWater === undefined ? {} : { msgLowWaterBytes: options.msgLowWater }),
    ...(options.limit === undefined ? {} : { bulkQueueLimitBytes: options.limit }),
  });
  return {
    mux,
    written,
    drain: () => {
      backlog = 0;
    },
    get backlog() {
      return backlog;
    },
  };
};

describe("outbound channel mux", () => {
  it("ctl 越过被水位压住的 bulk 直接交付", () => {
    const h = harness({ bulkLowWater: 100 });
    h.mux.enqueue("bulk", frame(10, "B1"), 10);
    h.mux.enqueue("bulk", frame(200, "B2"), 200);
    // B2 写出去之后 socket 积压 210 > 水位 100，下一片只能留在队列里。
    expect(h.written).toEqual([frame(10, "B1"), frame(200, "B2")]);
    h.mux.enqueue("bulk", frame(10, "B3"), 10);
    expect(h.written).toHaveLength(2);
    expect(h.mux.bulkQueuedBytes).toBe(10);

    // 关键：控制帧不等 bulk 消化，立刻出去。
    h.mux.enqueue("ctl", frame(2, "C1"), 2);
    expect(h.written).toEqual([frame(10, "B1"), frame(200, "B2"), frame(2, "C1")]);

    // 链路消化后才轮到被压住的 bulk。
    h.drain();
    h.mux.notifyDrained();
    expect(h.written).toEqual([frame(10, "B1"), frame(200, "B2"), frame(2, "C1"), frame(10, "B3")]);
  });

  it("bulk 压在队列里时根本不写进 socket", () => {
    const h = harness({ bulkLowWater: 100 });
    for (let i = 0; i < 50; i += 1) h.mux.enqueue("bulk", frame(1000, `B${i}`), 1000);
    // socket 只拿到第一片，其余 49 片都在应用层——这正是「不把内存变成链路缓冲」。
    expect(h.written).toEqual([frame(1000, "B0")]);
    expect(h.mux.bulkQueuedBytes).toBe(49 * 1000);
    expect(h.backlog).toBe(1000);
  });

  // 两条通道的水位是**各自独立**的（缺省值相同，见 DEFAULT_MSG_LOW_WATER_BYTES；这里刻意给
  // 不同的值，把判据分开测）。
  it("两条通道的水位各自独立：积压卡在两者之间时 msg 走、bulk 停", () => {
    const h = harness({ bulkLowWater: 100, msgLowWater: 1000 });
    h.mux.enqueue("bulk", frame(500, "B0"), 500);
    expect(h.written).toEqual([frame(500, "B0")]);

    h.mux.enqueue("msg", frame(10, "M1"), 10);
    h.mux.enqueue("bulk", frame(10, "B1"), 10);
    // 积压 510：低于 msg 水位 1000 → msg 出去；高于 bulk 水位 100 → bulk 停。
    expect(h.written).toEqual([frame(500, "B0"), frame(10, "M1")]);
    expect(h.mux.bulkQueuedBytes).toBe(10);

    // ctl 不受任何水位约束。
    h.mux.enqueue("ctl", frame(2, "C1"), 2);
    expect(h.written).toEqual([frame(500, "B0"), frame(10, "M1"), frame(2, "C1")]);
  });

  it("hasBulkRoom 在队列满时判 false，供调用方在封帧前丢片", () => {
    const h = harness({ bulkLowWater: 0, limit: 1000 });
    // 先让「socket」堵上：这一片出去了，积压也超了水位。
    h.mux.enqueue("bulk", frame(1000, "inf"), 1000);
    expect(h.written).toEqual([frame(1000, "inf")]);

    // 队列还空 → 还有空间；这片只能排队等链路消化。
    expect(h.mux.hasBulkRoom(1000)).toBe(true);
    h.mux.enqueue("bulk", frame(1000, "queued"), 1000);
    expect(h.written).toEqual([frame(1000, "inf")]);

    // 队列满了 → 判 false。调用方据此在**封帧之前**丢掉这一片，不推进任何序号。
    expect(h.mux.hasBulkRoom(1)).toBe(false);
  });

  it("队列撞上限也不丢已封好的帧：只报警一次，是内存护栏而不是流控", () => {
    const written: string[] = [];
    const overflow = vi.fn();
    const mux = new OutboundChannelMux<string>({
      write: (f) => written.push(f),
      // 链路一直堵着：所有 bulk 都只能留在队列里，把上限撞出来。
      backlog: () => 1000,
      bulkLowWaterBytes: 0,
      bulkQueueLimitBytes: 100,
      onBulkOverflow: overflow,
    });
    mux.enqueue("bulk", frame(100, "one"), 100);
    expect(written).toEqual([]);
    // 超上限也照收：丢已封好的帧会在接收侧留永久空洞（发送序号推进了、对端永远收不到）。
    expect(mux.enqueue("bulk", frame(100, "two"), 100)).toBe(true);
    expect(mux.bulkQueuedBytes).toBe(200);
    expect(overflow).toHaveBeenCalledTimes(1);
    mux.enqueue("bulk", frame(100, "three"), 100);
    expect(overflow).toHaveBeenCalledTimes(1);
  });

  it("链路通畅时保持 FIFO 顺序且队列排空", () => {
    const h = harness({ bulkLowWater: 100 });
    h.mux.enqueue("bulk", frame(1, "B1"), 1);
    h.mux.enqueue("bulk", frame(1, "B2"), 1);
    h.mux.enqueue("bulk", frame(1, "B3"), 1);
    expect(h.written).toEqual([frame(1, "B1"), frame(1, "B2"), frame(1, "B3")]);
    expect(h.mux.queuedBytes).toBe(0);
  });

  it("stop 之后不再接受任何帧", () => {
    const h = harness({ bulkLowWater: 100 });
    h.mux.stop();
    expect(h.mux.enqueue("ctl", frame(1, "C1"), 1)).toBe(false);
    expect(h.written).toEqual([]);
  });

  // `setTimeout(fn, NaN)` 会被当成 1ms：重试节拍从 10ms 变成「每 tick 一次」的空转，
  // 队列里只要压着分片就会把事件循环占住（这个项目在配对码上这么翻过一次车）。
  //
  // 这里用**写被拒**把队列压住，而不是用水位：被水位挡住走的是 `drainPollIntervalMs`
  // （缺省本来就是 1ms 密节拍），只有写被拒这条路由 `pumpIntervalMs` 管。
  it("pumpIntervalMs 非法时退回默认节拍，而不是退化成 1ms 空转", async () => {
    vi.useFakeTimers();
    try {
      const written: string[] = [];
      let refusing = true;
      const mux = new OutboundChannelMux<string>({
        write: (f) => {
          if (refusing) throw new Error("send refused");
          written.push(f);
        },
        pumpIntervalMs: Number.NaN,
      });
      mux.enqueue("bulk", frame(10, "B1"), 10);
      expect(written).toEqual([]);

      refusing = false;
      await vi.advanceTimersByTimeAsync(9);
      // 若 NaN 被当成 1ms，这里早就发出去了。
      expect(written).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      expect(written).toEqual([frame(10, "B1")]);
    } finally {
      vi.useRealTimers();
    }
  });

  // 写入层切片（issue 03）让「写被拒就重试」真的可行：片只有几 KB，缓冲区稍后就会腾出来。
  // 旧行为是当场丢掉——而帧已经封好、序号已经消耗，对端看到的是永久空洞。
  it("底层写被拒时不丢帧：重试到位；重试耗尽才放弃，且不把队列永久堵住", async () => {
    vi.useFakeTimers();
    try {
      // ① 只被拒几拍：原样按序交付（后一帧绝不能越过被拒的那一帧）。
      const written: string[] = [];
      let refusals = 2;
      const mux = new OutboundChannelMux<string>({
        write: (f) => {
          if (refusals > 0) {
            refusals -= 1;
            throw new Error("send refused");
          }
          written.push(f);
        },
        pumpIntervalMs: 10,
      });
      mux.enqueue("bulk", frame(10, "B1"), 10);
      mux.enqueue("bulk", frame(10, "B2"), 10);
      expect(written).toEqual([]);
      await vi.advanceTimersByTimeAsync(10);
      expect(written).toEqual([frame(10, "B1"), frame(10, "B2")]);

      // ② 一直拒：耗尽重试次数后放弃并上报，队列继续前进——否则这一帧会把整条队列永久堵住。
      const written2: string[] = [];
      const abandoned: string[] = [];
      const mux2 = new OutboundChannelMux<string>({
        write: (f) => {
          if (refusals === 0) throw new Error("send refused");
          written2.push(f);
        },
        pumpIntervalMs: 10,
        maxWriteAttempts: 3,
        onWriteAbandoned: (channel, attempts) => abandoned.push(`${channel}:${attempts}`),
      });
      mux2.enqueue("bulk", frame(10, "C1"), 10);
      mux2.enqueue("bulk", frame(10, "C2"), 10);
      await vi.advanceTimersByTimeAsync(50);
      expect(written2).toEqual([]);
      expect(abandoned).toEqual(["bulk:3", "bulk:3"]);

      // 链路恢复后新入队的帧照常出去：队列没有被那两帧堵死。
      refusals = 1;
      mux2.enqueue("bulk", frame(10, "C3"), 10);
      await vi.advanceTimersByTimeAsync(10);
      expect(written2).toEqual([frame(10, "C3")]);
    } finally {
      vi.useRealTimers();
    }
  });
});
