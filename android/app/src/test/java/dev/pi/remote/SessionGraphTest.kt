package dev.pi.remote

import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SessionGraphTest {
    private fun entry(id: String, parentId: String?, role: String = "user", text: String = id) = SessionGraphEntry(
        entryId = id,
        parentId = parentId,
        type = "message",
        timestamp = "2026-01-01T00:00:00.000Z",
        data = buildJsonObject {
            put("message", buildJsonObject {
                put("role", role)
                put("content", text)
            })
        },
    )

    @Test
    fun `projection follows the selected leaf and excludes sibling branches`() {
        val graph = fixtureGraph(
            sessionId = "session-1",
            entries = listOf(
                entry("root", null),
                entry("shared", "root", text = "shared"),
                entry("branch-a", "shared", role = "assistant", text = "A"),
                entry("branch-b", "shared", role = "assistant", text = "B"),
            ).associateBy(SessionGraphEntry::entryId),
            cursor = SessionBranchCursor("branch-a"),
        )

        val projected = projectSessionGraph(graph)

        assertEquals(listOf("root", "shared", "branch-a"), projected.messages.map(ChatMessage::messageId))
        assertFalse(projected.messages.any { it.content.any { content -> content.text == "B" } })
    }

    @Test
    fun `projection renders the window the producer declared, not the native compaction fields`() {
        val compaction = SessionGraphEntry(
            entryId = "compaction",
            parentId = "kept",
            type = "compaction",
            timestamp = "2026-01-01T00:00:03.000Z",
            data = buildJsonObject {
                put("summary", "old context")
                put("firstKeptEntryId", "kept")
            },
        )
        val after = entry("after", "compaction", text = "after")
        val entries = listOf(
            entry("root", null),
            entry("old", "root", text = "old"),
            entry("kept", "old", text = "kept"),
            compaction,
            after,
        )
        // 产出方已经解释好：窗口从 kept 开始，摘要渲染在窗口顶部。App 只照做。
        val graph = fixtureGraph("session-1", entries, SessionBranchCursor("after")).copy(
            display = fixtureDisplay(entries) + ("compaction" to DisplayEntry(
                displayId = "compaction", entryId = "compaction", nativeType = "compaction", kind = "summary",
                message = ChatMessage("compaction", "system", listOf(RemoteContent("text", "压缩摘要：old context")), 0L),
                anchor = DISPLAY_ANCHOR_HEAD,
            )),
            displayWindowStart = "kept",
        )

        val projected = projectSessionGraph(graph)

        assertEquals(listOf("compaction", "kept", "after"), projected.messages.map(ChatMessage::messageId))
        assertEquals("压缩摘要：old context", projected.messages.first().content.single().text)

        // 没有显示结果的条目只是不渲染，不是把整段会话丢掉，也不改变分支权威。
        val unsupported = fixtureGraph(
            "session-1",
            entries + entry("unknown", "compaction").copy(type = "future_semantic_entry"),
            SessionBranchCursor("unknown"),
        ).copy(display = graph.display, displayWindowStart = "kept")
        val unsupportedProjection = projectSessionGraph(unsupported)
        assertEquals(null, unsupportedProjection.error)
        // 没见过的条目没有显示结果，就不渲染；它前面的内容照常按窗口与锚点渲染。
        assertEquals(listOf("compaction", "kept"), unsupportedProjection.messages.map(ChatMessage::messageId))
        assertEquals("unknown", unsupported.cursor.leafId)
    }

    @Test
    fun `projection preserves bash output and hides non-display legacy custom messages`() {
        val bash = SessionGraphEntry(
            entryId = "bash",
            parentId = null,
            type = "message",
            timestamp = "2026-01-01T00:00:00.000Z",
            data = buildJsonObject {
                put("message", buildJsonObject {
                    put("role", "bashExecution")
                    put("command", "pwd")
                    put("output", "/workspace")
                    put("timestamp", 1)
                })
            },
        )
        val hidden = SessionGraphEntry(
            entryId = "hidden",
            parentId = "bash",
            type = "message",
            timestamp = "2026-01-01T00:00:01.000Z",
            data = buildJsonObject {
                put("message", buildJsonObject {
                    put("role", "custom")
                    put("display", false)
                    put("content", "internal")
                    put("timestamp", 2)
                })
            },
        )
        val entries = listOf(bash, hidden)
        // 产出方为 bash 合成了一行 system 文本，并且明确没有回传隐藏的自定义消息。
        val graph = fixtureGraph("session-1", entries, SessionBranchCursor("hidden")).copy(
            display = mapOf("bash" to DisplayEntry(
                displayId = "bash", entryId = "bash", nativeType = "message", kind = "message",
                message = ChatMessage("bash", "system", listOf(RemoteContent("text", "$ pwd\n/workspace")), 1L),
            )),
        )

        val projected = projectSessionGraph(graph)

        assertEquals(listOf("bash"), projected.messages.map(ChatMessage::messageId))
        assertEquals("$ pwd\n/workspace", projected.messages.single().content.single().text)
        // 隐藏的条目身份还在图里，但没有显示行就没有内容：本机不再自己判断 display 开关。
        assertTrue("hidden" in graph.entries)
        assertNull(graph.display["hidden"])
    }

    @Test
    fun `completed Codex tool calls remain renderable after canonical projection`() {
        val tool = SessionGraphEntry(
            entryId = "tool-1",
            parentId = null,
            type = "message",
            timestamp = "1970-01-01T00:00:00.000Z",
            data = buildJsonObject {
                put("message", buildJsonObject {
                    put("role", "assistant")
                    put("content", buildJsonArray {
                        add(buildJsonObject {
                            put("type", "tool_call")
                            put("toolCallId", "tool-1")
                            put("toolName", "commandExecution")
                            put("arguments", buildJsonObject { put("command", "npm test") })
                        })
                    })
                })
            },
        )

        // 工具调用的形状（含参数）也由产出方归一，App 只渲染。
        val graph = fixtureGraph("session-1", listOf(tool), SessionBranchCursor(tool.entryId)).copy(
            display = mapOf("tool-1" to DisplayEntry(
                displayId = "tool-1", entryId = "tool-1", nativeType = "message", kind = "message",
                message = ChatMessage("tool-1", "assistant", listOf(RemoteContent(
                    type = "tool_call", toolCallId = "tool-1", toolName = "commandExecution",
                    arguments = buildJsonObject { put("command", "npm test") },
                )), 0L),
            )),
        )
        val projected = projectSessionGraph(graph)
        val presentation = buildConversationPresentation(projected.messages)

        assertEquals(listOf("tool-1"), presentation.messages.map(ChatMessage::messageId))
        assertEquals("tool_call", presentation.messages.single().content.single().type)
        assertEquals("tool-1", presentation.messages.single().content.single().toolCallId)
    }

    @Test
    fun `projection reads explicit timing and leaves native custom payloads opaque`() {
        val assistant = entry("assistant", null, role = "assistant", text = "done")
        val timing = SessionGraphEntry(
            entryId = "timing",
            parentId = "assistant",
            type = "custom",
            timestamp = "2026-01-01T00:00:01.000Z",
            data = buildJsonObject {
                put("customType", "pi_remote_turn_timing")
                put("data", buildJsonObject {
                    put("turnId", "turn-1")
                    put("startedAt", 1_000)
                    put("durationMs", 250)
                    put("turnIndex", 0)
                    put("messageId", "assistant")
                })
            },
        )
        val graph = fixtureGraph(
            sessionId = "session-1",
            entries = listOf(assistant, timing).associateBy(SessionGraphEntry::entryId),
            cursor = SessionBranchCursor("timing"),
        )

        assertTrue(projectSessionGraph(graph).turnTimings.isEmpty())
        val explicit = TurnTiming("turn-1", 1_000, durationMs = 250, turnIndex = 0, messageId = "assistant")
        val projected = projectSessionGraph(graph.copy(turnTimings = mapOf(explicit.turnId to explicit)))
        assertEquals(listOf(explicit), projected.turnTimings)
    }

    @Test
    fun `append merges a new branch entry and keeps an existing identical entry idempotent`() {
        val graph = fixtureGraph(
            sessionId = "session-1",
            entries = mapOf("root" to entry("root", null)),
            cursor = SessionBranchCursor("root"),
        )
        val snapshot = SessionGraphSnapshot(
            sessionId = "session-1",
            syncId = "sync-1",
            cursor = SessionBranchCursor("child"),
            mode = "append",
            entries = listOf(entry("root", null), entry("child", "root", role = "assistant")),
        )

        val merged = graph.merge(snapshot)

        assertEquals(setOf("root", "child"), merged.entries.keys)
        assertEquals("child", merged.cursor.leafId)
    }

    @Test
    fun `append detects conflicts and replace preserves canonical sibling entries`() {
        val graph = fixtureGraph(
            sessionId = "session-1",
            entries = mapOf("root" to entry("root", null)),
            cursor = SessionBranchCursor("root"),
        )
        val append = SessionGraphSnapshot(
            sessionId = "session-1",
            syncId = "sync-1",
            cursor = SessionBranchCursor("root"),
            mode = "append",
            entries = listOf(entry("root", null, text = "different")),
        )

        val conflict = runCatching { graph.merge(append) }.exceptionOrNull()
        assertEquals("entry_conflict", conflict?.message)

        val replacement = append.copy(
            mode = "replace",
            entries = listOf(entry("replacement", null)),
            cursor = SessionBranchCursor("replacement"),
        )
        assertEquals(setOf("root", "replacement"), graph.merge(replacement).entries.keys)
    }

    @Test
    fun `replace rejects a divergent entry and preserves the committed tree`() {
        val graph = fixtureGraph(
            sessionId = "session-1",
            entries = mapOf("root" to entry("root", null, text = "local")),
            cursor = SessionBranchCursor("root"),
        )
        val replacement = SessionGraphSnapshot(
            sessionId = "session-1",
            syncId = "sync-1",
            cursor = SessionBranchCursor("root"),
            mode = "replace",
            entries = listOf(entry("root", null, text = "runtime")),
            range = "catchup",
            complete = false,
        )

        assertEquals("entry_conflict", runCatching { graph.merge(replacement) }.exceptionOrNull()?.message)
        assertEquals(entry("root", null, text = "local"), graph.entries["root"])
    }

    @Test
    fun `partial catchup advances the canonical cursor to the persisted frontier`() {
        val graph = SessionGraph("session-1")
        val partial = graph.merge(
            SessionGraphSnapshot(
                sessionId = "session-1",
                syncId = "catchup-partial",
                cursor = SessionBranchCursor("target"),
                mode = "replace",
                entries = listOf(
                    entry("root", null),
                    entry("frontier", "root"),
                ),
                range = "catchup",
                targetLeafId = "target",
                complete = false,
            ),
        )

        assertEquals(setOf("root", "frontier"), partial.entries.keys)
        assertEquals("frontier", partial.cursor.leafId)
        assertFalse(partial.hasCompleteEntryChain("target"))
    }

    @Test
    fun `completed wire range cannot prove continuity when memory lacks ancestors`() {
        val graph = fixtureGraph(
            sessionId = "session-1",
            entries = mapOf("frontier" to entry("frontier", "missing")),
            cursor = SessionBranchCursor("frontier"),
        )
        val completed = graph.merge(
            SessionGraphSnapshot(
                sessionId = "session-1",
                syncId = "catchup-complete",
                cursor = SessionBranchCursor("target"),
                mode = "append",
                entries = listOf(entry("target", "frontier")),
                range = "catchup",
                targetLeafId = "target",
                complete = true,
            ),
        )

        assertFalse(completed.hasCompleteEntryChain("target"))
        assertFalse(completed.hasCompleteCursor("target"))
    }

    @Test
    fun `catchup resumes from the persisted frontier when the target is not cached yet`() {
        val graph = fixtureGraph(
            sessionId = "session-1",
            entries = listOf(
                entry("root", null),
                entry("frontier", "root"),
            ).associateBy(SessionGraphEntry::entryId),
            cursor = SessionBranchCursor("frontier"),
        )

        assertEquals("frontier", graph.catchUpFrontier("target"))
        assertEquals(null, graph.copy(cursor = SessionBranchCursor("missing")).catchUpFrontier("target"))
        assertEquals(
            null,
            graph.copy(
                entries = graph.entries + ("target" to entry("target", "missing")),
                cursor = SessionBranchCursor("target"),
            ).catchUpFrontier("target"),
        )
    }

    @Test
    fun `projection refreshes the full branch when catchup completes on the same leaf`() {
        val graph = fixtureGraph(
            sessionId = "session-1",
            entries = listOf(
                entry("tail", "root"),
                entry("leaf", "tail", role = "assistant"),
            ).associateBy(SessionGraphEntry::entryId),
            cursor = SessionBranchCursor("leaf"),
        )
        val completed = graph.merge(
            SessionGraphSnapshot(
                sessionId = "session-1",
                syncId = "catchup-final",
                cursor = SessionBranchCursor("leaf"),
                mode = "append",
                entries = listOf(entry("root", null), entry("tail", "root")),
                range = "catchup",
                complete = true,
                display = fixtureDisplayBatch(listOf(entry("root", null), entry("tail", "root"))),
            ),
        )

        val projection = completed.projectLeafDeltaProjection(
            oldLeafId = "leaf",
            newLeafId = "leaf",
            currentMessages = listOf(
                ChatMessage("tail", "user", listOf(RemoteContent("text", "tail")), 1),
                ChatMessage("leaf", "assistant", listOf(RemoteContent("text", "leaf")), 2),
            ),
        )

        assertEquals(listOf("root", "tail", "leaf"), projection.messages.map(ChatMessage::messageId))
    }

    @Test
    fun `leaf append keeps new graph entries before an in-flight overlay`() {
        val graph = fixtureGraph(
            sessionId = "session-1",
            entries = listOf(
                entry("root", null),
                entry("user", "root"),
                entry("assistant", "user", role = "assistant"),
            ).associateBy(SessionGraphEntry::entryId),
            cursor = SessionBranchCursor("assistant"),
        )

        val projection = graph.projectLeafDeltaProjection(
            oldLeafId = "user",
            newLeafId = "assistant",
            currentMessages = listOf(
                ChatMessage("root", "user", listOf(RemoteContent("text", "root")), 1),
                ChatMessage("user", "user", listOf(RemoteContent("text", "user")), 2),
                ChatMessage("live", "assistant", listOf(RemoteContent("text", "streaming")), 3),
            ),
        )

        assertEquals(listOf("root", "user", "assistant", "live"), projection.messages.map(ChatMessage::messageId))
    }

    @Test
    fun `branch switch keeps canonical suffix ahead of live overlay`() {
        val graph = fixtureGraph(
            sessionId = "session-1",
            entries = listOf(
                entry("root", null),
                entry("old", "root", role = "assistant", text = "old"),
                entry("new", "root", role = "assistant", text = "new"),
            ).associateBy(SessionGraphEntry::entryId),
        )

        val projection = graph.projectLeafDeltaProjection(
            oldLeafId = "old",
            newLeafId = "new",
            currentMessages = listOf(
                ChatMessage("root", "user", listOf(RemoteContent("text", "root")), 1),
                ChatMessage("old", "assistant", listOf(RemoteContent("text", "old")), 2),
                ChatMessage("live", "assistant", listOf(RemoteContent("text", "live")), 3),
            ),
        )

        assertEquals(listOf("root", "new", "live"), projection.messages.map(ChatMessage::messageId))
    }

    @Test
    fun `partial projection reports missing parent while retaining the known tail`() {
        val graph = fixtureGraph(
            sessionId = "session-1",
            entries = mapOf("tail" to entry("tail", "missing")),
            cursor = SessionBranchCursor("tail"),
        )

        val projection = projectSessionGraph(graph)

        assertEquals(listOf("tail"), projection.messages.map(ChatMessage::messageId))
        assertEquals("missing_parent", projection.error)
    }

    @Test
    fun `append stores an incomplete target chain without claiming continuity`() {
        val graph = SessionGraph("session-1")
        val snapshot = SessionGraphSnapshot(
            sessionId = "session-1",
            syncId = "sync-incomplete",
            cursor = SessionBranchCursor("child"),
            mode = "append",
            entries = listOf(entry("child", "missing")),
        )

        val merged = graph.merge(snapshot)
        assertEquals(setOf("child"), merged.entries.keys)
        assertFalse(merged.hasCompleteCursor("child"))
    }

    @Test
    fun `firstUserMessageTitle returns the first user message of the branch`() {
        val graph = fixtureGraph(
            sessionId = "session-1",
            entries = listOf(
                entry("u1", null, role = "user", text = "第一句：开始提问"),
                entry("a1", "u1", role = "assistant", text = "好的"),
                entry("u2", "a1", role = "user", text = "第二句"),
            ).associateBy(SessionGraphEntry::entryId),
            cursor = SessionBranchCursor("u2"),
        )

        assertEquals("第一句：开始提问", graph.firstUserMessageTitle())
    }

    @Test
    fun `firstUserMessageTitle returns null when the branch has no user message`() {
        val graph = fixtureGraph(
            sessionId = "session-1",
            entries = listOf(
                entry("a1", null, role = "assistant", text = "hello"),
            ).associateBy(SessionGraphEntry::entryId),
            cursor = SessionBranchCursor("a1"),
        )

        assertNull(graph.firstUserMessageTitle())
    }

    @Test
    fun `firstUserMessageTitle returns null for an empty graph`() {
        assertNull(SessionGraph("session-1").firstUserMessageTitle())
    }

    @Test
    fun `firstUserMessageTitle returns null when the leaf is missing from the graph`() {
        val graph = fixtureGraph(
            sessionId = "session-1",
            entries = listOf(entry("u1", null, role = "user", text = "ask")).associateBy(SessionGraphEntry::entryId),
            cursor = SessionBranchCursor("unknown-leaf"),
        )

        assertNull(graph.firstUserMessageTitle())
    }

    /**
     * 失败回合的文案归产出方：它知道该用哪一份失败文本（流里发的还是 provider 回的）。
     * App 不看 stopReason，也不拿 errorMessage 兜底——没有显示结果就是「还没解释」，不猜。
     */
    @Test
    fun `a failed turn renders from its display row and stays empty without one`() {
        val failed = SessionGraphEntry(
            entryId = "failed",
            parentId = "u1",
            type = "message",
            timestamp = "2026-01-01T00:00:01.000Z",
            data = buildJsonObject {
                put(
                    "message",
                    buildJsonObject {
                        put("role", "assistant")
                        put("content", kotlinx.serialization.json.buildJsonArray { })
                        put("stopReason", "error")
                        put("errorMessage", "OpenAI API error (504): Gateway Time-out")
                    },
                )
                put("remoteFailure", "OpenAI API error (504): Gateway Time-out\nprovider=linkbus, model=gpt-5.6-terra")
            },
        )
        val entries = listOf(entry("u1", null, role = "user", text = "ask"), failed)
        val graph = fixtureGraph("session-1", entries, SessionBranchCursor("failed"))
        // 夹具只认字符串正文；失败行的正文与 isError 由产出方给，所以这里显式替换。
        val withFailure = graph.copy(display = graph.display + ("failed" to DisplayEntry(
            displayId = "failed", entryId = "failed", nativeType = "message", kind = "message",
            message = ChatMessage(
                "failed", "assistant",
                listOf(RemoteContent(
                    type = "text",
                    text = "OpenAI API error (504): Gateway Time-out\nprovider=linkbus, model=gpt-5.6-terra",
                )),
                1L,
                isError = true,
            ),
        )))

        val message = projectSessionGraph(withFailure).messages.single { it.messageId == "failed" }

        assertEquals("assistant", message.role)
        assertTrue(message.isError == true)
        assertEquals(
            "OpenAI API error (504): Gateway Time-out\nprovider=linkbus, model=gpt-5.6-terra",
            message.content.single().text,
        )
        // stopReason / errorMessage / remoteFailure 都在条目的原生形状里，本机不再读它们：
        // 产出方没给正文就渲染空行，不会自己拼一行「失败原因」，也不会自己点亮 isError。
        val bare = projectSessionGraph(graph).messages.single { it.messageId == "failed" }
        assertNull(bare.isError)
        assertTrue(bare.content.isEmpty())
    }

    @Test
    fun `display window prunes older path entries and keeps everything when it is not on the path`() {
        val entries = listOf(
            entry("u1", null, text = "旧问题"),
            entry("a1", "u1", role = "assistant", text = "旧回答"),
            entry("u2", "a1", text = "新问题"),
        )
        val graph = fixtureGraph("session-1", entries, SessionBranchCursor("u2"))
            .copy(displayWindowStart = "a1")

        assertEquals(listOf("a1", "u2"), projectSessionGraph(graph).messages.map(ChatMessage::messageId))
        // 窗口起点不在手上的这段路径里：整段保留。误删比多显示更糟。
        assertEquals(
            listOf("u1", "a1", "u2"),
            projectSessionGraph(graph.copy(displayWindowStart = "native-tail")).messages.map(ChatMessage::messageId),
        )
        // 窗口只影响渲染；历史权威（条目与分支）不受影响。
        assertEquals(setOf("u1", "a1", "u2"), graph.entries.keys)
    }

    @Test
    fun `anchored rows render at the window top and undisplayable rows keep identity without content`() {
        val entries = listOf(entry("u1", null, text = "问题"), entry("a1", "u1", role = "assistant", text = "回答"))
        val graph = fixtureGraph("session-1", entries, SessionBranchCursor("a1")).copy(
            display = fixtureDisplay(entries).mapValues { (id, row) ->
                if (id == "a1") row.copy(anchor = DISPLAY_ANCHOR_HEAD) else row
            } + ("future" to DisplayEntry(
                displayId = "future", entryId = null, nativeType = "brand_new_event",
                kind = "undisplayable", message = null, reason = "unknown_native_type",
            )),
        )

        assertEquals(listOf("a1", "u1"), projectSessionGraph(graph).messages.map(ChatMessage::messageId))
        assertEquals("unknown_native_type", graph.display.getValue("future").reason)
    }

    @Test
    fun `a projection version mismatch is reported instead of rendering another version's semantics`() {
        val entries = listOf(entry("u1", null, text = "问题"))
        val graph = fixtureGraph("session-1", entries, SessionBranchCursor("u1"))
            .copy(displayVersion = DISPLAY_PROJECTION_VERSION + 1)

        assertEquals(
            "显示投影版本不匹配（Host：${DISPLAY_PROJECTION_VERSION + 1}），请更新 App",
            projectSessionGraph(graph).error,
        )
    }

    // ADR-0039 §5：投影按行复用——同一条显示结果在多次投影中是同一个对象，
    // 这样 Compose 才能跳过重组；只有依赖变化的那一行才会是新对象。
    @Test
    fun `projection reuses unchanged display rows`() {
        val display = mapOf(
            "row-a" to DisplayEntry(displayId = "row-a", entryId = "row-a", kind = "message",
                message = ChatMessage("row-a", "assistant", emptyList(), 1)),
            "row-b" to DisplayEntry(displayId = "row-b", entryId = "row-b", kind = "message",
                message = ChatMessage("row-b", "assistant", emptyList(), 2)),
        )
        val graph = fixtureGraph(
            sessionId = "session-1",
            entries = listOf(
                entry("root", null),
                entry("row-a", "root", role = "assistant"),
                entry("row-b", "row-a", role = "assistant"),
            ).associateBy(SessionGraphEntry::entryId),
            cursor = SessionBranchCursor("row-b"),
        ).copy(display = display)
        val first = projectSessionGraph(graph)
        val second = projectSessionGraph(graph.copy(displayWindowStart = null))
        assertEquals(first.messages.map { it.messageId }, second.messages.map { it.messageId })
        for (index in first.messages.indices) {
            assertTrue(first.messages[index] === second.messages[index])
        }
    }

    // 新会话没有本地缓存不是缺口：把两种情况分开，否则每个新 Pi 会话顶部都会挂一条错误。
    @Test
    fun `a new session without local cache is not reported as a gap`() {
        assertEquals(FirstPageOutcome.NO_LOCAL_CACHE, firstPageOutcome(null, hasAnyLocalData = false))
        assertEquals(FirstPageOutcome.GAP, firstPageOutcome(null, hasAnyLocalData = true))
        val graph = fixtureGraph("session-1", mapOf("tail" to entry("tail", null)), SessionBranchCursor("tail"))
        assertEquals(FirstPageOutcome.LOADED, firstPageOutcome(graph, hasAnyLocalData = false))
    }
}
