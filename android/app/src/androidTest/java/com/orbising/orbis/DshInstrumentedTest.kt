// Orbis 测试用途（场景与判定见本文件断言）：
// - 新建会话 Agent 选择（S20、V12、V16、V18）
// - 顶栏 / 输入 / 交互（S12、S17、V05、V08、V12、V17）
package com.orbising.orbis

import android.graphics.Bitmap
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test

class DshInstrumentedTest {
    @get:Rule val compose = createComposeRule()

    @Test fun selectsLaunchableDeepSeekBeforeBackendReadyAndCreatesSessionInChosenDirectory() {
        var created: Pair<String, String>? = null
        compose.setContent { OrbisTheme { SessionDraftCard(
            state = RemoteState(hostId = "paired-host", connection = RelayConnection.ONLINE, e2eReady = true,
                supportedAgents = setOf("pi", "codex"), launchableAgents = setOf("pi", "codex", "dsh")),
            open = true, presetCwd = "D:/orbis-deepseek-harness", onBrowse = {}, onBrowseInto = {}, onBrowseUp = {},
            onSubmit = { kind, cwd, _, _, _ -> created = kind to cwd; true },
        ) } }
        compose.onNodeWithTag("draft-agent-dsh").performClick()
        capture("dsh-new-session.png")
        compose.onNode(hasSetTextAction()).performTextInput("检查工作目录")
        compose.onNodeWithTag("draft-send").performClick()
        compose.runOnIdle { assertEquals("dsh" to "D:/orbis-deepseek-harness", created) }
    }

    @Test fun answersDeepSeekPermissionThroughSharedInteractionWorkspace() {
        var answer: String? = null
        val request = PendingInteraction("dsh-approval", "dsh", "select", "DeepSeek 工具执行审批", "pwsh", listOf(
            InteractionOption("allow-once", "Allow once"), InteractionOption("reject-once", "Reject"),
        ), null)
        compose.setContent { OrbisTheme { AgentTheme(AgentBrand.DeepSeek) { InteractionWorkspace(
            listOf(request), true, emptySet(), null,
            respondConfirm = { _, _ -> }, respondValue = { _, value -> answer = value }, respondValues = { _, _ -> },
            respondQuestionnaire = { _, _ -> }, onCancel = {},
        ) } } }
        compose.onNodeWithText("DeepSeek 工具执行审批").assertIsDisplayed()
        capture("dsh-permission.png")
        compose.onNodeWithText("Allow once").performClick()
        compose.runOnIdle { assertEquals("allow-once", answer) }
    }

    private fun capture(name: String) {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val root = File(instrumentation.targetContext.getExternalFilesDir(null), "dsh-verification").apply { mkdirs() }
        instrumentation.uiAutomation.takeScreenshot().useBitmap { bitmap ->
            File(root, name).outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
        }
    }
    private inline fun Bitmap.useBitmap(block: (Bitmap) -> Unit) { try { block(this) } finally { recycle() } }
}
