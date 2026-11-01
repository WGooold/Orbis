package com.orbising.orbis

import android.graphics.Bitmap
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.width
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.dp
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test

class TurnFileChangesInstrumentedTest {
    @get:Rule val compose = createComposeRule()
    private val files = (1..5).map { index -> FileChangeMetadata("file-$index", "src/VeryLongComponentWithUnicode中文AndEmoji😀.test.tsx",
        changeKind = if (index == 1) "modified" else "added", fileKind = "text", additions = 40, deletions = 3,
        beforeBytes = 12, afterBytes = 400, contentVersion = "content-$index", detail = "available") }
    private val summary get() = TurnChangeSummary(1, ToolAgent("host", "codex", "session"), "turn", "set", listOf("turn"), 1,
        "entry", 1, 2, "ready", "completed", "complete", "workspace-window", emptyList(), 5, 4, 1, 0, 200, 3, files.take(4), scope = "git-visible-files", revision = 1)
    private val diff = "--- a/file\n+++ b/file\n@@ -1,150 +1,150 @@\n" + (1..150).joinToString("\n") { " line $it" } + "\n-old\n+new\n"

    @Test fun nativeSummaryShowsToolScopeWithoutReadingDetail() {
        var details = 0
        val native = summary.copy(attribution = "native-tool", scope = "native-file-tools", coverage = "partial", reasons = listOf("native-file-tools-only"))
        compose.setContent { OrbisTheme { Box(Modifier.width(320.dp)) {
            TurnChangeSummaryView(native, ChangeManifest(native), true, {}, { details++ })
        } } }
        compose.onNodeWithText("仅记录 Codex 文件工具变更").assertIsDisplayed()
        assertEquals("Codex 文件工具", changeScopeLabel(native.scope))
        assertEquals(0, details)
        screenshot("native-summary-tool-scope")
        compose.onNodeWithTag("change-file-file-1").performClick()
        assertEquals(1, details)
    }

    @Test fun openingAndExpandingSummaryReadsOnlyMetadata() {
        var manifests = 0; var details = 0
        compose.setContent { OrbisTheme { Box(Modifier.width(320.dp)) {
            TurnChangeSummaryView(summary, ChangeManifest(summary), true, { manifests++ }, { details++ })
        } } }
        compose.waitForIdle()
        assertEquals(0, manifests); assertEquals(0, details)
        // Compact block: header, then one single-line row per preview file in order.
        val header = compose.onNodeWithTag("turn-changes-open-turn").assertTextContains("5 个文件已更改", substring = true).fetchSemanticsNode().boundsInRoot
        val rows = (1..4).map { compose.onNodeWithTag("change-file-file-$it").fetchSemanticsNode().boundsInRoot }
        val density = InstrumentationRegistry.getInstrumentation().targetContext.resources.displayMetrics.density
        assertTrue(rows.first().top >= header.bottom)
        rows.zipWithNext().forEach { (above, below) -> assertTrue(below.top >= above.bottom) }
        rows.forEach { assertTrue("row ${it.height / density}dp", it.height / density <= 48f) }
        compose.onNodeWithText("还有 1 个文件").performClick()
        compose.waitForIdle()
        assertEquals(1, manifests); assertEquals(0, details)
        compose.onNodeWithTag("change-file-file-1").performClick()
        assertEquals(1, details)
        screenshot("summary-light")
    }

    @Test fun piSummaryClickOpensLoadingFileThenDisplaysItsFirstDiffPage() {
        val piFiles = files.mapIndexed { index, file -> file.copy(path =
            if (index % 2 == 0) "src/File$index.kt" else "docs/file-$index.md") }
        val piSummary = summary.copy(agent = summary.agent.copy(agentKind = "pi"), preview = piFiles.take(4))
        val viewer = mutableStateOf<FileChangeViewer?>(null)
        val manifest = mutableStateOf(ChangeManifest(piSummary).request())
        compose.setContent { OrbisTheme {
            Column {
                TurnChangeSummaryView(piSummary, manifest.value, true, {}, { file ->
                    viewer.value = FileChangeViewer("pi:runtime", piSummary, file.fileId).select(file)
                })
            }
            viewer.value?.let { current ->
                FileChangeViewerSheet(current, manifest.value, onClose = { viewer.value = null },
                    onSelectFile = { id ->
                        if (viewer.value?.selectedFileId != id) {
                            viewer.value = viewer.value?.select(piFiles.first { it.fileId == id })
                        }
                    }, onReadDetail = {}, onReadManifest = {}, onPosition = { _, _, _ -> })
            }
        } }
        compose.mainClock.autoAdvance = false
        compose.onNodeWithTag("change-file-file-3").performClick()
        compose.mainClock.advanceTimeByFrame()
        compose.waitForIdle()
        compose.runOnIdle {
            // The first manifest response replaces the four-file preview while the
            // viewer is already open; expanding the summary before opening hides this path.
            val pending = manifest.value
            manifest.value = pending.page(ChangeManifestPage(pending.requestId!!, "pi:runtime",
                piSummary.agent, piSummary.changeSetId, piSummary.manifestVersion, piFiles, 5, null))
            val current = viewer.value!!
            val file = current.current!!.file
            viewer.value = current.page(FileChangeDetailPage(current.current!!.requestId!!,
                current.runtimeId, piSummary.agent, piSummary.changeSetId, piSummary.manifestVersion,
                file.fileId, file.contentVersion, current.viewerId, "pi-read", diff, null, true))
        }
        compose.mainClock.autoAdvance = true
        compose.onNodeWithTag("file-change-viewer").assertIsDisplayed()
        compose.onNodeWithTag("file-diff-lines-file-3").assertIsDisplayed()
        compose.onNodeWithTag("file-change-page").assertTextEquals("3 / 5")
        compose.onNodeWithTag("file-diff-lines-file-3").performScrollToIndex(60)
        repeat(2) { compose.onNodeWithContentDescription("下一个文件").performClick() }
        compose.onNodeWithTag("file-change-page").assertTextEquals("5 / 5")
        compose.onNodeWithText("正在读取差异…").assertIsDisplayed()
        compose.onNodeWithContentDescription("关闭文件差异").performClick()
        compose.onNodeWithTag("file-change-viewer").assertDoesNotExist()
        compose.onNodeWithTag("change-file-file-2").performClick()
        compose.onNodeWithTag("file-change-page").assertTextEquals("2 / 5")
        compose.onNodeWithText("正在读取差异…").assertIsDisplayed()
        screenshot("pi-viewer-loading-after-reopen")
    }

    @Test fun swipingLoadsOnlySettledFileAndRestoresVisitedPosition() {
        val start = FileChangeViewer("runtime", summary, files[0].fileId,
            cache = mapOf(files[0].fileId to FileDiffCache(files[0], text = diff, loaded = true, eof = true)))
        val viewer = mutableStateOf(start)
        val requested = mutableListOf<String>()
        compose.setContent { OrbisTheme {
            FileChangeViewerSheet(viewer.value, ChangeManifest(summary, files, loaded = true), onClose = {},
                onSelectFile = { id ->
                    if (viewer.value.selectedFileId != id) {
                        requested += id
                        viewer.value = viewer.value.select(files.first { it.fileId == id }).let { changed ->
                            if (changed.current?.loaded == true) changed else changed.copy(cache = changed.cache + (id to
                                FileDiffCache(files.first { it.fileId == id }, text = diff, loaded = true, eof = true)))
                        }
                    }
                }, onReadDetail = { fail("All fixture content is complete; no additional reads are needed") },
                onReadManifest = { fail("Complete metadata must not be read again") }, onPosition = { id, index, offset ->
                    val old = viewer.value; val detail = old.cache[id]
                    if (detail != null && (detail.scrollIndex != index || detail.scrollOffset != offset)) viewer.value =
                        old.copy(cache = old.cache + (id to detail.copy(scrollIndex = index, scrollOffset = offset)))
                })
        } }
        compose.waitForIdle()
        assertTrue("Neighbor composition must not select or read it", requested.isEmpty())
        compose.onNodeWithTag("file-diff-lines-file-1").performScrollToIndex(60)
        compose.waitForIdle()
        val position = viewer.value.current!!.scrollIndex
        assertTrue(position >= 55)
        // An incomplete gesture must not select another file; the page springs back.
        compose.onNodeWithTag("file-change-pager").performTouchInput {
            down(center); moveBy(Offset(-width * 0.05f, 0f), 200); advanceEventTime(200); up()
        }
        compose.waitForIdle()
        assertTrue(requested.isEmpty())
        compose.onNodeWithTag("file-change-pager").performTouchInput { swipeLeft() }
        compose.waitForIdle()
        assertEquals(listOf("file-2"), requested)
        compose.onNodeWithTag("file-change-pager").performTouchInput { swipeRight() }
        compose.waitForIdle()
        assertEquals(listOf("file-2", "file-1"), requested)
        assertEquals(position, viewer.value.current!!.scrollIndex)
        screenshot("viewer-light")
    }

    @Test fun diffScrollNeverClosesViewerButHeaderPullDoes() {
        val viewer = FileChangeViewer("runtime", summary, files[0].fileId,
            cache = mapOf(files[0].fileId to FileDiffCache(files[0], text = diff, loaded = true, eof = true)))
        var closes = 0
        compose.setContent { OrbisTheme {
            FileChangeViewerSheet(viewer, ChangeManifest(summary, files, loaded = true), onClose = { closes++ }, {}, {}, {}, { _, _, _ -> })
        } }
        compose.waitForIdle()
        val lines = compose.onNodeWithTag("file-diff-lines-file-1")
        lines.performScrollToIndex(40)
        // Fast pulls back past the diff's top, and a pull on the page's non-scrolling footer.
        repeat(3) { lines.performTouchInput { swipeDown(startY = top + 10f, endY = bottom - 10f, durationMillis = 120) } }
        compose.onNodeWithText("已读取全部差异").performTouchInput { swipeDown(startY = centerY, endY = centerY + 600f, durationMillis = 150) }
        compose.waitForIdle()
        assertEquals(0, closes)
        lines.assertIsDisplayed()
        screenshot("viewer-body-pull-stays-open")
        // The header still owns the sheet's own drag-to-close.
        compose.onNodeWithTag("file-change-header").performTouchInput { swipeDown(startY = centerY, endY = centerY + 900f, durationMillis = 200) }
        compose.waitForIdle()
        assertEquals(1, closes)
    }

    @Test fun darkViewerLargeTextKeepsFullFilenameAccessibility() {
        val viewer = FileChangeViewer("runtime", summary, files[0].fileId,
            cache = mapOf(files[0].fileId to FileDiffCache(files[0], text = "--- a/file\n+++ b/file\n@@ -1,2 +1,2 @@\n context\n-old 中文😀\n+new 中文😀\n", loaded = true, eof = true)))
        compose.setContent { OrbisTheme(darkTheme = true) {
            val density = LocalDensity.current
            CompositionLocalProvider(LocalDensity provides Density(density.density, 1.6f)) {
                FileChangeViewerSheet(viewer, ChangeManifest(summary, files, loaded = true), {}, {}, {}, {}, { _, _, _ -> })
            }
        } }
        compose.waitForIdle()
        compose.onNodeWithContentDescription(files[0].path).assertExists()
        compose.onNodeWithContentDescription("关闭文件差异").assertIsDisplayed()
        compose.onNodeWithTag("file-change-pager").assertIsDisplayed()
        screenshot("viewer-dark-large-text")
    }

    private fun screenshot(name: String) {
        compose.mainClock.advanceTimeBy(500)
        compose.waitForIdle()
        InstrumentationRegistry.getInstrumentation().waitForIdleSync()
        Thread.sleep(300)
        val target = InstrumentationRegistry.getInstrumentation().targetContext
        val directory = File(target.getExternalFilesDir(null), "turn-file-changes").apply { mkdirs() }
        File(directory, "$name.png").outputStream().use {
            InstrumentationRegistry.getInstrumentation().uiAutomation.takeScreenshot().compress(Bitmap.CompressFormat.PNG, 100, it)
        }
    }
}
