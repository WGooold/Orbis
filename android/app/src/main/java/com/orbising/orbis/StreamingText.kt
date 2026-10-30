package com.orbising.orbis

import android.animation.ValueAnimator
import android.graphics.BlurMaskFilter
import android.graphics.Paint
import android.graphics.Typeface
import androidx.compose.material3.LocalContentColor
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.graphics.ClipOp
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.drawscope.clipPath
import androidx.compose.ui.graphics.drawscope.drawIntoCanvas
import androidx.compose.ui.graphics.nativeCanvas
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.graphics.isSpecified
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.style.TextAlign
import android.icu.text.BreakIterator
import java.util.Locale

internal val LocalStreamingText = staticCompositionLocalOf { false }

/** Existing text stays still. Only newly appended graphemes get arrival times. */
internal class GlyphRevealClock(initialText: String = "") {
    private var previous = initialText
    private val arrivals = linkedMapOf<Int, Pair<Int, Long>>()
    fun settle(text: String) {
        previous = text
        arrivals.clear()
    }
    fun observe(text: String, now: Long) {
        if (!text.startsWith(previous)) arrivals.clear()
        val start = (if (text.startsWith(previous)) previous.length else text.length).coerceAtLeast(text.length - 128)
        val breaks = BreakIterator.getCharacterInstance(Locale.ROOT).apply { setText(text) }
        var offset = if (start == 0) 0 else breaks.following(start - 1)
        var ordinal = 0
        while (offset != BreakIterator.DONE && offset < text.length) {
            val end = breaks.following(offset)
            if (end == BreakIterator.DONE) break
            arrivals[offset] = end to (now + (ordinal++ * 30L).coerceAtMost(450L))
            offset = end
        }
        previous = text
        arrivals.entries.removeAll { now - it.value.second >= 120L }
    }
    fun active(now: Long): List<Triple<Int, Int, Float>> = arrivals.mapNotNull { (start, value) ->
        val (end, time) = value
        val progress = ((now - time) / 120f).coerceIn(0f, 1f)
        if (progress >= 1f) null else Triple(start, end, progress)
    }
}

/** Native Text keeps its layout, selection and links; the reveal changes paint only. */
@Composable
internal fun StreamingMarkdownText(
    text: AnnotatedString,
    modifier: Modifier,
    style: TextStyle,
    textAlign: TextAlign,
) {
    val streaming = LocalStreamingText.current && ValueAnimator.areAnimatorsEnabled()
    // Mounting a row or enabling live rendering establishes a baseline; only later appends animate.
    val clock = remember(streaming) { GlyphRevealClock(text.text) }
    var frame by remember { mutableLongStateOf(0L) }
    var layout by remember { mutableStateOf<TextLayoutResult?>(null) }
    val density = LocalDensity.current
    val foreground = if (style.color.isSpecified) style.color else LocalContentColor.current
    val nativePaint = remember { Paint(Paint.ANTI_ALIAS_FLAG or Paint.SUBPIXEL_TEXT_FLAG) }
    val filters = remember(density.density) {
        Array(8) { BlurMaskFilter(6 * density.density * (it + 1) / 8, BlurMaskFilter.Blur.NORMAL) }
    }
    LaunchedEffect(text.text, streaming) {
        if (!streaming) { clock.settle(text.text); return@LaunchedEffect }
        withFrameMillis { now -> clock.observe(text.text, now); frame = now }
        while (clock.active(frame).isNotEmpty()) withFrameMillis { frame = it }
    }
    Text(text, modifier = modifier.drawWithContent {
        val result = layout
        val active = if (streaming) clock.active(frame) else emptyList()
        if (result == null || active.isEmpty()) { drawContent(); return@drawWithContent }
        val cutouts = Path()
        active.forEach { (start, _, _) ->
            if (start < result.layoutInput.text.length) cutouts.addRect(result.getBoundingBox(start))
        }
        clipPath(cutouts, ClipOp.Difference) { this@drawWithContent.drawContent() }
        drawIntoCanvas { canvas ->
            active.forEach { (start, end, progress) ->
                if (progress <= 0f || start >= result.layoutInput.text.length || end > text.length || end > result.layoutInput.text.length) return@forEach
                val span = text.spanStyles.lastOrNull { start >= it.start && start < it.end }?.item
                val weight = span?.fontWeight ?: style.fontWeight ?: FontWeight.Normal
                val family = if ((span?.fontFamily ?: style.fontFamily) == FontFamily.Monospace) "monospace" else "sans-serif"
                val bold = weight >= FontWeight.SemiBold
                val italic = (span?.fontStyle ?: style.fontStyle) == FontStyle.Italic
                val nativeStyle = when {
                    bold && italic -> Typeface.BOLD_ITALIC
                    bold -> Typeface.BOLD
                    italic -> Typeface.ITALIC
                    else -> Typeface.NORMAL
                }
                nativePaint.typeface = Typeface.create(family, nativeStyle)
                nativePaint.fontFeatureSettings = style.fontFeatureSettings ?: "tnum"
                nativePaint.textSize = with(density) { style.fontSize.toPx() }
                nativePaint.color = (span?.color?.takeIf { it.isSpecified } ?: foreground).toArgb()
                nativePaint.alpha = (255 * progress).toInt()
                nativePaint.maskFilter = filters[((1f - progress) * 7).toInt().coerceIn(0, 7)]
                val line = result.getLineForOffset(start)
                val box = result.getBoundingBox(start)
                val rtl = result.getBidiRunDirection(start) == androidx.compose.ui.text.style.ResolvedTextDirection.Rtl
                canvas.nativeCanvas.drawTextRun(text.text, start, end, result.getLineStart(line), result.getLineEnd(line),
                    if (rtl) box.right else box.left, result.getLineBaseline(line), rtl, nativePaint)
            }
        }
    }, style = style, textAlign = textAlign, onTextLayout = { layout = it })
}
