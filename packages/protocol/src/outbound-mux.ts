/**
 * 出站逻辑多路复用：让 `ctl` / `msg` 不排在 `bulk` 后面。
 *
 * ## 为什么光有 `hdr.ch` 不够
 *
 * `ch` 解决的是**序号**问题（`bulk` 丢帧不再连累控制的 `sequence_gap`），但它对**延迟**无能为力：
 * 不管信封里写着哪个 channel，它们最终都要依次写进**同一个** socket。WebSocket 是单条有序字节流，
 * 后写进去的帧不可能在那个字节流里超过先写进去的。所以「控制帧排在分片后面」这件事，
 * 只要分片**已经**进了 socket，channel 就救不了。
 *
 * 唯一的出路是**不让分片进 socket**：把等待队列放在应用层，只把 `bulk` 交付给 socket 直到
 * 它的待发字节数逼近水位；`ctl` / `msg` 则绕过这个水位直接交付。这样一条新产生的控制帧
 * 前面最多只剩「已经在线路上、收不回来」的那一点字节（水位 + 一帧）。
 *
 * ## 与「丢片不排队」的关系
 *
 * 票 07 定的语义是 `bulk` 限速靠**丢片**（pull 调度器按 chunk 重传，代价是一次 RTO 而不是重连），
 * 因为「排队会把内存变成链路的缓冲」（`cdc1d80` 翻车处）。这里不违背它，只是把「排队」收窄成一
 * 个**有界的小队列**：量级是一两个 chunk，不是整窗。真正需要丢的场合（Host 侧、封帧之前）
 * 由 `hasBulkRoom()` 提前拒绝，见下。
 *
 * ## 绝不在这里丢**已封好的帧**
 *
 * 这个类只接受**已经封好信封**的帧。丢一个已封好的信封会烧掉一个 nonce 与那份带宽，
 * 却没有换来任何东西；接收侧现在只查高水位线（issue 04），丢帧不再毒化通道，
 * 但"在封帧之前丢"依然是对的——省下的东西白省不如不花。所以：
 *
 * - Host 侧要丢就**在封帧之前**丢——问 `hasBulkRoom()`，不够就别封。
 * - 底层**写被拒**时不能丢：放在队首重试（`onWriteAbandoned` 只在重试耗尽后报出来）。
 *   写入层切片（见 `piece.ts`）让这一条真正可执行——片只有几 KB，而一次 1.34 MB 的写入
 *   被拒后几乎没有重试的余地（缓冲区只会更满）。
 * - 中转侧（Relay）**一律不丢**：它只搬字节、看不到 `transferId`，丢了无法让任何一方自愈。
 *   队列超上限时退化成「照发」（等价于没有这条上限时的行为），而不是丢。
 */

/** 逻辑 channel。与 `EnvelopeChannelSchema` 同集合，这里独立声明是为了避免与 `index.ts` 循环引用。 */
export type MuxChannel = "ctl" | "msg" | "bulk";

export type OutboundMuxOptions<T> = {
  /** 把一帧交给底层传输（`socket.send` / `dataChannel.send`）。 */
  write: (frame: T) => void;
  /**
   * 底层传输还没发出去的字节数（`ws.bufferedAmount` / `RTCDataChannel.bufferedAmount`）。
   * 不提供 = 不做水位控制，只剩优先级重排。
   */
  backlog?: () => number;
  /** `bulk` 只在 backlog 不超过它时交付。缺省 [DEFAULT_BULK_LOW_WATER_BYTES]。 */
  bulkLowWaterBytes?: number;
  /**
   * `msg` 的水位。**缺省与 `bulk` 相同**——见 [DEFAULT_MSG_LOW_WATER_BYTES]。
   */
  msgLowWaterBytes?: number;
  /**
   * `bulk` 等待队列的字节上限。
   *
   * 它是**内存护栏**：超过它只会报警（`onBulkOverflow`），**不会丢帧**——已封好的帧丢了就是
   * 永久空洞（见文件头）。流控由 `hasBulkRoom()` 交给**能在封帧之前丢**的调用方（主机侧），
   * 而正常的在途量由传输自己的窗口（pull / ack 窗口）兜住，所以这个上限不该被撞到。
   */
  bulkQueueLimitBytes?: number;
  /** `bulk` 因水位被压在队列里。用于观测「限速是主动降速，不是故障」。 */
  onBulkStalled?: (queuedBytes: number) => void;
  /** 队列超上限且不拒绝时告警一次（内存风险可见）。 */
  onBulkOverflow?: (queuedBytes: number) => void;
  /** 重试被水位压住的 `bulk` 的间隔。缺省 [DEFAULT_PUMP_INTERVAL_MS]。 */
  pumpIntervalMs?: number;
  /**
   * **被 socket 积压挡住时**的复查间隔。缺省 [DEFAULT_DRAIN_POLL_INTERVAL_MS]。
   *
   * 与 `pumpIntervalMs` 分开，是因为两种「等」的性质不同：写被拒是**对端有问题**（慢一点重试
   * 没关系，而重试次数本来就只有几次），被水位挡住是**链路正在正常工作、只是还没消化完**
   * （越早复查，链路就越不容易空转）。缺省值不是随手取的：节拍就是吞吐上界，见该常量的注释。
   */
  drainPollIntervalMs?: number;
  /** 一帧从排队到真正写出超过它时告警（秒级）。用于把「控制面为什么还慢」量化出来。 */
  onBulkQueuedTooLong?: (queuedMs: number, queuedBytes: number) => void;
  /**
   * 底层写入连续被拒达到上限，这一帧只能丢掉。
   *
   * 调用方拿到它应当把那条路径判死（已消耗的序号收不回来了）——例如 Host 的 P2P 出口
   * 在通道关闭时就是这样。**正常情况不应出现**：写被拒先留在队首重试。
   */
  onWriteAbandoned?: (channel: MuxChannel, attempts: number, error: unknown) => void;
  /** 写被拒后最多重试几次。缺省 [DEFAULT_MAX_WRITE_ATTEMPTS]。 */
  maxWriteAttempts?: number;
};

/**
 * `bulk` 的水位。
 *
 * 它直接决定「一条控制帧最多要等多少字节」：写进 socket 的分片收不回来，所以一条控制帧前面
 * 只可能剩「水位 + 正在写的那一件」。取 64 KiB 是因为写入层切片（[ADR-0010]）之后一件只有
 * 8 KiB——水位再往上调只是让控制帧多等，换不来吞吐（吞吐由复查节拍决定，见
 * [DEFAULT_DRAIN_POLL_INTERVAL_MS]）。
 *
 * [ADR-0010]: ../../../docs/adr/0010-write-layer-slicing.md
 */
export const DEFAULT_BULK_LOW_WATER_BYTES = 64 * 1024;
/**
 * `msg` 的水位。**与 `bulk` 相同。**
 *
 * 它原本是 1 MiB，理由是「会话快照可能好几 MB，水位太紧会把它压住」。写入层切片之后这条理由
 * 不成立了：一条消息被切成 8 KiB 的片，水位与「一次交付多大」的比较关系已经反过来。而更宽的
 * 水位是有代价的——水位就是「一条控制帧前面最多能有多少字节」，`msg` 水位 1 MiB 意味着
 * 任何一条大 `msg` 都能把 socket 积压抬到 1 MB，其后的 `ctl` / `msg` 都要等 1 MB / 带宽
 * （弱链路上又是秒级，正是票 03 要修的那个现象）。`msg` 的优先级仍然高于 `bulk`：
 * `#pump` 里 `msg` 先于 `bulk` 取，所以两者水位相同也不会互相饿死。
 */
export const DEFAULT_MSG_LOW_WATER_BYTES = DEFAULT_BULK_LOW_WATER_BYTES;
/** `bulk` 等待队列的字节上限。
 *
 * **它是内存护栏，不是流控。** 流控由传输自己的窗口负责，而今天唯一的窗口是**设备侧的 pull
 * 窗口**（Android `PullScheduler`：初始 4 MiB，上下界 1–8 MiB）。所以这个上限必须**明显大于**
 * 它，否则水位一堵，正常传输就会撞上它——那就从「延迟重排」变成了「系统性丢片」，每一片都要
 * 等一次 RTO 重传。
 *
 * 64 MiB 是那扇窗口的十几倍，正常传输撞不满它，而内存仍有明确上界。
 */
export const DEFAULT_BULK_QUEUE_LIMIT_BYTES = 64 * 1024 * 1024;
const DEFAULT_PUMP_INTERVAL_MS = 10;
/**
 * 被 socket 积压挡住时的复查间隔。
 *
 * ## 为什么它必须比 `DEFAULT_PUMP_INTERVAL_MS` 小得多
 *
 * 水位只决定「一次交付多少」，**只有节拍决定吞吐**：交付完一个水位之后必须等链路消化才能再
 * 交付，而这个「等」的长度就是节拍。于是缺省值同时给出了一个硬上界：
 *
 *     吞吐上界 = 水位 / 节拍
 *
 * 用 `pumpIntervalMs` 的 10 ms 就是 64 KiB / 10 ms = **6.4 MiB/s（≈54 Mbit/s）**——一个千兆
 * 局域网会被压掉一个数量级，50 Mbit/s 的链路正好卡在这条线上。取 1 ms 把它抬到 64 MiB/s，
 * 高于今天任何能走到这里的链路（可达的 relay / P2P 链路通常在 5–50 Mbit/s）。
 *
 * 代价是**只在有帧被水位挡住时**每秒多 1000 次定时器唤醒（队列空或链路通畅时一个都不会有）。
 *
 * ## 这是权宜，不是终点
 *
 * 干净的做法是让传输在消化时主动通知，而不是靠定时器猜：WebRTC 有
 * `bufferedAmountLowThreshold` / `onbufferedamountlow`，`ws` 有 `send(data, cb)` 的写出回调。
 * 那需要一个从各条出口反向回到多路复用器的通道，本轮不做。**真有链路超过 64 MiB/s 时，
 * 先做那件事，而不是把这个数再调小**——定时器精度与唤醒开销都会开始咬人。
 */
export const DEFAULT_DRAIN_POLL_INTERVAL_MS = 1;
/**
 * 写被拒后的重试次数上限。
 *
 * 取这么小是因为它挡的是「路径真的死了」：重试间隔就是 `pumpIntervalMs`（10ms），
 * 5 次不到 50ms——对端早就该回落了，再拖只会让控制帧陪着一起等。
 */
export const DEFAULT_MAX_WRITE_ATTEMPTS = 5;

/** 一个时长选项只有在「有限且为正」时才算数：`NaN` / `0` / 负数都会把节拍退化成空转。 */
function validInterval(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

type Entry<T> = { frame: T; bytes: number; queuedAt: number; channel: MuxChannel; attempts: number };

export class OutboundChannelMux<T> {
  readonly #options: OutboundMuxOptions<T>;
  readonly #queues: Record<MuxChannel, Entry<T>[]> = { ctl: [], msg: [], bulk: [] };
  /** 校验过的重试间隔（写被拒时用）。见构造函数里的注释。 */
  readonly #pumpIntervalMs: number;
  /** 校验过的复查间隔（被 socket 积压挡住时用）。 */
  readonly #drainPollIntervalMs: number;
  /** 上一次 `#pump` 是**因为 socket 积压**停下的（而不是因为队列空或写被拒）。它决定下次用哪个节拍。 */
  #gatedByBacklog = false;
  #queuedBytes = 0;
  #bulkBytes = 0;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #overflowReported = false;
  #stopped = false;

  constructor(options: OutboundMuxOptions<T>) {
    this.#options = options;
    // 时长必须校验：`setTimeout(fn, NaN)` 会被当成 1ms，一个 NaN 就能把重试节拍从 10ms 变成
    // 每 tick 一次的空转——这个项目在配对码上就这么把事件循环占满过一次。
    this.#pumpIntervalMs = validInterval(options.pumpIntervalMs) ?? DEFAULT_PUMP_INTERVAL_MS;
    this.#drainPollIntervalMs =
      validInterval(options.drainPollIntervalMs) ?? DEFAULT_DRAIN_POLL_INTERVAL_MS;
  }

  get queuedBytes(): number {
    return this.#queuedBytes;
  }

  get bulkQueuedBytes(): number {
    return this.#bulkBytes;
  }

  /**
   * 现在还能不能再接一片 `bulk`。
   *
   * **必须在封帧之前问**：返回 `false` 时调用方要丢掉这一片而不是封了再丢——
   * 已封好的信封被丢弃会推进发送序号却到不了对端，在接收侧是一个**永久**空洞。
   *
   * 判据是**队列**而不是链路水位：帧进了队列就是在等水位，等待本身是有界的
   * （`bulkQueueLimitBytes` 就是那个界），而「链路现在堵不堵」由 `#pump` 里的事决定，
   * 在这里问它会把「临时堵一下」误判成「没空间」，让调用方白丢一片。
   */
  hasBulkRoom(bytes: number): boolean {
    const limit = this.#options.bulkQueueLimitBytes ?? DEFAULT_BULK_QUEUE_LIMIT_BYTES;
    return this.#bulkBytes + bytes <= limit;
  }

  /**
   * 入队一帧。返回它是否被接受。
   *
   * 只有 `stop()` 之后才是 `false`：**这个类永远不丢帧**。要丢的调用方在封帧之前问
   * `hasBulkRoom()`，而不是封好了再交给这里丢。
   */
  enqueue(channel: MuxChannel, frame: T, bytes: number): boolean {
    if (this.#stopped) return false;
    if (channel === "bulk") {
      const limit = this.#options.bulkQueueLimitBytes ?? DEFAULT_BULK_QUEUE_LIMIT_BYTES;
      if (this.#bulkBytes + bytes > limit && !this.#overflowReported) {
        this.#overflowReported = true;
        this.#options.onBulkOverflow?.(this.#bulkBytes);
      }
    }
    this.#queues[channel].push({
      frame,
      bytes,
      channel,
      attempts: 0,
      queuedAt: this.#options.onBulkQueuedTooLong === undefined ? 0 : Date.now(),
    });
    this.#queuedBytes += bytes;
    if (channel === "bulk") this.#bulkBytes += bytes;
    this.#pump();
    return true;
  }

  /**
   * 底层缓冲消化了，可以再交付 `bulk`。
   *
   * `ws` 没有可靠的 drain 事件，所以这个类自带一个重试定时器；这个方法只是让调用方
   * 能在明确的时刻（例如刚发完一条小帧）立刻推进一次，省掉那一拍 10ms。
   */
  notifyDrained(): void {
    this.#pump();
  }

  stop(): void {
    this.#stopped = true;
    if (this.#timer !== undefined) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
    this.#queues.ctl.length = 0;
    this.#queues.msg.length = 0;
    this.#queues.bulk.length = 0;
    this.#queuedBytes = 0;
    this.#bulkBytes = 0;
    this.#gatedByBacklog = false;
  }

  #pump(): void {
    if (this.#stopped) return;
    // 这一轮为什么停下，决定下一轮什么时候来（见 `#syncTimer`）。每次重新判定。
    this.#gatedByBacklog = false;
    // 严格优先级：ctl 永远先走。它是交互的那一条，也是唯一「用户在等」的那一条。
    for (;;) {
      const entry =
        this.#queues.ctl.shift() ??
        this.#takeGated("msg", this.#options.msgLowWaterBytes ?? DEFAULT_MSG_LOW_WATER_BYTES) ??
        this.#takeGated("bulk", this.#options.bulkLowWaterBytes ?? DEFAULT_BULK_LOW_WATER_BYTES);
      if (entry === undefined) break;
      if (!this.#writeEntry(entry)) {
        // 写被拒：**留在队首重试**，并且停在这里——后面的帧不能越过它（顺序就是协议）。
        // 这一轮停下的原因是「对端有问题」而不是「链路还没消化」，所以别用密节拍复查。
        this.#gatedByBacklog = false;
        break;
      }
    }
    // **只有这里排定时器**：节拍由这一轮的停止原因决定，所以必须在循环之后才定。
    this.#syncTimer();
  }

  /** 交付一帧。返回 `false` 表示它被留在队首（重试），队列已经不再前进。 */
  #writeEntry(entry: Entry<T>): boolean {
    this.#queuedBytes -= entry.bytes;
    if (entry.channel === "bulk") this.#bulkBytes -= entry.bytes;
    let failure: unknown;
    try {
      this.#options.write(entry.frame);
      return true;
    } catch (error) {
      failure = error;
    }
    entry.attempts += 1;
    const limit = this.#options.maxWriteAttempts ?? DEFAULT_MAX_WRITE_ATTEMPTS;
    if (entry.attempts < limit) {
      this.#queuedBytes += entry.bytes;
      if (entry.channel === "bulk") this.#bulkBytes += entry.bytes;
      this.#queues[entry.channel].unshift(entry);
      return false;
    }
    // 重试耗尽：这一帧再怎么留也出不去，而它已经把整条队列堵住了。丢掉并上报——
    // 调用方据此判死那条路径（已消耗的序号收不回来，见文件头）。
    this.#options.onWriteAbandoned?.(entry.channel, entry.attempts, failure);
    return true;
  }

  /** 取出队首，但仅当底层缓冲低于该 channel 的水位。 */
  #takeGated(channel: MuxChannel, lowWaterBytes: number): Entry<T> | undefined {
    const queue = this.#queues[channel];
    const head = queue[0];
    if (head === undefined) return undefined;
    const backlog = this.#options.backlog?.() ?? 0;
    if (backlog > lowWaterBytes) {
      // 链路只是还没消化完，不是坏了：记下来，让下一次复查走更密的节拍（见 `#syncTimer`）。
      this.#gatedByBacklog = true;
      if (channel === "bulk") this.#options.onBulkStalled?.(this.#bulkBytes);
      return undefined;
    }
    queue.shift();
    return head;
  }

  /**
   * 队列里还压着东西 → 起一个定时器，等链路消化完（或被水位挡住的那件事过去）再来。
   *
   * **节拍分两种，因为两种「等」的性质不同**：被水位挡住是链路在正常工作，等得越短链路越不容易
   * 空转，而节拍本身就是吞吐上界（水位 / 节拍）——用 `DEFAULT_PUMP_INTERVAL_MS` 去复查会把
   * 吞吐压在 6.4 MiB/s。写被拒则是对端有问题，慢一点重试正好。见这两个常量的注释。
   */
  #syncTimer(): void {
    // `ctl` 也算在内：它平时不排队，但写被拒时同样会留在队首等重试。
    const pending = this.#queues.ctl.length + this.#queues.msg.length + this.#queues.bulk.length;
    if (pending === 0 || this.#stopped) {
      if (this.#timer !== undefined) {
        clearTimeout(this.#timer);
        this.#timer = undefined;
      }
      this.#gatedByBacklog = false;
      return;
    }
    if (this.#timer !== undefined) return;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      this.#reportStall();
      this.#pump();
    }, this.#gatedByBacklog ? this.#drainPollIntervalMs : this.#pumpIntervalMs);
    this.#timer.unref?.();
  }

  /** 队列压了太久 → 这是「链路真的堵了」，值得进日志，而不是悄悄降速。 */
  /**
   * 队列压了太久 → 这是「链路真的堵了」，值得进日志，而不是悄悄降速。
   *
   * **只报队首一条**：队首是等待最久的那条，它没到阈值就没有任何一条到了；逐条上报在慢链路上
   * 会退化成「每 tick × 队列长度」次回调——pump 被积压挡住时 tick 是 1ms 一次，而队列可以压着
   * 几千条分片，2026-09-17 真机实测一次 84MB 下载把 Host 日志刷了 1.89 GB，就是这个循环干的。
   */
  #reportStall(): void {
    const report = this.#options.onBulkQueuedTooLong;
    if (report === undefined) return;
    const head = this.#queues.bulk[0];
    if (head === undefined) return;
    const queuedMs = Date.now() - head.queuedAt;
    if (queuedMs >= 1_000) report(queuedMs, this.#bulkBytes);
  }
}
