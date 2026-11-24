import CoreGraphics
import Foundation

/// SC57: the two handles are separated by a 24pt inactive moat. Hit testing is
/// based on the initial point so a drag cannot change its owner halfway through.
enum ProviderDialGeometry {
    enum Handle: Hashable { case agent, profile }
    struct Layout {
        let width: Double
        let height: Double
        let radius: Double
        let centerX: Double
        let centerY: Double
        let holeRadius: Double
        let hubRadius: Double
        let agentRadius: Double
        let profileStep: Double
        let agentStep: Double
        init(width: Double, height: Double) {
            self.width = width; self.height = height
            let base = max(140, min((width * 0.52).rounded(), floor(height / 2) - 28, width - 76 - 28 - 136))
            radius = (base * 1.6).rounded()
            centerX = base + clamp(base * 0.15, 22, 30).rounded() + 24 - radius
            centerY = height / 2
            holeRadius = max(clamp(radius * 0.15, 22, 44).rounded(), 26 - centerX)
            hubRadius = max((radius * 0.5).rounded(), holeRadius + 72)
            agentRadius = ((holeRadius + hubRadius) / 2).rounded() + 2
            profileStep = clamp(96 / (radius + 28) * 180 / .pi, 16, 24).rounded()
            agentStep = clamp(56 / agentRadius * 180 / .pi, 24, 40).rounded()
        }
        var pinStart: Double { centerX + agentRadius }
        var pinTravel: Double { hubRadius + 24 - agentRadius }
        /// AGENT-DIAL-04: centre of an Agent `distance` slots from the gate. A docked pin stays on the
        /// fixed groove's centre line; an undocked one follows the ring.
        func pinCentre(distance: Double, travel: Double) -> CGPoint {
            let angle = distance * agentStep * .pi / 180
            let dock = ProviderDialGeometry.docked(distance)
            let radius = agentRadius + clamp(travel, 0, 1) * ProviderDialGeometry.seated(distance) * pinTravel
            return CGPoint(x: centerX + radius * cos(angle), y: centerY + radius * sin(angle) * (1 - dock))
        }
        func pinContains(x: Double, y: Double) -> Bool { (pinStart - 22...pinStart + pinTravel + 22).contains(x) && abs(y - centerY) <= 26 }
        func handle(x: Double, y: Double) -> Handle? {
            guard x >= 20 else { return nil }
            let distance = hypot(x - centerX, y - centerY)
            if distance < holeRadius { return nil }
            if distance < hubRadius { return .agent }
            if distance < hubRadius + 24 { return nil }
            return .profile
        }
    }
    static let pinHold = 0.72
    /// AGENT-DIAL-06: vertical travel past which a pin edit leaves the groove and is abandoned.
    static let pinEscape = 36.0
    static func horizontal(_ dx: Double, _ dy: Double) -> Bool { abs(dx) > abs(dy) * 1.1 }
    static func pinPosition(enabled: Bool, dx: Double, travel: Double) -> Double {
        enabled ? clamp(1 + dx / travel, 1 - pinHold, 1) : clamp(dx / travel, 0, pinHold)
    }
    static func pinArmed(enabled: Bool, position: Double) -> Bool { enabled ? position < 0.5 : position > 0.5 }
    /// Resting pin travel for any Agent: the socket end is reserved for a Host-confirmed enable.
    static func pinRest(pendingTarget: Bool?, enabled: Bool) -> Double {
        switch pendingTarget { case true?: pinHold; case false?: 1 - pinHold; case nil: enabled ? 1 : 0 }
    }
    /// AGENT-DIAL-04: docking is a function of ring position alone. An Agent is held on the groove line
    /// inside `dockWindow`; its pin may leave the ring only inside the narrower `seatWindow`.
    static let dockWindow = 0.2
    static let seatWindow = 0.1
    static func docked(_ distance: Double) -> Double { 1 - smooth(abs(distance) / dockWindow) }
    static func seated(_ distance: Double) -> Double { 1 - smooth(abs(distance) / seatWindow) }
    /// The raised cap emerges over a wider window, so it never belongs to two Agents at once.
    static func gate(_ distance: Double) -> Double { 1 - smooth(abs(distance) / 0.5) }
    private static func smooth(_ t: Double) -> Double { let x = clamp(t, 0, 1); return x * x * (3 - 2 * x) }
    /// AGENT-DIAL-04: the stacked dial height depends only on the page, never on the facts below it.
    static func stackedHeight(width: Double, height: Double) -> Double {
        let natural = 2 * (max(140, min((width * 0.52).rounded(), width - 240)) + 28)
        return max(max(height - 320, min(natural, height - 200)), min(height, 204))
    }
    static func settleDuration(distance: Double) -> Double { min(0.46, 0.22 + abs(distance) * 0.06) }
    static func clamp(_ value: Double, _ lower: Double, _ upper: Double) -> Double { min(max(value, lower), upper) }
    static func softened(_ value: Double, count: Int) -> Double {
        if value < 0 { return value * 0.3 }
        let last = Double(max(0, count - 1))
        return value > last ? last + (value - last) * 0.3 : value
    }
    static func sticky(_ value: Double) -> Double {
        let index = value.rounded(), delta = value - index
        return index + (delta < 0 ? -1 : 1) * 0.5 * pow(abs(delta) * 2, 2.4)
    }
    static func settled(_ position: Double, translation: Double, predictedTranslation: Double, handle: Handle, count: Int, pointsPerStep: Double) -> Int {
        let step = handle == .agent ? 84 : pointsPerStep
        let projection = handle == .agent ? translation : translation + (predictedTranslation - translation) * 0.3
        return Int(clamp((position - projection / step).rounded(), 0, Double(max(0, count - 1))))
    }
    static func variant(for kind: String) -> String? {
        switch kind {
        case "codex", "dsh": return "terminal"
        case "codexDesktop", "dshDesktop": return "desktop"
        default: return nil
        }
    }
    static func infoHint(for statusLabel: String) -> String? {
        switch statusLabel {
        case "未安装": return "在电脑上的 Orbis 里安装，完成后自动接入。"
        case "待配置": return "在电脑上的 Orbis 里填写连接配置。"
        default: return nil
        }
    }
    static func pinReleaseHint(effectiveEnabled: Bool, activeSessions: Int) -> String {
        if !effectiveEnabled { return "松手启用" }
        return activeSessions > 0 ? "松手后确认停用" : "松手停用"
    }
}
