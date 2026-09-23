package dev.pi.remote

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test

class CanonicalSessionEntriesTest {
    private fun entry(id: String, parent: String?) = SessionGraphEntry(id, parent, "message", "stable")
    private fun snapshot(mode: String, entries: List<SessionGraphEntry>) = SessionGraphSnapshot(
        "s", "sync", SessionBranchCursor(entries.lastOrNull()?.entryId), mode, entries,
    )

    @Test
    fun `every mode rejects conflicts but permits identical overlaps and missing parents`() {
        val old = entry("a", "missing")
        val graph = SessionGraph("s", entries = mapOf("a" to old))
        for (mode in listOf("replace", "append", "prepend")) {
            val merged = graph.merge(snapshot(mode, listOf(old, old, entry("b", "a"))))
            assertEquals(setOf("a", "b"), merged.entries.keys)
            assertFalse(merged.hasCompleteEntryChain("b"))
            assertEquals("entry_conflict", runCatching {
                graph.merge(snapshot(mode, listOf(entry("b", "a"), old.copy(timestamp = "changed"))))
            }.exceptionOrNull()?.message)
            assertEquals(mapOf("a" to old), graph.entries)
        }
    }

    @Test
    fun `late parent closing a cycle is rejected in memory as in SQLite`() {
        val graph = SessionGraph("s", entries = mapOf("a" to entry("a", "b")))
        assertEquals("cycle_detected", runCatching {
            graph.merge(snapshot("prepend", listOf(entry("b", "c"), entry("c", "a"))))
        }.exceptionOrNull()?.message)
    }

    @Test
    fun `older snapshots cannot regress timing or the observed descendant`() {
        val done = TurnTiming("t", 100, durationMs = 10, messageId = "tail")
        val graph = SessionGraph("s", listOf(entry("root", null), entry("tail", "root")).associateBy { it.entryId },
            SessionBranchCursor("tail"), mapOf("t" to done))
        val old = snapshot("replace", listOf(entry("root", null))).copy(turnTimings = listOf(TurnTiming("t", 100)))
        val merged = graph.merge(old)
        assertEquals(done, merged.turnTimings["t"])
        assertEquals("tail", merged.cursor.leafId)
        assertEquals("turn_timing_conflict", runCatching {
            graph.merge(old.copy(turnTimings = listOf(done.copy(durationMs = 20))))
        }.exceptionOrNull()?.message)
    }
}
