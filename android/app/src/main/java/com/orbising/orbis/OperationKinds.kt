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

    /** 被拒绝后是否直接删除：列表类（首页卡片、通知横幅）提示后回到原位；内容类保留失败状态等用户处理。 */
    fun removesOnRejection(op: LedgerOperation<LedgerPayload>): Boolean = when (op.payload) {
        is LedgerPayload.Quit, is LedgerPayload.Dismiss -> true
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
        is LedgerPayload.Dismiss -> LedgerEvidence.NONE
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
    for (event in step.events) when (event) {
        is LedgerEvent.Rejected -> {
            OperationKinds.message(event.operation)?.let { nextError = it }
            if (OperationKinds.removesOnRejection(event.operation)) nextLedger = nextLedger.remove(event.operation.opId)
        }
        is LedgerEvent.Verify -> verify = true
        else -> Unit
    }
    return copy(ledger = nextLedger, error = nextError, ledgerVerifyWanted = verify)
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
        return { OperationKinds.evidence(it, ids) }
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
    domain == OperationKinds.RUNTIMES_DOMAIN -> true
    domain.startsWith("notifications:") -> notificationProjections[domain.removePrefix("notifications:")]?.complete == true
    else -> false
}

/** 某个领域的权威状态刚刚应用。`read` 是核对读取的序号；推送为 null。 */
internal fun RemoteState.ledgerAuthority(domain: String, read: Int?, complete: Boolean): RemoteState {
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
