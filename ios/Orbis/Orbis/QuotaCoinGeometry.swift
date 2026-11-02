import Foundation
import CoreGraphics

/// S19 / ADR-0058 QuotaCoin. Native projection of the promotional film's solid coin.
/// Coordinates are in the existing 44pt face; the 64×56pt touch slot never transforms.
enum QuotaCoinGeometry {
    static let diameter = 44.0
    static let halfDepth = 4.6 * diameter / 48
    static let perspective = 190 * diameter / 48
    static let outgoingDuration = 0.22
    static let incomingDuration = 0.34
    static let rimBands = 13
    private static let axisX = -sin(24 * Double.pi / 180)
    private static let axisY = cos(24 * Double.pi / 180)
    private static let circumference = (0..<64).map { index in
        let a = Double(index) * 2 * Double.pi / 64
        return CGPoint(x: cos(a) * diameter / 2, y: sin(a) * diameter / 2)
    }

    /// A linear clock for each half-turn, matching GSAP power2.in / power3.out.
    static func angle(phase: Double) -> Double {
        let p = min(180, max(0, phase))
        if p <= 90 { return 90 * pow(p / 90, 3) }
        return 180 - 90 * pow((180 - p) / 90, 4)
    }

    /// Row-major homography. Points include their 22pt center; depth is towards the viewer.
    /// Normalization keeps the resting face exactly 44pt at both ends of a turn.
    static func projection(angle: Double, depth: Double) -> [Double] {
        let a = angle * .pi / 180, c = cos(a), s = sin(a), k = 1 - c
        let xx = c + axisX * axisX * k, xy = axisX * axisY * k, xz = axisY * s
        let yy = c + axisY * axisY * k, yz = -axisX * s
        let zx = -axisY * s, zy = axisX * s
        let center = diameter / 2, scale = (perspective - halfDepth) / perspective
        let wx = -zx / perspective, wy = -zy / perspective
        let w = 1 + (zx + zy) * center / perspective - c * depth / perspective
        return [scale * xx + center * wx, scale * xy + center * wy,
                scale * (xz * depth - (xx + xy) * center) + center * w,
                scale * xy + center * wx, scale * yy + center * wy,
                scale * (yz * depth - (xy + yy) * center) + center * w,
                wx, wy, w]
    }

    static func project(_ point: CGPoint, with m: [Double]) -> CGPoint {
        let x = Double(point.x), y = Double(point.y), w = m[6] * x + m[7] * y + m[8]
        return CGPoint(x: (m[0] * x + m[1] * y + m[2]) / w,
                       y: (m[3] * x + m[4] * y + m[5]) / w)
    }

    /// The reverse face is mounted around the same diagonal axis, so its mark rests upright.
    static func faceProjection(angle: Double) -> [Double] {
        projection(angle: angle > 90 ? angle - 180 : angle, depth: halfDepth)
    }

    static func faceVisible(angle: Double) -> Bool {
        // Perspective sees the raised face edge slightly before 90°; cull its back as well.
        abs(cos(angle * .pi / 180)) > halfDepth / perspective
    }

    struct Band {
        let points: [CGPoint]
        let brightness: Double
    }

    /// Filled cylindrical slices, not stacked zero-width planes: even exactly at 90° the
    /// edge stays solid. Draw far to near and cover with only the camera-facing quota face.
    static func bands(angle: Double) -> [Band] {
        let order = cos(angle * .pi / 180) >= 0 ? Array(0..<rimBands) : Array((0..<rimBands).reversed())
        return order.map { index in
            let depths = [Double(index), Double(index + 1)].map { -halfDepth + $0 * 2 * halfDepth / Double(rimBands) }
            let points = depths.flatMap { depth in
                let matrix = projection(angle: angle, depth: depth)
                return circumference.map { project(CGPoint(x: $0.x + diameter / 2, y: $0.y + diameter / 2), with: matrix) }
            }
            return Band(points: hull(points), brightness: 0.82 + 0.3 * exp(-pow((Double(index) - 6) / 3, 2)))
        }
    }

    private static func hull(_ points: [CGPoint]) -> [CGPoint] {
        let sorted = points.sorted { $0.x == $1.x ? $0.y < $1.y : $0.x < $1.x }
        func cross(_ a: CGPoint, _ b: CGPoint, _ c: CGPoint) -> CGFloat {
            (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)
        }
        func chain(_ points: [CGPoint]) -> [CGPoint] {
            var result: [CGPoint] = []
            for point in points {
                while result.count >= 2 && cross(result[result.count - 2], result[result.count - 1], point) <= 0 {
                    result.removeLast()
                }
                result.append(point)
            }
            return Array(result.dropLast())
        }
        return chain(sorted) + chain(sorted.reversed())
    }
}
