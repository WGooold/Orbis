// Orbis 测试用途（场景与判定见本文件断言）：
// - 复制反馈 / M05（M05、V16、SC23、MOT-08）
package com.orbising.orbis

import android.graphics.Bitmap
import android.os.SystemClock
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.dp
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import java.io.File

class CopyFeedbackInstrumentedTest {
    @get:Rule val compose = createComposeRule()

    @Test fun latestCopyOwnsTheFullDeadlineAndKeepsTheTarget() {
        var text by mutableStateOf("第一段内容")
        var copiedText: (() -> String?)? = null
        compose.setContent { OrbisTheme {
            val clipboard = LocalClipboardManager.current
            SideEffect { copiedText = { clipboard.getText()?.text } }
            CopyIconButton("复制代码") { text }
        } }
        val before = compose.onNodeWithContentDescription("复制代码").fetchSemanticsNode().boundsInRoot
        compose.onNodeWithContentDescription("复制代码").performClick()
        compose.onNodeWithContentDescription("已复制").assertIsDisplayed()
        compose.runOnIdle { assertEquals("第一段内容", copiedText?.invoke()); text = "第二段内容" }
        SystemClock.sleep(1_300)
        compose.onNodeWithContentDescription("已复制").performClick()
        SystemClock.sleep(1_300)
        compose.onNodeWithContentDescription("已复制").assertIsDisplayed()
        compose.runOnIdle { assertEquals("第二段内容", copiedText?.invoke()) }
        waitForReset("复制代码")
        assertEquals(before, compose.onNodeWithContentDescription("复制代码").fetchSemanticsNode().boundsInRoot)
        compose.runOnIdle { assertEquals("第二段内容", copiedText?.invoke()) }
    }

    @Test fun newOwnerDisableAndReentryDoNotReuseTheOldCheck() {
        var identity by mutableStateOf("first")
        var enabled by mutableStateOf(true)
        var shown by mutableStateOf(true)
        compose.setContent { OrbisTheme {
            if (shown) CopyIconButton("复制消息", enabled = enabled, identity = identity) { identity }
        } }
        compose.onNodeWithContentDescription("复制消息").performClick()
        compose.onNodeWithContentDescription("已复制").assertIsDisplayed()
        compose.runOnIdle { identity = "second" }
        compose.onNodeWithContentDescription("复制消息").assertIsDisplayed().performClick()
        compose.onNodeWithContentDescription("已复制").assertIsDisplayed()
        compose.runOnIdle { enabled = false }
        compose.onNodeWithContentDescription("复制消息").assertIsNotEnabled()
        compose.onNodeWithContentDescription("已复制").assertDoesNotExist()
        compose.runOnIdle { enabled = true }
        compose.onNodeWithContentDescription("复制消息").performClick()
        compose.runOnIdle { shown = false }
        compose.onNodeWithContentDescription("已复制").assertDoesNotExist()
        compose.runOnIdle { shown = true }
        compose.onNodeWithContentDescription("复制消息").assertIsDisplayed()
        compose.onNodeWithContentDescription("已复制").assertDoesNotExist()
    }

    @Test fun textCopyKeepsItsLabelAndGeometryInLightDarkAndLargeType() {
        var dark by mutableStateOf(false)
        var large by mutableStateOf(false)
        compose.setContent { OrbisTheme(darkTheme = dark) {
            val density = LocalDensity.current
            CompositionLocalProvider(LocalDensity provides Density(density.density, if (large) 1.5f else 1f)) {
                Column(Modifier.width(320.dp).background(MaterialTheme.colorScheme.background).padding(20.dp)) {
                    CopyTextButton("复制内容", identity = dark to large) { "完整工具参数" }
                }
            }
        } }
        for ((name, useDark, useLarge) in listOf(Triple("light", false, false), Triple("dark", true, false), Triple("large", false, true))) {
            compose.runOnIdle { dark = useDark; large = useLarge }
            val before = compose.onNodeWithContentDescription("复制内容").fetchSemanticsNode().boundsInRoot
            compose.onNodeWithContentDescription("复制内容").performClick()
            compose.onNodeWithContentDescription("已复制").assertIsDisplayed()
            compose.onNodeWithText("复制内容").assertIsDisplayed()
            assertEquals(before, compose.onNodeWithContentDescription("已复制").fetchSemanticsNode().boundsInRoot)
            capture("copy-text-$name-check")
            waitForReset("复制内容")
            assertEquals(before, compose.onNodeWithContentDescription("复制内容").fetchSemanticsNode().boundsInRoot)
            capture("copy-text-$name-restored")
        }
    }

    @Test fun approvalSummaryCopyFitsNarrowLargeTypeAndRestores() {
        val request = PendingInteraction("copy-approval", "codex", "confirm", "批准执行命令", null, emptyList(), null,
            argumentSummary = "这是待执行的完整参数。\n".repeat(18))
        compose.setContent { OrbisTheme {
            val density = LocalDensity.current
            CompositionLocalProvider(LocalDensity provides Density(density.density, 1.5f)) {
                Box(Modifier.width(320.dp).fillMaxHeight()) {
                    InteractionPanel(request, submitting = false, respondConfirm = {}, respondValue = {}, respondValues = {},
                        modifier = Modifier.fillMaxSize())
                }
            }
        } }
        val copy = compose.onNodeWithContentDescription("复制内容")
        copy.performScrollTo().performClick()
        compose.onNodeWithContentDescription("已复制").assertIsDisplayed()
        val bounds = compose.onNodeWithContentDescription("已复制").fetchSemanticsNode().boundsInRoot
        val root = compose.onRoot().fetchSemanticsNode().boundsInRoot
        assertTrue(bounds.left >= root.left && bounds.right <= root.right)
        capture("copy-approval-narrow-large-check")
        waitForReset("复制内容")
        assertEquals(bounds, copy.fetchSemanticsNode().boundsInRoot)
    }

    private fun waitForReset(label: String) {
        compose.waitUntil(4_000) { compose.onAllNodesWithContentDescription("已复制").fetchSemanticsNodes().isEmpty() }
        compose.onNodeWithContentDescription(label).assertIsDisplayed()
    }

    private fun capture(name: String) {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        File(context.getExternalFilesDir(null), "$name.png").outputStream().use {
            compose.onRoot().captureToImage().asAndroidBitmap().compress(Bitmap.CompressFormat.PNG, 100, it)
        }
    }
}
