// Orbis 测试用途（场景与判定见本文件断言）：
// - MOT-06 / SC14–16（MOT-06、SC14、C05、C06、R37、M17、V09、V10）
// - MOT-13 / SC35、MOT-15 / SC37（MOT-13、SC35、MOT-15、SC37、R47、R49、M20、M12、V13）
// - S62 / M30 / SC110（底部面板停靠高度、键盘、拖动与松手判定）
import Foundation
import CoreGraphics
import Testing
@testable import OrbisCore

struct MotionGeometryTests {
    @Test func physicalReleaseAndCancellationNeverFinishADecorativePeak() {
        var state = GlyphFeedbackState()
        #expect(state.update(pressed: false, activation: 0, enabled: true) == .reset)
        #expect(state.update(pressed: true, activation: 0, enabled: true) == .press)
        #expect(state.update(pressed: false, activation: 0, enabled: true) == .release)
        // A click delivered just after up belongs to that same physical gesture.
        #expect(state.update(pressed: false, activation: 1, enabled: true) == .release)
        state.released()
        #expect(state.update(pressed: false, activation: 2, enabled: true) == .activate)
    }

    @Test func repressTakesOverAndDisablingDropsTheOldGesture() {
        var state = GlyphFeedbackState()
        _ = state.update(pressed: true, activation: 0, enabled: true)
        #expect(state.update(pressed: false, activation: 1, enabled: true) == .release)
        #expect(state.update(pressed: true, activation: 1, enabled: true) == .press)
        #expect(state.update(pressed: true, activation: 1, enabled: false) == .reset)
        #expect(state.update(pressed: false, activation: 1, enabled: true) == .reset)
        #expect(state.update(pressed: false, activation: 2, enabled: true) == .activate)
    }

    @Test func mountingAnExistingActivationDoesNotReplayIt() {
        var state = GlyphFeedbackState()
        #expect(state.update(pressed: false, activation: 7, enabled: true) == .reset)
        #expect(state.update(pressed: false, activation: 8, enabled: true) == .activate)
        #expect(state.update(pressed: false, activation: 9, enabled: true) == .activate)
        #expect(state.update(pressed: false, activation: 10, enabled: false) == .reset)
    }

    @Test func sendStartsQuicklyAndContinuouslySlowsToAStopWithoutBouncing() {
        let source = CGPoint(x: 160, y: 620), target = CGPoint(x: 260, y: 410)
        for (start, duration) in [(CGFloat(0), CGFloat(0.25)), (CGFloat(0.25), CGFloat(0.75))] {
            let points = (0...20).map { MotionGeometry.sendPoint(from: source, to: target,
                progress: start + duration * CGFloat($0) / 20) }
            let distances = zip(points, points.dropFirst()).map { hypot($1.x - $0.x, $1.y - $0.y) }
            for (before, after) in zip(distances, distances.dropFirst()) { #expect(after <= before + 0.001) }
            #expect(distances.first! > distances.last! * 100)
            #expect(distances.last! < 0.1)
        }
        #expect(MotionGeometry.sendEaseOut(0.5) == 0.875)
        #expect(MotionGeometry.sendEaseOut(-1) == 0)
        #expect(MotionGeometry.sendEaseOut(2) == 1)
    }

    @Test func sendArrivesCompactThenUnfoldsToTheEntireMessageWithoutAHeightCap() {
        let source = CGRect(x: 24, y: 620, width: 300, height: 56)
        for target in [CGRect(x: 80, y: 490, width: 240, height: 64),
                       CGRect(x: 44, y: 180, width: 276, height: 400)] {
            #expect(MotionGeometry.sendFrame(from: source, to: target, progress: 0) == source)
            let right = MotionGeometry.sendFrame(from: source, to: target, progress: 0.07 / MotionGeometry.sendDuration)
            #expect(right.midX >= source.midX + 24)
            #expect(right.midY == source.midY)
            let arrival = MotionGeometry.sendFrame(from: source, to: target, progress: MotionGeometry.sendArrival)
            #expect(arrival.maxX == target.maxX && arrival.maxY == target.maxY)
            #expect(arrival.width < target.width && arrival.height < target.height)
            var previous = arrival
            for step in 1...100 {
                let progress = MotionGeometry.sendArrival + (1 - MotionGeometry.sendArrival) * CGFloat(step) / 100
                let frame = MotionGeometry.sendFrame(from: source, to: target, progress: progress)
                #expect(abs(frame.maxX - target.maxX) < 0.001 && abs(frame.maxY - target.maxY) < 0.001)
                #expect(frame.width >= previous.width && frame.height >= previous.height)
                previous = frame
            }
            #expect(previous == target)
            #expect(MotionGeometry.sendFrame(from: source, to: target, progress: 2) == target)
        }
    }

    @Test func aRevealCoversEveryCornerEvenForTouchesNearTheEdge() {
        let size = CGSize(width: 340, height: 126)
        for origin in [CGPoint.zero, CGPoint(x: 330, y: 4), CGPoint(x: 170, y: 63)] {
            let radius = MotionGeometry.revealRadius(origin: origin, size: size)
            for corner in [CGPoint.zero, CGPoint(x: 340, y: 0), CGPoint(x: 0, y: 126), CGPoint(x: 340, y: 126)] {
                #expect(hypot(corner.x - origin.x, corner.y - origin.y) <= radius + 0.001)
            }
        }
        #expect(MotionGeometry.touchOrigin(nil, size: size) == CGPoint(x: 170, y: 63))
        #expect(MotionGeometry.touchOrigin(CGPoint(x: -20, y: 400), size: size) == CGPoint(x: 0, y: 126))
    }

    @Test func sendMovesRightBeforeUpAndNeverOvershootsItsDestination() {
        let source = CGPoint(x: 160, y: 620), target = CGPoint(x: 260, y: 410)
        let samples = (0...100).map { MotionGeometry.sendPoint(from: source, to: target, progress: CGFloat($0) / 100) }
        #expect(samples.first == source); #expect(samples.last == target)
        #expect(samples[25] == CGPoint(x: 260, y: 620))
        for (a, b) in zip(samples, samples.dropFirst()) {
            #expect(b.x >= a.x); #expect(b.y <= a.y)
            #expect(b.x <= target.x && b.y >= target.y)
        }
        #expect(MotionGeometry.sendPoint(from: source, to: target, progress: -1) == source)
        #expect(MotionGeometry.sendPoint(from: source, to: target, progress: 2) == target)
        let leftTarget = CGPoint(x: 120, y: 410)
        #expect(MotionGeometry.sendPoint(from: source, to: leftTarget, progress: 0.25) == CGPoint(x: source.x + 24, y: source.y))
        #expect(MotionGeometry.sendPoint(from: source, to: leftTarget, progress: 1) == leftTarget)
    }

    // S62 / M30 / SC110: the old panel ignored requested stops (a three-row picker filled 88%)
    // and its stop math is easy to invert. Keyboard must not shrink the medium stop to nothing.
    @Test func sheetStopsHonorMediumAndKeyboard() {
        // iPhone 15: 759pt safe height, 34pt home indicator.
        let phone = OrbisSheetGeometry(available: 759, reference: 793, bottomInset: 34)
        #expect(phone.height(.large) == 759 - 793 * 0.12)
        #expect(abs(phone.height(.medium) - (793 * 0.55 - 34)) < 0.01)
        #expect(phone.height(.medium) < phone.height(.large))
        // Small screens keep a usable medium stop, never above large.
        let compact = OrbisSheetGeometry(available: 400, reference: 400)
        #expect(compact.height(.medium) == min(compact.height(.large), 320))
        // Keyboard up: the top edge stays put and every stop is the large height above it.
        let typing = OrbisSheetGeometry(available: 759 - 302, reference: 793, keyboard: true)
        #expect(typing.height(.medium) == typing.height(.large))
        #expect(typing.height(.large) == 759 - 302 - 793 * 0.12)
    }

    @Test func sheetDragGrowsThenRubberBandsAndMovesDown() {
        let g = OrbisSheetGeometry(available: 759, reference: 793, bottomInset: 34)
        let medium = g.height(.medium), large = g.height(.large)
        // Pulling up from medium grows the panel instead of lifting it off the bottom.
        let grown = g.frame(detents: [.medium, .large], current: .medium, translation: -50)
        #expect(grown.height == medium + 50 && grown.offset == 0)
        // Past the tallest stop it lifts by a bounded amount.
        let over = g.frame(detents: [.medium, .large], current: .medium, translation: -(large - medium) - 400)
        #expect(over.height == large && over.offset < 0 && over.offset > -OrbisSheetGeometry.rubberLimit)
        // Pulling down keeps the height and moves the panel.
        let lowered = g.frame(detents: [.large], current: .large, translation: 80)
        #expect(lowered.height == large && lowered.offset == 80)
    }

    @Test func sheetReleaseChoosesStopOrDismisses() {
        let g = OrbisSheetGeometry(available: 759, reference: 793, bottomInset: 34)
        let both: [OrbisSheetGeometry.Detent] = [.medium, .large]
        let gap = g.height(.large) - g.height(.medium)
        // Slow releases go to the nearest stop.
        #expect(g.settle(detents: both, current: .medium, translation: -gap * 0.6, velocity: 0) == .detent(.large))
        #expect(g.settle(detents: both, current: .medium, translation: -gap * 0.3, velocity: 0) == .detent(.medium))
        #expect(g.settle(detents: both, current: .large, translation: gap * 0.6, velocity: 0) == .detent(.medium))
        // A short pull from the smallest stop springs back; the dismissal distance closes.
        #expect(g.settle(detents: [.large], current: .large, translation: 60, velocity: 0) == .detent(.large))
        #expect(g.settle(detents: [.large], current: .large, translation: 120, velocity: 0) == .dismiss)
        // Flings move one stop: large -> medium first, then medium -> dismissed.
        #expect(g.settle(detents: both, current: .large, translation: 20, velocity: 1500) == .detent(.medium))
        #expect(g.settle(detents: both, current: .medium, translation: 20, velocity: 1500) == .dismiss)
        #expect(g.settle(detents: both, current: .medium, translation: -10, velocity: -1500) == .detent(.large))
        // Flicking down after pulling up only returns to the current stop.
        #expect(g.settle(detents: both, current: .medium, translation: -30, velocity: 1500) == .detent(.medium))
        // Keyboard-equalized stops keep the current one.
        let typing = OrbisSheetGeometry(available: 457, reference: 793, keyboard: true)
        #expect(typing.settle(detents: both, current: .large, translation: 10, velocity: 0) == .detent(.large))
    }
}
