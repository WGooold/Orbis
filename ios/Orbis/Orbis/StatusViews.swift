import SwiftUI

/// Root settings share the same material and reserve runtime changes for an explicit apply.
struct ConnectionStatusView: View {
    @EnvironmentObject private var store: OrbisStore
    @Environment(\.colorScheme) private var scheme
    @AppStorage("orbis.appearance") private var appearance = "mist"
    @AppStorage("orbis.colorMode") private var colorMode = "system"
    @EnvironmentObject private var overlay: OrbisOverlay
    @State private var connectionOpen = false
    @State private var languageOpen = false
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
                    StatusSection(title: L10n.tr("连接")) {
                        OrbisMotionButton { connectionOpen = true } label: {
                            HStack(spacing: 12) {
                                Image(systemName: "laptopcomputer").font(.system(size: 18)).foregroundStyle(OrbisPalette(scheme).secondary)
                                VStack(alignment: .leading, spacing: 4) {
                                    Text(store.selectedHost?.hostName ?? L10n.tr("电脑")).font(.orbisBody(.semibold)).lineLimit(1)
                                    Text(pathTitle(store.activePath) + " · " + connectionProtocolText(store.relayTransportKind, path: store.activePath, connected: store.connection == .secured))
                                        .font(.orbisLabel()).foregroundStyle(OrbisPalette(scheme).secondary).lineLimit(1)
                                }.frame(maxWidth: .infinity, alignment: .leading)
                                ConnectionPill(connection: store.connection, path: store.activePath, stateLabel: true)
                            }.frame(minHeight: 56).contentShape(Rectangle())
                        }.buttonStyle(.plain).accessibilityIdentifier("settings-connection")
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
                        }.buttonStyle(.plain).accessibilityIdentifier("settings-protocol")
                    }
                    StatusSection(title: L10n.tr("外观")) { appearancePicker.padding(.vertical, 12) }
                    StatusSection(title: L10n.tr("语言")) {
                        OrbisMotionButton { languageOpen = true } label: {
                            HStack {
                                VStack(alignment: .leading, spacing: 4) {
                                    Text(AppLocalization.shared.preference == .system ? L10n.tr("跟随系统") : AppLocalization.shared.preference == .chinese ? "简体中文" : "English").font(.orbisBody(.semibold))
                                    Text(AppLocalization.shared.language == .chinese ? "简体中文" : "English").font(.orbisLabel()).foregroundStyle(OrbisPalette(scheme).secondary)
                                }
                                Spacer(); Image(systemName: "chevron.right").font(.orbisLabel()).foregroundStyle(OrbisPalette(scheme).secondary)
                            }.frame(minHeight: 56).contentShape(Rectangle())
                        }.buttonStyle(.plain).accessibilityIdentifier("settings-language")
                    }
                }.padding(.horizontal, 20).padding(.vertical, 16)
            }.accessibilityIdentifier("settings-page")
        }.background(OrbisPalette(scheme).base.ignoresSafeArea())
            .orbisBottomSheet(isPresented: $connectionOpen) { connectionSheet.orbisSheet([.medium, .large]) }
            .orbisBottomSheet(isPresented: $languageOpen) {
                VStack(spacing: 16) {
                    OrbisPageHeader(title: L10n.tr("语言"), closes: true, back: { languageOpen = false }) { EmptyView() }
                    ForEach(AppLanguage.allCases, id: \.rawValue) { choice in languageChoice(choice) }
                    Spacer(minLength: 0)
                }.padding(16).orbisSheet([.medium])
            }
            .orbisBottomSheet(isPresented: $protocolOpen) { protocolSheet.orbisSheet([.medium, .large]) }
    }
    private var connectionSheet: some View {
        VStack(spacing: 16) {
            OrbisPageHeader(title: L10n.tr("当前连接"), closes: true, back: { connectionOpen = false }) { EmptyView() }
            ScrollView {
                VStack(spacing: 16) {
                    StatusRow(label: L10n.tr("连接状态"), value: connectionTitle(store.connection))
                    StatusRow(label: L10n.tr("连接延迟"), value: connectionLatencyText(store.pathRTT, connected: store.connection == .secured))
                    StatusRow(label: L10n.tr("端到端加密"), value: store.connection == .secured ? L10n.tr("已启用") : L10n.tr("未建立"))
                    ForEach(store.pairings, id: \.hostId) { pairing in
                        OrbisChoiceRow(title: pairing.hostName, subtitle: "", selected: pairing.hostId == store.selectedHostId) { store.connect(hostId: pairing.hostId) }
                    }
                    OrbisActionButton(title: L10n.tr("重新连接"), symbol: "arrow.clockwise", action: store.reconnectSelectedHost)
                        .disabled(store.selectedHost == nil || store.connection == .connecting)
                }
            }
        }.padding(16)
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
                VStack(alignment: .leading, spacing: 6) {
                    RoundedRectangle(cornerRadius: 2).fill(p.secondary).frame(width: 44, height: 4)
                    ForEach(0..<2) { index in
                        HStack(alignment: .top, spacing: 6) {
                            Circle().fill(index == 0 ? p.success : p.faint).frame(width: 6, height: 6).padding(.top, 2)
                            VStack(alignment: .leading, spacing: 3) {
                                RoundedRectangle(cornerRadius: 2).fill(p.secondary).frame(width: index == 0 ? 54 : 62, height: 4)
                                RoundedRectangle(cornerRadius: 2).fill(p.secondary.opacity(0.65)).frame(width: 38, height: 3)
                            }
                            Spacer(minLength: 0)
                        }.padding(6).frame(height: 26).background(p.lift, in: RoundedRectangle(cornerRadius: 8))
                    }
                    HStack { Spacer(); Circle().fill(p.accent).frame(width: 10, height: 10) }
                        .padding(5).frame(height: 20)
                        .background {
                            RoundedRectangle(cornerRadius: 10).fill(p.base
                                .shadow(.inner(color: p.shadow.opacity(p.shadeOpacity), radius: 2, x: 2, y: 2))
                                .shadow(.inner(color: p.light.opacity(p.highlightOpacity), radius: 2, x: -2, y: -2)))
                        }
                }.padding(10).frame(maxWidth: .infinity).frame(height: 120).background(p.base, in: RoundedRectangle(cornerRadius: 12))
                    .neuSurface(inset: selected, radius: 16, intensity: 0.4, padding: 4, concentric: false)
                    .environment(\.colorScheme, dark ? .dark : .light)
                HStack(spacing: 6) {
                    Image(systemName: selected ? "smallcircle.filled.circle" : "circle")
                    Text(dark ? L10n.tr("深色") : L10n.tr("浅色"))
                    if selected && colorMode == "system" { Text(L10n.tr("跟随系统")).font(.orbisCaption()) }
                }.font(.orbisBody(selected ? .semibold : .regular))
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
    private let kinds = ["codex", "claude", "dsh", "pi"]
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
            HStack(alignment: .firstTextBaseline, spacing: 12) {
                Label(store.selectedHost?.hostName ?? L10n.tr("电脑"), systemImage: "laptopcomputer").font(.orbisBody(.semibold))
                Spacer(minLength: 8)
                Text(host.providerKind == "pi" ? L10n.tr("Pi 可以同时启用多个配置") : L10n.tr("{0} · 电脑上保存的 {1} 个配置", agentTitle(host.providerKind), host.providers.count))
                    .font(.orbisCaption()).foregroundStyle(palette.secondary).lineLimit(1).minimumScaleFactor(0.8)
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
            .accessibilityIdentifier("provider-quota-" + name)
    }
}

private struct ProviderDialView: View {
    @Environment(\.colorScheme) private var scheme
    @Environment(\.orbisReduceMotion) private var reduced
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.orbisVisible) private var visible
    @State private var keyboardHandle: ProviderDialGeometry.Handle?
    @GestureState private var dragging = false
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
    @State private var agentPulse = 0
    @State private var profilePulse = 0
    private var groupIndex: Int { kinds.firstIndex(of: kind) ?? 1 }
    private var palette: OrbisPalette { OrbisPalette(scheme) }
    var body: some View {
        GeometryReader { proxy in
            let g = ProviderDialGeometry.Layout(width: proxy.size.width, height: proxy.size.height)
            ZStack(alignment: .topLeading) {
                disc(radius: g.radius, intensity: 1)
                    .overlay { if keyboardHandle == .profile { Circle().stroke(palette.agent(kind), lineWidth: 2).padding(4) } }
                    .focusEffectDisabled()
                    .onKeyPress(keys: [.upArrow, .downArrow, .home, .end]) { key in keyboardBrowse(.profile, key: key.key) }
                    .onKeyPress(.tab, phases: .down) { key in
                        if key.modifiers.contains(.shift) { return .ignored }
                        keyboardHandle = .agent; return .handled
                    }
                    .accessibilityElement().accessibilityLabel(L10n.tr("供应商圆盘"))
                    .accessibilityValue(providers.indices.contains(selected) ? providers[selected].name : L10n.tr("还没有供应商"))
                    .accessibilityIdentifier("provider-profile-keyboard")
                    .position(x: g.centerX, y: g.centerY)
                profileScale(g)
                disc(radius: g.hubRadius + 24, inset: true, intensity: 0.4).position(x: g.centerX, y: g.centerY)
                let hubIntensity: CGFloat = handle == .agent ? 1 : 0.4
                disc(radius: g.hubRadius, intensity: hubIntensity)
                    .overlay { if keyboardHandle == .agent { Circle().stroke(palette.agent(kind), lineWidth: 2).padding(4) } }
                    .focusEffectDisabled()
                    .onKeyPress(keys: [.upArrow, .downArrow, .home, .end]) { key in keyboardBrowse(.agent, key: key.key) }
                    .onKeyPress(.tab, phases: .down) { key in
                        if key.modifiers.contains(.shift) { keyboardHandle = .profile; return .handled }
                        return .ignored
                    }
                    .accessibilityElement().accessibilityLabel("Agent").accessibilityValue(agentTitle(kind))
                    .accessibilityIdentifier("provider-agent-keyboard")
                    .position(x: g.centerX, y: g.centerY)
                ForEach(0..<45, id: \.self) { tick in
                    let angle = Double(tick * 8) * .pi / 180
                    Circle().fill(palette.faint.opacity(0.5)).frame(width: 3, height: 3)
                        .position(x: g.centerX + (g.hubRadius - 8) * cos(angle), y: g.centerY + (g.hubRadius - 8) * sin(angle))
                }
                agentScale(g).opacity(handle == .profile ? 0.4 : 1)
                disc(radius: g.holeRadius, inset: true, intensity: 0.65).position(x: g.centerX, y: g.centerY)
                Circle().fill(palette.agent(kind)).frame(width: 8, height: 8)
                    .modifier(OrbisDialPulse(trigger: profilePulse, peak: 1.5))
                    .position(x: g.centerX + g.radius + 12, y: g.centerY)
            }.frame(width: proxy.size.width, height: proxy.size.height).clipped()
                .contentShape(Rectangle()).gesture(gesture(g))
                .background {
                    OrbisDialKeyboardBridge(active: visible && scenePhase == .active,
                        focus: Binding(get: { keyboardHandle }, set: { keyboardHandle = $0 }),
                        browse: { owner, key in _ = keyboardBrowse(owner, key: key) })
                }
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
        }.onAppear {
            groupPosition = Double(groupIndex); profilePosition = Double(selected)
            #if DEBUG
            if ProcessInfo.processInfo.arguments.contains("--preview-provider-keyboard") {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { keyboardHandle = .profile }
            }
            #endif
        }
            .onChange(of: dragging) { old, active in if old && !active { resetGesture() } }
            .onChange(of: visible) { _, active in if !active { keyboardHandle = nil; resetGesture() } }
            .onChange(of: scenePhase) { _, phase in if phase != .active { keyboardHandle = nil; resetGesture() } }
            .onDisappear { keyboardHandle = nil; resetGesture() }
            .onChange(of: kind) { _, _ in
                agentPulse += 1
                if handle == nil { groupPosition = Double(groupIndex) }
                withAnimation(reduced ? nil : InteractionMotion.state) { profilePosition = Double(selected) }
            }
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
                .modifier(OrbisDialPulse(trigger: agentPulse, peak: 1.08))
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
        DragGesture(minimumDistance: 0).updating($dragging) { _, active, _ in active = true }.onChanged { value in
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
                if index != Int(profilePosition.rounded()) { OrbisHaptics.selectionChanged(); profilePulse += 1 }
                profilePosition = next
            }
        }.onEnded { value in
            let captured = handle; handle = nil; gestureStarted = false
            guard let captured else { onMoving(false); return }
            if !moved {
                let angle = atan2(value.startLocation.y - g.centerY, value.startLocation.x - g.centerX) * 180 / .pi
                if captured == .agent { settleAgent(Int(ProviderDialGeometry.clamp((groupPosition + angle / g.agentStep).rounded(), 0, Double(kinds.count - 1)))) }
                else { settleProfile(Int(ProviderDialGeometry.clamp((profilePosition + angle / g.profileStep).rounded(), 0, Double(max(0, providers.count - 1))))) }
                return
            }
            if captured == .agent { settleAgent(Int(ProviderDialGeometry.clamp(groupPosition.rounded(), 0, Double(kinds.count - 1)))) }
            else {
                let target = ProviderDialGeometry.settled(initialPosition, translation: value.translation.height,
                    predictedTranslation: value.predictedEndTranslation.height, handle: .profile, count: providers.count, pointsPerStep: (g.radius + 28) * g.profileStep * .pi / 180)
                settleProfile(target)
            }
        }
    }
    private func resetGesture() {
        guard handle != nil || gestureStarted else { return }
        handle = nil; gestureStarted = false; moved = false
        groupPosition = Double(groupIndex); profilePosition = Double(selected); onMoving(false)
    }
    private func keyboardBrowse(_ owner: ProviderDialGeometry.Handle, key: KeyEquivalent) -> KeyPress.Result {
        let count = owner == .agent ? kinds.count : providers.count
        guard count > 0 else { return .handled }
        let current = owner == .agent ? groupIndex : selected
        let next = key == .home ? 0 : key == .end ? count - 1 : max(0, min(count - 1, current + (key == .downArrow ? 1 : -1)))
        if owner == .agent { settleAgent(next) } else { settleProfile(next) }
        return .handled
    }
    private func settleAgent(_ index: Int) {
        guard kinds.indices.contains(index) else { onMoving(false); return }
        onMoving(true)
        if kinds[index] != kind { OrbisHaptics.commit(); onKind(kinds[index]) }
        withAnimation(reduced ? nil : InteractionMotion.state) { groupPosition = Double(index) } completion: { onMoving(false) }
    }
    private func settleProfile(_ index: Int) {
        guard providers.indices.contains(index) else { onMoving(false); return }
        onMoving(true)
        let distance = Double(index) - profilePosition
        if Int(profilePosition.rounded()) != index { OrbisHaptics.selectionChanged(); profilePulse += 1 }
        withAnimation(reduced ? nil : InteractionMotion.dialSettle(distance: distance)) { profilePosition = Double(index) } completion: { onSelect(index); onMoving(false) }
    }
    private func adjustAgent(_ direction: AccessibilityAdjustmentDirection) {
        settleAgent(max(0, min(kinds.count - 1, groupIndex + (direction == .increment ? 1 : -1))))
    }
}


struct StatusSection<Content: View>: View {
    @Environment(\.colorScheme) private var scheme
    @AppStorage("orbis.appearance") private var visualStyle = "mist"
    let title: String
    @ViewBuilder var content: Content
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(title).font(.orbisLabel()).foregroundStyle(OrbisPalette(scheme).secondary)
                .padding(.horizontal, 4).accessibilityAddTraits(.isHeader)
            VStack(alignment: .leading, spacing: 0) { content }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 16).padding(.vertical, 4)
                .neuSurface(radius: OrbisRadius.card)
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


/// UIKeyCommand reaches physical keyboards consistently on iOS 17+ even when
/// SwiftUI's decorative dial circles do not become native first responders.
private struct OrbisDialKeyboardBridge: UIViewRepresentable {
    let active: Bool
    @Binding var focus: ProviderDialGeometry.Handle?
    let browse: (ProviderDialGeometry.Handle, KeyEquivalent) -> Void
    func makeUIView(context: Context) -> Receiver { Receiver() }
    func updateUIView(_ view: Receiver, context: Context) {
        view.active = active; view.owner = focus; view.browse = browse
        view.changeFocus = { focus = $0 }
        if active && focus != nil { if !view.isFirstResponder { view.becomeFirstResponder() } }
        else if view.isFirstResponder { view.resignFirstResponder() }
    }
    final class Receiver: UIView {
        var owner: ProviderDialGeometry.Handle?
        var active = false
        override func didMoveToWindow() { super.didMoveToWindow(); if window != nil && active && owner != nil { becomeFirstResponder() } }
        var browse: (ProviderDialGeometry.Handle, KeyEquivalent) -> Void = { _, _ in }
        var changeFocus: (ProviderDialGeometry.Handle?) -> Void = { _ in }
        override var canBecomeFirstResponder: Bool { true }
        override var canBecomeFocused: Bool { active }
        override func didUpdateFocus(in context: UIFocusUpdateContext, with coordinator: UIFocusAnimationCoordinator) {
            super.didUpdateFocus(in: context, with: coordinator)
            if context.nextFocusedView === self { if owner == nil { owner = .profile; changeFocus(.profile) }; becomeFirstResponder() }
        }
        override func pressesBegan(_ presses: Set<UIPress>, with event: UIPressesEvent?) {
            guard let key = presses.compactMap(\.key).first(where: { $0.keyCode != .keyboardLeftShift && $0.keyCode != .keyboardRightShift }), owner != nil else { super.pressesBegan(presses, with: event); return }
            switch key.keyCode {
            case .keyboardUpArrow: up()
            case .keyboardDownArrow: down()
            case .keyboardHome: home()
            case .keyboardEnd: end()
            case .keyboardTab:
                let shift = key.modifierFlags.contains(.shift) || presses.compactMap(\.key).contains { [.keyboardLeftShift, .keyboardRightShift].contains($0.keyCode) }
                if shift, owner == .agent { previous() }
                else if !shift, owner == .profile { nextHandle() }
                else { super.pressesBegan(presses, with: event) }
            default: super.pressesBegan(presses, with: event)
            }
        }
        override var keyCommands: [UIKeyCommand]? {
            var commands = [UIKeyCommand(input: UIKeyCommand.inputUpArrow, modifierFlags: [], action: #selector(up)),
             UIKeyCommand(input: UIKeyCommand.inputDownArrow, modifierFlags: [], action: #selector(down)),
             UIKeyCommand(input: UIKeyCommand.inputHome, modifierFlags: [], action: #selector(home)),
             UIKeyCommand(input: UIKeyCommand.inputEnd, modifierFlags: [], action: #selector(end))]
            if owner == .profile { commands.append(UIKeyCommand(input: "\t", modifierFlags: [], action: #selector(nextHandle))) }
            if owner == .agent { commands.append(UIKeyCommand(input: "\t", modifierFlags: .shift, action: #selector(previous))) }
            return commands.map { command in
                command.wantsPriorityOverSystemBehavior = true; return command
             }
        }
        @objc private func up() { if let owner { browse(owner, .upArrow) } }
        @objc private func down() { if let owner { browse(owner, .downArrow) } }
        @objc private func home() { if let owner { browse(owner, .home) } }
        @objc private func end() {
            if let owner { browse(owner, .end) }
        }
        @objc private func nextHandle() {
            if owner == .profile { owner = .agent; changeFocus(.agent) }
            else { owner = nil; changeFocus(nil); resignFirstResponder() }
        }
        @objc private func previous() {
            if owner == .agent { owner = .profile; changeFocus(.profile) }
            else { owner = nil; changeFocus(nil); resignFirstResponder() }
        }
    }
}
