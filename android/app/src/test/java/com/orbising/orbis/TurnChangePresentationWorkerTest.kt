package com.orbising.orbis

import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Test

class TurnChangePresentationWorkerTest {
    private val agent = ToolAgent("host", "codex", "session")
    private fun summary(id: String, anchor: String?, turn: String, startedAt: Long) = TurnChangeSummary(
        projectionVersion = 1, agent = agent, reviewTurnId = turn, changeSetId = id, sourceTurnIds = listOf(turn),
        manifestVersion = 1, anchorEntryId = anchor, startedAt = startedAt, finishedAt = startedAt + 1,
        state = "ready", outcome = "completed", coverage = "complete", attribution = "workspace-window", reasons = emptyList(),
        fileCount = 0, addedFiles = 0, modifiedFiles = 0, deletedFiles = 0, additions = 0, deletions = 0,
        preview = emptyList(), scope = "git-visible-files", revision = 1)

    @Test fun `matching is cached by immutable input identity and preserves last fragment ownership`() = runBlocking {
        val worker = TurnChangePresentationWorker()
        val row = ChatListItem.AssistantTurn(
            messages = listOf(ChatMessage("message", "assistant", emptyList(), 1)),
            completedMessageIds = setOf("message"),
        )
        val items = listOf(row)
        val turns = mapOf("message" to "turn")
        val summaries = linkedMapOf(
            "direct" to summary("direct", "message", "ignored", 2),
            "turn" to summary("turn", null, "turn", 1),
            "other" to summary("other", "elsewhere", "other", 0),
        )
        val request = TurnChangePresentationRequest(TurnChangePresentationIdentity("runtime", "session", 0), items, turns, summaries)

        val first = worker.resolve(request)
        val repeated = worker.resolve(request)

        assertSame(first, repeated)
        assertEquals(1, worker.computations)
        assertEquals(listOf("turn", "direct"), first.summariesByRow.getValue(row.key).map { it.changeSetId })
        assertFalse("other" in first.summariesByRow.values.flatten().map { it.changeSetId })
    }
}
