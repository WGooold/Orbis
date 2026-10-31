package com.orbising.orbis

import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/** V20: a paged Pi conversation, followed by a result whose calling entry arrives later. */
internal class ToolContinuityFixture {
    private val json = Json { encodeDefaults = true }
    private fun entry(message: ChatMessage, parent: String?) = SessionGraphEntry(message.messageId, parent,
        "message", "1", buildJsonObject { put("message", json.encodeToJsonElement(ChatMessage.serializer(), message)) })
    private fun text(id: String, role: String, content: String) = ChatMessage(id, role, listOf(RemoteContent("text", content)), 1)
    private fun call(id: String, tool: String, parent: String?) = entry(ChatMessage(id, "assistant",
        listOf(RemoteContent("tool_call", toolCallId = tool, toolName = "bash",
            arguments = buildJsonObject { put("command", "echo continuity") })), 1), parent)
    private fun result(id: String, tool: String, parent: String) = entry(
        text(id, "tool", "Tool completed").copy(toolCallId = tool, toolName = "bash"), parent)

    val initial: RemoteState
    init {
        val entries = (0..7).flatMap { i -> listOf(
            entry(text("user-$i", "user", "Question $i"), if (i == 0) "older-page" else "reply-${i - 1}"),
            entry(text("reply-$i", "assistant", "READING_ANCHOR_$i\n\nExisting conversation content remains available."), "user-$i"),
        ) } + call("first-call", "tool-one", "reply-7") + result("first-result", "tool-one", "first-call")
        val graph = fixtureGraph("session", entries, SessionBranchCursor("first-result"), cacheEpoch = "epoch")
        initial = RemoteState(selectedRuntimeId = "runtime", connection = RelayConnection.ONLINE,
            runtimes = mapOf("runtime" to RuntimeSummary("runtime", "Pi continuity", "/fixture", "running", "session",
                agentKind = "pi", sessionGraphSync = true, sessionLeafId = "first-result")),
            sessionGraphs = mapOf("session" to graph),
            runtimeSessionViews = mapOf("runtime" to RuntimeSessionView("runtime", "session", "first-result")),
            sessionHistory = mapOf("runtime" to SessionHistoryState("session", "first-result", "user-0", true)),
            conversations = mapOf("runtime" to RuntimeConversation(messages = projectSessionGraph(graph).messages + listOf(
                text("second-live", "assistant", "The next tool is running."),
                ChatMessage("tool-live:tool-two", "assistant", listOf(RemoteContent("tool_call",
                    toolCallId = "tool-two", toolName = "bash")), 1),
            ), streamingMessageIds = setOf("second-live", "tool-live:tool-two"),
                sourceEpoch = "epoch", sourceSeq = 1, sourceHeadLeafId = "first-result", hasLiveSnapshot = true)))
    }

    fun advance(state: RemoteState, seq: Long, fillParent: Boolean = false): RemoteState {
        val entries = when {
            fillParent -> listOf(call("second-call", "tool-two", "first-result"))
            seq == 2L -> listOf(result("second-result", "tool-two", "second-call"))
            else -> emptyList()
        }
        val patch = SessionPatch(sessionId = "session", source = SessionSourceEpoch("epoch", seq, true),
            baseSeq = seq - 1, seq = seq, checkpointId = "epoch:$seq", head = SessionBranchCursor("second-result"),
            headCompleteness = "complete", entries = entries,
            live = SessionLiveState(true, turn = SessionLiveTurn("turn", 1)))
        return FixtureRelayReducer().reduce(state,
            """{"type":"runtime.event","runtimeId":"runtime","sequence":${seq * 2},"event":${json.encodeToString(patch)}}""")
    }

    fun catchupWhileWaiting(state: RemoteState, fillParent: Boolean = false): RemoteState {
        val seq = state.conversations.getValue("runtime").sourceSeq
        val pending = state.copy(sessionSyncCommands = state.sessionSyncCommands + ("continuity-catchup" to
            PendingSessionSync("runtime", "session", "continuity-catchup", range = "catchup", targetLeafId = "second-result")))
        val snapshot = SessionGraphSnapshot("session", "continuity-catchup", SessionBranchCursor("second-result"), "append",
            listOfNotNull(result("second-result", "tool-two", "second-call"),
                call("second-call", "tool-two", "first-result").takeIf { fillParent }),
            range = "catchup", targetLeafId = "second-result",
            complete = true, source = SessionSourceEpoch("epoch", seq, true))
        return FixtureRelayReducer().reduce(pending,
            """{"type":"runtime.event","runtimeId":"runtime","sequence":${seq * 2 + 1},"event":${json.encodeToString(snapshot).dropLast(1)},"type":"session.snapshot"}}""")
    }
}
