package com.orbising.orbis

import org.junit.Assert.*
import org.junit.Test

/** S39 / SC60: only an authoritative successful terminal transition receives the default notification. */
class ReplyCompletionTest {
    private fun active() = RemoteState(hostId = "host", deviceId = "device", e2eReady = true, connection = RelayConnection.ONLINE,
        runtimes = mapOf("runtime" to RuntimeSummary("runtime","Codex","/repo","running","session")),
        conversations = mapOf("runtime" to RuntimeConversation(sourceEpoch = "epoch", sourceSeq = 1, sourceReady = true,
            activeTurnId = "turn", turnTimings = mapOf("turn" to TurnTiming("turn",100)))))
    private fun finished(before: RemoteState, outcome: String? = "completed") = before.copy(
        conversations = before.conversations.mapValues { (_, conversation) -> conversation.copy(sourceSeq = 2,
            activeTurnId = null, turnTimings = mapOf("turn" to TurnTiming("turn",100,20,outcome = outcome))) })

    @Test fun committedSourcePatchCarriesTheOptionalOutcomeIntoTheNotificationFact() {
        val before = active().withLiveFixture(SessionLiveState(true,SessionLiveTurn("turn",100)),runtimeId="runtime")
        val after = before.withLiveFixture(SessionLiveState(true,SessionLiveTurn("turn",100,20,"completed")),runtimeId="runtime")
        assertEquals("completed",after.conversations.getValue("runtime").turnTimings.getValue("turn").outcome)
        assertEquals("turn",confirmedReplyCompletions(before,after).single().turn)
    }

    @Test fun exactCompletionNotifiesOnceAndItsReceiptsSurviveReplayAndRestart() {
        val before = active(); val after = finished(before)
        val notice = confirmedReplyCompletions(before,after).single()
        val receipts = ReplyCompletionReceipts()
        assertTrue(receipts.claim(notice.identity))
        assertFalse(receipts.claim(confirmedReplyCompletions(before,after).single().identity))
        assertFalse(ReplyCompletionReceipts(receipts.snapshot()).claim(notice.identity))
        assertTrue(confirmedReplyCompletions(after,after).isEmpty())
        assertNotEquals(notice.identity, notice.copy(host="other").identity)
        assertNotEquals(notice.identity, notice.copy(session="other").identity)
        assertNotEquals(notice.identity, notice.copy(epoch="other").identity)
    }

    @Test fun cancellationFailureUnknownIdleAndReconnectCannotPretendTheReplyCompleted() {
        val before = active()
        for (outcome in listOf(null,"cancelled","failed","unknown","future-value"))
            assertTrue(confirmedReplyCompletions(before,finished(before,outcome)).isEmpty())
        assertTrue(confirmedReplyCompletions(before,before.copy(runtimes = before.runtimes.mapValues { it.value.copy(status="idle") })).isEmpty())
        assertTrue(confirmedReplyCompletions(before.copy(connection=RelayConnection.OFFLINE),finished(before)).isEmpty())
        assertTrue(confirmedReplyCompletions(before,finished(before).copy(e2eReady=false)).isEmpty())
        assertTrue(confirmedReplyCompletions(before,finished(before).copy(hostId="other")).isEmpty())
        assertTrue(confirmedReplyCompletions(before,finished(before).copy(conversations = mapOf("runtime" to finished(before).conversations.getValue("runtime").copy(sourceEpoch="new")))).isEmpty())
        assertTrue(confirmedReplyCompletions(RemoteState(),finished(before)).isEmpty())
    }
}
