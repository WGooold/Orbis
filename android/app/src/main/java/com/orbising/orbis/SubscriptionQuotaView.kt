package com.orbising.orbis

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import android.animation.ValueAnimator
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.Refresh
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.runtime.remember
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.nativeCanvas
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.withTransform
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.Job
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import java.text.DateFormat
import java.util.Date
import java.util.Locale
import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.sin

/** The agent mark is a two-sided coin; the rest of its card owns refresh. */
@Composable
internal fun SubscriptionQuotaCoin(
    kind: String,
    quota: SubscriptionQuota?,
    loading: Boolean,
    enabled: Boolean,
    tint: Color,
    refresh: () -> Unit,
) {
    var weekly by remember { mutableStateOf(false) }
    var demonstrated by remember { mutableStateOf(quota != null) }
    var flipJob by remember { mutableStateOf<Job?>(null) }
    val scope = rememberCoroutineScope()
    val angle = remember { Animatable(0f) }
    val fiveHourProgress = remember { Animatable(0f) }
    val weeklyProgress = remember { Animatable(0f) }
    val progress = if (weekly) weeklyProgress else fiveHourProgress
    val motionEnabled = ValueAnimator.areAnimatorsEnabled()
    val window = quota?.windows?.firstOrNull { it.name == if (weekly) "seven_day" else "five_hour" }
    val remaining = window?.remainingPercent
    val hasReadings = quota?.windows?.any { it.remainingPercent != null } == true
    val title = if (weekly) "周配额" else "5 小时配额"
    val percent = remaining?.let { String.format(Locale.getDefault(), "%.0f%%", it) } ?: "—"
    val color = if ((remaining ?: 100.0) <= 20.0) MaterialTheme.colorScheme.error else tint
    val secondary = MaterialTheme.colorScheme.onSurfaceVariant
    val rotation = quotaRotation(loading && motionEnabled)
    val interactions = remember { MutableInteractionSource() }
    val pressed by interactions.collectIsPressedAsState()
    suspend fun flip() {
        if (motionEnabled) angle.animateTo(90f, tween(QuotaCoinGeometry.OutgoingDuration, easing = LinearEasing))
        weekly = !weekly
        if (motionEnabled) {
            angle.animateTo(180f, tween(QuotaCoinGeometry.IncomingDuration, easing = LinearEasing))
            angle.snapTo(0f)
        }
    }
    LaunchedEffect(loading) {
        if (loading) { flipJob?.cancel(); angle.snapTo(0f) }
    }
    LaunchedEffect(motionEnabled) {
        if (!motionEnabled) { flipJob?.cancel(); angle.snapTo(0f) }
    }
    LaunchedEffect(quota?.checkedAt) {
        if (!demonstrated && !loading && quota?.windows?.count { it.remainingPercent != null } == 2) {
            demonstrated = true
            if (motionEnabled) flipJob = scope.launch {
                delay(800); flip(); delay(900); flip()
            }
        }
    }
    LaunchedEffect(quota?.windows, loading, motionEnabled) {
        if (!loading) {
            coroutineScope {
                for ((name, value) in listOf("five_hour" to fiveHourProgress, "seven_day" to weeklyProgress)) launch {
                    val target = ((quota?.windows?.firstOrNull { it.name == name }?.remainingPercent ?: 0.0) / 100).toFloat().coerceIn(0f, 1f)
                    if (motionEnabled) value.animateTo(target, tween(700, easing = FastOutSlowInEasing))
                    else value.snapTo(target)
                }
            }
        }
    }
    val reset = window?.resetsAt?.let { "，重置 " + DateFormat.getDateTimeInstance(DateFormat.SHORT, DateFormat.SHORT).format(Date(it)) }.orEmpty()
    Box(Modifier.size(width = 64.dp, height = 56.dp).testTag("quota-coin-$kind")
        .clickable(interactionSource = interactions, indication = null, enabled = enabled && !loading,
            role = Role.Button, onClickLabel = if (hasReadings) "翻面查看" + if (weekly) "5 小时配额" else "周配额" else "查询订阅配额") {
            if (!hasReadings) refresh() else {
                demonstrated = true
                flipJob?.cancel()
                flipJob = scope.launch { angle.snapTo(0f); flip() }
            }
        }.semantics(mergeDescendants = true) {
            contentDescription = "${agentBrand(kind).title} 配额"
            stateDescription = "$title，" + if (remaining != null) "剩余 $percent$reset" else if (loading) "查询中" else if (hasReadings) "暂不可用" else "待查询"
        }.graphicsLayer {
            alpha = if (!enabled) 0.4f else if (pressed) 0.6f else 1f
        }, contentAlignment = Alignment.CenterStart) {
        QuotaCoinTilt(angle.value, tint) {
            Canvas(Modifier.size(44.dp)) {
                val stroke = 2.5.dp.toPx()
                val inset = 2.dp.toPx()
                val bounds = Size(size.width - inset * 2, size.height - inset * 2)
                drawArc(secondary.copy(alpha = 0.16f), -45f, 315f, false, Offset(inset, inset), bounds,
                    style = Stroke(stroke, cap = StrokeCap.Round,
                        pathEffect = if (!hasReadings) PathEffect.dashPathEffect(floatArrayOf(1.dp.toPx(), 4.dp.toPx())) else null))
                if (loading) {
                    drawArc(Brush.sweepGradient(listOf(color.copy(alpha = 0.15f), color)), rotation - 90f, 80f,
                        false, Offset(inset, inset), bounds, style = Stroke(stroke, cap = StrokeCap.Round))
                } else if (progress.value > 0f) {
                    val sweep = progress.value * 315f
                    drawArc(Brush.linearGradient(listOf(color.copy(alpha = 0.4f), color)), -45f, sweep,
                        false, Offset(inset, inset), bounds, style = Stroke(stroke, cap = StrokeCap.Round))
                    val tip = Math.toRadians((-45f + sweep).toDouble())
                    val radius = bounds.width / 2
                    drawCircle(color, 1.8.dp.toPx(), Offset(center.x + cos(tip).toFloat() * radius, center.y + sin(tip).toFloat() * radius))
                }
            }
            AgentIcon(agentBrand(kind), Modifier.size(26.dp))
        }
        Text(if (weekly) "周" else "5h", modifier = Modifier.align(Alignment.TopEnd).graphicsLayer { alpha = 1 - 0.55f * abs(sin(Math.toRadians(QuotaCoinGeometry.angle(angle.value)))).toFloat() }.clearAndSetSemantics {},
            style = MaterialTheme.typography.labelSmall, fontWeight = FontWeight.Medium, color = secondary)
        Text(percent, modifier = Modifier.align(Alignment.BottomEnd).graphicsLayer { alpha = 1 - 0.55f * abs(sin(Math.toRadians(QuotaCoinGeometry.angle(angle.value)))).toFloat() }.clearAndSetSemantics {},
            style = MaterialTheme.typography.labelSmall.copy(fontFeatureSettings = "tnum"),
            fontWeight = FontWeight.Medium, color = if (remaining == null) secondary else color, maxLines = 1)
    }
}

/** Only the coin transforms; labels and its touch target retain their layout. */
@Composable
internal fun QuotaCoinTilt(angle: Float, tint: Color, content: @Composable () -> Unit) {
    val turn = QuotaCoinGeometry.angle(angle)
    val lift = abs(sin(Math.toRadians(turn))).toFloat()
    val colors = MaterialTheme.colorScheme
    val highlight = if (LocalOrbisDarkTheme.current) colors.onSurface else Color.White
    val face = listOf(colors.surfaceContainerHighest, colors.surface, colors.surfaceDim)
    val rim = listOf(highlight.copy(alpha = 0.9f), Color.Transparent, tint.copy(alpha = 0.25f))
    val bands = remember(turn) { if (lift > 0.0001f) QuotaCoinGeometry.bands(turn) else emptyList() }
    val projection = remember(turn) { QuotaCoinGeometry.faceProjection(turn) }
    Box(Modifier.size(44.dp), contentAlignment = Alignment.Center) {
        Canvas(Modifier.size(44.dp)) {
            val shadowY = center.y + 24.dp.toPx()
            withTransform({
                translate(center.x, shadowY)
                scale(1 - 0.65f * lift, 8f / 36, Offset.Zero)
            }) {
                drawCircle(Brush.radialGradient(listOf(colors.scrim.copy(alpha = 0.28f), Color.Transparent),
                    Offset.Zero, 18.dp.toPx()), radius = 18.dp.toPx(), center = Offset.Zero,
                    alpha = lift * (1 - 0.5f * lift))
            }
            bands.forEach { band ->
                val path = Path().apply {
                    band.points.forEachIndexed { index, point ->
                        val x = point.x.toFloat() * density; val y = point.y.toFloat() * density
                        if (index == 0) moveTo(x, y) else lineTo(x, y)
                    }
                    close()
                }
                val metal = listOf(0xF3D3C3, 0xC97A55, 0x8A4426).map { hex ->
                    Color((((hex shr 16) and 255) / 255f * band.brightness.toFloat()).coerceAtMost(1f),
                        (((hex shr 8) and 255) / 255f * band.brightness.toFloat()).coerceAtMost(1f),
                        ((hex and 255) / 255f * band.brightness.toFloat()).coerceAtMost(1f))
                }
                drawPath(path, Brush.linearGradient(metal, Offset.Zero, Offset(size.width, size.height)))
            }
        }
        Box(Modifier.size(44.dp).drawWithContent {
            // Skip the singular face: the closed cylindrical rim owns the exact side-on frame.
            if (QuotaCoinGeometry.faceVisible(turn)) {
                val matrix = android.graphics.Matrix().apply {
                    setValues(floatArrayOf(projection[0].toFloat(), projection[1].toFloat(), projection[2].toFloat() * density,
                        projection[3].toFloat(), projection[4].toFloat(), projection[5].toFloat() * density,
                        projection[6].toFloat() / density, projection[7].toFloat() / density, projection[8].toFloat()))
                }
                val canvas = drawContext.canvas.nativeCanvas
                val checkpoint = canvas.save()
                try {
                    canvas.concat(matrix)
                    drawContent()
                } finally { canvas.restoreToCount(checkpoint) }
            }
        }.drawBehind {
            drawCircle(Brush.radialGradient(face, Offset(size.width * 0.34f, size.height * 0.28f), 32.dp.toPx()))
        }.drawWithContent {
            drawContent()
            drawCircle(Brush.linearGradient(rim), radius = size.minDimension / 2 - 0.35.dp.toPx(), style = Stroke(0.7.dp.toPx()))
            if (lift > 0f) {
                val sweep = (turn / 180 * 2.8).toFloat()
                drawCircle(Brush.linearGradient(0.30f to Color.Transparent, 0.46f to highlight.copy(alpha = 0.55f),
                    0.60f to Color.Transparent, start = Offset(size.width * (-1.4f + sweep), 0f),
                    end = Offset(size.width * (-0.4f + sweep), size.height)), alpha = lift)
            }
        }, contentAlignment = Alignment.Center) { content() }
    }
}

/** Brief invitation on entry, continuous rotation only while a request is pending. */
@Composable
internal fun SubscriptionRefreshGlyph(loading: Boolean, pending: Boolean, tint: Color) {
    val invitation = remember { Animatable(0f) }
    LaunchedEffect(pending) {
        if (pending && ValueAnimator.areAnimatorsEnabled()) {
            invitation.animateTo(-35f, tween(260))
            invitation.animateTo(0f, tween(420, easing = FastOutSlowInEasing))
        }
    }
    val rotation = quotaRotation(loading && ValueAnimator.areAnimatorsEnabled())
    Box(Modifier.size(16.dp), contentAlignment = Alignment.Center) {
        Icon(Icons.Rounded.Refresh, contentDescription = null, tint = tint,
            modifier = Modifier.size(14.dp).graphicsLayer { rotationZ = if (loading) rotation else invitation.value })
    }
}

@Composable
private fun quotaRotation(loading: Boolean): Float {
    if (!loading) return 0f
    val transition = rememberInfiniteTransition(label = "quota-loading")
    val rotation by transition.animateFloat(0f, 360f,
        infiniteRepeatable(tween(1100, easing = LinearEasing), RepeatMode.Restart), label = "quota-rotation")
    return rotation
}
