package dev.pi.remote

import android.graphics.Bitmap
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test

class SessionHostOwnershipInstrumentedTest {
    @get:Rule val compose = createComposeRule()

    @Test fun missingAndStaleHostnamesStayTogetherAndCreationRequiresPairedConnection() {
        val state = mutableStateOf(RemoteState(
            hostId = "host-1", hostName = "Paired Desktop", connection = RelayConnection.ONLINE,
            sessions = listOf(
                SessionCatalogEntry("empty", name = "Empty Codex", cwd = "D:/repo", agentKind = "codex"),
                SessionCatalogEntry("cached", name = "Cached Pi", cwd = "D:/repo", hostname = "Old Desktop", hasHistoryCache = true),
            ).associateBy { it.sessionId },
            runtimes = mapOf("codex:empty" to RuntimeSummary("codex:empty", "Codex", "D:/repo", "idle", sessionId = "empty", sessionName = "Empty Codex")),
        ))
        val created = mutableListOf<String?>()
        compose.setContent { PiRemoteTheme { SessionDrawer(state.value, {}, {}, created::add, { _, _ -> }) } }
        compose.onNodeWithText("Paired Desktop").assertIsDisplayed()
        compose.onNodeWithText("Empty Codex").assertIsDisplayed()
        compose.onNodeWithText("Cached Pi").assertIsDisplayed()
        compose.onNodeWithText("未知主机").assertDoesNotExist()
        compose.onNodeWithText("Old Desktop").assertDoesNotExist()
        compose.onNodeWithContentDescription("切换电脑").assertDoesNotExist()
        compose.onNodeWithContentDescription("新建会话").assertIsNotEnabled()
        compose.onNodeWithContentDescription("在此目录新建会话").assertIsNotEnabled()
        compose.runOnIdle { state.value = state.value.copy(e2eReady = true) }
        capture("paired-sessions")
        compose.onNodeWithContentDescription("在此目录新建会话").assertIsEnabled().performClick()
        compose.runOnIdle { assertEquals(listOf("D:/repo"), created) }
        compose.runOnIdle { state.value = state.value.copy(runtimes = emptyMap(), connection = RelayConnection.OFFLINE, e2eReady = false) }
        compose.onNodeWithText("Empty Codex").assertIsDisplayed()
        compose.onNodeWithText("Cached Pi").assertIsDisplayed()
        compose.onNodeWithText("Paired Desktop").assertIsDisplayed()
        compose.onNodeWithContentDescription("在此目录新建会话").assertIsNotEnabled()
        compose.runOnIdle { state.value = RemoteState() }
        compose.onNodeWithText("Paired Desktop").assertDoesNotExist()
        compose.onNodeWithContentDescription("新建会话").assertIsNotEnabled()
    }

    @Test fun emptyAndFilteredCatalogKeepThePairedComputerVisible() {
        val state = mutableStateOf(RemoteState(hostId = "host-1", hostName = "Paired Desktop",
            connection = RelayConnection.ONLINE, e2eReady = true))
        compose.setContent { PiRemoteTheme { SessionDrawer(state.value, {}, {}, {}, { _, _ -> }) } }
        compose.onNodeWithText("Paired Desktop").assertIsDisplayed()
        compose.onNodeWithContentDescription("新建会话").assertIsEnabled()
        capture("paired-empty")
        compose.onNode(hasContentDescription("筛选会话：", substring = true)).performClick()
        compose.onNodeWithText("查看已归档会话").performClick()
        compose.onNodeWithText("Paired Desktop").assertIsDisplayed()
        compose.onNodeWithContentDescription("新建会话").assertIsEnabled()
    }

    @Test fun directoryShortcutRequiresBothPairingAndEncryption() {
        val state = mutableStateOf(RemoteState(connection = RelayConnection.ONLINE, e2eReady = true))
        var created: Pair<String, String>? = null
        compose.setContent { PiRemoteTheme { NewSessionSheet(
            state = state.value, presetCwd = "D:/repo", onDismiss = {}, onBrowse = {}, onBrowseInto = {}, onBrowseUp = {},
            onCreate = { kind, cwd -> created = kind to cwd },
        ) } }
        compose.onNodeWithText("在此目录新建 Pi 会话").assertIsNotEnabled()
        compose.runOnIdle { state.value = state.value.copy(hostId = "host-1", hostName = "Desktop", e2eReady = false) }
        compose.onNodeWithText("在此目录新建 Pi 会话").assertIsNotEnabled()
        compose.runOnIdle { state.value = state.value.copy(e2eReady = true) }
        compose.onNodeWithText("在此目录新建 Pi 会话").assertIsEnabled().performClick()
        compose.runOnIdle { assertEquals("pi" to "D:/repo", created) }
    }

    private fun capture(name: String) {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val directory = InstrumentationRegistry.getArguments().getString("evidenceDirectory") ?: "session-host-ownership"
        val folder = File(context.getExternalFilesDir(null), directory).apply { mkdirs() }
        val bitmap = compose.onAllNodes(isRoot()).onLast().captureToImage().asAndroidBitmap()
        File(folder, "$name.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
    }
}
