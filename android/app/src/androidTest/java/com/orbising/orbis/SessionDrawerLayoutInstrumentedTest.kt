// Orbis 测试用途（场景与判定见本文件断言）：
// - S19 / R65：防止标题长度、字体及外观变化破坏会话行等高和所属目录几何。
// - 目录（S15、S19、M06、M09、V17）
package com.orbising.orbis

import android.content.res.Configuration
import android.graphics.Bitmap
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.DrawerValue
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalNavigationDrawer
import androidx.compose.material3.rememberDrawerState
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.unit.Density
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

class SessionDrawerLayoutInstrumentedTest {
    @get:Rule val compose = createComposeRule()

    @Test fun lightCardsKeepUniformGeometry() = exercise(false)
    @Test fun darkCardsKeepUniformGeometry() = exercise(true)

    private fun exercise(dark: Boolean) {
        val scale = mutableStateOf(1f)
        val style = mutableStateOf(OrbisVisualStyle.Classic)
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
                OrbisTheme(darkTheme = dark, visualStyle = style.value) {
                    val host = HostSnapshot(HostPairing("layout-host", "Test Host", "test-public", "test-root",
                        relayUrl = "wss://relay.example", deviceId = "test-device", credential = "test-only"), state.value)
                    ModalNavigationDrawer(
                        drawerState = rememberDrawerState(DrawerValue.Open),
                        scrimColor = rememberNeumorphColors().scrim.copy(alpha = 0.32f),
                        drawerContent = {
                            SessionDrawer(state.value, listOf(host), {}, {}, {}, { _, _ -> }, { _, _ -> }, { _, _ -> }, { _, _, _ -> })
                        },
                    ) {
                        Box(Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background))
                    }
                }
            }
        }
        for (visualStyle in OrbisVisualStyle.values()) for (fontScale in listOf(1f, 1.5f)) {
            compose.runOnIdle { style.value = visualStyle; scale.value = fontScale }
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
            File(context.getExternalFilesDir(null), "drawer-layout-${visualStyle.key}-${if (dark) "dark" else "light"}-$fontScale.png")
                .outputStream().use { compose.onRoot().captureToImage().asAndroidBitmap().compress(Bitmap.CompressFormat.PNG, 100, it) }
            // Geometry alone cannot detect a material parent flattening every card.
            // Sample the blank top padding, away from rounded corners and text.
            val card = short.captureToImage().asAndroidBitmap()
            val x = card.width / 2
            val edge = card.getPixel(x, (2 * compose.density.density).toInt())
            val inside = card.getPixel(x, (10 * compose.density.density).toInt())
            fun brightness(pixel: Int) = (android.graphics.Color.red(pixel) +
                android.graphics.Color.green(pixel) + android.graphics.Color.blue(pixel)) / 3f
            assertTrue("${visualStyle.key} / dark=$dark / font=$fontScale must retain the inset top shadow",
                brightness(inside) - brightness(edge) > 2f)
        }
    }
}
