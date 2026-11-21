package com.orbising.orbis

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import com.orbising.orbis.OrbisActionIcon as Icon
import androidx.compose.material3.MaterialTheme
import com.orbising.orbis.OrbisBottomSheet as ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.layout.layout
import androidx.compose.ui.unit.dp

/** Paths belong to the computer, so Android's local File.separator must never be used. */
internal fun remoteBrowsePath(parent: String?, name: String): String = when {
    parent.isNullOrBlank() -> name // The root listing contains complete drive/root paths.
    parent.endsWith('/') || parent.endsWith('\\') -> parent + name
    parent.startsWith('/') || ('/' in parent && '\\' !in parent) -> "$parent/$name"
    else -> "$parent\\$name"
}

/** FILE-BROWSER-01: path entry and navigation are shared by session-folder and file-download pickers. */
@Composable
internal fun RemoteDirectoryBrowser(
    browse: SessionBrowseState?,
    connected: Boolean,
    onBrowse: (String?) -> Unit,
    onBrowseInto: (String) -> Unit,
    onBrowseUp: () -> Unit,
    modifier: Modifier = Modifier,
    showFiles: Boolean = false,
    selectedFiles: Set<String> = emptySet(),
    onSelectFile: (String) -> Unit = {},
) {
    val loading = browse?.isLoading == true
    val enabled = connected && !loading
    val entries = browse?.entries.orEmpty().filter { showFiles || it.isDir }
    var pathInput by rememberSaveable(browse?.path) { mutableStateOf(browse?.path.orEmpty()) }
    val focusManager = LocalFocusManager.current
    val jumpToPath = {
        val path = pathInput.trim()
        if (path.isNotEmpty() && enabled) {
            focusManager.clearFocus()
            onBrowse(path)
        }
    }
    Column(modifier, verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Icon(OrbisSymbols.Folder, contentDescription = null, tint = MaterialTheme.colorScheme.primary)
            Text(
                browse?.path?.takeIf(String::isNotBlank) ?: L10n.tr("电脑根目录"),
                fontFamily = FontFamily.Monospace,
                style = MaterialTheme.typography.labelMedium,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f),
            )
            if (loading) {
                CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp)
            } else {
                NeumorphIconButton(
                    onClick = { onBrowse(browse?.path) }, icon = OrbisSymbols.Refresh,
                    contentDescription = L10n.tr("刷新目录"), enabled = connected,
                )
            }
        }
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            NeumorphTextField(
                value = pathInput,
                onValueChange = { pathInput = it },
                modifier = Modifier.weight(1f).testTag("remote-directory-path"),
                placeholder = { Text(L10n.tr("电脑路径")) },
                singleLine = true,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri, imeAction = ImeAction.Go, autoCorrectEnabled = false),
                keyboardActions = KeyboardActions(onGo = { jumpToPath() }),
            )
            NeumorphIconButton(
                onClick = jumpToPath,
                icon = OrbisSymbols.Search,
                contentDescription = L10n.tr("跳转"),
                enabled = enabled && pathInput.isNotBlank(),
                modifier = Modifier.testTag("remote-directory-jump"),
            )
        }
        HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
        // In-sheet navigation stays inside the browser: a committing control would run the sheet's
        // exit without its owner closing it, leaving an invisible window that eats every touch.
        if (!browse?.path.isNullOrBlank()) {
            NeumorphTextButton(L10n.tr("上一级"), onClick = onBrowseUp, enabled = enabled, dismissOnClick = false,
                icon = OrbisSymbols.ArrowUpward, modifier = Modifier.fillMaxWidth())
        }
        if (browse?.error != null) {
            Text(browse.error, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
            NeumorphTextButton(L10n.tr("重新读取"), onClick = { onBrowse(browse.path) }, enabled = enabled, dismissOnClick = false)
        } else if (connected && !loading && browse != null && entries.isEmpty()) {
            Text(if (showFiles) L10n.tr("此目录没有可浏览的文件或子目录") else L10n.tr("此目录没有子目录"),
                style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        // The 8dp content padding only keeps the soft shadows; the list bleeds by the same amount,
        // so its rows line up with the「上一级」button and the action below.
        LazyColumn(
            modifier = Modifier.fillMaxWidth().weight(1f, fill = false).heightIn(max = 320.dp).bleedHorizontally(8.dp),
            contentPadding = PaddingValues(8.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            items(entries, key = SessionBrowseEntry::name) { entry ->
                val selected = !entry.isDir && entry.name in selectedFiles
                NeumorphSurface(
                    onClick = { if (entry.isDir) onBrowseInto(entry.name) else onSelectFile(entry.name) },
                    enabled = enabled && browse?.error == null,
                    modifier = Modifier.fillMaxWidth().semantics { this.selected = selected },
                    shape = RemoteUi.ControlShape,
                    style = if (selected) NeumorphStyle.Pressed else NeumorphStyle.Raised,
                    shadowScale = 0.45f,
                    contentInset = 12.dp,
                ) {
                    Row(Modifier.fillMaxWidth().heightIn(min = RemoteUi.TouchTarget).padding(12.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Icon(if (entry.isDir) OrbisSymbols.Folder else OrbisSymbols.Description,
                            contentDescription = if (entry.isDir) L10n.tr("目录") else L10n.tr("文件"),
                            tint = if (entry.hasSessions || selected) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant,
                            modifier = Modifier.size(20.dp))
                        if (entry.isDir) Text(entry.name, style = MaterialTheme.typography.bodyMedium,
                            maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                        else FileNameText(entry.name, Modifier.weight(1f))
                        if (entry.isDir && entry.hasSessions) {
                            Text(L10n.tr("有历史"), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.primary)
                        }
                        if (entry.isDir || showFiles) {
                            Icon(
                                if (entry.isDir) OrbisSymbols.ChevronRight else OrbisSymbols.CheckCircle,
                                contentDescription = null,
                                modifier = Modifier.size(20.dp).alpha(if (entry.isDir || selected) 1f else 0f),
                                tint = MaterialTheme.colorScheme.primary,
                            )
                        }
                    }
                }
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun DownloadFileSheet(
    state: RemoteState,
    onDismiss: () -> Unit,
    onBrowse: (String?) -> Unit,
    onBrowseInto: (String) -> Unit,
    onBrowseUp: () -> Unit,
    onDownload: (String) -> Unit,
    onOpen: () -> Unit = { onBrowse(null) },
) {
    val browse = state.sessionBrowse?.takeIf { it.forDownload }
    val connected = state.connection == RelayConnection.ONLINE && state.e2eReady
    var selectedFiles by remember(browse?.path) { mutableStateOf(emptySet<String>()) }
    val selected = browse?.entries.orEmpty().filter { !it.isDir && it.name in selectedFiles }
    // FILE-BROWSER-02: the opening (or reconnection), not a changed saved path, triggers a read.
    LaunchedEffect(connected, state.hostId) {
        if (connected) onOpen()
    }
    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        containerColor = MaterialTheme.colorScheme.surface, tonalElevation = 0.dp,
        shape = MaterialTheme.shapes.extraLarge,
        dragHandle = {
            NeumorphSurface(Modifier.padding(vertical = 16.dp).size(36.dp, 5.dp),
                shape = CircleShape, style = NeumorphStyle.Pressed, shadowScale = 0.25f) {}
        },
    ) {
        val confirmDownload = sheetCloseAction {
            if (selected.isNotEmpty()) {
                selected.forEach { onDownload(remoteBrowsePath(browse?.path, it.name)) }
                onDismiss()
            }
        }
        val toggleFile = { name: String ->
            selectedFiles = if (name in selectedFiles) selectedFiles - name else selectedFiles + name
        }
        BoxWithConstraints(Modifier.fillMaxWidth().weight(1f, fill = false)) {
            // A compact window cannot fit browser chrome plus a fixed footer. Keep them in one
            // scroll range and retain the browser's bounded lazy list within it.
            val scrollAll = maxHeight < 400.dp * LocalDensity.current.fontScale
            Column(Modifier.fillMaxWidth().then(if (scrollAll) Modifier.verticalScroll(rememberScrollState()) else Modifier)
                .padding(horizontal = RemoteUi.PagePadding).padding(bottom = 24.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Text(L10n.tr("选择电脑上的文件"), style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
                RemoteDirectoryBrowser(
                    browse, connected, onBrowse, onBrowseInto, onBrowseUp,
                    modifier = Modifier.fillMaxWidth().then(if (scrollAll) Modifier.heightIn(max = 320.dp) else Modifier.weight(1f, fill = false)),
                    showFiles = true, selectedFiles = selectedFiles, onSelectFile = toggleFile,
                )
                FileNameText(selected.singleOrNull()?.name.orEmpty(), Modifier.fillMaxWidth().height(24.dp),
                    style = MaterialTheme.typography.labelSmall)
                NeumorphActionButton(
                    text = if (selected.size <= 1) L10n.tr("下载到手机") else L10n.tr("下载所选 {0} 个文件", selected.size),
                    icon = OrbisSymbols.Download, modifier = Modifier.fillMaxWidth(),
                    enabled = connected && browse?.isLoading == false && browse.error == null && selected.isNotEmpty(),
                    onClick = confirmDownload,
                )
            }
        }
    }
}

/** Lets a list draw [amount] past both side edges, so content padding kept for shadows does not indent its rows. */
private fun Modifier.bleedHorizontally(amount: androidx.compose.ui.unit.Dp): Modifier = layout { measurable, constraints ->
    val extra = amount.roundToPx()
    val wide = constraints.copy(
        minWidth = constraints.minWidth + extra * 2,
        maxWidth = if (constraints.hasBoundedWidth) constraints.maxWidth + extra * 2 else constraints.maxWidth,
    )
    val placeable = measurable.measure(wide)
    layout((placeable.width - extra * 2).coerceAtLeast(0), placeable.height) { placeable.place(-extra, 0) }
}
