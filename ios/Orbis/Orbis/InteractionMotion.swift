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
    @Environment(\.orbisReduceMotion) private var reduced
    let systemName: String
    @State private var rotation: Double = 0
    private var rotates: Bool { ["gearshape", "clock.arrow.circlepath", "arrow.clockwise", "arrow.triangle.2.circlepath", "point.3.connected.trianglepath.dotted"].contains(systemName) }
    var body: some View {
        Image(systemName: systemName)
            .phaseAnimator([1.0, 0.88, 1.0], trigger: activation) { view, phase in
                view.scaleEffect(reduced || activation == 0 || rotates ? 1 : phase)
            } animation: { phase in .easeOut(duration: phase == 1 ? 0.13 : 0.09) }
            .rotationEffect(.degrees(rotation))
            .onChange(of: activation) { _, _ in
                if rotates && !reduced { withAnimation(InteractionMotion.selection) { rotation += 90 } }
            }
    }
}

/// Asset icons in action rows use the same activation source as SF Symbols.
struct OrbisActionPulse: ViewModifier {
    @Environment(\.orbisGlyphActivation) private var activation
    @Environment(\.orbisReduceMotion) private var reduced
    func body(content: Content) -> some View {
        content.phaseAnimator([1.0, 0.88, 1.0], trigger: activation) { view, phase in
            view.scaleEffect(reduced || activation == 0 ? 1 : phase)
        } animation: { phase in .easeOut(duration: phase == 1 ? 0.13 : 0.09) }
    }
}

/// All business callers use these semantic tokens (ADR-0058), including reduced motion.
enum InteractionMotion {
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
    @State private var rotation: Double = 0
    private var rotates: Bool { ["gearshape", "clock.arrow.circlepath", "arrow.clockwise", "point.3.connected.trianglepath.dotted"].contains(symbol) }

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
                        .phaseAnimator([0.0, 1.0, 0.0], trigger: activation) { view, phase in
                            view.offset(y: reduceMotion || activation == 0 ? 0 : phase * 4)
                        } animation: { phase in phase == 1 ? .easeOut(duration: 0.09) : .orbisPop }
                }
            } else {
                Image(systemName: symbol).font(.system(size: size, weight: .medium))
                    .rotationEffect(.degrees(rotation))
                    .contentTransition(.opacity)
                    .animation(reduceMotion ? nil : InteractionMotion.state, value: symbol)
                    .phaseAnimator([1.0, 0.88, 1.0], trigger: activation) { view, phase in
                        view.scaleEffect(reduceMotion || activation == 0 || rotates ? 1 : phase)
                    } animation: { phase in .easeOut(duration: phase == 1 ? 0.13 : 0.09) }
            }
        }.frame(width: size, height: size)
            .onChange(of: activation) { _, _ in
                if rotates && !reduceMotion { withAnimation(InteractionMotion.selection) { rotation += 90 } }
            }
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

/// Message actions are an anchored overlay, so opening them never changes the reading layout.
struct OrbisMessageActions: ViewModifier {
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
            .background(OrbisMenuScrollObserver { overlay.dismissMenu(owner: owner) })
            .accessibilityIdentifier("user-message-" + id)
            .simultaneousGesture(enabled ? LongPressGesture().onEnded { _ in show() } : nil)
            .accessibilityAction(named: "消息操作") { if enabled { show() } }
            .onChange(of: rewindEnabled) { _, _ in overlay.dismissMenu(owner: owner) }
            .onChange(of: id) { old, _ in overlay.dismissMenu(owner: "message-" + old) }
            .onGeometryChange(for: CGRect.self) { $0.frame(in: .global) } action: { new in
                // Keyboard and safe-area changes move the anchor without invalidating its owner.
                // Only a real scroll pan dismisses the menu; text selection remains native.
                anchor.frame = new
                overlay.moveMenu(owner: owner, to: new)
            }
            .onDisappear { overlay.dismissMenu(owner: owner) }
        } else {
            // Assistant/tool rows retain their own identifiers, links and controls.
            content
        }
    }
    private func show() {
        guard enabled, !anchor.frame.isEmpty else { return }
        var items = [OrbisMenuItem(title: "复制消息", symbol: "doc.on.doc", keepsOpen: true, identifier: "copy-message-" + id) { UIPasteboard.general.string = text }]
        if let rewind {
            items.append(OrbisMenuItem(title: "Rewind", symbol: "backward.end", disabled: !rewindEnabled, identifier: "rewind-message-" + id, action: rewind))
        }
        overlay.showMenu(items, from: anchor.frame, horizontal: true, owner: owner)
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
