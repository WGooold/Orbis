package com.orbising.orbis

import android.graphics.Bitmap
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.dp
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

class HomeLoadingInstrumentedTest {
    @get:Rule val compose = createComposeRule()
    @Test fun lightHomeKeepsTheListDuringLoadingRefreshAndRetry() = exercise(false)
    @Test fun darkHomeKeepsTheListDuringLoadingRefreshAndRetry() = exercise(true)

    private fun exercise(dark: Boolean) {
        var fixture = HomeLoadingFixture()
        val state = mutableStateOf(fixture.state)
        val scale = mutableStateOf(1f)
        val opened = mutableListOf<String>()
        val pairing = HostPairing("home-test", "Test Host", "test-public", "test-root",
            relayUrl = "wss://relay.example", deviceId = "test-device", credential = "test-only")
        compose.setContent {
            val density = LocalDensity.current
            CompositionLocalProvider(LocalDensity provides Density(density.density, scale.value)) {
                OrbisTheme(darkTheme = dark) {
                    RuntimeListScreen(state.value, listOf(HostSnapshot(pairing, state.value)),
                        onOpenRuntime = { _, id -> opened += id }, onCloseRuntimes = { _, _ -> emptySet() }, onOpenDownloads = {}, onUnpairHost = {},
                        onOpenSession = { _, _ -> }, onOpenHistory = { _, _ -> }, onNewSession = { _, _ -> },
                        onSetArchived = { _, _, _ -> }, onSelectHost = {}, onAddHost = {}, onOpenStatus = {}, onRequestProviders = {},
                        onRetryHome = {
                            fixture.beginRead("b"); fixture.facts("b", revision = 2)
                            state.value = fixture.state
                        })
                }
            }
        }
        for (fontScale in listOf(1f, 1.5f)) {
            // Nothing published yet: a failed read takes the empty list's place, with its full message.
            compose.runOnIdle {
                fixture = HomeLoadingFixture()
                fixture.directory(fixture.runtime("a"))
                val request = fixture.beginRead("a")
                fixture.state = fixture.state.failHomeRead(request, "会话读取失败，请重试")
                state.value = fixture.state; scale.value = fontScale
            }
            val list = compose.onNodeWithTag("home-session-list")
            list.assertExists()
            val listBounds = list.fetchSemanticsNode().boundsInRoot
            val pillBounds = compose.onNodeWithTag("home-connection-status").fetchSemanticsNode().boundsInRoot
            // No status row between the computer row and the list.
            with(compose.density) { assertTrue(listBounds.top - pillBounds.bottom <= 8.dp.toPx()) }
            compose.onNodeWithText("会话读取失败，请重试").assertIsDisplayed()
            assertTrue(compose.onNodeWithTag("home-session-status").fetchSemanticsNode().boundsInRoot.top >= listBounds.top)
            compose.onNodeWithText("同步失败").assertDoesNotExist()
            compose.onNodeWithText("暂无在线会话").assertDoesNotExist()
            compose.onNodeWithContentDescription("重新加载会话").assertIsDisplayed()
                .assertHeightIsAtLeast(48.dp).assertWidthIsAtLeast(48.dp)
            capture(dark, fontScale, "first-error")

            compose.runOnIdle { fixture = HomeLoadingFixture(); state.value = fixture.state }
            compose.onNodeWithText("正在加载会话…").assertIsDisplayed()
            assertTrue(compose.onNodeWithTag("home-session-status").fetchSemanticsNode().boundsInRoot.top >= listBounds.top)
            compose.onNodeWithText("正在同步").assertDoesNotExist()
            compose.onNodeWithText("暂无在线会话").assertDoesNotExist()
            assertEquals(listBounds, list.fetchSemanticsNode().boundsInRoot)
            capture(dark, fontScale, "initial")
            compose.runOnIdle {
                fixture.directory(fixture.runtime("a"), fixture.runtime("b"))
                fixture.beginRead("a"); fixture.beginRead("b")
                fixture.facts("a"); fixture.facts("b", setOf("identity", "execution"))
                state.value = fixture.state
            }
            compose.onNodeWithTag("home-runtime-a").assertDoesNotExist()
            compose.runOnIdle { fixture.facts("b", setOf("interactions")); state.value = fixture.state }
            compose.onNodeWithTag("home-runtime-a").assertIsDisplayed()
            compose.onNodeWithTag("home-runtime-b").assertIsDisplayed()
            compose.onNodeWithText("正在加载会话…").assertDoesNotExist()
            assertEquals(listBounds, list.fetchSemanticsNode().boundsInRoot)
            val cardBounds = compose.onNodeWithTag("home-runtime-a").fetchSemanticsNode().boundsInRoot
            with(compose.density) { assertTrue(cardBounds.top - listBounds.top <= 16.dp.toPx()) }
            // After publication, background sync lives in the connection capsule and never moves the cards.
            compose.runOnIdle { fixture.beginRead("a"); fixture.beginRead("b"); state.value = fixture.state }
            compose.onNodeWithText("正在同步").assertIsDisplayed()
            compose.onNodeWithText("正在加载会话…").assertDoesNotExist()
            compose.onNodeWithTag("home-runtime-a").assertIsDisplayed()
            assertEquals(cardBounds, compose.onNodeWithTag("home-runtime-a").fetchSemanticsNode().boundsInRoot)
            capture(dark, fontScale, "updating")
            compose.runOnIdle {
                fixture.facts("a", revision = 2)
                val request = fixture.state.agentStateReads.entries.first { it.value.runtimeId == "b" }.key
                fixture.state = fixture.state.failHomeRead(request, "会话读取失败，请重试")
                state.value = fixture.state
            }
            compose.onNodeWithText("同步失败").assertIsDisplayed()
            compose.onNodeWithText("会话读取失败，请重试").assertDoesNotExist()
            compose.onNodeWithContentDescription("重新加载会话").assertIsDisplayed()
                .assertHeightIsAtLeast(48.dp).assertWidthIsAtLeast(48.dp)
            assertTrue(compose.onNodeWithContentDescription("重新加载会话").fetchSemanticsNode().boundsInRoot.bottom <= listBounds.top + 1f)
            assertEquals(cardBounds, compose.onNodeWithTag("home-runtime-a").fetchSemanticsNode().boundsInRoot)
            assertEquals(listBounds, list.fetchSemanticsNode().boundsInRoot)
            capture(dark, fontScale, "error")
            compose.onNodeWithContentDescription("重新加载会话").performClick()
            compose.onNodeWithText("正在同步").assertDoesNotExist()
            compose.onNodeWithText("同步失败").assertDoesNotExist()
            compose.onNodeWithContentDescription("重新加载会话").assertDoesNotExist()
            assertEquals(listBounds, list.fetchSemanticsNode().boundsInRoot)
            assertEquals(cardBounds, compose.onNodeWithTag("home-runtime-a").fetchSemanticsNode().boundsInRoot)
            compose.runOnIdle {
                fixture.receive("""{"type":"runtime.online","runtime":{"runtimeId":"a","sessionId":"replacement","name":"Agent","cwd":"","status":"unknown"}}""")
                state.value = fixture.state
            }
            compose.onNodeWithText("完整会话 a").assertIsDisplayed()
            compose.onNodeWithTag("home-runtime-a").onChild().assertIsNotEnabled()
            compose.onNodeWithTag("home-runtime-a").performTouchInput { click() }
            compose.runOnIdle { assertTrue(opened.isEmpty()) }
            compose.runOnIdle { fixture.beginRead("a"); fixture.facts("a", title = "替换完成"); state.value = fixture.state }
            compose.onNodeWithTag("home-runtime-a").onChild().assertIsEnabled()
            compose.onNodeWithText("替换完成").assertIsDisplayed()
            assertEquals(listBounds, list.fetchSemanticsNode().boundsInRoot)
            capture(dark, fontScale, "complete")
        }
    }

    private fun capture(dark: Boolean, scale: Float, stage: String) {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val directory = File(context.getExternalFilesDir(null), "home-loading").apply { mkdirs() }
        File(directory, "${if (dark) "dark" else "light"}-$scale-$stage.png").outputStream().use {
            compose.onRoot().captureToImage().asAndroidBitmap().compress(Bitmap.CompressFormat.PNG, 100, it)
        }
    }
}
