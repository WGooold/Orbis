import SwiftUI

private enum RootTab: String, CaseIterable {
    case chat, providers, settings
    var title: String { switch self { case .chat: L10n.tr("聊天"); case .providers: L10n.tr("供应商"); case .settings: L10n.tr("设置") } }
    var symbol: String { switch self { case .chat: "bubble.left"; case .providers: "slider.horizontal.3"; case .settings: "gearshape" } }
}

private enum AppPage: Hashable { case chat, pairing, status, providers, history, downloads }

struct ContentView: View {
    @EnvironmentObject private var store: OrbisStore
    @Environment(\.colorScheme) private var scheme
    @AppStorage("orbis.appearance") private var visualStyle = "mist"
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.orbisReduceMotion) private var reduceMotion
    @StateObject private var navigation = OrbisPageStack<AppPage>()
    @State private var homeSelecting = false
    @State private var rootTab: RootTab = .chat
    @State private var displayedRoot: RootTab = .chat
    @State private var rootOpacity = 1.0
    @State private var rootOffset: CGFloat = 0
    @State private var rootTransition = 0
    @State private var draftOrigin: CGRect?
    @State private var draftSnapshot: UIView?
    @State private var surfaceWidth: CGFloat = 390
    @State private var drawerOpen = false
    @State private var directoryState = SessionDirectoryState()
    @State private var newSessionOpen = false
    @State private var draftCloseRequest = 0
    @State private var draftNotice = false
    @State private var draftNoticeToken = 0
    @State private var newSessionCwd: String?
    @StateObject private var overlay = OrbisOverlay()

    init() {
        #if DEBUG
        let preview = ProcessInfo.processInfo.arguments.first { $0.hasPrefix("--preview-screen=") }?.split(separator: "=").last.map(String.init)
        switch preview {
        case "chat", "slash", "approval", "tool", "queue", "notices", "interactions", "truncated", "viewport", "changes": _navigation = StateObject(wrappedValue: OrbisPageStack([.chat]))
        case "status": _rootTab = State(initialValue: .settings); _displayedRoot = State(initialValue: .settings)
        case "providers": _rootTab = State(initialValue: .providers); _displayedRoot = State(initialValue: .providers)
        case "downloads": _navigation = StateObject(wrappedValue: OrbisPageStack([.downloads]))
        case "history": _navigation = StateObject(wrappedValue: OrbisPageStack([.chat, .history]))
        case "drawer": _drawerOpen = State(initialValue: true)
        case "new-session": _newSessionOpen = State(initialValue: true)
        default: break
        }
        #endif
    }

    var body: some View {
        NavigationStack(path: $navigation.pages) {
            Group {
                if store.pairings.isEmpty {
                    PairingEntryView(onCancel: nil, onCode: store.pair)
                } else {
                    rootPages
                        .accessibilityHidden(drawerOpen && surfaceWidth < 600)
                }
            }
            .toolbar(.hidden, for: .navigationBar)
            .navigationDestination(for: AppPage.self) { page in
                Group {
                    switch page {
                    case .chat:
                        if let runtime = store.selectedRuntime {
                            ChatView(runtime: runtime, onBack: back, onHistory: { push(.history) }, onDownloads: { push(.downloads) })
                                .id(localSessionKey(host: store.selectedHost, runtime: runtime))
                                .modifier(OrbisDraftExpansion(origin: draftOrigin, snapshot: draftSnapshot, onComplete: { draftOrigin = nil; draftSnapshot = nil }))
                        } else { OrbisEmptyState(symbol: "desktopcomputer", title: L10n.tr("会话已离线")) }
                    case .pairing: PairingEntryView(onCancel: back, onCode: store.pair)
                    case .status: ConnectionStatusView(onBack: back)
                    case .providers: AgentProvidersView(onBack: back)
                    case .history: HistoryBranchView(onBack: back, onDownloads: { push(.downloads) })
                    case .downloads: DownloadsView(onBack: back)
                    }
                }
                .frame(maxWidth: 720).frame(maxWidth: .infinity, maxHeight: .infinity)
                .foregroundStyle(OrbisPalette(scheme).text)
                .background(OrbisPalette(scheme).base.ignoresSafeArea())
                .toolbar(.hidden, for: .navigationBar)
                .modifier(OrbisPageTransition(onBack: back,
                                              underlay: { navigation.underlay(below: page) { rootPages } }))
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
        .animation(reduceMotion ? nil : InteractionMotion.panel, value: visualStyle)
        .modifier(SessionDrawerModifier(isOpen: $drawerOpen, hasHost: !store.pairings.isEmpty, edgeSwipeEnabled: navigation.pages.isEmpty && rootTab == .chat && !store.pairings.isEmpty && !store.isPairing) {
            drawer
        })
        .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { surfaceWidth = $0 }
        .overlay(alignment: .top) {
            if let error = store.errorMessage {
                HStack(alignment: .top, spacing: 10) {
                    OrbisNotice(text: error, error: true)
                    OrbisIconButton(symbol: "xmark", label: L10n.tr("关闭错误提示")) { store.errorMessage = nil }
                }.padding(16).background(OrbisPalette(scheme).base)
                    .accessibilityElement(children: .contain)
            }
        }
        .overlay(alignment: .bottom) { TransferErrorBanner(transfers: store.transfers) }
        .overlay(alignment: .bottom) {
            if draftNotice { OrbisNotice(text: L10n.tr("草稿已保留")).padding(.horizontal, 20).padding(.bottom, 88).transition(InteractionMotion.notice) }
        }
        #if DEBUG
        .overlay(alignment: .topTrailing) {
            if ProcessInfo.processInfo.arguments.contains("--preview-viewport-controls") {
                HStack(spacing: 2) {
                    ForEach(["insert", "promote", "remove"], id: \.self) { operation in
                        Button(operation) { PreviewViewportUpdates.changeList?(operation) }
                            .accessibilityIdentifier("preview-list-" + operation)
                    }
                }.font(.system(size: 10)).padding(.top, 60)
            }
            if ProcessInfo.processInfo.arguments.contains("--preview-home-refresh-probe") {
                PreviewHomeRefreshReport()
            }
        }
        #endif
        .onChange(of: rootTab) { _, next in switchRoot(next) }
        .onChange(of: store.selectedHostId) { _, _ in overlay.dismissMenu() }
        .onChange(of: store.pairings) { _, _ in overlay.dismissMenu() }
        .onChange(of: navigation.pages) { _, pages in
            overlay.dismissMenu()
            // ADR-0049 §6.8：离开启动页不取消启动，成功后也不把用户拉回。
            if !pages.contains(.chat) { store.stopFollowingLaunch() }
        }
        .onChange(of: drawerOpen) { _, _ in overlay.dismissMenu() }
        .onChange(of: store.activationRevision) { _, _ in
            setDrawer(false); newSessionOpen = false
            if store.selectedRuntime != nil { navigation.replace(with: [.chat]) }
        }
        .onChange(of: store.selectedRuntimeId) { old, next in
            if old != nil && next == nil && navigation.pages.contains(.chat) { navigation.replace(with: []) }
        }
        .onChange(of: store.isPairing) { old, active in
            if old && !active && store.errorMessage == nil && store.selectedHost != nil { navigation.replace(with: []) }
        }
        .onReceive(NotificationCenter.default.publisher(for: ReplyCompletionNotifications.remoteWake)) { notification in
            guard let hostId = notification.userInfo?["hostId"] as? String,
                  store.pairings.contains(where: { $0.hostId == hostId }) else { return }
            store.connect(hostId: hostId)
            rootTab = .chat; displayedRoot = .chat
            navigation.replace(with: [.chat])
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
                        Text(L10n.tr("正在安全配对…")).font(.orbisBody(.medium))
                    }.neuSurface(radius: OrbisRadius.dialog, padding: 30)
                }.accessibilityAddTraits(.updatesFrequently)
            }
        }
        .orbisOverlayHost(overlay)
        .modifier(OrbisInputModality())
        #if DEBUG
        .overlay(alignment: .topLeading) { if ChatEntryProbe.enabled { ChatEntryReport() } }
        .overlay(alignment: .bottomLeading) { if PageReturnProbe.enabled { PageReturnReport() } }
        #endif
    }

    /// Keep root views mounted so changing tabs preserves scroll positions and selections.
    private var rootPages: some View {
        VStack(spacing: 0) {
            // Mounted inactive pages must not contribute their minimum height when the
            // keyboard shrinks the viewport. The home header stays above its scroll view.
            GeometryReader { viewport in
                ZStack {
                    rootContent(.chat) { home }
                    rootContent(.providers) { AgentProvidersView(root: true, onBack: { rootTab = .chat }) }
                    rootContent(.settings) { ConnectionStatusView(root: true, onBack: { rootTab = .chat }) }
                }.frame(width: viewport.size.width, height: viewport.size.height, alignment: .top)
                    .opacity(rootOpacity).offset(y: rootOffset)
                    .clipped()
            }
            if !homeSelecting { HStack(spacing: 12) {
                ForEach(RootTab.allCases, id: \.self) { tab in
                    OrbisMotionButton {
                        guard tab != rootTab else { return }
                        OrbisHaptics.selectionChanged(); rootTab = tab
                    } label: {
                        VStack(spacing: 2) {
                            Image(systemName: tab == .chat && rootTab == tab ? "bubble.left.fill" : tab == .settings && rootTab == tab ? "gearshape.fill" : tab.symbol)
                                .font(.system(size: 22))
                            Text(tab.title).font(.orbisLabel(rootTab == tab ? .semibold : .regular))
                        }.foregroundStyle(rootTab == tab ? OrbisPalette(scheme).accent : OrbisPalette(scheme).secondary)
                            .frame(maxWidth: .infinity, minHeight: 56)
                    }.buttonStyle(NeuButtonStyle(selected: rootTab == tab, radius: 16))
                        .accessibilityIdentifier("root-tab-" + tab.rawValue)
                        .accessibilityAddTraits(rootTab == tab ? .isSelected : [])
                }
            }.padding(.horizontal, 20).padding(.top, 8).padding(.bottom, 12) }
        }.frame(maxWidth: 720).frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(OrbisPalette(scheme).base.ignoresSafeArea())
    }

    private func rootContent<Content: View>(_ tab: RootTab, @ViewBuilder content: () -> Content) -> some View {
        content().environment(\.orbisVisible, displayedRoot == tab).opacity(displayedRoot == tab ? 1 : 0)
            .allowsHitTesting(displayedRoot == tab && rootOpacity == 1)
            .accessibilityElement(children: .contain)
            .accessibilityHidden(displayedRoot != tab)
    }

    private func switchRoot(_ next: RootTab) {
        overlay.dismissMenu(); setDrawer(false); draftNotice = false
        rootTransition += 1
        let token = rootTransition
        if reduceMotion { displayedRoot = next; rootOpacity = 1; rootOffset = 0; return }
        withAnimation(.timingCurve(0.4, 0, 1, 1, duration: 0.09)) { rootOpacity = 0 }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.09) {
            guard token == rootTransition else { return }
            displayedRoot = next; rootOffset = 8
            withAnimation(.timingCurve(0, 0, 0.2, 1, duration: 0.21)) { rootOpacity = 1; rootOffset = 0 }
        }
    }

    private var home: some View {
        HomeView(store: store, updates: store.homeUpdates, draftOpen: newSessionOpen, draftCwd: newSessionCwd, draftCloseRequest: draftCloseRequest, onDraft: {
            if newSessionOpen { draftCloseRequest += 1 }
            else { draftNotice = false; withAnimation(reduceMotion ? nil : .orbisCollapse) { newSessionOpen = true } }
        }, onDraftCancelled: { retained in
            withAnimation(reduceMotion ? nil : .orbisCollapse) { newSessionOpen = false; draftNotice = retained }
            draftNoticeToken += 1; let token = draftNoticeToken
            DispatchQueue.main.asyncAfter(deadline: .now() + 4) { if token == draftNoticeToken { withAnimation(reduceMotion ? nil : InteractionMotion.exit) { draftNotice = false } } }
        }, onDraftSubmitted: { launch, origin in
            draftOrigin = origin; draftSnapshot = currentScreenSnapshot()
            newSessionOpen = false
            if store.selectedRuntime != nil {
                var transaction = Transaction(animation: nil); transaction.disablesAnimations = true
                withTransaction(transaction) { navigation.replace(with: [.chat]) }
            }
        }, onSelection: { homeSelecting = $0 }, onDirectory: { setDrawer(true) }, onSettings: { rootTab = .settings },
                 onDownloads: { push(.downloads) },
                 onOpenRuntime: { hostId, runtime in
                     store.selectHost(hostId)
                     openRuntime(runtime)
                 }).equatable()
    }

    private var drawer: some View {
        SessionDrawerView(store: store, updates: store.directoryUpdates, renderedState: directoryState, state: $directoryState, onClose: { setDrawer(false) },
                          onOpenSession: { session in
                              if session.archived != true, let runtime = store.runtimes.first(where: { $0.sessionId == session.sessionId }) { openRuntime(runtime) }
                              else if store.openCachedSession(session) { setDrawer(false); navigation.replace(with: [.chat]) }
                              else {
                                  overlay.showDialog(L10n.tr("本机尚无缓存"), actions: [OrbisDialogAction(title: L10n.tr("返回"), role: .cancel)] + (store.connection == .secured ? [OrbisDialogAction(title: L10n.tr("在电脑继续会话")) { store.activate(session) }] : []))
                              }
                          },
                          onOpenHistory: { session in
                              if store.openCachedSession(session) { setDrawer(false); navigation.replace(with: [.chat]) }
                          },
                          onNewSession: { cwd in
                              navigation.replace(with: [])
                              newSessionCwd = cwd; setDrawer(false); rootTab = .chat
                              withAnimation(reduceMotion ? nil : .orbisCollapse) { newSessionOpen = true }
                          }, onAddHost: { setDrawer(false); push(.pairing) },
                          onProviders: { navigation.replace(with: []); setDrawer(false); rootTab = .providers },
                          onUnpair: { confirmUnpair($0) }).equatable()
    }

    private func back() { navigation.back() }
    private func push(_ page: AppPage) { navigation.push(page) }
    private func setDrawer(_ open: Bool) {
        withAnimation(reduceMotion ? nil : .orbisDrag) { drawerOpen = open }
    }
    private func confirmUnpair(_ host: HostPairing?) {
        guard let host else { return }
        overlay.showDialog(L10n.tr("取消配对这台电脑？"), message: L10n.tr("将移除本机配对与草稿"), actions: [
            OrbisDialogAction(title: L10n.tr("返回"), role: .cancel),
            OrbisDialogAction(title: L10n.tr("取消配对 {0}", host.hostName), role: .destructive) {
                store.unpair(hostId: host.hostId); navigation.replace(with: []); setDrawer(false)
            }
        ])
    }
    private func openRuntime(_ runtime: RuntimeSummary) {
        store.selectRuntime(runtime.runtimeId); setDrawer(false); navigation.replace(with: [.chat])
    }
}

/// 会话目录抽屉。关闭时在主页左侧（左 40% 宽度内）起手向右横拖即把抽屉拉出；打开时在抽屉
/// 或遮罩上向左拖动即推回。拖动过程中抽屉与遮罩跟随手指，松手按位置与速度吸附到打开或关闭。
/// 拉出手势挂在页面内容上与之同时识别，并按第一段位移锁定方向，竖向滚动主页时不会带出抽屉。
private struct SessionDrawerModifier<Drawer: View>: ViewModifier {
    @Environment(\.colorScheme) private var scheme
    @AppStorage("orbis.appearance") private var visualStyle = "mist"
    @Environment(\.orbisReduceMotion) private var reduceMotion
    @Binding var isOpen: Bool
    let hasHost: Bool
    let edgeSwipeEnabled: Bool
    @ViewBuilder let drawer: Drawer
    /// 拖动中抽屉相对完全打开位置的水平偏移，范围 [-width, 0]；nil 表示没有在拖动。
    @State private var offset: CGFloat?
    /// 按第一段位移锁定方向：true 横向带动抽屉，false 交给滚动等其他手势。
    @State private var horizontalDrag: Bool?
    /// 横拖抽屉期间停用手指下的按钮：从会话卡片或目录行上起手拖动时，松手不能再触发它们。
    @State private var suppressTaps = false
    @State private var containerWidth: CGFloat = 390

    private var width: CGFloat { min(320, containerWidth * 0.85) }
    private var persistent: Bool { hasHost && containerWidth >= 600 }

    func body(content: Content) -> some View {
        HStack(spacing: 0) {
            if persistent {
                drawer.frame(width: 320).frame(maxHeight: .infinity)
                    .orbisNested().background(OrbisPalette(scheme).base)
                    .accessibilityElement(children: .contain)
                    .accessibilityIdentifier("persistent-session-directory")
            }
            content.disabled(suppressTaps)
                .simultaneousGesture(edgeSwipeEnabled && !isOpen && !persistent ? openGesture : nil)
        }.onGeometryChange(for: CGFloat.self) { $0.size.width } action: { containerWidth = $0 }
            .overlay {
                let visible = !persistent && (isOpen || offset != nil)
                let progress = visible ? max(0, min(1, 1 + (offset ?? 0) / width)) : 0
                ZStack(alignment: .leading) {
                    if visible {
                        OrbisPalette(scheme).scrim.opacity(0.34 * progress).ignoresSafeArea()
                            .allowsHitTesting(false).accessibilityHidden(true)
                            .transition(.opacity)
                        // The close target occupies only the exposed scrim. A full-window
                        // accessibility button would cover the drawer's own hit targets.
                        HStack(spacing: 0) {
                            Color.clear.frame(width: max(0, width + (offset ?? 0))).allowsHitTesting(false)
                            Button(action: close) { Color.clear.contentShape(Rectangle()) }
                                .buttonStyle(.plain).accessibilityLabel(L10n.tr("关闭会话目录"))
                        }.ignoresSafeArea()
                        drawer
                            .disabled(suppressTaps)
                            .frame(width: width)
                            .frame(maxHeight: .infinity)
                            .orbisNested()
                            .background {
                                // The panel owns the material; its contents use flat tonal layers.
                                // Extend only the shell into safe areas, keeping controls in place.
                                Color.clear
                                    .neuSurface(radius: OrbisRadius.card, intensity: 1, concentric: false)
                                    .ignoresSafeArea()
                                    .allowsHitTesting(false)
                                    .accessibilityHidden(true)
                            }
                            .offset(x: offset ?? 0)
                            .transition(.move(edge: .leading))
                            .accessibilityElement(children: .contain)
                    }
                    // 紧贴屏幕左缘起手时，挂在内容上的同时手势会被系统边缘手势拦下，这里单独接住。
                    // 拉出过程中这条窄带必须一直存在，否则手势会随视图移除而被取消。
                    if edgeSwipeEnabled && !isOpen && !persistent {
                        Color.clear.frame(width: 20).frame(maxHeight: .infinity)
                            .contentShape(Rectangle())
                            .gesture(openGesture)
                            .accessibilityHidden(true)
                    }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
                .accessibilityElement(children: .contain)
                .accessibilityAddTraits(visible ? [.isModal] : [])
                .accessibilityHidden(!visible)
                .simultaneousGesture(isOpen && !persistent ? closeGesture : nil)
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

/// Owns navigation and source previews together, so new routes cannot forget swipe-back setup.
@MainActor
final class OrbisPageStack<Page: Hashable>: ObservableObject {
    @Published var pages: [Page] {
        didSet { snapshots = snapshots.filter { $0.key < pages.count } }
    }
    private var snapshots: [Int: UIView] = [:]

    init(_ pages: [Page] = []) { self.pages = pages }

    func push(_ page: Page) {
        if !pages.isEmpty { snapshots[pages.count] = currentScreenSnapshot() }
        pages.append(page)
    }

    func back() { if !pages.isEmpty { pages.removeLast() } }

    func replace(with pages: [Page]) {
        snapshots.removeAll()
        self.pages = pages
    }

    @ViewBuilder func underlay<Root: View>(below page: Page, @ViewBuilder root: () -> Root) -> some View {
        let index = pages.lastIndex(of: page) ?? 0
        if index == 0 { root() }
        else if let snapshot = snapshots[index] { SnapshotUnderlay(view: snapshot).ignoresSafeArea() }
        else { Color.clear }
    }
}

/// Every pushed full page uses the same transition, independent of its route (M14).
/// The source is a noninteractive preview; the actual source stays in the navigation stack.
struct OrbisPageTransition<Underlay: View>: ViewModifier {
    @Environment(\.orbisReduceMotion) private var reduceMotion
    @Environment(\.colorScheme) private var scheme
    @AppStorage("orbis.appearance") private var visualStyle = "mist"
    @EnvironmentObject private var overlay: OrbisOverlay
    let onBack: () -> Void
    @ViewBuilder let underlay: () -> Underlay
    @State private var offset: CGFloat = 0
    @State private var horizontalDrag: Bool?
    @State private var containerWidth: CGFloat = 390
    @State private var returning = false
    @State private var suppressTaps = false
    @State private var revealing = false
    @State private var settleID = UUID()
    @State private var backPriority: OrbisBackPriority?
    @GestureState private var gestureActive = false

    private var progress: CGFloat { max(0, min(1, offset / max(1, containerWidth))) }
    private var compression: CGFloat { 1 - progress }

    func body(content: Content) -> some View {
        ZStack {
            if revealing {
                underlay()
                    .overlay { OrbisPalette(scheme).scrim.opacity(0.34 * (1 - progress)).ignoresSafeArea() }
                    .scaleEffect(x: reduceMotion ? 1 : 1 - 0.025 * compression,
                                 y: reduceMotion ? 1 : 1 + 0.008 * compression,
                                 anchor: .leading)
                    .allowsHitTesting(false)
                    .accessibilityHidden(true)
            }
            content.offset(x: max(0, offset))
                .disabled(suppressTaps)
                .allowsHitTesting(!returning)
        }
        .background(OrbisPalette(scheme).base.ignoresSafeArea())
        .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { containerWidth = $0 }
        .simultaneousGesture(gesture)
        .onPreferenceChange(OrbisBackPriorityKey.self) { backPriority = $0 }
        .onChange(of: gestureActive) { _, active in
            // System interruptions may cancel a gesture without calling onEnded.
            if !active && horizontalDrag != nil && !returning {
                horizontalDrag = nil
                releaseTaps()
                settle(back: false, velocity: 0)
            }
        }
        .onDisappear { returning = false; suppressTaps = false; settleID = UUID() }
    }

    private var gesture: some Gesture {
        DragGesture(minimumDistance: 12, coordinateSpace: .global)
            .updating($gestureActive) { _, active, _ in active = true }
            .onChanged { value in
                guard !returning else { return }
                if horizontalDrag == nil {
                    horizontalDrag = overlay.menu == nil && overlay.dialog == nil && value.translation.width > abs(value.translation.height) * 1.5
                    settleID = UUID()
                }
                guard horizontalDrag == true else { return }
                // Simultaneous recognition preserves scrolling, but a Button under
                // the finger must not also fire when this horizontal drag ends.
                suppressTaps = true
                // A selection or modal must not preview a different page.
                if backPriority != nil { return }
                revealing = true
                let distance = max(0, value.translation.width)
                offset = distance > containerWidth ? containerWidth + (distance - containerWidth) * 0.18 : distance
            }
            .onEnded { value in
                let horizontal = horizontalDrag == true
                horizontalDrag = nil
                releaseTaps()
                guard horizontal && !returning else { return }
                let velocity = (value.predictedEndTranslation.width - value.translation.width) / 0.2
                if backPriority != nil {
                    if value.translation.width + velocity * 0.15 > containerWidth / 3 { backPriority?.action() }
                    return
                }
                settle(back: offset + velocity * 0.15 > containerWidth / 3, velocity: velocity)
            }
    }

    private func releaseTaps() {
        // Keep controls disabled through the current touch-up's action dispatch.
        DispatchQueue.main.async { suppressTaps = false }
    }

    private func settle(back: Bool, velocity: CGFloat) {
        let id = UUID()
        settleID = id
        returning = back
        #if DEBUG
        if back { PageReturnProbe.shared.begin() }
        #endif
        let target = back ? containerWidth : 0
        let distance = target - offset
        let initialVelocity = abs(distance) > 1 ? max(-8, min(8, velocity / distance)) : 0
        let finish = {
            guard settleID == id else { return }
            guard back && returning else { revealing = false; return }
            // Consume this completion before handing navigation back to the source.
            settleID = UUID()
            var transaction = Transaction(animation: nil)
            transaction.disablesAnimations = true
            withTransaction(transaction) { onBack() }
            #if DEBUG
            PageReturnProbe.shared.committed()
            #endif
        }
        // The preview is noninteractive. Do not leave it on screen waiting for
        // a spring to finish oscillating offscreen after the visible page is gone.
        if reduceMotion || (back && offset >= containerWidth) {
            var transaction = Transaction(animation: nil)
            transaction.disablesAnimations = true
            withTransaction(transaction) { offset = target }
            finish()
        } else {
            let animation = back ? InteractionMotion.pageReturn : .orbisSwipeBack(velocity: Double(initialVelocity))
            withAnimation(animation, completionCriteria: back ? .logicallyComplete : .removed) {
                offset = target
            } completion: { finish() }
        }
    }
}

@MainActor private func currentScreenSnapshot() -> UIView? {
    let window = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        .flatMap(\.windows).first { $0.isKeyWindow }
    return window?.snapshotView(afterScreenUpdates: false)
}

/// The submitted card keeps its identity while its rectangle grows into the chat page.
private struct OrbisDraftExpansion: ViewModifier {
    @Environment(\.orbisReduceMotion) private var reduced
    let origin: CGRect?
    let snapshot: UIView?
    let onComplete: () -> Void
    @State private var progress: CGFloat = 0
    func body(content: Content) -> some View {
        GeometryReader { proxy in
            ZStack {
                if origin != nil && progress < 1, let snapshot { SnapshotUnderlay(view: snapshot).ignoresSafeArea().accessibilityHidden(true) }
                content.clipShape(DraftExpansionShape(origin: origin.map { $0.offsetBy(dx: -proxy.frame(in: .global).minX, dy: -proxy.frame(in: .global).minY) }, progress: origin == nil ? 1 : progress))
                    .allowsHitTesting(origin == nil || progress == 1)
            }
        }.onAppear {
            guard origin != nil else { progress = 1; return }
            if reduced { progress = 1; onComplete(); return }
            withAnimation(.timingCurve(0.32, 0.72, 0, 1, duration: 0.32)) { progress = 1 } completion: { onComplete() }
        }
    }
}

private struct DraftExpansionShape: Shape {
    let origin: CGRect?
    var progress: CGFloat
    var animatableData: CGFloat { get { progress } set { progress = newValue } }
    func path(in rect: CGRect) -> Path {
        guard let origin else { return Path(rect) }
        let t = min(1, max(0, progress))
        let frame = CGRect(x: origin.minX * (1 - t), y: origin.minY * (1 - t),
            width: origin.width + (rect.width - origin.width) * t, height: origin.height + (rect.height - origin.height) * t)
        return Path(roundedRect: frame, cornerRadius: 24 * (1 - t))
    }
}

/// A still of the page below, shown only while a pushed page is being swiped back.
private struct SnapshotUnderlay: UIViewRepresentable {
    let view: UIView
    func makeUIView(context: Context) -> UIView {
        let container = UIView()
        container.isUserInteractionEnabled = false
        container.addSubview(view)
        view.frame = container.bounds
        view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        return container
    }
    func updateUIView(_ container: UIView, context: Context) {
        if view.superview !== container {
            container.addSubview(view)
            view.frame = container.bounds
        }
    }
}

private struct TransferErrorBanner: View {
    @ObservedObject var transfers: FileTransfers
    var body: some View {
        if let error = transfers.error {
            HStack {
                OrbisNotice(text: error, error: true)
                OrbisIconButton(symbol: "xmark", label: L10n.tr("关闭文件提示")) { transfers.error = nil }
            }.padding(16)
        }
    }
}

struct HomeView: View, Equatable {
    let store: OrbisStore
    @ObservedObject var updates: ScreenPublication
    static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.store === rhs.store && lhs.draftOpen == rhs.draftOpen && lhs.draftCwd == rhs.draftCwd &&
            lhs.draftCloseRequest == rhs.draftCloseRequest && lhs.visualStyle == rhs.visualStyle
    }

    @Environment(\.orbisReduceMotion) private var reduceMotion
    @Environment(\.colorScheme) private var scheme
    @AppStorage("orbis.appearance") private var visualStyle = "mist"
    @State private var selectedRuntimeIds: Set<String> = []
    @State private var swipeTranslations: [String: CGFloat] = [:]
    private struct ExitingCard {
        let card: HomeRuntimeCard
        let index: Int
        let token = UUID()
    }
    @State private var exitingCards: [String: ExitingCard] = [:]
    @State private var armedCloseRuntimeIds: Set<String> = []
    @State private var swipingRuntimeIds: Set<String> = []
    @State private var runtimeCardFrames: [String: CGRect] = [:]
    @State private var homeListGeometry = HomeListGeometry()
    @State private var closeSwipeRuntimeId: String?
    @State private var closeSwipeDirectionDecided = false
    @GestureState private var closeSwipeActive = false
    var draftOpen = false
    var draftCwd: String? = nil
    var draftCloseRequest = 0
    var onDraft: () -> Void = {}
    var onDraftCancelled: (Bool) -> Void = { _ in }
    var onDraftSubmitted: (HostConnection.LaunchState, CGRect) -> Void = { _, _ in }
    var onSelection: (Bool) -> Void = { _ in }
    let onDirectory: () -> Void
    let onSettings: () -> Void
    let onDownloads: () -> Void
    let onOpenRuntime: (String, RuntimeSummary) -> Void

    // Only gesture hit testing reads the moving origin. Updating it must not invalidate
    // every card on each native scroll frame; card frames stay in content coordinates.
    private final class HomeListGeometry {
        var contentOrigin: CGPoint = .zero
    }

    var body: some View {
        VStack(spacing: 0) {
            OrbisHeader {
                OrbisIconButton(symbol: selecting ? "xmark" : "line.3.horizontal",
                                label: selecting ? L10n.tr("退出多选") : L10n.tr("打开会话目录"), morphFrom: "line.3.horizontal") {
                    if selecting { selectedRuntimeIds = [] } else { onDirectory() }
                }
            } title: {
                if selecting {
                    OrbisMotionText(L10n.tr("已选择 {0} 项", selectedRuntimeIds.count)).font(.orbisTitle())
                } else {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Orbis").font(.orbisTitle())
                            .foregroundStyle(OrbisPalette(scheme).secondary)
                            .shadow(color: OrbisPalette(scheme).light, radius: 0, x: 1, y: 1)
                        Text("Easy Agents Everywhere").font(.orbisCaption()).tracking(0.4)
                            .foregroundStyle(OrbisPalette(scheme).secondary)
                            .lineLimit(1)
                    }
                }
            } trailing: {
                OrbisSelectionToolbar(selecting: selecting) { progress in
                    HStack(spacing: 8) {
                        OrbisIconButton(symbol: "arrow.down.to.line", label: L10n.tr("下载"), action: onDownloads)
                            .offset(x: 24 * progress).accessibilityIdentifier("home-downloads")
                        OrbisIconButton(symbol: draftOpen ? "xmark" : "plus", label: draftOpen ? L10n.tr("收起新会话") : L10n.tr("新建会话"), morphFrom: "plus", action: onDraft)
                            .offset(x: -24 * progress).accessibilityIdentifier("home-new-session")
                    }
                } selected: {
                    Button(L10n.tr("关闭")) { closeSelectedRuntimes() }
                        .font(.orbisLabel(.semibold)).foregroundStyle(OrbisPalette(scheme).error)
                        .buttonStyle(NeuButtonStyle(padding: 12))
                        .accessibilityLabel(L10n.tr("关闭选中会话")).disabled(store.connection != .secured)
                }
            }
            // One fixed row: which computer this page shows, how it is connected and, once the
            // list is published, whether it is still syncing. Retry joins the row without moving the cards.
            // The capsule only reports state; settings open from the gear (ADR-0046 §5).
            HStack(spacing: 10) {
                hostSwitcher
                Spacer(minLength: 8)
                ConnectionPill(connection: store.connection, path: store.activePath, sync: backgroundSync)
                    .accessibilityIdentifier("home-connection-pill")
                if case .failed(let error) = backgroundSync {
                    OrbisIconButton(symbol: "arrow.clockwise", label: retryLabel, tint: OrbisPalette(scheme).error,
                                    compact: true, action: store.refresh)
                        .accessibilityHint(error)
                }
            }.frame(height: 48).padding(.horizontal, 20).padding(.bottom, 2)
            homeSessionList
        }.frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(OrbisPalette(scheme).base.ignoresSafeArea())
            .onChange(of: store.selectedHostId) { _, _ in
                selectedRuntimeIds = []
                exitingCards = [:]
                resetCloseSwipes()
            }
            .onChange(of: selecting) { _, active in onSelection(active); if active { resetCloseSwipes() } }
            .onChange(of: closeSwipeActive) { _, active in
                // Opening the directory can cancel this simultaneous gesture without onEnded.
                if !active && closeSwipeDirectionDecided {
                    withAnimation(reduceMotion ? .easeOut(duration: 0.12) : .spring(response: 0.28, dampingFraction: 0.82)) {
                        resetCloseSwipes()
                    }
                }
            }
            .onChange(of: closableRuntimeIds) { _, ids in
                selectedRuntimeIds.formIntersection(ids)
                if let active = closeSwipeRuntimeId, !ids.contains(active) { resetCloseSwipes() }
            }
            .onChange(of: currentHost?.homeCards.map(\.id) ?? []) { _, ids in
                for id in ids where exitingCards[id] != nil || (swipeTranslations[id] ?? 0) < 0 {
                    // A rejected/expired close is authoritative: cancel the departure and restore this key.
                    guard currentHost?.connection.closingRuntimeIds.contains(id) != true, !swipingRuntimeIds.contains(id) else { continue }
                    exitingCards[id] = nil
                    withAnimation(reduceMotion ? nil : .orbisDrag) { swipeTranslations[id] = 0 }
                }
            }
            .onDisappear { selectedRuntimeIds = []; exitingCards = [:]; resetCloseSwipes(); onSelection(false) }
    }

    private var homeSessionList: some View {
        // Only the current computer's sessions: several paired computers never share one list (ADR-0030 修订).
        ScrollViewReader { proxy in ScrollView {
            LazyVStack(spacing: 12) {
                if let host = currentHost {
                    if draftOpen {
                        SessionDraftView(owner: store.activeConnection, presetCwd: draftCwd, closeRequest: draftCloseRequest, onSubmitted: onDraftSubmitted, onCancel: onDraftCancelled)
                            .id(store.selectedHostId).id("home-draft").transition(.opacity.combined(with: .offset(y: 4)))
                    }
                    ForEach(presentedCards(host)) { card in
                        // ADR-0049 §5：提交关闭后卡片沿滑动方向退场；电脑拒绝时再回到原位置。
                        runtimeCard(card, host: host)
                            .transition(.opacity)
                            .allowsHitTesting(exitingCards[card.id] == nil && !draftOpen)
                            .opacity(draftOpen ? 0.4 : 1)
                            .accessibilityHidden(exitingCards[card.id] != nil)
                    }
                    if host.connection.homeRuntimesLoading {
                        firstLoadStatus(host.connection.preparedHomeSync)
                    } else if presentedCards(host).isEmpty {
                        OrbisEmptyState(symbol: "desktopcomputer", title: L10n.tr("暂无在线会话"))
                            .frame(minHeight: 180).accessibilityIdentifier("home-session-empty")
                        OrbisActionButton(title: L10n.tr("查看会话目录"), symbol: "folder", action: onDirectory)
                    }
                }
            }.padding(.horizontal, 20).padding(.top, 12).padding(.bottom, 28)
                .background(HomePullRefresh(identity: store.selectedHostId, enabled: !selecting,
                                            tint: UIColor(OrbisPalette(scheme).secondary),
                                            refresh: store.refresh))
                .coordinateSpace(name: "home-session-content")
                .onGeometryChange(for: CGPoint.self) { $0.frame(in: .global).origin } action: {
                    homeListGeometry.contentOrigin = $0
                }
        }.frame(maxWidth: .infinity, maxHeight: .infinity)
            // Recognize alongside the scroll view itself. A child DragGesture can win
            // recognition before its direction guard runs and prevent native scrolling.
            .simultaneousGesture(closeSwipeGesture)
            .accessibilityAction(named: L10n.tr("刷新会话")) { if !selecting { store.refresh() } }
            .accessibilityIdentifier("home-session-list")
            .onChange(of: draftOpen) { _, open in if open { withAnimation(reduceMotion ? nil : .orbisCollapse) { proxy.scrollTo("home-draft", anchor: .top) } } }
        }
    }

    private var currentHost: HostSnapshot? { store.hosts.first { $0.hostId == store.selectedHostId } }
    private var closableRuntimeIds: Set<String> {
        guard let host = currentHost else { return [] }
        return Set(host.homeCards.filter { host.connection.canCloseRuntime($0.id) }.map(\.id))
    }

    private var selecting: Bool { !selectedRuntimeIds.isEmpty }

    /// Sync progress after the first snapshot is published; before that the list area reports it.
    private var backgroundSync: HomeSyncStatus {
        guard let connection = currentHost?.connection, !connection.homeRuntimesLoading else { return .idle }
        return connection.preparedHomeSync
    }

    private var retryLabel: String {
        store.connection == .secured ? L10n.tr("重新加载会话") : L10n.tr("重新连接")
    }

    /// Before the first complete snapshot the list is empty, so its own area says why:
    /// loading and failure take the empty state's place and never sit above cards.
    private func firstLoadStatus(_ sync: HomeSyncStatus) -> some View {
        let p = OrbisPalette(scheme)
        return VStack(spacing: 14) {
            if case .failed(let error) = sync {
                Image(systemName: "exclamationmark.circle").font(.system(size: 40)).foregroundStyle(p.error)
                Text(error).font(.orbisBody(.semibold)).multilineTextAlignment(.center)
                    .frame(maxWidth: .infinity)
                OrbisActionButton(title: store.connection == .secured ? L10n.tr("重新加载") : L10n.tr("重新连接"),
                                  symbol: "arrow.clockwise", action: store.refresh)
                    .accessibilityLabel(retryLabel)
                    .padding(.top, 6)
            } else {
                VStack(spacing: 12) {
                    ForEach(0..<3) { _ in
                        HStack(alignment: .top, spacing: 12) {
                            OrbisSkeleton(width: 48, height: 48, radius: 16)
                            VStack(alignment: .leading, spacing: 8) {
                                OrbisSkeleton(height: 16, radius: 6)
                                OrbisSkeleton(width: 180, height: 12, radius: 4)
                                OrbisSkeleton(width: 112, height: 12, radius: 4)
                            }
                        }.padding(16).neuSurface(inset: true, radius: 24, intensity: 0.4)
                    }
                }.accessibilityElement(children: .ignore).accessibilityLabel(L10n.tr("正在加载会话…"))
                    .accessibilityIdentifier("home-loading-skeleton")
            }
        }.padding(.vertical, 24).frame(maxWidth: .infinity, minHeight: 180)
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("home-session-status")
    }

    private func resetCloseSwipes() {
        swipeTranslations = swipeTranslations.filter { exitingCards[$0.key] != nil }
        armedCloseRuntimeIds = []
        swipingRuntimeIds = []
        closeSwipeRuntimeId = nil
        closeSwipeDirectionDecided = false
    }

    private var closeSwipeGesture: some Gesture {
        DragGesture(minimumDistance: 8, coordinateSpace: .global)
            .updating($closeSwipeActive) { _, active, _ in active = true }
            .onChanged { value in
                guard !selecting, let host = currentHost else { return }
                if !closeSwipeDirectionDecided {
                    closeSwipeDirectionDecided = true
                    let start = CGPoint(x: value.startLocation.x - homeListGeometry.contentOrigin.x,
                                        y: value.startLocation.y - homeListGeometry.contentOrigin.y)
                    // Lock the initial direction: a vertical or rightward drag stays with
                    // scrolling / the directory, even if the finger later changes course.
                    guard value.translation.width < -abs(value.translation.height),
                          let card = host.homeCards.first(where: {
                              runtimeCardFrames[$0.id]?.contains(start) == true
                          }), host.connection.homeCardIsCurrent(card), host.connection.canCloseRuntime(card.id) else { return }
                    closeSwipeRuntimeId = card.id
                }
                guard let id = closeSwipeRuntimeId,
                      let card = host.homeCards.first(where: { $0.id == id }),
                      host.connection.homeCardIsCurrent(card), host.connection.canCloseRuntime(card.id) else { return }
                let width = runtimeCardFrames[id]?.width ?? 0
                let threshold = width * 0.4
                let horizontal = value.translation.width
                swipingRuntimeIds.insert(id)
                let wasArmed = armedCloseRuntimeIds.contains(id)
                let disarmThreshold = threshold * 0.96
                let armed = threshold > 0 && (wasArmed ? horizontal <= -disarmThreshold : horizontal <= -threshold)
                if armed && !armedCloseRuntimeIds.contains(id) { OrbisHaptics.commit() }
                swipeTranslations[id] = min(0, max(-width, horizontal < -threshold ? -threshold + (horizontal + threshold) * 0.4 : horizontal))
                if armed { armedCloseRuntimeIds.insert(id) }
                else { armedCloseRuntimeIds.remove(id) }
            }
            .onEnded { value in
                let id = closeSwipeRuntimeId
                closeSwipeRuntimeId = nil
                closeSwipeDirectionDecided = false
                guard !selecting, let id else { return }
                // Let this release's button action finish before accepting taps again.
                DispatchQueue.main.async { swipingRuntimeIds.remove(id) }
                let threshold = (runtimeCardFrames[id]?.width ?? 0) * 0.4
                var closing = false
                if let host = currentHost,
                   let card = host.homeCards.first(where: { $0.id == id }),
                   host.connection.homeCardIsCurrent(card), threshold > 0,
                   armedCloseRuntimeIds.contains(id), value.translation.width <= -(threshold * 0.96) {
                    closing = !beginClose([id], host: host).isEmpty
                }
                if !closing { armedCloseRuntimeIds.remove(id) }
                if !closing {
                    withAnimation(reduceMotion ? .easeOut(duration: 0.12) : .spring(response: 0.28, dampingFraction: 0.82)) {
                        swipeTranslations[id] = 0
                    }
                }
            }
    }

    private func toggleSelection(_ id: String) {
        guard closableRuntimeIds.contains(id) else { return }
        OrbisHaptics.selectionChanged()
        if selectedRuntimeIds.contains(id) { selectedRuntimeIds.remove(id) }
        else { selectedRuntimeIds.insert(id) }
    }

    private func beginSelection(_ id: String) {
        guard closableRuntimeIds.contains(id) else { return }
        if !selectedRuntimeIds.contains(id) { OrbisHaptics.beginSelection() }
        selectedRuntimeIds.insert(id)
    }

    private func presentedCards(_ host: HostSnapshot) -> [HomeRuntimeCard] {
        var cards = host.homeCards
        for exit in exitingCards.values.sorted(by: { $0.index < $1.index }) where !cards.contains(where: { $0.id == exit.card.id }) {
            cards.insert(exit.card, at: min(exit.index, cards.count))
        }
        return cards
    }

    @discardableResult private func beginClose(_ ids: Set<String>, host: HostSnapshot) -> Set<String> {
        let cards = host.homeCards
        let submitted = store.closeRuntimes(hostId: host.hostId, runtimeIds: ids.intersection(closableRuntimeIds))
        for (index, card) in cards.enumerated() where submitted.contains(card.id) {
            let exit = ExitingCard(card: card, index: index)
            exitingCards[card.id] = exit
            withAnimation(reduceMotion ? nil : InteractionMotion.dismiss, completionCriteria: .removed) {
                swipeTranslations[card.id] = -(runtimeCardFrames[card.id]?.width ?? 0) - 40
            } completion: {
                guard store.selectedHostId == host.hostId, exitingCards[card.id]?.token == exit.token else { return }
                withAnimation(reduceMotion ? nil : InteractionMotion.state, completionCriteria: .removed) {
                    exitingCards[card.id] = nil
                } completion: {
                    if exitingCards[card.id] == nil { swipeTranslations[card.id] = nil }
                }
                armedCloseRuntimeIds.remove(card.id)
            }
        }
        return submitted
    }

    private func closeSelectedRuntimes() {
        guard let host = currentHost else { return }
        let currentIds = Set(host.homeCards.filter(host.connection.homeCardIsCurrent).map(\.id))
        selectedRuntimeIds.subtract(beginClose(selectedRuntimeIds.intersection(currentIds), host: host))
    }

    /// The current computer; with several paired computers it is also the switcher.
    @ViewBuilder private var hostSwitcher: some View {
        let p = OrbisPalette(scheme)
        let name = store.selectedHost?.hostName ?? L10n.tr("选择电脑")
        if store.pairings.count > 1 {
            OrbisMenuButton(accessibilityLabel: L10n.tr("切换电脑，当前 {0}", name), padding: 0,
                            items: { hostSwitchMenuItems(store) }) {
                HStack(spacing: 8) {
                    OrbisActionSymbol(systemName: "desktopcomputer").foregroundStyle(p.accent)
                    Text(name).font(.orbisLabel(.semibold)).lineLimit(1)
                    // A waiting approval on another computer; the menu names which one.
                    if store.hosts.contains(where: { $0.hostId != store.selectedHostId && hostHasPendingInteraction($0) }) {
                        Circle().fill(p.error).frame(width: 7, height: 7).accessibilityLabel(L10n.tr("其他电脑有待确认"))
                    }
                    OrbisActionSymbol(systemName: "chevron.up.chevron.down").imageScale(.small).foregroundStyle(p.secondary)
                }.padding(.horizontal, 12).frame(minHeight: 36)
            }
        } else {
            Label(name, systemImage: "desktopcomputer").font(.orbisLabel(.semibold)).lineLimit(1)
                .padding(.horizontal, 4)
        }
    }

    private func runtimeCard(_ card: HomeRuntimeCard, host: HostSnapshot) -> some View {
        let runtime = card.runtime
        let selected = selectedRuntimeIds.contains(runtime.runtimeId)
        let translation = swipeTranslations[runtime.runtimeId] ?? 0
        let cardWidth = runtimeCardFrames[runtime.runtimeId]?.width ?? 0
        let reveal = min(cardWidth, max(0, -translation))
        let armed = armedCloseRuntimeIds.contains(runtime.runtimeId) || exitingCards[runtime.runtimeId] != nil
        return HStack(spacing: 0) {
            ZStack(alignment: .trailing) {
                if !selecting {
                    HStack(spacing: 12) {
                        OrbisMotionText(armed ? L10n.tr("松手关闭") : L10n.tr("关闭"))
                            .font(.orbisLabel(.semibold)).lineLimit(1).minimumScaleFactor(0.8)
                            .frame(width: 100, alignment: .trailing)
                        ZStack {
                            Image(systemName: "xmark").font(.system(size: 16, weight: .semibold))
                                .frame(width: 28, height: 28)
                                .neuSurface(inset: !armed, radius: 14, intensity: 0.4, concentric: false)
                            Circle().stroke(OrbisPalette(scheme).secondary.opacity(0.2), lineWidth: 2)
                                .frame(width: 34, height: 34)
                            Circle().trim(from: 0, to: min(1, reveal / max(1, cardWidth * 0.4)))
                                .stroke(style: StrokeStyle(lineWidth: 2, lineCap: .round))
                                .frame(width: 34, height: 34).rotationEffect(.degrees(-90))
                        }.scaleEffect(armed ? 1.12 : 1)
                            .animation(reduceMotion ? nil : .orbisPop, value: armed)
                    }.foregroundStyle(armed ? OrbisPalette(scheme).error : OrbisPalette(scheme).secondary)
                        .frame(width: 164, alignment: .trailing).frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .trailing)
                        .padding(.trailing, 12)
                        .neuSurface(inset: true, radius: OrbisRadius.card, intensity: 0.65)
                        .opacity(reveal > 0 ? 1 : 0)
                        .accessibilityHidden(true)
                }
                Button {
                    guard !swipingRuntimeIds.contains(runtime.runtimeId) else { return }
                    if selecting { toggleSelection(runtime.runtimeId) }
                    else {
                        #if DEBUG
                        ChatEntryProbe.shared.begin()
                        #endif
                        onOpenRuntime(host.hostId, runtime)
                        #if DEBUG
                        ChatEntryProbe.shared.selected()
                        #endif
                    }
                } label: {
                    HomeCardContent(card: card, selected: selected,
                        selecting: selecting && host.connection.canCloseRuntime(runtime.runtimeId)).equatable()
                }.buttonStyle(OrbisSelectionButtonStyle(selected: selected, selecting: selecting, padding: OrbisRadius.cardPadding + 4))
                    .offset(x: translation)
                    .highPriorityGesture(LongPressGesture().onEnded { _ in beginSelection(runtime.runtimeId) })
                    .accessibilityIdentifier("home-runtime-\(runtime.runtimeId)")
                    .accessibilityAddTraits(selected ? .isSelected : [])
                    .accessibilityActions {
                        if host.connection.canCloseRuntime(runtime.runtimeId) { Button(L10n.tr("选择会话")) { beginSelection(runtime.runtimeId) } }
                    }
            }
            .onGeometryChange(for: CGRect.self) { $0.frame(in: .named("home-session-content")) } action: {
                runtimeCardFrames[runtime.runtimeId] = $0
            }
        }.accessibilityElement(children: .contain)
            .disabled(!host.connection.homeCardIsCurrent(card))
    }

}

/// Card contents depend only on visible facts; chat/history updates cannot rebuild the label.
private struct HomeCardContent: View, Equatable {
    let card: HomeRuntimeCard
    let selected: Bool
    let selecting: Bool
    @Environment(\.colorScheme) private var scheme
    @AppStorage("orbis.appearance") private var visualStyle = "mist"
    static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.card == rhs.card && lhs.selected == rhs.selected && lhs.selecting == rhs.selecting &&
            lhs.visualStyle == rhs.visualStyle
    }
    var body: some View {
        let runtime = card.runtime, kind = card.agentKind, pending = card.hasPendingInteraction
        HStack(alignment: .top, spacing: 12) {
            AgentEmblem(kind: kind, size: 40)
            VStack(alignment: .leading, spacing: 2) {
                OrbisMotionText(card.title).font(.orbisBody(.semibold)).lineLimit(2)
                Text(runtime.cwd)
                    .font(.orbisCaption(mono: true)).foregroundStyle(OrbisPalette(scheme).secondary).lineLimit(1).truncationMode(.middle)
                HStack(spacing: 10) {
                    Text(agentTitle(kind)).font(.orbisCaption(.medium)).foregroundStyle(OrbisPalette(scheme).agent(kind))
                    // A pending interaction takes the status slot instead of adding a line to the card.
                    if pending {
                        Label(L10n.tr("待确认"), systemImage: "exclamationmark.circle").font(.orbisCaption(.semibold))
                            .foregroundStyle(OrbisPalette(scheme).error)
                    } else { RuntimeStatusLabel(status: runtime.presentationStatus, title: runtime.presentationTitle) }
                }
            }.frame(maxWidth: .infinity, alignment: .leading)
            OrbisSelectionIndicator(selected: selected, selecting: selecting)
        }.frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// Connection text stays stable while background synchronization breathes in the raised status dot.
struct ConnectionPill: View {
    let connection: ConnectionState
    let path: String?
    @Environment(\.colorScheme) private var scheme
    @AppStorage("orbis.appearance") private var visualStyle = "mist"
    @Environment(\.orbisReduceMotion) private var reduceMotion
    var sync: HomeSyncStatus = .idle
    var stateLabel = false
    var body: some View {
        let p = OrbisPalette(scheme)
        let secured = connection == .secured
        let failed: Bool = { if case .failed = sync { return true }; return false }()
        let busy = connection == .connecting || connection == .online
        let tone = connection == .error || (secured && failed) ? p.error : secured ? p.success : p.warning
        // SC53: background reads keep the transport label and capsule geometry stable.
        let title = !secured ? connectionTitle(connection) : stateLabel ? L10n.tr("已连接") : failed ? L10n.tr("同步失败")
            : pathTitle(path ?? "relay")
        HStack(spacing: 6) {
            ZStack {
                if busy { ProgressView().controlSize(.mini).tint(tone).scaleEffect(0.8) }
                else {
                    OrbisStatusDot(tone: tone, working: secured && sync == .syncing)
                        .accessibilityElement(children: .ignore)
                        .accessibilityLabel(L10n.tr("连接状态"))
                        .accessibilityValue(secured && sync == .syncing ? L10n.tr("正在同步") : title)
                        .accessibilityIdentifier("home-connection-indicator")
                }
                }.frame(width: 16, height: 16)
            ZStack {
                // Route labels reserve the same space: a real LAN/Relay handoff
                // or background sync does not move the capsule's leading edge.
                if secured && !stateLabel && !failed {
                    Text(L10n.tr("局域网")).hidden().accessibilityHidden(true)
                    Text(L10n.tr("中继")).hidden().accessibilityHidden(true)
                }
                OrbisMotionText(title).foregroundStyle(secured && failed ? p.error : p.secondary)
            }
            if secured { Image(systemName: "lock.shield").accessibilityLabel(L10n.tr("端到端加密")) }
        }.font(.orbisLabel()).foregroundStyle(tone).padding(.horizontal, 12).frame(minHeight: 32)
            .neuSurface(radius: 16, intensity: 0.4, concentric: false)
            .animation(reduceMotion ? nil : .orbisFade, value: title)
            // A status group, not a button: its texts stay readable one by one.
            .accessibilityElement(children: .contain)
    }
}

/// Status is ink: a matte dot, with an orbit only while work is in progress.
struct OrbisStatusDot: View {
    let tone: Color
    var working = false
    var hollow = false
    @Environment(\.orbisReduceMotion) private var reduced
    @Environment(\.orbisVisible) private var visible
    @Environment(\.scenePhase) private var scenePhase
    @State private var started = Date()
    var body: some View {
        let animated = working && visible && !reduced && scenePhase == .active
        TimelineView(.animation(minimumInterval: 1.0 / 30, paused: !animated)) { context in
            ZStack {
                Circle().fill(hollow ? .clear : tone).frame(width: working ? 6 : 8, height: working ? 6 : 8)
                    .overlay { if hollow { Circle().strokeBorder(tone, lineWidth: 1.5) } }
                if working {
                    Circle().trim(from: 0.10, to: 0.80)
                        .stroke(AngularGradient(colors: [tone.opacity(0), tone], center: .center), style: StrokeStyle(lineWidth: 1.5, lineCap: .round))
                        .rotationEffect(.degrees(animated ? context.date.timeIntervalSince(started) / 1.1 * 360 : 0))
                }
            }
        }.frame(width: 16, height: 16).accessibilityHidden(true)
    }
}

/// Shared by the home row and the drawer footer: pick another paired computer. Only the drawer's
/// computer menu adds or unpairs computers (ADR-0046 §5), so it passes those actions.
@MainActor
func hostSwitchMenuItems(_ store: OrbisStore, onAddHost: (() -> Void)? = nil, onUnpair: ((HostPairing) -> Void)? = nil) -> [OrbisMenuItem] {
    var items: [OrbisMenuItem] = store.pairings.map { host in
        let snapshot = store.hosts.first { $0.hostId == host.hostId }
        let state = snapshot.map { L10n.tr("，") + connectionTitle($0.connectionState) } ?? ""
        let pending = snapshot.map(hostHasPendingInteraction) == true ? L10n.tr("，有待确认") : ""
        return OrbisMenuItem(title: host.hostName + state + pending, symbol: "desktopcomputer", checked: host.hostId == store.selectedHostId) {
            if host.hostId != store.selectedHostId { store.connect(hostId: host.hostId) }
        }
    }
    if onAddHost != nil || onUnpair != nil {
        items = [OrbisMenuItem(title: L10n.tr("切换电脑"), symbol: "desktopcomputer", children: items)]
    }
    if let onAddHost {
        items.append(.divider)
        items.append(OrbisMenuItem(title: L10n.tr("添加电脑"), symbol: "plus", action: onAddHost))
    }
    if let onUnpair, let host = store.selectedHost {
        items.append(OrbisMenuItem(title: L10n.tr("取消配对 {0}", host.hostName), symbol: "link", destructive: true) { onUnpair(host) })
    }
    return items
}

/// Another computer's approvals stay visible from the switcher once the list shows only one computer.
@MainActor
func hostHasPendingInteraction(_ host: HostSnapshot) -> Bool { host.connection.interactions.values.contains { !$0.isEmpty } }

func connectionTitle(_ state: ConnectionState) -> String {
    switch state {
    case .offline: return L10n.tr("未连接")
    case .connecting: return L10n.tr("正在连接")
    case .online: return L10n.tr("正在建立安全通道")
    case .secured: return L10n.tr("端到端加密已连接")
    case .error: return L10n.tr("连接错误")
    }
}
