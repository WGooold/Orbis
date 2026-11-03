import SwiftUI

private enum AppPage: Hashable { case chat, pairing, status, providers, history, downloads }

struct ContentView: View {
    @EnvironmentObject private var store: OrbisStore
    @Environment(\.colorScheme) private var scheme
    @AppStorage("orbis.visualStyle") private var visualStyle = "classic"
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.orbisReduceMotion) private var reduceMotion
    @StateObject private var navigation = OrbisPageStack<AppPage>()
    @State private var drawerOpen = false
    @State private var directoryState = SessionDirectoryState()
    @State private var newSessionOpen = false
    @State private var newSessionCwd: String?
    @State private var launchIntro: HostConnection.LaunchState?
    @State private var launchIntroReady = false
    @StateObject private var overlay = OrbisOverlay()

    init() {
        #if DEBUG
        let preview = ProcessInfo.processInfo.arguments.first { $0.hasPrefix("--preview-screen=") }?.split(separator: "=").last.map(String.init)
        switch preview {
        case "chat", "slash", "approval", "tool", "queue", "notices", "interactions", "truncated", "viewport", "changes": _navigation = StateObject(wrappedValue: OrbisPageStack([.chat]))
        case "status": _navigation = StateObject(wrappedValue: OrbisPageStack([.status]))
        case "providers": _navigation = StateObject(wrappedValue: OrbisPageStack([.status, .providers]))
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
                    home
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
                        } else { OrbisEmptyState(symbol: "desktopcomputer", title: "会话已离线") }
                    case .pairing: PairingEntryView(onCancel: back, onCode: store.pair)
                    case .status: ConnectionStatusView(onBack: back)
                    case .providers: AgentProvidersView(onBack: back)
                    case .history: HistoryBranchView(onBack: back, onDownloads: { push(.downloads) })
                    case .downloads: DownloadsView(onBack: back)
                    }
                }
                .modifier(OrbisMessageActionScope())
                .foregroundStyle(OrbisPalette(scheme).text)
                .background(OrbisPalette(scheme).base.ignoresSafeArea())
                .toolbar(.hidden, for: .navigationBar)
                .modifier(OrbisPageTransition(onBack: back,
                                              underlay: { navigation.underlay(below: page) { home } }))
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
        .modifier(SessionDrawerModifier(isOpen: $drawerOpen, edgeSwipeEnabled: navigation.pages.isEmpty && !store.pairings.isEmpty && !store.isPairing) {
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
        .sheet(isPresented: $newSessionOpen, onDismiss: { store.dismissBrowse(); launchIntroReady = launchIntro != nil }) {
            NewSessionView(presetCwd: newSessionCwd, onCreated: { launch in
                launchIntro = launch; launchIntroReady = false
                navigation.replace(with: [])
            }) { newSessionOpen = false }
                .environmentObject(store).orbisSheet([.large])
        }
        .onChange(of: store.selectedHostId) { _, _ in overlay.dismissMenu(); launchIntro = nil; launchIntroReady = false }
        .onChange(of: store.pairings) { _, _ in overlay.dismissMenu() }
        .onChange(of: navigation.pages) { _, pages in
            overlay.dismissMenu()
            // ADR-0049 §6.8：离开启动页不取消启动，成功后也不把用户拉回。
            if !pages.contains(.chat) && launchIntro == nil { store.stopFollowingLaunch() }
        }
        .onChange(of: drawerOpen) { _, open in if open { cancelLaunchIntro() } else { overlay.dismissMenu() } }
        .onChange(of: store.activationRevision) { _, _ in
            setDrawer(false); newSessionOpen = false
            if store.selectedRuntime != nil && launchIntro == nil { navigation.replace(with: [.chat]) }
        }
        .onChange(of: store.selectedRuntimeId) { old, next in
            if old != nil && next == nil && navigation.pages.contains(.chat) { navigation.replace(with: []) }
        }
        .onChange(of: store.isPairing) { old, active in
            if old && !active && store.errorMessage == nil && store.selectedHost != nil { navigation.replace(with: []) }
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
        #if DEBUG
        .overlay(alignment: .topLeading) { if ChatEntryProbe.enabled { ChatEntryReport() } }
        .overlay(alignment: .bottomLeading) { if PageReturnProbe.enabled { PageReturnReport() } }
        #endif
    }

    private var home: some View {
        HomeView(launchIntro: launchIntroReady ? launchIntro : nil, onLaunchPresented: { requestId in
            guard launchIntro?.requestId == requestId, !drawerOpen, !newSessionOpen, navigation.pages.isEmpty else { return }
            launchIntro = nil; launchIntroReady = false
            if store.selectedRuntime != nil { navigation.replace(with: [.chat]) }
        }, onDirectory: { setDrawer(true) }, onSettings: { push(.status) },
                 onDownloads: { push(.downloads) },
                 onOpenRuntime: { hostId, runtime in
                     store.selectHost(hostId)
                     openRuntime(runtime)
                 })
    }

    private var drawer: some View {
        SessionDrawerView(state: $directoryState, onClose: { setDrawer(false) },
                          onOpenSession: { session in
                              if let runtime = store.runtimes.first(where: { $0.sessionId == session.sessionId }) { openRuntime(runtime) }
                              else if store.openCachedSession(session) { setDrawer(false); navigation.replace(with: [.chat]) }
                              else {
                                  overlay.showDialog("本机尚无缓存", message: "连接电脑并打开会话后，可把历史保存在本机。", actions: [OrbisDialogAction(title: "返回", role: .cancel)] + (store.connection == .secured ? [OrbisDialogAction(title: "在电脑继续会话") { store.activate(session) }] : []))
                              }
                          },
                          onNewSession: { cwd in
                              newSessionCwd = cwd; setDrawer(false); newSessionOpen = true
                          }, onAddHost: { setDrawer(false); push(.pairing) },
                          onProviders: { setDrawer(false); push(.status) },
                          onUnpair: { confirmUnpair($0) })
    }

    private func back() { navigation.back() }
    private func cancelLaunchIntro() {
        guard launchIntro != nil else { return }
        launchIntro = nil; launchIntroReady = false
        store.stopFollowingLaunch()
    }
    private func push(_ page: AppPage) { cancelLaunchIntro(); navigation.push(page) }
    private func setDrawer(_ open: Bool) {
        if open { cancelLaunchIntro() }
        withAnimation(reduceMotion ? nil : .orbisDrag) { drawerOpen = open }
    }
    private func confirmUnpair(_ host: HostPairing?) {
        guard let host else { return }
        overlay.showDialog("取消配对这台电脑？", message: "此电脑在本机保存的配对和草稿将被移除。之后可以重新扫码连接。", actions: [
            OrbisDialogAction(title: "返回", role: .cancel),
            OrbisDialogAction(title: "取消配对 \(host.hostName)", role: .destructive) {
                store.unpair(hostId: host.hostId); navigation.replace(with: []); setDrawer(false)
            }
        ])
    }
    private func openRuntime(_ runtime: RuntimeSummary) {
        cancelLaunchIntro()
        store.selectRuntime(runtime.runtimeId); setDrawer(false); navigation.replace(with: [.chat])
    }
}

/// 会话目录抽屉。关闭时在主页左侧（左 40% 宽度内）起手向右横拖即把抽屉拉出；打开时在抽屉
/// 或遮罩上向左拖动即推回。拖动过程中抽屉与遮罩跟随手指，松手按位置与速度吸附到打开或关闭。
/// 拉出手势挂在页面内容上与之同时识别，并按第一段位移锁定方向，竖向滚动主页时不会带出抽屉。
private struct SessionDrawerModifier<Drawer: View>: ViewModifier {
    @Environment(\.colorScheme) private var scheme
    @AppStorage("orbis.visualStyle") private var visualStyle = "classic"
    @Environment(\.orbisReduceMotion) private var reduceMotion
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
                            .accessibilityElement(children: .contain)
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
    @AppStorage("orbis.visualStyle") private var visualStyle = "classic"
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
                OrbisIconButton(symbol: "xmark", label: "关闭文件提示") { transfers.error = nil }
            }.padding(16)
        }
    }
}

struct HomeView: View {
    var launchIntro: HostConnection.LaunchState? = nil
    var onLaunchPresented: (String) -> Void = { _ in }
    @Environment(\.orbisReduceMotion) private var reduceMotion
    @EnvironmentObject private var store: OrbisStore
    @Environment(\.colorScheme) private var scheme
    @AppStorage("orbis.visualStyle") private var visualStyle = "classic"
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
                                label: selecting ? "退出多选" : "打开会话目录", morphFrom: "line.3.horizontal") {
                    if selecting { selectedRuntimeIds = [] } else { onDirectory() }
                }
            } title: {
                if selecting {
                    OrbisMotionText("已选择 \(selectedRuntimeIds.count) 项").font(.orbisTitle())
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
                OrbisSelectionToolbar(selecting: selecting) { progress in
                    HStack(spacing: 8) {
                        OrbisIconButton(symbol: "arrow.down.to.line", label: "下载", action: onDownloads)
                            .offset(x: 24 * progress).accessibilityIdentifier("home-downloads")
                        OrbisIconButton(symbol: "gearshape", label: "设置", action: onSettings)
                            .offset(x: -24 * progress).accessibilityIdentifier("home-settings")
                    }
                } selected: {
                    Button("关闭") { closeSelectedRuntimes() }
                        .font(.orbisLabel(.semibold)).foregroundStyle(OrbisPalette(scheme).error)
                        .buttonStyle(NeuButtonStyle(padding: 12))
                        .accessibilityLabel("关闭选中会话").disabled(store.connection != .secured)
                }
            }
            // One fixed row: which computer this page shows, how it is connected and, once the
            // list is published, whether it is still syncing. Retry joins the row without moving the cards.
            // The capsule only reports state; settings open from the gear (ADR-0053 §4).
            HStack(spacing: 10) {
                hostSwitcher
                Spacer(minLength: 8)
                ConnectionPill(sync: backgroundSync)
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
            .onChange(of: selecting) { _, active in if active { resetCloseSwipes() } }
            .onChange(of: closeSwipeActive) { _, active in
                // Opening the directory can cancel this simultaneous gesture without onEnded.
                if !active && closeSwipeDirectionDecided {
                    withAnimation(reduceMotion ? .easeOut(duration: 0.12) : .spring(response: 0.28, dampingFraction: 0.82)) {
                        resetCloseSwipes()
                    }
                }
            }
            .onChange(of: currentHost?.homeRuntimes.map(\.runtimeId) ?? []) { _, ids in
                selectedRuntimeIds.formIntersection(ids)
            }
            .onChange(of: currentHost?.homeCards.map(\.id) ?? []) { _, ids in
                for id in ids where exitingCards[id] != nil || (swipeTranslations[id] ?? 0) < 0 {
                    // A rejected/expired close is authoritative: cancel the departure and restore this key.
                    guard currentHost?.connection.closingRuntimeIds.contains(id) != true, !swipingRuntimeIds.contains(id) else { continue }
                    exitingCards[id] = nil
                    withAnimation(reduceMotion ? nil : .orbisDrag) { swipeTranslations[id] = 0 }
                }
            }
            .onDisappear { selectedRuntimeIds = []; exitingCards = [:]; resetCloseSwipes() }
    }

    private var homeSessionList: some View {
        // Only the current computer's sessions: several paired computers never share one list (ADR-0030 修订).
        ScrollViewReader { proxy in ScrollView {
            LazyVStack(spacing: 16) {
                if let host = currentHost {
                    ForEach(presentedCards(host)) { card in
                        // ADR-0049 §5：提交关闭后卡片沿滑动方向退场；电脑拒绝时再回到原位置。
                        runtimeCard(card, host: host)
                            .transition(.opacity)
                            .allowsHitTesting(exitingCards[card.id] == nil)
                            .accessibilityHidden(exitingCards[card.id] != nil)
                    }
                    if let launchIntro {
                        OrbisNewSessionCard(title: launchIntro.title, kind: launchIntro.agentKind, requestId: launchIntro.requestId, onPresented: { onLaunchPresented(launchIntro.requestId) })
                            .id("new-session-" + launchIntro.requestId)
                    }
                    if host.connection.homeRuntimesLoading {
                        firstLoadStatus(host.connection.homeSyncStatus)
                    } else if presentedCards(host).isEmpty && launchIntro == nil {
                        OrbisEmptyState(symbol: "desktopcomputer", title: "暂无在线会话")
                            .frame(minHeight: 180).accessibilityIdentifier("home-session-empty")
                        OrbisActionButton(title: "查看会话目录", symbol: "folder", action: onDirectory)
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
            .accessibilityAction(named: "刷新会话") { if !selecting { store.refresh() } }
            .accessibilityIdentifier("home-session-list")
            .onChange(of: launchIntro?.requestId) { _, id in
                if let id { proxy.scrollTo("new-session-" + id, anchor: .bottom) }
            }
        }
    }

    private var currentHost: HostSnapshot? { store.hosts.first { $0.hostId == store.selectedHostId } }
    private var selecting: Bool { !selectedRuntimeIds.isEmpty }

    /// Sync progress after the first snapshot is published; before that the list area reports it.
    private var backgroundSync: HomeSyncStatus {
        guard let connection = currentHost?.connection, !connection.homeRuntimesLoading else { return .idle }
        return connection.homeSyncStatus
    }

    private var retryLabel: String {
        store.connection == .secured ? "重新加载会话" : "重新连接"
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
                OrbisActionButton(title: store.connection == .secured ? "重新加载" : "重新连接",
                                  symbol: "arrow.clockwise", action: store.refresh)
                    .accessibilityLabel(retryLabel)
                    .padding(.top, 6)
            } else {
                ProgressView().frame(width: 40, height: 40)
                Text("正在加载会话…").font(.orbisBody(.semibold)).foregroundStyle(p.secondary)
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
                          }), host.connection.homeCardIsCurrent(card) else { return }
                    closeSwipeRuntimeId = card.id
                }
                guard let id = closeSwipeRuntimeId,
                      let card = host.homeCards.first(where: { $0.id == id }),
                      host.connection.homeCardIsCurrent(card) else { return }
                let width = runtimeCardFrames[id]?.width ?? 0
                let threshold = width / 2
                let horizontal = value.translation.width
                swipingRuntimeIds.insert(id)
                let armed = threshold > 0 && horizontal <= -threshold
                if armed != armedCloseRuntimeIds.contains(id) {
                    OrbisHaptics.commit()
                }
                swipeTranslations[id] = min(0, max(-width, horizontal))
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
                let threshold = (runtimeCardFrames[id]?.width ?? 0) / 2
                var closing = false
                if let host = currentHost,
                   let card = host.homeCards.first(where: { $0.id == id }),
                   host.connection.homeCardIsCurrent(card), threshold > 0,
                   armedCloseRuntimeIds.contains(id), value.translation.width <= -threshold {
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
        OrbisHaptics.selectionChanged()
        if selectedRuntimeIds.contains(id) { selectedRuntimeIds.remove(id) }
        else { selectedRuntimeIds.insert(id) }
    }

    private func beginSelection(_ id: String) {
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
        let submitted = store.closeRuntimes(hostId: host.hostId, runtimeIds: ids)
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
        let name = store.selectedHost?.hostName ?? "选择电脑"
        if store.pairings.count > 1 {
            OrbisMenuButton(accessibilityLabel: "切换电脑，当前 \(name)", padding: 0,
                            items: { hostSwitchMenuItems(store) }) {
                HStack(spacing: 8) {
                    OrbisActionSymbol(systemName: "desktopcomputer").foregroundStyle(p.accent)
                    Text(name).font(.orbisLabel(.semibold)).lineLimit(1)
                    // A waiting approval on another computer; the menu names which one.
                    if store.hosts.contains(where: { $0.hostId != store.selectedHostId && hostHasPendingInteraction($0) }) {
                        Circle().fill(p.error).frame(width: 7, height: 7).accessibilityLabel("其他电脑有待确认")
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
        let kind = card.agentKind
        let pending = card.hasPendingInteraction
        let selected = selectedRuntimeIds.contains(runtime.runtimeId)
        let translation = swipeTranslations[runtime.runtimeId] ?? 0
        let cardWidth = runtimeCardFrames[runtime.runtimeId]?.width ?? 0
        let reveal = min(cardWidth, max(0, -translation))
        let armed = armedCloseRuntimeIds.contains(runtime.runtimeId) || exitingCards[runtime.runtimeId] != nil
        return HStack(spacing: 0) {
            ZStack(alignment: .trailing) {
                if !selecting {
                    // Keep both labels laid out so reversing the threshold never moves the glyphs.
                    ZStack {
                        HStack(spacing: 6) {
                            Image(systemName: "xmark").font(.system(size: 14, weight: .bold))
                            Text("关闭").font(.orbisLabel(.semibold)).lineLimit(1)
                        }
                        .opacity(armed ? 0 : 1)
                        HStack(spacing: 6) {
                            Image(systemName: "checkmark").font(.system(size: 14, weight: .bold))
                            Text("松手关闭").font(.orbisLabel(.semibold)).lineLimit(1)
                        }
                        .opacity(armed ? 1 : 0)
                    }
                    .foregroundStyle(.white)
                    .frame(width: 116).frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .trailing)
                    .background(armed ? OrbisPalette(scheme).secondary : OrbisPalette(scheme).error)
                    .animation(reduceMotion ? nil : InteractionMotion.state, value: armed)
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
                    HStack(spacing: 12) {
                        AgentEmblem(kind: kind)
                        VStack(alignment: .leading, spacing: 6) {
                            OrbisMotionText(card.title).font(.orbisBody(.semibold)).lineLimit(1)
                            Text(runtime.cwd)
                                .font(.orbisCaption(mono: true)).foregroundStyle(OrbisPalette(scheme).secondary).lineLimit(1)
                            HStack(spacing: 10) {
                                Text(agentTitle(kind)).font(.orbisCaption(.medium)).foregroundStyle(OrbisPalette(scheme).agent(kind))
                                // A pending interaction takes the status slot instead of adding a line to the card.
                                if pending {
                                    Label("待确认", systemImage: "exclamationmark.circle").font(.orbisCaption(.semibold))
                                        .foregroundStyle(OrbisPalette(scheme).error)
                                } else { RuntimeStatusLabel(status: runtime.presentationStatus) }
                            }
                        }.frame(maxWidth: .infinity, alignment: .leading)
                        OrbisSelectionIndicator(selected: selected, selecting: selecting)
                    }.frame(maxWidth: .infinity, alignment: .leading)
                }.buttonStyle(OrbisSelectionButtonStyle(selected: selected, selecting: selecting, padding: OrbisRadius.cardPadding + 4))
                    .offset(x: translation)
                    .highPriorityGesture(LongPressGesture().onEnded { _ in beginSelection(runtime.runtimeId) })
                    .accessibilityIdentifier("home-runtime-\(runtime.runtimeId)")
                    .accessibilityAddTraits(selected ? .isSelected : [])
                    .accessibilityAction(named: "选择会话") { beginSelection(runtime.runtimeId) }
            }
            .onGeometryChange(for: CGRect.self) { $0.frame(in: .named("home-session-content")) } action: {
                runtimeCardFrames[runtime.runtimeId] = $0
            }
        }.accessibilityElement(children: .contain)
            .disabled(!host.connection.homeCardIsCurrent(card))
    }

}

/// One capsule tells the computer's whole lifecycle: connecting, securing, syncing, then the transport path.
struct ConnectionPill: View {
    @EnvironmentObject private var store: OrbisStore
    @Environment(\.colorScheme) private var scheme
    @AppStorage("orbis.visualStyle") private var visualStyle = "classic"
    @Environment(\.orbisReduceMotion) private var reduceMotion
    var sync: HomeSyncStatus = .idle
    var body: some View {
        let p = OrbisPalette(scheme)
        let secured = store.connection == .secured
        let failed: Bool = { if case .failed = sync { return true }; return false }()
        let busy = store.connection == .connecting || store.connection == .online || (secured && sync == .syncing)
        let tone = store.connection == .error || (secured && failed) ? p.error : secured ? p.success : p.warning
        // Secured: sync progress, then the transport path; otherwise the connection phase. Color carries the state.
        let title = !secured ? connectionTitle(store.connection) : sync == .syncing ? "正在同步" : failed ? "同步失败"
            : pathTitle(store.activePath ?? "relay")
        HStack(spacing: 7) {
            ZStack {
                if busy { ProgressView().controlSize(.mini).tint(tone).scaleEffect(0.8) }
                else { Circle().fill(tone).frame(width: 7, height: 7) }
            }.frame(width: 12, height: 12)
            OrbisMotionText(title).foregroundStyle(secured && failed ? p.error : p.secondary)
            if secured { Image(systemName: "lock.shield").accessibilityLabel("端到端加密") }
        }.font(.orbisCaption(.medium)).foregroundStyle(p.secondary).padding(.horizontal, 12).frame(minHeight: 36)
            .neuSurface(inset: true, radius: 18, intensity: 0.35, concentric: false)
            .animation(reduceMotion ? nil : .orbisFade, value: title)
            // A status group, not a button: its texts stay readable one by one.
            .accessibilityElement(children: .contain)
    }
}

/// Shared by the home row and the drawer footer: pick another paired computer. Only the drawer's
/// computer menu adds or unpairs computers (ADR-0053 §4), so it passes those actions.
@MainActor
func hostSwitchMenuItems(_ store: OrbisStore, onAddHost: (() -> Void)? = nil, onUnpair: ((HostPairing) -> Void)? = nil) -> [OrbisMenuItem] {
    var items: [OrbisMenuItem] = store.pairings.map { host in
        let snapshot = store.hosts.first { $0.hostId == host.hostId }
        let state = snapshot.map { "，" + connectionTitle($0.connectionState) } ?? ""
        let pending = snapshot.map(hostHasPendingInteraction) == true ? "，有待确认" : ""
        return OrbisMenuItem(title: host.hostName + state + pending, symbol: "desktopcomputer", checked: host.hostId == store.selectedHostId) {
            if host.hostId != store.selectedHostId { store.connect(hostId: host.hostId) }
        }
    }
    if onAddHost != nil || onUnpair != nil {
        items = [OrbisMenuItem(title: "切换电脑", symbol: "desktopcomputer", children: items)]
    }
    if let onAddHost {
        items.append(.divider)
        items.append(OrbisMenuItem(title: "添加电脑", symbol: "plus", action: onAddHost))
    }
    if let onUnpair, let host = store.selectedHost {
        items.append(OrbisMenuItem(title: "取消配对 \(host.hostName)", symbol: "link", destructive: true) { onUnpair(host) })
    }
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
