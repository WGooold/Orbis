package com.orbising.orbis

import androidx.compose.runtime.*
import androidx.compose.ui.hapticfeedback.HapticFeedback
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

class HomeSelectionInstrumentedTest {
    @get:Rule val compose = createComposeRule()

    @Test fun longPressSelectsWithHapticAndClosesOnlyCheckedSessions() {
        val pairing = HostPairing("host", "Test Host", "test-public", "test-root",
            relayUrl = "wss://relay.example", deviceId = "test-device", credential = "test-only")
        var state by mutableStateOf(RemoteState(hostId = "host", e2eReady = true,
            runtimes = listOf("one", "two", "three").associateWith { RuntimeSummary(it, it, "/repo", "idle", sessionId = it, agentKind = "pi",
                domainAvailability = mapOf("identity" to "ready", "execution" to "ready", "interactions" to "ready")) }))
        val haptics = mutableListOf<HapticFeedbackType>()
        val opened = mutableListOf<String>()
        val closed = mutableListOf<Set<String>>()
        compose.setContent {
            CompositionLocalProvider(LocalHapticFeedback provides object : HapticFeedback {
                override fun performHapticFeedback(hapticFeedbackType: HapticFeedbackType) { haptics += hapticFeedbackType }
            }) {
                OrbisTheme {
                    RuntimeListScreen(state, listOf(HostSnapshot(pairing, state)),
                        onOpenRuntime = { _, id -> opened += id },
                        onCloseRuntimes = { host, ids ->
                            assertEquals("host", host); closed += ids
                            state = state.copy(runtimes = state.runtimes - ids)
                            ids
                        },
                        onOpenDownloads = {}, onUnpairHost = {},
                        onOpenSession = { _, _ -> }, onOpenHistory = { _, _ -> }, onNewSession = { _, _ -> },
                        onSetArchived = { _, _, _ -> }, onSelectHost = {}, onAddHost = {}, onOpenStatus = {}, onRequestProviders = {})
                }
            }
        }
        compose.onNodeWithTag("home-runtime-one").performTouchInput { longClick() }
        compose.onNodeWithText("已选择 1 项").assertIsDisplayed()
        compose.onNodeWithTag("home-runtime-two").performClick()
        compose.onNodeWithText("已选择 2 项").assertIsDisplayed()
        compose.onNodeWithTag("home-runtime-two").performClick()
        compose.onNodeWithText("已选择 1 项").assertIsDisplayed()
        compose.runOnIdle {
            assertTrue(opened.isEmpty())
            assertEquals(listOf(HapticFeedbackType.LongPress), haptics)
        }
        compose.onNodeWithTag("home-runtime-two").performClick()
        compose.onNodeWithContentDescription("关闭选中会话").performClick()
        compose.onNodeWithTag("home-runtime-one").assertDoesNotExist()
        compose.onNodeWithTag("home-runtime-two").assertDoesNotExist()
        compose.onNodeWithTag("home-runtime-three").performClick()
        compose.runOnIdle { assertEquals(listOf(setOf("one", "two")), closed); assertEquals(listOf("three"), opened) }
        compose.onNodeWithTag("home-runtime-three").performTouchInput { longClick() }
        compose.onNodeWithContentDescription("退出多选").performClick()
        compose.onNodeWithContentDescription("打开会话目录").assertIsDisplayed()
    }
}
