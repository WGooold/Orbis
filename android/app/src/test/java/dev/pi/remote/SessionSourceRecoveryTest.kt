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
    private fun cachedGraph(sessionId: String, entries: Map<String, SessionGraphEntry>, cursor: SessionBranchCursor = SessionBranchCursor()) =
        SessionGraph(sessionId, entries, cursor, cacheEpoch = "epoch")
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
    private fun checkpoint(state: RemoteState, seq: Long, entries: List<SessionGraphEntry> = emptyList(), head: String? = null, epoch: String = "epoch"): RemoteState {
        val pending = state.copy(sessionSyncCommands = mapOf("request" to PendingSessionSync(
            "runtime", "session", "sync", range = "preview", branchGeneration = state.sessionBranchGenerations["runtime"] ?: 0,
        )))
        val snapshot = SessionGraphSnapshot("session", "sync", SessionBranchCursor(head), "replace", entries,
            range = "preview", complete = true, source = SessionSourceEpoch(epoch, seq, true),
            checkpoint = SessionCheckpoint("$epoch:$seq", SessionBranchCursor(head), "complete", true),
            live = SessionLiveState(true, messages = listOf(SessionLiveMessage(row("live", "$seq"), false, true))),
        )
        return reducer.reduce(pending, """{"type":"runtime.event","runtimeId":"runtime","sequence":100,"event":${json.encodeToString(snapshot).dropLast(1)},"type":"session.snapshot"}}""")
    }

    @Test fun `new epoch handshake corrects cached parent and removes obsolete tail`() {
        val current = initial("c").copy(sessionGraphs = mapOf("session" to cachedGraph("session",
            mapOf("a" to entry("a"), "b" to entry("b", "a"), "c" to entry("c", "b")))))
        val boundary = receive(current, patch(1).copy(source = SessionSourceEpoch("new", 1, false)))
        val recovered = checkpoint(boundary, 2, listOf(entry("a"), entry("c", "a")), "c", "new")
        assertEquals(setOf("a", "c"), recovered.sessionGraphs.getValue("session").entries.keys)
        assertEquals("a", recovered.sessionGraphs.getValue("session").entries.getValue("c").parentId)
        assertEquals(listOf("a", "c", "live"), recovered.conversations.getValue("runtime").messages.map { it.messageId })
        assertEquals("new", recovered.conversations.getValue("runtime").sourceEpoch)
        assertFalse(recovered.conversations.getValue("runtime").isChatSyncing)
        val old = receive(recovered, patch(9, head = "b").copy(entries = listOf(entry("b", "a"))))
        assertEquals(recovered.sessionGraphs, old.sessionGraphs)
    }

    @Test fun `patch entries buffered before first checkpoint commit after handshake`() {
        val current = initial().copy(conversations = emptyMap())
        val waiting = receive(current, patch(3, head = "b").copy(entries = listOf(entry("b", "a"))))
        assertTrue(waiting.sessionGraphs.isEmpty())
        val recovered = checkpoint(waiting, 2, listOf(entry("a")), "a")
        assertEquals(listOf("a", "b", "live"), recovered.conversations.getValue("runtime").messages.map { it.messageId })
        assertEquals(3L, recovered.conversations.getValue("runtime").sourceSeq)
        assertFalse(recovered.conversations.getValue("runtime").isChatSyncing)
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
            sessionGraphs = mapOf("session" to cachedGraph("session", mapOf("current" to entry("current", "older")), SessionBranchCursor("current"))),
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
        assertFalse(changed.sessionGraphs.getValue("session").entries.containsKey("older"))
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
        val current = initial("tail").copy(sessionGraphs = mapOf("session" to cachedGraph(
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

    @Test fun `tool commit installs canonical entries before removing live without display recovery`() {
        val root = entry("root")
        val call = row("tool").copy(content = listOf(RemoteContent("tool_call", toolCallId = "tool", toolName = "bash")))
        val result = row("tool:result", "complete output").copy(role = "tool", toolCallId = "tool")
        fun canonical(message: ChatMessage, parent: String) = SessionGraphEntry(message.messageId, parent, "message", "1",
            buildJsonObject { put("message", json.encodeToJsonElement(ChatMessage.serializer(), message)) })
        val current = initial("root").copy(
            sessionGraphs = mapOf("session" to cachedGraph("session", mapOf("root" to root))),
            conversations = mapOf("runtime" to initial("root").conversations.getValue("runtime").copy(
                messages = listOf(row("root"), call), streamingMessageIds = setOf("tool"))),
        )
        val commit = patch(2, head = "tool:result").copy(
            entries = listOf(canonical(call, "root"), canonical(result, "tool")),
            live = SessionLiveState(true, turn = SessionLiveTurn("turn", 1)),
        )
        val changed = receive(current, commit)
        val conversation = changed.conversations.getValue("runtime")
        assertEquals(listOf("root", "tool", "tool:result"), conversation.messages.map(ChatMessage::messageId))
        assertEquals(listOf("root", "tool"), buildConversationPresentation(conversation.messages).messages.map(ChatMessage::messageId))
        assertEquals("complete output", buildConversationPresentation(conversation.messages).toolResults.getValue("tool").content.single().text)
        assertFalse(conversation.isChatSyncing)
        assertTrue(conversation.hasLiveSnapshot)
        assertTrue(conversation.streamingMessageIds.isEmpty())
        assertFalse("runtime" in changed.sessionSyncRequests)
        assertEquals("turn", conversation.activeTurnId)
    }

    @Test fun `out of order commits buffer entries until the source version gap closes`() {
        val current = initial("root").copy(sessionGraphs = mapOf("session" to cachedGraph("session", mapOf("root" to entry("root")))))
        val waiting = receive(current, patch(3, head = "b").copy(entries = listOf(entry("b", "a"))))
        assertEquals(1L, waiting.conversations.getValue("runtime").sourceSeq)
        assertEquals("root", waiting.runtimeSessionViews.getValue("runtime").leafId)
        assertFalse("b" in waiting.sessionGraphs.getValue("session").entries)
        val recovered = receive(waiting, patch(2, head = "a").copy(entries = listOf(entry("a", "root"))), sequence = 4)
        assertEquals(3L, recovered.conversations.getValue("runtime").sourceSeq)
        assertEquals(listOf("root", "a", "b", "live"), recovered.conversations.getValue("runtime").messages.map(ChatMessage::messageId))
        assertFalse(recovered.conversations.getValue("runtime").isChatSyncing)
    }

    @Test fun `canonical thinking keeps the first assistant card identity after commit`() {
        val thinking = row("thinking").copy(content = listOf(RemoteContent("thinking", "full thought")))
        val canonical = SessionGraphEntry("thinking", null, "message", "1", buildJsonObject {
            put("message", json.encodeToJsonElement(ChatMessage.serializer(), thinking))
        })
        val current = initial().copy(conversations = mapOf("runtime" to initial().conversations.getValue("runtime").copy(
            messages = listOf(thinking), streamingMessageIds = setOf("thinking"))))
        val changed = receive(current, patch(2, head = "thinking").copy(entries = listOf(canonical), live = SessionLiveState(true)))
        val shown = buildChatListItems(buildConversationPresentation(changed.conversations.getValue("runtime").messages).messages)
        assertEquals("thinking", shown.single().key)
        assertEquals(thinking.content, changed.conversations.getValue("runtime").messages.single().content)
        assertFalse(changed.conversations.getValue("runtime").isChatSyncing)
    }

    @Test fun `cyclic authoritative commit rejects the entire display transition`() {
        val current = initial("root").copy(sessionGraphs = mapOf("session" to cachedGraph("session", mapOf("root" to entry("root")))))
        val changed = receive(current, patch(2, head = "next").copy(entries = listOf(entry("next", "root"), entry("root", "next"))))
        assertEquals(current.sessionGraphs, changed.sessionGraphs)
        assertEquals(current.runtimeSessionViews, changed.runtimeSessionViews)
        assertEquals(1L, changed.conversations.getValue("runtime").sourceSeq)
        assertEquals(current.conversations.getValue("runtime").messages, changed.conversations.getValue("runtime").messages)
        assertTrue("runtime" in changed.sessionSyncFailures)
    }

    @Test fun `forward commit retains paged ancestors while rewind removes them`() {
        val base = initial("root")
        val current = base.copy(sessionGraphs = mapOf("session" to cachedGraph("session", mapOf("root" to entry("root")))),
            conversations = mapOf("runtime" to base.conversations.getValue("runtime").copy(
                messages = listOf(row("paged"), row("root"), row("live")))))
        val advanced = receive(current, patch(2, head = "next").copy(entries = listOf(entry("next", "root"))))
        assertEquals(listOf("paged", "root", "next", "live"), advanced.conversations.getValue("runtime").messages.map(ChatMessage::messageId))
        val rewound = receive(advanced, patch(3, head = "root"))
        assertEquals(listOf("root", "live"), rewound.conversations.getValue("runtime").messages.map(ChatMessage::messageId))
        val late = receive(rewound, patch(2, head = "next").copy(entries = listOf(entry("next", "root"))), sequence = 4)
        assertEquals(rewound.conversations, late.conversations)
        assertEquals("root", late.runtimeSessionViews.getValue("runtime").leafId)
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
            sessionGraphs = mapOf("session" to cachedGraph("session", mapOf("root" to entry("root")))),
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

    @Test fun `unversioned delayed catchup cannot refill a versioned cache`() {
        val current = initial("root").copy(
            sessionGraphs = mapOf("session" to cachedGraph("session", mapOf("root" to entry("root")), SessionBranchCursor("root"))),
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
        assertFalse(changed.sessionGraphs.getValue("session").entries.containsKey("old-tail"))
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

    @Test fun `cache rebuild invalidates old pages but preserves pairing and queued interaction state`() {
        val entry = entry("head")
        val pendingPage = PendingSessionSync("runtime", "session", "old-page", "catchup", "old-tail")
        val queued = QueuedMessage("queue", "after current turn", "followUp", "accepted")
        val interaction = PendingInteraction(
            requestId = "interaction", extensionId = "ext", kind = "confirm", title = "Confirm",
            description = null, options = emptyList(), placeholder = null,
        )
        val original = initial("head").copy(
            hostId = "host-paired",
            sessions = mapOf("session" to SessionCatalogEntry("session", hasHistoryCache = true)),
            sessionGraphs = mapOf("session" to cachedGraph("session", mapOf("head" to entry), SessionBranchCursor("head"))),
            sessionSyncCommands = mapOf("old-command" to pendingPage),
            pendingCommands = mapOf("old-command" to "runtime", "send-pending" to "runtime"),
            conversations = initial("head").conversations.mapValues { (_, conversation) ->
                conversation.copy(queuedMessages = mapOf(queued.queueId to queued), interactions = mapOf(interaction.requestId to interaction))
            },
        )

        val rebuilt = original.afterSessionCacheRebuild("session")
        assertTrue("session" !in rebuilt.sessionGraphs)
        assertFalse(rebuilt.sessions.getValue("session").hasHistoryCache)
        assertTrue(rebuilt.sessionSyncCommands.isEmpty())
        assertEquals(mapOf("send-pending" to "runtime"), rebuilt.pendingCommands)
        assertEquals("host-paired", rebuilt.hostId)
        assertEquals(mapOf(queued.queueId to queued), rebuilt.conversations.getValue("runtime").queuedMessages)
        assertEquals(mapOf(interaction.requestId to interaction), rebuilt.conversations.getValue("runtime").interactions)
        assertTrue(rebuilt.conversations.getValue("runtime").isChatSyncing)
        assertTrue("runtime" in rebuilt.sessionSyncRequests)
        val task = rebuilt.requestedSessionRecovery("runtime", 7, "fresh-checkpoint")
        assertEquals("preview", task?.range)
        assertNull(task?.targetLeafId)
        assertFalse(rebuilt.ownsSessionSnapshot("old-command", "runtime", "session", "old-page", "old-tail", "catchup"))
        val latePage = reducer.reduce(rebuilt, """{"type":"runtime.event","runtimeId":"runtime","sequence":50,"event":{
            "type":"session.snapshot","sessionId":"session","syncId":"old-page","range":"catchup","mode":"append",
            "cursor":{"leafId":"old-tail"},"complete":true,"entries":[
              {"entryId":"old-tail","parentId":null,"type":"message","timestamp":"1","data":{"message":{"role":"assistant","content":"obsolete"}}}
            ]}}""")
        assertTrue("session" !in latePage.sessionGraphs)
        assertEquals(rebuilt.conversations, latePage.conversations)
    }

    @Test fun `same source epoch and sequence checkpoint restores a cache-rebuilt projection`() {
        val original = initial("head").copy(sessionGraphs = mapOf(
            "session" to cachedGraph("session", mapOf("head" to entry("head")), SessionBranchCursor("head")),
        ))
        val rebuilt = original.afterSessionCacheRebuild("session")
        assertEquals("epoch", rebuilt.conversations.getValue("runtime").sourceEpoch)
        assertEquals(1L, rebuilt.conversations.getValue("runtime").sourceSeq)

        val recovered = checkpoint(rebuilt, 1, entries = listOf(entry("head")), head = "head")
        val conversation = recovered.conversations.getValue("runtime")
        assertEquals("epoch", conversation.sourceEpoch)
        assertEquals(1L, conversation.sourceSeq)
        assertTrue(conversation.sourceReady)
        assertTrue(conversation.hasLiveSnapshot)
        assertFalse(conversation.isChatSyncing)
        assertNull(conversation.systemNotice)
        assertEquals("head", recovered.runtimeSessionViews.getValue("runtime").leafId)
    }
}
