package com.orbising.orbis

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.graphics.toPixelMap
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import kotlin.math.abs

/** Real home cards and navigation with outstanding reads, without a Host or user pairing. */
class HomeNavigationInstrumentedTest {
    @get:Rule val compose = createComposeRule()
    private val opened = mutableListOf<String>()
    private var mounts = 0
    private var disposals = 0

    private fun showHome() {
        val pairing = HostPairing("host", "Test Host", "test-public", "test-root",
            relayUrl = "wss://relay.example", deviceId = "test-device", credential = "test-only")
        val state = RemoteState(hostId = "host", e2eReady = true,
            sessionListRequests = setOf("still-loading"), sessionSyncRequests = setOf("one", "two"),
            runtimes = listOf("one", "two").associateWith { RuntimeSummary(it, it, "/repo", "idle", sessionId = it, agentKind = "pi",
                domainAvailability = mapOf("identity" to "ready", "execution" to "ready", "interactions" to "ready")) })
        val selected = mutableStateOf<String?>(null)
        compose.setContent {
            OrbisTheme {
                SwipeBackLayer(open = selected.value != null, onBack = { selected.value = null }, underlay = {
                    DisposableEffect(Unit) { mounts++; onDispose { disposals++ } }
                    RuntimeListScreen(state, listOf(HostSnapshot(pairing, state)),
                        onOpenRuntime = { _, id -> opened += id; selected.value = id },
                        onCloseRuntimes = { _, _ -> emptySet() }, onOpenDownloads = {}, onUnpairHost = {},
                        onOpenSession = { _, _ -> }, onOpenHistory = { _, _ -> }, onNewSession = { _, _ -> },
                        onSetArchived = { _, _, _ -> }, onSelectHost = {}, onAddHost = {}, onOpenStatus = {}, onRequestProviders = {})
                }) {
                    Box(Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background)) { Text("Loading chat") }
                }
            }
        }
        compose.waitForIdle()
        compose.mainClock.autoAdvance = false
    }

    private fun cardLuminance(): Float {
        val pixels = compose.onNodeWithTag("home-runtime-one").captureToImage().toPixelMap()
        return pixels[(pixels.width * 0.9f).toInt(), pixels.height / 2].luminance()
    }

    @Test fun quickTapDrawsPressedCardBeforeOpeningOnce() {
        showHome()
        val resting = cardLuminance()
        val card = compose.onNodeWithTag("home-runtime-one")
        card.performTouchInput { click() }
        compose.runOnIdle { assertTrue("Navigation must allow the pressed frame to draw", opened.isEmpty()) }
        compose.mainClock.advanceTimeByFrame()
        assertTrue("A quick tap must visibly depress the card", abs(cardLuminance() - resting) > 0.01f)
        // A second tap in the same feedback window must not enqueue a second navigation.
        card.performTouchInput { click() }
        compose.mainClock.advanceTimeBy(80)
        compose.runOnIdle { assertEquals(listOf("one"), opened) }
    }

    @Test fun pointerDownRespondsBeforeScrollPressDelayAndCancelDoesNotNavigate() {
        showHome()
        val resting = cardLuminance()
        val card = compose.onNodeWithTag("home-runtime-one")
        card.performTouchInput { down(center) }
        compose.mainClock.advanceTimeByFrame()
        assertTrue("Press feedback must not wait for LazyColumn's tap delay", abs(cardLuminance() - resting) > 0.01f)
        card.performTouchInput { cancel() }
        compose.mainClock.advanceTimeBy(80)
        assertEquals(resting, cardLuminance(), 0.005f)
        compose.runOnIdle { assertTrue(opened.isEmpty()) }
    }

    @Test fun returningHomeAcceptsAnotherCardWhileReadsAreStillPending() {
        showHome()
        repeat(2) { index ->
            val id = if (index == 0) "one" else "two"
            compose.onNodeWithTag("home-runtime-$id").performTouchInput { click() }
            compose.mainClock.advanceTimeBy(120)
            compose.runOnIdle { assertEquals(index + 1, opened.size); assertEquals(id, opened.last()) }
            // Interrupt entry rather than waiting for either its animation or remote reads.
            compose.onRoot().performTouchInput {
                down(Offset(width * 0.1f, height * 0.5f))
                moveTo(Offset(width * 0.85f, height * 0.5f), 300)
                up()
            }
            compose.mainClock.advanceTimeBy(250)
            compose.onNodeWithTag("home-runtime-two").assertIsDisplayed()
            compose.runOnIdle {
                assertEquals("Returning must reuse the existing home", 1, mounts)
                assertEquals(0, disposals)
            }
        }
    }
}
