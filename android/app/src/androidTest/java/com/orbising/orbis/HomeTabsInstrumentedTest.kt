// S32 / SC51: root tabs expose one selected destination, dispatch one selection per tap,
// retain readable targets at large type, and preserve a real RemoteApp list across peer tabs and downloads.
package com.orbising.orbis

import android.graphics.Bitmap
import android.util.Log
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.width
import androidx.compose.material3.Text
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.dp
import androidx.lifecycle.ViewModelStore
import androidx.test.core.app.ApplicationProvider
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

class HomeTabsInstrumentedTest {
    @get:Rule val compose = createComposeRule()

    private val destinations = listOf(
        Triple(HomeTab.Chat, "home-tab-chat", "聊天"),
        Triple(HomeTab.Providers, "home-tab-providers", "供应商"),
        Triple(HomeTab.Settings, "home-tab-settings", "设置"),
    )

    @Test fun tabsExposeOneSelectionAndDispatchEachRootChangeExactlyOnce() {
        val selected = mutableStateOf(HomeTab.Chat)
        val selections = mutableListOf<HomeTab>()
        compose.setContent {
            OrbisTheme {
                Column {
                    // The navigation contract is isolated from Host connections and model requests.
                    Text("root:${selected.value.name}")
                    HomeTabBar(selected = selected.value, onSelect = {
                        selections += it
                        selected.value = it
                    })
                }
            }
        }
        fun assertSelection(expected: HomeTab) {
            for ((destination, tag, description) in destinations) {
                val tab = compose.onNodeWithTag(tag).assertIsDisplayed()
                    .assertContentDescriptionEquals(description)
                    .assert(SemanticsMatcher.expectValue(SemanticsProperties.Role, Role.Tab))
                if (destination == expected) tab.assertIsSelected() else tab.assertIsNotSelected()
            }
            compose.onNodeWithText("root:${expected.name}").assertIsDisplayed()
        }
        assertSelection(HomeTab.Chat)
        for ((destination, tag) in destinations.drop(1) + destinations.take(1)) {
            compose.onNodeWithTag(tag).performClick()
            assertSelection(destination)
        }
        compose.runOnIdle {
            assertEquals(listOf(HomeTab.Providers, HomeTab.Settings, HomeTab.Chat), selections)
        }
        compose.onNodeWithContentDescription("返回").assertDoesNotExist()
    }

    @Test fun realRootTabsRestoreScrolledChatsAndDownloadsBackRestoresTheTabBar() {
        // The model has no saved pairings; ready Host facts exist only in the composable input.
        // Switching tabs therefore exercises actual navigation without any real connection.
        val app = IsolatedTestApplication(ApplicationProvider.getApplicationContext(), prefix = "home-tabs")
        val owner = ViewModelStore()
        val model = RemoteViewModel(app)
        owner.put("home-tabs", model)
        val ids = (0 until 12).map { "tabs-c%02d".format(it) }
        val state = RemoteState(hostId = "tabs-host", deviceId = "tabs-device", e2eReady = true,
            runtimes = ids.associateWith { id ->
                RuntimeSummary(id, id, "/fixture/workspace", "idle", sessionId = id, agentKind = "pi",
                    domainAvailability = mapOf("identity" to "ready", "execution" to "ready", "interactions" to "ready"))
            },
            sessions = ids.withIndex().associate { (index, id) ->
                id to SessionCatalogEntry(id, name = id, modifiedAt = 10_000L - index)
            }).withReadyHomeFixture()
        val pairing = HostPairing("tabs-host", "Fixture computer", "test-public", "test-root",
            relayUrl = "wss://relay.example", deviceId = "tabs-device", credential = "test-only")
        try {
            compose.setContent {
                OrbisTheme { RemoteApp(state, listOf(HostSnapshot(pairing, state)), null, false, model) }
            }
            compose.onNodeWithTag("home-tab-chat").assertIsDisplayed().assertIsSelected()
            compose.onNodeWithTag("home-session-list").performScrollToIndex(5)
            compose.waitForIdle()
            val anchorTag = "home-runtime-${ids[5]}"
            val anchorTop = compose.onNodeWithTag(anchorTag).assertIsDisplayed().fetchSemanticsNode().boundsInRoot.top

            // S41 / SC62: the root drawer covers the tab bar; dimmed tabs cannot switch pages through it.
            compose.onNodeWithContentDescription("打开会话目录").performClick()
            val drawer = compose.onNodeWithTag("drawer-panel").assertIsDisplayed().fetchSemanticsNode().boundsInRoot
            val tabs = compose.onNodeWithTag("home-tabs").fetchSemanticsNode().boundsInRoot
            assertTrue("The modal directory must cover the tab bar", drawer.top <= tabs.top && drawer.bottom >= tabs.bottom)
            // A tap in the dimmed tab area dismisses the drawer instead of switching root tabs.
            compose.onNodeWithTag("home-tab-settings").performTouchInput { click() }
            compose.onNodeWithTag("home-tab-chat").assertIsSelected()
            compose.onNodeWithTag("home-session-list").assertIsDisplayed()

            compose.onNodeWithTag("home-tab-settings").performClick().assertIsSelected()
            compose.onNodeWithText("连接").assertIsDisplayed()
            compose.onNodeWithText("Agent 供应商").assertDoesNotExist()
            compose.onNodeWithContentDescription("返回").assertDoesNotExist()
            compose.onNodeWithTag("home-session-list").assertDoesNotExist()

            compose.onNodeWithTag("home-tab-providers").performClick().assertIsSelected()
            compose.onNodeWithText("连接").assertDoesNotExist()
            compose.onNodeWithContentDescription("返回").assertDoesNotExist()
            compose.onNodeWithTag("home-tabs").assertIsDisplayed()

            compose.onNodeWithTag("home-tab-chat").performClick().assertIsSelected()
            compose.onNodeWithTag(anchorTag).assertIsDisplayed()
            assertEquals("Peer-tab changes must retain the chat list's scroll anchor", anchorTop,
                compose.onNodeWithTag(anchorTag).fetchSemanticsNode().boundsInRoot.top, 1f)

            compose.onNodeWithContentDescription("打开下载").performClick()
            compose.onNodeWithText("暂无下载").assertIsDisplayed()
            // A pushed page must hide both the visual and accessible peer-tab navigation.
            compose.onNodeWithTag("home-tabs").assertDoesNotExist()
            compose.onNodeWithTag("home-tab-chat").assertDoesNotExist()
            compose.onNodeWithContentDescription("返回").performClick()
            compose.onNodeWithTag("home-tab-chat").assertIsDisplayed().assertIsSelected()
            compose.onNodeWithTag("home-tab-providers").assertIsDisplayed().assertIsNotSelected()
            compose.onNodeWithTag("home-tab-settings").assertIsDisplayed().assertIsNotSelected()
            assertEquals("Returning from downloads must retain the same chat list anchor", anchorTop,
                compose.onNodeWithTag(anchorTag).assertIsDisplayed().fetchSemanticsNode().boundsInRoot.top, 1f)
        } finally {
            compose.runOnIdle { owner.clear() }
            app.dispose()
        }
    }

    @Test fun narrowLargeTypeKeepsAllLabelsAndTouchTargetsInsideTheBar() {
        val selected = mutableStateOf(HomeTab.Providers)
        compose.setContent {
            val density = LocalDensity.current
            CompositionLocalProvider(LocalDensity provides Density(density.density, 1.6f)) {
                OrbisTheme(darkTheme = true) {
                    Box(Modifier.width(320.dp)) {
                        HomeTabBar(selected = selected.value, onSelect = { selected.value = it })
                    }
                }
            }
        }
        val root = compose.onRoot().fetchSemanticsNode().boundsInRoot
        // Capture every label before the first assertion fails, so width/height and fallback-font
        // rounding are distinguishable without weakening the original no-overflow requirement.
        val labelLayouts = destinations.associate { (_, _, description) ->
            val layouts = mutableListOf<TextLayoutResult>()
            compose.onNodeWithText(description, useUnmergedTree = true)
                .performSemanticsAction(SemanticsActions.GetTextLayoutResult) { it(layouts) }
            description to layouts.single()
        }
        val report = buildString {
            appendLine("root=$root requestedWidth=320dp requestedFontScale=1.6")
            destinations.forEach { (_, tag, description) ->
                val layout = labelLayouts.getValue(description)
                appendLine("$tag label=$description tab=${compose.onNodeWithTag(tag).fetchSemanticsNode().boundsInRoot} " +
                    "text=${compose.onNodeWithText(description, useUnmergedTree = true).fetchSemanticsNode().boundsInRoot}")
                appendLine("size=${layout.size} constraints=${layout.layoutInput.constraints} " +
                    "density=${layout.layoutInput.density} fontSize=${layout.layoutInput.style.fontSize} " +
                    "lineHeight=${layout.layoutInput.style.lineHeight} paragraph=${layout.multiParagraph.width}x${layout.multiParagraph.height} " +
                    "overflowWidth=${layout.didOverflowWidth} overflowHeight=${layout.didOverflowHeight} lines=${layout.lineCount}")
                for (line in 0 until layout.lineCount) {
                    appendLine("line=$line left=${layout.getLineLeft(line)} right=${layout.getLineRight(line)} " +
                        "top=${layout.getLineTop(line)} bottom=${layout.getLineBottom(line)} " +
                        "ellipsized=${layout.isLineEllipsized(line)}")
                }
            }
        }
        Log.i("HomeTabsLayout", report)
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val evidence = File(context.getExternalFilesDir(null), "home-tabs").apply { mkdirs() }
        File(evidence, "dark-320-1.6-label-layout.txt").writeText(report)
        File(evidence, "dark-320-1.6.png").outputStream().use {
            compose.onRoot().captureToImage().asAndroidBitmap().compress(Bitmap.CompressFormat.PNG, 100, it)
        }
        val bounds = destinations.map { (_, tag, description) ->
            val tab = compose.onNodeWithTag(tag).assertIsDisplayed()
                .assertContentDescriptionEquals(description)
                .assertWidthIsAtLeast(48.dp).assertHeightIsAtLeast(48.dp)
            val box = tab.fetchSemanticsNode().boundsInRoot
            assertTrue("$description must stay inside the narrow root", box.left >= root.left && box.right <= root.right)
            val layout = labelLayouts.getValue(description)
            assertFalse("$description must not overflow its label\n$report", layout.hasVisualOverflow)
            for (line in 0 until layout.lineCount) {
                assertFalse("$description must not be ellipsized", layout.isLineEllipsized(line))
            }
            box
        }
        for (index in 0 until bounds.lastIndex) {
            assertTrue("Adjacent root tabs must not overlap", bounds[index].right <= bounds[index + 1].left)
        }
        compose.onNodeWithTag("home-tab-settings").performClick().assertIsSelected()
        compose.onNodeWithTag("home-tab-providers").assertIsNotSelected()
        compose.runOnIdle { assertEquals(HomeTab.Settings, selected.value) }
    }
}
