package com.orbising.orbis

import android.animation.ValueAnimator
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import kotlin.math.PI
import kotlin.math.cos

/** SC53: a matte raised mark; its face color and shadows stay fixed while its highlight breathes. */
@Composable
internal fun NeumorphStatusDot(
    tint: Color,
    pulsing: Boolean,
    modifier: Modifier = Modifier,
    motionEnabled: Boolean = ValueAnimator.areAnimatorsEnabled(),
) {
    val colors = rememberNeumorphColors()
    val phase = if (pulsing && motionEnabled) {
        rememberInfiniteTransition(label = "status-dot").animateFloat(
            initialValue = 0f, targetValue = 1f,
            animationSpec = infiniteRepeatable(tween(1_500, easing = LinearEasing)),
            label = "status-dot-tint",
        )
    } else rememberUpdatedState(0f)
    // A small physical indicator retains its own relief inside the recessed capsule.
    CompositionLocalProvider(LocalOrbisSurface provides null) {
        Box(modifier.size(10.dp).neumorphRaised(CircleShape, shadowScale = 0.55f).drawBehind {
            val light = ((cos(phase.value * 2 * PI) + 1) / 2).toFloat()
            drawCircle(tint)
            drawCircle(
                brush = Brush.radialGradient(
                    colors = listOf(colors.lightShadow.copy(alpha = 0.03f + 0.88f * light), Color.Transparent),
                    center = Offset(size.width * 0.28f, size.height * 0.28f),
                    radius = size.minDimension * 1.2f,
                ),
            )
        })
    }
}
