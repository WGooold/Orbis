package com.orbising.orbis

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

    // A resumed window must register its new demand during failure cooldown without
    // clearing retry policy. Exercise both orders of late completion and clock recovery.
    @Test fun `resumed demand survives a late preview before failure cooldown expires`() = resumedAfterExhaustion(false)
    @Test fun `resumed demand survives a late preview after failure cooldown expires`() = resumedAfterExhaustion(true)

    // Partial or unknown source replies must retain bounded retry policy rather
    // than leaving an orphan cooldown after the displayed failure is removed.
    @Test fun `partial late preview cooldown still expires`() = incompleteAfterExhaustion(true)
    @Test fun `unknown late preview cooldown still expires`() = incompleteAfterExhaustion(false)

    @Test fun `expired correlation wakes retained demand only after its old owner releases`() {
        val baseline = initial().copy(connection = RelayConnection.ONLINE, e2eReady = true,
            sessionSyncRequests = setOf("r0"), sessionSyncDemandGenerations = mapOf("r0" to 1L))
        val sent = tick(baseline.queueSessionSync("old", task().copy(demandGeneration = 1L)), 0).state
        var current = tick(sent, 150_000).state.requestResumedHistoryRefresh("r0", "s0")
        repeat(SYNC_FAILURE_COOLDOWN_TICKS) { index ->
            val waiting = tick(current, 151_000L + index * 1_000L)
            assertTrue(waiting.recoverRuntimeIds.isEmpty())
            current = waiting.state
        }
        assertTrue(current.sessionSyncFailureCooldowns.isEmpty())
        assertTrue("old" in current.sessionSyncCommands)
        val released = tick(current, 300_000)
        assertEquals(listOf("r0"), released.recoverRuntimeIds)
        assertTrue(released.state.sessionSyncCommands.isEmpty())
        assertTrue(tick(released.state, 300_001).recoverRuntimeIds.isEmpty())
        val recovery = released.state.requestedSessionRecovery(released.recoverRuntimeIds.single(), 7, "fresh")!!
        assertEquals("fresh", tick(released.state.queueSessionSync("fresh-command", recovery), 300_001).send.single().task.syncId)
    }

    private fun incompleteAfterExhaustion(sourceReady: Boolean) {
        val now = System.currentTimeMillis()
        val baseline = initial().copy(connection = RelayConnection.ONLINE, e2eReady = true,
            sessionSyncRequests = setOf("r0"), sessionSyncDemandGenerations = mapOf("r0" to 1L))
        val sent = tick(baseline.queueSessionSync("old", task().copy(demandGeneration = 1L)), now - 150_000).state
        val exhausted = tick(sent, now).state.copy(sessionSyncBlockedTargets = setOf("r0\u0000other-leaf"))
        val resumed = exhausted.requestResumedHistoryRefresh("r0", "s0")
        val payload = """{"type":"runtime.event","runtimeId":"r0","sequence":2,"event":{
          "type":"session.snapshot","sessionId":"s0","syncId":"sync0-preview","mode":"replace",
          "range":"preview","targetLeafId":"leaf","complete":true,"cursor":{"leafId":"leaf"},
          "source":{"epoch":"fixture-source","seq":2,"ready":$sourceReady},
          "checkpoint":{"checkpointId":"partial","head":{"leafId":"leaf"},"headCompleteness":"complete","inventoryComplete":false},
          "live":{"complete":false,"messages":[],"tools":[]},
          "entries":[{"entryId":"leaf","parentId":null,"type":"message","timestamp":"1",
          "data":{"message":{"role":"user","content":"partial"}}}]}}"""
        var partial = FixtureRelayReducer().reduceSourceSnapshot(resumed, payload)
        assertTrue(partial.sessionSyncFailures.isEmpty())
        assertEquals(exhausted.sessionSyncFailureCooldowns, partial.sessionSyncFailureCooldowns)
        assertTrue("r0" in partial.sessionSyncRequests)
        repeat(SYNC_FAILURE_COOLDOWN_TICKS - 1) { index -> partial = tick(partial, now + (index + 1) * 1_000).state }
        assertTrue("r0" in partial.sessionSyncFailureCooldowns)
        val blocked = partial.copy(sessionSyncBlockedTargets = setOf("r0\u0000leaf"))
        assertTrue(tick(blocked, now + SYNC_FAILURE_COOLDOWN_TICKS * 1_000).recoverRuntimeIds.isEmpty())
        val released = tick(partial, now + SYNC_FAILURE_COOLDOWN_TICKS * 1_000)
        partial = released.state
        assertTrue(partial.sessionSyncFailureCooldowns.isEmpty())
        assertEquals(exhausted.sessionSyncBlockedTargets, partial.sessionSyncBlockedTargets)
        assertEquals(listOf("r0"), released.recoverRuntimeIds)
        assertTrue(tick(partial, now + 10_001).recoverRuntimeIds.isEmpty())
        val successor = partial.requestedSessionRecovery(released.recoverRuntimeIds.single(), 7, "fresh")!!
        val dispatched = tick(partial.queueSessionSync("fresh-command", successor), now + 11_000)
        assertEquals("fresh", dispatched.send.single().task.syncId)
        val freshPayload = payload.replace("\"syncId\":\"sync0-preview\"", "\"syncId\":\"fresh\"")
            .replace("\"sequence\":2", "\"sequence\":3").replace("\"seq\":2", "\"seq\":3")
            .replace("\"ready\":$sourceReady", "\"ready\":true")
            .replace("\"inventoryComplete\":false", "\"inventoryComplete\":true")
            .replace("\"complete\":false", "\"complete\":true").replace("\"content\":\"partial\"", "\"content\":\"current\"")
        val confirmed = FixtureRelayReducer().reduceSourceSnapshot(dispatched.state, freshPayload)
        assertTrue(confirmed.sessionSyncRequests.isEmpty())
        assertTrue(confirmed.sessionSyncCommands.isEmpty())
        assertEquals("current", confirmed.conversations.getValue("r0").messages.single().content.single().text)
    }

    private fun resumedAfterExhaustion(cooldownFirst: Boolean) {
        val baseline = initial().copy(connection = RelayConnection.ONLINE, e2eReady = true,
            sessionSyncRequests = setOf("r0"), sessionSyncDemandGenerations = mapOf("r0" to 1L))
        val sent = tick(baseline.queueSessionSync("old", task().copy(demandGeneration = 1L)), 0).state
        val exhausted = tick(sent, 150_000).state
        assertTrue("r0" in exhausted.sessionSyncFailures)
        assertSame(exhausted, exhausted.requestRuntimeRefresh("r0"))
        assertSame(exhausted, exhausted.requestResumedHistoryRefresh("r0", "replaced-session"))
        var resumed = exhausted.requestResumedHistoryRefresh("r0", "s0")
        assertTrue("r0" in resumed.sessionSyncRequests)
        assertEquals(2L, resumed.sessionSyncDemandGenerations["r0"])
        assertEquals(exhausted.sessionSyncFailures, resumed.sessionSyncFailures)
        assertEquals(exhausted.sessionSyncFailureCooldowns, resumed.sessionSyncFailureCooldowns)
        assertEquals(exhausted.sessionSyncBlockedTargets, resumed.sessionSyncBlockedTargets)
        assertEquals(exhausted.conversations, resumed.conversations)
        assertNull(resumed.requestedSessionRecovery("r0", 7, "premature"))
        if (cooldownFirst) repeat(SYNC_FAILURE_COOLDOWN_TICKS) { index ->
            val previous = resumed
            resumed = tick(previous, 151_000L + index * 1_000L).state.trackSessionReadDemands(previous)
        }
        fun response(syncId: String, sequence: Int, text: String) = """{"type":"runtime.event","runtimeId":"r0","sequence":$sequence,"event":{
          "type":"session.snapshot","sessionId":"s0","syncId":"$syncId","mode":"replace",
          "range":"preview","targetLeafId":"leaf","complete":true,"cursor":{"leafId":"leaf"},
          "entries":[{"entryId":"leaf","parentId":null,"type":"message","timestamp":"1",
          "data":{"message":{"role":"user","content":"$text"}}}]}}"""
        val completed = FixtureRelayReducer().reduceSourceSnapshot(resumed, response("sync0-preview", 2, "old"))
        assertTrue(completed.sessionSyncFailures.isEmpty())
        assertTrue(completed.sessionSyncFailureCooldowns.isEmpty())
        assertTrue(completed.sessionSyncBlockedTargets.isEmpty())
        assertTrue(completed.sessionSyncCommands.isEmpty())
        assertTrue("r0" in completed.sessionSyncRequests)
        val successor = completed.requestedSessionRecovery("r0", 7, "fresh")!!
        assertEquals(2L, successor.demandGeneration)
        val dispatched = tick(completed.queueSessionSync("fresh-command", successor), 162_000)
        assertEquals("fresh", dispatched.send.single().task.syncId)
        val fresh = dispatched.state
        val confirmed = FixtureRelayReducer().reduceSourceSnapshot(fresh, response("fresh", 3, "current"))
        assertTrue(confirmed.sessionSyncRequests.isEmpty())
        assertTrue(confirmed.sessionSyncCommands.isEmpty())
        assertEquals("current", confirmed.conversations.getValue("r0").messages.single().content.single().text)
    }

    @Test fun `automatic history retries share their reserved byte and page allowance`() {
        val budget = SessionHistoryPrefetch("window", "leaf")
        var state = initial().queueSessionSync("reserve", task(range = "history").copy(historyPrefetch = budget))
        val first = tick(state, 1000); state = first.state
        assertEquals(1, first.send.size)
        val retry = tick(state, 31_000); state = retry.state
        assertEquals(1, retry.send.size)
        assertEquals(2, retry.send.single().task.attempts)
        assertTrue(tick(state, 61_000).send.isEmpty())
        val failed = tick(state, 151_000).state
        assertTrue(failed.sessionRangeFailures.isEmpty())
        assertTrue(failed.sessionSyncFailures.isEmpty())
    }

    @Test fun `source recovery remains a bounded preview even when a cached head exists`() {
        val state = initial().copy(sessionSyncRequests = setOf("r0"), conversations = mapOf(
            "r0" to RuntimeConversation(hasLiveSnapshot = true, sourceEpoch = "epoch", sourceSeq = 10,
                sourceHeadLeafId = "leaf", sourceReady = true),
        ))
        val recovery = state.requestedSessionRecovery("r0", 7, "recovery")
        assertEquals("preview", recovery?.range)
        assertNull(recovery?.knownLeafId)
        assertEquals("leaf", recovery?.viewLeafId)
    }

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
        val recovered = FixtureRelayReducer().reduceSourceSnapshot(expired, payload)
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
