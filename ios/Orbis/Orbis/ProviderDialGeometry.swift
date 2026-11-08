import Foundation

/// SC57: the two handles are separated by a 24pt inactive moat. Hit testing is
/// based on the initial point so a drag cannot change its owner halfway through.
enum ProviderDialGeometry {
    enum Handle: Equatable { case agent, profile }
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
        func handle(x: Double, y: Double) -> Handle? {
            guard x >= 20 else { return nil }
            let distance = hypot(x - centerX, y - centerY)
            if distance < holeRadius { return nil }
            if distance < hubRadius { return .agent }
            if distance < hubRadius + 24 { return nil }
            return .profile
        }
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
}
