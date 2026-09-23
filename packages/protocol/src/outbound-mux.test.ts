import { describe, expect, it, vi } from "vitest";

import { OutboundChannelMux } from "./outbound-mux.js";

/** 造一个长度恰好是 `bytes` 的「帧」——测试里用它的长度当字节数，避免声明与事实不符。 */
const frame = (bytes: number, tag = ""): string => tag.padEnd(bytes, "x").slice(0, bytes);

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