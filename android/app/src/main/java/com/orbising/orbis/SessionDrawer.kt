package com.orbising.orbis

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
import com.orbising.orbis.NeumorphTextField as OutlinedTextField
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
    Codex("codex", "Codex 终端", "codex"),
    CodexDesktop("codexDesktop", "Codex 桌面版", "codexDesktop"),
    DeepSeek("dsh", "DeepSeek", "dsh"),
    Claude("claude", "Claude Code", "claude");

    fun matches(row: CachedSessionRow): Boolean = kind == null || row.agentKind == kind
    val hasProviderFilter: Boolean get() = this == Codex || this == CodexDesktop
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
    onRequestProviders: () -> Unit,
) {
    var expanded by remember { mutableStateOf(false) }
    var showProviders by remember { mutableStateOf(false) }
    val filterLabel = if (selected.hasProviderFilter) {
        "${selected.label}，${providerOptions.firstOrNull { it.key == providerFilterKey }?.label.orEmpty()}"
    } else selected.label
    Box {
        NeumorphIconButton(
            onClick = { showProviders = false; expanded = true; if (selected.hasProviderFilter) onRequestProviders() },
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
                    text = { Text("${selected.label}，provider") },
                    leadingIcon = { Icon(Icons.Rounded.ArrowBack, contentDescription = "返回会话筛选", modifier = Modifier.size(18.dp)) },
                    onClick = { showProviders = false },
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
                        if (filter.hasProviderFilter) { showProviders = true; onRequestProviders() } else expanded = false
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
                            if (filter.hasProviderFilter) Icon(Icons.Rounded.ChevronRight, contentDescription = "${filter.label}：按 provider 筛选")
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

/** One Host's slice of the merged sidebar tree. */
private data class DrawerHostSection(
    val hostId: String,
    val hostName: String,
    val directories: List<CachedDirectoryGroup>,
)

/** Host context, raised directory headers, and inset session leaves each have their own level. */
@Composable
internal fun SessionDrawer(
    state: RemoteState,
    hosts: List<HostSnapshot>,
    onSelectHost: (String) -> Unit,
    onUnpairHost: (String) -> Unit,
    onAddHost: () -> Unit,
    onOpenSession: (String, String) -> Unit,
    onOpenHistory: (String, String) -> Unit,
    onNewSession: (String, String?) -> Unit,
    onSetArchived: (String, String, Boolean) -> Unit,
    onRequestProviders: () -> Unit = {},
) {
    val tree = remember(hosts) {
        cachedHistoryTree(hosts.map { it.state })
    }
    val activeHostId = state.hostId
    var agentFilterKey by rememberSaveable { mutableStateOf(DrawerAgentFilter.All.key) }
    val agentFilter = drawerAgentFilter(agentFilterKey)
    val currentProvider = state.currentProviders[agentFilter.key]
    val currentProviders = remember(hosts, agentFilterKey) { hosts.associate { it.hostId to it.state.currentProviders[agentFilter.key] } }
    var requestedProviderKey by rememberSaveable(activeHostId, agentFilterKey) { mutableStateOf(CURRENT_CODEX_PROVIDER) }
    val providerOptions = remember(tree, currentProvider, agentFilterKey) { codexProviderOptions(tree, currentProvider, agentFilter.key) }
    val providerKey = requestedProviderKey.takeIf { key -> providerOptions.any { it.key == key } } ?: CURRENT_CODEX_PROVIDER
    val providerLabel = providerOptions.first { it.key == providerKey }.label
    var showArchived by rememberSaveable { mutableStateOf(false) }
    var blockedSession by remember { mutableStateOf<Pair<String, String>?>(null) }
    val filteredTree = remember(tree, agentFilterKey, showArchived, providerKey, currentProviders, activeHostId) {
        tree.mapNotNull { host ->
            // Current-provider ownership is checked against this backend on the selected computer.
            // Other computers keep their rows; their defaults are independent.
            val hostProvider = if (host.hostId == activeHostId) currentProviders[host.hostId] else null
            host.copy(
                directories = host.directories.mapNotNull { directory ->
                    directory.copy(sessions = directory.sessions.filter {
                        agentFilter.matches(it) && it.isArchived == showArchived &&
                            (!agentFilter.hasProviderFilter || host.hostId != activeHostId ||
                                matchesCodexProvider(it, providerKey, hostProvider))
                    })
                        .takeIf { it.sessions.isNotEmpty() }
                },
            ).takeIf { it.directories.isNotEmpty() }
        }
    }
    var query by rememberSaveable { mutableStateOf("") }
    val searchTerm = query.trim()
    val sections = remember(filteredTree, searchTerm) {
        filteredTree.map { host ->
            DrawerHostSection(
                hostId = host.hostId,
                hostName = host.hostname,
                directories = host.directories.mapNotNull { directory ->
                    if (searchTerm.isEmpty() || directory.cwd.contains(searchTerm, ignoreCase = true)) {
                        directory
                    } else {
                        directory.sessions.filter { it.title.contains(searchTerm, ignoreCase = true) }
                            .takeIf { it.isNotEmpty() }?.let { directory.copy(sessions = it) }
                    }
                },
            )
        }.filter { it.directories.isNotEmpty() }
    }
    val directoryCount = sections.sumOf { it.directories.size }
    val sessionCount = sections.sumOf { section -> section.directories.sumOf { it.sessions.size } }
    val showHostHeaders = sections.size > 1
    // Keep only one branch open. Searching reveals the first result without losing its parent.
    var expandedKey by rememberSaveable(activeHostId, searchTerm, agentFilterKey, providerKey, currentProvider) {
        mutableStateOf(
            sections.firstOrNull()?.let { section ->
                section.directories.firstOrNull()?.let { section.hostId + '\u0000' + it.cwd }
            },
        )
    }
    var showAllSessions by rememberSaveable(activeHostId, searchTerm, agentFilterKey, providerKey, currentProvider, expandedKey) { mutableStateOf(false) }
    // Reset only when browsing a different catalog, not when restoring this page from history.
    val listState = rememberSaveable(activeHostId, searchTerm, agentFilterKey, providerKey, currentProvider, showArchived, saver = LazyListState.Saver) {
        LazyListState()
    }
    val canCreate = state.canCreateSessionOn(activeHostId)
    val focusManager = LocalFocusManager.current
    val drawerWidth = (LocalConfiguration.current.screenWidthDp.dp - 32.dp).coerceAtMost(384.dp)

    blockedSession?.let { (hostId, sessionId) ->
        val snapshot = hosts.firstOrNull { it.hostId == hostId }
        val reason = if (hostId == activeHostId) snapshot?.state?.codexProviderMismatch(sessionId) else null
        if (reason != null) NeumorphDialog(
            onDismissRequest = { blockedSession = null },
            title = { Text("需要切换 provider") },
            text = { Text(reason) },
            confirmButton = { NeumorphTextButton("知道了", { blockedSession = null }) },
            dismissButton = if (snapshot?.state?.sessions?.get(sessionId)?.hasHistoryCache == true) {
                { NeumorphTextButton("查看只读历史", { blockedSession = null; onOpenHistory(hostId, sessionId) }) }
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
                        modifier = Modifier.weight(1f),
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
                        onSelectProvider = { requestedProviderKey = it },
                        onRequestProviders = onRequestProviders,
                    )
                    NeumorphIconButton(
                        onClick = { activeHostId?.let { onNewSession(it, null) } },
                        icon = Icons.Rounded.Add,
                        contentDescription = "新建会话",
                        enabled = canCreate,
                        tint = MaterialTheme.colorScheme.primary,
                    )
                }
            if (agentFilter.hasProviderFilter) {
                Text(
                    "${agentFilter.label}，$providerLabel",
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
                    "$directoryCount 个目录，$sessionCount 个会话",
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            LazyColumn(
                state = listState,
                modifier = Modifier.fillMaxWidth().weight(1f),
                contentPadding = PaddingValues(start = 20.dp, end = 20.dp, top = 6.dp, bottom = 16.dp),
            ) {
                if (sections.isEmpty()) {
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
                                    else if (agentFilter.hasProviderFilter && providerKey == CURRENT_CODEX_PROVIDER && currentProvider == null) "尚未获取当前 provider"
                                    else if (agentFilter == DrawerAgentFilter.All) "还没有可显示的会话"
                                    else "没有${agentFilter.label}会话"
                                } else "没有找到匹配的目录或会话",
                                style = MaterialTheme.typography.bodyMedium,
                            )
                        }
                    }
                }
                sections.forEach { section ->
                    val hostSnapshot = hosts.firstOrNull { it.hostId == section.hostId }
                    val isActiveHost = section.hostId == activeHostId
                    if (showHostHeaders) {
                        item(key = "host:${section.hostId}") {
                            DrawerHostHeader(section.hostName, isActiveHost)
                        }
                    }
                    section.directories.forEach { directory ->
                        val branchKey = section.hostId + '\u0000' + directory.cwd
                        val expanded = branchKey == expandedKey
                        item(key = "directory:$branchKey") {
                            DrawerDirectoryHeader(
                                directory = directory,
                                expanded = expanded,
                                createEnabled = isActiveHost && canCreate && directory.cwd.isNotBlank(),
                                onCreate = { onNewSession(section.hostId, directory.cwd) },
                            ) {
                                expandedKey = if (expanded) null else branchKey
                                focusManager.clearFocus()
                            }
                        }
                        val visibleSessions = if (expanded && (showAllSessions || searchTerm.isNotEmpty())) {
                            directory.sessions
                        } else directory.sessions.take(5)
                        items(visibleSessions, key = { "session:${section.hostId}:${it.sessionId}" }) { row ->
                            OrbisCollapse(expanded = expanded) {
                                DrawerBranch {
                                    DrawerSessionRow(
                                        row = row,
                                        onOpenSession = {
                                            if (isActiveHost && state.codexProviderMismatch(row.sessionId) != null) {
                                                blockedSession = section.hostId to row.sessionId
                                            } else {
                                                onOpenSession(section.hostId, row.sessionId)
                                            }
                                        },
                                        onOpenHistory = { onOpenHistory(section.hostId, row.sessionId) },
                                        archiveEnabled = isActiveHost && hostSnapshot?.state?.e2eReady == true &&
                                            row.catalogEntry?.agentKind != null &&
                                            row.sessionId !in state.sessionArchiveRequests.values &&
                                            (row.isArchived || !row.isOnline ||
                                                (row.isCodex && state.runtimes[row.runtimeId]?.status == "idle") ||
                                                (row.agentKind == "dsh" && state.runtimes[row.runtimeId]?.status == "idle")),
                                        archivePending = row.sessionId in state.sessionArchiveRequests.values,
                                        onSetArchived = { onSetArchived(section.hostId, row.sessionId, !row.isArchived) },
                                    )
                                }
                            }
                        }
                        if (directory.sessions.size > 5 && searchTerm.isEmpty()) {
                            item(key = "more:$branchKey") {
                                OrbisCollapse(expanded = expanded) {
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
                        item(key = "gap:$branchKey") { Spacer(Modifier.height(14.dp)) }
                    }
                }
            }
            // 「电脑」贴着抽屉底部：它是当前所在的主机，不是列表的筛选条件。
            // 多 Host 后它同时是切换入口：点开选另一台电脑，或取消当前这台。
            if (hosts.isNotEmpty()) {
                // 细线给列表收口：页脚必须被读成列表之外的一段，而不是最后一张目录卡片。
                HorizontalDivider(
                    modifier = Modifier.padding(start = 20.dp, end = 20.dp, top = 16.dp),
                    thickness = 1.dp,
                    color = MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.6f),
                )
                DrawerHostSwitcher(
                    hosts = hosts,
                    activeHostId = activeHostId,
                    onSelectHost = onSelectHost,
                    onUnpairHost = onUnpairHost,
                    onAddHost = onAddHost,
                )
            }
        }
    }
}

/**
 * 抽屉页脚：当前电脑，同时是多 Host 的切换入口。
 *
 * 它曾经和列表共用同一条水平带、同一种凹陷材质、同样的「标签 + 值」两行结构，
 * 于是被读成又一张目录卡片。页脚不是列表里的一行，它得在三个维度上和列表断开：
 * 几何上抬到地面之上（Raised）、结构上压成单行、位置上由列表底边那条细线收口。
 * 「你正站在哪台电脑上」是底座，不是筛选条件。
 */
@Composable
private fun DrawerHostSwitcher(
    hosts: List<HostSnapshot>,
    activeHostId: String?,
    onSelectHost: (String) -> Unit,
    onUnpairHost: (String) -> Unit,
    onAddHost: () -> Unit,
) {
    var expanded by remember { mutableStateOf(false) }
    val active = hosts.firstOrNull { it.hostId == activeHostId }
    Box(
        Modifier.fillMaxWidth().padding(horizontal = 20.dp).padding(top = 12.dp, bottom = 4.dp),
    ) {
        NeumorphSurface(
            modifier = Modifier.fillMaxWidth(),
            style = NeumorphStyle.Raised,
            shape = RemoteUi.ControlShape,
            shadowScale = 0.8f,
            onClick = { expanded = true },
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
                    active?.name ?: "未连接",
                    style = MaterialTheme.typography.titleSmall,
                    modifier = Modifier.weight(1f),
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                if (hosts.size > 1) {
                    Text(
                        "${hosts.size} 台",
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                Icon(
                    Icons.Rounded.ExpandMore,
                    contentDescription = "切换电脑",
                    modifier = Modifier.size(18.dp),
                    tint = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
        NeumorphMenu(expanded = expanded, onDismissRequest = { expanded = false }) {
            hosts.forEach { host ->
                NeumorphMenuItem(
                    text = { Text(host.name) },
                    onClick = { expanded = false; onSelectHost(host.hostId) },
                    leadingIcon = {
                        if (host.hostId == activeHostId) {
                            Icon(Icons.Rounded.Check, contentDescription = "当前电脑", tint = MaterialTheme.colorScheme.primary, modifier = Modifier.size(18.dp))
                        } else {
                            Icon(Icons.Rounded.Computer, contentDescription = null, modifier = Modifier.size(18.dp))
                        }
                    },
                    trailingIcon = {
                        Text(
                            if (host.state.e2eReady) "在线" else "离线",
                            style = MaterialTheme.typography.labelSmall,
                            color = if (host.state.e2eReady) MaterialTheme.colorScheme.tertiary else MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    },
                )
            }
            HorizontalDivider()
            NeumorphMenuItem(
                text = { Text("添加电脑") },
                onClick = { expanded = false; onAddHost() },
                leadingIcon = { Icon(Icons.Rounded.Add, contentDescription = null, modifier = Modifier.size(18.dp)) },
            )
            active?.let { host ->
                NeumorphMenuItem(
                    text = { Text("取消配对「${host.name}」", color = MaterialTheme.colorScheme.error) },
                    onClick = { expanded = false; onUnpairHost(host.hostId) },
                    leadingIcon = { Icon(Icons.Rounded.Close, contentDescription = null, modifier = Modifier.size(18.dp), tint = MaterialTheme.colorScheme.error) },
                )
            }
        }
    }
}

/** Host name above its directories when the sidebar shows more than one computer. */
@Composable
private fun DrawerHostHeader(name: String, active: Boolean) {
    Row(
        Modifier.fillMaxWidth().padding(start = 4.dp, top = 8.dp, bottom = 2.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Icon(
            Icons.Rounded.Computer,
            contentDescription = null,
            modifier = Modifier.size(16.dp),
            tint = if (active) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Text(
            name,
            style = MaterialTheme.typography.labelLarge,
            fontWeight = FontWeight.SemiBold,
            color = if (active) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurface,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
        if (active) {
            Text("当前", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.primary)
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
        contentInset = 14.dp,
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
                    maxLines = 1,
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
                        if (row.agentKind == "codexDesktop") "Codex 桌面版" else if (row.agentKind == "codex") "Codex 终端" else agentBrand(row.agentKind).title,
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
                            row.isOnline && row.agentKind == "pi" -> "请先退出 Pi 会话"
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
