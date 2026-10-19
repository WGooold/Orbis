package dev.pi.remote

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.*
import org.junit.Test

class AgentProvidersTest {
    private val waiting = RemoteState(hostId = "host-a", agentProviders = AgentProvidersState(kind = "codex", hostId = "host-a", requestId = "r", loading = true))
    private val response = Json.parseToJsonElement("""{"requestId":"r","kind":"codex","providers":[{"id":"a","kind":"codex","name":"Custom","enabled":true,"mode":"exclusive"}],"notice":"Changed"}""").jsonObject
    @Test fun onlyMatchingHostRequestCanReplaceProviderState() {
        val result = waiting.withProviderResult(response)
        assertFalse(result.agentProviders.loading)
        assertTrue(result.agentProviders.providers.isEmpty()) // A device receipt cannot replace shared provider facts.
        assertEquals("Changed", result.agentProviders.notice)
        val mirrored = result.withModelFixture("providers", """{"providers":[{"agentKind":"codex","current":"a",
            "profiles":[{"id":"a","name":"Custom","enabled":true,"mode":"exclusive","globalDefault":false}]}]}""", scope = "host")
        assertEquals("a", mirrored.agentProviders.providers.single().id)
        val otherHost = waiting.copy(hostId = "host-b")
        assertEquals(otherHost, otherHost.withProviderResult(response))
        val otherRequest = waiting.copy(agentProviders = waiting.agentProviders.copy(requestId = "new"))
        assertEquals(otherRequest, otherRequest.withProviderResult(response))
    }
    @Test fun failurePreservesConfirmedProviderState() {
        val current = waiting.copy(agentProviders = waiting.agentProviders.copy(providers = listOf(AgentProvider("old", "codex", "Old", true, false))))
        val result = current.withProviderResult(Json.parseToJsonElement("""{"requestId":"r","kind":"codex","error":"busy"}""").jsonObject)
        assertEquals("old", result.agentProviders.providers.single().id)
        assertEquals("busy", result.agentProviders.error)
        assertFalse(result.agentProviders.loading)
    }
}
