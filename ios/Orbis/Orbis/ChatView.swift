import SwiftUI
import Combine
import UIKit

private struct ChatInterestOwnership {
    let actions: ChatSessionActions
    var target: ChatActionContext { actions.target }
    let lease: AgentInterestLease
}

private struct ChatGitPollKey: Equatable {
    let target: ChatActionContext
    let active: Bool
}

/// Mount-lifetime dependencies only. Live inputs belong in ChatScreenModel or the
/// environment. Callback captures belong to this mount's focus/navigation storage.
struct ChatTranscriptMount: Equatable {
    let model: ChatScreenModel
    let actions: ChatSessionActions
    let mountToken: UUID
    let setComposerFocused: (Bool) -> Void
    let sendFlight: MessageSendFlight
    let acceptedSends: PassthroughSubject<Set<String>, Never>
    let onBack: () -> Void
    let onReturnToNewSession: () -> Void

    static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.model === rhs.model && lhs.actions == rhs.actions && lhs.mountToken == rhs.mountToken &&
            lhs.sendFlight === rhs.sendFlight && lhs.acceptedSends === rhs.acceptedSends
    }
}

/// The complete view remains stable for a native-scroll mount. Check every new
/// construction against the retained mount so volatile inputs cannot fail silently.
private struct ChatTranscriptRegion: View {
    private let proposedMount: ChatTranscriptMount
    @State private var content: EquatableView<ChatTranscriptView>

    init(model: ChatScreenModel, actions: ChatSessionActions, mountToken: UUID,
         setComposerFocused: @escaping (Bool) -> Void, sendFlight: MessageSendFlight,
         acceptedSends: PassthroughSubject<Set<String>, Never>, onBack: @escaping () -> Void, onReturnToNewSession: @escaping () -> Void) {
        let mount = ChatTranscriptMount(model: model, actions: actions, mountToken: mountToken,
            setComposerFocused: setComposerFocused, sendFlight: sendFlight,
            acceptedSends: acceptedSends, onBack: onBack, onReturnToNewSession: onReturnToNewSession)
        proposedMount = mount
        _content = State(initialValue: ChatTranscriptView(mount: mount).equatable())
    }

    var body: some View {
        let _ = assert(content.content.mount == proposedMount,
            "Transcript mount dependencies changed without a new page identity")
        content
    }
}

/// IOS-CHAT-02: stable page shell. Regional publishers update their own subtrees.
struct ChatView: View {
    let model: ChatScreenModel
    let actions: ChatSessionActions
    let fallbackRuntime: RuntimeSummary
    private var target: ChatActionContext { actions.target }
    @Environment(\.colorScheme) private var scheme
    @Environment(\.orbisReduceMotion) private var reduceMotion
    @Environment(\.orbisPageActivity) private var pageActivity
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.orbisVisualActive) private var visualActive
    @Environment(\.orbisFoldReading) private var foldReading
    let onBack: () -> Void
    let onHistory: () -> Void
    let onDownloads: () -> Void
    let onReturnToNewSession: () -> Void
    @State private var sendFlight = MessageSendFlight()
    @State private var downloadFlight = DownloadFlight()
    @State private var acceptedSends = PassthroughSubject<Set<String>, Never>()
    @State private var interest: ChatInterestOwnership?
    @State private var mountToken = UUID()
    @State private var composerFocus = ChatComposerFocus()
    private var accent: Color { OrbisPalette(scheme).agent(model.shell.kind) }

    init?(model: ChatScreenModel, onBack: @escaping () -> Void, onHistory: @escaping () -> Void,
          onDownloads: @escaping () -> Void, onReturnToNewSession: @escaping () -> Void) {
        let actions = model.actions
        guard let runtime = actions.runtime else { return nil }
        self.model = model; self.actions = actions; fallbackRuntime = runtime
        self.onBack = onBack; self.onHistory = onHistory; self.onDownloads = onDownloads; self.onReturnToNewSession = onReturnToNewSession
    }
    var body: some View {
        let _ = ChatSchedulingTrace.regionBody(.page)
        #if DEBUG
        let _ = ChatSchedulingTrace.pageBodyRendered(target: String(describing: target.pageIdentity), mountToken: mountToken)
        #endif
        let _ = ChatDebugProbes.rendered(.page)
        GeometryReader { geometry in
            let division = readingDivision(geometry)
            let reading = foldReading && division != nil
            let controlsVisible = reading && !composerFocus.focused && geometry.size.height - (division?.maxY ?? 0) >= 300
            let pageLayout = reading
                ? AnyLayout(ChatPageLayout(division: division, editing: !controlsVisible))
                : AnyLayout(VStackLayout(spacing: 0))
            pageLayout {
                ChatHeaderView(model: model, actions: actions, fallbackRuntime: fallbackRuntime,
                               composerFocus: composerFocus, downloadFlight: downloadFlight,
                               onBack: onBack, onHistory: onHistory, onDownloads: onDownloads).equatable()
                    .opacity(reading && !controlsVisible ? 0 : 1)
                    .allowsHitTesting(!reading || controlsVisible)
                    .accessibilityHidden(reading && !controlsVisible)
                ChatTranscriptRegion(model: model, actions: actions, mountToken: mountToken,
                                     setComposerFocused: { composerFocus.focused = $0 }, sendFlight: sendFlight,
                                     acceptedSends: acceptedSends, onBack: onBack, onReturnToNewSession: onReturnToNewSession).id(mountToken)
                ChatComposerView(model: model, actions: actions, fallbackRuntime: fallbackRuntime,
                                 composerFocus: composerFocus, sendFlight: sendFlight, onHistory: onHistory,
                                 onAcceptedSend: { acceptedSends.send($0) }).equatable()
                    .anchorPreference(key: FeedbackBottomAnchorKey.self, value: .bounds) { [.init(scope: .chat, bounds: $0)] }
                FoldReadingSurface(model: model, actions: actions, mountToken: mountToken,
                                    enabled: controlsVisible && visualActive && scenePhase == .active,
                                    viewportHeight: max(1, (division?.minY ?? 0) - 12))
                    .frame(height: reading ? nil : 0)
                    .opacity(controlsVisible ? 1 : 0)
                    .allowsHitTesting(controlsVisible)
                    .accessibilityHidden(!controlsVisible)
            }
            .clipped()
        }.frame(maxWidth: 720).frame(maxWidth: .infinity, maxHeight: .infinity)
            .modifier(ChatComposerFocusRegion(focus: composerFocus, actions: actions))
            .background(OrbisPalette(scheme).base.ignoresSafeArea()).tint(accent).environment(\.orbisAccent, accent)
            .downloadFlightHost(downloadFlight).messageSendFlightHost(sendFlight)
            .environment(\.chatVisualActivity, model.visualActivity)
            .onChange(of: visualActive, initial: true) { _, active in
                model.visibilityChanged(target: target, token: mountToken, visible: active, foreground: scenePhase == .active)
            }
            .onChange(of: pageActivity.isTop) { _, isTop in
                let preview = actions.connection.transfers.browserPreview
                if !isTop, preview.current?.fullScreen != true { preview.close() }
            }
            .onChange(of: scenePhase) { _, phase in
                if phase != .active { actions.connection.transfers.browserPreview.close() }
                model.visibilityChanged(target: target, token: mountToken, visible: visualActive, foreground: phase == .active)
            }
            .modifier(ChatTurnReviewRegion(model: model, actions: actions))
            .onChange(of: target, initial: true) { _, _ in reconcileInterest() }
            .onChange(of: pageActivity.hasArrived, initial: true) { _, _ in reconcileInterest() }
            .modifier(ChatPageDiagnostics(composerFocused: false,
                gitActive: pageActivity.pollsGit(sceneActive: scenePhase == .active),
                visualActive: visualActive, sendFlight: sendFlight))
            .onAppear { model.mount(target: target, token: mountToken, visible: visualActive, foreground: scenePhase == .active) }
            .onDisappear {
                actions.connection.transfers.browserPreview.close()
                releaseInterest()
                model.unmount(target: target, token: mountToken)
            }
            .task(id: ChatGitPollKey(target: target, active: pageActivity.pollsGit(sceneActive: scenePhase == .active))) {
                guard !Task.isCancelled, pageActivity.pollsGit(sceneActive: scenePhase == .active), actions.isCurrent else { return }
                ChatDebugProbes.gitPolling()
                actions.refreshWorkingBranch()
                while !Task.isCancelled {
                    do { try await Task.sleep(for: gitPollInterval) } catch { return }
                    guard !Task.isCancelled, actions.isCurrent else { return }
                    actions.refreshWorkingBranch()
                }
            }
    }

    private var gitPollInterval: Duration { ChatDebugProbes.gitPollInterval }

    private func readingDivision(_ geometry: GeometryProxy) -> CGRect? {
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

    private func reconcileInterest() {
        if let interest, interest.target != target { releaseInterest() }
        guard interest == nil, pageActivity.hasArrived, actions.isCurrent, let lease = actions.acquireInterest() else { return }
        interest = ChatInterestOwnership(actions: actions, lease: lease)
        ChatDebugProbes.interestAcquired()
    }

    private func releaseInterest() {
        guard let held = interest else { return }
        held.actions.releaseInterest(held.lease)
        interest = nil
        ChatDebugProbes.interestReleased()
    }
}

/// FOLD-04: one layout keeps the transcript, editor and header identities stable.
/// The keyboard's safe-area resize is already reflected in the proposed height.
private struct ChatPageLayout: Layout {
    let division: CGRect?
    let editing: Bool

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        proposal.replacingUnspecifiedDimensions()
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        guard subviews.count == 4 else { return }
        let measure = ProposedViewSize(width: bounds.width, height: nil)
        let headerHeight = subviews[0].sizeThatFits(measure).height
        let composerHeight = subviews[2].sizeThatFits(measure).height
        let frames: [CGRect]
        if let division {
            let geometry = FoldReadingGeometry(size: bounds.size, division: division, headerHeight: headerHeight,
                composerHeight: composerHeight, editing: editing)
            frames = [geometry.header, geometry.transcript, geometry.composer, geometry.surface]
        } else {
            let composerY = max(headerHeight, bounds.height - composerHeight)
            frames = [CGRect(x: 0, y: 0, width: bounds.width, height: headerHeight),
                      CGRect(x: 0, y: headerHeight, width: bounds.width, height: max(0, composerY - headerHeight)),
                      CGRect(x: 0, y: composerY, width: bounds.width, height: composerHeight), .zero]
        }
        for (index, frame) in frames.enumerated() {
            // Hidden controls remain mounted, outside the clipped layout surface.
            let origin = frame.height > 0 ? frame.origin : CGPoint(x: 0, y: bounds.height + 1000)
            subviews[index].place(at: CGPoint(x: bounds.minX + origin.x, y: bounds.minY + origin.y),
                                  anchor: .topLeading, proposal: ProposedViewSize(frame.size))
        }
    }
}

private struct FoldReadingSurface: UIViewRepresentable {
    let model: ChatScreenModel
    let actions: ChatSessionActions
    let mountToken: UUID
    let enabled: Bool
    let viewportHeight: CGFloat
    private var viewport: ChatViewportController { model.viewport }

    func makeUIView(context: Context) -> FoldReadingSurfaceView { FoldReadingSurfaceView() }

    func updateUIView(_ view: FoldReadingSurfaceView, context: Context) {
        view.configure(channel: viewport.readingSurface, enabled: enabled,
                       isCurrent: { model.ownsMount(target: actions.target, token: mountToken) })
        view.accessibilityLabel = L10n.tr("阅读操作区")
        view.onPage = { earlier in
            guard enabled, model.ownsMount(target: actions.target, token: mountToken) else { return false }
            viewport.update { $0.turnPage(towardEarlier: earlier, viewportHeight: viewportHeight,
                                         bottomDistance: viewport.bottomDistance) }
            return true
        }
        view.accessibilityCustomActions = [UIAccessibilityCustomAction(name: L10n.tr("回到最新消息")) { _ in
            guard enabled, model.ownsMount(target: actions.target, token: mountToken) else { return false }
            viewport.update { $0.jumpToLatest() }
            return true
        }]
    }

    static func dismantleUIView(_ view: FoldReadingSurfaceView, coordinator: ()) { view.cancel() }
}

/// The empty scroll view supplies UIKit's drag and deceleration, but only the
/// transcript writes its real offset. A stationary grip has no action or tap target.
private final class FoldReadingSurfaceView: UIScrollView, UIScrollViewDelegate {
    private var channel: ChatReadingSurface?
    private var gesture: UUID?
    private var previousOffset: CGFloat = 0
    private var isCurrent: () -> Bool = { false }
    var onPage: (Bool) -> Bool = { _ in false }

    init() {
        super.init(frame: .zero)
        backgroundColor = .clear
        contentInsetAdjustmentBehavior = .never
        showsVerticalScrollIndicator = false
        showsHorizontalScrollIndicator = false
        bounces = false
        scrollsToTop = false
        isDirectionalLockEnabled = true
        panGestureRecognizer.maximumNumberOfTouches = 1
        panGestureRecognizer.addTarget(self, action: #selector(panStateChanged))
        delegate = self
        isAccessibilityElement = true
        accessibilityTraits = .adjustable
        accessibilityIdentifier = "fold-reading-surface"
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    func configure(channel: ChatReadingSurface, enabled: Bool, isCurrent: @escaping () -> Bool) {
        if self.channel !== channel || !enabled { cancel() }
        self.channel = channel
        self.isCurrent = isCurrent
        isScrollEnabled = enabled
        isAccessibilityElement = enabled && bounds.height >= 44
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        isAccessibilityElement = isScrollEnabled && bounds.height >= 44
        if bounds.height < 44 { cancel() }
        // A symmetric native runway lets either thumb direction use the same
        // inertia at every transcript position; idle gestures re-centre invisibly.
        let runway = CGSize(width: bounds.width, height: bounds.height + 2_000_000)
        if contentSize != runway {
            cancel()
            contentSize = runway
            recenter()
        }
    }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        if window == nil { cancel() }
    }

    override func gestureRecognizerShouldBegin(_ recognizer: UIGestureRecognizer) -> Bool {
        if recognizer === panGestureRecognizer {
            let velocity = panGestureRecognizer.velocity(in: self)
            guard isScrollEnabled, bounds.height >= 44, isCurrent(), abs(velocity.y) > abs(velocity.x) else { return false }
        }
        return super.gestureRecognizerShouldBegin(recognizer)
    }

    func scrollViewWillBeginDragging(_ scrollView: UIScrollView) {
        finish()
        previousOffset = contentOffset.y
        gesture = channel?.begin { [weak self] in self?.stopMotion() }
        if gesture == nil { stopMotion() }
    }

    @objc private func panStateChanged() {
        if panGestureRecognizer.state == .cancelled || panGestureRecognizer.state == .failed { cancel() }
    }

    func scrollViewDidScroll(_ scrollView: UIScrollView) {
        let delta = contentOffset.y - previousOffset
        previousOffset = contentOffset.y
        guard let gesture else { return }
        guard isCurrent() else { cancel(); return }
        channel?.move(gesture, by: delta)
    }

    func scrollViewDidEndDragging(_ scrollView: UIScrollView, willDecelerate decelerate: Bool) {
        if let gesture { channel?.release(gesture) }
        if !decelerate { finish(); recenter() }
    }

    func scrollViewDidEndDecelerating(_ scrollView: UIScrollView) {
        guard panGestureRecognizer.state != .began && panGestureRecognizer.state != .changed else { return }
        finish()
        recenter()
    }

    private func finish() {
        guard let gesture else { return }
        self.gesture = nil
        channel?.end(gesture)
    }

    func cancel() {
        guard let gesture else { return }
        channel?.cancel(gesture)
    }

    private func stopMotion() {
        gesture = nil
        // Cancel both a held pan and its inertia before a keyboard, posture or
        // transcript-owner change. No delayed event can revive the old gesture.
        panGestureRecognizer.isEnabled = false
        setContentOffset(contentOffset, animated: false)
        panGestureRecognizer.isEnabled = isScrollEnabled
    }

    private func recenter() {
        guard gesture == nil, !isTracking, !isDragging, !isDecelerating else { return }
        setContentOffset(CGPoint(x: 0, y: 1_000_000), animated: false)
        previousOffset = contentOffset.y
    }

    override func accessibilityIncrement() { _ = onPage(false) }
    override func accessibilityDecrement() { _ = onPage(true) }
    override func accessibilityScroll(_ direction: UIAccessibilityScrollDirection) -> Bool {
        guard direction == .up || direction == .down else { return false }
        return onPage(direction == .up)
    }
}

private struct ChatComposerFocusRegion: ViewModifier {
    let focus: ChatComposerFocus
    let actions: ChatSessionActions
    func body(content: Content) -> some View {
        content
            .modifier(ChatKeyboardResizeProbe(focused: focus.focused))
            .onChange(of: focus.focused) { _, focused in if actions.isCurrent { actions.noteComposerFocus(focused) } }
            .onAppear { if actions.isCurrent, actions.takeComposerFocus() { DispatchQueue.main.async { if actions.isCurrent { focus.focused = true } } } }
    }
}

private struct ChatTurnReviewRegion: ViewModifier {
    let model: ChatScreenModel
    let actions: ChatSessionActions
    func body(content: Content) -> some View {
        content.modifier(TurnFileReviewPresenter(changes: actions.connection.turnFileChanges,
            context: actions.reading(model.canReadTranscript)))
    }
}
