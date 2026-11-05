// Orbis 测试用途（场景与判定见本文件断言）：
// - MOT-14 / SC36（MOT-14、SC36、R48、M22、V21）
// - r15 首页 / 目录视口与下拉刷新（M15、V21）
package com.orbising.orbis

import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test

/** V21: the directory catalog obeys the same viewport contract as home. */
class SessionDrawerViewportInstrumentedTest {
    @get:Rule val compose = createComposeRule()
    private val ids = (0..15).map { "d%02d".format(it) }
    private val state = mutableStateOf(catalog(ids))
    private fun catalog(order: List<String>, oneDirectory: Boolean = false) = RemoteState(
        hostId = "viewport-host", e2eReady = true,
        sessions = order.withIndex().associate { (index, id) -> id to SessionCatalogEntry(
            sessionId = id, name = id, cwd = if (oneDirectory) "/repo" else "/$id",
            agentKind = "pi", modifiedAt = 10000L - index,
        ) },
    )
    private fun show(oneDirectory: Boolean = false) {
        state.value = catalog(ids, oneDirectory)
        compose.setContent {
            OrbisTheme {
                val host = HostSnapshot(HostPairing("viewport-host", "Fixture", "public", "root",
                    relayUrl = "wss://relay.example", deviceId = "fixture-device", credential = "fixture"), state.value)
                SessionDrawer(state.value, listOf(host), {}, {}, {}, { _, _ -> }, { _, _ -> }, { _, _ -> }, { _, _, _ -> })
            }
        }
    }
    private fun y(tag: String) = compose.onNodeWithTag(tag).fetchSemanticsNode().boundsInRoot.top

    @Test fun aNewDirectoryAtTheTopRemainsVisible() {
        show()
        val before = y("drawer-directory-/d00")
        compose.runOnIdle { state.value = catalog(listOf("new") + ids) }
        compose.onNodeWithTag("drawer-directory-/new").assertIsDisplayed()
        assertEquals(before, y("drawer-directory-/new"), 1f)
    }

    @Test fun aScrolledDirectoryDoesNotFollowItsOwnPromotion() {
        show()
        compose.onNodeWithTag("drawer-session-list").performScrollToIndex(18)
        val before = y("drawer-directory-/d07")
        compose.runOnIdle { state.value = catalog(listOf("d06") + ids.filter { it != "d06" }) }
        assertEquals(before, y("drawer-directory-/d07"), 1f)
        compose.runOnIdle { state.value = catalog(listOf("new", "d06") + ids.filter { it != "d06" }) }
        assertEquals(before, y("drawer-directory-/d07"), 1f)
    }

    @Test fun sessionsWithinTheExpandedDirectoryRetainTheirReadingAnchor() {
        show(oneDirectory = true)
        compose.onNodeWithText("再显示 11 个会话").performScrollTo().performClick()
        compose.onNodeWithTag("drawer-session-list").performScrollToIndex(7)
        val before = y("drawer-session-d07")
        compose.runOnIdle { state.value = catalog(listOf("d06") + ids.filter { it != "d06" }, oneDirectory = true) }
        assertEquals(before, y("drawer-session-d07"), 1f)
    }
}
