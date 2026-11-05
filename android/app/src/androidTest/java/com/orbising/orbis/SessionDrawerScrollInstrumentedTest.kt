package com.orbising.orbis

import android.graphics.Bitmap
import android.os.Handler
import android.os.HandlerThread
import android.view.FrameMetrics
import android.view.Window
import androidx.activity.ComponentActivity
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import java.util.Collections
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test

/** S19 / V21: exercise real drags through a large catalog, including recycled closed branches. */
class SessionDrawerScrollInstrumentedTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    @Test fun longCatalogScrollsAndReopensDirectoriesInLight() = exercise(false)
    @Test fun longCatalogScrollsAndReopensDirectoriesInDark() = exercise(true)

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
        capture("top")
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
        list.performScrollToNode(hasTestTag("drawer-session-d079-s04"))
        compose.onNodeWithTag("drawer-session-d079-s04").assertIsDisplayed()
        list.performScrollToNode(hasText("再显示 7 个会话"))
        compose.onNodeWithText("再显示 7 个会话").performClick()
        list.performScrollToNode(hasTestTag("drawer-session-d079-s11"))
        compose.onNodeWithText("d079-s11").performClick()
        assertEquals(listOf("drawer-scroll" to "d079-s11"), opened)
        list.performScrollToIndex(0)
        compose.onNodeWithText("d000").performClick()
        list.performScrollToNode(hasTestTag("drawer-session-d000-s04"))
        compose.onNodeWithTag("drawer-session-d000-s04").assertIsDisplayed()
        compose.onNodeWithTag("drawer-session-d000-s11").assertDoesNotExist()
    }
}
