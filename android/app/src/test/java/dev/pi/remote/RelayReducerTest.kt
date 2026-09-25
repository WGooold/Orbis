package dev.pi.remote

import org.junit.Assert.assertEquals
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

class RelayReducerTest {
    private val reducer = RelayReducer()

    @Test
    fun `working branch ignores stale responses across refresh session and directory changes`() {
        val runtime = RuntimeSummary("runtime-a", "A", "/repo", "idle", "session-1")
        val initial = RemoteState(
            runtimes = mapOf(runtime.runtimeId to runtime),
            workingBranches = mapOf(runtime.runtimeId to WorkingBranch("new-request", runtime.sessionId, runtime.cwd, branch = "main", loaded = true)),
        )
        fun reply(requestId: String = "new-request", branch: String = "\"feature/mobile\"") = """
            {"type":"runtime.git","runtimeId":"runtime-a","requestId":"$requestId",
             "sessionId":"session-1","cwd":"/repo","branch":$branch,"commit":null}
        """
        assertEquals(initial, reducer.reduce(initial, reply(requestId = "old-request")))
        val updated = reducer.reduce(initial, reply())
        assertEquals("feature/mobile", updated.workingBranches["runtime-a"]?.branch)
        val cleared = reducer.reduce(updated, reply(branch = "null"))
        assertEquals(null, cleared.workingBranches["runtime-a"]?.branch)
        assertEquals(true, cleared.workingBranches["runtime-a"]?.loaded)
        val changedSession = initial.copy(runtimes = mapOf(runtime.runtimeId to runtime.copy(sessionId = "session-2")))
        assertEquals(changedSession, reducer.reduce(changedSession, reply()))
        val changedDirectory = initial.copy(runtimes = mapOf(runtime.runtimeId to runtime.copy(cwd = "/worktree")))
        assertEquals(changedDirectory, reducer.reduce(changedDirectory, reply()))
        val offline = initial.copy(runtimes = emptyMap())
        assertEquals(offline, reducer.reduce(offline, reply()))
    }

    @Test
    fun `a newly opened runtime requests preview before catchup`() {
        val conversation = RuntimeConversation()

        assertEquals("preview", initialSessionSyncRange(conversation, "known-leaf"))
        assertEquals("catchup", initialSessionSyncRange(
            conversation.copy(hasLiveSnapshot = true),
            "known-leaf",
        ))
        assertEquals("preview", initialSessionSyncRange(conversation, null))
        assertTrue(shouldStartBranchCatchUpImmediately(conversation.copy(hasLiveSnapshot = true), true))
        assertFalse(shouldStartBranchCatchUpImmediately(conversation, true))
    }

    @Test
    fun `runtime refresh keeps an idle snapshot visible while reconciling the graph`() {
        val initial = RemoteState(
            selectedRuntimeId = "runtime-a",
            runtimes = mapOf(
                "runtime-a" to RuntimeSummary(
                    "runtime-a",
                    "A",
                    "/a",
                    "idle",
                    "session-1",
                    sessionGraphSync = true,
                    sessionLeafId = "leaf-2",
                ),
            ),
            conversations = mapOf(
                "runtime-a" to RuntimeConversation(
                    messages = listOf(ChatMessage("old", "assistant", emptyList(), 1)),
                    hasLiveSnapshot = true,
                ),
            ),
        )

        val refreshed = initial.requestRuntimeRefresh("runtime-a")

        assertEquals(listOf("old"), refreshed.conversations["runtime-a"]?.messages?.map(ChatMessage::messageId))
        assertEquals(true, refreshed.conversations["runtime-a"]?.hasLiveSnapshot)
        assertEquals(false, refreshed.conversations["runtime-a"]?.isChatSyncing)
        assertTrue("runtime-a" in refreshed.sessionSyncRequests)
        assertEquals(refreshed, refreshed.requestRuntimeRefresh("other-runtime"))

        val streaming = RemoteState(
            selectedRuntimeId = "runtime-a",
            runtimes = mapOf(
                "runtime-a" to RuntimeSummary(
                    "runtime-a",
                    "A",
                    "/a",
                    "running",
                    "session-1",
                    sessionGraphSync = true,
                    sessionLeafId = "leaf-2",
                ),
            ),
            conversations = mapOf(
                "runtime-a" to RuntimeConversation(
                    messages = listOf(ChatMessage("stream", "assistant", emptyList(), 1)),
                    streamingMessageIds = setOf("stream"),
                    hasLiveSnapshot = true,
                ),
            ),
        )

        assertEquals(streaming, streaming.requestRuntimeRefresh("runtime-a"))
    }

    @Test
    fun `tree refresh supersedes an older catch-up task before requesting the new branch`() {
        val initial = RemoteState(
            selectedRuntimeId = "runtime-a",
            runtimes = mapOf(
                "runtime-a" to RuntimeSummary(
                    "runtime-a", "A", "/a", "idle", "session-1",
                    sessionGraphSync = true, sessionLeafId = "old-leaf",
                ),
            ),
            conversations = mapOf(
                "runtime-a" to RuntimeConversation(
                    messages = listOf(ChatMessage("old-leaf", "assistant", emptyList(), 1)),
                    hasLiveSnapshot = true,
                ),
            ),
            runtimeSessionViews = mapOf("runtime-a" to RuntimeSessionView("runtime-a", "session-1", "old-leaf")),
            sessionSyncCommands = mapOf(
                "old-command" to PendingSessionSync(
                    "runtime-a", "session-1", "old-sync", range = "catchup", targetLeafId = "old-leaf",
                ),
            ),
            pendingCommands = mapOf("old-command" to "runtime-a"),
        )

        val refreshed = initial.requestBranchRefresh("runtime-a")

        assertTrue("old-command" !in refreshed.sessionSyncCommands)
        assertTrue("old-command" !in refreshed.pendingCommands)
        assertTrue("runtime-a" in refreshed.sessionSyncRequests)
        assertTrue(refreshed.conversations["runtime-a"]?.messages?.isEmpty() == true)
        assertEquals(1, refreshed.sessionBranchGenerations["runtime-a"])
    }

    @Test
    fun `explicit tree refresh rejects a late snapshot from a disconnected old branch`() {
        val initial = RemoteState(
            selectedRuntimeId = "runtime-a",
            runtimes = mapOf(
                "runtime-a" to RuntimeSummary(
                    "runtime-a", "A", "/a", "idle", "session-1",
                    sessionGraphSync = true, sessionLeafId = "new-leaf",
                ),
            ),
            conversations = mapOf(
                "runtime-a" to RuntimeConversation(
                    messages = listOf(ChatMessage("old-leaf", "assistant", emptyList(), 1)),
                    hasLiveSnapshot = true,
                ),
            ),
            runtimeSessionViews = mapOf("runtime-a" to RuntimeSessionView("runtime-a", "session-1", "old-leaf")),
            sessionGraphs = mapOf(
                "session-1" to SessionGraph(
                    "session-1",
                    entries = listOf(
                        SessionGraphEntry("old-leaf", null, "message", "1"),
                        SessionGraphEntry("new-leaf", "missing-parent", "message", "2"),
                    ).associateBy(SessionGraphEntry::entryId),
                    cursor = SessionBranchCursor("old-leaf"),
                ),
            ),
            sessionSyncCommands = mapOf(
                "old-command" to PendingSessionSync("runtime-a", "session-1", "old-sync", targetLeafId = "old-leaf"),
            ),
            pendingCommands = mapOf("old-command" to "runtime-a"),
        )

        val refreshed = initial.requestBranchRefresh("runtime-a")
        val changed = reducer.reduce(refreshed, """
          {"type":"runtime.event","runtimeId":"runtime-a","sequence":1,"event":{
            "type":"session.snapshot","sessionId":"session-1","syncId":"old-sync","mode":"append",
            "range":"catchup","targetLeafId":"old-leaf","complete":true,"cursor":{"leafId":"old-leaf"},
            "entries":[{"entryId":"stale","parentId":null,"type":"message","timestamp":"3"}]
          }}
        """.trimIndent())

        assertTrue("old-command" !in changed.sessionSyncCommands)
        assertTrue("old-command" !in changed.pendingCommands)
        assertEquals("new-leaf", changed.runtimes["runtime-a"]?.sessionLeafId)
        assertEquals(initial.sessionGraphs, changed.sessionGraphs)
        assertTrue(changed.conversations["runtime-a"]?.messages?.isEmpty() == true)
        assertTrue("runtime-a" in changed.sessionSyncRequests)
        assertEquals(1, changed.sessionBranchGenerations["runtime-a"])
    }

    // 版本号必须来自常量。曾经这里硬编码了 `!= 3`：协议升到 4 之后每条入站消息都被判成
    // 「不兼容的协议版本」，界面永远停在「正在连接」+ 弹窗——而链路其实是通的，极难定位。
    @Test
    fun `accepts the current protocol version and rejects any other`() {
        val ready = { version: Int ->
            """
              {"type":"device.ready","protocolVersion":$version,"deviceId":"phone-1","runtimes":[]}
            """.trimIndent()
        }
        val ok = reducer.reduce(RemoteState(), ready(PROTOCOL_VERSION))
        assertEquals(RelayConnection.ONLINE, ok.connection)
        assertEquals(null, ok.error)

        // 旧版本**绝不能**被当成已连接：这才是这条不变量真正要守的东西（connection 的默认值
        // 是 OFFLINE 还是 CONNECTING 不重要，将来改了也不该让这条测试变红）。
        val stale = reducer.reduce(RemoteState(), ready(PROTOCOL_VERSION - 1))
        assertNotEquals(RelayConnection.ONLINE, stale.connection)
        assertEquals("收到不兼容的协议版本，请升级 Orbis", stale.error)
    }

    // issue 02 验收：事件按 ctl/msg 分道投递，`ctl` 插队是常态。水位线若按 runtimeId
    // 全局记账，后到的 ctl 会把先发出的 msg 永久压死——手机丢掉那条消息，且无任何提示。
    @Test
    fun `a late ctl event does not evict an earlier msg event`() {
        val ctlArrived = reducer.reduce(
            RemoteState(),
            """
              {"type":"runtime.event","runtimeId":"runtime-a","sequence":100,
               "event":{"type":"runtime.status","status":"running"}}
            """.trimIndent(),
            channel = "ctl",
        )
        val msgAccepted = reducer.reduce(
            ctlArrived,
            """
              {"type":"runtime.event","runtimeId":"runtime-a","sequence":99,
               "event":{"type":"message.queued","queueId":"q-1","text":"hi","delivery":"steer","state":"accepted"}}
            """.trimIndent(),
            channel = "msg",
        )
        // msg 的序号 99 小于 ctl 的 100，但两本账互不相认：msg 必须照常生效。
        assertEquals(
            QueuedMessage("q-1", "hi", "steer", "accepted", null),
            msgAccepted.conversations["runtime-a"]?.queuedMessages["q-1"],
        )
        assertEquals(99L, msgAccepted.lastSequence["runtime-a\u0000msg"])
        assertEquals(100L, msgAccepted.lastSequence["runtime-a\u0000ctl"])

        // 同一道内的重复仍按重放丢弃：道内高水位线照常工作。
        val replayed = reducer.reduce(
            msgAccepted,
            """
              {"type":"runtime.event","runtimeId":"runtime-a","sequence":99,
               "event":{"type":"message.queued","queueId":"q-1","text":"hi","delivery":"steer","state":"accepted"}}
            """.trimIndent(),
            channel = "msg",
        )
        assertEquals(msgAccepted, replayed)
    }

    /**
     * Kotlin 的 `PROTOCOL_VERSION` 与 Node 的 `PROTOCOL_VERSION`（`packages/protocol/src/index.ts`）
     * 是同一份契约的**两份字面量**，没有任何机制能自动让它们一致——而两边版本不同步的后果是
     * 连接被对端直接关掉，症状还只是一句含糊的「Relay 拒绝了协议消息」。
     *
     * 直接读取 Node 的声明来比较，避免在测试里再维护第三份版本字面量。
     */
    @Test
    fun `protocol version constant matches the node side`() {
        val protocolSource = generateSequence(File(checkNotNull(System.getProperty("user.dir")))) { it.parentFile }
            .map { File(it, "packages/protocol/src/index.ts") }
            .first { it.isFile }
            .readText()
        val nodeVersion = Regex("export const PROTOCOL_VERSION = (\\d+) as const;")
            .find(protocolSource)?.groupValues?.get(1)?.toInt()
        assertEquals(nodeVersion, PROTOCOL_VERSION)
    }

    @Test
    fun `session catalog merges metadata without runtime ownership`() {
        var state = reducer.reduce(RemoteState(), """
          {"type":"device.ready","deviceId":"phone-1","runtimes":[
            {"runtimeId":"runtime-a","name":"A","cwd":"/a","status":"idle","sessionId":"session-1"},
            {"runtimeId":"runtime-b","name":"B","cwd":"/b","status":"idle","sessionId":"session-2"}
          ]}
        """.trimIndent(), channel = "ctl")
        state = reducer.reduce(state, """
          {"type":"runtime.event","runtimeId":"runtime-a","sequence":1,"event":{
            "type":"session.catalog","sessions":[
              {"sessionId":"session-1","name":"API","cwd":"/a","createdAt":1,"modifiedAt":2,"messageCount":3},
              {"sessionId":"session-old","name":"Old","cwd":"/a","createdAt":1,"modifiedAt":3,"messageCount":4}
            ]
          }}
        """.trimIndent())
        state = reducer.reduce(state, """
          {"type":"runtime.event","runtimeId":"runtime-b","sequence":1,"event":{
            "type":"session.catalog","sessions":[
              {"sessionId":"session-1","name":"API","cwd":"/a","createdAt":1,"modifiedAt":4,"messageCount":5}
            ]
          }}
        """.trimIndent())

        assertEquals(5, state.sessions["session-1"]?.messageCount)
        assertEquals("session-1", state.runtimes["runtime-a"]?.sessionId)
        assertEquals("session-2", state.runtimes["runtime-b"]?.sessionId)
    }

    @Test
    fun `host offline resets the e2e channel and online runtimes`() {
        var state = reducer.reduce(RemoteState(), """
          {"type":"device.ready","deviceId":"phone-1","runtimes":[
            {"runtimeId":"runtime-a","name":"A","cwd":"/a","status":"idle","sessionId":"session-1"}
          ]}
        """.trimIndent(), channel = "ctl")
        state = state.copy(e2eReady = true, pendingCommands = mapOf("cmd-1" to "runtime-a"))

        state = reducer.reduce(state, """{"type":"host.offline","hostId":"host-1","reason":"disconnected"}""")

        assertFalse(state.e2eReady)
        assertTrue(state.runtimes.isEmpty())
        assertTrue(state.pendingCommands.isEmpty())
        assertEquals("cancelled", state.commandResults["cmd-1"]?.status)

        // host.online 本身不改状态：等重握手后的 device.ready 把目录重新对齐。
        val before = state
        state = reducer.reduce(state, """{"type":"host.online","hostId":"host-1"}""")
        assertEquals(before, state)
    }

    @Test
    fun `session snapshots share graph storage while keeping runtime leaves independent`() {
        val runtimeA = RuntimeSummary("runtime-a", "A", "/a", "idle", "session-1", sessionGraphSync = true)
        val runtimeB = RuntimeSummary("runtime-b", "B", "/b", "idle", "session-1", sessionGraphSync = true)
        var state = RemoteState(
            runtimes = mapOf("runtime-a" to runtimeA, "runtime-b" to runtimeB),
            sessionSyncCommands = mapOf(
                "command-a" to PendingSessionSync("runtime-a", "session-1", "sync-a"),
            ),
        )
        state = reducer.reduce(state, """
          {"type":"runtime.event","runtimeId":"runtime-a","sequence":1,"event":{
            "type":"session.snapshot","sessionId":"session-1","syncId":"sync-a","mode":"replace",
            "cursor":{"leafId":"a"},
            "entries":[
              {"entryId":"root","parentId":null,"type":"message","timestamp":"2026-01-01T00:00:00.000Z","data":{"message":{"role":"user","content":"root"}}},
              {"entryId":"a","parentId":"root","type":"message","timestamp":"2026-01-01T00:00:01.000Z","data":{"message":{"role":"assistant","content":"A"}}},
              {"entryId":"b","parentId":"root","type":"message","timestamp":"2026-01-01T00:00:02.000Z","data":{"message":{"role":"assistant","content":"B"}}}
            ]
          }}
        """.trimIndent())
        state = state.copy(
            sessionSyncCommands = mapOf(
                "command-b" to PendingSessionSync("runtime-b", "session-1", "sync-b"),
            ),
        )
        state = reducer.reduce(state, """
          {"type":"runtime.event","runtimeId":"runtime-b","sequence":1,"event":{
            "type":"session.snapshot","sessionId":"session-1","syncId":"sync-b","mode":"replace",
            "cursor":{"leafId":"b"},
            "entries":[
              {"entryId":"root","parentId":null,"type":"message","timestamp":"2026-01-01T00:00:00.000Z","data":{"message":{"role":"user","content":"root"}}},
              {"entryId":"a","parentId":"root","type":"message","timestamp":"2026-01-01T00:00:01.000Z","data":{"message":{"role":"assistant","content":"A"}}},
              {"entryId":"b","parentId":"root","type":"message","timestamp":"2026-01-01T00:00:02.000Z","data":{"message":{"role":"assistant","content":"B"}}}
            ]
          }}
        """.trimIndent())

        assertEquals(setOf("root", "a", "b"), state.sessionGraphs["session-1"]?.entries?.keys)
        assertEquals("a", state.runtimeSessionViews["runtime-a"]?.leafId)
        assertEquals("b", state.runtimeSessionViews["runtime-b"]?.leafId)
        assertEquals(listOf("root", "b"), state.conversations["runtime-b"]?.messages?.map(ChatMessage::messageId))
    }

    @Test
    fun `partial preview switches the target branch and keeps the preview until the target leaf arrives`() {
        val runtime = RuntimeSummary(
            "runtime-a",
            "A",
            "/a",
            "idle",
            "session-1",
            sessionGraphSync = true,
            sessionLeafId = "target",
        )
        val previewCommand = PendingSessionSync(
            runtimeId = "runtime-a",
            sessionId = "session-1",
            syncId = "preview-1",
            range = "preview",
            targetLeafId = "target",
        )
        var state = RemoteState(
            selectedRuntimeId = "runtime-a",
            runtimes = mapOf("runtime-a" to runtime),
            sessionSyncCommands = mapOf("command-preview" to previewCommand),
            pendingCommands = mapOf("command-preview" to "runtime-a"),
        )
        state = reducer.reduce(state, """
          {"type":"runtime.event","runtimeId":"runtime-a","sequence":1,"event":{
            "type":"session.snapshot","sessionId":"session-1","syncId":"preview-1","mode":"replace",
            "range":"preview","targetLeafId":"target","complete":false,"hasOlder":true,
            "cursor":{"leafId":"target"},"entries":[
              {"entryId":"tail","parentId":"missing","type":"message","timestamp":"2026-01-01T00:00:01.000Z","data":{"message":{"role":"assistant","content":"tail"}}},
              {"entryId":"target","parentId":"tail","type":"message","timestamp":"2026-01-01T00:00:02.000Z","data":{"message":{"role":"user","content":"target"}}}
            ]
          }}
        """.trimIndent())
        assertEquals("target", state.runtimeSessionViews["runtime-a"]?.leafId)
        assertEquals(listOf("tail", "target"), state.conversations["runtime-a"]?.messages?.map(ChatMessage::messageId))

        val catchupCommand = PendingSessionSync(
            runtimeId = "runtime-a",
            sessionId = "session-1",
            syncId = "catchup-1",
            range = "catchup",
            targetLeafId = "target",
            knownLeafId = null,
        )
        state = state.copy(
            sessionSyncCommands = mapOf("command-catchup" to catchupCommand),
            pendingCommands = mapOf("command-catchup" to "runtime-a"),
        )
        state = reducer.reduce(state, """
          {"type":"runtime.event","runtimeId":"runtime-a","sequence":2,"event":{
            "type":"session.snapshot","sessionId":"session-1","syncId":"catchup-1","mode":"replace",
            "range":"catchup","targetLeafId":"target","complete":false,
            "cursor":{"leafId":"target"},"entries":[
              {"entryId":"root","parentId":null,"type":"message","timestamp":"2026-01-01T00:00:00.000Z","data":{"message":{"role":"user","content":"root"}}}
            ]
          }}
        """.trimIndent())

        assertEquals("target", state.runtimeSessionViews["runtime-a"]?.leafId)
        assertEquals(listOf("tail", "target"), state.conversations["runtime-a"]?.messages?.map(ChatMessage::messageId))

        val switched = reducer.reduce(
            RemoteState(
                selectedRuntimeId = "runtime-a",
                runtimes = mapOf(
                    "runtime-a" to RuntimeSummary(
                        "runtime-a", "A", "/a", "idle", "session-1",
                        sessionGraphSync = true,
                        sessionLeafId = "new",
                    ),
                ),
                runtimeSessionViews = mapOf("runtime-a" to RuntimeSessionView("runtime-a", "session-1", "old")),
                sessionGraphs = mapOf(
                    "session-1" to SessionGraph(
                        "session-1",
                        entries = listOf(
                            SessionGraphEntry("root", null, "message", "1", buildJsonObject {
                                put("message", buildJsonObject { put("role", "user"); put("content", "root") })
                            }),
                            SessionGraphEntry("old", "root", "message", "2", buildJsonObject {
                                put("message", buildJsonObject { put("role", "assistant"); put("content", "old") })
                            }),
                        ).associateBy(SessionGraphEntry::entryId),
                        cursor = SessionBranchCursor("old"),
                    ),
                ),
                conversations = mapOf(
                    "runtime-a" to RuntimeConversation(
                        messages = listOf(
                            ChatMessage("root", "user", listOf(RemoteContent("text", "root")), 1),
                            ChatMessage("old", "assistant", listOf(RemoteContent("text", "old")), 2),
                        ),
                        hasLiveSnapshot = true,
                    ),
                ),
                sessionSyncCommands = mapOf(
                    "preview" to PendingSessionSync("runtime-a", "session-1", "preview", "preview", "new"),
                ),
                pendingCommands = mapOf("preview" to "runtime-a"),
            ),
            """
              {"type":"runtime.event","runtimeId":"runtime-a","sequence":1,"event":{
                "type":"session.snapshot","sessionId":"session-1","syncId":"preview","mode":"replace",
                "range":"preview","targetLeafId":"new","complete":false,
                "cursor":{"leafId":"new"},"entries":[
                  {"entryId":"new","parentId":"root","type":"message","timestamp":"3","data":{"message":{"role":"assistant","content":"new"}}}
                ]
              }}
            """.trimIndent(),
        )

        assertEquals("new", switched.runtimeSessionViews["runtime-a"]?.leafId)
        assertEquals(listOf("root", "new"), switched.conversations["runtime-a"]?.messages?.map(ChatMessage::messageId))
        assertFalse(switched.conversations["runtime-a"]?.messages?.any { it.messageId == "old" } == true)
    }

    @Test
    fun `preview snapshots enter the canonical tree and adopt the runtime live leaf`() {
        val pending = PendingSessionSync(
            runtimeId = "runtime-a",
            sessionId = "session-1",
            syncId = "preview-1",
            range = "preview",
            targetLeafId = "leaf",
        )
        val initial = RemoteState(
            selectedRuntimeId = "runtime-a",
            runtimes = mapOf(
                "runtime-a" to RuntimeSummary(
                    "runtime-a", "A", "/a", "idle", "session-1",
                    sessionGraphSync = true,
                    sessionLeafId = "leaf",
                ),
            ),
            sessionSyncCommands = mapOf("preview-command" to pending),
            pendingCommands = mapOf("preview-command" to "runtime-a"),
        )

        val changed = reducer.reduce(initial, """
          {"type":"runtime.event","runtimeId":"runtime-a","sequence":1,"event":{
            "type":"session.snapshot","sessionId":"session-1","syncId":"preview-1","mode":"replace",
            "range":"preview","targetLeafId":"leaf","complete":true,
            "cursor":{"leafId":"leaf"},"entries":[
              {"entryId":"root","parentId":null,"type":"message","timestamp":"1","data":{"message":{"role":"user","content":"root"}}},
              {"entryId":"leaf","parentId":"root","type":"message","timestamp":"2","data":{"message":{"role":"assistant","content":"preview"}}}
            ]
          }}
        """.trimIndent())

        assertEquals(setOf("root", "leaf"), changed.sessionGraphs["session-1"]?.entries?.keys)
        assertTrue(changed.sessions["session-1"]?.hasHistoryCache == true)
        assertEquals(listOf("root", "leaf"), changed.conversations["runtime-a"]?.messages?.map(ChatMessage::messageId))

        // The device caches sessionLeafId from metadata. A long turn or a Pi tree navigation can
        // leave it behind; a preview must report and adopt the Runtime's current leaf so the app
        // does not keep replaying a stale (possibly empty) branch.
        val staleTarget = reducer.reduce(
            RemoteState(
                selectedRuntimeId = "runtime-a",
                runtimes = mapOf(
                    "runtime-a" to RuntimeSummary(
                        "runtime-a", "A", "/a", "idle", "session-1",
                        sessionGraphSync = true,
                        sessionLeafId = "old",
                    ),
                ),
                conversations = mapOf(
                    "runtime-a" to RuntimeConversation(
                        messages = listOf(ChatMessage("old", "user", listOf(RemoteContent("text", "old")), 1)),
                    ),
                ),
                runtimeSessionViews = mapOf("runtime-a" to RuntimeSessionView("runtime-a", "session-1", "old")),
                sessionSyncCommands = mapOf(
                    "preview-1" to PendingSessionSync(
                        runtimeId = "runtime-a",
                        sessionId = "session-1",
                        syncId = "preview-sync",
                        range = "preview",
                        targetLeafId = null,
                    ),
                ),
                pendingCommands = mapOf("preview-1" to "runtime-a"),
            ),
            """
              {"type":"runtime.event","runtimeId":"runtime-a","sequence":1,"event":{
                "type":"session.snapshot","sessionId":"session-1","syncId":"preview-sync","mode":"replace",
                "range":"preview","targetLeafId":"live","complete":true,"hasOlder":true,"cursor":{"leafId":"live"},
                "entries":[
                  {"entryId":"old","parentId":null,"type":"message","timestamp":"1","data":{"message":{"role":"user","content":"old"}}},
                  {"entryId":"live","parentId":"old","type":"message","timestamp":"2","data":{"message":{"role":"assistant","content":"live"}}}
                ]
              }}
            """.trimIndent(),
        )

        assertEquals("live", staleTarget.runtimes["runtime-a"]?.sessionLeafId)
        assertEquals(listOf("old", "live"), staleTarget.conversations["runtime-a"]?.messages?.map(ChatMessage::messageId))
        assertEquals(null, staleTarget.conversations["runtime-a"]?.chatSyncError)
    }

    @Test
    fun `history snapshots cache entries without losing the current conversation`() {
        val initial = RemoteState(
            selectedRuntimeId = "runtime-a",
            runtimes = mapOf(
                "runtime-a" to RuntimeSummary(
                    "runtime-a", "A", "/a", "idle", "session-1",
                    sessionGraphSync = true,
                    sessionLeafId = "new",
                ),
            ),
            conversations = mapOf(
                "runtime-a" to RuntimeConversation(
                    messages = listOf(
                        ChatMessage("new", "assistant", listOf(RemoteContent("text", "new")), 2),
                    ),
                    hasLiveSnapshot = true,
                ),
            ),
            runtimeSessionViews = mapOf("runtime-a" to RuntimeSessionView("runtime-a", "session-1", "new")),
            sessionHistory = mapOf(
                "runtime-a" to SessionHistoryState("session-1", "new", "new", hasOlder = true, loading = true, requestId = "history-command"),
            ),
            sessionSyncCommands = mapOf(
                "history-command" to PendingSessionSync(
                    runtimeId = "runtime-a",
                    sessionId = "session-1",
                    syncId = "history-1",
                    range = "history",
                    targetLeafId = "new",
                    beforeEntryId = "new",
                ),
            ),
            pendingCommands = mapOf("history-command" to "runtime-a"),
        )

        val changed = reducer.reduce(initial, """
          {"type":"runtime.event","runtimeId":"runtime-a","sequence":1,"event":{
            "type":"session.snapshot","sessionId":"session-1","syncId":"history-1","mode":"prepend",
            "range":"history","targetLeafId":"new","beforeEntryId":"new","complete":true,"hasOlder":false,
            "cursor":{"leafId":"new"},"entries":[
              {"entryId":"old","parentId":null,"type":"message","timestamp":"1","data":{"message":{"role":"user","content":"old"}}}
            ]
          }}
        """.trimIndent())

        assertEquals(setOf("old"), changed.sessionGraphs["session-1"]?.entries?.keys)
        assertEquals(listOf("old", "new"), changed.conversations["runtime-a"]?.messages?.map(ChatMessage::messageId))
        assertEquals("old", changed.sessionHistory["runtime-a"]?.oldestEntryId)
        assertEquals(false, changed.sessionHistory["runtime-a"]?.loading)
        assertEquals(null, changed.sessionHistory["runtime-a"]?.requestId)
    }

    @Test
    fun `history snapshots prepend without overwriting a live tail that advanced during the round trip`() {
        // History is anchored to the display leaf the user is reading. A newer live tail does not
        // invalidate older entries, and treating it as stale strands the paging request.
        val initial = RemoteState(
            selectedRuntimeId = "runtime-a",
            runtimes = mapOf(
                "runtime-a" to RuntimeSummary(
                    "runtime-a", "A", "/a", "idle", "session-1",
                    sessionGraphSync = true,
                    sessionLeafId = "newer",
                ),
            ),
            conversations = mapOf(
                "runtime-a" to RuntimeConversation(
                    messages = listOf(
                        ChatMessage("new", "assistant", listOf(RemoteContent("text", "new")), 2),
                    ),
                    hasLiveSnapshot = true,
                ),
            ),
            runtimeSessionViews = mapOf("runtime-a" to RuntimeSessionView("runtime-a", "session-1", "new")),
            sessionHistory = mapOf(
                "runtime-a" to SessionHistoryState("session-1", "new", "new", hasOlder = true, loading = true, requestId = "history-command"),
            ),
            sessionSyncCommands = mapOf(
                "history-command" to PendingSessionSync(
                    runtimeId = "runtime-a",
                    sessionId = "session-1",
                    syncId = "history-1",
                    range = "history",
                    targetLeafId = "new",
                    beforeEntryId = "new",
                ),
            ),
            pendingCommands = mapOf("history-command" to "runtime-a"),
        )

        val changed = reducer.reduce(initial, """
          {"type":"runtime.event","runtimeId":"runtime-a","sequence":1,"event":{
            "type":"session.snapshot","sessionId":"session-1","syncId":"history-1","mode":"prepend",
            "range":"history","targetLeafId":"new","beforeEntryId":"new","complete":true,"hasOlder":false,
            "cursor":{"leafId":"new"},"entries":[
              {"entryId":"old","parentId":null,"type":"message","timestamp":"1","data":{"message":{"role":"user","content":"old"}}}
            ]
          }}
        """.trimIndent())

        assertEquals(listOf("old", "new"), changed.conversations["runtime-a"]?.messages?.map(ChatMessage::messageId))
        assertEquals("old", changed.sessionHistory["runtime-a"]?.oldestEntryId)
        assertEquals(false, changed.sessionHistory["runtime-a"]?.loading)
        assertEquals(null, changed.sessionHistory["runtime-a"]?.requestId)
        assertEquals(null, changed.conversations["runtime-a"]?.chatSyncError)

        val streaming = reducer.reduce(
            RemoteState(
                selectedRuntimeId = "runtime-a",
                runtimes = mapOf(
                    "runtime-a" to RuntimeSummary(
                        "runtime-a", "A", "/a", "idle", "session-1",
                        sessionGraphSync = true,
                        sessionLeafId = "live",
                    ),
                ),
                conversations = mapOf(
                    "runtime-a" to RuntimeConversation(
                        messages = listOf(
                            ChatMessage("new", "assistant", listOf(RemoteContent("text", "new")), 2),
                            ChatMessage("live", "assistant", listOf(RemoteContent("text", "live")), 3),
                        ),
                        streamingMessageIds = setOf("live"),
                        hasLiveSnapshot = true,
                    ),
                ),
                runtimeSessionViews = mapOf("runtime-a" to RuntimeSessionView("runtime-a", "session-1", "new")),
                sessionHistory = mapOf(
                    "runtime-a" to SessionHistoryState("session-1", "new", "new", hasOlder = true, loading = true, requestId = "history-command"),
                ),
                sessionSyncCommands = mapOf(
                    "history-command" to PendingSessionSync(
                        runtimeId = "runtime-a",
                        sessionId = "session-1",
                        syncId = "history-1",
                        range = "history",
                        targetLeafId = "new",
                        beforeEntryId = "new",
                    ),
                ),
                pendingCommands = mapOf("history-command" to "runtime-a"),
            ),
            """
              {"type":"runtime.event","runtimeId":"runtime-a","sequence":1,"event":{
                "type":"session.snapshot","sessionId":"session-1","syncId":"history-1","mode":"prepend",
                "range":"history","targetLeafId":"new","beforeEntryId":"new","complete":true,"hasOlder":false,
                "cursor":{"leafId":"new"},"entries":[
                  {"entryId":"old","parentId":null,"type":"message","timestamp":"1","data":{"message":{"role":"user","content":"old"}}}
                ]
              }}
            """.trimIndent(),
        )

        val ids = streaming.conversations["runtime-a"]?.messages?.map(ChatMessage::messageId)
        assertEquals(listOf("old", "new", "live"), ids)
        assertEquals(setOf("live"), streaming.conversations["runtime-a"]?.streamingMessageIds)
        assertEquals(false, streaming.sessionHistory["runtime-a"]?.loading)
    }

    @Test
    fun `persisted session entries are the projection source`() {
        val pending = PendingSessionSync("runtime-a", "session-1", "sync-1", "preview", "leaf")
        val initial = RemoteState(
            runtimes = mapOf("runtime-a" to RuntimeSummary("runtime-a", "A", "/a", "idle", "session-1", sessionGraphSync = true, sessionLeafId = "leaf")),
            sessionSyncCommands = mapOf("command" to pending),
            pendingCommands = mapOf("command" to "runtime-a"),
        )
        val persisted = SessionGraphEntry(
            "leaf", null, "message", "1", buildJsonObject {
            put("message", buildJsonObject { put("role", "assistant"); put("content", "persisted") })
        })
        val payload = """
          {"type":"runtime.event","runtimeId":"runtime-a","sequence":1,"event":{
            "type":"session.snapshot","sessionId":"session-1","syncId":"sync-1","mode":"replace",
            "range":"preview","targetLeafId":"leaf","complete":true,"cursor":{"leafId":"leaf"},
            "entries":[{"entryId":"leaf","parentId":null,"type":"message","timestamp":"1","data":{"message":{"role":"assistant","content":"wire"}}}]
          }}
        """.trimIndent()

        val changed = reducer.reduce(initial, payload, listOf(persisted))

        assertEquals("persisted", changed.conversations["runtime-a"]?.messages?.single()?.content?.single()?.text)
    }

    @Test
    fun `catchup persistence requires the same pending command and fixed target`() {
        val pending = PendingSessionSync(
            runtimeId = "runtime-a",
            sessionId = "session-1",
            syncId = "sync-1",
            range = "catchup",
            targetLeafId = "target-leaf",
            knownLeafId = "frontier",
        )
        val owned = RemoteState(
            runtimes = mapOf(
                "runtime-a" to RuntimeSummary(
                    "runtime-a", "A", "/a", "idle", "session-1",
                    sessionGraphSync = true,
                    sessionLeafId = "target-leaf",
                ),
            ),
            sessionSyncCommands = mapOf("command-1" to pending),
        )

        assertTrue(owned.ownsSessionSnapshot(
            commandId = "command-1",
            runtimeId = "runtime-a",
            sessionId = "session-1",
            syncId = "sync-1",
            targetLeafId = "target-leaf",
        ))
        assertFalse(owned.copy(sessionSyncCommands = emptyMap()).ownsSessionSnapshot(
            commandId = "command-1",
            runtimeId = "runtime-a",
            sessionId = "session-1",
            syncId = "sync-1",
            targetLeafId = "target-leaf",
        ))
        assertTrue(owned.copy(
            runtimes = mapOf(
                "runtime-a" to owned.runtimes.getValue("runtime-a").copy(sessionLeafId = "new-leaf"),
            ),
        ).ownsSessionSnapshot(
            commandId = "command-1",
            runtimeId = "runtime-a",
            sessionId = "session-1",
            syncId = "sync-1",
            targetLeafId = "target-leaf",
        ))
    }

    @Test
    fun `snapshot from a previous session cannot populate the current graph`() {
        val initial = RemoteState(
            selectedRuntimeId = "runtime-a",
            runtimes = mapOf(
                "runtime-a" to RuntimeSummary(
                    "runtime-a", "A", "/a", "idle", "session-new",
                    sessionGraphSync = true,
                    sessionLeafId = "new-leaf",
                ),
            ),
            conversations = mapOf(
                "runtime-a" to RuntimeConversation(
                    messages = listOf(ChatMessage("new-live", "assistant", emptyList(), 2)),
                    hasLiveSnapshot = true,
                ),
            ),
            sessionSyncCommands = mapOf(
                "old-command" to PendingSessionSync(
                    runtimeId = "runtime-a",
                    sessionId = "session-old",
                    syncId = "old-sync",
                    targetLeafId = "old-leaf",
                ),
            ),
            pendingCommands = mapOf("old-command" to "runtime-a"),
        )

        val changed = reducer.reduce(initial, """
          {"type":"runtime.event","runtimeId":"runtime-a","sequence":1,"event":{
            "type":"session.snapshot","sessionId":"session-old","syncId":"old-sync","mode":"replace",
            "range":"catchup","targetLeafId":"old-leaf","complete":true,
            "cursor":{"leafId":"old-leaf"},"entries":[
              {"entryId":"old-leaf","parentId":null,"type":"message","timestamp":"1","data":{"message":{"role":"assistant","content":"old"}}}
            ]
          }}
        """.trimIndent())

        assertTrue(changed.sessionGraphs.isEmpty())
        assertTrue(changed.sessions.isEmpty())
        assertEquals(listOf("new-live"), changed.conversations["runtime-a"]?.messages?.map(ChatMessage::messageId))
        assertTrue("old-command" !in changed.pendingCommands)
        assertTrue(changed.sessionSyncCommands.isEmpty())
    }

    @Test
    fun `snapshot from a previous branch cannot populate the current branch`() {
        val initial = RemoteState(
            sessionBranchGenerations = mapOf("runtime-a" to 1),
            selectedRuntimeId = "runtime-a",
            runtimes = mapOf(
                "runtime-a" to RuntimeSummary(
                    "runtime-a", "A", "/a", "idle", "session-1",
                    sessionGraphSync = true,
                    sessionLeafId = "new-leaf",
                ),
            ),
            conversations = mapOf(
                "runtime-a" to RuntimeConversation(
                    messages = listOf(ChatMessage("new-live", "assistant", emptyList(), 2)),
                    hasLiveSnapshot = true,
                ),
            ),
            sessionSyncCommands = mapOf(
                "old-command" to PendingSessionSync(
                    runtimeId = "runtime-a",
                    sessionId = "session-1",
                    syncId = "old-sync",
                    targetLeafId = "old-leaf",
                ),
            ),
            pendingCommands = mapOf("old-command" to "runtime-a"),
        )

        val changed = reducer.reduce(initial, """
          {"type":"runtime.event","runtimeId":"runtime-a","sequence":1,"event":{
            "type":"session.snapshot","sessionId":"session-1","syncId":"old-sync","mode":"replace",
            "range":"catchup","targetLeafId":"old-leaf","complete":true,
            "cursor":{"leafId":"old-leaf"},"entries":[
              {"entryId":"old-leaf","parentId":null,"type":"message","timestamp":"1","data":{"message":{"role":"assistant","content":"old"}}}
            ]
          }}
        """.trimIndent())

        // Previously committed old-branch nodes may remain canonical, but an in-flight response
        // that lost branch ownership must not add new nodes after the Runtime switched branches.
        assertTrue(changed.sessionGraphs.isEmpty())
        assertEquals(null, changed.runtimeSessionViews["runtime-a"])
        assertEquals(listOf("new-live"), changed.conversations["runtime-a"]?.messages?.map(ChatMessage::messageId))
        assertTrue("old-command" !in changed.pendingCommands)
        assertTrue(changed.sessionSyncCommands.isEmpty())
        assertTrue("runtime-a" in changed.sessionSyncRequests)
    }

    @Test
    fun `overlay correlation matches persisted entries by identity instead of text`() {
        val persisted = listOf(
            ChatMessage("root", "user", listOf(RemoteContent("text", "repeat")), 1),
            ChatMessage("old", "user", listOf(RemoteContent("text", "repeat")), 2),
            ChatMessage("next", "assistant", listOf(RemoteContent("text", "answer")), 3),
        )
        val overlay = ChatMessage("live", "user", listOf(RemoteContent("text", "repeat")), 3)
        val (messages, overlays) = mergeProjectedWithStreaming(
            persisted,
            RuntimeConversation(
                messages = persisted + overlay,
                streamingMessageIds = setOf("live"),
            ),
        )

        assertEquals(listOf("root", "old", "next", "live"), messages.map(ChatMessage::messageId))
        assertEquals(setOf("live"), overlays)

        val assistantPersisted = listOf(
            ChatMessage("assistant-entry", "assistant", listOf(RemoteContent("text", "answer")), 5),
        )
        val assistantOverlay = ChatMessage("assistant-live", "assistant", listOf(RemoteContent("text", "answer")), 4)
        val (assistantMessages, assistantOverlays) = mergeProjectedWithStreaming(
            assistantPersisted,
            RuntimeConversation(
                messages = listOf(assistantOverlay),
                streamingMessageIds = setOf("assistant-live"),
            ),
        )

        assertEquals(listOf("assistant-entry"), assistantMessages.map(ChatMessage::messageId))
        assertTrue(assistantOverlays.isEmpty())
    }

    @Test
    fun `overlay correlation tolerates an unavailable persisted timestamp`() {
        val persisted = ChatMessage(
            "entry-user",
            "user",
            listOf(RemoteContent("text", "same")),
            0,
        )
        val overlay = ChatMessage(
            "live-user",
            "user",
            listOf(RemoteContent("text", "same")),
            System.currentTimeMillis(),
        )

        val (messages, overlays) = mergeProjectedWithStreaming(
            listOf(persisted),
            RuntimeConversation(
                messages = listOf(overlay),
                streamingMessageIds = setOf("live-user"),
            ),
        )

        assertEquals(listOf("entry-user"), messages.map(ChatMessage::messageId))
        assertTrue(overlays.isEmpty())
    }

    @Test
    fun `a streamed reply reconciles with its persisted entry through the published id mapping`() {
        var state = liveTurnState()
        state = state.reduceEvents(
            liveEvent(1, """{"type":"turn.started","turnId":"t1","startedAt":2000,"turnIndex":0}"""),
            liveEvent(2, LIVE_TURN_STARTED_EVENT),
            liveEvent(3, liveDelta("thinking", "reasoned")),
            liveEvent(4, liveDelta("text", "answer")),
            liveEvent(5, liveDelta("text", " with an extra fragment")),
            liveEvent(6, LIVE_TURN_FINISHED_EVENT),
            // A replayed delta arrives after the stream already ended.
            liveEvent(7, liveDelta("thinking", " (replayed)")),
            liveEvent(8, LIVE_TURN_COMPLETED_EVENT),
        )
        state = state.awaitSessionSnapshot()

        val conversation = state.conversations.getValue("runtime-a")
        // The streamed row still carries more text than the persisted entry, which is exactly the
        // case content matching had to guess at; the published mapping pairs them by id instead.
        assertEquals(
            listOf("previous-entry", "user-entry", "assistant-entry"),
            conversation.messages.map(ChatMessage::messageId),
        )
        assertTrue(conversation.streamingMessageIds.isEmpty())
    }

    @Test
    fun `a runtime without the id mapping still reconciles through persistedMessageId`() {
        var state = liveTurnState()
        state = state.reduceEvents(
            liveEvent(1, """{"type":"turn.started","turnId":"t1","startedAt":2000,"turnIndex":0}"""),
            liveEvent(2, LIVE_TURN_STARTED_EVENT),
            liveEvent(3, liveDelta("thinking", "reasoned")),
            liveEvent(4, liveDelta("text", "answer with an extra fragment")),
            liveEvent(5, LIVE_TURN_FINISHED_EVENT),
            liveEvent(6, LIVE_TURN_COMPLETED_LEGACY_EVENT),
        )
        state = state.awaitSessionSnapshot()

        assertEquals(
            listOf("previous-entry", "user-entry", "assistant-entry"),
            state.conversations.getValue("runtime-a").messages.map(ChatMessage::messageId),
        )
    }

    @Test
    fun `a live row that lost its streaming identity is not re-attached beside its persisted twin`() {
        val state = liveTurnState()
        val base = state.conversations.getValue("runtime-a")

        // Same role, same finalized content and not older than the entry: this is assistant-entry
        // under its temporary id. Re-attaching it beside the projection would render the reply twice.
        val detached = ChatMessage(
            "assistant-live", "assistant",
            listOf(RemoteContent("thinking", "reasoned"), RemoteContent("text", "answer")),
            2_000,
        )

        val attached = state.copy(
            conversations = mapOf("runtime-a" to base.copy(messages = base.messages + detached)),
            lastSequence = mapOf("runtime-a" to 0L),
        ).awaitSessionSnapshot()

        assertEquals(
            listOf("previous-entry", "user-entry", "assistant-entry"),
            attached.conversations.getValue("runtime-a").messages.map(ChatMessage::messageId),
        )
    }

    private fun liveDelta(contentType: String, delta: String) = """
      {"type":"message.delta","messageId":"assistant-live","contentType":"$contentType","delta":"$delta"}
    """.trimIndent()

    private val LIVE_TURN_STARTED_EVENT = """
      {"type":"message.started","message":{"messageId":"assistant-live","role":"assistant","content":[],"timestamp":2000}}
    """.trimIndent()

    private val LIVE_TURN_FINISHED_EVENT = """
      {"type":"message.finished","message":{"messageId":"assistant-live","role":"assistant",
        "content":[{"type":"thinking","text":"reasoned"},{"type":"text","text":"answer with an extra fragment"}],
        "timestamp":2000}}
    """.trimIndent()

    /** The Runtime publishes the entry id it resolved for every message the turn persisted. */
    private val LIVE_TURN_COMPLETED_EVENT = """
      {"type":"turn.finished","turnId":"t1","startedAt":2000,"durationMs":900,
        "messageId":"assistant-live","persistedMessages":[
          {"messageId":"user-live","entryId":"user-entry"},
          {"messageId":"assistant-live","entryId":"assistant-entry"}]}
    """.trimIndent()

    /** Runtimes that predate `persistedMessages` only announce the assistant entry. */
    private val LIVE_TURN_COMPLETED_LEGACY_EVENT = """
      {"type":"turn.finished","turnId":"t1","startedAt":2000,"durationMs":900,
        "messageId":"assistant-live","persistedMessageId":"assistant-entry"}
    """.trimIndent()

    private fun liveEntry(
        entryId: String,
        parentId: String?,
        role: String,
        text: String,
        timestamp: Long,
        thinking: String? = null,
    ) = SessionGraphEntry(
        entryId = entryId,
        parentId = parentId,
        type = "message",
        timestamp = "2026-09-10T09:00:00.000Z",
        data = buildJsonObject {
            put("message", buildJsonObject {
                put("role", role)
                put("timestamp", timestamp)
                put("content", buildJsonArray {
                    thinking?.let {
                        add(buildJsonObject { put("type", "thinking"); put("thinking", it) })
                    }
                    add(buildJsonObject { put("type", "text"); put("text", text) })
                })
            })
        },
    )

    private fun liveEvent(sequence: Int, body: String) = """
      {"type":"runtime.event","runtimeId":"runtime-a","sequence":$sequence,"event":$body}
    """.trimIndent()

    /** A runtime whose graph, view and conversation stop at the previous assistant message. */
    private fun liveTurnState(): RemoteState {
        val previous = liveEntry("previous-entry", null, "assistant", "previous answer", 500)
        val graph = SessionGraph(
            sessionId = "session-1",
            entries = mapOf(previous.entryId to previous),
            cursor = SessionBranchCursor(previous.entryId),
        )
        return RemoteState(
            selectedRuntimeId = "runtime-a",
            runtimes = mapOf(
                "runtime-a" to RuntimeSummary(
                    "runtime-a", "A", "/a", "running", "session-1",
                    sessionGraphSync = true,
                    sessionLeafId = previous.entryId,
                ),
            ),
            runtimeSessionViews = mapOf(
                "runtime-a" to RuntimeSessionView("runtime-a", "session-1", previous.entryId),
            ),
            sessionGraphs = mapOf("session-1" to graph),
            conversations = mapOf(
                "runtime-a" to RuntimeConversation(messages = projectSessionGraph(graph).messages),
            ),
            lastSequence = mapOf("runtime-a" to 0L),
        )
    }

    private fun RemoteState.reduceEvents(vararg payloads: String): RemoteState =
        payloads.fold(this) { current, payload -> reducer.reduce(current, payload) }

    /** Persists the turn's entries the way the forward catch-up round does, then reduces it. */
    private fun RemoteState.awaitSessionSnapshot(): RemoteState {
        val graph = sessionGraphs.getValue("session-1")
        val user = liveEntry("user-entry", "previous-entry", "user", "为什么", 1_000)
        val assistant = liveEntry(
            "assistant-entry", "user-entry", "assistant", "answer", 2_000,
            thinking = "reasoned",
        )
        val prepared = copy(
            sessionSyncCommands = sessionSyncCommands + (
                "cmd-1" to PendingSessionSync(
                    runtimeId = "runtime-a",
                    sessionId = "session-1",
                    syncId = "sync-1",
                    range = "catchup",
                    targetLeafId = "assistant-entry",
                )
                ),
            runtimes = mapOf(
                "runtime-a" to runtimes.getValue("runtime-a").copy(
                    status = "idle",
                    sessionLeafId = "assistant-entry",
                ),
            ),
            sessionGraphs = sessionGraphs + (
                "session-1" to graph.copy(
                    entries = graph.entries + (user.entryId to user) + (assistant.entryId to assistant),
                )
                ),
        )
        val metadata = """
          {"type":"runtime.event","runtimeId":"runtime-a","sequence":90,"event":{
            "type":"runtime.metadata","metadata":{"runtimeId":"runtime-a","name":"A","cwd":"/a",
              "status":"idle","sessionId":"session-1","sessionLeafId":"assistant-entry"}}}
        """.trimIndent()
        val snapshot = """
          {"type":"runtime.event","runtimeId":"runtime-a","sequence":91,"event":{
            "type":"session.snapshot","sessionId":"session-1","syncId":"sync-1","mode":"append",
            "range":"catchup","targetLeafId":"assistant-entry","cursor":{"leafId":"assistant-entry"},
            "entries":[
              {"entryId":"user-entry","parentId":"previous-entry","type":"message",
               "timestamp":"2026-09-10T09:00:00.000Z",
               "data":{"message":{"role":"user","timestamp":1000,"content":[{"type":"text","text":"为什么"}]}}},
              {"entryId":"assistant-entry","parentId":"user-entry","type":"message",
               "timestamp":"2026-09-10T09:00:01.000Z",
               "data":{"message":{"role":"assistant","timestamp":2000,"content":[{"type":"thinking","thinking":"reasoned"},{"type":"text","text":"answer"}]}}}
            ]}}
        """.trimIndent()
        return reducer.reduce(reducer.reduce(prepared, metadata), snapshot)
    }

    @Test
    fun `a delta without a start keeps the live response visible`() {
        var state = reducer.reduce(RemoteState(
            runtimes = mapOf("runtime-a" to RuntimeSummary("runtime-a", "A", "/a", "running", "session-1")),
        ), """
          {"type":"runtime.event","runtimeId":"runtime-a","sequence":1,"event":{
            "type":"message.delta","messageId":"assistant-live","contentType":"text","delta":"hel"
          }}
        """.trimIndent())
        state = reducer.reduce(state, """
          {"type":"runtime.event","runtimeId":"runtime-a","sequence":2,"event":{
            "type":"message.delta","messageId":"assistant-live","contentType":"text","delta":"lo"
          }}
        """.trimIndent())

        assertEquals(listOf("assistant-live"), state.conversations["runtime-a"]?.messages?.map(ChatMessage::messageId))
        assertEquals("hello", state.conversations["runtime-a"]?.messages?.single()?.content?.single()?.text)
        assertEquals(setOf("assistant-live"), state.conversations["runtime-a"]?.streamingMessageIds)
    }

    @Test
    fun `streamed tool-call arguments stay out of the assistant prose`() {
        // Pi streams a tool call as `toolcall_delta` fragments. They belong in their own tool_call
        // block; concatenating them onto the assistant text renders the answer with argument JSON
        // glued to its tail until the finalized message replaces the live row.
        var state = reducer.reduce(RemoteState(
            runtimes = mapOf("runtime-a" to RuntimeSummary("runtime-a", "A", "/a", "running", "session-1")),
        ), """
          {"type":"runtime.event","runtimeId":"runtime-a","sequence":1,"event":{
            "type":"message.started","message":{"messageId":"assistant-live","role":"assistant","content":[],"timestamp":1}
          }}
        """.trimIndent())
        state = reducer.reduce(state, """
          {"type":"runtime.event","runtimeId":"runtime-a","sequence":2,"event":{
            "type":"message.delta","messageId":"assistant-live","contentType":"text","delta":"let me check"
          }}
        """.trimIndent())
        state = reducer.reduce(state, """
          {"type":"runtime.event","runtimeId":"runtime-a","sequence":3,"event":{
            "type":"message.delta","messageId":"assistant-live","contentType":"tool_call","contentIndex":1,"delta":"{\"path\":"
          }}
        """.trimIndent())
        state = reducer.reduce(state, """
          {"type":"runtime.event","runtimeId":"runtime-a","sequence":4,"event":{
            "type":"message.delta","messageId":"assistant-live","contentType":"tool_call","contentIndex":1,"delta":"\"a.txt\"}"
          }}
        """.trimIndent())

        val content = state.conversations.getValue("runtime-a").messages.single().content
        assertEquals(listOf("text", "tool_call"), content.map(RemoteContent::type))
        assertEquals("let me check", content[0].text)
        assertEquals("{\"path\":\"a.txt\"}", content[1].text)
    }

    @Test
    fun `snapshot replaces a runtime conversation and duplicate sequence is ignored`() {
        val ready = """{
          "type":"device.ready","deviceId":"phone-1","runtimes":[
            {"runtimeId":"runtime-a","name":"A","cwd":"/a","status":"idle","sessionId":"same","hostname":"devbox","sessionName":"API refactor"}
          ]
        }""".trimIndent()
        val snapshot = """{
          "type":"runtime.event","runtimeId":"runtime-a","sequence":1,"event":{
            "type":"message.started","message":{
              "messageId":"m1","role":"user","content":[{"type":"text","text":"hello"}],"timestamp":1
            }
          }
        }""".trimIndent()
        val duplicate = """{
          "type":"runtime.event","runtimeId":"runtime-a","sequence":1,"event":{
            "type":"message.delta","messageId":"m1","contentType":"text","delta":" duplicate"
          }
        }""".trimIndent()

        var state = reducer.reduce(reducer.reduce(reducer.reduce(RemoteState(), ready, channel = "ctl"), snapshot), duplicate)
        assertEquals("hello", state.conversations["runtime-a"]?.messages?.single()?.content?.single()?.text)
        assertEquals("devbox", state.runtimes["runtime-a"]?.hostname)
        assertEquals("API refactor", state.runtimes["runtime-a"]?.sessionName)

        state = state.copy(pendingCommands = mapOf("command-1" to "runtime-a"))
        state = reducer.reduce(state, """{
          "type":"runtime.event","runtimeId":"runtime-a","sequence":2,"event":{
            "type":"command.result","commandId":"command-1","ok":true
          }
        }""".trimIndent())
        assertFalse(state.pendingCommands.containsKey("command-1"))
        assertEquals(true, state.commandResults["command-1"]?.ok)
    }

    @Test
    fun `session replacement starts a fresh loading epoch`() {
        val initial = RemoteState(
            selectedRuntimeId = "runtime-a",
            runtimes = mapOf("runtime-a" to RuntimeSummary("runtime-a", "A", "/a", "idle", "old", sessionGraphSync = true)),
            conversations = mapOf(
                "runtime-a" to RuntimeConversation(
                    messages = listOf(ChatMessage("old-message", "user", emptyList(), 1)),
                    hasLiveSnapshot = true,
                ),
            ),
            capabilities = mapOf("runtime-a" to RuntimeCapabilities(listOf(RuntimeSlashCommand("old", source = "builtin")))),
            lastSequence = mapOf("runtime-a" to 20),
        )

        val replacement = reducer.reduce(initial, """
          {"type":"runtime.online","runtime":{
            "runtimeId":"runtime-a","name":"A","cwd":"/a","status":"idle","sessionId":"new","sessionGraphSync":true
          }}
        """.trimIndent())

        assertTrue(replacement.conversations["runtime-a"]?.messages?.isEmpty() == true)
        assertTrue(replacement.conversations["runtime-a"]?.isChatSyncing == true)
        assertTrue(replacement.runtimes["runtime-a"]?.sessionGraphSync == true)
        assertTrue("runtime-a" !in replacement.capabilities)
        assertTrue("runtime-a" !in replacement.lastSequence)
    }

    @Test
    fun `leaf changes invalidate old session sync and clear the old branch view`() {
        val initial = RemoteState(
            selectedRuntimeId = "runtime-a",
            runtimes = mapOf(
                "runtime-a" to RuntimeSummary(
                    "runtime-a",
                    "A",
                    "/a",
                    "idle",
                    "session-1",
                    sessionGraphSync = true,
                    sessionLeafId = "old-leaf",
                ),
            ),
            conversations = mapOf(
                "runtime-a" to RuntimeConversation(
                    messages = listOf(ChatMessage("old-leaf", "assistant", emptyList(), 1)),
                    hasLiveSnapshot = true,
                ),
            ),
            runtimeSessionViews = mapOf("runtime-a" to RuntimeSessionView("runtime-a", "session-1", "old-leaf")),
            sessionGraphs = mapOf(
                "session-1" to SessionGraph(
                    "session-1",
                    entries = listOf(
                        SessionGraphEntry("root", null, "message", "1"),
                        SessionGraphEntry("old-leaf", "root", "message", "2"),
                        SessionGraphEntry("new-leaf", "root", "message", "3"),
                    ).associateBy(SessionGraphEntry::entryId),
                    cursor = SessionBranchCursor("old-leaf"),
                ),
            ),
            sessionSyncCommands = mapOf(
                "old-sync" to PendingSessionSync(
                    "runtime-a",
                    "session-1",
                    "sync-old",
                    targetLeafId = "old-leaf",
                ),
            ),
            pendingCommands = mapOf("old-sync" to "runtime-a"),
        )

        val changed = reducer.reduce(initial, """
          {"type":"runtime.event","runtimeId":"runtime-a","sequence":1,"event":{
            "type":"runtime.metadata","metadata":{
              "runtimeId":"runtime-a","name":"A","cwd":"/a","status":"idle",
              "sessionId":"session-1","sessionGraphSync":true,"sessionLeafId":"new-leaf"
            }
          }}
        """.trimIndent())

        assertTrue("old-sync" !in changed.pendingCommands)
        assertTrue(changed.sessionSyncCommands.isEmpty())
        assertEquals("new-leaf", changed.runtimeSessionViews["runtime-a"]?.leafId)
        assertTrue(changed.conversations["runtime-a"]?.messages?.isEmpty() == true)
    }

    @Test
    fun `unseen metadata leaf keeps the live conversation until catchup resolves it`() {
        val initial = RemoteState(
            selectedRuntimeId = "runtime-a",
            runtimes = mapOf(
                "runtime-a" to RuntimeSummary(
                    "runtime-a",
                    "A",
                    "/a",
                    "idle",
                    "session-1",
                    sessionGraphSync = true,
                    sessionLeafId = "old-leaf",
                ),
            ),
            conversations = mapOf(
                "runtime-a" to RuntimeConversation(
                    messages = listOf(ChatMessage("old-leaf", "assistant", emptyList(), 1)),
                    hasLiveSnapshot = true,
                ),
            ),
            runtimeSessionViews = mapOf("runtime-a" to RuntimeSessionView("runtime-a", "session-1", "old-leaf")),
        )

        val changed = reducer.reduce(initial, """
          {"type":"runtime.event","runtimeId":"runtime-a","sequence":1,"event":{
            "type":"runtime.metadata","metadata":{
              "runtimeId":"runtime-a","name":"A","cwd":"/a","status":"idle",
              "sessionId":"session-1","sessionGraphSync":true,"sessionLeafId":"new-leaf"
            }
          }}
        """.trimIndent())

        assertEquals(listOf("old-leaf"), changed.conversations["runtime-a"]?.messages?.map(ChatMessage::messageId))
        assertEquals("new-leaf", changed.runtimes["runtime-a"]?.sessionLeafId)
        assertEquals("old-leaf", changed.runtimeSessionViews["runtime-a"]?.leafId)
        assertTrue(changed.sessionSyncRequests.contains("runtime-a"))
    }

    @Test
    fun `sync protocol error ends loading with a runtime error`() {
        val loading = RemoteState(
            conversations = mapOf("runtime-a" to RuntimeConversation(isChatSyncing = true)),
            sessionSyncCommands = mapOf("sync-1" to PendingSessionSync(
                runtimeId = "runtime-a",
                sessionId = "session-1",
                syncId = "session-sync-1",
                range = "catchup",
                targetLeafId = "leaf",
            )),
        )
        val failed = reducer.reduce(loading, """
          {"type":"protocol.error","code":"runtime_offline","message":"offline","commandId":"sync-1"}
        """.trimIndent())

        assertTrue(failed.conversations["runtime-a"]?.isChatSyncing == false)
        assertEquals("目标运行实例已离线", failed.conversations["runtime-a"]?.chatSyncError)
        assertEquals("目标运行实例已离线", failed.error)
        assertTrue("sync-1" !in failed.sessionSyncCommands)
    }

    @Test
    fun `history protocol error releases paging without cancelling the forward catch-up`() {
        val state = RemoteState(
            selectedRuntimeId = "runtime-a",
            runtimes = mapOf(
                "runtime-a" to RuntimeSummary(
                    "runtime-a", "A", "/a", "idle", "session-1",
                    sessionGraphSync = true,
                    sessionLeafId = "new",
                ),
            ),
            sessionHistory = mapOf(
                "runtime-a" to SessionHistoryState("session-1", "new", "old", hasOlder = true, loading = true, requestId = "history-command"),
            ),
            sessionSyncCommands = mapOf(
                "history-command" to PendingSessionSync(
                    runtimeId = "runtime-a",
                    sessionId = "session-1",
                    syncId = "history-1",
                    range = "history",
                    targetLeafId = "new",
                    beforeEntryId = "old",
                ),
            ),
            pendingCommands = mapOf("history-command" to "runtime-a"),
            sessionSyncRequests = setOf("runtime-a"),
        )

        val failed = reducer.reduce(state, """
          {"type":"protocol.error","code":"invalid_message","message":"bad range","commandId":"history-command"}
        """.trimIndent())

        assertEquals(false, failed.sessionHistory["runtime-a"]?.loading)
        assertEquals(null, failed.sessionHistory["runtime-a"]?.requestId)
        assertTrue(failed.sessionSyncRequests.isEmpty())
        assertTrue("history-command" !in failed.sessionSyncCommands)
    }

    @Test
    fun `catch-up entry conflict preserves the local tree and reports a recoverable error`() {
        val conflicting = SessionGraphEntry(
            "root", null, "message", "1",
            buildJsonObject {
                put("message", buildJsonObject { put("role", "user"); put("content", "different") })
            },
        )
        val initial = RemoteState(
            selectedRuntimeId = "runtime-a",
            runtimes = mapOf(
                "runtime-a" to RuntimeSummary(
                    "runtime-a", "A", "/a", "idle", "session-1",
                    sessionGraphSync = true,
                    sessionLeafId = "leaf",
                ),
            ),
            sessionGraphs = mapOf(
                "session-1" to SessionGraph(
                    sessionId = "session-1",
                    entries = mapOf("root" to SessionGraphEntry(
                        "root", null, "message", "1",
                        buildJsonObject {
                            put("message", buildJsonObject { put("role", "user"); put("content", "old") })
                        },
                    )),
                    cursor = SessionBranchCursor("root"),
                ),
            ),
            runtimeSessionViews = mapOf("runtime-a" to RuntimeSessionView("runtime-a", "session-1", "leaf")),
            sessionHistory = mapOf(
                "runtime-a" to SessionHistoryState("session-1", "leaf", "root", hasOlder = false),
            ),
            sessionSyncCommands = mapOf(
                "catchup-1" to PendingSessionSync(
                    runtimeId = "runtime-a",
                    sessionId = "session-1",
                    syncId = "sync-1",
                    range = "catchup",
                    targetLeafId = "leaf",
                    knownLeafId = "root",
                ),
            ),
            pendingCommands = mapOf("catchup-1" to "runtime-a"),
        )

        val changed = reducer.reduce(initial, """
          {"type":"runtime.event","runtimeId":"runtime-a","sequence":1,"event":{
            "type":"session.snapshot","sessionId":"session-1","syncId":"sync-1","mode":"append",
            "range":"catchup","targetLeafId":"leaf","complete":true,"cursor":{"leafId":"leaf"},
            "entries":[
              {"entryId":"root","parentId":null,"type":"message","timestamp":"1","data":{"message":{"role":"user","content":"different"}}},
              {"entryId":"leaf","parentId":"root","type":"message","timestamp":"2","data":{"message":{"role":"assistant","content":"leaf"}}}
            ]
          }}
        """.trimIndent())

        assertEquals(initial.sessionGraphs, changed.sessionGraphs)
        assertEquals(initial.sessionHistory, changed.sessionHistory)
        assertFalse("runtime-a" in changed.sessionSyncRequests)
        assertTrue("catchup-1" !in changed.sessionSyncCommands)
        assertTrue(changed.conversations["runtime-a"]?.chatSyncError?.contains("entry_conflict") == true)
    }

    @Test
    fun `session graph conflicts are limited to entry and timing divergence`() {
        assertTrue(isSessionGraphConflict(SessionGraphStoreException("entry_conflict")))
        assertTrue(isSessionGraphConflict(SessionGraphStoreException("turn_timing_conflict")))
        assertFalse(isSessionGraphConflict(SessionGraphStoreException("stale_snapshot")))
        assertFalse(isSessionGraphConflict(IllegalStateException("entry_conflict")))
        assertFalse(isSessionGraphConflict(null))
    }

    @Test
    fun `forward snapshot retargets the paging leaf without rewinding the older boundary or dropping temporary messages`() {
        // The canonical tree only holds a bounded window. A catch-up round for the same leaf must
        // not rewind the history boundary to the window edge, and it must not drop the older
        // temporary messages that were paged in above the window.
        val initial = RemoteState(
            selectedRuntimeId = "runtime-a",
            runtimes = mapOf(
                "runtime-a" to RuntimeSummary(
                    "runtime-a", "A", "/a", "idle", "session-1",
                    sessionGraphSync = true,
                    sessionLeafId = "live",
                ),
            ),
            conversations = mapOf(
                "runtime-a" to RuntimeConversation(
                    messages = listOf(
                        ChatMessage("old", "user", listOf(RemoteContent("text", "old")), 1),
                        ChatMessage("mid", "assistant", listOf(RemoteContent("text", "mid")), 2),
                        ChatMessage("live", "user", listOf(RemoteContent("text", "live")), 3),
                    ),
                    hasLiveSnapshot = true,
                ),
            ),
            runtimeSessionViews = mapOf("runtime-a" to RuntimeSessionView("runtime-a", "session-1", "live")),
            sessionHistory = mapOf(
                "runtime-a" to SessionHistoryState("session-1", "live", "old", hasOlder = true),
            ),
            sessionSyncCommands = mapOf(
                "catchup-1" to PendingSessionSync(
                    runtimeId = "runtime-a",
                    sessionId = "session-1",
                    syncId = "sync-1",
                    range = "catchup",
                    targetLeafId = "live",
                    knownLeafId = "mid",
                ),
            ),
            pendingCommands = mapOf("catchup-1" to "runtime-a"),
        )

        val changed = reducer.reduce(initial, """
          {"type":"runtime.event","runtimeId":"runtime-a","sequence":1,"event":{
            "type":"session.snapshot","sessionId":"session-1","syncId":"sync-1","mode":"append",
            "range":"catchup","targetLeafId":"live","complete":true,"cursor":{"leafId":"live"},
            "entries":[
              {"entryId":"mid","parentId":null,"type":"message","timestamp":"2","data":{"message":{"role":"assistant","content":"mid"}}},
              {"entryId":"live","parentId":"mid","type":"message","timestamp":"3","data":{"message":{"role":"user","content":"live"}}}
            ]
          }}
        """.trimIndent())

        assertEquals(listOf("old", "mid", "live"), changed.conversations["runtime-a"]?.messages?.map(ChatMessage::messageId))
        assertEquals("old", changed.sessionHistory["runtime-a"]?.oldestEntryId)
        assertEquals(true, changed.sessionHistory["runtime-a"]?.hasOlder)
        assertEquals(false, changed.sessionHistory["runtime-a"]?.loading)

        val retargeted = reducer.reduce(
            RemoteState(
                selectedRuntimeId = "runtime-a",
                runtimes = mapOf(
                    "runtime-a" to RuntimeSummary(
                        "runtime-a", "A", "/a", "idle", "session-1",
                        sessionGraphSync = true,
                        sessionLeafId = "new-live",
                    ),
                ),
                conversations = mapOf(
                    "runtime-a" to RuntimeConversation(
                        messages = listOf(ChatMessage("new-live", "user", listOf(RemoteContent("text", "tail")), 3)),
                        hasLiveSnapshot = true,
                    ),
                ),
                runtimeSessionViews = mapOf("runtime-a" to RuntimeSessionView("runtime-a", "session-1", "old-live")),
                sessionHistory = mapOf(
                    "runtime-a" to SessionHistoryState("session-1", "old-live", "deep", hasOlder = true),
                ),
                sessionSyncCommands = mapOf(
                    "catchup-1" to PendingSessionSync(
                        runtimeId = "runtime-a",
                        sessionId = "session-1",
                        syncId = "sync-1",
                        range = "catchup",
                        targetLeafId = "new-live",
                        knownLeafId = "old-live",
                    ),
                ),
                pendingCommands = mapOf("catchup-1" to "runtime-a"),
            ),
            """
              {"type":"runtime.event","runtimeId":"runtime-a","sequence":1,"event":{
                "type":"session.snapshot","sessionId":"session-1","syncId":"sync-1","mode":"append",
                "range":"catchup","targetLeafId":"new-live","complete":true,"cursor":{"leafId":"new-live"},
                "entries":[
                  {"entryId":"mid","parentId":null,"type":"message","timestamp":"2","data":{"message":{"role":"assistant","content":"mid"}}},
                  {"entryId":"old-live","parentId":"mid","type":"message","timestamp":"2","data":{"message":{"role":"assistant","content":"old-live"}}},
                  {"entryId":"new-live","parentId":"old-live","type":"message","timestamp":"3","data":{"message":{"role":"user","content":"new-live"}}}
                ]
              }}
            """.trimIndent(),
        )

        assertEquals("new-live", retargeted.sessionHistory["runtime-a"]?.leafId)
        assertEquals("deep", retargeted.sessionHistory["runtime-a"]?.oldestEntryId)
        assertEquals(true, retargeted.sessionHistory["runtime-a"]?.hasOlder)
    }

    @Test
    fun `an older paged-in message stays above the window when the leaf advances`() {
        // Preview/history pages are never written to the canonical tree, so they stay in memory as
        // temporary rows. A later leaf advance must not treat them as live overlays and append them
        // after the newest canonical message — that is the "an old message keeps jumping to the
        // bottom until the app is restarted" render bug.
        val graph = SessionGraph(
            sessionId = "session-1",
            entries = listOf(
                liveEntry("mid", null, "assistant", "mid", 2),
                liveEntry("live", "mid", "user", "live", 3),
                liveEntry("new", "live", "assistant", "new", 4),
            ).associateBy(SessionGraphEntry::entryId),
            cursor = SessionBranchCursor("new"),
        )
        val initial = RemoteState(
            selectedRuntimeId = "runtime-a",
            runtimes = mapOf(
                "runtime-a" to RuntimeSummary(
                    "runtime-a", "A", "/a", "idle", "session-1",
                    sessionGraphSync = true,
                    sessionLeafId = "live",
                ),
            ),
            runtimeSessionViews = mapOf("runtime-a" to RuntimeSessionView("runtime-a", "session-1", "live")),
            sessionGraphs = mapOf("session-1" to graph),
            conversations = mapOf(
                "runtime-a" to RuntimeConversation(
                    // "old" was paged in from history and is absent from the canonical tree.
                    messages = listOf(
                        ChatMessage("old", "user", listOf(RemoteContent("text", "old")), 1),
                        ChatMessage("mid", "assistant", listOf(RemoteContent("text", "mid")), 2),
                        ChatMessage("live", "user", listOf(RemoteContent("text", "live")), 3),
                        ChatMessage("new", "assistant", listOf(RemoteContent("text", "new")), 4),
                    ),
                    hasLiveSnapshot = true,
                ),
            ),
        )

        val advanced = reducer.reduce(initial, liveEvent(1, """
          {"type":"runtime.metadata","metadata":{"runtimeId":"runtime-a","name":"A","cwd":"/a",
            "status":"idle","sessionId":"session-1","sessionGraphSync":true,"sessionLeafId":"new"}}
        """.trimIndent()))

        assertEquals(
            listOf("old", "mid", "live", "new"),
            advanced.conversations.getValue("runtime-a").messages.map(ChatMessage::messageId),
        )
    }

    @Test
    fun `same-branch online replay keeps the in-flight history request until real disconnection`() {
        val initial = RemoteState(
            connection = RelayConnection.ONLINE,
            deviceId = "device-1",
            selectedRuntimeId = "runtime-a",
            runtimes = mapOf(
                "runtime-a" to RuntimeSummary(
                    "runtime-a", "A", "/a", "idle", "session-1",
                    sessionGraphSync = true,
                    sessionLeafId = "leaf",
                ),
            ),
            runtimeSessionViews = mapOf("runtime-a" to RuntimeSessionView("runtime-a", "session-1", "leaf")),
            sessionHistory = mapOf(
                "runtime-a" to SessionHistoryState(
                    "session-1", "leaf", "deep", hasOlder = true,
                    loading = true, requestId = "history-command",
                ),
            ),
            sessionSyncCommands = mapOf(
                "history-command" to PendingSessionSync(
                    runtimeId = "runtime-a",
                    sessionId = "session-1",
                    syncId = "history-1",
                    range = "history",
                    targetLeafId = "leaf",
                    beforeEntryId = "deep",
                ),
            ),
        )

        val changed = reducer.reduce(initial, """
          {"type":"runtime.online","runtime":{"runtimeId":"runtime-a","name":"A","cwd":"/a",
            "status":"idle","sessionId":"session-1","sessionGraphSync":true,"sessionLeafId":"leaf"}}
        """.trimIndent())

        assertEquals("deep", changed.sessionHistory["runtime-a"]?.oldestEntryId)
        assertEquals(true, changed.sessionHistory["runtime-a"]?.hasOlder)
        assertEquals(initial.sessionSyncCommands, changed.sessionSyncCommands)
        assertEquals(true, changed.sessionHistory["runtime-a"]?.loading)
        assertEquals("history-command", changed.sessionHistory["runtime-a"]?.requestId)
        val disconnected = changed.markReconnecting()
        assertTrue(disconnected.sessionSyncCommands.isEmpty())
        assertEquals(false, disconnected.sessionHistory["runtime-a"]?.loading)
        assertEquals(null, disconnected.sessionHistory["runtime-a"]?.requestId)
        assertEquals("deep", disconnected.sessionHistory["runtime-a"]?.oldestEntryId)
    }

    @Test
    fun `transport loss enters silent reconnect and same-session reconnect keeps transient state while loading`() {
        val state = RemoteState(
            connection = RelayConnection.ONLINE,
            pendingCommands = mapOf("command-1" to "runtime-a"),
            error = "旧错误",
        )

        val reconnecting = state.markReconnecting()

        assertEquals(RelayConnection.RECONNECTING, reconnecting.connection)
        assertEquals(null, reconnecting.error)
        assertTrue(reconnecting.pendingCommands.isEmpty())
        assertEquals("cancelled", reconnecting.commandResults["command-1"]?.status)

        val interaction = PendingInteraction("request-1", "extension", "confirm", "Continue", null, emptyList(), null)
        val initial = RemoteState(
            connection = RelayConnection.ONLINE,
            e2eReady = true,
            deviceId = "phone-1",
            selectedRuntimeId = "runtime-a",
            runtimes = mapOf(
                "runtime-a" to RuntimeSummary("runtime-a", "A", "/a", "idle", "same", sessionGraphSync = true),
                "runtime-b" to RuntimeSummary("runtime-b", "B", "/b", "idle", "other"),
            ),
            conversations = mapOf(
                "runtime-a" to RuntimeConversation(
                    messages = listOf(ChatMessage("live", "assistant", emptyList(), 1)),
                    hasLiveSnapshot = true,
                    interactions = mapOf("request-1" to interaction),
                    tools = mapOf("tool-1" to ToolActivity("tool-1", "bash", "started")),
                ),
            ),
            capabilities = mapOf("runtime-a" to RuntimeCapabilities(listOf(RuntimeSlashCommand("reload", source = "builtin")))),
        )
        val relayReady = """{"type":"device.ready","protocolVersion":$PROTOCOL_VERSION,"deviceId":"phone-1","runtimes":[],"agents":null}"""
        // Relay authenticates before Host's handshake finishes. Its empty seed is not a directory.
        val waiting = initial.markReconnecting()
        val authenticated = reducer.reduce(waiting, relayReady, channel = null)
        assertEquals("Relay reconnect must keep every window visible", waiting.runtimes, authenticated.runtimes)
        assertEquals(waiting.conversations, authenticated.conversations)
        assertEquals(waiting.capabilities, authenticated.capabilities)
        assertFalse(authenticated.e2eReady)

        val reconnected = reducer.reduce(
            authenticated,
            """
              {"type":"device.ready","deviceId":"phone-1","runtimes":[
                {"runtimeId":"runtime-a","name":"A","cwd":"/a","status":"idle","sessionId":"same","sessionGraphSync":true},
                {"runtimeId":"runtime-b","name":"B","cwd":"/b","status":"idle","sessionId":"other"}
              ]}
            """.trimIndent(),
            channel = "ctl",
        )

        val conversation = reconnected.conversations.getValue("runtime-a")
        assertTrue(conversation.isChatSyncing)
        assertTrue(conversation.hasLiveSnapshot)
        assertTrue(conversation.interactions.containsKey("request-1"))
        assertTrue(conversation.tools.containsKey("tool-1"))
        assertEquals("reload", reconnected.capabilities["runtime-a"]?.commands?.single()?.name)
        assertEquals(initial.runtimes, reconnected.runtimes)

        // LAN can already be live when Relay re-authenticates: keep in-flight work too.
        val live = reconnected.copy(
            e2eReady = true,
            pendingCommands = mapOf("sync-1" to "runtime-a"),
            sessionSyncCommands = mapOf("sync-1" to PendingSessionSync("runtime-a", "same", "sync-1")),
        )
        assertEquals(live, reducer.reduce(live, relayReady, channel = null))
        // Only Host's authenticated directory can say that all windows have actually closed.
        val empty = reducer.reduce(live, relayReady, channel = "ctl")
        assertTrue(empty.runtimes.isEmpty())
        assertTrue(empty.conversations.isEmpty())
    }

    @Test
    fun `queued messages stay visible until delivery and cannot be restored after delivery`() {
        var state = reducer.reduce(RemoteState(), """
          {"type":"runtime.event","runtimeId":"runtime-a","sequence":1,"event":{
            "type":"message.queued","queueId":"queue-1","text":"follow up","delivery":"followUp","state":"accepted"
          }}
        """.trimIndent())
        assertEquals("accepted", state.conversations["runtime-a"]?.queuedMessages?.get("queue-1")?.state)
        state = reducer.reduce(state, """
          {"type":"runtime.event","runtimeId":"runtime-a","sequence":2,"event":{
            "type":"message.started","queueId":"queue-1","message":{
              "messageId":"entry-1","role":"user","content":[{"type":"text","text":"follow up"}],"timestamp":1
            }
          }}
        """.trimIndent())
        assertTrue(state.conversations["runtime-a"]?.queuedMessages?.isEmpty() == true)
        assertEquals(1, state.conversations["runtime-a"]?.messages?.size)
        val late = reducer.reduce(state, """
          {"type":"runtime.event","runtimeId":"runtime-a","sequence":3,"event":{
            "type":"message.queued","queueId":"queue-1","text":"follow up","delivery":"followUp","state":"accepted"
          }}
        """.trimIndent())
        assertTrue(late.conversations["runtime-a"]?.queuedMessages?.isEmpty() == true)

        var delivered = reducer.reduce(RemoteState(), """
          {"type":"runtime.event","runtimeId":"runtime-a","sequence":1,"event":{
            "type":"message.queued","queueId":"queue-1","text":"queued","delivery":"steer","state":"accepted"
          }}
        """.trimIndent())
        delivered = reducer.reduce(delivered, """
          {"type":"runtime.event","runtimeId":"runtime-a","sequence":2,"event":{
            "type":"message.queued","queueId":"queue-1","text":"queued","delivery":"steer","state":"delivered"
          }}
        """.trimIndent())

        assertTrue(delivered.conversations["runtime-a"]?.queuedMessages?.isEmpty() == true)
        assertTrue("queue-1" in (delivered.conversations["runtime-a"]?.deliveredQueueIds ?: emptySet()))

        delivered = reducer.reduce(delivered, """
          {"type":"runtime.event","runtimeId":"runtime-a","sequence":3,"event":{
            "type":"message.queued","queueId":"queue-1","text":"queued","delivery":"steer","state":"accepted"
          }}
        """.trimIndent())

        assertTrue(delivered.conversations["runtime-a"]?.queuedMessages?.isEmpty() == true)
    }

    @Test
    fun `message lifecycle without queue id does not infer a queued message by text`() {
        var state = reducer.reduce(RemoteState(), """
          {"type":"runtime.event","runtimeId":"runtime-a","sequence":1,"event":{
            "type":"message.queued","queueId":"queue-1","text":"same text","delivery":"steer","state":"accepted"
          }}
        """.trimIndent())
        state = reducer.reduce(state, """
          {"type":"runtime.event","runtimeId":"runtime-a","sequence":2,"event":{
            "type":"message.started","message":{
              "messageId":"entry-1","role":"user","content":[{"type":"text","text":"same text"}],"timestamp":1
            }
          }}
        """.trimIndent())

        assertEquals("accepted", state.conversations["runtime-a"]?.queuedMessages?.get("queue-1")?.state)
        assertTrue(state.conversations["runtime-a"]?.deliveredQueueIds?.isEmpty() == true)
    }

    @Test
    fun `queued id cannot be reused with different message data`() {
        var state = reducer.reduce(RemoteState(), """
          {"type":"runtime.event","runtimeId":"runtime-a","sequence":1,"event":{
            "type":"message.queued","queueId":"queue-1","text":"original","delivery":"steer","state":"accepted"
          }}
        """.trimIndent())
        state = reducer.reduce(state, """
          {"type":"runtime.event","runtimeId":"runtime-a","sequence":2,"event":{
            "type":"message.queued","queueId":"queue-1","text":"different","delivery":"followUp","state":"accepted"
          }}
        """.trimIndent())

        assertEquals("original", state.conversations["runtime-a"]?.queuedMessages?.get("queue-1")?.text)
        assertEquals("steer", state.conversations["runtime-a"]?.queuedMessages?.get("queue-1")?.delivery)
    }

    @Test
    fun `queued messages are scoped to the runtime session and survive a same-session reconnect`() {
        var state = reducer.reduce(RemoteState(), """
          {"type":"runtime.online","runtime":{"runtimeId":"runtime-a","name":"A","cwd":"/a","status":"running","sessionId":"session-1"}}
        """.trimIndent())
        state = reducer.reduce(state, """
          {"type":"runtime.event","runtimeId":"runtime-a","sequence":1,"event":{
            "type":"message.queued","queueId":"queue-1","text":"old","delivery":"steer","state":"accepted"
          }}
        """.trimIndent())
        state = reducer.reduce(state, """
          {"type":"runtime.online","runtime":{"runtimeId":"runtime-a","name":"A","cwd":"/a","status":"idle","sessionId":"session-2"}}
        """.trimIndent())
        assertTrue(state.conversations["runtime-a"]?.queuedMessages?.isEmpty() == true)
        val unrelated = reducer.reduce(state, """
          {"type":"runtime.event","runtimeId":"runtime-b","sequence":1,"event":{
            "type":"message.queued","queueId":"queue-1","text":"other","delivery":"followUp","state":"accepted"
          }}
        """.trimIndent())
        assertTrue(unrelated.conversations["runtime-a"]?.queuedMessages?.isEmpty() == true)

        var reconnected = reducer.reduce(RemoteState(), """
          {"type":"runtime.online","runtime":{
            "runtimeId":"runtime-a","name":"A","cwd":"/a","status":"running","sessionId":"session-1"
          }}
        """.trimIndent())
        reconnected = reducer.reduce(reconnected, """
          {"type":"runtime.event","runtimeId":"runtime-a","sequence":1,"event":{
            "type":"message.queued","queueId":"queue-1","text":"keep me","delivery":"steer","state":"accepted"
          }}
        """.trimIndent())
        reconnected = reducer.reduce(reconnected, """
          {"type":"runtime.offline","runtimeId":"runtime-a","reason":"transport lost"}
        """.trimIndent())
        reconnected = reducer.reduce(reconnected, """
          {"type":"runtime.online","runtime":{
            "runtimeId":"runtime-a","name":"A","cwd":"/a","status":"running","sessionId":"session-1"
          }}
        """.trimIndent())

        assertEquals("accepted", reconnected.conversations["runtime-a"]?.queuedMessages?.get("queue-1")?.state)
    }

    @Test
    fun `runtime offline clears active timing but keeps completed timing frozen`() {
        val completedTiming = TurnTiming("turn-1", 1_000, durationMs = 250, messageId = "assistant-1")
        val state = RemoteState(
            runtimes = mapOf("runtime-a" to RuntimeSummary("runtime-a", "A", "/a", "idle", "session-1")),
            knownRuntimeSessions = mapOf("runtime-a" to "session-1"),
            conversations = mapOf("runtime-a" to RuntimeConversation(
                turnTimings = mapOf("turn-1" to completedTiming),
            )),
        )
        val completed = reducer.reduce(state, """
          {"type":"runtime.offline","runtimeId":"runtime-a","reason":"transport lost"}
        """.trimIndent())
        assertEquals(250L, completed.conversations["runtime-a"]?.turnTimings?.get("turn-1")?.durationMs)

        val active = state.copy(conversations = mapOf("runtime-a" to RuntimeConversation(
            turnTimings = mapOf("turn-2" to TurnTiming("turn-2", 2_000)),
            activeTurnId = "turn-2",
        )))
        val cleared = reducer.reduce(active, """
          {"type":"runtime.offline","runtimeId":"runtime-a","reason":"transport lost"}
        """.trimIndent())
        assertTrue(cleared.conversations["runtime-a"]?.turnTimings?.isEmpty() == true)
        assertEquals(null, cleared.conversations["runtime-a"]?.activeTurnId)
    }

    @Test
    fun `a new runtime connection resets the sequence epoch so a stale snapshot cannot replace newer events`() {
        val stale = RemoteState(
            lastSequence = mapOf("runtime-a" to 50),
            conversations = mapOf(
                "runtime-a" to RuntimeConversation(
                    messages = listOf(ChatMessage("old", "user", emptyList(), 1)),
                ),
            ),
        )
        val online = """{
          "type":"runtime.online","runtime":{
            "runtimeId":"runtime-a","name":"A","cwd":"/a","status":"idle"
          }
        }""".trimIndent()
        val snapshot = """{
          "type":"runtime.event","runtimeId":"runtime-a","sequence":1,"event":{
            "type":"message.started","message":{
              "messageId":"new","role":"user","content":[],"timestamp":2
            }
          }
        }""".trimIndent()

        val reconnected = reducer.reduce(stale, online)
        assertTrue(reconnected.conversations["runtime-a"]?.messages?.isEmpty() == true)

        val state = reducer.reduce(reconnected, snapshot)

        assertEquals("new", state.conversations["runtime-a"]?.messages?.single()?.messageId)
        assertEquals(1L, state.lastSequence["runtime-a"])

        val staleSnapshot = reducer.reduce(
            RemoteState(
                lastSequence = mapOf("runtime-a" to 4),
                runtimes = mapOf("runtime-a" to RuntimeSummary(
                    "runtime-a", "A", "/a", "idle", "session-1", sessionGraphSync = true, sessionLeafId = "leaf",
                )),
                conversations = mapOf("runtime-a" to RuntimeConversation(
                    messages = listOf(ChatMessage("live", "assistant", emptyList(), 1)),
                    streamingMessageIds = setOf("live"),
                )),
                sessionSyncCommands = mapOf(
                    "command" to PendingSessionSync("runtime-a", "session-1", "sync-1", targetLeafId = "leaf"),
                ),
            ),
            """
              {"type":"runtime.event","runtimeId":"runtime-a","sequence":3,"event":{
                "type":"session.snapshot","sessionId":"session-1","syncId":"sync-1","mode":"replace",
                "cursor":{"leafId":"leaf"},"entries":[
                  {"entryId":"leaf","parentId":null,"type":"message","timestamp":"1","data":{"message":{"role":"assistant","content":"stable"}}}
                ]
              }}
            """.trimIndent(),
        )

        assertEquals(4L, staleSnapshot.lastSequence["runtime-a"])
        assertEquals(listOf("leaf", "live"), staleSnapshot.conversations["runtime-a"]?.messages?.map(ChatMessage::messageId))
    }

    @Test
    fun `capabilities survive runtime online ordering whether they arrive before or after it`() {
        var state = reducer.reduce(RemoteState(), """
          {"type":"runtime.event","runtimeId":"runtime-a","sequence":10,"event":{
            "type":"runtime.capabilities","capabilities":{
              "commands":[
                {"name":"reload","description":"Reload resources","source":"builtin"},
                {"name":"skill:review","description":"Review code","source":"skill",
                 "argument":{"kind":"text","required":false,"hint":"[request]"}}
              ]
            }
          }}
        """.trimIndent())

        state = reducer.reduce(state, """
          {"type":"runtime.online","runtime":{
            "runtimeId":"runtime-a","name":"A","cwd":"/a","status":"idle","sessionId":"session-1"
          }}
        """.trimIndent())

        assertEquals(listOf("reload", "skill:review"), state.capabilities["runtime-a"]?.commands?.map { it.name })
        assertEquals("[request]", state.capabilities["runtime-a"]?.commands?.last()?.argument?.hint)
        assertEquals(10L, state.lastSequence["runtime-a"])

        val refreshed = reducer.reduce(
            RemoteState(
                runtimes = mapOf("runtime-a" to RuntimeSummary("runtime-a", "A", "/a", "idle", "session-1")),
                capabilities = mapOf(
                    "runtime-a" to RuntimeCapabilities(
                        commands = listOf(RuntimeSlashCommand("session", "Session 信息", "builtin")),
                    ),
                ),
                lastSequence = mapOf("runtime-a" to 10),
            ),
            """
              {"type":"runtime.event","runtimeId":"runtime-a","sequence":11,"event":{
                "type":"runtime.capabilities","capabilities":{
                  "commands":[{"name":"reload","description":"重载 Pi 扩展","source":"builtin"}]
                }
              }}
            """.trimIndent(),
        )
        val reordered = reducer.reduce(refreshed, """
          {"type":"runtime.online","runtime":{
            "runtimeId":"runtime-a","name":"A","cwd":"/a","status":"idle","sessionId":"session-1"
          }}
        """.trimIndent())

        assertEquals("reload", reordered.capabilities["runtime-a"]?.commands?.single()?.name)
        assertEquals(11L, reordered.lastSequence["runtime-a"])
    }

    @Test
    fun `artifact transfer lifecycle is scoped to its transfer identity`() {
        var state = reducer.reduce(RemoteState(), """
          {"type":"runtime.event","runtimeId":"runtime-a","sequence":1,"event":{
            "type":"artifact.started","commandId":"download-1","transferId":"download-1","offset":0,"artifact":{
              "artifactId":"00000000-0000-4000-8000-000000000002",
              "fileName":"report.zip","sha256":"0000000000000000000000000000000000000000000000000000000000000000","mimeType":"application/zip","size":3
            }
          }}
        """.trimIndent())
        assertEquals("downloading", state.downloads.values.single().status)
        assertEquals(0L, state.downloads.values.single().receivedBytes)

        val hostRoute = reducer.reduceArtifactChunk(state, "host-1", "download-1", 0, 3)
        assertEquals(3L, hostRoute.downloads.values.single().receivedBytes)

        state = reducer.reduceArtifactChunk(hostRoute, "runtime-a", "download-1", 0, 3)
        assertEquals(3L, state.downloads.values.single().receivedBytes)

        state = reducer.reduceArtifactChunk(state, "runtime-a", "download-1", 0, 3)
        assertEquals(3L, state.downloads.values.single().receivedBytes)
        assertEquals(null, state.error)
    }

    @Test
    fun `a rejected range fails the pull task`() {
        val artifact = """{"artifactId":"00000000-0000-4000-8000-000000000002","fileName":"report.zip","mimeType":"application/zip","size":3,"sha256":"0000000000000000000000000000000000000000000000000000000000000000"}"""

        val pull = reducer.reduce(RemoteState(), """
          {"type":"runtime.event","runtimeId":"host-1","sequence":1,"event":{
            "type":"artifact.started","commandId":"download-1","transferId":"transfer-1","offset":0,
            "artifact":$artifact
          }}
        """.trimIndent())
        assertEquals("host-1", pull.downloads.values.single().transferRuntimeId)

        val failed = reducer.reduce(pull, """
          {"type":"artifact.read.failed","protocolVersion":$PROTOCOL_VERSION,"transferId":"transfer-1","requestId":"r1","reason":"read_failed"}
        """.trimIndent())
        assertEquals("failed", failed.downloads.values.single().status)
    }

    @Test
    fun `out of order artifact chunks wait for the missing prefix`() {
        var state = reducer.reduce(RemoteState(), """
          {"type":"runtime.event","runtimeId":"runtime-a","sequence":1,"event":{
            "type":"artifact.started","commandId":"download-1","transferId":"download-1","offset":0,"artifact":{
              "artifactId":"00000000-0000-4000-8000-000000000013",
              "fileName":"report.zip","sha256":"0000000000000000000000000000000000000000000000000000000000000000","mimeType":"application/zip","size":9
            }
          }}
        """.trimIndent())
        state = reducer.reduceArtifactChunk(state, "runtime-a", "download-1", 0, 3)
        state = reducer.reduceArtifactChunk(state, "runtime-a", "download-1", 6, 3)

        assertEquals("downloading", state.downloads.values.single().status)
        assertEquals(3L, state.downloads.values.single().receivedBytes)
        assertEquals(null, state.error)

        state = reducer.reduceArtifactChunk(state, "runtime-a", "download-1", 3, 3)
        state = reducer.reduceArtifactChunk(state, "runtime-a", "download-1", 6, 3)
        assertEquals("downloading", state.downloads.values.single().status)
        assertEquals(9L, state.downloads.values.single().receivedBytes)
        assertEquals(null, state.error)
    }

    @Test
    fun `file download failures expose actionable computer side diagnostics`() {
        val missing = reducer.reduce(RemoteState(), """
          {"type":"runtime.event","runtimeId":"runtime-a","sequence":1,"event":{
            "type":"command.result","commandId":"download-missing","ok":false,
            "error":"ENOENT: no such file or directory"
          }}
        """.trimIndent())
        assertEquals("电脑端文件不存在或已被删除", missing.error)

        val denied = reducer.reduce(RemoteState(), """
          {"type":"runtime.event","runtimeId":"runtime-a","sequence":1,"event":{
            "type":"command.result","commandId":"download-denied","ok":false,
            "error":"EACCES: permission denied"
          }}
        """.trimIndent())
        assertEquals("Pi 进程无权读取电脑端文件", denied.error)
    }

    @Test
    fun `cancelled original download result does not fail an active retry`() {
        val state = RemoteState(
            pendingCommands = mapOf("retry-2" to "runtime-a"),
            pendingDownloads = mapOf("retry-2" to PendingDownload("task-1", "runtime-a", 3)),
            downloads = mapOf(
                "task-1" to ArtifactDownload(
                    taskId = "task-1",
                    runtimeId = "runtime-a",
                    displayName = "report.zip",
                    commandId = "retry-2",
                    sourcePath = "C:\\work\\report.zip",
                    status = "queued",
                    receivedBytes = 3,
                ),
            ),
        )

        val next = reducer.reduce(state, """
          {"type":"runtime.event","runtimeId":"runtime-a","sequence":1,"event":{
            "type":"command.result","commandId":"download-1","ok":false,
            "status":"cancelled","error":"user_cancelled"
          }}
        """.trimIndent())

        assertEquals(null, next.error)
        assertEquals("queued", next.downloads["task-1"]?.status)
        assertEquals("retry-2", next.downloads["task-1"]?.commandId)
        assertTrue(next.pendingDownloads.containsKey("retry-2"))
        assertEquals("cancelled", next.commandResults["download-1"]?.status)
    }

    @Test
    fun `resumed file downloads keep the persisted offset`() {
        val state = RemoteState(
            downloads = mapOf(
                "task-1" to ArtifactDownload(
                    taskId = "task-1",
                    runtimeId = "runtime-a",
                    displayName = "report.zip",
                    sourcePath = "C:\\work\\report.zip",
                    status = "queued",
                    receivedBytes = 3,
                ),
            ),
            pendingDownloads = mapOf(
                "download-2" to PendingDownload("task-1", "runtime-a", 3),
            ),
        )
        val next = reducer.reduce(state, """
          {"type":"runtime.event","runtimeId":"runtime-a","sequence":1,"event":{
            "type":"artifact.started","commandId":"download-2","transferId":"transfer-2","offset":3,"artifact":{
              "artifactId":"00000000-0000-4000-8000-000000000006",
              "fileName":"report.zip","sha256":"0000000000000000000000000000000000000000000000000000000000000000","mimeType":"application/zip","size":6,
              "path":"C:\\work\\report.zip"
            }
          }}
        """.trimIndent())

        assertEquals(3L, next.downloads["task-1"]?.receivedBytes)
        assertEquals("downloading", next.downloads["task-1"]?.status)
        assertFalse(next.pendingDownloads.containsKey("download-2"))
    }

    @Test
    fun `file downloads are not rejected at the former fifty MiB limit`() {
        val state = reducer.reduce(RemoteState(), """
          {"type":"runtime.event","runtimeId":"runtime-a","sequence":1,"event":{
            "type":"artifact.started","commandId":"download-large","transferId":"transfer-large","offset":0,"artifact":{
              "artifactId":"00000000-0000-4000-8000-000000000004",
              "fileName":"large.bin","sha256":"0000000000000000000000000000000000000000000000000000000000000000","mimeType":"application/octet-stream","size":104857600,
              "path":"C:\\work\\large.bin"
            }
          }}
        """.trimIndent())

        assertEquals(104857600L, state.downloads.values.single().artifact?.size)
        assertEquals("C:\\work\\large.bin", state.downloads.values.single().artifact?.path)
    }

    @Test
    fun `source runtime going offline does not pause a download the host is serving`() {
        // 下载任务上的 runtimeId 只是来源标记（文件来自哪个会话），服务方是 Host。
        // 源进程掉线曾把状态从 downloading 改成 paused，手机随即丢弃所有分片、一个 ack
        // 都不发，Host 只能等到 ack 超时报 artifact_ack_timeout。
        var state = reducer.reduce(RemoteState(), """
          {"type":"runtime.event","runtimeId":"runtime-a","sequence":1,"event":{
            "type":"artifact.started","commandId":"download-1","transferId":"download-1","offset":0,"artifact":{
              "artifactId":"00000000-0000-4000-8000-000000000030",
              "fileName":"app-debug.apk","sha256":"0000000000000000000000000000000000000000000000000000000000000000","mimeType":"application/vnd.android.package-archive","size":87886633
            }
          }}
        """.trimIndent())
        assertEquals("downloading", state.downloads.values.single().status)

        state = reducer.reduce(state, """
          {"type":"runtime.offline","runtimeId":"runtime-a","reason":"transport lost"}
        """.trimIndent())
        // 传输仍在（transferId 持续存在），状态必须还是 downloading，分片才不会被丢。
        assertEquals("downloading", state.downloads.values.single().status)
        assertEquals("download-1", state.downloads.values.single().transferId)
    }

    @Test
    fun `queued download without a transfer is paused when its source runtime goes offline`() {
        val task = ArtifactDownload(
            taskId = "task-1",
            runtimeId = "runtime-a",
            displayName = "report.zip",
            sourceArtifactId = "00000000-0000-4000-8000-000000000031",
        ).copy(status = "queued")
        val state = RemoteState(downloads = mapOf("task-1" to task))
        val next = reducer.reduce(state, """
          {"type":"runtime.offline","runtimeId":"runtime-a","reason":"transport lost"}
        """.trimIndent())
        assertEquals("paused", next.downloads["task-1"]?.status)
    }

    @Test
    fun `slash capabilities are scoped to a runtime and command results keep payload`() {
        val state = reducer.reduce(RemoteState(), """
          {"type":"runtime.event","runtimeId":"runtime-a","sequence":1,"event":{
            "type":"runtime.capabilities","capabilities":{
              "commands":[{"name":"model","label":"切换模型","source":"builtin","argument":{
                "kind":"select","required":true,
                "options":[{"value":"openai/gpt-5","label":"GPT-5","description":"openai/gpt-5"}]
              }}]
            }
          }}
        """.trimIndent())
        val modelCommand = state.capabilities["runtime-a"]?.commands?.single()
        assertEquals("model", modelCommand?.name)
        assertEquals("openai/gpt-5", modelCommand?.argument?.options?.single()?.value)

        val result = reducer.reduce(state.copy(pendingCommands = mapOf("slash-1" to "runtime-a")), """
          {"type":"runtime.event","runtimeId":"runtime-a","sequence":2,"event":{
            "type":"command.result","commandId":"slash-1","ok":true,"status":"success",
            "result":{"provider":"openai","modelId":"gpt-5"}
          }}
        """.trimIndent())
        assertFalse(result.pendingCommands.containsKey("slash-1"))
        assertEquals(true, result.commandResults["slash-1"]?.ok)
        assertEquals("gpt-5", result.commandResults["slash-1"]?.result?.jsonObject?.get("modelId")?.jsonPrimitive?.content)
    }

    @Test
    fun `session snapshot replaces temporary user and assistant messages after turn completion`() {
        val runtime = RuntimeSummary("runtime-a", "A", "/a", "idle", "session-1", sessionGraphSync = true)
        val root = SessionGraphEntry(
            entryId = "root",
            parentId = null,
            type = "message",
            timestamp = "2026-01-01T00:00:00.000Z",
            data = kotlinx.serialization.json.buildJsonObject {
                put("message", kotlinx.serialization.json.buildJsonObject {
                    put("role", "user")
                    put("content", "before")
                })
            },
        )
        var state = RemoteState(
            runtimes = mapOf("runtime-a" to runtime),
            conversations = mapOf(
                "runtime-a" to RuntimeConversation(
                    messages = listOf(
                        ChatMessage("root", "user", listOf(RemoteContent("text", "before")), 1),
                        ChatMessage("user-live", "user", listOf(RemoteContent("text", "new request")), 2),
                        ChatMessage("assistant-live", "assistant", listOf(RemoteContent("text", "done")), 3),
                    ),
                    streamingMessageIds = setOf("user-live", "assistant-live"),
                ),
            ),
            sessionGraphs = mapOf(
                "session-1" to SessionGraph(
                    sessionId = "session-1",
                    entries = mapOf("root" to root),
                    cursor = SessionBranchCursor("root"),
                ),
            ),
            runtimeSessionViews = mapOf("runtime-a" to RuntimeSessionView("runtime-a", "session-1", "root")),
            sessionSyncCommands = mapOf(
                "sync-command" to PendingSessionSync("runtime-a", "session-1", "sync-1"),
            ),
        )

        state = reducer.reduce(state, """
          {"type":"runtime.event","runtimeId":"runtime-a","sequence":1,"event":{
            "type":"session.snapshot","sessionId":"session-1","syncId":"sync-1","mode":"append",
            "cursor":{"leafId":"assistant-entry"},
            "entries":[
              {"entryId":"user-entry","parentId":"root","type":"message","timestamp":"2026-01-01T00:00:01.000Z","data":{"message":{"role":"user","content":"new request","timestamp":2}}},
              {"entryId":"assistant-entry","parentId":"user-entry","type":"message","timestamp":"2026-01-01T00:00:02.000Z","data":{"message":{"role":"assistant","content":"done","timestamp":3}}}
            ]
          }}
        """.trimIndent())

        assertEquals(listOf("root", "user-entry", "assistant-entry"), state.conversations["runtime-a"]?.messages?.map(ChatMessage::messageId))
        assertTrue(state.conversations["runtime-a"]?.streamingMessageIds?.isEmpty() == true)
    }

    @Test
    fun `session snapshot restores persisted turn timing and clears stale active timing`() {
        val state = RemoteState(
            runtimes = mapOf("runtime-a" to RuntimeSummary("runtime-a", "A", "/a", "idle", "session-1", sessionGraphSync = true)),
            conversations = mapOf("runtime-a" to RuntimeConversation(
                turnTimings = mapOf("active" to TurnTiming("active", 2_000)),
                activeTurnId = "active",
            )),
            sessionSyncCommands = mapOf(
                "command-1" to PendingSessionSync("runtime-a", "session-1", "sync-1"),
            ),
        )
        val restored = reducer.reduce(state, """
          {"type":"runtime.event","runtimeId":"runtime-a","sequence":1,"event":{
            "type":"session.snapshot","sessionId":"session-1","syncId":"sync-1","mode":"replace",
            "cursor":{"leafId":"timing"},"entries":[
              {"entryId":"assistant","parentId":null,"type":"message","timestamp":"2026-01-01T00:00:00.000Z","data":{"message":{"role":"assistant","content":"done"}}},
              {"entryId":"timing","parentId":"assistant","type":"custom","timestamp":"2026-01-01T00:00:01.000Z","data":{"customType":"pi_remote_turn_timing","data":{"turnId":"turn-1","startedAt":1000,"durationMs":250,"messageId":"assistant"}}}
            ]
          }}
        """.trimIndent())

        assertEquals(250L, restored.conversations["runtime-a"]?.turnTimings?.get("turn-1")?.durationMs)
        assertEquals(null, restored.conversations["runtime-a"]?.turnTimings?.get("active"))
        assertEquals(null, restored.conversations["runtime-a"]?.activeTurnId)
    }

    @Test
    fun `turn timing keeps separate turns anchored to assistant messages`() {
        var state = reducer.reduce(RemoteState(), """{
          "type":"runtime.online","runtime":{"runtimeId":"runtime-a","name":"A","cwd":"/a","status":"running","sessionId":"s1"}
        }""")
        state = reducer.reduce(state, """{
          "type":"runtime.event","runtimeId":"runtime-a","sequence":1,"event":{
            "type":"turn.started","turnId":"turn-1","startedAt":1000,"turnIndex":0
          }
        }""")
        assertEquals(
            TurnTiming("turn-1", 1000, turnIndex = 0),
            state.conversations["runtime-a"]?.turnTimings?.get("turn-1"),
        )
        val assistantLive = ChatMessage("assistant-live", "assistant", emptyList(), 2_000)
        state = reducer.reduce(state, """{
          "type":"runtime.event","runtimeId":"runtime-a","sequence":2,"event":{
            "type":"message.started","message":{
              "messageId":"assistant-live","role":"assistant","content":[],"timestamp":2000
            }
          }
        }""")
        assertEquals("assistant-live", state.conversations["runtime-a"]?.turnTimings?.get("turn-1")?.messageId)
        state = reducer.reduce(state, """{
          "type":"runtime.event","runtimeId":"runtime-a","sequence":3,"event":{
            "type":"message.finished","message":{
              "messageId":"assistant-live","role":"assistant","content":[{"type":"text","text":"done"}],"timestamp":2000
            }
          }
        }""")
        state = reducer.reduce(state, """{
          "type":"runtime.event","runtimeId":"runtime-a","sequence":4,"event":{
            "type":"turn.finished","turnId":"turn-1","startedAt":1000,"durationMs":250,"turnIndex":0,
            "messageId":"assistant-live","persistedMessageId":"assistant-entry"
          }
        }""")
        assertEquals(250L, state.conversations["runtime-a"]?.turnTimings?.get("turn-1")?.durationMs)
        assertEquals("assistant-entry", state.conversations["runtime-a"]?.turnTimings?.get("turn-1")?.messageId)
        assertEquals("assistant-entry", state.conversations["runtime-a"]?.messages?.single()?.messageId)

        state = reducer.reduce(state, """{
          "type":"runtime.event","runtimeId":"runtime-a","sequence":5,"event":{
            "type":"turn.started","turnId":"turn-2","startedAt":2000,"turnIndex":1
          }
        }""")
        assertEquals(setOf("turn-1", "turn-2"), state.conversations["runtime-a"]?.turnTimings?.keys)
        val duplicate = reducer.reduce(state, """{
          "type":"runtime.event","runtimeId":"runtime-a","sequence":5,"event":{
            "type":"turn.started","turnId":"turn-2","startedAt":2000,"turnIndex":1
          }
        }""")
        assertEquals(state, duplicate)

    }

    @Test
    fun `unknown protocol versions malformed events and relay errors fail closed`() {
        val incompatible = reducer.reduce(RemoteState(), """
          {"type":"runtime.event","protocolVersion":99,"runtimeId":"runtime-a","sequence":1,
           "event":{"type":"message.delta","messageId":"x","contentType":"text","delta":"y"}}
        """.trimIndent())
        assertEquals("收到不兼容的协议版本，请升级 Orbis", incompatible.error)
        val unknownEvent = reducer.reduce(RemoteState(), """
          {"type":"runtime.event","runtimeId":"runtime-a","sequence":1,"event":{"type":"future.event"}}
        """.trimIndent())
        assertEquals("手机无法安全处理此运行时事件，请在电脑端处理", unknownEvent.error)

        val malformed = reducer.reduce(RemoteState(), """
          {"type":"runtime.event","runtimeId":"runtime-a","sequence":1,"event":{
            "type":"interaction.requested","request":{"kind":"unknown","title":"unsafe"}
          }}
        """.trimIndent())
        assertEquals("手机无法安全渲染此交互，请在电脑端处理。", malformed.conversations["runtime-a"]?.interactionNotice)

        val unauthorized = reducer.reduce(RemoteState(), """
          {"type":"protocol.error","code":"unauthorized","message":"Invalid device credential"}
        """.trimIndent())
        assertEquals("Relay 拒绝了设备凭据，请重新扫码配对", unauthorized.error)

        val invalidMessage = reducer.reduce(RemoteState(), """
          {"type":"protocol.error","code":"invalid_message","message":"Message does not match the device protocol"}
        """.trimIndent())
        // 文案里的版本号必须来自常量。它曾经写死 `protocol v3`，协议升到 4 之后就成了
        // 指错方向的线索：用户照它去查版本，而两端版本其实都是对的。
        assertEquals(
            "Relay 拒绝了协议消息，请确认手机端与电脑端都是最新版（protocol v$PROTOCOL_VERSION）",
            invalidMessage.error,
        )
    }

    @Test
    fun `upload read control messages are accepted without a relay protocol error`() {
        val state = reducer.reduce(RemoteState(), """
          {"type":"file.upload.read","protocolVersion":$PROTOCOL_VERSION,
           "uploadId":"upload-1","offset":0,"length":1024}
        """.trimIndent())

        assertEquals(null, state.error)
    }

    @Test
    fun `runtime errors stay in their own runtime conversation`() {
        val initial = RemoteState(
            conversations = mapOf("runtime-b" to RuntimeConversation(runtimeError = "other window")),
        )
        val state = reducer.reduce(initial, """
          {"type":"runtime.event","runtimeId":"runtime-a","sequence":1,"event":{
            "type":"runtime.error","message":"Relay returned an invalid protocol message","recoverable":true
          }}
        """.trimIndent())

        assertEquals("Relay returned an invalid protocol message", state.conversations["runtime-a"]?.runtimeError)
        assertEquals("other window", state.conversations["runtime-b"]?.runtimeError)
        assertEquals(null, state.error)

        val nextTurn = reducer.reduce(state, """
          {"type":"runtime.event","runtimeId":"runtime-a","sequence":2,"event":{
            "type":"turn.started","turnId":"turn-2","startedAt":123
          }}
        """.trimIndent())
        assertEquals(null, nextTurn.conversations["runtime-a"]?.runtimeError)
        assertEquals("other window", nextTurn.conversations["runtime-b"]?.runtimeError)
    }


    @Test
    fun `portable interactions keep every rendering validation and selection field`() {
        val requested = """{
          "type":"runtime.event","runtimeId":"runtime-a","sequence":1,"event":{
            "type":"interaction.requested","request":{
              "runtimeId":"runtime-a","requestId":"request-1","extensionId":"deploy-extension",
              "kind":"input","title":"Deployment token","description":"Enter the one-time token",
              "toolName":"bash","argumentSummary":"kubectl apply -f deploy.yaml",
              "placeholder":"TOKEN-123","initialValue":"TOKEN-","minLength":6,"maxLength":20,
              "secret":true,"expiresAt":5000
            }
          }
        }""".trimIndent()

        var state = reducer.reduce(RemoteState(), requested)
        val interaction = state.conversations["runtime-a"]?.interactions?.get("request-1")
        assertEquals("bash", interaction?.toolName)
        assertEquals("kubectl apply -f deploy.yaml", interaction?.argumentSummary)
        assertEquals("TOKEN-", interaction?.initialValue)
        assertEquals(6, interaction?.minLength)
        assertEquals(20, interaction?.maxLength)
        assertEquals(true, interaction?.secret)
        assertEquals(5000L, interaction?.expiresAt)

        state = reducer.reduce(state, """{
          "type":"runtime.event","runtimeId":"runtime-a","sequence":2,"event":{
            "type":"interaction.cancelled","requestId":"request-1","reason":"timeout"
          }
        }""".trimIndent())
        assertFalse(state.conversations["runtime-a"]?.interactions?.containsKey("request-1") == true)
        assertEquals("交互请求已超时", state.conversations["runtime-a"]?.interactionNotice)

        state = reducer.reduce(state, """{
          "type":"runtime.event","runtimeId":"runtime-a","sequence":3,"event":{
            "type":"interaction.requested","request":{
              "runtimeId":"runtime-a","requestId":"request-2","extensionId":"deploy-extension",
              "kind":"confirm","title":"Deploy?","confirmLabel":"Deploy","cancelLabel":"Keep",
              "expiresAt":9000
            }
          }
        }""".trimIndent())
        val confirmation = state.conversations["runtime-a"]?.interactions?.get("request-2")
        assertEquals("Deploy", confirmation?.confirmLabel)
        assertEquals("Keep", confirmation?.cancelLabel)

        val multi = reducer.reduce(state, """{
          "type":"runtime.event","runtimeId":"runtime-a","sequence":4,"event":{
            "type":"interaction.requested","request":{
              "runtimeId":"runtime-a","requestId":"request-multi","extensionId":"ask-user-question",
              "kind":"multi-select","title":"Pick targets","description":"Choose one or more",
              "options":[
                {"value":"api","label":"API"},
                {"value":"worker","label":"Worker","description":"Background jobs"}
              ],
              "minSelections":1,"maxSelections":2,"expiresAt":9000
            }
          }
        }""".trimIndent())

        val multiInteraction = multi.conversations["runtime-a"]?.interactions?.get("request-multi")
        assertEquals("multi-select", multiInteraction?.kind)
        assertEquals(2, multiInteraction?.options?.size)
        assertEquals("Background jobs", multiInteraction?.options?.get(1)?.description)
        assertEquals(1, multiInteraction?.minSelections)
        assertEquals(2, multiInteraction?.maxSelections)
        assertEquals(null, multi.conversations["runtime-a"]?.interactionNotice)
    }

    @Test
    fun `interaction received before first runtime directory survives device ready`() {
        val request = """{
          "type":"runtime.event","runtimeId":"runtime-a","sequence":1,"event":{
            "type":"interaction.requested","request":{
              "runtimeId":"runtime-a","requestId":"request-before-online","extensionId":"ask-user-question",
              "kind":"confirm","title":"Continue?","expiresAt":9000
            }
          }
        }""".trimIndent()
        var state = reducer.reduce(RemoteState(), request)
        assertTrue(state.conversations["runtime-a"]?.interactions?.containsKey("request-before-online") == true)

        state = reducer.reduce(state, """
          {"type":"device.ready","protocolVersion":$PROTOCOL_VERSION,"deviceId":"phone-1","runtimes":[{
            "runtimeId":"runtime-a","name":"A","cwd":"/a","status":"waiting_local_interaction",
            "sessionId":"session-1"
          }]}
        """.trimIndent(), channel = "ctl")

        assertTrue(state.hasPendingInteraction("runtime-a"))
        assertEquals("request-before-online", state.conversations["runtime-a"]?.interactions?.keys?.single())
        assertEquals("Continue?", state.conversations["runtime-a"]?.interactions?.values?.single()?.title)
    }

    @Test
    fun `interaction snapshot restores the same request and removes completed stale prompts`() {
        val requested = """{
          "type":"runtime.event","runtimeId":"runtime-a","sequence":1,"event":{
            "type":"interaction.requested","request":{
              "runtimeId":"runtime-a","requestId":"request-1","extensionId":"ask-user-question",
              "kind":"confirm","title":"Continue?","expiresAt":9000
            }
          }
        }""".trimIndent()
        var state = reducer.reduce(RemoteState(), requested)
        val original = state.conversations.getValue("runtime-a").interactions.getValue("request-1")

        val reconnecting = state.markReconnecting()
        assertEquals(original, reconnecting.conversations.getValue("runtime-a").interactions.getValue("request-1"))

        state = reducer.reduce(reconnecting, """{
          "type":"runtime.event","runtimeId":"runtime-a","sequence":2,"event":{
            "type":"interaction.snapshot","requests":[{
              "runtimeId":"runtime-a","requestId":"request-1","extensionId":"ask-user-question",
              "kind":"confirm","title":"Continue?","expiresAt":9000
            }]
          }
        }""".trimIndent())
        val restored = state.conversations.getValue("runtime-a").interactions.getValue("request-1")
        assertEquals(original.requestId, restored.requestId)
        assertEquals(original.title, restored.title)

        state = reducer.reduce(state, """{
          "type":"runtime.event","runtimeId":"runtime-a","sequence":3,"event":{
            "type":"interaction.snapshot","requests":[]
          }
        }""".trimIndent())
        assertTrue(state.conversations.getValue("runtime-a").interactions.isEmpty())
    }

    @Test
    fun `window attention follows pending interaction or waiting runtime status`() {
        val pending = RemoteState(
            runtimes = mapOf("runtime-a" to RuntimeSummary("runtime-a", "A", "/a", "running")),
            conversations = mapOf("runtime-a" to RuntimeConversation(
                interactions = mapOf("request-1" to PendingInteraction(
                    requestId = "request-1", extensionId = "extension", kind = "confirm", title = "Continue?",
                    description = null, options = emptyList(), placeholder = null,
                )),
            )),
        )
        assertTrue(pending.hasPendingInteraction("runtime-a"))
        assertTrue(RemoteState(
            runtimes = mapOf("runtime-a" to RuntimeSummary("runtime-a", "A", "/a", "waiting_local_interaction")),
        ).hasPendingInteraction("runtime-a"))
        assertFalse(RemoteState(
            runtimes = mapOf("runtime-a" to RuntimeSummary("runtime-a", "A", "/a", "idle")),
        ).hasPendingInteraction("runtime-a"))
    }

    @Test
    fun `interaction response disconnect keeps request and discards unknown command outcome`() {
        val interaction = PendingInteraction(
            requestId = "request-1",
            extensionId = "ask-user-question",
            kind = "confirm",
            title = "Continue?",
            description = null,
            options = emptyList(),
            placeholder = null,
            responseCommandId = "answer-1",
        )
        val state = RemoteState(
            pendingCommands = mapOf("answer-1" to "runtime-a"),
            conversations = mapOf("runtime-a" to RuntimeConversation(interactions = mapOf("request-1" to interaction))),
        ).markReconnecting()

        assertTrue(state.conversations.getValue("runtime-a").interactions.containsKey("request-1"))
        assertEquals(null, state.conversations.getValue("runtime-a").interactions.getValue("request-1").responseCommandId)
        assertFalse(state.pendingCommands.containsKey("answer-1"))
        assertFalse(state.commandResults.containsKey("answer-1"))
    }

    @Test
    fun `multi-select interaction with impossible bounds fails closed`() {
        val state = reducer.reduce(RemoteState(), """{
          "type":"runtime.event","runtimeId":"runtime-a","sequence":1,"event":{
            "type":"interaction.requested","request":{
              "runtimeId":"runtime-a","requestId":"request-multi","extensionId":"ask-user-question",
              "kind":"multi-select","title":"Pick targets",
              "options":[{"value":"api","label":"API"}],
              "minSelections":2,"maxSelections":1,"expiresAt":9000
            }
          }
        }""".trimIndent())

        assertEquals("手机无法安全渲染此交互，请在电脑端处理。", state.conversations["runtime-a"]?.interactionNotice)
        assertFalse(state.conversations["runtime-a"]?.interactions?.containsKey("request-multi") == true)
    }

    @Test
    fun `tool cards track the projected branch and stay pinned only while in flight`() {
        val toolCallEntry = SessionGraphEntry(
            entryId = "tool-call",
            parentId = null,
            type = "message",
            timestamp = "2026-01-01T00:00:00.000Z",
            data = buildJsonObject {
                put("message", buildJsonObject {
                    put("role", "assistant")
                    put(
                        "content",
                        buildJsonArray {
                            add(buildJsonObject {
                                put("type", "toolCall")
                                put("id", "tool-1")
                                put("name", "bash")
                            })
                        },
                    )
                })
            },
        )
        val state = RemoteState(
            selectedRuntimeId = "runtime-a",
            runtimes = mapOf(
                "runtime-a" to RuntimeSummary(
                    "runtime-a",
                    "A",
                    "/a",
                    "idle",
                    "session-1",
                    sessionGraphSync = true,
                    sessionLeafId = "compaction",
                ),
            ),
            runtimeSessionViews = mapOf(
                "runtime-a" to RuntimeSessionView("runtime-a", "session-1", "tool-call"),
            ),
            sessionGraphs = mapOf(
                "session-1" to SessionGraph(
                    sessionId = "session-1",
                    entries = mapOf("tool-call" to toolCallEntry),
                    cursor = SessionBranchCursor("tool-call"),
                ),
            ),
            conversations = mapOf(
                "runtime-a" to RuntimeConversation(
                    messages = listOf(
                        ChatMessage(
                            messageId = "tool-call",
                            role = "assistant",
                            content = listOf(RemoteContent("tool_call", toolCallId = "tool-1", toolName = "bash")),
                            timestamp = 1,
                        ),
                    ),
                    tools = mapOf("tool-1" to ToolActivity("tool-1", "bash", "finished", detail = "done")),
                ),
            ),
            sessionSyncCommands = mapOf(
                "sync-1" to PendingSessionSync(
                    runtimeId = "runtime-a",
                    sessionId = "session-1",
                    syncId = "sync-1",
                    range = "catchup",
                    targetLeafId = "compaction",
                ),
            ),
        )

        val reduced = reducer.reduce(state, """
          {"type":"runtime.event","runtimeId":"runtime-a","sequence":1,"event":{
            "type":"session.snapshot","sessionId":"session-1","syncId":"sync-1","mode":"replace",
            "range":"catchup","targetLeafId":"compaction","cursor":{"leafId":"compaction"},
            "entries":[
              {"entryId":"tool-call","parentId":null,"type":"message","timestamp":"2026-01-01T00:00:00.000Z","data":{"message":{"role":"assistant","content":[{"type":"toolCall","id":"tool-1","name":"bash"}]}}},
              {"entryId":"compaction","parentId":"tool-call","type":"compaction","timestamp":"2026-01-01T00:00:01.000Z","data":{"summary":"old context"}}
            ]
          }}
        """.trimIndent())

        val conversation = reduced.conversations.getValue("runtime-a")
        assertEquals(listOf("compaction"), conversation.messages.map(ChatMessage::messageId))
        assertTrue("compaction tool card must be cleared", conversation.tools.isEmpty())

        val inFlightState = RemoteState(
            selectedRuntimeId = "runtime-a",
            runtimes = mapOf(
                "runtime-a" to RuntimeSummary(
                    "runtime-a",
                    "A",
                    "/a",
                    "running",
                    "session-1",
                    sessionGraphSync = true,
                    sessionLeafId = "assistant-1",
                ),
            ),
            runtimeSessionViews = mapOf(
                "runtime-a" to RuntimeSessionView("runtime-a", "session-1", "assistant-1"),
            ),
            sessionGraphs = mapOf(
                "session-1" to SessionGraph(
                    sessionId = "session-1",
                    entries = mapOf(
                        "assistant-1" to SessionGraphEntry(
                            entryId = "assistant-1",
                            parentId = null,
                            type = "message",
                            timestamp = "2026-01-01T00:00:00.000Z",
                            data = buildJsonObject {
                                put("message", buildJsonObject {
                                    put("role", "assistant")
                                    put("content", "working")
                                })
                            },
                        ),
                    ),
                    cursor = SessionBranchCursor("assistant-1"),
                ),
            ),
            conversations = mapOf(
                "runtime-a" to RuntimeConversation(
                    tools = mapOf("tool-1" to ToolActivity("tool-1", "bash", "updated", detail = "still running")),
                ),
            ),
            sessionSyncCommands = mapOf(
                "sync-1" to PendingSessionSync(
                    runtimeId = "runtime-a",
                    sessionId = "session-1",
                    syncId = "sync-1",
                    range = "catchup",
                    targetLeafId = "assistant-1",
                ),
            ),
        )

        val inFlightReduced = reducer.reduce(inFlightState, """
          {"type":"runtime.event","runtimeId":"runtime-a","sequence":1,"event":{
            "type":"session.snapshot","sessionId":"session-1","syncId":"sync-1","mode":"replace",
            "range":"catchup","targetLeafId":"assistant-1","cursor":{"leafId":"assistant-1"},
            "entries":[
              {"entryId":"assistant-1","parentId":null,"type":"message","timestamp":"2026-01-01T00:00:00.000Z","data":{"message":{"role":"assistant","content":"working"}}}
            ]
          }}
        """.trimIndent())

        val inFlightConversation = inFlightReduced.conversations.getValue("runtime-a")
        assertEquals(listOf("assistant-1"), inFlightConversation.messages.map(ChatMessage::messageId))
        assertTrue("an in-flight tool must keep its live card", inFlightConversation.tools.containsKey("tool-1"))
    }

    @Test
    fun `device ready requests graph sync only for selected runtime`() {
        val selected = reducer.reduce(
            RemoteState(selectedRuntimeId = "runtime-b"),
            """{"type":"device.ready","deviceId":"phone-1","runtimes":[
              {"runtimeId":"runtime-a","name":"A","cwd":"/a","status":"idle","sessionId":"same","sessionGraphSync":true},
              {"runtimeId":"runtime-b","name":"B","cwd":"/b","status":"idle","sessionId":"same","sessionGraphSync":true}
            ]}""".trimIndent(),
            channel = "ctl",
        )
        assertEquals(setOf("runtime-b"), selected.sessionSyncRequests)
    }

    @Test
    fun `device ready releases an orphaned history spinner but keeps its boundary`() {
        val initial = RemoteState(
            connection = RelayConnection.ONLINE,
            runtimes = mapOf(
                "runtime-a" to RuntimeSummary(
                    "runtime-a", "A", "/a", "idle", "same",
                    sessionGraphSync = true,
                    sessionLeafId = "leaf",
                ),
            ),
            runtimeSessionViews = mapOf("runtime-a" to RuntimeSessionView("runtime-a", "same", "leaf")),
            sessionHistory = mapOf(
                "runtime-a" to SessionHistoryState(
                    "same", "leaf", "deep", hasOlder = true,
                    loading = true, requestId = "history-command",
                ),
            ),
            sessionSyncCommands = mapOf(
                "history-command" to PendingSessionSync(
                    runtimeId = "runtime-a",
                    sessionId = "same",
                    syncId = "history-1",
                    range = "history",
                    targetLeafId = "leaf",
                    beforeEntryId = "deep",
                ),
            ),
        )

        val changed = reducer.reduce(initial, """
          {"type":"device.ready","deviceId":"phone-1","runtimes":[
            {"runtimeId":"runtime-a","name":"A","cwd":"/a","status":"idle","sessionId":"same",
             "sessionGraphSync":true,"sessionLeafId":"leaf"}
          ]}
        """.trimIndent(), channel = "ctl")

        assertEquals("deep", changed.sessionHistory["runtime-a"]?.oldestEntryId)
        assertEquals(true, changed.sessionHistory["runtime-a"]?.hasOlder)
        assertEquals(false, changed.sessionHistory["runtime-a"]?.loading)
        assertEquals(null, changed.sessionHistory["runtime-a"]?.requestId)
    }

    @Test
    fun `same-session runtimes keep independent chats and routing state`() {
        val ready = """{
          "type":"device.ready","deviceId":"phone-1","runtimes":[
            {"runtimeId":"runtime-a","name":"A","cwd":"/a","status":"idle","sessionId":"same"},
            {"runtimeId":"runtime-b","name":"B","cwd":"/b","status":"idle","sessionId":"same"}
          ]
        }""".trimIndent()
        fun started(runtime: String, id: String, text: String) = """{
          "type":"runtime.event","runtimeId":"$runtime","sequence":1,"event":{
            "type":"message.started","message":{
              "messageId":"$id","role":"assistant","content":[{"type":"text","text":"$text"}],"timestamp":1
            }
          }
        }""".trimIndent()

        var state = reducer.reduce(RemoteState(), ready, channel = "ctl")
        state = reducer.reduce(state, started("runtime-a", "a1", "only a"))
        state = reducer.reduce(state, started("runtime-b", "b1", "only b"))

        assertEquals("only a", state.conversations["runtime-a"]?.messages?.single()?.content?.single()?.text)
        assertEquals("only b", state.conversations["runtime-b"]?.messages?.single()?.content?.single()?.text)
        state = state.copy(selectedRuntimeId = "runtime-a")
        state = reducer.reduce(state, """{"type":"runtime.offline","runtimeId":"runtime-a","reason":"disconnected"}""")
        assertFalse(state.runtimes.containsKey("runtime-a"))
        assertEquals(null, state.selectedRuntimeId)
        assertEquals("B", state.runtimes["runtime-b"]?.name)
    }

    // ── 进程激活（spec §8）────────────────────────────────────────────────────

    @Test
    fun `session list result merges catalog without clobbering history cache`() {
        val initial = RemoteState(
            sessionListRequests = setOf("req-1"),
            sessions = mapOf(
                "s-1" to SessionCatalogEntry(
                    sessionId = "s-1",
                    cwd = "C:\\old",
                    messageCount = 12,
                    hasHistoryCache = true,
                    hostname = "PC",
                ),
            ),
        )
        val state = reducer.reduce(
            initial,
            """
            {"type":"session.list.result","requestId":"req-1","sessions":[
              {"sessionId":"s-1","cwd":"C:\\old","modifiedAt":50,"agentKind":"pi"},
              {"sessionId":"s-2","cwd":"D:\\work","modifiedAt":10,"agentKind":"codex"}
            ]}
            """.trimIndent(),
        )
        assertTrue(state.sessionListRequests.isEmpty())
        val merged = state.sessions["s-1"]!!
        // 只合并不替换：历史缓存标记与已数过的消息数不能被磁盘扫描冲掉。
        assertTrue(merged.hasHistoryCache)
        assertEquals(12, merged.messageCount)
        assertEquals("pi", merged.agentKind)
        val fresh = state.sessions["s-2"]!!
        assertEquals("codex", fresh.agentKind)
        assertEquals("D:\\work", fresh.cwd)
    }

    @Test
    fun `archive state survives late lists and runtime metadata while history stays available`() {
        val original = SessionCatalogEntry("s-1", cwd = "/repo", agentKind = "pi", hasHistoryCache = true, archived = false)
        val initial = RemoteState(
            sessions = mapOf("s-1" to original),
            sessionListRequests = setOf("old-list"),
            sessionListRequestEpochs = mapOf("old-list" to 0),
            sessionArchiveRequests = mapOf("archive" to "s-1"),
        )
        val archived = reducer.reduce(initial, """
            {"type":"session.archive.changed","requestId":"archive","agentKind":"pi","sessionId":"s-1","archived":true}
        """)
        assertTrue(archived.sessionArchiveRequests.isEmpty())
        assertTrue(archived.sessionListRequests.contains("old-list"))
        assertTrue(archived.sessions["s-1"]!!.hasHistoryCache)
        val late = reducer.reduce(archived, """
            {"type":"session.list.result","requestId":"old-list","sessions":[
              {"sessionId":"s-1","agentKind":"pi","cwd":"/repo","archived":false}]}
        """)
        assertEquals(archived.sessionListEpoch, late.sessionListEpoch)
        assertTrue(late.sessionListRequests.isEmpty())
        val runtimeMetadata = reducer.reduce(late, """
            {"type":"runtime.online","runtime":{"runtimeId":"runtime","name":"Pi","cwd":"/repo","status":"idle","sessionId":"s-1"}}
        """)
        assertEquals(true, runtimeMetadata.sessions["s-1"]?.archived)
        assertTrue(cachedHistoryTree(runtimeMetadata.copy(hostId = "paired-host")).flatMap { it.directories }.flatMap { it.sessions }.single().isArchived)

        val restoring = runtimeMetadata.copy(sessionArchiveRequests = mapOf("restore" to "s-1"))
        val failed = reducer.reduce(restoring, """
            {"type":"protocol.error","requestId":"restore","code":"session_conflict","message":"conflict"}
        """)
        assertEquals(true, failed.sessions["s-1"]?.archived)
        assertTrue(failed.sessionArchiveRequests.isEmpty())
        val restored = reducer.reduce(failed, """
            {"type":"session.archive.changed","agentKind":"pi","sessionId":"s-1","archived":false}
        """)
        assertEquals(false, restored.sessions["s-1"]?.archived)
        assertTrue(restored.sessions["s-1"]!!.hasHistoryCache)
        val reconnected = reducer.reduce(archived.copy(sessionListRequests = setOf("new-list")), """
            {"type":"session.list.result","requestId":"new-list","sessions":[
              {"sessionId":"s-1","agentKind":"pi","cwd":"/repo","archived":false}]}
        """)
        assertEquals(false, reconnected.sessions["s-1"]?.archived)
    }

    @Test
    fun `session list result ignores unknown request id`() {
        val initial = RemoteState(sessionListRequests = setOf("req-1"))
        val state = reducer.reduce(
            initial,
            """{"type":"session.list.result","requestId":"other","sessions":[]}""",
        )
        // requestId 不匹配时不消费也不合并（迟到/串线的响应）。
        assertEquals(setOf("req-1"), state.sessionListRequests)
        assertTrue(state.sessions.isEmpty())
    }

    @Test
    fun `session browse result fills the active browse session`() {
        val browse = SessionBrowseState(requestId = "b-1", path = "C:\\", isLoading = true)
        val initial = RemoteState(sessionBrowse = browse)
        val state = reducer.reduce(
            initial,
            """
            {"type":"session.browse.result","requestId":"b-1","path":"C:\\Users","parent":"C:\\",
             "entries":[{"name":"work","isDir":true,"hasSessions":true},{"name":"temp","isDir":true,"hasSessions":false}]}
            """.trimIndent(),
        )
        val updated = state.sessionBrowse!!
        assertFalse(updated.isLoading)
        assertEquals("C:\\Users", updated.path)
        assertEquals("C:\\", updated.parent)
        // 有过会话的目录排前。
        assertEquals("work", updated.entries.first().name)
        assertTrue(updated.entries.first().hasSessions)
    }

    @Test
    fun `session browse result for stale request id is ignored`() {
        val browse = SessionBrowseState(requestId = "b-2", path = "C:\\", isLoading = true)
        val state = reducer.reduce(
            RemoteState(sessionBrowse = browse),
            """{"type":"session.browse.result","requestId":"b-1","path":"C:\\","entries":[]}""",
        )
        assertEquals(browse, state.sessionBrowse)
    }

    @Test
    fun `session activated records notice and clears pending request`() {
        val initial = RemoteState(sessionActivateRequests = setOf("a-1"))
        val state = reducer.reduce(
            initial,
            """{"type":"session.activated","requestId":"a-1","agentKind":"codex","sessionId":"s-9","spawnMode":"headless"}""",
        )
        assertTrue(state.sessionActivateRequests.isEmpty())
        val activation = state.sessionActivation!!
        assertEquals("codex", activation.agentKind)
        assertEquals("s-9", activation.sessionId)
        assertEquals("headless", activation.spawnMode)
    }

    @Test
    fun `protocol error with session request id clears the pending state`() {
        val browse = SessionBrowseState(requestId = "b-1", path = "C:\\", isLoading = true)
        val initial = RemoteState(
            sessionListRequests = setOf("l-1"),
            sessionActivateRequests = setOf("a-1"),
            sessionBrowse = browse,
        )
        val state = reducer.reduce(
            initial,
            """{"type":"protocol.error","code":"cwd_missing","message":"目录不存在","requestId":"a-1"}""",
        )
        assertTrue(state.sessionActivateRequests.isEmpty())
        // 电脑端给的中文说明比通用映射更具体，直接用它（中继自己的英文短句才回落到映射）。
        assertEquals("目录不存在", state.error)
        // 其它两个请求不受影响。
        assertEquals(setOf("l-1"), state.sessionListRequests)
        assertTrue(state.sessionBrowse!!.isLoading)
    }
}
