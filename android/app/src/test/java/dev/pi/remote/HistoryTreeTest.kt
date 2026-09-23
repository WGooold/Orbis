package dev.pi.remote

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.add
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class HistoryTreeTest {
    private fun option(
        id: String,
        parent: String? = null,
        role: String? = "user",
        entryType: String = "message",
        active: Boolean = false,
        current: Boolean = false,
        hidden: Boolean = false,
        bookmark: String? = null,
        label: String = id,
    ) = RuntimeSlashCommandOption(
        value = id,
        label = label,
        tree = RuntimeSlashCommandTreeNode(
            parentId = parent,
            entryType = entryType,
            role = role,
            label = bookmark,
            defaultHidden = hidden,
            isCurrent = current,
            isOnActivePath = active,
        ),
    )

    /**
     * u1 ─ a1 ─ u2a ─ a2a   （当前分支）
     *           └ u2b ─ a2b （另一种走法）
     */
    private val branched = listOf(
        option("u1", role = "user", active = true, label = "第一个问题"),
        option("a1", parent = "u1", role = "assistant", active = true, label = "第一条回复"),
        option("u2a", parent = "a1", role = "user", active = true, label = "继续"),
        option("a2a", parent = "u2a", role = "assistant", active = true, current = true, label = "接着做完了"),
        option("u2b", parent = "a1", role = "user", label = "尝试另一种实现"),
        option("a2b", parent = "u2b", role = "assistant", label = "另一种做法"),
    )

    @Test
    fun `the active branch stays flat while the other one folds into a summary line`() {
        val rows = historyTreeRows(branched)

        assertEquals(3, rows.size)
        val first = rows[0] as HistoryTurnRow
        assertEquals("u1", first.user?.nodeId)
        assertEquals(listOf("a1"), first.replies.map(HistoryNode::nodeId))
        assertEquals(0, first.depth)
        assertTrue(first.showTurnIndex)
        assertEquals(1, first.turnIndex)

        val branch = rows[1] as HistoryBranchRow
        assertEquals("u2b", branch.branchId)
        assertEquals("尝试另一种实现", branch.summary)
        assertEquals(1, branch.turnCount)
        assertEquals("1 轮对话", branch.subtitle)
        assertEquals(1, branch.depth)

        val second = rows[2] as HistoryTurnRow
        assertEquals("u2a", second.user?.nodeId)
        assertEquals(listOf("a2a"), second.replies.map(HistoryNode::nodeId))
        assertEquals(2, second.turnIndex)
        assertTrue(second.hasCurrent)

        assertEquals(2, historyTreeCurrentRowIndex(rows))
    }

    @Test
    fun `expanding a folded branch renders it one level deeper with its own fold control`() {
        val rows = historyTreeRows(branched, expandedBranches = setOf("u2b"))

        assertEquals(3, rows.size)
        val expanded = rows[1] as HistoryTurnRow
        assertEquals("u2b", expanded.user?.nodeId)
        assertEquals("尝试另一种实现", expanded.user?.title)
        assertEquals(listOf("a2b"), expanded.replies.map(HistoryNode::nodeId))
        assertEquals(1, expanded.depth)
        assertEquals("u2b", expanded.collapseBranchId)
        assertFalse("展开的分支里不再重复轮次编号", expanded.showTurnIndex)
        assertNull((rows[0] as HistoryTurnRow).collapseBranchId)
    }

    @Test
    fun `tool calls stay folded into the turn details until asked for`() {
        val options = listOf(
            option("u1", role = "user", active = true),
            option("a1", parent = "u1", role = "assistant", active = true, current = true),
            option("t1", parent = "a1", role = "toolResult"),
        )

        val row = historyTreeRows(options).single() as HistoryTurnRow
        assertEquals(listOf("a1"), row.replies.map(HistoryNode::nodeId))
        assertEquals(listOf("t1"), row.details.map(HistoryNode::nodeId))
        assertEquals(HistoryNodeKind.Tool, row.details.single().kind)
        assertNull("工具结果不是可执行的跳转点", row.details.single().action)
        assertFalse(row.detailsExpanded)

        val opened = historyTreeRows(options, expandedDetails = setOf("u1")).single() as HistoryTurnRow
        assertTrue(opened.detailsExpanded)

        val withoutTools = historyTreeRows(options, HistoryTreeFilter.NO_TOOLS).single() as HistoryTurnRow
        assertTrue(withoutTools.details.isEmpty())
    }

    @Test
    fun `a linear codex thread renders as flat turns with tool items folded`() {
        // codex 的 thread 是一条线性链：没有旁支可折，所有节点都在活动路径上。
        val linear = listOf(
            option("u1", role = "user", active = true, label = "第一个问题"),
            option("c1", parent = "u1", role = "toolResult", active = true, hidden = true, label = "commandExecution"),
            option("c1:result", parent = "c1", role = "toolResult", active = true, hidden = true, label = "命令输出"),
            option("a1", parent = "c1:result", role = "assistant", active = true, label = "第一条回复"),
            option("u2", parent = "a1", role = "user", active = true, label = "第二个问题"),
            option("a2", parent = "u2", role = "assistant", active = true, current = true, label = "第二条回复"),
        )

        val rows = historyTreeRows(linear)

        assertEquals(2, rows.size)
        assertTrue("线性历史不该出现旁支摘要行", rows.none { it is HistoryBranchRow })
        val first = rows[0] as HistoryTurnRow
        assertEquals("u1", first.user?.nodeId)
        assertEquals(listOf("a1"), first.replies.map(HistoryNode::nodeId))
        assertEquals(listOf("c1", "c1:result"), first.details.map(HistoryNode::nodeId))
        assertNull("工具条目不是可执行的跳转点", first.details.first().action)
        assertEquals(2, (rows[1] as HistoryTurnRow).turnIndex)
    }

    @Test
    fun `settings entries fold away while compaction stays on the node line`() {
        // 链上的设置项：收进细节，不占节点行。
        val chained = listOf(
            option("u1", role = "user", active = true),
            option("model", parent = "u1", role = null, entryType = "model_change", hidden = true, active = true),
            option("compact", parent = "model", role = null, entryType = "compaction", active = true),
            option("a1", parent = "compact", role = "assistant", active = true, current = true),
        )
        val row = historyTreeRows(chained).single() as HistoryTurnRow
        assertEquals(listOf("compact", "a1"), row.replies.map(HistoryNode::nodeId))
        assertEquals(HistoryNodeKind.System, row.replies.first().kind)
        assertEquals(listOf("model"), row.details.map(HistoryNode::nodeId))

        // 只挂着设置项的旁支在默认视图里不占一行摘要；「全部」档仍要能看见它。
        val sibling = listOf(
            option("u1", role = "user", active = true),
            option("model", parent = "u1", role = null, entryType = "model_change", hidden = true),
            option("a1", parent = "u1", role = "assistant", active = true, current = true),
        )
        assertEquals(1, historyTreeRows(sibling).size)
        assertTrue(historyTreeRows(sibling, HistoryTreeFilter.ALL).any { it is HistoryBranchRow })
    }

    @Test
    fun `search is a flat result list that reaches into folded branches`() {
        val rows = historyTreeRows(branched, query = "尝试另一种")
        val row = rows.single() as HistoryTurnRow
        assertEquals("u2b", row.user?.nodeId)
        assertEquals(0, row.depth)
        assertFalse(row.showTurnIndex)

        assertEquals(2, historyTreeRows(branched, query = "另一种").size)
        assertTrue(historyTreeRows(branched, query = "尝试 不存在的词").isEmpty())
        assertEquals(2, historyTreeRows(branched, query = "u2").size)
    }

    @Test
    fun `filters keep their meaning over the fold`() {
        val userOnly = historyTreeRows(branched, HistoryTreeFilter.USER_ONLY)
        assertEquals(
            listOf("u1", "u2a"),
            userOnly.filterIsInstance<HistoryTurnRow>().flatMap(HistoryTurnRow::nodeIds),
        )

        val labeled = listOf(
            option("u1", role = "user", active = true),
            option("a1", parent = "u1", role = "assistant", active = true, bookmark = "检查点"),
            option("a2", parent = "u1", role = "assistant", current = true),
        )
        assertEquals(
            listOf("a1"),
            historyTreeRows(labeled, HistoryTreeFilter.LABELED_ONLY)
                .filterIsInstance<HistoryTurnRow>()
                .flatMap(HistoryTurnRow::nodeIds),
        )
    }

    @Test
    fun `selecting a node inside a folded branch reveals it`() {
        val rows = historyTreeRows(branched, selectedNodeId = "a2b")
        val selected = rows.filterIsInstance<HistoryTurnRow>().first { "a2b" in it.nodeIds }
        assertTrue(selected.containsSelected)
        assertEquals(1, selected.depth)
        assertTrue(rows.none { it is HistoryBranchRow })
    }

    @Test
    fun `a long linear session stays flat without overflowing the stack`() {
        val options = (0 until 20_000).map { index ->
            option(
                id = "entry-$index",
                parent = if (index == 0) null else "entry-${index - 1}",
                role = if (index % 2 == 0) "user" else "assistant",
                active = true,
                current = index == 19_999,
            )
        }

        val rows = historyTreeRows(options, selectedNodeId = "entry-19999")

        assertEquals(10_000, rows.size)
        assertTrue(rows.all { it is HistoryTurnRow })
        assertTrue(rows.all { it.depth == 0 })
        assertEquals(9_999, historyTreeCurrentRowIndex(rows))
        assertTrue(rows.last().hasCurrent)
    }

    @Test
    fun `the edited prompt travels back with the tree command result`() {
        assertEquals(
            "改写这一段",
            historyEditorText(Json.parseToJsonElement("""{"leafId":null,"editorText":"改写这一段"}""")),
        )
        assertNull(historyEditorText(Json.parseToJsonElement("""{"leafId":"a1"}""")))
        assertNull(historyEditorText(Json.parseToJsonElement("""{"editorText":"   "}""")))
        assertNull(historyEditorText(null))
    }

    @Test
    fun `the cached entry is the fallback text for editing a message`() {
        val graph = SessionGraph(
            sessionId = "s",
            entries = mapOf(
                "u1" to SessionGraphEntry(
                    entryId = "u1",
                    parentId = null,
                    type = "message",
                    timestamp = "2026-09-20T00:00:00.000Z",
                    data = buildJsonObject {
                        put("message", buildJsonObject {
                            put("role", "user")
                            put("content", buildJsonArray {
                                add(buildJsonObject {
                                    put("type", "text")
                                    put("text", "原文")
                                })
                            })
                        })
                    },
                ),
            ),
        )

        assertEquals("原文", graph.historyNodeText("u1"))
        assertNull(graph.historyNodeText("missing"))
    }

    @Test
    fun `preview reads only the local cache and admits when it cannot`() {
        val graph = SessionGraph(
            sessionId = "s",
            entries = mapOf(
                "u1" to SessionGraphEntry(
                    entryId = "u1",
                    parentId = null,
                    type = "message",
                    timestamp = "2026-09-20T00:00:00.000Z",
                    data = buildJsonObject {
                        put("message", buildJsonObject {
                            put("role", "user")
                            put("content", buildJsonArray {
                                add(buildJsonObject {
                                    put("type", "text")
                                    put("text", "原文")
                                })
                            })
                        })
                    },
                ),
            ),
        )

        assertTrue(historyNodePreview(null, "u1").unavailable)
        assertTrue(historyNodePreview(graph, "missing").unavailable)

        val preview = historyNodePreview(graph, "u1")
        assertFalse(preview.unavailable)
        assertEquals(listOf("u1"), preview.messages.map(ChatMessage::messageId))
    }
}
