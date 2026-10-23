package dev.pi.remote

import kotlinx.coroutines.channels.Channel
import java.util.concurrent.atomic.AtomicInteger

/**
 * 入站帧的三条优先级通道（ADR-0007 的接收侧 + ADR-0040 的有界化）。
 *
 * **为什么拆优先级。** `hdr.ch` 只把**序号**分开了，投递顺序一点没变：所有帧仍然按到达顺序挤在
 * 同一条队列里，而消费侧要落盘，比网络慢得多。按 channel 拆开之后，消费循环每次回到顶部都先清
 * 控制面，再取一条会话帧，最后才处理一片分片；一条控制帧的最坏等待从「等完整条积压」降到「等
 * 一帧落盘」。
 *
 * **为什么要有界。** 接收侧过去是 `Channel.UNLIMITED` + `trySend`，生产永远成功、消费慢时队列
 * 单调增长。2026-10-23 的真机堆转储里同时有 5,238 个未消费的帧、42MB payload，进程反复 OOM
 * （ADR-0040 Context）。这里给每条面各自一个「未取走」预算：
 *
 * - `ctl`（命令结果、交互、状态）：不可丢。超预算时丢最旧并记数，由消费侧当连接级异常处理。
 * - `msg`（会话同步、消息增量、会话目录）：可丢。超预算时丢最旧，消费侧据此对可见会话补一次
 *   源端同步——丢帧是背压，不是失败（ADR-0036）。
 * - `bulk`（artifact 分片）：可丢。分片按偏移重传（ADR-0005），丢一片的代价是一次 RTO。
 *
 * 预算是**本机内存**约束，不改线上协议、不改 Host 准入。计数器在生产者与消费者之间共享，竞争
 * 只可能让一次丢弃多算一帧，不会突破上界。
 */
internal class InboundFrameLanes(
    private val controlLimits: LaneLimits = LaneLimits(frames = 512, payload = 1_048_576),
    private val sessionLimits: LaneLimits = LaneLimits(frames = 256, payload = 4_194_304),
    private val bulkLimits: LaneLimits = LaneLimits(frames = 64, payload = 16_777_216),
) {
    /** 一条面的「未取走」上界。文本按 `payload.length`（UTF-16 字符）计，分片按字节计。 */
    internal data class LaneLimits(val frames: Int, val payload: Int) {
        init {
            require(frames > 0) { "lane frame limit must be positive" }
            require(payload > 0) { "lane payload limit must be positive" }
        }
    }

    internal data class InteractiveFrame(val payload: String, val channel: String?)

    /** 自上次读取以来因预算而丢弃的帧数；`sessionFrames` 触发重同步，`controlFrames` 断开连接。 */
    internal data class Overflow(val sessionFrames: Int, val controlFrames: Int) {
        val any: Boolean get() = sessionFrames > 0 || controlFrames > 0
    }

    private class Accounting(val limits: LaneLimits) {
        val frames = AtomicInteger()
        val payload = AtomicInteger()
    }

    /** 控制 / 消息面：命令结果、状态、会话同步、协议错误。 */
    private val control = Channel<InteractiveFrame>(Channel.UNLIMITED)
    private val session = Channel<InteractiveFrame>(Channel.UNLIMITED)

    /** 分片面：artifact 裸字节。 */
    private val bulk = Channel<ByteArray>(Channel.UNLIMITED)

    /** 叫醒信号。合并成一条：积压多少都只需要通知一次。 */
    private val wakeup = Channel<Unit>(Channel.CONFLATED)

    private val controlCount = Accounting(controlLimits)
    private val sessionCount = Accounting(sessionLimits)
    private val bulkCount = Accounting(bulkLimits)
    private val droppedSession = AtomicInteger()
    private val droppedControl = AtomicInteger()

    /**
     * 入队一条载荷。[channel] 是信封头上的逻辑 channel。
     *
     * 类型是 `String?` 只是因为 `RoutingHeaderV2` 与握手帧共用一份定义（`hs`/`pair` 不带 `ch`）；
     * 加密帧缺 `ch` 在 `E2eChannel.open` 就被拒了（ADR-0008），所以实际取值只有 `ctl` / `msg` /
     * `bulk`。没有 `ch` 的帧按 `ctl` 处理（与 ADR-0007 的协商规则一致）。
     */
    fun offer(payload: String, channel: String?): Boolean {
        if (channel == BULK_CHANNEL) return offerBulk(payload.toByteArray(Charsets.UTF_8))
        val sessionLane = channel == MESSAGE_CHANNEL
        val queue = if (sessionLane) session else control
        val accounting = if (sessionLane) sessionCount else controlCount
        val dropped = if (sessionLane) droppedSession else droppedControl
        val cost = payload.length
        dropOldestText(queue, accounting, dropped, cost)
        if (queue.trySend(InteractiveFrame(payload, channel)).isFailure) return false
        accounting.frames.incrementAndGet()
        accounting.payload.addAndGet(cost)
        wakeup.trySend(Unit)
        return true
    }

    /** 入队一片裸字节分片（E2E `bin` 帧）。 */
    fun offerBulk(bytes: ByteArray): Boolean {
        dropOldestBulk(bytes.size)
        if (bulk.trySend(bytes).isFailure) return false
        bulkCount.frames.incrementAndGet()
        bulkCount.payload.addAndGet(bytes.size)
        wakeup.trySend(Unit)
        return true
    }

    fun close() {
        control.close()
        session.close()
        bulk.close()
        wakeup.close()
    }

    /** 取一条控制帧。`null` = 控制面暂时空了。 */
    fun takeControl(): InteractiveFrame? = takeText(control, controlCount)

    /** 取一条会话面帧。`null` = 会话面暂时空了。 */
    fun takeSession(): InteractiveFrame? = takeText(session, sessionCount)

    /** 取一片分片。`null` = 暂时没有。 */
    fun takeBulk(): ByteArray? {
        val bytes = bulk.tryReceive().getOrNull() ?: return null
        bulkCount.frames.decrementAndGet()
        bulkCount.payload.addAndGet(-bytes.size)
        return bytes
    }

    /** 两面都空时挂起等叫醒。返回 `false` = 通道已关闭，消费循环该收工了。 */
    suspend fun awaitWork(): Boolean = wakeup.receiveCatching().isSuccess

    /** 读取并清零丢弃计数；消费循环每轮调用一次。 */
    fun drainOverflow(): Overflow = Overflow(droppedSession.getAndSet(0), droppedControl.getAndSet(0))

    private fun takeText(queue: Channel<InteractiveFrame>, accounting: Accounting): InteractiveFrame? {
        val frame = queue.tryReceive().getOrNull() ?: return null
        accounting.frames.decrementAndGet()
        accounting.payload.addAndGet(-frame.payload.length)
        return frame
    }

    private fun dropOldestText(
        queue: Channel<InteractiveFrame>,
        accounting: Accounting,
        dropped: AtomicInteger,
        incoming: Int,
    ) {
        while (accounting.frames.get() >= accounting.limits.frames ||
            accounting.payload.get() + incoming > accounting.limits.payload
        ) {
            val oldest = queue.tryReceive().getOrNull() ?: return
            accounting.frames.decrementAndGet()
            accounting.payload.addAndGet(-oldest.payload.length)
            dropped.incrementAndGet()
        }
    }

    private fun dropOldestBulk(incoming: Int) {
        while (bulkCount.frames.get() >= bulkLimits.frames ||
            bulkCount.payload.get() + incoming > bulkLimits.payload
        ) {
            val oldest = bulk.tryReceive().getOrNull() ?: return
            bulkCount.frames.decrementAndGet()
            bulkCount.payload.addAndGet(-oldest.size)
        }
    }

    private companion object {
        const val BULK_CHANNEL = "bulk"
        const val MESSAGE_CHANNEL = "msg"
    }
}
