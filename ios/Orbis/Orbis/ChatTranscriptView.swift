import SwiftUI
import Combine
import UIKit

/// Bottom edge of the transcript in the viewport, or nil while the lazy stack has released it.
private struct ChatBottomPreference: PreferenceKey {
    static var defaultValue: CGFloat? = nil
    static func reduce(value: inout CGFloat?, nextValue: () -> CGFloat?) { value = nextValue() ?? value }
}

private final class ChatViewportMetrics {
    var reports = ChatViewportReports()
}

private final class ChatRowViewportMetrics {
    let token = UUID()
    var facts = ChatViewportFacts()
    var appeared = false
}

/// Do not propagate every scroll pixel through the preference tree. Geometry
/// stays local to the row; only crossing a visibility/paging boundary publishes.
private struct ChatRowViewportObserver: ViewModifier {
    let viewportHeight: CGFloat
    var firstRow = false
    var questionID: String?
    let report: (UUID, ChatViewportFacts?) -> Void
    @State private var metrics = ChatRowViewportMetrics()

    func body(content: Content) -> some View {
        content
            .onGeometryChange(for: ChatViewportFacts.self) { geometry in
                ChatViewportFacts(frame: geometry.frame(in: .named("chat-viewport")),
                                  viewportHeight: viewportHeight, firstRow: firstRow, questionID: questionID)
            } action: { facts in
                metrics.facts = facts
                if metrics.appeared { report(metrics.token, facts) }
            }
            .onAppear { metrics.appeared = true; report(metrics.token, metrics.facts) }
            .onDisappear { metrics.appeared = false; report(metrics.token, nil) }
    }
}

private struct ChatReadingInteractionKey: EnvironmentKey {
    static let defaultValue: () -> Void = {}
}

extension EnvironmentValues {
    var chatReadingInteraction: () -> Void {
        get { self[ChatReadingInteractionKey.self] }
        set { self[ChatReadingInteractionKey.self] = newValue }
    }
}

/// The transcript has exactly one viewport policy: within one line of the bottom it follows
/// new content, dragging or opening a disclosure stops following, and past three lines a jump-to-latest
/// button appears. Nothing else moves the viewport on the reader's behalf.
private enum ChatFollow {
    static let bottomID = "chat-bottom"
    static let topPadding: CGFloat = 4
}

private struct ChatNativeMessageInputs: Equatable {
    let revision: UUID
    let kind: String?
    let toolResults: [String: ChatMessage]
    let timings: [SessionTurnTiming]
    let changeAnchors: Set<String>
    let streaming: Set<String>
    let rewind: RuntimeOption?
    let rewindEnabled: Bool
    let pending: PendingSend.State?
    let submissionConfirmed: Bool
    let uploads: [FileTransfer]
    let context: ChatReadContext
    let changes: ObjectIdentifier
    let canSend: Bool
}

private struct ChatNativeSnapshotInputs: Equatable {
    let revision: UInt64
    let environment: ChatNativeTranscriptEnvironment.ReconfigurationKey
    let hasLiveTools: Bool
    let emptyHeight: CGFloat?
}

private struct ChatNativeHeaderInputs: Equatable {
    let context: ChatReadContext
    let syncing: Bool
    let cached: Bool
    let loading: Bool
    let error: String?
    let hasOlder: Bool
}

private enum ChatNativeItemInputs: Equatable {
    case message(ChatNativeMessageInputs)
    case header(ChatNativeHeaderInputs)
    case empty(syncing: Bool, height: CGFloat)
    case tools(ChatReadContext)
    case tail
}

private struct ChatNativeRowInputs: Equatable {
    let content: ChatNativeItemInputs
    let environment: ChatNativeTranscriptEnvironment.ReconfigurationKey
}

/// The idle inventory contributes no row or spacing. Keep its ObservableObject
/// subscription at this leaf, matching LiveToolsView's existing empty branch.
private struct ChatNativeInventoryReader<Content: View>: View {
    let inventory: ToolInventories
    let runtimeID: String
    @ViewBuilder let content: (Bool) -> Content
    @State private var hasLiveTools: Bool

    init(inventory: ToolInventories, runtimeID: String, @ViewBuilder content: @escaping (Bool) -> Content) {
        self.inventory = inventory; self.runtimeID = runtimeID; self.content = content
        _hasLiveTools = State(initialValue: inventory.loading.contains(runtimeID) || inventory.errors[runtimeID] != nil)
    }

    var body: some View {
        content(hasLiveTools)
            .onReceive(inventory.objectWillChange) { _ in
                // Published fires before mutation. Only the row-presence projection
                // invalidates this builder; LiveToolsView owns its content updates.
                DispatchQueue.main.async {
                    let next = inventory.loading.contains(runtimeID) || inventory.errors[runtimeID] != nil
                    if hasLiveTools != next { hasLiveTools = next }
                }
            }
    }
}

struct ChatTranscriptView: View, Equatable {
    let mount: ChatTranscriptMount
    private var model: ChatScreenModel { mount.model }
    private var actions: ChatSessionActions { mount.actions }
    private var mountToken: UUID { mount.mountToken }
    private var ownsViewport: Bool { model.ownsMount(target: actions.target, token: mountToken) }
    private var target: ChatActionContext { actions.target }
    @Environment(\.colorScheme) private var scheme
    @Environment(\.orbisReduceMotion) private var reduceMotion
    // Focus is an action here, not transcript state. A FocusState.Binding would
    // invalidate the ForEach owner when a covered page changes its focus scope.
    private var setComposerFocused: (Bool) -> Void { mount.setComposerFocused }
    private var sendFlight: MessageSendFlight { mount.sendFlight }
    private var acceptedSends: PassthroughSubject<Set<String>, Never> { mount.acceptedSends }
    private var onBack: () -> Void { mount.onBack }
    @State private var metrics = ChatViewportMetrics()
    @State private var historyHeader = ChatHistoryHeaderVisibility()
    @State private var nativeInteractions = ChatTranscriptInteractionState()
    @State private var nativeSnapshots = ChatTranscriptSnapshotCache<ChatNativeSnapshotInputs, ChatNativeTranscriptView.Snapshot>()
    @State private var nativeItems = ChatTranscriptItemCache<ChatNativeRowInputs, ChatNativeTranscriptView.Item>()
    private var viewport: ChatViewportController { model.viewport }
    private var facts: ChatTranscriptState { model.transcript }
    static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.mount == rhs.mount
    }
    var body: some View {
        // The region owns this observation. Capture state and its cache revision
        // together before deferred geometry/environment builders run.
        let state = facts
        let revision = model.transcriptInputRevision
        let _ = ChatSchedulingTrace.regionBody(.transcript)
        let _ = ChatDebugProbes.rendered(.transcript)
        conversation(state: state, revision: revision).overlay(alignment: .top) {
            ChatNoticesRegion(model: model, actions: actions, mountToken: mountToken, viewport: viewport,
                historyHeader: historyHeader,
                setComposerFocused: setComposerFocused, onBack: onBack).equatable()
        }
        .onReceive(acceptedSends) { beginSendFeedback(existing: $0) }
        .onDisappear {
            // Cached callbacks may retain row state. Retire them after the shell
            // unmounts; a covered retained page still owns its mount and cache.
            let cache = nativeItems, snapshots = nativeSnapshots, model = model, target = target, token = mountToken
            DispatchQueue.main.async {
                if !model.ownsMount(target: target, token: token) { cache.removeAll(); snapshots.removeAll() }
            }
        }
    }

    private func conversation(state: ChatTranscriptState, revision: UInt64) -> some View {
        GeometryReader { geometry in
            Group {
                if #available(iOS 18.0, *) {
                    #if DEBUG
                    if ProcessInfo.processInfo.arguments.contains("--preview-swiftui-transcript") {
                        swiftUITranscript(height: geometry.size.height, state: state)
                    } else { nativeTranscript(height: geometry.size.height, state: state, revision: revision) }
                    #else
                    nativeTranscript(height: geometry.size.height, state: state, revision: revision)
                    #endif
                } else {
                    swiftUITranscript(height: geometry.size.height, state: state)
                }
            }
            .orbisAnchor(sendFlight.viewport)
            .overlay(alignment: .bottomTrailing) {
                ChatJumpToLatestView(viewport: viewport, hasRows: !state.transcript.rows.isEmpty,
                    accent: OrbisPalette(scheme).agent(state.kind), jump: jumpToLatest)
            }
            .overlay(alignment: .bottom) { ChatActionFeedbackView(feedback: state.actionFeedback) }
            .onChange(of: state.historyRevision) { _, _ in
                sendFlight.clear()
                nativeInteractions.reset()
            }
        }
    }

    /// Release compatibility path on iOS 17; DEBUG comparison path on newer OSes.
    private func swiftUITranscript(height: CGFloat, state: ChatTranscriptState) -> some View {
        let transcript = state.transcript
        let questionID = transcript.latestQuestion(excluding: Set(state.pending.items.map(\.messageId)))?.messageId
        let readContext = actions.reading(state.canSend)
        let streaming = activeStreaming(state)
        return ScrollView {
            LazyVStack(alignment: .leading, spacing: 16) {
                transcriptHeader(state: state).id("chat-header")
                    .onGeometryChange(for: Bool.self) { geometry in
                        let frame = geometry.frame(in: .named("chat-viewport"))
                        return frame.maxY > 0 && frame.minY < height
                    } action: { visible in if ownsViewport { historyHeader.visible = visible } }
                if transcript.rows.isEmpty {
                    OrbisEmptyState(symbol: "bubble.left.and.bubble.right", title: state.syncing ? L10n.tr("正在加载会话") : L10n.tr("继续这段会话"))
                        .frame(minHeight: max(180, height - 100))
                }
                ForEach(transcript.rows) { row in
                    messageRow(row, state: state, inputs: messageInputs(row, state: state, context: readContext, streaming: streaming)).equatable().id(row.id)
                        .modifier(ChatRowViewportObserver(viewportHeight: height,
                            firstRow: row.id == transcript.firstMessageId,
                            questionID: row.id == questionID ? questionID : nil, report: rowViewportChanged))
                }
                LiveToolsView(inventory: target.owner.toolInventories, runtimeId: actions.runtimeId, context: readContext).id("chat-live-tools")
                    .modifier(ChatRowViewportObserver(viewportHeight: height, report: rowViewportChanged))
                // Small tail: the last message sits close to the composer (LazyVStack spacing still applies).
                Color.clear.frame(height: 4).id(ChatFollow.bottomID)
                    .background(GeometryReader { geo in Color.clear.preference(key: ChatBottomPreference.self, value: geo.frame(in: .named("chat-viewport")).maxY) })
            }.scrollTargetLayout()
                .padding(.horizontal, 16).padding(.top, ChatFollow.topPadding)
                .background(OrbisScrollDirectionObserver { earlier in
                    guard ownsViewport else { return }
                    self.viewport.update { $0.directionChanged(towardEarlier: earlier) }
                })
                .background {
                    if #unavailable(iOS 18.0) { LegacyScrollInteraction(onInteraction: userInteractionChanged) }
                }
        }.coordinateSpace(name: "chat-viewport").scrollDismissesKeyboard(.interactively)
            .modifier(ChatScrollObserver(viewportHeight: height, controller: self.viewport, mountToken: mountToken,
                requestIsCurrent: { ownsViewport && self.viewport.owns($0) },
                onDistance: bottomDistanceChanged, onInteraction: userInteractionChanged,
                onReading: { if ownsViewport { self.viewport.disclosureBegan() } }))
            .task(id: mountToken) {
                // Child geometry can arrive before the page shell mounts and
                // resets policy. Replay the latest discrete facts after that reset.
                await Task.yield()
                guard !Task.isCancelled, ownsViewport else { return }
                if self.viewport.viewportChanged(metrics.reports.snapshot(questionID: self.viewport.latestQuestion?.messageId)) { loadOlder() }
            }
    }

    private func activeStreaming(_ state: ChatTranscriptState) -> Set<String> {
        state.connection == .secured && !state.syncing && !state.cached ? state.streaming : []
    }

    private func messageInputs(_ row: ChatRow, state: ChatTranscriptState,
                               context: ChatReadContext, streaming: Set<String>) -> ChatNativeMessageInputs {
        let transcript = state.transcript
        let pending = row.isUser ? state.pending.item(row.messages.first?.messageId) : nil
        return ChatNativeMessageInputs(revision: row.contentRevision, kind: state.kind,
            toolResults: transcript.toolResultsByRow[row.id] ?? [:], timings: transcript.timingsByRow[row.id] ?? [],
            changeAnchors: transcript.changeAnchorsByRow[row.id] ?? [],
            streaming: streaming.isEmpty ? [] : streaming.intersection(row.messages.map(\.messageId)),
            rewind: row.isUser ? state.rewind[row.id] : nil,
            rewindEnabled: row.isUser && state.canSend && state.status == "idle" && state.pendingActions.isEmpty,
            pending: pending?.state, submissionConfirmed: pending?.submissionConfirmed ?? false,
            uploads: row.isUser ? pendingUploads(row.messages.first?.messageId, state: state) : [],
            context: context, changes: ObjectIdentifier(target.owner.turnFileChanges), canSend: row.isUser && state.canSend)
    }

    private func messageRow(_ row: ChatRow, state: ChatTranscriptState, inputs: ChatNativeMessageInputs) -> ChatMessageRow {
        ChatMessageRow(row: row, kind: inputs.kind, toolResults: inputs.toolResults,
            toolText: state.transcript.toolTextByRow[row.id] ?? [:], timings: inputs.timings,
            changes: target.owner.turnFileChanges, readContext: inputs.context,
            changeAnchors: inputs.changeAnchors, streamingMessageIds: inputs.streaming, replyArrivals: viewport.arrivals,
            rewindOption: inputs.rewind, rewindEnabled: inputs.rewindEnabled,
            pending: inputs.pending, submissionConfirmed: inputs.submissionConfirmed,
            uploads: inputs.uploads, canResend: inputs.canSend,
            onRewind: { option in
                if actions.isCurrent, actions.moveHistory(to: option, fallbackText: row.messages.first?.text) {
                    LiveActivityCoordinator.shared.cancelQueuedOpen()
                    setComposerFocused(false)
                    OrbisHaptics.commit()
                }
            }, onPending: { pendingAction($0, messageId: row.messages.first?.messageId) })
    }

    private func nativeItem<Content: View>(id: String, inputs: ChatNativeItemInputs,
        environment: ChatNativeTranscriptEnvironment, kind: ChatNativeTranscriptView.Item.Kind = .auxiliary,
        @ViewBuilder content: () -> Content) -> ChatNativeTranscriptView.Item {
        nativeItems.item(id: id, inputs: .init(content: inputs, environment: environment.reconfigurationKey)) {
            ChatDebugProbes.nativeContentBuilt(message: kind == .message)
            return .init(id: id, revision: UUID(),
                content: AnyView(environment.applying(content())), kind: kind)
        }
    }

    private func nativeTranscript(height: CGFloat, state: ChatTranscriptState, revision: UInt64) -> some View {
        ChatNativeInventoryReader(inventory: target.owner.toolInventories, runtimeID: actions.runtimeId) { hasLiveTools in
        ChatNativeTranscriptEnvironmentReader { environment in
            let transcript = state.transcript
            let snapshotKey = ChatNativeSnapshotInputs(revision: revision,
                environment: environment.reconfigurationKey, hasLiveTools: hasLiveTools,
                emptyHeight: transcript.rows.isEmpty ? height : nil)
            ChatNativeTranscriptView(snapshot: {
                nativeSnapshots.snapshot(key: snapshotKey) {
                    ChatDebugProbes.nativeInputsCompared(rows: transcript.rows.count)
                    let trace = ChatSchedulingTrace.nativeInputsBegan()
                    defer { ChatSchedulingTrace.nativeInputsEnded(trace, rows: transcript.rows.count) }
                    let context = actions.reading(state.canSend)
                    let header = nativeItem(id: "chat-header", inputs: .header(.init(context: context,
                        syncing: state.syncing, cached: state.cached, loading: state.historyLoading,
                        error: state.historyError, hasOlder: state.hasOlder)), environment: environment) { transcriptHeader(state: state) }
                    let streaming = activeStreaming(state)
                    let rows = transcript.rows.map { row in
                        let inputs = messageInputs(row, state: state, context: context, streaming: streaming)
                        return nativeItem(id: row.id, inputs: .message(inputs), environment: environment, kind: .message) {
                            messageRow(row, state: state, inputs: inputs).equatable()
                        }
                    }
                    let empty: [ChatNativeTranscriptView.Item] = transcript.rows.isEmpty ? [
                        nativeItem(id: "chat-empty", inputs: .empty(syncing: state.syncing, height: height), environment: environment) {
                            OrbisEmptyState(symbol: "bubble.left.and.bubble.right",
                                title: state.syncing ? L10n.tr("正在加载会话") : L10n.tr("继续这段会话"))
                                .frame(minHeight: max(180, height - 100))
                        }
                    ] : []
                    let live = hasLiveTools ? [nativeItem(id: "chat-live-tools", inputs: .tools(context), environment: environment) {
                        LiveToolsView(inventory: target.owner.toolInventories, runtimeId: actions.runtimeId, context: context)
                    }] : []
                    let tail = nativeItem(id: ChatFollow.bottomID, inputs: .tail, environment: environment) { Color.clear.frame(height: 4) }
                    let items = [header] + empty + rows + live + [tail]
                    let _ = nativeItems.retain(ids: items.map(\.id))
                    return .init(items: items, revision: nativeItems.revision)
                }
            },
                prepareMount: { model.prepareMount(target: target, token: mountToken) },
                viewport: viewport, tailID: ChatFollow.bottomID, mountToken: mountToken,
                requestIsCurrent: { ownsViewport && viewport.owns($0) }, onDistance: bottomDistanceChanged,
                onInteraction: { active in
                    userInteractionChanged(active)
                    if !active { ChatDebugProbes.viewportStopped(viewport) }
                }, onViewport: { frames, height in
                    guard ownsViewport else { return }
                    historyHeader.visible = frames["chat-header"].map { $0.maxY > 0 && $0.minY < height } ?? false
                    var facts = ChatViewportFacts()
                    let question = viewport.latestQuestion?.messageId
                    for (id, frame) in frames where id != "chat-header" {
                        facts.merge(ChatViewportFacts(frame: frame, viewportHeight: height,
                            firstRow: id == transcript.firstMessageId, questionID: id == question ? question : nil))
                    }
                    if viewport.viewportChanged(facts) { loadOlder() }
                }, onDirection: { earlier in
                    guard ownsViewport else { return }
                    viewport.update { $0.directionChanged(towardEarlier: earlier) }
                }, reduceMotion: reduceMotion)
        }
        }
        .background { ChatTranscriptInteractionHost(state: nativeInteractions) }
        .modifier(ChatAboveViewportDisclosureProbe(interactions: nativeInteractions, viewport: viewport))
        .environment(\.chatTranscriptInteractionState, nativeInteractions)
        .environment(\.chatReadingInteraction) {
            if ownsViewport {
                viewport.disclosureBegan()
                ChatDebugProbes.beginScroll(flight: sendFlight)
            }
        }
        .onChange(of: revision, initial: true) { _, _ in
            nativeInteractions.reconcile(rowIDs: Set(state.transcript.rows.map(\.id)))
        }
    }

    /// One row above the transcript. Its height never changes: an error replaces the
    /// paging action in place instead of adding a line.
    private func transcriptHeader(state: ChatTranscriptState) -> some View {
        let p = OrbisPalette(scheme)
        let accent = p.agent(state.kind)
        let error = state.historyError
        let loading = state.historyLoading
        let blocked = state.syncing || (!state.canSend && !state.cached) || loading
        return HStack(spacing: 10) {
            if let error {
                Text(error).font(.orbisCaption()).foregroundStyle(p.error).lineLimit(1)
                Spacer(minLength: 0)
                OrbisTextButton(title: L10n.tr("重试"), symbol: "arrow.up", tint: accent, loading: loading) { loadOlder() }.disabled(blocked)
                    .accessibilityIdentifier("chat-history-older")
            } else if state.hasOlder {
                OrbisTextButton(title: L10n.tr("更早的消息"), symbol: "arrow.up", tint: accent, loading: loading) { loadOlder() }.disabled(blocked)
                    .accessibilityIdentifier("chat-history-older")
                Spacer(minLength: 0)
            } else {
                Spacer(minLength: 0)
            }
        }.frame(minHeight: 48)
    }

    // Scrolling from a geometry callback re-enters lazy layout while a disclosure changes height.
    // Observe here; native anchors handle size changes and an actual scroll ending resumes following.
    private func bottomDistanceChanged(_ distance: CGFloat) {
        guard ownsViewport else { return }
        viewport.distanceChanged(distance)
    }

    private func userInteractionChanged(_ active: Bool) {
        guard ownsViewport else { return }
        viewport.interactionChanged(active)
    }

    private func rowViewportChanged(_ token: UUID, _ facts: ChatViewportFacts?) {
        metrics.reports.update(token, facts: facts)
        guard ownsViewport else { return }
        if self.viewport.viewportChanged(metrics.reports.snapshot(questionID: self.viewport.latestQuestion?.messageId)) { loadOlder() }
    }

    private func jumpToLatest() {
        guard ownsViewport else { return }
        ChatDebugProbes.beginScroll(flight: sendFlight)
        self.viewport.update { $0.jumpToLatest() }
    }

    private func loadOlder() {
        // The native scroll position owns the reading anchor; this only gates paging.
        if ownsViewport, actions.loadOlderHistory() {
            self.viewport.update { $0.olderPageAccepted(bottomDistance: self.viewport.bottomDistance) }
        }
    }

    private func pendingAction(_ action: PendingSendAction, messageId: String?) {
        guard actions.isCurrent, let messageId else { return }
        switch action {
        case .resend:
            let existing = Set(actions.pendingSends.items.map(\.messageId))
            if actions.resendPendingSend(messageId) { OrbisHaptics.commit(); beginSendFeedback(existing: existing) }
        case .restore:
            guard let text = actions.restorePendingSend(messageId) else { return }
            let draft = actions.draft
            // The editor owns its local text; external restores use the existing revision channel.
            actions.saveDraft(draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? text : draft + "\n" + text)
            setComposerFocused(true)
        case .discard: actions.discardPendingSend(messageId)
        case .check: actions.refresh()
        case .cancel: _ = actions.cancelQueuedMessage(messageId)
        }
    }

    /// 本地待发送消息的附件，按发送时的顺序；上传任务已被清理的不显示。
    private func pendingUploads(_ messageId: String?, state: ChatTranscriptState) -> [FileTransfer] {
        guard let ids = state.pending.item(messageId)?.uploadIds, !ids.isEmpty else { return [] }
        let tasks = state.uploads
        return ids.compactMap { id in tasks.first { $0.id == id } }
    }
    private func beginSendFeedback(existing: Set<String>) {
        guard model.visualActivity.active, ownsViewport else { return }
        // No text/time/index heuristic: one synchronous accepted submit creates one new App identity.
        let created = actions.pendingSends.items.filter { !existing.contains($0.messageId) && $0.sessionId == actions.sessionId }
        guard created.count == 1, let send = created.first else { return }
        sendFlight.launch(send, following: self.viewport.following, reduceMotion: reduceMotion)
    }

}

private final class ChatNativeReadingMetrics {
    var offset: CGFloat = 0
    var distance: CGFloat = .infinity
}

private struct ChatNativeScrollFacts: Equatable {
    let offset: CGFloat
    let distance: CGFloat
}

/// Reports how far the transcript sits from its bottom edge and when the reader's finger
/// starts or stops moving it. iOS 18 reads the scroll geometry and phase directly.
private struct ChatScrollObserver: ViewModifier {
    let viewportHeight: CGFloat
    let controller: ChatViewportController
    let mountToken: UUID
    private var following: Bool { controller.following }
    private var request: ChatViewportPolicy.Request? { controller.request }
    private var contextGeneration: Int { controller.contextGeneration }
    let requestIsCurrent: (ChatViewportPolicy.Request) -> Bool
    let onDistance: (CGFloat) -> Void
    let onInteraction: (Bool) -> Void
    let onReading: () -> Void
    @State private var readingRow: String?
    @State private var legacyMetrics = ChatNativeReadingMetrics()
    @Environment(\.orbisReduceMotion) private var reduceMotion

    func body(content: Content) -> some View {
        if #available(iOS 18.0, *) {
            content
                .modifier(ChatNativeScrollPosition(following: following, request: request,
                                                   contextGeneration: contextGeneration, mountToken: mountToken, requestIsCurrent: requestIsCurrent,
                                                   onDistance: onDistance, onInteraction: interactionChanged, onReading: onReading))
        } else {
            ScrollViewReader { proxy in content
                .environment(\.chatReadingInteraction, onReading)
                .scrollPosition(id: $readingRow)
                .defaultScrollAnchor(following ? .bottom : nil)
                .onChange(of: request) { _, request in
                    guard let request, requestIsCurrent(request) else { return }
                    withAnimation(reduceMotion ? nil : .smooth(duration: 0.3)) {
                        switch request.target {
                        case .latest: readingRow = ChatFollow.bottomID
                        case .question(let id): proxy.scrollTo(id, anchor: .top)
                        case .page: break // Fold controls require iOS 27.1; this is the iOS 17 fallback.
                        }
                    }
                }
                .onPreferenceChange(ChatBottomPreference.self) { bottom in
                    legacyMetrics.distance = bottom.map { max(0, $0 - viewportHeight) } ?? .infinity
                    onDistance(legacyMetrics.distance)
                }
                .task(id: mountToken) {
                    await Task.yield()
                    guard !Task.isCancelled else { return }
                    onDistance(legacyMetrics.distance)
                }
            }
        }
    }

    private func interactionChanged(_ active: Bool) {
        onInteraction(active)
        if !active { ChatDebugProbes.viewportStopped(controller) }
    }
}

/// The native position owns both user motion and layout anchoring. Target the stable
/// tail row when jumping; the lazy stack's estimated content edge can move mid-animation.
@available(iOS 18.0, *)
private struct ChatNativeScrollPosition: ViewModifier {
    let following: Bool
    let request: ChatViewportPolicy.Request?
    let contextGeneration: Int
    let mountToken: UUID
    let requestIsCurrent: (ChatViewportPolicy.Request) -> Bool
    let onDistance: (CGFloat) -> Void
    let onInteraction: (Bool) -> Void
    let onReading: () -> Void
    // Keep automatic view-identity tracking disabled. A retained tail ID makes
    // SwiftUI compensate a settled reading offset when that same row grows.
    @State private var position = ScrollPosition()
    @State private var metrics = ChatNativeReadingMetrics()
    @Environment(\.orbisReduceMotion) private var reduceMotion

    func body(content: Content) -> some View {
        positioned(content)
            .environment(\.chatReadingInteraction) {
                // A disclosure can expand before the parent publishes `following = false`.
                // Commit a point before the disclosure changes height. The target layout's
                // coordinate starts after the lazy stack's top padding.
                onReading()
                position.scrollTo(y: metrics.offset - ChatFollow.topPadding)
            }
            .defaultScrollAnchor(.bottom, for: .initialOffset)
            .defaultScrollAnchor(following ? .bottom : ChatDebugProbes.readingSizeChangeAnchor, for: .sizeChanges)
            .modifier(ChatNativeAnchorProbe(position: position, following: following))
            .onChange(of: request) { _, request in
                guard let request, requestIsCurrent(request) else { return }
                withAnimation(reduceMotion ? nil : .smooth(duration: 0.3)) {
                    switch request.target {
                    case .latest: position.scrollTo(id: ChatFollow.bottomID, anchor: .bottom)
                    case .question(let id): position.scrollTo(id: id, anchor: .top)
                    case .page(let delta): position.scrollTo(y: max(0, metrics.offset + delta - ChatFollow.topPadding))
                    }
                }
            }
            .onChange(of: contextGeneration) { _, _ in
                // The offset still describes this same native scroll view. Clearing it to
                // zero would corrupt the next synchronous freeze if layout did not change.
                position = ScrollPosition()
            }
            .onScrollGeometryChange(for: ChatNativeScrollFacts.self) { geometry in
                ChatNativeScrollFacts(offset: geometry.contentOffset.y,
                    distance: max(0, geometry.contentSize.height + geometry.contentInsets.bottom - geometry.visibleRect.maxY))
            } action: { _, facts in
                metrics.offset = facts.offset; metrics.distance = facts.distance
                onDistance(facts.distance)
            }
            .task(id: mountToken) {
                await Task.yield()
                guard !Task.isCancelled else { return }
                onDistance(metrics.distance)
            }
            .onScrollPhaseChange { previous, phase in
                switch phase {
                case .tracking, .interacting:
                    if previous != .tracking && previous != .interacting {
                        position.isPositionedByUser = true
                    }
                    onInteraction(true)
                case .idle: onInteraction(false)
                default: break
                }
            }
    }

    @ViewBuilder private func positioned(_ content: Content) -> some View {
        if ChatDebugProbes.unbindReadingPosition && !following { content }
        else { content.scrollPosition($position) }
    }

}

/// iOS 17 has no scroll-phase API. Observe its native pan through the end of deceleration;
/// ending the finger gesture alone would re-enable following while the list is still coasting.
private struct LegacyScrollInteraction: UIViewRepresentable {
    let onInteraction: (Bool) -> Void
    func makeCoordinator() -> Coordinator { Coordinator(onInteraction) }
    func makeUIView(context: Context) -> UIView {
        let view = UIView()
        view.isUserInteractionEnabled = false
        DispatchQueue.main.async { context.coordinator.attach(from: view) }
        return view
    }
    func updateUIView(_ view: UIView, context: Context) {
        context.coordinator.onInteraction = onInteraction
        DispatchQueue.main.async { context.coordinator.attach(from: view) }
    }
    static func dismantleUIView(_ view: UIView, coordinator: Coordinator) { coordinator.detach() }

    final class Coordinator: NSObject {
        var onInteraction: (Bool) -> Void
        weak var scroll: UIScrollView?
        var displayLink: CADisplayLink?
        init(_ onInteraction: @escaping (Bool) -> Void) { self.onInteraction = onInteraction }
        func attach(from view: UIView) {
            guard scroll == nil else { return }
            var ancestor = view.superview
            while let candidate = ancestor {
                if let found = candidate as? UIScrollView {
                    scroll = found
                    found.panGestureRecognizer.addTarget(self, action: #selector(panChanged))
                    return
                }
                ancestor = candidate.superview
            }
        }
        @objc func panChanged(_ pan: UIPanGestureRecognizer) {
            guard pan.state == .began || pan.state == .changed else { return }
            onInteraction(true)
            guard displayLink == nil else { return }
            let link = CADisplayLink(target: self, selector: #selector(tick))
            link.add(to: .main, forMode: .common)
            displayLink = link
        }
        @objc func tick() {
            guard let scroll else { detach(); return }
            if !scroll.isTracking && !scroll.isDragging && !scroll.isDecelerating {
                displayLink?.invalidate(); displayLink = nil
                onInteraction(false)
            }
        }
        func detach() {
            displayLink?.invalidate(); displayLink = nil
            scroll?.panGestureRecognizer.removeTarget(self, action: #selector(panChanged))
            scroll = nil
        }
    }
}

private struct ChatActionFeedbackView: View {
    let feedback: String?
    @Environment(\.colorScheme) private var scheme
    @Environment(\.orbisReduceMotion) private var reduced
    @Environment(\.chatVisualActivity) private var activity
    var body: some View {
        Group {
            if let feedback {
                Label(feedback, systemImage: "checkmark").font(.orbisCaption(.medium))
                    .foregroundStyle(OrbisPalette(scheme).success)
                    .padding(.horizontal, 14).frame(minHeight: 32)
                    .neuSurface(radius: 16, intensity: 0.5, concentric: false)
                    .padding(.bottom, 12).transition(.opacity)
            }
        }.animation(reduced || activity?.active == false ? nil : .orbisFade, value: feedback)
    }
}

private struct ChatJumpToLatestView: View {
    let viewport: ChatViewportController
    let hasRows: Bool
    let accent: Color
    let jump: () -> Void
    @Environment(\.orbisReduceMotion) private var reduced
    @Environment(\.chatVisualActivity) private var activity
    var body: some View {
        Group {
            if viewport.showJump && hasRows {
                OrbisIconButton(symbol: "arrow.down", label: L10n.tr("跳到最新消息"), tint: accent, action: jump)
                    .padding(16).transition(.opacity.combined(with: .scale(scale: 0.85)))
            }
        }.animation(reduced || activity?.active == false ? nil : .orbisFade, value: viewport.showJump)
    }
}
