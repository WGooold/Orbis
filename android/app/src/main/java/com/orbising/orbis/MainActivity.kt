package com.orbising.orbis

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
import androidx.compose.animation.animateContentSize
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.Spring
import androidx.compose.animation.core.spring
import androidx.compose.animation.expandVertically
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.scaleIn
import androidx.compose.animation.scaleOut
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.slideOutHorizontally
import androidx.compose.animation.shrinkVertically
import androidx.compose.foundation.horizontalScroll
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
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.wrapContentHeight
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.Add
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.foundation.clickable
import androidx.compose.material.icons.rounded.Check
import androidx.compose.material.icons.rounded.Lock
import androidx.compose.material.icons.rounded.UnfoldMore
import androidx.compose.material.icons.rounded.LinkOff
import androidx.compose.material.icons.rounded.ArrowBack
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
import androidx.compose.material.icons.rounded.SkipPrevious
import androidx.compose.material.icons.rounded.Info
import androidx.compose.material.icons.rounded.KeyboardArrowDown
import androidx.compose.material.icons.rounded.Menu
import androidx.compose.material.icons.rounded.MoreVert
import androidx.compose.material.icons.rounded.Settings
import androidx.compose.material.icons.rounded.Psychology
import androidx.compose.material.icons.rounded.QrCodeScanner
import androidx.compose.material.icons.rounded.Refresh
import androidx.compose.material.icons.rounded.Send
import androidx.compose.material.icons.rounded.StopCircle
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsDraggedAsState
import androidx.compose.ui.platform.testTag
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.selection.toggleable
import androidx.compose.ui.semantics.Role
import com.orbising.orbis.NeumorphDialog as AlertDialog
import androidx.compose.material3.Badge
import androidx.compose.material3.CircularProgressIndicator
import com.orbising.orbis.NeumorphMenu as DropdownMenu
import com.orbising.orbis.NeumorphMenuItem as DropdownMenuItem
import androidx.compose.material3.DrawerValue
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.pulltorefresh.PullToRefreshDefaults
import androidx.compose.material3.pulltorefresh.PullToRefreshState
import androidx.compose.material3.pulltorefresh.pullToRefresh
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.material3.ModalNavigationDrawer
import com.orbising.orbis.NeumorphTextField as OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import com.orbising.orbis.OrbisActionIcon as Icon
import androidx.compose.material3.Text
import com.orbising.orbis.RemoteTopAppBar as TopAppBar
import androidx.compose.material3.rememberDrawerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.runtime.CompositionLocalProvider
import androidx.lifecycle.LifecycleEventObserver
import androidx.compose.runtime.key
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.snapshotFlow
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.saveable.rememberSaveableStateHolder
import androidx.compose.foundation.rememberScrollState
import androidx.compose.runtime.setValue
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.Alignment
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.foundation.layout.offset
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.input.nestedscroll.NestedScrollConnection
import androidx.compose.ui.input.nestedscroll.NestedScrollSource
import androidx.compose.ui.input.nestedscroll.nestedScroll
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.runtime.snapshots.Snapshot
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.boundsInWindow
import androidx.compose.ui.Modifier
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
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
import kotlin.math.roundToInt
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
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.JsonArray

class MainActivity : ComponentActivity() {
    override fun onResume() {
        super.onResume()
        AppLocalization.refreshSystemLanguage()
    }

    override fun onConfigurationChanged(newConfig: android.content.res.Configuration) {
        super.onConfigurationChanged(newConfig)
        AppLocalization.refreshSystemLanguage()
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        AppLocalization.configure(this)
        val appearancePreferences = getSharedPreferences("orbis-appearance", MODE_PRIVATE)
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 1)
        }
        setContent {
            var visualStyle by remember {
                mutableStateOf(OrbisVisualStyle.fromKey(appearancePreferences.getString("visualStyle", null)))
            }
            OrbisTheme(visualStyle = visualStyle, onVisualStyleChange = { choice ->
                visualStyle = choice
                appearancePreferences.edit().putString("visualStyle", choice.key).apply()
            }) {
                val model: RemoteViewModel = viewModel()
                val state by model.state.collectAsStateWithLifecycle()
                val hosts by model.hosts.collectAsStateWithLifecycle()
                val pairingError by model.pairingError.collectAsStateWithLifecycle()
                val pairingInProgress by model.pairingInProgress.collectAsStateWithLifecycle()
                var pendingToolExport by remember { mutableStateOf<ToolDetailView?>(null) }
                val toolExport = rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument("text/plain")) { uri ->
                    val detail = pendingToolExport
                    pendingToolExport = null
                    if (uri != null && detail != null) model.exportToolDetail(uri, detail)
                }
                CompositionLocalProvider(
                    androidx.compose.ui.platform.LocalLayoutDirection provides androidx.compose.ui.unit.LayoutDirection.Ltr,
                    LocalToolDetailAction provides { runtime, summary, part -> model.openToolDetail(runtime, summary, part) },
                    LocalToolContentAvailable provides (state.connection == RelayConnection.ONLINE),
                ) {
                    RemoteApp(state, hosts, pairingError, pairingInProgress, model)
                    state.changeViewer?.let { viewer ->
                        state.turnChanges[viewer.runtimeId]?.manifests?.get(viewer.summary.versionKey)?.let { manifest ->
                            key(viewer.runtimeId, viewer.summary.versionKey) { FileChangeViewerSheet(viewer, manifest,
                                onClose = { model.closeChangeViewer() }, onSelectFile = { model.selectChangeFile(it) },
                                onReadDetail = { model.readChangeDetail() }, onReadManifest = { model.readChangeManifest(viewer.runtimeId, viewer.summary) },
                                onPosition = { file, index, offset -> model.rememberChangePosition(file, index, offset) }) }
                        }
                    }
                    state.toolDetail?.let { detail -> ToolDetailDialog(detail, model) {
                        pendingToolExport = detail
                        model.closeToolDetail()
                        toolExport.launch("tool-${detail.part}.txt")
                    } }
                }
            }
        }
    }
}

private val LocalToolDetailAction = staticCompositionLocalOf<(String, ToolSummary, String) -> Unit> { { _, _, _ -> } }
private val LocalToolContentAvailable = staticCompositionLocalOf { false }

@Composable
private fun ToolDetailDialog(detail: ToolDetailView, model: RemoteViewModel, onExport: () -> Unit) {
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    DisposableEffect(lifecycle, detail.viewerId) {
        val observer = LifecycleEventObserver { _, event -> if (event == Lifecycle.Event.ON_STOP) model.closeAllToolDetails() }
        lifecycle.addObserver(observer)
        onDispose { lifecycle.removeObserver(observer) }
    }
    LaunchedEffect(detail.viewerId, detail.follow, detail.requestId, detail.offset, detail.error) {
        if (detail.follow && detail.requestId == null && detail.error == null && (!detail.contentFinal || detail.nextCursor != null)) {
            delay(if (detail.nextCursor == null) 750 else 50)
            model.readToolDetail()
        }
    }
    ToolDetailSheet(
        detail = detail,
        onClose = { model.closeToolDetail() },
        onReadNext = { model.readToolDetail() },
        onRetry = { if (detail.nextCursor != null) model.readToolDetail() else model.changeToolPart(detail.part) },
        onClear = { model.readToolDetail(clear = true) },
        onFollow = { if (it) model.readToolDetail(follow = true) else model.stopToolFollow() },
        onExport = onExport,
    )
}

@Composable
internal fun RemoteApp(
    state: RemoteState,
    hosts: List<HostSnapshot>,
    pairingError: String?,
    pairingInProgress: Boolean,
    model: RemoteViewModel,
) {
    val actionHaptic = rememberActionHaptic()
    val modelLifecycle = LocalLifecycleOwner.current
    LaunchedEffect(model, modelLifecycle) {
        modelLifecycle.lifecycle.repeatOnLifecycle(Lifecycle.State.RESUMED) {
            model.reconcileModels()
            while (isActive) {
                delay(15_000)
                model.reconcileModels()
            }
        }
    }
    val appearsPaired = hosts.isNotEmpty() || state.deviceId != null || state.connection != RelayConnection.OFFLINE
    // 添加电脑：已经配对过也能再扫一台；取消只是回主界面，不动已有连接。
    var addingHost by rememberSaveable { mutableStateOf(false) }
    var allDownloadsOpen by rememberSaveable { mutableStateOf(false) }
    var statusOpen by rememberSaveable { mutableStateOf(false) }
    // 新建会话面板：newSessionOpen 管可见性，newSessionCwd 只在「目录捷径」模式下带预设目录。
    // 两者必须分开——抽屉头的「新会话」按钮带上来的 cwd 就是 null（它意在让你先浏览目录），
    // 若拿 cwd != null 当可见性判据，面板永远不会出现（抽屉收回、什么也没发生）。
    var newSessionOpen by rememberSaveable { mutableStateOf(false) }
    var newSessionCwd by rememberSaveable { mutableStateOf<String?>(null) }
    var launchIntro by remember(state.hostId) { mutableStateOf<LaunchState?>(null) }
    var newSessionHostId by rememberSaveable { mutableStateOf<String?>(null) }
    LaunchedEffect(state.hostId) {
        if (newSessionOpen && state.hostId != newSessionHostId) {
            newSessionOpen = false
            newSessionCwd = null
            model.dismissBrowse()
        }
    }
    fun cancelLaunchIntro() {
        if (launchIntro == null) return
        launchIntro = null
        // Stop navigation ownership, not the already-dispatched launch request.
        model.selectRuntime(null)
    }
    // Keep the directory page's drawer, filters, expansion and scroll position across navigation.
    val runtimeListStateHolder = rememberSaveableStateHolder()
    // 会话列表既是默认页，也是聊天页右滑返回时露出的底层页面，因此抽成一处复用。
    val runtimeList: @Composable () -> Unit = {
        runtimeListStateHolder.SaveableStateProvider("runtime-list") {
            RuntimeListScreen(
                launchIntro = launchIntro,
                onLaunchPresented = { requestId -> if (launchIntro?.requestId == requestId) launchIntro = null },
                onDirectoryOpened = { cancelLaunchIntro() },
                state = state,
                hosts = hosts,
                onOpenRuntime = { hostId, runtimeId ->
                    cancelLaunchIntro()
                    allDownloadsOpen = false
                    model.openRuntime(hostId, runtimeId)
                },
                onCloseRuntimes = model::closeRuntimesOn,
                onOpenDownloads = { cancelLaunchIntro(); allDownloadsOpen = true },
                onUnpairHost = { hostId -> model.unpair(hostId) },
                onOpenSession = { hostId, sessionId ->
                    cancelLaunchIntro()
                    allDownloadsOpen = false
                    model.openSession(hostId, sessionId)
                },
                onOpenHistory = { hostId, sessionId ->
                    cancelLaunchIntro()
                    allDownloadsOpen = false
                    model.openOfflineSession(hostId, sessionId)
                },
                onNewSession = { hostId, cwd ->
                    cancelLaunchIntro()
                    model.selectHost(hostId)
                    newSessionHostId = hostId
                    newSessionCwd = cwd
                    newSessionOpen = true
                },
                onSetArchived = { hostId, sessionId, archived ->
                    model.setSessionArchivedOn(hostId, sessionId, archived)
                },
                onSelectHost = { hostId -> cancelLaunchIntro(); model.selectHost(hostId) },
                onAddHost = { cancelLaunchIntro(); addingHost = true },
                onRequestProviders = model::refreshProviderFacts,
                onOpenStatus = { cancelLaunchIntro(); statusOpen = true },
                onRetryHome = model::refreshHome,
            )
        }
    }
    val context = androidx.compose.ui.platform.LocalContext.current
    // session.activated（spec §8）：只证明进程已拉起；会话真正上线后 runtime.online 会接管 UI。
    LaunchedEffect(state.sessionActivation) {
        state.sessionActivation?.let { activation ->
            val kind = agentBrand(activation.agentKind).title
            // 桌面版的“无头”是相对终端说的：它本来就有窗口（桌面版 GUI 就是那个窗口）。
            // 对它说“电脑上无窗口”会把人叫去开一个终端，而那正是它不该做的事。
            val suffix = if (activation.spawnMode == "headless" && activation.agentKind != "codexDesktop") L10n.tr("，此会话无头（电脑上无窗口）") else ""
            Toast.makeText(context, L10n.tr("已在电脑上拉起 {0} 进程{1}，等待会话上线…", kind, suffix), Toast.LENGTH_LONG).show()
            model.clearActivationNotice()
        }
    }
    when {
        !appearsPaired -> PairingScreen(
            error = pairingError ?: state.error,
            pairingInProgress = pairingInProgress,
            pair = { relayUrl, code, qrRaw ->
                model.pair(relayUrl, code, qrRaw) { addingHost = false }
            },
            clearError = { model.clearPairingError(); model.clearError() },
            onCancel = if (hosts.isNotEmpty()) {
                { addingHost = false; model.clearPairingError() }
            } else null,
        )
        else -> {
            // 所有首页下一级整页共用导航容器；根配对和 sheet 保持独立的呈现方式（M14）。
            // 首页始终留在同一个组合位置，返回后立即可点。
            val page = when {
                launchIntro != null -> null
                addingHost -> HomeOverlay.Pairing
                state.selectedRuntimeId == null && state.selectedOfflineSessionId != null -> HomeOverlay.OfflineHistory
                state.selectedRuntimeId != null -> HomeOverlay.Chat
                statusOpen -> HomeOverlay.Settings
                allDownloadsOpen -> HomeOverlay.Downloads
                else -> null
            }
            OrbisPageHost(
                onBack = {
                    when (page) {
                        HomeOverlay.Pairing -> { addingHost = false; model.clearPairingError() }
                        HomeOverlay.OfflineHistory -> model.selectOfflineSession(null)
                        HomeOverlay.Chat -> model.selectRuntime(null)
                        HomeOverlay.Settings -> statusOpen = false
                        HomeOverlay.Downloads -> allDownloadsOpen = false
                        null -> Unit
                    }
                },
                underlay = runtimeList,
                open = page != null,
                contentKey = page,
                canNavigateBack = page != HomeOverlay.Pairing || !pairingInProgress,
            ) {
                when (page) {
                    HomeOverlay.Pairing -> PairingScreen(
                        error = pairingError ?: state.error, pairingInProgress = pairingInProgress,
                        pair = { relayUrl, code, qrRaw -> model.pair(relayUrl, code, qrRaw) { addingHost = false } },
                        clearError = { model.clearPairingError(); model.clearError() },
                        onCancel = { addingHost = false; model.clearPairingError() },
                    )
                    HomeOverlay.OfflineHistory -> AgentTheme(agentBrand(state.sessions[state.selectedOfflineSessionId]?.agentKind)) {
                        OfflineHistoryScreen(state, state.selectedOfflineSessionId, model, onBack = { model.selectOfflineSession(null) })
                    }
                    HomeOverlay.Chat -> AgentTheme(agentBrand(state.runtimes[state.selectedRuntimeId]?.agentKind ?: state.launchPage?.agentKind ?:
                        state.knownRuntimeSessions[state.selectedRuntimeId]?.let(state.sessions::get)?.agentKind)) {
                        ChatScreen(state, model)
                    }
                    HomeOverlay.Settings -> StatusScreen(
                        state = state,
                        model = model,
                        pairing = model.pairingStatus(),
                        onBack = { statusOpen = false },
                    )
                    HomeOverlay.Downloads -> HostDownloadsScreen(state, model, onBack = { allDownloadsOpen = false })
                    null -> Unit
                }
            }
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
                if (model.createSession(agentKind, cwd, newSessionHostId)) {
                    launchIntro = model.currentLaunchPresentation()
                    actionHaptic()
                }
            },
        )
    }
    // 共享错误通道按"要不要用户在电脑端动手"分两层显示，**任何一条都不再弹模态确认框**。
    //
    // 之前这里是 AlertDialog：一句重连抖动写进来的噪音就要求点「确定」，而 `error` 有十几个
    // 写入方，重复文案会把界面钉成点不完的弹窗。模态框只留给真正的选择（配对、删除、权限）。
    state.error?.takeIf { appearsPaired }?.let { error ->
        ErrorBanner(
            message = error,
            needsAction = state.errorNeedsAction,
            onDismiss = model::clearError,
        )
    }
}

/** Pages that slide in over the home list. */
private enum class HomeOverlay { Chat, Settings, Downloads, Pairing, OfflineHistory }

/** The computer's downloads page; the home, chat and history entries all open this same page. */
@Composable
private fun HostDownloadsScreen(state: RemoteState, model: RemoteViewModel, onBack: () -> Unit) {
    AllDownloadsScreen(
        state = state,
        onBack = onBack,
        onBrowse = model::browseSessions,
        onBrowseInto = model::browseInto,
        onBrowseUp = model::browseUp,
        onDismissBrowse = model::dismissBrowse,
        onDownload = { path -> model.downloadFile(path) },
        onRetry = { taskId -> model.retryDownload(taskId) },
        onCancel = model::cancelDownload,
        onDelete = model::deleteDownloads,
    )
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun PairingScreen(
    error: String?,
    pairingInProgress: Boolean,
    pair: (String, String, String?) -> Unit,
    clearError: () -> Unit,
    onCancel: (() -> Unit)? = null,
) {
    var scannerOpen by remember { mutableStateOf(false) }
    var scanError by remember { mutableStateOf<String?>(null) }
    Scaffold(
        containerColor = MaterialTheme.colorScheme.background,
        topBar = {
            TopAppBar(
                title = { Text("Orbis", fontWeight = FontWeight.SemiBold) },
                navigationIcon = {
                    if (onCancel != null && !pairingInProgress) {
                        NeumorphIconButton(
                            onClick = onCancel,
                            icon = Icons.Rounded.Close,
                            contentDescription = L10n.tr("取消添加电脑"),
                        )
                    }
                },
            )
        },
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
            Text(L10n.tr("连接你的电脑"), style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.SemiBold)
            Spacer(Modifier.height(24.dp))
            NeumorphActionButton(
                onClick = {
                    scanError = null
                    scannerOpen = true
                },
                text = if (pairingInProgress) L10n.tr("正在连接…") else L10n.tr("扫码配对"),
                icon = Icons.Rounded.QrCodeScanner,
                modifier = Modifier.fillMaxWidth(),
                enabled = !pairingInProgress,
            )
            Box(Modifier.fillMaxWidth().height(56.dp), contentAlignment = Alignment.Center) {
                if (pairingInProgress) CircularProgressIndicator(Modifier.size(24.dp))
                else Text(error ?: scanError.orEmpty(), color = MaterialTheme.colorScheme.error,
                    style = MaterialTheme.typography.bodySmall, maxLines = 2, overflow = TextOverflow.Ellipsis)
            }
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
                        scanError = L10n.tr("二维码无效或不是 Orbis 配对二维码")
                    } else {
                        scanError = L10n.tr("这是旧版二维码（无端到端加密材料）：请在电脑上重新执行 orbis pair")
                    }
                } else {
                    scanError = null
                    clearError()
                    pair(v2.relayUrl, v2.code, raw)
                }
                scannerOpen = false
            },
            onDismiss = { scannerOpen = false },
        )
    }
}

@OptIn(ExperimentalMaterial3Api::class)
private class HomePullRefreshState : PullToRefreshState {
    private val distance = Animatable(0f)

    override val distanceFraction: Float
        get() = distance.value

    override val isAnimating: Boolean
        get() = distance.isRunning

    override suspend fun animateToThreshold() {
        distance.animateTo(
            targetValue = 1f,
            animationSpec = spring(dampingRatio = 0.9f, stiffness = 520f),
        )
    }

    override suspend fun animateToHidden() {
        distance.animateTo(
            targetValue = 0f,
            animationSpec = spring(dampingRatio = 0.9f, stiffness = 420f),
        )
    }

    override suspend fun snapTo(targetValue: Float) {
        distance.snapTo(targetValue)
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun RuntimeListScreen(
    state: RemoteState,
    hosts: List<HostSnapshot>,
    onOpenRuntime: (String, String) -> Unit,
    onCloseRuntimes: (String, Set<String>) -> Set<String>,
    onOpenDownloads: () -> Unit,
    onUnpairHost: (String) -> Unit,
    onOpenSession: (String, String) -> Unit,
    onOpenHistory: (String, String) -> Unit,
    onNewSession: (String, String?) -> Unit,
    onSetArchived: (String, String, Boolean) -> Unit,
    onSelectHost: (String) -> Unit,
    onAddHost: () -> Unit,
    onOpenStatus: () -> Unit,
    onRequestProviders: () -> Unit,
    onRetryHome: () -> Unit = {},
    launchIntro: LaunchState? = null,
    onLaunchPresented: (String) -> Unit = {},
    onDirectoryOpened: () -> Unit = {},
) {
    val homeListState = rememberLazyListState()
    LaunchedEffect(launchIntro?.requestId) {
        if (launchIntro != null) {
            androidx.compose.runtime.withFrameNanos { }
            homeListState.scrollToItem((homeListState.layoutInfo.totalItemsCount - 1).coerceAtLeast(0))
        }
    }
    val pullRefreshState = remember { HomePullRefreshState() }
    var pullRefreshing by remember { mutableStateOf(false) }
    val drawerState = rememberDrawerState(DrawerValue.Closed)
    LaunchedEffect(drawerState.targetValue) {
        if (drawerState.targetValue == DrawerValue.Open) onDirectoryOpened()
    }
    val scope = rememberCoroutineScope()
    val activeHostId = state.hostId
    val haptic = LocalHapticFeedback.current
    var selectedRuntimeIds by remember(activeHostId) { mutableStateOf(emptySet<String>()) }
    // 主页只列当前电脑的会话：多台电脑不混在一张列表里，切换入口就在下面的电脑行（ADR-0030 修订）。
    val latestRuntimes = remember(hosts, activeHostId) {
        hosts.filter { it.hostId == activeHostId }.flatMap { snapshot ->
            // ADR-0049 §5：已提交关闭的会话先离开首页；电脑拒绝或超时时再回来。
            snapshot.state.homeCards
                .map { HostRuntimeRow(snapshot.hostId, snapshot.name, it, snapshot.state) }
        }
    }
    var departing by remember(activeHostId) { mutableStateOf(emptyMap<String, DepartingHomeRow>()) }
    fun submitClose(hostId: String, ids: Set<String>): Set<String> {
        val submitted = onCloseRuntimes(hostId, ids)
        departing = departing + latestRuntimes.mapIndexedNotNull { index, row ->
            if (row.runtime.runtimeId in submitted) row.runtime.runtimeId to DepartingHomeRow(row, index) else null
        }
        return submitted
    }
    val presentedRuntimes = remember(latestRuntimes, departing) {
        latestRuntimes.toMutableList().also { rows ->
            departing.values.sortedBy { it.index }.forEach { exit ->
                if (rows.none { it.runtime.runtimeId == exit.row.runtime.runtimeId }) rows.add(exit.index.coerceAtMost(rows.size), exit.row)
            }
        }
    }
    val latestHomeRows by rememberUpdatedState(latestRuntimes)
    val visibleRuntimes = rememberViewportItems(presentedRuntimes, homeListState, activeHostId)
    val visibleIds = visibleRuntimes.map { it.runtime.runtimeId }.toSet()
    val closableIds = visibleRuntimes.filter { it.state.canCloseRuntime(it.runtime.runtimeId) }.map { it.runtime.runtimeId }.toSet()
    val selectedIds = selectedRuntimeIds.intersect(visibleIds).intersect(closableIds)
    val selecting = selectedIds.isNotEmpty()
    LaunchedEffect(visibleIds, closableIds) { selectedRuntimeIds = selectedRuntimeIds.intersect(visibleIds).intersect(closableIds) }
    fun toggleSelection(id: String) {
        if (id !in closableIds) return
        haptic.performHapticFeedback(HapticFeedbackType.TextHandleMove)
        selectedRuntimeIds = if (id in selectedIds) selectedIds - id else selectedIds + id
    }
    BackHandler(enabled = LocalPageActive.current && selecting && drawerState.isClosed) { selectedRuntimeIds = emptySet() }
    ModalNavigationDrawer(
        drawerState = drawerState,
        gesturesEnabled = !selecting,
        drawerContent = {
            SessionDrawer(
                state = state,
                hosts = hosts,
                isOpen = drawerState.isOpen,
                onSelectHost = onSelectHost,
                onUnpairHost = onUnpairHost,
                onAddHost = onAddHost,
                onSetArchived = onSetArchived,
                onRequestProviders = onRequestProviders,
                // 打开别的电脑的会话前先切过去：交互命令永远只发给当前电脑。
                onOpenSession = { hostId, sessionId ->
                    scope.launch { drawerState.close() }
                    onOpenSession(hostId, sessionId)
                },
                // History temporarily replaces this page; return to the still-open drawer.
                onOpenHistory = onOpenHistory,
                onNewSession = { hostId, cwd ->
                    scope.launch { drawerState.close() }
                    onNewSession(hostId, cwd)
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
                            onClick = { if (selecting) selectedRuntimeIds = emptySet() else scope.launch { drawerState.open() } },
                            icon = if (selecting) Icons.Rounded.Close else Icons.Rounded.Menu,
                            menuMorph = selecting,
                            contentDescription = if (selecting) L10n.tr("退出多选") else L10n.tr("打开会话目录"),
                            size = 40.dp,
                        )
                    },
                    title = {
                        if (selecting) {
                            MotionText(L10n.tr("已选择 {0} 项", selectedIds.size), style = MaterialTheme.typography.titleLarge)
                        } else Column {
                            OrbisWordmark()
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
                        SelectionToolbar(selecting = selecting, normal = { progress ->
                            DownloadStatusButton(
                                activeCount = state.downloads.count { it.value.status in setOf("queued", "downloading") },
                                enabled = true,
                                onClick = onOpenDownloads,
                                modifier = Modifier.graphicsLayer { translationX = 24.dp.toPx() * progress },
                            )
                            // 右上角只有下载与设置两个入口；添加 / 取消配对只在侧边栏底部的电脑菜单（ADR-0046 §5）。
                            NeumorphIconButton(
                                onClick = onOpenStatus,
                                icon = Icons.Rounded.Settings,
                                contentDescription = L10n.tr("设置"),
                                modifier = Modifier.testTag("home-settings").graphicsLayer { translationX = -24.dp.toPx() * progress },
                            )

                        }, selected = {
                            NeumorphTextButton(
                                text = L10n.tr("关闭"),
                                onClick = {
                                    activeHostId?.let { hostId ->
                                        val currentIds = visibleRuntimes.filter { it.state.homeCardIsCurrent(it.card) && it.state.canCloseRuntime(it.runtime.runtimeId) }
                                            .map { it.runtime.runtimeId }.toSet()
                                        selectedRuntimeIds = selectedIds - submitClose(hostId, selectedIds.intersect(currentIds))
                                    }
                                },
                                enabled = state.e2eReady,
                                danger = true,
                                modifier = Modifier.semantics { contentDescription = L10n.tr("关闭选中会话") },
                            )
                        })
                    },
                )
            },
        ) { padding ->
            Column(Modifier.fillMaxSize().padding(padding).padding(horizontal = RemoteUi.PagePadding)) {
                // 一行固定高度：这一页是哪台电脑、怎么连着，以及首版列表发布后是否仍在同步；
                // 多台电脑时电脑名就是切换入口。重试只在失败时加入这一行，不移动卡片。
                val backgroundSync = if (state.homeRuntimesLoading) HomeSyncStatus.Idle else state.homeSyncStatus
                Row(
                    Modifier.fillMaxWidth().height(56.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    // The switcher takes the free width (its content stays at the start), so the chip sits flush right.
                    HomeHostSwitcher(hosts, activeHostId, onSelectHost, Modifier.weight(1f))
                    // 胶囊只表达状态，不再是入口；读屏把它读成一段状态（ADR-0046 §5）。
                    Box(Modifier.testTag("home-connection-status").semantics(mergeDescendants = true) { }) {
                        ConnectionStatus(state.connection, state.e2eReady, state.path, backgroundSync)
                    }
                    if (backgroundSync is HomeSyncStatus.Failed) {
                        NeumorphIconButton(
                            onClick = onRetryHome,
                            icon = Icons.Rounded.Refresh,
                            contentDescription = if (state.e2eReady) L10n.tr("重新加载会话") else L10n.tr("重新连接"),
                            tint = MaterialTheme.colorScheme.error,
                            compact = true,
                            modifier = Modifier.semantics { stateDescription = backgroundSync.message },
                        )
                    }
                }
                // V21：会话增删与重排不能把视口挤走。在发布新列表的同一次组合里决定位置，
                // 让 LazyColumn 这一帧就按它测量，而不是先跟着首卡跳走再拉回来。
                val homeKeys = visibleRuntimes.map { "${it.hostId}:${it.runtime.runtimeId}" }
                maintainListViewport(homeListState, homeKeys, activeHostId)
                // M15：与 iOS 一样下拉刷新，逻辑同失败重试；进度仍由连接胶囊或列表空态表达，指示器松手即收起。
                Box(
                    Modifier.fillMaxWidth().weight(1f).testTag("home-pull-refresh")
                        .pullToRefresh(
                            // The modifier owns the gesture; the indicator's refreshing state is
                            // separate so it can keep spinning while our softer release spring runs.
                            isRefreshing = false,
                            state = pullRefreshState,
                            enabled = !selecting,
                            onRefresh = {
                                if (!pullRefreshing) {
                                    pullRefreshing = true
                                    onRetryHome()
                                    scope.launch {
                                        try {
                                            pullRefreshState.animateToHidden()
                                        } finally {
                                            pullRefreshing = false
                                        }
                                    }
                                }
                            },
                        ),
                ) {
                LazyColumn(
                    modifier = Modifier.fillMaxSize()
                        // M15：跟随 iOS 原生 refreshable 的回弹，将整张会话列表按同一刷新距离下移；
                        // 用图层位移保留 LazyList 测量尺寸、滚动锚点和卡片手势状态。
                        .graphicsLayer {
                            translationY = pullRefreshState.distanceFraction * PullToRefreshDefaults.PositionalThreshold.toPx()
                        }
                        .testTag("home-session-list"),
                    state = homeListState,
                    verticalArrangement = Arrangement.spacedBy(16.dp),
                    contentPadding = PaddingValues(top = 12.dp, bottom = 24.dp),
                ) {
                    // 首版完整快照发布前列表为空：加载与失败占据空态的位置，而不是压在卡片上方。
                    if (state.homeRuntimesLoading) {
                        item(key = "status") { HomeFirstLoadStatus(state.homeSyncStatus, state.e2eReady, onRetryHome) }
                    } else if (visibleRuntimes.isEmpty() && launchIntro == null) {
                        item(key = "empty") {
                            Column(Modifier.fillMaxWidth().heightIn(min = 180.dp).testTag("home-session-empty"),
                                verticalArrangement = Arrangement.Center, horizontalAlignment = Alignment.CenterHorizontally) {
                                Icon(Icons.Rounded.Computer, contentDescription = null, modifier = Modifier.size(44.dp),
                                    tint = MaterialTheme.colorScheme.onSurfaceVariant)
                                Spacer(Modifier.height(14.dp))
                                Text(L10n.tr("暂无在线会话"), style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
                            }
                        }
                    }
                        items(
                            visibleRuntimes,
                            key = { "${it.hostId}:${it.runtime.runtimeId}" },
                        ) { row ->
                            val runtime = row.runtime
                            val departure = departing[runtime.runtimeId]
                            val cardCurrent = departure == null && row.state.homeCardIsCurrent(row.card)
                            val canClose = cardCurrent && row.state.canCloseRuntime(runtime.runtimeId)
                            val currentCanClose by rememberUpdatedState(canClose)
                            val currentCardIsCurrent by rememberUpdatedState(cardCurrent)
                            var cardWidth by remember(row.hostId, runtime.runtimeId) { mutableFloatStateOf(0f) }
                            val closeThreshold = cardWidth / 2f
                            var swipeOffset by remember(row.hostId, runtime.runtimeId) { mutableFloatStateOf(0f) }
                            var closeArmed by remember(row.hostId, runtime.runtimeId) { mutableStateOf(false) }
                            val swipeScope = rememberCoroutineScope()
                            val swipeAnim = remember(row.hostId, runtime.runtimeId) { Animatable(0f) }
                            var touchPressed by remember { mutableStateOf(false) }
                            var opening by remember { mutableStateOf(false) }
                            val currentOpenRuntime by rememberUpdatedState(onOpenRuntime)
                            LaunchedEffect(departure?.token, cardWidth) {
                                if (departure != null && cardWidth > 0) {
                                    swipeAnim.animateTo(cardWidth + 40f, tween(InteractionMotion.duration(InteractionMotion.Dismiss)))
                                    if (departing[runtime.runtimeId]?.token == departure.token) {
                                        departing = departing - runtime.runtimeId
                                    }
                                } else if (departure == null && swipeAnim.value > 0f) {
                                    // Changing the departure key cancels the exit coroutine. Its
                                    // successor owns recovery when a rejection kept the live row.
                                    swipeOffset = 0f; closeArmed = false
                                    swipeAnim.animateTo(0f, OrbisMotion.drag())
                                }
                            }
                            LaunchedEffect(canClose) {
                                if (!canClose && departure == null) { swipeOffset = 0f; closeArmed = false; swipeAnim.snapTo(0f) }
                            }
                            LaunchedEffect(opening, selecting) {
                                if (opening) {
                                    if (!selecting && currentCardIsCurrent) {
                                        // A quick tap can press and release in one frame. Paint the
                                        // depressed card before navigation starts composing the chat.
                                        androidx.compose.runtime.withFrameNanos { }
                                        androidx.compose.runtime.withFrameNanos { }
                                        if (currentCardIsCurrent) currentOpenRuntime(row.hostId, runtime.runtimeId)
                                    }
                                    opening = false
                                }
                            }
                            Row(
                                modifier = Modifier.fillMaxWidth().then(if (departure != null) Modifier.clearAndSetSemantics { } else Modifier).animateItem(
                                    fadeOutSpec = tween(InteractionMotion.duration(InteractionMotion.State)),
                                    placementSpec = tween(InteractionMotion.duration(InteractionMotion.State))),
                                verticalAlignment = Alignment.CenterVertically,
                                horizontalArrangement = Arrangement.spacedBy(0.dp),
                            ) {
                                // Keep the card's outer shadows outside the swipe container.
                                Box(Modifier.weight(1f).onSizeChanged { cardWidth = it.width.toFloat() }) {
                                    if (!selecting) {
                                        val armedColor = MaterialTheme.colorScheme.onSurfaceVariant
                                        val closeColor by androidx.compose.animation.animateColorAsState(
                                            if (closeArmed || departure != null) armedColor else MaterialTheme.colorScheme.error,
                                            tween(InteractionMotion.duration(InteractionMotion.State)), label = "close-threshold")
                                        Row(
                                            Modifier.matchParentSize().background(
                                                closeColor,
                                                RoundedCornerShape(20.dp),
                                            )
                                                .padding(end = 20.dp),
                                            verticalAlignment = Alignment.CenterVertically,
                                            horizontalArrangement = Arrangement.End,
                                        ) {
                                            AnimatedVisibility(
                                                visible = swipeOffset > 4f,
                                                enter = slideInHorizontally(
                                                    initialOffsetX = { it / 3 },
                                                    animationSpec = spring(stiffness = Spring.StiffnessMediumLow),
                                                ) + fadeIn(tween(140)) + scaleIn(
                                                    initialScale = 0.82f,
                                                    animationSpec = spring(stiffness = Spring.StiffnessMediumLow),
                                                ),
                                                exit = slideOutHorizontally(
                                                    targetOffsetX = { it / 4 },
                                                    animationSpec = tween(100),
                                                ) + fadeOut(tween(90)) + scaleOut(
                                                    targetScale = 0.82f,
                                                    animationSpec = spring(stiffness = Spring.StiffnessMediumLow),
                                                ),
                                            ) {
                                                Row(
                                                    Modifier.width(116.dp),
                                                    horizontalArrangement = Arrangement.Center,
                                                    verticalAlignment = Alignment.CenterVertically,
                                                ) {
                                                    androidx.compose.animation.Crossfade(targetState = closeArmed || departure != null,
                                                        modifier = Modifier.fillMaxWidth(),
                                                        animationSpec = tween(InteractionMotion.duration(InteractionMotion.State)), label = "close-threshold") { armed ->
                                                        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.Center,
                                                            verticalAlignment = Alignment.CenterVertically) {
                                                    Icon(if (armed) Icons.Rounded.Check else Icons.Rounded.Close, contentDescription = null,
                                                        tint = MaterialTheme.colorScheme.onError, modifier = Modifier.size(18.dp))
                                                    Spacer(Modifier.width(6.dp))
                                                    Text(if (armed) L10n.tr("松手关闭") else L10n.tr("关闭"), color = MaterialTheme.colorScheme.onError,
                                                        style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.SemiBold, maxLines = 1)
                                                        }
                                                    }
                                                }
                                            }
                                        }
                                    }
                                    NeumorphSurface(
                                        modifier = Modifier.fillMaxWidth().offset { IntOffset(-swipeAnim.value.roundToInt(), 0) }
                                            .testTag("home-runtime-${runtime.runtimeId}")
                                            .semantics { selected = runtime.runtimeId in selectedIds }
                                            .immediatePressFeedback(!selecting && cardCurrent) { touchPressed = it }
                                            .pointerInput(selecting, runtime.runtimeId, cardWidth, canClose) {
                                                if (!selecting && canClose) {
                                                    detectHomeCloseDragGestures(
                                                        onDragEnd = {
                                                            val shouldClose = closeThreshold > 0f && swipeOffset >= closeThreshold
                                                            // 提交成功后卡片从松手位置继续向左离开，不先弹回再消失。
                                                            val closing = shouldClose && currentCanClose && submitClose(row.hostId, setOf(runtime.runtimeId)).isNotEmpty()
                                                            if (!closing) {
                                                                swipeOffset = 0f; closeArmed = false
                                                                swipeScope.launch { swipeAnim.animateTo(0f, OrbisMotion.drag()) }
                                                            }
                                                        },
                                                        onDragCancel = {
                                                            swipeOffset = 0f; closeArmed = false
                                                            swipeScope.launch { swipeAnim.animateTo(0f, spring(stiffness = Spring.StiffnessMediumLow)) }
                                                        },
                                                        onHorizontalDrag = { change, dragAmount ->
                                                            val next = (swipeOffset - dragAmount).coerceIn(0f, cardWidth)
                                                            swipeOffset = next
                                                            val armed = closeThreshold > 0f && next >= closeThreshold
                                                            if (armed != closeArmed) {
                                                                haptic.performHapticFeedback(HapticFeedbackType.LongPress)
                                                            }
                                                            closeArmed = armed
                                                            swipeScope.launch { swipeAnim.snapTo(next) }
                                                            change.consume()
                                                        },
                                                    )
                                                }
                                            },
                                        shape = RoundedCornerShape(20.dp),
                                        enabled = cardCurrent,
                                        shadowScale = 0.8f,
                                        style = if (!selecting && (touchPressed || opening)) NeumorphStyle.Pressed else NeumorphStyle.Raised,
                                        selectionSelected = runtime.runtimeId in selectedIds,
                                        selectionMode = selecting && canClose,
                                        onClick = {
                                            if (selecting) { if (canClose) toggleSelection(runtime.runtimeId) }
                                            else if (swipeOffset == 0f && !opening) opening = true
                                        },
                                        onLongClick = if (!canClose) null else ({
                                            if (runtime.runtimeId !in selectedIds) haptic.performHapticFeedback(HapticFeedbackType.TextHandleMove)
                                            swipeOffset = 0f; closeArmed = false
                                            swipeScope.launch { swipeAnim.snapTo(0f) }
                                            selectedRuntimeIds = selectedIds + runtime.runtimeId
                                        }),
                                        contentInset = 16.dp,
                                    ) {
                                        Row(
                                            modifier = Modifier.fillMaxWidth().padding(16.dp),
                                            verticalAlignment = Alignment.CenterVertically,
                                            horizontalArrangement = Arrangement.spacedBy(12.dp),
                                        ) {
                                            AgentEmblem(agentBrand(runtime.agentKind), 44.dp)
                                            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                                                MotionText(row.card.title, style = MaterialTheme.typography.titleMedium,
                                                    fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                                                Text(runtime.cwd, fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.bodySmall,
                                                    color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
                                                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                                                    Text(agentBrand(runtime.agentKind).title, color = agentBrand(runtime.agentKind).accent(), style = MaterialTheme.typography.labelMedium)
                                                    if (row.card.hasPendingInteraction) {
                                                        Row(horizontalArrangement = Arrangement.spacedBy(4.dp), verticalAlignment = Alignment.CenterVertically) {
                                                            Icon(Icons.Rounded.ErrorOutline, contentDescription = null, tint = MaterialTheme.colorScheme.error, modifier = Modifier.size(14.dp))
                                                            Text(L10n.tr("待确认"), color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.SemiBold)
                                                        }
                                                    } else RuntimeStatus(runtime.presentationStatus, title = runtime.presentationTitle)
                                                }
                                            }
                                            OrbisSelectionIndicator(runtime.runtimeId in selectedIds, selecting && canClose)
                                        }
                                    }
                                }
                            }
                        }
                        launchIntro?.let { intro ->
                            item(key = "new-session-" + intro.requestId) { NewSessionMotionCard(intro) { onLaunchPresented(intro.requestId) } }
                        }
                    }
                PullToRefreshDefaults.Indicator(
                    state = pullRefreshState,
                    isRefreshing = pullRefreshing,
                    modifier = Modifier.align(Alignment.TopCenter),
                    containerColor = MaterialTheme.colorScheme.surface,
                    color = MaterialTheme.colorScheme.primary,
                )
                }
            }
        }
    }
}

/** Before the first complete snapshot the list is empty, so its own area says why: loading or a retryable failure. */
@Composable
private fun HomeFirstLoadStatus(sync: HomeSyncStatus, e2eReady: Boolean, onRetry: () -> Unit) {
    Column(Modifier.fillMaxWidth().heightIn(min = 180.dp).testTag("home-session-status"),
        verticalArrangement = Arrangement.Center, horizontalAlignment = Alignment.CenterHorizontally) {
        if (sync is HomeSyncStatus.Failed) {
            Icon(Icons.Rounded.ErrorOutline, contentDescription = null, modifier = Modifier.size(44.dp),
                tint = MaterialTheme.colorScheme.error)
            Spacer(Modifier.height(14.dp))
            Text(sync.message, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold,
                textAlign = TextAlign.Center)
            Spacer(Modifier.height(20.dp))
            NeumorphActionButton(
                onClick = onRetry,
                text = if (e2eReady) L10n.tr("重新加载") else L10n.tr("重新连接"),
                icon = Icons.Rounded.Refresh,
                modifier = Modifier.fillMaxWidth()
                    .semantics { contentDescription = if (e2eReady) L10n.tr("重新加载会话") else L10n.tr("重新连接") },
            )
        } else {
            CircularProgressIndicator(modifier = Modifier.size(36.dp), strokeWidth = 3.dp)
            Spacer(Modifier.height(14.dp))
            Text(L10n.tr("正在加载会话…"), style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold,
                color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

/** The card keys the home list last laid out, to place the viewport when they change. */

/** One home-screen card and the computer that serves it. */
private data class DepartingHomeRow(val row: HostRuntimeRow, val index: Int, val token: String = java.util.UUID.randomUUID().toString())

private data class HostRuntimeRow(
    val hostId: String,
    val hostName: String,
    val card: HomeRuntimeCard,
    val state: RemoteState,
) { val runtime: RuntimeSummary get() = card.runtime }

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
    val codexDesktopSupported = state.launchableAgents?.contains("codexDesktop") == true
    // DSH may be launchable even while its backend is offline; Host will start or attach it on request.
    val dshSupported = (state.launchableAgents ?: state.supportedAgents)?.contains("dsh") == true
    // Claude Code 只在电脑能打开终端窗口时可新建（Host 的 launchableAgents）。
    val claudeSupported = state.launchableAgents?.contains("claude") == true
    LaunchedEffect(codexSupported, codexDesktopSupported, dshSupported, claudeSupported) {
        // chip 可能停在上一轮选中的 Codex 上（rememberSaveable），电脑不支持就拉回来。
        if (!codexSupported && agentKind == "codex") agentKind = "pi"
        if (!codexDesktopSupported && agentKind == "codexDesktop") agentKind = "pi"
        if (!dshSupported && agentKind == "dsh") agentKind = "pi"
        if (!claudeSupported && agentKind == "claude") agentKind = "pi"
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
            // 标题与 iOS 一致：「新建会话」，目标电脑作为右侧说明，不再写成一整句。
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(L10n.tr("新建会话"), style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold,
                    modifier = Modifier.weight(1f).semantics { heading() })
                Icon(Icons.Rounded.Computer, contentDescription = null, modifier = Modifier.size(16.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
                Text(state.sessionHost?.name ?: L10n.tr("电脑"), style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            // 固定两列网格，每格同宽（与 iOS 一致）。
            Column(Modifier.fillMaxWidth().selectableGroup(), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    AgentChoice(AgentBrand.Pi, agentKind == "pi", { agentKind = "pi" }, Modifier.weight(1f))
                    AgentChoice(AgentBrand.Codex, agentKind == "codex", { agentKind = "codex" }, Modifier.weight(1f), codexSupported, L10n.tr("Codex 终端"))
                }
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    AgentChoice(AgentBrand.Codex, agentKind == "codexDesktop", { agentKind = "codexDesktop" }, Modifier.weight(1f), codexDesktopSupported, L10n.tr("Codex 桌面版"))
                    AgentChoice(AgentBrand.DeepSeek, agentKind == "dsh", { agentKind = "dsh" }, Modifier.weight(1f), dshSupported)
                }
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    AgentChoice(AgentBrand.Claude, agentKind == "claude", { agentKind = "claude" }, Modifier.weight(1f), claudeSupported)
                    Spacer(Modifier.weight(1f))
                }
            }
            if (!codexSupported) {
                Text(
                    L10n.tr("这台电脑没启用 Codex 后端"),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            val offline = !state.canOperateSessions
            if (offline) {
                Text(
                    L10n.tr("未连接到电脑"),
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
                    text = L10n.tr("在此目录新建 {0} 会话", agentBrand(agentKind).title),
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
                    text = L10n.tr("在这里新建 {0} 会话", agentBrand(agentKind).title),
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
private fun HistoryPagingHeader(
    phase: SessionReadPhase?,
    error: String?,
    feedback: String?,
    onLoad: () -> Unit,
) {
    if (phase?.active == true) {
        Column(Modifier.fillMaxWidth().padding(vertical = 8.dp)) {
            LinearProgressIndicator(Modifier.fillMaxWidth())
            Text(
                L10n.tr("正在加载更早的历史…"),
                modifier = Modifier.padding(top = 8.dp),
                style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        return
    }
    when {
        phase == SessionReadPhase.FAILED && error != null -> WarningCard(feedback ?: error)
        feedback != null -> WarningCard(feedback)
    }
    Row(
        modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.SpaceBetween,
    ) {
        Text(
            if (phase == SessionReadPhase.FAILED) L10n.tr("历史加载失败") else L10n.tr("还有更早的历史"),
            style = MaterialTheme.typography.labelMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        TextButton(onClick = onLoad) {
            Text(if (phase == SessionReadPhase.FAILED) L10n.tr("重试") else L10n.tr("加载"))
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun OfflineHistoryScreen(
    state: RemoteState,
    sessionId: String?,
    model: RemoteViewModel,
    onBack: () -> Unit,
) {
    val graph = sessionId?.let(state.sessionGraphs::get)
    val projection = remember(graph) {
        graph?.let(::projectSessionGraph) ?: SessionProjectionResult(emptyList(), L10n.tr("本地没有可用的历史缓存"))
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
    val historyRead = historyKey?.let(state::historyReadForWindow)
    val firstRead = historyKey?.let { state.sessionReadForWindow(it, SessionReadKind.FIRST_PAGE) }
    val listState = remember(historyKey) { LazyListState() }
    var historyPagingFeedback by remember(historyKey) { mutableStateOf<String?>(null) }
    var historyAnchorIndex by remember(historyKey) { mutableStateOf<Int?>(null) }
    var historyAnchorOffset by remember(historyKey) { mutableStateOf(0) }
    var historyAnchorCount by remember(historyKey) { mutableStateOf(0) }
    var historyAnchorOperationId by remember(historyKey) { mutableStateOf<String?>(null) }
    fun loadHistoryPage() {
        val key = historyKey ?: return
        val index = listState.firstVisibleItemIndex
        val offset = listState.firstVisibleItemScrollOffset
        val count = listState.layoutInfo.totalItemsCount
        val accepted = model.loadOlderHistory(key)
        if (accepted.operationId == null) {
            historyPagingFeedback = accepted.rejection ?: L10n.tr("历史加载请求未启动，请重试")
            return
        }
        historyPagingFeedback = null
        historyAnchorIndex = index
        historyAnchorOffset = offset
        historyAnchorCount = count
        historyAnchorOperationId = accepted.operationId
    }
    val pagingBlocked by rememberUpdatedState(
        historyKey == null || historyState?.hasOlder != true || historyRead?.phase?.active == true ||
            historyRead?.phase == HistoryReadPhase.FAILED || historyAnchorIndex != null
    )
    val currentLoadHistoryPage by rememberUpdatedState { loadHistoryPage() }
    // ADR-0041：只有「滚进顶部」的边沿才加载下一页；加载完成不自动续页。
    LaunchedEffect(historyKey) {
        historyPagingRequests({ listState.firstVisibleItemIndex }) { pagingBlocked }
            .collect { currentLoadHistoryPage() }
    }
    LaunchedEffect(presentation.messages.size, state.historyReads, historyAnchorOperationId) {
        val anchorIndex = historyAnchorIndex ?: return@LaunchedEffect
        val operation = historyAnchorOperationId?.let(state.historyReads::get)
        if (operation?.phase?.active == true) return@LaunchedEffect
        try {
            val itemCount = listState.layoutInfo.totalItemsCount
            if (operation?.phase in setOf(HistoryReadPhase.SUCCEEDED, HistoryReadPhase.END_REACHED) &&
                itemCount > historyAnchorCount) {
                listState.scrollToItem(anchorIndex + itemCount - historyAnchorCount, historyAnchorOffset)
            }
        } finally {
            historyAnchorIndex = null
            historyAnchorOperationId = null
        }
    }
    Scaffold(
        topBar = {
            TopAppBar(
                navigationIcon = {
                    NeumorphIconButton(
                        onClick = onBack,
                        icon = Icons.Rounded.ArrowBack,
                        contentDescription = L10n.tr("返回会话目录"),
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
                        AgentLabel(LocalAgentBrand.current, suffix = L10n.tr("只读历史"))
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
            historyKey?.let { state.conversations[it]?.systemNotice }?.let { notice -> item { NoticeCard(notice) } }
            if (historyState?.hasOlder == true || historyRead?.phase?.active == true) item(key = "history-paging") {
                HistoryPagingHeader(historyRead?.phase, historyRead?.error, historyPagingFeedback, ::loadHistoryPage)
            }
            if (firstRead?.phase?.active == true) item { LinearProgressIndicator(Modifier.fillMaxWidth()) }
            if (firstRead?.phase == SessionReadPhase.FAILED) item {
                WarningCard(firstRead.error ?: L10n.tr("本地首屏读取失败"))
                TextButton(onClick = { model.selectOfflineSession(sessionId) }) { Text(L10n.tr("重试读取")) }
            } else if (firstRead?.phase?.active != true) projection.error?.let { item { WarningCard(L10n.tr("历史记录加载失败：{0}", it)) } }
            if (historyRead?.phase == HistoryReadPhase.FAILED && historyState?.hasOlder != true) item {
                WarningCard(historyPagingFeedback ?: historyRead.error ?: L10n.tr("历史记录加载失败"))
                TextButton(onClick = { loadHistoryPage() }) { Text(L10n.tr("重试历史加载")) }
            }
            if (historyPagingFeedback != null && historyState?.hasOlder != true && historyRead?.phase != HistoryReadPhase.FAILED) {
                item { WarningCard(historyPagingFeedback!!) }
            }
            items(chatItems, key = ChatListItem::key) { item ->
                when (item) {
                    is ChatListItem.UserMessage -> UserMessageCard(
                        runtimeId = offlineRuntimeId,
                        message = item.message,
                        downloads = state.downloads,
                        downloadArtifact = { artifact -> model.downloadArtifact(artifact) },
                        // 只读历史里的文件同样能下载：点击路径就是「请 Host 把这个文件发过来」（§9.4）。
                        downloadFile = { path -> model.downloadFile(path) },
                    )

                    is ChatListItem.AssistantTurn -> AssistantTurnCard(
                        cardId = item.key,
                        runtimeId = offlineRuntimeId,
                        messages = item.messages,
                        turnTiming = groupTurnTiming(item.completedMessageIds.mapNotNull { messageTurnTimings[it] }),
                        nowMs = System.currentTimeMillis(),
                        toolActivities = emptyMap(),
                        toolResults = presentation.toolResults,
                        downloads = state.downloads,
                        downloadArtifact = { artifact -> model.downloadArtifact(artifact) },
                        downloadFile = { path -> model.downloadFile(path) },
                    )
                }
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun ChatScreen(
    state: RemoteState,
    model: RemoteViewModel,
    scrollState: LazyListState? = null,
    executeSlash: (String, String) -> String? = model::executeSlashCommand,
) {
    val runtimeId = state.selectedRuntimeId ?: return
    val actionHaptic = rememberActionHaptic()
    val runtime = state.runtimes[runtimeId]
    // ADR-0049 §6.8：启动中的会话用占位身份进入聊天页，可以写草稿和发送，消息等会话上线后再提交。
    val launch = state.launchPage
    val launchOpen = launch != null && launch.failure == null
    val sessionId = runtime?.sessionId
    // 启动页还没有 Runtime：本地行与发送飞入按启动请求的会话归属（恢复时是原会话，新建时是占位身份）。
    val pageSessionId = sessionId ?: launch?.let { it.resumed ?: it.placeholder }
    val conversation = state.conversations[runtimeId] ?: RuntimeConversation()
    // V13：恢复已有会话的启动页先显示本地缓存的历史（与 iOS 沿用缓存会话页一致），会话上线后由真实会话接替。
    val launchCache = launch?.resumed?.let(state.sessionGraphs::get)
    val launchHistory = remember(launchCache) { launchCache?.let(::projectSessionGraph)?.messages.orEmpty() }
    val rewindCommands = state.capabilities[runtimeId]?.commands.orEmpty()
    val rewindGraph = sessionId?.let(state.sessionGraphs::get)
    val rewindOptions = remember(rewindCommands, rewindGraph?.display) { userMessageRewindOptions(rewindCommands, rewindGraph) }
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
    // ADR-0039 §5：按消息对象身份复用上一次的列表行。`revision` 每条 patch 都会变，
    // 用它当 key 等于每次都重建整段会话的呈现；这里改成"只有消息对象真的换了才重建"。
    val presentationCache = remember { PresentationCache() }
    // ADR-0049：本地待确认发送只在呈现时叠加，权威记录与缓存都不包含它们。
    val pendingRows = state.pendingSends.chatRows(pageSessionId)
    val baseMessages = if (conversation.messages.isEmpty() && launch != null) launchHistory else conversation.messages
    val visibleMessages = remember(baseMessages, pendingRows) { mergePendingSends(baseMessages, pendingRows) }
    val presentation = presentationCache.presentation(visibleMessages)
    val chatItems = presentationCache.items(presentation.messages, turnIdsByMessageId)
    val latestQuestion = remember(conversation.messages) { latestChatQuestion(conversation.messages) }
    val truncatedContent = remember(presentation.messages) {
        presentation.messages.firstNotNullOfOrNull { message ->
            message.content.firstOrNull { it.truncated }?.let { message.messageId to (it.originalBytes ?: 0L) }
        }
    }
    val chatItemKeys = remember(chatItems) { chatItems.map(ChatListItem::key) }
    val chatItemIndexById = remember(conversation.revision) { chatListItemIndexByMessageId(chatItems) }
    val representedToolIds = remember(conversation.revision) {
        presentation.messages.flatMap { message -> message.content.mapNotNull(RemoteContent::toolCallId) }.toSet()
    }
    val orphanTools = remember(conversation.revision, representedToolIds) {
        orphanToolActivities(conversation.tools.values, representedToolIds)
    }
    // 下载不属于任何会话：会话页的下载按钮显示的是这台电脑全部在途任务。
    val activeDownloadCount = state.downloads.values.count { it.status == "queued" || it.status == "downloading" }
    // Enter at the cached tail; laying out the oldest card and then jumping doubles first-frame work.
    val listState = scrollState ?: remember(runtimeId, sessionId) {
        LazyListState(firstVisibleItemIndex = chatItems.size + orphanTools.size,
            firstVisibleItemScrollOffset = if (chatItems.isEmpty()) 0 else Int.MAX_VALUE)
    }
    LaunchedEffect(runtimeId, sessionId, listState, chatItems, turnIdsByMessageId, state.connection) {
        snapshotFlow { listState.layoutInfo.visibleItemsInfo.map { it.key }.toSet() }.collect { visible ->
            val entries = chatItems.filter { it.key in visible }.flatMap { item -> when (item) {
                is ChatListItem.UserMessage -> listOf(item.message.messageId)
                is ChatListItem.AssistantTurn -> item.messages.map { it.messageId }
            } }
            model.requestChangeSummaries(runtimeId, entries, entries.mapNotNull(turnIdsByMessageId::get))
        }
    }
    val sourceRead = state.sessionReadForWindow(runtimeId, SessionReadKind.SOURCE)
    val firstRead = state.sessionReadForWindow(runtimeId, SessionReadKind.FIRST_PAGE)
    val firstReadError = firstRead?.takeIf { it.phase == SessionReadPhase.FAILED &&
        conversation.messages.isEmpty() && sourceRead?.phase?.active != true }?.error
    val refreshTasksPending = sourceRead?.phase?.active == true
    val displayReadPending = refreshTasksPending || firstRead?.phase?.active == true
    val historyState = state.sessionHistory[runtimeId]
    val historyRead = state.historyReadForWindow(runtimeId)
    val rangeError = state.sessionRangeFailures[sessionRangeFailureKey(runtimeId, "catchup")]
    // One reserved status slot: sync, paging and error updates never insert transcript rows.
    val chatHeaderCount = 1
    val viewportMotion = remember(runtimeId, sessionId) { ChatViewportMotion() }
    // A catch-up can connect a large cached prefix in one projection. LazyColumn's nearby-key
    // lookup may then lose the old row. Capture its key before the new list is laid out.
    val previousItemKeys = remember(runtimeId, sessionId) { mutableSetOf<String>() }
    val projectionAnchor = remember(listState, chatItems, chatHeaderCount, orphanTools.size, displayReadPending, sourceRead?.operationId) {
        listState.layoutInfo.visibleItemsInfo.firstOrNull { it.key in chatItemIndexById || it.key in previousItemKeys }
            ?.let { ChatReadingAnchor(it.key as String, it.index, -it.offset, viewportMotion.generation) }
    }
    SideEffect {
        previousItemKeys.clear()
        previousItemKeys.addAll(chatItemKeys)
    }
    // Capture before a replacement is laid out, including when the new projection is empty.
    var refreshAnchorOperationId by remember(runtimeId, sessionId) { mutableStateOf<String?>(null) }
    val refreshStartAnchor = remember(runtimeId, sessionId, sourceRead?.operationId) { projectionAnchor }
    var historyAnchorMessageId by remember(runtimeId, sessionId) { mutableStateOf<String?>(null) }
    var historyAnchorIndex by remember(runtimeId, sessionId) { mutableStateOf<Int?>(null) }
    var historyAnchorPending by remember(runtimeId, sessionId) { mutableStateOf(false) }
    var historyAnchorOperationId by remember(runtimeId, sessionId) { mutableStateOf<String?>(null) }
    var historyAnchorOffset by remember(runtimeId, sessionId) { mutableStateOf(0) }
    var historyAnchorGeneration by remember(runtimeId, sessionId) { mutableStateOf(0L) }
    var historyPagingFeedback by remember(runtimeId, sessionId) { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()
    val sendFlight = remember(state.hostId, runtimeId, sessionId) { MessageSendFlightState(scope) }
    var initialPositioned by remember(runtimeId, sessionId) { mutableStateOf(false) }
    val lineHeightPx = with(LocalDensity.current) { MaterialTheme.typography.bodyLarge.lineHeight.toPx() }
    var following by remember(runtimeId, sessionId) { mutableStateOf(true) }
    val replyArrivals = remember(state.hostId, runtimeId, sessionId) { ReplyCardArrivals() }
    replyArrivals.observe(chatItems.map { item -> item.key to when (item) {
        is ChatListItem.UserMessage -> listOf(item.message.messageId)
        is ChatListItem.AssistantTurn -> item.messages.map { it.messageId }
    } }, initialPositioned && state.e2eReady && conversation.sourceReady && !conversation.isChatSyncing && !displayReadPending,
        following, android.os.SystemClock.uptimeMillis())
    var hasBrowsed by remember(state.hostId, runtimeId, sessionId) { mutableStateOf(false) }
    var lastScrollTowardEarlier by remember(state.hostId, runtimeId, sessionId) { mutableStateOf(false) }
    var suppressQuestionPaging by remember(state.hostId, runtimeId, sessionId) { mutableStateOf(false) }
    var userScrolling by remember(runtimeId, sessionId) { mutableStateOf(false) }
    val dragging by listState.interactionSource.collectIsDraggedAsState()
    LaunchedEffect(dragging, state.hostId) {
        if (dragging) {
            following = false
            hasBrowsed = true
            suppressQuestionPaging = false
            userScrolling = true
            viewportMotion.moved()
        }
    }
    val distanceToBottom by remember(listState) {
        derivedStateOf {
            val layout = listState.layoutInfo
            val last = layout.visibleItemsInfo.lastOrNull()
            chatBottomDistance(last?.index ?: -1, layout.totalItemsCount,
                (last?.offset ?: 0) + (last?.size ?: 0), layout.viewportEndOffset, layout.afterContentPadding)
        }
    }
    val scrollIntent = remember(state.hostId, runtimeId, sessionId) {
        object : NestedScrollConnection {
            override fun onPreScroll(available: Offset, source: NestedScrollSource): Offset {
                if (source == NestedScrollSource.UserInput && available.y != 0f) {
                    lastScrollTowardEarlier = available.y > 0f
                    following = false
                    hasBrowsed = true
                    suppressQuestionPaging = false
                    userScrolling = true
                    viewportMotion.moved()
                }
                return Offset.Zero
            }
            override fun onPostScroll(consumed: Offset, available: Offset, source: NestedScrollSource): Offset {
                // Includes inertia. LazyColumn maintains the current key/offset inside its
                // measure pass; asynchronous history/refresh jobs must not restore an older one.
                if (consumed.y != 0f) viewportMotion.moved()
                return Offset.Zero
            }
        }
    }
    LaunchedEffect(runtimeId, sessionId, listState) {
        snapshotFlow { Triple(distanceToBottom, listState.isScrollInProgress || dragging, listState.layoutInfo.totalItemsCount) }
            .collect { (distance, scrolling, count) ->
                if (userScrolling) {
                    if (!scrolling) {
                        userScrolling = false
                        following = distance < lineHeightPx
                        if (following) hasBrowsed = false
                    }
                } else if (!scrolling && count > chatHeaderCount) {
                    if (following && distance > 0.5f) listState.scrollToItem(count - 1, Int.MAX_VALUE)
                    // A layout change (including an empty recovery projection) is not a
                    // request to follow. Only an actual user scroll ending near the tail is.
                }
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
    // 历史页顶栏的下载入口：下载页滑入后返回历史页（ADR-0054）。
    var historyDownloadsOpen by remember(runtimeId, sessionId) { mutableStateOf(false) }
    LaunchedEffect(historyOpen) { if (!historyOpen) historyDownloadsOpen = false }
    // M16：聊天页与历史页各自的下载飞入层，文件飞向本页右上角的下载按钮。
    val chatFlight = rememberDownloadFlight(runtimeId, sessionId)
    val historyFlight = rememberDownloadFlight(runtimeId, sessionId)
    var historyAction by remember(runtimeId, sessionId) { mutableStateOf<HistoryTreeAction?>(null) }
    var historyActionCommandId by remember(runtimeId, sessionId) { mutableStateOf<String?>(null) }
    var historyActionError by remember(runtimeId, sessionId) { mutableStateOf<String?>(null) }
    fun runHistoryAction(action: HistoryTreeAction) {
        if (historyActionCommandId != null) return
        historyActionError = null
        val commandId = model.executeSlashCommand("tree", action.nodeId)
        if (commandId == null) {
            historyActionError = L10n.tr("跳转未送达：当前会话没有提供 /tree 命令")
            return
        }
        actionHaptic()
        historyAction = action
        historyActionCommandId = commandId
    }
    var pendingMessageCommandId by remember(runtimeId) { mutableStateOf<String?>(null) }
    var pendingMessageText by remember(runtimeId) { mutableStateOf("") }
    var commandFeedback by remember(runtimeId) { mutableStateOf<String?>(null) }
    var commandFeedbackTransient by remember(runtimeId) { mutableStateOf(false) }
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
    // 基础协议支持附件路径，不使用 `messageAttachments` 能力位（ADR-0012）。
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
            commandFeedbackTransient = false
            commandFeedback = L10n.tr("一次最多发送 {0} 个文件", MAX_ATTACHMENTS_PER_MESSAGE)
        }
    }
    // Refresh replaces the visible conversation with a fresh projection. Remember the row the
    // user is looking at so the viewport can stay put instead of jumping to the newest message.
    var refreshAnchorMessageId by remember(runtimeId, sessionId) { mutableStateOf<String?>(null) }
    var refreshAnchorIndex by remember(runtimeId, sessionId) { mutableStateOf<Int?>(null) }
    var refreshAnchorOffset by remember(runtimeId, sessionId) { mutableStateOf(0) }
    var refreshAnchorArmed by remember(runtimeId, sessionId) { mutableStateOf(false) }
    var refreshAnchorGeneration by remember(runtimeId, sessionId) { mutableStateOf(0L) }
    fun refreshConversation() {
        model.refreshRuntime(runtimeId)
        model.refreshWorkingBranch(runtimeId)
    }
    /** ADR-0049：消息写入通道即显示本地行，输入框立即清空；结果落在那一行上，不再锁住发送键。 */
    fun animateSend(commandId: String?) {
        commandId?.let(model::submittedSend)?.takeIf { it.sessionId == pageSessionId }?.let { sendFlight.launch(it, following) }
    }
    fun submitMessage(commandId: String?) {
        if (commandId == null) return
        animateSend(commandId)
        actionHaptic()
        commandFeedback = null
        input = ""
        selectedSlashCommandName = null
        model.clearDraft(runtimeId)
    }
    fun trackSubmission(commandId: String?) {
        if (commandId == null) return
        actionHaptic()
        val submittedText = input
        commandFeedback = null
        pendingMessageCommandId = commandId
        pendingMessageText = submittedText
        // Keep command arguments recoverable until a definite success. A channel write
        // cannot prove that a prompt/skill or configuration action completed.
    }
    LaunchedEffect(commandFeedback, commandFeedbackTransient) {
        if (commandFeedback != null && commandFeedbackTransient) { delay(2_500); commandFeedback = null }
    }
    LaunchedEffect(runtime?.status) {
        if (runtime?.status != "running") showDeliveryChoices = false
    }
    val lifecycleOwner = LocalLifecycleOwner.current
    LaunchedEffect(runtimeId, sessionId, runtime?.cwd, state.e2eReady, lifecycleOwner) {
        lifecycleOwner.lifecycle.repeatOnLifecycle(Lifecycle.State.RESUMED) {
            model.syncNotifications(runtimeId)
            refreshConversation()
            while (isActive) {
                delay(15_000)
                model.syncNotifications(runtimeId)
                refreshConversation()
            }
        }
    }
    fun loadHistoryPage() {
        val anchor = listState.layoutInfo.visibleItemsInfo.firstOrNull { it.key in chatItemIndexById }
        val index = anchor?.index ?: listState.firstVisibleItemIndex
        val offset = anchor?.let { -it.offset } ?: listState.firstVisibleItemScrollOffset
        val accepted = model.loadOlderHistory(runtimeId)
        if (accepted.operationId == null) {
            historyPagingFeedback = accepted.rejection ?: L10n.tr("历史加载请求未启动，请重试")
            return
        }
        historyPagingFeedback = null
        historyAnchorMessageId = anchor?.key as? String
        historyAnchorIndex = index
        historyAnchorPending = true
        historyAnchorOffset = offset
        historyAnchorGeneration = viewportMotion.generation
        historyAnchorOperationId = accepted.operationId
    }
    val pagingBlocked by rememberUpdatedState(
        !initialPositioned || historyState?.hasOlder != true || historyRead?.phase?.active == true ||
            historyRead?.phase == HistoryReadPhase.FAILED || historyAnchorPending || suppressQuestionPaging
    )
    val currentLoadHistoryPage by rememberUpdatedState { loadHistoryPage() }
    // ADR-0041：只有「滚进顶部」的边沿才加载下一页。把 hasOlder/phase 放进 key 会让 effect 每完成
    // 一页就重启、snapshotFlow 重放当前值，于是停在顶部变成连续下载。
    LaunchedEffect(runtimeId, sessionId) {
        historyPagingRequests({ listState.firstVisibleItemIndex }) { pagingBlocked }
            .collect { currentLoadHistoryPage() }
    }
    LaunchedEffect(chatItems, state.historyReads, historyAnchorOperationId) {
        val operation = historyAnchorOperationId?.let(state.historyReads::get)
        if (!historyAnchorPending || operation?.phase?.active == true) return@LaunchedEffect
        try {
            if (operation?.phase in setOf(HistoryReadPhase.SUCCEEDED, HistoryReadPhase.END_REACHED) &&
                historyAnchorGeneration == viewportMotion.generation && !userScrolling && !following &&
                !listState.isScrollInProgress) {
                val newIndex = historyAnchorMessageId?.let { chatItemIndexById[it] }
                    ?.let { it + chatHeaderCount } ?: historyAnchorIndex
                if (newIndex != null && newIndex >= 0) listState.scrollToItem(newIndex, historyAnchorOffset)
            }
        } finally {
            historyAnchorMessageId = null
            historyAnchorIndex = null
            historyAnchorPending = false
            historyAnchorOperationId = null
        }
    }


    // 历史页的跳转：成功后回到聊天页并停在新位置；编辑重发还要把原文放回输入框。
    // 历史与聊天保持组合，命令回执按当前 runtime 消费，成功后关闭历史层。
    LaunchedEffect(historyActionCommandId, state.commandResults) {
        val commandId = historyActionCommandId ?: return@LaunchedEffect
        val result = state.commandResults[commandId] ?: return@LaunchedEffect
        val action = historyAction
        model.consumeCommandResult(commandId)
        historyActionCommandId = null
        historyAction = null
        if (!result.ok) {
            historyActionError = L10n.tr("跳转失败：{0}", result.status)
            return@LaunchedEffect
        }
        // DSH 的「跳到某一轮」是原生 fork：后端回传新分支的会话 ID，编辑重发的原文属于那个
        // 新会话，所以直接打开它；原会话保持不动。Pi/codex 是原地回退，回传 leafId/editorText。
        val branchSessionId = historyBranchSessionId(result.result)
        if (action is HistoryTreeAction.EditAndRestart) {
            val text = historyEditorText(result.result) ?: action.fallbackText
            if (text != null) {
                if (branchSessionId != null) {
                    model.saveDraft(branchSessionId, text)
                } else {
                    input = text
                    selectedSlashCommandName = null
                    model.saveDraft(runtimeId, text)
                }
            }
        }
        if (branchSessionId != null) {
            historyOpen = false
            refreshAnchorArmed = false
            initialPositioned = false
            model.activateSession(branchSessionId)
            return@LaunchedEffect
        }
        // 历史已经被改写（codex 是原地截断，Pi 是同会话内换 leaf）：让列表重新贴到新的当前位置，
        sendFlight.clear()
        // 而不是停在旧锚点上；并立刻拉一次快照——后端广播的快照用自造 syncId，手机不采，
        // 不主动问这一下就还显示着已经不存在的那几轮。
        refreshAnchorArmed = false
        initialPositioned = false
        historyOpen = false
        // A tree/rewind action is an explicit branch replacement. It must supersede any older
        // catch-up task before the ordinary display refresh scheduler runs; a periodic refresh
        // would otherwise be rejected as "already pending" and the old snapshot could clear it.
        model.refreshAfterBranchAction(runtimeId)
        model.refreshWorkingBranch(runtimeId)
    }

    val historyPage: @Composable () -> Unit = {
        OrbisPageHost(
            onBack = { historyDownloadsOpen = false },
            open = historyDownloadsOpen,
            underlay = { DownloadFlightHost(historyFlight) {
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
            activeDownloadCount = activeDownloadCount,
            onOpenDownloads = { historyDownloadsOpen = true },
            downloadFlight = historyFlight,
            onContinueFrom = { node -> runHistoryAction(HistoryTreeAction.ContinueFrom(node.nodeId)) },
            onEditAndRestart = { node ->
                runHistoryAction(
                    HistoryTreeAction.EditAndRestart(
                        nodeId = node.nodeId,
                        fallbackText = sessionId?.let(state.sessionGraphs::get)?.historyNodeText(node.nodeId),
                    ),
                )
            },
            downloadArtifact = { artifact -> if (model.downloadArtifact(artifact)) historyFlight.launch() },
            downloadFile = { path -> if (model.downloadFile(path)) historyFlight.launch() },
        )
            } },
        ) { HostDownloadsScreen(state, model, onBack = { historyDownloadsOpen = false }) }
    }

    LaunchedEffect(runtimeId, sessionId, displayReadPending, chatItems, chatHeaderCount, orphanTools.size,
        sourceRead?.operationId, sourceRead?.phase) {
        if (refreshTasksPending && initialPositioned && !refreshAnchorArmed && !following) {
            refreshStartAnchor?.takeIf { it.generation == viewportMotion.generation }?.let { (key, index, offset, generation) ->
                refreshAnchorMessageId = key
                refreshAnchorIndex = index
                refreshAnchorOffset = offset
                refreshAnchorOperationId = sourceRead?.operationId
                refreshAnchorArmed = true
                refreshAnchorGeneration = generation
            }
        }
        val anchorRead = refreshAnchorOperationId?.let(state.sessionReads::get)
        val refreshFinished = refreshAnchorArmed && anchorRead?.phase?.active != true
        if (chatItems.isEmpty()) {
            if (initialPositioned && !following && !refreshAnchorArmed) {
                projectionAnchor?.let { (key, index, offset, generation) ->
                    refreshAnchorMessageId = key
                    refreshAnchorIndex = index
                    refreshAnchorOffset = offset
                    refreshAnchorArmed = true
                    refreshAnchorGeneration = generation
                }
            }
            return@LaunchedEffect
        }
        // Slow/error notices are list rows too. They cannot establish the initial chat anchor;
        // wait until an actual message row has been laid out before enabling history paging.
        val itemCount = snapshotFlow { listState.layoutInfo }.first { layout ->
            layout.totalItemsCount == chatHeaderCount + chatItems.size + orphanTools.size &&
                layout.visibleItemsInfo.any { it.key in chatItemIndexById }
        }.totalItemsCount
        if (refreshAnchorArmed && (refreshAnchorGeneration != viewportMotion.generation || following)) {
            refreshAnchorArmed = false
            refreshAnchorOperationId = null
        }
        if (refreshAnchorArmed) {
            // A refresh must not move the viewport. Restore the row that was visible before the
            // replacement projection, falling back to its old index when that row disappeared.
            val anchorIndex = refreshAnchorMessageId
                ?.let { id -> chatItemIndexById[id] }
                ?.let { it + chatHeaderCount }
                ?: refreshAnchorIndex
            try {
                if (anchorIndex != null && anchorIndex >= 0 && !userScrolling && !listState.isScrollInProgress) {
                    listState.scrollToItem(anchorIndex.coerceAtMost(itemCount - 1), refreshAnchorOffset)
                }
            } finally {
                // The viewport belongs to this source read, not to unrelated history/background
                // ranges or a replacement source read. Every terminal outcome releases it.
                if (refreshFinished) {
                    refreshAnchorArmed = false
                    refreshAnchorOperationId = null
                }
            }
            initialPositioned = true
            return@LaunchedEffect
        }
        if (!following && !historyAnchorPending) {
            projectionAnchor?.takeIf { it.generation == viewportMotion.generation }?.let { (key, _, offset) ->
                chatItemIndexById[key]?.let { index ->
                    val first = listState.layoutInfo.visibleItemsInfo.firstOrNull { it.key in chatItemIndexById }
                    if (!userScrolling && !listState.isScrollInProgress &&
                        (first?.key != key || first?.offset != -offset)) {
                        listState.scrollToItem(chatHeaderCount + index, offset)
                    }
                }
            }
        }
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
        // 失败也必须落在 composer 上方：斜杠命令不再像以前那样「发完没动静」，
        // 而是明确说出是中断失败、电脑端拒绝，还是连接把请求丢了。
        if (pendingMessageText.trim().startsWith("/")) {
            commandFeedbackTransient = result.ok
            commandFeedback = if (result.ok) slashCommandFeedback(pendingMessageText, result)
                else slashCommandError(pendingMessageText, result)
        }
        model.consumeCommandResult(commandId)
        pendingMessageCommandId = null
        pendingMessageText = ""
    }

    // 历史与分支和下载页一样盖在原聊天实例上，右滑时露出原聊天，保留列表、草稿与展开状态。
    OrbisPageHost(
        onBack = { historyOpen = false; historyActionError = null },
        open = historyOpen,
        underlay = {
    // 对话上方的下载页与主页面下载页是同一个页面（浏览文件 + 下载列表），语义都是「和 Host 交互」。
    // 它从右侧滑入，右滑露出并回到这个对话；对话保持原实例，阅读位置、草稿与展开状态不变（ADR-0054）。
    OrbisPageHost(
        onBack = { downloadManagerOpen = false },
        open = downloadManagerOpen,
        underlay = { DownloadFlightHost(chatFlight) { MessageSendFlightHost(sendFlight,
            active = !historyOpen && !downloadManagerOpen && LocalPageActive.current) {
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
                                launch?.title ?: state.sessionDisplayName(sessionId, runtime),
                                modifier = Modifier.weight(1f),
                                style = MaterialTheme.typography.titleMedium,
                                fontWeight = FontWeight.SemiBold,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                            )
                        }
                        ChatRuntimeStatus(
                            status = runtime?.presentationStatus ?: launch?.status ?: "error",
                            title = runtime?.presentationTitle,
                            isChatSyncing = displayReadPending,
                            // ADR-0049 §6.7：切换中显示所选值加标记；同一槽位、同一省略规则（V05）。
                            modelLabel = state.configStatus(runtimeId, "model")?.let { "${it.first} · ${it.second}" }
                                ?: runtime?.model?.let(::modelLabel),
                            thinkingLevel = state.configStatus(runtimeId, "thinking")?.let { "${it.first} · ${it.second}" }
                                ?: runtime?.thinkingLevel,
                        )
                    }
                },
                navigationIcon = {
                    NeumorphIconButton(
                        onClick = { model.selectRuntime(null) },
                        icon = Icons.Rounded.ArrowBack,
                        contentDescription = L10n.tr("返回"),
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
                        contentDescription = L10n.tr("历史与分支"),
                        size = 40.dp,
                    )
                    DownloadStatusButton(
                        activeCount = activeDownloadCount,
                        // 下载由 Host 服务（§9.4），与「当前会话的 runtime 在不在」无关。
                        enabled = state.hostId != null,
                        onClick = { downloadManagerOpen = true },
                        modifier = Modifier.testTag("chat-downloads").downloadFlightTarget(chatFlight),
                    )
                },
            )
            }
        },
        bottomBar = {
            // 输入区坐在底板上：不加 tonal/shadow elevation（tonal 会叠 surfaceTint 偏色，
            // 阴影会把「同一块地面」切断）。键盘出现时输入区随键盘上移，顶栏保持原位。
            Surface(Modifier.imePadding()) {
                Column {
                    runtime?.backgroundTasks?.takeIf { it.visible }?.let { tasks ->
                        androidx.compose.runtime.key(runtimeId, sessionId) { BackgroundTasksPanel(tasks) }
                    }
                    ComposerContextRail(composerStatus(runtime))
                    PendingMessagesPanel(
                        messages = state.queuePanelItems(runtimeId),
                        unconfirmed = OperationKinds.unconfirmedQueueIds(state.ledger, runtimeId),
                        canSend = state.e2eReady && runtime != null,
                        onCancel = model::cancelQueuedMessage,
                    )
                    OrbisCollapse(expanded = deliveryChoicesVisible(showDeliveryChoices, runtime?.status)) {
                        Row(
                            Modifier.fillMaxWidth().padding(horizontal = RemoteUi.PagePadding, vertical = 8.dp),
                            horizontalArrangement = Arrangement.spacedBy(8.dp),
                        ) {
                            NeumorphTextButton(
                                text = queuedMessageDeliveryText("followUp"),
                                onClick = {
                                    showDeliveryChoices = false
                                    submitMessage(model.sendMessage(input, "followUp"))
                                },
                                enabled = pendingMessageCommandId == null,
                                filled = true,
                                modifier = Modifier.weight(1f),
                            )
                            NeumorphTextButton(
                                text = queuedMessageDeliveryText("steer"),
                                onClick = {
                                    showDeliveryChoices = false
                                    submitMessage(model.sendMessage(input, "steer"))
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
                    // 输入斜杠命令时让位给命令列表，命令紧贴输入框（与 iOS 一致）。
                    if (!input.trimStart().startsWith("/")) {
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
                                    permissionManagement = runtime?.permissionManagement,
                                    connected = state.e2eReady && runtime?.domainAvailability?.get("permissions") == "ready",
                                    idle = runtime?.status == "idle" && conversation.interactions.isEmpty() && conversation.queuedMessages.isEmpty(),
                                    commandResults = state.commandResults,
                                    onApply = model::updatePermissions,
                                )
                            }
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
                    Row(
                        Modifier.fillMaxWidth().navigationBarsPadding()
                            .padding(start = 12.dp, end = 12.dp, top = 4.dp, bottom = 12.dp),
                        verticalAlignment = Alignment.Bottom,
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                    if (canAttachFiles) {
                        NeumorphIconButton(
                            onClick = { filePicker.launch(arrayOf("*/*")) },
                            icon = Icons.Rounded.AttachFile,
                            contentDescription = L10n.tr("发送文件到电脑"),
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
                        modifier = Modifier.weight(1f).onGloballyPositioned { sendFlight.composer = it.boundsInWindow() },
                        placeholder = { Text(L10n.tr("发给 {0}，/ 命令", LocalAgentBrand.current.title), maxLines = 1, overflow = TextOverflow.Ellipsis) },
                        enabled = runtime != null || launchOpen,
                        minLines = 1,
                        maxLines = 5,
                    )
                    // 两侧按钮保持 48dp 触控区；输入框承担剩余宽度，多行输入时按钮贴底对齐。
                    val sendEnabled = when (composerMode) {
                        ComposerAction.Abort -> runtime != null
                        ComposerAction.Send -> (runtime != null || launchOpen) && canSubmitInput(
                            input,
                            state.capabilities[runtimeId]?.commands.orEmpty(),
                            selectedSlashCommandName,
                        ) && pendingMessageCommandId == null &&
                            // ADR-0049 §6.2：附件还在上传也可以发送，消息先等上传完成；失败或取消的附件需要先处理。
                            attachedUploads.none { it.status == "failed" || it.status == "cancelled" }
                    }
                    var composerActivation by remember { mutableIntStateOf(0) }
                    NeumorphSurface(
                        modifier = Modifier.padding(bottom = 4.dp).size(48.dp),
                        shape = CircleShape,
                        shadowScale = 0.75f,
                        enabled = sendEnabled,
                        onClick = {
                                composerActivation++
                                when (composerMode) {
                                    ComposerAction.Abort -> {
                                        showDeliveryChoices = false
                                        if (model.stopRuntime() != null) actionHaptic()
                                    }

                                    ComposerAction.Send -> {
                                        val selectedCommand = state.capabilities[runtimeId]?.commands
                                            ?.find { it.name == selectedSlashCommandName }
                                        val slash = parseSlashInvocation(input)
                                        if (selectedCommand != null && slash?.first == selectedCommand.name) {
                                            showDeliveryChoices = false
                                            // ADR-0049 §6.1：产生对话的 Slash 与消息一样，气泡立即出现、输入框清空。
                                            if (model.producesMessage(selectedCommand, runtime)) {
                                                submitMessage(executeSlash(selectedCommand.name, slash.second))
                                            } else if (OperationKinds.isConfigSetting(selectedCommand.name) && slash.second.isNotBlank()) {
                                                // Config owns its receipt and confirmation in the ledger. It can also
                                                // accept an unchanged/coalesced choice without creating a command.
                                                // Leave the composer usable; new messages wait on the config ledger.
                                                if (executeSlash(selectedCommand.name, slash.second) != null) {
                                                    actionHaptic()
                                                    commandFeedback = null
                                                    input = ""
                                                    selectedSlashCommandName = null
                                                    model.clearDraft(runtimeId)
                                                }
                                            } else trackSubmission(
                                                executeSlash(selectedCommand.name, slash.second),
                                            )
                                        } else if (runtime?.status == "running" && runtime.agentKind == "claude") {
                                            // Claude Code 只有「等当前回合结束后提交」，没有 Steer 可选。
                                            showDeliveryChoices = false
                                            submitMessage(model.sendMessage(input, "followUp"))
                                        } else if (runtime?.status == "running") {
                                            showDeliveryChoices = true
                                        } else {
                                            showDeliveryChoices = false
                                            val commandId = model.sendMessage(input, attachments = attachablePaths,
                                                uploadTaskIds = attachedTaskIds.toList())
                                            // 附件已经交给消息，chip 就不该继续挂在输入框上；仍在上传的继续上传，
                                            // 写入通道后再从上传列表移走（ADR-0049 §6.2）。
                                            if (commandId != null) {
                                                if (attachedUploads.all { it.status == "completed" }) model.detachUploads(attachedTaskIds)
                                                updateAttachedTaskIds(emptySet())
                                            }
                                            submitMessage(commandId)
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
                                    OrbisMotionIcon(
                                        Icons.Rounded.StopCircle,
                                        description = L10n.tr("打断当前任务"),
                                        tint = if (sendEnabled) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.38f),
                                        size = 22.dp, activation = composerActivation,
                                    )

                                else ->
                                    OrbisMotionIcon(
                                        Icons.Rounded.Send,
                                        description = L10n.tr("发送"),
                                        tint = if (sendEnabled) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.38f),
                                        size = 22.dp, activation = composerActivation,
                                    )
                            }
                        }
                    }
                }
            }
        }
        },
        floatingActionButton = {
            AnimatedVisibility(visible = initialPositioned && !following && distanceToBottom > lineHeightPx * 3) {
                // 回到最新是可交互控件：凸起圆钮（平铺 FAB 会变成一块无影的染色圆）。
                NeumorphIconButton(
                    onClick = {
                        scope.launch {
                            val lastIndex = listState.layoutInfo.totalItemsCount - 1
                            if (lastIndex >= 0) {
                                userScrolling = false
                                hasBrowsed = false
                                suppressQuestionPaging = false
                                following = true
                                listState.animateScrollToItem(lastIndex, Int.MAX_VALUE)
                            }
                        }
                    },
                    icon = Icons.Rounded.KeyboardArrowDown,
                    contentDescription = L10n.tr("回到最新消息"),
                    size = 44.dp,
                )
            }
        },
    ) { padding ->
        Box(Modifier.fillMaxSize().padding(padding)) {
        Box(Modifier.fillMaxSize()) {
            LazyColumn(
                state = listState,
                modifier = Modifier.fillMaxSize().nestedScroll(scrollIntent).testTag("chat-transcript")
                    .onGloballyPositioned { sendFlight.viewport = it.boundsInWindow() },
                contentPadding = PaddingValues(horizontal = 16.dp, vertical = 16.dp),
                // 轮次间距 24，组内间距由 AssistantTurnCard 提供。
                verticalArrangement = Arrangement.spacedBy(24.dp),
            ) {
                item(key = "chat-status") {
                    val errors = listOfNotNull(
                        if (runtime == null && launch == null) L10n.tr("会话已离线") else null,
                        historyPagingFeedback, historyActionError, historyRead?.takeIf { it.phase == HistoryReadPhase.FAILED }?.error,
                        firstReadError, rangeError, state.sessionSyncFailures[runtimeId] ?: conversation.chatSyncError,
                        if (conversation.waitingLocalInteraction) L10n.tr("请在电脑端完成交互") else null,
                        conversation.interactionNotice, conversation.systemNotice,
                    ).distinct()
                    var detailsOpen by remember { mutableStateOf(false) }
                    Row(Modifier.fillMaxWidth().height(48.dp), verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Box(Modifier.size(24.dp), contentAlignment = Alignment.Center) {
                            if (displayReadPending || historyRead?.phase?.active == true)
                                CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp)
                        }
                        when {
                            errors.isNotEmpty() -> NeumorphTextButton(errors.first(), { detailsOpen = true }, Modifier.weight(1f))
                            historyState?.hasOlder == true -> NeumorphTextButton(L10n.tr("更早的消息"), { loadHistoryPage() },
                                Modifier.weight(1f), enabled = historyRead?.phase?.active != true)
                            else -> Spacer(Modifier.weight(1f))
                        }
                        if (truncatedContent != null) NeumorphTextButton(L10n.tr("完整内容"), {
                            model.requestFullEntry(runtimeId, truncatedContent.first)
                            detailsOpen = true
                        })
                    }
                    if (detailsOpen) AlertDialog(onDismissRequest = { detailsOpen = false },
                        title = { Text(if (errors.isEmpty()) L10n.tr("完整内容") else L10n.tr("会话状态")) },
                        text = {
                            val full = truncatedContent?.let { state.fullEntries[it.first] }?.let(::fullEntryText)
                            Box(Modifier.heightIn(max = 360.dp).verticalScroll(rememberScrollState())) {
                                SelectionContainer { Text(full ?: errors.joinToString("\n").ifEmpty { L10n.tr("正在读取…") }) }
                            }
                        },
                        confirmButton = { NeumorphTextButton(L10n.tr("关闭"), { detailsOpen = false }) },
                        dismissButton = { if (errors.isNotEmpty()) NeumorphTextButton(L10n.tr("重试"), {
                            detailsOpen = false
                            if (historyRead?.phase == HistoryReadPhase.FAILED) loadHistoryPage()
                            else model.refreshRuntime(runtimeId, explicitRetry = true)
                        }) })
                }
                items(chatItems, key = ChatListItem::key) { item ->
                    when (item) {
                        is ChatListItem.UserMessage -> UserMessageCard(
                            runtimeId = runtimeId,
                            message = item.message,
                            pending = state.pendingSends[item.message.messageId]?.state,
                            uploads = state.pendingSends[item.message.messageId]?.uploadIds.orEmpty().mapNotNull(state.uploads::get),
                            canResend = state.e2eReady && runtime != null,
                            onPendingAction = { action ->
                                when (action) {
                                    PendingSendAction.Resend -> model.resendPendingSend(item.message.messageId)?.let { animateSend(it); actionHaptic() }
                                    PendingSendAction.Restore -> {
                                        // 附件没传成：正文和附件都回到输入框（ADR-0049 §6.1）。
                                        val uploads = model.uploadsOf(item.message.messageId)
                                        model.restorePendingSend(item.message.messageId)?.let { text ->
                                            input = if (input.isBlank()) text else input + "\n" + text
                                            if (uploads.isNotEmpty()) updateAttachedTaskIds(attachedTaskIds + uploads)
                                        }
                                    }
                                    PendingSendAction.Discard -> model.discardPendingSend(item.message.messageId)
                                    PendingSendAction.Check -> model.refreshRuntime(explicitRetry = true)
                                    PendingSendAction.Cancel -> model.cancelQueuedMessage(item.message.messageId)
                                }
                            },
                            downloads = state.downloads,
                            downloadArtifact = { artifact -> if (model.downloadArtifact(artifact)) chatFlight.launch() },
                            downloadFile = { path -> if (model.downloadFile(path)) chatFlight.launch() },
                            onRewind = rewindOptions[item.message.messageId]?.let { option ->
                                { runHistoryAction(HistoryTreeAction.EditAndRestart(option.value, item.message.content.mapNotNull { it.text }.joinToString("\n"))) }
                            },
                            rewindEnabled = state.e2eReady && runtime?.status == "idle" && historyActionCommandId == null,
                        )

                        is ChatListItem.AssistantTurn -> AssistantTurnCard(
                            cardId = item.key,
                            runtimeId = runtimeId,
                            messages = item.messages,
                            copyMessages = item.copyMessages,
                            turnTiming = groupTurnTiming(item.completedMessageIds.mapNotNull { messageTurnTimings[it] }),
                            nowMs = if (item.completedMessageIds.mapNotNull { messageTurnTimings[it] }.any { it.durationMs == null }) timerNow else 0L,
                            streamingMessageIds = if (state.e2eReady && conversation.sourceReady && !conversation.isChatSyncing)
                                conversation.streamingMessageIds - conversation.finishedMessageIds else emptySet(),
                            replyArrivals = replyArrivals,
                            toolActivities = conversation.tools,
                            toolResults = presentation.toolResults,
                            downloads = state.downloads,
                            downloadArtifact = { artifact -> if (model.downloadArtifact(artifact)) chatFlight.launch() },
                            downloadFile = { path -> if (model.downloadFile(path)) chatFlight.launch() },
                            fileChanges = {
                                // A source split across visual steps owns its review only at its last fragment.
                                val ids = item.completedMessageIds
                                val turns = ids.mapNotNull(turnIdsByMessageId::get).toSet()
                                val changes = state.turnChanges[runtimeId]
                                changes?.summaries?.values?.filter { summary ->
                                    if (summary.anchorEntryId != null) summary.anchorEntryId in ids
                                    else summary.reviewTurnId in turns || summary.sourceTurnIds.lastOrNull() in turns
                                }?.sortedBy { it.startedAt }?.forEach { summary ->
                                    key(summary.changeSetId) {
                                        TurnChangeSummaryView(summary, changes.manifests[summary.versionKey] ?: ChangeManifest(summary),
                                            state.connection == RelayConnection.ONLINE,
                                            onReadManifest = { model.readChangeManifest(runtimeId, summary) },
                                            onOpenFile = { model.openChangeViewer(runtimeId, summary, it) })
                                    }
                                }
                            },
                        )
                    }
                }
                items(orphanTools, key = ToolActivity::toolCallId) { tool -> ToolCard(tool) }
            }
            // 通知与待处理交互都浮在正文上：出现、消失都不移动阅读位置，也不推动输入框（与 iOS 一致）。
            val notices = state.visibleNotificationProjection(runtimeId)?.takeIf { it.sessionId == sessionId }
            val noticesSupported = runtime?.agentKind in setOf("codex", "codexDesktop")
            val hasNotices = notices != null && (notices.items.isNotEmpty() || (noticesSupported && !notices.complete))
            val questionGap = with(LocalDensity.current) { 8.dp.toPx() }
            val questionOutsideViewport by remember(listState, latestQuestion, questionGap) {
                derivedStateOf {
                    val layout = listState.layoutInfo
                    val row = layout.visibleItemsInfo.firstOrNull { it.key == latestQuestion?.messageId }
                    latestQuestion != null && layout.visibleItemsInfo.isNotEmpty() &&
                        (row == null || row.offset + row.size < layout.viewportStartOffset - questionGap ||
                            row.offset > layout.viewportEndOffset + questionGap)
                }
            }
            // An overlay leaves list measurements and reading anchors unchanged. Notices own this slot first.
            AnimatedChatQuestionReminder(
                question = latestQuestion,
                visible = !hasNotices && initialPositioned && hasBrowsed && lastScrollTowardEarlier && !following && distanceToBottom > lineHeightPx * 3 && questionOutsideViewport,
                modifier = Modifier.align(Alignment.TopCenter).padding(horizontal = 16.dp, vertical = 6.dp),
                onClick = { question ->
                        val index = chatItems.indexOfFirst { it.key == question.messageId }
                        if (index >= 0) {
                            userScrolling = false
                            following = false
                            suppressQuestionPaging = true
                            viewportMotion.moved()
                            scope.launch { listState.animateScrollToItem(chatHeaderCount + index) }
                        }
                },
            )
            launch?.takeIf { it.failure != null || it.unconfirmed }?.let { failed ->
                Box(Modifier.align(Alignment.TopCenter)) {
                    LaunchNotice(failed, onRetry = model::retryLaunch, onBack = { model.selectRuntime(null) })
                }
            }
            state.visibleNotificationProjection(runtimeId)?.takeIf { it.sessionId == sessionId }?.let { projection ->
                Box(Modifier.align(Alignment.TopCenter)) {
                    RuntimeNotifications(projection, state.notificationEpoch,
                        supported = state.runtimes[runtimeId]?.agentKind in setOf("codex", "codexDesktop"),
                        onRecheck = { model.syncNotifications(runtimeId) }) { model.dismissNotification(runtimeId, it) }
                }
            }
            androidx.compose.runtime.key(runtimeId, sessionId) {
                Box(Modifier.align(Alignment.BottomCenter)) {
                    InteractionWorkspace(
                        requests = conversation.interactions.values.toList(), connected = state.e2eReady && runtime != null,
                        pendingCommands = state.pendingCommands.keys, error = null,
                        respondConfirm = { request, approved ->
                            if (model.respondConfirm(request, approved) == true) actionHaptic()
                        },
                        respondValue = { request, value ->
                            if (model.respondValue(request, value) == true) actionHaptic()
                        },
                        respondValues = { request, values ->
                            if (model.respondValues(request, values) == true) actionHaptic()
                        },
                        respondQuestionnaire = { request, answers ->
                            if (model.respondQuestionnaire(request, answers) == true && answers != null) actionHaptic()
                        },
                        onCancel = model::cancelInteraction,
                        responding = OperationKinds.respondingRequestIds(state.ledger, runtimeId),
                        status = state.interactionStatus(runtimeId),
                    )
                }
            }
        }
        commandFeedback?.let { feedback ->
            Text(feedback, Modifier.align(Alignment.BottomCenter).padding(12.dp)
                .background(rememberNeumorphColors().layer(2), RemoteUi.ControlShape).padding(12.dp),
                style = MaterialTheme.typography.bodySmall, maxLines = 2, overflow = TextOverflow.Ellipsis)
        }
        }
    }
        } } },
    ) { HostDownloadsScreen(state, model, onBack = { downloadManagerOpen = false }) }
        },
        content = historyPage,
    )

}

/** 会话元信息行共用的左侧槽宽：顶部信息块的图标与状态点都从这里起笔，文字才会落在同一条左基准线上。 */
private val MetaLineLeadingSlot = 20.dp

/** 顶部元信息行里图形与文字之间的间距。 */
private val MetaLineGap = 6.dp

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
        SlashOptionList(options = options, localizeDescription = selected.source == "builtin") { option ->
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
                contentInset = 12.dp,
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
                        // 内置命令属于当前 agent，不再逐项写 agent 名；只标出扩展、模板等其他来源（与 iOS 一致）。
                        if (command.source != "builtin") Text(slashSourceText(command.source, isCodex), color = MaterialTheme.colorScheme.primary)
                    }
                    command.description?.let {
                        val description = if (command.source == "builtin") L10n.hostText(it) else it
                        Text(
                            if (command.argument?.hint == null) description else "$description ${command.argument.hint}",
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
    localizeDescription: Boolean = false,
    onSelect: (RuntimeSlashCommandOption) -> Unit,
) {
    if (options.isEmpty()) {
        Text(
            L10n.tr("当前 {0} 没有匹配的可选项", LocalAgentBrand.current.title),
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
                contentInset = 12.dp,
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
                            if (localizeDescription) L10n.hostText(it) else it,
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
    return if (detail == null) L10n.tr("/{0} 已完成", name) else L10n.tr("/{0} 已完成：{1}", name, detail)
}

private fun slashCommandError(input: String, result: CommandResult): String {
    val name = parseSlashInvocation(input)?.first ?: "command"
    val detail = result.error?.takeIf { it.isNotBlank() } ?: when (result.status) {
        "cancelled" -> L10n.tr("请求已取消")
        "failure" -> L10n.tr("电脑端执行失败")
        else -> result.status
    }
    return L10n.tr("/{0} 失败：{1}", name, detail)
}

/**
 * 命令来源徽标。`builtin` 在 Pi 与 Codex 下都出现，但含义不同：
 * Pi 的是本体会话命令，Codex 的是 app-server RPC——按后端给不同文案，
 * 免得 Codex 会话里点 `/model` 看到 "Pi" 徽标以为连错了电脑。
 */
internal fun slashSourceText(source: String, isCodex: Boolean = false): String = when (source) {
    "builtin" -> if (isCodex) "Codex" else "Pi"
    "extension" -> L10n.tr("扩展")
    "prompt" -> L10n.tr("模板")
    "skill" -> "Skill"
    else -> source
}

@Composable
internal fun DownloadStatusButton(
    activeCount: Int,
    enabled: Boolean,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Box(modifier) {
        // S6：顶栏图标按钮是凸起圆钮。
        NeumorphIconButton(
            onClick = onClick,
            icon = Icons.Rounded.Download,
            contentDescription = if (activeCount > 0) L10n.tr("{0} 个文件正在下载", activeCount) else L10n.tr("打开下载"),
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
    var selectedTaskIds by remember(state.hostId) { mutableStateOf<Set<String>>(emptySet()) }
    val selectionHaptic = LocalHapticFeedback.current
    var pendingDeletion by remember(state.hostId) { mutableStateOf<Set<String>>(emptySet()) }
    val downloads = state.downloads.values.sortedByDescending(ArtifactDownload::createdAt)
    val visibleTaskIds = downloads.mapTo(mutableSetOf(), ArtifactDownload::taskId)
    val effectiveSelectedTaskIds = selectedTaskIds.intersect(visibleTaskIds)
    val selectionMode = effectiveSelectedTaskIds.isNotEmpty()
    LaunchedEffect(visibleTaskIds) { selectedTaskIds = selectedTaskIds.intersect(visibleTaskIds) }
    SelectionBackPriority(selectionMode) { selectedTaskIds = emptySet() }
    Scaffold(
        topBar = {
            TopAppBar(
                // 进行中的任务各自显示进度；标题不再重复一行「0 个任务进行中」（与 iOS 一致）。
                title = {
                    Text(
                        if (selectionMode) L10n.tr("已选择 {0} 项", effectiveSelectedTaskIds.size) else L10n.tr("下载"),
                        fontWeight = FontWeight.SemiBold,
                    )
                },
                navigationIcon = {
                    NeumorphIconButton(
                        onClick = { if (selectionMode) selectedTaskIds = emptySet() else onBack() },
                        icon = if (selectionMode) Icons.Rounded.Close else Icons.Rounded.ArrowBack,
                        backMorph = selectionMode,
                        contentDescription = if (selectionMode) L10n.tr("退出多选") else L10n.tr("返回"),
                        size = 40.dp,
                    )
                },
                actions = {
                    SelectionToolbar(selecting = selectionMode, normal = { Spacer(Modifier.size(48.dp)) }, selected = {
                        NeumorphIconButton(
                            onClick = { pendingDeletion = effectiveSelectedTaskIds },
                            icon = Icons.Rounded.Delete,
                            tint = MaterialTheme.colorScheme.error,
                            contentDescription = L10n.tr("删除所选下载"),
                            size = 40.dp,
                        )
                    })
                },
            )
        },
    ) { padding ->
        Column(Modifier.fillMaxSize().padding(padding)) {
            NeumorphActionButton(
                text = L10n.tr("浏览电脑文件"),
                icon = Icons.Rounded.Folder,
                onClick = { onDismissBrowse(); filePickerOpen = true },
                modifier = Modifier.fillMaxWidth().padding(horizontal = RemoteUi.PagePadding).padding(top = 12.dp, bottom = 20.dp),
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
                    Text(L10n.tr("暂无下载"), color = MaterialTheme.colorScheme.onSurfaceVariant)
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
                            onRetry = { taskId -> onRetry(taskId) },
                            onCancel = onCancel,
                            connected = state.e2eReady,
                            selected = task.taskId in effectiveSelectedTaskIds,
                            selectionMode = selectionMode,
                            onClick = {
                                selectionHaptic.performHapticFeedback(HapticFeedbackType.TextHandleMove)
                                selectedTaskIds = if (task.taskId in selectedTaskIds) {
                                    selectedTaskIds - task.taskId
                                } else {
                                    selectedTaskIds + task.taskId
                                }
                            },
                            onLongClick = {
                                if (task.taskId !in selectedTaskIds) selectionHaptic.performHapticFeedback(HapticFeedbackType.TextHandleMove)
                                selectedTaskIds = selectedTaskIds + task.taskId
                            },
                        )
                    }
                }
            }
        }
    }
    if (pendingDeletion.isNotEmpty()) {
        val ids = pendingDeletion.intersect(visibleTaskIds)
        AlertDialog(
            onDismissRequest = { pendingDeletion = emptySet() },
            title = { Text(L10n.tr("删除下载记录与本机文件？")) },
            text = { Text(L10n.tr("电脑上的原文件不受影响。")) },
            confirmButton = {
                TextButton(enabled = ids.isNotEmpty(), onClick = {
                    onDelete(ids)
                    selectedTaskIds = selectedTaskIds - ids
                    pendingDeletion = emptySet()
                }) { Text(L10n.tr("删除 {0} 项", ids.size), color = MaterialTheme.colorScheme.error) }
            },
            dismissButton = { TextButton(onClick = { pendingDeletion = emptySet() }) { Text(L10n.tr("取消")) } },
        )
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

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun DownloadTaskCard(
    task: ArtifactDownload,
    onRetry: (String) -> Unit,
    onCancel: (String) -> Unit = {},
    connected: Boolean = true,
    selected: Boolean = false,
    selectionMode: Boolean = false,
    onClick: () -> Unit = {},
    onLongClick: () -> Unit = {},
) {
    val total = task.artifact?.size
    val progress = total?.takeIf { it > 0 }?.let { (task.receivedBytes.toFloat() / it).coerceIn(0f, 1f) }
    val active = task.status == "queued" || task.status == "downloading"
    // 重试不看 runtime 在不在：文件在电脑磁盘上，Host 会直接读盘发分片（spec §8.1）。
    val canRetry = !active && task.status != "completed" &&
        (task.sourcePath != null || task.sourceArtifactId != null)
    val actionHint = when {
        !active && !canRetry -> null
        active -> L10n.tr("轻点暂停")
        !connected -> L10n.tr("连接电脑后继续")
        task.status == "failed" -> L10n.tr("轻点重试")
        else -> L10n.tr("轻点继续")
    }
    val statusColor = when (task.status) {
        "completed" -> MaterialTheme.colorScheme.tertiary
        "failed" -> MaterialTheme.colorScheme.error
        "paused", "cancelled" -> MaterialTheme.colorScheme.secondary
        else -> MaterialTheme.colorScheme.primary
    }
    NeumorphSurface(
        modifier = Modifier.fillMaxWidth().testTag("download-card-${task.taskId}")
            .semantics { this.selected = selected },
        onClick = {
            when {
                selectionMode -> onClick()
                active -> onCancel(task.taskId)
                canRetry && connected -> onRetry(task.taskId)
            }
        },
        onLongClick = onLongClick,
        shape = RemoteUi.CardShape,
        selectionSelected = selected,
        selectionMode = selectionMode,
        contentInset = 16.dp,
    ) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
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
                    FileNameText(task.displayName, fontWeight = FontWeight.SemiBold)
                    // Keep the normal caption's measured height while hiding its action hint.
                    Box {
                        Text(
                            listOfNotNull(downloadStatusText(task), actionHint).joinToString(" · "),
                            modifier = Modifier.alpha(if (selectionMode) 0f else 1f)
                                .then(if (selectionMode) Modifier.clearAndSetSemantics {} else Modifier),
                            style = MaterialTheme.typography.bodySmall, color = statusColor,
                        )
                        if (selectionMode) Text(downloadStatusText(task),
                            style = MaterialTheme.typography.bodySmall, color = statusColor)
                    }
                }
                OrbisSelectionIndicator(selected, selectionMode)
            }
            if (active || task.status in setOf("paused", "cancelled", "failed")) {
                if (progress == null && active) LinearProgressIndicator(Modifier.fillMaxWidth())
                else LinearProgressIndicator(progress = { progress ?: 0f }, modifier = Modifier.fillMaxWidth(), color = statusColor)
            }
            val source = task.sourcePath
            if (source != null) {
                Text(source, style = MaterialTheme.typography.bodySmall, fontFamily = FontFamily.Monospace, maxLines = 2, overflow = TextOverflow.Ellipsis)
            }
            task.savedLocation?.let { location ->
                Text(
                    L10n.tr("保存到：{0}", savedLocationText(task, location)),
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
    if (location.startsWith("content://")) L10n.tr("手机系统“下载”目录，{0}", task.displayName) else location

private fun downloadStatusText(task: ArtifactDownload): String = when (task.status) {
    "queued" -> L10n.tr("正在请求文件")
    "downloading" -> task.artifact?.size?.let { size ->
        "${formatByteCount(task.receivedBytes)} / ${formatByteCount(size)}"
    } ?: L10n.tr("正在下载")
    "completed" -> L10n.tr("下载完成")
    "paused" -> L10n.tr("已暂停，{0}", formatByteCount(task.receivedBytes))
    // User-stopped transfers keep their partial file and only resume on an explicit tap.
    "cancelled" -> L10n.tr("已暂停，{0}", formatByteCount(task.receivedBytes))
    "failed" -> L10n.tr("下载失败，{0}", formatByteCount(task.receivedBytes))
    else -> task.status
}

/** 主页的电脑行：当前电脑；配对了多台时点开即可切换或添加（与 iOS 主页、抽屉页脚同一套选项）。 */
@Composable
private fun HomeHostSwitcher(
    hosts: List<HostSnapshot>,
    activeHostId: String?,
    onSelectHost: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    val name = hosts.firstOrNull { it.hostId == activeHostId }?.name ?: L10n.tr("选择电脑")
    var expanded by remember { mutableStateOf(false) }
    val label: @Composable () -> Unit = {
        Row(
            Modifier.heightIn(min = 40.dp).padding(horizontal = if (hosts.size > 1) 12.dp else 4.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Icon(Icons.Rounded.Computer, contentDescription = null, tint = MaterialTheme.colorScheme.primary, modifier = Modifier.size(18.dp))
            Text(name, style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold, maxLines = 1,
                overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
            // 其他电脑上有待确认：列表只显示当前电脑后，这里提醒去切换（菜单里写明是哪台）。
            if (hosts.any { it.hostId != activeHostId && it.state.hasAnyPendingInteraction() }) {
                Box(Modifier.size(7.dp).clip(CircleShape).background(MaterialTheme.colorScheme.error)
                    .semantics { contentDescription = L10n.tr("其他电脑有待确认") })
            }
            if (hosts.size > 1) Icon(Icons.Rounded.UnfoldMore, contentDescription = L10n.tr("切换电脑"), modifier = Modifier.size(16.dp),
                tint = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
    Box(modifier, contentAlignment = Alignment.CenterStart) {
        if (hosts.size > 1) {
            NeumorphSurface(shape = RemoteUi.ControlShape, shadowScale = 0.6f, onClick = { expanded = true }) { label() }
        } else label()
        DropdownMenu(expanded = expanded, onDismissRequest = { expanded = false }) {
            hosts.forEach { host ->
                DropdownMenuItem(
                    text = { Text(host.name + if (host.state.hasAnyPendingInteraction()) L10n.tr("，有待确认") else "", maxLines = 1, overflow = TextOverflow.Ellipsis) },
                    onClick = { expanded = false; if (host.hostId != activeHostId) onSelectHost(host.hostId) },
                    leadingIcon = {
                        if (host.hostId == activeHostId) Icon(Icons.Rounded.Check, contentDescription = L10n.tr("当前电脑"), tint = MaterialTheme.colorScheme.primary, modifier = Modifier.size(18.dp))
                        else Icon(Icons.Rounded.Computer, contentDescription = null, modifier = Modifier.size(18.dp))
                    },
                    trailingIcon = {
                        Text(if (host.state.e2eReady) L10n.tr("在线") else L10n.tr("离线"), style = MaterialTheme.typography.labelSmall,
                            color = if (host.state.e2eReady) MaterialTheme.colorScheme.tertiary else MaterialTheme.colorScheme.onSurfaceVariant)
                    },
                )
            }
        }
    }
}

/** One capsule tells the computer's whole lifecycle: connecting, securing, syncing, then the transport path. */
@Composable
private fun ConnectionStatus(
    connection: RelayConnection,
    e2eReady: Boolean,
    path: String? = null,
    sync: HomeSyncStatus = HomeSyncStatus.Idle,
) {
    val secured = connection == RelayConnection.ONLINE && e2eReady
    val syncing = secured && sync == HomeSyncStatus.Syncing
    val failed = secured && sync is HomeSyncStatus.Failed
    // 握手中也算「忙」：中继认了、加密通道没成时，这段时间是能恢复的，不该显示成稳态。
    val isBusy = connection == RelayConnection.CONNECTING ||
        connection == RelayConnection.RECONNECTING ||
        (connection == RelayConnection.ONLINE && !e2eReady) || syncing
    val securedColor = MaterialTheme.colorScheme.tertiary
    val color = when {
        failed -> MaterialTheme.colorScheme.error
        secured -> securedColor
        connection == RelayConnection.RECONNECTING -> MaterialTheme.colorScheme.error
        connection == RelayConnection.ONLINE -> MaterialTheme.colorScheme.error
        else -> MaterialTheme.colorScheme.onSurfaceVariant
    }
    // 加密通道建立后先说同步进度，再说连接方式；之前说连接阶段；颜色始终表达状态（与 iOS 一致）。
    val label = when {
        syncing -> L10n.tr("正在同步")
        failed -> L10n.tr("同步失败")
        secured -> transportPathLabel(path) ?: L10n.tr("中继")
        connection == RelayConnection.ONLINE -> L10n.tr("正在建立安全通道")
        else -> relayConnectionText(connection)
    }
    NeumorphSurface(
        modifier = Modifier.padding(vertical = 8.dp),
        style = NeumorphStyle.Pressed,
        shape = CircleShape,
        shadowScale = 0.3f,
    ) {
    Row(
        modifier = Modifier.animateContentSize(tween(160)).padding(horizontal = 12.dp, vertical = 8.dp),
        horizontalArrangement = Arrangement.spacedBy(6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(Modifier.size(12.dp), contentAlignment = Alignment.Center) {
            if (isBusy) {
                CircularProgressIndicator(Modifier.size(12.dp), strokeWidth = 2.dp, color = color)
            } else {
                Box(Modifier.size(8.dp).clip(CircleShape).background(color))
            }
        }
        MotionText(label, color = color, style = MaterialTheme.typography.labelMedium)
        if (secured) {
            // 同步失败不影响加密：锁保持已加密的颜色，不把失败画成通道不安全。
            Icon(Icons.Rounded.Lock, contentDescription = L10n.tr("端到端加密"), tint = securedColor, modifier = Modifier.size(13.dp))
        }
    }
}

}

/** 设置页（原连接状态页，ADR-0046 §5）：供应商在最上方，其后是当前连接与只读的配对信息。 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun StatusScreen(
    state: RemoteState,
    model: RemoteViewModel,
    pairing: PairingStatus,
    onBack: () -> Unit,
) {
    LaunchedEffect(state.hostId, state.e2eReady) { if (state.e2eReady) model.refreshHostModel(listOf("providers"), force = true) }
    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(L10n.tr("设置"), fontWeight = FontWeight.SemiBold) },
                navigationIcon = {
                    NeumorphIconButton(
                        onClick = onBack,
                        icon = Icons.Rounded.ArrowBack,
                        contentDescription = L10n.tr("返回"),
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
            StatusSectionTitle(L10n.tr("Agent 供应商"))
            AgentStatusProvidersCard(state, model::switchAgentProvider, model::querySubscription)

            statusAdvice(state, pairing)?.let { WarningCard(it) }
            StatusSectionTitle(L10n.tr("当前连接"))
            StatusCard {
                StatusRow(
                    L10n.tr("连接状态"),
                    connectionStatusText(state),
                    if (state.e2eReady) StatusTone.Good
                    else if (state.connection == RelayConnection.ONLINE) StatusTone.Warn
                    else relayConnectionTone(state.connection),
                )
                StatusRow(L10n.tr("连接方式"), connectionMethodText(state), connectionMethodTone(state))
                StatusRow(L10n.tr("连接延迟"), connectionLatencyText(state), StatusTone.Neutral)
                StatusRow(L10n.tr("端到端加密"), if (state.e2eReady) L10n.tr("已启用") else L10n.tr("未建立"), e2eTone(state))
            }

            StatusSectionTitle(L10n.tr("配对信息"))
            StatusCard {
                StatusValueRow(L10n.tr("电脑"), state.hostName?.takeIf(String::isNotBlank) ?: L10n.tr("已配对的电脑"))
                StatusRow(L10n.tr("配对状态"), pairingText(pairing), pairingTone(pairing))
            }

            StatusSectionTitle(L10n.tr("外观"))
            val visualStyle = LocalOrbisVisualStyle.current
            val changeVisualStyle = LocalOrbisVisualStyleChange.current
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                listOf(OrbisVisualStyle.Classic to L10n.tr("经典"), OrbisVisualStyle.InsetFocus to L10n.tr("雾蓝")).forEach { (choice, label) ->
                    val selected = visualStyle == choice
                    NeumorphSurface(
                        modifier = Modifier.weight(1f).heightIn(min = 56.dp).testTag("appearance-${choice.key}")
                            .semantics { this.selected = selected },
                        shape = RemoteUi.ControlShape,
                        style = if (selected) NeumorphStyle.Pressed else NeumorphStyle.Raised,
                        onClick = { changeVisualStyle(choice) },
                    ) {
                        Row(
                            Modifier.fillMaxWidth().heightIn(min = 56.dp).padding(horizontal = 8.dp),
                            horizontalArrangement = Arrangement.Center,
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            if (selected) {
                                Icon(Icons.Rounded.Check, contentDescription = null, tint = MaterialTheme.colorScheme.primary,
                                    modifier = Modifier.size(16.dp))
                                Spacer(Modifier.width(6.dp))
                            }
                            Text(label, color = if (selected) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant,
                                style = MaterialTheme.typography.labelLarge, maxLines = 1)
                        }
                    }
                }
            }
            StatusSectionTitle(L10n.tr("语言"))
            AppLanguage.entries.forEach { choice ->
                val selected = AppLocalization.preference == choice
                val label = when (choice) {
                    AppLanguage.System -> L10n.tr("跟随系统")
                    AppLanguage.Chinese -> "简体中文"
                    AppLanguage.English -> "English"
                }
                NeumorphSurface(
                    modifier = Modifier.fillMaxWidth().heightIn(min = 56.dp)
                        .testTag("language-${choice.key}").semantics { this.selected = selected },
                    shape = RemoteUi.ControlShape,
                    style = if (selected) NeumorphStyle.Pressed else NeumorphStyle.Raised,
                    onClick = { AppLocalization.select(choice) },
                ) {
                    Row(Modifier.fillMaxWidth().heightIn(min = 56.dp).padding(horizontal = 16.dp, vertical = 12.dp),
                        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                        Text(label, modifier = Modifier.weight(1f), style = MaterialTheme.typography.bodyMedium,
                            color = if (selected) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurface)
                        if (selected) Icon(Icons.Rounded.Check, contentDescription = null,
                            tint = MaterialTheme.colorScheme.primary, modifier = Modifier.size(22.dp))
                        else Spacer(Modifier.size(22.dp))
                    }
                }
            }
        }
    }
}


@Composable
private fun AgentProvidersScreen(state: RemoteState, model: RemoteViewModel, onBack: () -> Unit) {
    AgentProvidersContent(state, onBack, model::loadAgentProviders, model::switchAgentProvider, model::removeAgentProviders, model::querySubscription)
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun AgentProvidersContent(
    state: RemoteState,
    onBack: () -> Unit,
    onLoad: (String) -> Unit,
    onEnable: (AgentProvider, String?) -> Unit,
    onRemove: (List<AgentProvider>, String?) -> Unit,
    onQuerySubscription: (AgentProvider, String?) -> Unit = { _, _ -> },
) {
    val catalog = state.agentProviders
    var pending by remember(state.hostId, catalog.kind) { mutableStateOf<AgentProvider?>(null) }
    var pendingRemoval by remember(state.hostId, catalog.kind) { mutableStateOf<List<AgentProvider>?>(null) }
    var selectedProviders by remember(state.hostId, catalog.kind) { mutableStateOf<Set<AgentProvider>>(emptySet()) }
    var selecting by remember(state.hostId, catalog.kind) { mutableStateOf(false) }
    val removable = catalog.providers.filter { it.removable }.toSet()
    val selected = selectedProviders.intersect(removable)
    val connected = state.e2eReady && state.connection == RelayConnection.ONLINE && catalog.hostId == state.hostId
    val available = connected && !catalog.loading && catalog.quotaRequestId == null && catalog.error == null
    val haptic = LocalHapticFeedback.current
    fun exitSelection() { selecting = false; selectedProviders = emptySet(); pendingRemoval = null }
    fun toggle(provider: AgentProvider) {
        if (available && provider.removable) {
            haptic.performHapticFeedback(HapticFeedbackType.TextHandleMove)
            selectedProviders = if (provider in selected) selected - provider else selected + provider
        }
    }
    LaunchedEffect(connected, removable) {
        selectedProviders = selected
        if (!connected || removable.isEmpty()) exitSelection()
        if (!connected) pending = null
    }
    SelectionBackPriority(selecting) { exitSelection() }
    Scaffold(topBar = {
        TopAppBar(title = { MotionText(if (selecting) L10n.tr("已选择 {0} 项", selected.size) else L10n.tr("供应商")) }, navigationIcon = {
            NeumorphIconButton(onClick = { if (selecting) exitSelection() else onBack() },
                icon = if (selecting) Icons.Rounded.Close else Icons.Rounded.ArrowBack,
                backMorph = selecting,
                contentDescription = if (selecting) L10n.tr("退出多选") else L10n.tr("返回"), size = 40.dp)
        }, actions = {
            SelectionToolbar(selecting = selecting, normal = {
                NeumorphIconButton(onClick = { exitSelection(); onLoad(catalog.kind) },
                    icon = Icons.Rounded.Refresh, contentDescription = L10n.tr("刷新"), enabled = connected && !catalog.loading)
            }, selected = {
                NeumorphIconButton(onClick = { pendingRemoval = catalog.providers.filter { it in selected } },
                    icon = Icons.Rounded.Delete, contentDescription = L10n.tr("移除所选供应商"), size = 40.dp, tint = MaterialTheme.colorScheme.error,
                    enabled = available && selected.isNotEmpty())
            })
        })
    }) { padding ->
        Column(Modifier.fillMaxSize().padding(padding).verticalScroll(rememberScrollState()).padding(20.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
            Text(state.hostName ?: L10n.tr("已配对的电脑"), style = MaterialTheme.typography.titleMedium)
            Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                listOf("pi" to "Pi", "codex" to "Codex", "claude" to "Claude Code", "dsh" to "DeepSeek").forEach { (kind, label) ->
                    FilterChip(selected = catalog.kind == kind, onClick = { exitSelection(); pending = null; onLoad(kind) },
                        label = { Text(label) }, enabled = !catalog.loading)
                }
            }
            if (catalog.loading) LinearProgressIndicator(Modifier.fillMaxWidth())
            catalog.error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
            catalog.notice?.let { Text(it, color = MaterialTheme.colorScheme.primary) }
            if (!catalog.loading && catalog.error == null && catalog.providers.isEmpty()) Text(L10n.tr("还没有供应商"))
            if (removable.isNotEmpty()) Text(if (selecting) L10n.tr("轻点卡片选择，完成后点击右上角移除") else L10n.tr("长按已启用的供应商可多选移除"), maxLines = 1, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant)
            catalog.providers.forEach { provider ->
                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                    NeumorphSurface(Modifier.weight(1f).testTag("provider-card-${provider.id}")
                        .semantics { this.selected = provider in selected }, shape = RemoteUi.CardShape, contentPadding = 16.dp,
                        selectionSelected = provider in selected, selectionMode = selecting,
                        enabled = available && provider.removable,
                        onClick = { if (selecting) toggle(provider) },
                        onLongClick = {
                            if (available && provider.removable) {
                                if (provider !in selected) haptic.performHapticFeedback(HapticFeedbackType.TextHandleMove)
                                selecting = true; selectedProviders = selected + provider
                            }
                        }) {
                        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                                Text(provider.name, fontWeight = FontWeight.SemiBold)
                                Text(if (provider.enabled) (if (provider.additive) L10n.tr("已启用") else L10n.tr("当前使用")) else L10n.tr("未启用"), style = MaterialTheme.typography.bodySmall)
                            }
                            OrbisSelectionIndicator(provider in selected, selecting && provider.removable)
                        }
                    }
                    if (!provider.enabled) {
                        Box(Modifier.width(64.dp).heightIn(min = RemoteUi.TouchTarget), contentAlignment = Alignment.Center) {
                            NeumorphTextButton(text = L10n.tr("启用"), onClick = { pending = provider }, enabled = available && !selecting)
                        }
                    }
                }
                if (provider.enabled && provider.subscriptionSupported) {
                    TextButton(onClick = { onQuerySubscription(provider, catalog.hostId) }, enabled = available && !selecting,
                        modifier = Modifier.testTag("provider-quota-${provider.id}")) {
                        Text(if (catalog.quotaRequestId != null && catalog.quotaProviderId == provider.id) L10n.tr("查询中…") else L10n.tr("查询订阅配额"))
                    }
                    if (catalog.quotaProviderId == provider.id) {
                        catalog.quotaError?.let { Text(it, color = MaterialTheme.colorScheme.error) }
                        catalog.quota?.let { quota ->
                            val dateFormat = java.text.DateFormat.getDateTimeInstance(java.text.DateFormat.MEDIUM, java.text.DateFormat.SHORT, L10n.locale)
                            quota.windows.forEach { window ->
                                val label = if (window.name == "five_hour") L10n.tr("5 小时配额") else L10n.tr("周配额")
                                Text(label + L10n.tr("：") + (window.remainingPercent?.let { L10n.tr("剩余 ") + String.format(L10n.locale, "%.1f", it) + "%" } ?: L10n.tr("暂不可用")))
                                window.remainingPercent?.let { remaining -> LinearProgressIndicator(progress = { (remaining / 100).toFloat() }, modifier = Modifier.fillMaxWidth()) }
                                window.resetsAt?.let { Text(L10n.tr("重置时间：") + dateFormat.format(java.util.Date(it)), style = MaterialTheme.typography.bodySmall) }
                            }
                            Text(L10n.tr("查询时间：") + dateFormat.format(java.util.Date(quota.checkedAt)), style = MaterialTheme.typography.bodySmall)
                        }
                    }
                }
            }
        }
    }
    pending?.let { provider ->
        AlertDialog(onDismissRequest = { pending = null }, title = { Text(L10n.tr("启用供应商")) },
            text = { Text("${provider.name}\n${if (provider.additive) L10n.tr("添加到 Pi 配置，可与其他供应商同时启用。") else L10n.tr("将切换 Host 配置，并重新加载后台 Agent。已有会话需要重新打开。")}") },
            confirmButton = { TextButton(enabled = available && provider in catalog.providers, onClick = { onEnable(provider, catalog.hostId); pending = null }) { Text(L10n.tr("确认")) } },
            dismissButton = { TextButton(onClick = { pending = null }) { Text(L10n.tr("取消")) } })
    }
    pendingRemoval?.let { providers ->
        AlertDialog(onDismissRequest = { pendingRemoval = null }, title = { Text(L10n.tr("移除 {0} 个供应商？", providers.size)) },
            text = { Text(providers.joinToString("\n") { it.name } + L10n.tr("\n从 Pi 配置移除；Host 中的卡片和配置仍保留。") +
                if (providers.any { it.globalDefault }) L10n.tr("\n包含 Pi 的全局默认供应商，移除后请在 Pi 中重新选择模型。") else "") },
            confirmButton = { TextButton(enabled = available && catalog.canRemove(providers, state.hostId),
                onClick = { onRemove(providers, catalog.hostId); exitSelection() }) { Text(L10n.tr("移除 {0} 项", providers.size), color = MaterialTheme.colorScheme.error) } },
            dismissButton = { TextButton(onClick = { pendingRemoval = null }) { Text(L10n.tr("取消")) } })
    }
}

/**
 * 只在控制链底座不健康时给下一步。优先说配对不完整：那是最容易被误当成「网络问题」的一种，
 * 因为手机确实连上了中继，只是永远没有加密通道。
 */
internal fun statusAdvice(state: RemoteState, pairing: PairingStatus): String? = when {
    pairing.hostId == null || !pairing.pskRootPresent ->
        L10n.tr("配对不完整：请打开侧边栏，点底部的电脑取消配对，再扫电脑上的新二维码")
    state.e2eReady -> null
    state.connection == RelayConnection.ONLINE ->
        L10n.tr("正在等待电脑连接：请确认电脑上的 Orbis Host 已打开，APP 会自动重连")
    state.connection == RelayConnection.OFFLINE -> L10n.tr("暂时无法连接电脑，请检查网络并确认电脑上的 Orbis Host 已打开")
    else -> null
}

internal fun transportPathLabel(path: String?): String? = when (path) {
    "lan" -> L10n.tr("局域网")
    "relay" -> L10n.tr("中继")
    else -> null
}

/**
 * 当前连接方式（spec §14 B4）。Host 没宣布路径时，出站默认走中继（RelayClient.activePath 的约定），
 * 所以在线时不能显示成「未知」——那会让人以为连接方式根本没取到。
 */
internal fun connectionMethodText(state: RemoteState): String =
    transportPathLabel(state.path)
        ?: if (state.connection == RelayConnection.ONLINE) L10n.tr("中继") else L10n.tr("尚未确认")

/** 局域网路径使用成功色，中继使用普通状态色。 */
internal fun connectionMethodTone(state: RemoteState): StatusTone = when (state.path) {
    "lan" -> StatusTone.Good
    else -> StatusTone.Neutral
}

internal fun connectionLatencyText(state: RemoteState): String =
    state.pathRttMs?.takeIf { state.e2eReady && it >= 0 }?.let { "$it ms" } ?: L10n.tr("暂不可用")

internal fun connectionStatusText(state: RemoteState): String = when {
    state.e2eReady -> L10n.tr("已连接")
    state.connection == RelayConnection.ONLINE -> L10n.tr("正在连接电脑")
    else -> relayConnectionText(state.connection)
}

private fun relayConnectionText(connection: RelayConnection): String = when (connection) {
    RelayConnection.OFFLINE -> L10n.tr("未连接")
    RelayConnection.CONNECTING -> L10n.tr("正在连接")
    RelayConnection.ONLINE -> L10n.tr("已连接")
    RelayConnection.RECONNECTING -> L10n.tr("正在重新连接")
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
    pairing.hostId == null -> L10n.tr("未配对")
    !pairing.pskRootPresent -> L10n.tr("需要重新配对")
    else -> L10n.tr("已配对")
}

/**
 * Codex 桌面版 app-server 的接入分档（ADR-0022）。
 *
 * Host 没下发（未启用 Codex、电脑离线、旧版本）时只能是「未知」：把未知说成未接入
 * 会让人去重开桌面版，而真正的问题在别处。
 */
internal fun codexDesktopText(attach: CodexDesktopAttach?): String = when (attach?.state) {
    "attached" -> L10n.tr("已接入")
    "closed" -> L10n.tr("未接入")
    "notInstalled" -> L10n.tr("未安装")
    "unsupported" -> L10n.tr("不可用")
    "error" -> L10n.tr("接入失败")
    else -> L10n.tr("未知")
}

internal fun codexDesktopTone(attach: CodexDesktopAttach?): StatusTone = when (attach?.state) {
    "attached" -> StatusTone.Good
    "closed" -> StatusTone.Warn
    "error" -> StatusTone.Bad
    else -> StatusTone.Neutral
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
        contentInset = 16.dp,
    ) {
        Column(Modifier.fillMaxWidth().padding(16.dp), content = content)
    }
}

@OptIn(androidx.compose.foundation.layout.ExperimentalLayoutApi::class)
@Composable
private fun StatusRow(label: String, value: String, tone: StatusTone) {
    val color = statusToneColor(tone)
    androidx.compose.foundation.layout.FlowRow(
        modifier = Modifier.fillMaxWidth().padding(vertical = 6.dp),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Text(label, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.padding(end = 12.dp).align(Alignment.CenterVertically))
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

/** A plain value on the same line as its label, aligned with the toned rows of the card (iOS `StatusRow`). */
@OptIn(androidx.compose.foundation.layout.ExperimentalLayoutApi::class)
@Composable
private fun StatusValueRow(label: String, value: String) {
    androidx.compose.foundation.layout.FlowRow(Modifier.fillMaxWidth().padding(vertical = 6.dp),
        horizontalArrangement = Arrangement.SpaceBetween, verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(label, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.padding(end = 12.dp).align(Alignment.CenterVertically))
        SelectionContainer {
            Text(value, style = MaterialTheme.typography.labelLarge)
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
        SimpleDateFormat("HH:mm:ss", L10n.locale).format(Date(startedAt))
    }
    Text(
        text = L10n.tr("开始 {0}", startTime),
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
        text = L10n.tr("耗时 {0}{1}", formatTurnDuration(durationMs), if (active) L10n.tr("，进行中") else ""),
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
    val progress = status.contextProgress ?: 0f
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
    if (status.severity == ContextUsageSeverity.Normal) return
    Text(
        L10n.tr("上下文 {0}", label),
        modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 2.dp),
        style = MaterialTheme.typography.labelSmall,
        fontWeight = FontWeight.Medium,
        color = if (status.severity == ContextUsageSeverity.Critical) MaterialTheme.colorScheme.error
            else MaterialTheme.colorScheme.primary,
    )
}

@Composable
internal fun ChatRuntimeStatus(
    status: String,
    isChatSyncing: Boolean,
    modelLabel: String?,
    thinkingLevel: String?,
    title: String? = null,
) {
    Row(
        Modifier.fillMaxWidth(),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(MetaLineGap),
    ) {
        // Reuse the leading icon slot: syncing must never change the text's width budget.
        MetaLineSlot {
            if (isChatSyncing) {
                CircularProgressIndicator(
                    modifier = Modifier.size(11.dp),
                    strokeWidth = 1.5.dp,
                    color = MaterialTheme.colorScheme.secondary,
                )
            } else {
                RuntimeStatusDot(status)
            }
        }
        MotionText(
            title ?: runtimeStatusText(status),
            color = runtimeStatusColor(status),
            style = MaterialTheme.typography.labelSmall,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
        modelLabel?.takeIf(String::isNotBlank)?.let { label ->
            MotionText(
                "$label",
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
            MotionText(
                "$level",
                modifier = Modifier.widthIn(max = 96.dp),
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                style = MaterialTheme.typography.labelSmall,
                fontWeight = FontWeight.Medium,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
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
    title: String? = null,
    isChatSyncing: Boolean = false,
    modelLabel: String? = null,
    modifier: Modifier = Modifier,
) {
    Row(modifier, horizontalArrangement = Arrangement.spacedBy(5.dp), verticalAlignment = Alignment.CenterVertically) {
        RuntimeStatusIndicator(status, title)
        modelLabel?.takeIf(String::isNotBlank)?.let { label ->
            MotionText(
                "$label",
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
internal fun RuntimeStatusIndicator(status: String, title: String? = null) {
    Row(horizontalArrangement = Arrangement.spacedBy(5.dp), verticalAlignment = Alignment.CenterVertically) {
        RuntimeStatusDot(status)
        MotionText(title ?: runtimeStatusText(status), color = runtimeStatusColor(status), style = MaterialTheme.typography.labelSmall)
    }
}

@Composable
private fun RuntimeStatusDot(status: String) {
    Box(Modifier.size(6.dp).clip(CircleShape).background(runtimeStatusColor(status)))
}

@Composable
private fun runtimeStatusColor(status: String): Color = when (status) {
    "unknown", "tasks_unknown" -> MaterialTheme.colorScheme.onSurfaceVariant
    "idle" -> MaterialTheme.colorScheme.tertiary
    // ADR-0049 §6.8：启动中是进行中的状态，与运行中同色；启动未确认待核对，与等待同色，不显示为错误。
    "running", "compacting", "starting", "background" -> MaterialTheme.colorScheme.primary
    "waiting_local_interaction", "launch_unconfirmed" -> MaterialTheme.colorScheme.secondary
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
    onRewind: (() -> Unit)? = null,
    rewindEnabled: Boolean = false,
    /** ADR-0049：本地待确认发送的状态；权威行为 null。 */
    pending: PendingSendState? = null,
    /** ADR-0049 §6.1：本地待发送消息带的附件（上传任务），气泡内显示缩略图 / 文件名与上传进度。 */
    uploads: List<UploadTask> = emptyList(),
    canResend: Boolean = false,
    onPendingAction: (PendingSendAction) -> Unit = {},
) {
    // 右对齐、按内容收窄的气泡，最宽 85%：位置已说明是谁发的，不再加「你」（与 iOS 一致）。
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
        Spacer(Modifier.weight(0.15f))
        Column(Modifier.weight(0.85f, fill = false), horizontalAlignment = Alignment.End, verticalArrangement = Arrangement.spacedBy(2.dp)) {
            MessageActions(id = "$runtimeId:${message.messageId}",
                text = message.content.mapNotNull { it.text }.joinToString("\n"), rewindEnabled = rewindEnabled,
                onRewind = if (pending == null) onRewind else null) { openActions ->
            NeumorphSurface(modifier = Modifier.messageSendFlightTarget(message.clientMessageId ?: message.messageId),
                style = NeumorphStyle.Pressed, shadowScale = 0.55f, contentPadding = 14.dp,
                onClick = {}, onLongClick = openActions) {
                Column(Modifier, verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    if (message.isError == true) Text(L10n.tr("发送异常"), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.error)
                    MessageBlocks(
                        runtimeId = runtimeId,
                        message = message,
                        downloads = downloads,
                        downloadArtifact = downloadArtifact,
                        downloadFile = downloadFile,
                    )
                    if (uploads.isNotEmpty()) PendingAttachments(uploads)
                }
            }
            }
            if (pending != null) {
                PendingSendStatus(pending, canResend, onPendingAction)
            }
        }
    }
}

internal enum class PendingSendAction { Resend, Restore, Discard, Check, Cancel }

/** 用户气泡下方原本放复制 / 回退的位置，替换为发送状态与恢复操作，不在聊天里另起提示行。 */
@Composable
private fun PendingSendStatus(state: PendingSendState, canResend: Boolean, onAction: (PendingSendAction) -> Unit) {
    Row(Modifier.testTag("pending-send-status"), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
        val muted = MaterialTheme.colorScheme.onSurfaceVariant
        when (state) {
            PendingSendState.Sending, PendingSendState.Accepted -> {
                CircularProgressIndicator(Modifier.size(12.dp), strokeWidth = 1.5.dp, color = muted)
                Text(L10n.tr("发送中"), style = MaterialTheme.typography.labelSmall, color = muted)
            }
            is PendingSendState.Waiting -> {
                // ADR-0049 §6.2：标明在等什么（上传中的附件名、等待前一条）。
                CircularProgressIndicator(Modifier.size(12.dp), strokeWidth = 1.5.dp, color = muted)
                Text(state.label, style = MaterialTheme.typography.labelSmall, color = muted, maxLines = 2, overflow = TextOverflow.Ellipsis)
            }
            PendingSendState.Queued -> {
                Text(L10n.tr("已排队"), style = MaterialTheme.typography.labelSmall, color = muted)
                NeumorphIconButton(onClick = { onAction(PendingSendAction.Cancel) }, icon = Icons.Rounded.Close,
                    contentDescription = L10n.tr("撤回排队消息"), size = 28.dp, enabled = canResend)
            }
            PendingSendState.Unconfirmed -> {
                Icon(Icons.Rounded.ErrorOutline, contentDescription = null, tint = muted, modifier = Modifier.size(14.dp))
                Text(L10n.tr("未确认是否送达"), style = MaterialTheme.typography.labelSmall, color = muted)
                NeumorphIconButton(onClick = { onAction(PendingSendAction.Check) }, icon = Icons.Rounded.Refresh,
                    contentDescription = L10n.tr("核对送达状态"), size = 28.dp, enabled = canResend)
                NeumorphIconButton(onClick = { onAction(PendingSendAction.Discard) }, icon = Icons.Rounded.Delete,
                    contentDescription = L10n.tr("删除"), size = 28.dp)
            }
            is PendingSendState.Failed -> {
                Icon(Icons.Rounded.ErrorOutline, contentDescription = null, tint = MaterialTheme.colorScheme.error, modifier = Modifier.size(14.dp))
                Text(state.reason, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.error,
                    maxLines = 2, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
                NeumorphIconButton(onClick = { onAction(PendingSendAction.Resend) }, icon = Icons.Rounded.Refresh,
                    contentDescription = L10n.tr("重新发送"), size = 28.dp, enabled = canResend)
                NeumorphIconButton(onClick = { onAction(PendingSendAction.Restore) }, icon = Icons.Rounded.Edit,
                    contentDescription = L10n.tr("放回输入框"), size = 28.dp)
                NeumorphIconButton(onClick = { onAction(PendingSendAction.Discard) }, icon = Icons.Rounded.Delete,
                    contentDescription = L10n.tr("删除"), size = 28.dp)
            }
        }
    }
}

/** One shared panel per visible reasoning/text/tool step, independent of native turns. */
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
    streamingMessageIds: Set<String> = emptySet(),
    replyArrivals: ReplyCardArrivals? = null,
    copyMessages: List<ChatMessage> = messages,
    cardId: String = messages.first().messageId,
    fileChanges: @Composable () -> Unit = {},
) {
    val motionParts = remember(messages) { messages.flatMap { message -> message.content.mapIndexed { index, block ->
        ReplyCardPart("${message.messageId}:$index:${block.type}", block.text.orEmpty())
    } } }
    val content = remember(messages) { assistantCardContent(messages) }
    GrowingReplyCard(cardId, motionParts, messages.any { it.messageId in streamingMessageIds }, replyArrivals) {
        Column(Modifier, verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                AgentLabel(LocalAgentBrand.current)
                Spacer(Modifier.weight(1f))
                turnTiming?.let { TurnStartLabel(it.startedAt) }
                // 整段回复的复制入口，与 iOS 卡片右上角一致。
                if (copyMessages.any { message -> message.content.any { it.type == "text" && !it.text.isNullOrBlank() } }) {
                    CopyIconButton(L10n.tr("复制回复"), size = 30.dp) {
                        copyMessages.flatMap { message -> message.content.filter { it.type == "text" }.mapNotNull { it.text } }
                            .filter(String::isNotBlank).joinToString("\n\n")
                    }
                }
            }
            content.prose.forEach { message ->
                key(runtimeId, message.messageId) {
                    CompositionLocalProvider(LocalStreamingText provides (message.messageId in streamingMessageIds)) {
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
                }
            }
            if (content.tools.isNotEmpty()) ChatToolGroup(runtimeId, content.tools, toolActivities, toolResults,
                downloads, downloadArtifact, downloadFile)
            turnTiming?.let { TurnDurationLabel(it, nowMs) }
            fileChanges()
        }
    }
}

/** S31: one bounded disclosure for a parallel tool batch, across all native message shapes. */
@Composable
private fun ChatToolGroup(
    runtimeId: String,
    calls: List<ChatCardTool>,
    activities: Map<String, ToolActivity>,
    results: Map<String, ChatMessage>,
    downloads: Map<String, ArtifactDownload>,
    downloadArtifact: (RemoteArtifact) -> Unit,
    downloadFile: (String) -> Unit,
) {
    val id = calls.first().key
    var expanded by rememberSaveable(id) { mutableStateOf(false) }
    var visible by rememberSaveable(id) { mutableIntStateOf(CHAT_TOOL_PAGE_SIZE) }
    val summaries = calls.map { call -> results[call.block.toolCallId]?.toolSummary
        ?: activities[call.block.toolCallId]?.summary ?: call.block.summary }
    val running = calls.indices.any { index -> summaries[index]?.let { it.phase !in setOf("finished", "cancelled") }
        ?: (activities[calls[index].block.toolCallId]?.state?.let { it != "finished" } ?: (results[calls[index].block.toolCallId] == null)) }
    val failed = summaries.any { it?.isError == true } || calls.any { results[it.block.toolCallId]?.isError == true }
    val status = if (running) L10n.tr("执行中") else if (failed) L10n.tr("执行失败") else L10n.tr("已完成")
    @Composable fun callView(call: ChatCardTool) {
        androidx.compose.runtime.key(call.key) {
            MessageBlocks(runtimeId, call.message.copy(content = listOf(call.block)), activities, results,
                downloads, downloadArtifact, downloadFile)
        }
    }
    if (calls.size == 1) { callView(calls.first()); return }
    Column(Modifier.fillMaxWidth()) {
        NeumorphTextButton(text = L10n.tr("{0} 次工具调用", calls.size) + " · " + status,
            icon = if (expanded) Icons.Rounded.ExpandLess else Icons.Rounded.ExpandMore,
            onClick = { expanded = !expanded }, modifier = Modifier.fillMaxWidth().testTag("chat-tool-group"))
        OrbisCollapse(expanded) {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                calls.take(visible).forEach { callView(it) }
                if (visible < calls.size) NeumorphTextButton(L10n.tr("显示更多工具（剩余 {0} 项）", calls.size - visible),
                    onClick = { visible += CHAT_TOOL_PAGE_SIZE }, modifier = Modifier.fillMaxWidth())
            }
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
                Text(L10n.tr("回复异常"), color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.labelMedium)
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
        message.content.forEachIndexed { index, block ->
            key(block.toolCallId ?: "${message.messageId}:$index:${block.type}") {
            if (block.type == "artifact" && block.artifact != null) {
                ArtifactCard(
                    artifact = block.artifact,
                    download = downloads.values.firstOrNull {
                        it.sourceArtifactId == block.artifact.artifactId ||
                            block.artifact.path != null && it.sourcePath == block.artifact.path
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
                    val summary = result?.toolSummary ?: activity?.summary ?: block.summary
                    val openDetail = LocalToolDetailAction.current
                    // A live streamed tool call has no id/arguments yet: its raw argument fragments
                    // are accumulated in `text` and only the finalized message carries the real
                    // tool_call metadata.
                    val live = toolId == null && block.arguments == null && !block.text.isNullOrBlank()
                    CollapsedTool(
                        toolName = block.toolName ?: activity?.toolName ?: message.toolName ?: L10n.tr("工具"),
                        arguments = block.arguments?.toString() ?: block.text,
                        activity = activity,
                        result = result,
                        live = live,
                        summary = summary,
                        canRead = LocalToolContentAvailable.current,
                        openDetail = { part -> summary?.let { openDetail(runtimeId, it, part) } },
                    )
                }
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
        "queued" -> L10n.tr("正在请求文件")
        "downloading" -> L10n.tr("正在下载 {0}/{1}", formatByteCount(download.receivedBytes), formatByteCount(artifact.size))
        "completed" -> L10n.tr("已保存到手机")
        "failed" -> download.error ?: L10n.tr("下载失败")
        "paused" -> L10n.tr("已暂停，可在下载页面继续")
        else -> L10n.tr("点击下载")
    }
    NeumorphSurface(
        onClick = onDownload,
        enabled = !isDownloading,
        shape = RemoteUi.ControlShape,
        modifier = Modifier.fillMaxWidth(),
        contentInset = 16.dp,
    ) {
        Row(
            Modifier.padding(16.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Icon(Icons.Rounded.Download, contentDescription = L10n.tr("下载文件"), tint = MaterialTheme.colorScheme.primary)
            Column(Modifier.weight(1f)) {
                FileNameText(artifact.fileName, fontWeight = FontWeight.SemiBold)
                Text(
                    L10n.tr("{0}，{1}", formatByteCount(artifact.size), status),
                    style = MaterialTheme.typography.bodySmall,
                    color = if (download?.status == "failed") MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            if (isDownloading) CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp)
        }
    }
}

internal fun formatByteCount(bytes: Long): String = when {
    bytes >= 1024 * 1024 -> "%.1f MB".format(bytes / (1024.0 * 1024.0))
    bytes >= 1024 -> "%.1f KB".format(bytes / 1024.0)
    else -> "$bytes B"
}

@Composable
private fun CollapsedThinking(text: String) {
    var expanded by rememberSaveable { mutableStateOf(false) }
    CompactDisclosure(
        icon = Icons.Rounded.Psychology,
        title = L10n.tr("思考过程"),
        summary = text,
        collapsedSummary = "",
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
    summary: ToolSummary? = null,
    canRead: Boolean = false,
    openDetail: (String) -> Unit = {},
) {
    if (summary != null) {
        ToolSummaryDisclosure(summary, canRead, openDetail)
        return
    }
    var expanded by rememberSaveable { mutableStateOf(false) }
    val resultText = result?.content.orEmpty().mapNotNull { it.text }.joinToString("\n").trim()
    val detail = resultText.ifBlank { activity?.detail }
    val failed = activity?.isError == true || result?.isError == true
    val status = when {
        failed -> L10n.tr("执行失败")
        live -> L10n.tr("参数接收中")
        else -> activity?.let { toolStateText(it.state) } ?: L10n.tr("已完成")
    }
    CompactDisclosure(
        icon = Icons.Rounded.Build,
        title = toolName,
        status = status,
        summary = listOfNotNull(arguments, detail).joinToString("\n"),
        collapsedSummary = detail?.let(::compactActivitySummary).orEmpty(),
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
    collapsedSummary: String? = null,
    /** Short state shown beside the title on the same line (iOS: 「read  已完成」). */
    status: String? = null,
) {
    val preview = collapsedSummary ?: summary.lineSequence().firstOrNull().orEmpty()
    NeumorphSurface(
        onClick = onClick,
        style = NeumorphStyle.Pressed,
        shape = RemoteUi.ControlShape,
        shadowScale = 0.5f,
        modifier = Modifier.fillMaxWidth(),
        contentInset = 12.dp,
    ) {
        Row(Modifier.heightIn(min = 56.dp).padding(12.dp),
            verticalAlignment = if (expanded || preview.isNotBlank()) Alignment.Top else Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Icon(icon, contentDescription = null, tint = tint, modifier = Modifier.size(17.dp))
            Column(Modifier.weight(1f)) {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text(title, style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.SemiBold,
                        maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
                    status?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1) }
                }
                if (preview.isNotBlank()) OrbisCollapse(expanded = !expanded) {
                    Text(preview, style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
                OrbisCollapse(expanded = expanded) {
                    Text(summary, style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant, fontFamily = FontFamily.Monospace)
                }
            }
            Icon(
                if (expanded) Icons.Rounded.ExpandLess else Icons.Rounded.ExpandMore,
                contentDescription = if (expanded) L10n.tr("收起") else L10n.tr("展开"),
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
        contentPadding = 12.dp,
    ) {
        Column(Modifier) {
            Text(L10n.tr("{0}，{1}", tool.toolName, toolStateText(tool.state)), style = MaterialTheme.typography.titleSmall)
            tool.detail?.let { Text(it.take(2_000), fontFamily = FontFamily.Monospace) }
            if (tool.isError) Text(L10n.tr("工具执行失败"), color = MaterialTheme.colorScheme.error)
        }
    }
}

@Composable
private fun PendingMessagesPanel(
    messages: List<QueuedMessage>,
    unconfirmed: Set<String>,
    canSend: Boolean,
    onCancel: (String) -> String?,
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
                L10n.tr("排队消息"),
                style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(horizontal = 12.dp, vertical = 2.dp),
            )
            LazyColumn(
                modifier = Modifier.fillMaxWidth().heightIn(max = 168.dp),
                contentPadding = PaddingValues(bottom = 6.dp),
            ) {
                items(messages, key = { "queued:${it.queueId}" }) { message ->
                    // ADR-0049 §6.3：撤回结果不明时回到原位并标“撤回未确认”，核对前不能再撤回。
                    QueuedMessageRow(message, message.queueId in unconfirmed, canSend) { onCancel(message.queueId) }
                }
            }
        }
    }
}

@Composable
private fun QueuedMessageRow(message: QueuedMessage, unconfirmed: Boolean, canSend: Boolean, onCancel: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Column(Modifier.weight(1f)) {
            Text(message.text, maxLines = 3, overflow = TextOverflow.Ellipsis)
            Text(
                L10n.tr("{0}，{1}{2}", queuedMessageDeliveryText(message.delivery), queuedMessageStateText(message.state), message.error?.let { "：$it" }.orEmpty()),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        // 只有还没送进上下文的消息能撤回；结果由队列事件回报（与 iOS 一致）。
        if (message.state == "accepted") {
            NeumorphTextButton(if (unconfirmed) L10n.tr("撤回未确认") else L10n.tr("撤回"), onClick = onCancel, icon = Icons.Rounded.Close,
                enabled = canSend && !unconfirmed)
        }
    }
}

/** How a message sent during a running turn is delivered; the same words on iOS. */
internal fun queuedMessageDeliveryText(delivery: String): String = when (delivery) {
    "steer" -> L10n.tr("插入当前任务")
    else -> L10n.tr("完成后发送")
}

private fun queuedMessageStateText(state: String): String = when (state) {
    "submitting" -> L10n.tr("提交中")
    "unconfirmed" -> L10n.tr("未确认")
    "accepted" -> L10n.tr("已排队")
    "delivered" -> L10n.tr("已送入上下文")
    "cancelled" -> L10n.tr("已取消")
    "rejected" -> L10n.tr("已拒绝")
    "not_cancelable" -> L10n.tr("不可取消")
    else -> state
}


/**
 * 错误横幅：错误分两层，互不打扰。
 *
 * - **Notice**（默认）：偶发/可自愈的错误，6 秒后自动消失；再点一下也能立刻关掉。
 * - **Action**：需要用户去电脑端处理（版本不兼容、事件无法解析），一直留着，直到用户点关闭。
 *
 * 覆盖在内容之上但不拦截点击：只有横幅本身可点，下面的界面照常操作。
 */
@Composable
private fun ErrorBanner(message: String, needsAction: Boolean, onDismiss: () -> Unit) {
    // 同一条文案重复到达不会反复闪：key 是文案本身，计时不会被重置。
    LaunchedEffect(message, needsAction) {
        if (!needsAction) {
            delay(6_000)
            onDismiss()
        }
    }
    Box(Modifier.fillMaxSize().wrapContentHeight(Alignment.Top).statusBarsPadding(), contentAlignment = Alignment.TopCenter) {
        NeumorphSurface(
            onClick = onDismiss,
            shape = RemoteUi.ControlShape,
            shadowScale = 0.5f,
            modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp),
        ) {
            Row(
                Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 10.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Icon(
                    Icons.Rounded.ErrorOutline,
                    contentDescription = null,
                    tint = MaterialTheme.colorScheme.error,
                    modifier = Modifier.size(18.dp),
                )
                Text(
                    message,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurface,
                    maxLines = if (needsAction) 6 else 3,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f),
                )
                if (needsAction) {
                    Text(L10n.tr("关闭"), style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.primary)
                }
            }
        }
    }
}

@Composable
private fun WarningCard(text: String) = FeedbackCard(text, isError = true)

/**
 * Notices float over the top of the transcript (never pushing the reading position). Each one is a
 * single opaque banner that carries its own close action and, when unverified, the re-check action.
 */
@Composable
internal fun RuntimeNotifications(
    projection: NoticeProjection,
    expectedEpoch: String?,
    /** 只有 Codex（含桌面版）会上报通知来源；其他运行时没有「待核对」可言，不显示核对提示。 */
    supported: Boolean,
    onRecheck: (() -> Unit)?,
    onDismiss: (String) -> Unit,
) {
    if (projection.items.isEmpty() && (!supported || projection.complete)) return
    val unverified = supported && (projection.verification == "unknown" || projection.hostEpoch != expectedEpoch)
    Column(Modifier.fillMaxWidth().heightIn(max = 200.dp)
        .verticalScroll(rememberScrollState()).padding(horizontal = 16.dp, vertical = 8.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp)) {
        if (projection.items.isEmpty()) NoticeBanner(L10n.tr("通知状态待核对"), isError = false, recheck = unverified, onRecheck = onRecheck, onClose = null)
        projection.items.forEachIndexed { index, notice ->
            NoticeBanner(notice.message, isError = notice.severity != "info",
                recheck = index == 0 && (unverified || (supported && notice.verification == "unknown")), onRecheck = onRecheck,
                onClose = { onDismiss(notice.notificationId) })
        }
    }
}

@Composable
private fun NoticeBanner(text: String, isError: Boolean, recheck: Boolean, onRecheck: (() -> Unit)?, onClose: (() -> Unit)?) {
    NeumorphSurface(Modifier.fillMaxWidth(), shape = RemoteUi.ControlShape, shadowScale = 0.6f, contentPadding = 12.dp) {
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.Top) {
            Icon(if (isError) Icons.Rounded.ErrorOutline else Icons.Rounded.Info, contentDescription = null,
                tint = if (isError) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.size(20.dp).padding(top = 1.dp))
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Text(text, style = MaterialTheme.typography.bodyMedium,
                    color = if (isError) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurface)
                if (recheck && text != L10n.tr("通知状态待核对")) {
                    Text(L10n.tr("通知状态待核对"), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                if (recheck && onRecheck != null) {
                    var glyphActivation by remember { mutableStateOf(0) }
                    Row(Modifier.clip(CircleShape).clickable { glyphActivation++; onRecheck() }.padding(vertical = 2.dp),
                        horizontalArrangement = Arrangement.spacedBy(4.dp), verticalAlignment = Alignment.CenterVertically) {
                        Icon(Icons.Rounded.Refresh, contentDescription = null, tint = MaterialTheme.colorScheme.primary, modifier = Modifier.size(14.dp).actionGlyphMotion(glyphActivation))
                        Text(L10n.tr("重新核对"), style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.primary)
                    }
                }
            }
            onClose?.let { NeumorphIconButton(onClick = it, icon = Icons.Rounded.Close, contentDescription = L10n.tr("关闭通知"), size = 28.dp) }
        }
    }
}

@Composable
private fun NoticeCard(text: String) = FeedbackCard(text, isError = false)

@Composable
private fun FeedbackCard(text: String, isError: Boolean) {
    NeumorphSurface(Modifier.fillMaxWidth(), style = NeumorphStyle.Pressed, shadowScale = 0.5f, contentPadding = 14.dp) {
        Row(Modifier, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            Icon(if (isError) Icons.Rounded.ErrorOutline else Icons.Rounded.Info, contentDescription = null,
                tint = if (isError) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.primary, modifier = Modifier.size(20.dp))
            Text(text, style = MaterialTheme.typography.bodyMedium)
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
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
    /** Inline above the composer: the card wraps its content instead of filling a sheet. */
    compact: Boolean = false,
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
    var fullPreview by remember(request.requestId) { mutableStateOf(false) }
    var summaryOverflows by remember(request.requestId) { mutableStateOf(false) }
    var linkError by remember(request.requestId) { mutableStateOf<String?>(null) }
    val knownKind = request.kind == "confirm" || request.kind == "select" || request.kind == "multi-select" || request.kind == "input"

    Column(
        modifier = modifier.fillMaxWidth().padding(horizontal = if (compact) 16.dp else 12.dp, vertical = 8.dp),
    ) {
        NeumorphSurface(modifier = if (compact) Modifier.fillMaxWidth() else Modifier.fillMaxSize(), shape = RemoteUi.CardShape, contentInset = 12.dp) {
            Column(Modifier.fillMaxWidth().then(if (compact) Modifier else Modifier.fillMaxHeight()).padding(12.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp)) {
                // 状态固定在标题行右侧：提交中、已提交、过期只替换这个位置的文字，按钮不移动（与 iOS 一致）。
                Row(Modifier.fillMaxWidth().heightIn(min = 32.dp), verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Icon(Icons.Rounded.Info, contentDescription = null, tint = MaterialTheme.colorScheme.primary, modifier = Modifier.size(20.dp))
                    Text(request.title, style = MaterialTheme.typography.titleMedium, modifier = Modifier.weight(1f), maxLines = 2,
                        overflow = TextOverflow.Ellipsis)
                    Text(
                        when {
                            request.submitted -> L10n.tr("已提交")
                            submitting -> L10n.tr("正在发送…")
                            expired -> L10n.tr("已过期")
                            else -> L10n.tr("待确认")
                        },
                        style = MaterialTheme.typography.labelSmall,
                        color = if (expired) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.primary,
                        maxLines = 1,
                    )
                }
                Column(
                    Modifier
                        .then(if (compact) Modifier.heightIn(max = 240.dp) else Modifier.weight(1f))
                        .fillMaxWidth()
                        .heightIn(min = 0.dp)
                        .verticalScroll(rememberScrollState())
                        .padding(4.dp),
                    verticalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    request.toolName?.let { tool ->
                        Text(tool, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.primary, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                    // 先说明为什么，再给出要执行的内容（与 iOS 一致）。
                    request.description?.let { SelectionContainer { Text(it) } }
                    request.argumentSummary?.let { summary ->
                        NeumorphSurface(style = NeumorphStyle.Pressed, shape = RemoteUi.ControlShape) {
                            SelectionContainer {
                                Text(summary, modifier = Modifier.fillMaxWidth().padding(10.dp), fontFamily = FontFamily.Monospace,
                                    maxLines = if (fullPreview) Int.MAX_VALUE else 8, overflow = TextOverflow.Ellipsis,
                                    onTextLayout = { if (!fullPreview) summaryOverflows = it.hasVisualOverflow })
                            }
                        }
                        // 只有内容真的被截断时才需要展开 / 复制整段；短命令可直接长按选择。
                        if (summaryOverflows || fullPreview) FlowRow(
                            horizontalArrangement = Arrangement.spacedBy(8.dp),
                            verticalArrangement = Arrangement.spacedBy(8.dp),
                        ) {
                            NeumorphTextButton(if (fullPreview) L10n.tr("收起内容") else L10n.tr("展开完整内容"), onClick = { fullPreview = !fullPreview })
                            CopyTextButton(L10n.tr("复制内容"), identity = request.requestId) { summary }
                        }
                    }
                    request.externalUrl?.let { url ->
                        Text(url, style = MaterialTheme.typography.bodySmall)
                        NeumorphTextButton(L10n.tr("打开网页"), enabled = responseEnabled, onClick = {
                            runCatching { uriHandler.openUri(url) }.onFailure { linkError = L10n.tr("无法打开网页，请在电脑端完成操作。") }
                        })
                    }
                    linkError?.let { Text(it, color = MaterialTheme.colorScheme.error) }
                    if (interactionHasDeadline(request) && !expired) {
                        Text(L10n.tr("剩余 {0} 秒", interactionRemainingSeconds(request, nowMs)), color = MaterialTheme.colorScheme.secondary, style = MaterialTheme.typography.labelMedium)
                    }
                    if (!knownKind) WarningCard(L10n.tr("手机无法安全渲染此交互，请在电脑端处理。"))
                    when (request.kind) {
                        "select" -> request.options.forEach { option ->
                            NeumorphSurface(
                                onClick = { respondValue(option.value) },
                                enabled = responseEnabled,
                                shape = RemoteUi.ControlShape,
                                shadowScale = 0.5f,
                                modifier = Modifier.fillMaxWidth(),
                                contentInset = 12.dp,
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
                            label = { Text(request.placeholder ?: L10n.tr("输入内容")) },
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
                                    contentInset = 8.dp,
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
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    if (onCancel != null && request.kind != "confirm") {
                        NeumorphTextButton(L10n.tr("取消请求"), enabled = responseEnabled, onClick = onCancel)
                    }
                    if (request.kind == "confirm") {
                        NeumorphTextButton(
                            text = request.cancelLabel ?: L10n.tr("拒绝"),
                            danger = true,
                            enabled = responseEnabled,
                            modifier = Modifier.weight(1f),
                            onClick = { respondConfirm(false) },
                        )
                    }
                    when (request.kind) {
                        "confirm" -> NeumorphTextButton(
                            text = request.confirmLabel ?: L10n.tr("允许"),
                            modifier = Modifier.weight(1f),
                            filled = true,
                            enabled = responseEnabled,
                            onClick = { respondConfirm(true) },
                        )
                        "input" -> NeumorphTextButton(
                            text = L10n.tr("提交"),
                            modifier = Modifier.weight(1f),
                            filled = true,
                            enabled = responseEnabled && isInteractionInputValid(input, request),
                            onClick = { respondValue(input) },
                        )
                        "multi-select" -> NeumorphTextButton(
                            text = L10n.tr("提交"),
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


private fun toolStateText(state: String): String = when (state) {
    "started" -> L10n.tr("已开始")
    "updated" -> L10n.tr("执行中")
    "finished" -> L10n.tr("已完成")
    else -> L10n.tr("状态未知")
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
                    FileNameText(upload.displayName, style = MaterialTheme.typography.labelMedium)
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
                    contentDescription = L10n.tr("移除附件"),
                    size = 40.dp,
                    tint = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }
}

/** 附件的进度文案。失败时优先说原因，因为那是用户唯一能采取行动的信息。 */
internal fun uploadProgressText(upload: UploadTask): String {
    val total = upload.size
    val percent = if (total <= 0) 0 else ((upload.durableBytes * 100) / total).toInt().coerceIn(0, 100)
    return when (upload.status) {
        "completed" -> L10n.tr("已发送到电脑")
        "failed" -> upload.error ?: L10n.tr("发送失败")
        "paused" -> L10n.tr("已暂停，可重新发送（{0}%）", percent)
        else -> L10n.tr("发送中 {0}%", percent)
    }
}

/**
 * 会话呈现的按身份缓存（ADR-0039 §5）。
 *
 * 消息是**不可变数据类**：内容变了必然是新对象，因此"列表逐项 `===`"就是可靠的
 * "内容没变"判据。命中时直接返回同一个呈现/列表对象，Compose 才能跳过重组。
 */
private class PresentationCache {
    private var lastMessages: List<ChatMessage>? = null
    private var lastPresentation: ConversationPresentation? = null
    private var lastItemMessages: List<ChatMessage>? = null
    private var lastTurnIds: Map<String, String>? = null
    private var lastItems: List<ChatListItem>? = null
    private var lastViewportItems: List<ChatListItem>? = null

    private fun sameIdentity(a: List<ChatMessage>?, b: List<ChatMessage>): Boolean {
        if (a === b) return true
        if (a == null || a.size != b.size) return false
        for (index in b.indices) if (a[index] !== b[index]) return false
        return true
    }

    fun presentation(messages: List<ChatMessage>): ConversationPresentation {
        lastPresentation?.let { cached -> if (sameIdentity(lastMessages, messages)) return cached }
        return buildConversationPresentation(messages).also {
            lastMessages = messages
            lastPresentation = it
        }
    }

    fun items(messages: List<ChatMessage>, turnIdsByMessageId: Map<String, String>): List<ChatListItem> {
        val cached = lastItems
        if (cached != null && sameIdentity(lastItemMessages, messages) && lastTurnIds == turnIdsByMessageId) return lastViewportItems!!
        return buildChatListItems(messages, turnIdsByMessageId, previous = cached.orEmpty()).also {
            lastItemMessages = messages
            lastTurnIds = turnIdsByMessageId
            lastItems = it
        }.let { chatViewportItems(it, lastViewportItems.orEmpty()) }.also { lastViewportItems = it }
    }
}

/** 从一条完整 Entry 里取出可读正文（ADR-0038 §8 的查看入口用）。 */
private fun fullEntryText(entry: SessionGraphEntry): String {
    val message = entry.data["message"] ?: return entry.data.toString()
    val content = message.jsonObject["content"]
    if (content == null || content !is JsonArray) return message.toString()
    return content.jsonArray.joinToString("\n") { block ->
        val obj = block.jsonObject
        when (obj["type"]?.jsonPrimitive?.contentOrNull) {
            "text", "thinking" -> obj["text"]?.jsonPrimitive?.contentOrNull ?: ""
            "tool_call" -> "[工具] " + (obj["toolName"]?.jsonPrimitive?.contentOrNull ?: "") + " " + (obj["arguments"]?.toString() ?: "")
            else -> block.toString()
        }
    }
}

/** ADR-0049 §6.8：启动失败或未确认时在聊天页原位说明，提供“重试”“返回”，草稿保留。 */
@Composable
internal fun LaunchNotice(launch: LaunchState, onRetry: () -> Unit, onBack: () -> Unit) {
    NeumorphSurface(
        modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 8.dp).testTag("launch-notice"),
        shape = RemoteUi.ControlShape, style = NeumorphStyle.Pressed,
    ) {
        Column(Modifier.fillMaxWidth().padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(launch.failure?.let { L10n.tr("启动失败：{0}", it) } ?: L10n.tr("启动未确认：电脑端尚未报告会话上线，请稍后在会话列表中查看。"),
                style = MaterialTheme.typography.bodyMedium,
                color = if (launch.failure != null) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant)
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                NeumorphTextButton(L10n.tr("重试"), onClick = onRetry, icon = Icons.Rounded.Refresh, modifier = Modifier.testTag("launch-retry"))
                NeumorphTextButton(L10n.tr("返回"), onClick = onBack, modifier = Modifier.testTag("launch-back"))
            }
        }
    }
}
