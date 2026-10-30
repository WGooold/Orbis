package com.orbising.orbis

import android.content.Context
import android.graphics.Bitmap
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.lifecycle.ViewModelStore
import androidx.test.core.app.ApplicationProvider
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Rule
import org.junit.Test

/** Real Host/Relay/Mods -> encryption -> Android cache/reducer -> production ChatScreen. */
class ClaudeHistoryInstrumentedTest {
    @get:Rule val compose = createComposeRule()

    @Test fun existingHistoryAndRunningTurnSurviveParallelToolsAndReconnect() {
        val port = InstrumentationRegistry.getArguments().getString("claudeFixturePort")
        assumeTrue("Start scripts/claude-history-fixture.mjs and supply claudeFixturePort", port != null)
        val baseUrl = "http://10.0.2.2:$port"
        fun request(path: String, post: Boolean = false): String {
            val connection = URL("$baseUrl$path").openConnection() as HttpURLConnection
            connection.connectTimeout = 10_000
            connection.readTimeout = 15_000
            if (post) connection.requestMethod = "POST"
            return try { connection.inputStream.bufferedReader().use { it.readText() } }
            finally { connection.disconnect() }
        }
        val raw = request("/pairing")
        val pairing = Json.parseToJsonElement(raw).jsonObject
        val base = ApplicationProvider.getApplicationContext<Context>()
        val app = IsolatedTestApplication(base, prefix = "claude-history")
        val runtimeId = "claude:claude-history-fixture"
        var owner = ViewModelStore()
        lateinit var model: RemoteViewModel
        val displayed = mutableStateOf<RemoteViewModel?>(null)
        fun start() = compose.runOnIdle {
            model = RemoteViewModel(app)
            owner.put("claude", model)
            displayed.value = model
        }
        fun hasText(text: String) = model.state.value.conversations[runtimeId]?.messages
            ?.any { message -> message.content.any { it.text == text } } == true
        fun screenshot(name: String) {
            val folder = File(base.getExternalFilesDir(null), "claude-history").apply { mkdirs() }
            File(folder, "$name.png").outputStream().use {
                compose.onRoot().captureToImage().asAndroidBitmap().compress(Bitmap.CompressFormat.PNG, 100, it)
            }
        }
        try {
            start()
            compose.setContent {
                displayed.value?.let { vm ->
                    val state by vm.state.collectAsState()
                    OrbisTheme { AgentTheme(agentBrand("claude")) { ChatScreen(state, vm) } }
                }
            }
            compose.runOnIdle {
                model.pair(pairing.getValue("relayUrl").jsonPrimitive.content,
                    pairing.getValue("code").jsonPrimitive.content, raw)
            }
            compose.waitUntil(30_000) { model.state.value.e2eReady && runtimeId in model.state.value.runtimes }
            assertTrue("Claude must advertise graph sync before opening the chat",
                model.state.value.runtimes.getValue(runtimeId).sessionGraphSync)
            compose.runOnIdle { model.selectRuntime(runtimeId) }
            compose.waitUntil(30_000) { hasText("CLAUDE_HISTORY_VISIBLE") && hasText("CLAUDE_ALREADY_STREAMING") }
            compose.onNodeWithText("CLAUDE_HISTORY_VISIBLE").assertIsDisplayed()
            compose.onNodeWithText("CLAUDE_ALREADY_STREAMING").assertIsDisplayed()
            screenshot("history-and-running-turn")

            request("/advance", post = true)
            compose.waitUntil(30_000) { hasText("CLAUDE_PARALLEL_HISTORY") && hasText("CLAUDE_STREAM_VISIBLE") }
            compose.onNodeWithText("CLAUDE_STREAM_VISIBLE").assertIsDisplayed()
            assertNull(model.state.value.conversations[runtimeId]?.chatSyncError)
            screenshot("parallel-tools-and-stream")

            request("/finish", post = true)
            compose.waitUntil(30_000) {
                hasText("CLAUDE_FINAL_VISIBLE") && model.state.value.conversations[runtimeId]?.streamingMessageIds?.isEmpty() == true
            }
            compose.runOnIdle { displayed.value = null; owner.clear(); owner = ViewModelStore() }
            start()
            compose.waitUntil(30_000) { model.state.value.e2eReady && runtimeId in model.state.value.runtimes }
            compose.runOnIdle { model.selectRuntime(runtimeId) }
            compose.waitUntil(30_000) { hasText("CLAUDE_FINAL_VISIBLE") && model.state.value.sessionSyncCommands.isEmpty() }
            assertTrue(hasText("CLAUDE_HISTORY_VISIBLE"))
            assertTrue(hasText("CLAUDE_PARALLEL_HISTORY"))
            compose.onNodeWithText("CLAUDE_FINAL_VISIBLE").assertIsDisplayed()
            assertNull(model.state.value.conversations[runtimeId]?.chatSyncError)
            val stats = Json.parseToJsonElement(request("/stats")).jsonObject
            assertEquals("Host must accept canonical and live transactions", 0, stats.getValue("rejected").jsonArray.size)
            screenshot("reopened-history")
        } finally {
            compose.runOnIdle { displayed.value = null; owner.clear() }
            app.dispose()
        }
    }
}
