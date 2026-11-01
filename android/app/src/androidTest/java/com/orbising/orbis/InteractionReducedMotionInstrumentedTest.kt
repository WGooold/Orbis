package com.orbising.orbis

import android.animation.ValueAnimator
import android.os.ParcelFileDescriptor
import androidx.compose.foundation.layout.*
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.Settings
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.unit.dp
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import java.io.File

/** A4 uses the actual system setting, restores it even on failure, and never assumes/skips. */
class InteractionReducedMotionInstrumentedTest {
    @get:Rule val compose = createComposeRule()

    @Test fun selectionMenusIconsAndSendKeepTheirMeaningWithSystemAnimationsDisabled() {
        val keys = listOf("animator_duration_scale", "transition_animation_scale", "window_animation_scale")
        val previous = keys.associateWith { shell("settings get global $it").trim() }
        try {
            keys.forEach { shell("settings put global $it 0") }
            compose.waitUntil(5_000) { !ValueAnimator.areAnimatorsEnabled() }
            var selecting by mutableStateOf(false)
            var menu by mutableStateOf(false)
            var page by mutableStateOf(emptyList<String>())
            var taps = 0
            var fullPage by mutableStateOf(false)
            var backs = 0
            lateinit var flight: MessageSendFlightState
            compose.setContent { OrbisTheme {
                val scope = rememberCoroutineScope()
                flight = remember { MessageSendFlightState(scope) }
                Column(Modifier.fillMaxSize().padding(24.dp)) {
                    SelectionToolbar(selecting,
                        normal = { NeumorphTextButton("打开", { menu = true }) },
                        selected = { NeumorphTextButton("退出选择", { selecting = false }) })
                    NeumorphSurface(Modifier.fillMaxWidth().height(100.dp).testTag("card"),
                        selectionSelected = selecting, selectionMode = selecting, onClick = { selecting = !selecting }) { Text("选择卡片") }
                    NeumorphIconButton({ taps++ }, Icons.Rounded.Settings, "设置反馈", Modifier.testTag("glyph"))
                    NeumorphTextButton("打开整页", { fullPage = true })
                    Box {
                        NeumorphMenu(menu, { menu = false }, page = page, onBack = { page = emptyList() }) { shown ->
                            if (shown.isEmpty()) NeumorphMenuItem({ Text("二级菜单") }, { page = listOf("child") })
                            else NeumorphMenuItem({ Text("返回菜单") }, { page = emptyList() })
                        }
                    }
                }
                if (fullPage) OrbisPageHost(onBack = { backs++; fullPage = false }, underlay = {}) {
                    Box(Modifier.fillMaxSize().testTag("reduced-page")) { Text("整页内容") }
                }
            } }
            val card = compose.onNodeWithTag("card")
            val bounds = card.fetchSemanticsNode().boundsInRoot
            card.performClick()
            compose.onNodeWithText("退出选择").assertIsDisplayed().performClick()
            compose.onNodeWithText("退出选择").assertDoesNotExist()
            assertEquals(bounds, card.fetchSemanticsNode().boundsInRoot)
            val icon = compose.onNodeWithTag("glyph")
            val before = icon.captureToImage().asAndroidBitmap()
            icon.performClick(); icon.performClick()
            assertTrue(before.sameAs(icon.captureToImage().asAndroidBitmap()))
            compose.runOnIdle {
                assertEquals(2, taps)
                flight.composer = Rect(20f, 600f, 360f, 660f); flight.root = Rect(0f, 0f, 400f, 800f)
                flight.launch(PendingSend("m", "c", "s", "输入", emptyList(), null, 1, null), true)
                assertTrue(flight.flights.isEmpty())
            }
            compose.onNodeWithText("打开").performClick()
            compose.onNodeWithText("二级菜单").performClick()
            compose.onNodeWithText("返回菜单").assertIsDisplayed().performClick()
            compose.onNodeWithText("二级菜单").assertIsDisplayed()
            compose.runOnIdle { menu = false }
            compose.onNodeWithText("二级菜单").assertDoesNotExist()
            compose.onNodeWithText("打开整页").performClick()
            compose.onNodeWithText("整页内容").assertIsDisplayed()
            assertEquals(0f, compose.onNodeWithTag("reduced-page").fetchSemanticsNode().positionInRoot.x, 1f)
            compose.onNodeWithTag("reduced-page").performTouchInput { swipeRight() }
            compose.onNodeWithText("整页内容").assertDoesNotExist()
            compose.runOnIdle { assertEquals(1, backs) }
            val context = InstrumentationRegistry.getInstrumentation().targetContext
            File(context.getExternalFilesDir(null), "motion-reduced.png").outputStream().use {
                compose.onRoot().captureToImage().asAndroidBitmap().compress(android.graphics.Bitmap.CompressFormat.PNG, 100, it)
            }
        } finally {
            previous.forEach { (key, value) ->
                shell(if (value == "null") "settings delete global $key" else "settings put global $key $value")
            }
        }
    }

    private fun shell(command: String): String = ParcelFileDescriptor.AutoCloseInputStream(
        InstrumentationRegistry.getInstrumentation().uiAutomation.executeShellCommand(command)
    ).bufferedReader().use { it.readText() }
}
