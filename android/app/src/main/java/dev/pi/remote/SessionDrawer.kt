package dev.pi.remote

import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.Add
import androidx.compose.material.icons.rounded.Archive
import androidx.compose.material.icons.rounded.ArrowBack
import androidx.compose.material.icons.rounded.Unarchive
import androidx.compose.material.icons.rounded.MoreVert
import androidx.compose.material.icons.rounded.Check
import androidx.compose.material.icons.rounded.ChevronRight
import androidx.compose.material.icons.rounded.Close
import androidx.compose.material.icons.rounded.Computer
import androidx.compose.material.icons.rounded.ExpandLess
import androidx.compose.material.icons.rounded.ExpandMore
import androidx.compose.material.icons.rounded.Folder
import androidx.compose.material.icons.rounded.FolderOpen
import androidx.compose.material.icons.rounded.FilterList
import androidx.compose.material.icons.rounded.HistoryEdu
import androidx.compose.material.icons.rounded.Search
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalDrawerSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp

private enum class DrawerAgentFilter(
    val key: String,
    val label: String,
    private val kind: String?,
) {
    All("all", "全部", null),
    Pi("pi", "Pi", "pi"),
    Codex("codex", "Codex", "codex"),
    DeepSeek("dsh", "DeepSeek", "dsh");

    fun matches(row: CachedSessionRow): Boolean = kind == null || row.agentKind == kind
}

private fun drawerAgentFilter(key: String): DrawerAgentFilter =
    DrawerAgentFilter.values().firstOrNull { it.key == key } ?: DrawerAgentFilter.All

@Composable
private fun DrawerAgentFilterMenu(
    selected: DrawerAgentFilter,
    onSelect: (DrawerAgentFilter) -> Unit,
    showArchived: Boolean,
    onToggleArchived: () -> Unit,
    providerOptions: List<CodexProviderOption>,
    providerFilterKey: String,
    onSelectProvider: (String) -> Unit,
) {
    var expanded by remember { mutableStateOf(false) }
    var showProviders by remember { mutableStateOf(false) }
    val filterLabel = if (selected == DrawerAgentFilter.Codex) {
        "Codex · ${providerOptions.firstOrNull { it.key == providerFilterKey }?.label.orEmpty()}"
    } else selected.label
    Box {
        NeumorphIconButton(
            onClick = { showProviders = false; expanded = true },
            icon = Icons.Rounded.FilterList,
            contentDescription = "筛选会话：$filterLabel",
            tint = if (selected == DrawerAgentFilter.All) {
                MaterialTheme.colorScheme.onSurfaceVariant
            } else {
                MaterialTheme.colorScheme.primary
            },
        )
        NeumorphMenu(expanded = expanded, onDismissRequest = { expanded = false }) {
            if (showProviders) {
                NeumorphMenuItem(
                    text = { Text("Codex · provider") },
                    leadingIcon = { Icon(Icons.Rounded.ArrowBack, contentDescription = "返回会话筛选", modifier = Modifier.size(18.dp)) },
                    onClick = { showProviders = false },
                )
                Text(
                    "会话绑定所属 provider；打开其他 provider 的会话前，请先在电脑端切换。",
                    modifier = Modifier.width(248.dp).padding(horizontal = 8.dp),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                providerOptions.forEach { option ->
                    NeumorphMenuItem(
                        text = { Text(option.label) },
                        onClick = { onSelectProvider(option.key); expanded = false },
                        trailingIcon = if (option.key == providerFilterKey) {
                            { Icon(Icons.Rounded.Check, contentDescription = "当前 provider 筛选", tint = MaterialTheme.colorScheme.primary) }
                        } else null,
                    )
                }
            } else {
            DrawerAgentFilter.values().forEach { filter ->
                NeumorphMenuItem(
                    text = { Text(filter.label) },
                    onClick = {
                        onSelect(filter)
                        if (filter == DrawerAgentFilter.Codex) showProviders = true else expanded = false
                    },
                    leadingIcon = {
                        if (filter == DrawerAgentFilter.All) {
                            Icon(Icons.Rounded.FilterList, contentDescription = null, modifier = Modifier.size(18.dp))
                        } else {
                            AgentIcon(agentBrand(filter.key), Modifier.size(18.dp))
                        }
                    },
                    trailingIcon = {
                        Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                            if (filter == selected) Icon(Icons.Rounded.Check, contentDescription = "当前筛选", tint = MaterialTheme.colorScheme.primary)
                            if (filter == DrawerAgentFilter.Codex) Icon(Icons.Rounded.ChevronRight, contentDescription = "按 provider 筛选")
                        }
                    },
                )
            }
            HorizontalDivider()
            NeumorphMenuItem(
                text = { Text(if (showArchived) "查看未归档会话" else "查看已归档会话") },
                onClick = { onToggleArchived(); expanded = false },
                leadingIcon = { Icon(Icons.Rounded.Archive, contentDescription = null, modifier = Modifier.size(18.dp)) },
            )
            }
        }
    }
}

/** Host context, raised directory headers, and inset session leaves each have their own level. */
@Composable
internal fun SessionDrawer(
    state: RemoteState,
    onOpenSession: (String) -> Unit,
    onOpenHistory: (String) -> Unit,
    onNewSession: (String?) -> Unit,
    onSetArchived: (String, Boolean) -> Unit,
) {
    val tree = remember(state.hostId, state.hostName, state.sessions, state.runtimes, state.sessionAliases, state.sessionGraphs, state.conversations) {
        cachedHistoryTree(state)
    }
    var agentFilterKey by rememberSaveable { mutableStateOf(DrawerAgentFilter.All.key) }
    val agentFilter = drawerAgentFilter(agentFilterKey)
    val currentProvider = state.currentProviders["codex"]
    var requestedProviderKey by rememberSaveable(state.hostId) { mutableStateOf(CURRENT_CODEX_PROVIDER) }
    val providerOptions = remember(tree, currentProvider) { codexProviderOptions(tree, currentProvider) }
    val providerKey = requestedProviderKey.takeIf { key -> providerOptions.any { it.key == key } } ?: CURRENT_CODEX_PROVIDER
    val providerLabel = providerOptions.first { it.key == providerKey }.label
    var showArchived by rememberSaveable { mutableStateOf(false) }
    var blockedSessionId by remember { mutableStateOf<String?>(null) }
    val filteredTree = remember(tree, agentFilterKey, showArchived, providerKey, currentProvider) {
        tree.mapNotNull { host ->
            host.copy(
                directories = host.directories.mapNotNull { directory ->
                    directory.copy(sessions = directory.sessions.filter {
                        agentFilter.matches(it) && it.isArchived == showArchived &&
                            (agentFilter != DrawerAgentFilter.Codex || matchesCodexProvider(it, providerKey, currentProvider))
                    })
                        .takeIf { it.sessions.isNotEmpty() }
                },
            ).takeIf { it.directories.isNotEmpty() }
        }
    }
    val host = state.sessionHost
    val selectedHost = host?.hostId
    val activeHost = filteredTree.singleOrNull()
    var query by rememberSaveable { mutableStateOf("") }
    val searchTerm = query.trim()
    val directories = remember(activeHost, searchTerm) {
        activeHost?.directories.orEmpty().mapNotNull { directory ->
            if (searchTerm.isEmpty() || directory.cwd.contains(searchTerm, ignoreCase = true)) {
                directory
            } else {
                directory.sessions.filter { it.title.contains(searchTerm, ignoreCase = true) }
                    .takeIf { it.isNotEmpty() }?.let { directory.copy(sessions = it) }
            }
        }
    }
    // Keep only one branch open. Searching reveals the first result without losing its parent.
    var expandedCwd by rememberSaveable(selectedHost, searchTerm, agentFilterKey, providerKey, currentProvider) {
        mutableStateOf(directories.firstOrNull()?.cwd)
    }
    var showAllSessions by rememberSaveable(selectedHost, searchTerm, agentFilterKey, providerKey, currentProvider, expandedCwd) { mutableStateOf(false) }
    // Reset only when browsing a different catalog, not when restoring this page from history.
    val listState = rememberSaveable(selectedHost, searchTerm, agentFilterKey, providerKey, currentProvider, showArchived, saver = LazyListState.Saver) {
        LazyListState()
    }
    val connected = state.canOperateSessions
    val canCreate = state.canCreateSessionOn(selectedHost)
    val focusManager = LocalFocusManager.current
    val drawerWidth = (LocalConfiguration.current.screenWidthDp.dp - 32.dp).coerceAtMost(384.dp)

    blockedSessionId?.let { sessionId ->
        val reason = state.codexProviderMismatch(sessionId)
        if (reason != null) NeumorphDialog(
            onDismissRequest = { blockedSessionId = null },
            title = { Text("需要切换 provider") },
            text = { Text(reason) },
            confirmButton = { NeumorphTextButton("知道了", { blockedSessionId = null }) },
            dismissButton = if (state.sessions[sessionId]?.hasHistoryCache == true) {
                { NeumorphTextButton("查看只读历史", { blockedSessionId = null; onOpenHistory(sessionId) }) }
            } else null,
        )
    }

    ModalDrawerSheet(
        modifier = Modifier.width(drawerWidth),
        drawerShape = MaterialTheme.shapes.extraLarge,
        drawerTonalElevation = 0.dp,
        drawerContainerColor = MaterialTheme.colorScheme.background,
    ) {
        // 抽屉不再铺一层凸起底板：内容直接落在与页面同一块「地面」上，
        // 浅色面板会把抽屉内外的软材质割成两层，也让贴边控件多出一圈无处安放的柔影。
        Column(
            Modifier.fillMaxSize()
                .imePadding()
                .padding(horizontal = 12.dp, vertical = 8.dp),
        ) {
            Row(
                Modifier.fillMaxWidth().padding(start = 20.dp, end = 16.dp, top = 0.dp, bottom = 8.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(4.dp),
                ) {
                    OutlinedTextField(
                        value = query,
                        onValueChange = { query = it },
                        modifier = Modifier.weight(1f).neumorphInsetOverlay(RemoteUi.ControlShape),
                        placeholder = { Text("搜索目录或会话", style = MaterialTheme.typography.bodyMedium) },
                        leadingIcon = { Icon(Icons.Rounded.Search, contentDescription = null, modifier = Modifier.size(20.dp)) },
                        trailingIcon = if (query.isNotEmpty()) {
                        {
                            NeumorphIconButton(
                                onClick = { query = "" },
                                icon = Icons.Rounded.Close,
                                contentDescription = "清除搜索",
                                size = 28.dp,
                            )
                        }
                    } else null,
                    singleLine = true,
                    textStyle = MaterialTheme.typography.bodyMedium,
                    keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
                    keyboardActions = KeyboardActions(onSearch = { focusManager.clearFocus() }),
                        colors = neumorphFieldColors(),
                        shape = RemoteUi.ControlShape,
                    )
                    DrawerAgentFilterMenu(
                        selected = agentFilter,
                        onSelect = { agentFilterKey = it.key },
                        showArchived = showArchived,
                        onToggleArchived = { showArchived = !showArchived },
                        providerOptions = providerOptions,
                        providerFilterKey = providerKey,
                        onSelectProvider = { requestedProviderKey = it; agentFilterKey = DrawerAgentFilter.Codex.key },
                    )
                    NeumorphIconButton(
                        onClick = { onNewSession(null) },
                        icon = Icons.Rounded.Add,
                        contentDescription = "新建会话",
                        enabled = canCreate,
                        tint = MaterialTheme.colorScheme.primary,
                    )
                }
            if (agentFilter == DrawerAgentFilter.Codex) {
                Text(
                    "Codex · $providerLabel",
                    modifier = Modifier.fillMaxWidth().padding(horizontal = 24.dp, vertical = 4.dp),
                    style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.primary,
                )
            }
            Row(
                Modifier.fillMaxWidth().padding(horizontal = 24.dp, vertical = 8.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.SpaceBetween,
            ) {
                Text(
                    if (searchTerm.isNotEmpty()) "搜索结果" else if (showArchived) "已归档" else "工作目录",
                    style = MaterialTheme.typography.labelLarge,
                    modifier = Modifier.semantics { heading() },
                )
                Text(
                    "${directories.size} 个目录 · ${directories.sumOf { it.sessions.size }} 个会话",
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            LazyColumn(
                state = listState,
                modifier = Modifier.fillMaxWidth().weight(1f),
                contentPadding = PaddingValues(start = 20.dp, end = 20.dp, top = 6.dp, bottom = 16.dp),
            ) {
                if (directories.isEmpty()) {
                    item {
                        Column(
                            Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 28.dp),
                            horizontalAlignment = Alignment.CenterHorizontally,
                            verticalArrangement = Arrangement.spacedBy(8.dp),
                        ) {
                            Icon(
                                if (searchTerm.isEmpty()) Icons.Rounded.FolderOpen else Icons.Rounded.Search,
                                contentDescription = null,
                                modifier = Modifier.size(32.dp),
                                tint = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                            Text(
                                if (searchTerm.isEmpty()) {
                                    if (showArchived) "没有已归档的会话"
                                    else if (agentFilter == DrawerAgentFilter.Codex && providerKey == CURRENT_CODEX_PROVIDER && currentProvider == null) "尚未获取当前 provider"
                                    else if (agentFilter == DrawerAgentFilter.All) "还没有可显示的会话"
                                    else "没有${agentFilter.label}会话"
                                } else "没有找到匹配的目录或会话",
                                style = MaterialTheme.typography.bodyMedium,
                            )
                            Text(
                                if (searchTerm.isEmpty()) {
                                    if (showArchived) "通过筛选菜单返回未归档会话"
                                    else if (agentFilter == DrawerAgentFilter.Codex && providerKey == CURRENT_CODEX_PROVIDER && currentProvider == null) "连接电脑获取当前配置，或在筛选菜单中选择其他 provider"
                                    else if (agentFilter == DrawerAgentFilter.All) "新建一个会话，从选择目录开始"
                                    else "切换筛选条件，或新建一个${agentFilter.label}会话"
                                } else "试试目录名、完整路径或会话标题",
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                    }
                }
                directories.forEach { directory ->
                    val expanded = directory.cwd == expandedCwd
                    item(key = "directory:${directory.cwd}") {
                        DrawerDirectoryHeader(
                            directory = directory,
                            expanded = expanded,
                            createEnabled = canCreate && directory.cwd.isNotBlank(),
                            onCreate = { onNewSession(directory.cwd) },
                        ) {
                            expandedCwd = if (expanded) null else directory.cwd
                            focusManager.clearFocus()
                        }
                    }
                    if (expanded) {
                        val visibleSessions = if (showAllSessions || searchTerm.isNotEmpty()) {
                            directory.sessions
                        } else directory.sessions.take(5)
                        items(visibleSessions, key = { "session:${it.sessionId}" }) { row ->
                            DrawerBranch {
                                DrawerSessionRow(
                                    row = row,
                                    onOpenSession = {
                                        if (state.codexProviderMismatch(row.sessionId) != null) blockedSessionId = row.sessionId
                                        else onOpenSession(row.sessionId)
                                    },
                                    onOpenHistory = { onOpenHistory(row.sessionId) },
                                    archiveEnabled = connected && state.e2eReady &&
                                        row.catalogEntry?.agentKind != null && row.agentKind != "dsh" &&
                                        row.sessionId !in state.sessionArchiveRequests.values &&
                                        (row.isArchived || !row.isOnline || (row.isCodex && state.runtimes[row.runtimeId]?.status == "idle")),
                                    archivePending = row.sessionId in state.sessionArchiveRequests.values,
                                    onSetArchived = { onSetArchived(row.sessionId, !row.isArchived) },
                                )
                            }
                        }
                        if (directory.sessions.size > 5 && searchTerm.isEmpty()) {
                            item(key = "more:${directory.cwd}") {
                                DrawerBranch {
                                    NeumorphTextButton(
                                        text = if (showAllSessions) "收起较早会话" else "再显示 ${directory.sessions.size - 5} 个会话",
                                        onClick = { showAllSessions = !showAllSessions },
                                        icon = if (showAllSessions) Icons.Rounded.ExpandLess else Icons.Rounded.ExpandMore,
                                        modifier = Modifier.fillMaxWidth(),
                                    )
                                }
                            }
                        }
                    }
                    item(key = "gap:${directory.cwd}") { Spacer(Modifier.height(14.dp)) }
                }
            }
            // 「电脑」贴着抽屉底部：它是当前所在的主机，不是列表的筛选条件，
            // 放到顶部会先于「你看哪个目录」被读到，也让搜索框离拇指更远。
            if (host != null) {
                // 细线给列表收口：页脚必须被读成列表之外的一段，而不是最后一张目录卡片。
                HorizontalDivider(
                    modifier = Modifier.padding(start = 20.dp, end = 20.dp, top = 16.dp),
                    thickness = 1.dp,
                    color = MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.6f),
                )
                DrawerHostLabel(host.name)
            }
        }
    }
}

/**
 * 抽屉页脚：当前电脑。
 *
 * 它曾经和列表共用同一条水平带、同一种凹陷材质、同样的「标签 + 值」两行结构，
 * 于是被读成又一张目录卡片。页脚不是列表里的一行，它得在三个维度上和列表断开：
 * 几何上抬到地面之上（Raised）、结构上压成单行、位置上由列表底边那条细线收口。
 * 「你正站在哪台电脑上」是底座，不是筛选条件。
 */
@Composable
private fun DrawerHostLabel(name: String) {
    Box(
        Modifier.fillMaxWidth().padding(horizontal = 20.dp).padding(top = 12.dp, bottom = 4.dp),
    ) {
        NeumorphSurface(
            modifier = Modifier.fillMaxWidth(),
            style = NeumorphStyle.Raised,
            shape = RemoteUi.ControlShape,
            shadowScale = 0.8f,
        ) {
            Row(
                Modifier.fillMaxWidth().heightIn(min = RemoteUi.TouchTarget).padding(horizontal = 16.dp, vertical = 6.dp),
                horizontalArrangement = Arrangement.spacedBy(10.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Icon(
                    Icons.Rounded.Computer,
                    contentDescription = null,
                    modifier = Modifier.size(20.dp),
                    tint = MaterialTheme.colorScheme.primary,
                )
                Text(
                    "电脑",
                    style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Text(
                    name,
                    style = MaterialTheme.typography.titleSmall,
                    modifier = Modifier.weight(1f),
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
    }
}

@Composable
private fun DrawerDirectoryHeader(
    directory: CachedDirectoryGroup,
    expanded: Boolean,
    createEnabled: Boolean,
    onCreate: () -> Unit,
    onClick: () -> Unit,
) {
    val accent = if (expanded) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant
    val rotation by animateFloatAsState(if (expanded) 90f else 0f, label = "directory-disclosure")
    NeumorphSurface(
        modifier = Modifier.fillMaxWidth().semantics { stateDescription = if (expanded) "已展开" else "已收起" },
        shape = RemoteUi.CardShape,
        style = if (expanded) NeumorphStyle.Pressed else NeumorphStyle.Raised,
        shadowScale = 0.75f,
        onClick = onClick,
    ) {
        Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                Icon(
                    if (expanded) Icons.Rounded.FolderOpen else Icons.Rounded.Folder,
                    contentDescription = null,
                    modifier = Modifier.size(24.dp),
                    tint = accent,
                )
                Column(Modifier.weight(1f)) {
                    Text(
                        directoryDisplayName(directory.cwd).ifBlank { "未记录目录" },
                        style = MaterialTheme.typography.titleSmall,
                        fontWeight = FontWeight.SemiBold,
                        color = if (expanded) accent else MaterialTheme.colorScheme.onSurface,
                        maxLines = 2,
                        overflow = TextOverflow.Ellipsis,
                    )
                    Text(
                        "${directory.sessions.size} 个会话",
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                NeumorphIconButton(
                    onClick = onCreate,
                    icon = Icons.Rounded.Add,
                    contentDescription = "在此目录新建会话",
                    enabled = createEnabled,
                    size = 32.dp,
                    tint = accent,
                )
                Icon(
                    Icons.Rounded.ChevronRight,
                    contentDescription = if (expanded) "收起目录" else "展开目录",
                    tint = accent,
                    modifier = Modifier.size(20.dp).rotate(rotation),
                )
            }
            if (directory.cwd.isNotBlank()) {
                Text(
                    directory.cwd,
                    fontFamily = FontFamily.Monospace,
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = if (expanded) Int.MAX_VALUE else 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
    }
}

/** Continuous guides live in the gutter; session surfaces never compete with directory headers. */
@Composable
private fun DrawerBranch(content: @Composable () -> Unit) {
    val guideColor = MaterialTheme.colorScheme.outlineVariant
    Box(
        Modifier.fillMaxWidth().drawBehind {
            val x = 18.dp.toPx()
            val middle = size.height / 2f
            drawLine(guideColor, Offset(x, 0f), Offset(x, size.height), 1.5.dp.toPx(), StrokeCap.Round)
            drawLine(guideColor, Offset(x, middle), Offset(30.dp.toPx(), middle), 1.5.dp.toPx(), StrokeCap.Round)
        }.padding(start = 32.dp, top = 10.dp),
    ) {
        content()
    }
}

@Composable
private fun DrawerSessionRow(
    row: CachedSessionRow,
    onOpenSession: () -> Unit,
    onOpenHistory: () -> Unit,
    archiveEnabled: Boolean,
    archivePending: Boolean,
    onSetArchived: () -> Unit,
) {
    var menuOpen by remember { mutableStateOf(false) }
    NeumorphSurface(
        modifier = Modifier.fillMaxWidth(),
        style = NeumorphStyle.Pressed,
        shape = RemoteUi.ControlShape,
        shadowScale = 0.45f,
        onClick = {
            if (!row.isArchived) onOpenSession()
            else if (row.catalogEntry?.hasHistoryCache == true) onOpenHistory()
            else menuOpen = true
        },
    ) {
        Row(
            Modifier.fillMaxWidth().heightIn(min = 72.dp).padding(start = 12.dp, end = 8.dp, top = 12.dp, bottom = 12.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Text(row.title, maxLines = 2, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.bodyMedium)
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    AgentIcon(agentBrand(row.agentKind), modifier = Modifier.size(14.dp))
                    Text(
                        agentBrand(row.agentKind).title,
                        style = MaterialTheme.typography.labelSmall,
                        color = agentBrand(row.agentKind).accent(),
                    )
                    if (row.isOnline) {
                        Box(Modifier.size(4.dp).background(MaterialTheme.colorScheme.tertiary, CircleShape))
                        Text("在线", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.tertiary)
                    }
                }
                if (row.isCodex) {
                    Text(
                        row.modelProvider ?: "未知 provider",
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
            }
            Icon(
                Icons.Rounded.ChevronRight,
                contentDescription = null,
                tint = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.size(16.dp),
            )
            Box {
                NeumorphIconButton(
                    onClick = { menuOpen = true },
                    icon = Icons.Rounded.MoreVert,
                    contentDescription = "会话操作",
                    size = 30.dp,
                )
                NeumorphMenu(expanded = menuOpen, onDismissRequest = { menuOpen = false }) {
                    if (!row.isOnline && row.catalogEntry?.hasHistoryCache == true) {
                        NeumorphMenuItem(
                            text = { Text("查看只读历史") },
                            onClick = { menuOpen = false; onOpenHistory() },
                            leadingIcon = {
                                Icon(
                                    Icons.Rounded.HistoryEdu,
                                    contentDescription = null,
                                    modifier = Modifier.size(18.dp),
                                )
                            },
                        )
                    }
                    NeumorphMenuItem(
                        text = { Text(when {
                            archivePending -> "处理中…"
                            row.isArchived -> "恢复会话"
                            row.agentKind == "dsh" -> "DSH 暂不支持归档"
                            row.isOnline && !row.isCodex -> "请先退出 Pi 会话"
                            row.isOnline && !archiveEnabled -> "等待任务完成后归档"
                            else -> "归档会话"
                        }) },
                        enabled = archiveEnabled,
                        onClick = { menuOpen = false; onSetArchived() },
                        leadingIcon = { Icon(
                            if (row.isArchived) Icons.Rounded.Unarchive else Icons.Rounded.Archive,
                            contentDescription = null,
                            modifier = Modifier.size(18.dp),
                        ) },
                    )
                }
            }
        }
    }
}

internal fun directoryDisplayName(cwd: String): String =
    cwd.trimEnd('/', '\\')
        .substringAfterLast('/')
        .substringAfterLast('\\')
        .takeIf(String::isNotBlank)
        ?: cwd
