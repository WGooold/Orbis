package dev.pi.remote

import org.junit.Assert.*
import org.junit.Test

class SessionSyncTasksTest {
    private fun initial(count: Int = 1) = RemoteState(
        selectedRuntimeId = "r0",
        runtimes = (0 until count).associate { "r$it" to RuntimeSummary("r$it", "R", "/", "idle", "s$it", sessionGraphSync = true, sessionLeafId = "leaf") },
    )
    private fun task(index: Int = 0, range: String = "preview") = PendingSessionSync(
        "r$index", "s$index", "sync$index-$range", range, "leaf", knownLeafId = "root",
        beforeEntryId = "boundary".takeIf { range == "history" }, connectionGeneration = 7,
    )
    private fun tick(state: RemoteState, time: Long) = advanceSessionSyncTasks(state, time, 7)
    private fun ack(state: RemoteState, id: String, sequence: Int = 1) = RelayReducer().reduce(state,
        """{"type":"runtime.event","runtimeId":"r0","sequence":$sequence,"event":{"type":"command.result","commandId":"$id","ok":true}}""")

    @Test fun `slow acknowledgement retains snapshot ownership and stable retry identity`() {
        val first = tick(initial().queueSessionSync("c", task()), 1_000)
        assertEquals(1, first.send.size)
        val acknowledged = ack(first.state, "c")
        assertTrue(acknowledged.pendingCommands.isEmpty())
        assertEquals(first.state.sessionSyncCommands, acknowledged.sessionSyncCommands)
        val slow = tick(acknowledged, 9_001)
        assertTrue(slow.send.isEmpty())
        assertTrue(slow.state.sessionSyncCommands.getValue("c").slow)
        assertTrue(slow.state.ownsSessionSnapshot("c", "r0", "s0", "sync0-preview", "leaf", "preview"))
        var state = slow.state
        for ((attempt, time) in listOf(31_000L, 61_000L, 121_000L).withIndex()) {
            val retry = tick(state, time)
            val sent = retry.send.single()
            assertEquals("c", sent.commandId)
            assertEquals(first.send.single().task.copy(attempts = attempt + 2, sentAt = time, slow = true), sent.task)
            state = retry.state
        }
        val exhausted = tick(state, 151_000)
        assertTrue(exhausted.send.isEmpty())
        assertEquals(4, exhausted.state.sessionSyncCommands.getValue("c").attempts)
        assertEquals(SESSION_SYNC_TIMEOUT_MESSAGE, exhausted.state.sessionSyncFailures["r0"])
        assertSame(exhausted.state, exhausted.state.requestRuntimeRefresh("r0"))
        assertTrue(tick(exhausted.state, 200_000).send.isEmpty())
        assertTrue(exhausted.state.ownsSessionSnapshot("c", "r0", "s0", "sync0-preview", "leaf", "preview"))
        assertTrue(tick(exhausted.state, 301_000).state.sessionSyncCommands.isEmpty())
    }

    @Test fun `late snapshot clears exhaustion and explicit retry resets the page clock`() {
        val first = tick(initial().queueSessionSync("c", task()), 0).state
        val expired = tick(first, 150_000).state
        val payload = """{"type":"runtime.event","runtimeId":"r0","sequence":2,"event":{
          "type":"session.snapshot","sessionId":"s0","syncId":"sync0-preview","mode":"replace",
          "range":"preview","targetLeafId":"leaf","complete":true,"cursor":{"leafId":"leaf"},
          "entries":[{"entryId":"leaf","parentId":null,"type":"message","timestamp":"1",
          "data":{"message":{"role":"user","content":"late"}}}]}}"""
        val recovered = RelayReducer().reduce(expired, payload)
        assertTrue(recovered.sessionSyncFailures.isEmpty())
        assertTrue(recovered.sessionSyncCommands.isEmpty())
        assertEquals("leaf", recovered.conversations["r0"]?.messages?.single()?.messageId)
        assertNull(recovered.conversations["r0"]?.chatSyncError)
        val retry = tick(expired.retrySessionSync("r0").queueSessionSync("new", task().copy(syncId = "new-sync")), 160_000)
        assertEquals(1, retry.send.single().task.attempts)
        assertEquals(160_000L, retry.send.single().task.firstSentAt)
        assertFalse(retry.state.ownsSessionSnapshot("c", "r0", "s0", "sync0-preview", "leaf", "preview"))
        val nextPage = tick(recovered.queueSessionSync("page2", task(range = "history")), 170_000)
        assertEquals(1, nextPage.send.single().task.attempts)
        assertEquals(170_000L, nextPage.send.single().task.sentAt)
    }

    @Test fun `suspended clock cannot burst all retries on resumption`() {
        val first = tick(initial().queueSessionSync("c", task()), 0)
        val resumed = tick(first.state, 100_000)
        assertEquals(1, resumed.send.size)
        assertTrue(tick(resumed.state, 101_000).send.isEmpty())
        assertEquals(1, tick(resumed.state, 130_000).send.size)
        assertTrue(tick(resumed.state, 150_000).send.isEmpty())
    }

    @Test fun `foreground priority and a reserved background slot both make progress`() {
        val state = initial(5).queueSessionSync("background", task(1, "catchup"))
            .queueSessionSync("background2", task(2, "catchup"))
            .queueSessionSync("preview", task())
            .queueSessionSync("history", task(0, "history"))
        val dispatched = tick(state, 0)
        assertEquals(listOf("preview", "background"), dispatched.send.map { it.commandId })
        val next = tick(dispatched.state.copy(sessionSyncCommands = dispatched.state.sessionSyncCommands - "background"), 1)
        assertEquals(listOf("background2"), next.send.map { it.commandId })
        assertEquals(2, next.state.sessionSyncCommands.values.count { it.attempts > 0 })
    }

    @Test fun `task queue deduplicates and rejects overflow with a recoverable state`() {
        var state = initial(40)
        repeat(32) { state = state.queueSessionSync("c$it", task(it, "catchup")) }
        assertSame(state, state.queueSessionSync("duplicate", task(1, "catchup")))
        state = state.queueSessionSync("overflow", task(32))
        assertEquals(32, state.sessionSyncCommands.size)
        assertEquals(32, state.pendingCommands.size)
        assertTrue("r32" in state.sessionSyncFailures)
    }

    @Test fun `branch session connection and foreground cancellation release requests`() {
        val started = tick(initial(2).queueSessionSync("history", task(0, "history"))
            .queueSessionSync("background", task(1, "catchup")), 0).state
        val foregroundChanged = started.cancelForegroundSessionSyncs("r1")
        assertEquals(setOf("background"), foregroundChanged.sessionSyncCommands.keys)
        val branchChanged = tick(started.copy(sessionBranchGenerations = mapOf("r0" to 1)), 1).state
        assertFalse("history" in branchChanged.sessionSyncCommands)
        val sessionChanged = tick(started.copy(runtimes = started.runtimes + ("r0" to started.runtimes.getValue("r0").copy(sessionId = "other"))), 1).state
        assertFalse("history" in sessionChanged.sessionSyncCommands)
        assertTrue(advanceSessionSyncTasks(started, 1, 8).state.sessionSyncCommands.isEmpty())
        val growth = tick(started.copy(runtimes = started.runtimes + ("r0" to started.runtimes.getValue("r0").copy(sessionLeafId = "new-tail"))), 1).state
        assertEquals(started.sessionSyncCommands, growth.sessionSyncCommands)
    }

    @Test fun `retired sync results never accumulate command results or restart loading`() {
        var state = initial()
        repeat(200) { state = ack(state, "session-sync:$it", it + 1) }
        assertTrue(state.commandResults.isEmpty())
        assertTrue(state.pendingCommands.isEmpty())
        assertTrue(state.sessionSyncCommands.isEmpty())
    }
}
