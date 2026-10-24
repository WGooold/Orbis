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
        val rows = cachedHistoryTree(RemoteState(hostId = "paired-host", sessions = sessions)).single().directories.single().sessions
        fun matching(key: String, current: String?) = rows.filter { it.isCodex && matchesCodexProvider(it, key, current) }.map { it.sessionId }.toSet()
        assertEquals(setOf("current"), matching(CURRENT_CODEX_PROVIDER, "custom"))
        assertEquals(setOf("other"), matching(CURRENT_CODEX_PROVIDER, "openai"))
        assertEquals(emptySet<String>(), matching(CURRENT_CODEX_PROVIDER, null))
        assertEquals(setOf("legacy"), matching(UNKNOWN_CODEX_PROVIDER, "custom"))
        assertEquals(setOf("current", "other", "legacy"), matching(ALL_CODEX_PROVIDERS, "custom"))
        assertEquals(setOf("other"), matching(providerFilterKey("openai"), "custom"))
    }

    @Test fun `provider menu labels current config even when it has no sessions and excludes Pi providers`() {
        val tree = cachedHistoryTree(RemoteState(hostId = "paired-host", sessions = sessions))
        val options = codexProviderOptions(tree, "new-provider")
        assertEquals(CodexProviderOption(CURRENT_CODEX_PROVIDER, "new-provider（当前使用）"), options.first())
        assertEquals(listOf(CURRENT_CODEX_PROVIDER, ALL_CODEX_PROVIDERS, "provider:custom", "provider:openai", UNKNOWN_CODEX_PROVIDER), options.map { it.key })
        assertEquals(1, codexProviderOptions(tree, "custom").count { it.label.contains("custom") })
        assertEquals("当前 provider（尚未获取）", codexProviderOptions(emptyList(), null).first().label)
    }

    @Test fun `provider ownership survives cache serialization and partial runtime metadata`() {
        val source = entry("other", "openai")
        assertEquals(source, Json.decodeFromString<SessionCatalogEntry>(Json.encodeToString(source)))
        val state = reducer.reduce(RemoteState(hostId = "paired-host", sessions = sessions), """{
            "type":"runtime.online","runtime":{"runtimeId":"codex:other","sessionId":"other",
            "name":"Codex","cwd":"D:/repo","status":"idle","model":{"provider":"custom","id":"model"}}
        }""")
        assertEquals("openai", state.sessions["other"]?.modelProvider)
        assertEquals("openai", cachedHistoryTree(state).single().directories.single().sessions.first { it.sessionId == "other" }.modelProvider)
    }

    @Test fun `catalog updates providers independently of sessions and clears stale config on failure or disconnect`() {
        val initial = RemoteState(hostId = "paired-host", sessions = sessions, sessionListRequests = setOf("list"))
        val state = initial.withModelFixture("providers", """{"providers":[{"agentKind":"codex","current":"profile-uuid","modelProvider":"custom","profiles":null}]}""", scope = "host")
        assertEquals(mapOf("codex" to "custom"), state.currentProviders)
        assertEquals(sessions, state.sessions)
        val failed = state.withModelFixture("providers", """{"providers":[{"agentKind":"codex","current":"profile-uuid","modelProvider":null,"profiles":null}]}""", revision = 2, scope = "host")
        assertTrue(failed.currentProviders.isEmpty())
        assertTrue(reducer.reduce(state, """{"type":"host.offline","hostId":"host"}""").currentProviders.isEmpty())
        assertEquals(state, reducer.reduce(state, """{
            "type":"session.list.result","requestId":"stale","sessions":[],
            "currentProviders":[{"agentKind":"codex","provider":"wrong"}]
        }"""))
    }

    @Test fun `managed profile identity is never used as native session provider`() {
        val state = RemoteState(hostId = "paired-host").withModelFixture("providers", """{"providers":[
            {"agentKind":"codex","current":"managed-profile-uuid","profiles":[]},
            {"agentKind":"codexDesktop","current":null,"modelProvider":"custom","profiles":null}
        ]}""", scope = "host")
        assertEquals(mapOf("codexDesktop" to "custom"), state.currentProviders)
        assertEquals("codex: 未核对、codexDesktop: custom", state.providerSwitchingView().detail)
        val absent = state.withModelFixture("providers", """{"providers":[
            {"agentKind":"codex","current":"another-profile","modelProvider":"terminal","profiles":[]}
        ]}""", revision = 2, scope = "host")
        assertEquals(mapOf("codex" to "terminal"), absent.currentProviders)
    }

    @Test fun `desktop provider menu and ownership are independent from terminal providers`() {
        val entries = sessions + listOf(entry("desktop-current", "custom", "codexDesktop"),
            entry("desktop-other", "desktop-only", "codexDesktop"), entry("desktop-unknown", null, "codexDesktop"))
            .associateBy { it.sessionId }
        val tree = cachedHistoryTree(RemoteState(hostId = "paired-host", sessions = entries))
        val desktop = codexProviderOptions(tree, "custom", "codexDesktop")
        assertEquals(listOf(CURRENT_CODEX_PROVIDER, ALL_CODEX_PROVIDERS, "provider:desktop-only", UNKNOWN_CODEX_PROVIDER), desktop.map { it.key })
        assertEquals("custom（当前使用）", desktop.first().label)
        assertFalse(codexProviderOptions(tree, "custom", "codex").any { it.key == "provider:desktop-only" })
        val rows = tree.single().directories.single().sessions.filter { it.agentKind == "codexDesktop" }
        assertEquals(listOf("desktop-current"), rows.filter { matchesCodexProvider(it, CURRENT_CODEX_PROVIDER, "custom") }.map { it.sessionId })
        assertEquals(listOf("desktop-other"), rows.filter { matchesCodexProvider(it, providerFilterKey("desktop-only"), "custom") }.map { it.sessionId })
        assertEquals(listOf("desktop-unknown"), rows.filter { matchesCodexProvider(it, UNKNOWN_CODEX_PROVIDER, "custom") }.map { it.sessionId })
    }

    @Test fun `opening a foreign provider session explains how to switch without blocking Pi or unknown sessions`() {
        val state = RemoteState(hostId = "paired-host", sessions = sessions, currentProviders = mapOf("codex" to "custom"))
        assertTrue(state.codexProviderMismatch("other")!!.contains("此会话属于 openai，当前使用 custom"))
        assertNull(state.codexProviderMismatch("current"))
        assertNull(state.codexProviderMismatch("legacy"))
        assertNull(state.codexProviderMismatch("pi"))
        assertNull(state.copy(currentProviders = emptyMap()).codexProviderMismatch("other"))
    }
}
