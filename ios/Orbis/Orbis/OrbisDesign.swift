import SwiftUI

extension EnvironmentValues {
    /// Preview fixtures exercise the same reduction branches as the system setting.
    var orbisReduceMotion: Bool {
        #if DEBUG
        accessibilityReduceMotion || ProcessInfo.processInfo.arguments.contains("--preview-reduce-motion")
        #else
        accessibilityReduceMotion
        #endif
    }
}
import UIKit

// Shared with Android's OrbisTheme / Neumorph: one continuous base, raised
// actions and cards, recessed inputs and single-choice controls. Batch selection
// adds a tint and outline without changing depth. All distances are points.
struct OrbisPalette {
    let dark: Bool
    let insetFocus: Bool
    init(_ scheme: ColorScheme) {
        dark = scheme == .dark
        insetFocus = UserDefaults.standard.string(forKey: "orbis.visualStyle") == "insetFocus"
    }
    /// Four background layers, each 1–3% lightness apart: well < base < lift < top.
    /// Hierarchy comes from these steps, never from black borders or #000.
    var well: Color { Color(hex: insetFocus ? (dark ? 0x222A39 : 0xE4E7EF) : (dark ? 0x1C1F26 : 0xDDE3EF)) }
    var base: Color { Color(hex: insetFocus ? (dark ? 0x293244 : 0xEEF0F5) : (dark ? 0x23262E : 0xE6EBF4)) }
    var lift: Color { Color(hex: insetFocus ? (dark ? 0x303B4F : 0xF3F5F9) : (dark ? 0x292D36 : 0xEDF1F8)) }
    var top: Color { Color(hex: insetFocus ? (dark ? 0x37435A : 0xFAFBFD) : (dark ? 0x2F333D : 0xF3F6FB)) }
    var inset: Color { well }
    var light: Color { Color(hex: insetFocus ? (dark ? 0x44516A : 0xFFFFFF) : (dark ? 0x2E323C : 0xFFFFFF)) }
    var shadow: Color { Color(hex: insetFocus ? (dark ? 0x101828 : 0xA9B2C3) : (dark ? 0x0A0C11 : 0xA6B2C6)) }
    /// Tinted ink for scrims and drop shadows instead of pure black.
    var scrim: Color { Color(hex: dark ? 0x0A0C11 : 0x2A3344) }
    var text: Color { Color(hex: insetFocus ? (dark ? 0xE3E9F5 : 0x4A5368) : (dark ? 0xDDE1E9 : 0x232A36)) }
    var secondary: Color { Color(hex: insetFocus ? (dark ? 0xB9C4D8 : 0x798396) : (dark ? 0xB8C0CE : 0x4A5364)) }
    var accent: Color { Color(hex: insetFocus ? (dark ? 0x8DB4FF : 0x5F8FE5) : (dark ? 0xA9C0FF : 0x2459D3)) }
    var error: Color { Color(hex: dark ? 0xFFB4AB : 0xB3261E) }
    var success: Color { Color(hex: dark ? 0x84D6B3 : 0x1B7A57) }
    var warning: Color { Color(hex: dark ? 0xF2C26B : 0x9A5B00) }
    var outline: Color { Color(hex: insetFocus ? (dark ? 0x4B5870 : 0xC8CEDA) : (dark ? 0x3A4150 : 0xC9D1DE)) }

    func layer(_ index: Int) -> Color { [well, base, lift, top][min(max(index, 0), 3)] }

    func agent(_ kind: String?) -> Color {
        switch kind {
        case "codex", "codexDesktop": return Color(hex: dark ? 0x77D6C7 : 0x006C64)
        case "dsh": return Color(hex: dark ? 0xA1B5FF : 0x4D6BFE)
        case "claude": return Color(hex: dark ? 0xF0B48C : 0xB4572E)
        default: return Color(hex: dark ? 0xF2AD90 : 0x99482F)
        }
    }
}

extension Color {
    init(hex: UInt32) {
        self.init(.sRGB, red: Double((hex >> 16) & 255) / 255,
                  green: Double((hex >> 8) & 255) / 255, blue: Double(hex & 255) / 255, opacity: 1)
    }
}

// MARK: - Type, radius, motion

/// The whole interface uses four sizes; weight, color and spacing carry the rest of the hierarchy.
enum OrbisTextSize {
    static let title: CGFloat = 20
    static let body: CGFloat = 15
    static let label: CGFloat = 13
    /// Smallest readable size.
    static let caption: CGFloat = 12
}

extension Font {
    /// Digits are tabular everywhere so counts, sizes and timers never shift their neighbours.
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
    static let sheet: CGFloat = 28
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
    static let orbisCollapse = Animation.smooth(duration: 0.26)
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

private func nestedLayer(_ parent: Int, inset: Bool) -> Int {
    if inset { return parent > 0 ? parent - 1 : parent + 1 }
    return parent < 3 ? parent + 1 : parent - 1
}

private struct NeuSurface: ViewModifier {
    @Environment(\.colorScheme) private var scheme
    @AppStorage("orbis.visualStyle") private var visualStyle = "classic"
    @Environment(\.orbisSurface) private var parent
    let inset: Bool
    let radius: CGFloat
    let intensity: CGFloat
    let padding: CGFloat
    let concentric: Bool

    func body(content: Content) -> some View {
        let p = OrbisPalette(scheme)
        let r = concentric ? (parent?.innerRadius ?? radius) : radius
        let layer = parent.map { nestedLayer($0.layer, inset: inset) } ?? (inset ? 0 : 1)
        // A raised control two levels deep has no fill of its own; it only shows its press.
        let plain = (parent?.depth ?? 0) >= 2 && !inset
        let shape = RoundedRectangle(cornerRadius: r, style: .continuous)
        content
            .padding(padding)
            .environment(\.orbisSurface, OrbisSurfaceContext(layer: layer, depth: (parent?.depth ?? 0) + 1,
                                                             innerRadius: padding > 0 ? max(r - padding, 0) : nil))
            .background {
                if parent != nil {
                    shape.fill(plain ? .clear : p.layer(layer))
                } else if inset {
                    shape.fill(p.well.shadow(.inner(color: p.shadow.opacity(p.insetFocus ? 0.50 : 0.38), radius: 3 * intensity,
                                                    x: 3 * intensity, y: 3 * intensity))
                        .shadow(.inner(color: p.light.opacity(0.7), radius: 3 * intensity,
                                       x: -3 * intensity, y: -3 * intensity)))
                } else {
                    shape.fill(p.base)
                        .shadow(color: p.shadow.opacity(0.38), radius: 4 * intensity, x: 4 * intensity, y: 4 * intensity)
                        .shadow(color: p.light.opacity(0.7), radius: 4 * intensity, x: -4 * intensity, y: -4 * intensity)
                }
            }
    }
}

extension View {
    /// `padding` is applied inside the surface; nested surfaces then use `radius - padding`.
    /// Circles and capsules pass `concentric: false` to keep their own shape.
    func neuSurface(inset: Bool = false, radius: CGFloat = 20, intensity: CGFloat = 0.8,
                    padding: CGFloat = 0, concentric: Bool = true) -> some View {
        modifier(NeuSurface(inset: inset, radius: radius, intensity: intensity, padding: padding, concentric: concentric))
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
        padding(.horizontal, 16).padding(.vertical, 14).frame(minHeight: 56)
            .orbisField(focused: focused)
    }
}

private struct OrbisField: ViewModifier {
    @Environment(\.orbisSurface) private var parent
    @AppStorage("orbis.visualStyle") private var visualStyle = "classic"
    let focused: Bool
    let radius: CGFloat

    func body(content: Content) -> some View {
        let r = parent?.innerRadius ?? radius
        let shape = RoundedRectangle(cornerRadius: r, style: .continuous)
        content
            .neuSurface(inset: true, radius: radius, intensity: focused ? 0.9 : (visualStyle == "insetFocus" ? 0.82 : 0.6))
            // Outer halo: only the half outside the field shows; the field covers the rest.
            .background { shape.stroke(.tint.opacity(focused ? 0.12 : 0), lineWidth: 8) }
            .overlay { shape.strokeBorder(.tint.opacity(focused ? 0.28 : 0), lineWidth: 1.5) }
            .animation(.orbisFade, value: focused)
    }
}

/// Fills with the lightness layer `offset` steps away from the surrounding surface,
/// so rows and headers separate by background steps instead of drawn lines.
struct OrbisLayerFill: View {
    @Environment(\.colorScheme) private var scheme
    @AppStorage("orbis.visualStyle") private var visualStyle = "classic"
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
                if reduceMotion { shown = value; animating = false; return }
                // Pin the measured height first so the animation interpolates between two numbers.
                animating = true
                DispatchQueue.main.async {
                    guard token == current else { return }
                    withAnimation(.orbisCollapse) { shown = value } completion: {
                        if token == current { animating = false }
                    }
                }
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
            .neuSurface(inset: selected || configuration.isPressed, radius: radius, intensity: 0.6, padding: padding)
            .contentShape(RoundedRectangle(cornerRadius: radius))
            .opacity(enabled ? 1 : 0.4)
    }
}

/// Batch selection is a color change, never a change to the card's depth or layout.
struct OrbisSelectionButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var enabled
    @Environment(\.colorScheme) private var scheme
    @AppStorage("orbis.visualStyle") private var visualStyle = "classic"
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
            .neuSurface(inset: recessed || (!selecting && configuration.isPressed), radius: radius, intensity: 0.6, padding: padding)
            .background(OrbisTouchOrigin { touchOrigin = $0 })
            .overlay {
                OrbisSelectionFill(selected: selected, origin: touchOrigin,
                                   radius: parent?.innerRadius ?? radius, color: accent)
            }
            .contentShape(shape)
            .opacity(enabled ? 1 : 0.4)
    }
}

/// Keep the slot even outside selection mode, so labels and cards never reflow.
struct OrbisSelectionIndicator: View {
    @Environment(\.colorScheme) private var scheme
    @AppStorage("orbis.visualStyle") private var visualStyle = "classic"
    @Environment(\.orbisReduceMotion) private var reduced
    let selected: Bool
    let selecting: Bool

    var body: some View {
        let p = OrbisPalette(scheme)
        Circle().fill(selected ? p.accent : .clear)
            .overlay { Circle().strokeBorder(selected ? p.accent : p.secondary.opacity(0.55), lineWidth: 1.5) }
            .overlay {
                Image(systemName: "checkmark").font(.system(size: 12, weight: .bold))
                    .foregroundStyle(p.dark ? Color(hex: 0x12307A) : .white).opacity(selected ? 1 : 0)
            }
            .frame(width: 22, height: 22)
            .opacity(selecting ? 1 : 0)
            .animation(reduced ? nil : InteractionMotion.state, value: selected)
            .animation(reduced ? nil : InteractionMotion.state, value: selecting)
            .allowsHitTesting(false).accessibilityHidden(true)
    }
}

/// `size` is the visible disc; the touch target stays at least 44pt (48pt for the default 40pt disc).
struct OrbisIconButton: View {
    @Environment(\.colorScheme) private var scheme
    @AppStorage("orbis.visualStyle") private var visualStyle = "classic"
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
                .foregroundStyle(tint ?? OrbisPalette(scheme).secondary)
                .frame(width: diameter, height: diameter)
        }
        .buttonStyle(NeuIconButtonStyle(selected: selected, size: diameter, compact: compact)).accessibilityLabel(label)
    }
}

struct NeuIconButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var enabled
    let selected: Bool
    var size: CGFloat = 40
    var compact = false
    func makeBody(configuration: Configuration) -> some View {
        let target = compact ? 48 : max(44, size + 8)
        return configuration.label
            .environment(\.orbisGlyphPressed, configuration.isPressed && enabled)
            .neuSurface(inset: selected || configuration.isPressed, radius: size / 2,
                        intensity: compact ? 0.32 : size < 36 ? 0.4 : 0.5, concentric: false)
            .frame(width: target, height: target).contentShape(Rectangle()).opacity(enabled ? 1 : 0.4)
    }
}

/// Small raised text action (Android `NeumorphTextButton`): replaces bare system-tinted text buttons.
struct OrbisTextButton: View {
    @Environment(\.colorScheme) private var scheme
    @AppStorage("orbis.visualStyle") private var visualStyle = "classic"
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
                .foregroundStyle(tint ?? pageAccent ?? OrbisPalette(scheme).accent)
                .padding(.horizontal, 14).frame(maxWidth: fill ? .infinity : nil, minHeight: 40)
        }.buttonStyle(NeuButtonStyle(radius: 14))
    }
}

/// Raised when off, recessed with the accent check when on (Android `NeumorphCheckbox`).
struct OrbisCheckbox: View {
    @Environment(\.colorScheme) private var scheme
    @AppStorage("orbis.visualStyle") private var visualStyle = "classic"
    @Environment(\.orbisReduceMotion) private var reduced
    let checked: Bool
    let label: String
    let action: () -> Void
    var body: some View {
        Button(action: action) {
            Image(systemName: "checkmark").font(.system(size: 12, weight: .bold))
                .foregroundStyle(OrbisPalette(scheme).accent)
                .scaleEffect(checked ? 1 : 0.5).opacity(checked ? 1 : 0)
                .animation(reduced ? nil : .orbisPop, value: checked)
                .frame(width: 26, height: 26)
                .neuSurface(inset: checked, radius: 8, intensity: 0.42, concentric: false)
                .frame(width: 44, height: 44).contentShape(Rectangle())
        }.buttonStyle(.plain)
            .accessibilityLabel(label).accessibilityAddTraits(checked ? .isSelected : [])
    }
}

/// Recessed track with a raised knob; the track picks up the accent when on.
struct NeuToggleStyle: ToggleStyle {
    @Environment(\.colorScheme) private var scheme
    @AppStorage("orbis.visualStyle") private var visualStyle = "classic"
    @Environment(\.orbisReduceMotion) private var reduced
    @Environment(\.isEnabled) private var enabled
    func makeBody(configuration: Configuration) -> some View {
        let p = OrbisPalette(scheme)
        let on = configuration.isOn
        return Button { configuration.isOn.toggle() } label: {
            HStack(spacing: 12) {
                configuration.label.frame(maxWidth: .infinity, alignment: .leading)
                ZStack(alignment: on ? .trailing : .leading) {
                    Capsule().fill(p.accent.opacity(on ? 0.22 : 0))
                    Circle().fill(on ? p.accent : p.base).frame(width: 22, height: 22)
                        .shadow(color: p.shadow.opacity(0.45), radius: 2, x: 1.5, y: 1.5)
                        .shadow(color: p.light.opacity(0.7), radius: 2, x: -1.5, y: -1.5)
                        .padding(4)
                }.frame(width: 52, height: 30)
                    .neuSurface(inset: true, radius: 15, intensity: 0.5, concentric: false)
                    .animation(reduced ? nil : .orbisPop, value: on)
            }.frame(minHeight: 48).contentShape(Rectangle())
        }.buttonStyle(.plain).opacity(enabled ? 1 : 0.4)
            .accessibilityAddTraits(.isToggle).accessibilityValue(on ? L10n.tr("开") : L10n.tr("关"))
    }
}

/// Copy action whose check mark pops in and hides itself after 2.5 seconds.
struct OrbisCopyButton: View {
    @Environment(\.colorScheme) private var scheme
    @AppStorage("orbis.visualStyle") private var visualStyle = "classic"
    @Environment(\.orbisReduceMotion) private var reduced
    @Environment(\.isEnabled) private var enabled
    let label: String
    var size: CGFloat = 28
    let text: () -> String
    @StateObject private var feedback = OrbisCopyFeedback()

    var body: some View {
        let p = OrbisPalette(scheme)
        let copied = feedback.copied
        OrbisMotionButton { feedback.perform { UIPasteboard.general.string = text() } } label: {
            ZStack {
                OrbisActionSymbol(systemName: "doc.on.doc").foregroundStyle(p.secondary)
                    .opacity(copied ? 0 : 1).scaleEffect(copied ? 0.6 : 1)
                OrbisActionSymbol(systemName: "checkmark").fontWeight(.bold).foregroundStyle(p.success)
                    .opacity(copied ? 1 : 0).scaleEffect(copied ? 1 : 0.5)
            }.font(.system(size: size * 0.5, weight: .medium))
                .frame(width: size, height: size)
                .animation(reduced ? nil : .orbisPop, value: copied)
        }
        .buttonStyle(NeuIconButtonStyle(selected: false, size: size))
        .accessibilityLabel(copied ? L10n.tr("已复制") : label)
        .onChange(of: enabled) { _, enabled in if !enabled { feedback.clear() } }
        .onDisappear { feedback.clear() }
    }
}

// MARK: - Sheets

/// Sheet chrome in the shared material: the base color behind the content and a
/// recessed grab handle instead of the system indicator. Content starts outside any surface.
private struct OrbisSheetChrome: ViewModifier {
    @Environment(\.colorScheme) private var scheme
    @AppStorage("orbis.visualStyle") private var visualStyle = "classic"
    let detents: Set<PresentationDetent>
    func body(content: Content) -> some View {
        content
            .environment(\.orbisSurface, nil)
            .overlay(alignment: .top) {
                Capsule().fill(.clear).frame(width: 40, height: 6)
                    .neuSurface(inset: true, radius: 3, intensity: 0.35, concentric: false)
                    .padding(.top, 7).allowsHitTesting(false).accessibilityHidden(true)
            }
            .presentationDetents(detents)
            .presentationDragIndicator(.hidden)
            .presentationCornerRadius(OrbisRadius.sheet)
            .presentationBackground(OrbisPalette(scheme).base)
    }
}

extension View {
    func orbisSheet(_ detents: Set<PresentationDetent> = [.large]) -> some View {
        modifier(OrbisSheetChrome(detents: detents))
    }
}

// MARK: - Menus and dialogs

/// One entry of an `OrbisMenuButton`. Items are built when the menu opens.
struct OrbisMenuItem: Identifiable {
    let id = UUID()
    let title: String
    var symbol: String? = nil
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
    @Published private(set) var menu: MenuRequest?
    @Published private(set) var dialog: DialogRequest?
    var isPresenting: Bool { menu != nil || dialog != nil }

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

extension View {
    func orbisAnchor(_ anchor: OrbisAnchor) -> some View {
        background(GeometryReader { proxy in
            Color.clear
                .onAppear { anchor.frame = proxy.frame(in: .global) }
                .onChange(of: proxy.frame(in: .global)) { _, frame in anchor.frame = frame }
        })
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
    @EnvironmentObject private var overlay: OrbisOverlay
    @Environment(\.colorScheme) private var scheme
    @AppStorage("orbis.visualStyle") private var visualStyle = "classic"
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
                .foregroundStyle(tint ?? OrbisPalette(scheme).secondary)
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
    @AppStorage("orbis.visualStyle") private var visualStyle = "classic"
    let radius: CGFloat
    let padding: CGFloat
    func body(content: Content) -> some View {
        let p = OrbisPalette(scheme)
        content
            .padding(padding)
            .orbisNested(layer: 1, innerRadius: radius - padding)
            .background {
                RoundedRectangle(cornerRadius: radius, style: .continuous).fill(p.base)
                    .shadow(color: p.shadow.opacity(0.42), radius: 8, x: 6, y: 6)
                    .shadow(color: p.light.opacity(0.75), radius: 8, x: -5, y: -5)
                    .shadow(color: p.scrim.opacity(scheme == .dark ? 0.35 : 0.1), radius: 22, y: 10)
            }
    }
}

private struct OrbisOverlayLayer: View {
    @Environment(\.colorScheme) private var scheme
    @AppStorage("orbis.visualStyle") private var visualStyle = "classic"
    @ObservedObject var overlay: OrbisOverlay
    @Environment(\.orbisReduceMotion) private var reduceMotion

    var body: some View {
        ZStack {
            if overlay.dialog != nil {
                OrbisPalette(scheme).scrim.opacity(0.32).ignoresSafeArea()
                    .onTapGesture { overlay.cancelDialog() }
                    .accessibilityHidden(true)
                    .transition(.opacity)
            }
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
                            .id(menu.id)
                            .transition(reduceMotion ? .identity : .asymmetric(
                                insertion: .modifier(active: OrbisPanelEntrance(progress: 0, anchor: menuTransitionAnchor(anchor, in: bounds)),
                                                     identity: OrbisPanelEntrance(progress: 1, anchor: menuTransitionAnchor(anchor, in: bounds))).combined(with: .opacity).animation(InteractionMotion.panel),
                                removal: .modifier(active: OrbisPanelEntrance(progress: 0, anchor: menuTransitionAnchor(anchor, in: bounds)),
                                                   identity: OrbisPanelEntrance(progress: 1, anchor: menuTransitionAnchor(anchor, in: bounds))).combined(with: .opacity).animation(InteractionMotion.exit)))
                    }
                    if let dialog = overlay.dialog {
                        OrbisDialogPanel(request: dialog, onAction: overlay.perform, onCancel: overlay.cancelDialog)
                            .id(dialog.id)
                            .frame(width: proxy.size.width, height: proxy.size.height)
                            .transition(.opacity.combined(with: .scale(scale: 0.96)))
                    }
                }
                .frame(width: proxy.size.width, height: proxy.size.height, alignment: .topLeading)
            }
        }
        .animation(reduceMotion ? nil : InteractionMotion.panel, value: overlay.menu?.id)
        .animation(reduceMotion ? nil : .easeOut(duration: 0.18), value: overlay.dialog?.id)
        .allowsHitTesting(overlay.isPresenting)
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
        content.scaleEffect(0.86 + 0.14 * progress, anchor: anchor)
            .rotation3DEffect(.degrees(Double((anchor.y - 0.5) * 12 * (1 - progress))), axis: (x: 1, y: 0, z: 0), anchor: anchor)
            .offset(x: (anchor.x - 0.5) * 24 * (1 - progress), y: (anchor.y - 0.5) * 16 * (1 - progress))
    }
}

private struct OrbisMenuPanel: View {
    @Environment(\.colorScheme) private var scheme
    @AppStorage("orbis.visualStyle") private var visualStyle = "classic"
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
    @AppStorage("orbis.visualStyle") private var visualStyle = "classic"
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
                if let symbol = item.symbol {
                    OrbisMotionGlyph(symbol: copied ? "checkmark" : symbol, size: 20, activation: activation)
                }
                Text(copied ? L10n.tr("已复制") : item.title).lineLimit(2)
                    .frame(maxWidth: .infinity, alignment: .leading)
                if !item.children.isEmpty { Image(systemName: "chevron.right") }
                else if item.checked { Image(systemName: "checkmark").fontWeight(.bold) }
            }.font(.orbisBody(.medium))
                .foregroundStyle(item.destructive ? p.error : item.checked ? p.accent : p.text)
                .padding(.horizontal, 14).frame(minHeight: 48).contentShape(Rectangle())
        }.buttonStyle(MenuRowStyle(selected: item.checked))
            .disabled(item.disabled)
            .accessibilityLabel(copied ? L10n.tr("已复制") : item.title)
            .accessibilityIdentifier(item.identifier ?? "")
            .onChange(of: item.identifier) { _, _ in feedback.clear() }
            .onDisappear { feedback.clear() }
            .accessibilityAddTraits(item.checked ? .isSelected : [])
    }
}

/// Menu rows sit flat on the panel; only the checked or pressed row takes a recessed fill.
private struct MenuRowStyle: ButtonStyle {
    @Environment(\.colorScheme) private var scheme
    @AppStorage("orbis.visualStyle") private var visualStyle = "classic"
    @Environment(\.isEnabled) private var enabled
    @Environment(\.orbisSurface) private var parent
    let selected: Bool
    func makeBody(configuration: Configuration) -> some View {
        let p = OrbisPalette(scheme)
        configuration.label
            .environment(\.orbisGlyphPressed, configuration.isPressed && enabled)
            .background {
                RoundedRectangle(cornerRadius: parent?.innerRadius ?? OrbisRadius.control, style: .continuous)
                    .fill(selected || configuration.isPressed ? p.well : .clear)
            }
            .opacity(enabled ? 1 : 0.4)
    }
}

private struct OrbisDialogPanel: View {
    @Environment(\.colorScheme) private var scheme
    @AppStorage("orbis.visualStyle") private var visualStyle = "classic"
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
    @Environment(\.colorScheme) private var scheme
    @AppStorage("orbis.visualStyle") private var visualStyle = "classic"
    @Environment(\.orbisAccent) private var pageAccent
    let title: String
    var symbol: String? = nil
    var tint: Color? = nil
    @State private var activation = 0
    let action: () -> Void
    var body: some View {
        Button { activation += 1; action() } label: {
            HStack(spacing: 8) {
                if let symbol { OrbisMotionGlyph(symbol: symbol, size: 17, activation: activation) }
                OrbisMotionText(title)
            }.font(.orbisBody(.semibold))
                .foregroundStyle(tint ?? pageAccent ?? OrbisPalette(scheme).accent)
                .frame(maxWidth: .infinity, minHeight: 52).padding(.horizontal, 12)
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
        }.padding(.horizontal, 16).padding(.vertical, 10)
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
    @AppStorage("orbis.visualStyle") private var visualStyle = "classic"
    var radius: CGFloat = 16

    var body: some View {
        let palette = OrbisPalette(scheme)
        RoundedRectangle(cornerRadius: radius, style: .continuous)
            .fill(palette.well
                .shadow(.inner(color: palette.shadow.opacity(palette.insetFocus ? 0.50 : 0.38),
                               radius: 2.4, x: 2.4, y: 2.4))
                .shadow(.inner(color: palette.light.opacity(0.7), radius: 2.4, x: -2.4, y: -2.4)))
            .allowsHitTesting(false).accessibilityHidden(true)
    }
}

struct AgentEmblem: View {
    @Environment(\.colorScheme) private var scheme
    @AppStorage("orbis.visualStyle") private var visualStyle = "classic"
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
        Image(agentAsset(kind)).renderingMode(kind == "pi" || kind == "claude" || kind == nil ? .original : .template)
            .resizable().scaledToFit().foregroundStyle(OrbisPalette(scheme).agent(kind))
            .frame(width: size * (recessed ? 0.56 : 0.9), height: size * (recessed ? 0.56 : 0.9))
            .modifier(OrbisActionPulse())
    }
}

func agentTitle(_ kind: String?) -> String {
    switch kind {
    case "codex", "codexDesktop": return "Codex"
    case "dsh": return "DeepSeek"
    case "claude": return "Claude Code"
    default: return "Pi"
    }
}

private func agentAsset(_ kind: String?) -> String {
    switch kind {
    case "codex", "codexDesktop": return "AgentCodex"
    case "dsh": return "AgentDeepSeek"
    case "claude": return "AgentClaude"
    default: return "AgentPi"
    }
}

struct RuntimeStatusLabel: View {
    @Environment(\.colorScheme) private var scheme
    @AppStorage("orbis.visualStyle") private var visualStyle = "classic"
    let status: String
    var syncing = false
    var title: String? = nil
    var body: some View {
        HStack(spacing: 5) {
            // Keep the status dot and refresh spinner in the same measured slot.
            Circle().fill(color).frame(width: 7, height: 7)
                .opacity(syncing ? 0 : 1)
                .frame(width: 14, height: 14)
                .overlay {
                    if syncing { ProgressView().controlSize(.mini).accessibilityLabel(L10n.tr("正在刷新")) }
                }
            OrbisMotionText(title ?? runtimeStatusTitle(status)).font(.orbisCaption()).lineLimit(1)
        }.foregroundStyle(OrbisPalette(scheme).secondary)
    }
    private var color: Color {
        let p = OrbisPalette(scheme)
        switch status {
        // ADR-0049 §6.8：启动中是进行中的状态，与运行中同色；启动未确认待核对，与等待同色。
        case "running", "compacting", "starting", "background": return p.accent
        case "waiting", "waiting_interaction", "waiting_local_interaction", "launch_unconfirmed": return p.warning
        case "unknown", "tasks_unknown": return p.secondary
        case "error": return p.error
        default: return p.success
        }
    }
}

struct OrbisEmptyState: View {
    @Environment(\.colorScheme) private var scheme
    @AppStorage("orbis.visualStyle") private var visualStyle = "classic"
    let symbol: String
    let title: String
    var body: some View {
        VStack(spacing: 14) {
            Image(systemName: symbol).font(.system(size: 40)).foregroundStyle(OrbisPalette(scheme).secondary)
            Text(title).font(.orbisBody(.semibold))
        }.padding(24).frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

struct OrbisNotice: View {
    @Environment(\.colorScheme) private var scheme
    @AppStorage("orbis.visualStyle") private var visualStyle = "classic"
    let text: String
    var error = false
    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 9) {
            Image(systemName: error ? "exclamationmark.circle" : "info.circle")
                .orbisIconBaseline(OrbisTextSize.label)
            OrbisMotionText(text).frame(maxWidth: .infinity, alignment: .leading)
        }.font(.orbisLabel())
            .foregroundStyle(error ? OrbisPalette(scheme).error : OrbisPalette(scheme).secondary)
            .neuSurface(inset: true, radius: OrbisRadius.control, intensity: 0.45, padding: 14)
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

    /// Call after a download was queued.
    func launch() {
        // A button's action can run before the page's tap gesture reports where the finger was.
        DispatchQueue.main.async { [weak self] in self?.fly() }
    }

    func cancel() {
        flights = []
        pop = 1
        highlighted = false
    }

    private func fly() {
        guard target != .zero else { return }
        if reduceMotion {
            #if DEBUG
            previewLaunchMode = "highlight"
            #endif
            withAnimation(.orbisFade) { highlighted = true }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.16) { [weak self] in
                withAnimation(.orbisFade) { self?.highlighted = false }
            }
            return
        }
        guard flights.count < Self.maxFlights else { popTarget(); return }
        let to = CGPoint(x: target.midX, y: target.midY)
        let flight = Flight(from: lastTap ?? CGPoint(x: page.midX, y: page.midY), to: to, start: Date())
        #if DEBUG
        previewLastFlight = flight
        previewLaunchMode = "flight"
        #endif
        flights.append(flight)
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.duration) { [weak self] in
            guard let self, self.flights.contains(where: { $0.id == flight.id }) else { return }
            self.flights.removeAll { $0.id == flight.id }
            self.popTarget()
        }
    }

    private func popTarget() {
        withAnimation(.easeOut(duration: 0.09)) { pop = 1.12 }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.09) { [weak self] in
            withAnimation(.orbisPop) { self?.pop = 1 }
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
    let flight: DownloadFlight
    func body(content: Content) -> some View {
        content.environment(\.downloadFlight, flight)
            // Observe taps without taking them from buttons, links or scrolling.
            .simultaneousGesture(SpatialTapGesture(coordinateSpace: .global).onEnded { flight.lastTap = $0.location })
            .overlay { DownloadFlightLayer(flight: flight) }
            .onGeometryChange(for: CGRect.self) { $0.frame(in: .global) } action: { flight.page = $0 }
            .onChange(of: reduceMotion, initial: true) { _, value in flight.reduceMotion = value }
            .onDisappear { flight.cancel() }
    }
}

private struct DownloadFlightTarget: ViewModifier {
    @Environment(\.colorScheme) private var scheme
    @AppStorage("orbis.visualStyle") private var visualStyle = "classic"
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
    @AppStorage("orbis.visualStyle") private var visualStyle = "classic"
    /// Chat pages follow the agent's accent (X02).
    @Environment(\.orbisAccent) private var pageAccent
    @ObservedObject var flight: DownloadFlight
    var body: some View {
        GeometryReader { proxy in
            let origin = proxy.frame(in: .global).origin
            TimelineView(.animation(paused: flight.flights.isEmpty)) { context in
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
