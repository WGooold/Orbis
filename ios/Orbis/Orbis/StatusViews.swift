import SwiftUI

/// The settings page (formerly the connection status page, ADR-0046 §5): providers first, then the
/// current connection and read-only pairing facts. Computers are switched, added and unpaired from
/// the home row and the drawer's computer menu, not here.
struct ConnectionStatusView: View {
    @EnvironmentObject private var store: OrbisStore
    @Environment(\.colorScheme) private var scheme
    @AppStorage("orbis.visualStyle") private var visualStyle = "classic"
    let onBack: () -> Void
    @EnvironmentObject private var host: HostState
    var body: some View {
        VStack(spacing: 0) {
            OrbisPageHeader(title: L10n.tr("设置"), back: onBack) {
                // Always in the header, so a connection change never inserts or removes page content.
                OrbisIconButton(symbol: "arrow.clockwise", label: L10n.tr("重新连接"), action: store.reconnectSelectedHost)
                    .disabled(store.selectedHost == nil || store.connection == .connecting)
            }
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    StatusSection(title: L10n.tr("Agent 供应商")) {
                        ForEach(["pi", "codex", "claude", "dsh"], id: \.self) { kind in
                            AgentStatusProviderCard(kind: kind)
                        }
                    }
                    StatusSection(title: L10n.tr("当前连接")) {
                        StatusRow(label: L10n.tr("连接状态"), value: store.connection == .secured ? L10n.tr("已连接") : connectionTitle(store.connection),
                                  tone: store.connection == .secured ? OrbisPalette(scheme).success : store.connection == .error ? OrbisPalette(scheme).error : OrbisPalette(scheme).warning)
                        StatusRow(label: L10n.tr("连接方式"), value: pathTitle(store.activePath),
                                  tone: store.activePath == "lan" ? OrbisPalette(scheme).success : OrbisPalette(scheme).secondary)
                        StatusRow(label: L10n.tr("连接协议"), value: connectionProtocolText(store.relayTransportKind, path: store.activePath, connected: store.connection == .secured), tone: OrbisPalette(scheme).secondary)
                        Text(L10n.tr("协议模式")).font(.orbisBody())
                        HStack(spacing: 10) {
                            ForEach([
                                (RelayTransportMode.auto, L10n.tr("自动")),
                                (.ws, "WS"),
                                (.quic, "QUIC"),
                            ], id: \.0.rawValue) { mode, title in
                                let selected = store.relayTransportMode == mode
                                OrbisMotionButton { store.setRelayTransportMode(mode) } label: {
                                    HStack(spacing: 5) {
                                        if selected { Image(systemName: "checkmark").accessibilityHidden(true) }
                                        Text(title).lineLimit(1)
                                    }
                                    .font(.orbisLabel(.semibold))
                                    .foregroundStyle(selected ? OrbisPalette(scheme).accent : OrbisPalette(scheme).secondary)
                                    .frame(maxWidth: .infinity, minHeight: 48)
                                }
                                .buttonStyle(NeuButtonStyle(selected: selected))
                                .disabled(store.selectedHost == nil)
                                .accessibilityIdentifier("relay-mode-\(mode.rawValue)")
                                .accessibilityAddTraits(selected ? .isSelected : [])
                            }
                        }
                        Text(relayTransportModeDescription(store.relayTransportMode))
                            .font(.orbisCaption()).foregroundStyle(OrbisPalette(scheme).secondary)
                            .fixedSize(horizontal: false, vertical: true)
                        StatusRow(label: L10n.tr("连接延迟"), value: connectionLatencyText(store.pathRTT, connected: store.connection == .secured), tone: OrbisPalette(scheme).secondary)
                        StatusRow(label: L10n.tr("端到端加密"), value: store.connection == .secured ? L10n.tr("已启用") : L10n.tr("未建立"),
                                  tone: store.connection == .secured ? OrbisPalette(scheme).success : OrbisPalette(scheme).secondary)
                    }
                    StatusSection(title: L10n.tr("配对信息")) {
                        StatusRow(label: L10n.tr("电脑"), value: store.selectedHost?.hostName ?? L10n.tr("已配对的电脑"))
                        StatusRow(label: L10n.tr("配对状态"), value: store.selectedHost == nil ? L10n.tr("未配对") : L10n.tr("已配对"),
                                  tone: store.selectedHost == nil ? OrbisPalette(scheme).error : OrbisPalette(scheme).success)
                    }
                    StatusSection(title: L10n.tr("外观")) {
                        HStack(spacing: 10) {
                            appearanceChoice(L10n.tr("经典"), value: "classic")
                            appearanceChoice(L10n.tr("雾蓝"), value: "insetFocus")
                        }
                    }
                    StatusSection(title: L10n.tr("语言")) {
                        ForEach(AppLanguage.allCases, id: \.rawValue) { choice in
                            languageChoice(choice)
                        }
                    }
                }.padding(.horizontal, 20).padding(.vertical, 16)
            }.accessibilityIdentifier("settings-page")
        }.background(OrbisPalette(scheme).base.ignoresSafeArea())
            .onAppear { host.loadProviders("codex") }
}

    private func appearanceChoice(_ title: String, value: String) -> some View {
        let selected = visualStyle == value
        let palette = OrbisPalette(scheme)
        return OrbisMotionButton { visualStyle = value } label: {
            HStack(spacing: 6) {
                if selected { Image(systemName: "checkmark").accessibilityHidden(true) }
                Text(title).lineLimit(1)
            }
            .font(.orbisLabel(.semibold))
            .foregroundStyle(selected ? palette.accent : palette.secondary)
            .frame(maxWidth: .infinity, minHeight: 56)
            .contentShape(Rectangle())
        }
        .buttonStyle(NeuButtonStyle(selected: selected))
        .accessibilityIdentifier("appearance-\(value)")
        .accessibilityAddTraits(selected ? .isSelected : [])
    }

    private func languageChoice(_ choice: AppLanguage) -> some View {
        let selected = AppLocalization.shared.preference == choice
        let title = choice == .system ? L10n.tr("跟随系统") : choice == .chinese ? "简体中文" : "English"
        let palette = OrbisPalette(scheme)
        return OrbisMotionButton { AppLocalization.shared.select(choice) } label: {
            HStack(spacing: 12) {
                Text(title).fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 12)
                Image(systemName: selected ? "checkmark.circle.fill" : "circle")
                    .accessibilityHidden(true)
            }
            .font(.orbisBody(.medium))
            .foregroundStyle(selected ? palette.accent : palette.text)
            .frame(maxWidth: .infinity, minHeight: 56, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(NeuButtonStyle(selected: selected))
        .accessibilityIdentifier("language-\(choice.rawValue)")
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}

private struct AgentStatusProviderCard: View {
    @EnvironmentObject private var host: HostState
    @EnvironmentObject private var overlay: OrbisOverlay
    @Environment(\.colorScheme) private var scheme
    @AppStorage("orbis.visualStyle") private var visualStyle = "classic"
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
    @AppStorage("orbis.visualStyle") private var visualStyle = "classic"
    @State private var selected: Set<AgentProvider> = []
    @State private var selecting = false
    let onBack: () -> Void
    private var removable: Set<AgentProvider> { Set(host.providers.filter(\.removable)) }
    private var effectiveSelection: Set<AgentProvider> { selected.intersection(removable) }
    var body: some View {
        VStack(spacing: 0) {
            OrbisHeader {
                OrbisIconButton(symbol: selecting ? "xmark" : "arrow.left", label: selecting ? L10n.tr("退出多选") : L10n.tr("返回"), morphFrom: "arrow.left") {
                    if selecting { exitSelection() } else { onBack() }
                }
            } title: {
                OrbisMotionText(selecting ? L10n.tr("已选择 {0} 项", effectiveSelection.count) : L10n.tr("供应商"))
                    .font(.orbisTitle()).lineLimit(1).accessibilityAddTraits(.isHeader)
            } trailing: {
                OrbisSelectionToolbar(selecting: selecting) { _ in
                    OrbisIconButton(symbol: "arrow.clockwise", label: L10n.tr("刷新供应商")) { exitSelection(); host.loadProviders(host.providerKind) }
                        .disabled(host.providersLoading || host.changingProvider || !host.connected)
                } selected: {
                    OrbisIconButton(symbol: "trash", label: L10n.tr("移除所选供应商"), tint: OrbisPalette(scheme).error, action: confirmRemoval)
                        .disabled(!host.canChangeProvider || effectiveSelection.isEmpty)
                }
            }
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    Text(store.selectedHost?.hostName ?? L10n.tr("已配对的电脑")).font(.orbisBody(.medium))
                    LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 10) {
                        ForEach(["pi", "codex", "claude", "dsh"], id: \.self) { kind in
                            OrbisMotionButton { exitSelection(); overlay.dismissDialog(); host.loadProviders(kind) } label: {
                                HStack(spacing: 6) {
                                    AgentEmblem(kind: kind, size: 22, recessed: false)
                                    Text(agentTitle(kind)).font(.orbisLabel(.semibold))
                                }.frame(maxWidth: .infinity, minHeight: 48)
                            }.buttonStyle(NeuButtonStyle(selected: host.providerKind == kind))
                                .disabled(host.providersLoading || host.changingProvider)
                                .accessibilityLabel(L10n.tr("{0}供应商", agentTitle(kind))).accessibilityAddTraits(host.providerKind == kind ? .isSelected : [])
                        }
                    }
                    ProgressView().progressViewStyle(.linear)
                        .opacity(host.providersLoading || host.changingProvider ? 1 : 0)
                        .accessibilityHidden(!(host.providersLoading || host.changingProvider))
                        .accessibilityLabel(host.changingProvider ? L10n.tr("正在更新供应商") : L10n.tr("正在读取供应商"))
                    if let problem = host.providerCatalogProblem, !host.providersLoading { OrbisNotice(text: problem, error: host.connected) }
                    if let notice = host.providerNotice { OrbisNotice(text: notice) }
                    if host.providerSummary?["switching"].bool == true { OrbisNotice(text: L10n.tr("电脑正在切换供应商，请等待完成后再操作。")) }
                    if !host.providersLoading && host.providerCatalogProblem == nil && host.providers.isEmpty {
                        OrbisEmptyState(symbol: "shippingbox", title: L10n.tr("还没有供应商"))
                    }
                    if !removable.isEmpty {
                        Text(selecting ? L10n.tr("轻点卡片选择，完成后点击右上角移除") : L10n.tr("长按已启用的供应商可多选移除"))
                            .font(.orbisCaption()).foregroundStyle(OrbisPalette(scheme).secondary).lineLimit(1)
                    }
                    ForEach(host.providers) { provider in providerRow(provider) }
                }.padding(20)
            }
        }.background(OrbisPalette(scheme).base.ignoresSafeArea())
            .onAppear { host.loadProviders(host.providerKind) }
            .orbisBackPriority("provider-selection", active: selecting, action: exitSelection)
            .onChange(of: host.hostKey) { _, _ in exitSelection(); overlay.dismissDialog() }
            .onChange(of: host.providerKind) { _, _ in exitSelection(); overlay.dismissDialog() }
            .onChange(of: host.connected) { _, connected in
                if !connected { exitSelection(); overlay.dismissDialog() }
            }
            .onChange(of: removable) { _, values in
                selected.formIntersection(values)
                if values.isEmpty { exitSelection() }
            }
    }

    private func exitSelection() { selecting = false; selected = [] }

    private func select(_ provider: AgentProvider) {
        guard host.canChangeProvider, provider.removable else { return }
        if !selected.contains(provider) { OrbisHaptics.beginSelection() }
        selecting = true; selected.insert(provider)
    }

    private func providerRow(_ provider: AgentProvider) -> some View {
        let hasQuota = provider.enabled && provider.subscriptionSupported
        let ownQuota = host.quotaProviderId == provider.id
        let quota = ownQuota ? host.quota : nil
        let loading = ownQuota && host.queryingQuota
        let palette = OrbisPalette(scheme)
        return HStack(spacing: 0) {
            OrbisMotionButton {
                if selecting {
                    guard host.canChangeProvider, provider.removable else { return }
                    OrbisHaptics.selectionChanged()
                    if !selected.insert(provider).inserted { selected.remove(provider) }
                } else if hasQuota, let key = host.hostKey {
                    host.querySubscription(provider, expectedHostKey: key)
                }
            } label: {
                VStack(alignment: .leading, spacing: 18) {
                    HStack(spacing: 12) {
                        if provider.official {
                            AgentEmblem(kind: provider.kind, size: 32, recessed: false).accessibilityHidden(true)
                        }
                        VStack(alignment: .leading, spacing: 5) {
                            Text(provider.name).font(.orbisBody(.semibold)).foregroundStyle(palette.text)
                            Text((provider.official ? L10n.tr("官方 · ") : "") + (provider.enabled ? (provider.additive ? L10n.tr("已启用") : L10n.tr("当前使用")) : L10n.tr("未启用")))
                                .font(.orbisCaption()).foregroundStyle(provider.enabled ? palette.success : palette.secondary)
                        }.frame(maxWidth: .infinity, alignment: .leading)
                        if hasQuota {
                            OrbisActionSymbol(systemName: "arrow.clockwise").font(.orbisBody(.medium))
                                .foregroundStyle(palette.secondary).accessibilityHidden(true)
                        } else {
                            OrbisSelectionIndicator(selected: effectiveSelection.contains(provider), selecting: selecting && provider.removable)
                        }
                    }
                    if hasQuota {
                        HStack(alignment: .top, spacing: 16) {
                            ForEach(["five_hour", "seven_day"], id: \.self) { name in
                                SubscriptionQuotaRing(name: name, window: quota?.windows.first { $0.name == name },
                                                      loading: loading, tint: palette.agent(provider.kind))
                            }
                        }.padding(.vertical, 2)
                        if ownQuota, let error = host.quotaError {
                            Text(error).font(.orbisCaption()).foregroundStyle(palette.error).fixedSize(horizontal: false, vertical: true)
                        }
                    }
                }.padding(18).frame(maxWidth: .infinity, alignment: .leading)
            }.buttonStyle(OrbisSelectionButtonStyle(selected: effectiveSelection.contains(provider), selecting: selecting))
                .highPriorityGesture(LongPressGesture().onEnded { _ in select(provider) })
                .accessibilityIdentifier("provider-card-\(provider.id)")
                .accessibilityAddTraits(effectiveSelection.contains(provider) ? .isSelected : [])
                .accessibilityHint(hasQuota ? (loading ? L10n.tr("正在查询") : L10n.tr("轻点查询当前订阅剩余配额")) : provider.removable ? (selecting ? L10n.tr("轻点切换选择") : L10n.tr("长按进入多选移除")) : "")
                .accessibilityAction(named: L10n.tr("选择供应商")) { select(provider) }
            if !provider.enabled {
                OrbisTextButton(title: L10n.tr("启用"), tint: palette.accent) {
                    if let key = host.hostKey { confirm(provider, hostKey: key) }
                }.disabled(!host.canChangeProvider || selecting).accessibilityIdentifier("provider-action-\(provider.id)")
                    .frame(width: 64, height: 48)
            }
        }
    }

    private func confirm(_ provider: AgentProvider, hostKey: String) {
        overlay.showDialog(L10n.tr("启用供应商"), message: provider.confirmation, actions: [
            OrbisDialogAction(title: L10n.tr("取消"), role: .cancel),
            OrbisDialogAction(title: L10n.tr("确认")) { host.changeProvider(provider, expectedHostKey: hostKey) }
        ])
    }

    private func confirmRemoval() {
        guard host.canChangeProvider, let key = host.hostKey else { return }
        let providers = host.providers.filter { effectiveSelection.contains($0) }
        guard !providers.isEmpty else { return }
        let message = providers.map(\.name).joined(separator: "\n") + L10n.tr("\n从 Pi 配置移除；Host 中的卡片和配置仍保留。") +
            (providers.contains(where: \.globalDefault) ? L10n.tr("\n包含 Pi 的全局默认供应商，移除后请在 Pi 中重新选择模型。") : "")
        overlay.showDialog(L10n.tr("移除 {0} 个供应商？", providers.count), message: message, actions: [
            OrbisDialogAction(title: L10n.tr("取消"), role: .cancel),
            OrbisDialogAction(title: L10n.tr("移除 {0} 项", providers.count), role: .destructive) {
                host.removeProviders(providers, expectedHostKey: key); exitSelection()
            }
        ])
    }
}


/// One coin, two quota windows. Card refresh and coin flip remain separate actions.
private struct SubscriptionQuotaCoin: View {
    @Environment(\.colorScheme) private var scheme
    @AppStorage("orbis.visualStyle") private var visualStyle = "classic"
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
    @AppStorage("orbis.visualStyle") private var visualStyle = "classic"
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
    @AppStorage("orbis.visualStyle") private var visualStyle = "classic"
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
    @AppStorage("orbis.visualStyle") private var visualStyle = "classic"
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
    @AppStorage("orbis.visualStyle") private var visualStyle = "classic"
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
