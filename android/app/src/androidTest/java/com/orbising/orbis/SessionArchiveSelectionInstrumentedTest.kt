package com.orbising.orbis

import androidx.activity.OnBackPressedDispatcher
import androidx.activity.compose.LocalOnBackPressedDispatcherOwner
import androidx.compose.runtime.*
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

class SessionArchiveSelectionInstrumentedTest {
    @get:Rule val compose = createComposeRule()

    private fun session(id: String) = SessionCatalogEntry(
        sessionId = id, name = id, cwd = "/repo", agentKind = "codex", archived = false,
    )

    private fun state() = RemoteState(hostId = "host", e2eReady = true,
        sessions = listOf("one", "two", "three").associateWith(::session))

    private fun host(state: RemoteState) = HostSnapshot(
        HostPairing(state.hostId!!, "Test Host", "test-public", "test-root",
            relayUrl = "wss://relay.example", deviceId = "test-device", credential = "test-only"), state,
    )

    @Test fun longPressArchivesAndRestoresOnlyCheckedSessions() {
        var state by mutableStateOf(state())
        val opened = mutableListOf<String>()
        val archived = mutableListOf<Triple<String, String, Boolean>>()
        compose.setContent { OrbisTheme {
            SessionDrawer(state, listOf(host(state)), {}, {}, {},
                onOpenSession = { _, id -> opened += id }, onOpenHistory = { _, id -> opened += id },
                onNewSession = { _, _ -> },
                onSetArchived = { hostId, id, value ->
                    archived += Triple(hostId, id, value)
                    state = state.copy(sessions = state.sessions + (id to state.sessions.getValue(id).copy(archived = value)))
                })
        } }
        compose.onNodeWithContentDescription("会话操作").assertDoesNotExist()
        val originalBounds = compose.onNodeWithTag("drawer-session-one").fetchSemanticsNode().boundsInRoot
        compose.onNodeWithTag("drawer-session-one").performTouchInput { longClick() }
        compose.waitForIdle()
        assertEquals(originalBounds, compose.onNodeWithTag("drawer-session-one").fetchSemanticsNode().boundsInRoot)
        compose.onNodeWithText("已选择 1 项").assertIsDisplayed()
        compose.onNodeWithTag("drawer-session-two").performClick()
        compose.onNodeWithText("已选择 2 项").assertIsDisplayed()
        compose.onNodeWithTag("drawer-session-one").performClick()
        compose.onNodeWithText("已选择 1 项").assertIsDisplayed()
        compose.onNodeWithTag("drawer-session-one").performClick()
        compose.onNodeWithContentDescription("归档选中会话").performClick()
        compose.onNodeWithTag("drawer-session-one").assertDoesNotExist()
        compose.onNodeWithTag("drawer-session-two").assertDoesNotExist()
        compose.onNodeWithTag("drawer-session-three").assertIsDisplayed()
        compose.runOnIdle {
            assertTrue(opened.isEmpty())
            assertEquals(setOf(Triple("host", "one", true), Triple("host", "two", true)), archived.toSet())
        }
        compose.onNodeWithContentDescription("筛选会话：全部").performClick()
        compose.onNodeWithText("查看已归档会话").performClick()
        compose.onNodeWithTag("drawer-session-one").performTouchInput { longClick() }
        compose.onNodeWithTag("drawer-session-two").performClick()
        compose.onNodeWithContentDescription("恢复选中会话").performClick()
        compose.onNodeWithText("没有已归档的会话").assertIsDisplayed()
        compose.runOnIdle {
            assertEquals(4, archived.size)
            assertTrue(state.sessions.values.all { it.archived == false })
        }
    }

    @Test fun busyPendingAndDisconnectedSelectionsCannotBeArchived() {
        var state by mutableStateOf(state().copy(runtimes = mapOf(
            "runtime" to RuntimeSummary("runtime", "one", "/repo", "working", sessionId = "one", agentKind = "codex"))))
        var requests = 0
        compose.setContent { OrbisTheme {
            SessionDrawer(state, listOf(host(state)), {}, {}, {}, { _, _ -> }, { _, _ -> }, { _, _ -> },
                onSetArchived = { _, _, _ -> requests++ })
        } }
        compose.onNodeWithTag("drawer-session-one").performTouchInput { longClick() }
        compose.onNodeWithTag("drawer-session-two").performClick()
        compose.onNodeWithContentDescription("归档选中会话").assertIsNotEnabled()
        compose.onNodeWithText("等待任务完成后归档").assertIsDisplayed()
        compose.runOnIdle { state = state.copy(runtimes = emptyMap()) }
        compose.onNodeWithContentDescription("归档选中会话").assertIsEnabled()
        compose.runOnIdle { state = state.copy(sessionArchiveRequests = mapOf("request" to "two")) }
        compose.onNodeWithContentDescription("归档选中会话").assertIsNotEnabled()
        compose.runOnIdle { state = state.copy(sessionArchiveRequests = emptyMap(), e2eReady = false) }
        compose.onNodeWithContentDescription("归档选中会话").assertIsNotEnabled()
        compose.runOnIdle { assertEquals(0, requests) }
    }

    @Test fun selectionClearsOnBackSearchHostSwitchAndDrawerClose() {
        var state by mutableStateOf(state())
        var isOpen by mutableStateOf(true)
        var dispatcher: OnBackPressedDispatcher? = null
        compose.setContent {
            dispatcher = LocalOnBackPressedDispatcherOwner.current?.onBackPressedDispatcher
            OrbisTheme {
                SessionDrawer(state, listOf(host(state)), {}, {}, {}, { _, _ -> }, { _, _ -> }, { _, _ -> },
                    onSetArchived = { _, _, _ -> }, isOpen = isOpen)
            }
        }
        fun select() = compose.onNodeWithTag("drawer-session-one").performTouchInput { longClick() }
        fun assertCleared() = compose.onNodeWithContentDescription("退出多选").assertDoesNotExist()
        select()
        compose.onNodeWithContentDescription("退出多选").performClick()
        assertCleared()
        select()
        compose.runOnIdle { dispatcher!!.onBackPressed() }
        assertCleared()
        select()
        compose.onNode(hasSetTextAction()).performTextInput("one")
        assertCleared()
        compose.onNodeWithContentDescription("清除搜索").performClick()
        select()
        compose.runOnIdle { state = state.copy(hostId = "other-host") }
        assertCleared()
        select()
        compose.runOnIdle { isOpen = false }
        compose.runOnIdle { isOpen = true }
        assertCleared()
    }
}
