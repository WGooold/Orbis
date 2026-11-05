package com.orbising.orbis

import android.animation.ValueAnimator
import android.graphics.Bitmap
import android.os.SystemClock
import android.os.ParcelFileDescriptor
import androidx.compose.foundation.layout.*
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.unit.dp
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Rule
import org.junit.Test

class ReplyCardMotionInstrumentedTest {
    @get:Rule val compose = createComposeRule()
    private fun height() = compose.onNodeWithTag("reply-card").fetchSemanticsNode().boundsInRoot.height

    @Test fun liveGrowthHasIntermediateFramesAndRetargetsWithoutScalingExistingText() {
        assumeTrue(ValueAnimator.areAnimatorsEnabled())
        val body = mutableStateOf("FIRST")
        compose.mainClock.autoAdvance = false
        compose.setContent {
            OrbisTheme {
                Box(Modifier.width(320.dp).padding(16.dp)) {
                    GrowingReplyCard("reply", listOf(ReplyCardPart("text", body.value)), true, null,
                        Modifier.testTag("reply-card")) {
                        Column { Text("ANCHOR", Modifier.testTag("anchor")); Text(body.value) }
                    }
                }
            }
        }
        compose.mainClock.advanceTimeBy(300)
        val initial = height()
        val anchor = compose.onNodeWithTag("anchor").fetchSemanticsNode().boundsInRoot
        compose.runOnIdle { body.value += "\nSECOND\nTHIRD\nFOURTH" }
        compose.mainClock.advanceTimeBy(64)
        val intermediate = height()
        assertTrue(intermediate > initial)
        capture("growth-middle")
        compose.runOnIdle { body.value += "\nFIFTH\nSIXTH" }
        compose.mainClock.advanceTimeByFrame()
        assertTrue("retarget must not jump back to the previous start", height() >= intermediate)
        compose.mainClock.advanceTimeBy(400)
        assertTrue(height() > intermediate)
        assertEquals("existing text must not scale or drift", anchor,
            compose.onNodeWithTag("anchor").fetchSemanticsNode().boundsInRoot)
        compose.onNodeWithText(body.value).assertExists()
        capture("growth-complete")
        compose.mainClock.autoAdvance = true
    }

    @Test fun newReplyEntersOnceAndLazyRemountShowsItsFullHeightImmediately() {
        assumeTrue(ValueAnimator.areAnimatorsEnabled())
        val mounted = mutableStateOf(true)
        compose.mainClock.autoAdvance = false
        compose.setContent {
            val arrivals = remember {
                ReplyCardArrivals().apply {
                    observe(emptyList(), true, true, SystemClock.uptimeMillis())
                    observe(listOf("new" to listOf("new")), true, true, SystemClock.uptimeMillis())
                }
            }
            OrbisTheme {
                Box(Modifier.width(320.dp).padding(16.dp)) {
                    if (mounted.value) GrowingReplyCard("new", listOf(ReplyCardPart("text", "new")), true, arrivals,
                        Modifier.testTag("reply-card")) { Column { Text("FIRST\nSECOND\nTHIRD\nFOURTH") } }
                }
            }
        }
        compose.mainClock.advanceTimeBy(64)
        val middle = height()
        capture("arrival-middle")
        compose.mainClock.advanceTimeBy(400)
        val full = height()
        assertTrue(middle < full)
        compose.runOnIdle { mounted.value = false }
        compose.mainClock.advanceTimeByFrame()
        compose.runOnIdle { mounted.value = true }
        compose.mainClock.advanceTimeBy(32)
        assertEquals(full, height(), 1f)
        capture("remount-complete")
        compose.mainClock.autoAdvance = true
    }

    @Test fun oldHistoryAndRewritesDoNotAnimateTheirHeight() {
        val body = mutableStateOf("FIRST\nSECOND\nTHIRD\nFOURTH")
        compose.mainClock.autoAdvance = false
        compose.setContent {
            OrbisTheme {
                Box(Modifier.width(320.dp).padding(16.dp)) {
                    GrowingReplyCard("old", listOf(ReplyCardPart("text", body.value)), false, null,
                        Modifier.testTag("reply-card")) { Column { Text(body.value) } }
                }
            }
        }
        compose.mainClock.advanceTimeBy(32)
        val initial = height()
        compose.mainClock.advanceTimeBy(300)
        assertEquals(initial, height(), 1f)
        compose.runOnIdle { body.value = "REWRITTEN" }
        compose.mainClock.advanceTimeBy(32)
        val shortened = height()
        assertTrue(shortened < initial)
        compose.mainClock.advanceTimeBy(300)
        assertEquals(shortened, height(), 1f)
        compose.mainClock.autoAdvance = true
    }

    @Test fun systemReducedMotionShowsNewCardsAndLiveGrowthImmediately() {
        val keys = listOf("animator_duration_scale", "transition_animation_scale", "window_animation_scale")
        val previous = keys.associateWith { shell("settings get global $it").trim() }
        try {
            keys.forEach { shell("settings put global $it 0") }
            compose.waitUntil(5_000) { !ValueAnimator.areAnimatorsEnabled() }
            val body = mutableStateOf("FIRST\nSECOND")
            compose.mainClock.autoAdvance = false
            compose.setContent {
                val arrivals = remember {
                    ReplyCardArrivals().apply {
                        observe(emptyList(), true, true, SystemClock.uptimeMillis())
                        observe(listOf("new" to listOf("new")), true, true, SystemClock.uptimeMillis())
                    }
                }
                OrbisTheme {
                    Box(Modifier.width(320.dp).padding(16.dp)) {
                        GrowingReplyCard("new", listOf(ReplyCardPart("text", body.value)), true, arrivals,
                            Modifier.testTag("reply-card")) { Column { Text(body.value) } }
                    }
                }
            }
            compose.mainClock.advanceTimeBy(32)
            val first = height()
            compose.onNodeWithText(body.value).assertIsDisplayed()
            compose.mainClock.advanceTimeBy(300)
            assertEquals(first, height(), 1f)
            compose.runOnIdle { body.value += "\nTHIRD\nFOURTH" }
            compose.mainClock.advanceTimeBy(32)
            val grown = height()
            assertTrue(grown > first)
            compose.mainClock.advanceTimeBy(300)
            assertEquals(grown, height(), 1f)
            capture("reduced-live-growth")
        } finally {
            compose.mainClock.autoAdvance = true
            previous.forEach { (key, value) ->
                shell(if (value == "null") "settings delete global $key" else "settings put global $key $value")
            }
            val originallyEnabled = previous.getValue("animator_duration_scale").toFloatOrNull() != 0f
            compose.waitUntil(5_000) { ValueAnimator.areAnimatorsEnabled() == originallyEnabled }
        }
    }

    private fun shell(command: String): String {
        val descriptor = androidx.test.platform.app.InstrumentationRegistry.getInstrumentation().uiAutomation.executeShellCommand(command)
        return ParcelFileDescriptor.AutoCloseInputStream(descriptor).bufferedReader().use { it.readText() }
    }

    private fun capture(name: String) {
        val context = androidx.test.platform.app.InstrumentationRegistry.getInstrumentation().targetContext
        val directory = java.io.File(context.getExternalFilesDir(null), "reply-card-motion").apply { mkdirs() }
        java.io.File(directory, "$name.png").outputStream().use {
            compose.onRoot().captureToImage().asAndroidBitmap().compress(Bitmap.CompressFormat.PNG, 100, it)
        }
    }
}
