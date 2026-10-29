import Foundation

enum SessionReadPhase: String {
    case queued, local, remote, waiting, succeeded, endReached, failed, cancelled, superseded
    var active: Bool { [.queued, .local, .remote, .waiting].contains(self) }
}
enum SessionReadKind: String { case firstPage, source, history, catchup }

/// A window and its source namespace, distinct from both connection and wire transaction IDs.
struct SessionReadOwner: Equatable {
    let hostKey: String
    let deviceId: String
    let historyKey: String
    let sessionId: String
    let branchGeneration: Int
    let cacheEpoch: String?
    let connectionGeneration: UUID
    var selected: Bool
}
struct SessionReadOperation: Identifiable {
    let id: String
    let kind: SessionReadKind
    let owner: SessionReadOwner
    let targetLeafId: String?
    let beforeEntryId: String?
    let demandGeneration: Int64
    let startedAt: Date
    var phase: SessionReadPhase
    var commandId: String?
    var lastCommandId: String?
    var error: String?
    var lastGap: SessionCatchupGap?
}
struct SessionReadAcceptance {
    let operationId: String?
    let merged: Bool
    let rejection: String?
    var accepted: Bool { operationId != nil }
}
struct SessionCatchupGap: Equatable {
    let knownLeafId: String?
    let targetLeafId: String
}
enum SessionReadEffect {
    case none
    case apply(SessionHistoryPage)
    case requestSource
    case requestHistory(before: String, target: String?)
    case requestCatchup(SessionCatchupGap)
}

/// Single writer for logical reads. IO reports committed pages and command.result reports no
/// completion fact. An old worker can never clear the phase or demand owned by its successor.
struct SessionReadOperations {
    private(set) var operations: [String: SessionReadOperation] = [:]
    private var order: [String] = []
    private(set) var demands: [String: Int64] = [:]
    private let activeLimit = 32
    private let completedLimit = 64

    func latest(historyKey: String, kind: SessionReadKind) -> SessionReadOperation? {
        order.reversed().compactMap { operations[$0] }.first { $0.owner.historyKey == historyKey && $0.kind == kind }
    }
    func owns(_ id: String, current: SessionReadOwner) -> Bool {
        guard let operation = operations[id], operation.phase.active else { return false }
        return ownerValid(operation, current: current)
    }
    private func ownerValid(_ operation: SessionReadOperation, current: SessionReadOwner) -> Bool {
        let owner = operation.owner
        guard owner.hostKey == current.hostKey, owner.deviceId == current.deviceId, owner.historyKey == current.historyKey,
              owner.sessionId == current.sessionId, owner.branchGeneration == current.branchGeneration else { return false }
        if operation.kind == .history || operation.kind == .catchup || operation.kind == .firstPage && owner.cacheEpoch != nil {
            guard owner.cacheEpoch == current.cacheEpoch else { return false }
        }
        if operation.kind == .history || operation.kind == .firstPage { guard current.selected else { return false } }
        if operation.phase == .remote || ([.source, .catchup].contains(operation.kind) && [.queued, .waiting].contains(operation.phase)) {
            guard owner.connectionGeneration == current.connectionGeneration else { return false }
        }
        return true
    }
    @discardableResult
    mutating func requestSource(historyKey: String) -> Int64 {
        let next = (demands[historyKey] ?? 0) + 1
        demands[historyKey] = next; return next
    }
    mutating func begin(kind: SessionReadKind, owner: SessionReadOwner, targetLeafId: String?, beforeEntryId: String? = nil,
                        id: String = UUID().uuidString, now: Date = Date()) -> SessionReadAcceptance {
        reconcile(owner)
        if let existing = latest(historyKey: owner.historyKey, kind: kind), existing.phase.active {
            return SessionReadAcceptance(operationId: existing.id, merged: true, rejection: nil)
        }
        guard !owner.sessionId.isEmpty, !owner.hostKey.isEmpty, operations.values.filter({ $0.phase.active }).count < activeLimit else {
            return SessionReadAcceptance(operationId: nil, merged: false, rejection: "会话读取归属无效或任务已满")
        }
        if kind == .history, beforeEntryId == nil { return SessionReadAcceptance(operationId: nil, merged: false, rejection: "历史首屏尚未就绪") }
        let operation = SessionReadOperation(id: id, kind: kind, owner: owner, targetLeafId: targetLeafId, beforeEntryId: beforeEntryId,
            demandGeneration: demands[owner.historyKey] ?? 0, startedAt: now,
            phase: kind == .history || kind == .firstPage ? .local : .queued)
        guard ownerValid(operation, current: owner), operations[id] == nil else { return SessionReadAcceptance(operationId: nil, merged: false, rejection: "读取归属已经失效") }
        operations[id] = operation; order.append(id); prune()
        return SessionReadAcceptance(operationId: id, merged: false, rejection: nil)
    }
    mutating func reconcile(_ current: SessionReadOwner) {
        for id in order {
            guard let operation = operations[id], operation.phase.active, operation.owner.historyKey == current.historyKey else { continue }
            if !ownerValid(operation, current: current) { finish(id, phase: .superseded) }
        }
    }
    mutating func bindRemote(_ id: String, commandId: String, current: SessionReadOwner) -> Bool {
        reconcile(current)
        guard owns(id, current: current), operations[id]?.phase != .remote else { return false }
        // A local read may survive reconnect, but its remote continuation must be registered
        // under a newly owned operation rather than silently inheriting the old connection.
        guard operations[id]?.owner.connectionGeneration == current.connectionGeneration else { finish(id, phase: .superseded); return false }
        operations[id]?.phase = .remote; operations[id]?.commandId = commandId; operations[id]?.lastCommandId = commandId; return true
    }
    mutating func localResult(_ id: String, page: SessionHistoryPage, current: SessionReadOwner) -> SessionReadEffect {
        reconcile(current)
        guard owns(id, current: current), operations[id]?.phase == .local, let operation = operations[id] else { return .none }
        guard page.graph.sessionId == operation.owner.sessionId, operation.owner.cacheEpoch == nil || page.graph.epoch == operation.owner.cacheEpoch else { finish(id, phase: .superseded); return .none }
        if page.status == .cycleDetected { finish(id, phase: .failed, error: "本地历史父节点形成循环"); return .none }
        if page.displayComplete && !page.entries.isEmpty {
            finish(id, phase: .succeeded); return .apply(page)
        }
        if page.complete && !page.hasOlder && page.entries.isEmpty && page.status == .complete {
            finish(id, phase: operation.kind == .history ? .endReached : .succeeded); return .apply(page)
        }
        operations[id]?.phase = .waiting
        if operation.kind == .history, let boundary = operation.beforeEntryId { return .requestHistory(before: boundary, target: operation.targetLeafId) }
        return .requestSource
    }
    mutating func committedRemoteResult(_ id: String, commandId: String, page: SessionHistoryPage,
                                        current: SessionReadOwner, sourceConfirmed: Bool = false) -> SessionReadEffect {
        reconcile(current)
        guard owns(id, current: current), let operation = operations[id], operation.phase == .remote, operation.commandId == commandId,
              page.graph.sessionId == operation.owner.sessionId else { return .none }
        if operation.kind == .source {
            guard sourceConfirmed else { operations[id]?.phase = .waiting; operations[id]?.commandId = nil; return .requestSource }
            finish(id, phase: .succeeded)
            if demands[operation.owner.historyKey] == operation.demandGeneration { demands[operation.owner.historyKey] = nil }
            return .apply(page)
        }
        if operation.kind == .catchup {
            guard let target = operation.targetLeafId else { finish(id, phase: .failed, error: "补齐目标缺失"); return .none }
            let gap = page.targetCovered ? nil : (page.coverageGap ?? sessionCatchupGap(in: page.graph, targetLeafId: target))
            if let gap {
                if operation.lastGap == gap { finish(id, phase: .failed, error: "补齐范围未推进，请重试"); return .none }
                operations[id]?.lastGap = gap; operations[id]?.phase = .waiting; operations[id]?.commandId = nil
                return .requestCatchup(gap)
            }
            finish(id, phase: .succeeded); return .apply(page)
        }
        guard page.displayComplete, page.status == .complete || page.status == .olderAvailable else { finish(id, phase: .failed, error: "历史范围或显示结果不完整"); return .none }
        if operation.kind == .history, page.entries.first?.entryId == operation.beforeEntryId { finish(id, phase: .failed, error: "历史范围未推进，请重试"); return .none }
        if page.entries.isEmpty && (!page.complete || page.hasOlder) { finish(id, phase: .failed, error: "历史范围未推进，请重试"); return .none }
        finish(id, phase: page.entries.isEmpty && operation.kind == .history ? .endReached : .succeeded)
        return .apply(page)
    }
    mutating func finish(_ id: String, phase: SessionReadPhase, error: String? = nil) {
        guard !phase.active, operations[id]?.phase.active == true else { return }
        operations[id]?.phase = phase; operations[id]?.error = error; operations[id]?.commandId = nil; prune()
    }
    mutating func cancelForeground(except historyKey: String? = nil) {
        for id in order where operations[id]?.owner.historyKey != historyKey && [.firstPage, .history].contains(operations[id]?.kind) { finish(id, phase: .cancelled) }
    }
    mutating func recoverLate(_ id: String, commandId: String, current: SessionReadOwner, newId: String = UUID().uuidString) -> String? {
        guard let old = operations[id], old.phase == .failed, old.lastCommandId == commandId, operations[newId] == nil,
              operations.values.filter({ $0.phase.active }).count < activeLimit, latest(historyKey: old.owner.historyKey, kind: old.kind)?.id == id,
              ownerValid(old, current: current), old.owner.connectionGeneration == current.connectionGeneration else { return nil }
        var recovery = SessionReadOperation(id: newId, kind: old.kind, owner: old.owner, targetLeafId: old.targetLeafId,
            beforeEntryId: old.beforeEntryId, demandGeneration: old.demandGeneration, startedAt: Date(), phase: .remote)
        recovery.commandId = commandId; recovery.lastCommandId = commandId
        operations[newId] = recovery; order.append(newId); prune(); return newId
    }
    private mutating func prune() {
        let completed = order.filter { operations[$0]?.phase.active == false }
        for id in completed.prefix(max(0, completed.count - completedLimit)) { operations[id] = nil }
        order.removeAll { operations[$0] == nil }
    }
}

/// The logical target remains fixed. A source request fills the first missing ancestor beneath
/// that target; neither this cache-only range nor its arrival is allowed to move the live head.
func sessionCatchupGap(in graph: CachedSessionGraph, targetLeafId: String) -> SessionCatchupGap? {
    var next: String? = targetLeafId, visited: Set<String> = []
    let excluded = Set(graph.windowStart.map { graph.path(to: $0).dropLast().map(\.entryId) } ?? [])
    while let id = next {
        guard visited.insert(id).inserted else { return SessionCatchupGap(knownLeafId: nil, targetLeafId: id) }
        guard let entry = graph.entries[id] else { return SessionCatchupGap(knownLeafId: nil, targetLeafId: id) }
        if graph.display[entry.entryId] == nil && !excluded.contains(entry.entryId) { return SessionCatchupGap(knownLeafId: entry.parentId, targetLeafId: id) }
        next = entry.parentId
    }
    return nil
}
