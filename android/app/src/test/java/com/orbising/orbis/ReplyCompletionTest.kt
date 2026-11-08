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
    @Test fun handshakeThenCompletedRecoveryDoesNotInheritAnOldConnectionsActiveTurn() {
        val running = active()
        val starting = running.copy(conversations=running.conversations.mapValues { it.value.copy(sourceSeq=0,activeTurnId=null) })
        val observer = ReplyCompletionObserver()
        assertTrue(observer.observe(starting,running,1).isEmpty())
        assertEquals(1,observer.observe(running,finished(running),1).size)
        assertTrue(observer.observe(starting,running,2).isEmpty())
        val disconnected=running.copy(e2eReady=false,connection=RelayConnection.RECONNECTING)
        observer.observe(running,disconnected,2)
        val handshake=disconnected.copy(e2eReady=true,connection=RelayConnection.ONLINE)
        observer.observe(disconnected,handshake,3)
        assertTrue(observer.observe(handshake,finished(running),3).isEmpty())
        assertTrue(observer.observe(starting,running,3).isEmpty())
        assertEquals(1,observer.observe(running,finished(running),3).size)
    }
    @Test fun sameConnectionRecoverySnapshotSeedsButNeverNotifiesAndFreshPatchStillCompletes() {
        val observer=ReplyCompletionObserver();val running=active()
        val starting=running.copy(conversations=running.conversations.mapValues { it.value.copy(sourceSeq=0,activeTurnId=null) })
        observer.observe(starting,running,1,allowCompletion=false)
        assertTrue(observer.observe(running,finished(running),1,allowCompletion=false).isEmpty())
        assertTrue(observer.observe(running,finished(running),1).isEmpty())
        val fresh=running.copy(conversations=running.conversations.mapValues { (_,c) -> c.copy(sourceSeq=3,
            activeTurnId="fresh",turnTimings=mapOf("fresh" to TurnTiming("fresh",200))) })
        observer.observe(finished(running),fresh,1)
        val done=fresh.copy(conversations=fresh.conversations.mapValues { (_,c) -> c.copy(sourceSeq=4,
            activeTurnId=null,turnTimings=mapOf("fresh" to TurnTiming("fresh",200,10,outcome="completed"))) })
        assertEquals("fresh",observer.observe(fresh,done,1).single().turn)
    }
}
