package dev.pi.remote

import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test

class CodexPermissionsInstrumentedTest {
    @get:Rule val compose = createComposeRule()

    @Test fun commandAndScopeAreVisibleAndOnlyTheSelectedDecisionIsSubmitted() {
        val submissions = mutableListOf<String>()
        val submitted = mutableStateOf(false)
        val request = PendingInteraction(
            requestId = "approval", extensionId = "codex", kind = "select", title = "批准执行命令",
            description = "申请读取 D:/reports；工作目录 D:/repo",
            argumentSummary = "Get-Content D:/reports/result.txt", placeholder = null,
            options = listOf(InteractionOption("0", "允许一次"), InteractionOption("1", "本会话允许"), InteractionOption("2", "拒绝并继续")),
        )
        compose.setContent { PiRemoteTheme {
            InteractionPanel(request.copy(submitted = submitted.value), false,
                respondConfirm = { error("Wrong response") }, respondValue = { submissions.add(it); submitted.value = true },
                respondValues = { error("Wrong response") })
        } }
        compose.onNodeWithText("Get-Content D:/reports/result.txt").assertIsDisplayed()
        compose.onNodeWithText("申请读取 D:/reports；工作目录 D:/repo").assertIsDisplayed()
        compose.onNodeWithText("本会话允许").performScrollTo().performClick()
        compose.onNodeWithText("本会话允许").assertIsNotEnabled()
        compose.runOnIdle { assertEquals(listOf("1"), submissions) }
    }

    @Test fun permissionDetailsShowReadOnlyNeverAndTheSandboxFailure() {
        compose.setContent { PiRemoteTheme { RuntimePermissionsStatus(RuntimePermissions(
            sandbox = "readOnly", approvalPolicy = "never", networkAccess = false, reviewer = "user",
            problem = "Windows 沙箱初始化失败，请在电脑端修复 Codex 沙箱设置后重试。",
        )) } }
        compose.onNodeWithText("沙箱异常").performClick()
        compose.onNodeWithText("当前会话权限").assertIsDisplayed()
        compose.onNodeWithText("只读沙箱 · 不申请审批", substring = true).assertIsDisplayed()
        compose.onNodeWithText("电脑端修复 Codex 沙箱设置", substring = true).assertExists()
    }

    @Test fun freeTextQuestionCanBeAnsweredWithoutSelectingADummyOption() {
        val answers = mutableListOf<List<QuestionnaireAnswer>>()
        compose.setContent { PiRemoteTheme { QuestionnairePanel(
            PendingInteraction("free-text", "codex", "questionnaire", "需要回答", null, emptyList(), null,
                questions = listOf(QuestionnaireQuestion("q", "需要保存到哪个目录？", emptyList(), allowOther = true))),
            false, null, onSubmit = { answers.add(it) }, onCancel = {},
        ) } }
        compose.onNodeWithText("填写回答").performScrollTo().performTextInput("D:/reports")
        compose.onNodeWithText("提交答案").performClick()
        compose.runOnIdle { assertEquals(listOf(QuestionnaireAnswer("q", emptyList(), "D:/reports")), answers.single()) }
    }
}
