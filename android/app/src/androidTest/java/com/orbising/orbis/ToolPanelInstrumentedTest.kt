package com.orbising.orbis

import android.graphics.Bitmap
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.unit.dp
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import java.io.File

class ToolPanelInstrumentedTest {
    @get:Rule val compose = createComposeRule()

    private val summary = ToolSummary(
        tool = ToolIdentity(ToolAgent("host", "codex", "session"), "call"),
        toolName = "read", phase = "finished", order = 0, durationMs = 1200, exitCode = 0,
        inputSummary = ToolSummaryText("Sources/ToolViews.kt", false, 20),
        resultSummary = ToolSummaryText("已检查 18 个文件", true, 4096),
        contents = listOf(
            ToolPart("arguments", "json", "readable", "whole-source"),
            ToolPart("output", "text", "pending", "range"),
            ToolPart("result", "json", "unrecoverable", "none"),
        ),
    )

    @Test fun expandingOnlyShowsSummariesAndReadsTheChosenPartOnDemand() {
        val reads = mutableListOf<String>()
        var connected by mutableStateOf(true)
        compose.setContent {
            OrbisTheme {
                Column(Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background).padding(20.dp)) {
                    ToolSummaryDisclosure(summary, connected) { reads += it }
                }
            }
        }
        compose.onNodeWithText("Sources/ToolViews.kt").assertDoesNotExist()
        compose.onNodeWithText("查看输出").assertDoesNotExist()
        compose.onNodeWithContentDescription("展开read，已完成").performClick()
        compose.onNodeWithText("Sources/ToolViews.kt").assertIsDisplayed()
        compose.onNodeWithText("已检查 18 个文件").assertIsDisplayed()
        compose.onNodeWithText("已省略部分内容").assertIsDisplayed()
        compose.onNodeWithText("退出码 0").assertIsDisplayed()
        compose.onNodeWithText("查看结果").assertIsNotEnabled()
        compose.onNodeWithText("此部分内容已无法恢复").assertIsDisplayed()
        compose.runOnIdle { assertTrue(reads.isEmpty()) }
        capture("tool-expanded-light")
        compose.onNodeWithText("查看输出").performClick()
        compose.onNodeWithText("查看参数").performClick()
        compose.runOnIdle { assertEquals(listOf("output", "arguments"), reads); connected = false }
        compose.onNodeWithText("查看参数").assertIsNotEnabled()
        compose.onNodeWithText("查看输出").assertIsNotEnabled()
        compose.onNodeWithContentDescription("收起read，已完成").performClick()
        compose.onNodeWithText("查看输出").assertDoesNotExist()
    }

    @Test fun absentPartsStayHiddenAndTemporaryFailuresExplainDisabledActions() {
        compose.setContent {
            OrbisTheme(darkTheme = true) {
                Column(Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background).padding(20.dp)) {
                    ToolSummaryDisclosure(summary.copy(contents = listOf(
                        ToolPart("arguments", "json", "absent", "none"),
                        ToolPart("output", "text", "temporarily-unavailable", "range"),
                    )), true) { error("Unavailable parts must not request content") }
                }
            }
        }
        compose.onNodeWithContentDescription("展开read，已完成").performClick()
        compose.onNodeWithText("查看参数").assertDoesNotExist()
        compose.onNodeWithText("查看输出").assertIsNotEnabled()
        compose.onNodeWithText("来源暂时无法提供此部分内容").assertIsDisplayed()
        capture("tool-expanded-dark")
    }

    @Test fun detailKeepsPagingStableAndSupportsCopyFollowRetryAndCompletion() {
        var detail by mutableStateOf(ToolDetailView("runtime", summary, "output", text = "Sources checked: 18\n" + "file ".repeat(80),
            offset = 32768, nextCursor = 32768))
        var reads = 0
        var retries = 0
        var exports = 0
        var closes = 0
        compose.setContent {
            OrbisTheme(darkTheme = true) {
                ToolDetailSheet(detail, onClose = { closes++ }, onReadNext = { reads++; detail = detail.copy(requestId = "next") },
                    onRetry = { retries++ }, onClear = {}, onFollow = { detail = detail.copy(follow = it) }, onExport = { exports++ })
            }
        }
        compose.onNodeWithText("输出").assertIsDisplayed()
        compose.onNodeWithContentDescription("复制已读取内容").performClick()
        compose.onNodeWithContentDescription("已复制").assertIsDisplayed()
        compose.onNodeWithText("跟随输出").performClick()
        compose.onNode(isToggleable()).assertIsOn()
        val footer = compose.onNodeWithTag("tool-read-footer").fetchSemanticsNode().boundsInRoot
        capture("tool-detail-dark")
        compose.onNodeWithText("导出当前部分").performClick()
        compose.onNodeWithText("读取下一页").performClick()
        compose.onNodeWithText("正在读取…").assertIsNotEnabled()
        compose.onNodeWithText("导出当前部分").assertIsNotEnabled()
        compose.runOnIdle { assertEquals(1, reads); assertEquals(1, exports) }
        compose.runOnIdle { detail = detail.copy(requestId = null, nextCursor = null, contentFinal = true, follow = false) }
        compose.onNodeWithText("已到当前读取范围末尾").assertIsDisplayed()
        compose.onNodeWithText("读取下一页").assertDoesNotExist()
        compose.onNode(isToggleable()).assertIsNotEnabled()
        val completedFooter = compose.onNodeWithTag("tool-read-footer").fetchSemanticsNode().boundsInRoot
        assertEquals(footer.top, completedFooter.top, 1f)
        assertEquals(footer.height, completedFooter.height, 1f)
        compose.runOnIdle { detail = detail.copy(error = "详情读取超时，可重试") }
        compose.onNodeWithText("重新读取").performClick()
        compose.runOnIdle { assertEquals(1, retries) }
        compose.onNodeWithContentDescription("关闭").performClick()
        compose.runOnIdle { assertEquals(1, closes) }
    }

    private fun capture(name: String) {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val root = if (compose.onAllNodesWithTag("tool-detail-sheet").fetchSemanticsNodes().isEmpty()) compose.onRoot()
            else compose.onNodeWithTag("tool-detail-sheet")
        File(context.getExternalFilesDir(null), "$name.png").outputStream().use {
            root.captureToImage().asAndroidBitmap().compress(Bitmap.CompressFormat.PNG, 100, it)
        }
    }
}
