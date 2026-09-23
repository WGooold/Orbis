package dev.pi.remote

import android.graphics.Bitmap
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test

class InteractionWorkspaceInstrumentedTest {
    @get:Rule val compose = createComposeRule()

    private fun input(id: String, extension: String) = PendingInteraction(
        id, extension, "input", "填写目录", null, emptyList(), "目录",
    )

    @Test fun piAndCodexRequestsShareDraftsNavigationOfflineLockAndCompletion() {
        val requests = mutableStateOf(listOf(input("pi-input", "pi-extension"), PendingInteraction(
            "codex-approval", "codex", "select", "批准执行命令", "读取项目文件", listOf(
                InteractionOption("once", "允许一次"), InteractionOption("no", "拒绝并继续"),
            ), null, argumentSummary = "Get-ChildItem D:/project",
        )))
        val connected = mutableStateOf(true)
        val submissions = mutableListOf<Pair<String, String>>()
        compose.setContent { PiRemoteTheme { InteractionWorkspace(
            requests.value, connected.value, emptySet(), null,
            respondConfirm = { _, _ -> error("Unexpected confirm") },
            respondValue = { request, value -> submissions.add(request.requestId to value)
                requests.value = requests.value.map { if (it.requestId == request.requestId) it.copy(submitted = true) else it } },
            respondValues = { _, _ -> error("Unexpected multi-select") },
            respondQuestionnaire = { _, _ -> error("Unexpected questionnaire") }, onCancel = { error("Unexpected cancel") },
        ) } }
        compose.onNode(hasSetTextAction()).performTextInput("D:/reports")
        compose.onNodeWithText("收起").performClick()
        compose.onNodeWithText("待处理 2 项 · 填写目录").performClick()
        compose.onNode(hasSetTextAction()).assertTextContains("D:/reports")
        compose.onNodeWithText("2. 批准执行命令").performClick()
        compose.onNodeWithText("Get-ChildItem D:/project").assertIsDisplayed()
        compose.runOnIdle { connected.value = false }
        compose.onNodeWithText("允许一次").assertIsNotEnabled()
        compose.onNodeWithText("连接已断开，草稿已保留，连接后可重试").assertIsDisplayed()
        compose.runOnIdle { connected.value = true }
        capture("mobile-controls-approval.png")
        compose.onNodeWithText("允许一次").performClick()
        compose.onNodeWithText("允许一次").assertIsNotEnabled()
        compose.runOnIdle { assertEquals(listOf("codex-approval" to "once"), submissions); requests.value = requests.value.take(1) }
        compose.onNode(hasSetTextAction()).assertTextContains("D:/reports")
        compose.onNodeWithText("提交").performClick()
        compose.runOnIdle { assertEquals("pi-input" to "D:/reports", submissions.last()); requests.value = emptyList() }
        compose.onNodeWithText("收起").assertDoesNotExist()
    }

    @Test fun piQuestionnaireSurvivesCollapseAndKeepsCancelSeparate() {
        val request = PendingInteraction("pi-question", "ask-user-question", "questionnaire", "实施方案", null, emptyList(), null,
            questions = listOf(QuestionnaireQuestion("scope", "要处理哪些模块？", listOf(InteractionOption("api", "API")),
                multiSelect = true, allowOther = true, allowNotes = true)))
        var cancellation = 0
        val answers = mutableListOf<List<QuestionnaireAnswer>>()
        compose.setContent { PiRemoteTheme { InteractionWorkspace(
            listOf(request), true, emptySet(), null,
            respondConfirm = { _, _ -> }, respondValue = { _, _ -> }, respondValues = { _, _ -> },
            respondQuestionnaire = { _, value -> if (value == null) cancellation++ else answers.add(value) }, onCancel = {},
        ) } }
        compose.onNodeWithText("API").performClick()
        compose.onNodeWithText("其他答案").performClick()
        compose.onNodeWithText("填写其他答案").performScrollTo().performTextInput("cache")
        compose.onNodeWithText("收起").performClick()
        compose.runOnIdle { assertEquals(0, cancellation); assertTrue(answers.isEmpty()) }
        compose.onNodeWithText("待处理 1 项 · 实施方案").performClick()
        compose.onNodeWithText("填写其他答案").performScrollTo().assertTextContains("cache")
        capture("mobile-controls-questionnaire.png")
        compose.onNodeWithText("提交答案").performClick()
        compose.runOnIdle { assertEquals(listOf(QuestionnaireAnswer("scope", listOf("api"), "cache")), answers.single()) }
    }

    @Test fun permissionChangesWaitForConfirmationAndShowServerFailures() {
        val permissions = mutableStateOf(RuntimePermissions("readOnly", "never", reviewer = "user", networkAccess = false))
        val results = mutableStateOf(emptyMap<String, CommandResult>())
        val calls = mutableListOf<Pair<String, String>>()
        val command = RuntimeSlashCommand("sandbox", "文件访问范围", "builtin", RuntimeSlashCommandArgument("select", true, options = listOf(
            RuntimeSlashCommandOption("readOnly", "只读", "仅允许读取文件"),
            RuntimeSlashCommandOption("workspaceWrite", "工作区可写", "允许修改当前项目"),
            RuntimeSlashCommandOption("dangerFullAccess", "完全访问", "允许读写和联网"),
        )))
        compose.setContent { PiRemoteTheme { RuntimePermissionsStatus(
            permissions.value, listOf(command), commandResults = results.value,
            onApply = { name, value -> calls.add(name to value); "write-${calls.size}" },
        ) } }
        compose.onNodeWithText("只读沙箱 · 不申请审批").performClick()
        compose.onNodeWithText("○ 工作区可写").performScrollTo().performClick()
        compose.onNodeWithText("应用到当前会话").performClick()
        compose.onNodeWithText("正在应用，等待电脑确认…").assertIsNotEnabled()
        compose.runOnIdle { assertEquals("readOnly", permissions.value.sandbox); results.value = mapOf("write-1" to CommandResult(false, error = "组织策略不允许修改")) }
        compose.onNodeWithText("组织策略不允许修改").assertIsDisplayed()
        compose.onNodeWithText("应用到当前会话").performClick()
        compose.runOnIdle {
            permissions.value = permissions.value.copy(sandbox = "workspaceWrite")
            results.value = results.value + ("write-2" to CommandResult(true))
        }
        compose.onNodeWithText("已应用到当前会话，后续任务使用新设置").assertIsDisplayed()
        compose.onNodeWithText("应用到当前会话").assertIsNotEnabled()
        capture("mobile-controls-permissions.png")
    }

    @Test fun unavailablePiPermissionsDoNotInventSettings() {
        compose.setContent { PiRemoteTheme { RuntimePermissionsStatus(null) } }
        compose.onNodeWithText("权限 · 查看").performClick()
        compose.onNodeWithText("工具权限由电脑端", substring = true).assertIsDisplayed()
        compose.onNodeWithText("应用到当前会话").assertDoesNotExist()
    }

    private fun capture(name: String) {
        compose.waitForIdle()
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        instrumentation.uiAutomation.takeScreenshot()?.let { bitmap ->
            File(instrumentation.targetContext.getExternalFilesDir(null), name).outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
            bitmap.recycle()
        }
    }
}
