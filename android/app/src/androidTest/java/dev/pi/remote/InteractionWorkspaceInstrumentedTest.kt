package dev.pi.remote

import android.graphics.Bitmap
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.junit4.StateRestorationTester
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
        val setting = RuntimePermissionSetting("vendor.setting/42", "Host 设置", "opaque:old", options = listOf(
            RuntimePermissionOption("opaque:old", "当前策略", "Host 当前策略说明"),
            RuntimePermissionOption("opaque:new", "新策略", "Host 新策略说明"),
        ))
        val permissions = mutableStateOf(RuntimePermissionManagement("Host 当前摘要", "Host 权限详情", "restricted", listOf(setting)))
        val results = mutableStateOf(emptyMap<String, CommandResult>())
        val calls = mutableListOf<Pair<String, String>>()
        compose.setContent { PiRemoteTheme { RuntimePermissionsStatus(
            permissions.value, commandResults = results.value,
            onApply = { id, value -> calls.add(id to value); "write-${calls.size}" },
        ) } }
        compose.onNodeWithContentDescription("当前会话权限").performClick()
        compose.onNodeWithText("○ 新策略").performScrollTo().performClick()
        compose.onNodeWithText("应用到当前会话").performClick()
        compose.onNodeWithText("正在应用，等待电脑确认…").assertIsNotEnabled()
        compose.runOnIdle {
            assertEquals(listOf("vendor.setting/42" to "opaque:new"), calls)
            assertEquals("opaque:old", permissions.value.settings.single().currentValue)
            results.value = mapOf("write-1" to CommandResult(false, error = "组织策略不允许修改"))
        }
        compose.onNodeWithText("组织策略不允许修改").assertIsDisplayed()
        compose.onNodeWithText("应用到当前会话").performClick()
        compose.runOnIdle {
            permissions.value = permissions.value.copy(summary = "Host 新摘要", settings = listOf(setting.copy(currentValue = "opaque:new")))
            results.value = results.value + ("write-2" to CommandResult(true))
        }
        compose.onNodeWithText("已应用到当前会话").assertIsDisplayed()
        compose.onNodeWithText("应用到当前会话").assertIsNotEnabled()
        capture("mobile-controls-permissions.png")
    }

    @Test fun permissionWaitRecoversAfterTimeoutDisconnectAndStateRestoration() {
        val setting = RuntimePermissionSetting("opaque-setting", "权限设置", "old", options = listOf(
            RuntimePermissionOption("old", "当前策略"), RuntimePermissionOption("new", "新策略"),
        ))
        val connected = mutableStateOf(true)
        val results = mutableStateOf(emptyMap<String, CommandResult>())
        var calls = 0
        val restoration = StateRestorationTester(compose)
        restoration.setContent { PiRemoteTheme { RuntimePermissionsStatus(
            RuntimePermissionManagement("Host 摘要", "Host 详情", "unknown", listOf(setting)),
            connected = connected.value, commandResults = results.value,
            onApply = { _, _ -> "write-${++calls}" },
        ) } }
        compose.onNodeWithContentDescription("当前会话权限").performClick()
        compose.onNodeWithText("○ 新策略").performScrollTo().performClick()
        compose.onNodeWithText("应用到当前会话").performClick()
        compose.runOnIdle { results.value = mapOf("write-1" to CommandResult(true, status = "pending")) }
        compose.onNodeWithText("正在应用，等待电脑确认…").assertIsNotEnabled()
        compose.mainClock.advanceTimeBy(75_100)
        compose.onNodeWithText("等待电脑确认已超过 75 秒，权限设置尚未确认；请检查当前权限后再决定是否重试").assertIsDisplayed()
        compose.onNodeWithText("应用到当前会话").assertIsEnabled()
        compose.runOnIdle { assertEquals(1, calls) }

        compose.onNodeWithText("应用到当前会话").performClick()
        compose.runOnIdle { connected.value = false }
        compose.onNodeWithText("连接已断开，权限设置尚未确认；重新连接后请检查当前权限").assertIsDisplayed()
        compose.runOnIdle { connected.value = true; assertEquals(2, calls) }
        compose.onNodeWithText("应用到当前会话").assertIsEnabled()

        compose.onNodeWithText("应用到当前会话").performClick()
        restoration.emulateSavedInstanceStateRestore()
        compose.onNodeWithText("正在应用，等待电脑确认…").assertDoesNotExist()
        compose.runOnIdle { assertEquals(3, calls) }
    }

    @Test fun unavailablePiPermissionsDoNotInventSettings() {
        compose.setContent { PiRemoteTheme { RuntimePermissionsStatus(null) } }
        compose.onNodeWithText("电脑端管理").performClick()
        compose.onNodeWithText("当前会话未提供权限管理信息，请在电脑端查看和管理权限").assertIsDisplayed()
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
