package com.orbising.orbis

import android.graphics.Bitmap
import androidx.compose.foundation.layout.Box
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

    @Test fun openingAndExpandingSummaryReadsOnlyMetadata() {
        var manifests = 0; var details = 0
        compose.setContent { OrbisTheme { Box(Modifier.width(320.dp)) {
            TurnChangeSummaryView(summary, ChangeManifest(summary), true, { manifests++ }, { details++ })
        } } }
        compose.waitForIdle()
        assertEquals(0, manifests); assertEquals(0, details)
        compose.onNodeWithText("查看全部文件").performClick()
        compose.waitForIdle()
        assertEquals(1, manifests); assertEquals(0, details)
        compose.onNodeWithTag("change-file-file-1").performClick()
        assertEquals(1, details)
        screenshot("summary-light")
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
