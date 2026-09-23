package dev.pi.remote

import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import org.junit.Assert.*
import org.junit.Test

class SessionProviderFilterTest {
    private val reducer = RelayReducer()
    private fun entry(id: String, provider: String?, agent: String = "codex") = SessionCatalogEntry(
        sessionId = id, name = id, cwd = "D:/repo", hostname = "desktop", agentKind = agent,
        modelProvider = provider, hasHistoryCache = true,
    )

    private val sessions = listOf(
        entry("current", "custom"), entry("other", "openai"), entry("legacy", null), entry("pi", "anthropic", "pi"),
    ).associateBy { it.sessionId }

    @Test fun `current provider filter follows configuration and never guesses unknown ownership`() {
        val rows = cachedHistoryTree(RemoteState(sessions = sessions)).single().directories.single().sessions
        fun matching(key: String, current: String?) = rows.filter { it.isCodex && matchesCodexProvider(it, key, current) }.map { it.sessionId }.toSet()
        assertEquals(setOf("current"), matching(CURRENT_CODEX_PROVIDER, "custom"))
        assertEquals(setOf("other"), matching(CURRENT_CODEX_PROVIDER, "openai"))
        assertEquals(emptySet<String>(), matching(CURRENT_CODEX_PROVIDER, null))
        assertEquals(setOf("legacy"), matching(UNKNOWN_CODEX_PROVIDER, "custom"))
        assertEquals(setOf("current", "other", "legacy"), matching(ALL_CODEX_PROVIDERS, "custom"))
        assertEquals(setOf("other"), matching(providerFilterKey("openai"), "custom"))
    }

    @Test fun `provider menu labels current config even when it has no sessions and excludes Pi providers`() {
        val tree = cachedHistoryTree(RemoteState(sessions = sessions))
        val options = codexProviderOptions(tree, "new-provider")
        assertEquals(CodexProviderOption(CURRENT_CODEX_PROVIDER, "new-provider（当前使用）"), options.first())
        assertEquals(listOf(CURRENT_CODEX_PROVIDER, ALL_CODEX_PROVIDERS, "provider:custom", "provider:openai", UNKNOWN_CODEX_PROVIDER), options.map { it.key })
        assertEquals(1, codexProviderOptions(tree, "custom").count { it.label.contains("custom") })
        assertEquals("当前 provider（尚未获取）", codexProviderOptions(emptyList(), null).first().label)
    }

    @Test fun `provider ownership survives cache serialization and partial runtime metadata`() {
        val source = entry("other", "openai")
        assertEquals(source, Json.decodeFromString<SessionCatalogEntry>(Json.encodeToString(source)))
        val state = reducer.reduce(RemoteState(sessions = sessions), """{
            "type":"runtime.online","runtime":{"runtimeId":"codex:other","sessionId":"other",
            "name":"Codex","cwd":"D:/repo","status":"idle","model":{"provider":"custom","id":"model"}}
        }""")
        assertEquals("openai", state.sessions["other"]?.modelProvider)
        assertEquals("openai", cachedHistoryTree(state).single().directories.single().sessions.first { it.sessionId == "other" }.modelProvider)
    }

    @Test fun `catalog updates providers independently of sessions and clears stale config on failure or disconnect`() {
        val initial = RemoteState(sessions = sessions, sessionListRequests = setOf("list"))
        val state = reducer.reduce(initial, """{
            "type":"session.list.result","requestId":"list","sessions":[],
            "currentProviders":[{"agentKind":"codex","provider":"custom"}]
        }""")
        assertEquals(mapOf("codex" to "custom"), state.currentProviders)
        assertEquals(sessions, state.sessions)
        val failed = reducer.reduce(state.copy(sessionListRequests = setOf("failed")), """{
            "type":"session.list.result","requestId":"failed","sessions":[],"currentProviders":[]
        }""")
        assertTrue(failed.currentProviders.isEmpty())
        assertTrue(reducer.reduce(state, """{"type":"host.offline","hostId":"host"}""").currentProviders.isEmpty())
        assertEquals(state, reducer.reduce(state, """{
            "type":"session.list.result","requestId":"stale","sessions":[],
            "currentProviders":[{"agentKind":"codex","provider":"wrong"}]
        }"""))
    }

    @Test fun `opening a foreign provider session explains how to switch without blocking Pi or unknown sessions`() {
        val state = RemoteState(sessions = sessions, currentProviders = mapOf("codex" to "custom"))
        assertTrue(state.codexProviderMismatch("other")!!.contains("此会话属于 openai，当前使用 custom"))
        assertNull(state.codexProviderMismatch("current"))
        assertNull(state.codexProviderMismatch("legacy"))
        assertNull(state.codexProviderMismatch("pi"))
        assertNull(state.copy(currentProviders = emptyMap()).codexProviderMismatch("other"))
    }
}
