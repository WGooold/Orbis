package com.orbising.orbis

import android.animation.ValueAnimator
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.tween
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
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.layout.boundsInWindow
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
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
        val handingOff: Boolean get() = progress.value >= 0.78f
    }
    var composer = Rect.Zero
    var root = Rect.Zero
    var density = 1f
    val targets = mutableMapOf<String, Rect>()
    val flights = mutableStateListOf<Flight>()
    private val jobs = mutableMapOf<String, Job>()

    fun launch(send: PendingSend, following: Boolean) {
        if (!ValueAnimator.areAnimatorsEnabled() || composer.isEmpty || root.isEmpty || flights.size >= 3 || flights.any { it.id == send.messageId }) return
        val width = composer.width.coerceAtMost(root.width * 0.55f)
        val fallback = Rect(root.right - width - 20 * density, composer.top - 72 * density, root.right - 20 * density, composer.top - 16 * density)
        val flight = Flight(send.messageId, send.text, composer, fallback)
        flights.add(flight)
        jobs[flight.id] = scope.launch {
            withFrameNanos { }; withFrameNanos { }
            targets[send.messageId]?.takeIf { following && !send.showsInQueue && !send.queueOwned && it.overlaps(root) && it.bottom <= composer.top }?.let {
                flight.target = it; flight.landsOnRow = true
            }
            flight.progress.animateTo(1f, tween(InteractionMotion.Send, easing = androidx.compose.animation.core.LinearEasing))
            flights.remove(flight); jobs.remove(flight.id)
        }
    }
    fun cancelFlights() { jobs.values.toList().forEach { it.cancel() }; jobs.clear(); flights.clear() }
    fun clear() { cancelFlights(); targets.clear() }
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
                val center = InteractionMotion.sendPoint(flight.source.center, flight.target.center, p, 24 * density.density) - state.root.topLeft
                val width = flight.source.width + (flight.target.width - flight.source.width) * (p / 0.25f).coerceIn(0f, 1f)
                val height = (flight.source.height + (flight.target.height - flight.source.height) * p).coerceAtMost(with(density) { 96.dp.toPx() })
                NeumorphSurface(style = NeumorphStyle.Pressed, modifier = Modifier
                    .size(with(density) { width.toDp() }, with(density) { height.toDp() })
                    .graphicsLayer { translationX = center.x - width / 2; translationY = center.y - height / 2; alpha = if (p > 0.78f) (1-p) / 0.22f else 1f }
                    .clearAndSetSemantics { }) {
                    Text(flight.text, Modifier.padding(14.dp), maxLines = 2, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.bodyLarge)
                }
            }
        }
    }
}

@Composable
internal fun Modifier.messageSendFlightTarget(id: String): Modifier {
    val flight = LocalMessageSendFlight.current ?: return this
    val current = flight.flights.firstOrNull { it.id == id }
    val alpha by androidx.compose.animation.core.animateFloatAsState(if (current?.landsOnRow == true && !current.handingOff) 0f else 1f,
        tween(if (current?.handingOff == true) 60 else 0), label = "send-handoff")
    DisposableEffect(flight, id) { onDispose { flight.targets.remove(id) } }
    return onGloballyPositioned { flight.targets[id] = it.boundsInWindow() }.graphicsLayer { this.alpha = alpha }
}
