import Foundation

/// LA-I10: iOS does not report a dismissal to a suspended process. Persist the
/// locally created activity and all covered runs, so its absence after relaunch
/// is treated as dismissal until complete Host facts prove those runs ended.
struct LiveActivityLifecycle: Codable, Equatable {
    struct Record: Codable, Equatable {
        let activityId: String
        var runKeys: Set<String>
    }

    struct Run: Equatable {
        let focusKey: String
        let turnId: String?
        init(focusKey: String, turnId: String? = nil) {
            self.focusKey = focusKey; self.turnId = turnId
        }
    }

    private struct Identity: Codable, Equatable {
        var key: String
        var turnId: String?
    }

    private(set) var created: [String: Record] = [:]
    private(set) var suppressed: [String: Set<String>] = [:]
    private var identities: [String: [String: Identity]] = [:]

    init() {}

    private enum CodingKeys: String, CodingKey { case created, suppressed, identities }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        created = try c.decodeIfPresent([String: Record].self, forKey: .created) ?? [:]
        suppressed = try c.decodeIfPresent([String: Set<String>].self, forKey: .suppressed) ?? [:]
        identities = try c.decodeIfPresent([String: [String: Identity]].self, forKey: .identities) ?? [:]
    }

    /// Resolve every active run, not just the aggregate's current focus. A run
    /// first seen without a turn ID keeps its fallback identity when the ID is
    /// filled in; a later different turn ID is a new generation.
    mutating func runKeys(pairingKey: String, runs: [Run], complete: Bool) -> Set<String> {
        var known = identities[pairingKey] ?? [:]
        var keys: Set<String> = []
        let activeFocus = Set(runs.map(\.focusKey).filter { !$0.isEmpty })
        for run in runs where !run.focusKey.isEmpty {
            let turn = run.turnId.flatMap { $0.isEmpty ? nil : $0 }
            var identity: Identity
            if let previous = known[run.focusKey] {
                if let turn, let priorTurn = previous.turnId, turn != priorTurn {
                    identity = Identity(key: Self.turnKey(focus: run.focusKey, turn: turn), turnId: turn)
                } else {
                    identity = previous
                    if identity.turnId == nil { identity.turnId = turn }
                }
            } else {
                identity = Identity(key: turn.map { Self.turnKey(focus: run.focusKey, turn: $0) }
                    ?? "focus:\(run.focusKey)", turnId: turn)
            }
            known[run.focusKey] = identity
            keys.insert(identity.key)
        }
        if complete { known = known.filter { activeFocus.contains($0.key) } }
        identities[pairingKey] = known.isEmpty ? nil : known
        return keys
    }

    private static func turnKey(focus: String, turn: String) -> String {
        // focus is an app-generated SHA256 hex key; length-prefix the turn too
        // so no caller-provided delimiter can make two identities collide.
        "turn:\(focus.utf8.count):\(focus):\(turn.utf8.count):\(turn)"
    }

    /// Call on creation and after reconciling the active run inventory for the
    /// same activity, keeping the persisted coverage current before suspension.
    mutating func noteCreated(pairingKey: String, activityId: String, runKeys: Set<String>) {
        guard !pairingKey.isEmpty, !activityId.isEmpty else { return }
        created[pairingKey] = Record(activityId: activityId, runKeys: runKeys)
    }

    /// Pass only system activities still active or stale. A normal end observed
    /// in this process calls complete first, rather than appearing as missing.
    mutating func restore(systemActiveIds: Set<String>) {
        for (pairing, record) in created where !systemActiveIds.contains(record.activityId) {
            suppressed[pairing, default: []].formUnion(record.runKeys)
            created[pairing] = nil
        }
    }

    /// Partial/missing facts cannot clear a user's dismissal. Full facts retire
    /// only suppressed runs that are no longer active. A new turn is therefore
    /// eligible once all runs covered by the dismissed activity have ended.
    mutating func mayStart(pairingKey: String, currentRuns: Set<String>, complete: Bool) -> Bool {
        if let previous = suppressed[pairingKey], !previous.isEmpty {
            guard complete else { return false }
            let remaining = previous.intersection(currentRuns)
            suppressed[pairingKey] = remaining.isEmpty ? nil : remaining
            if !remaining.isEmpty { return false }
        }
        return !currentRuns.isEmpty
    }

    /// A late dismissal from an older activity must not suppress a newer one.
    mutating func dismiss(pairingKey: String, activityId: String, runKeys: Set<String> = []) {
        if let record = created[pairingKey] {
            guard record.activityId == activityId else { return }
            suppressed[pairingKey, default: []].formUnion(record.runKeys.union(runKeys))
            created[pairingKey] = nil
        } else if !runKeys.isEmpty {
            suppressed[pairingKey, default: []].formUnion(runKeys)
        }
    }

    /// App-observed terminal completion/removal is distinct from user dismissal.
    /// A late terminal event cannot clear suppression belonging to another run.
    mutating func complete(pairingKey: String, activityId: String) {
        guard created[pairingKey]?.activityId == activityId else { return }
        created[pairingKey] = nil
    }

    mutating func forgetPairing(_ pairingKey: String) {
        created[pairingKey] = nil; suppressed[pairingKey] = nil; identities[pairingKey] = nil
    }
}
