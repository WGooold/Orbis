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

    // OPENCLAW-DRAFT-FEEDBACK-01: correlated Host replies are not local timeouts, and legacy
    // or unchecked gateway details must not leak or masquerade as a diagnosed token failure.
    @Test fun configurationReplySurfacesOnlyKnownHostGuidance() {
        val state = RemoteState(sessionConfiguration = SessionConfigurationState("openclaw", "/repo", requestId = "active"))
        val safe = "缺少 OpenClaw Gateway 令牌。请在电脑的 Orbis Host → OpenClaw 填入 Gateway 令牌并应用。"
        fun reply(id: String, detail: String, channel: String? = "ctl", code: String = "configuration_unavailable") = reducer.reduce(state,
            """{"type":"protocol.error","requestId":"$id","code":"$code","message":"$detail"}""", channel = channel)
        assertEquals(state.sessionConfiguration, reply("old", safe).sessionConfiguration)
        assertEquals(state.sessionConfiguration, reply("active", safe, channel = null).sessionConfiguration)
        val failed = reply("active", safe)
        assertEquals(L10n.hostText(safe), failed.sessionConfiguration.error)
        assertNull(failed.sessionConfiguration.requestId)
        assertNull(failed.feedback.banner)
        assertFalse(failed.sessionConfiguration.admitConfiguredLaunch("openclaw", "/repo", journalLoaded = true).allowed)
        val fallback = L10n.tr("电脑端未能确认 OpenClaw 配置，请检查电脑端 Orbis 后重试")
        assertEquals(fallback, reply("active", "").sessionConfiguration.error)
        assertEquals(fallback, reply("active", "上游错误 token=fixture-secret").sessionConfiguration.error)
        assertEquals(fallback, reply("active", "$safe fixture-secret").sessionConfiguration.error)
        val disabled = reply("active", "内部信息 fixture-secret", code = "host_disabled")
        assertEquals(L10n.tr("这台电脑的连接已停用，请联系管理员"), disabled.sessionConfiguration.error)
        assertNotNull(disabled.feedback.banner)
    }

    // A false transport result, a deadline, and a successful retry belong to distinct request IDs.
    @Test fun configurationTransportFailureAndRetryRequireExactRequestAndDirectory() {
        val state = RemoteState(sessionConfiguration = SessionConfigurationState("openclaw", "/repo", requestId = "active"))
        val notSent = state.failConfigurationTransport("active", timedOut = false, legacyError = "legacy")
        assertEquals(L10n.tr("配置请求未发送，请检查连接后重试"), notSent.sessionConfiguration.error)
        assertNull(notSent.sessionConfiguration.requestId)
        val expired = state.failConfigurationTransport("active", timedOut = true, legacyError = "legacy")
        assertEquals(L10n.tr("未收到电脑回复，请检查连接后重试"), expired.sessionConfiguration.error)
        assertNull(expired.sessionConfiguration.requestId)
        val retry = expired.copy(sessionConfiguration = SessionConfigurationState("openclaw", "/repo", requestId = "retry"))
        assertSame(retry, retry.failConfigurationTransport("active", timedOut = true, legacyError = "legacy"))
        fun result(requestId: String, cwd: String) = reducer.reduce(retry,
            """{"type":"session.configuration.result","requestId":"$requestId","agentKind":"openclaw","cwd":"$cwd","binding":"gateway-defaults","revision":0,"values":{},"catalog":{"binding":"gateway-defaults"}}""", channel = "ctl")
        for (stateWithNoConfirmation in listOf(result("active", "/repo"), result("retry", "/other"))) {
            assertFalse(stateWithNoConfirmation.sessionConfiguration.admitConfiguredLaunch("openclaw", "/repo", journalLoaded = true).allowed)
            assertEquals("retry", stateWithNoConfirmation.sessionConfiguration.requestId)
        }
        val confirmed = result("retry", "/repo").sessionConfiguration
        assertTrue(confirmed.admitConfiguredLaunch("openclaw", "/repo", journalLoaded = true).allowed)
        assertFalse(confirmed.admitConfiguredLaunch("openclaw", "/repo", journalLoaded = false).allowed)
        assertNull(confirmed.error)
    }

    // OPENCLAW-DRAFT-DIAGNOSTIC-01: a not-ready row explains a configured source; it is not launch admission.
    @Test fun diagnosticNeedsCurrentAuthenticatedBackendsAndDoesNotGrantLaunchability() {
        val state = RemoteState(hostId = "host", e2eReady = true, connection = RelayConnection.ONLINE,
            agentModelEpoch = "e", sessionConfigurationSupported = true, openClawNegotiated = true,
            supportedAgents = setOf("codex"), launchableAgents = setOf("codex"),
            agentStateReads = mapOf("read" to AgentStateRead("host||", "host", setOf("backends"))))
        val action = "OpenClaw Gateway 令牌不匹配。请在电脑的 Orbis Host → OpenClaw 核对令牌并重新应用。"
        fun snapshot(rows: String, revision: Int = 1, availability: String = "ready") =
            """{"type":"agent.state.snapshot","requestId":"read","scope":"host","modelEpoch":"e","domains":[{"domain":"backends","modelEpoch":"e","revision":$revision,"availability":"$availability","completeness":"complete","checkedAt":$revision,"value":{"backends":[$rows],"launchableAgents":["codex"]}}],"missing":[],"truncated":false}"""
        fun row(reason: String, ready: String = "false") = """{"kind":"openclaw","ready":$ready,"reason":$reason}"""
        fun RemoteState.diagnostic() = openClawDraftDiagnostic(AppLanguage.English)
        val update = snapshot(row("\"$action\""))
        assertNull(state.diagnostic())
        assertNull(reducer.reduce(state, update, channel = null).diagnostic())
        val projected = reducer.reduce(state, update, channel = "ctl")
        assertEquals("The OpenClaw Gateway token does not match. Check the token in Orbis Host → OpenClaw on your computer and apply it again.", projected.diagnostic())
        assertEquals(setOf("codex"), projected.launchableAgents)
        assertFalse(projected.canLaunchOpenClaw())
        assertNull(projected.copy(openClawNegotiated = false).diagnostic())
        assertNull(projected.copy(launchableAgents = setOf("codex", "openclaw")).diagnostic())
        assertNull(projected.copy(agentEnablementRevision = 2, agentEnablementRows = listOf(AgentEnablementRow("openclaw", "OpenClaw", false))).diagnostic())
        assertNull(projected.markReconnecting().copy(e2eReady = true, connection = RelayConnection.ONLINE).diagnostic())
        assertNull(reducer.reduce(projected, """{"type":"host.offline"}""").diagnostic())
        val removed = reducer.reduce(projected, snapshot("", revision = 2), channel = "ctl")
        assertNull(removed.diagnostic())
        assertNull(reducer.reduce(removed, update, channel = "ctl").diagnostic())
        assertNull(reducer.reduce(projected, snapshot(row("\"$action\""), revision = 2, availability = "unavailable"), channel = "ctl").diagnostic())
        assertNull(reducer.reduce(projected, """{"type":"agent.state.snapshot","requestId":"read","scope":"host","modelEpoch":"e","domains":[],"missing":[{"domain":"backends","reason":"no_state"}],"truncated":false}""", channel = "ctl").diagnostic())
        assertNull(reducer.reduce(state, snapshot(row("\"$action\"", ready = "true")), channel = "ctl").diagnostic())
        assertNull(reducer.reduce(state, snapshot(row("\"$action\"", ready = "\"false\"")), channel = "ctl").diagnostic())
        assertEquals("OpenClaw is waiting for device approval. Approve Orbis Host in the OpenClaw device list, then reconnect Host.",
            reducer.reduce(state, snapshot(row("\"pairing_required\"")), channel = "ctl").diagnostic())
        for (reason in listOf("\"backend_not_ready\"", "\"starting\"", "\"$action\\nfixture-secret\"", "null")) {
            assertEquals("The selected assistant is not ready. Check it on your computer.", reducer.reduce(state, snapshot(row(reason)), channel = "ctl").diagnostic())
        }
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
