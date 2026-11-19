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

    @Test fun `one native row retires all merged optimistic sends but never another same-text send`() {
        val native = Json.decodeFromString(ChatMessage.serializer(),
            """{"messageId":"native","role":"user","content":[{"type":"text","text":"same"}],"timestamp":1,"clientMessageId":"a","clientMessageIds":["a","b"]}""")
        val session = "kimi-code:fixture:session_inbox"
        val sends = listOf("a", "b", "c").associateWith { id -> PendingSend(id, id, session, "same", emptyList(), null, 0, null) }
        val runtime = RuntimeSummary(session, "Kimi Code", "/repo", "idle", session).withKimiIdentity()
        val state = RemoteState(runtimes = mapOf(session to runtime), pendingSends = sends,
            conversations = mapOf(session to RuntimeConversation(messages = listOf(native))))
        assertEquals(KIMI_CODE_KIND, runtime.agentKind)
        assertEquals(setOf("c"), state.reconcilePendingSends(10).first.pendingSends.keys)
    }
}
