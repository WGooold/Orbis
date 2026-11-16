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
    // SC92: changing the active computer must preserve its unresolved connection conditions for a later return.
    @Test fun `host scope switch retains active and dismissed connection conditions without replaying toasts`() {
        val version = banner(FeedbackCondition.VERSION)
        val pairing = banner(FeedbackCondition.PAIRING)
        val state = FeedbackState(foreground = true).present(version).present(pairing)
            .dismissBanner(pairing.key).present(AppFeedback("completed", "saved", FeedbackLevel.F3))
        val away = state.clearScope(preservingConnectionConditions = true)
        assertEquals(state.conditions, away.conditions)
        assertEquals(state.dismissed, away.dismissed)
        assertEquals(version, away.banner)
        assertNull(away.toast)
        assertNull(away.present(AppFeedback("completed", "saved", FeedbackLevel.F3)).toast)
    }
    // SC93: temporary administrative disablement recovers after the administrator re-enables the computer.
    @Test fun `disabled computer keeps retrying and its action opens settings`() {
        assertFalse(connectionRejectionStopsReconnect("host_disabled"))
        assertTrue(connectionRejectionStopsReconnect("device_mismatch"))
        assertTrue(connectionRejectionStopsReconnect("unauthorized"))
        assertTrue(connectionRejectionStopsReconnect("protocol_version_mismatch"))
        assertEquals(L10n.tr("设置"), feedbackActionText(FeedbackAction.SETTINGS, FeedbackCondition.OTHER))
        assertEquals(L10n.tr("检查更新"), feedbackActionText(FeedbackAction.SETTINGS, FeedbackCondition.VERSION))
    }
    // SC97: an invalid draft belongs to the composer and must not mark the session card or drawer as failed.
    @Test fun `composer validation stays local and does not replace session operation failures`() {
        val existing = mapOf("chat" to "关闭未完成", "other-session" to "归档未完成")
        val initial = RemoteState(sessionOperationErrors = existing)
        val failure = userMessageInputError("/help")!!
        val invalid = initial.composerFailure("chat", failure)
        assertEquals(failure, invalid.conversations["chat"]?.operationError)
        assertEquals(existing, invalid.sessionOperationErrors)
        val corrected = invalid.composerFailure("chat", "")
        assertNull(corrected.conversations["chat"]?.operationError)
        assertEquals(existing, corrected.sessionOperationErrors)
        assertEquals("关闭失败", initial.sessionFailure("chat", "关闭失败").sessionOperationErrors["chat"])
    }
    // SC98: opaque codes are diagnostic-only, while filenames, paths and natural language remain useful feedback.
    @Test fun `failure copy preserves filenames paths and ordinary transport words`() {
        val fallback = "请重试"
        listOf("无法打开 my_notes.txt", "无法读取 /home/host/my_notes.txt", "Host 无法读取当前文件", "The runtime could not open the file", "my_notes.txt").forEach { message ->
            assertEquals(message, feedbackFailureText(message, fallback))
        }
        assertEquals(fallback, feedbackFailureText("host_busy", fallback))
        assertEquals(fallback, feedbackFailureText("protocol_version_mismatch", fallback))
    }
    // SC101: future and currently unlisted machine codes obey the same diagnostic-only presentation rule.
    @Test fun `unregistered machine codes stay diagnostic only without hiding file paths`() {
        val fallback = "请重试"
        for (code in listOf("session_busy", "write_failed", "write_permission_denied", "future_backend_rejection", "my_notes")) {
            assertEquals(code, fallback, feedbackFailureText(code, fallback))
            assertEquals(code, "请求失败，请重试", feedbackFailureText("请求失败，请重试（$code）", fallback))
            assertEquals(code, fallback, feedbackFailureText("请求失败 $code", fallback))
        }
        for (message in listOf("无法读取 session_busy.txt", "无法读取 /repo/write_failed", "无法读取 C:\\repo\\write_failed.txt", "WS connection closed", "QUIC connection interrupted")) {
            assertEquals(message, feedbackFailureText(message, fallback))
        }
    }
    @Test fun `known error annotations are hidden without removing useful failure details`() {
        assertEquals("请求失败，请重试", feedbackFailureText("请求失败，请重试（invalid_request）", "请重试"))
        assertEquals("请重试", feedbackFailureText("请求失败 invalid_request", "请重试"))
        assertEquals("无法打开 /repo/host_busy.txt", feedbackFailureText("无法打开 /repo/host_busy.txt", "请重试"))
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
    // SC99: finishing the rejected reader must preserve its connection condition.
    @Test fun `fatal errors finish the matching reader and retain the connection banner`() {
        val initial = RemoteState(sessionBrowse = SessionBrowseState("browse-request", isLoading = true))
        val result = RelayReducer().reduce(initial, """{"type":"protocol.error","requestId":"browse-request","code":"unauthorized"}""")
        assertEquals(FeedbackCondition.PAIRING, result.feedback.banner?.condition)
        assertFalse(result.sessionBrowse?.isLoading ?: true)
        assertFalse(result.sessionBrowse?.error.isNullOrBlank())
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
