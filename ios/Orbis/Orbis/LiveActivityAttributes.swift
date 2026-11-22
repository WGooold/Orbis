import Foundation
import CryptoKit

/// LA-01: the only content carried through ActivityKit/APNs is a bounded,
/// generic summary. Session titles are never part of a push.
struct OrbisLiveActivityState: Codable, Hashable, Sendable {
    var version: Int = 1
    var phase: String
    var runningCount: Int
    var pendingCount: Int
    var focusKey: String?
    var agentKind: String?
    var startedAt: Int64?
    var updatedAt: Int64
    var outcome: String?
    var sessionCount: Int?

    // Mirror of @orbis/protocol LIVE_ACTIVITY_AGENT_KINDS. A cross-target
    // conformance test checks the same wire allowlist for older Apps and new producers.
    static let agentKinds: Set<String> = ["pi", "codex", "codexDesktop", "claude", "dsh", "dshDesktop", "opencode"]
    static let freshness: TimeInterval = 600

    static func isDigest(_ value: String) -> Bool {
        value.utf8.count == 64 && value.utf8.allSatisfy { (48...57).contains($0) || (97...102).contains($0) }
    }

    var isActive: Bool { phase == "running" || phase == "attention" }

    init(version: Int = 1, phase: String, runningCount: Int, pendingCount: Int,
         focusKey: String? = nil, agentKind: String? = nil, startedAt: Int64? = nil,
         updatedAt: Int64, outcome: String? = nil, sessionCount: Int? = nil) {
        self.version = version; self.phase = phase
        self.runningCount = runningCount; self.pendingCount = pendingCount
        self.focusKey = focusKey; self.agentKind = agentKind
        self.startedAt = startedAt; self.updatedAt = updatedAt; self.outcome = outcome; self.sessionCount = sessionCount
    }

    var isValid: Bool {
        guard version == 1, ["running", "attention", "ended", "stale"].contains(phase),
              (0...2048).contains(runningCount), (0...131_072).contains(pendingCount),
              (0...8_640_000_000_000_000).contains(updatedAt),
              startedAt.map({ $0 >= 0 && $0 <= updatedAt }) != false,
              focusKey.map(Self.isDigest) != false,
              agentKind.map({ Self.agentKinds.contains($0) }) != false,
              outcome.map({ ["completed", "failed", "cancelled", "unknown"].contains($0) }) != false,
              sessionCount.map({ $0 >= runningCount + (phase == "attention" ? 1 : 0) && $0 <= min(2048, runningCount + pendingCount) }) != false,
              phase == "ended" || outcome == nil else { return false }
        switch phase {
        case "running": return runningCount > 0 && pendingCount == 0
        case "attention": return pendingCount > 0
        case "ended": return runningCount == 0 && pendingCount == 0
        default: return true
        }
    }

    /// LA-I11: relative priority between this app's independent Host activities.
    var relevanceScore: Double { !isValid ? 0 : phase == "attention" ? 100 : phase == "running" ? 50 : 0 }
}

/// LIVE-ACTIVITY-02: only app-derived, opaque pairing identifiers may cross
/// the ActivityKit boundary. Host/device references cannot select a new pairing.
struct OrbisLiveActivityAttributes: Codable, Hashable, Sendable {
    let hostId: String
    var language: String? = nil
    var pairingKey: String? = nil
    var pairingRef: String? = nil
    var launchId: String? = nil
    // Decode released activities; never write titles or names on new ones.
    var initialFocusKey: String? = nil
    var initialTitle: String? = nil
    var source: NotificationSource? = nil

    static func remotePairingRef(hostId: String, deviceId: String, credential: String) -> String {
        let data = (try? JSONSerialization.data(withJSONObject: ["orbis.live-activity-pairing-v1", hostId, deviceId,
            NotificationSource.digest(credential)], options: [.withoutEscapingSlashes])) ?? Data()
        return SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    func url(focusKey: String?) -> URL? {
        var components = URLComponents()
        components.scheme = "orbis"; components.host = "activity"
        components.queryItems = [URLQueryItem(name: "hostId", value: hostId)]
        if let pairingRef, OrbisLiveActivityState.isDigest(pairingRef) {
            components.queryItems?.append(URLQueryItem(name: "pairingRef", value: pairingRef))
        } else if let pairingKey, OrbisLiveActivityState.isDigest(pairingKey) {
            components.queryItems?.append(URLQueryItem(name: "pairingKey", value: pairingKey))
        } else { return nil }
        if let focusKey, OrbisLiveActivityState.isDigest(focusKey) { components.queryItems?.append(URLQueryItem(name: "focusKey", value: focusKey)) }
        return components.url
    }
}

#if os(iOS) && canImport(ActivityKit)
import ActivityKit
extension OrbisLiveActivityAttributes: ActivityAttributes {
    typealias ContentState = OrbisLiveActivityState
}
#endif

/// Static copy and data for the system's compact, minimal and two-row views.
/// No approximate elapsed counters, placeholder task titles or faux actions.
struct OrbisLiveActivityPresentation {
    enum Status { case running, attention, stale, completed, failed, cancelled, ended }
    let state: OrbisLiveActivityState
    let language: String
    let title: String?
    let source: NotificationSource
    let badge: String?
    let status: Status

    init(state: OrbisLiveActivityState, isStale: Bool, language: String, title: String? = nil,
         hostId: String = "", source: NotificationSource? = nil, badge: String? = nil) {
        self.state = state; self.language = language; self.badge = badge
        self.source = source ?? .fallback(hostId: hostId, language: language)
        self.title = state.isValid ? title : nil
        if !state.isValid || state.phase == "stale" || isStale && state.phase != "ended" { status = .stale }
        else if state.phase == "ended" {
            switch state.outcome {
            case "completed": status = .completed
            case "failed": status = .failed
            case "cancelled": status = .cancelled
            default: status = .ended
            }
        } else { status = state.phase == "attention" ? .attention : .running }
    }

    private var chinese: Bool { language.hasPrefix("zh") }
    var isAggregate: Bool {
        state.sessionCount.map { $0 > 1 } ?? (state.runningCount > 1 || state.runningCount > 0 && state.pendingCount > 0)
    }
    var agent: AgentIdentity? { state.isValid ? AgentIdentity(kind: state.agentKind) : nil }
    var compactAgent: AgentIdentity? { !isAggregate && (status == .running || status == .attention) ? agent : nil }
    var details: String? { title ?? agent?.title ?? startedText }

    var startedAt: Date? {
        guard status == .running, state.runningCount == 1, let startedAt = state.startedAt else { return nil }
        return Date(timeIntervalSince1970: Double(startedAt) / 1000)
    }
    private var locale: Locale { Locale(identifier: language) }
    var clockText: String? { startedAt?.formatted(.dateTime.hour().minute().locale(locale)) }
    var startedText: String? { clockText.map { chinese ? "\($0) 开始" : "Started \($0)" } }

    var headline: String {
        switch status {
        case .running:
            return state.runningCount == 1 ? (chinese ? "运行中" : "Running") :
                (chinese ? "\(state.runningCount) 个运行中" : "\(state.runningCount) running")
        case .attention:
            let count = state.pendingCount
            let pending = chinese ? "\(count) 项待处理" : "\(count) pending"
            let running = chinese ? "\(state.runningCount) 个运行中" : "\(state.runningCount) running"
            return state.runningCount == 0 ? pending : pending + " · " + running
        case .stale: return chinese ? "待更新" : "Not current"
        case .completed: return chinese ? "已完成" : "Completed"
        case .failed: return chinese ? "执行失败" : "Failed"
        case .cancelled: return chinese ? "已取消" : "Cancelled"
        case .ended: return chinese ? "已结束" : "Ended"
        }
    }

    var statusSymbol: String {
        switch status {
        case .running: return "circle.fill"
        case .attention: return "exclamationmark.circle.fill"
        case .stale: return "clock.badge.questionmark"
        case .completed: return "checkmark.circle.fill"
        case .failed: return "xmark.circle.fill"
        case .cancelled: return "slash.circle"
        case .ended: return "minus.circle"
        }
    }

    private static let compactClock = Date.FormatStyle().hour(.twoDigits(amPM: .omitted)).minute(.twoDigits).locale(Locale(identifier: "en_GB"))

    var compactText: String? {
        let count = status == .attention ? state.pendingCount : state.runningCount
        if status == .attention || status == .running && count > 1 { return count > 99 ? "99+" : String(count) }
        return startedAt?.formatted(Self.compactClock)
    }
    var sourceAccessibilityLabel: String { [source.name, headline].joined(separator: ", ") }
    var compactStatusAccessibilityLabel: String { [headline, startedText].compactMap { $0 }.joined(separator: ", ") }
}
