import SwiftUI
import Combine

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
         acceptedSends: PassthroughSubject<Set<String>, Never>, onBack: @escaping () -> Void) {
        let mount = ChatTranscriptMount(model: model, actions: actions, mountToken: mountToken,
            setComposerFocused: setComposerFocused, sendFlight: sendFlight,
            acceptedSends: acceptedSends, onBack: onBack)
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
    let onBack: () -> Void
    let onHistory: () -> Void
    let onDownloads: () -> Void
    @State private var sendFlight = MessageSendFlight()
    @State private var downloadFlight = DownloadFlight()
    @State private var acceptedSends = PassthroughSubject<Set<String>, Never>()
    @State private var interest: ChatInterestOwnership?
    @State private var mountToken = UUID()
    @FocusState private var composerFocused: Bool
    private var accent: Color { OrbisPalette(scheme).agent(model.shell.kind) }

    init?(model: ChatScreenModel, onBack: @escaping () -> Void, onHistory: @escaping () -> Void, onDownloads: @escaping () -> Void) {
        let actions = model.actions
        guard let runtime = actions.runtime else { return nil }
        self.model = model; self.actions = actions; fallbackRuntime = runtime
        self.onBack = onBack; self.onHistory = onHistory; self.onDownloads = onDownloads
    }
    var body: some View {
        let _ = ChatSchedulingTrace.regionBody(.page)
        let _ = ChatDebugProbes.rendered(.page)
        VStack(spacing: 0) {
            ChatHeaderView(model: model, actions: actions, fallbackRuntime: fallbackRuntime,
                           composerFocused: $composerFocused, downloadFlight: downloadFlight,
                           onBack: onBack, onHistory: onHistory, onDownloads: onDownloads).equatable()
            ChatTranscriptRegion(model: model, actions: actions, mountToken: mountToken,
                                 setComposerFocused: { composerFocused = $0 }, sendFlight: sendFlight,
                                 acceptedSends: acceptedSends, onBack: onBack).id(mountToken)
            ChatComposerView(model: model, actions: actions, fallbackRuntime: fallbackRuntime,
                             composerFocused: $composerFocused, sendFlight: sendFlight, onHistory: onHistory,
                             onAcceptedSend: { acceptedSends.send($0) }).equatable()
                .anchorPreference(key: FeedbackComposerAnchorKey.self, value: .bounds) { $0 }
        }.frame(maxWidth: 720).frame(maxWidth: .infinity, maxHeight: .infinity)
            .modifier(ChatKeyboardResizeProbe(focused: composerFocused))
            .background(OrbisPalette(scheme).base.ignoresSafeArea()).tint(accent).environment(\.orbisAccent, accent)
            .downloadFlightHost(downloadFlight).messageSendFlightHost(sendFlight)
            .environment(\.chatVisualActivity, model.visualActivity)
            .onChange(of: visualActive, initial: true) { _, active in
                model.visibilityChanged(target: target, token: mountToken, visible: active, foreground: scenePhase == .active)
            }
            .onChange(of: scenePhase) { _, phase in
                model.visibilityChanged(target: target, token: mountToken, visible: visualActive, foreground: phase == .active)
            }
            .onChange(of: composerFocused) { _, focused in if actions.isCurrent { actions.noteComposerFocus(focused) } }
            .onAppear { if actions.isCurrent, actions.takeComposerFocus() { DispatchQueue.main.async { if actions.isCurrent { composerFocused = true } } } }
            .modifier(ChatTurnReviewRegion(model: model, actions: actions))
            .onChange(of: target, initial: true) { _, _ in reconcileInterest() }
            .onChange(of: pageActivity.hasArrived, initial: true) { _, _ in reconcileInterest() }
            .modifier(ChatPageDiagnostics(composerFocused: composerFocused,
                gitActive: pageActivity.pollsGit(sceneActive: scenePhase == .active),
                visualActive: visualActive, sendFlight: sendFlight))
            .onAppear { model.mount(target: target, token: mountToken, visible: visualActive, foreground: scenePhase == .active) }
            .onDisappear {
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

private struct ChatTurnReviewRegion: ViewModifier {
    let model: ChatScreenModel
    let actions: ChatSessionActions
    func body(content: Content) -> some View {
        content.modifier(TurnFileReviewPresenter(changes: actions.connection.turnFileChanges,
            context: actions.reading(model.canReadTranscript)))
    }
}
