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
}
