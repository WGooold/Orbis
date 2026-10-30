package com.orbising.orbis

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.pager.HorizontalPager
import androidx.compose.foundation.pager.rememberPagerState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.launch

@Composable
internal fun ChangeFileName(name: String, modifier: Modifier = Modifier) {
    val style = MaterialTheme.typography.bodySmall
    val measurer = rememberTextMeasurer()
    val density = LocalDensity.current
    BoxWithConstraints(modifier.clearAndSetSemantics { contentDescription = name }) {
        val width = with(density) { maxWidth.roundToPx() }
        val display = remember(name, width, style, density.fontScale) {
            elideChangeFileName(name) { measurer.measure(it, style, softWrap = false, maxLines = 1).size.width <= width }
        }
        // Native wrapping is the accessible fallback when even the extension cannot fit.
        Text(display, style = style, softWrap = true)
    }
}

internal fun changeScopeLabel(scope: String) = when (scope) {
    "git-visible-files" -> "已跟踪及非忽略文件"
    "bounded-directory" -> "当前目录（已排除缓存）"
    else -> "记录范围未确认"
}

private fun changeKindLabel(kind: String) = when (kind) {
    "added" -> "新增"; "deleted" -> "删除"; "renamed" -> "重命名"; "type-changed" -> "类型变化"; "modified" -> "修改"; else -> "未知"
}

@Composable
private fun ChangeCounts(additions: Long?, deletions: Long?) {
    Text("+${additions ?: "?"}  −${deletions ?: "?"}", style = MaterialTheme.typography.bodySmall,
        fontFamily = FontFamily.Monospace, color = MaterialTheme.colorScheme.onSurfaceVariant)
}

@Composable
private fun ChangeFileRow(file: FileChangeMetadata, enabled: Boolean, onClick: () -> Unit) {
    Row(Modifier.fillMaxWidth().clickable(enabled = enabled, onClick = onClick).heightIn(min = RemoteUi.TouchTarget)
        .padding(vertical = 6.dp).testTag("change-file-${file.fileId}"), verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            ChangeFileName(file.path, Modifier.fillMaxWidth())
            if (file.oldPath != null) Text("原路径 ${file.oldPath}", style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant)
            Text(changeKindLabel(file.changeKind), style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        ChangeCounts(file.additions, file.deletions)
        Icon(Icons.Rounded.ChevronRight, contentDescription = null, modifier = Modifier.size(18.dp))
    }
}

/** Compact turn-end attachment. Expanding it fetches metadata only. */
@Composable
internal fun TurnChangeSummaryView(
    summary: TurnChangeSummary, manifest: ChangeManifest, canRead: Boolean,
    onReadManifest: () -> Unit, onOpenFile: (FileChangeMetadata) -> Unit,
) {
    var expanded by rememberSaveable(summary.changeSetId) { mutableStateOf(false) }
    Column(Modifier.fillMaxWidth().testTag("turn-file-changes-${summary.reviewTurnId}"), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.5f))
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(when (summary.state) {
                "collecting", "finalizing" -> "正在统计文件变化"
                "unavailable" -> "本轮文件变化未记录"
                else -> "${summary.fileCount ?: "?"} 个文件变化"
            }, Modifier.weight(1f), style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.Medium)
            if (summary.state == "ready") ChangeCounts(summary.additions, summary.deletions)
        }
        if (summary.state == "ready") {
            Text("新增 ${summary.addedFiles ?: "?"}  修改 ${summary.modifiedFiles ?: "?"}  删除 ${summary.deletedFiles ?: "?"}",
                style = MaterialTheme.typography.bodySmall, fontFamily = FontFamily.Monospace,
                color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        if (summary.coverage != "complete") Text(if (summary.coverage == "partial") "仅记录部分变化" else "无法确认轮次前后版本",
            style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
        Text(changeScopeLabel(summary.scope), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Text("含同期工作区修改，归属未确认", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        if (summary.reasons.isNotEmpty()) Text(summary.reasons.map(::changeCoverageReason).distinct().joinToString("、"),
            style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        manifest.files.take(4).forEach { file -> ChangeFileRow(file, canRead) { onOpenFile(file) } }
        if ((summary.fileCount ?: 0) > 4) {
            NeumorphTextButton(if (expanded) "收起文件清单" else "查看全部文件", onClick = {
                expanded = !expanded
                if (expanded && !manifest.loaded) onReadManifest()
            }, enabled = canRead, modifier = Modifier.fillMaxWidth())
            OrbisCollapse(expanded) {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    LazyColumn(Modifier.fillMaxWidth().heightIn(max = 320.dp)) {
                        itemsIndexed(manifest.files.drop(4), key = { _, file -> file.fileId }) { _, file ->
                            ChangeFileRow(file, canRead) { onOpenFile(file) }
                        }
                    }
                    if (!manifest.complete || manifest.error != null) NeumorphTextButton(
                        if (manifest.requestId != null) "正在读取清单…" else if (manifest.error != null) "重试读取清单" else "加载更多文件",
                        onClick = onReadManifest, enabled = canRead && manifest.requestId == null, modifier = Modifier.fillMaxWidth())
                    manifest.error?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
                }
            }
        }
        manifest.files.firstOrNull()?.let { first ->
            NeumorphActionButton(text = "查看详情", icon = Icons.Rounded.FindInPage, onClick = { onOpenFile(first) },
                modifier = Modifier.fillMaxWidth(), enabled = canRead)
        }
    }
}

internal fun changeCoverageReason(reason: String): String = when {
    reason.contains("late") || reason.contains("boundary") -> "接入时未取得可靠起点"
    reason.contains("limit") || reason.contains("budget") || reason.contains("timeout") -> "部分文件超过采集预算"
    reason.contains("concurrent") -> "期间可能有并发修改"
    reason.contains("restart") -> "电脑端重启中断了采集"
    reason.contains("mapping") -> "无法确认工作区路径映射"
    reason.contains("unreadable") || reason.contains("read") -> "部分文件无法读取"
    else -> "部分文件或时间范围未被完整捕获"
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun FileChangeViewerSheet(
    viewer: FileChangeViewer, manifest: ChangeManifest,
    onClose: () -> Unit, onSelectFile: (String) -> Unit, onReadDetail: () -> Unit,
    onReadManifest: () -> Unit, onPosition: (String, Int, Int) -> Unit,
) {
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    val currentOnClose by rememberUpdatedState(onClose)
    val currentOnSelect by rememberUpdatedState(onSelectFile)
    DisposableEffect(lifecycle, viewer.summary.versionKey) {
        val observer = LifecycleEventObserver { _, event -> if (event == Lifecycle.Event.ON_STOP) currentOnClose() }
        lifecycle.addObserver(observer)
        onDispose { lifecycle.removeObserver(observer) }
    }
    val files = manifest.files
    if (files.isEmpty()) return
    val pager = rememberPagerState(initialPage = files.indexOfFirst { it.fileId == viewer.selectedFileId }.coerceAtLeast(0)) { files.size }
    val currentFiles by rememberUpdatedState(files)
    val scope = rememberCoroutineScope()
    // Pager composes neighboring placeholders; only this settled selection can issue detail reads.
    LaunchedEffect(pager, viewer.summary.versionKey) {
        snapshotFlow { pager.settledPage to pager.isScrollInProgress }.distinctUntilChanged().collect { (page, scrolling) ->
            if (!scrolling) currentFiles.getOrNull(page)?.let { currentOnSelect(it.fileId) }
        }
    }
    ModalBottomSheet(onDismissRequest = onClose,
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true), dragHandle = null,
        modifier = Modifier.fillMaxHeight(0.96f).testTag("file-change-viewer"),
        containerColor = MaterialTheme.colorScheme.background, tonalElevation = 0.dp) {
        Column(Modifier.fillMaxWidth().weight(1f).navigationBarsPadding().padding(top = 20.dp, bottom = 12.dp)) {
            Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp), verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                NeumorphIconButton(onClick = onClose, icon = Icons.Rounded.Close, contentDescription = "关闭文件差异")
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Text("本轮文件差异", style = MaterialTheme.typography.titleLarge)
                    ChangeFileName(files.getOrNull(pager.settledPage)?.path.orEmpty(), Modifier.fillMaxWidth())
                }
                Text("${pager.settledPage + 1}/${summaryCount(manifest)}", style = MaterialTheme.typography.bodySmall, fontFamily = FontFamily.Monospace)
            }
            Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp), verticalAlignment = Alignment.CenterVertically) {
                NeumorphIconButton(onClick = { scope.launch { pager.animateScrollToPage(pager.settledPage - 1) } }, icon = Icons.Rounded.ChevronLeft,
                    contentDescription = "上一个文件", enabled = pager.settledPage > 0)
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Text("左右滑动切换文件", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    Text(changeScopeLabel(viewer.summary.scope), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                NeumorphIconButton(onClick = { scope.launch { pager.animateScrollToPage(pager.settledPage + 1) } }, icon = Icons.Rounded.ChevronRight,
                    contentDescription = "下一个文件", enabled = pager.settledPage < files.lastIndex)
            }
            HorizontalPager(state = pager, key = { files[it].fileId }, beyondViewportPageCount = 0,
                modifier = Modifier.fillMaxWidth().weight(1f).testTag("file-change-pager")) { index ->
                val file = files[index]
                FileDiffPage(file, viewer.cache[file.fileId], selected = !pager.isScrollInProgress &&
                    index == pager.settledPage && file.fileId == viewer.selectedFileId,
                    onRead = onReadDetail, onPosition = { line, offset -> onPosition(file.fileId, line, offset) })
            }
            if (!manifest.complete || manifest.error != null) {
                NeumorphTextButton(if (manifest.requestId != null) "正在读取文件清单…" else "加载更多文件",
                    onClick = onReadManifest, enabled = manifest.requestId == null,
                    modifier = Modifier.fillMaxWidth().padding(horizontal = 20.dp))
                manifest.error?.let { Text(it, Modifier.padding(horizontal = 20.dp), color = MaterialTheme.colorScheme.error,
                    style = MaterialTheme.typography.bodySmall) }
            }
        }
    }
}
private fun summaryCount(manifest: ChangeManifest) = manifest.summary.fileCount?.toString() ?: manifest.files.size.toString()

@Composable
private fun FileDiffPage(file: FileChangeMetadata, cache: FileDiffCache?, selected: Boolean, onRead: () -> Unit, onPosition: (Int, Int) -> Unit) {
    val rows = remember(cache?.text, cache?.eof) { unifiedDiffLines(cache?.text.orEmpty(), cache?.eof == true) }
    val gutterDigits = remember(rows) { maxOf(2, rows.maxOfOrNull { maxOf(it.oldLine ?: 0, it.newLine ?: 0) }?.toString()?.length ?: 2) }
    val gutterWidth = with(LocalDensity.current) { MaterialTheme.typography.bodySmall.fontSize.toDp() * (gutterDigits * 0.65f) + 6.dp }
    val state = remember(file.fileId) { LazyListState(cache?.scrollIndex ?: 0, cache?.scrollOffset ?: 0) }
    val currentOnPosition by rememberUpdatedState(onPosition)
    DisposableEffect(state, file.fileId) { onDispose { currentOnPosition(state.firstVisibleItemIndex, state.firstVisibleItemScrollOffset) } }
    LaunchedEffect(state, file.fileId) {
        snapshotFlow { state.firstVisibleItemIndex to state.firstVisibleItemScrollOffset }.distinctUntilChanged().collect { (index, offset) ->
            currentOnPosition(index, offset)
        }
    }
    // One bounded range when the reader scrolls near the tail. No composition-triggered neighbor reads.
    LaunchedEffect(state, selected, cache?.nextCursor, cache?.requestId, cache?.error) {
        if (selected && cache?.loaded == true && !cache.eof && cache.requestId == null && cache.error == null) {
            snapshotFlow { state.isScrollInProgress && (state.layoutInfo.visibleItemsInfo.lastOrNull()?.index ?: -1) >= rows.lastIndex - 4 }
                .distinctUntilChanged().collect { nearEnd -> if (nearEnd) onRead() }
        }
    }
    Column(Modifier.fillMaxSize().padding(horizontal = 16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Text(changeKindLabel(file.changeKind), Modifier.weight(1f), style = MaterialTheme.typography.bodySmall)
            ChangeCounts(file.additions, file.deletions)
        }
        NeumorphSurface(Modifier.fillMaxWidth().weight(1f), style = NeumorphStyle.Pressed,
            shape = RemoteUi.ControlShape, shadowScale = 0.4f) {
            if (rows.isEmpty()) Box(Modifier.fillMaxSize().padding(16.dp), contentAlignment = Alignment.Center) {
                Text(when {
                    file.detail != "available" -> changeFailureText(file.detail)
                    cache?.requestId != null -> "正在读取差异…"
                    cache?.loaded == true && cache.eof -> "没有文本差异"
                    else -> "停留在此文件后读取差异"
                }, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            } else LazyColumn(state = state, modifier = Modifier.fillMaxSize().testTag("file-diff-lines-${file.fileId}"), contentPadding = PaddingValues(vertical = 12.dp)) {
                itemsIndexed(rows, key = { index, _ -> index }) { _, line -> DiffLineRow(line, gutterWidth) }
            }
        }
        Box(Modifier.fillMaxWidth().heightIn(min = RemoteUi.FieldHeight), contentAlignment = Alignment.Center) {
            when {
                cache?.error != null -> Column {
                    Text(cache.error, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
                    if (file.detail == "available" && !cache.error.contains("显示上限")) NeumorphTextButton("重新读取", onClick = onRead, enabled = selected)
                }
                cache?.requestId != null -> CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp)
                cache?.loaded == true && !cache.eof -> NeumorphTextButton("读取下一段差异", onClick = onRead, enabled = selected)
                cache?.eof == true -> Text("已读取全部差异", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
    }
}

@Composable
private fun DiffLineRow(line: UnifiedDiffLine, gutterWidth: androidx.compose.ui.unit.Dp) {
    val added = Color(0xFF257D4F)
    val deleted = MaterialTheme.colorScheme.error
    val tint = when (line.kind) { "addition" -> added.copy(alpha = 0.12f); "deletion" -> deleted.copy(alpha = 0.10f);
        "hunk" -> MaterialTheme.colorScheme.primary.copy(alpha = 0.08f); else -> Color.Transparent }
    Row(Modifier.fillMaxWidth().background(tint).padding(horizontal = 8.dp, vertical = 2.dp), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        Text(if (line.continuation) "↳" else line.oldLine?.toString().orEmpty(), Modifier.width(gutterWidth), style = MaterialTheme.typography.bodySmall,
            fontFamily = FontFamily.Monospace, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Text(if (line.continuation) "" else line.newLine?.toString().orEmpty(), Modifier.width(gutterWidth), style = MaterialTheme.typography.bodySmall,
            fontFamily = FontFamily.Monospace, color = MaterialTheme.colorScheme.onSurfaceVariant)
        SelectionContainer(Modifier.weight(1f)) { Text(line.text, style = MaterialTheme.typography.bodySmall, fontFamily = FontFamily.Monospace,
            color = when (line.kind) { "hunk" -> MaterialTheme.colorScheme.primary; else -> MaterialTheme.colorScheme.onSurface }) }
    }
}
