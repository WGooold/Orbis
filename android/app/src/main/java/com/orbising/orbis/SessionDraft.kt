package com.orbising.orbis

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.tween
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.combinedClickable
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.input.key.*
import androidx.compose.ui.text.input.ImeAction
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
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.delay

internal class LocalSessionDraft(agent: String = "codex", cwd: String = "", text: String = "") {
    val agent = mutableStateOf(agent)
    val cwd = mutableStateOf(cwd)
    val text = mutableStateOf(text)
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

/** Local draft only: a remote session is requested by the first message's send action. */
@OptIn(androidx.compose.foundation.ExperimentalFoundationApi::class)
@Composable
internal fun SessionDraftCard(state: RemoteState, open: Boolean, presetCwd: String?,
    onBrowse: (String?) -> Unit, onBrowseInto: (String) -> Unit, onBrowseUp: () -> Unit,
    onCancel: () -> Unit = {}, drafts: SessionDraftStore? = null, onSubmit: (String, String, String, Rect, Rect) -> Boolean) {
    val localStore = rememberSaveable(saver = SessionDraftStore.Saver) { SessionDraftStore() }
    val draft = remember(state.hostId, drafts) { (drafts ?: localStore).draft(state.hostId) }
    var kind by draft.agent
    var text by draft.text
    var cwd by draft.cwd
    var directoryOpen by rememberSaveable { mutableStateOf(false) }
    var agentMenu by remember { mutableStateOf(false) }
    var pressed by remember { mutableStateOf(true) }
    val appearance = remember { Animatable(0f) }
    var bounds by remember { mutableStateOf(Rect.Zero) }
    var fieldBounds by remember { mutableStateOf(Rect.Zero) }
    val focus = remember { FocusRequester() }
    fun submit() {
        if (text.isNotBlank() && cwd.isNotBlank() && state.canCreateSessionOn(state.hostId) && onSubmit(kind, cwd, text.trim(), bounds, fieldBounds)) text = ""
    }
    val supported = state.launchableAgents ?: state.supportedAgents
    val kinds = listOf("codex", "claude", "dsh", "pi")
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
    LaunchedEffect(open, presetCwd) {
        if (open) {
            if (presetCwd != null) cwd = presetCwd
            if (cwd.isBlank()) cwd = state.runtimes.values.firstOrNull()?.cwd
                ?: state.sessions.values.firstOrNull { it.cwd.isNotBlank() }?.cwd.orEmpty()
            if (cwd.isBlank() && state.sessionBrowse == null) onBrowse(null)
        }
    }
    LaunchedEffect(state.sessionBrowse?.path) { if (cwd.isBlank()) cwd = state.sessionBrowse?.path.orEmpty() }
    LaunchedEffect(supported) { if (supported != null && kind !in supported) kind = kinds.firstOrNull { it in supported } ?: "pi" }
    AgentTheme(agentBrand(kind)) {
        NeumorphSurface(Modifier.fillMaxWidth().testTag("session-draft").onGloballyPositioned { bounds = it.boundsInWindow() },
            style = if (pressed) NeumorphStyle.Pressed else NeumorphStyle.Raised, contentPadding = 16.dp) {
            Column(Modifier.fillMaxWidth().graphicsLayer { alpha = appearance.value; translationY = 4.dp.toPx() * (1 - appearance.value) },
                verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                    kinds.forEach { agent ->
                        val brand = agentBrand(agent)
                        val selected = agent == kind || agent == "codex" && kind == "codexDesktop"
                        Box(Modifier.size(48.dp).testTag("draft-agent-$agent").combinedClickable(
                            enabled = supported?.contains(agent) != false,
                            role = Role.RadioButton, onClick = { kind = agent },
                            onLongClick = if (agent == "codex" && supported?.contains("codexDesktop") == true) ({ agentMenu = true }) else null,
                        ).semantics { this.selected = selected }) {
                            NeumorphSurface(Modifier.align(Alignment.Center).size(36.dp), shape = CircleShape,
                                style = if (selected) NeumorphStyle.Pressed else NeumorphStyle.Raised,
                                shadowScale = 0.4f, enabled = supported?.contains(agent) != false) {
                                Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { AgentIcon(brand, Modifier.size(20.dp), brand.title) }
                            }
                            if (agent == "codex") NeumorphMenu(agentMenu, { agentMenu = false }) {
                                listOf("codex", "codexDesktop").forEach { value ->
                                    NeumorphMenuItem(text = { Text(if (value == "codex") L10n.tr("Codex 终端") else L10n.tr("Codex 桌面版")) },
                                        onClick = { kind = value; agentMenu = false }, enabled = supported?.contains(value) != false)
                                }
                            }
                        }
                    }
                    Text(if (kind == "codexDesktop") L10n.tr("Codex 桌面版") else agentBrand(kind).title,
                        modifier = Modifier.weight(1f), style = MaterialTheme.typography.titleSmall, color = MaterialTheme.colorScheme.primary, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
                NeumorphTextButton(text = cwd.ifBlank { L10n.tr("选择工作目录") },
                    onClick = { directoryOpen = true; onBrowse(cwd.takeIf(String::isNotBlank)) }, icon = Icons.Rounded.Folder,
                    modifier = Modifier.fillMaxWidth().testTag("draft-directory"))
                Row(verticalAlignment = Alignment.Bottom, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    NeumorphTextField(text, { text = it }, Modifier.weight(1f).testTag("draft-message").focusRequester(focus).onGloballyPositioned { fieldBounds = it.boundsInWindow() }.onPreviewKeyEvent { event ->
                            if (event.type == KeyEventType.KeyDown && event.key == Key.Escape) { onCancel(); true }
                            else if (event.type == KeyEventType.KeyDown && event.key == Key.Enter && !event.isShiftPressed &&
                                text.isNotBlank() && !event.nativeKeyEvent.isAltPressed) { submit(); true }
                            else false
                        },
                        placeholder = { Text(L10n.tr("让 {0} 做什么？", agentBrand(kind).title)) }, maxLines = 6,
                        keyboardOptions = KeyboardOptions(imeAction = ImeAction.Send),
                        keyboardActions = KeyboardActions(onSend = { submit() }))
                    NeumorphIconButton(onClick = ::submit, icon = Icons.Rounded.ArrowUpward, contentDescription = L10n.tr("发出第一句话并创建会话"),
                        enabled = text.isNotBlank() && cwd.isNotBlank() && state.canCreateSessionOn(state.hostId),
                        tint = MaterialTheme.colorScheme.primary, modifier = Modifier.testTag("draft-send"))
                }
                Text(L10n.tr("发出第一句话，才会在电脑上创建这个会话"), style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
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
