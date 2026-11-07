package com.orbising.orbis

import android.animation.ValueAnimator
import androidx.activity.compose.LocalOnBackPressedDispatcherOwner
import androidx.compose.animation.core.Easing
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animate
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.awaitTouchSlopOrCancellation
import androidx.compose.foundation.gestures.drag
import androidx.compose.foundation.gestures.detectHorizontalDragGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.asPaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.ArrowBack
import androidx.compose.material.icons.rounded.ExpandMore
import androidx.compose.material.icons.rounded.Refresh
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Slider
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.saveable.mapSaver
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.draw.drawWithCache
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.BlendMode
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.CompositingStrategy
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.util.VelocityTracker
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.ProgressBarRangeInfo
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.disabled
import androidx.compose.ui.semantics.progressBarRangeInfo
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.setProgress
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import kotlin.math.atan2
import kotlin.math.cos
import kotlin.math.roundToInt
import kotlin.math.sin
import kotlin.math.sqrt

private val PROVIDER_DIAL_AGENTS = listOf("claude", "codex", "dsh", "pi")

private data class ProviderDialBrowseState(
    val claude: String = "",
    val codex: String = "",
    val dsh: String = "",
    val pi: String = "",
) {
    fun id(kind: String): String = when (kind) {
        "claude" -> claude
        "codex" -> codex
        "dsh" -> dsh
        else -> pi
    }

    fun with(kind: String, id: String): ProviderDialBrowseState = when (kind) {
        "claude" -> copy(claude = id)
        "codex" -> copy(codex = id)
        "dsh" -> copy(dsh = id)
        else -> copy(pi = id)
    }
}

private val ProviderDialBrowseSaver = mapSaver(
    save = { value -> mapOf("claude" to value.claude, "codex" to value.codex, "dsh" to value.dsh, "pi" to value.pi) },
    restore = { value -> ProviderDialBrowseState(
        claude = value["claude"] as? String ?: "", codex = value["codex"] as? String ?: "",
        dsh = value["dsh"] as? String ?: "", pi = value["pi"] as? String ?: "",
    ) },
)

private data class ProviderDialPalette(
    val background: Color,
    val panel: Color,
    val surface: Color,
    val ink: Color,
    val muted: Color,
    val line: Color,
    val edge: Color,
    val accent: Color,
    val light: Color,
    val shadow: Color,
    val face: Color,
    val neumorph: NeumorphColors,
)

@Composable
private fun providerDialPalette(): ProviderDialPalette {
    val dark = LocalOrbisDarkTheme.current
    return if (dark) {
        val bg = Color(0xFF2C2E31)
        val panel = Color(0xFF303236)
        val surface = Color(0xFF34363A)
        val light = Color(0xFF414449)
        val shadow = Color(0xFF1D1F22)
        ProviderDialPalette(
            background = bg, panel = panel, surface = surface,
            ink = Color(0xFFEEEFEF), muted = Color(0xFF9B9EA4),
            line = Color(0x0BFFFFFF), edge = Color(0x0AFFFFFF),
            accent = Color(0xFFD3D9D5), light = light, shadow = shadow, face = panel,
            neumorph = NeumorphColors(
                base = bg, lightShadow = light, darkShadow = shadow, insetBase = panel,
                lift = panel, top = surface, scrim = shadow,
                darkShadowOpacity = 0.46f, lightShadowOpacity = 0.34f,
            ),
        )
    } else {
        val bg = Color(0xFFE5E7E9)
        val panel = Color(0xFFE5E7E9)
        val surface = Color(0xFFEAEDEF)
        val light = Color.White
        val shadow = Color(0xFFBDC2C8)
        ProviderDialPalette(
            background = bg, panel = panel, surface = surface,
            ink = Color(0xFF373B41), muted = Color(0xFF7C8188),
            line = Color(0x10363B44), edge = Color(0x90FFFFFF),
            accent = Color(0xFF555F59), light = light, shadow = shadow, face = bg,
            neumorph = NeumorphColors(
                base = bg, lightShadow = light, darkShadow = shadow, insetBase = panel,
                lift = panel, top = surface, scrim = shadow,
                darkShadowOpacity = 0.34f, lightShadowOpacity = 0.55f,
            ),
        )
    }
}

private val ProviderDialEaseOutCubic = Easing { fraction ->
    val inverse = 1f - fraction
    1f - inverse * inverse * inverse
}
private val ProviderDialEaseOutQuartic = Easing { fraction ->
    val inverse = 1f - fraction
    1f - inverse * inverse * inverse * inverse
}

private fun providerAgentShort(kind: String): String = when (kind) {
    "claude" -> "Claude"
    "codex" -> "Codex"
    "dsh" -> "DeepSeek"
    else -> "Pi"
}

private fun providerAgentMark(kind: String): String = when (kind) {
    "claude" -> "✳"
    "codex" -> ">_"
    "dsh" -> "≈"
    else -> "π"
}

private fun providerLabel(provider: AgentProvider): String {
    val id = provider.id.lowercase()
    val name = provider.name.lowercase()
    return when {
        provider.official -> "官方配置"
        "workspace" in id || "workspace" in name || "工作区" in name -> "工作区配置"
        "personal" in id || "personal" in name || "个人" in name -> "个人配置"
        provider.additive -> "附加配置"
        else -> "已保存的配置"
    }
}

/** Home provider tab: browsing previews a profile; the right pointer is the explicit switch gesture. */
@Composable
internal fun ProviderDialScreen(
    state: RemoteState,
    hosts: List<HostSnapshot>,
    onSelectHost: (String) -> Unit,
    onLoad: (String) -> Unit,
    onEnable: (AgentProvider, String?) -> Unit,
    onQuerySubscription: (AgentProvider, String?) -> Unit,
    showBack: Boolean = true,
) {
    OrbisMaterialTheme {
        val active = LocalPageActive.current
        val palette = providerDialPalette()
        val dispatcherOwner = checkNotNull(LocalOnBackPressedDispatcherOwner.current)
        var kind by rememberSaveable(state.hostId) { mutableStateOf("codex") }
        var hostMenu by remember { mutableStateOf(false) }
        var browse by rememberSaveable(state.hostId, stateSaver = ProviderDialBrowseSaver) { mutableStateOf(ProviderDialBrowseState()) }
        var dialOffset by remember { mutableFloatStateOf(0f) }
        var singleProviderTurns by rememberSaveable(state.hostId) { mutableFloatStateOf(0f) }

        val hostId = state.hostId
        val connected = hostId != null && state.connection == RelayConnection.ONLINE && state.e2eReady
        val providers = state.providersForKind(kind)
        val baseIndex = providers.indexOfFirst { it.id == browse.id(kind) }
            .takeIf { it >= 0 }
            ?: providers.indexOf(state.currentProviderForKind(kind)).takeIf { it >= 0 }
            ?: 0
        val previewIndex = if (providers.isEmpty()) 0 else ProviderDialGeometry.wrap(
            baseIndex + dialOffset.roundToInt(), providers.size,
        )
        val preview = providers.getOrNull(previewIndex)
        val canUse = active && connected && state.canUseProviders(kind)
        val canSwitch = canUse && preview != null && (!preview.enabled || preview.additive)
        val catalogIdentity = providers.map { listOf(it.id, it.name, it.enabled, it.additive, it.globalDefault, it.subscriptionSupported, it.official) }

        LaunchedEffect(active, hostId, kind, connected) {
            if (active && connected) onLoad(kind)
        }
        LaunchedEffect(active, hostId, kind, connected, catalogIdentity) {
            if (providers.none { it.id == browse.id(kind) }) {
                val nextId = state.currentProviderForKind(kind)?.id ?: providers.firstOrNull()?.id.orEmpty()
                browse = browse.with(kind, nextId)
            }
            dialOffset = 0f
            singleProviderTurns = 0f
        }
        val largeText = LocalDensity.current.fontScale >= 1.3f
        CompositionLocalProvider(LocalNeumorphColors provides palette.neumorph) {
            MaterialTheme(colorScheme = MaterialTheme.colorScheme.copy(
                primary = palette.accent,
                onPrimary = palette.background,
                background = palette.background,
                onBackground = palette.ink,
                surface = palette.panel,
                onSurface = palette.ink,
                surfaceVariant = palette.surface,
                onSurfaceVariant = palette.muted,
                outline = palette.line,
                error = Color(0xFFB85A54),
            )) {
                Box(Modifier.fillMaxSize().background(palette.background)) {
                    Column(
                        Modifier.fillMaxSize().statusBarsPadding()
                            .then(if (largeText) Modifier.verticalScroll(rememberScrollState()) else Modifier),
                    ) {
                        Row(
                            Modifier.fillMaxWidth().heightIn(min = 91.dp).padding(horizontal = 25.dp, vertical = 14.dp),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(17.dp),
                        ) {
                            if (showBack) {
                                NeumorphIconButton(
                                    onClick = { dispatcherOwner.onBackPressedDispatcher.onBackPressed() },
                                    icon = Icons.Rounded.ArrowBack,
                                    contentDescription = L10n.tr("返回"),
                                    size = 42.dp,
                                )
                            }
                            Column(Modifier.weight(1f), verticalArrangement = Arrangement.Center) {
                                Text(
                                    "INTEGRATIONS",
                                    color = palette.ink,
                                    fontSize = 21.sp,
                                    fontWeight = FontWeight.SemiBold,
                                    letterSpacing = (-0.45).sp,
                                    maxLines = 1,
                                )
                                Text(
                                    L10n.tr("Agent 供应商"),
                                    color = palette.muted,
                                    fontSize = 11.sp,
                                    letterSpacing = 0.5.sp,
                                    modifier = Modifier.padding(top = 4.dp),
                                    maxLines = 1,
                                )
                            }
                        }

                        ProviderAgentReel(
                            kind = kind,
                            hostId = hostId,
                            active = active,
                            onKind = { next ->
                                if (next != kind) {
                                    kind = next
                                    dialOffset = 0f
                                    singleProviderTurns = 0f
                                    onLoad(next)
                                }
                            },
                            modifier = Modifier.fillMaxWidth().padding(horizontal = 24.dp).padding(top = 4.dp),
                        )

                        Row(
                            Modifier.fillMaxWidth().heightIn(min = 49.dp)
                                .padding(start = 28.dp, end = 28.dp, top = 10.dp, bottom = 3.dp),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(0.dp),
                        ) {
                            Box {
                                Row(
                                    Modifier.heightIn(min = 30.dp).clickable(
                                        enabled = active && hosts.size > 1, role = Role.Button,
                                        onClick = { hostMenu = true },
                                    ),
                                    verticalAlignment = Alignment.CenterVertically,
                                    horizontalArrangement = Arrangement.spacedBy(5.dp),
                                ) {
                                    val hostTitle = hosts.firstOrNull { it.hostId == hostId }?.name
                                        ?: state.hostName?.takeIf(String::isNotBlank) ?: L10n.tr("已配对电脑")
                                    Text(hostTitle, color = palette.muted, fontSize = 10.sp, maxLines = 1,
                                        overflow = TextOverflow.Ellipsis)
                                    Icon(Icons.Rounded.ExpandMore, contentDescription = null,
                                        tint = palette.muted, modifier = Modifier.size(17.dp))
                                }
                                NeumorphMenu(expanded = hostMenu, onDismissRequest = { hostMenu = false }) {
                                    hosts.forEach { host ->
                                        NeumorphMenuItem(
                                            text = { Text(host.name) }, enabled = active && host.hostId != hostId,
                                            onClick = { hostMenu = false; onSelectHost(host.hostId) },
                                        )
                                    }
                                }
                            }
                            Spacer(Modifier.weight(1f))
                            Text(
                                if (kind == "pi") "Pi · 可同时启用多个" else "电脑已保存的配置",
                                color = palette.muted, fontSize = 9.sp, letterSpacing = 0.15.sp,
                                textAlign = TextAlign.End, maxLines = 1, overflow = TextOverflow.Ellipsis,
                            )
                        }

                        Box(
                            Modifier.fillMaxWidth().padding(top = 8.dp).heightIn(min = 280.dp)
                                .then(if (largeText) Modifier.height(460.dp) else Modifier.weight(1f)),
                        ) {
                            ProviderDialArc(
                                state = state, kind = kind, providers = providers, preview = preview, previewIndex = previewIndex,
                                baseIndex = baseIndex, dialOffset = dialOffset, active = active, connected = connected,
                                hostId = hostId,
                                canSwitch = canSwitch,
                                onSwitch = { selected ->
                                    val fresh = hostId?.let { expectedHost ->
                                        state.providersForKind(kind).firstOrNull { it.id == selected.id }
                                            ?.takeIf { it == selected && state.hostId == expectedHost &&
                                                active && connected && state.canUseProviders(kind) &&
                                                (!it.enabled || it.additive) }
                                    }
                                    if (fresh != null) onEnable(fresh, hostId)
                                },
                                rotationOffset = singleProviderTurns,
                                onBrowse = { selected, turns ->
                                    if (selected != null) browse = browse.with(kind, selected.id)
                                    if (providers.size == 1) singleProviderTurns = turns
                                    dialOffset = 0f
                                },
                                onDragOffset = { dialOffset = it },
                                modifier = Modifier.fillMaxSize(),
                            )
                        }
                        ProviderDialOperations(
                            state = state,
                            kind = kind,
                            provider = preview,
                            hostId = hostId,
                            active = active,
                            connected = connected,
                            canUse = canUse,
                            canSwitch = canSwitch,
                            onQuery = { selected, expectedHost ->
                                if (active && connected && state.hostId == expectedHost &&
                                    state.canUseProviders(kind) && selected.enabled && selected.official &&
                                    selected.subscriptionSupported) {
                                    onQuerySubscription(selected, expectedHost)
                                }
                            },
                        )
                    }

                }
            }
        }
    }
}

@Composable
private fun ProviderAgentReel(kind: String, hostId: String?, active: Boolean, onKind: (String) -> Unit, modifier: Modifier = Modifier) {
    val currentIndex = PROVIDER_DIAL_AGENTS.indexOf(kind).coerceAtLeast(0)
    val density = LocalDensity.current
    fun pitchPx(width: Float) = minOf(with(density) { 132.dp.toPx() }, width * 0.39f)
    var position by remember { mutableFloatStateOf(currentIndex.toFloat()) }
    val scope = rememberCoroutineScope()
    var settling by remember { mutableStateOf<Job?>(null) }
    val velocity = remember { VelocityTracker() }
    val motionEnabled = ValueAnimator.areAnimatorsEnabled()
    val palette = providerDialPalette()
    LaunchedEffect(kind, hostId, active) {
        settling?.cancel()
        position = currentIndex.toFloat()
    }
    fun choose(index: Int, commit: Boolean = true) {
        settling?.cancel()
        val next = PROVIDER_DIAL_AGENTS[ProviderDialGeometry.wrap(index, PROVIDER_DIAL_AGENTS.size)]
        if (!motionEnabled) {
            position = index.toFloat()
            if (commit) onKind(next)
        } else {
            settling = scope.launch {
                animate(position, index.toFloat(), animationSpec = tween(340, easing = ProviderDialEaseOutCubic)) { value, _ ->
                    position = value
                }
                if (commit) onKind(next)
            }
        }
    }
    Column(
        modifier.testTag("provider-agent-reel")
            .semantics(mergeDescendants = true) {
                val agentCount = PROVIDER_DIAL_AGENTS.size.toFloat()
                val progress = (((position % agentCount) + agentCount) % agentCount)
                    .coerceIn(0f, PROVIDER_DIAL_AGENTS.lastIndex.toFloat())
                progressBarRangeInfo = ProgressBarRangeInfo(progress, 0f..3f, 0)
                stateDescription = L10n.tr("{0}，{1} / 4", providerAgentShort(kind), currentIndex + 1)
                setProgress { requested ->
                    if (!active) false else {
                        val target = requested.roundToInt().coerceIn(0, PROVIDER_DIAL_AGENTS.lastIndex)
                        choose(target)
                        true
                    }
                }
                customActions = listOf(
                    CustomAccessibilityAction(L10n.tr("上一个 Agent")) { if (!active) false else { choose(currentIndex - 1); true } },
                    CustomAccessibilityAction(L10n.tr("下一个 Agent")) { if (!active) false else { choose(currentIndex + 1); true } },
                )
            },
        verticalArrangement = Arrangement.spacedBy(0.dp),
    ) {
        Row(
            Modifier.fillMaxWidth().padding(horizontal = 5.dp).padding(bottom = 9.dp).height(12.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text("AGENT", color = palette.muted, fontSize = 8.sp, lineHeight = 12.sp,
                letterSpacing = 1.12.sp, fontFamily = FontFamily.Monospace)
            Spacer(Modifier.weight(1f))
            Text(
                "左右拨动 · ${(currentIndex + 1).toString().padStart(2, '0')} / 04",
                color = palette.muted,
                fontSize = 9.sp,
                lineHeight = 12.sp,
                letterSpacing = 0.15.sp,
                maxLines = 1,
            )
        }
        BoxWithConstraints(
            Modifier.fillMaxWidth().height(67.dp)
                .clip(RoundedCornerShape(21.dp))
                .graphicsLayer { compositingStrategy = CompositingStrategy.Offscreen }
                .drawWithCache {
                    val fadeMask = Brush.horizontalGradient(
                        0f to Color.Transparent, 0.12f to Color.White,
                        0.88f to Color.White, 1f to Color.Transparent,
                    )
                    onDrawWithContent {
                        drawContent()
                        drawRect(fadeMask, blendMode = BlendMode.DstIn)
                    }
                }
                .pointerInput(active, kind, density) {
                    if (active) detectHorizontalDragGestures(
                        onDragStart = { settling?.cancel(); velocity.resetTracking() },
                        onDragEnd = {
                            val projected = position - velocity.calculateVelocity().x / pitchPx(size.width.toFloat()) * 0.10f
                            choose(projected.roundToInt().coerceIn(currentIndex - 3, currentIndex + 3))
                        },
                        onDragCancel = { choose(currentIndex, commit = false) },
                        onHorizontalDrag = { change, dragAmount ->
                            change.consume()
                            velocity.addPosition(change.uptimeMillis, change.position)
                            val stepPx = pitchPx(size.width.toFloat())
                            position = (position - dragAmount / stepPx).coerceIn(currentIndex - 3f, currentIndex + 3f)
                        },
                    )
                },
            contentAlignment = Alignment.Center,
        ) {
            NeumorphSurface(
                Modifier.fillMaxSize(), shape = RoundedCornerShape(21.dp),
                style = NeumorphStyle.Pressed, shadowScale = 0.48f,
            ) {}
            val step = minOf(132.dp, maxWidth * 0.39f)
            NeumorphSurface(
                Modifier.align(Alignment.Center).width(132.dp).height(53.dp),
                shape = RoundedCornerShape(15.dp),
                style = NeumorphStyle.Raised,
                shadowScale = 0.35f,
            ) {}
            val centerIndex = position.roundToInt()
            for (relative in -3..3) {
                val virtualIndex = centerIndex + relative
                val itemIndex = ProviderDialGeometry.wrap(virtualIndex, PROVIDER_DIAL_AGENTS.size)
                val itemKind = PROVIDER_DIAL_AGENTS[itemIndex]
                val distance = virtualIndex - position
                val absDistance = kotlin.math.abs(distance)
                val scale = 1f - minOf(absDistance, 2f) * 0.12f
                Box(
                    Modifier.align(Alignment.Center)
                        .offset(x = step * distance)
                        .width(132.dp).height(67.dp)
                        .graphicsLayer {
                            cameraDistance = with(density) { 480.dp.toPx() }
                            rotationY = -distance * 16f
                            scaleX = scale
                            scaleY = scale
                            alpha = maxOf(0f, 1f - absDistance * 0.65f)
                        }
                        .clickable(enabled = active, role = Role.RadioButton) { choose(virtualIndex) },
                    contentAlignment = Alignment.Center,
                ) {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(9.dp)) {
                        Text(providerAgentMark(itemKind), color = palette.muted, fontFamily = FontFamily.Monospace,
                            fontSize = 15.sp, letterSpacing = (-1).sp, maxLines = 1)
                        Text(providerAgentShort(itemKind), color = palette.ink, fontSize = 16.sp,
                            fontWeight = FontWeight.Medium, letterSpacing = (-0.35).sp, maxLines = 1)
                    }
                }
            }
            Box(
                Modifier.align(Alignment.BottomCenter).padding(bottom = 11.dp)
                    .width(13.dp).height(2.dp).clip(CircleShape).background(palette.accent.copy(alpha = 0.70f)),
            )
        }
        Row(
            Modifier.fillMaxWidth().height(17.dp),
            horizontalArrangement = Arrangement.Center,
            verticalAlignment = Alignment.Bottom,
        ) {
            for (index in PROVIDER_DIAL_AGENTS.indices) {
                Box(
                    Modifier.padding(horizontal = 2.5.dp).width(if (index == currentIndex) 13.dp else 4.dp)
                        .height(4.dp).clip(CircleShape)
                        .background(if (index == currentIndex) palette.accent.copy(alpha = 0.8f) else palette.muted.copy(alpha = 0.24f)),
                )
            }
        }
    }
}

@Composable
private fun ProviderDialArc(
    state: RemoteState,
    kind: String,
    providers: List<AgentProvider>,
    preview: AgentProvider?,
    previewIndex: Int,
    baseIndex: Int,
    dialOffset: Float,
    active: Boolean,
    connected: Boolean,
    hostId: String?,
    canSwitch: Boolean,
    onSwitch: (AgentProvider) -> Unit,
    rotationOffset: Float,
    onBrowse: (AgentProvider?, Float) -> Unit,
    onDragOffset: (Float) -> Unit,
    modifier: Modifier = Modifier,
) {
    val density = LocalDensity.current
    val palette = providerDialPalette()
    val scope = rememberCoroutineScope()
    val latestOffset by rememberUpdatedState(dialOffset)
    var settling by remember { mutableStateOf<Job?>(null) }
    val motionEnabled = ValueAnimator.areAnimatorsEnabled()
    LaunchedEffect(active, connected, hostId, kind, providers, baseIndex, rotationOffset) { settling?.cancel() }
    fun settle(offset: Float, commit: Boolean) {
        settling?.cancel()
        val target = if (commit) offset.roundToInt().toFloat() else 0f
        fun finish() {
            if (commit && providers.isNotEmpty()) {
                val selected = providers[ProviderDialGeometry.roundedIndex(baseIndex, target, providers.size)]
                val turns = if (providers.size == 1) {
                    ProviderDialGeometry.wrap(rotationOffset.roundToInt() + target.roundToInt(), 10).toFloat()
                } else 0f
                onBrowse(selected, turns)
            }
            onDragOffset(0f)
        }
        if (!motionEnabled) finish() else settling = scope.launch {
            animate(latestOffset, target, animationSpec = tween(460, easing = ProviderDialEaseOutQuartic)) { value, _ ->
                onDragOffset(value)
            }
            finish()
        }
    }
    val max = providers.lastIndex.coerceAtLeast(0)
    val position = baseIndex + (if (providers.size == 1) rotationOffset else 0f) + dialOffset
    val progressValue = if (providers.size <= 1) 0f else {
        val count = providers.size.toFloat()
        (((position % count) + count) % count).coerceIn(0f, max.toFloat())
    }
    BoxWithConstraints(
        modifier.clipToBounds().testTag("provider-arc")
            .semantics(mergeDescendants = false) {
                contentDescription = L10n.tr("供应商拨盘")
                progressBarRangeInfo = ProgressBarRangeInfo(progressValue, 0f..max.toFloat(), 0)
                stateDescription = preview?.let {
                    L10n.tr("{0}，{1}，{2} / {3}", agentBrand(kind).title, it.name, previewIndex + 1, providers.size) +
                        if (providers.size == 1) " · " + L10n.tr("拨盘转动 {0} 格", ProviderDialGeometry.wrap(position.roundToInt(), 10)) else ""
                }
                    ?: L10n.tr("{0} 没有可用供应商", agentBrand(kind).title)
                setProgress { requested ->
                    if (!active || providers.isEmpty()) false else {
                        settling?.cancel()
                        onBrowse(providers[requested.roundToInt().coerceIn(0, max)], 0f)
                        true
                    }
                }
                customActions = listOf(
                    CustomAccessibilityAction(L10n.tr("上一个供应商")) {
                        if (!active || providers.isEmpty()) false else if (providers.size == 1) {
                            onBrowse(providers.single(), ProviderDialGeometry.wrap(rotationOffset.roundToInt() - 1, 10).toFloat()); true
                        } else {
                            settling?.cancel()
                            onBrowse(providers[ProviderDialGeometry.wrap(previewIndex - 1, providers.size)], 0f); true
                        }
                    },
                    CustomAccessibilityAction(L10n.tr("下一个供应商")) {
                        if (!active || providers.isEmpty()) false else if (providers.size == 1) {
                            onBrowse(providers.single(), ProviderDialGeometry.wrap(rotationOffset.roundToInt() + 1, 10).toFloat()); true
                        } else {
                            settling?.cancel()
                            onBrowse(providers[ProviderDialGeometry.wrap(previewIndex + 1, providers.size)], 0f); true
                        }
                    },
                ) + if (canSwitch && preview != null) listOf(
                    CustomAccessibilityAction(
                        L10n.tr("沿指针外拉以{0}", if (preview.enabled) L10n.tr("停用") else L10n.tr("启用")),
                    ) {
                        val current = state.providersForKind(kind).firstOrNull { it.id == preview.id }
                        if (!active || !connected || !state.canUseProviders(kind) || current != preview) false
                        else { onSwitch(preview); true }
                    },
                ) else emptyList()
            }
            .pointerInput(active, hostId, kind, providers.map { it.id }, baseIndex, rotationOffset) {
                if (!active || providers.isEmpty()) return@pointerInput
                awaitEachGesture {
                    val down = awaitFirstDown(requireUnconsumed = false)
                    val width = size.width.toFloat()
                    val height = size.height.toFloat()
                    val radius = maxOf(with(density) { 350.dp.toPx() }, width * 1.15f, height * 0.8f)
                    val cx = width * 0.83f - radius
                    val cy = height / 2f
                    val dx = down.position.x - cx
                    val dy = down.position.y - cy
                    val distance = sqrt(dx * dx + dy * dy)
                    // Reserve the left system-back strip, just like the approved pointer implementation.
                    if (down.position.x < with(density) { 28.dp.toPx() } ||
                        distance <= radius * 0.16f || distance > radius + with(density) { 24.dp.toPx() }) {
                        return@awaitEachGesture
                    }
                    var previousAngle = atan2(dy, dx)
                    var angularTravel = 0f
                    val startOffset = latestOffset
                    var currentOffset = startOffset
                    fun track(point: Offset) {
                        val angle = atan2(point.y - cy, point.x - cx)
                        angularTravel += ProviderDialGeometry.normalizeAngle(angle - previousAngle)
                        previousAngle = angle
                        currentOffset = startOffset + ProviderDialGeometry.dragOffset(angularTravel, providers.size)
                        onDragOffset(currentOffset)
                    }
                    val slop = awaitTouchSlopOrCancellation(down.id) { change, _ ->
                        settling?.cancel()
                        track(change.position)
                        change.consume()
                    }
                    if (slop != null) {
                        val released = drag(slop.id) { change -> track(change.position); change.consume() }
                        settle(currentOffset, commit = released)
                    }
                }
            },
    ) {
        val radiusDp = maxOf(350f, maxWidth.value * 1.15f, maxHeight.value * 0.8f)
        val centerXDp = maxWidth.value * 0.83f - radiusDp
        val centerYDp = maxHeight.value / 2f
        val radialDp = radiusDp - 138f
        val panelWidth = 242.dp
        val panelHeight = 146.dp
        Canvas(Modifier.fillMaxSize()) {
            val r = radiusDp.dp.toPx()
            val center = Offset(centerXDp.dp.toPx(), centerYDp.dp.toPx())
            val rotation = position * (Math.PI / 5).toFloat()
            // All geometry is the PD03 design geometry, including its off-screen hub.
            val shadowExtent = 22.dp.toPx()
            drawCircle(Brush.radialGradient(
                0f to Color.Transparent, 0.93f to Color.Transparent,
                0.965f to palette.shadow.copy(alpha = 0.28f), 1f to Color.Transparent,
                center = center + Offset(10.dp.toPx(), 10.dp.toPx()), radius = r + shadowExtent,
            ), r + shadowExtent, center + Offset(10.dp.toPx(), 10.dp.toPx()))
            drawCircle(Brush.linearGradient(listOf(palette.surface, palette.background),
                start = center - Offset(r, r), end = center + Offset(r, r)), r, center)
            drawCircle(palette.edge, r - 0.5.dp.toPx(), center, style = Stroke(1.dp.toPx()))
            drawCircle(palette.edge, r - 11.dp.toPx(), center, style = Stroke(1.dp.toPx()))
            drawCircle(palette.line, r - 31.dp.toPx(), center, style = Stroke(1.dp.toPx()))
            val tickEdge = r - 14.dp.toPx()
            val tickRadius = tickEdge * 0.69f
            for (tick in 0 until 120) {
                drawArc(
                    color = palette.muted.copy(alpha = 0.25f),
                    startAngle = tick * 3f - 90.25f - Math.toDegrees(rotation.toDouble()).toFloat(),
                    sweepAngle = 0.25f,
                    useCenter = false,
                    topLeft = center - Offset(tickRadius, tickRadius),
                    size = Size(tickRadius * 2, tickRadius * 2),
                    style = Stroke(width = tickEdge * 0.008f),
                )
            }
            val anchor = position.roundToInt()
            for (slot in -4..4) {
                val angle = Math.toRadians(((anchor + slot + 0.5f) * 36f).toDouble()).toFloat() - rotation
                val start = r - 300.dp.toPx()
                val end = start + 285.dp.toPx()
                drawLine(Brush.linearGradient(listOf(Color.Transparent, palette.line, palette.line),
                    start = center + Offset(cos(angle) * start, sin(angle) * start),
                    end = center + Offset(cos(angle) * end, sin(angle) * end)),
                    center + Offset(cos(angle) * start, sin(angle) * start),
                    center + Offset(cos(angle) * end, sin(angle) * end), strokeWidth = 1.dp.toPx())
            }
            val hubR = r - minOf(r - 36.dp.toPx(), 300.dp.toPx())
            drawCircle(palette.background, hubR, center)
            drawCircle(palette.edge, hubR, center, style = Stroke(1.dp.toPx()))
            drawCircle(palette.light.copy(alpha = 0.24f), hubR - 1.dp.toPx(),
                center + Offset(1.dp.toPx(), 1.dp.toPx()), style = Stroke(2.dp.toPx()))
        }
        val anchor = position.roundToInt()
        val slots = (-4..4).toList()
        if (providers.isNotEmpty()) for (relative in slots) {
            val virtual = anchor + relative
            val index = ProviderDialGeometry.wrap(virtual, providers.size)
            val provider = providers[index]
            val angle = (virtual - position) * 36f
            val radians = Math.toRadians(angle.toDouble())
            val panelX = centerXDp + cos(radians).toFloat() * radialDp
            val panelY = centerYDp + sin(radians).toFloat() * radialDp
            val selected = relative == 0
            Column(
                Modifier.align(Alignment.TopStart)
                    .offset(panelX.dp - panelWidth / 2, panelY.dp - panelHeight / 2)
                    .size(panelWidth, panelHeight)
                    .graphicsLayer { rotationZ = angle; alpha = if (selected) 1f else 0.48f }
                    .then(if (selected) Modifier.testTag("provider-preview") else Modifier.clearAndSetSemantics {})
                    .padding(start = 16.dp, end = 22.dp, top = 13.dp, bottom = 13.dp),
                verticalArrangement = Arrangement.Center,
            ) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(13.dp)) {
                    Box(Modifier.size(29.dp).clip(CircleShape).background(palette.background)
                        .border(0.5.dp, palette.line, CircleShape), contentAlignment = Alignment.Center) {
                        Text((index + 1).toString().padStart(2, '0'), color = palette.muted,
                            fontSize = 10.sp, fontFamily = FontFamily.Monospace, maxLines = 1)
                    }
                    Text(providerAgentShort(kind).uppercase() + " / PROVIDER", color = palette.muted,
                        fontSize = 9.sp, letterSpacing = 1.08.sp, fontFamily = FontFamily.Monospace, maxLines = 1)
                }
                Text(provider.name, Modifier.fillMaxWidth().padding(top = 17.dp, bottom = 7.dp),
                    color = palette.ink, fontSize = 24.sp, fontWeight = FontWeight.SemiBold,
                    letterSpacing = (-0.7).sp, lineHeight = 27.6.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text(providerLabel(provider), color = palette.muted, fontSize = 11.sp, maxLines = 1)
                Row(Modifier.padding(top = 13.dp), verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(5.dp)) {
                    Text(if (provider.enabled) "✓" else "↗", fontSize = 11.sp,
                        color = if (provider.enabled) palette.accent else palette.muted)
                    Text((if (provider.enabled) L10n.tr("已启用") else L10n.tr("未启用")) +
                        if (provider.official) " · " + L10n.tr("官方") else "",
                        color = if (provider.enabled) palette.accent else palette.muted, fontSize = 9.sp, maxLines = 1)
                }
            }
        } else {
            Column(Modifier.align(Alignment.CenterStart).padding(start = 60.dp, end = 55.dp)
                .testTag("provider-preview"),
                verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Text(providerAgentShort(kind).uppercase() + " / PROVIDER", color = palette.muted,
                    fontSize = 9.sp, letterSpacing = 1.sp, fontFamily = FontFamily.Monospace)
                Text(state.providerCatalogProblems[kind] ?: if (connected) L10n.tr("当前没有可用供应商")
                    else L10n.tr("等待电脑连接"), color = palette.ink, fontSize = 20.sp)
            }
        }
        ProviderDialSwitchPointer(
            provider = preview,
            enabled = canSwitch && active && connected,
            modifier = Modifier.align(Alignment.CenterEnd),
            onConfirm = { selected ->
                val current = state.providersForKind(kind).firstOrNull { it.id == selected.id }
                if (active && connected && state.canUseProviders(kind) && current == selected) onSwitch(selected)
            },
        )
    }
}

@Composable
private fun ProviderDialOperations(
    state: RemoteState,
    kind: String,
    provider: AgentProvider?,
    hostId: String?,
    connected: Boolean,
    active: Boolean,
    canUse: Boolean,
    canSwitch: Boolean,
    onQuery: (AgentProvider, String?) -> Unit,
) {
    val palette = providerDialPalette()
    val operation = state.agentProviders.takeIf { it.kind == kind && it.hostId == hostId }
    val snapshot = provider?.let { state.subscriptionQuotas[kind]?.takeIf { quota -> quota.providerId == it.id } }
    val loading = provider != null && operation?.quotaRequestId != null && operation.quotaProviderId == provider.id && operation.quotaKind == kind
    val quotaAvailable = provider?.let { it.official && it.enabled && it.subscriptionSupported } == true
    val status = when {
        !connected -> L10n.tr("等待电脑连接")
        state.providerCatalogProblems[kind] != null -> state.providerCatalogProblems[kind].orEmpty()
        operation?.requestId != null -> L10n.tr("正在切换配置")
        operation?.loading == true -> L10n.tr("正在读取供应商")
        provider == null -> L10n.tr("当前没有可用供应商")
        provider.enabled && provider.additive -> L10n.tr("已启用，可同时使用")
        provider.enabled -> L10n.tr("已启用")
        else -> L10n.tr("未启用")
    }
    Column(
        Modifier.fillMaxWidth().padding(horizontal = 24.dp, vertical = 8.dp)
            .testTag("provider-inline-actions"),
        verticalArrangement = Arrangement.spacedBy(5.dp),
    ) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            Text(status, Modifier.weight(1f), color = palette.muted, fontSize = 11.sp,
                maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        if (canSwitch && provider != null) {
            Text(
                L10n.tr("沿右侧指针向外拉动并松手以{0}", if (provider.enabled) L10n.tr("停用") else L10n.tr("启用")),
                color = palette.muted.copy(alpha = 0.92f), fontSize = 10.sp,
                maxLines = 1, overflow = TextOverflow.Ellipsis,
                modifier = Modifier.testTag("provider-switch-hint"),
            )
        }
        operation?.error?.let { Text(it, color = MaterialTheme.colorScheme.error, fontSize = 11.sp) }
        operation?.notice?.let { Text(it, color = palette.muted, fontSize = 11.sp) }
        if (provider?.official == true && provider.subscriptionSupported) {
            if (quotaAvailable) {
                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                val density = LocalDensity.current
                CompositionLocalProvider(LocalDensity provides androidx.compose.ui.unit.Density(
                    density.density * density.fontScale, 1f,
                )) {
                    SubscriptionQuotaCoin(kind, snapshot?.quota, loading, active && canUse, palette.accent) {
                        onQuery(provider, hostId)
                    }
                }
                    val quotaSummary = snapshot?.quota?.windows?.joinToString(" · ") { window ->
                        val label = if (window.name == "five_hour") L10n.tr("5 小时") else L10n.tr("周")
                        "$label ${window.remainingPercent?.let { String.format(L10n.locale, "%.0f%%", it) } ?: "—"}"
                    } ?: when { loading -> L10n.tr("正在查询官方额度"); !provider.enabled -> L10n.tr("启用后可查询官方额度"); else -> L10n.tr("点击额度环查询") }
                    Text(quotaSummary, Modifier.weight(1f), color = palette.muted, fontSize = 10.sp,
                        maxLines = 2, overflow = TextOverflow.Ellipsis)
                NeumorphIconButton(onClick = { onQuery(provider, hostId) }, icon = Icons.Rounded.Refresh,
                    contentDescription = L10n.tr("查询 {0} 订阅配额", provider.name), enabled = active && canUse,
                    modifier = Modifier.testTag("provider-query"))
            }
            snapshot?.error?.let { Text(it, color = MaterialTheme.colorScheme.error, fontSize = 11.sp) }
            operation?.takeIf { it.quotaProviderId == provider.id }?.quotaError?.let {
                Text(it, color = MaterialTheme.colorScheme.error, fontSize = 11.sp)
            }
        }
    }
}
}

/** The fixed right-side index becomes a guided pull-to-switch control for a pending profile. */
@Composable
private fun ProviderDialSwitchPointer(
    provider: AgentProvider?,
    enabled: Boolean,
    modifier: Modifier = Modifier,
    onConfirm: (AgentProvider) -> Unit,
) {
    val palette = providerDialPalette()
    val density = LocalDensity.current
    val scope = rememberCoroutineScope()
    val pullDistancePx = with(density) { 38.dp.toPx() }
    var progress by remember(provider?.id, enabled) { mutableFloatStateOf(0f) }
    var resetJob by remember { mutableStateOf<Job?>(null) }
    val displayedProgress by animateFloatAsState(progress, tween(90, easing = FastOutSlowInEasing), label = "dial-pointer-pull")
    val guide = rememberInfiniteTransition(label = "dial-pointer-guide")
    val guideTravel by guide.animateFloat(
        initialValue = 0f,
        targetValue = 1f,
        animationSpec = infiniteRepeatable(tween(1100, easing = LinearEasing), RepeatMode.Restart),
        label = "dial-pointer-guide-travel",
    )
    val action = provider?.let {
        L10n.tr("沿指针外拉并松手以{0}", if (it.enabled) L10n.tr("停用") else L10n.tr("启用"))
    } ?: L10n.tr("供应商指针")
    Box(
        modifier.width(64.dp).height(58.dp)
            .testTag("provider-pointer-confirm")
            .semantics {
                contentDescription = action
                stateDescription = if (enabled) {
                    if (displayedProgress >= 0.98f) L10n.tr("松手以确认切换") else L10n.tr("沿右侧指针向外拉动")
                } else L10n.tr("当前供应商无需切换")
                progressBarRangeInfo = ProgressBarRangeInfo(displayedProgress, 0f..1f, 0)
                if (enabled && provider != null) {
                    customActions = listOf(CustomAccessibilityAction(action) {
                        onConfirm(provider)
                        true
                    })
                } else {
                    disabled()
                }
            }
            .pointerInput(enabled, provider?.id, provider?.enabled) {
                if (!enabled || provider == null) return@pointerInput
                awaitEachGesture {
                    val down = awaitFirstDown(requireUnconsumed = false)
                    var distance = 0f
                    val slop = awaitTouchSlopOrCancellation(down.id) { change, overSlop ->
                        if (kotlin.math.abs(overSlop.x) >= kotlin.math.abs(overSlop.y)) {
                            distance = (change.position.x - down.position.x).coerceAtLeast(0f)
                            progress = (distance / pullDistancePx).coerceIn(0f, 1f)
                            change.consume()
                        }
                    }
                    if (slop != null) {
                        val released = drag(slop.id) { change ->
                            distance = (change.position.x - down.position.x).coerceAtLeast(0f)
                            progress = (distance / pullDistancePx).coerceIn(0f, 1f)
                            change.consume()
                        }
                        if (released && distance >= pullDistancePx) onConfirm(provider)
                        resetJob?.cancel()
                        resetJob = scope.launch {
                            animate(progress, 0f, animationSpec = tween(220, easing = FastOutSlowInEasing)) { value, _ ->
                                progress = value
                            }
                        }
                    }
                }
            },
        contentAlignment = Alignment.Center,
    ) {
        Canvas(Modifier.fillMaxSize()) {
            val start = 12.dp.toPx()
            val end = size.width - 12.dp.toPx()
            val centerY = size.height * 0.46f
            val trackWidth = 1.5.dp.toPx()
            val knobRadius = 8.dp.toPx()
            val knobX = start + (end - start) * displayedProgress
            drawLine(palette.muted.copy(alpha = if (enabled) 0.27f else 0.72f),
                Offset(start, centerY), Offset(end, centerY), trackWidth, cap = StrokeCap.Round)
            if (enabled) {
                val filledEnd = start + (end - start) * maxOf(displayedProgress, guideTravel * 0.56f)
                drawLine(palette.accent.copy(alpha = 0.30f), Offset(start, centerY), Offset(filledEnd, centerY),
                    trackWidth * 1.4f, cap = StrokeCap.Round)
                for (index in 0..1) {
                    val arrowX = start + (end - start) * (0.39f + index * 0.22f) + guideTravel * 4.dp.toPx()
                    drawLine(palette.accent.copy(alpha = 0.42f + 0.42f * (1f - guideTravel)),
                        Offset(arrowX - 2.dp.toPx(), centerY - 2.5.dp.toPx()),
                        Offset(arrowX + 1.dp.toPx(), centerY), 1.1.dp.toPx(), cap = StrokeCap.Round)
                    drawLine(palette.accent.copy(alpha = 0.42f + 0.42f * (1f - guideTravel)),
                        Offset(arrowX + 1.dp.toPx(), centerY),
                        Offset(arrowX - 2.dp.toPx(), centerY + 2.5.dp.toPx()), 1.1.dp.toPx(), cap = StrokeCap.Round)
                }
            }
            drawCircle(palette.shadow.copy(alpha = 0.25f), knobRadius + 2.dp.toPx(), Offset(knobX + 1.dp.toPx(), centerY + 1.dp.toPx()))
            drawCircle(if (enabled) palette.surface else palette.accent.copy(alpha = 0.75f), knobRadius, Offset(knobX, centerY))
            drawCircle(palette.edge, knobRadius, Offset(knobX, centerY), style = Stroke(1.dp.toPx()))
            if (enabled) {
                drawCircle(palette.accent.copy(alpha = 0.6f), knobRadius + 3.dp.toPx() * guideTravel,
                    Offset(knobX, centerY), style = Stroke(1.dp.toPx() * (1f - guideTravel).coerceAtLeast(0.2f)))
            }
        }
    }
}
