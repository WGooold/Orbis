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
        val pending = created.ledgerWritten(id, 2L).copy(
            sessionActivateRequests = setOf(id, "other-launch"),
            sessionActivateTargets = mapOf(id to "session", "other-launch" to "other-session"),
        )
        val failed = reducer.reduce(pending, """{"type":"protocol.error","requestId":"$id","code":"protocol_version_mismatch"}""")
        assertEquals(FeedbackCondition.VERSION, failed.feedback.banner?.condition)
        assertFalse(failed.launching?.failure.isNullOrBlank())
        assertEquals(pending.pendingCommands, failed.pendingCommands)
        assertEquals(setOf("other-launch"), failed.sessionActivateRequests)
        assertEquals(mapOf("other-launch" to "other-session"), failed.sessionActivateTargets)
    }

    // SC105: a ledger launch reports an ordinary rejection on its launch page, not again as a session-list error.
    @Test fun `ordinary rejection of a ledger launch is shown once on its launch page`() {
        val id = "launch-request"
        val (created, _) = online().createLaunch(id, mapOf("type" to "new", "agentKind" to "codex", "cwd" to "/repo"), "New session", 1L)
        val pending = created.ledgerWritten(id, 2L).copy(sessionActivateRequests = setOf(id), sessionActivateTargets = mapOf(id to "session"))
        val failed = reducer.reduce(pending, """{"type":"protocol.error","requestId":"$id","code":"host_busy","message":"电脑端正忙"}""")
        assertFalse(failed.launching?.failure.isNullOrBlank())
        assertTrue(failed.sessionActivateRequests.isEmpty())
        assertNull(failed.sessionListError)
    }

    @Test fun `version rejection of a verification read cannot fail an unrelated close`() {
        val requestId = OperationKinds.VERIFY_REQUEST_PREFIX + "request"
        val (created, _) = online().createQuit("close-agent", "agent", 1L)
        val pending = created.ledgerWritten("close-agent", 2L).beginLedgerRead(requestId)
        val reply = """{"type":"protocol.error","requestId":"$requestId","commandId":"close-agent","code":"protocol_version_mismatch"}"""
        val failed = reducer.reduce(pending, reply, channel = "ctl")
        assertEquals(FeedbackCondition.VERSION, failed.feedback.banner?.condition)
        assertEquals(pending.closingRuntimeIds, failed.closingRuntimeIds)
        assertEquals(pending.sessionOperationErrors, failed.sessionOperationErrors)
        assertEquals(pending.ledger.operations, failed.ledger.operations)
        assertFalse("The rejected verification read must finish", requestId in failed.ledgerReads)
        val duplicate = reducer.reduce(failed, reply, channel = "ctl")
        assertEquals(failed.ledger.operations, duplicate.ledger.operations)
        assertEquals(failed.sessionOperationErrors, duplicate.sessionOperationErrors)
    }

    // SC99: every correlated read ends on admission rejection, while unrelated requests stay pending.
    @Test fun `connection and ordinary rejections release request owners consistently`() {
        for (code in listOf("protocol_version_mismatch", "unauthorized", "host_disabled", "host_busy")) {
            val initial = online().copy(
                sessionListRequests = setOf("list", "other"),
                sessionListRequestEpochs = mapOf("list" to 1L, "other" to 2L),
                sessionActivateRequests = setOf("activate", "other"),
                sessionActivateTargets = mapOf("activate" to "session", "other" to "other-session"),
                sessionBrowse = SessionBrowseState("browse"),
                agentStateRequests = setOf("home", "other"),
                agentStateReads = mapOf("home" to AgentStateRead("home-key", "agent", setOf("identity"))),
                agentProviders = AgentProvidersState(requestId = "provider", loading = true),
                sessionConfiguration = SessionConfigurationState(requestId = "configuration"),
            )
            for (requestId in listOf("list", "activate", "browse", "home", "provider", "configuration")) {
                val failed = reducer.reduce(initial,
                    """{"type":"protocol.error","requestId":"$requestId","code":"$code"}""", channel = "ctl")
                when (requestId) {
                    "list" -> {
                        assertEquals(code, setOf("other"), failed.sessionListRequests)
                        assertEquals(mapOf("other" to 2L), failed.sessionListRequestEpochs)
                        // SC105: a connection-level rejection is explained once, by its banner.
                        assertEquals(code, code == "host_busy", failed.sessionListError != null)
                    }
                    "activate" -> {
                        assertEquals(setOf("other"), failed.sessionActivateRequests)
                        assertEquals(mapOf("other" to "other-session"), failed.sessionActivateTargets)
                        assertEquals(code, code == "host_busy", failed.sessionListError != null)
                    }
                    "browse" -> {
                        assertEquals(false, failed.sessionBrowse?.isLoading)
                        assertFalse(failed.sessionBrowse?.error.isNullOrBlank())
                    }
                    "home" -> {
                        assertEquals(setOf("other"), failed.agentStateRequests)
                        assertFalse(failed.agentStateSnapshots["home-key"]?.error.isNullOrBlank())
                    }
                    "provider" -> {
                        assertNull(failed.agentProviders.requestId)
                        assertFalse(failed.agentProviders.loading)
                        assertFalse(failed.agentProviders.error.isNullOrBlank())
                    }
                    "configuration" -> {
                        assertNull(failed.sessionConfiguration.requestId)
                        assertFalse(failed.sessionConfiguration.error.isNullOrBlank())
                    }
                }
                assertTrue("other" in failed.sessionListRequests)
                assertTrue("other" in failed.sessionActivateRequests)
                assertTrue("other" in failed.agentStateRequests)
                assertEquals(initial.pendingCommands, failed.pendingCommands)
                assertEquals(RelayConnection.ONLINE, failed.connection)
                if (code == "host_busy") assertNull(failed.feedback.banner) else assertNotNull(failed.feedback.banner)
            }
        }
    }

    // SC99: both IDs must be considered even when each belongs to a different ledger operation.
    @Test fun `one rejection settles both correlated ledger operations`() {
        val (closing, _) = online().createQuit("close-agent", "agent", 1L)
        val target = mapOf("type" to "new", "agentKind" to "codex", "cwd" to "/repo")
        val (created, _) = closing.ledgerWritten("close-agent", 2L).createLaunch("launch-request", target, "New session", 3L)
        val failed = reducer.reduce(created.ledgerWritten("launch-request", 4L),
            """{"type":"protocol.error","commandId":"close-agent","requestId":"launch-request","code":"protocol_version_mismatch"}""")
        assertFalse("agent" in failed.closingRuntimeIds)
        assertFalse(failed.launching?.failure.isNullOrBlank())
    }

    // SC99: a message command and a launch request can share one rejection envelope.
    @Test fun `one rejection settles both the command and request ledger operation`() {
        for (code in listOf("protocol_version_mismatch", "host_busy")) {
            val target = mapOf("type" to "new", "agentKind" to "codex", "cwd" to "/repo")
            val (created, _) = online().createLaunch("launch-request", target, "New session", 1L)
            val row = PendingSend("message", "rejected", "session", "hello", emptyList(), null, 1L, null)
            val pending = created.ledgerWritten("launch-request", 2L).copy(pendingSends = mapOf(row.messageId to row))
            val failed = reducer.reduce(pending,
                """{"type":"protocol.error","commandId":"rejected","requestId":"launch-request","code":"$code"}""")
            assertFalse(failed.launching?.failure.isNullOrBlank())
            assertTrue(failed.pendingSends["message"]?.state is PendingSendState.Failed)
            assertEquals(false, failed.commandResults["rejected"]?.ok)
            assertEquals(mapOf("other" to "agent"), failed.pendingCommands)
        }
    }

    // SC99 / L5: a failed read still supplies its read boundary to fresh authoritative state.
    @Test fun `rejected verification read resolves an unknown close against the fresh runtime list`() {
        for (code in listOf("protocol_version_mismatch", "unauthorized", "host_disabled")) {
            val (created, _) = online().createQuit("close-agent", "agent", 1L)
            val disconnected = created.ledgerWritten("close-agent", 2L).markReconnecting()
            val ready = reducer.reduce(disconnected,
                """{"type":"device.ready","deviceId":"phone","modelEpoch":"epoch","runtimes":[{"runtimeId":"agent","name":"Agent","cwd":"/repo","status":"idle","sessionId":"session"}]}""",
                channel = "ctl").copy(e2eReady = true).ledgerOpenConnection()
            val pending = ready.beginLedgerRead("verify-request")
            assertEquals(LedgerPhase.Unknown, pending.ledger.operation("close-agent")?.phase)
            val failed = reducer.reduce(pending,
                """{"type":"protocol.error","requestId":"verify-request","code":"$code"}""", channel = "ctl")
            assertFalse("verify-request" in failed.ledgerReads)
            assertFalse("agent" in failed.closingRuntimeIds)
            assertNull(failed.ledger.operation("close-agent"))
            assertEquals(OperationKinds.quitUnconfirmed.reason, failed.sessionOperationErrors["agent"])
            assertNotNull(failed.feedback.banner)
        }
    }
}
