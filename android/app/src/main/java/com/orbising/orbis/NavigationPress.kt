package com.orbising.orbis

import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.Modifier
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.ui.input.pointer.pointerInput

/** Immediate visual feedback in a scrolling list; click/long-press/drag ownership stays native. */
@Composable
internal fun Modifier.immediatePressFeedback(enabled: Boolean, onPressed: (Boolean) -> Unit): Modifier {
    val currentOnPressed by rememberUpdatedState(onPressed)
    return pointerInput(enabled) {
        if (!enabled) return@pointerInput
        awaitEachGesture {
            try {
                val down = awaitFirstDown(requireUnconsumed = false, pass = PointerEventPass.Initial)
                currentOnPressed(true)
                do {
                    // Observe after the list and swipe handlers: cancel the visual as soon
                    // as either owns a drag, without consuming their pointer events.
                    val event = awaitPointerEvent(PointerEventPass.Final)
                    val change = event.changes.firstOrNull { it.id == down.id } ?: break
                } while (change.pressed && !(change.isConsumed && change.position != change.previousPosition))
            } finally {
                currentOnPressed(false)
            }
        }
    }
}
