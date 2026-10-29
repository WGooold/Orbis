package com.orbising.orbis

import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class SessionDisplayNameCacheTest {
    @get:Rule val temporary = TemporaryFolder()
    private val device = DeviceCredential("wss://relay.example", "device", "test")
    private val runtime = RuntimeSummary("r", "Pi runtime", "/repo", "idle", sessionId = "s", agentKind = "pi")

    private fun state(entry: SessionCatalogEntry = SessionCatalogEntry("s", cwd = "/repo", agentKind = "pi")) =
        RemoteState(hostId = "host", deviceId = device.deviceId, runtimes = mapOf("r" to runtime), sessions = mapOf("s" to entry))

    private fun graph(text: String, role: String = "user"): SessionGraph = fixtureGraph("s", listOf(
        SessionGraphEntry("message", type = "message", timestamp = "2026-01-01T00:00:00.000Z", data = buildJsonObject {
            put("message", buildJsonObject { put("role", role); put("content", text) })
        }),
    ), SessionBranchCursor("message"))

    @Test fun `first loaded user title survives restart without a transcript`() {
        val initial = state()
        val cached = initial.copy(sessionGraphs = mapOf("s" to graph("修复安卓首页。\n后面的消息不属于标题")))
            .cachePiSessionNames(initial)
        assertEquals("修复安卓首页。", cached.sessions["s"]?.cachedDisplayName)
        val file = temporary.newFile()
        SessionCatalogStore(file).save(device, "host", cached.sessions.values)
        val restarted = state().copy(sessions = SessionCatalogStore(file).load(device, "host").associateBy { it.sessionId })
        assertTrue(restarted.sessionGraphs.isEmpty())
        assertTrue(restarted.conversations.isEmpty())
        assertEquals("修复安卓首页。", restarted.runtimeDisplayName(runtime))
        assertEquals("修复安卓首页。", restarted.sessionDisplayName("s"))
        assertEquals("修复安卓首页。", cachedHistoryTree(restarted).single().directories.single().sessions.single().title)
        assertSame(restarted, restarted.cachePiSessionNames())
    }

    @Test fun `later runtime names catalog updates and history never replace the Pi label`() {
        val cached = state().copy(sessionGraphs = mapOf("s" to graph("首次名称"))).cachePiSessionNames()
        val catalog = cached.withModelFixture("catalog", """{"sessions":[
            {"sessionId":"s","cwd":"/repo","agentKind":"pi","name":"电脑上的新名字",
             "firstMessage":"新的摘要","cachedDisplayName":"不接受的远程缓存名"}],"backends":[]}""", scope = "host")
        assertEquals("电脑上的新名字", catalog.sessions["s"]?.name)
        assertEquals("首次名称", catalog.sessions["s"]?.cachedDisplayName)
        val identity = catalog.withModelFixture("identity", """{"runtimeId":"r","sessionId":"s",
            "name":"Pi runtime","sessionName":"又一个名字","cwd":"/repo","status":"idle","agentKind":"pi"}""")
        val changed = identity.copy(sessionGraphs = mapOf("s" to graph("换了分支后的消息"))).cachePiSessionNames(cached)
        assertEquals("又一个名字", changed.runtimes["r"]?.sessionName)
        assertEquals("首次名称", changed.runtimeDisplayName(changed.runtimes.getValue("r")))
        assertEquals("首次名称", changed.copy(runtimes = emptyMap(), sessionGraphs = emptyMap()).sessionDisplayName("s"))
    }

    @Test fun `reconnecting an unnamed runtime keeps the cached title with a new runtime id`() {
        val cached = state().copy(sessionGraphs = mapOf("s" to graph("保持这个名字"))).cachePiSessionNames()
        val reconnect = runtime.copy(runtimeId = "new-runtime", agentKind = null)
        val merged = mergeSessionCatalogEntry(cached.sessions["s"], reconnect.catalogEntry()!!)
        val next = cached.copy(runtimes = mapOf(reconnect.runtimeId to reconnect), sessions = mapOf("s" to merged),
            sessionGraphs = emptyMap(), conversations = emptyMap()).cachePiSessionNames(cached)
        assertEquals("", merged.name)
        assertEquals("保持这个名字", next.runtimeDisplayName(reconnect))
    }

    @Test fun `legacy catalog titles are captured on startup without history loading`() {
        val file = temporary.newFile()
        file.writeText("""{"relayUrl":"wss://relay.example","deviceId":"device","hostId":"host","updatedAt":1,
            "sessions":[{"sessionId":"s","agentKind":"pi","name":"已有名称","firstMessage":"其他摘要"},
                        {"sessionId":"preview","agentKind":"pi","firstMessage":"首条消息。第二句无需缓存"}]}""")
        val restored = RemoteState(hostId = "host", sessions = SessionCatalogStore(file).load(device, "host").associateBy { it.sessionId })
            .cachePiSessionNames()
        assertEquals("已有名称", restored.sessions["s"]?.cachedDisplayName)
        assertEquals("首条消息。", restored.sessions["preview"]?.cachedDisplayName)
        assertTrue(restored.sessionGraphs.isEmpty())
        SessionCatalogStore(file).save(device, "host", restored.sessions.values)
        assertEquals(restored.sessions.values.toSet(), SessionCatalogStore(file).load(device, "host").toSet())
    }

    @Test fun `catalog preview is preferred over a loaded tail and remains bounded`() {
        val text = "内容".repeat(30)
        val cached = state(SessionCatalogEntry("s", agentKind = "pi", firstMessage = "  $text\n第二行"))
            .copy(sessionGraphs = mapOf("s" to graph("最近一页的用户消息"))).cachePiSessionNames()
        assertEquals(text.take(39) + "…", cached.sessionDisplayName("s"))
        assertEquals(40, cached.sessionDisplayName("s").length)
    }

    @Test fun `blank names runtime labels ids and assistant text do not freeze a placeholder`() {
        val empty = state(SessionCatalogEntry("s", name = "s", firstMessage = " \n ", agentKind = "pi"))
            .copy(runtimes = mapOf("r" to runtime.copy(sessionName = "s")), sessionGraphs = mapOf("s" to graph("助手开场白", "assistant")))
        assertSame(empty, empty.cachePiSessionNames())
        assertNull(empty.sessions["s"]?.cachedDisplayName)
        val loaded = empty.copy(sessionGraphs = mapOf("s" to graph("用户终于发来消息"))).cachePiSessionNames(empty)
        assertEquals("用户终于发来消息", loaded.sessionDisplayName("s"))
    }

    @Test fun `live user messages can populate the catalog before a graph exists`() {
        val initial = state().copy(sessions = emptyMap())
        val live = initial.copy(conversations = mapOf("r" to RuntimeConversation(messages = listOf(
            ChatMessage("assistant", "assistant", listOf(RemoteContent("text", "欢迎")), 1),
            ChatMessage("user", "user", listOf(RemoteContent("text", "处理这个任务！后续")), 2),
        )))).cachePiSessionNames(initial)
        assertEquals("处理这个任务！", live.sessions["s"]?.cachedDisplayName)
        assertEquals("pi", live.sessions["s"]?.agentKind)
        assertTrue(live.sessionGraphs.isEmpty())
    }

    @Test fun `cached names do not inspect history again even when the graph changes`() {
        val cached = state(SessionCatalogEntry("s", agentKind = "pi", cachedDisplayName = "直接读取缓存"))
        val unavailableEntries = object : Map<String, SessionGraphEntry> by emptyMap() {
            override fun isEmpty(): Boolean = error("History must not be inspected to resolve a cached name")
        }
        val next = cached.copy(sessionGraphs = mapOf("s" to SessionGraph("s", entries = unavailableEntries,
            cursor = SessionBranchCursor("leaf"))))
        assertSame(next, next.cachePiSessionNames(cached))
        assertEquals("直接读取缓存", next.runtimeDisplayName(runtime))
    }

    @Test fun `multiple windows share one session label without borrowing another sessions messages`() {
        val extraWindow = runtime.copy(runtimeId = "second")
        val initial = state().copy(runtimes = mapOf("r" to runtime, "second" to extraWindow), conversations = mapOf(
            "r" to RuntimeConversation(streamingSessionId = "previous-session", messages = listOf(
                ChatMessage("old", "user", listOf(RemoteContent("text", "上一会话的消息")), 1))),
        ))
        assertSame(initial, initial.cachePiSessionNames())
        val named = initial.copy(conversations = initial.conversations + ("second" to RuntimeConversation(
            streamingSessionId = "s", messages = listOf(ChatMessage("current", "user", listOf(RemoteContent("text", "当前会话名称")), 2)),
        ))).cachePiSessionNames(initial)
        assertEquals("当前会话名称", named.runtimeDisplayName(runtime))
        assertEquals("当前会话名称", named.runtimeDisplayName(extraWindow))
        val renamed = named.copy(runtimes = mapOf("r" to runtime.copy(sessionName = "稍后命名"), "second" to extraWindow))
        assertSame(renamed, renamed.cachePiSessionNames(named))
        assertEquals("当前会话名称", renamed.runtimeDisplayName(renamed.runtimes.getValue("r")))
    }

    @Test fun `name cache remains scoped to its paired Host and device`() {
        val first = temporary.newFile()
        val second = temporary.newFile()
        SessionCatalogStore(first).save(device, "host", listOf(SessionCatalogEntry("s", agentKind = "pi", cachedDisplayName = "电脑一")))
        SessionCatalogStore(second).save(device, "other-host", listOf(SessionCatalogEntry("s", agentKind = "pi", cachedDisplayName = "电脑二")))
        assertEquals("电脑一", SessionCatalogStore(first).load(device, "host").single().cachedDisplayName)
        assertEquals("电脑二", SessionCatalogStore(second).load(device, "other-host").single().cachedDisplayName)
        assertTrue(SessionCatalogStore(first).load(device, "other-host").isEmpty())
        assertTrue(SessionCatalogStore(first).load(device.copy(deviceId = "other-device"), "host").isEmpty())
        SessionCatalogStore(first).clear()
        assertTrue(SessionCatalogStore(first).load(device, "host").isEmpty())
        assertEquals("电脑二", SessionCatalogStore(second).load(device, "other-host").single().cachedDisplayName)
    }

    @Test fun `other agents keep following authoritative names and cannot import a local label`() {
        val codex = runtime.copy(agentKind = "codex", sessionName = "Codex 新名字")
        val current = state(SessionCatalogEntry("s", agentKind = "codex", cachedDisplayName = "旧缓存"))
            .copy(runtimes = mapOf("r" to codex))
        assertSame(current, current.cachePiSessionNames())
        assertEquals("Codex 新名字", current.sessionDisplayName("s"))
        val incoming = SessionCatalogEntry("new", agentKind = "pi", cachedDisplayName = "远程字段")
        assertNull(mergeSessionCatalogEntry(null, incoming).cachedDisplayName)
        val projected = RemoteState(hostId = "host").withModelFixture("catalog", """{"sessions":[
            {"sessionId":"new","agentKind":"pi","cachedDisplayName":"远程字段"}],"backends":[]}""", scope = "host")
        assertNull(projected.sessions["new"]?.cachedDisplayName)
    }
}
