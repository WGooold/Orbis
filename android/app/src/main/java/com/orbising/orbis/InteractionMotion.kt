package com.orbising.orbis

import android.animation.ValueAnimator
import androidx.compose.animation.togetherWith
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.CubicBezierEasing
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.waitForUpOrCancellation
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.ui.platform.testTag
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.material3.Icon
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.Modifier
import androidx.compose.ui.zIndex
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.painter.Painter
import androidx.compose.material3.LocalContentColor
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.text
import androidx.compose.ui.semantics.getTextLayoutResult
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import kotlin.math.cos
import kotlin.math.sin
import kotlin.math.hypot
import kotlin.math.max

/** ADR-0058. Durations and geometry are semantic shared contracts, never per-screen constants. */
internal object InteractionMotion {
    const val CopyFeedback = 2_500L
    const val CopyTransition = 220
    const val ReplyGrowth = 180
    const val ReplyArrival = 220
    val ReplyEase = CubicBezierEasing(0.2f, 0f, 0f, 1f)
    const val GlyphPress = 80
    const val GlyphRelease = 160
    const val GlyphPressedScale = 0.94f
    const val GlyphPressedOpacity = 0.82f
    val GlyphEase = CubicBezierEasing(0.2f, 0f, 0f, 1f)
    const val EdgeShrink = 0.08f
    fun edgeShift(width: Float, progress: Float, direction: Float, gap: Float): Float {
        val p = progress.coerceIn(0f, 1f)
        return direction * minOf(24f, (width * EdgeShrink / 2f - gap).coerceAtLeast(0f)) * p
    }
    const val State = 160
    const val Selection = 260
    const val Panel = 220
    const val Exit = 160
    const val Dismiss = 180
    const val SendTravel = 280
    const val SendExpand = 160
    const val Send = SendTravel + SendExpand
    const val SendArrival = SendTravel / 440f
    // Linear clock, one cubic ease-out per spatial stage: fast departure and a steady stop.
    fun sendEaseOut(progress: Float): Float {
        val remaining = 1 - progress.coerceIn(0f, 1f)
        return 1 - remaining * remaining * remaining
    }
    fun sendFrame(source: Rect, target: Rect, progress: Float, density: Float = 1f): Rect {
        val p = progress.coerceIn(0f, 1f)
        val compact = Size(minOf(source.width, target.width) * 0.86f,
            minOf(72f * density, source.height, target.height * 0.86f))
        val landing = Rect(target.bottomRight - Offset(compact.width, compact.height), compact)
        if (p < SendArrival) {
            val travel = p / SendArrival
            val center = sendPoint(source.center, landing.center, travel, 24f * density)
            val narrow = sendEaseOut(travel / 0.25f)
            val size = Size(source.width + (compact.width - source.width) * narrow,
                source.height + (compact.height - source.height) * narrow)
            return Rect(center - Offset(size.width / 2, size.height / 2), size)
        }
        val t = (p - SendArrival) / (1 - SendArrival)
        val eased = sendEaseOut(t)
        val size = Size(compact.width + (target.width - compact.width) * eased,
            compact.height + (target.height - compact.height) * eased)
        return Rect(target.bottomRight - Offset(size.width, size.height), size)
    }
    fun duration(value: Int) = if (ValueAnimator.areAnimatorsEnabled()) value else 0
    fun touchOrigin(point: Offset?, size: Size) = Offset(
        (point?.x ?: size.width / 2).coerceIn(0f, size.width),
        (point?.y ?: size.height / 2).coerceIn(0f, size.height),
    )
    fun revealRadius(origin: Offset, size: Size) = hypot(max(origin.x, size.width - origin.x), max(origin.y, size.height - origin.y))
    fun sendPoint(from: Offset, to: Offset, progress: Float, minimumRight: Float = 24f): Offset {
        val p = progress.coerceIn(0f, 1f)
        val bend = Offset(max(from.x + minimumRight, to.x), from.y)
        return if (p < 0.25f) from + (bend - from) * sendEaseOut(p / 0.25f)
        else bend + (to - bend) * sendEaseOut((p - 0.25f) / 0.75f)
    }
}

/** Physical release/cancel wins over decorative activation; no minimum press hold. */
internal class GlyphFeedbackState {
    enum class Response { Press, Release, Activate, Reset }
    private var lastActivation: Int? = null
    private var physicalCycle = false
    fun update(pressed: Boolean, activation: Int, enabled: Boolean): Response {
        val activated = lastActivation?.let { it != activation } ?: false
        lastActivation = activation
        if (!enabled) { physicalCycle = false; return Response.Reset }
        if (pressed) { physicalCycle = true; return Response.Press }
        if (physicalCycle) return Response.Release
        return if (activated) Response.Activate else Response.Reset
    }
    fun released() { physicalCycle = false }
}

/** Observe initial down without consuming slop, scrolling, long presses or child links. */
internal fun Modifier.orbisTouchOrigin(enabled: Boolean = true, onTouch: (Offset) -> Unit): Modifier =
    if (!enabled) this else pointerInput(Unit) {
        awaitEachGesture {
            val down = awaitFirstDown(requireUnconsumed = false, pass = PointerEventPass.Initial)
            onTouch(down.position)
            waitForUpOrCancellation(pass = PointerEventPass.Final)
        }
    }

@Composable
internal fun OrbisMotionIcon(
    icon: ImageVector,
    description: String?,
    tint: Color,
    size: Dp,
    activation: Int,
    modifier: Modifier = Modifier,
    menuMorph: Boolean? = null,
    backMorph: Boolean? = null,
    pressed: Boolean = LocalGlyphPressed.current,
    enabled: Boolean = LocalGlyphEnabled.current,
    copyFeedback: Boolean? = null,
) {
    val name = icon.name.substringAfterLast('.')
    val progress = rememberGlyphProgress(pressed, activation, enabled)
    val glyph = modifier.glyphPressure(progress)
    val semantics = if (description != null) Modifier.semantics { contentDescription = description } else Modifier
    if (copyFeedback != null) {
        CopyFeedbackIcon(copyFeedback, tint, size, glyph.then(semantics))
    } else if (backMorph != null) {
        val p by animateFloatAsState(if (backMorph) 1f else 0f,
            tween(InteractionMotion.duration(InteractionMotion.Selection)), label = "back-close")
        Canvas(glyph.size(size).then(semantics)) {
            val h = this.size.width * 0.34f
            fun point(a: Offset, b: Offset) = center + a + (b-a) * p
            drawLine(tint, point(Offset(-h, 0f), Offset(-h, h)), point(Offset(0f, -h), Offset(h, -h)), 2.dp.toPx(), StrokeCap.Round)
            if (p < 0.99f) drawLine(tint, center + Offset(-h * (1-p), 0f), center + Offset(h * (1-p), 0f), 2.dp.toPx(), StrokeCap.Round)
            drawLine(tint, point(Offset(-h, 0f), Offset(-h, -h)), point(Offset(0f, h), Offset(h, h)), 2.dp.toPx(), StrokeCap.Round)
        }
    } else if (menuMorph != null) {
        val p by animateFloatAsState(if (menuMorph) 1f else 0f,
            tween(InteractionMotion.duration(InteractionMotion.Selection)), label = "menu-close")
        Canvas(glyph.size(size).then(semantics)) {
            val half = this.size.width * 0.36f
            val angle = p * Math.PI.toFloat() / 4
            val dx = cos(angle) * half; val dy = sin(angle) * half
            val gap = this.size.height * 0.26f * (1 - p)
            drawLine(tint, center + Offset(-dx, -gap - dy), center + Offset(dx, -gap + dy), 2.dp.toPx(), StrokeCap.Round)
            if (p < 0.99f) drawLine(tint, center + Offset(-half * (1-p), 0f), center + Offset(half * (1-p), 0f), 2.dp.toPx(), StrokeCap.Round)
            drawLine(tint, center + Offset(-dx, gap + dy), center + Offset(dx, gap - dy), 2.dp.toPx(), StrokeCap.Round)
        }
    } else if (name == "Download") {
        Canvas(glyph.size(size).then(semantics)) {
            val w = this.size.width; val h = this.size.height; val dy = 0f; val stroke = 2.dp.toPx()
            drawLine(tint, Offset(w * 0.18f, h * 0.85f), Offset(w * 0.82f, h * 0.85f), stroke, StrokeCap.Round)
            drawLine(tint, Offset(w / 2, h * 0.12f + dy), Offset(w / 2, h * 0.65f + dy), stroke, StrokeCap.Round)
            drawLine(tint, Offset(w * 0.28f, h * 0.45f + dy), Offset(w / 2, h * 0.67f + dy), stroke, StrokeCap.Round)
            drawLine(tint, Offset(w / 2, h * 0.67f + dy), Offset(w * 0.72f, h * 0.45f + dy), stroke, StrokeCap.Round)
        }
    } else Icon(icon, description, tint = tint, modifier = glyph.size(size))
}

internal val LocalMotionActionsEnabled = staticCompositionLocalOf { true }
internal val LocalGlyphActivation = staticCompositionLocalOf { 0 }
internal val LocalGlyphPressed = staticCompositionLocalOf { false }
internal val LocalGlyphEnabled = staticCompositionLocalOf { true }

/** For icon-bearing rows: the parent action owns activation; static glyphs receive zero. */
@Composable
internal fun OrbisActionIcon(imageVector: ImageVector, contentDescription: String?, modifier: Modifier = Modifier,
    tint: Color = LocalContentColor.current) {
    if (imageVector.name.substringAfterLast('.') == "Download") {
        OrbisMotionIcon(imageVector, contentDescription, tint, 24.dp, LocalGlyphActivation.current, modifier)
    } else Icon(imageVector, contentDescription, modifier.actionGlyphMotion(LocalGlyphActivation.current), tint)
}

@Composable
internal fun OrbisActionIcon(painter: Painter, contentDescription: String?, modifier: Modifier = Modifier,
    tint: Color = LocalContentColor.current) {
    Icon(painter, contentDescription, modifier.actionGlyphMotion(LocalGlyphActivation.current), tint)
}

@Composable
internal fun Modifier.actionGlyphMotion(activation: Int): Modifier {
    val progress = rememberGlyphProgress(LocalGlyphPressed.current, activation, LocalGlyphEnabled.current)
    return glyphPressure(progress)
}

private fun Modifier.glyphPressure(progress: Float): Modifier = graphicsLayer {
    scaleX = if (ValueAnimator.areAnimatorsEnabled()) 1 - (1 - InteractionMotion.GlyphPressedScale) * progress else 1f
    scaleY = scaleX
    alpha = 1 - (1 - InteractionMotion.GlyphPressedOpacity) * progress
}

/** One stable slot for normal/batch actions. Progress is shared by each icon's merge offset. */
@Composable
internal fun SelectionToolbar(
    selecting: Boolean,
    normal: @Composable RowScope.(Float) -> Unit,
    selected: @Composable RowScope.() -> Unit,
) {
    val progress by animateFloatAsState(if (selecting) 1f else 0f,
        tween(InteractionMotion.duration(InteractionMotion.Selection)), label = "selection-toolbar")
    Box(contentAlignment = Alignment.Center) {
        CompositionLocalProvider(LocalMotionActionsEnabled provides !selecting) {
            Row(Modifier.zIndex(if (selecting) 0f else 1f).graphicsLayer { alpha = (1 - progress / 0.62f).coerceIn(0f, 1f) }
                .then(if (selecting) Modifier.clearAndSetSemantics { } else Modifier),
                verticalAlignment = Alignment.CenterVertically) { normal(progress) }
        }
        CompositionLocalProvider(LocalMotionActionsEnabled provides selecting) {
            Row(Modifier.zIndex(if (selecting) 1f else 0f).graphicsLayer { alpha = ((progress - 0.62f) / 0.38f).coerceIn(0f, 1f) }
                .then(if (!selecting) Modifier.clearAndSetSemantics { } else Modifier),
                verticalAlignment = Alignment.CenterVertically, content = selected)
        }
    }
}


/** One animation owner: release/cancel immediately reverses, re-press takes over. */
@Composable
private fun rememberGlyphProgress(pressed: Boolean, activation: Int, enabled: Boolean): Float {
    val progress = remember { Animatable(0f) }
    val feedback = remember { GlyphFeedbackState() }
    val reduced = !ValueAnimator.areAnimatorsEnabled()
    LaunchedEffect(pressed, activation, reduced, enabled) {
        val response = feedback.update(pressed, activation, enabled)
        if (reduced || !enabled) {
            progress.snapTo(if (enabled && pressed) 1f else 0f)
            if (!pressed) feedback.released()
            return@LaunchedEffect
        }
        when (response) {
            GlyphFeedbackState.Response.Press -> progress.animateTo(1f,
                tween(InteractionMotion.GlyphPress, easing = InteractionMotion.GlyphEase))
            GlyphFeedbackState.Response.Release -> {
                progress.animateTo(0f, tween(InteractionMotion.GlyphRelease, easing = InteractionMotion.GlyphEase))
                feedback.released()
            }
            GlyphFeedbackState.Response.Activate -> {
                progress.animateTo(1f, tween(InteractionMotion.GlyphPress, easing = InteractionMotion.GlyphEase))
                progress.animateTo(0f, tween(InteractionMotion.GlyphRelease, easing = InteractionMotion.GlyphEase))
            }
            GlyphFeedbackState.Response.Reset -> progress.snapTo(0f)
        }
    }
    return progress.value
}

/** Short discrete labels fade inside their own slot; semantics belongs only to the live value. */
@Composable
internal fun MotionText(
    text: String,
    modifier: Modifier = Modifier,
    color: Color = Color.Unspecified,
    style: androidx.compose.ui.text.TextStyle = androidx.compose.material3.LocalTextStyle.current,
    fontWeight: androidx.compose.ui.text.font.FontWeight? = null,
    maxLines: Int = Int.MAX_VALUE,
    overflow: androidx.compose.ui.text.style.TextOverflow = androidx.compose.ui.text.style.TextOverflow.Clip,
) {
    val layoutResult = remember(text) { mutableStateOf<androidx.compose.ui.text.TextLayoutResult?>(null) }
    val appearance = remember { Animatable(0f) }
    LaunchedEffect(Unit) { appearance.animateTo(1f, tween(InteractionMotion.duration(InteractionMotion.State))) }
    androidx.compose.animation.AnimatedContent(targetState = text,
        modifier = modifier.graphicsLayer { alpha = appearance.value }.semantics {
            this.text = androidx.compose.ui.text.AnnotatedString(text)
            getTextLayoutResult { results -> layoutResult.value?.let { results.add(it); true } ?: false }
        },
        transitionSpec = {
            (androidx.compose.animation.fadeIn(tween(InteractionMotion.duration(InteractionMotion.State))) togetherWith
                androidx.compose.animation.fadeOut(tween(InteractionMotion.duration(InteractionMotion.State))))
                .using(null)
        }, label = "discrete-label") { displayed ->
        androidx.compose.material3.Text(displayed, Modifier.clearAndSetSemantics { }, color = color,
            style = style, fontWeight = fontWeight, maxLines = maxLines, overflow = overflow,
            onTextLayout = { if (displayed == text) layoutResult.value = it })
    }
}


@Composable
internal fun NewSessionMotionCard(launch: LaunchState, onPresented: () -> Unit) {
    val progress = remember(launch.requestId) { Animatable(0f) }
    val finish by androidx.compose.runtime.rememberUpdatedState(onPresented)
    LaunchedEffect(launch.requestId) {
        progress.animateTo(1f, tween(InteractionMotion.duration(InteractionMotion.Panel)))
        finish()
    }
    NeumorphSurface(Modifier.fillMaxWidth().graphicsLayer { translationY = 32.dp.toPx() * (1 - progress.value); alpha = progress.value }
        .testTag("new-session-card"), contentPadding = 20.dp) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = androidx.compose.foundation.layout.Arrangement.spacedBy(14.dp)) {
            AgentIcon(agentBrand(launch.agentKind), Modifier.size(44.dp))
            androidx.compose.foundation.layout.Column {
                MotionText(launch.title, style = androidx.compose.material3.MaterialTheme.typography.titleMedium, maxLines = 2)
                MotionText(L10n.tr("启动中"), color = androidx.compose.material3.MaterialTheme.colorScheme.primary)
            }
        }
    }
}

/** Shared insertion/removal and placement timing for stable-key directory collections. */
internal fun androidx.compose.foundation.lazy.LazyItemScope.collectionMotion(): Modifier = Modifier.animateItem(
    fadeInSpec = tween(InteractionMotion.duration(InteractionMotion.State)),
    placementSpec = tween(InteractionMotion.duration(InteractionMotion.Panel)),
    fadeOutSpec = tween(InteractionMotion.duration(InteractionMotion.State)),
)
