// Orbis 测试用途（场景与判定见本文件断言）：
// - OPT-05 `respond`（V07、V22）（V07、V22）
package com.orbising.orbis

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * ADR-0049 §6.5 `respond`：回答审批 / 问卷经操作账本结算。iOS `RespondLedgerTests.swift` 与本文件用例一一对应。
 * 交互清单经真实的 interactions 领域投影（applyAgentDomainProjection）进入账本。
 */
class RespondLedgerTest {
    private val reducer = RelayReducer()
    private val json = Json { ignoreUnknownKeys = true }
    private var counter = 0

    private fun ready(state: RemoteState): RemoteState = reducer.reduce(state,
        """{"type":"device.ready","deviceId":"phone-1","modelEpoch":"epoch",
            "runtimes":[{"runtimeId":"a","name":"Agent","cwd":"/repo","status":"running","sessionId":"session-a"}]}""", channel = "ctl")

    private fun request(id: String, kind: String = "confirm", secret: Boolean = false, submitted: Boolean = false) = PendingInteraction(
        requestId = id, extensionId = "test", kind = kind, title = "允许操作？", description = null,
        options = if (kind == "select" || kind == "multi-select") listOf(InteractionOption("fast", "快速"), InteractionOption("safe", "稳妥")) else emptyList(),
        placeholder = null, secret = secret, submitted = submitted)

    /** Host 的 interactions 领域（完整清单）。 */
    private fun interactions(state: RemoteState, vararg requests: PendingInteraction): RemoteState {
        val byId = requests.associateBy { it.requestId }
        val value = JsonObject(byId.mapValues { (id, _) -> JsonObject(mapOf("requestId" to JsonPrimitive(id))) })
        val domain = AgentStateDomainView("interactions", "epoch", (++counter).toLong(), "ready", "complete", 0, value)
        return state.applyAgentDomainProjection("a", "session-a", mapOf("interactions" to domain), json) { _, row, _ ->
            byId[row["requestId"]?.jsonPrimitive?.contentOrNull]
        }
    }

    private fun setup(vararg requests: PendingInteraction = arrayOf(request("approval"), request("pick", "select"))): RemoteState =
        interactions(ready(RemoteState(hostId = "host-1", e2eReady = true, connection = RelayConnection.ONLINE)), *requests)

    /** 与 HostConnection.respond 相同：先记入账本，写入通道后登记。 */
    private fun respond(state: RemoteState, requestId: String, summary: String): Pair<RemoteState, String> {
        val commandId = "respond-${++counter}"
        val (created, creation) = state.createRespond(commandId, "a", requestId, summary, System.currentTimeMillis())
        assertTrue(creation is LedgerCreation.Created)
        return created.ledgerWritten(commandId, System.currentTimeMillis()) to commandId
    }

    private fun result(state: RemoteState, id: String, ok: Boolean, error: String? = null): RemoteState = reducer.reduce(state,
        """{"type":"runtime.event","runtimeId":"a","sequence":${++counter},"event":{"type":"command.result","commandId":"$id","ok":$ok
            ${error?.let { ""","error":"$it"""" } ?: ""}}}""", channel = "ctl")

    private fun read(state: RemoteState): Pair<RemoteState, String> {
        assertTrue(state.ledgerVerifyWanted && state.ledgerConnectionOpen && state.e2eReady)
        val id = OperationKinds.VERIFY_REQUEST_PREFIX + (++counter)
        return state.beginLedgerRead(id) to id
    }

    private fun answer(state: RemoteState, requestId: String): RemoteState = reducer.reduce(state,
        """{"type":"agent.state.snapshot","requestId":"$requestId","scope":"device","modelEpoch":"epoch","domains":[],
            "missing":[{"domain":"operations","reason":"no_state"}],"truncated":false}""", channel = "ctl")

    private fun visible(state: RemoteState): List<String> {
        val hidden = OperationKinds.respondingRequestIds(state.ledger, "a")
        return state.conversations["a"]?.interactions?.keys.orEmpty().filterNot { it in hidden }
    }

    private fun status(state: RemoteState) = state.interactionStatus("a")
    private fun reconnect(state: RemoteState) = ready(state.markReconnecting()).copy(e2eReady = true).ledgerOpenConnection()

    @Test fun answeringCollapsesAtOnceAndShowsTheSummaryUntilTheRequestLeaves() {
        val start = setup()
        var (state, id) = respond(start, "approval", OperationKinds.confirmSummary(start.conversations.getValue("a").interactions.getValue("approval"), true))
        assertEquals(listOf("pick"), visible(state))
        assertEquals("已允许" to true, status(state)?.let { it.first to it.second })
        state = result(state, id, ok = true)
        // 成功回执后请求仍在清单里：面板不闪回。
        assertEquals(listOf("pick"), visible(state))
        state = interactions(state, request("pick", "select"))
        assertTrue(state.ledger.operations.isEmpty())
        assertEquals("已允许" to false, status(state)?.let { it.first to it.second })
    }

    @Test fun settledFeedbackExpiresWithoutAnOpenChatAndCannotReplayOnReentry() {
        val (sent, id) = respond(setup(), "approval", "已提交")
        val settled = interactions(result(sent, id, ok = true), request("pick", "select"))
        val deadline = settled.interactionOutcomes.getValue("a").expiresAt
        assertEquals(deadline, settled.nextOperationDeadline)
        assertEquals("已提交", settled.interactionStatus("a", deadline - 1)?.first)
        // Even before the scheduler runs after a background pause, a new page must not show expired feedback.
        assertNull(settled.interactionStatus("a", deadline))
        val expired = settled.ledgerTick(deadline)
        assertTrue(expired.interactionOutcomes.isEmpty())
        assertNull(expired.nextOperationDeadline)
        assertNull(status(expired.copy(selectedRuntimeId = "a")))
    }

    @Test fun leavingConsumesOnlyTheCompletedFeedbackAndKeepsPendingAnswers() {
        val (sent, id) = respond(setup(), "approval", "已提交")
        val settled = interactions(result(sent, id, ok = true), request("pick", "select"))
        val other = InteractionOutcome("other", "已选择", Long.MAX_VALUE)
        val left = settled.copy(interactionOutcomes = settled.interactionOutcomes + ("b" to other)).clearInteractionOutcome("a")
        assertNull(status(left.copy(selectedRuntimeId = "a")))
        assertEquals(other, left.interactionOutcomes["b"])
        assertEquals("已提交", status(sent.clearInteractionOutcome("a"))?.first)
        assertTrue(sent.clearInteractionOutcome("a").ledger.operations.isNotEmpty())
    }

    @Test fun anOldDeadlineCannotClearANewerAnswerAndNewSubmissionsConsumeOldFeedback() {
        val old = InteractionOutcome("first", "已提交", 10_000)
        val newer = InteractionOutcome("second", "已选择", 12_000)
        val state = setup().copy(interactionOutcomes = mapOf("a" to newer, "b" to old))
        val ticked = state.ledgerTick(10_000)
        assertEquals(newer, ticked.interactionOutcomes["a"])
        assertNull(ticked.interactionOutcomes["b"])
        val (sent, id) = respond(ticked, "approval", "已允许")
        assertTrue(sent.interactionOutcomes.isEmpty())
        assertNull(status(result(sent, id, ok = false, error = "拒绝")))
    }

    @Test fun disconnectClearsSettledFeedback() {
        val state = setup().copy(ledgerConnectionOpen = true,
            interactionOutcomes = mapOf("a" to InteractionOutcome("done", "已提交")))
        assertTrue(state.ledgerCloseConnection().interactionOutcomes.isEmpty())
    }

    @Test fun freeTextAndSecretsOnlySaySubmitted() {
        assertEquals("已提交", OperationKinds.valueSummary(request("pick", "select", secret = true), "fast"))
        assertEquals("已提交", OperationKinds.valueSummary(request("text", "input"), "秘密"))
        assertEquals("已选择：稳妥", OperationKinds.valueSummary(request("pick", "select"), "safe"))
        assertEquals("已选择：快速、稳妥", OperationKinds.valuesSummary(request("pick", "multi-select"), listOf("fast", "safe")))
    }

    @Test fun anExplicitFailureBringsThePanelBackWithItsReason() {
        val (responding, id) = respond(setup(), "approval", "已拒绝")
        val state = result(responding, id, ok = false, error = "校验失败")
        assertEquals(listOf("approval", "pick"), visible(state))
        assertNull(status(state))
        assertEquals("回答未提交：校验失败", state.error)
    }

    @Test fun aRequestHandledElsewhereShowsTheFactNotOurAnswer() {
        val state = interactions(respond(setup(), "approval", "已允许").first, request("pick", "select"))
        assertTrue(state.ledger.operations.isEmpty())
        assertEquals("已处理", status(state)?.first)
    }

    @Test fun disconnectShowsUnconfirmed() {
        val state = respond(setup(), "approval", "已允许").first.markReconnecting()
        assertEquals("已允许，未确认", status(state)?.first)
        assertEquals(listOf("pick"), visible(state))
    }

    @Test fun reconnectStillPendingRestoresThePanelSilently() {
        var state = interactions(reconnect(respond(setup(), "approval", "已允许").first), request("approval"), request("pick", "select"))
        val (reading, id) = read(state)
        state = answer(reading, id)
        assertEquals(listOf("approval", "pick"), visible(state))
        assertTrue(state.ledger.operations.isEmpty())
        assertNull(state.error)
    }

    @Test fun reconnectWithTheRequestGoneShowsHandled() {
        val state = interactions(reconnect(respond(setup(), "approval", "已允许").first), request("pick", "select"))
        assertTrue(state.ledger.operations.isEmpty())
        assertEquals("已处理", status(state)?.first)
    }

    @Test fun aRequestCanOnlyBeAnsweredOnceAtATime() {
        val (state, _) = respond(setup(), "approval", "已允许")
        assertTrue(state.createRespond("again", "a", "approval", "已拒绝", System.currentTimeMillis()).second is LedgerCreation.Conflict)
    }

    @Test fun noReceiptWithinTheBudgetShowsUnconfirmedAndReads() {
        val state = respond(setup(), "approval", "已允许").first.ledgerTick(System.currentTimeMillis() + 61_000)
        assertEquals("已允许，未确认", status(state)?.first)
        assertTrue(state.ledgerVerifyWanted)
    }
}
