package com.orbising.orbis

import android.animation.ValueAnimator
import androidx.activity.compose.LocalOnBackPressedDispatcherOwner
import androidx.compose.animation.core.*
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.state.ToggleableState
import kotlinx.coroutines.delay
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.focusable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.ui.input.key.*
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.input.pointer.util.VelocityTracker
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.*
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import kotlin.math.*

/** Browsing is local. Only the settled primary action may request a provider change. */
@Composable
internal fun ProviderDialScreen(state: RemoteState, hosts: List<HostSnapshot>, onSelectHost: (String) -> Unit,
    onLoad: (String) -> Unit, onEnable: (AgentProvider, String?) -> Unit,
    onQuerySubscription: (AgentProvider, String?) -> Unit, showBack: Boolean = true,
    onAgentEnabled: (String?, String, Boolean, AgentDialReview?, Long?) -> Unit = { _, _, _, _, _ -> },
    onAgentRefresh: (String?) -> Unit = {}, onDismissAgentReview: (String?, AgentDialReview) -> Unit = { _, _ -> }) {
    val active = LocalPageActive.current
    var chosenKind by rememberSaveable(state.hostId) { mutableStateOf("codex") }
    var previewId by rememberSaveable(state.hostId, chosenKind) { mutableStateOf("") }
    var moving by remember(state.hostId) { mutableStateOf(false) }
    var hostMenu by remember { mutableStateOf(false) }
    var pending by remember { mutableStateOf<Pair<String, AgentProvider>?>(null) }
    val hostId = state.hostId
    val connected = hostId != null && state.e2eReady && state.connection == RelayConnection.ONLINE
    // Offline management facts never feed launch/catalog policy; they are cached for this dial only.
    val rows = if (connected && state.agentEnablementRevision != null) state.agentEnablementRows else state.agentDial.cached?.rows.orEmpty()
    val managed = state.agentEnablementAvailable || state.agentDial.cached != null
    val kinds = if (managed) rows.map { it.kind }
        else legacyAgentDialKinds(state.supportedAgents, state.launchableAgents) ?: DIAL_PROVIDER_GROUPS
    val kind = chosenKind.takeIf { it in kinds } ?: kinds.firstOrNull().orEmpty()
    val row = rows.firstOrNull { it.kind == kind }
    val group = agentDialProviderGroup(kind)
    val label = row?.label ?: knownAgentBrand(kind)?.title ?: kind
    val on = !managed || row?.enabled == true
    val sourceStatus = state.dialSourceStatus(kind, row, connected)
    val write = state.agentDial.pending(kind)
    val queued = write != null && state.agentDial.inFlight?.choice != write
    val visualOn = state.agentDial.visualEnabled(kind, on)
    var lastProfiles by remember(hostId, kind) { mutableStateOf(emptyList<AgentProvider>()) }
    val providers = if (on && group != null) state.providersForKind(group) else emptyList()
    val preview = providers.firstOrNull { it.id == previewId } ?: group?.let(state::currentProviderForKind)?.takeIf { it in providers } ?: providers.firstOrNull()
    val currentIndex = providers.indexOf(preview).coerceAtLeast(0)
    SideEffect { if (on && providers != lastProfiles) lastProfiles = providers }
    val dialProfiles = if (visualOn && !on) lastProfiles else providers
    val operation = state.agentProviders.takeIf { it.hostId == hostId && it.kind == group }
    val canEdit = active && state.agentDialCanEdit() && state.agentDial.review == null
    val canUse = group != null && active && connected && on && write == null && state.canUseProviders(group) && !moving
    val haptic = rememberActionHaptic()
    val notice = state.agentDial.notice
    var visibleNotice by remember(hostId) { mutableStateOf<AgentDialNotice?>(null) }
    LaunchedEffect(hostId, notice) { visibleNotice = notice; if (notice?.status != "readFailed") { delay(4_000); visibleNotice = null } }
    LaunchedEffect(active, hostId, kind, group, on, connected) {
        pending = null
        if (active && connected && on && group != null) onLoad(group)
    }
    LaunchedEffect(hostId, kind, providers.map { it.id }) {
        if (providers.none { it.id == previewId }) previewId = group?.let(state::currentProviderForKind)?.id ?: providers.firstOrNull()?.id.orEmpty()
    }
    fun toggle(target: Boolean) { if (canEdit && row != null && (write == null || queued)) onAgentEnabled(hostId, kind, target, null, null) }
    val syncLabel = remember(state.agentDial.lastSync) { state.agentDial.lastSync?.let {
        android.text.format.DateFormat.format(android.text.format.DateFormat.getBestDateTimePattern(java.util.Locale.getDefault(), "jm"), it).toString()
    } }
    Column(Modifier.fillMaxSize().background(MaterialTheme.colorScheme.surface).statusBarsPadding()
        .then(if (showBack) Modifier.navigationBarsPadding() else Modifier)) {
        RemoteTopAppBar(title = { Text("Agent") }, navigationIcon = {
            if (showBack) {
                val dispatcher = LocalOnBackPressedDispatcherOwner.current
                NeumorphIconButton({ dispatcher?.onBackPressedDispatcher?.onBackPressed() }, OrbisSymbols.ArrowBack, L10n.tr("返回"))
            }
        }, actions = {
            if (connected && managed && !state.agentDial.synchronized)
                NeumorphIconButton({ onAgentRefresh(hostId) }, OrbisSymbols.Refresh, L10n.tr("刷新"))
        })
        Row(Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 12.dp), verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Box(Modifier.widthIn(max = 140.dp)) {
                Row(Modifier.heightIn(min = 48.dp).orbisKeyboardFocus().clickable(
                    enabled = active && hosts.size > 1,
                    interactionSource = remember { MutableInteractionSource() }, indication = null,
                ) { hostMenu = true },
                    verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Icon(OrbisSymbols.Computer, null, Modifier.size(20.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
                    Text(state.hostName ?: hosts.firstOrNull { it.hostId == hostId }?.name ?: L10n.tr("电脑"),
                        style = MaterialTheme.typography.titleMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    if (hosts.size > 1) Icon(OrbisSymbols.KeyboardArrowDown, null, Modifier.size(16.dp))
                }
                NeumorphMenu(hostMenu, { hostMenu = false }) {
                    hosts.forEach { host -> NeumorphMenuItem(text = { Text(host.name) },
                        onClick = { hostMenu = false; onSelectHost(host.hostId) }) }
                }
            }
            Text(if (managed && rows.isNotEmpty()) L10n.tr("{0} / {1} 已启用", rows.count { it.enabled }, rows.size)
                else if (managed) L10n.tr("正在读取 Agent") else L10n.tr("{0} 个配置", providers.size),
                modifier = Modifier.weight(1f).testTag("provider-summary"), style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        @Composable fun Dial(modifier: Modifier) {
            val statuses = remember(kinds, rows, connected, state.supportedAgents, state.launchableAgents, state.codexDesktop, state.openCodeAvailability, state.agentDial) {
                kinds.associateWith { k -> state.dialSourceStatus(k, rows.firstOrNull { it.kind == k }, connected) }
            }
            val activeSessionCount = if (connected && on) state.runtimes.values.count { it.agentKind == kind } else 0
            val externalSubtitle = visibleNotice?.takeIf { it.kind == kind && (it.status == "externalOn" || it.status == "externalOff") }
                ?.let { if (it.status == "externalOn") "其他设备已启用" else "其他设备已停用" }
            val errorReason = if (kind == "codexDesktop" && on && connected && sourceStatus.tone == "error") state.codexDesktop?.reason else null
            DualProviderDial(kinds, rows.associateBy { it.kind }, statuses, kind, label, dialProfiles, currentIndex, hostId, active,
                managed, visualOn, canEdit && row != null && (write == null || queued), write, queued, sourceStatus, !connected,
                activeSessionCount = activeSessionCount, externalSubtitle = externalSubtitle, errorReason = errorReason,
                autoNudge = canEdit && rows.isNotEmpty() && rows.none { it.enabled },
                conflictId = visibleNotice?.takeIf { it.kind == kind && it.status == "conflict" }?.id,
                onToggle = ::toggle,
                onKind = { next -> if (kind != next) { chosenKind = next; previewId = "" } },
                onBrowse = { previewId = providers.getOrNull(it)?.id.orEmpty() }, onMoving = { moving = it }, modifier = modifier)
        }
        @Composable fun Controls(modifier: Modifier) {
            val brand = knownAgentBrand(kind)
            val content: @Composable () -> Unit = {
                Column(modifier.padding(horizontal = 20.dp).padding(bottom = 16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    val activeSessions = if (connected && on) state.runtimes.values.filter { it.agentKind == kind } else emptyList()
                    if (activeSessions.isNotEmpty() && (preview?.subscriptionSupported != true || !preview.enabled)) {
                        NeumorphSurface(Modifier.fillMaxWidth().testTag("provider-running-sessions"), RoundedCornerShape(12.dp), NeumorphStyle.Pressed, shadowScale = 0.35f) {
                            Column(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 10.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                                activeSessions.take(2).forEach { runtime ->
                                    val sessionTitle = runtime.sessionName?.takeIf { it.isNotBlank() } ?: runtime.name.ifBlank { runtime.runtimeId }
                                    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                        Box(Modifier.size(8.dp).background(LocalOrbisPalette.current.success, CircleShape))
                                        Text(sessionTitle, Modifier.weight(1f), style = MaterialTheme.typography.labelMedium,
                                            color = MaterialTheme.colorScheme.onSurface, maxLines = 1, overflow = TextOverflow.Ellipsis)
                                    }
                                }
                                val remaining = activeSessions.size - 2
                                Text(if (remaining > 0) L10n.tr("另外 {0} 个", remaining) else L10n.tr("{0} 个会话", activeSessions.size),
                                    style = MaterialTheme.typography.labelSmall, color = LocalOrbisPalette.current.success)
                            }
                        }
                    }
                    if (on && group != null && (preview != null || !managed))
                        ProviderQuotaPair(state, group, preview, canQuery = canUse, onQuery = { onQuerySubscription(it, hostId) })
                    if (on && group != null) {
                        operation?.error?.let { Text(it, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.error) }
                        state.providerCatalogProblems[group]?.let { Text(it, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.error, modifier = Modifier.testTag("provider-catalog-problem")) }
                    }
                    val title = when {
                        write != null -> L10n.tr(if (write.target) "正在启用" else "正在停用")
                        managed && row == null -> L10n.tr("正在读取 Agent")
                        managed && !on -> L10n.tr("启用 {0}", label)
                        managed && group == null -> L10n.tr("已启用")
                        operation?.requestId != null -> L10n.tr("正在切换配置")
                        preview == null -> if (operation?.loading == true) L10n.tr("正在读取供应商") else L10n.tr("当前没有可用供应商")
                        preview.additive && preview.enabled -> L10n.tr("移出 {0}", preview.name)
                        preview.additive -> L10n.tr("启用 {0}", preview.name)
                        preview.enabled -> L10n.tr("正在使用 {0}", preview.name)
                        else -> L10n.tr("切换到 {0}", preview.name)
                    }
                    NeumorphActionButton(text = title, modifier = Modifier.fillMaxWidth().testTag("provider-apply"),
                        enabled = if (managed && !on) canEdit && write == null && row != null && !moving else canUse && preview != null && (!preview.enabled || preview.additive),
                        icon = if (managed && !on) Icons.Rounded.PowerSettingsNew else if (preview?.enabled == true || managed && group == null) OrbisSymbols.Check else OrbisSymbols.SwapHoriz,
                        onClick = {
                            if (managed && !on) { toggle(true); return@NeumorphActionButton }
                            val selected = preview ?: return@NeumorphActionButton
                            if (canUse && hostId != null && selected in state.providersForKind(selected.kind)) {
                                if (selected.additive) { haptic(); onEnable(selected, hostId) }
                                else pending = hostId to selected
                            }
                        })
                    if (providers.isNotEmpty() || !managed) Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
                        Text(if (providers.isEmpty()) "0 / 0" else "${currentIndex + 1} / ${providers.size}",
                            style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    if (!connected) Text(syncLabel?.let { L10n.tr("等待电脑连接 · 上次同步 {0}", it) } ?: L10n.tr("等待电脑连接"),
                        style = MaterialTheme.typography.labelMedium, color = LocalOrbisPalette.current.warning)
                    visibleNotice?.let { feedback ->
                        val name = rows.firstOrNull { it.kind == feedback.kind }?.label ?: label
                        val text = when (feedback.status) {
                            "disabled" -> L10n.tr("已停用 {0}", name)
                            "externalOn" -> L10n.tr("{0} 已在其他设备启用", name)
                            "externalOff" -> L10n.tr("{0} 已在其他设备停用", name)
                            "conflict" -> L10n.tr("Agent 设置已在其他设备更新，请确认后重试")
                            "interrupted" -> L10n.tr(if (state.agentDial.synchronized) "已按电脑同步" else "未确认，等待电脑同步")
                            else -> L10n.tr("无法读取或保存 Agent 设置")
                        }
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text(text, Modifier.weight(1f), style = MaterialTheme.typography.labelMedium)
                            if (feedback.status == "disabled" && canEdit && feedback.revision == state.agentEnablementRevision)
                                TextButton(onClick = { feedback.kind?.let { onAgentEnabled(hostId, it, true, null, feedback.revision) }; visibleNotice = null }) { Text(L10n.tr("撤销")) }
                            if (feedback.status == "readFailed" && connected)
                                TextButton(onClick = { onAgentRefresh(hostId) }) { Text(L10n.tr("刷新")) }
                        }
                    }
                }
            }
            if (brand != null) AgentTheme(brand, content) else content()
        }
        BoxWithConstraints(Modifier.weight(1f).fillMaxWidth()) {
            val width = maxWidth; val height = maxHeight
            if (width >= 560.dp && height < 500.dp) Row(Modifier.fillMaxSize(), verticalAlignment = Alignment.CenterVertically) {
                Dial(Modifier.weight(1f).fillMaxHeight()); Controls(Modifier.width(minOf(340.dp, width * 0.44f)).verticalScroll(rememberScrollState()))
            } else Column(Modifier.fillMaxSize()) {
                Dial(Modifier.weight(1f).fillMaxWidth()); Controls(Modifier.fillMaxWidth().heightIn(max = (height - 204.dp).coerceAtLeast(90.dp)).verticalScroll(rememberScrollState()))
            }
        }
    }
    val review = state.agentDial.review
    if (active && review != null && connected) {
        val name = rows.firstOrNull { it.kind == review.kind }?.label ?: review.kind
        val dismiss = { onDismissAgentReview(hostId, review) }
        NeumorphDialog(onDismissRequest = dismiss,
            title = { Text(L10n.tr("停用 {0}？", name)) },
            text = { Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(L10n.tr("Orbis 将断开此 Agent 的接入，不会退出原生应用。"))
                review.sessions.forEach { Text(it) }
                val remaining = (review.total ?: 0) - review.sessions.size
                if (remaining > 0) Text(L10n.tr("另外 {0} 个", remaining))
            } },
            confirmButton = { NeumorphTextButton(L10n.tr("停用"), { onAgentEnabled(hostId, review.kind, false, review, review.revision) }, enabled = active && state.agentDialCanEdit()) },
            dismissButton = { NeumorphTextButton(L10n.tr("取消"), dismiss) })
    }
    pending?.let { (expectedHost, selected) ->
        val fresh = state.hostId == expectedHost && connected && active && !moving && state.canUseProviders(selected.kind) &&
            state.providersForKind(selected.kind).any { it == selected }
        NeumorphDialog(onDismissRequest = { pending = null },
            title = { Text(L10n.tr("切换 {0} 到 {1}？", agentBrand(selected.kind).title, selected.name)) },
            text = { Text(L10n.tr("已有会话需要重新打开。")) },
            confirmButton = { NeumorphTextButton(L10n.tr("切换并重载 Agent"), {
                if (fresh) { pending = null; haptic(); onEnable(selected, expectedHost) }
            }, enabled = fresh) }, dismissButton = { NeumorphTextButton(L10n.tr("取消"), { pending = null }) })
    }
}

/** The neutral moat and hollow never claim a gesture; the starting ring owns it until release. */
@Composable
private fun DualProviderDial(kinds: List<String>, rows: Map<String, AgentEnablementRow>, statuses: Map<String, AgentDialStatus>,
    kind: String, label: String,
    providers: List<AgentProvider>, selectedIndex: Int, hostId: String?, active: Boolean, managed: Boolean, on: Boolean,
    canEdit: Boolean, pending: AgentDialChoice?, queued: Boolean, status: AgentDialStatus, offline: Boolean,
    activeSessionCount: Int, externalSubtitle: String?, errorReason: String?,
    autoNudge: Boolean, conflictId: String?,
    onToggle: (Boolean) -> Unit, onKind: (String) -> Unit, onBrowse: (Int) -> Unit, onMoving: (Boolean) -> Unit, modifier: Modifier = Modifier) {
    val density = LocalDensity.current
    val scope = rememberCoroutineScope()
    var agentPosition by remember(hostId) { mutableFloatStateOf(kinds.indexOf(kind).toFloat()) }
    // The pointer coroutine survives Agent changes; it must follow the replacement state
    // used by drawing and settling rather than keep the first Agent's position.
    val itemPosition by rememberUpdatedState(
        remember(hostId, kind) { mutableFloatStateOf(selectedIndex.toFloat()) }
    )
    var grabbed by remember(hostId) { mutableStateOf<ProviderDialRing?>(null) }
    var settleJob by remember(hostId) { mutableStateOf<Job?>(null) }
    val currentKind by rememberUpdatedState(kind)
    val currentKinds by rememberUpdatedState(kinds)
    val currentOn by rememberUpdatedState(on)
    val currentEdit by rememberUpdatedState(canEdit)
    val currentPending by rememberUpdatedState(pending)
    val currentActiveSessions by rememberUpdatedState(activeSessionCount)
    val toggle by rememberUpdatedState(onToggle)
    var pinDrag by remember(hostId, kind) { mutableStateOf<Float?>(null) }
    var pinArmed by remember(hostId, kind) { mutableStateOf(false) }
    var showStatusInfo by remember(hostId, kind, status.label) { mutableStateOf(false) }
    var hint by remember(hostId, kind) { mutableStateOf<String?>(null) }
    var hintEvent by remember(hostId, kind) { mutableIntStateOf(0) }
    val nudge = remember(hostId, kind) { Animatable(0f) }
    val recoil = remember(hostId, kind) { Animatable(0f) }
    var nudged by rememberSaveable(hostId) { mutableStateOf(false) }
    fun nudgePin() { if (canEdit && pending == null) { hint = if (on) "向内拉停用" else "向外推启用"; hintEvent++ } }
    val currentNudge by rememberUpdatedState(::nudgePin)
    LaunchedEffect(active, autoNudge) {
        if (active && autoNudge && !nudged) {
            delay(900); nudged = true
            currentNudge(); delay(540); currentNudge()
        }
    }
    LaunchedEffect(hostId, kind, conflictId) {
        recoil.snapTo(0f)
        if (conflictId != null && ValueAnimator.areAnimatorsEnabled()) {
            recoil.animateTo(-4f, tween(55)); recoil.animateTo(3f, tween(55)); recoil.animateTo(0f, tween(75))
        }
    }
    val haptic = rememberActionHaptic()
    LaunchedEffect(hintEvent) {
        if (hintEvent > 0) {
            if (ValueAnimator.areAnimatorsEnabled()) { nudge.animateTo(if (on) -0.16f else 0.16f, tween(160)); nudge.animateTo(0f, tween(220)) }
            delay(1050); hint = null
        }
    }
    val target = when { pending?.target == true -> AgentDialPin.HOLD; pending?.target == false -> 1f - AgentDialPin.HOLD; on -> 1f; else -> 0f }
    val pin by animateFloatAsState(target, tween(InteractionMotion.duration(170)), label = "agent-pin")
    var ringLit by remember(hostId, kind) { mutableStateOf(on) }
    val sweep = remember(hostId, kind) { Animatable(1f) }
    val dimSweep = remember(hostId, kind) { Animatable(0f) }
    val power by animateFloatAsState(if (ringLit) 1f else 0f, tween(InteractionMotion.duration(240)), label = "agent-ring-power")
    LaunchedEffect(on) {
        if (managed && on && !ringLit && !offline) {
            dimSweep.snapTo(0f)
            delay(InteractionMotion.duration(170).toLong()); ringLit = true; haptic()
            if (ValueAnimator.areAnimatorsEnabled()) { sweep.snapTo(0f); sweep.animateTo(1f, tween(580, easing = InteractionMotion.Easing)) }
        } else if (managed && !on && ringLit && !offline) {
            ringLit = false
            if (ValueAnimator.areAnimatorsEnabled()) { dimSweep.snapTo(1f); dimSweep.animateTo(0f, tween(520, easing = InteractionMotion.Easing)) }
        } else { ringLit = on; sweep.snapTo(1f); dimSweep.snapTo(0f) }
    }
    val flowing = managed && on && !offline && (status.label.startsWith("准备") || status.label.startsWith("正在") || status.label.startsWith("安装"))
    val flowTransition = rememberInfiniteTransition(label = "agent-ring-flow")
    val flowAngle by if (flowing && ValueAnimator.areAnimatorsEnabled()) flowTransition.animateFloat(0f, 360f,
        infiniteRepeatable(tween(1400, easing = LinearEasing)), label = "agent-ring-flow-angle") else rememberUpdatedState(0f)
    val currentProviders by rememberUpdatedState(if (ringLit) providers else emptyList())
    val currentOnKind by rememberUpdatedState(onKind)
    val currentOnBrowse by rememberUpdatedState(onBrowse)
    val currentOnMoving by rememberUpdatedState(onMoving)
    val tick = rememberActionHaptic()
    val pointerPop = remember { Animatable(1f) }
    val agentPop = remember { Animatable(1f) }
    LaunchedEffect(itemPosition.floatValue.roundToInt()) {
        if (ValueAnimator.areAnimatorsEnabled()) {
            pointerPop.snapTo(1.5f)
            pointerPop.animateTo(1f, tween(InteractionMotion.duration(InteractionMotion.State)))
        } else pointerPop.snapTo(1f)
    }
    LaunchedEffect(kind) {
        if (ValueAnimator.areAnimatorsEnabled()) {
            agentPop.snapTo(1.08f)
            agentPop.animateTo(1f, tween(InteractionMotion.duration(InteractionMotion.Selection), easing = InteractionMotion.GlyphEase))
        } else agentPop.snapTo(1f)
    }
    val palette = LocalOrbisPalette.current
    val material = rememberNeumorphColors()
    val accent = knownAgentBrand(kind)?.accent() ?: MaterialTheme.colorScheme.primary
    LaunchedEffect(hostId, kinds, kind, selectedIndex) {
        if (grabbed == null && settleJob?.isActive != true) {
            agentPosition = kinds.indexOf(kind).coerceAtLeast(0).toFloat()
            itemPosition.floatValue = selectedIndex.toFloat()
        }
    }
    DisposableEffect(hostId, active) { onDispose { settleJob?.cancel(); currentOnMoving(false) } }
    fun settle(ring: ProviderDialRing, target: Int) {
        settleJob?.cancel()
        val maxIndex = if (ring == ProviderDialRing.Agent) currentKinds.lastIndex.coerceAtLeast(0) else currentProviders.lastIndex.coerceAtLeast(0)
        val end = target.coerceIn(0, maxIndex)
        val from = if (ring == ProviderDialRing.Agent) agentPosition else itemPosition.floatValue
        currentOnMoving(true)
        settleJob = scope.launch {
            animate(from, end.toFloat(), animationSpec = tween(InteractionMotion.duration(
                InteractionMotion.Panel + min(240, (abs(end - from) * 90).roundToInt())), easing = Easing { 1 - (1-it).pow(3) })) { value, _ ->
                if (ring == ProviderDialRing.Agent) agentPosition = value else itemPosition.floatValue = value
            }
            if (ring == ProviderDialRing.Agent) currentKinds.getOrNull(end)?.let(currentOnKind) else currentOnBrowse(end)
            currentOnMoving(false)
        }
    }
    BoxWithConstraints(modifier.clipToBounds().testTag("provider-dual-dial")) {
        val height = maxHeight.value
        val width = maxWidth.value
        val g = DualDialGeometry.measure(width, height)
        val latestGeometry = rememberUpdatedState(g)
        val px = density.density
        Box(Modifier.fillMaxSize().pointerInput(hostId, active, kinds, managed) {
            if (!active) return@pointerInput
            awaitEachGesture {
                val down = awaitFirstDown(requireUnconsumed = false)
                val gestureGeometry = latestGeometry.value
                val x = down.position.x / px; val y = down.position.y / px
                val inChannel = managed && gestureGeometry.inPinChannel(x, y)
                val ring = gestureGeometry.ringAt(x, y) ?: ProviderDialRing.Agent.takeIf { inChannel } ?: return@awaitEachGesture
                settleJob?.cancel(); currentOnMoving(false)
                val start = if (ring == ProviderDialRing.Agent) agentPosition.roundToInt().toFloat() else itemPosition.floatValue
                val startKind = currentKind
                val startEnabled = currentOn
                val startPending = currentPending
                val velocity = VelocityTracker()
                velocity.addPosition(down.uptimeMillis, down.position)
                var locked = false; var radial = false; var armed = false; var released = false
                var vertical = false
                try {
                    while (true) {
                        val change = awaitPointerEvent().changes.firstOrNull { it.id == down.id } ?: break
                        velocity.addPosition(change.uptimeMillis, change.position)
                        if (!change.pressed) { released = !change.isConsumed || radial || vertical; break }
                        val dx = (change.position.x - down.position.x) / px
                        val dy = (change.position.y - down.position.y) / px
                        if (!locked && if (managed) hypot(dx, dy) >= AgentDialPin.LOCK else abs(dy) > (if (ring == ProviderDialRing.Agent) 10f else 4f)) {
                            locked = true
                            val horizontal = managed && AgentDialPin.horizontal(dx, dy)
                            radial = horizontal && inChannel && currentEdit
                            vertical = !horizontal && (ring == ProviderDialRing.Agent && currentKinds.isNotEmpty() || ring == ProviderDialRing.Profile && currentProviders.isNotEmpty())
                            if (vertical) { grabbed = ring; currentOnMoving(true) }
                            if (horizontal && inChannel) change.consume()
                        }
                        if (locked && inChannel && !vertical && !radial) { change.consume() }
                        if (radial) {
                            if (!currentEdit || currentKind != startKind || currentOn != startEnabled || currentPending != startPending) { radial = false; armed = false; pinArmed = false; pinDrag = null; hint = null; break }
                            val effective = startPending?.target ?: startEnabled
                            val value = AgentDialPin.drag(effective, dx, gestureGeometry.pinTravel)
                            pinDrag = value
                            val next = AgentDialPin.armed(effective, value)
                            if (next != armed) { if (next) tick(); armed = next }
                            pinArmed = next
                            hint = if (armed) agentDialPinReleaseHint(effective, currentActiveSessions) else null
                            change.consume()
                        } else if (vertical) {
                            if (ring == ProviderDialRing.Agent) {
                                val raw = DualDialGeometry.soften(start - dy / 84f, currentKinds.size)
                                val next = raw.roundToInt().coerceIn(0, currentKinds.lastIndex)
                                if (currentKinds[next] != currentKind) { tick(); currentOnKind(currentKinds[next]) }
                                agentPosition = DualDialGeometry.sticky(raw)
                            } else if (currentProviders.isNotEmpty()) {
                                val next = DualDialGeometry.soften(start - dy / gestureGeometry.profilePitch, currentProviders.size)
                                if (next.roundToInt() != itemPosition.floatValue.roundToInt()) tick()
                                itemPosition.floatValue = next
                                currentOnBrowse(next.roundToInt().coerceIn(0, currentProviders.lastIndex))
                            }
                            change.consume()
                        }
                    }
                } finally {
                    if (vertical) { grabbed = null; currentOnMoving(false) }
                    if (radial) { pinDrag = null; pinArmed = false; hint = null }
                }
                if (radial && released && armed && currentEdit && currentKind == startKind && currentOn == startEnabled && currentPending == startPending)
                    toggle(!(startPending?.target ?: startEnabled))
                if (vertical && released) {
                    if (ring == ProviderDialRing.Agent) settle(ring, agentPosition.roundToInt())
                    else settle(ring, (itemPosition.floatValue - velocity.calculateVelocity().y / px / gestureGeometry.profilePitch * 0.14f).roundToInt())
                }
            }
        }) {
            fun Modifier.disc(radius: Float) = wrapContentSize(Alignment.TopStart, unbounded = true)
                .offset(x = (g.cx - radius).dp, y = (g.cy - radius).dp).requiredSize((radius * 2).dp)
            // These are the independent physical rings of the component, each with one frame.
            CompositionLocalProvider(LocalOrbisSurface provides null) {
                NeumorphSurface(Modifier.disc(g.radius), CircleShape, style = if (managed && !ringLit) NeumorphStyle.Pressed else NeumorphStyle.Raised, shadowScale = 0.4f + power * 0.6f) {}
                if (managed && !offline && sweep.value in 0f..1f && sweep.value < 1f) {
                    Canvas(Modifier.fillMaxSize()) {
                        val radius = (g.radius - 12) * px
                        val topLeft = Offset((g.cx - g.radius + 12) * px, (g.cy - g.radius + 12) * px)
                        val size = androidx.compose.ui.geometry.Size(2 * radius, 2 * radius)
                        val tint = accent.copy(alpha = sin(sweep.value * PI.toFloat()) * 0.7f)
                        drawArc(tint, 0f, sweep.value * 110f, false, topLeft, size, style = Stroke(2.dp.toPx()))
                        drawArc(tint, 0f, -sweep.value * 110f, false, topLeft, size, style = Stroke(2.dp.toPx()))
                    }
                }
                if (managed && !offline && dimSweep.value > 0.01f) {
                    Canvas(Modifier.fillMaxSize()) {
                        val radius = (g.radius - 12) * px
                        val topLeft = Offset((g.cx - g.radius + 12) * px, (g.cy - g.radius + 12) * px)
                        val size = androidx.compose.ui.geometry.Size(2 * radius, 2 * radius)
                        val tint = palette.faint.copy(alpha = sin(dimSweep.value * PI.toFloat()) * 0.55f)
                        drawArc(tint, 0f, dimSweep.value * 110f, false, topLeft, size, style = Stroke(2.dp.toPx()))
                        drawArc(tint, 0f, -dimSweep.value * 110f, false, topLeft, size, style = Stroke(2.dp.toPx()))
                    }
                }
                if (flowing) {
                    Canvas(Modifier.fillMaxSize()) {
                        val radius = (g.radius - 12) * px
                        val topLeft = Offset((g.cx - g.radius + 12) * px, (g.cy - g.radius + 12) * px)
                        val size = androidx.compose.ui.geometry.Size(2 * radius, 2 * radius)
                        drawArc(accent.copy(alpha = 0.55f), flowAngle - 36f, 72f, false, topLeft, size, style = Stroke(2.dp.toPx()))
                    }
                }
                NeumorphSurface(Modifier.disc(g.seamRadius), CircleShape, NeumorphStyle.Pressed, shadowScale = 0.4f) {}
                NeumorphSurface(Modifier.disc(g.hubRadius).graphicsLayer { alpha = if (grabbed == ProviderDialRing.Profile) 0.4f else 1f },
                    CircleShape, shadowScale = if (grabbed == ProviderDialRing.Agent) 0.65f else 0.4f) {}
                NeumorphSurface(Modifier.disc(g.holeRadius), CircleShape, NeumorphStyle.Pressed, shadowScale = 0.65f) {}
                if (!managed) NeumorphSurface(Modifier.offset(x = (g.cx + g.agentRadius - 20).dp, y = (g.cy - 20).dp).size(40.dp)
                    .graphicsLayer { scaleX = agentPop.value; scaleY = agentPop.value },
                    CircleShape, NeumorphStyle.Pressed, shadowScale = 0.4f) {}
            }
            Canvas(Modifier.fillMaxSize()) {
                val centre = Offset(g.cx * px, g.cy * px)
                fun point(r: Float, angle: Float) = centre + Offset(cos(angle) * r * px, sin(angle) * r * px)
                val itemStep = Math.toRadians(g.profileStep.toDouble()).toFloat()
                for (i in 0 until 120) {
                    val a = Math.toRadians((i * 3 - itemPosition.floatValue * g.profileStep).toDouble()).toFloat()
                    val length = if (i % 8 == 0) 18 else if (i % 4 == 0) 12 else 8
                    drawLine(palette.faint.copy(alpha = if (offline) 0.32f else 0.28f + power * 0.72f), point(g.radius - length, a), point(g.radius - 6, a), strokeWidth = 1.dp.toPx())
                }
                (if (ringLit) providers else emptyList()).forEachIndexed { index, provider ->
                    val a = (index - itemPosition.floatValue) * itemStep
                    drawCircle(if (provider.enabled) palette.success else palette.faint, 3.dp.toPx(), point(g.radius - 32, a))
                }
                repeat(100) { index ->
                    val a = index * (2 * PI / 100).toFloat()
                    drawCircle(palette.faint.copy(alpha = 0.45f), 0.8.dp.toPx(), point(g.hubRadius - 6, a))
                }
                val pinColor = when (status.tone) { "success" -> palette.success; "warning" -> palette.warning; "error" -> palette.danger; else -> accent }
                val pointer = Offset((g.cx + g.radius + 8) * px, g.cy * px)
                if (managed && !offline && power in 0.01f..0.99f) {
                    val radius = (g.radius - 12) * px
                    val start = Offset(g.cx * px - radius, g.cy * px - radius)
                    val size = androidx.compose.ui.geometry.Size(2 * radius, 2 * radius)
                    val tint = accent.copy(alpha = sin(power * PI.toFloat()) * 0.7f)
                    drawArc(tint, 0f, power * 110, false, start, size, style = Stroke(2.dp.toPx()))
                    drawArc(tint, -power * 110, power * 110, false, start, size, style = Stroke(2.dp.toPx()))
                }
                val hollow = managed && (offline || !ringLit || status.tone == "neutral")
                if (hollow) drawCircle(if (offline || !on) palette.faint else pinColor, 3.5.dp.toPx(), pointer, style = Stroke(1.dp.toPx()))
                else drawCircle(pinColor, 3.dp.toPx() * pointerPop.value, pointer)
            }
            kinds.forEachIndexed { index, agent ->
                val angle = Math.toRadians(((index - agentPosition) * g.agentStep).toDouble())
                val x = g.cx + g.agentRadius * cos(angle).toFloat()
                val y = g.cy + g.agentRadius * sin(angle).toFloat()
                val agentEnabled = if (agent == kind) on else rows[agent]?.enabled == true
                val agentStatus = statuses[agent] ?: status
                if (abs(index - agentPosition) < 3.1f && x >= 12 && y in 20f..(height - 20) && !(managed && agent == kind && grabbed != ProviderDialRing.Agent)) Box(Modifier.offset(x = (x-24).dp, y = (y-24).dp).size(48.dp)
                    .testTag("provider-agent-$agent")
                    .graphicsLayer { alpha = if (grabbed == ProviderDialRing.Profile || agent != kind) 0.4f else 1f }
                    .orbisKeyboardFocus().clickable(enabled = active,
                        interactionSource = remember { MutableInteractionSource() }, indication = null) { tick(); settle(ProviderDialRing.Agent, index) }, contentAlignment = Alignment.Center) {
                    DialAgentMark(agent, offline || !agentEnabled)
                    if (managed) DialAgentBadges(agent, agentEnabled && !offline, agentStatus)
                }
            }
            val infoHint = agentDialInfoHint(status.label)
            val subtitleText = externalSubtitle ?: errorReason ?: if (on && !offline && activeSessionCount > 0) L10n.tr("{0} 个运行中", activeSessionCount) else null
            val subtitleColor = when {
                externalSubtitle != null -> accent
                errorReason != null -> palette.danger
                else -> palette.success
            }
            providers.forEachIndexed { index, provider ->
                val angle = Math.toRadians(((index - itemPosition.floatValue) * g.profileStep).toDouble())
                val x = g.cx + (g.radius + 28) * cos(angle).toFloat()
                val y = g.cy + (g.radius + 28) * sin(angle).toFloat()
                if (y in -40f..(height + 40)) {
                    val selected = index == itemPosition.floatValue.roundToInt().coerceIn(0, providers.lastIndex)
                    Column(Modifier.offset(x = x.dp, y = (y - if (selected) 44 else 16).dp).width((width - x - 16).coerceIn(64f,136f).dp).heightIn(min = 48.dp)
                        .graphicsLayer { alpha = if (grabbed == ProviderDialRing.Agent) 0.4f else if (selected) 1f else 0.6f }
                        .orbisKeyboardFocus().clickable(enabled = active,
                            interactionSource = remember { MutableInteractionSource() }, indication = null) { settle(ProviderDialRing.Profile, index) },
                        verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        if (selected) Text(label, style = MaterialTheme.typography.labelSmall, color = accent)
                        Text(provider.name, style = if (selected) MaterialTheme.typography.titleLarge else MaterialTheme.typography.labelMedium,
                            maxLines = 1, overflow = TextOverflow.Ellipsis, color = MaterialTheme.colorScheme.onSurface)
                        if (selected) {
                            Text(if (provider.official) L10n.tr("官方配置") else L10n.tr("已保存的配置"),
                                style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                            if (managed && (status.tone != "success" || pending != null || hint != null)) {
                                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                                    Text(L10n.tr(hint ?: status.label), style = MaterialTheme.typography.labelSmall,
                                        color = when (status.tone) { "warning" -> palette.warning; "error" -> palette.danger; else -> accent })
                                    if (infoHint != null && hint == null) {
                                        Icon(OrbisSymbols.Info, L10n.tr("查看说明"), Modifier.size(15.dp).clickable { showStatusInfo = !showStatusInfo },
                                            tint = MaterialTheme.colorScheme.onSurfaceVariant)
                                    }
                                }
                                if (showStatusInfo && infoHint != null && hint == null) {
                                    Text(L10n.tr(infoHint), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                                }
                            }
                            if (subtitleText != null) {
                                Text(subtitleText, style = MaterialTheme.typography.labelSmall, color = subtitleColor, maxLines = 2, overflow = TextOverflow.Ellipsis)
                            }
                            if (provider.enabled) Text(if (provider.additive) L10n.tr("已启用") else L10n.tr("使用中"),
                                style = MaterialTheme.typography.labelSmall, color = palette.success)
                        }
                    }
                }
            }
            if (managed && (!ringLit || providers.isEmpty()) && kind.isNotEmpty()) {
                val x = g.cx + g.radius + 28
                Column(Modifier.offset(x = x.dp, y = (g.cy - 31).dp).width((width - x - 12).coerceIn(64f, 150f).dp), verticalArrangement = Arrangement.spacedBy(5.dp)) {
                    Text(label, style = MaterialTheme.typography.labelSmall, color = if (on && !offline) accent else palette.faint)
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        Text(L10n.tr(hint ?: status.label), style = MaterialTheme.typography.titleLarge,
                            color = when (status.tone) { "success" -> palette.success; "warning" -> palette.warning; "error" -> palette.danger; "accent" -> accent; else -> MaterialTheme.colorScheme.onSurfaceVariant })
                        if (infoHint != null && hint == null) {
                            Icon(OrbisSymbols.Info, L10n.tr("查看说明"), Modifier.size(18.dp).testTag("provider-status-info")
                                .clickable { showStatusInfo = !showStatusInfo }, tint = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                    }
                    if (showStatusInfo && infoHint != null && hint == null) {
                        Text(L10n.tr(infoHint), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    if (subtitleText != null) {
                        Text(subtitleText, style = MaterialTheme.typography.labelSmall, color = subtitleColor, maxLines = 2, overflow = TextOverflow.Ellipsis)
                    }
                }
            }
            // Two distinct keyboard/accessible sliders mirror the physical rings without remote writes.
            @Composable
            fun Modifier.keyboardRing(ring: ProviderDialRing, position: Float, lastIndex: Int): Modifier =
                orbisKeyboardFocus().onPreviewKeyEvent { event ->
                    if (!active || event.type != KeyEventType.KeyDown) false else {
                        val target = if (managed && ring == ProviderDialRing.Agent && canEdit) when (event.key) {
                            Key.DirectionLeft -> false; Key.DirectionRight -> true; Key.Spacebar -> !(pending?.target ?: on); else -> null
                        } else null
                        if (target != null) { onToggle(target); return@onPreviewKeyEvent true }
                        val next = when (event.key) {
                            Key.DirectionUp -> position.roundToInt() - 1
                            Key.DirectionDown -> position.roundToInt() + 1
                            Key.MoveHome -> 0
                            Key.MoveEnd -> lastIndex
                            else -> return@onPreviewKeyEvent false
                        }
                        settle(ring,next.coerceIn(0,lastIndex.coerceAtLeast(0)));true
                    }
                }.focusable(enabled=active)
            if (kinds.isNotEmpty()) Box(Modifier.offset(x = 20.dp).width((g.cx + g.hubRadius - 20).coerceAtLeast(48f).dp).fillMaxHeight()
                .testTag("provider-agent-reel").keyboardRing(ProviderDialRing.Agent,agentPosition,kinds.lastIndex).semantics {
                    contentDescription = "Agent"; stateDescription = label
                    progressBarRangeInfo = ProgressBarRangeInfo(agentPosition.coerceIn(0f, kinds.lastIndex.toFloat()), 0f..kinds.lastIndex.toFloat(), (kinds.size - 2).coerceAtLeast(0))
                    setProgress { target -> if (!active) false else { settle(ProviderDialRing.Agent, target.roundToInt()); true } }
                })
            if (!managed || providers.isNotEmpty()) Box(Modifier.offset(x = (g.cx + g.seamRadius).dp).fillMaxSize().testTag("provider-arc").keyboardRing(ProviderDialRing.Profile,itemPosition.floatValue,providers.lastIndex).semantics {
                contentDescription = L10n.tr("{0} 的配置", label)
                stateDescription = providers.getOrNull(selectedIndex)?.name ?: L10n.tr("当前没有可用供应商")
                progressBarRangeInfo = ProgressBarRangeInfo(itemPosition.floatValue.coerceIn(0f, providers.lastIndex.coerceAtLeast(0).toFloat()),
                    0f..providers.lastIndex.coerceAtLeast(0).toFloat(), (providers.size - 2).coerceAtLeast(0))
                setProgress { target -> if (!active || providers.isEmpty()) false else { settle(ProviderDialRing.Profile, target.roundToInt()); true } }
            })
            if (managed && label.isNotEmpty() && grabbed != ProviderDialRing.Agent) {
                val x = g.pinStart
                val fraction = (pinDrag ?: (pin + nudge.value)).coerceIn(0f, 1f)
                val color = if (conflictId != null) palette.danger else if (offline || !on && pending == null) palette.faint else accent
                val progress = rememberInfiniteTransition(label = "agent-pin-pending")
                val spin by if (pending != null && !queued && ValueAnimator.areAnimatorsEnabled()) progress.animateFloat(0f, 360f,
                    infiniteRepeatable(tween(1100, easing = LinearEasing)), label = "agent-pin-spin") else rememberUpdatedState(0f)
                NeumorphSurface(Modifier.offset((x - 22).dp, (g.cy - 22).dp).size((g.pinTravel + 44).dp, 44.dp),
                    RoundedCornerShape(22.dp), NeumorphStyle.Pressed, shadowScale = 0.55f) {}
                Canvas(Modifier.fillMaxSize()) {
                    val socketColor = when {
                        conflictId != null -> palette.danger.copy(alpha = 0.75f)
                        on && !offline -> accent.copy(alpha = 0.85f)
                        else -> palette.faint.copy(alpha = 0.50f)
                    }
                    val socketStroke = if (on && !offline || conflictId != null) 1.5.dp.toPx() else 1.dp.toPx()
                    drawCircle(socketColor, 18.dp.toPx(), Offset((x + g.pinTravel) * px, g.cy * px), style = Stroke(socketStroke))
                    if (pinArmed) {
                        drawRoundRect(
                            color = accent.copy(alpha = 0.8f),
                            topLeft = Offset((x - 22) * px, (g.cy - 22) * px),
                            size = androidx.compose.ui.geometry.Size((g.pinTravel + 44) * px, 44 * px),
                            cornerRadius = androidx.compose.ui.geometry.CornerRadius(22 * px, 22 * px),
                            style = Stroke(2.dp.toPx())
                        )
                    }
                }
                NeumorphSurface(Modifier.offset((x + g.pinTravel * fraction - 20 + recoil.value).dp, (g.cy - 20).dp).size(40.dp),
                    CircleShape, shadowScale = if (on) 0.6f else 0.28f) {
                    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                        if (pending == null) {
                            DialAgentMark(kind, !on || offline)
                            DialAgentBadges(kind, on && !offline, status)
                        } else Canvas(Modifier.size(29.dp)) {
                            if (queued) drawCircle(color, style = Stroke(1.5.dp.toPx(), pathEffect = PathEffect.dashPathEffect(floatArrayOf(4.dp.toPx(), 3.dp.toPx()))))
                            else drawArc(color, spin, 260f, useCenter = false, style = Stroke(1.5.dp.toPx()))
                        }
                    }
                }
                Box(Modifier.offset((x - 24).dp, (g.cy - 24).dp).size((g.pinTravel + 48).dp, 48.dp)
                    .testTag("agent-enablement-$kind").orbisKeyboardFocus().onPreviewKeyEvent { event ->
                        if (event.type != KeyEventType.KeyDown || !canEdit) false else {
                            val targetEnabled = when (event.key) { Key.DirectionRight -> true; Key.DirectionLeft -> false; Key.Spacebar, Key.Enter -> !(pending?.target ?: on); else -> null }
                            targetEnabled?.let(onToggle); targetEnabled != null
                        }
                    }.focusable(enabled = active && canEdit).pointerInput(hostId, kind, active) {
                        if (active) detectTapGestures(onTap = { currentNudge() })
                    }.semantics {
                        role = Role.Switch; contentDescription = label; stateDescription = L10n.tr(hint ?: status.label)
                        toggleableState = if (on) ToggleableState.On else ToggleableState.Off
                        if (!canEdit) disabled()
                        else {
                            val targetEnabled = !(pending?.target ?: on)
                            val action = L10n.tr(if (targetEnabled) "启用" else "停用")
                            customActions = listOf(CustomAccessibilityAction(action) { onToggle(targetEnabled); true })
                            onClick(action) { onToggle(targetEnabled); true }
                        }
                    })
            }
        }
    }
}

@Composable
private fun DialAgentMark(kind: String, muted: Boolean) {
    val brand = knownAgentBrand(kind)
    if (brand == null) Icon(OrbisSymbols.Computer, null, Modifier.size(20.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
    else Box(Modifier.graphicsLayer { alpha = if (muted) 0.50f else 1f }, contentAlignment = Alignment.Center) {
        AgentIcon(brand, Modifier.size(20.dp), tintOverride = if (muted) LocalOrbisPalette.current.faint else null)
    }
}

@Composable
private fun BoxScope.DialAgentBadges(kind: String, showStatusDot: Boolean, status: AgentDialStatus) {
    val palette = LocalOrbisPalette.current
    val secondary = MaterialTheme.colorScheme.onSurfaceVariant
    if (showStatusDot) {
        Canvas(Modifier.align(Alignment.TopEnd).padding(5.dp).size(7.dp)) {
            val dotColor = when {
                status.tone == "success" -> palette.success
                status.label == "可启动" -> secondary
                status.tone == "warning" -> palette.warning
                status.tone == "error" -> palette.danger
                else -> palette.faint
            }
            if (status.label == "可启动") drawCircle(dotColor, style = Stroke(1.5.dp.toPx()))
            else drawCircle(dotColor)
        }
    }
    val variant = agentDialVariant(kind)
    if (variant != null) {
        NeumorphSurface(Modifier.align(Alignment.BottomEnd).padding(2.dp).size(14.dp), CircleShape, shadowScale = 0.25f) {
            Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                Icon(if (variant == "terminal") OrbisSymbols.Terminal else OrbisSymbols.Computer,
                    null, Modifier.size(9.dp), tint = secondary)
            }
        }
    }
}

@Composable
private fun ProviderQuotaPair(state: RemoteState, kind: String, provider: AgentProvider?, canQuery: Boolean,
    onQuery: (AgentProvider) -> Unit) {
    val snapshot = provider?.let { state.subscriptionQuotas[kind]?.takeIf { q -> q.providerId == it.id } }
    val operation = state.agentProviders
    val loading = operation.quotaRequestId != null && operation.quotaProviderId == provider?.id && operation.quotaKind == kind
    val available = provider?.let { it.enabled && it.official && it.subscriptionSupported } == true
    var queried by remember(state.hostId, kind, provider?.id) { mutableStateOf(false) }
    LaunchedEffect(canQuery, provider?.id, available) {
        if (canQuery && available && !queried && snapshot == null && !loading) { queried = true; provider?.let(onQuery) }
    }
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Box(Modifier.fillMaxWidth().heightIn(min = 112.dp).testTag("provider-quota-pair"), contentAlignment = Alignment.CenterStart) {
            if (!available) StatusWithInfo(L10n.tr("配额不可用"),
                if (provider?.subscriptionSupported == true) L10n.tr("启用后可查询配额") else L10n.tr("这个配置不提供配额查询"))
            else Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(20.dp)) {
                listOf("five_hour", "seven_day").forEach { name ->
                    val window = snapshot?.quota?.windows?.firstOrNull { it.name == name }
                    val resetCountdown = subscriptionQuotaResetCountdownLabel(window?.resetsAt)
                    val percent = window?.remainingPercent
                    val low = percent != null && percent <= 20
                    val color = if (low) LocalOrbisPalette.current.danger else MaterialTheme.colorScheme.primary
                    val progress by animateFloatAsState(((percent ?: 0.0) / 100).toFloat(),
                        tween(InteractionMotion.duration(InteractionMotion.State)), label = "quota-progress")
                    Column(Modifier.weight(1f).testTag("provider-quota-$name"), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                            Text(if (name == "five_hour") L10n.tr("5 小时") else L10n.tr("7 天"),
                                style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                            if (low) { Icon(OrbisSymbols.Warning, null, Modifier.size(12.dp), tint = color)
                                Text(L10n.tr("即将用完"), style = MaterialTheme.typography.labelSmall, color = color) }
                        }
                        MotionText(percent?.let { String.format(L10n.locale, "%.0f%%", it) } ?: "—",
                            style = MaterialTheme.typography.displaySmall, color = if (low) color else MaterialTheme.colorScheme.onSurface)
                        NeumorphSurface(Modifier.fillMaxWidth().height(6.dp), CircleShape, NeumorphStyle.Pressed, shadowScale = 0.4f) {
                            Box(Modifier.fillMaxWidth().height(6.dp)) {
                                Box(Modifier.fillMaxWidth(progress.coerceIn(0f, 1f)).height(6.dp).background(color, CircleShape))
                            }
                        }
                        // A manual refresh keeps the last reading visible, so the caption carries the in-flight state.
                        Text(if (loading) L10n.tr("查询中") else resetCountdown
                            ?: L10n.tr("暂不可用"), style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.fillMaxWidth())
                    }
                }
                // Always present: every tap after the automatic first query is a fresh subscription read.
                NeumorphIconButton({ provider?.let(onQuery) }, OrbisSymbols.Refresh,
                    L10n.tr("刷新配额"), enabled = canQuery && !loading, modifier = Modifier.testTag("provider-query"))
            }
        }
        if (available && !loading) snapshot?.error?.let { error ->
            InlineFeedbackError(error, Modifier.testTag("provider-quota-error"))
        }
    }
}
