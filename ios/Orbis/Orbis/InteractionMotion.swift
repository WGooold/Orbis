import SwiftUI

struct OrbisBackPriority: Equatable {
    let key: String
    let action: () -> Void
    static func == (lhs: Self, rhs: Self) -> Bool { lhs.key == rhs.key }
}
struct OrbisBackPriorityKey: PreferenceKey {
    static var defaultValue: OrbisBackPriority? { nil }
    static func reduce(value: inout OrbisBackPriority?, nextValue: () -> OrbisBackPriority?) {
        value = nextValue() ?? value
    }
}
extension View {
    func orbisBackPriority(_ key: String, active: Bool, action: @escaping () -> Void) -> some View {
        preference(key: OrbisBackPriorityKey.self, value: active ? OrbisBackPriority(key: key, action: action) : nil)
    }
}
import UIKit

private struct OrbisGlyphActivationKey: EnvironmentKey { static let defaultValue = 0 }
extension EnvironmentValues {
    var orbisGlyphActivation: Int {
        get { self[OrbisGlyphActivationKey.self] }
        set { self[OrbisGlyphActivationKey.self] = newValue }
    }
}

/// Raw icon-bearing rows keep their existing ButtonStyle and only animate their symbols.
struct OrbisMotionButton<Label: View>: View {
    let action: () -> Void
    @ViewBuilder let label: () -> Label
    @State private var activation = 0
    var body: some View {
        Button { activation += 1; action() } label: { label().environment(\.orbisGlyphActivation, activation) }
    }
}

struct OrbisActionSymbol: View {
    @Environment(\.orbisGlyphActivation) private var activation
    let systemName: String
    var body: some View {
        Image(systemName: systemName).modifier(OrbisPressedGlyph(activation: activation))
    }
}

private struct OrbisGlyphPressedKey: EnvironmentKey { static let defaultValue = false }
extension EnvironmentValues {
    var orbisGlyphPressed: Bool {
        get { self[OrbisGlyphPressedKey.self] }
        set { self[OrbisGlyphPressedKey.self] = newValue }
    }
}

/// Quiet, interruptible pressure. The action never waits for this visual response.
struct OrbisPressedGlyph: ViewModifier {
    @Environment(\.orbisGlyphPressed) private var pressed
    @Environment(\.orbisReduceMotion) private var reduced
    @Environment(\.isEnabled) private var enabled
    let activation: Int
    @State private var progress: Double = 0
    @State private var feedback = GlyphFeedbackState()
    private struct Input: Equatable {
        let pressed: Bool
        let activation: Int
        let reduced: Bool
        let enabled: Bool
    }
    func body(content: Content) -> some View {
        content
            .scaleEffect(reduced ? 1 : 1 - progress * (1 - MotionGeometry.glyphPressedScale))
            .opacity(1 - progress * (1 - MotionGeometry.glyphPressedOpacity))
            .task(id: Input(pressed: pressed, activation: activation, reduced: reduced, enabled: enabled)) {
                let response = feedback.update(pressed: pressed, activation: activation, enabled: enabled)
                if reduced || !enabled {
                    var transaction = Transaction(animation: nil)
                    transaction.disablesAnimations = true
                    withTransaction(transaction) { progress = enabled && pressed ? 1 : 0 }
                    if !pressed { feedback.released() }
                    return
                }
                switch response {
                case .press:
                    withAnimation(InteractionMotion.glyphPress) { progress = 1 }
                case .release:
                    withAnimation(InteractionMotion.glyphRelease) { progress = 0 }
                    do { try await Task.sleep(for: .seconds(MotionGeometry.glyphReleaseDuration)) }
                    catch { return }
                    feedback.released()
                case .activate:
                    // Keyboard / VoiceOver, or a tap coalesced into one display frame.
                    withAnimation(InteractionMotion.glyphPress) { progress = 1 }
                    do { try await Task.sleep(for: .seconds(MotionGeometry.glyphPressDuration)) }
                    catch { return }
                    withAnimation(InteractionMotion.glyphRelease) { progress = 0 }
                case .reset:
                    progress = 0
                }
            }
            .onDisappear { progress = 0; feedback = GlyphFeedbackState() }
    }
}

/// Geometry-stable discrete labels; streaming text and editable text keep their own rendering.
struct OrbisMotionText: View {
    @Environment(\.orbisReduceMotion) private var reduced
    @State private var appeared = false
    let value: String
    init(_ value: String) { self.value = value }
    var body: some View {
        Text(value).contentTransition(.opacity)
            .opacity(reduced || appeared ? 1 : 0)
            .task { withAnimation(reduced ? nil : InteractionMotion.state) { appeared = true } }
            .animation(reduced ? nil : InteractionMotion.state, value: value)
    }
}

/// Asset icons in action rows use the same activation source as SF Symbols.
struct OrbisActionPulse: ViewModifier {
    @Environment(\.orbisGlyphActivation) private var activation
    func body(content: Content) -> some View {
        content.modifier(OrbisPressedGlyph(activation: activation))
    }
}

/// All business callers use these semantic tokens (ADR-0058), including reduced motion.
enum InteractionMotion {
    static let glyphPress = Animation.timingCurve(0.2, 0, 0, 1, duration: MotionGeometry.glyphPressDuration)
    static let glyphRelease = Animation.timingCurve(0.2, 0, 0, 1, duration: MotionGeometry.glyphReleaseDuration)
    static let copyTransition = Animation.timingCurve(0.2, 0, 0, 1, duration: 0.16)
    static let selection = Animation.timingCurve(0.2, 0, 0, 1, duration: 0.26)
    static let state = Animation.easeOut(duration: 0.16)
    static let panel = Animation.easeOut(duration: 0.22)
    static let exit = Animation.easeIn(duration: 0.16)
    static let dismiss = Animation.easeIn(duration: 0.18)
    /// A committed page return ends with the visible slide, never a spring's invisible tail.
    static let pageReturn = Animation.easeOut(duration: 0.18)
    /// A pushed page enters on the return's curve, so entry and exit read as one motion. A
    /// spring overshoots past the resting edge, where the page is clamped and visibly sticks.
    static let pageEnter = Animation.timingCurve(0.2, 0, 0, 1, duration: 0.28)
    static let send = Animation.linear(duration: MotionGeometry.sendDuration)
    static let toolbar = Animation.easeInOut(duration: 0.26)
    static func dialSettle(distance: Double) -> Animation {
        .timingCurve(0.215, 0.61, 0.355, 1, duration: ProviderDialGeometry.settleDuration(distance: distance))
    }

    static var notice: AnyTransition {
        .asymmetric(insertion: .offset(y: 12).combined(with: .opacity).animation(panel),
                    removal: .opacity.animation(exit))
    }
}

private struct ReplyCardMeasurement: Equatable {
    var size: CGSize = .zero
    var parts: [ReplyCardPart] = []
    var live = false
    var reduced = false
}
private struct ReplyCardMeasurementKey: PreferenceKey {
    static var defaultValue: ReplyCardMeasurement? { nil }
    static func reduce(value: inout ReplyCardMeasurement?, nextValue: () -> ReplyCardMeasurement?) {
        value = nextValue() ?? value
    }
}
private final class ReplyCardAppearance: ObservableObject {
    let entering: Bool
    init(arrivals: ReplyCardArrivals?, id: String) {
        entering = arrivals?.claim(id, now: ProcessInfo.processInfo.systemUptime) ?? false
    }
}

/// Measure at the final width, then reveal only height. The surface is outside the clip,
/// so its rounded bottom edge and shadow grow with the card without scaling the text.
struct OrbisReplyCard: ViewModifier {
    @Environment(\.orbisReduceMotion) private var reduced
    @StateObject private var appearance: ReplyCardAppearance
    @State private var growth = ReplyCardGrowth()
    @State private var height = ReplyCardHeight()
    @State private var opacity = ReplyCardHeight()
    @State private var animating = false
    let parts: [ReplyCardPart]
    let live: Bool

    init(id: String, parts: [ReplyCardPart], live: Bool, arrivals: ReplyCardArrivals?) {
        self.parts = parts; self.live = live
        _appearance = StateObject(wrappedValue: ReplyCardAppearance(arrivals: arrivals, id: id))
    }

    func body(content: Content) -> some View {
        TimelineView(.animation(paused: !animating)) { clock in
            let now = clock.date.timeIntervalSinceReferenceDate
            content
            .fixedSize(horizontal: false, vertical: true)
            .background(GeometryReader { geometry in
                Color.clear.preference(key: ReplyCardMeasurementKey.self,
                    value: ReplyCardMeasurement(size: geometry.size, parts: parts, live: live, reduced: reduced))
            })
            .frame(height: reduced ? nil : (height.value(at: now) ?? (appearance.entering ? 0 : nil)), alignment: .top)
            .clipped()
            .neuSurface(radius: OrbisRadius.card, intensity: 0.65, padding: 16)
            .opacity(reduced ? 1 : Double(opacity.value(at: now) ?? (appearance.entering ? 0 : 1)))
            .transaction { transaction in
                if reduced { transaction.animation = nil; transaction.disablesAnimations = true }
            }
            .onAppear {
                guard appearance.entering, opacity.target == nil else { return }
                let now = Date.timeIntervalSinceReferenceDate
                opacity.retarget(1, at: now, animated: !reduced, duration: MotionGeometry.replyArrivalDuration, initial: 0)
                animating = height.isAnimating(at: now) || opacity.isAnimating(at: now)
            }
            .onChange(of: animating && !height.isAnimating(at: now) && !opacity.isAnimating(at: now)) { _, finished in
                if finished { animating = false }
            }
        }
            .onPreferenceChange(ReplyCardMeasurementKey.self) { measurement in
                guard let measurement, measurement.size.width > 0 else { return }
                let now = Date.timeIntervalSinceReferenceDate
                let first = height.target == nil
                let animate = growth.update(size: measurement.size, parts: measurement.parts,
                    live: measurement.live, reduced: measurement.reduced, entering: appearance.entering)
                guard height.target != measurement.size.height || (!animate && height.isAnimating(at: now)) ||
                        (measurement.reduced && opacity.isAnimating(at: now)) else { return }
                var transaction = Transaction(animation: nil)
                transaction.disablesAnimations = true
                withTransaction(transaction) {
                    height.retarget(measurement.size.height, at: now, animated: animate,
                        duration: first ? MotionGeometry.replyArrivalDuration : MotionGeometry.replyGrowthDuration,
                        initial: appearance.entering ? 0 : nil)
                    if measurement.reduced { opacity.retarget(1, at: now, animated: false, duration: 0) }
                    animating = height.isAnimating(at: now) || opacity.isAnimating(at: now)
                }
            }
            .onDisappear {
                if let target = height.target {
                    height.retarget(target, at: Date.timeIntervalSinceReferenceDate, animated: false, duration: 0)
                }
                opacity.retarget(1, at: Date.timeIntervalSinceReferenceDate, animated: false, duration: 0)
                animating = false
            }
    }
}

/// Observes touch-down without participating in gesture recognition or delaying a scroll/long press.
struct OrbisTouchOrigin: UIViewRepresentable {
    let onTouch: (CGPoint) -> Void
    func makeUIView(context: Context) -> Probe { Probe(onTouch: onTouch) }
    func updateUIView(_ uiView: Probe, context: Context) { uiView.onTouch = onTouch }

    final class Probe: UIView {
        var onTouch: (CGPoint) -> Void
        private var observer: TouchObserver?
        init(onTouch: @escaping (CGPoint) -> Void) {
            self.onTouch = onTouch
            super.init(frame: .zero)
            isUserInteractionEnabled = false
            isAccessibilityElement = false
        }
        required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
        override func didMoveToWindow() {
            super.didMoveToWindow()
            if let observer { observer.view?.removeGestureRecognizer(observer) }
            observer = nil
            guard let window else { return }
            let recognizer = TouchObserver { [weak self] touch in
                guard let self, !self.isHidden, self.window != nil else { return }
                let point = touch.location(in: self)
                if self.bounds.contains(point) { self.onTouch(point) }
            }
            window.addGestureRecognizer(recognizer)
            observer = recognizer
        }
    }

    private final class TouchObserver: UIGestureRecognizer {
        let observe: (UITouch) -> Void
        init(observe: @escaping (UITouch) -> Void) {
            self.observe = observe
            super.init(target: nil, action: nil)
            cancelsTouchesInView = false
            delaysTouchesBegan = false
            delaysTouchesEnded = false
        }
        override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent) {
            if let touch = touches.first { observe(touch) }
            state = .failed
        }
        override func canPrevent(_ preventedGestureRecognizer: UIGestureRecognizer) -> Bool { false }
        override func canBePrevented(by preventingGestureRecognizer: UIGestureRecognizer) -> Bool { false }
    }
}

struct OrbisSelectionFill: View {
    @Environment(\.colorScheme) private var scheme
    @Environment(\.orbisReduceMotion) private var reduceMotion
    let selected: Bool
    let origin: CGPoint?
    let radius: CGFloat
    let color: Color
    var body: some View {
        GeometryReader { proxy in
            let point = MotionGeometry.touchOrigin(origin, size: proxy.size)
            let reach = MotionGeometry.revealRadius(origin: point, size: proxy.size)
            let shape = RoundedRectangle(cornerRadius: radius, style: .continuous)
            Circle().fill(OrbisPalette(scheme).accentSoft)
                .frame(width: reach * 2, height: reach * 2)
                .scaleEffect(selected ? 1 : 0)
                .position(point)
                .clipShape(shape)
                .overlay { shape.strokeBorder(color.opacity(selected ? 1 : 0), lineWidth: 1) }
                .animation(reduceMotion ? nil : selected ? InteractionMotion.selection : InteractionMotion.state, value: selected)
        }.allowsHitTesting(false).accessibilityHidden(true)
    }
}

/// Copy controls share a fixed slot and the same transition into success and back to copy.
struct OrbisCopyGlyph: View {
    @Environment(\.orbisReduceMotion) private var reduced
    @Environment(\.orbisGlyphActivation) private var inheritedActivation
    let copied: Bool
    let size: CGFloat
    var symbol = "doc.on.doc"
    var activation: Int? = nil
    var normalColor: Color? = nil
    var successColor: Color? = nil

    var body: some View {
        ZStack {
            Image(systemName: symbol).foregroundStyle(normalColor ?? .primary)
                .opacity(copied ? 0 : 1).scaleEffect(copied ? 0.6 : 1)
            Image(systemName: "checkmark").fontWeight(.bold).foregroundStyle(successColor ?? .primary)
                .opacity(copied ? 1 : 0).scaleEffect(copied ? 1 : 0.5)
        }
        .font(.system(size: size, weight: .medium))
        .frame(width: size, height: size)
        .animation(reduced ? nil : InteractionMotion.copyTransition, value: copied)
        .modifier(OrbisPressedGlyph(activation: activation ?? inheritedActivation))
        .accessibilityHidden(true)
    }
}

/// Stable glyph slot. State morphs keep their meaning; every action shares quiet pressure.
struct OrbisMotionGlyph: View {
    @Environment(\.orbisReduceMotion) private var reduceMotion
    let symbol: String
    let size: CGFloat
    var activation = 0
    var morphFrom: String? = nil

    var body: some View {
        Group {
            if morphFrom == "line.3.horizontal" {
                MenuCloseLines(progress: symbol == "xmark" ? 1 : 0)
                    .stroke(style: StrokeStyle(lineWidth: 2, lineCap: .round))
                    .animation(reduceMotion ? nil : InteractionMotion.toolbar, value: symbol)
            } else if morphFrom == "arrow.left" {
                BackCloseLines(progress: symbol == "xmark" ? 1 : 0)
                    .stroke(style: StrokeStyle(lineWidth: 2, lineCap: .round))
                    .animation(reduceMotion ? nil : InteractionMotion.toolbar, value: symbol)
            } else if symbol == "arrow.down.to.line" {
                Path { p in
                    p.move(to: CGPoint(x: size * 0.18, y: size * 0.85)); p.addLine(to: CGPoint(x: size * 0.82, y: size * 0.85))
                    p.move(to: CGPoint(x: size / 2, y: size * 0.12)); p.addLine(to: CGPoint(x: size / 2, y: size * 0.65))
                    p.move(to: CGPoint(x: size * 0.28, y: size * 0.45)); p.addLine(to: CGPoint(x: size / 2, y: size * 0.67)); p.addLine(to: CGPoint(x: size * 0.72, y: size * 0.45))
                }.stroke(style: StrokeStyle(lineWidth: 2, lineCap: .round, lineJoin: .round))
            } else {
                Image(systemName: symbol).font(.system(size: size, weight: .medium))
                    .contentTransition(.opacity)
                    .animation(reduceMotion ? nil : InteractionMotion.state, value: symbol)
            }
        }.frame(width: size, height: size)
            .modifier(OrbisPressedGlyph(activation: activation))
            .accessibilityHidden(true)
    }
}

private struct BackCloseLines: Shape {
    var progress: CGFloat
    var animatableData: CGFloat { get { progress } set { progress = newValue } }
    func path(in rect: CGRect) -> Path {
        let p = min(1, max(0, progress)), h = rect.width * 0.34
        let from: [(CGPoint, CGPoint)] = [
            (CGPoint(x: -h, y: 0), CGPoint(x: 0, y: -h)),
            (CGPoint(x: -h, y: 0), CGPoint(x: h, y: 0)),
            (CGPoint(x: -h, y: 0), CGPoint(x: 0, y: h))]
        let to: [(CGPoint, CGPoint)] = [
            (CGPoint(x: -h, y: h), CGPoint(x: h, y: -h)), (.zero, .zero),
            (CGPoint(x: -h, y: -h), CGPoint(x: h, y: h))]
        func point(_ a: CGPoint, _ b: CGPoint) -> CGPoint {
            CGPoint(x: rect.midX + a.x + (b.x - a.x) * p, y: rect.midY + a.y + (b.y - a.y) * p)
        }
        var path = Path()
        for i in from.indices {
            path.move(to: point(from[i].0, to[i].0)); path.addLine(to: point(from[i].1, to[i].1))
        }
        return path
    }
}

private struct MenuCloseLines: Shape {
    var progress: CGFloat
    var animatableData: CGFloat { get { progress } set { progress = newValue } }
    func path(in rect: CGRect) -> Path {
        let p = min(1, max(0, progress)), half = rect.width * 0.36
        let angle = p * .pi / 4, dx = cos(angle) * half, dy = sin(angle) * half
        let gap = rect.height * 0.26 * (1 - p)
        var path = Path()
        path.move(to: CGPoint(x: rect.midX - dx, y: rect.midY - gap - dy))
        path.addLine(to: CGPoint(x: rect.midX + dx, y: rect.midY - gap + dy))
        path.move(to: CGPoint(x: rect.midX - half * (1 - p), y: rect.midY))
        path.addLine(to: CGPoint(x: rect.midX + half * (1 - p), y: rect.midY))
        path.move(to: CGPoint(x: rect.midX - dx, y: rect.midY + gap + dy))
        path.addLine(to: CGPoint(x: rect.midX + dx, y: rect.midY + gap - dy))
        return path
    }
}

/// A message owns one menu or one text-selection sheet; the page header never changes.
struct OrbisMessageActions: ViewModifier {
    @EnvironmentObject private var overlay: OrbisOverlay
    @Environment(\.scenePhase) private var scenePhase
    let enabled: Bool
    let id: String
    let text: String
    let rewindEnabled: Bool
    var rewind: (() -> Void)?
    @State private var anchor = OrbisAnchor()
    @State private var selectingText = false
    private var owner: String { "message-" + id }

    func body(content: Content) -> some View {
        if enabled {
            content.orbisAnchor(anchor)
                .background(OrbisMenuScrollObserver { overlay.dismissMenu(owner: owner) })
                .accessibilityIdentifier("user-message-" + id)
                .onLongPressGesture { show() }
                .accessibilityAction(named: L10n.tr("消息操作"), show)
                .onChange(of: rewindEnabled) { _, _ in overlay.dismissMenu(owner: owner) }
                .onChange(of: rewind != nil) { _, _ in overlay.dismissMenu(owner: owner) }
                .onChange(of: text) { _, _ in dismiss() }
                .onChange(of: id) { old, _ in
                    overlay.dismissMenu(owner: "message-" + old); selectingText = false
                }
                .onChange(of: scenePhase) { _, phase in if phase != .active { dismiss() } }
                .onGeometryChange(for: CGRect.self) { $0.frame(in: .global) } action: { new in
                    anchor.frame = new
                    overlay.moveMenu(owner: owner, to: new)
                }
                .orbisBottomSheet(isPresented: $selectingText) {
                    OrbisMessageTextSelection(text: text).orbisSheet()
                }
                .onDisappear { dismiss() }
        } else { content }
    }
    private func dismiss() {
        overlay.dismissMenu(owner: owner); selectingText = false
    }
    private func show() {
        guard enabled, !selectingText, !anchor.frame.isEmpty, overlay.menu?.owner != owner else { return }
        var items: [OrbisMenuItem] = []
        if !text.isEmpty {
            items.append(OrbisMenuItem(title: L10n.tr("复制消息"), symbol: "doc.on.doc", keepsOpen: true,
                                      identifier: "copy-message-" + id) { UIPasteboard.general.string = text })
            items.append(OrbisMenuItem(title: L10n.tr("选择文字"), symbol: "text.cursor",
                                      identifier: "select-message-text-" + id) { selectingText = true })
        }
        if rewindEnabled, let rewind {
            if !items.isEmpty { items.append(.divider) }
            items.append(OrbisMenuItem(title: "Rewind", symbol: "backward.end",
                                      identifier: "rewind-message-" + id, action: rewind))
        }
        guard !items.isEmpty else { return }
        OrbisHaptics.selectionChanged()
        overlay.showMenu(items, from: anchor.frame, preferAbove: true, owner: owner)
    }
}

private struct OrbisMessageTextSelection: View {
    @OrbisDismiss private var dismiss
    let text: String
    var body: some View {
        VStack(spacing: 0) {
            OrbisPageHeader(title: L10n.tr("选择文字"), closes: true,
                            backLabel: L10n.tr("关闭文字选择"), back: { dismiss() }) {
                OrbisCopyButton(label: L10n.tr("复制消息")) { text }
            }
            OrbisSelectableMessageText(text: text)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .accessibilityIdentifier("message-selection-text")
        }
    }
}

/// UITextView keeps native range handles on supported iOS versions, including iPadOS 26.
/// SwiftUI Text can offer only whole-paragraph Copy/Share on those versions.
private struct OrbisSelectableMessageText: UIViewRepresentable {
    @Environment(\.colorScheme) private var scheme
    @AppStorage("orbis.appearance") private var visualStyle = "mist"
    let text: String

    func makeUIView(context: Context) -> UITextView {
        let view = UITextView()
        view.isEditable = false
        view.isSelectable = true
        view.backgroundColor = .clear
        view.font = .monospacedDigitSystemFont(ofSize: OrbisTextSize.body, weight: .regular)
        view.textContainerInset = UIEdgeInsets(top: 20, left: 20, bottom: 20, right: 20)
        view.textContainer.lineFragmentPadding = 0
        view.accessibilityIdentifier = "message-selection-text"
        return view
    }
    func updateUIView(_ view: UITextView, context: Context) {
        // Appearance updates must not reset an active range or its scroll position.
        if view.text != text { view.text = text }
        view.textColor = UIColor(OrbisPalette(scheme).text)
    }
}

private struct OrbisMenuScrollObserver: UIViewRepresentable {
    let onScroll: () -> Void
    func makeCoordinator() -> Coordinator { Coordinator(onScroll) }
    func makeUIView(context: Context) -> UIView {
        let view = UIView(); view.isUserInteractionEnabled = false
        DispatchQueue.main.async { context.coordinator.attach(view) }
        return view
    }
    func updateUIView(_ view: UIView, context: Context) {
        context.coordinator.onScroll = onScroll
        DispatchQueue.main.async { context.coordinator.attach(view) }
    }
    static func dismantleUIView(_ view: UIView, coordinator: Coordinator) { coordinator.detach() }
    final class Coordinator: NSObject {
        var onScroll: () -> Void
        weak var scroll: UIScrollView?
        init(_ onScroll: @escaping () -> Void) { self.onScroll = onScroll }
        func attach(_ view: UIView) {
            guard scroll == nil else { return }
            var ancestor = view.superview
            while let candidate = ancestor {
                if let found = candidate as? UIScrollView {
                    scroll = found
                    found.panGestureRecognizer.addTarget(self, action: #selector(panned))
                    return
                }
                ancestor = candidate.superview
            }
        }
        @objc func panned(_ pan: UIPanGestureRecognizer) {
            if pan.state == .began { onScroll() }
        }
        func detach() { scroll?.panGestureRecognizer.removeTarget(self, action: #selector(panned)); scroll = nil }
    }
}

/// Both action groups keep one layout slot. Only the active group can receive input or focus.
struct OrbisSelectionToolbar<Normal: View, Selected: View>: View {
    @Environment(\.orbisReduceMotion) private var reduceMotion
    let selecting: Bool
    @ViewBuilder let normal: (CGFloat) -> Normal
    @ViewBuilder let selected: Selected
    var body: some View {
        ZStack {
            normal(selecting ? 1 : 0)
                .zIndex(selecting ? 0 : 1)
                .opacity(selecting ? 0 : 1)
                .animation(reduceMotion ? nil : InteractionMotion.state.delay(selecting ? 0 : 0.1), value: selecting)
                .disabled(selecting).allowsHitTesting(!selecting).accessibilityHidden(selecting)
            // Hidden sizing content has no controls. The active branch is removed on exit,
            // so a child Button's accessibility configuration cannot retain stale actions.
            selected.hidden().allowsHitTesting(false).accessibilityHidden(true)
            if selecting {
                selected.zIndex(1)
                    .transition(.opacity.animation(reduceMotion ? nil : .easeOut(duration: 0.1).delay(0.16)))
            }
        }.animation(reduceMotion ? nil : InteractionMotion.toolbar, value: selecting)
    }
}

@MainActor final class MessageSendFlight: ObservableObject {
    struct Item: Identifiable {
        let id: String
        let text: String
        let source: CGRect
        var target: CGRect
        var progress: CGFloat = 0
        var landsOnRow = false
        var awaitingTarget = false
    }
    @Published private(set) var items: [Item] = []
    let composer = OrbisAnchor()
    let root = OrbisAnchor()
    let viewport = OrbisAnchor()
    var targets: [String: OrbisAnchor] = [:]
    private var tasks: [String: Task<Void, Never>] = [:]
    #if DEBUG
    private var previewProgress: CGFloat? {
        ProcessInfo.processInfo.arguments.first { $0.hasPrefix("--preview-send-progress=") }
            .flatMap { Double($0.dropFirst("--preview-send-progress=".count)) }.map { CGFloat(min(1, max(0, $0))) }
    }
    var previewMetrics: String {
        guard let item = items.last else { return "count=0" }
        let frame = MotionGeometry.sendFrame(from: item.source, to: item.target, progress: item.progress)
        return "count=\(items.count);id=\(item.id);lands=\(item.landsOnRow);p=\(item.progress);x=\(frame.midX);y=\(frame.midY);width=\(frame.width);height=\(frame.height);right=\(frame.maxX);bottom=\(frame.maxY);clipTop=\(viewport.frame.minY);fromX=\(item.source.midX);fromY=\(item.source.midY);toX=\(item.target.midX);toY=\(item.target.midY);toWidth=\(item.target.width);toHeight=\(item.target.height);toRight=\(item.target.maxX);toBottom=\(item.target.maxY)"
    }
    #endif

    func launch(_ send: PendingSend, following: Bool, reduceMotion: Bool) {
        guard !reduceMotion, !composer.frame.isEmpty, !root.frame.isEmpty,
              items.count < 3, !items.contains(where: { $0.id == send.messageId }) else { return }
        let source = composer.frame
        let fallback = CGRect(x: root.frame.maxX - min(source.width, 180) - 20, y: source.minY - 72,
                              width: min(source.width, 180), height: min(source.height, 72))
        items.append(Item(id: send.messageId, text: send.text, source: source, target: fallback,
                          awaitingTarget: following && !send.showsInQueue && !send.queueOwned))
        tasks[send.messageId] = Task { @MainActor [weak self] in
            // Allow the newly accepted row to lay out. This never delays submission or clearing the composer.
            await MotionLayoutFrames.wait()
            guard !Task.isCancelled, let self, let index = self.items.firstIndex(where: { $0.id == send.messageId }) else { return }
            if following, !send.showsInQueue, !send.queueOwned, let target = self.targets[send.messageId]?.frame, target.intersects(self.root.frame), target.maxY <= source.minY {
                self.items[index].target = target
                self.items[index].landsOnRow = true
            }
            self.items[index].awaitingTarget = false
            #if DEBUG
            // A deterministic phase supplied by UI fixtures freezes production geometry for frame review.
            if let progress = self.previewProgress {
                self.items[index].progress = progress
                self.tasks[send.messageId] = nil
                return
            }
            #endif
            // The real row stays hidden until its full-size visual has finished unfolding.
            // Completion follows the rendered animation, rather than a competing wall-clock timer.
            withAnimation(InteractionMotion.send, completionCriteria: .removed) {
                self.items[index].progress = 1
            } completion: { [weak self] in
                withTransaction(Transaction(animation: nil)) {
                    self?.items.removeAll { $0.id == send.messageId }
                }
            }
            self.tasks[send.messageId] = nil
        }
    }
    func cancelFlights() {
        tasks.values.forEach { $0.cancel() }; tasks = [:]; items = []
    }
    // Rows unregister on disappearance. A covered/backgrounded page may resume with
    // the same rows, so cancelling motion must preserve their live landing anchors.
    func clear() { cancelFlights() }
}

/// Layout rendezvous uses display frames, not an assumed 60 Hz wall-clock delay.
@MainActor private final class MotionLayoutFrames: NSObject {
    private var link: CADisplayLink?
    private var remaining = 2
    private var continuation: CheckedContinuation<Void, Never>?
    static func wait() async {
        let frames = MotionLayoutFrames()
        await withTaskCancellationHandler {
            await withCheckedContinuation { continuation in
                frames.continuation = continuation
                if Task.isCancelled { frames.finish(); return }
                let link = CADisplayLink(target: frames, selector: #selector(tick))
                frames.link = link
                link.add(to: .main, forMode: .common)
            }
        } onCancel: {
            Task { @MainActor in frames.finish() }
        }
    }
    @objc private func tick() {
        remaining -= 1
        if remaining == 0 { finish() }
    }
    private func finish() {
        link?.invalidate(); link = nil
        continuation?.resume(); continuation = nil
    }
}

private struct MessageSendFlightKey: EnvironmentKey { static let defaultValue: MessageSendFlight? = nil }
extension EnvironmentValues {
    var messageSendFlight: MessageSendFlight? {
        get { self[MessageSendFlightKey.self] }
        set { self[MessageSendFlightKey.self] = newValue }
    }
}
extension View {
    func messageSendFlightHost(_ flight: MessageSendFlight) -> some View { modifier(MessageSendFlightHost(flight: flight)) }
    func messageSendFlightTarget(_ id: String) -> some View { MessageSendFlightTarget(id: id, content: self) }
}

private struct MessageSendFlightHost: ViewModifier {
    @ObservedObject var flight: MessageSendFlight
    @Environment(\.scenePhase) private var scene
    @Environment(\.colorScheme) private var scheme
    @AppStorage("orbis.appearance") private var visualStyle = "mist"
    @Environment(\.orbisReduceMotion) private var reduceMotion
    @State private var viewportSize: CGSize = .zero
    func body(content: Content) -> some View {
        content.orbisAnchor(flight.root).environment(\.messageSendFlight, flight)
            #if DEBUG
            .overlay(alignment: .topLeading) {
                if ProcessInfo.processInfo.arguments.contains("--preview-send-probe") {
                    Color.clear.frame(width: 1, height: 1).accessibilityElement()
                        .accessibilityIdentifier("send-flight-probe").accessibilityValue(flight.previewMetrics)
                }
            }
            #endif
            .overlayPreferenceValue(MessageSendVisualKey.self) { visuals in
                ZStack(alignment: .topLeading) {
                    ForEach(flight.items) { item in
                        SendFlightVisual(progress: item.progress, source: item.source, target: item.target,
                                         root: flight.root.frame.origin, text: item.text,
                                         visual: item.landsOnRow || item.awaitingTarget ? visuals[item.id] : nil,
                                         landsOnRow: item.landsOnRow || item.awaitingTarget)
                            .transition(.identity)
                    }
                }.frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                    .mask { Rectangle().padding(.top, max(0, flight.viewport.frame.minY - flight.root.frame.minY)) }
                    .accessibilityElement(children: .ignore)
                    .allowsHitTesting(false).accessibilityHidden(true)
            }
            .onGeometryChange(for: CGSize.self) { $0.size } action: { size in
                // A keyboard/rotation layout invalidates captured coordinates. Reveal the
                // real message immediately instead of flying behind another surface.
                if viewportSize != .zero && size != viewportSize { flight.cancelFlights() }
                viewportSize = size
            }
            .onChange(of: scene) { _, phase in if phase != .active { flight.clear() } }
            .onChange(of: reduceMotion) { _, reduced in if reduced { flight.clear() } }
            .onDisappear { flight.clear() }
    }
}
/// Render the same bubble (including Markdown and attachments) as a noninteractive Canvas
/// symbol. A plain two-line text copy cannot hand off seamlessly to the canonical message.
private struct MessageSendVisualKey: PreferenceKey {
    static var defaultValue: [String: AnyView] { [:] }
    static func reduce(value: inout [String: AnyView], nextValue: () -> [String: AnyView]) {
        value.merge(nextValue(), uniquingKeysWith: { _, new in new })
    }
}
private struct SendFlightVisual: View, Animatable {
    var progress: CGFloat
    let source: CGRect
    let target: CGRect
    let root: CGPoint
    let text: String
    let visual: AnyView?
    let landsOnRow: Bool
    @Environment(\.colorScheme) private var scheme
    var animatableData: CGFloat { get { progress } set { progress = newValue } }
    var body: some View {
        let frame = MotionGeometry.sendFrame(from: source, to: target, progress: progress)
        Canvas { context, size in
            context.clip(to: Path(roundedRect: CGRect(origin: .zero, size: size), cornerRadius: OrbisRadius.card))
            if let symbol = context.resolveSymbol(id: "message") {
                let scale = min(1, size.width / max(1, target.width))
                context.scaleBy(x: scale, y: scale)
                context.draw(symbol, at: .zero, anchor: .topLeading)
            }
        } symbols: {
            if let visual {
                visual.frame(width: target.width, height: target.height, alignment: .topLeading).tag("message")
            } else {
                Text(text).font(.orbisBody()).foregroundStyle(OrbisPalette(scheme).text)
                    .padding(14).frame(width: target.width, alignment: .leading)
                    .neuSurface(inset: true, radius: OrbisRadius.card, intensity: 0.6).tag("message")
            }
        }
        .frame(width: frame.width, height: frame.height)
        .position(x: frame.midX - root.x, y: frame.midY - root.y)
        .opacity(landsOnRow ? 1 : min(1, max(0, (1 - progress) / (1 - MotionGeometry.sendArrival))))
        .accessibilityHidden(true).allowsHitTesting(false)
    }
}
private struct MessageSendFlightTarget<Content: View>: View {
    @Environment(\.messageSendFlight) private var flight
    let id: String
    let content: Content
    var body: some View {
        if let flight { TrackedSendTarget(flight: flight, id: id, content: content) }
        else { content }
    }
}
private struct TrackedSendTarget<Content: View>: View {
    @ObservedObject var flight: MessageSendFlight
    let id: String
    let content: Content
    @State private var anchor = OrbisAnchor()
    var body: some View {
        let item = flight.items.first { $0.id == id }
        let projected = item.map { $0.landsOnRow || $0.awaitingTarget } ?? false
        content
            // Keep the selectable native text at full opacity throughout. Restoring
            // its opacity during an IME layout can animate the underlying text view
            // even when SwiftUI's handoff transaction has no animation.
            .mask {
                Rectangle().fill(projected ? Color.clear : Color.black)
                    .padding(-OrbisRadius.card)
                    .transaction { $0.animation = nil; $0.disablesAnimations = true }
            }
            .preference(key: MessageSendVisualKey.self, value: projected ? [id: AnyView(content)] : [:])
            .orbisAnchor(anchor)
            .onAppear { flight.targets[id] = anchor }
            .onChange(of: id) { old, new in flight.targets[old] = nil; flight.targets[new] = anchor }
            .onDisappear { flight.targets[id] = nil }
    }
}


/// Native pan direction, independent of layout, inertia, programmatic jumps and new output.
struct OrbisScrollDirectionObserver: UIViewRepresentable {
    let onDirection: (Bool) -> Void
    func makeCoordinator() -> Coordinator { Coordinator(onDirection) }
    func makeUIView(context: Context) -> UIView {
        let view = UIView(); view.isUserInteractionEnabled = false
        DispatchQueue.main.async { context.coordinator.attach(view) }
        return view
    }
    func updateUIView(_ view: UIView, context: Context) {
        context.coordinator.changed = onDirection
        DispatchQueue.main.async { context.coordinator.attach(view) }
    }
    static func dismantleUIView(_ view: UIView, coordinator: Coordinator) { coordinator.detach() }
    final class Coordinator: NSObject {
        var changed: (Bool) -> Void
        weak var scroll: UIScrollView?
        var lastY: CGFloat = 0
        init(_ changed: @escaping (Bool) -> Void) { self.changed = changed }
        func attach(_ view: UIView) {
            guard scroll == nil else { return }
            var ancestor = view.superview
            while let candidate = ancestor {
                if let found = candidate as? UIScrollView {
                    scroll = found; found.panGestureRecognizer.addTarget(self, action: #selector(pan)); return
                }
                ancestor = candidate.superview
            }
        }
        @objc func pan(_ pan: UIPanGestureRecognizer) {
            let y = pan.translation(in: pan.view).y
            if pan.state == .began { lastY = 0 }
            if pan.state == .began || pan.state == .changed {
                let delta = y - lastY
                if abs(delta) > 0.5 { changed(delta > 0); lastY = y }
            }
        }
        func detach() { scroll?.panGestureRecognizer.removeTarget(self, action: #selector(pan)); scroll = nil }
    }
}



/// A dial crossing gives one small state-duration pulse, cancelled on reuse.
struct OrbisDialPulse: ViewModifier {
    @Environment(\.orbisReduceMotion) private var reduced
    let trigger: Int
    let peak: CGFloat
    @State private var scale: CGFloat = 1
    func body(content: Content) -> some View {
        content.scaleEffect(reduced ? 1 : scale).task(id: trigger) {
            guard trigger > 0, !reduced else { scale = 1; return }
            withAnimation(.timingCurve(0.2, 0, 0, 1, duration: 0.08)) { scale = peak }
            try? await Task.sleep(for: .milliseconds(80))
            guard !Task.isCancelled else { return }
            withAnimation(.timingCurve(0.2, 0, 0, 1, duration: 0.08)) { scale = 1 }
        }
    }
}
