package dev.pi.remote

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SessionGraphTest {
    private val json = Json { ignoreUnknownKeys = true }

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
        val graph = SessionGraph(
            sessionId = "session-1",
            entries = listOf(
                entry("root", null),
                entry("shared", "root", text = "shared"),
                entry("branch-a", "shared", role = "assistant", text = "A"),
                entry("branch-b", "shared", role = "assistant", text = "B"),
            ).associateBy(SessionGraphEntry::entryId),
            cursor = SessionBranchCursor("branch-a"),
        )

        val projected = projectSessionGraph(graph, json)

        assertEquals(listOf("root", "shared", "branch-a"), projected.messages.map(ChatMessage::messageId))
        assertFalse(projected.messages.any { it.content.any { content -> content.text == "B" } })
    }

    @Test
    fun `projection applies the latest Pi compaction boundary and skips unknown entry types`() {
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
        val graph = SessionGraph(
            sessionId = "session-1",
            entries = listOf(
                entry("root", null),
                entry("old", "root", text = "old"),
                entry("kept", "old", text = "kept"),
                compaction,
                after,
            ).associateBy(SessionGraphEntry::entryId),
            cursor = SessionBranchCursor("after"),
        )

        val projected = projectSessionGraph(graph, json)

        assertEquals(listOf("compaction", "kept", "after"), projected.messages.map(ChatMessage::messageId))
        assertEquals("压缩摘要：old context", projected.messages.first().content.single().text)

        val unsupported = graph.copy(
            entries = graph.entries + ("unknown" to entry("unknown", "compaction").copy(type = "future_semantic_entry")),
            cursor = SessionBranchCursor("unknown"),
        )
        val unsupportedProjection = projectSessionGraph(unsupported, json)
        assertEquals(null, unsupportedProjection.error)
        assertEquals(listOf("compaction", "kept"), unsupportedProjection.messages.map(ChatMessage::messageId))
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
        val graph = SessionGraph(
            sessionId = "session-1",
            entries = listOf(bash, hidden).associateBy(SessionGraphEntry::entryId),
            cursor = SessionBranchCursor("hidden"),
        )

        val projected = projectSessionGraph(graph, json)

        assertEquals(listOf("bash"), projected.messages.map(ChatMessage::messageId))
        assertEquals("$ pwd\n/workspace", projected.messages.single().content.single().text)
    }

    @Test
    fun `projection restores completed turn timing from the selected Session branch`() {
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
        val graph = SessionGraph(
            sessionId = "session-1",
            entries = listOf(assistant, timing).associateBy(SessionGraphEntry::entryId),
            cursor = SessionBranchCursor("timing"),
        )

        val projected = projectSessionGraph(graph, json)

        assertEquals(
            listOf(TurnTiming("turn-1", 1_000, durationMs = 250, turnIndex = 0, messageId = "assistant")),
            projected.turnTimings,
        )
    }

    @Test
    fun `append merges a new branch entry and keeps an existing identical entry idempotent`() {
        val graph = SessionGraph(
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
        val graph = SessionGraph(
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
        val graph = SessionGraph(
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
        val graph = SessionGraph(
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
        val graph = SessionGraph(
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
        val graph = SessionGraph(
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
            ),
        )

        val projection = completed.projectLeafDeltaProjection(
            oldLeafId = "leaf",
            newLeafId = "leaf",
            currentMessages = listOf(
                ChatMessage("tail", "user", listOf(RemoteContent("text", "tail")), 1),
                ChatMessage("leaf", "assistant", listOf(RemoteContent("text", "leaf")), 2),
            ),
            json = json,
        )

        assertEquals(listOf("root", "tail", "leaf"), projection.messages.map(ChatMessage::messageId))
    }

    @Test
    fun `leaf append keeps new graph entries before an in-flight overlay`() {
        val graph = SessionGraph(
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
            json = json,
        )

        assertEquals(listOf("root", "user", "assistant", "live"), projection.messages.map(ChatMessage::messageId))
    }

    @Test
    fun `branch switch keeps canonical suffix ahead of live overlay`() {
        val graph = SessionGraph(
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
            json = json,
        )

        assertEquals(listOf("root", "new", "live"), projection.messages.map(ChatMessage::messageId))
    }

    @Test
    fun `partial projection reports missing parent while retaining the known tail`() {
        val graph = SessionGraph(
            sessionId = "session-1",
            entries = mapOf("tail" to entry("tail", "missing")),
            cursor = SessionBranchCursor("tail"),
        )

        val projection = projectSessionGraph(graph, json)

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
        val graph = SessionGraph(
            sessionId = "session-1",
            entries = listOf(
                entry("u1", null, role = "user", text = "第一句：开始提问"),
                entry("a1", "u1", role = "assistant", text = "好的"),
                entry("u2", "a1", role = "user", text = "第二句"),
            ).associateBy(SessionGraphEntry::entryId),
            cursor = SessionBranchCursor("u2"),
        )

        assertEquals("第一句：开始提问", graph.firstUserMessageTitle(json))
    }

    @Test
    fun `firstUserMessageTitle returns null when the branch has no user message`() {
        val graph = SessionGraph(
            sessionId = "session-1",
            entries = listOf(
                entry("a1", null, role = "assistant", text = "hello"),
            ).associateBy(SessionGraphEntry::entryId),
            cursor = SessionBranchCursor("a1"),
        )

        assertNull(graph.firstUserMessageTitle(json))
    }

    @Test
    fun `firstUserMessageTitle returns null for an empty graph`() {
        assertNull(SessionGraph("session-1").firstUserMessageTitle(json))
    }

    @Test
    fun `firstUserMessageTitle returns null when the leaf is missing from the graph`() {
        val graph = SessionGraph(
            sessionId = "session-1",
            entries = listOf(entry("u1", null, role = "user", text = "ask")).associateBy(SessionGraphEntry::entryId),
            cursor = SessionBranchCursor("unknown-leaf"),
        )

        assertNull(graph.firstUserMessageTitle(json))
    }

    /**
     * A provider failure is the only content such a turn produced, so a projection that drops it
     * leaves the phone showing an empty turn with no way to tell failure from "still thinking".
     */
    @Test
    fun `projection keeps a failed turn renderable with its failure reason`() {
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
        val graph = SessionGraph(
            sessionId = "session-1",
            entries = listOf(entry("u1", null, role = "user", text = "ask"), failed)
                .associateBy(SessionGraphEntry::entryId),
            cursor = SessionBranchCursor("failed"),
        )

        val message = projectSessionGraph(graph, json).messages.single { it.messageId == "failed" }

        assertEquals("assistant", message.role)
        assertTrue(message.isError == true)
        assertEquals(
            "OpenAI API error (504): Gateway Time-out\nprovider=linkbus, model=gpt-5.6-terra",
            message.content.single().text,
        )
    }
}
