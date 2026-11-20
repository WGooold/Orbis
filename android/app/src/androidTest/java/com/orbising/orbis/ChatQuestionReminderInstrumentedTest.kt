// Orbis 测试用途（场景与判定见本文件断言）：
// - MOT-20 / SC42（MOT-20、SC42、R54、S24、V01、V03）
package com.orbising.orbis

import android.graphics.Bitmap
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import androidx.compose.runtime.MutableState
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.test.*
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.lifecycle.ViewModelStore
import androidx.test.core.app.ApplicationProvider
import java.io.File
import kotlin.math.ceil
import kotlin.math.floor
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

class ChatQuestionReminderInstrumentedTest {
    @get:Rule val compose = createComposeRule()
    private val question = "帮我比较这两种实现的阅读体验，保留滚动位置、消息身份和现有动效。\n也请考虑长问题、附件、连续追问和 👩🏽‍💻 的显示。"
    private fun text(id: String, role: String, body: String) = ChatMessage(id, role, listOf(RemoteContent("text", body)), 1)
    private fun initial() = RemoteState(hostId = "question-host", selectedRuntimeId = "r",
        runtimes = mapOf("r" to RuntimeSummary("r", "提醒测试", "/repo", "idle", "s", agentKind = "codex")),
        conversations = mapOf("r" to RuntimeConversation(messages = listOf(
            text("old-user", "user", "之前的问题"), text("old-reply", "assistant", (1..30).joinToString("\n\n") { "之前的回复 $it" }),
            text("question", "user", question), text("reply", "assistant", (1..80).joinToString("\n\n") { "阅读锚点 $it" }),
        ))))

    private fun withChat(dark: Boolean = false, exercise: (MutableState<RemoteState>, LazyListState, CoroutineScope) -> Unit) {
        val app = IsolatedTestApplication(ApplicationProvider.getApplicationContext(), "question-reminder")
        val owner = ViewModelStore()
        val model = RemoteViewModel(app)
        owner.put("question-reminder", model)
        val state = mutableStateOf(initial())
        val scroll = LazyListState()
        lateinit var scope: CoroutineScope
        try {
            compose.setContent {
                scope = rememberCoroutineScope()
                OrbisTheme(darkTheme = dark) { ChatScreen(state.value, model, scroll) }
            }
            compose.waitForIdle()
            compose.onNodeWithTag("chat-question-reminder").assertDoesNotExist()
            compose.onNodeWithTag("chat-transcript").performTouchInput { swipeDown() }
            compose.runOnIdle { scope.launch { scroll.scrollToItem(4, 350) } }
            compose.waitForIdle()
            compose.onNodeWithTag("chat-question-reminder").assertIsDisplayed()
            exercise(state, scroll, scope)
        } finally {
            compose.runOnIdle { owner.clear() }
            app.dispose()
        }
    }

    @Test fun readingShowsTheQuestionAndTappingLocatesItWithoutFollowing() = reading(dark = false)
    @Test fun darkReadingKeepsTheSameVisibilityAndGeometry() = reading(dark = true)

    private fun reading(dark: Boolean) = withChat(dark) { state, scroll, scope ->
        val transcript = compose.onNodeWithTag("chat-transcript")
        val viewport = transcript.fetchSemanticsNode().boundsInRoot
        val reminder = compose.onNodeWithTag("chat-question-reminder")
        val originalOffset = scroll.firstVisibleItemScrollOffset
        compose.runOnIdle {
            val conversation = state.value.conversations.getValue("r")
            state.value = state.value.copy(conversations = mapOf("r" to conversation.copy(
                messages = conversation.messages + text("tail", "assistant", "追加回复"), revision = conversation.revision + 1)))
        }
        compose.waitForIdle()
        assertEquals(4, scroll.firstVisibleItemIndex)
        assertEquals(originalOffset, scroll.firstVisibleItemScrollOffset)
        assertEquals(viewport, transcript.fetchSemanticsNode().boundsInRoot)
        capture("question-reading-$dark")
        reminder.performTouchInput { click() }
        compose.waitForIdle()
        reminder.assertDoesNotExist()
        assertTrue("Tapping the reminder must bring the original source row into the viewport",
            scroll.layoutInfo.visibleItemsInfo.any { it.key == "question" })
        compose.onNodeWithContentDescription("回到最新消息").assertIsDisplayed()
        capture("question-original-$dark")
        // CHAT-QUESTION-02: an earlier answer points to its own preceding question.
        compose.runOnIdle { scope.launch { scroll.scrollToItem(2, 100) } }
        compose.waitForIdle()
        reminder.assertIsDisplayed()
        val inReminder = hasAnyAncestor(hasTestTag("chat-question-reminder"))
        compose.onNode(hasText("之前的问题") and inReminder, useUnmergedTree = true).assertIsDisplayed()
        compose.onNode(hasText(question) and inReminder, useUnmergedTree = true).assertDoesNotExist()
        compose.onNodeWithText("最近提问").assertIsDisplayed()
        compose.onNodeWithContentDescription("回到最新消息").performClick()
        compose.waitForIdle()
        reminder.assertDoesNotExist()
    }

    @Test fun localOutboxDoesNotReplaceTheQuestionAndConfirmedUpdatesKeepTheAnchor() = withChat { state, scroll, _ ->
        val before = scroll.firstVisibleItemScrollOffset
        val pending = PendingSend("local", "command", "s", "尚未确认的问题", emptyList(), null, 2, "reply", state = PendingSendState.Unconfirmed)
        compose.runOnIdle { state.value = state.value.copy(pendingSends = mapOf(pending.messageId to pending)) }
        compose.waitForIdle()
        compose.onNodeWithText(question).assertIsDisplayed()
        compose.runOnIdle {
            val conversation = state.value.conversations.getValue("r")
            state.value = state.value.copy(pendingSends = emptyMap(), conversations = mapOf("r" to conversation.copy(
                messages = conversation.messages + text("source-new", "user", "已确认的新问题"), revision = conversation.revision + 1)))
        }
        compose.waitForIdle()
        compose.onNodeWithText(question).assertIsDisplayed()
        compose.onNodeWithText("已确认的新问题").assertIsNotDisplayed()
        assertEquals(4, scroll.firstVisibleItemIndex)
        assertEquals(before, scroll.firstVisibleItemScrollOffset)
        capture("question-confirmed-update")
    }

    // CHAT-PAGING-01: replacing the question must remove its semantics and hit target
    // immediately, even with an animation clock that has not advanced.
    @Test fun historyRetryOwnsTheQuestionSlotWithoutMovingTheReader() = withChat { state, scroll, _ ->
        val before = scroll.firstVisibleItemScrollOffset
        val original = state.value
        val failed = SessionReadOperation("failed", "r", original.deviceId, original.hostId, "s", "leaf", "oldest", 0,
            null, phase = SessionReadPhase.FAILED, error = "fixture failure")
        compose.mainClock.autoAdvance = false
        try {
            compose.runOnIdle {
                state.value = original.copy(sessionHistory = mapOf("r" to SessionHistoryState("s", "leaf", "oldest", true)),
                    sessionReads = mapOf("failed" to failed))
            }
            compose.mainClock.advanceTimeByFrame()
            compose.waitForIdle()
            compose.onNodeWithTag("chat-history-retry").assertIsDisplayed().assertHasClickAction()
            compose.onNodeWithTag("chat-question-reminder").assertDoesNotExist()
            assertEquals(before, scroll.firstVisibleItemScrollOffset)
        } finally { compose.mainClock.autoAdvance = true }
        compose.runOnIdle { state.value = original }
        compose.waitForIdle()
        compose.onNodeWithTag("chat-history-retry").assertDoesNotExist()
        compose.onNodeWithText(question).assertIsDisplayed()
        assertEquals(before, scroll.firstVisibleItemScrollOffset)
    }

    // CHAT-PAGING-02: only foreground paging owns the top slot; changing phases never moves the transcript.
    @Test fun foregroundHistoryLoadingShowsOneNonInteractiveStatusWithoutMovingTheReader() = withChat { state, scroll, _ ->
        val transcript = compose.onNodeWithTag("chat-transcript")
        val progress = compose.onNodeWithTag("chat-history-loading")
        val position = scroll.firstVisibleItemIndex to scroll.firstVisibleItemScrollOffset
        val viewport = transcript.fetchSemanticsNode().boundsInRoot
        val original = state.value.copy(sessionHistory = mapOf("r" to SessionHistoryState("s", "leaf", "oldest", true)))
        val pending = SessionReadOperation("paging", "r", original.deviceId, original.hostId, "s", "leaf", "oldest", 0,
            null, phase = SessionReadPhase.WAITING)
        fun show(operation: SessionReadOperation) {
            compose.runOnIdle { state.value = original.copy(sessionReads = mapOf(operation.operationId to operation)) }
            compose.waitForIdle()
        }
        progress.assertDoesNotExist()
        show(pending.copy(kind = SessionReadKind.PREFETCH))
        progress.assertDoesNotExist()
        // CHAT-PAGING-03: the first frame is already visible; only the overlay moves as it settles.
        compose.mainClock.autoAdvance = false
        try {
            compose.runOnIdle { state.value = original.copy(sessionReads = mapOf(pending.operationId to pending)) }
            compose.mainClock.advanceTimeByFrame()
            progress.assertIsDisplayed()
            val entryTop = progress.fetchSemanticsNode().boundsInRoot.top
            assertEquals(viewport, transcript.fetchSemanticsNode().boundsInRoot)
            compose.mainClock.advanceTimeBy(InteractionMotion.State.toLong() + 64)
            val restingTop = progress.fetchSemanticsNode().boundsInRoot.top
            if (InteractionMotion.duration(InteractionMotion.State) > 0) {
                assertTrue("History progress should settle downward from its visible entry frame", restingTop > entryTop)
            } else {
                assertEquals(entryTop, restingTop, 1f)
            }
        } finally { compose.mainClock.autoAdvance = true }
        progress.assertIsDisplayed().assertTextEquals(L10n.tr("正在加载更早的历史…")).assertHasNoClickAction()
        assertEquals(viewport.center.x, progress.fetchSemanticsNode().boundsInRoot.center.x, 1f)
        compose.onNodeWithTag("chat-question-reminder").assertDoesNotExist()
        compose.onNodeWithTag("chat-history-retry").assertDoesNotExist()
        assertEquals(viewport, transcript.fetchSemanticsNode().boundsInRoot)
        assertEquals(position, scroll.firstVisibleItemIndex to scroll.firstVisibleItemScrollOffset)
        show(pending.copy(phase = SessionReadPhase.SUCCEEDED))
        progress.assertDoesNotExist()
        compose.onNodeWithTag("chat-question-reminder").assertIsDisplayed()
        assertEquals(position, scroll.firstVisibleItemIndex to scroll.firstVisibleItemScrollOffset)
    }

    // CHAT-PAGING-04: keep a real pointer down to inspect the two preview states before release.
    @Test fun historyPullShowsProgressBeforeReleaseAndDoesNotLoadOnCancellation() {
        val progress = mutableFloatStateOf(0f)
        var loads = 0
        var threshold = 0f
        compose.setContent {
            threshold = with(LocalDensity.current) { 44.dp.toPx() }
            OrbisTheme(darkTheme = false) {
                Box(Modifier.fillMaxSize().background(rememberNeumorphColors().base)) {
                    Box(Modifier.fillMaxSize().testTag("history-gesture-viewport")
                        .chatHistoryPull(ChatPresentationIdentity("host", "runtime", "session", 0) to "device",
                            nearTop = { true }, canLoad = { true }, onLoad = { loads++ },
                            onProgress = { progress.floatValue = it }))
                    if (progress.floatValue > 0f) {
                        ChatHistoryProgress(
                            Modifier.align(Alignment.TopCenter),
                            loading = false, pullProgress = progress,
                        )
                    }
                }
            }
        }
        val transcript = compose.onNodeWithTag("history-gesture-viewport")
        val pill = compose.onNodeWithTag("chat-history-pull")
        transcript.performTouchInput { down(center); moveBy(Offset(0f, threshold * 0.5f)) }
        pill.assertIsDisplayed().assertTextEquals(L10n.tr("下拉加载历史")).assertHasNoClickAction()
        compose.runOnIdle { assertEquals(0.5f, progress.floatValue, 0.01f); assertEquals(0, loads) }
        // CHAT-PAGING-05: sample outside the layer while it is translucent, not at full opacity.
        val bounds = pill.fetchSemanticsNode().boundsInRoot
        val frame = capture("history-pull-halfway")
        val x = bounds.center.x.toInt()
        val backdrop = android.graphics.Color.red(frame.getPixel(x, frame.height / 2))
        val highlight = android.graphics.Color.red(frame.getPixel(x, floor(bounds.top).toInt() - 1))
        val shadow = android.graphics.Color.red(frame.getPixel(x, ceil(bounds.bottom).toInt() + 1))
        assertTrue("Half-pulled pill must retain light and shadow outside its bounds ($highlight / $backdrop / $shadow)",
            highlight >= backdrop + 3 && shadow <= backdrop - 3)
        transcript.performTouchInput { moveBy(Offset(0f, threshold * 0.7f)) }
        pill.assertTextEquals(L10n.tr("松手加载"))
        compose.runOnIdle { assertEquals(0, loads) }
        transcript.performTouchInput { moveBy(Offset(0f, -threshold * 0.5f)); up() }
        pill.assertDoesNotExist()
        compose.runOnIdle { assertEquals(0, loads) }
        transcript.performTouchInput { down(center); moveBy(Offset(0f, threshold * 1.2f)); cancel() }
        pill.assertDoesNotExist()
        compose.runOnIdle { assertEquals(0, loads) }
        transcript.performTouchInput { down(center); moveBy(Offset(0f, threshold * 1.2f)); up() }
        pill.assertDoesNotExist()
        compose.runOnIdle { assertEquals(1, loads) }
    }

    @Test fun notificationsTakePriorityAndHostChangesClearTheReminder() = withChat { state, scroll, _ ->
        val before = scroll.firstVisibleItemScrollOffset
        compose.runOnIdle {
            state.value = state.value.copy(notificationProjections = mapOf("r" to
                NoticeProjection("epoch", 1, "s", "unknown", emptyList(), complete = false)))
        }
        compose.waitForIdle()
        compose.onNodeWithTag("chat-question-reminder").assertDoesNotExist()
        compose.onNodeWithText("通知状态待核对").assertIsDisplayed()
        assertEquals(before, scroll.firstVisibleItemScrollOffset)
        compose.runOnIdle { state.value = state.value.copy(notificationProjections = emptyMap()) }
        compose.waitForIdle()
        compose.onNodeWithTag("chat-question-reminder").assertIsDisplayed()
        compose.runOnIdle { state.value = state.value.copy(hostId = "other-host") }
        compose.waitForIdle()
        compose.onNodeWithTag("chat-question-reminder").assertDoesNotExist()
        assertEquals(before, scroll.firstVisibleItemScrollOffset)
        capture("question-host-cleared")
    }


    @Test fun lastUserDirectionControlsTheSingleLineReminder() = withChat { _, scroll, scope ->
        val reminder = compose.onNodeWithTag("chat-question-reminder")
        val before = reminder.fetchSemanticsNode().boundsInRoot
        assertTrue(before.height < compose.onNodeWithTag("chat-transcript").fetchSemanticsNode().boundsInRoot.height / 3)
        compose.onNodeWithTag("chat-transcript").performTouchInput { swipeUp() }
        compose.waitForIdle()
        reminder.assertDoesNotExist()
        // Programmatic positioning must not manufacture an earlier-reading intention.
        compose.runOnIdle { scope.launch { scroll.scrollToItem(4, 350) } }
        compose.waitForIdle()
        reminder.assertDoesNotExist()
        // Stay inside the same reply. A large down swipe can bring the source
        // question into the first visible row, where the reminder should hide.
        compose.onNodeWithTag("chat-transcript").performTouchInput {
            swipe(center, center + Offset(0f, 100f), durationMillis = 450)
        }
        compose.waitForIdle()
        reminder.assertIsDisplayed()
    }

    private fun capture(name: String): Bitmap {
        val context = ApplicationProvider.getApplicationContext<android.content.Context>()
        val directory = File(context.getExternalFilesDir(null), "question-reminder").apply { mkdirs() }
        val frame = compose.onRoot().captureToImage().asAndroidBitmap()
        File(directory, "$name.png").outputStream().use {
            assertTrue(frame.compress(Bitmap.CompressFormat.PNG, 100, it))
        }
        return frame
    }
}
