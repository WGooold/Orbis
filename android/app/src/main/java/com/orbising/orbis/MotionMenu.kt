package com.orbising.orbis

import androidx.activity.compose.BackHandler
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.SizeTransform
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.slideOutHorizontally
import androidx.compose.animation.togetherWith
import androidx.compose.animation.core.MutableTransitionState
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.tween
import androidx.compose.animation.core.updateTransition
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.saveable.rememberSaveableStateHolder
import androidx.compose.foundation.ScrollState
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import kotlinx.coroutines.delay
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.TransformOrigin
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.type
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.IntRect
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Popup
import androidx.compose.ui.window.PopupPositionProvider
import androidx.compose.ui.window.PopupProperties

/** The same popup and surface own all menu depths. Content must use the rendered path. */
@Composable
internal fun MotionMenu(
    expanded: Boolean,
    onDismissRequest: () -> Unit,
    page: List<String>,
    onBack: (() -> Unit)?,
    preferAbove: Boolean,
    content: @Composable ColumnScope.(List<String>) -> Unit,
) {
    val visible = remember { MutableTransitionState(false) }
    LaunchedEffect(expanded) { visible.targetState = expanded }
    val transition = updateTransition(visible, label = "anchored-menu")
    val progress by transition.animateFloat(
        transitionSpec = { tween(InteractionMotion.duration(if (targetState) InteractionMotion.Panel else InteractionMotion.Exit)) },
        label = "panel-progress",
    ) { if (it) 1f else 0f }
    var origin by remember { mutableStateOf(TransformOrigin.Center) }
    val scrollStates = rememberSaveableStateHolder()
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    DisposableEffect(lifecycle, expanded) {
        val observer = LifecycleEventObserver { _, event -> if (event == Lifecycle.Event.ON_STOP && expanded) onDismissRequest() }
        lifecycle.addObserver(observer)
        onDispose { lifecycle.removeObserver(observer) }
    }
    val density = LocalDensity.current
    val insets = WindowInsets.safeDrawing
    val top = insets.getTop(density); val bottom = insets.getBottom(density)
    val gap = with(density) { 8.dp.roundToPx() }
    val margin = with(density) { 16.dp.roundToPx() }
    val provider = remember(gap, margin, top, bottom, preferAbove) {
        object : PopupPositionProvider {
            override fun calculatePosition(anchorBounds: IntRect, windowSize: IntSize, layoutDirection: LayoutDirection, popupContentSize: IntSize): IntOffset {
                val x = (if (anchorBounds.center.x > windowSize.width / 2) anchorBounds.right - popupContentSize.width else anchorBounds.left)
                    .coerceIn(margin, (windowSize.width - margin - popupContentSize.width).coerceAtLeast(margin))
                val low = top + gap
                val high = (windowSize.height - bottom - gap - popupContentSize.height).coerceAtLeast(low)
                val below = anchorBounds.bottom + gap; val above = anchorBounds.top - gap - popupContentSize.height
                val y = when {
                    preferAbove && above >= low -> above
                    below <= high -> below
                    above >= low -> above
                    else -> (anchorBounds.center.y - popupContentSize.height / 2).coerceIn(low, high)
                }
                origin = TransformOrigin(
                    ((anchorBounds.center.x - x).toFloat() / popupContentSize.width.coerceAtLeast(1)).coerceIn(0f, 1f),
                    ((anchorBounds.center.y - y).toFloat() / popupContentSize.height.coerceAtLeast(1)).coerceIn(0f, 1f),
                )
                return IntOffset(x, y)
            }
        }
    }
    if (expanded || visible.currentState || visible.targetState) {
        val back = { if (page.isNotEmpty() && onBack != null) onBack() else onDismissRequest() }
        BackHandler(enabled = expanded, onBack = back)
        val maxWidth = (LocalConfiguration.current.screenWidthDp - 32).coerceIn(120, 300).dp
        val maxHeight = (LocalConfiguration.current.screenHeightDp - with(density) { (top + bottom).toDp().value } - 32).coerceAtLeast(48f).dp
        Popup(popupPositionProvider = provider, onDismissRequest = onDismissRequest,
            properties = PopupProperties(focusable = true, dismissOnBackPress = false),
        ) {
            CompositionLocalProvider(LocalOrbisSurface provides null) {
                NeumorphSurface(shape = RemoteUi.CardShape, modifier = Modifier
                    .widthIn(max = maxWidth).heightIn(max = maxHeight)
                    .onPreviewKeyEvent { event ->
                        if (event.key == Key.Back || event.key == Key.Escape) {
                            if (event.type == KeyEventType.KeyUp) back()
                            true
                        } else false
                    }
                    .then(if (!expanded) Modifier.clearAndSetSemantics { } else Modifier)
                    .graphicsLayer {
                        transformOrigin = origin
                        alpha = progress
                        scaleX = 0.86f + 0.14f * progress; scaleY = scaleX
                        translationX = (origin.pivotFractionX - 0.5f) * 24.dp.toPx() * (1 - progress)
                        translationY = (origin.pivotFractionY - 0.5f) * 16.dp.toPx() * (1 - progress)
                        rotationX = (origin.pivotFractionY - 0.5f) * 12 * (1 - progress)
                        cameraDistance = 12 * density.density
                    },
                ) {
                    AnimatedContent(targetState = page, label = "menu-page", transitionSpec = {
                        val forward = targetState.size > initialState.size
                        val shapeTime = InteractionMotion.duration(InteractionMotion.State)
                        val slideTime = InteractionMotion.duration(InteractionMotion.Panel)
                        (slideInHorizontally(tween(slideTime, delayMillis = shapeTime)) { if (forward) it else -it / 3 } +
                            fadeIn(tween(slideTime, delayMillis = shapeTime)))
                            .togetherWith(slideOutHorizontally(tween(slideTime, delayMillis = shapeTime)) { if (forward) -it / 3 else it } +
                                fadeOut(tween(slideTime, delayMillis = shapeTime)))
                            .using(SizeTransform { _, _ -> tween(shapeTime) })
                    }) { renderedPage ->
                        CompositionLocalProvider(LocalOrbisSurface provides OrbisSurfaceContext(1, 1, 16.dp),
                            LocalMotionActionsEnabled provides (expanded && renderedPage == page)) {
                            scrollStates.SaveableStateProvider(renderedPage.joinToString("/")) {
                                val scroll = rememberSaveable(saver = ScrollState.Saver) { ScrollState(0) }
                                Column(Modifier.heightIn(max = maxHeight).verticalScroll(scroll).padding(8.dp)
                                    .then(if (renderedPage != page) Modifier.clearAndSetSemantics { } else Modifier),
                                    verticalArrangement = Arrangement.spacedBy(4.dp)) { content(renderedPage) }
                            }
                        }
                    }
                }
            }
        }
    }
}
