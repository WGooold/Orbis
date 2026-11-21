package com.orbising.orbis

import android.view.View
import android.view.ViewGroup
import android.webkit.WebView
import androidx.activity.ComponentActivity
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material3.Text
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollToIndex
import androidx.compose.ui.unit.dp
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test

/** SC116 / SC128: run the product preview card and page host within a scrolled conversation. */
class ChatFilePreviewInteractionTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    @Test fun showsAStillImageInTheCardAndReusesTheFetchedPage() {
        lateinit var host: PreviewTestHost
        lateinit var listState: LazyListState
        var downloads = 0
        compose.setContent {
            val scope = rememberCoroutineScope()
            val fake = remember(scope) { PreviewTestHost(scope) }
            val actions = remember(fake) { FilePreviewActions(fake.preview, "session", fake.preview::open) }
            val list = rememberLazyListState()
            SideEffect { host = fake; listState = list }
            OrbisTheme {
                ChatFilePreviewHost(actions) {
                    LazyColumn(Modifier.fillMaxSize().testTag("preview-test-list"), state = list) {
                        items(80, key = { it }) { index ->
                            if (index == 40) ChatFilePreviewCard("message:40", fake.source, "report.html",
                                downloadTag = "preview-test-download", onDownload = { downloads++ }) {
                                NeumorphTextButton(L10n.tr("下载"), onClick = { downloads++ })
                            } else Box(Modifier.height(56.dp)) { Text("Message $index") }
                        }
                    }
                }
            }
        }

        val list = compose.onNodeWithTag("preview-test-list")
        val open = compose.onNodeWithTag("chat-file-preview-open")
        val page = compose.onNodeWithTag("chat-file-preview-reader")
        val still = compose.onNodeWithTag("chat-file-preview-snapshot")
        list.performScrollToIndex(40)
        open.assertIsDisplayed()
        compose.onNodeWithTag("chat-file-preview-panel").assertDoesNotExist()
        compose.runOnIdle { assertTrue(host.sent.isEmpty()); assertTrue(webViews().isEmpty()) }

        open.performClick()
        compose.runOnIdle {
            val command = host.sent.first().getValue("command").jsonObject
            assertEquals("artifact.download", command.getValue("type").jsonPrimitive.content)
            assertEquals(host.artifact, command.getValue("artifactId").jsonPrimitive.content)
            assertNull(command["maxBytes"])
            assertNotNull(command["web"])
        }
        // The inline page loads its own files, then a still image replaces the live WebView.
        compose.waitUntil(15_000) { compose.runOnIdle { host.preview.selection.value?.snapshot != null && webViews().isEmpty() } }
        still.assertIsDisplayed()
        assertEquals(setOf("style.css", "app.js", "pixel.png"), host.requested.toSet())
        compose.waitForIdle()
        val instrumentation = androidx.test.platform.app.InstrumentationRegistry.getInstrumentation()
        instrumentation.uiAutomation.takeScreenshot()?.let { screenshot ->
            java.io.File(instrumentation.targetContext.getExternalFilesDir(null), "SC128-chat-card.png").outputStream().use {
                screenshot.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, it)
            }
            screenshot.recycle()
        }
        val anchor = compose.runOnIdle { listState.firstVisibleItemIndex to listState.firstVisibleItemScrollOffset }
        assertEquals(40, anchor.first)
        val ready = compose.runOnIdle { checkNotNull(host.preview.selection.value) }
        val wire = host.sent.size

        compose.onNodeWithTag("chat-file-preview-fullscreen").performClick()
        page.assertIsDisplayed()
        awaitBrowser(fullScreen = true)
        compose.onNodeWithContentDescription(L10n.tr("返回")).performClick()
        page.assertDoesNotExist()
        compose.waitUntil(4_000) { compose.runOnIdle { webViews().isEmpty() } }
        still.assertIsDisplayed()
        compose.runOnIdle {
            assertEquals(anchor, listState.firstVisibleItemIndex to listState.firstVisibleItemScrollOffset)
            assertEquals(ready.id, host.preview.selection.value?.id)
            assertSame(ready.entry, host.preview.selection.value?.entry)
        }

        list.performScrollToIndex(60)
        list.performScrollToIndex(40)
        still.assertIsDisplayed()
        compose.runOnIdle { assertTrue(webViews().isEmpty()) }
        assertEquals("full screen and scrolling reuse the fetched page", wire, host.sent.size)
        compose.onNodeWithTag("preview-test-download").performClick()
        compose.runOnIdle { assertEquals(1, downloads) }
    }

    private fun awaitBrowser(fullScreen: Boolean) {
        compose.waitUntil(8_000) {
            compose.runOnIdle {
                webViews().singleOrNull()?.let { it.title?.startsWith("ran") == true && it.isVerticalScrollBarEnabled == fullScreen } == true
            }
        }
    }

    private fun webViews(): List<WebView> {
        fun find(view: View): List<WebView> = when (view) {
            is WebView -> listOf(view)
            is ViewGroup -> (0 until view.childCount).flatMap { find(view.getChildAt(it)) }
            else -> emptyList()
        }
        return find(compose.activity.window.decorView)
    }
}
