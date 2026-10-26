package com.orbising.orbis

import kotlinx.serialization.json.Json
import org.junit.Assert.*
import org.junit.Test

class AgentCatalogRangeTest {
    private val reducer = RelayReducer()
    private val json = Json { ignoreUnknownKeys = true }
    private fun first(state: RemoteState = RemoteState(), revision: Long = 1, id: String = "snapshot") = state.withModelFixture(
        "catalog", """{"totalSessions":2,"sessions":[{"sessionId":"first","agentKind":"pi"}],
        "backends":[{"kind":"pi","ready":true,"complete":true,"sessions":2}],
        "snapshotId":"$id","nextCursor":"cursor:$id","truncated":false}""", revision, scope = "host")
    private fun request(state: RemoteState, id: String = "range") = state.copy(agentCatalogRangeRequest =
        state.agentCatalogRange!!.let { AgentCatalogRangeRequest(id, it.nextCursor!!, it.modelEpoch, it.revision,
            it.snapshotId, it.sessions.size) })
    private fun page(request: String = "range", snapshot: String = "snapshot", revision: Long = 1, offset: Int = 1,
        next: String = "null", rows: String = """[{"sessionId":"second","agentKind":"pi"}]""", error: String = "") = """
        {"type":"agent.state.range.page","protocolVersion":$PROTOCOL_VERSION,"requestId":"$request",
         "scope":"host","domain":"catalog","page":{"modelEpoch":"fixture-model","revision":$revision,
         "snapshotId":"$snapshot","offset":$offset,"totalSessions":2,"sessions":$rows,"nextCursor":$next,
         "complete":true,"truncated":false$error}}
    """.trimIndent()

    @Test fun `first window retains directory until every fixed page arrives`() {
        val old = RemoteState(sessions = mapOf("old" to SessionCatalogEntry("old", agentKind = "pi"),
            "cached" to SessionCatalogEntry("cached", agentKind = "pi", hasHistoryCache = true)))
        val started = first(old)
        assertEquals(setOf("old", "cached", "first"), started.sessions.keys)
        assertTrue(started.catalogSummaryView().text.contains("读取中"))
        val complete = reducer.reduce(request(started), page(), channel = "ctl")
        assertEquals(setOf("cached", "first", "second"), complete.sessions.keys)
        assertNull(complete.agentCatalogRangeRequest)
        assertNull(complete.agentCatalogRange?.nextCursor)
        assertNull(complete.agentCatalogRange?.error)
        assertEquals(2, complete.agentCatalogRange?.sessions?.size)
        assertEquals(StatusTone.Good, complete.catalogSummaryView().tone)
    }

    @Test fun `pages require an authenticated matching request and fixed version`() {
        val state = request(first())
        assertEquals(state, reducer.reduce(state, page(request = "old"), channel = "ctl"))
        assertEquals(state, reducer.reduce(state, page()))
        for (payload in listOf(page(snapshot = "old"), page(revision = 0), page(offset = 0))) {
            val result = reducer.reduce(state, payload, channel = "ctl")
            assertEquals(setOf("first"), result.sessions.keys)
            assertEquals("snapshot_changed", result.agentCatalogRange?.error)
            assertNull(result.agentCatalogRangeRequest)
        }
    }

    @Test fun `a newer catalog version retires its in-flight cursor`() {
        val old = request(first())
        val fresh = first(old, 2, "next-snapshot")
        assertNull(fresh.agentCatalogRangeRequest)
        val late = reducer.reduce(fresh, page(), channel = "ctl")
        assertEquals(fresh, late)
        assertEquals("next-snapshot", late.agentCatalogRange?.snapshotId)
    }

    @Test fun `duplicate inventories and incomplete terminal pages cannot complete a directory`() {
        val state = request(first())
        for (payload in listOf(page(rows = """[{"sessionId":"first","agentKind":"pi"}]"""),
            page(rows = "[]"), page(next = "\"cursor:snapshot\""))) {
            val rejected = reducer.reduce(state, payload, channel = "ctl")
            assertEquals("invalid_page", rejected.agentCatalogRange?.error)
            assertEquals(setOf("first"), rejected.sessions.keys)
        }
    }

    @Test fun `explicit snapshot change preserves last known sessions for a fresh read`() {
        val state = request(first())
        val result = reducer.reduce(state, page(rows = "[]", error = ",\"error\":\"snapshot_changed\""), channel = "ctl")
        assertEquals(state.sessions, result.sessions)
        assertEquals("snapshot_changed", result.agentCatalogRange?.error)
        assertEquals(StatusTone.Warn, result.catalogSummaryView().tone)
    }
}
