import Foundation
import CoreGraphics

/// PERF-11: scrolling only publishes viewport boundary crossings. Pixel offsets
/// are native scroll state; the chat needs visibility, paging and question facts.
struct ChatViewportFacts: Equatable {
    struct Question: Equatable {
        let id: String
        let outside: Bool
    }
    var hasVisibleRows = false
    var firstRowNearTop = false
    var question: Question?

    init() {}
    init(frame: CGRect, viewportHeight: CGFloat, firstRow: Bool, questionID: String?) {
        hasVisibleRows = frame.maxY > 0 && frame.minY < viewportHeight
        firstRowNearTop = firstRow && frame.minY >= -40 && frame.minY < viewportHeight
        if let questionID {
            question = Question(id: questionID, outside: frame.maxY < -8 || frame.minY > viewportHeight + 8)
        }
    }

    mutating func merge(_ next: Self) {
        hasVisibleRows = hasVisibleRows || next.hasVisibleRows
        firstRowNearTop = firstRowNearTop || next.firstRowNearTop
        question = next.question ?? question
    }

    func questionOutsideViewport(_ id: String?) -> Bool {
        guard hasVisibleRows, let id else { return false }
        // A lazily released question is outside. A previous question's geometry
        // cannot stand in for a newly published question with a different identity.
        guard let question, question.id == id else { return true }
        return question.outside
    }
}

/// IOS-CHAT-04: discrete reading policy. Native scroll adapters retain pixel geometry and
/// anchors; this value changes only when intent, a threshold or a paging edge changes.
struct ChatViewportPolicy: Equatable {
    static let line: CGFloat = 20

    enum Mode: Equatable { case following, reading, interacting }
    enum Target: Equatable { case latest, question(String) }
    struct Request: Equatable {
        let target: Target
        let sequence: Int
        let contextGeneration: Int
        let interactionGeneration: Int
    }

    private(set) var mode: Mode = .following
    private(set) var hasPositioned = false
    private(set) var hasBrowsed = false
    private(set) var lastScrollTowardEarlier = false
    private(set) var questionOutsideViewport = false
    private(set) var suppressQuestionPaging = false
    private(set) var awaitingOlderPage = false
    private(set) var topArmed = false
    private(set) var showJump = false
    private(set) var request: Request?
    private(set) var contextGeneration = 0
    private(set) var interactionGeneration = 0
    private var requestSequence = 0

    var following: Bool { mode == .following }
    var showQuestionReminder: Bool {
        hasPositioned && hasBrowsed && lastScrollTowardEarlier && showJump && questionOutsideViewport
    }

    mutating func distanceChanged(_ distance: CGFloat, hasMessages: Bool, firstRowNearTop: Bool) {
        if distance.isFinite && !hasPositioned && hasMessages {
            hasPositioned = true
            if !firstRowNearTop { topArmed = true }
        }
        updateJump(distance)
    }

    /// Consume the edge even while a business read is blocked. Completion cannot replay
    /// a top position: the reader must leave this boundary before it can arm again.
    mutating func viewportChanged(_ viewport: ChatViewportFacts, questionID: String?, canPage: Bool) -> Bool {
        questionChanged(outside: viewport.questionOutsideViewport(questionID))
        guard viewport.firstRowNearTop else { topArmed = hasPositioned; return false }
        guard topArmed else { return false }
        topArmed = false
        return canPage && !suppressQuestionPaging && !awaitingOlderPage
    }

    mutating func questionChanged(outside: Bool) { questionOutsideViewport = outside }
    mutating func directionChanged(towardEarlier: Bool) { lastScrollTowardEarlier = towardEarlier }

    mutating func interactionChanged(_ active: Bool, bottomDistance: CGFloat) {
        if active {
            if mode != .interacting { interactionGeneration += 1 }
            mode = .interacting
            hasBrowsed = true
            suppressQuestionPaging = false
            request = nil
        } else {
            // Programmatic scrolling and disclosure layout also report idle. Only a real
            // native user interaction may finish by restoring bottom following.
            guard mode == .interacting else { return }
            mode = bottomDistance <= Self.line ? .following : .reading
            if following { hasBrowsed = false }
        }
        updateJump(bottomDistance)
    }

    /// Called synchronously between native freeze and the disclosure's height mutation.
    mutating func disclosureBegan(bottomDistance: CGFloat) {
        interactionGeneration += 1
        mode = .reading
        request = nil
        updateJump(bottomDistance)
    }

    mutating func jumpToLatest() {
        mode = .following
        hasBrowsed = false
        suppressQuestionPaging = false
        showJump = false
        makeRequest(.latest)
    }

    mutating func locateQuestion(_ id: String, bottomDistance: CGFloat) {
        mode = .reading
        suppressQuestionPaging = true
        makeRequest(.question(id))
        updateJump(bottomDistance)
    }

    mutating func olderPageAccepted(bottomDistance: CGFloat) {
        awaitingOlderPage = true
        // Paging does not end a gesture already in flight. Native idle still belongs
        // to that reader, including when they keep moving while the page is loading.
        if mode != .interacting { mode = .reading }
        request = nil
        updateJump(bottomDistance)
    }

    mutating func olderPageFinished() { awaitingOlderPage = false }

    /// A branch or source owner changed. Editor state and native anchoring are not owned
    /// here, and resetting this value never issues a programmatic scroll request.
    mutating func resetContext() {
        let generation = contextGeneration + 1, sequence = requestSequence
        self = Self()
        contextGeneration = generation
        requestSequence = sequence
    }

    func owns(_ candidate: Request) -> Bool {
        request == candidate && candidate.contextGeneration == contextGeneration &&
            candidate.interactionGeneration == interactionGeneration
    }

    private mutating func makeRequest(_ target: Target) {
        requestSequence += 1
        request = Request(target: target, sequence: requestSequence, contextGeneration: contextGeneration,
                          interactionGeneration: interactionGeneration)
    }

    private mutating func updateJump(_ distance: CGFloat) {
        showJump = !following && distance > Self.line * 3
    }
}

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

/// IOS-CHAT-05: network polling follows the top page at rest; visual work also
/// includes the source revealed during a return and uses orbisVisible instead.
struct OrbisPageActivity: Equatable {
    let isTop: Bool
    let isStationary: Bool
    let hasArrived: Bool

    func pollsGit(sceneActive: Bool) -> Bool { sceneActive && isTop && isStationary && hasArrived }
}

/// Parser completion can lag visibility. Keep the newest hidden source as a
/// baseline until its prepared document (or a foreground successor) is consumed.
struct OrbisRevealCatchUp {
    private(set) var hiddenSource: String?

    mutating func sourceChanged(_ source: String, active: Bool) {
        if !active { hiddenSource = source }
    }

    mutating func visibilityChanged(active: Bool, source: String, preparedSource: String?) {
        if !active { hiddenSource = source }
        else if let preparedSource { consumeIfCaughtUp(preparedSource, currentSource: source) }
    }

    mutating func allowsReveal(preparedSource: String?, currentSource: String, active: Bool) -> Bool {
        guard active else { return false }
        guard hiddenSource != nil else { return true }
        if let preparedSource { consumeIfCaughtUp(preparedSource, currentSource: currentSource) }
        return false
    }

    private mutating func consumeIfCaughtUp(_ prepared: String, currentSource: String) {
        guard let hiddenSource else { return }
        if prepared == hiddenSource || prepared.hasPrefix(hiddenSource) || prepared == currentSource {
            self.hiddenSource = nil
        }
    }
}

/// A paused periodic schedule emits its current frame once and owns no future
/// ticks. The SwiftUI adapter supplies the current absolute start on resumption.
struct OrbisPeriodicEntries: Sequence {
    let start: Date
    let interval: TimeInterval
    let paused: Bool

    init(start: Date, interval: TimeInterval, paused: Bool) {
        self.start = start; self.interval = interval.isFinite && interval > 0 ? interval : 1; self.paused = paused
    }
    struct Iterator: IteratorProtocol {
        var nextDate: Date?
        let interval: TimeInterval
        let paused: Bool
        mutating func next() -> Date? {
            guard let value = nextDate else { return nil }
            nextDate = paused ? nil : value.addingTimeInterval(interval)
            return value
        }
    }
    func makeIterator() -> Iterator { Iterator(nextDate: start, interval: interval, paused: paused) }
}

/// Decorative work queued before hide/cancel cannot revive after a later show.
struct OrbisVisualWorkGate {
    private(set) var active = true
    private(set) var generation = 0
    mutating func setActive(_ value: Bool) {
        guard active != value else { return }
        active = value; invalidate()
    }
    mutating func invalidate() { generation &+= 1 }
    func permits(_ captured: Int) -> Bool { active && captured == generation }
}

/// IOS-CHAT-03: the editor owns its natural height at one remaining width. The
/// side actions keep their measured touch targets and all three children share a bottom edge.
struct ChatComposerRowGeometry: Equatable {
    static let spacing: CGFloat = 10
    let size: CGSize
    let leading: CGRect
    let editor: CGRect
    let trailing: CGRect

    static func finiteWidth(_ width: CGFloat?) -> CGFloat? {
        guard let width, width.isFinite else { return nil }
        return max(0, width)
    }

    static func editorWidth(in rowWidth: CGFloat?, leading: CGSize, trailing: CGSize) -> CGFloat? {
        guard let rowWidth = finiteWidth(rowWidth) else { return nil }
        return max(0, rowWidth - finiteSize(leading).width - finiteSize(trailing).width - 2 * spacing)
    }

    init(proposedWidth: CGFloat?, leading: CGSize, editor: CGSize, trailing: CGSize) {
        let leading = Self.finiteSize(leading), editor = Self.finiteSize(editor), trailing = Self.finiteSize(trailing)
        let editorWidth = Self.editorWidth(in: proposedWidth, leading: leading, trailing: trailing) ?? editor.width
        let height = max(leading.height, editor.height, trailing.height)
        let occupiedWidth = leading.width + 2 * Self.spacing + trailing.width
        size = CGSize(width: max(Self.finiteWidth(proposedWidth) ?? occupiedWidth + editorWidth, occupiedWidth), height: height)
        self.leading = CGRect(x: 0, y: height - leading.height, width: leading.width, height: leading.height)
        self.editor = CGRect(x: leading.width + Self.spacing, y: height - editor.height, width: editorWidth, height: editor.height)
        self.trailing = CGRect(x: self.editor.maxX + Self.spacing, y: height - trailing.height, width: trailing.width, height: trailing.height)
    }

    private static func finiteSize(_ size: CGSize) -> CGSize {
        CGSize(width: size.width.isFinite ? max(0, size.width) : 0,
               height: size.height.isFinite ? max(0, size.height) : 0)
    }
}

/// Layout validity owns these entries. A child/environment update invalidates both;
/// a changed parent height alone does not change the editor's width/natural-height proposal.
struct ChatComposerRowCache<Value> {
    private var ideal: Value?
    private var constrained: (width: CGFloat, value: Value)?

    func value(for width: CGFloat?) -> Value? {
        guard let width else { return ideal }
        return constrained?.width == width ? constrained?.value : nil
    }

    mutating func store(_ value: Value, for width: CGFloat?) {
        if let width { constrained = (width, value) } else { ideal = value }
    }

    mutating func invalidate() { self = Self() }
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
