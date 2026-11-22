import Foundation
import CryptoKit

/// Facts used for the local routing/title index, dismissal tracking, and the
/// initial state only when a released Relay has no Host-summary claim route.
struct LiveActivityRuntimeFact: Sendable {
    let sessionId: String
    let agentKind: String
    let phase: String
    let pendingCount: Int
    let startedAt: Int64?
    let backgroundAgents: Bool
    let title: String?
    var turnId: String? = nil
    var runtimeId: String? = nil
    var isActive: Bool { pendingCount > 0 || phase != "idle" || backgroundAgents }
}

enum LiveActivityProjection {
    static func hasBackgroundAgents(_ inventory: BackgroundTaskInventory?) -> Bool {
        guard let inventory, inventory.confirmed else { return false }
        return inventory.items.contains { task in
            task.kind != "shell" && task.kind != "monitor" && ["pending", "running", "waiting"].contains(task.status)
        }
    }

    static func focusKey(hostId: String, agentKind: String, sessionId: String) -> String {
        let data = (try? JSONSerialization.data(withJSONObject: [hostId, agentKind, sessionId], options: [.withoutEscapingSlashes])) ?? Data()
        return SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    static func supports(_ kind: String) -> Bool { OrbisLiveActivityState.agentKinds.contains(kind) }

    /// LIVE-ACTIVITY-02: the compatibility path may seed an activity, but can
    /// never turn reconnect/idle facts into a write on an existing activity.
    static func seed(hostId: String, facts: [LiveActivityRuntimeFact], complete: Bool, now: Int64) -> OrbisLiveActivityState? {
        let facts = facts.filter { supports($0.agentKind) }
        guard complete, facts.allSatisfy({ ["idle", "running", "waiting_local_interaction"].contains($0.phase) }) else { return nil }
        let pending = facts.filter { $0.pendingCount > 0 || $0.phase == "waiting_local_interaction" }
        let running = facts.filter { $0.pendingCount == 0 && $0.phase != "waiting_local_interaction" && ($0.phase == "running" || $0.backgroundAgents) }
        guard let focus = (pending.isEmpty ? running : pending).min(by: {
            if $0.agentKind != $1.agentKind { return $0.agentKind < $1.agentKind }
            return $0.sessionId < $1.sessionId
        }) else { return nil }
        let runningCount = min(running.count, 2048)
        let requests = min(pending.reduce(0) { $0 + max(1, $1.pendingCount) }, 131_072)
        return OrbisLiveActivityState(phase: pending.isEmpty ? "running" : "attention",
            runningCount: runningCount, pendingCount: requests,
            focusKey: focusKey(hostId: hostId, agentKind: focus.agentKind, sessionId: focus.sessionId),
            agentKind: focus.agentKind, startedAt: focus.startedAt.flatMap { $0 >= 0 && $0 <= now ? $0 : nil }, updatedAt: now,
            sessionCount: running.count + pending.count <= 2048 ? running.count + pending.count : nil)
    }

}

struct LiveActivityOpenTarget: Equatable {
    let hostId: String
    let pairingKey: String?
    let pairingRef: String?
    let focusKey: String?

    /// LA-I03: URLs are navigation only. They cannot approve a request or submit
    /// commands, and only a currently paired Host may be selected by the caller.
    init?(url: URL) {
        guard let c = URLComponents(url: url, resolvingAgainstBaseURL: false), c.scheme == "orbis", c.host == "activity",
              c.user == nil, c.password == nil, c.port == nil, c.path.isEmpty, c.fragment == nil else { return nil }
        let items = c.queryItems ?? []
        guard Set(items.map(\.name)).count == items.count, items.allSatisfy({ ["hostId", "pairingKey", "pairingRef", "focusKey"].contains($0.name) && $0.value != nil }),
              let host = items.first(where: { $0.name == "hostId" })?.value, !host.isEmpty, host.utf8.count <= 128 else { return nil }
        let key = items.first(where: { $0.name == "pairingKey" })?.value
        let reference = items.first(where: { $0.name == "pairingRef" })?.value
        guard (key == nil) != (reference == nil), let pairing = key ?? reference, OrbisLiveActivityState.isDigest(pairing) else { return nil }
        let focus = items.first(where: { $0.name == "focusKey" })?.value
        guard focus.map(OrbisLiveActivityState.isDigest) != false else { return nil }
        hostId = host; pairingKey = key; pairingRef = reference; focusKey = focus
    }
}

/// LA-I09: a tap may wait briefly for a current route map, but never retains a
/// navigation intent after fallback, replacement, backgrounding or user navigation.
struct LiveActivityOpenQueue {
    enum Destination: Equatable { case home, runtime(String) }
    static let timeout: TimeInterval = 2
    private(set) var generation: UInt64 = 0
    private(set) var target: LiveActivityOpenTarget?
    private var deadline: TimeInterval = 0

    @discardableResult
    mutating func enqueue(_ target: LiveActivityOpenTarget, now: TimeInterval) -> UInt64 {
        generation &+= 1
        self.target = target; deadline = now + Self.timeout
        return generation
    }

    mutating func cancel() { generation &+= 1; target = nil }

    mutating func resolve(generation: UInt64, now: TimeInterval, routeIsCurrent: Bool,
                          complete: Bool, runtimeId: String?) -> Destination? {
        guard generation == self.generation, let target else { return nil }
        let destination: Destination
        if target.focusKey == nil || now >= deadline { destination = .home }
        else if routeIsCurrent, let runtimeId { destination = .runtime(runtimeId) }
        else if routeIsCurrent && complete { destination = .home }
        else { return nil }
        self.target = nil
        return destination
    }
}
