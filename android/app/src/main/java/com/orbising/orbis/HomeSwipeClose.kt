package com.orbising.orbis

import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.awaitHorizontalTouchSlopOrCancellation
import androidx.compose.foundation.gestures.horizontalDrag
import androidx.compose.ui.input.pointer.PointerInputChange
import androidx.compose.ui.input.pointer.PointerInputScope
import androidx.compose.ui.input.pointer.positionChange

/** Claim only left-starting drags; right-starting drags remain available to the home drawer. */
internal suspend fun PointerInputScope.detectHomeCloseDragGestures(
    onDragStart: () -> Unit,
    onDragEnd: () -> Unit,
    onDragCancel: () -> Unit,
    onHorizontalDrag: (PointerInputChange, Float) -> Unit,
) {
    awaitEachGesture {
        val down = awaitFirstDown(requireUnconsumed = false)
        var closing: Boolean? = null
        var overSlop = 0f
        val drag = awaitHorizontalTouchSlopOrCancellation(down.id) { change, over ->
            // Decide before consuming touch slop. Ignoring positive deltas in the drag
            // callback is too late: the general horizontal detector already owns the drag.
            if (closing == null) closing = over < 0f
            if (closing == true) {
                change.consume()
                overSlop = over
            }
        }
        if (drag != null) {
            onDragStart()
            onHorizontalDrag(drag, overSlop)
            // Keep ownership when the finger reverses so a close can be pulled back
            // without handing the same gesture to the drawer halfway through.
            if (horizontalDrag(drag.id) {
                onHorizontalDrag(it, it.positionChange().x)
                it.consume()
            }) {
                onDragEnd()
            } else {
                onDragCancel()
            }
        }
    }
}
