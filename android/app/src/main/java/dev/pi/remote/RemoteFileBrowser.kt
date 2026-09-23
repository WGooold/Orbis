package dev.pi.remote

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.ArrowUpward
import androidx.compose.material.icons.rounded.CheckCircle
import androidx.compose.material.icons.rounded.ChevronRight
import androidx.compose.material.icons.rounded.Description
import androidx.compose.material.icons.rounded.Download
import androidx.compose.material.icons.rounded.Folder
import androidx.compose.material.icons.rounded.Refresh
import androidx.compose.material3.Badge
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp

/** Paths belong to the computer, so Android's local File.separator must never be used. */
internal fun remoteBrowsePath(parent: String?, name: String): String = when {
    parent.isNullOrBlank() -> name // The root listing contains complete drive/root paths.
    parent.endsWith('/') || parent.endsWith('\\') -> parent + name
    parent.startsWith('/') || ('/' in parent && '\\' !in parent) -> "$parent/$name"
    else -> "$parent\\$name"
}

/** The same navigation and loading/error states serve session folders and downloadable files. */
@Composable
internal fun RemoteDirectoryBrowser(
    browse: SessionBrowseState?,
    connected: Boolean,
    onBrowse: (String?) -> Unit,
    onBrowseInto: (String) -> Unit,
    onBrowseUp: () -> Unit,
    modifier: Modifier = Modifier,
    showFiles: Boolean = false,
    selectedFile: String? = null,
    onSelectFile: (String) -> Unit = {},
) {
    val loading = browse?.isLoading == true
    val enabled = connected && !loading
    val entries = browse?.entries.orEmpty().filter { showFiles || it.isDir }
    Column(modifier, verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Icon(Icons.Rounded.Folder, contentDescription = null, tint = MaterialTheme.colorScheme.primary)
            Text(
                browse?.path?.takeIf(String::isNotBlank) ?: "电脑根目录",
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
                    onClick = { onBrowse(browse?.path) }, icon = Icons.Rounded.Refresh,
                    contentDescription = "刷新目录", enabled = connected,
                )
            }
        }
        HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
        if (!browse?.path.isNullOrBlank()) {
            NeumorphTextButton("上一级", onClick = onBrowseUp, enabled = enabled,
                icon = Icons.Rounded.ArrowUpward, modifier = Modifier.fillMaxWidth())
        }
        if (browse?.error != null) {
            Text(browse.error, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
            NeumorphTextButton("重新读取", onClick = { onBrowse(browse.path) }, enabled = enabled)
        } else if (connected && !loading && browse != null && entries.isEmpty()) {
            Text(if (showFiles) "此目录没有可浏览的文件或子目录" else "此目录没有子目录",
                style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        LazyColumn(
            modifier = Modifier.fillMaxWidth().weight(1f, fill = false).heightIn(max = 320.dp),
            contentPadding = PaddingValues(8.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            items(entries, key = SessionBrowseEntry::name) { entry ->
                val selected = !entry.isDir && selectedFile == entry.name
                NeumorphSurface(
                    onClick = { if (entry.isDir) onBrowseInto(entry.name) else onSelectFile(entry.name) },
                    enabled = enabled && browse?.error == null,
                    modifier = Modifier.fillMaxWidth().semantics { this.selected = selected },
                    shape = RemoteUi.ControlShape,
                    style = if (selected) NeumorphStyle.Pressed else NeumorphStyle.Raised,
                    shadowScale = 0.45f,
                ) {
                    Row(Modifier.fillMaxWidth().heightIn(min = RemoteUi.TouchTarget).padding(12.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Icon(if (entry.isDir) Icons.Rounded.Folder else Icons.Rounded.Description,
                            contentDescription = if (entry.isDir) "目录" else "文件",
                            tint = if (entry.hasSessions || selected) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant,
                            modifier = Modifier.size(20.dp))
                        Text(entry.name, style = MaterialTheme.typography.bodyMedium,
                            maxLines = 2, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                        if (entry.isDir && entry.hasSessions) {
                            Badge(containerColor = MaterialTheme.colorScheme.secondaryContainer) {
                                Text("有历史", style = MaterialTheme.typography.labelSmall)
                            }
                        }
                        if (entry.isDir || selected) {
                            Icon(if (selected) Icons.Rounded.CheckCircle else Icons.Rounded.ChevronRight,
                                contentDescription = null, modifier = Modifier.size(20.dp),
                                tint = MaterialTheme.colorScheme.primary)
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
) {
    val browse = state.sessionBrowse
    val connected = state.connection == RelayConnection.ONLINE && state.e2eReady
    var selectedFile by rememberSaveable(browse?.path) { mutableStateOf<String?>(null) }
    val selected = browse?.entries?.firstOrNull { !it.isDir && it.name == selectedFile }
    LaunchedEffect(connected) {
        if (connected) onBrowse(browse?.path)
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
        Column(Modifier.fillMaxWidth().navigationBarsPadding()
            .padding(horizontal = RemoteUi.PagePadding).padding(bottom = 24.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Text("选择电脑上的文件", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
            Text(if (connected) "进入目录，选中文件后下载到手机" else "未连接到电脑，连接后可继续浏览",
                style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            RemoteDirectoryBrowser(
                browse, connected, onBrowse, onBrowseInto, onBrowseUp,
                modifier = Modifier.fillMaxWidth().weight(1f, fill = false),
                showFiles = true, selectedFile = selectedFile, onSelectFile = { selectedFile = it },
            )
            selected?.let {
                Text(remoteBrowsePath(browse?.path, it.name), fontFamily = FontFamily.Monospace,
                    style = MaterialTheme.typography.labelSmall, maxLines = 2, overflow = TextOverflow.Ellipsis,
                    color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            NeumorphActionButton(
                text = "下载到手机", icon = Icons.Rounded.Download, modifier = Modifier.fillMaxWidth(),
                enabled = connected && browse?.isLoading == false && browse.error == null && selected != null,
                onClick = {
                    selected?.let { onDownload(remoteBrowsePath(browse?.path, it.name)); onDismiss() }
                },
            )
        }
    }
}
