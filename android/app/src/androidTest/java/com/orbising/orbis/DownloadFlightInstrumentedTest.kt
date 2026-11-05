package com.orbising.orbis

import android.animation.ValueAnimator
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material3.Button
import androidx.compose.material3.Text
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.unit.dp
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Rule
import org.junit.Test

/** ADR-0058 M16: a queued download flies from the tap to the page's download button. */
class DownloadFlightInstrumentedTest {
    @get:Rule val compose = createComposeRule()

    @Test fun aQueuedDownloadFliesFromTheTapToTheButtonWithoutTakingTouches() {
        assumeTrue("system animations are off; flights are skipped by design", ValueAnimator.areAnimatorsEnabled())
        lateinit var flight: DownloadFlight
        var queued = true
        var underneath = 0
        compose.setContent {
            OrbisTheme {
                flight = rememberDownloadFlight()
                DownloadFlightHost(flight) {
                    Box(Modifier.fillMaxSize()) {
                        DownloadStatusButton(activeCount = 0, enabled = true, onClick = {},
                            modifier = Modifier.align(Alignment.TopEnd).padding(8.dp).testTag("target").downloadFlightTarget(flight))
                        Button(onClick = { if (queued) flight.launch() }, Modifier.align(Alignment.Center).testTag("file")) { Text("report.pdf") }
                        Button(onClick = { underneath++ }, Modifier.align(Alignment.BottomCenter).size(120.dp, 56.dp).testTag("under")) { Text("under") }
                    }
                }
            }
        }
        compose.mainClock.autoAdvance = false
        val file = compose.onNodeWithTag("file").fetchSemanticsNode().boundsInRoot
        val target = compose.onNodeWithTag("target").fetchSemanticsNode().boundsInRoot
        compose.onNodeWithTag("file").performTouchInput { click(Offset(width * 0.3f, height * 0.5f)) }
        compose.mainClock.advanceTimeByFrame()
        assertEquals(1, flight.flights.size)
        val flying = flight.flights.single()
        assertEquals(file.left + file.width * 0.3f, flying.from.x, 2f)
        assertEquals(file.center.y, flying.from.y, 2f)
        assertEquals(target.center.x, flying.to.x, 4f)
        assertEquals(target.center.y, flying.to.y, 4f)
        compose.mainClock.advanceTimeBy(DownloadFlight.DURATION_MS / 2L)
        capture("download-flight-midway")
        // Flights never take touches from what is beneath them.
        compose.onNodeWithTag("under").performClick()
        compose.mainClock.advanceTimeByFrame()
        assertEquals(1, underneath)
        compose.mainClock.advanceTimeBy(DownloadFlight.DURATION_MS + 400L)
        assertTrue(flight.flights.isEmpty())
        // At most three at once; the rest only pop the button.
        repeat(5) { compose.onNodeWithTag("file").performClick() }
        compose.mainClock.advanceTimeByFrame()
        assertEquals(DownloadFlight.MAX_FLIGHTS, flight.flights.size)
        compose.mainClock.advanceTimeBy(DownloadFlight.DURATION_MS + 400L)
        // Nothing was queued: nothing flies.
        queued = false
        compose.onNodeWithTag("file").performClick()
        compose.mainClock.advanceTimeByFrame()
        assertTrue(flight.flights.isEmpty())
        compose.mainClock.autoAdvance = true
    }

    private fun capture(name: String) {
        val context = androidx.test.platform.app.InstrumentationRegistry.getInstrumentation().targetContext
        val directory = java.io.File(context.getExternalFilesDir(null), "r15").apply { mkdirs() }
        java.io.File(directory, "$name.png").outputStream().use {
            compose.onRoot().captureToImage().asAndroidBitmap().compress(android.graphics.Bitmap.CompressFormat.PNG, 100, it)
        }
    }
}
