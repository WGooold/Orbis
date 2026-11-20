package com.orbising.orbis

import android.graphics.Bitmap
import android.os.Handler
import android.os.HandlerThread
import android.view.FrameMetrics
import android.view.Window
import androidx.activity.ComponentActivity
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.unit.dp
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import java.util.Collections
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

/** S19 / V21: exercise real drags through a large catalog, including recycled closed branches. */
class SessionDrawerScrollInstrumentedTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    @Test fun longCatalogScrollsAndReopensDirectoriesInLight() = exercise(false)
    @Test fun longCatalogScrollsAndReopensDirectoriesInDark() = exercise(true)

    // SC115 / V21: a static long branch must keep its geometry when lazy rows mount and
    // must not flash to the directory header during a reverse fling. No transport is involved.
    @Test fun recyclingAndReversingFlingInOneLongDirectoryKeepsTheViewport() {
        val count = 400
        val anchor = 200
        val prefix = "drawer-session-long-"
        val entries = (0 until count).map { index ->
            val id = "long-$index"
            SessionCatalogEntry(sessionId = id, name = id, cwd = "/repo/long", agentKind = "pi", modifiedAt = count.toLong() - index)
        }
        val state = RemoteState(hostId = "drawer-scroll", e2eReady = true, sessions = entries.associateBy { it.sessionId })
        val host = HostSnapshot(HostPairing("drawer-scroll", "Fixture", "public", "root",
            relayUrl = "wss://relay.example", deviceId = "fixture-device", credential = "fixture"), state)
        compose.setContent { OrbisTheme {
            SessionDrawer(state, listOf(host), {}, {}, {}, { _, _ -> }, { _, _ -> }, { _, _ -> }, { _, _, _ -> })
        } }
        val more = "查看全部 $count 条"
        compose.waitUntil(10_000) { compose.onAllNodesWithText(more).fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithText(more).performScrollTo().performClick()
        val list = compose.onNodeWithTag("drawer-session-list")
        compose.waitForIdle()
        compose.mainClock.autoAdvance = false
        try {
            list.performScrollToIndex(anchor + 1) // position directly without composing intervening rows
            compose.waitForIdle()
            compose.onNodeWithTag("$prefix$anchor").assertIsDisplayed() // no enter animation to wait for
        } finally {
            compose.mainClock.autoAdvance = true
        }
        fun firstVisibleSession(): Int = compose.onAllNodes(SemanticsMatcher("is a long directory session") {
            it.config.getOrNull(SemanticsProperties.TestTag)?.startsWith(prefix) == true
        }).fetchSemanticsNodes().filter { it.boundsInRoot.height > 0f }.minOf {
            it.config[SemanticsProperties.TestTag].removePrefix(prefix).toInt()
        }
        val distance = with(compose.density) { 128.dp.toPx() }
        val velocity = with(compose.density) { 700.dp.toPx() }
        list.performTouchInput { swipeWithVelocity(center, center - Offset(0f, distance), endVelocity = velocity) }
        val deeper = firstVisibleSession()
        assertTrue("forward fling should advance locally from $anchor, got $deeper", deeper in (anchor + 2)..(anchor + 35))
        compose.mainClock.autoAdvance = false
        try {
            list.performTouchInput { swipeWithVelocity(center, center + Offset(0f, distance), endVelocity = velocity) }
            repeat(24) { frame ->
                compose.mainClock.advanceTimeByFrame()
                val first = firstVisibleSession()
                assertTrue("reverse fling jumped from $deeper to $first at frame $frame", first in (anchor - 35)..deeper)
            }
        } finally {
            compose.mainClock.autoAdvance = true
        }
        val earlier = firstVisibleSession()
        assertTrue("reverse fling should move toward, not jump past, the anchor: $deeper -> $earlier",
            earlier in (anchor - 35)..(deeper - 2))
        compose.onNodeWithTag("drawer-directory-/repo/long").assertIsNotDisplayed()
    }

    private fun exercise(dark: Boolean) {
        val entries = (0 until 80).flatMap { directory -> (0 until 12).map { session ->
            val id = "d%03d-s%02d".format(directory, session)
            SessionCatalogEntry(sessionId = id, name = id, cwd = "/repo/d%03d".format(directory),
                agentKind = "pi", modifiedAt = 10000L - directory * 100 - session)
        } }
        val state = mutableStateOf(RemoteState(hostId = "drawer-scroll", e2eReady = true,
            sessions = entries.associateBy { it.sessionId }))
        val opened = mutableListOf<Pair<String, String>>()
        compose.setContent {
            OrbisTheme(darkTheme = dark) {
                val host = HostSnapshot(HostPairing("drawer-scroll", "Fixture", "public", "root",
                    relayUrl = "wss://relay.example", deviceId = "fixture-device", credential = "fixture"), state.value)
                SessionDrawer(state.value, listOf(host), {}, {}, {}, { h, s -> opened += h to s },
                    { _, _ -> }, { _, _ -> }, { _, _, _ -> })
            }
        }
        val files = InstrumentationRegistry.getInstrumentation().targetContext.getExternalFilesDir(null)
        val appearance = if (dark) "dark" else "light"
        fun capture(stage: String) {
            File(files, "drawer-scroll-$appearance-$stage.png").outputStream().use {
                compose.onRoot().captureToImage().asAndroidBitmap().compress(Bitmap.CompressFormat.PNG, 100, it)
            }
        }
        // Catalog projection runs off the UI thread; wait for publication before testing the preview.
        compose.waitUntil(timeoutMillis = 10_000) {
            compose.onAllNodesWithTag("drawer-session-d000-s02").fetchSemanticsNodes().isNotEmpty()
        }
        // S30: preview is three rows; footer remains part of the recessed panel.
        compose.onNodeWithTag("drawer-session-d000-s02").assertExists()
        compose.onNodeWithTag("drawer-session-d000-s03").assertDoesNotExist()
        compose.onNodeWithText("查看全部 12 条").assertExists()
        capture("top")
        compose.onNodeWithText("d000").performClick()
        compose.waitForIdle()
        capture("collapsed")
        // Capture intermediate geometry to catch a square header or a white press frame.
        compose.mainClock.autoAdvance = false
        compose.onNodeWithText("d000").performClick()
        for (step in listOf(16L, 64L, 80L, 120L)) {
            compose.mainClock.advanceTimeBy(step)
            capture("expand-${compose.mainClock.currentTime}")
        }
        compose.mainClock.autoAdvance = true
        compose.waitForIdle()
        // Directory catalog is also a three-item preview until explicitly expanded.
        compose.onNodeWithTag("drawer-directory-/repo/d003").assertDoesNotExist()
        compose.onNodeWithTag("drawer-session-list").performScrollToNode(hasText("查看全部 80 个工作目录"))
        compose.onNodeWithText("查看全部 80 个工作目录").performClick()
        val frames = Collections.synchronizedList(mutableListOf<Long>())
        val thread = HandlerThread("drawer-frame-metrics").apply { start() }
        val listener = Window.OnFrameMetricsAvailableListener { _, metrics, _ ->
            frames += metrics.getMetric(FrameMetrics.TOTAL_DURATION)
        }
        compose.runOnIdle { compose.activity.window.addOnFrameMetricsAvailableListener(listener, Handler(thread.looper)) }
        try {
            repeat(12) {
                compose.onNodeWithTag("drawer-session-list").performTouchInput { swipeUp(durationMillis = 250) }
                // A transport-only state update must not change catalog order or the user's position.
                compose.runOnIdle { state.value = state.value.copy(lastSequence = mapOf("transport" to it.toLong())) }
            }
            compose.waitForIdle()
        } finally {
            compose.runOnIdle { compose.activity.window.removeOnFrameMetricsAvailableListener(listener) }
            thread.quitSafely()
            thread.join(5000)
        }
        val samples = synchronized(frames) { frames.toList() }
        File(files, "drawer-scroll-$appearance-frames.json").writeText(samples.joinToString(prefix = "[", postfix = "]"))
        val list = compose.onNodeWithTag("drawer-session-list")
        list.performScrollToNode(hasTestTag("drawer-directory-/repo/d079"))
        capture("end")
        compose.onNodeWithText("d079").performClick()
        list.performScrollToNode(hasTestTag("drawer-session-d079-s02"))
        compose.onNodeWithTag("drawer-session-d079-s02").assertIsDisplayed()
        list.performScrollToNode(hasText("查看全部 12 条"))
        compose.onNodeWithText("查看全部 12 条").performClick()
        list.performScrollToNode(hasTestTag("drawer-session-d079-s11"))
        compose.onNodeWithText("d079-s11").performClick()
        assertEquals(listOf("drawer-scroll" to "d079-s11"), opened)
        list.performScrollToIndex(0)
        compose.onNodeWithText("d000").performClick()
        list.performScrollToNode(hasTestTag("drawer-session-d000-s02"))
        compose.onNodeWithTag("drawer-session-d000-s02").assertIsDisplayed()
        compose.onNodeWithTag("drawer-session-d000-s11").assertDoesNotExist()
    }
}
