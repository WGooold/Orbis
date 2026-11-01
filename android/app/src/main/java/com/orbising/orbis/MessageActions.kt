package com.orbising.orbis

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.SkipPrevious
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.layout.boundsInWindow
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.platform.LocalTextToolbar
import androidx.compose.ui.platform.TextToolbar
import androidx.compose.ui.platform.TextToolbarStatus
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner

/** User bubbles and native text selection share one anchored action owner (M19). */
@Composable
internal fun MessageActions(
    id: String,
    text: String,
    rewindEnabled: Boolean,
    onRewind: (() -> Unit)?,
    content: @Composable (open: () -> Unit) -> Unit,
) {
    var open by remember(id) { mutableStateOf(false) }
    var bounds by remember(id) { mutableStateOf(Rect.Zero) }
    var copySelection by remember(id) { mutableStateOf<(() -> Unit)?>(null) }
    var selectAll by remember(id) { mutableStateOf<(() -> Unit)?>(null) }
    var allowSelectionMenu by remember(id) { mutableStateOf(true) }
    val currentRewind by rememberUpdatedState(onRewind)
    val currentEnabled by rememberUpdatedState(rewindEnabled)
    val toolbar = remember(id) {
        object : TextToolbar {
            override val status get() = if (open) TextToolbarStatus.Shown else TextToolbarStatus.Hidden
            override fun showMenu(rect: Rect, onCopyRequested: (() -> Unit)?, onPasteRequested: (() -> Unit)?,
                onCutRequested: (() -> Unit)?, onSelectAllRequested: (() -> Unit)?) {
                if (!allowSelectionMenu) return
                copySelection = onCopyRequested
                selectAll = onSelectAllRequested
                open = true
            }
            override fun hide() { if (copySelection != null || selectAll != null) open = false; copySelection = null; selectAll = null }
        }
    }
    LaunchedEffect(id, rewindEnabled, onRewind != null) { open = false }
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    DisposableEffect(lifecycle, id) {
        val observer = LifecycleEventObserver { _, event -> if (event == Lifecycle.Event.ON_STOP) open = false }
        lifecycle.addObserver(observer)
        onDispose { lifecycle.removeObserver(observer) }
    }
    fun dismiss() { allowSelectionMenu = false; open = false }
    Box(Modifier.orbisTouchOrigin { allowSelectionMenu = true }.onGloballyPositioned {
        val next = it.boundsInWindow()
        if (bounds != Rect.Zero && bounds != next) dismiss()
        bounds = next
    }.semantics { customActions = listOf(CustomAccessibilityAction("消息操作") { open = true; true }) }) {
        CompositionLocalProvider(LocalTextToolbar provides toolbar) { content { open = true } }
        NeumorphMenu(expanded = open, onDismissRequest = ::dismiss, preferAbove = true) {
            Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                CopyIconButton("复制消息", size = 32.dp) { text }
                if (onRewind != null) NeumorphIconButton(
                    onClick = { dismiss(); if (currentEnabled) currentRewind?.invoke() },
                    icon = Icons.Rounded.SkipPrevious, contentDescription = "Rewind", size = 32.dp, enabled = rewindEnabled)
            }
            // Preserve native selection handles and its copy/select-all operations. These
            // callbacks belong to the current selection and never rewrite message content.
            Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                copySelection?.let { copy -> NeumorphTextButton("复制选中文本", { dismiss(); copy() }) }
                selectAll?.let { all -> NeumorphTextButton("全选", all) }
            }
        }
    }
}
