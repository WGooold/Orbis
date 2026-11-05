// Orbis 测试用途（场景与判定见本文件断言）：
// - S02 / S19：检查图标凹槽、配额币两面像素和命中区，防止材质修改损伤前景。
package com.orbising.orbis

import android.content.Context
import android.graphics.Bitmap
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.unit.dp
import androidx.test.core.app.ApplicationProvider
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import java.io.File

/** Captures the real provider panel at fixed animation times, including both subscription brands. */
class AgentIconRecessInstrumentedTest {
    @get:Rule val compose = createComposeRule()

    @Test fun providerWellsKeepBothCoinFacesAndHitTargetsAcrossAppearances() {
        val kinds = listOf("codex", "claude")
        val quota = SubscriptionQuota(1, listOf(SubscriptionWindow("five_hour", 82.0, null), SubscriptionWindow("seven_day", 35.0, null)))
        val state = RemoteState(hostId = "icon-recess-fixture", e2eReady = true, connection = RelayConnection.ONLINE,
            providerCatalogs = kinds.associateWith { kind -> listOf(AgentProvider("official", kind, "官方订阅", true, false,
                subscriptionSupported = true, official = true)) },
            subscriptionQuotas = kinds.associateWith { ProviderQuotaSnapshot(providerId = "official", quota = quota) })
        var dark by mutableStateOf(false)
        var style by mutableStateOf(OrbisVisualStyle.Classic)
        var queries = 0
        compose.setContent {
            OrbisTheme(darkTheme = dark, visualStyle = style) {
                Column(Modifier.width(360.dp).padding(16.dp)) {
                    AgentStatusProvidersCard(state, { _, _ -> }, { _, _ -> queries++ })
                }
            }
        }
        compose.mainClock.advanceTimeBy(800)
        val bounds = kinds.associateWith { compose.onNodeWithTag("quota-coin-$it").fetchSemanticsNode().boundsInRoot }
        for (appearance in OrbisVisualStyle.entries) for (night in listOf(false, true)) {
            compose.runOnIdle { style = appearance; dark = night }
            compose.mainClock.advanceTimeBy(800)
            val label = "${appearance.name}-${if (night) "dark" else "light"}"
            capture("$label-rest")
            compose.mainClock.autoAdvance = false
            for (kind in kinds) {
                val coin = compose.onNodeWithTag("quota-coin-$kind")
                coin.performClick()
                var elapsed = 0L
                for (time in listOf(160L, 208L, 224L, 272L, 352L, 592L)) {
                    compose.mainClock.advanceTimeBy(time - elapsed, ignoreFrameDuration = true)
                    elapsed = time
                    assertEquals(bounds[kind], coin.fetchSemanticsNode().boundsInRoot)
                    capture("$label-$kind-$time")
                }
                coin.assert(SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, "周配额，剩余 35%"))
                coin.performClick(); compose.mainClock.advanceTimeBy(600)
                coin.assert(SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, "5 小时配额，剩余 82%"))
            }
            compose.mainClock.autoAdvance = true
        }
        compose.runOnIdle { assertEquals("Local flips must not query the provider", 0, queries) }
    }

    private fun capture(name: String) {
        compose.waitForIdle()
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        instrumentation.waitForIdleSync()
        Thread.sleep(48) // Present the frozen frame to the display compositor before taking the screenshot.
        val image = instrumentation.uiAutomation.takeScreenshot()
        val context = ApplicationProvider.getApplicationContext<Context>()
        val directory = File(context.getExternalFilesDir(null), "icon-recess").apply { mkdirs() }
        File(directory, "$name.png").outputStream().use { image.compress(Bitmap.CompressFormat.PNG, 100, it) }
        image.recycle()
    }
}
