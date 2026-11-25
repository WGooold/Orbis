package com.orbising.orbis

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import org.junit.Assert.*
import org.junit.Test

class AgyIntegrationTest {
    // AGY-13: an advertised feature is not the handshake acknowledgement. A
    // released Host should not get a declaration it never advertised.
    @Test fun `requests AGY only when advertised and requires Host acknowledgement before launching`() {
        fun json(input: String) = Json.parseToJsonElement(input) as JsonObject
        val old = json("""{"hostFeatures":["device.features"],"dshDesktop":null}""")
        val offer = json("""{"hostFeatures":["device.features","agent.agy"],"dshDesktop":null}""")
        val ack = json("""{"hostFeatures":["device.features","agent.agy"],"deviceFeatures":["agent.agy"],"dshDesktop":null}""")
        assertFalse(AGY_FEATURE in deviceAgentFeatures(old))
        assertTrue(AGY_FEATURE in requestedAgentFeatures(offer))
        assertFalse(readyAdmitsAgy(offer))
        assertTrue(readyAdmitsAgy(ack))
        assertTrue(requestedAgentFeatures(ack).isEmpty())
        val base = RemoteState(e2eReady = true, sessionConfigurationSupported = true, launchableAgents = setOf(AGY_KIND))
        assertFalse(base.canLaunchAgy())
        assertTrue(base.copy(agyNegotiated = true).canLaunchAgy())
    }

    // AGY-13: an unnamed native runtime owns its own brand and generated close
    // capability. It must never fall back to a fake terminal slash command.
    @Test fun `uses the namespaced identity and native close capability`() {
        val runtime = RuntimeSummary(runtimeId = "agy:native", name = "Antigravity CLI", cwd = "/workspace", status = "idle", sessionId = "agy:native").withNamespacedAgentKind()
        val close = RuntimeSlashCommand(RUNTIME_CLOSE_CAPABILITY, source = "builtin", closeGeneration = "native-generation")
        assertEquals(AGY_KIND, runtime.agentKind)
        assertEquals(AgentBrand.Agy, knownAgentBrand(runtime.agentKind))
        assertEquals(close, runtime.remoteCloseCommand(listOf(close), negotiated = true))
        assertNull(runtime.remoteCloseCommand(listOf(close), negotiated = false))
        assertFalse(ownsComputerWindow(runtime.agentKind))
    }
}
