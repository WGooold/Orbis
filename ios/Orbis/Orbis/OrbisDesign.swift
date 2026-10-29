import SwiftUI
import UIKit

// Shared with Android's OrbisTheme / Neumorph: one continuous base, raised
// actions and cards, recessed inputs and selections. All distances are points.
struct OrbisPalette {
    let dark: Bool
    init(_ scheme: ColorScheme) { dark = scheme == .dark }
    /// Four background layers, each 1–3% lightness apart: well < base < lift < top.
    /// Hierarchy comes from these steps, never from black borders or #000.
    var well: Color { Color(hex: dark ? 0x1C1F26 : 0xDDE3EF) }
    var base: Color { Color(hex: dark ? 0x23262E : 0xE6EBF4) }
    var lift: Color { Color(hex: dark ? 0x292D36 : 0xEDF1F8) }
    var top: Color { Color(hex: dark ? 0x2F333D : 0xF3F6FB) }
    var inset: Color { well }
    var light: Color { Color(hex: dark ? 0x2E323C : 0xFFFFFF) }
    var shadow: Color { Color(hex: dark ? 0x0A0C11 : 0xA6B2C6) }
    /// Tinted ink for scrims and drop shadows instead of pure black.
    var scrim: Color { Color(hex: dark ? 0x0A0C11 : 0x2A3344) }
    var text: Color { Color(hex: dark ? 0xDDE1E9 : 0x232A36) }
    var secondary: Color { Color(hex: dark ? 0xB8C0CE : 0x4A5364) }
    var accent: Color { Color(hex: dark ? 0xA9C0FF : 0x2459D3) }
    var error: Color { Color(hex: dark ? 0xFFB4AB : 0xB3261E) }
    var success: Color { Color(hex: dark ? 0x84D6B3 : 0x1B7A57) }
    var warning: Color { Color(hex: dark ? 0xF2C26B : 0x9A5B00) }
    var outline: Color { Color(hex: dark ? 0x3A4150 : 0xC9D1DE) }

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

extension EnvironmentValues {
    var orbisSurface: OrbisSurfaceContext? {
        get { self[OrbisSurfaceKey.self] }
        set { self[OrbisSurfaceKey.self] = newValue }
    }
}

private func nestedLayer(_ parent: Int, inset: Bool) -> Int {
    if inset { return parent > 0 ? parent - 1 : parent + 1 }
    return parent < 3 ? parent + 1 : parent - 1
}

private struct NeuSurface: ViewModifier {
    @Environment(\.colorScheme) private var scheme
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
                    shape.fill(p.well.shadow(.inner(color: p.shadow.opacity(0.38), radius: 3 * intensity,
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
    let focused: Bool
    let radius: CGFloat

    func body(content: Content) -> some View {
        let r = parent?.innerRadius ?? radius
        let shape = RoundedRectangle(cornerRadius: r, style: .continuous)
        content
            .neuSurface(inset: true, radius: radius, intensity: focused ? 0.9 : 0.6)
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
    @Environment(\.orbisSurface) private var surface
    var offset = 1
    var opacity: Double = 1
    var body: some View {
        let layer = surface?.layer ?? 1
        OrbisPalette(scheme).layer(layer + offset <= 3 ? layer + offset : layer - offset).opacity(opacity)
    }
}

/// Animates a clipping frame between 0 and the content's natural height (the grid
/// `0fr → 1fr` technique): the content keeps its own layout the whole time, so nothing
/// above or below jumps to the end state before the animation catches up.
struct OrbisCollapse<Content: View>: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let expanded: Bool
    @ViewBuilder var content: Content
    @State private var shown: Bool
    @State private var animating = false
    @State private var height: CGFloat?
    @State private var token = 0

    init(expanded: Bool, @ViewBuilder content: () -> Content) {
        self.expanded = expanded
        self.content = content()
        _shown = State(initialValue: expanded)
    }

    var body: some View {
        content
            .fixedSize(horizontal: false, vertical: true)
            .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { height = $0 }
            // At rest an open container takes the content's live height, so growing content is never clipped.
            .frame(height: shown ? (animating ? height : nil) : 0, alignment: .top)
            .clipped()
            .opacity(shown ? 1 : 0)
            .allowsHitTesting(shown)
            .accessibilityHidden(!shown)
            .onChange(of: expanded) { _, value in
                if reduceMotion { shown = value; animating = false; return }
                token += 1
                let current = token
                // Pin the measured height first so the animation interpolates between two numbers.
                animating = true
                DispatchQueue.main.async {
                    withAnimation(.orbisCollapse) { shown = value } completion: {
                        if token == current { animating = false }
                    }
                }
            }
    }
}

// MARK: - Controls

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
            .neuSurface(inset: selected || configuration.isPressed, radius: radius, intensity: 0.6, padding: padding)
            .contentShape(RoundedRectangle(cornerRadius: radius))
            .opacity(enabled ? 1 : 0.4)
    }
}

/// `size` is the visible disc; the touch target stays at least 44pt (48pt for the default 40pt disc).
struct OrbisIconButton: View {
    @Environment(\.colorScheme) private var scheme
    let symbol: String
    let label: String
    var tint: Color? = nil
    var selected = false
    var size: CGFloat = 40
    let action: () -> Void
    var body: some View {
        Button(action: action) {
            Image(systemName: symbol).font(.system(size: size * 0.55, weight: .medium))
                .foregroundStyle(tint ?? OrbisPalette(scheme).secondary)
                .frame(width: size, height: size)
        }
        .buttonStyle(NeuIconButtonStyle(selected: selected, size: size)).accessibilityLabel(label)
    }
}

struct NeuIconButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var enabled
    let selected: Bool
    var size: CGFloat = 40
    func makeBody(configuration: Configuration) -> some View {
        let target = max(44, size + 8)
        return configuration.label
            .neuSurface(inset: selected || configuration.isPressed, radius: size / 2,
                        intensity: size < 36 ? 0.4 : 0.5, concentric: false)
            .frame(width: target, height: target).contentShape(Rectangle()).opacity(enabled ? 1 : 0.4)
    }
}

/// Small raised text action (Android `NeumorphTextButton`): replaces bare system-tinted text buttons.
struct OrbisTextButton: View {
    @Environment(\.colorScheme) private var scheme
    let title: String
    var symbol: String? = nil
    var tint: Color? = nil
    var fill = false
    /// Swaps the icon for a spinner in the same slot, so the button keeps its size.
    var loading = false
    let action: () -> Void
    var body: some View {
        Button(action: action) {
            HStack(spacing: 6) {
                if let symbol {
                    ZStack {
                        Image(systemName: symbol).fontWeight(.semibold).opacity(loading ? 0 : 1)
                        if loading { ProgressView().controlSize(.mini) }
                    }
                }
                Text(title).lineLimit(1)
            }.font(.orbisLabel(.semibold))
                .foregroundStyle(tint ?? OrbisPalette(scheme).accent)
                .padding(.horizontal, 14).frame(maxWidth: fill ? .infinity : nil, minHeight: 40)
        }.buttonStyle(NeuButtonStyle(radius: 14))
    }
}

/// Raised when off, recessed with the accent check when on (Android `NeumorphCheckbox`).
struct OrbisCheckbox: View {
    @Environment(\.colorScheme) private var scheme
    let checked: Bool
    let label: String
    let action: () -> Void
    var body: some View {
        Button(action: action) {
            Image(systemName: "checkmark").font(.system(size: 12, weight: .bold))
                .foregroundStyle(OrbisPalette(scheme).accent)
                .scaleEffect(checked ? 1 : 0.5).opacity(checked ? 1 : 0)
                .animation(.orbisPop, value: checked)
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
                    .animation(.orbisPop, value: on)
            }.frame(minHeight: 48).contentShape(Rectangle())
        }.buttonStyle(.plain).opacity(enabled ? 1 : 0.4)
            .accessibilityAddTraits(.isToggle).accessibilityValue(on ? "开" : "关")
    }
}

/// Copy action whose check mark pops in and hides itself after 2.5 seconds.
struct OrbisCopyButton: View {
    @Environment(\.colorScheme) private var scheme
    let label: String
    var size: CGFloat = 28
    let text: () -> String
    @State private var copied = false
    @State private var reset: Task<Void, Never>?

    var body: some View {
        let p = OrbisPalette(scheme)
        Button(action: copy) {
            ZStack {
                Image(systemName: "doc.on.doc").foregroundStyle(p.secondary)
                    .opacity(copied ? 0 : 1).scaleEffect(copied ? 0.6 : 1)
                Image(systemName: "checkmark").fontWeight(.bold).foregroundStyle(p.success)
                    .opacity(copied ? 1 : 0).scaleEffect(copied ? 1 : 0.5)
            }.font(.system(size: size * 0.5, weight: .medium))
                .frame(width: size, height: size)
                .animation(.orbisPop, value: copied)
        }
        .buttonStyle(NeuIconButtonStyle(selected: false, size: size))
        .accessibilityLabel(copied ? "已复制" : label)
        .onDisappear { reset?.cancel() }
    }

    private func copy() {
        UIPasteboard.general.string = text()
        copied = true
        reset?.cancel()
        reset = Task { @MainActor in
            try? await Task.sleep(nanoseconds: 2_500_000_000)
            if !Task.isCancelled { copied = false }
        }
    }
}

// MARK: - Sheets

/// Sheet chrome in the shared material: the base color behind the content and a
/// recessed grab handle instead of the system indicator. Content starts outside any surface.
private struct OrbisSheetChrome: ViewModifier {
    @Environment(\.colorScheme) private var scheme
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
        let anchor: CGRect
        let items: [OrbisMenuItem]
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
    func showMenu(_ items: [OrbisMenuItem], from anchor: CGRect) {
        guard dialog == nil, items.contains(where: { !$0.isDivider }) else { return }
        menu = MenuRequest(anchor: anchor, items: items)
    }
    func showDialog(_ title: String, message: String? = nil, actions: [OrbisDialogAction]) {
        menu = nil
        dialog = DialogRequest(title: title, message: message, actions: actions.isEmpty ? [OrbisDialogAction(title: "知道了", role: .cancel)] : actions)
    }
    func dismissMenu() { menu = nil }
    func dismissDialog() { dialog = nil }

    fileprivate func select(_ item: OrbisMenuItem) {
        menu = nil
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
        Button { overlay.showMenu(items(), from: anchor.frame) } label: { label }
            .buttonStyle(NeuButtonStyle(selected: selected, padding: padding))
            .orbisAnchor(anchor)
            .accessibilityLabel(accessibilityLabel)
    }
}

/// Icon disc that opens a menu; looks and sizes exactly like `OrbisIconButton`.
struct OrbisMenuIconButton: View {
    @EnvironmentObject private var overlay: OrbisOverlay
    @Environment(\.colorScheme) private var scheme
    @State private var anchor = OrbisAnchor()
    let symbol: String
    let label: String
    var tint: Color? = nil
    var selected = false
    var size: CGFloat = 40
    let items: () -> [OrbisMenuItem]
    var body: some View {
        Button { overlay.showMenu(items(), from: anchor.frame) } label: {
            Image(systemName: symbol).font(.system(size: size * 0.55, weight: .medium))
                .foregroundStyle(tint ?? OrbisPalette(scheme).secondary)
                .frame(width: size, height: size)
        }
        .buttonStyle(NeuIconButtonStyle(selected: selected, size: size))
        .orbisAnchor(anchor)
        .accessibilityLabel(label)
    }
}

/// A hand-drawn raised panel (menus, dialogs). Its content counts as nested inside one frame.
private struct OrbisPanel: ViewModifier {
    @Environment(\.colorScheme) private var scheme
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
    @ObservedObject var overlay: OrbisOverlay
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

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
                            .accessibilityHidden(true)
                        let anchor = menu.anchor.offsetBy(dx: -origin.x, dy: -origin.y)
                        OrbisMenuPanel(request: menu, anchor: anchor, bounds: bounds,
                                       onSelect: overlay.select, onDismiss: overlay.dismissMenu)
                            .id(menu.id)
                            .transition(.opacity.combined(with: .scale(scale: 0.94, anchor: menuTransitionAnchor(anchor, in: bounds))))
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
        .ignoresSafeArea(.keyboard)
        .animation(reduceMotion ? nil : .orbisFade, value: overlay.menu?.id)
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

private struct OrbisMenuPanel: View {
    @Environment(\.colorScheme) private var scheme
    let request: OrbisOverlay.MenuRequest
    /// Anchor rect and the safe area that may hold the menu, both in the layer's local coordinates.
    let anchor: CGRect
    let bounds: CGRect
    let onSelect: (OrbisMenuItem) -> Void
    let onDismiss: () -> Void

    private var width: CGFloat { min(280, max(200, bounds.width - 32)) }

    var body: some View {
        ViewThatFits(in: .vertical) {
            list
            ScrollView { list }.frame(maxHeight: max(160, bounds.height - 32))
        }
        .frame(width: width - OrbisRadius.menuPadding * 2)
        .modifier(OrbisPanel(radius: OrbisRadius.menu, padding: OrbisRadius.menuPadding))
        .alignmentGuide(.leading) { d in -x(for: d.width) }
        .alignmentGuide(.top) { d in -y(for: d.height) }
        .accessibilityElement(children: .contain)
        .accessibilityAddTraits(.isModal)
        .accessibilityAction(.escape, onDismiss)
    }

    private var list: some View {
        VStack(alignment: .leading, spacing: 4) {
            ForEach(request.items) { item in
                if item.isDivider {
                    // A lightness step, not a drawn line, separates the groups.
                    OrbisPalette(scheme).well.frame(height: 2).clipShape(Capsule())
                        .padding(.horizontal, 14).padding(.vertical, 4).accessibilityHidden(true)
                } else {
                    OrbisMenuRow(item: item) { onSelect(item) }
                }
            }
        }
    }

    /// Align with the anchor's near edge, never closer than 16pt to the safe-area edge.
    private func x(for width: CGFloat) -> CGFloat {
        let preferred = anchor.midX > bounds.midX ? anchor.maxX - width : anchor.minX
        let low = bounds.minX + 16, high = max(low, bounds.maxX - 16 - width)
        return min(max(low, preferred), high)
    }

    /// Below the anchor when it fits, otherwise above, otherwise as close as the screen allows.
    private func y(for height: CGFloat) -> CGFloat {
        let low = bounds.minY + 8, high = max(low, bounds.maxY - 8 - height)
        let below = anchor.maxY + 8
        if below <= high { return below }
        let above = anchor.minY - 8 - height
        if above >= low { return above }
        return min(max(low, anchor.midY - height / 2), high)
    }
}

private struct OrbisMenuRow: View {
    @Environment(\.colorScheme) private var scheme
    let item: OrbisMenuItem
    let action: () -> Void
    var body: some View {
        let p = OrbisPalette(scheme)
        Button(action: action) {
            HStack(spacing: 12) {
                if let symbol = item.symbol {
                    Image(systemName: symbol).frame(width: 20)
                }
                Text(item.title).lineLimit(2)
                    .frame(maxWidth: .infinity, alignment: .leading)
                if item.checked { Image(systemName: "checkmark").fontWeight(.bold) }
            }.font(.orbisBody(.medium))
                .foregroundStyle(item.destructive ? p.error : item.checked ? p.accent : p.text)
                .padding(.horizontal, 14).frame(minHeight: 48).contentShape(Rectangle())
        }.buttonStyle(MenuRowStyle(selected: item.checked))
            .disabled(item.disabled)
            .accessibilityLabel(item.title)
            .accessibilityAddTraits(item.checked ? .isSelected : [])
    }
}

/// Menu rows sit flat on the panel; only the checked or pressed row takes a recessed fill.
private struct MenuRowStyle: ButtonStyle {
    @Environment(\.colorScheme) private var scheme
    @Environment(\.isEnabled) private var enabled
    @Environment(\.orbisSurface) private var parent
    let selected: Bool
    func makeBody(configuration: Configuration) -> some View {
        let p = OrbisPalette(scheme)
        configuration.label
            .background {
                RoundedRectangle(cornerRadius: parent?.innerRadius ?? OrbisRadius.control, style: .continuous)
                    .fill(selected || configuration.isPressed ? p.well : .clear)
            }
            .opacity(enabled ? 1 : 0.4)
    }
}

private struct OrbisDialogPanel: View {
    @Environment(\.colorScheme) private var scheme
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
    let title: String
    var symbol: String? = nil
    var tint: Color? = nil
    let action: () -> Void
    var body: some View {
        Button(action: action) {
            HStack(spacing: 8) {
                if let symbol { Image(systemName: symbol) }
                Text(title)
            }.font(.orbisBody(.semibold))
                .foregroundStyle(tint ?? OrbisPalette(scheme).accent)
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
    let back: () -> Void
    @ViewBuilder var trailing: Trailing
    var body: some View {
        OrbisHeader {
            OrbisIconButton(symbol: "arrow.left", label: "返回", action: back)
        } title: {
            Text(title).font(.orbisTitle()).lineLimit(1).accessibilityAddTraits(.isHeader)
        } trailing: { trailing }
    }
}

struct AgentEmblem: View {
    @Environment(\.colorScheme) private var scheme
    let kind: String?
    var size: CGFloat = 44
    var recessed = true
    var body: some View {
        Group {
            if recessed {
                mark.frame(width: size, height: size).neuSurface(inset: true, radius: 16, intensity: 0.45)
            } else { mark.frame(width: size, height: size) }
        }.accessibilityLabel(agentTitle(kind))
    }
    private var mark: some View {
        Image(agentAsset(kind)).renderingMode(kind == "pi" || kind == nil ? .original : .template)
            .resizable().scaledToFit().foregroundStyle(OrbisPalette(scheme).agent(kind))
            .frame(width: size * (recessed ? 0.56 : 0.9), height: size * (recessed ? 0.56 : 0.9))
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
    let status: String
    var body: some View {
        HStack(spacing: 5) {
            Circle().fill(color).frame(width: 7, height: 7)
            Text(runtimeStatusTitle(status)).font(.orbisCaption())
        }.foregroundStyle(OrbisPalette(scheme).secondary)
    }
    private var color: Color {
        let p = OrbisPalette(scheme)
        switch status {
        case "running": return p.accent
        case "waiting", "waiting_interaction", "waiting_local_interaction": return p.warning
        case "error": return p.error
        default: return p.success
        }
    }
}

struct OrbisEmptyState: View {
    @Environment(\.colorScheme) private var scheme
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
    let text: String
    var error = false
    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 9) {
            Image(systemName: error ? "exclamationmark.circle" : "info.circle")
                .orbisIconBaseline(OrbisTextSize.label)
            Text(text).frame(maxWidth: .infinity, alignment: .leading)
        }.font(.orbisLabel())
            .foregroundStyle(error ? OrbisPalette(scheme).error : OrbisPalette(scheme).secondary)
            .neuSurface(inset: true, radius: OrbisRadius.control, intensity: 0.45, padding: 14)
    }
}
