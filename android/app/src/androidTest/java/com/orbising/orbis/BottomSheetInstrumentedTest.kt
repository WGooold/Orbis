package com.orbising.orbis

import android.graphics.Bitmap
import android.os.SystemClock
import android.view.WindowInsets
import androidx.activity.ComponentActivity
import androidx.compose.foundation.layout.*
import androidx.compose.material3.Text
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.dp
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertTrue
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import java.io.File

/** S43 / SC64 / M29: compare full controls with the physical safe viewport, not clipped semantics. */
class BottomSheetInstrumentedTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    @Test fun protocolFooterFitsThePhysicalWindow() {
        compose.setContent { OrbisTheme {
            ProtocolChoiceSheet(RelayTransportMode.AUTO, true, {}, {})
        } }
        capture("protocol")
        assertFullyVisible(compose.onNodeWithTag("relay-mode-WS"))
        assertFullyVisible(compose.onNodeWithTag("protocol-apply"))
    }

    @Test fun languageLastChoiceFitsThePhysicalWindow() {
        compose.setContent { OrbisTheme {
            DesignSettingsScreen(RemoteState(), {}, true, {})
        } }
        compose.onNodeWithTag("settings-language").performScrollTo().performClick()
        capture("language")
        assertFullyVisible(compose.onNodeWithTag("language-en"))
    }

    @Test fun permissionFooterAndLastScrolledOptionFitThePhysicalWindow() {
        compose.setContent { OrbisTheme {
            RuntimePermissionsStatus(RuntimePermissionManagement("权限摘要", "当前权限详情", "restricted", listOf(
                RuntimePermissionSetting("scope", "权限范围", "0", options = (0..15).map {
                    RuntimePermissionOption("$it", "权限选项 $it", "权限选项的说明文字")
                })
            )))
        } }
        compose.onNodeWithContentDescription("当前会话权限").performClick()
        compose.onNodeWithText("权限选项 15").performScrollTo()
        capture("permissions")
        assertFullyVisible(compose.onNodeWithText("权限选项 15"))
        assertFullyVisible(compose.onNodeWithText("应用到当前会话"))
    }

    /** Long choices must scroll independently of the title and reach the last action at large type. */
    @Test fun longChoiceListKeepsItsTitleAndCanRevealItsLastAction() {
        compose.setContent { OrbisTheme {
            val density = LocalDensity.current
            CompositionLocalProvider(LocalDensity provides Density(density.density, 1.6f)) {
                OrbisChoiceSheet("选择工作目录", {}) {
                    repeat(24) { ChoiceRow("工作目录 $it", "完整目录说明", false, "directory-$it") {} }
                    NeumorphActionButton({}, "使用此目录", Modifier.fillMaxWidth().testTag("last-action"))
                }
            }
        } }
        val title = compose.onNodeWithText("选择工作目录").fetchSemanticsNode().positionInWindow
        compose.onNodeWithTag("last-action").performScrollTo()
        assertFullyVisible(compose.onNodeWithTag("last-action"))
        assertEquals(title, compose.onNodeWithText("选择工作目录").fetchSemanticsNode().positionInWindow)
        capture("long-choices")
    }

    @Test fun draftDirectoryBrowserKeepsItsConfirmActionReachable() {
        compose.setContent { OrbisTheme {
            SessionDraftCard(browseState(), true, "/workspace", {}, {}, {}, onSubmit = { _, _, _, _, _ -> false })
        } }
        compose.onNodeWithTag("draft-directory").performClick()
        compose.onNodeWithText("使用此目录").performScrollTo()
        assertFullyVisible(compose.onNodeWithText("使用此目录"))
        capture("directory")
    }

    /** S51 / SC73: browsing up and retrying stay in the sheet instead of pre-running its exit. */
    @Test fun draftDirectoryNavigationKeepsTheSheetAlive() {
        val browsed = mutableListOf<String?>()
        val ups = mutableListOf<String?>()
        val base = browseState()
        val state = mutableStateOf(base.copy(sessionBrowse = base.sessionBrowse!!.copy(
            parent = "/", error = L10n.tr("没有权限读取目录"))))
        compose.setContent { OrbisTheme {
            SessionDraftCard(state.value, true, null, { browsed.add(it) }, {}, { ups.add("up") },
                onSubmit = { _, _, _, _, _ -> false })
        } }
        compose.onNodeWithTag("draft-directory").performClick()
        compose.runOnIdle { browsed.clear() }
        compose.onNodeWithText("重新读取").performClick()
        compose.onNodeWithText("上一级").performClick()
        compose.runOnIdle {
            assertEquals(listOf<String?>("/workspace"), browsed)
            assertEquals(listOf<String?>("up"), ups)
        }
        // A committed exit that the sheet never owns leaves a transparent window behind, so the
        // scrim could no longer close anything. Dismissing proves the sheet still holds its exit.
        compose.onNodeWithTag("orbis-sheet-scrim").performTouchInput { click(Offset(20f, 150f)) }
        compose.waitForIdle()
        compose.onNodeWithTag("orbis-sheet-window").assertDoesNotExist()
    }

    @Test fun downloadBrowserKeepsItsFooterAndOnlyDownloadsAfterExit() {
        val open = mutableStateOf(true)
        val downloads = mutableListOf<String>()
        compose.setContent { OrbisTheme {
            if (open.value) DownloadFileSheet(browseState(), { open.value = false }, {}, {}, {}, { downloads += it })
        } }
        compose.onNodeWithText("report.txt").performClick()
        reveal(compose.onNodeWithText("下载到手机"))
        assertFullyVisible(compose.onNodeWithText("下载到手机"))
        capture("download")
        compose.mainClock.autoAdvance = false
        compose.onNodeWithText("下载到手机").performClick()
        compose.mainClock.advanceTimeByFrame()
        compose.mainClock.advanceTimeBy(64)
        compose.runOnIdle { assertTrue(downloads.isEmpty()) }
        compose.mainClock.advanceTimeBy(400)
        compose.runOnIdle { assertEquals(listOf("/workspace/report.txt"), downloads) }
        compose.onNodeWithTag("orbis-sheet-window").assertDoesNotExist()
    }

    @Test fun toolDetailKeepsPagingAndExportAboveNavigation() {
        val summary = ToolSummary(tool = ToolIdentity(ToolAgent("host", "codex", "session"), "call"),
            toolName = "read", phase = "finished", order = 0)
        compose.setContent { OrbisTheme {
            ToolDetailSheet(ToolDetailView("runtime", summary, "output", text = "file\n".repeat(200), nextCursor = 100),
                {}, {}, {}, {}, {}, {})
        } }
        assertFullyVisible(compose.onNodeWithTag("tool-read-footer"))
        assertFullyVisible(compose.onNodeWithTag("tool-export"))
        assertFullyVisible(compose.onNodeWithText("跟随输出"))
        capture("tool-detail")
    }

    @Test fun fileDiffKeepsPagingAndManifestActionAboveNavigation() {
        val file = FileChangeMetadata("file", "src/example.kt", changeKind = "modified", fileKind = "text", contentVersion = "1", detail = "available")
        val summary = TurnChangeSummary(1, ToolAgent("host", "codex", "session"), "turn", "set", listOf("turn"), 1,
            "entry", 1, 2, "ready", "completed", "complete", "workspace-window", emptyList(), 1, 1, 0, 0, 1, 1, listOf(file), revision = 1)
        val text = "--- a/src/example.kt\n+++ b/src/example.kt\n@@ -1 +1 @@\n-old\n+new\n"
        val viewer = FileChangeViewer("runtime", summary, file.fileId, cache = mapOf(file.fileId to
            FileDiffCache(file, text = text, loaded = true, eof = true, projection = unifiedDiffProjection(text, true))))
        compose.setContent { OrbisTheme {
            FileChangeViewerSheet(viewer, ChangeManifest(summary, listOf(file), loaded = true), {}, {}, {}, {}, { _, _, _ -> })
        } }
        assertFullyVisible(compose.onNodeWithTag("file-change-page"))
        compose.onAllNodesWithText("加载更多文件").fetchSemanticsNodes().takeIf { it.isNotEmpty() }?.let {
            assertFullyVisible(compose.onNodeWithText("加载更多文件"))
        }
        capture("file-diff")
    }

    @Test fun questionnaireKeepsItsLastOptionAndSubmitReachable() {
        val request = PendingInteraction("question", "test", "questionnaire", "选择范围", null, emptyList(), null,
            questions = listOf(QuestionnaireQuestion("scope", "处理哪些目录？",
                (0..12).map { InteractionOption("$it", "目录选项 $it") }, multiSelect = true)))
        compose.setContent { OrbisTheme {
            InteractionWorkspace(listOf(request), true, emptySet(), null, { _, _ -> }, { _, _ -> },
                { _, _ -> }, { _, _ -> }, {})
        } }
        compose.onNodeWithText("目录选项 12").performScrollTo().performClick()
        assertFullyVisible(compose.onNodeWithText("目录选项 12"))
        reveal(compose.onNodeWithText("提交答案"))
        assertFullyVisible(compose.onNodeWithText("提交答案"))
        capture("questionnaire")
    }

    /** M29: prove entrance/exit movement in the actual dialog and commit only after exit. */
    @Test fun entranceAndSelectionExitHaveIntermediateFramesAndCommitOnce() {
        val open = mutableStateOf(false)
        var commits = 0
        compose.setContent { OrbisTheme {
            if (open.value) OrbisChoiceSheet("语言", { open.value = false }) {
                ChoiceRow("English", "", false, "animated-choice", dismissOnSelect = true) {
                    commits++; open.value = false
                }
            }
        } }
        compose.mainClock.autoAdvance = false
        compose.runOnIdle { open.value = true }
        compose.mainClock.advanceTimeByFrame()
        compose.waitForIdle()
        compose.mainClock.advanceTimeByFrame()
        val start = sheetTop()
        compose.mainClock.advanceTimeBy(64)
        val entering = sheetTop()
        capture("enter-middle")
        compose.mainClock.advanceTimeBy(400)
        val settled = sheetTop()
        assertTrue("Entrance must rise after the dialog is laid out: $start, $entering, $settled",
            start > entering + 1 && entering > settled + 1)
        compose.onNodeWithTag("animated-choice").performClick().performClick()
        compose.mainClock.advanceTimeByFrame()
        compose.mainClock.advanceTimeBy(64)
        val exiting = sheetTop()
        capture("exit-middle")
        compose.runOnIdle { assertEquals(0, commits) }
        assertTrue("Exit must move down before removing the window", exiting > settled + 1)
        compose.mainClock.advanceTimeBy(400)
        compose.runOnIdle { assertEquals(1, commits) }
        compose.onNodeWithTag("orbis-sheet-window").assertDoesNotExist()
    }

    /** All cancellation routes keep the dialog alive until the shared exit has finished. */
    @Test fun scrimBackAndGripDismissThroughTheSameExit() {
        val open = mutableStateOf(true)
        var closes = 0
        compose.setContent { OrbisTheme {
            if (open.value) OrbisChoiceSheet("语言", { closes++; open.value = false }) { Text("English") }
        } }
        listOf("scrim", "back", "grip").forEachIndexed { index, route ->
            if (index > 0) {
                compose.mainClock.autoAdvance = true
                compose.runOnIdle { open.value = true }
                compose.waitForIdle()
            }
            compose.mainClock.autoAdvance = false
            when (route) {
                "scrim" -> compose.onNodeWithTag("orbis-sheet-scrim").performTouchInput { click(Offset(20f, 150f)) }
                "back" -> InstrumentationRegistry.getInstrumentation().sendKeyDownUpSync(android.view.KeyEvent.KEYCODE_BACK)
                else -> compose.onNodeWithTag("orbis-sheet-grip").performTouchInput {
                    swipe(center, center + Offset(0f, with(compose.density) { 96.dp.toPx() }), 180)
                }
            }
            compose.mainClock.advanceTimeByFrame()
            compose.mainClock.advanceTimeBy(48)
            compose.runOnIdle { assertEquals("$route must wait for exit", index, closes) }
            compose.onNodeWithTag("orbis-sheet-window").assertExists()
            compose.mainClock.advanceTimeBy(400)
            compose.runOnIdle { assertEquals(index + 1, closes) }
            compose.onNodeWithTag("orbis-sheet-window").assertDoesNotExist()
        }
    }

    @Test fun reducedMotionStillShowsTheFullSheetAndCommitsOnce() {
        fun shell(command: String) = android.os.ParcelFileDescriptor.AutoCloseInputStream(
            InstrumentationRegistry.getInstrumentation().uiAutomation.executeShellCommand(command)
        ).bufferedReader().use { it.readText().trim() }
        val original = shell("settings get global animator_duration_scale")
        try {
            shell("settings put global animator_duration_scale 0")
            compose.waitUntil(5_000) { !android.animation.ValueAnimator.areAnimatorsEnabled() }
            val open = mutableStateOf(true)
            var commits = 0
            compose.setContent { OrbisTheme {
                if (open.value) OrbisChoiceSheet("语言", { open.value = false }) {
                    ChoiceRow("English", "", false, "reduced-choice", dismissOnSelect = true) {
                        commits++; open.value = false
                    }
                }
            } }
            assertFullyVisible(compose.onNodeWithTag("reduced-choice"))
            compose.onNodeWithTag("reduced-choice").performClick()
            compose.runOnIdle { assertEquals(1, commits) }
            compose.onNodeWithTag("orbis-sheet-window").assertDoesNotExist()
        } finally {
            shell(if (original == "null") "settings delete global animator_duration_scale" else "settings put global animator_duration_scale $original")
            compose.waitUntil(5_000) { android.animation.ValueAnimator.areAnimatorsEnabled() == (original != "0" && original != "0.0") }
        }
    }

    private fun sheetTop(): Float = compose.onNodeWithTag("orbis-sheet-surface").fetchSemanticsNode().positionInWindow.y

    private fun reveal(node: SemanticsNodeInteraction) {
        if (generateSequence(node.fetchSemanticsNode().parent) { it.parent }.any { it.config.contains(SemanticsActions.ScrollBy) }) {
            node.performScrollTo()
        }
    }

    private fun browseState() = RemoteState(hostId = "test-host", e2eReady = true, connection = RelayConnection.ONLINE,
        sessionBrowse = SessionBrowseState("browse", "/workspace", entries = listOf(SessionBrowseEntry("report.txt", false, false)) +
            (0..12).map { SessionBrowseEntry("directory-$it", true, false) }, isLoading = false))

    private fun assertFullyVisible(node: SemanticsNodeInteraction) {
        node.assertIsDisplayed()
        val semantic = node.fetchSemanticsNode()
        val full = node.getUnclippedBoundsInRoot()
        val clipped = semantic.boundsInRoot
        val metrics = compose.activity.windowManager.currentWindowMetrics
        val insets = metrics.windowInsets.getInsets(WindowInsets.Type.systemBars() or WindowInsets.Type.displayCutout())
        val position = semantic.positionOnScreen
        val bottom = position.y + semantic.size.height
        assertTrue("Control extends below safe screen: $bottom > ${metrics.bounds.bottom - insets.bottom}",
            bottom <= metrics.bounds.bottom - insets.bottom + 1)
        assertTrue("Control extends above safe screen: $position", position.y >= metrics.bounds.top + insets.top - 1)
        assertTrue("Control extends outside safe screen width: $position / ${semantic.size}",
            position.x >= metrics.bounds.left + insets.left - 1 && position.x + semantic.size.width <= metrics.bounds.right - insets.right + 1)
        assertTrue("Control is clipped: $full vs $clipped", with(compose.density) { (full.bottom - full.top).toPx() } <= clipped.height + 1)
    }

    private fun capture(name: String) {
        compose.waitForIdle()
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        instrumentation.waitForIdleSync()
        // Window composition can be idle before SurfaceFlinger presents the dialog's buffer.
        SystemClock.sleep(250)
        val context = instrumentation.targetContext
        File(context.getExternalFilesDir(null), "bottom-sheet-$name.png").outputStream().use {
            instrumentation.uiAutomation.takeScreenshot().compress(Bitmap.CompressFormat.PNG, 100, it)
        }
    }
}
