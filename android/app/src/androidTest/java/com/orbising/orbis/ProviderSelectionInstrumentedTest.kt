package com.orbising.orbis

import androidx.compose.runtime.*
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test

class ProviderSelectionInstrumentedTest {
    @get:Rule val compose = createComposeRule()

    @Test fun longPressSelectionCanToggleCancelAndRemoveTogetherWithoutChangingEnableBehavior() {
        val providers = listOf(
            AgentProvider("a", "pi", "Official", true, true, true),
            AgentProvider("b", "pi", "Team", true, true),
            AgentProvider("c", "pi", "Disabled", false, true),
        )
        var state by mutableStateOf(RemoteState(hostId = "host-a", e2eReady = true, connection = RelayConnection.ONLINE,
            agentProviders = AgentProvidersState(kind = "pi", hostId = "host-a", providers = providers)))
        var removed = emptyList<AgentProvider>()
        var enabled: AgentProvider? = null
        compose.setContent {
            OrbisTheme {
                AgentProvidersContent(state, {}, {}, { provider, _ -> enabled = provider }, { values, host ->
                    assertEquals("host-a", host); removed = values
                })
            }
        }
        compose.onNodeWithContentDescription("移除所选供应商").assertDoesNotExist()
        compose.onNodeWithText("移除", substring = false).assertDoesNotExist()
        compose.onNodeWithTag("provider-card-c").performTouchInput { longClick() }
        compose.onNodeWithContentDescription("移除所选供应商").assertDoesNotExist()
        compose.onNodeWithText("启用", substring = false).performClick()
        compose.onNodeWithText("确认").performClick()
        compose.runOnIdle { assertEquals(providers[2], enabled) }
        val originalBounds = compose.onNodeWithTag("provider-card-a").fetchSemanticsNode().boundsInRoot
        compose.onNodeWithTag("provider-card-a").performTouchInput { longClick() }
        compose.waitForIdle()
        assertEquals(originalBounds, compose.onNodeWithTag("provider-card-a").fetchSemanticsNode().boundsInRoot)
        compose.onNodeWithText("已选择 1 项").assertIsDisplayed()
        compose.onNodeWithTag("provider-card-a").performTouchInput { click() }
        compose.onNodeWithText("已选择 0 项").assertIsDisplayed()
        compose.onNodeWithContentDescription("移除所选供应商").assertIsNotEnabled()
        compose.onNodeWithTag("provider-card-a").performTouchInput { click() }
        compose.onNodeWithTag("provider-card-b").performTouchInput { click() }
        compose.onNodeWithText("已选择 2 项").assertIsDisplayed()
        compose.onNodeWithTag("provider-card-b").performTouchInput { click() }
        compose.onNodeWithText("已选择 1 项").assertIsDisplayed()
        compose.onNodeWithContentDescription("退出多选").performClick()
        compose.onNodeWithContentDescription("移除所选供应商").assertDoesNotExist()
        compose.onNodeWithTag("provider-card-a").performTouchInput { longClick() }
        compose.onNodeWithTag("provider-card-b").performTouchInput { click() }
        compose.onNodeWithContentDescription("移除所选供应商").performClick()
        compose.onNodeWithText("全局默认供应商", substring = true).assertIsDisplayed()
        compose.onNodeWithText("取消").performClick()
        compose.runOnIdle { assertTrue(removed.isEmpty()) }
        compose.onNodeWithText("已选择 2 项").assertIsDisplayed()
        compose.onNodeWithContentDescription("移除所选供应商").performClick()
        compose.onNodeWithText("移除 2 项").performClick()
        compose.runOnIdle { assertEquals(providers.take(2), removed) }
        compose.onNodeWithContentDescription("移除所选供应商").assertDoesNotExist()
        compose.onNodeWithTag("provider-card-a").performTouchInput { longClick() }
        compose.onNodeWithText("Codex", substring = false).performClick()
        compose.onNodeWithContentDescription("移除所选供应商").assertDoesNotExist()
        compose.onNodeWithTag("provider-card-a").performTouchInput { longClick() }
        compose.runOnIdle { state = state.copy(e2eReady = false) }
        compose.onNodeWithContentDescription("移除所选供应商").assertDoesNotExist()
        compose.runOnIdle { state = state.copy(e2eReady = true) }
        compose.onNodeWithTag("provider-card-a").performTouchInput { longClick() }
        compose.runOnIdle { state = state.copy(hostId = "host-b") }
        compose.onNodeWithContentDescription("移除所选供应商").assertDoesNotExist()
    }
}
