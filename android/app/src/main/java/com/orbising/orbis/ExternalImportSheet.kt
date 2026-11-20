package com.orbising.orbis

import androidx.activity.compose.BackHandler
import androidx.compose.animation.animateContentSize
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Badge
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle

@Composable
internal fun ExternalImportButton(count: Int, action: () -> Unit) {
    if (count > 0) {
        Box(modifier = Modifier.testTag("external-import-inbox")) {
            NeumorphIconButton(
                onClick = action,
                icon = OrbisSymbols.Archive,
                contentDescription = L10n.tr("待发送 · {0}", count),
                size = 40.dp,
            )
            Box(Modifier.size(RemoteUi.TouchTarget)) {
                Badge(
                    modifier = Modifier.align(Alignment.TopEnd),
                    containerColor = MaterialTheme.colorScheme.primary,
                    contentColor = MaterialTheme.colorScheme.onPrimary,
                ) {
                    Text(if (count > 9) "9+" else count.toString())
                }
            }
        }
    }
}

private enum class ImportRoute { MAIN, COMPUTERS, SETUP }
private enum class ImportStage { COMPOSE, AWAITING_RECEIPT, AWAITING_LAUNCH }

private fun ExternalImportBatch.stage(): ImportStage {
    val receipt = attempt?.receipt
    if (receipt != null && receipt.mayCheck) return ImportStage.AWAITING_RECEIPT
    if (destination == null && launch != null && !launch.failed) return ImportStage.AWAITING_LAUNCH
    return ImportStage.COMPOSE
}

/** OI-08: one page — what is being sent, an optional note, which Session — then one Send. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun ExternalImportSheet(
    ui: ExternalImportUi, model: ExternalImportViewModel, remote: RemoteViewModel,
    destinations: suspend () -> List<ExternalImportChoice> = { remote.externalImportDestinations() },
) {
    val batch = ui.batches.firstOrNull { it.id == ui.selected }
    val completed = ui.completed
    var route by remember(batch?.id) { mutableStateOf(ImportRoute.MAIN) }
    var launchHost by remember(batch?.id) { mutableStateOf<String?>(null) }
    var setupBack by remember(batch?.id) { mutableStateOf(ImportRoute.MAIN) }
    var note by remember(batch?.id) { mutableStateOf((batch?.attempt?.instruction ?: batch?.launch?.instruction).orEmpty()) }
    var choice by remember(batch?.id) { mutableStateOf(batch?.destination?.target) }
    var deleting by remember(batch?.id) { mutableStateOf(false) }
    val focus = LocalFocusManager.current
    val hosts by remote.hosts.collectAsStateWithLifecycle()
    var choices by remember(batch?.id) { mutableStateOf<List<ExternalImportChoice>?>(null) }
    val composing = batch != null && route == ImportRoute.MAIN && batch.stage() == ImportStage.COMPOSE
    LaunchedEffect(batch?.id, composing, hosts) {
        if (composing) choices = destinations()
    }
    val delivering = batch != null && ui.delivering == batch.id
    val processing = ui.busy || delivering
    val actionable = !ui.busy && ui.delivering == null
    val title = when {
        completed != null -> L10n.tr("已发送")
        batch == null -> L10n.tr("待发送")
        route == ImportRoute.COMPUTERS -> L10n.tr("选择电脑")
        route == ImportRoute.SETUP -> L10n.tr("新建会话")
        else -> L10n.tr("发送到会话")
    }
    val showsBack = (completed != null && ui.batches.isNotEmpty()) || (completed == null && (route != ImportRoute.MAIN || (batch != null && ui.batches.size > 1)))

    fun back() {
        focus.clearFocus()
        if (completed != null) { model.finishCompleted(); return }
        when (route) {
            ImportRoute.SETUP -> { launchHost = null; route = setupBack }
            ImportRoute.COMPUTERS -> route = ImportRoute.MAIN
            ImportRoute.MAIN -> model.select(null)
        }
    }

    fun newSession() {
        focus.clearFocus()
        val computers = remote.externalImportHosts()
        if (computers.size == 1) {
            launchHost = computers.first().first.hostId; setupBack = ImportRoute.MAIN; route = ImportRoute.SETUP
        } else route = ImportRoute.COMPUTERS
    }

    OrbisBottomSheet(onDismissRequest = model::close, maxHeightFraction = 0.94f) {
        // System Back walks the same steps as the header arrow; only the top level closes the sheet.
        BackHandler(enabled = showsBack) { if (!ui.busy) back() }
        val closeSheet = sheetCloseAction(model::close)
        Column(Modifier.fillMaxWidth().padding(horizontal = 20.dp).testTag("external-import-sheet")) {
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                if (showsBack) NeumorphIconButton(::back, OrbisSymbols.ArrowBack, L10n.tr("返回"), enabled = !ui.busy, size = 36.dp)
                Text(title, Modifier.weight(1f), style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.SemiBold)
                if (batch != null && route == ImportRoute.MAIN && completed == null) {
                    NeumorphIconButton({ deleting = true }, OrbisSymbols.Delete, L10n.tr("删除"), enabled = !processing, size = 36.dp)
                }
                NeumorphIconButton(closeSheet, OrbisSymbols.Close, L10n.tr("关闭"), size = 36.dp)
            }
            if (processing) LinearProgressIndicator(Modifier.fillMaxWidth().padding(top = 8.dp))
            key(batch?.id, route, completed?.target) {
                Column(Modifier.weight(1f, fill = false).verticalScroll(rememberScrollState()).padding(vertical = 14.dp),
                    verticalArrangement = Arrangement.spacedBy(18.dp)) {
                    ui.problem?.let { ImportNotice(importProblemText(it)) }
                    when {
                        completed != null -> ImportCompleted(completed, remote.externalImportAgent(completed.target))
                        batch == null -> ImportInbox(ui, model)
                        route == ImportRoute.COMPUTERS -> {
                            val computers = remote.externalImportHosts()
                            if (computers.isEmpty()) ImportEmpty(L10n.tr("暂无可用电脑"), OrbisSymbols.Computer)
                            else Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                                computers.forEach { (host, _) ->
                                    ImportLinkRow(OrbisSymbols.Computer, host.name, enabled = actionable) {
                                        launchHost = host.hostId; setupBack = ImportRoute.COMPUTERS; route = ImportRoute.SETUP
                                    }
                                }
                            }
                        }
                        route == ImportRoute.SETUP -> {
                            val owner = launchHost?.let(remote::externalImportConnection)
                            if (owner == null) ImportEmpty(L10n.tr("暂无可用电脑"), OrbisSymbols.Computer)
                            else {
                                val state by owner.state.collectAsStateWithLifecycle()
                                ImportHeading(owner.pairing.hostName ?: owner.hostId)
                                key(owner) {
                                    SessionDraftCard(state, true, null, owner::browseSessions, owner::browseInto, owner::browseUp,
                                        onCancel = ::back, onLoadConfiguration = owner::loadSessionConfiguration,
                                        onSaveConfiguration = owner::saveSessionConfiguration, importMode = true
                                    ) { agent, cwd, first, _, _ ->
                                        val instruction = listOf(note.trim(), first).filter(String::isNotEmpty).joinToString("\n\n")
                                        launchHost = null; route = ImportRoute.MAIN
                                        model.launch(batch, owner, agent, cwd, instruction)
                                        true
                                    }
                                }
                            }
                        }
                        else -> {
                            if (!delivering) {
                                if (batch.attempt?.receipt == ExternalImportReceipt.FAILED) ImportNotice(L10n.tr("发送失败"))
                                if (batch.destination == null && batch.launch?.failed == true) ImportNotice(L10n.tr("新会话没有启动"))
                            }
                            ImportContentCard(batch)
                            when (batch.stage()) {
                                ImportStage.AWAITING_RECEIPT -> batch.destination?.let { destination ->
                                    ImportTargetRow(destination.sessionName, listOf(destination.hostName, directoryDisplayName(destination.target.cwd)),
                                        remote.externalImportAgent(destination.target), selected = true)
                                    if (!delivering) ImportStatus(L10n.tr("未收到电脑确认"))
                                }
                                ImportStage.AWAITING_LAUNCH -> batch.launch?.let { launch ->
                                    ImportTargetRow(L10n.tr("新建会话"), listOf(launch.hostName, directoryDisplayName(launch.cwd)), launch.agent, selected = true)
                                    if (!delivering) ImportStatus(L10n.tr("未收到新会话确认"))
                                }
                                ImportStage.COMPOSE -> {
                                    NeumorphTextField(note, { note = it },
                                        modifier = Modifier.fillMaxWidth().testTag("external-import-note"),
                                        placeholder = { Text(L10n.tr("添加说明…")) }, minLines = 1, maxLines = 4, enabled = !processing)
                                    val locked = batch.destination?.takeIf { batch.launch != null }
                                    // A Session created for this content stays its only target.
                                    if (locked != null) ImportTargetRow(locked.sessionName, listOf(locked.hostName, directoryDisplayName(locked.target.cwd)),
                                        remote.externalImportAgent(locked.target), selected = true)
                                    else ImportTargets(choices, ui.recent, choice, actionable, remote.externalImportConnecting(),
                                        onSelect = { focus.clearFocus(); choice = if (choice == it) null else it },
                                        onNewSession = ::newSession)
                                }
                            }
                        }
                    }
                }
            }
            @Composable fun action(label: String, icon: ImageVector?, tag: String, enabled: Boolean = actionable, run: () -> Unit) {
                ImportDivider()
                NeumorphActionButton(onClick = { focus.clearFocus(); run() }, text = label, icon = icon,
                    modifier = Modifier.fillMaxWidth().padding(vertical = 8.dp).testTag(tag), enabled = enabled)
            }
            val phase = ui.phase.takeIf { delivering }
            when {
                completed != null -> action(L10n.tr("打开会话"), OrbisSymbols.ChatBubble, "external-import-open-session") {
                    // The chat is already underneath when the sheet finishes its exit.
                    remote.openSession(completed.target.hostId, completed.target.sessionId)
                    closeSheet()
                }
                batch == null || route != ImportRoute.MAIN -> Unit
                phase != null -> action(importPhaseText(phase), null, "external-import-progress", enabled = false) {}
                batch.stage() != ImportStage.COMPOSE ->
                    action(L10n.tr("重新检查"), OrbisSymbols.Refresh, "external-import-recheck") { model.recheck(batch, remote) }
                else -> {
                    val target = batch.destination?.takeIf { batch.launch != null }
                        ?: choices?.firstOrNull { it.destination.target == choice }?.destination
                    if (target == null) action(L10n.tr("选一个会话"), null, "external-import-send", enabled = false) {}
                    else action(L10n.tr("发送到「{0}」", target.sessionName), OrbisSymbols.ArrowUpward, "external-import-send") {
                        model.send(batch, target, remote, note)
                    }
                }
            }
        }
    }
    if (deleting && batch != null) NeumorphDialog(
        onDismissRequest = { deleting = false }, title = { Text(L10n.tr("删除这条内容？")) }, text = {},
        dismissButton = { NeumorphTextButton(L10n.tr("取消"), onClick = { deleting = false }) },
        confirmButton = { NeumorphTextButton(L10n.tr("删除"), onClick = { deleting = false; model.delete(batch.id) }, danger = true, enabled = !processing) },
    )
}

@Composable
private fun ImportTargets(choices: List<ExternalImportChoice>?, recent: ExternalImportTarget?, selected: ExternalImportTarget?,
                          enabled: Boolean, connecting: Boolean, onSelect: (ExternalImportTarget) -> Unit, onNewSession: () -> Unit) {
    when {
        choices == null -> ImportStatus(L10n.tr("正在读取…"))
        // A cold start from the share sheet races the first catalog; empty is not final yet.
        choices.isEmpty() && connecting -> ImportStatus(L10n.tr("正在连接…"))
        choices.isEmpty() -> ImportEmpty(L10n.tr("暂无可加入的会话"), OrbisSymbols.ChatBubble)
        else -> orderImportChoices(choices, recent).forEach { group ->
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                ImportHeading(group.first().destination.hostName)
                group.forEach { option ->
                    val target = option.destination.target
                    ImportTargetRow(option.destination.sessionName,
                        listOf(directoryDisplayName(target.cwd), L10n.tr("运行中").takeIf { option.running },
                            L10n.tr("最近使用").takeIf { target == recent }),
                        option.agentKind, selected = target == selected, enabled = enabled,
                        modifier = Modifier.testTag("external-import-target"), onClick = { onSelect(target) })
                }
            }
        }
    }
    ImportLinkRow(OrbisSymbols.Add, L10n.tr("新建会话"), enabled = enabled,
        modifier = Modifier.testTag("external-import-new-session"), onClick = onNewSession)
}

@Composable
private fun ImportInbox(ui: ExternalImportUi, model: ExternalImportViewModel) {
    if (ui.batches.isEmpty()) {
        if (!ui.busy && ui.problem == null) ImportEmpty(L10n.tr("没有待发送的内容"), OrbisSymbols.Archive)
        return
    }
    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        ui.batches.forEach { item ->
            val error = item.attempt?.receipt == ExternalImportReceipt.FAILED || (item.destination == null && item.launch?.failed == true)
            NeumorphSurface(Modifier.fillMaxWidth().testTag("external-import-${item.id}"), shape = RemoteUi.ControlShape, shadowScale = 0.5f,
                onClick = { model.select(item.id) }, enabled = !ui.busy) {
                Row(Modifier.fillMaxWidth().heightIn(min = 60.dp).padding(horizontal = 14.dp, vertical = 10.dp),
                    verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    ImportContentIcon(item, 36.dp)
                    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                        Text(importTitle(item), style = MaterialTheme.typography.bodyLarge, fontWeight = FontWeight.Medium,
                            maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Text(importStatusLine(item), style = MaterialTheme.typography.bodySmall, maxLines = 1, overflow = TextOverflow.Ellipsis,
                            color = if (error) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    Icon(OrbisSymbols.ChevronRight, null, Modifier.size(16.dp), tint = LocalOrbisPalette.current.faint)
                }
            }
        }
    }
}

@Composable
private fun ImportCompleted(destination: ExternalImportDestination, agent: String?) {
    val reveal = remember { Animatable(0f) }
    LaunchedEffect(Unit) { reveal.animateTo(1f, tween(InteractionMotion.duration(InteractionMotion.Panel))) }
    Column(Modifier.fillMaxWidth().padding(top = 16.dp), horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(18.dp)) {
        Icon(OrbisSymbols.CheckCircleFill, null, Modifier.size(52.dp).graphicsLayer {
            alpha = reveal.value; scaleX = 0.8f + 0.2f * reveal.value; scaleY = scaleX
        }, tint = LocalOrbisPalette.current.success)
        ImportTargetRow(destination.sessionName, listOf(destination.hostName, directoryDisplayName(destination.target.cwd)),
            agent, selected = false, showsIndicator = false, modifier = Modifier.testTag("external-import-completed"))
    }
}

/** OI-08: what is being sent, in one card that expands in place. */
@Composable
private fun ImportContentCard(batch: ExternalImportBatch) {
    var expanded by remember(batch.id) { mutableStateOf(false) }
    val expandable = batch.files.size > 1 || (batch.files.isNotEmpty() && batch.text != null) ||
        (batch.files.isEmpty() && (batch.text?.length ?: 0) > 90)
    val turn by animateFloatAsState(if (expanded) 180f else 0f, label = "import-expand")
    NeumorphSurface(Modifier.fillMaxWidth().testTag("external-import-summary"), shape = RoundedCornerShape(18.dp),
        onClick = if (expandable) ({ expanded = !expanded }) else null, contentInset = 0.dp) {
        Column(Modifier.animateContentSize()) {
            Row(Modifier.fillMaxWidth().padding(14.dp), verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                ImportContentIcon(batch, 40.dp)
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                    Text(importTitle(batch), style = MaterialTheme.typography.bodyLarge, fontWeight = FontWeight.Medium,
                        maxLines = 2, overflow = TextOverflow.Ellipsis)
                    Text(importKind(batch), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                if (expandable) Icon(OrbisSymbols.KeyboardArrowDown, null, Modifier.size(18.dp).rotate(turn), tint = LocalOrbisPalette.current.faint)
            }
            if (expanded && expandable) {
                ImportDivider(66.dp)
                Column(Modifier.fillMaxWidth().padding(start = 66.dp, end = 14.dp, top = 12.dp, bottom = 14.dp),
                    verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    batch.files.drop(1).forEach { file ->
                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                            Box(Modifier.weight(1f)) { FileNameText(file.name, style = MaterialTheme.typography.bodySmall) }
                            Text(formatByteCount(file.bytes), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                    }
                    batch.text?.takeIf { batch.files.isNotEmpty() || it.length > 90 }?.let { text ->
                        SelectionContainer {
                            Text(importPreview(text, 2000), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun ImportContentIcon(batch: ExternalImportBatch, size: androidx.compose.ui.unit.Dp) {
    val palette = LocalOrbisPalette.current
    Box(Modifier.size(size).clip(RoundedCornerShape(size * 0.28f)).background(palette.accentSoft), contentAlignment = Alignment.Center) {
        Icon(if (batch.files.isEmpty()) OrbisSymbols.ChatBubble else OrbisSymbols.Description, null,
            Modifier.size(size * 0.5f), tint = palette.accent)
    }
}

/** Shared selection language: a raised tile at rest, pressed in once chosen. */
@Composable
private fun ImportTargetRow(title: String, notes: List<String?>, agent: String?, selected: Boolean, enabled: Boolean = true,
                            showsIndicator: Boolean = true, modifier: Modifier = Modifier, onClick: (() -> Unit)? = null) {
    val palette = LocalOrbisPalette.current
    val interaction = remember { MutableInteractionSource() }
    NeumorphSurface(
        modifier = modifier.fillMaxWidth().then(if (onClick != null) Modifier.selectable(selected, enabled = enabled,
            role = Role.RadioButton, interactionSource = interaction, indication = null, onClick = onClick) else Modifier),
        interactionSource = interaction, enabled = enabled || onClick == null, shape = RemoteUi.ControlShape,
        style = if (selected && showsIndicator) NeumorphStyle.Pressed else NeumorphStyle.Raised, shadowScale = 0.5f,
    ) {
        Row(Modifier.fillMaxWidth().heightIn(min = 60.dp).padding(horizontal = 14.dp, vertical = 10.dp),
            verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            if (agent != null) AgentIcon(agentBrand(agent), Modifier.size(24.dp))
            else Icon(OrbisSymbols.ChatBubble, null, Modifier.size(22.dp), tint = palette.accent)
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                Text(title, style = MaterialTheme.typography.bodyLarge, fontWeight = FontWeight.Medium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                val line = notes.filterNotNull().joinToString(" · ")
                if (line.isNotEmpty()) Text(line, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            if (showsIndicator) {
                if (selected) Icon(OrbisSymbols.CheckCircleFill, null, Modifier.size(22.dp), tint = palette.accent)
                else Box(Modifier.size(20.dp).border(1.5.dp, palette.faint.copy(alpha = 0.5f), CircleShape))
            }
        }
    }
}

@Composable
private fun ImportLinkRow(icon: ImageVector, title: String, enabled: Boolean, modifier: Modifier = Modifier, onClick: () -> Unit) {
    NeumorphSurface(modifier = modifier.fillMaxWidth().semantics { this.role = Role.Button }, shape = RemoteUi.ControlShape,
        shadowScale = 0.5f, onClick = onClick, enabled = enabled) {
        Row(Modifier.fillMaxWidth().heightIn(min = 52.dp).padding(horizontal = 14.dp),
            verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Icon(icon, null, Modifier.size(22.dp), tint = LocalOrbisPalette.current.accent)
            Text(title, Modifier.weight(1f), style = MaterialTheme.typography.bodyLarge, fontWeight = FontWeight.Medium)
            Icon(OrbisSymbols.ChevronRight, null, Modifier.size(16.dp), tint = LocalOrbisPalette.current.faint)
        }
    }
}

@Composable
private fun ImportDivider(inset: androidx.compose.ui.unit.Dp = 0.dp) =
    HorizontalDivider(Modifier.padding(start = inset), thickness = 0.5.dp, color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.16f))

@Composable
private fun ImportHeading(title: String) {
    Text(title, Modifier.padding(start = 4.dp), style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
}

@Composable
private fun ImportEmpty(text: String, icon: ImageVector) {
    Column(Modifier.fillMaxWidth().padding(vertical = 28.dp), horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Icon(icon, null, Modifier.size(28.dp), tint = LocalOrbisPalette.current.faint)
        Text(text, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

@Composable
private fun ImportStatus(text: String) {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Icon(OrbisSymbols.History, null, Modifier.size(18.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
        Text(text, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

@Composable
private fun ImportNotice(text: String) {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Icon(OrbisSymbols.Error, null, Modifier.size(18.dp), tint = MaterialTheme.colorScheme.error)
        Text(text, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.error)
    }
}

private fun importTitle(batch: ExternalImportBatch): String =
    batch.files.firstOrNull()?.name ?: importPreview(batch.text.orEmpty().trim(), 200)

private fun importKind(batch: ExternalImportBatch): String =
    if (batch.files.isEmpty()) L10n.tr("文字")
    else L10n.tr("{0} 个文件 · {1}", batch.files.size, formatByteCount(batch.files.sumOf { it.bytes }))

private fun importStatusLine(batch: ExternalImportBatch): String {
    val destination = batch.destination
    val launch = batch.launch
    return when {
        destination != null -> L10n.tr("{0} · {1}", when (batch.attempt?.receipt) {
            ExternalImportReceipt.FAILED -> L10n.tr("发送失败")
            null -> L10n.tr("未发送")
            else -> L10n.tr("未确认")
        }, destination.sessionName)
        launch != null -> if (launch.failed) L10n.tr("新会话没有启动") else L10n.tr("{0} · {1}", L10n.tr("新会话未确认"), launch.hostName)
        else -> importKind(batch)
    }
}

private fun importPreview(body: String, limit: Int): String = if (body.length <= limit) body
    else body.take(limit).trimEnd(Char::isHighSurrogate) + "…"

private fun importPhaseText(phase: ImportPhase): String = when (phase) {
    is ImportPhase.Uploading -> L10n.tr("正在上传 {0}/{1}", phase.index, phase.total)
    ImportPhase.Sending -> L10n.tr("正在发送…")
    ImportPhase.Checking -> L10n.tr("正在检查…")
    ImportPhase.Launching -> L10n.tr("正在创建会话…")
}

private fun importProblemText(problem: ImportProblem): String = when (problem) {
    ImportProblem.EMPTY -> L10n.tr("没有可发送的内容")
    ImportProblem.UNSUPPORTED -> L10n.tr("不支持此分享内容")
    ImportProblem.LIMIT -> L10n.tr("内容超过大小或数量上限")
    ImportProblem.FULL -> L10n.tr("待发送内容已满，请先删除一些")
    ImportProblem.BUSY -> L10n.tr("上一条还在处理，请稍后再试")
    ImportProblem.UNREADABLE -> L10n.tr("无法读取分享的内容")
    ImportProblem.TARGET_UNAVAILABLE -> L10n.tr("所选会话已不可用")
    ImportProblem.LAUNCH_CONFIGURATION -> L10n.tr("会话配置还没准备好，请稍后再试")
    ImportProblem.HOST_UPGRADE -> L10n.tr("电脑端版本较旧，更新后才能发送")
    ImportProblem.UPLOAD_FAILED -> L10n.tr("上传未完成，附件已保留")
    ImportProblem.ALREADY_ASSIGNED -> L10n.tr("这条内容已选定其他会话")
}
