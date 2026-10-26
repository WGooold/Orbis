package com.orbising.orbis

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.After
import org.junit.Assert.*
import org.junit.Test

class SessionSyncSelectionInstrumentedTest {
    private val context = ApplicationProvider.getApplicationContext<Context>()
    private val store = SessionGraphStore(context, directoryName = "sync-selection-${java.util.UUID.randomUUID()}")
    private val device = DeviceCredential("wss://sync-selection.example.com", "test-device", "test-credential")
    private fun entry(id: String, parent: String?) = SessionGraphEntry(id, parent, "message", "1",
        buildJsonObject { put("message", buildJsonObject { put("role", "user"); put("content", id) }) })
    @After fun cleanUp() { store.clear() }
    private fun state(): RemoteState {
        val source = SessionSourceEpoch("epoch", 10, true)
        store.upsert(device, "s", listOf(entry("a", null)), "a", source = source, activateSource = true)
        val graph = store.withCacheVersions(device, fixtureGraph("s", mapOf("a" to entry("a", null)), SessionBranchCursor("a")))
        val state = RemoteState(selectedRuntimeId = "r",
            runtimes = mapOf("r" to RuntimeSummary("r", "R", "/", "idle", "s", sessionGraphSync = true, sessionLeafId = "a")),
            sessionGraphs = mapOf("s" to graph), runtimeSessionViews = mapOf("r" to RuntimeSessionView("r", "s", "a")),
            conversations = mapOf("r" to RuntimeConversation(hasLiveSnapshot = true, sourceEpoch = "epoch", sourceSeq = 10,
                sourceHeadLeafId = "a")), sessionSyncRequests = setOf("r"))
        return advanceSessionSyncTasks(state.queueSessionSync("request", state.requestedSessionRecovery("r", 0, "sync")!!), 1_000, 0).state
    }
    private fun snapshot(selection: String, seq: Long, head: String, entries: List<SessionGraphEntry>) = SessionGraphSnapshot(
        "s", "sync", SessionBranchCursor(head), "append", entries, range = "preview", targetLeafId = head,
        complete = true, rangeStatus = "complete", source = SessionSourceEpoch("epoch", seq, true),
        checkpoint = SessionCheckpoint("epoch:$seq", SessionBranchCursor(head), "complete", true),
        live = SessionLiveState(true).takeUnless { selection == "unchanged" }, selection = selection,
        // 真实后端随条目一起发显示结果；夹具照做，摄取路径因此也走到「读回盘上那份」的分支。
        display = fixtureDisplayBatch(entries),
    )
    @Test fun unchangedDoesNotWriteOrActivateCache() {
        val state = state()
        val before = store.withCacheVersions(device, state.sessionGraphs.getValue("s"))
        assertEquals(emptyList<SessionGraphEntry>(), ingestSessionSnapshot(store, device, "r", "request",
            snapshot("unchanged", 10, "a", emptyList()), { state }, { true })?.entries)
        assertEquals(before, store.withCacheVersions(device, state.sessionGraphs.getValue("s")))
        assertEquals("a", store.latestLeaf(device, "s"))
        assertTrue(store.hasContinuousCoverage(device, "s", "a"))
    }
    @Test fun deltaCommitsSuffixVersionAndCoverageBeforeStateCanAdvance() {
        val state = state()
        val b = entry("b", "a")
        assertEquals(listOf(b), ingestSessionSnapshot(store, device, "r", "request",
            snapshot("delta", 11, "b", listOf(b)), { state }, { true })?.entries)
        assertEquals(listOf(entry("a", null), b), store.readBranch(device, "s", "b").entries)
        assertEquals("epoch", store.cacheEpoch(device, "s"))
        assertTrue(store.hasContinuousCoverage(device, "s", "b"))
        assertEquals(11L, store.withCacheVersions(device, SessionGraph("s", mapOf("b" to b))).entryVersions["b"])
        assertEquals(10L, state.conversations.getValue("r").sourceSeq)
    }
    @Test fun obsoleteRequestCannotPersistItsDelta() {
        val state = state()
        val obsolete = state.copy(sessionBranchGenerations = mapOf("r" to 1))
        assertNull(ingestSessionSnapshot(store, device, "r", "request",
            snapshot("delta", 11, "b", listOf(entry("b", "a"))), { obsolete }, { true }))
        assertFalse(store.contains(device, "s", "b"))
        assertEquals("a", store.latestLeaf(device, "s"))
    }
    @Test fun unknownBoundaryRejectsConditionalEntriesUntilAFreshSnapshotArrives() {
        val state = state()
        val unknown = state.copy(conversations = state.conversations.mapValues { (_, conversation) ->
            conversation.copy(sourceReady = false, sourceSeq = -1, isChatSyncing = true)
        })
        assertEquals(emptyList<SessionGraphEntry>(), ingestSessionSnapshot(store, device, "r", "request",
            snapshot("delta", 11, "b", listOf(entry("b", "a"))), { unknown }, { true }))
        assertFalse(store.contains(device, "s", "b"))
        assertEquals("a", store.latestLeaf(device, "s"))
        assertEquals("epoch", store.cacheEpoch(device, "s"))
    }
    @Test fun malformedDeltaCannotWriteOrPromoteCoverage() {
        val state = state()
        try {
            ingestSessionSnapshot(store, device, "r", "request",
                snapshot("delta", 11, "b", listOf(entry("b", "missing"))), { state }, { true })
            fail("A delta must be anchored to the applied client head")
        } catch (error: IllegalArgumentException) { assertEquals("session_delta_gap", error.message) }
        assertFalse(store.contains(device, "s", "b"))
        assertEquals("a", store.latestLeaf(device, "s"))
        assertEquals(10L, state.conversations.getValue("r").sourceSeq)
    }

    @Test fun missingSourceOrCheckpointCannotWriteAnyCanonicalRows() {
        val current = state()
        val b = entry("b", "a")
        for (range in listOf("preview", "history", "catchup")) {
            val owned = current.copy(sessionSyncCommands = current.sessionSyncCommands.mapValues { (_, request) -> request.copy(
                range = range, knownState = null, targetLeafId = "a", requestTargetLeafId = "a", beforeEntryId = null) })
            val page = snapshot("snapshot", 11, "a", listOf(b)).copy(range = range,
                mode = if (range == "history") "prepend" else "replace", selection = null, source = null,
                checkpoint = null, live = null)
            try {
                ingestSessionSnapshot(store, device, "r", "request", page, { owned }, { true })
                fail("$range must require a source before writing canonical rows")
            } catch (error: IllegalArgumentException) { assertEquals("session_source_missing", error.message) }
            assertFalse(store.contains(device, "s", "b"))
            assertEquals("a", store.latestLeaf(device, "s"))
            assertEquals("epoch", store.cacheEpoch(device, "s"))
        }
        try {
            ingestSessionSnapshot(store, device, "r", "request",
                snapshot("delta", 11, "b", listOf(b)).copy(checkpoint = null), { current }, { true })
            fail("A preview checkpoint must be validated before writing canonical rows")
        } catch (error: IllegalArgumentException) { assertEquals("session_checkpoint_missing", error.message) }
        assertFalse(store.contains(device, "s", "b"))
        assertEquals(10L, current.conversations.getValue("r").sourceSeq)
    }
}
