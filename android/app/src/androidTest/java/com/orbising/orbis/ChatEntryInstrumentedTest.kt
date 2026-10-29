package com.orbising.orbis

import android.app.Application
import android.content.Context
import android.content.SharedPreferences
import android.os.SystemClock
import android.util.Log
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.Button
import androidx.compose.material3.Text
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.SideEffect
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.lifecycle.ViewModelStore
import androidx.test.core.app.ApplicationProvider
import java.io.File
import java.util.UUID
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test

/** Render-only entry fixture: no Host or transport, uses production chat + navigation surfaces. */
class ChatEntryInstrumentedTest {
    @get:Rule val compose = createComposeRule()
    private class IsolatedApplication(base: Context) : Application() {
        private val prefix = "viewport-${UUID.randomUUID()}"
        private val root = File(base.filesDir, prefix).apply { mkdirs() }
        private val preferences = mutableSetOf<String>()
        init { attachBaseContext(base) }
        override fun getApplicationContext(): Context = this
        override fun getFilesDir(): File = root
        override fun getCacheDir(): File = File(root, "cache").apply { mkdirs() }
        override fun getNoBackupFilesDir(): File = File(root, "no-backup").apply { mkdirs() }
        override fun getSharedPreferences(name: String, mode: Int): SharedPreferences {
            val isolated = "$prefix-$name"
            preferences += isolated
            return baseContext.getSharedPreferences(isolated, mode)
        }
        fun dispose() {
            preferences.forEach { baseContext.deleteSharedPreferences(it) }
            root.deleteRecursively()
        }
    }


    @Test fun cachedLongConversationEntryAndReentry() {
        val app = IsolatedApplication(ApplicationProvider.getApplicationContext())
        val owner = ViewModelStore()
        val model = RemoteViewModel(app)
        owner.put("entry", model)
        val opened = mutableStateOf(false)
        val messages = (1..80).flatMap { index -> listOf(
            ChatMessage("user-$index", "user", listOf(RemoteContent("text", "Question $index")), 1),
            ChatMessage("reply-$index", "assistant", listOf(RemoteContent("text", "Cached history paragraph.\n\n".repeat(8))), 1))
        } + listOf(ChatMessage("last-user", "user", listOf(RemoteContent("text", "Long turn")), 1)) +
            (1..80).map { index -> ChatMessage("step-$index", "assistant",
                listOf(RemoteContent("text", "Step $index\n\n**Verify** the source, layout and tools.\n\nPreserve the complete content and reading position.")), 1) } +
            ChatMessage("latest", "assistant", listOf(RemoteContent("text", "ENTRY_LATEST")), 1)
        val state = RemoteState(selectedRuntimeId = "r", connection = RelayConnection.ONLINE,
            runtimes = mapOf("r" to RuntimeSummary("r", "Entry fixture", "/", "idle", "s")),
            conversations = mapOf("r" to RuntimeConversation(messages = messages, hasLiveSnapshot = true)))
        var tapped = 0L
        var drawn = 0L
        var underlayBuilds = 0
        try {
            compose.setContent {
                OrbisTheme {
                    if (opened.value) SwipeBackLayer(onBack = { opened.value = false }, underlay = {
                        SideEffect { underlayBuilds++ }
                        Text("Home underlay")
                    }) {
                        Box(Modifier.fillMaxSize().drawWithContent {
                            drawContent()
                            if (drawn == 0L) drawn = SystemClock.elapsedRealtimeNanos()
                        }) { ChatScreen(state, model) }
                    } else Button(onClick = { tapped = SystemClock.elapsedRealtimeNanos(); opened.value = true }) { Text("Open") }
                }
            }
            repeat(3) { index ->
                compose.runOnIdle { drawn = 0L; underlayBuilds = 0 }
                compose.onNodeWithText("Open").performClick()
                compose.waitUntil(15_000) { drawn > 0L }
                compose.waitForIdle()
                Log.i("OrbisChatEntry", "entry=${index + 1} drawMs=${(drawn - tapped) / 1_000_000.0} underlayBuilds=$underlayBuilds")
                assertEquals("The entry underlay must be composed once, not on every animation frame", 1, underlayBuilds)
                assertTrue("Cached entry rendering exceeded 500 ms", drawn - tapped < 500_000_000L)
                compose.onNodeWithText("ENTRY_LATEST").assertIsDisplayed()
                compose.runOnIdle { opened.value = false }
            }
        } finally {
            compose.runOnIdle { owner.clear() }
            app.dispose()
        }
    }
}
