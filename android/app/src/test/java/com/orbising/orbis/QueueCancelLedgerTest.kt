package com.orbising.orbis

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * ADR-0049 §6.3 `queueCancel`：撤回排队消息经操作账本结算。iOS `QueueCancelLedgerTests.swift` 与本文件用例一一对应。
 * Host 队列经真实的 delivery 领域投影（applyAgentDomainProjection）进入账本。
 */
class QueueCancelLedgerTest {
    private val reducer = RelayReducer()
    private val json = Json { ignoreUnknownKeys = true }
    private var counter = 0

    private fun ready(state: RemoteState): RemoteState = reducer.reduce(state,
        """{"type":"device.ready","deviceId":"phone-1","modelEpoch":"epoch",
            "runtimes":[{"runtimeId":"a","name":"Agent","cwd":"/repo","status":"running","sessionId":"session-a"}]}""", channel = "ctl")

    /** Host 的 delivery 领域：queueId -> state。 */
    private fun queue(state: RemoteState, items: Map<String, String>, complete: Boolean = true): RemoteState {
        val value = JsonObject(items.mapValues { (id, value) -> JsonObject(mapOf("queueId" to JsonPrimitive(id), "text" to JsonPrimitive("text $id"),
            "delivery" to JsonPrimitive("followUp"), "state" to JsonPrimitive(value))) })
        val domain = AgentStateDomainView("delivery", "epoch", (++counter).toLong(), "ready", if (complete) "complete" else "partial", 0, value)
        return state.applyAgentDomainProjection("a", "session-a", mapOf("delivery" to domain), json) { _, _, _ -> null }
    }

    private fun setup(): RemoteState =
        queue(ready(RemoteState(hostId = "host-1", e2eReady = true, connection = RelayConnection.ONLINE)), mapOf("q1" to "accepted", "q2" to "accepted"))

    /** 与 HostConnection.cancelQueuedMessage 相同：先记入账本，写入通道后登记。 */
    private fun cancel(state: RemoteState, queueId: String): Pair<RemoteState, String> {
        val commandId = "cancel-${++counter}"
        val (created, creation) = state.createQueueCancel(commandId, "a", queueId, System.currentTimeMillis())
        assertTrue(creation is LedgerCreation.Created)
        return created.ledgerWritten(commandId, System.currentTimeMillis()) to commandId
    }

    private fun result(state: RemoteState, id: String, ok: Boolean, status: String, error: String? = null): RemoteState = reducer.reduce(state,
        """{"type":"runtime.event","runtimeId":"a","sequence":${++counter},"event":{"type":"command.result","commandId":"$id","ok":$ok,
            "status":"$status"${error?.let { ""","error":"$it"""" } ?: ""}}}""", channel = "ctl")

    private fun read(state: RemoteState): Pair<RemoteState, String> {
        assertTrue(state.ledgerVerifyWanted && state.ledgerConnectionOpen && state.e2eReady)
        val id = OperationKinds.VERIFY_REQUEST_PREFIX + (++counter)
        return state.beginLedgerRead(id) to id
    }

    private fun answer(state: RemoteState, requestId: String): RemoteState = reducer.reduce(state,
        """{"type":"agent.state.snapshot","requestId":"$requestId","scope":"device","modelEpoch":"epoch","domains":[],
            "missing":[{"domain":"operations","reason":"no_state"}],"truncated":false}""", channel = "ctl")

    private fun panel(state: RemoteState) = state.queuePanelItems("a").map { it.queueId }
    private fun unconfirmed(state: RemoteState) = OperationKinds.unconfirmedQueueIds(state.ledger, "a")
    private fun reconnect(state: RemoteState) = ready(state.markReconnecting()).copy(e2eReady = true).ledgerOpenConnection()

    @Test fun withdrawLeavesAtOnceAndLandsOnTheCancelledResult() {
        var (state, id) = cancel(setup(), "q1")
        assertEquals(listOf("q2"), panel(state))
        state = result(state, id, ok = true, status = "cancelled")
        // 成功回执后仍等 Host 队列体现结果，队列项不闪回。
        assertEquals(listOf("q2"), panel(state))
        state = queue(state, mapOf("q2" to "accepted"))
        assertTrue(state.ledger.operations.isEmpty())
        assertEquals(listOf("q2"), panel(state))
        assertNull(state.error)
    }

    @Test fun aCancelledQueueItemLandsWithoutTheResult() {
        val state = queue(cancel(setup(), "q1").first, mapOf("q1" to "cancelled", "q2" to "accepted"))
        assertTrue(state.ledger.operations.isEmpty())
    }

    @Test fun alreadyDeliveredStaysOutOfTheQueueAndSaysSo() {
        val (cancelling, id) = cancel(setup(), "q1")
        val state = queue(result(cancelling, id, ok = false, status = "already_delivered", error = "消息已送达或不存在"),
            mapOf("q2" to "accepted"))
        assertEquals(listOf("q2"), panel(state))
        assertEquals("撤回未完成：消息已交给 Agent", state.error)
    }

    @Test fun aDeliveredQueueItemSettlesAsAlreadyDelivered() {
        val state = queue(cancel(setup(), "q1").first, mapOf("q1" to "delivered", "q2" to "accepted"))
        assertTrue(state.ledger.operations.isEmpty())
        assertEquals(listOf("q2"), panel(state))
        assertEquals("撤回未完成：消息已交给 Agent", state.error)
    }

    @Test fun notCancelableReturnsTheItemWithItsReason() {
        val (cancelling, id) = cancel(setup(), "q1")
        val state = result(cancelling, id, ok = false, status = "not_cancelable", error = "DSH 不支持撤回排队消息；请使用停止")
        assertEquals(listOf("q1", "q2"), panel(state))
        assertEquals("撤回未完成：DSH 不支持撤回排队消息；请使用停止", state.error)
    }

    @Test fun disconnectBringsTheItemBackMarkedUnconfirmed() {
        val state = cancel(setup(), "q1").first.markReconnecting()
        assertEquals(listOf("q1", "q2"), panel(state))
        assertEquals(setOf("q1"), unconfirmed(state))
        assertNull(state.error)
    }

    @Test fun reconnectStillQueuedClearsTheMarkSilently() {
        var state = queue(reconnect(cancel(setup(), "q1").first), mapOf("q1" to "accepted", "q2" to "accepted"))
        val (reading, id) = read(state)
        state = answer(reading, id)
        assertTrue(unconfirmed(state).isEmpty())
        assertEquals(listOf("q1", "q2"), panel(state))
        assertTrue(state.ledger.operations.isEmpty())
        assertNull(state.error)
    }

    @Test fun reconnectWithTheItemCancelledLands() {
        val state = queue(reconnect(cancel(setup(), "q1").first), mapOf("q1" to "cancelled", "q2" to "accepted"))
        assertTrue(state.ledger.operations.isEmpty())
        assertNull(state.error)
    }

    @Test fun aSecondWithdrawOfTheSameItemIsBlocked() {
        val (state, _) = cancel(setup(), "q1")
        assertTrue(state.createQueueCancel("again", "a", "q1", System.currentTimeMillis()).second is LedgerCreation.Conflict)
    }

    @Test fun noReceiptWithinTheBudgetMarksItUnconfirmedAndReads() {
        val state = cancel(setup(), "q1").first.ledgerTick(System.currentTimeMillis() + 61_000)
        assertEquals(setOf("q1"), unconfirmed(state))
        assertTrue(state.ledgerVerifyWanted)
    }
}
