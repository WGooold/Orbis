package com.orbising.orbis

import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SessionToolContinuityTest {
    private val json = Json { encodeDefaults = true }
    private val reducer = FixtureRelayReducer()
    private fun entry(id: String, parent: String?, role: String = "assistant") = SessionGraphEntry(
        id, parent, "message", "1", buildJsonObject {
            put("message", buildJsonObject { put("role", role); put("content", id) })
        },
    )
    private fun initial(): RemoteState {
        val entries = listOf(entry("user", null, "user"), entry("first-call", "user"),
            entry("first-result", "first-call", "toolResult"))
        val graph = fixtureGraph("session", entries, SessionBranchCursor("first-result"), cacheEpoch = "epoch")
        return RemoteState(selectedRuntimeId = "runtime",
            runtimes = mapOf("runtime" to RuntimeSummary("runtime", "Pi", "/fixture", "running", "session",
                agentKind = "pi", sessionGraphSync = true, sessionLeafId = "first-result")),
            sessionGraphs = mapOf("session" to graph),
            runtimeSessionViews = mapOf("runtime" to RuntimeSessionView("runtime", "session", "first-result")),
            sessionHistory = mapOf("runtime" to SessionHistoryState("session", "first-result", "user", false)),
            conversations = mapOf("runtime" to RuntimeConversation(messages = projectSessionGraph(graph).messages,
                sourceEpoch = "epoch", sourceSeq = 1, sourceHeadLeafId = "first-result", hasLiveSnapshot = true)))
    }
    private fun receive(state: RemoteState, seq: Long, head: String, entries: List<SessionGraphEntry> = emptyList(),
        live: SessionLiveState = SessionLiveState(true, turn = SessionLiveTurn("turn", 1))): RemoteState {
        val patch = SessionPatch(sessionId = "session", source = SessionSourceEpoch("epoch", seq, true),
            baseSeq = seq - 1, seq = seq, checkpointId = "epoch:$seq", head = SessionBranchCursor(head),
            headCompleteness = "complete", entries = entries, live = live)
        return reducer.reduce(state,
            """{"type":"runtime.event","runtimeId":"runtime","sequence":$seq,"event":${json.encodeToString(patch)}}""")
    }

    @Test fun `repeated live updates cannot publish a tool result whose parent is still missing`() {
        val initial = initial()
        val shown = initial.conversations.getValue("runtime").messages
        var state = receive(initial, 2, "second-result", listOf(entry("second-result", "second-call", "toolResult")))
        assertEquals(shown, state.conversations.getValue("runtime").messages)
        for (seq in 3L..5L) {
            state = receive(state, seq, "second-result")
            assertEquals("unresolved parent at source sequence $seq", shown, state.conversations.getValue("runtime").messages)
            assertEquals(false, state.sessionHistory.getValue("runtime").hasOlder)
        }
        state = receive(state, 6, "second-result", listOf(entry("second-call", "first-result")))
        assertEquals(listOf("user", "first-call", "first-result", "second-call", "second-result"),
            state.conversations.getValue("runtime").messages.map(ChatMessage::messageId))
        assertEquals(6L, state.conversations.getValue("runtime").sourceSeq)
        assertNull(state.conversations.getValue("runtime").retainedProjectionLeafId)
        assertFalse(state.conversations.getValue("runtime").isChatSyncing)
    }

    @Test fun `another tool result before the missing parent must retain the displayed branch`() {
        val initial = initial()
        var state = receive(initial, 2, "second-result", listOf(entry("second-result", "second-call", "toolResult")))
        state = receive(state, 3, "third-result", listOf(entry("third-result", "second-result", "toolResult")))
        assertEquals(initial.conversations.getValue("runtime").messages, state.conversations.getValue("runtime").messages)
        state = receive(state, 4, "third-result", listOf(entry("second-call", "first-result")))
        assertEquals(listOf("user", "first-call", "first-result", "second-call", "second-result", "third-result"),
            state.conversations.getValue("runtime").messages.map(ChatMessage::messageId))
    }

    @Test fun `live text and tool rows survive until canonical handoff is complete`() {
        val base = initial()
        val live = listOf(
            ChatMessage("live-text", "assistant", listOf(RemoteContent("text", "Step two")), 1),
            ChatMessage("tool-live:two", "assistant", listOf(RemoteContent("tool_call", toolCallId = "two", toolName = "bash")), 1),
        )
        val initial = base.copy(conversations = base.conversations.mapValues { (_, conversation) ->
            conversation.copy(messages = conversation.messages + live, streamingMessageIds = live.map { it.messageId }.toSet())
        })
        val pending = receive(initial, 2, "second-result", listOf(entry("second-result", "second-call", "toolResult")))
        assertEquals(initial.conversations.getValue("runtime").messages, pending.conversations.getValue("runtime").messages)
        assertEquals(setOf("live-text", "tool-live:two"), pending.conversations.getValue("runtime").streamingMessageIds)
        assertEquals("session", pending.conversations.getValue("runtime").streamingSessionId)
        assertTrue(pending.conversations.getValue("runtime").isChatSyncing)
        assertNull(pending.appliedSessionState("runtime"))
        val joined = receive(pending, 3, "second-result", listOf(entry("second-call", "first-result")))
        assertEquals(listOf("user", "first-call", "first-result", "second-call", "second-result"),
            joined.conversations.getValue("runtime").messages.map(ChatMessage::messageId))
        assertTrue(joined.conversations.getValue("runtime").streamingMessageIds.isEmpty())
    }

    @Test fun `cached first page cannot replace the retained branch with its disconnected result`() {
        val initial = initial()
        val pending = receive(initial, 2, "second-result", listOf(entry("second-result", "second-call", "toolResult")))
        val seeded = pending.seedCachedSessionView("runtime", pending.sessionGraphs.getValue("session"), cachedFirstPage = true)
        assertEquals(initial.conversations.getValue("runtime").messages, seeded.conversations.getValue("runtime").messages)
        assertEquals("user", seeded.sessionHistory.getValue("runtime").oldestEntryId)
        assertEquals(false, seeded.sessionHistory.getValue("runtime").hasOlder)
    }

    @Test fun `recovery checkpoint uses the retained branch even after the source head advanced`() {
        val initial = initial()
        val pending = receive(initial, 2, "second-result", listOf(entry("second-result", "second-call", "toolResult")))
            .copy(sessionSyncCommands = mapOf("request" to PendingSessionSync("runtime", "session", "sync", range = "preview")))
        val snapshot = SessionGraphSnapshot("session", "sync", SessionBranchCursor("second-result"), "replace", emptyList(),
            range = "preview", complete = true, source = SessionSourceEpoch("epoch", 3, true),
            checkpoint = SessionCheckpoint("epoch:3", SessionBranchCursor("second-result"), "complete", true),
            live = SessionLiveState(true, turn = SessionLiveTurn("turn", 1)))
        val recovered = reducer.reduce(pending,
            """{"type":"runtime.event","runtimeId":"runtime","sequence":3,"event":${json.encodeToString(snapshot).dropLast(1)},"type":"session.snapshot"}}""")
        assertEquals(initial.conversations.getValue("runtime").messages, recovered.conversations.getValue("runtime").messages)
        assertEquals("first-result", recovered.conversations.getValue("runtime").retainedProjectionLeafId)
        val joined = receive(recovered, 4, "second-result", listOf(entry("second-call", "first-result")))
        assertEquals(5, joined.conversations.getValue("runtime").messages.size)
        assertNull(joined.conversations.getValue("runtime").retainedProjectionLeafId)
    }

    @Test fun `a confirmed rewind while waiting replaces the branch and clears its retained anchor`() {
        val pending = receive(initial(), 2, "second-result", listOf(entry("second-result", "second-call", "toolResult")))
        val rewound = receive(pending, 3, "user")
        assertEquals(listOf("user"), rewound.conversations.getValue("runtime").messages.map(ChatMessage::messageId))
        assertNull(rewound.conversations.getValue("runtime").retainedProjectionLeafId)
        assertFalse(rewound.conversations.getValue("runtime").isChatSyncing)
    }

    @Test fun `cache rebuild discards the retained anchor with the invalidated rows`() {
        val pending = receive(initial(), 2, "second-result", listOf(entry("second-result", "second-call", "toolResult")))
        val rebuilt = pending.afterSessionCacheRebuild("session")
        assertNull(rebuilt.conversations.getValue("runtime").retainedProjectionLeafId)
        assertTrue(rebuilt.conversations.getValue("runtime").messages.isEmpty())
    }

    @Test fun `retaining rows does not retain a completed turn or an obsolete tool inventory`() {
        val base = initial()
        val running = base.copy(conversations = base.conversations.mapValues { (_, conversation) ->
            conversation.copy(activeTurnId = "turn", turnTimings = mapOf("turn" to TurnTiming("turn", 1)),
                tools = mapOf("second" to ToolActivity("second", "bash", "started")))
        })
        val stopped = receive(running, 2, "second-result", listOf(entry("second-result", "second-call", "toolResult")),
            live = SessionLiveState(true))
        val conversation = stopped.conversations.getValue("runtime")
        assertEquals(base.conversations.getValue("runtime").messages, conversation.messages)
        assertNull(conversation.activeTurnId)
        assertTrue(conversation.tools.isEmpty())
        assertTrue(conversation.isChatSyncing)
    }

    @Test fun `catchup page for the disconnected head cannot prepend its orphan result`() {
        val initial = initial()
        val orphan = entry("second-result", "second-call", "toolResult")
        val pending = receive(initial, 2, "second-result", listOf(orphan)).copy(
            sessionSyncCommands = mapOf("request" to PendingSessionSync("runtime", "session", "sync", range = "catchup",
                targetLeafId = "second-result")))
        val snapshot = SessionGraphSnapshot("session", "sync", SessionBranchCursor("second-result"), "append", listOf(orphan),
            range = "catchup", targetLeafId = "second-result", complete = true, source = SessionSourceEpoch("epoch", 2, true))
        val caughtUp = reducer.reduce(pending,
            """{"type":"runtime.event","runtimeId":"runtime","sequence":3,"event":${json.encodeToString(snapshot).dropLast(1)},"type":"session.snapshot"}}""")
        assertEquals(initial.conversations.getValue("runtime").messages, caughtUp.conversations.getValue("runtime").messages)
        assertEquals("first-result", caughtUp.conversations.getValue("runtime").retainedProjectionLeafId)
    }

    @Test fun `catchup filling the parent waits for atomic source live handoff`() {
        val fixture = ToolContinuityFixture()
        val pending = fixture.advance(fixture.initial, 2)
        val caughtUp = fixture.catchupWhileWaiting(pending, fillParent = true)
        assertEquals(fixture.initial.conversations.getValue("runtime").messages,
            caughtUp.conversations.getValue("runtime").messages)
        assertTrue(caughtUp.conversations.getValue("runtime").isChatSyncing)
        assertEquals("first-result", caughtUp.conversations.getValue("runtime").retainedProjectionLeafId)
        val joined = fixture.advance(caughtUp, 3)
        val conversation = joined.conversations.getValue("runtime")
        assertEquals(1, conversation.messages.count { it.messageId == "second-call" })
        assertTrue(conversation.streamingMessageIds.isEmpty())
        assertNull(conversation.retainedProjectionLeafId)
        assertFalse(conversation.isChatSyncing)
    }

    @Test fun `cached parent cannot expose canonical and retained live copies together`() {
        val fixture = ToolContinuityFixture()
        val pending = fixture.advance(fixture.initial, 2)
        val completeGraph = fixture.advance(pending, 3, fillParent = true).sessionGraphs.getValue("session")
        val seeded = pending.seedCachedSessionView("runtime", completeGraph, cachedFirstPage = true)
        assertEquals(fixture.initial.conversations.getValue("runtime").messages,
            seeded.conversations.getValue("runtime").messages)
        assertEquals("first-result", seeded.conversations.getValue("runtime").retainedProjectionLeafId)
        assertTrue(seeded.conversations.getValue("runtime").isChatSyncing)
    }
}
