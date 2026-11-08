package com.orbising.orbis

import android.animation.ValueAnimator
import androidx.compose.animation.core.*
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp

/** Only the truly uncached home uses placeholders; every line has the real card's reserved space. */
@Composable
internal fun HomeSessionSkeleton() {
    val phase = if (ValueAnimator.areAnimatorsEnabled()) rememberInfiniteTransition(label = "skeleton").animateFloat(
        -1f, 2f, infiniteRepeatable(tween(InteractionMotion.Loop, easing = LinearEasing)), label = "skeleton-highlight")
        else rememberUpdatedState(0f)
    val highlight = rememberNeumorphColors().lightShadow
    Column(Modifier.fillMaxWidth().testTag("home-session-skeleton"), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        repeat(3) {
            Row(Modifier.fillMaxWidth().height(128.dp).padding(16.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                NeumorphSurface(Modifier.size(44.dp), RoundedCornerShape(16.dp), NeumorphStyle.Pressed, shadowScale = 0.4f) {}
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    listOf(0.85f, 0.65f, 0.45f).forEach { width ->
                        NeumorphSurface(Modifier.fillMaxWidth(width).height(16.dp), RoundedCornerShape(8.dp), NeumorphStyle.Pressed, shadowScale = 0.4f) {
                            Box(Modifier.fillMaxSize().drawBehind {
                                val x = size.width * phase.value
                                drawRect(Brush.linearGradient(listOf(Color.Transparent, highlight.copy(alpha = 0.55f), Color.Transparent),
                                    Offset(x-size.width/2, 0f), Offset(x+size.width/2, 0f)))
                            })
                        }
                    }
                }
            }
        }
    }
}
