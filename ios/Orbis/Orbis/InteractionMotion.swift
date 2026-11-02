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
        Image(systemName: systemName).modifier(OrbisPressedGlyph(role: systemName, activation: activation))
    }
}

private struct OrbisGlyphPressedKey: EnvironmentKey { static let defaultValue = false }
extension EnvironmentValues {
    var orbisGlyphPressed: Bool {
        get { self[OrbisGlyphPressedKey.self] }
        set { self[OrbisGlyphPressedKey.self] = newValue }
    }
}

/// A short tap finishes its visual press while the action runs immediately. Re-press takes over.
struct OrbisPressedGlyph: ViewModifier {
    @Environment(\.orbisGlyphPressed) private var pressed
    @Environment(\.orbisReduceMotion) private var reduced
    let role: String
    let activation: Int
    @State private var progress: Double = 0
    @State private var began: Date?
    @State private var pointerActivation = false
    private var rotates: Bool { InteractionMotion.rotates(role) }
    private var downloads: Bool { role == "arrow.down.to.line" }
    func body(content: Content) -> some View {
        content.rotationEffect(.degrees(rotates ? progress * 360 : 0))
            .scaleEffect(rotates || downloads ? 1 : 1 - progress * 0.12)
            .offset(y: downloads ? progress * 4 : 0)
            .task(id: pressed) {
                if pressed {
                    began = Date(); pointerActivation = true
                    if rotates { OrbisHaptics.press() }
                    withAnimation(reduced ? nil : .easeOut(duration: rotates ? 0.26 : 0.09)) { progress = reduced ? 0 : 1 }
                } else if let began {
                    let remaining = max(0, (rotates ? 0.26 : 0.09) - Date().timeIntervalSince(began))
                    if !reduced { try? await Task.sleep(for: .seconds(remaining)) }
                    guard !Task.isCancelled else { return }
                    withAnimation(reduced ? nil : downloads ? .orbisPop : .easeOut(duration: rotates ? 0.26 : 0.13)) { progress = 0 }
                    self.began = nil; pointerActivation = false
                }
            }
            .task(id: activation) {
                guard activation > 0 else { return }
                if pointerActivation { pointerActivation = false; return }
                // Keyboard / VoiceOver activation has no physical press phase.
                withAnimation(reduced ? nil : InteractionMotion.state) { progress = reduced ? 0 : 1 }
                if !reduced { try? await Task.sleep(for: .seconds(rotates ? 0.26 : 0.09)) }
                guard !Task.isCancelled else { return }
                withAnimation(reduced ? nil : downloads ? .orbisPop : InteractionMotion.selection) { progress = 0 }
            }
            .onDisappear { progress = 0; began = nil; pointerActivation = false }
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
        content.modifier(OrbisPressedGlyph(role: "asset", activation: activation))
    }
}

/// All business callers use these semantic tokens (ADR-0058), including reduced motion.
enum InteractionMotion {
    static func rotates(_ role: String) -> Bool { ["gearshape", "clock.arrow.circlepath", "arrow.clockwise", "arrow.triangle.2.circlepath", "point.3.connected.trianglepath.dotted"].contains(role) }
    static let selection = Animation.easeOut(duration: 0.26)
    static let state = Animation.easeOut(duration: 0.16)
    static let panel = Animation.easeOut(duration: 0.22)
    static let exit = Animation.easeIn(duration: 0.16)
    static let dismiss = Animation.easeIn(duration: 0.18)
    static let send = Animation.linear(duration: 0.28)
    static let toolbar = Animation.easeInOut(duration: 0.26)

    static var notice: AnyTransition {
        .asymmetric(insertion: .offset(x: 32, y: -12).combined(with: .opacity).animation(panel),
                    removal: .offset(x: 32, y: -12).combined(with: .opacity).animation(exit))
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
            Circle().fill(color.opacity(0.07))
                .frame(width: reach * 2, height: reach * 2)
                .scaleEffect(selected ? 1 : 0)
                .position(point)
                .clipShape(shape)
                .overlay { shape.strokeBorder(color.opacity(selected ? 0.65 : 0), lineWidth: 1) }
                .animation(reduceMotion ? nil : selected ? InteractionMotion.selection : InteractionMotion.state, value: selected)
        }.allowsHitTesting(false).accessibilityHidden(true)
    }
}

/// Stable glyph slot: download animates the arrow alone; menu/close uses actual line geometry.
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
                ZStack {
                    Path { p in p.move(to: CGPoint(x: size * 0.18, y: size * 0.85)); p.addLine(to: CGPoint(x: size * 0.82, y: size * 0.85)) }
                        .stroke(style: StrokeStyle(lineWidth: 2, lineCap: .round))
                    Path { p in
                        p.move(to: CGPoint(x: size / 2, y: size * 0.12)); p.addLine(to: CGPoint(x: size / 2, y: size * 0.65))
                        p.move(to: CGPoint(x: size * 0.28, y: size * 0.45)); p.addLine(to: CGPoint(x: size / 2, y: size * 0.67)); p.addLine(to: CGPoint(x: size * 0.72, y: size * 0.45))
                    }.stroke(style: StrokeStyle(lineWidth: 2, lineCap: .round, lineJoin: .round))
                        .modifier(OrbisPressedGlyph(role: symbol, activation: activation))
                }
            } else {
                Image(systemName: symbol).font(.system(size: size, weight: .medium))
                    .contentTransition(.opacity)
                    .animation(reduceMotion ? nil : InteractionMotion.state, value: symbol)
                    .modifier(OrbisPressedGlyph(role: symbol, activation: activation))
            }
        }.frame(width: size, height: size)
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

/// Page-scoped actions replace the stable header slot without changing the transcript layout.
struct OrbisMessageActions: ViewModifier {
    @Environment(\.orbisMessageActions) private var toolbar
    @EnvironmentObject private var overlay: OrbisOverlay
    let enabled: Bool
    let id: String
    let text: String
    let rewindEnabled: Bool
    var rewind: (() -> Void)?
    @State private var anchor = OrbisAnchor()
    private var owner: String { "message-" + id }

    func body(content: Content) -> some View {
        if enabled {
        content.orbisAnchor(anchor)
            .background(OrbisMenuScrollObserver { dismiss() })
            .accessibilityIdentifier("user-message-" + id)
            // Native selection can cancel a passive window observer as it dismisses the keyboard.
            // Keep the row's simultaneous recognizer for that first hold; the observer also
            // handles another hold when native text selection already owns the hit target.
            .simultaneousGesture(LongPressGesture().onEnded { _ in show() })
            .background(OrbisLongPressObserver(onPress: show))
            .accessibilityAction(named: "消息操作") { if enabled { show() } }
            .onChange(of: rewindEnabled) { _, _ in dismiss() }
            .onChange(of: text) { _, new in
                guard toolbar?.selection?.id == id else { return }
                toolbar?.selection = .init(id: id, text: new, rewindEnabled: rewindEnabled, rewind: rewind)
            }
            .onChange(of: id) { old, _ in overlay.dismissMenu(owner: "message-" + old); toolbar?.dismiss(id: old) }
            .onGeometryChange(for: CGRect.self) { $0.frame(in: .global) } action: { new in
                // Keyboard and safe-area changes move the anchor without invalidating its owner.
                // Only a real scroll pan dismisses the menu; text selection remains native.
                anchor.frame = new
                overlay.moveMenu(owner: owner, to: new)
            }
            .onDisappear { dismiss() }
        } else {
            // Assistant/tool rows retain their own identifiers, links and controls.
            content
        }
    }
    private func dismiss() {
        overlay.dismissMenu(owner: owner); toolbar?.dismiss(id: id)
    }
    private func show() {
        guard enabled else { return }
        if let toolbar {
            guard toolbar.selection?.id != id else { return }
            OrbisHaptics.selectionChanged()
            toolbar.selection = .init(id: id, text: text, rewindEnabled: rewindEnabled, rewind: rewind)
            return
        }
        guard !anchor.frame.isEmpty else { return }
        var items = [OrbisMenuItem(title: "复制消息", symbol: "doc.on.doc", keepsOpen: true, identifier: "copy-message-" + id) { UIPasteboard.general.string = text }]
        if let rewind {
            items.append(OrbisMenuItem(title: "Rewind", symbol: "backward.end", disabled: !rewindEnabled, identifier: "rewind-message-" + id, action: rewind))
        }
        overlay.showMenu(items, from: anchor.frame, horizontal: true, owner: owner)
    }
}

/// Observes a held touch without winning against native text selection or scroll gestures.
/// Native selection may already own the second hold, so a SwiftUI LongPressGesture is insufficient.
private struct OrbisLongPressObserver: UIViewRepresentable {
    let onPress: () -> Void
    func makeUIView(context: Context) -> Probe { Probe(onPress: onPress) }
    func updateUIView(_ view: Probe, context: Context) { view.onPress = onPress }
    static func dismantleUIView(_ view: Probe, coordinator: ()) { view.detach() }
    final class Probe: UIView {
        var onPress: () -> Void
        private var observer: HoldObserver?
        init(onPress: @escaping () -> Void) {
            self.onPress = onPress
            super.init(frame: .zero)
            isUserInteractionEnabled = false; isAccessibilityElement = false
        }
        required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
        override func didMoveToWindow() {
            super.didMoveToWindow(); detach()
            guard let window else { return }
            let recognizer = HoldObserver(probe: self)
            window.addGestureRecognizer(recognizer); observer = recognizer
        }
        func detach() { observer?.invalidate(); if let observer { observer.view?.removeGestureRecognizer(observer) }; observer = nil }
        func contains(_ touch: UITouch) -> Bool {
            guard window != nil, bounds.contains(touch.location(in: self)) else { return false }
            var parent: UIView? = self
            while let view = parent {
                if view.isHidden || view.alpha < 0.01 { return false }
                if view.clipsToBounds && !view.bounds.contains(touch.location(in: view)) { return false }
                parent = view.superview
            }
            return true
        }
    }
    private final class HoldObserver: UIGestureRecognizer {
        weak var probe: Probe?
        private var start = CGPoint.zero
        private var pending: DispatchWorkItem?
        init(probe: Probe) {
            self.probe = probe; super.init(target: nil, action: nil)
            cancelsTouchesInView = false; delaysTouchesBegan = false; delaysTouchesEnded = false
        }
        func invalidate() { pending?.cancel(); pending = nil }
        override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent) {
            guard touches.count == 1, let touch = touches.first, probe?.contains(touch) == true else { state = .failed; return }
            start = touch.location(in: view)
            let work = DispatchWorkItem { [weak self] in
                guard let self, self.state == .possible else { return }
                self.probe?.onPress(); self.state = .failed; self.pending = nil
            }
            pending = work; DispatchQueue.main.asyncAfter(deadline: .now() + 0.5, execute: work)
        }
        override func touchesMoved(_ touches: Set<UITouch>, with event: UIEvent) {
            guard let touch = touches.first else { return }
            let point = touch.location(in: view)
            if hypot(point.x - start.x, point.y - start.y) > 10 { invalidate(); state = .failed }
        }
        override func touchesEnded(_ touches: Set<UITouch>, with event: UIEvent) { invalidate(); state = .failed }
        override func touchesCancelled(_ touches: Set<UITouch>, with event: UIEvent) { invalidate(); state = .failed }
        override func reset() { invalidate(); super.reset() }
        override func canPrevent(_ other: UIGestureRecognizer) -> Bool { false }
        override func canBePrevented(by other: UIGestureRecognizer) -> Bool { false }
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
        var handingOff = false
        var landsOnRow = false
    }
    @Published private(set) var items: [Item] = []
    let composer = OrbisAnchor()
    let root = OrbisAnchor()
    var targets: [String: OrbisAnchor] = [:]
    private var tasks: [String: Task<Void, Never>] = [:]
    #if DEBUG
    private var previewProgress: CGFloat? {
        ProcessInfo.processInfo.arguments.first { $0.hasPrefix("--preview-send-progress=") }
            .flatMap { Double($0.dropFirst("--preview-send-progress=".count)) }.map { CGFloat(min(1, max(0, $0))) }
    }
    var previewMetrics: String {
        guard let item = items.last else { return "count=0" }
        let point = MotionGeometry.sendPoint(from: CGPoint(x: item.source.midX, y: item.source.midY),
                                            to: CGPoint(x: item.target.midX, y: item.target.midY), progress: item.progress)
        return "count=\(items.count);id=\(item.id);lands=\(item.landsOnRow);p=\(item.progress);x=\(point.x);y=\(point.y);fromX=\(item.source.midX);fromY=\(item.source.midY);toX=\(item.target.midX);toY=\(item.target.midY)"
    }
    #endif

    func launch(_ send: PendingSend, following: Bool, reduceMotion: Bool) {
        guard !reduceMotion, !composer.frame.isEmpty, !root.frame.isEmpty,
              items.count < 3, !items.contains(where: { $0.id == send.messageId }) else { return }
        let source = composer.frame
        let fallback = CGRect(x: root.frame.maxX - min(source.width, 180) - 20, y: source.minY - 72,
                              width: min(source.width, 180), height: min(source.height, 72))
        items.append(Item(id: send.messageId, text: send.text, source: source, target: fallback))
        tasks[send.messageId] = Task { @MainActor [weak self] in
            // Allow the newly accepted row to lay out. This never delays submission or clearing the composer.
            await MotionLayoutFrames.wait()
            guard !Task.isCancelled, let self, let index = self.items.firstIndex(where: { $0.id == send.messageId }) else { return }
            if following, !send.showsInQueue, !send.queueOwned, let target = self.targets[send.messageId]?.frame, target.intersects(self.root.frame), target.maxY <= source.minY {
                self.items[index].target = target
                self.items[index].landsOnRow = true
            }
            #if DEBUG
            // A deterministic phase supplied by UI fixtures freezes production geometry for frame review.
            if let progress = self.previewProgress {
                self.items[index].progress = progress
                self.items[index].handingOff = progress >= 0.78
                self.tasks[send.messageId] = nil
                return
            }
            #endif
            withAnimation(InteractionMotion.send) { self.items[index].progress = 1 }
            try? await Task.sleep(nanoseconds: 220_000_000)
            guard !Task.isCancelled, let handingOff = self.items.firstIndex(where: { $0.id == send.messageId }) else { return }
            withAnimation(.easeOut(duration: 0.06)) { self.items[handingOff].handingOff = true }
            try? await Task.sleep(nanoseconds: 60_000_000)
            guard !Task.isCancelled else { return }
            self.items.removeAll { $0.id == send.messageId }; self.tasks[send.messageId] = nil
        }
    }
    func cancelFlights() {
        tasks.values.forEach { $0.cancel() }; tasks = [:]; items = []
    }
    func clear() { cancelFlights(); targets = [:] }
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
    func messageSendFlightTarget(_ id: String) -> some View { modifier(MessageSendFlightTarget(id: id)) }
}

private struct MessageSendFlightHost: ViewModifier {
    @ObservedObject var flight: MessageSendFlight
    @Environment(\.scenePhase) private var scene
    @Environment(\.colorScheme) private var scheme
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
            .overlay(alignment: .topLeading) {
                ZStack(alignment: .topLeading) {
                    ForEach(flight.items) { item in
                        // Canvas is a visual copy only. It never creates another readable
                        // Text node while the canonical message remains in the transcript.
                        Canvas { context, size in
                            context.clip(to: Path(CGRect(origin: .zero, size: size)))
                            context.draw(Text(item.text).font(.orbisBody()).foregroundColor(OrbisPalette(scheme).text),
                                         in: CGRect(x: 14, y: 14, width: max(0, size.width - 28), height: max(0, size.height - 28)))
                        }.accessibilityHidden(true)
                            .modifier(SendFlightPlacement(progress: item.progress, source: item.source,
                                                          target: item.target, root: flight.root.frame.origin))
                            .opacity(item.handingOff ? 0 : 1)
                    }
                }.frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
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
private struct SendFlightPlacement: AnimatableModifier {
    var progress: CGFloat
    let source: CGRect
    let target: CGRect
    let root: CGPoint
    var animatableData: CGFloat { get { progress } set { progress = newValue } }
    func body(content: Content) -> some View {
        let center = MotionGeometry.sendPoint(from: CGPoint(x: source.midX, y: source.midY),
                                              to: CGPoint(x: target.midX, y: target.midY), progress: progress)
        // Reach the message-column width during the rightward stage, so a wide composer
        // does not extend beyond the screen before the upward stage begins.
        let widthProgress = min(1, max(0, progress / 0.25))
        content.frame(width: source.width + (target.width - source.width) * widthProgress,
                      height: min(96, source.height + (target.height - source.height) * progress))
            .clipped().neuSurface(inset: true, radius: OrbisRadius.card, intensity: 0.6)
            .position(x: center.x - root.x, y: center.y - root.y)
    }
}
private struct MessageSendFlightTarget: ViewModifier {
    @Environment(\.messageSendFlight) private var flight
    let id: String
    func body(content: Content) -> some View {
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
        content.opacity(item?.landsOnRow == true && item?.handingOff == false ? 0 : 1)
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


@MainActor
final class OrbisMessageActionState: ObservableObject {
    struct Selection {
        let id: String
        let text: String
        let rewindEnabled: Bool
        let rewind: (() -> Void)?
    }
    @Published var selection: Selection?
    func dismiss(id: String? = nil) { if id == nil || selection?.id == id { selection = nil } }
}
private struct OrbisMessageActionKey: EnvironmentKey { static let defaultValue: OrbisMessageActionState? = nil }
extension EnvironmentValues {
    var orbisMessageActions: OrbisMessageActionState? {
        get { self[OrbisMessageActionKey.self] }
        set { self[OrbisMessageActionKey.self] = newValue }
    }
}
struct OrbisMessageActionScope: ViewModifier {
    @StateObject private var actions = OrbisMessageActionState()
    func body(content: Content) -> some View {
        content.environment(\.orbisMessageActions, actions)
            .orbisBackPriority("message-actions", active: actions.selection != nil) { actions.dismiss() }
            .onDisappear { actions.dismiss() }
    }
}
struct OrbisMessageActionHeader<Normal: View>: View {
    @ObservedObject var actions: OrbisMessageActionState
    @Environment(\.orbisReduceMotion) private var reduced
    @ViewBuilder var normal: Normal
    var body: some View {
        ZStack {
            normal.hidden().allowsHitTesting(false).accessibilityHidden(true)
            if actions.selection == nil { normal.transition(.opacity) }
            if let selected = actions.selection {
                HStack(spacing: 12) {
                    OrbisIconButton(symbol: "xmark", label: "退出消息操作") { actions.dismiss() }
                    OrbisMotionText("消息操作").font(.orbisBody(.semibold)).frame(maxWidth: .infinity, alignment: .leading)
                    OrbisCopyButton(label: "复制消息") { actions.selection?.text ?? "" }
                        .accessibilityIdentifier("copy-message-" + selected.id)
                    if let rewind = selected.rewind {
                        OrbisIconButton(symbol: "backward.end", label: "Rewind") {
                            guard actions.selection?.id == selected.id, selected.rewindEnabled else { return }
                            actions.dismiss(); rewind()
                        }.disabled(!selected.rewindEnabled).accessibilityIdentifier("rewind-message-" + selected.id)
                    }
                }.padding(.horizontal, 16).padding(.vertical, 10)
                    .accessibilityElement(children: .contain).accessibilityIdentifier("message-action-header")
                    .transition(.opacity.combined(with: .offset(y: -4)))
            }
        }.animation(reduced ? nil : InteractionMotion.state, value: actions.selection?.id)
    }
}


struct OrbisNewSessionCard: View {
    @Environment(\.orbisReduceMotion) private var reduced
    let title: String
    let kind: String?
    let requestId: String
    let onPresented: () -> Void
    @State private var entered = false
    var body: some View {
        HStack(spacing: 14) {
            AgentEmblem(kind: kind)
            VStack(alignment: .leading, spacing: 8) {
                OrbisMotionText(title).font(.orbisBody(.semibold)).lineLimit(2)
                RuntimeStatusLabel(status: "starting")
            }.frame(maxWidth: .infinity, alignment: .leading)
        }.neuSurface(radius: OrbisRadius.card, padding: OrbisRadius.cardPadding + 4)
            .offset(y: reduced || entered ? 0 : 32).opacity(reduced || entered ? 1 : 0)
            .accessibilityIdentifier("new-session-card")
            .task(id: requestId) {
                withAnimation(reduced ? nil : InteractionMotion.panel) { entered = true }
                if !reduced { try? await Task.sleep(for: .milliseconds(220)) }
                guard !Task.isCancelled else { return }
                onPresented()
            }
    }
}
