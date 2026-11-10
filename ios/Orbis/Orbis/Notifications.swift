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
    }
    private var active: [String: Identity] = [:]
    private var positions: [String: (epoch: String, seq: Int64)] = [:]
    private var receipts: [Identity]
    private var seen: Set<Identity>
    private let preferences: UserDefaults?
    private let key: String
    init(preferences: UserDefaults? = nil, owner: String = "") {
        self.preferences = preferences
        key = "orbis.replyCompletionReceipts." + owner
        let stored = preferences?.data(forKey: key).flatMap { try? JSONDecoder().decode([Identity].self, from: $0) } ?? []
        receipts = Array(stored.suffix(512)); seen = Set(receipts)
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
        if receipts.count > 512 { seen.remove(receipts.removeFirst()) }
        if let data = try? JSONEncoder().encode(receipts) { preferences?.set(data, forKey: key) }
    }
}

#if canImport(UIKit) && canImport(UserNotifications)
import UIKit
import UserNotifications

@MainActor
final class OrbisAppDelegate: NSObject, UIApplicationDelegate {
    private static var pairings: [HostPairing] = []
    private static var currentToken: String?
    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        UNUserNotificationCenter.current().delegate = ReplyCompletionNotifications.shared
        return true
    }
    static func updatePairings(_ value: [HostPairing]) {
        let nextIds = Set(value.map { $0.hostId })
        if let currentToken {
            for old in pairings where !nextIds.contains(old.hostId) { register(nil, pairing: old) }
            for pairing in value { register(currentToken, pairing: pairing) }
        }
        pairings = value
    }
    static func registerForPushIfAllowed() {
        Task {
            let settings = await UNUserNotificationCenter.current().notificationSettings()
            guard settings.authorizationStatus == .authorized || settings.authorizationStatus == .provisional else { return }
            UIApplication.shared.registerForRemoteNotifications()
        }
    }
    nonisolated func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        let token = deviceToken.map { String(format: "%02x", $0) }.joined()
        Task { @MainActor in
            Self.currentToken = token
            for pairing in Self.pairings { Self.register(token, pairing: pairing) }
        }
    }
    nonisolated func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        // APNs may be unavailable in simulator or misconfigured signing; local notifications remain independent.
    }
    private static func register(_ token: String?, pairing: HostPairing) {
        guard var components = URLComponents(string: pairing.relay.relayUrl), components.scheme == "wss" else { return }
        components.scheme = "https"
        components.path = "/v1/push/register"
        guard let url = components.url else { return }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("Bearer \(pairing.relay.credential)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try? JSONSerialization.data(withJSONObject: ["token": token as Any? ?? NSNull()])
        Task {
            for attempt in 0..<3 {
                do {
                    let (_, response) = try await URLSession.shared.data(for: request)
                    if let response = response as? HTTPURLResponse, (200..<300).contains(response.statusCode) { return }
                } catch { }
                if attempt < 2 { try? await Task.sleep(for: .seconds(attempt == 0 ? 1 : 4)) }
            }
        }
    }
}

/// Defaults to notifications after the system grants permission. iOS suspension still
/// stops live reception; remote alerts use APNs and never carry conversation content.
@MainActor
final class ReplyCompletionNotifications: NSObject, UNUserNotificationCenterDelegate {
    static let shared = ReplyCompletionNotifications()
    static let remoteWake = Notification.Name("orbis.remoteWake")
    private var requesting = false
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
            if status.authorizationStatus == .authorized || status.authorizationStatus == .provisional {
                OrbisAppDelegate.registerForPushIfAllowed()
            }
            requesting = false
        }
    }
    func post(hostId: String, sessionId: String, epoch: String, turnId: String, title: String) {
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = L10n.tr("回复完成")
        content.sound = .default
        content.userInfo = ["hostId": hostId, "sessionId": sessionId]
        // Use an identity key so repeated delivery replaces the same OS notification.
        let identifier = Data((hostId + "\u{0}" + sessionId + "\u{0}" + epoch + "\u{0}" + turnId).utf8).base64EncodedString()
        UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: identifier, content: content, trigger: nil))
    }
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse, withCompletionHandler completionHandler: @escaping () -> Void) {
        let info = response.notification.request.content.userInfo
        let payload = info["orbis"] as? [String: Any]
        let hostId = payload?["hostId"] as? String
        guard let hostId, !hostId.isEmpty, hostId.count <= 128,
              ["task-completed", "approval-requested"].contains(payload?["category"] as? String ?? "") else { completionHandler(); return }
        Task { @MainActor in
            NotificationCenter.default.post(name: Self.remoteWake, object: nil, userInfo: ["hostId": hostId])
            completionHandler()
        }
    }
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter,
        willPresent notification: UNNotification, withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.banner, .list, .sound])
    }
}
#endif
