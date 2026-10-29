import SwiftUI

struct SessionDirectoryState {
    var query = ""
    var kind: String?
    var archived = false
    var providerKey = "current"
    /// 一次只展开一个目录（与 Android 侧栏一致）；nil 表示用户收起了全部目录。
    var expandedPath: String?
    /// 目录清单换了一批（首次打开、搜索、筛选、切换电脑）时重新挑选默认展开的目录。
    var needsDefaultExpansion = true
    /// 展开目录里是否显示最近 5 条之外的较早会话；换目录时复位。
    var showAllSessions = false
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
    @EnvironmentObject private var overlay: OrbisOverlay

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
        let directories = self.directories
        VStack(spacing: 16) {
            HStack(spacing: 12) {
                Text("会话目录").font(.orbisTitle()).accessibilityAddTraits(.isHeader)
                Spacer()
                OrbisIconButton(symbol: "xmark", label: "关闭会话目录", action: onClose)
            }.padding(.top, 8)
            HStack(spacing: 12) {
                OrbisActionButton(title: "新会话", symbol: "plus") { onNewSession(nil) }
                    .disabled(store.connection != .secured || store.activatingSessionId != nil)
                OrbisIconButton(symbol: "arrow.clockwise", label: "刷新会话目录", action: store.refresh)
                    .disabled(store.selectedHost == nil)
                OrbisMenuIconButton(symbol: "line.3.horizontal.decrease", label: "筛选会话：\(state.kind.map(filterTitle) ?? "全部")",
                                    tint: state.kind == nil ? OrbisPalette(scheme).secondary : OrbisPalette(scheme).accent,
                                    selected: state.kind != nil) { filterMenuItems }
            }
            HStack(spacing: 8) {
                Image(systemName: "magnifyingglass").foregroundStyle(OrbisPalette(scheme).secondary)
                TextField("搜索会话或目录", text: $state.query).font(.orbisBody())
                    .focused($searchFocused).submitLabel(.search).onSubmit { searchFocused = false }
                    .autocorrectionDisabled().textInputAutocapitalization(.never)
                // The clear button keeps its slot so the field never changes width while typing.
                OrbisIconButton(symbol: "xmark", label: "清除搜索", size: 28) { state.query = "" }
                    .opacity(state.query.isEmpty ? 0 : 1).disabled(state.query.isEmpty)
                    .accessibilityHidden(state.query.isEmpty)
            }.padding(.leading, 14).padding(.trailing, 6).frame(minHeight: 56).orbisField(focused: searchFocused)
            // One fixed row carries the title, the active filter and the counts; filtering never inserts a row.
            HStack(spacing: 8) {
                Text(searching ? "搜索结果" : state.archived ? "已归档" : "工作目录")
                    .font(.orbisLabel(.semibold)).accessibilityAddTraits(.isHeader)
                if let kind = state.kind {
                    Text(filterTitle(kind)).font(.orbisCaption(.medium)).foregroundStyle(OrbisPalette(scheme).accent).lineLimit(1)
                    if hasProviderFilter {
                        Text(providerLabel).font(.orbisCaption(.medium)).foregroundStyle(OrbisPalette(scheme).accent).lineLimit(1)
                    }
                }
                Spacer(minLength: 4)
                Text("\(directories.count) 个目录，\(directories.reduce(0) { $0 + $1.sessions.count }) 个会话")
                    .font(.orbisCaption()).foregroundStyle(OrbisPalette(scheme).secondary).fixedSize()
            }.frame(minHeight: 28)
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
            OrbisPalette(scheme).well.frame(height: 2).clipShape(Capsule()).accessibilityHidden(true)
            hostSelector
        }.padding(.horizontal, 18)
            .onAppear(perform: resolveExpansion)
            .onChange(of: directories.map(\.path)) { _, _ in resolveExpansion() }
            .onChange(of: store.selectedHostId) { _, _ in state.providerKey = "current"; restartExpansion() }
            .onChange(of: state.kind) { _, _ in state.providerKey = "current"; restartExpansion() }
            .onChange(of: state.archived) { _, _ in restartExpansion() }
            .onChange(of: state.providerKey) { _, _ in restartExpansion() }
            .onChange(of: state.query) { _, _ in restartExpansion() }
    }

    private var searching: Bool { !state.query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

    private var filterMenuItems: [OrbisMenuItem] {
        var items: [OrbisMenuItem] = []
        if state.kind != nil || state.archived {
            items.append(OrbisMenuItem(title: "清除筛选", symbol: "arrow.uturn.backward") { state.kind = nil; state.archived = false; state.providerKey = "current" })
            items.append(.divider)
        }
        items.append(OrbisMenuItem(title: "全部", checked: state.kind == nil) { state.kind = nil })
        items += ["pi", "codex", "codexDesktop", "dsh", "claude"].map { kind in
            OrbisMenuItem(title: filterTitle(kind), checked: state.kind == kind) { state.kind = kind }
        }
        items.append(.divider)
        items.append(OrbisMenuItem(title: state.archived ? "查看未归档会话" : "查看已归档会话", symbol: state.archived ? "tray.full" : "archivebox") {
            state.archived.toggle()
        })
        if hasProviderFilter {
            items.append(.divider)
            items += providerOptions.map { option in
                OrbisMenuItem(title: option.label, checked: effectiveProviderKey == option.key) { state.providerKey = option.key }
            }
        }
        items.append(.divider)
        items.append(OrbisMenuItem(title: "供应商配置与切换", symbol: "slider.horizontal.3", action: onProviders))
        return items
    }

    /// 只在需要时挑选默认目录：保留用户手动展开或收起的选择，直到目录清单换了一批。
    /// 搜索时展开第一条结果；平时优先当前会话所在目录，否则展开最近使用的目录。
    private func resolveExpansion() {
        let current = directories
        let preferred = searching ? nil : store.selectedRuntime?.cwd
        if state.needsDefaultExpansion {
            guard !current.isEmpty else { return }
            state.expandedPath = defaultExpandedDirectory(current, preferred: preferred)
            state.needsDefaultExpansion = false
            state.showAllSessions = false
        } else if let path = state.expandedPath, !current.contains(where: { $0.path == path }) {
            state.expandedPath = defaultExpandedDirectory(current, preferred: preferred)
            state.showAllSessions = false
        }
    }

    private func restartExpansion() {
        state.needsDefaultExpansion = true
        resolveExpansion()
    }

    private func toggle(_ path: String) {
        state.expandedPath = state.expandedPath == path ? nil : path
        state.showAllSessions = false
        searchFocused = false
    }

    private var emptyTitle: String {
        if !state.query.isEmpty { return "没有匹配的会话" }
        if hasProviderFilter && effectiveProviderKey == "current" && store.currentProvider(for: state.kind ?? "codex") == nil { return "尚未获取当前 provider" }
        return state.archived ? "没有已归档的会话" : "暂无会话"
    }

    private func directoryGroup(_ directory: SessionDirectory) -> some View {
        let expanded = state.expandedPath == directory.path
        let hidden = directory.sessions.count - directorySessionPreviewLimit
        let visible = expanded && (state.showAllSessions || searching || hidden <= 0) ? directory.sessions : Array(directory.sessions.prefix(directorySessionPreviewLimit))
        return VStack(spacing: 0) {
            HStack(spacing: 8) {
                Button { toggle(directory.path) } label: {
                    HStack(spacing: 9) {
                        Image(systemName: expanded ? "folder.fill" : "folder").foregroundStyle(OrbisPalette(scheme).accent)
                        VStack(alignment: .leading, spacing: 3) {
                            Text(directoryTitle(directory.path)).font(.orbisBody(.semibold)).lineLimit(1)
                            Text(directory.path).font(.orbisCaption(mono: true)).foregroundStyle(OrbisPalette(scheme).secondary).lineLimit(1)
                        }.frame(maxWidth: .infinity, alignment: .leading)
                        Text("\(directory.sessions.count)").font(.orbisCaption()).foregroundStyle(OrbisPalette(scheme).secondary)
                        Image(systemName: "chevron.right").imageScale(.small)
                            .rotationEffect(.degrees(expanded ? 90 : 0)).animation(.orbisCollapse, value: expanded)
                    }.padding(12).frame(minHeight: 60).contentShape(Rectangle())
                }.buttonStyle(NeuButtonStyle(selected: expanded))
                    .accessibilityLabel("\(expanded ? "收起" : "展开")目录 \(directory.path)，\(directory.sessions.count) 个会话")
                OrbisIconButton(symbol: "plus", label: "在此目录新建会话") { onNewSession(directory.path) }
                    .disabled(store.connection != .secured || store.activatingSessionId != nil)
            }
            OrbisCollapse(expanded: expanded) {
                VStack(spacing: 10) {
                    ForEach(visible) { session in
                        sessionRow(session).padding(.leading, 12)
                    }
                    if hidden > 0 && !searching {
                        OrbisTextButton(title: state.showAllSessions ? "收起较早会话" : "再显示 \(hidden) 个会话",
                                        symbol: state.showAllSessions ? "chevron.up" : "chevron.down", fill: true) {
                            state.showAllSessions.toggle()
                        }.padding(.leading, 12)
                    }
                }.padding(.top, 10)
            }
        }
    }

    private func sessionRow(_ session: SessionSummary) -> some View {
        let runtime = store.runtimes.first { $0.sessionId == session.sessionId }
        return HStack(spacing: 4) {
            Button {
                searchFocused = false
                if runtime != nil, let problem = store.providerMismatch(session) { showMismatch(problem) }
                else { onOpenSession(session) }
            } label: {
                HStack(spacing: 8) {
                    // Activation swaps the emblem for a spinner in the same slot; the title never reflows.
                    ZStack {
                        AgentEmblem(kind: session.agentKind, size: 24, recessed: false)
                            .opacity(store.activatingSessionId == session.sessionId ? 0 : 1)
                        if store.activatingSessionId == session.sessionId { ProgressView().controlSize(.small) }
                    }.frame(width: 24, height: 24)
                    VStack(alignment: .leading, spacing: 4) {
                        Text(store.displayName(session)).font(.orbisBody()).lineLimit(2)
                        HStack(spacing: 8) {
                            if let runtime { RuntimeStatusLabel(status: runtime.status) }
                            else { Text("缓存历史").font(.orbisCaption()).foregroundStyle(OrbisPalette(scheme).secondary) }
                            Text(sessionTimeTitle(session.modifiedAt))
                                .font(.orbisCaption()).foregroundStyle(OrbisPalette(scheme).secondary)
                            if session.agentKind == "codexDesktop" {
                                Text("桌面版").font(.orbisCaption()).foregroundStyle(OrbisPalette(scheme).agent(session.agentKind))
                            }
                            if let provider = sessionOtherProvider(session, current: store.currentProvider(for: session.agentKind ?? "")) {
                                Text(provider).font(.orbisCaption()).foregroundStyle(OrbisPalette(scheme).warning)
                            }
                        }.lineLimit(1)
                    }.frame(maxWidth: .infinity, alignment: .leading)
                }.padding(12).contentShape(Rectangle())
            }.buttonStyle(.plain)
                .disabled(store.activatingSessionId != nil)
            OrbisMenuIconButton(symbol: "ellipsis", label: "会话操作", size: 30) {
                [OrbisMenuItem(title: "在电脑继续会话", symbol: "play", disabled: store.connection != .secured || store.activatingSessionId != nil) {
                    if let problem = store.providerMismatch(session) { showMismatch(problem) } else { store.activate(session) }
                }, OrbisMenuItem(title: state.archived ? "取消归档" : "归档会话", symbol: state.archived ? "tray.and.arrow.up" : "archivebox",
                               disabled: store.connection != .secured || session.agentKind == nil) {
                    store.archive(session, archived: !state.archived)
                }]
            }.padding(.trailing, 2).accessibilityIdentifier("session-actions-" + session.sessionId)
        }.neuSurface(inset: store.selectedRuntime?.sessionId == session.sessionId, radius: 16, intensity: 0.45)
    }

    private func showMismatch(_ problem: String) {
        overlay.showDialog("需要切换 provider", message: problem, actions: [
            OrbisDialogAction(title: "取消", role: .cancel),
            OrbisDialogAction(title: "供应商设置", action: onProviders)
        ])
    }

    private var hostSelector: some View {
        HStack(spacing: 10) {
            OrbisMenuButton(accessibilityLabel: "切换电脑，当前 \(store.selectedHost?.hostName ?? "未选择")", items: { hostSwitchMenuItems(store, onAddHost: onAddHost) }) {
                HStack(spacing: 10) {
                    Image(systemName: "desktopcomputer").foregroundStyle(OrbisPalette(scheme).accent)
                    VStack(alignment: .leading, spacing: 3) {
                        Text("电脑").font(.orbisCaption()).foregroundStyle(OrbisPalette(scheme).secondary)
                        Text(store.selectedHost?.hostName ?? "选择电脑").font(.orbisBody(.semibold)).lineLimit(1)
                    }
                    Spacer()
                    Image(systemName: "chevron.up.chevron.down").imageScale(.small).foregroundStyle(OrbisPalette(scheme).secondary)
                }.padding(12).frame(minHeight: 58).contentShape(Rectangle())
            }
            if let host = store.selectedHost {
                OrbisMenuIconButton(symbol: "ellipsis", label: "当前电脑操作") {
                    [OrbisMenuItem(title: "取消配对 \(host.hostName)", symbol: "link", destructive: true) { onUnpair(host) }]
                }
            }
        }.padding(.bottom, 18)
    }
}

private func filterTitle(_ kind: String) -> String {
    switch kind {
    case "codex": return "Codex 终端"
    case "codexDesktop": return "Codex 桌面版"
    case "dsh": return "DeepSeek"
    case "claude": return "Claude Code"
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
            OrbisPageHeader(title: "新建会话", closes: true, back: onDismiss) {
                Label(store.selectedHost?.hostName ?? "电脑", systemImage: "desktopcomputer").font(.orbisCaption())
                    .foregroundStyle(OrbisPalette(scheme).secondary).lineLimit(1)
            }
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 14) {
                        ForEach(["pi", "codex", "codexDesktop", "dsh", "claude"], id: \.self) { agent in
                            Button { kind = agent } label: {
                                HStack(spacing: 8) {
                                    AgentEmblem(kind: agent, size: 22, recessed: false)
                                    Text(filterTitle(agent)).lineLimit(2)
                                    // Reserved even when unchecked so the label does not shift on selection.
                                    Image(systemName: "checkmark").opacity(kind == agent ? 1 : 0)
                                }.font(.orbisLabel(.semibold)).foregroundStyle(OrbisPalette(scheme).agent(agent)).frame(maxWidth: .infinity, minHeight: 60).padding(.horizontal, 10)
                            }.buttonStyle(NeuButtonStyle(selected: kind == agent)).disabled(!allowedAgents.contains(agent))
                                .accessibilityAddTraits(kind == agent ? .isSelected : [])
                        }
                    }
                    if let presetCwd {
                        Label(presetCwd, systemImage: "folder").font(.orbisLabel(mono: true)).frame(maxWidth: .infinity, alignment: .leading)
                            .neuSurface(inset: true, radius: 16, intensity: 0.45, padding: 16)
                    } else { RemoteDirectoryView() }
                    if store.connection != .secured { OrbisNotice(text: "未连接到电脑") }
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
                    .font(.orbisCaption(mono: true)).frame(maxWidth: .infinity, alignment: .leading)
                // Spinner and refresh share one fixed slot so the path never reflows while loading.
                ZStack {
                    if store.browse?.loading == true { ProgressView().controlSize(.small) }
                    else { OrbisIconButton(symbol: "arrow.clockwise", label: "刷新目录") { store.browseDirectory(store.browse?.path) }.disabled(store.connection != .secured) }
                }.frame(width: 48, height: 48)
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
                if entries.isEmpty { Text("此目录没有子目录").font(.orbisLabel()).foregroundStyle(OrbisPalette(scheme).secondary).padding(16) }
                ForEach(entries) { entry in
                    Button { store.browseDirectory(remoteBrowsePath(parent: store.browse?.path, name: entry.name)) } label: {
                        HStack(spacing: 10) {
                            Image(systemName: "folder").foregroundStyle(OrbisPalette(scheme).accent)
                            Text(entry.name).font(.orbisBody()).frame(maxWidth: .infinity, alignment: .leading)
                            if entry.hasSessions { Text("有历史").font(.orbisCaption()).foregroundStyle(OrbisPalette(scheme).accent) }
                            Image(systemName: "chevron.right").imageScale(.small)
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
    @FocusState private var focused: Bool
    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            OrbisPageHeader(title: "会话别名", closes: true, back: { dismiss() }) { EmptyView() }
            VStack(alignment: .leading, spacing: 18) {
                TextField("会话别名", text: $alias, axis: .vertical)
                    .font(.orbisBody()).lineLimit(1...3).focused($focused).orbisInput(focused: focused).accessibilityLabel("会话别名")
                Text("\(alias.count)/40").font(.orbisCaption()).foregroundStyle(OrbisPalette(scheme).secondary)
                    .frame(maxWidth: .infinity, alignment: .trailing)
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
