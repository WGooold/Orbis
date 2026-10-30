package com.orbising.orbis

import android.app.Application
import android.content.Context
import android.content.SharedPreferences
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.lifecycle.ViewModelStore
import androidx.test.core.app.ApplicationProvider
import java.io.File
import java.util.UUID
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

/** ADR-0053 §4 / S22: download and settings are the only header entries; the capsule only reports. */
class SettingsEntryInstrumentedTest {
    @get:Rule val compose = createComposeRule()

    private class IsolatedApplication(base: Context) : Application() {
        private val prefix = "settings-${UUID.randomUUID()}"
        private val root = File(base.filesDir, prefix).apply { mkdirs() }
        private val preferences = mutableSetOf<String>()
        init { attachBaseContext(base) }
        override fun getApplicationContext(): Context = this
        override fun getFilesDir(): File = root
        override fun getCacheDir(): File = File(root, "cache").apply { mkdirs() }
        override fun getNoBackupFilesDir(): File = File(root, "no-backup").apply { mkdirs() }
        override fun getSharedPreferences(name: String, mode: Int): SharedPreferences {
            val isolated = "$prefix-$name"
            preferences += isolated
            return baseContext.getSharedPreferences(isolated, mode)
        }
        fun dispose() {
            preferences.forEach { baseContext.deleteSharedPreferences(it) }
            root.deleteRecursively()
        }
    }

    private fun pairing(id: String, name: String) = HostPairing(id, name, "test-public", "test-root",
        relayUrl = "wss://relay.example", deviceId = "test-device", credential = "test-only")

    @Test fun headerKeepsDownloadAndSettingsAndTheCapsuleIsNotAnEntry() {
        val state = RemoteState(hostId = "host", e2eReady = true, connection = RelayConnection.ONLINE,
            runtimes = mapOf("one" to RuntimeSummary("one", "one", "/repo", "idle", sessionId = "one", agentKind = "pi",
                domainAvailability = mapOf("identity" to "ready", "execution" to "ready", "interactions" to "ready"))))
            .withReadyHomeFixture()
        var settings = 0
        var downloads = 0
        compose.setContent {
            OrbisTheme {
                RuntimeListScreen(state, listOf(HostSnapshot(pairing("host", "Work"), state), HostSnapshot(pairing("other", "Home"), state.copy(hostId = "other"))),
                    onOpenRuntime = { _, _ -> }, onCloseRuntimes = { _, _ -> emptySet() }, onOpenDownloads = { downloads++ }, onUnpairHost = {},
                    onOpenSession = { _, _ -> }, onOpenHistory = { _, _ -> }, onNewSession = { _, _ -> },
                    onSetArchived = { _, _, _ -> }, onSelectHost = {}, onAddHost = {}, onOpenStatus = { settings++ }, onRequestProviders = {})
            }
        }
        capture("home-header-light")
        compose.onNodeWithContentDescription("更多操作").assertDoesNotExist()
        compose.onNodeWithTag("home-settings").assertIsDisplayed().performClick()
        assertEquals(1, settings)
        compose.onNodeWithContentDescription("打开下载").assertIsDisplayed().performClick()
        assertEquals(1, downloads)
        // The capsule reports the connection as one status and takes no clicks.
        compose.onNodeWithTag("home-connection-status").assert(SemanticsMatcher.keyNotDefined(SemanticsActions.OnClick))
        compose.onNodeWithTag("home-connection-status").performClick()
        assertEquals(1, settings)
        // The home switcher only switches computers (the drawer's own switcher reads "电脑, Work, 2 台").
        compose.onNode(hasText("Work") and !hasText("台", substring = true)).performClick()
        compose.onNodeWithText("Home").assertIsDisplayed()
        compose.onAllNodesWithText("添加电脑").assertCountEquals(0)
        compose.onAllNodes(hasText("取消配对", substring = true) and hasClickAction()).assertCountEquals(0)
    }

    @Test fun settingsPutProvidersFirstAndHaveNoComputerEntries() = settingsOrder(dark = false)
    @Test fun darkSettingsKeepTheSameOrder() = settingsOrder(dark = true)

    private fun settingsOrder(dark: Boolean) {
        val app = IsolatedApplication(ApplicationProvider.getApplicationContext())
        val owner = ViewModelStore()
        val model = RemoteViewModel(app)
        owner.put("settings", model)
        val state = RemoteState(hostId = "host", hostName = "Work", e2eReady = true, connection = RelayConnection.ONLINE)
        try {
            compose.setContent {
                OrbisTheme(darkTheme = dark) { StatusScreen(state = state, model = model, pairing = model.pairingStatus(), onBack = {}) }
            }
            compose.onNodeWithText("设置").assertIsDisplayed()
            capture(if (dark) "settings-dark" else "settings-light")
            val providers = compose.onNodeWithText("Agent 供应商").fetchSemanticsNode().boundsInRoot.top
            val connection = compose.onNodeWithText("当前连接").fetchSemanticsNode().boundsInRoot.top
            compose.onNodeWithText("配对信息").performScrollTo()
            val pairing = compose.onNodeWithText("配对信息").fetchSemanticsNode().positionInRoot.y
            assertTrue(providers < connection)
            assertTrue(compose.onNodeWithText("当前连接").fetchSemanticsNode().positionInRoot.y < pairing)
            compose.onAllNodesWithText("已配对电脑").assertCountEquals(0)
            compose.onAllNodesWithText("添加电脑").assertCountEquals(0)
            // Advice may name where to unpair; there is no unpair action on this page.
            compose.onAllNodes(hasText("取消配对", substring = true) and hasClickAction()).assertCountEquals(0)
        } finally {
            owner.clear()
            app.dispose()
        }
    }

    private fun capture(name: String) {
        val context = androidx.test.platform.app.InstrumentationRegistry.getInstrumentation().targetContext
        val directory = java.io.File(context.getExternalFilesDir(null), "r15").apply { mkdirs() }
        java.io.File(directory, "$name.png").outputStream().use {
            compose.onRoot().captureToImage().asAndroidBitmap().compress(android.graphics.Bitmap.CompressFormat.PNG, 100, it)
        }
    }
}
