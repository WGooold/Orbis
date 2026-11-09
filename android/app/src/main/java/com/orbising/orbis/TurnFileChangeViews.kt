package com.orbising.orbis

import com.orbising.orbis.OrbisBottomSheet as ModalBottomSheet

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.Orientation
import androidx.compose.foundation.gestures.draggable
import androidx.compose.foundation.gestures.rememberDraggableState
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.pager.HorizontalPager
import androidx.compose.foundation.pager.rememberPagerState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.input.nestedscroll.NestedScrollConnection
import androidx.compose.ui.input.nestedscroll.NestedScrollSource
import androidx.compose.ui.input.nestedscroll.nestedScroll
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Velocity
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
    "native-file-tools" -> L10n.tr("Codex 文件工具")
    "git-visible-files" -> L10n.tr("已跟踪及非忽略文件")
    "bounded-directory" -> L10n.tr("当前目录（已排除缓存）")
    else -> L10n.tr("记录范围未确认")
}

private fun changeKindLabel(kind: String) = when (kind) {
    "added" -> L10n.tr("新增"); "deleted" -> L10n.tr("删除"); "renamed" -> L10n.tr("重命名"); "type-changed" -> L10n.tr("类型变化"); "modified" -> L10n.tr("修改"); else -> L10n.tr("未知")
}

/** Only known numbers; files without text counts show a short status instead of "+? −?". */
@Composable
private fun ChangeCounts(additions: Long?, deletions: Long?, status: String? = "—") {
    val muted = MaterialTheme.colorScheme.onSurfaceVariant
    val style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace)
    Row(horizontalArrangement = Arrangement.spacedBy(5.dp)) {
        if (additions == null && deletions == null) {
            status?.let { Text(it, style = style, color = muted) }
        } else {
            if (additions != null && (additions > 0 || (deletions ?: 0) == 0L)) Text("+$additions", style = style, color = MaterialTheme.colorScheme.tertiary)
            if (deletions != null && deletions > 0) Text("−$deletions", style = style, color = MaterialTheme.colorScheme.error)
        }
    }
}

internal fun changeShortStatus(detail: String) = when (detail) {
    "binary" -> L10n.tr("二进制"); "too-large" -> L10n.tr("过大"); "unsupported" -> L10n.tr("不支持"); "not-captured" -> L10n.tr("未保存"); "busy" -> L10n.tr("未统计"); else -> "—"
}

@Composable
private fun changeModifiedColor(): Color =
    if (MaterialTheme.colorScheme.background.luminance() < 0.5f) Color(0xFFF2C26B) else Color(0xFF9A5B00)

/** Git-style status letter; TalkBack reads the Chinese kind. */
@Composable
private fun ChangeKindLetter(kind: String) {
    val (letter, tint) = when (kind) {
        "added" -> "A" to MaterialTheme.colorScheme.tertiary
        "deleted" -> "D" to MaterialTheme.colorScheme.error
        "modified" -> "M" to changeModifiedColor()
        "renamed" -> "R" to MaterialTheme.colorScheme.primary
        "type-changed" -> "T" to changeModifiedColor()
        else -> "?" to MaterialTheme.colorScheme.onSurfaceVariant
    }
    Box(Modifier.size(18.dp).background(tint.copy(alpha = 0.14f), RoundedCornerShape(5.dp))
        .clearAndSetSemantics { contentDescription = changeKindLabel(kind) }, contentAlignment = Alignment.Center) {
        Text(letter, style = MaterialTheme.typography.labelSmall, fontFamily = FontFamily.Monospace, fontWeight = FontWeight.Bold, color = tint)
    }
}

@Composable
private fun ChangeHairline() = HorizontalDivider(thickness = 0.5.dp, color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.14f))

/** Name first (middle-elided, extension kept), then the nearest directories, then counts. */
@Composable
private fun ChangeFileRow(file: FileChangeMetadata, enabled: Boolean, onClick: () -> Unit) {
    Row(Modifier.fillMaxWidth().orbisKeyboardFocus().clickable(enabled = enabled, onClick = onClick).heightIn(min = 40.dp)
        .testTag("change-file-${file.fileId}"), verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        ChangeKindLetter(file.changeKind)
        ChangeFileNameWithDirectory(file.path, Modifier.weight(1f))
        ChangeCounts(file.additions, file.deletions, changeShortStatus(file.detail))
    }
}

/** The directory never squeezes the name: full directory, then its nearest segment, then hidden. */
@Composable
private fun ChangeFileNameWithDirectory(path: String, modifier: Modifier = Modifier) {
    val nameStyle = MaterialTheme.typography.bodySmall
    val directoryStyle = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace)
    val measurer = rememberTextMeasurer()
    val density = LocalDensity.current
    val name = path.substringAfterLast('/').substringAfterLast('\\')
    val directory = path.dropLast(name.length).trimEnd('/', '\\')
    BoxWithConstraints(modifier) {
        val width = with(density) { maxWidth.roundToPx() }
        val gap = with(density) { 8.dp.roundToPx() }
        val shown = remember(path, width, nameStyle, density.fontScale) {
            val nearest = directory.substringAfterLast('/').let { if (it == directory) it else "…/$it" }
            val nameWidth = measurer.measure(name, nameStyle, softWrap = false, maxLines = 1).size.width
            listOf(directory, nearest).filter { it.isNotEmpty() }.distinct().firstOrNull {
                nameWidth + gap + measurer.measure(it, directoryStyle, softWrap = false, maxLines = 1).size.width <= width
            }
        }
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            ChangeFileName(path, Modifier.weight(1f, fill = false))
            shown?.let { Text(it, style = directoryStyle, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, softWrap = false) }
        }
    }
}

/**
 * Turn-end summary, styled like the transcript's tool disclosures: one recessed block whose header
 * opens the viewer, one compact line per file, and a single caveat line when needed. Expanding
 * fetches metadata only.
 */
@Composable
internal fun TurnChangeSummaryView(
    summary: TurnChangeSummary, manifest: ChangeManifest, canRead: Boolean,
    onReadManifest: () -> Unit, onOpenFile: (FileChangeMetadata) -> Unit,
) {
    var expanded by rememberSaveable(summary.changeSetId) { mutableStateOf(false) }
    var openActivation by remember { mutableStateOf(0) }
    var expandActivation by remember { mutableStateOf(0) }
    val ready = summary.state == "ready"
    val count = summary.fileCount?.toInt() ?: manifest.files.size
    val files = if (!ready) emptyList() else if (expanded) manifest.files else manifest.files.take(4)
    val pending = summary.state == "collecting" || summary.state == "finalizing"
    val muted = MaterialTheme.colorScheme.onSurfaceVariant
    val opens = ready && files.isNotEmpty()
    val title = when {
        pending -> L10n.tr("正在统计文件变化")
        summary.state == "unavailable" -> L10n.tr("本轮文件变化未记录")
        count == 0 -> if (summary.coverage == "complete") L10n.tr("本轮没有文件变化") else L10n.tr("未发现文件变化")
        else -> L10n.tr("{0} 个文件已更改", count)
    }
    val caveat = turnChangeCoverageNote(summary)
    Column(Modifier.fillMaxWidth().testTag("turn-file-changes-${summary.reviewTurnId}"), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        NeumorphSurface(Modifier.fillMaxWidth(), style = NeumorphStyle.Pressed, shape = RemoteUi.ControlShape, shadowScale = 0.5f) {
            Column(Modifier.padding(horizontal = 12.dp, vertical = 2.dp)) {
                Row(Modifier.fillMaxWidth().heightIn(min = 44.dp)
                    .then(if (opens) Modifier.orbisKeyboardFocus().clickable(enabled = canRead) { openActivation++; onOpenFile(files.first()) }
                        .semantics { contentDescription = L10n.tr("查看详情，{0}", title) } else Modifier)
                    .testTag("turn-changes-open-${summary.reviewTurnId}"),
                    verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Icon(if (summary.state == "unavailable") OrbisSymbols.Error else OrbisSymbols.Description,
                        contentDescription = null, tint = muted, modifier = Modifier.size(17.dp).actionGlyphMotion(openActivation))
                    Row(Modifier.weight(1f), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Text(title, style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.Medium,
                            color = if (opens) MaterialTheme.colorScheme.onSurface else muted, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        if (pending) CircularProgressIndicator(Modifier.size(12.dp), strokeWidth = 1.5.dp, color = muted)
                    }
                    if (opens) {
                        ChangeCounts(summary.additions, summary.deletions, status = null)
                        Icon(OrbisSymbols.ChevronRight, contentDescription = null, tint = muted, modifier = Modifier.size(18.dp).actionGlyphMotion(openActivation))
                    }
                }
                files.forEach { file -> ChangeHairline(); ChangeFileRow(file, canRead) { onOpenFile(file) } }
                if (ready && count > 4) {
                    ChangeHairline()
                    Row(Modifier.fillMaxWidth().heightIn(min = 40.dp).orbisKeyboardFocus().clickable(enabled = canRead) {
                        expandActivation++
                        expanded = !expanded
                        if (expanded && !manifest.loaded) onReadManifest()
                    }, verticalAlignment = Alignment.CenterVertically) {
                        Text(if (expanded) L10n.tr("收起") else L10n.tr("还有 {0} 个文件", count - 4), Modifier.weight(1f),
                            style = MaterialTheme.typography.bodySmall, color = muted)
                        if (manifest.requestId != null) CircularProgressIndicator(Modifier.size(12.dp), strokeWidth = 1.5.dp, color = muted)
                        Icon(if (expanded) Icons.Rounded.ExpandLess else OrbisSymbols.KeyboardArrowDown, contentDescription = null,
                            tint = muted, modifier = Modifier.size(18.dp).actionGlyphMotion(expandActivation))
                    }
                }
                if (expanded && manifest.requestId == null && (manifest.loaded && !manifest.complete || manifest.error != null)) {
                    ChangeHairline()
                    Text(if (manifest.error != null) L10n.tr("重新读取文件清单") else L10n.tr("加载更多文件"),
                        Modifier.fillMaxWidth().orbisKeyboardFocus().clickable(enabled = canRead, onClick = onReadManifest).heightIn(min = 40.dp)
                            .wrapContentHeight(Alignment.CenterVertically),
                        style = MaterialTheme.typography.bodySmall,
                        color = if (manifest.error != null) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.primary)
                }
            }
        }
        if (caveat.isNotEmpty()) Row(Modifier.padding(horizontal = 4.dp), verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            Icon(Icons.Rounded.WarningAmber, contentDescription = null, tint = changeModifiedColor(), modifier = Modifier.size(14.dp))
            Text(caveat, style = MaterialTheme.typography.bodySmall, color = changeModifiedColor())
        }
    }
}

/**
 * Diff reading never moves the sheet: whatever vertical scroll or fling the body leaves over
 * (pulling past the diff's top, a fling that hits it) stops here instead of reaching the sheet.
 */
private object DiffBodyOwnsVerticalScroll : NestedScrollConnection {
    override fun onPostScroll(consumed: Offset, available: Offset, source: NestedScrollSource) = Offset(0f, available.y)
    override suspend fun onPostFling(consumed: Velocity, available: Velocity) = Velocity(0f, available.y)
}

/** Only the header (handle, title, ×) drags the sheet closed; see [DiffBodyOwnsVerticalScroll]. */
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
    val currentFiles by rememberUpdatedState(files)
    val pager = rememberPagerState(initialPage = files.indexOfFirst { it.fileId == viewer.selectedFileId }.coerceAtLeast(0)) { currentFiles.size }
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
        val closeSheet = sheetCloseAction(onClose)
        Column(Modifier.fillMaxWidth().weight(1f).navigationBarsPadding().padding(bottom = 8.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Column(Modifier.fillMaxWidth().testTag("file-change-header")) {
                Box(Modifier.align(Alignment.CenterHorizontally).padding(top = 10.dp).size(40.dp, 5.dp)
                    .background(MaterialTheme.colorScheme.outlineVariant, CircleShape))
                Row(Modifier.fillMaxWidth().padding(start = 16.dp, end = 16.dp, top = 8.dp, bottom = 4.dp),
                    verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    NeumorphIconButton(onClick = closeSheet, icon = OrbisSymbols.Close, contentDescription = L10n.tr("关闭文件差异"))
                    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                        Text(L10n.tr("本轮文件差异"), style = MaterialTheme.typography.titleLarge, maxLines = 1)
                        Text(changeScopeLabel(viewer.summary.scope), style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1)
                    }
                }
            }
            // Pager can remeasure after its count changes but before its retained key/content
            // callbacks are replaced. All three must read the same current manifest, not a
            // captured four-file preview that a first metadata page has already outgrown.
            HorizontalPager(state = pager, key = { currentFiles.getOrNull(it)?.fileId ?: it }, beyondViewportPageCount = 0,
                modifier = Modifier.fillMaxWidth().weight(1f).nestedScroll(DiffBodyOwnsVerticalScroll)
                    .draggable(rememberDraggableState {}, Orientation.Vertical).testTag("file-change-pager")) { index ->
                val file = currentFiles.getOrNull(index) ?: return@HorizontalPager
                FileDiffPage(file, viewer.cache[file.fileId], selected = !pager.isScrollInProgress &&
                    index == pager.settledPage && file.fileId == viewer.selectedFileId,
                    onRead = onReadDetail, onPosition = { line, offset -> onPosition(file.fileId, line, offset) })
            }
            Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp), verticalAlignment = Alignment.CenterVertically) {
                NeumorphIconButton(onClick = { scope.launch { pager.animateScrollToPage(pager.settledPage - 1) } }, icon = Icons.Rounded.ChevronLeft,
                    contentDescription = L10n.tr("上一个文件"), enabled = pager.settledPage > 0)
                Text("${pager.settledPage + 1} / ${summaryCount(manifest)}", Modifier.weight(1f).testTag("file-change-page"),
                    style = MaterialTheme.typography.labelLarge, fontFamily = FontFamily.Monospace,
                    color = MaterialTheme.colorScheme.onSurfaceVariant, textAlign = TextAlign.Center)
                NeumorphIconButton(onClick = { scope.launch { pager.animateScrollToPage(pager.settledPage + 1) } }, icon = OrbisSymbols.ChevronRight,
                    contentDescription = L10n.tr("下一个文件"), enabled = pager.settledPage < files.lastIndex)
            }
            if (!manifest.complete || manifest.error != null) {
                NeumorphTextButton(if (manifest.requestId != null) L10n.tr("正在读取文件清单…") else L10n.tr("加载更多文件"),
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
private fun ChangeKindBadge(kind: String) {
    val tint = when (kind) {
        "added" -> MaterialTheme.colorScheme.tertiary; "deleted" -> MaterialTheme.colorScheme.error
        "renamed" -> MaterialTheme.colorScheme.primary; "unknown" -> MaterialTheme.colorScheme.onSurfaceVariant
        else -> changeModifiedColor()
    }
    Text(changeKindLabel(kind), Modifier.background(tint.copy(alpha = 0.14f), CircleShape).padding(horizontal = 8.dp, vertical = 2.dp),
        style = MaterialTheme.typography.labelSmall, fontWeight = FontWeight.SemiBold, color = tint)
}

/** Name, kind and counts slide with their page, so a settled swipe never relabels the previous file. */
@Composable
private fun DiffFileHeader(file: FileChangeMetadata) {
    val name = file.path.substringAfterLast('/').substringAfterLast('\\')
    val directory = file.path.dropLast(name.length)
    Column(Modifier.fillMaxWidth().padding(horizontal = 4.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            ChangeKindBadge(file.changeKind)
            ChangeFileName(file.path, Modifier.weight(1f))
            ChangeCounts(file.additions, file.deletions, changeShortStatus(file.detail))
        }
        if (directory.isNotEmpty()) Text(directory, style = MaterialTheme.typography.bodySmall, fontFamily = FontFamily.Monospace,
            color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
        if (file.oldPath != null) Text(L10n.tr("原路径 {0}", file.oldPath), style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

@Composable
private fun FileDiffPage(file: FileChangeMetadata, cache: FileDiffCache?, selected: Boolean, onRead: () -> Unit, onPosition: (Int, Int) -> Unit) {
    val projection = cache?.projection ?: UnifiedDiffProjection.EMPTY
    val rows = projection.lines
    val gutterDigits = projection.gutterDigits
    val gutterWidth = with(LocalDensity.current) { MaterialTheme.typography.bodySmall.fontSize.toDp() * (gutterDigits * 0.62f) }
    val state = remember(file.fileId) { LazyListState(cache?.scrollIndex ?: 0, cache?.scrollOffset ?: 0) }
    val diffRows = remember(rows) { rows.indices.filter { rows[it].kind in setOf("addition", "deletion", "context") } }
    val visibleDiffPosition by remember(state, diffRows) {
        derivedStateOf {
            val visibleIndex = state.layoutInfo.visibleItemsInfo.firstOrNull { diffRows.binarySearch(it.index) >= 0 }?.index
            visibleIndex?.let { diffRows.binarySearch(it).let { position -> if (position >= 0) position + 1 else null } }
        }
    }
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
    Column(Modifier.fillMaxSize().padding(horizontal = 16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        DiffFileHeader(file)
        if (visibleDiffPosition != null && diffRows.isNotEmpty()) {
            val position = L10n.tr("差异行 {0} / {1}", visibleDiffPosition, diffRows.size)
            Text(if (cache?.eof == false) L10n.tr("{0}（已读取）", position) else position,
                Modifier.fillMaxWidth().testTag("file-diff-position"), style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant, textAlign = TextAlign.End, maxLines = 1)
        }
        NeumorphSurface(Modifier.fillMaxWidth().weight(1f), style = NeumorphStyle.Pressed,
            shape = RemoteUi.ControlShape, shadowScale = 0.4f) {
            if (rows.isEmpty()) Box(Modifier.fillMaxSize().padding(16.dp), contentAlignment = Alignment.Center) {
                Text(when {
                    file.detail != "available" -> changeFailureText(file.detail)
                    cache?.requestId != null -> L10n.tr("正在读取差异…")
                    cache?.loaded == true && cache.eof -> L10n.tr("没有文本差异")
                    else -> L10n.tr("停留在此文件后读取差异")
                }, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            } else LazyColumn(state = state, modifier = Modifier.fillMaxSize().testTag("file-diff-lines-${file.fileId}"), contentPadding = PaddingValues(vertical = 8.dp)) {
                itemsIndexed(rows, key = { index, _ -> index }) { _, line -> DiffLineRow(line, gutterWidth) }
            }
        }
        Box(Modifier.fillMaxWidth().heightIn(min = RemoteUi.FieldHeight), contentAlignment = Alignment.Center) {
            when {
                cache?.error != null -> Column {
                    Text(cache.error, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
                    if (file.detail == "available" && !L10n.matches(cache.error, "已读取差异达到 2 MiB 显示上限")) NeumorphTextButton(L10n.tr("重新读取"), onClick = onRead, enabled = selected)
                }
                cache?.requestId != null -> CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp)
                cache?.loaded == true && !cache.eof -> NeumorphTextButton(L10n.tr("读取下一段差异"), onClick = onRead, enabled = selected)
                cache?.eof == true -> Text(L10n.tr("已读取全部差异"), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
    }
}

/** Git-style row: old / new numbers, a +/− marker column and the line body; headers span the row. */
@Composable
private fun DiffLineRow(line: UnifiedDiffLine, gutterWidth: androidx.compose.ui.unit.Dp) {
    val tint = when (line.kind) { "addition" -> MaterialTheme.colorScheme.tertiary; "deletion" -> MaterialTheme.colorScheme.error; else -> null }
    val style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace)
    val muted = MaterialTheme.colorScheme.onSurfaceVariant
    if (line.kind == "hunk" || line.kind == "header") {
        val hunk = line.kind == "hunk"
        Text(line.text, Modifier.fillMaxWidth().padding(vertical = if (hunk) 4.dp else 0.dp)
            .background(if (hunk) MaterialTheme.colorScheme.primary.copy(alpha = 0.08f) else Color.Transparent)
            .padding(horizontal = 10.dp, vertical = if (hunk) 4.dp else 1.dp),
            style = style, color = if (hunk) MaterialTheme.colorScheme.primary else muted)
        return
    }
    val marked = !line.continuation
    Row(Modifier.fillMaxWidth().background(tint?.copy(alpha = if (line.kind == "addition") 0.12f else 0.10f) ?: Color.Transparent)
        .padding(start = 4.dp, end = 10.dp, top = 1.dp, bottom = 1.dp)) {
        Text(if (marked) line.oldLine?.toString().orEmpty() else "", Modifier.width(gutterWidth), style = style, color = muted, textAlign = TextAlign.End)
        Text(if (marked) line.newLine?.toString().orEmpty() else "", Modifier.padding(start = 6.dp).width(gutterWidth), style = style, color = muted, textAlign = TextAlign.End)
        Text(when { !marked -> ""; line.kind == "addition" -> "+"; line.kind == "deletion" -> "−"; else -> "" },
            Modifier.width(18.dp), style = style, color = tint ?: muted, textAlign = TextAlign.Center)
        SelectionContainer(Modifier.weight(1f)) {
            Text(if (marked && line.kind in setOf("addition", "deletion", "context")) line.text.drop(1) else line.text,
                style = style, color = tint ?: MaterialTheme.colorScheme.onSurface)
        }
    }
}
