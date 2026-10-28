package com.orbising.orbis

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.*
import org.junit.Test

class HistoryReadOperationsTest {
    private fun entry(id: String, parent: String?) = SessionGraphEntry(id, parent, "message", "stable",
        buildJsonObject { put("message", buildJsonObject { put("role", "user"); put("content", id) }) })
    private fun initial(offline: Boolean = false): RemoteState {
        val key = if (offline) "offline:s" else "r"
        val graph = fixtureGraph("s", mapOf("tail" to entry("tail", "older")), SessionBranchCursor("tail"), "fixture-source")
        return RemoteState(deviceId = "device", hostId = "host", connection = RelayConnection.ONLINE,
            selectedRuntimeId = key.takeUnless { offline }, selectedOfflineSessionId = "s".takeIf { offline },
            runtimes = if (offline) emptyMap() else mapOf("r" to RuntimeSummary("r", "R", "/", "idle", "s",
                sessionGraphSync = true, sessionLeafId = "tail")),
            runtimeSessionViews = if (offline) emptyMap() else mapOf("r" to RuntimeSessionView("r", "s", "tail")),
            sessionGraphs = mapOf("s" to graph), sessionHistory = mapOf(key to SessionHistoryState("s", "tail", "tail", true)),
            conversations = mapOf(key to RuntimeConversation(messages = projectSessionGraph(graph).messages, hasLiveSnapshot = true)))
    }
    private val page = fixtureRange(listOf(entry("older", null)), false, true)
    private fun remote(state: RemoteState, id: String = "page"): RemoteState = state.queueSessionSync("command",
        PendingSessionSync("r", "s", "sync", "history", "tail", beforeEntryId = "tail", historyOperationId = id))
        .let { advanceSessionSyncTasks(it, 0).state }
    private fun response(state: RemoteState, withDisplay: Boolean = true): RemoteState {
        val snapshot = SessionGraphSnapshot("s", "sync", SessionBranchCursor("tail"), "prepend", page.entries,
            range = "history", targetLeafId = "tail", beforeEntryId = "tail", hasOlder = false, complete = true,
            display = if (withDisplay) null else DisplayBatch(DISPLAY_PROJECTION_VERSION))
        val event = Json.encodeToJsonElement(SessionGraphSnapshot.serializer(), snapshot) as JsonObject
        val payload = buildJsonObject { put("type", "runtime.event"); put("runtimeId", "r"); put("sequence", 2)
            put("event", JsonObject(event + ("type" to JsonPrimitive("session.snapshot")))) }
        val committed = if (withDisplay) committedFixtureBatch(snapshot.entries) else
            CommittedSessionBatch(snapshot.entries, DisplayBatch(DISPLAY_PROJECTION_VERSION))
        return FixtureRelayReducer().reduceSourceSnapshot(state, payload.toString(), committed)
    }

    @Test fun `canonical ancestors without display rows remain remotely loadable instead of proving history end`() {
        val base = initial()
        val graph = base.sessionGraphs.getValue("s").withFixtureEntries(listOf(entry("older", null), entry("tail", "older")))
            .let { it.copy(display = it.display - "older") }
        val cached = base.copy(sessionGraphs = mapOf("s" to graph),
            sessionHistory = mapOf("r" to SessionHistoryState("s", "tail", "older", false)))
            .reconcileHistoryReads()
        val read = cached.beginHistoryRead("r", "missing-display")
        assertEquals("missing-display", read.acceptance.operationId)
        assertEquals("tail", read.state.sessionHistory.getValue("r").oldestEntryId)
        val missingDisplay = page.copy(display = emptyMap())
        val local = read.state.applyLocalHistoryRead("missing-display", missingDisplay)
        assertTrue(local.ownsHistoryRead("missing-display"))
        assertTrue(local.sessionHistory.getValue("r").hasOlder)
        val missingSourceDisplay = response(remote(local, "missing-display"), withDisplay = false)
        assertEquals(HistoryReadPhase.FAILED, missingSourceDisplay.latestHistoryRead("r")?.phase)
        assertTrue(missingSourceDisplay.sessionHistory.getValue("r").hasOlder)
        val retry = missingSourceDisplay.beginHistoryRead("r", "retry-display").state
        val recovered = response(remote(retry, "retry-display"))
        assertEquals(listOf("older", "tail"), recovered.conversations.getValue("r").messages.map { it.messageId })
        assertFalse("history=${recovered.sessionHistory}; display=${recovered.sessionGraphs.values.map { it.display.keys }}",
            recovered.sessionHistory.getValue("r").hasOlder)
        // A producer-declared display window legitimately excludes its canonical prefix.
        val windowed = base.copy(sessionGraphs = mapOf("s" to graph.copy(displayWindowStart = "tail")),
            sessionHistory = mapOf("r" to SessionHistoryState("s", "tail", "older", false))).reconcileHistoryReads()
        assertFalse(windowed.sessionHistory.getValue("r").hasOlder)
    }

    @Test fun `ordinary projection cannot revoke a cached page or let its old worker end a new read`() {
        val started = initial().beginHistoryRead("r", "first")
        assertEquals("first", started.acceptance.operationId)
        assertTrue(started.state.beginHistoryRead("r", "duplicate").acceptance.merged)
        // Same failing seam as the phone: valid content arrives after display loading was cleared.
        var changed = started.state.copy(sessionHistory = mapOf("r" to SessionHistoryState("s", "tail", "tail", true)))
        val nextGraph = changed.sessionGraphs.getValue("s")
            .withFixtureEntries(listOf(entry("tail", "older"), entry("new", "tail")))
        changed = changed.copy(runtimes = mapOf("r" to changed.runtimes.getValue("r").copy(sessionLeafId = "new")))
            .seedCachedSessionView("r", nextGraph)
        assertTrue(changed.sessionHistory.getValue("r").loading)
        val applied = changed.applyLocalHistoryRead("first", page)
        assertEquals(listOf("older", "tail", "new"), applied.conversations.getValue("r").messages.map { it.messageId })
        assertEquals("new", applied.runtimeSessionViews.getValue("r").leafId)
        assertFalse(applied.sessionHistory.getValue("r").loading)
        assertFalse(applied.sessionHistory.getValue("r").hasOlder)
        val restarted = started.state.finishHistoryRead("first", HistoryReadPhase.CANCELLED).beginHistoryRead("r", "second").state
        assertEquals(restarted, restarted.finishHistoryRead("first", HistoryReadPhase.CANCELLED))
        assertTrue(restarted.ownsHistoryRead("second"))
    }

    @Test fun `local handoff remains owned through acknowledgement and late recovery has its own outcome`() {
        val local = initial().beginHistoryRead("r", "page").state
        val sent = remote(local)
        assertEquals(HistoryReadPhase.REMOTE, sent.historyReads.getValue("page").phase)
        val ack = RelayReducer().reduce(sent, """{"type":"runtime.event","runtimeId":"r","sequence":1,"event":{"type":"command.result","commandId":"command","ok":true}}""")
        assertTrue(ack.ownsHistoryRead("page"))
        val completed = response(ack)
        assertEquals(HistoryReadPhase.END_REACHED, completed.historyReads.getValue("page").phase)
        assertFalse(completed.sessionHistory.getValue("r").loading)
        assertEquals(listOf("older", "tail"), completed.conversations.getValue("r").messages.map { it.messageId })
        val exhausted = advanceSessionSyncTasks(sent, 150_000).state
        assertEquals(HistoryReadPhase.FAILED, exhausted.historyReads.getValue("page").phase)
        assertTrue(exhausted.sessionSyncFailures.isEmpty())
        val recovered = response(exhausted)
        assertEquals(HistoryReadPhase.FAILED, recovered.historyReads.getValue("page").phase)
        assertEquals(HistoryReadPhase.END_REACHED, recovered.latestHistoryRead("r")?.phase)
        val retry = exhausted.beginHistoryRead("r", "retry").state
        assertFalse("command" in retry.sessionSyncCommands)
        assertEquals(retry.historyReads, response(retry).historyReads)
        assertTrue(retry.ownsHistoryRead("retry"))
    }

    @Test fun `failures and empty incomplete pages never prove end or block valid cache queries`() {
        for (offline in listOf(false, true)) {
            val key = if (offline) "offline:s" else "r"
            val state = initial(offline).copy(sessionSyncFailures = mapOf("r" to "source unavailable"))
            val started = state.beginHistoryRead(key, "read").state
            assertTrue(started.ownsHistoryRead("read"))
            val gap = started.applyLocalHistoryRead("read", SessionGraphRange(emptyList(), false, false, SessionGraphRangeStatus.MISSING_PARENT))
            assertTrue(gap.sessionHistory.getValue(key).hasOlder)
            val failed = gap.finishHistoryRead("read", HistoryReadPhase.FAILED, "disk read failed")
            assertTrue(failed.sessionHistory.getValue(key).hasOlder)
            assertFalse(failed.sessionHistory.getValue(key).loading)
            assertNotNull(failed.beginHistoryRead(key, "retry").acceptance.operationId)
            assertFalse(failed.applyLocalHistoryRead("read", page).sessionGraphs.getValue("s").entries.containsKey("older"))
            val exhausted = started.applyLocalHistoryRead("read", SessionGraphRange(emptyList(), false, true))
            assertEquals(HistoryReadPhase.END_REACHED, exhausted.historyReads.getValue("read").phase)
            assertFalse(exhausted.sessionHistory.getValue(key).hasOlder)
            if (!offline) {
                val pageSucceeded = response(remote(started, "read"))
                assertEquals(state.sessionSyncFailures, pageSucceeded.sessionSyncFailures)
                assertFalse(pageSucceeded.ownsHistoryRead("read"))
            }
        }
    }

    @Test fun `a displayable first page does not confirm the source or own another windows result`() {
        for (offline in listOf(false, true)) {
            val key = if (offline) "offline:s" else "r"
            var state = initial(offline).copy(runtimeSessionViews = emptyMap(),
                conversations = initial(offline).conversations.mapValues { (_, conversation) ->
                    conversation.copy(messages = emptyList(), hasLiveSnapshot = false)
                }).beginSessionRead(key, SessionReadKind.FIRST_PAGE, "first-page").state
            if (!offline) state = state.beginSessionRead(key, SessionReadKind.SOURCE, "source").state
            val loaded = state.sessionGraphs.getValue("s").withFixtureEntries(
                listOf(entry("older", null), entry("tail", "older")),
            )
            val displayed = state.applyFirstSessionPage("first-page", loaded)
            assertEquals(listOf("older", "tail"), projectSessionGraph(displayed.sessionGraphs.getValue("s")).messages.map { it.messageId })
            assertNull(displayed.appliedSessionState(key))
            if (!offline) {
                assertEquals(listOf("older", "tail"), displayed.conversations.getValue(key).messages.map { it.messageId })
                assertTrue(displayed.ownsHistoryRead("source"))
                val unknown = state.copy(conversations = state.conversations.mapValues { (_, conversation) ->
                    conversation.copy(sourceEpoch = "epoch", sourceReady = false, isChatSyncing = true,
                        chatSyncError = "source unavailable")
                }).applyFirstSessionPage("first-page", loaded)
                assertEquals(listOf("older", "tail"), unknown.conversations.getValue(key).messages.map { it.messageId })
                assertEquals("source unavailable", unknown.conversations.getValue(key).chatSyncError)
                assertNull(unknown.appliedSessionState(key))
                assertTrue(unknown.ownsHistoryRead("source"))
            }
            // Another committed projection can advance while this cache query is running.
            val newerGraph = loaded.withFixtureEntries(loaded.entries.values + entry("new", "tail"))
                .copy(cursor = SessionBranchCursor("new"))
            val newer = state.copy(sessionGraphs = mapOf("s" to newerGraph)).applyFirstSessionPage("first-page", loaded)
            assertEquals("new", newer.sessionGraphs.getValue("s").cursor.leafId)
            assertEquals(SessionReadPhase.SUCCEEDED, displayed.sessionReads.getValue("first-page").phase)
            val switched = state.copy(selectedRuntimeId = null, selectedOfflineSessionId = null)
                .applyFirstSessionPage("first-page", loaded)
            assertFalse(switched.sessionGraphs.getValue("s").entries.containsKey("older"))
            val failed = state.failLocalSessionRead("first-page", "disk failure")
            assertEquals(SessionReadPhase.FAILED, failed.sessionReads.getValue("first-page").phase)
            if (!offline) {
                assertTrue(failed.ownsHistoryRead("source"))
                assertTrue(failed.sessionSyncFailures.isEmpty())
            }
        }
    }

    @Test fun `multi page catchup preserves its goal independently of window lifetime`() {
        var state = initial().beginSessionRead("r", SessionReadKind.CATCHUP, "catchup", "tail").state
        val pageTask = PendingSessionSync("r", "s", "first", "catchup", "tail", requestTargetLeafId = "older",
            historyOperationId = "catchup")
        state = state.queueSessionSync("first", pageTask)
        state = state.copy(sessionSyncCommands = emptyMap(), pendingCommands = emptyMap(),
            runtimes = mapOf("r" to state.runtimes.getValue("r").copy(sessionLeafId = "new"))).reconcileHistoryReads()
        val continued = state.beginSessionRead("r", SessionReadKind.CATCHUP, "replacement", "new")
        assertTrue(continued.acceptance.merged)
        assertEquals("tail", continued.state.sessionReads.getValue("catchup").leafId)
        val background = continued.state.cancelForegroundSessionSyncs(null).copy(selectedRuntimeId = null)
        assertTrue(background.ownsHistoryRead("catchup"))
        val wrongEpoch = continued.state.observeCatchupCoverage("catchup", pageTask, null, "replacement")
        assertFalse(wrongEpoch.ownsHistoryRead("catchup"))
        assertEquals(SessionReadPhase.SUPERSEDED, wrongEpoch.sessionReads.getValue("catchup").phase)
        val progressed = continued.state.observeCatchupCoverage("catchup", pageTask, SessionSyncGap(null, "root-gap"))
        assertTrue(progressed.ownsHistoryRead("catchup"))
        val stalled = continued.state.observeCatchupCoverage("catchup", pageTask, SessionSyncGap(null, "older"))
        assertFalse(stalled.ownsHistoryRead("catchup"))
        assertTrue(stalled.sessionSyncFailures.isEmpty())
        assertTrue(sessionRangeFailureKey("r", "catchup") in stalled.sessionRangeFailures)
        val completed = background.observeCatchupCoverage("catchup", pageTask, null)
        val nextRound = completed.beginSessionRead("r", SessionReadKind.CATCHUP, "next-round", "new")
        assertEquals("new", nextRound.state.sessionReads.getValue("next-round").leafId)
    }

    @Test fun `partial responses cannot extend source recovery into an unbounded logical wait`() {
        var source = initial().beginSessionRead("r", SessionReadKind.SOURCE, "source").state
        source = source.copy(sessionReads = source.sessionReads.mapValues { (_, read) -> read.copy(startedAt = 0) })
        source = source.queueSessionSync("attempt-1", PendingSessionSync("r", "s", "one", "preview", null,
            historyOperationId = "source"))
        source = advanceSessionSyncTasks(source, 1_000).state
        // Partial data ends a wire range but not its logical recovery budget.
        source = source.copy(sessionSyncCommands = emptyMap(), pendingCommands = emptyMap(),
            conversations = source.conversations.mapValues { (_, conversation) -> conversation.copy(isChatSyncing = true) })
            .reconcileHistoryReads()
        assertTrue(source.ownsHistoryRead("source"))
        source = source.queueSessionSync("attempt-2", PendingSessionSync("r", "s", "two", "preview", null,
            historyOperationId = "source"))
        source = advanceSessionSyncTasks(source, 2_000).state
        val timedOut = advanceSessionSyncTasks(source, 150_000).state
        assertEquals(SessionReadPhase.FAILED, timedOut.sessionReads.getValue("source").phase)
        assertTrue("r" in timedOut.sessionSyncFailures)
        assertTrue(timedOut.retrySessionSync("r").beginSessionRead("r", SessionReadKind.SOURCE, "retry").acceptance.operationId != null)
    }

    @Test fun `owner changes reject old data while a transport reconnect preserves a local page`() {
        val state = initial().beginHistoryRead("r", "read").state
        val reconnecting = state.markReconnecting()
        assertTrue(reconnecting.ownsHistoryRead("read"))
        assertEquals(HistoryReadPhase.SUCCEEDED, reconnecting.applyLocalHistoryRead("read", page).historyReads.getValue("read").phase)
        val changed = listOf(state.copy(selectedRuntimeId = null), state.copy(deviceId = "other"),
            state.copy(conversations = state.conversations.mapValues { (_, conversation) ->
                conversation.copy(sourceEpoch = "different-view-generation", sourceReady = true)
            }),
            state.copy(sessionBranchGenerations = mapOf("r" to 1)), state.copy(sessionGraphs = mapOf("s" to state.sessionGraphs.getValue("s").copy(cacheEpoch = "new"))))
        for (next in changed) {
            val discarded = next.applyLocalHistoryRead("read", page)
            assertFalse(discarded.sessionGraphs.getValue("s").entries.containsKey("older"))
            assertEquals(HistoryReadPhase.SUPERSEDED, discarded.historyReads.getValue("read").phase)
        }
        val offline = initial(offline = true).beginHistoryRead("offline:s", "offline-read").state
        val migrated = offline.afterSessionCacheRebuild("s").applyLocalHistoryRead("offline-read", page)
        assertFalse(migrated.ownsHistoryRead("offline-read"))
        assertFalse(migrated.sessionHistory["offline:s"]?.loading == true)
        assertNull(migrated.sessionGraphs["s"])
        val diskEpochChanged = state.applyLocalHistoryRead("read", page, "replacement")
        assertFalse(diskEpochChanged.sessionGraphs.getValue("s").entries.containsKey("older"))
        assertEquals(HistoryReadPhase.SUPERSEDED, diskEpochChanged.historyReads.getValue("read").phase)
        val reconnectingRemote = remote(state, "read").markReconnecting()
        assertEquals(HistoryReadPhase.CANCELLED, reconnectingRemote.historyReads.getValue("read").phase)
        val cancelled = state.finishHistoryRead("read", HistoryReadPhase.CANCELLED)
        assertTrue(remote(cancelled, "read").sessionSyncCommands.isEmpty())
        val sent = remote(state, "read")
        val invalidEpoch = sent.copy(sessionGraphs = mapOf("s" to sent.sessionGraphs.getValue("s").copy(cacheEpoch = "new")))
        assertTrue(advanceSessionSyncTasks(invalidEpoch, 1).state.sessionSyncCommands.isEmpty())
    }
}
