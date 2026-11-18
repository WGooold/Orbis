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
import androidx.compose.runtime.Composable
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
internal fun ExternalImportSheet(ui: ExternalImportUi, model: ExternalImportViewModel) {
    val selected = ui.batches.firstOrNull { it.id == ui.selected }
    var deleting by remember(selected?.id) { mutableStateOf(false) }
    OrbisBottomSheet(onDismissRequest = model::close, maxHeightFraction = 0.85f) {
        Column(Modifier.fillMaxWidth().padding(horizontal = 4.dp).testTag("external-import-sheet")) {
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                if (selected != null) NeumorphIconButton({ model.select(null) }, OrbisSymbols.ArrowBack, L10n.tr("返回"))
                Text(L10n.tr("待导入"), style = MaterialTheme.typography.titleLarge, modifier = Modifier.weight(1f))
                NeumorphIconButton(sheetCloseAction(model::close), OrbisSymbols.Close, L10n.tr("关闭"))
            }
            Column(Modifier.weight(1f, fill = false).verticalScroll(rememberScrollState()).padding(vertical = 16.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp)) {
                ui.problem?.let { Text(importProblemText(it), color = MaterialTheme.colorScheme.error) }
                if (ui.busy) Text(L10n.tr("正在处理导入…"))
                if (selected != null) {
                    selected.files.forEach { file ->
                        Column(Modifier.fillMaxWidth()) {
                            Text(file.name, style = MaterialTheme.typography.bodyLarge)
                            Text(formatByteCount(file.bytes), style = MaterialTheme.typography.bodySmall)
                        }
                    }
                    selected.text?.let { body -> SelectionContainer { Text(importPreview(body, 2000)) } }
                    NeumorphTextButton(L10n.tr("删除"), onClick = { deleting = true }, enabled = !ui.busy, dismissOnClick = false)
                } else {
                    if (ui.batches.isEmpty() && !ui.busy && ui.problem == null) Text(L10n.tr("暂无待导入内容"))
                    ui.batches.forEach { batch ->
                        NeumorphSurface(Modifier.fillMaxWidth().testTag("external-import-${batch.id}"),
                            onClick = { model.select(batch.id) }, contentInset = 12.dp) {
                            Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                                Text(batch.files.firstOrNull()?.name ?: importPreview(batch.text.orEmpty(), 120),
                                    maxLines = 2, overflow = TextOverflow.Ellipsis)
                                if (batch.files.isNotEmpty()) Text(L10n.tr("{0} 个文件", batch.files.size),
                                    style = MaterialTheme.typography.bodySmall)
                            }
                        }
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

private fun importPreview(body: String, limit: Int): String = if (body.length <= limit) body
    else body.take(limit).trimEnd(Char::isHighSurrogate) + "…"

private fun importProblemText(problem: ImportProblem): String = when (problem) {
    ImportProblem.EMPTY -> L10n.tr("没有可导入的内容")
    ImportProblem.UNSUPPORTED -> L10n.tr("不支持此分享内容")
    ImportProblem.LIMIT -> L10n.tr("导入内容超过大小或数量上限")
    ImportProblem.FULL -> L10n.tr("待导入空间已满")
    ImportProblem.BUSY -> L10n.tr("已有导入正在进行，请稍后重试")
    ImportProblem.UNREADABLE -> L10n.tr("无法读取导入内容")
}
