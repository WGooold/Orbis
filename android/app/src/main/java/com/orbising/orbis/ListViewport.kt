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
internal fun maintainListViewport(state: LazyListState, keys: List<String>, identity: Any?, preserveStationaryItems: Boolean = false) {
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
            val fullyVisible = layout.visibleItemsInfo.filter {
                it.size > 0 && it.offset >= layout.viewportStartOffset && it.offset + it.size <= layout.viewportEndOffset
            }
            val positions = if (preserveStationaryItems) keys.withIndex().associate { it.value to it.index } else emptyMap()
            // A promoted branch can be the first visible item. Hold the next stationary
            // row instead: keeping its old numeric slot shifts all following rows when
            // expanded and collapsed branches have different heights.
            val stationary = if (preserveStationaryItems) fullyVisible.firstOrNull { item ->
                val key = item.key as? String
                val oldIndex = key?.let(previous::indexOf) ?: -1
                val newIndex = positions[key]
                item.contentType != "gap" && oldIndex >= 0 && newIndex != null && previous.take(oldIndex).none { (positions[it] ?: -1) > newIndex }
            } else null
            val anchor = stationary ?: fullyVisible.firstOrNull()
            // layoutInfo can still describe the preceding measured catalog while an async
            // drawer projection has already recomposed. Its key remains authoritative; its
            // index must never be used to index a newer key list.
            val anchorKey = anchor?.key as? String
            val anchorIndex = anchorKey?.let(previous::indexOf)?.takeIf { it >= 0 } ?: index
            // LazyList item offsets already exclude content padding. Subtracting the
            // viewport start again would add that padding on every catalog update.
            val anchorOffset = anchor?.let { -it.offset } ?: offset
            val special = if (stationary != null) null else homeViewportTarget(previous, keys, anchorIndex, anchorOffset, slop)
            val target = special ?: (anchorKey ?: previous.getOrNull(anchorIndex))?.let(keys::indexOf)?.takeIf { it >= 0 }?.let { it to anchorOffset }
            target?.let { state.requestScrollToItem(it.first, it.second) }
        }
    }
}
