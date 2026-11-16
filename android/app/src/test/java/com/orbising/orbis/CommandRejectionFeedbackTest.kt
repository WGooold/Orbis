package com.orbising.orbis

import org.junit.Assert.*
import org.junit.Test

/** SC96: a Host rejection must release command waiters even when the socket stays open. */
class CommandRejectionFeedbackTest {
    private val reducer = RelayReducer()
    private fun online() = RemoteState(
        hostId = "host", connection = RelayConnection.ONLINE, e2eReady = true,
        runtimes = mapOf("agent" to RuntimeSummary("agent", "Agent", "/repo", "idle", "session")),
        pendingCommands = mapOf("rejected" to "agent", "other" to "agent"),
    )

    @Test fun `admission rejection completes composer and history command waiters`() {
        for (code in listOf("host_busy", "message_id_conflict")) {
            val failed = reducer.reduce(online(), """{"type":"protocol.error","commandId":"rejected","code":"$code","message":"电脑端拒绝了本次操作"}""")
            assertEquals("Missing failure receipt for $code", false, failed.commandResults["rejected"]?.ok)
            assertEquals("failure", failed.commandResults["rejected"]?.status)
            assertFalse(failed.commandResults["rejected"]?.error.isNullOrBlank())
            assertEquals(mapOf("other" to "agent"), failed.pendingCommands)
            assertNull(failed.feedback.banner)
            assertTrue(failed.sessionOperationErrors.isEmpty())
            assertEquals(RelayConnection.ONLINE, failed.connection)
        }
    }

    @Test fun `version rejection completes its command while retaining the connection banner`() {
        val failed = reducer.reduce(online(), """{"type":"protocol.error","commandId":"rejected","code":"protocol_version_mismatch","message":"会话业务协议不能中途更换"}""")
        assertEquals(FeedbackCondition.VERSION, failed.feedback.banner?.condition)
        assertEquals(false, failed.commandResults["rejected"]?.ok)
        assertEquals(mapOf("other" to "agent"), failed.pendingCommands)
        assertEquals(RelayConnection.ONLINE, failed.connection)
    }

    @Test fun `version rejection settles its ledger operation without waiting for reconnect`() {
        val id = "close-agent"
        val (created, creation) = online().copy(pendingCommands = emptyMap()).createQuit(id, "agent", 1L)
        assertTrue(creation is LedgerCreation.Created)
        val pending = created.ledgerWritten(id, 2L)
        assertTrue("agent" in pending.closingRuntimeIds)
        val failed = reducer.reduce(pending, """{"type":"protocol.error","commandId":"$id","code":"protocol_version_mismatch","message":"会话业务协议不能中途更换"}""")
        assertEquals(FeedbackCondition.VERSION, failed.feedback.banner?.condition)
        assertFalse("agent" in failed.closingRuntimeIds)
        assertFalse(failed.sessionOperationErrors["agent"].isNullOrBlank())
        assertEquals(RelayConnection.ONLINE, failed.connection)
    }

    @Test fun `rejected prompt command marks its optimistic message failed`() {
        val row = PendingSend("message", "rejected", "session", "/skill", emptyList(), null, 1L, null, slashName = "skill")
        val failed = reducer.reduce(online().copy(pendingSends = mapOf(row.messageId to row)),
            """{"type":"protocol.error","commandId":"rejected","code":"host_busy","message":"电脑端繁忙，请稍后重试"}""")
        assertTrue(failed.pendingSends["message"]?.state is PendingSendState.Failed)
        assertEquals(false, failed.commandResults["rejected"]?.ok)
        assertNull(failed.feedback.banner)
    }

    // Host echoes requestId as well as commandId for a rejected business protocol version.
    @Test fun `version rejection releases its configuration request`() {
        val initial = online().copy(sessionConfiguration = SessionConfigurationState(requestId = "configuration"))
        val failed = reducer.reduce(initial, """{"type":"protocol.error","requestId":"configuration","code":"protocol_version_mismatch"}""")
        assertEquals(FeedbackCondition.VERSION, failed.feedback.banner?.condition)
        assertNull(failed.sessionConfiguration.requestId)
        assertFalse(failed.sessionConfiguration.error.isNullOrBlank())
        assertEquals(initial.pendingCommands, failed.pendingCommands)
    }

    @Test fun `version rejection settles only its launch request`() {
        val id = "launch-request"
        val target = mapOf("type" to "new", "agentKind" to "codex", "cwd" to "/repo")
        val (created, creation) = online().createLaunch(id, target, "New session", 1L)
        assertTrue(creation is LedgerCreation.Created)
        val pending = created.ledgerWritten(id, 2L)
        val failed = reducer.reduce(pending, """{"type":"protocol.error","requestId":"$id","code":"protocol_version_mismatch"}""")
        assertEquals(FeedbackCondition.VERSION, failed.feedback.banner?.condition)
        assertFalse(failed.launching?.failure.isNullOrBlank())
        assertEquals(pending.pendingCommands, failed.pendingCommands)
    }

    @Test fun `version rejection of a verification read cannot fail an unrelated close`() {
        val (created, _) = online().createQuit("close-agent", "agent", 1L)
        val pending = created.ledgerWritten("close-agent", 2L).beginLedgerRead("verify-request")
        val failed = reducer.reduce(pending, """{"type":"protocol.error","requestId":"verify-request","code":"protocol_version_mismatch"}""", channel = "ctl")
        assertEquals(FeedbackCondition.VERSION, failed.feedback.banner?.condition)
        assertEquals(pending.closingRuntimeIds, failed.closingRuntimeIds)
        assertEquals(pending.sessionOperationErrors, failed.sessionOperationErrors)
        assertEquals(pending.ledger.operations, failed.ledger.operations)
    }
}
