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
                                Button { store.selectHost(computer.hostId) } label: {
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
                        StatusFact(label: "连接状态", value: store.connection == .secured ? "已连接" : connectionTitle(store.connection),
                                   tone: store.connection == .secured ? OrbisPalette(scheme).success : store.connection == .error ? OrbisPalette(scheme).error : nil)
                        StatusFact(label: "连接方式", value: pathTitle(store.activePath))
                        StatusFact(label: "端到端加密", value: store.connection == .secured ? "已启用" : "未建立",
                                   tone: store.connection == .secured ? OrbisPalette(scheme).success : nil)
                    }
                    StatusSection(title: "配对信息") {
                        StatusFact(label: "电脑", value: store.selectedHost?.hostName ?? "已配对的电脑")
                        StatusFact(label: "配对状态", value: store.selectedHost == nil ? "未配对" : "已配对", tone: store.selectedHost == nil ? nil : OrbisPalette(scheme).success)
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
                        Button(action: onProviders) {
                            HStack {
                                Text("供应商配置与切换").font(.orbisBody(.semibold))
                                Spacer()
                                Image(systemName: "chevron.right").font(.orbisLabel(.semibold))
                            }.padding(.horizontal, 14).frame(minHeight: 48).contentShape(Rectangle())
                        }.buttonStyle(NeuButtonStyle()).foregroundStyle(OrbisPalette(scheme).accent)
                    }
                    StatusSection(title: "连接优先级") {
                        ForEach(Array(store.pathPreference.enumerated()), id: \.element) { index, kind in
                            HStack(spacing: 8) {
                                Text("第 \(index + 1) 优先").font(.orbisCaption()).foregroundStyle(OrbisPalette(scheme).secondary)
                                Text(priorityPathTitle(kind)).font(.orbisBody()).frame(maxWidth: .infinity, alignment: .leading)
                                OrbisIconButton(symbol: "arrow.up", label: "上移\(priorityPathTitle(kind))") { move(index, to: index - 1) }
                                    .disabled(index == 0)
                                OrbisIconButton(symbol: "arrow.down", label: "下移\(priorityPathTitle(kind))") { move(index, to: index + 1) }
                                    .disabled(index == store.pathPreference.count - 1)
                            }.accessibilityElement(children: .contain).accessibilityIdentifier("path-priority-\(kind)")
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
    let onBack: () -> Void
    var body: some View {
        VStack(spacing: 0) {
            OrbisPageHeader(title: "供应商", back: onBack) {
                OrbisTextButton(title: "刷新", symbol: "arrow.clockwise") { host.loadProviders(host.providerKind) }
                    .disabled(host.providersLoading || host.changingProvider || !host.connected)
            }
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    Text(store.selectedHost?.hostName ?? "已配对的电脑").font(.orbisBody(.medium))
                    HStack(spacing: 10) {
                        ForEach(["pi", "codex", "dsh"], id: \.self) { kind in
                            Button { host.loadProviders(kind) } label: {
                                HStack(spacing: 6) {
                                    AgentEmblem(kind: kind, size: 22, recessed: false)
                                    Text(agentTitle(kind)).font(.orbisLabel(.semibold))
                                }.frame(maxWidth: .infinity, minHeight: 48)
                            }.buttonStyle(NeuButtonStyle(selected: host.providerKind == kind))
                                .disabled(host.providersLoading || host.changingProvider)
                                .accessibilityLabel("\(agentTitle(kind))供应商").accessibilityAddTraits(host.providerKind == kind ? .isSelected : [])
                        }
                    }
                    // Always laid out; loading only changes its opacity, so the list below never moves.
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
                    ForEach(host.providers) { provider in
                        HStack(spacing: 12) {
                            VStack(alignment: .leading, spacing: 6) {
                                Text(provider.name).font(.orbisBody(.semibold))
                                Text(provider.enabled ? (provider.additive ? "已启用" : "当前使用") : "未启用")
                                    .font(.orbisCaption()).foregroundStyle(provider.enabled ? OrbisPalette(scheme).success : OrbisPalette(scheme).secondary)
                            }.frame(maxWidth: .infinity, alignment: .leading)
                            if !provider.enabled || provider.additive {
                                OrbisTextButton(title: provider.enabled ? "移除" : "启用",
                                                tint: provider.enabled ? OrbisPalette(scheme).error : OrbisPalette(scheme).accent) {
                                    if let key = host.hostKey { confirm(provider, hostKey: key) }
                                }.disabled(!host.canChangeProvider).accessibilityIdentifier("provider-action-\(provider.id)")
                            }
                        }.neuSurface(radius: OrbisRadius.card, padding: 16)
                    }
                }.padding(20)
            }
        }.background(OrbisPalette(scheme).base.ignoresSafeArea())
            .onAppear { host.loadProviders(host.providerKind) }
            // 换了电脑，未确认的切换就不再成立。
            .onChange(of: host.hostKey) { _, _ in overlay.dismissDialog() }
    }

    private func confirm(_ provider: AgentProvider, hostKey: String) {
        overlay.showDialog(provider.enabled ? "移除供应商" : "启用供应商", message: provider.confirmation, actions: [
            OrbisDialogAction(title: "取消", role: .cancel),
            OrbisDialogAction(title: "确认", role: provider.enabled ? .destructive : .normal) {
                host.changeProvider(provider, expectedHostKey: hostKey)
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

private func pathTitle(_ path: String?) -> String {
    switch path { case "lan": return "局域网"; case "p2p": return "P2P 直连"; case "relay": return "中继"; default: return "尚未确认" }
}
