package com.orbising.orbis

import org.junit.Assert.*
import org.junit.Test

/** AGENT-DIAL-01: the saved policy and the dial presentation settle independently. */
class AgentDialStateTest {
    private val pi = AgentEnablementRow("pi", "Pi", true)
    private val codex = AgentEnablementRow("codex", "Codex CLI", false)
    private val rows = listOf(pi, codex)
    private fun ready(rows: List<AgentEnablementRow> = this.rows, revision: Long = 1) = RemoteState(
        hostId = "test-host", connection = RelayConnection.ONLINE, e2eReady = true,
        agentEnablementAvailable = true, agentEnablementRows = rows, agentEnablementRevision = revision,
        agentDial = AgentDialSync(cached = AgentDialSnapshot(revision, rows), synchronized = true, scoped = true),
    )

    @Test fun legacyRosterUsesOnlyHostAnnouncedProviderGroupsInStableDialOrder() {
        assertEquals(listOf("codex", "pi", "agy"), legacyAgentDialKinds(setOf("pi", "codexDesktop", "agy"), setOf("codex", "hermes")))
        assertEquals("agy", agentDialProviderGroup("agy"))
        assertEquals(emptyList<String>(), legacyAgentDialKinds(emptySet(), emptySet()))
        assertNull(legacyAgentDialKinds(null, null))
    }

    @Test fun broadcastChangesPolicyButNotTheOwnPinUntilItsReceipt() {
        val initial = ready()
        val sending = initial.copy(agentDial = initial.agentDial.enqueue("pi", false, rows, 1).beginWrite("off", rows, 1))
        val after = AgentDialSnapshot(2, listOf(pi.copy(enabled = false), codex))
        val broadcast = sending.withAgentDialSnapshot(after, null, null, 20)
        assertEquals(emptySet<String>(), broadcast.enabledAgentKinds())
        assertTrue(broadcast.agentDial.visualEnabled("pi", false))
        assertEquals("off", broadcast.agentDial.inFlight?.id)
        assertNull(broadcast.agentDial.notice)
        val receipt = broadcast.withAgentDialSnapshot(after, "off", "applied", 21)
        assertFalse(receipt.agentDial.visualEnabled("pi", false))
        assertEquals(AgentDialNotice("pi", "disabled", "off", 2), receipt.agentDial.notice)
        assertNull(receipt.agentDial.inFlight)
        assertEquals(receipt, receipt.withAgentDialSnapshot(AgentDialSnapshot(1, rows), null, null, 22))
    }

    @Test fun lateSuccessReceiptCannotReplaceAStillNewerBroadcast() {
        val initial = ready()
        val sending = initial.copy(agentDial = initial.agentDial.enqueue("pi", false, rows, 1).beginWrite("off", rows, 1))
        val newest = AgentDialSnapshot(3, listOf(pi.copy(enabled = true), codex.copy(enabled = true)))
        val broadcast = sending.withAgentDialSnapshot(newest, null, null, 10)
        val oldReply = AgentDialSnapshot(2, listOf(pi.copy(enabled = false), codex))
        val result = broadcast.withAgentDialSnapshot(oldReply, "off", "applied", 11)
        assertEquals(3L, result.agentEnablementRevision)
        assertEquals(setOf("pi", "codex"), result.enabledAgentKinds())
        assertEquals("conflict", result.agentDial.notice?.status)
    }

    @Test fun queueWaitsForReviewAndRevalidatesUndoAndApproval() {
        val initial = ready()
        val sending = initial.copy(agentDial = initial.agentDial.enqueue("pi", false, rows, 1)
            .beginWrite("off", rows, 1).enqueue("codex", true, rows, 1))
        val review = AgentDialReview("pi", 1, listOf("Session"), 1, "a".repeat(64))
        val awaiting = sending.withAgentDialRejection("off", review, null).agentDial
        assertEquals(review, awaiting.review)
        assertSame(awaiting, awaiting.beginWrite("premature", rows, 1))
        val approved = awaiting.enqueue("pi", false, rows, 1, review).beginWrite("confirmed", rows, 1)
        assertEquals("pi", approved.inFlight?.choice?.kind)
        assertEquals("codex", approved.queue.single().kind)
        val idle = AgentDialSync(synchronized = true)
        assertSame(idle, idle.enqueue("codex", true, rows, 2, expectedRevision = 1))
        val queuedUndo = idle.enqueue("codex", true, rows, 1, expectedRevision = 1)
        assertNull(queuedUndo.beginWrite("stale", rows, 2).inFlight)
    }

    @Test fun disconnectDropsAllUncertainIntentsAndRequiresTheFreshReadReceipt() {
        val initial = ready()
        val dial = initial.agentDial.enqueue("pi", false, rows, 1).beginWrite("old", rows, 1).enqueue("codex", true, rows, 1)
        val offline = initial.copy(agentEnablementRevision = null, agentEnablementRows = emptyList(), agentDial = dial.disconnected())
        assertNull(offline.enabledAgentKinds())
        assertEquals(rows, offline.agentDial.cached?.rows)
        assertFalse(offline.agentDialCanEdit())
        assertTrue(offline.agentDial.queue.isEmpty())
        val reconnect = offline.copy(agentDial = offline.agentDial.copy(inFlight = AgentDialRequest("read", null, null)))
        val updated = AgentDialSnapshot(2, listOf(pi, codex.copy(enabled = true)))
        assertSame(reconnect, reconnect.withAgentDialSnapshot(updated, "old", "applied", 21))
        val broadcast = reconnect.withAgentDialSnapshot(updated, null, null, 22)
        assertFalse(broadcast.agentDialCanEdit())
        val fetched = broadcast.withAgentDialSnapshot(updated, "read", null, 23)
        assertTrue(fetched.agentDialCanEdit())
        assertEquals("externalOn", fetched.agentDial.notice?.status)
        assertTrue(fetched.agentDial.queue.isEmpty())
    }

    @Test fun variantBadgesInfoHintsAndActiveSessionPinReleaseHintsMatchDialSpec() {
        assertEquals("terminal", agentDialVariant("codex"))
        assertEquals("terminal", agentDialVariant("dsh"))
        assertEquals("desktop", agentDialVariant("codexDesktop"))
        assertEquals("desktop", agentDialVariant("dshDesktop"))
        assertNull(agentDialVariant("claude"))
        assertEquals("在电脑上的 Orbis 里安装，完成后自动接入。", agentDialInfoHint("未安装"))
        assertEquals("在电脑上的 Orbis 里填写连接配置。", agentDialInfoHint("待配置"))
        assertNull(agentDialInfoHint("已连接"))
        assertEquals("松手启用", agentDialPinReleaseHint(effectiveEnabled = false, activeSessions = 2))
        assertEquals("松手停用", agentDialPinReleaseHint(effectiveEnabled = true, activeSessions = 0))
        assertEquals("松手后确认停用", agentDialPinReleaseHint(effectiveEnabled = true, activeSessions = 1))
    }
}
