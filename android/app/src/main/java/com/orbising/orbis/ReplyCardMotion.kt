package com.orbising.orbis

import android.animation.ValueAnimator
import android.os.SystemClock
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.snap
import androidx.compose.animation.core.tween
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.layout.Layout
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.constrainHeight
import androidx.compose.ui.unit.dp
import kotlin.math.roundToInt

internal data class ReplyCardPart(val id: String, val text: String)
private data class ReplyCardMeasurement(val size: IntSize, val parts: List<ReplyCardPart>, val live: Boolean, val animate: Boolean)

/** Append-only live growth; ordinary disclosure, reflow and history keep their own layout. */
internal class ReplyCardGrowth {
    private var size: IntSize? = null
    private var parts = emptyList<ReplyCardPart>()
    private var live = false
    var animates = false
        private set

    fun update(next: IntSize, nextParts: List<ReplyCardPart>, nextLive: Boolean,
               reduced: Boolean, entering: Boolean = false): Boolean {
        val appended = nextParts != parts && nextParts.size >= parts.size && parts.zip(nextParts).all {
            (old, new) -> old.id == new.id && new.text.startsWith(old.text)
        }
        val old = size
        if (old == null) animates = entering && !reduced
        else if (reduced || next.width != old.width || (!appended && nextParts != parts)) animates = false
        else if (next.height != old.height) animates = next.height > old.height && appended && (live || nextLive)
        // Tokens that do not add a line must neither restart nor cancel a running transition.
        size = next; parts = nextParts; live = nextLive
        return animates
    }
}

/** Page-local, short-lived tickets are consumed once when a lazy row actually mounts. */
internal class ReplyCardArrivals {
    private var previous: List<String>? = null
    private var members = emptySet<String>()
    private var ready = false
    private val tickets = mutableMapOf<String, Long>()

    fun observe(rows: List<Pair<String, List<String>>>, nextReady: Boolean, following: Boolean, now: Long) {
        val ids = rows.map { it.first }
        tickets.entries.removeAll { now - it.value > InteractionMotion.ReplyArrival || it.key !in ids }
        previous?.let { old ->
            if (ready && nextReady && following && ids.size > old.size && ids.take(old.size) == old) {
                rows.drop(old.size).filter { (_, ids) -> ids.none { it in members } }
                    .forEach { (id, _) -> tickets[id] = now }
            }
        }
        if (!nextReady || !following) tickets.clear()
        previous = ids; members = rows.flatMap { it.second }.toSet(); ready = nextReady
    }

    fun claim(id: String, now: Long): Boolean = tickets.remove(id)?.let { now - it <= InteractionMotion.ReplyArrival } ?: false
}

/** Measure once at the final width; only the bottom edge moves, never the text scale. */
@Composable
internal fun GrowingReplyCard(
    id: String,
    parts: List<ReplyCardPart>,
    live: Boolean,
    arrivals: ReplyCardArrivals?,
    modifier: Modifier = Modifier,
    content: @Composable () -> Unit,
) {
    val entering = remember(id) { arrivals?.claim(id, SystemClock.uptimeMillis()) == true }
    val policy = remember(id) { ReplyCardGrowth() }
    var measurement by remember(id) { mutableStateOf<ReplyCardMeasurement?>(null) }
    val measured = measurement?.size ?: IntSize.Zero
    var appeared by remember(id) { mutableStateOf(!entering) }
    val reduced = !ValueAnimator.areAnimatorsEnabled()
    val animate = measurement?.animate == true && !reduced
    val arrivalHeight = remember(id, measured.width > 0) { measured.height }
    val height by animateFloatAsState(measured.height.toFloat(),
        if (animate) tween(if (entering && measured.height == arrivalHeight) InteractionMotion.ReplyArrival else InteractionMotion.ReplyGrowth,
            easing = InteractionMotion.ReplyEase) else snap(), label = "reply-height")
    val alpha by animateFloatAsState(if (appeared || reduced) 1f else 0f,
        tween(if (reduced) 0 else InteractionMotion.ReplyArrival, easing = InteractionMotion.ReplyEase), label = "reply-arrival")
    LaunchedEffect(id) { appeared = true }
    NeumorphSurface(modifier.fillMaxWidth().graphicsLayer { this.alpha = alpha }, shadowScale = 0.55f, contentPadding = 16.dp) {
        Layout(content = content, modifier = Modifier.clipToBounds()) { children, constraints ->
            val child = children.single().measure(constraints.copy(minHeight = 0, maxHeight = Constraints.Infinity))
            val natural = IntSize(child.width, child.height)
            // Decide with the content and its new measurement together. Publishing the text
            // first would consume the append before measuring it, or flash the full height.
            val grow = policy.update(natural, parts, live, reduced, entering)
            val displayed = if (grow) height.roundToInt() else child.height
            val next = ReplyCardMeasurement(natural, parts, live, grow)
            if (measurement != next) measurement = next
            layout(child.width, constraints.constrainHeight(displayed.coerceAtLeast(0))) {
                child.placeRelative(0, 0)
            }
        }
    }
}
