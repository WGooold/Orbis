package dev.pi.remote

import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

class ChatListItemReuseTest {
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
