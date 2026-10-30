package com.orbising.orbis

import android.graphics.Bitmap
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test

class DownloadFileBrowserInstrumentedTest {
    @get:Rule val compose = createComposeRule()

    @Test fun downloadPageBrowsesDrivesFoldersAndDownloadsSelectedFileWithoutTyping() {
        val state = mutableStateOf(RemoteState(connection = RelayConnection.ONLINE, e2eReady = true))
        val downloads = mutableListOf<String>()
        val visited = mutableListOf<String?>()
        fun browse(path: String?) {
            visited += path
            val entries = when (path) {
                null, "" -> listOf(SessionBrowseEntry("D:\\", true, false))
                "D:\\" -> listOf(SessionBrowseEntry("build output", true, false))
                else -> listOf(SessionBrowseEntry("应用 v1.apk", false, false), SessionBrowseEntry("notes.txt", false, false))
            }
            state.value = state.value.copy(sessionBrowse = SessionBrowseState(
                requestId = "request-${visited.size}", path = path,
                parent = if (path == "D:\\build output") "D:\\" else null,
                entries = entries, isLoading = false,
            ))
        }
        compose.setContent { OrbisTheme { AllDownloadsScreen(
            state = state.value, onBack = {}, onBrowse = ::browse,
            onBrowseInto = { name -> browse(remoteBrowsePath(state.value.sessionBrowse?.path, name)) },
            onBrowseUp = { browse(state.value.sessionBrowse?.parent) },
            onDismissBrowse = { state.value = state.value.copy(sessionBrowse = null) },
            onDownload = downloads::add, onRetry = {}, onCancel = {}, onDelete = {},
        ) } }
        compose.onAllNodes(hasSetTextAction()).assertCountEquals(0)
        compose.onNodeWithText("浏览电脑文件").performClick()
        compose.onNodeWithText("D:\\").performClick()
        compose.onNodeWithText("build output").performClick()
        compose.onNodeWithText("下载到手机").assertIsNotEnabled()
        compose.onNodeWithText("应用 v1.apk").performClick()
        compose.onNodeWithText("下载到手机").assertIsEnabled()
        capture("download-file-picker.png")
        compose.onNodeWithText("上一级").performClick()
        compose.onNodeWithText("build output").performClick()
        compose.onNodeWithText("下载到手机").assertIsNotEnabled()
        compose.onNodeWithText("应用 v1.apk").performClick()
        compose.onNodeWithText("下载到手机").performClick()
        compose.onNodeWithText("选择电脑上的文件").assertDoesNotExist()
        compose.runOnIdle {
            assertEquals(listOf("D:\\build output\\应用 v1.apk"), downloads)
            assertTrue(visited.contains("D:\\build output"))
        }
    }

    @Test fun longPressKeepsDownloadGeometryAndDeletionRequiresConfirmation() {
        val task = ArtifactDownload("one", "host", displayName = "应用安装包与说明文件.zip",
            sourcePath = "/repo/releases/应用安装包与说明文件.zip", status = "downloading")
        val state = RemoteState(hostId = "host", e2eReady = true, downloads = mapOf(task.taskId to task))
        val deleted = mutableListOf<Set<String>>()
        var paused = 0
        compose.setContent { OrbisTheme { AllDownloadsScreen(
            state = state, onBack = {}, onBrowse = {}, onBrowseInto = {}, onBrowseUp = {},
            onDismissBrowse = {}, onDownload = {}, onRetry = {}, onCancel = { paused++ }, onDelete = deleted::add,
        ) } }
        val card = compose.onNodeWithTag("download-card-one")
        val originalBounds = card.fetchSemanticsNode().boundsInRoot
        val originalTitle = compose.onNodeWithText(task.displayName, useUnmergedTree = true).fetchSemanticsNode().boundsInRoot
        card.performTouchInput { longClick() }
        compose.onNodeWithText("已选择 1 项").assertIsDisplayed()
        assertEquals(originalBounds, card.fetchSemanticsNode().boundsInRoot)
        assertEquals(originalTitle, compose.onNodeWithText(task.displayName, useUnmergedTree = true).fetchSemanticsNode().boundsInRoot)
        card.assertIsSelected()
        capture("download-selection-stable.png")
        compose.onNodeWithContentDescription("删除所选下载").performClick()
        compose.onNodeWithText("删除下载记录与本机文件？").assertIsDisplayed()
        compose.onNodeWithText("取消").performClick()
        card.assertIsSelected()
        compose.runOnIdle { assertTrue(deleted.isEmpty()); assertEquals(0, paused) }
        compose.onNodeWithContentDescription("退出多选").performClick()
        assertEquals(originalBounds, card.fetchSemanticsNode().boundsInRoot)
        card.performClick()
        compose.runOnIdle { assertEquals(1, paused) }
        card.performTouchInput { longClick() }
        compose.onNodeWithContentDescription("删除所选下载").performClick()
        compose.onNodeWithText("删除 1 项").performClick()
        compose.runOnIdle { assertEquals(listOf(setOf("one")), deleted) }
    }

    @Test fun sessionBrowserFiltersFilesWhileFilePickerHandlesLoadingOfflineAndRetry() {
        val state = mutableStateOf(RemoteState(
            connection = RelayConnection.ONLINE, e2eReady = true,
            sessionBrowse = SessionBrowseState("list", "D:\\", entries = listOf(
                SessionBrowseEntry("work", true, true), SessionBrowseEntry("file.zip", false, false),
            ), isLoading = false),
        ))
        val files = mutableStateOf(false)
        var retries = 0
        compose.setContent { OrbisTheme {
            if (!files.value) {
                RemoteDirectoryBrowser(state.value.sessionBrowse, true, {}, {}, {})
            } else {
                DownloadFileSheet(state.value, {}, { retries++ }, {}, {}, {})
            }
        } }
        compose.onNodeWithText("work").assertIsDisplayed()
        compose.onNodeWithText("file.zip").assertDoesNotExist()
        compose.runOnIdle { files.value = true }
        compose.onNodeWithText("file.zip").performClick()
        compose.onNodeWithText("下载到手机").assertIsEnabled()
        compose.runOnIdle { state.value = state.value.copy(connection = RelayConnection.RECONNECTING, e2eReady = false) }
        compose.onNodeWithText("下载到手机").assertIsNotEnabled()
        compose.onNodeWithText("D:\\").assertIsDisplayed()
        compose.runOnIdle { state.value = state.value.copy(connection = RelayConnection.ONLINE, e2eReady = true,
            sessionBrowse = state.value.sessionBrowse!!.copy(isLoading = true)) }
        compose.onNodeWithText("下载到手机").assertIsNotEnabled()
        compose.runOnIdle { state.value = state.value.copy(sessionBrowse = state.value.sessionBrowse!!.copy(
            isLoading = false, error = "没有权限读取目录")) }
        compose.onNodeWithText("没有权限读取目录").assertIsDisplayed()
        compose.onNodeWithText("下载到手机").assertIsNotEnabled()
        val beforeRetry = retries
        compose.onNodeWithText("重新读取").performClick()
        compose.runOnIdle { assertEquals(beforeRetry + 1, retries) }
    }

    private fun capture(name: String) {
        compose.waitForIdle()
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        instrumentation.uiAutomation.takeScreenshot()?.let { bitmap ->
            File(instrumentation.targetContext.getExternalFilesDir(null), name).outputStream().use {
                bitmap.compress(Bitmap.CompressFormat.PNG, 100, it)
            }
            bitmap.recycle()
        }
    }
}
