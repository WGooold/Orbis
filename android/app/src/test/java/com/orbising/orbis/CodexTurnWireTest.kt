package com.orbising.orbis

import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/** S52 / SC76: exercise the real native -> Host compact wire at the Android reducer boundary.
 * Fixture: codex-turn-wire-probe.mjs, isolated CLI/Desktop app-servers, already-running turns.
 * Covers independent ctl/msg arrival and unchanged reconnect confirmation, not a UI-only mock. */
class CodexTurnWireTest {
    private val reducer = RelayReducer()
    private val fixture = Json.parseToJsonElement(requireNotNull(javaClass.getResource("/codex-turn-wire.json")).readText()).jsonObject
    private fun JsonObject.text(key: String) = getValue(key).jsonPrimitive.content
    private fun frames(variant: JsonObject, stage: String) = variant.getValue(stage).jsonArray.map { it.jsonObject }
    private fun initial(frame: JsonObject): RemoteState {
        val id = frame.text("runtimeId")
        return RemoteState(hostId = "probe-host", agentModelEpoch = frame.text("modelEpoch"), e2eReady = true,
            connection = RelayConnection.ONLINE, homeDirectoryReceived = true,
            runtimes = mapOf(id to RuntimeSummary(id, "Codex", "/probe", "unknown", frame.text("sessionId"), agentKind = frame.text("agentKind"))))
    }
    private fun subscribe(state: RemoteState, frame: JsonObject): RemoteState {
        val requestId = frame.text("requestId")
        return state.copy(agentStateRequests = state.agentStateRequests + requestId,
            agentStateReads = state.agentStateReads + (requestId to AgentStateRead(
                "agent|${frame.text("agentKind")}|${frame.text("sessionId")}", "agent", setOf("execution", "model"),
                frame.text("runtimeId"), frame.text("sessionId"), frame.text("agentKind"), stateFormat = "compact-v2")))
    }
    private fun receive(state: RemoteState, frame: JsonObject): RemoteState {
        val execution = frame["domains"]?.jsonArray?.firstOrNull()?.jsonObject?.get("domain")?.jsonPrimitive?.content == "execution"
        return reducer.reduce(state, frame.toString(), channel = if (execution) "ctl" else "msg")
    }

    @Test fun nativeRunningTurnsResolveInEitherFrameOrderAndKeepCurrentAfterChanges() {
        for ((_, raw) in fixture) for (reverse in listOf(false, true)) {
            val variant = raw.jsonObject
            val before = frames(variant, "before").let { if (reverse) it.reversed() else it }
            val id = before.first().text("runtimeId")
            var state = subscribe(initial(before.first()), before.first())
            state = receive(state, before.first())
            assertEquals("模型未确认", state.sessionModelPresentation(id).model)
            state = receive(state, before.last())
            assertEquals("GPT-5.5", state.sessionModelPresentation(id).model)
            assertEquals("low", state.sessionModelPresentation(id).thinking)
            assertNull(state.sessionModelPresentation(id).indicator)
            val changed = frames(variant, "changed")
            state = subscribe(state, changed.first())
            changed.forEach { state = receive(state, it) }
            assertEquals("GPT-5.5", state.sessionModelPresentation(id).model)
            assertEquals("low", state.sessionModelPresentation(id).thinking)
            assertEquals("下轮已设", state.sessionModelPresentation(id).indicator)
        }
    }

    @Test fun reconnectWaitsForBothConfirmedDomainsIncludingUnchangedReplies() {
        for ((_, raw) in fixture) for (reverse in listOf(false, true)) {
            val before = frames(raw.jsonObject, "before")
            val id = before.first().text("runtimeId")
            var state = subscribe(initial(before.first()), before.first()).ledgerOpenConnection()
            before.forEach { state = receive(state, it) }
            assertEquals("GPT-5.5", state.sessionModelPresentation(id).model)
            state = state.ledgerCloseConnection().ledgerOpenConnection()
            assertEquals("模型未确认", state.sessionModelPresentation(id).model)
            val replies = before.map { frame -> JsonObject(frame + mapOf(
                "requestId" to JsonPrimitive("reconnect"), "domains" to JsonArray(emptyList()),
                "unchanged" to JsonArray(frame.getValue("domains").jsonArray.map { it.jsonObject.getValue("domain") })))
            }.let { if (reverse) it.reversed() else it }
            state = subscribe(state, replies.first())
            state = receive(state, replies.first())
            assertEquals("模型未确认", state.sessionModelPresentation(id).model)
            state = receive(state, replies.last())
            assertEquals("GPT-5.5", state.sessionModelPresentation(id).model)
            assertEquals("low", state.sessionModelPresentation(id).thinking)
            assertNull(state.sessionModelPresentation(id).indicator)
        }
    }
}
