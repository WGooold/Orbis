import SwiftUI
import UIKit

/// Stores content coordinates, so native scrolling never republishes every card's geometry.
@MainActor
private final class DirectoryViewport: ObservableObject {
    @Published private(set) var scrolling = false
    var directories: [SessionDirectory]?
    private(set) var projection: SessionDirectoryProjection?
    weak var scrollView: UIScrollView?
    private var keys: [String] = []
    private var identity = ""
    private var frames: [String: CGRect] = [:]
    private var activity: [String: Int64] = [:]
    private enum Target { case offset(CGFloat), anchor(String, CGFloat) }
    private var target: Target?
    private var scheduled = false

    func remember(_ projection: SessionDirectoryProjection?, identity: String) {
        guard let projection else { return }
        if self.projection === projection {
            if self.identity != identity { self.identity = identity; target = nil }
            return
        }
        self.projection = projection
        self.directories = projection.directories
        let next = projection.keys
        let activity = projection.activity
        let updated = Set(activity.keys.filter { self.activity[$0] != nil && self.activity[$0] != activity[$0] })
        defer { self.identity = identity; keys = next; self.activity = activity }
        guard self.identity == identity, keys != next, !keys.isEmpty,
              let scroll = scrollView, !scrolling else { target = nil; return }
        let offset = scroll.contentOffset.y
        let top = offset + scroll.adjustedContentInset.top
        if top <= 8 { target = .offset(-scroll.adjustedContentInset.top) }
        else if let anchor = keys.first(where: { key in
            guard let frame = frames[key], frame.height > 0 else { return false }
            return frame.minY >= top && frame.maxY <= offset + scroll.bounds.height - scroll.adjustedContentInset.bottom
        }), let frame = frames[anchor] {
            let moved = catalogAnchorMoved(previous: keys, current: next, anchor: anchor, updated: updated)
            target = moved ? .offset(offset) : .anchor(anchor, frame.minY - offset)
        } else { target = .offset(offset) }
        scheduleRestore()
    }

    func record(_ key: String, frame: CGRect) {
        frames[key] = frame
        if target != nil { scheduleRestore() }
    }

    func interactionChanged(_ active: Bool) {
        if scrolling != active { scrolling = active }
    }

    private func scheduleRestore() {
        guard !scheduled else { return }
        scheduled = true
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.scheduled = false
            guard let scroll = self.scrollView, !self.scrolling, let target = self.target else { return }
            self.target = nil
            let y: CGFloat
            switch target {
            case .offset(let value): y = value
            case .anchor(let key, let relativeY): y = (self.frames[key]?.minY ?? scroll.contentOffset.y + relativeY) - relativeY
            }
            let minimum = -scroll.adjustedContentInset.top
            let maximum = max(minimum, scroll.contentSize.height - scroll.bounds.height + scroll.adjustedContentInset.bottom)
            UIView.performWithoutAnimation {
                scroll.setContentOffset(CGPoint(x: scroll.contentOffset.x, y: min(maximum, max(minimum, y))), animated: false)
            }
        }
    }
}

/// Observes the existing native pan; never replaces its delegate or takes the gesture.
private struct DirectoryViewportObserver: UIViewRepresentable {
    let viewport: DirectoryViewport
    func makeUIView(context: Context) -> Observer { Observer(viewport: viewport) }
    func updateUIView(_ view: Observer, context: Context) { view.attach() }
    static func dismantleUIView(_ view: Observer, coordinator: ()) { view.detach() }

    final class Observer: UIView {
        let viewport: DirectoryViewport
        private weak var scroll: UIScrollView?
        private var displayLink: CADisplayLink?
        init(viewport: DirectoryViewport) { self.viewport = viewport; super.init(frame: .zero); isUserInteractionEnabled = false }
        required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
        override func didMoveToWindow() { super.didMoveToWindow(); attach() }
        func attach() {
            var parent = superview
            while let view = parent {
                if let found = view as? UIScrollView {
                    if scroll !== found {
                        detach(); scroll = found; viewport.scrollView = found
                        found.panGestureRecognizer.addTarget(self, action: #selector(panChanged))
                    }
                    return
                }
                parent = view.superview
            }
        }
        func detach() {
            scroll?.panGestureRecognizer.removeTarget(self, action: #selector(panChanged))
            displayLink?.invalidate(); displayLink = nil
            scroll = nil
        }
        @objc private func panChanged() {
            guard let scroll else { return }
            if scroll.panGestureRecognizer.state == .began || scroll.panGestureRecognizer.state == .changed {
                viewport.interactionChanged(true)
            }
            if displayLink == nil {
                let link = CADisplayLink(target: self, selector: #selector(checkIdle))
                displayLink = link; link.add(to: .main, forMode: .common)
            }
        }
        @objc private func checkIdle() {
            guard let scroll, !scroll.isTracking && !scroll.isDragging && !scroll.isDecelerating else { return }
            displayLink?.invalidate(); displayLink = nil
            viewport.interactionChanged(false)
        }
    }
}

struct SessionDirectoryState: Equatable {
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

struct SessionDrawerView: View, Equatable {
    let store: OrbisStore
    @ObservedObject var updates: ScreenPublication
    let renderedState: SessionDirectoryState
    static func == (lhs: Self, rhs: Self) -> Bool { lhs.store === rhs.store && lhs.renderedState == rhs.renderedState }

    @Environment(\.orbisReduceMotion) private var reduceMotion
    @Environment(\.colorScheme) private var scheme
    @AppStorage("orbis.appearance") private var visualStyle = "mist"
    @Binding var state: SessionDirectoryState
    @FocusState private var searchFocused: Bool
    @State private var selectedSessionIds: Set<String> = []
    @StateObject private var viewport = DirectoryViewport()
    @State private var directoryWorker = SessionDirectoryWorker()
    @State private var incomingProjection: SessionDirectoryProjection?
    private var catalog: SessionDirectoryCatalog { store.activeConnection.directoryCatalog }
    private var request: SessionDirectoryFilter {
        SessionDirectoryFilter(hostId: store.selectedHostId, catalogRevision: catalog.revision, query: state.query,
            kind: state.kind, archived: state.archived, provider: state.providerKey,
            currentProvider: store.currentProvider(for: state.kind ?? "codex"), language: String(describing: AppLocalization.shared.language))
    }
    private var projection: SessionDirectoryProjection? {
        incomingProjection?.filter.sameView(as: request) == true ? incomingProjection : nil
    }
    let onClose: () -> Void
    let onOpenSession: (SessionSummary) -> Void
    let onNewSession: (String?) -> Void
    let onAddHost: () -> Void
    let onProviders: () -> Void
    let onUnpair: (HostPairing) -> Void
    @EnvironmentObject private var overlay: OrbisOverlay

    private var hasProviderFilter: Bool { state.kind == "codex" || state.kind == "codexDesktop" }
    private var providerOptions: [SessionProviderOption] { projection?.options ?? [] }
    private var effectiveProviderKey: String { projection?.provider ?? state.providerKey }
    private var providerLabel: String { providerOptions.first { $0.key == effectiveProviderKey }?.label ?? L10n.tr("当前 provider") }
    private var displayedProjection: SessionDirectoryProjection? {
        viewport.scrolling && viewport.projection?.filter.sameView(as: request) == true ? viewport.projection : projection
    }
    private var directories: [SessionDirectory] { displayedProjection?.directories ?? [] }

    var body: some View {
        let incoming = self.projection
        let shown = displayedProjection
        let directories = shown?.directories ?? []
        let _ = viewport.scrolling ? () : viewport.remember(incoming, identity: "\(store.selectedHostId ?? "")|\(state.query)|\(state.kind ?? "")|\(state.archived)|\(state.providerKey)|\(state.expandedPath ?? "")|\(state.showAllSessions)")
        let selectedSessions = (shown?.sessions ?? []).filter { selectedSessionIds.contains($0.sessionId) }
        VStack(spacing: 16) {
            if selecting {
                HStack(spacing: 8) {
                    Text(L10n.tr("已选择 {0} 项", selectedSessions.count)).font(.orbisTitle())
                    Spacer()
                    OrbisIconButton(symbol: "xmark", label: L10n.tr("退出多选")) { selectedSessionIds = [] }
                }
                OrbisActionButton(title: state.archived ? L10n.tr("恢复选中会话") : L10n.tr("归档选中会话"),
                    symbol: state.archived ? "tray.and.arrow.up" : "archivebox", action: archiveSelection)
                    .disabled(selectedSessions.contains { archiveUnavailableReason($0) != nil })
                if selectedSessions.count == 1, let session = selectedSessions.first, !state.archived {
                    OrbisTextButton(title: L10n.tr("在电脑继续会话"), symbol: "play") {
                        if let problem = store.providerMismatch(session) { showMismatch(problem) }
                        else { store.activate(session) }
                    }.disabled(store.connection != .secured || store.activatingSessionId != nil)
                }
            }
            HStack(spacing: 8) {
                HStack(spacing: 8) {
                    Image(systemName: "magnifyingglass").foregroundStyle(OrbisPalette(scheme).secondary)
                    TextField(L10n.tr("搜索目录或会话"), text: $state.query).font(.orbisBody())
                        .focused($searchFocused).submitLabel(.search).onSubmit { searchFocused = false }
                        .autocorrectionDisabled().textInputAutocapitalization(.never)
                    OrbisIconButton(symbol: "xmark", label: L10n.tr("清除搜索"), size: 28) { state.query = "" }
                        .opacity(state.query.isEmpty ? 0 : 1).disabled(state.query.isEmpty).accessibilityHidden(state.query.isEmpty)
                }.padding(.leading, 16).frame(minHeight: 56).orbisField(focused: searchFocused)
                OrbisIconButton(symbol: state.archived ? "archivebox.fill" : "archivebox",
                    label: state.archived ? L10n.tr("查看未归档会话") : L10n.tr("查看已归档会话"),
                    tint: state.archived ? OrbisPalette(scheme).accent : OrbisPalette(scheme).secondary,
                    selected: state.archived, compact: true) { state.archived.toggle() }
                    .accessibilityIdentifier("drawer-archive-toggle")
                    .accessibilityAddTraits(state.archived ? [.isSelected] : [])
                OrbisMenuIconButton(symbol: "line.3.horizontal.decrease", label: L10n.tr("筛选会话：{0}", state.kind.map(filterTitle) ?? L10n.tr("全部")),
                    tint: state.kind == nil ? OrbisPalette(scheme).secondary : OrbisPalette(scheme).accent,
                    selected: state.kind != nil, compact: true) { filterMenuItems }
            }.padding(.top, 16)
            // One fixed row carries the title, the active filter and the counts; filtering never inserts a row.
            HStack(spacing: 8) {
                OrbisMotionText(searching ? L10n.tr("搜索结果") : state.archived ? L10n.tr("已归档") : L10n.tr("工作目录"))
                    .font(.orbisLabel(.semibold)).accessibilityAddTraits(.isHeader)
                if let kind = state.kind {
                    OrbisMotionText(filterTitle(kind)).font(.orbisCaption(.medium)).foregroundStyle(OrbisPalette(scheme).accent).lineLimit(1)
                    if hasProviderFilter {
                        OrbisMotionText(providerLabel).font(.orbisCaption(.medium)).foregroundStyle(OrbisPalette(scheme).accent).lineLimit(1)
                    }
                }
                Spacer(minLength: 4)
                Text(L10n.tr("{0} 个目录，{1} 个会话", directories.count, directories.reduce(0) { $0 + $1.sessions.count }))
                    .font(.orbisCaption()).foregroundStyle(OrbisPalette(scheme).secondary).fixedSize()
            }.frame(minHeight: 28)
            ScrollView {
                // A directory can shrink by several screens while its header is offscreen.
                // Measure every group so the scroll extent never retains an old lazy estimate.
                VStack(spacing: 2) {
                    if directories.isEmpty {
                        OrbisEmptyState(symbol: state.query.isEmpty ? "folder" : "magnifyingglass", title: emptyTitle)
                            .padding(.top, 40)
                        if state.query.isEmpty { OrbisTextButton(title: L10n.tr("新建会话"), symbol: "plus") { onNewSession(nil) } }
                    }
                    ForEach(directories) { directory in
                        directoryGroup(directory).transition(.opacity.combined(with: .offset(y: 4)))
                    }
                }.padding(6).padding(.bottom, 16)
                    .coordinateSpace(name: "directory-viewport-content")
                    .background(DirectoryViewportObserver(viewport: viewport))
                    .animation(reduceMotion ? nil : InteractionMotion.panel, value: "\(state.kind ?? "")|\(state.archived)|\(state.providerKey)|\(state.query)")
            }
            // As in the transcript, let the scroll view resolve shrinking content itself.
            .defaultScrollAnchor(.top)
            .scrollDismissesKeyboard(.interactively)
            .accessibilityIdentifier("drawer-session-list")
            hostSelector
        }.padding(.horizontal, 16)
            .onAppear(perform: resolveExpansion)
            .onChange(of: directories.map(\.path)) { _, _ in resolveExpansion() }
            .onChange(of: store.selectedHostId) { _, _ in state.providerKey = "current"; restartExpansion() }
            .onChange(of: state.kind) { _, _ in state.providerKey = "current"; restartExpansion() }
            .onChange(of: state.archived) { _, _ in restartExpansion() }
            .onChange(of: state.providerKey) { _, _ in restartExpansion() }
            .onChange(of: state.query) { _, _ in restartExpansion() }
            .onChange(of: directories.flatMap(\.sessions).map(\.sessionId)) { _, ids in
                selectedSessionIds.formIntersection(ids)
            }
            .task(id: request) {
                let filter = request, source = catalog
                let next = await directoryWorker.resolve(catalog: source, filter: filter)
                guard !Task.isCancelled else { return }
                incomingProjection = next
                if !viewport.scrolling { resolveExpansion() }
            }
            .onChange(of: viewport.scrolling) { _, active in if !active { resolveExpansion() } }
            .onDisappear { selectedSessionIds = [] }
    }

    private var searching: Bool { !state.query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
    private var selectedSessions: [SessionSummary] {
        (displayedProjection?.sessions ?? []).filter { selectedSessionIds.contains($0.sessionId) }
    }
    private var selecting: Bool { !selectedSessionIds.isEmpty }

    private func beginSelection(_ id: String) {
        if !selectedSessionIds.contains(id) { OrbisHaptics.beginSelection() }
        searchFocused = false
        selectedSessionIds.insert(id)
    }

    private func toggleSelection(_ id: String) {
        OrbisHaptics.selectionChanged()
        if selectedSessionIds.contains(id) { selectedSessionIds.remove(id) }
        else { selectedSessionIds.insert(id) }
    }

    private func archiveUnavailableReason(_ session: SessionSummary) -> String? {
        guard store.connection == .secured else { return L10n.tr("连接电脑后可操作") }
        guard let kind = session.agentKind else { return L10n.tr("尚未获取会话类型") }
        guard !store.isArchiving(session.sessionId) else { return L10n.tr("处理中…") }
        guard session.archived != true else { return nil }
        let runtimes = store.runtimes.filter { $0.sessionId == session.sessionId }
        guard !runtimes.isEmpty else { return nil }
        if kind == "pi" { return L10n.tr("请先退出 Pi 会话") }
        if kind == "claude" { return L10n.tr("请先退出 Claude Code 会话") }
        return runtimes.allSatisfy { $0.status == "idle" } ? nil : L10n.tr("等待任务完成后归档")
    }

    private func archiveSelection() {
        let sessions = selectedSessions
        guard !sessions.isEmpty, sessions.allSatisfy({ archiveUnavailableReason($0) == nil }) else { return }
        for session in sessions { store.archive(session, archived: !state.archived) }
        selectedSessionIds = []
    }

    private var filterMenuItems: [OrbisMenuItem] {
        var items: [OrbisMenuItem] = []
        if state.kind != nil {
            items.append(OrbisMenuItem(title: L10n.tr("清除筛选"), symbol: "arrow.uturn.backward") { state.kind = nil; state.providerKey = "current" })
            items.append(.divider)
        }
        items.append(OrbisMenuItem(title: L10n.tr("全部"), checked: state.kind == nil) { state.kind = nil })
        items += ["pi", "codex", "codexDesktop", "dsh", "claude"].map { kind in
            OrbisMenuItem(title: filterTitle(kind), checked: state.kind == kind) { state.kind = kind }
        }
        if hasProviderFilter {
            items.append(.divider)
            items += providerOptions.map { option in
                OrbisMenuItem(title: option.label, checked: effectiveProviderKey == option.key) { state.providerKey = option.key }
            }
        }
        items.append(.divider)
        items.append(OrbisMenuItem(title: L10n.tr("设置"), symbol: "gearshape", action: onProviders))
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
        selectedSessionIds = []
        state.needsDefaultExpansion = true
        resolveExpansion()
    }

    private func toggle(_ path: String) {
        state.expandedPath = state.expandedPath == path ? nil : path
        state.showAllSessions = false
        searchFocused = false
    }

    private var emptyTitle: String {
        if !state.query.isEmpty { return L10n.tr("没有匹配的会话") }
        if hasProviderFilter && effectiveProviderKey == "current" && store.currentProvider(for: state.kind ?? "codex") == nil { return L10n.tr("尚未获取当前 provider") }
        return state.archived ? L10n.tr("没有已归档的会话") : L10n.tr("暂无会话")
    }

    private func directoryGroup(_ directory: SessionDirectory) -> some View {
        let expanded = state.expandedPath == directory.path
        let hidden = directory.sessions.count - directorySessionPreviewLimit
        let visible = expanded && (state.showAllSessions || searching || hidden <= 0) ? directory.sessions : Array(directory.sessions.prefix(directorySessionPreviewLimit))
        let running = directory.sessions.contains { catalog.runtimeBySession[$0.sessionId].map { ["running", "compacting", "starting", "background"].contains($0.presentationStatus) } == true }
        return VStack(spacing: 0) {
            OrbisMotionButton { toggle(directory.path) } label: {
                HStack(spacing: 8) {
                    Image(systemName: expanded ? "folder.fill" : "folder").font(.system(size: 18))
                        .foregroundStyle(expanded ? OrbisPalette(scheme).text : OrbisPalette(scheme).secondary)
                    Text(directoryTitle(directory.path)).font(.orbisLabel(.semibold)).lineLimit(1)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    if running && !expanded { OrbisStatusDot(tone: OrbisPalette(scheme).success, working: true) }
                    Text("\(directory.sessions.count)").font(.orbisCaption()).foregroundStyle(OrbisPalette(scheme).secondary)
                    Image(systemName: "chevron.right").font(.system(size: 16))
                        .rotationEffect(.degrees(expanded ? 90 : 0)).animation(reduceMotion ? nil : .orbisCollapse, value: expanded)
                }.padding(.horizontal, 8).frame(minHeight: 48).contentShape(Rectangle())
            }.buttonStyle(DirectoryRowStyle())
                .accessibilityLabel(L10n.tr("{0}目录 {1}，{2} 个会话", expanded ? L10n.tr("收起") : L10n.tr("展开"), directory.path, directory.sessions.count))
                .accessibilityIdentifier("drawer-directory-" + directory.path)
                .onGeometryChange(for: CGRect.self) { $0.frame(in: .named("directory-viewport-content")) } action: { viewport.record("directory:" + directory.path, frame: $0) }
            OrbisCollapse(expanded: expanded) {
                VStack(spacing: 0) {
                    ForEach(visible) { session in
                        sessionRow(session).id(session.sessionId + "|" + state.query)
                            .transition(.opacity.combined(with: .offset(y: 4)))
                            .onGeometryChange(for: CGRect.self) { $0.frame(in: .named("directory-viewport-content")) } action: { viewport.record("session:" + session.sessionId, frame: $0) }
                    }
                    HStack(spacing: 4) {
                        OrbisMotionButton { onNewSession(directory.path) } label: {
                            Label(L10n.tr("新建会话"), systemImage: "plus").font(.orbisCaption()).foregroundStyle(OrbisPalette(scheme).accent).frame(minHeight: 48)
                        }.buttonStyle(DirectoryRowStyle()).disabled(store.connection != .secured || store.activatingSessionId != nil)
                        Spacer(minLength: 4)
                        if hidden > 0 && !searching {
                            OrbisMotionButton { state.showAllSessions.toggle() } label: {
                                HStack(spacing: 4) {
                                    Text(state.showAllSessions ? L10n.tr("收起较早会话") : L10n.tr("全部 {0} 个", directory.sessions.count))
                                    Image(systemName: state.showAllSessions ? "chevron.up" : "chevron.right")
                                }.font(.orbisCaption()).foregroundStyle(OrbisPalette(scheme).secondary).frame(minHeight: 48)
                            }.buttonStyle(DirectoryRowStyle())
                        }
                    }
                }.padding(.leading, 34).padding(.bottom, 8)
                    .overlay(alignment: .leading) {
                        OrbisPalette(scheme).outline.frame(width: 1).padding(.leading, 17).padding(.bottom, 16).allowsHitTesting(false)
                    }
            }
        }
    }

    private func sessionRow(_ session: SessionSummary) -> some View {
        let runtime = catalog.runtimeBySession[session.sessionId]
        let selected = selectedSessionIds.contains(session.sessionId)
        let current = store.selectedRuntime?.sessionId == session.sessionId
        let unavailable = selecting ? archiveUnavailableReason(session) : nil
        return OrbisMotionButton {
            searchFocused = false
            if selecting { toggleSelection(session.sessionId) }
            else if runtime != nil, let problem = store.providerMismatch(session) { showMismatch(problem) }
            else { onOpenSession(session) }
        } label: {
            HStack(spacing: 8) {
                ZStack {
                    AgentEmblem(kind: session.agentKind, size: 14, recessed: false).opacity(store.activatingSessionId == session.sessionId ? 0 : 1)
                    if store.activatingSessionId == session.sessionId { ProgressView().controlSize(.mini) }
                }.frame(width: 14, height: 16)
                Text(catalog.titles[session.sessionId] ?? session.sessionId).font(.orbisLabel(current ? .semibold : .regular))
                    .foregroundStyle(current ? OrbisPalette(scheme).accent : OrbisPalette(scheme).text)
                    .lineLimit(1).frame(maxWidth: .infinity, alignment: .leading)
                if let unavailable {
                    Image(systemName: "exclamationmark.circle").font(.system(size: 14)).foregroundStyle(OrbisPalette(scheme).warning).accessibilityLabel(unavailable)
                } else if let runtime, runtime.presentationStatus != "idle" {
                    RuntimeStatusLabel(status: runtime.presentationStatus, title: runtime.presentationTitle)
                } else {
                    Text(sessionTimeTitle(session.modifiedAt)).font(.orbisCaption()).foregroundStyle(OrbisPalette(scheme).secondary).lineLimit(1)
                }
                if selecting { OrbisSelectionIndicator(selected: selected, selecting: true) }
            }.padding(.horizontal, 8).frame(minHeight: 48).contentShape(Rectangle())
        }.buttonStyle(DirectoryRowStyle(current: current, selected: selected))
            .disabled(store.activatingSessionId != nil && !selecting)
            .highPriorityGesture(LongPressGesture().onEnded { _ in beginSelection(session.sessionId) })
            .accessibilityIdentifier("drawer-session-" + session.sessionId)
            .accessibilityAddTraits(selected ? .isSelected : [])
            .accessibilityHint(sessionOtherProvider(session, current: store.currentProvider(for: session.agentKind ?? "")) ?? "")
            .accessibilityAction(named: L10n.tr("选择会话")) { beginSelection(session.sessionId) }
    }

    private func showMismatch(_ problem: String) {
        overlay.showDialog(L10n.tr("需要切换 provider"), message: problem, actions: [
            OrbisDialogAction(title: L10n.tr("取消"), role: .cancel),
            OrbisDialogAction(title: L10n.tr("设置"), action: onProviders)
        ])
    }

    private var hostSelector: some View {
        HStack(spacing: 10) {
            // The only place to add or unpair a computer (ADR-0046 §5).
            OrbisMenuButton(accessibilityLabel: L10n.tr("电脑，当前 {0}", store.selectedHost?.hostName ?? L10n.tr("未选择")),
                            items: { hostSwitchMenuItems(store, onAddHost: onAddHost, onUnpair: onUnpair) }) {
                HStack(spacing: 10) {
                    OrbisActionSymbol(systemName: "desktopcomputer").foregroundStyle(OrbisPalette(scheme).accent)
                    VStack(alignment: .leading, spacing: 3) {
                        Text(L10n.tr("电脑")).font(.orbisCaption()).foregroundStyle(OrbisPalette(scheme).secondary)
                        Text(store.selectedHost?.hostName ?? L10n.tr("选择电脑")).font(.orbisBody(.semibold)).lineLimit(1)
                    }
                    Spacer()
                    OrbisActionSymbol(systemName: "chevron.up.chevron.down").imageScale(.small).foregroundStyle(OrbisPalette(scheme).secondary)
                }.padding(12).frame(minHeight: 58).contentShape(Rectangle())
            }
        }.padding(.bottom, 18)
    }
}

private struct DirectoryRowStyle: ButtonStyle {
    @Environment(\.colorScheme) private var scheme
    var current = false
    var selected = false
    func makeBody(configuration: Configuration) -> some View {
        configuration.label.environment(\.orbisGlyphPressed, configuration.isPressed)
            .neuSurface(inset: current || configuration.isPressed, radius: 12,
                        intensity: current || configuration.isPressed ? 0.4 : 0, press: configuration.isPressed)
            .overlay { OrbisSelectionFill(selected: selected, origin: nil, radius: 12, color: OrbisPalette(scheme).accent) }
    }
}

private func filterTitle(_ kind: String) -> String {
    switch kind {
    case "codex": return L10n.tr("Codex 终端")
    case "codexDesktop": return L10n.tr("Codex 桌面版")
    case "dsh": return "DeepSeek"
    case "claude": return "Claude Code"
    default: return "Pi"
    }
}

/// A local draft is the first step of creating a session. Nothing is sent to the
/// computer until the first sentence is submitted through the existing launch/send ledgers.
struct SessionDraftView: View {
    @EnvironmentObject private var store: OrbisStore
    @Environment(\.colorScheme) private var scheme
    @Environment(\.orbisReduceMotion) private var reduced
    @Environment(\.orbisVisible) private var visible
    @Environment(\.scenePhase) private var scenePhase
    @EnvironmentObject private var overlay: OrbisOverlay
    @AppStorage("orbis.appearance") private var appearance = "mist"
    @AppStorage("orbis.lastDraftAgent") private var agent = "codex"
    @State private var text = ""
    let owner: HostConnection
    let presetCwd: String?
    let closeRequest: Int
    let onSubmitted: (HostConnection.LaunchState, CGRect) -> Void
    let onCancel: (Bool) -> Void
    @State private var path: String?
    @State private var choosingDirectory = false
    @State private var cancelling = false
    @State private var risen = false
    @State private var frame: CGRect = .zero
    @State private var codexFrame: CGRect = .zero
    @State private var focused = false
    init(owner: HostConnection, presetCwd: String?, closeRequest: Int, onSubmitted: @escaping (HostConnection.LaunchState, CGRect) -> Void, onCancel: @escaping (Bool) -> Void) {
        self.owner = owner; self.presetCwd = presetCwd; self.closeRequest = closeRequest; self.onSubmitted = onSubmitted; self.onCancel = onCancel
        _path = State(initialValue: presetCwd)
    }
    private var draftRuntime: RuntimeSummary { RuntimeSummary(runtimeId: "local-new-session", name: "", cwd: "", status: "idle", sessionId: "local-new-session", agentKind: agent) }
    private var pathRuntime: RuntimeSummary { RuntimeSummary(runtimeId: "local-new-session-path", name: "", cwd: "", status: "idle", sessionId: "local-new-session-path", agentKind: agent) }
    private var allowed: [String] { store.launchableAgents ?? store.supportedAgents ?? ["pi", "codex"] }
    private var currentPath: String? { path ?? presetCwd ?? store.browse?.path }
    private var canSend: Bool {
        !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && currentPath?.isEmpty == false &&
            store.connection == .secured && store.activatingSessionId == nil && allowed.contains(agent)
    }
    var body: some View {
        let p = OrbisPalette(scheme)
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 4) {
                ForEach(["codex", "claude", "dsh", "pi"], id: \.self) { kind in
                    OrbisMotionButton { agent = kind == "codex" && !allowed.contains("codex") && allowed.contains("codexDesktop") ? "codexDesktop" : kind } label: {
                        AgentEmblem(kind: kind, size: 20, recessed: false)
                            .saturation(agent == kind || kind == "codex" && agent == "codexDesktop" ? 1 : 0).opacity(agent == kind || kind == "codex" && agent == "codexDesktop" ? 1 : 0.4)
                            .frame(width: 36, height: 36)
                            .neuSurface(inset: agent == kind || kind == "codex" && agent == "codexDesktop", radius: 18,
                                intensity: agent == kind || kind == "codex" && agent == "codexDesktop" ? 0.4 : 0, concentric: false)
                            .frame(width: 48, height: 48).contentShape(Rectangle())
                    }.buttonStyle(.plain).disabled(!allowed.contains(kind) && !(kind == "codex" && allowed.contains("codexDesktop")))
                        .onGeometryChange(for: CGRect.self) { $0.frame(in: .global) } action: { if kind == "codex" { codexFrame = $0 } }
                        .simultaneousGesture(LongPressGesture().onEnded { _ in if kind == "codex" { showCodexChoices() } })
                        .accessibilityAction(named: L10n.tr("Codex 桌面版")) { if kind == "codex", allowed.contains("codexDesktop") { agent = "codexDesktop" } }
                        .accessibilityIdentifier("draft-agent-" + kind).accessibilityAddTraits(agent == kind || kind == "codex" && agent == "codexDesktop" ? .isSelected : [])
                }
                Spacer(minLength: 0)
                Text(agent == "codexDesktop" ? L10n.tr("Codex 桌面版") : agentTitle(agent)).font(.orbisLabel(.semibold)).foregroundStyle(p.agent(agent)).lineLimit(1)
            }
            OrbisMotionButton { focused = false; choosingDirectory = true } label: {
                HStack(spacing: 8) {
                    Image(systemName: "folder").font(.system(size: 16))
                    Text(currentPath ?? L10n.tr("选择工作目录")).font(.orbisCaption(mono: true)).lineLimit(1).truncationMode(.middle)
                    Spacer(minLength: 0); Image(systemName: "chevron.down").font(.orbisCaption())
                }.foregroundStyle(p.secondary).frame(minHeight: 48).contentShape(Rectangle())
            }.buttonStyle(.plain).accessibilityIdentifier("draft-directory")
            HStack(alignment: .bottom, spacing: 8) {
                OrbisDraftEditor(text: $text, focused: Binding(get: { focused }, set: { focused = $0 }),
                    placeholder: L10n.tr("让 {0} 做什么？", agent == "codexDesktop" ? L10n.tr("Codex 桌面版") : agentTitle(agent)),
                    ink: UIColor(p.text), placeholderInk: UIColor(p.secondary), onSubmit: submit, onCancel: cancel)
                    .padding(.horizontal, 12).padding(.vertical, 10).frame(minHeight: 56)
                    .orbisField(focused: focused)
                OrbisIconButton(symbol: "arrow.up", label: L10n.tr("发送"), tint: p.agent(agent), action: submit)
                    .disabled(!canSend).accessibilityIdentifier("draft-send").padding(.bottom, 4)
            }
            Text(L10n.tr("发出第一句话，才会在电脑上创建这个会话")).font(.orbisCaption()).foregroundStyle(p.secondary)
        }.opacity(risen ? 1 : 0).offset(y: risen ? 0 : 4)
            .neuSurface(inset: !risen, radius: 24, intensity: 0.65, padding: 16)
            .environment(\.orbisAccent, p.agent(agent)).tint(p.agent(agent))
            .accessibilityElement(children: .contain).accessibilityIdentifier("session-draft")
            .onGeometryChange(for: CGRect.self) { $0.frame(in: .global) } action: { frame = $0 }
            .onAppear {
                text = owner.draft(for: draftRuntime)
                let rememberedPath = owner.draft(for: pathRuntime)
                if presetCwd == nil && !rememberedPath.isEmpty { path = rememberedPath }
                if currentPath == nil { path = store.selectedRuntime?.cwd ?? store.sessions.first?.cwd }
                if !allowed.contains(agent), let first = allowed.first { agent = first }
                if currentPath == nil { store.browseDirectory() }
            }
            .task {
                if !reduced { try? await Task.sleep(for: .milliseconds(200)) }
                guard !Task.isCancelled, !cancelling else { return }
                withAnimation(reduced ? nil : InteractionMotion.selection) { risen = true }
                if !reduced { try? await Task.sleep(for: .milliseconds(120)) }
                if !cancelling && visible && scenePhase == .active { focused = true }
            }
            .onChange(of: text) { _, value in owner.saveDraft(value, for: draftRuntime) }
            .onChange(of: presetCwd) { _, value in if let value { path = value } }
            .onChange(of: path) { _, value in owner.saveDraft(value ?? "", for: pathRuntime) }
            .onChange(of: closeRequest) { _, _ in cancel() }
            .onChange(of: visible) { _, active in if !active { focused = false } }
            .onChange(of: scenePhase) { _, phase in if phase != .active { focused = false } }
            .onKeyPress(.escape) { cancel(); return .handled }
            .orbisBottomSheet(isPresented: $choosingDirectory) { directorySheet.orbisSheet([.large]) }
    }
    private var directorySheet: some View {
        VStack(spacing: 16) {
            OrbisPageHeader(title: L10n.tr("在哪个目录里开始"), closes: true, back: { choosingDirectory = false }) { EmptyView() }
            ScrollView { RemoteDirectoryView() }
            OrbisActionButton(title: L10n.tr("选择这个目录"), symbol: "checkmark") {
                path = store.browse?.path; choosingDirectory = false
            }.disabled(store.browse?.path?.isEmpty != false || store.browse?.loading != false || store.browse?.error != nil)
        }.padding(16).onAppear { store.browseDirectory(currentPath) }
            .onDisappear { store.dismissBrowse() }
    }
    /// Preserve the existing desktop backend without adding a fifth primary Agent.
    private func showCodexChoices() {
        focused = false
        var choices: [OrbisMenuItem] = []
        if allowed.contains("codex") { choices.append(OrbisMenuItem(title: "Codex", checked: agent == "codex") { agent = "codex" }) }
        if allowed.contains("codexDesktop") { choices.append(OrbisMenuItem(title: L10n.tr("Codex 桌面版"), checked: agent == "codexDesktop") { agent = "codexDesktop" }) }
        if !choices.isEmpty { overlay.showMenu(choices, from: codexFrame) }
    }
    private func cancel() {
        cancelling = true
        focused = false
        let retained = !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        withAnimation(reduced ? nil : InteractionMotion.selection) { risen = false }
        if reduced { onCancel(retained) }
        else { DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) { onCancel(retained) } }
    }
    private func submit() {
        guard owner === store.activeConnection, canSend, let cwd = currentPath else { return }
        let sentence = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard store.createSession(agentKind: agent, cwd: cwd, firstMessage: sentence), let launch = store.launching else { return }
        owner.saveDraft("", for: draftRuntime)
        text = ""; focused = false; OrbisHaptics.commit(); onSubmitted(launch, frame)
    }
}

struct RemoteDirectoryView: View {
    @EnvironmentObject private var store: OrbisStore
    @Environment(\.colorScheme) private var scheme
    @AppStorage("orbis.appearance") private var visualStyle = "mist"
    var body: some View {
        VStack(spacing: 14) {
            HStack(spacing: 8) {
                OrbisActionSymbol(systemName: "folder").foregroundStyle(OrbisPalette(scheme).accent)
                Text(store.browse?.path.flatMap { $0.isEmpty ? nil : $0 } ?? L10n.tr("电脑根目录"))
                    .font(.orbisCaption(mono: true)).frame(maxWidth: .infinity, alignment: .leading)
                // Spinner and refresh share one fixed slot so the path never reflows while loading.
                ZStack {
                    if store.browse?.loading == true { ProgressView().controlSize(.small) }
                    else { OrbisIconButton(symbol: "arrow.clockwise", label: L10n.tr("刷新目录")) { store.browseDirectory(store.browse?.path) }.disabled(store.connection != .secured) }
                }.frame(width: 48, height: 48)
            }
            if store.browse?.path?.isEmpty == false {
                OrbisActionButton(title: L10n.tr("上一级"), symbol: "arrow.up") { store.browseDirectory(store.browse?.parent) }
                    .disabled(store.browse?.loading == true || store.connection != .secured)
            }
            if let error = store.browse?.error {
                OrbisNotice(text: error, error: true)
                OrbisActionButton(title: L10n.tr("重新读取"), symbol: "arrow.clockwise") { store.browseDirectory(store.browse?.path) }
                    .disabled(store.connection != .secured)
            } else if store.browse?.loading == false {
                let entries = (store.browse?.entries ?? []).filter(\.isDir).sorted { ($0.hasSessions ? 0 : 1, $0.name) < ($1.hasSessions ? 0 : 1, $1.name) }
                if entries.isEmpty { Text(L10n.tr("此目录没有子目录")).font(.orbisLabel()).foregroundStyle(OrbisPalette(scheme).secondary).padding(16) }
                ForEach(entries) { entry in
                    OrbisMotionButton { store.browseDirectory(remoteBrowsePath(parent: store.browse?.path, name: entry.name)) } label: {
                        HStack(spacing: 10) {
                            OrbisActionSymbol(systemName: "folder").foregroundStyle(OrbisPalette(scheme).accent)
                            Text(entry.name).font(.orbisBody()).frame(maxWidth: .infinity, alignment: .leading)
                            if entry.hasSessions { Text(L10n.tr("有历史")).font(.orbisCaption()).foregroundStyle(OrbisPalette(scheme).accent) }
                            OrbisActionSymbol(systemName: "chevron.right").imageScale(.small)
                        }.padding(14).frame(minHeight: 52)
                    }.buttonStyle(NeuButtonStyle()).disabled(store.connection != .secured)
                }
            }
        }
    }
}


/// Native marked-text editing keeps IME confirmation distinct from first-sentence
/// submission. Hardware Shift+Return inserts a line break; Return submits once.
private struct OrbisDraftEditor: UIViewRepresentable {
    @Binding var text: String
    @Binding var focused: Bool
    let placeholder: String
    let ink: UIColor
    let placeholderInk: UIColor
    let onSubmit: () -> Void
    let onCancel: () -> Void
    func makeCoordinator() -> Coordinator { Coordinator(self) }
    func makeUIView(context: Context) -> Editor {
        let view = Editor()
        view.delegate = context.coordinator
        view.backgroundColor = .clear; view.font = .systemFont(ofSize: 15)
        view.textContainerInset = .zero; view.textContainer.lineFragmentPadding = 4
        view.returnKeyType = .send
        view.accessibilityIdentifier = "draft-message"
        return view
    }
    func updateUIView(_ view: Editor, context: Context) {
        context.coordinator.parent = self
        view.submit = onSubmit; view.cancel = onCancel
        view.placeholder.text = placeholder; view.placeholder.textColor = placeholderInk
        view.placeholder.isHidden = !text.isEmpty
        view.accessibilityLabel = placeholder
        if view.markedTextRange == nil && view.text != text {
            let selected = view.selectedRange; view.text = text
            view.selectedRange = NSRange(location: min(selected.location, text.utf16.count), length: 0)
        }
        view.textColor = ink
        if focused && !view.isFirstResponder { view.becomeFirstResponder() }
        else if !focused && view.isFirstResponder { view.resignFirstResponder() }
    }
    func sizeThatFits(_ proposal: ProposedViewSize, uiView: Editor, context: Context) -> CGSize? {
        let width = proposal.width ?? 240
        let height = uiView.sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude)).height
        return CGSize(width: width, height: min(6 * (uiView.font?.lineHeight ?? 18), max(uiView.font?.lineHeight ?? 18, height)))
    }
    final class Coordinator: NSObject, UITextViewDelegate {
        var parent: OrbisDraftEditor
        init(_ parent: OrbisDraftEditor) { self.parent = parent }
        func textViewDidChange(_ textView: UITextView) {
            parent.text = textView.text; (textView as? Editor)?.placeholder.isHidden = !textView.text.isEmpty
            textView.invalidateIntrinsicContentSize()
        }
        func textViewDidBeginEditing(_ textView: UITextView) { parent.focused = true }
        func textViewDidEndEditing(_ textView: UITextView) { parent.focused = false }
        func textView(_ textView: UITextView, shouldChangeTextIn range: NSRange, replacementText text: String) -> Bool {
            if text == "\n", textView.markedTextRange == nil, (textView as? Editor)?.insertingLineBreak != true { parent.onSubmit(); return false }
            return true
        }
    }
    final class Editor: UITextView {
        var submit: () -> Void = {}
        var cancel: () -> Void = {}
        let placeholder = UILabel()
        var insertingLineBreak = false
        override init(frame: CGRect, textContainer: NSTextContainer?) {
            super.init(frame: frame, textContainer: textContainer)
            placeholder.font = .systemFont(ofSize: 15); placeholder.isUserInteractionEnabled = false; addSubview(placeholder)
        }
        required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
        override func layoutSubviews() {
            super.layoutSubviews(); placeholder.frame = CGRect(x: 4, y: 0, width: bounds.width - 8, height: 22)
        }
        override func pressesBegan(_ presses: Set<UIPress>, with event: UIPressesEvent?) {
            guard markedTextRange == nil else { super.pressesBegan(presses, with: event); return }
            if let key = presses.compactMap(\.key).first(where: { $0.keyCode == .keyboardReturnOrEnter }) {
                let shift = key.modifierFlags.contains(.shift) || presses.compactMap(\.key).contains { [.keyboardLeftShift, .keyboardRightShift].contains($0.keyCode) }
                if shift { lineBreak() } else { send() }
                return
            }
            super.pressesBegan(presses, with: event)
        }
        override var keyCommands: [UIKeyCommand]? {
            guard markedTextRange == nil else { return super.keyCommands }
            return [UIKeyCommand(input: "\r", modifierFlags: .shift, action: #selector(lineBreak)),
             UIKeyCommand(input: "\r", modifierFlags: [], action: #selector(send)),
             UIKeyCommand(input: UIKeyCommand.inputEscape, modifierFlags: [], action: #selector(close))].map { command in
                 command.wantsPriorityOverSystemBehavior = true; return command
             }
        }
        @objc private func lineBreak() {
            guard markedTextRange == nil else { return }
            insertingLineBreak = true; insertText("\n"); insertingLineBreak = false
        }
        @objc private func send() { if markedTextRange == nil { submit() } }
        @objc private func close() { if markedTextRange == nil { cancel() } }
    }
}
