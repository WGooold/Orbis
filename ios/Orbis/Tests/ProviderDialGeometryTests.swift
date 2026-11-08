// Orbis 测试用途：SC57 双圈供应商盘的边缘保护、空心/护城河分区和吸附。
// 防止手势跨圈以及换 Agent 时被速度带过多个 Agent；配置盘保留速度投射。
import Foundation
import Testing
@testable import OrbisCore

@Suite("Provider dial handle ownership and detents")
struct ProviderDialGeometryTests {
    @Test func touchStartsInExactlyOneHandle() {
        let g = ProviderDialGeometry.Layout(width: 390, height: 400)
        #expect(g.centerX < 0)
        #expect(g.centerX + g.holeRadius >= 26)
        #expect(g.hubRadius - g.holeRadius >= 72)
        #expect(g.handle(x: 19, y: g.centerY) == nil)
        #expect(g.handle(x: g.centerX + g.holeRadius - 1, y: g.centerY) == nil)
        #expect(g.handle(x: g.centerX + (g.holeRadius + g.hubRadius) / 2, y: g.centerY) == .agent)
        #expect(g.handle(x: g.centerX + g.hubRadius + 12, y: g.centerY) == nil)
        #expect(g.handle(x: g.centerX + g.hubRadius + 25, y: g.centerY) == .profile)
    }
    @Test func releaseVelocityNeverChangesTheAgentTarget() {
        let slow = ProviderDialGeometry.settled(1, translation: -30, predictedTranslation: -30, handle: .agent, count: 4, pointsPerStep: 96)
        let fling = ProviderDialGeometry.settled(1, translation: -30, predictedTranslation: -900, handle: .agent, count: 4, pointsPerStep: 96)
        #expect(slow == 1)
        #expect(fling == slow)
        #expect(ProviderDialGeometry.settled(1, translation: -43, predictedTranslation: -900, handle: .agent, count: 4, pointsPerStep: 96) == 2)
    }
    @Test func profileProjectionIsBoundedByTheAvailableCatalog() {
        #expect(ProviderDialGeometry.settled(1, translation: -30, predictedTranslation: -900, handle: .profile, count: 4, pointsPerStep: 96) == 3)
        #expect(ProviderDialGeometry.settled(0, translation: 900, predictedTranslation: 900, handle: .profile, count: 4, pointsPerStep: 96) == 0)
        #expect(ProviderDialGeometry.settled(0, translation: -900, predictedTranslation: -900, handle: .profile, count: 0, pointsPerStep: 96) == 0)
    }
    // Outer-disc landing has a distance-dependent, bounded 220–460ms duration.
    @Test func settlingDurationGrowsAndRemainsBounded() {
        #expect(ProviderDialGeometry.settleDuration(distance: 0) == 0.22)
        #expect(ProviderDialGeometry.settleDuration(distance: 2) > 0.22)
        #expect(ProviderDialGeometry.settleDuration(distance: -2) == ProviderDialGeometry.settleDuration(distance: 2))
        #expect(ProviderDialGeometry.settleDuration(distance: 100) == 0.46)
    }

}
