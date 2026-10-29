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
        val clock = GlyphRevealClock()
        clock.observe(text, 1_000)
        assertEquals(3, clock.active(1_000).size)
        assertEquals(listOf("A", "👨‍👩‍👧‍👦", "e\u0301"), clock.active(1_000).map { text.substring(it.first, it.second) })
        clock.observe(text + "Z", 1_030)
        assertEquals(4, clock.active(1_030).size)
        assertTrue(clock.active(1_600).isEmpty())
        clock.observe("replacement", 1_700)
        assertTrue(clock.active(1_700).isEmpty())
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
        compose.waitUntil(4_000) {
            compose.onAllNodesWithContentDescription("已复制").fetchSemanticsNodes().isEmpty()
        }
        compose.onNodeWithContentDescription("复制代码").assertIsDisplayed()
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val out = File(context.getExternalFilesDir(null), "ui-polish-${if (dark) "dark" else "light"}.png")
        out.outputStream().use { compose.onRoot().captureToImage().asAndroidBitmap().compress(Bitmap.CompressFormat.PNG, 100, it) }
        assertTrue(out.length() > 0)
    }
}
