package com.orbising.orbis

import androidx.compose.runtime.snapshotFlow
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
