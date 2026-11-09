package com.orbising.orbis

import android.animation.ValueAnimator
import androidx.activity.compose.LocalOnBackPressedDispatcherOwner
import androidx.compose.animation.core.*
import androidx.compose.foundation.Canvas
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
import java.text.DateFormat
import java.util.Date
import kotlin.math.*

private val DIAL_AGENTS = listOf("codex", "claude", "dsh", "pi")

/** Browsing is local. Only the settled primary action may request a provider change. */
@Composable
internal fun ProviderDialScreen(state: RemoteState, hosts: List<HostSnapshot>, onSelectHost: (String) -> Unit,
    onLoad: (String) -> Unit, onEnable: (AgentProvider, String?) -> Unit,
    onQuerySubscription: (AgentProvider, String?) -> Unit, showBack: Boolean = true) {
    val active = LocalPageActive.current
    var kind by rememberSaveable(state.hostId) { mutableStateOf("codex") }
    var previewId by rememberSaveable(state.hostId, kind) { mutableStateOf("") }
    var moving by remember { mutableStateOf(false) }
    var hostMenu by remember { mutableStateOf(false) }
    var pending by remember { mutableStateOf<Pair<String, AgentProvider>?>(null) }
    val hostId = state.hostId
    val connected = hostId != null && state.e2eReady && state.connection == RelayConnection.ONLINE
    val providers = state.providersForKind(kind)
    val preview = providers.firstOrNull { it.id == previewId } ?: state.currentProviderForKind(kind) ?: providers.firstOrNull()
    val currentIndex = providers.indexOf(preview).coerceAtLeast(0)
    val operation = state.agentProviders.takeIf { it.hostId == hostId && it.kind == kind }
    val canUse = active && connected && state.canUseProviders(kind) && !moving
    val haptic = rememberActionHaptic()
    LaunchedEffect(active, hostId, kind, connected) { pending = null; if (active && connected) onLoad(kind) }
    LaunchedEffect(hostId, kind, providers.map { it.id }) {
        previewId = state.currentProviderForKind(kind)?.id ?: providers.firstOrNull()?.id.orEmpty()
    }
    Column(Modifier.fillMaxSize().background(MaterialTheme.colorScheme.surface).statusBarsPadding()
        .then(if (showBack) Modifier.navigationBarsPadding() else Modifier)) {
        RemoteTopAppBar(title = { Text(L10n.tr("供应商")) }, navigationIcon = {
            if (showBack) {
                val dispatcher = LocalOnBackPressedDispatcherOwner.current
                NeumorphIconButton({ dispatcher?.onBackPressedDispatcher?.onBackPressed() }, OrbisSymbols.ArrowBack, L10n.tr("返回"))
            }
        })
        Row(Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 16.dp), verticalAlignment = Alignment.CenterVertically,
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
            Text(L10n.tr("{0} 个配置", providers.size),
                modifier = Modifier.weight(1f).testTag("provider-summary"), style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        DualProviderDial(kind, providers, currentIndex, hostId, active,
            onKind = { next -> if (kind != next) { kind = next; previewId = "" } },
            onBrowse = { previewId = providers.getOrNull(it)?.id.orEmpty() },
            onMoving = { moving = it }, modifier = Modifier.fillMaxWidth().weight(1f).heightIn(min = 300.dp))
        AgentTheme(agentBrand(kind)) {
            Column(Modifier.fillMaxWidth().padding(horizontal = 20.dp).padding(bottom = 16.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp)) {
                ProviderQuotaPair(state, kind, preview, canQuery = canUse,
                    onQuery = { selected -> onQuerySubscription(selected, hostId) })
                operation?.error?.let { Text(it, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.error) }
                state.providerCatalogProblems[kind]?.let { Text(it, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.error) }
                val title = when {
                    operation?.requestId != null -> L10n.tr("正在切换配置")
                    preview == null -> if (operation?.loading == true) L10n.tr("正在读取供应商") else L10n.tr("当前没有可用供应商")
                    preview.additive && preview.enabled -> L10n.tr("移出 {0}", preview.name)
                    preview.additive -> L10n.tr("启用 {0}", preview.name)
                    preview.enabled -> L10n.tr("正在使用 {0}", preview.name)
                    else -> L10n.tr("切换到 {0}", preview.name)
                }
                NeumorphActionButton(text = title, modifier = Modifier.fillMaxWidth().testTag("provider-apply"),
                    enabled = canUse && preview != null && (!preview.enabled || preview.additive),
                    icon = if (preview?.enabled == true) OrbisSymbols.Check else OrbisSymbols.SwapHoriz,
                    onClick = {
                        val selected = preview ?: return@NeumorphActionButton
                        val fresh = state.providersForKind(kind).firstOrNull { it.id == selected.id }?.takeIf { it == selected }
                        if (fresh != null && canUse && hostId != null) {
                            if (fresh.additive) { haptic(); onEnable(fresh, hostId) }
                            else pending = hostId to fresh
                        }
                    })
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
                    Text(if (providers.isEmpty()) "0 / 0" else "${currentIndex + 1} / ${providers.size}",
                        style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                if (!connected) Text(L10n.tr("等待电脑连接"), style = MaterialTheme.typography.labelMedium, color = LocalOrbisPalette.current.warning)
            }
        }
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
private fun DualProviderDial(kind: String, providers: List<AgentProvider>, selectedIndex: Int, hostId: String?, active: Boolean,
    onKind: (String) -> Unit, onBrowse: (Int) -> Unit, onMoving: (Boolean) -> Unit, modifier: Modifier = Modifier) {
    val density = LocalDensity.current
    val scope = rememberCoroutineScope()
    var agentPosition by remember(hostId) { mutableFloatStateOf(DIAL_AGENTS.indexOf(kind).toFloat()) }
    var itemPosition by remember(hostId, kind) { mutableFloatStateOf(selectedIndex.toFloat()) }
    var grabbed by remember { mutableStateOf<ProviderDialRing?>(null) }
    var settleJob by remember { mutableStateOf<Job?>(null) }
    val currentKind by rememberUpdatedState(kind)
    val currentProviders by rememberUpdatedState(providers)
    val currentOnKind by rememberUpdatedState(onKind)
    val currentOnBrowse by rememberUpdatedState(onBrowse)
    val currentOnMoving by rememberUpdatedState(onMoving)
    val tick = rememberActionHaptic()
    val pointerPop = remember { Animatable(1f) }
    val agentPop = remember { Animatable(1f) }
    LaunchedEffect(itemPosition.roundToInt()) {
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
    val accent = agentBrand(kind).accent()
    LaunchedEffect(hostId, kind, selectedIndex) {
        if (grabbed == null && settleJob?.isActive != true) {
            agentPosition = DIAL_AGENTS.indexOf(kind).coerceAtLeast(0).toFloat()
            itemPosition = selectedIndex.toFloat()
        }
    }
    DisposableEffect(hostId, active) { onDispose { settleJob?.cancel(); currentOnMoving(false) } }
    fun settle(ring: ProviderDialRing, target: Int) {
        settleJob?.cancel()
        val maxIndex = if (ring == ProviderDialRing.Agent) DIAL_AGENTS.lastIndex else currentProviders.lastIndex.coerceAtLeast(0)
        val end = target.coerceIn(0, maxIndex)
        val from = if (ring == ProviderDialRing.Agent) agentPosition else itemPosition
        currentOnMoving(true)
        settleJob = scope.launch {
            animate(from, end.toFloat(), animationSpec = tween(InteractionMotion.duration(
                InteractionMotion.Panel + min(240, (abs(end - from) * 90).roundToInt())), easing = Easing { 1 - (1-it).pow(3) })) { value, _ ->
                if (ring == ProviderDialRing.Agent) agentPosition = value else itemPosition = value
            }
            if (ring == ProviderDialRing.Agent) currentOnKind(DIAL_AGENTS[end]) else currentOnBrowse(end)
            currentOnMoving(false)
        }
    }
    BoxWithConstraints(modifier.clipToBounds().testTag("provider-dual-dial")) {
        val height = maxHeight.value
        val width = maxWidth.value
        val g = DualDialGeometry.measure(width, height)
        val latestGeometry = rememberUpdatedState(g)
        val px = density.density
        Box(Modifier.fillMaxSize().pointerInput(hostId, active) {
            if (!active) return@pointerInput
            awaitEachGesture {
                val down = awaitFirstDown(requireUnconsumed = false)
                val gestureGeometry = latestGeometry.value
                val ring = gestureGeometry.ringAt(down.position.x / px, down.position.y / px) ?: return@awaitEachGesture
                settleJob?.cancel()
                currentOnMoving(false)
                val start = if (ring == ProviderDialRing.Agent) agentPosition.roundToInt().toFloat() else itemPosition
                val velocity = VelocityTracker()
                velocity.addPosition(down.uptimeMillis, down.position)
                var moved = false
                var cancelled = false
                var released = false
                try {
                    while (true) {
                        val event = awaitPointerEvent()
                        val change = event.changes.firstOrNull { it.id == down.id }
                        if (change == null) { cancelled = true; break }
                        velocity.addPosition(change.uptimeMillis, change.position)
                        if (!change.pressed) { released = !change.isConsumed || moved; break }
                        val dy = (change.position.y - down.position.y) / px
                        if (!moved && abs(dy) > if (ring == ProviderDialRing.Agent) 10f else 4f) {
                            moved = true
                            grabbed = ring
                            currentOnMoving(true)
                        }
                        if (moved) {
                            if (ring == ProviderDialRing.Agent) {
                                val raw = DualDialGeometry.soften(start - dy / 84f, DIAL_AGENTS.size)
                                val next = raw.roundToInt().coerceIn(0, DIAL_AGENTS.lastIndex)
                                if (DIAL_AGENTS[next] != currentKind) { tick(); currentOnKind(DIAL_AGENTS[next]) }
                                agentPosition = DualDialGeometry.sticky(raw)
                            } else {
                                val raw = start - dy / gestureGeometry.profilePitch
                                val next = DualDialGeometry.soften(raw, currentProviders.size)
                                if (next.roundToInt() != itemPosition.roundToInt()) tick()
                                itemPosition = next
                                currentOnBrowse(next.roundToInt().coerceIn(0, currentProviders.lastIndex.coerceAtLeast(0)))
                            }
                            change.consume()
                        }
                    }
                } finally {
                    if (moved) {
                        grabbed = null
                        currentOnMoving(false)
                    }
                }
                // Child labels own taps. Only a drag may cancel their click and settle the ring.
                if (moved && released && !cancelled) {
                    if (ring == ProviderDialRing.Agent) settle(ring, agentPosition.roundToInt())
                    else settle(ring, (itemPosition - if (moved) velocity.calculateVelocity().y / px / gestureGeometry.profilePitch * 0.14f else 0f).roundToInt())
                }
            }
        }) {
            fun Modifier.disc(radius: Float) = wrapContentSize(Alignment.TopStart, unbounded = true)
                .offset(x = (g.cx - radius).dp, y = (g.cy - radius).dp).requiredSize((radius * 2).dp)
            // These are the independent physical rings of the component, each with one frame.
            CompositionLocalProvider(LocalOrbisSurface provides null) {
                NeumorphSurface(Modifier.disc(g.radius), CircleShape, shadowScale = 1f) {}
                NeumorphSurface(Modifier.disc(g.seamRadius), CircleShape, NeumorphStyle.Pressed, shadowScale = 0.4f) {}
                NeumorphSurface(Modifier.disc(g.hubRadius).graphicsLayer { alpha = if (grabbed == ProviderDialRing.Profile) 0.4f else 1f },
                    CircleShape, shadowScale = if (grabbed == ProviderDialRing.Agent) 0.65f else 0.4f) {}
                NeumorphSurface(Modifier.disc(g.holeRadius), CircleShape, NeumorphStyle.Pressed, shadowScale = 0.65f) {}
                NeumorphSurface(Modifier.offset(x = (g.cx + g.agentRadius - 20).dp, y = (g.cy - 20).dp).size(40.dp)
                    .graphicsLayer { scaleX = agentPop.value; scaleY = agentPop.value },
                    CircleShape, NeumorphStyle.Pressed, shadowScale = 0.4f) {}
            }
            Canvas(Modifier.fillMaxSize()) {
                val centre = Offset(g.cx * px, g.cy * px)
                fun point(r: Float, angle: Float) = centre + Offset(cos(angle) * r * px, sin(angle) * r * px)
                val itemStep = Math.toRadians(g.profileStep.toDouble()).toFloat()
                for (i in 0 until 120) {
                    val a = Math.toRadians((i * 3 - itemPosition * g.profileStep).toDouble()).toFloat()
                    val length = if (i % 8 == 0) 18 else if (i % 4 == 0) 12 else 8
                    drawLine(palette.faint, point(g.radius - length, a), point(g.radius - 6, a), strokeWidth = 1.dp.toPx())
                }
                providers.forEachIndexed { index, provider ->
                    val a = (index - itemPosition) * itemStep
                    drawCircle(if (provider.enabled) palette.success else palette.faint, 3.dp.toPx(), point(g.radius - 32, a))
                }
                repeat(100) { index ->
                    val a = index * (2 * PI / 100).toFloat()
                    drawCircle(palette.faint.copy(alpha = 0.45f), 0.8.dp.toPx(), point(g.hubRadius - 6, a))
                }
                drawCircle(accent, 3.dp.toPx() * pointerPop.value, Offset((g.cx + g.radius + 8) * px, g.cy * px))
            }
            DIAL_AGENTS.forEachIndexed { index, agent ->
                val angle = Math.toRadians(((index - agentPosition) * g.agentStep).toDouble())
                val x = g.cx + g.agentRadius * cos(angle).toFloat()
                val y = g.cy + g.agentRadius * sin(angle).toFloat()
                if (x >= 12 && y in 20f..(height - 20)) Box(Modifier.offset(x = (x-24).dp, y = (y-24).dp).size(48.dp)
                    .testTag("provider-agent-$agent")
                    .graphicsLayer { alpha = if (grabbed == ProviderDialRing.Profile || agent != kind) 0.4f else 1f }
                    .orbisKeyboardFocus().clickable(enabled = active,
                        interactionSource = remember { MutableInteractionSource() }, indication = null) { tick(); settle(ProviderDialRing.Agent, index) }, contentAlignment = Alignment.Center) {
                    AgentIcon(agentBrand(agent), Modifier.size(20.dp))
                }
            }
            providers.forEachIndexed { index, provider ->
                val angle = Math.toRadians(((index - itemPosition) * g.profileStep).toDouble())
                val x = g.cx + (g.radius + 28) * cos(angle).toFloat()
                val y = g.cy + (g.radius + 28) * sin(angle).toFloat()
                if (y in -40f..(height + 40)) {
                    val selected = index == itemPosition.roundToInt().coerceIn(0, providers.lastIndex)
                    Column(Modifier.offset(x = x.dp, y = (y - if (selected) 44 else 16).dp).width((width - x - 16).coerceIn(64f,136f).dp).heightIn(min = 48.dp)
                        .graphicsLayer { alpha = if (grabbed == ProviderDialRing.Agent) 0.4f else if (selected) 1f else 0.6f }
                        .orbisKeyboardFocus().clickable(enabled = active,
                            interactionSource = remember { MutableInteractionSource() }, indication = null) { settle(ProviderDialRing.Profile, index) },
                        verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        if (selected) Text(agentBrand(kind).title, style = MaterialTheme.typography.labelSmall, color = accent)
                        Text(provider.name, style = if (selected) MaterialTheme.typography.titleLarge else MaterialTheme.typography.labelMedium,
                            maxLines = 1, overflow = TextOverflow.Ellipsis, color = MaterialTheme.colorScheme.onSurface)
                        if (selected) {
                            Text(if (provider.official) L10n.tr("官方配置") else L10n.tr("已保存的配置"),
                                style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                            if (provider.enabled) Text(if (provider.additive) L10n.tr("已启用") else L10n.tr("使用中"),
                                style = MaterialTheme.typography.labelSmall, color = palette.success)
                        }
                    }
                }
            }
            // Two distinct keyboard/accessible sliders mirror the physical rings without remote writes.
            @Composable
            fun Modifier.keyboardRing(ring: ProviderDialRing, position: Float, lastIndex: Int): Modifier =
                orbisKeyboardFocus().onPreviewKeyEvent { event ->
                    if (!active || event.type != KeyEventType.KeyDown) false else {
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
            Box(Modifier.offset(x = 20.dp).width((g.cx + g.hubRadius - 20).coerceAtLeast(48f).dp).fillMaxHeight()
                .testTag("provider-agent-reel").keyboardRing(ProviderDialRing.Agent,agentPosition,DIAL_AGENTS.lastIndex).semantics {
                    contentDescription = "Agent"; stateDescription = agentBrand(kind).title
                    progressBarRangeInfo = ProgressBarRangeInfo(agentPosition.coerceIn(0f, 3f), 0f..3f, 2)
                    setProgress { target -> if (!active) false else { settle(ProviderDialRing.Agent, target.roundToInt()); true } }
                })
            Box(Modifier.offset(x = (g.cx + g.seamRadius).dp).fillMaxSize().testTag("provider-arc").keyboardRing(ProviderDialRing.Profile,itemPosition,providers.lastIndex).semantics {
                contentDescription = L10n.tr("{0} 的配置", agentBrand(kind).title)
                stateDescription = providers.getOrNull(selectedIndex)?.name ?: L10n.tr("当前没有可用供应商")
                progressBarRangeInfo = ProgressBarRangeInfo(itemPosition.coerceIn(0f, providers.lastIndex.coerceAtLeast(0).toFloat()),
                    0f..providers.lastIndex.coerceAtLeast(0).toFloat(), (providers.size - 2).coerceAtLeast(0))
                setProgress { target -> if (!active || providers.isEmpty()) false else { settle(ProviderDialRing.Profile, target.roundToInt()); true } }
            })
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
    Box(Modifier.fillMaxWidth().heightIn(min = 112.dp).testTag("provider-quota-pair"), contentAlignment = Alignment.CenterStart) {
        if (!available) Text(if (provider?.subscriptionSupported == true) L10n.tr("启用后可查询配额") else L10n.tr("这个配置不提供配额查询"),
            style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        else Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(20.dp)) {
            listOf("five_hour", "seven_day").forEach { name ->
                val window = snapshot?.quota?.windows?.firstOrNull { it.name == name }
                val percent = window?.remainingPercent
                val low = percent != null && percent <= 20
                val color = if (low) LocalOrbisPalette.current.danger else MaterialTheme.colorScheme.primary
                val progress by animateFloatAsState(((percent ?: 0.0) / 100).toFloat(),
                    tween(InteractionMotion.duration(InteractionMotion.State)), label = "quota-progress")
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
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
                    Text(window?.resetsAt?.let { L10n.tr("重置 {0}", DateFormat.getDateTimeInstance(DateFormat.SHORT, DateFormat.SHORT, L10n.locale).format(Date(it))) }
                        ?: if (loading) L10n.tr("查询中") else L10n.tr("暂不可用"), style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
            }
            if (snapshot?.error != null || !loading && snapshot?.quota == null) NeumorphIconButton({ provider?.let(onQuery) }, OrbisSymbols.Refresh,
                L10n.tr("查询订阅配额"), enabled = canQuery && !loading, modifier = Modifier.testTag("provider-query"))
        }
    }
}
