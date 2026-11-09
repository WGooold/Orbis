// Orbis 测试用途（场景与判定见本文件断言）：
// - Claude 后台子任务（S26、S17、S20、V05、V12、V16、V18、M03、M06、M10、M20）
package com.orbising.orbis

import androidx.compose.foundation.layout.Column
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

class BackgroundTasksInstrumentedTest {
    @get:Rule val compose = createComposeRule()

    @Test fun homeBlocksUnsupportedCloseAndClearsSelectionWhenBackgroundWorkStarts() {
        val pairing = HostPairing("host", "Test Host", "test-public", "test-root",
            relayUrl = "wss://relay.example", deviceId = "test-device", credential = "test-only")
        var tasks by mutableStateOf(BackgroundTaskInventory("ready",
            listOf(BackgroundTask("child", "检查代码", "Explore", "running")), false))
        val closed = mutableListOf<Set<String>>()
        val opened = mutableListOf<String>()
        compose.setContent {
            val state = RemoteState(hostId = "host", e2eReady = true, runtimes = mapOf("parent" to
                RuntimeSummary("parent", "Claude", "/repo", "idle", sessionId = "session", agentKind = "claude", backgroundTasks = tasks)))
                .withReadyHomeFixture()
            OrbisTheme {
                RuntimeListScreen(state, listOf(HostSnapshot(pairing, state)),
                    onOpenRuntime = { _, id -> opened += id }, onCloseRuntimes = { _, ids -> closed += ids; ids },
                    onOpenDownloads = {}, onUnpairHost = {}, onOpenSession = { _, _ -> }, onOpenHistory = { _, _ -> },
                    onNewSession = { _, _ -> }, onSetArchived = { _, _, _ -> }, onSelectHost = {}, onAddHost = {},
                    onOpenStatus = {}, onRequestProviders = {})
            }
        }
        val card = compose.onNodeWithTag("home-runtime-parent")
        compose.onNodeWithText("1 个子任务运行中").assertIsDisplayed()
        card.performTouchInput { swipeLeft() }
        card.assertIsDisplayed().assertIsNotSelected()
        compose.runOnIdle { assertTrue(closed.isEmpty()) }
        compose.runOnIdle { tasks = tasks.copy(items = tasks.items.map { it.copy(status = "completed") }) }
        card.performTouchInput { longClick() }
        card.assertIsSelected()
        compose.runOnIdle { tasks = tasks.copy(availability = "unknown") }
        card.assertIsNotSelected()
        card.performClick()
        compose.runOnIdle { assertEquals(listOf("parent"), opened); assertTrue(closed.isEmpty()) }
    }

    @Test fun backgroundInventoryUpdatesInPlaceWithoutClosingDisclosureOrChangingMainPhase() {
        var tasks by mutableStateOf(BackgroundTaskInventory("ready", listOf(
            BackgroundTask("a", "检查代码", "Explore", "running"),
            BackgroundTask("b", "检查代码", "general-purpose", "running", "a")), false))
        compose.setContent {
            OrbisTheme {
                val runtime = RuntimeSummary("parent", "Claude", "/repo", "idle", backgroundTasks = tasks)
                Column {
                    RuntimeStatusIndicator(runtime.presentationStatus, runtime.presentationTitle)
                    BackgroundTasksPanel(tasks)
                    Text("主回合：${runtime.status}")
                }
            }
        }
        compose.onNodeWithText("主回合：idle").assertIsDisplayed()
        compose.onNodeWithTag("background-tasks-toggle").performClick()
        compose.onNodeWithTag("background-task-a").assertIsDisplayed()
        compose.onNodeWithTag("background-task-b").assertIsDisplayed()
        compose.runOnIdle { tasks = tasks.copy(items = tasks.items.map { if (it.id == "a") it.copy(status = "completed") else it }) }
        compose.onNodeWithTag("background-task-a").assertIsDisplayed()
        compose.onNodeWithText("完成").assertIsDisplayed()
        compose.onNodeWithText("主回合：idle").assertIsDisplayed()
        compose.runOnIdle { tasks = tasks.copy(availability = "unknown") }
        compose.onNodeWithTag("background-task-b").assertIsDisplayed()
        compose.onNodeWithText("状态待核对，显示最后已知信息").assertIsDisplayed()
        // S33 / SC52: partial lists retain disclosure, task titles and their known local status.
        compose.runOnIdle { tasks = tasks.copy(truncated = true) }
        compose.onNodeWithText("子代理 2 项（清单不完整）").assertIsDisplayed()
        compose.onNodeWithText("清单不完整，显示已知任务").assertIsDisplayed()
        compose.onNodeWithText("完成").assertIsDisplayed()
        compose.onNodeWithText("工作中").assertIsDisplayed()
        compose.onNodeWithTag("background-tasks-toggle").performClick()
        compose.onNodeWithTag("background-task-b").assertDoesNotExist()
    }
}
