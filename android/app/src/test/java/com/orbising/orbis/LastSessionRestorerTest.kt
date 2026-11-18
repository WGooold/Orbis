package com.orbising.orbis

import org.junit.Assert.*
import org.junit.Test

/** MH-02: startup history must hand over to live chat without overriding later navigation. */
class LastSessionRestorerTest {
    private val saved = LastSession("device", "old-runtime", "session")
    private val initial = RemoteState(hostId = "host", deviceId = "device", connection = RelayConnection.ONLINE,
        sessions = mapOf("session" to SessionCatalogEntry("session", hasHistoryCache = true)))

    private fun runtime(id: String = "new-runtime", session: String? = "session", kind: String = "codex") =
        RuntimeSummary(id, "Agent", "/repo", "running", sessionId = session, agentKind = kind, sessionGraphSync = true)

    @Test fun `cached startup follows the same session when its runtime arrives later`() {
        for (kind in listOf("codex", "claude", "pi", "dsh")) {
            val restorer = LastSessionRestorer()
            val unrelated = runtime("other-runtime", "other-session", kind)
            val starting = initial.copy(runtimes = mapOf(unrelated.runtimeId to unrelated))
            assertEquals(LastSessionRestoreTarget.History("session"), restorer.next(starting, saved))
            val history = starting.copy(selectedOfflineSessionId = "session")
            // Unrelated streaming/catalog frames must neither reload the cache nor end recovery.
            repeat(250) { assertNull(restorer.next(history, saved)) }
            val online = RelayReducer().reduce(history,
                """{"type":"runtime.online","runtime":{"runtimeId":"new-runtime","sessionId":"session","name":"Agent","cwd":"/repo","status":"running","agentKind":"$kind","sessionGraphSync":true}}""")
            // Directory routing is ready before the separate identity/execution domain snapshots.
            assertEquals("session", online.runtimes["new-runtime"]?.sessionId)
            assertEquals(LastSessionRestoreTarget.Runtime("new-runtime"), restorer.next(online, saved))
            assertTrue(restorer.settled)
            assertNull(restorer.next(online, saved))
        }
    }

    @Test fun `empty authenticated directory can show cache and later become live`() {
        val restorer = LastSessionRestorer()
        val ready = RelayReducer().reduce(initial,
            """{"type":"device.ready","deviceId":"device","runtimes":[]}""", channel = "ctl")
        assertEquals(LastSessionRestoreTarget.History("session"), restorer.next(ready, saved))
        val live = runtime()
        assertEquals(LastSessionRestoreTarget.Runtime(live.runtimeId), restorer.next(ready.copy(
            selectedOfflineSessionId = "session", runtimes = mapOf(live.runtimeId to live)), saved))
    }

    @Test fun `existing live session opens directly even when its old runtime id was reused`() {
        val restorer = LastSessionRestorer()
        val live = runtime()
        val reused = runtime(saved.runtimeId, "different-session")
        assertEquals(LastSessionRestoreTarget.Runtime(live.runtimeId), restorer.next(initial.copy(
            runtimes = mapOf(reused.runtimeId to reused, live.runtimeId to live)), saved))
        assertTrue(restorer.settled)
    }

    @Test fun `reused runtime cannot replace the saved session and legacy runtime records still open`() {
        val reused = runtime(saved.runtimeId, "different-session")
        assertEquals(LastSessionRestoreTarget.History("session"), LastSessionRestorer().next(initial.copy(
            runtimes = mapOf(reused.runtimeId to reused)), saved))
        assertEquals(LastSessionRestoreTarget.Runtime(saved.runtimeId), LastSessionRestorer().next(initial.copy(
            runtimes = mapOf(reused.runtimeId to reused)), saved.copy(sessionId = null)))
    }

    @Test fun `explicit navigation stops a pending startup restoration`() {
        val live = runtime()
        for (destination in listOf(initial, initial.copy(selectedRuntimeId = "other-runtime"),
            initial.copy(selectedOfflineSessionId = "other-session"))) {
            val restorer = LastSessionRestorer()
            assertEquals(LastSessionRestoreTarget.History("session"), restorer.next(initial, saved))
            assertNull(restorer.next(destination, saved))
            assertTrue(restorer.settled)
            assertNull(restorer.next(initial.copy(selectedOfflineSessionId = "session",
                runtimes = mapOf(live.runtimeId to live)), saved))
        }
        val cancelled = LastSessionRestorer()
        assertEquals(LastSessionRestoreTarget.History("session"), cancelled.next(initial, saved))
        cancelled.cancel()
        assertNull(cancelled.next(initial.copy(selectedOfflineSessionId = "session",
            runtimes = mapOf(live.runtimeId to live)), saved))
    }

    @Test fun `missing cache keeps waiting for live directory across unrelated updates and reconnect`() {
        val restorer = LastSessionRestorer()
        val empty = initial.copy(sessions = emptyMap())
        repeat(250) { assertNull(restorer.next(empty, saved)) }
        val live = runtime()
        val disconnected = empty.copy(connection = RelayConnection.RECONNECTING, runtimes = mapOf(live.runtimeId to live))
        assertNull(restorer.next(disconnected, saved))
        assertFalse(restorer.settled)
        assertEquals(LastSessionRestoreTarget.Runtime(live.runtimeId), restorer.next(
            disconnected.copy(connection = RelayConnection.ONLINE), saved))
    }

    @Test fun `cached view survives reconnect until the saved session returns`() {
        val restorer = LastSessionRestorer()
        assertEquals(LastSessionRestoreTarget.History("session"), restorer.next(initial, saved))
        val history = initial.copy(selectedOfflineSessionId = "session", connection = RelayConnection.RECONNECTING)
        assertNull(restorer.next(history, saved))
        assertFalse(restorer.settled)
        val live = runtime()
        assertEquals(LastSessionRestoreTarget.Runtime(live.runtimeId), restorer.next(history.copy(
            connection = RelayConnection.ONLINE, runtimes = mapOf(live.runtimeId to live)), saved))
    }

    @Test fun `another device or an existing foreground selection cannot be restored over`() {
        val live = runtime()
        for ((state, record) in listOf(initial to null, initial.copy(deviceId = "other-device") to saved,
            initial.copy(selectedRuntimeId = "chosen-runtime") to saved,
            initial.copy(selectedOfflineSessionId = "chosen-session") to saved)) {
            val restorer = LastSessionRestorer()
            assertNull(restorer.next(state.copy(runtimes = mapOf(live.runtimeId to live)), record))
            assertTrue(restorer.settled)
        }
    }
}
