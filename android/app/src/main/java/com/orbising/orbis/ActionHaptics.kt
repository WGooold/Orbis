package com.orbising.orbis

import android.view.HapticFeedbackConstants
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.platform.LocalView

/** Opt in only after a deliberate action is submitted; ordinary buttons stay quiet. */
@Composable
internal fun rememberActionHaptic(): () -> Unit {
    val view = LocalView.current
    return remember(view) {
        { view.performHapticFeedback(HapticFeedbackConstants.VIRTUAL_KEY); Unit }
    }
}
