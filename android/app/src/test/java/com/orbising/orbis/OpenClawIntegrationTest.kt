package com.orbising.orbis

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.*
import org.junit.Test

class OpenClawIntegrationTest {
    private val reducer = RelayReducer()
    private fun ready(features: String, echo: String = "", runtime: String = "", desktop: String = "") =
        """{"type":"device.ready","protocolVersion":19,"deviceId":"phone","modelEpoch":"e","sessionConfiguration":1,
        "hostFeatures":$features,"runtimes":[$runtime]$echo$desktop}"""

    // OPENCLAW-03: independent of availability, authenticated echo owns OpenClaw admission;
    // a different visibility view cannot reuse an equal-revision catalog baseline.
    @Test fun negotiatedReadyDiscardsOnlyTheRetiredProjection() {
        val legacy = ready("""["device.features"]""")
        val filtered = ready("""["device.features","agent.openclaw"]""")
        val admitted = ready("""["device.features","agent.openclaw"]""", """, "deviceFeatures": ["agent.dshDesktop","agent.openclaw"], "agents": ["openclaw"], "launchableAgents": ["openclaw"]""",
            """{"runtimeId":"openclaw:r","sessionId":"openclaw:s","name":"OpenClaw","cwd":"/repo","status":"idle"}""", """, "dshDesktop":null""")
        fun requests(payload: String) = requestedAgentFeatures(Json.parseToJsonElement(payload).jsonObject)
        assertEquals(listOf("agent.dshDesktop"), requests(legacy))
        assertEquals(listOf("agent.dshDesktop", "agent.openclaw"), requests(filtered))
        assertEquals(emptyList<String>(), requests(admitted))
        val oldState = RemoteState(agentModelEpoch = "e", agentStateSnapshots = mapOf(
            "host||" to AgentStateSnapshotView("host||", "host", "read", "e")))
        assertFalse(reducer.reduce(oldState, admitted, channel = null).openClawNegotiated)
        val newState = reducer.reduce(oldState, admitted, channel = "ctl")
        assertTrue(newState.canLaunchOpenClaw())
        assertTrue(newState.agentStateSnapshots.isEmpty())
        assertEquals("openclaw", newState.runtimes["openclaw:r"]?.agentKind)
        val oldAgain = reducer.reduce(newState, legacy, channel = "ctl")
        assertFalse(oldAgain.canLaunchOpenClaw())
        assertTrue(oldAgain.supportsSessionConfiguration("codex"))
        assertFalse(oldAgain.supportsSessionConfiguration("openclaw"))
    }

    // Hold a first sentence under the common launch ledger until the exact ready result.
    @Test fun headlessLaunchUsesNativeDefaultsAndWaitsForReady() {
        val config = SessionConfigurationSnapshot("openclaw", "/repo", "gateway-defaults", 2,
            SessionConfigurationValues(), SessionConfigurationCatalog("gateway-defaults"))
        val payload = configuredLaunchPayload("launch", config, SessionConfigurationValues(model = "stale-codex-model"), "tui")
        assertEquals("session.launch", payload["type"]?.jsonPrimitive?.content)
        assertEquals("headless", payload["spawnMode"]?.jsonPrimitive?.content)
        assertNull(payload["values"]?.jsonObject?.get("model"))
        var state = RemoteState(hostId = "host", e2eReady = true, connection = RelayConnection.ONLINE,
            sessionActivateRequests = setOf("launch"), openClawNegotiated = true)
        state = state.createLaunch("launch", mapOf("type" to "new", "agentKind" to "openclaw", "cwd" to "/repo"), "new", 1).first
        state = state.createWaitingSend("first-command", "first-message", "launch:launch", "launch:launch", "hello", null,
            emptyList(), emptyList(), 2, listOf(state.ledger.operation("launch")!!)).first
        // The real caller marks the launch written after the durable journal and transport write.
        state = state.ledgerWritten("launch", 3)
        fun reduce(json: String) { state = reducer.reduce(state, json, channel = "ctl").openAcknowledgedSession() }
        reduce("""{"type":"runtime.online","runtime":{"runtimeId":"openclaw:r","sessionId":"openclaw:s","name":"OpenClaw","cwd":"/repo","status":"idle"}}""")
        reduce("""{"type":"session.launch.result","launchId":"launch","phase":"configuring","sessionId":"openclaw:s"}""")
        assertTrue(state.readySends().isEmpty())
        reduce("""{"type":"session.launch.result","launchId":"launch","phase":"ready","sessionId":"openclaw:s","spawnMode":"headless"}""")
        assertEquals("openclaw:r", state.selectedRuntimeId)
        assertEquals(1, state.readySends().size)
        assertEquals("openclaw:s", state.pendingSends["first-message"]?.sessionId)
    }
}
