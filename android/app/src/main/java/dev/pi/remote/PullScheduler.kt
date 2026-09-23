package dev.pi.remote

import java.util.UUID
import kotlin.math.abs

/**
 * 接收方驱动的下载调度器（ADR-0005）。
 *
 * 这个类的存在，是把「一次下载传到哪、下一步要哪一段、丢片怎么补」的全部状态从发送方
 * 搬到接收方。发送方（Host）退化成无状态的范围应答器：`read(offset,length) → chunk`。
 *
 * 三条不变量：
 * 1. **进度只有 `durableOffset` 一个权威**——它是 `.part` 文件里连续落盘的前缀长度。
 * 2. **`highestIssued - durableOffset ≤ window`**——在途 + 乱序暂存的总量有界。写盘跟不上
 *    时 `durableOffset` 不动，新请求自动停发，这就是磁盘背压。
 * 3. **超时只重请求那一个 chunk**，绝不重发整窗——这是相对旧 16 MiB 窗口模型的核心收益。
 *
 * 纯逻辑、无 I/O：`send` 由调用方注入（真实实现走 E2E 通道），`now` 可注入时钟，
 * 因此可以确定性地单测乱序、丢包、收敛与交互让路。
 */
internal class PullScheduler(
    private val size: Long,
    startOffset: Long,
    private val send: (requestId: String, offset: Long, length: Int) -> Unit,
    private val now: () -> Long = System::currentTimeMillis,
) {
    private class Outstanding(
        var requestId: String,
        val length: Int,
        var sentAt: Long,
        var retransmitted: Boolean = false,
    )

    /** 已连续落盘的前缀。外部写入 `.part` 后把新长度回填进来。 */
    var durableOffset: Long = startOffset
        private set

    /** 当前允许的「已请求未落盘」字节上限。 */
    var window: Long = INITIAL_WINDOW_BYTES
        private set

    private var highestIssued: Long = startOffset
    private val outstanding = linkedMapOf<Long, Outstanding>()
    private val requestById = mutableMapOf<String, Long>()

    private var srtt = 0L
    private var rttvar = 0L
    private var sawRttSample = false

    // 简单带宽估计：只用来给「加性增」定一个上限目标（BDP），不参与乘性减。
    private var bandwidthBytesPerMs = 0.0
    private var deliveredSinceSample = 0L
    private var lastBandwidthSampleAt = 0L

    private var interactive = false
    private var paused = false

    val complete: Boolean get() = durableOffset >= size
    val inFlight: Int get() = outstanding.size

    /** 交互流量优先时把窗口压到 1 个 chunk：在途字节小了，控制帧就不会排在几十兆分片后面。 */
    fun setInteractive(value: Boolean) {
        interactive = value
    }

    /**
     * E2E 通道不可用时暂停调度：不发新请求、也不重传。否则断线期间会往一个收不到的回执的
     * 方向持续灌 `read`（Host 那边全变成 `not_ready`/未知传输），白晃带宽。
     */
    fun setPaused(value: Boolean) {
        paused = value
    }

    /**
     * 调度一拍：先补超时的洞，再按窗口请求新数据。调用方需要周期性地调它。
     */
    fun tick() {
        if (paused) return
        val nowMs = now()
        retransmitTimedOut(nowMs)
        val effective = if (interactive) minOf(window, ARTIFACT_CHUNK_BYTES.toLong()) else window
        while (highestIssued < size && highestIssued - durableOffset < effective) {
            val length = chunkLength(highestIssued)
            issue(highestIssued, length, nowMs)
            highestIssued += length
        }
    }

    /**
     * 收到一个 chunk。[durableOffsetAfterWrite] 是把它写进 `.part` 之后 store 报回的连续前缀。
     */
    fun onChunk(offset: Long, length: Int, durableOffsetAfterWrite: Long) {
        val nowMs = now()
        val wasContiguous = offset == durableOffset
        outstanding.remove(offset)?.let { entry ->
            requestById.remove(entry.requestId)
            // Karn：重传过的样本不拿去更新 RTT，否则估计会被污染。
            if (!entry.retransmitted) sampleRtt(nowMs - entry.sentAt)
        }
        if (durableOffsetAfterWrite > durableOffset) durableOffset = durableOffsetAfterWrite
        noteDelivered(length, nowMs)
        if (wasContiguous && !complete) growWindow()
    }

    /** Host 明确拒绝了一次范围请求（越界/读盘失败/身份变了）：这条传输以确定原因收场。 */
    fun onReadFailed(requestId: String): String? {
        val offset = requestById.remove(requestId) ?: return null
        outstanding.remove(offset)
        return "电脑无法读取该文件的这一段"
    }

    private fun retransmitTimedOut(nowMs: Long) {
        val rto = currentRto()
        for ((offset, entry) in outstanding.entries.toList()) {
            if (nowMs - entry.sentAt <= rto) continue
            onLoss()
            requestById.remove(entry.requestId)
            entry.requestId = UUID.randomUUID().toString()
            entry.sentAt = nowMs
            entry.retransmitted = true
            requestById[entry.requestId] = offset
            // 交互状态只改变新请求的粒度。补洞必须覆盖原范围，不能缩短或扩大。
            send(entry.requestId, offset, entry.length)
        }
    }

    private fun issue(offset: Long, length: Int, nowMs: Long) {
        val requestId = UUID.randomUUID().toString()
        outstanding[offset] = Outstanding(requestId, length, nowMs)
        requestById[requestId] = offset
        send(requestId, offset, length)
    }

    private fun chunkLength(offset: Long): Int = minOf(
        // 交互让路时按更小的粒度取：分片是单条有序字节流上**收不回来**的那一段，一条控制帧
        // 最多只能等它前面那一帧写完。1 MiB 的分片在多兆带宽上就是几百毫秒的队头阻塞，
        // 128 KiB 把它压到几十毫秒，而代价只是每字节多一点点请求开销。
        if (interactive) INTERACTIVE_CHUNK_BYTES.toLong() else ARTIFACT_CHUNK_BYTES.toLong(),
        size - offset,
    ).toInt()

    private fun growWindow() {
        // 带宽样本还未知时不设天花板，先让窗口长起来；已知 BDP 后就不再长过它（但也不因成功而缩）。
        val ceiling = if (bandwidthBytesPerMs > 0.0) maxOf(bdpWindow(), MIN_WINDOW_BYTES) else MAX_WINDOW_BYTES
        val next = window + ARTIFACT_CHUNK_BYTES
        window = minOf(next, maxOf(ceiling, window), MAX_WINDOW_BYTES)
    }

    private fun onLoss() {
        window = maxOf(window / 2, MIN_WINDOW_BYTES)
    }

    private fun currentRto(): Long =
        if (!sawRttSample) DEFAULT_RTO_MS else (srtt + 4 * rttvar).coerceIn(MIN_RTO_MS, MAX_RTO_MS)

    private fun sampleRtt(sample: Long) {
        if (sample <= 0) return
        if (!sawRttSample) {
            srtt = sample
            rttvar = sample / 2
            sawRttSample = true
            return
        }
        rttvar = (3 * rttvar + abs(srtt - sample)) / 4
        srtt = (7 * srtt + sample) / 8
    }

    private fun noteDelivered(length: Int, nowMs: Long) {
        deliveredSinceSample += length
        if (lastBandwidthSampleAt == 0L) {
            lastBandwidthSampleAt = nowMs
            return
        }
        val elapsed = nowMs - lastBandwidthSampleAt
        if (elapsed < BANDWIDTH_SAMPLE_MS) return
        val sample = deliveredSinceSample.toDouble() / elapsed
        bandwidthBytesPerMs = if (bandwidthBytesPerMs == 0.0) sample else bandwidthBytesPerMs * 0.75 + sample * 0.25
        deliveredSinceSample = 0
        lastBandwidthSampleAt = nowMs
    }

    /** BDP = 实测带宽 × 平滑 RTT。只用于给加性增定上限，丢包时仍以乘性减为准。 */
    private fun bdpWindow(): Long {
        if (bandwidthBytesPerMs <= 0.0 || srtt <= 0) return MIN_WINDOW_BYTES
        return (bandwidthBytesPerMs * srtt * BDP_SAFETY).toLong().coerceIn(MIN_WINDOW_BYTES, MAX_WINDOW_BYTES)
    }

    companion object {
        /**
         * 初始窗口：4 MiB（起步先要 4 个 chunk，不是把整个文件倒进链路）。
         *
         * 它**不**负责控制帧的及时性：那件事由出站水位（`OutboundChannelMux`）与接收侧分道
         * （`InboundFrameLanes`）在两侧兜住，控制帧不必再靠「把窗口收小」来抢道。
         */
        const val INITIAL_WINDOW_BYTES = 4L * 1024 * 1024
        const val MIN_WINDOW_BYTES = 1L * 1024 * 1024
        const val MAX_WINDOW_BYTES = 8L * 1024 * 1024

        /** 交互让路时的分片粒度（见 `chunkLength`）。 */
        const val INTERACTIVE_CHUNK_BYTES = 128 * 1024

        const val MIN_RTO_MS = 200L
        const val MAX_RTO_MS = 2_000L
        const val DEFAULT_RTO_MS = 1_000L

        const val BDP_SAFETY = 1.5
        const val BANDWIDTH_SAMPLE_MS = 500L
    }
}
