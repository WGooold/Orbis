package com.orbising.orbis

import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

class ChatListItemReuseTest {
    @Test
    fun `long transcript preserves distant rows and revises non tail dependencies`() {
        val messages = (0 until 3000).flatMap { i -> listOf(message("u$i", "user", "question"), message("a$i", "assistant", "answer")) }
        val first = buildChatListItems(messages)
        val corrected = messages.toMutableList().apply { this[35] = message("a17", "assistant", "corrected") }
        val second = buildChatListItems(corrected, previous = first)
        for (index in second.indices) {
            if (index != 35) assertSame(first[index], second[index])
        }
        assertTrue((second[35] as ChatListItem.AssistantTurn).messages.single() === corrected[35])
        val assistants = listOf(message("a", "assistant", "one"), message("t", "tool", "result"), message("b", "assistant", "two"))
        val separated = buildChatListItems(assistants, mapOf("a" to "turn-1"))
        assertTrue(separated.size == 2)
        val unchanged = buildChatListItems(assistants, mapOf("a" to "turn-1"), separated)
        assertSame(separated[0], unchanged[0]); assertSame(separated[1], unchanged[1])
        // S31 / SC50: native timing anchors do not change content-step boundaries or row reuse.
        val withoutAnchors = buildChatListItems(assistants, previous = separated)
        assertTrue(withoutAnchors.size == 2)
        assertSame(separated[0], withoutAnchors[0]); assertSame(separated[1], withoutAnchors[1])
        assertTrue(withoutAnchors.filterIsInstance<ChatListItem.AssistantTurn>().flatMap { it.messages } == assistants)
    }

    private fun message(id: String, role: String, text: String) =
        ChatMessage(id, role, listOf(RemoteContent(type = "text", text = text)), 1)

    // ADR-0039 §5：内容没变的行必须复用同一个对象，否则 Compose 每次 patch 都会重组整段会话。
    @Test
    fun `unchanged rows are reused across rebuilds`() {
        val user = message("u1", "user", "hi")
        val a1 = message("a1", "assistant", "one")
        val first = buildChatListItems(listOf(user, a1))
        assertTrue(first[0] is ChatListItem.UserMessage)

        // 只有助手消息内容变了：用户行与它自己都应当被复用。
        val a1b = message("a1", "assistant", "one more")
        val second = buildChatListItems(listOf(user, a1b), previous = first)
        assertSame(first[0], second[0])
        val secondTurn = second[1] as ChatListItem.AssistantTurn
        assertTrue(secondTurn.messages.single() === a1b)

        // 完全没变：整行复用。
        val third = buildChatListItems(listOf(user, a1b), previous = second)
        assertSame(second[1], third[1])
    }
}
