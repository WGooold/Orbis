import Foundation
import CoreGraphics

/// ADR-0058. Pure geometry shared by selection, send feedback and edge navigation.
enum MotionGeometry {
    static func touchOrigin(_ point: CGPoint?, size: CGSize) -> CGPoint {
        CGPoint(x: min(max(0, point?.x ?? size.width / 2), size.width),
                y: min(max(0, point?.y ?? size.height / 2), size.height))
    }

    static func revealRadius(origin: CGPoint, size: CGSize) -> CGFloat {
        hypot(max(origin.x, size.width - origin.x), max(origin.y, size.height - origin.y))
    }

    static func sendPoint(from: CGPoint, to: CGPoint, progress: CGFloat) -> CGPoint {
        let p = min(1, max(0, progress))
        let bend = CGPoint(x: max(from.x + 24, to.x), y: from.y)
        if p < 0.25 {
            let t = p / 0.25
            return CGPoint(x: from.x + (bend.x - from.x) * t, y: from.y)
        }
        let t = (p - 0.25) / 0.75
        return CGPoint(x: bend.x + (to.x - bend.x) * t, y: from.y + (to.y - from.y) * t)
    }
}
