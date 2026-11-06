package com.orbising.orbis

import org.junit.Assert.*
import org.junit.Test

class HomeUiSnapshotTest {
    private fun pairing(id: String) = HostPairing(id, id, "public", "root", emptyList(), "wss://example.test", "device", "credential")

    // Current and background Host transcripts must never invalidate the retained home surface.
    @Test fun `unrelated transcripts reuse the surface while menu and archive facts remain live`() {
        val worker = HomeUiWorker()
        val runtime = RuntimeSummary("r", "Agent", "/repo", "idle", "s", agentKind = "codex", sessionName = "Name")
        val answer = ChatMessage("a", "assistant", listOf(RemoteContent("text", "First")), 1)
        val initial = RemoteState(hostId = "h", runtimes = mapOf("r" to runtime),
            sessions = mapOf("s" to SessionCatalogEntry("s", cwd = "/repo", agentKind = "codex")),
            conversations = mapOf("r" to RuntimeConversation(messages = listOf(answer))))
        val other = initial.copy(hostId = "other")
        fun resolve(current: RemoteState, background: RemoteState = other) = worker.resolve(current,
            listOf(HostSnapshot(pairing("h"), current), HostSnapshot(pairing("other"), background)), AppLanguage.Chinese)
        val before = resolve(initial)
        repeat(60) { index ->
            val changed = initial.copy(conversations = mapOf("r" to RuntimeConversation(messages = listOf(answer.copy(content = listOf(RemoteContent("text", "$index")))))))
            assertSame(before, resolve(changed, changed.copy(hostId = "other")))
        }
        assertTrue(before.state.conversations.isEmpty())
        assertTrue(before.state.sessionGraphs.isEmpty())
        assertTrue(before.hosts.all { it.state.conversations.isEmpty() })
        val waiting = other.copy(runtimes = mapOf("r" to runtime.copy(status = "waiting_local_interaction")))
        val menu = resolve(initial, waiting)
        assertNotSame(before, menu)
        assertTrue(menu.hosts.last().hasPendingInteraction)
        val (archived, _) = initial.createArchive("archive", "s", "codex", true, 10)
        assertTrue(resolve(archived).catalog.single().directories.single().sessions.single().isArchived)
        val switched = worker.resolve(other, listOf(HostSnapshot(pairing("other"), other)), AppLanguage.Chinese)
        assertEquals("other", switched.state.hostId)
        assertEquals("other", switched.catalog.single().hostId)
    }
}
