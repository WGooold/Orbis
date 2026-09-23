package dev.pi.remote

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.*
import org.junit.Test

class SessionSnapshotProjectionTest {
    private fun entry(id: String, parent: String?) = SessionGraphEntry(id, parent, "message", "stable",
        buildJsonObject { put("message", buildJsonObject { put("role", "user"); put("content", id) }) })
    private val runtime = RuntimeSummary("r", "R", "/", "idle", "s", sessionLeafId = "tail")
    private val graph = SessionGraph("s", listOf(entry("root", null), entry("tail", "root")).associateBy { it.entryId }, SessionBranchCursor("tail"))

    private fun reduce(state: RemoteState, snapshot: SessionGraphSnapshot): RemoteState {
        val payload = buildJsonObject {
            put("type", "runtime.event"); put("runtimeId", "r"); put("sequence", 1)
            put("event", JsonObject((Json.encodeToJsonElement(SessionGraphSnapshot.serializer(), snapshot) as JsonObject) +
                ("type" to kotlinx.serialization.json.JsonPrimitive("session.snapshot"))))
        }
        return RelayReducer().reduce(state, payload.toString(), snapshot.entries)
    }

    @Test
    fun `preview arriving after live tail growth cannot move the live or display leaf back`() {
        val pending = PendingSessionSync("r", "s", "sync", "preview", targetLeafId = null, viewLeafId = "root")
        val state = RemoteState(runtimes = mapOf("r" to runtime), sessionGraphs = mapOf("s" to graph),
            sessionSyncCommands = mapOf("c" to pending), runtimeSessionViews = mapOf("r" to RuntimeSessionView("r", "s", "tail")),
            conversations = mapOf("r" to RuntimeConversation(messages = projectSessionGraph(graph).messages,
                hasLiveSnapshot = true)))
        val next = reduce(state, SessionGraphSnapshot("s", "sync", SessionBranchCursor("root"), "replace",
            listOf(entry("root", null)), "preview", "root", complete = true))
        assertEquals("tail", next.runtimes["r"]?.sessionLeafId)
        assertEquals("tail", next.runtimeSessionViews["r"]?.leafId)
        assertEquals(listOf("root", "tail"), next.conversations["r"]?.messages?.map { it.messageId })
    }

    @Test
    fun `gap target is not a command to roll the runtime back`() {
        val pending = PendingSessionSync("r", "s", "sync", targetLeafId = "tail", requestTargetLeafId = "root")
        val incomplete = graph.copy(entries = graph.entries - "root")
        val state = RemoteState(runtimes = mapOf("r" to runtime), sessionGraphs = mapOf("s" to incomplete),
            sessionSyncCommands = mapOf("c" to pending), runtimeSessionViews = mapOf("r" to RuntimeSessionView("r", "s", "tail")))
        val next = reduce(state, SessionGraphSnapshot("s", "sync", SessionBranchCursor("root"), "replace",
            listOf(entry("root", null)), "catchup", "root", complete = true))
        assertEquals("tail", next.runtimes["r"]?.sessionLeafId)
        assertEquals("tail", next.runtimeSessionViews["r"]?.leafId)
        assertEquals(listOf("root", "tail"), next.conversations["r"]?.messages?.map { it.messageId })
    }

    @Test
    fun `filling a gap moves the history boundary to the newly visible cached prefix`() {
        for (first in listOf(1, 2)) {
            fun node(n: Int) = entry("e$n", if (n == 1) null else "e${n - 1}")
            val cached = ((first..3) + (8..10)).map(::node)
            val pending = PendingSessionSync("r", "s", "sync", "catchup",
                targetLeafId = "e10", knownLeafId = "e3", requestTargetLeafId = "e7", viewLeafId = "e10")
            val state = RemoteState(
                runtimes = mapOf("r" to runtime.copy(sessionLeafId = "e10")),
                sessionGraphs = mapOf("s" to SessionGraph("s", cached.associateBy { it.entryId }, SessionBranchCursor("e10"))),
                sessionSyncCommands = mapOf("c" to pending),
                runtimeSessionViews = mapOf("r" to RuntimeSessionView("r", "s", "e10")),
                sessionHistory = mapOf("r" to SessionHistoryState("s", "e10", "e8", hasOlder = true)),
                conversations = mapOf("r" to RuntimeConversation(messages = projectSessionEntries((8..10).map(::node)), hasLiveSnapshot = true)),
            )
            val next = reduce(state, SessionGraphSnapshot("s", "sync", SessionBranchCursor("e7"), "append",
                (4..7).map(::node), "catchup", "e7", complete = true))
            assertEquals((first..10).map { "e$it" }, next.conversations["r"]?.messages?.map { it.messageId })
            assertEquals("e$first", next.sessionHistory["r"]?.oldestEntryId)
            assertEquals(first != 1, next.sessionHistory["r"]?.hasOlder)
        }
    }

    @Test
    fun `all ranges require the current branch generation and exact paging boundary`() {
        for (range in listOf("preview", "history", "catchup")) {
            val pending = PendingSessionSync("r", "s", "sync", range, "tail", beforeEntryId = "tail".takeIf { range == "history" }, branchGeneration = 2)
            val state = RemoteState(runtimes = mapOf("r" to runtime), sessionSyncCommands = mapOf("c" to pending), sessionBranchGenerations = mapOf("r" to 2))
            fun owns(s: RemoteState, before: String? = pending.beforeEntryId) =
                s.ownsSessionSnapshot("c", "r", "s", "sync", "tail", range, before)
            assertTrue(owns(state))
            assertFalse(owns(state.copy(sessionBranchGenerations = mapOf("r" to 3))))
            assertFalse(owns(state, "wrong"))
            assertTrue(owns(state.copy(runtimes = mapOf("r" to runtime.copy(sessionLeafId = "newer")))))
        }
    }

    @Test
    fun `cached target page seeds the display without waiting for the missing prefix`() {
        val incomplete = graph.copy(entries = graph.entries - "root")
        val state = RemoteState(runtimes = mapOf("r" to runtime), sessionGraphs = mapOf("s" to incomplete),
            conversations = mapOf("r" to RuntimeConversation(messages = listOf(ChatMessage("live", "assistant", emptyList(), 1)),
                streamingMessageIds = setOf("live"))))
        val seeded = state.seedCachedSessionView("r", incomplete)
        assertEquals(listOf("tail", "live"), seeded.conversations["r"]?.messages?.map { it.messageId })
        assertTrue(seeded.conversations["r"]?.hasLiveSnapshot == true)
        assertNull(seeded.conversations["r"]?.chatSyncError)
        assertTrue(seeded.sessionHistory["r"]?.hasOlder == true)
    }

    @Test
    fun `failed write retains the tree and conversation and releases the history spinner`() {
        val state = RemoteState(runtimes = mapOf("r" to runtime), sessionGraphs = mapOf("s" to graph),
            conversations = mapOf("r" to RuntimeConversation(messages = projectSessionGraph(graph).messages)),
            sessionSyncCommands = mapOf("c" to PendingSessionSync("r", "s", "sync", "history", "tail")),
            sessionHistory = mapOf("r" to SessionHistoryState("s", "tail", "root", true, loading = true, requestId = "c")))
        val failed = state.failSessionSync("c", "disk full")
        assertEquals(state.sessionGraphs, failed.sessionGraphs)
        assertEquals(state.conversations["r"]?.messages, failed.conversations["r"]?.messages)
        assertFalse(failed.sessionHistory.getValue("r").loading)
        assertEquals("disk full", failed.conversations["r"]?.chatSyncError)
    }

    @Test
    fun `metadata invalidates proven branch changes but not disconnected fragments`() {
        val pending = PendingSessionSync("r", "s", "sync", targetLeafId = "tail")
        val state = RemoteState(runtimes = mapOf("r" to runtime), sessionGraphs = mapOf("s" to graph),
            sessionSyncCommands = mapOf("c" to pending))
        val payload = """{"type":"runtime.event","runtimeId":"r","sequence":1,"event":{
            "type":"runtime.metadata","metadata":{"runtimeId":"r","name":"R","cwd":"/","status":"idle",
            "sessionId":"s","sessionLeafId":"new","sessionGraphSync":true}}}"""
        val sibling = RelayReducer().reduce(state.copy(sessionGraphs = mapOf("s" to graph.copy(
            entries = graph.entries + ("new" to entry("new", "root")),
        ))), payload)
        assertEquals(1, sibling.sessionBranchGenerations["r"])
        assertTrue(sibling.sessionSyncCommands.isEmpty())
        val unknown = RelayReducer().reduce(state.copy(sessionGraphs = mapOf("s" to graph.copy(
            entries = graph.entries + ("new" to entry("new", "missing")),
        ))), payload)
        assertEquals(state.sessionBranchGenerations, unknown.sessionBranchGenerations)
        assertEquals(pending, unknown.sessionSyncCommands["c"])
    }
}
