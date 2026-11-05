// Orbis 测试用途（场景与判定见本文件断言）：
// - r15 流式顺序（M04）
// - 材质 / 字形 / 控件（S01、S09、S12、M04、V15）
package com.orbising.orbis

import android.graphics.Bitmap
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.unit.dp
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import java.io.File

class UiPolishInstrumentedTest {
    @get:Rule val compose = createComposeRule()

    @Test fun lightAppearanceKeepsFieldAndFileGeometryStable() = exercise(false)
    @Test fun darkAppearanceKeepsFieldAndFileGeometryStable() = exercise(true)

    @Test fun revealKeepsEmojiAndCombiningCharactersTogether() {
        val text = "A👨‍👩‍👧‍👦e\u0301"
        assertEquals(listOf("A", "👨‍👩‍👧‍👦", "e\u0301"), graphemeRanges(text, 0).map { text.substring(it.first, it.second) }.toList())
        // Starting inside a grapheme never splits it.
        assertEquals(listOf("e\u0301"), graphemeRanges(text, 2).map { text.substring(it.first, it.second) }.toList())
        val schedule = RevealSchedule()
        schedule.observe(0, 1_000)
        schedule.observe(text.length, 1_000)
        val starts = graphemeRanges(text, 0).map { schedule.startTime(it.first)!! }.toList()
        assertEquals(starts.sorted(), starts)
        schedule.observe(text.length + 1, 1_030)
        assertTrue(schedule.startTime(text.length)!! >= starts.last())
        assertTrue(schedule.isAnimating(1_030))
        assertTrue(!schedule.isAnimating(1_600))
        schedule.observe("replacement".length, 1_700)
        assertTrue(!schedule.isAnimating(1_700))
    }

    private fun exercise(dark: Boolean) {
        var value by mutableStateOf("")
        var stream by mutableStateOf("正在检查界面")
        compose.setContent {
            OrbisTheme(darkTheme = dark) {
                Column(Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background).padding(20.dp),
                    verticalArrangement = Arrangement.spacedBy(16.dp)) {
                    Text("会话", style = MaterialTheme.typography.titleLarge)
                    NeumorphSurface(contentPadding = 12.dp) {
                        Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                            AgentLabel(AgentBrand.Codex)
                            CompositionLocalProvider(LocalStreamingText provides true) {
                                MarkdownText(stream) {}
                            }
                            MarkdownText("```swift\nlet count = 12345\n```\n\n| 文件 | 状态 |\n| --- | --- |\n| 报告 | 完成 |") {}
                            FileNameText("这是一份很长很长很长的报告文件名称.finalextension", Modifier.width(180.dp))
                        }
                    }
                    NeumorphTextField(value, { value = it }, Modifier.testTag("field"), placeholder = { Text("发送消息") }, singleLine = true)
                    Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                        NeumorphTextButton("取消", {})
                        NeumorphTextButton("发送", {})
                    }
                }
            }
        }
        compose.waitForIdle()
        compose.onNodeWithText("这是一份很长很长很长的报告文件名称.finalextension").assertIsDisplayed()
        val before = compose.onNodeWithTag("field").fetchSemanticsNode().boundsInRoot
        compose.onNode(hasSetTextAction()).performClick().performTextInput("1234567890")
        compose.waitForIdle()
        val after = compose.onNodeWithTag("field").fetchSemanticsNode().boundsInRoot
        assertEquals(before.width, after.width, 0.5f)
        assertEquals(before.height, after.height, 0.5f)
        compose.runOnIdle { stream += "，新增文字与数字 67890" }
        compose.waitForIdle()
        compose.onNodeWithText("正在检查界面，新增文字与数字 67890").assertIsDisplayed()
        compose.onNodeWithContentDescription("复制代码").performClick()
        compose.onNodeWithContentDescription("已复制").assertIsDisplayed()
        // Markdown copy wiring only; deadlines and reset are covered by CopyFeedbackInstrumentedTest.
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val out = File(context.getExternalFilesDir(null), "ui-polish-${if (dark) "dark" else "light"}.png")
        out.outputStream().use { compose.onRoot().captureToImage().asAndroidBitmap().compress(Bitmap.CompressFormat.PNG, 100, it) }
        assertTrue(out.length() > 0)
    }
}
