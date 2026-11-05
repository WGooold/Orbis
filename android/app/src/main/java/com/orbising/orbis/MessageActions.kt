package com.orbising.orbis

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.SkipPrevious
import androidx.compose.material.icons.rounded.Close
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.platform.testTag
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

/** User bubbles and native text selection share the current page header owner (M19). */
@Composable
internal fun MessageActions(
    id: String,
    text: String,
    rewindEnabled: Boolean,
    onRewind: (() -> Unit)?,
    content: @Composable (open: () -> Unit) -> Unit,
) {
    val header = LocalMessageActionState.current
    var open by remember(id) { mutableStateOf(false) }
    var bounds by remember(id) { mutableStateOf(Rect.Zero) }
    var copySelection by remember(id) { mutableStateOf<(() -> Unit)?>(null) }
    var selectAll by remember(id) { mutableStateOf<(() -> Unit)?>(null) }
    var allowSelectionMenu by remember(id) { mutableStateOf(true) }
    val currentRewind by rememberUpdatedState(onRewind)
    val currentEnabled by rememberUpdatedState(rewindEnabled)
    fun show() {
        open = true
        header?.selection = MessageActionSelection(id, text, currentEnabled, { currentRewind?.invoke(); Unit }.takeIf { onRewind != null }, copySelection, selectAll)
    }
    LaunchedEffect(header?.selection?.id) { if (header != null && header.selection?.id != id) open = false }
    val toolbar = remember(id) {
        object : TextToolbar {
            override val status get() = if (open) TextToolbarStatus.Shown else TextToolbarStatus.Hidden
            override fun showMenu(rect: Rect, onCopyRequested: (() -> Unit)?, onPasteRequested: (() -> Unit)?,
                onCutRequested: (() -> Unit)?, onSelectAllRequested: (() -> Unit)?) {
                if (!allowSelectionMenu) return
                copySelection = onCopyRequested
                selectAll = onSelectAllRequested
                show()
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
    fun dismiss() { allowSelectionMenu = false; open = false; header?.dismiss(id) }
    LaunchedEffect(open, text, rewindEnabled, copySelection, selectAll) {
        if (open) header?.selection = MessageActionSelection(id, text, rewindEnabled, { currentRewind?.invoke(); Unit }.takeIf { onRewind != null }, copySelection, selectAll)
        else header?.dismiss(id)
    }
    DisposableEffect(id) { onDispose { header?.dismiss(id) } }
    Box(Modifier.orbisTouchOrigin { allowSelectionMenu = true }.onGloballyPositioned {
        val next = it.boundsInWindow()
        if (bounds != Rect.Zero && bounds != next) dismiss()
        bounds = next
    }.semantics { customActions = listOf(CustomAccessibilityAction(L10n.tr("消息操作")) { show(); true }) }) {
        CompositionLocalProvider(LocalTextToolbar provides toolbar) { content { show() } }
        NeumorphMenu(expanded = open && header == null, onDismissRequest = ::dismiss, preferAbove = true) {
            Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                CopyIconButton(L10n.tr("复制消息"), size = 32.dp) { text }
                if (onRewind != null) NeumorphIconButton(
                    onClick = { dismiss(); if (currentEnabled) currentRewind?.invoke() },
                    icon = Icons.Rounded.SkipPrevious, contentDescription = "Rewind", size = 32.dp, enabled = rewindEnabled)
            }
            // Preserve native selection handles and its copy/select-all operations. These
            // callbacks belong to the current selection and never rewrite message content.
            Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                copySelection?.let { copy -> NeumorphTextButton(L10n.tr("复制选中文本"), { dismiss(); copy() }) }
                selectAll?.let { all -> NeumorphTextButton(L10n.tr("全选"), all) }
            }
        }
    }
}


internal data class MessageActionSelection(val id: String, val text: String, val rewindEnabled: Boolean,
    val rewind: (() -> Unit)?, val copySelection: (() -> Unit)? = null, val selectAll: (() -> Unit)? = null)
internal class MessageActionState {
    var selection by mutableStateOf<MessageActionSelection?>(null)
    fun dismiss(id: String? = null) { if (id == null || selection?.id == id) selection = null }
}
internal val LocalMessageActionState = staticCompositionLocalOf<MessageActionState?> { null }

@OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)
@Composable
internal fun MessageActionHeader(normal: @Composable () -> Unit) {
    val state = LocalMessageActionState.current
    val selection = state?.selection
    SelectionBackPriority(selection != null) { state?.dismiss() }
    val show by androidx.compose.animation.core.animateFloatAsState(if (selection != null) 1f else 0f,
        androidx.compose.animation.core.tween(InteractionMotion.duration(InteractionMotion.State)), label = "message-header")
    var retained by remember { mutableStateOf(selection) }
    SideEffect { if (selection != null) retained = selection }
    Box {
        Box(Modifier.graphicsLayer { alpha = 1f - show }
            .then(if (selection != null) Modifier.clearAndSetSemantics { }.pointerInput(Unit) {
                detectTapGestures { }
            } else Modifier)) { CompositionLocalProvider(LocalMotionActionsEnabled provides (selection == null)) { normal() } }
        retained?.takeIf { show > 0f || selection != null }?.let { shown ->
            androidx.compose.material3.TopAppBar(
                modifier = Modifier.graphicsLayer { alpha = show; translationY = (1f-show) * -4.dp.toPx() }
                    .testTag("message-action-header")
                    .then(if (selection == null) Modifier.clearAndSetSemantics { } else Modifier),
                title = { if (shown.copySelection == null && shown.selectAll == null) MotionText(L10n.tr("消息操作"), maxLines = 1) },
                navigationIcon = { NeumorphIconButton({ state?.dismiss() }, Icons.Rounded.Close, L10n.tr("退出消息操作"), enabled = selection != null) },
                actions = {
                    CopyIconButton(L10n.tr("复制消息"), enabled = selection != null, identity = shown.id) { selection?.text.orEmpty() }
                    if (shown.rewind != null) NeumorphIconButton({
                        if (state?.selection?.id == shown.id && shown.rewindEnabled) { state.dismiss(); shown.rewind.invoke() }
                    }, Icons.Rounded.SkipPrevious, "Rewind", enabled = selection?.rewindEnabled == true)
                    shown.copySelection?.let { copy -> NeumorphTextButton(L10n.tr("复制选区"), { if (selection != null) copy() }) }
                    shown.selectAll?.let { all -> NeumorphTextButton(L10n.tr("全选"), { if (selection != null) all() }) }
                },
            )
        }
    }
}
