// Orbis 测试用途（场景与判定见本文件断言）：
// - r24 整页导航（M07、M08、M14、V17、V18）
package com.orbising.orbis

import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.lifecycle.ViewModelStore
import androidx.test.core.app.ApplicationProvider
import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test

/** M14: exercise the real history/chat/download hierarchy, including cancellation and source state. */
class HistorySwipeBackInstrumentedTest {
    @get:Rule val compose = createComposeRule()

    private fun capture(name: String) {
        val context = androidx.test.platform.app.InstrumentationRegistry.getInstrumentation().targetContext
        val directory = File(context.getExternalFilesDir(null), "history-swipe").apply { mkdirs() }
        File(directory, "$name.png").outputStream().use {
            compose.onRoot().captureToImage().asAndroidBitmap().compress(android.graphics.Bitmap.CompressFormat.PNG, 100, it)
        }
    }

    @Test fun historyReboundsThenReturnsToTheSameChatAndDownloadsReturnOneLevel() {
        val app = IsolatedTestApplication(ApplicationProvider.getApplicationContext(), prefix = "history-swipe")
        val owner = ViewModelStore()
        val model = RemoteViewModel(app)
        owner.put("history-swipe", model)
        val scroll = LazyListState()
        val state = RemoteState(hostId = "history-swipe-host", selectedRuntimeId = "r", runtimes = mapOf(
            "r" to RuntimeSummary("r", "History swipe fixture", "/", "idle", "s")),
            conversations = mapOf("r" to RuntimeConversation(messages = listOf(
                ChatMessage("reply", "assistant", listOf(RemoteContent("text", "Original chat reply")), 1)))))
        try {
            compose.setContent { OrbisTheme { ChatScreen(state, model, scroll) } }
            compose.onNode(hasSetTextAction()).performTextInput("Draft before history")
            val index = scroll.firstVisibleItemIndex
            val offset = scroll.firstVisibleItemScrollOffset
            compose.onNodeWithContentDescription("历史与分支").performClick()
            compose.onNodeWithTag("history-downloads").performClick()
            compose.onRoot().performTouchInput {
                swipeRight(startX = width * 0.15f, endX = width * 0.9f, durationMillis = 600)
            }
            compose.onNodeWithText("历史与分支").assertIsDisplayed()
            capture("history-after-downloads")
            // A short drag with no release velocity must rebound on history.
            val originalX = compose.onNodeWithText("历史与分支").fetchSemanticsNode().boundsInRoot.left
            compose.onRoot().performTouchInput {
                down(Offset(width * 0.15f, height * 0.6f))
                moveTo(Offset(width * 0.30f, height * 0.6f), 600)
            }
            val shifted = compose.onNodeWithText("历史与分支").fetchSemanticsNode().boundsInRoot.left
            org.junit.Assert.assertTrue("history follows the finger", shifted - originalX > 20f)
            capture("history-drag-preview")
            compose.onRoot().performTouchInput { advanceEventTime(300); up() }
            compose.onNodeWithText("历史与分支").assertIsDisplayed()
            compose.onRoot().performTouchInput {
                swipeRight(startX = width * 0.15f, endX = width * 0.9f, durationMillis = 600)
            }
            compose.onNode(hasSetTextAction()).assertTextContains("Draft before history")
            compose.onNodeWithText("Original chat reply").assertIsDisplayed()
            capture("history-returned-to-chat")
            compose.runOnIdle {
                assertEquals(index, scroll.firstVisibleItemIndex)
                assertEquals(offset, scroll.firstVisibleItemScrollOffset)
            }
            // The retained chat remains interactive and can open history again.
            compose.onNodeWithContentDescription("历史与分支").performClick()
            compose.onNodeWithText("历史与分支").assertIsDisplayed()
        } finally {
            compose.runOnIdle { owner.clear() }
            app.dispose()
        }
    }
}
