package com.orbising.orbis

import androidx.compose.material3.Text
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.runBlocking
import org.junit.Rule
import org.junit.Test

class MarkdownPresentationInstrumentedTest {
    @get:Rule val compose = createComposeRule()

    // MARKDOWN-LIVE-01: a cache hit can be painted before the async collector catches up.
    // The next cache miss must retain that displayed version, even if an older read finishes.
    @Test fun aCacheHitRemainsVisibleDuringTheNextPendingParse() {
        val cache = MarkdownDocumentCache()
        val first = runBlocking { cache.resolve("FIRST") }
        val second = runBlocking { cache.resolve("FIRST SECOND") }
        val third = runBlocking { cache.resolve("FIRST SECOND THIRD") }
        val pendingSecond = CompletableDeferred<PreparedMarkdown>()
        val pendingThird = CompletableDeferred<PreparedMarkdown>()
        val input = mutableStateOf("FIRST")
        val cached = mutableStateOf<PreparedMarkdown?>(null)
        compose.setContent {
            val document = rememberMarkdownDocument(input.value, cached.value) { text ->
                when (text) {
                    "FIRST" -> first
                    "FIRST SECOND" -> pendingSecond.await()
                    else -> pendingThird.await()
                }
            }
            Text(document?.inline?.values?.single()?.text.orEmpty())
        }
        compose.onNodeWithText("FIRST").assertExists()
        compose.runOnIdle { input.value = "FIRST SECOND"; cached.value = second }
        compose.onNodeWithText("FIRST SECOND").assertExists()
        compose.runOnIdle { input.value = "FIRST SECOND THIRD"; cached.value = null }
        compose.onNodeWithText("FIRST SECOND").assertExists()
        compose.runOnIdle { pendingSecond.complete(second) }
        compose.onNodeWithText("FIRST SECOND").assertExists()
        compose.runOnIdle { pendingThird.complete(third) }
        compose.onNodeWithText("FIRST SECOND THIRD").assertExists()
    }

    // The first background parse can finish after a newer cache hit has already painted.
    // Rejecting that stale completion protects the retained body on the following cache miss.
    @Test fun anOlderParseCannotReplaceTheNewerDisplayedDocument() {
        val cache = MarkdownDocumentCache()
        val first = runBlocking { cache.resolve("FIRST") }
        val second = runBlocking { cache.resolve("FIRST SECOND") }
        val third = runBlocking { cache.resolve("FIRST SECOND THIRD") }
        val pendingFirst = CompletableDeferred<PreparedMarkdown>()
        val pendingThird = CompletableDeferred<PreparedMarkdown>()
        val input = mutableStateOf("FIRST")
        val cached = mutableStateOf<PreparedMarkdown?>(first)
        compose.setContent {
            val document = rememberMarkdownDocument(input.value, cached.value) { text ->
                if (text == "FIRST") pendingFirst.await() else pendingThird.await()
            }
            Text(document?.inline?.values?.single()?.text.orEmpty())
        }
        compose.onNodeWithText("FIRST").assertExists()
        compose.runOnIdle { input.value = "FIRST SECOND"; cached.value = second }
        compose.onNodeWithText("FIRST SECOND").assertExists()
        compose.runOnIdle { pendingFirst.complete(first) }
        compose.runOnIdle { input.value = "FIRST SECOND THIRD"; cached.value = null }
        compose.onNodeWithText("FIRST SECOND").assertExists()
        compose.runOnIdle { pendingThird.complete(third) }
        compose.onNodeWithText("FIRST SECOND THIRD").assertExists()
    }

    // A slow parser must still publish useful intermediate chunks. Dropping every result
    // whose input is no longer current can freeze all live output until the turn ends.
    @Test fun anIntermediateParseCanAdvanceTheBodyWhileTheNextChunkWaits() {
        val cache = MarkdownDocumentCache()
        val first = runBlocking { cache.resolve("FIRST") }
        val second = runBlocking { cache.resolve("FIRST SECOND") }
        val third = runBlocking { cache.resolve("FIRST SECOND THIRD") }
        val pendingSecond = CompletableDeferred<PreparedMarkdown>()
        val pendingThird = CompletableDeferred<PreparedMarkdown>()
        val input = mutableStateOf("FIRST")
        compose.setContent {
            val document = rememberMarkdownDocument(input.value, null) { text ->
                when (text) {
                    "FIRST" -> first
                    "FIRST SECOND" -> pendingSecond.await()
                    else -> pendingThird.await()
                }
            }
            Text(document?.inline?.values?.single()?.text.orEmpty())
        }
        compose.onNodeWithText("FIRST").assertExists()
        compose.runOnIdle { input.value = "FIRST SECOND" }
        compose.runOnIdle { input.value = "FIRST SECOND THIRD" }
        compose.runOnIdle { pendingSecond.complete(second) }
        compose.onNodeWithText("FIRST SECOND").assertExists()
        compose.runOnIdle { pendingThird.complete(third) }
        compose.onNodeWithText("FIRST SECOND THIRD").assertExists()
    }
}
