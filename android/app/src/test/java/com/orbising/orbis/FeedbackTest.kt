package com.orbising.orbis

import org.junit.Assert.*
import org.junit.Test

/** SC92/SC93: duplicated asynchronous failures must neither replay a banner nor hide a fatal connection rejection. */
class FeedbackTest {
    private fun banner(condition: FeedbackCondition) = AppFeedback(condition.name, condition.name, FeedbackLevel.F4, condition, FeedbackAction.RECHECK)
    @Test fun `banners keep priority suppression and condition recovery`() {
        var state = FeedbackState()
        FeedbackCondition.entries.reversed().forEach { state = state.present(banner(it)) }
        assertEquals(FeedbackCondition.PAIRING, state.banner?.condition)
        state = state.dismissBanner(FeedbackCondition.PAIRING.name)
        assertEquals(FeedbackCondition.VERSION, state.banner?.condition)
        state = state.present(banner(FeedbackCondition.PAIRING))
        assertEquals(FeedbackCondition.VERSION, state.banner?.condition)
        state = state.resolve(FeedbackCondition.PAIRING.name).present(banner(FeedbackCondition.PAIRING))
        assertEquals(FeedbackCondition.PAIRING, state.banner?.condition)
    }
    @Test fun `duplicate banner retains identity and does not replay`() {
        val first = FeedbackState().present(banner(FeedbackCondition.VERSION))
        assertSame(first, first.present(banner(FeedbackCondition.VERSION)))
    }
    @Test fun `short feedback respects ownership background and stale timers`() {
        val a = AppFeedback("operation-a", "saved", FeedbackLevel.F3)
        val b = AppFeedback("operation-b", "saved", FeedbackLevel.F3)
        var state = FeedbackState()
        assertNull(state.present(a).toast)
        state = state.visible(true).present(a)
        assertSame(state, state.present(a))
        state = state.present(b)
        assertEquals(b, state.toast)
        assertEquals(b, state.dismissToast(a.id).toast)
        state = state.visible(false)
        assertNull(state.toast)
        assertNull(state.present(a).visible(true).toast)
        assertTrue(state.present(banner(FeedbackCondition.VERSION)).clearScope().conditions.isEmpty())
    }
    @Test fun `fatal errors cannot be consumed by a matching object reader`() {
        val initial = RemoteState(sessionBrowse = SessionBrowseState("browse-request", isLoading = true))
        val result = RelayReducer().reduce(initial, """{"type":"protocol.error","requestId":"browse-request","code":"unauthorized"}""")
        assertEquals(FeedbackCondition.PAIRING, result.feedback.banner?.condition)
        assertNull(result.sessionBrowse?.error)
    }
    @Test fun `menu cannot claim a rejection without an active id`() {
        val loader = MenuOptionsLoader()
        assertFalse(loader.owns(kotlinx.serialization.json.buildJsonObject { put("type", kotlinx.serialization.json.JsonPrimitive("protocol.error")) }))
    }
    // SC92: a background completion is consumed, and distinct operations may reuse the same copy.
    @Test fun `consumed toast keys survive background and intervening results`() {
        val first = AppFeedback("first", "saved", FeedbackLevel.F3)
        var state = FeedbackState().present(first).visible(true)
        assertNull(state.present(first).toast)
        val second = AppFeedback("second", "saved", FeedbackLevel.F3)
        state = state.present(second)
        assertEquals(second, state.toast)
        state = state.dismissToast(second.id)
        assertNull(state.present(first).toast)
        assertEquals(2, state.shownToastKeys.size)
    }
    // SC93: a restored authenticated connection resolves the administrative condition without clearing F3.
    @Test fun `authenticated recovery resolves disabled computer and keeps short feedback`() {
        val toast = AppFeedback("saved-draft", "saved", FeedbackLevel.F3)
        val initial = RemoteState(feedback = FeedbackState(foreground = true).present(toast))
        val reducer = RelayReducer()
        val disabled = reducer.reduce(initial, """{"type":"protocol.error","code":"host_disabled"}""")
        assertEquals("computer-disabled", disabled.feedback.banner?.key)
        val restored = reducer.reduce(disabled, """{"type":"device.ready","deviceId":"phone","runtimes":[]}""", channel = "ctl")
        assertNull(restored.feedback.banner)
        assertEquals(toast, restored.feedback.toast)
        val ledgerRead = initial.copy(ledgerReads = mapOf("verify" to 1))
        val fatal = reducer.reduce(ledgerRead, """{"type":"protocol.error","requestId":"verify","code":"unauthorized"}""", channel = "ctl")
        assertEquals(FeedbackCondition.PAIRING, fatal.feedback.banner?.condition)
        val invalid = reducer.reduce(ledgerRead, """{"type":"protocol.error","requestId":"verify","code":"invalid_message"}""", channel = "ctl")
        assertEquals(FeedbackCondition.VERSION, invalid.feedback.banner?.condition)
    }
    @Test fun `a visible download failure stays inline and leaving adds one short feedback per retry`() {
        val task = ArtifactDownload("download", "host", displayName = "file.txt", status = "downloading")
        val initial = RemoteState(feedback = FeedbackState(foreground = true), downloads = mapOf(task.taskId to task))
        val failure = initial.copy(downloads = mapOf(task.taskId to task.copy(status = "failed", error = "read failed")))
        assertNull(failure.withTransferFailureFeedback(initial, TransferFeedbackScope(downloadsVisible = true)).feedback.toast)
        val away = failure.withTransferFailureFeedback(initial, TransferFeedbackScope())
        assertNotNull(away.feedback.toast)
        assertSame(away, away.withTransferFailureFeedback(away, TransferFeedbackScope()))
        val retry = away.copy(downloads = mapOf(task.taskId to task))
        val failedAgain = retry.copy(downloads = failure.downloads).withTransferFailureFeedback(retry, TransferFeedbackScope())
        assertNotEquals(away.feedback.toast?.key, failedAgain.feedback.toast?.key)
        val background = failure.copy(feedback = FeedbackState()).withTransferFailureFeedback(initial, TransferFeedbackScope())
        assertNull(background.feedback.visible(true).toast)
        assertNull(failure.withTransferFailureFeedback(RemoteState(), TransferFeedbackScope()).feedback.toast)
        assertNull(away.error)
        assertEquals("read failed", away.downloads[task.taskId]?.error)
    }
}
