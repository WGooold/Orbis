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

struct OrbisIconButton: View {
    @Environment(\.colorScheme) private var scheme
    let symbol: String
    let label: String
    var tint: Color? = nil
    var selected = false
    let action: () -> Void
    var body: some View {
        Button(action: action) {
            Image(systemName: symbol).font(.system(size: 22, weight: .medium))
                .foregroundStyle(tint ?? OrbisPalette(scheme).secondary)
                .frame(width: 40, height: 40)
        }
        .buttonStyle(NeuIconButtonStyle(selected: selected)).accessibilityLabel(label)
    }
}

private struct NeuIconButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var enabled
    let selected: Bool
    func makeBody(configuration: Configuration) -> some View {
        configuration.label.neuSurface(inset: selected || configuration.isPressed, radius: 20, intensity: 0.5)
            .frame(width: 48, height: 48).contentShape(Rectangle()).opacity(enabled ? 1 : 0.4)
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
