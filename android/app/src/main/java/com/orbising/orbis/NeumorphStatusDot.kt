package com.orbising.orbis

import android.animation.ValueAnimator
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.unit.dp

/** Solid state ink; work adds an orbiting arc without changing the reserved 10dp slot. */
@Composable
internal fun NeumorphStatusDot(tint: Color, pulsing: Boolean, modifier: Modifier = Modifier,
    motionEnabled: Boolean = ValueAnimator.areAnimatorsEnabled(), idle: Boolean = false) {
    val phase = if (pulsing && motionEnabled) rememberInfiniteTransition(label = "status-work").animateFloat(
        0f, 360f, infiniteRepeatable(tween(InteractionMotion.Loop, easing = LinearEasing)), label = "status-orbit",
    ) else rememberUpdatedState(0f)
    Canvas(modifier.size(10.dp)) {
        if (idle) drawCircle(tint, radius = 3.dp.toPx(), style = Stroke(1.5.dp.toPx()))
        else drawCircle(tint, radius = (if (pulsing) 3 else 4).dp.toPx())
        if (pulsing) {
            val stroke = 1.5.dp.toPx()
            val inset = stroke / 2
            // Short trailing segments fade into the material; the dot itself never pulses.
            repeat(12) { index ->
                drawArc(tint.copy(alpha = (index + 1) / 12f), phase.value - 90 + index * 12f, 13f,
                    false, Offset(inset, inset), Size(size.width - stroke, size.height - stroke),
                    style = Stroke(stroke, cap = StrokeCap.Round))
            }
        }
    }
}
