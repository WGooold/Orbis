package com.orbising.orbis

import androidx.activity.compose.BackHandler
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.statusBarsPadding
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
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.runtime.CompositionLocalProvider
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
import com.orbising.orbis.OrbisActionIcon as Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalDrawerSheet
import com.orbising.orbis.NeumorphTextField as OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp

internal enum class DrawerAgentFilter(
    val key: String,
    private val labelKey: String,
    private val kind: String?,
) {
    All("all", "全部", null),
    Pi("pi", "Pi", "pi"),
    Codex("codex", "Codex 终端", "codex"),
    CodexDesktop("codexDesktop", "Codex 桌面版", "codexDesktop"),
    DeepSeek("dsh", "DeepSeek", "dsh"),
    Claude("claude", "Claude Code", "claude");

    fun matches(row: CachedSessionRow): Boolean = kind == null || row.agentKind == kind
    val label: String get() = L10n.tr(labelKey)
    val hasProviderFilter: Boolean get() = this == Codex || this == CodexDesktop
}

internal fun drawerAgentFilter(key: String): DrawerAgentFilter =
    DrawerAgentFilter.values().firstOrNull { it.key == key } ?: DrawerAgentFilter.All

@Composable
private fun DrawerAgentFilterMenu(
    selected: DrawerAgentFilter,
    onSelect: (DrawerAgentFilter) -> Unit,
    providerOptions: List<CodexProviderOption>,
    providerFilterKey: String,
    onSelectProvider: (String) -> Unit,
    onRequestProviders: () -> Unit,
) {
    var expanded by remember { mutableStateOf(false) }
    var showProviders by remember { mutableStateOf(false) }
    val filterLabel = if (selected.hasProviderFilter) {
        L10n.tr("{0}，{1}", selected.label, providerOptions.firstOrNull { it.key == providerFilterKey }?.label.orEmpty())
    } else selected.label
    Box {
        NeumorphIconButton(
            onClick = { showProviders = false; expanded = true; if (selected.hasProviderFilter) onRequestProviders() },
            icon = OrbisSymbols.FilterList,
            contentDescription = L10n.tr("筛选会话：{0}", filterLabel),
            tint = if (selected == DrawerAgentFilter.All) {
                MaterialTheme.colorScheme.onSurfaceVariant
            } else {
                MaterialTheme.colorScheme.primary
            },
        )
        NeumorphMenu(expanded = expanded, onDismissRequest = { expanded = false },
            page = if (showProviders) listOf("providers") else emptyList(),
            onBack = { showProviders = false }) { renderedPage ->
            if (renderedPage.isNotEmpty()) {
                NeumorphMenuItem(
                    text = { Text(L10n.tr("{0}，provider", selected.label)) },
                    leadingIcon = { Icon(OrbisSymbols.ArrowBack, contentDescription = L10n.tr("返回会话筛选"), modifier = Modifier.size(18.dp)) },
                    onClick = { showProviders = false },
                )
                providerOptions.forEach { option ->
                    NeumorphMenuItem(
                        text = { Text(option.label) },
                        onClick = { onSelectProvider(option.key); expanded = false },
                        trailingIcon = if (option.key == providerFilterKey) {
                            { Icon(OrbisSymbols.Check, contentDescription = L10n.tr("当前 provider 筛选"), tint = MaterialTheme.colorScheme.primary) }
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
                            Icon(OrbisSymbols.FilterList, contentDescription = null, modifier = Modifier.size(18.dp))
                        } else {
                            AgentIcon(agentBrand(filter.key), Modifier.size(18.dp))
                        }
                    },
                    trailingIcon = {
                        Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                            if (filter == selected) Icon(OrbisSymbols.Check, contentDescription = L10n.tr("当前筛选"), tint = MaterialTheme.colorScheme.primary)
                            if (filter.hasProviderFilter) Icon(OrbisSymbols.ChevronRight, contentDescription = L10n.tr("{0}：按 provider 筛选", filter.label))
                        }
                    },
                )
            }
            }
        }
    }
}

/** The lazy items and viewport keys must describe exactly the same rows, including closed slots. */
private data class DrawerDirectoryItems(
    val hostId: String,
    val directory: CachedDirectoryGroup,
    val branchKey: String,
    val expanded: Boolean,
    val sessions: List<CachedSessionRow>,
    val hasMore: Boolean,
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
    isOpen: Boolean = true,
    preparedCatalog: List<CachedHostGroup>? = null,
    permanent: Boolean = false,
) {
    val activeHostId = state.hostId
    // 只列当前电脑的目录：多台电脑不合并成一棵树，切换在页脚的电脑行（ADR-0030 修订）。
    val activeHostState = hosts.firstOrNull { it.hostId == activeHostId }?.state
    var agentFilterKey by rememberSaveable { mutableStateOf(DrawerAgentFilter.All.key) }
    val agentFilter = drawerAgentFilter(agentFilterKey)
    val currentProvider = state.currentProviders[agentFilter.key]
    val hostProvider = activeHostState?.currentProviders?.get(agentFilter.key)
    var requestedProviderKey by rememberSaveable(activeHostId, agentFilterKey) { mutableStateOf(CURRENT_CODEX_PROVIDER) }
    var showArchived by rememberSaveable { mutableStateOf(false) }
    var blockedSession by remember { mutableStateOf<Pair<String, String>?>(null) }
    var query by rememberSaveable { mutableStateOf("") }
    val searchTerm = query.trim()
    val request = DrawerCatalogRequest(activeHostState, AppLocalization.language, DrawerCatalogFilter(
        agentFilterKey, showArchived, requestedProviderKey, currentProvider, hostProvider, searchTerm), preparedCatalog)
    val projection = rememberDrawerCatalog(request)
    val providerOptions = projection?.options ?: codexProviderOptions(emptyList(), currentProvider, agentFilter.key)
    val providerKey = projection?.providerKey ?: requestedProviderKey
    val providerLabel = providerOptions.firstOrNull { it.key == providerKey }?.label.orEmpty()
    // Reset only when browsing a different catalog, not when restoring this page from history.
    val listState = rememberSaveable(activeHostId, searchTerm, agentFilterKey, providerKey, currentProvider, showArchived, saver = LazyListState.Saver) {
        LazyListState()
    }
    val viewportIdentity = remember(activeHostId, searchTerm, agentFilterKey, providerKey, currentProvider, showArchived) {
        listOf(activeHostId, searchTerm, agentFilterKey, providerKey, currentProvider, showArchived)
    }
    val emptyContent = remember { DrawerCatalogContent(emptyList()) }
    val content = rememberDrawerViewport(projection?.content ?: emptyContent, listState, viewportIdentity)
    val sections = content.sections
    val directoryCount = content.directoryCount
    val visibleSessions = content.sessions
    val sessionCount = visibleSessions.size
    var selectedSessionIds by remember(activeHostId, searchTerm, agentFilterKey, providerKey, currentProvider, showArchived, isOpen) {
        mutableStateOf(emptySet<String>())
    }
    val visibleIds = content.ids
    val selectedIds = remember(selectedSessionIds, visibleIds) { selectedSessionIds.intersect(visibleIds) }
    val selectedSessions = remember(visibleSessions, selectedIds) { visibleSessions.filter { it.sessionId in selectedIds } }
    val selecting = selectedIds.isNotEmpty()
    LaunchedEffect(visibleIds) { selectedSessionIds = selectedSessionIds.intersect(visibleIds) }
    BackHandler(enabled = LocalPageActive.current && isOpen && selecting) { selectedSessionIds = emptySet() }
    // Keep only one branch open. Searching reveals the first result without losing its parent.
    var expandedKey by rememberSaveable(activeHostId, searchTerm, agentFilterKey, providerKey, currentProvider) {
        mutableStateOf(
            sections.firstOrNull()?.let { section ->
                section.directories.firstOrNull()?.let { section.hostId + '\u0000' + it.cwd }
            },
        )
    }
    var needsDefaultExpansion by rememberSaveable(activeHostId, searchTerm, agentFilterKey, providerKey, currentProvider) {
        mutableStateOf(true)
    }
    val firstDirectoryKey = sections.firstOrNull()?.let { section ->
        section.directories.firstOrNull()?.let { section.hostId + '\u0000' + it.cwd }
    }
    LaunchedEffect(firstDirectoryKey, needsDefaultExpansion) {
        if (needsDefaultExpansion && firstDirectoryKey != null) {
            if (expandedKey == null) expandedKey = firstDirectoryKey
            needsDefaultExpansion = false
        }
    }
    var showAllSessions by rememberSaveable(activeHostId, searchTerm, agentFilterKey, providerKey, currentProvider, expandedKey) { mutableStateOf(false) }
    var showAllDirectories by rememberSaveable(viewportIdentity) { mutableStateOf(false) }
    val allDirectoryItems = remember(sections, expandedKey, showAllSessions, searchTerm) {
        sections.flatMap { section -> section.directories.map { directory ->
            val branchKey = section.hostId + '\u0000' + directory.cwd
            val expanded = branchKey == expandedKey
            DrawerDirectoryItems(section.hostId, directory, branchKey, expanded,
                if (expanded && (showAllSessions || searchTerm.isNotEmpty())) directory.sessions else directory.sessions.take(3),
                directory.sessions.size > 3 && searchTerm.isEmpty())
        } }
    }
    val directoryItems = if (showAllDirectories || searchTerm.isNotEmpty()) allDirectoryItems else allDirectoryItems.take(3)
    val viewportKeys = remember(directoryItems, allDirectoryItems.size, searchTerm) {
        buildList {
            directoryItems.forEach { branch ->
                add("directory:${branch.branchKey}")
                branch.sessions.forEach { add("session:${branch.hostId}:${it.sessionId}") }
                add("more:${branch.branchKey}")
                add("gap:${branch.branchKey}")
            }
            if (allDirectoryItems.size > 3 && searchTerm.isEmpty()) add("directory-preview-more")
        }
    }
    val panelKeys = remember(directoryItems) {
        directoryItems.map { branch -> buildList {
            add("directory:${branch.branchKey}")
            branch.sessions.forEach { add("session:${branch.hostId}:${it.sessionId}") }
            add("more:${branch.branchKey}")
        } }
    }
    val canCreate = state.canCreateSessionOn(activeHostId)
    val focusManager = LocalFocusManager.current
    val haptic = LocalHapticFeedback.current
    val drawerWidth = (LocalConfiguration.current.screenWidthDp.dp * 0.85f).coerceAtMost(320.dp)

    blockedSession?.let { (hostId, sessionId) ->
        val snapshot = hosts.firstOrNull { it.hostId == hostId }
        val reason = if (hostId == activeHostId) snapshot?.state?.codexProviderMismatch(sessionId) else null
        if (reason != null) NeumorphDialog(
            onDismissRequest = { blockedSession = null },
            title = { MotionText(L10n.tr("需要切换 provider")) },
            text = { MotionText(reason) },
            confirmButton = { NeumorphTextButton(L10n.tr("知道了"), { blockedSession = null }) },
            dismissButton = if (snapshot?.state?.sessions?.get(sessionId)?.hasHistoryCache == true) {
                { NeumorphTextButton(L10n.tr("查看只读历史"), { blockedSession = null; onOpenHistory(hostId, sessionId) }) }
            } else null,
        )
    }

    DrawerPanel(modifier = Modifier.width(if (permanent) 320.dp else drawerWidth), permanent = permanent) {
        Column(
            Modifier.fillMaxSize()
                .imePadding()
                .padding(horizontal = 16.dp, vertical = 8.dp),
        ) {
            Row(
                Modifier.fillMaxWidth().padding(bottom = 8.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(4.dp),
                ) {
                    OutlinedTextField(
                        value = query,
                        onValueChange = { query = it },
                        modifier = Modifier.weight(1f),
                        placeholder = { MotionText(L10n.tr("搜索目录或会话"), style = MaterialTheme.typography.bodyMedium) },
                        leadingIcon = { Icon(OrbisSymbols.Search, contentDescription = null, modifier = Modifier.size(20.dp)) },
                        trailingIcon = if (query.isNotEmpty()) {
                        {
                            NeumorphIconButton(
                                onClick = { query = "" },
                                icon = OrbisSymbols.Close,
                                contentDescription = L10n.tr("清除搜索"),
                                size = 28.dp,
                            )
                        }
                    } else null,
                    singleLine = true,
                    textStyle = MaterialTheme.typography.bodyMedium,
                    keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
                    keyboardActions = KeyboardActions(onSearch = { focusManager.clearFocus() }),
                        colors = neumorphFieldColors(),
                        shape = androidx.compose.foundation.shape.RoundedCornerShape(12.dp),
                    )
                    NeumorphIconButton(
                        onClick = { showArchived = !showArchived },
                        icon = if (showArchived) Icons.Rounded.Archive else OrbisSymbols.Archive,
                        contentDescription = if (showArchived) L10n.tr("查看未归档会话") else L10n.tr("查看已归档会话"),
                        modifier = Modifier.testTag("drawer-archive-toggle").semantics { selected = showArchived },
                        tint = if (showArchived) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant,
                        style = if (showArchived) NeumorphStyle.Pressed else NeumorphStyle.Raised,
                    )
                    DrawerAgentFilterMenu(
                        selected = agentFilter,
                        onSelect = { agentFilterKey = it.key },
                        providerOptions = providerOptions,
                        providerFilterKey = providerKey,
                        onSelectProvider = { requestedProviderKey = it },
                        onRequestProviders = onRequestProviders,
                    )

                }
            if (agentFilter.hasProviderFilter) {
                MotionText(
                    L10n.tr("{0}，{1}", agentFilter.label, providerLabel),
                    modifier = Modifier.fillMaxWidth().padding(horizontal = 24.dp, vertical = 4.dp),
                    style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.primary,
                )
            }
            Row(
                Modifier.fillMaxWidth().padding(vertical = 8.dp).heightIn(min = RemoteUi.TouchTarget),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.SpaceBetween,
            ) {
                SelectionToolbar(selecting = selecting, normal = {

                    MotionText(
                        if (searchTerm.isNotEmpty()) L10n.tr("搜索结果") else if (showArchived) L10n.tr("已归档") else L10n.tr("工作目录"),
                        style = MaterialTheme.typography.labelMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.weight(1f).semantics { heading() },
                    )
                    MotionText(
                        L10n.tr("{0} 个目录", directoryCount),
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }, selected = {

                    NeumorphIconButton(
                        onClick = { selectedSessionIds = emptySet() },
                        icon = OrbisSymbols.Close,
                        contentDescription = L10n.tr("退出多选"),
                    )
                    MotionText(L10n.tr("已选择 {0} 项", selectedIds.size), style = MaterialTheme.typography.labelLarge,
                        modifier = Modifier.weight(1f))
                    selectedSessions.singleOrNull()?.takeIf { !it.isOnline && it.catalogEntry?.hasHistoryCache == true }?.let { row ->
                        NeumorphIconButton(
                            onClick = { activeHostId?.let { onOpenHistory(it, row.sessionId) }; selectedSessionIds = emptySet() },
                            icon = OrbisSymbols.History,
                            contentDescription = L10n.tr("查看只读历史"),
                        )
                    }
                    NeumorphIconButton(
                        onClick = {
                            val hostId = activeHostId
                            if (hostId != null && selectedSessions.all { drawerArchiveUnavailableReason(it, state) == null }) {
                                selectedSessions.forEach { onSetArchived(hostId, it.sessionId, !showArchived) }
                                selectedSessionIds = emptySet()
                            }
                        },
                        icon = if (showArchived) Icons.Rounded.Unarchive else OrbisSymbols.Archive,
                        contentDescription = if (showArchived) L10n.tr("恢复选中会话") else L10n.tr("归档选中会话"),
                        enabled = selectedSessions.all { drawerArchiveUnavailableReason(it, state) == null },
                        tint = MaterialTheme.colorScheme.primary,
                    )
                })
            }
            maintainListViewport(listState, viewportKeys, listOf(viewportIdentity, expandedKey, showAllSessions), preserveStationaryItems = true)
            LazyColumn(
                state = listState,
                modifier = Modifier.fillMaxWidth().weight(1f).testTag("drawer-session-list"),
                contentPadding = PaddingValues(top = 4.dp, bottom = 16.dp),
            ) {
                if (sections.isEmpty()) {
                    item(contentType = "empty") {
                        Column(
                            Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 28.dp),
                            horizontalAlignment = Alignment.CenterHorizontally,
                            verticalArrangement = Arrangement.spacedBy(8.dp),
                        ) {
                            Icon(
                                if (searchTerm.isEmpty()) OrbisSymbols.FolderFill else OrbisSymbols.Search,
                                contentDescription = null,
                                modifier = Modifier.size(32.dp),
                                tint = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                            Text(
                                if (searchTerm.isEmpty()) {
                                    if (showArchived) L10n.tr("没有已归档的会话")
                                    else if (agentFilter.hasProviderFilter && providerKey == CURRENT_CODEX_PROVIDER && currentProvider == null) L10n.tr("尚未获取当前 provider")
                                    else if (agentFilter == DrawerAgentFilter.All) L10n.tr("还没有可显示的会话")
                                    else L10n.tr("没有{0}会话", agentFilter.label)
                                } else L10n.tr("没有找到匹配的目录或会话"),
                                style = MaterialTheme.typography.bodyMedium,
                            )
                        }
                    }
                }
                directoryItems.forEach { branch ->
                    val (hostId, directory, branchKey, expanded) = branch
                    val isActiveHost = hostId == activeHostId
                    item(key = "directory:$branchKey", contentType = "directory") {
                        Box { DrawerDirectorySlice { DrawerDirectoryHeader(
                            directory = directory,
                            expanded = expanded,
                            createEnabled = isActiveHost && canCreate && directory.cwd.isNotBlank(),
                            onCreate = { onNewSession(hostId, directory.cwd) },
                        ) {
                            needsDefaultExpansion = false
                            expandedKey = if (expanded) null else branchKey
                            focusManager.clearFocus()
                        } } }
                    }
                    itemsIndexed(branch.sessions, key = { _, row -> "session:$hostId:${row.sessionId}" }, contentType = { _, _ -> "session" }) { index, row ->
                        Box { DrawerDirectorySlice { OrbisCollapse(expanded = expanded) {
                            DrawerBranch(first = index == 0, last = false) {
                                DrawerSessionRow(
                                    row = row,
                                    runtimeStatus = row.runtimeId?.let(state.runtimes::get)?.presentationStatus,
                                    runtimeStatusTitle = row.runtimeId?.let(state.runtimes::get)?.presentationTitle,
                                    otherProvider = sessionOtherProvider(row, state.currentProviders[row.agentKind]),
                                    onOpenSession = {
                                        if (isActiveHost && state.codexProviderMismatch(row.sessionId) != null) {
                                            blockedSession = hostId to row.sessionId
                                        } else {
                                            onOpenSession(hostId, row.sessionId)
                                        }
                                    },
                                    onOpenHistory = { onOpenHistory(hostId, row.sessionId) },
                                    selecting = selecting,
                                    selected = row.sessionId in selectedIds,
                                    archiveUnavailableReason = drawerArchiveUnavailableReason(row, state),
                                    onToggleSelection = {
                                        haptic.performHapticFeedback(HapticFeedbackType.TextHandleMove)
                                        selectedSessionIds = if (row.sessionId in selectedIds) selectedIds - row.sessionId else selectedIds + row.sessionId
                                    },
                                    onBeginSelection = {
                                        if (row.sessionId !in selectedIds) haptic.performHapticFeedback(HapticFeedbackType.TextHandleMove)
                                        focusManager.clearFocus()
                                        selectedSessionIds = selectedIds + row.sessionId
                                    },
                                )
                            }
                        } } }
                    }
                    run {
                        item(key = "more:$branchKey", contentType = "more") {
                            DrawerDirectorySlice { OrbisCollapse(expanded = expanded) {
                                DrawerBranch(first = branch.sessions.isEmpty(), last = true) {
                                    Column(Modifier.fillMaxWidth()) {
                                        if (branch.hasMore) {

                                            Row(Modifier.fillMaxWidth().heightIn(min = 48.dp)
                                                .orbisKeyboardFocus().clickable(interactionSource = remember { MutableInteractionSource() }, indication = null) { showAllSessions = !showAllSessions },
                                                verticalAlignment = Alignment.CenterVertically) {
                                                Text(if (showAllSessions) L10n.tr("收起较早会话") else L10n.tr("查看全部 {0} 条", directory.sessions.size),
                                                    modifier = Modifier.weight(1f), style = MaterialTheme.typography.labelLarge,
                                                    color = MaterialTheme.colorScheme.primary)
                                                Icon(if (showAllSessions) Icons.Rounded.ExpandLess else OrbisSymbols.ChevronRight,
                                                    contentDescription = null, tint = MaterialTheme.colorScheme.primary, modifier = Modifier.size(18.dp))
                                            }
                                        }
                                        if (directory.cwd.isNotBlank()) {
                                            Row(Modifier.fillMaxWidth().heightIn(min = 48.dp)
                                                .semantics { contentDescription = L10n.tr("在此目录新建会话") }
                                                .orbisKeyboardFocus().clickable(enabled = isActiveHost && canCreate, interactionSource = remember { MutableInteractionSource() }, indication = null) {
                                                    onNewSession(hostId, directory.cwd)
                                                }, verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                                Icon(OrbisSymbols.Add, null, tint = MaterialTheme.colorScheme.primary, modifier = Modifier.size(16.dp))
                                                Text(L10n.tr("新建会话"), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.primary)
                                            }
                                        }
                                    }
                                }
                            } }
                        }
                    }
                    item(key = "gap:$branchKey", contentType = "gap") { Spacer(Modifier.height(8.dp)) }
                }
                if (allDirectoryItems.size > 3 && searchTerm.isEmpty()) {
                    item(key = "directory-preview-more", contentType = "directory-more") {
                        Row(Modifier.fillMaxWidth().heightIn(min = 48.dp).padding(horizontal = 6.dp)
                            .orbisKeyboardFocus().clickable(interactionSource = remember { MutableInteractionSource() }, indication = null) { showAllDirectories = !showAllDirectories },
                            verticalAlignment = Alignment.CenterVertically) {
                            Text(if (showAllDirectories) L10n.tr("收起工作目录") else L10n.tr("查看全部 {0} 个工作目录", directoryCount),
                                modifier = Modifier.weight(1f), style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.primary)
                            Icon(if (showAllDirectories) Icons.Rounded.ExpandLess else OrbisSymbols.ChevronRight,
                                contentDescription = null, tint = MaterialTheme.colorScheme.primary, modifier = Modifier.size(18.dp))
                        }
                    }
                }
            }
            // 「电脑」贴着抽屉底部：它是当前所在的主机，不是列表的筛选条件。
            // 多 Host 后它同时是切换入口：点开选另一台电脑，或取消当前这台。
            if (hosts.isNotEmpty()) {
                // 细线给列表收口：页脚必须被读成列表之外的一段，而不是最后一张目录卡片。
                HorizontalDivider(
                    modifier = Modifier.padding(start = 12.dp, end = 12.dp, top = 10.dp),
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

/** Keep the drawer ground, controls, and recesses in the same scoped material. */
@Composable
private fun DrawerPanel(modifier: Modifier = Modifier, permanent: Boolean = false, content: @Composable () -> Unit) {
    OrbisMaterialTheme {
        if (permanent) Box(modifier.fillMaxHeight().statusBarsPadding().background(MaterialTheme.colorScheme.surface).testTag("drawer-panel")) { content() }
        else         ModalDrawerSheet(
            modifier = modifier.background(MaterialTheme.colorScheme.background, MaterialTheme.shapes.extraLarge).testTag("drawer-panel"),
            drawerShape = MaterialTheme.shapes.extraLarge,
            drawerTonalElevation = 0.dp,
            drawerContainerColor = MaterialTheme.colorScheme.background,
            content = { content() },
        )
    }
}

/** Current host footer: raised icon, two-line identity/status, with existing host actions. */
@Composable
private fun DrawerHostSwitcher(
    hosts: List<HostSnapshot>,
    activeHostId: String?,
    onSelectHost: (String) -> Unit,
    onUnpairHost: (String) -> Unit,
    onAddHost: () -> Unit,
) {
    var expanded by remember { mutableStateOf(false) }
    var computers by remember { mutableStateOf(false) }
    var pendingUnpair by remember { mutableStateOf<HostSnapshot?>(null) }
    LaunchedEffect(activeHostId, hosts.map { it.hostId }) { expanded = false; computers = false }
    val active = hosts.firstOrNull { it.hostId == activeHostId }
    Box(
        Modifier.fillMaxWidth().padding(top = 8.dp, bottom = 4.dp),
    ) {
        Box(
            modifier = Modifier.fillMaxWidth().orbisKeyboardFocus().clickable(interactionSource = remember { MutableInteractionSource() }, indication = null) { computers = false; expanded = true },
        ) {
            Row(
                Modifier.fillMaxWidth().heightIn(min = RemoteUi.TouchTarget).padding(horizontal = 8.dp, vertical = 8.dp),
                horizontalArrangement = Arrangement.spacedBy(10.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Icon(OrbisSymbols.Computer, null, Modifier.size(20.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Text(active?.name ?: L10n.tr("未连接"), style = MaterialTheme.typography.titleSmall,
                        maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                        Box(Modifier.size(5.dp).background(if (active?.state?.e2eReady == true) MaterialTheme.colorScheme.tertiary else MaterialTheme.colorScheme.onSurfaceVariant, CircleShape))
                        Text(if (active?.state?.e2eReady == true) L10n.tr("已连接") else L10n.tr("离线"),
                            style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
                if (hosts.size > 1) {
                    Text(
                        L10n.tr("{0} 台", hosts.size),
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                Icon(
                    OrbisSymbols.ChevronRight,
                    contentDescription = if (hosts.size > 1) L10n.tr("切换电脑") else null,
                    modifier = Modifier.size(18.dp),
                    tint = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
        NeumorphMenu(expanded = expanded, onDismissRequest = { expanded = false },
            page = if (computers) listOf("computers") else emptyList(), onBack = { computers = false }) { renderedPage ->
            if (renderedPage.isNotEmpty()) {
            NeumorphMenuItem(text = { Text(L10n.tr("返回电脑菜单")) }, onClick = { computers = false },
                leadingIcon = { Icon(OrbisSymbols.ArrowBack, contentDescription = null) })
            hosts.forEach { host ->
                NeumorphMenuItem(
                    text = { Text(host.name) },
                    onClick = { expanded = false; onSelectHost(host.hostId) },
                    leadingIcon = {
                        if (host.hostId == activeHostId) {
                            Icon(OrbisSymbols.Check, contentDescription = L10n.tr("当前电脑"), tint = MaterialTheme.colorScheme.primary, modifier = Modifier.size(18.dp))
                        } else {
                            Icon(OrbisSymbols.Computer, contentDescription = null, modifier = Modifier.size(18.dp))
                        }
                    },
                    trailingIcon = {
                        Text(
                            if (host.state.e2eReady) L10n.tr("在线") else L10n.tr("离线"),
                            style = MaterialTheme.typography.labelSmall,
                            color = if (host.state.e2eReady) MaterialTheme.colorScheme.tertiary else MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    },
                )
            }
            } else {
            NeumorphMenuItem(text = { Text(L10n.tr("切换电脑")) }, onClick = { computers = true },
                leadingIcon = { Icon(OrbisSymbols.Computer, contentDescription = null) })
            NeumorphMenuItem(
                text = { Text(L10n.tr("添加电脑")) },
                onClick = { expanded = false; onAddHost() },
                leadingIcon = { Icon(OrbisSymbols.Add, contentDescription = null, modifier = Modifier.size(18.dp)) },
            )
            active?.let { host ->
                NeumorphMenuItem(
                    text = { Text(L10n.tr("取消配对「{0}」", host.name), color = MaterialTheme.colorScheme.error) },
                    onClick = { expanded = false; pendingUnpair = host },
                    leadingIcon = { Icon(OrbisSymbols.Close, contentDescription = null, modifier = Modifier.size(18.dp), tint = MaterialTheme.colorScheme.error) },
                )
            }
            }
        }
    }
    pendingUnpair?.let { host ->
        NeumorphDialog(onDismissRequest = { pendingUnpair = null },
            title = { Text(L10n.tr("取消配对 {0}？", host.name)) },
            text = { Text(L10n.tr("将移除本机配对与草稿")) },
            confirmButton = { NeumorphTextButton(L10n.tr("取消配对"), { pendingUnpair = null; onUnpairHost(host.hostId) }, danger = true) },
            dismissButton = { NeumorphTextButton(L10n.tr("保留"), { pendingUnpair = null }) })
    }

}

@Composable
private fun DrawerDirectoryHeader(directory: CachedDirectoryGroup, expanded: Boolean, createEnabled: Boolean,
    onCreate: () -> Unit, onClick: () -> Unit) {
    val rotation by animateFloatAsState(if (expanded) 90f else 0f,
        androidx.compose.animation.core.tween(InteractionMotion.duration(InteractionMotion.Collapse)), label = "directory-disclosure")
    NeumorphSurface(Modifier.fillMaxWidth().testTag("drawer-directory-${directory.cwd}")
        .semantics { stateDescription = if (expanded) L10n.tr("已展开") else L10n.tr("已收起") },
        shape = androidx.compose.foundation.shape.RoundedCornerShape(12.dp), shadowScale = 0.4f, onClick = onClick, flat = true) {
        Row(Modifier.fillMaxWidth().heightIn(min = 48.dp).padding(horizontal = 8.dp), verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Icon(if (expanded) OrbisSymbols.FolderFill else OrbisSymbols.Folder, null, modifier = Modifier.size(20.dp),
                tint = if (expanded) MaterialTheme.colorScheme.onSurface else MaterialTheme.colorScheme.onSurfaceVariant)
            Text(directoryDisplayName(directory.cwd).ifBlank { L10n.tr("未记录目录") }, Modifier.weight(1f),
                style = MaterialTheme.typography.titleSmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text("${directory.sessions.size}", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Icon(OrbisSymbols.ChevronRight, if (expanded) L10n.tr("收起目录") else L10n.tr("展开目录"),
                modifier = Modifier.size(16.dp).rotate(rotation), tint = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

/** Navigation rows stay on the drawer face; only a press or current selection indents them. */
@Composable
private fun DrawerDirectorySlice(content: @Composable () -> Unit) {
    CompositionLocalProvider(LocalOrbisSurface provides OrbisSurfaceContext(0, 2, 12.dp)) { content() }
}

@Composable
private fun DrawerBranch(first: Boolean, last: Boolean, content: @Composable () -> Unit) {
    val hairline = MaterialTheme.colorScheme.outlineVariant
    Box(Modifier.fillMaxWidth().padding(start = 16.dp).drawBehind {
        drawLine(hairline, Offset.Zero, Offset(0f, size.height), strokeWidth = 1.dp.toPx())
    }.padding(start = 16.dp, bottom = if (last) 8.dp else 0.dp)) { content() }
}

@Composable
private fun DrawerSessionRow(row: CachedSessionRow, runtimeStatus: String?, runtimeStatusTitle: String? = null,
    otherProvider: String?, onOpenSession: () -> Unit, onOpenHistory: () -> Unit, selecting: Boolean,
    selected: Boolean, archiveUnavailableReason: String?, onToggleSelection: () -> Unit, onBeginSelection: () -> Unit) {
    NeumorphSurface(Modifier.fillMaxWidth().testTag("drawer-session-${row.sessionId}")
        .semantics(mergeDescendants = true) { this.selected = selected; if (otherProvider != null) contentDescription = L10n.tr("{0}，{1}", row.title, otherProvider) },
        selectionSelected = selected, selectionMode = selecting, shape = androidx.compose.foundation.shape.RoundedCornerShape(12.dp),
        shadowScale = 0.4f, flat = true, onClick = {
            if (selecting) onToggleSelection() else if (!row.isArchived) onOpenSession()
            else if (row.catalogEntry?.hasHistoryCache == true) onOpenHistory() else onBeginSelection()
        }, onLongClick = onBeginSelection) {
        Row(Modifier.fillMaxWidth().heightIn(min = 48.dp).padding(end = 4.dp), verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            AgentIcon(agentBrand(row.agentKind), Modifier.size(16.dp))
            Text(row.title, Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis,
                style = MaterialTheme.typography.labelMedium)
            if (selecting && archiveUnavailableReason != null) Text(archiveUnavailableReason,
                style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1,
                modifier = Modifier.width(56.dp), overflow = TextOverflow.Ellipsis)
            else if (runtimeStatus != null && runtimeStatus !in setOf("idle", "unknown")) RuntimeStatusIndicator(runtimeStatus, runtimeStatusTitle)
            else if (row.modifiedAt > 0) Text(sessionTimeText(row.modifiedAt), style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1)
            OrbisSelectionIndicator(selected, selecting)
        }
    }
}

private fun drawerArchiveUnavailableReason(row: CachedSessionRow, state: RemoteState): String? = when {
    !state.e2eReady -> L10n.tr("连接电脑后可操作")
    row.catalogEntry?.agentKind == null -> L10n.tr("尚未获取会话类型")
    row.sessionId in state.archivingSessionIds -> L10n.tr("处理中…")
    row.isArchived || !row.isOnline -> null
    row.agentKind == "pi" -> L10n.tr("请先退出 Pi 会话")
    row.agentKind == "claude" -> L10n.tr("请先退出 Claude Code 会话")
    (row.isCodex || row.agentKind == "dsh") && state.runtimes[row.runtimeId]?.status == "idle" -> null
    else -> L10n.tr("等待任务完成后归档")
}

internal fun directoryDisplayName(cwd: String): String =
    cwd.trimEnd('/', '\\')
        .substringAfterLast('/')
        .substringAfterLast('\\')
        .takeIf(String::isNotBlank)
        ?: cwd
