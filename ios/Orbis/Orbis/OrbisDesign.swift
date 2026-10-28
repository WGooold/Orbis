import SwiftUI

// Shared with Android's OrbisTheme / Neumorph: one continuous base, raised
// actions and cards, recessed inputs and selections. All distances are points.
struct OrbisPalette {
    let dark: Bool
    init(_ scheme: ColorScheme) { dark = scheme == .dark }
    var base: Color { Color(hex: dark ? 0x23262E : 0xE6EBF4) }
    var inset: Color { Color(hex: dark ? 0x1C1F26 : 0xDDE3EF) }
    var light: Color { Color(hex: dark ? 0x2E323C : 0xFFFFFF) }
    var shadow: Color { Color(hex: dark ? 0x0A0C11 : 0xA6B2C6) }
    var text: Color { Color(hex: dark ? 0xDDE1E9 : 0x232A36) }
    var secondary: Color { Color(hex: dark ? 0xB8C0CE : 0x4A5364) }
    var accent: Color { Color(hex: dark ? 0xA9C0FF : 0x2459D3) }
    var error: Color { Color(hex: dark ? 0xFFB4AB : 0xB3261E) }
    var success: Color { Color(hex: dark ? 0x84D6B3 : 0x1B7A57) }
    var outline: Color { Color(hex: dark ? 0x3A4150 : 0xC9D1DE) }

    func agent(_ kind: String?) -> Color {
        switch kind {
        case "codex", "codexDesktop": return Color(hex: dark ? 0x77D6C7 : 0x006C64)
        case "dsh": return Color(hex: dark ? 0xA1B5FF : 0x4D6BFE)
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

private struct NeuSurface: ViewModifier {
    @Environment(\.colorScheme) private var scheme
    let inset: Bool
    let radius: CGFloat
    let intensity: CGFloat

    func body(content: Content) -> some View {
        let p = OrbisPalette(scheme)
        let shape = RoundedRectangle(cornerRadius: radius, style: .continuous)
        content.background {
            if inset {
                shape.fill(p.inset.shadow(.inner(color: p.shadow.opacity(0.38), radius: 3 * intensity,
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
    func neuSurface(inset: Bool = false, radius: CGFloat = 20, intensity: CGFloat = 0.8) -> some View {
        modifier(NeuSurface(inset: inset, radius: radius, intensity: intensity))
    }
    func orbisInput() -> some View {
        padding(.horizontal, 16).padding(.vertical, 14).frame(minHeight: 56)
            .neuSurface(inset: true, radius: 16, intensity: 0.6)
    }
}

struct NeuButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var enabled
    let selected: Bool
    let radius: CGFloat
    init(selected: Bool = false, radius: CGFloat = 16) { self.selected = selected; self.radius = radius }
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .contentShape(RoundedRectangle(cornerRadius: radius))
            .neuSurface(inset: selected || configuration.isPressed, radius: radius, intensity: 0.6)
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

private struct NeuIconButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var enabled
    let selected: Bool
    var size: CGFloat = 40
    func makeBody(configuration: Configuration) -> some View {
        let target = max(44, size + 8)
        return configuration.label.neuSurface(inset: selected || configuration.isPressed, radius: size / 2, intensity: size < 36 ? 0.4 : 0.5)
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
    let action: () -> Void
    var body: some View {
        Button(action: action) {
            HStack(spacing: 6) {
                if let symbol { Image(systemName: symbol).font(.system(size: 12, weight: .semibold)) }
                Text(title).font(.system(size: 13, weight: .semibold)).lineLimit(1)
            }.foregroundStyle(tint ?? OrbisPalette(scheme).accent)
                .padding(.horizontal, 14).frame(maxWidth: fill ? .infinity : nil, minHeight: 40)
                .contentShape(RoundedRectangle(cornerRadius: 14))
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
                .foregroundStyle(OrbisPalette(scheme).accent).opacity(checked ? 1 : 0)
                .frame(width: 26, height: 26)
                .neuSurface(inset: checked, radius: 8, intensity: 0.42)
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
                    .neuSurface(inset: true, radius: 15, intensity: 0.5)
                    .animation(.easeOut(duration: 0.16), value: on)
            }.frame(minHeight: 48).contentShape(Rectangle())
        }.buttonStyle(.plain).opacity(enabled ? 1 : 0.4)
            .accessibilityAddTraits(.isToggle).accessibilityValue(on ? "开" : "关")
    }
}

// MARK: - Sheets

/// Sheet chrome in the shared material: the base color behind the content and a
/// recessed grab handle instead of the system indicator.
private struct OrbisSheetChrome: ViewModifier {
    @Environment(\.colorScheme) private var scheme
    let detents: Set<PresentationDetent>
    func body(content: Content) -> some View {
        content
            .overlay(alignment: .top) {
                Capsule().fill(.clear).frame(width: 40, height: 6)
                    .neuSurface(inset: true, radius: 3, intensity: 0.35)
                    .padding(.top, 7).allowsHitTesting(false).accessibilityHidden(true)
            }
            .presentationDetents(detents)
            .presentationDragIndicator(.hidden)
            .presentationCornerRadius(28)
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
        accessibilityHidden(overlay.isPresenting)
            .overlay { OrbisOverlayLayer(overlay: overlay) }
            .environmentObject(overlay)
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
    let items: () -> [OrbisMenuItem]
    @ViewBuilder let label: Label
    var body: some View {
        Button { overlay.showMenu(items(), from: anchor.frame) } label: { label }
            .buttonStyle(NeuButtonStyle(selected: selected, radius: 16))
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

private struct OrbisOverlayLayer: View {
    @ObservedObject var overlay: OrbisOverlay
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        ZStack {
            if overlay.dialog != nil {
                Color.black.opacity(0.32).ignoresSafeArea()
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
        .animation(reduceMotion ? nil : .easeOut(duration: 0.16), value: overlay.menu?.id)
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
        let p = OrbisPalette(scheme)
        ViewThatFits(in: .vertical) {
            list
            ScrollView { list }.frame(maxHeight: max(160, bounds.height - 32))
        }
        .frame(width: width)
        .background {
            RoundedRectangle(cornerRadius: 20, style: .continuous).fill(p.base)
                .shadow(color: p.shadow.opacity(0.42), radius: 8, x: 6, y: 6)
                .shadow(color: p.light.opacity(0.75), radius: 8, x: -5, y: -5)
                .shadow(color: .black.opacity(scheme == .dark ? 0.35 : 0.1), radius: 22, y: 10)
        }
        .alignmentGuide(.leading) { d in -x(for: d.width) }
        .alignmentGuide(.top) { d in -y(for: d.height) }
        .accessibilityElement(children: .contain)
        .accessibilityAddTraits(.isModal)
        .accessibilityAction(.escape, onDismiss)
    }

    private var list: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(request.items) { item in
                if item.isDivider {
                    Rectangle().fill(OrbisPalette(scheme).outline.opacity(0.8)).frame(height: 1)
                        .padding(.horizontal, 8).padding(.vertical, 2).accessibilityHidden(true)
                } else {
                    OrbisMenuRow(item: item) { onSelect(item) }
                }
            }
        }.padding(12)
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
                    Image(systemName: symbol).font(.system(size: 15, weight: .medium)).frame(width: 20)
                }
                Text(item.title).font(.system(size: 14, weight: .medium)).lineLimit(2)
                    .frame(maxWidth: .infinity, alignment: .leading)
                if item.checked { Image(systemName: "checkmark").font(.system(size: 12, weight: .bold)) }
            }.foregroundStyle(item.destructive ? p.error : item.checked ? p.accent : p.text)
                .padding(.horizontal, 14).frame(minHeight: 48).contentShape(Rectangle())
        }.buttonStyle(NeuButtonStyle(selected: item.checked, radius: 14))
            .disabled(item.disabled)
            .accessibilityLabel(item.title)
            .accessibilityAddTraits(item.checked ? .isSelected : [])
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
            Text(request.title).font(.system(size: 19, weight: .semibold))
                .fixedSize(horizontal: false, vertical: true).accessibilityAddTraits(.isHeader)
            if let message = request.message, !message.isEmpty {
                ViewThatFits(in: .vertical) {
                    messageText(message)
                    ScrollView { messageText(message) }.frame(maxHeight: 320)
                }
            }
            if ordered.count <= 2 {
                HStack(spacing: 12) { ForEach(ordered) { button($0) } }
            } else {
                VStack(spacing: 12) { ForEach(ordered) { button($0) } }
            }
        }
        .foregroundStyle(p.text)
        .padding(24).frame(maxWidth: 360, alignment: .leading)
        .background {
            RoundedRectangle(cornerRadius: 28, style: .continuous).fill(p.base)
                .shadow(color: p.shadow.opacity(0.5), radius: 10, x: 8, y: 8)
                .shadow(color: p.light.opacity(0.6), radius: 10, x: -6, y: -6)
        }
        .padding(.horizontal, 28)
        .accessibilityElement(children: .contain)
        .accessibilityAddTraits(.isModal)
        .accessibilityIdentifier("orbis-dialog")
        .accessibilityAction(.escape, onCancel)
    }

    private func messageText(_ message: String) -> some View {
        Text(message).font(.system(size: 14)).foregroundStyle(OrbisPalette(scheme).secondary)
            .fixedSize(horizontal: false, vertical: true).frame(maxWidth: .infinity, alignment: .leading)
    }

    private func button(_ action: OrbisDialogAction) -> some View {
        let p = OrbisPalette(scheme)
        let tint = action.role == .destructive ? p.error : action.role == .cancel ? p.secondary : p.accent
        return Button { onAction(action) } label: {
            Text(action.title).font(.system(size: 14, weight: .semibold)).lineLimit(2).multilineTextAlignment(.center)
                .foregroundStyle(tint).padding(.horizontal, 12).frame(maxWidth: .infinity, minHeight: 48)
        }.buttonStyle(NeuButtonStyle(radius: 16))
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
                Text(title).font(.system(size: 14, weight: .semibold))
            }.foregroundStyle(tint ?? OrbisPalette(scheme).accent)
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
            Text(title).font(.system(size: 20, weight: .semibold)).accessibilityAddTraits(.isHeader)
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
    default: return "Pi"
    }
}

private func agentAsset(_ kind: String?) -> String {
    switch kind {
    case "codex", "codexDesktop": return "AgentCodex"
    case "dsh": return "AgentDeepSeek"
    default: return "AgentPi"
    }
}

struct RuntimeStatusLabel: View {
    @Environment(\.colorScheme) private var scheme
    let status: String
    var body: some View {
        HStack(spacing: 5) {
            Circle().fill(color).frame(width: 7, height: 7)
            Text(runtimeStatusTitle(status)).font(.system(size: 12))
        }.foregroundStyle(OrbisPalette(scheme).secondary)
    }
    private var color: Color {
        let p = OrbisPalette(scheme)
        switch status {
        case "running": return p.accent
        case "waiting", "waiting_interaction", "waiting_local_interaction": return .orange
        case "error": return p.error
        default: return p.success
        }
    }
}

struct OrbisEmptyState: View {
    @Environment(\.colorScheme) private var scheme
    let symbol: String
    let title: String
    var detail: String? = nil
    var body: some View {
        VStack(spacing: 14) {
            Image(systemName: symbol).font(.system(size: 40)).foregroundStyle(OrbisPalette(scheme).secondary)
            Text(title).font(.system(size: 16, weight: .semibold))
            if let detail { Text(detail).font(.system(size: 13)).foregroundStyle(OrbisPalette(scheme).secondary).multilineTextAlignment(.center) }
        }.padding(24).frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

struct OrbisNotice: View {
    @Environment(\.colorScheme) private var scheme
    let text: String
    var error = false
    var body: some View {
        HStack(alignment: .top, spacing: 9) {
            Image(systemName: error ? "exclamationmark.circle" : "info.circle")
            Text(text).font(.system(size: 13)).frame(maxWidth: .infinity, alignment: .leading)
        }.foregroundStyle(error ? OrbisPalette(scheme).error : OrbisPalette(scheme).secondary)
            .padding(14).neuSurface(inset: true, radius: 16, intensity: 0.45)
    }
}
