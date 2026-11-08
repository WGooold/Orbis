package com.orbising.orbis

import android.graphics.Bitmap
import androidx.compose.runtime.*
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test

/** S36 / SC57: browsing never applies; a settled explicit action confirms the exact Host/profile. */
class ProviderDialInstrumentedTest {
    @get:Rule val compose = createComposeRule()
    private val changes = mutableListOf<Pair<AgentProvider,String?>>()
    private val queries = mutableListOf<AgentProvider>()
    private fun profiles(kind: String) = listOf(
        AgentProvider("$kind-local",kind,"本机配置",true,kind=="pi",official=true,subscriptionSupported=kind=="codex"),
        AgentProvider("$kind-relay",kind,"relay-b",false,kind=="pi"))
    private fun ready(host: String="dial-host") = RemoteState(hostId=host,hostName="workstation",e2eReady=true,
        connection=RelayConnection.ONLINE,providerCatalogs=listOf("codex","claude","dsh","pi").associateWith(::profiles))
    private fun show(state: MutableState<RemoteState>, dark: Boolean=false) {
        compose.setContent { OrbisTheme(darkTheme=dark) {
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
    @Test fun browsingAndCancelledConfirmationNeverWriteAndApplyingNamesBothAgentAndProfile() {
        show(mutableStateOf(ready()))
        compose.onNodeWithTag("provider-apply").assertIsNotEnabled()
        progress("provider-arc",1f)
        compose.runOnIdle { assertTrue(changes.isEmpty()) }
        compose.onNodeWithTag("provider-apply").assertIsEnabled().performClick()
        compose.onNodeWithText("切换 Codex 到 relay-b？").assertIsDisplayed()
        compose.onNodeWithText("取消").performClick()
        compose.runOnIdle { assertTrue(changes.isEmpty()) }
        compose.onNodeWithTag("provider-apply").performClick()
        compose.onNodeWithText("切换",useUnmergedTree=true).performClick()
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
    @Test fun bothQuotaWindowsAppearTogetherAndLowQuotaUsesAnExplicitWarning() {
        val quota=SubscriptionQuota(1,listOf(SubscriptionWindow("five_hour",80.0,null),SubscriptionWindow("seven_day",15.0,null)))
        show(mutableStateOf(ready().copy(subscriptionQuotas=mapOf("codex" to ProviderQuotaSnapshot("codex-local",quota)))))
        compose.onNodeWithText("5 小时").assertIsDisplayed()
        compose.onNodeWithText("7 天").assertIsDisplayed()
        compose.onNodeWithText("80%").assertIsDisplayed()
        compose.onNodeWithText("15%").assertIsDisplayed()
        compose.onNodeWithText("即将用完").assertIsDisplayed()
        compose.runOnIdle { assertTrue(changes.isEmpty());assertTrue(queries.isEmpty()) }
        capture("quota-pair")
    }
}
