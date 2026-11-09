// Orbis 测试用途（场景与判定见本文件断言）：
// - OPT-07 `config`（V12、V05）（V12、V05）
package com.orbising.orbis

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * ADR-0049 §6.7 `config`：模型 / 思考级别条件乐观。iOS `ConfigLedgerTests.swift` 与本文件用例一一对应；
 * 模型经真实的 model 领域投影（applyAgentDomainProjection）进入账本。
 */
class ConfigLedgerTest {
    private val reducer = RelayReducer()
    private val json = Json { ignoreUnknownKeys = true }
    private var counter = 0

    private fun runtimeJson(model: String?) = """{"runtimeId":"a","name":"Agent","cwd":"/repo","status":"idle","sessionId":"session-a"""" +
        (model?.let { ""","model":{"provider":"openai","id":"$it","name":"$it"}""" } ?: "") + "}"

    private fun reduce(state: RemoteState, payload: String, channel: String? = "ctl") =
        reducer.reduce(state, payload, channel = channel)

    private fun ready(state: RemoteState) =
        reduce(state, """{"type":"device.ready","deviceId":"phone-1","modelEpoch":"epoch","runtimes":[${runtimeJson(null)}]}""")

    /** 模型只由已提交的 model 领域写入（metadata 不写业务字段）。 */
    private fun model(state: RemoteState, id: String): RemoteState {
        val value = JsonObject(mapOf("provider" to JsonPrimitive("openai"), "id" to JsonPrimitive(id), "name" to JsonPrimitive(id)))
        val domain = AgentStateDomainView("model", "epoch", (++counter).toLong(), "ready", "complete", 0, value)
        return state.applyAgentDomainProjection("a", "session-a", mapOf("model" to domain), json) { _, _, _ -> null }
    }

    private fun setup() = model(ready(RemoteState(hostId = "host-1", e2eReady = true, connection = RelayConnection.ONLINE)), "model-a")

    /** 与 HostConnection.submitConfig 相同。 */
    private fun choose(state: RemoteState, value: String, label: String): Pair<RemoteState, String> {
        val target = OperationKinds.configTarget("a", "model")
        if (state.ledger.active(target) != null) return state.copy(configSelections = state.configSelections + (target to (value to label))) to ""
        val id = "config-${++counter}"
        val (created, creation) = state.createConfig(id, "a", "model", value, label, System.currentTimeMillis())
        assertTrue(creation is LedgerCreation.Created)
        return created.ledgerWritten(id, System.currentTimeMillis()) to id
    }

    private fun result(state: RemoteState, id: String, ok: Boolean, error: String? = null) = reduce(state,
        """{"type":"runtime.event","runtimeId":"a","sequence":${++counter},"event":{"type":"command.result","commandId":"$id","ok":$ok
            ${error?.let { ""","error":"$it"""" } ?: ""}}}""")

    private fun waitingSend(state: RemoteState, text: String): RemoteState {
        val (next, creation) = state.createWaitingSend("send-${++counter}", "message-$counter", "a", "session-a", text, null,
            emptyList(), emptyList(), System.currentTimeMillis(), OperationKinds.activeConfigOps(state.ledger, "a"))
        assertTrue(creation is LedgerCreation.Created)
        return next
    }

    private fun status(state: RemoteState) = state.configStatus("a", "model")?.let { "${it.first} / ${it.second}" }

    @Test fun choosingShowsTheChoiceAtOnceAndLandsOnConfirmation() {
        var (state, id) = choose(setup(), "model-b", "快速模型")
        assertEquals("快速模型 / 切换中", status(state))
        state = result(state, id, ok = true)
        assertEquals("快速模型 / 切换中", status(state))
        state = model(state, "model-b")
        assertNull(status(state))
        assertTrue(state.ledger.operations.isEmpty())
    }

    @Test fun aNormalizedConfirmationShowsTheConfirmedValue() {
        val (chosen, id) = choose(setup(), "model-b", "快速模型")
        val state = model(result(chosen, id, ok = true), "model-b-2026")
        assertNull(status(state))
        assertEquals("model-b-2026", state.runtimes["a"]?.model?.id)
    }

    @Test fun aFailureReturnsToTheConfirmedValueAndFailsTheMessagesWaitingForIt() {
        val (chosen, id) = choose(setup(), "model-b", "快速模型")
        var state = waitingSend(chosen, "用新模型回答")
        assertEquals(PendingSendState.Waiting("等待模型切换"), state.pendingSends.values.single().state)
        state = result(state, id, ok = false, error = "未知模型")
        assertNull(status(state))
        assertEquals("模型切换未完成：未知模型", state.error)
        assertEquals(PendingSendState.Failed("模型切换未完成，消息未发送"), state.pendingSends.values.single().state)
        assertTrue(state.readySends().isEmpty())
    }

    @Test fun prerequisiteFailureDoesNotParseTheLanguageOfTheWaitingLabel() {
        val (chosen, id) = choose(setup(), "model-b", "Original model label")
        val waiting = waitingSend(chosen, "原文 {0} /repo/file.swift")
        val row = waiting.pendingSends.values.single()
        val state = result(waiting.copy(pendingSends = waiting.pendingSends +
            (row.messageId to row.copy(state = PendingSendState.Waiting("Waiting for model switch")))),
            id, ok = false, error = "Model unavailable")
        assertEquals(PendingSendState.Failed("模型切换未完成，消息未发送"), state.pendingSends.values.single().state)
        assertEquals("原文 {0} /repo/file.swift", state.pendingSends.values.single().text)
    }

    @Test fun messagesSentBeforeConfirmationWaitAndThenSubmit() {
        val (chosen, id) = choose(setup(), "model-b", "快速模型")
        var state = result(waitingSend(chosen, "用新模型回答"), id, ok = true)
        assertTrue(state.readySends().isEmpty())
        state = model(state, "model-b")
        assertEquals(1, state.readySends().size)
    }

    @Test fun consecutiveChoicesSubmitOnlyTheLatest() {
        val (first, id) = choose(setup(), "model-b", "快速模型")
        val (second, again) = choose(first, "model-c", "深度模型")
        assertEquals("", again)
        assertEquals("深度模型 / 切换中", status(second))
        val settled = model(result(second, id, ok = true), "model-b")
        // HostConnection.resubmitConfigSelections：前一次已结算，最新一次与确认值不同，需再提交。
        assertTrue(settled.ledger.active(OperationKinds.configTarget("a", "model")) == null)
        assertEquals("model-c" to "深度模型", settled.configSelections[OperationKinds.configTarget("a", "model")])
    }

    @Test fun disconnectShowsUnconfirmedAndAnUnchangedConfigFailsAfterReconnect() {
        var state = choose(setup(), "model-b", "快速模型").first.markReconnecting()
        assertEquals("快速模型 / 未确认", status(state))
        state = model(ready(state).copy(e2eReady = true).ledgerOpenConnection(), "model-a")
        val readId = OperationKinds.VERIFY_REQUEST_PREFIX + "1"
        state = reduce(state.beginLedgerRead(readId), """{"type":"agent.state.snapshot","requestId":"$readId","scope":"device","modelEpoch":"epoch",
            "domains":[],"missing":[{"domain":"operations","reason":"no_state"}],"truncated":false}""")
        assertNull(status(state))
        assertEquals("模型切换未完成：未生效", state.error)
    }

    @Test fun reconnectWithTheChoiceInEffectLands() {
        var state = choose(setup(), "model-b", "快速模型").first.markReconnecting()
        state = model(ready(state).copy(e2eReady = true).ledgerOpenConnection(), "model-b")
        assertNull(status(state))
        assertTrue(state.ledger.operations.isEmpty())
        assertNull(state.error)
    }
}
