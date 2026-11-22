import Foundation
import Combine

struct RuntimeNoticeScope: Codable, Hashable {
    var turnId: String?
    var requestId: String?
    var operationId: String?
    var commandId: String?
}

struct RuntimeNotice: Codable, Hashable, Identifiable {
    let notificationId: String
    let producerEpoch: String
    let code: String
    let occurrenceId: String
    let scope: RuntimeNoticeScope
    let severity: String
    let message: String
    let lifecycle: String
    let createdAt: Int64
    let updatedAt: Int64
    let verification: String
    var displayMs: Int64?
    var expiresAt: Int64?
    var id: String { notificationId }

    fileprivate var valid: Bool {
        [notificationId, producerEpoch, code, occurrenceId].allSatisfy(RuntimeNotifications.validIdentifier) &&
        [scope.turnId, scope.requestId, scope.operationId, scope.commandId].compactMap { $0 }.allSatisfy(RuntimeNotifications.validIdentifier) &&
        !message.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && message.utf8.count <= 4096 &&
        createdAt >= 0 && updatedAt >= createdAt && expiresAt.map { $0 >= createdAt } != false &&
        displayMs.map { (1000...300_000).contains($0) } != false &&
        ["condition", "outcome"].contains(lifecycle) && ["info", "warning", "error"].contains(severity) &&
        ["confirmed", "unknown"].contains(verification) &&
        (lifecycle != "condition" || (expiresAt == nil && displayMs == nil))
    }
}

struct RuntimeNoticeProjection: Equatable {
    let hostEpoch: String
    let revision: Int64
    let sessionId: String?
    let verification: String
    let items: [RuntimeNotice]
    let complete: Bool
}

private struct RuntimeNoticeSnapshot: Decodable {
    let hostEpoch: String
    let runtimeId: String
    let sessionId: String?
    let revision: Int64
    let complete: Bool
    let verification: String
    let notifications: [RuntimeNotice]
    let removedNotificationIds: [String]
    enum CodingKeys: String, CodingKey { case hostEpoch, runtimeId, sessionId, revision, complete, verification, notifications, removedNotificationIds }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        hostEpoch = try c.decode(String.self, forKey: .hostEpoch); runtimeId = try c.decode(String.self, forKey: .runtimeId)
        sessionId = try c.decodeIfPresent(String.self, forKey: .sessionId); revision = try c.decode(Int64.self, forKey: .revision)
        complete = try c.decode(Bool.self, forKey: .complete); verification = try c.decode(String.self, forKey: .verification)
        notifications = try c.decode([RuntimeNotice].self, forKey: .notifications)
        removedNotificationIds = try c.decodeIfPresent([String].self, forKey: .removedNotificationIds) ?? []
    }
}

/// Host notification versions are independent of chat and transport sequence.
/// Conditions and outcomes remain Host-owned, including expiration and dismissals.
@MainActor
final class RuntimeNotifications: ObservableObject {
    @Published private(set) var projections: [String: RuntimeNoticeProjection] = [:]
    /// ADR-0049 §6.6：本设备已关闭、尚未结算的通知（键为 runtimeId + NUL + notificationId），由连接层按账本更新。
    @Published private(set) var hidden: Set<String> = []
    private(set) var receipts: [String: UInt64] = [:]
    var send: (([String: Any]) -> Bool)?
    private var hostKey: String?
    private var connected = false
    private var epoch: String?
    private var onlineIds: Set<String> = []
    private struct Session { let id: String? }
    private var sessions: [String: Session] = [:]
    private var jobs: [String: Task<Void, Never>] = [:]
    private var jobIds: [String: UUID] = [:]
    private let retryDelays: [UInt64]

    init(retryDelaysNanoseconds: [UInt64] = [1_000_000_000, 3_000_000_000]) {
        retryDelays = Array(retryDelaysNanoseconds.prefix(2))
    }

    nonisolated fileprivate static func validIdentifier(_ value: String) -> Bool {
        !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && value.utf16.count <= 256
    }

    func setConnection(_ pairing: HostPairing?, connected: Bool) {
        let key = pairing.map(FileTransfers.pairingKey)
        guard key != hostKey || self.connected != connected else { return }
        cancelReads()
        if key != hostKey { epoch = nil; sessions = [:]; onlineIds = []; projections = [:]; receipts = [:] }
        hostKey = key; self.connected = connected
    }

    /// Only the authenticated device.ready establishes or replaces the Host epoch.
    func ready(epoch: String?, runtimes: [RuntimeSummary]) {
        guard connected else { return }
        if let epoch, Self.validIdentifier(epoch), self.epoch != epoch { cancelReads(); self.epoch = epoch }
        onlineIds = Set(runtimes.map(\.runtimeId))
        for runtime in runtimes { sessions[runtime.runtimeId] = Session(id: runtime.sessionId) }
        for runtime in runtimes { sync(runtimeId: runtime.runtimeId) }
    }

    func online(_ runtime: RuntimeSummary) {
        guard connected else { return }
        onlineIds.insert(runtime.runtimeId); sessions[runtime.runtimeId] = Session(id: runtime.sessionId)
        sync(runtimeId: runtime.runtimeId)
    }

    func offline(runtimeId: String) {
        onlineIds.remove(runtimeId)
        // Keep the last Session binding: the Host can still send a terminal
        // notification inventory after removing the online Runtime directory row.
        jobs.removeValue(forKey: runtimeId)?.cancel(); jobIds[runtimeId] = nil
    }

    @discardableResult
    func consume(_ message: [String: Any]) -> Bool {
        guard message["type"] as? String == "notification.snapshot" else { return false }
        guard connected, message["protocolVersion"] as? Int == orbisProtocolVersion,
              let data = try? JSONSerialization.data(withJSONObject: message), data.count <= 256 * 1024,
              let snapshot = try? JSONDecoder().decode(RuntimeNoticeSnapshot.self, from: data),
              snapshot.hostEpoch == epoch, Self.validIdentifier(snapshot.hostEpoch), Self.validIdentifier(snapshot.runtimeId),
              snapshot.revision >= 0, snapshot.revision <= 9_007_199_254_740_991,
              snapshot.notifications.count <= 64, snapshot.removedNotificationIds.count <= 320,
              snapshot.removedNotificationIds.allSatisfy(Self.validIdentifier), snapshot.notifications.allSatisfy(\.valid),
              Set(snapshot.notifications.map(\.notificationId)).count == snapshot.notifications.count,
              !snapshot.notifications.contains(where: { snapshot.removedNotificationIds.contains($0.notificationId) }),
              ["confirmed", "unknown"].contains(snapshot.verification), let session = sessions[snapshot.runtimeId],
              snapshot.sessionId == session.id || (snapshot.sessionId == nil && snapshot.notifications.isEmpty) else { return true }
        let previous = projections[snapshot.runtimeId]
        if previous?.hostEpoch == snapshot.hostEpoch, let revision = previous?.revision, revision > snapshot.revision { return true }
        if previous == nil, projections.count >= 2048 {
            guard let retired = projections.keys.first(where: { !onlineIds.contains($0) }) else { return true }
            projections[retired] = nil; receipts[retired] = nil
        }
        receipts[snapshot.runtimeId] = (receipts[snapshot.runtimeId] ?? 0) &+ 1
        jobs.removeValue(forKey: snapshot.runtimeId)?.cancel(); jobIds[snapshot.runtimeId] = nil
        if previous?.hostEpoch == snapshot.hostEpoch, previous?.revision == snapshot.revision { return true }
        let items: [RuntimeNotice]
        if snapshot.complete { items = snapshot.notifications }
        else {
            // An unverified source inventory cannot add facts or imply recovery.
            // Explicit Host removal proofs still retire expired/dismissed outcomes.
            items = (previous?.sessionId == snapshot.sessionId ? previous?.items ?? [] : [])
                .filter { !snapshot.removedNotificationIds.contains($0.notificationId) }
        }
        projections[snapshot.runtimeId] = RuntimeNoticeProjection(hostEpoch: snapshot.hostEpoch, revision: snapshot.revision,
            sessionId: snapshot.sessionId, verification: snapshot.complete ? snapshot.verification : "unknown",
            items: items, complete: snapshot.complete)
        return true
    }

    func sync(runtimeId: String) {
        jobs.removeValue(forKey: runtimeId)?.cancel(); jobIds[runtimeId] = nil
        guard connected, let epoch, sessions[runtimeId] != nil, Self.validIdentifier(runtimeId) else { return }
        let receipt = receipts[runtimeId] ?? 0, id = UUID()
        jobIds[runtimeId] = id
        _ = send?(["type": "notification.sync", "protocolVersion": orbisProtocolVersion, "runtimeId": runtimeId])
        jobs[runtimeId] = Task { [weak self] in
            guard let self else { return }
            for pause in self.retryDelays {
                do { try await Task.sleep(nanoseconds: pause) } catch { return }
                guard self.connected, self.epoch == epoch, self.jobIds[runtimeId] == id,
                      self.receipts[runtimeId] ?? 0 == receipt else { return }
                _ = self.send?(["type": "notification.sync", "protocolVersion": orbisProtocolVersion, "runtimeId": runtimeId])
            }
            if self.jobIds[runtimeId] == id { self.jobIds[runtimeId] = nil; self.jobs[runtimeId] = nil }
        }
    }

    var hostEpoch: String? { epoch }

    func setHidden(_ keys: Set<String>) { if hidden != keys { hidden = keys } }

    /// 界面看到的清单：权威清单减去本设备正在关闭的通知（账本叠加，L3）。
    func visibleProjection(_ runtimeId: String) -> RuntimeNoticeProjection? {
        guard let projection = projections[runtimeId] else { return nil }
        guard !hidden.isEmpty else { return projection }
        let items = projection.items.filter { !hidden.contains(runtimeId + "\u{0}" + $0.notificationId) }
        guard items.count != projection.items.count else { return projection }
        return RuntimeNoticeProjection(hostEpoch: projection.hostEpoch, revision: projection.revision, sessionId: projection.sessionId,
                                       verification: projection.verification, items: items, complete: projection.complete)
    }

    /// 写入关闭并立即读取一次；返回关闭时的 Host 代次，未写入时为 nil。
    @discardableResult
    func dismiss(runtimeId: String, notificationId: String) -> String? {
        guard connected, let epoch, sessions[runtimeId] != nil, Self.validIdentifier(runtimeId), Self.validIdentifier(notificationId),
              send?(["type": "notification.dismiss", "protocolVersion": orbisProtocolVersion,
                     "runtimeId": runtimeId, "hostEpoch": epoch, "notificationId": notificationId]) == true else { return nil }
        sync(runtimeId: runtimeId)
        return epoch
    }

    private func cancelReads() {
        jobs.values.forEach { $0.cancel() }; jobs = [:]; jobIds = [:]
    }
}


/// Source snapshots seed activity; only an applied, advancing patch may complete
/// the same turn. Receipts survive a process restart and stay bounded per pairing.
final class ReplyCompletionTracker {
    private struct Identity: Codable, Hashable {
        let session: String
        let epoch: String
        let turn: String
        let startedAt: Int64
        var localTurn: ReplyNotificationCleanup.LocalTurn { .init(session: session, epoch: epoch, id: turn) }
    }
    private var active: [String: Identity] = [:]
    private var positions: [String: (epoch: String, seq: Int64)] = [:]
    private var receipts: [Identity]
    private var seen: Set<Identity>
    private(set) var completedTurnStarts: [ReplyNotificationCleanup.LocalTurn: Int64]
    private let preferences: UserDefaults?
    private let key: String
    init(preferences: UserDefaults? = nil, owner: String = "") {
        self.preferences = preferences
        key = "orbis.replyCompletionReceipts." + owner
        let stored = preferences?.data(forKey: key).flatMap { try? JSONDecoder().decode([Identity].self, from: $0) } ?? []
        let recent = Array(stored.suffix(512))
        receipts = recent; seen = Set(recent)
        completedTurnStarts = Dictionary(recent.map { ($0.localTurn, $0.startedAt) }, uniquingKeysWith: { _, newest in newest })
    }
    func resetActive() { active = [:]; positions = [:] }
    func consume(_ event: [String: Any], sessionId: String) -> Bool {
        guard let type = event["type"] as? String, ["session.snapshot", "session.patch"].contains(type), !sessionId.isEmpty,
              let source = event["source"] as? [String: Any], source["ready"] as? Bool == true,
              let epoch = source["epoch"] as? String, !epoch.isEmpty,
              let sequence = source["seq"] as? NSNumber, sequence.int64Value >= 0,
              let live = event["live"] as? [String: Any], live["complete"] as? Bool == true else { return false }
        let previous = positions[sessionId]
        if previous?.epoch != epoch { active[sessionId] = nil }
        else if sequence.int64Value <= previous!.seq { return false }
        positions[sessionId] = (epoch, sequence.int64Value)
        guard let turn = live["turn"] as? [String: Any],
              let turnId = turn["turnId"] as? String, !turnId.isEmpty, turnId.utf16.count <= 256,
              let startedAt = turn["startedAt"] as? NSNumber, startedAt.int64Value >= 0 else { active[sessionId] = nil; return false }
        let identity = Identity(session: sessionId, epoch: epoch, turn: turnId, startedAt: startedAt.int64Value)
        if turn["durationMs"] == nil && turn["outcome"] == nil { active[sessionId] = identity; return false }
        let observed = active.removeValue(forKey: sessionId)
        guard turn["outcome"] as? String == "completed", let duration = turn["durationMs"] as? NSNumber, duration.doubleValue >= 0 else { return false }
        let shouldNotify = type == "session.patch" && previous?.epoch == epoch && observed == identity && !seen.contains(identity)
        remember(identity)
        return shouldNotify
    }
    private func remember(_ identity: Identity) {
        guard seen.insert(identity).inserted else { return }
        receipts.append(identity)
        if receipts.count > 512 {
            let old = receipts.removeFirst(); seen.remove(old)
            if completedTurnStarts[old.localTurn] == old.startedAt { completedTurnStarts[old.localTurn] = nil }
        }
        completedTurnStarts[identity.localTurn] = identity.startedAt
        if let data = try? JSONEncoder().encode(receipts) { preferences?.set(data, forKey: key) }
    }
}

/// SC121 / APNS-L21: the Host's ready projection can contain a partial native
/// inventory (including after an explicit removal). Absence is authoritative
/// only after a full baseline from that same source. Keep it across a fresh
/// read, but do not use it until that read actually confirms the interactions.
struct NotificationApprovalInventory {
    var confirmedAt: Date?
    var pending: Set<String>
    var removed: Set<String>

    static func reconcile(_ domain: HostDomain, previous: HostDomain?, inventory: Self?, readAt: Date) -> Self? {
        guard domain.availability == "ready",
              let ids = domain.value.object.map({ Set($0.keys) }) ?? (domain.value == .null && domain.completeness == "complete" ? [] : nil) else { return nil }
        let sameSource = previous.map {
            $0.modelEpoch == domain.modelEpoch && $0.source.producer == domain.source.producer &&
            $0.source.sourceId == domain.source.sourceId && $0.source.sourceEpoch == domain.source.sourceEpoch
        } == true
        let baseline = sameSource ? inventory : nil
        guard domain.completeness == "complete" || (domain.completeness == "partial" && domain.projectionComplete == true && baseline != nil) else { return nil }
        var removed = (baseline?.removed ?? []).union((baseline?.pending ?? []).subtracting(ids)).subtracting(ids)
        if removed.count > 256 { removed = (baseline?.pending ?? []).subtracting(ids) }
        return Self(confirmedAt: readAt, pending: ids, removed: removed)
    }
}

enum ReplyNotificationCleanup {
    struct LocalTurn: Hashable, Sendable {
        let session: String
        let epoch: String
        let id: String
    }

    struct Alert: Sendable {
        let id: String
        let date: Date
        let thread: String
        let host: String?
        let category: String?
        let event: String?
        let pairing: String?
        let session: String?
        let localTurn: LocalTurn?

        init(id: String, date: Date, thread: String, remote: Bool, userInfo: [AnyHashable: Any]) {
            self.id = id; self.date = date; self.thread = thread
            let envelope = userInfo["orbis"] as? [String: Any]
            let target = remote && envelope == nil ? nil : PushNotificationOpenTarget(userInfo)
            // SC114 also recognizes the released flat local completion payload.
            let legacyLocal = !remote && userInfo["orbis"] == nil && target?.sessionId != nil
            let known = envelope != nil || legacyLocal
            host = known ? target?.hostId : nil
            category = known && target != nil ? (envelope?["category"] as? String ?? "task-completed") : nil
            event = remote ? envelope?["eventId"] as? String : nil
            pairing = remote ? nil : target?.pairingKey
            session = remote ? nil : target?.sessionId
            // The locally generated request identifier has carried the turn since
            // before APNs. Neither the APNs event digest nor the OS identifier is a session ID.
            if !remote, let host, let session, let data = Data(base64Encoded: id),
               let value = String(data: data, encoding: .utf8) {
                let fields = value.components(separatedBy: "\u{0}")
                localTurn = fields.count == 4 && fields[0] == host && fields[1] == session && !fields[2].isEmpty && !fields[3].isEmpty ?
                    .init(session: session, epoch: fields[2], id: fields[3]) : nil
            } else { localTurn = nil }
        }
    }

    struct Turn: Equatable, Hashable, Sendable {
        let runtime: String
        let session: String
        let id: String
        let startedAt: Int64

        init(runtime: String, session: String, id: String, startedAt: Int64) {
            self.runtime = runtime; self.session = session; self.id = id; self.startedAt = startedAt
        }
        init?(runtime: String, session: String, value: HostJSON) {
            guard let id = value["turnId"].string, !id.isEmpty, id.utf16.count <= 256,
                  let startedAt = value["startedAt"].integer else { return nil }
            self.init(runtime: runtime, session: session, id: id, startedAt: startedAt)
        }
    }
    struct HostFacts: Equatable, Sendable {
        let generation: UUID
        var approvals: [String: Set<String>]?
        var settledApprovals: [String: Set<String>] = [:]
        var approvalsConfirmedThrough: Date?
        var viewedSessions: Set<String> = []
        var latestTurns: [Turn] = []
        var knownCompletions: Set<Turn> = []
        var localTurnStarts: [LocalTurn: Int64] = [:]
    }
    struct State: Equatable, Sendable {
        var pairings: [String: String]
        var pairingsConfirmed: Bool
        var retiredThrough: [String: Date]
        var hosts: [String: HostFacts]
    }
    struct Plan: Sendable {
        var remove: [String] = []
        var recheck: [String: Date] = [:]
    }

    static func approvalEvent(runtime: String, request: String) -> String {
        NotificationSource.digest("approval:\(runtime):\(request)")
    }

    static func completionEvent(_ turn: Turn) -> String {
        NotificationSource.digest("completed:\(turn.runtime):\(turn.session):\(turn.id)")
    }

    /// Only return actual system request identifiers. Pairing retirement is
    /// independent of connectivity; the remaining rules need current Host facts.
    static func plan(_ delivered: [Alert], state: State) -> Plan {
        var result = Plan()
        let threads = Dictionary(Set(state.pairings.keys).union(state.retiredThrough.keys)
            .map { (NotificationSource.threadIdentifier($0), $0) }, uniquingKeysWith: { first, _ in first })
        func hashes(_ requests: [String: Set<String>]) -> Set<String> {
            Set(requests.flatMap { runtime, ids in ids.map { approvalEvent(runtime: runtime, request: $0) } })
        }
        var pending: [String: Set<String>] = [:], settled: [String: Set<String>] = [:]
        var completions: [String: Set<String>] = [:]
        func removal(_ alert: Alert) -> String? {
            if let payloadHost = alert.host, let threadHost = threads[alert.thread], payloadHost != threadHost { return nil }
            guard let host = alert.host ?? threads[alert.thread] else { return nil }
            guard let pairing = state.pairings[host] else {
                return state.pairingsConfirmed || state.retiredThrough[host] != nil ? alert.id : nil
            }
            if let key = alert.pairing, key != pairing { return alert.id }
            if let retired = state.retiredThrough[host], alert.date <= retired { return alert.id }
            guard let facts = state.hosts[host], alert.host == host else { return nil }
            switch alert.category {
            case "approval-requested":
                guard let inventory = facts.approvals, let through = facts.approvalsConfirmedThrough else { return nil }
                if pending[host] == nil { pending[host] = hashes(inventory); settled[host] = hashes(facts.settledApprovals) }
                if let event = alert.event, pending[host]?.contains(event) == true { return nil }
                // An APNs alert can precede the matching E2E state update. Do not
                // apply an older negative inventory to a newly delivered request.
                let resolved = alert.event.map { settled[host]?.contains($0) == true } == true
                guard pending[host]?.isEmpty == true || resolved || isDigest(alert.event) else { return nil }
                guard resolved || alert.date <= through else {
                    if !inventory.isEmpty { result.recheck[host] = max(result.recheck[host] ?? alert.date, alert.date) }
                    return nil
                }
                // A nonempty inventory can only retire events in the Host's
                // released SHA-256 format. An empty one can retire legacy IDs too.
                return alert.id
            case "task-completed":
                if let session = alert.session {
                    if facts.viewedSessions.contains(session) { return alert.id }
                    let latest = facts.latestTurns.filter { $0.session == session }
                    if let turn = alert.localTurn, latest.count == 1, let current = latest.first, current.id != turn.id,
                       let knownStart = facts.localTurnStarts[turn], knownStart < current.startedAt { return alert.id }
                } else if let event = alert.event {
                    if completions[host] == nil {
                        let latest = Dictionary(uniqueKeysWithValues: facts.latestTurns.map { ($0.runtime, $0) })
                        completions[host] = Set(facts.knownCompletions.union(facts.latestTurns).filter { turn in
                            if facts.viewedSessions.contains(turn.session) { return true }
                            guard let current = latest[turn.runtime] else { return false }
                            return current.session == turn.session && current.id != turn.id && current.startedAt > turn.startedAt
                        }.map(completionEvent))
                    }
                    if completions[host]?.contains(event) == true { return alert.id }
                }
            default: break
            }
            return nil
        }
        for alert in delivered { if let id = removal(alert) { result.remove.append(id) } }
        return result
    }

    private static func isDigest(_ value: String?) -> Bool {
        guard let value, value.utf8.count == 64 else { return false }
        return value.utf8.allSatisfy { (48...57).contains($0) || (97...102).contains($0) }
    }
}

/// Coalesce notifications separately from screen publications, which can be
/// held during navigation. Match off the main actor, then revalidate before
/// giving any identifiers to the OS.
@MainActor
final class ForegroundReplyNotificationCleanup {
    private weak var store: OrbisStore?
    private var pairingObservation: AnyCancellable?
    private var observations: [String: (ObjectIdentifier, AnyCancellable)] = [:]
    private var pairingKeys: [String: String] = [:]
    private var retiredThrough: [String: Date] = [:]
    private var foreground = false
    private var dirty = false
    private var force = false
    private var lastState: ReplyNotificationCleanup.State?
    private var lastRecheck: [String: Date] = [:]
    private var work: Task<Void, Never>?
    private let delay: Duration
    private let isActive: () -> Bool
    private let delivered: () async -> [ReplyNotificationCleanup.Alert]
    private let remove: ([String]) -> Void

    init(delay: Duration = .milliseconds(250), isActive: @escaping () -> Bool, delivered: @escaping () async -> [ReplyNotificationCleanup.Alert],
         remove: @escaping ([String]) -> Void) {
        self.delay = delay; self.isActive = isActive; self.delivered = delivered; self.remove = remove
    }

    func bind(_ store: OrbisStore) {
        guard self.store !== store else { return }
        work?.cancel()
        self.store = store; observations = [:]; pairingKeys = [:]; retiredThrough = [:]; lastState = nil; lastRecheck = [:]
        pairingObservation = store.$pairings.sink { [weak self] pairings in
            guard let self else { return }
            let keys = Dictionary(uniqueKeysWithValues: pairings.map { ($0.hostId, PushNotificationIdentity.pairingKey($0)) })
            let now = Date()
            for (host, key) in self.pairingKeys where keys[host] != key {
                self.retiredThrough[host] = now; self.lastRecheck[host] = nil
            }
            self.pairingKeys = keys
            self.schedule()
        }
    }

    func setForeground(_ active: Bool) {
        guard foreground != active else { return }
        foreground = active
        if active { lastRecheck = [:]; schedule(force: true) } else { work?.cancel() }
    }

    func schedule(force: Bool = false) {
        dirty = true; self.force = self.force || force
        guard foreground, work == nil else { return }
        work = Task { [weak self] in
            guard let self else { return }
            defer { self.work = nil; if self.foreground && self.dirty { self.schedule() } }
            while self.foreground && self.dirty && !Task.isCancelled {
                // A short bounded coalescer also lets willPresent finish putting the alert in the list.
                do { try await Task.sleep(for: self.delay) } catch { return }
                self.dirty = false
                self.observeHosts()
                let forced = self.force; self.force = false
                guard self.isActive(), let state = self.state(), forced || state != self.lastState else { continue }
                let alerts = await self.delivered()
                guard self.foreground, self.isActive(), !Task.isCancelled, let current = self.state() else { continue }
                let plan = await Task.detached(priority: .utility) { ReplyNotificationCleanup.plan(alerts, state: current) }.value
                guard self.foreground, self.isActive(), !Task.isCancelled else { continue }
                guard current == self.state() else { self.schedule(force: true); continue }
                self.lastState = current
                if !plan.remove.isEmpty { self.remove(plan.remove) }
                for (host, delivery) in plan.recheck where delivery > (self.lastRecheck[host] ?? .distantPast) {
                    self.lastRecheck[host] = delivery
                    self.store?.connection(for: host)?.recheckReplyNotificationApprovals()
                }
            }
        }
    }

    func waitForPending() async {
        while let work { await work.value }
    }

    private func observeHosts() {
        guard let store else { return }
        observations = observations.filter { pairingKeys[$0.key] != nil }
        for host in store.hosts {
            let id = ObjectIdentifier(host.connection)
            guard observations[host.hostId]?.0 != id else { continue }
            observations[host.hostId] = (id, host.connection.notificationCleanupChanged.sink { [weak self] in self?.schedule() })
        }
    }

    private func state() -> ReplyNotificationCleanup.State? {
        guard let store else { return nil }
        let hosts = store.hosts.compactMap { host in host.connection.replyNotificationFacts().map { (host.hostId, $0) } }
        return .init(pairings: pairingKeys, pairingsConfirmed: store.pairingInventoryConfirmed,
            retiredThrough: retiredThrough, hosts: Dictionary(uniqueKeysWithValues: hosts))
    }
}

#if canImport(UIKit) && canImport(UserNotifications)
import UIKit
import UserNotifications
import Network

@MainActor
final class OrbisAppDelegate: NSObject, UIApplicationDelegate {
    static let pushEnvironment = PushRegistrationEnvironment.load()
    static let pushRegistration = PushRegistrationCoordinator(environment: pushEnvironment,
        loadRetired: { try await Task.detached { try SecureStore.shared.pendingPushRemovals() }.value },
        saveRetired: { values in try await Task.detached { try SecureStore.shared.savePendingPushRemovals(values) }.value })
    private static var authorizationRevision = 0
    private var pushNetwork: NWPathMonitor?
    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        UNUserNotificationCenter.current().delegate = ReplyCompletionNotifications.shared
        #if DEBUG
        if ProcessInfo.processInfo.arguments.contains(where: { $0.hasPrefix("--preview-screen=") || $0.hasPrefix("--push-lifecycle-probe=") }) { return true }
        #endif
        LiveActivityCoordinator.shared.startMonitoring()
        let network = NWPathMonitor()
        network.pathUpdateHandler = { path in
            if path.status == .satisfied {
                Task { @MainActor in
                    Self.registerForPushIfAllowed()
                    LiveActivityCoordinator.shared.registrationNetworkAvailable()
                }
            }
        }
        network.start(queue: DispatchQueue(label: "orbis.push.reachability"))
        pushNetwork = network
        return true
    }
    static func updatePairings(_ value: [HostPairing]) {
        pushRegistration.updatePairings(value)
        ReplyCompletionNotifications.shared.updateSources(value)
    }
    static func registerForPushIfAllowed() {
        authorizationRevision += 1
        let revision = authorizationRevision
        Task {
            let settings = await UNUserNotificationCenter.current().notificationSettings()
            guard revision == authorizationRevision else { return }
            let allowed = settings.authorizationStatus == .authorized || settings.authorizationStatus == .provisional
            pushRegistration.setAuthorizationAllowed(allowed)
            pushRegistration.refresh()
            if allowed, pushEnvironment != nil { UIApplication.shared.registerForRemoteNotifications() }
        }
    }
    nonisolated func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        let token = deviceToken.map { String(format: "%02x", $0) }.joined()
        Task { @MainActor in
            Self.pushRegistration.receiveToken(token)
        }
    }
    nonisolated func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        // APNs may be unavailable in simulator or misconfigured signing; local notifications remain independent.
    }
}

/// Defaults to notifications after the system grants permission. iOS suspension still
/// stops live reception; remote alerts use APNs and never carry conversation content.
@MainActor
final class ReplyCompletionNotifications: NSObject, UNUserNotificationCenterDelegate {
    static let shared = ReplyCompletionNotifications()
    static let remoteOpens = PushNotificationOpenQueue()
    private var requesting = false
    private let sourceQueue = DispatchQueue(label: "orbis.notification.sources", qos: .utility)
    private var sources = NotificationSourceDirectory(language: "zh-Hans", hosts: [:])
    private var sourceRevision = 0
    private let cleanup = ForegroundReplyNotificationCleanup(isActive: { UIApplication.shared.applicationState == .active },
        delivered: {
            await withCheckedContinuation { continuation in
                UNUserNotificationCenter.current().getDeliveredNotifications { notifications in
                    continuation.resume(returning: notifications.map {
                        ReplyNotificationCleanup.Alert(id: $0.request.identifier, date: $0.date, thread: $0.request.content.threadIdentifier,
                            remote: $0.request.trigger is UNPushNotificationTrigger, userInfo: $0.request.content.userInfo)
                    })
                }
            }
        }, remove: { UNUserNotificationCenter.current().removeDeliveredNotifications(withIdentifiers: $0) })

    func bind(_ store: OrbisStore, foreground: Bool) { cleanup.bind(store); cleanup.setForeground(foreground) }
    func setForeground(_ active: Bool) { cleanup.setForeground(active) }

    func updateSources(_ pairings: [HostPairing]) {
        sourceRevision += 1
        let revision = sourceRevision
        let inputs = pairings.map { NotificationSource.Input(hostId: $0.hostId, name: $0.hostName,
            pairingKey: PushNotificationIdentity.pairingKey($0)) }
        let language = AppLocalization.shared.language.rawValue
        // Serial, atomic writes keep an older pairing snapshot from overwriting
        // a newer removal. All filesystem work runs away from the main thread.
        sourceQueue.async { [weak self] in
            let directory = NotificationSourceDirectory(language: language, hosts: NotificationSource.make(inputs, language: language))
            if let url = NotificationSourceDirectory.sharedURL() { try? directory.write(to: url) }
            Task { @MainActor in
                guard let self, self.sourceRevision == revision else { return }
                self.sources = directory
            }
        }
    }
    func prepare() {
        let center = UNUserNotificationCenter.current()
        center.delegate = self
        guard !requesting else { return }
        requesting = true
        Task {
            var status = await center.notificationSettings()
            if status.authorizationStatus == .notDetermined {
                _ = try? await center.requestAuthorization(options: [.alert, .sound, .badge])
                status = await center.notificationSettings()
            }
            OrbisAppDelegate.registerForPushIfAllowed()
            requesting = false
        }
    }
    func post(hostId: String, pairingKey: String, sessionId: String, epoch: String, turnId: String, title: String) {
        let content = UNMutableNotificationContent()
        content.title = sources.source(hostId: hostId).name
        content.subtitle = String(title.prefix(160))
        content.body = sources.body(category: "task-completed")
        content.threadIdentifier = NotificationSource.threadIdentifier(hostId)
        content.sound = .default
        content.userInfo = ["orbis": ["v": 1, "category": "task-completed", "hostId": hostId,
            "sessionId": sessionId, "pairingKey": pairingKey]]
        // Use an identity key so repeated delivery replaces the same OS notification.
        let identifier = Data((hostId + "\u{0}" + sessionId + "\u{0}" + epoch + "\u{0}" + turnId).utf8).base64EncodedString()
        UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: identifier, content: content, trigger: nil))
    }
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse, withCompletionHandler completionHandler: @escaping () -> Void) {
        let info = response.notification.request.content.userInfo
        Task { @MainActor in
            Self.remoteOpens.receive(info)
            self.cleanup.schedule(force: true)
            completionHandler()
        }
    }
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter,
        willPresent notification: UNNotification, withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.banner, .list, .sound])
        Task { @MainActor in self.cleanup.schedule(force: true) }
    }
}
#endif
