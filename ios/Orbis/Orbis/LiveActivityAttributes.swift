import Foundation

/// LA-01: the only content carried through ActivityKit/APNs is a bounded,
/// generic summary. Session titles remain in attributes created on this device.
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

    init(version: Int = 1, phase: String, runningCount: Int, pendingCount: Int,
         focusKey: String? = nil, agentKind: String? = nil, startedAt: Int64? = nil,
         updatedAt: Int64, outcome: String? = nil) {
        self.version = version; self.phase = phase
        self.runningCount = runningCount; self.pendingCount = pendingCount
        self.focusKey = focusKey; self.agentKind = agentKind
        self.startedAt = startedAt; self.updatedAt = updatedAt; self.outcome = outcome
    }

    var isValid: Bool {
        guard version == 1, ["running", "attention", "ended", "stale"].contains(phase),
              (0...2048).contains(runningCount), (0...131_072).contains(pendingCount),
              (0...9_007_199_254_740_991).contains(updatedAt),
              startedAt.map({ $0 >= 0 && $0 <= updatedAt }) != false,
              focusKey.map({ $0.utf8.count == 64 && $0.utf8.allSatisfy { (48...57).contains($0) || (97...102).contains($0) } }) != false,
              agentKind.map({ ["pi", "codex", "codexDesktop", "claude", "dsh", "dshDesktop"].contains($0) }) != false,
              outcome.map({ ["completed", "failed", "cancelled", "unknown"].contains($0) }) != false,
              phase == "ended" || outcome == nil else { return false }
        switch phase {
        case "running": return runningCount > 0 && pendingCount == 0
        case "attention": return pendingCount > 0
        case "ended": return runningCount == 0 && pendingCount == 0
        default: return true
        }
    }
}

/// LA-02: display values use the last confirmed timestamp, with approximate
/// minutes. No timer, spinner, looping animation, or second counter is needed.
struct OrbisLiveActivityPresentation {
    let state: OrbisLiveActivityState
    let isStale: Bool
    let language: String
    let title: String

    init(state: OrbisLiveActivityState, isStale: Bool, language: String,
         initialFocusKey: String? = nil, initialTitle: String? = nil) {
        self.state = state
        self.isStale = !state.isValid || state.phase == "stale" || (isStale && state.phase != "ended")
        self.language = language
        let localTitle = initialTitle?.trimmingCharacters(in: .whitespacesAndNewlines)
        if let focus = state.focusKey, focus == initialFocusKey,
           let localTitle, !localTitle.isEmpty {
            title = String(localTitle.prefix(160))
        } else { title = language.hasPrefix("zh") ? "当前任务" : "Current task" }
    }

    private var chinese: Bool { language.hasPrefix("zh") }
    var isAttention: Bool { !isStale && state.phase == "attention" }
    var isEnded: Bool { !isStale && state.phase == "ended" }
    var isAggregate: Bool {
        state.runningCount > 1 || state.pendingCount > 1 || (state.runningCount == 1 && state.pendingCount == 1)
    }

    var assetName: String {
        guard !isAggregate, !isStale, !isEnded else { return "OrbisMark" }
        switch state.agentKind {
        case "codex", "codexDesktop": return "AgentCodex"
        case "claude": return "AgentClaude"
        case "dsh", "dshDesktop": return "AgentDeepSeek"
        case "pi": return "AgentPi"
        default: return "OrbisMark"
        }
    }

    var agentName: String {
        switch state.agentKind {
        case "codex", "codexDesktop": return "Codex"
        case "claude": return "Claude"
        case "dsh", "dshDesktop": return "DeepSeek"
        case "pi": return "Pi"
        default: return "Orbis"
        }
    }

    var elapsedMinutes: Int? {
        guard !isStale, let startedAt = state.startedAt,
              startedAt >= 0, state.updatedAt >= startedAt else { return nil }
        return Int(min(9999, (state.updatedAt - startedAt) / 60_000))
    }

    var elapsedText: String? {
        guard let minutes = elapsedMinutes else { return nil }
        if minutes == 0 { return chinese ? "不到 1 分钟" : "<1 min" }
        return chinese ? "约 \(minutes) 分钟" : "~\(minutes) min"
    }

    private func compactCount(_ count: Int) -> String { count > 99 ? "99+" : String(count) }

    var compactText: String {
        if isStale { return "—" }
        if isAttention { return compactCount(state.pendingCount) }
        if isEnded { return "✓" }
        if state.runningCount > 1 {
            let value = compactCount(state.runningCount)
            return chinese ? "\(value) 个" : value
        }
        return elapsedText ?? (chinese ? "运行中" : "Running")
    }

    var headline: String {
        if isStale { return chinese ? "待更新" : "Update needed" }
        if isAttention { return chinese ? "\(state.pendingCount) 项待处理" : "\(state.pendingCount) pending" }
        if isEnded { return statusText }
        if state.runningCount > 1 { return chinese ? "\(state.runningCount) 个运行中" : "\(state.runningCount) running" }
        return elapsedText ?? statusText
    }

    var statusText: String {
        if isStale { return chinese ? "状态待更新" : "Status out of date" }
        if isAttention { return chinese ? "等待你处理" : "Waiting for you" }
        if isEnded {
            switch state.outcome {
            case "completed": return chinese ? "已完成" : "Completed"
            case "failed": return chinese ? "执行失败" : "Failed"
            case "cancelled": return chinese ? "已取消" : "Cancelled"
            default: return chinese ? "已结束" : "Ended"
            }
        }
        return chinese ? "运行中" : "Running"
    }

    var detail: String {
        if isStale { return chinese ? "打开 Orbis 更新状态" : "Open Orbis to refresh" }
        if isAttention { return "\(agentName) · " + (chinese ? "需要你处理" : "Needs your attention") }
        if isEnded { return elapsedText ?? statusText }
        return "\(agentName) · " + (chinese ? "正在执行任务" : "Working on your task")
    }

    var otherRunningCount: Int {
        guard !isStale, !isEnded else { return 0 }
        return isAttention ? state.runningCount : max(0, state.runningCount - 1)
    }

    var otherRunningText: String? {
        let count = otherRunningCount
        guard count > 0 else { return nil }
        if chinese { return "另有 \(count) 个会话运行中" }
        return count == 1 ? "1 other session running" : "\(count) other sessions running"
    }

    var actionText: String {
        isAttention ? (chinese ? "查看请求" : "View request") : (chinese ? "打开会话" : "Open session")
    }
}

#if os(iOS) && canImport(ActivityKit)
import ActivityKit

struct OrbisLiveActivityAttributes: ActivityAttributes {
    typealias ContentState = OrbisLiveActivityState

    let hostId: String
    let language: String
    var pairingKey: String = ""
    /// These optional local values never travel through the push service. A
    /// changed focus cannot reuse the title of the previous session.
    var initialFocusKey: String? = nil
    var initialTitle: String? = nil

    func url(focusKey: String?) -> URL? {
        var components = URLComponents()
        components.scheme = "orbis"; components.host = "activity"
        components.queryItems = [URLQueryItem(name: "hostId", value: hostId)]
        if !pairingKey.isEmpty { components.queryItems?.append(URLQueryItem(name: "pairingKey", value: pairingKey)) }
        if let focusKey { components.queryItems?.append(URLQueryItem(name: "focusKey", value: focusKey)) }
        return components.url
    }
}
#endif
