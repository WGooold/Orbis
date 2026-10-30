package com.orbising.orbis

import android.content.Context
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.unit.dp
import androidx.test.core.app.ApplicationProvider
import androidx.test.platform.app.InstrumentationRegistry
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import java.io.File

class SubscriptionQuotaInstrumentedTest {
    @get:Rule val compose = createComposeRule()

    @Test fun compactCardsSeparateSwitchFromQueryAndKeepBothAgentReadings() {
        val official = AgentProvider("official", "codex", "官方订阅", true, false, subscriptionSupported = true, official = true)
        val team = official.copy(id = "team", name = "团队供应商", enabled = false, subscriptionSupported = false, official = false)
        var state by mutableStateOf(RemoteState(hostId = "host", e2eReady = true, connection = RelayConnection.ONLINE,
            providerCatalogs = mapOf("codex" to listOf(official, team), "claude" to listOf(official.copy(kind = "claude")))))
        var dark by mutableStateOf(false)
        var queries = 0
        var switched: AgentProvider? = null
        compose.setContent {
            OrbisTheme(darkTheme = dark) {
                Column(Modifier.width(340.dp).padding(12.dp)) {
                    AgentStatusProvidersCard(state, { provider, _ -> switched = provider }, { provider, _ ->
                        queries++; state = state.beginSubscriptionQuery(provider, "query")
                    })
                }
            }
        }
        compose.onNodeWithTag("provider-switch-codex").performClick()
        compose.onNodeWithText("团队供应商").performClick()
        compose.runOnIdle { assertEquals(team, switched); assertEquals(0, queries) }
        compose.onNodeWithTag("quota-coin-codex").performClick()
        compose.runOnIdle {
            assertEquals(1, queries)
            state = state.withSubscriptionResult(Json.parseToJsonElement("""{"requestId":"query","id":"official","kind":"codex","quota":{"checkedAt":1,"windows":[{"name":"five_hour","remainingPercent":82,"resetsAt":null},{"name":"seven_day","remainingPercent":35,"resetsAt":null}]}}""").jsonObject)
        }
        // Let the first successful result demonstrate both faces and return to 5h.
        compose.mainClock.advanceTimeBy(3500)
        val coin = compose.onNodeWithTag("quota-coin-codex")
        coin.assert(SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, "5 小时配额，剩余 82%"))
        coin.performClick()
        compose.mainClock.advanceTimeBy(600)
        coin.assert(SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, "周配额，剩余 35%"))
        compose.runOnIdle { assertEquals("Flipping must not send a quota request", 1, queries) }
        val bounds = coin.fetchSemanticsNode().boundsInRoot
        assertEquals(64f, bounds.width / compose.density.density, 1f)
        assertTrue(bounds.height / compose.density.density >= 48)
        assertTrue(compose.onNodeWithTag("provider-quota-codex").fetchSemanticsNode().boundsInRoot.height / compose.density.density < 130)
        compose.onNodeWithText("轻点卡片查询配额").assertDoesNotExist()
        compose.onNodeWithText("查询订阅配额").assertDoesNotExist()
        for (appearance in listOf("light", "dark")) {
            compose.runOnIdle { dark = appearance == "dark" }
            compose.waitForIdle()
            val context = ApplicationProvider.getApplicationContext<Context>()
            val file = File(context.getExternalFilesDir(null), "quota-compact-$appearance.png")
            file.outputStream().use { compose.onRoot().captureToImage().asAndroidBitmap().compress(android.graphics.Bitmap.CompressFormat.PNG, 100, it) }
            // Freeze at real rendered intermediate frames to review the diagonal edge and light.
            val frames = File(context.getExternalFilesDir(null), "quota-tilt").apply { mkdirs() }
            compose.mainClock.autoAdvance = false
            repeat(2) { turn ->
                coin.performClick()
                repeat(15) { frame ->
                    compose.mainClock.advanceTimeBy(40)
                    val png = File(frames, "$appearance-$turn-${frame.toString().padStart(2, '0')}.png")
                    compose.waitForIdle()
                    val instrumentation = InstrumentationRegistry.getInstrumentation()
                    instrumentation.waitForIdleSync()
                    Thread.sleep(32) // Allow the display compositor to present the frozen animation frame.
                    val bitmap = instrumentation.uiAutomation.takeScreenshot()
                    png.outputStream().use { bitmap.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, it) }
                    bitmap.recycle()
                }
            }
            compose.mainClock.autoAdvance = true
            compose.waitForIdle()

        }
        // Refresh from the card while on the weekly face, retaining the selected face and cached value on failure.
        compose.onNodeWithTag("provider-quota-codex").performTouchInput { click(Offset(width * 0.45f, height * 0.5f)) }
        compose.runOnIdle { assertEquals(2, queries); state = state.failSubscriptionQuery("query", "查询超时") }
        coin.assert(SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, "周配额，剩余 35%"))
        coin.performClick()
        compose.mainClock.advanceTimeBy(600)
        coin.assert(SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, "5 小时配额，剩余 82%"))
        compose.onNodeWithTag("quota-coin-claude").performClick()
        compose.runOnIdle {
            assertEquals(3, queries)
            state = state.failSubscriptionQuery("query", "查询超时")
            assertEquals(82.0, state.subscriptionQuotas["codex"]!!.quota!!.windows.first().remainingPercent!!, 0.0)
        }
        compose.onAllNodesWithText("查询超时").assertCountEquals(2)
    }
}
