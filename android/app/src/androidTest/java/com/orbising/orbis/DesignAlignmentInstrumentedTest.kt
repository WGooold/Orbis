package com.orbising.orbis

import android.graphics.Bitmap
import androidx.compose.foundation.layout.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.unit.dp
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test

/** S34/S35/S37, SC54/SC55/SC56: inspect actual controls without real Host traffic. */
@OptIn(androidx.compose.ui.ExperimentalComposeUiApi::class, androidx.compose.ui.test.ExperimentalTestApi::class)
class DesignAlignmentInstrumentedTest {
    @get:Rule val compose = createComposeRule()
    private fun ready(host: String = "design-host") = RemoteState(hostId = host, hostName = "workstation",
        connection = RelayConnection.ONLINE, e2eReady = true, supportedAgents = setOf("codex","claude","dsh","pi"),
        launchableAgents = setOf("codex","claude","dsh","pi"))

    private fun visualReady(): RemoteState {
        val rows = listOf(
            Triple("dsh", "统一了代理逻辑并添加界面提示", "/Volumes/WD1TB/Orbis/orbis"),
            Triple("codex", "配置 iOS 应用 TestFlight 上传", "/Users/wgooold/.codex/worktrees"),
            Triple("claude", "新拟物菜单栏设计稿实现", "/Volumes/WD1TB/Orbis/orbis"),
            Triple("pi", "整理下载记录与回收空间", "/Users/wgooold"))
        val providers = listOf("codex","claude","dsh","pi").associateWith { kind -> listOf(
            AgentProvider("$kind-local",kind,"本机配置",true,kind=="pi",official=true,subscriptionSupported=kind=="codex"),
            AgentProvider("$kind-relay",kind,"relay-b",false,kind=="pi")) }
        return ready().copy(deviceId = "fixture-device", path = "relay", pathRttMs = 12, relayTransportKind = RelayTransportKind.QUIC,
            runtimes = rows.withIndex().associate { (i,row) -> "visual-$i" to RuntimeSummary("visual-$i",row.second,row.third,
                if (i==0) "running" else "idle", "session-$i",agentKind=row.first,sessionName=row.second) },
            sessions = rows.withIndex().associate { (i,row) -> "session-$i" to SessionCatalogEntry("session-$i",name=row.second,
                cwd=row.third,agentKind=row.first,modifiedAt=10_000L-i) }, providerCatalogs = providers,
            subscriptionQuotas = mapOf("codex" to ProviderQuotaSnapshot("codex-local",SubscriptionQuota(1,listOf(
                SubscriptionWindow("five_hour",80.0,null),SubscriptionWindow("seven_day",15.0,null)))))).withReadyHomeFixture()
    }

    private var captureInputMode: androidx.compose.ui.input.InputModeManager? = null
    private val touchInput = object : androidx.compose.ui.input.InputModeManager {
        override val inputMode = androidx.compose.ui.input.InputMode.Touch
        override fun requestInputMode(inputMode: androidx.compose.ui.input.InputMode) = inputMode == this.inputMode
    }
    private fun capture(name: String) {
        compose.runOnIdle { captureInputMode?.requestInputMode(androidx.compose.ui.input.InputMode.Touch) }
        compose.waitForIdle()
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        File(context.getExternalFilesDir(null), "design-$name.png").outputStream().use {
            compose.onRoot().captureToImage().asAndroidBitmap().compress(Bitmap.CompressFormat.PNG,100,it)
        }
    }

    @Test fun protocolSelectionRequiresAnExplicitApplyAndRespectsOfflineDisablement() {
        val choices = mutableListOf<RelayTransportMode>()
        val enabled = mutableStateOf(true)
        compose.setContent { OrbisTheme { ProtocolChoiceSheet(RelayTransportMode.AUTO, enabled.value, {}) { choices += it } } }
        compose.onNodeWithTag("protocol-apply").assertIsNotEnabled()
        compose.onNodeWithTag("relay-mode-QUIC").performClick()
        compose.runOnIdle { assertTrue(choices.isEmpty()) }
        compose.onNodeWithTag("protocol-apply").assertIsEnabled()
        compose.runOnIdle { enabled.value = false }
        compose.onNodeWithTag("protocol-apply").assertIsNotEnabled()
        compose.runOnIdle { enabled.value = true }
        compose.onNodeWithTag("protocol-apply").performClick()
        compose.runOnIdle { assertEquals(listOf(RelayTransportMode.QUIC),choices) }
    }

    @Test fun localDraftKeepsItsTextUntilAFirstSendSucceedsAndUsesTheCurrentHostDirectory() {
        val state = mutableStateOf(ready())
        val open = mutableStateOf(true)
        var accepted = false
        val submissions = mutableListOf<List<String>>()
        compose.setContent { OrbisTheme {
            SessionDraftCard(state.value, open.value, "/Projects/orbis", {}, {}, {}) { kind,cwd,text,_,_ ->
                submissions += listOf(state.value.hostId.orEmpty(),kind,cwd,text); accepted
            }
        } }
        compose.onNodeWithTag("draft-send").assertIsNotEnabled()
        compose.onNodeWithTag("draft-agent-claude").performClick()
        val input = compose.onNode(hasSetTextAction())
        input.performTextInput("第一句话")
        compose.runOnIdle { assertTrue(submissions.isEmpty()) }
        compose.runOnIdle { open.value = false }
        compose.runOnIdle { open.value = true }
        input.assertTextContains("第一句话")
        compose.onNodeWithTag("draft-send").performClick()
        input.assertTextContains("第一句话")
        compose.runOnIdle { assertEquals(listOf("design-host","claude","/Projects/orbis","第一句话"),submissions.single()); accepted = true }
        compose.onNodeWithTag("draft-send").performClick()
        input.assert(SemanticsMatcher.expectValue(androidx.compose.ui.semantics.SemanticsProperties.EditableText, androidx.compose.ui.text.AnnotatedString("")))
        compose.runOnIdle { state.value = ready("other-host") }
        input.assert(SemanticsMatcher.expectValue(androidx.compose.ui.semantics.SemanticsProperties.EditableText, androidx.compose.ui.text.AnnotatedString("")))
        capture("draft-light")
    }

    /** S34 / SC54: tablet navigation remains visible while right-pane root content changes. */
    @Test fun tabletKeepsTheDirectoryAndMovesTheRootTabsIntoItsSidebar() {
        val app = IsolatedTestApplication(androidx.test.core.app.ApplicationProvider.getApplicationContext(), "design-tablet")
        val tablet = app.resources.configuration.screenWidthDp >= 600
        if (!tablet) app.dispose()
        org.junit.Assume.assumeTrue("Requires an actual >=600dp leased viewport", tablet)
        val owner = androidx.lifecycle.ViewModelStore()
        val model = RemoteViewModel(app); owner.put("tablet", model)
        val state = visualReady()
        val pairing = HostPairing("design-host", "workstation", "pub", "root", relayUrl = "wss://relay.example", deviceId = "fixture-device", credential = "fixture")
        try {
            compose.setContent {
                captureInputMode = androidx.compose.ui.platform.LocalInputModeManager.current
                CompositionLocalProvider(androidx.compose.ui.platform.LocalInputModeManager provides touchInput) {
                    OrbisTheme { RemoteApp(state, listOf(HostSnapshot(pairing,state)), null, false, model) }
                }
            }
            capture("tablet-home")
            compose.onNodeWithTag("home-tab-providers").performClick(); capture("tablet-providers")
            compose.onNodeWithTag("permanent-directory").assertIsDisplayed()
            compose.onNodeWithTag("home-tabs").assertIsDisplayed()
            compose.onNodeWithTag("home-tab-settings").performClick()
            compose.onNodeWithTag("permanent-directory").assertIsDisplayed()
            compose.onNodeWithTag("home-tab-settings").assertIsSelected()
            compose.onNodeWithTag("settings-protocol").assertExists()
            capture("tablet-root")
        } finally { compose.runOnIdle { owner.clear() }; app.dispose() }
    }

    /** Focus never changes the target's measured rectangle, including native external keyboards. */
    @Test fun keyboardFocusUsesTheSameButtonTargetAndRetainsItsActivation() {
        var clicks = 0
        var keyboard: androidx.compose.ui.input.InputModeManager? = null
        compose.setContent { OrbisTheme {
            keyboard = androidx.compose.ui.platform.LocalInputModeManager.current
            androidx.compose.foundation.layout.Column(Modifier.padding(24.dp)) {
                NeumorphActionButton(text = "焦点按钮", onClick = { clicks++ }, modifier = Modifier.testTag("focus-action"))
            }
        } }
        val action = compose.onNodeWithTag("focus-action")
        val before = action.fetchSemanticsNode().boundsInRoot
        compose.runOnIdle { assertTrue(keyboard!!.requestInputMode(androidx.compose.ui.input.InputMode.Keyboard)) }
        action.performSemanticsAction(androidx.compose.ui.semantics.SemanticsActions.RequestFocus) { assertTrue(it()) }
        action.assertIsFocused()
        assertEquals(before, action.fetchSemanticsNode().boundsInRoot)
        action.performClick()
        compose.runOnIdle {
            assertEquals(1, clicks)
            keyboard!!.requestInputMode(androidx.compose.ui.input.InputMode.Touch)
        }
    }


    /** Chinese candidate confirmation must never become the first remote send. */
    @Test fun composingEnterDoesNotSubmitUntilTheImeHasCommittedItsCandidate() {
        val drafts = SessionDraftStore()
        val row = drafts.draft("design-host")
        var sends = 0
        compose.setContent { OrbisTheme {
            SessionDraftCard(ready(), true, "/Projects/orbis", {}, {}, {}, drafts = drafts) { _,_,_,_,_ -> sends++; true }
        } }
        compose.runOnIdle {
            row.text.value = "候选词"
            row.editing.value = androidx.compose.ui.text.input.TextFieldValue("候选词", androidx.compose.ui.text.TextRange(3), androidx.compose.ui.text.TextRange(0,3))
        }
        compose.onNodeWithTag("draft-message").performKeyInput { pressKey(androidx.compose.ui.input.key.Key.Enter) }
        compose.runOnIdle { assertEquals(0, sends); row.editing.value = row.editing.value.copy(composition = null) }
        compose.onNodeWithTag("draft-message").performKeyInput { pressKey(androidx.compose.ui.input.key.Key.Enter) }
        compose.runOnIdle { assertEquals(1, sends) }
    }



    /** SC55: Desktop-only Hosts still expose the existing Codex slot and valid first send. */
    @Test fun desktopOnlyHostKeepsTheCodexSlotUsableWithoutFallingBackToPi() {
        var submitted: String? = null
        compose.setContent { OrbisTheme {
            SessionDraftCard(ready().copy(supportedAgents=setOf("codexDesktop"), launchableAgents=setOf("codexDesktop")),
                true,"/Projects/orbis",{},{},{}) { kind,_,_,_,_ -> submitted=kind;true }
        } }
        compose.onNodeWithTag("draft-agent-codex").assertIsEnabled().performClick()
        compose.onNodeWithText("Codex 桌面版").assertIsDisplayed()
        compose.onNode(hasSetTextAction()).performTextInput("首句")
        compose.onNodeWithTag("draft-send").assertIsEnabled().performClick()
        compose.runOnIdle { assertEquals("codexDesktop",submitted) }
    }

    /** S40 / SC61: choosing Codex with both targets available asks which one to launch. */
    @Test fun tappingCodexOpensAnExplicitTerminalOrDesktopChoice() {
        var submitted: String? = null
        val agents = setOf("codex", "codexDesktop", "claude", "dsh", "pi")
        compose.setContent { OrbisTheme {
            SessionDraftCard(ready().copy(supportedAgents = agents, launchableAgents = agents), true,
                "/Projects/orbis", {}, {}, {}) { kind, _, _, _, _ -> submitted = kind; true }
        } }
        compose.onNodeWithText("Codex 终端版").assertIsDisplayed()
        compose.onNodeWithTag("draft-codex-version").performClick()
        compose.onAllNodesWithText("Codex 终端版").onLast().assertIsDisplayed()
        compose.onNodeWithText("Codex 桌面版").assertIsDisplayed()
        compose.onNodeWithText("Codex 桌面版").performClick()
        compose.onNodeWithText("Codex 桌面版").assertIsDisplayed()
        compose.onNode(hasSetTextAction()).performTextInput("首句")
        compose.onNodeWithTag("draft-send").performClick()
        compose.runOnIdle { assertEquals("codexDesktop", submitted) }
    }

    /** S35: the inline card and flat directory remain usable on the smallest supported phone. */
    @Test fun narrowDraftKeepsThePathAgentTargetsAndSendInsideItsCard() {
        compose.setContent { OrbisTheme {
            CompositionLocalProvider(androidx.compose.ui.platform.LocalInputModeManager provides touchInput) {
                Box(Modifier.width(320.dp)) { SessionDraftCard(visualReady(), true, "/Volumes/WD1TB/Orbis/orbis", {}, {}, {}) { _,_,_,_,_ -> true } }
            }
        } }
        val card = compose.onNodeWithTag("session-draft").fetchSemanticsNode().boundsInRoot
        for (tag in listOf("draft-directory","draft-send","draft-agent-codex","draft-agent-claude","draft-agent-dsh","draft-agent-pi")) {
            val bounds = compose.onNodeWithTag(tag).assertIsDisplayed().fetchSemanticsNode().boundsInRoot
            assertTrue("$tag fits", bounds.left >= card.left && bounds.right <= card.right)
        }
        compose.waitUntil(2500) {
            compose.onAllNodes(isFocused()).fetchSemanticsNodes().any { it.config.contains(androidx.compose.ui.semantics.SemanticsProperties.EditableText) }
        }
        capture("draft-narrow-touch")
    }

    /** Rejected input leaves the draft and never registers a session.activate operation. */
    @Test fun invalidFirstMessageNeverCreatesAnEmptyRemoteSession() {
        val app = IsolatedTestApplication(androidx.test.core.app.ApplicationProvider.getApplicationContext(), "design-invalid")
        val scope = kotlinx.coroutines.CoroutineScope(kotlinx.coroutines.SupervisorJob() + kotlinx.coroutines.Dispatchers.Main)
        val pairing = HostPairing("design-host", "workstation", "pub", "root", relayUrl = "wss://relay.example", deviceId = "fixture-device", credential = "fixture")
        val connection = HostConnection(app, scope, pairing, HostStores(app), { X25519KeyPair.generate() }, {})
        val drafts = SessionDraftStore()
        try {
            compose.setContent { OrbisTheme {
                SessionDraftCard(ready(), true, "/Projects/orbis", {}, {}, {}, drafts = drafts) { kind,cwd,text,_,_ ->
                    connection.sendFirstSessionMessage(kind,cwd,text,"design-host") != null
                }
            } }
            compose.onNode(hasSetTextAction()).performTextInput("/help")
            compose.onNodeWithTag("draft-send").performClick()
            compose.onNode(hasSetTextAction()).assertTextContains("/help")
            compose.runOnIdle {
                assertTrue(connection.state.value.sessionActivateRequests.isEmpty())
                assertNull(connection.state.value.launchPage)
                assertEquals("斜杠命令只能从当前会话提供的菜单中选择",connection.state.value.error)
                assertNull(connection.sendFirstSessionMessage("codex","/Projects/orbis","x".repeat(100_001),"design-host"))
                assertTrue(connection.state.value.sessionActivateRequests.isEmpty())
                assertTrue(connection.state.value.error.orEmpty().contains("100000"))
                // Isolated in-memory ledger fixture: one free slot cannot own both activate and first send.
                val mutable = HostConnection::class.java.getDeclaredField("mutableState").apply { isAccessible = true }
                    .get(connection) as kotlinx.coroutines.flow.MutableStateFlow<RemoteState>
                mutable.value = ready().copy(ledger=OperationLedger(capacity=1))
                assertNull(connection.sendFirstSessionMessage("codex","/Projects/orbis","valid first message","design-host"))
                assertTrue(connection.state.value.sessionActivateRequests.isEmpty())
                assertNull(connection.state.value.launchPage)
                assertEquals("待发送的消息过多，请稍后重试",connection.state.value.error)
            }
        } finally { scope.coroutineContext[kotlinx.coroutines.Job]?.cancel(); app.dispose() }
    }

    /** The complete root includes peer navigation; isolated page captures omit that context. */
    @Test fun completePhoneRootKeepsItsTabsAcrossDraftProviderAndSettings() {
        val app = IsolatedTestApplication(androidx.test.core.app.ApplicationProvider.getApplicationContext(), "design-phone")
        val owner = androidx.lifecycle.ViewModelStore()
        val model = RemoteViewModel(app); owner.put("phone", model)
        val state = visualReady()
        val pairing = HostPairing("design-host", "workstation", "pub", "root", relayUrl = "wss://relay.example", deviceId = "fixture-device", credential = "fixture")
        try {
            compose.setContent {
                captureInputMode = androidx.compose.ui.platform.LocalInputModeManager.current
                CompositionLocalProvider(androidx.compose.ui.platform.LocalInputModeManager provides touchInput) {
                    OrbisTheme { RemoteApp(state, listOf(HostSnapshot(pairing,state)), null, false, model) }
                }
            }
            compose.onNodeWithTag("home-tabs").assertIsDisplayed(); capture("root-home")
            compose.onNodeWithTag("home-new-session").performTouchInput { click() }
            compose.waitUntil(2500) {
                compose.onAllNodes(isFocused()).fetchSemanticsNodes().any { it.config.contains(androidx.compose.ui.semantics.SemanticsProperties.EditableText) }
            }
            capture("root-draft")
            compose.onNodeWithTag("home-tab-providers").performTouchInput { click() }; capture("root-providers")
            compose.onNodeWithTag("home-tab-settings").performTouchInput { click() }; capture("root-settings")
        } finally { compose.runOnIdle { owner.clear() }; app.dispose() }
    }

    /** S37: explicit draft card heights match the source without losing protocol access. */
    @Test fun settingsCardDensityMatchesTheDraftAt320And358Dp() {
        var density: androidx.compose.ui.unit.Density? = null
        val width = mutableStateOf(358)
        compose.setContent { OrbisTheme {
            density=androidx.compose.ui.platform.LocalDensity.current
            Box(Modifier.width(width.value.dp).height(812.dp)) { DesignSettingsScreen(visualReady(),{},true,{}) }
        } }
        for (value in listOf(358,320)) {
            compose.runOnIdle { width.value=value }
            val connection=compose.onNodeWithTag("settings-connection-group").fetchSemanticsNode().boundsInRoot
            assertEquals(120f,with(density!!) { connection.height.toDp().value },0.6f)
            compose.onNodeWithTag("settings-language").performScrollTo()
            val language=compose.onNodeWithTag("settings-language-group").fetchSemanticsNode().boundsInRoot
            assertEquals(64f,with(density!!) { language.height.toDp().value },0.6f)
            compose.onNodeWithTag("settings-protocol").performScrollTo().performClick()
            compose.onNodeWithTag("relay-mode-WS").assertIsDisplayed()
            compose.onNodeWithTag("protocol-apply").assertIsNotEnabled()
            androidx.test.platform.app.InstrumentationRegistry.getInstrumentation().uiAutomation.performGlobalAction(android.accessibilityservice.AccessibilityService.GLOBAL_ACTION_BACK)
            compose.waitForIdle()
            compose.waitUntil(2_000) { compose.onAllNodesWithTag("orbis-choice-sheet").fetchSemanticsNodes().isEmpty() }
            capture("settings-density-$value")
        }
    }

    @Test fun appearanceModesAndBothMaterialsChangeEverySurfaceWithoutChangingSettingsStructure() {
        val oldMode = AppAppearance.mode; val oldMaterial = AppAppearance.material
        try {
            compose.runOnIdle { AppAppearance.selectMode(OrbisAppearanceMode.Light); AppAppearance.selectMaterial(OrbisMaterial.Mist) }
            compose.setContent { OrbisTheme { DesignSettingsScreen(ready(),{},true,{}) } }
            capture("settings-mist-light")
            compose.onNodeWithTag("appearance-dark").performScrollTo().performClick()
            compose.runOnIdle { assertEquals(OrbisAppearanceMode.Dark,AppAppearance.mode) }
            capture("settings-mist-dark")
            compose.onNodeWithTag("appearance-material-sage").performScrollTo().performClick()
            compose.runOnIdle { assertEquals(OrbisMaterial.Sage,AppAppearance.material) }
            capture("settings-sage-dark")
            compose.onNodeWithTag("appearance-light").performScrollTo().performClick()
            capture("settings-sage-light")
            compose.onNodeWithTag("appearance-system").performScrollTo().performClick()
            compose.runOnIdle { assertEquals(OrbisAppearanceMode.System,AppAppearance.mode) }
            compose.onNodeWithTag("settings-protocol").performScrollTo().assertIsDisplayed()
            compose.onNodeWithText("配对信息").assertDoesNotExist()
        } finally { compose.runOnIdle { AppAppearance.selectMode(oldMode); AppAppearance.selectMaterial(oldMaterial) } }
    }
}
