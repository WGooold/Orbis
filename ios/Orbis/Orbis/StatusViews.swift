import SwiftUI

struct ConnectionStatusView: View {
    @EnvironmentObject private var store: OrbisStore
    @Environment(\.colorScheme) private var scheme
    let onBack: () -> Void
    let onSettings: () -> Void
    @EnvironmentObject private var host: HostState
    var body: some View {
        VStack(spacing: 0) {
            OrbisPageHeader(title: "连接状态", back: onBack) {
                // Always in the header, so a connection change never inserts or removes page content.
                OrbisIconButton(symbol: "arrow.clockwise", label: "重新连接", action: store.reconnectSelectedHost)
                    .disabled(store.selectedHost == nil || store.connection == .connecting)
                OrbisIconButton(symbol: "gearshape", label: "设置", action: onSettings)
            }
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    if store.hosts.count > 1 {
                        StatusSection(title: "已配对电脑") {
                            ForEach(store.hosts) { computer in
                                Button { store.connect(hostId: computer.hostId) } label: {
                                    HStack {
                                        Text(computer.name).font(.orbisBody(.semibold))
                                        Spacer()
                                        Text(connectionTitle(computer.connectionState)).font(.orbisCaption())
                                        if computer.hostId == store.selectedHostId { Image(systemName: "checkmark") }
                                    }.frame(minHeight: 44)
                                }.buttonStyle(.plain)
                            }
                        }
                    }
                    StatusSection(title: "当前连接") {
                        StatusRow(label: "连接状态", value: store.connection == .secured ? "已连接" : connectionTitle(store.connection),
                                  tone: store.connection == .secured ? OrbisPalette(scheme).success : store.connection == .error ? OrbisPalette(scheme).error : OrbisPalette(scheme).warning)
                        StatusRow(label: "连接方式", value: pathTitle(store.activePath),
                                  tone: ["lan", "p2p"].contains(store.activePath ?? "") ? OrbisPalette(scheme).success : OrbisPalette(scheme).secondary)
                        StatusRow(label: "端到端加密", value: store.connection == .secured ? "已启用" : "未建立",
                                  tone: store.connection == .secured ? OrbisPalette(scheme).success : OrbisPalette(scheme).secondary)
                    }
                    StatusSection(title: "Agent 供应商") {
                        ForEach(["pi", "codex", "claude", "dsh"], id: \.self) { kind in
                            AgentStatusProviderCard(kind: kind)
                        }
                    }
                    StatusSection(title: "配对信息") {
                        StatusRow(label: "电脑", value: store.selectedHost?.hostName ?? "已配对的电脑")
                        StatusRow(label: "配对状态", value: store.selectedHost == nil ? "未配对" : "已配对",
                                  tone: store.selectedHost == nil ? OrbisPalette(scheme).error : OrbisPalette(scheme).success)
                    }
                }.padding(.horizontal, 20).padding(.vertical, 16)
            }
        }.background(OrbisPalette(scheme).base.ignoresSafeArea())
            .onAppear { host.loadProviders("codex") }
}
}

private struct AgentStatusProviderCard: View {
    @EnvironmentObject private var host: HostState
    @EnvironmentObject private var overlay: OrbisOverlay
    @Environment(\.colorScheme) private var scheme
    @State private var switchAnchor = OrbisAnchor()
    let kind: String
    private var providers: [AgentProvider] { host.providers(for: kind) }
    private var current: AgentProvider? { host.currentProvider(for: kind) }
    private var quotaSnapshot: ProviderQuotaSnapshot? { host.subscriptionQuota(for: kind) }
    private var quota: SubscriptionQuota? { quotaSnapshot?.quota }
    private var loading: Bool { current?.id == host.quotaProviderId && host.quotaKind == kind && host.queryingQuota }
    var body: some View {
        let palette = OrbisPalette(scheme)
        let expectedHost = host.hostKey
        ZStack(alignment: .topTrailing) {
            Button {
                if let current, let expectedHost { host.querySubscription(current, expectedHostKey: expectedHost) }
            } label: {
                VStack(alignment: .leading, spacing: 10) {
                    HStack(spacing: 12) {
                        if current?.subscriptionSupported == true {
                            Color.clear.frame(width: 64, height: 56)
                        } else {
                            AgentEmblem(kind: kind, size: 32, recessed: false).accessibilityHidden(true)
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
                                        .foregroundStyle(palette.agent(kind)).accessibilityLabel("官方供应商")
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
                .accessibilityHint(current?.subscriptionSupported == true ? "查询或刷新订阅剩余配额" : "")
                .accessibilityValue(loading ? "正在查询配额" : quota?.windows.map { window in
                    window.title + " " + (window.remainingPercent.map { String(format: "%.0f%%", $0) } ?? "暂不可用")
                }.joined(separator: "，") ?? "")
            if let current, current.subscriptionSupported {
                HStack {
                    SubscriptionQuotaCoin(kind: kind, quota: quota, loading: loading,
                                          enabled: host.canChangeProvider(for: kind), tint: palette.agent(kind)) {
                        if let expectedHost { host.querySubscription(current, expectedHostKey: expectedHost) }
                    }.id("\(expectedHost ?? "")-\(kind)-\(current.id)")
                    Spacer(minLength: 0)
                }.padding(16)
            }
            Button {
                let items = providers.map { provider in
                    OrbisMenuItem(title: provider.name, symbol: provider.official ? "checkmark.seal" : "server.rack",
                                  checked: provider.enabled, disabled: provider.enabled && !provider.additive) {
                        if !provider.enabled || provider.additive, let expectedHost { host.changeProvider(provider, expectedHostKey: expectedHost) }
                    }
                }
                overlay.showMenu(items, from: switchAnchor.frame)
            } label: {
                Label("切换", systemImage: "arrow.triangle.2.circlepath")
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
}

private struct ProviderQuotaCardButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label.opacity(configuration.isPressed ? 0.72 : 1)
    }
}

struct SettingsView: View {
    @EnvironmentObject private var store: OrbisStore
    @Environment(\.colorScheme) private var scheme
    let onBack: () -> Void
    var body: some View {
        VStack(spacing: 0) {
            OrbisPageHeader(title: "设置", back: onBack) { EmptyView() }
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    VStack(alignment: .leading, spacing: 12) {
                        Text("连接优先级").font(.orbisLabel(.semibold)).foregroundStyle(OrbisPalette(scheme).secondary)
                            .padding(.horizontal, 4).accessibilityAddTraits(.isHeader)
                        ForEach(Array(store.pathPreference.enumerated()), id: \.element) { index, kind in
                            HStack(spacing: 0) {
                                VStack(alignment: .leading, spacing: 4) {
                                    Text("第 \(index + 1) 优先").font(.orbisCaption()).foregroundStyle(OrbisPalette(scheme).secondary)
                                    Text(priorityPathTitle(kind)).font(.orbisBody()).frame(maxWidth: .infinity, alignment: .leading)
                                }.padding(.leading, 4)
                                OrbisIconButton(symbol: "arrow.up", label: "上移\(priorityPathTitle(kind))", compact: true) { move(index, to: index - 1) }
                                    .disabled(index == 0)
                                OrbisIconButton(symbol: "arrow.down", label: "下移\(priorityPathTitle(kind))", compact: true) { move(index, to: index + 1) }
                                    .disabled(index == store.pathPreference.count - 1)
                            }.frame(minHeight: 60).accessibilityElement(children: .contain).accessibilityIdentifier("path-priority-\(kind)")
                        }
                    }
                }.padding(.horizontal, 20).padding(.vertical, 16)
            }
        }.background(OrbisPalette(scheme).base.ignoresSafeArea())
    }
    private func priorityPathTitle(_ kind: String) -> String {
        switch kind { case "lan": return "局域网"; case "p2p": return "P2P 直连"; default: return "中继" }
    }
    private func move(_ from: Int, to: Int) {
        guard store.pathPreference.indices.contains(to) else { return }
        var order = store.pathPreference
        order.insert(order.remove(at: from), at: to)
        store.setPathPreference(order)
    }
}

struct AgentProvidersView: View {
    @EnvironmentObject private var store: OrbisStore
    @EnvironmentObject private var host: HostState
    @EnvironmentObject private var overlay: OrbisOverlay
    @Environment(\.colorScheme) private var scheme
    @State private var selected: Set<AgentProvider> = []
    @State private var selecting = false
    let onBack: () -> Void
    private var removable: Set<AgentProvider> { Set(host.providers.filter(\.removable)) }
    private var effectiveSelection: Set<AgentProvider> { selected.intersection(removable) }
    var body: some View {
        VStack(spacing: 0) {
            OrbisHeader {
                OrbisIconButton(symbol: selecting ? "xmark" : "arrow.left", label: selecting ? "退出多选" : "返回") {
                    if selecting { exitSelection() } else { onBack() }
                }
            } title: {
                Text(selecting ? "已选择 \(effectiveSelection.count) 项" : "供应商")
                    .font(.orbisTitle()).lineLimit(1).accessibilityAddTraits(.isHeader)
            } trailing: {
                if selecting {
                    OrbisIconButton(symbol: "trash", label: "移除所选供应商", tint: OrbisPalette(scheme).error, action: confirmRemoval)
                        .disabled(!host.canChangeProvider || effectiveSelection.isEmpty)
                } else {
                    OrbisIconButton(symbol: "arrow.clockwise", label: "刷新供应商") { exitSelection(); host.loadProviders(host.providerKind) }
                        .disabled(host.providersLoading || host.changingProvider || !host.connected)
                }
            }
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    Text(store.selectedHost?.hostName ?? "已配对的电脑").font(.orbisBody(.medium))
                    LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 10) {
                        ForEach(["pi", "codex", "claude", "dsh"], id: \.self) { kind in
                            Button { exitSelection(); overlay.dismissDialog(); host.loadProviders(kind) } label: {
                                HStack(spacing: 6) {
                                    AgentEmblem(kind: kind, size: 22, recessed: false)
                                    Text(agentTitle(kind)).font(.orbisLabel(.semibold))
                                }.frame(maxWidth: .infinity, minHeight: 48)
                            }.buttonStyle(NeuButtonStyle(selected: host.providerKind == kind))
                                .disabled(host.providersLoading || host.changingProvider)
                                .accessibilityLabel("\(agentTitle(kind))供应商").accessibilityAddTraits(host.providerKind == kind ? .isSelected : [])
                        }
                    }
                    ProgressView().progressViewStyle(.linear)
                        .opacity(host.providersLoading || host.changingProvider ? 1 : 0)
                        .accessibilityHidden(!(host.providersLoading || host.changingProvider))
                        .accessibilityLabel(host.changingProvider ? "正在更新供应商" : "正在读取供应商")
                    if let problem = host.providerCatalogProblem, !host.providersLoading { OrbisNotice(text: problem, error: host.connected) }
                    if let notice = host.providerNotice { OrbisNotice(text: notice) }
                    if host.providerSummary?["switching"].bool == true { OrbisNotice(text: "电脑正在切换供应商，请等待完成后再操作。") }
                    if !host.providersLoading && host.providerCatalogProblem == nil && host.providers.isEmpty {
                        OrbisEmptyState(symbol: "shippingbox", title: "还没有供应商")
                    }
                    if !removable.isEmpty {
                        Text(selecting ? "轻点卡片选择，完成后点击右上角移除" : "长按已启用的供应商可多选移除")
                            .font(.orbisCaption()).foregroundStyle(OrbisPalette(scheme).secondary).lineLimit(1)
                    }
                    ForEach(host.providers) { provider in providerRow(provider) }
                }.padding(20)
            }
        }.background(OrbisPalette(scheme).base.ignoresSafeArea())
            .onAppear { host.loadProviders(host.providerKind) }
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
        if !selecting { OrbisHaptics.beginSelection() }
        selecting = true; selected.insert(provider)
    }

    private func providerRow(_ provider: AgentProvider) -> some View {
        let hasQuota = provider.enabled && provider.subscriptionSupported
        let ownQuota = host.quotaProviderId == provider.id
        let quota = ownQuota ? host.quota : nil
        let loading = ownQuota && host.queryingQuota
        let palette = OrbisPalette(scheme)
        return HStack(spacing: 0) {
            Button {
                if selecting {
                    guard host.canChangeProvider, provider.removable else { return }
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
                            Text((provider.official ? "官方 · " : "") + (provider.enabled ? (provider.additive ? "已启用" : "当前使用") : "未启用"))
                                .font(.orbisCaption()).foregroundStyle(provider.enabled ? palette.success : palette.secondary)
                        }.frame(maxWidth: .infinity, alignment: .leading)
                        if hasQuota {
                            Image(systemName: "arrow.clockwise").font(.orbisBody(.medium))
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
                .accessibilityHint(hasQuota ? (loading ? "正在查询" : "轻点查询当前订阅剩余配额") : provider.removable ? (selecting ? "轻点切换选择" : "长按进入多选移除") : "")
                .accessibilityAction(named: "选择供应商") { select(provider) }
            if !provider.enabled {
                OrbisTextButton(title: "启用", tint: palette.accent) {
                    if let key = host.hostKey { confirm(provider, hostKey: key) }
                }.disabled(!host.canChangeProvider || selecting).accessibilityIdentifier("provider-action-\(provider.id)")
                    .frame(width: 64, height: 48)
            }
        }
    }

    private func confirm(_ provider: AgentProvider, hostKey: String) {
        overlay.showDialog("启用供应商", message: provider.confirmation, actions: [
            OrbisDialogAction(title: "取消", role: .cancel),
            OrbisDialogAction(title: "确认") { host.changeProvider(provider, expectedHostKey: hostKey) }
        ])
    }

    private func confirmRemoval() {
        guard host.canChangeProvider, let key = host.hostKey else { return }
        let providers = host.providers.filter { effectiveSelection.contains($0) }
        guard !providers.isEmpty else { return }
        let message = providers.map(\.name).joined(separator: "\n") + "\n从 Pi 配置移除；Host 中的卡片和配置仍保留。" +
            (providers.contains(where: \.globalDefault) ? "\n包含 Pi 的全局默认供应商，移除后请在 Pi 中重新选择模型。" : "")
        overlay.showDialog("移除 \(providers.count) 个供应商？", message: message, actions: [
            OrbisDialogAction(title: "取消", role: .cancel),
            OrbisDialogAction(title: "移除 \(providers.count) 项", role: .destructive) {
                host.removeProviders(providers, expectedHostKey: key); exitSelection()
            }
        ])
    }
}


/// One coin, two quota windows. Card refresh and coin flip remain separate actions.
private struct SubscriptionQuotaCoin: View {
    @Environment(\.colorScheme) private var scheme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var weekly = false
    @State private var angle: Double = 0
    @State private var demonstrated = false
    @State private var flipTask: Task<Void, Never>?
    @State private var progress: CGFloat = 0
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
        let title = weekly ? "周配额" : "5 小时配额"
        let status: String
        if let remaining { status = "剩余 " + String(format: "%.0f%%", remaining) }
        else { status = loading ? "查询中" : hasReadings ? "暂不可用" : "待查询" }
        return title + "，" + status
    }
    private var spokenHint: String {
        let action = hasReadings ? "轻点翻面查看" + (weekly ? "5 小时配额" : "周配额") : "查询订阅配额"
        guard let reset = window?.resetsAt else { return action }
        return action + "，重置 " + Date(timeIntervalSince1970: Double(reset) / 1000).formatted(date: .abbreviated, time: .shortened)
    }
    private var coinButton: some View {
        Button(action: tapCoin) { coinFace }
            .buttonStyle(ProviderInlineButtonStyle()).disabled(!enabled || loading)
            .accessibilityLabel("\(agentTitle(kind)) 配额")
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
            .task(id: "\(loading)-\(weekly)-\(remaining ?? -1)") { updateProgress() }
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
                        SubscriptionQuotaArc(progress: progress)
                            .stroke(LinearGradient(colors: [color.opacity(0.4), color], startPoint: .topLeading, endPoint: .bottomTrailing),
                                    style: StrokeStyle(lineWidth: 2.5, lineCap: .round))
                    }
                    AgentEmblem(kind: kind, size: 26, recessed: false)
                }.frame(width: 44, height: 44)
                    .modifier(QuotaCoinTilt(angle: angle, palette: palette, tint: tint))
                    .frame(maxWidth: .infinity, alignment: .leading)
                VStack(alignment: .trailing) {
                    Text(weekly ? "周" : "5h").foregroundStyle(palette.secondary)
                    Spacer(minLength: 0)
                    Text(remaining.map { String(format: "%.0f%%", $0) } ?? "—")
                        .foregroundStyle(remaining == nil ? palette.secondary : color).monospacedDigit()
                }.font(.orbisCaption(.medium)).frame(maxWidth: .infinity, alignment: .trailing)
                    .opacity(1 - 0.55 * abs(sin(angle * .pi / 180)))
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
        let fraction = (remaining ?? 0.0) / 100.0
        let target = CGFloat(min(max(fraction, 0.0), 1.0))
        let animation: Animation? = reduceMotion ? nil : .easeOut(duration: 0.7)
        withAnimation(animation) { progress = target }
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
        angle = 0
    }
    @MainActor private func flip() async {
        guard !Task.isCancelled else { return }
        guard !reduceMotion else { weekly.toggle(); return }
        withAnimation(.timingCurve(0.42, 0, 0.75, 0.45, duration: 0.22)) { angle = 90 }
        do { try await Task.sleep(for: .milliseconds(220)) } catch { return }
        guard !Task.isCancelled else { return }
        var transaction = Transaction(); transaction.disablesAnimations = true
        withTransaction(transaction) { weekly.toggle() }
        withAnimation(.timingCurve(0.16, 0.75, 0.25, 1, duration: 0.34)) { angle = 180 }
        do { try await Task.sleep(for: .milliseconds(340)) } catch { return }
        guard !Task.isCancelled else { return }
        withTransaction(transaction) { angle = 0 }
    }
}

/// The medallion turns about its own diagonal axis; labels and hit geometry stay still.
/// Interpolating the angle here also updates extrusion and light on every rendered frame.
private struct QuotaCoinTilt: AnimatableModifier {
    var angle: Double
    let palette: OrbisPalette
    let tint: Color
    var animatableData: Double { get { angle } set { angle = newValue } }
    private var lift: Double { abs(sin(angle * .pi / 180)) }
    private var faceAngle: Double { angle > 90 ? angle - 180 : angle }
    private var axis: (x: CGFloat, y: CGFloat, z: CGFloat) { (-0.4067, 0.9135, 0) }
    func body(content: Content) -> some View {
        ZStack {
            Ellipse().fill(RadialGradient(colors: [palette.scrim.opacity(0.22), .clear],
                                         center: .center, startRadius: 0, endRadius: 18))
                .frame(width: 36, height: 10).offset(x: 2, y: 22)
                .opacity(lift).scaleEffect(x: 1 - 0.15 * lift, y: 1)
            ZStack {
                // At 90° the faces become lines; this solid rim preserves physical thickness.
                Capsule().fill(LinearGradient(colors: [tint.opacity(0.85), palette.shadow],
                                               startPoint: .leading, endPoint: .trailing))
                    .frame(width: 3.2 * lift, height: 41)
                    .rotationEffect(.degrees(24)).offset(x: 1.1 * lift, y: 0.49 * lift)
                    .opacity(lift * lift * lift)
                // Three bounded layers form the visible edge even at the side-on angle.
                ForEach((1...3).reversed(), id: \.self) { layer in
                    Circle().fill(LinearGradient(colors: [tint.opacity(0.6), palette.shadow],
                                                 startPoint: .topLeading, endPoint: .bottomTrailing))
                        .frame(width: 41, height: 41)
                        .rotation3DEffect(.degrees(faceAngle), axis: axis, perspective: 0.36)
                        .offset(x: CGFloat(layer) * 0.9 * lift, y: CGFloat(layer) * 0.4 * lift)
                        .opacity(lift)
                }
                content
                    .background(Circle().fill(LinearGradient(colors: [palette.top, palette.base, palette.well],
                                                              startPoint: .topLeading, endPoint: .bottomTrailing)).padding(3))
                    .overlay {
                        Circle().stroke(LinearGradient(colors: [palette.light.opacity(0.65), .clear, tint.opacity(0.12)],
                                                       startPoint: .topLeading, endPoint: .bottomTrailing), lineWidth: 0.7).padding(3)
                        Circle().fill(LinearGradient(stops: [.init(color: .clear, location: 0.2),
                                                            .init(color: (palette.dark ? palette.text : palette.light).opacity(0.48), location: 0.48),
                                                            .init(color: .clear, location: 0.7)],
                                                     startPoint: UnitPoint(x: -0.8 + lift, y: 0),
                                                     endPoint: UnitPoint(x: 0.4 + lift, y: 1)))
                            .padding(3).opacity(lift)
                    }
                    .rotation3DEffect(.degrees(faceAngle), axis: axis, perspective: 0.36)
            }.rotationEffect(.degrees(4 * lift)).scaleEffect(1 + 0.035 * lift)
                .offset(x: -lift, y: -2 * lift)
        }.frame(width: 44, height: 44)
    }
}

private struct SubscriptionQuotaRing: View {
    @Environment(\.colorScheme) private var scheme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var progress: CGFloat = 0
    let name: String
    let window: SubscriptionQuota.Window?
    let loading: Bool
    let tint: Color
    private var title: String { name == "five_hour" ? "5 小时配额" : "周配额" }
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
            Text(name == "five_hour" ? "5h" : "周")
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
        .accessibilityValue(remaining.map { "剩余 " + String(format: "%.1f", $0) + "%" } ?? (loading ? "查询中" : window == nil ? "待查询" : "暂不可用"))
        .accessibilityHint(window?.resetsAt.map { "重置 " + Date(timeIntervalSince1970: Double($0) / 1000).formatted(date: .abbreviated, time: .shortened) } ?? "")
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
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
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
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .opacity(enabled ? (configuration.isPressed ? 0.55 : 1) : 0.4)
            .scaleEffect(configuration.isPressed && !reduceMotion ? 0.96 : 1)
            .animation(reduceMotion ? nil : .easeOut(duration: 0.16), value: configuration.isPressed)
    }
}

struct StatusSection<Content: View>: View {
    @Environment(\.colorScheme) private var scheme
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
    let label: String
    let value: String
    var tone: Color? = nil
    var body: some View {
        HStack(spacing: 12) {
            Text(label).font(.orbisBody()).frame(maxWidth: .infinity, alignment: .leading)
            HStack(spacing: 6) {
                if let tone { Circle().fill(tone).frame(width: 7, height: 7) }
                Text(value).font(.orbisLabel(.medium)).lineLimit(1)
                    .foregroundStyle(tone ?? OrbisPalette(scheme).text).textSelection(.enabled)
            }.padding(.horizontal, tone == nil ? 0 : 10).frame(minHeight: 30)
                .background { if tone != nil { Capsule().fill(OrbisPalette(scheme).well) } }
        }
    }
}

func pathTitle(_ path: String?) -> String {
    switch path { case "lan": return "局域网"; case "p2p": return "P2P 直连"; case "relay": return "中继"; default: return "尚未确认" }
}
