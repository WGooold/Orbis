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
                    home
                }
            }
            .toolbar(.hidden, for: .navigationBar)
            .navigationDestination(for: AppPage.self) { page in
                Group {
                    switch page {
                    case .chat:
                        if let runtime = store.selectedRuntime {
                            ChatView(runtime: runtime, onBack: back, onHistory: { pages.append(.history) }, onDownloads: { pages.append(.downloads) })
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
                .modifier(SwipeBackModifier(enabled: page == .chat, onBack: back, underlay: { home }))
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

    private var home: some View {
        HomeView(onDirectory: { setDrawer(true) }, onStatus: { pages.append(.status) },
                 onSettings: { pages.append(.settings) }, onAddHost: { pages.append(.pairing) },
                 onDownloads: { pages.append(.downloads) }, onUnpair: { confirmUnpair(store.selectedHost) },
                 onOpenRuntime: openRuntime)
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
        overlay.showDialog("取消配对这台电脑？", message: "此电脑在本机保存的配对和草稿将被移除。之后可以重新扫码连接。", actions: [
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
/// 首页固定在原位，起始轻微横向受压，随右滑逐步恢复原状并渐亮；吸附完成后再返回。
private struct SwipeBackModifier<Underlay: View>: ViewModifier {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.colorScheme) private var scheme
    let enabled: Bool
    let onBack: () -> Void
    @ViewBuilder let underlay: () -> Underlay
    @State private var offset: CGFloat = 0
    @State private var horizontalDrag: Bool?
    @State private var containerWidth: CGFloat = 390
    @State private var returning = false
    @State private var revealing = false
    @State private var settleID = UUID()
    @GestureState private var gestureActive = false

    private var progress: CGFloat { max(0, min(1, offset / max(1, containerWidth))) }
    private var compression: CGFloat { 1 - progress }

    func body(content: Content) -> some View {
        ZStack {
            if enabled && revealing {
                underlay()
                    .overlay { OrbisPalette(scheme).scrim.opacity(0.34 * (1 - progress)).ignoresSafeArea() }
                    .scaleEffect(x: reduceMotion ? 1 : 1 - 0.025 * compression,
                                 y: reduceMotion ? 1 : 1 + 0.008 * compression,
                                 anchor: .leading)
                    .allowsHitTesting(false)
                    .accessibilityHidden(true)
            }
            content.offset(x: max(0, offset))
        }
        .background(OrbisPalette(scheme).base.ignoresSafeArea())
        .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { containerWidth = $0 }
        .simultaneousGesture(enabled ? gesture : nil)
        .onChange(of: gestureActive) { _, active in
            // System interruptions may cancel a gesture without calling onEnded.
            if !active && horizontalDrag != nil && !returning {
                horizontalDrag = nil
                settle(back: false, velocity: 0)
            }
        }
        .onDisappear { returning = false; settleID = UUID() }
    }

    private var gesture: some Gesture {
        DragGesture(minimumDistance: 12, coordinateSpace: .global)
            .updating($gestureActive) { _, active, _ in active = true }
            .onChanged { value in
                guard !returning else { return }
                if horizontalDrag == nil {
                    horizontalDrag = value.translation.width > abs(value.translation.height) * 1.5
                    settleID = UUID()
                }
                guard horizontalDrag == true else { return }
                revealing = true
                let distance = max(0, value.translation.width)
                offset = distance > containerWidth ? containerWidth + (distance - containerWidth) * 0.18 : distance
            }
            .onEnded { value in
                let horizontal = horizontalDrag == true
                horizontalDrag = nil
                guard horizontal && !returning else { return }
                let velocity = (value.predictedEndTranslation.width - value.translation.width) / 0.2
                settle(back: offset + velocity * 0.15 > containerWidth / 3, velocity: velocity)
            }
    }

    private func settle(back: Bool, velocity: CGFloat) {
        let id = UUID()
        settleID = id
        returning = back
        let target = back ? containerWidth : 0
        let distance = target - offset
        let initialVelocity = abs(distance) > 1 ? max(-8, min(8, velocity / distance)) : 0
        withAnimation(reduceMotion ? nil : .orbisSwipeBack(velocity: Double(initialVelocity)), completionCriteria: .removed) {
            offset = target
        } completion: {
            guard settleID == id else { return }
            guard back && returning else { revealing = false; return }
            var transaction = Transaction(animation: nil)
            transaction.disablesAnimations = true
            withTransaction(transaction) { onBack() }
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
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @EnvironmentObject private var store: OrbisStore
    @Environment(\.colorScheme) private var scheme
    @State private var selectedRuntimeIds: Set<String> = []
    @State private var swipeTranslations: [String: CGFloat] = [:]
    @State private var armedCloseRuntimeIds: Set<String> = []
    @State private var closeHapticRuntimeIds: Set<String> = []
    @State private var swipingRuntimeIds: Set<String> = []
    @State private var runtimeCardWidths: [String: CGFloat] = [:]
    let onDirectory: () -> Void
    let onStatus: () -> Void
    let onSettings: () -> Void
    let onAddHost: () -> Void
    let onDownloads: () -> Void
    let onUnpair: () -> Void
    let onOpenRuntime: (RuntimeSummary) -> Void

    var body: some View {
        VStack(spacing: 0) {
            OrbisHeader {
                if selecting {
                    OrbisIconButton(symbol: "xmark", label: "退出多选") { selectedRuntimeIds = [] }
                } else {
                    OrbisIconButton(symbol: "line.3.horizontal", label: "打开会话目录", action: onDirectory)
                }
            } title: {
                if selecting {
                    Text("已选择 \(selectedRuntimeIds.count) 项").font(.orbisTitle())
                } else {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Orbis").font(.orbisTitle())
                            .foregroundStyle(Color(hex: scheme == .dark ? 0xD3D9E3 : 0x4E5F7A))
                            .shadow(color: OrbisPalette(scheme).light, radius: 0, x: 1, y: 1)
                        Text("Easy Agents EveryWhere").font(.orbisCaption(.semibold)).tracking(0.4)
                            .foregroundStyle(LinearGradient(colors: [OrbisPalette(scheme).accent, OrbisPalette(scheme).success], startPoint: .leading, endPoint: .trailing))
                            .lineLimit(1)
                    }
                }
            } trailing: {
                if selecting {
                    Button("关闭") { closeSelectedRuntimes() }
                        .font(.orbisLabel(.semibold)).foregroundStyle(OrbisPalette(scheme).error)
                        .buttonStyle(NeuButtonStyle(padding: 12))
                        .accessibilityLabel("关闭选中会话")
                        .disabled(store.connection != .secured)
                } else {
                    OrbisIconButton(symbol: "arrow.down.to.line", label: "下载", action: onDownloads)
                    OrbisMenuIconButton(symbol: "ellipsis", label: "更多操作") {
                        [OrbisMenuItem(title: "连接状态", symbol: "info.circle", action: onStatus),
                         OrbisMenuItem(title: "设置", symbol: "gearshape", action: onSettings),
                         OrbisMenuItem(title: "添加电脑", symbol: "plus", action: onAddHost),
                         .divider,
                         OrbisMenuItem(title: "取消配对当前电脑", symbol: "link", destructive: true, action: onUnpair)]
                    }
                }
            }
            // One fixed row: which computer this page shows, and how it is connected.
            // The reconnect action appears inside it without moving the cards.
            HStack(spacing: 10) {
                hostSwitcher
                Spacer(minLength: 8)
                Button(action: onStatus) { ConnectionPill() }.buttonStyle(.plain)
                if store.connection == .offline || store.connection == .error {
                    OrbisIconButton(symbol: "arrow.clockwise", label: "重新连接", size: 36, action: store.reconnectSelectedHost)
                }
            }.frame(height: 48).padding(.horizontal, 20).padding(.bottom, 2)
            // Only the current computer's sessions: several paired computers never share one list (ADR-0030 修订).
            if let host = currentHost, !host.runtimes.isEmpty {
                ScrollView {
                    LazyVStack(spacing: 16) {
                        ForEach(host.runtimes.sorted { host.connection.displayName($0).localizedStandardCompare(host.connection.displayName($1)) == .orderedAscending }) { runtime in
                            runtimeCard(runtime, host: host)
                        }
                    }.padding(.horizontal, 20).padding(.top, 12).padding(.bottom, 28)
                }.refreshable { store.refresh() }
            } else {
                OrbisEmptyState(symbol: "desktopcomputer", title: "暂无在线会话")
                OrbisActionButton(title: "查看会话目录", symbol: "folder", action: onDirectory)
                    .padding(.horizontal, 24).padding(.bottom, 32)
            }
        }.frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(OrbisPalette(scheme).base.ignoresSafeArea())
            .onChange(of: store.selectedHostId) { _, _ in
                selectedRuntimeIds = []
                resetCloseSwipes()
            }
            .onChange(of: selecting) { _, active in if active { resetCloseSwipes() } }
            .onChange(of: currentHost?.runtimes.map(\.runtimeId) ?? []) { _, ids in
                selectedRuntimeIds.formIntersection(ids)
            }
            .onDisappear { selectedRuntimeIds = []; resetCloseSwipes() }
    }

    private var currentHost: HostSnapshot? { store.hosts.first { $0.hostId == store.selectedHostId } }
    private var selecting: Bool { !selectedRuntimeIds.isEmpty }

    private func resetCloseSwipes() {
        swipeTranslations = [:]
        armedCloseRuntimeIds = []
        closeHapticRuntimeIds = []
        swipingRuntimeIds = []
    }

    private func toggleSelection(_ id: String) {
        if selectedRuntimeIds.contains(id) { selectedRuntimeIds.remove(id) }
        else { selectedRuntimeIds.insert(id) }
    }

    private func beginSelection(_ id: String) {
        if !selecting { OrbisHaptics.beginSelection() }
        selectedRuntimeIds.insert(id)
    }

    private func closeSelectedRuntimes() {
        guard let hostId = store.selectedHostId else { return }
        let submitted = store.closeRuntimes(hostId: hostId, runtimeIds: selectedRuntimeIds)
        selectedRuntimeIds.subtract(submitted)
    }

    /// The current computer; with several paired computers it is also the switcher.
    @ViewBuilder private var hostSwitcher: some View {
        let p = OrbisPalette(scheme)
        let name = store.selectedHost?.hostName ?? "选择电脑"
        if store.pairings.count > 1 {
            OrbisMenuButton(accessibilityLabel: "切换电脑，当前 \(name)", padding: 0,
                            items: { hostSwitchMenuItems(store, onAddHost: onAddHost) }) {
                HStack(spacing: 8) {
                    Image(systemName: "desktopcomputer").foregroundStyle(p.accent)
                    Text(name).font(.orbisLabel(.semibold)).lineLimit(1)
                    // A waiting approval on another computer; the menu names which one.
                    if store.hosts.contains(where: { $0.hostId != store.selectedHostId && hostHasPendingInteraction($0) }) {
                        Circle().fill(p.error).frame(width: 7, height: 7).accessibilityLabel("其他电脑有待确认")
                    }
                    Image(systemName: "chevron.up.chevron.down").imageScale(.small).foregroundStyle(p.secondary)
                }.padding(.horizontal, 12).frame(minHeight: 36)
            }
        } else {
            Label(name, systemImage: "desktopcomputer").font(.orbisLabel(.semibold)).lineLimit(1)
                .padding(.horizontal, 4)
        }
    }

    private func runtimeCard(_ runtime: RuntimeSummary, host: HostSnapshot) -> some View {
        let kind = host.connection.agentKind(runtime)
        let pending = !(host.connection.interactions[runtime.runtimeId] ?? []).isEmpty
        let selected = selectedRuntimeIds.contains(runtime.runtimeId)
        let translation = swipeTranslations[runtime.runtimeId] ?? 0
        let cardWidth = runtimeCardWidths[runtime.runtimeId] ?? 0
        let closeThreshold = cardWidth / 2
        let reveal = min(cardWidth, max(0, -translation))
        let armed = armedCloseRuntimeIds.contains(runtime.runtimeId)
        return HStack(spacing: 0) {
            ZStack(alignment: .trailing) {
                if !selecting {
                    HStack(spacing: 6) {
                        Image(systemName: armed ? "checkmark" : "xmark").font(.system(size: 14, weight: .bold))
                        Text(armed ? "松手关闭" : "关闭").font(.orbisLabel(.semibold)).lineLimit(1)
                    }
                    .foregroundStyle(.white)
                    .frame(width: 116).frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .trailing)
                    .background(armed ? OrbisPalette(scheme).secondary : OrbisPalette(scheme).error)
                    .clipShape(RoundedRectangle(cornerRadius: OrbisRadius.card, style: .continuous))
                    .opacity(reveal > 0 ? 1 : 0)
                    .scaleEffect(reveal > 0 ? 1 : 0.88, anchor: .trailing)
                    .offset(x: reveal > 0 ? 0 : 10)
                    .animation(reduceMotion ? .easeOut(duration: 0.12) : .spring(response: 0.22, dampingFraction: 0.78), value: reveal > 0)
                    .accessibilityHidden(true)
                }
                Button {
                    guard !swipingRuntimeIds.contains(runtime.runtimeId) else { return }
                    if selecting { toggleSelection(runtime.runtimeId) }
                    else { store.selectRuntime(hostId: host.hostId, runtimeId: runtime.runtimeId); onOpenRuntime(runtime) }
                } label: {
                    HStack(spacing: 12) {
                        AgentEmblem(kind: kind)
                        VStack(alignment: .leading, spacing: 6) {
                            Text(host.connection.displayName(runtime)).font(.orbisBody(.semibold)).lineLimit(1)
                            Text(runtime.cwd)
                                .font(.orbisCaption(mono: true)).foregroundStyle(OrbisPalette(scheme).secondary).lineLimit(1)
                            HStack(spacing: 10) {
                                Text(agentTitle(kind)).font(.orbisCaption(.medium)).foregroundStyle(OrbisPalette(scheme).agent(kind))
                                // A pending interaction takes the status slot instead of adding a line to the card.
                                if pending {
                                    Label("待确认", systemImage: "exclamationmark.circle").font(.orbisCaption(.semibold))
                                        .foregroundStyle(OrbisPalette(scheme).error)
                                } else { RuntimeStatusLabel(status: runtime.status) }
                            }
                        }
                    }.frame(maxWidth: .infinity, alignment: .leading)
                }.buttonStyle(NeuButtonStyle(selected: selected, radius: OrbisRadius.card, padding: OrbisRadius.cardPadding + 4))
                    .offset(x: -reveal)
                    .highPriorityGesture(LongPressGesture().onEnded { _ in beginSelection(runtime.runtimeId) })
                    .accessibilityIdentifier("home-runtime-\(runtime.runtimeId)")
                    .accessibilityAddTraits(selected ? .isSelected : [])
                    .accessibilityAction(named: "选择会话") { beginSelection(runtime.runtimeId) }
                    .simultaneousGesture(DragGesture(minimumDistance: 8, coordinateSpace: .global)
                        .onChanged { value in
                            guard !selecting else { return }
                            let horizontal = value.translation.width
                            guard abs(horizontal) > abs(value.translation.height) else {
                                swipeTranslations[runtime.runtimeId] = 0
                                armedCloseRuntimeIds.remove(runtime.runtimeId)
                                return
                            }
                            swipingRuntimeIds.insert(runtime.runtimeId)
                            if closeThreshold > 0, !armedCloseRuntimeIds.contains(runtime.runtimeId), horizontal <= -closeThreshold,
                               !closeHapticRuntimeIds.contains(runtime.runtimeId) {
                                closeHapticRuntimeIds.insert(runtime.runtimeId)
                                OrbisHaptics.commit()
                            }
                            swipeTranslations[runtime.runtimeId] = min(0, max(-cardWidth, horizontal))
                            if closeThreshold > 0, horizontal <= -closeThreshold { armedCloseRuntimeIds.insert(runtime.runtimeId) }
                            else { armedCloseRuntimeIds.remove(runtime.runtimeId) }
                        }
                        .onEnded { value in
                            guard !selecting else { return }
                            // Let this release's button action finish before accepting taps again.
                            DispatchQueue.main.async { swipingRuntimeIds.remove(runtime.runtimeId) }
                            if closeThreshold > 0, armedCloseRuntimeIds.contains(runtime.runtimeId), value.translation.width <= -closeThreshold,
                               abs(value.translation.width) > abs(value.translation.height) {
                                _ = store.closeRuntimes(hostId: host.hostId, runtimeIds: [runtime.runtimeId])
                            }
                            withAnimation(reduceMotion ? .easeOut(duration: 0.12) : .spring(response: 0.28, dampingFraction: 0.82)) {
                                swipeTranslations[runtime.runtimeId] = 0
                                armedCloseRuntimeIds.remove(runtime.runtimeId)
                                closeHapticRuntimeIds.remove(runtime.runtimeId)
                            }
                        })
            }
            .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { runtimeCardWidths[runtime.runtimeId] = $0 }
            if selecting {
                OrbisIconButton(symbol: selected ? "checkmark.circle.fill" : "circle", label: selected ? "取消选择会话" : "选择会话",
                                tint: selected ? OrbisPalette(scheme).accent : nil, selected: selected, compact: true) {
                    toggleSelection(runtime.runtimeId)
                }
            }
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
            // Secured: the transport path; otherwise the connection phase. Color carries the state.
            Text(store.connection == .secured ? pathTitle(store.activePath ?? "relay") : connectionTitle(store.connection))
            if store.connection == .secured { Image(systemName: "lock.shield").accessibilityLabel("端到端加密") }
        }.font(.orbisCaption(.medium)).foregroundStyle(OrbisPalette(scheme).secondary).padding(.horizontal, 12).frame(minHeight: 36)
            .neuSurface(inset: true, radius: 18, intensity: 0.35, concentric: false)
    }
}

/// Shared by the home row and the drawer footer: pick another paired computer, or add one.
@MainActor
func hostSwitchMenuItems(_ store: OrbisStore, onAddHost: @escaping () -> Void) -> [OrbisMenuItem] {
    var items: [OrbisMenuItem] = store.pairings.map { host in
        let snapshot = store.hosts.first { $0.hostId == host.hostId }
        let state = snapshot.map { "，" + connectionTitle($0.connectionState) } ?? ""
        let pending = snapshot.map(hostHasPendingInteraction) == true ? "，有待确认" : ""
        return OrbisMenuItem(title: host.hostName + state + pending, symbol: "desktopcomputer", checked: host.hostId == store.selectedHostId) {
            if host.hostId != store.selectedHostId { store.connect(hostId: host.hostId) }
        }
    }
    items.append(.divider)
    items.append(OrbisMenuItem(title: "添加电脑", symbol: "plus", action: onAddHost))
    return items
}

/// Another computer's approvals stay visible from the switcher once the list shows only one computer.
@MainActor
func hostHasPendingInteraction(_ host: HostSnapshot) -> Bool { host.connection.interactions.values.contains { !$0.isEmpty } }

func connectionTitle(_ state: ConnectionState) -> String {
    switch state {
    case .offline: return "未连接"
    case .connecting: return "正在连接"
    case .online: return "正在建立安全通道"
    case .secured: return "端到端加密已连接"
    case .error: return "连接错误"
    }
}
