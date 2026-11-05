package com.orbising.orbis

import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.*
import org.junit.Test

class DrawerCatalogCacheTest {
    private val session = SessionCatalogEntry("s", cwd = "/repo", agentKind = "codex")
    private val runtime = RuntimeSummary("r", "Runtime", "/repo", "idle", sessionId = "s", agentKind = "codex")
    private val initial = RemoteState(hostId = "host", hostName = "Computer", sessions = mapOf("s" to session))
    private fun DrawerCatalogCache.get(state: RemoteState?) = resolve(state, AppLanguage.Chinese)
    private fun List<CachedHostGroup>.row() = single().directories.single().sessions.single()

    @Test fun `transport and connection updates reuse the whole catalog`() {
        val cache = DrawerCatalogCache()
        val state = initial.copy(sessions = (0 until 2000).associate { index ->
            val id = "s$index"
            id to session.copy(sessionId = id, cwd = "/repo/${index % 100}", modifiedAt = index.toLong())
        })
        val tree = cache.get(state)
        repeat(100) { index ->
            val next = state.copy(lastSequence = mapOf("relay" to index.toLong()),
                e2eReady = index % 2 == 0, connection = RelayConnection.ONLINE)
            assertSame(tree, cache.get(next))
        }
        assertEquals(2000, tree.single().directories.sumOf { it.sessions.size })
    }

    @Test fun `catalog edits invalidate even when size and first session stay the same`() {
        val cache = DrawerCatalogCache()
        val state = initial.copy(sessions = initial.sessions + ("second" to session.copy(sessionId = "second")))
        val before = cache.get(state)
        val next = state.copy(sessions = state.sessions + ("second" to state.sessions.getValue("second")
            .copy(name = "Updated", cwd = "/moved", modifiedAt = 100)))
        val after = cache.get(next)
        assertNotSame(before, after)
        assertEquals(cachedHistoryTree(next), after)
        assertEquals("/moved", after.single().directories.first().cwd)
        assertEquals("Updated", after.single().directories.first().sessions.single().title)
    }

    @Test fun `runtime name identity online state and removal invalidate`() {
        val cache = DrawerCatalogCache()
        cache.get(initial)
        val live = initial.copy(runtimes = mapOf("r" to runtime.copy(sessionName = "Live name")))
        assertEquals("Live name", cache.get(live).row().title)
        assertTrue(cache.get(live).row().isOnline)
        val renamed = live.copy(runtimes = mapOf("r" to runtime.copy(sessionName = "Renamed")))
        assertEquals("Renamed", cache.get(renamed).row().title)
        assertFalse(cache.get(initial).row().isOnline)
        assertEquals(cachedHistoryTree(initial), cache.get(initial))
    }

    @Test fun `loaded history title corrections invalidate with unchanged entry count`() {
        fun withTitle(title: String): RemoteState = initial.copy(sessionGraphs = mapOf("s" to fixtureGraph("s",
            listOf(SessionGraphEntry("first", type = "message", timestamp = "2026-11-05T00:00:00.000Z", data = buildJsonObject {
                put("message", buildJsonObject { put("role", "user"); put("content", title) })
            })), SessionBranchCursor("first"))))
        val cache = DrawerCatalogCache()
        assertEquals("First question", cache.get(withTitle("First question")).row().title)
        assertEquals("Corrected question", cache.get(withTitle("Corrected question")).row().title)
    }

    @Test fun `live fallback title and message count invalidate`() {
        val cache = DrawerCatalogCache()
        val live = initial.copy(runtimes = mapOf("r" to runtime))
        cache.get(live)
        val message = ChatMessage("m", "user", listOf(RemoteContent("text", "Live question")), 1)
        val next = live.copy(conversations = mapOf("r" to RuntimeConversation(messages = listOf(message))))
        assertEquals("Live question", cache.get(next).row().title)
        assertEquals(1, cache.get(next).row().messageCount)
        val changed = next.copy(conversations = mapOf("r" to RuntimeConversation(messages = listOf(
            message.copy(content = listOf(RemoteContent("text", "Edited question")))))))
        assertEquals("Edited question", cache.get(changed).row().title)
    }

    @Test fun `archive ledger changes are visible before and after settlement`() {
        val cache = DrawerCatalogCache()
        assertFalse(cache.get(initial).row().isArchived)
        val (pending, _) = initial.createArchive("archive", "s", "codex", true, 100)
        assertTrue(cache.get(pending).row().isArchived)
        assertEquals(cachedHistoryTree(pending), cache.get(pending))
        assertFalse(cache.get(initial).row().isArchived)
    }

    @Test fun `host rename switch removal and language cannot reuse the previous projection`() {
        val cache = DrawerCatalogCache()
        val before = cache.get(initial)
        val renamed = initial.copy(hostName = "Renamed computer")
        assertEquals("Renamed computer", cache.get(renamed).single().hostname)
        val switched = renamed.copy(hostId = "other-host")
        assertEquals("other-host", cache.get(switched).single().hostId)
        assertTrue(cache.get(null).isEmpty())
        assertNotSame(before, cache.get(initial))
        val chinese = cache.get(initial)
        val english = cache.resolve(initial, AppLanguage.English)
        assertNotSame(chinese, english)
        assertEquals(chinese, english) // All labels in this fixture are supplied by the Host.
    }

    @Test fun `offline titles do not scan online runtimes per catalog entry`() {
        var runtimeTraversals = 0
        val actual = mapOf("r" to runtime)
        val counted = object : Map<String, RuntimeSummary> by actual {
            override val values: Collection<RuntimeSummary> get() {
                runtimeTraversals++
                return actual.values
            }
        }
        val state = initial.copy(runtimes = counted, sessions = (0 until 1000).associate { index ->
            val id = "offline-$index"
            id to session.copy(sessionId = id, name = "Title $index")
        })
        val tree = cachedHistoryTree(state)
        assertEquals(1001, tree.single().directories.single().sessions.size)
        assertEquals(1, runtimeTraversals)
        assertEquals("Title 999", tree.single().directories.single().sessions.single { it.sessionId == "offline-999" }.title)
    }
}
