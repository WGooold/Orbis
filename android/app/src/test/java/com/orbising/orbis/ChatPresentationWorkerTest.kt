package com.orbising.orbis

import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Test

class ChatPresentationWorkerTest {
    // Streaming admission runs during composition. A deep collection comparison here
    // would put transcript work back on Main even though resolve itself uses Default.
    @Test fun `admission never compares or hashes message collections`() {
        val messages = object : List<ChatMessage> by emptyList() {
            override fun equals(other: Any?): Boolean = error("message equality on admission")
            override fun hashCode(): Int = error("message hash on admission")
        }
        val identity = ChatPresentationIdentity("h", "r", "s", 1)
        fun request(input: List<ChatMessage> = messages, owner: ChatPresentationIdentity = identity) =
            ChatPresentationRequest(owner, input, emptyMap(), emptyMap(), emptyMap())
        assertEquals(request(), request())
        assertEquals(request().hashCode(), request().hashCode())
        assertNotEquals(request(), request(emptyList()))
        assertNotEquals(request(), request(owner = identity.copy(branch = 2)))
    }

    // Revision/length shortcuts must not hide rewrites; arrival identity follows message
    // membership while body edits and branch changes still publish their current content.
    @Test fun `same length rewrite and branch change retain accurate row membership`() = runBlocking {
        val worker = ChatPresentationWorker()
        val identity = ChatPresentationIdentity("h", "r", "s", 1)
        val message = ChatMessage("answer", "assistant", listOf(RemoteContent("text", "before")), 1)
        fun request(body: ChatMessage, owner: ChatPresentationIdentity = identity) =
            ChatPresentationRequest(owner, listOf(body), emptyMap(), emptyMap(), emptyMap())
        val first = worker.resolve(request(message))
        val changed = message.copy(content = listOf(RemoteContent("text", "after!")))
        val second = worker.resolve(request(changed))
        assertEquals("after!", second.presentation.messages.single().content.single().text)
        assertEquals(first.arrivalRows, second.arrivalRows)
        assertNotSame(first, second)
        val other = worker.resolve(request(changed, identity.copy(branch = 2)))
        assertEquals(2, other.identity.branch)
        assertEquals(second.arrivalRows, other.arrivalRows)
    }
}
