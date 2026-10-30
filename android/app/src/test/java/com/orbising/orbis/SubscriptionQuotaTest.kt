package com.orbising.orbis

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.*
import org.junit.Test

class SubscriptionQuotaTest {
    private val quota = """{"checkedAt":123,"windows":[{"name":"five_hour","remainingPercent":85.5,"resetsAt":456},{"name":"seven_day","remainingPercent":null,"resetsAt":null}]}"""
    private val provider = AgentProvider("official", "claude", "Claude 官方订阅", true, false, subscriptionSupported = true)
    private val waiting = RemoteState(hostId = "host-a", agentProviders = AgentProvidersState(kind = "claude", hostId = "host-a",
        providers = listOf(provider), quotaRequestId = "query", quotaProviderId = "official"))
    private fun response(request: String = "query", kind: String = "claude", id: String = "official") = Json.parseToJsonElement(
        """{"type":"provider.subscription.result","requestId":"$request","kind":"$kind","id":"$id","quota":$quota}""").jsonObject

    @Test fun quotaRequiresMatchingHostRequestKindAndEnabledProvider() {
        for (reply in listOf(response(request = "old"), response(kind = "codex"), response(id = "other"))) assertEquals(waiting, waiting.withSubscriptionResult(reply))
        val anotherHost = waiting.copy(hostId = "host-b")
        assertEquals(anotherHost, anotherHost.withSubscriptionResult(response()))
        val switched = waiting.copy(agentProviders = waiting.agentProviders.copy(providers = listOf(provider.copy(enabled = false))))
        assertEquals(switched, switched.withSubscriptionResult(response()))
        val result = waiting.withSubscriptionResult(response())
        assertNull(result.agentProviders.quotaRequestId)
        assertNull(result.agentProviders.quotaError)
        assertEquals(85.5, result.agentProviders.quota!!.windows.first().remainingPercent!!, 0.0)
        assertNull(result.agentProviders.quota!!.windows.last().remainingPercent)
    }

    @Test fun malformedQuotaNeverBecomesZeroAndFailureCanBeRetried() {
        for (invalid in listOf(quota.replace("85.5", "101"), quota.replace("85.5", "-1"), quota.replace("seven_day", "five_hour"))) {
            assertNull(parseSubscriptionQuota(Json.parseToJsonElement(invalid).jsonObject))
        }
        val failed = waiting.withSubscriptionResult(Json.parseToJsonElement("""{"requestId":"query","kind":"claude","id":"official","error":"登录过期"}""").jsonObject)
        assertNull(failed.agentProviders.quotaRequestId)
        assertNull(failed.agentProviders.quota)
        assertEquals("登录过期", failed.agentProviders.quotaError)
        assertNull(failed.agentProviders.error)
    }

    @Test fun officialCapabilityComesFromHostFacts() {
        val projected = waiting.withModelFixture("providers", """{"providers":[{"agentKind":"claude","profiles":[{"id":"official","name":"Claude","enabled":true,"mode":"exclusive","globalDefault":false,"subscriptionSupported":true}]}]}""", scope = "host")
        assertTrue(projected.agentProviders.providers.single().subscriptionSupported)
    }
    @Test fun connectionCardQueryRegistersHostAndKeepsOtherAgentResults() {
        val codex = provider.copy(kind = "codex")
        val loaded = RemoteState(hostId = "host-a", providerCatalogs = mapOf("claude" to listOf(provider), "codex" to listOf(codex)))
        val first = loaded.beginSubscriptionQuery(provider, "query").withSubscriptionResult(response())
        assertEquals("host-a", first.agentProviders.hostId)
        assertEquals(85.5, first.subscriptionQuotas["claude"]!!.quota!!.windows.first().remainingPercent!!, 0.0)
        val second = first.beginSubscriptionQuery(codex, "codex-query")
            .withSubscriptionResult(response(request = "codex-query", kind = "codex"))
        assertEquals(setOf("claude", "codex"), second.subscriptionQuotas.keys)
        val refreshing = second.beginSubscriptionQuery(provider, "retry")
        assertNotNull(refreshing.subscriptionQuotas["claude"]!!.quota)
        val failed = refreshing.failSubscriptionQuery("retry", "超时")
        assertEquals("超时", failed.subscriptionQuotas["claude"]!!.error)
        assertNotNull(failed.subscriptionQuotas["claude"]!!.quota)
        assertEquals(second.subscriptionQuotas["codex"], failed.subscriptionQuotas["codex"])
        assertEquals(failed, failed.failSubscriptionQuery("query", "旧错误"))
    }

}
