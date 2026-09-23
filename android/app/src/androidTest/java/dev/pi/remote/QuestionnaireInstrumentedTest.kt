package dev.pi.remote

import android.graphics.Bitmap
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import java.io.FileOutputStream
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.SideEffect
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.assertIsOn
import androidx.compose.ui.test.assertTextContains
import androidx.compose.ui.test.junit4.StateRestorationTester
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTextInput
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

class QuestionnaireInstrumentedTest {
    @get:Rule val compose = createComposeRule()

    private fun request() = PendingInteraction(
        requestId = "questionnaire-1", extensionId = "ask-user-question", kind = "questionnaire",
        title = "确认实施方案", description = null, options = emptyList(), placeholder = null,
        questions = listOf(
            QuestionnaireQuestion(
                id = "targets", header = "范围", question = "需要处理哪些部分？",
                options = listOf(InteractionOption("api", "API"), InteractionOption("db", "数据库")),
                multiSelect = true, allowOther = true, allowNotes = true,
            ),
            QuestionnaireQuestion(
                id = "env", header = "环境", question = "在哪里运行？",
                options = listOf(InteractionOption("local", "本机"), InteractionOption("remote", "远程")),
                allowOther = true,
            ),
        ),
    )

    @Test
    fun editingAndRestoringTheFormPreservesDraftsUntilOneExplicitSubmission() {
        val submissions = mutableListOf<List<QuestionnaireAnswer>>()
        val submitting = mutableStateOf(false)
        val restoration = StateRestorationTester(compose)
        var hideKeyboard: () -> Unit = {}
        restoration.setContent {
            val keyboard = LocalSoftwareKeyboardController.current
            SideEffect { hideKeyboard = { keyboard?.hide() } }
            PiRemoteTheme {
                QuestionnairePanel(request(), submitting.value, null, onSubmit = {
                    submissions.add(it)
                    submitting.value = true
                }, onCancel = { error("Unexpected cancellation") })
            }
        }
        compose.onNodeWithText("API").performClick()
        compose.onNodeWithText("数据库").performScrollTo().performClick()
        compose.onNodeWithText("其他答案").performScrollTo().performClick()
        compose.onNodeWithText("填写其他答案").performScrollTo().performTextInput("cache")
        compose.onNodeWithText("补充说明（可选）").performScrollTo().performTextInput("keep data")
        compose.runOnIdle { hideKeyboard() }
        compose.waitForIdle()
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        instrumentation.uiAutomation.takeScreenshot()?.let { image ->
            FileOutputStream(File(instrumentation.targetContext.getExternalFilesDir(null), "questionnaire-preview.png")).use {
                image.compress(Bitmap.CompressFormat.PNG, 100, it)
            }
            image.recycle()
        }
        compose.onNodeWithText("下一题").performClick()
        // The fixed-height panel keeps the second question independently scrollable; the
        // questionnaire-level Other/input behavior is covered by the first question above.
        compose.onNodeWithText("本机").performClick()
        compose.runOnIdle { hideKeyboard() }
        // A single-choice answer can be changed without submitting a partial questionnaire.
        assertTrue(submissions.isEmpty())
        compose.onNodeWithText("上一题").performClick()
        restoration.emulateSavedInstanceStateRestore()
        compose.onNodeWithText("API").assertIsOn()
        compose.onNodeWithText("数据库").assertIsOn()
        compose.onNodeWithText("填写其他答案").performScrollTo().assertTextContains("cache")
        compose.onNodeWithText("补充说明（可选）").performScrollTo().assertTextContains("keep data")
        // Change an earlier answer after returning from another question.
        compose.onNodeWithText("数据库").performScrollTo().performClick()
        compose.onNodeWithText("下一题").performClick()
        compose.onNodeWithText("提交答案").performClick()
        compose.onNodeWithText("正在提交…").assertIsNotEnabled().performClick()
        compose.runOnIdle {
            assertEquals(1, submissions.size)
            assertEquals(listOf(
                QuestionnaireAnswer("targets", listOf("api"), "cache", "keep data"),
                QuestionnaireAnswer("env", listOf("local")),
            ), submissions.single())
        }
    }

    @Test
    fun cancellingFromOtherInputEndsTheRequestWithoutSubmittingAnAnswer() {
        var cancellations = 0
        val submitting = mutableStateOf(false)
        compose.setContent {
            PiRemoteTheme {
                QuestionnairePanel(request(), submitting.value, null,
                    onSubmit = { error("Cancellation must not submit a partial answer") },
                    onCancel = { cancellations++; submitting.value = true },
                )
            }
        }
        compose.onNodeWithText("其他答案").performScrollTo().performClick()
        compose.onNodeWithText("取消回答").performClick()
        compose.onNodeWithText("取消回答").assertIsNotEnabled().performClick()
        compose.runOnIdle { assertEquals(1, cancellations) }
    }
}
