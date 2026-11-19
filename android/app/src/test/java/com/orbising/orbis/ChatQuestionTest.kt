package com.orbising.orbis

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class ChatQuestionTest {
    private fun message(id: String, role: String = "user", text: String = "同一个问题") =
        ChatMessage(id, role, listOf(RemoteContent("text", text)), 1)

    // CHAT-QUESTION-02: a new question is never used for earlier reading rows.
    @Test fun readingRowsUseTheNearestSourceQuestionWithoutPickingPendingOrFutureRows() {
        val rows = listOf(message("intro", "assistant"), message("first"), message("answer1", "assistant"),
            message("pending"), message("answer2", "assistant"), message("second"), message("answer3", "assistant"))
        val index = indexChatReadingQuestions(rows.map(ChatMessage::messageId), rows, setOf("pending"))
        assertNull(index["intro"])
        assertNull(index["first"])
        assertEquals(ChatQuestion("first", "同一个问题"), index["answer1"])
        assertEquals("first", index["pending"]?.messageId)
        assertEquals("first", index["answer2"]?.messageId)
        assertNull(index["second"])
        assertEquals("second", index["answer3"]?.messageId)
        assertNull(index["stale-branch"])
    }

    @Test fun multilineUnicodeAndAttachmentNamesArePreserved() {
        val text = "解释 👩🏽‍💻 与 e\u0301\n再比较两种实现"
        assertEquals(text, sourceChatQuestion(message("unicode", text = text))?.text)
        val file = RemoteArtifact("file", "很长的设计稿.pdf", "application/pdf", 42)
        val attachment = ChatMessage("attachment", "user", listOf(RemoteContent("artifact", artifact = file)), 2)
        assertEquals("附件：很长的设计稿.pdf", sourceChatQuestion(attachment)?.text)
        assertNull(sourceChatQuestion(message("empty", text = " \n ")))
    }
}
