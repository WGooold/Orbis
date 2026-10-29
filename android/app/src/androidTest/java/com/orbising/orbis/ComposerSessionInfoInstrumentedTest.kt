package com.orbising.orbis

import android.graphics.Bitmap
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.width
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.dp
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.core.app.ApplicationProvider
import androidx.lifecycle.ViewModelStore
import java.io.File
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

class ComposerSessionInfoInstrumentedTest {
    @get:Rule val compose = createComposeRule()

    @Test fun longPathAndBranchRemainReadableInACompactRow() {
        val path = "/Users/developer/Projects/mobile/worktrees/orbis"
        val branch = "feature/keep-the-composer-layout-readable"
        compose.setContent {
            OrbisTheme {
                Box(Modifier.width(390.dp).background(MaterialTheme.colorScheme.background).testTag("session-info")) {
                    ComposerSessionInfo(path, WorkingBranch("request", "session", path, branch, loaded = true)) {
                        RuntimePermissionsStatus(RuntimePermissionManagement("工作区写入", "权限详情", "restricted", emptyList()))
                    }
                }
            }
        }
        compose.onNodeWithContentDescription(path).assertIsDisplayed()
        compose.onNodeWithText(branch).assertIsDisplayed()
        val density = InstrumentationRegistry.getInstrumentation().targetContext.resources.displayMetrics.density
        val row = compose.onNodeWithTag("session-info").fetchSemanticsNode().boundsInRoot
        val directory = compose.onNodeWithContentDescription(path).fetchSemanticsNode().boundsInRoot
        val branchBounds = compose.onNodeWithText(branch).fetchSemanticsNode().boundsInRoot
        assertTrue("Directory lost its readable tail: $directory", directory.width >= 24 * density)
        assertTrue("Directory and branch overlap", directory.right <= branchBounds.left)
        assertTrue("Session info kept an empty row: $row", row.height <= 40 * density)
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        File(context.getExternalFilesDir(null), "composer-session-info.png").outputStream().use {
            compose.onNodeWithTag("session-info").captureToImage().asAndroidBitmap().compress(Bitmap.CompressFormat.PNG, 100, it)
        }
        compose.onNodeWithContentDescription("当前会话权限").performClick()
        compose.onNodeWithText("权限详情").assertIsDisplayed()
    }

    @Test fun narrowLargeTextKeepsTheOpenPermissionPanelWhenResized() {
        val narrow = mutableStateOf(false)
        compose.setContent {
            OrbisTheme {
                val density = LocalDensity.current
                CompositionLocalProvider(LocalDensity provides Density(density.density, if (narrow.value) 1.6f else 1f)) {
                    Column(Modifier.width(if (narrow.value) 260.dp else 390.dp)) {
                        ComposerSessionInfo("/Projects/orbis", WorkingBranch("request", "session", "/Projects/orbis", "main")) {
                            RuntimePermissionsStatus(RuntimePermissionManagement("工作区写入", "权限详情", "restricted", emptyList()))
                        }
                    }
                }
            }
        }
        compose.onNodeWithContentDescription("当前会话权限").performClick()
        compose.runOnIdle { narrow.value = true }
        compose.onNodeWithText("权限详情").assertIsDisplayed()
        compose.runOnIdle { narrow.value = false }
        compose.onNodeWithText("权限详情").assertIsDisplayed()
    }

    @Test fun composerHasNoEmptyNoticeSlotAndKeepsCriticalUsageVisibleWithSlashInput() {
        val app = IsolatedTestApplication(ApplicationProvider.getApplicationContext(), "composer-spacing")
        val owner = ViewModelStore()
        val model = RemoteViewModel(app)
        owner.put("composer", model)
        val runtime = RuntimeSummary("runtime", "Codex", "/Projects/orbis", "idle", "session",
            agentKind = "codex", contextUsage = RuntimeContextUsage(24_000, 128_000, 18.75),
            permissionManagement = RuntimePermissionManagement("工作区写入", "权限详情", "restricted", emptyList()))
        val displayed = mutableStateOf(RemoteState(selectedRuntimeId = runtime.runtimeId, runtimes = mapOf(runtime.runtimeId to runtime)))
        try {
            compose.setContent { OrbisTheme { ChatScreen(displayed.value, model) } }
            val density = InstrumentationRegistry.getInstrumentation().targetContext.resources.displayMetrics.density
            val transcript = compose.onNodeWithTag("chat-transcript").fetchSemanticsNode().boundsInRoot
            val field = compose.onNode(hasSetTextAction()).fetchSemanticsNode().boundsInRoot
            assertTrue("Blank area above composer: ${field.top - transcript.bottom}", field.top - transcript.bottom <= 44 * density)
            val context = InstrumentationRegistry.getInstrumentation().targetContext
            File(context.getExternalFilesDir(null), "composer-chat-compact.png").outputStream().use {
                compose.onRoot().captureToImage().asAndroidBitmap().compress(Bitmap.CompressFormat.PNG, 100, it)
            }
            compose.runOnIdle {
                displayed.value = displayed.value.copy(runtimes = mapOf(runtime.runtimeId to runtime.copy(
                    contextUsage = RuntimeContextUsage(121_600, 128_000, 95.0))))
            }
            compose.onNodeWithText("上下文 95%，121k/128k").assertIsDisplayed()
            compose.onNode(hasSetTextAction()).performClick().performTextInput("/")
            compose.onNodeWithText("上下文 95%，121k/128k").assertIsDisplayed()
            compose.onNode(hasSetTextAction()).assertIsDisplayed()
        } finally {
            compose.runOnIdle { owner.clear() }
            app.dispose()
        }
    }
}
