package com.orbising.orbis

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull

internal const val RUNTIME_CLOSE_FEATURE = "runtime.close.v1"
internal const val RUNTIME_CLOSE_CAPABILITY = "orbis-close"

/** SESSION-CLOSE-01: a dialog authorizes only these sessions on this connection. */
internal data class RuntimeCloseTarget(
    val runtimeId: String,
    val sessionId: String,
    val agentKind: String?,
    val closeGeneration: String?,
)

internal data class RuntimeClosePlan(
    val hostId: String,
    val connection: Int,
    val modelEpoch: String?,
    val negotiated: Boolean,
    val entries: List<Entry>,
) {
    data class Entry(val target: RuntimeCloseTarget, val title: String, val impact: RuntimeCloseImpact)
    val runtimeIds: Set<String> get() = entries.mapTo(mutableSetOf()) { it.target.runtimeId }
    val requiresConfirmation: Boolean get() = entries.any { it.impact.needsConfirmation }
    val viewOnly: Boolean get() = entries.all { it.impact.viewOnly }
    val actionTitle: String get() = if (viewOnly) L10n.tr("退出视图") else L10n.tr("确认关闭")
    val dialogTitle: String get() = when {
        viewOnly && entries.size > 1 -> L10n.tr("退出 {0} 个手机视图？", entries.size)
        entries.size > 1 -> L10n.tr("关闭 {0} 个会话？", entries.size)
        viewOnly -> L10n.tr("退出手机视图？")
        else -> L10n.tr("关闭会话？")
    }
    val message: String get() = (entries.map { entry ->
        entry.title + "\n" + (entry.impact.activity + entry.impact.effect).joinToString("\n")
    } + if (viewOnly) emptyList() else listOf(L10n.tr("已保存的历史会保留；未保存的输出可能丢失，已执行的操作不会撤销。"))).joinToString("\n\n")
}

data class RuntimeCloseImpact(val activity: List<String>, val effect: String, val viewOnly: Boolean) {
    val needsConfirmation: Boolean get() = activity.isNotEmpty()
}

internal fun List<RuntimeSlashCommand>.visibleSlashCommands(): List<RuntimeSlashCommand> {
    if (none { it.name == RUNTIME_CLOSE_CAPABILITY }) return this
    val menu = filterNot { it.name == RUNTIME_CLOSE_CAPABILITY }
    return if (menu.any { it.name == "quit" }) menu else menu + RuntimeSlashCommand("quit", source = "builtin")
}

internal fun RuntimeSummary.remoteCloseCommand(commands: List<RuntimeSlashCommand>, negotiated: Boolean): RuntimeSlashCommand? {
    val name = if (negotiated && agentKind == "claude") RUNTIME_CLOSE_CAPABILITY else "quit"
    return commands.firstOrNull { it.name == name && it.argument?.required != true && (!negotiated || it.source == "builtin") &&
        (name != RUNTIME_CLOSE_CAPABILITY || !it.closeGeneration.isNullOrBlank()) }
}

internal fun RemoteState.closeTarget(id: String): RuntimeCloseTarget? {
    val runtime = runtimes[id] ?: return null
    val sessionId = runtime.sessionId?.takeIf { it.isNotBlank() } ?: return null
    val command = runtime.remoteCloseCommand(capabilities[id]?.commands.orEmpty(), runtimeCloseNegotiated) ?: return null
    return RuntimeCloseTarget(id, sessionId, runtime.agentKind, command.closeGeneration)
}

internal fun RemoteState.closeImpact(id: String): RuntimeCloseImpact? {
    homeCloseImpacts?.let { return it[id] }
    val runtime = runtimes[id] ?: return null
    val tasks = runtime.backgroundTasks
    val conversation = conversations[id]
    val snapshot = agentStateSnapshots["agent|${runtime.agentKind.orEmpty()}|${runtime.sessionId.orEmpty()}"]
    val execution = snapshot?.domains?.get("execution")?.value as? JsonObject
    val retry = execution?.get("retry") as? JsonObject
    val retrying = (retry?.get("phase") as? JsonPrimitive)?.contentOrNull == "running"
    val queued = (conversation?.queuedMessages.orEmpty().values.filter { it.state in setOf("accepted", "not_cancelable", "unconfirmed") }.map { it.queueId } +
        pendingSends.values.filter { it.sessionId == runtime.sessionId && (it.runtimeId == null || it.runtimeId == id) &&
            !it.submissionConfirmed && it.state !is PendingSendState.Failed }.map { it.messageId }).toSet().size
    val activity = buildList {
        if (runtime.status == "running") add(L10n.tr("当前回合正在运行。"))
        else if (runtime.status !in setOf("idle", "waiting_local_interaction")) add(L10n.tr("当前回合状态未确认。"))
        if (runtime.status == "waiting_local_interaction" || conversation?.interactions?.isNotEmpty() == true) add(L10n.tr("有待处理的交互。"))
        if (runtime.compactionPhase == "running") add(L10n.tr("正在压缩上下文。"))
        if (retrying) add(L10n.tr("任务正在重试。"))
        if (tasks != null && (tasks.confirmed || tasks.truncated)) {
            if (tasks.activeAgentCount > 0) add(L10n.tr("有 {0} 个活跃子代理。", tasks.activeAgentCount))
            if (tasks.activeCommandCount > 0) add(L10n.tr("有 {0} 个活跃后台命令或监听。", tasks.activeCommandCount))
        }
        if (tasks?.truncated == true) add(L10n.tr("后台任务清单不完整，可能还有其他任务。"))
        else if (tasks?.confirmed != true && (tasks?.visible == true || runtimeCloseNegotiated && runtime.agentKind == "claude"))
            add(L10n.tr("后台任务状态未确认，可能仍有任务运行。"))
        if (queued > 0) add(L10n.tr("有 {0} 条消息尚未确认送达，关闭后可能不会发送。", queued))
    }
    val effect = when (runtime.agentKind) {
        "codexDesktop" -> L10n.tr("只退出手机视图，不会停止电脑端的工作。")
        "claude" -> L10n.tr("将结束电脑上的 Claude Code 进程；不能确认所有后台任务都会停止。")
        "codex" -> L10n.tr("将尝试关闭电脑上的 Codex 终端；不能确认所有后台任务都会停止。")
        "dsh", "dshDesktop" -> L10n.tr("关闭会尝试停止当前回合；不能确认所有后台任务都会停止。")
        "pi" -> L10n.tr("将请求退出电脑上的 Pi 会话；不能确认所有后台任务都会停止。")
        else -> L10n.tr("关闭可能中断电脑端的工作；不能确认所有后台任务都会停止。")
    }
    return RuntimeCloseImpact(activity, effect, runtime.agentKind == "codexDesktop")
}

internal fun RemoteState.closePlan(ids: Set<String>): RuntimeClosePlan? {
    val host = hostId ?: return null
    return RuntimeClosePlan(host, ledger.connection, agentModelEpoch, runtimeCloseNegotiated, ids.mapNotNull { id ->
        val runtime = runtimes[id] ?: return@mapNotNull null
        if (!canCloseRuntime(id)) return@mapNotNull null
        RuntimeClosePlan.Entry(closeTarget(id) ?: return@mapNotNull null, runtimeDisplayName(runtime), closeImpact(id) ?: return@mapNotNull null)
    })
}

internal fun RemoteState.closeTargetIsCurrent(plan: RuntimeClosePlan, target: RuntimeCloseTarget): Boolean =
    e2eReady && plan.hostId == hostId && plan.connection == ledger.connection && plan.modelEpoch == agentModelEpoch &&
        plan.negotiated == runtimeCloseNegotiated && closeTarget(target.runtimeId) == target && canCloseRuntime(target.runtimeId)
