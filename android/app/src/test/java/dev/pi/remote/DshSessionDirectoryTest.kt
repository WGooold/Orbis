package dev.pi.remote

import org.junit.Assert.*
import org.junit.Test

class DshSessionDirectoryTest {
    private val reducer = RelayReducer()

    @Test fun `current DSH directory drops missing uncached sessions but preserves history online and other agents`() {
        val state = RemoteState(hostId = "host", sessions = listOf(
            SessionCatalogEntry("dsh:old", name = "Same", agentKind = "dsh"),
            SessionCatalogEntry("dsh:cached", agentKind = "dsh", hasHistoryCache = true),
            SessionCatalogEntry("dsh:online", agentKind = "dsh"),
            SessionCatalogEntry("pi:old", agentKind = "pi"),
        ).associateBy { it.sessionId }, runtimes = mapOf("dsh:online" to RuntimeSummary(
            runtimeId = "dsh:online", sessionId = "dsh:online", name = "DSH", cwd = "D:/work", status = "idle",
        )))
        val next = state.withModelFixture("catalog", """{"backends":[{"kind":"dsh","complete":true}],"sessions":[
            {"sessionId":"dsh:a","name":"Same","agentKind":"dsh"},
            {"sessionId":"dsh:b","name":"Same","agentKind":"dsh"}]}""", scope = "host")
        assertEquals(setOf("dsh:a", "dsh:b", "dsh:cached", "dsh:online", "pi:old"), next.sessions.keys)
        assertEquals(2, next.sessions.values.count { it.name == "Same" })
        assertTrue(next.sessions["dsh:cached"]!!.hasHistoryCache)
        assertEquals(1, cachedHistoryTree(next).flatMap { it.directories }.flatMap { it.sessions }.count { it.sessionId == "dsh:online" })
    }

    @Test fun `empty or other-agent directory is not evidence to erase DSH entries`() {
        val state = RemoteState(sessions = mapOf("dsh:old" to SessionCatalogEntry("dsh:old", agentKind = "dsh")))
        assertTrue(reducer.reduce(state, """{"type":"session.list.result","sessions":[]}""").sessions.containsKey("dsh:old"))
        assertTrue(reducer.reduce(state, """{"type":"session.list.result","sessions":[{"sessionId":"pi:new","agentKind":"pi"}]}""").sessions.containsKey("dsh:old"))
    }

    @Test fun `explicit resume selects its acknowledged session in either event order`() {
        val runtime = """{"runtimeId":"dsh:target","sessionId":"dsh:target","name":"DSH","cwd":"D:/work","status":"idle"}"""
        val online = """{"type":"runtime.online","runtime":$runtime}"""
        val ack = """{"type":"session.activated","requestId":"resume","sessionId":"dsh:target","agentKind":"dsh","spawnMode":"headless"}"""
        for (events in listOf(listOf(online, ack), listOf(ack, online))) {
            var state = RemoteState(selectedRuntimeId = "other", sessionActivateRequests = setOf("resume"), sessionActivateTargets = mapOf("resume" to "dsh:target"))
            for (event in events) state = reducer.reduce(state, event).openAcknowledgedSession()
            assertEquals("dsh:target", state.selectedRuntimeId)
            assertNull(state.activatedSessionToOpen)
            assertTrue(state.sessionActivateTargets.isEmpty())
        }
    }

    @Test fun `failed or unrelated activation cannot navigate`() {
        val initial = RemoteState(selectedRuntimeId = "other", sessionActivateRequests = setOf("resume"), sessionActivateTargets = mapOf("resume" to "dsh:target"))
        val failed = reducer.reduce(initial, """{"type":"protocol.error","requestId":"resume","code":"session_not_found","message":"missing"}""").openAcknowledgedSession()
        assertTrue(failed.sessionActivateTargets.isEmpty())
        assertEquals("other", failed.selectedRuntimeId)
        val mismatch = reducer.reduce(initial, """{"type":"session.activated","requestId":"resume","sessionId":"dsh:wrong","agentKind":"dsh"}""").openAcknowledgedSession()
        assertNull(mismatch.activatedSessionToOpen)
        assertEquals("other", mismatch.selectedRuntimeId)
    }
}
