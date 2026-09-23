package dev.pi.remote

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.ChevronRight
import androidx.compose.material.icons.rounded.Computer
import androidx.compose.material.icons.rounded.ErrorOutline
import androidx.compose.material.icons.rounded.HelpOutline
import androidx.compose.material.icons.rounded.LockOpen
import androidx.compose.material.icons.rounded.Shield
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
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
import kotlinx.serialization.Serializable

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

private fun permissionScopeLabel(permissions: RuntimePermissions): String =
    when (permissions.sandbox) {
        "readOnly", "read-only" -> "只读沙箱"
        "workspaceWrite", "workspace-write" -> "工作区可写"
        "dangerFullAccess", "danger-full-access" -> "完全访问"
        "externalSandbox" -> "外部沙箱"
        else -> "权限待确认"
    }

internal fun permissionSummary(permissions: RuntimePermissions): String {
    val sandbox = permissionScopeLabel(permissions)
    val approval = when (permissions.approvalPolicy) {
        "never" -> "不申请审批"
        "on-request", "onRequest" -> "按需批准"
        "untrusted", "unlessTrusted" -> "不可信操作需批准"
        "unknown" -> "批准策略未知"
        else -> "自定义批准策略"
    }
    return "$sandbox · $approval"
}

internal fun permissionDetails(permissions: RuntimePermissions): String = buildString {
    appendLine(permissionSummary(permissions))
    when (permissions.sandbox) {
        "dangerFullAccess", "danger-full-access" -> appendLine("此会话不受沙箱限制，仍受电脑账户权限限制。")
        "readOnly", "read-only" -> appendLine("此会话允许读取文件，写入受沙箱限制。")
        "workspaceWrite", "workspace-write" -> appendLine("此会话可写工作目录及列出的授权目录。")
        "unknown" -> appendLine("尚未收到此会话的有效权限，请刷新会话后查看。")
    }
    if (permissions.approvalPolicy == "never") appendLine("受限操作不会弹出人工批准，会直接失败；这不代表自动批准所有操作。")
    appendLine("网络访问：${when (permissions.networkAccess) { true -> "允许"; false -> "受限"; null -> "未知" }}")
    appendLine("批准处理：${when (permissions.reviewer) {
        "user" -> "由你处理"
        "auto_review", "guardian_subagent" -> "自动审查"
        else -> "未知"
    }}")
    permissions.profile?.let { appendLine("权限配置：$it") }
    permissions.writableRoots?.takeIf { it.isNotEmpty() }?.let { appendLine("额外可写目录：\n${it.joinToString("\n")}") }
    permissions.readableRoots?.let { appendLine("可读目录：\n${it.joinToString("\n").ifEmpty { "未额外授权" }}") }
    if (permissions.approvalPolicy.startsWith("{")) appendLine("批准策略：${permissions.approvalPolicy}")
    permissions.problem?.let { appendLine("\n$it") }
}.trim()

internal fun permissionSettingValue(permissions: RuntimePermissions?, command: String): String? = when (command) {
    "sandbox" -> permissions?.sandbox
    "network" -> when (permissions?.networkAccess) { true -> "enabled"; false -> "restricted"; null -> null }
    "approvals" -> permissions?.approvalPolicy
    "approval-reviewer" -> permissions?.reviewer?.let { if (it == "guardian_subagent") "auto_review" else it }
    else -> null
}

@Composable
internal fun RuntimePermissionsStatus(
    permissions: RuntimePermissions?,
    commands: List<RuntimeSlashCommand> = emptyList(),
    connected: Boolean = true,
    idle: Boolean = true,
    commandResults: Map<String, CommandResult> = emptyMap(),
    onApply: (String, String) -> String? = { _, _ -> null },
    modifier: Modifier = Modifier,
) {
    var expanded by rememberSaveable { mutableStateOf(false) }
    var selectedCommand by rememberSaveable { mutableStateOf("sandbox") }
    var selectedValue by rememberSaveable { mutableStateOf<String?>(null) }
    var pendingId by rememberSaveable { mutableStateOf<String?>(null) }
    var feedback by rememberSaveable { mutableStateOf<String?>(null) }
    var showDetails by rememberSaveable { mutableStateOf(false) }
    val available = if (permissions == null) emptyList() else commands.filter {
        it.name in listOf("sandbox", "network", "approvals", "approval-reviewer") && it.argument?.kind == "select"
    }
    val command = available.find { it.name == selectedCommand } ?: available.firstOrNull()
    val current = command?.let { permissionSettingValue(permissions, it.name) }
    LaunchedEffect(pendingId, commandResults[pendingId]) {
        val result = commandResults[pendingId] ?: return@LaunchedEffect
        feedback = if (result.ok) "已应用到当前会话，后续任务使用新设置" else result.error ?: "设置未确认，请检查当前权限后重试"
        pendingId = null
        if (result.ok) selectedValue = null
    }
    // A quiet session fact beside the working directory, with a full-sized touch target.
    // Approval/network details belong in the sheet; never imply that "never" means auto-approve.
    val hasProblem = permissions?.problem != null
    val label = when {
        hasProblem -> "沙箱异常"
        permissions == null -> "电脑端管理"
        else -> permissionScopeLabel(permissions)
    }
    val icon = when {
        hasProblem -> Icons.Rounded.ErrorOutline
        permissions == null -> Icons.Rounded.Computer
        permissions.sandbox in listOf("dangerFullAccess", "danger-full-access") -> Icons.Rounded.LockOpen
        permissions.sandbox in listOf("readOnly", "read-only", "workspaceWrite", "workspace-write", "externalSandbox") -> Icons.Rounded.Shield
        else -> Icons.Rounded.HelpOutline
    }
    val tint = if (hasProblem) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant
    Row(
        modifier = modifier
            .clip(RoundedCornerShape(12.dp))
            .clickable(role = Role.Button, onClickLabel = "查看权限与审批设置") { expanded = true }
            .semantics {
                contentDescription = "当前会话权限"
                stateDescription = permissions?.let {
                    "${if (hasProblem) "沙箱异常。" else ""}${permissionSummary(it)}"
                } ?: "由电脑端管理"
            }
            .heightIn(min = 48.dp)
            .padding(horizontal = 8.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Icon(icon, contentDescription = null, modifier = Modifier.size(16.dp), tint = tint)
        Text(label, modifier = Modifier.weight(1f, fill = false), style = MaterialTheme.typography.labelMedium,
            color = tint, maxLines = 2, overflow = TextOverflow.Ellipsis)
        Icon(Icons.Rounded.ChevronRight, contentDescription = null, modifier = Modifier.size(14.dp), tint = tint)
    }
    if (expanded) SessionControlDialog("当前会话权限", onClose = { expanded = false }) {
        Column(Modifier.weight(1f).fillMaxWidth().verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
            if (permissions == null) {
                Text("当前会话未提供可查询的沙箱和审批策略。工具权限由电脑端的运行环境和扩展管理。")
                Text("结构化审批和问答可在 App 的待处理面板完成；电脑端原生交互会单独提示。")
            } else {
                Text("当前生效", style = MaterialTheme.typography.labelLarge)
                Text(permissionSummary(permissions), style = MaterialTheme.typography.titleMedium)
                Text("网络：${when (permissions.networkAccess) { true -> "允许"; false -> "受限"; null -> "未知" }} · 审批处理：${when (permissions.reviewer) { "user" -> "由我处理"; "auto_review", "guardian_subagent" -> "自动审查"; else -> "未知" }}")
                permissions.problem?.let { Text(it, color = MaterialTheme.colorScheme.error) }
                NeumorphTextButton(if (showDetails) "收起授权详情" else "查看授权目录与策略说明", onClick = { showDetails = !showDetails })
                if (showDetails) SelectionContainer { Text(permissionDetails(permissions), style = MaterialTheme.typography.bodyMedium) }
            }
            if (available.isNotEmpty()) {
                Text("修改设置", style = MaterialTheme.typography.titleMedium)
                Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    available.forEach { item ->
                        NeumorphTextButton(item.description ?: item.name, filled = item == command, enabled = pendingId == null,
                            onClick = { selectedCommand = item.name; selectedValue = null; feedback = null })
                    }
                }
                command?.argument?.options?.forEach { option ->
                    val chosen = (selectedValue ?: current) == option.value
                    NeumorphSurface(
                        modifier = Modifier.fillMaxWidth(), shape = RemoteUi.ControlShape,
                        style = if (chosen) NeumorphStyle.Pressed else NeumorphStyle.Raised,
                        enabled = connected && idle && pendingId == null,
                        onClick = { selectedValue = option.value; feedback = null },
                    ) {
                        Column(Modifier.fillMaxWidth().padding(14.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                            Text("${if (chosen) "● " else "○ "}${option.label}${if (option.value == current) " · 当前" else ""}")
                            option.description?.let { Text(it, style = MaterialTheme.typography.bodySmall) }
                        }
                    }
                }
                if (command?.name == "network" && permissions?.sandbox in listOf("dangerFullAccess", "danger-full-access")) {
                    Text("完全访问模式包含联网权限。限制联网前，请先切换为只读或工作区可写。")
                }
                Text("一次应用一项设置，仅作用于当前会话的后续任务。", style = MaterialTheme.typography.bodySmall)
            } else if (permissions != null) Text("当前会话未提供手机端权限设置，请在电脑端调整。")
        }
        Column(Modifier.fillMaxWidth().padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            if (!connected) Text("连接已断开，连接后可应用设置", color = MaterialTheme.colorScheme.error)
            else if (!idle) Text("请先完成当前任务和待处理交互，再调整权限")
            feedback?.let { Text(it) }
            if (command != null) NeumorphTextButton(
                if (pendingId != null) "正在应用，等待电脑确认…" else "应用到当前会话", filled = true,
                modifier = Modifier.fillMaxWidth(),
                enabled = connected && idle && pendingId == null && selectedValue != null && selectedValue != current &&
                    !(command.name == "network" && permissions?.sandbox in listOf("dangerFullAccess", "danger-full-access")),
                onClick = {
                    pendingId = onApply(command.name, selectedValue!!)
                    feedback = if (pendingId == null) "设置未发送，请检查连接后重试" else null
                },
            )
        }
    }
}
