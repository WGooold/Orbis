package dev.pi.remote

import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.*
import org.junit.Test

class SessionSourceRecoveryTest {
    private val json = Json { encodeDefaults = true }
    private val reducer = RelayReducer()
    private fun row(id: String, text: String = id) = ChatMessage(id, "assistant", listOf(RemoteContent("text", text)), 1)
    private fun entry(id: String, parent: String? = null) = SessionGraphEntry(id, parent, "message", "1", buildJsonObject {
        put("message", json.encodeToJsonElement(ChatMessage.serializer(), row(id)))
    })
    private fun initial(head: String? = null) = RemoteState(
        selectedRuntimeId = "runtime", runtimes = mapOf("runtime" to RuntimeSummary(
            "runtime", "R", "/", "idle", "session", sessionGraphSync = true, sessionLeafId = head,
        )), conversations = mapOf("runtime" to RuntimeConversation(
            messages = listOf(row("live", "one")), streamingMessageIds = setOf("live"),
            sourceEpoch = "epoch", sourceSeq = 1, sourceHeadLeafId = head, hasLiveSnapshot = true,
            activeTurnId = "turn", turnTimings = mapOf("turn" to TurnTiming("turn", 1)),
            tools = mapOf("tool" to ToolActivity("tool", "bash", "started")),
        )), runtimeSessionViews = mapOf("runtime" to RuntimeSessionView("runtime", "session", head)),
    )
    private fun patch(seq: Long, base: Long = seq - 1, head: String? = null) = SessionPatch(
        sessionId = "session", source = SessionSourceEpoch("epoch", seq, true), baseSeq = base, seq = seq,
        checkpointId = "epoch:$seq", head = SessionBranchCursor(head), headCompleteness = "complete",
        live = SessionLiveState(true, messages = listOf(SessionLiveMessage(row("live", "$seq"), false, true))),
    )
    private fun receive(state: RemoteState, patch: SessionPatch, sequence: Long = patch.seq): RemoteState = reducer.reduce(
        state, """{"type":"runtime.event","runtimeId":"runtime","sequence":$sequence,"event":${json.encodeToString(patch)}}""",
    )
    private fun checkpoint(state: RemoteState, seq: Long, entries: List<SessionGraphEntry> = emptyList(), head: String? = null): RemoteState {
        val pending = state.copy(sessionSyncCommands = mapOf("request" to PendingSessionSync(
            "runtime", "session", "sync", range = "preview",
        )))
        val snapshot = SessionGraphSnapshot("session", "sync", SessionBranchCursor(head), "replace", entries,
            range = "preview", complete = true, source = SessionSourceEpoch("epoch", seq, true),
            checkpoint = SessionCheckpoint("epoch:$seq", SessionBranchCursor(head), "complete", true),
            live = SessionLiveState(true, messages = listOf(SessionLiveMessage(row("live", "$seq"), false, true))),
        )
        return reducer.reduce(pending, """{"type":"runtime.event","runtimeId":"runtime","sequence":100,"event":${json.encodeToString(snapshot).dropLast(1)},"type":"session.snapshot"}}""")
    }

    @Test fun `checkpoint retains and replays patches received after its capture`() {
        val withGap = receive(initial(), patch(3))
        assertEquals(1L, withGap.conversations.getValue("runtime").sourceSeq)
        val recovered = checkpoint(withGap, 2)
        val conversation = recovered.conversations.getValue("runtime")
        assertEquals(3L, conversation.sourceSeq)
        assertEquals("3", conversation.messages.single().content.single().text)
        assertTrue(conversation.sourcePatchBuffer.isEmpty())
        assertFalse(conversation.isChatSyncing)
    }

    @Test fun `patches arriving before the first checkpoint survive its epoch handshake`() {
        val withoutBaseline = initial().copy(conversations = initial().conversations.mapValues { (_, conversation) ->
            conversation.copy(sourceEpoch = null, sourceSeq = -1)
        })
        val waiting = receive(withoutBaseline, patch(3))
        assertNull(waiting.conversations.getValue("runtime").sourceEpoch)
        val recovered = checkpoint(waiting, 2)
        assertEquals(3L, recovered.conversations.getValue("runtime").sourceSeq)
        assertEquals("3", recovered.conversations.getValue("runtime").messages.single().content.single().text)
    }

    @Test fun `retired epoch patch cannot erase a buffered current epoch successor`() {
        val current = initial().copy(conversations = initial().conversations.mapValues { (_, conversation) ->
            conversation.copy(retiredSourceEpochs = setOf("retired"))
        })
        val withGap = receive(current, patch(3))
        val afterRetired = receive(withGap, patch(9).copy(source = SessionSourceEpoch("retired", 9, true)))
        val recovered = receive(afterRetired, patch(2))
        assertEquals(3L, recovered.conversations.getValue("runtime").sourceSeq)
    }

    @Test fun `history page does not install its attached live checkpoint`() {
        val current = initial("current").copy(
            sessionGraphs = mapOf("session" to SessionGraph("session", mapOf("current" to entry("current", "older")), SessionBranchCursor("current"))),
            sessionSyncCommands = mapOf("history" to PendingSessionSync("runtime", "session", "history", "history", "current", "current")),
        )
        val changed = reducer.reduce(current, """{"type":"runtime.event","runtimeId":"runtime","sequence":1,"event":{
          "type":"session.snapshot","sessionId":"session","syncId":"history","range":"history","mode":"prepend",
          "cursor":{"leafId":"current"},"beforeEntryId":"current","complete":true,"entries":[
            {"entryId":"older","parentId":null,"type":"message","timestamp":"1","data":{"message":{"role":"user","content":"older"}}}
          ],"source":{"epoch":"other","seq":99,"ready":true},
          "checkpoint":{"checkpointId":"other:99","head":{"leafId":"older"},"headCompleteness":"complete","inventoryComplete":true},
          "live":{"complete":true,"turn":null,"messages":[],"tools":[]}
        }}""")
        val conversation = changed.conversations.getValue("runtime")
        assertEquals("epoch", conversation.sourceEpoch)
        assertEquals(1L, conversation.sourceSeq)
        assertEquals("current", conversation.sourceHeadLeafId)
        assertEquals("current", changed.runtimeSessionViews.getValue("runtime").leafId)
        assertEquals("turn", conversation.activeTurnId)
        assertEquals(current.conversations.getValue("runtime").tools, conversation.tools)
        assertTrue(conversation.messages.any { it.messageId == "live" })
        assertTrue(changed.sessionGraphs.getValue("session").entries.containsKey("older"))
    }

    @Test fun `late legacy lifecycle and ctl idle cannot change the replicated turn`() {
        val current = initial()
        val lifecycle = listOf(
            """{"type":"message.delta","messageId":"live","text":" stale"}""",
            """{"type":"turn.finished","turnId":"turn","durationMs":9}""",
            """{"type":"tool.finished","toolCallId":"tool","toolName":"bash","isError":false}""",
            """{"type":"runtime.status","status":"idle"}""",
        )
        var changed = current
        lifecycle.forEachIndexed { index, event ->
            changed = reducer.reduce(changed, """{"type":"runtime.event","runtimeId":"runtime","sequence":${index + 1},"event":$event}""")
        }
        val conversation = changed.conversations.getValue("runtime")
        assertEquals("one", conversation.messages.single().content.single().text)
        assertEquals("turn", conversation.activeTurnId)
        assertEquals("started", conversation.tools.getValue("tool").state)
        assertEquals("running", changed.runtimes.getValue("runtime").status)
    }

    @Test fun `checkpoint with no active turn repairs a lost final idle event`() {
        val current = initial().let { state -> state.copy(runtimes = state.runtimes.mapValues { (_, runtime) -> runtime.copy(status = "running") }) }
        val changed = checkpoint(current, 2)
        assertNull(changed.conversations.getValue("runtime").activeTurnId)
        assertEquals("idle", changed.runtimes.getValue("runtime").status)
    }

    @Test fun `confirmed turn status is repaired while canonical head content is still missing`() {
        val current = initial().let { state -> state.copy(runtimes = state.runtimes.mapValues { (_, runtime) -> runtime.copy(status = "running") }) }
        val changed = checkpoint(current, 2, head = "uncached")
        assertTrue(changed.conversations.getValue("runtime").isChatSyncing)
        assertNull(changed.conversations.getValue("runtime").activeTurnId)
        assertEquals("idle", changed.runtimes.getValue("runtime").status)
    }

    @Test fun `patch changes head to a cached ancestor atomically`() {
        val current = initial("tail").copy(sessionGraphs = mapOf("session" to SessionGraph(
            "session", mapOf("root" to entry("root"), "tail" to entry("tail", "root")), SessionBranchCursor("tail"),
        )))
        val changed = receive(current, patch(2, head = "root"))
        val conversation = changed.conversations.getValue("runtime")
        assertEquals("root", changed.runtimeSessionViews.getValue("runtime").leafId)
        assertEquals(listOf("root", "live"), conversation.messages.map(ChatMessage::messageId))
        assertFalse(conversation.isChatSyncing)
        assertEquals(2L, conversation.sourceSeq)
    }

    @Test fun `missing patch head replaces old branch with a visible recovery gap`() {
        val changed = receive(initial(), patch(2, head = "uncached"))
        val conversation = changed.conversations.getValue("runtime")
        assertEquals("uncached", conversation.sourceHeadLeafId)
        assertEquals("uncached", changed.runtimeSessionViews.getValue("runtime").leafId)
        assertFalse(conversation.hasLiveSnapshot)
        assertTrue(conversation.isChatSyncing)
        assertTrue("runtime" in changed.sessionSyncRequests)
        assertEquals("2", conversation.messages.single().content.single().text)
    }

    @Test fun `metadata cannot revert a versioned source head`() {
        val current = initial("current")
        val changed = reducer.reduce(current, """{"type":"runtime.event","runtimeId":"runtime","sequence":1,"event":{
            "type":"runtime.metadata","metadata":{"runtimeId":"runtime","name":"R","cwd":"/","status":"idle",
            "sessionId":"session","sessionGraphSync":true,"sessionLeafId":"other"}}}""")
        assertEquals(current.conversations, changed.conversations)
        assertEquals("current", changed.runtimeSessionViews.getValue("runtime").leafId)
        assertTrue("runtime" in changed.sessionSyncRequests)
    }

    @Test fun `source recovery requests a checkpoint even with a fully covered cached leaf`() {
        val current = initial("root").copy(
            sessionGraphs = mapOf("session" to SessionGraph("session", mapOf("root" to entry("root")))),
        ).requestRuntimeRefresh("runtime")
        val task = current.requestedSessionRecovery("runtime", 7, "new-sync")!!
        assertEquals("preview", task.range)
        assertNull(task.targetLeafId)
        assertEquals(7, task.connectionGeneration)
        assertNull(current.queueSessionSync("request", task).requestedSessionRecovery("runtime", 7, "duplicate"))
    }

    @Test fun `malformed patch versions cannot establish or advance the source state`() {
        val malformed = patch(2).copy(source = SessionSourceEpoch("epoch", 3, true))
        val changed = receive(initial(), malformed)
        assertEquals(1L, changed.conversations.getValue("runtime").sourceSeq)
        assertTrue("runtime" in changed.sessionSyncRequests)
        assertTrue(changed.conversations.getValue("runtime").sourcePatchBuffer.isEmpty())
    }

    @Test fun `delayed catchup fills the old branch without moving a reverted head`() {
        val current = initial("root").copy(
            sessionGraphs = mapOf("session" to SessionGraph("session", mapOf("root" to entry("root")), SessionBranchCursor("root"))),
            sessionSyncCommands = mapOf("page" to PendingSessionSync("runtime", "session", "old-page", "catchup", "old-tail")),
        )
        val changed = reducer.reduce(current, """{"type":"runtime.event","runtimeId":"runtime","sequence":1,"event":{
            "type":"session.snapshot","sessionId":"session","syncId":"old-page","range":"catchup","mode":"append",
            "cursor":{"leafId":"old-tail"},"complete":true,"entries":[
              {"entryId":"old-tail","parentId":"root","type":"message","timestamp":"1","data":{"message":{"role":"assistant","content":"old branch"}}}
            ]}}""")
        val conversation = changed.conversations.getValue("runtime")
        assertEquals("root", conversation.sourceHeadLeafId)
        assertEquals(1L, conversation.sourceSeq)
        assertEquals("root", changed.runtimeSessionViews.getValue("runtime").leafId)
        assertFalse(conversation.messages.any { it.messageId == "old-tail" })
        assertTrue(conversation.messages.any { it.messageId == "live" })
        assertTrue(changed.sessionGraphs.getValue("session").entries.containsKey("old-tail"))
    }

    @Test fun `canonical page cannot close a recovery gap without the current head entry`() {
        val current = receive(initial(), patch(2, head = "uncached")).copy(
            sessionSyncCommands = mapOf("page" to PendingSessionSync("runtime", "session", "page", "catchup", "older")),
        )
        val changed = reducer.reduce(current, """{"type":"runtime.event","runtimeId":"runtime","sequence":3,"event":{
            "type":"session.snapshot","sessionId":"session","syncId":"page","range":"catchup","mode":"append",
            "cursor":{"leafId":"older"},"complete":true,"entries":[
              {"entryId":"older","parentId":null,"type":"message","timestamp":"1","data":{"message":{"role":"assistant","content":"old branch"}}}
            ]}}""")
        assertFalse(changed.conversations.getValue("runtime").hasLiveSnapshot)
        assertTrue(changed.conversations.getValue("runtime").isChatSyncing)
        assertTrue("runtime" in changed.sessionSyncRequests)
        assertFalse(changed.conversations.getValue("runtime").messages.any { it.messageId == "older" })
    }

    @Test fun `obsolete page cannot clear recovery already waiting for a checkpoint`() {
        val current = initial("head").copy(
            conversations = initial("head").conversations.mapValues { (_, conversation) -> conversation.copy(isChatSyncing = true) },
            sessionSyncRequests = setOf("runtime"),
            sessionSyncCommands = mapOf("page" to PendingSessionSync("runtime", "session", "page", "catchup", "older", branchGeneration = 0)),
            sessionBranchGenerations = mapOf("runtime" to 1),
        )
        val changed = reducer.reduce(current, """{"type":"runtime.event","runtimeId":"runtime","sequence":3,"event":{
            "type":"session.snapshot","sessionId":"session","syncId":"page","range":"catchup","mode":"append",
            "cursor":{"leafId":"older"},"complete":true,"entries":[]}}""")
        assertTrue(changed.conversations.getValue("runtime").isChatSyncing)
        assertEquals("head", changed.conversations.getValue("runtime").sourceHeadLeafId)
        assertTrue("runtime" in changed.sessionSyncRequests)
    }

    @Test fun `source checkpoint preserves the independent pending queue`() {
        val queue = mapOf("pending" to QueuedMessage("pending", "send later", "followUp", "accepted"))
        val current = initial().copy(conversations = initial().conversations.mapValues { (_, conversation) ->
            conversation.copy(queuedMessages = queue)
        })
        val recovered = checkpoint(current, 2)
        assertEquals(queue, recovered.conversations.getValue("runtime").queuedMessages)
    }

    @Test fun `same source patch can close a gap despite a lower outer transport watermark`() {
        val withGap = receive(initial(), patch(3), sequence = 30)
        val recovered = receive(withGap, patch(2), sequence = 20)
        assertEquals(3L, recovered.conversations.getValue("runtime").sourceSeq)
        assertEquals("3", recovered.conversations.getValue("runtime").messages.single().content.single().text)
    }

    @Test fun `checkpoint cannot establish a complete source version without an explicit head`() {
        val pending = initial().copy(sessionSyncCommands = mapOf("checkpoint" to PendingSessionSync(
            "runtime", "session", "no-head", "preview",
        )))
        val changed = reducer.reduce(pending, """{"type":"runtime.event","runtimeId":"runtime","sequence":1,"event":{
            "type":"session.snapshot","sessionId":"session","syncId":"no-head","range":"preview","mode":"replace",
            "cursor":{"leafId":null},"complete":true,"source":{"epoch":"epoch","seq":2,"ready":true},
            "checkpoint":{"checkpointId":"epoch:2","headCompleteness":"complete","inventoryComplete":true},
            "live":{"complete":true,"turn":null,"messages":[],"tools":[]}
        }}""")
        val conversation = changed.conversations.getValue("runtime")
        assertEquals(1L, conversation.sourceSeq)
        assertEquals("one", conversation.messages.single().content.single().text)
        assertTrue(conversation.isChatSyncing)
    }

    @Test fun `partial recovery waits before sending another checkpoint`() {
        val current = initial().copy(sessionSyncRequests = setOf("runtime"), conversations = initial().conversations.mapValues { (_, conversation) ->
            conversation.copy(sourceRecoveryRetryAt = 5_000)
        })
        val task = current.requestedSessionRecovery("runtime", 7, "next")!!
        val queued = current.queueSessionSync("request", task)
        assertTrue(advanceSessionSyncTasks(queued, 4_999, 7).send.isEmpty())
        assertEquals(1, advanceSessionSyncTasks(queued, 5_000, 7).send.size)
    }
}
