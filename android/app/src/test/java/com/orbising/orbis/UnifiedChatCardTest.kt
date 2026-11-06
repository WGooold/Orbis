package com.orbising.orbis

import java.io.File
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class UnifiedChatCardTest {
    private fun rows(messages: List<ChatMessage>, anchors: Map<String, String> = emptyMap(), previous: List<ChatListItem> = emptyList()) =
        chatViewportItems(buildChatListItems(messages, anchors, previous)).filterIsInstance<ChatListItem.AssistantTurn>()
    private fun signature(rows: List<ChatListItem.AssistantTurn>) = rows.map { row -> row.messages.flatMap { message -> message.content.map { block ->
        if (block.type == "tool_call") "tool:${block.toolCallId}" else "${block.type}:${block.text}"
    } } }
    private fun text(id: String, value: String = id) = ChatMessage(id, "assistant", listOf(RemoteContent("text", value)), 0)

    // S31 / SC50: native turns and one-message/many-message packing must yield the same visible steps.
    @Test fun `all five backends use the same fixture regardless of message and turn packing`() {
        val root = generateSequence(File(System.getProperty("user.dir"))) { it.parentFile }
            .first { File(it, "ios/Orbis/Tests/Fixtures/chat-card-layout.json").isFile }
        val fixture = Json.parseToJsonElement(File(root, "ios/Orbis/Tests/Fixtures/chat-card-layout.json").readText()).jsonObject
        val steps = fixture.getValue("steps").jsonArray.map { step -> step.jsonArray.map { value ->
            val block = value.jsonObject
            RemoteContent(type = block.getValue("type").jsonPrimitive.content, text = block["text"]?.jsonPrimitive?.content,
                toolCallId = block["toolCallId"]?.jsonPrimitive?.content, toolName = block["toolName"]?.jsonPrimitive?.content)
        } }
        val expected = fixture.getValue("expectedCards").jsonArray.map { it.jsonArray.map { it.jsonPrimitive.content } }
        val perStep = steps.mapIndexed { index, blocks -> ChatMessage("step-$index", "assistant", blocks, 0) }
        val perBlock = steps.flatten().mapIndexed { index, block -> ChatMessage("block-$index", "assistant", listOf(block), 0) }
        val bundled = listOf(ChatMessage("bundled", "assistant", steps.flatten(), 0))
        for ((backend, messages) in listOf("pi" to perStep, "dsh" to bundled, "claude" to perBlock,
                "codex" to perBlock, "codexDesktop" to perStep)) {
            val anchors = messages.associate { it.messageId to "native-${it.messageId}" }
            assertEquals(backend, expected, signature(rows(messages, anchors)))
            assertEquals(backend, expected, signature(rows(messages)))
        }
        val result = rows(bundled)
        assertEquals(listOf(emptySet<String>(), emptySet(), setOf("bundled")), result.map { it.completedMessageIds })
        assertEquals(2, assistantCardContent(result[0].messages).tools.size)
        assertEquals(1, assistantCardContent(result[1].messages).tools.size)
    }

    // A large parallel batch stays one collapsed group with bounded local paging, not dozens of frames.
    @Test fun `large tool batches and appended tools retain card identity`() {
        fun tool(index: Int) = RemoteContent("tool_call", toolCallId = "call-$index", toolName = "read")
        val initial = ChatMessage("live", "assistant", listOf(tool(0)), 0)
        val before = rows(listOf(initial))
        val packed = initial.copy(messageId = "persisted", content = (0 until 24).map(::tool))
        val after = rows(listOf(packed), previous = before)
        assertEquals(1, after.size)
        assertEquals(before.single().key, after.single().key)
        assertEquals(24, assistantCardContent(after.single().messages).tools.size)
        assertEquals(8, CHAT_TOOL_PAGE_SIZE)
    }

    // The prose budget is applied to blocks too; prepending history cannot move an existing row start.
    @Test fun `prose boundaries survive prepend and native boundary changes`() {
        val original = (0 until 9).map { text("m$it") }
        val before = rows(original)
        assertEquals(listOf(4, 4, 1), before.map { it.messages.size })
        val after = rows(listOf(text("older0"), text("older1")) + original, previous = before)
        assertEquals(listOf("older0") + before.map { it.key }, after.map { it.key })
        assertEquals(signature(before), signature(rows(original, original.associate { it.messageId to "turn" })))
        val oneMessage = ChatMessage("packed", "assistant", original.flatMap { it.content }, 0)
        assertEquals(signature(before), signature(rows(listOf(oneMessage))))
    }
}
