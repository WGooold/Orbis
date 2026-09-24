package dev.pi.remote

import androidx.compose.material3.TextButton

import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.animation.expandVertically
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.shrinkVertically
import androidx.compose.foundation.background
import androidx.compose.foundation.Image
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.Add
import androidx.compose.material.icons.rounded.ArrowBack
import androidx.compose.material.icons.rounded.ArrowDownward
import androidx.compose.material.icons.rounded.ArrowUpward
import androidx.compose.material.icons.rounded.AttachFile
import androidx.compose.material.icons.rounded.Build
import androidx.compose.material.icons.rounded.ChevronRight
import androidx.compose.material.icons.rounded.CheckCircle
import androidx.compose.material.icons.rounded.Download
import androidx.compose.material.icons.rounded.Close
import androidx.compose.material.icons.rounded.Delete
import androidx.compose.material.icons.rounded.Edit
import androidx.compose.material.icons.rounded.ErrorOutline
import androidx.compose.material.icons.rounded.Computer
import androidx.compose.material.icons.rounded.ExpandLess
import androidx.compose.material.icons.rounded.ExpandMore
import androidx.compose.material.icons.rounded.InsertDriveFile
import androidx.compose.material.icons.rounded.Folder
import androidx.compose.material.icons.rounded.History
import androidx.compose.material.icons.rounded.Info
import androidx.compose.material.icons.rounded.KeyboardArrowDown
import androidx.compose.material.icons.rounded.Link
import androidx.compose.material.icons.rounded.Menu
import androidx.compose.material.icons.rounded.MoreVert
import androidx.compose.material.icons.rounded.Psychology
import androidx.compose.material.icons.rounded.QrCodeScanner
import androidx.compose.material.icons.rounded.Refresh
import androidx.compose.material.icons.rounded.Send
import androidx.compose.material.icons.rounded.Settings
import androidx.compose.material.icons.rounded.StopCircle
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.selection.toggleable
import androidx.compose.ui.semantics.Role
import dev.pi.remote.NeumorphDialog as AlertDialog
import androidx.compose.material3.Badge
import androidx.compose.material3.CircularProgressIndicator
import dev.pi.remote.NeumorphMenu as DropdownMenu
import dev.pi.remote.NeumorphMenuItem as DropdownMenuItem
import androidx.compose.material3.DrawerValue
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.material3.ModalNavigationDrawer
import dev.pi.remote.NeumorphTextField as OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import dev.pi.remote.RemoteTopAppBar as TopAppBar
import androidx.compose.material3.rememberDrawerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.snapshotFlow
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.saveable.rememberSaveableStateHolder
import androidx.compose.foundation.rememberScrollState
import androidx.compose.runtime.setValue
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.foundation.layout.widthIn
import kotlin.math.max
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.repeatOnLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 1)
        }
        setContent {
            PiRemoteTheme {
                val model: RemoteViewModel = viewModel()
                val state by model.state.collectAsStateWithLifecycle()
                RemoteApp(state, model)
            }
        }
    }
}

@Composable
private fun RemoteApp(state: RemoteState, model: RemoteViewModel) {
    val appearsPaired = state.deviceId != null || state.connection != RelayConnection.OFFLINE
    var allDownloadsOpen by rememberSaveable { mutableStateOf(false) }
    var statusOpen by rememberSaveable { mutableStateOf(false) }
    var settingsOpen by rememberSaveable { mutableStateOf(false) }
    // 新建会话面板：newSessionOpen 管可见性，newSessionCwd 只在「目录捷径」模式下带预设目录。
    // 两者必须分开——抽屉头的「新会话」按钮带上来的 cwd 就是 null（它意在让你先浏览目录），
    // 若拿 cwd != null 当可见性判据，面板永远不会出现（抽屉收回、什么也没发生）。
    var newSessionOpen by rememberSaveable { mutableStateOf(false) }
    var newSessionCwd by rememberSaveable { mutableStateOf<String?>(null) }
    var newSessionHostId by rememberSaveable { mutableStateOf<String?>(null) }
    LaunchedEffect(state.hostId) {
        if (newSessionOpen && state.hostId != newSessionHostId) {
            newSessionOpen = false
            newSessionCwd = null
            model.dismissBrowse()
        }
    }
    // Keep the directory page's drawer, filters, expansion and scroll position across navigation.
    val runtimeListStateHolder = rememberSaveableStateHolder()
    val context = androidx.compose.ui.platform.LocalContext.current
    // session.activated（spec §8）：只证明进程已拉起；会话真正上线后 runtime.online 会接管 UI。
    LaunchedEffect(state.sessionActivation) {
        state.sessionActivation?.let { activation ->
            val kind = agentBrand(activation.agentKind).title
            val suffix = if (activation.spawnMode == "headless") "，此会话无头（电脑上无窗口）" else ""
            Toast.makeText(context, "已在电脑上拉起 $kind 进程$suffix，等待会话上线…", Toast.LENGTH_LONG).show()
            model.clearActivationNotice()
        }
    }
    when {
        !appearsPaired -> PairingScreen(state.error, model::pair, model::clearError)
        state.selectedRuntimeId == null && state.selectedOfflineSessionId != null -> AgentTheme(
            agentBrand(state.sessions[state.selectedOfflineSessionId]?.agentKind),
        ) {
            OfflineHistoryScreen(
                state = state,
                sessionId = state.selectedOfflineSessionId,
                model = model,
                onBack = { model.selectOfflineSession(null) },
            )
        }
        state.selectedRuntimeId == null -> if (allDownloadsOpen) {
            AllDownloadsScreen(
                state = state,
                onBack = { allDownloadsOpen = false },
                onBrowse = model::browseSessions,
                onBrowseInto = model::browseInto,
                onBrowseUp = model::browseUp,
                onDismissBrowse = model::dismissBrowse,
                onDownload = { path -> model.downloadFile(path) },
                onRetry = { taskId -> model.retryDownload(taskId) },
                onCancel = model::cancelDownload,
                onDelete = model::deleteDownloads,
            )
        } else if (settingsOpen) {
            SettingsScreen(model = model, onBack = { settingsOpen = false })
        } else if (statusOpen) {
            StatusScreen(
                state = state,
                pairing = model.pairingStatus(),
                onBack = { statusOpen = false },
                onOpenSettings = { settingsOpen = true },
                onRawDiagnostics = model::diagnosticReport,
            )
        } else {
            runtimeListStateHolder.SaveableStateProvider("runtime-list") {
                RuntimeListScreen(
                    state = state,
                    selectRuntime = { runtimeId ->
                        allDownloadsOpen = false
                        model.selectRuntime(runtimeId)
                    },
                    setSessionAlias = model::setSessionAlias,
                    onOpenDownloads = { allDownloadsOpen = true },
                    unpair = model::unpair,
                    onOpenHistory = { sessionId ->
                        allDownloadsOpen = false
                        model.selectOfflineSession(sessionId)
                    },
                    onNewSession = { cwd ->
                        newSessionHostId = state.hostId
                        newSessionCwd = cwd
                        newSessionOpen = true
                    },
                    onActivateSession = model::activateSession,
                    onSetArchived = model::setSessionArchived,
                    onOpenStatus = { statusOpen = true },
                )
            }
        }
        else -> AgentTheme(agentBrand(state.runtimes[state.selectedRuntimeId]?.agentKind ?:
            state.knownRuntimeSessions[state.selectedRuntimeId]?.let(state.sessions::get)?.agentKind)) {
            ChatScreen(state, model)
        }
    }
    if (newSessionOpen && state.hostId == newSessionHostId) {
        NewSessionSheet(
            state = state,
            presetCwd = newSessionCwd,
            onDismiss = { newSessionOpen = false; newSessionCwd = null; model.dismissBrowse() },
            onBrowse = model::browseSessions,
            onBrowseInto = model::browseInto,
            onBrowseUp = model::browseUp,
            onCreate = { agentKind, cwd ->
                newSessionOpen = false
                newSessionCwd = null
                model.dismissBrowse()
                model.createSession(agentKind, cwd, newSessionHostId)
            },
        )
    }
    // 模态错误框：同一句文案只弹一次。
    //
    // `error` 是一条共享通道，重连抖动时会有多个写入方反复写同一句话（最典型的是
    // 「收到无效的中继服务器消息」）。模态框每次出现都要求用户点「确定」才能继续，所以不设防
    // 的话，一句重复的噪音就能把界面钉成一个点不完的弹窗——用户看到的正是「一直提示这个」。
    var acknowledgedError by rememberSaveable { mutableStateOf<String?>(null) }
    state.error?.takeIf { appearsPaired }?.takeIf { it != acknowledgedError }?.let { error ->
        AlertDialog(
            onDismissRequest = {
                acknowledgedError = error
                model.clearError()
            },
            confirmButton = {
                NeumorphTextButton("确定", filled = true, onClick = {
                    acknowledgedError = error
                    model.clearError()
                })
            },
            title = { Text("Orbis") },
            text = { Text(error) },
        )
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun PairingScreen(error: String?, pair: (String, String, String?) -> Unit, clearError: () -> Unit) {
    var relayUrl by remember { mutableStateOf("") }
    var pairingCode by remember { mutableStateOf("") }
    var qrRaw by remember { mutableStateOf<String?>(null) }
    var scannerOpen by remember { mutableStateOf(false) }
    var scanError by remember { mutableStateOf<String?>(null) }
    Scaffold(
        containerColor = MaterialTheme.colorScheme.background,
        topBar = { TopAppBar(title = { Text("Orbis", fontWeight = FontWeight.SemiBold) }) },
    ) { padding ->
        Column(
            modifier = Modifier.fillMaxSize().padding(padding)
                .verticalScroll(rememberScrollState()).padding(horizontal = 24.dp, vertical = 24.dp),
            verticalArrangement = Arrangement.Center,
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            NeumorphSurface(Modifier.size(76.dp), style = NeumorphStyle.Pressed) {
                Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                    Image(
                        painter = painterResource(R.drawable.orbis_launcher_foreground),
                        contentDescription = "Orbis",
                        modifier = Modifier.size(52.dp),
                    )
                }
            }
            Spacer(Modifier.height(18.dp))
            Text("连接你的电脑", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.SemiBold)
            Text(
                "扫描电脑上的配对二维码，访问你的 Agent 会话",
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                style = MaterialTheme.typography.bodyMedium,
            )
            Spacer(Modifier.height(24.dp))
            NeumorphActionButton(
                onClick = {
                    scanError = null
                    scannerOpen = true
                },
                text = "扫码配对",
                icon = Icons.Rounded.QrCodeScanner,
                modifier = Modifier.fillMaxWidth(),
            )
            Row(
                modifier = Modifier.fillMaxWidth().padding(vertical = 16.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                HorizontalDivider(Modifier.weight(1f))
                Text("手动输入", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                HorizontalDivider(Modifier.weight(1f))
            }
            OutlinedTextField(
                value = relayUrl,
                onValueChange = { relayUrl = it },
                modifier = Modifier.fillMaxWidth(),
                label = { Text("Relay 地址") },
                leadingIcon = { Icon(Icons.Rounded.Link, contentDescription = null) },
                placeholder = { Text("ws:// 或 wss://") },
                singleLine = true,
            )
            Spacer(Modifier.height(16.dp))
            OutlinedTextField(
                value = pairingCode,
                onValueChange = { pairingCode = it },
                modifier = Modifier.fillMaxWidth(),
                label = { Text("一次性配对码") },
                singleLine = true,
            )
            Spacer(Modifier.height(12.dp))
            NeumorphActionButton(
                onClick = { clearError(); pair(relayUrl, pairingCode, qrRaw) },
                text = "连接",
                enabled = isSupportedRelayUrl(relayUrl) && pairingCode.isNotBlank(),
                modifier = Modifier.fillMaxWidth(),
            )
            error?.let { Text(it, color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(top = 12.dp)) }
            scanError?.let { Text(it, color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(top = 8.dp)) }
        }
    }
    if (scannerOpen) {
        QrScannerDialog(
            onPayload = { raw ->
                // v2 二维码带 E2E 材料（hostPub + psk），优先；v1 只能填表单但无法完成 E2E 配对。
                val v2 = parsePairingQrV2(raw)
                if (v2 == null) {
                    val v1 = parsePairingQrPayload(raw)
                    if (v1 == null) {
                        scanError = "二维码无效或不是 Orbis 配对二维码"
                    } else {
                        relayUrl = v1.relayUrl
                        pairingCode = v1.code
                        qrRaw = null
                        scanError = "这是旧版二维码（无端到端加密材料）：请在电脑上重新执行 pi-remote pair"
                    }
                } else {
                    relayUrl = v2.relayUrl
                    pairingCode = v2.code
                    qrRaw = raw
                    scanError = null
                }
                scannerOpen = false
            },
            onDismiss = { scannerOpen = false },
        )
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun RuntimeListScreen(
    state: RemoteState,
    selectRuntime: (String?) -> Unit,
    setSessionAlias: (String, String) -> Unit,
    onOpenDownloads: () -> Unit,
    unpair: () -> Unit,
    onOpenHistory: (String) -> Unit,
    onNewSession: (String?) -> Unit,
    onActivateSession: (String) -> Unit,
    onSetArchived: (String, Boolean) -> Unit,
    onOpenStatus: () -> Unit,
) {
    var aliasEditorRuntime by remember { mutableStateOf<RuntimeSummary?>(null) }
    var moreMenuOpen by remember { mutableStateOf(false) }
    val drawerState = rememberDrawerState(DrawerValue.Closed)
    val scope = rememberCoroutineScope()
    val onlineRuntimesBySession = remember(state.runtimes, state.sessionAliases) {
        state.runtimes.values
            .filter { it.sessionId != null }
            .sortedBy(state::runtimeDisplayName)
            .groupBy { it.sessionId.orEmpty() }
    }
    ModalNavigationDrawer(
        drawerState = drawerState,
        drawerContent = {
            SessionDrawer(
                state = state,
                onSetArchived = onSetArchived,
                onOpenSession = { sessionId ->
                    scope.launch { drawerState.close() }
                    val runtime = onlineRuntimesBySession[sessionId]?.firstOrNull()
                    if (runtime != null) selectRuntime(runtime.runtimeId) else onActivateSession(sessionId)
                },
                // History temporarily replaces this page; return to the still-open drawer.
                onOpenHistory = onOpenHistory,
                onNewSession = { cwd ->
                    scope.launch { drawerState.close() }
                    onNewSession(cwd)
                },
            )
        },
    ) {
        Scaffold(
            containerColor = MaterialTheme.colorScheme.background,
            topBar = {
                TopAppBar(
                navigationIcon = {
                    NeumorphIconButton(
                        onClick = { scope.launch { drawerState.open() } },
                        icon = Icons.Rounded.Menu,
                        contentDescription = "打开会话目录",
                        size = 40.dp,
                    )
                },
                    title = {
                        Column {
                            Text("Orbis", fontWeight = FontWeight.SemiBold, maxLines = 1)
                            Text(
                                "Easy Agents EveryWhere",
                                style = MaterialTheme.typography.labelMedium.copy(
                                    fontWeight = FontWeight.SemiBold,
                                    letterSpacing = 0.8.sp,
                                    brush = Brush.linearGradient(
                                        listOf(
                                            MaterialTheme.colorScheme.primary,
                                            MaterialTheme.colorScheme.tertiary,
                                        ),
                                    ),
                                ),
                                maxLines = 1,
                            )
                        }
                    },
                    actions = {
                        DownloadStatusButton(
                            activeCount = state.downloads.count { it.value.status in setOf("queued", "downloading") },
                            enabled = true,
                            onClick = onOpenDownloads,
                        )
                        Box {
                            NeumorphIconButton(
                                onClick = { moreMenuOpen = true },
                                icon = Icons.Rounded.MoreVert,
                                contentDescription = "更多操作",
                            )
                            DropdownMenu(expanded = moreMenuOpen, onDismissRequest = { moreMenuOpen = false }) {
                                DropdownMenuItem(
                                    text = { Text("连接状态") },
                                    leadingIcon = { Icon(Icons.Rounded.Info, contentDescription = null) },
                                    onClick = { moreMenuOpen = false; onOpenStatus() },
                                )
                                DropdownMenuItem(
                                    text = { Text("取消配对", color = MaterialTheme.colorScheme.error) },
                                    onClick = { moreMenuOpen = false; unpair() },
                                )
                            }
                        }
                    },
                )
            },
        ) { padding ->
            Column(Modifier.fillMaxSize().padding(padding).padding(horizontal = RemoteUi.PagePadding)) {
                ConnectionStatus(state.connection, state.e2eReady, state.path)
                val visibleRuntimes = state.runtimes.values.sortedBy(state::runtimeDisplayName)
                if (visibleRuntimes.isEmpty()) {
                    Column(
                        modifier = Modifier.fillMaxSize().padding(bottom = 48.dp),
                        verticalArrangement = Arrangement.Center,
                        horizontalAlignment = Alignment.CenterHorizontally,
                    ) {
                        Icon(
                            Icons.Rounded.Computer,
                            contentDescription = null,
                            modifier = Modifier.size(44.dp),
                            tint = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                        Spacer(Modifier.height(14.dp))
                        Text("暂无在线会话", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
                        Text(
                            "从会话目录打开记录，或新建一个会话",
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            style = MaterialTheme.typography.bodyMedium,
                        )
                        if (state.sessions.values.any(SessionCatalogEntry::hasHistoryCache)) {
                            Spacer(Modifier.height(6.dp))
                            Text(
                                "可从左上方菜单查看已缓存的历史记录",
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                style = MaterialTheme.typography.bodySmall,
                            )
                        }
                    }
                } else {
                    LazyColumn(
                        verticalArrangement = Arrangement.spacedBy(16.dp),
                        contentPadding = PaddingValues(top = 12.dp, bottom = 24.dp),
                    ) {
                        items(
                            visibleRuntimes,
                            key = RuntimeSummary::runtimeId,
                        ) { runtime ->
                            NeumorphSurface(
                                modifier = Modifier.fillMaxWidth(),
                                shape = RoundedCornerShape(20.dp),
                                shadowScale = 0.8f,
                                onClick = { selectRuntime(runtime.runtimeId) },
                            ) {
                                Row(
                                    modifier = Modifier.fillMaxWidth().padding(16.dp),
                                    verticalAlignment = Alignment.CenterVertically,
                                    horizontalArrangement = Arrangement.spacedBy(12.dp),
                                ) {
                                    AgentEmblem(agentBrand(runtime.agentKind), 44.dp)
                                    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                                        Text(
                                            state.runtimeDisplayName(runtime),
                                            style = MaterialTheme.typography.titleMedium,
                                            fontWeight = FontWeight.SemiBold,
                                            maxLines = 1,
                                            overflow = TextOverflow.Ellipsis,
                                        )
                                        Text(
                                            runtime.runtimeDisplayPath(),
                                            fontFamily = FontFamily.Monospace,
                                            style = MaterialTheme.typography.bodySmall,
                                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                                            maxLines = 1,
                                            overflow = TextOverflow.Ellipsis,
                                        )
                                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                                            Text(agentBrand(runtime.agentKind).title, color = agentBrand(runtime.agentKind).accent(), style = MaterialTheme.typography.labelMedium)
                                            RuntimeStatus(runtime.status)
                                        }
                                        if (state.hasPendingInteraction(runtime.runtimeId)) {
                                            Row(
                                                verticalAlignment = Alignment.CenterVertically,
                                                horizontalArrangement = Arrangement.spacedBy(6.dp),
                                            ) {
                                                Icon(
                                                    Icons.Rounded.ErrorOutline,
                                                    contentDescription = null,
                                                    tint = MaterialTheme.colorScheme.error,
                                                    modifier = Modifier.size(17.dp),
                                                )
                                                Column(verticalArrangement = Arrangement.spacedBy(1.dp)) {
                                                    Text(
                                                        "待确认",
                                                        color = MaterialTheme.colorScheme.error,
                                                        style = MaterialTheme.typography.labelMedium,
                                                        fontWeight = FontWeight.SemiBold,
                                                    )
                                                    Text(
                                                        "打开此窗口完成交互，否则流程会一直等待",
                                                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                                                        style = MaterialTheme.typography.bodySmall,
                                                        maxLines = 1,
                                                        overflow = TextOverflow.Ellipsis,
                                                    )
                                                }
                                            }
                                        }
                                    }
                                    NeumorphIconButton(
                                        onClick = { aliasEditorRuntime = runtime },
                                        icon = Icons.Rounded.Edit,
                                        contentDescription = "修改会话别名",
                                        size = 40.dp,
                                        tint = MaterialTheme.colorScheme.onSurfaceVariant,
                                    )
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    aliasEditorRuntime?.let { runtime ->
        SessionAliasDialog(
            runtime = runtime,
            currentAlias = state.sessionAliases[runtime.sessionAliasIdentity()],
            onDismiss = { aliasEditorRuntime = null },
            onSave = { alias ->
                setSessionAlias(runtime.runtimeId, alias)
                aliasEditorRuntime = null
            },
            onClear = {
                setSessionAlias(runtime.runtimeId, "")
                aliasEditorRuntime = null
            },
        )
    }
}

/**
 * L2 新建会话（spec §8.1 / §8.2）：选 agent 类型 → 浏览电脑目录（session.browse 逐层下钻，
 * 「有历史」的目录排前）→ 选定目录后 session.activate(new)。presetCwd 非空时跳过浏览
 * （来自抽屉目录节点的「在这里新建」捷径）。
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun NewSessionSheet(
    state: RemoteState,
    presetCwd: String?,
    onDismiss: () -> Unit,
    onBrowse: (String?) -> Unit,
    onBrowseInto: (String) -> Unit,
    onBrowseUp: () -> Unit,
    onCreate: (String, String) -> Unit,
) {
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    var agentKind by rememberSaveable { mutableStateOf("pi") }
    // 电脑端说得很清楚时不让人白点：做不到的 agent 直接置灰（未知=不限制，见 RemoteState）。
    val codexSupported = state.supportedAgents?.contains("codex") != false
    val dshSupported = state.supportedAgents?.contains("dsh") == true
    LaunchedEffect(codexSupported, dshSupported) {
        // chip 可能停在上一轮选中的 Codex 上（rememberSaveable），电脑不支持就拉回来。
        if (!codexSupported && agentKind == "codex") agentKind = "pi"
        if (!dshSupported && agentKind == "dsh") agentKind = "pi"
    }
    LaunchedEffect(Unit) {
        if (presetCwd == null && state.sessionBrowse == null) onBrowse(null)
    }
    AgentTheme(agentBrand(agentKind)) {
    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = sheetState,
        containerColor = MaterialTheme.colorScheme.surface,
        tonalElevation = 0.dp,
        shape = MaterialTheme.shapes.extraLarge,
        dragHandle = {
            NeumorphSurface(Modifier.padding(vertical = 16.dp).size(36.dp, 5.dp), shape = CircleShape, style = NeumorphStyle.Pressed, shadowScale = 0.25f) {}
        },
    ) {
        Column(
            modifier = Modifier.fillMaxWidth().navigationBarsPadding()
                .padding(horizontal = RemoteUi.PagePadding).padding(bottom = 24.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Text(
                "在${state.sessionHost?.name ?: "电脑"}上新建会话",
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.SemiBold,
            )
            Row(Modifier.fillMaxWidth().selectableGroup(), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                AgentChoice(AgentBrand.Pi, agentKind == "pi", { agentKind = "pi" }, Modifier.weight(1f))
                AgentChoice(AgentBrand.Codex, agentKind == "codex", { agentKind = "codex" }, Modifier.weight(1f), codexSupported)
            }
            AgentChoice(AgentBrand.DeepSeek, agentKind == "dsh", { agentKind = "dsh" }, Modifier.fillMaxWidth(), dshSupported)
            if (agentKind == "dsh") {
                Text("DeepSeek Harness 会话在后台运行，支持模型切换与工具审批", style = MaterialTheme.typography.bodySmall)
            }
            if (!codexSupported) {
                Text(
                    "这台电脑没启用 Codex 后端",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            val offline = !state.canOperateSessions
            if (offline) {
                Text(
                    "未连接到电脑：连接建立后才能浏览目录与新建会话",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            val preset = presetCwd
            if (preset != null) {
                // 捷径模式：目录已由抽屉节点指定，直接创建。
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Icon(Icons.Rounded.Folder, contentDescription = null, tint = MaterialTheme.colorScheme.primary)
                    Column {
                        Text(directoryDisplayName(preset), fontWeight = FontWeight.Medium)
                        Text(
                            preset,
                            fontFamily = FontFamily.Monospace,
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }
                }
                NeumorphActionButton(
                    onClick = { onCreate(agentKind, preset) },
                    text = "在此目录新建 ${agentBrand(agentKind).title} 会话",
                    enabled = state.canCreateSessionOn(state.hostId),
                    modifier = Modifier.fillMaxWidth(),
                )
            } else {
                val browse = state.sessionBrowse
                RemoteDirectoryBrowser(
                    browse = browse,
                    connected = !offline && state.e2eReady,
                    onBrowse = onBrowse,
                    onBrowseInto = onBrowseInto,
                    onBrowseUp = onBrowseUp,
                    modifier = Modifier.fillMaxWidth().weight(1f, fill = false),
                )
                NeumorphActionButton(
                    onClick = {
                        val cwd = browse?.path.orEmpty()
                        if (cwd.isNotBlank()) onCreate(agentKind, cwd)
                    },
                    text = "在这里新建 ${agentBrand(agentKind).title} 会话",
                    enabled = state.canCreateSessionOn(state.hostId) && browse != null && !browse.isLoading &&
                        browse.error == null && !browse.path.isNullOrBlank(),
                    modifier = Modifier.fillMaxWidth(),
                )
            }
        }
    }
}
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun OfflineHistoryScreen(
    state: RemoteState,
    sessionId: String?,
    model: RemoteViewModel,
    onBack: () -> Unit,
) {
    BackHandler(onBack = onBack)
    val graph = sessionId?.let(state.sessionGraphs::get)
    val projection = remember(graph) {
        graph?.let(::projectSessionGraph) ?: SessionProjectionResult(emptyList(), "本地没有可用的历史缓存")
    }
    val presentation = remember(projection.messages) { buildConversationPresentation(projection.messages) }
    val messageTurnTimings = remember(projection) {
        projection.turnTimings.mapNotNull { timing ->
            timing.messageId?.let { it to timing }
        }.toMap()
    }
    val turnIdsByMessageId = remember(messageTurnTimings) {
        messageTurnTimings.mapValues { (_, timing) -> timing.turnId }
    }
    val historyKey = sessionId?.let { "offline:$it" }
    val historyState = historyKey?.let(state.sessionHistory::get)
    val listState = remember(historyKey) { LazyListState() }
    var historyAnchorIndex by remember(historyKey) { mutableStateOf<Int?>(null) }
    var historyAnchorOffset by remember(historyKey) { mutableStateOf(0) }
    var historyAnchorCount by remember(historyKey) { mutableStateOf(0) }
    LaunchedEffect(historyKey, historyState?.hasOlder, historyState?.loading) {
        if (historyKey == null || historyState?.hasOlder != true || historyState.loading) return@LaunchedEffect
        snapshotFlow { listState.firstVisibleItemIndex }.collect { firstVisibleIndex ->
            if (firstVisibleIndex <= 1 && historyAnchorIndex == null) {
                historyAnchorIndex = firstVisibleIndex
                historyAnchorOffset = listState.firstVisibleItemScrollOffset
                historyAnchorCount = listState.layoutInfo.totalItemsCount
                model.loadOlderHistory(historyKey)
            }
        }
    }
    LaunchedEffect(presentation.messages.size, historyState?.loading) {
        val anchorIndex = historyAnchorIndex ?: return@LaunchedEffect
        val itemCount = listState.layoutInfo.totalItemsCount
        if (historyState?.loading == true || itemCount <= historyAnchorCount) return@LaunchedEffect
        listState.scrollToItem(anchorIndex + itemCount - historyAnchorCount, historyAnchorOffset)
        historyAnchorIndex = null
    }
    Scaffold(
        topBar = {
            TopAppBar(
                navigationIcon = {
                    NeumorphIconButton(
                        onClick = onBack,
                        icon = Icons.Rounded.ArrowBack,
                        contentDescription = "返回会话目录",
                        size = 40.dp,
                    )
                },
                title = {
                    Column {
                        Text(
                            state.sessionDisplayName(sessionId),
                            fontWeight = FontWeight.SemiBold,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                        AgentLabel(LocalAgentBrand.current, suffix = "只读历史")
                    }
                },
            )
        },
    ) { padding ->
        val chatItems = remember(presentation, turnIdsByMessageId) {
            buildChatListItems(presentation.messages, turnIdsByMessageId)
        }
        val offlineRuntimeId = "offline-$sessionId"
        LazyColumn(
            state = listState,
            modifier = Modifier.fillMaxSize().padding(padding),
            contentPadding = PaddingValues(horizontal = 16.dp, vertical = 16.dp),
            // 轮次间距与在线会话一致。
            verticalArrangement = Arrangement.spacedBy(24.dp),
        ) {
            projection.error?.let { item { WarningCard("历史记录加载失败：$it") } }
            items(chatItems, key = ChatListItem::key) { item ->
                when (item) {
                    is ChatListItem.UserMessage -> UserMessageCard(
                        runtimeId = offlineRuntimeId,
                        message = item.message,
                        downloads = state.downloads,
                        downloadArtifact = { artifact -> model.downloadArtifact(offlineRuntimeId, artifact) },
                        // 只读历史里的文件同样能下载：点击路径就是「请 Host 把这个文件发过来」
                        // （§9.4）。`runtimeId` 只是来源标记（哪个会话里的文件），命令发给 Host。
                        downloadFile = { path -> model.downloadFile(offlineRuntimeId, path) },
                    )

                    is ChatListItem.AssistantTurn -> AssistantTurnCard(
                        runtimeId = offlineRuntimeId,
                        messages = item.messages,
                        turnTiming = groupTurnTiming(item.messages.mapNotNull { messageTurnTimings[it.messageId] }),
                        nowMs = System.currentTimeMillis(),
                        toolActivities = emptyMap(),
                        toolResults = presentation.toolResults,
                        downloads = state.downloads,
                        downloadArtifact = { artifact -> model.downloadArtifact(offlineRuntimeId, artifact) },
                        downloadFile = { path -> model.downloadFile(offlineRuntimeId, path) },
                    )
                }
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun ChatScreen(state: RemoteState, model: RemoteViewModel) {
    val runtimeId = state.selectedRuntimeId ?: return
    val runtime = state.runtimes[runtimeId]
    val sessionId = runtime?.sessionId
    val conversation = state.conversations[runtimeId] ?: RuntimeConversation()
    val activeTurn = conversation.activeTurnId?.let(conversation.turnTimings::get)
    var timerNow by remember { mutableStateOf(System.currentTimeMillis()) }
    LaunchedEffect(activeTurn?.turnId, activeTurn?.startedAt) {
        while (activeTurn != null) {
            timerNow = System.currentTimeMillis()
            delay(1_000)
        }
    }
    val messageTurnTimings = remember(conversation.revision) {
        conversation.turnTimings.values.mapNotNull { timing ->
            timing.messageId?.let { messageId -> messageId to timing }
        }.toMap()
    }
    val turnIdsByMessageId = remember(messageTurnTimings) {
        messageTurnTimings.mapValues { (_, timing) -> timing.turnId }
    }
    val presentation = remember(conversation.revision) { buildConversationPresentation(conversation.messages) }
    val chatItems = remember(conversation.revision, turnIdsByMessageId) {
        buildChatListItems(presentation.messages, turnIdsByMessageId)
    }
    val chatItemKeys = remember(chatItems) { chatItems.map(ChatListItem::key) }
    val chatItemIndexById = remember(conversation.revision) { chatListItemIndexByMessageId(chatItems) }
    val representedToolIds = remember(conversation.revision) {
        presentation.messages.flatMap { message -> message.content.mapNotNull(RemoteContent::toolCallId) }.toSet()
    }
    val orphanTools = remember(conversation.revision, representedToolIds) {
        orphanToolActivities(conversation.tools.values, representedToolIds)
    }
    val runtimeDownloads = state.downloads.values.filter {
        it.runtimeId == runtimeId && (runtime == null || it.sessionId == runtime.sessionId)
    }
    val activeDownloadCount = runtimeDownloads.count { it.status == "queued" || it.status == "downloading" }
    val listState = remember(runtimeId, sessionId) { LazyListState() }
    val historyState = state.sessionHistory[runtimeId]
    val chatHeaderCount = listOf(
        runtime == null,
        historyState?.loading == true,
        (state.sessionSyncFailures[runtimeId] ?: conversation.chatSyncError) != null,
        state.sessionSyncCommands.values.any { it.runtimeId == runtimeId && it.slow && it.exhaustedAt == null },
        conversation.waitingLocalInteraction,
        conversation.interactionNotice != null,
    ).count { it }
    // A catch-up can connect a large cached prefix in one projection. LazyColumn's nearby-key
    // lookup may then lose the old row. Capture its key before the new list is laid out.
    val projectionAnchor = remember(listState, chatItemKeys, chatHeaderCount, orphanTools.size, conversation.isChatSyncing) {
        listState.layoutInfo.visibleItemsInfo.firstOrNull { it.key in chatItemIndexById }
            ?.let { (it.key as String) to -it.offset }
    }
    var historyAnchorMessageId by remember(runtimeId, sessionId) { mutableStateOf<String?>(null) }
    var historyAnchorIndex by remember(runtimeId, sessionId) { mutableStateOf<Int?>(null) }
    var historyAnchorPending by remember(runtimeId, sessionId) { mutableStateOf(false) }
    var historyAnchorOffset by remember(runtimeId, sessionId) { mutableStateOf(0) }
    val scope = rememberCoroutineScope()
    var initialPositioned by remember(runtimeId, sessionId) { mutableStateOf(false) }
    val isNearLatest by remember(listState, initialPositioned) {
        derivedStateOf {
            val layout = listState.layoutInfo
            val lastVisible = layout.visibleItemsInfo.lastOrNull()?.index ?: -1
            shouldFollowLatest(initialPositioned, lastVisible, layout.totalItemsCount)
        }
    }
    var input by remember(runtimeId, sessionId, state.deviceId) {
        mutableStateOf(model.loadDraft(runtimeId))
    }
    val composerMode = composerAction(isWorking = runtime?.status == "running", input = input)
    var selectedSlashCommandName by remember(runtimeId) { mutableStateOf<String?>(null) }
    var downloadManagerOpen by remember(runtimeId) { mutableStateOf(false) }
    // 历史与分支整页：顶栏入口和输入 /tree 进的是同一页。动作（跳分支）走 /tree 命令，
    // 节点 ID 只在页面内部流转，不会再被拼进输入框。
    var historyOpen by remember(runtimeId, sessionId) { mutableStateOf(false) }
    var historyAction by remember(runtimeId, sessionId) { mutableStateOf<HistoryTreeAction?>(null) }
    var historyActionCommandId by remember(runtimeId, sessionId) { mutableStateOf<String?>(null) }
    var historyActionError by remember(runtimeId, sessionId) { mutableStateOf<String?>(null) }
    fun runHistoryAction(action: HistoryTreeAction) {
        historyActionError = null
        val commandId = model.executeSlashCommand("tree", action.nodeId)
        if (commandId == null) {
            historyActionError = "跳转未送达：当前会话没有提供 /tree 命令"
            return
        }
        historyAction = action
        historyActionCommandId = commandId
    }
    var pendingMessageCommandId by remember(runtimeId) { mutableStateOf<String?>(null) }
    var pendingMessageText by remember(runtimeId) { mutableStateOf("") }
    var commandFeedback by remember(runtimeId) { mutableStateOf<String?>(null) }
    var showDeliveryChoices by remember(runtimeId, sessionId) { mutableStateOf(false) }
    // 这个 composer 上挂着的上传任务（taskId）。只有传完的才能随消息发出。
    // 关联记在 ViewModel（按会话）：退出会话窗口再回来，chip 原样恢复——上传不因退出窗口取消。
    val sessionKey = "$runtimeId/$sessionId"
    var attachedTaskIds by remember(runtimeId, sessionId) { mutableStateOf(model.attachedTaskIds(sessionKey)) }
    fun updateAttachedTaskIds(newIds: Set<String>) {
        attachedTaskIds = newIds
        model.setAttachedTaskIds(sessionKey, newIds)
    }
    val runtimeUploads = state.uploads.values.filter { it.runtimeId == runtimeId }
    val attachedUploads = runtimeUploads.filter { it.taskId in attachedTaskIds }
    val attachablePaths = attachedUploads.filter { it.status == "completed" }.mapNotNull(UploadTask::remotePath)
    // 附件现在是无条件支持的（ADR-0008 删掉了 `messageAttachments` 能力位）。
    val canAttachFiles = runtime != null && state.hostId != null
    val filePicker = rememberLauncherForActivityResult(
        ActivityResultContracts.OpenMultipleDocuments(),
    ) { uris ->
        uris.take(MAX_ATTACHMENTS_PER_MESSAGE).forEach { uri ->
            // 登记完立刻把任务挂到 composer 的附件 chip 上——上传进度必须可见，
            // 否则用户不知道文件正在传、也不知道为什么发送键是灰的。
            model.queueUpload(uri, runtimeId) { taskId -> updateAttachedTaskIds(attachedTaskIds + taskId) }
        }
        if (uris.size > MAX_ATTACHMENTS_PER_MESSAGE) {
            commandFeedback = "一次最多发送 $MAX_ATTACHMENTS_PER_MESSAGE 个文件"
        }
    }
    // Refresh replaces the visible conversation with a fresh projection. Remember the row the
    // user is looking at so the viewport can stay put instead of jumping to the newest message.
    var refreshAnchorMessageId by remember(runtimeId, sessionId) { mutableStateOf<String?>(null) }
    var refreshAnchorIndex by remember(runtimeId, sessionId) { mutableStateOf<Int?>(null) }
    var refreshAnchorOffset by remember(runtimeId, sessionId) { mutableStateOf(0) }
    var refreshAnchorArmed by remember(runtimeId, sessionId) { mutableStateOf(false) }
    // Sending is the one intent that should move the viewport to the newest row; a periodic
    // refresh must not.
    var followNewestAfterSync by remember(runtimeId, sessionId) { mutableStateOf(false) }
    fun refreshConversation() {
        model.refreshRuntime(runtimeId)
        model.refreshWorkingBranch(runtimeId)
    }
    fun trackSubmission(commandId: String?, clearInputAfterSubmit: Boolean = false) {
        if (commandId == null) return
        // Sending is an explicit intent to see new content, so stop pinning the refresh viewport
        // and follow the newest row once the resulting sync settles.
        refreshAnchorArmed = false
        followNewestAfterSync = true
        val submittedText = input
        commandFeedback = null
        pendingMessageCommandId = commandId
        pendingMessageText = submittedText
        if (clearInputAfterSubmit) {
            // Slash commands are actions and may replace the session or reconnect the runtime;
            // clear them once Relay accepts the request instead of waiting for the final result.
            input = ""
            selectedSlashCommandName = null
            model.clearDraft(runtimeId)
        }
    }
    LaunchedEffect(runtime?.status) {
        if (runtime?.status != "running") showDeliveryChoices = false
    }
    val lifecycleOwner = LocalLifecycleOwner.current
    LaunchedEffect(runtimeId, sessionId, runtime?.cwd, state.e2eReady, lifecycleOwner) {
        lifecycleOwner.lifecycle.repeatOnLifecycle(Lifecycle.State.RESUMED) {
            refreshConversation()
            while (isActive) {
                delay(15_000)
                refreshConversation()
            }
        }
    }
    LaunchedEffect(runtimeId, sessionId, historyState?.hasOlder, historyState?.loading, initialPositioned) {
        if (!initialPositioned || historyState?.hasOlder != true || historyState.loading) return@LaunchedEffect
        snapshotFlow { listState.firstVisibleItemIndex }.collect { firstVisibleIndex ->
            if (firstVisibleIndex <= 1 && !historyAnchorPending) {
                val anchor = listState.layoutInfo.visibleItemsInfo.firstOrNull { it.key in chatItemIndexById }
                historyAnchorMessageId = anchor?.key as? String
                historyAnchorIndex = anchor?.index ?: firstVisibleIndex
                historyAnchorPending = true
                historyAnchorOffset = anchor?.let { -it.offset } ?: listState.firstVisibleItemScrollOffset
                model.loadOlderHistory(runtimeId)
            }
        }
    }
    LaunchedEffect(chatItems, historyState?.loading) {
        if (!historyAnchorPending || historyState?.loading == true) return@LaunchedEffect
        val anchorId = historyAnchorMessageId
        val newIndex = anchorId?.let { id -> chatItemIndexById[id] }
            ?.let { it + chatHeaderCount }
            ?: historyAnchorIndex
        if (newIndex != null && newIndex >= 0) {
            listState.scrollToItem(newIndex, historyAnchorOffset)
        }
        historyAnchorMessageId = null
        historyAnchorIndex = null
        historyAnchorPending = false
    }
    BackHandler {
        if (historyOpen) {
            historyOpen = false
            historyActionError = null
        } else if (downloadManagerOpen) downloadManagerOpen = false
        else model.selectRuntime(null)
    }

    // 历史页的跳转：成功后回到聊天页并停在新位置；编辑重发还要把原文放回输入框。
    // 这个 effect 必须排在下面 `if (historyOpen) return` 之前——历史页打开时聊天页会提前返回，
    // 排在后面的 effect 根本不会被组合，命令结果就永远没人消费。
    LaunchedEffect(historyActionCommandId, state.commandResults) {
        val commandId = historyActionCommandId ?: return@LaunchedEffect
        val result = state.commandResults[commandId] ?: return@LaunchedEffect
        val action = historyAction
        model.consumeCommandResult(commandId)
        historyActionCommandId = null
        historyAction = null
        if (!result.ok) {
            historyActionError = "跳转失败：${result.status}"
            return@LaunchedEffect
        }
        if (action is HistoryTreeAction.EditAndRestart) {
            val text = historyEditorText(result.result) ?: action.fallbackText
            if (text != null) {
                input = text
                selectedSlashCommandName = null
                model.saveDraft(runtimeId, text)
            }
        }
        // 历史已经被改写（codex 是原地截断，Pi 是同会话内换 leaf）：让列表重新贴到新的当前位置，
        // 而不是停在旧锚点上；并立刻拉一次快照——后端广播的快照用自造 syncId，手机不采，
        // 不主动问这一下就还显示着已经不存在的那几轮。
        refreshAnchorArmed = false
        followNewestAfterSync = true
        initialPositioned = false
        historyOpen = false
        refreshConversation()
    }

    if (historyOpen) {
        HistoryTreePage(
            state = state,
            runtimeId = runtimeId,
            sessionId = sessionId,
            pendingNodeId = historyAction?.nodeId,
            actionError = historyActionError,
            onBack = {
                historyOpen = false
                historyActionError = null
            },
            onContinueFrom = { node -> runHistoryAction(HistoryTreeAction.ContinueFrom(node.nodeId)) },
            onEditAndRestart = { node ->
                runHistoryAction(
                    HistoryTreeAction.EditAndRestart(
                        nodeId = node.nodeId,
                        fallbackText = sessionId?.let(state.sessionGraphs::get)?.historyNodeText(node.nodeId),
                    ),
                )
            },
            downloadArtifact = { artifact -> model.downloadArtifact(runtimeId, artifact) },
            downloadFile = { path -> model.downloadFile(runtimeId, path) },
        )
        return
    }

    if (downloadManagerOpen) {
        // 对话上方的下载页与主页面下载页是同一个页面（浏览文件 + 下载列表），
        // 语义都是「和 Host 交互」——不再是「某个 runtime 的下载」。
        AllDownloadsScreen(
            state = state,
            onBack = { downloadManagerOpen = false },
            onBrowse = model::browseSessions,
            onBrowseInto = model::browseInto,
            onBrowseUp = model::browseUp,
            onDismissBrowse = model::dismissBrowse,
            onDownload = { path -> model.downloadFile(path) },
            onRetry = { taskId -> model.retryDownload(taskId) },
            onCancel = model::cancelDownload,
            onDelete = model::deleteDownloads,
        )
        return
    }

    LaunchedEffect(runtimeId, sessionId, conversation.isChatSyncing, chatItemKeys, chatHeaderCount, orphanTools.size) {
        if (chatItems.isEmpty()) return@LaunchedEffect
        // Slow/error notices are list rows too. They cannot establish the initial chat anchor;
        // wait until an actual message row has been laid out before enabling history paging.
        val itemCount = snapshotFlow { listState.layoutInfo }.first { layout ->
            layout.totalItemsCount == chatHeaderCount + chatItems.size + orphanTools.size &&
                layout.visibleItemsInfo.any { it.key in chatItemIndexById }
        }.totalItemsCount
        if (conversation.isChatSyncing) {
            // A refresh replaces the visible conversation with a fresh projection. Capture the row
            // the user is looking at here, not when the refresh is requested, so every round of a
            // multi-round sync re-anchors and an externally requested sync cannot jump the list
            // either. An explicit send opts out: it wants the newest row instead.
            if (initialPositioned && !refreshAnchorArmed && !followNewestAfterSync) {
                val firstVisible = listState.firstVisibleItemIndex
                val anchor = listState.layoutInfo.visibleItemsInfo.firstOrNull { it.key in chatItemIndexById }
                refreshAnchorMessageId = anchor?.key as? String
                refreshAnchorIndex = anchor?.index ?: firstVisible
                refreshAnchorOffset = anchor?.let { -it.offset } ?: listState.firstVisibleItemScrollOffset
                refreshAnchorArmed = true
            }
            // A background catch-up can run for a long time. It must not keep the viewport
            // "unpositioned": that hid the jump-to-latest button for the whole sync. Still open
            // a freshly selected conversation on its newest message the first time items appear.
            if (!initialPositioned) {
                listState.scrollToItem(itemCount - 1)
                initialPositioned = true
            }
            return@LaunchedEffect
        }
        if (refreshAnchorArmed) {
            // A refresh must not move the viewport. Restore the row that was visible before the
            // replacement projection, falling back to its old index when that row disappeared.
            val anchorIndex = refreshAnchorMessageId
                ?.let { id -> chatItemIndexById[id] }
                ?.let { it + chatHeaderCount }
                ?: refreshAnchorIndex
            if (anchorIndex != null && anchorIndex >= 0) {
                listState.scrollToItem(anchorIndex.coerceAtMost(itemCount - 1), refreshAnchorOffset)
            }
            // A refresh completes in several rounds (preview, then catch-up pages). Stay pinned
            // until every sync for this runtime has finished so a later round cannot yank the list
            // to the newest message.
            if (state.sessionSyncCommands.values.none { it.runtimeId == runtimeId }) {
                refreshAnchorArmed = false
            }
            initialPositioned = true
            return@LaunchedEffect
        }
        // A settled sync only moves to the newest message when the user just sent something.
        // A periodic refresh leaves the viewport where the user left it.
        if (!initialPositioned || followNewestAfterSync) {
            listState.scrollToItem(itemCount - 1)
        } else if (!historyAnchorPending) {
            projectionAnchor?.let { (key, offset) ->
                chatItemIndexById[key]?.let { index ->
                    listState.scrollToItem(chatHeaderCount + index, offset)
                }
            }
        }
        followNewestAfterSync = false
        initialPositioned = true
    }

    LaunchedEffect(pendingMessageCommandId, state.commandResults) {
        val commandId = pendingMessageCommandId ?: return@LaunchedEffect
        val result = state.commandResults[commandId] ?: return@LaunchedEffect
        if (result.ok && input == pendingMessageText) {
            input = ""
            selectedSlashCommandName = null
            model.clearDraft(runtimeId)
        }
        if (result.ok && pendingMessageText.trim().startsWith("/")) {
            commandFeedback = slashCommandFeedback(pendingMessageText, result)
        }
        model.consumeCommandResult(commandId)
        pendingMessageCommandId = null
        pendingMessageText = ""
    }

    Scaffold(
        topBar = {
            Column {
            TopAppBar(
                title = {
                    Column {
                        Row(
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(MetaLineGap),
                        ) {
                            AgentIcon(LocalAgentBrand.current, Modifier.size(MetaLineLeadingSlot))
                            Text(LocalAgentBrand.current.title, style = MaterialTheme.typography.labelLarge, color = LocalAgentBrand.current.accent())
                            Text(
                                state.sessionDisplayName(sessionId, runtime),
                                modifier = Modifier.weight(1f),
                                style = MaterialTheme.typography.titleMedium,
                                fontWeight = FontWeight.SemiBold,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                            )
                        }
                        ChatRuntimeStatus(
                            status = runtime?.status ?: "error",
                            isChatSyncing = conversation.isChatSyncing,
                            modelLabel = runtime?.model?.let(::modelLabel),
                            thinkingLevel = runtime?.thinkingLevel,
                        )
                    }
                },
                navigationIcon = {
                    NeumorphIconButton(
                        onClick = { model.selectRuntime(null) },
                        icon = Icons.Rounded.ArrowBack,
                        contentDescription = "返回",
                        size = 40.dp,
                    )
                },
                actions = {
                    // 「历史与分支」入口：与输入 /tree 打开的是同一个整页。用 History（时钟）
                    // 而不是 AccountTree——后者留给输入区的「Git 工作分支」行，两个都画成
                    // 分叉树会让人以为这个按钮是切换分支用的。
                    NeumorphIconButton(
                        onClick = {
                            historyActionError = null
                            historyOpen = true
                        },
                        icon = Icons.Rounded.History,
                        contentDescription = "历史与分支",
                        size = 40.dp,
                    )
                    DownloadStatusButton(
                        activeCount = activeDownloadCount,
                        // 下载由 Host 服务（§9.4），与「当前会话的 runtime 在不在」无关。
                        enabled = state.hostId != null,
                        onClick = { downloadManagerOpen = true },
                    )
                },
            )
            }
        },
        bottomBar = {
            // 输入区坐在底板上：不加 tonal/shadow elevation（tonal 会叠 surfaceTint 偏色，
            // 阴影会把「同一块地面」切断）。
            Surface {
                Column {
                    ComposerContextRail(composerStatus(runtime))
                    commandFeedback?.let { NoticeCard(it) }
                    PendingMessagesPanel(
                        messages = conversation.queuedMessages.values.toList(),
                    )
                    AnimatedVisibility(visible = deliveryChoicesVisible(showDeliveryChoices, runtime?.status)) {
                        Row(
                            Modifier.fillMaxWidth().padding(horizontal = RemoteUi.PagePadding, vertical = 8.dp),
                            horizontalArrangement = Arrangement.spacedBy(8.dp),
                        ) {
                            NeumorphTextButton(
                                text = "Follow-up",
                                onClick = {
                                    showDeliveryChoices = false
                                    trackSubmission(model.sendMessage(input, "followUp"))
                                },
                                enabled = pendingMessageCommandId == null,
                                filled = true,
                                modifier = Modifier.weight(1f),
                            )
                            NeumorphTextButton(
                                text = "Steer",
                                onClick = {
                                    showDeliveryChoices = false
                                    trackSubmission(model.sendMessage(input, "steer"))
                                },
                                enabled = pendingMessageCommandId == null,
                                filled = true,
                                modifier = Modifier.weight(1f),
                            )
                        }
                    }
                    SlashCommandPicker(
                        input = input,
                        commands = state.capabilities[runtimeId]?.commands.orEmpty(),
                        selectedCommandName = selectedSlashCommandName,
                        // 命令词表的 source 在 Pi 与 Codex 下都叫 "builtin"，但徽标文案不同：
                        // Codex 的命令来自 app-server，标成 "Pi" 会让用户以为点错了后端。
                        isCodex = runtime?.isCodex == true,
                        isDsh = runtime?.agentKind == "dsh",
                        onOpenTree = {
                            // /tree 不再把候选铺在输入框下面：整页打开，命令词也一并清掉，
                            // 免得节点 ID 落到聊天输入框里。
                            input = ""
                            selectedSlashCommandName = null
                            model.clearDraft(runtimeId)
                            historyActionError = null
                            historyOpen = true
                        },
                        onCommandSelected = { command, invocation ->
                            showDeliveryChoices = false
                            selectedSlashCommandName = command.name
                            input = invocation
                            model.saveDraft(runtimeId, invocation)
                        },
                    )
                    ComposerContextNotice(composerStatus(runtime))
                    // 目录、分支和权限组成同一组会话信息；附件属于待发送消息，紧贴输入框。
                    ComposerSessionInfo(
                        path = runtime?.cwd,
                        branch = runtime?.let { current ->
                            state.workingBranches[runtimeId]?.takeIf {
                                it.cwd == current.cwd && it.sessionId == current.sessionId
                            }
                        },
                    ) {
                        androidx.compose.runtime.key(runtimeId, sessionId) {
                            RuntimePermissionsStatus(
                                permissions = runtime?.permissions,
                                commands = state.capabilities[runtimeId]?.commands.orEmpty(),
                                connected = state.e2eReady && runtime != null,
                                idle = runtime?.status == "idle" && conversation.interactions.isEmpty() && conversation.queuedMessages.isEmpty(),
                                commandResults = state.commandResults,
                                onApply = model::executeSlashCommand,
                            )
                        }
                    }
                    if (attachedUploads.isNotEmpty()) {
                        AttachmentChips(
                            uploads = attachedUploads,
                            onRemove = { taskId ->
                                updateAttachedTaskIds(attachedTaskIds - taskId)
                                // 叉叉 = 取消：还没传完的连电脑端一起取消，传完的只从本条消息摘掉。
                                model.removeUploads(setOf(taskId))
                            },
                        )
                    }
                    androidx.compose.runtime.key(runtimeId, sessionId) {
                        InteractionWorkspace(
                            requests = conversation.interactions.values.toList(), connected = state.e2eReady && runtime != null,
                            pendingCommands = state.pendingCommands.keys, error = null,
                            respondConfirm = model::respondConfirm, respondValue = model::respondValue,
                            respondValues = model::respondValues, respondQuestionnaire = model::respondQuestionnaire,
                            onCancel = model::cancelInteraction,
                        )
                    }
                    Row(
                        Modifier.fillMaxWidth().navigationBarsPadding()
                            .padding(horizontal = 12.dp, vertical = 12.dp),
                        verticalAlignment = Alignment.Bottom,
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                    if (canAttachFiles) {
                        NeumorphIconButton(
                            onClick = { filePicker.launch(arrayOf("*/*")) },
                            icon = Icons.Rounded.AttachFile,
                            contentDescription = "发送文件到电脑",
                            enabled = attachedTaskIds.size < MAX_ATTACHMENTS_PER_MESSAGE,
                            modifier = Modifier.padding(bottom = 4.dp),
                        )
                    }
                    OutlinedTextField(
                        value = input,
                        onValueChange = { value ->
                            showDeliveryChoices = false
                            input = value
                            model.saveDraft(runtimeId, value)
                            if (!matchesSelectedSlashCommand(value, selectedSlashCommandName)) {
                                selectedSlashCommandName = null
                            }
                        },
                        modifier = Modifier.weight(1f),
                        placeholder = { Text("发给 ${LocalAgentBrand.current.title} · / 命令", maxLines = 1, overflow = TextOverflow.Ellipsis) },
                        enabled = runtime != null,
                        minLines = 1,
                        maxLines = 5,
                    )
                    // 两侧按钮保持 48dp 触控区；输入框承担剩余宽度，多行输入时按钮贴底对齐。
                    val sendEnabled = when (composerMode) {
                        ComposerAction.Abort -> runtime != null
                        ComposerAction.Send -> runtime != null && canSubmitInput(
                            input,
                            state.capabilities[runtimeId]?.commands.orEmpty(),
                            selectedSlashCommandName,
                        ) && pendingMessageCommandId == null &&
                            // 还没传完的附件不发：否则 agent 会拿到一个不存在的路径。
                            attachedUploads.size == attachablePaths.size
                    }
                    NeumorphSurface(
                        modifier = Modifier.padding(bottom = 4.dp).size(48.dp),
                        shape = CircleShape,
                        shadowScale = 0.75f,
                        enabled = sendEnabled,
                        onClick = {
                                when (composerMode) {
                                    ComposerAction.Abort -> {
                                        showDeliveryChoices = false
                                        model.stopRuntime()
                                    }

                                    ComposerAction.Send -> {
                                        val selectedCommand = state.capabilities[runtimeId]?.commands
                                            ?.find { it.name == selectedSlashCommandName }
                                        val slash = parseSlashInvocation(input)
                                        if (selectedCommand != null && slash?.first == selectedCommand.name) {
                                            showDeliveryChoices = false
                                            trackSubmission(
                                                model.executeSlashCommand(selectedCommand.name, slash.second),
                                                clearInputAfterSubmit = true,
                                            )
                                        } else if (runtime?.status == "running") {
                                            showDeliveryChoices = true
                                        } else {
                                            showDeliveryChoices = false
                                            val commandId = model.sendMessage(input, attachments = attachablePaths)
                                            // 附件已经交给 Pi，chip 就不该继续挂在输入框上；
                                            // 任务本身仍在上传列表里可查进度/删记录。
                                            if (commandId != null) {
                                                model.detachUploads(attachedTaskIds)
                                                updateAttachedTaskIds(emptySet())
                                            }
                                            trackSubmission(commandId)
                                        }
                                    }
                                }
                        },
                    ) {
                        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                            when {
                                pendingMessageCommandId != null ->
                                    CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp)

                                composerMode == ComposerAction.Abort ->
                                    Icon(
                                        Icons.Rounded.StopCircle,
                                        contentDescription = "打断当前任务",
                                        tint = if (sendEnabled) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.38f),
                                        modifier = Modifier.size(22.dp),
                                    )

                                else ->
                                    Icon(
                                        Icons.Rounded.Send,
                                        contentDescription = "发送",
                                        tint = if (sendEnabled) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.38f),
                                        modifier = Modifier.size(22.dp),
                                    )
                            }
                        }
                    }
                }
            }
        }
        },
        floatingActionButton = {
            AnimatedVisibility(visible = initialPositioned && !isNearLatest) {
                // 回到最新是可交互控件：凸起圆钮（平铺 FAB 会变成一块无影的染色圆）。
                NeumorphIconButton(
                    onClick = {
                        scope.launch {
                            val lastIndex = listState.layoutInfo.totalItemsCount - 1
                            if (lastIndex >= 0) listState.animateScrollToItem(lastIndex)
                        }
                    },
                    icon = Icons.Rounded.KeyboardArrowDown,
                    contentDescription = "回到最新消息",
                    size = 44.dp,
                )
            }
        },
    ) { padding ->
        Column(Modifier.fillMaxSize().padding(padding)) {
            conversation.runtimeError?.let { runtimeError ->
                Box(Modifier.fillMaxWidth().padding(start = 16.dp, top = 12.dp, end = 16.dp)) {
                    WarningCard(runtimeError)
                }
            }
            LazyColumn(
                state = listState,
                modifier = Modifier.fillMaxWidth().weight(1f),
                contentPadding = PaddingValues(horizontal = 16.dp, vertical = 16.dp),
                // 轮次间距 24，组内间距由 AssistantTurnCard 提供。
                verticalArrangement = Arrangement.spacedBy(24.dp),
            ) {
                if (runtime == null) item { WarningCard("此运行实例已离线。") }
                if (historyState?.loading == true) {
                    item { LinearProgressIndicator(modifier = Modifier.fillMaxWidth()) }
                }
                (state.sessionSyncFailures[runtimeId] ?: conversation.chatSyncError)?.let { syncError ->
                    item {
                        Column {
                            WarningCard("聊天记录加载失败：$syncError")
                            TextButton(onClick = { model.refreshRuntime(runtimeId, explicitRetry = true) }) { Text("重试") }
                        }
                    }
                }
                if (state.sessionSyncCommands.values.any { it.runtimeId == runtimeId && it.slow && it.exhaustedAt == null }) {
                    item { NoticeCard("聊天记录仍在同步，请稍候…") }
                }
                if (conversation.waitingLocalInteraction) {
                    item { WarningCard("此交互必须在电脑端完成。停止操作仅为尽力而为。") }
                }
                conversation.interactionNotice?.let { notice -> item { NoticeCard(notice) } }
                items(chatItems, key = ChatListItem::key) { item ->
                    when (item) {
                        is ChatListItem.UserMessage -> UserMessageCard(
                            runtimeId = runtimeId,
                            message = item.message,
                            downloads = state.downloads,
                            downloadArtifact = { artifact -> model.downloadArtifact(runtimeId, artifact) },
                            downloadFile = { path -> model.downloadFile(runtimeId, path) },
                        )

                        is ChatListItem.AssistantTurn -> AssistantTurnCard(
                            runtimeId = runtimeId,
                            messages = item.messages,
                            turnTiming = groupTurnTiming(item.messages.mapNotNull { messageTurnTimings[it.messageId] }),
                            nowMs = timerNow,
                            toolActivities = conversation.tools,
                            toolResults = presentation.toolResults,
                            downloads = state.downloads,
                            downloadArtifact = { artifact -> model.downloadArtifact(runtimeId, artifact) },
                            downloadFile = { path -> model.downloadFile(runtimeId, path) },
                        )
                    }
                }
                items(orphanTools, key = ToolActivity::toolCallId) { tool -> ToolCard(tool) }
            }
        }
    }

}

/** 会话元信息行共用的左侧槽宽：顶部信息块的图标与状态点都从这里起笔，文字才会落在同一条左基准线上。 */
private val MetaLineLeadingSlot = 20.dp

/** 顶部元信息行里图形与文字之间的间距。 */
private val MetaLineGap = 6.dp

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun SessionAliasDialog(
    runtime: RuntimeSummary,
    currentAlias: String?,
    onDismiss: () -> Unit,
    onSave: (String) -> Unit,
    onClear: () -> Unit,
) {
    var alias by remember(runtime.runtimeId, runtime.sessionId, currentAlias) {
        mutableStateOf(currentAlias.orEmpty())
    }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { AgentLabel(agentBrand(runtime.agentKind), suffix = "设置会话别名") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedTextField(
                    value = alias,
                    onValueChange = { alias = it.take(SESSION_ALIAS_MAX_LENGTH) },
                    modifier = Modifier.fillMaxWidth(),
                    label = { Text("APP 显示名称") },
                    singleLine = true,
                    supportingText = {
                        Text("${alias.length}/$SESSION_ALIAS_MAX_LENGTH")
                    },
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Text),
                )
                runtime.hostname?.trim()?.takeIf(String::isNotEmpty)?.let { host ->
                    Text(
                        "主机名：$host",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
                Text(
                    "Session 显示名称：${runtime.sessionName?.trim()?.takeIf(String::isNotEmpty) ?: "未设置"}",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        },
        confirmButton = {
            NeumorphTextButton(
                text = "保存",
                filled = true,
                enabled = normalizeSessionAlias(alias) != null,
                onClick = { onSave(alias) },
            )
        },
        dismissButton = {
            FlowRow(horizontalArrangement = Arrangement.spacedBy(12.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                NeumorphTextButton(
                    text = "恢复默认",
                    enabled = currentAlias != null,
                    onClick = onClear,
                )
                NeumorphTextButton(text = "取消", onClick = onDismiss)
            }
        },
    )
}

@Composable
private fun SlashCommandPicker(
    input: String,
    commands: List<RuntimeSlashCommand>,
    selectedCommandName: String?,
    isCodex: Boolean = false,
    isDsh: Boolean = false,
    onOpenTree: () -> Unit,
    onCommandSelected: (RuntimeSlashCommand, String) -> Unit,
) {
    if (!input.startsWith("/")) return
    val invocation = input.removePrefix("/")
    val separator = invocation.indexOfFirst(Char::isWhitespace)
    val selected = parseSlashInvocation(input)
        ?.first
        ?.takeIf { it == selectedCommandName }
        ?.let { name -> commands.find { it.name == name } }
    val argument = selected?.argument

    if (selected != null && argument?.kind == "tree") {
        // 树候选现在有自己的整页：这里不再画 280dp 的小树，只负责把页面打开。
        LaunchedEffect(selected.name) { onOpenTree() }
        return
    }
    if (selected != null && argument?.kind == "select") {
        val query = if (separator < 0) "" else invocation.substring(separator + 1).trim().lowercase()
        val options = argument.options
            .filter { option ->
                option.value.lowercase().contains(query) ||
                    option.label.lowercase().contains(query) ||
                    option.description?.lowercase()?.contains(query) == true
            }
        SlashOptionList(options = options) { option ->
            onCommandSelected(selected, "/${selected.name} ${option.value}")
        }
        return
    }
    if (selected != null || separator >= 0) return

    val query = invocation.lowercase()
    val matches = commands
        .filter { it.name.lowercase().startsWith(query) }
        .sortedWith(compareBy<RuntimeSlashCommand> { it.source != "builtin" }.thenBy { it.name })
    if (matches.isEmpty()) return
    LazyColumn(
        modifier = Modifier.fillMaxWidth().heightIn(max = 260.dp),
        contentPadding = PaddingValues(horizontal = RemoteUi.PagePadding, vertical = 8.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        items(matches, key = { "slash:${it.source}:${it.name}" }) { command ->
            NeumorphSurface(
                onClick = {
                    onCommandSelected(command, "/${command.name}${if (command.argument == null) "" else " "}")
                },
                shape = RemoteUi.ControlShape,
                shadowScale = 0.5f,
                modifier = Modifier.fillMaxWidth(),
            ) {
                Column(Modifier.fillMaxWidth().heightIn(min = RemoteUi.TouchTarget).padding(12.dp)) {
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        Text(
                            "/${command.name}",
                            modifier = Modifier.weight(1f),
                            fontFamily = FontFamily.Monospace,
                            fontWeight = FontWeight.SemiBold,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                        Text(if (isDsh && command.source == "builtin") "DeepSeek" else slashSourceText(command.source, isCodex), color = MaterialTheme.colorScheme.primary)
                    }
                    command.description?.let {
                        Text(
                            if (command.argument?.hint == null) it else "$it ${command.argument.hint}",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun SlashOptionList(
    options: List<RuntimeSlashCommandOption>,
    onSelect: (RuntimeSlashCommandOption) -> Unit,
) {
    if (options.isEmpty()) {
        Text(
            "当前 ${LocalAgentBrand.current.title} 没有匹配的可选项",
            modifier = Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 12.dp),
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        return
    }
    val listState = remember { LazyListState() }
    LazyColumn(
        state = listState,
        modifier = Modifier.fillMaxWidth().heightIn(max = 260.dp),
        contentPadding = PaddingValues(horizontal = RemoteUi.PagePadding, vertical = 8.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        items(options, key = RuntimeSlashCommandOption::value) { option ->
            NeumorphSurface(
                onClick = { onSelect(option) },
                shape = RemoteUi.ControlShape,
                shadowScale = 0.5f,
                modifier = Modifier.fillMaxWidth(),
            ) {
                Column(Modifier.fillMaxWidth().heightIn(min = RemoteUi.TouchTarget).padding(12.dp)) {
                    Text(
                        option.label,
                        fontWeight = FontWeight.SemiBold,
                        maxLines = 2,
                        overflow = TextOverflow.Ellipsis,
                    )
                    option.description?.let {
                        Text(
                            it,
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            maxLines = 2,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }
                }
            }
        }
    }
}

internal fun canSubmitInput(
    input: String,
    commands: List<RuntimeSlashCommand>,
    selectedSlashCommandName: String?,
): Boolean {
    val trimmed = input.trim()
    if (trimmed.isBlank()) return false
    if (!trimmed.startsWith("/")) return true
    val (name, args) = parseSlashInvocation(trimmed) ?: return false
    if (name != selectedSlashCommandName) return false
    val command = commands.find { it.name == name } ?: return false
    if (command.argument == null && args.isNotBlank()) return false
    return command.argument?.required != true || args.isNotBlank()
}

internal fun matchesSelectedSlashCommand(input: String, selectedName: String?): Boolean {
    if (selectedName == null) return false
    return parseSlashInvocation(input)?.first == selectedName
}

internal fun parseSlashInvocation(input: String): Pair<String, String>? {
    val trimmed = input.trim()
    if (!trimmed.startsWith("/")) return null
    val invocation = trimmed.removePrefix("/")
    val separator = invocation.indexOfFirst(Char::isWhitespace)
    val name = if (separator < 0) invocation else invocation.substring(0, separator)
    if (name.isBlank()) return null
    val args = if (separator < 0) "" else invocation.substring(separator).trim()
    return name to args
}

private fun slashCommandFeedback(input: String, result: CommandResult): String {
    val name = parseSlashInvocation(input)?.first ?: "command"
    val detail = result.result?.toString()?.takeIf { it != "{}" && it != "null" }
    return if (detail == null) "/$name 已完成" else "/$name 已完成：$detail"
}

/**
 * 命令来源徽标。`builtin` 在 Pi 与 Codex 下都出现，但含义不同：
 * Pi 的是本体会话命令，Codex 的是 app-server RPC——按后端给不同文案，
 * 免得 Codex 会话里点 `/model` 看到 "Pi" 徽标以为连错了电脑。
 */
internal fun slashSourceText(source: String, isCodex: Boolean = false): String = when (source) {
    "builtin" -> if (isCodex) "Codex" else "Pi"
    "extension" -> "扩展"
    "prompt" -> "模板"
    "skill" -> "Skill"
    else -> source
}

@Composable
private fun DownloadStatusButton(
    activeCount: Int,
    enabled: Boolean,
    onClick: () -> Unit,
) {
    Box {
        // S6：顶栏图标按钮是凸起圆钮。
        NeumorphIconButton(
            onClick = onClick,
            icon = Icons.Rounded.Download,
            contentDescription = if (activeCount > 0) "$activeCount 个文件正在下载" else "打开下载",
            enabled = enabled,
            size = 40.dp,
        )
        Box(Modifier.size(RemoteUi.TouchTarget)) {
            if (activeCount > 0) {
                Badge(
                    modifier = Modifier.align(Alignment.TopEnd),
                    containerColor = MaterialTheme.colorScheme.primary,
                    contentColor = MaterialTheme.colorScheme.onPrimary,
                ) {
                    Text(if (activeCount > 9) "9+" else activeCount.toString())
                }
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class, ExperimentalFoundationApi::class)
@Composable
internal fun AllDownloadsScreen(
    state: RemoteState,
    onBack: () -> Unit,
    onBrowse: (String?) -> Unit,
    onBrowseInto: (String) -> Unit,
    onBrowseUp: () -> Unit,
    onDismissBrowse: () -> Unit,
    onDownload: (String) -> Unit,
    onRetry: (String) -> Unit,
    onCancel: (String) -> Unit,
    onDelete: (Set<String>) -> Unit,
) {
    var filePickerOpen by rememberSaveable { mutableStateOf(false) }
    var selectedTaskIds by remember { mutableStateOf<Set<String>>(emptySet()) }
    val downloads = state.downloads.values.sortedByDescending(ArtifactDownload::createdAt)
    val visibleTaskIds = downloads.mapTo(mutableSetOf(), ArtifactDownload::taskId)
    val effectiveSelectedTaskIds = selectedTaskIds.intersect(visibleTaskIds)
    val activeCount = downloads.count { it.status == "queued" || it.status == "downloading" }
    val selectionMode = effectiveSelectedTaskIds.isNotEmpty()
    BackHandler(onBack = onBack)
    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    Column {
                        Text(
                            if (selectionMode) "已选择 ${effectiveSelectedTaskIds.size} 项" else "下载",
                            fontWeight = FontWeight.SemiBold,
                        )
                        if (!selectionMode) {
                            Text(
                                "$activeCount 个任务进行中",
                                style = MaterialTheme.typography.labelMedium,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                    }
                },
                navigationIcon = {
                    NeumorphIconButton(
                        onClick = { if (selectionMode) selectedTaskIds = emptySet() else onBack() },
                        icon = if (selectionMode) Icons.Rounded.Close else Icons.Rounded.ArrowBack,
                        contentDescription = if (selectionMode) "退出多选" else "返回",
                        size = 40.dp,
                    )
                },
                actions = {
                    if (selectionMode) {
                        NeumorphIconButton(
                            onClick = {
                                onDelete(effectiveSelectedTaskIds)
                                selectedTaskIds = emptySet()
                            },
                            icon = Icons.Rounded.Delete,
                            contentDescription = "删除下载项",
                            size = 40.dp,
                        )
                    }
                },
            )
        },
    ) { padding ->
        Column(Modifier.fillMaxSize().padding(padding)) {
            Text(
                "浏览电脑目录，选择文件下载到手机",
                style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(horizontal = RemoteUi.PagePadding, vertical = 12.dp),
            )
            NeumorphActionButton(
                text = "浏览电脑文件",
                icon = Icons.Rounded.Folder,
                onClick = { onDismissBrowse(); filePickerOpen = true },
                modifier = Modifier.fillMaxWidth().padding(horizontal = RemoteUi.PagePadding).padding(bottom = 20.dp),
            )
            HorizontalDivider()
            if (downloads.isEmpty()) {
                Column(
                    Modifier.fillMaxSize(),
                    verticalArrangement = Arrangement.Center,
                    horizontalAlignment = Alignment.CenterHorizontally,
                ) {
                    Icon(Icons.Rounded.Download, contentDescription = null, modifier = Modifier.size(40.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
                    Spacer(Modifier.height(10.dp))
                    Text("暂无下载任务", color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            } else {
                LazyColumn(
                    modifier = Modifier.fillMaxSize(),
                    contentPadding = PaddingValues(RemoteUi.PagePadding),
                    verticalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    items(downloads, key = ArtifactDownload::taskId) { task ->
                        DownloadTaskCard(
                            task = task,
                            contextLabel = downloadTaskContext(state, task),
                            onRetry = { taskId -> onRetry(taskId) },
                            onCancel = onCancel,
                            selected = task.taskId in effectiveSelectedTaskIds,
                            selectionMode = selectionMode,
                            onClick = {
                                selectedTaskIds = if (task.taskId in selectedTaskIds) {
                                    selectedTaskIds - task.taskId
                                } else {
                                    selectedTaskIds + task.taskId
                                }
                            },
                            onLongClick = {
                                selectedTaskIds = selectedTaskIds + task.taskId
                            },
                        )
                    }
                }
            }
        }
    }
    if (filePickerOpen) {
        DownloadFileSheet(
            state = state,
            onDismiss = { filePickerOpen = false; onDismissBrowse() },
            onBrowse = onBrowse,
            onBrowseInto = onBrowseInto,
            onBrowseUp = onBrowseUp,
            onDownload = onDownload,
        )
    }
}

private fun downloadTaskContext(state: RemoteState, task: ArtifactDownload): String {
    val runtime = state.runtimes[task.runtimeId]
    val runtimeName = when {
        task.sessionId != null -> state.sessionDisplayName(
            task.sessionId,
            runtime?.takeIf { it.sessionId == task.sessionId },
        )
        runtime != null -> state.runtimeDisplayName(runtime)
        task.runtimeId.isBlank() -> "电脑"
        else -> "来源会话已离线"
    }
    val session = when {
        task.sessionId == null -> "会话未知"
        runtime == null -> "原会话 ${shortSessionId(task.sessionId)}"
        runtime.sessionId == task.sessionId -> "当前会话"
        else -> "原会话 ${shortSessionId(task.sessionId)}（当前已切换会话）"
    }
    return "$runtimeName · $session"
}

private fun shortSessionId(sessionId: String): String =
    sessionId.take(8).ifBlank { "未知" }

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun DownloadTaskCard(
    task: ArtifactDownload,
    onRetry: (String) -> Unit,
    onCancel: (String) -> Unit = {},
    contextLabel: String? = null,
    selected: Boolean = false,
    selectionMode: Boolean = false,
    onClick: () -> Unit = {},
    onLongClick: () -> Unit = {},
) {
    val total = task.artifact?.size
    val progress = total?.takeIf { it > 0 }?.let { (task.receivedBytes.toFloat() / it).coerceIn(0f, 1f) }
    val active = task.status == "queued" || task.status == "downloading"
    val canCancel = active
    // 重试不看 runtime 在不在：文件在电脑磁盘上，Host 会直接读盘发分片（spec §8.1）。
    val canRetry = !active && task.status != "completed" &&
        (task.sourcePath != null || task.sourceArtifactId != null)
    val statusColor = when (task.status) {
        "completed" -> MaterialTheme.colorScheme.tertiary
        "failed" -> MaterialTheme.colorScheme.error
        "paused", "cancelled" -> MaterialTheme.colorScheme.secondary
        else -> MaterialTheme.colorScheme.primary
    }
    NeumorphSurface(
        modifier = Modifier.fillMaxWidth(),
        onClick = { if (selectionMode) onClick() },
        onLongClick = onLongClick,
        shape = RemoteUi.CardShape,
        style = if (selected) NeumorphStyle.Pressed else NeumorphStyle.Raised,
    ) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                if (selectionMode) {
                    NeumorphCheckbox(
                        checked = selected,
                        onCheckedChange = { onClick() },
                    )
                }
                Icon(
                    when (task.status) {
                        "completed" -> Icons.Rounded.CheckCircle
                        "failed" -> Icons.Rounded.ErrorOutline
                        else -> Icons.Rounded.Download
                    },
                    contentDescription = null,
                    tint = statusColor,
                )
                Column(Modifier.weight(1f)) {
                    Text(task.displayName, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Text(downloadStatusText(task), style = MaterialTheme.typography.bodySmall, color = statusColor)
                }
                if (active) {
                    if (canCancel) {
                        NeumorphIconButton(
                            onClick = { onCancel(task.taskId) },
                            icon = Icons.Rounded.StopCircle,
                            contentDescription = "取消下载",
                            size = 40.dp,
                        )
                    } else {
                        CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp)
                    }
                } else if (canRetry) {
                    NeumorphIconButton(
                        onClick = { onRetry(task.taskId) },
                        icon = Icons.Rounded.Refresh,
                        contentDescription = "继续下载",
                        size = 40.dp,
                    )
                }
            }
            contextLabel?.let { label ->
                Text(label, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            if (active || task.status == "paused" || task.status == "failed") {
                if (progress == null) LinearProgressIndicator(Modifier.fillMaxWidth())
                else LinearProgressIndicator(progress = { progress }, modifier = Modifier.fillMaxWidth())
            }
            val source = task.sourcePath
            if (source != null) {
                Text(source, style = MaterialTheme.typography.bodySmall, fontFamily = FontFamily.Monospace, maxLines = 2, overflow = TextOverflow.Ellipsis)
            }
            task.savedLocation?.let { location ->
                Text(
                    "保存到：${savedLocationText(task, location)}",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            task.error?.let { error ->
                if (task.status == "failed" || task.status == "paused") {
                    Text(error, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
                }
            }
        }
    }
}

private fun savedLocationText(task: ArtifactDownload, location: String): String =
    if (location.startsWith("content://")) "手机系统“下载”目录 · ${task.displayName}" else location

private fun downloadStatusText(task: ArtifactDownload): String = when (task.status) {
    "queued" -> "正在请求文件"
    "downloading" -> task.artifact?.size?.let { size ->
        "${formatByteCount(task.receivedBytes)} / ${formatByteCount(size)}"
    } ?: "正在下载"
    "completed" -> "下载完成"
    "paused" -> "已暂停 · ${formatByteCount(task.receivedBytes)}"
    "cancelled" -> "已取消 · ${formatByteCount(task.receivedBytes)}"
    "failed" -> "下载失败 · ${formatByteCount(task.receivedBytes)}"
    else -> task.status
}

@Composable
private fun ConnectionStatus(connection: RelayConnection, e2eReady: Boolean, path: String? = null) {
    // 握手中也算「忙」：中继认了、加密通道没成时，这段时间是能恢复的，不该显示成稳态。
    val isBusy = connection == RelayConnection.CONNECTING ||
        connection == RelayConnection.RECONNECTING ||
        (connection == RelayConnection.ONLINE && !e2eReady)
    val color = when {
        connection == RelayConnection.ONLINE && e2eReady -> MaterialTheme.colorScheme.tertiary
        connection == RelayConnection.RECONNECTING -> MaterialTheme.colorScheme.error
        connection == RelayConnection.ONLINE -> MaterialTheme.colorScheme.error
        else -> MaterialTheme.colorScheme.onSurfaceVariant
    }
    NeumorphSurface(
        modifier = Modifier.padding(vertical = 8.dp),
        style = NeumorphStyle.Pressed,
        shape = CircleShape,
        shadowScale = 0.3f,
    ) {
    Row(
        modifier = Modifier.padding(horizontal = 12.dp, vertical = 8.dp),
        horizontalArrangement = Arrangement.spacedBy(6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (isBusy) {
            CircularProgressIndicator(Modifier.size(12.dp), strokeWidth = 2.dp, color = color)
        } else {
            Box(Modifier.size(8.dp).clip(CircleShape).background(color))
        }
        Text(
            // 颜色表达连接状态，文字只表达当前连接模式。
            transportPathLabel(path) ?: "中继",
            color = color,
            style = MaterialTheme.typography.labelMedium,
        )
    }
}

}

/**
 * 连接状态页：把控制链底座摊开成可扫读的两段——连接/加密与配对/凭据。
 *
 * 与诊断弹窗的分工：诊断弹窗事后排障（含最近事件轨迹），本页只回答「现在通不通」；
 * 会话同步、下载、缓存等不在这里。没有加密通道（或配对材料不完整）时，置顶给一句可照做的下一步。
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun StatusScreen(
    state: RemoteState,
    pairing: PairingStatus,
    onBack: () -> Unit,
    onOpenSettings: () -> Unit,
    onRawDiagnostics: () -> String,
) {
    BackHandler(onBack = onBack)
    // 原始事件日志是这个 APP 唯一的现场排障面（手机未必能接 logcat），状态页只回答「现在通不通」，
    // 但两者同源于一个诊断按钮，所以把它降级为次级入口，而不是随旧弹窗一起删掉。
    var rawLog by remember { mutableStateOf<String?>(null) }
    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("连接状态", fontWeight = FontWeight.SemiBold) },
                navigationIcon = {
                    NeumorphIconButton(
                        onClick = onBack,
                        icon = Icons.Rounded.ArrowBack,
                        contentDescription = "返回",
                        size = 40.dp,
                    )
                },
                actions = {
                    NeumorphIconButton(
                        onClick = onOpenSettings,
                        icon = Icons.Rounded.Settings,
                        contentDescription = "设置",
                        size = 40.dp,
                    )
                    NeumorphTextButton(
                        text = "原始事件",
                        onClick = { rawLog = onRawDiagnostics() },
                    )
                },
            )
        },
    ) { padding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
                .verticalScroll(rememberScrollState())
                .padding(horizontal = RemoteUi.PagePadding, vertical = 16.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            statusAdvice(state, pairing)?.let { WarningCard(it) }

            StatusSectionTitle("连接与加密")
            StatusCard {
                StatusRow("连接方式", connectionMethodText(state), connectionMethodTone(state))
                StatusRow("中继连接", relayConnectionText(state.connection), relayConnectionTone(state.connection))
                StatusRow("加密通道", if (state.e2eReady) "已建立" else "未建立", e2eTone(state))
                StatusFact("路径延迟", state.pathRttMs?.let { "${it}ms" } ?: "—")
                StatusFact("Relay 地址", pairing.relayUrl ?: "—")
                StatusFact("本机 deviceId", pairing.deviceId ?: "—")
                StatusFact("Host hostId", pairing.hostId ?: "—")
            }

            StatusSectionTitle("配对与凭据")
            StatusCard {
                StatusRow("配对状态", pairingText(pairing), pairingTone(pairing))
                StatusFact("Host 公钥指纹", pairing.hostPublicKeyFingerprint ?: "—")
                StatusFact("配对根密钥", if (pairing.pskRootPresent) "已保存" else "缺失")
            }
        }
    }
    rawLog?.let { text ->
        AlertDialog(
            onDismissRequest = { rawLog = null },
            title = { Text("原始事件") },
            text = {
                Column(
                    Modifier
                        .heightIn(max = 420.dp)
                        .verticalScroll(rememberScrollState()),
                ) {
                    Text(
                        text,
                        style = MaterialTheme.typography.bodySmall,
                        fontFamily = FontFamily.Monospace,
                    )
                }
            },
            confirmButton = {
                NeumorphTextButton("刷新", filled = true, onClick = { rawLog = onRawDiagnostics() })
            },
            dismissButton = {
                NeumorphTextButton("关闭", onClick = { rawLog = null })
            },
        )
    }
}

/**
 * 设置页。目前只有一项：连接优先级（§6.2）。
 *
 * 顺序是用户显式排的，所以它压过 RTT 证据（Host 侧 PathSelector 的规矩）：
 * 更高优先级的路径一建立就会顶替当前路径，不再需要「快 30% 且连续 3 次」。
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun SettingsScreen(model: RemoteViewModel, onBack: () -> Unit) {
    BackHandler(onBack = onBack)
    val state by model.state.collectAsStateWithLifecycle()
    var providersOpen by remember { mutableStateOf(false) }
    if (providersOpen) {
        AgentProvidersScreen(state, model, onBack = { providersOpen = false })
        return
    }
    // 顺序改在本地状态里：store 不是 Compose state，不这么写点完箭头界面不会刷新。
    var order by remember { mutableStateOf(model.pathPreference()) }
    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("设置", fontWeight = FontWeight.SemiBold) },
                navigationIcon = {
                    NeumorphIconButton(
                        onClick = onBack,
                        icon = Icons.Rounded.ArrowBack,
                        contentDescription = "返回",
                        size = 40.dp,
                    )
                },
            )
        },
    ) { padding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
                .verticalScroll(rememberScrollState())
                .padding(horizontal = RemoteUi.PagePadding, vertical = 16.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            StatusSectionTitle("Agent 供应商")
            StatusCard {
                Text("切换电脑上已保存的供应商。API 地址、密钥与模型在 Host 的 Agent 页面配置。", style = MaterialTheme.typography.bodySmall)
                TextButton(onClick = { providersOpen = true; model.loadAgentProviders("codex") }) { Text("供应商配置与切换") }
            }
            StatusSectionTitle("连接优先级")
            StatusCard {
                Text(
                    "越靠上越优先。更高优先级的路径一建立就顶替当前路径；当前路径断开时立刻回落到剩下最靠上的那条。",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(vertical = 6.dp),
                )
                order.forEachIndexed { index, kind ->
                    PriorityOrderRow(
                        rank = index + 1,
                        kind = kind,
                        canMoveUp = index > 0,
                        canMoveDown = index < order.lastIndex,
                        onMoveUp = {
                            order = order.moved(index, index - 1)
                            model.setPathPreference(order)
                        },
                        onMoveDown = {
                            order = order.moved(index, index + 1)
                            model.setPathPreference(order)
                        },
                    )
                }
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun AgentProvidersScreen(state: RemoteState, model: RemoteViewModel, onBack: () -> Unit) {
    BackHandler(onBack = onBack)
    val catalog = state.agentProviders
    var pending by remember(state.hostId, catalog.kind) { mutableStateOf<AgentProvider?>(null) }
    val available = state.e2eReady && state.connection == RelayConnection.ONLINE && catalog.hostId == state.hostId && !catalog.loading
    Scaffold(topBar = {
        TopAppBar(title = { Text("供应商") }, navigationIcon = {
            NeumorphIconButton(onClick = onBack, icon = Icons.Rounded.ArrowBack, contentDescription = "返回", size = 40.dp)
        }, actions = { TextButton(onClick = { model.loadAgentProviders(catalog.kind) }, enabled = !catalog.loading) { Text("刷新") } })
    }) { padding ->
        Column(Modifier.fillMaxSize().padding(padding).verticalScroll(rememberScrollState()).padding(20.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
            Text(state.hostName ?: "已配对的电脑", style = MaterialTheme.typography.titleMedium)
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                listOf("pi" to "Pi", "codex" to "Codex", "dsh" to "DeepSeek").forEach { (kind, label) ->
                    FilterChip(selected = catalog.kind == kind, onClick = { model.loadAgentProviders(kind) }, label = { Text(label) }, enabled = !catalog.loading)
                }
            }
            Text(if (catalog.kind == "pi") "可同时启用多个供应商。更改后重新打开 Pi，再用 /model 选择模型。" else "切换后重新打开会话。正在工作的 Agent 需先结束当前任务。", style = MaterialTheme.typography.bodySmall)
            if (catalog.loading) LinearProgressIndicator(Modifier.fillMaxWidth())
            catalog.error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
            catalog.notice?.let { Text(it, color = MaterialTheme.colorScheme.primary) }
            if (!catalog.loading && catalog.error == null && catalog.providers.isEmpty()) Text("还没有供应商，请先在 Host 的 Agent 页面添加。")
            catalog.providers.forEach { provider ->
                StatusCard {
                    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                        Column(Modifier.weight(1f)) {
                            Text(provider.name, fontWeight = FontWeight.SemiBold)
                            Text(if (provider.enabled) (if (provider.additive) "已启用" else "当前使用") else "未启用", style = MaterialTheme.typography.bodySmall)
                        }
                        if (!provider.enabled || provider.additive) TextButton(onClick = { pending = provider }, enabled = available) { Text(if (provider.enabled) "停用" else "启用") }
                    }
                }
            }
        }
    }
    pending?.let { provider ->
        AlertDialog(onDismissRequest = { pending = null }, title = { Text(if (provider.enabled) "停用供应商" else "启用供应商") },
            text = { Text("${provider.name}\n${if (provider.additive) "将更新 Pi 显式配置。" else "将切换 Host 配置，并重新加载后台 Agent。已有会话需要重新打开。"}") },
            confirmButton = { TextButton(enabled = available, onClick = { model.switchAgentProvider(provider, catalog.hostId); pending = null }) { Text("确认") } },
            dismissButton = { TextButton(onClick = { pending = null }) { Text("取消") } })
    }
}

@Composable
private fun PriorityOrderRow(
    rank: Int,
    kind: String,
    canMoveUp: Boolean,
    canMoveDown: Boolean,
    onMoveUp: () -> Unit,
    onMoveDown: () -> Unit,
) {
    Row(
        modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Text(
            "第 $rank 优先",
            style = MaterialTheme.typography.labelMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.weight(0.8f),
        )
        Text(
            transportPathLabel(kind) ?: kind,
            style = MaterialTheme.typography.bodyMedium,
            modifier = Modifier.weight(1f),
        )
        NeumorphIconButton(
            onClick = onMoveUp,
            icon = Icons.Rounded.ArrowUpward,
            contentDescription = "上移",
            size = 40.dp,
            enabled = canMoveUp,
        )
        NeumorphIconButton(
            onClick = onMoveDown,
            icon = Icons.Rounded.ArrowDownward,
            contentDescription = "下移",
            size = 40.dp,
            enabled = canMoveDown,
        )
    }
}

/** 把 [from] 位置的一项挪到 [to]，越界或原地不动时原样返回。 */
internal fun <T> List<T>.moved(from: Int, to: Int): List<T> {
    if (from !in indices || to !in indices || from == to) return this
    val copy = toMutableList()
    copy.add(to, copy.removeAt(from))
    return copy
}

/**
 * 只在控制链底座不健康时给下一步。优先说配对不完整：那是最容易被误当成「网络问题」的一种，
 * 因为手机确实连上了中继，只是永远没有加密通道。
 */
internal fun statusAdvice(state: RemoteState, pairing: PairingStatus): String? = when {
    pairing.hostId == null || !pairing.pskRootPresent ->
        "配对不完整（缺少端到端加密材料）：请在主界面点「取消配对」，再扫电脑上的新二维码"
    state.connection == RelayConnection.ONLINE && !state.e2eReady ->
        "已连上中继，但电脑没有回应端到端加密握手：请确认电脑上的 Pi 正在运行；若已运行，这台手机的配对可能已失效"
    state.connection == RelayConnection.OFFLINE -> "未连接到中继服务器：请检查网络与 Relay 地址"
    else -> null
}

internal fun transportPathLabel(path: String?): String? = when (path) {
    "p2p" -> "P2P 直连"
    "lan" -> "局域网"
    "relay" -> "中继"
    else -> null
}

/**
 * 当前连接方式（spec §14 B4）。Host 没宣布路径时，出站默认走中继（RelayClient.activePath 的约定），
 * 所以在线时不能显示成「未知」——那会让人以为连接方式根本没取到。
 */
internal fun connectionMethodText(state: RemoteState): String =
    transportPathLabel(state.path)
        ?: if (state.connection == RelayConnection.ONLINE) "中继（默认）" else "未知"

/** 直连（P2P/局域网）比经中继更值得一眼看出来，所以给它们更「好」的颜色。 */
internal fun connectionMethodTone(state: RemoteState): StatusTone = when (state.path) {
    "p2p", "lan" -> StatusTone.Good
    else -> StatusTone.Neutral
}

private fun relayConnectionText(connection: RelayConnection): String = when (connection) {
    RelayConnection.OFFLINE -> "离线"
    RelayConnection.CONNECTING -> "正在连接"
    RelayConnection.ONLINE -> "已连接"
    RelayConnection.RECONNECTING -> "正在重新连接"
}

internal enum class StatusTone { Good, Warn, Bad, Neutral }

internal fun relayConnectionTone(connection: RelayConnection): StatusTone = when (connection) {
    RelayConnection.ONLINE -> StatusTone.Good
    RelayConnection.CONNECTING -> StatusTone.Warn
    RelayConnection.RECONNECTING -> StatusTone.Bad
    RelayConnection.OFFLINE -> StatusTone.Neutral
}

internal fun e2eTone(state: RemoteState): StatusTone = when {
    state.e2eReady -> StatusTone.Good
    state.connection == RelayConnection.ONLINE -> StatusTone.Bad
    state.connection == RelayConnection.CONNECTING || state.connection == RelayConnection.RECONNECTING -> StatusTone.Warn
    else -> StatusTone.Neutral
}

internal fun pairingText(pairing: PairingStatus): String = when {
    pairing.hostId == null -> "未配对"
    !pairing.pskRootPresent -> "缺少加密材料"
    else -> "完整"
}

internal fun pairingTone(pairing: PairingStatus): StatusTone =
    if (pairing.hostId != null && pairing.pskRootPresent) StatusTone.Good else StatusTone.Bad

@Composable
private fun StatusSectionTitle(text: String) {
    Text(
        text,
        style = MaterialTheme.typography.titleSmall,
        fontWeight = FontWeight.SemiBold,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier.padding(top = 4.dp, start = 4.dp),
    )
}

@Composable
private fun StatusCard(content: @Composable ColumnScope.() -> Unit) {
    NeumorphSurface(
        modifier = Modifier.fillMaxWidth(),
        shape = RemoteUi.CardShape,
    ) {
        Column(Modifier.fillMaxWidth().padding(16.dp), content = content)
    }
}

@Composable
private fun StatusRow(label: String, value: String, tone: StatusTone) {
    val color = statusToneColor(tone)
    Row(
        modifier = Modifier.fillMaxWidth().padding(vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text(label, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.weight(1f))
        NeumorphSurface(style = NeumorphStyle.Pressed, shape = CircleShape, shadowScale = 0.25f) {
        Row(
            modifier = Modifier.padding(horizontal = 10.dp, vertical = 6.dp),
            horizontalArrangement = Arrangement.spacedBy(6.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Box(Modifier.size(8.dp).clip(CircleShape).background(color))
            Text(value, color = color, style = MaterialTheme.typography.labelMedium)
        }
        }
    }
}

@Composable
private fun StatusFact(label: String, value: String) {
    Column(Modifier.fillMaxWidth().padding(vertical = 6.dp)) {
        Text(
            label,
            style = MaterialTheme.typography.labelMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        SelectionContainer {
            Text(
                value,
                style = MaterialTheme.typography.bodySmall,
                fontFamily = FontFamily.Monospace,
                modifier = Modifier.padding(top = 2.dp),
            )
        }
    }
}

@Composable
private fun statusToneColor(tone: StatusTone): Color = when (tone) {
    StatusTone.Good -> MaterialTheme.colorScheme.tertiary
    StatusTone.Warn -> MaterialTheme.colorScheme.primary
    StatusTone.Bad -> MaterialTheme.colorScheme.error
    StatusTone.Neutral -> MaterialTheme.colorScheme.onSurfaceVariant
}

@Composable
private fun TurnStartLabel(startedAt: Long) {
    val startTime = remember(startedAt) {
        SimpleDateFormat("HH:mm:ss", Locale.getDefault()).format(Date(startedAt))
    }
    Text(
        text = "开始 $startTime",
        style = MaterialTheme.typography.labelSmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier.padding(horizontal = 4.dp, vertical = 2.dp),
    )
}

@Composable
private fun TurnDurationLabel(timing: TurnTiming, nowMs: Long) {
    val active = timing.durationMs == null
    val durationMs = timing.durationMs ?: max(0L, nowMs - timing.startedAt)
    Text(
        text = "耗时 ${formatTurnDuration(durationMs)}${if (active) " · 进行中" else ""}",
        style = MaterialTheme.typography.labelSmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier.padding(horizontal = 4.dp, vertical = 2.dp),
    )
}

private fun formatTurnDuration(durationMs: Long): String {
    val totalSeconds = durationMs / 1_000
    return if (totalSeconds < 60) {
        "${totalSeconds}s"
    } else {
        "${totalSeconds / 60}m ${totalSeconds % 60}s"
    }
}

/**
 * Ambient context meter: a hairline pinned to the top edge of the composer area that fills as the
 * conversation approaches the model's context window. The composer is the container; the rail is
 * how full it is. Silent below the elevated threshold — the fill itself is the message.
 */
@Composable
private fun ComposerContextRail(status: ComposerStatus) {
    val progress = status.contextProgress ?: return
    val color = when (status.severity) {
        ContextUsageSeverity.Normal -> MaterialTheme.colorScheme.outlineVariant
        ContextUsageSeverity.Elevated -> MaterialTheme.colorScheme.primary
        ContextUsageSeverity.Critical -> MaterialTheme.colorScheme.error
    }
    val animated by animateFloatAsState(
        targetValue = progress.coerceIn(0f, 1f),
        animationSpec = tween(durationMillis = 450),
        label = "contextRail",
    )
    Box(
        Modifier
            .fillMaxWidth()
            .height(2.dp)
            .background(color.copy(alpha = 0.18f)),
    ) {
        Box(
            Modifier
                .fillMaxWidth(animated.coerceAtLeast(if (progress > 0f) 0.02f else 0f))
                .fillMaxHeight()
                .background(color),
        )
    }
}

/** Numeric detail is noise until the context actually starts running out; then it fades in. */
@Composable
private fun ComposerContextNotice(status: ComposerStatus) {
    val label = status.contextLabel ?: return
    AnimatedVisibility(
        visible = status.severity != ContextUsageSeverity.Normal,
        enter = fadeIn(tween(200)) + expandVertically(),
        exit = fadeOut(tween(200)) + shrinkVertically(),
    ) {
        Text(
            "上下文 $label",
            modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 2.dp),
            style = MaterialTheme.typography.labelSmall,
            fontWeight = FontWeight.Medium,
            color = if (status.severity == ContextUsageSeverity.Critical) {
                MaterialTheme.colorScheme.error
            } else {
                MaterialTheme.colorScheme.primary
            },
            maxLines = 1,
        )
    }
}

@Composable
private fun ChatRuntimeStatus(
    status: String,
    isChatSyncing: Boolean,
    modelLabel: String?,
    thinkingLevel: String?,
) {
    Row(
        Modifier.fillMaxWidth(),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(MetaLineGap),
    ) {
        MetaLineSlot { RuntimeStatusDot(status) }
        Text(runtimeStatusText(status), color = runtimeStatusColor(status), style = MaterialTheme.typography.labelSmall)
        modelLabel?.takeIf(String::isNotBlank)?.let { label ->
            Text(
                "· $label",
                // fill = false：短标签只占自身宽度，不撑满剩余空间把内容推到行尾。
                modifier = Modifier.weight(1f, fill = false).widthIn(max = 132.dp),
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                style = MaterialTheme.typography.labelSmall,
                fontWeight = FontWeight.Medium,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
        thinkingLevel?.takeIf(String::isNotBlank)?.let { level ->
            Text(
                "· $level",
                modifier = Modifier.widthIn(max = 96.dp),
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                style = MaterialTheme.typography.labelSmall,
                fontWeight = FontWeight.Medium,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
        if (isChatSyncing) {
            CircularProgressIndicator(
                modifier = Modifier.size(11.dp),
                strokeWidth = 1.5.dp,
                color = MaterialTheme.colorScheme.secondary,
            )
        }
    }
}

/** 顶部信息块每行的左侧槽：行首图形（图标 / 状态点）固定占这么宽，后面的文字才能落在同一条左基准线上。 */
@Composable
private fun MetaLineSlot(content: @Composable () -> Unit) {
    Box(Modifier.size(MetaLineLeadingSlot), contentAlignment = Alignment.CenterStart) { content() }
}

@Composable
private fun RuntimeStatus(
    status: String,
    isChatSyncing: Boolean = false,
    modelLabel: String? = null,
    modifier: Modifier = Modifier,
) {
    Row(modifier, horizontalArrangement = Arrangement.spacedBy(5.dp), verticalAlignment = Alignment.CenterVertically) {
        RuntimeStatusIndicator(status)
        modelLabel?.takeIf(String::isNotBlank)?.let { label ->
            Text(
                "· $label",
                modifier = Modifier.weight(1f, fill = false),
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                style = MaterialTheme.typography.labelSmall,
                fontWeight = FontWeight.Medium,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
        if (isChatSyncing) {
            CircularProgressIndicator(
                modifier = Modifier.size(11.dp),
                strokeWidth = 1.5.dp,
                color = MaterialTheme.colorScheme.secondary,
            )
        }
    }
}

@Composable
private fun RuntimeStatusIndicator(status: String) {
    Row(horizontalArrangement = Arrangement.spacedBy(5.dp), verticalAlignment = Alignment.CenterVertically) {
        RuntimeStatusDot(status)
        Text(runtimeStatusText(status), color = runtimeStatusColor(status), style = MaterialTheme.typography.labelSmall)
    }
}

@Composable
private fun RuntimeStatusDot(status: String) {
    Box(Modifier.size(6.dp).clip(CircleShape).background(runtimeStatusColor(status)))
}

@Composable
private fun runtimeStatusColor(status: String): Color = when (status) {
    "idle" -> MaterialTheme.colorScheme.tertiary
    "running" -> MaterialTheme.colorScheme.primary
    "waiting_local_interaction" -> MaterialTheme.colorScheme.secondary
    else -> MaterialTheme.colorScheme.error
}

/** User messages share the soft base; right alignment and the author label establish identity. */
@Composable
internal fun UserMessageCard(
    runtimeId: String,
    message: ChatMessage,
    downloads: Map<String, ArtifactDownload>,
    downloadArtifact: (RemoteArtifact) -> Unit,
    downloadFile: (String) -> Unit,
) {
    Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.End) {
        NeumorphSurface(Modifier.fillMaxWidth(0.9f), style = NeumorphStyle.Pressed, shadowScale = 0.55f) {
            Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(if (message.isError == true) "你 · 发送异常" else "你", style = MaterialTheme.typography.labelSmall,
                    color = if (message.isError == true) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.primary)
                MessageBlocks(
                    runtimeId = runtimeId,
                    message = message,
                    downloads = downloads,
                    downloadArtifact = downloadArtifact,
                    downloadFile = downloadFile,
                )
            }
        }
    }
}

/** One softly raised panel per assistant turn; text and nested Markdown stay on a quiet reading surface. */
@Composable
internal fun AssistantTurnCard(
    runtimeId: String,
    messages: List<ChatMessage>,
    turnTiming: TurnTiming?,
    nowMs: Long,
    toolActivities: Map<String, ToolActivity>,
    toolResults: Map<String, ChatMessage>,
    downloads: Map<String, ArtifactDownload>,
    downloadArtifact: (RemoteArtifact) -> Unit,
    downloadFile: (String) -> Unit,
) {
    NeumorphSurface(Modifier.fillMaxWidth(), shadowScale = 0.55f) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.SpaceBetween) {
                AgentLabel(LocalAgentBrand.current)
                turnTiming?.let { TurnStartLabel(it.startedAt) }
            }
            messages.forEach { message ->
                AssistantTurnMessage(
                    runtimeId = runtimeId,
                    message = message,
                    toolActivities = toolActivities,
                    toolResults = toolResults,
                    downloads = downloads,
                    downloadArtifact = downloadArtifact,
                    downloadFile = downloadFile,
                )
            }
            turnTiming?.let { TurnDurationLabel(it, nowMs) }
        }
    }
}

/** 轮次里的单条消息：正常内容直接平铺；出错的包一层错误染色面。 */
@Composable
private fun AssistantTurnMessage(
    runtimeId: String,
    message: ChatMessage,
    toolActivities: Map<String, ToolActivity>,
    toolResults: Map<String, ChatMessage>,
    downloads: Map<String, ArtifactDownload>,
    downloadArtifact: (RemoteArtifact) -> Unit,
    downloadFile: (String) -> Unit,
) {
    if (message.isError == true) {
        NeumorphSurface(
            style = NeumorphStyle.Pressed,
            shape = RemoteUi.ControlShape,
            modifier = Modifier.fillMaxWidth(),
        ) {
            Column(
                Modifier.padding(horizontal = 11.dp, vertical = 9.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Text("回复异常", color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.labelMedium)
                MessageBlocks(runtimeId, message, toolActivities, toolResults, downloads, downloadArtifact, downloadFile)
            }
        }
    } else {
        MessageBlocks(runtimeId, message, toolActivities, toolResults, downloads, downloadArtifact, downloadFile)
    }
}

/** 一条消息的内容块：artifact 卡片 / 正文 / 思考 / 工具调用。 */
@Composable
private fun MessageBlocks(
    runtimeId: String,
    message: ChatMessage,
    toolActivities: Map<String, ToolActivity> = emptyMap(),
    toolResults: Map<String, ChatMessage> = emptyMap(),
    downloads: Map<String, ArtifactDownload>,
    downloadArtifact: (RemoteArtifact) -> Unit,
    downloadFile: (String) -> Unit,
) {
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        message.content.forEach { block ->
            if (block.type == "artifact" && block.artifact != null) {
                ArtifactCard(
                    artifact = block.artifact,
                    download = downloads.values.firstOrNull {
                        it.runtimeId == runtimeId && it.sourceArtifactId == block.artifact.artifactId
                    },
                    onDownload = { downloadArtifact(block.artifact) },
                )
            } else when (contentPresentation(message.role, block.type)) {
                ContentPresentation.MESSAGE -> MarkdownText(block.text.orEmpty(), downloadFile)
                ContentPresentation.THINKING -> CollapsedThinking(block.text.orEmpty())
                ContentPresentation.TOOL -> {
                    val toolId = block.toolCallId
                    val activity = toolId?.let { toolActivities[it] }
                    val result = toolId?.let { toolResults[it] }
                    // A live streamed tool call has no id/arguments yet: its raw argument fragments
                    // are accumulated in `text` and only the finalized message carries the real
                    // tool_call metadata.
                    val live = toolId == null && block.arguments == null && !block.text.isNullOrBlank()
                    CollapsedTool(
                        toolName = block.toolName ?: activity?.toolName ?: message.toolName ?: "工具",
                        arguments = block.arguments?.toString() ?: block.text,
                        activity = activity,
                        result = result,
                        live = live,
                    )
                }
            }
        }
    }
}

@Composable
private fun ArtifactCard(
    artifact: RemoteArtifact,
    download: ArtifactDownload?,
    onDownload: () -> Unit,
) {
    val isDownloading = download?.status == "downloading" || download?.status == "queued"
    val status = when (download?.status) {
        "queued" -> "正在请求文件"
        "downloading" -> "正在下载 ${formatByteCount(download.receivedBytes)}/${formatByteCount(artifact.size)}"
        "completed" -> "已保存到手机"
        "failed" -> download.error ?: "下载失败"
        "paused" -> "已暂停，可在下载页面继续"
        else -> "点击下载"
    }
    NeumorphSurface(
        onClick = onDownload,
        enabled = !isDownloading,
        shape = RemoteUi.ControlShape,
        modifier = Modifier.fillMaxWidth(),
    ) {
        Row(
            Modifier.padding(16.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Icon(Icons.Rounded.Download, contentDescription = "下载文件", tint = MaterialTheme.colorScheme.primary)
            Column(Modifier.weight(1f)) {
                Text(artifact.fileName, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text(
                    "${formatByteCount(artifact.size)} · $status",
                    style = MaterialTheme.typography.bodySmall,
                    color = if (download?.status == "failed") MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            if (isDownloading) CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp)
        }
    }
}

private fun formatByteCount(bytes: Long): String = when {
    bytes >= 1024 * 1024 -> "%.1f MB".format(bytes / (1024.0 * 1024.0))
    bytes >= 1024 -> "%.1f KB".format(bytes / 1024.0)
    else -> "$bytes B"
}

@Composable
private fun CollapsedThinking(text: String) {
    var expanded by remember(text) { mutableStateOf(false) }
    CompactDisclosure(
        icon = Icons.Rounded.Psychology,
        title = "思考",
        summary = if (expanded) text else "${text.lineSequence().count()} 行",
        expanded = expanded,
        onClick = { expanded = !expanded },
        tint = MaterialTheme.colorScheme.secondary,
    )
}

@Composable
private fun CollapsedTool(
    toolName: String,
    arguments: String?,
    activity: ToolActivity?,
    result: ChatMessage?,
    live: Boolean = false,
) {
    var expanded by remember(toolName, arguments, result?.messageId) { mutableStateOf(false) }
    val resultText = result?.content.orEmpty().mapNotNull { it.text }.joinToString("\n").trim()
    val detail = resultText.ifBlank { activity?.detail }
    val failed = activity?.isError == true || result?.isError == true
    val status = when {
        failed -> "执行失败"
        live -> "参数接收中"
        else -> activity?.let { toolStateText(it.state) } ?: "已完成"
    }
    CompactDisclosure(
        icon = Icons.Rounded.Build,
        title = toolName,
        summary = if (expanded) listOfNotNull(arguments, detail).joinToString("\n") else "$status${detail?.let { " · ${compactActivitySummary(it)}" }.orEmpty()}",
        expanded = expanded,
        onClick = { expanded = !expanded },
        tint = if (failed) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.primary,
    )
}

@Composable
private fun CompactDisclosure(
    icon: ImageVector,
    title: String,
    summary: String,
    expanded: Boolean,
    onClick: () -> Unit,
    tint: Color,
) {
    NeumorphSurface(
        onClick = onClick,
        style = NeumorphStyle.Pressed,
        shape = RemoteUi.ControlShape,
        shadowScale = 0.5f,
        modifier = Modifier.fillMaxWidth(),
    ) {
        Row(Modifier.heightIn(min = 56.dp).padding(12.dp), verticalAlignment = Alignment.Top, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Icon(icon, contentDescription = null, tint = tint, modifier = Modifier.size(17.dp))
            Column(Modifier.weight(1f)) {
                Text(title, style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.SemiBold)
                Text(
                    summary,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = if (expanded) Int.MAX_VALUE else 1,
                    overflow = if (expanded) TextOverflow.Clip else TextOverflow.Ellipsis,
                    fontFamily = if (expanded) FontFamily.Monospace else FontFamily.Default,
                )
            }
            Icon(
                if (expanded) Icons.Rounded.ExpandLess else Icons.Rounded.ExpandMore,
                contentDescription = if (expanded) "收起" else "展开",
                tint = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.size(18.dp),
            )
        }
    }
}

@Composable
private fun ToolCard(tool: ToolActivity) {
    // S6：工具输出 = 真凹陷（inset 面 + 内阴影），不用默认容器色（未归入蓝灰家族会发灰紫）。
    NeumorphSurface(
        modifier = Modifier.fillMaxWidth(),
        shape = RemoteUi.ControlShape,
        style = NeumorphStyle.Pressed,
    ) {
        Column(Modifier.padding(12.dp)) {
            Text("${tool.toolName} • ${toolStateText(tool.state)}", style = MaterialTheme.typography.titleSmall)
            tool.detail?.let { Text(it.take(2_000), fontFamily = FontFamily.Monospace) }
            if (tool.isError) Text("工具执行失败", color = MaterialTheme.colorScheme.error)
        }
    }
}

@Composable
private fun PendingMessagesPanel(
    messages: List<QueuedMessage>,
) {
    if (messages.isEmpty()) return
    // S6：附属物用真凹陷面（inset 面 + 内阴影）；半透明叠加的色随底板漂移，和其他凹陷面对不上。
    NeumorphSurface(
        modifier = Modifier.fillMaxWidth().padding(horizontal = RemoteUi.PagePadding, vertical = 8.dp),
        shape = RemoteUi.ControlShape,
        style = NeumorphStyle.Pressed,
    ) {
        Column(Modifier.fillMaxWidth().padding(top = 8.dp)) {
            Text(
                "排队消息",
                style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(horizontal = 12.dp, vertical = 2.dp),
            )
            LazyColumn(
                modifier = Modifier.fillMaxWidth().heightIn(max = 168.dp),
                contentPadding = PaddingValues(bottom = 6.dp),
            ) {
                items(messages, key = { "queued:${it.queueId}" }) { message ->
                    QueuedMessageRow(message)
                }
            }
        }
    }
}

@Composable
private fun QueuedMessageRow(message: QueuedMessage) {
    Row(
        Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Column(Modifier.weight(1f)) {
            Text(message.text, maxLines = 3, overflow = TextOverflow.Ellipsis)
            Text(
                "${queuedMessageDeliveryText(message.delivery)} · ${queuedMessageStateText(message.state)}${message.error?.let { "：$it" }.orEmpty()}",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

private fun queuedMessageDeliveryText(delivery: String): String = when (delivery) {
    "followUp" -> "Follow-up"
    "steer" -> "Steer"
    else -> delivery
}

private fun queuedMessageStateText(state: String): String = when (state) {
    "accepted" -> "已排队"
    "delivered" -> "已送入上下文"
    "cancelled" -> "已取消"
    "rejected" -> "已拒绝"
    "not_cancelable" -> "不可取消"
    else -> state
}

@Composable
private fun WarningCard(text: String) = FeedbackCard(text, isError = true)

@Composable
private fun NoticeCard(text: String) = FeedbackCard(text, isError = false)

@Composable
private fun FeedbackCard(text: String, isError: Boolean) {
    NeumorphSurface(Modifier.fillMaxWidth(), style = NeumorphStyle.Pressed, shadowScale = 0.5f) {
        Row(Modifier.padding(14.dp), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            Icon(if (isError) Icons.Rounded.ErrorOutline else Icons.Rounded.Info, contentDescription = null,
                tint = if (isError) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.primary, modifier = Modifier.size(20.dp))
            Text(text, style = MaterialTheme.typography.bodyMedium)
        }
    }
}

@Composable
internal fun InteractionPanel(
    request: PendingInteraction,
    submitting: Boolean,
    respondConfirm: (Boolean) -> Unit,
    respondValue: (String) -> Unit,
    respondValues: (List<String>) -> Unit,
    modifier: Modifier = Modifier.fillMaxWidth().height(360.dp),
    connected: Boolean = true,
    error: String? = null,
    draftState: InteractionDraft? = null,
    onCancel: (() -> Unit)? = null,
) {
    val localDraft = remember(request.requestId) { InteractionDraft(InteractionDraftValue(input = request.initialValue.orEmpty())) }
    val form = draftState ?: localDraft
    val input = form.value.input
    val selected = form.value.values
    var nowMs by remember(request.requestId) { mutableStateOf(System.currentTimeMillis()) }
    LaunchedEffect(request.requestId, request.expiresAt) {
        if (interactionHasDeadline(request)) {
            while (!isInteractionExpired(request, nowMs)) {
                delay(1_000)
                nowMs = System.currentTimeMillis()
            }
        }
    }
    val expired = isInteractionExpired(request, nowMs)
    val responseEnabled = connected && !expired && !submitting && !request.submitted
    val uriHandler = androidx.compose.ui.platform.LocalUriHandler.current
    val clipboard = androidx.compose.ui.platform.LocalClipboardManager.current
    var fullPreview by remember(request.requestId) { mutableStateOf(false) }
    var linkError by remember(request.requestId) { mutableStateOf<String?>(null) }
    val knownKind = request.kind == "confirm" || request.kind == "select" || request.kind == "multi-select" || request.kind == "input"

    Column(
        modifier = modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 8.dp),
    ) {
        NeumorphSurface(modifier = Modifier.fillMaxSize(), shape = RemoteUi.CardShape) {
            Column(Modifier.fillMaxSize().padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text(request.title, style = MaterialTheme.typography.titleMedium)
                    }
                    request.toolName?.let { tool ->
                        Text(tool, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.primary, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                }
                Column(
                    Modifier
                        .weight(1f)
                        .fillMaxWidth()
                        .heightIn(min = 0.dp)
                        .verticalScroll(rememberScrollState())
                        .padding(4.dp),
                    verticalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    request.argumentSummary?.let { summary ->
                        NeumorphSurface(style = NeumorphStyle.Pressed, shape = RemoteUi.ControlShape) {
                            SelectionContainer {
                                Text(summary, modifier = Modifier.fillMaxWidth().padding(10.dp), fontFamily = FontFamily.Monospace,
                                    maxLines = if (fullPreview) Int.MAX_VALUE else 8, overflow = TextOverflow.Ellipsis)
                            }
                        }
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            NeumorphTextButton(if (fullPreview) "收起内容" else "展开完整内容", onClick = { fullPreview = !fullPreview })
                            NeumorphTextButton("复制内容", onClick = { clipboard.setText(androidx.compose.ui.text.AnnotatedString(summary)) })
                        }
                    }
                    request.description?.let { SelectionContainer { Text(it) } }
                    request.externalUrl?.let { url ->
                        Text(url, style = MaterialTheme.typography.bodySmall)
                        NeumorphTextButton("打开网页", enabled = responseEnabled, onClick = {
                            runCatching { uriHandler.openUri(url) }.onFailure { linkError = "无法打开网页，请在电脑端完成操作。" }
                        })
                    }
                    linkError?.let { Text(it, color = MaterialTheme.colorScheme.error) }
                    if (interactionHasDeadline(request) && !expired) {
                        Text("剩余 ${interactionRemainingSeconds(request, nowMs)} 秒", color = MaterialTheme.colorScheme.secondary, style = MaterialTheme.typography.labelMedium)
                    }
                    if (expired) Text("此交互请求已超时", color = MaterialTheme.colorScheme.error)
                    if (!knownKind) WarningCard("手机无法安全渲染此交互，请在电脑端处理。")
                    when (request.kind) {
                        "select" -> request.options.forEach { option ->
                            NeumorphSurface(
                                onClick = { respondValue(option.value) },
                                enabled = responseEnabled,
                                shape = RemoteUi.ControlShape,
                                shadowScale = 0.5f,
                                modifier = Modifier.fillMaxWidth(),
                            ) {
                                Column(Modifier.fillMaxWidth().heightIn(min = RemoteUi.TouchTarget).padding(12.dp)) {
                                    Text(option.label)
                                    option.description?.let { Text(it, style = MaterialTheme.typography.bodySmall) }
                                }
                            }
                        }
                        "input" -> OutlinedTextField(
                            value = input,
                            onValueChange = { form.value = form.value.copy(input = it) },
                            modifier = Modifier.fillMaxWidth(),
                            label = { Text(request.placeholder ?: "输入内容") },
                            supportingText = { interactionInputConstraintText(request)?.let { Text(it) } },
                            isError = !isInteractionInputValid(input, request),
                            enabled = responseEnabled,
                            visualTransformation = if (request.secret) PasswordVisualTransformation() else VisualTransformation.None,
                            keyboardOptions = if (request.secret) KeyboardOptions(keyboardType = KeyboardType.Password) else KeyboardOptions.Default,
                        )
                        "multi-select" -> {
                            request.options.forEach { option ->
                                val checked = option.value in selected
                                val interaction = remember(option.value) { MutableInteractionSource() }
                                NeumorphSurface(
                                    modifier = Modifier.fillMaxWidth().toggleable(
                                        value = checked, enabled = responseEnabled, role = Role.Checkbox,
                                        interactionSource = interaction, indication = null,
                                    ) { checked -> form.value = form.value.copy(values = if (checked) selected + option.value else selected - option.value) },
                                    interactionSource = interaction,
                                    shape = RemoteUi.ControlShape,
                                    style = if (checked) NeumorphStyle.Pressed else NeumorphStyle.Raised,
                                    shadowScale = 0.45f,
                                ) {
                                    Row(Modifier.padding(8.dp), verticalAlignment = Alignment.CenterVertically) {
                                        NeumorphCheckbox(checked = checked, onCheckedChange = null, enabled = responseEnabled)
                                        Column(Modifier.weight(1f).padding(start = 8.dp)) {
                                            Text(option.label)
                                            option.description?.let { Text(it, style = MaterialTheme.typography.bodySmall) }
                                        }
                                    }
                                }
                            }
                            interactionMultiSelectConstraintText(request)?.let {
                                Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                            }
                        }
                    }
                }
                error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
                Text(
                    when {
                        request.submitted -> "已提交，等待电脑确认…"
                        submitting -> "正在发送，请稍候…"
                        expired -> "此交互请求已超时"
                        else -> "请在上方完成回答"
                    },
                    style = MaterialTheme.typography.bodySmall,
                    maxLines = 1,
                )
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    if (onCancel != null && request.kind != "confirm") {
                        NeumorphTextButton("取消请求", enabled = responseEnabled, onClick = onCancel)
                    }
                    if (request.kind == "confirm") {
                        NeumorphTextButton(
                            text = request.cancelLabel ?: "拒绝",
                            danger = true,
                            enabled = responseEnabled,
                            onClick = { respondConfirm(false) },
                        )
                    }
                    when (request.kind) {
                        "confirm" -> NeumorphTextButton(
                            text = request.confirmLabel ?: "允许",
                            modifier = Modifier.weight(1f),
                            filled = true,
                            enabled = responseEnabled,
                            onClick = { respondConfirm(true) },
                        )
                        "input" -> NeumorphTextButton(
                            text = "提交",
                            modifier = Modifier.weight(1f),
                            filled = true,
                            enabled = responseEnabled && isInteractionInputValid(input, request),
                            onClick = { respondValue(input) },
                        )
                        "multi-select" -> NeumorphTextButton(
                            text = "提交",
                            modifier = Modifier.weight(1f),
                            filled = true,
                            enabled = responseEnabled && isInteractionMultiSelectValid(selected.size, request),
                            onClick = { respondValues(selected.toList()) },
                        )
                    }
                }
            }
        }
    }
}

private fun runtimeStatusText(status: String): String = when (status) {
    "idle" -> "空闲"
    "running" -> "运行中"
    "waiting_local_interaction" -> "等待电脑端交互"
    else -> "未知状态"
}

private fun toolStateText(state: String): String = when (state) {
    "started" -> "已开始"
    "updated" -> "执行中"
    "finished" -> "已完成"
    else -> "状态未知"
}

/**
 * composer 上方的附件条：名字 + 进度 + 可单个删除。
 *
 * 传完之前不允许发送（见调用点），所以这里的状态直接就是「用户看到的传输进度」。
 */
@Composable
private fun AttachmentChips(uploads: List<UploadTask>, onRemove: (String) -> Unit) {
    Column(
        Modifier.fillMaxWidth().padding(horizontal = RemoteUi.PagePadding, vertical = 8.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        for (upload in uploads) {
            val failed = upload.status == "failed"
            val done = upload.status == "completed"
            Row(
                Modifier
                    .fillMaxWidth()
                    .clip(RemoteUi.ControlShape)
                    .background(rememberNeumorphColors().insetBase)
                    .neumorphInsetOverlay(RemoteUi.ControlShape)
                    .padding(horizontal = 12.dp, vertical = 8.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Icon(
                    Icons.Rounded.InsertDriveFile,
                    contentDescription = null,
                    modifier = Modifier.size(16.dp),
                    tint = when {
                        failed -> MaterialTheme.colorScheme.error
                        done -> MaterialTheme.colorScheme.tertiary
                        else -> MaterialTheme.colorScheme.primary
                    },
                )
                Column(Modifier.weight(1f)) {
                    Text(
                        upload.displayName,
                        style = MaterialTheme.typography.labelMedium,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                    Text(
                        uploadProgressText(upload),
                        style = MaterialTheme.typography.labelSmall,
                        color = if (failed) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
                NeumorphIconButton(
                    onClick = { onRemove(upload.taskId) },
                    icon = Icons.Rounded.Close,
                    contentDescription = "移除附件",
                    size = 40.dp,
                    tint = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }
}

/** 附件的进度文案。失败时优先说原因，因为那是用户唯一能采取行动的信息。 */
private fun uploadProgressText(upload: UploadTask): String {
    val total = upload.size
    val percent = if (total <= 0) 0 else ((upload.durableBytes * 100) / total).toInt().coerceIn(0, 100)
    return when (upload.status) {
        "completed" -> "已发送到电脑"
        "failed" -> upload.error ?: "发送失败"
        "paused" -> "已暂停，可重新发送（$percent%）"
        else -> "发送中 $percent%"
    }
}
