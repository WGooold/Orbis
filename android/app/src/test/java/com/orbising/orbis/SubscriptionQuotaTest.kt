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

    @Test fun parsesBoundedAntigravityPoolWindows() {
        val pooled = Json.parseToJsonElement("""{"checkedAt":123,"windows":[{"name":"five_hour","remainingPercent":50,"resetsAt":456},{"name":"seven_day","remainingPercent":null,"resetsAt":null}],"pools":[{"id":"gemini-pro","label":"Gemini","windows":[{"name":"five_hour","remainingPercent":50,"resetsAt":456},{"name":"seven_day","remainingPercent":null,"resetsAt":null}]}]}""").jsonObject
        val parsed = parseSubscriptionQuota(pooled)
        assertEquals("Gemini", parsed?.pools?.singleOrNull()?.label)
        assertEquals(50.0, parsed?.pools?.singleOrNull()?.windows?.firstOrNull()?.remainingPercent)
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

    // QUOTA-FEEDBACK-01: an authenticated rejection settles the owning refresh, not the catalog or global banner.
    @Test fun protocolRejectionSettlesOnlyTheOwningQuotaQuery() {
        val reducer = RelayReducer()
        val loaded = waiting.withSubscriptionResult(response())
        val refreshing = loaded.beginSubscriptionQuery(provider, "retry")
        val rejection = """{"type":"protocol.error","requestId":"retry","code":"invalid_request","message":"电脑端不支持配额查询"}"""
        assertEquals(refreshing, reducer.reduce(refreshing, rejection, channel = null))
        assertEquals(refreshing, reducer.reduce(refreshing, rejection.replace("retry", "query"), channel = "ctl"))
        val failed = reducer.reduce(refreshing, rejection, channel = "ctl")
        assertNull(failed.agentProviders.quotaRequestId)
        assertEquals("电脑端不支持配额查询", failed.subscriptionQuotas["claude"]?.error)
        assertEquals(loaded.subscriptionQuotas["claude"]?.quota, failed.subscriptionQuotas["claude"]?.quota)
        assertNull(failed.agentProviders.error)
        assertNull(failed.feedback.banner)
        val retrying = failed.beginSubscriptionQuery(provider, "new")
        assertNull(retrying.subscriptionQuotas["claude"]?.error)
        assertEquals(retrying, reducer.reduce(retrying, rejection, channel = "ctl"))
        val recovered = retrying.withSubscriptionResult(response(request = "new"))
        assertNull(recovered.subscriptionQuotas["claude"]?.error)
        assertNull(recovered.agentProviders.quotaRequestId)
    }

    @Test fun disconnectKeepsLastReadingAndDoesNotAcceptLateQuota() {
        val loaded = waiting.withSubscriptionResult(response())
        val interrupted = loaded.beginSubscriptionQuery(provider, "pending").interruptSubscriptionQuery()
        assertNull(interrupted.agentProviders.quotaRequestId)
        assertEquals(loaded.subscriptionQuotas["claude"]?.quota, interrupted.subscriptionQuotas["claude"]?.quota)
        assertEquals(L10n.tr("连接已断开，请重新查询配额"), interrupted.subscriptionQuotas["claude"]?.error)
        assertEquals(interrupted, interrupted.withSubscriptionResult(response(request = "pending")))
    }

    // QUOTA-FEEDBACK-02: a partial catalog is not evidence that a queried configuration disappeared.
    @Test fun temporaryCatalogProblemKeepsTheReadingAndSettlesTheOwningReply() {
        val profiles = """[{"id":"official","enabled":true,"subscriptionSupported":true}]"""
        val readyCatalog = """{"providers":[{"agentKind":"claude","availability":"ready","profiles":$profiles}]}"""
        val loaded = waiting.withModelFixture("providers", readyCatalog, scope = "host").withSubscriptionResult(response())
        val refreshing = loaded.beginSubscriptionQuery(provider, "pending").let {
            it.copy(agentProviders = it.agentProviders.copy(kind = "codex", providers = emptyList()))
        }
        val partial = refreshing.withModelFixture("providers", readyCatalog.replace("ready", "unknown"), revision = 2, scope = "host")
        assertNotNull(partial.providerCatalogProblems["claude"])
        assertEquals(loaded.subscriptionQuotas["claude"], partial.subscriptionQuotas["claude"])
        val failure = Json.parseToJsonElement(
            """{"type":"provider.subscription.result","requestId":"pending","kind":"claude","id":"official","error":"登录过期"}"""
        ).jsonObject
        val failed = partial.withSubscriptionResult(failure)
        assertNull(failed.agentProviders.quotaRequestId)
        assertNull(failed.agentProviders.error)
        val recovered = failed.withModelFixture("providers", readyCatalog, revision = 3, scope = "host")
        assertNull(recovered.providerCatalogProblems["claude"])
        assertEquals("登录过期", recovered.subscriptionQuotas["claude"]?.error)
        assertEquals(loaded.subscriptionQuotas["claude"]?.quota, recovered.subscriptionQuotas["claude"]?.quota)
        assertEquals(recovered, recovered.withSubscriptionResult(response(request = "pending")))
    }

    @Test fun verifiedRemovalOfAQuotaOwnerInvalidatesItsPendingRead() {
        val loaded = waiting.withSubscriptionResult(response())
        val codex = provider.copy(kind = "codex")
        val withBoth = loaded.copy(providerCatalogs = mapOf("codex" to listOf(codex)))
            .beginSubscriptionQuery(codex, "codex").withSubscriptionResult(response(request = "codex", kind = "codex"))
        val refreshing = withBoth.beginSubscriptionQuery(provider, "pending")
        val changed = refreshing.withModelFixture("providers",
            """{"providers":[{"agentKind":"claude","availability":"ready","profiles":[]}]}""", scope = "host")
        assertNull(changed.subscriptionQuotas["claude"])
        assertNull(changed.agentProviders.quotaRequestId)
        assertEquals(withBoth.subscriptionQuotas["codex"], changed.subscriptionQuotas["codex"])
        assertEquals(changed, changed.withSubscriptionResult(response(request = "pending")))
    }

}
