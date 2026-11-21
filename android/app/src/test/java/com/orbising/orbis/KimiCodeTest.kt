package com.orbising.orbis

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import org.junit.Assert.*
import org.junit.Test

class KimiCodeTest {
    private fun ready(json: String) = Json.parseToJsonElement(json) as JsonObject

    @Test fun `KIMI-07 negotiates only on an advertised Host and preserves the old Desktop fallback`() {
        val legacy = ready("""{"hostFeatures":["device.features"],"dshDesktop":null}""")
        assertEquals(listOf("agent.dshDesktop"), deviceAgentFeatures(legacy))
        assertFalse(hasNegotiatedKimiCode(legacy))
        assertEquals(emptyList<String>(), deviceAgentFeatures(ready("""{"hostFeatures":["agent.kimiCode"]}""")))
        val filtered = ready("""{"hostFeatures":["device.features","agent.kimiCode"]}""")
        assertEquals(listOf("agent.dshDesktop", "agent.kimiCode"), deviceAgentFeatures(filtered))
        assertFalse(hasNegotiatedKimiCode(filtered))
        assertTrue(hasNegotiatedKimiCode(ready("""{"hostFeatures":["device.features","agent.kimiCode"],"dshDesktop":null}""")))
        assertEquals(
            listOf("agent.dshDesktop", "state.compact-bootstrap.v1", "claude.send-now.v1"),
            deviceAgentFeatures(ready("""{"hostFeatures":["device.features","state.compact-bootstrap.v1","claude.send-now.v1"]}""")),
        )
        assertEquals("headless", kimiSpawnMode("kimiCode", "tui"))
        assertEquals("tui", kimiSpawnMode("codex", "tui"))
    }

    @Test fun `Agent settings require an explicit capability echo even with Desktop admitted`() {
        val offer = ready("""{"hostFeatures":["device.features","agent.enablement.v1"],"dshDesktop":null}""")
        assertTrue(AGENT_ENABLEMENT_FEATURE in requestedAgentFeatures(offer))
        assertFalse(readyAdmitsAgentEnablement(offer))
        val admitted = ready("""{"hostFeatures":["device.features","agent.enablement.v1"],"deviceFeatures":["agent.enablement.v1"],"dshDesktop":null}""")
        assertTrue(readyAdmitsAgentEnablement(admitted))
        assertTrue(requestedAgentFeatures(admitted).isEmpty())
    }

    @Test fun `managed ready preserves an explicitly empty Agent directory without OpenClaw`() {
        val payload = """{"type":"device.ready","protocolVersion":19,"modelEpoch":"new","hostFeatures":["device.features","agent.enablement.v1"],"deviceFeatures":["agent.enablement.v1"],"runtimes":[],"agents":[],"launchableAgents":[]}"""
        val state = RelayReducer().reduce(RemoteState(supportedAgents = setOf("pi"), launchableAgents = setOf("pi")), payload, channel = "ctl")
        assertEquals(emptySet<String>(), state.supportedAgents)
        assertEquals(emptySet<String>(), state.launchableAgents)
    }

    @Test fun `managed source gate uses saved choice without changing legacy fallback`() {
        val legacy = RemoteState(sessionConfigurationSupported = true)
        assertTrue(legacy.supportsSessionConfiguration("codex"))
        val managed = legacy.copy(agentEnablementRevision = 1, agentEnablementRows = listOf(
            AgentEnablementRow("codex", "Codex CLI", false), AgentEnablementRow("codexDesktop", "Codex Desktop", true)))
        assertFalse(managed.supportsSessionConfiguration("codex"))
        assertTrue(managed.supportsSessionConfiguration("codexDesktop"))
    }

    @Test fun `OpenCode declares its feature only to a Host that advertises it`() {
        assertEquals(listOf("agent.dshDesktop", "agent.opencode"), deviceAgentFeatures(ready("""{"hostFeatures":["device.features","agent.opencode"]}""")))
        assertEquals(emptyList<String>(), deviceAgentFeatures(ready("""{"hostFeatures":["agent.opencode"]}""")))
    }

    @Test fun `one native row retires all merged optimistic sends but never another same-text send`() {
        val native = Json.decodeFromString(ChatMessage.serializer(),
            """{"messageId":"native","role":"user","content":[{"type":"text","text":"same"}],"timestamp":1,"clientMessageId":"a","clientMessageIds":["a","b"]}""")
        val session = "kimi-code:fixture:session_inbox"
        val sends = listOf("a", "b", "c").associateWith { id -> PendingSend(id, id, session, "same", emptyList(), null, 0, null, runtimeId = session) }
        val runtime = RuntimeSummary(session, "Kimi Code", "/repo", "idle", session).withKimiIdentity()
        val state = RemoteState(runtimes = mapOf(session to runtime), pendingSends = sends,
            conversations = mapOf(session to RuntimeConversation(messages = listOf(native))))
        assertEquals(KIMI_CODE_KIND, runtime.agentKind)
        assertEquals(setOf("c"), state.reconcilePendingSends(10).first.pendingSends.keys)
    }
}
