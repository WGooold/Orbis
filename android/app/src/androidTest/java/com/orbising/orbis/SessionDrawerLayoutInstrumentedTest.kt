package com.orbising.orbis

import android.content.res.Configuration
import android.graphics.Bitmap
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.unit.Density
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test

class SessionDrawerLayoutInstrumentedTest {
    @get:Rule val compose = createComposeRule()

    @Test fun lightCardsKeepUniformGeometry() = exercise(false)
    @Test fun darkCardsKeepUniformGeometry() = exercise(true)

    private fun exercise(dark: Boolean) {
        val scale = mutableStateOf(1f)
        val state = mutableStateOf(RemoteState(hostId = "layout-host", e2eReady = true,
            sessions = listOf(
                SessionCatalogEntry(sessionId = "short", name = "短标题", cwd = "/repo", agentKind = "codex"),
                SessionCatalogEntry(sessionId = "long", name = "这是一个需要换行并且超过两行后显示省略号的很长会话标题，用来检查侧边栏卡片是否始终等高", cwd = "/repo", agentKind = "codex"),
            ).associateBy { it.sessionId }))
        compose.setContent {
            val density = LocalDensity.current
            val configuration = Configuration(LocalConfiguration.current).apply { screenWidthDp = 360 }
            CompositionLocalProvider(LocalDensity provides Density(density.density, scale.value),
                LocalConfiguration provides configuration) {
                OrbisTheme(darkTheme = dark) {
                    val host = HostSnapshot(HostPairing("layout-host", "Test Host", "test-public", "test-root",
                        relayUrl = "wss://relay.example", deviceId = "test-device", credential = "test-only"), state.value)
                    SessionDrawer(state.value, listOf(host), {}, {}, {}, { _, _ -> }, { _, _ -> }, { _, _ -> }, { _, _, _ -> })
                }
            }
        }
        for (fontScale in listOf(1f, 1.5f)) {
            compose.runOnIdle { scale.value = fontScale }
            val short = compose.onNodeWithTag("drawer-session-short")
            val long = compose.onNodeWithTag("drawer-session-long")
            val before = short.fetchSemanticsNode().boundsInRoot
            val other = long.fetchSemanticsNode().boundsInRoot
            assertEquals(before.width, other.width, 0.5f)
            assertEquals(before.height, other.height, 0.5f)
            short.performTouchInput { longClick() }
            assertEquals(before, short.fetchSemanticsNode().boundsInRoot)
            assertEquals(other, long.fetchSemanticsNode().boundsInRoot)
            compose.onNodeWithContentDescription("退出多选").performClick()
            val context = InstrumentationRegistry.getInstrumentation().targetContext
            File(context.getExternalFilesDir(null), "drawer-layout-${if (dark) "dark" else "light"}-$fontScale.png")
                .outputStream().use { compose.onRoot().captureToImage().asAndroidBitmap().compress(Bitmap.CompressFormat.PNG, 100, it) }
        }
    }
}
