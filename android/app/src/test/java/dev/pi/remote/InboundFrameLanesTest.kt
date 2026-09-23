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
 * 票 07 的接收侧一半：`hdr.ch` 只把序号分开了，**投递顺序**一点没变，所以控制帧仍然会排队在
 * 分片后面。这组用例锁的就是派发顺序——它是「下载一开，什么都点不动」的直接成因。
 */
class InboundFrameLanesTest {

    @Test
    fun `交互面先于积压的分片被取走`() = runBlocking {
        val lanes = InboundFrameLanes()
        // 先堆一片分片积压：落盘比网络慢，这正是真实情形。
        repeat(64) { lanes.offerBulk(byteArrayOf(it.toByte())) }
        // 然后才来一条控制帧。
        lanes.offer("""{"type":"command.result"}""", "ctl")

        // 控制帧必须先出来，哪怕它排在 64 片分片后面才到。
        assertEquals("""{"type":"command.result"}""", lanes.takeInteractive()?.payload)
        // 分片还在原地等着，一片都没被提前消费。
        assertTrue(lanes.takeBulk() != null)
    }

    @Test
    fun `分片不会垄断消费循环：每处理一片都要回头看交互面`() = runBlocking {
        val lanes = InboundFrameLanes()
        repeat(8) { lanes.offerBulk(byteArrayOf(it.toByte())) }
        lanes.offer("first", "ctl")

        // 模拟消费循环：先清交互面，再处理一片分片。
        assertEquals("first", lanes.takeInteractive()?.payload)
        assertTrue(lanes.takeBulk() != null)
        // 分片处理完一片之后，交互面立刻又能被优先看到。
        lanes.offer("second", "ctl")
        assertEquals("second", lanes.takeInteractive()?.payload)
    }

    @Test
    fun `bulk channel 的帧也走分片面，不看载荷形态`() = runBlocking {
        val lanes = InboundFrameLanes()
        lanes.offer("""{"type":"artifact.chunk"}""", "bulk")
        // 分类以 channel 为准：写了 bulk 就是分片，不管它是文本。
        assertNull(lanes.takeInteractive())
        // 它确实落在分片面上：分片不会丢，只是不抢交互面的道。
        assertEquals("""{"type":"artifact.chunk"}""", lanes.takeBulk()?.toString(Charsets.UTF_8))
    }

    @Test
    fun `没有 channel 的帧按交互处理，老对端行为不变`() = runBlocking {
        val lanes = InboundFrameLanes()
        lanes.offer("""{"type":"device.ready"}""", null)
        assertEquals("""{"type":"device.ready"}""", lanes.takeInteractive()?.payload)
    }

    @Test
    fun `两面都空时挂起，被叫醒后取到新帧`() = runBlocking {
        val lanes = InboundFrameLanes()
        val waiter = async {
            val woke = withTimeoutOrNull(2_000) { lanes.awaitWork() }
            assertEquals(true, woke)
            lanes.takeInteractive()?.payload
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
}
