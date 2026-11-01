package com.orbising.orbis

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive

/** ADR-0049 §7.5：账本里每种操作携带的内容。新增种类只在这里加一个子类型。 */
sealed interface LedgerPayload {
    /** 首页关闭会话（`/quit`）。 */
    data class Quit(val runtimeId: String) : LedgerPayload
    /** 关闭通知（只影响本设备，ADR-0028 §3）。 */
    data class Dismiss(val runtimeId: String, val hostEpoch: String, val notificationId: String) : LedgerPayload
    /** 归档 / 取消归档（每张卡片一条）。 */
    data class Archive(val sessionId: String, val agentKind: String, val archived: Boolean) : LedgerPayload
    /** 撤回排队消息。 */
    data class QueueCancel(val runtimeId: String, val queueId: String) : LedgerPayload
    /** 回答审批 / 问卷、取消提问。`summary` 是原位短状态显示的摘要（自由文本与敏感输入只显示“已提交”）。 */
    data class Respond(val runtimeId: String, val requestId: String, val summary: String) : LedgerPayload
    /** 等待前置操作的消息（附件上传、同会话前一条）。写入通道后交给 ADR-0055 的 outbox 结算。 */
    data class Send(val runtimeId: String, val sessionId: String, val messageId: String) : LedgerPayload
    /** 模型 / 思考级别（条件乐观）。`setting` 为 `model` 或 `thinking`；`label` 是选择器里的名字。 */
    data class Config(val runtimeId: String, val setting: String, val value: String, val label: String) : LedgerPayload
    /** 新建 / 恢复会话（即时反馈）：立即进入聊天页并显示“启动中”。`placeholder` 是启动期间聊天页的占位身份。 */
    data class Launch(val requestId: String, val placeholder: String) : LedgerPayload
}

typealias AppLedger = OperationLedger<LedgerPayload>

/**
 * ADR-0049 §7.5 的种类定义：目标、策略、证据和呈现。阶段、断线、期限、作用域和冲突全部由 [OperationLedger] 处理，
 * reducer 与 [HostConnection] 只负责把回执、权威状态和本机事件交给账本。iOS `OperationKinds.swift` 与本文件同构。
 */
object OperationKinds {
    /** 在线列表（`device.ready` 与 `runtime.online` / `runtime.offline`）在账本里的领域名。 */
    const val RUNTIMES_DOMAIN = "runtimes"
    const val QUIT = "quit"
    const val DISMISS = "dismiss"
    const val ARCHIVE = "archive"
    /** 会话目录（HostState.catalog / session.list）在账本里的领域名。 */
    const val CATALOG_DOMAIN = "catalog"
    const val QUEUE_CANCEL = "queueCancel"
    /** 某个 Runtime 的 Host 队列（delivery 领域）在账本里的领域名。 */
    fun queueDomain(runtimeId: String) = "queue:$runtimeId"
    const val RESPOND = "respond"
    const val SEND = "send"
    const val CONFIG = "config"
    const val LAUNCH = "launch"

    /** ADR-0049 §6.1：来源为 prompt / skill、会产生一条用户消息的命令，且当前可以执行（idle，ADR-0055 §5）。 */
    fun slashProducesMessage(command: RuntimeSlashCommand, runtime: RuntimeSummary): Boolean =
        command.source in setOf("prompt", "skill") && runtime.status == "idle" && runtime.sessionId != null
    /**
     * `launch`：同一 requestId 的 `session.activated` 表示 Host 已受理并给出 Session，该 Session 的 Runtime 上线才落地；
     * 失败在聊天页原位显示；超时后显示“启动未确认”，以随后的会话列表为准（ADR-0049 §6.8）。
     */
    val launchPolicy = LedgerPolicy(
        successLands = false,
        acceptedBudgetMs = LEDGER_RECEIPT_BUDGET_MS,
        afterSuccessMs = LEDGER_RECEIPT_BUDGET_MS,
        afterSuccess = LedgerTimeout.Unknown,
        whenUnresolved = LedgerTimeout.Unknown,
        deviceReceipts = true,
    )
    /** 某个 Runtime 的模型配置（model 领域或 runtime.metadata）在账本里的领域名。 */
    fun modelDomain(runtimeId: String) = "model:$runtimeId"
    fun isConfigSetting(name: String) = name == "model" || name == "thinking"
    fun configTitle(setting: String) = if (setting == "model") "模型" else "思考级别"
    fun configTarget(runtimeId: String, setting: String) = "config:$runtimeId:$setting"

    /**
     * `config`：成功回执后仍等 model 领域发布确认值（确认值与所选不同时显示确认值），15 秒未见就转结果不明核对；
     * 核对后与所选不一致按切换失败处理（ADR-0049 §6.7）。
     */
    val configPolicy = LedgerPolicy(
        successLands = false,
        acceptedBudgetMs = LEDGER_RECEIPT_BUDGET_MS,
        afterSuccessMs = 15_000,
        afterSuccess = LedgerTimeout.Unknown,
        whenUnresolved = LedgerTimeout.Reject(LedgerRejection("unconfirmed", "未生效")),
        deviceReceipts = true,
    )

    fun confirmedValue(runtime: RuntimeSummary, setting: String): String? = if (setting == "model") runtime.model?.id else runtime.thinkingLevel

    /** 模型配置对 `config` 说明了什么：确认值等于所选即落地；成功回执后确认值不同（规范化或别名）也落地，显示确认值。 */
    fun configEvidence(op: LedgerOperation<LedgerPayload>, runtime: RuntimeSummary?): LedgerEvidence {
        val payload = op.payload as? LedgerPayload.Config ?: return LedgerEvidence.NONE
        val confirmed = runtime?.let { confirmedValue(it, payload.setting) } ?: return LedgerEvidence.NONE
        return if (confirmed == payload.value || op.succeeded) LedgerEvidence.LANDED else LedgerEvidence.NONE
    }

    /** 未结算的配置切换：等它的消息排在它后面（§6.2）。 */
    fun activeConfigOps(ledger: AppLedger, runtimeId: String): List<LedgerOperation<LedgerPayload>> =
        ledger.operations.filter { !it.phase.isSettled && (it.payload as? LedgerPayload.Config)?.runtimeId == runtimeId }

    /** 选择器与顶栏显示的值：所选值加“切换中”；结果不明加“未确认”（ADR-0049 §6.7）。 */
    fun configStatus(ledger: AppLedger, runtimeId: String, setting: String): Pair<String, String>? {
        for (op in ledger.operations.asReversed()) {
            val payload = op.payload as? LedgerPayload.Config ?: continue
            if (payload.runtimeId != runtimeId || payload.setting != setting) continue
            when (op.phase) {
                LedgerPhase.Waiting, LedgerPhase.Sent, LedgerPhase.Accepted -> return payload.label to "切换中"
                LedgerPhase.Unknown, LedgerPhase.Unconfirmed -> return payload.label to "未确认"
                is LedgerPhase.Rejected -> continue
            }
        }
        return null
    }
    /** `send` 在账本里只经历 `waiting`：前置完成、轮到它时写入通道并交给 outbox，账本随即删除记录。 */
    val sendPolicy = LedgerPolicy(successLands = true, acceptedBudgetMs = LEDGER_RECEIPT_BUDGET_MS, deviceReceipts = true)
    fun sendGroup(sessionId: String) = "session:$sessionId"
    fun uploadPrerequisite(uploadId: String) = "upload:$uploadId"
    /** 某个 Runtime 的交互清单（interactions 领域）在账本里的领域名。 */
    fun interactionsDomain(runtimeId: String) = "interactions:$runtimeId"

    /**
     * `respond`：成功回执后面板保持收起，直到交互清单不再含该请求（避免闪回），15 秒仍在就转结果不明核对。
     * 明确失败且请求仍有效时面板回到原位并保留答案；核对后请求仍在则静默恢复面板，已不在则显示“已处理”。
     */
    val respondPolicy = LedgerPolicy(
        successLands = false,
        acceptedBudgetMs = LEDGER_RECEIPT_BUDGET_MS,
        afterSuccessMs = 15_000,
        afterSuccess = LedgerTimeout.Unknown,
        whenUnresolved = LedgerTimeout.Reject(LedgerRejection("unresolved", "")),
        deviceReceipts = true,
    )

    fun respondTarget(runtimeId: String, requestId: String) = "interaction:$runtimeId:$requestId"

    /** 回答摘要：确认结果、选项名或“已提交”；自由文本与敏感输入不回显（ADR-0049 §6.5）。 */
    fun confirmSummary(request: PendingInteraction, approved: Boolean) =
        if (approved) "已${request.confirmLabel ?: "允许"}" else "已${request.cancelLabel ?: "拒绝"}"
    fun valueSummary(request: PendingInteraction, value: String) =
        if (request.kind != "select" || request.secret) "已提交" else "已选择：${request.options.firstOrNull { it.value == value }?.label ?: value}"
    fun valuesSummary(request: PendingInteraction, values: List<String>) =
        if (request.secret || values.isEmpty()) "已提交" else "已选择：" + values.joinToString("、") { value -> request.options.firstOrNull { it.value == value }?.label ?: value }

    /** 正在回答、尚未结算的请求：面板收起（L3），草稿保留。 */
    fun respondingRequestIds(ledger: AppLedger, runtimeId: String): Set<String> = ledger.operations
        .filter { !it.phase.isSettled }
        .mapNotNullTo(mutableSetOf()) { (it.payload as? LedgerPayload.Respond)?.takeIf { p -> p.runtimeId == runtimeId }?.requestId }

    /** 原位短状态：确认前带处理中标记；结果不明显示“未确认”。 */
    fun respondStatus(ledger: AppLedger, runtimeId: String): Pair<String, Boolean>? {
        for (op in ledger.operations.asReversed()) {
            val payload = op.payload as? LedgerPayload.Respond ?: continue
            if (payload.runtimeId != runtimeId) continue
            when (op.phase) {
                LedgerPhase.Waiting, LedgerPhase.Sent, LedgerPhase.Accepted -> return payload.summary to true
                LedgerPhase.Unknown, LedgerPhase.Unconfirmed -> return "${payload.summary} · 未确认" to false
                is LedgerPhase.Rejected -> continue
            }
        }
        return null
    }

    /** 交互清单对 `respond` 说明了什么：请求已不在即落地；仍在、未被 Host 标为已提交且未见成功回执，是反向证据。 */
    fun interactionEvidence(op: LedgerOperation<LedgerPayload>, requests: Map<String, PendingInteraction>): LedgerEvidence {
        val payload = op.payload as? LedgerPayload.Respond ?: return LedgerEvidence.NONE
        val request = requests[payload.requestId] ?: return LedgerEvidence.LANDED
        return if (request.submitted || op.succeeded) LedgerEvidence.NONE else LedgerEvidence.NOT_APPLIED
    }
    /** 某个 Runtime 的通知清单在账本里的领域名：每个 Runtime 的通知快照各自独立。 */
    fun noticesDomain(runtimeId: String) = "notifications:$runtimeId"
    /** 账本发起的核对读取（L5）使用的 requestId 前缀。 */
    const val VERIFY_REQUEST_PREFIX = "ledger-verify:"

    val quitStillRunning = LedgerRejection("still_running", "电脑上的会话仍在运行，请稍后重试或在电脑上关闭。")
    val quitUnconfirmed = LedgerRejection("unconfirmed", "关闭会话未确认：会话仍在运行。")

    /** `quit`：成功回执只表示受理，Runtime 离线才算落地；成功后 15 秒仍在线或结果不明核对后仍在线，都恢复卡片。 */
    val quitPolicy = LedgerPolicy(
        successLands = false,
        acceptedBudgetMs = LEDGER_RECEIPT_BUDGET_MS,
        afterSuccessMs = 15_000,
        afterSuccess = LedgerTimeout.Reject(quitStillRunning),
        whenUnresolved = LedgerTimeout.Reject(quitUnconfirmed),
        deviceReceipts = true,
        appliesBeforeLaterReads = false,
    )

    fun quitTarget(runtimeId: String) = "runtime:$runtimeId"

    /** `dismiss`：没有回执；Host 处理关闭时同步生效，之后发起的读取已能反映结果。权威清单仍含它就静默重新显示。 */
    val dismissPolicy = LedgerPolicy(
        successLands = false,
        acceptedBudgetMs = LEDGER_RECEIPT_BUDGET_MS,
        whenUnresolved = LedgerTimeout.Reject(LedgerRejection("not_dismissed", "")),
        deviceReceipts = false,
        appliesBeforeLaterReads = true,
    )

    fun dismissTarget(runtimeId: String, hostEpoch: String, notificationId: String) = "notification:$runtimeId:$hostEpoch:$notificationId"

    /** 本设备已关闭、尚未结算的通知：横幅保持隐藏，包括结果不明期间（L4）。键为 runtimeId + NUL + notificationId。 */
    fun hiddenNotificationKeys(ledger: AppLedger): Set<String> = ledger.operations
        .filter { !it.phase.isSettled }
        .mapNotNullTo(mutableSetOf()) { op -> (op.payload as? LedgerPayload.Dismiss)?.let { "${it.runtimeId}\u0000${it.notificationId}" } }

    /** 通知清单对 `dismiss` 说明了什么：清单里已没有它即落地；完整清单仍含它是反向证据（只在因果晚于关闭时采用，L2）。 */
    fun noticeEvidence(op: LedgerOperation<LedgerPayload>, projection: NoticeProjection?): LedgerEvidence {
        val payload = op.payload as? LedgerPayload.Dismiss ?: return LedgerEvidence.NONE
        if (projection == null || projection.hostEpoch != payload.hostEpoch) return LedgerEvidence.NONE
        if (projection.items.none { it.notificationId == payload.notificationId }) return LedgerEvidence.LANDED
        return if (projection.complete) LedgerEvidence.NOT_APPLIED else LedgerEvidence.NONE
    }

    val archiveUnconfirmed = LedgerRejection("unconfirmed", "电脑上的会话目录仍是原状态")

    /**
     * `archive`：同一 requestId 的 `session.archive.changed` 或设备回执 success 表示 Host 已完成原生归档；
     * 卡片留在目标列表直到目录体现结果（避免目录刷新前闪回），15 秒仍未体现就转结果不明核对。
     * 带同一 requestId 的 `protocol.error` 为拒绝；核对后目录仍为原状态时恢复并提示。
     */
    val archivePolicy = LedgerPolicy(
        successLands = false,
        acceptedBudgetMs = LEDGER_RECEIPT_BUDGET_MS,
        afterSuccessMs = 15_000,
        afterSuccess = LedgerTimeout.Unknown,
        whenUnresolved = LedgerTimeout.Reject(archiveUnconfirmed),
        deviceReceipts = true,
    )

    fun archiveTarget(agentKind: String, sessionId: String) = "session:$agentKind:$sessionId"

    /** 卡片应显示在哪个列表：未结算的归档操作的目标值叠加在目录上（L3）。 */
    fun archiveOverrides(ledger: AppLedger): Map<String, Boolean> = ledger.operations
        .filter { !it.phase.isSettled }
        .mapNotNull { (it.payload as? LedgerPayload.Archive)?.let { archive -> archive.sessionId to archive.archived } }
        .toMap()

    /** 目录对 `archive` 说明了什么：归档状态已等于目标值即落地；其余交给回执与核对。 */
    fun catalogEvidence(op: LedgerOperation<LedgerPayload>, sessions: Map<String, SessionCatalogEntry>): LedgerEvidence {
        val payload = op.payload as? LedgerPayload.Archive ?: return LedgerEvidence.NONE
        return if ((sessions[payload.sessionId]?.archived == true) == payload.archived) LedgerEvidence.LANDED else LedgerEvidence.NONE
    }

    val queueAlreadyDelivered = LedgerRejection("already_delivered", "消息已交给 Agent")

    /**
     * `queueCancel`：成功回执（`cancelled`）或队列项转为 `cancelled` 即落地；`already_delivered`、`not_cancelable` 等为拒绝。
     * 结果不明且核对后：仍在队列就静默放回、可再撤回；已不在完整队列中就以权威队列为准不再显示（ADR-0049 §6.3）。
     */
    val queueCancelPolicy = LedgerPolicy(
        // 成功回执后队列项保持退场，直到 Host 队列体现结果（避免闪回），15 秒仍未体现就转结果不明核对。
        successLands = false,
        acceptedBudgetMs = LEDGER_RECEIPT_BUDGET_MS,
        afterSuccessMs = 15_000,
        afterSuccess = LedgerTimeout.Unknown,
        whenUnresolved = LedgerTimeout.Reject(LedgerRejection("not_cancelled", "")),
        deviceReceipts = true,
    )

    fun queueCancelTarget(runtimeId: String, queueId: String) = "queue:$runtimeId:$queueId"

    /** 撤回已写入、等待回执的队列项：先按既有移除呈现退场。 */
    fun cancellingQueueIds(ledger: AppLedger, runtimeId: String): Set<String> = ledger.operations
        .filter { it.phase == LedgerPhase.Sent || it.phase == LedgerPhase.Accepted }
        .mapNotNullTo(mutableSetOf()) { (it.payload as? LedgerPayload.QueueCancel)?.takeIf { p -> p.runtimeId == runtimeId }?.queueId }

    /** 撤回结果不明：队列项回到原位并标“撤回未确认”，核对前不能再撤回。 */
    fun unconfirmedQueueIds(ledger: AppLedger, runtimeId: String): Set<String> = ledger.operations
        .filter { it.phase == LedgerPhase.Unknown || it.phase == LedgerPhase.Unconfirmed }
        .mapNotNullTo(mutableSetOf()) { (it.payload as? LedgerPayload.QueueCancel)?.takeIf { p -> p.runtimeId == runtimeId }?.queueId }

    /**
     * Host 队列对 `queueCancel` 说明了什么：已 `cancelled`，或成功回执后已不在队列中，即落地；
     * 未见成功回执而仍 `accepted` 是反向证据（只在因果晚于撤回时采用）。
     */
    fun queueEvidence(op: LedgerOperation<LedgerPayload>, queue: Map<String, QueuedMessage>): LedgerEvidence {
        val payload = op.payload as? LedgerPayload.QueueCancel ?: return LedgerEvidence.NONE
        return when (queue[payload.queueId]?.state) {
            "cancelled" -> LedgerEvidence.LANDED
            "accepted" -> if (op.succeeded) LedgerEvidence.NONE else LedgerEvidence.NOT_APPLIED
            null -> if (op.succeeded) LedgerEvidence.LANDED else LedgerEvidence.NONE
            else -> LedgerEvidence.NONE
        }
    }

    /** 回执所属的 Runtime：Runtime 级命令的回执只认同一 Runtime 的事件（Host 按 runtimeId + commandId 归属）。 */
    fun runtimeId(op: LedgerOperation<LedgerPayload>): String? = when (val payload = op.payload) {
        is LedgerPayload.Quit -> payload.runtimeId
        is LedgerPayload.QueueCancel -> payload.runtimeId
        is LedgerPayload.Respond -> payload.runtimeId
        is LedgerPayload.Send -> payload.runtimeId
        is LedgerPayload.Config -> payload.runtimeId
        is LedgerPayload.Dismiss, is LedgerPayload.Archive, is LedgerPayload.Launch -> null
    }

    /** 被拒绝后是否直接删除：列表类（首页卡片、通知横幅、目录卡片、队列项）提示后回到原位；内容类保留失败状态等用户处理。 */
    fun removesOnRejection(op: LedgerOperation<LedgerPayload>): Boolean = when (op.payload) {
        is LedgerPayload.Quit, is LedgerPayload.Dismiss, is LedgerPayload.Archive, is LedgerPayload.QueueCancel, is LedgerPayload.Respond, is LedgerPayload.Send, is LedgerPayload.Config, is LedgerPayload.Launch -> true
    }

    /** 首页要隐藏的卡片：未结算的 `quit` 一直保持叠加，包括结果不明期间（L4）。 */
    fun hiddenRuntimeIds(ledger: AppLedger): Set<String> = ledger.operations
        .filter { !it.phase.isSettled }
        .mapNotNullTo(mutableSetOf()) { (it.payload as? LedgerPayload.Quit)?.runtimeId }

    /**
     * 在线列表对操作说明了什么。只有正向证据：Runtime 已不在列表中即落地；仍在线说明不了“没关”，
     * 关闭在 Host 上异步完成，交给成功后的期限或结果不明的核对处理。
     */
    fun evidence(op: LedgerOperation<LedgerPayload>, runtimeIds: Set<String>): LedgerEvidence = when (val payload = op.payload) {
        is LedgerPayload.Quit -> if (payload.runtimeId in runtimeIds) LedgerEvidence.NONE else LedgerEvidence.LANDED
        is LedgerPayload.Dismiss, is LedgerPayload.Archive, is LedgerPayload.QueueCancel, is LedgerPayload.Respond, is LedgerPayload.Send, is LedgerPayload.Config, is LedgerPayload.Launch -> LedgerEvidence.NONE
    }

    /** `command.result` 的回执。`cancelled` / `unconfirmed` 是可能已执行的结果，交给账本按结果不明处理。 */
    fun receipt(ok: Boolean, status: String?, error: String?): LedgerReceipt = when {
        ok -> if (status == "pending") LedgerReceipt.Accepted else LedgerReceipt.Succeeded
        status == "cancelled" || status == "unconfirmed" -> LedgerReceipt.Uncertain
        else -> LedgerReceipt.Failed(LedgerRejection(status ?: "failure", error.nonBlank() ?: "请重试。"))
    }

    /** 设备作用域 `operations` 领域的值（`{operationId: AgentOperationItem}`）→ 回执。查不到的不出现在结果里。 */
    fun deviceReceipts(value: JsonElement?): Map<String, LedgerReceipt> {
        val items = value as? JsonObject ?: return emptyMap()
        val receipts = mutableMapOf<String, LedgerReceipt>()
        for ((id, raw) in items) {
            val item = raw as? JsonObject ?: continue
            if (item.text("operationId") != id) continue
            receipts[id] = when (val state = item.text("state") ?: continue) {
                "accepted", "pending" -> LedgerReceipt.Accepted
                "success" -> LedgerReceipt.Succeeded
                "cancelled", "unconfirmed" -> LedgerReceipt.Uncertain
                else -> LedgerReceipt.Failed(LedgerRejection(state, item.text("detail").nonBlank() ?: "请重试。"))
            }
        }
        return receipts
    }

    /** 被拒绝的操作给用户的提示。 */
    fun message(op: LedgerOperation<LedgerPayload>): String? {
        val rejection = (op.phase as? LedgerPhase.Rejected)?.rejection ?: return null
        return when (op.payload) {
            is LedgerPayload.Quit ->
                if (rejection == quitStillRunning || rejection == quitUnconfirmed) rejection.reason else "关闭会话未完成：${rejection.reason}"
            is LedgerPayload.Dismiss -> null // 通知重新显示即说明关闭未生效，不另弹错误（ADR-0049 §6.6）。
            is LedgerPayload.Archive -> (if ((op.payload as LedgerPayload.Archive).archived) "归档未完成：" else "恢复未完成：") +
                rejection.reason.ifBlank { "请重试" }
            // 队列里仍有它就静默放回；已投递时就近说明，消息随权威记录出现在聊天中。
            is LedgerPayload.QueueCancel -> when (rejection.code) {
                "not_cancelled", "not_applied" -> null
                "already_delivered" -> "撤回未完成：${queueAlreadyDelivered.reason}"
                else -> "撤回未完成：${rejection.reason.ifBlank { "请重试" }}"
            }
            is LedgerPayload.Send -> null // 失败显示在气泡原位（outbox 的失败行）。
            is LedgerPayload.Launch -> null // 失败在聊天页原位显示原因及“重试”“返回”。
            is LedgerPayload.Config -> "${configTitle((op.payload as LedgerPayload.Config).setting)}切换未完成：${rejection.reason.ifBlank { "请重试" }}"
            // 核对后请求仍在：静默恢复面板；明确失败时面板回到原位并说明原因，答案保留。
            is LedgerPayload.Respond -> when (rejection.code) {
                "unresolved", "not_applied" -> null
                else -> "回答未提交：${rejection.reason.ifBlank { "请重试" }}"
            }
        }
    }

    private fun JsonObject.text(key: String): String? = (this[key]?.takeIf { it !is JsonNull })?.jsonPrimitive?.contentOrNull
    private fun String?.nonBlank(): String? = this?.takeIf(String::isNotBlank)
}

// ---- ADR-0049 §7 操作账本的输入：reducer 与 HostConnection 共用的纯状态转换 ----

/** 首页正在关闭的会话（含结果不明）：卡片保持隐藏。 */
internal val RemoteState.closingRuntimeIds: Set<String> get() = OperationKinds.hiddenRuntimeIds(ledger)

/** 界面看到的通知清单：权威清单减去本设备正在关闭的通知（账本叠加，L3）。 */
internal fun RemoteState.visibleNotificationProjection(runtimeId: String): NoticeProjection? {
    val projection = notificationProjections[runtimeId] ?: return null
    val hidden = OperationKinds.hiddenNotificationKeys(ledger)
    if (hidden.isEmpty()) return projection
    val items = projection.items.filterNot { "$runtimeId\u0000${it.notificationId}" in hidden }
    return if (items.size == projection.items.size) projection else projection.copy(items = items)
}

/** 账本事件的呈现：列表类被拒绝时提示原因后删除，界面随叠加回到权威状态；结果不明的要求一次核对读取。 */
internal fun RemoteState.withLedgerStep(step: LedgerStep<LedgerPayload>): RemoteState {
    var nextLedger = step.ledger
    var nextError = error
    var verify = ledgerVerifyWanted
    var outcomes = interactionOutcomes
    var sends = pendingSends
    var launch = launching
    var selected = selectedRuntimeId
    var draftMove = launchDraftMove
    var activateRequests = sessionActivateRequests
    val archiveRejections = step.events.count { it is LedgerEvent.Rejected && it.operation.payload is LedgerPayload.Archive }
    for (event in step.events) when (event) {
        is LedgerEvent.Rejected -> {
            // 等待中的消息：前置失败时这条转失败，原因写明前置操作（ADR-0049 §6.2）。
            (event.operation.payload as? LedgerPayload.Send)?.let { send ->
                val rejection = (event.operation.phase as? LedgerPhase.Rejected)?.rejection
                sends[send.messageId]?.let { it to it.state }?.let { (row, state) ->
                    if (state !is PendingSendState.Waiting) return@let
                    // 配置切换失败：等它的消息一起转失败（“模型切换未完成，消息未发送”），可按当前配置重新发送。
                    val reason = if (rejection?.code == "prerequisite" && state.label.startsWith("等待") &&
                        (state.label.endsWith("切换") || state.label.endsWith("启动")))
                        state.label.removePrefix("等待") + "未完成，消息未发送" else rejection?.reason.orEmpty()
                    sends = sends + (send.messageId to row.copy(state = PendingSendState.Failed(reason)))
                }
            }
            // 启动失败：在聊天页原位显示原因及“重试”“返回”，草稿保留，不自动退回原页面。
            (event.operation.payload as? LedgerPayload.Launch)?.let { payload ->
                if (launch?.requestId == payload.requestId) {
                    val reason = (event.operation.phase as? LedgerPhase.Rejected)?.rejection?.reason.orEmpty().ifBlank { "启动失败" }
                    launch = launch?.copy(failure = reason)?.takeIf { it.following }
                }
                activateRequests = activateRequests - payload.requestId
            }
            // 批量归档同时被拒绝时写明数量（ADR-0049 §6.4）。
            OperationKinds.message(event.operation)?.let { nextError = if (archiveRejections > 1) "$archiveRejections 个会话$it" else it }
            if (OperationKinds.removesOnRejection(event.operation)) nextLedger = nextLedger.remove(event.operation.opId)
        }
        is LedgerEvent.Verify -> verify = true
        is LedgerEvent.Unconfirmed -> (event.operation.payload as? LedgerPayload.Launch)?.let { payload ->
            if (launch?.requestId == payload.requestId) launch = launch?.copy(unconfirmed = true)
            activateRequests = activateRequests - payload.requestId
        }
        is LedgerEvent.Landed -> (event.operation.payload as? LedgerPayload.Launch)?.let { payload ->
            // 启动成功：草稿迁到真实会话（V17），用户仍在启动页时切过去；离开了就不拉回，会话照常出现在首页。
            val current = launch?.takeIf { it.requestId == payload.requestId } ?: return@let
            val real = runtimes.values.firstOrNull { it.sessionId == current.sessionId }
            if (real != null) draftMove = current.runtime() to real
            if (current.following && selected == current.placeholder && real != null) selected = real.runtimeId
            else if (selected == current.placeholder) selected = null
            launch = null
        } ?: (event.operation.payload as? LedgerPayload.Respond)?.let { respond ->
            // 回答已结算：原位短暂显示结果（约 2.5 秒，V16）。只因请求已不在而结算的显示“已处理”，不声称是本机回答生效。
            outcomes = outcomes + (respond.runtimeId to InteractionOutcome(event.operation.opId,
                if (event.operation.succeeded) respond.summary else "已处理"))
        }
        else -> Unit
    }
    return copy(ledger = nextLedger, error = nextError, ledgerVerifyWanted = verify, interactionOutcomes = outcomes, pendingSends = sends,
        launching = launch, selectedRuntimeId = selected, launchDraftMove = draftMove, sessionActivateRequests = activateRequests)
}

private val LedgerPhase.awaitsVerification get() = this == LedgerPhase.Unknown || this == LedgerPhase.Unconfirmed

/** 加密连接已建立：账本进入新的连接代次，旧连接上仍未结算的操作重新核对（L4、L5）。 */
internal fun RemoteState.ledgerOpenConnection(): RemoteState {
    if (ledgerConnectionOpen) return this
    val opened = copy(ledgerConnectionOpen = true, ledgerFresh = emptySet()).withLedgerStep(ledger.connected())
    return if (opened.ledger.operations.any { it.phase.awaitsVerification }) opened.copy(ledgerVerifyWanted = true) else opened
}

/** 连接断开：已写入的操作统一转结果不明，旧连接上的核对读取作废（L4）。 */
internal fun RemoteState.ledgerCloseConnection(): RemoteState {
    if (!ledgerConnectionOpen) return this
    return copy(ledgerConnectionOpen = false, ledgerReads = emptyMap(), ledgerFresh = emptySet()).withLedgerStep(ledger.connectionLost())
}

/** 创建操作时记下它要读的领域已应用到哪里（L2 的 basis）。 */
internal fun RemoteState.ledgerBasis(domain: String): Map<String, Int> = mapOf(domain to (authoritySeq[domain] ?: 0))

/** 各领域的证据：只在这里读当前权威状态，种类规则在 [OperationKinds]。 */
private fun RemoteState.ledgerEvidence(domain: String): (LedgerOperation<LedgerPayload>) -> LedgerEvidence {
    if (domain == OperationKinds.RUNTIMES_DOMAIN) {
        val ids = runtimes.keys
        val sessions = runtimes.values.mapNotNullTo(mutableSetOf()) { it.sessionId }
        val launch = launching
        return { op ->
            // `launch`：Host 给出的 Session 的 Runtime 已上线即落地。
            val payload = op.payload as? LedgerPayload.Launch
            if (payload == null) OperationKinds.evidence(op, ids)
            else if (launch?.requestId == payload.requestId && launch.sessionId != null && launch.sessionId in sessions) LedgerEvidence.LANDED
            else LedgerEvidence.NONE
        }
    }
    if (domain == OperationKinds.CATALOG_DOMAIN) {
        val catalog = sessions
        return { OperationKinds.catalogEvidence(it, catalog) }
    }
    if (domain.startsWith("model:")) {
        val runtime = runtimes[domain.removePrefix("model:")]
        return { OperationKinds.configEvidence(it, runtime) }
    }
    if (domain.startsWith("interactions:")) {
        val runtimeId = domain.removePrefix("interactions:")
        val requests = conversations[runtimeId]?.interactions.orEmpty()
        return { op -> if ((op.payload as? LedgerPayload.Respond)?.runtimeId == runtimeId) OperationKinds.interactionEvidence(op, requests) else LedgerEvidence.NONE }
    }
    if (domain.startsWith("queue:")) {
        val runtimeId = domain.removePrefix("queue:")
        val queue = conversations[runtimeId]?.queuedMessages.orEmpty()
        return { op -> if ((op.payload as? LedgerPayload.QueueCancel)?.runtimeId == runtimeId) OperationKinds.queueEvidence(op, queue) else LedgerEvidence.NONE }
    }
    val projections = notificationProjections
    return { op ->
        val payload = op.payload as? LedgerPayload.Dismiss
        if (payload == null || OperationKinds.noticesDomain(payload.runtimeId) != domain) LedgerEvidence.NONE
        else OperationKinds.noticeEvidence(op, projections[payload.runtimeId])
    }
}

/** 领域当前的权威状态是否完整：部分结果不能作为反向证据（L2）。 */
private fun RemoteState.ledgerDomainComplete(domain: String): Boolean = when {
    domain == OperationKinds.RUNTIMES_DOMAIN || domain == OperationKinds.CATALOG_DOMAIN -> true
    domain.startsWith("notifications:") -> notificationProjections[domain.removePrefix("notifications:")]?.complete == true
    domain.startsWith("queue:") -> runtimes[domain.removePrefix("queue:")]?.domainAvailability?.get("delivery") == "ready"
    domain.startsWith("interactions:") -> runtimes[domain.removePrefix("interactions:")]?.domainAvailability?.get("interactions") == "ready"
    domain.startsWith("model:") -> true
    else -> false
}

/** 某个领域的权威状态刚刚应用。`read` 是核对读取的序号；推送为 null。 */
internal fun RemoteState.ledgerAuthority(domain: String, read: Int?, complete: Boolean): RemoteState {
    // Runtime 已不在：它的队列随之消失，撤回失效（L7）。
    val base = if (domain != OperationKinds.RUNTIMES_DOMAIN) this else
        withLedgerStep(ledger.expire { op -> (op.payload as? LedgerPayload.QueueCancel)?.let { it.runtimeId !in runtimes } ?: false })
    return base.stampAuthority(domain, read, complete)
}

private fun RemoteState.stampAuthority(domain: String, read: Int?, complete: Boolean): RemoteState {
    val seq = (authoritySeq[domain] ?: 0) + 1
    val stamped = copy(authoritySeq = authoritySeq + (domain to seq), ledgerFresh = if (read == null) ledgerFresh + domain else ledgerFresh)
    if (ledger.operations.none { domain in it.basis }) return stamped
    val stamp = LedgerStamp(domain, seq, ledger.connection, read, complete)
    return stamped.withLedgerStep(ledger.authority(stamp, ledgerEvidence(domain)))
}

/** 在线列表已应用。 */
internal fun RemoteState.ledgerRuntimeList(read: Int?, complete: Boolean): RemoteState =
    ledgerAuthority(OperationKinds.RUNTIMES_DOMAIN, read, complete)

/** 通知快照被接受后：该 Runtime 的通知清单作为权威状态交给账本。 */
internal fun RemoteState.ledgerNotices(runtimeId: String): RemoteState =
    ledgerAuthority(OperationKinds.noticesDomain(runtimeId), null, notificationProjections[runtimeId]?.complete == true)

/** Host 通知代次变了：旧代次上的关闭全部失效（L7）。 */
internal fun RemoteState.ledgerExpireStaleNotices(): RemoteState =
    withLedgerStep(ledger.expire { op -> (op.payload as? LedgerPayload.Dismiss)?.let { it.hostEpoch != notificationEpoch } ?: false })

/** 同一 opId 的回执（L1）。 */
internal fun RemoteState.ledgerReceipt(opId: String, receipt: LedgerReceipt, now: Long): RemoteState =
    withLedgerStep(ledger.receipt(opId, ledger.connection, receipt, now))

/** 发起一次读取：登记读取序号，回复带着它交回账本。 */
internal fun RemoteState.beginLedgerRead(requestId: String): RemoteState {
    val (next, read) = ledger.beginRead()
    return copy(ledger = next, ledgerReads = ledgerReads + (requestId to read), ledgerVerifyWanted = false)
}

/**
 * 核对读取的回复：先交设备私有回执，再以同一时刻的权威状态核对（L5）。读取失败（例如旧 Host 不认识设备作用域）
 * 也是这次读取之后的回复：回执按查不到处理，仍以权威状态核对，不让操作停在结果不明。只核对本连接上已刷新过的领域。
 */
internal fun RemoteState.ledgerReadReply(requestId: String, message: JsonObject, now: Long): RemoteState {
    val read = ledgerReads[requestId] ?: return this
    val type = message["type"]?.jsonPrimitive?.contentOrNull
    val receipts = if (type == "agent.state.snapshot" && message["scope"]?.jsonPrimitive?.contentOrNull == "device" && message["error"] == null) {
        val domains = message["domains"] as? kotlinx.serialization.json.JsonArray
        val operations = domains?.firstOrNull { (it as? JsonObject)?.get("domain")?.jsonPrimitive?.contentOrNull == "operations" } as? JsonObject
        OperationKinds.deviceReceipts(operations?.get("value"))
    } else emptyMap()
    var next = copy(ledgerReads = ledgerReads - requestId).withLedgerStep(ledger.deviceReceipts(receipts, ledger.connection, now))
    val domains = next.ledger.operations.flatMap { it.basis.keys }.toSet().intersect(next.ledgerFresh).sorted()
    for (domain in domains) next = next.ledgerAuthority(domain, read, next.ledgerDomainComplete(domain))
    return next
}

/** 到期处理的唯一入口（L8）。 */
internal fun RemoteState.ledgerTick(now: Long): RemoteState = withLedgerStep(ledger.tick(now))

/** `quit` 先记入账本（尚未写入）；返回是否创建。同一会话的关闭尚未结算时不重复创建（L9）。 */
internal fun RemoteState.createQuit(opId: String, runtimeId: String, now: Long): Pair<RemoteState, LedgerCreation<LedgerPayload>> {
    val (next, creation) = ledger.create(opId, OperationKinds.QUIT, OperationKinds.quitTarget(runtimeId),
        policy = OperationKinds.quitPolicy, basis = ledgerBasis(OperationKinds.RUNTIMES_DOMAIN),
        payload = LedgerPayload.Quit(runtimeId), written = false, now = now)
    return copy(ledger = next) to creation
}

/** 调用方已把操作写入通道。 */
internal fun RemoteState.ledgerWritten(opId: String, now: Long): RemoteState = withLedgerStep(ledger.written(opId, now))

/** `dismiss` 先记入账本（尚未写入）。同一通知的关闭尚未结算时不重复创建（L9）。 */
internal fun RemoteState.createDismiss(opId: String, runtimeId: String, notificationId: String, now: Long): Pair<RemoteState, LedgerCreation<LedgerPayload>> {
    val epoch = notificationEpoch ?: return this to LedgerCreation.Full()
    val (next, creation) = ledger.create(opId, OperationKinds.DISMISS, OperationKinds.dismissTarget(runtimeId, epoch, notificationId),
        policy = OperationKinds.dismissPolicy, basis = ledgerBasis(OperationKinds.noticesDomain(runtimeId)),
        payload = LedgerPayload.Dismiss(runtimeId, epoch, notificationId), written = false, now = now)
    return copy(ledger = next) to creation
}

/** 关闭写入后立即读取一次：它的回复因果晚于 Host 对关闭的处理（L2）。 */
internal fun RemoteState.dismissWritten(opId: String, now: Long): RemoteState = ledgerWritten(opId, now).copy(ledgerVerifyWanted = true)

/** 目录叠加未结算的归档操作：卡片立即出现在目标列表（ADR-0049 §6.4）。 */
internal fun RemoteState.sessionsWithLedger(): Map<String, SessionCatalogEntry> {
    val overrides = OperationKinds.archiveOverrides(ledger)
    if (overrides.isEmpty()) return sessions
    return sessions.mapValues { (id, entry) -> overrides[id]?.let { entry.copy(archived = it) } ?: entry }
}

/** 正在归档 / 恢复、尚未结算的会话：冲突入口在结算前禁用（L9）。 */
internal val RemoteState.archivingSessionIds: Set<String> get() = OperationKinds.archiveOverrides(ledger).keys

/** `archive` 先记入账本（尚未写入），opId 即请求的 requestId。同一会话的归档尚未结算时不重复创建（L9）。 */
internal fun RemoteState.createArchive(requestId: String, sessionId: String, agentKind: String, archived: Boolean, now: Long):
    Pair<RemoteState, LedgerCreation<LedgerPayload>> {
    val (next, creation) = ledger.create(requestId, OperationKinds.ARCHIVE, OperationKinds.archiveTarget(agentKind, sessionId),
        policy = OperationKinds.archivePolicy, basis = ledgerBasis(OperationKinds.CATALOG_DOMAIN),
        payload = LedgerPayload.Archive(sessionId, agentKind, archived), written = false, now = now)
    return copy(ledger = next) to creation
}

/** `queueCancel` 先记入账本（尚未写入），opId 即命令的 commandId。同一队列项的撤回尚未结算时不重复创建（L9）。 */
internal fun RemoteState.createQueueCancel(commandId: String, runtimeId: String, queueId: String, now: Long):
    Pair<RemoteState, LedgerCreation<LedgerPayload>> {
    val (next, creation) = ledger.create(commandId, OperationKinds.QUEUE_CANCEL, OperationKinds.queueCancelTarget(runtimeId, queueId),
        policy = OperationKinds.queueCancelPolicy, basis = ledgerBasis(OperationKinds.queueDomain(runtimeId)),
        payload = LedgerPayload.QueueCancel(runtimeId, queueId), written = false, now = now)
    return copy(ledger = next) to creation
}

/**
 * Host 队列（delivery 领域）已应用：已投递的项若正在撤回，按 `already_delivered` 结算（Host 声明的同一身份），
 * 再把队列作为权威状态交给账本。
 */
internal fun RemoteState.ledgerQueue(runtimeId: String, delivered: Set<String>, complete: Boolean, now: Long): RemoteState {
    var next = this
    for (op in ledger.operations) {
        val payload = op.payload as? LedgerPayload.QueueCancel ?: continue
        if (payload.runtimeId == runtimeId && payload.queueId in delivered && !op.phase.isSettled) {
            next = next.withLedgerStep(next.ledger.receipt(op.opId, next.ledger.connection, LedgerReceipt.Failed(OperationKinds.queueAlreadyDelivered), now))
        }
    }
    return next.ledgerAuthority(OperationKinds.queueDomain(runtimeId), null, complete)
}

/** 回答结算后在原位短暂显示的结果（V16）：`id` 区分每次结算，界面据此计时约 2.5 秒后隐藏。 */
data class InteractionOutcome(val id: String, val text: String)

/** `respond` 先记入账本（尚未写入），opId 即命令的 commandId。同一请求的回答尚未结算时不重复创建（L9）。 */
internal fun RemoteState.createRespond(commandId: String, runtimeId: String, requestId: String, summary: String, now: Long):
    Pair<RemoteState, LedgerCreation<LedgerPayload>> {
    val (next, creation) = ledger.create(commandId, OperationKinds.RESPOND, OperationKinds.respondTarget(runtimeId, requestId),
        policy = OperationKinds.respondPolicy, basis = ledgerBasis(OperationKinds.interactionsDomain(runtimeId)),
        payload = LedgerPayload.Respond(runtimeId, requestId, summary), written = false, now = now)
    return copy(ledger = next) to creation
}

/** 原位短状态：账本中未结算的回答，或刚结算的结果（文案, 是否处理中, 结果标识）。 */
internal fun RemoteState.interactionStatus(runtimeId: String): Triple<String, Boolean, String?>? =
    OperationKinds.respondStatus(ledger, runtimeId)?.let { Triple(it.first, it.second, null) }
        ?: interactionOutcomes[runtimeId]?.let { Triple(it.text, false, it.id) }

/**
 * ADR-0049 §6.2：气泡立即出现，输入框清空；附件上传完成且同会话前一条已写入后，按创建顺序写入通道。
 * opId 即写入时使用的 commandId。
 */
internal fun RemoteState.createWaitingSend(
    commandId: String, messageId: String, runtimeId: String, sessionId: String, text: String, delivery: String?,
    uploadIds: List<String>, pendingUploads: List<UploadTask>, now: Long,
    configs: List<LedgerOperation<LedgerPayload>> = emptyList(),
): Pair<RemoteState, LedgerCreation<LedgerPayload>> {
    val (next, creation) = ledger.create(commandId, OperationKinds.SEND, "message:$messageId", group = OperationKinds.sendGroup(sessionId),
        conflicts = false, policy = OperationKinds.sendPolicy, basis = emptyMap(),
        prerequisites = pendingUploads.map { OperationKinds.uploadPrerequisite(it.taskId) }.toSet() + configs.map { it.opId },
        payload = LedgerPayload.Send(runtimeId, sessionId, messageId), written = false, now = now)
    if (creation !is LedgerCreation.Created) return this to creation
    val config = configs.firstNotNullOfOrNull { it.payload as? LedgerPayload.Config }?.let { OperationKinds.configTitle(it.setting) }
    val label = when {
        pendingUploads.isNotEmpty() -> "上传中：" + pendingUploads.joinToString("、") { it.displayName }
        configs.any { it.payload is LedgerPayload.Launch } -> "等待会话启动"
        config != null -> "等待${config}切换"
        else -> "等待前一条发送"
    }
    val anchor = conversations[runtimeId]?.messages?.lastOrNull()?.messageId
    val send = PendingSend(messageId, commandId, sessionId, text, emptyList(), delivery, now, anchor,
        state = PendingSendState.Waiting(label), uploadIds = uploadIds)
    return copy(ledger = next, pendingSends = pendingSends + (messageId to send)) to creation
}

/** 轮到它的等待消息已写入通道：换成 Host 附件路径进入发送中，账本记录交给 outbox。 */
internal fun RemoteState.waitingWritten(opId: String, messageId: String, runtimeId: String, paths: List<String>, now: Long): RemoteState {
    val send = pendingSends[messageId]?.takeIf { it.state is PendingSendState.Waiting } ?: return this
    val step = ledger.written(opId, now)
    return copy(pendingSends = pendingSends + (messageId to send.copy(state = PendingSendState.Sending, attachments = paths)),
        pendingCommands = pendingCommands + (opId to runtimeId), uploads = uploads - send.uploadIds.toSet())
        .withLedgerStep(LedgerStep(step.ledger.remove(opId), step.events))
}

/** 上传结束（完成、失败或取消）：等待它的消息据此写入或转失败。 */
internal fun RemoteState.ledgerUploadSettled(taskId: String, succeeded: Boolean, reason: String): RemoteState =
    withLedgerStep(ledger.prerequisite(OperationKinds.uploadPrerequisite(taskId), succeeded, reason))

/** 已经可以写入通道的等待消息（前置都已完成、同组没有更早的等待者）。 */
internal fun RemoteState.readySends(): List<LedgerOperation<LedgerPayload>> = ledger.ready().filter { it.payload is LedgerPayload.Send }

/** `config` 先记入账本（尚未写入），opId 即命令的 commandId。 */
internal fun RemoteState.createConfig(commandId: String, runtimeId: String, setting: String, value: String, label: String, now: Long):
    Pair<RemoteState, LedgerCreation<LedgerPayload>> {
    val (next, creation) = ledger.create(commandId, OperationKinds.CONFIG, OperationKinds.configTarget(runtimeId, setting),
        policy = OperationKinds.configPolicy, basis = ledgerBasis(OperationKinds.modelDomain(runtimeId)),
        payload = LedgerPayload.Config(runtimeId, setting, value, label), written = false, now = now)
    return copy(ledger = next) to creation
}

/** 顶栏与选择器显示的值：(名字, 标记)；没有进行中的切换时为 null，显示确认值。 */
internal fun RemoteState.configStatus(runtimeId: String, setting: String): Pair<String, String>? =
    configSelections[OperationKinds.configTarget(runtimeId, setting)]?.let { it.second to "切换中" }
        ?: OperationKinds.configStatus(ledger, runtimeId, setting)


/** ADR-0049 §6.8：正在启动的会话。启动期间聊天页用占位身份显示，草稿与消息先归属它，Session ID 确认后迁移。 */
data class LaunchState(
    val requestId: String,
    val placeholder: String,
    val target: Map<String, String>,
    val title: String,
    val cwd: String,
    val agentKind: String?,
    /** 恢复的已有会话；新建时为 null。启动期间聊天页、草稿与消息都用它（或占位身份）归属，保持稳定。 */
    val resumed: String?,
    /** Host 在 `session.activated` 中给出的 Session。 */
    val sessionId: String? = resumed,
    val failure: String? = null,
    val unconfirmed: Boolean = false,
    /** 用户仍停在这个启动页：成功后切到真实会话；离开后不再把用户拉回。 */
    val following: Boolean = true,
) {
    val status: String get() = if (failure != null) "error" else if (unconfirmed) "launch_unconfirmed" else "starting"
    /** 启动期间聊天页的占位 Runtime：草稿与消息归属它。 */
    fun runtime() = RuntimeSummary(placeholder, title, cwd, status, resumed ?: placeholder, agentKind = agentKind)
}

/** 当前聊天页是不是启动中的会话。 */
internal val RemoteState.launchPage: LaunchState? get() = launching?.takeIf { it.placeholder == selectedRuntimeId }

/** `launch` 先记入账本（尚未写入），opId 即请求的 requestId；同时立即进入启动页。 */
internal fun RemoteState.createLaunch(requestId: String, target: Map<String, String>, title: String, now: Long): Pair<RemoteState, LedgerCreation<LedgerPayload>> {
    val placeholder = "launch:$requestId"
    val (next, creation) = ledger.create(requestId, OperationKinds.LAUNCH, placeholder, policy = OperationKinds.launchPolicy,
        basis = ledgerBasis(OperationKinds.RUNTIMES_DOMAIN), payload = LedgerPayload.Launch(requestId, placeholder), written = false, now = now)
    if (creation !is LedgerCreation.Created) return this to creation
    val resumed = target["sessionId"]?.takeIf { target["type"] == "resume" }
    val launch = LaunchState(requestId, placeholder, target, title, target["cwd"] ?: resumed?.let { sessions[it]?.cwd }.orEmpty(),
        target["agentKind"], resumed)
    return copy(ledger = next, launching = launch, selectedRuntimeId = placeholder, selectedOfflineSessionId = null) to creation
}

/** 同一 requestId 的 session.activated：记下 Host 给出的 Session，占位 Session 下的消息转到真实会话。 */
internal fun RemoteState.launchActivated(requestId: String, sessionId: String, now: Long): RemoteState {
    val launch = launching?.takeIf { it.requestId == requestId } ?: return this
    val provisional = launch.resumed ?: launch.placeholder
    val rebound = pendingSends.mapValues { (_, send) -> if (send.sessionId == provisional) send.copy(sessionId = sessionId) else send }
    return copy(launching = launch.copy(sessionId = sessionId), launchSessions = launchSessions + (provisional to sessionId), pendingSends = rebound)
        .ledgerReceipt(requestId, LedgerReceipt.Succeeded, now)
        .ledgerRuntimeList(read = null, complete = false)
}

/** 用户离开了启动页：启动继续，成功后不把用户拉回；失败或未确认的启动随之收起。 */
internal fun RemoteState.stopFollowingLaunch(): RemoteState {
    val launch = launching ?: return this
    return copy(launching = if (launch.failure != null || launch.unconfirmed) null else launch.copy(following = false),
        activatedSessionToOpen = null)
}
