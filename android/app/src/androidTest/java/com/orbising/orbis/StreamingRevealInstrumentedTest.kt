package com.orbising.orbis

import android.animation.ValueAnimator
import android.graphics.Bitmap
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.unit.dp
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Rule
import org.junit.Test

/** ADR-0053 §1 / M04: a streamed message reveals strictly in order, across paragraphs. */
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
        compose.runOnIdle { text.value = "第一段" + "继续写很多字让这一批需要一段时间才能逐字显示完".repeat(2) }
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

    private fun capture(name: String) {
        val context = androidx.test.platform.app.InstrumentationRegistry.getInstrumentation().targetContext
        val directory = java.io.File(context.getExternalFilesDir(null), "r15").apply { mkdirs() }
        java.io.File(directory, "$name.png").outputStream().use {
            compose.onRoot().captureToImage().asAndroidBitmap().compress(android.graphics.Bitmap.CompressFormat.PNG, 100, it)
        }
    }
}
