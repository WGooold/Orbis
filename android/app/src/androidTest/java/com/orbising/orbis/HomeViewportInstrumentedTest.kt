package com.orbising.orbis

import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test

/** ADR-0053 §3 / V21 and §6 / M15: the home list is never pushed away, and it refreshes by pulling. */
class HomeViewportInstrumentedTest {
    @get:Rule val compose = createComposeRule()
    private val pairing = HostPairing("host", "Test Host", "test-public", "test-root",
        relayUrl = "wss://relay.example", deviceId = "test-device", credential = "test-only")
    private val cards = (0 until 12).map { "c%02d".format(it) }
    private val state = mutableStateOf(home(cards))
    private var refreshes = 0

    /** Newest first: the first id gets the latest modification time. */
    private fun home(order: List<String>): RemoteState {
        val runtimes = order.associateWith { RuntimeSummary(it, it, "/repo", "idle", sessionId = it, agentKind = "pi",
            domainAvailability = mapOf("identity" to "ready", "execution" to "ready", "interactions" to "ready")) }
        val sessions = order.withIndex().associate { (index, id) -> id to SessionCatalogEntry(id, name = id, modifiedAt = 10_000L - index) }
        return RemoteState(hostId = "host", e2eReady = true, runtimes = runtimes, sessions = sessions).withReadyHomeFixture()
    }

    private fun show() {
        compose.setContent {
            OrbisTheme {
                RuntimeListScreen(state.value, listOf(HostSnapshot(pairing, state.value)),
                    onOpenRuntime = { _, _ -> }, onCloseRuntimes = { _, _ -> emptySet() }, onOpenDownloads = {}, onUnpairHost = {},
                    onOpenSession = { _, _ -> }, onOpenHistory = { _, _ -> }, onNewSession = { _, _ -> },
                    onSetArchived = { _, _, _ -> }, onSelectHost = {}, onAddHost = {}, onOpenStatus = {}, onRequestProviders = {},
                    onRetryHome = { refreshes++ })
            }
        }
        compose.waitForIdle()
    }

    private fun top(id: String) = compose.onNodeWithTag("home-runtime-$id").fetchSemanticsNode().boundsInRoot.top

    @Test fun atTheTopANewOrPromotedSessionStaysInView() {
        show()
        val firstTop = top("c00")
        compose.runOnIdle { state.value = home(listOf("new") + cards) }
        compose.onNodeWithTag("home-runtime-new").assertIsDisplayed()
        assertEquals(firstTop, top("new"), 1f)
        compose.runOnIdle { state.value = home(listOf("c07", "new") + cards.filter { it != "c07" }) }
        compose.onNodeWithTag("home-runtime-c07").assertIsDisplayed()
        assertEquals(firstTop, top("c07"), 1f)
    }

    @Test fun scrolledCardsStayPutWhenOthersMoveAboveThem() {
        show()
        compose.onNodeWithTag("home-session-list").performScrollToIndex(5)
        compose.waitForIdle()
        val anchor = top("c05")
        val next = top("c06")
        // A card from below jumps to the top: the cards in view keep their screen positions.
        compose.runOnIdle { state.value = home(listOf("c10") + cards.filter { it != "c10" }) }
        compose.waitForIdle()
        assertEquals(anchor, top("c05"), 1f)
        assertEquals(next, top("c06"), 1f)
        // A brand-new session above does the same.
        compose.runOnIdle { state.value = home(listOf("new", "c10") + cards.filter { it != "c10" }) }
        compose.waitForIdle()
        assertEquals(anchor, top("c05"), 1f)
    }

    @Test fun theFirstVisibleCardMovingAwayKeepsThePixelPosition() {
        show()
        compose.onNodeWithTag("home-session-list").performScrollToIndex(5)
        compose.waitForIdle()
        val anchor = top("c05")
        val next = top("c06")
        // The first visible card itself had activity and moved to the top: the viewport does not follow
        // it; its slot is taken by the card that was above it and the cards below stay put.
        compose.runOnIdle { state.value = home(listOf("c05") + cards.filter { it != "c05" }) }
        compose.waitForIdle()
        assertEquals(anchor, top("c04"), 1f)
        assertEquals(next, top("c06"), 1f)
    }

    @Test fun pullingAtTheTopRefreshesOnceWithoutMovingTheCards() {
        show()
        val before = top("c00")
        compose.onNodeWithTag("home-session-list").performTouchInput {
            swipeDown(startY = top + 20f, endY = top + 20f + height * 0.6f, durationMillis = 500)
        }
        compose.waitForIdle()
        assertEquals(1, refreshes)
        assertEquals(before, top("c00"), 1f)
        // Away from the top the same gesture only scrolls.
        compose.onNodeWithTag("home-session-list").performScrollToIndex(6)
        compose.waitForIdle()
        compose.onNodeWithTag("home-session-list").performTouchInput {
            swipeDown(startY = centerY - 100f, endY = centerY + 50f, durationMillis = 400)
        }
        compose.waitForIdle()
        assertEquals(1, refreshes)
        // While selecting, pulling does nothing.
        compose.onNodeWithTag("home-session-list").performScrollToIndex(0)
        compose.onNodeWithTag("home-runtime-c00").performTouchInput { longClick() }
        compose.onNodeWithText("已选择 1 项").assertIsDisplayed()
        compose.onNodeWithTag("home-session-list").performTouchInput {
            swipeDown(startY = top + 20f, endY = top + 20f + height * 0.6f, durationMillis = 500)
        }
        compose.waitForIdle()
        assertEquals(1, refreshes)
    }
}
