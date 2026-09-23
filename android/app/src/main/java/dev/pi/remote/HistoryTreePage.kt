package dev.pi.remote

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.ArrowBack
import androidx.compose.material.icons.rounded.ArrowDownward
import androidx.compose.material.icons.rounded.ChevronRight
import androidx.compose.material.icons.rounded.Close
import androidx.compose.material.icons.rounded.Edit
import androidx.compose.material.icons.rounded.ExpandLess
import androidx.compose.material.icons.rounded.ExpandMore
import androidx.compose.material.icons.rounded.Search
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.focus.FocusManager
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import dev.pi.remote.NeumorphMenu as DropdownMenu
import dev.pi.remote.NeumorphMenuItem as DropdownMenuItem

/** 历史树页面 */
private const val HISTORY_TREE_COMMAND = "tree"
private val HistoryIndentStep = 16.dp
private val HistoryRowSpacing = 8.dp
private const val PREVIEW_MESSAGE_LIMIT = 8

/** 分支缩进的连接线：新拟物底板上的柔影色，比描边轻，只负责表达连通关系。 */
private val HistoryBranchRule = Color(0x33A6B2C6)

/**
 * 会话历史（`/tree`）整页。
 *
 * 页面只做三件事：看清树、预览节点、执行跳转。
 *
 * - 树占主要屏幕空间，搜索是独立输入框，进页面即收起键盘；
 * - 默认只展开当前分支，其他分支折成一行摘要（点一下展开）；
 * - 点节点先预览附近的对话，**不改变电脑端会话**；底部按节点类型给出唯一的正式动作。
 *
 * 节点 ID 只在这里使用，不会再被写进聊天输入框。
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun HistoryTreePage(
    state: RemoteState,
    runtimeId: String,
    sessionId: String?,
    pendingNodeId: String?,
    actionError: String?,
    onBack: () -> Unit,
    onContinueFrom: (HistoryNode) -> Unit,
    onEditAndRestart: (HistoryNode) -> Unit,
    downloadArtifact: (RemoteArtifact) -> Unit,
    downloadFile: (String) -> Unit,
) {
    val keyboard = LocalSoftwareKeyboardController.current
    val focusManager = LocalFocusManager.current
    // 从聊天页进来时输入法可能还开着——树要占满屏幕，先把键盘收掉。
    LaunchedEffect(Unit) {
        focusManager.clearFocus()
        keyboard?.hide()
    }

    val treeOptions = remember(state.capabilities, runtimeId) {
        state.capabilities[runtimeId]?.commands
            .orEmpty()
            .firstOrNull { it.name == HISTORY_TREE_COMMAND }
            ?.argument
            ?.takeIf { it.kind == "tree" }
            ?.options
            .orEmpty()
    }
    val runtime = state.runtimes[runtimeId]
    val graph = sessionId?.let(state.sessionGraphs::get)
    val busy = runtime?.status == "running"

    var query by rememberSaveable { mutableStateOf("") }
    var filterKey by rememberSaveable { mutableStateOf(HistoryTreeFilter.DEFAULT.name) }
    var filterMenuOpen by remember { mutableStateOf(false) }
    var expandedBranches by remember { mutableStateOf(emptySet<String>()) }
    var expandedDetails by remember { mutableStateOf(emptySet<String>()) }
    var selectedNodeId by remember { mutableStateOf<String?>(null) }
    val filter = HistoryTreeFilter.entries.firstOrNull { it.name == filterKey } ?: HistoryTreeFilter.DEFAULT

    val rows = remember(treeOptions, filter, query, expandedBranches, expandedDetails, selectedNodeId) {
        historyTreeRows(
            options = treeOptions,
            filter = filter,
            query = query,
            expandedBranches = expandedBranches,
            expandedDetails = expandedDetails,
            selectedNodeId = selectedNodeId,
        )
    }
    val selectedNode = remember(rows, selectedNodeId) { findHistoryNode(rows, selectedNodeId) }
    val listState = remember(sessionId) { LazyListState() }
    var positioned by remember(sessionId) { mutableStateOf(false) }
    LaunchedEffect(rows, positioned, query) {
        if (positioned || query.isNotBlank() || rows.isEmpty()) return@LaunchedEffect
        listState.scrollToItem(historyTreeCurrentRowIndex(rows))
        positioned = true
    }

    Scaffold(
        topBar = {
            TopAppBar(
                navigationIcon = {
                    NeumorphIconButton(
                        onClick = onBack,
                        icon = Icons.Rounded.ArrowBack,
                        contentDescription = "返回聊天",
                        size = RemoteUi.IconButtonSize,
                    )
                },
                title = {
                    Column {
                        Text("历史与分支", fontWeight = FontWeight.SemiBold)
                        Text(
                            graph?.firstUserMessageTitle()
                                ?: sessionId?.let(state.sessions::get)?.name?.takeIf(String::isNotBlank)
                                ?: "当前会话",
                            style = MaterialTheme.typography.labelMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }
                },
            )
        },
    ) { padding ->
        Column(Modifier.fillMaxSize().padding(padding).imePadding()) {
            HistorySearchField(
                query = query,
                onQueryChange = { value ->
                    // 搜索是另一种浏览方式：换查询就退出预览，别让面板停在看不见的节点上。
                    query = value
                    selectedNodeId = null
                },
                focusManager = focusManager,
                modifier = Modifier.padding(horizontal = RemoteUi.PagePadding, vertical = 8.dp),
            )
            Row(
                modifier = Modifier.fillMaxWidth().padding(horizontal = RemoteUi.PagePadding),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Box {
                    NeumorphTextButton(text = "显示：${filter.title}", onClick = { filterMenuOpen = true })
                    DropdownMenu(expanded = filterMenuOpen, onDismissRequest = { filterMenuOpen = false }) {
                        HistoryTreeFilter.entries.forEach { candidate ->
                            DropdownMenuItem(text = { Text(candidate.title) }, onClick = {
                                // `filter` 是从 `filterKey` 每次组合时推导出来的，只有 key 是状态。
                                filterKey = candidate.name
                                filterMenuOpen = false
                            })
                        }
                    }
                }
                Text(
                    if (query.isBlank()) {
                        "${rows.count { it is HistoryTurnRow }} 轮 · ${rows.count { it is HistoryBranchRow }} 个分支"
                    } else {
                        "${rows.size} 个匹配节点"
                    },
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.weight(1f),
                )
                NeumorphTextButton(
                    text = "当前位置",
                    enabled = query.isBlank() && rows.isNotEmpty(),
                    onClick = {
                        expandedBranches = emptySet()
                        expandedDetails = emptySet()
                        selectedNodeId = null
                        filterKey = HistoryTreeFilter.DEFAULT.name
                    },
                )
            }
            if (rows.isEmpty()) {
                Text(
                    if (treeOptions.isEmpty()) "这个会话还没有可显示的分支记录" else "没有匹配的节点",
                    modifier = Modifier.padding(RemoteUi.PagePadding),
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            } else {
                LazyColumn(
                    state = listState,
                    modifier = Modifier.weight(1f).fillMaxWidth(),
                    contentPadding = PaddingValues(horizontal = RemoteUi.PagePadding, vertical = 12.dp),
                    verticalArrangement = Arrangement.spacedBy(HistoryRowSpacing),
                ) {
                    items(rows, key = HistoryTreeRow::key) { row ->
                        when (row) {
                            is HistoryTurnRow -> HistoryTurnCard(
                                row = row,
                                onSelect = { node -> selectedNodeId = node.nodeId },
                                onToggleDetails = { key ->
                                    expandedDetails = if (key in expandedDetails) expandedDetails - key else expandedDetails + key
                                },
                                onCollapseBranch = { id -> expandedBranches = expandedBranches - id },
                            )

                            is HistoryBranchRow -> HistoryBranchCard(
                                row = row,
                                onExpand = { expandedBranches = expandedBranches + row.branchId },
                            )
                        }
                    }
                }
            }
            actionError?.let { message ->
                Text(
                    message,
                    modifier = Modifier.fillMaxWidth().padding(horizontal = RemoteUi.PagePadding, vertical = 4.dp),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.error,
                )
            }
            selectedNode?.let { node ->
                HistoryPreviewPanel(
                    node = node,
                    preview = remember(graph, node.nodeId) { historyNodePreview(graph, node.nodeId) },
                    busy = busy,
                    pending = pendingNodeId != null,
                    isPendingNode = node.nodeId == pendingNodeId,
                    downloads = state.downloads,
                    downloadArtifact = downloadArtifact,
                    downloadFile = downloadFile,
                    runtimeId = runtimeId,
                    onExitPreview = { selectedNodeId = null },
                    onContinueFrom = { onContinueFrom(node) },
                    onEditAndRestart = { onEditAndRestart(node) },
                )
            }
        }
    }
}

@Composable
private fun HistorySearchField(
    query: String,
    onQueryChange: (String) -> Unit,
    focusManager: FocusManager,
    modifier: Modifier = Modifier,
) {
    OutlinedTextField(
        value = query,
        onValueChange = onQueryChange,
        modifier = modifier.fillMaxWidth().neumorphInsetOverlay(RemoteUi.ControlShape),
        placeholder = { Text("搜索消息、分支或书签", style = MaterialTheme.typography.bodyMedium) },
        leadingIcon = { Icon(Icons.Rounded.Search, contentDescription = null, modifier = Modifier.size(20.dp)) },
        trailingIcon = if (query.isEmpty()) {
            null
        } else {
            {
                NeumorphIconButton(
                    onClick = { onQueryChange("") },
                    icon = Icons.Rounded.Close,
                    contentDescription = "清除搜索",
                    size = 28.dp,
                )
            }
        },
        singleLine = true,
        textStyle = MaterialTheme.typography.bodyMedium,
        keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
        keyboardActions = KeyboardActions(onSearch = { focusManager.clearFocus() }),
        colors = neumorphFieldColors(),
        shape = RemoteUi.ControlShape,
    )
}

/** 一轮对话：用户消息、助手回复、以及收起来的工具与设置细节。 */
@Composable
private fun HistoryTurnCard(
    row: HistoryTurnRow,
    onSelect: (HistoryNode) -> Unit,
    onToggleDetails: (String) -> Unit,
    onCollapseBranch: (String) -> Unit,
) {
    Column(
        modifier = Modifier.fillMaxWidth().historyIndent(row.depth),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            if (row.showTurnIndex) {
                Text(
                    "第 ${row.turnIndex} 轮",
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            if (row.hasCurrent) {
                Text("当前位置", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.primary)
            }
            Spacer(Modifier.weight(1f))
            row.collapseBranchId?.let { branchId ->
                NeumorphIconButton(
                    onClick = { onCollapseBranch(branchId) },
                    icon = Icons.Rounded.ExpandLess,
                    contentDescription = "收起这个分支",
                    size = 30.dp,
                )
            }
        }
        row.user?.let { node -> HistoryNodeCard(node, selected = node.nodeId == row.selectedNodeId, onClick = { onSelect(node) }) }
        row.replies.forEach { node ->
            HistoryNodeCard(node, selected = node.nodeId == row.selectedNodeId, onClick = { onSelect(node) })
        }
        if (row.details.isNotEmpty()) {
            NeumorphSurface(
                onClick = { onToggleDetails(row.detailsKey) },
                shape = RemoteUi.ControlShape,
                shadowScale = 0.3f,
                modifier = Modifier.fillMaxWidth(),
            ) {
                Row(
                    Modifier.fillMaxWidth().heightIn(min = RemoteUi.TouchTarget).padding(horizontal = 12.dp, vertical = 6.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    Icon(
                        if (row.detailsExpanded) Icons.Rounded.ExpandLess else Icons.Rounded.ExpandMore,
                        contentDescription = if (row.detailsExpanded) "收起细节" else "展开细节",
                        tint = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.size(18.dp),
                    )
                    Text(
                        "${row.details.size} 项工具与设置",
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
            if (row.detailsExpanded) {
                Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    row.details.forEach { node ->
                        NeumorphSurface(
                            onClick = { onSelect(node) },
                            shape = RemoteUi.ControlShape,
                            style = if (node.nodeId == row.selectedNodeId) NeumorphStyle.Pressed else NeumorphStyle.Raised,
                            shadowScale = 0.25f,
                            modifier = Modifier.fillMaxWidth(),
                        ) {
                            Column(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 8.dp)) {
                                Text(
                                    node.kind.label,
                                    style = MaterialTheme.typography.labelSmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                )
                                Text(
                                    node.title,
                                    style = MaterialTheme.typography.bodySmall,
                                    maxLines = 2,
                                    overflow = TextOverflow.Ellipsis,
                                )
                            }
                        }
                    }
                }
            }
        }
    }
}

/** 可点选的节点。选中态用凹陷表示「这一条正在预览」，与当前位置同一套材质语言。 */
@Composable
private fun HistoryNodeCard(node: HistoryNode, selected: Boolean, onClick: () -> Unit) {
    NeumorphSurface(
        onClick = onClick,
        shape = RemoteUi.ControlShape,
        style = if (selected || node.isCurrent) NeumorphStyle.Pressed else NeumorphStyle.Raised,
        shadowScale = 0.35f,
        modifier = Modifier.fillMaxWidth(),
    ) {
        Column(Modifier.fillMaxWidth().heightIn(min = RemoteUi.TouchTarget).padding(horizontal = 12.dp, vertical = 8.dp)) {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(
                    node.kind.label,
                    style = MaterialTheme.typography.labelSmall,
                    color = if (node.isOnActivePath) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant,
                )
                if (node.isCurrent) {
                    Text("当前位置", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.primary)
                }
                node.bookmark?.let {
                    Text(
                        "书签：$it",
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.primary,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
                if (selected) {
                    Text("正在预览", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.primary)
                }
            }
            Text(
                node.title,
                style = MaterialTheme.typography.bodyMedium,
                fontWeight = if (node.isCurrent) FontWeight.SemiBold else FontWeight.Normal,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
        }
    }
}

/** 折叠的其他分支：一行摘要 + "N 轮对话"，点开才展开。 */
@Composable
private fun HistoryBranchCard(row: HistoryBranchRow, onExpand: () -> Unit) {
    NeumorphSurface(
        onClick = onExpand,
        shape = RemoteUi.ControlShape,
        shadowScale = 0.4f,
        modifier = Modifier.fillMaxWidth().historyIndent(row.depth),
    ) {
        Row(
            Modifier.fillMaxWidth().heightIn(min = RemoteUi.TouchTarget).padding(horizontal = 12.dp, vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Icon(
                Icons.Rounded.ChevronRight,
                contentDescription = "展开分支",
                tint = MaterialTheme.colorScheme.primary,
                modifier = Modifier.size(18.dp),
            )
            Column(Modifier.weight(1f)) {
                Text(
                    row.summary,
                    style = MaterialTheme.typography.bodyMedium,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                )
                Text(
                    row.subtitle,
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }
}

/**
 * 预览面板。它取代了「点一下就把节点 ID 塞进输入框」的老路子：
 * 点节点只改变手机上的显示，底部再给出唯一的正式动作。
 */
@Composable
private fun HistoryPreviewPanel(
    node: HistoryNode,
    preview: HistoryPreview,
    busy: Boolean,
    pending: Boolean,
    isPendingNode: Boolean,
    downloads: Map<String, ArtifactDownload>,
    downloadArtifact: (RemoteArtifact) -> Unit,
    downloadFile: (String) -> Unit,
    runtimeId: String,
    onExitPreview: () -> Unit,
    onContinueFrom: () -> Unit,
    onEditAndRestart: () -> Unit,
) {
    NeumorphSurface(
        shape = RemoteUi.CardShape,
        shadowScale = 0.8f,
        modifier = Modifier.fillMaxWidth().padding(horizontal = RemoteUi.PagePadding, vertical = 8.dp),
    ) {
        Column(Modifier.fillMaxWidth().heightIn(max = 420.dp).padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(
                    "正在预览",
                    style = MaterialTheme.typography.labelLarge,
                    color = MaterialTheme.colorScheme.primary,
                )
                Text(
                    "不会改变电脑端会话",
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.weight(1f),
                )
                NeumorphTextButton(text = "退出预览", onClick = onExitPreview)
            }
            Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(node.kind.label, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    node.bookmark?.let {
                        Text("书签：$it", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.primary, maxLines = 1)
                    }
                }
                Text(node.title, style = MaterialTheme.typography.bodyMedium, maxLines = 3, overflow = TextOverflow.Ellipsis)
            }
            Column(
                Modifier.fillMaxWidth().weight(1f, fill = false).verticalScroll(rememberScrollState()),
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                when {
                    preview.unavailable -> Text(
                        "本机还没有这个节点的对话缓存，只能执行底部动作。",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )

                    preview.messages.isEmpty() -> Text(
                        "这是一条还没有对话内容的记录。",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )

                    else -> {
                        Text(
                            "附近的对话",
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                        val presentation = remember(preview.messages) { buildConversationPresentation(preview.messages) }
                        val items = remember(preview.messages) { buildChatListItems(presentation.messages) }
                        items.forEach { item ->
                            when (item) {
                                is ChatListItem.UserMessage -> UserMessageCard(
                                    runtimeId = runtimeId,
                                    message = item.message,
                                    downloads = downloads,
                                    downloadArtifact = downloadArtifact,
                                    downloadFile = downloadFile,
                                )

                                is ChatListItem.AssistantTurn -> AssistantTurnCard(
                                    runtimeId = runtimeId,
                                    messages = item.messages,
                                    turnTiming = null,
                                    nowMs = 0L,
                                    toolActivities = emptyMap(),
                                    toolResults = presentation.toolResults,
                                    downloads = downloads,
                                    downloadArtifact = downloadArtifact,
                                    downloadFile = downloadFile,
                                )
                            }
                        }
                    }
                }
            }
            HistoryPreviewActions(
                node = node,
                busy = busy,
                pending = pending,
                isPendingNode = isPendingNode,
                onContinueFrom = onContinueFrom,
                onEditAndRestart = onEditAndRestart,
            )
        }
    }
}

@Composable
private fun HistoryPreviewActions(
    node: HistoryNode,
    busy: Boolean,
    pending: Boolean,
    isPendingNode: Boolean,
    onContinueFrom: () -> Unit,
    onEditAndRestart: () -> Unit,
) {
    val hint = when {
        node.isCurrent -> "当前位置就是这条记录"
        busy -> "运行中：切换分支要等这一轮结束"
        else -> null
    }
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        when (node.action) {
            HistoryNodeAction.EditAndRestart -> NeumorphTextButton(
                text = "编辑这条消息并重新开始",
                icon = Icons.Rounded.Edit,
                filled = true,
                enabled = !busy && !pending,
                onClick = onEditAndRestart,
                modifier = Modifier.fillMaxWidth(),
            )

            HistoryNodeAction.ContinueFromHere -> NeumorphTextButton(
                text = "从这条回复后继续",
                icon = Icons.Rounded.ArrowDownward,
                filled = true,
                enabled = !busy && !pending,
                onClick = onContinueFrom,
                modifier = Modifier.fillMaxWidth(),
            )

            null -> Text(
                hint ?: "这条记录只能预览，不能作为继续对话的位置。",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        if (node.action != null) {
            Text(
                when {
                    isPendingNode -> "正在跳转…"
                    hint != null -> hint
                    node.action == HistoryNodeAction.EditAndRestart -> "分支会移到这条消息之前，原文回到输入框"
                    else -> "分支会停在这条回复之后，接着往下聊"
                },
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

internal data class HistoryPreview(
    val messages: List<ChatMessage>,
    val unavailable: Boolean,
)

/** 预览 = 从根到这条记录的尾部若干条消息。它只读本机缓存，不发任何请求。 */
internal fun historyNodePreview(graph: SessionGraph?, nodeId: String): HistoryPreview {
    if (graph == null || !graph.entries.containsKey(nodeId)) return HistoryPreview(emptyList(), unavailable = true)
    val messages = projectSessionGraph(graph.copy(cursor = SessionBranchCursor(nodeId)))
        .messages
        .takeLast(PREVIEW_MESSAGE_LIMIT)
    return HistoryPreview(messages, unavailable = false)
}

private fun findHistoryNode(rows: List<HistoryTreeRow>, nodeId: String?): HistoryNode? {
    if (nodeId == null) return null
    for (row in rows) {
        if (row !is HistoryTurnRow) continue
        row.user?.takeIf { it.nodeId == nodeId }?.let { return it }
        row.replies.firstOrNull { it.nodeId == nodeId }?.let { return it }
        row.details.firstOrNull { it.nodeId == nodeId }?.let { return it }
    }
    return null
}

/** 只有分支点才加深缩进：连续对话保持同一缩进，层级才不会被链长吃掉。 */
private fun Modifier.historyIndent(depth: Int): Modifier = if (depth <= 0) {
    this
} else {
    padding(start = HistoryIndentStep * depth).drawBehind {
        drawLine(
            color = HistoryBranchRule,
            start = Offset(4.dp.toPx(), 0f),
            end = Offset(4.dp.toPx(), size.height),
            strokeWidth = 2.dp.toPx(),
        )
    }
}
