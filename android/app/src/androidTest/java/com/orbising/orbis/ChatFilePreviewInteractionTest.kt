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
import java.security.MessageDigest
import java.util.UUID
import java.util.concurrent.CopyOnWriteArrayList
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test

/** SC116: run the product preview card and page host within a scrolled conversation. */
class ChatFilePreviewInteractionTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    @Test fun reusesTheVerifiedPreviewAndPreservesTheScrolledPosition() {
        val artifact = UUID.randomUUID().toString()
        val transfer = UUID.randomUUID().toString()
        val source = ChatFilePreview.Source(artifactId = artifact)
        val document = "<!doctype html><title>Preview report</title><p>Report</p>".toByteArray()
        val digest = MessageDigest.getInstance("SHA-256").digest(document).joinToString("") { "%02x".format(it) }
        val sent = CopyOnWriteArrayList<JsonObject>()
        lateinit var preview: ChatFilePreview
        lateinit var listState: LazyListState
        var downloads = 0
        compose.setContent {
            val scope = rememberCoroutineScope()
            val receiver = remember(scope) {
                ChatFilePreview(scope, "host", { sent.add(it) }, { false }, automaticTick = false).apply { authenticated(true) }
            }
            val actions = remember(receiver) { FilePreviewActions(receiver, "session", receiver::open) }
            val list = rememberLazyListState()
            SideEffect { preview = receiver; listState = list }
            OrbisTheme {
                ChatFilePreviewHost(actions) {
                    LazyColumn(Modifier.fillMaxSize().testTag("preview-test-list"), state = list) {
                        items(80, key = { it }) { index ->
                            if (index == 40) ChatFilePreviewCard("message:40", source, "report.html") {
                                NeumorphTextButton(L10n.tr("下载"), onClick = { downloads++ }, modifier = Modifier.testTag("preview-test-download"))
                            } else Box(Modifier.height(56.dp)) { Text("Message $index") }
                        }
                    }
                }
            }
        }

        val list = compose.onNodeWithTag("preview-test-list")
        val open = compose.onNodeWithTag("chat-file-preview-open")
        val panel = compose.onNodeWithTag("chat-file-preview-panel")
        val page = compose.onNodeWithTag("chat-file-preview-reader")
        val download = compose.onNodeWithTag("preview-test-download")
        list.performScrollToIndex(40)
        open.assertIsDisplayed()
        panel.assertDoesNotExist()
        compose.runOnIdle { assertTrue(sent.isEmpty()); assertTrue(webViews().isEmpty()) }

        open.performClick()
        compose.onNodeWithTag("chat-file-preview-loading").assertIsDisplayed()
        compose.runOnIdle {
            assertTrue(webViews().isEmpty())
            val command = sent.single()
            val downloadCommand = command.getValue("command").jsonObject
            assertEquals("artifact.download", downloadCommand.getValue("type").jsonPrimitive.content)
            assertEquals(artifact, downloadCommand.getValue("artifactId").jsonPrimitive.content)
            assertEquals(ChatFilePreview.MAX_BYTES.toString(), downloadCommand.getValue("maxBytes").jsonPrimitive.content)
            assertTrue(preview.consume(buildJsonObject {
                put("type", "file.preview.started"); put("protocolVersion", PROTOCOL_VERSION); put("runtimeId", "host")
                put("commandId", command.getValue("commandId").jsonPrimitive.content); put("transferId", transfer)
                put("artifactId", artifact); put("format", "html"); put("size", document.size); put("sha256", digest)
            }))
            preview.tick()
            assertEquals("artifact.read", sent.last().getValue("type").jsonPrimitive.content)
            assertTrue(preview.consume(ArtifactChunkFrame("host", transfer, 0, document)))
        }
        awaitBrowser(fullScreen = false)
        val anchor = compose.runOnIdle { listState.firstVisibleItemIndex to listState.firstVisibleItemScrollOffset }
        assertEquals(40, anchor.first)
        val ready = compose.runOnIdle { checkNotNull(preview.selection.value) }
        assertEquals(listOf("runtime.command", "artifact.read", "artifact.done"), sent.map { it.getValue("type").jsonPrimitive.content })

        compose.onNodeWithTag("chat-file-preview-fullscreen").performClick()
        page.assertIsDisplayed()
        awaitBrowser(fullScreen = true)
        compose.onNodeWithContentDescription(L10n.tr("返回")).performClick()
        page.assertDoesNotExist()
        awaitBrowser(fullScreen = false)
        panel.assertIsDisplayed()
        compose.runOnIdle {
            assertEquals(anchor, listState.firstVisibleItemIndex to listState.firstVisibleItemScrollOffset)
            assertEquals(ready.id, preview.selection.value?.id)
            assertSame(ready.document, preview.selection.value?.document)
        }

        list.performScrollToIndex(60)
        compose.waitUntil(4_000) { compose.runOnIdle { webViews().isEmpty() } }
        list.performScrollToIndex(40)
        awaitBrowser(fullScreen = false)
        assertEquals(3, sent.size)
        download.performClick()
        compose.runOnIdle { assertEquals(1, downloads) }
    }

    private fun awaitBrowser(fullScreen: Boolean) {
        compose.waitUntil(8_000) {
            compose.runOnIdle {
                webViews().singleOrNull()?.let { it.title == "Preview report" && it.isVerticalScrollBarEnabled == fullScreen } == true
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
