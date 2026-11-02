package com.orbising.orbis

import android.animation.ValueAnimator
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.geometry.RoundRect
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.graphics.layer.GraphicsLayer
import androidx.compose.ui.graphics.layer.drawLayer
import androidx.compose.ui.graphics.rememberGraphicsLayer
import androidx.compose.ui.graphics.drawscope.clipPath
import androidx.compose.ui.graphics.drawscope.clipRect
import androidx.compose.ui.graphics.drawscope.scale
import androidx.compose.ui.graphics.drawscope.translate
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.layout.boundsInWindow
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.positionInWindow
import androidx.compose.ui.unit.toSize
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner

@Stable
internal class MessageSendFlightState(private val scope: CoroutineScope) {
    class Flight(val id: String, val text: String, val source: Rect, target: Rect) {
        var target by mutableStateOf(target)
        var landsOnRow by mutableStateOf(false)
        val progress = Animatable(0f)
        var awaitingTarget by mutableStateOf(false)
    }
    var composer = Rect.Zero
    var root = Rect.Zero
    var viewport = Rect.Zero
    var density = 1f
    val targets = mutableMapOf<String, Rect>()
    val visuals = mutableMapOf<String, GraphicsLayer>()
    val flights = mutableStateListOf<Flight>()
    private val jobs = mutableMapOf<String, Job>()

    fun launch(send: PendingSend, following: Boolean) {
        if (!ValueAnimator.areAnimatorsEnabled() || composer.isEmpty || root.isEmpty || flights.size >= 3 || flights.any { it.id == send.messageId }) return
        val width = composer.width.coerceAtMost(root.width * 0.55f)
        val fallback = Rect(root.right - width - 20 * density, composer.top - 72 * density, root.right - 20 * density, composer.top - 16 * density)
        val flight = Flight(send.messageId, send.text, composer, fallback).apply {
            awaitingTarget = following && !send.showsInQueue && !send.queueOwned
        }
        flights.add(flight)
        jobs[flight.id] = scope.launch {
            withFrameNanos { }; withFrameNanos { }
            targets[send.messageId]?.takeIf { following && !send.showsInQueue && !send.queueOwned && it.overlaps(root) && it.bottom <= composer.top }?.let {
                flight.target = it; flight.landsOnRow = true
            }
            flight.awaitingTarget = false
            flight.progress.animateTo(1f, tween(InteractionMotion.Send, easing = androidx.compose.animation.core.LinearEasing))
            flights.remove(flight); jobs.remove(flight.id)
        }
    }
    fun cancelFlights() { jobs.values.toList().forEach { it.cancel() }; jobs.clear(); flights.clear() }
    // Registered rows own their target/layer lifetime. Backgrounding or covering a page
    // cancels its animation without losing the landing registration when the page returns.
    fun clear() { cancelFlights() }
}

internal val LocalMessageSendFlight = staticCompositionLocalOf<MessageSendFlightState?> { null }

@Composable
internal fun MessageSendFlightHost(state: MessageSendFlightState, active: Boolean, content: @Composable () -> Unit) {
    LaunchedEffect(active) { if (!active) state.clear() }
    DisposableEffect(state) { onDispose { state.clear() } }
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    DisposableEffect(state, lifecycle) {
        val observer = LifecycleEventObserver { _, event -> if (event == Lifecycle.Event.ON_STOP) state.clear() }
        lifecycle.addObserver(observer)
        onDispose { lifecycle.removeObserver(observer) }
    }
    val density = LocalDensity.current
    SideEffect { state.density = density.density }
    Box(Modifier.fillMaxSize().onGloballyPositioned {
        val bounds = it.boundsInWindow()
        // Keyboard/rotation invalidates a captured trajectory. Keep the canonical row visible
        // immediately, and retain its live target registration for the next accepted send.
        if (state.root != Rect.Zero && state.root.size != bounds.size) state.cancelFlights()
        state.root = bounds
    }) {
        CompositionLocalProvider(LocalMessageSendFlight provides state, content = content)
        state.flights.forEach { flight ->
            key(flight.id) {
                val p = flight.progress.value
                val frame = InteractionMotion.sendFrame(flight.source, flight.target, p, density.density)
                val visual = if (flight.landsOnRow || flight.awaitingTarget) state.visuals[flight.id] else null
                if (visual != null) {
                    Canvas(Modifier.fillMaxSize().clearAndSetSemantics { }) {
                        clipRect(top = (state.viewport.top - state.root.top).coerceAtLeast(0f)) {
                            translate(frame.left - state.root.left, frame.top - state.root.top) {
                                val outline = Path().apply { addRoundRect(RoundRect(0f, 0f, frame.width, frame.height,
                                    CornerRadius(24.dp.toPx()))) }
                                clipPath(outline) {
                                    val factor = minOf(1f, frame.width / flight.target.width.coerceAtLeast(1f))
                                    scale(factor, factor, Offset.Zero) { drawLayer(visual) }
                                }
                            }
                        }
                    }
                } else {
                    NeumorphSurface(style = NeumorphStyle.Pressed, modifier = Modifier
                        .size(with(density) { frame.width.toDp() }, with(density) { frame.height.toDp() })
                        .graphicsLayer {
                            translationX = frame.left - state.root.left
                            translationY = frame.top - state.root.top
                            alpha = if (flight.awaitingTarget) 1f else ((1-p) / (1-InteractionMotion.SendArrival)).coerceIn(0f, 1f)
                        }.clearAndSetSemantics { }) {
                        Text(flight.text, Modifier.padding(14.dp), style = MaterialTheme.typography.bodyLarge)
                    }
                }
            }
        }
    }
}

@Composable
internal fun Modifier.messageSendFlightTarget(id: String): Modifier {
    val flight = LocalMessageSendFlight.current ?: return this
    val current = flight.flights.firstOrNull { it.id == id }
    val layer = rememberGraphicsLayer()
    DisposableEffect(flight, id, layer) {
        flight.visuals[id] = layer
        onDispose {
            if (flight.visuals[id] === layer) {
                flight.targets.remove(id)
                flight.visuals.remove(id)
            }
        }
    }
    return onGloballyPositioned {
        // boundsInWindow clips long rows to the viewport; unfolding needs their full size.
        flight.targets[id] = Rect(it.positionInWindow(), it.size.toSize())
    }.drawWithContent {
        if (current != null && (current.landsOnRow || current.awaitingTarget)) {
            // Record the real bubble once. The overlay reuses its display list, including
            // attachments and the exact text layout, while this row retains layout/semantics.
            layer.record { this@drawWithContent.drawContent() }
        } else {
            drawContent()
        }
    }
}
