package com.orbising.orbis

import android.graphics.Bitmap
import androidx.compose.runtime.*
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.unit.dp
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test

/** S36 / SC57: browsing never applies; a settled explicit action confirms the exact Host/profile. */
@OptIn(androidx.compose.ui.ExperimentalComposeUiApi::class, androidx.compose.ui.test.ExperimentalTestApi::class)
class ProviderDialInstrumentedTest {
    @get:Rule val compose = createComposeRule()
    private val changes = mutableListOf<Pair<AgentProvider,String?>>()
    private val queries = mutableListOf<AgentProvider>()
    private val enablementChanges = mutableListOf<Triple<String, Boolean, AgentDialReview?>>()
    private var keyboard: androidx.compose.ui.input.InputModeManager? = null
    private fun profiles(kind: String) = listOf(
        AgentProvider("$kind-local",kind,"本机配置",true,kind=="pi",official=true,subscriptionSupported=kind=="codex"),
        AgentProvider("$kind-relay",kind,"relay-b",false,kind=="pi"))
    private fun ready(host: String="dial-host") = RemoteState(hostId=host,hostName="workstation",e2eReady=true,
        connection=RelayConnection.ONLINE,providerCatalogs=listOf("codex","claude","dsh","pi").associateWith(::profiles))
    private fun show(state: MutableState<RemoteState>, dark: Boolean=false) {
        compose.setContent { OrbisTheme(darkTheme=dark) {
            keyboard=androidx.compose.ui.platform.LocalInputModeManager.current
            ProviderDialScreen(state.value, emptyList(), {}, {}, { provider,host -> changes += provider to host },
                { provider,_ -> queries += provider },showBack=false)
        } }
    }
    private fun progress(tag: String,value: Float) {
        compose.onNodeWithTag(tag).performSemanticsAction(SemanticsActions.SetProgress) { assertTrue(it(value)) }
        compose.waitForIdle()
    }
    private fun capture(name: String) {
        val context=InstrumentationRegistry.getInstrumentation().targetContext
        File(context.getExternalFilesDir(null),"design-provider-$name.png").outputStream().use {
            compose.onRoot().captureToImage().asAndroidBitmap().compress(Bitmap.CompressFormat.PNG,100,it)
        }
    }
    /** S42 / SC63: browsing stays local until the exact selection is explicitly confirmed. */
    @Test fun browsingAndCancelledConfirmationNeverWriteAndApplyingNamesBothAgentAndProfile() {
        show(mutableStateOf(ready()))
        compose.onNodeWithText("供应商").assertIsDisplayed()
        val computer = compose.onNodeWithText("workstation").fetchSemanticsNode().boundsInRoot
        val summary = compose.onNodeWithTag("provider-summary").assertIsDisplayed().fetchSemanticsNode().boundsInRoot
        assertEquals(computer.center.y,summary.center.y,1f)
        assertTrue(computer.right < summary.left)
        compose.onNodeWithTag("provider-apply").assertIsNotEnabled()
        progress("provider-arc",1f)
        compose.runOnIdle { assertTrue(changes.isEmpty()) }
        compose.onNodeWithTag("provider-apply").assertIsEnabled().performClick()
        compose.onNodeWithText("切换 Codex 到 relay-b？").assertIsDisplayed()
        compose.onNodeWithText("取消").performClick()
        compose.runOnIdle { assertTrue(changes.isEmpty()) }
        compose.onNodeWithTag("provider-apply").performClick()
        compose.onNodeWithText("切换并重载 Agent", useUnmergedTree = true).performClick()
        compose.runOnIdle { assertEquals(listOf(profiles("codex")[1] to "dial-host"),changes) }
        capture("light")
    }
    /** AGENT-DIAL-04: facts growing below the dial scroll in their own share; the disc never moves or resizes. */
    @Test fun dialKeepsItsFrameWhenTheFactsBelowGrow() {
        val state = mutableStateOf(ready())
        show(state)
        val before = compose.onNodeWithTag("provider-dual-dial").fetchSemanticsNode().boundsInRoot
        compose.runOnIdle { state.value = state.value.copy(providerCatalogProblems = mapOf("codex" to
            List(12) { "无法读取供应商目录" }.joinToString("，"))) }
        compose.onNodeWithTag("provider-catalog-problem").assertExists()
        assertEquals(before, compose.onNodeWithTag("provider-dual-dial").fetchSemanticsNode().boundsInRoot)
    }
    /** AGENT-DIAL-05: quota, running sessions, an empty disabled slot and error prompts never move the action between Agents. */
    @Test fun actionHoldsItsPlaceAcrossAgentsWithDifferentFacts() {
        val revision = 3L
        val rows = listOf(AgentEnablementRow("codex", "Codex CLI", true), AgentEnablementRow("claude", "Claude Code", true),
            AgentEnablementRow("dsh", "DeepSeek", false), AgentEnablementRow("pi", "Pi", true))
        val session = RuntimeSummary("claude-run", "Claude", "/repo", "idle", sessionId = "claude-session", agentKind = "claude", sessionName = "Refactor")
        show(mutableStateOf(ready().copy(agentEnablementAvailable = true, agentEnablementRevision = revision, agentEnablementRows = rows,
            agentDial = AgentDialSync(cached = AgentDialSnapshot(revision, rows), synchronized = true),
            runtimes = mapOf(session.runtimeId to session), providerCatalogProblems = mapOf("pi" to "无法读取供应商目录"))))
        fun actionTop(index: Int): Float {
            progress("provider-agent-reel", index.toFloat())
            return compose.onNodeWithTag("provider-apply").fetchSemanticsNode().boundsInRoot.top
        }
        val codex = actionTop(0)
        compose.onNodeWithTag("provider-quota-five_hour").assertExists()
        assertEquals(codex, actionTop(1), 0.5f)
        compose.onNodeWithTag("provider-running-sessions").assertExists()
        assertEquals(codex, actionTop(2), 0.5f)
        compose.onNodeWithText("启用 DeepSeek").assertExists()
        assertEquals(codex, actionTop(3), 0.5f)
        // The first prompt sits on the line under the action and stays in view without scrolling.
        val action = compose.onNodeWithTag("provider-apply").fetchSemanticsNode().boundsInRoot
        val problem = compose.onNodeWithTag("provider-catalog-problem").assertIsDisplayed().fetchSemanticsNode().boundsInRoot
        assertTrue(problem.top >= action.bottom)
        assertTrue(problem.bottom <= compose.onRoot().fetchSemanticsNode().boundsInRoot.bottom)
    }
    /** S36 / SC57: refresh is not hidden once a reading exists; each tap reaches a new query and failures stay visible. */
    @Test fun quotaRefreshStaysAvailableAfterTheFirstReading() {
        val provider = profiles("codex").first()
        val reading = SubscriptionQuota(1_000, listOf(SubscriptionWindow("five_hour", 82.0, null), SubscriptionWindow("seven_day", 35.0, null)))
        val state = mutableStateOf(ready().copy(subscriptionQuotas = mapOf("codex" to ProviderQuotaSnapshot(provider.id, reading))))
        show(state)
        repeat(2) { compose.onNodeWithTag("provider-query").assertIsEnabled().performClick() }
        compose.runOnIdle {
            assertEquals(listOf(provider.id, provider.id), queries.map { it.id })
            state.value = state.value.beginSubscriptionQuery(provider, "query")
        }
        compose.onNodeWithTag("provider-query").assertIsNotEnabled()
        compose.onAllNodesWithText("查询中").assertCountEquals(2)
        compose.runOnIdle { state.value = state.value.failSubscriptionQuery("query", "登录过期，请重新登录电脑端") }
        compose.onNodeWithText("登录过期，请重新登录电脑端").assertIsDisplayed()
        val error = compose.onNodeWithTag("provider-quota-error").fetchSemanticsNode().boundsInRoot
        for (name in listOf("five_hour", "seven_day")) {
            val quota = compose.onNodeWithTag("provider-quota-$name").fetchSemanticsNode().boundsInRoot
            assertTrue("$name ($quota) must sit above the error ($error)", quota.bottom <= error.top)
        }
        compose.onNodeWithText("82%").assertIsDisplayed()
        compose.onNodeWithText("35%").assertIsDisplayed()
        progress("provider-arc", 1f)
        compose.onNodeWithTag("provider-quota-error").assertDoesNotExist()
        progress("provider-arc", 0f)
        compose.onNodeWithTag("provider-quota-error").assertIsDisplayed()
        compose.onNodeWithTag("provider-query").assertIsEnabled().performClick()
        compose.runOnIdle { state.value = state.value.beginSubscriptionQuery(provider, "retry") }
        compose.onNodeWithTag("provider-quota-error").assertDoesNotExist()
    }
    @Test fun hostChangesAndDisconnectionCannotConfirmAStalePreview() {
        val state=mutableStateOf(ready());show(state)
        progress("provider-arc",1f);compose.onNodeWithTag("provider-apply").performClick()
        compose.runOnIdle { state.value=ready("other-host") }
        compose.onNodeWithText("切换 Codex 到 relay-b？").assertDoesNotExist()
        progress("provider-arc",1f)
        compose.runOnIdle { state.value=state.value.copy(e2eReady=false,connection=RelayConnection.OFFLINE) }
        compose.onNodeWithTag("provider-apply").assertIsNotEnabled()
        compose.runOnIdle { assertTrue(changes.isEmpty()) }
    }
    @Test fun agentRingOpensThatAgentsCurrentConfigurationAndPiRemainsAdditive() {
        show(mutableStateOf(ready()),true)
        progress("provider-arc",1f)
        progress("provider-agent-reel",1f)
        compose.onNodeWithText("正在使用 本机配置").assertIsDisplayed()
        compose.onNodeWithTag("provider-apply").assertIsNotEnabled()
        progress("provider-agent-reel",3f)
        compose.onNodeWithText("移出 本机配置").assertIsDisplayed()
        compose.onNodeWithTag("provider-apply").assertIsEnabled().performClick()
        compose.runOnIdle { assertEquals(listOf(profiles("pi")[0] to "dial-host"),changes) }
        capture("dark")
    }

    /** S42 / SC63: rotating the inner ring does not cancel the outer ring's next drag. */
    @Test fun outerRingRemainsDraggableAfterTurningTheAgentRing() {
        show(mutableStateOf(ready()))
        // Use the real touch path: a child label tap must not be replaced by the parent's release.
        compose.onNodeWithTag("provider-agent-claude").performTouchInput { click() }
        compose.onNodeWithTag("provider-agent-reel")
            .assert(SemanticsMatcher.expectValue(androidx.compose.ui.semantics.SemanticsProperties.StateDescription, "Claude Code"))

        val node = compose.onNodeWithTag("provider-dual-dial")
        val bounds = node.fetchSemanticsNode().boundsInRoot
        val width = with(compose.density) { bounds.width.toDp().value }
        val height = with(compose.density) { bounds.height.toDp().value }
        val geometry = DualDialGeometry.measure(width, height)
        val x = with(compose.density) { (geometry.cx + geometry.agentRadius).dp.toPx() }
        val y = with(compose.density) { geometry.cy.dp.toPx() }
        val travel = with(compose.density) { 84.dp.toPx() }
        node.performTouchInput {
            down(androidx.compose.ui.geometry.Offset(x, y))
            moveTo(androidx.compose.ui.geometry.Offset(x, y - travel), 700)
            up()
        }
        compose.onNodeWithTag("provider-agent-reel")
            .assert(SemanticsMatcher.expectValue(androidx.compose.ui.semantics.SemanticsProperties.StateDescription, "DeepSeek"))
        dragOuterRingToSecondProfile()
        compose.runOnIdle { assertTrue(changes.isEmpty()) }
    }

    /** AGENT-DIAL-01: wheel navigation cannot commit; only an armed, horizontal pin release sends a choice. */
    @Test fun pinRequiresPastMidpointHorizontalReleaseAndKeepsItsChannelSeparate() {
        val revision = 7L
        val rows = listOf(AgentEnablementRow("pi", "Pi", true), AgentEnablementRow("codex", "Codex CLI", false))
        val state = ready().copy(agentEnablementAvailable = true, agentEnablementRevision = revision, agentEnablementRows = rows,
            agentDial = AgentDialSync(cached = AgentDialSnapshot(revision, rows), synchronized = true))
        compose.setContent { OrbisTheme {
            ProviderDialScreen(state, emptyList(), {}, {}, { provider, host -> changes += provider to host }, { _, _ -> },
                showBack = false, onAgentEnabled = { _, kind, target, review, _ -> enablementChanges += Triple(kind, target, review) })
        } }
        compose.onNodeWithTag("provider-summary").assertExists()
        val dial = compose.onNodeWithTag("provider-dual-dial")
        val bounds = dial.fetchSemanticsNode().boundsInRoot
        val geometry = with(compose.density) { DualDialGeometry.measure(bounds.width.toDp().value, bounds.height.toDp().value) }
        val x = with(compose.density) { (geometry.pinStart + geometry.pinTravel / 2).dp.toPx() }
        val y = with(compose.density) { geometry.cy.dp.toPx() }
        val travel = with(compose.density) { geometry.pinTravel.dp.toPx() }
        dial.performTouchInput {
            down(androidx.compose.ui.geometry.Offset(x, y))
            moveTo(androidx.compose.ui.geometry.Offset(x + travel * 0.4f, y), 250)
            up()
        }
        compose.runOnIdle { assertTrue(enablementChanges.isEmpty()) }
        dial.performTouchInput {
            down(androidx.compose.ui.geometry.Offset(x, y))
            moveTo(androidx.compose.ui.geometry.Offset(x + travel * 0.8f, y), 250)
            up()
        }
        compose.runOnIdle {
            assertEquals(listOf(Triple("pi", false, null)), enablementChanges)
            assertTrue(changes.isEmpty())
        }
        val selection = compose.onNodeWithTag("provider-agent-reel")
        selection.performSemanticsAction(SemanticsActions.SetProgress) { assertTrue(it(1f)) }
        compose.waitForIdle()
        compose.runOnIdle {
            assertEquals(1, enablementChanges.size)
            assertEquals("codex", enablementChanges.single().first)
            assertTrue(changes.isEmpty())
        }
    }

    /** SC63: every Agent's ring follows the finger before release, then supports a reverse drag. */
    @Test fun outerRingTracksBothDirectionsAcrossRepeatedAgentChanges() {
        show(mutableStateOf(ready()))
        for (agentIndex in listOf(1, 2, 3, 0, 1)) {
            progress("provider-agent-reel", agentIndex.toFloat())
            assertOuterPosition(0f)
            val node = compose.onNodeWithTag("provider-dual-dial")
            val bounds = node.fetchSemanticsNode().boundsInRoot
            val geometry = with(compose.density) {
                DualDialGeometry.measure(bounds.width.toDp().value, bounds.height.toDp().value)
            }
            val start = with(compose.density) {
                androidx.compose.ui.geometry.Offset((geometry.cx + geometry.radius - 16f).dp.toPx(), geometry.cy.dp.toPx())
            }
            val travel = with(compose.density) { geometry.profilePitch.dp.toPx() }
            node.performTouchInput {
                down(start)
                moveTo(start.copy(y = start.y - travel * 0.65f), 300)
            }
            // Let recomposition happen while the finger is still down: the physical position
            // must follow the drag, even when browsing updates the selected configuration.
            assertOuterPosition(0.65f)
            compose.onNodeWithTag("provider-apply").assertIsNotEnabled()
            node.performTouchInput {
                moveTo(start.copy(y = start.y - travel), 300)
                up()
            }
            assertOuterPosition(1f)
            node.performTouchInput {
                down(start)
                moveTo(start.copy(y = start.y + travel), 600)
                up()
            }
            assertOuterPosition(0f)
            compose.onNodeWithTag("provider-arc")
                .assert(SemanticsMatcher.expectValue(androidx.compose.ui.semantics.SemanticsProperties.StateDescription, "本机配置"))
        }
        compose.runOnIdle { assertTrue(changes.isEmpty()) }
        capture("ring-after-agent-changes")
    }

    private fun assertOuterPosition(expected: Float) {
        compose.onNodeWithTag("provider-arc").assert(SemanticsMatcher("outer ring position is $expected") {
            kotlin.math.abs(it.config[androidx.compose.ui.semantics.SemanticsProperties.ProgressBarRangeInfo].current - expected) < 0.01f
        })
    }

    private fun dragOuterRingToSecondProfile() {
        val node = compose.onNodeWithTag("provider-dual-dial")
        val bounds = node.fetchSemanticsNode().boundsInRoot
        val width = with(compose.density) { bounds.width.toDp().value }
        val height = with(compose.density) { bounds.height.toDp().value }
        val geometry = DualDialGeometry.measure(width, height)
        val x = with(compose.density) { (geometry.cx + geometry.radius - 16f).dp.toPx() }
        val y = with(compose.density) { geometry.cy.dp.toPx() }
        val travel = with(compose.density) { 110.dp.toPx() }
        node.performTouchInput {
            down(androidx.compose.ui.geometry.Offset(x, y))
            moveTo(androidx.compose.ui.geometry.Offset(x, y - travel), 500)
            up()
        }
        compose.waitForIdle()
        compose.onNodeWithTag("provider-arc")
            .assert(SemanticsMatcher.expectValue(androidx.compose.ui.semantics.SemanticsProperties.StateDescription, "relay-b"))
        // SC63: the selection callback can succeed while a stale drag state leaves the drawn ring frozen.
        compose.onNodeWithTag("provider-arc").assert(SemanticsMatcher("outer ring reaches the selected detent") {
            kotlin.math.abs(it.config[androidx.compose.ui.semantics.SemanticsProperties.ProgressBarRangeInfo].current - 1f) < 0.01f
        })
    }
    /** SC57: each ring independently owns arrows/Home/End; keys never apply a configuration. */
    @Test fun keyboardBrowsesEachRingWithItsOwnFocusAndNeverApplies() {
        show(mutableStateOf(ready()))
        compose.runOnIdle { assertTrue(keyboard!!.requestInputMode(androidx.compose.ui.input.InputMode.Keyboard)) }
        fun focus(tag: String) {
            compose.onNodeWithTag(tag).performSemanticsAction(SemanticsActions.RequestFocus) { assertTrue(it()) }
            compose.onNodeWithTag(tag).assertIsFocused()
        }
        focus("provider-agent-reel")
        compose.onNodeWithTag("provider-agent-reel").performKeyInput { pressKey(androidx.compose.ui.input.key.Key.MoveEnd) }
        compose.onNodeWithTag("provider-agent-reel").assert(SemanticsMatcher.expectValue(androidx.compose.ui.semantics.SemanticsProperties.StateDescription,"Pi"))
        compose.onNodeWithTag("provider-agent-reel").performKeyInput { pressKey(androidx.compose.ui.input.key.Key.MoveHome) }
        compose.onNodeWithTag("provider-agent-reel").assert(SemanticsMatcher.expectValue(androidx.compose.ui.semantics.SemanticsProperties.StateDescription,"Codex"))
        focus("provider-arc")
        compose.onNodeWithTag("provider-arc").performKeyInput { pressKey(androidx.compose.ui.input.key.Key.DirectionDown) }
        compose.onNodeWithTag("provider-arc").assert(SemanticsMatcher.expectValue(androidx.compose.ui.semantics.SemanticsProperties.StateDescription,"relay-b"))
        compose.onNodeWithTag("provider-arc").performKeyInput { pressKey(androidx.compose.ui.input.key.Key.MoveHome) }
        compose.onNodeWithTag("provider-arc").assert(SemanticsMatcher.expectValue(androidx.compose.ui.semantics.SemanticsProperties.StateDescription,"本机配置"))
        compose.onNodeWithTag("provider-arc").performKeyInput { pressKey(androidx.compose.ui.input.key.Key.MoveEnd) }
        compose.onNodeWithTag("provider-arc").assert(SemanticsMatcher.expectValue(androidx.compose.ui.semantics.SemanticsProperties.StateDescription,"relay-b"))
        compose.runOnIdle { assertTrue(changes.isEmpty()) }
    }
    @Test fun bothQuotaWindowsAppearTogetherAndLowQuotaUsesAnExplicitWarning() {
        val quota=SubscriptionQuota(1,listOf(SubscriptionWindow("five_hour",80.0,null),SubscriptionWindow("seven_day",15.0,null)))
        show(mutableStateOf(ready().copy(subscriptionQuotas=mapOf("codex" to ProviderQuotaSnapshot("codex-local",quota)))))
        compose.onNodeWithText("5 小时").assertIsDisplayed()
        compose.onNodeWithText("7 天").assertIsDisplayed()
        compose.onNodeWithText("80%").assertIsDisplayed()
        compose.onNodeWithText("15%").assertIsDisplayed()
        compose.onNodeWithText("即将用完").assertIsDisplayed()
        compose.onNodeWithText("里圈选 Agent，外圈选配置").assertDoesNotExist()
        compose.onNodeWithTag("provider-summary").assertIsDisplayed()
        compose.runOnIdle { assertTrue(changes.isEmpty());assertTrue(queries.isEmpty()) }
        capture("quota-pair")
    }
}
