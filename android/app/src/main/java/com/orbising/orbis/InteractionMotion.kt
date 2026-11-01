package com.orbising.orbis

import android.animation.ValueAnimator
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.waitForUpOrCancellation
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.material3.Icon
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
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
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import kotlin.math.cos
import kotlin.math.sin
import kotlin.math.hypot
import kotlin.math.max

/** ADR-0058. Durations and geometry are semantic shared contracts, never per-screen constants. */
internal object InteractionMotion {
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
) {
    val pulse = remember { Animatable(0f) }
    val rotation = remember { Animatable(0f) }
    val name = icon.name.substringAfterLast('.')
    val rotates = name in setOf("Settings", "History", "Refresh", "AccountTree")
    LaunchedEffect(activation) {
        if (activation == 0 || !ValueAnimator.areAnimatorsEnabled()) return@LaunchedEffect
        if (rotates) rotation.animateTo(rotation.value + 90f, tween(InteractionMotion.Selection))
        else {
            pulse.animateTo(1f, tween(90))
            pulse.animateTo(0f, if (name == "Download") OrbisMotion.pop() else tween(130))
        }
    }
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
            val w = this.size.width; val h = this.size.height; val dy = pulse.value * 4.dp.toPx(); val stroke = 2.dp.toPx()
            drawLine(tint, Offset(w * 0.18f, h * 0.85f), Offset(w * 0.82f, h * 0.85f), stroke, StrokeCap.Round)
            drawLine(tint, Offset(w / 2, h * 0.12f + dy), Offset(w / 2, h * 0.65f + dy), stroke, StrokeCap.Round)
            drawLine(tint, Offset(w * 0.28f, h * 0.45f + dy), Offset(w / 2, h * 0.67f + dy), stroke, StrokeCap.Round)
            drawLine(tint, Offset(w / 2, h * 0.67f + dy), Offset(w * 0.72f, h * 0.45f + dy), stroke, StrokeCap.Round)
        }
    } else Icon(icon, description, tint = tint, modifier = modifier.size(size).graphicsLayer {
        rotationZ = rotation.value
        scaleX = 1 - 0.12f * pulse.value; scaleY = scaleX
    })
}

internal val LocalMotionActionsEnabled = staticCompositionLocalOf { true }
internal val LocalGlyphActivation = staticCompositionLocalOf { 0 }

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
    val pulse = remember { Animatable(0f) }
    val rotation = remember { Animatable(0f) }
    val reduced = !ValueAnimator.areAnimatorsEnabled()
    val rotates = role in setOf("Settings", "History", "HistoryEdu", "Refresh", "AccountTree")
    LaunchedEffect(activation, reduced) {
        if (reduced) { pulse.snapTo(0f); rotation.snapTo(0f) }
        else if (activation > 0) {
            if (rotates) rotation.animateTo(rotation.value + 90f, tween(InteractionMotion.Selection))
            else { pulse.animateTo(1f, tween(90)); pulse.animateTo(0f, tween(130)) }
        }
    }
    return graphicsLayer { rotationZ = rotation.value; scaleX = 1 - 0.12f * pulse.value; scaleY = scaleX }
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
