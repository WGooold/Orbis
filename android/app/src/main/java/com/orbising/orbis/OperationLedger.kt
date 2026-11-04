package com.orbising.orbis

/**
 * ADR-0049 §7：客户端操作账本。所有乐观操作都记在这里，阶段、断线、期限、作用域和冲突只在这里实现一次。
 *
 * 账本是不可变值：不发送、不读取、不计时。[HostConnection] 负责写入通道、发起读取和驱动时钟，
 * 再把回执、权威状态和本机事件作为输入交给账本；每次调用返回新账本和事件。界面 = 权威状态叠加账本中的操作，
 * 删除一条操作，界面就回到权威状态（L3）。账本从不修改权威状态或缓存。iOS `OperationLedger.swift` 与本文件同构。
 */
data class LedgerRejection(val code: String, val reason: String)

sealed interface LedgerPhase {
    /** 已在本机创建，尚未写入通道（等前置操作或同组的前一条）。 */
    data object Waiting : LedgerPhase
    /** 已写入加密通道。 */
    data object Sent : LedgerPhase
    /** Host 已受理，尚无最终结果。 */
    data object Accepted : LedgerPhase
    /** 可能已执行，结果未知；等核对（L5）。 */
    data object Unknown : LedgerPhase
    /** 核对后仍无证据（ADR-0055 P12）：保持可见并提供核对入口，之后出现落地证据仍会落地。 */
    data object Unconfirmed : LedgerPhase
    /** 明确未执行，或种类的“结果不明”规则判定未生效。 */
    data class Rejected(val rejection: LedgerRejection) : LedgerPhase

    val isSettled: Boolean get() = this is Rejected
}

sealed interface LedgerTimeout {
    data object Unknown : LedgerTimeout
    data class Reject(val rejection: LedgerRejection) : LedgerTimeout
}

/** 种类策略（§7.5）。每种操作只声明这些，其余全部由账本处理。 */
data class LedgerPolicy(
    /** 成功回执即落地（例如回答、撤回）；否则成功回执只表示受理，仍等权威状态。 */
    val successLands: Boolean = false,
    /** 受理（pending）后多久仍无最终结果就转为结果不明；null 表示一直等落地证据（例如排队中的消息）。 */
    val acceptedBudgetMs: Long? = LEDGER_RECEIPT_BUDGET_MS,
    /** 成功回执后多久仍无落地证据，以及到期结果；null 表示一直等。 */
    val afterSuccessMs: Long? = null,
    val afterSuccess: LedgerTimeout = LedgerTimeout.Unknown,
    /** 结果不明且核对后仍无证据：拒绝（列表类恢复原状）或保持未确认（内容类）。 */
    val whenUnresolved: LedgerTimeout = LedgerTimeout.Unknown,
    /** Host 会为它写设备私有回执 `DeviceView.operations`（§7.6）。 */
    val deviceReceipts: Boolean = true,
    /** Host 处理请求时同步生效，之后发起的读取已能反映结果（例如关闭通知）。 */
    val appliesBeforeLaterReads: Boolean = false,
)

data class LedgerOperation<P>(
    /** 幂等键：commandId 或 requestId。一个 opId 只代表一次用户意图。 */
    val opId: String,
    val kind: String,
    /** 目标键：同一目标同时只有一个未结算的冲突操作（L9）。 */
    val target: String,
    /** 顺序组：同组按创建顺序写入通道，后创建的不越过仍在等待的前一条（L9）。 */
    val group: String?,
    val conflicts: Boolean,
    val policy: LedgerPolicy,
    /** 创建时已应用的权威序号，按领域记录；只有更新的权威状态才能作为证据（L2）。 */
    val basis: Map<String, Int>,
    val createdAt: Long,
    val payload: P,
    val prerequisites: Set<String>,
    val phase: LedgerPhase,
    /** 写入通道时的连接代次。 */
    val connection: Int? = null,
    /** Host 处理完这次操作时（同步生效的种类为写入时）的读取序号；之后发起的读取才能作为反向证据（L2）。 */
    val settledRead: Int? = null,
    val deadline: Long? = null,
    val succeeded: Boolean = false,
    /** 结果不明后：已用因果晚于操作的完整权威状态核对过。 */
    val authorityChecked: Boolean = false,
    /** 结果不明后：已读过设备私有回执，或该种类没有设备回执。 */
    val receiptChecked: Boolean = false,
)

sealed interface LedgerEvent<P> {
    val operation: LedgerOperation<P>
    data class Landed<P>(override val operation: LedgerOperation<P>) : LedgerEvent<P>
    data class Rejected<P>(override val operation: LedgerOperation<P>) : LedgerEvent<P>
    data class Unknown<P>(override val operation: LedgerOperation<P>) : LedgerEvent<P>
    data class Unconfirmed<P>(override val operation: LedgerOperation<P>) : LedgerEvent<P>
    data class Expired<P>(override val operation: LedgerOperation<P>) : LedgerEvent<P>
    /** 前置操作已完成，轮到它写入通道。 */
    data class Ready<P>(override val operation: LedgerOperation<P>) : LedgerEvent<P>
    /** 结果不明，需要账本的使用者主动发起一次读取（L5）。 */
    data class Verify<P>(override val operation: LedgerOperation<P>) : LedgerEvent<P>
}

sealed interface LedgerReceipt {
    /** `ok = true` 且 `pending`。 */
    data object Accepted : LedgerReceipt
    /** 最终成功。 */
    data object Succeeded : LedgerReceipt
    /** 明确失败，未执行。 */
    data class Failed(val rejection: LedgerRejection) : LedgerReceipt
    /** 客户端合成的 cancelled / unconfirmed：可能已执行。 */
    data object Uncertain : LedgerReceipt
}

/** 调用方按种类判定的证据：权威状态已体现结果、明确没有体现，或无从判断。 */
enum class LedgerEvidence { LANDED, NOT_APPLIED, NONE }

/** 一次已应用的权威状态的来源。 */
data class LedgerStamp(
    val domain: String,
    /** 本机按领域递增的已应用序号。 */
    val seq: Int,
    val connection: Int,
    /** 这是哪次读取的回复；推送来的更新为 null。 */
    val read: Int?,
    /** 完整快照；部分结果不能作为反向证据。 */
    val complete: Boolean,
)

sealed interface LedgerCreation<P> {
    class Created<P> : LedgerCreation<P> { override fun equals(other: Any?) = other is Created<*>; override fun hashCode() = 1 }
    class Duplicate<P> : LedgerCreation<P> { override fun equals(other: Any?) = other is Duplicate<*>; override fun hashCode() = 2 }
    class Full<P> : LedgerCreation<P> { override fun equals(other: Any?) = other is Full<*>; override fun hashCode() = 3 }
    data class Conflict<P>(val existing: LedgerOperation<P>) : LedgerCreation<P>
}

data class LedgerStep<P>(val ledger: OperationLedger<P>, val events: List<LedgerEvent<P>> = emptyList())

const val LEDGER_RECEIPT_BUDGET_MS = 60_000L

data class OperationLedger<P>(
    val operations: List<LedgerOperation<P>> = emptyList(),
    val connection: Int = 0,
    val readCounter: Int = 0,
    val capacity: Int = 256,
) {
    fun operation(opId: String): LedgerOperation<P>? = operations.firstOrNull { it.opId == opId }
    fun active(target: String): LedgerOperation<P>? = operations.firstOrNull { it.target == target && !it.phase.isSettled }
    fun operations(kind: String): List<LedgerOperation<P>> = operations.filter { it.kind == kind }
    /** 这个组里有还没写入通道的操作：新操作必须排在它后面。 */
    fun blocks(group: String): Boolean = operations.any { it.group == group && it.phase == LedgerPhase.Waiting }
    val nextDeadline: Long? get() = operations.mapNotNull(LedgerOperation<P>::deadline).minOrNull()

    /** 等待中的操作里，已经可以写入通道的：前置操作都已完成，且同组没有更早的等待者。 */
    fun ready(): List<LedgerOperation<P>> {
        val blocked = mutableSetOf<String>()
        val result = mutableListOf<LedgerOperation<P>>()
        for (op in operations) {
            if (op.phase != LedgerPhase.Waiting) continue
            if (op.group != null && op.group in blocked) continue
            if (op.prerequisites.isEmpty()) result += op
            op.group?.let(blocked::add)
        }
        return result
    }

    // ---- 创建与写入 ----

    /** 创建一条操作。`written` 表示调用方已经把它写入通道；否则它处于 `Waiting`。 */
    fun create(
        opId: String, kind: String, target: String, group: String? = null, conflicts: Boolean = true,
        policy: LedgerPolicy, basis: Map<String, Int>, prerequisites: Set<String> = emptySet(), payload: P,
        written: Boolean, now: Long,
    ): Pair<OperationLedger<P>, LedgerCreation<P>> {
        if (operation(opId) != null) return this to LedgerCreation.Duplicate()
        if (conflicts) operations.firstOrNull { it.conflicts && it.target == target && !it.phase.isSettled }
            ?.let { return this to LedgerCreation.Conflict(it) }
        if (operations.count { !it.phase.isSettled } >= capacity) return this to LedgerCreation.Full()
        var op = LedgerOperation(opId, kind, target, group, conflicts, policy, basis, now, payload, prerequisites, LedgerPhase.Waiting)
        if (written) op = op.written(connection, readCounter, now)
        return copy(operations = operations + op) to LedgerCreation.Created()
    }

    /** 调用方已把 `Waiting` 的操作写入通道；返回因此轮到写入的同组后一条。 */
    fun written(opId: String, now: Long): LedgerStep<P> = edit {
        update(opId) { if (it.phase == LedgerPhase.Waiting) it.written(connection, readCounter, now) else it }
    }

    /** 写入通道失败（本地未发送）：操作明确未执行。 */
    fun writeFailed(opId: String, reason: String): LedgerStep<P> = edit { reject(opId, LedgerRejection("not_sent", reason)) }

    /** 账本外的前置操作（例如附件上传）完成或失败。账本内的前置操作在结算时自动处理。 */
    fun prerequisite(id: String, succeeded: Boolean, reason: String): LedgerStep<P> = edit {
        for (op in before) {
            if (op.phase != LedgerPhase.Waiting || id !in op.prerequisites) continue
            if (succeeded) update(op.opId) { it.copy(prerequisites = it.prerequisites - id) }
            else reject(op.opId, LedgerRejection("prerequisite", reason))
        }
    }

    // ---- 回执 ----

    /**
     * 同一 opId 的回执，`connection` 是收到它的连接代次。opId 不复用，回执描述的就是这次操作的真实结果，
     * 所以重连后才处理到的、或 Host 在新连接上重放的回执照常生效；只丢弃不可能的来源：
     * 早于写入它的连接，或晚于当前连接（L1）。
     */
    fun receipt(opId: String, connection: Int, receipt: LedgerReceipt, now: Long): LedgerStep<P> = edit {
        val op = find(opId) ?: return@edit
        val written = op.connection ?: return@edit
        if (connection < written || connection > this.connection) return@edit
        apply(receipt, op, now)
    }

    // ---- 连接与读取 ----

    /** 连接断开：所有已写入通道、尚未结算的操作统一转为结果不明（L4）。等待中的不变。 */
    fun connectionLost(): LedgerStep<P> = edit { lose() }

    /** 建立了新的加密连接，`connection` 随之加一。旧连接上仍未结算的操作一律结果不明，并在这条连接上重新核对（L4、L5）。 */
    fun connected(): LedgerStep<P> = edit {
        lose()
        connection += 1
        for (op in list.toList()) {
            if (op.phase != LedgerPhase.Unknown && op.phase != LedgerPhase.Unconfirmed) continue
            update(op.opId) { it.copy(authorityChecked = false, receiptChecked = !it.policy.deviceReceipts) }
        }
    }

    /** 发起一次权威读取；回复带着这个序号交回账本。 */
    fun beginRead(): Pair<OperationLedger<P>, Int> = (readCounter + 1).let { copy(readCounter = it) to it }

    /** 一次权威状态已经应用。`evidence` 按种类判定这份状态对操作说明了什么。 */
    fun authority(stamp: LedgerStamp, evidence: (LedgerOperation<P>) -> LedgerEvidence): LedgerStep<P> = edit {
        for (id in before.map(LedgerOperation<P>::opId)) {
            val op = find(id) ?: continue
            val basis = op.basis[stamp.domain] ?: continue
            if (stamp.seq <= basis) continue
            if (op.phase == LedgerPhase.Waiting || op.phase.isSettled) continue
            when (evidence(op)) {
                LedgerEvidence.LANDED -> { land(id); continue }
                LedgerEvidence.NOT_APPLIED -> if (causal(stamp, op) && (op.phase == LedgerPhase.Sent || op.phase == LedgerPhase.Accepted)) {
                    reject(id, LedgerRejection("not_applied", "")); continue
                }
                LedgerEvidence.NONE -> Unit
            }
            if ((op.phase == LedgerPhase.Unknown || op.phase == LedgerPhase.Unconfirmed) && stamp.complete && verifies(stamp, op)) {
                update(id) { it.copy(authorityChecked = true) }
                resolve(id)
            }
        }
    }

    /** 新连接上读到的设备私有回执（`DeviceView.operations`）。查不到不代表没发生（会按最旧淘汰）。 */
    fun deviceReceipts(receipts: Map<String, LedgerReceipt>, connection: Int, now: Long): LedgerStep<P> = edit {
        if (connection != this.connection) return@edit
        for (id in before.map(LedgerOperation<P>::opId)) {
            val op = find(id) ?: continue
            if ((op.phase != LedgerPhase.Unknown && op.phase != LedgerPhase.Unconfirmed) || !op.policy.deviceReceipts) continue
            update(id) { it.copy(receiptChecked = true) }
            val receipt = receipts[id]
            if (receipt == null) { resolve(id); continue }
            // 设备回执说明 Host 确实收到了：把这次操作接到当前连接上继续等结果。
            update(id) { it.copy(connection = connection) }
            if (receipt == LedgerReceipt.Accepted) {
                update(id) { it.copy(phase = LedgerPhase.Accepted, deadline = it.policy.acceptedBudgetMs?.let { budget -> now + budget }) }
            } else {
                find(id)?.let { apply(receipt, it, now) }
            }
        }
    }

    // ---- 作用域、时钟与用户操作 ----

    /** 目标或作用域已不存在（换电脑、取消配对、会话被替换）：直接删除，不提示（L7）。 */
    fun expire(predicate: (LedgerOperation<P>) -> Boolean): LedgerStep<P> = edit {
        val gone = list.filter(predicate)
        val ids = gone.map(LedgerOperation<P>::opId).toSet()
        list.removeAll { it.opId in ids }
        gone.forEach { events += LedgerEvent.Expired(it) }
        gone.forEach { dependentsFailed(it.opId, L10n.tr("前置操作已失效")) }
    }

    /** 期限到期：已写入但没有最终结果的操作转为结果不明并要求核对；成功后的种类期限按策略处理（L8）。 */
    fun tick(now: Long): LedgerStep<P> = edit {
        for (id in before.map(LedgerOperation<P>::opId)) {
            val op = find(id) ?: continue
            val deadline = op.deadline ?: continue
            if (deadline > now) continue
            when {
                op.phase == LedgerPhase.Accepted && op.succeeded && op.policy.afterSuccessMs != null ->
                    when (val outcome = op.policy.afterSuccess) {
                        is LedgerTimeout.Reject -> reject(id, outcome.rejection)
                        LedgerTimeout.Unknown -> toUnknown(id)
                    }
                op.phase == LedgerPhase.Sent || op.phase == LedgerPhase.Accepted -> toUnknown(id)
                else -> update(id) { it.copy(deadline = null) }
            }
        }
    }

    /** 用户处理了已拒绝或未确认的操作（删除、放回输入框、重新发送会生成新操作）。 */
    fun remove(opId: String): OperationLedger<P> = copy(operations = operations.filterNot { it.opId == opId })

    // ---- 内部转移 ----

    private inline fun edit(block: Editor<P>.() -> Unit): LedgerStep<P> {
        val editor = Editor(this)
        editor.block()
        // 每次公开调用只在结束时报告一次新变为可写入的操作（例如前一条落地、被拒绝或已写入），避免重复写入。
        editor.readyEvents(editor.before)
        return LedgerStep(copy(operations = editor.list.toList(), connection = editor.connection), editor.events.toList())
    }

    private class Editor<P>(ledger: OperationLedger<P>) {
        val before: List<LedgerOperation<P>> = ledger.operations
        val list = ledger.operations.toMutableList()
        var connection = ledger.connection
        val readCounter = ledger.readCounter
        val events = mutableListOf<LedgerEvent<P>>()

        fun find(opId: String) = list.firstOrNull { it.opId == opId }

        fun update(opId: String, change: (LedgerOperation<P>) -> LedgerOperation<P>) {
            val index = list.indexOfFirst { it.opId == opId }
            if (index >= 0) list[index] = change(list[index])
        }

        fun ready(operations: List<LedgerOperation<P>>) = OperationLedger(operations).ready()

        /** 只报告这次变化后新变为可写入的操作，避免重复写入。 */
        fun readyEvents(previous: List<LedgerOperation<P>>) {
            val wasReady = ready(previous).map(LedgerOperation<P>::opId).toSet()
            ready(list).filter { it.opId !in wasReady }.forEach { events += LedgerEvent.Ready(it) }
        }

        fun apply(receipt: LedgerReceipt, op: LedgerOperation<P>, now: Long) {
            if (op.phase == LedgerPhase.Waiting || op.phase.isSettled) return
            when (receipt) {
                LedgerReceipt.Accepted -> update(op.opId) {
                    // pending 不覆盖更具体的结果（L2）。
                    if (it.succeeded) it else it.copy(phase = LedgerPhase.Accepted, deadline = it.policy.acceptedBudgetMs?.let { budget -> now + budget })
                }
                LedgerReceipt.Succeeded -> if (op.policy.successLands) land(op.opId) else update(op.opId) {
                    it.copy(phase = LedgerPhase.Accepted, succeeded = true,
                        settledRead = it.settledRead?.let { read -> minOf(read, readCounter) } ?: readCounter,
                        deadline = it.policy.afterSuccessMs?.let { delay -> now + delay })
                }
                is LedgerReceipt.Failed -> reject(op.opId, receipt.rejection)
                LedgerReceipt.Uncertain -> toUnknown(op.opId)
            }
        }

        fun lose() {
            list.filter { it.phase == LedgerPhase.Sent || it.phase == LedgerPhase.Accepted }.forEach { toUnknown(it.opId) }
        }

        fun toUnknown(opId: String) {
            val op = find(opId) ?: return
            if (op.phase != LedgerPhase.Sent && op.phase != LedgerPhase.Accepted) return
            // 之后主动发起的读取才算核对（L5）。
            update(opId) { it.copy(phase = LedgerPhase.Unknown, deadline = null, authorityChecked = false,
                receiptChecked = !it.policy.deviceReceipts, settledRead = readCounter) }
            find(opId)?.let { events += LedgerEvent.Unknown(it); events += LedgerEvent.Verify(it) }
        }

        fun resolve(opId: String) {
            val op = find(opId) ?: return
            if (op.phase != LedgerPhase.Unknown || !op.authorityChecked || !op.receiptChecked) return
            when (val rule = op.policy.whenUnresolved) {
                is LedgerTimeout.Reject -> reject(opId, rule.rejection)
                LedgerTimeout.Unknown -> {
                    update(opId) { it.copy(phase = LedgerPhase.Unconfirmed) }
                    find(opId)?.let { events += LedgerEvent.Unconfirmed(it) }
                }
            }
        }

        fun land(opId: String) {
            val op = find(opId) ?: return
            list.removeAll { it.opId == opId }
            for (waiting in list.toList()) {
                if (waiting.phase == LedgerPhase.Waiting && opId in waiting.prerequisites) {
                    update(waiting.opId) { it.copy(prerequisites = it.prerequisites - opId) }
                }
            }
            events += LedgerEvent.Landed(op)
        }

        fun reject(opId: String, rejection: LedgerRejection) {
            val op = find(opId) ?: return
            if (op.phase.isSettled) return
            update(opId) { it.copy(phase = LedgerPhase.Rejected(rejection), deadline = null) }
            find(opId)?.let { events += LedgerEvent.Rejected(it) }
            dependentsFailed(opId, rejection.reason)
        }

        fun dependentsFailed(opId: String, reason: String) {
            list.filter { it.phase == LedgerPhase.Waiting && opId in it.prerequisites }
                .forEach { reject(it.opId, LedgerRejection("prerequisite", reason)) }
        }

        fun causal(stamp: LedgerStamp, op: LedgerOperation<P>): Boolean {
            if (!stamp.complete) return false
            val written = op.connection
            if (written != null && stamp.connection > written) return true
            val read = stamp.read; val settled = op.settledRead
            return read != null && settled != null && read > settled
        }

        /** 结果不明后的核对只认因果晚于操作的完整状态：新连接上的快照，或期限到期后主动发起的读取。 */
        fun verifies(stamp: LedgerStamp, op: LedgerOperation<P>): Boolean = causal(stamp, op)
    }
}

/** 写入通道时登记一次读取序号：同步生效的种类，之后发起的读取已能反映结果。 */
private fun <P> LedgerOperation<P>.written(connection: Int, reads: Int, now: Long) = copy(
    phase = LedgerPhase.Sent, connection = connection,
    settledRead = if (policy.appliesBeforeLaterReads) reads else null,
    deadline = now + LEDGER_RECEIPT_BUDGET_MS,
)
