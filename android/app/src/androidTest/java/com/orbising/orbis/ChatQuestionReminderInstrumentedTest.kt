package com.orbising.orbis

import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.runtime.MutableState
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.lifecycle.ViewModelStore
import androidx.test.core.app.ApplicationProvider
import java.io.File
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
        compose.onNodeWithText(question).assertIsDisplayed()
        compose.onNodeWithContentDescription("回到最新消息").assertIsDisplayed()
        capture("question-original-$dark")
        // The question can be offscreen below an older answer, too. It still names the latest question.
        compose.runOnIdle { scope.launch { scroll.scrollToItem(2, 100) } }
        compose.waitForIdle()
        reminder.assertIsDisplayed()
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
        compose.onNodeWithText("已确认的新问题").assertIsDisplayed()
        assertEquals(4, scroll.firstVisibleItemIndex)
        assertEquals(before, scroll.firstVisibleItemScrollOffset)
        capture("question-confirmed-update")
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

    private fun capture(name: String) {
        val context = ApplicationProvider.getApplicationContext<android.content.Context>()
        val directory = File(context.getExternalFilesDir(null), "question-reminder").apply { mkdirs() }
        File(directory, "$name.png").outputStream().use {
            assertTrue(compose.onRoot().captureToImage().asAndroidBitmap().compress(android.graphics.Bitmap.CompressFormat.PNG, 100, it))
        }
    }
}
