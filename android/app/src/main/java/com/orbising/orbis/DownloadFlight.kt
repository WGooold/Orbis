package com.orbising.orbis

import android.animation.ValueAnimator
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.Description
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Stable
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.geometry.center
import androidx.compose.ui.graphics.ColorFilter
import androidx.compose.ui.graphics.drawscope.translate
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.vector.rememberVectorPainter
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.LayoutCoordinates
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.toSize
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch

/**
 * Download feedback (ADR-0051 M16, ADR-0053 §7). Once a download is actually queued, a file icon
 * flies from the tap along an upward arc to the page's download button, which then gives a small
 * pop. Flights are drawn on their own layer: they never take touches, change layout or move the
 * reader, and they end with the page. The animation is not evidence that anything downloaded.
 */
@Stable
internal class DownloadFlight(private val scope: CoroutineScope) {
    internal class Flight(val from: Offset, val to: Offset) {
        /** Linear time 0..1; the position eases, the fade follows the clock. */
        val clock = Animatable(0f)
    }

    internal val flights = mutableStateListOf<Flight>()
    internal val pop = Animatable(1f)
    internal var layer: LayoutCoordinates? = null
    internal var target: LayoutCoordinates? = null
    /** The latest press on the page, in the layer's coordinates. */
    internal var press: Offset? = null

    /** Call after a download was queued. */
    fun launch() {
        val layer = layer?.takeIf { it.isAttached } ?: return
        val target = target?.takeIf { it.isAttached } ?: return
        // Reduced motion does not fly: the button's badge already reports the new task.
        if (!ValueAnimator.areAnimatorsEnabled()) return
        if (flights.size >= MAX_FLIGHTS) { scope.launch { popTarget() }; return }
        val to = layer.localPositionOf(target, target.size.toSize().center)
        val from = press ?: Offset(layer.size.width / 2f, layer.size.height / 2f)
        val flight = Flight(from, to)
        flights += flight
        scope.launch {
            try {
                flight.clock.animateTo(1f, tween(DURATION_MS, easing = LinearEasing))
            } finally {
                flights.remove(flight)
            }
            popTarget()
        }
    }

    private suspend fun popTarget() {
        pop.animateTo(1.12f, tween(90))
        pop.animateTo(1f, OrbisMotion.pop())
    }

    companion object {
        const val DURATION_MS = 520
        const val FADE_MS = 80
        const val MAX_FLIGHTS = 3
    }
}

@Composable
internal fun rememberDownloadFlight(vararg keys: Any?): DownloadFlight {
    val scope = rememberCoroutineScope()
    return remember(*keys) { DownloadFlight(scope) }
}

/** The page's download button: where flights land and what pops when they arrive. */
internal fun Modifier.downloadFlightTarget(flight: DownloadFlight): Modifier =
    onGloballyPositioned { flight.target = it }
        .graphicsLayer { flight.pop.value.let { scaleX = it; scaleY = it } }

/** Hosts [content] with the flight layer above it; presses are only observed, never consumed. */
@Composable
internal fun DownloadFlightHost(flight: DownloadFlight, content: @Composable () -> Unit) {
    Box(
        Modifier.fillMaxSize().pointerInput(flight) {
            awaitEachGesture {
                flight.press = awaitFirstDown(requireUnconsumed = false, pass = PointerEventPass.Initial).position
            }
        },
    ) {
        content()
        DownloadFlightLayer(flight)
    }
}

@Composable
private fun DownloadFlightLayer(flight: DownloadFlight) {
    val painter = rememberVectorPainter(Icons.Rounded.Description)
    val tint = ColorFilter.tint(MaterialTheme.colorScheme.primary)
    Canvas(Modifier.fillMaxSize().testTag("download-flight-layer").onGloballyPositioned { flight.layer = it }) {
        val arc = 120.dp.toPx()
        val fadeFrom = 1f - DownloadFlight.FADE_MS.toFloat() / DownloadFlight.DURATION_MS
        flight.flights.forEach { item ->
            val time = item.clock.value
            val t = FastOutSlowInEasing.transform(time)
            // Quadratic Bézier bending upward between the tap and the button; near the top edge the
            // bend shrinks so the icon never leaves the screen on its way to a header button.
            val top = minOf(item.from.y, item.to.y)
            val control = Offset((item.from.x + item.to.x) / 2f, top - minOf(arc, top / 2f))
            val u = 1f - t
            val point = item.from * (u * u) + control * (2f * u * t) + item.to * (t * t)
            val side = (28f + (16f - 28f) * t).dp.toPx()
            val alpha = if (time < fadeFrom) 1f else ((1f - time) / (1f - fadeFrom)).coerceIn(0f, 1f)
            translate(point.x - side / 2f, point.y - side / 2f) {
                with(painter) { draw(Size(side, side), alpha = alpha, colorFilter = tint) }
            }
        }
    }
}
