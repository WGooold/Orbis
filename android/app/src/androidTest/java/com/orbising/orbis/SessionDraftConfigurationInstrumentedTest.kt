package com.orbising.orbis

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.width
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.dp
import org.junit.After
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test

/** S51 / SC73, S54 / SC78: category switching and info never commit; Apply stays visible and closes once. */
class SessionDraftConfigurationInstrumentedTest {
    @get:Rule val compose = createComposeRule()
    @After fun restoreLanguage() { AppLocalization.select(AppLanguage.Chinese) }

    /** S55 / SC79: four long Codex permission fields cannot crowd out either value at 320dp. */
    @Test fun longCodexPermissionsKeepModelAndThinkingVisibleAt320dp() = checkConfigurationWidth(AppLanguage.Chinese, 1f)

    @Test fun englishLongPermissionsKeepValuesVisibleWithLargerText() = checkConfigurationWidth(AppLanguage.English, 1.3f)

    private fun checkConfigurationWidth(language: AppLanguage, fontScale: Float) {
        AppLocalization.select(language)
        val model = "GPT-5.4"
        val values = SessionConfigurationValues(model, "high", mapOf("sandbox" to "workspaceWrite", "network" to "enabled", "approvals" to "on-request", "reviewer" to "user"))
        val permissions = values.permissions.map { (id, value) ->
            RuntimePermissionSetting(id, id, options = listOf(RuntimePermissionOption(value, "这是很长的权限说明 $id / Read and write files with approval")))
        }
        val catalog = SessionConfigurationCatalog("fixture", models = listOf(SessionConfigurationModel(model, model,
            thinking = listOf(RuntimePermissionOption("high", "高")))), permissions = permissions)
        val state = RemoteState(hostId = "draft-host", e2eReady = true, connection = RelayConnection.ONLINE,
            supportedAgents = setOf("codex"), sessionConfigurationSupported = true,
            sessionConfiguration = SessionConfigurationState("codex", "/fixture", snapshot =
                SessionConfigurationSnapshot("codex", "/fixture", "fixture", 1, values, catalog)))
        compose.setContent { OrbisTheme {
            CompositionLocalProvider(LocalDensity provides Density(LocalDensity.current.density, fontScale)) {
                Box(Modifier.width(320.dp)) {
                    SessionDraftCard(state, true, "/fixture", {}, {}, {}, onSubmit = { _, _, _, _, _ -> false })
                }
            }
        } }
        val card = compose.onNodeWithTag("session-draft").fetchSemanticsNode().boundsInRoot
        val modelBounds = compose.onNodeWithTag("draft-config-model").assertIsDisplayed().assertIsEnabled().fetchSemanticsNode().boundsInRoot
        val thinkingBounds = compose.onNodeWithTag("draft-config-thinking").assertIsDisplayed().assertIsEnabled().fetchSemanticsNode().boundsInRoot
        val permissionsBounds = compose.onNodeWithTag("draft-config-permissions").assertIsDisplayed().assertIsEnabled().fetchSemanticsNode().boundsInRoot
        assertTrue(modelBounds.bottom <= thinkingBounds.top)
        assertTrue(thinkingBounds.right < permissionsBounds.left)
        assertEquals(thinkingBounds.width, permissionsBounds.width, 1f)
        assertEquals(modelBounds.left, thinkingBounds.left, 1f)
        assertEquals(modelBounds.right, permissionsBounds.right, 1f)
        assertTrue(modelBounds.left >= card.left && modelBounds.right <= card.right)
        for (field in listOf("model", "thinking")) {
            val layouts = mutableListOf<androidx.compose.ui.text.TextLayoutResult>()
            compose.onNodeWithTag("draft-config-$field-value", useUnmergedTree = true)
                .performSemanticsAction(androidx.compose.ui.semantics.SemanticsActions.GetTextLayoutResult) { it(layouts) }
            assertFalse("$field is fully readable", layouts.single().isLineEllipsized(0))
        }
        compose.onNodeWithTag("draft-config-thinking-value", useUnmergedTree = true).assertTextEquals(L10n.hostText("高"))
        capture("draft-config-${language.key}")
        compose.onNodeWithTag("draft-config-permissions").performClick()
        compose.onNodeWithTag("draft-permissions-apply").assertIsDisplayed().assertIsNotEnabled()
    }

    private fun capture(name: String) {
        val instrumentation = androidx.test.platform.app.InstrumentationRegistry.getInstrumentation()
        val screenshot = instrumentation.uiAutomation.takeScreenshot()
        java.io.File(instrumentation.targetContext.getExternalFilesDir(null), "$name.png").outputStream().use {
            screenshot.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, it)
        }
    }

    @Test fun permissionChoicesStayOpenAndApplyOnceAfterMultipleEdits() {
        val saved = mutableListOf<SessionConfigurationValues>()
        val values = SessionConfigurationValues(permissions = mapOf("sandbox" to "workspaceWrite", "network" to "disabled"))
        val catalog = SessionConfigurationCatalog("fixture", permissions = listOf(
            RuntimePermissionSetting("sandbox", "沙箱", options = listOf(
                RuntimePermissionOption("workspaceWrite", "工作目录"),
                RuntimePermissionOption("readOnly", "只读", "只能读取文件"),
                RuntimePermissionOption("dangerFullAccess", "完全访问"))),
            RuntimePermissionSetting("network", "网络", options = listOf(
                RuntimePermissionOption("disabled", "禁用网络"),
                RuntimePermissionOption("enabled", "启用网络"))),
        ))
        val state = RemoteState(hostId = "draft-host", e2eReady = true, connection = RelayConnection.ONLINE,
            supportedAgents = setOf("codex"), sessionConfigurationSupported = true,
            sessionConfiguration = SessionConfigurationState("codex", "/fixture", snapshot =
                SessionConfigurationSnapshot("codex", "/fixture", "fixture", 1, values, catalog)))
        compose.setContent { OrbisTheme {
            SessionDraftCard(state, true, "/fixture", {}, {}, {}, onSaveConfiguration = { saved += it },
                onSubmit = { _, _, _, _, _ -> false })
        } }
        compose.onNodeWithTag("draft-config-permissions").performClick()
        val top = compose.onNodeWithTag("orbis-sheet-surface").fetchSemanticsNode().positionInWindow.y
        compose.onNodeWithTag("draft-permissions-apply").assertIsDisplayed().assertIsNotEnabled()
        compose.onNodeWithText("完全访问").performClick()
        compose.waitForIdle()
        assertEquals("Choosing a staged permission must not start the sheet's exit", top,
            compose.onNodeWithTag("orbis-sheet-surface").fetchSemanticsNode().positionInWindow.y, 1f)
        compose.onNodeWithText("只读").performClick()
        compose.onNodeWithText("只能读取文件").assertDoesNotExist()
        compose.onNodeWithContentDescription("查看只读说明").performClick()
        compose.onNodeWithText("只能读取文件").assertIsDisplayed()
        compose.onNodeWithText("知道了").performClick()
        compose.onNodeWithTag("permission-tab-network").performClick()
        compose.onNodeWithTag("permission-option-network-enabled").assertIsSelected()
        compose.onNodeWithTag("permission-tab-sandbox").performClick()
        compose.onNodeWithTag("permission-option-sandbox-readOnly").assertIsSelected()
        compose.onNodeWithTag("draft-permissions-apply").assertIsDisplayed().assertIsEnabled()
        val instrumentation = androidx.test.platform.app.InstrumentationRegistry.getInstrumentation()
        val screenshot = instrumentation.uiAutomation.takeScreenshot()
        java.io.File(instrumentation.targetContext.getExternalFilesDir(null), "quiet-draft-permissions.png").outputStream().use {
            screenshot.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, it)
        }
        compose.runOnIdle { assertTrue(saved.isEmpty()) }
        compose.onNodeWithTag("draft-permissions-apply").performClick()
        compose.runOnIdle {
            assertEquals(listOf(values.copy(permissions = mapOf("sandbox" to "readOnly", "network" to "enabled"))), saved)
        }
        compose.onNodeWithTag("orbis-sheet-window").assertDoesNotExist()
        // A second opening and real back dismissal prove no invisible modal keeps consuming input.
        compose.onNodeWithTag("draft-config-permissions").performClick()
        compose.onNodeWithTag("permission-tab-network").performClick()
        compose.onNodeWithText("启用网络").performClick()
        androidx.test.platform.app.InstrumentationRegistry.getInstrumentation()
            .sendKeyDownUpSync(android.view.KeyEvent.KEYCODE_BACK)
        compose.onNodeWithTag("orbis-sheet-window").assertDoesNotExist()
        compose.runOnIdle { assertEquals(1, saved.size) }
        compose.onNodeWithTag("draft-send").assertIsDisplayed().assertIsEnabled()
    }
}
