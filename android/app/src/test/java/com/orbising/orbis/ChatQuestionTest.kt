package com.orbising.orbis

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class ChatQuestionTest {
    private fun message(id: String, role: String = "user", text: String = "同一个问题") =
        ChatMessage(id, role, listOf(RemoteContent("text", text)), 1)

    @Test fun sourceOrderWinsEvenWhenIdenticalQuestionsHaveTheSameTimestamp() {
        val messages = listOf(message("first"), message("second"), message("assistant", "assistant"), message("tool", "tool"))
        assertEquals(ChatQuestion("second", "同一个问题"), latestChatQuestion(messages))
        assertNull(latestChatQuestion(messages.drop(2)))
    }

    @Test fun unconfirmedAndFailedLocalRowsDoNotReplaceTheSourceQuestion() {
        val messages = listOf(message("source"), message("sending"), message("failed"), message("unconfirmed"))
        assertEquals("source", latestChatQuestion(messages, setOf("sending", "failed", "unconfirmed"))?.messageId)
        assertNull(latestChatQuestion(messages, messages.map { it.messageId }.toSet()))
    }

    @Test fun prependingHistoryOrReplacingTheBranchCannotPinAStaleQuestion() {
        val current = message("current")
        assertEquals(latestChatQuestion(listOf(current)), latestChatQuestion(listOf(message("old"), current, message("reply", "assistant"))))
        assertEquals("branch", latestChatQuestion(listOf(message("branch")))?.messageId)
        assertNull(latestChatQuestion(emptyList()))
    }

    @Test fun multilineUnicodeAndAttachmentNamesArePreserved() {
        val text = "解释 👩🏽‍💻 与 e\u0301\n再比较两种实现"
        assertEquals(text, latestChatQuestion(listOf(message("unicode", text = text)))?.text)
        val file = RemoteArtifact("file", "很长的设计稿.pdf", "application/pdf", 42)
        val attachment = ChatMessage("attachment", "user", listOf(RemoteContent("artifact", artifact = file)), 2)
        assertEquals("附件：很长的设计稿.pdf", latestChatQuestion(listOf(attachment))?.text)
        assertNull(latestChatQuestion(listOf(message("empty", text = " \n "))))
    }
}
