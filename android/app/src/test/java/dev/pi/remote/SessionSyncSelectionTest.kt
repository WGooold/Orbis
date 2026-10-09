package dev.pi.remote

import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.*
import org.junit.Test

class SessionSyncSelectionTest {
    private val json = Json { ignoreUnknownKeys = true; encodeDefaults = true }
    private val reducer = RelayReducer()
    private fun entry(id: String, parent: String? = null) = SessionGraphEntry(id, parent, "message", "1",
        buildJsonObject { put("message", buildJsonObject { put("role", "user"); put("content", id) }) })
    private fun initial(): RemoteState {
        val a = entry("a")
        val graph = SessionGraph("s", mapOf("a" to a), SessionBranchCursor("a"), cacheEpoch = "epoch",
            entryVersions = mapOf("a" to 10L))
        return RemoteState(
            selectedRuntimeId = "r", runtimes = mapOf("r" to RuntimeSummary("r", "R", "/", "running", "s",
                sessionGraphSync = true, sessionLeafId = "a")),
            sessionGraphs = mapOf("s" to graph),
            runtimeSessionViews = mapOf("r" to RuntimeSessionView("r", "s", "a")),
            sessionHistory = mapOf("r" to SessionHistoryState("s", "a", "a", false)),
            conversations = mapOf("r" to RuntimeConversation(
                messages = projectSessionGraph(graph).messages,
                sourceEpoch = "epoch", sourceSeq = 10, sourceHeadLeafId = "a", sourceReady = true,
                hasLiveSnapshot = true, activeTurnId = "turn", turnTimings = mapOf("turn" to TurnTiming("turn", 1)),
            )),
        )
    }
    private fun queued(state: RemoteState = initial()): RemoteState {
        val pending = state.copy(sessionSyncRequests = state.sessionSyncRequests + "r")
        val request = pending.requestedSessionRecovery("r", 0, "sync")!!
        return advanceSessionSyncTasks(pending.queueSessionSync("request", request), 1_000, 0).state
    }
    private fun response(selection: String = "unchanged", seq: Long = 10, head: String = "a",
        entries: List<SessionGraphEntry> = emptyList(), live: SessionLiveState? = null) = SessionGraphSnapshot(
        "s", "sync", SessionBranchCursor(head), "append", entries, range = "preview", targetLeafId = head,
        hasOlder = false, complete = true, rangeStatus = "complete", source = SessionSourceEpoch("epoch", seq, true),
        checkpoint = SessionCheckpoint("epoch:$seq", SessionBranchCursor(head), "complete", true), live = live, selection = selection,
    )
    private fun receive(state: RemoteState, snapshot: SessionGraphSnapshot): RemoteState {
        val body = json.encodeToString(snapshot).dropLast(1) + ",\"type\":\"session.snapshot\"}"
        return reducer.reduce(state, """{"type":"runtime.event","runtimeId":"r","sequence":100,"event":$body}""")
    }
    private fun patch(state: RemoteState, seq: Long, base: Long) = reducer.reduce(state,
        """{"type":"runtime.event","runtimeId":"r","sequence":$seq,"event":{
          "type":"session.patch","sessionId":"s","source":{"epoch":"epoch","seq":$seq,"ready":true},
          "baseSeq":$base,"seq":$seq,"checkpointId":"epoch:$seq","head":{"leafId":"a"},"headCompleteness":"complete",
          "live":{"complete":true,"turn":null,"messages":[],"tools":[]}
        }}""")

    @Test fun `only a fully applied baseline is advertised while history ancestors may remain partial`() {
        val state = initial()
        assertEquals(SessionAppliedState("epoch", 10, SessionBranchCursor("a")), state.appliedSessionState("r"))
        val partial = entry("a", "missing-ancestor")
        val cached = state.copy(sessionGraphs = mapOf("s" to state.sessionGraphs.getValue("s").copy(entries = mapOf("a" to partial))))
        assertNotNull(cached.appliedSessionState("r"))
        val conversation = state.conversations.getValue("r")
        for (invalid in listOf(conversation.copy(sourceReady = false), conversation.copy(hasLiveSnapshot = false),
            conversation.copy(sourceSeq = -1), conversation.copy(isChatSyncing = true),
            conversation.copy(sourceEpoch = null), conversation.copy(forceSourceSnapshot = true))) {
            assertNull(state.copy(conversations = mapOf("r" to invalid)).appliedSessionState("r"))
        }
        assertNull(state.copy(sessionGraphs = emptyMap()).appliedSessionState("r"))
        assertNull(state.copy(sessionGraphs = mapOf("s" to state.sessionGraphs.getValue("s").copy(cacheEpoch = "old"))).appliedSessionState("r"))
        assertNull(state.copy(conversations = mapOf("r" to conversation.copy(sourceHeadLeafId = "missing"))).appliedSessionState("r"))
    }

    @Test fun `unchanged releases the request without modifying display revision history live or graph`() {
        val state = queued()
        val changed = receive(state, response())
        assertEquals(state.conversations, changed.conversations)
        assertSame(state.sessionGraphs, changed.sessionGraphs)
        assertEquals(state.sessionHistory, changed.sessionHistory)
        assertEquals(state.runtimes, changed.runtimes)
        assertEquals(state.runtimeSessionViews, changed.runtimeSessionViews)
        assertTrue(changed.sessionSyncCommands.isEmpty())
        assertTrue(changed.sessionSyncRequests.isEmpty())
    }

    @Test fun `late unchanged preserves newer applied patches and cannot complete a newer gap`() {
        val state = queued()
        val advanced = patch(state, 11, 10)
        val confirmed = receive(advanced, response())
        assertEquals(11L, confirmed.conversations.getValue("r").sourceSeq)
        assertEquals(advanced.conversations, confirmed.conversations)
        val gap = patch(state, 12, 11)
        assertNull(gap.appliedSessionState("r"))
        val waiting = receive(gap, response())
        assertEquals(gap.conversations, waiting.conversations)
        assertTrue("r" in waiting.sessionSyncRequests)
        assertTrue(waiting.sessionSyncCommands.isEmpty())
    }

    @Test fun `late unchanged cannot install another epoch or mutate an unknown source`() {
        val state = queued()
        val conversation = state.conversations.getValue("r")
        for (changed in listOf(conversation.copy(sourceReady = false, isChatSyncing = true),
            conversation.copy(sourceEpoch = "new", sourceSeq = 1, retiredSourceEpochs = setOf("epoch")))) {
            val unknown = state.copy(conversations = mapOf("r" to changed))
            val result = receive(unknown, response())
            assertEquals(unknown.conversations, result.conversations)
            assertEquals(unknown.sessionGraphs, result.sessionGraphs)
            assertTrue("r" in result.sessionSyncRequests)
        }
    }

    @Test fun `late state response cannot regress newer patches or leave a blocking stale error`() {
        val state = patch(patch(queued(), 11, 10), 12, 11)
        val result = receive(state, response("state", 11, live = SessionLiveState(true)))
        assertEquals(state.conversations, result.conversations)
        assertTrue(result.sessionSyncRequests.isEmpty())
        assertTrue(result.sessionSyncCommands.isEmpty())
        assertTrue(result.sessionSyncFailures.isEmpty())
        assertNull(result.conversations.getValue("r").chatSyncError)
    }

    @Test fun `conditional state cannot reestablish a baseline after an unknown boundary or epoch switch`() {
        val state = queued()
        val conversation = state.conversations.getValue("r")
        for (invalidated in listOf(conversation.copy(sourceReady = false, sourceSeq = -1, isChatSyncing = true),
            conversation.copy(sourceEpoch = "new", sourceSeq = 1, retiredSourceEpochs = setOf("epoch")))) {
            val invalid = state.copy(conversations = mapOf("r" to invalidated))
            val result = receive(invalid, response("state", 11, live = SessionLiveState(true)))
            assertEquals(invalid.conversations, result.conversations)
            assertEquals(invalid.sessionGraphs, result.sessionGraphs)
            assertNull(result.conversations.getValue("r").chatSyncError)
            assertTrue("r" in result.sessionSyncRequests)
        }
    }

    @Test fun `state only repairs the live inventory and retains already loaded history`() {
        val state = queued()
        val result = receive(state, response("state", 11, live = SessionLiveState(true)))
        val conversation = result.conversations.getValue("r")
        assertEquals(listOf("a"), conversation.messages.map { it.messageId })
        assertEquals(11L, conversation.sourceSeq)
        assertNull(conversation.activeTurnId)
        assertEquals("idle", result.runtimes.getValue("r").status)
        assertEquals(state.sessionHistory.getValue("r").oldestEntryId, result.sessionHistory.getValue("r").oldestEntryId)
    }

    @Test fun `delta adds only the suffix and advances the checkpoint after ingestion`() {
        val state = queued()
        val result = receive(state, response("delta", 11, "b", listOf(entry("b", "a")), SessionLiveState(true)))
        assertEquals(listOf("a", "b"), result.conversations.getValue("r").messages.map { it.messageId })
        assertEquals("b", result.conversations.getValue("r").sourceHeadLeafId)
        assertEquals(11L, result.conversations.getValue("r").sourceSeq)
        assertFalse(result.conversations.getValue("r").isChatSyncing)
        assertEquals("a", result.sessionHistory.getValue("r").oldestEntryId)
    }

    @Test fun `forged acknowledgement and broken delta cannot consume a baseline`() {
        val state = queued()
        for (bad in listOf(response(seq = 11), response(head = "other"), response(entries = listOf(entry("b", "a"))),
            response(live = SessionLiveState(true)), response("delta", 11, "b", listOf(entry("b", "wrong")), SessionLiveState(true)))) {
            val result = receive(state, bad)
            assertEquals(state.sessionGraphs, result.sessionGraphs)
            assertEquals(10L, result.conversations.getValue("r").sourceSeq)
            assertTrue("r" in result.sessionSyncFailures)
        }
        val noBaseline = state.copy(sessionSyncCommands = state.sessionSyncCommands.mapValues { (_, task) -> task.copy(knownState = null) })
        assertTrue("r" in receive(noBaseline, response()).sessionSyncFailures)
    }

    @Test fun `explicit retry forces a snapshot and periodic retry keeps the original applied progress`() {
        val state = queued()
        val task = state.sessionSyncCommands.getValue("request")
        val first = advanceSessionSyncTasks(state, 1_000, 0).state
        val progressed = patch(first, 11, 10)
        val retry = advanceSessionSyncTasks(progressed, 31_000, 0)
        assertEquals(task.knownState, retry.send.single().task.knownState)
        val explicit = initial().retrySessionSync("r").copy(sessionSyncRequests = setOf("r"))
        assertNull(explicit.requestedSessionRecovery("r", 0, "forced")?.knownState)
        val afterPatch = patch(explicit, 11, 10)
        assertNull(afterPatch.appliedSessionState("r"))
    }
}
