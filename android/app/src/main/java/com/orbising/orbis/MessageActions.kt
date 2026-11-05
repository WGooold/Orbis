package com.orbising.orbis

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.SkipPrevious
import androidx.compose.material.icons.rounded.TextFields
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner

private enum class MessageActionMode { Reading, Menu, TextSelection }

/** One explicit mode per message. Native selection never opens message actions. */
@Composable
internal fun MessageActions(
    id: String,
    text: String,
    rewindEnabled: Boolean,
    onRewind: (() -> Unit)?,
    content: @Composable (open: () -> Unit) -> Unit,
) {
    var mode by remember(id) { mutableStateOf(MessageActionMode.Reading) }
    var menuEpoch by remember(id) { mutableIntStateOf(0) }
    val currentRewind by rememberUpdatedState(onRewind)
    val currentEnabled by rememberUpdatedState(rewindEnabled)
    val active = LocalPageActive.current
    fun dismiss() { mode = MessageActionMode.Reading }
    fun show() {
        if (active && mode == MessageActionMode.Reading && (text.isNotEmpty() || rewindEnabled && onRewind != null)) {
            menuEpoch++
            mode = MessageActionMode.Menu
        }
    }
    LaunchedEffect(id, text, rewindEnabled, onRewind != null, active) { dismiss() }
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    DisposableEffect(lifecycle, id) {
        val observer = LifecycleEventObserver { _, event -> if (event == Lifecycle.Event.ON_STOP) dismiss() }
        lifecycle.addObserver(observer)
        onDispose { lifecycle.removeObserver(observer) }
    }
    SelectionBackPriority(mode != MessageActionMode.Reading, ::dismiss)
    Box(Modifier.semantics {
        customActions = listOf(CustomAccessibilityAction(L10n.tr("消息操作")) { show(); true })
    }) {
        CompositionLocalProvider(LocalMessageTextSelectionEnabled provides false) { content(::show) }
        // Remove the menu before handing focus to native selection, including its exit layer.
        if (mode != MessageActionMode.TextSelection) {
            NeumorphMenu(expanded = mode == MessageActionMode.Menu, onDismissRequest = ::dismiss, preferAbove = true) {
                if (text.isNotEmpty()) {
                    CopyMenuItem(L10n.tr("复制消息"), identity = id to menuEpoch) { text }
                    NeumorphMenuItem(text = { Text(L10n.tr("选择文字")) },
                        leadingIcon = { OrbisActionIcon(Icons.Rounded.TextFields, contentDescription = null) },
                        onClick = { if (mode == MessageActionMode.Menu) mode = MessageActionMode.TextSelection })
                }
                if (rewindEnabled && onRewind != null) {
                    if (text.isNotEmpty()) HorizontalDivider()
                    NeumorphMenuItem(text = { Text("Rewind") },
                        leadingIcon = { OrbisActionIcon(Icons.Rounded.SkipPrevious, contentDescription = null) },
                        onClick = {
                            if (mode == MessageActionMode.Menu && currentEnabled) {
                                dismiss(); currentRewind?.invoke()
                            }
                        })
                }
            }
        }
    }
    if (mode == MessageActionMode.TextSelection) {
        NeumorphDialog(
            onDismissRequest = ::dismiss,
            title = { Text(L10n.tr("选择文字")) },
            text = {
                SelectionContainer(Modifier.testTag("message-text-selection")) {
                    Text(text, Modifier.fillMaxWidth().heightIn(max = 420.dp)
                        .verticalScroll(rememberScrollState()).testTag("message-selection-text"))
                }
            },
            confirmButton = { NeumorphTextButton(L10n.tr("关闭文字选择"), ::dismiss) },
            dismissButton = { CopyTextButton(L10n.tr("复制消息"), identity = id) { text } },
        )
    }
}
