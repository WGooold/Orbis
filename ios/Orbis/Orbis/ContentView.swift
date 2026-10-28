import SwiftUI

private enum AppPage: Hashable { case chat, pairing, status, settings, providers, history, downloads }

struct ContentView: View {
    @EnvironmentObject private var store: OrbisStore
    @Environment(\.colorScheme) private var scheme
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var pages: [AppPage] = []
    @State private var drawerOpen = false
    @State private var directoryState = SessionDirectoryState()
    @State private var newSessionOpen = false
    @State private var newSessionCwd: String?
    @State private var aliasRuntime: RuntimeSummary?
    @State private var unpairHost: HostPairing?

    init() {
        #if DEBUG
        let preview = ProcessInfo.processInfo.arguments.first { $0.hasPrefix("--preview-screen=") }?.split(separator: "=").last.map(String.init)
        switch preview {
        case "chat", "slash", "approval", "tool": _pages = State(initialValue: [.chat])
        case "status": _pages = State(initialValue: [.status])
        case "settings": _pages = State(initialValue: [.settings])
        case "providers": _pages = State(initialValue: [.settings, .providers])
        case "downloads": _pages = State(initialValue: [.downloads])
        case "history": _pages = State(initialValue: [.chat, .history])
        case "drawer": _drawerOpen = State(initialValue: true)
        case "new-session": _newSessionOpen = State(initialValue: true)
        default: break
        }
        #endif
    }

    var body: some View {
        NavigationStack(path: $pages) {
            Group {
                if store.pairings.isEmpty {
                    PairingEntryView(onCancel: nil, onCode: store.pair)
                } else {
                    HomeView(onDirectory: { setDrawer(true) }, onStatus: { pages.append(.status) },
                             onSettings: { pages.append(.settings) }, onAddHost: { pages.append(.pairing) },
                             onDownloads: { pages.append(.downloads) }, onUnpair: { unpairHost = store.selectedHost }, onAlias: { aliasRuntime = $0 },
                             onOpenRuntime: openRuntime)
                }
            }
            .toolbar(.hidden, for: .navigationBar)
            .navigationDestination(for: AppPage.self) { page in
                Group {
                    switch page {
                    case .chat:
                        if let runtime = store.selectedRuntime {
                            ChatView(runtime: runtime, onBack: back, onHistory: { pages.append(.history) }, onDownloads: { pages.append(.downloads) }, onAlias: { aliasRuntime = runtime })
                                .id(localSessionKey(host: store.selectedHost, runtime: runtime))
                        } else { OrbisEmptyState(symbol: "desktopcomputer", title: "会话已离线", detail: "返回会话目录，重新打开会话。") }
                    case .pairing: PairingEntryView(onCancel: back, onCode: store.pair)
                    case .status: ConnectionStatusView(onBack: back, onSettings: { pages.append(.settings) })
                    case .settings: SettingsView(onBack: back, onProviders: { pages.append(.providers) })
                    case .providers: AgentProvidersView(onBack: back)
                    case .history: HistoryBranchView(onBack: back)
                    case .downloads: DownloadsView(onBack: back)
                    }
                }
                .foregroundStyle(OrbisPalette(scheme).text)
                .background(OrbisPalette(scheme).base.ignoresSafeArea())
                .toolbar(.hidden, for: .navigationBar)
            }
        }
        .environmentObject(store.transfers)
        .environmentObject(store.toolInventories)
        .environmentObject(store.hostState)
        .tint(OrbisPalette(scheme).accent)
        .foregroundStyle(OrbisPalette(scheme).text)
        .background(OrbisPalette(scheme).base.ignoresSafeArea())
        .accessibilityHidden(drawerOpen)
        .overlay { if drawerOpen { drawer } }
        .overlay(alignment: .top) {
            if let error = store.errorMessage {
                HStack(alignment: .top, spacing: 10) {
                    OrbisNotice(text: error, error: true)
                    OrbisIconButton(symbol: "xmark", label: "关闭错误提示") { store.errorMessage = nil }
                }.padding(16).background(OrbisPalette(scheme).base)
                    .accessibilityElement(children: .contain)
            }
        }
        .overlay(alignment: .bottom) { TransferErrorBanner(transfers: store.transfers) }
        .sheet(isPresented: $newSessionOpen, onDismiss: store.dismissBrowse) {
            NewSessionView(presetCwd: newSessionCwd) { newSessionOpen = false }
                .environmentObject(store).presentationDetents([.large]).presentationDragIndicator(.visible)
                .presentationCornerRadius(28)
        }
        .sheet(item: $aliasRuntime) { runtime in
            SessionAliasView(runtime: runtime).environmentObject(store)
                .presentationDetents([.medium]).presentationDragIndicator(.visible).presentationCornerRadius(28)
        }
        .confirmationDialog("取消配对这台电脑？", isPresented: Binding(get: { unpairHost != nil }, set: { if !$0 { unpairHost = nil } }), titleVisibility: .visible) {
            if let host = unpairHost {
                Button("取消配对 \(host.hostName)", role: .destructive) {
                    store.unpair(hostId: host.hostId); unpairHost = nil; pages = []; setDrawer(false)
                }
            }
            Button("返回", role: .cancel) { unpairHost = nil }
        } message: { Text("此电脑在本机保存的配对、草稿和别名将被移除。之后可以重新扫码连接。") }
        .onChange(of: store.activationRevision) { _, _ in
            setDrawer(false); newSessionOpen = false
            if store.selectedRuntime != nil { pages = [.chat] }
        }
        .onChange(of: store.selectedRuntimeId) { old, next in
            if old != nil && next == nil && pages.contains(.chat) { pages = [] }
        }
        .onChange(of: store.isPairing) { old, active in
            if old && !active && store.errorMessage == nil && store.selectedHost != nil { pages = [] }
        }
        .onChange(of: scenePhase) { old, new in
            if new != .active { store.toolContent.close() }
            if old == .background && new == .active { store.refresh() }
        }
        .overlay {
            if store.isPairing {
                ZStack {
                    Color.black.opacity(0.25).ignoresSafeArea()
                    VStack(spacing: 14) {
                        ProgressView()
                        Text("正在安全配对…").font(.system(size: 15, weight: .medium))
                    }.padding(30).neuSurface(radius: 28)
                }.accessibilityAddTraits(.updatesFrequently)
            }
        }
    }

    private var drawer: some View {
        GeometryReader { geometry in
            ZStack(alignment: .leading) {
                Color.black.opacity(0.32).ignoresSafeArea().onTapGesture { setDrawer(false) }
                    .accessibilityLabel("关闭会话目录").accessibilityAddTraits(.isButton)
                SessionDrawerView(state: $directoryState, onClose: { setDrawer(false) },
                                  onOpenSession: { session in
                                      if let runtime = store.runtimes.first(where: { $0.sessionId == session.sessionId }) { openRuntime(runtime) }
                                      else { store.activate(session) }
                                  },
                                  onNewSession: { cwd in
                                      newSessionCwd = cwd; setDrawer(false); newSessionOpen = true
                                  }, onAddHost: { setDrawer(false); pages.append(.pairing) },
                                  onProviders: { setDrawer(false); pages.append(.settings); pages.append(.providers) },
                                  onUnpair: { unpairHost = $0 })
                    .frame(width: min(380, geometry.size.width * 0.9))
                    .background(OrbisPalette(scheme).base.ignoresSafeArea())
                    .transition(.move(edge: .leading))
                    .gesture(DragGesture(minimumDistance: 35).onEnded { if $0.translation.width < -65 { setDrawer(false) } })
            }
        }.accessibilityAddTraits(.isModal)
    }

    private func back() { if !pages.isEmpty { pages.removeLast() } }
    private func setDrawer(_ open: Bool) {
        withAnimation(reduceMotion ? nil : .easeInOut(duration: 0.22)) { drawerOpen = open }
    }
    private func openRuntime(_ runtime: RuntimeSummary) {
        store.selectRuntime(runtime.runtimeId); setDrawer(false); pages = [.chat]
    }
}

private struct TransferErrorBanner: View {
    @ObservedObject var transfers: FileTransfers
    var body: some View {
        if let error = transfers.error {
            HStack {
                OrbisNotice(text: error, error: true)
                OrbisIconButton(symbol: "xmark", label: "关闭文件提示") { transfers.error = nil }
            }.padding(16)
        }
    }
}

struct HomeView: View {
    @EnvironmentObject private var store: OrbisStore
    @Environment(\.colorScheme) private var scheme
    let onDirectory: () -> Void
    let onStatus: () -> Void
    let onSettings: () -> Void
    let onAddHost: () -> Void
    let onDownloads: () -> Void
    let onUnpair: () -> Void
    let onAlias: (RuntimeSummary) -> Void
    let onOpenRuntime: (RuntimeSummary) -> Void

    var body: some View {
        VStack(spacing: 0) {
            OrbisHeader {
                OrbisIconButton(symbol: "line.3.horizontal", label: "打开会话目录", action: onDirectory)
            } title: {
                VStack(alignment: .leading, spacing: 3) {
                    Text("Orbis").font(.system(size: 23, weight: .semibold))
                        .foregroundStyle(Color(hex: scheme == .dark ? 0xB8C0CE : 0x899CB7))
                        .shadow(color: OrbisPalette(scheme).light, radius: 0, x: 1, y: 1)
                    Text("Easy Agents EveryWhere").font(.system(size: 10, weight: .semibold)).tracking(0.6)
                        .foregroundStyle(LinearGradient(colors: [OrbisPalette(scheme).accent, OrbisPalette(scheme).success], startPoint: .leading, endPoint: .trailing))
                        .lineLimit(1).minimumScaleFactor(0.8)
                }
            } trailing: {
                OrbisIconButton(symbol: "arrow.down.to.line", label: "下载", action: onDownloads)
                Menu {
                    Button("连接状态", systemImage: "info.circle", action: onStatus)
                    Button("设置", systemImage: "gearshape", action: onSettings)
                    Button("添加电脑", systemImage: "plus", action: onAddHost)
                    Button("取消配对当前电脑", systemImage: "link.badge.plus", role: .destructive, action: onUnpair)
                } label: {
                    Image(systemName: "ellipsis").font(.system(size: 20, weight: .semibold))
                        .frame(width: 40, height: 40).neuSurface(radius: 20, intensity: 0.5).frame(width: 48, height: 48)
                }.accessibilityLabel("更多操作")
            }
            HStack {
                Button(action: onStatus) { ConnectionPill() }.buttonStyle(.plain)
                Spacer()
                if store.connection == .offline || store.connection == .error {
                    Button("重新连接", action: store.reconnectSelectedHost).font(.system(size: 12, weight: .semibold)).frame(minHeight: 48)
                }
            }.padding(.horizontal, 20).padding(.bottom, 6)
            if store.runtimes.isEmpty {
                OrbisEmptyState(symbol: "desktopcomputer", title: "暂无在线会话",
                                detail: store.connection == .secured ? "在电脑端启动 Agent，或在会话目录中新建。" : "连接电脑后，在线会话会出现在这里。")
                OrbisActionButton(title: "查看会话目录", symbol: "folder", action: onDirectory)
                    .padding(.horizontal, 24).padding(.bottom, 32)
            } else {
                ScrollView {
                    LazyVStack(spacing: 16) {
                        ForEach(store.runtimes.sorted { store.displayName($0).localizedStandardCompare(store.displayName($1)) == .orderedAscending }) { runtime in
                            runtimeCard(runtime)
                        }
                    }.padding(.horizontal, 20).padding(.top, 12).padding(.bottom, 28)
                }.refreshable { store.refresh() }
            }
        }.frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(OrbisPalette(scheme).base.ignoresSafeArea())
    }

    private func runtimeCard(_ runtime: RuntimeSummary) -> some View {
        Button { onOpenRuntime(runtime) } label: {
            HStack(spacing: 12) {
                AgentEmblem(kind: runtime.agentKind)
                VStack(alignment: .leading, spacing: 6) {
                    Text(store.displayName(runtime)).font(.system(size: 16, weight: .semibold)).lineLimit(1)
                    Text("\(store.selectedHost?.hostName ?? "电脑")-\(runtime.cwd)")
                        .font(.system(size: 12, design: .monospaced)).foregroundStyle(OrbisPalette(scheme).secondary).lineLimit(1)
                    HStack(spacing: 10) {
                        Text(agentTitle(runtime.agentKind)).font(.system(size: 12, weight: .medium)).foregroundStyle(OrbisPalette(scheme).agent(runtime.agentKind))
                        RuntimeStatusLabel(status: runtime.status)
                    }
                    if !(store.interactions[runtime.runtimeId] ?? []).isEmpty {
                        Label("待确认 · 打开会话完成交互", systemImage: "exclamationmark.circle")
                            .font(.system(size: 11)).foregroundStyle(OrbisPalette(scheme).error)
                    }
                }.frame(maxWidth: .infinity, alignment: .leading)
            }.padding(16).padding(.trailing, 52)
        }.buttonStyle(NeuButtonStyle(radius: 20))
            .overlay(alignment: .trailing) {
                OrbisIconButton(symbol: "pencil", label: "修改会话别名") { onAlias(runtime) }.padding(.trailing, 12)
            }.accessibilityElement(children: .contain)
    }

}

struct ConnectionPill: View {
    @EnvironmentObject private var store: OrbisStore
    @Environment(\.colorScheme) private var scheme
    var body: some View {
        HStack(spacing: 7) {
            Circle().fill(store.connection == .secured ? OrbisPalette(scheme).success : store.connection == .error ? OrbisPalette(scheme).error : .orange)
                .frame(width: 7, height: 7)
            Text(connectionTitle(store.connection)).font(.system(size: 12, weight: .medium))
            if store.connection == .secured { Image(systemName: "lock.shield").font(.system(size: 11)) }
        }.foregroundStyle(OrbisPalette(scheme).secondary).padding(.horizontal, 12).frame(minHeight: 36)
            .neuSurface(inset: true, radius: 18, intensity: 0.35)
    }
}

func connectionTitle(_ state: ConnectionState) -> String {
    switch state {
    case .offline: return "未连接"
    case .connecting: return "正在连接"
    case .online: return "正在建立安全通道"
    case .secured: return "端到端加密已连接"
    case .error: return "连接错误"
    }
}
