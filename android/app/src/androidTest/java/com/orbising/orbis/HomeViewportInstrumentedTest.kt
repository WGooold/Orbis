// Orbis 测试用途（场景与判定见本文件断言）：
// - r15 首页 / 目录视口与下拉刷新（M15、V21）
package com.orbising.orbis

import android.graphics.Bitmap
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

/** ADR-0046 V21 / ADR-0058 M15: the home list is never pushed away, and it refreshes by pulling. */
class HomeViewportInstrumentedTest {
    @get:Rule val compose = createComposeRule()
    private val pairing = HostPairing("host", "Test Host", "test-public", "test-root",
        relayUrl = "wss://relay.example", deviceId = "test-device", credential = "test-only")
    private val cards = (0 until 12).map { "c%02d".format(it) }
    private val state = mutableStateOf(home(cards))
    private var refreshes = 0
    private val opened = mutableListOf<String>()

    /** Newest first: the first id gets the latest modification time. */
    private fun home(order: List<String>): RemoteState {
        val runtimes = order.associateWith { RuntimeSummary(it, it, "/repo", "idle", sessionId = it, agentKind = "pi",
            domainAvailability = mapOf("identity" to "ready", "execution" to "ready", "interactions" to "ready")) }
        val sessions = order.withIndex().associate { (index, id) -> id to SessionCatalogEntry(id, name = id, modifiedAt = 10_000L - index) }
        return RemoteState(hostId = "host", e2eReady = true, runtimes = runtimes, sessions = sessions).withReadyHomeFixture()
    }

    private fun show(darkTheme: Boolean = false) {
        compose.setContent {
            OrbisTheme(darkTheme = darkTheme) {
                RuntimeListScreen(state.value, listOf(HostSnapshot(pairing, state.value)),
                    onOpenRuntime = { _, id -> opened += id }, onCloseRuntimes = { _, _ -> emptySet() }, onOpenDownloads = {}, onUnpairHost = {},
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

    @Test fun pullingAtTheTopMovesTheListAndRestoresItsPositionAfterRefresh() {
        show()
        val list = compose.onNodeWithTag("home-session-list")
        val before = top("c00")
        val stateBeforeRefresh = state.value
        list.performTouchInput {
            val x = width / 2f
            down(Offset(x, top + 20f))
            moveTo(Offset(x, top + height * 0.6f), delayMillis = 500)
        }
        compose.waitForIdle()
        val pulled = top("c00")
        assertTrue("The whole session list follows the pull gesture", pulled > before + 20f)
        compose.runOnIdle { assertEquals("Refresh fires on release", 0, refreshes) }
        capturePull("pulling-during-refresh")
        list.performTouchInput { up() }
        compose.waitForIdle()
        assertEquals(1, refreshes)
        compose.runOnIdle {
            assertEquals("The indicator reset does not wait for sync state", stateBeforeRefresh, state.value)
        }
        assertEquals("The list returns to its original viewport", before, top("c00"), 1f)
        compose.onNodeWithTag("home-runtime-c00").performTouchInput { click() }
        compose.runOnIdle { assertEquals(listOf("c00"), opened) }
        // A vertical pull must not leave a transformed hit region that steals horizontal gestures.
        compose.onNodeWithTag("home-runtime-c00").performTouchInput {
            swipe(Offset(width * 0.1f, center.y), Offset(width * 0.9f, center.y), durationMillis = 400)
        }
        compose.onNodeWithText("搜索目录或会话").assertIsDisplayed()
        compose.onRoot().performTouchInput { click(Offset(width - 8f, center.y)) }
        compose.onNodeWithTag("home-runtime-c00").performTouchInput {
            swipe(Offset(width * 0.9f, center.y), Offset(width * 0.5f, center.y), durationMillis = 400)
        }
        compose.onNodeWithTag("home-runtime-c00").assertIsDisplayed()
        assertEquals(1, refreshes)
        // Away from the top the same gesture only scrolls.
        list.performScrollToIndex(6)
        compose.waitForIdle()
        list.performTouchInput {
            swipeDown(startY = centerY - 100f, endY = centerY + 50f, durationMillis = 400)
        }
        compose.waitForIdle()
        assertEquals(1, refreshes)
        // While selecting, pulling does nothing.
        list.performScrollToIndex(0)
        compose.onNodeWithTag("home-runtime-c00").performTouchInput { longClick() }
        compose.onNodeWithText("已选择 1 项").assertIsDisplayed()
        list.performTouchInput {
            swipeDown(startY = top + 20f, endY = top + 20f + height * 0.6f, durationMillis = 500)
        }
        compose.waitForIdle()
        assertEquals(1, refreshes)
    }

    @Test fun darkThemePullMovesAndRestoresTheWholeList() {
        show(darkTheme = true)
        val list = compose.onNodeWithTag("home-session-list")
        val before = top("c00")
        list.performTouchInput {
            val x = width / 2f
            down(Offset(x, top + 20f))
            moveTo(Offset(x, top + height * 0.6f), delayMillis = 500)
        }
        compose.waitForIdle()
        assertTrue("The whole session list follows the pull gesture in dark mode", top("c00") > before + 20f)
        capturePull("dark-pulling-during-refresh")
        list.performTouchInput { up() }
        compose.waitForIdle()
        assertEquals(1, refreshes)
        assertEquals("The dark-mode list returns to its original viewport", before, top("c00"), 1f)
    }

    private fun capturePull(name: String) {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val directory = File(context.getExternalFilesDir(null), "home-pull-refresh").apply { mkdirs() }
        File(directory, "$name.png").outputStream().use {
            compose.onRoot().captureToImage().asAndroidBitmap().compress(Bitmap.CompressFormat.PNG, 100, it)
        }
    }

    @Test fun catalogChangesWaitForTheReadersDragToFinish() {
        show()
        val list = compose.onNodeWithTag("home-session-list")
        list.performScrollToIndex(5)
        list.performTouchInput { down(center); moveBy(Offset(0f, -50f)); advanceEventTime(50) }
        val before = top("c06")
        compose.runOnIdle { state.value = home(listOf("c05") + cards.filter { it != "c05" }) }
        assertEquals("No repositioning while the pointer is held", before, top("c06"), 1f)
        list.performTouchInput { moveBy(Offset(0f, -40f)); advanceEventTime(200); up() }
        compose.waitForIdle()
        org.junit.Assert.assertTrue("The native drag still consumes movement", top("c06") < before - 20f)
    }
}
