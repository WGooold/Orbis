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

    func dismiss(runtimeId: String, notificationId: String) {
        guard connected, let epoch, sessions[runtimeId] != nil, Self.validIdentifier(runtimeId), Self.validIdentifier(notificationId) else { return }
        _ = send?(["type": "notification.dismiss", "protocolVersion": orbisProtocolVersion,
            "runtimeId": runtimeId, "hostEpoch": epoch, "notificationId": notificationId])
        sync(runtimeId: runtimeId)
    }

    private func cancelReads() {
        jobs.values.forEach { $0.cancel() }; jobs = [:]; jobIds = [:]
    }
}
