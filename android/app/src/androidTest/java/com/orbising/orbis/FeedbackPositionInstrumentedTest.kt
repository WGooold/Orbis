// Orbis 测试用途（场景与判定见本文件断言）：
// - F1/F3/F4 错误与提示位置几何核验：确认顶栏、底部导航、聊天浮层（交互卡片/回到最新/F3）、离线历史与卡片/抽屉行不重叠、不挤压标题。
package com.orbising.orbis

import android.graphics.Bitmap
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.lifecycle.ViewModelStore
import androidx.test.core.app.ApplicationProvider
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

class FeedbackPositionInstrumentedTest {
    @get:Rule val compose = createComposeRule()

    private val pairing = HostPairing(
        hostId = "pos-host",
        hostName = "Workstation",
        hostPub = "test-public",
        pskRoot = "test-root",
        relayUrl = "wss://relay.example",
        deviceId = "pos-device",
        credential = "test-only",
    )

    private fun assertNoOverlap(aName: String, a: Rect, bName: String, b: Rect) {
        val intersects = a.left < b.right - 1f && a.right > b.left + 1f && a.top < b.bottom - 1f && a.bottom > b.top + 1f
        assertFalse("$aName ($a) must not overlap $bName ($b)", intersects)
    }

    private fun assertAbove(upperName: String, upper: Rect, lowerName: String, lower: Rect) {
        assertNoOverlap(upperName, upper, lowerName, lower)
        assertTrue("$upperName (bottom=${upper.bottom}) must sit above $lowerName (top=${lower.top})", upper.bottom <= lower.top + 2f)
    }

    private fun capture(name: String) {
        compose.waitForIdle()
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val dir = File(context.getExternalFilesDir(null), "feedback-positions").apply { mkdirs() }
        File(dir, "$name.png").outputStream().use {
            assertTrue(InstrumentationRegistry.getInstrumentation().uiAutomation.takeScreenshot().compress(Bitmap.CompressFormat.PNG, 100, it))
        }
    }

    @Test fun homeBannerDocksAboveTopBarToastClearsTabsAndBannerHidesOnPairing() {
        val app = IsolatedTestApplication(ApplicationProvider.getApplicationContext(), "fb-home")
        val owner = ViewModelStore()
        val model = RemoteViewModel(app)
        owner.put("fb-home", model)
        val banner = AppFeedback("pairing-expired", "这台手机的配对已失效", FeedbackLevel.F4, FeedbackCondition.PAIRING, FeedbackAction.REPAIR)
        val toast = AppFeedback("draft-kept", "草稿已保留", FeedbackLevel.F3, action = FeedbackAction.UNDO)
        val state = RemoteState(
            hostId = pairing.hostId,
            hostName = pairing.hostName,
            deviceId = pairing.deviceId,
            e2eReady = true,
            connection = RelayConnection.ONLINE,
            feedback = FeedbackState(foreground = true).present(banner).present(toast),
            runtimes = mapOf(
                "r1" to RuntimeSummary("r1", "整理错误提示位置", "/repo/orbis", "idle", "s1", agentKind = "codex", model = RuntimeModelInfo("openai", "gpt-5.4")),
            ),
            sessions = mapOf("s1" to SessionCatalogEntry("s1", name = "整理错误提示位置", cwd = "/repo/orbis", agentKind = "codex")),
        ).withReadyHomeFixture()
        try {
            compose.setContent {
                OrbisTheme {
                    RemoteApp(state, listOf(HostSnapshot(pairing, state)), null, false, model)
                }
            }
            compose.waitForIdle()
            val f4 = compose.onNodeWithTag("feedback-f4").assertIsDisplayed().fetchSemanticsNode().boundsInRoot
            val menuBtn = compose.onNodeWithContentDescription("打开会话目录").assertIsDisplayed().fetchSemanticsNode().boundsInRoot
            val newBtn = compose.onNodeWithContentDescription("新建会话").assertIsDisplayed().fetchSemanticsNode().boundsInRoot
            val f3 = compose.onNodeWithTag("feedback-f3").assertIsDisplayed().fetchSemanticsNode().boundsInRoot
            val tabs = compose.onNodeWithTag("home-tabs").assertIsDisplayed().fetchSemanticsNode().boundsInRoot

            assertAbove("F4 banner", f4, "TopBar menu", menuBtn)
            assertAbove("F4 banner", f4, "TopBar new session", newBtn)
            assertAbove("F3 toast", f3, "HomeTabBar", tabs)
            capture("android-home-f4-f3")

            // Tapping "重新配对" opens PairingScreen where F4 must hide so the cancel button stays reachable.
            compose.onNodeWithText("重新配对", useUnmergedTree = true).performClick()
            compose.waitForIdle()
            compose.onNodeWithTag("feedback-f4").assertDoesNotExist()
            compose.onNodeWithContentDescription("取消添加电脑").assertIsDisplayed()
            capture("android-pairing-no-f4")
        } finally {
            compose.runOnIdle { owner.clear() }
            app.dispose()
        }
    }

    @Test fun homeCardAndDrawerErrorsDoNotCrushMetadataOrTitles() {
        val runtime = RuntimeSummary("r1", "整理错误提示", "/repo/orbis", "running", "s1", agentKind = "codex", model = RuntimeModelInfo("openai", "gpt-5.4"))
        val session = SessionCatalogEntry("s1", name = "很长的会话标题用于确认不会被挤压", cwd = "/repo/orbis", agentKind = "codex", modifiedAt = 1000L)
        val state = RemoteState(
            hostId = pairing.hostId,
            hostName = pairing.hostName,
            deviceId = pairing.deviceId,
            e2eReady = true,
            connection = RelayConnection.ONLINE,
            runtimes = mapOf("r1" to runtime),
            sessions = mapOf("s1" to session),
            sessionOperationErrors = mapOf("r1" to "后台任务尚未结束，暂不能关闭会话。", "s1" to "归档未完成，请重试"),
        ).withReadyHomeFixture()

        val showDrawer = mutableStateOf(false)
        compose.setContent {
            OrbisTheme {
                if (!showDrawer.value) {
                    RuntimeListScreen(
                        state, listOf(HostSnapshot(pairing, state)),
                        onOpenRuntime = { _, _ -> }, onCloseRuntimes = { _, _, _, _ -> emptySet() },
                        onOpenDownloads = {}, onUnpairHost = {}, onOpenSession = { _, _ -> }, onOpenHistory = { _, _ -> },
                        onNewSession = { _, _ -> }, onSetArchived = { _, _, _ -> }, onSelectHost = {}, onAddHost = {},
                        onOpenStatus = {}, onRequestProviders = {},
                    )
                } else {
                    SessionDrawer(
                        state = state, hosts = listOf(HostSnapshot(pairing, state)), isOpen = true,
                        onSelectHost = {}, onUnpairHost = {}, onAddHost = {},
                        onOpenSession = { _, _ -> }, onOpenHistory = { _, _ -> }, onNewSession = { _, _ -> },
                        onSetArchived = { _, _, _ -> }, permanent = true,
                    )
                }
            }
        }
        compose.waitForIdle()
        val modelText = compose.onNodeWithText("GPT 5.4", useUnmergedTree = true).assertIsDisplayed().fetchSemanticsNode().boundsInRoot
        val cardError = compose.onNodeWithTag("home-card-error-r1", useUnmergedTree = true).assertIsDisplayed().fetchSemanticsNode().boundsInRoot
        assertTrue("Model label must retain readable width, got ${modelText.width}", modelText.width > 30f)
        assertAbove("Card metadata", modelText, "Card error row", cardError)
        capture("android-home-card-error")

        compose.runOnIdle { showDrawer.value = true }
        compose.waitForIdle()
        val drawerTitle = compose.onNodeWithText("很长的会话标题用于确认不会被挤压", useUnmergedTree = true).assertIsDisplayed().fetchSemanticsNode().boundsInRoot
        val drawerError = compose.onNodeWithTag("drawer-session-error-s1", useUnmergedTree = true).assertIsDisplayed().fetchSemanticsNode().boundsInRoot
        assertTrue("Drawer title must retain readable width, got ${drawerTitle.width}", drawerTitle.width > 60f)
        assertAbove("Drawer title", drawerTitle, "Drawer error row", drawerError)
        capture("android-drawer-row-error")
    }

    @Test fun chatBannerStatusErrorNotificationsJumpInteractionAndToastNeverOverlap() {
        val app = IsolatedTestApplication(ApplicationProvider.getApplicationContext(), "fb-chat")
        val owner = ViewModelStore()
        val model = RemoteViewModel(app)
        owner.put("fb-chat", model)
        val messages = (1..20).flatMap { index ->
            listOf(
                ChatMessage("u$index", "user", listOf(RemoteContent("text", "第 $index 个问题")), index.toLong()),
                ChatMessage("a$index", "assistant", listOf(RemoteContent("text", (1..6).joinToString("\n\n") { "第 $index 轮回复内容段落 $it" })), index.toLong()),
            )
        }
        val interaction = PendingInteraction(
            requestId = "req-1",
            extensionId = "codex",
            kind = "confirm",
            title = "允许执行验证命令？",
            description = "运行脚本以核对提示位置",
            options = emptyList(),
            placeholder = null,
        )
        val runtimeNotice = RuntimeNotice("n1", "codex", "n1", "one", NoticeScope(), "warning", "沙箱需要配置", "condition", 1, 1, "confirmed")
        val banner = AppFeedback("host-closed", "电脑端 Orbis 未打开，打开后会自动连接", FeedbackLevel.F4, FeedbackCondition.COMPUTER_UNAVAILABLE, FeedbackAction.RECHECK)
        val toast = AppFeedback("saved", "已复制内容", FeedbackLevel.F3, action = FeedbackAction.UNDO)
        val state = RemoteState(
            hostId = pairing.hostId,
            hostName = pairing.hostName,
            deviceId = pairing.deviceId,
            e2eReady = true,
            connection = RelayConnection.ONLINE,
            selectedRuntimeId = "r1",
            notificationEpoch = pairing.hostId,
            feedback = FeedbackState(foreground = true).present(banner).present(toast),
            runtimes = mapOf("r1" to RuntimeSummary("r1", "测试对话", "/repo/orbis", "idle", "s1", agentKind = "codex", model = RuntimeModelInfo("openai", "gpt-5.4"))),
            sessions = mapOf("s1" to SessionCatalogEntry("s1", name = "测试对话", cwd = "/repo/orbis", agentKind = "codex")),
            conversations = mapOf(
                "r1" to RuntimeConversation(
                    messages = messages,
                    interactions = mapOf("req-1" to interaction),
                    operationError = "一次最多发送 10 个文件",
                    chatSyncError = "会话同步失败，请重试",
                ),
            ),
            notificationProjections = mapOf(
                "r1" to NoticeProjection(pairing.hostId, 1, "s1", "confirmed", listOf(runtimeNotice), complete = true),
            ),
        ).withReadyHomeFixture()

        val listState = LazyListState()
        lateinit var scope: CoroutineScope
        try {
            compose.setContent {
                scope = rememberCoroutineScope()
                OrbisTheme {
                    // Use RemoteApp layout contract for docked F4 + F3 over ChatScreen with controllable scroll.
                    val visibleBanner = state.feedback.banner
                    val bannerTransition = androidx.compose.runtime.remember { androidx.compose.animation.core.MutableTransitionState(true) }
                    val geometry = LocalFeedbackGeometry.current
                    androidx.compose.foundation.layout.Column(Modifier.fillMaxSize()) {
                        FeedbackBannerSlot(visibleBanner, bannerTransition, onDismiss = {}) {}
                        Box(Modifier.weight(1f)) {
                            ChatScreen(state, model, scrollState = listState)
                            FeedbackOverlay(
                                notice = state.feedback.toast,
                                bottom = true,
                                anchor = listOfNotNull(geometry.composerTop, geometry.chatOverlayTop).minOrNull(),
                                onDismiss = {},
                                onAction = {},
                            )
                        }
                    }
                }
            }
            compose.waitForIdle()
            // Scroll to top so JumpToLatest becomes visible simultaneously with InteractionWorkspace and F3 toast.
            compose.runOnIdle { scope.launch { listState.scrollToItem(1, 0) } }
            compose.waitForIdle()
            compose.onNodeWithTag("chat-transcript").performTouchInput { swipeDown() }
            compose.waitForIdle()

            val f4 = compose.onNodeWithTag("feedback-f4").assertIsDisplayed().fetchSemanticsNode().boundsInRoot
            val back = compose.onNodeWithContentDescription("返回").assertIsDisplayed().fetchSemanticsNode().boundsInRoot
            val statusErr = compose.onNodeWithTag("chat-status-error").assertIsDisplayed().fetchSemanticsNode().boundsInRoot
            val notice = compose.onNodeWithText("沙箱需要配置").assertIsDisplayed().fetchSemanticsNode().boundsInRoot
            val f3 = compose.onNodeWithTag("feedback-f3").assertIsDisplayed().fetchSemanticsNode().boundsInRoot
            val jump = compose.onNodeWithContentDescription("回到最新消息").assertIsDisplayed().fetchSemanticsNode().boundsInRoot
            val allow = compose.onNodeWithText("允许").assertIsDisplayed().fetchSemanticsNode().boundsInRoot
            val composerErr = compose.onNodeWithTag("composer-error").assertIsDisplayed().fetchSemanticsNode().boundsInRoot

            assertAbove("F4 banner", f4, "Chat TopBar back", back)
            assertAbove("Chat TopBar back", back, "Chat status error", statusErr)
            assertAbove("Chat status error", statusErr, "Runtime notification", notice)
            compose.onNodeWithText("通知状态待核对").assertDoesNotExist()
            assertAbove("F3 toast", f3, "JumpToLatest", jump)
            assertAbove("JumpToLatest", jump, "Interaction allow button", allow)
            assertAbove("Interaction allow button", allow, "Composer inline error", composerErr)
            assertTrue("Composer inline error must have horizontal padding, got left=${composerErr.left}", composerErr.left > 10f)
            capture("android-chat-all-layers")
        } finally {
            compose.runOnIdle { owner.clear() }
            app.dispose()
        }
    }

    @Test fun offlineHistoryWarningCardsAndRetryButtonsDoNotOverlap() {
        val app = IsolatedTestApplication(ApplicationProvider.getApplicationContext(), "fb-offline")
        val owner = ViewModelStore()
        val model = RemoteViewModel(app)
        owner.put("fb-offline", model)
        val offlineKey = "offline:s1"
        val state = RemoteState(
            hostId = pairing.hostId,
            deviceId = pairing.deviceId,
            selectedOfflineSessionId = "s1",
            sessions = mapOf("s1" to SessionCatalogEntry("s1", name = "离线历史", agentKind = "codex")),
            sessionReads = mapOf(
                "first" to SessionReadOperation("first", offlineKey, pairing.deviceId, pairing.hostId, "s1", null, null, 0, null,
                    kind = SessionReadKind.FIRST_PAGE, phase = SessionReadPhase.FAILED, error = "首屏读取失败"),
                "page" to SessionReadOperation("page", offlineKey, pairing.deviceId, pairing.hostId, "s1", "leaf", "old", 0, null,
                    kind = SessionReadKind.HISTORY, phase = SessionReadPhase.FAILED, error = "更早历史读取失败"),
            ),
        )
        try {
            compose.setContent {
                OrbisTheme {
                    OfflineHistoryScreen(state, "s1", model, onBack = {})
                }
            }
            compose.waitForIdle()
            val firstWarn = compose.onNodeWithText("首屏读取失败").assertIsDisplayed().fetchSemanticsNode().boundsInRoot
            val firstRetry = compose.onNodeWithText("重试读取").assertIsDisplayed().fetchSemanticsNode().boundsInRoot
            val histWarn = compose.onNodeWithText("更早历史读取失败").assertIsDisplayed().fetchSemanticsNode().boundsInRoot
            val histRetry = compose.onNodeWithText("重试历史加载").assertIsDisplayed().fetchSemanticsNode().boundsInRoot

            assertAbove("First read warning", firstWarn, "Retry first read", firstRetry)
            assertAbove("History read warning", histWarn, "Retry history load", histRetry)
            capture("android-offline-history-errors")
        } finally {
            compose.runOnIdle { owner.clear() }
            app.dispose()
        }
    }

    @Test fun modelConfigAndHistoryTreeErrorsSuppressLoadingAndShowRetry() {
        val modelCmd = RuntimeSlashCommand(
            name = "model",
            description = "选择模型",
            source = "builtin",
            argument = RuntimeSlashCommandArgument("select", required = true, optionCatalog = MenuOptionCatalog(id = "cat-m", count = 5)),
        )
        val treeCmd = RuntimeSlashCommand(
            name = "tree",
            description = "历史分支",
            source = "builtin",
            argument = RuntimeSlashCommandArgument("tree", required = true, optionCatalog = MenuOptionCatalog(id = "cat-t", count = 8)),
        )
        val state = RemoteState(
            hostId = pairing.hostId,
            e2eReady = true,
            runtimes = mapOf("r1" to RuntimeSummary("r1", "Codex", "/repo", "idle", "s1", agentKind = "codex")),
            capabilities = mapOf("r1" to RuntimeCapabilities(listOf(modelCmd, treeCmd))),
            menuOptionErrors = mapOf(
                "r1:model" to "命令选项读取失败，请重新打开菜单",
                "r1:tree" to "命令选项读取失败，请重新打开菜单",
            ),
        )
        val showTree = mutableStateOf(false)
        compose.setContent {
            OrbisTheme {
                if (!showTree.value) {
                    SessionModelConfigurationSheet(
                        state = state, runtimeId = "r1", onClose = {},
                        setting = "model", onSettingChange = {}, onSelect = { _, _ -> null },
                        onVerify = {}, onRetryOptions = {},
                    )
                } else {
                    HistoryTreePage(
                        state = state, runtimeId = "r1", sessionId = "s1",
                        pendingNodeId = null, actionError = state.menuOptionErrors["r1:tree"],
                        onBack = {}, onContinueFrom = {}, onEditAndRestart = {},
                        downloadArtifact = {}, downloadFile = {}, onRetryTree = {},
                    )
                }
            }
        }
        compose.waitForIdle()
        compose.onNodeWithTag("session-config-menu-error").assertIsDisplayed()
        compose.onNodeWithText("重试").assertIsDisplayed()
        compose.onNodeWithText("加载中…").assertDoesNotExist()
        capture("android-model-config-error")

        compose.runOnIdle { showTree.value = true }
        compose.waitForIdle()
        compose.onNodeWithTag("history-tree-error").assertIsDisplayed()
        compose.onNodeWithText("重试").assertIsDisplayed()
        compose.onNodeWithText("读取中…").assertDoesNotExist()
        capture("android-history-tree-error")
    }
}
