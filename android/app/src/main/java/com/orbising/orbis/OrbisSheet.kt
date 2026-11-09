package com.orbising.orbis

import android.view.WindowManager
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.FastOutLinearInEasing
import androidx.compose.animation.core.LinearOutSlowInEasing
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectVerticalDragGestures
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.window.DialogWindowProvider
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import kotlinx.coroutines.launch

internal val LocalSheetCommit = staticCompositionLocalOf<((() -> Unit) -> Unit)?> { null }
internal val LocalModalCommit = staticCompositionLocalOf<((() -> Unit) -> Unit)?> { null }
private val LocalSheetDragModifier = staticCompositionLocalOf<Modifier> { Modifier }

/** Custom sheet headers share the grip's drag lifecycle without capturing body scrolling. */
@Composable
internal fun sheetDragHandleModifier(): Modifier = LocalSheetDragModifier.current

/** Explicit close actions wait for the sheet's exit; ordinary controls keep their own behavior. */
@Composable
internal fun sheetCloseAction(onClose: () -> Unit): () -> Unit {
    val commit = LocalSheetCommit.current
    return { if (commit != null) commit(onClose) else onClose() }
}

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
    maxHeightFraction: Float = 1f,
    content: @Composable ColumnScope.() -> Unit,
) {
    val appearance = remember { Animatable(0f) }
    val drag = remember { Animatable(0f) }
    var closing by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    val density = LocalDensity.current
    val currentDismiss by rememberUpdatedState(onDismissRequest)
    fun close(action: () -> Unit) {
        if (closing) return
        closing = true
        scope.launch {
            appearance.animateTo(0f, tween(InteractionMotion.duration(InteractionMotion.Dismiss), easing = FastOutLinearInEasing))
            action()
        }
    }
    fun dismiss() = close { currentDismiss() }
    val dragModifier = Modifier.pointerInput(Unit) {
        detectVerticalDragGestures(
            onVerticalDrag = { change, amount ->
                change.consume()
                if (!closing) scope.launch { drag.snapTo((drag.value + amount).coerceAtLeast(0f)) }
            },
            onDragEnd = {
                if (drag.value > with(density) { 72.dp.toPx() }) dismiss()
                else scope.launch { drag.animateTo(0f, OrbisMotion.drag()) }
            },
            onDragCancel = { scope.launch { drag.animateTo(0f, OrbisMotion.drag()) } },
        )
    }
    // Compose 1.7's non-default-width Dialog measures from screenHeightDp instead of the
    // window's constraints. A full-screen native window must use its actual measure specs.
    Dialog(onDismissRequest = ::dismiss, properties = DialogProperties(decorFitsSystemWindows = false)) {
        val view = LocalView.current
        DisposableEffect(view) {
            (view.parent as? DialogWindowProvider)?.window?.apply {
                setLayout(WindowManager.LayoutParams.MATCH_PARENT, WindowManager.LayoutParams.MATCH_PARENT)
                clearFlags(WindowManager.LayoutParams.FLAG_DIM_BEHIND)
                setWindowAnimations(0)
            }
            onDispose { }
        }
        var laidOut by remember(view) { mutableStateOf(false) }
        // Start inside the dialog, after its first layout, so creating a second window cannot
        // consume the entrance animation before any sheet pixels are presented.
        LaunchedEffect(view, laidOut) {
            if (laidOut && !closing) {
                withFrameNanos { }
                appearance.animateTo(1f, tween(InteractionMotion.duration(InteractionMotion.Panel), easing = LinearOutSlowInEasing))
            }
        }
        Box(Modifier.fillMaxSize().testTag("orbis-sheet-window").onGloballyPositioned { laidOut = true }) {
            Box(Modifier.matchParentSize().graphicsLayer { alpha = appearance.value }
                .background(MaterialTheme.colorScheme.scrim.copy(alpha = 0.34f))
                .testTag("orbis-sheet-scrim")
                .clickable(interactionSource = remember { androidx.compose.foundation.interaction.MutableInteractionSource() }, indication = null, onClick = ::dismiss))
            BoxWithConstraints(Modifier.fillMaxSize()
                .windowInsetsPadding(WindowInsets.safeDrawing.only(WindowInsetsSides.Top + WindowInsetsSides.Horizontal))
                .imePadding().padding(top = 16.dp)) {
                CompositionLocalProvider(LocalOrbisSurface provides null, LocalSheetDragModifier provides dragModifier) {
                    NeumorphSurface(modifier = Modifier.align(Alignment.BottomCenter).widthIn(max = 720.dp).fillMaxWidth()
                        .heightIn(max = maxHeight * maxHeightFraction).then(modifier).graphicsLayer {
                            alpha = appearance.value
                            translationY = with(density) { 24.dp.toPx() } * (1 - appearance.value) + drag.value
                        }.testTag("orbis-sheet-surface"), shape = RoundedCornerShape(32.dp), shadowScale = 1f, contentInset = 16.dp) {
                        // Own the bottom inset once, inside the measured surface. Every caller's
                        // footer and scroll viewport now share the same safe available height.
                        Column(Modifier.fillMaxWidth().navigationBarsPadding()) {
                            if (dragHandle != null) Box(Modifier.fillMaxWidth().heightIn(min = 32.dp)
                                .testTag("orbis-sheet-grip").then(dragModifier), contentAlignment = Alignment.Center) { dragHandle() }
                            CompositionLocalProvider(LocalSheetCommit provides ::close) { content() }
                        }
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
    OrbisBottomSheet(onDismissRequest = onDismiss, maxHeightFraction = 0.88f) {
        Column(Modifier.fillMaxWidth().testTag("orbis-choice-sheet")
            .padding(start = 16.dp, end = 16.dp, bottom = 24.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
            Text(title, style = MaterialTheme.typography.titleLarge)
            Column(Modifier.fillMaxWidth().weight(1f, fill = false).verticalScroll(rememberScrollState())) {
                CompositionLocalProvider(LocalModalCommit provides LocalSheetCommit.current) { content() }
            }
        }
    }
}
