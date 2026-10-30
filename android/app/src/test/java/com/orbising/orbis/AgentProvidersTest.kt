package com.orbising.orbis

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.*
import org.junit.Test

class AgentProvidersTest {
    private val removable = listOf("a", "b").map { AgentProvider(it, "pi", it, true, true, it == "a") }
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

    @Test fun removalBatchOnlyAdvancesAfterMatchingReceiptAndKeepsAuthoritativeCards() {
        val state = RemoteState(hostId = "host-a", agentProviders = AgentProvidersState(kind = "pi", hostId = "host-a",
            requestId = "first", loading = true, providers = removable, pendingRemovals = removable, removalCount = 2))
        fun receipt(id: String, kind: String = "pi") = Json.parseToJsonElement("""{"requestId":"$id","kind":"$kind"}""").jsonObject
        assertEquals(state, state.withProviderResult(receipt("stale")))
        assertEquals(state, state.withProviderResult(receipt("first", "codex")))
        val next = state.withProviderResult(receipt("first"))
        assertTrue(next.agentProviders.loading)
        assertEquals(removable.takeLast(1), next.agentProviders.pendingRemovals)
        assertEquals(removable, next.agentProviders.providers)
        val projected = next.withModelFixture("providers", """{"providers":[{"agentKind":"pi","profiles":[]}]}""", scope = "host")
        assertTrue(projected.agentProviders.loading)
        val waiting = next.copy(agentProviders = next.agentProviders.copy(requestId = "second"))
        assertEquals(waiting, waiting.withProviderResult(receipt("first")))
        val done = waiting.withProviderResult(receipt("second"))
        assertFalse(done.agentProviders.loading)
        assertTrue(done.agentProviders.pendingRemovals.isEmpty())
        assertEquals("已移除 2 个供应商。", done.agentProviders.notice)
        assertEquals(removable, done.agentProviders.providers)
    }

    @Test fun removalRejectsStaleHostDisabledExclusiveAndDuplicateSelectionsAndStopsOnFailure() {
        val catalog = AgentProvidersState(kind = "pi", hostId = "host-a", providers = removable)
        assertTrue(catalog.canRemove(removable, "host-a"))
        assertFalse(catalog.canRemove(removable, "host-b"))
        assertFalse(catalog.canRemove(emptyList(), "host-a"))
        assertFalse(catalog.canRemove(listOf(removable[0], removable[0]), "host-a"))
        assertFalse(catalog.canRemove(listOf(removable[0].copy(enabled = false)), "host-a"))
        assertFalse(catalog.canRemove(listOf(removable[0].copy(additive = false)), "host-a"))
        val waiting = RemoteState(hostId = "host-a", agentProviders = catalog.copy(
            requestId = "r", loading = true, pendingRemovals = removable, removalCount = 2))
        val failed = waiting.withProviderResult(Json.parseToJsonElement("""{"requestId":"r","kind":"pi","error":"busy"}""").jsonObject)
        assertFalse(failed.agentProviders.loading)
        assertTrue(failed.agentProviders.pendingRemovals.isEmpty())
        assertEquals("批量移除已停止：busy", failed.agentProviders.error)
        assertEquals(removable, failed.agentProviders.providers)
    }
}
