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
