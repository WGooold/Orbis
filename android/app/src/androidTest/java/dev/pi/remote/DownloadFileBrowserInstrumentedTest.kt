package dev.pi.remote

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
        compose.setContent { PiRemoteTheme { AllDownloadsScreen(
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

    @Test fun sessionBrowserFiltersFilesWhileFilePickerHandlesLoadingOfflineAndRetry() {
        val state = mutableStateOf(RemoteState(
            connection = RelayConnection.ONLINE, e2eReady = true,
            sessionBrowse = SessionBrowseState("list", "D:\\", entries = listOf(
                SessionBrowseEntry("work", true, true), SessionBrowseEntry("file.zip", false, false),
            ), isLoading = false),
        ))
        val files = mutableStateOf(false)
        var retries = 0
        compose.setContent { PiRemoteTheme {
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
        compose.onNodeWithText("未连接到电脑，连接后可继续浏览").assertIsDisplayed()
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
