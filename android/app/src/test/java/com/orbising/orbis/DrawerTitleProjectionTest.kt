package com.orbising.orbis

import org.junit.Assert.*
import org.junit.Test

class DrawerTitleProjectionTest {
    private fun graph(): SessionGraph {
        val entries = (0 until 200).associate { index ->
            val id = "$index"
            id to SessionGraphEntry(id, parentId = (index - 1).takeIf { it >= 0 }?.toString(), type = "message", timestamp = "2026-11-05T00:00:00Z")
        }
        val display = entries.mapValues { (id, _) -> DisplayEntry(id, entryId = id, kind = "message",
            message = ChatMessage(id, if (id.toInt() % 3 == 0) "user" else "assistant",
                listOf(RemoteContent("text", "Question $id。More")), id.toLong())) }
        return SessionGraph("s", entries = entries, cursor = SessionBranchCursor("199"), display = display)
    }

    private fun expected(graph: SessionGraph): String? = firstUserMessageTitle(projectSessionEntries(
        buildSessionPath(graph.entries, graph.cursor.leafId), graph.display, graph.displayWindowStart))

    @Test fun `title matches full projection for windows branches head anchors corrections and missing parents`() {
        val base = graph()
        val head = base.display.getValue("90").copy(anchor = DISPLAY_ANCHOR_HEAD)
        val variants = listOf(base, base.copy(displayWindowStart = "100"), base.copy(displayWindowStart = "missing"),
            base.copy(cursor = SessionBranchCursor("77")), base.copy(display = base.display + ("90" to head)),
            base.copy(display = base.display + ("0" to base.display.getValue("0").copy(message = null))),
            base.copy(entries = base.entries - "80"), base.copy(cursor = SessionBranchCursor()),
            base.copy(display = base.display + ("0" to base.display.getValue("0").copy(message = ChatMessage("0", "user",
                listOf(RemoteContent("text", " \n ")), 0)))))
        for (variant in variants) assertEquals(expected(variant), variant.firstUserMessageTitle())
    }

    @Test fun `title cache follows exact graph dependencies but ignores runtime status and transport metadata`() {
        var projections = 0
        val cache = SessionTitleCache { projections++; it.firstUserMessageTitle() }
        val graph = graph()
        val runtime = RuntimeSummary("r", "Runtime", "/repo", "idle", sessionId = "s", agentKind = "codex")
        val state = RemoteState(hostId = "host", sessions = mapOf("s" to SessionCatalogEntry("s", agentKind = "codex")),
            sessionGraphs = mapOf("s" to graph), runtimes = mapOf("r" to runtime))
        repeat(50) { assertEquals(expected(graph), cache.resolve(state, "s", runtime.copy(status = "running"))) }
        assertEquals(1, projections)
        val window = graph.copy(displayWindowStart = "100")
        assertEquals(expected(window), cache.resolve(state.copy(sessionGraphs = mapOf("s" to window)), "s", runtime))
        assertEquals(2, projections)
        val corrected = window.copy(display = window.display + ("102" to window.display.getValue("102").copy(
            message = ChatMessage("corrected", "user", listOf(RemoteContent("text", "Corrected")), 1))))
        assertEquals("Corrected", cache.resolve(state.copy(sessionGraphs = mapOf("s" to corrected)), "s", runtime))
        assertEquals(3, projections)
        cache.retain(null)
        cache.resolve(state, "s", runtime)
        assertEquals(4, projections)
    }

    @Test fun `metadata names and fixed Pi names skip all graph work`() {
        val cache = SessionTitleCache { error("Named sessions must not project history") }
        val graph = graph()
        val state = RemoteState(sessionGraphs = mapOf("s" to graph), sessions = mapOf("s" to
            SessionCatalogEntry("s", agentKind = "pi", name = "New name", cachedDisplayName = "Fixed Pi title")))
        assertEquals("Fixed Pi title", cache.resolve(state, "s", null))
        val codex = state.copy(sessions = mapOf("s" to SessionCatalogEntry("s", agentKind = "codex", name = "Named")))
        assertEquals("Named", cache.resolve(codex, "s", null))
    }

    @Test fun `authoritative name arrival releases the unused history title cache`() {
        var projections = 0
        val cache = SessionTitleCache { projections++; it.firstUserMessageTitle() }
        val state = RemoteState(sessionGraphs = mapOf("s" to graph()),
            sessions = mapOf("s" to SessionCatalogEntry("s", agentKind = "codex")))
        cache.resolve(state, "s", null)
        assertEquals(1, projections)
        val named = state.copy(sessions = mapOf("s" to state.sessions.getValue("s").copy(name = "Authoritative")))
        assertEquals("Authoritative", cache.resolve(named, "s", null))
        cache.resolve(state, "s", null)
        assertEquals(2, projections)
    }
}
