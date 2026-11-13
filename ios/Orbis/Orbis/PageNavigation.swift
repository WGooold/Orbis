import SwiftUI
import UIKit

// ADR-0054 / M14: every full page is a mounted layer above the page it came from. The root and
// every pushed page stay in one SwiftUI tree; nothing is captured, re-hosted or rebuilt, so a
// return reveals the real source with its reading position, draft and live updates.
// Motion follows the interaction draft and Android's OrbisPageHost: a push slides in from the
// trailing edge while the source moves 24pt to the leading side under a 0.34 scrim; a drag
// returns that source in step with the finger.

/// One pushed page. The id keeps a layer's identity while pages above it come and go.
struct OrbisPageEntry<Page: Hashable>: Identifiable, Equatable {
    let id = UUID()
    let page: Page
}

/// How a page that is added on top of the current one arrives.
enum OrbisPageEntrance {
    /// Slides in from the trailing edge (M14).
    case slide
    /// Grows from a rectangle in global coordinates, the submitted draft card (S35 / M27).
    case expand(CGRect)
    /// Appears at once.
    case none
}

/// Owns the page path. Layers keep their own state; the stack only decides which page is on top
/// and runs the one motion that can be in flight.
@MainActor
final class OrbisPageStack<Page: Hashable>: ObservableObject {
    @Published private(set) var entries: [OrbisPageEntry<Page>]
    /// Shared with the moving layer and its source only; the rest of the tree never reads it.
    let motion = OrbisPageMotion()
    private var arrival: (() -> Void)?

    var pages: [Page] { entries.map(\.page) }

    init(_ pages: [Page] = []) { entries = pages.map { OrbisPageEntry(page: $0) } }

    func push(_ page: Page) { replace(with: pages + [page]) }

    /// The unchanged prefix keeps its mounted layers. Only a single page added on top of the
    /// current path animates; any other change applies at once.
    func replace(with pages: [Page], entrance: OrbisPageEntrance = .slide, onArrival: (() -> Void)? = nil) {
        settleNow()
        var kept = 0
        while kept < min(entries.count, pages.count) && entries[kept].page == pages[kept] { kept += 1 }
        let next = Array(entries.prefix(kept)) + pages[kept...].map { OrbisPageEntry(page: $0) }
        guard next.map(\.id) != entries.map(\.id) else { onArrival?(); return }
        let addsOne = kept == entries.count && next.count == kept + 1
        if case .expand = entrance {} else if addsOne {
            // A covered page must not keep the keyboard; the expanding draft releases its own.
            UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
        }
        var mode = addsOne ? entrance : .none
        if motion.reduceMotion || motion.width <= 0 { mode = .none }
        orbisWithoutAnimation {
            switch mode {
            case .slide: motion.prepare(next[kept].id, phase: .entering, offset: motion.width)
            case .expand(let global): motion.prepare(next[kept].id, phase: .expanding, origin: motion.local(global))
            case .none: break
            }
            entries = next
        }
        if case .none = mode { onArrival?() } else { arrival = onArrival }
    }

    /// A page's own back control: the same committed slide a released swipe runs.
    func requestBack() {
        guard let top = entries.last else { return }
        switch motion.phase {
        case .returning: return
        case .entering, .expanding: settleNow()
        default: break
        }
        if motion.movingID != top.id { orbisWithoutAnimation { motion.prepare(top.id, phase: .settling, offset: 0) } }
        settle(top.id, back: true, velocity: 0)
    }

    /// Removes the top page at once, without a transition.
    func back() {
        settleNow()
        guard !entries.isEmpty else { return }
        orbisWithoutAnimation { entries.removeLast() }
    }

    // MARK: Layer callbacks

    /// Starts a prepared entrance once its layer is mounted at the starting position.
    fileprivate func arrive(_ id: UUID) {
        guard motion.movingID == id else { return }
        let token = motion.token
        switch motion.phase {
        case .entering:
            withAnimation(InteractionMotion.pageEnter, completionCriteria: .logicallyComplete) {
                motion.offset = 0
            } completion: { [weak self] in self?.finishArrival(token) }
        case .expanding:
            withAnimation(InteractionMotion.pageEnter, completionCriteria: .logicallyComplete) {
                motion.expansion = 1
            } completion: { [weak self] in self?.finishArrival(token) }
        default: break
        }
    }

    fileprivate func canDrag(_ id: UUID) -> Bool {
        guard entries.last?.id == id else { return false }
        switch motion.phase {
        case .entering, .expanding, .returning: return false
        case .idle, .dragging, .settling: return true
        }
    }

    fileprivate func drag(_ id: UUID, translation: CGFloat) {
        guard canDrag(id) else { return }
        let width = motion.width
        let distance = max(0, translation)
        motion.token += 1
        motion.movingID = id
        motion.phase = .dragging
        motion.offset = distance > width ? width + (distance - width) * 0.18 : distance
    }

    fileprivate func release(_ id: UUID, velocity: CGFloat) {
        guard motion.movingID == id, motion.phase == .dragging else { return }
        settle(id, back: motion.offset + velocity * 0.15 > motion.width / 3, velocity: velocity)
    }

    /// The system cancelled the drag: the page returns to rest.
    fileprivate func cancelDrag(_ id: UUID) {
        guard motion.movingID == id, motion.phase == .dragging else { return }
        settle(id, back: false, velocity: 0)
    }

    // MARK: Motion

    private func settle(_ id: UUID, back: Bool, velocity: CGFloat) {
        motion.token += 1
        let token = motion.token
        motion.phase = back ? .returning : .settling
        #if DEBUG
        if back { PageReturnProbe.shared.begin() }
        #endif
        let width = motion.width
        let target = back ? width : 0
        // Never leave a page on screen waiting for an invisible spring tail once it is gone.
        if motion.reduceMotion || width <= 0 || (back && motion.offset >= width) {
            orbisWithoutAnimation { motion.offset = target }
            complete(id, back: back, token: token)
            return
        }
        let distance = target - motion.offset
        let initialVelocity = abs(distance) > 1 ? max(-8, min(8, velocity / distance)) : 0
        let animation = back ? InteractionMotion.pageReturn : .orbisSwipeBack(velocity: Double(initialVelocity))
        withAnimation(animation, completionCriteria: back ? .logicallyComplete : .removed) {
            motion.offset = target
        } completion: { [weak self] in self?.complete(id, back: back, token: token) }
    }

    private func complete(_ id: UUID, back: Bool, token: Int) {
        guard motion.token == token else { return }
        orbisWithoutAnimation {
            if back { entries.removeAll { $0.id == id } }
            motion.reset()
        }
        #if DEBUG
        if back { PageReturnProbe.shared.committed() }
        #endif
    }

    private func finishArrival(_ token: Int) {
        guard motion.token == token else { return }
        orbisWithoutAnimation { motion.reset() }
        let done = arrival
        arrival = nil
        done?()
    }

    /// Ends whatever is in flight where it was heading, so a new path starts from rest.
    private func settleNow() {
        guard let id = motion.movingID else { return }
        let returning = motion.phase == .returning
        orbisWithoutAnimation {
            if returning { entries.removeAll { $0.id == id } }
            motion.reset()
        }
        let done = arrival
        arrival = nil
        done?()
    }
}

/// The single motion in flight. Only the moving layer and the layer directly below it read the
/// observed values, so a drag redraws two layers and never re-evaluates page content.
@MainActor @Observable
final class OrbisPageMotion {
    enum Phase: Equatable { case idle, entering, expanding, dragging, settling, returning }

    fileprivate(set) var movingID: UUID?
    fileprivate(set) var phase: Phase = .idle
    /// Horizontal offset of the moving layer; 0 covers its source, `width` reveals it.
    fileprivate(set) var offset: CGFloat = 0
    /// Shape progress of an expanding page; 1 is the full page.
    fileprivate(set) var expansion: CGFloat = 1
    /// Expansion origin in host coordinates.
    fileprivate(set) var origin: CGRect?
    fileprivate(set) var width: CGFloat = 0
    @ObservationIgnored fileprivate(set) var insets = EdgeInsets()
    @ObservationIgnored fileprivate var frame: CGRect = .zero
    @ObservationIgnored fileprivate var reduceMotion = false
    @ObservationIgnored fileprivate var token = 0

    fileprivate func prepare(_ id: UUID, phase: Phase, offset: CGFloat = 0, origin: CGRect? = nil) {
        token += 1
        movingID = id
        self.phase = phase
        self.offset = offset
        self.origin = origin
        expansion = origin == nil ? 1 : 0
    }

    fileprivate func reset() {
        token += 1
        movingID = nil
        phase = .idle
        offset = 0
        expansion = 1
        origin = nil
    }

    fileprivate func layout(frame: CGRect, insets: EdgeInsets) {
        self.frame = frame
        self.insets = insets
        if width != frame.width { width = frame.width }
    }

    fileprivate func local(_ global: CGRect) -> CGRect { global.offsetBy(dx: -frame.minX, dy: -frame.minY) }

    /// How uncovered the layer below the moving one is: 0 fully covered, 1 fully revealed.
    fileprivate var sourceProgress: CGFloat {
        if phase == .expanding { return 1 - expansion }
        return width > 0 ? offset / width : 1
    }
}

/// The full-page navigation boundary. Sheets, menus and the drawer live outside it.
struct OrbisPageHost<Page: Hashable, Root: View, PageContent: View>: View {
    @ObservedObject var stack: OrbisPageStack<Page>
    /// The root is also unreachable while something outside the host covers it (the phone drawer).
    var rootCovered = false
    @ViewBuilder let root: () -> Root
    @ViewBuilder let page: (Page) -> PageContent
    @Environment(\.orbisReduceMotion) private var reduceMotion
    @State private var insets = EdgeInsets()

    var body: some View {
        let entries = stack.entries
        ZStack {
            root()
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .modifier(OrbisPageLayer(stack: stack, id: nil, aboveID: entries.first?.id,
                                         isTop: entries.isEmpty, unreachable: !entries.isEmpty || rootCovered))
            ForEach(Array(entries.enumerated()), id: \.element.id) { index, entry in
                let isTop = index == entries.count - 1
                page(entry.page)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .modifier(OrbisPageLayer(stack: stack, id: entry.id, aboveID: isTop ? nil : entries[index + 1].id,
                                             isTop: isTop, unreachable: !isTop))
            }
        }
        // A source moving to the leading side must not slide under the iPad directory column.
        .clipShape(HorizontalBounds(leading: insets.leading, trailing: insets.trailing))
        .onGeometryChange(for: HostGeometry.self) {
            HostGeometry(frame: $0.frame(in: .global), insets: $0.safeAreaInsets)
        } action: { geometry in
            stack.motion.layout(frame: geometry.frame, insets: geometry.insets)
            insets = geometry.insets
        }
        .onAppear { stack.motion.reduceMotion = reduceMotion }
        .onChange(of: reduceMotion) { _, reduced in stack.motion.reduceMotion = reduced }
    }

    private struct HostGeometry: Equatable {
        let frame: CGRect
        let insets: EdgeInsets
    }
}

/// Everything a mounted layer needs: its slide, its role as a source, reachability and the
/// return gesture. Applied as a modifier so motion never re-evaluates the page inside it.
private struct OrbisPageLayer<Page: Hashable>: ViewModifier {
    @Environment(\.colorScheme) private var scheme
    @Environment(\.orbisReduceMotion) private var reduceMotion
    @EnvironmentObject private var overlay: OrbisOverlay
    let stack: OrbisPageStack<Page>
    /// nil for the root.
    let id: UUID?
    /// The layer directly above; its motion reveals this one.
    let aboveID: UUID?
    let isTop: Bool
    /// Not the top page, or covered by something outside the host.
    let unreachable: Bool
    @State private var horizontalDrag: Bool?
    @State private var suppressTaps = false
    @State private var backPriority: OrbisBackPriority?
    @GestureState private var gestureActive = false

    func body(content: Content) -> some View {
        let motion = stack.motion
        let moving = id != nil && motion.movingID == id
        let source = aboveID != nil && motion.movingID == aboveID
        // A covered layer rests at the fully covered state, so starting a return from it is
        // continuous, and handing it the top after a return changes no pixel.
        let reveal: CGFloat = source ? motion.sourceProgress : (isTop ? 1 : 0)
        let busy = moving && (motion.phase == .returning || motion.phase == .expanding)
        content
            .environment(\.orbisVisible, !unreachable || source)
            .disabled(suppressTaps)
            .clipShape(PageExpansionShape(origin: moving ? motion.origin : nil,
                                          progress: moving ? motion.expansion : 1,
                                          insets: motion.insets))
            .modifier(PageSlideEffect(offset: moving ? motion.offset : 0))
            .modifier(PageSourceShade(reveal: reveal,
                                      shifts: !reduceMotion && !(source && motion.phase == .expanding),
                                      scrim: OrbisPalette(scheme).scrim))
            .allowsHitTesting(isTop && !busy)
            .orbisAccessibilitySubtree(hidden: unreachable)
            .simultaneousGesture(drag, including: isTop && id != nil ? .all : .subviews)
            .onPreferenceChange(OrbisBackPriorityKey.self) { backPriority = $0 }
            .onChange(of: gestureActive) { _, active in
                // System interruptions may cancel a gesture without calling onEnded.
                guard !active, horizontalDrag != nil, let id else { return }
                horizontalDrag = nil
                releaseTaps()
                stack.cancelDrag(id)
            }
            .onAppear { if let id { stack.arrive(id) } }
    }

    private var drag: some Gesture {
        DragGesture(minimumDistance: 12, coordinateSpace: .global)
            .updating($gestureActive) { _, active, _ in active = true }
            .onChanged { value in
                guard let id, stack.canDrag(id) else { return }
                if horizontalDrag == nil {
                    horizontalDrag = overlay.menu == nil && overlay.dialog == nil &&
                        value.translation.width > abs(value.translation.height) * 1.5
                }
                guard horizontalDrag == true else { return }
                // Scrolling keeps working, but a control under the finger must not also fire
                // when this horizontal drag ends.
                suppressTaps = true
                // A selection consumes the swipe instead of previewing another page.
                if backPriority != nil { return }
                stack.drag(id, translation: value.translation.width)
            }
            .onEnded { value in
                let horizontal = horizontalDrag == true
                horizontalDrag = nil
                releaseTaps()
                guard horizontal, let id else { return }
                let velocity = (value.predictedEndTranslation.width - value.translation.width) / 0.2
                if let backPriority {
                    if value.translation.width + velocity * 0.15 > stack.motion.width / 3 { backPriority.action() }
                    return
                }
                stack.release(id, velocity: velocity)
            }
    }

    private func releaseTaps() {
        // Keep controls disabled through the current touch-up's action dispatch.
        DispatchQueue.main.async { suppressTaps = false }
    }
}

/// The moving layer's offset, clamped every frame: a cancel spring may overshoot its rest
/// position, but the page never travels past the leading edge.
private struct PageSlideEffect: GeometryEffect {
    var offset: CGFloat
    var animatableData: CGFloat {
        get { offset }
        set { offset = newValue }
    }
    func effectValue(size: CGSize) -> ProjectionTransform {
        ProjectionTransform(CGAffineTransform(translationX: max(0, offset), y: 0))
    }
}

/// The source under a moving page: 24pt to the leading side and a 0.34 scrim when fully
/// covered, back to rest as it is revealed. Interpolated and clamped every frame.
private struct PageSourceShade: ViewModifier, Animatable {
    var reveal: CGFloat
    let shifts: Bool
    let scrim: Color
    var animatableData: CGFloat {
        get { reveal }
        set { reveal = newValue }
    }
    func body(content: Content) -> some View {
        let covered = 1 - min(1, max(0, reveal))
        content
            .overlay {
                scrim.opacity(0.34 * covered).ignoresSafeArea()
                    .allowsHitTesting(false).accessibilityHidden(true)
            }
            .offset(x: shifts ? -24 * covered : 0)
    }
}

/// The submitted draft card's rectangle growing into the full page, safe areas included, with
/// its corner radius easing from 24 to 0. Without an origin it does not clip.
private struct PageExpansionShape: Shape {
    let origin: CGRect?
    var progress: CGFloat
    let insets: EdgeInsets
    var animatableData: CGFloat {
        get { progress }
        set { progress = newValue }
    }
    func path(in rect: CGRect) -> Path {
        guard let origin else { return Path(rect.insetBy(dx: -10_000, dy: -10_000)) }
        let full = CGRect(x: rect.minX - insets.leading, y: rect.minY - insets.top,
                          width: rect.width + insets.leading + insets.trailing,
                          height: rect.height + insets.top + insets.bottom)
        let t = min(1, max(0, progress))
        let frame = CGRect(x: origin.minX + (full.minX - origin.minX) * t,
                           y: origin.minY + (full.minY - origin.minY) * t,
                           width: origin.width + (full.width - origin.width) * t,
                           height: origin.height + (full.height - origin.height) * t)
        return Path(roundedRect: frame, cornerRadius: 24 * (1 - t))
    }
}

/// Clips horizontally to the host (plus its own leading and trailing safe areas) and leaves the
/// vertical safe-area extensions of page backgrounds untouched.
private struct HorizontalBounds: Shape {
    let leading: CGFloat
    let trailing: CGFloat
    func path(in rect: CGRect) -> Path {
        Path(CGRect(x: rect.minX - leading, y: rect.minY - 10_000,
                    width: rect.width + leading + trailing, height: rect.height + 20_000))
    }
}

extension View {
    /// A subtree that stays mounted while unreachable (a covered page, an inactive tab). Hiding
    /// alone does not stop an ancestor's explicit visibility from exposing descendants, so a
    /// hidden subtree also drops its children. Only the arguments change, so identity is kept.
    func orbisAccessibilitySubtree(hidden: Bool) -> some View {
        accessibilityElement(children: hidden ? .ignore : .contain).accessibilityHidden(hidden)
    }
}

@MainActor func orbisWithoutAnimation(_ body: () -> Void) {
    var transaction = Transaction(animation: nil)
    transaction.disablesAnimations = true
    withTransaction(transaction, body)
}
