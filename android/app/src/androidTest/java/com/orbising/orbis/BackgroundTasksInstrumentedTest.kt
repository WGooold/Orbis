// Orbis 测试用途（场景与判定见本文件断言）：
// - Claude 后台子任务（S26、S17、S20、V05、V12、V16、V18、M03、M06、M10、M20）
// - Android 子代理展开行与父子树（S59 / SC107）
package com.orbising.orbis

import android.graphics.Bitmap
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.unit.dp
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
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
                    onOpenRuntime = { _, id -> opened += id }, onCloseRuntimes = { _, ids, _, _ -> closed += ids; ids },
                    onOpenDownloads = {}, onUnpairHost = {}, onOpenSession = { _, _ -> }, onOpenHistory = { _, _ -> },
                    onNewSession = { _, _ -> }, onSetArchived = { _, _, _ -> }, onSelectHost = {}, onAddHost = {},
                    onOpenStatus = {}, onRequestProviders = {})
            }
        }
        val card = compose.onNodeWithTag("home-runtime-parent")
        compose.onNodeWithText("1 个子代理运行中").assertIsDisplayed()
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

    // S59 / SC107: nesting is shown by indentation, not by a "来自" line; screenshots keep the visual evidence.
    @Test fun subagentTreeIndentsChildrenUnderTheirParent() {
        val tasks = BackgroundTaskInventory("ready", listOf(
            BackgroundTask("lead", "梳理需求", "general-purpose", "running"),
            BackgroundTask("scan", "扫描调用点", "Explore", "running", "lead"),
            BackgroundTask("tests", "核对测试", "Explore", "completed", "lead"),
            BackgroundTask("lint", "格式检查", "agent", "failed")), false)
        var dark by mutableStateOf(false)
        var shown by mutableStateOf(tasks)
        compose.setContent {
            OrbisTheme(darkTheme = dark, manageWindow = false) {
                Surface {
                    Column(Modifier.fillMaxWidth()) {
                        Spacer(Modifier.height(24.dp))
                        key(dark) { BackgroundTasksPanel(shown) }
                        Text("输入区", Modifier.fillMaxWidth().height(56.dp))
                    }
                }
            }
        }
        listOf(false, true).forEach { useDark ->
            compose.runOnIdle { dark = useDark; shown = tasks }
            val theme = if (useDark) "dark" else "light"
            capture("background-tasks-collapsed-$theme")
            compose.onNodeWithTag("background-tasks-toggle").performClick()
            compose.waitForIdle()
            compose.onAllNodesWithText("来自：梳理需求").assertCountEquals(0)
            fun left(text: String) = compose.onNodeWithText(text, useUnmergedTree = true).getBoundsInRoot().left
            assertTrue(left("扫描调用点") > left("梳理需求"))
            assertEquals(left("扫描调用点"), left("核对测试"))
            assertEquals(left("梳理需求"), left("格式检查"))
            capture("background-tasks-expanded-$theme")
            // Withdrawn snapshot: last-known rows stay, without liveness (asserted in BackgroundTasksTest).
            compose.runOnIdle { shown = tasks.copy(availability = "unknown") }
            compose.onNodeWithText("状态待核对，显示最后已知信息").assertIsDisplayed()
            capture("background-tasks-unconfirmed-$theme")
        }
    }

    private fun capture(name: String) {
        val output = File(InstrumentationRegistry.getInstrumentation().targetContext.getExternalFilesDir(null), "$name.png")
        output.outputStream().use { compose.onRoot().captureToImage().asAndroidBitmap().compress(Bitmap.CompressFormat.PNG, 100, it) }
    }
}
