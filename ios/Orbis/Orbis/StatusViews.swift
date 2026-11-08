import SwiftUI

/// Root settings share the same material and reserve runtime changes for an explicit apply.
struct ConnectionStatusView: View {
    @EnvironmentObject private var store: OrbisStore
    @Environment(\.colorScheme) private var scheme
    @AppStorage("orbis.appearance") private var appearance = "mist"
    @AppStorage("orbis.colorMode") private var colorMode = "system"
    @EnvironmentObject private var overlay: OrbisOverlay
    @State private var protocolOpen = false
    @State private var proposedProtocol: RelayTransportMode = .auto
    var root = false
    let onBack: () -> Void
    var body: some View {
        VStack(spacing: 0) {
            OrbisHeader {
                if !root { OrbisIconButton(symbol: "arrow.left", label: L10n.tr("返回"), action: onBack) }
            } title: { Text(L10n.tr("设置")).font(.orbisTitle()) } trailing: { EmptyView() }
            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    StatusSection(title: L10n.tr("外观")) { appearancePicker }
                    StatusSection(title: L10n.tr("连接")) {
                        HStack {
                            Label(store.selectedHost?.hostName ?? L10n.tr("电脑"), systemImage: "laptopcomputer").font(.orbisBody(.semibold))
                            Spacer()
                            ConnectionPill(connection: store.connection, path: store.activePath)
                        }.frame(minHeight: 48)
                        StatusRow(label: L10n.tr("端到端加密"), value: store.connection == .secured ? L10n.tr("已启用") : L10n.tr("未建立"), tone: OrbisPalette(scheme).secondary)
                        OrbisMotionButton {
                            proposedProtocol = store.relayTransportMode; protocolOpen = true
                        } label: {
                            HStack(spacing: 8) {
                                VStack(alignment: .leading, spacing: 4) {
                                    Text(L10n.tr("连接协议")).font(.orbisBody(.semibold))
                                    Text(protocolTitle(store.relayTransportMode) + " · " + connectionProtocolText(store.relayTransportKind, path: store.activePath, connected: store.connection == .secured))
                                        .font(.orbisLabel()).foregroundStyle(OrbisPalette(scheme).secondary)
                                }
                                Spacer(); Image(systemName: "chevron.right").font(.orbisLabel())
                            }.frame(minHeight: 56).contentShape(Rectangle())
                        }.buttonStyle(NeuButtonStyle()).accessibilityIdentifier("settings-protocol")
                        StatusRow(label: L10n.tr("连接延迟"), value: connectionLatencyText(store.pathRTT, connected: store.connection == .secured))
                        ForEach(store.pairings, id: \.hostId) { pairing in
                            OrbisMotionButton { store.connect(hostId: pairing.hostId) } label: {
                                HStack(spacing: 8) {
                                    Image(systemName: "laptopcomputer")
                                    Text(pairing.hostName).font(.orbisLabel()).lineLimit(1)
                                    Spacer()
                                    Image(systemName: pairing.hostId == store.selectedHostId ? "checkmark" : "arrow.left.arrow.right")
                                }.foregroundStyle(pairing.hostId == store.selectedHostId ? OrbisPalette(scheme).accent : OrbisPalette(scheme).secondary)
                                    .frame(minHeight: 48)
                            }.buttonStyle(NeuButtonStyle(selected: pairing.hostId == store.selectedHostId))
                        }
                        OrbisTextButton(title: L10n.tr("重新连接"), symbol: "arrow.clockwise", action: store.reconnectSelectedHost)
                            .disabled(store.selectedHost == nil || store.connection == .connecting)
                    }
                    StatusSection(title: L10n.tr("语言")) {
                        ForEach(AppLanguage.allCases, id: \.rawValue) { choice in languageChoice(choice) }
                    }
                    Text("Orbis · Easy Agents Everywhere").font(.orbisCaption()).foregroundStyle(OrbisPalette(scheme).secondary)
                        .frame(maxWidth: .infinity).padding(.vertical, 8)
                }.padding(.horizontal, 20).padding(.vertical, 16)
            }.accessibilityIdentifier("settings-page")
        }.background(OrbisPalette(scheme).base.ignoresSafeArea())
            .sheet(isPresented: $protocolOpen) { protocolSheet.orbisSheet([.medium, .large]) }
    }
    private var appearancePicker: some View {
        VStack(spacing: 16) {
            HStack(spacing: 16) {
                themePreview(dark: false)
                themePreview(dark: true)
            }
            Toggle(isOn: Binding(get: { colorMode == "system" }, set: { colorMode = $0 ? "system" : scheme == .dark ? "dark" : "light" })) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(L10n.tr("跟随系统")).font(.orbisBody(.semibold))
                    Text(L10n.tr("随手机的浅色与深色自动切换")).font(.orbisLabel()).foregroundStyle(OrbisPalette(scheme).secondary)
                }
            }.toggleStyle(NeuToggleStyle()).accessibilityIdentifier("appearance-system")
            HStack {
                Text(L10n.tr("材质")).font(.orbisBody(.semibold)); Spacer()
                ForEach(OrbisAppearance.allCases, id: \.rawValue) { material in
                    let selected = appearance == material.rawValue
                    let palette = OrbisPalette(scheme, appearance: material)
                    OrbisMotionButton { appearance = material.rawValue } label: {
                        HStack(spacing: 8) {
                            Circle().fill(palette.base).overlay { Circle().fill(palette.accent).frame(width: 8, height: 8) }
                                .frame(width: 28, height: 28)
                                .neuSurface(inset: selected, radius: 14, intensity: 0.4, concentric: false)
                            Text(material == .mist ? L10n.tr("雾蓝") : L10n.tr("灰绿")).font(.orbisLabel(selected ? .semibold : .regular))
                        }.foregroundStyle(selected ? OrbisPalette(scheme).accent : OrbisPalette(scheme).secondary).frame(minHeight: 48)
                    }.buttonStyle(.plain).accessibilityIdentifier("appearance-" + material.rawValue)
                        .accessibilityAddTraits(selected ? .isSelected : [])
                }
            }
        }
    }
    private func themePreview(dark: Bool) -> some View {
        let selected = colorMode == "system" ? (scheme == .dark) == dark : colorMode == (dark ? "dark" : "light")
        let p = OrbisPalette(dark ? .dark : .light)
        return OrbisMotionButton { colorMode = dark ? "dark" : "light" } label: {
            VStack(spacing: 8) {
                VStack(alignment: .leading, spacing: 12) {
                    HStack { RoundedRectangle(cornerRadius: 2).fill(p.secondary).frame(width: 32, height: 4); Spacer(); Circle().fill(p.accent).frame(width: 8, height: 8) }
                    ForEach(0..<2) { index in
                        HStack(spacing: 8) {
                            Circle().fill(index == 0 ? p.success : p.faint).frame(width: 6, height: 6)
                            RoundedRectangle(cornerRadius: 2).fill(p.secondary).frame(height: 4)
                        }.padding(8).frame(height: 28).background(p.base, in: RoundedRectangle(cornerRadius: 8))
                            .shadow(color: p.shadow.opacity(p.shadeOpacity), radius: 2, x: 2, y: 2)
                            .shadow(color: p.light.opacity(p.highlightOpacity), radius: 2, x: -2, y: -2)
                    }
                    RoundedRectangle(cornerRadius: 6).fill(p.base.shadow(.inner(color: p.shadow.opacity(p.shadeOpacity), radius: 2, x: 2, y: 2))).frame(height: 20)
                }.padding(12).background(p.base, in: RoundedRectangle(cornerRadius: 12))
                    .neuSurface(inset: selected, radius: 16, intensity: 0.4, padding: 4, concentric: false)
                HStack(spacing: 6) {
                    Image(systemName: selected ? "smallcircle.filled.circle" : "circle")
                    Text(dark ? L10n.tr("深色") : L10n.tr("浅色"))
                    if selected && colorMode == "system" { Text(L10n.tr("跟随系统")).font(.orbisCaption()) }
                }.font(.orbisLabel(selected ? .semibold : .regular))
                    .foregroundStyle(selected ? OrbisPalette(scheme).accent : OrbisPalette(scheme).secondary)
            }.frame(maxWidth: .infinity)
        }.buttonStyle(.plain).accessibilityIdentifier(dark ? "appearance-dark" : "appearance-light")
            .accessibilityAddTraits(selected ? .isSelected : [])
    }
    private var protocolSheet: some View {
        VStack(alignment: .leading, spacing: 16) {
            OrbisPageHeader(title: L10n.tr("连接协议"), closes: true, back: { protocolOpen = false }) { EmptyView() }
            ForEach([RelayTransportMode.auto, .ws, .quic], id: \.rawValue) { mode in
                OrbisChoiceRow(title: protocolTitle(mode), subtitle: relayTransportModeDescription(mode), selected: proposedProtocol == mode) { proposedProtocol = mode }
                    .accessibilityIdentifier("relay-mode-" + mode.rawValue)
            }
            OrbisActionButton(title: proposedProtocol == store.relayTransportMode ? L10n.tr("正在使用") : L10n.tr("改用 {0} 并重新连接", protocolTitle(proposedProtocol))) {
                store.setRelayTransportMode(proposedProtocol); protocolOpen = false
            }.disabled(proposedProtocol == store.relayTransportMode || store.selectedHost == nil)
                .accessibilityIdentifier("relay-mode-apply")
            Spacer(minLength: 0)
        }.padding(16).background(OrbisPalette(scheme).base)
    }
    private func protocolTitle(_ mode: RelayTransportMode) -> String {
        switch mode { case .auto: L10n.tr("自动"); case .ws: "WebSocket"; case .quic: "QUIC" }
    }
    private func languageChoice(_ choice: AppLanguage) -> some View {
        let selected = AppLocalization.shared.preference == choice
        let title = choice == .system ? L10n.tr("跟随系统") : choice == .chinese ? "简体中文" : "English"
        return OrbisChoiceRow(title: title, subtitle: "", selected: selected) { AppLocalization.shared.select(choice) }
            .accessibilityIdentifier("language-\(choice.rawValue)")
    }
}

struct OrbisChoiceRow: View {
    @Environment(\.colorScheme) private var scheme
    let title: String
    let subtitle: String
    let selected: Bool
    let action: () -> Void
    var body: some View {
        OrbisMotionButton(action: action) {
            HStack(alignment: .center, spacing: 12) {
                Circle().fill(.clear).overlay { if selected { Circle().fill(OrbisPalette(scheme).accent).padding(7) } }
                    .frame(width: 24, height: 24).neuSurface(inset: true, radius: 12, intensity: 0.4, concentric: false)
                VStack(alignment: .leading, spacing: 4) {
                    Text(title).font(.orbisBody(.semibold)).foregroundStyle(selected ? OrbisPalette(scheme).accent : OrbisPalette(scheme).text)
                    if !subtitle.isEmpty { Text(subtitle).font(.orbisLabel()).foregroundStyle(OrbisPalette(scheme).secondary).fixedSize(horizontal: false, vertical: true) }
                }.frame(maxWidth: .infinity, alignment: .leading)
            }.padding(12).frame(minHeight: 48).contentShape(Rectangle())
        }.buttonStyle(NeuButtonStyle(selected: selected, radius: 16))
            .accessibilityAddTraits(selected ? .isSelected : [])
    }
}

private struct AgentStatusProviderCard: View {
    @EnvironmentObject private var host: HostState
    @EnvironmentObject private var overlay: OrbisOverlay
    @Environment(\.colorScheme) private var scheme
    @AppStorage("orbis.appearance") private var visualStyle = "mist"
    @State private var switchAnchor = OrbisAnchor()
    let kind: String
    private var providers: [AgentProvider] { host.providers(for: kind) }
    private var current: AgentProvider? { host.currentProvider(for: kind) }
    private var quotaSnapshot: ProviderQuotaSnapshot? { host.subscriptionQuota(for: kind) }
    private var quota: SubscriptionQuota? { quotaSnapshot?.quota }
    private var loading: Bool { current?.id == host.quotaProviderId && host.quotaKind == kind && host.queryingQuota }
    private var quotaAccessibilityValue: String {
        if loading { return L10n.tr("正在查询配额") }
        guard let quota else { return "" }
        return quota.windows.map { window in
            let remaining = window.remainingPercent.map { String(format: "%.0f%%", $0) } ?? L10n.tr("暂不可用")
            return window.title + " " + remaining
        }.joined(separator: L10n.tr("，"))
    }
    var body: some View {
        let palette = OrbisPalette(scheme)
        let expectedHost = host.hostKey
        ZStack(alignment: .topTrailing) {
            quotaButton(palette: palette, expectedHost: expectedHost)
            if let current, current.subscriptionSupported {
                HStack {
                    SubscriptionQuotaCoin(kind: kind, quota: quota, loading: loading,
                                          enabled: host.canChangeProvider(for: kind), tint: palette.agent(kind)) {
                        if let expectedHost { host.querySubscription(current, expectedHostKey: expectedHost) }
                    }.id("\(expectedHost ?? "")-\(kind)-\(current.id)")
                    Spacer(minLength: 0)
                }.padding(16)
            }
            OrbisMotionButton {
                let items = providers.map { provider in
                    OrbisMenuItem(title: provider.name, symbol: provider.official ? "checkmark.seal" : "server.rack",
                                  checked: provider.enabled, disabled: provider.enabled && !provider.additive) {
                        if !provider.enabled || provider.additive, let expectedHost { host.changeProvider(provider, expectedHostKey: expectedHost) }
                    }
                }
                overlay.showMenu(items, from: switchAnchor.frame)
            } label: {
                Label { Text(L10n.tr("切换")) } icon: { OrbisActionSymbol(systemName: "arrow.triangle.2.circlepath") }
                    .font(.orbisLabel(.semibold)).foregroundStyle(palette.secondary)
                    .frame(minWidth: 64, minHeight: 48).contentShape(Rectangle())
            }.buttonStyle(ProviderInlineButtonStyle()).orbisAnchor(switchAnchor)
                .disabled(!host.canChangeProvider(for: kind) || providers.isEmpty)
                .accessibilityIdentifier("provider-switch-\(kind)")
                .padding(.trailing, 12).padding(.top, 16).id(expectedHost)
        }
        .onChange(of: host.hostKey) { _, _ in overlay.dismissMenu() }
        .onChange(of: providers) { _, _ in overlay.dismissMenu() }
        .onChange(of: host.canChangeProvider(for: kind)) { _, available in
            if !available { overlay.dismissMenu() }
        }
        .onDisappear { overlay.dismissMenu() }
    }

    private func quotaButton(palette: OrbisPalette, expectedHost: String?) -> some View {
        Button {
            if let current, let expectedHost { host.querySubscription(current, expectedHostKey: expectedHost) }
        } label: {
            VStack(alignment: .leading, spacing: 10) {
                HStack(spacing: 12) {
                    if current?.subscriptionSupported == true {
                        Color.clear.frame(width: 64, height: 56)
                    } else {
                        AgentEmblem(kind: kind, size: 32, recessed: false)
                            .background { AgentIconRecess().frame(width: 48, height: 48) }
                            .accessibilityHidden(true)
                    }
                    VStack(alignment: .leading, spacing: 4) {
                        HStack(spacing: 6) {
                            Text(agentTitle(kind)).font(.orbisLabel(.semibold)).foregroundStyle(palette.text)
                            if current?.subscriptionSupported == true {
                                SubscriptionRefreshGlyph(loading: loading, pending: quota == nil, tint: palette.agent(kind), size: 16)
                            }
                        }
                        HStack(spacing: 5) {
                            Text(host.providerName(for: kind)).font(.orbisBody(.medium))
                                .foregroundStyle(palette.secondary).lineLimit(2)
                            if current?.official == true {
                                Image(systemName: "checkmark.seal.fill").font(.orbisCaption(.semibold))
                                    .foregroundStyle(palette.agent(kind)).accessibilityLabel(L10n.tr("官方供应商"))
                            }
                        }
                    }.frame(maxWidth: .infinity, alignment: .leading)
                }.padding(.trailing, 72).frame(minHeight: 48)
                if current?.subscriptionSupported == true {
                    if let error = quotaSnapshot?.error {
                        Text(error).font(.orbisCaption()).foregroundStyle(palette.error).fixedSize(horizontal: false, vertical: true)
                    }
                }
                if host.providerKind == kind, let error = host.providerError {
                    Text(error).font(.orbisCaption()).foregroundStyle(palette.error)
                }
                if host.providerKind == kind, let notice = host.providerNotice {
                    Text(notice).font(.orbisCaption()).foregroundStyle(palette.secondary)
                }
            }.padding(16).frame(maxWidth: .infinity, alignment: .leading).contentShape(Rectangle())
        }.buttonStyle(ProviderQuotaCardButtonStyle())
            .disabled(current?.subscriptionSupported != true || !host.canChangeProvider(for: kind) || loading)
            .accessibilityIdentifier("provider-quota-\(kind)")
            .accessibilityHint(current?.subscriptionSupported == true ? L10n.tr("查询或刷新订阅剩余配额") : "")
            .accessibilityValue(quotaAccessibilityValue)
    }
}

private struct ProviderQuotaCardButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label.opacity(configuration.isPressed ? 0.72 : 1)
    }
}

struct AgentProvidersView: View {
    @EnvironmentObject private var store: OrbisStore
    @EnvironmentObject private var host: HostState
    @EnvironmentObject private var overlay: OrbisOverlay
    @Environment(\.colorScheme) private var scheme
    @AppStorage("orbis.appearance") private var appearance = "mist"
    @State private var selectedId: String?
    @State private var moving = false
    var root = false
    let onBack: () -> Void
    private let kinds = ["pi", "codex", "dsh", "claude"]
    private var selectedIndex: Int { host.providers.firstIndex { $0.id == selectedId } ?? host.providers.firstIndex(where: \.enabled) ?? 0 }
    private var provider: AgentProvider? { host.providers.indices.contains(selectedIndex) ? host.providers[selectedIndex] : nil }
    private var palette: OrbisPalette { OrbisPalette(scheme) }
    var body: some View {
        VStack(spacing: 0) {
            OrbisHeader {
                if !root { OrbisIconButton(symbol: "arrow.left", label: L10n.tr("返回"), action: onBack) }
            } title: { Text(L10n.tr("供应商")).font(.orbisTitle()) } trailing: {
                OrbisIconButton(symbol: "arrow.clockwise", label: L10n.tr("刷新供应商")) { host.loadProviders(host.providerKind) }
                    .disabled(host.providersLoading || host.changingProvider || !host.connected)
            }
            VStack(alignment: .leading, spacing: 6) {
                Label(store.selectedHost?.hostName ?? L10n.tr("电脑"), systemImage: "laptopcomputer").font(.orbisBody(.semibold))
                Text(host.providerKind == "pi" ? L10n.tr("Pi 可以同时启用多个配置") : L10n.tr("{0} · 电脑上保存的 {1} 个配置", agentTitle(host.providerKind), host.providers.count))
                    .font(.orbisCaption()).foregroundStyle(palette.secondary)
            }.frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 20).padding(.vertical, 12)
            ProviderDialView(kinds: kinds, kind: host.providerKind, providers: host.providers, selected: selectedIndex,
                onKind: { kind in selectedId = nil; overlay.dismissDialog(); host.loadProviders(kind) },
                onSelect: { index in if host.providers.indices.contains(index) { selectedId = host.providers[index].id } }, onMoving: { moving = $0 })
                .frame(minHeight: 300, maxHeight: .infinity)
                .overlay {
                    if host.providersLoading { ProgressView().accessibilityLabel(L10n.tr("正在读取供应商")) }
                    else if let problem = host.providerCatalogProblem { OrbisNotice(text: problem, error: host.connected).padding(20) }
                    else if host.providers.isEmpty { Text(L10n.tr("还没有供应商")).font(.orbisBody()).foregroundStyle(palette.secondary).padding(20) }
                }
            VStack(spacing: 16) {
                quotaPanel.frame(height: 124)
                if let provider {
                    let active = provider.enabled && !provider.additive
                    OrbisActionButton(title: actionTitle(provider), symbol: active ? "checkmark" : provider.additive ? (provider.enabled ? "xmark" : "plus") : "arrow.left.arrow.right", tint: palette.agent(provider.kind)) {
                        apply(provider)
                    }.disabled(active || moving || host.providersLoading || !host.canChangeProvider)
                        .accessibilityIdentifier("provider-action-" + provider.id)
                } else { OrbisActionButton(title: L10n.tr("正在使用")) {}.disabled(true) }
                HStack {
                    Text(L10n.tr("里圈选 Agent，外圈选配置"))
                    Spacer(); Text("\(host.providers.isEmpty ? 0 : selectedIndex + 1) / \(host.providers.count)")
                }.font(.orbisCaption()).foregroundStyle(palette.secondary)
                if let notice = host.providerNotice { OrbisNotice(text: notice) }
            }.padding(.horizontal, 20).padding(.top, 12).padding(.bottom, 16)
        }.background(palette.base.ignoresSafeArea())
            .onAppear { host.loadProviders(host.providerKind) }
            .onChange(of: host.providerKind) { _, _ in selectedId = nil }
            .onChange(of: host.hostKey) { _, _ in selectedId = nil; moving = false; overlay.dismissDialog() }
            .onChange(of: host.connected) { _, connected in if !connected { moving = false; overlay.dismissDialog() } }
    }
    private var quotaPanel: some View {
        Group {
            if let provider, provider.enabled && provider.subscriptionSupported {
                HStack(alignment: .top, spacing: 20) {
                    ForEach(["five_hour", "seven_day"], id: \.self) { name in
                        let own = host.quotaProviderId == provider.id
                        ProviderQuotaCell(name: name, window: own ? host.quota?.windows.first { $0.name == name } : nil,
                            loading: own && host.queryingQuota, tint: palette.agent(provider.kind))
                    }
                    OrbisIconButton(symbol: "arrow.clockwise", label: L10n.tr("刷新配额"), compact: true) {
                        if let key = host.hostKey { host.querySubscription(provider, expectedHostKey: key) }
                    }.disabled(host.queryingQuota || !host.connected).accessibilityIdentifier("provider-quota-refresh")
                }
                .overlay(alignment: .bottomLeading) {
                    if host.quotaProviderId == provider.id, let error = host.quotaError { Text(error).font(.orbisCaption()).foregroundStyle(palette.error) }
                }
            } else {
                HStack(spacing: 6) { Image(systemName: "info.circle"); Text(L10n.tr("这个配置不提供配额查询")) }
                    .font(.orbisLabel()).foregroundStyle(palette.secondary).frame(maxWidth: .infinity)
            }
        }
    }
    private func actionTitle(_ provider: AgentProvider) -> String {
        if provider.additive { return provider.enabled ? L10n.tr("移出 {0}", provider.name) : L10n.tr("启用 {0}", provider.name) }
        return provider.enabled ? L10n.tr("正在使用 {0}", provider.name) : L10n.tr("切换到 {0}", provider.name)
    }
    private func apply(_ provider: AgentProvider) {
        guard !moving, let key = host.hostKey, host.canChangeProvider else { return }
        let removing = provider.additive && provider.enabled
        overlay.showDialog(removing ? L10n.tr("移出 {0}？", provider.name) : L10n.tr("切换 {0} 到 {1}？", agentTitle(provider.kind), provider.name), message: provider.confirmation, actions: [
            OrbisDialogAction(title: L10n.tr("取消"), role: .cancel),
            OrbisDialogAction(title: removing ? L10n.tr("移出") : provider.additive ? L10n.tr("启用") : L10n.tr("切换"), role: removing ? .destructive : .normal) {
                OrbisHaptics.commit()
                if removing { host.removeProviders([provider], expectedHostKey: key) }
                else { host.changeProvider(provider, expectedHostKey: key) }
            }
        ])
    }
}

private struct ProviderQuotaCell: View {
    @Environment(\.colorScheme) private var scheme
    let name: String
    let window: SubscriptionQuota.Window?
    let loading: Bool
    let tint: Color
    var body: some View {
        let p = OrbisPalette(scheme)
        let remaining = window?.remainingPercent
        let low = (remaining ?? 100) <= 20
        let ink = low ? p.error : tint
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 4) {
                Text(name == "five_hour" ? L10n.tr("5 小时") : L10n.tr("7 天")).font(.orbisLabel())
                if low { Image(systemName: "exclamationmark.triangle").font(.system(size: 14)).foregroundStyle(p.error) }
            }.foregroundStyle(p.secondary)
            HStack(alignment: .firstTextBaseline, spacing: 2) {
                Text(remaining.map { String(format: "%.0f", $0) } ?? "—").font(.orbisDisplay()).foregroundStyle(low ? p.error : p.text)
                Text("%").font(.orbisLabel()).foregroundStyle(p.secondary)
            }
            GeometryReader { proxy in
                Capsule().fill(.clear).neuSurface(inset: true, radius: 3, intensity: 0.4, concentric: false)
                    .overlay(alignment: .leading) { Capsule().fill(ink).frame(width: proxy.size.width * min(1, max(0, (remaining ?? 0) / 100))) }
            }.frame(height: 6)
            if loading { Text(L10n.tr("正在查询")).font(.orbisCaption()).foregroundStyle(p.secondary) }
            else if let reset = window?.resetsAt {
                Text(Date(timeIntervalSince1970: Double(reset) / 1000), style: .relative).font(.orbisCaption()).foregroundStyle(p.secondary).lineLimit(1)
            } else { Text(L10n.tr("轻点刷新查询")).font(.orbisCaption()).foregroundStyle(p.secondary) }
        }.frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityElement(children: .combine)
    }
}

private struct ProviderDialView: View {
    @Environment(\.colorScheme) private var scheme
    @Environment(\.orbisReduceMotion) private var reduced
    let kinds: [String]
    let kind: String
    let providers: [AgentProvider]
    let selected: Int
    let onKind: (String) -> Void
    let onSelect: (Int) -> Void
    let onMoving: (Bool) -> Void
    @State private var groupPosition = 0.0
    @State private var profilePosition = 0.0
    @State private var handle: ProviderDialGeometry.Handle?
    @State private var gestureStarted = false
    @State private var initialPosition = 0.0
    @State private var moved = false
    private var groupIndex: Int { kinds.firstIndex(of: kind) ?? 1 }
    private var palette: OrbisPalette { OrbisPalette(scheme) }
    var body: some View {
        GeometryReader { proxy in
            let g = ProviderDialGeometry.Layout(width: proxy.size.width, height: proxy.size.height)
            ZStack(alignment: .topLeading) {
                disc(radius: g.radius, intensity: 1).position(x: g.centerX, y: g.centerY)
                profileScale(g)
                disc(radius: g.hubRadius + 24, inset: true, intensity: 0.4).position(x: g.centerX, y: g.centerY)
                disc(radius: g.hubRadius, intensity: handle == .agent ? 1 : 0.4).position(x: g.centerX, y: g.centerY)
                ForEach(0..<45, id: \.self) { tick in
                    let angle = Double(tick * 8) * .pi / 180
                    Circle().fill(palette.faint.opacity(0.5)).frame(width: 3, height: 3)
                        .position(x: g.centerX + (g.hubRadius - 8) * cos(angle), y: g.centerY + (g.hubRadius - 8) * sin(angle))
                }
                agentScale(g).opacity(handle == .profile ? 0.4 : 1)
                disc(radius: g.holeRadius, inset: true, intensity: 0.65).position(x: g.centerX, y: g.centerY)
                Circle().fill(palette.agent(kind)).frame(width: 8, height: 8).position(x: g.centerX + g.radius + 12, y: g.centerY)
            }.frame(width: proxy.size.width, height: proxy.size.height).clipped()
                .contentShape(Rectangle()).gesture(gesture(g))
                .accessibilityElement(children: .contain)
                .overlay(alignment: .leading) {
                    Color.clear.frame(width: max(48, g.centerX + g.hubRadius), height: 48)
                        .accessibilityElement().accessibilityLabel("Agent").accessibilityValue(agentTitle(kind))
                        .accessibilityAdjustableAction { direction in adjustAgent(direction) }
                }
                .accessibilityLabel(L10n.tr("供应商圆盘"))
                .accessibilityValue(providers.indices.contains(selected) ? providers[selected].name : L10n.tr("还没有供应商"))
                .accessibilityAdjustableAction { direction in
                    let next = max(0, min(providers.count - 1, selected + (direction == .increment ? 1 : -1)))
                    settleProfile(next)
                }
        }.onAppear { groupPosition = Double(groupIndex); profilePosition = Double(selected) }
            .onChange(of: kind) { _, _ in groupPosition = Double(groupIndex); profilePosition = Double(selected) }
            .onChange(of: selected) { _, index in if handle == nil { profilePosition = Double(index) } }
    }
    private func disc(radius: Double, inset: Bool = false, intensity: CGFloat) -> some View {
        Circle().fill(.clear).frame(width: radius * 2, height: radius * 2)
            .neuSurface(inset: inset, radius: radius, intensity: intensity, concentric: false)
            .environment(\.orbisSurface, nil)
    }
    private func agentScale(_ g: ProviderDialGeometry.Layout) -> some View {
        ZStack {
            Color.clear.frame(width: 36, height: 36).neuSurface(inset: true, radius: 18, intensity: 0.4, concentric: false)
                .position(x: g.centerX + g.agentRadius, y: g.centerY)
            ForEach(Array(kinds.enumerated()), id: \.offset) { index, agent in
                let angle = (Double(index) - groupPosition) * g.agentStep * .pi / 180
                let x = g.centerX + g.agentRadius * cos(angle)
                if x >= 30 {
                    AgentEmblem(kind: agent, size: 20, recessed: false)
                        .saturation(index == groupIndex ? 1 : 0).opacity(index == groupIndex ? 1 : 0.4)
                        .position(x: x, y: g.centerY + g.agentRadius * sin(angle))
                        .onTapGesture { settleAgent(index) }
                }
            }
        }
    }
    private func profileScale(_ g: ProviderDialGeometry.Layout) -> some View {
        ZStack {
            Canvas { context, _ in
                for index in -60...60 {
                    let angle = (Double(index * 3) - profilePosition * g.profileStep) * .pi / 180
                    let major = index % 6 == 0
                    var path = Path()
                    let outer = g.radius - 10, inner = outer - (major ? 14 : index % 2 == 0 ? 9 : 5)
                    path.move(to: CGPoint(x: g.centerX + inner * cos(angle), y: g.centerY + inner * sin(angle)))
                    path.addLine(to: CGPoint(x: g.centerX + outer * cos(angle), y: g.centerY + outer * sin(angle)))
                    context.stroke(path, with: .color(palette.faint), lineWidth: 1)
                }
            }
            ForEach(Array(providers.enumerated()), id: \.element.id) { index, provider in
                let delta = Double(index) - profilePosition
                let angle = delta * g.profileStep * .pi / 180
                let x = g.centerX + (g.radius + 28) * cos(angle), y = g.centerY + (g.radius + 28) * sin(angle)
                if abs(delta) <= 3.5 && x >= 20 {
                    VStack(alignment: .leading, spacing: 4) {
                        if abs(delta) < 0.5 { Text(agentTitle(kind)).font(.orbisCaption()).foregroundStyle(palette.agent(kind)) }
                        Text(provider.name).font(abs(delta) < 0.5 ? .orbisTitle() : .orbisBody()).lineLimit(1)
                            .foregroundStyle(abs(delta) < 0.5 ? palette.text : palette.secondary)
                        if abs(delta) < 0.5 {
                            Text(provider.official ? L10n.tr("官方") : L10n.tr("自定义配置")).font(.orbisCaption()).foregroundStyle(palette.secondary)
                            if provider.enabled { Text(provider.additive ? L10n.tr("已启用") : L10n.tr("使用中")).font(.orbisCaption()).foregroundStyle(palette.success) }
                        }
                    }.frame(width: max(136, g.width - x - 8), alignment: .leading)
                        .opacity(handle == .agent ? 0.4 : max(0.25, 1 - abs(delta) * 0.22))
                        .position(x: x + max(136, g.width - x - 8) / 2, y: y)
                        .onTapGesture { settleProfile(index) }
                    Circle().fill(provider.enabled ? palette.success : palette.faint).frame(width: 5, height: 5)
                        .position(x: g.centerX + (g.radius - 32) * cos(angle), y: g.centerY + (g.radius - 32) * sin(angle))
                }
            }
        }.opacity(handle == .agent ? 0.4 : 1)
    }
    private func gesture(_ g: ProviderDialGeometry.Layout) -> some Gesture {
        DragGesture(minimumDistance: 0).onChanged { value in
            if !gestureStarted {
                gestureStarted = true; handle = g.handle(x: value.startLocation.x, y: value.startLocation.y)
                initialPosition = handle == .agent ? Double(groupIndex) : profilePosition
                moved = false
                if handle != nil { onMoving(true) }
            }
            guard let handle else { return }
            let dy = value.translation.height
            guard moved || abs(dy) >= (handle == .agent ? 10 : 4) else { return }
            moved = true
            if handle == .agent {
                let next = ProviderDialGeometry.softened(initialPosition - dy / 84, count: kinds.count)
                let index = Int(ProviderDialGeometry.clamp(next.rounded(), 0, Double(kinds.count - 1)))
                if index != groupIndex { OrbisHaptics.commit(); onKind(kinds[index]) }
                groupPosition = ProviderDialGeometry.sticky(next)
            } else {
                let next = ProviderDialGeometry.softened(initialPosition - dy / ((g.radius + 28) * g.profileStep * .pi / 180), count: providers.count)
                let index = Int(ProviderDialGeometry.clamp(next.rounded(), 0, Double(max(0, providers.count - 1))))
                if index != Int(profilePosition.rounded()) { OrbisHaptics.selectionChanged() }
                profilePosition = next
            }
        }.onEnded { value in
            let captured = handle; handle = nil; gestureStarted = false
            guard let captured else { onMoving(false); return }
            if captured == .agent { settleAgent(Int(ProviderDialGeometry.clamp(groupPosition.rounded(), 0, Double(kinds.count - 1)))) }
            else {
                let target = ProviderDialGeometry.settled(initialPosition, translation: value.translation.height,
                    predictedTranslation: value.predictedEndTranslation.height, handle: .profile, count: providers.count, pointsPerStep: (g.radius + 28) * g.profileStep * .pi / 180)
                settleProfile(target)
            }
        }
    }
    private func settleAgent(_ index: Int) {
        guard kinds.indices.contains(index) else { onMoving(false); return }
        onMoving(true)
        if kinds[index] != kind { OrbisHaptics.commit(); onKind(kinds[index]) }
        withAnimation(reduced ? nil : .timingCurve(0, 0, 0.2, 1, duration: 0.26)) { groupPosition = Double(index) } completion: { onMoving(false) }
    }
    private func settleProfile(_ index: Int) {
        guard providers.indices.contains(index) else { onMoving(false); return }
        onMoving(true)
        withAnimation(reduced ? nil : .timingCurve(0, 0, 0.2, 1, duration: 0.26)) { profilePosition = Double(index) } completion: { onSelect(index); onMoving(false) }
    }
    private func adjustAgent(_ direction: AccessibilityAdjustmentDirection) {
        settleAgent(max(0, min(kinds.count - 1, groupIndex + (direction == .increment ? 1 : -1))))
    }
}


/// One coin, two quota windows. Card refresh and coin flip remain separate actions.
private struct SubscriptionQuotaCoin: View {
    @Environment(\.colorScheme) private var scheme
    @AppStorage("orbis.appearance") private var visualStyle = "mist"
    @Environment(\.orbisReduceMotion) private var reduceMotion
    @State private var weekly = false
    @State private var angle: Double = 0
    @State private var demonstrated = false
    @State private var flipTask: Task<Void, Never>?
    @State private var fiveHourProgress: CGFloat = 0
    @State private var weeklyProgress: CGFloat = 0
    let kind: String
    let quota: SubscriptionQuota?
    let loading: Bool
    let enabled: Bool
    let tint: Color
    let refresh: () -> Void
    private var window: SubscriptionQuota.Window? { quota?.windows.first { $0.name == (weekly ? "seven_day" : "five_hour") } }
    private var remaining: Double? { window?.remainingPercent }
    private var hasReadings: Bool { quota?.windows.contains { $0.remainingPercent != nil } == true }

    private var spokenValue: String {
        let title = weekly ? L10n.tr("周配额") : L10n.tr("5 小时配额")
        let status: String
        if let remaining { status = L10n.tr("剩余 ") + String(format: "%.0f%%", remaining) }
        else { status = loading ? L10n.tr("查询中") : hasReadings ? L10n.tr("暂不可用") : L10n.tr("待查询") }
        return title + L10n.tr("，") + status
    }
    private var spokenHint: String {
        let action = hasReadings ? L10n.tr("轻点翻面查看") + (weekly ? L10n.tr("5 小时配额") : L10n.tr("周配额")) : L10n.tr("查询订阅配额")
        guard let reset = window?.resetsAt else { return action }
        return action + L10n.tr("，重置 ") + Date(timeIntervalSince1970: Double(reset) / 1000).formatted(.dateTime.locale(L10n.locale).month(.abbreviated).day().hour().minute())
    }
    private var coinButton: some View {
        Button(action: tapCoin) { coinFace }
            .buttonStyle(ProviderInlineButtonStyle()).disabled(!enabled || loading)
            .accessibilityLabel(L10n.tr("{0} 配额", agentTitle(kind)))
            .accessibilityValue(spokenValue)
            .accessibilityHint(spokenHint)
            .accessibilityIdentifier("quota-coin-\(kind)")
    }
    var body: some View {
        coinButton
            .onAppear { demonstrated = quota != nil }
            .onDisappear { cancelFlip() }
            .onChange(of: loading) { _, value in if value { cancelFlip() } }
            .onChange(of: reduceMotion) { _, _ in cancelFlip() }
            .onChange(of: quota?.checkedAt) { _, _ in demonstrate() }
            .task(id: "\(loading)-\(reduceMotion)-\(quota?.windows.map { $0.remainingPercent ?? -1 } ?? [])") { updateProgress() }
    }
    private var coinFace: some View {
        let palette = OrbisPalette(scheme)
        let color = (remaining ?? 100) <= 20 ? palette.error : tint
        return ZStack {
                ZStack {
                    SubscriptionQuotaArc(progress: 1)
                        .stroke(palette.secondary.opacity(0.16), style: StrokeStyle(lineWidth: 2.5, lineCap: .round,
                            dash: hasReadings ? [] : [1, 4]))
                    if loading {
                        TimelineView(.animation(minimumInterval: 1 / 30, paused: reduceMotion)) { context in
                            Circle().trim(from: 0, to: 0.22)
                                .stroke(color.gradient, style: StrokeStyle(lineWidth: 2.5, lineCap: .round))
                                .rotationEffect(.degrees(reduceMotion ? -90 : context.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: 1.1) / 1.1 * 360))
                        }
                    } else {
                        SubscriptionQuotaArc(progress: weekly ? weeklyProgress : fiveHourProgress)
                            .stroke(LinearGradient(colors: [color.opacity(0.4), color], startPoint: .topLeading, endPoint: .bottomTrailing),
                                    style: StrokeStyle(lineWidth: 2.5, lineCap: .round))
                    }
                    AgentEmblem(kind: kind, size: 26, recessed: false)
                }.frame(width: 44, height: 44)
                    .modifier(QuotaCoinTilt(angle: angle, palette: palette, tint: tint))
                    .background { AgentIconRecess().frame(width: 56, height: 56) }
                    .frame(maxWidth: .infinity, alignment: .leading)
                VStack(alignment: .trailing) {
                    Text(weekly ? L10n.tr("周") : "5h").foregroundStyle(palette.secondary)
                    Spacer(minLength: 0)
                    Text(remaining.map { String(format: "%.0f%%", $0) } ?? "—")
                        .foregroundStyle(remaining == nil ? palette.secondary : color).monospacedDigit()
                }.font(.orbisCaption(.medium)).frame(maxWidth: .infinity, alignment: .trailing)
                    .modifier(QuotaCoinLabelFade(phase: angle))
            }.frame(width: 64, height: 56)
                .contentShape(Rectangle())
    }
    private func tapCoin() {
        guard hasReadings else { refresh(); return }
        demonstrated = true
        cancelFlip()
        flipTask = Task { await flip() }
    }
    private func updateProgress() {
        guard !loading else { return }
        func fraction(_ name: String) -> CGFloat {
            CGFloat(min(1, max(0, (quota?.windows.first { $0.name == name }?.remainingPercent ?? 0) / 100)))
        }
        let animation: Animation? = reduceMotion ? nil : .easeOut(duration: 0.7)
        withAnimation(animation) {
            fiveHourProgress = fraction("five_hour")
            weeklyProgress = fraction("seven_day")
        }
    }
    private func demonstrate() {
        guard !demonstrated, !loading, quota?.windows.filter({ $0.remainingPercent != nil }).count == 2 else { return }
        demonstrated = true
        guard !reduceMotion else { return }
        flipTask = Task {
            do {
                try await Task.sleep(for: .milliseconds(800))
                await flip()
                try await Task.sleep(for: .milliseconds(900))
                await flip()
            } catch { return }
        }
    }
    private func cancelFlip() {
        flipTask?.cancel(); flipTask = nil
        var transaction = Transaction(); transaction.disablesAnimations = true
        withTransaction(transaction) { angle = 0 }
    }
    @MainActor private func flip() async {
        guard !Task.isCancelled else { return }
        guard !reduceMotion else { weekly.toggle(); return }
        // A linear phase clock lets the native renderer reproduce the film's exact eases.
        withAnimation(.linear(duration: QuotaCoinGeometry.outgoingDuration)) { angle = 90 }
        do { try await Task.sleep(for: .milliseconds(220)) } catch { return }
        guard !Task.isCancelled else { return }
        var transaction = Transaction(); transaction.disablesAnimations = true
        withTransaction(transaction) { weekly.toggle() }
        withAnimation(.linear(duration: QuotaCoinGeometry.incomingDuration)) { angle = 180 }
        do { try await Task.sleep(for: .milliseconds(340)) } catch { return }
        guard !Task.isCancelled else { return }
        withTransaction(transaction) { angle = 0 }
    }
}

/// Only the coin transforms. Its corner labels and hit geometry stay still.
/// The body is a closed cylinder, including at the exact side-on frame.
private struct QuotaCoinTilt: AnimatableModifier {
    var angle: Double // linear phase, eased once by QuotaCoinGeometry
    let palette: OrbisPalette
    let tint: Color
    var animatableData: Double { get { angle } set { angle = newValue } }
    private var turn: Double { QuotaCoinGeometry.angle(phase: angle) }
    private var lift: Double { abs(sin(turn * .pi / 180)) }
    private var highlight: Color { palette.dark ? palette.text : palette.light }

    func body(content: Content) -> some View {
        let shadow = QuotaCoinGeometry.shadow(angle: turn)
        ZStack {
            Circle().fill(RadialGradient(colors: [palette.scrim.opacity(palette.dark ? 0.52 : 0.32), .clear],
                                        center: .center, startRadius: 0, endRadius: QuotaCoinGeometry.shadowDiameter / 2))
                .frame(width: QuotaCoinGeometry.shadowDiameter, height: QuotaCoinGeometry.shadowDiameter)
                .scaleEffect(x: shadow.widthScale, y: QuotaCoinGeometry.shadowHeight / QuotaCoinGeometry.shadowDiameter)
                .offset(y: QuotaCoinGeometry.shadowOffsetY).opacity(shadow.opacityScale)
                .allowsHitTesting(false).accessibilityHidden(true)
            Canvas { context, _ in
                guard lift > 0.0001 else { return }
                for band in QuotaCoinGeometry.bands(angle: turn) {
                    var path = Path()
                    path.addLines(band.points); path.closeSubpath()
                    let colors = [0xF3D3C3, 0xC97A55, 0x8A4426].map { hex in
                        Color(red: min(1, Double((hex >> 16) & 255) / 255 * band.brightness),
                              green: min(1, Double((hex >> 8) & 255) / 255 * band.brightness),
                              blue: min(1, Double(hex & 255) / 255 * band.brightness))
                    }
                    context.fill(path, with: .linearGradient(Gradient(colors: colors),
                        startPoint: .zero, endPoint: CGPoint(x: 44, y: 44)))
                }
            }.accessibilityHidden(true)
            content
                .background(Circle().fill(RadialGradient(colors: [palette.top, palette.base, palette.well],
                    center: UnitPoint(x: 0.34, y: 0.28), startRadius: 0, endRadius: 32)))
                .overlay {
                    Circle().strokeBorder(LinearGradient(colors: [highlight.opacity(0.9), .clear, tint.opacity(0.25)],
                        startPoint: .topLeading, endPoint: .bottomTrailing), lineWidth: 0.7)
                    Circle().fill(LinearGradient(stops: [
                        .init(color: .clear, location: 0.30),
                        .init(color: highlight.opacity(0.55), location: 0.46),
                        .init(color: .clear, location: 0.60)],
                        startPoint: UnitPoint(x: -1.4 + turn / 180 * 2.8, y: 0),
                        endPoint: UnitPoint(x: -0.4 + turn / 180 * 2.8, y: 1)))
                        .opacity(lift)
                }
                .projectionEffect(faceTransform)
                // The cylindrical edge owns the seam; never rasterize a singular face.
                .opacity(QuotaCoinGeometry.faceVisible(angle: turn) ? 1 : 0)
        }.frame(width: 44, height: 44)
    }

    private var faceTransform: ProjectionTransform {
        let m = QuotaCoinGeometry.faceProjection(angle: turn)
        var result = ProjectionTransform()
        result.m11 = m[0]; result.m21 = m[1]; result.m31 = m[2]
        result.m12 = m[3]; result.m22 = m[4]; result.m32 = m[5]
        result.m13 = m[6]; result.m23 = m[7]; result.m33 = m[8]
        return result
    }
}

private struct QuotaCoinLabelFade: AnimatableModifier {
    var phase: Double
    var animatableData: Double { get { phase } set { phase = newValue } }
    func body(content: Content) -> some View {
        content.opacity(1 - 0.55 * abs(sin(QuotaCoinGeometry.angle(phase: phase) * .pi / 180)))
    }
}

private struct SubscriptionQuotaRing: View {
    @Environment(\.colorScheme) private var scheme
    @AppStorage("orbis.appearance") private var visualStyle = "mist"
    @Environment(\.orbisReduceMotion) private var reduceMotion
    @State private var progress: CGFloat = 0
    let name: String
    let window: SubscriptionQuota.Window?
    let loading: Bool
    let tint: Color
    private var title: String { name == "five_hour" ? L10n.tr("5 小时配额") : L10n.tr("周配额") }
    private var remaining: Double? { window?.remainingPercent }
    var body: some View {
        let palette = OrbisPalette(scheme)
        let color = (remaining ?? 100) <= 20 ? palette.error : tint
        ZStack(alignment: .topTrailing) {
            ZStack {
                SubscriptionQuotaArc(progress: 1)
                    .stroke(palette.secondary.opacity(0.12), style: StrokeStyle(lineWidth: 3.5, lineCap: .round,
                        dash: window == nil ? [2, 4] : []))
                if loading {
                    TimelineView(.animation(minimumInterval: 1 / 30, paused: reduceMotion)) { context in
                        Circle().trim(from: 0, to: 0.22)
                            .stroke(color.gradient, style: StrokeStyle(lineWidth: 3.5, lineCap: .round))
                            .rotationEffect(.degrees(reduceMotion ? -90 : context.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: 1.1) / 1.1 * 360))
                    }
                } else {
                    SubscriptionQuotaArc(progress: progress)
                        .stroke(LinearGradient(colors: [color.opacity(0.45), color], startPoint: .topLeading, endPoint: .bottomTrailing),
                                style: StrokeStyle(lineWidth: 3.5, lineCap: .round))
                }
                Text(remaining.map { String(format: "%.0f", $0) + "%" } ?? "—")
                    .font(.orbisTitle()).foregroundStyle(remaining == nil ? palette.secondary : palette.text)
                    .contentTransition(.numericText()).minimumScaleFactor(0.7).lineLimit(1).padding(.horizontal, 3)
            }.frame(width: 64, height: 64).frame(width: 76, height: 76)
            Text(name == "five_hour" ? "5h" : L10n.tr("周"))
                .font(.orbisCaption(.medium)).foregroundStyle(palette.secondary)
        }
        .task(id: "\(loading)-\(remaining ?? -1)") {
            guard !loading else { progress = 0; return }
            progress = 0
            withAnimation(reduceMotion ? nil : .easeOut(duration: 0.7)) {
                progress = min(max((remaining ?? 0) / 100, 0), 1)
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(title)
        .accessibilityValue(remaining.map { L10n.tr("剩余 ") + String(format: "%.1f", $0) + "%" } ?? (loading ? L10n.tr("查询中") : window == nil ? L10n.tr("待查询") : L10n.tr("暂不可用")))
        .accessibilityHint(window?.resetsAt.map { L10n.tr("重置 ") + Date(timeIntervalSince1970: Double($0) / 1000).formatted(.dateTime.locale(L10n.locale).month(.abbreviated).day().hour().minute()) } ?? "")
        .accessibilityIdentifier("quota-ring-\(name)")
    }
}

private struct SubscriptionQuotaArc: Shape {
    var progress: CGFloat
    var animatableData: CGFloat { get { progress } set { progress = newValue } }
    func path(in rect: CGRect) -> Path {
        var path = Path()
        guard progress > 0 else { return path }
        path.addArc(center: CGPoint(x: rect.midX, y: rect.midY), radius: min(rect.width, rect.height) / 2 - 2,
                    startAngle: .degrees(-45), endAngle: .degrees(-45 + 315 * Double(progress)), clockwise: false)
        return path
    }
}

private struct SubscriptionRefreshGlyph: View {
    @Environment(\.orbisReduceMotion) private var reduceMotion
    @State private var invitation = false
    let loading: Bool
    let pending: Bool
    let tint: Color
    var size: CGFloat = 48
    var body: some View {
        TimelineView(.animation(minimumInterval: 1 / 30, paused: !loading || reduceMotion)) { context in
            Image(systemName: "arrow.clockwise")
                .font(.orbisCaption(.semibold)).foregroundStyle(tint)
                .rotationEffect(.degrees(loading && !reduceMotion ? context.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: 1.1) / 1.1 * 360 : invitation ? -35 : 0))
                .frame(width: size, height: size)
        }.accessibilityHidden(true)
            .task(id: pending) {
                guard pending, !reduceMotion else { return }
                withAnimation(.easeInOut(duration: 0.28)) { invitation = true }
                do { try await Task.sleep(for: .milliseconds(280)) } catch { return }
                withAnimation(.easeOut(duration: 0.42)) { invitation = false }
            }
    }
}

/// Transparent inline actions share the card's material and keep their full hit area.
private struct ProviderInlineButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var enabled
    @Environment(\.orbisReduceMotion) private var reduceMotion
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .opacity(enabled ? (configuration.isPressed ? 0.55 : 1) : 0.4)
            .scaleEffect(configuration.isPressed && !reduceMotion ? 0.96 : 1)
            .animation(reduceMotion ? nil : .easeOut(duration: 0.16), value: configuration.isPressed)
    }
}

struct StatusSection<Content: View>: View {
    @Environment(\.colorScheme) private var scheme
    @AppStorage("orbis.appearance") private var visualStyle = "mist"
    let title: String
    @ViewBuilder var content: Content
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(title).font(.orbisLabel(.semibold)).foregroundStyle(OrbisPalette(scheme).secondary)
                .padding(.horizontal, 4).accessibilityAddTraits(.isHeader)
            VStack(alignment: .leading, spacing: 14) { content }
                .frame(maxWidth: .infinity, alignment: .leading)
                .neuSurface(radius: OrbisRadius.card, padding: 16)
        }
    }
}

struct StatusFact: View {
    @Environment(\.colorScheme) private var scheme
    @AppStorage("orbis.appearance") private var visualStyle = "mist"
    let label: String
    /// A short qualifier shown beside the label in its own color, instead of joining them with a dot.
    var tag: String? = nil
    let value: String
    var tone: Color? = nil
    var monospaced = false
    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack(spacing: 8) {
                Text(label).foregroundStyle(OrbisPalette(scheme).secondary)
                if let tag { Text(tag).fontWeight(.semibold).foregroundStyle(OrbisPalette(scheme).text) }
            }.font(.orbisCaption())
            HStack(alignment: .firstTextBaseline, spacing: 7) {
                if let tone { Circle().fill(tone).frame(width: 7, height: 7).orbisIconBaseline(OrbisTextSize.body) }
                Text(value).font(.orbisBody(mono: monospaced))
                    .foregroundStyle(tone ?? OrbisPalette(scheme).text).textSelection(.enabled)
            }
        }.frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// One fact on a line: label on the left, value (with its state color) on the right, as on Android.
struct StatusRow: View {
    @Environment(\.colorScheme) private var scheme
    @AppStorage("orbis.appearance") private var visualStyle = "mist"
    let label: String
    let value: String
    var tone: Color? = nil
    var body: some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: 12) {
                Text(label).font(.orbisBody()).fixedSize()
                Spacer(minLength: 0)
                valueBadge.fixedSize()
            }
            VStack(alignment: .leading, spacing: 8) {
                Text(label).font(.orbisBody()).fixedSize(horizontal: false, vertical: true)
                valueBadge
            }.frame(maxWidth: .infinity, alignment: .leading)
        }
    }
    private var valueBadge: some View {
        HStack(spacing: 6) {
            if let tone { Circle().fill(tone).frame(width: 7, height: 7) }
            Text(value).font(.orbisLabel(.medium)).fixedSize(horizontal: false, vertical: true)
                .foregroundStyle(tone ?? OrbisPalette(scheme).text).textSelection(.enabled)
        }.padding(.horizontal, tone == nil ? 0 : 10).frame(minHeight: 30)
            .background { if tone != nil { Capsule().fill(OrbisPalette(scheme).well) } }
    }
}

func pathTitle(_ path: String?) -> String {
    switch path { case "lan": return L10n.tr("局域网"); case "relay": return L10n.tr("中继"); default: return L10n.tr("尚未确认") }
}
