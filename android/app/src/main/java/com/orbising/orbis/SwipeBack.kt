package com.orbising.orbis

import androidx.compose.animation.core.Animatable
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectHorizontalDragGestures
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.graphics.TransformOrigin
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.input.pointer.util.VelocityTracker
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.semantics.clearAndSetSemantics
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch

/**
 * 聊天页右滑返回：在页面任意位置向右横拖，页面跟随手指；松手时按位移加上抛掷速度判断，
 * 超过三分之一屏宽就弹到右侧，动画结束才返回，否则回弹。竖向滑动由消息列表消费。
 * [underlay] 固定在原位，起始轻微横向受压，随右滑逐步恢复原状并渐亮。
 * 手势挂在位移图层外侧，指针坐标不随页面平移而变化。
 */
@Composable
internal fun SwipeBackLayer(
    onBack: () -> Unit,
    underlay: @Composable () -> Unit,
    content: @Composable () -> Unit,
) {
    val currentOnBack by rememberUpdatedState(onBack)
    val offset = remember { Animatable(0f) }
    val scope = rememberCoroutineScope()
    var width by remember { mutableIntStateOf(0) }
    var dragOffset by remember { mutableFloatStateOf(0f) }
    var dragging by remember { mutableStateOf(false) }
    var entering by remember { mutableStateOf(true) }
    var entranceStarted by remember { mutableStateOf(false) }
    var returning by remember { mutableStateOf(false) }
    var settleJob by remember { mutableStateOf<Job?>(null) }
    val underlayVisible by remember { derivedStateOf { entering || dragging || offset.isRunning || offset.value > 0f } }
    val scrim = MaterialTheme.colorScheme.scrim

    fun position(): Float {
        if (entering && !entranceStarted) return width.toFloat()
        val value = if (dragging) dragOffset else offset.value
        return if (dragging && value > width) width + (value - width) * 0.18f else value
    }
    fun progress() = (position() / width.coerceAtLeast(1)).coerceIn(0f, 1f)
    fun settle(back: Boolean, velocity: Float) {
        val released = position()
        returning = back
        settleJob = scope.launch {
            offset.snapTo(released)
            dragging = false
            offset.animateTo(
                if (back) width.toFloat() else 0f,
                OrbisMotion.swipeBack(),
                initialVelocity = velocity.coerceIn(-width * 4f, width * 4f),
            )
            if (back) currentOnBack()
        }
    }
    LaunchedEffect(width) {
        if (width > 0 && entering) {
            if (!entranceStarted) offset.snapTo(width.toFloat())
            entranceStarted = true
            offset.animateTo(0f, OrbisMotion.swipeBack())
            entering = false
        }
    }
    Box(
        Modifier
            .fillMaxSize()
            .background(MaterialTheme.colorScheme.background)
            .clipToBounds()
            .onSizeChanged { width = it.width }
            .pointerInput(Unit) {
                val velocity = VelocityTracker()
                detectHorizontalDragGestures(
                    onDragStart = {
                        if (!returning && !entering) {
                            settleJob?.cancel()
                            dragOffset = offset.value.coerceAtLeast(0f)
                            dragging = true
                            velocity.resetTracking()
                        }
                    },
                    onHorizontalDrag = { change, dragAmount ->
                        if (!dragging || returning) return@detectHorizontalDragGestures
                        velocity.addPosition(change.uptimeMillis, change.position)
                        change.consume()
                        dragOffset = (dragOffset + dragAmount).coerceAtLeast(0f)
                    },
                    onDragEnd = {
                        if (dragging && !returning) {
                            val speed = velocity.calculateVelocity().x
                            val projected = position() + speed * 0.15f
                            settle(width > 0 && projected > width / 3f, speed)
                        }
                    },
                    onDragCancel = { if (dragging && !returning) settle(false, 0f) },
                )
            },
    ) {
        if (underlayVisible) {
            Box(Modifier.fillMaxSize()
                .clearAndSetSemantics { }
                .graphicsLayer {
                    val compression = 1f - progress()
                    transformOrigin = TransformOrigin(0f, 0.5f)
                    scaleX = 1f - 0.025f * compression
                    scaleY = 1f + 0.008f * compression
                }
                .drawWithContent {
                    drawContent()
                    drawRect(scrim.copy(alpha = 0.34f * (1f - progress())))
                }) {
                underlay()
                // The revealed home is a preview until navigation finishes.
                Box(Modifier.matchParentSize().pointerInput(Unit) { detectTapGestures { } })
            }
        }
        Box(Modifier.fillMaxSize().graphicsLayer {
            translationX = if (entering && !entranceStarted) size.width else position().coerceAtLeast(0f)
        }) { content() }
    }
}
