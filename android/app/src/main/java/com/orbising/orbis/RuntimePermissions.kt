package com.orbising.orbis

import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.*
import com.orbising.orbis.OrbisActionIcon as Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.delay
import kotlinx.serialization.Serializable

/** Raw backend facts retained for compatibility and diagnostics only. */
@Serializable
data class RuntimePermissions(
    val sandbox: String,
    val approvalPolicy: String,
    val reviewer: String? = null,
    val networkAccess: Boolean? = null,
    val writableRoots: List<String>? = null,
    val readableRoots: List<String>? = null,
    val profile: String? = null,
    val problem: String? = null,
)

@Serializable
data class RuntimePermissionManagement(
    val summary: String,
    val details: String,
    val tone: String,
    val settings: List<RuntimePermissionSetting>,
)

@Serializable
data class RuntimePermissionSetting(
    val id: String,
    val label: String,
    val currentValue: String? = null,
    val disabledReason: String? = null,
    val options: List<RuntimePermissionOption>,
)

@Serializable
data class RuntimePermissionOption(
    val value: String,
    val label: String,
    val description: String? = null,
)

@Composable
internal fun RuntimePermissionsStatus(
    permissionManagement: RuntimePermissionManagement?,
    connected: Boolean = true,
    idle: Boolean = true,
    commandResults: Map<String, CommandResult> = emptyMap(),
    onApply: (String, String) -> String? = { _, _ -> null },
    modifier: Modifier = Modifier,
) {
    var expanded by rememberSaveable { mutableStateOf(false) }
    var selectedSettingId by rememberSaveable { mutableStateOf<String?>(null) }
    var selectedValue by rememberSaveable { mutableStateOf<String?>(null) }
    var pendingId by remember { mutableStateOf<String?>(null) }
    var feedback by rememberSaveable { mutableStateOf<String?>(null) }
    val available = permissionManagement?.settings.orEmpty()
    val setting = available.find { it.id == selectedSettingId } ?: available.firstOrNull()
    val current = setting?.currentValue
    val canEdit = connected && idle && pendingId == null && setting?.disabledReason == null
    LaunchedEffect(setting?.id) {
        selectedSettingId = setting?.id
        selectedValue = null
        feedback = null
    }
    LaunchedEffect(pendingId, commandResults[pendingId]) {
        val result = commandResults[pendingId] ?: return@LaunchedEffect
        if (result.status == "pending") return@LaunchedEffect
        feedback = if (result.ok) L10n.tr("已应用到当前会话") else result.error ?: L10n.tr("设置未确认，请检查当前权限后重试")
        pendingId = null
        if (result.ok) selectedValue = null
    }
    LaunchedEffect(pendingId, connected) {
        val requestId = pendingId ?: return@LaunchedEffect
        if (!connected) {
            pendingId = null
            feedback = L10n.tr("连接已断开，权限设置尚未确认；重新连接后请检查当前权限")
            return@LaunchedEffect
        }
        delay(75_000)
        if (pendingId == requestId) {
            pendingId = null
            feedback = L10n.tr("等待电脑确认已超过 75 秒，权限设置尚未确认；请检查当前权限后再决定是否重试")
        }
    }
    val label = permissionManagement?.summary?.let { L10n.hostSummary(it) } ?: L10n.tr("电脑端管理")
    val icon = when (permissionManagement?.tone) {
        "problem" -> Icons.Rounded.ErrorOutline
        "full" -> Icons.Rounded.LockOpen
        "restricted" -> Icons.Rounded.Shield
        null -> Icons.Rounded.Computer
        else -> Icons.Rounded.HelpOutline
    }
    val tint = if (permissionManagement?.tone == "problem") MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant
    var glyphActivation by remember { mutableStateOf(0) }
    Row(
        modifier = modifier.clip(RoundedCornerShape(12.dp))
            .clickable(role = Role.Button, onClickLabel = L10n.tr("查看权限与审批设置")) { glyphActivation++; expanded = true }
            .semantics { contentDescription = L10n.tr("当前会话权限"); stateDescription = label }
            .heightIn(min = 32.dp).padding(horizontal = 8.dp, vertical = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Icon(icon, contentDescription = null, modifier = Modifier.size(16.dp).actionGlyphMotion(glyphActivation), tint = tint)
        Text(label, modifier = Modifier.weight(1f, fill = false), style = MaterialTheme.typography.labelMedium,
            color = tint, maxLines = 2, overflow = TextOverflow.Ellipsis)
        Icon(Icons.Rounded.ChevronRight, contentDescription = null, modifier = Modifier.size(14.dp).actionGlyphMotion(glyphActivation), tint = tint)
    }
    if (expanded) SessionControlDialog(L10n.tr("当前会话权限"), onClose = { expanded = false }) {
        Column(Modifier.weight(1f).fillMaxWidth().verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
            if (permissionManagement == null) {
                Text(L10n.tr("当前会话未提供权限管理信息，请在电脑端查看和管理权限"))
            } else {
                Text(L10n.tr("当前生效"), style = MaterialTheme.typography.labelLarge)
                Text(L10n.hostSummary(permissionManagement.summary), style = MaterialTheme.typography.titleMedium, color = tint)
                SelectionContainer { Text(L10n.hostText(permissionManagement.details), style = MaterialTheme.typography.bodyMedium) }
            }
            if (available.isNotEmpty()) {
                Text(L10n.tr("修改设置"), style = MaterialTheme.typography.titleMedium)
                Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    available.forEach { item ->
                        NeumorphTextButton(L10n.hostText(item.label), filled = item == setting, enabled = pendingId == null,
                            onClick = { selectedSettingId = item.id; selectedValue = null; feedback = null })
                    }
                }
                setting?.disabledReason?.let { Text(L10n.hostText(it)) }
                setting?.options?.forEach { option ->
                    val chosen = (selectedValue ?: current) == option.value
                    NeumorphSurface(
                        modifier = Modifier.fillMaxWidth(), shape = RemoteUi.ControlShape,
                        style = if (chosen) NeumorphStyle.Pressed else NeumorphStyle.Raised,
                        enabled = canEdit,
                        onClick = { selectedValue = option.value; feedback = null },
                        contentInset = 14.dp,
                    ) {
                        Column(Modifier.fillMaxWidth().padding(14.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                            Text("${if (chosen) "● " else "○ "}${L10n.hostText(option.label)}${if (option.value == current) L10n.tr("，当前") else ""}")
                            option.description?.let { Text(L10n.hostText(it), style = MaterialTheme.typography.bodySmall) }
                        }
                    }
                }
            } else if (permissionManagement != null) Text(L10n.tr("当前会话未提供手机端权限设置"))
        }
        Column(Modifier.fillMaxWidth().padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            if (!connected) Text(L10n.tr("连接已断开，连接后可应用设置"), color = MaterialTheme.colorScheme.error)
            else if (!idle) Text(L10n.tr("请先完成当前任务和待处理交互，再调整权限"))
            feedback?.let { Text(it) }
            if (setting != null) NeumorphTextButton(
                if (pendingId != null) L10n.tr("正在应用，等待电脑确认…") else L10n.tr("应用到当前会话"), filled = true,
                modifier = Modifier.fillMaxWidth(),
                maxLines = Int.MAX_VALUE,
                enabled = canEdit && selectedValue != null && selectedValue != current && setting.options.any { it.value == selectedValue },
                onClick = {
                    pendingId = onApply(setting.id, selectedValue!!)
                    feedback = if (pendingId == null) L10n.tr("设置未发送，请检查连接后重试") else null
                },
            )
        }
    }
}
