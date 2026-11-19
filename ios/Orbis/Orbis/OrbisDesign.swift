import SwiftUI

private struct ChatVisualActivityKey: EnvironmentKey { static let defaultValue: ChatVisualActivity? = nil }
extension EnvironmentValues {
    var chatVisualActivity: ChatVisualActivity? {
        get { self[ChatVisualActivityKey.self] }
        set { self[ChatVisualActivityKey.self] = newValue }
    }
    /// Preview fixtures exercise the same reduction branches as the system setting.
    var orbisReduceMotion: Bool {
        #if DEBUG
        accessibilityReduceMotion || ProcessInfo.processInfo.arguments.contains("--preview-reduce-motion")
        #else
        accessibilityReduceMotion
        #endif
    }

    /// IOS-CHAT-05: a retained page remains mounted while covered or backgrounded.
    /// Visual work follows both its nearest page visibility and the scene lifecycle.
    var orbisVisualActive: Bool { orbisVisible && scenePhase == .active }

    /// Project one comparable environment dependency. A chat leaf never reads the
    /// fallback scene/visibility values when its page already supplies an owner.
    var orbisVisualActivitySource: OrbisVisualActivitySource {
        if let activity = chatVisualActivity { return .init(page: activity, fallback: false) }
        return .init(page: nil, fallback: orbisVisualActive)
    }
}

struct OrbisVisualActivitySource: Equatable {
    let page: ChatVisualActivity?
    let fallback: Bool
    static func == (lhs: Self, rhs: Self) -> Bool { lhs.page === rhs.page && lhs.fallback == rhs.fallback }
}

/// Keep the TimelineView's type and subtree stable while its clock is suspended.
/// Resuming starts at the present absolute time instead of replaying missed entries.
struct OrbisPausablePeriodicSchedule: TimelineSchedule {
    let interval: TimeInterval
    let paused: Bool

    func entries(from startDate: Date, mode: TimelineScheduleMode) -> OrbisPeriodicEntries {
        OrbisPeriodicEntries(start: max(startDate, Date()), interval: interval, paused: paused)
    }
}
import UIKit

// Shared with Android's OrbisTheme / Neumorph: one continuous base, raised
// actions and cards, recessed inputs and single-choice controls. Batch selection
// adds a tint and outline without changing depth. All distances are points.
enum OrbisAppearance: String, CaseIterable {
    case mist, sage
    static func migrate(_ defaults: UserDefaults = .standard) {
        guard defaults.string(forKey: "orbis.appearance") == nil else { return }
        defaults.set("mist", forKey: "orbis.appearance")
        defaults.removeObject(forKey: "orbis.visualStyle")
    }
}

private struct OrbisAppearanceKey: EnvironmentKey { static let defaultValue = OrbisAppearance.mist.rawValue }
private struct OrbisColorModeKey: EnvironmentKey { static let defaultValue = "system" }
private struct OrbisSystemVerticalBarKey: EnvironmentKey { static let defaultValue = false }
private struct OrbisSystemRootActionsKey: EnvironmentKey { static let defaultValue = false }
private struct OrbisPersistentDirectoryKey: EnvironmentKey { static let defaultValue = false }
extension EnvironmentValues {
    /// The stored appearance (Android: `LocalOrbisPalette`); views that follow it read this.
    var orbisAppearance: String {
        get { self[OrbisAppearanceKey.self] }
        set { self[OrbisAppearanceKey.self] = newValue }
    }
    var orbisColorMode: String {
        get { self[OrbisColorModeKey.self] }
        set { self[OrbisColorModeKey.self] = newValue }
    }
    /// True when the system places root tabs and toolbar items into a shared vertical sidebar.
    var orbisSystemVerticalBar: Bool {
        get { self[OrbisSystemVerticalBarKey.self] }
        set { self[OrbisSystemVerticalBarKey.self] = newValue }
    }
    /// True when the root screen owns the system toolbar's action buttons.
    var orbisSystemRootActions: Bool {
        get { self[OrbisSystemRootActionsKey.self] }
        set { self[OrbisSystemRootActionsKey.self] = newValue }
    }
    /// True when the session directory stays visibly pinned beside the page content.
    var orbisPersistentDirectory: Bool {
        get { self[OrbisPersistentDirectoryKey.self] }
        set { self[OrbisPersistentDirectoryKey.self] = newValue }
    }
}

/// Display preferences, read from defaults in one place (PERF-12). SwiftUI re-evaluates every
/// `@AppStorage` property on any `UserDefaults.standard` write, whatever its key — a draft keystroke,
/// a catalog cache — and re-renders the window from there. This publishes only when the appearance
/// or color mode actually changes. Writers store to `UserDefaults.standard` directly.
@MainActor final class OrbisDisplaySettings: ObservableObject {
    static let shared = OrbisDisplaySettings()
    @Published private(set) var appearance = ""
    @Published private(set) var colorMode = ""
    private var observer: NSObjectProtocol?
    private init() {
        reload()
        observer = NotificationCenter.default.addObserver(forName: UserDefaults.didChangeNotification, object: nil, queue: nil) { [weak self] _ in
            // Defaults can change on any thread; the comparison and publication happen on main.
            if Thread.isMainThread { MainActor.assumeIsolated { self?.reload() } }
            else { DispatchQueue.main.async { self?.reload() } }
        }
    }
    private func reload() {
        let appearance = UserDefaults.standard.string(forKey: "orbis.appearance") ?? OrbisAppearance.mist.rawValue
        let colorMode = UserDefaults.standard.string(forKey: "orbis.colorMode") ?? "system"
        if appearance != self.appearance { self.appearance = appearance }
        if colorMode != self.colorMode { self.colorMode = colorMode }
    }
}

/// Provides the display preferences to everything below; applied at the window root and by
/// UIKit-hosted pages, which do not inherit the root's environment.
struct OrbisDisplayPreferences: ViewModifier {
    @ObservedObject private var settings = OrbisDisplaySettings.shared
    func body(content: Content) -> some View {
        content.environment(\.orbisAppearance, settings.appearance).environment(\.orbisColorMode, settings.colorMode)
    }
}

/// The stored appearance for palettes built without one. Palettes are built in most view
/// bodies, so the preference is read once and again only after defaults change, not on every
/// body (PERF-10). Views re-render through `\.orbisAppearance`.
enum OrbisAppearanceSetting {
    private static let lock = NSLock()
    private static var cached: OrbisAppearance?
    private static var generation = 0
    private static let invalidation = NotificationCenter.default.addObserver(
        forName: UserDefaults.didChangeNotification, object: nil, queue: nil) { _ in
        lock.lock(); cached = nil; generation &+= 1; lock.unlock()
    }
    static var current: OrbisAppearance {
        _ = invalidation
        lock.lock(); let hit = cached, read = generation; lock.unlock()
        if let hit { return hit }
        // Defaults are read outside the lock: a change notification may arrive on any thread,
        // including during this read. A read overtaken by a change is used once, not cached.
        let value = OrbisAppearance(rawValue: UserDefaults.standard.string(forKey: "orbis.appearance") ?? "mist") ?? .mist
        lock.lock(); if generation == read { cached = value }; lock.unlock()
        return value
    }
}

/// The design specification's four themes share one semantic palette. Recesses
/// keep their parent material; only the paired inner shadows describe depth.
struct OrbisPalette {
    let dark: Bool
    let appearance: OrbisAppearance
    init(_ scheme: ColorScheme, appearance: OrbisAppearance? = nil) {
        dark = scheme == .dark
        self.appearance = appearance ?? OrbisAppearanceSetting.current
    }
    private var sage: Bool { appearance == .sage }
    private func material(_ mistLight: UInt32, _ mistDark: UInt32, _ sageLight: UInt32, _ sageDark: UInt32) -> Color {
        Color(hex: sage ? (dark ? sageDark : sageLight) : (dark ? mistDark : mistLight))
    }
    var base: Color { material(0xE6EBF4, 0x23262E, 0xE0E7DF, 0x33393D) }
    var lift: Color { material(0xEDF1F8, 0x292D36, 0xE8EEE5, 0x3A4246) }
    var top: Color { material(0xF3F6FB, 0x2F333D, 0xF0F5ED, 0x424B50) }
    var well: Color { base }
    var inset: Color { base }
    var light: Color { material(0xFFFFFF, 0x343946, 0xF8FBF5, 0x4A555A) }
    var shadow: Color { material(0xA6B2C6, 0x0A0C11, 0xB2C0B0, 0x1C2427) }
    var scrim: Color { material(0x2A3344, 0x05070A, 0x203626, 0x0B1214) }
    var text: Color { material(0x232A36, 0xDDE1E9, 0x2F4235, 0xEFF3F0) }
    var secondary: Color { material(0x4A5364, 0xB8C0CE, 0x4F6153, 0xBAC7C2) }
    var faint: Color { material(0x737D90, 0x858D9C, 0x6E7F6F, 0x8E9C97) }
    var accent: Color { material(0x2F5287, 0xAFC6E6, 0x41603F, 0xA9DDC1) }
    var accentSoft: Color { material(0xD0D9E7, 0x343944, 0xD3DCD2, 0x414D4D) }
    var onAccent: Color { material(0xFFFFFF, 0x16233A, 0xFFFFFF, 0x173322) }
    var error: Color { Color(hex: dark ? 0xFFB4AB : 0xAD241C) }
    var success: Color { material(0x1A6A4D, 0x84D6B3, 0x1A6A4D, 0x8FDDB8) }
    var warning: Color { Color(hex: dark ? 0xF2C26B : 0x845000) }
    var outline: Color { material(0xC9D1DE, 0x3A4150, 0xC7D1C5, 0x4A5653) }
    var shadeOpacity: Double { dark ? 0.70 : sage ? 0.65 : 0.55 }
    var highlightOpacity: Double { dark || sage ? (sage && dark ? 0.70 : 0.80) : 0.90 }
    func layer(_ index: Int) -> Color { [base, base, lift, top][min(max(index, 0), 3)] }
    func agent(_ kind: String?) -> Color {
        switch kind {
        case "codex", "codexDesktop": return Color(hex: dark ? 0x77D6C7 : 0x00655D)
        case "dsh", "dshDesktop": return Color(hex: dark ? 0xA9BBFF : 0x3550CF)
        case "opencode": return Color(hex: dark ? 0xA99BFF : 0x5E4CAD)
        case kimiCodeKind: return Color(hex: dark ? 0xBDC6FF : 0x343B8E)
        case "claude": return Color(hex: dark ? 0xF0B48C : 0x9A4521)
        default: return Color(hex: dark ? 0xF0A9D3 : 0x8C3870)
        }
    }
}

extension Color {
    init(hex: UInt32) {
        self.init(.sRGB, red: Double((hex >> 16) & 255) / 255,
                  green: Double((hex >> 8) & 255) / 255, blue: Double(hex & 255) / 255, opacity: 1)
    }
}

private struct OrbisKeyboardNavigationKey: EnvironmentKey { static let defaultValue = false }
extension EnvironmentValues {
    var orbisKeyboardNavigation: Bool { get { self[OrbisKeyboardNavigationKey.self] } set { self[OrbisKeyboardNavigationKey.self] = newValue } }
}
struct OrbisInputModality: ViewModifier {
    @State private var keyboard = false
    func body(content: Content) -> some View {
        content.environment(\.orbisKeyboardNavigation, keyboard)
            .onKeyPress(.tab) { keyboard = true; return .ignored }
            .simultaneousGesture(SpatialTapGesture().onEnded { _ in keyboard = false })
    }
}

// MARK: - Type, radius, motion

/// The whole interface uses four sizes; weight, color and spacing carry the rest of the hierarchy.
enum OrbisTextSize {
    static let display: CGFloat = 28
    static let title: CGFloat = 20
    static let body: CGFloat = 15
    static let label: CGFloat = 13
    /// Smallest readable size.
    static let caption: CGFloat = 12
}

extension Font {
    /// Digits are tabular everywhere so counts, sizes and timers never shift their neighbours.
    static func orbisDisplay() -> Font { orbis(OrbisTextSize.display, .semibold) }
    static func orbisTitle(_ weight: Font.Weight = .semibold) -> Font { orbis(OrbisTextSize.title, weight) }
    static func orbisBody(_ weight: Font.Weight = .regular, mono: Bool = false) -> Font { orbis(OrbisTextSize.body, weight, mono) }
    static func orbisLabel(_ weight: Font.Weight = .regular, mono: Bool = false) -> Font { orbis(OrbisTextSize.label, weight, mono) }
    static func orbisCaption(_ weight: Font.Weight = .regular, mono: Bool = false) -> Font { orbis(OrbisTextSize.caption, weight, mono) }
    private static func orbis(_ size: CGFloat, _ weight: Font.Weight, _ mono: Bool = false) -> Font {
        .system(size: size, weight: weight, design: mono ? .monospaced : .default).monospacedDigit()
    }
}

/// A container's children use `radius - padding`, so nested corners stay concentric.
enum OrbisRadius {
    static let control: CGFloat = 16
    static let card: CGFloat = 24
    static let cardPadding: CGFloat = 12
    static let menu: CGFloat = 24
    static let menuPadding: CGFloat = 8
    static let dialog: CGFloat = 32
    static let dialogPadding: CGFloat = 16
    static let sheet: CGFloat = 32
}

/// The implicit SwiftUI and measured native-host adapters use one motion spec.
enum OrbisCollapseMotion {
    static let spring = Spring.smooth(duration: 0.26)
}

extension Animation {
    /// Drag release: stiffness 1200, damping 80. Overdamped, so it settles without overshoot.
    static let orbisDrag = Animation.interpolatingSpring(mass: 1, stiffness: 1200, damping: 80)
    /// Page release keeps a visible elastic settle, matching Android's swipe-back spring.
    static func orbisSwipeBack(velocity: Double) -> Animation {
        .interpolatingSpring(mass: 1, stiffness: 260, damping: 24, initialVelocity: velocity)
    }
    /// Small confirmations (checks, toggles): stiffness 380, damping 18, a slight bounce.
    static let orbisPop = Animation.interpolatingSpring(mass: 1, stiffness: 380, damping: 18)
    static let orbisCollapse = Animation.spring(OrbisCollapseMotion.spring)
    static let orbisFade = Animation.easeOut(duration: 0.16)
}

extension View {
    /// Puts an icon's center 0.375em above the first text baseline (the CSS
    /// `vertical-align: -0.125em` rule) in rows aligned by `.firstTextBaseline`.
    func orbisIconBaseline(_ fontSize: CGFloat) -> some View {
        alignmentGuide(.firstTextBaseline) { d in d[VerticalAlignment.center] + fontSize * 0.375 }
    }
}

// MARK: - Surfaces

/// Only the outermost surface draws a frame (soft shadows). Surfaces inside it become flat
/// fills one lightness layer away from their parent, and inherit `innerRadius` so the
/// nested corners stay concentric.
struct OrbisSurfaceContext: Equatable {
    var layer: Int
    var depth: Int
    var innerRadius: CGFloat?
}

private struct OrbisSurfaceKey: EnvironmentKey {
    static let defaultValue: OrbisSurfaceContext? = nil
}

private struct OrbisAccentKey: EnvironmentKey {
    static let defaultValue: Color? = nil
}

extension EnvironmentValues {
    var orbisSurface: OrbisSurfaceContext? {
        get { self[OrbisSurfaceKey.self] }
        set { self[OrbisSurfaceKey.self] = newValue }
    }
    /// The agent color of the page (a chat); controls default to the app accent outside one.
    var orbisAccent: Color? {
        get { self[OrbisAccentKey.self] }
        set { self[OrbisAccentKey.self] = newValue }
    }
}

/// Quantize the legacy intensity call sites to the three shared depth tokens.
private func surfaceIntensity(_ value: CGFloat) -> CGFloat {
    value <= 0 ? 0 : value <= 0.42 ? 0.4 : value < 1 ? 0.65 : 1
}

private struct OrbisVisibleKey: EnvironmentKey { static let defaultValue = true }
extension EnvironmentValues {
    var orbisVisible: Bool { get { self[OrbisVisibleKey.self] } set { self[OrbisVisibleKey.self] = newValue } }
}

/// Context forwarding is an action dependency, not a reason for every closed presenter to observe the Hub.
private struct OrbisStoreReferenceKey: EnvironmentKey { static let defaultValue: OrbisStore? = nil }
extension EnvironmentValues {
    var orbisStoreReference: OrbisStore? {
        get { self[OrbisStoreReferenceKey.self] }
        set { self[OrbisStoreReferenceKey.self] = newValue }
    }
}

/// A stable action recipient, deliberately not an ObservableObject subscription. Message text
/// can start a download without being invalidated by every transfer's progress publication.
private struct OrbisFileActionsKey: EnvironmentKey {
    static let defaultValue: FileTransfers? = nil
}

extension EnvironmentValues {
    var orbisFileActions: FileTransfers? {
        get { self[OrbisFileActionsKey.self] }
        set { self[OrbisFileActionsKey.self] = newValue }
    }
}

/// Hosted chat roots use the stable activity reference; other surfaces keep
/// their ordinary visibility/scene environment. Only the consuming leaf observes it.
@MainActor @propertyWrapper
struct OrbisVisualActive: DynamicProperty {
    @Environment(\.orbisVisualActivitySource) private var source
    var wrappedValue: Bool { source.page?.active ?? source.fallback }
}

private struct NeuSurface: ViewModifier {
    @Environment(\.orbisReduceMotion) private var reduced
    @OrbisVisualActive private var visualActive
    let inset: Bool
    let radius: CGFloat
    let intensity: CGFloat
    let padding: CGFloat
    let concentric: Bool
    let press: Bool?
    func body(content: Content) -> some View {
        content.modifier(NeuDepthSurface(depth: (inset ? -1 : 1) * surfaceIntensity(intensity),
                                        radius: radius, padding: padding, concentric: concentric))
            .animation(reduced || !visualActive ? nil : press.map { $0 ? InteractionMotion.glyphPress : InteractionMotion.glyphRelease } ?? InteractionMotion.selection, value: inset)
    }
}

/// Signed depth interpolates through the flat material instead of swapping surfaces.
private struct NeuDepthSurface: AnimatableModifier {
    @Environment(\.colorScheme) private var scheme
    @Environment(\.orbisAppearance) private var appearance
    @Environment(\.orbisSurface) private var parent
    var depth: CGFloat
    let radius: CGFloat
    let padding: CGFloat
    let concentric: Bool
    var animatableData: CGFloat { get { depth } set { depth = newValue } }
    func body(content: Content) -> some View {
        let p = OrbisPalette(scheme)
        let r = concentric ? (parent?.innerRadius ?? radius) : radius
        let parentLayer = parent?.layer ?? 1
        let layer = depth < 0 ? parentLayer : min(parentLayer + (parent == nil ? 0 : 1), 3)
        let fill = p.layer(layer)
        let shape = RoundedRectangle(cornerRadius: r, style: .continuous)
        let outer = parent == nil ? max(depth, 0) : 0
        let inner = max(-depth, 0)
        content.padding(padding)
            .environment(\.orbisSurface, OrbisSurfaceContext(layer: layer, depth: (parent?.depth ?? 0) + 1,
                innerRadius: padding > 0 ? max(r - padding, 0) : nil))
            .background {
                Group {
                    if inner > 0 {
                        shape.fill(fill
                            .shadow(.inner(color: p.shadow.opacity(p.shadeOpacity * inner), radius: 4 * inner, x: 4 * inner, y: 4 * inner))
                            .shadow(.inner(color: p.light.opacity(p.highlightOpacity * inner), radius: 4 * inner, x: -4 * inner, y: -4 * inner)))
                    } else { shape.fill(fill) }
                }.shadow(color: p.shadow.opacity(p.shadeOpacity * outer), radius: 4 * outer, x: 4 * outer, y: 4 * outer)
                    .shadow(color: p.light.opacity(p.highlightOpacity * outer), radius: 4 * outer, x: -4 * outer, y: -4 * outer)
            }
    }
}

extension View {
    /// `padding` is applied inside the surface; nested surfaces then use `radius - padding`.
    /// Circles and capsules pass `concentric: false` to keep their own shape.
    func neuSurface(inset: Bool = false, radius: CGFloat = 20, intensity: CGFloat = 0.65,
                    padding: CGFloat = 0, concentric: Bool = true, press: Bool? = nil) -> some View {
        modifier(NeuSurface(inset: inset, radius: radius, intensity: intensity, padding: padding, concentric: concentric, press: press))
    }

    /// For views layered over a surface from outside its content (overlays, panels drawn by hand).
    func orbisNested(layer: Int = 1, innerRadius: CGFloat? = nil) -> some View {
        environment(\.orbisSurface, OrbisSurfaceContext(layer: layer, depth: 1, innerRadius: innerRadius))
    }

    /// Recessed field. Focus deepens the recess and adds two soft accent rings instead of a hard stroke.
    func orbisField(focused: Bool, radius: CGFloat = OrbisRadius.control) -> some View {
        modifier(OrbisField(focused: focused, radius: radius))
    }

    func orbisInput(focused: Bool) -> some View {
        padding(.horizontal, 16).padding(.vertical, 14)
            .fixedSize(horizontal: false, vertical: true)
            .frame(minHeight: 56)
            .orbisField(focused: focused)
    }
}

private struct OrbisField: ViewModifier {
    @OrbisVisualActive private var visualActive
    @Environment(\.orbisKeyboardNavigation) private var keyboard
    @Environment(\.orbisAccent) private var accent
    @Environment(\.colorScheme) private var scheme
    @Environment(\.orbisSurface) private var parent
    @Environment(\.orbisAppearance) private var visualStyle
    let focused: Bool
    let radius: CGFloat

    func body(content: Content) -> some View {
        let r = parent?.innerRadius ?? radius
        let shape = RoundedRectangle(cornerRadius: r, style: .continuous)
        content
            .neuSurface(inset: true, radius: radius, intensity: 0.65)
            // Outer halo: only the half outside the field shows; the field covers the rest.
            .background { shape.stroke(.tint.opacity(focused ? 0.12 : 0), lineWidth: 8) }
            .overlay { shape.stroke(.tint.opacity(focused ? 0.28 : 0), lineWidth: 1) }
            .overlay { if focused && keyboard { shape.stroke(accent ?? OrbisPalette(scheme).accent, lineWidth: 2).padding(-4) } }
            .animation(visualActive ? .orbisFade : nil, value: focused)
    }
}

/// Fills with the lightness layer `offset` steps away from the surrounding surface,
/// so rows and headers separate by background steps instead of drawn lines.
struct OrbisLayerFill: View {
    @Environment(\.colorScheme) private var scheme
    @Environment(\.orbisAppearance) private var visualStyle
    @Environment(\.orbisSurface) private var surface
    var offset = 1
    var opacity: Double = 1
    var body: some View {
        let layer = surface?.layer ?? 1
        OrbisPalette(scheme).layer(layer + offset <= 3 ? layer + offset : layer - offset).opacity(opacity)
    }
}

/// Animates a clipping frame between 0 and the content's natural height (the grid
/// `0fr → 1fr` technique). Mount only on first expansion (ADR-0048), then keep content
/// identity and natural layout across subsequent toggles.
struct OrbisCollapse<Content: View>: View {
    @Environment(\.orbisReduceMotion) private var reduceMotion
    @OrbisVisualActive private var visualActive
    @Environment(\.chatNativeCellGeometry) private var nativeGeometry
    let expanded: Bool
    @ViewBuilder var content: () -> Content
    @State private var hasExpanded: Bool
    @State private var shown: Bool
    @State private var animating = false
    @State private var height: CGFloat?
    @State private var token = 0

    init(expanded: Bool, @ViewBuilder content: @escaping () -> Content) {
        self.expanded = expanded
        self.content = content
        _hasExpanded = State(initialValue: expanded)
        _shown = State(initialValue: expanded)
    }

    var body: some View {
        if nativeGeometry != nil {
            ChatNativeCollapse(expanded: expanded, content: content)
        } else {
            Group {
                if expanded || hasExpanded {
                    content()
                        .fixedSize(horizontal: false, vertical: true)
                        .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { height = $0 }
                        // At rest an open container takes the content's live height, so growing content is never clipped.
                        .frame(height: shown ? (animating ? height : nil) : 0, alignment: .top)
                        .clipped()
                        .opacity(shown ? 1 : 0)
                        .allowsHitTesting(shown)
                        .accessibilityHidden(!shown)
                }
            }
                .onChange(of: expanded) { _, value in
                    if value { hasExpanded = true }
                    token += 1
                    let current = token
                    if reduceMotion || !visualActive { settle(); return }
                    // Pin the measured height first so the animation interpolates between two numbers.
                    animating = true
                    DispatchQueue.main.async {
                        guard token == current else { return }
                        withAnimation(.orbisCollapse) { shown = value } completion: {
                            if token == current { animating = false }
                        }
                    }
                }
                .onChange(of: visualActive) { _, active in
                    if !active { settle() }
                }
                .onDisappear { settle() }
        }
    }

    private func settle() {
        token += 1
        var transaction = Transaction(animation: nil)
        transaction.disablesAnimations = true
        withTransaction(transaction) {
            if expanded { hasExpanded = true }
            shown = expanded; animating = false
        }
    }
}

// MARK: - Controls

#if DEBUG
/// Isolated launch-argument fixture: counts actual builder invocations and layout passes.
private final class DisclosureWorkCounts {
    var builds = 0
    var layouts = 0
}

private struct DisclosureProbeLayout: Layout {
    let counts: DisclosureWorkCounts
    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        counts.layouts += 1
        return subviews.first?.sizeThatFits(proposal) ?? .zero
    }
    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        subviews.first?.place(at: bounds.origin, proposal: proposal)
    }
}

private struct DisclosureStateProbe: View {
    let text: String
    @State private var count = 0
    var body: some View {
        VStack(alignment: .leading) {
            Button("Count \(count)") { count += 1 }.accessibilityIdentifier("disclosure-counter")
            Text(text)
            Text(String(repeating: "Long hidden thinking\n", count: 300))
        }
    }
}

struct DisclosurePerformancePreview: View {
    @State private var counts = DisclosureWorkCounts()
    @State private var generation = 0
    @State private var report = ""
    @State private var text = "Original body"
    var body: some View {
        VStack {
            HStack {
                Button("Sample") { report = "builds=\(counts.builds) layouts=\(counts.layouts)" }
                Button("Reopen") { counts = DisclosureWorkCounts(); generation += 1; report = "" }
                Button("Update") { text = "Updated body" }
            }
            Text(report).accessibilityIdentifier("disclosure-counts")
            ScrollView {
                VStack {
                    ForEach(0..<30) { index in
                        CompactDisclosure(title: "Detail \(index)", symbol: "sparkles") { probe() }
                    }
                }.id(generation)
            }
        }.padding()
    }
    private func probe() -> some View {
        counts.builds += 1
        return DisclosureProbeLayout(counts: counts) { DisclosureStateProbe(text: text) }
    }
}
#endif

/// Reserved for deliberate submissions, rather than every button press.
/// Medium at full intensity: the selection tick and light impacts are hard to feel with the phone in hand.
@MainActor
enum OrbisHaptics {
    private static let impact = UIImpactFeedbackGenerator(style: .medium)

    private static let selection = UISelectionFeedbackGenerator()
    static func beginSelection() { selectionChanged() }
    static func selectionChanged() { selection.selectionChanged(); selection.prepare() }

    static func commit() {
        impact.impactOccurred()
        impact.prepare()
    }
}

struct NeuButtonStyle: ButtonStyle {
    @OrbisVisualActive private var visualActive
    @Environment(\.isFocused) private var keyboardFocused
    @Environment(\.orbisAccent) private var accent
    @Environment(\.colorScheme) private var scheme
    @Environment(\.orbisReduceMotion) private var reduced
    @Environment(\.isEnabled) private var enabled
    let selected: Bool
    let radius: CGFloat
    let padding: CGFloat
    init(selected: Bool = false, radius: CGFloat = OrbisRadius.control, padding: CGFloat = 0) {
        self.selected = selected; self.radius = radius; self.padding = padding
    }
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .environment(\.orbisGlyphPressed, configuration.isPressed && enabled)
            .neuSurface(inset: selected || configuration.isPressed, radius: radius, intensity: enabled ? 0.65 : 0, padding: padding, press: configuration.isPressed)
            .overlay { if !enabled { RoundedRectangle(cornerRadius: radius).strokeBorder(OrbisPalette(scheme).outline, lineWidth: 1) } }
            .contentShape(RoundedRectangle(cornerRadius: radius))
            .overlay { if keyboardFocused && enabled { RoundedRectangle(cornerRadius: radius).stroke(accent ?? OrbisPalette(scheme).accent, lineWidth: 2).padding(-4) } }
            .animation(reduced || !visualActive ? nil : configuration.isPressed ? InteractionMotion.glyphPress : InteractionMotion.glyphRelease, value: configuration.isPressed)
    }
}

/// Batch selection is a color change, never a change to the card's depth or layout.
struct OrbisSelectionButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var enabled
    @Environment(\.colorScheme) private var scheme
    @Environment(\.orbisAppearance) private var visualStyle
    @Environment(\.orbisSurface) private var parent
    let selected: Bool
    let selecting: Bool
    var radius: CGFloat = OrbisRadius.card
    var padding: CGFloat = 0
    var recessed = false
    @State private var touchOrigin: CGPoint?

    func makeBody(configuration: Configuration) -> some View {
        let shape = RoundedRectangle(cornerRadius: parent?.innerRadius ?? radius, style: .continuous)
        let accent = OrbisPalette(scheme).accent
        configuration.label
            .environment(\.orbisGlyphPressed, configuration.isPressed && enabled)
            // Keep the opaque selection material below the label and above the surface.
            // Expand through the surface padding without changing content geometry.
            .background {
                OrbisSelectionFill(selected: selected, origin: touchOrigin,
                                   radius: parent?.innerRadius ?? radius, color: accent)
                    .padding(-padding)
            }
            .neuSurface(inset: recessed || (!selecting && configuration.isPressed), radius: radius, intensity: enabled ? 0.65 : 0, padding: padding, press: configuration.isPressed)
            .background(OrbisTouchOrigin { touchOrigin = $0 })
            .contentShape(shape)
            .overlay { if !enabled { shape.strokeBorder(OrbisPalette(scheme).outline, lineWidth: 1) } }
    }
}

/// Keep the slot even outside selection mode, so labels and cards never reflow.
struct OrbisSelectionIndicator: View {
    @OrbisVisualActive private var visualActive
    @Environment(\.colorScheme) private var scheme
    @Environment(\.orbisAppearance) private var visualStyle
    @Environment(\.orbisReduceMotion) private var reduced
    let selected: Bool
    let selecting: Bool

    var body: some View {
        let p = OrbisPalette(scheme)
        Circle().fill(selected ? p.accent : .clear)
            .overlay { Circle().strokeBorder(selected ? p.accent : p.secondary.opacity(0.55), lineWidth: 1.5) }
            .overlay {
                Image(systemName: "checkmark").font(.system(size: 12, weight: .bold))
                    .foregroundStyle(p.onAccent).opacity(selected ? 1 : 0)
            }
            .frame(width: 24, height: 24)
            .opacity(selecting ? 1 : 0)
            .animation(reduced || !visualActive ? nil : InteractionMotion.state, value: selected)
            .animation(reduced || !visualActive ? nil : InteractionMotion.state, value: selecting)
            .allowsHitTesting(false).accessibilityHidden(true)
    }
}

/// `size` is the visible disc; the touch target stays at least 44pt (48pt for the default 40pt disc).
struct OrbisIconButton: View {
    @Environment(\.isEnabled) private var enabled
    @Environment(\.colorScheme) private var scheme
    @Environment(\.orbisAppearance) private var visualStyle
    let symbol: String
    let label: String
    var tint: Color? = nil
    var selected = false
    var size: CGFloat = 40
    /// Side actions: 36pt disc, 48pt target. Adjacent rows need no extra spacing
    /// because the target already leaves 6pt between the disc and the card.
    var compact = false
    var morphFrom: String? = nil
    @State private var activation = 0
    let action: () -> Void
    var body: some View {
        let diameter: CGFloat = compact ? 36 : size
        Button { activation += 1; action() } label: {
            OrbisMotionGlyph(symbol: symbol, size: compact ? 18 : size * 0.55, activation: activation, morphFrom: morphFrom)
                .foregroundStyle(enabled ? (tint ?? OrbisPalette(scheme).secondary) : OrbisPalette(scheme).faint)
                .frame(width: diameter, height: diameter)
        }
        .buttonStyle(NeuIconButtonStyle(selected: selected, size: diameter, compact: compact)).accessibilityLabel(label)
    }
}

struct NeuIconButtonStyle: ButtonStyle {
    @OrbisVisualActive private var visualActive
    @Environment(\.isFocused) private var keyboardFocused
    @Environment(\.orbisAccent) private var accent
    @Environment(\.colorScheme) private var scheme
    @Environment(\.orbisReduceMotion) private var reduced
    @Environment(\.isEnabled) private var enabled
    let selected: Bool
    var size: CGFloat = 40
    var compact = false
    func makeBody(configuration: Configuration) -> some View {
        let target = max(48, size + 8)
        return configuration.label
            .environment(\.orbisGlyphPressed, configuration.isPressed && enabled)
            .neuSurface(inset: selected || configuration.isPressed, radius: size / 2,
                        intensity: enabled ? (size <= 36 ? 0.4 : 0.65) : 0, concentric: false, press: configuration.isPressed)
            .overlay { if !enabled { Circle().strokeBorder(OrbisPalette(scheme).outline, lineWidth: 1) } }
            .overlay { if keyboardFocused && enabled { Circle().stroke(accent ?? OrbisPalette(scheme).accent, lineWidth: 2).padding(-4) } }
            .frame(width: target, height: target).contentShape(Rectangle())
            .animation(reduced || !visualActive ? nil : configuration.isPressed ? InteractionMotion.glyphPress : InteractionMotion.glyphRelease, value: configuration.isPressed)
    }
}

/// Small raised text action (Android `NeumorphTextButton`): replaces bare system-tinted text buttons.
struct OrbisTextButton: View {
    @Environment(\.isEnabled) private var enabled
    @Environment(\.colorScheme) private var scheme
    @Environment(\.orbisAppearance) private var visualStyle
    @Environment(\.orbisAccent) private var pageAccent
    let title: String
    var symbol: String? = nil
    var tint: Color? = nil
    var fill = false
    /// Swaps the icon for a spinner in the same slot, so the button keeps its size.
    var loading = false
    @State private var activation = 0
    let action: () -> Void
    var body: some View {
        Button { activation += 1; action() } label: {
            HStack(spacing: 6) {
                if let symbol {
                    ZStack {
                        OrbisMotionGlyph(symbol: symbol, size: 16, activation: activation).opacity(loading ? 0 : 1)
                        if loading { ProgressView().controlSize(.mini) }
                    }
                }
                OrbisMotionText(title).lineLimit(1)
            }.font(.orbisLabel(.semibold))
                .foregroundStyle(enabled ? (tint ?? pageAccent ?? OrbisPalette(scheme).accent) : OrbisPalette(scheme).faint)
                .padding(.horizontal, 14).frame(maxWidth: fill ? .infinity : nil, minHeight: 48)
        }.buttonStyle(NeuButtonStyle(radius: 16))
    }
}

/// Raised when off, recessed with the accent check when on (Android `NeumorphCheckbox`).
struct OrbisCheckbox: View {
    @OrbisVisualActive private var visualActive
    @Environment(\.colorScheme) private var scheme
    @Environment(\.orbisAppearance) private var visualStyle
    @Environment(\.orbisReduceMotion) private var reduced
    let checked: Bool
    let label: String
    let action: () -> Void
    var body: some View {
        Button(action: action) {
            Image(systemName: "checkmark").font(.system(size: 12, weight: .bold))
                .foregroundStyle(OrbisPalette(scheme).accent)
                .scaleEffect(checked ? 1 : 0.5).opacity(checked ? 1 : 0)
                .animation(reduced || !visualActive ? nil : .orbisPop, value: checked)
                .frame(width: 24, height: 24)
                .neuSurface(inset: checked, radius: 8, intensity: 0.42, concentric: false)
                .frame(width: 48, height: 48).contentShape(Rectangle())
        }.buttonStyle(.plain)
            .accessibilityLabel(label).accessibilityAddTraits(checked ? .isSelected : [])
    }
}

/// Neutral material track and rounded square thumb: accent belongs to the ink.
struct NeuToggleStyle: ToggleStyle {
    @OrbisVisualActive private var visualActive
    @Environment(\.colorScheme) private var scheme
    @Environment(\.orbisAppearance) private var appearance
    @Environment(\.orbisReduceMotion) private var reduced
    @Environment(\.isEnabled) private var enabled
    func makeBody(configuration: Configuration) -> some View {
        let p = OrbisPalette(scheme)
        let on = configuration.isOn
        return Button { configuration.isOn.toggle() } label: {
            HStack(spacing: 12) {
                configuration.label.frame(maxWidth: .infinity, alignment: .leading)
                ZStack(alignment: on ? .trailing : .leading) {
                    RoundedRectangle(cornerRadius: 8).fill(p.base)
                        .overlay { Circle().fill(enabled && on ? p.accent : p.faint).frame(width: 4, height: 4) }
                        .frame(width: 24, height: 24)
                        .neuSurface(radius: 8, intensity: enabled ? 0.4 : 0, concentric: false)
                        .padding(4)
                }.frame(width: 56, height: 32)
                    .neuSurface(inset: true, radius: 12, intensity: enabled ? 0.4 : 0, concentric: false)
                    .animation(reduced || !visualActive ? nil : InteractionMotion.selection, value: on)
            }.frame(minHeight: 48).contentShape(Rectangle())
        }.buttonStyle(.plain)
            .accessibilityAddTraits(.isToggle).accessibilityValue(on ? L10n.tr("开") : L10n.tr("关"))
    }
}

/// Copy action whose glyph animates into success and restores after 2.5 seconds.
struct OrbisCopyButton: View {
    @Environment(\.colorScheme) private var scheme
    @Environment(\.orbisAppearance) private var visualStyle
    @Environment(\.isEnabled) private var enabled
    @OrbisVisualActive private var visualActive
    let label: String
    var size: CGFloat = 28
    let text: () -> String
    @StateObject private var feedback = OrbisCopyFeedback()

    var body: some View {
        let p = OrbisPalette(scheme)
        let copied = feedback.copied
        OrbisMotionButton { feedback.perform { UIPasteboard.general.string = text() } } label: {
            OrbisCopyGlyph(copied: copied, size: size * 0.5,
                normalColor: p.secondary, successColor: p.success)
                .frame(width: size, height: size)
        }
        .buttonStyle(NeuIconButtonStyle(selected: false, size: size))
        .accessibilityLabel(copied ? L10n.tr("已复制") : label)
        .onChange(of: enabled) { _, enabled in if !enabled { feedback.clear() } }
        .onChange(of: visualActive) { _, active in if !active { feedback.clear() } }
        .onDisappear { feedback.clear() }
    }
}

// MARK: - Sheets

enum OrbisSheetDetent: Int, Comparable, Hashable {
    case medium, large
    static func < (lhs: Self, rhs: Self) -> Bool { lhs.rawValue < rhs.rawValue }
}

private protocol OrbisSheetDetentProviding {
    var orbisSheetDetents: [OrbisSheetDetent] { get }
}

private struct OrbisSheetConfiguredView<Content: View>: View, OrbisSheetDetentProviding {
    @Environment(\.colorScheme) private var scheme
    let content: Content
    let rawDetents: Set<PresentationDetent>
    let stops: [OrbisSheetDetent]
    var orbisSheetDetents: [OrbisSheetDetent] { stops }

    var body: some View {
        content
            .environment(\.orbisSurface, OrbisSurfaceContext(layer: 1, depth: 1, innerRadius: 16))
            .preference(key: OrbisSheetDetentsKey.self, value: stops)
            .presentationDetents(rawDetents)
            .presentationDragIndicator(.hidden)
            .presentationCornerRadius(OrbisRadius.sheet)
            .presentationBackground(OrbisPalette(scheme).base)
    }
}

private struct OrbisSheetDetentsKey: PreferenceKey {
    static let defaultValue: [OrbisSheetDetent] = []
    static func reduce(value: inout [OrbisSheetDetent], nextValue: () -> [OrbisSheetDetent]) {
        if value.isEmpty { value = nextValue() }
    }
}

extension View {
    func orbisSheet(_ detents: Set<PresentationDetent> = [.large]) -> some View {
        var stops: [OrbisSheetDetent] = []
        if detents.contains(.medium) { stops.append(.medium) }
        if detents.contains(where: { $0 != .medium }) || stops.isEmpty { stops.append(.large) }
        return OrbisSheetConfiguredView(content: self, rawDetents: detents, stops: stops)
    }
}

private struct OrbisDismissKey: EnvironmentKey { static let defaultValue: (() -> Void)? = nil }
private struct OrbisRetireKey: EnvironmentKey { static let defaultValue: (() -> Void)? = nil }
extension EnvironmentValues {
    var orbisDismiss: (() -> Void)? { get { self[OrbisDismissKey.self] } set { self[OrbisDismissKey.self] = newValue } }
    var orbisRetire: (() -> Void)? { get { self[OrbisRetireKey.self] } set { self[OrbisRetireKey.self] = newValue } }
}

/// Native sheets expose one dismissal action to their content.
@propertyWrapper struct OrbisDismiss: DynamicProperty {
    @Environment(\.dismiss) private var system
    @Environment(\.orbisDismiss) private var custom
    var wrappedValue: () -> Void { custom ?? { system() } }
}

/// Losing presentation authority retires this owner without dismissing newer sheets.
@propertyWrapper struct OrbisRetire: DynamicProperty {
    @Environment(\.dismiss) private var system
    @Environment(\.orbisRetire) private var custom
    var wrappedValue: () -> Void { custom ?? { system() } }
}

/// The overlay owns presentation, while the presenter continues to own state. A live
/// source republishes a fresh builder after parent changes without remounting the sheet.
@MainActor
private final class OrbisLiveSheetSource: ObservableObject {
    var content: () -> AnyView = { AnyView(EmptyView()) }
    var mountCount = 0
    private var scheduled = false

    func prepare(_ builder: @escaping () -> AnyView) {
        content = builder
    }

    func update(_ builder: @escaping () -> AnyView) {
        content = builder
        guard mountCount > 0, !scheduled else { return }
        scheduled = true
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.scheduled = false
            guard self.mountCount > 0 else { return }
            self.objectWillChange.send()
        }
    }
}

private struct OrbisLiveSheetContent: View {
    @ObservedObject var source: OrbisLiveSheetSource
    var body: some View {
        source.content()
            .onAppear { source.mountCount += 1 }
            .onDisappear { source.mountCount = max(0, source.mountCount - 1) }
    }
}

private struct OrbisBottomSheetPresenter<Sheet: View>: ViewModifier {
    @EnvironmentObject private var overlay: OrbisOverlay
    @Environment(\.orbisStoreReference) private var storeReference
    @Environment(\.orbisAccent) private var accent
    @Environment(\.colorScheme) private var scheme
    @Environment(\.locale) private var locale
    @Environment(\.layoutDirection) private var layoutDirection
    @Binding var presented: Bool
    var onDismiss: (() -> Void)?
    let retireIndependently: Bool
    let sheet: () -> Sheet
    @State private var owner = UUID()
    // @State retains the source without subscribing the presenter to its publications.
    @State private var liveSheet = OrbisLiveSheetSource()

    private func wrapSheet(_ view: Sheet) -> AnyView {
        let base = view
            .environment(\.orbisAccent, accent)
            .tint(accent ?? OrbisPalette(scheme).accent)
            .environment(\.locale, locale)
            .environment(\.layoutDirection, layoutDirection)
        guard let store = storeReference else { return AnyView(base) }
        return AnyView(base
            .environmentObject(store)
            .environment(\.orbisStoreReference, store)
            .environmentObject(store.hostState)
            .environmentObject(store.transfers)
            .environmentObject(store.toolInventories)
            .environment(\.orbisFileActions, store.transfers)
            .environmentObject(store.notifications)
            .environmentObject(store.agentState))
    }

    func body(content: Content) -> some View {
        if presented {
            liveSheet.update { wrapSheet(sheet()) }
        }
        return content.onChange(of: presented, initial: true) { _, open in
            if open {
                let initial = sheet()
                let detents = (initial as? OrbisSheetDetentProviding)?.orbisSheetDetents ?? [.large]
                liveSheet.prepare { wrapSheet(sheet()) }
                let binding = $presented
                let dismissed = onDismiss
                overlay.showSheet(owner: owner, detents: detents,
                                  content: { AnyView(OrbisLiveSheetContent(source: liveSheet)) },
                                  onDismiss: { binding.wrappedValue = false; dismissed?() })
            } else { releasePresentation() }
        }.onDisappear { releasePresentation() }
    }

    private func releasePresentation() {
        if retireIndependently { overlay.retireSheet(owner: owner) }
        else { overlay.dismissSheet(owner: owner) }
    }
}

extension View {
    /// App-owned sheets backed by native `UISheetPresentationController` with Orbis material,
    /// recessed grab handle, and per-sheet `OrbisOverlay` support for nested sheets and dialogs.
    func orbisBottomSheet<Sheet: View>(isPresented: Binding<Bool>, onDismiss: (() -> Void)? = nil, retireIndependently: Bool = false, @ViewBuilder content: @escaping () -> Sheet) -> some View {
        modifier(OrbisBottomSheetPresenter(presented: isPresented, onDismiss: onDismiss, retireIndependently: retireIndependently, sheet: content))
    }
}

private struct OrbisSheetContent: View {
    let content: () -> AnyView
    var body: some View { content() }
}

private struct OrbisSheetThemedContainer<Content: View>: View {
    @ObservedObject private var display = OrbisDisplaySettings.shared
    let content: Content

    private var preferredScheme: ColorScheme? {
        #if DEBUG
        if ProcessInfo.processInfo.arguments.contains("--preview-dark") { return .dark }
        #endif
        switch display.colorMode {
        case "light": return .light
        case "dark": return .dark
        default: return nil
        }
    }

    var body: some View {
        content
            .modifier(OrbisDisplayPreferences())
            .preferredColorScheme(preferredScheme)
    }
}

private struct OrbisSheetRootView: View {
    @Environment(\.colorScheme) private var scheme
    @Environment(\.orbisAppearance) private var visualStyle
    @Environment(\.orbisColorMode) private var colorMode
    @ObservedObject var overlay: OrbisOverlay
    let content: () -> AnyView
    let dismiss: () -> Void
    let retire: () -> Void
    let onDetentsChanged: ([OrbisSheetDetent]) -> Void
    let onStyleChanged: (UIColor, UIUserInterfaceStyle) -> Void
    let onDialogStateChanged: (Bool) -> Void

    private var interfaceStyle: UIUserInterfaceStyle {
        #if DEBUG
        if ProcessInfo.processInfo.arguments.contains("--preview-dark") { return .dark }
        #endif
        return colorMode == "light" ? .light : colorMode == "dark" ? .dark : .unspecified
    }

    var body: some View {
        let palette = OrbisPalette(scheme)
        VStack(spacing: 0) {
            Capsule().fill(.clear).frame(width: 36, height: 6)
                .neuSurface(inset: true, radius: 3, intensity: 0.4, concentric: false)
                .frame(maxWidth: .infinity).frame(height: 24)
                .padding(.top, 4)
                .accessibilityHidden(true)
            OrbisSheetContent(content: content)
                .environment(\.orbisSurface, OrbisSurfaceContext(layer: 1, depth: 1, innerRadius: 16))
                .environment(\.orbisDismiss, dismiss)
                .environment(\.orbisRetire, retire)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        }
        .frame(maxWidth: 720)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .foregroundStyle(palette.text)
        .background(palette.base.ignoresSafeArea())
        .orbisOverlayHost(overlay)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("orbis-bottom-sheet")
        .onPreferenceChange(OrbisSheetDetentsKey.self) { requested in
            let next = Array(Set(requested.isEmpty ? [.large] : requested)).sorted()
            onDetentsChanged(next)
        }
        .onAppear {
            onStyleChanged(UIColor(palette.base), interfaceStyle)
            onDialogStateChanged(overlay.dialog != nil)
        }
        .onChange(of: scheme) { _, next in
            onStyleChanged(UIColor(OrbisPalette(next).base), interfaceStyle)
        }
        .onChange(of: visualStyle) { _, _ in
            onStyleChanged(UIColor(OrbisPalette(scheme).base), interfaceStyle)
        }
        .onChange(of: colorMode) { _, _ in
            onStyleChanged(UIColor(OrbisPalette(scheme).base), interfaceStyle)
        }
        .onChange(of: overlay.dialog != nil) { _, active in
            onDialogStateChanged(active)
        }
    }
}

@MainActor
private final class OrbisSheetViewController: UIViewController, UISheetPresentationControllerDelegate {
    var ownerID: UUID
    let sheetOverlay = OrbisOverlay()
    var onDismissedBySystem: ((UUID) -> Void)?
    var onRequestDismiss: ((UUID) -> Void)?
    var onRequestRetire: ((UUID) -> Void)?
    var didNotifyDismissal = false

    private var currentDetents: [OrbisSheetDetent]
    private var userInteractedWithDetent = false
    private var hasAppeared = false
    private let reduceMotion: Bool
    private var hostingController: UIHostingController<AnyView>?
    private var pendingContent: (() -> AnyView)?

    init(request: OrbisOverlay.SheetRequest, reduceMotion: Bool) {
        self.ownerID = request.id
        self.currentDetents = request.initialDetents.isEmpty ? [.large] : Array(Set(request.initialDetents)).sorted()
        self.reduceMotion = reduceMotion
        self.pendingContent = request.content
        super.init(nibName: nil, bundle: nil)
        modalPresentationStyle = .pageSheet
        definesPresentationContext = true
        overrideUserInterfaceStyle = Self.resolvedInterfaceStyle(colorMode: OrbisDisplaySettings.shared.colorMode)
        if let sheet = sheetPresentationController {
            sheet.delegate = self
            applySheetConfiguration(to: sheet, detents: currentDetents, animated: false)
        }
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = UIColor(OrbisPalette(currentColorScheme()).base)
        if let content = pendingContent {
            pendingContent = nil
            installHosting(content: content)
        }
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        hasAppeared = true
    }

    override func viewDidDisappear(_ animated: Bool) {
        super.viewDidDisappear(animated)
        if (isBeingDismissed || (presentingViewController == nil && view.window == nil)), !didNotifyDismissal {
            hasAppeared = false
            didNotifyDismissal = true
            onDismissedBySystem?(ownerID)
        }
    }

    override func accessibilityPerformEscape() -> Bool {
        onRequestDismiss?(ownerID)
        return true
    }

    func replace(with request: OrbisOverlay.SheetRequest) {
        ownerID = request.id
        didNotifyDismissal = false
        userInteractedWithDetent = false
        sheetOverlay.dismissMenu()
        sheetOverlay.dismissDialog()
        if let nested = sheetOverlay.sheets.first {
            sheetOverlay.dismissSheet(owner: nested.id)
        }
        if presentedViewController != nil {
            dismiss(animated: false)
        }
        let nextDetents = request.initialDetents.isEmpty ? [.large] : Array(Set(request.initialDetents)).sorted()
        updateDetents(nextDetents, animated: !reduceMotion && hasAppeared)
        if isViewLoaded {
            installHosting(content: request.content)
        } else {
            pendingContent = request.content
        }
    }

    func updateDetents(_ detents: [OrbisSheetDetent], animated: Bool) {
        let normalized = detents.isEmpty ? [OrbisSheetDetent.large] : Array(Set(detents)).sorted()
        guard normalized != currentDetents else { return }
        currentDetents = normalized
        if let sheet = sheetPresentationController {
            applySheetConfiguration(to: sheet, detents: normalized, animated: animated && hasAppeared)
        }
    }

    func sheetPresentationControllerDidChangeSelectedDetentIdentifier(_ sheetPresentationController: UISheetPresentationController) {
        userInteractedWithDetent = true
    }

    func presentationControllerDidDismiss(_ presentationController: UIPresentationController) {
        guard !didNotifyDismissal else { return }
        didNotifyDismissal = true
        onDismissedBySystem?(ownerID)
    }

    private func installHosting(content: @escaping () -> AnyView) {
        if let existing = hostingController {
            existing.willMove(toParent: nil)
            existing.view.removeFromSuperview()
            existing.removeFromParent()
            hostingController = nil
        }
        let root = OrbisSheetThemedContainer(content: OrbisSheetRootView(
            overlay: sheetOverlay,
            content: content,
            dismiss: { [weak self] in
                guard let self else { return }
                self.onRequestDismiss?(self.ownerID)
            },
            retire: { [weak self] in
                guard let self else { return }
                self.onRequestRetire?(self.ownerID)
            },
            onDetentsChanged: { [weak self] detents in
                self?.updateDetents(detents, animated: !(self?.reduceMotion ?? false))
            },
            onStyleChanged: { [weak self] background, style in
                guard let self else { return }
                self.view.backgroundColor = background
                if self.overrideUserInterfaceStyle != style {
                    self.overrideUserInterfaceStyle = style
                }
            },
            onDialogStateChanged: { [weak self] active in
                self?.isModalInPresentation = active
            }
        ))
        let hosting = UIHostingController(rootView: AnyView(root))
        hosting.view.backgroundColor = .clear
        addChild(hosting)
        hosting.view.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(hosting.view)
        NSLayoutConstraint.activate([
            hosting.view.topAnchor.constraint(equalTo: view.topAnchor),
            hosting.view.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            hosting.view.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            hosting.view.bottomAnchor.constraint(equalTo: view.bottomAnchor)
        ])
        hosting.didMove(toParent: self)
        hostingController = hosting
    }

    private func applySheetConfiguration(to sheet: UISheetPresentationController,
                                         detents: [OrbisSheetDetent],
                                         animated: Bool) {
        let normalized = detents.isEmpty ? [OrbisSheetDetent.large] : Array(Set(detents)).sorted()
        let uiDetents: [UISheetPresentationController.Detent] = normalized.map {
            $0 == .medium ? .medium() : .large()
        }
        let preferred: UISheetPresentationController.Detent.Identifier =
            normalized.first == .medium ? .medium : .large
        let currentFits = sheet.selectedDetentIdentifier.map { id in
            normalized.contains(id == .medium ? .medium : .large)
        } ?? false

        let apply = {
            sheet.detents = uiDetents
            if !self.userInteractedWithDetent || !currentFits {
                sheet.selectedDetentIdentifier = preferred
            }
            sheet.prefersGrabberVisible = false
            sheet.preferredCornerRadius = OrbisRadius.sheet
            sheet.prefersScrollingExpandsWhenScrolledToEdge = true
            sheet.largestUndimmedDetentIdentifier = nil
        }
        if animated {
            sheet.animateChanges(apply)
        } else {
            apply()
        }
    }

    private func currentColorScheme() -> ColorScheme {
        #if DEBUG
        if ProcessInfo.processInfo.arguments.contains("--preview-dark") { return .dark }
        #endif
        switch OrbisDisplaySettings.shared.colorMode {
        case "dark": return .dark
        case "light": return .light
        default: return traitCollection.userInterfaceStyle == .dark ? .dark : .light
        }
    }

    private static func resolvedInterfaceStyle(colorMode: String) -> UIUserInterfaceStyle {
        #if DEBUG
        if ProcessInfo.processInfo.arguments.contains("--preview-dark") { return .dark }
        #endif
        switch colorMode {
        case "light": return .light
        case "dark": return .dark
        default: return .unspecified
        }
    }
}

private struct OrbisNativeSheetBridge: UIViewRepresentable {
    let overlay: OrbisOverlay
    let sheetIDs: [UUID]
    let reduceMotion: Bool

    func makeCoordinator() -> Coordinator { Coordinator() }
    func makeUIView(context: Context) -> Probe {
        let probe = Probe()
        probe.coordinator = context.coordinator
        context.coordinator.probe = probe
        return probe
    }
    func updateUIView(_ view: Probe, context: Context) {
        context.coordinator.overlay = overlay
        context.coordinator.reduceMotion = reduceMotion
        context.coordinator.scheduleReconcile()
    }
    static func dismantleUIView(_ view: Probe, coordinator: Coordinator) {
        coordinator.teardown()
    }

    final class Probe: UIView {
        weak var coordinator: Coordinator?
        init() {
            super.init(frame: .zero)
            isUserInteractionEnabled = false
            isAccessibilityElement = false
            backgroundColor = .clear
        }
        required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
        override func didMoveToWindow() {
            super.didMoveToWindow()
            if window != nil { coordinator?.scheduleReconcile() }
        }
        var nearestViewController: UIViewController? {
            var responder: UIResponder? = self
            while let next = responder?.next {
                if var vc = next as? UIViewController {
                    while let parent = vc.parent, parent is OrbisSheetViewController {
                        vc = parent
                    }
                    return vc
                }
                responder = next
            }
            return nil
        }
    }

    @MainActor final class Coordinator {
        weak var probe: Probe?
        weak var overlay: OrbisOverlay?
        var reduceMotion = false
        private var displayed: [OrbisSheetViewController] = []
        private var transitionInFlight = false
        private var scheduled = false

        func scheduleReconcile() {
            guard !scheduled else { return }
            scheduled = true
            DispatchQueue.main.async { [weak self] in
                guard let self else { return }
                self.scheduled = false
                self.reconcile()
            }
        }

        func teardown() {
            for vc in displayed { vc.didNotifyDismissal = true }
            if let first = displayed.first, let presenter = first.presentingViewController, presenter.presentedViewController === first {
                presenter.dismiss(animated: false)
            }
            displayed.removeAll()
            overlay = nil
        }

        private func waitForTransition(_ coordinator: UIViewControllerTransitionCoordinator?) -> Bool {
            guard let coordinator else { return false }
            let attached = coordinator.animate(alongsideTransition: nil) { [weak self] _ in
                DispatchQueue.main.async {
                    guard let self else { return }
                    self.transitionInFlight = false
                    self.reconcile()
                }
            }
            if attached {
                transitionInFlight = true
                return true
            }
            return false
        }

        func reconcile() {
            guard !transitionInFlight else { return }
            guard let overlay, let hostVC = probe?.nearestViewController, hostVC.view.window != nil else { return }
            let desired = overlay.sheets

            displayed.removeAll { $0.presentingViewController == nil && !$0.isBeingPresented }

            var prefix = 0
            while prefix < displayed.count && prefix < desired.count && displayed[prefix].ownerID == desired[prefix].id {
                prefix += 1
            }

            if prefix == displayed.count - 1 && desired.count == displayed.count && displayed[prefix].presentedViewController == nil {
                displayed[prefix].replace(with: desired[prefix])
                return
            }

            if prefix < displayed.count {
                let victim = displayed[prefix]
                let animated = !reduceMotion && desired.count <= prefix
                guard let presenter = victim.presentingViewController, presenter.presentedViewController === victim else {
                    displayed.removeSubrange(prefix...)
                    reconcile()
                    return
                }
                if waitForTransition(presenter.transitionCoordinator) { return }
                for vc in displayed[prefix...] { vc.didNotifyDismissal = true }
                displayed.removeSubrange(prefix...)
                transitionInFlight = true
                presenter.dismiss(animated: animated) { [weak self] in
                    DispatchQueue.main.async {
                        guard let self else { return }
                        self.transitionInFlight = false
                        self.reconcile()
                    }
                }
                return
            }

            if prefix < desired.count {
                let presenter: UIViewController = displayed.last ?? hostVC
                if waitForTransition(presenter.transitionCoordinator) { return }
                if presenter.presentedViewController != nil {
                    _ = waitForTransition(presenter.presentedViewController?.transitionCoordinator)
                    return
                }
                let request = desired[prefix]
                let vc = makeSheetController(for: request)
                displayed.append(vc)
                transitionInFlight = true
                presenter.present(vc, animated: !reduceMotion) { [weak self] in
                    DispatchQueue.main.async {
                        guard let self else { return }
                        self.transitionInFlight = false
                        self.reconcile()
                    }
                }
            }
        }

        private func makeSheetController(for request: OrbisOverlay.SheetRequest) -> OrbisSheetViewController {
            let vc = OrbisSheetViewController(request: request, reduceMotion: reduceMotion)
            vc.onDismissedBySystem = { [weak self, weak overlay] ownerID in
                guard let self, let overlay else { return }
                self.displayed.removeAll { $0.ownerID == ownerID }
                overlay.dismissSheet(owner: ownerID)
            }
            vc.onRequestDismiss = { [weak overlay] ownerID in
                overlay?.dismissSheet(owner: ownerID)
            }
            vc.onRequestRetire = { [weak overlay] ownerID in
                overlay?.retireSheet(owner: ownerID)
            }
            return vc
        }
    }
}

// MARK: - Menus and dialogs

/// One entry of an `OrbisMenuButton`. Items are built when the menu opens.
struct OrbisMenuItem: Identifiable {
    let id = UUID()
    let title: String
    var symbol: String? = nil
    var agentKind: String? = nil
    var checked = false
    var destructive = false
    var disabled = false
    var isDivider = false
    var children: [OrbisMenuItem] = []
    var keepsOpen = false
    var identifier: String? = nil
    var action: () -> Void = {}

    static var divider: OrbisMenuItem { OrbisMenuItem(title: "", isDivider: true) }
}

struct OrbisDialogAction: Identifiable {
    enum Role { case normal, destructive, cancel }
    let id = UUID()
    let title: String
    var role: Role = .normal
    var action: () -> Void = {}
}

/// Menus and dialogs are drawn by `OrbisOverlayLayer` above every page and the
/// drawer (Android `NeumorphMenu` / `NeumorphDialog`), instead of system popovers,
/// action sheets and alerts that ignore the shared material.
@MainActor
final class OrbisOverlay: ObservableObject {
    struct MenuRequest: Identifiable {
        let id = UUID()
        var anchor: CGRect
        var items: [OrbisMenuItem]
        var horizontal = false
        var preferAbove = false
        var owner: String? = nil
    }
    struct DialogRequest: Identifiable {
        let id = UUID()
        let title: String
        let message: String?
        let actions: [OrbisDialogAction]
    }
    struct SheetRequest: Identifiable {
        let id: UUID
        let initialDetents: [OrbisSheetDetent]
        let content: () -> AnyView
        let onDismiss: () -> Void
    }
    @Published private(set) var sheets: [SheetRequest] = []
    func showSheet(owner: UUID, detents: [OrbisSheetDetent] = [.large],
                   content: @escaping () -> AnyView, onDismiss: @escaping () -> Void) {
        guard !sheets.contains(where: { $0.id == owner }) else { return }
        menu = nil
        sheets.append(SheetRequest(id: owner, initialDetents: detents, content: content, onDismiss: onDismiss))
    }
    func dismissSheet(owner: UUID) {
        guard let index = sheets.firstIndex(where: { $0.id == owner }) else { return }
        let removed = Array(sheets[index...]); sheets.removeSubrange(index...)
        removed.reversed().forEach { $0.onDismiss() }
    }
    func retireSheet(owner: UUID) {
        guard let index = sheets.firstIndex(where: { $0.id == owner }) else { return }
        let removed = sheets.remove(at: index)
        removed.onDismiss()
    }
    @Published private(set) var menu: MenuRequest?
    @Published private(set) var dialog: DialogRequest?
    var isPresenting: Bool { menu != nil || dialog != nil || !sheets.isEmpty }

    /// `anchor` is in global coordinates.
    func showMenu(_ items: [OrbisMenuItem], from anchor: CGRect, horizontal: Bool = false, preferAbove: Bool = false, owner: String? = nil) {
        guard dialog == nil, items.contains(where: { !$0.isDivider }) else { return }
        menu = MenuRequest(anchor: anchor, items: items, horizontal: horizontal, preferAbove: preferAbove, owner: owner)
    }
    func showDialog(_ title: String, message: String? = nil, actions: [OrbisDialogAction]) {
        menu = nil
        dialog = DialogRequest(title: title, message: message, actions: actions.isEmpty ? [OrbisDialogAction(title: L10n.tr("知道了"), role: .cancel)] : actions)
    }
    func dismissMenu() { menu = nil }
    func dismissMenu(owner: String) { if menu?.owner == owner { menu = nil } }
    func moveMenu(owner: String, to frame: CGRect) {
        guard menu?.owner == owner, menu?.anchor != frame else { return }
        menu?.anchor = frame
    }
    func dismissDialog() { dialog = nil }

    fileprivate func select(_ item: OrbisMenuItem) {
        if !item.keepsOpen { menu = nil }
        item.action()
    }
    fileprivate func perform(_ action: OrbisDialogAction) {
        dialog = nil
        action.action()
    }
    /// Outside tap / escape: the same as choosing the cancel action, if there is one.
    fileprivate func cancelDialog() {
        guard let current = dialog else { return }
        dialog = nil
        current.actions.first { $0.role == .cancel }?.action()
    }
}

extension View {
    /// Root of the menu / dialog layer. Apply once, outside the drawer, so menus open above it.
    func orbisOverlayHost(_ overlay: OrbisOverlay) -> some View {
        ZStack {
            self.accessibilityHidden(overlay.isPresenting)
            OrbisOverlayLayer(overlay: overlay)
        }.environmentObject(overlay)
    }
}

/// Keeps a view's latest global frame without causing re-renders; menus read it when they open.
final class OrbisAnchor {
    var frame: CGRect = .zero
}

/// Independent hosted roots cannot share SwiftUI's global coordinate space. Register a
/// real UIView with the cell's layout channel and observe touches in that same window.
struct OrbisNativeWindowGeometryReader: UIViewRepresentable {
    let geometry: ChatNativeCellGeometry
    var semanticID: String? = nil
    let onFrame: (UUID, CGRect?) -> Void
    var onTouch: ((CGPoint) -> Void)? = nil
    var onUpdate: ((UUID) -> Void)? = nil
    var onRemove: ((UUID) -> Void)? = nil

    func makeCoordinator() -> Coordinator { Coordinator() }
    func makeUIView(context: Context) -> Probe { Probe() }
    func updateUIView(_ view: Probe, context: Context) {
        context.coordinator.bind(view, geometry: geometry, semanticID: semanticID, onFrame: onFrame,
                                 onTouch: onTouch, onUpdate: onUpdate, onRemove: onRemove)
    }
    static func dismantleUIView(_ view: Probe, coordinator: Coordinator) {
        coordinator.detach()
        view.detach()
    }

    @MainActor final class Coordinator {
        private let id = UUID()
        private weak var geometry: ChatNativeCellGeometry?
        private var semanticID: String?
        private var version = UUID()
        private var onRemove: ((UUID) -> Void)?

        func bind(_ view: Probe, geometry: ChatNativeCellGeometry, semanticID: String? = nil,
                  onFrame: @escaping (UUID, CGRect?) -> Void,
                  onTouch: ((CGPoint) -> Void)?, onUpdate: ((UUID) -> Void)?, onRemove: ((UUID) -> Void)?) {
            if let previous = self.geometry {
                if previous !== geometry { detach() }
                else if self.semanticID != semanticID {
                    // The view can keep the same rectangle while acquiring a new
                    // row/page owner. Re-register once to replay that actual frame.
                    version = UUID()
                    previous.unregister(id: id)
                }
            }
            self.geometry = geometry
            self.semanticID = semanticID
            self.onRemove = onRemove
            let version = UUID(); self.version = version
            view.geometry = geometry; view.onTouch = onTouch
            onUpdate?(id)
            geometry.register(id: id, view: view) { [weak self] frame in
                guard let self, self.version == version else { return }
                onFrame(self.id, frame)
            }
        }
        func detach() {
            version = UUID()
            geometry?.unregister(id: id); geometry = nil
            semanticID = nil
            let remove = onRemove; onRemove = nil
            remove?(id)
        }
    }

    final class Probe: UIView {
        weak var geometry: ChatNativeCellGeometry?
        var onTouch: ((CGPoint) -> Void)? { didSet { updateTouchObservation() } }
        private weak var observer: TouchObserver?
        init() {
            super.init(frame: .zero)
            isUserInteractionEnabled = false; isAccessibilityElement = false
            backgroundColor = .clear
        }
        required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
        override func layoutSubviews() { super.layoutSubviews(); geometry?.refresh() }
        override func didMoveToWindow() {
            super.didMoveToWindow()
            geometry?.refresh()
            updateTouchObservation()
        }
        private func updateTouchObservation() {
            if onTouch != nil, let window {
                if observer?.view === window { return }
                detach()
                observer = TouchObserver.attach(self, to: window)
            } else { detach() }
        }
        func detach() {
            observer?.remove(self)
            observer = nil
        }
    }
    private final class TouchObserver: UIGestureRecognizer {
        // One passive recognizer per window; recycling a cell only changes weak
        // registrations. Pure geometry probes need no touch registration at all.
        private static let observers = NSMapTable<UIWindow, TouchObserver>(keyOptions: .weakMemory, valueOptions: .weakMemory)
        private let probes = NSHashTable<Probe>.weakObjects()
        static func attach(_ probe: Probe, to window: UIWindow) -> TouchObserver {
            let observer: TouchObserver
            if let existing = observers.object(forKey: window) { observer = existing }
            else {
                observer = TouchObserver()
                observers.setObject(observer, forKey: window)
                window.addGestureRecognizer(observer)
            }
            observer.probes.add(probe)
            return observer
        }
        func remove(_ probe: Probe) {
            probes.remove(probe)
            if probes.allObjects.isEmpty {
                if let window = view as? UIWindow { Self.observers.removeObject(forKey: window) }
                view?.removeGestureRecognizer(self)
            }
        }
        init() {
            super.init(target: nil, action: nil)
            cancelsTouchesInView = false; delaysTouchesBegan = false; delaysTouchesEnded = false
        }
        override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent) {
            if let touch = touches.first, let window = view as? UIWindow {
                let point = touch.location(in: window)
                for probe in probes.allObjects where probe.window === window && !probe.isHidden &&
                    probe.bounds.contains(touch.location(in: probe)) {
                    probe.onTouch?(point)
                }
            }
            state = .failed
        }
        override func canPrevent(_ preventedGestureRecognizer: UIGestureRecognizer) -> Bool { false }
        override func canBePrevented(by preventingGestureRecognizer: UIGestureRecognizer) -> Bool { false }
    }
}

private struct OrbisAnchorReporter: ViewModifier {
    @Environment(\.chatNativeCellGeometry) private var nativeGeometry
    @Environment(\.downloadFlight) private var downloadFlight
    let anchor: OrbisAnchor
    var onChange: ((CGRect?) -> Void)?
    func body(content: Content) -> some View {
        if let nativeGeometry {
            content.background(OrbisNativeWindowGeometryReader(geometry: nativeGeometry, onFrame: { _, frame in report(frame) },
                onTouch: downloadFlight.map { flight in { flight.lastTap = $0 } }))
        } else {
            content.onGeometryChange(for: CGRect.self) { $0.frame(in: .global) } action: { report($0) }
        }
    }
    private func report(_ frame: CGRect?) {
        anchor.frame = frame ?? .zero
        onChange?(frame)
    }
}

extension View {
    /// SwiftUI rows report their global frame without a background view (PERF-10).
    /// Independently hosted native cells use an explicit window-coordinate reader.
    func orbisAnchor(_ anchor: OrbisAnchor, onChange: ((CGRect?) -> Void)? = nil) -> some View {
        modifier(OrbisAnchorReporter(anchor: anchor, onChange: onChange))
    }
}

/// A button that opens a neumorphic menu anchored to itself.
struct OrbisMenuButton<Label: View>: View {
    @EnvironmentObject private var overlay: OrbisOverlay
    @State private var anchor = OrbisAnchor()
    let accessibilityLabel: String
    var selected = false
    var padding: CGFloat = 0
    let items: () -> [OrbisMenuItem]
    @ViewBuilder let label: Label
    var body: some View {
        OrbisMotionButton { overlay.showMenu(items(), from: anchor.frame) } label: { label }
            .buttonStyle(NeuButtonStyle(selected: selected, padding: padding))
            .orbisAnchor(anchor)
            .accessibilityLabel(accessibilityLabel)
    }
}

/// Icon disc that opens a menu; looks and sizes exactly like `OrbisIconButton`.
struct OrbisMenuIconButton: View {
    @Environment(\.isEnabled) private var enabled
    @EnvironmentObject private var overlay: OrbisOverlay
    @Environment(\.colorScheme) private var scheme
    @Environment(\.orbisAppearance) private var visualStyle
    @State private var anchor = OrbisAnchor()
    let symbol: String
    let label: String
    var tint: Color? = nil
    var selected = false
    var size: CGFloat = 40
    var compact = false
    @State private var activation = 0
    let items: () -> [OrbisMenuItem]
    var body: some View {
        let diameter: CGFloat = compact ? 36 : size
        Button { activation += 1; overlay.showMenu(items(), from: anchor.frame) } label: {
            OrbisMotionGlyph(symbol: symbol, size: compact ? 18 : size * 0.55, activation: activation)
                .foregroundStyle(enabled ? (tint ?? OrbisPalette(scheme).secondary) : OrbisPalette(scheme).faint)
                .frame(width: diameter, height: diameter)
        }
        .buttonStyle(NeuIconButtonStyle(selected: selected, size: diameter, compact: compact))
        .orbisAnchor(anchor)
        .accessibilityLabel(label)
    }
}

/// A hand-drawn raised panel (menus, dialogs). Its content counts as nested inside one frame.
private struct OrbisPanel: ViewModifier {
    @Environment(\.colorScheme) private var scheme
    @Environment(\.orbisAppearance) private var visualStyle
    let radius: CGFloat
    let padding: CGFloat
    func body(content: Content) -> some View {
        content.neuSurface(radius: radius, intensity: 1, padding: padding, concentric: false)

    }
}

private struct OrbisOverlayLayer: View {
    @Environment(\.colorScheme) private var scheme
    @Environment(\.orbisAppearance) private var visualStyle
    @ObservedObject var overlay: OrbisOverlay
    @Environment(\.orbisReduceMotion) private var reduceMotion

    var body: some View {
        ZStack {
            GeometryReader { proxy in
                let origin = proxy.frame(in: .global).origin
                let insets = proxy.safeAreaInsets
                // 菜单只摆在安全区内，不压到状态栏、灵动岛或主屏指示条下面。
                let bounds = CGRect(x: insets.leading, y: insets.top,
                                    width: max(0, proxy.size.width - insets.leading - insets.trailing),
                                    height: max(0, proxy.size.height - insets.top - insets.bottom))
                ZStack(alignment: .topLeading) {
                    if let menu = overlay.menu {
                        Color.clear.contentShape(Rectangle())
                            .onTapGesture { overlay.dismissMenu() }
                            .gesture(DragGesture(minimumDistance: 10).onChanged { _ in overlay.dismissMenu() })
                            .accessibilityHidden(true)
                        let anchor = menu.anchor.offsetBy(dx: -origin.x, dy: -origin.y)
                        OrbisMenuPanel(request: menu, anchor: anchor, bounds: bounds,
                                       onSelect: overlay.select, onDismiss: overlay.dismissMenu)
                            .accessibilityIdentifier("orbis-menu-panel")
                            .id(menu.id)
                            .transition(reduceMotion ? .identity : .asymmetric(
                                insertion: .modifier(active: OrbisPanelEntrance(progress: 0, anchor: menuTransitionAnchor(anchor, in: bounds)),
                                                     identity: OrbisPanelEntrance(progress: 1, anchor: menuTransitionAnchor(anchor, in: bounds))).combined(with: .opacity).animation(InteractionMotion.panel),
                                removal: .modifier(active: OrbisPanelEntrance(progress: 0, anchor: menuTransitionAnchor(anchor, in: bounds)),
                                                   identity: OrbisPanelEntrance(progress: 1, anchor: menuTransitionAnchor(anchor, in: bounds))).combined(with: .opacity).animation(InteractionMotion.exit)))
                    }
                    if let dialog = overlay.dialog {
                        OrbisPalette(scheme).scrim.opacity(0.34).ignoresSafeArea()
                            .onTapGesture { overlay.cancelDialog() }.transition(.opacity)
                        OrbisDialogPanel(request: dialog, onAction: overlay.perform, onCancel: overlay.cancelDialog)
                            .id(dialog.id)
                            .frame(width: proxy.size.width, height: proxy.size.height)
                            .transition(reduceMotion ? .identity : .asymmetric(
                                insertion: .opacity.combined(with: .scale(scale: 0.96)).animation(InteractionMotion.panel),
                                removal: .opacity.combined(with: .scale(scale: 0.96)).animation(InteractionMotion.exit)))
                    }
                }
                .frame(width: proxy.size.width, height: proxy.size.height, alignment: .topLeading)
            }
        }
        .background(OrbisNativeSheetBridge(overlay: overlay, sheetIDs: overlay.sheets.map(\.id), reduceMotion: reduceMotion))
        .animation(reduceMotion ? nil : InteractionMotion.panel, value: overlay.menu?.id)
        .animation(reduceMotion ? nil : InteractionMotion.panel, value: overlay.dialog?.id)
        .allowsHitTesting(overlay.menu != nil || overlay.dialog != nil)
    }

    private func menuTransitionAnchor(_ anchor: CGRect, in bounds: CGRect) -> UnitPoint {
        let trailing = anchor.midX > bounds.midX
        let above = anchor.midY > bounds.minY + bounds.height * 0.6
        switch (above, trailing) {
        case (false, false): return .topLeading
        case (false, true): return .topTrailing
        case (true, false): return .bottomLeading
        case (true, true): return .bottomTrailing
        }
    }
}

private struct OrbisPanelEntrance: AnimatableModifier {
    var progress: CGFloat
    let anchor: UnitPoint
    var animatableData: CGFloat { get { progress } set { progress = newValue } }
    func body(content: Content) -> some View {
        content.scaleEffect(0.96 + 0.04 * progress, anchor: anchor)
    }
}

private struct OrbisMenuPanel: View {
    @Environment(\.colorScheme) private var scheme
    @Environment(\.orbisAppearance) private var visualStyle
    @Environment(\.orbisReduceMotion) private var reduceMotion
    let request: OrbisOverlay.MenuRequest
    let anchor: CGRect
    let bounds: CGRect
    let onSelect: (OrbisMenuItem) -> Void
    let onDismiss: () -> Void
    private struct Page: Identifiable {
        let id: UUID
        let title: String?
        let items: [OrbisMenuItem]
    }
    @State private var history: [Page] = []
    @State private var displayed: Page?
    @State private var destination: Page?
    @State private var height: CGFloat?
    @State private var direction: CGFloat = 1
    @State private var generation = UUID()
    @State private var scrollPositions: [UUID: UUID] = [:]
    @State private var focusedItems: [UUID: UUID] = [:]
    @AccessibilityFocusState private var focusedItem: UUID?
    private var root: Page { Page(id: request.id, title: nil, items: request.items) }
    private var current: Page { displayed ?? root }
    private var width: CGFloat { min(280, max(120, bounds.width - 32)) }
    private var maxHeight: CGFloat { max(96, bounds.height - 32) }

    var body: some View {
        ZStack(alignment: .top) {
            ScrollView {
                list(current).fixedSize(horizontal: false, vertical: true).scrollTargetLayout()
            }
            .scrollPosition(id: Binding(get: { scrollPositions[current.id] }, set: { scrollPositions[current.id] = $0 }))
            .defaultScrollAnchor(.top)
            .disabled(destination != nil)
            .id(current.id)
            .transition(reduceMotion ? .identity : .asymmetric(
                insertion: .offset(x: direction * width).combined(with: .opacity),
                removal: .offset(x: -direction * width / 3).combined(with: .opacity)))
        }
        .frame(width: width - OrbisRadius.menuPadding * 2, height: min(maxHeight, height ?? 48), alignment: .top)
        .clipped()
        .overlay(alignment: .top) {
            // Only menu rows are measured offscreen, never message/tool content.
            list(destination ?? current, measuring: true).fixedSize(horizontal: false, vertical: true)
                .background(GeometryReader { proxy in
                    Color.clear.onAppear { settleHeight(proxy.size.height) }
                        .onChange(of: proxy.size.height) { _, measured in settleHeight(measured) }
                })
                .id((destination ?? current).id)
                .hidden().allowsHitTesting(false).accessibilityHidden(true)
        }
        .modifier(OrbisPanel(radius: OrbisRadius.menu, padding: OrbisRadius.menuPadding))
        .alignmentGuide(.leading) { d in -x(for: d.width) }
        .alignmentGuide(.top) { d in -y(for: d.height) }
        .accessibilityElement(children: .contain)
        .accessibilityAddTraits(.isModal)
        .accessibilityAction(.escape, back)
        .onDisappear { generation = UUID() }
    }

    @ViewBuilder private func list(_ page: Page, measuring: Bool = false) -> some View {
        if request.horizontal {
            HStack(spacing: 4) {
                ForEach(page.items) { item in
                    OrbisMenuRow(item: item) { onSelect(item) }
                }
            }
        } else {
            VStack(alignment: .leading, spacing: 4) {
                if let title = page.title {
                    OrbisMenuRow(item: OrbisMenuItem(title: title, symbol: "chevron.left"), action: back)
                }
                ForEach(page.items) { item in
                    if item.isDivider {
                        OrbisPalette(scheme).well.frame(height: 2).clipShape(Capsule())
                            .padding(.horizontal, 14).padding(.vertical, 4).accessibilityHidden(true)
                    } else {
                        let row = OrbisMenuRow(item: item) {
                            if item.children.isEmpty { onSelect(item) }
                            else {
                                focusedItems[current.id] = item.id
                                history.append(current)
                                navigate(Page(id: item.id, title: item.title, items: item.children), forward: true)
                            }
                        }
                        if measuring { row }
                        else { row.id(item.id).accessibilityFocused($focusedItem, equals: item.id) }
                    }
                }
            }
        }
    }
    private func navigate(_ page: Page, forward: Bool) {
        generation = UUID()
        direction = forward ? 1 : -1
        destination = page
        // Equal-height pages still need the second stage; geometry callbacks only fire on size change.
        if reduceMotion { displayed = page; destination = nil }
    }
    private func settleHeight(_ measured: CGFloat) {
        let target = min(maxHeight, measured)
        guard let next = destination else { height = target; return }
        let token = generation
        withAnimation(reduceMotion ? nil : InteractionMotion.state, completionCriteria: .logicallyComplete) {
            height = target
        } completion: {
            guard generation == token else { return }
            withAnimation(reduceMotion ? nil : InteractionMotion.panel) { displayed = next; destination = nil }
            focusedItem = focusedItems[next.id] ?? next.items.first(where: { !$0.isDivider && !$0.disabled })?.id
        }
    }
    private func back() {
        guard let previous = history.popLast() else { onDismiss(); return }
        navigate(previous, forward: false)
    }
    private func x(for width: CGFloat) -> CGFloat {
        let preferred = anchor.midX > bounds.midX ? anchor.maxX - width : anchor.minX
        let low = bounds.minX + 16, high = max(low, bounds.maxX - 16 - width)
        return min(max(low, preferred), high)
    }
    private func y(for height: CGFloat) -> CGFloat {
        let low = bounds.minY + 8, high = max(low, bounds.maxY - 8 - height)
        let above = anchor.minY - 8 - height
        if request.preferAbove && above >= low { return above }
        let below = anchor.maxY + 8
        if below <= high { return below }
        if above >= low { return above }
        return min(max(low, anchor.midY - height / 2), high)
    }
}

private struct OrbisMenuRow: View {
    @Environment(\.colorScheme) private var scheme
    @Environment(\.orbisAppearance) private var visualStyle
    @OrbisVisualActive private var visualActive
    let item: OrbisMenuItem
    let action: () -> Void
    @StateObject private var feedback = OrbisCopyFeedback()
    @State private var activation = 0
    var body: some View {
        let p = OrbisPalette(scheme)
        let copied = feedback.copied
        Button {
            activation += 1
            if item.keepsOpen {
                feedback.perform(action)
            } else { action() }
        } label: {
            HStack(spacing: 12) {
                if let kind = item.agentKind {
                    AgentEmblem(kind: kind, size: 18, recessed: false)
                } else if let symbol = item.symbol {
                    if item.keepsOpen {
                        OrbisCopyGlyph(copied: copied, size: 20, symbol: symbol, activation: activation,
                            normalColor: p.text, successColor: p.text)
                    } else {
                        OrbisMotionGlyph(symbol: symbol, size: 20, activation: activation)
                    }
                }
                Text(copied ? L10n.tr("已复制") : item.title).lineLimit(2)
                    .frame(maxWidth: .infinity, alignment: .leading)
                if item.checked { Image(systemName: "checkmark").fontWeight(.bold) }
                if !item.children.isEmpty { Image(systemName: "chevron.right") }
            }.font(.orbisBody(.medium))
                .foregroundStyle(item.destructive ? p.error : item.checked ? p.accent : p.text)
                .padding(.horizontal, 14).frame(minHeight: 48).contentShape(Rectangle())
        }.buttonStyle(MenuRowStyle(selected: item.checked))
            .disabled(item.disabled)
            .accessibilityLabel(copied ? L10n.tr("已复制") : item.title)
            .accessibilityIdentifier(item.identifier ?? "")
            .onChange(of: item.identifier) { _, _ in feedback.clear() }
            .onChange(of: visualActive) { _, active in if !active { feedback.clear() } }
            .onDisappear { feedback.clear() }
            .accessibilityAddTraits(item.checked ? .isSelected : [])
    }
}

/// Menu rows sit flat on the panel; only the checked or pressed row takes a recessed fill.
private struct MenuRowStyle: ButtonStyle {
    @Environment(\.colorScheme) private var scheme
    @Environment(\.orbisAppearance) private var visualStyle
    @Environment(\.isEnabled) private var enabled
    @Environment(\.orbisSurface) private var parent
    let selected: Bool
    func makeBody(configuration: Configuration) -> some View {
        let p = OrbisPalette(scheme)
        configuration.label
            .environment(\.orbisGlyphPressed, configuration.isPressed && enabled)
            .neuSurface(inset: selected || configuration.isPressed, radius: parent?.innerRadius ?? OrbisRadius.control,
                        intensity: enabled && (selected || configuration.isPressed) ? 0.4 : 0, press: configuration.isPressed)
            .overlay { if !enabled { RoundedRectangle(cornerRadius: 16).strokeBorder(p.outline, lineWidth: 1) } }

    }
}

private struct OrbisDialogPanel: View {
    @Environment(\.colorScheme) private var scheme
    @Environment(\.orbisAppearance) private var visualStyle
    let request: OrbisOverlay.DialogRequest
    let onAction: (OrbisDialogAction) -> Void
    let onCancel: () -> Void

    /// Cancel first, then the confirming actions (Android: dismiss button before confirm).
    private var ordered: [OrbisDialogAction] {
        request.actions.filter { $0.role == .cancel } + request.actions.filter { $0.role != .cancel }
    }

    var body: some View {
        let p = OrbisPalette(scheme)
        VStack(alignment: .leading, spacing: 20) {
            VStack(alignment: .leading, spacing: 12) {
                Text(request.title).font(.orbisTitle())
                    .fixedSize(horizontal: false, vertical: true).accessibilityAddTraits(.isHeader)
                if let message = request.message, !message.isEmpty {
                    ViewThatFits(in: .vertical) {
                        messageText(message)
                        ScrollView { messageText(message) }.frame(maxHeight: 320)
                    }
                }
            }.padding(.horizontal, 8).padding(.top, 8)
            if ordered.count <= 2 {
                HStack(spacing: 12) { ForEach(ordered) { button($0) } }
            } else {
                VStack(spacing: 12) { ForEach(ordered) { button($0) } }
            }
        }
        .foregroundStyle(p.text)
        .frame(maxWidth: 360 - OrbisRadius.dialogPadding * 2, alignment: .leading)
        .modifier(OrbisPanel(radius: OrbisRadius.dialog, padding: OrbisRadius.dialogPadding))
        .padding(.horizontal, 28)
        .accessibilityElement(children: .contain)
        .accessibilityAddTraits(.isModal)
        .accessibilityIdentifier("orbis-dialog")
        .accessibilityAction(.escape, onCancel)
    }

    private func messageText(_ message: String) -> some View {
        Text(message).font(.orbisLabel()).foregroundStyle(OrbisPalette(scheme).secondary)
            .fixedSize(horizontal: false, vertical: true).frame(maxWidth: .infinity, alignment: .leading)
    }

    private func button(_ action: OrbisDialogAction) -> some View {
        let p = OrbisPalette(scheme)
        let tint = action.role == .destructive ? p.error : action.role == .cancel ? p.secondary : p.accent
        return Button { onAction(action) } label: {
            Text(action.title).font(.orbisBody(.semibold)).lineLimit(2).multilineTextAlignment(.center)
                .foregroundStyle(tint).padding(.horizontal, 12).frame(maxWidth: .infinity, minHeight: 48)
        }.buttonStyle(NeuButtonStyle())
    }
}

struct OrbisActionButton: View {
    @Environment(\.isEnabled) private var enabled
    @Environment(\.colorScheme) private var scheme
    @Environment(\.orbisAppearance) private var visualStyle
    @Environment(\.orbisAccent) private var pageAccent
    let title: String
    var symbol: String? = nil
    var tint: Color? = nil
    @State private var activation = 0
    let action: () -> Void
    var body: some View {
        Button { activation += 1; action() } label: {
            HStack(spacing: 8) {
                if let symbol { OrbisMotionGlyph(symbol: symbol, size: 18, activation: activation) }
                OrbisMotionText(title)
            }.font(.orbisBody(.semibold))
                .foregroundStyle(enabled ? (tint ?? pageAccent ?? OrbisPalette(scheme).accent) : OrbisPalette(scheme).faint)
                .frame(maxWidth: .infinity, minHeight: 56).padding(.horizontal, 16)
        }.buttonStyle(NeuButtonStyle())
    }
}

struct OrbisHeader<Leading: View, Title: View, Trailing: View>: View {
    @ViewBuilder var leading: Leading
    @ViewBuilder var title: Title
    @ViewBuilder var trailing: Trailing
    var body: some View {
        HStack(spacing: 12) {
            leading
            title.frame(maxWidth: .infinity, alignment: .leading)
            trailing
        }.padding(.horizontal, 16).frame(minHeight: 56)
    }
}

struct OrbisPageHeader<Trailing: View>: View {
    let title: String
    /// Sheets close with ×; pushed pages go back with ←.
    var closes = false
    var backLabel: String? = nil
    var titleLineLimit = 1
    let back: () -> Void
    @ViewBuilder var trailing: Trailing
    var body: some View {
        OrbisHeader {
            OrbisIconButton(symbol: closes ? "xmark" : "arrow.left", label: backLabel ?? (closes ? L10n.tr("关闭") : L10n.tr("返回")), morphFrom: "arrow.left", action: back)
        } title: {
            OrbisMotionText(title).font(.orbisTitle()).lineLimit(titleLineLimit).accessibilityAddTraits(.isHeader)
        } trailing: { trailing }
    }
}

/// S02 / S19: a local identity recess, without changing the enclosing material context.
/// Keep it behind the glyph/coin so it never clips a projected edge or intercepts a tap.
struct AgentIconRecess: View {
    @Environment(\.colorScheme) private var scheme
    @Environment(\.orbisAppearance) private var visualStyle
    var radius: CGFloat = 16

    var body: some View {
        let palette = OrbisPalette(scheme)
        RoundedRectangle(cornerRadius: radius, style: .continuous)
            .fill(palette.well
                .shadow(.inner(color: palette.shadow.opacity(palette.shadeOpacity),
                               radius: 2.4, x: 2.4, y: 2.4))
                .shadow(.inner(color: palette.light.opacity(0.7), radius: 2.4, x: -2.4, y: -2.4)))
            .allowsHitTesting(false).accessibilityHidden(true)
    }
}

struct AgentEmblem: View {
    @Environment(\.colorScheme) private var scheme
    @Environment(\.orbisAppearance) private var visualStyle
    let kind: String?
    var size: CGFloat = 44
    var recessed = true
    var body: some View {
        Group {
            if recessed {
                mark.frame(width: size, height: size).background { AgentIconRecess() }
            } else { mark.frame(width: size, height: size) }
        }.accessibilityLabel(agentTitle(kind))
    }
    private var mark: some View {
        Group {
            if kind == "opencode" {
                Image(systemName: "terminal.fill")
                    .font(.system(size: size * (recessed ? 0.42 : 0.7), weight: .medium))
                    .foregroundStyle(OrbisPalette(scheme).agent(kind))
            } else {
                Image(agentAsset(kind)).renderingMode(kind == "pi" || kind == "claude" || kind == nil ? .original : .template)
                    .resizable().scaledToFit().foregroundStyle(OrbisPalette(scheme).agent(kind))
                    .frame(width: size * (recessed ? 0.56 : 0.9), height: size * (recessed ? 0.56 : 0.9))
            }
        }.frame(width: size, height: size).modifier(OrbisActionPulse())
    }
}

func agentTitle(_ kind: String?) -> String {
    switch kind {
    case "codex", "codexDesktop": return "Codex"
    case "dsh", "dshDesktop": return "DeepSeek"
    case "claude": return "Claude Code"
    case kimiCodeKind: return "Kimi Code"
    case "opencode": return "OpenCode"
    default: return "Pi"
    }
}

private func agentAsset(_ kind: String?) -> String {
    switch kind {
    case "codex", "codexDesktop": return "AgentCodex"
    case "dsh", "dshDesktop": return "AgentDeepSeek"
    case "claude": return "AgentClaude"
    case kimiCodeKind: return "AgentKimi"
    default: return "AgentPi"
    }
}

struct RuntimeStatusLabel: View {
    @Environment(\.colorScheme) private var scheme
    @Environment(\.orbisAppearance) private var appearance
    let status: String
    var syncing = false
    var title: String? = nil
    private var working: Bool { syncing || ["running", "compacting", "starting", "background"].contains(status) }
    var body: some View {
        HStack(spacing: 4) {
            OrbisStatusDot(tone: color, working: working, hollow: status == "idle" && !syncing)
            OrbisMotionText(title ?? runtimeStatusTitle(status)).font(.orbisLabel()).lineLimit(1)
        }.foregroundStyle(OrbisPalette(scheme).secondary)
    }
    private var color: Color {
        let p = OrbisPalette(scheme)
        switch status {
        // S60 / SC108: a running command alone is static, so it never reads as Claude working.
        case "running", "compacting", "starting", "background", "background_commands": return p.success
        case "waiting", "waiting_interaction", "waiting_local_interaction", "launch_unconfirmed": return p.warning
        case "error": return p.error
        default: return p.faint
        }
    }
}

struct OrbisEmptyState: View {
    @Environment(\.colorScheme) private var scheme
    @Environment(\.orbisAppearance) private var visualStyle
    let symbol: String
    let title: String
    var body: some View {
        VStack(spacing: 14) {
            Image(systemName: symbol).font(.system(size: 40)).foregroundStyle(OrbisPalette(scheme).secondary)
            Text(title).font(.orbisBody(.semibold))
        }.padding(24).frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

/// S53 / SC77: secondary explanations open above the current page or sheet.
struct OrbisInfoButton: View {
    @EnvironmentObject private var overlay: OrbisOverlay
    let title: String
    let message: String
    var identifier = "inline-info"
    var body: some View {
        OrbisIconButton(symbol: "info.circle", label: L10n.tr("查看{0}说明", title), size: 28) {
            overlay.showDialog(title, message: message, actions: [OrbisDialogAction(title: L10n.tr("知道了"), role: .cancel)])
        }.accessibilityIdentifier(identifier)
    }
}

struct OrbisStatusWithInfo: View {
    @Environment(\.colorScheme) private var scheme
    let title: String
    let message: String
    var error = false
    var body: some View {
        HStack(spacing: 8) {
            Text(title).font(.orbisCaption()).foregroundStyle(error ? OrbisPalette(scheme).error : OrbisPalette(scheme).secondary)
                .frame(maxWidth: .infinity, alignment: .leading)
            OrbisInfoButton(title: title, message: message)
        }
    }
}

struct OrbisNotice: View {
    @Environment(\.colorScheme) private var scheme
    @Environment(\.orbisAppearance) private var visualStyle
    let text: String
    var error = false
    var trailing: AnyView? = nil
    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Image(systemName: error ? "exclamationmark.circle" : "info.circle")
                .foregroundStyle(error ? OrbisPalette(scheme).error : OrbisPalette(scheme).secondary)
                .orbisIconBaseline(OrbisTextSize.body)
            OrbisMotionText(text).foregroundStyle(OrbisPalette(scheme).text).frame(maxWidth: .infinity, alignment: .leading)
            if let trailing { trailing }
        }.font(.orbisBody()).frame(minHeight: 16)
            .neuSurface(radius: OrbisRadius.control, intensity: 1, padding: 16)
    }
}

// MARK: - Download flight (ADR-0051 M16, ADR-0058 M16)

/// Once a download is actually queued, a file icon flies from the tap along an upward arc to the
/// page's download button, which then pops. Flights never take touches, change layout or move the
/// reader, and they end with the page. The animation is not evidence that anything downloaded.
@MainActor
final class DownloadFlight: ObservableObject {
    struct Flight: Identifiable {
        let id = UUID()
        let from: CGPoint
        let to: CGPoint
        let start: Date
    }
    #if DEBUG
    /// UI tests slow the flight to capture its middle frame.
    static let duration: TimeInterval = ProcessInfo.processInfo.arguments.contains("--preview-slow-flight") ? 4.16 : 0.52
    #else
    static let duration: TimeInterval = 0.52
    #endif
    static let fade: TimeInterval = 0.08
    static let maxFlights = 3

    @Published private(set) var flights: [Flight] = []
    @Published var pop: CGFloat = 1
    @Published var highlighted = false
    #if DEBUG
    private(set) var previewLastFlight: Flight?
    private(set) var previewLaunchMode = "none"
    var previewMetrics: String {
        "count=\(flights.count);mode=\(previewLaunchMode);fromX=\(previewLastFlight?.from.x ?? -1);fromY=\(previewLastFlight?.from.y ?? -1);toX=\(previewLastFlight?.to.x ?? -1);toY=\(previewLastFlight?.to.y ?? -1)"
    }
    #endif
    /// Global frames; the latest tap anywhere on the page is the one that started the download.
    var target: CGRect = .zero
    var page: CGRect = .zero
    var lastTap: CGPoint?
    var reduceMotion = false
    private var work = OrbisVisualWorkGate()

    /// Call after a download was queued.
    func launch() {
        guard work.active else { return }
        let generation = work.generation
        // A button's action can run before the page's tap gesture reports where the finger was.
        DispatchQueue.main.async { [weak self] in
            guard let self, self.work.permits(generation) else { return }
            self.fly(generation: generation)
        }
    }

    func setVisualActive(_ active: Bool) {
        work.setActive(active)
        if !active { cancel() }
    }

    func cancel() {
        work.invalidate()
        var transaction = Transaction(animation: nil)
        transaction.disablesAnimations = true
        withTransaction(transaction) {
            if !flights.isEmpty { flights = [] }
            if pop != 1 { pop = 1 }
            if highlighted { highlighted = false }
        }
    }

    private func fly(generation: Int) {
        guard work.permits(generation), target != .zero else { return }
        if reduceMotion {
            #if DEBUG
            previewLaunchMode = "highlight"
            #endif
            withAnimation(.orbisFade) { highlighted = true }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.16) { [weak self] in
                guard let self, self.work.permits(generation) else { return }
                withAnimation(.orbisFade) { self.highlighted = false }
            }
            return
        }
        guard flights.count < Self.maxFlights else { popTarget(generation: generation); return }
        let to = CGPoint(x: target.midX, y: target.midY)
        let flight = Flight(from: lastTap ?? CGPoint(x: page.midX, y: page.midY), to: to, start: Date())
        #if DEBUG
        previewLastFlight = flight
        previewLaunchMode = "flight"
        #endif
        flights.append(flight)
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.duration) { [weak self] in
            guard let self, self.work.permits(generation), self.flights.contains(where: { $0.id == flight.id }) else { return }
            self.flights.removeAll { $0.id == flight.id }
            self.popTarget(generation: generation)
        }
    }

    private func popTarget(generation: Int) {
        guard work.permits(generation) else { return }
        withAnimation(.easeOut(duration: 0.09)) { pop = 1.12 }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.09) { [weak self] in
            guard let self, self.work.permits(generation) else { return }
            withAnimation(.orbisPop) { self.pop = 1 }
        }
    }
}

private struct DownloadFlightKey: EnvironmentKey {
    static let defaultValue: DownloadFlight? = nil
}

extension EnvironmentValues {
    /// The page's download flight; download entries launch it after queueing a task.
    var downloadFlight: DownloadFlight? {
        get { self[DownloadFlightKey.self] }
        set { self[DownloadFlightKey.self] = newValue }
    }
}

private struct DownloadFlightHost: ViewModifier {
    @Environment(\.orbisReduceMotion) private var reduceMotion
    @OrbisVisualActive private var visualActive
    let flight: DownloadFlight
    func body(content: Content) -> some View {
        content.environment(\.downloadFlight, flight)
            // Observe taps without taking them from buttons, links or scrolling.
            .simultaneousGesture(SpatialTapGesture(coordinateSpace: .global).onEnded { flight.lastTap = $0.location })
            .overlay { DownloadFlightLayer(flight: flight) }
            .onGeometryChange(for: CGRect.self) { $0.frame(in: .global) } action: { flight.page = $0 }
            .onChange(of: reduceMotion, initial: true) { _, value in flight.reduceMotion = value }
            .onChange(of: visualActive, initial: true) { _, active in flight.setVisualActive(active) }
            .onDisappear { flight.cancel() }
    }
}

private struct DownloadFlightTarget: ViewModifier {
    @Environment(\.colorScheme) private var scheme
    @Environment(\.orbisAppearance) private var visualStyle
    @Environment(\.orbisAccent) private var pageAccent
    @ObservedObject var flight: DownloadFlight
    func body(content: Content) -> some View {
        content.scaleEffect(flight.pop)
            .background { Circle().fill((pageAccent ?? OrbisPalette(scheme).accent).opacity(flight.highlighted ? 0.22 : 0)) }
            .onGeometryChange(for: CGRect.self) { $0.frame(in: .global) } action: { flight.target = $0 }
            #if DEBUG
            .accessibilityValue(ProcessInfo.processInfo.arguments.contains("--preview-flight-probe") ? flight.previewMetrics : "")
            #endif
    }
}

private struct DownloadFlightLayer: View {
    @Environment(\.colorScheme) private var scheme
    @Environment(\.orbisAppearance) private var visualStyle
    /// Chat pages follow the agent's accent (X02).
    @Environment(\.orbisAccent) private var pageAccent
    @OrbisVisualActive private var visualActive
    @ObservedObject var flight: DownloadFlight
    var body: some View {
        GeometryReader { proxy in
            let origin = proxy.frame(in: .global).origin
            TimelineView(.animation(paused: !visualActive || flight.flights.isEmpty)) { context in
                Canvas { graphics, _ in
                    var icon = graphics.resolve(Image(systemName: "doc.fill"))
                    icon.shading = .color(pageAccent ?? OrbisPalette(scheme).accent)
                    let fadeFrom = 1 - DownloadFlight.fade / DownloadFlight.duration
                    for item in flight.flights {
                        let time = min(max(context.date.timeIntervalSince(item.start) / DownloadFlight.duration, 0), 1)
                        let t = time * time * (3 - 2 * time)
                        let from = CGPoint(x: item.from.x - origin.x, y: item.from.y - origin.y)
                        let to = CGPoint(x: item.to.x - origin.x, y: item.to.y - origin.y)
                        // Quadratic Bézier bending upward between the tap and the button; near the top
                        // edge the bend shrinks so the icon never leaves the screen.
                        let top = min(from.y, to.y)
                        let control = CGPoint(x: (from.x + to.x) / 2, y: top - min(120, top / 2))
                        let u = 1 - t
                        let x = u * u * from.x + 2 * u * t * control.x + t * t * to.x
                        let y = u * u * from.y + 2 * u * t * control.y + t * t * to.y
                        let side = 28 + (16 - 28) * t
                        graphics.opacity = time < fadeFrom ? 1 : max(0, (1 - time) / (1 - fadeFrom))
                        graphics.draw(icon, in: CGRect(x: x - side / 2, y: y - side / 2, width: side, height: side))
                    }
                }
            }
        }
        .allowsHitTesting(false).accessibilityHidden(true)
    }
}

extension View {
    /// Hosts the page's download flights above it (ADR-0058 M16).
    func downloadFlightHost(_ flight: DownloadFlight) -> some View { modifier(DownloadFlightHost(flight: flight)) }
    /// The page's download button: where flights land and what pops when they arrive.
    func downloadFlightTarget(_ flight: DownloadFlight) -> some View { modifier(DownloadFlightTarget(flight: flight)) }
}


/// M28 loading material: the same base as the page, inset depth and one 1100ms
/// highlight. Reduced motion and hidden root pages keep a static placeholder.
struct OrbisSkeleton: View {
    @Environment(\.colorScheme) private var scheme
    @Environment(\.orbisReduceMotion) private var reduced
    @OrbisVisualActive private var visualActive
    var width: CGFloat? = nil
    let height: CGFloat
    var radius: CGFloat = 8
    var body: some View {
        TimelineView(.animation(minimumInterval: 1 / 30, paused: reduced || !visualActive)) { context in
            Color.clear.neuSurface(inset: true, radius: radius, intensity: 0.4, concentric: false)
                .overlay {
                    if !reduced && visualActive {
                        GeometryReader { bounds in
                            LinearGradient(colors: [.clear, OrbisPalette(scheme).light.opacity(0.32), .clear], startPoint: .leading, endPoint: .trailing)
                                .frame(width: bounds.size.width * 0.5)
                                .offset(x: bounds.size.width * (CGFloat(context.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: 1.1) / 1.1) * 1.5 - 0.5))
                        }.clipShape(RoundedRectangle(cornerRadius: radius))
                    }
                }
        }.frame(width: width, height: height)
    }
}

private final class OrbisWindowBackdropController: UIViewController {
    var targetColor: UIColor = .clear { didSet { applyIfNeeded() } }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.isUserInteractionEnabled = false
        view.backgroundColor = .clear
        applyIfNeeded()
    }

    override func didMove(toParent parent: UIViewController?) {
        super.didMove(toParent: parent)
        applyIfNeeded()
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        applyIfNeeded()
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        applyIfNeeded()
    }

    /// Synchronizes ancestor UIKit container backgrounds so safe-area margins and
    /// system bars reveal the palette base instead of default `systemBackground`.
    private func applyIfNeeded() {
        if let window = view.window, window.backgroundColor?.isEqual(targetColor) != true {
            window.backgroundColor = targetColor
        }
        var ancestor = parent
        while let controller = ancestor {
            if let hostView = controller.viewIfLoaded, hostView.backgroundColor?.isEqual(targetColor) != true {
                hostView.backgroundColor = targetColor
            }
            ancestor = controller.parent
        }
    }
}

private struct OrbisWindowBackdropView: UIViewControllerRepresentable {
    let color: UIColor

    func makeUIViewController(context: Context) -> OrbisWindowBackdropController {
        let controller = OrbisWindowBackdropController()
        controller.targetColor = color
        return controller
    }

    func updateUIViewController(_ controller: OrbisWindowBackdropController, context: Context) {
        if !controller.targetColor.isEqual(color) {
            controller.targetColor = color
        }
    }
}

extension View {
    func orbisWindowBackdrop(color: UIColor) -> some View {
        background {
            OrbisWindowBackdropView(color: color)
                .allowsHitTesting(false)
                .accessibilityHidden(true)
        }
    }

    @ViewBuilder func orbisSystemNavigationBarChrome(visible: Bool) -> some View {
        if #available(iOS 18.0, *) {
            toolbarBackgroundVisibility(.hidden, for: .navigationBar)
                .toolbarVisibility(visible ? .visible : .hidden, for: .navigationBar)
        } else {
            toolbarBackground(.hidden, for: .navigationBar)
                .toolbar(visible ? .visible : .hidden, for: .navigationBar)
        }
    }

    @ViewBuilder func orbisSystemTabBarVisible(_ visible: Bool) -> some View {
        if #available(iOS 18.0, *) {
            toolbarVisibility(visible ? .visible : .hidden, for: .tabBar)
        } else {
            toolbar(visible ? .visible : .hidden, for: .tabBar)
        }
    }

    @ViewBuilder func orbisConfigureVerticalTabBar() -> some View {
        #if compiler(>=6.4)
        if #available(iOS 27.1, *) {
            toolbarVerticalBehavior(.automatic)
                .toolbarVerticalCompressionBehavior(.automatic)
        } else {
            self
        }
        #else
        self
        #endif
    }

    func orbisRootSystemToolbar(enabled: Bool, showActions: Bool = true, title: String, titleColor: Color,
                                trailingLabel: String? = nil, trailingSymbol: String? = nil,
                                trailingDisabled: Bool = false, trailingIdentifier: String? = nil,
                                trailingAction: (() -> Void)? = nil) -> some View {
        modifier(OrbisRootToolbarModifier(
            enabled: enabled, showActions: showActions, title: title, titleColor: titleColor,
            trailingLabel: trailingLabel, trailingSymbol: trailingSymbol,
            trailingDisabled: trailingDisabled, trailingIdentifier: trailingIdentifier,
            trailingAction: trailingAction
        ))
    }
}

private struct OrbisRootToolbarModifier: ViewModifier {
    let enabled: Bool
    let showActions: Bool
    let title: String
    let titleColor: Color
    let trailingLabel: String?
    let trailingSymbol: String?
    let trailingDisabled: Bool
    let trailingIdentifier: String?
    let trailingAction: (() -> Void)?

    func body(content: Content) -> some View {
        if enabled {
            #if compiler(>=6.4)
            if #available(iOS 27.1, *) {
                content
                    .navigationBarTitleDisplayMode(.inline)
                    .toolbar {
                        ToolbarItem(placement: .principal) { titleLabel }
                        if showActions, let label = trailingLabel, let symbol = trailingSymbol, let action = trailingAction {
                            ToolbarItem(placement: .topBarTrailing) {
                                actionButton(label: label, symbol: symbol, action: action)
                            }
                            .axisBehavior(.verticalPreferred)
                            .visibilityPriority(.high)
                        }
                    }
            } else {
                legacyToolbar(content)
            }
            #else
            legacyToolbar(content)
            #endif
        } else {
            content
        }
    }

    private func legacyToolbar(_ content: Content) -> some View {
        content
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .principal) { titleLabel }
                if showActions, let label = trailingLabel, let symbol = trailingSymbol, let action = trailingAction {
                    ToolbarItem(placement: .topBarTrailing) {
                        actionButton(label: label, symbol: symbol, action: action)
                    }
                }
            }
    }

    private var titleLabel: some View {
        Text(title).font(.orbisTitle()).foregroundStyle(titleColor).lineLimit(1)
    }

    private func actionButton(label: String, symbol: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Label(label, systemImage: symbol)
        }
        .disabled(trailingDisabled)
        .accessibilityLabel(label)
        .modifier(OptionalAccessibilityIdentifier(identifier: trailingIdentifier))
    }
}

private struct OptionalAccessibilityIdentifier: ViewModifier {
    let identifier: String?
    func body(content: Content) -> some View {
        if let identifier {
            content.accessibilityIdentifier(identifier)
        } else {
            content
        }
    }
}
