package com.orbising.orbis

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp

@Composable
internal fun ExternalImportButton(count: Int, action: () -> Unit) {
    if (count > 0) NeumorphIconButton(action, OrbisSymbols.Folder,
        L10n.tr("待导入 · {0}", count), modifier = Modifier.testTag("external-import-inbox"), size = 40.dp)
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun ExternalImportSheet(ui: ExternalImportUi, model: ExternalImportViewModel, remote: RemoteViewModel) {
    val selected = ui.batches.firstOrNull { it.id == ui.selected }
    var instruction by remember(selected?.id) { mutableStateOf((selected?.attempt?.instruction ?: selected?.launch?.instruction).orEmpty()) }
    var deleting by remember(selected?.id) { mutableStateOf(false) }
    var choosingComputer by remember(selected?.id) { mutableStateOf(false) }
    var launchHost by remember(selected?.id) { mutableStateOf<String?>(null) }
    var choosingTarget by remember(selected?.id) { mutableStateOf(false) }
    var targets by remember(selected?.id) { mutableStateOf<List<ExternalImportDestination>?>(null) }
    LaunchedEffect(selected?.id, choosingTarget) {
        targets = if (choosingTarget) remote.externalImportDestinations() else null
    }
    OrbisBottomSheet(onDismissRequest = model::close, maxHeightFraction = 0.85f) {
        Column(Modifier.fillMaxWidth().padding(horizontal = 4.dp).testTag("external-import-sheet")) {
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                if (selected != null) NeumorphIconButton({
                    if (launchHost != null) launchHost = null else if (choosingComputer) choosingComputer = false
                    else if (choosingTarget) choosingTarget = false else model.select(null)
                }, OrbisSymbols.ArrowBack, L10n.tr("返回"), enabled = !ui.busy)
                Text(L10n.tr(if (choosingTarget) "选择已有会话" else "待导入"),
                    style = MaterialTheme.typography.titleLarge, modifier = Modifier.weight(1f))
                NeumorphIconButton(sheetCloseAction(model::close), OrbisSymbols.Close, L10n.tr("关闭"))
            }
            Column(Modifier.weight(1f, fill = false).verticalScroll(rememberScrollState()).padding(vertical = 16.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp)) {
                ui.problem?.let { Text(importProblemText(it), color = MaterialTheme.colorScheme.error) }
                if (ui.busy || (selected != null && ui.delivering == selected.id)) Text(L10n.tr("正在处理导入…"))
                val owner = launchHost?.let(remote::externalImportConnection)
                if (selected != null && owner != null) {
                    val state by owner.state.collectAsStateWithLifecycle()
                    Text(owner.pairing.hostName ?: owner.hostId, style = MaterialTheme.typography.labelLarge)
                    androidx.compose.runtime.key(owner) {
                        SessionDraftCard(state, true, null, owner::browseSessions, owner::browseInto, owner::browseUp,
                            onCancel = { launchHost = null }, onLoadConfiguration = owner::loadSessionConfiguration,
                            onSaveConfiguration = owner::saveSessionConfiguration, importMode = true) { agent, cwd, note, _, _ ->
                            launchHost = null; choosingComputer = false
                            model.launch(selected, owner, agent, cwd, note)
                            true
                        }
                    }
                } else if (choosingComputer) {
                    val hosts = remote.externalImportHosts()
                    if (hosts.isEmpty()) Text(L10n.tr("暂无可加入的会话"))
                    hosts.forEach { (host, _) ->
                        NeumorphTextButton(host.name, onClick = { launchHost = host.hostId }, dismissOnClick = false)
                    }
                } else if (selected != null && choosingTarget) {
                    val destinations = targets
                    if (destinations == null) Text(L10n.tr("正在读取…"))
                    else if (destinations.isEmpty()) Text(L10n.tr("暂无可加入的会话"))
                    else destinations.forEach { destination ->
                        NeumorphSurface(Modifier.fillMaxWidth(), onClick = {
                            choosingTarget = false
                            model.assign(selected.id, destination) { remote.externalImportRuntime(destination.target) != null }
                        }, enabled = !ui.busy, contentInset = 12.dp) { DestinationLabel(destination) }
                    }
                } else if (selected != null) {
                    selected.destination?.let { DestinationLabel(it) }
                    selected.files.forEach { file ->
                        Column(Modifier.fillMaxWidth()) {
                            Text(file.name, style = MaterialTheme.typography.bodyLarge)
                            Text(formatByteCount(file.bytes), style = MaterialTheme.typography.bodySmall)
                        }
                    }
                    selected.text?.let { body -> SelectionContainer { Text(importPreview(body, 2000)) } }
                    val destination = selected.destination
                    val launch = selected.launch
                    if (destination == null && launch != null) {
                        Text(L10n.tr("{0} · {1}", launch.hostName, launch.cwd))
                        Text(L10n.tr(if (launch.failed) "启动失败" else "启动结果待核对"))
                        if (launch.failed) NeumorphTextButton(L10n.tr("移回待导入"), onClick = { model.clearFailedLaunch(selected.id, launch.id) },
                            enabled = !ui.busy && ui.delivering == null, dismissOnClick = false)
                        else NeumorphTextButton(L10n.tr("核对结果"), onClick = { model.deliver(selected, remote, null) },
                            enabled = !ui.busy && ui.delivering == null, dismissOnClick = false)
                    } else if (destination == null) {
                        NeumorphTextButton(L10n.tr("加入会话草稿"), onClick = { choosingTarget = true }, enabled = !ui.busy,
                            modifier = Modifier.testTag("external-import-choose-target"), dismissOnClick = false)
                        NeumorphTextButton(L10n.tr("新建会话"), onClick = { choosingComputer = true }, enabled = !ui.busy && ui.delivering == null,
                            modifier = Modifier.testTag("external-import-new-session"), dismissOnClick = false)
                    } else {
                        val receipt = selected.attempt?.receipt
                        when {
                            receipt == ExternalImportReceipt.ACCEPTED -> Text(L10n.tr("会话已接收"))
                            receipt?.mayCheck == true -> {
                                Text(L10n.tr("发送结果待核对"))
                                NeumorphTextButton(L10n.tr("核对结果"), onClick = { model.deliver(selected, remote, null) },
                                    enabled = !ui.busy && ui.delivering == null, dismissOnClick = false)
                            }
                            else -> {
                                if (receipt == ExternalImportReceipt.FAILED) Text(L10n.tr("发送失败"), color = MaterialTheme.colorScheme.error)
                                NeumorphTextField(instruction, { instruction = it }, modifier = Modifier.fillMaxWidth(),
                                    placeholder = { Text(L10n.tr("补充要求（可选）")) }, minLines = 2, maxLines = 5,
                                    enabled = !ui.busy && ui.delivering != selected.id)
                                NeumorphTextButton(L10n.tr("发送"), onClick = { model.deliver(selected, remote, instruction) },
                                    enabled = !ui.busy && ui.delivering == null, modifier = Modifier.testTag("external-import-send"), dismissOnClick = false)
                                if (launch == null) NeumorphTextButton(L10n.tr("移回待导入"), onClick = { model.unassign(selected.id, destination.target) },
                                    enabled = !ui.busy && ui.delivering != selected.id, dismissOnClick = false)
                            }
                        }
                    }
                    NeumorphTextButton(L10n.tr("删除"), onClick = { deleting = true }, enabled = !ui.busy && ui.delivering != selected.id, dismissOnClick = false)
                } else {
                    if (ui.batches.isEmpty() && !ui.busy && ui.problem == null) Text(L10n.tr("暂无待导入内容"))
                    ui.batches.filter { it.destination == null && it.launch == null }.forEach { BatchRow(it, model, enabled = !ui.busy) }
                    val drafts = ui.batches.filter { it.destination != null || it.launch != null }
                    if (drafts.isNotEmpty()) {
                        Text(L10n.tr("导入草稿"), style = MaterialTheme.typography.labelLarge)
                        drafts.forEach { BatchRow(it, model, enabled = !ui.busy) }
                    }
                }
            }
        }
    }
    if (deleting && selected != null) NeumorphDialog(
        onDismissRequest = { deleting = false },
        title = { Text(L10n.tr("删除待导入内容？")) },
        text = {},
        dismissButton = { NeumorphTextButton(L10n.tr("取消"), onClick = { deleting = false }) },
        confirmButton = { NeumorphTextButton(L10n.tr("删除"), onClick = { deleting = false; model.delete(selected.id) }, danger = true) },
    )
}

@Composable
private fun BatchRow(batch: ExternalImportBatch, model: ExternalImportViewModel, enabled: Boolean) {
    NeumorphSurface(Modifier.fillMaxWidth().testTag("external-import-${batch.id}"),
        onClick = { model.select(batch.id) }, enabled = enabled, contentInset = 12.dp) {
        Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(batch.files.firstOrNull()?.name ?: importPreview(batch.text.orEmpty(), 120),
                maxLines = 2, overflow = TextOverflow.Ellipsis)
            val destination = batch.destination
            if (destination != null) Text(L10n.tr("{0} · {1}", destination.hostName, destination.sessionName),
                style = MaterialTheme.typography.bodySmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
            else if (batch.files.isNotEmpty()) Text(L10n.tr("{0} 个文件", batch.files.size), style = MaterialTheme.typography.bodySmall)
        }
    }
}

@Composable
private fun DestinationLabel(destination: ExternalImportDestination) {
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text(destination.sessionName, style = MaterialTheme.typography.bodyLarge)
        Text(L10n.tr("{0} · {1}", destination.hostName, destination.target.cwd), style = MaterialTheme.typography.bodySmall)
    }
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
