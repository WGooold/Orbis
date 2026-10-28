package com.orbising.orbis

import androidx.compose.animation.core.Animatable
import androidx.compose.foundation.gestures.detectHorizontalDragGestures
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.composed
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.input.pointer.util.VelocityTracker
import androidx.compose.ui.layout.onSizeChanged
import kotlinx.coroutines.launch

/**
 * 聊天页右滑返回：在页面任意位置向右横拖，页面跟随手指；松手时按位移加上抛掷速度判断，
 * 超过三分之一屏宽就返回，否则回弹。竖向滑动先被消息列表消费，不会触发返回。
 * 手势挂在位移图层外侧，指针坐标不随页面平移而变化。
 */
internal fun Modifier.swipeToGoBack(onBack: () -> Unit): Modifier = composed {
    val currentOnBack by rememberUpdatedState(onBack)
    val offset = remember { Animatable(0f) }
    val scope = rememberCoroutineScope()
    var width by remember { mutableIntStateOf(0) }
    this
        .onSizeChanged { width = it.width }
        .pointerInput(Unit) {
            val velocity = VelocityTracker()
            detectHorizontalDragGestures(
                onDragStart = { velocity.resetTracking() },
                onHorizontalDrag = { change, dragAmount ->
                    velocity.addPosition(change.uptimeMillis, change.position)
                    change.consume()
                    scope.launch { offset.snapTo((offset.value + dragAmount).coerceAtLeast(0f)) }
                },
                onDragEnd = {
                    val projected = offset.value + velocity.calculateVelocity().x * 0.15f
                    if (projected > width / 3f) currentOnBack()
                    else scope.launch { offset.animateTo(0f) }
                },
                onDragCancel = { scope.launch { offset.animateTo(0f) } },
            )
        }
        .graphicsLayer { translationX = offset.value }
}
