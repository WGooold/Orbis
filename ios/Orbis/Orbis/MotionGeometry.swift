import Foundation
import CoreGraphics

/// ADR-0058. Pure geometry shared by selection, send feedback and edge navigation.
enum MotionGeometry {
    static let sendTravelDuration = 0.28
    static let sendExpandDuration = 0.16
    static let sendDuration = sendTravelDuration + sendExpandDuration
    static let sendArrival = sendTravelDuration / sendDuration

    /// Fast departure, progressively smaller steps, and zero velocity at the destination.
    /// Keep the animation clock linear; this curve is applied once to each spatial stage.
    static func sendEaseOut(_ progress: CGFloat) -> CGFloat {
        let remaining = 1 - min(1, max(0, progress))
        return 1 - remaining * remaining * remaining
    }

    /// The compact message arrives at the row's bottom-right, then unfolds in place.
    /// Only the travelling preview is height-limited; the last frame is the full bubble.
    static func sendFrame(from source: CGRect, to target: CGRect, progress: CGFloat) -> CGRect {
        let p = min(1, max(0, progress))
        let compact = CGSize(width: min(source.width, target.width) * 0.86,
                             height: min(72, source.height, target.height * 0.86))
        let landing = CGRect(x: target.maxX - compact.width, y: target.maxY - compact.height,
                             width: compact.width, height: compact.height)
        if p < sendArrival {
            let travel = p / sendArrival
            let center = sendPoint(from: CGPoint(x: source.midX, y: source.midY),
                                   to: CGPoint(x: landing.midX, y: landing.midY), progress: travel)
            let narrow = sendEaseOut(travel / 0.25)
            let size = CGSize(width: source.width + (compact.width - source.width) * narrow,
                              height: source.height + (compact.height - source.height) * narrow)
            return CGRect(x: center.x - size.width / 2, y: center.y - size.height / 2,
                          width: size.width, height: size.height)
        }
        let t = (p - sendArrival) / (1 - sendArrival)
        let eased = sendEaseOut(t)
        let size = CGSize(width: compact.width + (target.width - compact.width) * eased,
                          height: compact.height + (target.height - compact.height) * eased)
        return CGRect(x: target.maxX - size.width, y: target.maxY - size.height,
                      width: size.width, height: size.height)
    }

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
            let t = sendEaseOut(p / 0.25)
            return CGPoint(x: from.x + (bend.x - from.x) * t, y: from.y)
        }
        let t = sendEaseOut((p - 0.25) / 0.75)
        return CGPoint(x: bend.x + (to.x - bend.x) * t, y: from.y + (to.y - from.y) * t)
    }
}
