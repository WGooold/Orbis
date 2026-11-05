// Orbis 测试用途（场景与判定见本文件断言）：
// - Pi 连续工具交接（V20、V09、V01、V04、V18）
package com.orbising.orbis

import android.content.Context
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.lifecycle.ViewModelStore
import androidx.test.core.app.ApplicationProvider
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test

class ToolContinuityInstrumentedTest {
    @get:Rule val compose = createComposeRule()

    @Test fun repeatedToolUpdatesKeepTheFollowingTranscriptAndPagingBoundary() = verify(reading = false)
    @Test fun repeatedToolUpdatesKeepTheReadingAnchorUntilTheParentArrives() = verify(reading = true)

    private fun verify(reading: Boolean) {
        val base = ApplicationProvider.getApplicationContext<Context>()
        val app = IsolatedTestApplication(base, prefix = "tool-continuity")
        val owner = ViewModelStore()
        val model = RemoteViewModel(app)
        owner.put("continuity", model)
        val fixture = ToolContinuityFixture()
        val state = mutableStateOf(fixture.initial)
        val list = LazyListState()
        val frames = mutableListOf<String>()
        val name = if (reading) "reading" else "following"
        val directory = File(base.getExternalFilesDir(null), "tool-continuity").apply { mkdirs() }
        fun screenshot(stage: String) {
            InstrumentationRegistry.getInstrumentation().uiAutomation.takeScreenshot()?.let { bitmap ->
                File(directory, "$name-$stage.png").outputStream().use {
                    bitmap.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, it)
                }
            }
        }
        fun position() = list.layoutInfo.visibleItemsInfo.map { Triple(it.key, it.offset, it.size) }
        try {
            compose.setContent { OrbisTheme { AgentTheme(agentBrand("pi")) { ChatScreen(state.value, model, list) } } }
            compose.waitForIdle()
            if (reading) {
                // A real drag disables following; programmatic positioning alone does not.
                repeat(3) { compose.onNodeWithTag("chat-transcript").performTouchInput { swipeDown() } }
                compose.waitForIdle()
            }
            val before = compose.runOnIdle { position() }
            val count = compose.runOnIdle { list.layoutInfo.totalItemsCount }
            screenshot("before")
            for (seq in 2L..5L) {
                compose.runOnIdle {
                    state.value = fixture.advance(state.value, seq)
                    if (seq == 3L) state.value = fixture.catchupWhileWaiting(state.value)
                    if (seq == 5L) state.value = fixture.catchupWhileWaiting(state.value, fillParent = true)
                }
                compose.waitForIdle()
                repeat(3) {
                    compose.mainClock.advanceTimeByFrame()
                    compose.runOnIdle {
                        frames += "seq=$seq count=${state.value.conversations.getValue("runtime").messages.size} rows=${position()}"
                        assertEquals("Existing rows disappeared at sequence $seq", count, list.layoutInfo.totalItemsCount)
                        assertEquals("Visible geometry moved at sequence $seq", before, position())
                        assertEquals("user-0", state.value.sessionHistory.getValue("runtime").oldestEntryId)
                    }
                }
                screenshot("pending-$seq")
            }
            compose.runOnIdle { state.value = fixture.advance(state.value, 6, fillParent = true) }
            compose.waitForIdle()
            compose.runOnIdle {
                assertTrue(state.value.conversations.getValue("runtime").messages.any { it.messageId == "second-call" })
                assertTrue(state.value.conversations.getValue("runtime").messages.any { it.messageId == "user-0" })
                if (reading) assertEquals(before, position())
            }
            screenshot("resolved")
        } finally {
            File(directory, "$name-frames.txt").writeText(frames.joinToString("\n"))
            compose.runOnIdle { owner.clear() }
            app.dispose()
        }
    }
}
