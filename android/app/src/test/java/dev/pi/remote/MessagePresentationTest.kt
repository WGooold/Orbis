package dev.pi.remote

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class MessagePresentationTest {
    @Test
    fun `normal conversation text stays visible while thinking and tools start collapsed`() {
        assertEquals(ContentPresentation.MESSAGE, contentPresentation("assistant", "text"))
        assertEquals(ContentPresentation.THINKING, contentPresentation("assistant", "thinking"))
        assertEquals(ContentPresentation.TOOL, contentPresentation("assistant", "tool_call"))
        assertEquals(ContentPresentation.TOOL, contentPresentation("tool", "text"))

        assertFalse(contentPresentation("assistant", "text").startsCollapsed)
        assertTrue(contentPresentation("assistant", "thinking").startsCollapsed)
        assertTrue(contentPresentation("assistant", "tool_call").startsCollapsed)
    }

    @Test
    fun `collapsed activity summary is one compact readable line`() {
        val summary = compactActivitySummary(
            """
                first line
                second    line
                third line with additional detail
            """.trimIndent(),
            maxCharacters = 28,
        )

        assertEquals("first line second line…", summary)
        assertFalse(summary.contains('\n'))
    }

    @Test
    fun `tool results are merged into their matching tool call instead of rendered twice`() {
        val assistant = ChatMessage(
            messageId = "assistant-1",
            role = "assistant",
            content = listOf(RemoteContent(type = "tool_call", toolCallId = "call-1", toolName = "read")),
            timestamp = 1,
        )
        val toolResult = ChatMessage(
            messageId = "tool-1",
            role = "tool",
            content = listOf(RemoteContent(type = "text", text = "file contents")),
            timestamp = 2,
            toolCallId = "call-1",
            toolName = "read",
        )

        val presentation = buildConversationPresentation(listOf(assistant, toolResult))

        assertEquals(listOf(assistant), presentation.messages)
        assertEquals(toolResult, presentation.toolResults["call-1"])
    }

    @Test
    fun `empty placeholders are not rendered and duplicate IDs keep one stable row`() {
        val placeholder = ChatMessage("assistant-live", "assistant", emptyList(), 2)
        val first = ChatMessage("message-1", "user", listOf(RemoteContent("text", "before")), 1)
        val updated = first.copy(content = listOf(RemoteContent("text", "after")))

        val presentation = buildConversationPresentation(listOf(placeholder, first, updated))

        assertEquals(listOf(updated), presentation.messages)

        val toolCall = ChatMessage(
            messageId = "assistant-1",
            role = "assistant",
            content = listOf(RemoteContent(type = "tool_call", toolCallId = "call-1", toolName = "read")),
            timestamp = 1,
        )
        val emptyResult = ChatMessage("tool-1", "tool", emptyList(), 2, toolCallId = "call-1")

        val toolPresentation = buildConversationPresentation(listOf(toolCall, emptyResult))

        assertEquals(listOf(toolCall), toolPresentation.messages)
        assertTrue(toolPresentation.toolResults.isEmpty())
    }

    @Test
    fun `a live tool call carrying only streamed arguments is still renderable`() {
        // Before the runtime finalizes the message the tool_call block has no id, name or parsed
        // arguments — only the accumulated argument text. It must not be filtered out, or the whole
        // live answer disappears for as long as the tool call streams.
        val live = ChatMessage(
            messageId = "assistant-live",
            role = "assistant",
            content = listOf(
                RemoteContent(type = "text", text = "let me check"),
                RemoteContent(type = "tool_call", text = "{\"path\":\"a.txt\"}"),
            ),
            timestamp = 1,
        )

        val presentation = buildConversationPresentation(listOf(live))

        assertEquals(listOf(live), presentation.messages)
    }

    @Test
    fun `only in-flight tool activities without a represented message are pinned`() {
        val inFlight = ToolActivity("call-live", "bash", "updated", detail = "running")
        val finished = ToolActivity("call-done", "bash", "finished", detail = "done")
        val representedLive = ToolActivity("call-shown", "read", "updated")
        val representedFinished = ToolActivity("call-shown-done", "read", "finished")

        val orphans = orphanToolActivities(
            listOf(inFlight, finished, representedLive, representedFinished),
            representedToolIds = setOf("call-shown", "call-shown-done"),
        )

        assertEquals(listOf(inFlight), orphans)
        assertEquals(
            emptyList<ToolActivity>(),
            orphanToolActivities(
                listOf(ToolActivity("stale-call", "bash", "finished", detail = "result")),
                representedToolIds = emptySet(),
            ),
        )
    }

    @Test
    fun `detects bare computer paths without treating slash commands or web urls as files`() {
        assertEquals(
            listOf("C:\\work\\build\\app.apk", "/tmp/reports/result.zip"),
            detectableFilePaths("路径：C:\\work\\build\\app.apk，或 /tmp/reports/result.zip。"),
        )
        assertEquals(emptyList<String>(), detectableFilePaths("运行 /reload 或打开 https://example.test/file.zip"))

    }

    @Test
    fun `conversation follows latest only initially or while user remains near the end`() {
        assertTrue(shouldFollowLatest(initialPositioned = false, lastVisibleIndex = 0, totalItems = 30))
        assertTrue(shouldFollowLatest(initialPositioned = true, lastVisibleIndex = 28, totalItems = 30))
        assertFalse(shouldFollowLatest(initialPositioned = true, lastVisibleIndex = 12, totalItems = 30))
    }

    @Test
    fun `delivery choices are transient and only visible while running`() {
        assertFalse(deliveryChoicesVisible(requested = false, runtimeStatus = "running"))
        assertFalse(deliveryChoicesVisible(requested = true, runtimeStatus = "idle"))
        assertTrue(deliveryChoicesVisible(requested = true, runtimeStatus = "running"))
        assertFalse(deliveryChoicesVisible(requested = false, runtimeStatus = "running"))
    }

    @Test
    fun `composer button aborts only while working with an empty input`() {
        assertEquals(ComposerAction.Send, composerAction(isWorking = false, input = ""))
        assertEquals(ComposerAction.Send, composerAction(isWorking = false, input = "hello"))
        assertEquals(ComposerAction.Abort, composerAction(isWorking = true, input = ""))
        assertEquals(ComposerAction.Abort, composerAction(isWorking = true, input = "   "))
        assertEquals(ComposerAction.Send, composerAction(isWorking = true, input = "hello"))
    }

    @Test
    fun `slash input can only submit after choosing the published menu item`() {
        val commands = listOf(
            RuntimeSlashCommand("reload", "Reload resources", "builtin"),
            RuntimeSlashCommand(
                "model",
                "Select model",
                "builtin",
                RuntimeSlashCommandArgument("select", required = true),
            ),
        )

        assertFalse(canSubmitInput("/reload", commands, selectedSlashCommandName = null))
        assertTrue(canSubmitInput("/reload", commands, selectedSlashCommandName = "reload"))
        assertFalse(canSubmitInput("/reload unexpected", commands, selectedSlashCommandName = "reload"))
        assertFalse(canSubmitInput("/model", commands, selectedSlashCommandName = "model"))
        assertTrue(canSubmitInput("/model openai/gpt-5", commands, selectedSlashCommandName = "model"))
        assertTrue(canSubmitInput("ordinary message", commands, selectedSlashCommandName = null))
    }

    @Test
    fun `select argument chosen from the menu is submittable`() {
        // 二级菜单选完拼成 "/model <value>"——按钮必须立刻可点（required 已满足）。
        val commands = listOf(
            RuntimeSlashCommand(
                "model",
                "Select the model",
                "builtin",
                RuntimeSlashCommandArgument(
                    kind = "select",
                    required = true,
                    options = listOf(
                        RuntimeSlashCommandOption("gpt-5.5", "GPT-5.5", "Frontier model"),
                        RuntimeSlashCommandOption("gpt-5.4", "gpt-5.4"),
                    ),
                ),
            ),
            RuntimeSlashCommand(
                "thinking",
                "Set reasoning effort",
                "builtin",
                RuntimeSlashCommandArgument(
                    kind = "select",
                    required = true,
                    options = listOf(RuntimeSlashCommandOption("low", "low"), RuntimeSlashCommandOption("high", "high")),
                ),
            ),
        )

        assertTrue(canSubmitInput("/model gpt-5.5", commands, selectedSlashCommandName = "model"))
        assertTrue(canSubmitInput("/thinking high", commands, selectedSlashCommandName = "thinking"))
        // 没选之前不能提交（required 未满足）。
        assertFalse(canSubmitInput("/model", commands, selectedSlashCommandName = "model"))
    }

    @Test
    fun `builtin command badge follows the backend`() {
        // builtin 在 Pi 与 Codex 下都出现，但徽标文案必须区分，免得 Codex 会话显示 "Pi"。
        assertEquals("Pi", slashSourceText("builtin", isCodex = false))
        assertEquals("Codex", slashSourceText("builtin", isCodex = true))
        assertEquals("Pi", slashSourceText("builtin"))
        assertEquals("扩展", slashSourceText("extension", isCodex = true))
        assertEquals("Skill", slashSourceText("skill", isCodex = true))
    }

    @Test
    fun `codex runtime is recognized by its prefixed id`() {
        val base = RuntimeSummary(runtimeId = "codex:019f-thread-1", name = "Codex", cwd = "D:/repo", status = "idle")
        assertTrue(base.isCodex)
        assertTrue(base.copy(runtimeId = "codex").isCodex)
        assertFalse(base.copy(runtimeId = "3f2a-uuid").isCodex)
        // 前缀撞车防护：以 codex 开头但不是 "codex:" 分隔的 id 不算。
        assertFalse(base.copy(runtimeId = "codexer-uuid").isCodex)
    }

    @Test
    fun `editing a selected slash command name invalidates the menu selection`() {
        assertTrue(matchesSelectedSlashCommand("/compact focus on tests", "compact"))
        assertFalse(matchesSelectedSlashCommand("/reload", "compact"))
        assertFalse(matchesSelectedSlashCommand("ordinary message", "compact"))
    }

    @Test
    fun `consecutive assistant messages merge into one turn while user messages stand alone`() {
        val user1 = ChatMessage("u1", "user", listOf(RemoteContent("text", "帮我看看日志")), 1)
        val assistantText = ChatMessage("a1", "assistant", listOf(RemoteContent("text", "正文")), 2)
        val assistantTool = ChatMessage("a2", "assistant", listOf(RemoteContent("text", "工具输出")), 3)
        val user2 = ChatMessage("u2", "user", listOf(RemoteContent("text", "继续")), 4)
        val assistantTail = ChatMessage("a3", "assistant", listOf(RemoteContent("text", "收尾")), 5)

        val items = buildChatListItems(listOf(user1, assistantText, assistantTool, user2, assistantTail))

        assertEquals(
            listOf(
                ChatListItem.UserMessage(user1),
                ChatListItem.AssistantTurn(listOf(assistantText, assistantTool)),
                ChatListItem.UserMessage(user2),
                ChatListItem.AssistantTurn(listOf(assistantTail)),
            ),
            items,
        )
        assertEquals("u1", items[0].key)
        assertEquals("a1", items[1].key)
    }

    @Test
    fun `separates assistant cards at actual turn timing boundaries`() {
        val firstAssistant = ChatMessage("a1", "assistant", listOf(RemoteContent("text", "第一轮")), 1)
        val toolResult = ChatMessage("t1", "tool", listOf(RemoteContent("text", "工具结果")), 2)
        val secondAssistant = ChatMessage("a2", "assistant", listOf(RemoteContent("text", "第二轮")), 3)

        val items = buildChatListItems(
            listOf(firstAssistant, toolResult, secondAssistant),
            turnIdsByMessageId = mapOf("a1" to "turn-1", "a2" to "turn-2"),
        )

        assertEquals(
            listOf(
                ChatListItem.AssistantTurn(listOf(firstAssistant, toolResult)),
                ChatListItem.AssistantTurn(listOf(secondAssistant)),
            ),
            items,
        )
    }

    @Test
    fun `tool role messages join the surrounding assistant turn`() {
        val assistant = ChatMessage("a1", "assistant", listOf(RemoteContent("text", "正文")), 1)
        val tool = ChatMessage("t1", "tool", listOf(RemoteContent("text", "无结果的工具输出")), 2)

        val items = buildChatListItems(listOf(assistant, tool))

        assertEquals(listOf(ChatListItem.AssistantTurn(listOf(assistant, tool))), items)
    }

    @Test
    fun `every message resolves to its containing turn row for scroll anchoring`() {
        val user1 = ChatMessage("u1", "user", listOf(RemoteContent("text", "第一条")), 1)
        val assistantA = ChatMessage("a1", "assistant", listOf(RemoteContent("text", "一")), 2)
        val assistantB = ChatMessage("a2", "assistant", listOf(RemoteContent("text", "二")), 3)
        val user2 = ChatMessage("u2", "user", listOf(RemoteContent("text", "第二条")), 4)

        val items = buildChatListItems(listOf(user1, assistantA, assistantB, user2))
        val indexById = chatListItemIndexByMessageId(items)

        assertEquals(0, indexById["u1"])
        assertEquals(1, indexById["a1"])
        assertEquals(1, indexById["a2"])
        assertEquals(2, indexById["u2"])
    }

    @Test
    fun `one assistant card times every turn it merges and stays live while any turn runs`() {
        // 一张卡片会合并多轮 Pi 轮次（一轮 = 一次 LLM 调用 + 它发起的工具）。只取第一条计时会把
        // 「第一个工具刚跑完」的几秒钉在卡片上，真机上表现为「耗时一直停在几秒、不再进行」——
        // 这张卡片的时长必须覆盖它合并的全部轮次。
        val finished = groupTurnTiming(
            listOf(
                TurnTiming("turn-1", startedAt = 1_000, durationMs = 3_000, messageId = "a1"),
                TurnTiming("turn-2", startedAt = 4_000, durationMs = 30_000, messageId = "a2"),
            ),
        )
        assertEquals(1_000L, finished?.startedAt)
        assertEquals(33_000L, finished?.durationMs)

        val live = groupTurnTiming(
            listOf(
                TurnTiming("turn-1", startedAt = 1_000, durationMs = 3_000, messageId = "a1"),
                TurnTiming("turn-2", startedAt = 4_000, durationMs = null, messageId = "a2"),
            ),
        )
        assertEquals(1_000L, live?.startedAt)
        assertNull(live?.durationMs)

        assertNull(groupTurnTiming(emptyList()))
    }
}
