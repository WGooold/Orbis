package com.orbising.orbis

import androidx.compose.animation.core.Animatable
import androidx.compose.foundation.gestures.detectHorizontalDragGestures
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.input.pointer.util.VelocityTracker
import androidx.compose.ui.layout.onSizeChanged
import kotlinx.coroutines.launch

/**
 * 聊天页右滑返回：在页面任意位置向右横拖，页面跟随手指；松手时按位移加上抛掷速度判断，
 * 超过三分之一屏宽就返回，否则回弹。竖向滑动先被消息列表消费，不会触发返回。
 * 拖动时底层露出 [underlay]（返回后要显示的页面，即会话列表），而不是空白。
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
    Box(
        Modifier
            .fillMaxSize()
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
                        else scope.launch { offset.animateTo(0f, OrbisMotion.drag()) }
                    },
                    onDragCancel = { scope.launch { offset.animateTo(0f, OrbisMotion.drag()) } },
                )
            },
    ) {
        if (offset.value > 0f) underlay()
        Box(Modifier.fillMaxSize().graphicsLayer { translationX = offset.value }) { content() }
    }
}
