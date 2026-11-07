// S32 / SC51: the native provider dial browses without writes, confirms through the guided right-pointer pull,
// rejects stale/offline pulls, covers physical drag/cancel, and keeps official quota controls inline.
package com.orbising.orbis

import android.graphics.Bitmap
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.width
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.MutableState
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.dp
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.max
import kotlin.math.sin
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

class ProviderDialInstrumentedTest {
    @get:Rule val compose = createComposeRule()

    private val enabled = mutableListOf<Pair<AgentProvider, String?>>()
    private val removed = mutableListOf<Pair<List<AgentProvider>, String?>>()
    private val queries = mutableListOf<Pair<AgentProvider, String?>>()
    private val loaded = mutableListOf<String>()

    private fun providers(kind: String) = listOf(
        AgentProvider("$kind-official", kind, "$kind official fixture", enabled = true,
            additive = kind == "pi", subscriptionSupported = kind == "codex" || kind == "claude", official = true),
        AgentProvider("$kind-workspace", kind, "$kind workspace fixture", enabled = false, additive = kind == "pi"),
    )

    private fun ready(host: String = "dial-host") = RemoteState(hostId = host, hostName = "Fixture computer",
        e2eReady = true, connection = RelayConnection.ONLINE,
        providerCatalogs = listOf("claude", "codex", "dsh", "pi").associateWith(::providers),
        agentProviders = AgentProvidersState(kind = "codex", hostId = host, providers = providers("codex")))

    private fun show(state: MutableState<RemoteState>, dark: MutableState<Boolean> = mutableStateOf(false),
        narrow: MutableState<Boolean> = mutableStateOf(false)) {
        compose.setContent {
            val density = LocalDensity.current
            CompositionLocalProvider(LocalDensity provides Density(density.density, if (narrow.value) 1.5f else 1f)) {
                OrbisTheme(darkTheme = dark.value) {
                    Box(if (narrow.value) Modifier.width(320.dp).fillMaxSize() else Modifier.fillMaxSize()) {
                        val current = state.value
                        val pairing = HostPairing(current.hostId ?: "dial-host", "Fixture computer", "test-public", "test-root",
                            relayUrl = "wss://relay.example", deviceId = "test-device", credential = "test-only")
                        ProviderDialScreen(current, listOf(HostSnapshot(pairing, current)),
                            onSelectHost = {}, onLoad = { loaded += it },
                            onEnable = { provider, host -> enabled += provider to host },
                            onQuerySubscription = { provider, host -> queries += provider to host },
                            showBack = false)
                    }
                }
            }
        }
    }

    private fun progress(tag: String, index: Float) {
        compose.onNodeWithTag(tag).performSemanticsAction(SemanticsActions.SetProgress) { action ->
            assertTrue("$tag must accept an accessible index change", action(index))
        }
        compose.waitForIdle()
    }

    private fun previewWorkspace() {
        progress("provider-arc", 1f)
        compose.onNodeWithTag("provider-switch-hint").assertIsDisplayed()
        compose.onNodeWithTag("provider-pointer-confirm").assertIsDisplayed()
    }

    private fun pullPointer(endFraction: Float = 0.97f) {
        compose.onNodeWithTag("provider-pointer-confirm").performTouchInput {
            swipeRight(startX = width * 0.16f, endX = width * endFraction, durationMillis = 360)
        }
        compose.waitForIdle()
    }

    private fun assertNoWrites() = compose.runOnIdle {
        assertTrue("Browsing and incomplete or invalid pointer pulls must not enable providers", enabled.isEmpty())
        assertTrue("Browsing must not remove providers", removed.isEmpty())
    }

    @Test fun guidedPointerPullConfirmsTheExactProviderAndHostWithoutButtonsOrDialogs() {
        val state = mutableStateOf(ready())
        show(state)
        progress("provider-arc", 1f)
        assertEquals(1f, compose.onNodeWithTag("provider-arc").fetchSemanticsNode()
            .config[SemanticsProperties.ProgressBarRangeInfo].current, 0f)
        compose.onNodeWithText("沿右侧指针向外拉动并松手以启用").assertIsDisplayed()
        compose.onNodeWithTag("provider-apply").assertDoesNotExist()
        assertNoWrites()
        pullPointer(endFraction = 0.49f)
        assertNoWrites()
        pullPointer()
        compose.onNodeWithText("确认供应商切换").assertDoesNotExist()
        compose.runOnIdle { assertEquals(listOf(providers("codex")[1] to "dial-host"), enabled) }
    }

    @Test fun changingHostOrGoingOfflineDisablesThePointerSwitchWithoutWrites() {
        val state = mutableStateOf(ready())
        show(state)
        previewWorkspace()
        compose.runOnIdle { state.value = ready("other-dial-host") }
        compose.onNodeWithTag("provider-pointer-confirm").assertIsNotEnabled()
        pullPointer()
        assertNoWrites()
        previewWorkspace()
        compose.runOnIdle { state.value = state.value.copy(e2eReady = false, connection = RelayConnection.OFFLINE) }
        compose.onNodeWithTag("provider-pointer-confirm").assertIsNotEnabled()
        compose.onAllNodesWithTag("provider-switch-hint").assertCountEquals(0)
        pullPointer()
        assertNoWrites()
    }

    @Test fun switchingAgentChangesTheDialPreviewAndDisplaysThatAgentsRealProviderNames() {
        val state = mutableStateOf(ready())
        show(state)
        previewWorkspace()
        // Agent order is Claude / Codex / DeepSeek / Pi, matching the horizontal reel.
        progress("provider-agent-reel", 0f)
        compose.onNodeWithTag("provider-switch-hint").assertDoesNotExist()
        compose.onNodeWithTag("provider-arc").assert(SemanticsMatcher("The arc must name the Claude profile") {
            it.config[SemanticsProperties.StateDescription].contains("claude official fixture") == true
        })
        compose.onAllNodesWithText("codex workspace fixture").assertCountEquals(0)
        compose.runOnIdle { assertEquals("claude", loaded.last()) }
        assertNoWrites()
    }

    @Test fun singleProviderKeepsAWorkingTurnableDialAndOfficialQuotaControlsInline() {
        val single = providers("codex").take(1)
        val state = mutableStateOf(ready().let { it.copy(providerCatalogs = it.providerCatalogs + ("codex" to single),
            agentProviders = it.agentProviders.copy(providers = single)) })
        val dark = mutableStateOf(false)
        val narrow = mutableStateOf(false)
        show(state, dark, narrow)
        val singleRange = compose.onNodeWithTag("provider-arc").fetchSemanticsNode()
            .config[SemanticsProperties.ProgressBarRangeInfo]
        assertEquals(0f, singleRange.current, 0f)
        assertEquals(0f..0f, singleRange.range)
        compose.onNodeWithTag("provider-pointer-confirm").assertIsDisplayed().assertIsNotEnabled()
        compose.onNodeWithTag("provider-query").assertIsDisplayed()
        compose.onNodeWithTag("provider-preview").assertIsDisplayed().assertHasNoClickAction()
        turnArc(cancelled = false)
        compose.onNodeWithTag("provider-arc").assert(SemanticsMatcher("A single provider keeps the wheel's turn detent") {
            it.config[SemanticsProperties.StateDescription].contains("拨盘转动 1 格") == true
        })
        assertEquals("Turning a one-provider wheel does not change its provider", 0f, arcIndex(), 0f)
        assertNoWrites()
        turnArc(cancelled = true) {
            compose.onNodeWithTag("provider-arc").assert(SemanticsMatcher("Cancelled turn previews the next detent") {
                it.config[SemanticsProperties.StateDescription].contains("拨盘转动 2 格") == true
            })
        }
        compose.onNodeWithTag("provider-arc").assert(SemanticsMatcher("Cancelled turn returns to the committed detent") {
            it.config[SemanticsProperties.StateDescription].contains("拨盘转动 1 格") == true
        })
        assertNoWrites()
        compose.onNodeWithTag("provider-query").assertIsDisplayed().performClick()
        compose.runOnIdle { assertEquals(listOf(single.single() to "dial-host"), queries) }
        // A query receipt retains the original shared 5-hour/week coin interaction, not a disabled picture.
        compose.runOnIdle {
            state.value = state.value.copy(subscriptionQuotas = mapOf("codex" to ProviderQuotaSnapshot(
                single.single().id, SubscriptionQuota(42L, listOf(
                    SubscriptionWindow("five_hour", 80.0, null), SubscriptionWindow("seven_day", 60.0, null),
                )),
            )))
        }
        compose.onNodeWithTag("quota-coin-codex").assertIsEnabled().performClick()
        compose.onNodeWithTag("quota-coin-codex").assert(SemanticsMatcher("Quota coin can flip to the week") {
            it.config[SemanticsProperties.StateDescription].contains("周配额")
        })
        compose.runOnIdle { assertEquals("Flipping quota must not send another query", 1, queries.size) }
        compose.onAllNodesWithTag("provider-apply").assertCountEquals(0)
        compose.onAllNodesWithTag("provider-query").assertCountEquals(1)
        compose.onNodeWithTag("provider-inline-actions").assertIsDisplayed()
        compose.onAllNodesWithTag("provider-refresh").assertCountEquals(0)
        compose.onAllNodesWithTag("provider-manage").assertCountEquals(0)
        capture("normal")
        compose.runOnIdle { dark.value = true }
        capture("dark")
        compose.runOnIdle { narrow.value = true }
        compose.onNodeWithTag("provider-agent-reel").assertIsDisplayed()
        compose.onNodeWithTag("provider-arc").assertIsDisplayed()
        compose.onNodeWithTag("provider-pointer-confirm").assertIsDisplayed()
        capture("dark-320-large-type")
        compose.runOnIdle { state.value = state.value.copy(providerCatalogs = state.value.providerCatalogs + ("codex" to emptyList()),
            agentProviders = state.value.agentProviders.copy(providers = emptyList())) }
        compose.onNodeWithTag("provider-pointer-confirm").assertIsNotEnabled()
        compose.onAllNodesWithTag("provider-query").assertCountEquals(0)
        compose.onAllNodesWithTag("provider-manage").assertCountEquals(0)
        assertNoWrites()
    }

    // Draft-fidelity guard: the overview is a neutral dial, not the previous green action card.
    // Business actions remain attached to the root dial and its right-side pointer.
    @Test fun approvedDraftOverviewHasNeutralPaletteAndNoLegacyActionCardsInEitherTheme() {
        val profiles = listOf(
            AgentProvider("draft-official", "codex", "OFFICIAL", enabled = true, additive = false,
                official = true, subscriptionSupported = true),
            AgentProvider("draft-workspace", "codex", "WORKSPACE", enabled = false, additive = false),
            AgentProvider("draft-personal", "codex", "PERSONAL", enabled = false, additive = false),
        )
        val state = mutableStateOf(ready().let { it.copy(
            providerCatalogs = it.providerCatalogs + ("codex" to profiles),
            agentProviders = it.agentProviders.copy(providers = profiles),
        ) })
        val dark = mutableStateOf(false)
        show(state, dark)
        fun verifyOverview(darkMode: Boolean) {
            compose.onNodeWithText("INTEGRATIONS").assertIsDisplayed()
            compose.onNodeWithText("AGENT", useUnmergedTree = true).assertIsDisplayed()
            compose.onNodeWithTag("provider-agent-reel").assertIsDisplayed()
            compose.onNodeWithTag("provider-preview").assertIsDisplayed().assertHasNoClickAction()
            compose.onNodeWithTag("provider-pointer-confirm").assertIsDisplayed()
            compose.onNodeWithTag("provider-query").assertIsDisplayed()
            listOf("provider-refresh", "provider-manage", "provider-actions-close").forEach {
                compose.onAllNodesWithTag(it).assertCountEquals(0)
            }
            val bitmap = compose.onRoot().captureToImage().asAndroidBitmap()
            // The clear left margin must retain the exact approved local page paper, not global green.
            val marginX = with(compose.density) { 2.dp.toPx().toInt() }
            val sampleY = bitmap.height / 5
            assertEquals("Approved page palette", if (darkMode) 0xff2c2e31.toInt() else 0xffe5e7e9.toInt(), bitmap.getPixel(marginX, sampleY))
        }
        verifyOverview(false)
        capture("draft-overview-light")
        compose.runOnIdle { dark.value = true }
        verifyOverview(true)
        capture("draft-overview-dark")
        assertNoWrites()
    }

    private fun arcIndex() = compose.onNodeWithTag("provider-arc").fetchSemanticsNode()
        .config[SemanticsProperties.ProgressBarRangeInfo].current

    /** Move along a physical 36-degree arc around the hidden left-hand pivot, not the box center. */
    private fun turnArc(cancelled: Boolean, whileHeld: () -> Unit = {}) {
        val arc = compose.onNodeWithTag("provider-arc")
        val bounds = arc.fetchSemanticsNode().boundsInRoot
        val minimumRadius = with(compose.density) { 350.dp.toPx() }
        val radius = max(minimumRadius, max(bounds.width * 1.15f, bounds.height * .8f))
        val pivotX = bounds.width * .83f - radius
        val pivotY = bounds.height * .5f
        val fingerRadius = bounds.width * .65f - pivotX
        val points = (0..18).map { step ->
            val angle = (18.0 - step * 2.0) * PI / 180.0
            Offset(pivotX + fingerRadius * cos(angle).toFloat(), pivotY + fingerRadius * sin(angle).toFloat())
        }
        assertTrue("The fixed angular path must stay within the exposed arc viewport",
            points.all { it.x > 0f && it.x < bounds.width && it.y > 0f && it.y < bounds.height })
        arc.performTouchInput {
            down(points.first())
            points.drop(1).forEach { moveTo(it, delayMillis = 20) }
        }
        whileHeld()
        arc.performTouchInput { if (cancelled) cancel() else up() }
        compose.waitForIdle()
    }

    @Test fun realArcAndAgentDragsBrowseWhileCancelledArcReturnsToItsLastCommittedPreview() {
        val state = mutableStateOf(ready())
        show(state)
        assertEquals(0f, arcIndex(), 0f)
        turnArc(cancelled = false) {
            // A changed semantic index before pointer-up proves the disc follows the held finger.
            assertEquals(1f, arcIndex(), 0f)
            assertNoWrites()
            capture("finger-held")
        }
        assertEquals(1f, arcIndex(), 0f)
        assertNoWrites()
        turnArc(cancelled = true) {
            assertEquals(0f, arcIndex(), 0f) // With two profiles, one more sector wraps visually to the first.
            assertNoWrites()
        }
        assertEquals("Cancel must restore the last browsed detent, not enable a supplier", 1f, arcIndex(), 0f)
        assertNoWrites()
        val agentDragDistance = with(compose.density) { 90.dp.toPx() }
        compose.onNodeWithTag("provider-agent-reel").performTouchInput {
            swipeLeft(startX = width * .65f, endX = width * .65f - agentDragDistance, durationMillis = 400)
        }
        compose.waitForIdle()
        compose.runOnIdle { assertEquals("dsh", loaded.last()) }
        compose.onNodeWithTag("provider-arc").assert(SemanticsMatcher("The arc must name the DeepSeek profile") {
            it.config[SemanticsProperties.StateDescription].contains("dsh official fixture") == true
        })
        assertNoWrites()
    }

    private fun capture(name: String) {
        compose.waitForIdle()
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val directory = File(context.getExternalFilesDir(null), "provider-dial").apply { mkdirs() }
        File(directory, "$name.png").outputStream().use {
            compose.onRoot().captureToImage().asAndroidBitmap().compress(Bitmap.CompressFormat.PNG, 100, it)
        }
    }
}
