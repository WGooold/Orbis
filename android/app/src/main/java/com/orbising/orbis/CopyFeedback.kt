package com.orbising.orbis

import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.Check
import androidx.compose.material.icons.rounded.ContentCopy
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import kotlinx.coroutines.delay

private class CopyFeedback {
    var copied by mutableStateOf(false)
        private set
    var generation by mutableLongStateOf(0)
        private set

    fun perform(copy: () -> Unit) {
        copy()
        copied = true
        generation++
    }

    fun clear() { copied = false }
}

/** Each copy owner has one cancellable deadline; accessibility motion settings do not shorten it. */
@Composable
private fun rememberCopyFeedback(identity: Any?, enabled: Boolean): CopyFeedback {
    val feedback = remember(identity) { CopyFeedback() }
    LaunchedEffect(feedback, feedback.generation, feedback.copied, enabled) {
        if (!enabled) feedback.clear()
        else if (feedback.copied) {
            delay(InteractionMotion.CopyFeedback)
            feedback.clear()
        }
    }
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    DisposableEffect(lifecycle, feedback) {
        val observer = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_STOP) feedback.clear()
        }
        lifecycle.addObserver(observer)
        onDispose { lifecycle.removeObserver(observer); feedback.clear() }
    }
    return feedback
}

/** Copies [text] and shows a check for 2.5 s; copying again restarts the timer. */
@Composable
internal fun CopyIconButton(
    label: String,
    size: Dp = 32.dp,
    enabled: Boolean = true,
    identity: Any? = null,
    text: () -> String,
) {
    val clipboard = LocalClipboardManager.current
    val feedback = rememberCopyFeedback(identity, enabled)
    NeumorphIconButton(
        onClick = { feedback.perform { clipboard.setText(AnnotatedString(text())) } },
        icon = if (feedback.copied) Icons.Rounded.Check else Icons.Rounded.ContentCopy,
        contentDescription = if (feedback.copied) L10n.tr("已复制") else label,
        size = size,
        enabled = enabled,
    )
}

/** The label and hit area stay fixed while the copy glyph changes to a check. */
@Composable
internal fun CopyTextButton(label: String, identity: Any? = null, text: () -> String) {
    val clipboard = LocalClipboardManager.current
    val feedback = rememberCopyFeedback(identity, enabled = true)
    NeumorphTextButton(
        text = label,
        onClick = { feedback.perform { clipboard.setText(AnnotatedString(text())) } },
        icon = if (feedback.copied) Icons.Rounded.Check else Icons.Rounded.ContentCopy,
        modifier = Modifier.semantics { contentDescription = if (feedback.copied) L10n.tr("已复制") else label },
    )
}
