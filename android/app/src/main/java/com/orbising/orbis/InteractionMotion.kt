package com.orbising.orbis

import android.animation.ValueAnimator
import androidx.compose.animation.togetherWith
import androidx.compose.animation.core.Animatable
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
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import kotlinx.coroutines.delay
import android.os.SystemClock
import androidx.compose.runtime.remember
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.Modifier
import androidx.compose.ui.zIndex
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
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
    fun rotates(role: String) = role in setOf("Settings", "History", "HistoryEdu", "Refresh", "AccountTree")
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
    const val Send = 280
    fun duration(value: Int) = if (ValueAnimator.areAnimatorsEnabled()) value else 0
    fun touchOrigin(point: Offset?, size: Size) = Offset(
        (point?.x ?: size.width / 2).coerceIn(0f, size.width),
        (point?.y ?: size.height / 2).coerceIn(0f, size.height),
    )
    fun revealRadius(origin: Offset, size: Size) = hypot(max(origin.x, size.width - origin.x), max(origin.y, size.height - origin.y))
    fun sendPoint(from: Offset, to: Offset, progress: Float, minimumRight: Float = 24f): Offset {
        val p = progress.coerceIn(0f, 1f)
        val bend = Offset(max(from.x + minimumRight, to.x), from.y)
        return if (p < 0.25f) from + (bend - from) * (p / 0.25f)
        else bend + (to - bend) * ((p - 0.25f) / 0.75f)
    }
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
) {
    val name = icon.name.substringAfterLast('.')
    val rotates = InteractionMotion.rotates(name)
    val progress = rememberGlyphProgress(pressed, activation, rotates)
    val semantics = if (description != null) Modifier.semantics { contentDescription = description } else Modifier
    if (backMorph != null) {
        val p by animateFloatAsState(if (backMorph) 1f else 0f,
            tween(InteractionMotion.duration(InteractionMotion.Selection)), label = "back-close")
        Canvas(modifier.size(size).then(semantics)) {
            val h = this.size.width * 0.34f
            fun point(a: Offset, b: Offset) = center + a + (b-a) * p
            drawLine(tint, point(Offset(-h, 0f), Offset(-h, h)), point(Offset(0f, -h), Offset(h, -h)), 2.dp.toPx(), StrokeCap.Round)
            if (p < 0.99f) drawLine(tint, center + Offset(-h * (1-p), 0f), center + Offset(h * (1-p), 0f), 2.dp.toPx(), StrokeCap.Round)
            drawLine(tint, point(Offset(-h, 0f), Offset(-h, -h)), point(Offset(0f, h), Offset(h, h)), 2.dp.toPx(), StrokeCap.Round)
        }
    } else if (menuMorph != null) {
        val p by animateFloatAsState(if (menuMorph) 1f else 0f,
            tween(InteractionMotion.duration(InteractionMotion.Selection)), label = "menu-close")
        Canvas(modifier.size(size).then(semantics)) {
            val half = this.size.width * 0.36f
            val angle = p * Math.PI.toFloat() / 4
            val dx = cos(angle) * half; val dy = sin(angle) * half
            val gap = this.size.height * 0.26f * (1 - p)
            drawLine(tint, center + Offset(-dx, -gap - dy), center + Offset(dx, -gap + dy), 2.dp.toPx(), StrokeCap.Round)
            if (p < 0.99f) drawLine(tint, center + Offset(-half * (1-p), 0f), center + Offset(half * (1-p), 0f), 2.dp.toPx(), StrokeCap.Round)
            drawLine(tint, center + Offset(-dx, gap + dy), center + Offset(dx, gap - dy), 2.dp.toPx(), StrokeCap.Round)
        }
    } else if (name == "Download") {
        Canvas(modifier.size(size).then(semantics)) {
            val w = this.size.width; val h = this.size.height; val dy = progress * 4.dp.toPx(); val stroke = 2.dp.toPx()
            drawLine(tint, Offset(w * 0.18f, h * 0.85f), Offset(w * 0.82f, h * 0.85f), stroke, StrokeCap.Round)
            drawLine(tint, Offset(w / 2, h * 0.12f + dy), Offset(w / 2, h * 0.65f + dy), stroke, StrokeCap.Round)
            drawLine(tint, Offset(w * 0.28f, h * 0.45f + dy), Offset(w / 2, h * 0.67f + dy), stroke, StrokeCap.Round)
            drawLine(tint, Offset(w / 2, h * 0.67f + dy), Offset(w * 0.72f, h * 0.45f + dy), stroke, StrokeCap.Round)
        }
    } else Icon(icon, description, tint = tint, modifier = modifier.size(size).graphicsLayer {
        rotationZ = if (rotates) progress * 360 else 0f
        scaleX = if (rotates) 1f else 1 - 0.12f * progress; scaleY = scaleX
    })
}

internal val LocalMotionActionsEnabled = staticCompositionLocalOf { true }
internal val LocalGlyphActivation = staticCompositionLocalOf { 0 }
internal val LocalGlyphPressed = staticCompositionLocalOf { false }

/** For icon-bearing rows: the parent action owns activation; static glyphs receive zero. */
@Composable
internal fun OrbisActionIcon(imageVector: ImageVector, contentDescription: String?, modifier: Modifier = Modifier,
    tint: Color = LocalContentColor.current) {
    if (imageVector.name.substringAfterLast('.') == "Download") {
        OrbisMotionIcon(imageVector, contentDescription, tint, 24.dp, LocalGlyphActivation.current, modifier)
    } else Icon(imageVector, contentDescription, modifier.actionGlyphMotion(LocalGlyphActivation.current, imageVector.name.substringAfterLast('.')), tint)
}

@Composable
internal fun OrbisActionIcon(painter: Painter, contentDescription: String?, modifier: Modifier = Modifier,
    tint: Color = LocalContentColor.current) {
    Icon(painter, contentDescription, modifier.actionGlyphMotion(LocalGlyphActivation.current), tint)
}

@Composable
internal fun Modifier.actionGlyphMotion(activation: Int, role: String = "generic"): Modifier {
    val rotates = InteractionMotion.rotates(role)
    val progress = rememberGlyphProgress(LocalGlyphPressed.current, activation, rotates)
    return graphicsLayer { rotationZ = if (rotates) progress * 360 else 0f; scaleX = if (rotates) 1f else 1 - 0.12f * progress; scaleY = scaleX }
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


/** Action dispatch is independent of this visual minimum. Re-press cancels the old return. */
@Composable
private fun rememberGlyphProgress(pressed: Boolean, activation: Int, rotates: Boolean): Float {
    val progress = remember { Animatable(0f) }
    var downAt by remember { mutableLongStateOf(0L) }
    var pointerActivation by remember { mutableStateOf(false) }
    val haptic = LocalHapticFeedback.current
    val reduced = !ValueAnimator.areAnimatorsEnabled()
    LaunchedEffect(pressed, reduced) {
        if (pressed) {
            downAt = SystemClock.uptimeMillis(); pointerActivation = true
            if (rotates) haptic.performHapticFeedback(HapticFeedbackType.TextHandleMove)
            progress.animateTo(if (reduced) 0f else 1f, tween(InteractionMotion.duration(if (rotates) 260 else 90)))
        } else if (downAt != 0L) {
            if (!reduced) {
                // Finish the peak after a quick release; do not jump straight to a smaller target.
                val left = ((if (rotates) 260L else 90L) - (SystemClock.uptimeMillis() - downAt)).coerceAtLeast(0)
                if (left > 0) progress.animateTo(1f, tween(left.toInt()))
            }
            progress.animateTo(0f, tween(InteractionMotion.duration(if (rotates) 260 else 130)))
            downAt = 0L; pointerActivation = false
        }
    }
    LaunchedEffect(activation) {
        if (activation == 0) return@LaunchedEffect
        if (pointerActivation) { pointerActivation = false; return@LaunchedEffect }
        if (!reduced) {
            progress.animateTo(1f, tween(if (rotates) 260 else 90))
            progress.animateTo(0f, tween(if (rotates) 260 else 130))
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
                MotionText("启动中", color = androidx.compose.material3.MaterialTheme.colorScheme.primary)
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
