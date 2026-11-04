import Foundation

/// ADR-0049 §7：客户端操作账本。所有乐观操作都记在这里，阶段、断线、期限、作用域和冲突只在这里实现一次。
///
/// 账本是纯值类型：不发送、不读取、不计时。`HostConnection` 负责写入通道、发起读取和驱动时钟，
/// 再把回执、权威状态和本机事件作为输入交给账本；账本返回新状态和事件。界面 = 权威状态叠加账本中的操作，
/// 删除一条操作，界面就回到权威状态（L3）。账本从不修改权威状态或缓存。
struct OperationLedger<Payload: Equatable>: Equatable {
    struct Rejection: Equatable {
        let code: String
        let reason: String
        init(_ code: String, _ reason: String) { self.code = code; self.reason = reason }
    }

    enum Phase: Equatable {
        /// 已在本机创建，尚未写入通道（等前置操作或同组的前一条）。
        case waiting
        /// 已写入加密通道。
        case sent
        /// Host 已受理，尚无最终结果。
        case accepted
        /// 可能已执行，结果未知；等核对（L5）。
        case unknown
        /// 核对后仍无证据（ADR-0055 P12）：保持可见并提供核对入口，之后出现落地证据仍会落地。
        case unconfirmed
        /// 明确未执行，或种类的“结果不明”规则判定未生效。
        case rejected(Rejection)

        var isSettled: Bool { if case .rejected = self { return true }; return false }
    }

    /// 种类策略（§7.5）。每种操作只声明这些，其余全部由账本处理。
    struct Policy: Equatable {
        enum Timeout: Equatable { case unknown, reject(Rejection) }
        /// 成功回执即落地（例如回答、撤回）；否则成功回执只表示受理，仍等权威状态。
        var successLands = false
        /// 受理（pending）后多久仍无最终结果就转为结果不明；nil 表示一直等落地证据（例如排队中的消息）。
        var acceptedBudget: TimeInterval? = OperationLedger.receiptBudget
        /// 成功回执后多久仍无落地证据，以及到期结果；nil 表示一直等（例如首页关闭为 15 秒后恢复）。
        var afterSuccess: (seconds: TimeInterval, outcome: Timeout)?
        /// 结果不明且核对后仍无证据：拒绝（列表类恢复原状）或保持未确认（内容类）。
        var whenUnresolved: Timeout = .unknown
        /// Host 会为它写设备私有回执 `DeviceView.operations`（§7.6）。
        var deviceReceipts = true
        /// Host 处理请求时同步生效，之后发起的读取已能反映结果（例如关闭通知）。
        var appliesBeforeLaterReads = false

        static func == (lhs: Policy, rhs: Policy) -> Bool {
            lhs.successLands == rhs.successLands && lhs.acceptedBudget == rhs.acceptedBudget
                && lhs.afterSuccess?.seconds == rhs.afterSuccess?.seconds && lhs.afterSuccess?.outcome == rhs.afterSuccess?.outcome
                && lhs.whenUnresolved == rhs.whenUnresolved && lhs.deviceReceipts == rhs.deviceReceipts
                && lhs.appliesBeforeLaterReads == rhs.appliesBeforeLaterReads
        }
    }

    struct Operation: Equatable {
        /// 幂等键：commandId 或 requestId。一个 opId 只代表一次用户意图。
        let opId: String
        let kind: String
        /// 目标键：同一目标同时只有一个未结算的冲突操作（L9）。
        let target: String
        /// 顺序组：同组按创建顺序写入通道，后创建的不越过仍在等待的前一条（L9）。
        let group: String?
        let conflicts: Bool
        let policy: Policy
        /// 创建时已应用的权威序号，按领域记录；只有更新的权威状态才能作为证据（L2）。
        let basis: [String: Int]
        let createdAt: Date
        var payload: Payload
        var prerequisites: Set<String>
        var phase: Phase
        /// 写入通道时的连接代次。
        var connection: Int?
        /// Host 处理完这次操作时（同步生效的种类为写入时）的读取序号；之后发起的读取才能作为反向证据（L2）。
        var settledRead: Int?
        var deadline: Date?
        var succeeded = false
        /// 结果不明后：已用因果晚于操作的完整权威状态核对过。
        var authorityChecked = false
        /// 结果不明后：已读过设备私有回执，或该种类没有设备回执。
        var receiptChecked = false
        var detail: String?
    }

    enum Event: Equatable {
        case landed(Operation)
        case rejected(Operation)
        case unknown(Operation)
        case unconfirmed(Operation)
        case expired(Operation)
        /// 前置操作已完成，轮到它写入通道。
        case ready(Operation)
        /// 结果不明，需要账本的使用者主动发起一次读取（L5）。
        case verify(Operation)
    }

    enum Receipt: Equatable {
        /// `ok = true` 且 `pending`。
        case accepted
        /// 最终成功。
        case succeeded
        /// 明确失败，未执行。
        case failed(Rejection)
        /// 客户端合成的 cancelled / unconfirmed：可能已执行。
        case uncertain
    }

    /// 调用方按种类判定的证据：权威状态已体现结果、明确没有体现，或无从判断。
    enum Evidence: Equatable { case landed, notApplied, none }

    /// 一次已应用的权威状态的来源。
    struct Stamp: Equatable {
        let domain: String
        /// 本机按领域递增的已应用序号。
        let seq: Int
        let connection: Int
        /// 这是哪次读取的回复；推送来的更新为 nil。
        let read: Int?
        /// 完整快照；部分结果不能作为反向证据。
        let complete: Bool
    }

    enum Creation: Equatable { case created, duplicate, conflict(Operation), full }

    static var receiptBudget: TimeInterval { 60 }

    private(set) var operations: [Operation] = []
    private(set) var connection = 0
    private(set) var readCounter = 0
    let capacity: Int

    init(capacity: Int = 256) { self.capacity = capacity }

    func operation(_ opId: String) -> Operation? { operations.first { $0.opId == opId } }
    func active(target: String) -> Operation? { operations.first { $0.target == target && !$0.phase.isSettled } }
    func operations(kind: String) -> [Operation] { operations.filter { $0.kind == kind } }
    /// 这个组里有还没写入通道的操作：新操作必须排在它后面。
    func blocks(group: String) -> Bool { operations.contains { $0.group == group && $0.phase == .waiting } }
    var nextDeadline: Date? { operations.compactMap(\.deadline).min() }

    // MARK: - 创建与写入

    /// 创建一条操作。`written` 表示调用方已经把它写入通道；否则它处于 `waiting`。
    mutating func create(opId: String, kind: String, target: String, group: String? = nil, conflicts: Bool = true,
                         policy: Policy, basis: [String: Int], prerequisites: Set<String> = [], payload: Payload,
                         written: Bool, now: Date) -> Creation {
        if operation(opId) != nil { return .duplicate }
        if conflicts, let existing = operations.first(where: { $0.conflicts && $0.target == target && !$0.phase.isSettled }) {
            return .conflict(existing)
        }
        if operations.filter({ !$0.phase.isSettled }).count >= capacity { return .full }
        var op = Operation(opId: opId, kind: kind, target: target, group: group, conflicts: conflicts, policy: policy, basis: basis,
                           createdAt: now, payload: payload, prerequisites: prerequisites, phase: .waiting)
        if written { Self.markWritten(&op, connection: connection, reads: readCounter, now: now) }
        operations.append(op)
        return .created
    }

    /// 调用方已把 `waiting` 的操作写入通道；返回因此轮到写入的同组后一条。
    @discardableResult
    mutating func written(_ opId: String, now: Date) -> [Event] {
        step { ledger in
            let (current, reads) = (ledger.connection, ledger.readCounter)
            ledger.update(opId) { op in
                guard op.phase == .waiting else { return }
                Self.markWritten(&op, connection: current, reads: reads, now: now)
            }
            return []
        }
    }

    /// 写入通道失败（本地未发送）：操作明确未执行。
    mutating func writeFailed(_ opId: String, reason: String) -> [Event] {
        step { $0.reject(opId, Rejection("not_sent", reason)) }
    }

    /// 写入通道时登记一次读取序号：同步生效的种类，之后发起的读取已能反映结果。
    private static func markWritten(_ op: inout Operation, connection: Int, reads: Int, now: Date) {
        op.phase = .sent; op.connection = connection
        op.settledRead = op.policy.appliesBeforeLaterReads ? reads : nil
        op.deadline = now.addingTimeInterval(Self.receiptBudget)
    }

    /// 等待中的操作里，已经可以写入通道的：前置操作都已完成，且同组没有更早的等待者。
    func ready() -> [Operation] {
        var blockedGroups: Set<String> = []
        var result: [Operation] = []
        for op in operations where op.phase == .waiting {
            if let group = op.group, blockedGroups.contains(group) { continue }
            if op.prerequisites.isEmpty { result.append(op) }
            if let group = op.group { blockedGroups.insert(group) }
        }
        return result
    }

    /// 账本外的前置操作（例如附件上传）完成或失败。账本内的前置操作在结算时自动处理。
    mutating func prerequisite(_ id: String, succeeded: Bool, reason: String) -> [Event] {
        step { ledger in
            var events: [Event] = []
            for op in ledger.operations where op.phase == .waiting && op.prerequisites.contains(id) {
                if succeeded { ledger.update(op.opId) { $0.prerequisites.remove(id) } }
                else { events += ledger.reject(op.opId, Rejection("prerequisite", reason)) }
            }
            return events
        }
    }

    // MARK: - 回执

    /// 同一 opId 的回执，`connection` 是收到它的连接代次。opId 不复用，回执描述的就是这次操作的真实结果，
    /// 所以重连后才处理到的、或 Host 在新连接上重放的回执照常生效；只丢弃不可能的来源：
    /// 早于写入它的连接，或晚于当前连接（L1）。
    mutating func receipt(_ opId: String, connection: Int, _ receipt: Receipt, now: Date) -> [Event] {
        guard let op = operation(opId), let written = op.connection, connection >= written, connection <= self.connection else { return [] }
        return step { $0.apply(receipt, to: op, now: now) }
    }

    private mutating func apply(_ receipt: Receipt, to op: Operation, now: Date) -> [Event] {
        switch op.phase {
        case .waiting, .rejected: return []
        case .sent, .accepted, .unknown, .unconfirmed: break
        }
        switch receipt {
        case .accepted:
            guard op.phase != .accepted || op.succeeded == false else { return [] }
            update(op.opId) { op in
                if op.succeeded { return } // pending 不覆盖更具体的结果（L2）
                op.phase = .accepted
                op.deadline = op.policy.acceptedBudget.map { now.addingTimeInterval($0) }
            }
            return []
        case .succeeded:
            if op.policy.successLands { return land(op.opId) }
            let reads = readCounter
            update(op.opId) { op in
                op.phase = .accepted; op.succeeded = true
                op.settledRead = op.settledRead.map { min($0, reads) } ?? reads
                op.deadline = op.policy.afterSuccess.map { now.addingTimeInterval($0.seconds) }
            }
            return []
        case .failed(let rejection):
            return reject(op.opId, rejection)
        case .uncertain:
            return toUnknown(op.opId)
        }
    }

    // MARK: - 连接与读取

    /// 连接断开：所有已写入通道、尚未结算的操作统一转为结果不明（L4）。等待中的不变。
    mutating func connectionLost() -> [Event] {
        step { ledger in ledger.operations.filter { $0.phase == .sent || $0.phase == .accepted }.flatMap { ledger.toUnknown($0.opId) } }
    }

    /// 建立了新的加密连接，`connection` 随之加一。旧连接上仍未结算的操作一律结果不明，
    /// 并在这条连接上重新核对（L4、L5）。
    mutating func connected() -> [Event] {
        let events = connectionLost()
        connection += 1
        for op in operations where op.phase == .unknown || op.phase == .unconfirmed {
            update(op.opId) { $0.authorityChecked = false; $0.receiptChecked = !$0.policy.deviceReceipts }
        }
        return events
    }

    /// 发起一次权威读取；回复带着这个序号交回账本。
    mutating func beginRead() -> Int { readCounter += 1; return readCounter }

    /// 一次权威状态已经应用。`evidence` 按种类判定这份状态对操作说明了什么。
    mutating func authority(_ stamp: Stamp, evidence: (Operation) -> Evidence) -> [Event] {
        step { $0.authorityImpl(stamp, evidence: evidence) }
    }

    private mutating func authorityImpl(_ stamp: Stamp, evidence: (Operation) -> Evidence) -> [Event] {
        var events: [Event] = []
        for id in operations.map(\.opId) {
            guard let op = operation(id), let basis = op.basis[stamp.domain], stamp.seq > basis else { continue }
            switch op.phase {
            case .waiting, .rejected: continue
            case .sent, .accepted, .unknown, .unconfirmed: break
            }
            switch evidence(op) {
            case .landed:
                events += land(op.opId)
                continue
            case .notApplied where causal(stamp, after: op):
                if op.phase == .sent || op.phase == .accepted {
                    events += reject(op.opId, Rejection("not_applied", ""))
                    continue
                }
            case .notApplied, .none: break
            }
            if (op.phase == .unknown || op.phase == .unconfirmed), stamp.complete, verifies(stamp, op) {
                update(op.opId) { $0.authorityChecked = true }
                events += resolve(op.opId)
            }
        }
        return events
    }

    /// 新连接上读到的设备私有回执（`DeviceView.operations`）。查不到不代表没发生（会按最旧淘汰）。
    mutating func deviceReceipts(_ receipts: [String: Receipt], connection: Int, now: Date) -> [Event] {
        step { $0.deviceReceiptsImpl(receipts, connection: connection, now: now) }
    }

    private mutating func deviceReceiptsImpl(_ receipts: [String: Receipt], connection: Int, now: Date) -> [Event] {
        guard connection == self.connection else { return [] }
        var events: [Event] = []
        for id in operations.map(\.opId) {
            guard let op = operation(id), op.phase == .unknown || op.phase == .unconfirmed, op.policy.deviceReceipts else { continue }
            update(op.opId) { $0.receiptChecked = true }
            if let receipt = receipts[op.opId] {
                // 设备回执说明 Host 确实收到了：把这次操作接到当前连接上继续等结果。
                update(op.opId) { $0.connection = connection }
                if receipt == .accepted {
                    update(op.opId) { op in
                        op.phase = .accepted
                        op.deadline = op.policy.acceptedBudget.map { now.addingTimeInterval($0) }
                    }
                    continue
                }
                if let current = operation(op.opId) { events += apply(receipt, to: current, now: now) }
                continue
            }
            events += resolve(op.opId)
        }
        return events
    }

    // MARK: - 作用域、时钟与用户操作

    /// 目标或作用域已不存在（换电脑、取消配对、会话被替换）：直接删除，不提示（L7）。
    mutating func expire(where predicate: (Operation) -> Bool) -> [Event] {
        let gone = operations.filter(predicate)
        let goneIds = Set(gone.map(\.opId))
        return step { ledger in
            ledger.operations.removeAll { goneIds.contains($0.opId) }
            return gone.map(Event.expired) + gone.flatMap { ledger.dependentsFailed(on: $0.opId, reason: L10n.tr("前置操作已失效")) }
        }
    }

    /// 期限到期：已写入但没有最终结果的操作转为结果不明并要求核对；成功后的种类期限按策略处理（L8）。
    mutating func tick(now: Date) -> [Event] {
        step { $0.tickImpl(now: now) }
    }

    private mutating func tickImpl(now: Date) -> [Event] {
        var events: [Event] = []
        for id in operations.map(\.opId) {
            guard let op = operation(id), let deadline = op.deadline, deadline <= now else { continue }
            if op.phase == .accepted, op.succeeded, let after = op.policy.afterSuccess {
                switch after.outcome {
                case .reject(let rejection): events += reject(op.opId, rejection)
                case .unknown: events += toUnknown(op.opId)
                }
            } else if op.phase == .sent || op.phase == .accepted {
                events += toUnknown(op.opId)
            } else {
                update(op.opId) { $0.deadline = nil }
            }
        }
        return events
    }

    /// 用户处理了已拒绝或未确认的操作（删除、放回输入框、重新发送会生成新操作）。
    mutating func remove(_ opId: String) {
        operations.removeAll { $0.opId == opId }
    }

    // MARK: - 内部转移

    private func causal(_ stamp: Stamp, after op: Operation) -> Bool {
        guard stamp.complete else { return false }
        if let connection = op.connection, stamp.connection > connection { return true }
        if let read = stamp.read, let settled = op.settledRead, read > settled { return true }
        return false
    }

    /// 结果不明后的核对只认因果晚于操作的完整状态：新连接上的快照，或期限到期后主动发起的读取。
    private func verifies(_ stamp: Stamp, _ op: Operation) -> Bool {
        if let connection = op.connection, stamp.connection > connection { return true }
        if let read = stamp.read, let verifyRead = op.settledRead, read > verifyRead { return true }
        return false
    }

    private mutating func toUnknown(_ opId: String) -> [Event] {
        guard let op = operation(opId), op.phase == .sent || op.phase == .accepted else { return [] }
        let reads = readCounter
        update(opId) { op in
            op.phase = .unknown; op.deadline = nil
            op.authorityChecked = false; op.receiptChecked = !op.policy.deviceReceipts
            // 之后主动发起的读取才算核对（L5）。
            op.settledRead = reads
        }
        return [.unknown(operation(opId)!), .verify(operation(opId)!)]
    }

    private mutating func resolve(_ opId: String) -> [Event] {
        guard let op = operation(opId), op.phase == .unknown, op.authorityChecked, op.receiptChecked else { return [] }
        switch op.policy.whenUnresolved {
        case .reject(let rejection): return reject(opId, rejection)
        case .unknown:
            update(opId) { $0.phase = .unconfirmed }
            return [.unconfirmed(operation(opId)!)]
        }
    }

    private mutating func land(_ opId: String) -> [Event] {
        guard let op = operation(opId) else { return [] }
        operations.removeAll { $0.opId == opId }
        for waiting in operations where waiting.phase == .waiting && waiting.prerequisites.contains(opId) {
            update(waiting.opId) { $0.prerequisites.remove(opId) }
        }
        return [.landed(op)]
    }

    private mutating func reject(_ opId: String, _ rejection: Rejection) -> [Event] {
        guard let op = operation(opId), !op.phase.isSettled else { return [] }
        update(opId) { op in op.phase = .rejected(rejection); op.deadline = nil }
        return [.rejected(operation(opId)!)] + dependentsFailed(on: opId, reason: rejection.reason)
    }

    private mutating func dependentsFailed(on opId: String, reason: String) -> [Event] {
        operations.filter { $0.phase == .waiting && $0.prerequisites.contains(opId) }
            .flatMap { reject($0.opId, Rejection("prerequisite", reason)) }
    }

    /// 每次公开调用只在结束时报告一次新变为可写入的操作（例如前一条落地、被拒绝或已写入），避免重复写入。
    private mutating func step(_ body: (inout Self) -> [Event]) -> [Event] {
        let before = operations
        let events = body(&self)
        return events + readyEvents(before: before)
    }

    private func readyEvents(before: [Operation]) -> [Event] {
        var previous = self; previous.operations = before
        let wasReady = Set(previous.ready().map(\.opId))
        return ready().filter { !wasReady.contains($0.opId) }.map(Event.ready)
    }

    private mutating func update(_ opId: String, _ change: (inout Operation) -> Void) {
        guard let index = operations.firstIndex(where: { $0.opId == opId }) else { return }
        change(&operations[index])
    }
}
