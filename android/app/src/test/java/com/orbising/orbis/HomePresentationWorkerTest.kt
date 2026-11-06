package com.orbising.orbis

import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Test

class HomePresentationWorkerTest {
    // A stream changes history, not the card's identity/status/title. Sorting must stay off UI
    // and its unchanged result must be reused; partial model reads keep the last complete cards.
    @Test fun `stream updates reuse cards and partial reads retain the complete snapshot`() = runBlocking {
        val fixture = HomeLoadingFixture().also { it.complete("a", "b") }
        val caller = Thread.currentThread()
        var sorts = 0
        var facts = 0
        val worker = HomePresentationWorker(beforeFacts = { facts++ }, beforeSort = { assertNotSame(caller, Thread.currentThread()); sorts++ })
        val initial = fixture.state
        val cards = worker.resolve(HomePresentationRequest(initial, AppLanguage.Chinese))
        repeat(60) { index ->
            val state = initial.copy(conversations = initial.conversations + ("a" to RuntimeConversation(
                messages = listOf(ChatMessage("stream", "assistant", listOf(RemoteContent("text", "chunk $index")), 1)))))
            assertSame(cards, worker.resolve(HomePresentationRequest(state, AppLanguage.Chinese)))
        }
        assertEquals(1, sorts)
        assertEquals(1, facts)
        fixture.beginRead("a")
        assertSame(fixture.state.homeSnapshot, worker.resolve(HomePresentationRequest(fixture.state, AppLanguage.Chinese)))
        fixture.facts("a", title = "renamed", revision = 2)
        assertEquals("renamed", worker.resolve(HomePresentationRequest(fixture.state, AppLanguage.Chinese))!!.first { it.runtime.runtimeId == "a" }.title)
        assertEquals(2, sorts)
    }

    // Admission/commit fencing must not call collection equality on the UI thread.
    @Test fun `ownership checks use references and reject replacement inputs`() {
        val map = object : Map<String, RuntimeSummary> by emptyMap() {
            override fun equals(other: Any?): Boolean = error("UI compared a runtime collection")
        }
        val state = RemoteState(hostId = "h", runtimes = map)
        val request = HomePresentationRequest(state, AppLanguage.Chinese)
        assertTrue(request.matches(state.copy(pathRttMs = 8)))
        assertFalse(request.matches(state.copy(hostId = "other")))
        assertFalse(request.matches(state.copy(runtimes = emptyMap())))
    }
}
