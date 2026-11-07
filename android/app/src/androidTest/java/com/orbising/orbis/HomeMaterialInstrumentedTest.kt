// S18 material regression: the home and drawer share the same soft base while brand identity,
// selection geometry and the host popup remain readable in both appearances.
package com.orbising.orbis

import android.graphics.Bitmap
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test

class HomeMaterialInstrumentedTest {
    @get:Rule val compose = createComposeRule()

    @Test fun lightHomeSharesTheDrawerMaterial() = exercise(false)
    @Test fun darkHomeSharesTheDrawerMaterial() = exercise(true)

    private fun exercise(dark: Boolean) {
        val pairing = HostPairing("home-material", "Test Host", "test-public", "test-root",
            relayUrl = "wss://relay.example", deviceId = "test-device", credential = "test-only")
        val kinds = listOf("pi", "codex", "dsh", "claude")
        val state = RemoteState(hostId = "home-material", connection = RelayConnection.ONLINE, e2eReady = true,
            runtimes = kinds.associateWith { kind ->
                RuntimeSummary(kind, "Review $kind", "/repo/workspace", "idle", sessionId = kind, agentKind = kind,
                    domainAvailability = mapOf("identity" to "ready", "execution" to "ready", "interactions" to "ready"))
            }).withReadyHomeFixture()
        val hosts = listOf(HostSnapshot(pairing, state),
            HostSnapshot(pairing.copy(hostId = "backup-material", hostName = "Backup Host"), RemoteState(hostId = "backup-material")))
        compose.setContent {
            OrbisTheme(darkTheme = dark) {
                RuntimeListScreen(state, hosts,
                    onOpenRuntime = { _, _ -> }, onCloseRuntimes = { _, _ -> emptySet() }, onOpenDownloads = {}, onUnpairHost = {},
                    onOpenSession = { _, _ -> }, onOpenHistory = { _, _ -> }, onNewSession = { _, _ -> },
                    onSetArchived = { _, _, _ -> }, onSelectHost = {}, onAddHost = {}, onOpenStatus = {}, onRequestProviders = {})
            }
        }
        compose.waitForIdle()
        val expected = orbisMaterialColors(dark).base.toArgb()
        val image = compose.onRoot().captureToImage().asAndroidBitmap()
        // The uninterrupted left gutter must use the same base as the approved drawer.
        assertEquals(expected, image.getPixel(2, image.height / 2))
        val bounds = kinds.associateWith { compose.onNodeWithTag("home-runtime-$it").fetchSemanticsNode().boundsInRoot }
        capture(dark, "resting")
        for (brand in listOf("Pi", "Codex", "DeepSeek", "Claude Code")) compose.onNodeWithText(brand).assertIsDisplayed()
        // The retained closed drawer has the same host name offscreen; target the home control.
        compose.onNode(hasText("Test Host") and hasAnyAncestor(hasTestTag("drawer-panel")).not()).performClick()
        compose.onNodeWithText("Backup Host").assertIsDisplayed()
        capture(dark, "hosts", compose.onNode(isPopup()))
        // Select the current host only: dismissing the popup must not perform a remote operation.
        compose.onNode(hasText("Test Host") and hasAnyAncestor(isPopup())).performClick()
        compose.onNodeWithTag("home-runtime-pi").performTouchInput { longClick() }
        compose.onNodeWithText("已选择 1 项").assertIsDisplayed()
        for (kind in kinds) assertEquals(bounds.getValue(kind), compose.onNodeWithTag("home-runtime-$kind").fetchSemanticsNode().boundsInRoot)
        capture(dark, "selection")
        compose.onNodeWithContentDescription("退出多选").performClick()
        compose.onNodeWithContentDescription("打开会话目录").performClick()
        compose.onNodeWithText("工作目录").assertIsDisplayed()
        val drawer = compose.onNodeWithTag("drawer-panel").captureToImage().asAndroidBitmap()
        assertEquals(expected, drawer.getPixel(2, drawer.height / 2))
    }

    private fun capture(dark: Boolean, stage: String, node: SemanticsNodeInteraction = compose.onRoot()) {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        File(context.getExternalFilesDir(null), "home-material-${if (dark) "dark" else "light"}-$stage.png").outputStream().use {
            node.captureToImage().asAndroidBitmap().compress(Bitmap.CompressFormat.PNG, 100, it)
        }
    }
}
