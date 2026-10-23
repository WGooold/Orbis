package dev.pi.remote

import kotlinx.coroutines.async
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeoutOrNull
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 接收侧的两件事：
 *
 * 1. 派发顺序（ADR-0007）：`hdr.ch` 只把序号分开了，投递顺序没变；控制帧必须越过积压的分片。
 * 2. 内存上界（ADR-0040）：会话面与分片有预算，超了丢最旧；控制面不静默丢。
 */
class InboundFrameLanesTest {

    private fun bounded(
        controlFrames: Int = 8,
        controlPayload: Int = 1024,
        sessionFrames: Int = 4,
        sessionPayload: Int = 32,
        bulkFrames: Int = 4,
        bulkPayload: Int = 16,
    ) = InboundFrameLanes(
        controlLimits = InboundFrameLanes.LaneLimits(controlFrames, controlPayload),
        sessionLimits = InboundFrameLanes.LaneLimits(sessionFrames, sessionPayload),
        bulkLimits = InboundFrameLanes.LaneLimits(bulkFrames, bulkPayload),
    )

    @Test
    fun `控制面先于积压的分片被取走`() = runBlocking {
        val lanes = InboundFrameLanes()
        // 先堆一片分片积压：落盘比网络慢，这正是真实情形。
        repeat(64) { lanes.offerBulk(byteArrayOf(it.toByte())) }
        // 然后才来一条控制帧。
        lanes.offer("""{"type":"command.result"}""", "ctl")

        // 控制帧必须先出来，哪怕它排在 64 片分片后面才到。
        assertEquals("""{"type":"command.result"}""", lanes.takeControl()?.payload)
        // 分片还在原地等着，一片都没被提前消费。
        assertTrue(lanes.takeBulk() != null)
    }

    @Test
    fun `控制面与会话面都先于分片，且控制面排在会话面前`() = runBlocking {
        val lanes = InboundFrameLanes()
        repeat(8) { lanes.offerBulk(byteArrayOf(it.toByte())) }
        lanes.offer("""{"type":"session.patch"}""", "msg")
        lanes.offer("first", "ctl")

        assertEquals("first", lanes.takeControl()?.payload)
        assertEquals("""{"type":"session.patch"}""", lanes.takeSession()?.payload)
        assertTrue(lanes.takeBulk() != null)
        assertNull(lanes.takeControl())
        assertNull(lanes.takeSession())
    }

    @Test
    fun `bulk channel 的帧也走分片面，不看载荷形态`() = runBlocking {
        val lanes = InboundFrameLanes()
        lanes.offer("""{"type":"artifact.chunk"}""", "bulk")
        // 分类以 channel 为准：写了 bulk 就是分片，不管它是文本。
        assertNull(lanes.takeControl())
        assertNull(lanes.takeSession())
        // 它确实落在分片面上：分片不会丢，只是不抢控制面的道。
        assertEquals("""{"type":"artifact.chunk"}""", lanes.takeBulk()?.toString(Charsets.UTF_8))
    }

    @Test
    fun `没有 channel 的帧按控制面处理，老对端行为不变`() = runBlocking {
        val lanes = InboundFrameLanes()
        lanes.offer("""{"type":"device.ready"}""", null)
        assertEquals("""{"type":"device.ready"}""", lanes.takeControl()?.payload)
    }

    @Test
    fun `三面都空时挂起，被叫醒后取到新帧`() = runBlocking {
        val lanes = InboundFrameLanes()
        val waiter = async {
            val woke = withTimeoutOrNull(2_000) { lanes.awaitWork() }
            assertEquals(true, woke)
            lanes.takeControl()?.payload
        }
        delay(50)
        lanes.offer("""{"type":"artifact.started"}""", "ctl")
        assertEquals("""{"type":"artifact.started"}""", waiter.await())
    }

    @Test
    fun `关闭后叫醒不再成功，消费循环可以收工`() = runBlocking {
        val lanes = InboundFrameLanes()
        lanes.close()
        assertFalse(lanes.awaitWork())
        assertFalse(lanes.offer("late", "ctl"))
    }

    @Test
    fun `会话面超预算丢最旧并保留最新`() = runBlocking {
        // 每帧 10 字符、预算 25 字符：只放得下两帧，第三条会挤掉第一条。
        val lanes = bounded(sessionFrames = 10, sessionPayload = 25)
        lanes.offer("first-0000", "msg")
        lanes.offer("second-000", "msg")
        lanes.offer("third-0000", "msg")

        assertEquals(1, lanes.drainOverflow().sessionFrames)
        assertEquals(listOf("second-000", "third-0000"), takeAllSessions(lanes))
    }

    @Test
    fun `会话面按字节预算淘汰，不是只看帧数`() = runBlocking {
        val lanes = bounded(sessionFrames = 10, sessionPayload = 20)
        lanes.offer("aaaaaaaaaa", "msg")
        lanes.offer("bbbbbbbbbb", "msg")
        lanes.offer("cccccccccc", "msg")
        assertEquals(1, lanes.drainOverflow().sessionFrames)
        assertEquals(listOf("bbbbbbbbbb", "cccccccccc"), takeAllSessions(lanes))
    }

    @Test
    fun `取走之后预算归还，不会误丢`() = runBlocking {
        val lanes = bounded(sessionFrames = 2, sessionPayload = 100)
        lanes.offer("one", "msg")
        lanes.offer("two", "msg")
        assertEquals("one", lanes.takeSession()?.payload)
        lanes.offer("three", "msg")
        assertEquals(0, lanes.drainOverflow().sessionFrames)
        assertEquals("two", lanes.takeSession()?.payload)
        assertEquals("three", lanes.takeSession()?.payload)
    }

    @Test
    fun `控制面超预算丢最旧并单独计数`() = runBlocking {
        val lanes = bounded(controlFrames = 2, controlPayload = 100)
        lanes.offer("result-1", "ctl")
        lanes.offer("result-2", "ctl")
        lanes.offer("result-3", "ctl")
        val overflow = lanes.drainOverflow()
        assertEquals(1, overflow.controlFrames)
        assertEquals(0, overflow.sessionFrames)
        // 最新的三条里留下最旧的两条之外的最新一条：丢的是队首。
        assertEquals("result-2", lanes.takeControl()?.payload)
        assertEquals("result-3", lanes.takeControl()?.payload)
    }

    @Test
    fun `分片超预算丢最旧，pull 调度器按 RTO 重传`() = runBlocking {
        val lanes = bounded(bulkFrames = 2, bulkPayload = 8)
        lanes.offerBulk(byteArrayOf(1, 2, 3))
        lanes.offerBulk(byteArrayOf(4, 5, 6))
        lanes.offerBulk(byteArrayOf(7, 8, 9))
        assertEquals(byteArrayOf(4, 5, 6).toList(), lanes.takeBulk()?.toList())
        assertEquals(byteArrayOf(7, 8, 9).toList(), lanes.takeBulk()?.toList())
        assertNull(lanes.takeBulk())
    }

    @Test
    fun `丢弃计数只被消费一次`() = runBlocking {
        val lanes = bounded(sessionFrames = 1, sessionPayload = 4)
        lanes.offer("aaaa", "msg")
        lanes.offer("bbbb", "msg")
        assertEquals(1, lanes.drainOverflow().sessionFrames)
        assertEquals(0, lanes.drainOverflow().sessionFrames)
    }

    private fun takeAllSessions(lanes: InboundFrameLanes): List<String> = buildList {
        while (true) add(lanes.takeSession()?.payload ?: break)
    }
}
