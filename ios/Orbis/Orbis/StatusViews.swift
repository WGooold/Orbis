import SwiftUI
import CryptoKit

struct ConnectionStatusView: View {
    @EnvironmentObject private var store: OrbisStore
    @EnvironmentObject private var host: HostState
    @Environment(\.colorScheme) private var scheme
    @State private var rawEventsOpen = false
    let onBack: () -> Void
    let onSettings: () -> Void
    var body: some View {
        VStack(spacing: 0) {
            OrbisPageHeader(title: "连接状态", back: onBack) {
                OrbisIconButton(symbol: "gearshape", label: "设置", action: onSettings)
                OrbisTextButton(title: "原始事件") { rawEventsOpen = true }
            }
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    if store.connection != .secured {
                        OrbisNotice(text: store.connection == .connecting || store.connection == .online ? "正在连接电脑并建立安全通道。" : "检查电脑端 Host 和网络连接，然后重试。", error: store.connection == .error)
                        OrbisActionButton(title: "重新连接", symbol: "arrow.clockwise", action: store.reconnectSelectedHost)
                            .disabled(store.selectedHost == nil || store.connection == .connecting)
                    }
                    if store.hosts.count > 1 {
                        StatusSection(title: "已配对电脑") {
                            ForEach(store.hosts) { computer in
                                Button { store.selectHost(computer.hostId) } label: {
                                    HStack {
                                        Text(computer.name).font(.system(size: 14, weight: .semibold))
                                        Spacer()
                                        Text(connectionTitle(computer.connectionState)).font(.system(size: 11))
                                        if computer.hostId == store.selectedHostId { Image(systemName: "checkmark") }
                                    }.frame(minHeight: 44)
                                }.buttonStyle(.plain)
                            }
                        }
                    }
                    StatusSection(title: "连接与加密") {
                        StatusFact(label: "连接方式", value: pathTitle(store.activePath), tone: store.connection == .secured ? OrbisPalette(scheme).success : nil)
                        StatusFact(label: "电脑通道", value: connectionTitle(store.connection))
                        StatusFact(label: "加密通道", value: store.connection == .secured ? "已建立" : "未建立", tone: store.connection == .secured ? OrbisPalette(scheme).success : nil)
                        StatusFact(label: "路径延迟", value: store.pathRTT.map { "\(Int($0)) ms" } ?? "—")
                        StatusFact(label: "Relay 地址", value: store.selectedHost?.relay.relayUrl ?? "—")
                        StatusFact(label: "本机 deviceId", value: store.selectedHost?.relay.deviceId ?? "—", monospaced: true)
                        StatusFact(label: "Host hostId", value: store.selectedHostId ?? "—", monospaced: true)
                    }
                    StatusSection(title: "配对与凭据") {
                        StatusFact(label: "配对状态", value: store.selectedHost == nil ? "未配对" : "已配对", tone: store.selectedHost == nil ? nil : OrbisPalette(scheme).success)
                        StatusFact(label: "电脑", value: store.selectedHost?.hostName ?? "—")
                        StatusFact(label: "Host 公钥指纹", value: fingerprint, monospaced: true)
                        StatusFact(label: "配对根密钥", value: store.selectedHost?.pskRoot.isEmpty == false ? "已保存" : "缺失")
                    }
                    HostDiagnosticsSection()
                    HostCatalogSection()
                    HostProvidersSection()
                    HostModelSection()
                    HostServicesSection()
                }.padding(.horizontal, 20).padding(.vertical, 16)
            }
        }.background(OrbisPalette(scheme).base.ignoresSafeArea())
            .sheet(isPresented: $rawEventsOpen) {
                VStack(spacing: 0) {
                    OrbisPageHeader(title: "原始事件", back: { rawEventsOpen = false }) { EmptyView() }
                    ScrollView {
                        Text(store.connectionEvents.reversed().joined(separator: "\n"))
                            .font(.system(size: 12, design: .monospaced)).textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .leading).padding(20)
                    }
                }.foregroundStyle(OrbisPalette(scheme).text).background(OrbisPalette(scheme).base)
                    .orbisSheet([.large])
            }
            .onAppear { if store.connection == .secured { host.refresh() } }
    }
    private var fingerprint: String {
        guard let host = store.selectedHost, let bytes = try? Base64URL.decode(host.hostPub, label: "hostPub") else { return "—" }
        return SHA256.hash(data: bytes).prefix(8).map { String(format: "%02x", $0) }.joined(separator: ":")
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
                                Text("供应商配置与切换").font(.system(size: 14, weight: .semibold))
                                Spacer()
                                Image(systemName: "chevron.right").font(.system(size: 12, weight: .semibold))
                            }.padding(.horizontal, 14).frame(minHeight: 48).contentShape(Rectangle())
                        }.buttonStyle(NeuButtonStyle(radius: 14)).foregroundStyle(OrbisPalette(scheme).accent)
                    }
                    StatusSection(title: "连接优先级") {
                        ForEach(Array(store.pathPreference.enumerated()), id: \.element) { index, kind in
                            HStack(spacing: 8) {
                                Text("第 \(index + 1) 优先").font(.system(size: 12)).foregroundStyle(OrbisPalette(scheme).secondary)
                                Text(priorityPathTitle(kind)).font(.system(size: 14)).frame(maxWidth: .infinity, alignment: .leading)
                                OrbisIconButton(symbol: "arrow.up", label: "上移\(priorityPathTitle(kind))") { move(index, to: index - 1) }
                                    .disabled(index == 0)
                                OrbisIconButton(symbol: "arrow.down", label: "下移\(priorityPathTitle(kind))") { move(index, to: index + 1) }
                                    .disabled(index == store.pathPreference.count - 1)
                            }.accessibilityElement(children: .contain).accessibilityIdentifier("path-priority-\(kind)")
                        }
                    }
                    Text("顺序会保存在本机，并同步给电脑。电脑根据各路径的可达性与延迟选择当前路径，连接状态页显示实际使用的链路。")
                        .font(.system(size: 13)).foregroundStyle(OrbisPalette(scheme).secondary)
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
                    Text(store.selectedHost?.hostName ?? "已配对的电脑").font(.system(size: 16, weight: .medium))
                    HStack(spacing: 10) {
                        ForEach(["pi", "codex", "dsh"], id: \.self) { kind in
                            Button { host.loadProviders(kind) } label: {
                                HStack(spacing: 6) {
                                    AgentEmblem(kind: kind, size: 22, recessed: false)
                                    Text(agentTitle(kind)).font(.system(size: 13, weight: .semibold))
                                }.frame(maxWidth: .infinity, minHeight: 48)
                            }.buttonStyle(NeuButtonStyle(selected: host.providerKind == kind))
                                .disabled(host.providersLoading || host.changingProvider)
                                .accessibilityLabel("\(agentTitle(kind))供应商").accessibilityAddTraits(host.providerKind == kind ? .isSelected : [])
                        }
                    }
                    if host.providersLoading || host.changingProvider {
                        ProgressView().progressViewStyle(.linear).accessibilityLabel(host.changingProvider ? "正在更新供应商" : "正在读取供应商")
                    }
                    if let problem = host.providerCatalogProblem, !host.providersLoading { OrbisNotice(text: problem, error: host.connected) }
                    if let notice = host.providerNotice { OrbisNotice(text: notice) }
                    if host.providerSummary?["switching"].bool == true { OrbisNotice(text: "电脑正在切换供应商，请等待完成后再操作。") }
                    if !host.providersLoading && host.providerCatalogProblem == nil && host.providers.isEmpty {
                        OrbisEmptyState(symbol: "shippingbox", title: "还没有供应商", detail: "请先在电脑端 Host 添加供应商配置。")
                    }
                    ForEach(host.providers) { provider in
                        HStack(spacing: 12) {
                            VStack(alignment: .leading, spacing: 6) {
                                Text(provider.name).font(.system(size: 15, weight: .semibold))
                                Text(provider.enabled ? (provider.additive ? "已启用" : "当前使用") : "未启用")
                                    .font(.system(size: 12)).foregroundStyle(provider.enabled ? OrbisPalette(scheme).success : OrbisPalette(scheme).secondary)
                            }.frame(maxWidth: .infinity, alignment: .leading)
                            if !provider.enabled || provider.additive {
                                OrbisTextButton(title: provider.enabled ? "移除" : "启用",
                                                tint: provider.enabled ? OrbisPalette(scheme).error : OrbisPalette(scheme).accent) {
                                    if let key = host.hostKey { confirm(provider, hostKey: key) }
                                }.disabled(!host.canChangeProvider).accessibilityIdentifier("provider-action-\(provider.id)")
                            }
                        }.padding(18).neuSurface()
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

private struct HostDiagnosticsSection: View {
    @EnvironmentObject private var host: HostState
    var body: some View {
        StatusSection(title: "电脑端诊断记录") {
            if let problem = host.problem(for: "diagnostics") { StatusFact(label: "记录目录", value: problem) }
            else if let value = host.domains["diagnostics"]?.value {
                StatusFact(label: "记录目录", value: value["records"].integer.map { "\($0) 条记录" } ?? "尚未核对条数")
                if let count = value["dropped"].integer, count > 0 { OrbisNotice(text: "已淘汰 \(count) 条记录，当前窗口不包含完整历史。") }
                if let count = value["persistFailures"].integer, count > 0 { OrbisNotice(text: "落盘失败 \(count) 次，磁盘记录存在缺口。", error: true) }
            }
            if let error = host.diagnosticsError { OrbisNotice(text: error, error: true) }
            if host.diagnosticsLoading { ProgressView().accessibilityLabel("正在读取诊断记录") }
            if let page = host.diagnosticPage {
                StatusFact(label: "最近读到的", value: page.records.last?.message ?? "本页没有记录")
                if page.truncated { OrbisNotice(text: "记录窗口已变化，部分较早记录已淘汰。") }
                if page.nextCursor != nil { Text("还有更新的记录未读取").font(.system(size: 12)) }
                ForEach(page.records) { record in
                    VStack(alignment: .leading, spacing: 5) {
                        StatusFact(label: "\(record.category) · \(severityTitle(record.severity))", value: record.message)
                        Text(Date(timeIntervalSince1970: Double(record.at) / 1000), style: .time).font(.system(size: 11)).foregroundStyle(.secondary)
                    }
                }
                if let cursor = page.nextCursor {
                    OrbisActionButton(title: "读取下一页", symbol: "arrow.down") { host.readDiagnostics(cursor: cursor) }
                        .disabled(!host.connected || host.diagnosticsLoading)
                }
            } else { StatusFact(label: "最近读到的", value: "尚未读取") }
            OrbisActionButton(title: "重新读取", symbol: "arrow.clockwise") { host.readDiagnostics() }
                .disabled(!host.connected || host.diagnosticsLoading)
        }
    }
}

private struct HostCatalogSection: View {
    @EnvironmentObject private var host: HostState
    var body: some View {
        StatusSection(title: "电脑端会话目录") {
            if let problem = host.problem(for: "catalog") { StatusFact(label: "目录完整性", value: problem) }
            else if let value = host.domains["catalog"]?.value {
                let incomplete = value["backends"].array.contains { $0["complete"].bool != true }
                StatusFact(label: "目录完整性", value: value["truncated"].bool == true ? "目录已截断" : value["nextCursor"].string != nil ? "目录尚有未读取的范围" : incomplete ? "部分后端未能读完" : "电脑已核对目录")
                StatusFact(label: "会话总数", value: value["totalSessions"].integer.map(String.init) ?? "未知")
                ForEach(Array(value["backends"].array.enumerated()), id: \.offset) { _, backend in
                    StatusFact(label: agentTitle(backend["kind"].string), value: backend["error"].string ?? (backend["ready"].bool == true ? (backend["complete"].bool == true ? "读取完成" : "目录不完整") : "后端未就绪"))
                }
            }
        }
    }
}

private struct HostProvidersSection: View {
    @EnvironmentObject private var host: HostState
    var body: some View {
        StatusSection(title: "电脑端供应商") {
            if let problem = host.problem(for: "providers") { StatusFact(label: "供应商状态", value: problem) }
            else {
                let rows = host.domains["providers"]?.value["providers"].array ?? []
                if rows.isEmpty { StatusFact(label: "供应商状态", value: "电脑没有报告任何供应商") }
                ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
                    let title = agentTitle(row["agentKind"].string)
                    if let availability = row["availability"].string, availability != "ready" {
                        StatusFact(label: title + " · 配置状态", value: "电脑尚未核对，以下保留最后读取的配置")
                    }
                    StatusFact(label: title + " · 切换状态", value: boolTitle(row["switching"].bool, yes: "正在切换", no: "未报告进行中的切换"))
                    StatusFact(label: title + " · 当前供应商", value: row["current"].string ?? "尚未核对")
                    StatusFact(label: title + " · 可选供应商", value: row["profiles"] == .null ? "清单尚未读取" : "\(row["profiles"].array.count) 个\(row["profilesTruncated"].bool == true ? "（清单不完整）" : "")")
                    StatusFact(label: title + " · 认证绑定", value: boolTitle(row["authenticated"].bool, yes: "已绑定凭据", no: "缺少凭据，请在电脑端配置"))
                    if row["authentication"] != .null {
                        StatusFact(label: title + " · 远端认证", value: boolTitle(row["authentication"]["verified"].bool, yes: "已验证", no: "未通过验证"))
                    }
                    StatusFact(label: title + " · 用量", value: usageTitle(row["usage"]))
                    StatusFact(label: title + " · 路由", value: row["routing"]["availability"].string == "ready" ? boolTitle(row["routing"]["running"].bool, yes: "运行中", no: "未运行") : "尚未核对")
                    if row["health"]["availability"].string == "ready" {
                        let open = row["health"]["circuits"].array.filter { $0["state"].string == "open" }.count
                        StatusFact(label: title + " · 健康度", value: open > 0 ? "\(open) 个供应商熔断中" : "无熔断中的供应商")
                    }
                }
            }
        }
    }
    private func usageTitle(_ usage: HostJSON) -> String {
        guard usage["availability"].string == "ready" else { return usage["error"].string != nil ? "查询失败" : "尚未核对" }
        let rows = usage["rows"].array
        let numbers = rows.compactMap { row -> String? in
            guard let remaining = row["remaining"].number else { return nil }
            return "剩余 \(remaining.formatted())"
        }
        return numbers.isEmpty ? (usage["detail"].string ?? "没有可用的用量数值") : numbers.joined(separator: "；")
    }
}

private struct HostModelSection: View {
    @EnvironmentObject private var host: HostState
    var body: some View {
        StatusSection(title: "统一状态模型") {
            if !host.pendingDomains.isEmpty { ProgressView().accessibilityLabel("正在读取电脑端状态") }
            if let error = host.modelError { OrbisNotice(text: error, error: true) }
            ForEach(HostState.domainNames, id: \.self) { name in
                StatusFact(label: domainTitle(name), value: host.problem(for: name) ?? host.domains[name].map { "已核对 · 版本 \($0.revision)" } ?? "尚未读取")
            }
            OrbisActionButton(title: "刷新电脑端状态", symbol: "arrow.clockwise") { host.refresh() }
                .disabled(!host.connected || !host.pendingDomains.isEmpty)
        }
    }
}

private struct HostServicesSection: View {
    @EnvironmentObject private var store: OrbisStore
    @EnvironmentObject private var host: HostState
    @Environment(\.colorScheme) private var scheme
    var body: some View {
        StatusSection(title: "电脑 Agent 服务") {
            StatusFact(label: "Codex 桌面版接入", value: desktopAttachTitle(store.codexDesktop?.state),
                tone: store.codexDesktop?.state == "attached" ? OrbisPalette(scheme).success : store.codexDesktop?.state == "error" ? OrbisPalette(scheme).error : nil)
            if let reason = store.codexDesktop?.reason { StatusFact(label: "说明", value: reason) }
            if let problem = host.problem(for: "backends") { StatusFact(label: "服务状态", value: problem) }
            else if let value = host.domains["backends"]?.value {
                ForEach(Array(value["backends"].array.enumerated()), id: \.offset) { _, backend in
                    StatusFact(label: agentTitle(backend["kind"].string), value: backend["reason"].string ?? boolTitle(backend["ready"].bool, yes: "已就绪", no: "未就绪"))
                }
            }
            if host.problem(for: "management") == nil, let value = host.domains["management"]?.value {
                StatusFact(label: "Host 服务", value: value["lifecycle"].string == "running" ? "运行中" : value["lifecycle"].string ?? "未知")
                StatusFact(label: "系统", value: value["platform"].string ?? "未知")
            }
        }
    }
}

private func boolTitle(_ value: Bool?, yes: String, no: String) -> String { value.map { $0 ? yes : no } ?? "尚未核对" }
private func severityTitle(_ severity: String) -> String { severity == "error" ? "错误" : severity == "warning" ? "警告" : "信息" }
private func domainTitle(_ name: String) -> String {
    ["identity": "电脑身份", "backends": "Agent 服务", "catalog": "会话目录", "providers": "供应商", "workspaces": "工作区", "files": "文件", "operations": "操作", "diagnostics": "诊断记录", "connections": "电脑连接", "management": "服务管理"][name] ?? name
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
            Text(title).font(.system(size: 14, weight: .semibold)).foregroundStyle(OrbisPalette(scheme).secondary).accessibilityAddTraits(.isHeader)
            VStack(alignment: .leading, spacing: 14) { content }
                .padding(18).frame(maxWidth: .infinity, alignment: .leading).neuSurface()
        }
    }
}

struct StatusFact: View {
    @Environment(\.colorScheme) private var scheme
    let label: String
    let value: String
    var tone: Color? = nil
    var monospaced = false
    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(label).font(.system(size: 11)).foregroundStyle(OrbisPalette(scheme).secondary)
            HStack(alignment: .firstTextBaseline, spacing: 7) {
                if let tone { Circle().fill(tone).frame(width: 7, height: 7) }
                Text(value).font(.system(size: 14, design: monospaced ? .monospaced : .default))
                    .foregroundStyle(tone ?? OrbisPalette(scheme).text).textSelection(.enabled)
            }
        }.frame(maxWidth: .infinity, alignment: .leading)
    }
}

private func pathTitle(_ path: String?) -> String {
    switch path { case "lan": return "LAN 局域网直连"; case "p2p": return "P2P 点对点"; case "relay": return "Relay 中继"; default: return "尚未确认" }
}
