package com.orbising.orbis

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.tween
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.clickable
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.input.key.*
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.text.TextRange
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.saveable.listSaver
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.layout.boundsInWindow
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.*
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.delay

internal class LocalSessionDraft(agent: String = "codex", cwd: String = "", text: String = "") {
    val agent = mutableStateOf(agent)
    val cwd = mutableStateOf(cwd)
    val text = mutableStateOf(text)
    val editing = mutableStateOf(TextFieldValue(text, selection = TextRange(text.length)))
}

/** Lives above the inline card, so closing it and switching computers keep separate drafts. */
internal class SessionDraftStore {
    private val rows = mutableMapOf<String, LocalSessionDraft>()
    fun draft(host: String?) = rows.getOrPut(host.orEmpty()) { LocalSessionDraft() }
    companion object {
        val Saver = listSaver<SessionDraftStore, String>(
            save = { store -> store.rows.flatMap { (host, row) -> listOf(host, row.agent.value, row.cwd.value, row.text.value) } },
            restore = { values -> SessionDraftStore().apply { values.chunked(4).forEach { row ->
                rows[row[0]] = LocalSessionDraft(row[1], row[2], row[3])
            } } },
        )
    }
}

/** Local draft only: starting explicitly creates a session, with an optional first message. */
@OptIn(androidx.compose.foundation.ExperimentalFoundationApi::class)
@Composable
internal fun SessionDraftCard(state: RemoteState, open: Boolean, presetCwd: String?,
    onBrowse: (String?) -> Unit, onBrowseInto: (String) -> Unit, onBrowseUp: () -> Unit,
    onCancel: () -> Unit = {}, drafts: SessionDraftStore? = null,
    onLoadConfiguration: (String, String) -> Unit = { _, _ -> },
    onSaveConfiguration: (SessionConfigurationValues) -> Unit = {},
    onSubmit: (String, String, String, Rect, Rect) -> Boolean) {
    val localStore = rememberSaveable(saver = SessionDraftStore.Saver) { SessionDraftStore() }
    val draft = remember(state.hostId, drafts) { (drafts ?: localStore).draft(state.hostId) }
    var kind by draft.agent
    var text by draft.text
    var cwd by draft.cwd
    var fieldValue by draft.editing
    LaunchedEffect(text) { if (fieldValue.text != text) fieldValue = TextFieldValue(text, selection = TextRange(text.length)) }
    var directoryOpen by rememberSaveable { mutableStateOf(false) }
    var agentMenu by remember { mutableStateOf<String?>(null) }
    var pressed by remember { mutableStateOf(true) }
    val appearance = remember { Animatable(0f) }
    var bounds by remember { mutableStateOf(Rect.Zero) }
    var fieldBounds by remember { mutableStateOf(Rect.Zero) }
    val focus = remember { FocusRequester() }
    var configurationPanel by remember { mutableStateOf<String?>(null) }
    var permissionCategory by remember { mutableStateOf<String?>(null) }
    var proposedPermissions by remember { mutableStateOf<Map<String, String>>(emptyMap()) }
    val config = state.sessionConfiguration.takeIf { it.agentKind == kind && it.cwd == cwd }
    LaunchedEffect(open, kind, cwd, state.e2eReady, state.sessionConfigurationSupported) {
        if (open && state.e2eReady && state.sessionConfigurationSupported && cwd.isNotBlank()) onLoadConfiguration(kind, cwd)
    }
    fun submit() {
        if (cwd.isNotBlank() && state.canCreateSessionOn(state.hostId) && onSubmit(kind, cwd, text.trim(), bounds, fieldBounds)) text = ""
    }
    val supported = state.launchableAgents ?: state.supportedAgents
    val kinds = listOf("codex", "claude", "dsh", "pi")
    val family = agentFamily(kind)
    /** Both native entries of a family can start here, so its version is a real choice (Codex terminal / desktop, DeepSeek Web / Desktop). */
    fun versionsAvailable(of: String) = agentVariants(of).size > 1 && agentVariants(of).all { supported?.contains(it) == true }
    LaunchedEffect(open) {
        if (open) {
            pressed = true; appearance.snapTo(0f)
            delay(InteractionMotion.duration(200).toLong())
            pressed = false
            delay(InteractionMotion.duration(120).toLong())
            appearance.animateTo(1f, tween(InteractionMotion.duration(InteractionMotion.State)))
            focus.requestFocus()
        } else {
            appearance.animateTo(0f, tween(InteractionMotion.duration(InteractionMotion.State)))
            pressed = true
        }
    }
    LaunchedEffect(open, presetCwd, state.hostId) {
        if (open) {
            if (presetCwd != null) cwd = presetCwd
            if (cwd.isBlank()) cwd = state.runtimes.values.firstOrNull()?.cwd
                ?: state.sessions.values.firstOrNull { it.cwd.isNotBlank() }?.cwd.orEmpty()
            if (cwd.isBlank() && state.sessionBrowse == null) onBrowse(null)
        }
    }
    LaunchedEffect(state.sessionBrowse?.path) { if (cwd.isBlank()) cwd = state.sessionBrowse?.path.orEmpty() }
    LaunchedEffect(supported) { if (supported != null && kind !in supported)
        kind = (listOf("codex", "codexDesktop", "claude", "dsh", "dshDesktop", "pi")).firstOrNull { it in supported } ?: "pi"
    }
    AgentTheme(agentBrand(kind)) {
        NeumorphSurface(Modifier.fillMaxWidth().testTag("session-draft").onGloballyPositioned { bounds = it.boundsInWindow() },
            style = if (pressed) NeumorphStyle.Pressed else NeumorphStyle.Raised, contentPadding = 16.dp) {
            Column(Modifier.fillMaxWidth().graphicsLayer { alpha = appearance.value; translationY = 4.dp.toPx() * (1 - appearance.value) },
                verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                    kinds.forEach { agent ->
                        val brand = agentBrand(agent)
                        val variants = agentVariants(agent)
                        val selected = family == agent
                        val enabled = supported == null || variants.any { it in supported }
                        val chooseCodexVersion = versionsAvailable(agent)
                        Box(Modifier.size(48.dp).testTag("draft-agent-$agent").combinedClickable(
                            interactionSource = remember { MutableInteractionSource() }, indication = null,
                            enabled = enabled,
                            role = if (chooseCodexVersion) Role.Button else Role.RadioButton,
                            onClick = {
                                if (chooseCodexVersion) agentMenu = agent
                                else kind = variants.firstOrNull { supported?.contains(it) != false } ?: agent
                            },
                            onLongClick = if (chooseCodexVersion) ({ agentMenu = agent }) else null,
                        ).semantics {
                            this.selected = selected
                            if (chooseCodexVersion) stateDescription = if (agent == "codex") L10n.tr("选择 Codex 终端版或桌面版")
                                else variants.joinToString(" / ") { agentVariantTitle(it) }
                        }) {
                            Box(Modifier.align(Alignment.Center).size(36.dp), contentAlignment = Alignment.Center) {
                                if (selected) AgentIconRecess(Modifier.fillMaxSize(), CircleShape)
                                AgentIcon(brand, Modifier.size(20.dp).graphicsLayer { alpha = if (selected) 1f else 0.4f }, brand.title,
                                    tintOverride = if (selected) null else LocalOrbisPalette.current.faint)
                            }
                            if (variants.size > 1) NeumorphMenu(agentMenu == agent, { agentMenu = null }) {
                                variants.forEach { value ->
                                    NeumorphMenuItem(text = { Text(agentVariantTitle(value)) },
                                        onClick = { kind = value; agentMenu = null }, enabled = supported?.contains(value) != false)
                                }
                            }
                        }
                    }
                    val hasVariants = agentVariants(family).size > 1
                    val versionChoice = versionsAvailable(family)
                    Row(Modifier.weight(1f).heightIn(min = 48.dp)
                        .testTag(if (family == "codex") "draft-codex-version" else if (hasVariants) "draft-$family-version" else "draft-agent-label")
                        .then(if (versionChoice) Modifier.orbisKeyboardFocus().clickable(
                            interactionSource = remember { MutableInteractionSource() }, indication = null,
                            role = Role.Button,
                        ) { agentMenu = family } else Modifier)
                        .semantics {
                            if (hasVariants) stateDescription = agentVariantTitle(kind)
                        }, verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(6.dp, Alignment.End)) {
                        Text(if (family == "codex") "Codex" else agentBrand(kind).title,
                            modifier = Modifier.weight(1f).testTag("draft-agent-name"), style = MaterialTheme.typography.titleSmall,
                            color = MaterialTheme.colorScheme.primary, textAlign = TextAlign.End,
                            maxLines = 1, overflow = TextOverflow.Ellipsis)
                        if (hasVariants) Icon(when (kind) { "codexDesktop", "dshDesktop" -> OrbisSymbols.Computer; "dsh" -> Icons.Rounded.Language; else -> Icons.Rounded.Terminal },
                            null, Modifier.size(18.dp).testTag(if (family == "codex") "draft-codex-mode-icon" else "draft-$family-mode-icon"), tint = MaterialTheme.colorScheme.primary)
                    }
                }
                Row(Modifier.fillMaxWidth().heightIn(min = 48.dp).testTag("draft-directory")
                    .orbisKeyboardFocus().clickable(role = Role.Button) { directoryOpen = true; onBrowse(cwd.takeIf(String::isNotBlank)) },
                    verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Icon(OrbisSymbols.Folder, null, Modifier.size(16.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
                    Text(cwd.ifBlank { L10n.tr("选择工作目录") }, Modifier.weight(1f), style = MaterialTheme.typography.labelMedium,
                        fontFamily = FontFamily.Monospace, color = MaterialTheme.colorScheme.onSurfaceVariant,
                        maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Icon(OrbisSymbols.KeyboardArrowDown, null, Modifier.size(16.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                if (state.sessionConfigurationSupported) {
                    val permissionSummary = config?.snapshot?.catalog?.permissions?.mapNotNull { setting ->
                        setting.options.firstOrNull { it.value == config.values.permissions[setting.id] }?.label
                    }?.takeIf { it.isNotEmpty() }?.joinToString(" · ") { L10n.hostText(it) } ?: L10n.tr("电脑端默认")
                    val thinking = config?.model?.thinking?.firstOrNull { it.value == config.values.thinking }?.label
                        ?.let(L10n::hostText) ?: config?.values?.thinking ?: L10n.tr("默认深度")
                    // S55 / SC79: permissions never claim width from the model or thinking value.
                    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        DraftConfigurationButton(L10n.tr("模型"), config?.model?.label ?: L10n.tr(if (config?.snapshot == null) "模型" else "电脑端默认"),
                            panel = "model", enabled = config?.snapshot?.catalog?.models?.isNotEmpty() == true && config.requestId == null,
                            modifier = Modifier.fillMaxWidth(), onClick = { configurationPanel = "model" })
                        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            DraftConfigurationButton(L10n.tr("思考深度"), thinking, panel = "thinking",
                                enabled = config?.model?.thinking?.isNotEmpty() == true && config.requestId == null,
                                modifier = Modifier.weight(1f), onClick = { configurationPanel = "thinking" })
                            DraftConfigurationButton(L10n.tr("权限"), null, panel = "permissions", accessibilityValue = permissionSummary,
                                enabled = config?.snapshot != null && config.requestId == null, modifier = Modifier.weight(1f),
                                onClick = { proposedPermissions = config?.values?.permissions.orEmpty(); configurationPanel = "permissions" })
                        }
                    }
                    config?.error?.let { StatusWithInfo(L10n.tr("设置未确认"), L10n.hostText(it), error = true) }
                    if (config?.requestId != null) Text(L10n.tr("正在确认配置…"), style = MaterialTheme.typography.labelMedium)
                    if (config?.error != null) NeumorphTextButton(L10n.tr("刷新"), onClick = { onLoadConfiguration(kind, cwd) })
                } else StatusWithInfo(L10n.tr("电脑端默认"), L10n.tr("升级电脑端后可在此选择模型、思考深度和权限"))
                Row(verticalAlignment = Alignment.Bottom, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    NeumorphTextField(fieldValue, { fieldValue = it; text = it.text }, Modifier.weight(1f).testTag("draft-message").focusRequester(focus).onGloballyPositioned { fieldBounds = it.boundsInWindow() }.onPreviewKeyEvent { event ->
                            if (event.type == KeyEventType.KeyDown && event.key == Key.Escape) { onCancel(); true }
                            else if (event.type == KeyEventType.KeyDown && event.key == Key.Enter && fieldValue.composition == null && !event.isShiftPressed &&
                                !event.nativeKeyEvent.isAltPressed) { submit(); true }
                            else false
                        },
                        placeholder = { Text(L10n.tr("让 {0} 做什么？", agentBrand(kind).title)) }, maxLines = 6,
                        keyboardOptions = KeyboardOptions(imeAction = ImeAction.Send),
                        keyboardActions = KeyboardActions(onSend = { if (fieldValue.composition == null) submit() }))
                    NeumorphIconButton(onClick = ::submit,
                        icon = if (text.isBlank()) Icons.Rounded.PlayArrow else OrbisSymbols.ArrowUpward,
                        contentDescription = L10n.tr(if (text.isBlank()) "启动" else "发出第一句话并创建会话"),
                        enabled = cwd.isNotBlank() && state.canCreateSessionOn(state.hostId),
                        tint = MaterialTheme.colorScheme.primary, modifier = Modifier.testTag("draft-send"))
                }

            }
        }
        val panel = configurationPanel
        if (panel != null && panel != "permissions" && config?.snapshot != null) OrbisChoiceSheet(L10n.tr(if (panel == "model") "模型" else if (panel == "thinking") "思考深度" else "权限"), { configurationPanel = null }) {
            Column(Modifier.fillMaxWidth().heightIn(max = 440.dp).verticalScroll(androidx.compose.foundation.rememberScrollState()), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                if (panel == "model") config.snapshot.catalog.models.forEach { model ->
                    NeumorphTextButton(model.label, filled = config.values.model == model.value, onClick = {
                        val thinking = config.values.thinking?.takeIf { value -> model.thinking.any { it.value == value } } ?: model.defaultThinking
                        onSaveConfiguration(config.values.copy(model = model.value, thinking = thinking)); configurationPanel = null
                    }, modifier = Modifier.fillMaxWidth())
                }
                if (panel == "thinking") config.model?.thinking?.forEach { option ->
                    NeumorphTextButton(L10n.hostText(option.label), filled = config.values.thinking == option.value, onClick = {
                        onSaveConfiguration(config.values.copy(thinking = option.value)); configurationPanel = null
                    }, modifier = Modifier.fillMaxWidth())
                }

            }
        }
        if (panel == "permissions" && config?.snapshot != null) SessionControlDialog(L10n.tr("新会话权限"), { configurationPanel = null }) {
            val closeAndApply = sheetCloseAction {
                onSaveConfiguration(config.values.copy(permissions = proposedPermissions)); configurationPanel = null
            }
            PermissionSettingChoices(config.snapshot.catalog.permissions, permissionCategory, proposedPermissions, config.values.permissions,
                enabled = state.e2eReady && config.requestId == null, modifier = Modifier.weight(1f), onCategory = { permissionCategory = it },
                onSelect = { id, value ->
                    proposedPermissions = proposedPermissions + (id to value)
                    if (id == "sandbox" && value == "dangerFullAccess") proposedPermissions = proposedPermissions + ("network" to "enabled")
                })
            config.snapshot.catalog.notice?.let { InlineInfoButton(L10n.hostText(it), L10n.tr("新会话权限")) }
            if (config.snapshot.catalog.permissions.isNotEmpty()) NeumorphTextButton(L10n.tr("应用到新会话"), filled = true,
                dismissOnClick = false, onClick = closeAndApply,
                enabled = state.e2eReady && config.requestId == null && proposedPermissions != config.values.permissions,
                modifier = Modifier.fillMaxWidth().padding(16.dp).testTag("draft-permissions-apply"))
        }
        if (directoryOpen) OrbisChoiceSheet(L10n.tr("工作目录"), { directoryOpen = false }) {
            RemoteDirectoryBrowser(state.sessionBrowse, state.e2eReady, onBrowse, onBrowseInto, onBrowseUp,
                modifier = Modifier.fillMaxWidth().heightIn(max = 440.dp))
            val browse = state.sessionBrowse
            NeumorphActionButton(text = L10n.tr("使用此目录"), onClick = {
                browse?.path?.takeIf(String::isNotBlank)?.let { cwd = it; directoryOpen = false }
            }, enabled = browse != null && !browse.isLoading && browse.error == null && !browse.path.isNullOrBlank(),
                modifier = Modifier.fillMaxWidth())
        }
    }
}

/** Fixed slots use the shared surface and type scale; full values remain available to accessibility. */
@Composable
private fun DraftConfigurationButton(label: String, value: String?, panel: String, enabled: Boolean,
    modifier: Modifier = Modifier, accessibilityValue: String? = value, onClick: () -> Unit) {
    NeumorphSurface(modifier.testTag("draft-config-$panel").semantics {
        contentDescription = label
        accessibilityValue?.let { stateDescription = it }
    }, shape = RemoteUi.ControlShape, shadowScale = 0.5f, enabled = enabled, onClick = onClick) {
        Row(Modifier.fillMaxWidth().heightIn(min = 56.dp).padding(horizontal = 12.dp, vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            val tint = if (enabled) MaterialTheme.colorScheme.onSurfaceVariant else LocalOrbisPalette.current.faint
            if (value != null) Column(Modifier.weight(1f)) {
                Text(label, style = MaterialTheme.typography.labelSmall, color = tint, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text(value, Modifier.testTag("draft-config-$panel-value"),
                    style = if (panel == "model") MaterialTheme.typography.titleMedium else MaterialTheme.typography.titleSmall,
                    color = if (enabled) MaterialTheme.colorScheme.onSurface else tint, maxLines = 1, overflow = TextOverflow.Ellipsis)
            } else {
                Icon(OrbisSymbols.Shield, null, Modifier.size(16.dp), tint = tint)
                Text(label, Modifier.weight(1f), style = MaterialTheme.typography.titleSmall, color = tint,
                    maxLines = 2, overflow = TextOverflow.Ellipsis)
            }
            Icon(OrbisSymbols.KeyboardArrowDown, null, Modifier.size(14.dp), tint = tint)
        }
    }
}

/** Agents with a second native entry keep one emblem; the entry is a version beside it (ADR-0022, ADR-0076). */
internal fun agentFamily(kind: String): String = when (kind) { "codexDesktop" -> "codex"; "dshDesktop" -> "dsh"; else -> kind }
internal fun agentVariants(family: String): List<String> = when (family) {
    "codex" -> listOf("codex", "codexDesktop")
    "dsh" -> listOf("dsh", "dshDesktop")
    else -> listOf(family)
}
internal fun agentVariantTitle(kind: String): String = when (kind) {
    "codex" -> L10n.tr("Codex 终端版")
    "codexDesktop" -> L10n.tr("Codex 桌面版")
    "dsh" -> L10n.tr("DeepSeek 网页版")
    "dshDesktop" -> L10n.tr("DeepSeek 桌面版")
    else -> agentBrand(kind).title
}
