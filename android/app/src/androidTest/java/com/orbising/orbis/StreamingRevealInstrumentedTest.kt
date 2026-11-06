// Orbis 测试用途（场景与判定见本文件断言）：
// - r15 流式顺序（M04）
package com.orbising.orbis

import android.animation.ValueAnimator
import android.graphics.Bitmap
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.width
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.unit.dp
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Rule
import org.junit.Test
import kotlinx.coroutines.runBlocking

/** ADR-0046 §4 / M04: a streamed message reveals strictly in order, across paragraphs. */
class StreamingRevealInstrumentedTest {
    @get:Rule val compose = createComposeRule()

    private fun ink(bitmap: Bitmap): Int {
        val background = bitmap.getPixel(0, 0)
        var count = 0
        for (y in 0 until bitmap.height) for (x in 0 until bitmap.width) {
            val pixel = bitmap.getPixel(x, y)
            val delta = listOf(16, 8, 0).sumOf { shift -> kotlin.math.abs((pixel shr shift and 0xFF) - (background shr shift and 0xFF)) }
            if (delta > 60) count++
        }
        return count
    }

    @Test fun aNewParagraphWaitsForTheTextBeforeIt() {
        assumeTrue("system animations are off; streamed text shows at once by design", ValueAnimator.areAnimatorsEnabled())
        val tail = "第一段" + "继续写很多字让这一批需要一段时间才能逐字显示完".repeat(2)
        // Parsing runs on a real background dispatcher; prewarm so this test controls reveal
        // frames without making a 48ms virtual step a deadline for the native parser.
        runBlocking { listOf("第一段", tail, "$tail\n\n第二段出现").forEach { markdownDocuments.resolve(it) } }
        val text = mutableStateOf("第一段")
        compose.mainClock.autoAdvance = false
        compose.setContent {
            OrbisTheme {
                Box(Modifier.background(MaterialTheme.colorScheme.background).padding(12.dp).width(320.dp)) {
                    CompositionLocalProvider(LocalStreamingText provides true) { MarkdownText(text.value) {} }
                }
            }
        }
        compose.mainClock.advanceTimeBy(200)
        // A long tail for the first paragraph, then a second paragraph arrives right after it.
        compose.runOnIdle { text.value = tail }
        compose.mainClock.advanceTimeBy(48)
        compose.runOnIdle { text.value += "\n\n第二段出现" }
        compose.mainClock.advanceTimeBy(48)
        capture("streaming-first-tail-revealing")
        val second = compose.onNodeWithText("第二段出现").captureToImage().asAndroidBitmap()
        assertEquals("the second paragraph must not draw before the first has finished starting", 0, ink(second))
        compose.mainClock.advanceTimeBy(RevealSchedule.MAX_DELAY_MS * 2 + RevealSchedule.DURATION_MS * 2)
        val settled = compose.onNodeWithText("第二段出现").captureToImage().asAndroidBitmap()
        assertTrue("the second paragraph appears once its turn comes", ink(settled) > 0)
        compose.mainClock.autoAdvance = true
    }

    // STREAM-REVEAL-01: fixed frames distinguish data loss from repainting. A character
    // that has reached full opacity must remain visible while later chunks are queued.
    @Test fun settledPrefixNeverDisappearsDuringSuccessiveChunks() {
        assumeTrue("system animations are off", ValueAnimator.areAnimatorsEnabled())
        val text = mutableStateOf("STABLE PREFIX\n")
        compose.mainClock.autoAdvance = false
        compose.setContent {
            OrbisTheme {
                Box(Modifier.background(MaterialTheme.colorScheme.background).padding(12.dp).width(320.dp)) {
                    val cursor = rememberRevealCursor(true)
                    CompositionLocalProvider(LocalRevealCursor provides cursor) {
                        StreamingMarkdownText(AnnotatedString(text.value), Modifier.fillMaxWidth(),
                            MaterialTheme.typography.bodyMedium, TextAlign.Start)
                    }
                }
            }
        }
        compose.mainClock.advanceTimeBy(200)
        val baseline = compose.onNodeWithText(text.value).captureToImage().asAndroidBitmap()
        val prefixInk = ink(Bitmap.createBitmap(baseline, 0, 0, baseline.width, baseline.height / 2))
        assertTrue("fixture prefix is visible", prefixInk > 0)
        repeat(20) { step ->
            compose.runOnIdle { text.value += "text " }
            compose.mainClock.advanceTimeByFrame()
            val bitmap = compose.onNodeWithText(text.value).captureToImage().asAndroidBitmap()
            val visible = ink(Bitmap.createBitmap(bitmap, 0, 0, baseline.width, baseline.height / 2))
            assertTrue("settled prefix disappeared at chunk $step: $visible < $prefixInk", visible >= prefixInk * 0.9)
        }
        compose.mainClock.autoAdvance = true
    }

    // STREAM-REVEAL-02: sampling the newly appended tail catches a one-frame full-text
    // fallback followed by hiding, which is invisible to semantics-only assertions.
    @Test fun appendedTextDoesNotFlashBeforeItsRevealStarts() {
        assumeTrue("system animations are off", ValueAnimator.areAnimatorsEnabled())
        val text = mutableStateOf("BASE")
        compose.mainClock.autoAdvance = false
        compose.setContent {
            OrbisTheme {
                Box(Modifier.background(MaterialTheme.colorScheme.background).padding(12.dp).width(320.dp)) {
                    val cursor = rememberRevealCursor(true)
                    CompositionLocalProvider(LocalRevealCursor provides cursor) {
                        StreamingMarkdownText(AnnotatedString(text.value), Modifier.fillMaxWidth(),
                            MaterialTheme.typography.bodyMedium, TextAlign.Start)
                    }
                }
            }
        }
        compose.mainClock.advanceTimeBy(200)
        compose.runOnIdle { text.value += " new text that waits in the reveal queue" }
        val counts = mutableListOf<Int>()
        repeat(16) {
            compose.mainClock.advanceTimeByFrame()
            counts += ink(compose.onNodeWithText(text.value).captureToImage().asAndroidBitmap())
        }
        counts.zipWithNext().forEachIndexed { frame, (before, after) ->
            assertTrue("new text flashed at frame $frame: $counts", after >= before * 0.85)
        }
        compose.mainClock.autoAdvance = true
    }

    // STREAM-REVEAL-03: exercise the actual async Markdown body and card measurement,
    // rather than only a Text leaf. Every appended chunk keeps its established prefix painted.
    @Test fun markdownCardKeepsVisibleTextWhileNewChunksArePrepared() {
        assumeTrue("system animations are off", ValueAnimator.areAnimatorsEnabled())
        val text = mutableStateOf("STABLE PREFIX\n\n")
        compose.mainClock.autoAdvance = false
        compose.setContent {
            OrbisTheme {
                Box(Modifier.background(MaterialTheme.colorScheme.background).padding(12.dp).width(320.dp)) {
                    AssistantTurnCard("codex:test",
                        listOf(ChatMessage("reply", "assistant", listOf(RemoteContent("text", text.value)), 1)),
                        null, 0, emptyMap(), emptyMap(), emptyMap(), {}, {}, setOf("reply"))
                }
            }
        }
        compose.waitUntil(5_000) {
            compose.mainClock.advanceTimeByFrame()
            compose.onAllNodesWithText("STABLE PREFIX").fetchSemanticsNodes().isNotEmpty()
        }
        compose.mainClock.advanceTimeBy(800)
        val prefixInk = ink(compose.onNodeWithText("STABLE PREFIX").captureToImage().asAndroidBitmap())
        assertTrue("fixture prefix is visible", prefixInk > 0)
        repeat(20) { chunk ->
            compose.runOnIdle { text.value += "word " }
            repeat(3) { frame ->
                compose.mainClock.advanceTimeByFrame()
                val visible = ink(compose.onNodeWithText("STABLE PREFIX").captureToImage().asAndroidBitmap())
                assertTrue("Markdown prefix disappeared at chunk $chunk frame $frame: $visible < $prefixInk",
                    visible >= prefixInk * 0.9)
            }
        }
        compose.mainClock.autoAdvance = true
    }

    private fun capture(name: String) {
        val context = androidx.test.platform.app.InstrumentationRegistry.getInstrumentation().targetContext
        val directory = java.io.File(context.getExternalFilesDir(null), "r15").apply { mkdirs() }
        java.io.File(directory, "$name.png").outputStream().use {
            compose.onRoot().captureToImage().asAndroidBitmap().compress(android.graphics.Bitmap.CompressFormat.PNG, 100, it)
        }
    }
}
