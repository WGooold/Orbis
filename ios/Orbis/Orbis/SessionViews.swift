import SwiftUI

struct SessionDirectoryState {
    var query = ""
    var kind: String?
    var archived = false
    var providerKey = "current"
    var expanded: Set<String> = []
}

struct SessionDrawerView: View {
    @EnvironmentObject private var store: OrbisStore
    @EnvironmentObject private var host: HostState
    @Environment(\.colorScheme) private var scheme
    @Binding var state: SessionDirectoryState
    @FocusState private var searchFocused: Bool
    let onClose: () -> Void
    let onOpenSession: (SessionSummary) -> Void
    let onNewSession: (String?) -> Void
    let onAddHost: () -> Void
    let onProviders: () -> Void
    let onUnpair: (HostPairing) -> Void
    @State private var mismatch: String?

    private var hasProviderFilter: Bool { state.kind == "codex" || state.kind == "codexDesktop" }
    private var providerOptions: [SessionProviderOption] {
        sessionProviderOptions(store.sessions, kind: state.kind ?? "codex", current: store.currentProvider(for: state.kind ?? "codex"))
    }
    private var effectiveProviderKey: String { providerOptions.contains { $0.key == state.providerKey } ? state.providerKey : "current" }
    private var providerLabel: String { providerOptions.first { $0.key == effectiveProviderKey }?.label ?? "当前 provider" }

    private var directories: [SessionDirectory] {
        let visible = hasProviderFilter ? store.sessions.filter {
            matchesSessionProvider($0, filter: effectiveProviderKey, current: store.currentProvider(for: state.kind ?? "codex"))
        } : store.sessions
        return sessionDirectories(visible, query: state.query, kind: state.kind, archived: state.archived, title: store.displayName)
    }

    var body: some View {
        VStack(spacing: 16) {
            HStack(spacing: 12) {
                Text("会话目录").font(.system(size: 20, weight: .semibold)).accessibilityAddTraits(.isHeader)
                Spacer()
                OrbisIconButton(symbol: "xmark", label: "关闭会话目录", action: onClose)
            }.padding(.top, 8)
            HStack(spacing: 12) {
                OrbisActionButton(title: "新会话", symbol: "plus") { onNewSession(nil) }
                    .disabled(store.connection != .secured || store.activatingSessionId != nil)
                OrbisIconButton(symbol: "arrow.clockwise", label: "刷新会话目录", action: store.refresh)
                    .disabled(store.selectedHost == nil)
                Menu {
                    Button("全部") { state.kind = nil }
                    ForEach(["pi", "codex", "codexDesktop", "dsh"], id: \.self) { kind in
                        Button(filterTitle(kind)) { state.kind = kind }
                    }
                    Divider()
                    Button(state.archived ? "查看未归档会话" : "查看已归档会话") { state.archived.toggle() }
                    if hasProviderFilter {
                        Divider()
                        ForEach(providerOptions) { option in
                            Button { state.providerKey = option.key } label: {
                                if effectiveProviderKey == option.key { Label(option.label, systemImage: "checkmark") }
                                else { Text(option.label) }
                            }
                        }
                    }
                    Divider()
                    Button("供应商配置与切换", action: onProviders)
                } label: {
                    Image(systemName: "line.3.horizontal.decrease").frame(width: 40, height: 40)
                        .foregroundStyle(state.kind == nil ? OrbisPalette(scheme).secondary : OrbisPalette(scheme).accent)
                        .neuSurface(inset: state.kind != nil, radius: 20, intensity: 0.5).frame(width: 48, height: 48)
                }.accessibilityLabel("筛选会话：\(state.kind.map(filterTitle) ?? "全部")")
            }
            HStack(spacing: 8) {
                Image(systemName: "magnifyingglass").foregroundStyle(OrbisPalette(scheme).secondary)
                TextField("搜索会话或目录", text: $state.query).font(.system(size: 14))
                    .focused($searchFocused).submitLabel(.search).onSubmit { searchFocused = false }
                    .autocorrectionDisabled().textInputAutocapitalization(.never)
                if !state.query.isEmpty {
                    Button { state.query = "" } label: { Image(systemName: "xmark.circle.fill").frame(minWidth: 32, minHeight: 32) }
                        .accessibilityLabel("清除搜索")
                }
            }.padding(.horizontal, 14).frame(minHeight: 56).neuSurface(inset: true, radius: 16, intensity: 0.6)
            HStack {
                Text("\(directories.count) 个目录 · \(directories.reduce(0) { $0 + $1.sessions.count }) 个会话")
                    .font(.system(size: 12)).foregroundStyle(OrbisPalette(scheme).secondary)
                Spacer()
                Button(state.expanded.count >= directories.count && !directories.isEmpty ? "收起全部" : "展开全部") {
                    state.expanded = state.expanded.count >= directories.count ? [] : Set(directories.map(\.path))
                }.font(.system(size: 12, weight: .semibold)).frame(minHeight: 40)
            }
            if state.kind != nil || state.archived {
                HStack {
                    Text("\(state.kind.map(filterTitle) ?? "全部")\(hasProviderFilter ? " · " + providerLabel : "")\(state.archived ? " · 已归档" : "")").font(.system(size: 12))
                    Spacer()
                    Button("重置") { state.kind = nil; state.archived = false; state.providerKey = "current" }.font(.system(size: 12))
                }.foregroundStyle(OrbisPalette(scheme).accent)
            }
            ScrollView {
                LazyVStack(spacing: 14) {
                    if directories.isEmpty {
                        OrbisEmptyState(symbol: state.query.isEmpty ? "folder" : "magnifyingglass", title: emptyTitle)
                            .padding(.top, 40)
                    }
                    ForEach(directories) { directory in
                        directoryGroup(directory)
                    }
                }.padding(6).padding(.bottom, 16)
            }.scrollDismissesKeyboard(.interactively)
            Divider().overlay(OrbisPalette(scheme).outline)
            hostSelector
        }.padding(.horizontal, 18)
            .onAppear {
                if state.expanded.isEmpty, let path = store.selectedRuntime?.cwd ?? directories.first?.path { state.expanded.insert(path) }
            }
            .onChange(of: store.sessions.map(\.sessionId)) { _, _ in
                if state.expanded.isEmpty, let path = store.selectedRuntime?.cwd ?? directories.first?.path { state.expanded.insert(path) }
            }
            .onChange(of: store.selectedHostId) { _, _ in state.providerKey = "current"; state.expanded = [] }
            .onChange(of: state.kind) { _, _ in state.providerKey = "current" }
            .alert("需要切换 provider", isPresented: Binding(get: { mismatch != nil }, set: { if !$0 { mismatch = nil } })) {
                Button("供应商设置") { mismatch = nil; onProviders() }
                Button("取消", role: .cancel) { mismatch = nil }
            } message: { Text(mismatch ?? "") }
    }

    private var emptyTitle: String {
        if !state.query.isEmpty { return "没有匹配的会话" }
        if hasProviderFilter && effectiveProviderKey == "current" && store.currentProvider(for: state.kind ?? "codex") == nil { return "尚未获取当前 provider" }
        return state.archived ? "没有已归档的会话" : "暂无会话"
    }

    private func directoryGroup(_ directory: SessionDirectory) -> some View {
        let expanded = state.expanded.contains(directory.path) || !state.query.trimmingCharacters(in: .whitespaces).isEmpty
        return VStack(spacing: 10) {
            HStack(spacing: 8) {
                Button {
                    if !state.expanded.insert(directory.path).inserted { state.expanded.remove(directory.path) }
                } label: {
                    HStack(spacing: 9) {
                        Image(systemName: expanded ? "folder.fill" : "folder").foregroundStyle(OrbisPalette(scheme).accent)
                        VStack(alignment: .leading, spacing: 3) {
                            Text(directoryTitle(directory.path)).font(.system(size: 14, weight: .semibold)).lineLimit(1)
                            Text(directory.path).font(.system(size: 11, design: .monospaced)).foregroundStyle(OrbisPalette(scheme).secondary).lineLimit(1)
                        }.frame(maxWidth: .infinity, alignment: .leading)
                        Text("\(directory.sessions.count)").font(.system(size: 12)).foregroundStyle(OrbisPalette(scheme).secondary)
                        Image(systemName: expanded ? "chevron.down" : "chevron.right").font(.system(size: 11))
                    }.padding(12).frame(minHeight: 60).contentShape(Rectangle())
                }.buttonStyle(NeuButtonStyle(selected: expanded))
                    .accessibilityLabel("\(expanded ? "收起" : "展开")目录 \(directory.path)，\(directory.sessions.count) 个会话")
                OrbisIconButton(symbol: "plus", label: "在此目录新建会话") { onNewSession(directory.path) }
                    .disabled(store.connection != .secured || store.activatingSessionId != nil)
            }
            if expanded {
                ForEach(directory.sessions) { session in
                    sessionRow(session).padding(.leading, 12)
                }
            }
        }
    }

    private func sessionRow(_ session: SessionSummary) -> some View {
        let runtime = store.runtimes.first { $0.sessionId == session.sessionId }
        return HStack(spacing: 4) {
            Button {
                searchFocused = false
                if let problem = store.providerMismatch(session) { mismatch = problem }
                else { onOpenSession(session) }
            } label: {
                HStack(spacing: 8) {
                    AgentEmblem(kind: session.agentKind, size: 24, recessed: false)
                    VStack(alignment: .leading, spacing: 4) {
                        Text(store.displayName(session)).font(.system(size: 14, weight: .medium)).lineLimit(2)
                        HStack(spacing: 6) {
                            if let runtime { RuntimeStatusLabel(status: runtime.status) }
                            else { Text("未运行").font(.system(size: 11)).foregroundStyle(OrbisPalette(scheme).secondary) }
                            Text(Date(timeIntervalSince1970: Double(session.modifiedAt) / 1000), style: .date)
                                .font(.system(size: 10)).foregroundStyle(OrbisPalette(scheme).secondary)
                        }
                    }.frame(maxWidth: .infinity, alignment: .leading)
                    if store.activatingSessionId == session.sessionId { ProgressView().controlSize(.small) }
                }.padding(12).contentShape(Rectangle())
            }.buttonStyle(.plain)
                .disabled((runtime == nil && store.connection != .secured) || store.activatingSessionId != nil)
            Menu {
                Button(state.archived ? "取消归档" : "归档会话", systemImage: state.archived ? "tray.and.arrow.up" : "archivebox") {
                    store.archive(session, archived: !state.archived)
                }.disabled(store.connection != .secured || session.agentKind == nil)
            } label: { Image(systemName: "ellipsis").frame(width: 40, height: 48) }.accessibilityLabel("会话操作")
        }.neuSurface(inset: store.selectedRuntime?.sessionId == session.sessionId, radius: 16, intensity: 0.45)
    }

    private var hostSelector: some View {
        HStack(spacing: 10) {
            Menu {
                ForEach(store.pairings) { host in
                    Button { if host.hostId != store.selectedHostId { store.connect(hostId: host.hostId) } } label: {
                        Label(host.hostName, systemImage: host.hostId == store.selectedHostId ? "checkmark" : "desktopcomputer")
                    }
                }
                Divider()
                Button("添加电脑", systemImage: "plus", action: onAddHost)
            } label: {
                HStack(spacing: 10) {
                    Image(systemName: "desktopcomputer")
                    VStack(alignment: .leading, spacing: 3) {
                        Text("电脑").font(.system(size: 11)).foregroundStyle(OrbisPalette(scheme).secondary)
                        Text(store.selectedHost?.hostName ?? "选择电脑").font(.system(size: 14, weight: .semibold)).lineLimit(1)
                    }
                    Spacer()
                    Image(systemName: "chevron.up.chevron.down").font(.system(size: 11))
                }.padding(12).frame(minHeight: 58).neuSurface(radius: 16, intensity: 0.6)
            }.accessibilityLabel("切换电脑，当前 \(store.selectedHost?.hostName ?? "未选择")")
            if let host = store.selectedHost {
                Menu {
                    Button("取消配对 \(host.hostName)", role: .destructive) { onUnpair(host) }
                } label: { Image(systemName: "ellipsis").frame(width: 40, height: 40).neuSurface(radius: 20, intensity: 0.5).frame(width: 48, height: 48) }
                    .accessibilityLabel("当前电脑操作")
            }
        }.padding(.bottom, 18)
    }
}

private func filterTitle(_ kind: String) -> String {
    switch kind {
    case "codex": return "Codex 终端"
    case "codexDesktop": return "Codex 桌面版"
    case "dsh": return "DeepSeek"
    default: return "Pi"
    }
}

struct NewSessionView: View {
    @EnvironmentObject private var store: OrbisStore
    @Environment(\.colorScheme) private var scheme
    let presetCwd: String?
    let onDismiss: () -> Void
    @State private var kind = "pi"

    private var allowedAgents: [String] { store.launchableAgents ?? store.supportedAgents ?? ["pi", "codex"] }
    private var canCreate: Bool {
        let path = presetCwd ?? store.browse?.path
        return store.connection == .secured && store.activatingSessionId == nil && allowedAgents.contains(kind) &&
            path?.isEmpty == false && (presetCwd != nil || (store.browse?.loading == false && store.browse?.error == nil))
    }

    var body: some View {
        VStack(spacing: 16) {
            OrbisPageHeader(title: "新建会话", back: onDismiss) { EmptyView() }
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    Text("在\(store.selectedHost?.hostName ?? "电脑")上新建会话").font(.system(size: 16, weight: .semibold))
                    LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 14) {
                        ForEach(["pi", "codex", "codexDesktop", "dsh"], id: \.self) { agent in
                            Button { kind = agent } label: {
                                HStack(spacing: 8) {
                                    AgentEmblem(kind: agent, size: 22, recessed: false)
                                    Text(filterTitle(agent)).font(.system(size: 13, weight: .semibold)).lineLimit(2)
                                    if kind == agent { Image(systemName: "checkmark").font(.system(size: 11)) }
                                }.foregroundStyle(OrbisPalette(scheme).agent(agent)).frame(maxWidth: .infinity, minHeight: 60).padding(.horizontal, 10)
                            }.buttonStyle(NeuButtonStyle(selected: kind == agent)).disabled(!allowedAgents.contains(agent))
                                .accessibilityAddTraits(kind == agent ? .isSelected : [])
                        }
                    }
                    if let presetCwd {
                        Label(presetCwd, systemImage: "folder").font(.system(size: 13, design: .monospaced)).padding(16).frame(maxWidth: .infinity, alignment: .leading)
                            .neuSurface(inset: true, radius: 16, intensity: 0.45)
                    } else { RemoteDirectoryView() }
                    if store.connection != .secured { OrbisNotice(text: "未连接到电脑，连接恢复后可新建会话。") }
                }.padding(.horizontal, 24).padding(.vertical, 8)
            }
            OrbisActionButton(title: "在这里新建 \(agentTitle(kind)) 会话", symbol: "plus", tint: OrbisPalette(scheme).agent(kind)) {
                if let cwd = presetCwd ?? store.browse?.path {
                    store.createSession(agentKind: kind, cwd: cwd)
                    if store.activatingSessionId != nil { onDismiss() }
                }
            }.disabled(!canCreate).padding(.horizontal, 24).padding(.bottom, 24)
        }.background(OrbisPalette(scheme).base.ignoresSafeArea())
            .onAppear {
                if !allowedAgents.contains(kind), let first = allowedAgents.first { kind = first }
                if presetCwd == nil { store.browseDirectory() }
            }
            .onChange(of: store.selectedHostId) { _, _ in onDismiss() }
    }
}

struct RemoteDirectoryView: View {
    @EnvironmentObject private var store: OrbisStore
    @Environment(\.colorScheme) private var scheme
    var body: some View {
        VStack(spacing: 14) {
            HStack(spacing: 8) {
                Image(systemName: "folder").foregroundStyle(OrbisPalette(scheme).accent)
                Text(store.browse?.path.flatMap { $0.isEmpty ? nil : $0 } ?? "电脑根目录")
                    .font(.system(size: 12, design: .monospaced)).frame(maxWidth: .infinity, alignment: .leading)
                if store.browse?.loading == true { ProgressView().controlSize(.small) }
                else { OrbisIconButton(symbol: "arrow.clockwise", label: "刷新目录") { store.browseDirectory(store.browse?.path) }.disabled(store.connection != .secured) }
            }
            if store.browse?.path?.isEmpty == false {
                OrbisActionButton(title: "上一级", symbol: "arrow.up") { store.browseDirectory(store.browse?.parent) }
                    .disabled(store.browse?.loading == true || store.connection != .secured)
            }
            if let error = store.browse?.error {
                OrbisNotice(text: error, error: true)
                OrbisActionButton(title: "重新读取", symbol: "arrow.clockwise") { store.browseDirectory(store.browse?.path) }
                    .disabled(store.connection != .secured)
            } else if store.browse?.loading == false {
                let entries = (store.browse?.entries ?? []).filter(\.isDir).sorted { ($0.hasSessions ? 0 : 1, $0.name) < ($1.hasSessions ? 0 : 1, $1.name) }
                if entries.isEmpty { Text("此目录没有子目录").font(.system(size: 13)).foregroundStyle(OrbisPalette(scheme).secondary).padding(16) }
                ForEach(entries) { entry in
                    Button { store.browseDirectory(remoteBrowsePath(parent: store.browse?.path, name: entry.name)) } label: {
                        HStack(spacing: 10) {
                            Image(systemName: "folder").foregroundStyle(OrbisPalette(scheme).accent)
                            Text(entry.name).font(.system(size: 14)).frame(maxWidth: .infinity, alignment: .leading)
                            if entry.hasSessions { Text("有历史").font(.system(size: 10)).foregroundStyle(OrbisPalette(scheme).accent) }
                            Image(systemName: "chevron.right").font(.system(size: 12))
                        }.padding(14).frame(minHeight: 52)
                    }.buttonStyle(NeuButtonStyle()).disabled(store.connection != .secured)
                }
            }
        }
    }
}

struct SessionAliasView: View {
    @EnvironmentObject private var store: OrbisStore
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var scheme
    let runtime: RuntimeSummary
    @State private var alias = ""
    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            OrbisPageHeader(title: "会话别名", back: { dismiss() }) { EmptyView() }
            VStack(alignment: .leading, spacing: 18) {
                TextField("输入别名，留空恢复电脑端名称", text: $alias, axis: .vertical)
                    .font(.system(size: 15)).lineLimit(1...3).orbisInput().accessibilityLabel("会话别名")
                HStack {
                    Text("仅在本 App 中显示").font(.system(size: 12))
                    Spacer()
                    Text("\(alias.count)/40").font(.system(size: 12, design: .monospaced))
                }.foregroundStyle(OrbisPalette(scheme).secondary)
                HStack(spacing: 14) {
                    OrbisActionButton(title: "恢复默认") { store.setAlias("", for: runtime); dismiss() }
                    OrbisActionButton(title: "保存", symbol: "checkmark") { store.setAlias(alias, for: runtime); dismiss() }
                }
            }.padding(.horizontal, 24)
            Spacer(minLength: 12)
        }.background(OrbisPalette(scheme).base.ignoresSafeArea())
            .onAppear { alias = store.alias(for: runtime) }
            .onChange(of: alias) { _, value in if value.count > 40 { alias = String(value.prefix(40)) } }
    }
}
