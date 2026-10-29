package com.orbising.orbis

import org.junit.Assert.*
import org.junit.Test

class HistoryCoveragePerformanceTest {
    private class CountedEntries(private val source: Map<String, SessionGraphEntry>) : Map<String, SessionGraphEntry> by source {
        var reads = 0
        override fun get(key: String): SessionGraphEntry? { reads++; return source[key] }
    }
    @Test fun longCompactedHistoryKeepsCoverageWithoutRepeatedAncestorScans() {
        val entries = (0 until 4_000).associate { index ->
            "$index" to SessionGraphEntry("$index", (index - 1).takeIf { it >= 0 }?.toString(), "message", "1")
        }
        val counted = CountedEntries(entries)
        val graph = SessionGraph("s", counted, displayWindowStart = "3970",
            display = (3970 until 4000).associate { "$it" to DisplayEntry("$it", "$it", kind = "undisplayable") })
        val state = RemoteState(sessionGraphs = mapOf("s" to graph),
            sessionHistory = mapOf("r" to SessionHistoryState("s", "3999", "3970", false)))
        repeat(3) {
            counted.reads = 0
            val start = System.nanoTime()
            assertSame(state, state.reconcileHistoryReads())
            println("HistoryCoverage entries=4000 elapsedMs=${(System.nanoTime() - start) / 1_000_000.0}")
            assertTrue("Coverage must be linear: ${counted.reads} entry lookups", counted.reads <= entries.size * 2)
        }
        counted.reads = 0
        val selection = state.copy(selectedRuntimeId = "r")
        assertSame(selection, selection.reconcileHistoryReads(state))
        assertEquals("Selection alone cannot change graph coverage", 0, counted.reads)
    }

    @Test fun windowAncestorsDoNotHideGapsOnAnotherBranchOrAtTheWindowStart() {
        val entries = listOf(SessionGraphEntry("root", null, "message", "1"),
            SessionGraphEntry("window", "root", "message", "1"),
            SessionGraphEntry("fork", "root", "message", "1"),
            SessionGraphEntry("tail", "fork", "message", "1")).associateBy { it.entryId }
        val graph = SessionGraph("s", entries, displayWindowStart = "window",
            display = mapOf("tail" to DisplayEntry("tail", "tail", kind = "undisplayable")))
        val state = RemoteState(sessionGraphs = mapOf("s" to graph),
            sessionHistory = mapOf("r" to SessionHistoryState("s", "tail", "root", false)))
        val reconciled = state.reconcileHistoryReads()
        assertEquals("tail", reconciled.sessionHistory["r"]?.oldestEntryId)
        assertTrue(reconciled.sessionHistory.getValue("r").hasOlder)
        val filled = state.copy(sessionGraphs = mapOf("s" to graph.copy(display = graph.display +
            ("fork" to DisplayEntry("fork", "fork", kind = "undisplayable")))))
        assertSame(filled, filled.reconcileHistoryReads(state))
        val windowMissing = filled.copy(sessionGraphs = mapOf("s" to graph.copy(displayWindowStart = "fork")))
        assertEquals("tail", windowMissing.reconcileHistoryReads(filled).sessionHistory["r"]?.oldestEntryId)
    }
}
