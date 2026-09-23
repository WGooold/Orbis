package dev.pi.remote

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * PullScheduler 的确定性单测（注入时钟 + 假发送）。
 *
 * 钉住三件事：窗口有界、只补洞、交互让路；外加完成判定。
 */
class PullSchedulerTest {

    private val mib = 1024L * 1024L
    private val oneChunk = (1024 * 1024)

    private class Harness(size: Long, startOffset: Long = 0) {
        var now = 0L
        val sent = mutableListOf<Sent>()
        val scheduler = PullScheduler(
            size = size,
            startOffset = startOffset,
            send = { requestId, offset, length -> sent += Sent(requestId, offset, length) },
            now = { now },
        )

        data class Sent(val requestId: String, val offset: Long, val length: Int)

        fun tick() = scheduler.tick()
        fun advance(ms: Long) { now += ms }
        fun deliver(offset: Long, length: Int, durableAfter: Long) =
            scheduler.onChunk(offset, length, durableAfter)
    }

    @Test
    fun `起步按窗口发满连续请求`() {
        val h = Harness(size = 10 * mib)
        h.tick()
        // 默认窗口 4 MiB → 恰好 4 个连续 chunk，不从头狂发整个文件。
        assertEquals(listOf(0L, mib, 2 * mib, 3 * mib), h.sent.map { it.offset })
    }

    @Test
    fun `超时只重请求丢的那一片，不重发整窗`() {
        val h = Harness(size = 8 * mib)
        h.tick() // 0..3
        for (i in 0 until 4) h.deliver(i * mib, oneChunk, (i + 1) * mib)
        h.tick() // 4..7
        // 5/6/7 到了，4 丢了：乱序到达不推进 durable prefix。
        h.deliver(5 * mib, oneChunk, 4 * mib)
        h.deliver(6 * mib, oneChunk, 4 * mib)
        h.deliver(7 * mib, oneChunk, 4 * mib)
        val before = h.sent.size

        // 聊天开始后新请求会缩成小片，但超时重传必须仍覆盖原来缺失的整段。
        h.scheduler.setInteractive(true)
        h.advance(PullScheduler.MAX_RTO_MS + 1)
        h.tick()

        val retry = h.sent.drop(before).single()
        assertEquals(4 * mib, retry.offset)
        assertEquals(oneChunk, retry.length)
        h.deliver(retry.offset, retry.length, 8 * mib)
        assertTrue(h.scheduler.complete)

        // 反方向也不能扩大原请求，否则会与已经缓存的小片重叠。
        val small = Harness(size = mib)
        small.scheduler.setInteractive(true)
        small.tick()
        val missing = small.sent.first()
        small.sent.drop(1).forEach { small.deliver(it.offset, it.length, 0) }
        val issued = small.sent.size
        small.scheduler.setInteractive(false)
        small.advance(PullScheduler.MAX_RTO_MS + 1)
        small.tick()
        val smallRetry = small.sent.drop(issued).single()
        assertEquals(missing.offset, smallRetry.offset)
        assertEquals(missing.length, smallRetry.length)
        small.deliver(smallRetry.offset, smallRetry.length, mib)
        assertTrue(small.scheduler.complete)
    }

    @Test
    fun `已收到的乱序片不会被重复请求`() {
        val h = Harness(size = 8 * mib)
        h.tick()
        for (i in 0 until 4) h.deliver(i * mib, oneChunk, (i + 1) * mib)
        h.tick() // 4..7
        h.deliver(5 * mib, oneChunk, 4 * mib)
        h.deliver(6 * mib, oneChunk, 4 * mib)
        h.deliver(7 * mib, oneChunk, 4 * mib)
        val before = h.sent.size
        h.tick() // 未到 RTO：既不重传，也没有新数据可请求。
        assertEquals(before, h.sent.size)
        assertEquals(1, h.scheduler.inFlight)
    }

    @Test
    fun `超时收缩窗口，按序交付不再回缩`() {
        val h = Harness(size = 32 * mib)
        h.tick()
        val initial = h.scheduler.window
        assertEquals(PullScheduler.INITIAL_WINDOW_BYTES, initial)

        // 一片都不回：全部在途请求超时 → 乘性减（可能连续减几次，只断方向）。
        h.advance(PullScheduler.MAX_RTO_MS + 1)
        h.tick()
        val afterLoss = h.scheduler.window
        assertTrue("窗口应因丢包收缩：$afterLoss !< $initial", afterLoss < initial)

        // 之后按序交付不该让窗口再降。
        var durable = 0L
        repeat(4) {
            h.deliver(durable, oneChunk, durable + 1 * mib)
            durable += 1 * mib
        }
        assertTrue(h.scheduler.window >= afterLoss)
    }

    @Test
    fun `交互让路把在途压到一个 ARTIFACT_CHUNK_BYTES，并把分片切成小块`() {
        val h = Harness(size = 16 * mib)
        h.tick()
        for (i in 0 until 4) h.deliver(i * mib, oneChunk, (i + 1) * mib)
        val before = h.sent.size

        h.scheduler.setInteractive(true)
        h.tick()
        val issued = h.sent.drop(before)
        // 在途**字节**被压到 1 个 ARTIFACT_CHUNK_BYTES：控制帧前面最多只剩这么多。
        assertEquals(ARTIFACT_CHUNK_BYTES.toLong(), issued.sumOf { it.length.toLong() })
        assertEquals(4 * mib, issued.first().offset)
        // 而且这一窗被切成 INTERACTIVE_CHUNK_BYTES 的小片。一帧进了 socket 就收不回来，
        // 控制帧只能等它写完——1 MiB 在多兆带宽上是几百毫秒，128 KiB 压到几十毫秒。
        assertTrue(issued.all { it.length == PullScheduler.INTERACTIVE_CHUNK_BYTES })

        h.scheduler.setInteractive(false)
        h.tick()
        assertTrue(h.sent.size > before + 1)
    }

    @Test
    fun `全部落盘即完成，不再发请求`() {
        val h = Harness(size = 2 * mib)
        h.tick()
        h.deliver(0, oneChunk, 1 * mib)
        h.deliver(1 * mib, oneChunk, 2 * mib)
        assertTrue(h.scheduler.complete)
        val before = h.sent.size
        h.advance(PullScheduler.MAX_RTO_MS + 1)
        h.tick()
        assertEquals(before, h.sent.size)
    }

    @Test
    fun `E2E 未就绪时暂停：不发新请求也不重传，恢复后继续`() {
        val h = Harness(size = 8 * mib)
        h.tick()
        h.scheduler.setPaused(true)
        h.advance(PullScheduler.MAX_RTO_MS + 1)
        val before = h.sent.size
        h.tick()
        assertEquals(before, h.sent.size)
        h.scheduler.setPaused(false)
        h.tick()
        assertTrue(h.sent.size > before)
    }

    @Test
    fun `Host 拒绝某个请求时给出确定原因`() {
        val h = Harness(size = 4 * mib)
        h.tick()
        val requestId = h.sent.first().requestId
        assertEquals("电脑无法读取该文件的这一段", h.scheduler.onReadFailed(requestId))
        assertNull(h.scheduler.onReadFailed("unknown-request"))
    }

    @Test
    fun `slow reliable link completes without building a queue of duplicate ranges`() {
        val h = Harness(size = 12 * mib)
        val queue = java.util.ArrayDeque<Harness.Sent>()
        val received = sortedMapOf<Long, Int>()
        var issued = 0
        var remaining = 0L
        var durable = 0L
        var peakQueuedBytes = 0L
        h.tick()
        // 256 KiB/s: one 1 MiB response takes four seconds, without any packet loss.
        // Requests share a reliable FIFO byte stream with their own retransmissions.
        for (tick in 0 until 1_200) {
            while (issued < h.sent.size) queue.addLast(h.sent[issued++])
            if (remaining == 0L && queue.isNotEmpty()) remaining = queue.first.length.toLong()
            peakQueuedBytes = maxOf(peakQueuedBytes, queue.sumOf { it.length.toLong() })
            h.advance(100)
            if (queue.isNotEmpty()) {
                remaining -= 256 * 1024 / 10
                if (remaining <= 0L) {
                    val response = queue.removeFirst()
                    remaining = 0L
                    if (response.offset >= durable) received[response.offset] = response.length
                    while (true) durable += received.remove(durable) ?: break
                    h.deliver(response.offset, response.length, durable)
                }
            }
            h.tick()
            if (h.scheduler.complete) break
        }
        assertTrue("durable=$durable requests=${h.sent.size} peakQueuedBytes=$peakQueuedBytes", h.scheduler.complete)
        assertEquals("a progressing reliable link must not retry its queued responses", 12, h.sent.size)
        assertTrue("peakQueuedBytes=$peakQueuedBytes", peakQueuedBytes <= PullScheduler.MAX_WINDOW_BYTES)
        assertTrue("completion took ${h.now}ms", h.now <= 50_000L)
    }

    @Test
    fun `stalled window retries one range and backs off instead of repeating the window`() {
        val h = Harness(size = 8 * mib)
        h.tick()
        h.advance(PullScheduler.DEFAULT_RTO_MS + 1)
        h.tick()
        assertEquals(1, h.sent.drop(4).size)
        assertEquals(0L, h.sent.last().offset)
        val afterFirstRetry = h.sent.size
        h.advance(PullScheduler.DEFAULT_RTO_MS + 1)
        h.tick()
        assertEquals("the next retry must wait for exponential backoff", afterFirstRetry, h.sent.size)
        h.advance(PullScheduler.DEFAULT_RTO_MS + 1)
        h.tick()
        assertEquals(afterFirstRetry + 1, h.sent.size)
        assertEquals(0L, h.sent.last().offset)
    }

    @Test
    fun `switching out of interactive mode never overshoots the receive window`() {
        val h = Harness(size = 32 * mib)
        h.scheduler.setInteractive(true)
        h.tick()
        val first = h.sent.first()
        h.advance(50)
        h.deliver(first.offset, first.length, first.length.toLong())
        h.scheduler.setInteractive(false)
        h.tick()
        val highest = h.sent.maxOf { it.offset + it.length }
        assertTrue("issued=$highest durable=${h.scheduler.durableOffset} window=${h.scheduler.window}",
            highest - h.scheduler.durableOffset <= h.scheduler.window)
    }

    @Test
    fun `late duplicate responses do not postpone recovery or inflate the window`() {
        val h = Harness(size = 4 * mib)
        h.tick()
        h.advance(50)
        h.deliver(0, oneChunk, mib)
        val window = h.scheduler.window
        repeat(4) {
            h.advance(250)
            h.deliver(0, oneChunk, mib)
        }
        h.advance(1)
        h.tick()
        assertEquals(5, h.sent.size)
        assertEquals(mib, h.sent.last().offset)
        assertTrue(h.scheduler.window < window)
    }

    @Test
    fun `recovery repairs several dropped ranges one at a time and finishes`() {
        val h = Harness(size = 4 * mib)
        h.tick()
        h.advance(20)
        h.deliver(3 * mib, oneChunk, 0)
        for (missing in 0 until 3) {
            val before = h.sent.size
            h.advance(PullScheduler.MAX_RTO_MS + 1)
            h.tick()
            val request = h.sent.drop(before).single()
            assertEquals(missing * mib, request.offset)
            h.advance(20)
            h.deliver(request.offset, request.length, if (missing == 2) 4 * mib else (missing + 1) * mib)
        }
        assertTrue(h.scheduler.complete)
        assertEquals(0, h.scheduler.inFlight)
    }
}
