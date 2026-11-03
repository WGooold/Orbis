import Foundation
import CoreGraphics
import Testing
@testable import OrbisCore

struct QuotaCoinGeometryTests {
    @Test func contactShadowStaysVisibleAndInsideTheWellThroughoutBothDirections() {
        let resting = QuotaCoinGeometry.shadow(angle: 0)
        let side = QuotaCoinGeometry.shadow(angle: 90)
        #expect(side.widthScale < resting.widthScale)
        for angle in stride(from: 0.0, through: 180.0, by: 1) {
            let shadow = QuotaCoinGeometry.shadow(angle: angle)
            let reverse = QuotaCoinGeometry.shadow(angle: 180 - angle)
            #expect(shadow.opacityScale > 0 && shadow.opacityScale <= 1)
            #expect(abs(shadow.widthScale - reverse.widthScale) < 0.0001)
            // The complete soft footprint fits the 56pt well, not only its opaque center.
            let x = QuotaCoinGeometry.shadowDiameter / 2 * shadow.widthScale
            let y = QuotaCoinGeometry.shadowOffsetY
            let radiusY = QuotaCoinGeometry.shadowHeight / 2
            for t in stride(from: 0.0, through: 2 * Double.pi, by: 0.05) {
                #expect(hypot(x * cos(t), y + radiusY * sin(t)) < 28)
            }
        }
    }

    @Test func bothFacesLandUprightAtTheOriginalSize() {
        for angle in [0.0, 180.0] {
            let matrix = QuotaCoinGeometry.faceProjection(angle: angle)
            for point in [CGPoint.zero, CGPoint(x: 44, y: 0), CGPoint(x: 22, y: 22), CGPoint(x: 44, y: 44)] {
                let projected = QuotaCoinGeometry.project(point, with: matrix)
                #expect(hypot(projected.x - point.x, projected.y - point.y) < 0.0001)
            }
        }
    }

    @Test func aSideOnCoinHasASolidEightPointEdgeInsteadOfDisappearing() {
        let bands = QuotaCoinGeometry.bands(angle: 90)
        #expect(bands.count == 13)
        var projectedWidth: [Double] = []
        for band in bands {
            let points = band.points
            let area = abs(zip(points, Array(points.dropFirst()) + [points[0]])
                .reduce(0.0) { $0 + $1.0.x * $1.1.y - $1.1.x * $1.0.y }) / 2
            #expect(area > 20) // Each depth slice is filled, not a zero-width transformed disc.
            projectedWidth += points.map { Double($0.x) * cos(24 * .pi / 180) + Double($0.y) * sin(24 * .pi / 180) }
        }
        let width = projectedWidth.max()! - projectedWidth.min()!
        #expect(width > 8 && width < 10)
    }

    @Test func rotationIsBoundedAndTheVisibleFaceNeverMirrors() {
        #expect(!QuotaCoinGeometry.faceVisible(angle: 90))
        for angle in stride(from: 0.0, through: 180.0, by: 3) {
            let m = QuotaCoinGeometry.faceProjection(angle: angle)
            let origin = QuotaCoinGeometry.project(.zero, with: m)
            let x = QuotaCoinGeometry.project(CGPoint(x: 44, y: 0), with: m)
            let y = QuotaCoinGeometry.project(CGPoint(x: 0, y: 44), with: m)
            if QuotaCoinGeometry.faceVisible(angle: angle) {
                #expect((x.x - origin.x) * (y.y - origin.y) - (x.y - origin.y) * (y.x - origin.x) > 0)
            }
            for point in QuotaCoinGeometry.bands(angle: angle).flatMap(\.points) {
                #expect(point.x.isFinite && point.y.isFinite)
                #expect(point.x >= -1 && point.x <= 45)
                #expect(point.y >= -1 && point.y <= 45)
            }
        }
    }

    @Test func filmTimingAcceleratesOutAndDeceleratesToAnExactRest() {
        #expect(QuotaCoinGeometry.angle(phase: -1) == 0)
        #expect(QuotaCoinGeometry.angle(phase: 45) == 11.25)
        #expect(QuotaCoinGeometry.angle(phase: 90) == 90)
        #expect(QuotaCoinGeometry.angle(phase: 135) == 174.375)
        #expect(QuotaCoinGeometry.angle(phase: 181) == 180)
        #expect(abs(QuotaCoinGeometry.outgoingDuration + QuotaCoinGeometry.incomingDuration - 0.56) < 0.0001)
        let values = (0...180).map { QuotaCoinGeometry.angle(phase: Double($0)) }
        #expect(zip(values, values.dropFirst()).allSatisfy { $1 >= $0 })
        #expect(values[180] - values[179] < 0.001)
    }
}
