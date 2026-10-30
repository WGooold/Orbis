import SwiftUI

struct ConnectionStatusView: View {
    @EnvironmentObject private var store: OrbisStore
    @Environment(\.colorScheme) private var scheme
    let onBack: () -> Void
    let onSettings: () -> Void
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
                    StatusSection(title: "配对信息") {
                        StatusRow(label: "电脑", value: store.selectedHost?.hostName ?? "已配对的电脑")
                        StatusRow(label: "配对状态", value: store.selectedHost == nil ? "未配对" : "已配对",
                                  tone: store.selectedHost == nil ? OrbisPalette(scheme).error : OrbisPalette(scheme).success)
                    }
                }.padding(.horizontal, 20).padding(.vertical, 16)
            }
        }.background(OrbisPalette(scheme).base.ignoresSafeArea())
    }
}

struct SettingsView: View {
    @EnvironmentObject private var store: OrbisStore
    @Environment(\.colorScheme) private var scheme
    let onBack: () -> Void
    let onProviders: () -> Void
    var body: some View {
        VStack(spacing: 0) {
            OrbisPageHeader(title: "设置", back: onBack) { EmptyView() }
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    StatusSection(title: "Agent 供应商") {
                        // The card is the only surface: the row inside it is plain, not a second raised layer.
                        Button(action: onProviders) {
                            HStack {
                                Text("供应商配置与切换").font(.orbisBody(.semibold))
                                Spacer()
                                Image(systemName: "chevron.right").font(.orbisLabel(.semibold))
                            }.frame(minHeight: 32).contentShape(Rectangle())
                        }.buttonStyle(.plain).foregroundStyle(OrbisPalette(scheme).accent)
                    }
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
                    ForEach(host.providers) { provider in
                        providerRow(provider)
                        if provider.enabled && provider.subscriptionSupported {
                            OrbisTextButton(title: host.queryingQuota && host.quotaProviderId == provider.id ? "查询中…" : "查询订阅配额", tint: OrbisPalette(scheme).accent) {
                                if let key = host.hostKey { host.querySubscription(provider, expectedHostKey: key) }
                            }.disabled(!host.canChangeProvider || selecting).accessibilityIdentifier("provider-quota-\(provider.id)")
                            if host.quotaProviderId == provider.id {
                                if let error = host.quotaError { OrbisNotice(text: error, error: true) }
                                if let quota = host.quota {
                                    VStack(alignment: .leading, spacing: 10) {
                                        ForEach(quota.windows) { window in
                                            Text(window.title + "：" + (window.remainingPercent.map { "剩余 " + String(format: "%.1f", $0) + "%" } ?? "暂不可用"))
                                                .font(.orbisBody(.medium))
                                            if let remaining = window.remainingPercent { ProgressView(value: remaining, total: 100) }
                                            if let reset = window.resetsAt {
                                                Text("重置时间：" + Date(timeIntervalSince1970: Double(reset) / 1000).formatted(date: .abbreviated, time: .shortened)).font(.orbisCaption())
                                            }
                                        }
                                        Text("查询时间：" + Date(timeIntervalSince1970: Double(quota.checkedAt) / 1000).formatted(date: .abbreviated, time: .shortened))
                                            .font(.orbisCaption()).foregroundStyle(OrbisPalette(scheme).secondary)
                                    }.padding(16)
                                }
                            }
                        }
                    }
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
        HStack(spacing: 0) {
            Button {
                guard selecting, host.canChangeProvider, provider.removable else { return }
                if !selected.insert(provider).inserted { selected.remove(provider) }
            } label: {
                HStack(spacing: 12) {
                    VStack(alignment: .leading, spacing: 6) {
                        Text(provider.name).font(.orbisBody(.semibold)).foregroundStyle(OrbisPalette(scheme).text)
                        Text(provider.enabled ? (provider.additive ? "已启用" : "当前使用") : "未启用")
                            .font(.orbisCaption()).foregroundStyle(provider.enabled ? OrbisPalette(scheme).success : OrbisPalette(scheme).secondary)
                    }.frame(maxWidth: .infinity, alignment: .leading)
                    OrbisSelectionIndicator(selected: effectiveSelection.contains(provider), selecting: selecting && provider.removable)
                }.padding(16).frame(maxWidth: .infinity, alignment: .leading)
            }.buttonStyle(OrbisSelectionButtonStyle(selected: effectiveSelection.contains(provider), selecting: selecting))
                .highPriorityGesture(LongPressGesture().onEnded { _ in select(provider) })
                .accessibilityIdentifier("provider-card-\(provider.id)")
                .accessibilityAddTraits(effectiveSelection.contains(provider) ? .isSelected : [])
                .accessibilityHint(provider.removable ? (selecting ? "轻点切换选择" : "长按进入多选移除") : "")
                .accessibilityAction(named: "选择供应商") { select(provider) }
            if !provider.enabled {
                OrbisTextButton(title: "启用", tint: OrbisPalette(scheme).accent) {
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

private func priorityPathTitle(_ kind: String) -> String {
    switch kind { case "lan": return "局域网"; case "p2p": return "P2P 直连"; default: return "中继" }
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
