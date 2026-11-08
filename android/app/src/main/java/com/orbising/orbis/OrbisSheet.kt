package com.orbising.orbis

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectVerticalDragGestures
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.window.DialogWindowProvider
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import kotlinx.coroutines.launch

internal val LocalSheetCommit = staticCompositionLocalOf<((() -> Unit) -> Unit)?> { null }
internal val LocalModalCommit = staticCompositionLocalOf<((() -> Unit) -> Unit)?> { null }

/** Shared sheet: one material frame, 24dp arrival, a draggable grip and semantic dismissal timing. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun OrbisBottomSheet(
    onDismissRequest: () -> Unit,
    modifier: Modifier = Modifier,
    sheetState: SheetState? = null,
    shape: Shape = RoundedCornerShape(topStart = 32.dp, topEnd = 32.dp),
    containerColor: Color = MaterialTheme.colorScheme.surface,
    tonalElevation: Dp = 0.dp,
    dragHandle: (@Composable () -> Unit)? = { DefaultSheetGrip() },
    content: @Composable ColumnScope.() -> Unit,
) {
    val appearance = remember { Animatable(0f) }
    val drag = remember { Animatable(0f) }
    var closing by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    val density = LocalDensity.current
    val currentDismiss by rememberUpdatedState(onDismissRequest)
    fun dismiss() {
        if (closing) return
        closing = true
        scope.launch { appearance.animateTo(0f, tween(InteractionMotion.duration(InteractionMotion.Dismiss))); currentDismiss() }
    }
    LaunchedEffect(Unit) { appearance.animateTo(1f, tween(InteractionMotion.duration(InteractionMotion.Panel))) }
    Dialog(onDismissRequest = ::dismiss, properties = DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false)) {
        val view = LocalView.current
        DisposableEffect(view) {
            (view.parent as? DialogWindowProvider)?.window?.clearFlags(android.view.WindowManager.LayoutParams.FLAG_DIM_BEHIND)
            onDispose { }
        }
        Box(Modifier.fillMaxSize()) {
            Box(Modifier.matchParentSize().graphicsLayer { alpha = appearance.value }
                .background(MaterialTheme.colorScheme.scrim.copy(alpha = 0.34f))
                .clickable(interactionSource = remember { androidx.compose.foundation.interaction.MutableInteractionSource() }, indication = null, onClick = ::dismiss))
            CompositionLocalProvider(LocalOrbisSurface provides null) {
                NeumorphSurface(modifier.align(Alignment.BottomCenter).widthIn(max = 720.dp).fillMaxWidth()
                    .statusBarsPadding().imePadding().graphicsLayer {
                        alpha = appearance.value
                        translationY = with(density) { 24.dp.toPx() } * (1 - appearance.value) + drag.value
                    }, shape = RoundedCornerShape(32.dp), shadowScale = 1f, contentInset = 16.dp) {
                    Column(Modifier.fillMaxWidth()) {
                        if (dragHandle != null) Box(Modifier.fillMaxWidth().heightIn(min = 32.dp)
                            .pointerInput(Unit) { detectVerticalDragGestures(
                                onVerticalDrag = { change, amount -> change.consume(); scope.launch { drag.snapTo((drag.value + amount).coerceAtLeast(0f)) } },
                                onDragEnd = { if (drag.value > with(density) { 72.dp.toPx() }) dismiss() else scope.launch { drag.animateTo(0f, OrbisMotion.drag()) } },
                                onDragCancel = { scope.launch { drag.animateTo(0f, OrbisMotion.drag()) } },
                            ) }, contentAlignment = Alignment.Center) { dragHandle() }
                        CompositionLocalProvider(LocalSheetCommit provides { action ->
                            if (!closing) {
                                closing = true
                                scope.launch {
                                    appearance.animateTo(0f, tween(InteractionMotion.duration(InteractionMotion.Dismiss)))
                                    action()
                                }
                            }
                        }) { content() }
                    }
                }
            }
        }
    }
}

@Composable
private fun DefaultSheetGrip() {
    Box(Modifier.padding(vertical = 12.dp).size(40.dp, 4.dp).background(MaterialTheme.colorScheme.outlineVariant, CircleShape))
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun OrbisChoiceSheet(title: String, onDismiss: () -> Unit, content: @Composable ColumnScope.() -> Unit) {
    OrbisBottomSheet(onDismissRequest = onDismiss) {
        Column(Modifier.fillMaxWidth().navigationBarsPadding().padding(start = 16.dp, end = 16.dp, bottom = 24.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp)) {
            Text(title, style = MaterialTheme.typography.titleLarge)
            CompositionLocalProvider(LocalModalCommit provides LocalSheetCommit.current) { content() }
        }
    }
}
