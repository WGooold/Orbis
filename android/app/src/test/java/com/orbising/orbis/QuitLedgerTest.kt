package com.orbising.orbis

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * ADR-0049 §7.5 `quit`：首页关闭经操作账本结算。iOS `QuitLedgerTests.swift` 与本文件用例一一对应；
 * [HostConnection] 的两步副作用（写入后登记、发起核对读取）在这里用同样的纯状态函数模拟。
 */
class QuitLedgerTest {
    private val reducer = RelayReducer()
    private var sequence = 0L
    private var opCounter = 0

    private fun ready(state: RemoteState, vararg ids: String): RemoteState {
        val runtimes = ids.joinToString(",") { """{"runtimeId":"$it","name":"Agent","cwd":"/repo","status":"idle","sessionId":"session-$it"}""" }
        val readied = reducer.reduce(state, """{"type":"device.ready","deviceId":"phone-1","modelEpoch":"epoch","runtimes":[$runtimes]}""", channel = "ctl")
        return ids.fold(readied) { current, id -> event(current, id,
            """{"type":"runtime.capabilities","capabilities":{"commands":[{"name":"quit","source":"builtin"}]}}""") }
    }

    private fun setup(vararg ids: String = arrayOf("a", "b")): RemoteState =
        ready(RemoteState(hostId = "host-1", e2eReady = true, connection = RelayConnection.ONLINE), *ids)

    private fun event(state: RemoteState, runtimeId: String, event: String): RemoteState {
        sequence += 1
        return reducer.reduce(state, """{"type":"runtime.event","runtimeId":"$runtimeId","sequence":$sequence,"event":$event}""", channel = "ctl")
    }

    /** 与 HostConnection.submitQuit 相同：先记入账本，写入通道后登记。 */
    private fun close(state: RemoteState, runtimeId: String): Pair<RemoteState, String> {
        val id = "quit-${++opCounter}"
        val (created, creation) = state.createQuit(id, runtimeId, System.currentTimeMillis())
        assertTrue(creation is LedgerCreation.Created)
        return created.ledgerWritten(id, System.currentTimeMillis()) to id
    }

    /** 与 HostConnection.updateState 的核对钩子相同：有需要且通道可用时登记一次读取。 */
    private fun verify(state: RemoteState): Pair<RemoteState, String> {
        assertTrue(state.ledgerVerifyWanted && state.ledgerConnectionOpen && state.e2eReady)
        val id = OperationKinds.VERIFY_REQUEST_PREFIX + (++opCounter)
        return state.beginLedgerRead(id) to id
    }

    private fun answer(state: RemoteState, requestId: String, receipts: Map<String, String>): RemoteState {
        val items = receipts.entries.joinToString(",") { (id, value) ->
            """"$id":{"operationId":"$id","runtimeId":"a","state":"$value","at":1}"""
        }
        return reducer.reduce(state, """
            {"type":"agent.state.snapshot","requestId":"$requestId","scope":"device","modelEpoch":"epoch",
             "domains":[{"domain":"operations","modelEpoch":"epoch","revision":1,"availability":"ready","completeness":"partial",
               "checkedAt":1,"value":{$items},
               "source":{"producer":"host","sourceId":"host:device-operations","sourceEpoch":"e","sourceRevision":1}}],
             "missing":[],"truncated":false}
        """.trimIndent(), channel = "ctl")
    }

    private fun disconnect(state: RemoteState) = state.markReconnecting()

    /** 新连接：device.ready 先于握手确认到达也可以（Android 的到达顺序），之后 e2eReady 翻转。 */
    private fun reconnect(state: RemoteState, vararg online: String): RemoteState =
        ready(state, *online).copy(e2eReady = true, connection = RelayConnection.ONLINE).ledgerOpenConnection()

    private fun result(state: RemoteState, id: String, ok: Boolean, error: String? = null) = event(state, "a",
        """{"type":"command.result","commandId":"$id","ok":$ok${error?.let { ""","error":"$it"""" } ?: ""}}""")

    @Test fun closeHidesAtOnceAndLandsWhenTheRuntimeGoesOffline() {
        var (state, id) = close(setup(), "a")
        assertEquals(setOf("a"), state.closingRuntimeIds)
        state = result(state, id, ok = true)
        assertEquals(setOf("a"), state.closingRuntimeIds)
        state = reducer.reduce(state, """{"type":"runtime.offline","runtimeId":"a"}""", channel = "ctl")
        assertTrue(state.closingRuntimeIds.isEmpty())
        assertTrue(state.ledger.operations.isEmpty())
        assertNull(state.error)
    }

    @Test fun explicitRejectionRestoresTheCardWithItsReason() {
        val (first, a) = close(setup(), "a")
        var (state, _) = close(first, "b")
        state = result(state, a, ok = false, error = "会话正忙")
        assertEquals(setOf("b"), state.closingRuntimeIds)
        assertEquals("关闭会话未完成：会话正忙", state.error)
    }

    @Test fun protocolErrorForTheCommandIsARejection() {
        var (state, id) = close(setup(), "a")
        state = reducer.reduce(state,
            """{"type":"protocol.error","code":"runtime_offline","message":"runtime a 当前没有在本机运行","commandId":"$id"}""", channel = "ctl")
        assertTrue(state.closingRuntimeIds.isEmpty())
        assertEquals("关闭会话未完成：runtime a 当前没有在本机运行", state.error)
    }

    @Test fun acceptedButStillOnlineAfterFifteenSecondsRestores() {
        var (state, id) = close(setup(), "a")
        state = result(state, id, ok = true)
        state = state.ledgerTick(System.currentTimeMillis() + 14_000)
        assertEquals(setOf("a"), state.closingRuntimeIds)
        state = state.ledgerTick(System.currentTimeMillis() + 16_000)
        assertTrue(state.closingRuntimeIds.isEmpty())
        assertEquals(OperationKinds.quitStillRunning.reason, state.error)
    }

    @Test fun disconnectKeepsTheCardHiddenWithoutAnError() {
        val state = disconnect(close(setup(), "a").first)
        assertEquals(setOf("a"), state.closingRuntimeIds)
        assertEquals(LedgerPhase.Unknown, state.ledger.operations.single().phase)
        assertNull(state.error)
        // host.offline 也是断线（L4）。
        val offline = reducer.reduce(close(setup(), "a").first, """{"type":"host.offline","hostId":"host-1"}""", channel = null)
        assertEquals(setOf("a"), offline.closingRuntimeIds)
        assertEquals(LedgerPhase.Unknown, offline.ledger.operations.single().phase)
    }

    @Test fun reconnectStillOnlineWithoutReceiptRestoresAsUnconfirmed() {
        var state = reconnect(disconnect(close(setup(), "a").first), "a", "b")
        // 只有完整在线列表还不够：设备私有回执读回之前不下结论（L5）。
        assertEquals(setOf("a"), state.closingRuntimeIds)
        val (reading, read) = verify(state)
        state = answer(reading, read, emptyMap())
        assertTrue(state.closingRuntimeIds.isEmpty())
        assertEquals(OperationKinds.quitUnconfirmed.reason, state.error)
    }

    @Test fun reconnectWithTheRuntimeGoneLandsSilently() {
        val state = reconnect(disconnect(close(setup(), "a").first), "b")
        assertTrue(state.closingRuntimeIds.isEmpty())
        assertTrue(state.ledger.operations.isEmpty())
        assertNull(state.error)
    }

    @Test fun reconnectReceiptOfSuccessStartsTheFifteenSecondRule() {
        val (closed, id) = close(setup(), "a")
        var state = reconnect(disconnect(closed), "a", "b")
        val (reading, read) = verify(state)
        state = answer(reading, read, mapOf(id to "success"))
        assertEquals(setOf("a"), state.closingRuntimeIds)
        state = state.ledgerTick(System.currentTimeMillis() + 16_000)
        assertTrue(state.closingRuntimeIds.isEmpty())
        assertEquals(OperationKinds.quitStillRunning.reason, state.error)
    }

    @Test fun lateReceiptOnTheNewConnectionStillSettles() {
        val (closed, id) = close(setup(), "a")
        var state = reconnect(disconnect(closed), "a", "b")
        state = result(state, id, ok = false, error = "不支持")
        assertTrue(state.closingRuntimeIds.isEmpty())
        assertEquals("关闭会话未完成：不支持", state.error)
    }

    @Test fun missingReceiptWithinTheBudgetVerifiesOnTheSameConnection() {
        var state = close(setup(), "a").first.ledgerTick(System.currentTimeMillis() + 61_000)
        assertEquals(setOf("a"), state.closingRuntimeIds)
        val (reading, read) = verify(state)
        state = answer(reading, read, emptyMap())
        assertTrue(state.closingRuntimeIds.isEmpty())
        assertEquals(OperationKinds.quitUnconfirmed.reason, state.error)
    }

    @Test fun failedVerifyReadStillVerifiesAgainstTheOnlineList() {
        val (reading, read) = verify(close(setup(), "a").first.ledgerTick(System.currentTimeMillis() + 61_000))
        val state = reducer.reduce(reading, """{"type":"protocol.error","code":"invalid_message","message":"bad","requestId":"$read"}""", channel = "ctl")
        assertTrue(state.closingRuntimeIds.isEmpty())
        assertEquals(OperationKinds.quitUnconfirmed.reason, state.error)
        assertTrue(state.e2eReady)
    }

    @Test fun aRepeatedCloseOfTheSameRuntimeIsNotSentTwice() {
        val (state, _) = close(setup(), "a")
        assertTrue(state.createQuit("again", "a", System.currentTimeMillis()).second is LedgerCreation.Conflict)
    }
}
