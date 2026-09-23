package dev.pi.remote

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

    @Test fun selectsDeepSeekAndCreatesSessionInChosenDirectory() {
        var created: Pair<String, String>? = null
        compose.setContent { PiRemoteTheme { NewSessionSheet(
            state = RemoteState(connection = RelayConnection.ONLINE, supportedAgents = setOf("pi", "codex", "dsh")),
            presetCwd = "D:/orbis-deepseek-harness", onDismiss = {}, onBrowse = {}, onBrowseInto = {}, onBrowseUp = {},
            onCreate = { kind, cwd -> created = kind to cwd },
        ) } }
        compose.onNodeWithText("DeepSeek", useUnmergedTree = true).performClick()
        compose.onNodeWithText("DeepSeek Harness 会话在后台运行，支持模型切换与工具审批").assertIsDisplayed()
        capture("dsh-new-session.png")
        compose.onNodeWithText("在此目录新建 DeepSeek 会话").performClick()
        compose.runOnIdle { assertEquals("dsh" to "D:/orbis-deepseek-harness", created) }
    }

    @Test fun answersDeepSeekPermissionThroughSharedInteractionWorkspace() {
        var answer: String? = null
        val request = PendingInteraction("dsh-approval", "dsh", "select", "DeepSeek 工具执行审批", "pwsh", listOf(
            InteractionOption("allow-once", "Allow once"), InteractionOption("reject-once", "Reject"),
        ), null)
        compose.setContent { PiRemoteTheme { AgentTheme(AgentBrand.DeepSeek) { InteractionWorkspace(
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
