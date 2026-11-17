package com.orbising.orbis

import java.io.File
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test

/** FT-G12-GAP-01: a committed tail window must recover a missed source interval without
 * requiring every ancestor. Live patch reordering still belongs to the continuity guard. */
class SessionPreviewWindowRecoveryTest {
    private val json = Json { encodeDefaults = true; ignoreUnknownKeys = true }
    private val reducer = RelayReducer()
    private fun entry(id: String, parent: String?, role: String = "assistant") =
        SessionGraphEntry(id, parent, "message", "1", buildJsonObject {
            put("message", buildJsonObject { put("role", role); put("content", id) })
        })
    private val old = (0..9).map { entry("old-$it", if (it == 0) null else "old-${it - 1}") }
    private val produced = (0..69).map { entry("new-$it", if (it == 0) "old-9" else "new-${it - 1}") }
    private val tail = produced.takeLast(30)

    private fun initial(): RemoteState {
        val graph = fixtureGraph("session", old, SessionBranchCursor("old-9"), cacheEpoch = "epoch")
        return RemoteState(selectedRuntimeId = "runtime", connection = RelayConnection.ONLINE, e2eReady = true,
            runtimes = mapOf("runtime" to RuntimeSummary("runtime", "Pi", "/fixture", "idle", "session",
                agentKind = "pi", sessionGraphSync = true, sessionLeafId = "new-69")),
            sessionGraphs = mapOf("session" to graph),
            runtimeSessionViews = mapOf("runtime" to RuntimeSessionView("runtime", "session", "old-9")),
            sessionHistory = mapOf("runtime" to SessionHistoryState("session", "old-9", "old-0", false)),
            conversations = mapOf("runtime" to RuntimeConversation(messages = fixtureMessages(old),
                sourceEpoch = "epoch", sourceSeq = 10, sourceHeadLeafId = "old-9", hasLiveSnapshot = true)))
    }

    private fun coldStart(cached: List<SessionGraphEntry> = old): RemoteState {
        val fresh = RemoteState(selectedRuntimeId = "runtime", connection = RelayConnection.ONLINE, e2eReady = true,
            runtimes = initial().runtimes)
        val read = fresh.beginSessionRead("runtime", SessionReadKind.FIRST_PAGE, "cached-first-page")
        return read.state.applyFirstSessionPage(requireNotNull(read.acceptance.operationId),
            fixtureGraph("session", cached, SessionBranchCursor(cached.last().entryId), cacheEpoch = "epoch"))
    }

    private fun request(state: RemoteState = initial(), syncId: String = "sync"): RemoteState {
        val wanted = state.copy(sessionSyncRequests = state.sessionSyncRequests + "runtime")
        val task = requireNotNull(wanted.requestedSessionRecovery("runtime", 0, syncId))
        val started = wanted.beginSessionRead("runtime", SessionReadKind.SOURCE, "read-$syncId")
        val queued = started.state.queueSessionSync("cmd-$syncId", task.copy(
            historyOperationId = requireNotNull(started.acceptance.operationId)))
        return advanceSessionSyncTasks(queued, System.currentTimeMillis(), 0).state
    }

    private fun snapshot(syncId: String = "sync", entries: List<SessionGraphEntry> = tail) = SessionGraphSnapshot(
        "session", syncId, SessionBranchCursor("new-69"), "replace", entries,
        range = "preview", targetLeafId = "new-69", hasOlder = true, complete = false,
        rangeStatus = "limit_reached", selection = "snapshot", source = SessionSourceEpoch("epoch", 80, true),
        checkpoint = SessionCheckpoint("epoch:80", SessionBranchCursor("new-69"), "complete", true),
        live = SessionLiveState(true), display = fixtureDisplayBatch(entries))

    private fun receive(state: RemoteState, snapshot: SessionGraphSnapshot, sequence: Long = 1,
        committed: CommittedSessionBatch = committedFixtureBatch(snapshot.entries)): RemoteState {
        val event = json.encodeToJsonElement(SessionGraphSnapshot.serializer(), snapshot) as JsonObject
        val payload = buildJsonObject {
            put("type", "runtime.event"); put("runtimeId", "runtime"); put("sequence", sequence)
            put("event", JsonObject(event + ("type" to JsonPrimitive("session.snapshot"))))
        }
        return reducer.reduce(state, payload.toString(), committed)
    }

    private fun patch(state: RemoteState, base: Long, seq: Long, head: String,
        entries: List<SessionGraphEntry>, sequence: Long = seq): RemoteState {
        val patch = SessionPatch(sessionId = "session", source = SessionSourceEpoch("epoch", seq, true),
            baseSeq = base, seq = seq, checkpointId = "epoch:$seq", head = SessionBranchCursor(head),
            headCompleteness = "complete", entries = entries, display = fixtureDisplayBatch(entries),
            live = SessionLiveState(true))
        return reducer.reduce(state,
            """{"type":"runtime.event","runtimeId":"runtime","sequence":$sequence,"event":${json.encodeToString(patch)}}""")
    }

    private fun ids(state: RemoteState) = state.conversations.getValue("runtime").messages.map(ChatMessage::messageId)
    private fun assertRecovered(state: RemoteState, expected: List<SessionGraphEntry> = tail, seq: Long = 80) {
        assertEquals(expected.map(SessionGraphEntry::entryId), ids(state))
        val conversation = state.conversations.getValue("runtime")
        assertNull(conversation.retainedProjectionLeafId)
        assertFalse(conversation.isChatSyncing)
        assertNull(conversation.chatSyncError)
        assertTrue(state.sessionSyncCommands.isEmpty())
        assertFalse("runtime" in state.sessionSyncRequests)
        assertEquals(seq, state.appliedSessionState("runtime")?.seq)
        assertEquals(SessionReadPhase.SUCCEEDED, state.sessionReadForWindow("runtime", SessionReadKind.SOURCE)?.phase)
    }

    @Test fun `returning to an opened session adopts the bounded window and repairs paging`() {
        val sent = request()
        assertNotNull(sent.sessionSyncCommands.getValue("cmd-sync").knownState)
        val recovered = receive(sent, snapshot())
        assertRecovered(recovered)
        assertTrue("old-9" in recovered.sessionGraphs.getValue("session").entries)
        assertEquals("new-40", recovered.sessionHistory.getValue("runtime").oldestEntryId)
        assertTrue(recovered.sessionHistory.getValue("runtime").hasOlder)
        val history = recovered.beginHistoryRead("runtime", "older")
        assertEquals("new-40", history.state.sessionReads.getValue(requireNotNull(history.acceptance.operationId)).beforeEntryId)

        // Paging starts above the new tail, so it can actually retrieve the missed middle.
        val task = PendingSessionSync("runtime", "session", "older-sync", range = "history",
            targetLeafId = "new-69", beforeEntryId = "new-40", historyOperationId = "older")
        val queued = advanceSessionSyncTasks(history.state.queueSessionSync("older-command", task),
            System.currentTimeMillis(), 0).state
        val page = snapshot("older-sync", produced.subList(10, 40)).copy(mode = "prepend", range = "history",
            beforeEntryId = "new-40", selection = null, checkpoint = null, live = null,
            rangeStatus = "older_available")
        val paged = receive(queued, page, 2)
        assertEquals(produced.drop(10).map(SessionGraphEntry::entryId), ids(paged))
        assertEquals("new-10", paged.sessionHistory.getValue("runtime").oldestEntryId)
    }

    @Test fun `same epoch reconnect recovers without restarting the process`() {
        val reconnected = initial().markReconnecting().copy(connection = RelayConnection.ONLINE, e2eReady = true)
        assertRecovered(receive(request(reconnected), snapshot()))
    }

    // FT-G12-GAP-02: production first-page restoration has a view/paging boundary but no source
    // checkpoint. Both a cached root and an older truncated cache must page through the gap.
    @Test fun `cold start rebases cached paging and retrieves the entire missed interval`() {
        for (cached in listOf(old, old.takeLast(5))) {
            val restored = coldStart(cached)
            assertEquals(cached.map(SessionGraphEntry::entryId), ids(restored))
            assertEquals("old-9", restored.runtimeSessionViews.getValue("runtime").leafId)
            assertEquals(cached.first().parentId != null, restored.sessionHistory.getValue("runtime").hasOlder)
            assertNull(restored.conversations.getValue("runtime").sourceEpoch)
            assertNull(restored.conversations.getValue("runtime").sourceHeadLeafId)
            assertNull(restored.conversations.getValue("runtime").retainedProjectionLeafId)
            val sent = request(restored)
            assertNull(sent.sessionSyncCommands.getValue("cmd-sync").knownState)

            var state = receive(sent, snapshot())
            assertRecovered(state)
            assertEquals("new-40", state.sessionHistory.getValue("runtime").oldestEntryId)
            assertTrue(state.sessionHistory.getValue("runtime").hasOlder)
            assertTrue(cached.all { it.entryId in state.sessionGraphs.getValue("session").entries })

            val pages = listOf(produced.subList(10, 40), old + produced.take(10))
            for ((index, entries) in pages.withIndex()) {
                val readId = "cold-older-$index"
                val read = state.beginHistoryRead("runtime", readId)
                assertNull(read.acceptance.rejection)
                val operation = read.state.sessionReads.getValue(requireNotNull(read.acceptance.operationId))
                assertEquals(if (index == 0) "new-40" else "new-10", operation.beforeEntryId)
                assertEquals("new-69", operation.leafId)
                val task = PendingSessionSync("runtime", "session", readId, range = "history",
                    targetLeafId = operation.leafId, beforeEntryId = operation.beforeEntryId, historyOperationId = readId)
                val queued = advanceSessionSyncTasks(read.state.queueSessionSync("cmd-$readId", task),
                    System.currentTimeMillis(), 0).state
                val lastPage = index == pages.lastIndex
                val page = snapshot(readId, entries).copy(mode = "prepend", range = "history",
                    beforeEntryId = operation.beforeEntryId, selection = null, checkpoint = null, live = null,
                    hasOlder = !lastPage, complete = lastPage,
                    rangeStatus = if (lastPage) "complete" else "older_available")
                state = receive(queued, page, index + 2L)
                assertEquals(if (lastPage) SessionReadPhase.END_REACHED else SessionReadPhase.SUCCEEDED,
                    state.sessionReads.getValue(readId).phase)
            }
            assertEquals((old + produced).map(SessionGraphEntry::entryId), ids(state))
            assertEquals("old-0", state.sessionHistory.getValue("runtime").oldestEntryId)
            assertFalse(state.sessionHistory.getValue("runtime").hasOlder)
        }
    }

    // The restored view is an anchor, not a reason to discard a connected cached prefix.
    @Test fun `cold start preserves a cached prefix connected to the preview window`() {
        val recovered = receive(request(coldStart(old + produced.take(45))), snapshot())
        assertRecovered(recovered, old + produced)
        assertEquals("old-0", recovered.sessionHistory.getValue("runtime").oldestEntryId)
        assertFalse(recovered.sessionHistory.getValue("runtime").hasOlder)
    }

    @Test fun `missed patch interval recovers and subsequent live patches keep advancing`() {
        val gapped = patch(initial(), 79, 80, "new-69", listOf(produced.last()), 1)
        assertEquals(setOf(80L), gapped.conversations.getValue("runtime").sourcePatchBuffer.keys)
        val sent = request(gapped)
        assertNull(sent.sessionSyncCommands.getValue("cmd-sync").knownState)
        val recovered = receive(sent, snapshot(), 2)
        assertRecovered(recovered)
        val newer = entry("new-70", "new-69")
        val advanced = patch(recovered, 80, 81, "new-70", listOf(newer), 3)
        assertEquals((tail + newer).map(SessionGraphEntry::entryId), ids(advanced))
        assertEquals(81L, advanced.appliedSessionState("runtime")?.seq)
    }

    @Test fun `an already retained projection can recover with a one entry window`() {
        val retained = patch(initial(), 10, 11, "new-69", listOf(produced.last()), 1)
        assertEquals("old-9", retained.conversations.getValue("runtime").retainedProjectionLeafId)
        val page = listOf(produced.last())
        val recovered = receive(request(retained), snapshot(entries = page), 2)
        assertRecovered(recovered, page)
        assertEquals("new-69", recovered.sessionHistory.getValue("runtime").oldestEntryId)
        assertTrue(recovered.sessionHistory.getValue("runtime").hasOlder)
    }

    @Test fun `connected bounded preview preserves paged messages and their oldest boundary`() {
        val entries = old + produced
        val older = entry("temporary-older", null)
        val baseline = initial()
        val state = baseline.copy(sessionGraphs = mapOf("session" to fixtureGraph("session", entries,
            SessionBranchCursor("old-9"), cacheEpoch = "epoch")),
            conversations = baseline.conversations.mapValues { (_, value) ->
                value.copy(messages = fixtureMessages(listOf(older)) + value.messages)
            },
            sessionHistory = mapOf("runtime" to SessionHistoryState("session", "old-9", older.entryId, false)))
        val recovered = receive(request(state), snapshot())
        assertRecovered(recovered, listOf(older) + entries)
        assertEquals(older.entryId, recovered.sessionHistory.getValue("runtime").oldestEntryId)
        assertFalse(recovered.sessionHistory.getValue("runtime").hasOlder)
    }

    @Test fun `new window replaces temporary paged rows and old live rows atomically`() {
        val baseline = initial()
        val older = entry("temporary-older", null)
        val oldLive = ChatMessage("old-live", "assistant", listOf(RemoteContent("text", "old")), 1)
        val newLive = ChatMessage("new-live", "assistant", listOf(RemoteContent("text", "new")), 2)
        val state = baseline.copy(conversations = baseline.conversations.mapValues { (_, value) ->
            value.copy(messages = fixtureMessages(listOf(older)) + value.messages + oldLive,
                streamingMessageIds = setOf(oldLive.messageId))
        }, sessionHistory = mapOf("runtime" to SessionHistoryState("session", "old-9", older.entryId, true)))
        val page = snapshot().copy(live = SessionLiveState(true,
            messages = listOf(SessionLiveMessage(newLive, false, true))))
        val recovered = receive(request(state), page)
        val conversation = recovered.conversations.getValue("runtime")
        assertEquals(tail.map(SessionGraphEntry::entryId) + newLive.messageId, ids(recovered))
        assertEquals(setOf(newLive.messageId), conversation.streamingMessageIds)
        assertFalse(conversation.isChatSyncing)
        assertNotNull(recovered.appliedSessionState("runtime"))
        assertEquals("new-40", recovered.sessionHistory.getValue("runtime").oldestEntryId)
    }

    @Test fun `a bounded window also applies when the older host omits selection`() {
        assertRecovered(receive(request(), snapshot().copy(selection = null)))
    }

    @Test fun `incomplete source and invalid ranges cannot replace the displayed branch`() {
        val valid = snapshot()
        val variants = listOf(
            valid.copy(rangeStatus = "missing_parent"),
            valid.copy(live = SessionLiveState(false)),
            valid.copy(source = SessionSourceEpoch("epoch", 9, true)),
            valid.copy(checkpoint = valid.checkpoint!!.copy(inventoryComplete = false)),
            valid.copy(entries = listOf(tail.first(), tail.last()), display = fixtureDisplayBatch(listOf(tail.first(), tail.last()))),
        )
        for (page in variants) {
            val state = receive(request(), page)
            assertEquals("must retain rows for $page", old.map(SessionGraphEntry::entryId), ids(state))
        }
    }

    @Test fun `a bounded response without its head cannot confirm a source baseline`() {
        val page = snapshot(entries = tail.dropLast(1))
        val state = receive(request(), page)
        assertNull(state.appliedSessionState("runtime"))
        assertTrue(state.conversations.getValue("runtime").isChatSyncing)
        assertTrue("runtime" in state.sessionSyncRequests)
    }

    @Test fun `old local history and prefetch reads cannot restore the superseded window`() {
        for (automatic in listOf(false, true)) {
            val baseline = initial().copy(sessionHistory = mapOf("runtime" to
                SessionHistoryState("session", "old-9", "old-0", true)))
            val read = baseline.beginHistoryRead("runtime", "old-read",
                SessionHistoryPrefetch("old-window", "old-9", "old-0").takeIf { automatic })
            assertNotNull(read.acceptance.operationId)
            val recovered = receive(request(read.state), snapshot())
            assertRecovered(recovered)
            assertEquals(SessionReadPhase.SUPERSEDED, recovered.sessionReads.getValue("old-read").phase)
            val late = recovered.applyLocalHistoryRead("old-read",
                fixtureRange(listOf(entry("old-older", null)), hasOlder = false, complete = true))
            assertEquals(recovered.conversations, late.conversations)
            assertEquals(recovered.sessionHistory, late.sessionHistory)
        }
    }

    @Test fun `an old remote history response cannot replace the new paging boundary`() {
        val baseline = initial().copy(sessionHistory = mapOf("runtime" to
            SessionHistoryState("session", "old-9", "old-0", true)))
        val read = baseline.beginHistoryRead("runtime", "old-read")
        val task = PendingSessionSync("runtime", "session", "old-sync", range = "history",
            targetLeafId = "old-9", beforeEntryId = "old-0", historyOperationId = "old-read")
        val sent = advanceSessionSyncTasks(read.state.queueSessionSync("old-command", task),
            System.currentTimeMillis(), 0).state
        // The source refresh has its own operation and may run beside an older history page.
        val source = sent.beginSessionRead("runtime", SessionReadKind.SOURCE, "read-sync")
        val refresh = source.state.queueSessionSync("cmd-sync", PendingSessionSync("runtime", "session", "sync",
            range = "preview", sourceRecovery = true, sourceRecoveryEpoch = "epoch", historyOperationId = "read-sync"))
            .copy(sessionSyncRequests = setOf("runtime"))
        val bothSent = advanceSessionSyncTasks(refresh, System.currentTimeMillis(), 0).state
        val recovered = receive(bothSent, snapshot())
        assertRecovered(recovered)
        assertEquals(SessionReadPhase.SUPERSEDED, recovered.sessionReads.getValue("old-read").phase)
        assertFalse("old-command" in recovered.pendingCommands)
        val late = snapshot("old-sync", old).copy(mode = "prepend", range = "history", selection = null,
            cursor = SessionBranchCursor("old-9"), targetLeafId = "old-9", beforeEntryId = "old-0",
            hasOlder = false, complete = true, rangeStatus = "complete", checkpoint = null, live = null)
        val ignored = receive(recovered, late, 2)
        assertEquals(recovered.conversations, ignored.conversations)
        assertEquals(recovered.sessionHistory, ignored.sessionHistory)
    }

    @Test fun `a failed old history read cannot block paging in the recovered window`() {
        val baseline = initial().copy(sessionHistory = mapOf("runtime" to
            SessionHistoryState("session", "old-9", "old-0", true)))
        val read = baseline.beginHistoryRead("runtime", "failed-old-read")
        val failed = read.state.failLocalSessionRead("failed-old-read", "old window failure")
        assertEquals(SessionReadPhase.FAILED, failed.historyReadForWindow("runtime")?.phase)
        val recovered = receive(request(failed), snapshot())
        assertRecovered(recovered)
        assertEquals(SessionReadPhase.SUPERSEDED, recovered.historyReadForWindow("runtime")?.phase)
        assertNull(recovered.historyReadForWindow("runtime")?.error)
    }

    @Test fun `a valid wire page cannot hide a gap in the committed parent chain`() {
        val broken = tail.map { if (it.entryId == "new-60") it.copy(parentId = "uncached-parent") else it }
        val state = receive(request(), snapshot(), committed = committedFixtureBatch(broken))
        assertEquals(old.map(SessionGraphEntry::entryId), ids(state))
        assertEquals("old-9", state.conversations.getValue("runtime").retainedProjectionLeafId)
        assertNull(state.appliedSessionState("runtime"))
    }

    @Test fun `source checkpoint and buffered successor commit as one recoverable window`() {
        val successor = entry("new-70", "new-69")
        val buffered = patch(initial(), 80, 81, "new-70", listOf(successor), 1)
        // Production ingestion can return the snapshot rows plus its contiguous buffered suffix.
        val page = snapshot()
        val display = mergedSnapshotDisplay(page.display,
            buffered.conversations.getValue("runtime").sourcePatchBuffer.values.toList())
        val recovered = receive(request(buffered), page, 2, CommittedSessionBatch(tail + successor, display))
        assertRecovered(recovered, tail + successor, 81)
    }

    @Test fun `a late response after leaving the session cannot install a new window`() {
        val switched = request().cancelForegroundSessionSyncs("other").copy(selectedRuntimeId = "other")
        val ignored = receive(switched, snapshot())
        assertEquals(switched.conversations, ignored.conversations)
        assertEquals(switched.sessionGraphs, ignored.sessionGraphs)
    }

    // The runner supplies snapshots generated by the actual frozen published selector and the
    // current selector. This is an explicit cross-version check, not a recreated old schema.
    @Test fun `published host and current host snapshots recover the same Android window`() {
        val directory = System.getenv("ORBIS_PREVIEW_WINDOW_FIXTURES")
        assumeTrue("Requires frozen published and current Host selector fixtures", directory != null)
        for (name in listOf("published-snapshot.json", "current-snapshot.json")) {
            val page = json.decodeFromString<SessionGraphSnapshot>(File(directory, name).readText())
            for (state in listOf(initial(), coldStart())) {
                val recovered = receive(request(state), page, committed = CommittedSessionBatch(page.entries, page.display))
                assertRecovered(recovered)
                assertEquals("new-40", recovered.sessionHistory.getValue("runtime").oldestEntryId)
                assertTrue(recovered.sessionHistory.getValue("runtime").hasOlder)
            }
        }
    }
}
