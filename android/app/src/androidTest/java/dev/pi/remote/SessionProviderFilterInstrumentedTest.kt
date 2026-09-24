package dev.pi.remote

import android.graphics.Bitmap
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test

class SessionProviderFilterInstrumentedTest {
    @get:Rule val compose = createComposeRule()

    @Test fun submenuDefaultsToCurrentProviderSupportsSearchArchiveAndSwitching() {
        val entries = listOf(
            session("Custom session", "custom"), session("Other session", "openai"),
            session("Unknown session", null), session("Archived session", "custom", archived = true),
            session("Pi session", null, agent = "pi"),
        )
        val state = mutableStateOf(RemoteState(hostId = "paired-host", hostName = "Desktop",
            sessions = entries.associateBy { it.sessionId }, currentProviders = mapOf("codex" to "custom"),
        ))
        val opened = mutableListOf<String>()
        compose.setContent { PiRemoteTheme { SessionDrawer(state.value, opened::add, {}, {}, { _, _ -> }) } }
        openFilter()
        compose.onNodeWithContentDescription("按 provider 筛选").performClick()
        compose.onNodeWithText("custom（当前使用）").assertIsDisplayed()
        compose.onNodeWithContentDescription("当前 provider 筛选").assertExists()
        compose.onNodeWithText("会话绑定所属 provider", substring = true).assertIsDisplayed()
        capture("provider-menu")
        compose.onNodeWithText("custom（当前使用）").performClick()
        compose.onNodeWithText("Custom session").assertIsDisplayed()
        compose.onNodeWithText("Other session").assertDoesNotExist()
        compose.onNodeWithText("Pi session").assertDoesNotExist()
        capture("current-provider")

        openFilter()
        compose.onNodeWithContentDescription("按 provider 筛选").performClick()
        compose.onNodeWithText("openai").performClick()
        compose.onNodeWithText("Other session").assertIsDisplayed().performClick()
        compose.onNodeWithText("需要切换 provider").assertIsDisplayed()
        compose.onNodeWithText("此会话属于 openai，当前使用 custom", substring = true).assertIsDisplayed()
        assertEquals(emptyList<String>(), opened)
        capture("provider-mismatch")
        compose.onNodeWithText("知道了").performClick()
        openFilter()
        compose.onNodeWithContentDescription("按 provider 筛选").performClick()
        compose.onNodeWithText("全部 provider").performClick()
        compose.onNodeWithText("Custom session").assertIsDisplayed()
        compose.onNodeWithText("Other session").assertIsDisplayed()
        compose.onNodeWithText("Unknown session").assertIsDisplayed()
        compose.onNodeWithText("Pi session").assertDoesNotExist()

        openFilter()
        compose.onNodeWithContentDescription("按 provider 筛选").performClick()
        compose.onNodeWithText("custom（当前使用）").performClick()
        compose.runOnIdle { state.value = state.value.copy(currentProviders = mapOf("codex" to "openai")) }
        compose.onNodeWithText("Other session").assertIsDisplayed()
        compose.onNodeWithText("Custom session").assertDoesNotExist()
        compose.onNodeWithText("Codex · openai（当前使用）").assertIsDisplayed()
        compose.onNode(hasSetTextAction()).performTextInput("no-match")
        compose.onNodeWithText("没有找到匹配的目录或会话").assertIsDisplayed()
        compose.onNodeWithContentDescription("清除搜索").performClick()
        compose.onNodeWithText("Other session").assertIsDisplayed()
        compose.runOnIdle { state.value = state.value.copy(currentProviders = mapOf("codex" to "custom")) }
        openFilter()
        compose.onNodeWithText("查看已归档会话").performClick()
        compose.onNodeWithText("Archived session").assertIsDisplayed()
        compose.onNodeWithText("Custom session").assertDoesNotExist()
    }

    @Test fun missingConfigurationNeverClaimsUnknownSessionsAreCurrent() {
        val state = mutableStateOf(RemoteState(hostId = "paired-host", hostName = "Desktop", sessions = listOf(session("Unknown session", null)).associateBy { it.sessionId }))
        compose.setContent { PiRemoteTheme { SessionDrawer(state.value, {}, {}, {}, { _, _ -> }) } }
        openFilter()
        compose.onNodeWithContentDescription("按 provider 筛选").performClick()
        compose.onNodeWithText("当前 provider（尚未获取）").performClick()
        compose.onNodeWithText("尚未获取当前 provider").assertIsDisplayed()
        compose.onNodeWithText("Unknown session").assertDoesNotExist()
        openFilter()
        compose.onNodeWithContentDescription("按 provider 筛选").performClick()
        compose.onNodeWithText("未知 provider").performClick()
        compose.onNodeWithText("Unknown session").assertIsDisplayed()
    }

    private fun openFilter() = compose.onNode(hasContentDescription("筛选会话：", substring = true)).performClick()

    private fun session(name: String, provider: String?, archived: Boolean = false, agent: String = "codex") = SessionCatalogEntry(
        sessionId = name, name = name, cwd = "D:/project", hostname = "Desktop", agentKind = agent,
        modelProvider = provider, archived = archived,
    )

    private fun capture(name: String) {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val folder = File(instrumentation.targetContext.getExternalFilesDir(null), "provider-filter").apply { mkdirs() }
        val bitmap = compose.onAllNodes(isRoot()).onLast().captureToImage().asAndroidBitmap()
        File(folder, "$name.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
    }
}
