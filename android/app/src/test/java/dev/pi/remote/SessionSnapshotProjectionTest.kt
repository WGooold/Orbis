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
    fun `a newly loaded cached branch replaces an already live display and its old paging task`() {
        val pending = PendingSessionSync("r", "s", "old-sync", "history", "tail", beforeEntryId = "root")
        val state = RemoteState(
            runtimes = mapOf("r" to runtime.copy(sessionLeafId = "other")),
            sessionGraphs = mapOf("s" to graph),
            runtimeSessionViews = mapOf("r" to RuntimeSessionView("r", "s", "tail")),
            conversations = mapOf("r" to RuntimeConversation(messages = projectSessionGraph(graph).messages +
                ChatMessage("old-live", "assistant", emptyList(), 1), streamingMessageIds = setOf("old-live"), hasLiveSnapshot = true)),
            sessionHistory = mapOf("r" to SessionHistoryState("s", "tail", "old-boundary", true, true, "old-command")),
            sessionSyncCommands = mapOf("old-command" to pending),
            pendingCommands = mapOf("old-command" to "r"),
        )
        // SQLite can have complete coverage even though the current in-memory window lacks other.
        val loaded = graph.copy(entries = graph.entries + ("other" to entry("other", "root")))
        val seeded = state.seedCachedSessionView("r", loaded)

        assertEquals(listOf("root", "other"), seeded.conversations["r"]?.messages?.map { it.messageId })
        assertEquals("other", seeded.runtimeSessionViews["r"]?.leafId)
        assertEquals(SessionHistoryState("s", "other", "root", false), seeded.sessionHistory["r"])
        assertTrue(seeded.conversations["r"]?.streamingMessageIds?.isEmpty() == true)
        assertFalse(seeded.conversations.getValue("r").isChatSyncing)
        assertTrue(seeded.sessionSyncCommands.isEmpty())
        assertTrue(seeded.pendingCommands.isEmpty())
        assertEquals(1, seeded.sessionBranchGenerations["r"])

        val evictedOldLeaf = state.seedCachedSessionView("r", loaded.copy(entries = loaded.entries - "tail"))
        assertEquals(seeded.conversations["r"]?.messages, evictedOldLeaf.conversations["r"]?.messages)
        assertTrue(evictedOldLeaf.conversations["r"]?.streamingMessageIds?.isEmpty() == true)
        assertEquals(1, evictedOldLeaf.sessionBranchGenerations["r"])
    }

    @Test
    fun `cached forward growth preserves paged rows history ownership and an active stream`() {
        val loaded = SessionGraph("s", listOf(entry("tail", "missing"), entry("new", "tail")).associateBy { it.entryId })
        val pending = PendingSessionSync("r", "s", "history", "history", "tail", beforeEntryId = "older")
        val conversation = RuntimeConversation(
            messages = projectSessionEntries(listOf(entry("older", null), entry("tail", "missing"))) +
                ChatMessage("live", "assistant", emptyList(), 1),
            streamingMessageIds = setOf("live"), hasLiveSnapshot = true,
        )
        val state = RemoteState(runtimes = mapOf("r" to runtime.copy(sessionLeafId = "new", status = "running")),
            runtimeSessionViews = mapOf("r" to RuntimeSessionView("r", "s", "tail")),
            conversations = mapOf("r" to conversation), sessionSyncCommands = mapOf("c" to pending),
            sessionHistory = mapOf("r" to SessionHistoryState("s", "tail", "older", true, true, "c")))

        val seeded = state.seedCachedSessionView("r", loaded)

        assertEquals(listOf("older", "tail", "new", "live"), seeded.conversations["r"]?.messages?.map { it.messageId })
        assertEquals(setOf("live"), seeded.conversations["r"]?.streamingMessageIds)
        assertEquals(pending, seeded.sessionSyncCommands["c"])
        assertEquals(SessionHistoryState("s", "new", "older", true, true, "c"), seeded.sessionHistory["r"])
        assertEquals(state.sessionBranchGenerations, seeded.sessionBranchGenerations)
    }

    @Test
    fun `an unchanged cached leaf keeps its wider display without a loading flash`() {
        val state = RemoteState(runtimes = mapOf("r" to runtime),
            runtimeSessionViews = mapOf("r" to RuntimeSessionView("r", "s", "tail")),
            conversations = mapOf("r" to RuntimeConversation(messages = projectSessionGraph(graph).messages, hasLiveSnapshot = true)))
        assertSame(state, state.seedCachedSessionView("r", graph.copy(entries = graph.entries - "root")))
    }

    @Test
    fun `directory refresh schedules cached leaf changes before replacing the displayed view`() {
        val expanded = graph.copy(entries = graph.entries + ("new" to entry("new", "tail")))
        val initial = RemoteState(
            selectedRuntimeId = "r", runtimes = mapOf("r" to runtime.copy(sessionGraphSync = true)),
            sessionGraphs = mapOf("s" to expanded),
            runtimeSessionViews = mapOf("r" to RuntimeSessionView("r", "s", "tail")),
            conversations = mapOf("r" to RuntimeConversation(messages = projectSessionGraph(graph).messages,
                hasLiveSnapshot = true)),
        )
        for (leaf in listOf("new", "root", null)) {
            val summary = Json.encodeToString(RuntimeSummary.serializer(), runtime.copy(sessionLeafId = leaf, sessionGraphSync = true))
            for (directory in listOf(
                """{"type":"runtime.online","runtime":$summary}""",
                """{"type":"device.ready","deviceId":"phone","runtimes":[$summary]}""",
            )) {
                val announced = RelayReducer().reduce(initial, directory, channel = "ctl")
                assertTrue("r" in announced.sessionSyncRequests)
                if (leaf == "new") assertEquals("tail", announced.runtimeSessionViews["r"]?.leafId)

                val seeded = announced.seedCachedSessionView("r", expanded)
                assertEquals(leaf, seeded.runtimeSessionViews["r"]?.leafId)
                assertEquals(when (leaf) {
                    "new" -> listOf("root", "tail", "new")
                    "root" -> listOf("root")
                    else -> emptyList()
                }, seeded.conversations["r"]?.messages?.map { it.messageId })
                assertTrue(seeded.conversations.getValue("r").hasLiveSnapshot)
                assertFalse(seeded.conversations.getValue("r").isChatSyncing)
            }
        }
    }

    @Test
    fun `metadata without graph support keeps a live conversation when it has no leaf`() {
        val conversation = RuntimeConversation(messages = projectSessionGraph(graph).messages, hasLiveSnapshot = true)
        val state = RemoteState(runtimes = mapOf("r" to runtime.copy(sessionLeafId = null)),
            runtimeSessionViews = mapOf("r" to RuntimeSessionView("r", "s", null)),
            conversations = mapOf("r" to conversation), sessionSyncRequests = setOf("r"))
        val next = RelayReducer().reduce(state, """{"type":"runtime.event","runtimeId":"r","sequence":1,"event":{
            "type":"runtime.metadata","metadata":{"runtimeId":"r","name":"R","cwd":"/","status":"idle",
            "sessionId":"s","sessionGraphSync":false}}}""")

        assertEquals(conversation.messages, next.conversations["r"]?.messages)
    }

    @Test
    fun `a delayed tree success refresh keeps the next turn overlay while projecting its persisted branch`() {
        val live = ChatMessage("live", "assistant", emptyList(), 1)
        val activeTiming = TurnTiming("active", 1)
        val activeTool = ToolActivity("tool", "read", "running")
        val state = RemoteState(
            selectedRuntimeId = "r", runtimes = mapOf("r" to runtime.copy(status = "running", sessionGraphSync = true)),
            runtimeSessionViews = mapOf("r" to RuntimeSessionView("r", "s", "tail")),
            conversations = mapOf("r" to RuntimeConversation(
                messages = projectSessionGraph(graph).messages + live, hasLiveSnapshot = true,
                streamingMessageIds = setOf("live"), streamingSessionId = "s", activeTurnId = "active",
                turnTimings = mapOf("active" to activeTiming, "finished" to TurnTiming("finished", 0, 1)),
                tools = mapOf("tool" to activeTool, "finished" to ToolActivity("finished", "read", "finished")),
            )),
        )

        val refreshed = state.requestBranchRefresh("r")
        assertEquals(listOf(live), refreshed.conversations["r"]?.messages)
        val seeded = refreshed.seedCachedSessionView("r", graph)
        assertEquals(listOf("root", "tail", "live"), seeded.conversations["r"]?.messages?.map { it.messageId })
        assertEquals(setOf("live"), seeded.conversations["r"]?.streamingMessageIds)
        assertEquals(mapOf("active" to activeTiming), seeded.conversations["r"]?.turnTimings)
        assertEquals(mapOf("tool" to activeTool), seeded.conversations["r"]?.tools)
        assertEquals("active", seeded.conversations["r"]?.activeTurnId)
    }

    @Test
    fun `rewinding metadata to an empty branch clears messages overlays and pending history`() {
        val state = RemoteState(selectedRuntimeId = "r", runtimes = mapOf("r" to runtime.copy(sessionGraphSync = true)),
            sessionGraphs = mapOf("s" to graph), runtimeSessionViews = mapOf("r" to RuntimeSessionView("r", "s", "tail")),
            conversations = mapOf("r" to RuntimeConversation(messages = projectSessionGraph(graph).messages,
                streamingMessageIds = setOf("tail"), hasLiveSnapshot = true)),
            sessionSyncCommands = mapOf("c" to PendingSessionSync("r", "s", "old", "history", "tail")),
            pendingCommands = mapOf("c" to "r"), sessionSyncRequests = setOf("r"))
        val next = RelayReducer().reduce(state, """{"type":"runtime.event","runtimeId":"r","sequence":1,"event":{
            "type":"runtime.metadata","metadata":{"runtimeId":"r","name":"R","cwd":"/","status":"idle",
            "sessionId":"s","sessionLeafId":null,"sessionGraphSync":true}}}""")

        assertEquals(RuntimeSessionView("r", "s", null), next.runtimeSessionViews["r"])
        assertTrue(next.conversations.getValue("r").messages.isEmpty())
        assertTrue(next.conversations.getValue("r").hasLiveSnapshot)
        assertFalse(next.conversations.getValue("r").isChatSyncing)
        assertTrue(next.sessionSyncCommands.isEmpty())
        assertTrue(next.sessionSyncRequests.isEmpty())
        assertEquals(SessionHistoryState("s", null, null, false), next.sessionHistory["r"])
        assertTrue("r" !in next.sessionSyncRequests)
        assertFalse(next.requestRuntimeRefresh("r").conversations.getValue("r").isChatSyncing)
    }

    @Test
    fun `an authoritative empty preview completes the display while a late empty preview preserves a newer leaf`() {
        val state = RemoteState(runtimes = mapOf("r" to runtime), sessionGraphs = mapOf("s" to graph),
            runtimeSessionViews = mapOf("r" to RuntimeSessionView("r", "s", "tail")),
            conversations = mapOf("r" to RuntimeConversation(messages = projectSessionGraph(graph).messages, isChatSyncing = true)),
            sessionSyncCommands = mapOf("c" to PendingSessionSync("r", "s", "sync", "preview", viewLeafId = "tail")))
        val snapshot = SessionGraphSnapshot("s", "sync", SessionBranchCursor(null), "replace", emptyList(),
            range = "preview", complete = true, rangeStatus = "complete")
        val empty = reduce(state, snapshot)

        assertNull(empty.runtimes["r"]?.sessionLeafId)
        assertEquals(RuntimeSessionView("r", "s", null), empty.runtimeSessionViews["r"])
        assertTrue(empty.conversations.getValue("r").messages.isEmpty())
        assertTrue(empty.conversations.getValue("r").hasLiveSnapshot)
        assertFalse(empty.conversations.getValue("r").isChatSyncing)
        val advanced = state.copy(runtimes = mapOf("r" to runtime.copy(sessionLeafId = "new")))
        assertEquals("new", reduce(advanced, snapshot).runtimes["r"]?.sessionLeafId)
        assertEquals(state.conversations["r"]?.messages, reduce(advanced, snapshot).conversations["r"]?.messages)
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
