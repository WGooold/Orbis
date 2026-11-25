// Orbis 测试用途：SC57 双圈供应商盘的边缘保护、空心/护城河分区和吸附。
// 防止手势跨圈以及换 Agent 时被速度带过多个 Agent；配置盘保留速度投射。
import Foundation
import Testing
@testable import OrbisCore

@Suite("Provider dial handle ownership and detents")
struct ProviderDialGeometryTests {
    @Test func legacyRosterFiltersOnlyWhenTheHostAdvertisesCapabilities() {
        #expect(legacyAgentDialKinds(supported: ["pi", "codexDesktop"], launchable: ["codex", "hermes"]) == ["codex", "pi"])
        #expect(legacyAgentDialKinds(supported: [], launchable: []) == [])
        #expect(legacyAgentDialKinds(supported: nil, launchable: nil) == nil)
    }
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

    // AGENT-DIAL-01: an outward drag stops before the socket; a vertical drag is never a latch edit.
    @Test func pinArmsOnlyPastMidpointInItsCaptureChannel() {
        let g = ProviderDialGeometry.Layout(width: 390, height: 440)
        let x = g.pinStart + g.pinTravel / 2
        #expect(g.pinContains(x: x, y: g.centerY))
        #expect(!g.pinContains(x: x, y: g.centerY + 28))
        #expect(!ProviderDialGeometry.horizontal(12, -70))
        #expect(ProviderDialGeometry.horizontal(30, 8))
        #expect(!ProviderDialGeometry.pinArmed(enabled: false, position: ProviderDialGeometry.pinPosition(enabled: false, dx: g.pinTravel * 0.4, travel: g.pinTravel)))
        // AGENT-DIAL-08: the pin follows the finger along the whole groove and stops only at its ends.
        #expect(abs(ProviderDialGeometry.pinPosition(enabled: false, dx: g.pinTravel * 0.9, travel: g.pinTravel) - 0.9) < 0.00001)
        #expect(ProviderDialGeometry.pinPosition(enabled: false, dx: g.pinTravel * 1.5, travel: g.pinTravel) == 1)
        #expect(abs(ProviderDialGeometry.pinPosition(enabled: true, dx: -g.pinTravel * 0.9, travel: g.pinTravel) - 0.1) < 0.00001)
        #expect(ProviderDialGeometry.pinArmed(enabled: true, position: ProviderDialGeometry.pinPosition(enabled: true, dx: -g.pinTravel, travel: g.pinTravel)))
    }

    // AGENT-DIAL-04: the stacked dial is sized by the page alone, at the disc's full width-bound size,
    // so quota, session or notice rows below can only scroll, not move or shrink the disc.
    @Test func stackedDialKeepsItsFullDiscIndependentOfTheFactsBelow() {
        for (width, height) in [(360.0, 560.0), (393.0, 600.0), (430.0, 700.0)] {
            let dial = ProviderDialGeometry.stackedHeight(width: width, height: height)
            #expect(ProviderDialGeometry.Layout(width: width, height: dial).radius == ProviderDialGeometry.Layout(width: width, height: 4000).radius)
            #expect(height - dial >= 200)
        }
        #expect(ProviderDialGeometry.stackedHeight(width: 393, height: 300) == 204)
    }

    // AGENT-DIAL-04: a docked pin is one continuous path — slot, groove, socket — with no jump between
    // the ring and the groove, and an extended pin never leaves the groove's centre line.
    @Test func dockedPinRetractsAlongTheFixedGrooveWithoutJumping() {
        let g = ProviderDialGeometry.Layout(width: 393, height: ProviderDialGeometry.stackedHeight(width: 393, height: 600))
        #expect(abs(g.pinCentre(distance: 0, travel: 1).x - (g.pinStart + g.pinTravel)) < 0.001)
        #expect(abs(g.pinCentre(distance: 0, travel: 0).x - g.pinStart) < 0.001)
        #expect(abs(g.pinCentre(distance: 0, travel: 1).y - g.centerY) < 0.001)
        #expect(g.pinCentre(distance: ProviderDialGeometry.seatWindow, travel: 0) == g.pinCentre(distance: ProviderDialGeometry.seatWindow, travel: 1))
        var previous = g.pinCentre(distance: -0.6, travel: 1)
        for i in -599...600 {
            let distance = Double(i) / 1000
            let centre = g.pinCentre(distance: distance, travel: 1)
            #expect(hypot(centre.x - previous.x, centre.y - previous.y) < 1, "jump at \(distance)")
            if centre.x - g.pinCentre(distance: distance, travel: 0).x > 0.5 { #expect(abs(centre.y - g.centerY) <= 3, "off groove at \(distance)") }
            previous = centre
        }
    }

    @Test func variantBadgesInfoHintsAndActiveSessionPinReleaseHintsMatchDialSpec() {
        #expect(ProviderDialGeometry.variant(for: "codex") == "terminal")
        #expect(ProviderDialGeometry.variant(for: "dsh") == "terminal")
        #expect(ProviderDialGeometry.variant(for: "kimiCode") == "web")
        #expect(ProviderDialGeometry.variant(for: "codexDesktop") == "desktop")
        #expect(ProviderDialGeometry.variant(for: "dshDesktop") == "desktop")
        #expect(ProviderDialGeometry.variant(for: "kimiCodeDesktop") == "desktop")
        #expect(ProviderDialGeometry.variant(for: "claude") == nil)
        #expect(L10n.format("Kimi Code 桌面版", language: .english) == "Kimi Code Desktop")
        #expect(L10n.format("Kimi Code Web", language: .english) == "Kimi Code Web")
        #expect(ProviderDialGeometry.infoHint(for: "未安装") == "在电脑上的 Orbis 里安装，完成后自动接入。")
        #expect(ProviderDialGeometry.infoHint(for: "待配置") == "在电脑上的 Orbis 里填写连接配置。")
        #expect(ProviderDialGeometry.infoHint(for: "已连接") == nil)
        #expect(ProviderDialGeometry.pinReleaseHint(effectiveEnabled: false, activeSessions: 2) == "松手启用")
        #expect(ProviderDialGeometry.pinReleaseHint(effectiveEnabled: true, activeSessions: 0) == "松手停用")
        #expect(ProviderDialGeometry.pinReleaseHint(effectiveEnabled: true, activeSessions: 1) == "松手后确认停用")
    }

    // Compact landscape viewports shrink the disc below the portrait floor while preserving handle geometry.
    @Test func compactLandscapeDialShrinksCleanlyWhilePreservingHandles() {
        let portrait = ProviderDialGeometry.Layout(width: 402, height: 380)
        for height in [204.0, 228.0, 260.0] {
            let landscape = ProviderDialGeometry.Layout(width: 480, height: height)
            #expect(landscape.radius < portrait.radius)
            #expect(landscape.centerX < 0)
            #expect(landscape.centerX + landscape.holeRadius >= 26)
            #expect(landscape.hubRadius - landscape.holeRadius >= 72)
            #expect(landscape.hubRadius + 24 < landscape.radius)
            #expect(landscape.handle(x: landscape.centerX + (landscape.holeRadius + landscape.hubRadius) / 2, y: landscape.centerY) == .agent)
            #expect(landscape.handle(x: landscape.centerX + landscape.hubRadius + 25, y: landscape.centerY) == .profile)
        }
    }

}
