package dev.pi.remote

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SessionAliasStoreTest {
    @Test
    fun `blank alias removes the matching session entry`() {
        val device = DeviceCredential("wss://relay.example.com", "device-1", "credential")
        val runtime = RuntimeSummary("runtime-1", "MCC", "/work/project", "idle", "session-1")
        val entries = updateStoredSessionAliases(
            listOf(
                StoredSessionAlias("wss://relay.example.com", "device-1", "runtime-1", "session-1", "旧名称"),
                StoredSessionAlias("wss://relay.example.com", "device-1", "runtime-1", "session-2", "另一个会话"),
            ),
            device,
            runtime,
            "   ",
        )

        assertEquals(
            mapOf(SessionAliasIdentity("runtime-1", "session-2") to "另一个会话"),
            storedSessionAliasesFor(entries, device),
        )
    }

    @Test
    fun `aliases are isolated by relay device runtime and session`() {
        val device = DeviceCredential("wss://relay.example.com", "device-1", "credential")
        val otherDevice = device.copy(deviceId = "device-2")
        val runtime = RuntimeSummary("runtime-1", "MCC", "/work/project", "idle", "session-1")
        val entries = updateStoredSessionAliases(emptyList(), device, runtime, "项目一")

        assertEquals("项目一", storedSessionAliasesFor(entries, device)[runtime.sessionAliasIdentity()])
        assertNull(storedSessionAliasesFor(entries, otherDevice)[runtime.sessionAliasIdentity()])
        assertNull(
            storedSessionAliasesFor(entries, device)[
                SessionAliasIdentity(runtime.runtimeId, "session-2")
            ],
        )
        assertTrue(
            storedSessionAliasesFor(entries, device)[
                SessionAliasIdentity("runtime-2", runtime.sessionId)
            ] == null,
        )
    }

    @Test
    fun `all session surfaces share alias agent name and first user message priority`() {
        val runtime = RuntimeSummary(
            runtimeId = "runtime-1",
            name = "legacy-name",
            cwd = "D:\\work\\project",
            status = "idle",
            sessionId = "session-1",
            sessionName = "电脑端会话名称",
        )
        val firstMessage = ChatMessage(
            messageId = "message-1",
            role = "user",
            content = listOf(RemoteContent("text", "第一句：请检查项目。第二句不应显示")),
            timestamp = 1,
        )
        val graphEntry = SessionGraphEntry(
            entryId = "u1", parentId = null, type = "message", timestamp = "2026-01-01T00:00:00.000Z",
            data = Json.parseToJsonElement("""{"message":{"role":"user","content":"图中的首条消息。第二句"}}""").jsonObject,
        )
        val state = RemoteState(
            runtimes = mapOf(runtime.runtimeId to runtime),
            sessions = mapOf("session-1" to SessionCatalogEntry(
                "session-1", name = "目录名称", cwd = runtime.cwd, firstMessage = "目录中的首条消息。第二句",
            )),
            sessionGraphs = mapOf("session-1" to SessionGraph(
                sessionId = "session-1", entries = mapOf("u1" to graphEntry), cursor = SessionBranchCursor("u1"),
            )),
            conversations = mapOf(runtime.runtimeId to RuntimeConversation(messages = listOf(
                firstMessage.copy(messageId = "assistant", role = "assistant", content = listOf(RemoteContent("text", "忽略助手开场白"))),
                firstMessage,
            ))),
            sessionAliases = mapOf(runtime.sessionAliasIdentity() to "APP 别名"),
        )
        fun assertNames(expected: String, current: RemoteState) {
            current.runtimes.values.forEach { assertEquals(expected, current.runtimeDisplayName(it)) }
            assertEquals(expected, current.sessionDisplayName("session-1"))
            assertEquals(expected, cachedHistoryTree(current).single().directories.single().sessions.single().title)
        }

        assertNames("APP 别名", state)
        assertNames("APP 别名", state.copy(runtimes = emptyMap()))
        val named = state.copy(sessionAliases = emptyMap())
        assertNames("电脑端会话名称", named)
        assertNames("目录名称", named.copy(runtimes = emptyMap()))
        val unnamed = named.copy(
            runtimes = mapOf(runtime.runtimeId to runtime.copy(sessionName = "  ")),
            sessions = named.sessions.mapValues { it.value.copy(name = "  ") },
        )
        assertNames("图中的首条消息。", unnamed)
        assertNames("图中的首条消息。", unnamed.copy(runtimes = emptyMap()))
        val noGraph = unnamed.copy(sessionGraphs = emptyMap())
        assertNames("目录中的首条消息。", noGraph)
        assertNames("目录中的首条消息。", noGraph.copy(runtimes = emptyMap()))
        val noPreview = noGraph.copy(sessions = noGraph.sessions.mapValues { it.value.copy(firstMessage = null) })
        assertNames("第一句：请检查项目。", noPreview)
        assertNames("session-1", noPreview.copy(conversations = emptyMap()))
        assertNames("session-1", noPreview.copy(runtimes = emptyMap()))
        assertEquals("runtime-1", RemoteState().runtimeDisplayName(runtime.copy(sessionId = null, sessionName = null)))
        assertEquals("123456789012345678901234567890123456789…", firstUserMessageTitle(listOf(
            firstMessage.copy(content = listOf(RemoteContent("text", "12345678901234567890123456789012345678901234567890"))),
        )))

        // A live rename must survive going offline; clearing it must not revive the old catalog name.
        val reducer = RelayReducer()
        var updated = named
        listOf("自动命名", null).forEachIndexed { index, title ->
            updated = reducer.reduce(updated, """{
                "type":"runtime.event","runtimeId":"runtime-1","sequence":${index + 1},
                "event":{"type":"runtime.metadata","metadata":{
                    "runtimeId":"runtime-1","name":"Codex","cwd":"D:/repo","status":"idle",
                    "sessionId":"session-1"${title?.let { ",\"sessionName\":\"$it\"" }.orEmpty()}
                }}
            }""")
            val expected = title ?: "图中的首条消息。"
            assertNames(expected, updated)
            assertNames(expected, updated.copy(runtimes = emptyMap()))
        }
    }

    @Test
    fun `hostname prefixes the displayed working path`() {
        val runtime = RuntimeSummary(
            runtimeId = "runtime-1",
            name = "project",
            cwd = "D:\\work\\project",
            status = "idle",
            hostname = "devbox",
        )

        assertEquals("devbox-D:\\work\\project", runtime.runtimeDisplayPath())
        assertEquals("D:\\work\\project", runtime.copy(hostname = null).runtimeDisplayPath())
        assertEquals("D:\\work\\project", runtime.copy(hostname = "  ").runtimeDisplayPath())
    }

    @Test
    fun `alias input collapses whitespace removes controls and limits length`() {
        val normalized = normalizeSessionAlias("  项目\n\n\t控制\u0007${"x".repeat(100)}  ")

        assertEquals("项目 控制${"x".repeat(35)}", normalized)
    }
}
