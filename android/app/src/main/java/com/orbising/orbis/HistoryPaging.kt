package com.orbising.orbis

import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Modifier
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.ui.input.pointer.pointerInput
import kotlin.math.abs
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow

/** 顶部区域的上界（含）：`firstVisibleIndex <= 1` 视为「已到顶部」。 */
private const val TopZoneLastIndex = 1

/**
 * 历史分页的触发条件（ADR-0041）：只有视口**从顶部区域外进入顶部区域**的那一次边沿请求下一页。
 *
 * 为什么不是电平：过去是「只要 `index <= 1` 就加载」。而 [firstVisibleIndex] 通过 `snapshotFlow`
 * 被 `LaunchedEffect` 收集，effect 的 key 里又带着 `historyRead.operationId/phase`——每完成一页
 * key 就变，effect 重启并立刻重放当前值，于是「停在顶部」变成连续下载，一页接一页。
 *
 * - 停在顶部不会重复请求：触发后必须离开（`index > TopZoneLastIndex`）才会重新武装；
 * - [blocked] 必须用 `rememberUpdatedState` 读最新值，**不要**把它放进 `LaunchedEffect` 的 key：
 *   key 变化会重启 `snapshotFlow` 并重放首帧，等于又把电平触发放回来。
 */
internal fun historyPagingRequests(
    firstVisibleIndex: () -> Int,
    blocked: () -> Boolean,
): Flow<Unit> = flow {
    var previous = firstVisibleIndex()
    snapshotFlow { firstVisibleIndex() to blocked() }.collect { (index, isBlocked) ->
        val enteredTop = index <= TopZoneLastIndex && previous > TopZoneLastIndex
        previous = index
        if (enteredTop && !isBlocked) emit(Unit)
    }
}

/** CHAT-PAGING-01: a blocked down event stays blocked, even if the page returns before release. */
internal class ChatHistoryPan {
    private var requiredDistance: Float? = null
    fun begin(nearTop: Boolean, admitted: Boolean, density: Float) {
        requiredDistance = if (admitted) (if (nearTop) 44f else 12f) * density else null
    }
    fun progress(dx: Float, dy: Float, nearTop: Boolean, admitted: Boolean): Float {
        val threshold = requiredDistance ?: return 0f
        if (!admitted || !nearTop || dy <= abs(dx)) return 0f
        return (dy / threshold).coerceAtMost(1f)
    }
    fun cancel() { requiredDistance = null }
    fun release(dx: Float, dy: Float, nearTop: Boolean, admitted: Boolean): Boolean {
        val ready = progress(dx, dy, nearTop, admitted) == 1f
        cancel()
        return ready
    }
}

/** Observe only physical transcript gestures. Final pass sees the list position after the drag.
 *  Never consume input, and never start a read from recomposition, rebound, or fling callbacks. */
internal fun Modifier.chatHistoryPull(
    owner: Pair<ChatPresentationIdentity, String?>,
    nearTop: () -> Boolean,
    canLoad: () -> Boolean,
    onLoad: () -> Unit,
    onProgress: (Float) -> Unit,
    onArmed: () -> Unit,
): Modifier = pointerInput(owner) {
    val gesture = ChatHistoryPan()
    awaitEachGesture {
        val down = awaitFirstDown(requireUnconsumed = false, pass = PointerEventPass.Initial)
        gesture.begin(nearTop(), canLoad(), density)
        var armed = false
        try {
            while (true) {
                val event = awaitPointerEvent(PointerEventPass.Final)
                if (event.changes.any { it.id != down.id && it.pressed }) break
                val change = event.changes.firstOrNull { it.id == down.id } ?: break
                val distance = change.position - down.position
                val admitted = canLoad()
                if (!admitted) break
                if (!change.pressed) {
                    // Compose represents a cancelled pointer as a consumed up.
                    if (!change.isConsumed && gesture.release(distance.x, distance.y, nearTop(), admitted)) onLoad()
                    break
                }
                val progress = gesture.progress(distance.x, distance.y, nearTop(), admitted)
                onProgress(progress)
                // CHAT-PAGING-06: only an in-drag transition to the full ring gives feedback.
                val nextArmed = progress >= 1f
                if (nextArmed && !armed) onArmed()
                armed = nextArmed
            }
        } finally {
            gesture.cancel()
            onProgress(0f)
        }
    }
}
