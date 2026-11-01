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
                "cancelled" -> LedgerReceipt.Uncertain
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
        }
    }

    private fun JsonObject.text(key: String): String? = (this[key]?.takeIf { it !is JsonNull })?.jsonPrimitive?.contentOrNull
    private fun String?.nonBlank(): String? = this?.takeIf(String::isNotBlank)
}

// ---- ADR-0049 §7 操作账本的输入：reducer 与 HostConnection 共用的纯状态转换 ----

/** 首页正在关闭的会话（含结果不明）：卡片保持隐藏。 */
internal val RemoteState.closingRuntimeIds: Set<String> get() = OperationKinds.hiddenRuntimeIds(ledger)

/** 账本事件的呈现：被拒绝的操作提示原因后删除，界面随叠加回到权威状态；结果不明的要求一次核对读取。 */
internal fun RemoteState.withLedgerStep(step: LedgerStep<LedgerPayload>): RemoteState {
    var nextLedger = step.ledger
    var nextError = error
    var verify = ledgerVerifyWanted
    for (event in step.events) when (event) {
        is LedgerEvent.Rejected -> {
            OperationKinds.message(event.operation)?.let { nextError = it }
            when (event.operation.payload) {
                is LedgerPayload.Quit -> nextLedger = nextLedger.remove(event.operation.opId) // 列表类：提示后删除，卡片回到原位。
            }
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
    val opened = copy(ledgerConnectionOpen = true).withLedgerStep(ledger.connected())
    return if (opened.ledger.operations.any { it.phase.awaitsVerification }) opened.copy(ledgerVerifyWanted = true) else opened
}

/** 连接断开：已写入的操作统一转结果不明，旧连接上的核对读取作废（L4）。 */
internal fun RemoteState.ledgerCloseConnection(): RemoteState {
    if (!ledgerConnectionOpen) return this
    return copy(ledgerConnectionOpen = false, ledgerReads = emptyMap()).withLedgerStep(ledger.connectionLost())
}

/** 在线列表已应用。`read` 是核对读取的序号：同一有序通道上，读取回复到达时的在线列表已包含 Host 处理这次读取之前的全部变化。 */
internal fun RemoteState.ledgerRuntimeList(read: Int?, complete: Boolean): RemoteState {
    val seq = runtimeListSeq + 1
    if (ledger.operations.isEmpty()) return copy(runtimeListSeq = seq)
    val ids = runtimes.keys
    val stamp = LedgerStamp(OperationKinds.RUNTIMES_DOMAIN, seq, ledger.connection, read, complete)
    return copy(runtimeListSeq = seq).withLedgerStep(ledger.authority(stamp) { OperationKinds.evidence(it, ids) })
}

/** 同一 opId 的回执（L1）。 */
internal fun RemoteState.ledgerReceipt(opId: String, receipt: LedgerReceipt, now: Long): RemoteState =
    withLedgerStep(ledger.receipt(opId, ledger.connection, receipt, now))

/** 发起一次核对读取：登记读取序号，回复带着它交回账本。 */
internal fun RemoteState.beginLedgerRead(requestId: String): RemoteState {
    val (next, read) = ledger.beginRead()
    return copy(ledger = next, ledgerReads = ledgerReads + (requestId to read), ledgerVerifyWanted = false)
}

/**
 * 核对读取的回复：先交设备私有回执，再以同一时刻的在线列表核对（L5）。读取失败（例如旧 Host 不认识设备作用域）
 * 也是这次读取之后的回复：回执按查不到处理，仍以在线列表核对，不让操作停在结果不明。
 */
internal fun RemoteState.ledgerReadReply(requestId: String, message: JsonObject, now: Long): RemoteState {
    val read = ledgerReads[requestId] ?: return this
    val type = message["type"]?.jsonPrimitive?.contentOrNull
    val receipts = if (type == "agent.state.snapshot" && message["scope"]?.jsonPrimitive?.contentOrNull == "device" && message["error"] == null) {
        val domains = message["domains"] as? kotlinx.serialization.json.JsonArray
        val operations = domains?.firstOrNull { (it as? JsonObject)?.get("domain")?.jsonPrimitive?.contentOrNull == "operations" } as? JsonObject
        OperationKinds.deviceReceipts(operations?.get("value"))
    } else emptyMap()
    return copy(ledgerReads = ledgerReads - requestId)
        .withLedgerStep(ledger.deviceReceipts(receipts, ledger.connection, now))
        .ledgerRuntimeList(read, complete = true)
}

/** 到期处理的唯一入口（L8）。 */
internal fun RemoteState.ledgerTick(now: Long): RemoteState = withLedgerStep(ledger.tick(now))

/** `quit` 先记入账本（尚未写入）；返回是否创建。同一会话的关闭尚未结算时不重复创建（L9）。 */
internal fun RemoteState.createQuit(opId: String, runtimeId: String, now: Long): Pair<RemoteState, LedgerCreation<LedgerPayload>> {
    val (next, creation) = ledger.create(opId, OperationKinds.QUIT, OperationKinds.quitTarget(runtimeId),
        policy = OperationKinds.quitPolicy, basis = mapOf(OperationKinds.RUNTIMES_DOMAIN to runtimeListSeq),
        payload = LedgerPayload.Quit(runtimeId), written = false, now = now)
    return copy(ledger = next) to creation
}

/** 调用方已把操作写入通道。 */
internal fun RemoteState.ledgerWritten(opId: String, now: Long): RemoteState = withLedgerStep(ledger.written(opId, now))
