package com.orbising.orbis

import android.view.HapticFeedbackConstants
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.platform.LocalView

/** Opt in only after a deliberate action is submitted; ordinary buttons stay quiet. LONG_PRESS (heavy click) because VIRTUAL_KEY is too faint on many motors. */
@Composable
internal fun rememberActionHaptic(): () -> Unit {
    val view = LocalView.current
    return remember(view) {
        { view.performHapticFeedback(HapticFeedbackConstants.LONG_PRESS); Unit }
    }
}
