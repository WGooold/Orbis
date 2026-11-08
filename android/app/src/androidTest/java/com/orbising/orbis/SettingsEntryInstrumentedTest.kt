// Orbis 测试用途（场景与判定见本文件断言）：
// - r15 设置与入口（S18、S22、S23、S25）；S28 / SC48 实际协议；S29 / SC49 三种 per-Host 协议模式。
// - S32 / SC51：首页仅保留右对齐下载入口；根设置不再承载供应商或返回入口。
package com.orbising.orbis

import android.content.Context
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.mutableStateOf
import androidx.compose.foundation.layout.width
import androidx.compose.ui.unit.dp
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.lifecycle.ViewModelStore
import androidx.test.core.app.ApplicationProvider
import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

/** S32 / SC51: root tabs own settings; the header keeps only download and the capsule only reports. */
class SettingsEntryInstrumentedTest {
    @get:Rule val compose = createComposeRule()

    private fun pairing(id: String, name: String) = HostPairing(id, name, "test-public", "test-root",
        relayUrl = "wss://relay.example", deviceId = "test-device", credential = "test-only")

    @Test fun headerKeepsOnlyRightAlignedDownloadAndTheCapsuleIsNotAnEntry() {
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
        compose.onNodeWithTag("home-settings").assertDoesNotExist()
        compose.onNodeWithContentDescription("设置").assertDoesNotExist()
        val download = compose.onNodeWithContentDescription("打开下载").assertIsDisplayed()
        val rootBounds = compose.onRoot().fetchSemanticsNode().boundsInRoot
        val downloadBounds = download.fetchSemanticsNode().boundsInRoot
        val maximumInset = with(compose.density) { 16.dp.toPx() }
        assertTrue("Download must occupy the trailing header action, without a settings-sized gap",
            rootBounds.right - downloadBounds.right in 0f..maximumInset)
        download.performClick()
        assertEquals(1, downloads)
        // The capsule reports the connection as one status and takes no clicks.
        compose.onNodeWithTag("home-connection-status").assert(SemanticsMatcher.keyNotDefined(SemanticsActions.OnClick))
        compose.onNodeWithTag("home-connection-status").performTouchInput { click() }
        assertEquals(0, settings)
        // The home switcher only switches computers (the drawer's own switcher reads "电脑, Work, 2 台").
        compose.onNode(hasText("Work") and !hasText("台", substring = true)).performClick()
        compose.onNodeWithText("Home").assertIsDisplayed()
        compose.onAllNodesWithText("添加电脑").assertCountEquals(0)
        compose.onAllNodes(hasText("取消配对", substring = true) and hasClickAction()).assertCountEquals(0)
    }

    @Test fun rootSettingsPutConnectionFirstAndHaveNoProviderOrComputerEntries() = settingsOrder(dark = false)
    @Test fun darkRootSettingsKeepConnectionFirstAndHaveNoProviderEntry() = settingsOrder(dark = true)

    @Test fun lightSettingsRemoveThemeChoicesAndUseUnifiedMaterial() = noAppearanceSwitch(dark = false)
    @Test fun darkSettingsRemoveThemeChoicesAndUseUnifiedMaterial() = noAppearanceSwitch(dark = true)

    @Test fun languageSwitchUpdatesSettingsAndPersistsWithoutReplacingThePage() {
        val app = IsolatedTestApplication(ApplicationProvider.getApplicationContext(), prefix = "settings")
        val owner = ViewModelStore()
        val model = RemoteViewModel(app)
        owner.put("language", model)
        var back = 0
        try {
            AppLocalization.configure(app)
            AppLocalization.select(AppLanguage.Chinese)
            compose.setContent {
                OrbisTheme { StatusScreen(RemoteState(hostId = "host", hostName = "设置 / 原文"), model,
                    model.pairingStatus(), onBack = { back++ }) }
            }
            compose.onNodeWithTag("language-en").performScrollTo().performClick().assertIsSelected()
            compose.onNodeWithText("Settings").assertIsDisplayed()
            compose.onNodeWithText("Follow system").assertIsDisplayed()
            assertEquals(0, back)
            compose.runOnIdle {
                assertEquals("en", app.getSharedPreferences(AppLocalization.PREFERENCES, Context.MODE_PRIVATE)
                    .getString(AppLocalization.PREFERENCE_KEY, null))
                AppLocalization.configure(app)
                assertEquals(AppLanguage.English, AppLocalization.language)
            }
            capture("language-settings-english")
            compose.onNodeWithText("设置 / 原文").performScrollTo().assertIsDisplayed()
            compose.onNodeWithTag("language-zh-Hans").performScrollTo().performClick().assertIsSelected()
            compose.onNodeWithText("设置").assertIsDisplayed()
            compose.onNodeWithText("跟随系统").assertIsDisplayed()
            capture("language-settings-chinese")
        } finally {
            AppLocalization.select(AppLanguage.Chinese)
            owner.clear()
            app.dispose()
        }
    }

    @Test fun englishSettingsFitNarrowLargeTypeAndKeepLanguageTargets() {
        val app = IsolatedTestApplication(ApplicationProvider.getApplicationContext(), prefix = "settings")
        val owner = ViewModelStore()
        val model = RemoteViewModel(app)
        owner.put("language-layout", model)
        try {
            AppLocalization.configure(app)
            AppLocalization.select(AppLanguage.English)
            compose.setContent {
                val density = androidx.compose.ui.platform.LocalDensity.current
                androidx.compose.runtime.CompositionLocalProvider(
                    androidx.compose.ui.platform.LocalDensity provides androidx.compose.ui.unit.Density(density.density, 1.5f)
                ) {
                    androidx.compose.foundation.layout.Box(androidx.compose.ui.Modifier.width(360.dp)) {
                        OrbisTheme(darkTheme = true) {
                            StatusScreen(RemoteState(hostId = "host", hostName = "Original computer", e2eReady = true,
                                connection = RelayConnection.ONLINE, path = "relay"), model, model.pairingStatus(), onBack = {})
                        }
                    }
                }
            }
            compose.onNodeWithText("End-to-end encryption").performScrollTo().assertIsDisplayed()
            for (key in listOf("system", "zh-Hans", "en")) {
                val choice = compose.onNodeWithTag("language-$key").performScrollTo()
                choice.assertIsDisplayed()
                assertTrue(choice.fetchSemanticsNode().boundsInRoot.height >= 48)
            }
            capture("language-english-dark-large-type")
        } finally {
            AppLocalization.select(AppLanguage.Chinese)
            owner.clear()
            app.dispose()
        }
    }

    @Test fun englishPermissionsKeepOpaqueSettingAndOptionIdentities() {
        val app = IsolatedTestApplication(ApplicationProvider.getApplicationContext(), prefix = "settings")
        var applied: Pair<String, String>? = null
        val permissions = RuntimePermissionManagement(
            summary = "工作区可写 · 按需询问", details = "网络：允许联网。\nVendor-only detail", tone = "restricted",
            settings = listOf(RuntimePermissionSetting(id = "vendor-scope", label = "文件访问范围", currentValue = "opaque-A",
                options = listOf(RuntimePermissionOption("opaque-A", "只读"), RuntimePermissionOption("opaque-B", "工作区可写"))))
        )
        try {
            AppLocalization.configure(app)
            AppLocalization.select(AppLanguage.English)
            compose.setContent {
                OrbisTheme { RuntimePermissionsStatus(permissions, onApply = { setting, value ->
                    applied = setting to value
                    "isolated-command"
                }) }
            }
            compose.onNodeWithText("Workspace write · Ask when needed").performClick()
            compose.onNodeWithText("File access scope").assertIsDisplayed()
            compose.onNodeWithText("Network: access allowed.\nVendor-only detail").assertIsDisplayed()
            compose.onNodeWithText("○ Workspace write").performClick()
            compose.onNodeWithText(L10n.tr("应用到当前会话")).performClick()
            compose.runOnIdle { assertEquals("vendor-scope" to "opaque-B", applied) }
            compose.onNodeWithText("Current session permissions").assertIsDisplayed()
            val pending = compose.onNodeWithText(L10n.tr("正在应用，等待电脑确认…"))
            pending.assertIsDisplayed().assertIsNotEnabled()
            val layouts = mutableListOf<androidx.compose.ui.text.TextLayoutResult>()
            pending.performSemanticsAction(SemanticsActions.GetTextLayoutResult) { it(layouts) }
            capture("language-permissions-english", wholeWindow = true)
            val layout = layouts.single()
            // Compose can retain the wider paragraph constraint after measuring a shorter line.
            // Check the rendered lines and final character, rather than that unused paragraph width.
            assertTrue("The pending permission message must remain fully readable", !layout.didOverflowHeight)
            for (line in 0 until layout.lineCount) {
                assertTrue("Permission line $line must not be ellipsized", !layout.isLineEllipsized(line))
                assertTrue("Permission line $line must fit its text bounds",
                    layout.getLineLeft(line) >= 0 && layout.getLineRight(line) <= layout.size.width)
            }
            assertEquals("The complete pending message must be laid out", layout.layoutInput.text.length,
                layout.getLineEnd(layout.lineCount - 1, visibleEnd = true))
        } finally {
            AppLocalization.select(AppLanguage.Chinese)
            app.dispose()
        }
    }

    private fun noAppearanceSwitch(dark: Boolean) {
        val app = IsolatedTestApplication(ApplicationProvider.getApplicationContext(), prefix = "settings")
        val owner = ViewModelStore()
        val model = RemoteViewModel(app)
        owner.put("appearance", model)
        var surface = androidx.compose.ui.graphics.Color.Unspecified
        try {
            compose.setContent {
                OrbisTheme(darkTheme = dark) {
                    surface = MaterialTheme.colorScheme.surface
                    StatusScreen(RemoteState(hostId = "host", hostName = "Work"), model, model.pairingStatus(), onBack = {})
                }
            }
            compose.onNodeWithText("外观").assertDoesNotExist()
            compose.onNodeWithText("经典").assertDoesNotExist()
            compose.onNodeWithText("雾蓝").assertDoesNotExist()
            compose.onNodeWithText("语言").performScrollTo().assertIsDisplayed()
            assertEquals(orbisMaterialColors(dark).base, surface)
            capture(if (dark) "settings-unified-dark" else "settings-unified-light")
        } finally {
            owner.clear()
            app.dispose()
        }
    }

    private fun settingsOrder(dark: Boolean) {
        val app = IsolatedTestApplication(ApplicationProvider.getApplicationContext(), prefix = "settings")
        val owner = ViewModelStore()
        val model = RemoteViewModel(app)
        owner.put("settings", model)
        val state = mutableStateOf(RemoteState(hostId = "host", hostName = "Work", e2eReady = true, connection = RelayConnection.ONLINE,
            path = "lan", pathRttMs = 42L, relayTransportKind = RelayTransportKind.QUIC,
            relayTransportMode = RelayTransportMode.AUTO))
        try {
            compose.setContent {
                OrbisTheme(darkTheme = dark) { StatusScreen(state = state.value, model = model, pairing = model.pairingStatus(), onBack = {}, root = true) }
            }
            compose.onNodeWithText("设置").assertIsDisplayed()
            compose.onNodeWithContentDescription("返回").assertDoesNotExist()
            compose.onNodeWithText("Agent 供应商").assertDoesNotExist()
            capture(if (dark) "settings-dark" else "settings-light")
            compose.onNodeWithText("当前连接").assertIsDisplayed()
            compose.onNodeWithText("连接协议").performScrollTo().assertIsDisplayed()
            compose.onNodeWithTag("relay-mode-WS").assertIsDisplayed()
            compose.onNodeWithTag("relay-mode-AUTO").performScrollTo().assertIsSelected()
            compose.onNodeWithTag("relay-mode-WS").assertIsNotSelected()
            compose.onNodeWithTag("relay-mode-QUIC").assertIsNotSelected()
            compose.runOnIdle { state.value = state.value.copy(relayTransportMode = RelayTransportMode.WS) }
            compose.onNodeWithTag("relay-mode-WS").assertIsSelected()
            compose.runOnIdle { state.value = state.value.copy(relayTransportMode = RelayTransportMode.QUIC) }
            compose.onNodeWithTag("relay-mode-QUIC").assertIsSelected()
            compose.runOnIdle { state.value = state.value.copy(relayTransportMode = RelayTransportMode.AUTO) }
            compose.onNodeWithText("连接延迟").performScrollTo().assertIsDisplayed()
            compose.onNodeWithText("42 ms").assertIsDisplayed()
            val latencyTop = compose.onNodeWithText("连接延迟").fetchSemanticsNode().boundsInRoot.top
            capture(if (dark) "settings-latency-dark" else "settings-latency-light")
            compose.runOnIdle { state.value = state.value.copy(path = "relay", pathRttMs = 137L) }
            compose.onNodeWithTag("relay-mode-QUIC").assertIsDisplayed()
            compose.onNodeWithText("137 ms").assertIsDisplayed()
            assertEquals(latencyTop, compose.onNodeWithText("连接延迟").fetchSemanticsNode().boundsInRoot.top, 1f)
            compose.runOnIdle { state.value = state.value.copy(pathRttMs = null) }
            compose.onNodeWithText("暂不可用").assertIsDisplayed()
            compose.runOnIdle { state.value = state.value.copy(e2eReady = false, pathRttMs = 137L) }
            compose.onAllNodesWithText("暂不可用").assertCountEquals(2)
            compose.runOnIdle { state.value = state.value.copy(e2eReady = true, pathRttMs = 42L) }
            compose.onNodeWithText("配对信息").performScrollTo()
            val pairing = compose.onNodeWithText("配对信息").fetchSemanticsNode().positionInRoot.y
            compose.onNodeWithText("Agent 供应商").assertDoesNotExist()
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

    private fun capture(name: String, wholeWindow: Boolean = false) {
        val instrumentation = androidx.test.platform.app.InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.targetContext
        compose.waitForIdle()
        // Bottom sheets own a separate window; a Compose root bitmap can omit that window.
        val bitmap = if (wholeWindow) checkNotNull(instrumentation.uiAutomation.takeScreenshot())
            else compose.onRoot().captureToImage().asAndroidBitmap()
        val directory = java.io.File(context.getExternalFilesDir(null), "r15").apply { mkdirs() }
        java.io.File(directory, "$name.png").outputStream().use {
            bitmap.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, it)
        }
    }
}
