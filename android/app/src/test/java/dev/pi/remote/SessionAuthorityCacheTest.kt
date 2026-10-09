package dev.pi.remote

import org.junit.Assert.*
import org.junit.Test

class SessionAuthorityCacheTest {
    private fun entry(id: String, parent: String? = null, time: String = "1") = SessionGraphEntry(id, parent, "message", time)
    private fun page(epoch: String, seq: Long, vararg entries: SessionGraphEntry) = SessionGraphSnapshot(
        "s", "sync", SessionBranchCursor(), "prepend", entries.toList(), source = SessionSourceEpoch(epoch, seq, true))

    @Test fun `accepted new epoch replaces cached edges and old rows`() {
        val old = SessionGraph("s").merge(page("old", 1, entry("a"), entry("b", "a"), entry("c", "b")))
        val corrected = old.merge(page("new", 1, entry("c", "a", "corrected")))
        assertEquals(setOf("c"), corrected.entries.keys)
        assertEquals("a", corrected.entries.getValue("c").parentId)
        assertEquals("new", corrected.cacheEpoch)
        assertFalse(corrected.hasCompleteEntryChain("c"))
    }

    @Test fun `late same epoch page fills holes but cannot overwrite newer nodes`() {
        val graph = SessionGraph("s").merge(page("e", 10, entry("b", "a", "new")))
        val filled = graph.merge(page("e", 2, entry("a"), entry("b", "wrong", "old")))
        assertEquals("new", filled.entries.getValue("b").timestamp)
        assertEquals("a", filled.entries.getValue("b").parentId)
        assertTrue(filled.hasCompleteEntryChain("b"))
        assertEquals(10L, filled.entryVersions["b"])
    }

    @Test fun `newer authority corrects same id while partial page preserves unrelated rows`() {
        val graph = SessionGraph("s").merge(page("e", 1, entry("a"), entry("b", "a"), entry("c", "b")))
        val corrected = graph.merge(page("e", 2, entry("b", "missing", "new")))
        assertEquals(setOf("a", "b", "c"), corrected.entries.keys)
        assertFalse(corrected.hasCompleteEntryChain("c"))
        assertEquals("new", corrected.entries.getValue("b").timestamp)
    }

    @Test fun `authority does not permit cycles or inconsistent duplicate ids`() {
        val graph = SessionGraph("s").merge(page("e", 1, entry("a"), entry("b", "a")))
        assertEquals("cycle_detected", runCatching { graph.merge(page("e", 2, entry("a", "b"))) }.exceptionOrNull()?.message)
        assertEquals("entry_conflict", runCatching { graph.merge(page("e", 2, entry("a"), entry("a", "b"))) }.exceptionOrNull()?.message)
    }

    @Test fun `cache gate rejects old history and unhandshaken epoch before persistence`() {
        val conversation = RuntimeConversation(sourceEpoch = "e", sourceSeq = 10, sourceReady = true,
            retiredSourceEpochs = setOf("old"))
        assertFalse(conversation.snapshotSourceGate(page("old", 99, entry("a")), "history").cacheAllowed)
        assertFalse(conversation.snapshotSourceGate(page("future", 1, entry("a")), "history").cacheAllowed)
        assertTrue(conversation.snapshotSourceGate(page("e", 1, entry("a")), "history").cacheAllowed)
        val checkpoint = page("future", 1).copy(range = "preview",
            checkpoint = SessionCheckpoint("id", SessionBranchCursor(), "complete", true), live = SessionLiveState(true))
        assertTrue(conversation.snapshotSourceGate(checkpoint, "preview").epochSwitchRejected)
        assertFalse(conversation.snapshotSourceGate(checkpoint, "preview").cacheAllowed)
        assertTrue(conversation.copy(isChatSyncing = true).snapshotSourceGate(checkpoint, "preview").epochSwitchRejected)
        assertTrue(conversation.snapshotSourceGate(checkpoint, "preview", sourceRecovery = true).cacheAllowed)
        assertTrue(conversation.snapshotSourceGate(checkpoint, "preview", sourceRecovery = true, sourceRecoveryEpoch = "stale").epochSwitchRejected)
        assertFalse(conversation.snapshotSourceGate(checkpoint.copy(live = SessionLiveState(false)), "preview", sourceRecovery = true).cacheAllowed)
        assertFalse(conversation.snapshotSourceGate(checkpoint.copy(source = SessionSourceEpoch("old", 99, true)), "preview", sourceRecovery = true).cacheAllowed)
    }
}
