// SC53: background sync keeps the transport label and bounds fixed, animates only the matte dot,
// and remains still when motion is disabled. Captures cover the real capsule in both appearances.
package com.orbising.orbis

import android.graphics.Bitmap
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.unit.dp
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

class HomeConnectionStatusInstrumentedTest {
    @get:Rule val compose = createComposeRule()

    @Test fun lightBackgroundSyncKeepsTheCapsuleStill() = exercise(false)
    @Test fun darkBackgroundSyncKeepsTheCapsuleStill() = exercise(true)

    private fun exercise(dark: Boolean) {
        val sync = mutableStateOf<HomeSyncStatus>(HomeSyncStatus.Idle)
        compose.setContent {
            OrbisTheme(darkTheme = dark) {
                Box(Modifier.testTag("capsule-capture").padding(16.dp)) {
                    ConnectionStatus(RelayConnection.ONLINE, e2eReady = true, path = "relay", sync = sync.value)
                }
            }
        }
        val capsule = compose.onNodeWithTag("capsule-capture")
        val label = compose.onNodeWithText("中继")
        val dot = compose.onNodeWithTag("home-connection-indicator")
        label.assertIsDisplayed()
        val bounds = capsule.fetchSemanticsNode().boundsInRoot
        val labelBounds = label.fetchSemanticsNode().boundsInRoot
        val dotBounds = dot.fetchSemanticsNode().boundsInRoot
        compose.mainClock.autoAdvance = false
        repeat(4) {
            compose.runOnIdle { sync.value = HomeSyncStatus.Syncing }
            compose.mainClock.advanceTimeByFrame()
            dot.assert(SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, "正在同步"))
            compose.onNodeWithText("正在同步").assertDoesNotExist()
            label.assertIsDisplayed()
            assertEquals(bounds, capsule.fetchSemanticsNode().boundsInRoot)
            assertEquals(labelBounds, label.fetchSemanticsNode().boundsInRoot)
            assertEquals(dotBounds, dot.fetchSemanticsNode().boundsInRoot)
            val bright = dot.captureToImage().asAndroidBitmap()
            compose.mainClock.advanceTimeBy(1_100)
            val dim = dot.captureToImage().asAndroidBitmap()
            var changedPixels = 0
            for (y in 0 until minOf(bright.height, dim.height)) for (x in 0 until minOf(bright.width, dim.width)) {
                val a = bright.getPixel(x, y)
                val b = dim.getPixel(x, y)
                val delta = kotlin.math.abs(android.graphics.Color.red(a) - android.graphics.Color.red(b)) +
                    kotlin.math.abs(android.graphics.Color.green(a) - android.graphics.Color.green(b)) +
                    kotlin.math.abs(android.graphics.Color.blue(a) - android.graphics.Color.blue(b))
                if (delta >= 18) changedPixels++
            }
            assertTrue("Sync highlight should visibly breathe within the dot; changed pixels=$changedPixels", changedPixels >= 6)
            if (it == 0) capture(dark, "syncing", capsule.captureToImage().asAndroidBitmap())
            compose.runOnIdle { sync.value = HomeSyncStatus.Idle }
            compose.mainClock.advanceTimeByFrame()
            assertEquals(bounds, capsule.fetchSemanticsNode().boundsInRoot)
        }
        capture(dark, "idle", capsule.captureToImage().asAndroidBitmap())
        compose.runOnIdle { sync.value = HomeSyncStatus.Failed("test failure") }
        compose.mainClock.advanceTimeBy(300)
        compose.onNodeWithText("同步失败").assertIsDisplayed()
    }

    @Test fun reducedMotionKeepsTheRaisedDotVisibleAndStill() {
        compose.setContent {
            OrbisTheme {
                NeumorphStatusDot(androidx.compose.material3.MaterialTheme.colorScheme.tertiary,
                    pulsing = true, motionEnabled = false, modifier = Modifier.testTag("dot"))
            }
        }
        compose.mainClock.autoAdvance = false
        val dot = compose.onNodeWithTag("dot").assertIsDisplayed()
        val first = dot.captureToImage().asAndroidBitmap()
        compose.mainClock.advanceTimeBy(1_100)
        assertTrue(first.sameAs(dot.captureToImage().asAndroidBitmap()))
    }

    private fun capture(dark: Boolean, stage: String, bitmap: Bitmap) {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val directory = File(context.getExternalFilesDir(null), "home-connection-dot").apply { mkdirs() }
        File(directory, "dot-${if (dark) "dark" else "light"}-$stage.png").outputStream().use {
            bitmap.compress(Bitmap.CompressFormat.PNG, 100, it)
        }
    }
}
