package dev.pi.remote

import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import org.junit.Assert.*
import org.junit.Test

class NotificationsTest {
    private val json = Json { ignoreUnknownKeys = true }
    private val reducer = RelayReducer()
    private fun initial() = RemoteState(notificationEpoch = "host", runtimes = mapOf(
        "runtime" to RuntimeSummary("runtime", "Agent", "D:/repo", "idle", "session"),
        "other" to RuntimeSummary("other", "Agent", "D:/other", "idle", "other-session")),
        lastSequence = mapOf("runtime\u0000ctl" to 99999L))
    private fun notice(id: String) = RuntimeNotice(id, "producer", id, "occurrence", NoticeScope(turnId = "turn"),
        "warning", id, "condition", 1, 1, "confirmed")
    private fun receive(state: RemoteState, revision: Long, items: List<RuntimeNotice>, host: String = "host",
        runtime: String = "runtime", session: String = "session", complete: Boolean = true, channel: String? = "ctl"): RemoteState {
        val snapshot = NoticeSnapshot(host, runtime, session, revision, complete, "confirmed", items)
        val payload = json.encodeToString(snapshot).dropLast(1) + ",\"type\":\"notification.snapshot\",\"protocolVersion\":$PROTOCOL_VERSION}"
        return reducer.reduce(state, payload, channel = channel)
    }
    @Test fun `full inventory fixes a lost clear and does not depend on transport or chat versions`() {
        val active = receive(initial(), 1, listOf(notice("retry"), notice("sandbox")))
        val recovered = receive(active, 7, listOf(notice("sandbox")))
        assertEquals(listOf("sandbox"), recovered.notificationProjections.getValue("runtime").items.map { it.code })
        assertEquals(recovered, receive(recovered, 2, listOf(notice("retry"))))
        assertEquals(99999L, recovered.lastSequence["runtime\u0000ctl"])
    }
    @Test fun `partial snapshots cannot clear notices and can recover with a complete successor`() {
        val active = receive(initial(), 1, listOf(notice("retry")))
        val unknown = receive(active, 2, emptyList(), complete = false)
        assertEquals("unknown", unknown.notificationProjections.getValue("runtime").verification)
        assertEquals(1, unknown.notificationProjections.getValue("runtime").items.size)
        assertTrue(receive(unknown, 3, emptyList()).notificationProjections.getValue("runtime").items.isEmpty())
    }
    @Test fun `a snapshot cannot switch Host epochs without an authenticated ready`() {
        val active = receive(initial(), 10, listOf(notice("retry")))
        assertEquals(active, receive(active, 99, emptyList(), host = "old"))
        val handshake = reducer.reduce(active, """{"type":"device.ready","protocolVersion":$PROTOCOL_VERSION,
            "deviceId":"phone","notificationEpoch":"new","agents":[],"runtimes":[
              {"runtimeId":"runtime","name":"Agent","cwd":"D:/repo","status":"idle","sessionId":"session"}]}""", channel = "ctl")
        val recovered = receive(handshake, 0, emptyList(), host = "new")
        assertTrue(recovered.notificationProjections.getValue("runtime").items.isEmpty())
        assertEquals(recovered, receive(recovered, 11, listOf(notice("retry"))))
    }
    @Test fun `old session and plaintext notifications cannot modify an active view`() {
        val state = initial()
        assertEquals(state, receive(state, 1, listOf(notice("retry")), session = "retired"))
        assertEquals(state, receive(state, 1, listOf(notice("retry")), channel = null))
    }
    @Test fun `one runtime cannot clear another and phone time never expires a remote condition`() {
        val first = receive(initial(), 1, listOf(notice("sandbox")))
        val both = receive(first, 1, listOf(notice("retry")), runtime = "other", session = "other-session")
        val settled = receive(both, 2, emptyList())
        assertEquals("retry", settled.notificationProjections.getValue("other").items.single().code)
    }
    @Test fun `malformed condition expiration and duplicate identities leave the baseline intact`() {
        val state = receive(initial(), 1, listOf(notice("retry")))
        assertEquals(state, receive(state, 2, listOf(notice("retry").copy(expiresAt = 99))))
        assertEquals(state, receive(state, 2, listOf(notice("a"), notice("a"))))
    }
    @Test fun `legacy error cannot revive a cleared Host notification`() {
        val cleared = receive(receive(initial(), 1, listOf(notice("retry"))), 2, emptyList())
        val delayed = reducer.reduce(cleared, """{"type":"runtime.event","runtimeId":"runtime","sequence":100000,
          "event":{"type":"runtime.error","message":"Reconnecting...","recoverable":true}}""", channel = "ctl")
        assertTrue(delayed.notificationProjections.getValue("runtime").items.isEmpty())
        assertNull(delayed.error)
    }
    @Test fun `a partial inventory for a different Session cannot inherit old Session notices`() {
        val old = receive(initial(), 1, listOf(notice("retry")))
        val switched = old.copy(runtimes = old.runtimes + ("runtime" to old.runtimes.getValue("runtime").copy(sessionId = "new")))
        val pending = receive(switched, 2, emptyList(), session = "new", complete = false)
        assertTrue(pending.notificationProjections.getValue("runtime").items.isEmpty())
        assertEquals("unknown", pending.notificationProjections.getValue("runtime").verification)
    }
}
