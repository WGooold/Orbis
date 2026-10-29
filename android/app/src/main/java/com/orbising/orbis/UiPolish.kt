package com.orbising.orbis

import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.foundation.layout.Row
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.text
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.draw.drawWithCache
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.ui.layout.Layout
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.foundation.layout.offset
import kotlin.math.sqrt

internal object OrbisMotion {
    // Compose expresses damping as a ratio: c / (2 * sqrt(k * mass)).
    fun drag() = spring<Float>(stiffness = 1200f, dampingRatio = 80f / (2f * sqrt(1200f)))
    fun swipeBack() = spring<Float>(stiffness = 260f, dampingRatio = 24f / (2f * sqrt(260f)))
    fun pop() = spring<Float>(stiffness = 380f, dampingRatio = 18f / (2f * sqrt(380f)))
}

/** Measure the full content once, then animate only the clipping viewport (0fr → 1fr). */
@Composable
internal fun OrbisCollapse(expanded: Boolean, content: @Composable () -> Unit) {
    val fraction by animateFloatAsState(if (expanded) 1f else 0f, tween(260), label = "collapse")
    Layout(content = content, modifier = Modifier.clipToBounds().then(if (!expanded) Modifier.clearAndSetSemantics {} else Modifier)) { measurables, constraints ->
        val children = measurables.map { it.measure(constraints.copy(minHeight = 0)) }
        val width = children.maxOfOrNull { it.width } ?: constraints.minWidth
        val fullHeight = children.maxOfOrNull { it.height } ?: 0
        layout(width, (fullHeight * fraction).toInt()) { children.forEach { it.placeRelative(0, 0) } }
    }
}

/** Keep the extension as a separate, untruncated run; only the basename may ellipsize. */
@Composable
internal fun FileNameText(
    name: String,
    modifier: Modifier = Modifier,
    style: TextStyle = MaterialTheme.typography.bodyMedium,
    fontWeight: FontWeight? = null,
) {
    val (base, extension) = fileNameParts(name)
    Row(modifier.clearAndSetSemantics { text = AnnotatedString(name) }) {
        Text(base, Modifier.weight(1f, fill = false), style = style, fontWeight = fontWeight,
            maxLines = 1, overflow = TextOverflow.Ellipsis)
        if (extension.isNotEmpty()) Text(extension, Modifier, style = style,
            fontWeight = fontWeight, maxLines = 1, softWrap = false)
    }
}

internal fun fileNameParts(name: String): Pair<String, String> {
    val dot = name.lastIndexOf('.')
    return if (dot > 0 && dot < name.lastIndex) name.substring(0, dot) to name.substring(dot)
        else name to ""
}

/** Pixel distances, not row counts: one assistant row can span hundreds of lines. */
internal fun chatBottomDistance(lastIndex: Int, itemCount: Int, bottom: Int, viewportEnd: Int, padding: Int): Float =
    if (itemCount == 0) 0f else if (lastIndex == itemCount - 1) (bottom + padding - viewportEnd).coerceAtLeast(0).toFloat()
    else Float.POSITIVE_INFINITY

/** Two softly feathered accent rings; focus never changes field bounds or draws a dark outline. */
@Composable
internal fun Modifier.orbisFieldFocus(focused: Boolean, shape: Shape): Modifier {
    val intensity by animateFloatAsState(if (focused) 1f else 0f, tween(160), label = "field-focus")
    val color = MaterialTheme.colorScheme.primary
    return drawWithCache {
        val radius = (shape as? RoundedCornerShape)?.topStart?.toPx(size, this) ?: 16.dp.toPx()
        onDrawBehind {
            if (intensity > 0f) {
                for (step in 6 downTo 0) {
                    val spread = step * 0.65.dp.toPx()
                    drawRoundRect(color.copy(alpha = (0.028f + (6 - step) * 0.004f) * intensity),
                        Offset(-spread, -spread), Size(size.width + spread * 2, size.height + spread * 2),
                        CornerRadius(radius + spread), style = Stroke(1.5.dp.toPx()))
                }
                drawRoundRect(color.copy(alpha = 0.14f * intensity),
                    cornerRadius = CornerRadius(radius), style = Stroke(1.dp.toPx()))
            }
        }
    }
}

/** Optical correction for icons beside text; isolated icon buttons remain centered. */
@Composable
internal fun Modifier.orbisIconBaseline(size: TextUnit): Modifier =
    offset(y = with(LocalDensity.current) { size.toDp() * 0.125f })
