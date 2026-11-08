package com.orbising.orbis

import com.orbising.orbis.OrbisBottomSheet as ModalBottomSheet

import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import java.util.Locale

internal fun toolPartTitle(part: String): String = when (part) {
    "arguments" -> L10n.tr("参数")
    "result" -> L10n.tr("结果")
    else -> L10n.tr("输出")
}

/** Expanding a summary is local; full content is read only after choosing a part. */
@Composable
internal fun ToolSummaryDisclosure(summary: ToolSummary, canRead: Boolean, onReadPart: (String) -> Unit) {
    var expanded by rememberSaveable(summary.tool) { mutableStateOf(false) }
    val phase = when (summary.phase) {
        "started", "running" -> L10n.tr("执行中")
        "cancelled" -> L10n.tr("已取消")
        else -> if (summary.isError == true) L10n.tr("执行失败") else L10n.tr("已完成")
    }
    val rotation by animateFloatAsState(if (expanded) 180f else 0f, tween(InteractionMotion.duration(InteractionMotion.Selection)), label = "tool-disclosure")
    var glyphActivation by remember { mutableStateOf(0) }
    NeumorphSurface(
        modifier = Modifier.fillMaxWidth(), style = NeumorphStyle.Pressed,
        shape = RoundedCornerShape(14.dp), shadowScale = 0.35f, contentInset = 12.dp,
    ) {
        Column(Modifier.padding(horizontal = 12.dp, vertical = 4.dp)) {
            Row(
                Modifier.fillMaxWidth()
                    .semantics { contentDescription = L10n.tr("{0}{1}，{2}", if (expanded) L10n.tr("收起") else L10n.tr("展开"), summary.toolName, phase) }
                    .orbisKeyboardFocus().clickable(interactionSource = remember { MutableInteractionSource() }, indication = null, role = Role.Button) { glyphActivation++; expanded = !expanded }
                    .heightIn(min = RemoteUi.TouchTarget),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Icon(
                    if (summary.isError == true) OrbisSymbols.Error else OrbisSymbols.Build,
                    contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.size(17.dp).actionGlyphMotion(glyphActivation),
                )
                Text(summary.toolName, Modifier.weight(1f, fill = false), style = MaterialTheme.typography.labelLarge,
                    fontWeight = FontWeight.Medium, maxLines = 2, overflow = TextOverflow.Ellipsis)
                Text(phase, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1)
                Spacer(Modifier.weight(1f))
                Icon(OrbisSymbols.KeyboardArrowDown, contentDescription = null,
                    tint = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.size(18.dp).rotate(rotation))
            }
            OrbisCollapse(expanded) {
                Column(Modifier.fillMaxWidth().padding(bottom = 10.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    if (summary.durationMs != null || summary.exitCode != null) {
                        Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                            summary.durationMs?.let { SummaryCaption(L10n.tr("耗时 {0} 秒", String.format(L10n.locale, "%.1f", it / 1000.0))) }
                            summary.exitCode?.let { SummaryCaption(L10n.tr("退出码 {0}", it)) }
                        }
                    }
                    listOfNotNull(summary.inputSummary, summary.resultSummary, summary.errorSummary).forEach { part ->
                        SelectionContainer {
                            Text(part.text, style = MaterialTheme.typography.bodySmall, fontFamily = FontFamily.Monospace)
                        }
                        if (part.omitted) SummaryCaption(L10n.tr("已省略部分内容"))
                    }
                    summary.contents.filter { it.availability != "absent" }.forEach { part ->
                        NeumorphActionButton(
                            text = L10n.tr("查看") + toolPartTitle(part.part), icon = Icons.Rounded.FindInPage,
                            onClick = { onReadPart(part.part) }, modifier = Modifier.fillMaxWidth(),
                            enabled = canRead && part.readCapability != "none" && part.availability in setOf("readable", "pending"),
                        )
                        when (part.availability) {
                            "temporarily-unavailable" -> SummaryCaption(L10n.tr("来源暂时无法提供此部分内容"))
                            "unrecoverable" -> SummaryCaption(L10n.tr("此部分内容已无法恢复"))
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun SummaryCaption(text: String) {
    Text(text, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
}

/** Large detail sheet with a stable paging footer, matching the iOS reader. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun ToolDetailSheet(
    detail: ToolDetailView,
    onClose: () -> Unit,
    onReadNext: () -> Unit,
    onRetry: () -> Unit,
    onClear: () -> Unit,
    onFollow: (Boolean) -> Unit,
    onExport: () -> Unit,
) {
    val loading = detail.requestId != null
    ModalBottomSheet(
        onDismissRequest = onClose,
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        modifier = Modifier.fillMaxHeight(0.94f).testTag("tool-detail-sheet"), dragHandle = null,
        containerColor = MaterialTheme.colorScheme.background, tonalElevation = 0.dp,
    ) {
        val topInset = WindowInsets.statusBars.asPaddingValues().calculateTopPadding().coerceAtLeast(24.dp)
        Column(
            Modifier.fillMaxWidth().weight(1f).navigationBarsPadding().padding(top = topInset, bottom = 16.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            Row(Modifier.fillMaxWidth().padding(horizontal = 20.dp), verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                NeumorphIconButton(onClick = onClose, icon = OrbisSymbols.Close, contentDescription = L10n.tr("关闭"))
                Text(detail.summary.toolName, Modifier.weight(1f), style = MaterialTheme.typography.titleLarge,
                    maxLines = 1, overflow = TextOverflow.Ellipsis)
                CopyIconButton(L10n.tr("复制已读取内容"), size = 40.dp, enabled = detail.text.isNotEmpty()) { detail.text }
            }
            Row(Modifier.fillMaxWidth().padding(horizontal = 24.dp), verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                Text(toolPartTitle(detail.part), Modifier.weight(1f), style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.SemiBold)
                SummaryCaption(L10n.tr("已读取至 {0}", formatByteCount(detail.offset)))
            }
            if (detail.gaps.isNotEmpty()) {
                Text(L10n.tr("来源存在不可恢复的内容缺口，当前读取范围不代表完整输出。"),
                    Modifier.padding(horizontal = 24.dp), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
            }
            key(detail.viewerId) {
                NeumorphSurface(
                    modifier = Modifier.fillMaxWidth().weight(1f).padding(horizontal = 20.dp).testTag("tool-detail-content"),
                    style = NeumorphStyle.Pressed, shape = RemoteUi.ControlShape, shadowScale = 0.4f,
                ) {
                    Box(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).horizontalScroll(rememberScrollState()).padding(18.dp)) {
                        SelectionContainer {
                            Text(detail.text.ifEmpty { if (loading) L10n.tr("读取中…") else L10n.tr("当前范围没有文本内容。") },
                                style = MaterialTheme.typography.bodySmall, fontFamily = FontFamily.Monospace)
                        }
                    }
                }
            }
            Box(Modifier.fillMaxWidth().heightIn(min = RemoteUi.FieldHeight).padding(horizontal = 24.dp).testTag("tool-read-footer"), contentAlignment = Alignment.Center) {
                when {
                    detail.error != null -> Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                        Text(detail.error, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
                        NeumorphActionButton(text = L10n.tr("重新读取"), icon = OrbisSymbols.Refresh, onClick = onRetry,
                            modifier = Modifier.fillMaxWidth(), enabled = !loading && !detail.exporting)
                        if (L10n.matches(detail.error, "已读取内容达到 2 MiB 缓存上限，可清空已读内容后继续")) {
                            NeumorphTextButton(L10n.tr("清空已读并继续"), onClick = onClear, modifier = Modifier.fillMaxWidth(), enabled = !loading && !detail.exporting)
                        }
                    }
                    detail.nextCursor != null -> NeumorphActionButton(
                        text = if (loading) L10n.tr("正在读取…") else L10n.tr("读取下一页"), icon = OrbisSymbols.ArrowDownward, onClick = onReadNext,
                        modifier = Modifier.fillMaxWidth(), enabled = !loading && !detail.exporting,
                    )
                    loading -> CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp)
                    else -> SummaryCaption(if (detail.contentFinal) L10n.tr("已到当前读取范围末尾") else L10n.tr("已到当前末尾，工具可能仍在运行"))
                }
            }
            if (detail.exporting) {
                Row(Modifier.padding(horizontal = 24.dp), verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    CircularProgressIndicator(Modifier.size(20.dp).testTag("tool-export-progress"), strokeWidth = 2.dp)
                    SummaryCaption(L10n.tr("正在导出，{0}", formatByteCount(detail.exportedBytes)))
                    Spacer(Modifier.weight(1f))
                    NeumorphTextButton(L10n.tr("取消导出"), onClick = onClose)
                }
            } else {
                NeumorphActionButton(text = L10n.tr("导出当前部分"), icon = OrbisSymbols.Download, onClick = onExport,
                    modifier = Modifier.fillMaxWidth().padding(horizontal = 24.dp).testTag("tool-export"), enabled = !loading)
                if (detail.exportComplete) {
                    Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) { SummaryCaption(L10n.tr("已导出 {0}", formatByteCount(detail.exportedBytes))) }
                }
            }
            val canFollow = !detail.exporting && !(detail.contentFinal && detail.nextCursor == null)
            ToolFollowToggle(detail.follow, canFollow, onFollow)
        }
    }
}

/** Recessed track and raised thumb use the same dimensions as iOS NeuToggleStyle. */
@Composable
private fun ToolFollowToggle(checked: Boolean, enabled: Boolean, onCheckedChange: (Boolean) -> Unit) {
    val thumbOffset by animateFloatAsState(if (checked) 26f else 4f, OrbisMotion.pop(), label = "tool-follow")
    Row(
        Modifier.fillMaxWidth().padding(horizontal = 24.dp).alpha(if (enabled) 1f else 0.4f)
            .toggleable(value = checked, enabled = enabled, role = Role.Switch,
                interactionSource = remember { MutableInteractionSource() }, indication = null, onValueChange = onCheckedChange)
            .heightIn(min = RemoteUi.TouchTarget),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(L10n.tr("跟随输出"), Modifier.weight(1f), style = MaterialTheme.typography.bodyLarge)
        Box(Modifier.size(52.dp, 30.dp)) {
            NeumorphSurface(modifier = Modifier.fillMaxSize(), style = NeumorphStyle.Pressed,
                shape = RoundedCornerShape(15.dp), shadowScale = 0.5f) {
                Box(Modifier.fillMaxSize().background(MaterialTheme.colorScheme.primary.copy(alpha = if (checked) 0.22f else 0f)))
            }
            NeumorphSurface(modifier = Modifier.align(Alignment.CenterStart).offset(x = thumbOffset.dp).size(22.dp),
                shape = CircleShape, shadowScale = 0.45f) {
                Box(Modifier.fillMaxSize().background(MaterialTheme.colorScheme.primary.copy(alpha = if (checked) 1f else 0f)))
            }
        }
    }
}
