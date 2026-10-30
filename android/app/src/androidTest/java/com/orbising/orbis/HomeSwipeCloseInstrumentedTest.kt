package com.orbising.orbis

import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.graphics.toPixelMap
import androidx.compose.ui.hapticfeedback.HapticFeedback
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import kotlin.math.abs
import kotlin.math.roundToInt

class HomeSwipeCloseInstrumentedTest {
    @get:Rule val compose = createComposeRule()

    @Test fun shortSwipeReboundsAndEachGestureVibratesOnlyOnceBeforeClosingItsRuntime() {
        val pairing = HostPairing("host", "Test Host", "test-public", "test-root",
            relayUrl = "wss://relay.example", deviceId = "test-device", credential = "test-only")
        val state = RemoteState(hostId = "host", e2eReady = true,
            runtimes = listOf("one", "two").associateWith { RuntimeSummary(it, it, "/repo", "idle", sessionId = it, agentKind = "pi",
                domainAvailability = mapOf("identity" to "ready", "execution" to "ready", "interactions" to "ready")) })
        val haptics = mutableListOf<HapticFeedbackType>()
        val opened = mutableListOf<String>()
        val closed = mutableListOf<Pair<String, Set<String>>>()
        var density = 1f
        compose.setContent {
            density = LocalDensity.current.density
            CompositionLocalProvider(LocalHapticFeedback provides object : HapticFeedback {
                override fun performHapticFeedback(hapticFeedbackType: HapticFeedbackType) { haptics += hapticFeedbackType }
            }) {
                OrbisTheme {
                    RuntimeListScreen(state.withReadyHomeFixture(), listOf(HostSnapshot(pairing, state.withReadyHomeFixture())),
                        onOpenRuntime = { _, id -> opened += id },
                        onCloseRuntimes = { host, ids -> closed += host to ids; ids },
                        onOpenDownloads = {}, onUnpairHost = {},
                        onOpenSession = { _, _ -> }, onOpenHistory = { _, _ -> }, onNewSession = { _, _ -> },
                        onSetArchived = { _, _, _ -> }, onSelectHost = {}, onAddHost = {}, onOpenStatus = {}, onRequestProviders = {})
                }
            }
        }
        val card = compose.onNodeWithTag("home-runtime-one")
        val bounds = card.fetchSemanticsNode().boundsInRoot
        val cardWidth = bounds.width
        // The swipe wrapper must leave the card's raised shadow visible outside its bounds.
        val pixels = compose.onRoot().captureToImage().toPixelMap()
        val shadow = pixels[(bounds.right + 3 * density).roundToInt(), bounds.center.y.roundToInt()]
        val ground = pixels[(bounds.right + 12 * density).roundToInt(), bounds.center.y.roundToInt()]
        assertTrue("The swipe container clipped the card shadow", abs(shadow.luminance() - ground.luminance()) > 0.005f)

        // A rightward gesture that starts on the card belongs to the drawer, even after
        // the card's horizontal touch slop is crossed. A short pull should rebound.
        card.performTouchInput {
            swipe(Offset(width * 0.1f, center.y), Offset(width * 0.25f, center.y), durationMillis = 600)
        }
        compose.onNodeWithText("搜索目录或会话").assertIsNotDisplayed()
        compose.runOnIdle { assertTrue(opened.isEmpty()); assertTrue(closed.isEmpty()); assertTrue(haptics.isEmpty()) }
        card.performTouchInput {
            swipe(Offset(width * 0.1f, center.y), Offset(width * 0.9f, center.y), durationMillis = 400)
        }
        compose.onNodeWithText("搜索目录或会话").assertIsDisplayed()
        compose.runOnIdle { assertTrue(opened.isEmpty()); assertTrue(closed.isEmpty()); assertTrue(haptics.isEmpty()) }
        compose.onRoot().performTouchInput { click(Offset(width - 8f, center.y)) }
        compose.onNodeWithText("搜索目录或会话").assertIsNotDisplayed()

        // More than the former fixed threshold, but less than half of this card.
        card.performTouchInput { down(Offset(width * 0.85f, center.y)); moveBy(Offset(-cardWidth * 0.4f, 0f)) }
        compose.onNodeWithText("关闭").assertIsDisplayed()
        compose.runOnIdle { assertTrue(haptics.isEmpty()); assertTrue(closed.isEmpty()) }
        card.performTouchInput { up() }
        compose.waitForIdle()
        compose.runOnIdle { assertTrue(opened.isEmpty()); assertTrue(closed.isEmpty()) }

        // Cross, retreat and cross again during the same drag: one vibration, no close until release.
        card.performTouchInput { down(Offset(width * 0.85f, center.y)); moveBy(Offset(-cardWidth * 0.6f, 0f)) }
        compose.onNodeWithText("松手关闭").assertIsDisplayed()
        card.performTouchInput { moveBy(Offset(cardWidth * 0.3f, 0f)); moveBy(Offset(-cardWidth * 0.3f, 0f)) }
        compose.runOnIdle { assertEquals(1, haptics.size); assertTrue(closed.isEmpty()) }
        card.performTouchInput { moveBy(Offset(cardWidth * 0.3f, 0f)); up() }
        compose.waitForIdle()
        compose.runOnIdle { assertTrue(closed.isEmpty()) }

        // A fresh gesture must vibrate again even if a submitted close keeps the card visible.
        repeat(2) {
            card.performTouchInput { down(Offset(width * 0.85f, center.y)); moveBy(Offset(-cardWidth * 0.6f, 0f)); up() }
            compose.waitForIdle()
        }
        compose.runOnIdle {
            assertEquals(3, haptics.size)
            assertEquals(listOf("host" to setOf("one"), "host" to setOf("one")), closed)
            assertTrue(opened.isEmpty())
        }
        compose.onNodeWithTag("home-runtime-two").assertIsDisplayed()

        // Reversing an accepted left drag all the way past its start must not open the drawer.
        card.performTouchInput {
            down(Offset(width * 0.7f, center.y))
            moveBy(Offset(-cardWidth * 0.3f, 0f))
            moveBy(Offset(cardWidth * 0.5f, 0f))
            up()
        }
        compose.onNodeWithText("搜索目录或会话").assertIsNotDisplayed()
        compose.runOnIdle { assertEquals(2, closed.size); assertTrue(opened.isEmpty()) }
        card.performTouchInput { click() }
        compose.runOnIdle { assertEquals(listOf("one"), opened) }
    }
}
