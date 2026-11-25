package com.orbising.orbis

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
    @Test fun `Host removal proof can expire an outcome without pretending the source recovered`() {
        val active = receive(initial(), 1, listOf(notice("retry"), notice("done").copy(lifecycle = "outcome", displayMs = 8000, expiresAt = 9000)))
        val snapshot = NoticeSnapshot("host", "runtime", "session", 2, false, "unknown", emptyList(), listOf("done"))
        val payload = json.encodeToString(snapshot).dropLast(1) + ",\"type\":\"notification.snapshot\",\"protocolVersion\":$PROTOCOL_VERSION}"
        val expired = reducer.reduce(active, payload, channel = "ctl")
        assertEquals(listOf("retry"), expired.notificationProjections.getValue("runtime").items.map { it.notificationId })
        assertEquals("unknown", expired.notificationProjections.getValue("runtime").verification)
    }
    @Test fun `a partial inventory for a different Session cannot inherit old Session notices`() {
        val old = receive(initial(), 1, listOf(notice("retry")))
        val switched = old.copy(runtimes = old.runtimes + ("runtime" to old.runtimes.getValue("runtime").copy(sessionId = "new")))
        val pending = receive(switched, 2, emptyList(), session = "new", complete = false)
        assertTrue(pending.notificationProjections.getValue("runtime").items.isEmpty())
        assertEquals("unknown", pending.notificationProjections.getValue("runtime").verification)
    }

    private fun interactionNotice(id: String, code: String, request: String? = null) = notice(id).copy(
        code = code, scope = NoticeScope(requestId = request), lifecycle = "outcome", severity = "error", message = "Raw detail",
    )

    // MOBILE-INTERACTION-04: ambiguous legacy failures are not presented as confirmed rejections.
    @Test fun `terminal interaction result and confirmed rejection are distinct from a legacy warning`() {
        val result = interactionNotice("done", "interaction.result", "request").copy(severity = "info", message = "已处理")
        val rejected = interactionNotice("rejected", "interaction.submit.rejected", "request")
        val legacy = interactionNotice("legacy", "interaction.submit", "request")

        assertTrue(result.isInteractionResult)
        assertFalse(result.isResponseOutcome)
        assertEquals("info" to "已处理", result.displaySeverity to result.displayMessage)
        assertTrue(rejected.isResponseOutcome)
        assertFalse(rejected.isInteractionResult)
        assertEquals("error" to "提交失败", rejected.displaySeverity to rejected.displayMessage)
        assertTrue(legacy.isResponseOutcome)
        assertFalse(legacy.isInteractionResult)
        assertEquals("warning" to "回答结果未确认", legacy.displaySeverity to legacy.displayMessage)
    }

    // Deduplication is a chat-only projection, not a change to Host authority.
    @Test fun `chat drops only submission copies owned by a matching request or result`() {
        fun approval(id: String, error: String? = null) = PendingInteraction(
            id, "test", "confirm", "Approve?", null, emptyList(), null, responseError = error,
        )
        val local = approval("local", "Local send error")
        val pending = approval("pending")
        val elsewhere = approval("elsewhere", "Different runtime error")
        val base = initial().copy(conversations = mapOf(
            "runtime" to RuntimeConversation(interactions = listOf(local, pending).associateBy { it.requestId }),
            "other" to RuntimeConversation(interactions = mapOf(elsewhere.requestId to elsewhere)),
        ))
        val (created, creation) = base.createRespond("command", "runtime", pending.requestId, "已允许", 0)
        assertTrue(creation is LedgerCreation.Created)
        val responding = created.ledgerWritten("command", 0).copy(interactionOutcomes = mapOf(
            "runtime" to InteractionOutcome("outcome", "已允许", Long.MAX_VALUE, requestId = "settled"),
        ))
        val retained = listOf(
            interactionNotice("terminal", "interaction.result", "remote-result").copy(severity = "info"),
            interactionNotice("nonmatching", "interaction.submit.rejected", "elsewhere"),
            interactionNotice("unscoped", "interaction.submit"),
            notice("sandbox"),
        )
        val copies = listOf(
            interactionNotice("local-copy", "interaction.submit.rejected", "local"),
            interactionNotice("pending-copy", "interaction.submit", "pending"),
            interactionNotice("settled-copy", "interaction.submit", "settled"),
            interactionNotice("terminal-copy", "interaction.submit.rejected", "remote-result"),
        )
        val state = receive(responding, 1, copies + retained)
        // The other request occupies the workspace. The two short statuses cannot own visible feedback.
        assertEquals(copies.slice(1..2) + retained, state.chatNoticeProjection("runtime", "session")?.items)
        assertNull(state.chatNoticeProjection("runtime", "retired"))
        assertEquals(copies + retained, state.notificationProjections.getValue("runtime").items)

        val withoutLocal = state.copy(conversations = state.conversations + ("runtime" to RuntimeConversation(interactions = mapOf(pending.requestId to pending))))
        assertEquals(pending.requestId, withoutLocal.interactionStatus("runtime")?.requestId)
        assertEquals(listOf(copies[0], copies[2]) + retained, withoutLocal.chatNoticeProjection("runtime", "session")?.items)
    }

    // Host time, not phone time, retires notices. A request-local error only owns visible feedback while it can still display.
    @Test fun `expired request does not hide its fallback and dismissing a terminal does not expose a duplicate`() {
        val expired = PendingInteraction("expired", "test", "confirm", "Approve?", null, emptyList(), null,
            expiresAt = 10, responseError = "Old error")
        val fallback = interactionNotice("expired-fallback", "interaction.submit.rejected", expired.requestId)
        val terminal = interactionNotice("terminal", "interaction.result", "ended")
        val duplicate = interactionNotice("old-fallback", "interaction.submit", "ended")
        val base = initial().copy(conversations = mapOf("runtime" to RuntimeConversation(interactions = mapOf(expired.requestId to expired))))
        val state = receive(base, 1, listOf(fallback, terminal, duplicate))
        assertEquals(listOf(terminal), state.chatNoticeProjection("runtime", "session", now = 9)?.items)
        assertEquals(listOf(fallback, terminal), state.chatNoticeProjection("runtime", "session", now = 10)?.items)
        val (dismissing, creation) = state.createDismiss("dismiss", "runtime", terminal.notificationId, 11)
        assertTrue(creation is LedgerCreation.Created)
        assertEquals(listOf(fallback), dismissing.chatNoticeProjection("runtime", "session", now = 11)?.items)
    }
}
