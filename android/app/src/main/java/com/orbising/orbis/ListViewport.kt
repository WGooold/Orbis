package com.orbising.orbis

import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.runtime.snapshots.Snapshot
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.dp

private class ViewportItems<T> { var items: List<T>? = null }
private class ViewportKeys { var keys: List<String> = emptyList() }

/** Settle catalog structure after the native drag and fling, without cancelling either. */
@Composable
internal fun <T> rememberViewportItems(items: List<T>, state: LazyListState, identity: Any?): List<T> {
    val shown = remember(identity) { ViewportItems<T>() }
    if (!state.isScrollInProgress || shown.items == null) shown.items = items
    return shown.items!!
}

/** Runs before this composition is measured, so no intermediate jump is published. */
@Composable
internal fun maintainListViewport(state: LazyListState, keys: List<String>, identity: Any?) {
    val shown = remember(identity) { ViewportKeys() }
    val slop = with(LocalDensity.current) { 8.dp.roundToPx() }
    if (shown.keys == keys) return
    val previous = shown.keys
    shown.keys = keys
    Snapshot.withoutReadObservation {
        if (previous.isEmpty() || keys.isEmpty() || state.isScrollInProgress) return@withoutReadObservation
        val index = state.firstVisibleItemIndex
        val offset = state.firstVisibleItemScrollOffset
        if (index == 0 && offset <= slop) {
            state.requestScrollToItem(0, 0)
        } else {
            val layout = state.layoutInfo
            val anchor = layout.visibleItemsInfo.firstOrNull {
                it.size > 0 && it.offset >= layout.viewportStartOffset && it.offset + it.size <= layout.viewportEndOffset
            }
            val anchorIndex = anchor?.index ?: index
            // LazyList item offsets already exclude content padding. Subtracting the
            // viewport start again would add that padding on every catalog update.
            val anchorOffset = anchor?.let { -it.offset } ?: offset
            val special = homeViewportTarget(previous, keys, anchorIndex, anchorOffset, slop)
            val target = special ?: previous.getOrNull(anchorIndex)?.let(keys::indexOf)?.takeIf { it >= 0 }?.let { it to anchorOffset }
            target?.let { state.requestScrollToItem(it.first, it.second) }
        }
    }
}
