package com.orbising.orbis

import androidx.compose.foundation.layout.heightIn
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.runtime.key
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Badge
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
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
                contentDescription = L10n.tr("待导入 · {0}", count),
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

private enum class ImportRoute { PREVIEW, SESSIONS, COMPUTERS, SETUP }

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun ExternalImportSheet(ui: ExternalImportUi, model: ExternalImportViewModel, remote: RemoteViewModel) {
    val batch = ui.batches.firstOrNull { it.id == ui.selected }
    var route by remember(batch?.id) { mutableStateOf(ImportRoute.PREVIEW) }
    var launchHost by remember(batch?.id) { mutableStateOf<String?>(null) }
    var setupBack by remember(batch?.id) { mutableStateOf(ImportRoute.SESSIONS) }
    var instruction by remember(batch?.id) { mutableStateOf((batch?.attempt?.instruction ?: batch?.launch?.instruction).orEmpty()) }
    var deleting by remember(batch?.id) { mutableStateOf(false) }
    val focus = LocalFocusManager.current
    val hosts by remote.hosts.collectAsStateWithLifecycle()
    var targets by remember(batch?.id) { mutableStateOf<List<ExternalImportDestination>?>(null) }
    val choosing = route == ImportRoute.SESSIONS && batch?.destination == null
    LaunchedEffect(batch?.id, choosing, hosts) {
        targets = if (choosing) remote.externalImportDestinations() else null
    }
    val destination = batch?.destination
    val launch = batch?.launch
    val receipt = batch?.attempt?.receipt
    val processing = ui.busy || (batch != null && ui.delivering == batch.id)
    val actionable = !ui.busy && ui.delivering == null
    val editable = destination != null && (receipt == null || receipt == ExternalImportReceipt.FAILED)
    val screen = if (destination != null || launch != null) ImportRoute.PREVIEW else route
    val title = when {
        batch == null -> L10n.tr("待导入")
        screen == ImportRoute.SESSIONS -> L10n.tr("选择发送目标")
        screen == ImportRoute.COMPUTERS -> L10n.tr("选择电脑")
        screen == ImportRoute.SETUP -> L10n.tr("新建会话")
        receipt == ExternalImportReceipt.ACCEPTED -> L10n.tr("会话已接收")
        editable -> L10n.tr("发送到会话")
        else -> L10n.tr("分享内容")
    }

    fun back() {
        focus.clearFocus()
        when (screen) {
            ImportRoute.SETUP -> { launchHost = null; route = setupBack }
            ImportRoute.COMPUTERS -> route = ImportRoute.SESSIONS
            ImportRoute.SESSIONS -> route = ImportRoute.PREVIEW
            ImportRoute.PREVIEW -> model.select(null)
        }
    }

    OrbisBottomSheet(onDismissRequest = model::close, maxHeightFraction = 0.94f) {
        Column(Modifier.fillMaxWidth().padding(horizontal = 20.dp).testTag("external-import-sheet")) {
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                if (batch != null) NeumorphIconButton(::back, OrbisSymbols.ArrowBack, L10n.tr("返回"), enabled = !ui.busy, size = 36.dp)
                Text(title, Modifier.weight(1f), style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.SemiBold)
                if (batch != null && screen == ImportRoute.PREVIEW) {
                    NeumorphIconButton({ deleting = true }, OrbisSymbols.Delete, L10n.tr("删除"), enabled = !processing, size = 36.dp)
                }
                NeumorphIconButton(sheetCloseAction(model::close), OrbisSymbols.Close, L10n.tr("关闭"), size = 36.dp)
            }
            if (processing) LinearProgressIndicator(Modifier.fillMaxWidth())
            key(batch?.id, screen, destination?.target, launch?.id) {
                Column(Modifier.weight(1f, fill = false).verticalScroll(rememberScrollState()).padding(vertical = 12.dp),
                    verticalArrangement = Arrangement.spacedBy(16.dp)) {
                    ui.problem?.let { ImportStatus(importProblemText(it), OrbisSymbols.Error, error = true) }
                    when {
                        batch == null -> {
                            if (ui.batches.isEmpty() && !processing && ui.problem == null) ImportEmpty(L10n.tr("暂无待导入内容"), OrbisSymbols.Archive)
                            val (pending, placed) = ui.batches.partition { it.destination == null && it.launch == null }
                            if (pending.isNotEmpty()) ImportGroup {
                                pending.forEachIndexed { index, item ->
                                    if (index > 0) ImportDivider()
                                    BatchRow(item, model, !ui.busy)
                                }
                            }
                            if (placed.isNotEmpty()) {
                                ImportHeading(L10n.tr("导入记录"))
                                ImportGroup {
                                    placed.forEachIndexed { index, item ->
                                        if (index > 0) ImportDivider()
                                        BatchRow(item, model, !ui.busy)
                                    }
                                }
                            }
                        }
                        screen == ImportRoute.SESSIONS -> {
                            val available = targets
                            when {
                                available == null -> Text(L10n.tr("正在读取…"), style = MaterialTheme.typography.bodyMedium)
                                available.isEmpty() -> ImportEmpty(L10n.tr("暂无可加入的会话"), OrbisSymbols.ChatBubble)
                                else -> available.groupBy { it.target.hostId }.values.forEach { group ->
                                    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                                        ImportHeading(group.first().hostName)
                                        ImportGroup {
                                            group.forEachIndexed { index, target ->
                                                if (index > 0) ImportDivider()
                                                ImportRow(OrbisSymbols.ChatBubble, target.sessionName, target.target.cwd, enabled = actionable,
                                                    onClick = {
                                                        model.assign(batch.id, target) { remote.externalImportRuntime(target.target) != null }
                                                    })
                                            }
                                        }
                                    }
                                }
                            }
                        }
                        screen == ImportRoute.COMPUTERS -> {
                            val computers = remote.externalImportHosts()
                            if (computers.isEmpty()) ImportEmpty(L10n.tr("暂无可用电脑"), OrbisSymbols.Computer)
                            else ImportGroup {
                                computers.forEachIndexed { index, (host, _) ->
                                    if (index > 0) ImportDivider()
                                    ImportRow(OrbisSymbols.Computer, host.name, enabled = actionable,
                                        onClick = { launchHost = host.hostId; setupBack = ImportRoute.COMPUTERS; route = ImportRoute.SETUP })
                                }
                            }
                        }
                        screen == ImportRoute.SETUP -> {
                            val owner = launchHost?.let(remote::externalImportConnection)
                            if (owner == null) ImportEmpty(L10n.tr("暂无可用电脑"), OrbisSymbols.Computer)
                            else {
                                val state by owner.state.collectAsStateWithLifecycle()
                                ImportHeading(owner.pairing.hostName ?: owner.hostId)
                                key(owner) {
                                    SessionDraftCard(state, true, null, owner::browseSessions, owner::browseInto, owner::browseUp,
                                        onCancel = ::back, onLoadConfiguration = owner::loadSessionConfiguration,
                                        onSaveConfiguration = owner::saveSessionConfiguration, importMode = true
                                    ) { agent, cwd, note, _, _ ->
                                        launchHost = null; route = ImportRoute.PREVIEW
                                        model.launch(batch, owner, agent, cwd, note)
                                        true
                                    }
                                }
                            }
                        }
                        else -> {
                            if (destination != null) ImportGroup {
                                val change: (() -> Unit)? = if (editable && launch == null) ({
                                    focus.clearFocus()
                                    route = ImportRoute.SESSIONS
                                    model.unassign(batch.id, destination.target)
                                }) else null
                                ImportRow(OrbisSymbols.ChatBubble, destination.sessionName,
                                    L10n.tr("{0} · {1}", destination.hostName, destination.target.cwd),
                                    actionLabel = if (change != null) L10n.tr("更换会话") else null,
                                    enabled = actionable, onClick = change)
                            } else if (launch != null) ImportGroup { ImportRow(OrbisSymbols.Computer, launch.hostName, launch.cwd) }
                            when {
                                receipt == ExternalImportReceipt.FAILED -> ImportStatus(L10n.tr("发送失败"), OrbisSymbols.Error, true)
                                receipt?.mayCheck == true -> ImportStatus(L10n.tr("发送结果待核对"), OrbisSymbols.Refresh)
                                destination == null && launch?.failed == true -> ImportStatus(L10n.tr("启动失败"), OrbisSymbols.Error, true)
                                destination == null && launch != null -> ImportStatus(L10n.tr("启动结果待核对"), OrbisSymbols.Refresh)
                            }
                            ImportPayload(batch, muted = destination != null || launch != null)
                            if (editable) NeumorphTextField(instruction, { instruction = it },
                                modifier = Modifier.fillMaxWidth(), placeholder = { Text(L10n.tr("补充要求（可选）")) },
                                minLines = 2, maxLines = 5, enabled = !processing)
                        }
                    }
                }
            }
            if (batch != null) {
                @Composable fun action(label: String, icon: ImageVector, tag: String = "", run: () -> Unit) {
                    ImportDivider()
                    NeumorphActionButton(onClick = { focus.clearFocus(); run() }, text = label, icon = icon,
                        modifier = Modifier.fillMaxWidth().padding(vertical = 8.dp).then(if (tag.isEmpty()) Modifier else Modifier.testTag(tag)),
                        enabled = actionable)
                }
                when {
                    screen == ImportRoute.SESSIONS -> action(L10n.tr("新建会话"), OrbisSymbols.Add, "external-import-new-session") {
                        val computers = remote.externalImportHosts()
                        if (computers.size == 1) {
                            launchHost = computers.first().first.hostId; setupBack = ImportRoute.SESSIONS; route = ImportRoute.SETUP
                        } else route = ImportRoute.COMPUTERS
                    }
                    screen != ImportRoute.PREVIEW -> Unit
                    editable -> action(L10n.tr("发送"), OrbisSymbols.ArrowUpward, "external-import-send") { model.deliver(batch, remote, instruction) }
                    receipt?.mayCheck == true || (destination == null && launch != null && !launch.failed) ->
                        action(L10n.tr("核对结果"), OrbisSymbols.Refresh) { model.deliver(batch, remote, null) }
                    destination == null && launch?.failed == true ->
                        action(L10n.tr("移回待导入"), OrbisSymbols.Archive) { model.clearFailedLaunch(batch.id, launch.id) }
                    destination == null && launch == null -> action(L10n.tr("选择发送目标"), OrbisSymbols.ArrowUpward, "external-import-choose-target") { route = ImportRoute.SESSIONS }
                }
            }
        }
    }
    if (deleting && batch != null) NeumorphDialog(
        onDismissRequest = { deleting = false }, title = { Text(L10n.tr("删除待导入内容？")) }, text = {},
        dismissButton = { NeumorphTextButton(L10n.tr("取消"), onClick = { deleting = false }) },
        confirmButton = { NeumorphTextButton(L10n.tr("删除"), onClick = { deleting = false; model.delete(batch.id) }, danger = true, enabled = !processing) },
    )
}

@Composable
private fun ImportDivider() = HorizontalDivider(thickness = 0.5.dp, color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.16f))

@Composable
private fun ImportGroup(content: @Composable () -> Unit) {
    NeumorphSurface(Modifier.fillMaxWidth(), shape = RemoteUi.ControlShape, style = NeumorphStyle.Pressed, contentInset = 0.dp) {
        Column { content() }
    }
}

@Composable
private fun ImportHeading(title: String) {
    Text(title, style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
}

@Composable
private fun ImportRow(icon: ImageVector, title: String, subtitle: String? = null, actionLabel: String? = null,
                      modifier: Modifier = Modifier, enabled: Boolean = true, onClick: (() -> Unit)? = null) {
    NeumorphSurface(modifier = modifier.fillMaxWidth(), shape = RemoteUi.ControlShape,
        flat = true, onClick = onClick, enabled = enabled) {
        Row(Modifier.fillMaxWidth().heightIn(min = 56.dp).padding(horizontal = 14.dp, vertical = 10.dp),
            verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Icon(icon, null, Modifier.size(20.dp), tint = MaterialTheme.colorScheme.primary)
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                Text(title, style = MaterialTheme.typography.bodyLarge, fontWeight = FontWeight.Medium, maxLines = 2, overflow = TextOverflow.Ellipsis)
                subtitle?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 2, overflow = TextOverflow.Ellipsis) }
            }
            if (actionLabel != null) Text(actionLabel, style = MaterialTheme.typography.labelMedium,
                color = if (enabled) MaterialTheme.colorScheme.primary else LocalOrbisPalette.current.faint,
                modifier = Modifier.weight(0.45f, fill = false))
            else if (onClick != null) Icon(OrbisSymbols.ChevronRight, null, Modifier.size(16.dp), tint = LocalOrbisPalette.current.faint)
        }
    }
}

@Composable
private fun ImportEmpty(text: String, icon: ImageVector) {
    Column(Modifier.fillMaxWidth().padding(vertical = 32.dp), horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Icon(icon, null, Modifier.size(28.dp), tint = LocalOrbisPalette.current.faint)
        Text(text, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

@Composable
private fun ImportStatus(text: String, icon: ImageVector, error: Boolean = false) {
    val color = if (error) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Icon(icon, null, Modifier.size(18.dp), tint = color)
        Text(text, style = MaterialTheme.typography.bodyMedium, color = color)
    }
}

@Composable
private fun ImportPayload(batch: ExternalImportBatch, muted: Boolean) {
    var expanded by remember(batch.id, muted) { mutableStateOf(false) }
    val fold = !expanded && (muted || batch.files.size > 3 || (batch.text?.length ?: 0) > 260)
    val files = if (fold && muted) emptyList() else if (fold) batch.files.take(3) else batch.files
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        if (files.isNotEmpty()) {
            ImportHeading(L10n.tr("{0} 个文件", batch.files.size))
            ImportGroup {
                files.forEachIndexed { index, file ->
                    if (index > 0) ImportDivider()
                    Row(Modifier.fillMaxWidth().padding(14.dp), verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                        Icon(OrbisSymbols.Description, null, Modifier.size(18.dp), tint = MaterialTheme.colorScheme.primary)
                        Box(Modifier.weight(1f)) { FileNameText(file.name, style = MaterialTheme.typography.bodyMedium) }
                        Text(formatByteCount(file.bytes), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
            }
        }
        batch.text?.takeUnless { fold && muted }?.let { text ->
            ImportHeading(L10n.tr("分享文字"))
            ImportGroup {
                SelectionContainer { Text(importPreview(text, if (fold) 260 else 2000), Modifier.padding(14.dp), style = MaterialTheme.typography.bodyMedium) }
            }
        }
        if (fold || expanded) {
            NeumorphTextButton(if (expanded) L10n.tr("收起") else L10n.tr("查看分享内容"),
                onClick = { expanded = !expanded }, dismissOnClick = false)
        }
    }
}

@Composable
private fun BatchRow(batch: ExternalImportBatch, model: ExternalImportViewModel, enabled: Boolean) {
    val destination = batch.destination
    val launch = batch.launch
    val status = when (batch.attempt?.receipt) {
        ExternalImportReceipt.ACCEPTED -> L10n.tr("已接收")
        ExternalImportReceipt.FAILED -> L10n.tr("失败")
        null -> if (destination != null) L10n.tr("待发送") else launch?.let { if (it.failed) L10n.tr("失败") else L10n.tr("待核对") }
        else -> L10n.tr("待核对")
    }
    val context = when {
        destination != null -> destination.sessionName
        launch != null -> launch.hostName
        batch.files.isNotEmpty() -> L10n.tr("{0} 个文件 · {1}", batch.files.size, formatByteCount(batch.files.sumOf { it.bytes }))
        else -> L10n.tr("分享文字")
    }
    ImportRow(if (batch.files.isEmpty()) OrbisSymbols.ChatBubble else OrbisSymbols.Description,
        batch.files.firstOrNull()?.name ?: importPreview(batch.text.orEmpty(), 120),
        status?.let { L10n.tr("{0} · {1}", it, context) } ?: context,
        modifier = Modifier.testTag("external-import-${batch.id}"), enabled = enabled, onClick = { model.select(batch.id) })
}

private fun importPreview(body: String, limit: Int): String = if (body.length <= limit) body
    else body.take(limit).trimEnd(Char::isHighSurrogate) + "…"

private fun importProblemText(problem: ImportProblem): String = when (problem) {
    ImportProblem.EMPTY -> L10n.tr("没有可导入的内容")
    ImportProblem.UNSUPPORTED -> L10n.tr("不支持此分享内容")
    ImportProblem.LIMIT -> L10n.tr("导入内容超过大小或数量上限")
    ImportProblem.FULL -> L10n.tr("待导入空间已满")
    ImportProblem.BUSY -> L10n.tr("已有导入正在进行，请稍后重试")
    ImportProblem.UNREADABLE -> L10n.tr("无法读取导入内容")
    ImportProblem.TARGET_UNAVAILABLE -> L10n.tr("所选会话已不可用")
    ImportProblem.LAUNCH_CONFIGURATION -> L10n.tr("配置未确认，请刷新核对")
    ImportProblem.HOST_UPGRADE -> L10n.tr("更新电脑端后可发送导入内容")
    ImportProblem.UPLOAD_FAILED -> L10n.tr("上传未完成，附件已保留")
    ImportProblem.ALREADY_ASSIGNED -> L10n.tr("此内容已加入其他会话草稿")
}
