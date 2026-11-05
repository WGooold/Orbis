package com.orbising.orbis

import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.asCoroutineDispatcher
import kotlinx.coroutines.async
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.yield
import org.junit.Assert.*
import org.junit.Test

class DrawerCatalogWorkerTest {
    private val session = SessionCatalogEntry("s", cwd = "/repo", agentKind = "codex", modelProvider = "one")
    private val runtime = RuntimeSummary("r", "Runtime", "/repo", "idle", sessionId = "s", agentKind = "codex")
    private val initial = RemoteState(hostId = "host", hostName = "Computer", sessions = mapOf("s" to session))
    private val filter = DrawerCatalogFilter("all", false, CURRENT_CODEX_PROVIDER, "one", "one", "")
    private fun request(state: RemoteState? = initial, filter: DrawerCatalogFilter = this.filter) =
        DrawerCatalogRequest(state, AppLanguage.Chinese, filter)

    @Test fun `status and assistant body changes preserve grouped catalog and filtered content`() = runBlocking {
        val worker = DrawerCatalogWorker()
        val message = ChatMessage("m", "assistant", listOf(RemoteContent("text", "first")), 1)
        val state = initial.copy(runtimes = mapOf("r" to runtime.copy(sessionName = "A title")),
            conversations = mapOf("r" to RuntimeConversation(messages = listOf(message))))
        val before = worker.resolve(request(state))
        repeat(100) { index ->
            val next = state.copy(runtimes = mapOf("r" to state.runtimes.getValue("r").copy(status = "running")),
                conversations = mapOf("r" to RuntimeConversation(messages = listOf(message.copy(
                    content = listOf(RemoteContent("text", "chunk $index")))))))
            assertSame(before.content, worker.resolve(request(next)).content)
        }
        val renamed = state.copy(runtimes = mapOf("r" to runtime.copy(sessionName = "Renamed")))
        assertEquals("Renamed", worker.resolve(request(renamed)).content.sessions.single().title)
    }

    @Test fun `filter search archive and provider resolution keep existing semantics`() = runBlocking {
        val other = session.copy(sessionId = "other", name = "Find me", cwd = "/other", modelProvider = "two")
        val archived = session.copy(sessionId = "archived", archived = true)
        val state = initial.copy(sessions = mapOf("s" to session, "other" to other, "archived" to archived))
        val worker = DrawerCatalogWorker()
        assertEquals(2, worker.resolve(request(state)).content.sessions.size)
        assertEquals(setOf("s"), worker.resolve(request(state, filter.copy(agentKey = "codex"))).content.ids)
        assertEquals(setOf("other"), worker.resolve(request(state, filter.copy(agentKey = "codex",
            requestedProvider = providerFilterKey("two"), query = "find"))).content.ids)
        assertEquals(setOf("archived"), worker.resolve(request(state, filter.copy(archived = true))).content.ids)
        assertEquals(CURRENT_CODEX_PROVIDER, worker.resolve(request(state, filter.copy(
            requestedProvider = providerFilterKey("removed")))).providerKey)
        assertEquals(1, worker.resolve(request(state, filter.copy(query = "/other"))).content.directoryCount)
    }

    @Test fun `UI request equality never traverses maps and old hosts filters and languages are rejected`() {
        val guarded = object : Map<String, SessionCatalogEntry> by initial.sessions {
            override fun equals(other: Any?): Boolean = error("No collection equality on UI")
        }
        val state = initial.copy(sessions = guarded)
        assertEquals(request(state), request(state.copy(lastSequence = mapOf("transport" to 5))))
        assertNotEquals(request(state), request(state.copy(sessions = initial.sessions)))
        assertFalse(request().sameView(request(initial.copy(hostId = "other"))))
        assertFalse(request().sameView(request(filter = filter.copy(query = "new"))))
        assertFalse(request().sameView(DrawerCatalogRequest(initial, AppLanguage.English, filter)))
    }

    @Test fun `blocked history title projection runs off caller thread and cannot block UI work`() = runBlocking {
        val caller = Thread.currentThread()
        val entered = CountDownLatch(1)
        val release = CountDownLatch(1)
        val dispatcher = Executors.newSingleThreadExecutor { Thread(it, "drawer-test-worker") }.asCoroutineDispatcher()
        try {
            val cache = DrawerCatalogCache(SessionTitleCache {
                assertNotSame(caller, Thread.currentThread())
                entered.countDown()
                check(release.await(5, TimeUnit.SECONDS))
                "Background title"
            })
            val worker = DrawerCatalogWorker(dispatcher, cache)
            val state = initial.copy(sessionGraphs = mapOf("s" to SessionGraph("s")))
            val pending = async { worker.resolve(request(state)) }
            yield()
            assertTrue(withContext(Dispatchers.IO) { entered.await(5, TimeUnit.SECONDS) })
            assertFalse(pending.isCompleted)
            // The caller is executing here while the real projection is still blocked.
            release.countDown()
            assertEquals("Background title", pending.await().content.sessions.single().title)
        } finally { release.countDown(); dispatcher.close() }
    }

    @Test fun `conflation settles on newest host without dropping its catalog`() = runBlocking {
        val last = request(initial.copy(hostId = "last", sessions = mapOf("s" to session.copy(name = "Latest"))))
        val results = flowOf(request(), request(initial.copy(hostId = "middle")), last)
            .projectDrawerCatalog(DrawerCatalogWorker()).toList()
        assertEquals("last", results.last().identity.hostId)
        assertEquals("Latest", results.last().content.sessions.single().title)
    }

    @Test fun `background labels use the captured language rather than mutable UI language`() = runBlocking {
        val input = DrawerCatalogRequest(initial.copy(hostName = null), AppLanguage.English, filter)
        val result = DrawerCatalogWorker().resolve(input)
        assertEquals(L10n.format("已配对电脑", language = AppLanguage.English), result.content.sections.single().hostName)
        assertEquals(L10n.format("全部 provider", language = AppLanguage.English),
            result.options.single { it.key == ALL_CODEX_PROVIDERS }.label)
    }
}
