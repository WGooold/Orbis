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
import java.util.TreeMap
import kotlinx.coroutines.flow.collectLatest

internal val LocalStreamingText = staticCompositionLocalOf { false }

/** The reveal timeline of the streamed message being composed; null when nothing animates. */
internal val LocalRevealCursor = staticCompositionLocalOf<RevealCursor?> { null }

/** Document-order position of the current Markdown block inside its message. */
internal val LocalRevealPath = compositionLocalOf { emptyList<Int>() }

/**
 * One reveal timeline for a streamed message (ADR-0051 M04, ADR-0046 §4). Characters start
 * fading in strictly in rendered order: a new batch queues behind the tail that has not started
 * yet, so the end of one batch and the start of the next never animate at once. When the queue
 * would trail the stream by more than [MAX_DELAY_MS], the spacing compresses (several adjacent
 * characters may start in one frame) but the order never changes. Offsets are UTF-16 positions
 * in the message's concatenated rendered text; at most [maxActive] trailing ones animate.
 */
internal class RevealSchedule(private val maxActive: Int = Int.MAX_VALUE) {
    private class Segment(val start: Int, val end: Int, val at: Double, val interval: Double) {
        fun startOf(offset: Int) = at + (offset - start) * interval
        val lastStart: Double get() = startOf(end - 1)
    }

    private val segments = ArrayDeque<Segment>()

    /** Length already scheduled; -1 until the first observation takes the text as the baseline. */
    var known = -1
        private set

    /** Everything before this offset has settled. */
    var settledBelow = Int.MAX_VALUE
        private set

    fun reset() {
        known = -1
        settledBelow = Int.MAX_VALUE
        segments.clear()
    }

    fun settle(length: Int) {
        known = length
        settledBelow = length
        segments.clear()
    }

    fun observe(length: Int, now: Long) {
        tick(now)
        // Rewritten or shortened text settles at once; it never replays.
        if (known < 0 || length < known) { settle(length); return }
        if (length == known) return
        val count = length - known
        val deadline = now + MAX_DELAY_MS.toDouble()
        val next = segments.lastOrNull()?.let { it.lastStart + it.interval } ?: now.toDouble()
        val first = next.coerceIn(now.toDouble(), deadline)
        val interval = if (count == 1) STAGGER_MS.toDouble()
            else ((deadline - first) / (count - 1)).coerceIn(0.0, STAGGER_MS.toDouble())
        segments.addLast(Segment(known, length, first, interval))
        known = length
        if (length - maxActive > settledBelow) {
            settledBelow = length - maxActive
            while (segments.isNotEmpty() && segments.first().end <= settledBelow) segments.removeFirst()
        }
    }

    fun tick(now: Long) {
        while (segments.isNotEmpty() && segments.first().lastStart + DURATION_MS <= now) {
            settledBelow = maxOf(settledBelow, segments.removeFirst().end)
        }
    }

    /** 0 = not shown yet, 1 = settled. Characters past [known] stay hidden until observed. */
    fun progress(offset: Int, now: Long): Float {
        if (offset < settledBelow) return 1f
        if (offset >= known) return 0f
        val segment = segments.lastOrNull { it.start <= offset } ?: return 1f
        return ((now - segment.startOf(offset)) / DURATION_MS).toFloat().coerceIn(0f, 1f)
    }

    fun isAnimating(now: Long) = segments.isNotEmpty() && now < segments.last().lastStart + DURATION_MS

    /** When [offset] starts revealing; null once it has settled or before it is observed. */
    fun startTime(offset: Int): Double? =
        if (offset < settledBelow || offset >= known) null
        else segments.lastOrNull { it.start <= offset }?.startOf(offset)

    companion object {
        const val DURATION_MS = 120L
        const val STAGGER_MS = 30L
        const val MAX_DELAY_MS = 450L
        const val MAX_ACTIVE = 128
    }
}

private val RevealPathOrder = Comparator<List<Int>> { a, b ->
    for (index in 0 until minOf(a.size, b.size)) {
        val order = a[index].compareTo(b[index])
        if (order != 0) return@Comparator order
    }
    a.size.compareTo(b.size)
}

/**
 * Joins one message's Markdown blocks into a single timeline: each block registers its rendered
 * length under its document-order path, so a paragraph that appears mid-stream continues where
 * the previous one stopped instead of showing up whole.
 */
@Stable
internal class RevealCursor {
    val schedule = RevealSchedule(RevealSchedule.MAX_ACTIVE)
    private val lengths = TreeMap<List<Int>, Int>(RevealPathOrder)
    var revision by mutableIntStateOf(0)
        private set
    /** The frame time the blocks draw at. */
    var frame by mutableLongStateOf(0L)
    internal var streaming = false

    val total: Int get() = lengths.values.sum()

    fun register(path: List<Int>, length: Int) {
        if (lengths.put(path, length) != length) revision++
    }

    fun unregister(path: List<Int>) {
        if (lengths.remove(path) != null) revision++
    }

    fun base(path: List<Int>): Int = lengths.headMap(path).values.sum()
}

/** The message's cursor while it streams, and afterwards until the queued characters settle. */
@Composable
internal fun rememberRevealCursor(streaming: Boolean): RevealCursor? {
    val cursor = remember { RevealCursor() }
    var draining by remember { mutableStateOf(false) }
    LaunchedEffect(cursor, streaming) {
        if (streaming != cursor.streaming) {
            cursor.streaming = streaming
            // Starting to stream takes the current text as the baseline; ending lets the queue drain.
            if (streaming) cursor.schedule.reset() else draining = cursor.schedule.isAnimating(cursor.frame)
        }
        if (!streaming && !draining) return@LaunchedEffect
        // Blocks register after composition; reading the revision here keeps that out of composition.
        snapshotFlow { cursor.revision }.collectLatest {
            withFrameMillis { now ->
                if (streaming) cursor.schedule.observe(cursor.total, now)
                else if (cursor.total != cursor.schedule.known) cursor.schedule.settle(cursor.total)
                cursor.frame = now
            }
            while (cursor.schedule.isAnimating(cursor.frame)) {
                withFrameMillis { now -> cursor.schedule.tick(now); cursor.frame = now }
            }
            if (!streaming) draining = false
        }
    }
    return cursor.takeIf { streaming || draining }
}

/** Grapheme ranges of [text], starting at the first boundary at or after [from]. */
internal fun graphemeRanges(text: String, from: Int): Sequence<Pair<Int, Int>> = sequence {
    if (from >= text.length) return@sequence
    val breaks = BreakIterator.getCharacterInstance(Locale.ROOT).apply { setText(text) }
    var offset = if (from <= 0) 0 else breaks.following(from - 1)
    while (offset != BreakIterator.DONE && offset < text.length) {
        val end = breaks.following(offset)
        if (end == BreakIterator.DONE) break
        yield(offset to end)
        offset = end
    }
}

/** Native Text keeps its layout, selection and links; the reveal changes paint only. */
@Composable
internal fun StreamingMarkdownText(
    text: AnnotatedString,
    modifier: Modifier,
    style: TextStyle,
    textAlign: TextAlign,
    registerWithCursor: Boolean = true,
) {
    val cursor = LocalRevealCursor.current
    val path = LocalRevealPath.current
    var layout by remember { mutableStateOf<TextLayoutResult?>(null) }
    val density = LocalDensity.current
    val foreground = if (style.color.isSpecified) style.color else LocalContentColor.current
    val nativePaint = remember { Paint(Paint.ANTI_ALIAS_FLAG or Paint.SUBPIXEL_TEXT_FLAG) }
    val filters = remember(density.density) {
        Array(8) { BlurMaskFilter(6 * density.density * (it + 1) / 8, BlurMaskFilter.Blur.NORMAL) }
    }
    if (cursor != null && registerWithCursor) {
        val length = text.length
        SideEffect { cursor.register(path, length) }
        DisposableEffect(cursor, path) { onDispose { cursor.unregister(path) } }
    }
    Text(text, modifier = modifier.drawWithContent {
        val result = layout
        if (cursor == null || result == null || result.layoutInput.text.text != text.text) {
            drawContent(); return@drawWithContent
        }
        val now = cursor.frame
        val schedule = cursor.schedule
        val base = cursor.base(path)
        if (schedule.settledBelow - base >= text.length) { drawContent(); return@drawWithContent }
        // Characters before the first hidden one are revealing; everything after it is hidden.
        val active = ArrayList<Triple<Int, Int, Float>>()
        var hiddenFrom = text.length
        for ((start, end) in graphemeRanges(text.text, schedule.settledBelow - base)) {
            val progress = schedule.progress(base + start, now)
            if (progress <= 0f) { hiddenFrom = start; break }
            if (progress < 1f) active += Triple(start, end, progress)
        }
        if (active.isEmpty() && hiddenFrom >= text.length) { drawContent(); return@drawWithContent }
        val cutouts = Path()
        active.forEach { (start, _, _) -> cutouts.addRect(result.getBoundingBox(start)) }
        if (hiddenFrom < text.length) cutouts.addPath(result.getPathForRange(hiddenFrom, text.length))
        clipPath(cutouts, ClipOp.Difference) { this@drawWithContent.drawContent() }
        drawIntoCanvas { canvas ->
            active.forEach { (start, end, progress) ->
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
