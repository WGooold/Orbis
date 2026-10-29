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
    @StateObject private var overlay = OrbisOverlay()

    init() {
        #if DEBUG
        let preview = ProcessInfo.processInfo.arguments.first { $0.hasPrefix("--preview-screen=") }?.split(separator: "=").last.map(String.init)
        switch preview {
        case "chat", "slash", "approval", "tool", "queue", "notices", "interactions", "truncated", "viewport": _pages = State(initialValue: [.chat])
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
                             onDownloads: { pages.append(.downloads) }, onUnpair: { confirmUnpair(store.selectedHost) }, onAlias: { aliasRuntime = $0 },
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
                        } else { OrbisEmptyState(symbol: "desktopcomputer", title: "会话已离线") }
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
                // 位移作用在整个页面（含底色）上，拖动时底层露出的是会话列表，而不是空白。
                .modifier(SwipeBackModifier(enabled: page == .chat, onBack: back))
            }
        }
        .environmentObject(store.transfers)
        .environmentObject(store.toolInventories)
        .environmentObject(store.hostState)
        .environmentObject(store.notifications)
        .environmentObject(store.agentState)
        .tint(OrbisPalette(scheme).accent)
        .foregroundStyle(OrbisPalette(scheme).text)
        .background(OrbisPalette(scheme).base.ignoresSafeArea())
        .accessibilityHidden(drawerOpen)
        .modifier(SessionDrawerModifier(isOpen: $drawerOpen, edgeSwipeEnabled: pages.isEmpty && !store.pairings.isEmpty && !store.isPairing) {
            drawer
        })
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
                .environmentObject(store).orbisSheet([.large])
        }
        .sheet(item: $aliasRuntime) { runtime in
            SessionAliasView(runtime: runtime).environmentObject(store).orbisSheet([.medium])
        }
        .onChange(of: pages) { _, _ in overlay.dismissMenu() }
        .onChange(of: drawerOpen) { _, open in if !open { overlay.dismissMenu() } }
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
                    OrbisPalette(scheme).scrim.opacity(0.25).ignoresSafeArea()
                    VStack(spacing: 14) {
                        ProgressView()
                        Text("正在安全配对…").font(.orbisBody(.medium))
                    }.neuSurface(radius: OrbisRadius.dialog, padding: 30)
                }.accessibilityAddTraits(.updatesFrequently)
            }
        }
        .orbisOverlayHost(overlay)
    }

    private var drawer: some View {
        SessionDrawerView(state: $directoryState, onClose: { setDrawer(false) },
                          onOpenSession: { session in
                              if let runtime = store.runtimes.first(where: { $0.sessionId == session.sessionId }) { openRuntime(runtime) }
                              else if store.openCachedSession(session) { setDrawer(false); pages = [.chat] }
                              else {
                                  overlay.showDialog("本机尚无缓存", message: "连接电脑并打开会话后，可把历史保存在本机。", actions: [OrbisDialogAction(title: "返回", role: .cancel)] + (store.connection == .secured ? [OrbisDialogAction(title: "在电脑继续会话") { store.activate(session) }] : []))
                              }
                          },
                          onNewSession: { cwd in
                              newSessionCwd = cwd; setDrawer(false); newSessionOpen = true
                          }, onAddHost: { setDrawer(false); pages.append(.pairing) },
                          onProviders: { setDrawer(false); pages.append(.settings); pages.append(.providers) },
                          onUnpair: { confirmUnpair($0) })
    }

    private func back() { if !pages.isEmpty { pages.removeLast() } }
    private func setDrawer(_ open: Bool) {
        withAnimation(reduceMotion ? nil : .orbisDrag) { drawerOpen = open }
    }
    private func confirmUnpair(_ host: HostPairing?) {
        guard let host else { return }
        overlay.showDialog("取消配对这台电脑？", message: "此电脑在本机保存的配对、草稿和别名将被移除。之后可以重新扫码连接。", actions: [
            OrbisDialogAction(title: "返回", role: .cancel),
            OrbisDialogAction(title: "取消配对 \(host.hostName)", role: .destructive) {
                store.unpair(hostId: host.hostId); pages = []; setDrawer(false)
            }
        ])
    }
    private func openRuntime(_ runtime: RuntimeSummary) {
        store.selectRuntime(runtime.runtimeId); setDrawer(false); pages = [.chat]
    }
}

/// 会话目录抽屉。关闭时在主页左侧（左 40% 宽度内）起手向右横拖即把抽屉拉出；打开时在抽屉
/// 或遮罩上向左拖动即推回。拖动过程中抽屉与遮罩跟随手指，松手按位置与速度吸附到打开或关闭。
/// 拉出手势挂在页面内容上与之同时识别，并按第一段位移锁定方向，竖向滚动主页时不会带出抽屉。
private struct SessionDrawerModifier<Drawer: View>: ViewModifier {
    @Environment(\.colorScheme) private var scheme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Binding var isOpen: Bool
    let edgeSwipeEnabled: Bool
    @ViewBuilder let drawer: Drawer
    /// 拖动中抽屉相对完全打开位置的水平偏移，范围 [-width, 0]；nil 表示没有在拖动。
    @State private var offset: CGFloat?
    /// 按第一段位移锁定方向：true 横向带动抽屉，false 交给滚动等其他手势。
    @State private var horizontalDrag: Bool?
    /// 横拖抽屉期间停用手指下的按钮：从会话卡片或目录行上起手拖动时，松手不能再触发它们。
    @State private var suppressTaps = false
    @State private var containerWidth: CGFloat = 390

    private var width: CGFloat { min(380, containerWidth * 0.9) }

    func body(content: Content) -> some View {
        content
            .disabled(suppressTaps)
            .simultaneousGesture(edgeSwipeEnabled && !isOpen ? openGesture : nil)
            .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { containerWidth = $0 }
            .overlay {
                let visible = isOpen || offset != nil
                let progress = visible ? max(0, min(1, 1 + (offset ?? 0) / width)) : 0
                ZStack(alignment: .leading) {
                    if visible {
                        OrbisPalette(scheme).scrim.opacity(0.32 * progress).ignoresSafeArea()
                            .contentShape(Rectangle())
                            .onTapGesture { close() }
                            .accessibilityLabel("关闭会话目录").accessibilityAddTraits(.isButton)
                            .transition(.opacity)
                        drawer
                            .disabled(suppressTaps)
                            .frame(width: width)
                            .frame(maxHeight: .infinity)
                            .background(OrbisPalette(scheme).base.ignoresSafeArea())
                            .offset(x: offset ?? 0)
                            .transition(.move(edge: .leading))
                            .accessibilityAddTraits(.isModal)
                    }
                    // 紧贴屏幕左缘起手时，挂在内容上的同时手势会被系统边缘手势拦下，这里单独接住。
                    // 拉出过程中这条窄带必须一直存在，否则手势会随视图移除而被取消。
                    if edgeSwipeEnabled && !isOpen {
                        Color.clear.frame(width: 20).frame(maxHeight: .infinity)
                            .contentShape(Rectangle())
                            .gesture(openGesture)
                            .accessibilityHidden(true)
                    }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
                .simultaneousGesture(isOpen ? closeGesture : nil)
            }
    }

    private var openGesture: some Gesture {
        DragGesture(minimumDistance: 12, coordinateSpace: .global)
            .onChanged { value in
                if horizontalDrag == nil {
                    horizontalDrag = value.startLocation.x < containerWidth * 0.4 &&
                        value.translation.width > abs(value.translation.height) * 1.5
                }
                guard horizontalDrag == true else { return }
                suppressTaps = true
                offset = min(0, max(-width, value.translation.width - width))
            }
            .onEnded { value in
                let horizontal = horizontalDrag == true
                horizontalDrag = nil
                guard horizontal else { return }
                releaseTaps()
                settle(open: value.predictedEndTranslation.width > width / 2)
            }
    }

    private var closeGesture: some Gesture {
        DragGesture(minimumDistance: 12, coordinateSpace: .global)
            .onChanged { value in
                if horizontalDrag == nil {
                    horizontalDrag = abs(value.translation.width) > abs(value.translation.height)
                }
                guard horizontalDrag == true else { return }
                suppressTaps = true
                offset = min(0, max(-width, value.translation.width))
            }
            .onEnded { value in
                let horizontal = horizontalDrag == true
                horizontalDrag = nil
                guard horizontal else { return }
                releaseTaps()
                settle(open: value.predictedEndTranslation.width > -width / 2)
            }
    }

    /// 等同一次松手里按钮的动作判定过去，再恢复按钮。
    private func releaseTaps() {
        DispatchQueue.main.async { suppressTaps = false }
    }

    private func settle(open: Bool) {
        let animation: Animation? = reduceMotion ? nil : .orbisDrag
        if open {
            withAnimation(animation) { isOpen = true; offset = nil }
        } else if offset == nil {
            withAnimation(animation) { isOpen = false }
        } else {
            // 先把抽屉滑到屏幕外，再移除，避免移除转场从完全打开的位置重新开始。
            withAnimation(animation) { offset = -width } completion: {
                isOpen = false; offset = nil
            }
        }
    }

    private func close() {
        withAnimation(reduceMotion ? nil : .orbisDrag) { isOpen = false; offset = nil }
    }
}

/// 聊天页右滑返回。导航栏隐藏后系统侧滑返回失效，这里在页面上同时识别一个横向拖动：
/// 按第一段位移锁定方向，向右横拖时页面跟随手指，松手按位置与速度决定返回或回弹。
private struct SwipeBackModifier: ViewModifier {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let enabled: Bool
    let onBack: () -> Void
    @State private var offset: CGFloat = 0
    @State private var horizontalDrag: Bool?
    @State private var containerWidth: CGFloat = 390

    func body(content: Content) -> some View {
        content
            .offset(x: offset)
            .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { containerWidth = $0 }
            .simultaneousGesture(enabled ? gesture : nil)
    }

    private var gesture: some Gesture {
        DragGesture(minimumDistance: 12, coordinateSpace: .global)
            .onChanged { value in
                if horizontalDrag == nil {
                    horizontalDrag = value.translation.width > abs(value.translation.height) * 1.5
                }
                guard horizontalDrag == true else { return }
                offset = max(0, value.translation.width)
            }
            .onEnded { value in
                let horizontal = horizontalDrag == true
                horizontalDrag = nil
                guard horizontal else { return }
                if value.predictedEndTranslation.width > containerWidth / 3 {
                    onBack()
                } else {
                    withAnimation(reduceMotion ? nil : .orbisDrag) { offset = 0 }
                }
            }
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
                VStack(alignment: .leading, spacing: 2) {
                    Text("Orbis").font(.orbisTitle())
                        .foregroundStyle(Color(hex: scheme == .dark ? 0xB8C0CE : 0x899CB7))
                        .shadow(color: OrbisPalette(scheme).light, radius: 0, x: 1, y: 1)
                    Text("Easy Agents EveryWhere").font(.orbisCaption(.semibold)).tracking(0.4)
                        .foregroundStyle(LinearGradient(colors: [OrbisPalette(scheme).accent, OrbisPalette(scheme).success], startPoint: .leading, endPoint: .trailing))
                        .lineLimit(1)
                }
            } trailing: {
                OrbisIconButton(symbol: "arrow.down.to.line", label: "下载", action: onDownloads)
                OrbisMenuIconButton(symbol: "ellipsis", label: "更多操作") {
                    [OrbisMenuItem(title: "连接状态", symbol: "info.circle", action: onStatus),
                     OrbisMenuItem(title: "设置", symbol: "gearshape", action: onSettings),
                     OrbisMenuItem(title: "添加电脑", symbol: "plus", action: onAddHost),
                     .divider,
                     OrbisMenuItem(title: "取消配对当前电脑", symbol: "link", destructive: true, action: onUnpair)]
                }
            }
            // Fixed height: the reconnect action appears inside this row without moving the cards.
            HStack {
                Button(action: onStatus) { ConnectionPill() }.buttonStyle(.plain)
                Spacer()
                if store.connection == .offline || store.connection == .error {
                    OrbisTextButton(title: "重新连接", symbol: "arrow.clockwise", action: store.reconnectSelectedHost)
                }
            }.frame(height: 48).padding(.horizontal, 20).padding(.bottom, 2)
            if store.hosts.allSatisfy({ $0.runtimes.isEmpty }) {
                OrbisEmptyState(symbol: "desktopcomputer", title: "暂无在线会话")
                OrbisActionButton(title: "查看会话目录", symbol: "folder", action: onDirectory)
                    .padding(.horizontal, 24).padding(.bottom, 32)
            } else {
                ScrollView {
                    LazyVStack(spacing: 16) {
                        ForEach(store.hosts) { host in
                            HStack {
                                Button { store.selectHost(host.hostId) } label: {
                                    Label(host.name, systemImage: host.hostId == store.selectedHostId ? "desktopcomputer" : "desktopcomputer.trianglebadge.exclamationmark")
                                        .font(.orbisLabel(.semibold))
                                }.buttonStyle(.plain)
                                Spacer()
                                Text(connectionTitle(host.connectionState)).font(.orbisCaption()).foregroundStyle(OrbisPalette(scheme).secondary)
                            }.padding(.horizontal, 4).padding(.top, 8)
                            ForEach(host.runtimes.sorted { host.connection.displayName($0).localizedStandardCompare(host.connection.displayName($1)) == .orderedAscending }) { runtime in
                                runtimeCard(runtime, host: host)
                            }
                            if host.runtimes.isEmpty { Text("这台电脑暂无在线会话").font(.orbisCaption()).foregroundStyle(OrbisPalette(scheme).secondary).padding(12) }
                        }
                    }.padding(.horizontal, 20).padding(.top, 12).padding(.bottom, 28)
                }.refreshable { store.refresh() }
            }
        }.frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(OrbisPalette(scheme).base.ignoresSafeArea())
    }

    private func runtimeCard(_ runtime: RuntimeSummary, host: HostSnapshot) -> some View {
        let kind = host.connection.agentKind(runtime)
        let pending = !(host.connection.interactions[runtime.runtimeId] ?? []).isEmpty
        return Button { store.selectRuntime(hostId: host.hostId, runtimeId: runtime.runtimeId); onOpenRuntime(runtime) } label: {
            HStack(spacing: 12) {
                AgentEmblem(kind: kind)
                VStack(alignment: .leading, spacing: 6) {
                    Text(host.connection.displayName(runtime)).font(.orbisBody(.semibold)).lineLimit(1)
                    Text("\(host.name)-\(runtime.cwd)")
                        .font(.orbisCaption(mono: true)).foregroundStyle(OrbisPalette(scheme).secondary).lineLimit(1)
                    HStack(spacing: 10) {
                        Text(agentTitle(kind)).font(.orbisCaption(.medium)).foregroundStyle(OrbisPalette(scheme).agent(kind))
                        // A pending interaction takes the status slot instead of adding a line to the card.
                        if pending {
                            Label("待确认", systemImage: "exclamationmark.circle").font(.orbisCaption(.semibold))
                                .foregroundStyle(OrbisPalette(scheme).error)
                        } else { RuntimeStatusLabel(status: runtime.status) }
                    }
                }.frame(maxWidth: .infinity, alignment: .leading)
            }.padding(.trailing, 52)
        }.buttonStyle(NeuButtonStyle(radius: OrbisRadius.card, padding: OrbisRadius.cardPadding + 4))
            .overlay(alignment: .trailing) {
                OrbisIconButton(symbol: "pencil", label: "修改会话别名") { store.selectHost(host.hostId); onAlias(runtime) }
                    .orbisNested().padding(.trailing, 12)
            }.accessibilityElement(children: .contain)
    }

}

struct ConnectionPill: View {
    @EnvironmentObject private var store: OrbisStore
    @Environment(\.colorScheme) private var scheme
    var body: some View {
        HStack(spacing: 7) {
            Circle().fill(store.connection == .secured ? OrbisPalette(scheme).success : store.connection == .error ? OrbisPalette(scheme).error : OrbisPalette(scheme).warning)
                .frame(width: 7, height: 7)
            Text(connectionTitle(store.connection))
            if store.connection == .secured { Image(systemName: "lock.shield") }
        }.font(.orbisCaption(.medium)).foregroundStyle(OrbisPalette(scheme).secondary).padding(.horizontal, 12).frame(minHeight: 36)
            .neuSurface(inset: true, radius: 18, intensity: 0.35, concentric: false)
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
