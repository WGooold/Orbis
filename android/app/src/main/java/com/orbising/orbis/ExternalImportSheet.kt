package com.orbising.orbis

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Badge
import androidx.compose.material3.ExperimentalMaterial3Api
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
import androidx.compose.ui.draw.clip
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
    val colors = rememberNeumorphColors()

    LaunchedEffect(selected?.id, choosingTarget) {
        targets = if (choosingTarget) remote.externalImportDestinations() else null
    }

    val pageTitle = when {
        launchHost != null -> L10n.tr("新建会话")
        choosingComputer -> L10n.tr("选择电脑")
        choosingTarget -> L10n.tr("选择已有会话")
        selected != null -> L10n.tr("待导入项")
        else -> L10n.tr("待导入")
    }
    val canGoBack = selected != null || choosingTarget || choosingComputer || launchHost != null
    fun handleBack() {
        if (launchHost != null) launchHost = null
        else if (choosingComputer) choosingComputer = false
        else if (choosingTarget) choosingTarget = false
        else model.select(null)
    }

    OrbisBottomSheet(onDismissRequest = model::close, maxHeightFraction = 0.88f) {
        Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp).testTag("external-import-sheet")) {
            Row(
                Modifier.fillMaxWidth().padding(bottom = 8.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(12.dp)
            ) {
                if (canGoBack) {
                    NeumorphIconButton(
                        onClick = ::handleBack,
                        icon = OrbisSymbols.ArrowBack,
                        contentDescription = L10n.tr("返回"),
                        enabled = !ui.busy,
                        size = 40.dp
                    )
                } else {
                    Spacer(Modifier.size(40.dp))
                }
                Text(
                    pageTitle,
                    style = MaterialTheme.typography.titleLarge,
                    fontWeight = FontWeight.SemiBold,
                    modifier = Modifier.weight(1f),
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis
                )
                NeumorphIconButton(
                    onClick = sheetCloseAction(model::close),
                    icon = OrbisSymbols.Close,
                    contentDescription = L10n.tr("关闭"),
                    size = 40.dp
                )
            }
            Column(
                Modifier.weight(1f, fill = false).verticalScroll(rememberScrollState()).padding(vertical = 12.dp),
                verticalArrangement = Arrangement.spacedBy(14.dp)
            ) {
                ui.problem?.let {
                    Row(
                        Modifier.fillMaxWidth().padding(horizontal = 4.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(8.dp)
                    ) {
                        Icon(OrbisSymbols.Error, contentDescription = null, tint = MaterialTheme.colorScheme.error, modifier = Modifier.size(18.dp))
                        Text(importProblemText(it), color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium)
                    }
                }
                if (ui.busy || (selected != null && ui.delivering == selected.id)) {
                    Text(L10n.tr("正在处理导入…"), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }

                val owner = launchHost?.let(remote::externalImportConnection)
                if (selected != null && owner != null) {
                    val state by owner.state.collectAsStateWithLifecycle()
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .clip(RoundedCornerShape(10.dp))
                            .background(colors.insetBase)
                            .padding(horizontal = 14.dp, vertical = 10.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(10.dp)
                    ) {
                        Icon(OrbisSymbols.Computer, contentDescription = null, tint = MaterialTheme.colorScheme.primary, modifier = Modifier.size(18.dp))
                        Text(owner.pairing.hostName ?: owner.hostId, style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.SemiBold)
                    }
                    androidx.compose.runtime.key(owner) {
                        SessionDraftCard(
                            state, true, null, owner::browseSessions, owner::browseInto, owner::browseUp,
                            onCancel = { launchHost = null },
                            onLoadConfiguration = owner::loadSessionConfiguration,
                            onSaveConfiguration = owner::saveSessionConfiguration,
                            importMode = true
                        ) { agent, cwd, note, _, _ ->
                            launchHost = null
                            choosingComputer = false
                            model.launch(selected, owner, agent, cwd, note)
                            true
                        }
                    }
                } else if (choosingComputer) {
                    val hosts = remote.externalImportHosts()
                    if (hosts.isEmpty()) {
                        Column(
                            modifier = Modifier.fillMaxWidth().padding(vertical = 40.dp),
                            horizontalAlignment = Alignment.CenterHorizontally,
                            verticalArrangement = Arrangement.spacedBy(12.dp)
                        ) {
                            Icon(OrbisSymbols.Computer, contentDescription = null, modifier = Modifier.size(40.dp), tint = LocalOrbisPalette.current.faint)
                            Text(L10n.tr("暂无可加入的会话"), color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodyMedium)
                        }
                    } else {
                        hosts.forEach { (host, _) ->
                            NeumorphSurface(
                                modifier = Modifier.fillMaxWidth(),
                                shape = RemoteUi.ControlShape,
                                onClick = { launchHost = host.hostId },
                                contentInset = 14.dp
                            ) {
                                Row(
                                    modifier = Modifier.fillMaxWidth(),
                                    verticalAlignment = Alignment.CenterVertically,
                                    horizontalArrangement = Arrangement.spacedBy(12.dp)
                                ) {
                                    Box(
                                        modifier = Modifier
                                            .size(38.dp)
                                            .clip(RoundedCornerShape(10.dp))
                                            .background(colors.insetBase),
                                        contentAlignment = Alignment.Center
                                    ) {
                                        Icon(OrbisSymbols.Computer, contentDescription = null, tint = MaterialTheme.colorScheme.primary, modifier = Modifier.size(20.dp))
                                    }
                                    Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                                        Text(host.name, style = MaterialTheme.typography.bodyLarge, fontWeight = FontWeight.SemiBold)
                                        Text(L10n.tr("已连接"), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                                    }
                                    Icon(OrbisSymbols.ChevronRight, contentDescription = null, tint = LocalOrbisPalette.current.faint, modifier = Modifier.size(16.dp))
                                }
                            }
                        }
                    }
                } else if (selected != null && choosingTarget) {
                    val destinations = targets
                    if (destinations == null) {
                        Text(L10n.tr("正在读取…"), modifier = Modifier.padding(16.dp), color = MaterialTheme.colorScheme.onSurfaceVariant)
                    } else if (destinations.isEmpty()) {
                        Column(
                            modifier = Modifier.fillMaxWidth().padding(vertical = 40.dp),
                            horizontalAlignment = Alignment.CenterHorizontally,
                            verticalArrangement = Arrangement.spacedBy(12.dp)
                        ) {
                            Icon(OrbisSymbols.ChatBubble, contentDescription = null, modifier = Modifier.size(40.dp), tint = LocalOrbisPalette.current.faint)
                            Text(L10n.tr("暂无可加入的会话"), color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodyMedium)
                        }
                    } else {
                        destinations.forEach { destination ->
                            NeumorphSurface(
                                modifier = Modifier.fillMaxWidth(),
                                shape = RemoteUi.ControlShape,
                                onClick = {
                                    choosingTarget = false
                                    model.assign(selected.id, destination) { remote.externalImportRuntime(destination.target) != null }
                                },
                                enabled = !ui.busy,
                                contentInset = 14.dp
                            ) {
                                Row(
                                    modifier = Modifier.fillMaxWidth(),
                                    verticalAlignment = Alignment.CenterVertically,
                                    horizontalArrangement = Arrangement.spacedBy(12.dp)
                                ) {
                                    Box(
                                        modifier = Modifier
                                            .size(38.dp)
                                            .clip(RoundedCornerShape(10.dp))
                                            .background(colors.insetBase),
                                        contentAlignment = Alignment.Center
                                    ) {
                                        Icon(OrbisSymbols.ChatBubble, contentDescription = null, tint = MaterialTheme.colorScheme.primary, modifier = Modifier.size(18.dp))
                                    }
                                    Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                                        Text(destination.sessionName, style = MaterialTheme.typography.bodyLarge, fontWeight = FontWeight.SemiBold)
                                        Text(L10n.tr("{0} · {1}", destination.hostName, destination.target.cwd), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                                    }
                                    Icon(OrbisSymbols.ChevronRight, contentDescription = null, tint = LocalOrbisPalette.current.faint, modifier = Modifier.size(16.dp))
                                }
                            }
                        }
                    }
                } else if (selected != null) {
                    if (selected.files.isNotEmpty()) {
                        NeumorphSurface(
                            modifier = Modifier.fillMaxWidth(),
                            shape = RemoteUi.ControlShape,
                            contentInset = 14.dp
                        ) {
                            Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                                selected.files.forEach { file ->
                                    Row(
                                        modifier = Modifier.fillMaxWidth(),
                                        verticalAlignment = Alignment.CenterVertically,
                                        horizontalArrangement = Arrangement.spacedBy(12.dp)
                                    ) {
                                        Box(
                                            modifier = Modifier
                                                .size(36.dp)
                                                .clip(RoundedCornerShape(8.dp))
                                                .background(colors.insetBase),
                                            contentAlignment = Alignment.Center
                                        ) {
                                            Icon(
                                                OrbisSymbols.Description,
                                                contentDescription = null,
                                                modifier = Modifier.size(18.dp),
                                                tint = MaterialTheme.colorScheme.primary
                                            )
                                        }
                                        Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                                            FileNameText(file.name, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold)
                                            Text(formatByteCount(file.bytes), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                                        }
                                    }
                                }
                            }
                        }
                    }

                    selected.text?.let { body ->
                        Box(
                            modifier = Modifier
                                .fillMaxWidth()
                                .clip(RoundedCornerShape(12.dp))
                                .background(colors.insetBase)
                                .neumorphInsetOverlay(RoundedCornerShape(12.dp))
                                .padding(14.dp)
                        ) {
                            SelectionContainer {
                                Text(
                                    importPreview(body, 2000),
                                    style = MaterialTheme.typography.bodyMedium,
                                    color = MaterialTheme.colorScheme.onSurface
                                )
                            }
                        }
                    }

                    val destination = selected.destination
                    val launch = selected.launch
                    if (destination != null) {
                        NeumorphSurface(
                            modifier = Modifier.fillMaxWidth(),
                            shape = RemoteUi.ControlShape,
                            contentInset = 14.dp
                        ) {
                            Row(
                                modifier = Modifier.fillMaxWidth(),
                                verticalAlignment = Alignment.CenterVertically,
                                horizontalArrangement = Arrangement.spacedBy(12.dp)
                            ) {
                                Box(
                                    modifier = Modifier
                                        .size(36.dp)
                                        .clip(RoundedCornerShape(8.dp))
                                        .background(colors.insetBase),
                                    contentAlignment = Alignment.Center
                                ) {
                                    Icon(
                                        OrbisSymbols.ChatBubble,
                                        contentDescription = null,
                                        modifier = Modifier.size(18.dp),
                                        tint = MaterialTheme.colorScheme.primary
                                    )
                                }
                                Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                                    Text(destination.sessionName, style = MaterialTheme.typography.bodyLarge, fontWeight = FontWeight.SemiBold)
                                    Text(L10n.tr("{0} · {1}", destination.hostName, destination.target.cwd), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                                }
                            }
                        }
                        val receipt = selected.attempt?.receipt
                        when {
                            receipt == ExternalImportReceipt.ACCEPTED -> {
                                Row(
                                    modifier = Modifier.fillMaxWidth().padding(horizontal = 4.dp),
                                    verticalAlignment = Alignment.CenterVertically,
                                    horizontalArrangement = Arrangement.spacedBy(8.dp)
                                ) {
                                    Icon(OrbisSymbols.CheckCircle, contentDescription = null, tint = MaterialTheme.colorScheme.primary, modifier = Modifier.size(20.dp))
                                    Text(L10n.tr("会话已接收"), style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.primary, fontWeight = FontWeight.SemiBold)
                                }
                            }
                            receipt?.mayCheck == true -> {
                                Text(L10n.tr("发送结果待核对"), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                                NeumorphActionButton(
                                    onClick = { model.deliver(selected, remote, null) },
                                    text = L10n.tr("核对结果"),
                                    icon = OrbisSymbols.Refresh,
                                    enabled = !ui.busy && ui.delivering == null,
                                    modifier = Modifier.fillMaxWidth()
                                )
                            }
                            else -> {
                                if (receipt == ExternalImportReceipt.FAILED) {
                                    Row(
                                        modifier = Modifier.fillMaxWidth().padding(horizontal = 4.dp),
                                        verticalAlignment = Alignment.CenterVertically,
                                        horizontalArrangement = Arrangement.spacedBy(8.dp)
                                    ) {
                                        Icon(OrbisSymbols.Error, contentDescription = null, tint = MaterialTheme.colorScheme.error, modifier = Modifier.size(20.dp))
                                        Text(L10n.tr("发送失败"), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.error)
                                    }
                                }
                                NeumorphTextField(
                                    instruction,
                                    { instruction = it },
                                    modifier = Modifier.fillMaxWidth(),
                                    placeholder = { Text(L10n.tr("补充要求（可选）")) },
                                    minLines = 2,
                                    maxLines = 5,
                                    enabled = !ui.busy && ui.delivering != selected.id
                                )
                                NeumorphActionButton(
                                    onClick = { model.deliver(selected, remote, instruction) },
                                    text = L10n.tr("发送"),
                                    icon = OrbisSymbols.ArrowUpward,
                                    enabled = !ui.busy && ui.delivering == null,
                                    modifier = Modifier.fillMaxWidth().testTag("external-import-send")
                                )
                                if (launch == null) {
                                    Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
                                        NeumorphTextButton(
                                            L10n.tr("移回待导入"),
                                            onClick = { model.unassign(selected.id, destination.target) },
                                            enabled = !ui.busy && ui.delivering != selected.id,
                                            dismissOnClick = false
                                        )
                                    }
                                }
                            }
                        }
                    } else if (launch != null) {
                        NeumorphSurface(
                            modifier = Modifier.fillMaxWidth(),
                            shape = RemoteUi.ControlShape,
                            contentInset = 14.dp
                        ) {
                            Row(
                                modifier = Modifier.fillMaxWidth(),
                                verticalAlignment = Alignment.CenterVertically,
                                horizontalArrangement = Arrangement.spacedBy(12.dp)
                            ) {
                                Box(
                                    modifier = Modifier
                                        .size(36.dp)
                                        .clip(RoundedCornerShape(8.dp))
                                        .background(colors.insetBase),
                                    contentAlignment = Alignment.Center
                                ) {
                                    Icon(
                                        OrbisSymbols.Computer,
                                        contentDescription = null,
                                        modifier = Modifier.size(18.dp),
                                        tint = MaterialTheme.colorScheme.primary
                                    )
                                }
                                Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                                    Text(launch.hostName, style = MaterialTheme.typography.bodyLarge, fontWeight = FontWeight.SemiBold)
                                    Text(launch.cwd, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                                }
                            }
                        }
                        if (launch.failed) {
                            Row(
                                modifier = Modifier.fillMaxWidth().padding(horizontal = 4.dp),
                                verticalAlignment = Alignment.CenterVertically,
                                horizontalArrangement = Arrangement.spacedBy(8.dp)
                            ) {
                                Icon(OrbisSymbols.Error, contentDescription = null, tint = MaterialTheme.colorScheme.error, modifier = Modifier.size(20.dp))
                                Text(L10n.tr("启动失败"), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.error)
                            }
                            Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
                                NeumorphTextButton(
                                    L10n.tr("移回待导入"),
                                    onClick = { model.clearFailedLaunch(selected.id, launch.id) },
                                    enabled = !ui.busy && ui.delivering == null,
                                    dismissOnClick = false
                                )
                            }
                        } else {
                            Text(L10n.tr("启动结果待核对"), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                            NeumorphActionButton(
                                onClick = { model.deliver(selected, remote, null) },
                                text = L10n.tr("核对结果"),
                                icon = OrbisSymbols.Refresh,
                                enabled = !ui.busy && ui.delivering == null,
                                modifier = Modifier.fillMaxWidth()
                            )
                        }
                    } else {
                        Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                            NeumorphActionButton(
                                onClick = { choosingTarget = true },
                                text = L10n.tr("加入会话草稿"),
                                icon = OrbisSymbols.ChatBubble,
                                enabled = !ui.busy,
                                modifier = Modifier.fillMaxWidth().testTag("external-import-choose-target")
                            )
                            NeumorphActionButton(
                                onClick = { choosingComputer = true },
                                text = L10n.tr("新建会话"),
                                icon = OrbisSymbols.Add,
                                enabled = !ui.busy && ui.delivering == null,
                                modifier = Modifier.fillMaxWidth().testTag("external-import-new-session")
                            )
                        }
                    }
                    Box(Modifier.fillMaxWidth().padding(top = 8.dp), contentAlignment = Alignment.Center) {
                        NeumorphTextButton(
                            L10n.tr("删除"),
                            onClick = { deleting = true },
                            danger = true,
                            icon = OrbisSymbols.Delete,
                            enabled = !ui.busy && ui.delivering != selected.id,
                            dismissOnClick = false
                        )
                    }
                } else {
                    if (ui.batches.isEmpty() && !ui.busy && ui.problem == null) {
                        Column(
                            modifier = Modifier.fillMaxWidth().padding(vertical = 48.dp),
                            horizontalAlignment = Alignment.CenterHorizontally,
                            verticalArrangement = Arrangement.spacedBy(12.dp)
                        ) {
                            Icon(
                                OrbisSymbols.Archive,
                                contentDescription = null,
                                modifier = Modifier.size(44.dp),
                                tint = LocalOrbisPalette.current.faint
                            )
                            Text(
                                L10n.tr("暂无待导入内容"),
                                style = MaterialTheme.typography.bodyMedium,
                                color = MaterialTheme.colorScheme.onSurfaceVariant
                            )
                        }
                    }
                    val unassigned = ui.batches.filter { it.destination == null && it.launch == null }
                    val drafts = ui.batches.filter { it.destination != null || it.launch != null }

                    if (unassigned.isNotEmpty()) {
                        if (drafts.isNotEmpty()) {
                            Text(
                                L10n.tr("待导入"),
                                style = MaterialTheme.typography.labelLarge,
                                fontWeight = FontWeight.SemiBold,
                                color = MaterialTheme.colorScheme.onSurfaceVariant
                            )
                        }
                        unassigned.forEach { BatchRow(it, model, enabled = !ui.busy) }
                    }

                    if (drafts.isNotEmpty()) {
                        Text(
                            L10n.tr("导入草稿"),
                            style = MaterialTheme.typography.labelLarge,
                            fontWeight = FontWeight.SemiBold,
                            color = MaterialTheme.colorScheme.primary
                        )
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
    val colors = rememberNeumorphColors()
    val destination = batch.destination
    val launch = batch.launch
    val isDraft = destination != null || launch != null
    val hasFiles = batch.files.isNotEmpty()

    NeumorphSurface(
        modifier = Modifier.fillMaxWidth().testTag("external-import-${batch.id}"),
        onClick = { model.select(batch.id) },
        enabled = enabled,
        shape = RemoteUi.ControlShape,
        contentInset = 14.dp
    ) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(12.dp)
        ) {
            Box(
                modifier = Modifier
                    .size(38.dp)
                    .clip(RoundedCornerShape(10.dp))
                    .background(colors.insetBase),
                contentAlignment = Alignment.Center
            ) {
                Icon(
                    if (hasFiles) OrbisSymbols.Description else OrbisSymbols.ChatBubble,
                    contentDescription = null,
                    modifier = Modifier.size(20.dp),
                    tint = if (isDraft) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant
                )
            }
            Column(
                modifier = Modifier.weight(1f),
                verticalArrangement = Arrangement.spacedBy(3.dp)
            ) {
                Text(
                    batch.files.firstOrNull()?.name ?: importPreview(batch.text.orEmpty(), 120),
                    style = MaterialTheme.typography.bodyLarge,
                    fontWeight = FontWeight.Medium,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis
                )
                val subtitle = when {
                    destination != null -> L10n.tr("{0} · {1}", destination.hostName, destination.sessionName)
                    launch != null -> L10n.tr("{0} · {1}", launch.hostName, launch.cwd)
                    hasFiles -> L10n.tr("{0} 个文件 · {1}", batch.files.size, formatByteCount(batch.files.sumOf { it.bytes }))
                    else -> formatByteCount(batch.text.orEmpty().toByteArray().size.toLong())
                }
                Text(
                    subtitle,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis
                )
            }
            if (isDraft) {
                Box(
                    modifier = Modifier
                        .clip(RoundedCornerShape(6.dp))
                        .background(MaterialTheme.colorScheme.primary.copy(alpha = 0.12f))
                        .padding(horizontal = 6.dp, vertical = 2.dp)
                ) {
                    Text(
                        L10n.tr("草稿"),
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.primary,
                        fontWeight = FontWeight.SemiBold
                    )
                }
            }
            Icon(
                OrbisSymbols.ChevronRight,
                contentDescription = null,
                modifier = Modifier.size(16.dp),
                tint = LocalOrbisPalette.current.faint
            )
        }
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
