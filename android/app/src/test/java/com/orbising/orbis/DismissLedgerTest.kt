package com.orbising.orbis

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * ADR-0049 §6.6 `dismiss`：关闭通知经操作账本结算。iOS `DismissLedgerTests.swift` 与本文件用例一一对应；
 * [HostConnection.dismissNotification] 与读取钩子的两步副作用在这里用同样的纯状态函数模拟。
 */
class DismissLedgerTest {
    private val reducer = RelayReducer()
    private var revision = 0L
    private var counter = 0

    private fun ready(state: RemoteState, epoch: String = "host-epoch"): RemoteState = reducer.reduce(state,
        """{"type":"device.ready","deviceId":"phone-1","modelEpoch":"epoch","notificationEpoch":"$epoch",
            "runtimes":[{"runtimeId":"a","name":"Agent","cwd":"/repo","status":"idle","sessionId":"session-a"}]}""", channel = "ctl")

    private fun notices(state: RemoteState, ids: List<String>, complete: Boolean = true, removed: List<String> = emptyList(),
                        epoch: String = "host-epoch"): RemoteState {
        revision += 1
        val rows = ids.joinToString(",") {
            """{"notificationId":"$it","producerEpoch":"producer","code":"$it","occurrenceId":"occurrence","scope":{"turnId":"turn"},
                "severity":"warning","message":"$it","lifecycle":"condition","createdAt":1,"updatedAt":1,"verification":"confirmed"}"""
        }
        val gone = removed.joinToString(",") { "\"$it\"" }
        return reducer.reduce(state, """{"type":"notification.snapshot","protocolVersion":$PROTOCOL_VERSION,"hostEpoch":"$epoch",
            "runtimeId":"a","sessionId":"session-a","revision":$revision,"complete":$complete,"verification":"confirmed",
            "notifications":[$rows],"removedNotificationIds":[$gone]}""", channel = "ctl")
    }

    private fun setup(): RemoteState =
        notices(ready(RemoteState(hostId = "host-1", e2eReady = true, connection = RelayConnection.ONLINE)), listOf("retry", "sandbox"))

    /** 与 HostConnection.dismissNotification 相同：先记入账本，写入后登记并要求一次读取。 */
    private fun dismiss(state: RemoteState, id: String): RemoteState {
        val opId = "dismiss-${++counter}"
        val (created, creation) = state.createDismiss(opId, "a", id, System.currentTimeMillis())
        assertTrue(creation is LedgerCreation.Created)
        return created.dismissWritten(opId, System.currentTimeMillis())
    }

    /** 与 HostConnection.updateState 的读取钩子相同。 */
    private fun read(state: RemoteState): Pair<RemoteState, String> {
        assertTrue(state.ledgerVerifyWanted && state.ledgerConnectionOpen && state.e2eReady)
        val id = OperationKinds.VERIFY_REQUEST_PREFIX + (++counter)
        return state.beginLedgerRead(id) to id
    }

    private fun answer(state: RemoteState, requestId: String): RemoteState = reducer.reduce(state,
        """{"type":"agent.state.snapshot","requestId":"$requestId","scope":"device","modelEpoch":"epoch","domains":[],
            "missing":[{"domain":"operations","reason":"no_state"}],"truncated":false}""", channel = "ctl")

    private fun visible(state: RemoteState) = state.visibleNotificationProjection("a")?.items?.map { it.notificationId }.orEmpty()

    private fun reconnect(state: RemoteState, epoch: String = "host-epoch"): RemoteState =
        ready(state, epoch).copy(e2eReady = true, connection = RelayConnection.ONLINE).ledgerOpenConnection()

    @Test fun dismissHidesAtOnceAndLandsOnTheHostRemoval() {
        var state = dismiss(setup(), "retry")
        assertEquals(listOf("sandbox"), visible(state))
        state = notices(state, listOf("sandbox"), removed = listOf("retry"))
        assertTrue(state.ledger.operations.isEmpty())
        assertEquals(listOf("sandbox"), visible(state))
        assertNull(state.error)
    }

    @Test fun aStalePushStillListingItDoesNotBringItBack() {
        // 推送可能是 Host 处理关闭之前生成的，不能作为反向证据（L2）。
        val state = notices(dismiss(setup(), "retry"), listOf("retry", "sandbox"))
        assertEquals(listOf("sandbox"), visible(state))
        assertEquals(1, state.ledger.operations.size)
    }

    @Test fun theReadAfterTheDismissStillListingItShowsItAgainSilently() {
        val (reading, id) = read(dismiss(setup(), "retry"))
        val state = answer(notices(reading, listOf("retry", "sandbox")), id)
        assertEquals(listOf("retry", "sandbox"), visible(state))
        assertTrue(state.ledger.operations.isEmpty())
        assertNull(state.error)
    }

    @Test fun anIncompleteInventoryIsNotNegativeEvidence() {
        val (reading, id) = read(dismiss(setup(), "retry"))
        val state = answer(notices(reading, listOf("retry"), complete = false), id)
        assertEquals(listOf("sandbox"), visible(state))
        assertEquals(1, state.ledger.operations.size)
    }

    @Test fun disconnectKeepsItHiddenAndTheFirstNewInventoryDecides() {
        var state = dismiss(setup(), "retry").markReconnecting()
        assertEquals(listOf("sandbox"), visible(state))
        state = reconnect(state)
        // 旧连接留下的清单不能作证：读取回复先到也不下结论。
        val (reading, id) = read(state)
        state = answer(reading, id)
        assertEquals(listOf("sandbox"), visible(state))
        state = notices(state, listOf("retry", "sandbox"))
        assertEquals(listOf("retry", "sandbox"), visible(state))
        assertTrue(state.ledger.operations.isEmpty())
    }

    @Test fun reconnectWithTheNoticeGoneLands() {
        val state = notices(reconnect(dismiss(setup(), "retry").markReconnecting()), listOf("sandbox"))
        assertTrue(state.ledger.operations.isEmpty())
        assertEquals(listOf("sandbox"), visible(state))
    }

    @Test fun aNewHostEpochExpiresTheDismissal() {
        val state = reconnect(dismiss(setup(), "retry").markReconnecting(), epoch = "restarted")
        assertTrue(state.ledger.operations.isEmpty())
    }

    @Test fun noReceiptWithinTheBudgetReadsAndDecides() {
        val (consumed, _) = read(dismiss(setup(), "retry"))
        val expired = consumed.ledgerTick(System.currentTimeMillis() + 61_000)
        assertTrue(expired.ledgerVerifyWanted)
        assertEquals(listOf("sandbox"), visible(expired))
        val (reading, id) = read(expired)
        assertEquals(listOf("retry", "sandbox"), visible(answer(reading, id)))
    }
}
