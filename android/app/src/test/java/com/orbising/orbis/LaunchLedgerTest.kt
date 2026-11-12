// Orbis 测试用途（场景与判定见本文件断言）：
// - OPT-08 `launch`（V12、V10）（V12、V10）
package com.orbising.orbis

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * ADR-0049 §6.8 `launch`：新建 / 恢复会话立即进入聊天页。iOS `LaunchLedgerTests.swift` 与本文件用例一一对应；
 * [HostConnection.activateTarget] 的登记与 updateState 里的 openAcknowledgedSession 在这里显式调用。
 */
class LaunchLedgerTest {
    private val reducer = RelayReducer()
    private var counter = 0

    private fun reduce(state: RemoteState, payload: String) = reducer.reduce(state, payload, channel = "ctl").openAcknowledgedSession()

    private fun setup(): RemoteState = reduce(RemoteState(hostId = "host-1", e2eReady = true, connection = RelayConnection.ONLINE,
        sessions = mapOf("s1" to SessionCatalogEntry(sessionId = "s1", name = "旧会话", cwd = "/repo/app", agentKind = "codex"))),
        """{"type":"device.ready","deviceId":"phone-1","modelEpoch":"epoch","runtimes":[]}""")

    /** 与 HostConnection.activateTarget 相同：登记请求、创建启动操作并立即进入启动页，写入后登记。 */
    private fun launch(state: RemoteState, target: Map<String, String>, title: String = "app"): Pair<RemoteState, String> {
        val requestId = "launch-${++counter}"
        val registered = state.copy(sessionActivateRequests = state.sessionActivateRequests + requestId,
            sessionActivateTargets = target["sessionId"]?.takeIf { target["type"] == "resume" }?.let { mapOf(requestId to it) } ?: emptyMap())
        val (created, creation) = registered.createLaunch(requestId, target, title, System.currentTimeMillis())
        assertTrue(creation is LedgerCreation.Created)
        return created.ledgerWritten(requestId, System.currentTimeMillis()) to requestId
    }

    private fun activated(state: RemoteState, requestId: String, sessionId: String) =
        reduce(state, """{"type":"session.activated","requestId":"$requestId","sessionId":"$sessionId","agentKind":"codex"}""")

    private fun online(state: RemoteState, sessionId: String) = reduce(state,
        """{"type":"runtime.online","runtime":{"runtimeId":"rt-$sessionId","sessionId":"$sessionId","name":"Agent","cwd":"/repo/app","status":"idle"}}""")

    private fun newSession(state: RemoteState) = launch(state, mapOf("type" to "new", "agentKind" to "codex", "cwd" to "/repo/app"))

    // LAUNCH-WAIT-01: legacy/resume launches have no configured journal; only
    // a matching uncertain or failed configured launch may expose abandonment.
    @Test fun abandonmentAvailabilityRequiresTheMatchingUnresolvedJournal() {
        val (state, id) = newSession(setup())
        val pending = state.launching!!
        assertFalse(pending.canAbandonConfiguredLaunch(id))
        for (unresolved in listOf(pending.copy(unconfirmed = true), pending.copy(failure = "launch failed"))) {
            assertFalse(unresolved.canAbandonConfiguredLaunch(null))
            assertFalse(unresolved.canAbandonConfiguredLaunch("different-launch"))
            assertTrue(unresolved.canAbandonConfiguredLaunch(id))
        }
        val resumed = launch(setup(), mapOf("type" to "resume", "sessionId" to "s1", "agentKind" to "codex")).first.launching!!
        assertFalse(resumed.copy(unconfirmed = true).canAbandonConfiguredLaunch(null))
    }

    // S51 / SC73: a runtime can be visible during native setup; only the matching
    // configured-ready result is allowed to bind and release waiting first messages.
    @Test fun configuredLaunchWaitsForNativeConfirmationAndRejectsStaleReceipts() {
        var (state, id) = newSession(setup())
        state = state.createWaitingSend("first-command", "first-message", state.selectedRuntimeId!!, state.launching!!.placeholder,
            "first sentence", null, emptyList(), emptyList(), 1000, listOf(state.ledger.operation(id)!!)).first
        state = online(state, "native-configured")
        state = reduce(state, """{"type":"session.launch.result","requestId":"$id","launchId":"other","phase":"ready","sessionId":"native-configured"}""")
        assertTrue(state.readySends().isEmpty())
        state = reduce(state, """{"type":"session.launch.result","requestId":"$id","launchId":"$id","phase":"configuring","sessionId":"native-configured"}""")
        assertTrue(state.readySends().isEmpty())
        assertNull(state.launching!!.sessionId)
        state = reduce(state, """{"type":"session.launch.result","requestId":"$id","launchId":"$id","phase":"ready","sessionId":"native-configured"}""")
        assertEquals("rt-native-configured", state.selectedRuntimeId)
        assertEquals(1, state.readySends().size)
        assertEquals("native-configured", state.pendingSends.getValue("first-message").sessionId)
    }

    // Leaving the failed page retains its ledger operation; admission deduplication must not hide it forever.
    @Test fun unresolvedConfiguredLaunchCanBeReopenedAfterLeavingItsPage() {
        var (state, id) = newSession(setup())
        state = reduce(state, """{"type":"session.launch.result","launchId":"$id","phase":"unknown"}""")
        val fields = state.launching!!.target
        state = state.stopFollowingLaunch().copy(selectedRuntimeId = null)
        assertNull(state.launching)
        val restored = state.restoreConfiguredLaunch(id, fields, 2000)
        assertEquals(id, restored.launchPage?.requestId)
        assertTrue(restored.launchPage!!.unconfirmed)
        assertEquals(state.ledger.operations.size, restored.ledger.operations.size)
    }

    // Unknown without sessionId still guards against duplicates. Only explicit abandonment releases it.
    @Test fun explicitAbandonmentRemovesOnlyTheMatchingUncertainLaunchAndWaitingMessage() {
        var (state, id) = newSession(setup())
        state = state.createWaitingSend("first-command", "first-message", state.selectedRuntimeId!!, state.launching!!.placeholder,
            "unsent draft", null, emptyList(), emptyList(), 1000, listOf(state.ledger.operation(id)!!)).first
        assertEquals(state, state.abandonConfiguredLaunchState(id, "first-message"))
        state = reduce(state, """{"type":"session.launch.result","launchId":"$id","phase":"unknown","error":"native consent pending"}""")
        assertEquals(state, state.abandonConfiguredLaunchState("stale-launch", "first-message"))
        val cleared = state.abandonConfiguredLaunchState(id, "first-message")
        assertNull(cleared.launching)
        assertNull(cleared.selectedRuntimeId)
        assertTrue(cleared.pendingSends.isEmpty())
        assertTrue(cleared.sessionActivateRequests.isEmpty())
        assertNull(cleared.ledger.operation(id))
        assertNull(cleared.ledger.operation("first-command"))
        assertTrue(cleared.ledger.hasCapacity(256))
        assertTrue(cleared.canCreateSessionOn("host-1"))
    }

    // R2: abandonment owns a launch placeholder, not the rest of the outbox. Missing
    // journal IDs or restored UI-only rows must not leak slots or delete unrelated sends.
    @Test fun abandonmentCleansPlaceholderSendsAndRestoredRowsWithoutTouchingOtherSessions() {
        var (state, id) = newSession(setup())
        val placeholder = state.launching!!.placeholder
        state = state.createWaitingSend("first-command", "first-message", placeholder, placeholder,
            "unsent draft", null, emptyList(), emptyList(), 1000, listOf(state.ledger.operation(id)!!)).first
        state = state.createWaitingSend("other-command", "other-message", "rt-s1", "s1",
            "unrelated", null, emptyList(), emptyList(), 1000).first
        val restored = state.pendingSends.getValue("first-message").copy(messageId = "restored-message", commandId = "restored-command")
        state = state.copy(pendingSends = state.pendingSends + (restored.messageId to restored))
        state = reduce(state, """{"type":"session.launch.result","launchId":"$id","phase":"failed","error":"login required"}""")
        val cleared = state.abandonConfiguredLaunchState(id, null)
        assertEquals(listOf(state.ledger.operation("other-command")), cleared.ledger.operations)
        assertEquals(mapOf("other-message" to state.pendingSends.getValue("other-message")), cleared.pendingSends)
        assertTrue(cleared.ledger.hasCapacity(255))
    }

    @Test fun resumeEntersTheChatAtOnceShowingStartingAndSwitchesWhenOnline() {
        var (state, id) = launch(setup(), mapOf("type" to "resume", "sessionId" to "s1", "agentKind" to "codex"), "旧会话")
        assertEquals("starting", state.launchPage?.status)
        assertEquals("s1", state.launchPage?.runtime()?.sessionId)
        state = online(activated(state, id, "s1"), "s1")
        assertEquals("rt-s1", state.selectedRuntimeId)
        assertNull(state.launching)
        assertTrue(state.ledger.operations.isEmpty())
    }

    @Test fun aNewSessionEntersAPlaceholderAndItsDraftMovesOnSuccess() {
        var (state, id) = newSession(setup())
        val placeholder = state.launchPage!!.runtime()
        assertTrue(placeholder.runtimeId.startsWith("launch:"))
        assertEquals("app", placeholder.name)
        state = online(activated(state, id, "new-1"), "new-1")
        assertEquals("rt-new-1", state.selectedRuntimeId)
        assertEquals(placeholder.runtimeId, state.launchDraftMove?.first?.runtimeId)
        assertEquals("rt-new-1", state.launchDraftMove?.second?.runtimeId)
    }

    @Test fun aMessageSentWhileStartingWaitsAndIsSubmittedWhenOnline() {
        var (state, id) = newSession(setup())
        val launch = state.launchPage!!
        val (waiting, _) = state.createWaitingSend("send-1", "message-1", launch.placeholder, launch.placeholder, "你好", null,
            emptyList(), emptyList(), System.currentTimeMillis(), listOfNotNull(state.ledger.operation(id)))
        state = waiting
        assertEquals(PendingSendState.Waiting("等待会话启动"), state.pendingSends.values.single().state)
        assertTrue(state.readySends().isEmpty())
        state = activated(state, id, "new-1")
        assertEquals("new-1", state.pendingSends.values.single().sessionId)
        state = online(state, "new-1")
        val ready = state.readySends().single().payload as LedgerPayload.Send
        assertEquals("new-1", state.launchSessions[ready.sessionId])
    }

    /** 真实 Host 先广播 Runtime 上线，再回复同一 requestId 的 session.activated；等待中的消息同样要在上线后写入（iOS 同名用例）。 */
    @Test fun aMessageSentWhileStartingIsSubmittedWhenTheRuntimeIsOnlineBeforeTheReply() {
        var (state, id) = newSession(setup())
        val launch = state.launchPage!!
        state = state.createWaitingSend("send-1", "message-1", launch.placeholder, launch.placeholder, "你好", null,
            emptyList(), emptyList(), System.currentTimeMillis(), listOfNotNull(state.ledger.operation(id))).first
        state = online(state, "new-1")
        assertTrue("the Runtime is not known to be this launch yet", state.readySends().isEmpty())
        state = activated(state, id, "new-1")
        assertEquals("new-1", state.pendingSends.values.single().sessionId)
        val ready = state.readySends().single().payload as LedgerPayload.Send
        assertEquals("new-1", state.launchSessions[ready.sessionId])
        assertEquals("rt-new-1", state.selectedRuntimeId)
    }

    @Test fun aFailureShowsInPlaceFailsWaitingMessagesAndCanRetry() {
        var (state, id) = newSession(setup())
        val launch = state.launchPage!!
        state = state.createWaitingSend("send-1", "message-1", launch.placeholder, launch.placeholder, "你好", null,
            emptyList(), emptyList(), System.currentTimeMillis(), listOfNotNull(state.ledger.operation(id))).first
        state = reduce(state, """{"type":"protocol.error","code":"agent_unsupported","message":"对应的 agent 后端未就绪","requestId":"$id"}""")
        assertEquals("对应的 agent 后端未就绪", state.launchPage?.failure)
        assertEquals("error", state.launchPage?.status)
        assertEquals(PendingSendState.Failed("会话启动未完成，消息未发送"), state.pendingSends.values.single().state)
        // 重试需要新的请求：旧请求已不再占用“正在创建”。
        assertTrue(id !in state.sessionActivateRequests)
    }

    @Test fun leavingTheLaunchPageDoesNotPullTheUserBack() {
        var (state, id) = newSession(setup())
        state = state.stopFollowingLaunch().copy(selectedRuntimeId = null)
        state = online(activated(state, id, "new-1"), "new-1")
        assertNull(state.selectedRuntimeId)
        assertTrue("rt-new-1" in state.runtimes)
        assertNull(state.launching)
    }

    @Test fun noResultWithinTheBudgetShowsLaunchUnconfirmed() {
        var state = newSession(setup()).first.ledgerTick(System.currentTimeMillis() + 61_000)
        assertTrue(state.ledgerVerifyWanted)
        val read = OperationKinds.VERIFY_REQUEST_PREFIX + "1"
        state = reduce(state.beginLedgerRead(read), """{"type":"agent.state.snapshot","requestId":"$read","scope":"device","modelEpoch":"epoch",
            "domains":[],"missing":[{"domain":"operations","reason":"no_state"}],"truncated":false}""")
        assertTrue(state.launchPage?.unconfirmed == true)
        assertEquals("launch_unconfirmed", state.launchPage?.status)
    }
}
