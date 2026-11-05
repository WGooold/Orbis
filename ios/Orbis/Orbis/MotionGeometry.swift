import Foundation
import CoreGraphics

/// ADR-0058. Pure geometry shared by selection, send feedback and edge navigation.
enum MotionGeometry {
    static let replyGrowthDuration = 0.18
    static let replyArrivalDuration = 0.22
    static let glyphPressDuration = 0.08
    static let glyphReleaseDuration = 0.16
    static let glyphPressedScale = 0.94
    static let glyphPressedOpacity = 0.82
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

/// Only append-only live content may animate its natural height. Disclosures, reflow,
/// rewrites and history are separate operations and must not inherit a streaming animation.
struct ReplyCardPart: Equatable {
    let id: String
    let text: String
}

struct ReplyCardGrowth {
    private var size: CGSize?
    private var parts: [ReplyCardPart] = []
    private var live = false
    private(set) var animates = false

    mutating func update(size next: CGSize, parts nextParts: [ReplyCardPart], live nextLive: Bool,
                         reduced: Bool, entering: Bool = false) -> Bool {
        let appended = nextParts != parts && nextParts.count >= parts.count && zip(parts, nextParts).allSatisfy {
            $0.id == $1.id && $1.text.hasPrefix($0.text)
        }
        if let size {
            if reduced || next.width != size.width || (!appended && nextParts != parts) {
                animates = false
            } else if next.height != size.height {
                animates = next.height > size.height && appended && (live || nextLive)
            }
            // Same-height tokens keep the running transition and never restart it.
        } else {
            animates = entering && !reduced
        }
        size = next; parts = nextParts; live = nextLive
        return animates
    }
}

/// An explicit presentation height lets a rewrite snap even when the new target equals
/// the old target. Retargeting samples the current frame instead of restarting at the old size.
struct ReplyCardHeight {
    private(set) var target: CGFloat?
    private var start: CGFloat = 0
    private var started: TimeInterval = 0
    private var duration: TimeInterval = 0

    func value(at time: TimeInterval) -> CGFloat? {
        guard let target else { return nil }
        guard duration > 0 else { return target }
        let fraction = min(1, max(0, (time - started) / duration))
        // Invert the x coordinate of cubic-bezier(0.2, 0, 0, 1).
        var low = 0.0, high = 1.0
        for _ in 0..<20 {
            let t = (low + high) / 2, remaining = 1 - t
            let x = 0.6 * remaining * remaining * t + t * t * t
            if x < fraction { low = t } else { high = t }
        }
        let t = (low + high) / 2
        let eased = fraction == 0 ? 0 : fraction == 1 ? 1 : 3 * (1 - t) * t * t + t * t * t
        return start + (target - start) * eased
    }

    func isAnimating(at time: TimeInterval) -> Bool {
        target != nil && start != target && time < started + duration
    }

    mutating func retarget(_ next: CGFloat, at time: TimeInterval, animated: Bool,
                          duration nextDuration: TimeInterval, initial: CGFloat? = nil) {
        if animated && target == next { return }
        start = animated ? (value(at: time) ?? initial ?? next) : next
        target = next; started = time; duration = animated ? nextDuration : 0
    }
}

/// Page-local, bounded arrival tickets. A lazy row may consume a ticket once, promptly;
/// scrolling back to it, replacing live IDs or loading an old page cannot replay entry.
final class ReplyCardArrivals {
    private var previous: [String]?
    private var members: Set<String> = []
    private var ready = false
    private var tickets: [String: TimeInterval] = [:]

    func observe(rows: [(id: String, members: [String])], ready nextReady: Bool,
                 following: Bool, now: TimeInterval) {
        let ids = rows.map(\.id)
        tickets = tickets.filter { now - $0.value <= MotionGeometry.replyArrivalDuration && ids.contains($0.key) }
        if let previous, ready && nextReady && following,
           ids.count > previous.count, Array(ids.prefix(previous.count)) == previous {
            for row in rows.dropFirst(previous.count) where Set(row.members).isDisjoint(with: members) {
                tickets[row.id] = now
            }
        }
        if !nextReady || !following { tickets.removeAll() }
        previous = ids; members = Set(rows.flatMap(\.members)); ready = nextReady
    }

    func claim(_ id: String, now: TimeInterval) -> Bool {
        guard let start = tickets.removeValue(forKey: id) else { return false }
        return now - start <= MotionGeometry.replyArrivalDuration
    }
}

/// Physical release/cancel always wins over decorative activation. No minimum press hold.
struct GlyphFeedbackState {
    enum Response { case press, release, activate, reset }
    private var lastActivation: Int?
    private var physicalCycle = false

    mutating func update(pressed: Bool, activation: Int, enabled: Bool) -> Response {
        let activated = lastActivation.map { $0 != activation } ?? false
        lastActivation = activation
        guard enabled else { physicalCycle = false; return .reset }
        if pressed { physicalCycle = true; return .press }
        if physicalCycle { return .release }
        return activated ? .activate : .reset
    }

    mutating func released() { physicalCycle = false }
}
