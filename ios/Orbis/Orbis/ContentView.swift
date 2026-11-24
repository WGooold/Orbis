import SwiftUI

private enum RootTab: String, CaseIterable {
    case chat, providers, settings
    var title: String { switch self { case .chat: L10n.tr("聊天"); case .providers: "Agent"; case .settings: L10n.tr("设置") } }
    var symbol: String { switch self { case .chat: "bubble.left"; case .providers: "slider.horizontal.3"; case .settings: "gearshape" } }
}

private enum AppPage: Hashable { case chat, pairing, status, providers, history, downloads, filePreview(UUID), downloadedFile(String) }

/// The legacy Hub may still publish for other pages; this wrapper does no page construction.
struct ContentView: View {
    @EnvironmentObject private var store: OrbisStore
    var body: some View { NavigationRoot(store: store).equatable().environment(\.orbisStoreReference, store) }
}

private struct NavigationRoot: View, Equatable {
    let store: OrbisStore
    private var facts: NavigationScreenSnapshot { store.chatScreens.navigation }
    static func == (lhs: Self, rhs: Self) -> Bool { lhs.store === rhs.store }
    @Environment(\.colorScheme) private var scheme
    @Environment(\.orbisAppearance) private var visualStyle
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.openURL) private var openURL
    @Environment(\.orbisReduceMotion) private var reduceMotion
    @StateObject private var navigation = OrbisPageStack<AppPage>()
    @State private var homeSelecting = false
    @State private var rootTab: RootTab = .chat
    @State private var displayedRoot: RootTab = .chat
    @State private var rootOpacity = 1.0
    @State private var rootOffset: CGFloat = 0
    @State private var rootTransition = 0
    @State private var persistentDirectory = false
    @State private var foldClosed = false
    @State private var hasVerticalEdge = false
    @State private var drawerOpen = false
    @State private var directoryState = SessionDirectoryState()
    @State private var newSessionOpen = false
    @State private var draftCloseRequest = 0
    @State private var newSessionCwd: String?
    @StateObject private var overlay = OrbisOverlay()
    @StateObject private var externalImports = ExternalImportInboxModel()
    #if DEBUG
    @State private var previewListOperationCount = 0
    #endif

    init(store: OrbisStore) {
        self.store = store
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

    private var visibleBanner: FeedbackNotice? {
        navigation.pages.last == .pairing ? nil : facts.feedback.banner
    }

    private var activeToastAnchorScope: FeedbackAnchorScope? {
        switch navigation.pages.last {
        case .chat: return .chat
        case .history: return .history
        case nil: return .root
        case .downloads, .pairing, .status, .providers, .filePreview, .downloadedFile: return nil
        }
    }

    // Separate type-checking boundaries keep this modifier chain within older
    // CI compilers' limits while preserving the view tree and modifier order.
    private var rootSurface: some View {
        ZStack {
            if facts.pairings.isEmpty {
                PairingEntryView(onCancel: nil, onCode: store.pair)
                    .frame(maxWidth: 720)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .background(OrbisPalette(scheme).base.ignoresSafeArea())
            } else {
                // The root and every full page stay mounted under the page above them, so a
                // return reveals the real source (ADR-0054 / M14).
                // Store changes wait while a page moves, so no whole-page update lands between the
                // transition's frames (PERF-10). Each phase re-arms the safety limit; a finger drag
                // always ends in a release or cancel, so it may hold longer.
                VStack(spacing: 0) {
                    if let notice = visibleBanner {
                        feedbackNotice(notice, error: true)
                            .padding(.horizontal, 16).padding(.vertical, 6)
                            .frame(maxWidth: 720)
                            .frame(maxWidth: .infinity)
                            .background(OrbisPalette(scheme).base.ignoresSafeArea(edges: .top))
                            .transition(reduceMotion ? .identity : InteractionMotion.banner)
                            .task(id: notice.id) { announceFeedback(notice.text) }
                            .zIndex(1)
                    }
                    OrbisPageHost(stack: navigation, rootCovered: drawerOpen && !persistentDirectory,
                                  shiftsRoot: !usesSystemVerticalBar,
                                  rootScrimIgnoresSafeArea: !hasVerticalEdge,
                                  onFlight: { [store] phase in
                                      if phase == .dragging { LiveActivityCoordinator.shared.cancelQueuedOpen() }
                                      store.holdScreenPublications(phase != nil, limit: phase == .dragging ? .seconds(5) : .seconds(1))
                                  }) {
                        rootPages
                    } page: { page in
                        pageView(page)
                            .frame(maxWidth: 720).frame(maxWidth: .infinity, maxHeight: .infinity)
                            .foregroundStyle(OrbisPalette(scheme).text)
                            .background(OrbisPalette(scheme).base.ignoresSafeArea())
                    }
                }
                .overlayPreferenceValue(FeedbackBottomAnchorKey.self) { anchors in
                    GeometryReader { geometry in
                        if let notice = facts.feedback.toast {
                            let scope = activeToastAnchorScope
                            let topmostMinY = anchors.compactMap { entry -> CGFloat? in
                                guard entry.scope == scope else { return nil }
                                let rect = geometry[entry.bounds]
                                return rect.height > 0.5 ? rect.minY : nil
                            }.min()
                            let rawBottom = topmostMinY.map { max(12, geometry.size.height - $0 + 8) } ?? 12
                            let clampedBottom = min(rawBottom, max(12, geometry.size.height - 96))
                            feedbackNotice(notice, error: false)
                                .padding(.horizontal, 16)
                                .frame(maxWidth: 720)
                                .padding(.bottom, clampedBottom)
                                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottom)
                                .transition(reduceMotion ? .identity : InteractionMotion.notice)
                                .task(id: notice.id) { announceFeedback(notice.text) }
                        }
                    }
                }
                .animation(reduceMotion ? nil : InteractionMotion.panel, value: visibleBanner?.id)
                .animation(reduceMotion ? nil : InteractionMotion.panel, value: facts.feedback.toast?.id)
            }
        }
        .background(OrbisPalette(scheme).base.ignoresSafeArea())
        .environment(\.orbisImportInbox, externalImports)
        .environmentObject(facts.source.transfers)
        .environment(\.orbisFileActions, facts.source.transfers)
        .environmentObject(facts.source.toolInventories)
        .environmentObject(facts.source.hostState)
        .environmentObject(facts.source.notifications)
        .environmentObject(facts.source.agentState)
        .tint(OrbisPalette(scheme).accent)
        .foregroundStyle(OrbisPalette(scheme).text)
        .background(OrbisPalette(scheme).base.ignoresSafeArea())
        .environment(\.orbisSystemVerticalBar, usesSystemVerticalBar)
        .environment(\.orbisSystemRootActions, usesSystemVerticalBar && (hasVerticalEdge || (navigation.pages.isEmpty && (!drawerOpen || persistentDirectory))))
        .environment(\.orbisPersistentDirectory, persistentDirectory)
        .animation(reduceMotion ? nil : InteractionMotion.panel, value: visualStyle)
        .modifier(SessionDrawerModifier(isOpen: $drawerOpen,
                                        hasHost: !facts.pairings.isEmpty,
                                        edgeSwipeEnabled: navigation.pages.isEmpty && rootTab == .chat && !facts.pairings.isEmpty && !facts.pairing,
                                        onPersistentChange: { persistentDirectory = $0 },
                                        onClosedChange: { foldClosed = $0 }) {
            drawer
        })
        .orbisWindowBackdrop(color: resolvedBackdropColor)
        .modifier(VerticalBarObserver(hasVerticalEdge: $hasVerticalEdge))
    }

    private var resolvedBackdropColor: UIColor {
        UIColor(OrbisPalette(scheme, appearance: OrbisAppearance(rawValue: visualStyle) ?? .mist).base)
    }

    private var rootWithNotices: some View {
        rootSurface
        #if DEBUG
        .overlay(alignment: .topTrailing) {
            if ProcessInfo.processInfo.arguments.contains("--preview-viewport-controls") {
                HStack(spacing: 2) {
                    ForEach(["insert", "promote", "remove"], id: \.self) { operation in
                        Button {
                            guard let change = PreviewViewportUpdates.changeList else { return }
                            change(operation)
                            previewListOperationCount += 1
                        } label: {
                            Text(operation).frame(minWidth: 44, minHeight: 44).contentShape(Rectangle())
                        }
                            .accessibilityIdentifier("preview-list-" + operation)
                            .accessibilityValue(String(previewListOperationCount))
                    }
                }.buttonStyle(.plain).font(.system(size: 10)).padding(.top, 60).padding(.trailing, 12)
            }
            if ProcessInfo.processInfo.arguments.contains("--preview-home-refresh-probe") {
                PreviewHomeRefreshReport()
            }
        }
        #endif
    }

    private func feedbackNotice(_ notice: FeedbackNotice, error: Bool) -> some View {
        OrbisNotice(text: notice.text, error: error, trailing: AnyView(HStack(alignment: .center, spacing: 8) {
            if let action = notice.action {
                OrbisTextButton(title: feedbackActionTitle(action), tint: error ? OrbisPalette(scheme).error : nil) {
                    if !error { store.dismissFeedbackToast() }
                    switch action {
                    case .pair: push(.pairing)
                    case .reconnect: store.reconnectSelectedHost()
                    case .settings: selectRoot(.settings); navigation.replace(with: [])
                    case .update: if let url = URL(string: "https://orbising.com/#download") { openURL(url) }
                    case .restoreDraft:
                        LiveActivityCoordinator.shared.cancelQueuedOpen()
                        store.stopFollowingLaunch()
                        withAnimation(reduceMotion ? nil : .orbisCollapse) { newSessionOpen = true }
                    }
                }.orbisNested()
            }
            OrbisIconButton(symbol: "xmark", label: L10n.tr("关闭提示"), size: 28) {
                if error { store.dismissFeedbackBanner() } else { store.dismissFeedbackToast() }
            }.orbisNested()
        })).accessibilityElement(children: .contain)
            .accessibilityIdentifier(error ? "feedback-f4" : "feedback-f3")
    }
    private func feedbackActionTitle(_ action: FeedbackAction) -> String {
        switch action {
        case .pair: L10n.tr("重新配对")
        case .reconnect: L10n.tr("重新连接")
        case .settings: L10n.tr("设置")
        case .update: L10n.tr("更新")
        case .restoreDraft: L10n.tr("继续编辑")
        }
    }
    private func announceFeedback(_ text: String) {
        UIAccessibility.post(notification: .announcement, argument: text)
    }

    private var rootWithNavigationUpdates: some View {
        rootWithNotices
        .onChange(of: rootTab) { _, next in
            LiveActivityCoordinator.shared.cancelQueuedOpen()
            switchRoot(next)
        }
        .onChange(of: facts.selectedHostId) { _, _ in
            LiveActivityCoordinator.shared.navigationSelectionChanged()
            store.setFeedbackPage(downloads: navigation.pages.last == .downloads, chat: navigation.pages.last == .chat)
            store.hostState.setCatalogQuery(directoryState.networkQuery)
            store.hostState.setCatalogVisible((drawerOpen || persistentDirectory) && scenePhase == .active)
            overlay.dismissMenu()
        }
        .onChange(of: persistentDirectory) { _, visible in
            store.hostState.setCatalogVisible((drawerOpen || visible) && scenePhase == .active)
        }
        .onChange(of: facts.pairings) { _, _ in overlay.dismissMenu() }
        .onChange(of: navigation.pages) { _, pages in
            store.setFeedbackPage(downloads: pages.last == .downloads, chat: pages.last == .chat)
            store.setHistoryWindowVisible(scenePhase == .active && pages.last == .chat)
            overlay.dismissMenu()
            // ADR-0049 §6.8：离开启动页不取消启动，成功后也不把用户拉回。
            if !pages.contains(.chat) { store.stopFollowingLaunch() }
        }
        .onChange(of: drawerOpen) { _, open in
            if open { LiveActivityCoordinator.shared.cancelQueuedOpen() }
            store.hostState.setCatalogQuery(directoryState.networkQuery)
            store.hostState.setCatalogVisible((open || persistentDirectory) && scenePhase == .active)
            overlay.dismissMenu()
        }
        .onChange(of: newSessionOpen) { _, open in
            if open { LiveActivityCoordinator.shared.cancelQueuedOpen() }
        }
        .onChange(of: facts.activationRevision) { _, _ in
            setDrawer(false); newSessionOpen = false
            if facts.runtime != nil { navigation.replace(with: [.chat]) }
        }
        .onChange(of: facts.selectedRuntimeId) { old, next in
            if old != nil && next == nil && navigation.pages.contains(.chat) { navigation.replace(with: []) }
        }
        .onChange(of: facts.pairing) { old, active in
            if old && !active && facts.error == nil && facts.selectedHost != nil { navigation.replace(with: []) }
        }
    }

    private var rootWithSceneUpdates: some View {
        rootWithNavigationUpdates
        .onOpenURL { url in
            if url.isFileURL { externalImports.openDocument(url) }
            else { LiveActivityCoordinator.shared.receive(url) }
        }
        .onReceive(LiveActivityCoordinator.shared.navigation) { target in
            guard let target else { return }
            LiveActivityCoordinator.shared.navigation.send(nil)
            guard store.pairings.contains(where: { $0.hostId == target.hostId }) else { return }
            rootTab = .chat; displayedRoot = .chat
            navigation.replace(with: target.runtimeId == nil ? [] : [.chat])
        }
        .onReceive(ReplyCompletionNotifications.remoteOpens.publisher) { target in
            guard let target else { return }
            ReplyCompletionNotifications.remoteOpens.consume()
            let pairing = store.pairings.first { $0.hostId == target.hostId }
            let connection = store.connection(for: target.hostId)
            guard let destination = target.destination(currentPairingKey: pairing.map { PushNotificationIdentity.pairingKey($0) },
                sessions: connection?.runtimes.map { ($0.runtimeId, $0.sessionId) } ?? [],
                confirmed: connection?.connection == .secured && connection?.homeRuntimesUpdating == false) else { return }
            LiveActivityCoordinator.shared.cancelQueuedOpen()
            store.connect(hostId: target.hostId)
            rootTab = .chat; displayedRoot = .chat
            switch destination {
            case .home: navigation.replace(with: [])
            case .runtime(let runtimeId):
                store.selectRuntime(hostId: target.hostId, runtimeId: runtimeId)
                navigation.replace(with: [.chat])
            }
        }
        .task(id: scenePhase) {
            store.setFeedbackForeground(scenePhase == .active)
            store.setFeedbackPage(downloads: navigation.pages.last == .downloads, chat: navigation.pages.last == .chat)
            store.hostState.setCatalogQuery(directoryState.networkQuery)
            store.hostState.setCatalogVisible((drawerOpen || persistentDirectory) && scenePhase == .active)
            store.setHistoryWindowVisible(scenePhase == .active && navigation.pages.last == .chat)
            guard scenePhase == .active else { return }
            externalImports.refresh()
            while !Task.isCancelled {
                store.reconcileCatalog()
                store.reconcileHistoryWindow()
                do { try await Task.sleep(nanoseconds: 60_000_000_000) } catch { return }
            }
        }
        .onChange(of: scenePhase) { old, new in
            // OI-08: the Share Extension can only offer Sessions Orbis saw as it left the foreground.
            if old == .active && new != .active { externalImports.saveTargets(store.hosts.flatMap { $0.connection.externalImportChoices() }) }
            if new == .background { LiveActivityCoordinator.shared.cancelQueuedOpen() }
            if new != .active { store.toolContent.close() }
            if old == .background && new == .active { store.resumeForeground() }
        }
    }

    var body: some View {
        #if DEBUG
        let _ = ChatUpdateProbe.shared.rendered(.navigation)
        #endif
        rootWithSceneUpdates
        .overlay {
            if facts.pairing {
                ZStack {
                    OrbisPalette(scheme).scrim.opacity(0.25).ignoresSafeArea()
                    VStack(spacing: 14) {
                        ProgressView()
                        Text(L10n.tr("正在安全配对…")).font(.orbisBody(.medium))
                    }.orbisModalSurface(radius: OrbisRadius.dialog, padding: 30)
                }.accessibilityAddTraits(.updatesFrequently)
            }
        }
        .orbisBottomSheet(isPresented: $externalImports.isOpen) {
            ExternalImportInboxView(model: externalImports, store: store, onOpenSession: openImportedSession).orbisSheet([.large])
        }
        .orbisOverlayHost(overlay)
        .modifier(OrbisInputModality())
        #if DEBUG
        .overlay(alignment: .topLeading) { if ChatEntryProbe.enabled { ChatEntryReport() } }
        .overlay(alignment: .bottomLeading) { if PageReturnProbe.enabled { PageReturnReport() } }
        .overlay(alignment: .bottom) { if PageMotionProbe.enabled { PageMotionReport() } }
        .overlay(alignment: .bottomTrailing) { if AccessibilityReachProbe.enabled { AccessibilityReachReport() } }
        #endif
    }

    /// Posture changes update bar visibility within the same tab container.
    private var usesSystemVerticalBar: Bool {
        #if DEBUG
        if ProcessInfo.processInfo.arguments.contains("--preview-fold-closed") { return true }
        #endif
        return foldClosed || hasVerticalEdge
    }

    private var rootPages: some View {
        VStack(spacing: 0) {
            // FOLD-06: system containers own the shared vertical sidebar on Duo;
            // keep TabView unboxed so UIKit and SwiftUI backgrounds bleed through safe areas.
            TabView(selection: Binding(get: { displayedRoot }, set: { tab in
                if !navigation.pages.isEmpty { navigation.replace(with: []) }
                guard tab != rootTab else { return }
                OrbisHaptics.selectionChanged(); selectRoot(tab)
            })) {
                rootContent(.chat) { home }
                rootContent(.providers) { AgentProvidersView(root: true, onBack: { selectRoot(.chat) }) }
                rootContent(.settings) { ConnectionStatusView(root: true, onBack: { selectRoot(.chat) }, onOpenAgent: { selectRoot(.providers) }) }
            }
            .orbisConfigureVerticalTabBar()
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            if !homeSelecting && !usesSystemVerticalBar { HStack(spacing: 12) {
                ForEach(RootTab.allCases, id: \.self) { tab in
                    OrbisMotionButton {
                        guard tab != rootTab else { return }
                        OrbisHaptics.selectionChanged(); selectRoot(tab)
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
            }.padding(.horizontal, 20).padding(.top, 8).padding(.bottom, 12)
                .frame(maxWidth: 720).frame(maxWidth: .infinity)
                .accessibilityIdentifier("root-bottom-navigation")
                .anchorPreference(key: FeedbackBottomAnchorKey.self, value: .bounds) { [.init(scope: .root, bounds: $0)] } }
        }.frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(OrbisPalette(scheme).base.ignoresSafeArea())
    }

    @ViewBuilder private func pageView(_ page: AppPage) -> some View {
        switch page {
        case .chat:
            let entry = navigation.entries.last(where: { $0.page == .chat })?.id
            if facts.runtime != nil,
               let chat = ChatView(model: store.chatScreens, onBack: back, onHistory: { push(.history) },
                   onDownloads: { push(.downloads) }, onReturnToNewSession: { openRecoveredSessionDraft(from: entry) }) {
                chat
                    .environment(\.openChatFilePreview, { id in push(.filePreview(id)) })
                    .id(facts.target.pageIdentity)
            } else { OrbisEmptyState(symbol: "desktopcomputer", title: L10n.tr("会话已离线")) }
        case .pairing: PairingEntryView(onCancel: back, onCode: store.pair)
        case .status: ConnectionStatusView(onBack: back, onOpenAgent: { push(.providers) })
        case .providers: AgentProvidersView(onBack: back)
        case .history: HistoryBranchView(onBack: back)
        case .downloads: DownloadsView(onBack: back, onOpen: { push(.downloadedFile($0)) })
        case .downloadedFile(let id): DownloadedFilePage(task: facts.source.transfers.completedLocalDownload(id), back: back)
        case .filePreview(let id):
            ChatFilePreviewPage(preview: facts.source.transfers.browserPreview, id: id) {
                if navigation.pages.last == .filePreview(id) { back() }
            }
        }
    }

    private func rootContent<Content: View>(_ tab: RootTab, @ViewBuilder content: () -> Content) -> some View {
        let active = displayedRoot == tab
        // On real Duo (`hasVerticalEdge == true`), keep the shared vertical sidebar and
        // navigation bar visibility constant across pushes so the system bar and status
        // bar never switch axis or reflow safe areas mid-transition.
        let tabBarVisible = usesSystemVerticalBar && (hasVerticalEdge || (!homeSelecting && navigation.pages.isEmpty && !drawerOpen))
        let navBarVisible = usesSystemVerticalBar
        // The page host already withdraws a covered root; a tab only narrows that further.
        return NavigationStack {
            content()
                .frame(maxWidth: 720)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(OrbisPalette(scheme).base.ignoresSafeArea())
                .orbisWindowBackdrop(color: resolvedBackdropColor)
                .orbisSystemNavigationBarChrome(visible: navBarVisible)
        }
        .modifier(RootTabVisibility(active: active))
        .opacity(active ? 1 : 0)
        .opacity(rootOpacity).offset(y: rootOffset)
        .allowsHitTesting(active && rootOpacity == 1)
        .orbisAccessibilitySubtree(hidden: !active)
        .tabItem { Label(tab.title, systemImage: tab.symbol) }
        .tag(tab)
        .orbisSystemTabBarVisible(tabBarVisible)
    }

    private func switchRoot(_ next: RootTab) {
        overlay.dismissMenu(); setDrawer(false)
        rootTransition += 1
        let token = rootTransition
        if reduceMotion || usesSystemVerticalBar { displayedRoot = next; rootOpacity = 1; rootOffset = 0; return }
        withAnimation(.timingCurve(0.4, 0, 1, 1, duration: 0.09)) { rootOpacity = 0 }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.09) {
            guard token == rootTransition else { return }
            displayedRoot = next; rootOffset = 8
            withAnimation(.timingCurve(0, 0, 0.2, 1, duration: 0.21)) { rootOpacity = 1; rootOffset = 0 }
        }
    }

    private func selectRoot(_ tab: RootTab) {
        LiveActivityCoordinator.shared.cancelQueuedOpen()
        rootTab = tab
    }

    private var home: some View {
        HomeView(store: store, updates: store.homeUpdates, pageCovered: !navigation.pages.isEmpty,
                 draftOpen: newSessionOpen, draftCwd: newSessionCwd, draftCloseRequest: draftCloseRequest, onDraft: {
            LiveActivityCoordinator.shared.cancelQueuedOpen()
            if !navigation.pages.isEmpty {
                navigation.replace(with: [])
                selectRoot(.chat)
                store.stopFollowingLaunch()
                withAnimation(reduceMotion ? nil : .orbisCollapse) { newSessionOpen = true }
            } else if newSessionOpen {
                draftCloseRequest += 1
            } else {
                store.stopFollowingLaunch()
                withAnimation(reduceMotion ? nil : .orbisCollapse) { newSessionOpen = true }
            }
        }, onDraftCancelled: { retained in
            withAnimation(reduceMotion ? nil : .orbisCollapse) { newSessionOpen = false }
            if retained { store.presentFeedback(.toast, L10n.tr("草稿已保留"), action: .restoreDraft) }
        }, onDraftSubmitted: { launch, origin in
            LiveActivityCoordinator.shared.cancelQueuedOpen()
            // The card stays in the live home until the growing page has covered it, so the
            // list outside the rectangle does not move while the page expands (S35 / M27).
            if store.selectedRuntime != nil {
                #if DEBUG
                ChatSchedulingTrace.pageOpenRequested(target: "new-session")
                #endif
                navigation.replace(with: [.chat], entrance: .expand(origin)) { newSessionOpen = false }
            } else {
                newSessionOpen = false
            }
        }, onSelection: { homeSelecting = $0 },
                 onDirectory: { if navigation.pages.isEmpty { setDrawer(true) } else { setDrawer(!drawerOpen) } },
                 onSettings: { selectRoot(.settings) },
                 onDownloads: { if navigation.pages.last != .downloads { push(.downloads) } },
                 onOpenRuntime: { hostId, runtime in
                     store.selectHost(hostId)
                     openRuntime(runtime)
                 }).equatable()
    }

    private var drawer: some View {
        SessionDrawerView(store: store, updates: store.directoryUpdates, renderedState: directoryState, state: $directoryState, onClose: { setDrawer(false) },
                          onOpenSession: { session in
                              if session.archived != true, let runtime = store.runtimes.first(where: { $0.directorySessionId == session.sessionId }) { openRuntime(runtime) }
                              else if store.connection == .secured, session.sessionId.hasPrefix("codex-history:"),
                                      !store.activeConnection.cachedSessionIds.contains(session.sessionId), session.archived != true {
                                  let modes = store.activeConnection.codexResumeModes(session)
                                  if modes.count == 1 { store.activate(session, codexLaunchMode: modes[0]); setDrawer(false) }
                                  else if !modes.isEmpty {
                                      overlay.showDialog(L10n.tr("启动方式"), actions: modes.map { mode in
                                          OrbisDialogAction(title: mode.title) { store.activate(session, codexLaunchMode: mode); setDrawer(false) }
                                      } + [OrbisDialogAction(title: L10n.tr("返回"), role: .cancel)])
                                  } else if openCachedSession(session) { setDrawer(false); navigation.replace(with: [.chat]) }
                              }
                              else if openCachedSession(session) { setDrawer(false); navigation.replace(with: [.chat]) }
                              else {
                                  overlay.showDialog(L10n.tr("本机尚无缓存"), actions: [OrbisDialogAction(title: L10n.tr("返回"), role: .cancel)] + (store.connection == .secured ? [OrbisDialogAction(title: L10n.tr("在电脑继续会话")) { store.activate(session) }] : []))
                              }
                          },
                          onOpenHistory: { session in
                              if openCachedSession(session) { setDrawer(false); navigation.replace(with: [.chat]) }
                          },
                          onNewSession: { cwd in
                              navigation.replace(with: [])
                              newSessionCwd = cwd; setDrawer(false); selectRoot(.chat)
                              store.stopFollowingLaunch()
                              withAnimation(reduceMotion ? nil : .orbisCollapse) { newSessionOpen = true }
                          }, onAddHost: { setDrawer(false); push(.pairing) },
                          onProviders: { selectRoot(.providers); navigation.replace(with: []); setDrawer(false) },
                          onUnpair: { confirmUnpair($0) }).equatable()
    }

    private func openRecoveredSessionDraft(from entry: UUID?) {
        guard let entry, navigation.entries.last?.id == entry, navigation.motion.phase == .idle else { return }
        LiveActivityCoordinator.shared.cancelQueuedOpen()
        navigation.replace(with: [])
        selectRoot(.chat)
        newSessionCwd = nil
        store.stopFollowingLaunch()
        withAnimation(reduceMotion ? nil : .orbisCollapse) { newSessionOpen = true }
    }
    /// A page's own back control runs the same slide as a released swipe and reveals the same source.
    private func back() { LiveActivityCoordinator.shared.cancelQueuedOpen(); navigation.requestBack() }
    private func push(_ page: AppPage) { LiveActivityCoordinator.shared.cancelQueuedOpen(); navigation.push(page) }
    private func setDrawer(_ open: Bool) {
        if open { LiveActivityCoordinator.shared.cancelQueuedOpen() }
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
        LiveActivityCoordinator.shared.cancelQueuedOpen()
        #if DEBUG
        ChatSchedulingTrace.pageOpenRequested(target: runtime.runtimeId)
        #endif
        store.selectRuntime(runtime.runtimeId); setDrawer(false); navigation.replace(with: [.chat])
    }
    /// OI-08: after a confirmed import the user can continue in that exact Session; nothing else is selected for them.
    private func openImportedSession(_ target: ExternalImportTarget) {
        guard let runtime = store.connection(for: target.hostId)?.runtimes.first(where: { $0.sessionId == target.sessionId }) else { return }
        LiveActivityCoordinator.shared.cancelQueuedOpen()
        rootTab = .chat; displayedRoot = .chat
        store.selectRuntime(hostId: target.hostId, runtimeId: runtime.runtimeId)
        setDrawer(false); navigation.replace(with: [.chat])
    }
    private func openCachedSession(_ session: SessionSummary) -> Bool {
        LiveActivityCoordinator.shared.cancelQueuedOpen()
        #if DEBUG
        ChatSchedulingTrace.pageOpenRequested(target: session.sessionId)
        #endif
        return store.openCachedSession(session)
    }
}

/// A root tab animates only while it is the displayed tab of a root the page host shows.
private struct RootTabVisibility: ViewModifier {
    @Environment(\.orbisVisible) private var shown
    let active: Bool
    func body(content: Content) -> some View { content.environment(\.orbisVisible, shown && active) }
}

/// 会话目录抽屉。关闭时在主页左侧（左 40% 宽度内）起手向右横拖即把抽屉拉出；打开时在抽屉
/// 或遮罩上向左拖动即推回。拖动过程中抽屉与遮罩跟随手指，松手按位置与速度吸附到打开或关闭。
/// 拉出手势挂在页面内容上与之同时识别，并按第一段位移锁定方向，竖向滚动主页时不会带出抽屉。
private struct FoldReadingKey: EnvironmentKey { static let defaultValue = false }
private struct OpenSessionDirectoryKey: EnvironmentKey { static let defaultValue: () -> Void = {} }
extension EnvironmentValues {
    var orbisFoldReading: Bool {
        get { self[FoldReadingKey.self] }
        set { self[FoldReadingKey.self] = newValue }
    }
    var orbisOpenSessionDirectory: () -> Void {
        get { self[OpenSessionDirectoryKey.self] }
        set { self[OpenSessionDirectoryKey.self] = newValue }
    }
}

private struct FoldHingeObserver: ViewModifier {
    @Binding var partiallyOpen: Bool
    @Binding var hasHinge: Bool
    var onClosedChange: (Bool) -> Void = { _ in }
    func body(content: Content) -> some View {
        #if compiler(>=6.4)
        if #available(iOS 27.1, *) {
            content.onHingeChange { _, context in
                hasHinge = hasHinge || context.hinge != nil
                partiallyOpen = context.hinge?.status == .partiallyOpen
                onClosedChange(context.hinge?.status == .closed)
            }
        } else { content }
        #else
        content
        #endif
    }
}

private struct VerticalBarObserver: ViewModifier {
    @Binding var hasVerticalEdge: Bool
    func body(content: Content) -> some View {
        #if compiler(>=6.4)
        if #available(iOS 27.1, *) {
            content.modifier(VerticalBarEdgeReader(hasVerticalEdge: $hasVerticalEdge))
        } else { content }
        #else
        content
        #endif
    }
}

#if compiler(>=6.4)
@available(iOS 27.1, *)
private struct VerticalBarEdgeReader: ViewModifier {
    @Environment(\.toolbarVerticalEdge) private var edge
    @Binding var hasVerticalEdge: Bool
    func body(content: Content) -> some View {
        content.onChange(of: edge != nil, initial: true) { _, active in
            if hasVerticalEdge != active { hasVerticalEdge = active }
        }
    }
}
#endif

private struct SessionDrawerModifier<Drawer: View>: ViewModifier {
    @Environment(\.verticalSizeClass) private var verticalSizeClass
    @Environment(\.colorScheme) private var scheme
    @Environment(\.orbisAppearance) private var visualStyle
    @Environment(\.orbisReduceMotion) private var reduceMotion
    @Binding var isOpen: Bool
    let hasHost: Bool
    let edgeSwipeEnabled: Bool
    var onPersistentChange: (Bool) -> Void = { _ in }
    var onClosedChange: (Bool) -> Void = { _ in }
    @ViewBuilder let drawer: Drawer
    /// 拖动中抽屉相对完全打开位置的水平偏移，范围 [-width, 0]；nil 表示没有在拖动。
    @State private var offset: CGFloat?
    /// 按第一段位移锁定方向：true 横向带动抽屉，false 交给滚动等其他手势。
    @State private var horizontalDrag: Bool?
    /// 横拖抽屉期间停用手指下的按钮：从会话卡片或目录行上起手拖动时，松手不能再触发它们。
    @State private var suppressTaps = false
    @State private var partiallyOpen = false
    @State private var hasHinge = false

    private var isPartiallyOpen: Bool {
        #if DEBUG
        if ProcessInfo.processInfo.arguments.contains("--preview-fold-reading") ||
            ProcessInfo.processInfo.arguments.contains("--preview-partially-open") { return true }
        #endif
        return partiallyOpen
    }

    func body(content: Content) -> some View {
        GeometryReader { geometry in
            let layout = SessionShellGeometry(size: geometry.size, divisionFrame: drawerDivision(geometry),
                hasHost: hasHost, compactHeight: verticalSizeClass == .compact,
                partiallyOpen: isPartiallyOpen, hasHinge: hasHinge)
            let width = min(320, geometry.size.width * 0.85)
            ordinaryContent(content, layout: layout, containerWidth: geometry.size.width, drawerWidth: width)
                .overlay { drawerOverlay(persistent: layout.showsDirectory, width: width, containerWidth: geometry.size.width) }
                .onChange(of: layout.showsDirectory, initial: true) { old, next in
                    if !old && next {
                        isOpen = false
                        offset = nil
                        horizontalDrag = nil
                        suppressTaps = false
                    }
                    onPersistentChange(next)
                }
        }
        // FOLD-04: the shell owns the base behind centered panes, hinge gaps and
        // outer safe areas; pane-local backgrounds leave these regions transparent.
        .background(OrbisPalette(scheme).base.ignoresSafeArea())
        .modifier(FoldHingeObserver(partiallyOpen: $partiallyOpen, hasHinge: $hasHinge, onClosedChange: onClosedChange))
    }

    private func drawerOverlay(persistent: Bool, width: CGFloat, containerWidth: CGFloat) -> some View {
        let visible = !persistent && (isOpen || offset != nil)
        let progress = visible ? max(0, min(1, 1 + (offset ?? 0) / width)) : 0
        return ZStack(alignment: .leading) {
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
                            .orbisModalSurface(radius: OrbisRadius.card)
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
                    .gesture(openGesture(containerWidth: containerWidth, width: width))
                    .accessibilityHidden(true)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
        .accessibilityElement(children: .contain)
        .accessibilityAddTraits(visible ? [.isModal] : [])
        .accessibilityHidden(!visible)
        .simultaneousGesture(isOpen && !persistent ? closeGesture(width: width) : nil)
    }

    // FOLD-08: the directory slot and the original page keep their structural
    // identities. Both get explicit widths before the expanded frame is drawn.
    private func ordinaryContent(_ content: Content, layout: SessionShellGeometry,
                                 containerWidth: CGFloat, drawerWidth: CGFloat) -> some View {
        HStack(spacing: 0) {
            ZStack {
                if layout.showsDirectory {
                    directoryPanel(width: min(320, layout.directory.width))
                        .frame(width: layout.directory.width)
                }
            }
            .frame(width: layout.showsDirectory ? layout.content.minX : 0, alignment: .leading)
            .frame(maxHeight: .infinity)
            .background {
                if layout.showsDirectory {
                    OrbisPalette(scheme).base.ignoresSafeArea(edges: [.top, .bottom, .leading])
                }
            }
            content.disabled(suppressTaps)
                .environment(\.orbisFoldReading, layout.reading)
                .environment(\.orbisOpenSessionDirectory, {
                    withAnimation(reduceMotion ? nil : .orbisDrag) { isOpen = true }
                })
                .simultaneousGesture(edgeSwipeEnabled && !isOpen && !layout.showsDirectory
                    ? openGesture(containerWidth: containerWidth, width: drawerWidth) : nil)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    private func drawerDivision(_ geometry: GeometryProxy) -> CGRect? {
        #if DEBUG
        if ProcessInfo.processInfo.arguments.contains("--preview-fold-reading") {
            return CGRect(x: 0, y: 420, width: geometry.size.width, height: 1)
        }
        #endif
        #if compiler(>=6.4)
        if #available(iOS 27.1, *) {
            return geometry.reservedRegions(kind: .division, options: .includeInactive).first?.frame
        }
        #endif
        return nil
    }

    private func directoryPanel(width: CGFloat) -> some View {
        drawer.frame(width: width).frame(maxHeight: .infinity)
            .orbisNested().background(OrbisPalette(scheme).base.ignoresSafeArea(edges: [.top, .bottom, .leading]))
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("persistent-session-directory")
    }

    private func openGesture(containerWidth: CGFloat, width: CGFloat) -> some Gesture {
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
                settle(open: value.predictedEndTranslation.width > width / 2, width: width)
            }
    }

    private func closeGesture(width: CGFloat) -> some Gesture {
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
                settle(open: value.predictedEndTranslation.width > -width / 2, width: width)
            }
    }

    /// 等同一次松手里按钮的动作判定过去，再恢复按钮。
    private func releaseTaps() {
        DispatchQueue.main.async { suppressTaps = false }
    }

    private func settle(open: Bool, width: CGFloat) {
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


struct HomeView: View, Equatable {
    let store: OrbisStore
    @ObservedObject var updates: ScreenPublication
    var pageCovered = false
    static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.store === rhs.store && lhs.draftOpen == rhs.draftOpen && lhs.draftCwd == rhs.draftCwd &&
            lhs.draftCloseRequest == rhs.draftCloseRequest && lhs.pageCovered == rhs.pageCovered
    }

    @EnvironmentObject private var overlay: OrbisOverlay
    @Environment(\.orbisReduceMotion) private var reduceMotion
    @Environment(\.colorScheme) private var scheme
    @Environment(\.orbisAppearance) private var visualStyle
    @Environment(\.orbisSystemVerticalBar) private var systemVerticalBar
    @Environment(\.orbisSystemRootActions) private var systemRootActions
    @Environment(\.orbisPersistentDirectory) private var persistentDirectory
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
    private struct CloseSwipeTarget {
        let hostId: String
        let card: HomeRuntimeCard
    }
    @State private var closeSwipeTarget: CloseSwipeTarget?
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

    private var homeHeader: some View {
        let palette = OrbisPalette(scheme, appearance: OrbisAppearance(rawValue: visualStyle) ?? .mist)
        return OrbisHeader {
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
                        .foregroundStyle(palette.secondary)
                        .shadow(color: palette.light, radius: 0, x: 1, y: 1)
                    Text("Nothing But the Remote").font(.orbisCaption()).tracking(0.4)
                        .foregroundStyle(palette.secondary)
                        .lineLimit(1)
                }
            }
        } trailing: {
            OrbisSelectionToolbar(selecting: selecting) { progress in
                HStack(spacing: 8) {
                    ExternalImportInboxButton()
                    OrbisIconButton(symbol: "arrow.down.to.line", label: L10n.tr("下载"), action: onDownloads)
                        .offset(x: 24 * progress).accessibilityIdentifier("home-downloads")
                    OrbisIconButton(symbol: draftOpen ? "xmark" : "plus", label: draftOpen ? L10n.tr("收起新会话") : L10n.tr("新建会话"), morphFrom: "plus", action: onDraft)
                        .offset(x: -24 * progress).accessibilityIdentifier("home-new-session")
                }
            } selected: {
                Button(L10n.tr("关闭")) { closeSelectedRuntimes() }
                    .font(.orbisLabel(.semibold)).foregroundStyle(palette.error)
                    .buttonStyle(NeuButtonStyle(padding: 12))
                    .accessibilityLabel(L10n.tr("关闭选中会话")).disabled(store.connection != .secured)
            }
        }
    }

    var body: some View {
        let palette = OrbisPalette(scheme, appearance: OrbisAppearance(rawValue: visualStyle) ?? .mist)
        VStack(spacing: 0) {
            if !systemVerticalBar {
                homeHeader
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
                    OrbisIconButton(symbol: "arrow.clockwise", label: retryLabel, tint: palette.error,
                                    compact: true, action: store.refresh)
                        .accessibilityHint(error)
                }
            }.frame(height: 48).padding(.horizontal, 20).padding(.bottom, 2)
            homeSessionList
        }.frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(palette.base.ignoresSafeArea())
            .modifier(HomeSystemToolbarModifier(
                enabled: systemVerticalBar,
                showActions: systemRootActions,
                selecting: selecting,
                selectedCount: selectedRuntimeIds.count,
                persistentDirectory: persistentDirectory,
                draftOpen: draftOpen,
                canCloseSelected: store.connection == .secured,
                palette: palette,
                onExitSelection: { selectedRuntimeIds = [] },
                onDirectory: onDirectory,
                onDownloads: onDownloads,
                onDraft: onDraft,
                onCloseSelected: closeSelectedRuntimes
            ))
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
            .onChange(of: selectableRuntimeIds) { _, ids in
                selectedRuntimeIds.formIntersection(ids)
                if let active = closeSwipeTarget, !ids.contains(active.card.id) { resetCloseSwipes() }
            }
            .onChange(of: closableRuntimeIds) { _, ids in
                armedCloseRuntimeIds.formIntersection(ids)
            }
            .onChange(of: pageCovered) { _, covered in
                if covered { selectedRuntimeIds = []; exitingCards = [:]; resetCloseSwipes(); onSelection(false) }
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
    private var selectableRuntimeIds: Set<String> {
        guard let host = currentHost else { return [] }
        return host.connection.homeSelectableRuntimeIds
    }
    private var closableRuntimeIds: Set<String> {
        guard let host = currentHost else { return [] }
        return host.connection.homeClosableRuntimeIds
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
        closeSwipeTarget = nil
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
                    closeSwipeTarget = CloseSwipeTarget(hostId: host.hostId, card: card)
                }
                guard let target = closeSwipeTarget, target.hostId == host.hostId,
                      host.connection.homeCardIsCurrent(target.card) else { return }
                let id = target.card.id
                let width = runtimeCardFrames[id]?.width ?? 0
                let threshold = width * 0.4
                let horizontal = value.translation.width
                swipingRuntimeIds.insert(id)
                let wasArmed = armedCloseRuntimeIds.contains(id)
                let disarmThreshold = threshold * 0.96
                let armed = host.connection.canCloseRuntime(id) && threshold > 0 &&
                    (wasArmed ? horizontal <= -disarmThreshold : horizontal <= -threshold)
                if armed && !armedCloseRuntimeIds.contains(id) { OrbisHaptics.commit() }
                swipeTranslations[id] = min(0, max(-width, horizontal < -threshold ? -threshold + (horizontal + threshold) * 0.4 : horizontal))
                if armed { armedCloseRuntimeIds.insert(id) }
                else { armedCloseRuntimeIds.remove(id) }
            }
            .onEnded { value in
                let target = closeSwipeTarget
                closeSwipeTarget = nil
                closeSwipeDirectionDecided = false
                guard !selecting, let target else { return }
                let id = target.card.id
                // Let this release's button action finish before accepting taps again.
                DispatchQueue.main.async { swipingRuntimeIds.remove(id) }
                let threshold = (runtimeCardFrames[id]?.width ?? 0) * 0.4
                var closing = false
                if let host = currentHost, host.hostId == target.hostId,
                   host.connection.homeCardIsCurrent(target.card), threshold > 0 {
                    let canClose = host.connection.canCloseRuntime(id)
                    let committed = armedCloseRuntimeIds.contains(id) && value.translation.width <= -(threshold * 0.96)
                    // A deliberate blocked swipe reaches the same threshold, explains why,
                    // and rebounds without arming, hiding the card, or sending quit.
                    if committed || (!canClose && value.translation.width <= -threshold) {
                        closing = !beginClose([id], host: host).isEmpty
                    }
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
        guard selectableRuntimeIds.contains(id) else { return }
        OrbisHaptics.selectionChanged()
        if selectedRuntimeIds.contains(id) { selectedRuntimeIds.remove(id) }
        else { selectedRuntimeIds.insert(id) }
    }

    private func beginSelection(_ id: String) {
        guard selectableRuntimeIds.contains(id) else { return }
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
        let targets = ids.intersection(selectableRuntimeIds)
        let plan = host.connection.closePlan(targets)
        if plan.requiresConfirmation {
            overlay.confirmRuntimeClose(plan) {
                guard let current = currentHost, current.hostId == host.hostId, current.connection === host.connection else { return }
                // A changed selection must never broaden the dialog's original targets.
                let presented = Set(plan.entries.map(\.target.runtimeId))
                selectedRuntimeIds.subtract(submitClose(presented, host: current, plan: plan, confirmed: true))
            }
            return []
        }
        return submitClose(targets, host: host, plan: plan, confirmed: false)
    }

    private func submitClose(_ ids: Set<String>, host: HostSnapshot, plan: RuntimeClosePlan, confirmed: Bool) -> Set<String> {
        let cards = host.homeCards
        let submitted = store.closeRuntimes(hostId: host.hostId, runtimeIds: ids, plan: plan, confirmed: confirmed)
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
        let canClose = host.connection.canCloseRuntime(runtime.runtimeId)
        let armed = (canClose && armedCloseRuntimeIds.contains(runtime.runtimeId)) || exitingCards[runtime.runtimeId] != nil
        let viewOnly = runtime.viewOnlyClose
        let closeLabel = canClose ? (viewOnly ? L10n.tr("退出视图") : L10n.tr("关闭")) : L10n.tr("暂不可关闭")
        let review = armed && exitingCards[runtime.runtimeId] == nil && host.connection.closeImpact(runtime.runtimeId)?.needsConfirmation == true
        let releaseLabel = review ? L10n.tr("松手确认") : viewOnly ? L10n.tr("松手退出") : L10n.tr("松手关闭")
        return VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 0) {
                ZStack(alignment: .trailing) {
                    if !selecting {
                        HStack(spacing: 12) {
                            OrbisMotionText(armed ? releaseLabel : closeLabel)
                                .font(.orbisLabel(.semibold)).lineLimit(1).minimumScaleFactor(0.8)
                                .frame(width: 100, alignment: .trailing)
                            ZStack {
                                Image(systemName: canClose || armed ? "xmark" : "lock").font(.system(size: 16, weight: .semibold))
                                    .frame(width: 28, height: 28)
                                    .neuSurface(inset: !armed, radius: 14, intensity: 0.4, concentric: false)
                                Circle().stroke(OrbisPalette(scheme).secondary.opacity(0.2), lineWidth: 2)
                                    .frame(width: 34, height: 34)
                                    .opacity(canClose || armed ? 1 : 0)
                                Circle().trim(from: 0, to: min(1, reveal / max(1, cardWidth * 0.4)))
                                    .stroke(style: StrokeStyle(lineWidth: 2, lineCap: .round))
                                    .frame(width: 34, height: 34).rotationEffect(.degrees(-90))
                                    .opacity(canClose || armed ? 1 : 0)
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
                        HomeCardContent(card: card, selected: selected, selecting: selecting).equatable()
                    }.buttonStyle(OrbisSelectionButtonStyle(selected: selected, selecting: selecting, padding: OrbisRadius.cardPadding + 4))
                        .offset(x: translation)
                        .highPriorityGesture(LongPressGesture().onEnded { _ in beginSelection(runtime.runtimeId) })
                        .accessibilityIdentifier("home-runtime-\(runtime.runtimeId)")
                        .accessibilityAddTraits(selected ? .isSelected : [])
                        .accessibilityActions {
                            Button(L10n.tr("选择会话")) { beginSelection(runtime.runtimeId) }
                        }
                }
                .onGeometryChange(for: CGRect.self) { $0.frame(in: .named("home-session-content")) } action: {
                    runtimeCardFrames[runtime.runtimeId] = $0
                }
            }
            if let error = card.error {
                HStack(alignment: .center, spacing: 8) {
                    Label(error, systemImage: "exclamationmark.circle")
                        .font(.orbisCaption()).foregroundStyle(OrbisPalette(scheme).error)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    OrbisIconButton(symbol: "xmark", label: L10n.tr("关闭错误提示"), size: 28) {
                        host.connection.clearObjectError(runtime.runtimeId)
                    }.orbisNested()
                }
                .padding(.horizontal, 12).padding(.vertical, 4)
                .accessibilityElement(children: .contain)
                .accessibilityIdentifier("home-card-error-\(runtime.runtimeId)")
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
    @Environment(\.orbisAppearance) private var visualStyle
    static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.card == rhs.card && lhs.selected == rhs.selected && lhs.selecting == rhs.selecting
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
    @Environment(\.orbisAppearance) private var visualStyle
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

enum FeedbackAnchorScope: Equatable { case root, chat, history }

struct FeedbackBottomAnchor {
    let scope: FeedbackAnchorScope
    let bounds: Anchor<CGRect>
}

/// Active bottom chrome (root tab bar, chat composer + bottom overlays, history preview) reports its
/// bounds so F3 toasts sit cleanly above the topmost visible bottom element.
struct FeedbackBottomAnchorKey: PreferenceKey {
    static var defaultValue: [FeedbackBottomAnchor] { [] }
    static func reduce(value: inout [FeedbackBottomAnchor], nextValue: () -> [FeedbackBottomAnchor]) {
        value.append(contentsOf: nextValue())
    }
}

private struct HomeSystemToolbarModifier: ViewModifier {
    let enabled: Bool
    let showActions: Bool
    let selecting: Bool
    let selectedCount: Int
    let persistentDirectory: Bool
    let draftOpen: Bool
    let canCloseSelected: Bool
    let palette: OrbisPalette
    let onExitSelection: () -> Void
    let onDirectory: () -> Void
    let onDownloads: () -> Void
    let onDraft: () -> Void
    let onCloseSelected: () -> Void

    func body(content: Content) -> some View {
        if enabled {
            #if compiler(>=6.4)
            if #available(iOS 27.1, *) {
                content
                    .navigationBarTitleDisplayMode(.inline)
                    .toolbar {
                        ToolbarItem(placement: .principal) { principalTitle }
                        if showActions {
                            if selecting {
                                ToolbarItem(placement: .topBarLeading) { exitSelectionButton }
                                    .axisBehavior(.verticalPreferred)
                                ToolbarItem(placement: .topBarTrailing) { closeSelectedButton }
                                    .axisBehavior(.verticalPreferred)
                                    .visibilityPriority(.high)
                            } else {
                                if !persistentDirectory {
                                    ToolbarItem(placement: .topBarLeading) { directoryButton }
                                        .axisBehavior(.verticalPreferred)
                                }
                                ToolbarItem(placement: .topBarTrailing) { ExternalImportInboxButton(native: true) }
                                    .axisBehavior(.verticalPreferred)
                                ToolbarItem(placement: .topBarTrailing) { downloadsButton }
                                    .axisBehavior(.verticalPreferred)
                                    .visibilityPriority(.high)
                                ToolbarItem(placement: .topBarTrailing) { newSessionButton }
                                    .axisBehavior(.verticalPreferred)
                                    .visibilityPriority(.high)
                            }
                        }
                    }
            } else {
                legacyToolbar(content)
            }
            #else
            legacyToolbar(content)
            #endif
        } else {
            content
        }
    }

    private func legacyToolbar(_ content: Content) -> some View {
        content
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .principal) { principalTitle }
                if showActions {
                    if selecting {
                        ToolbarItem(placement: .topBarLeading) { exitSelectionButton }
                        ToolbarItem(placement: .topBarTrailing) { closeSelectedButton }
                    } else {
                        if !persistentDirectory {
                            ToolbarItem(placement: .topBarLeading) { directoryButton }
                        }
                        ToolbarItem(placement: .topBarTrailing) { ExternalImportInboxButton(native: true) }
                        ToolbarItem(placement: .topBarTrailing) { downloadsButton }
                        ToolbarItem(placement: .topBarTrailing) { newSessionButton }
                    }
                }
            }
    }

    @ViewBuilder private var principalTitle: some View {
        if selecting {
            OrbisMotionText(L10n.tr("已选择 {0} 项", selectedCount))
                .font(.orbisTitle())
                .foregroundStyle(palette.text)
        } else {
            VStack(spacing: 0) {
                Text("Orbis").font(.orbisBody(.semibold))
                    .foregroundStyle(palette.secondary)
                Text("Nothing But the Remote").font(.system(size: 10, weight: .medium))
                    .tracking(0.3)
                    .foregroundStyle(palette.secondary)
                    .lineLimit(1)
            }
        }
    }

    private var exitSelectionButton: some View {
        Button(action: onExitSelection) {
            Label(L10n.tr("退出多选"), systemImage: "xmark")
        }
        .accessibilityLabel(L10n.tr("退出多选"))
    }

    private var directoryButton: some View {
        Button(action: onDirectory) {
            Label(L10n.tr("打开会话目录"), systemImage: "line.3.horizontal")
        }
        .accessibilityLabel(L10n.tr("打开会话目录"))
    }

    private var downloadsButton: some View {
        Button(action: onDownloads) {
            Label(L10n.tr("下载"), systemImage: "arrow.down.to.line")
        }
        .accessibilityIdentifier("home-downloads")
        .accessibilityLabel(L10n.tr("下载"))
    }

    private var newSessionButton: some View {
        Button(action: onDraft) {
            Label(draftOpen ? L10n.tr("收起新会话") : L10n.tr("新建会话"),
                  systemImage: draftOpen ? "xmark" : "plus")
        }
        .accessibilityIdentifier("home-new-session")
        .accessibilityLabel(draftOpen ? L10n.tr("收起新会话") : L10n.tr("新建会话"))
    }

    private var closeSelectedButton: some View {
        Button(L10n.tr("关闭"), action: onCloseSelected)
            .tint(palette.error)
            .disabled(!canCloseSelected)
            .accessibilityLabel(L10n.tr("关闭选中会话"))
    }
}
