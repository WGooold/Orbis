import Foundation
import CoreGraphics
import Testing
@testable import OrbisCore

struct MotionGeometryTests {
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
