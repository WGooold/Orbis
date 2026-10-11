package dev.pi.remote

import org.junit.Assert.*
import org.junit.Test

class SessionLoadQueueTest {
    @Test fun `new demands cannot be stranded or released by an exiting worker`() {
        val queue = SessionLoadQueue()
        val device = DeviceCredential("wss://relay.example", "device", "test")
        val runtime = RuntimeSummary("r", "R", "/", "idle", "s", sessionLeafId = "old")
        val old = SessionLoadRequest(device, runtime)
        val fresh = old.copy(runtime = runtime.copy(sessionLeafId = "new"))
        val worker = queue.enqueue(listOf(old))!!
        assertEquals(listOf(old), queue.take(worker, "r"))
        assertNull(queue.enqueue(listOf(old, fresh)))
        assertEquals(listOf(fresh), queue.take(worker, "r"))
        assertNull(queue.take(worker, "r"))
        // Enqueue in the gap between the empty take and the old coroutine's finally.
        val successor = queue.enqueue(listOf(fresh))!!
        assertTrue(queue.release(worker).isEmpty())
        assertEquals(listOf(fresh), queue.take(successor, "r"))
        assertNull(queue.enqueue(listOf(old)))
        val remaining = queue.release(successor)
        val recovery = queue.enqueue(remaining)!!
        assertEquals(listOf(old), queue.take(recovery, "r"))
        assertNull(queue.take(recovery, "r"))
    }
}
