import SwiftUI
import UIKit
import UniformTypeIdentifiers
import ImageIO

/// Bottom edge of the transcript in the viewport, or nil while the lazy stack has released it.
private struct ChatBottomPreference: PreferenceKey {
    static var defaultValue: CGFloat? = nil
    static func reduce(value: inout CGFloat?, nextValue: () -> CGFloat?) { value = nextValue() ?? value }
}

final class ChatScrollMetrics {
    var bottomDistance: CGFloat = 0
    var firstVisibleRow: String?
    var userScrolling = false
    var rowFrames: [String: CGRect] = [:]
    var viewportHeight: CGFloat = 0
}

private struct ChatQuestionJump: Equatable {
    let rowID: String
    let request = UUID()
}

private struct ChatRowsPreference: PreferenceKey {
    static var defaultValue: [String: CGRect] = [:]
    static func reduce(value: inout [String: CGRect], nextValue: () -> [String: CGRect]) { value.merge(nextValue(), uniquingKeysWith: { _, next in next }) }
}

private struct ChatReadingInteractionKey: EnvironmentKey {
    static let defaultValue: () -> Void = {}
}

private extension EnvironmentValues {
    var chatReadingInteraction: () -> Void {
        get { self[ChatReadingInteractionKey.self] }
        set { self[ChatReadingInteractionKey.self] = newValue }
    }
}

/// The transcript has exactly one viewport policy: within one line of the bottom it follows
/// new content, dragging or opening a disclosure stops following, and past three lines a jump-to-latest
/// button appears. Nothing else moves the viewport on the reader's behalf.
private enum ChatFollow {
    static let line: CGFloat = 20
    static let bottomID = "chat-bottom"
    static let topPadding: CGFloat = 4
}

struct ChatView: View {
    @StateObject private var sendFlight = MessageSendFlight()
    @EnvironmentObject private var store: OrbisStore
    @EnvironmentObject private var transfers: FileTransfers
    @EnvironmentObject private var agent: AgentState
    @EnvironmentObject private var notifications: RuntimeNotifications
    @Environment(\.colorScheme) private var scheme
    @AppStorage("orbis.appearance") private var visualStyle = "mist"
    @Environment(\.orbisReduceMotion) private var reduceMotion
    let runtime: RuntimeSummary
    let onBack: () -> Void
    let onHistory: () -> Void
    let onDownloads: () -> Void
    @State private var following = true
    @State private var replyArrivals = ReplyCardArrivals()
    @State private var jumpRequest = 0
    /// Per-frame scroll facts live in a reference box: writing them must not re-render the chat.
    /// Only `showJump` (derived from them) is view state, and it changes at a threshold.
    @State private var metrics = ChatScrollMetrics()
    @State private var showJump = false
    @State private var hasPositioned = false
    @State private var hasBrowsed = false
    @State private var questionOutsideViewport = false
    @State private var lastScrollTowardEarlier = false
    @State private var questionJumpRequest: ChatQuestionJump?
    @State private var suppressQuestionPaging = false
    @State private var selectedCommand: String?
    @State private var deliveryChoices = false
    @State private var permissionsOpen = false
    @State private var runtimeInfoOpen = false
    @State private var filePickerOpen = false
    @State private var historyAnchor: String?
    @State private var topArmed = false
    @StateObject private var downloadFlight = DownloadFlight()
    @FocusState private var composerFocused: Bool

    private var kind: String? { store.agentKind(runtime) }
    /// Claude Code 只能等当前回合结束后提交（没有 Steer）；附件和其他后端一样以路径交给它。
    private var claudeComposer: Bool { kind == "claude" }
    private var accent: Color { OrbisPalette(scheme).agent(kind) }
    private var latestQuestion: ChatQuestion? {
        store.chatTranscript.latestQuestion(excluding: Set(store.pendingSends.items.map(\.messageId)))
    }
    private var showQuestionReminder: Bool { hasPositioned && hasBrowsed && lastScrollTowardEarlier && showJump && questionOutsideViewport }
    private var hasRuntimeNotices: Bool {
        guard let projection = notifications.visibleProjection(runtime.runtimeId) else { return false }
        return !projection.items.isEmpty || (["codex", "codexDesktop"].contains(runtime.agentKind) && !projection.complete)
    }
    private var draft: Binding<String> { Binding(get: { store.draft(for: runtime) }, set: { store.saveDraft($0, for: runtime) }) }
    private var slash: Bool { draft.wrappedValue.trimmingCharacters(in: .whitespacesAndNewlines).hasPrefix("/") }
    private var command: SlashCommand? { (store.commands[runtime.runtimeId] ?? []).first { $0.name == selectedCommand } }
    private var attachments: [FileTransfer] {
        transfers.currentTasks.filter { $0.direction == "upload" && $0.runtimeId == runtime.runtimeId && $0.sessionId == runtime.sessionId && $0.attached }
    }
    private var canSubmit: Bool {
        // ADR-0049 §6.2：附件还在上传也可以发送，消息先等上传完成；失败或取消的附件需要先处理。
        guard store.canSend, !transfers.preparing, attachments.allSatisfy({ !["failed", "cancelled"].contains($0.status) }),
              !draft.wrappedValue.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !attachments.isEmpty else { return false }
        if slash {
            guard let command, draft.wrappedValue.hasPrefix("/" + command.name), store.pendingActionIds.isEmpty else { return false }
            return command.argument?.required != true || !commandArguments(command).isEmpty
        }
        return true
    }

    var body: some View {
        VStack(spacing: 0) {
            header
            conversation.overlay(alignment: .top) {
                if let launch = store.launching, store.isLaunchPage, launch.failure != nil || launch.unconfirmed {
                    // ADR-0049 §6.8：启动失败或未确认时在聊天页原位说明，提供“重试”“返回”，草稿保留。
                        VStack(alignment: .leading, spacing: 8) {
                            OrbisStatusWithInfo(title: L10n.tr(launch.failure != nil ? "启动失败" : "启动未确认"), message: launch.failure ?? L10n.tr("启动未确认：电脑端尚未报告会话上线，请稍后在会话列表中查看。"), error: launch.failure != nil)
                            HStack(spacing: 12) {
                                OrbisActionButton(title: L10n.tr("重试"), symbol: "arrow.clockwise") { store.retryLaunch() }.accessibilityIdentifier("launch-retry")
                                OrbisActionButton(title: L10n.tr("返回")) { onBack() }.accessibilityIdentifier("launch-back")
                            }
                        }.padding(.horizontal, 16)
                            // 容器自身带标识；不加 .contain 时标识会下沉覆盖“重试”“返回”的标识。
                            .accessibilityElement(children: .contain).accessibilityIdentifier("launch-notice")
                } else {
                    ZStack(alignment: .top) {
                        if showQuestionReminder && !hasRuntimeNotices, let question = latestQuestion {
                            questionReminder(question).padding(.horizontal, 16).padding(.top, 6)
                                .transition(reduceMotion ? .identity : InteractionMotion.notice)
                        }
                        if hasRuntimeNotices {
                            RuntimeNoticesView(runtimeId: runtime.runtimeId, supported: ["codex", "codexDesktop"].contains(runtime.agentKind)).padding(.horizontal, 16)
                        }
                    }.animation(reduceMotion ? nil : InteractionMotion.panel,
                                value: showQuestionReminder && !hasRuntimeNotices && latestQuestion != nil)
                }
            }
            if store.isViewingCachedSession { cachedComposer } else { composer }
        }.frame(maxWidth: 720).frame(maxWidth: .infinity, maxHeight: .infinity)
            #if DEBUG
            // Headless Device Hub can attach a hardware keyboard. The explicit fixture also
            // exercises the same viewport squeeze deterministically without changing release UI.
            .padding(.bottom, ProcessInfo.processInfo.arguments.contains("--preview-keyboard-resize") && composerFocused ? 300 : 0)
            #endif
            .background(OrbisPalette(scheme).base.ignoresSafeArea()).tint(accent).environment(\.orbisAccent, accent)
            .downloadFlightHost(downloadFlight)
            .messageSendFlightHost(sendFlight)
            .onChange(of: runtime.runtimeId) { _, _ in sendFlight.clear() }
            // ADR-0049 §6.8：启动页上正在输入时会话上线，新页面接过输入框焦点，键盘不收起。
            .onChange(of: composerFocused) { _, focused in store.noteComposerFocus(focused) }
            .onAppear { if store.takeComposerFocus(runtime.runtimeId) { DispatchQueue.main.async { composerFocused = true } } }
            #if DEBUG
            .overlay(alignment: .top) { if ProcessInfo.processInfo.arguments.contains("--preview-screen=changes") { TurnChangesRequestProbeView() } }
            .background { if ChatEntryProbe.enabled { ChatEntryDrawProbe().allowsHitTesting(false) } }
            #endif
            .fileImporter(isPresented: $filePickerOpen, allowedContentTypes: [.item], allowsMultipleSelection: true) { result in
                switch result {
                case .success(let urls): transfers.upload(urls: Array(urls.prefix(max(0, 10 - attachments.count))), runtime: runtime)
                case .failure(let error): transfers.error = error.localizedDescription
                }
            }
            .orbisBottomSheet(isPresented: $permissionsOpen) {
                PermissionsView(runtime: runtime).orbisSheet([.large])
            }
            .orbisBottomSheet(isPresented: $runtimeInfoOpen) {
                SessionModelConfigurationView(runtime: runtime).orbisSheet([.medium, .large])
            }
            .modifier(TurnFileReviewPresenter(changes: store.turnFileChanges))
            .onChange(of: draft.wrappedValue) { _, next in
                if let selectedCommand, !(next == "/" + selectedCommand || next.hasPrefix("/" + selectedCommand + " ")) { self.selectedCommand = nil }
                if next.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { deliveryChoices = false }
            }
            // Subscriptions start once the page has arrived; publishing them inside the entrance
            // forced the whole chat to lay out between its frames (PERF-10).
            .orbisTaskAfterArrival(id: runtime.runtimeId) {
                agent.setInterest(runtime: runtime, owner: "chat", domains: AgentState.chatDomains)
                defer { agent.setInterest(runtime: runtime, owner: "chat", domains: []) }
                store.refreshWorkingBranch()
                while !Task.isCancelled {
                    do { try await Task.sleep(nanoseconds: 15_000_000_000) } catch { return }
                    store.refreshWorkingBranch()
                }
            }
            .task(id: command?.argument?.optionCatalog?.id) {
                guard let command else { return }
                store.loadMenuOptions(runtimeId: runtime.runtimeId, name: command.name)
            }
            .onChange(of: selectedCommand) { old, _ in
                if let old { store.cancelMenuOptions(runtimeId: runtime.runtimeId, name: old) }
            }
            .onDisappear { if let selectedCommand { store.cancelMenuOptions(runtimeId: runtime.runtimeId, name: selectedCommand) } }
            .onChange(of: runtime.status) { _, status in if status != "running" { deliveryChoices = false } }
            .onChange(of: latestQuestion) { _, _ in updateQuestionVisibility() }
            .onChange(of: [store.selectedHostId ?? "", runtime.runtimeId, runtime.sessionId ?? ""]) { _, _ in
                runtimeInfoOpen = false
                sendFlight.clear()
                hasBrowsed = false; lastScrollTowardEarlier = false; questionOutsideViewport = false; questionJumpRequest = nil
                suppressQuestionPaging = false; metrics.rowFrames = [:]
            }
    }

    private func questionReminder(_ question: ChatQuestion) -> some View {
        let p = OrbisPalette(scheme)
        return OrbisMotionButton {
            composerFocused = false
            metrics.userScrolling = false
            following = false
            suppressQuestionPaging = true
            questionJumpRequest = ChatQuestionJump(rowID: question.messageId)
        } label: {
            HStack(spacing: 12) {
                HStack(spacing: 8) {
                    Text(L10n.tr("最近提问")).font(.orbisCaption(.medium)).foregroundStyle(p.secondary)
                        .lineLimit(1).fixedSize(horizontal: true, vertical: false)
                    Text(question.text).font(.orbisLabel()).foregroundStyle(p.text)
                        .lineLimit(1).multilineTextAlignment(.leading)
                }.frame(maxWidth: .infinity, alignment: .leading)
                OrbisActionSymbol(systemName: "arrow.up.left").font(.orbisLabel(.medium)).foregroundStyle(accent)
                    .accessibilityHidden(true)
            }.padding(.horizontal, 14).padding(.vertical, 10).frame(minHeight: 48)
        }.buttonStyle(NeuButtonStyle())
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(L10n.tr("最近提问，{0}", question.text))
            .accessibilityHint(L10n.tr("定位到原消息"))
            .accessibilityIdentifier("chat-question-reminder")
            .accessibilityAddTraits(.isButton)
    }

    private func updateQuestionVisibility() {
        let visibleFrames = metrics.rowFrames.values.contains { $0.maxY > 0 && $0.minY < metrics.viewportHeight }
        let outside = latestQuestion.map { question in
            guard visibleFrames else { return false }
            guard let frame = metrics.rowFrames[question.messageId] else { return true }
            // A small dead band keeps the reminder quiet at the viewport boundary.
            return frame.maxY < -8 || frame.minY > metrics.viewportHeight + 8
        } ?? false
        if outside != questionOutsideViewport { questionOutsideViewport = outside }
    }

    private var header: some View {
        let p = OrbisPalette(scheme)
        let presentation = store.sessionModelPresentation(runtime)
        return OrbisHeader {
            OrbisIconButton(symbol: "arrow.left", label: L10n.tr("返回"), action: onBack)
        } title: {
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 6) {
                    AgentEmblem(kind: kind, size: 18, recessed: false)
                    OrbisMotionText(store.displayName(runtime)).font(.orbisBody(.semibold)).lineLimit(1)
                }
                HStack(spacing: 8) {
                    if store.connection == .secured {
                        RuntimeStatusLabel(status: runtime.presentationStatus, syncing: store.isSyncing, title: runtime.presentationTitle)
                            .fixedSize(horizontal: true, vertical: false)
                    } else {
                        HStack(spacing: 5) {
                            Circle().fill(store.connection == .error ? p.error : p.warning)
                                .frame(width: 7, height: 7).frame(width: 14, height: 14)
                            OrbisMotionText(connectionTitle(store.connection)).font(.orbisCaption()).lineLimit(1)
                        }.foregroundStyle(p.secondary).fixedSize(horizontal: true, vertical: false)
                    }
                    if let model = presentation.model {
                        OrbisMotionText([model, presentation.thinking].compactMap { $0 }.joined(separator: " · "))
                            .font(.orbisCaption()).foregroundStyle(p.secondary).lineLimit(1)
                            .frame(maxWidth: .infinity, alignment: .leading).layoutPriority(1)
                    }
                    if let indicator = presentation.indicator {
                        OrbisMotionText(indicator).font(.orbisCaption()).foregroundStyle(p.secondary).lineLimit(1)
                            .fixedSize(horizontal: true, vertical: false).accessibilityIdentifier("chat-model-switching")
                    }
                }
            }.contentShape(Rectangle()).onTapGesture { composerFocused = false; runtimeInfoOpen = true }
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(L10n.tr("{0}，{1}，{2}", agentTitle(kind), store.displayName(runtime), store.connection == .secured ? runtime.presentationTitle : connectionTitle(store.connection)))
                .accessibilityValue([presentation.model, presentation.thinking, presentation.indicator].compactMap { $0 }.joined(separator: " · "))
                .accessibilityHint(L10n.tr("模型与深度")).accessibilityIdentifier("chat-title")
                .accessibilityAddTraits(.isButton)
        } trailing: {
            OrbisIconButton(symbol: "clock.arrow.circlepath", label: L10n.tr("历史与分支"), action: onHistory)
            OrbisIconButton(symbol: "arrow.down.to.line", label: L10n.tr("下载"), action: onDownloads)
                .downloadFlightTarget(downloadFlight).accessibilityIdentifier("chat-downloads")
        }
    }

    /// A long turn is virtualized into small rows. Its review card belongs after the turn's last
    /// row, whichever of the turn's messages the Host anchored it to.
    private func turnEndChangeAnchors(_ row: ChatRow) -> Set<String> {
        store.chatTranscript.changeAnchorsByRow[row.id] ?? []
    }

    private var conversation: some View {
        let kind = self.kind
        let transcript = store.chatTranscript
        let streamingMessageIds = store.connection == .secured && !store.isSyncing && !store.isViewingCachedSession ? store.streamingMessageIds : []
        replyArrivals.observe(rows: transcript.rows.map { ($0.id, $0.messages.map(\.messageId)) },
            ready: hasPositioned && store.connection == .secured && !store.isSyncing && !store.isViewingCachedSession,
            following: following, now: ProcessInfo.processInfo.systemUptime)
        let rewindOptions = store.userMessageRewindOptions(for: runtime)
        return GeometryReader { viewport in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 16) {
                    transcriptHeader.id("chat-header")
                    if transcript.rows.isEmpty {
                        OrbisEmptyState(symbol: "bubble.left.and.bubble.right", title: store.isSyncing ? L10n.tr("正在加载会话") : L10n.tr("继续这段会话"))
                            .frame(minHeight: max(180, viewport.size.height - 100))
                    }
                    ForEach(transcript.rows) { row in
                        ChatMessageRow(row: row, kind: kind, toolResults: transcript.toolResultsByRow[row.id] ?? [:],
                                       timings: transcript.timingsByRow[row.id] ?? [],
                                       changes: store.turnFileChanges,
                                       changeAnchors: turnEndChangeAnchors(row),
                                       streamingMessageIds: streamingMessageIds.intersection(row.messages.map(\.messageId)),
                                       replyArrivals: replyArrivals,
                                       rewindOption: row.isUser ? rewindOptions[row.id] : nil,
                                       rewindEnabled: store.canSend && runtime.status == "idle" && store.pendingActionIds.isEmpty,
                                       pending: row.isUser ? store.pendingSends.item(row.messages.first?.messageId)?.state : nil,
                                       uploads: row.isUser ? pendingUploads(row.messages.first?.messageId) : [],
                                       canResend: store.canSend, onRewind: { option in
                            if store.moveHistory(to: option, fallbackText: row.messages.first?.text) {
                                composerFocused = false
                                OrbisHaptics.commit()
                            }
                        }, onPending: { action in pendingAction(action, messageId: row.messages.first?.messageId) }).equatable().id(row.id)
                            .background(GeometryReader { geometry in Color.clear.preference(key: ChatRowsPreference.self, value: [row.id: geometry.frame(in: .named("chat-viewport"))]) })
                    }
                    LiveToolsView(runtime: runtime).id("chat-live-tools")
                        .background(GeometryReader { geometry in Color.clear.preference(key: ChatRowsPreference.self, value: ["chat-live-tools": geometry.frame(in: .named("chat-viewport"))]) })
                    // Small tail: the last message sits close to the composer (LazyVStack spacing still applies).
                    Color.clear.frame(height: 4).id(ChatFollow.bottomID)
                        .background(GeometryReader { geo in Color.clear.preference(key: ChatBottomPreference.self, value: geo.frame(in: .named("chat-viewport")).maxY) })
                }.scrollTargetLayout()
                    .padding(.horizontal, 16).padding(.top, ChatFollow.topPadding)
                    .background(OrbisScrollDirectionObserver { earlier in lastScrollTowardEarlier = earlier })
                    .background {
                        if #unavailable(iOS 18.0) { LegacyScrollInteraction(onInteraction: userInteractionChanged) }
                    }
            }.coordinateSpace(name: "chat-viewport").scrollDismissesKeyboard(.interactively)
                .orbisAnchor(sendFlight.viewport)

                .modifier(ChatScrollObserver(viewportHeight: viewport.size.height, following: following, jumpRequest: jumpRequest,
                                             questionJumpRequest: questionJumpRequest,
                                             onDistance: bottomDistanceChanged,
                                             onInteraction: { userInteractionChanged($0) },
                                             onReading: { metrics.userScrolling = false; following = false }))
                .onPreferenceChange(ChatRowsPreference.self) { frames in
                    metrics.rowFrames = frames
                    metrics.viewportHeight = viewport.size.height
                    updateQuestionVisibility()
                    metrics.firstVisibleRow = frames.filter { $0.value.maxY > 0 && $0.value.minY < viewport.size.height }.min { $0.value.minY < $1.value.minY }?.key
                    let first = transcript.firstMessageId
                    let atTop = first.flatMap { frames[$0] }.map { $0.minY >= -40 && $0.minY < viewport.size.height } ?? false
                    if !atTop && topArmed != hasPositioned { topArmed = hasPositioned }
                    if atTop && topArmed && !suppressQuestionPaging && historyAnchor == nil && !store.isSyncing && !store.historyLoading.contains(runtime.runtimeId) && store.historyErrors[runtime.runtimeId] == nil {
                        topArmed = false; loadOlder()
                    }
                }
                .onChange(of: viewport.size.height) { _, height in
                    metrics.viewportHeight = height
                    updateQuestionVisibility()
                }
                .overlay(alignment: .bottomTrailing) {
                    if showJump && !transcript.rows.isEmpty {
                        OrbisIconButton(symbol: "arrow.down", label: L10n.tr("跳到最新消息"), tint: accent) { jumpToLatest() }
                            .padding(16)
                            .transition(.opacity.combined(with: .scale(scale: 0.85)))
                    }
                }
                .overlay(alignment: .bottom) {
                    if let feedback = store.actionFeedback {
                        Label(feedback, systemImage: "checkmark").font(.orbisCaption(.medium))
                            .foregroundStyle(OrbisPalette(scheme).success)
                            .padding(.horizontal, 14).frame(minHeight: 32)
                            .neuSurface(radius: 16, intensity: 0.5, concentric: false)
                            .padding(.bottom, 12)
                            .transition(.opacity)
                    }
                }
                .animation(reduceMotion ? nil : .orbisFade, value: showJump)
                .onChange(of: following) { _, next in
                    if next { hasBrowsed = false }
                    updateJump()
                }
                .onChange(of: store.historyRevision) { _, _ in
                    sendFlight.clear()
                    following = true; hasPositioned = false; hasBrowsed = false
                    questionOutsideViewport = false; questionJumpRequest = nil; suppressQuestionPaging = false
                }
                .animation(reduceMotion ? nil : .orbisFade, value: store.actionFeedback)
                .onChange(of: store.historyPageRevision) { _, _ in
                    // Native identity anchoring preserves the current row AND its offset,
                    // including if the reader scrolled while the older page was in flight.
                    self.historyAnchor = nil
                }
                .onChange(of: store.historyLoading.contains(runtime.runtimeId)) { old, loading in
                    if old && !loading && store.historyErrors[runtime.runtimeId] != nil { historyAnchor = nil }
                }
        }
    }

    private var cachedComposer: some View {
        VStack(spacing: 10) {
            OrbisStatusWithInfo(title: L10n.tr("本机缓存"), message: L10n.tr("本机缓存，可离线浏览，发送消息前需在电脑继续此会话"))
            if let session = store.sessions.first(where: { $0.sessionId == runtime.sessionId }) {
                OrbisActionButton(title: L10n.tr("在电脑继续会话"), symbol: "play") { store.activate(session) }
                    .disabled(store.connection != .secured || store.activatingSessionId != nil)
            }
        }.padding(16)
    }

    /// One row above the transcript. Its height never changes: an error replaces the
    /// paging action in place instead of adding a line.
    private var transcriptHeader: some View {
        let p = OrbisPalette(scheme)
        let error = store.historyErrors[runtime.runtimeId]
        let loading = store.historyLoading.contains(runtime.runtimeId)
        let blocked = store.isSyncing || (!store.canSend && !store.isViewingCachedSession) || loading
        return HStack(spacing: 10) {
            if let error {
                Text(error).font(.orbisCaption()).foregroundStyle(p.error).lineLimit(1)
                Spacer(minLength: 0)
                OrbisTextButton(title: L10n.tr("重试"), symbol: "arrow.up", tint: accent, loading: loading) { loadOlder() }.disabled(blocked)
            } else if store.hasOlderHistory[runtime.runtimeId] == true {
                OrbisTextButton(title: L10n.tr("更早的消息"), symbol: "arrow.up", tint: accent, loading: loading) { loadOlder() }.disabled(blocked)
                Spacer(minLength: 0)
            } else {
                Spacer(minLength: 0)
            }
        }.frame(minHeight: 48)
    }

    // Scrolling from a geometry callback re-enters lazy layout while a disclosure changes height.
    // Observe here; native anchors handle size changes and an actual scroll ending resumes following.
    private func bottomDistanceChanged(_ distance: CGFloat) {
        metrics.bottomDistance = distance
        updateJump()
        if distance.isFinite && !hasPositioned && !store.messages.isEmpty { hasPositioned = true }
    }

    private func userInteractionChanged(_ active: Bool) {
        if active {
            metrics.userScrolling = true
            hasBrowsed = true
            suppressQuestionPaging = false
            following = false
        } else {
            guard metrics.userScrolling else { return }
            metrics.userScrolling = false
            if metrics.bottomDistance <= ChatFollow.line { following = true }
        }
    }

    private func updateJump() {
        let next = !following && metrics.bottomDistance > ChatFollow.line * 3
        if next != showJump { showJump = next }
    }

    private func jumpToLatest() {
        hasBrowsed = false
        suppressQuestionPaging = false
        following = true
        jumpRequest += 1
    }

    private var composer: some View {
        let p = OrbisPalette(scheme)
        return VStack(spacing: 0) {
            InteractionWorkspaceView(runtimeId: runtime.runtimeId)
            if let tasks = runtime.backgroundTasks, tasks.visible {
                BackgroundTasksView(tasks: tasks).id("\(runtime.runtimeId):\(runtime.sessionId ?? "")")
            }
            if let percent = contextUsagePercent(runtime.contextUsage), domainReady("context") {
                GeometryReader { geometry in
                    Rectangle().fill(accent.opacity(0.15))
                        .overlay(alignment: .leading) { Rectangle().fill(percent >= 90 ? p.error : accent).frame(width: geometry.size.width * min(100, max(0, percent)) / 100) }
                }.frame(height: 2).accessibilityLabel(L10n.tr("上下文已使用 {0}%", Int(percent)))
            } else { Color.clear.frame(height: 2) }
            QueuedMessagesView(runtimeId: runtime.runtimeId)
            OrbisCollapse(expanded: deliveryChoices) {
                HStack(spacing: 12) {
                    OrbisActionButton(title: deliveryTitle("followUp"), tint: accent) { submit(delivery: "followUp") }
                    OrbisActionButton(title: deliveryTitle("steer"), tint: accent) { submit(delivery: "steer") }
                }.padding(.horizontal, 16).padding(.top, 10)
            }
            if !slash {
                // One line of session context between the transcript and the field: directory,
                // branch, permissions. The path gives way first; the branch keeps its name.
                HStack(spacing: 12) {
                    HStack(spacing: 12) {
                        Label(runtime.cwd, systemImage: "folder").lineLimit(1).truncationMode(.middle)
                        OrbisMotionButton {
                            #if DEBUG
                            PreviewViewportUpdates.advance?()
                            PreviewViewportUpdates.schedule?()
                            #endif
                            store.refreshWorkingBranch()
                        } label: {
                            Label { Text(branchTitle) } icon: { OrbisActionSymbol(systemName: "point.3.connected.trianglepath.dotted") }.lineLimit(1)
                        }.buttonStyle(.plain).layoutPriority(1).accessibilityLabel(L10n.tr("刷新 Git 工作分支，") + branchTitle)
                    }.font(.orbisCaption(mono: true)).foregroundStyle(p.secondary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    if let permissions = runtime.permissionManagement {
                        OrbisMotionButton { composerFocused = false; permissionsOpen = true } label: {
                            HStack(spacing: 5) {
                                OrbisActionSymbol(systemName: "shield.lefthalf.filled")
                                Text(L10n.hostSummary(permissions.summary)).lineLimit(1)
                                OrbisActionSymbol(systemName: "chevron.right").imageScale(.small)
                            }.font(.orbisCaption()).frame(minHeight: 32)
                                .foregroundStyle(permissions.tone == "problem" ? p.error : accent)
                                .contentShape(Rectangle().inset(by: -6))
                        }.buttonStyle(.plain).accessibilityLabel(L10n.tr("会话权限：{0}", L10n.hostSummary(permissions.summary)))
                    }
                }.padding(.horizontal, 20).padding(.top, 6)
            }
            AttachmentStrip(runtime: runtime)
            if slash { SlashPickerView(runtime: runtime, selected: $selectedCommand, input: draft, onHistory: onHistory).padding(.top, 10) }
            HStack(alignment: .bottom, spacing: 10) {
                OrbisIconButton(symbol: "paperclip", label: L10n.tr("发送文件到电脑"), tint: accent) {
                    composerFocused = false; filePickerOpen = true
                }.disabled(!store.canSend || transfers.preparing || attachments.count >= 10)
                TextField(L10n.tr("发给 {0}，/ 命令", agentTitle(kind)), text: draft, axis: .vertical)
                    .accessibilityIdentifier("chat-composer")
                    .font(.orbisBody()).lineLimit(1...6).focused($composerFocused)
                    .onKeyPress(keys: [.return], phases: .down) { key in
                        if key.modifiers.contains(.shift) { return .ignored }
                        guard canSubmit else { return .handled }
                        if runtime.status == "running" && !slash && claudeComposer { submit(delivery: "followUp") }
                        else if runtime.status == "running" && !slash { deliveryChoices.toggle() }
                        else { submit() }
                        return .handled
                    }
                    .onKeyPress(.escape) { composerFocused = false; return .handled }
                    .padding(.horizontal, 16).padding(.vertical, 16).frame(minHeight: 56)
                    .orbisField(focused: composerFocused).orbisAnchor(sendFlight.composer)
                if runtime.status == "running" && draft.wrappedValue.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && attachments.isEmpty {
                    OrbisIconButton(symbol: "stop.fill", label: L10n.tr("停止生成"), tint: p.error) {
                        if store.stopRuntime() { OrbisHaptics.commit() }
                    }.disabled(!store.canSend)
                } else {
                    OrbisIconButton(symbol: "arrow.up", label: L10n.tr("发送消息"), tint: accent) {
                        if runtime.status == "running" && !slash && claudeComposer { submit(delivery: "followUp") }
                        else if runtime.status == "running" && !slash { deliveryChoices.toggle() }
                        else { submit() }
                    }.disabled(!canSubmit)
                }
            }.padding(.horizontal, 12).padding(.top, 6).padding(.bottom, 12)
        }.padding(.top, 4).background(p.base)
    }

    private func domainReady(_ name: String) -> Bool {
        guard let snapshot = agent.snapshots[runtime.runtimeId] else { return true }
        return snapshot.missing[name] == nil && (snapshot.domains[name]?.availability ?? "ready") == "ready"
    }

    private var branchTitle: String {
        guard let branch = store.workingBranches[runtime.runtimeId], branch.cwd == runtime.cwd, branch.sessionId == runtime.sessionId else { return L10n.tr("分支信息待同步") }
        return branch.branch ?? branch.commit.map { L10n.tr("{0}（分离 HEAD）", String($0.prefix(8))) } ?? (branch.loaded ? L10n.tr("未获取到 Git 分支") : L10n.tr("分支信息待同步"))
    }

    private func loadOlder() {
        let anchor = metrics.firstVisibleRow
        if store.loadOlderHistory() { historyAnchor = anchor; following = false }
    }

    private func commandArguments(_ command: SlashCommand) -> String {
        String(draft.wrappedValue.dropFirst(command.name.count + 1)).trimmingCharacters(in: .whitespacesAndNewlines)
    }
    private func pendingAction(_ action: PendingSendAction, messageId: String?) {
        guard let messageId else { return }
        switch action {
        case .resend:
            let existing = Set(store.pendingSends.items.map(\.messageId))
            if store.resendPendingSend(messageId) { OrbisHaptics.commit(); beginSendFeedback(existing: existing) }
        case .restore:
            guard let text = store.restorePendingSend(messageId) else { return }
            let current = draft.wrappedValue.trimmingCharacters(in: .whitespacesAndNewlines)
            draft.wrappedValue = current.isEmpty ? text : draft.wrappedValue + "\n" + text
            composerFocused = true
        case .discard: store.discardPendingSend(messageId)
        case .check: store.refresh()
        case .cancel: _ = store.cancelQueuedMessage(messageId)
        }
    }

    private func submit(delivery: String? = nil) {
        guard canSubmit else { return }
        let existing = Set(store.pendingSends.items.map(\.messageId))
        let accepted: Bool
        // ADR-0049 §6.1：产生对话的 Slash 与消息一样，气泡立即出现、输入框清空。
        let messageSlash = slash && command.map(store.producesMessage) == true
        if slash, let command { accepted = store.executeSlash(command.name, args: commandArguments(command), composerDraft: messageSlash ? nil : draft.wrappedValue) }
        else { accepted = store.sendMessage(draft.wrappedValue.isEmpty ? "请查看附件。" : draft.wrappedValue, delivery: delivery, attachmentIds: Set(attachments.map(\.id))) }
        if accepted {
            beginSendFeedback(existing: existing)
            OrbisHaptics.commit()
            if !slash || messageSlash {
                // 交给消息的附件离开输入框，仍在上传的继续上传（不取消）。
                transfers.release(Set(attachments.map(\.id))); draft.wrappedValue = ""; selectedCommand = nil
            }
            deliveryChoices = false
        }
    }
    /// 本地待发送消息的附件，按发送时的顺序；上传任务已被清理的不显示。
    private func pendingUploads(_ messageId: String?) -> [FileTransfer] {
        guard let ids = store.pendingSends.item(messageId)?.uploadIds, !ids.isEmpty else { return [] }
        let tasks = transfers.currentTasks
        return ids.compactMap { id in tasks.first { $0.id == id } }
    }
    private func beginSendFeedback(existing: Set<String>) {
        // No text/time/index heuristic: one synchronous accepted submit creates one new App identity.
        let created = store.pendingSends.items.filter { !existing.contains($0.messageId) && $0.sessionId == runtime.sessionId }
        guard created.count == 1, let send = created.first else { return }
        sendFlight.launch(send, following: following, reduceMotion: reduceMotion)
    }

}

private final class ChatNativeReadingMetrics {
    var offset: CGFloat = 0
    var frozen = false
}

private struct ChatNativeScrollFacts: Equatable {
    let offset: CGFloat
    let distance: CGFloat
}

/// Reports how far the transcript sits from its bottom edge and when the reader's finger
/// starts or stops moving it. iOS 18 reads the scroll geometry and phase directly.
private struct ChatScrollObserver: ViewModifier {
    let viewportHeight: CGFloat
    let following: Bool
    let jumpRequest: Int
    let questionJumpRequest: ChatQuestionJump?
    let onDistance: (CGFloat) -> Void
    let onInteraction: (Bool) -> Void
    let onReading: () -> Void
    @State private var readingRow: String?
    @Environment(\.orbisReduceMotion) private var reduceMotion

    func body(content: Content) -> some View {
        if #available(iOS 18.0, *) {
            content
                .modifier(ChatNativeScrollPosition(following: following, jumpRequest: jumpRequest,
                                                   questionJumpRequest: questionJumpRequest,
                                                   onDistance: onDistance, onInteraction: onInteraction, onReading: onReading))
        } else {
            ScrollViewReader { proxy in content
                .environment(\.chatReadingInteraction, onReading)
                .scrollPosition(id: $readingRow)
                .defaultScrollAnchor(following ? .bottom : nil)
                .onChange(of: jumpRequest) { _, _ in
                    withAnimation(reduceMotion ? nil : .smooth(duration: 0.3)) { readingRow = ChatFollow.bottomID }
                }
                .onChange(of: questionJumpRequest) { _, request in
                    guard let request else { return }
                    withAnimation(reduceMotion ? nil : .smooth(duration: 0.3)) { proxy.scrollTo(request.rowID, anchor: .top) }
                }
                .onPreferenceChange(ChatBottomPreference.self) { bottom in
                    onDistance(bottom.map { max(0, $0 - viewportHeight) } ?? .infinity)
                }
            }
        }
    }
}

/// The native position owns both user motion and layout anchoring. An explicit bottom-edge
/// request also survives lazy height estimates; a saved row ID is never replayed after a drag.
@available(iOS 18.0, *)
private struct ChatNativeScrollPosition: ViewModifier {
    let following: Bool
    let jumpRequest: Int
    let questionJumpRequest: ChatQuestionJump?
    let onDistance: (CGFloat) -> Void
    let onInteraction: (Bool) -> Void
    let onReading: () -> Void
    @State private var position = ScrollPosition(idType: String.self)
    @State private var metrics = ChatNativeReadingMetrics()
    @Environment(\.orbisReduceMotion) private var reduceMotion

    func body(content: Content) -> some View {
        content
            .environment(\.chatReadingInteraction) {
                // A disclosure can expand before the parent publishes `following = false`.
                // Commit a point before the disclosure changes height. The target layout's
                // coordinate starts after the lazy stack's top padding.
                metrics.frozen = true
                onReading()
                position.scrollTo(y: metrics.offset - ChatFollow.topPadding)
            }
            .scrollPosition($position)
            .defaultScrollAnchor(.bottom, for: .initialOffset)
            .defaultScrollAnchor(following ? .bottom : nil, for: .sizeChanges)
            .onChange(of: jumpRequest) { _, _ in
                metrics.frozen = false
                withAnimation(reduceMotion ? nil : .smooth(duration: 0.3)) { position.scrollTo(edge: .bottom) }
            }
            .onChange(of: questionJumpRequest) { _, request in
                guard let request else { return }
                withAnimation(reduceMotion ? nil : .smooth(duration: 0.3)) { position.scrollTo(id: request.rowID, anchor: .top) }
            }
            .onChange(of: following) { _, next in
                if !next && !metrics.frozen { position.isPositionedByUser = true }
            }
            .onScrollGeometryChange(for: ChatNativeScrollFacts.self) { geometry in
                ChatNativeScrollFacts(offset: geometry.contentOffset.y,
                    distance: max(0, geometry.contentSize.height + geometry.contentInsets.bottom - geometry.visibleRect.maxY))
            } action: { _, facts in metrics.offset = facts.offset; onDistance(facts.distance) }
            .onScrollPhaseChange { _, phase in
                switch phase {
                case .tracking, .interacting: metrics.frozen = false; onInteraction(true)
                case .idle: onInteraction(false)
                default: break
                }
            }
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

/// Inputs are plain values so an unchanged row is skipped: it does not observe the whole store.
struct ChatMessageRow: View, Equatable {
    @Environment(\.colorScheme) private var scheme
    @AppStorage("orbis.appearance") private var visualStyle = "mist"
    let row: ChatRow
    let kind: String?
    var toolResults: [String: ChatMessage] = [:]
    var timings: [SessionTurnTiming] = []
    var changes: TurnFileChanges?
    var changeAnchors: Set<String> = []
    var streamingMessageIds: Set<String> = []
    var replyArrivals: ReplyCardArrivals? = nil
    var rewindOption: RuntimeOption? = nil
    var rewindEnabled = false
    /// ADR-0049：本地待确认发送的状态；权威行为 nil。
    var pending: PendingSend.State? = nil
    /// ADR-0049 §6.1：本地待发送消息带的附件（上传任务），气泡内显示缩略图 / 文件名与上传进度。
    var uploads: [FileTransfer] = []
    var canResend = false
    var onRewind: (RuntimeOption) -> Void = { _ in }
    var onPending: (PendingSendAction) -> Void = { _ in }
    static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.row.contentRevision == rhs.row.contentRevision && lhs.kind == rhs.kind && lhs.toolResults == rhs.toolResults &&
            lhs.timings == rhs.timings && lhs.changeAnchors == rhs.changeAnchors && lhs.changes === rhs.changes &&
            lhs.streamingMessageIds == rhs.streamingMessageIds && lhs.rewindOption == rhs.rewindOption &&
            lhs.rewindEnabled == rhs.rewindEnabled && lhs.pending == rhs.pending && lhs.uploads == rhs.uploads &&
            lhs.canResend == rhs.canResend && lhs.visualStyle == rhs.visualStyle
    }
    var body: some View {
        VStack(alignment: .trailing, spacing: 2) {
            HStack(alignment: .top, spacing: 0) {
                if row.isUser { Spacer(minLength: 36) }
                VStack(alignment: .leading, spacing: 12) {
                    if !row.isUser {
                        HStack(spacing: 6) {
                            AgentEmblem(kind: kind, size: 17, recessed: false)
                            Text(agentTitle(kind)).font(.orbisCaption(.semibold)).foregroundStyle(OrbisPalette(scheme).agent(kind))
                            Spacer(minLength: 8)
                            // 复制整轮回复。不用长按手势：它挂在每条消息上会和滚动、文本选择抢触摸。
                            OrbisCopyButton(label: L10n.tr("复制回复"), size: 28) { copyText }
                                .padding(.vertical, -10)
                        }
                    }
                    if row.isUser {
                        ForEach(row.messages) { message in
                            MessageContentView(message: message, toolResults: toolResults, streaming: false)
                        }
                    } else {
                        let content = assistantCardContent(row.messages)
                        ForEach(content.prose) { message in
                            MessageContentView(message: message, toolResults: toolResults, streaming: streamingMessageIds.contains(message.messageId))
                        }
                        if !content.tools.isEmpty { ChatToolGroup(calls: content.tools, results: toolResults) }
                    }
                    if row.isUser && !uploads.isEmpty { PendingAttachments(tasks: uploads) }
                    if !row.isUser, let changes {
                        TurnChangeCards(changes: changes, anchors: changeAnchors)
                    }
                    ForEach(timings, id: \.turnId) { timing in
                        TimelineView(.animation(minimumInterval: 1, paused: timing.durationMs != nil)) { context in
                            let elapsed = timing.durationMs.map(Double.init) ?? max(0, context.date.timeIntervalSince1970 * 1000 - Double(timing.startedAt))
                            Text(String(format: timing.durationMs == nil ? L10n.tr("本轮已运行 %.1f 秒") : L10n.tr("本轮耗时 %.1f 秒"), elapsed / 1000))
                                .font(.orbisCaption(mono: true)).foregroundStyle(OrbisPalette(scheme).secondary)
                        }
                    }
                }.frame(maxWidth: row.isUser ? nil : .infinity, alignment: .leading)
                    .modifier(ChatMessageSurface(row: row, streaming: !streamingMessageIds.isEmpty, arrivals: replyArrivals))
                    .accessibilityAction(named: L10n.tr("复制")) { UIPasteboard.general.string = copyText }
                    .messageSendFlightTarget(row.messages.first?.clientMessageId ?? row.id)
                    .modifier(OrbisMessageActions(enabled: row.isUser, id: row.id, text: row.isUser ? copyText : "",
                                                  rewindEnabled: rewindEnabled, rewind: messageRewind))
                if !row.isUser { Spacer(minLength: 8) }
            }
            if row.isUser, let pending {
                PendingSendStatus(state: pending, canResend: canResend, rowId: row.id, onAction: onPending)
            }
        }
    }
    private var messageRewind: (() -> Void)? {
        guard pending == nil, let rewindOption else { return nil }
        return { onRewind(rewindOption) }
    }
    private var copyText: String { row.copyText ?? (row.copyMessages ?? row.messages).map(\.text).joined(separator: "\n\n") }
}

private struct ChatMessageSurface: ViewModifier {
    let row: ChatRow
    let streaming: Bool
    let arrivals: ReplyCardArrivals?
    func body(content: Content) -> some View {
        if row.isUser {
            content.neuSurface(inset: true, radius: OrbisRadius.card, intensity: 0.65, padding: 16)
        } else {
            content.modifier(OrbisReplyCard(id: row.id, parts: row.messages.flatMap { message in
                message.content.enumerated().map { index, block in
                    ReplyCardPart(id: "\(message.messageId):\(index):\(block.type)", text: block.text ?? "")
                }
            }, live: streaming, arrivals: arrivals))
        }
    }
}

enum PendingSendAction { case resend, restore, discard, check, cancel }

/// ADR-0049 §6.1：等待上传的消息在气泡内显示附件。图片显示缩略图，其他文件显示图标；文件名按 S09 保留扩展名，
/// 下方是与输入框附件条相同的上传状态与进度。只读：重试 / 放回 / 删除在气泡下方的操作区。
private struct PendingAttachments: View {
    @Environment(\.colorScheme) private var scheme
    @AppStorage("orbis.appearance") private var visualStyle = "mist"
    let tasks: [FileTransfer]
    var body: some View {
        let p = OrbisPalette(scheme)
        VStack(alignment: .leading, spacing: 8) {
            ForEach(tasks) { task in
                HStack(spacing: 10) {
                    AttachmentThumbnail(task: task)
                    VStack(alignment: .leading, spacing: 3) {
                        FileNameText(name: task.name).font(.orbisCaption(.medium))
                        Text(pendingAttachmentStatus(task)).font(.orbisCaption()).lineLimit(1)
                            .foregroundStyle(task.error != nil || task.status == "failed" ? p.error : p.secondary)
                    }
                }.accessibilityElement(children: .combine).accessibilityIdentifier("pending-attachment-" + task.id)
            }
        }
    }
}

func pendingAttachmentStatus(_ task: FileTransfer) -> String {
    if let error = task.error { return error }
    if task.status == "completed" { return L10n.tr("已上传") }
    guard ["uploading", "verifying"].contains(task.status), task.size > 0 else { return transferStatusTitle(task.status) }
    return transferStatusTitle(task.status) + " \(min(100, Int(task.received * 100 / max(1, task.size))))%"
}

/// 36pt 方形缩略图：本机暂存的图片按需降采样解码，其他文件或解码失败显示文件图标。
private struct AttachmentThumbnail: View {
    @Environment(\.colorScheme) private var scheme
    @AppStorage("orbis.appearance") private var visualStyle = "mist"
    let task: FileTransfer
    @State private var image: UIImage?
    var body: some View {
        ZStack {
            if let image {
                Image(uiImage: image).resizable().scaledToFill()
            } else {
                OrbisActionSymbol(systemName: "doc").foregroundStyle(OrbisPalette(scheme).secondary)
            }
        }.frame(width: 36, height: 36).clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
            .task(id: task.localPath) { image = await Self.thumbnail(task) }
    }
    static func thumbnail(_ task: FileTransfer) async -> UIImage? {
        guard let path = task.localPath, let type = UTType(filenameExtension: (task.name as NSString).pathExtension),
              type.conforms(to: .image) else { return nil }
        return await Task.detached(priority: .utility) {
            guard let source = CGImageSourceCreateWithURL(URL(fileURLWithPath: path) as CFURL, nil),
                  let cgImage = CGImageSourceCreateThumbnailAtIndex(source, 0, [
                    kCGImageSourceCreateThumbnailFromImageAlways: true, kCGImageSourceCreateThumbnailWithTransform: true,
                    kCGImageSourceThumbnailMaxPixelSize: 120] as CFDictionary) else { return nil }
            return UIImage(cgImage: cgImage)
        }.value
    }
}

/// 用户气泡下方原本放复制 / 回退的位置，替换为发送状态与恢复操作，不在聊天里另起提示行。
private struct PendingSendStatus: View {
    @Environment(\.colorScheme) private var scheme
    @AppStorage("orbis.appearance") private var visualStyle = "mist"
    let state: PendingSend.State
    let canResend: Bool
    let rowId: String
    let onAction: (PendingSendAction) -> Void
    var body: some View {
        let palette = OrbisPalette(scheme)
        HStack(spacing: 2) {
            switch state {
            case .sending, .accepted:
                ProgressView().controlSize(.mini).dynamicTypeSize(...DynamicTypeSize.large).frame(width: 28, height: 28)
                Text(L10n.tr("发送中")).font(.orbisCaption()).foregroundStyle(palette.secondary)
            case .queued:
                OrbisActionSymbol(systemName: "clock").font(.orbisCaption()).foregroundStyle(palette.secondary).frame(width: 28, height: 28)
                Text(L10n.tr("已排队")).font(.orbisCaption()).foregroundStyle(palette.secondary)
                OrbisIconButton(symbol: "xmark", label: L10n.tr("撤回排队消息"), size: 28) { onAction(.cancel) }
                    .disabled(!canResend).accessibilityIdentifier("pending-cancel-" + rowId)
            case .waiting(let label):
                // ADR-0049 §6.2：标明在等什么（上传中的附件名、等待前一条）。
                ProgressView().controlSize(.mini).dynamicTypeSize(...DynamicTypeSize.large).frame(width: 28, height: 28)
                Text(label).font(.orbisCaption()).foregroundStyle(palette.secondary).lineLimit(2)
            case .unconfirmed:
                OrbisActionSymbol(systemName: "questionmark.circle").font(.orbisCaption()).foregroundStyle(palette.secondary).frame(width: 28, height: 28)
                Text(L10n.tr("未确认是否送达")).font(.orbisCaption()).foregroundStyle(palette.secondary)
                OrbisIconButton(symbol: "arrow.clockwise", label: L10n.tr("核对送达状态"), size: 28) { onAction(.check) }
                    .accessibilityIdentifier("pending-check-" + rowId)
                OrbisIconButton(symbol: "trash", label: L10n.tr("删除"), size: 28) { onAction(.discard) }
                    .accessibilityIdentifier("pending-discard-" + rowId)
            case .failed(let reason):
                OrbisActionSymbol(systemName: "exclamationmark.circle").foregroundStyle(palette.error).font(.orbisCaption())
                Text(reason).font(.orbisCaption()).foregroundStyle(palette.error).lineLimit(2)
                OrbisIconButton(symbol: "arrow.clockwise", label: L10n.tr("重新发送"), size: 28) { onAction(.resend) }
                    .disabled(!canResend).accessibilityIdentifier("pending-resend-" + rowId)
                OrbisIconButton(symbol: "pencil", label: L10n.tr("放回输入框"), size: 28) { onAction(.restore) }
                    .accessibilityIdentifier("pending-restore-" + rowId)
                OrbisIconButton(symbol: "trash", label: L10n.tr("删除"), size: 28) { onAction(.discard) }
                    .accessibilityIdentifier("pending-discard-" + rowId)
            }
        }.accessibilityElement(children: .contain).accessibilityIdentifier("pending-status-" + rowId)
    }
}

/// A batch remains one compact group even if a backend uses one message per call.
private struct ChatToolGroup: View {
    let calls: [ChatCardTool]
    let results: [String: ChatMessage]
    @State private var visible = chatToolPageSize
    private func summary(_ call: ChatCardTool) -> ToolSummary? { call.block.toolCallId.flatMap { results[$0]?.toolSummary } ?? call.block.summary }
    private var phase: String {
        let running = calls.contains { call in
            if let value = summary(call) { return !["finished", "cancelled"].contains(value.phase) }
            return call.block.toolCallId.flatMap { results[$0] } == nil
        }
        if running { return L10n.tr("执行中") }
        if calls.contains(where: { summary($0)?.isError == true || $0.block.toolCallId.flatMap { results[$0]?.isError } == true }) { return L10n.tr("执行失败") }
        return L10n.tr("已完成")
    }
    var body: some View {
        if calls.count == 1 {
            MessageContentView(message: calls[0].displayMessage, toolResults: results)
        } else {
            CompactDisclosure(title: L10n.tr("{0} 次工具调用", calls.count), detail: phase, symbol: "wrench.and.screwdriver") {
                VStack(alignment: .leading, spacing: 8) {
                    ForEach(Array(calls.prefix(visible))) { call in
                        MessageContentView(message: call.displayMessage, toolResults: results)
                    }
                    if visible < calls.count {
                        OrbisActionButton(title: L10n.tr("显示更多工具（剩余 {0} 项）", calls.count - visible)) { visible += chatToolPageSize }
                    }
                }
            }.accessibilityIdentifier("chat-tool-group")
        }
    }
}

private struct MessageContentView: View {
    @EnvironmentObject private var transfers: FileTransfers
    @Environment(\.downloadFlight) private var downloadFlight
    @Environment(\.colorScheme) private var scheme
    @AppStorage("orbis.appearance") private var visualStyle = "mist"
    let message: ChatMessage
    var toolResults: [String: ChatMessage] = [:]
    var streaming = false
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            if let summary = message.toolSummary { ToolSummaryView(summary: summary) }
            ForEach(Array(message.content.enumerated()), id: \.offset) { _, content in
                switch content.type {
                case "thinking":
                    CompactDisclosure(title: L10n.tr("思考过程"), symbol: "sparkles") {
                        Text(content.text ?? L10n.tr("思考中…")).font(.orbisLabel()).textSelection(.enabled)
                    }
                case "tool_call", "toolCall":
                    let result = content.toolCallId.flatMap { toolResults[$0] }
                    if let summary = result?.toolSummary ?? content.summary { ToolSummaryView(summary: summary) }
                    else {
                        let live = content.toolCallId == nil && content.arguments == nil && content.text?.isEmpty == false
                        let status = result?.isError == true ? L10n.tr("执行失败") : live ? L10n.tr("参数接收中") : L10n.tr("已完成")
                        CompactDisclosure(title: content.toolName ?? result?.toolName ?? message.toolName ?? L10n.tr("工具"), detail: status, symbol: "wrench.and.screwdriver") {
                            VStack(alignment: .leading, spacing: 10) {
                                if let arguments = toolArgumentsText(content), !arguments.isEmpty {
                                    Text(arguments).font(.orbisCaption(mono: true)).textSelection(.enabled)
                                }
                                if let result { Text(fullMessageText(result)).font(.orbisCaption(mono: true)).textSelection(.enabled) }
                            }
                        }
                    }
                case "artifact":
                    if let file = content.artifact {
                        OrbisMotionButton { if transfers.download(artifact: file) { downloadFlight?.launch() } } label: {
                            HStack(spacing: 8) {
                                OrbisActionSymbol(systemName: "arrow.down.doc")
                                FileNameText(name: file.fileName)
                            }.font(.orbisLabel()).frame(maxWidth: .infinity, minHeight: 44, alignment: .leading).padding(.horizontal, 12)
                        }.buttonStyle(NeuButtonStyle())
                    }
                default:
                    if let text = content.text, !text.isEmpty {
                        if message.role == "user" { Text(text).font(.orbisBody()).textSelection(.disabled) }
                        else { MarkdownMessage(text: text, streaming: streaming) }
                    }
                }
            }
            if message.content.contains(where: { $0.truncated == true }) { TruncatedMessageContent(message: message) }
            if message.content.isEmpty && message.toolSummary == nil { Text("…").foregroundStyle(OrbisPalette(scheme).secondary) }
        }.foregroundStyle(message.isError == true ? OrbisPalette(scheme).error : OrbisPalette(scheme).text)
    }
}

private struct TruncatedMessageContent: View {
    @EnvironmentObject private var store: OrbisStore
    @Environment(\.colorScheme) private var scheme
    let message: ChatMessage
    @State private var fullOpen = false
    @State private var fullEntryId = ""
    var body: some View {
        Group {
            if let truncated = message.content.first(where: { $0.truncated == true }) {
                OrbisStatusWithInfo(title: L10n.tr("内容已截断"), message:
                    (truncated.originalBytes.map { L10n.tr("有内容因超长被截断（原始 {0} 字节）", $0.formatted()) } ?? L10n.tr("有内容因超长被截断。"))
                    + (store.canSend ? "" : "\n" + L10n.tr("连接电脑并继续此会话后可取回完整内容。")))
                OrbisTextButton(title: L10n.tr("查看完整内容"), symbol: "doc.text.magnifyingglass") {
                    store.previewEntry(message.messageId)
                    fullEntryId = store.entryPreview?.entryId ?? message.messageId
                    fullOpen = true
                }.disabled(!store.canSend).accessibilityIdentifier("full-entry-" + message.messageId)
            }
        }.orbisBottomSheet(isPresented: $fullOpen) { FullMessageView(entryId: fullEntryId).orbisSheet([.large]) }
    }
}

private struct FullMessageView: View {
    @EnvironmentObject private var store: OrbisStore
    @OrbisDismiss private var dismiss
    @Environment(\.colorScheme) private var scheme
    @AppStorage("orbis.appearance") private var visualStyle = "mist"
    let entryId: String
    private var preview: EntryPreview? { store.entryPreview?.entryId == entryId ? store.entryPreview : nil }
    var body: some View {
        VStack(spacing: 16) {
            OrbisPageHeader(title: L10n.tr("完整内容"), closes: true, back: { dismiss() }) {
                OrbisCopyButton(label: L10n.tr("复制完整内容"), size: 40) {
                    guard let message = preview?.message else { return "" }
                    return fullMessageText(message)
                }.disabled(preview?.message == nil).accessibilityIdentifier("copy-full-entry-" + entryId)
            }
            if preview?.loading == true { ProgressView(L10n.tr("正在取回…")) }
            if let message = preview?.message {
                ScrollView([.horizontal, .vertical]) {
                    Text(fullMessageText(message)).font(.orbisLabel(mono: true)).textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading).padding(20)
                }
            } else if preview?.loading != true {
                OrbisNotice(text: preview?.error ?? L10n.tr("当前没有可显示的完整内容。"), error: true).padding(.horizontal, 20)
                OrbisActionButton(title: L10n.tr("重试"), symbol: "arrow.clockwise") { store.previewEntry(entryId) }.disabled(!store.canSend).padding(.horizontal, 20)
            }
            Spacer(minLength: 0)
        }.foregroundStyle(OrbisPalette(scheme).text).background(OrbisPalette(scheme).base.ignoresSafeArea())
            .onDisappear { if preview != nil { store.dismissPreview() } }
    }
}

/// A file name that truncates only the end of its stem; the extension always stays visible.
struct FileNameText: View {
    let name: String
    var body: some View {
        let parts = fileNameParts(name)
        HStack(spacing: 0) {
            Text(parts.stem).lineLimit(1).truncationMode(.tail)
            if !parts.ext.isEmpty { Text(parts.ext).lineLimit(1).fixedSize() }
        }.accessibilityElement(children: .ignore).accessibilityLabel(name)
    }
}

func fileNameParts(_ name: String) -> (stem: String, ext: String) {
    guard let dot = name.lastIndex(of: "."), dot != name.startIndex, dot < name.index(before: name.endIndex) else { return (name, "") }
    return (String(name[..<dot]), String(name[dot...]))
}

struct CompactDisclosure<Content: View>: View {
    @Environment(\.colorScheme) private var scheme
    @AppStorage("orbis.appearance") private var visualStyle = "mist"
    @Environment(\.orbisReduceMotion) private var reduced
    @Environment(\.chatReadingInteraction) private var readingInteraction
    let title: String
    var detail: String? = nil
    let symbol: String
    @ViewBuilder let content: () -> Content
    @State private var expanded = false
    var body: some View {
        let p = OrbisPalette(scheme)
        VStack(alignment: .leading, spacing: 0) {
            OrbisMotionButton { readingInteraction(); expanded.toggle() } label: {
                HStack(spacing: 8) {
                    OrbisActionSymbol(systemName: symbol)
                    Text(title).fontWeight(.medium).foregroundStyle(p.text).lineLimit(2)
                    if let detail { Text(detail).lineLimit(1) }
                    Spacer(minLength: 0)
                    Image(systemName: "chevron.down").imageScale(.small)
                        .rotationEffect(.degrees(expanded ? 180 : 0))
                        .animation(reduced ? nil : .orbisCollapse, value: expanded)
                }.font(.orbisLabel()).foregroundStyle(p.secondary).frame(minHeight: 40).contentShape(Rectangle())
            }.buttonStyle(.plain).accessibilityLabel("\(expanded ? L10n.tr("收起") : L10n.tr("展开"))\(title)\(detail.map { "，" + $0 } ?? "")")
            OrbisCollapse(expanded: expanded) {
                content().frame(maxWidth: .infinity, alignment: .leading).padding(.bottom, 10)
            }
        }.padding(.horizontal, 12).padding(.vertical, 4).neuSurface(inset: true, radius: 12, intensity: 0.4)
    }
}

struct ToolSummaryView: View {
    @EnvironmentObject private var store: OrbisStore
    @Environment(\.colorScheme) private var scheme
    @AppStorage("orbis.appearance") private var visualStyle = "mist"
    @State private var detailOpen = false
    let summary: ToolSummary
    var body: some View {
        CompactDisclosure(title: summary.toolName, detail: phase, symbol: summary.isError == true ? "exclamationmark.circle" : "wrench.and.screwdriver") {
            VStack(alignment: .leading, spacing: 10) {
                if summary.durationMs != nil || summary.exitCode != nil {
                    HStack {
                        if let duration = summary.durationMs { Text(String(format: L10n.tr("耗时 %.1f 秒"), Double(duration) / 1000)) }
                        if let code = summary.exitCode { Text(L10n.tr("退出码 {0}", code)) }
                    }.font(.orbisCaption()).foregroundStyle(.secondary)
                }
                ForEach(Array([summary.inputSummary, summary.resultSummary, summary.errorSummary].compactMap { $0 }.enumerated()), id: \.offset) { _, part in
                    Text(part.text).font(.orbisCaption(mono: true)).textSelection(.enabled)
                    if part.omitted { Text(L10n.tr("已省略部分内容")).font(.orbisCaption()).foregroundStyle(OrbisPalette(scheme).secondary) }
                }
                if let tool = summary.tool, let runtime = store.selectedRuntime {
                    ForEach(summary.contents, id: \.part) { part in
                        if part.availability != "absent" {
                            OrbisActionButton(title: L10n.tr("查看") + toolPartTitle(part.part), symbol: "doc.text.magnifyingglass") {
                                store.toolContent.open(runtimeId: runtime.runtimeId, locator: ToolLocator(tool: tool, part: part.part)); detailOpen = true
                            }.disabled(!store.canSend || part.readCapability == "none" || !["readable", "pending"].contains(part.availability))
                            if ["temporarily-unavailable", "unrecoverable"].contains(part.availability) {
                                Text(part.availability == "unrecoverable" ? L10n.tr("此部分内容已无法恢复") : L10n.tr("来源暂时无法提供此部分内容")).font(.orbisCaption()).foregroundStyle(.secondary)
                            }
                        }
                    }
                }
            }
        }.orbisBottomSheet(isPresented: $detailOpen, onDismiss: { store.toolContent.close() }) {
            ToolDetailView(reader: store.toolContent, title: summary.toolName).orbisSheet([.large])
        }
    }
    private var phase: String {
        switch summary.phase { case "started", "running": return L10n.tr("执行中"); case "cancelled": return L10n.tr("已取消"); default: return summary.isError == true ? L10n.tr("执行失败") : L10n.tr("已完成") }
    }
}

// MARK: - Markdown


@available(iOS 18.0, *)
private struct RevealRenderer: TextRenderer {
    let clock: RevealClock
    let base: Int
    let now: TimeInterval

    func draw(layout: Text.Layout, in ctx: inout GraphicsContext) {
        let firstIndex = layout.first?.lazy.compactMap { $0.characterIndices.first }.first
        guard let origin = firstIndex else {
            for line in layout { ctx.draw(line) }
            return
        }
        let settled = clock.settledBelow
        for line in layout {
            for run in line {
                guard let last = run.characterIndices.max(), base + origin.distance(to: last) >= settled else {
                    ctx.draw(run); continue
                }
                for index in run.indices {
                    let glyph = run[index]
                    guard let character = glyph.characterIndices.first else { ctx.draw(glyph); continue }
                    let progress = clock.progress(base + origin.distance(to: character), at: now)
                    if progress <= 0 { continue }
                    if progress >= 1 { ctx.draw(glyph); continue }
                    var copy = ctx
                    copy.opacity = progress
                    copy.addFilter(.blur(radius: RevealClock.blur * (1 - progress)))
                    copy.draw(glyph)
                }
            }
        }
    }
}

extension Text {
    /// iOS 17 has no text renderer; streamed text simply appears there.
    @ViewBuilder func reveal(_ clock: RevealClock, base: Int, now: TimeInterval) -> some View {
        if #available(iOS 18.0, *) { textRenderer(RevealRenderer(clock: clock, base: base, now: now)) }
        else { self }
    }
}

struct MarkdownMessage: View {
    @Environment(\.orbisReduceMotion) private var reduceMotion
    @EnvironmentObject private var transfers: FileTransfers
    @Environment(\.downloadFlight) private var downloadFlight
    @Environment(\.colorScheme) private var scheme
    @AppStorage("orbis.appearance") private var visualStyle = "mist"
    #if DEBUG
    @Environment(\.previewRevealTime) private var previewRevealTime
    #endif
    let text: String
    let streaming: Bool
    @State private var clock: RevealClock
    @State private var settleTick = 0
    @StateObject private var preparation: MarkdownPreparation

    init(text: String, streaming: Bool = false) {
        self.text = text
        self.streaming = streaming
        let cached = MarkdownDocuments.cached(text)
        _preparation = StateObject(wrappedValue: MarkdownPreparation(text: text))
        _clock = State(initialValue: RevealClock(known: cached?.length ?? 0))
    }

    var body: some View {
        // Preserve the measured row while a streamed replacement is parsed off-main.
        let prepared = MarkdownDocuments.cached(text) ?? preparation.prepared?.document
        let rows = prepared?.rows ?? []
        let length = prepared?.length ?? 0
        #if DEBUG
        let referenceNow = previewRevealTime ?? Date().timeIntervalSinceReferenceDate
        #else
        let referenceNow = Date().timeIntervalSinceReferenceDate
        #endif
        let revealEnabled = streaming && !reduceMotion
        // When the stream ends, characters already queued finish revealing instead of jumping in.
        let animating = !reduceMotion && settleTick >= 0 && clock.isAnimating(at: referenceNow)
        let visibleClock = revealEnabled || animating ? clock : RevealClock(known: length)
        TimelineView(.animation(minimumInterval: nil, paused: !animating)) { context in
            #if DEBUG
            let renderTime = previewRevealTime ?? max(context.date.timeIntervalSinceReferenceDate, Date().timeIntervalSinceReferenceDate)
            #else
            let renderTime = max(context.date.timeIntervalSinceReferenceDate, Date().timeIntervalSinceReferenceDate)
            #endif
            let now = reduceMotion ? TimeInterval.greatestFiniteMagnitude : renderTime
            VStack(alignment: .leading, spacing: 12) {
                ForEach(rows) { row in rowView(row, html: prepared?.mathHTML[row.id], clock: visibleClock, now: now) }
            }
        }.font(.orbisBody()).textSelection(.enabled)
            .task(id: text) {
                preparation.update(text, streaming: streaming)
            }
            .onDisappear { preparation.cancel() }
            .onChange(of: preparation.prepared?.document.length) { _, next in
                guard let next else { return }
                if revealEnabled { clock.observe(length: next, at: referenceNow) }
                else { clock = RevealClock(known: next) }
            }
            .environment(\.openURL, OpenURLAction { url in
                if ["http", "https", "mailto"].contains(url.scheme?.lowercased() ?? "") { return .systemAction }
                let path = url.isFileURL ? url.path : url.absoluteString.removingPercentEncoding ?? url.absoluteString
                if transfers.download(path: path) { downloadFlight?.launch() }
                return .handled
            })
            .onChange(of: text) { previous, value in
                if revealEnabled && value.hasPrefix(previous) { clock.observe(length: length, at: referenceNow) }
                else { clock = RevealClock(known: length) }
            }
            // Starting to stream takes the current text as the baseline; ending lets the queue drain.
            .onChange(of: revealEnabled) { _, enabled in
                preparation.update(text, streaming: streaming)
                if enabled { clock = RevealClock(known: length) }
            }
            .task(id: clock.end) {
                // Pause the timeline once the last character has settled.
                let wait = clock.end - Date().timeIntervalSinceReferenceDate
                guard wait > 0 else { return }
                try? await Task.sleep(nanoseconds: UInt64((wait + 0.05) * 1_000_000_000))
                settleTick += 1
            }
    }

    @ViewBuilder private func rowView(_ row: MarkdownRow, html: String?, clock: RevealClock, now: TimeInterval) -> some View {
        let p = OrbisPalette(scheme)
        switch row.kind {
        case .spacer: Spacer().frame(height: 2)
        case .divider: Rectangle().fill(p.outline).frame(height: 1)
        case .image(let alt, let url): MarkdownImageView(alt: alt, url: url)
        case .table(let section): MarkdownTableView(section: section)
        case .code(let language, let code): CodeBlockView(text: code, language: language, clock: clock, base: row.base, now: now)
        case .quote(let value):
            HStack(alignment: .top, spacing: 10) {
                Capsule().fill(p.accent.opacity(0.6)).frame(width: 3)
                mathOrText(value, html: html, clock: clock, base: row.base, now: now, color: p.secondary)
                    .foregroundStyle(p.secondary).frame(maxWidth: .infinity, alignment: .leading)
            }.fixedSize(horizontal: false, vertical: true)
        case .heading(let level, let value):
            mathOrText(value, html: html, clock: clock, base: row.base, now: now, size: level <= 2 ? OrbisTextSize.title : OrbisTextSize.body, bold: true)
                .font(level <= 2 ? .orbisTitle() : .orbisBody(.semibold))
                .padding(.top, 4).accessibilityAddTraits(.isHeader)
        case .task(let checked, let value):
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                OrbisActionSymbol(systemName: checked ? "checkmark.square.fill" : "square").orbisIconBaseline(OrbisTextSize.body)
                mathOrText(value, html: html, clock: clock, base: row.base, now: now)
            }
        case .bullet(let indent, let value):
            HStack(alignment: .firstTextBaseline, spacing: 9) {
                Text("•").reveal(clock, base: row.base, now: now)
                mathOrText(value, html: html, clock: clock, base: row.base + 1, now: now)
            }.padding(.leading, CGFloat(min(indent, 12)) * 6)
        case .text(let value):
            mathOrText(value, html: html, clock: clock, base: row.base, now: now)
        }
    }
    @ViewBuilder private func mathOrText(_ value: AttributedString, html: String?, clock: RevealClock, base: Int, now: TimeInterval,
        size: CGFloat = OrbisTextSize.body, bold: Bool = false, color: Color? = nil) -> some View {
        if let html {
            MathFragment(html: html, source: value, size: size, bold: bold, color: color ?? OrbisPalette(scheme).text,
                clock: clock, base: base, now: now)
        } else { Text(value).reveal(clock, base: base, now: now) }
    }
}

private struct CodeBlockView: View {
    @Environment(\.colorScheme) private var scheme
    @AppStorage("orbis.appearance") private var visualStyle = "mist"
    let text: String
    let language: String
    let clock: RevealClock
    let base: Int
    let now: TimeInterval
    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(language).font(.orbisCaption(mono: true)).foregroundStyle(OrbisPalette(scheme).secondary)
                Spacer()
                OrbisCopyButton(label: L10n.tr("复制代码"), size: 28) { text }
            }.padding(.top, -6).padding(.trailing, -8)
            ScrollView(.horizontal) {
                Text(text).reveal(clock, base: base, now: now)
                    .font(.orbisLabel(mono: true)).fixedSize(horizontal: true, vertical: false).textSelection(.enabled).padding(.bottom, 4)
            }
        }.neuSurface(inset: true, radius: 12, intensity: 0.4, padding: 12)
    }
}

private struct SlashPickerView: View {
    @EnvironmentObject private var store: OrbisStore
    @Environment(\.colorScheme) private var scheme
    @AppStorage("orbis.appearance") private var visualStyle = "mist"
    let runtime: RuntimeSummary
    @Binding var selected: String?
    @Binding var input: String
    let onHistory: () -> Void
    @State private var contentHeight: CGFloat = 0
    private var commands: [SlashCommand] { store.commands[runtime.runtimeId] ?? [] }
    var body: some View {
        let p = OrbisPalette(scheme)
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 10) {
                if let selected, let command = commands.first(where: { $0.name == selected }), let argument = command.argument {
                    if let hint = argument.hint {
                        HStack { Text("/" + command.name).font(.orbisLabel(mono: true)); Spacer()
                            OrbisInfoButton(title: "/" + command.name, message: command.source == "builtin" ? L10n.hostText(hint) : hint)
                        }
                    }
                    ForEach(argument.options ?? []) { option in
                        HStack(spacing: 0) {
                            OrbisMotionButton { input = "/\(command.name) \(option.value)" } label: {
                                Text(option.label).font(.orbisLabel(.medium))
                                    .frame(maxWidth: .infinity, minHeight: 48, alignment: .leading).padding(.horizontal, 12)
                            }.buttonStyle(NeuButtonStyle(radius: 12))
                            if let description = option.description, !description.isEmpty {
                                OrbisInfoButton(title: option.label, message: command.source == "builtin" ? L10n.hostText(description) : description)
                            }
                        }
                    }
                } else {
                    let query = String(input.trimmingCharacters(in: .whitespacesAndNewlines).dropFirst()).lowercased()
                    let filtered = commands.filter { query.isEmpty || $0.name.lowercased().contains(query) }
                        .sorted { ($0.source == "builtin" ? 0 : 1, $0.name) < ($1.source == "builtin" ? 0 : 1, $1.name) }
                    if filtered.isEmpty { Text(commands.isEmpty ? L10n.tr("当前会话尚未提供可用命令") : L10n.tr("没有匹配的命令")).font(.orbisCaption()).foregroundStyle(p.secondary).padding(12) }
                    ForEach(filtered) { command in
                        HStack(spacing: 0) {
                            OrbisMotionButton {
                                if command.name == "tree" { input = ""; selected = nil; onHistory() }
                                else { selected = command.name; input = "/" + command.name + (command.argument == nil ? "" : " ") }
                            } label: {
                                HStack(spacing: 10) {
                                    Text("/" + command.name).font(.orbisLabel(.semibold, mono: true))
                                    Spacer(minLength: 0)
                                    if let source = slashSourceTitle(command.source) { Text(source).font(.orbisCaption()).foregroundStyle(.tint) }
                                }.frame(minHeight: 48).padding(.horizontal, 12)
                            }.buttonStyle(NeuButtonStyle(radius: 12))
                            if let description = command.description, !description.isEmpty {
                                OrbisInfoButton(title: "/" + command.name, message: command.source == "builtin" ? L10n.hostText(description) : description)
                            }
                        }
                    }
                }
            }.padding(8)
                .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { contentHeight = $0 }
        }.frame(height: min(contentHeight, 180)).scrollBounceBehavior(.basedOnSize).padding(.horizontal, 12)
    }
}

struct PermissionsView: View {
    @EnvironmentObject private var store: OrbisStore
    @OrbisDismiss private var dismiss
    @Environment(\.colorScheme) private var scheme
    @AppStorage("orbis.appearance") private var visualStyle = "mist"
    let runtime: RuntimeSummary
    @State private var proposedSetting: String?
    @State private var proposedValue: String?
    var body: some View {
        let p = OrbisPalette(scheme)
        VStack(spacing: 16) {
            OrbisPageHeader(title: L10n.tr("当前会话权限"), closes: true, back: { dismiss() }) {
                if let permissions = store.selectedRuntime?.permissionManagement {
                    OrbisInfoButton(title: L10n.tr("当前会话权限"), message: L10n.hostText(permissions.details), identifier: "permission-info")
                }
            }
            if let permissions = store.selectedRuntime?.permissionManagement {
                Text(L10n.hostSummary(permissions.summary)).font(.orbisLabel()).foregroundStyle(p.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 16)
                OrbisPermissionChoices(settings: permissions.settings, values: proposedValues(permissions),
                    currentValues: Dictionary(uniqueKeysWithValues: permissions.settings.compactMap { item in item.currentValue.map { (item.id, $0) } }),
                    enabled: store.canSend && store.pendingActionIds.isEmpty,
                    onCategory: { proposedSetting = nil; proposedValue = nil }) { id, value in
                        proposedSetting = id; proposedValue = value
                    }
            } else {
                Text(L10n.tr("电脑端管理")).font(.orbisLabel()); Spacer()
            }
            OrbisActionButton(title: L10n.tr("应用到当前会话")) {
                guard let setting = proposedSetting, let value = proposedValue else { return }
                if store.updatePermission(settingId: setting, value: value) { dismiss() }
            }.disabled(!canApply)
                .padding(.horizontal, 16).padding(.bottom, 16).accessibilityIdentifier("permissions-apply")
        }.background(p.base.ignoresSafeArea())
            .onChange(of: store.selectedRuntimeId) { _, _ in dismiss() }
    }
    private var canApply: Bool {
        guard let id = proposedSetting, let value = proposedValue,
              let setting = store.selectedRuntime?.permissionManagement?.settings.first(where: { $0.id == id }) else { return false }
        return value != setting.currentValue && store.canUpdatePermission(settingId: id, value: value)
    }
    private func proposedValues(_ permissions: PermissionManagement) -> [String: String] {
        var values = Dictionary(uniqueKeysWithValues: permissions.settings.compactMap { item in item.currentValue.map { (item.id, $0) } })
        if let proposedSetting, let proposedValue { values[proposedSetting] = proposedValue }
        return values
    }

}

private struct MarkdownTableView: View {
    @Environment(\.colorScheme) private var scheme
    let section: MarkdownTextSection
    var body: some View {
        ScrollView(.horizontal) {
            Grid(alignment: .topLeading, horizontalSpacing: 0, verticalSpacing: 0) {
                ForEach(Array(section.rows.enumerated()), id: \.offset) { rowIndex, row in
                    GridRow(alignment: .top) {
                        ForEach(Array((section.rows.first ?? []).indices), id: \.self) { column in
                            cell(row: rowIndex, column: column)
                                .font(.orbisLabel(rowIndex == 0 ? .semibold : .regular))
                                .frame(width: 150, alignment: alignment(column)).padding(10)
                                .frame(maxHeight: .infinity, alignment: .top)
                                // Rows separate by a lightness step, not by drawn grid lines.
                                .background(OrbisLayerFill(offset: 1, opacity: rowIndex == 0 ? 1 : rowIndex % 2 == 0 ? 0.5 : 0))
                        }
                    }
                }
            }
        }.neuSurface(inset: true, radius: 12, intensity: 0.4).clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous)).textSelection(.enabled)
    }
    @ViewBuilder private func cell(row: Int, column: Int) -> some View {
        let value = row < section.inlineRows.count && column < section.inlineRows[row].count ? section.inlineRows[row][column] : AttributedString("")
        if row < section.mathRows.count, column < section.mathRows[row].count, let html = section.mathRows[row][column] {
            MathFragment(html: html, source: value, size: OrbisTextSize.label, bold: row == 0, color: OrbisPalette(scheme).text,
                alignment: alignment(column) == .center ? "center" : alignment(column) == .trailing ? "right" : "left")
        } else { Text(value) }
    }
    private func alignment(_ column: Int) -> Alignment {
        let markers = section.text.components(separatedBy: "|")
        guard column < markers.count else { return .leading }
        let marker = markers[column]
        if marker.hasPrefix(":") && marker.hasSuffix(":") { return .center }
        return marker.hasSuffix(":") ? .trailing : .leading
    }
}

private struct MarkdownImageView: View {
    @Environment(\.colorScheme) private var scheme
    @AppStorage("orbis.appearance") private var visualStyle = "mist"
    let alt: String
    let url: URL
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            AsyncImage(url: url) { phase in
                if let image = phase.image { image.resizable().scaledToFit().frame(maxHeight: 280).accessibilityLabel(alt.isEmpty ? L10n.tr("消息图片") : alt) }
                else if phase.error != nil { Label(alt.isEmpty ? L10n.tr("图片未能加载") : alt, systemImage: "photo").font(.orbisLabel()) }
                else { ProgressView().frame(maxWidth: .infinity, minHeight: 80) }
            }
            Link(alt.isEmpty ? L10n.tr("打开图片") : alt, destination: url).font(.orbisCaption())
        }.neuSurface(inset: true, radius: 12, intensity: 0.4, padding: 12)
    }
}


struct QueuedMessagesView: View {
    @EnvironmentObject private var store: OrbisStore
    @Environment(\.colorScheme) private var scheme
    @AppStorage("orbis.appearance") private var visualStyle = "mist"
    let runtimeId: String
    var body: some View {
        let items = store.queuePanelItems(runtimeId)
        if items.count == 1, let item = items.first {
            card(item).frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 16).padding(.top, 10)
                .accessibilityElement(children: .contain).accessibilityIdentifier("queued-messages")
        } else if !items.isEmpty {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 12) {
                    ForEach(items) { item in card(item).frame(width: 260, alignment: .leading) }
                }.padding(.horizontal, 16).padding(.top, 10)
            }.frame(maxHeight: 140).accessibilityIdentifier("queued-messages")
        }
    }
    private func card(_ item: QueuedMessage) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(deliveryTitle(item.delivery) + L10n.tr("，") + queueStateTitle(item.state)).font(.orbisCaption(.semibold))
                Spacer(minLength: 8)
                if item.state == "accepted" {
                    // ADR-0049 §6.3：撤回结果不明时回到原位并标“撤回未确认”，核对前不能再撤回。
                    let unconfirmed = store.unconfirmedQueueCancellations(runtimeId).contains(item.queueId)
                    OrbisTextButton(title: unconfirmed ? L10n.tr("撤回未确认") : L10n.tr("撤回"), symbol: "xmark") { _ = store.cancelQueuedMessage(item.queueId) }
                        .disabled(!store.canSend || unconfirmed).accessibilityIdentifier("queue-cancel-" + item.queueId)
                }
            }
            Text(item.text).font(.orbisCaption()).lineLimit(3).textSelection(.enabled)
            if let error = item.error { Text(error).font(.orbisCaption()).foregroundStyle(OrbisPalette(scheme).error) }
        }.padding(12).neuSurface(inset: true, radius: 12, intensity: 0.4)
    }
}

/// Notices float over the top of the transcript. Each one is a single opaque banner that
/// carries its own close action and, when unverified, the re-check action inside it.
struct RuntimeNoticesView: View {
    @EnvironmentObject private var store: OrbisStore
    @EnvironmentObject private var notifications: RuntimeNotifications
    @Environment(\.colorScheme) private var scheme
    @AppStorage("orbis.appearance") private var visualStyle = "mist"
    let runtimeId: String
    /// 只有 Codex（含桌面版）会上报通知来源；其他运行时没有「待核对」可言，不显示核对提示。
    let supported: Bool
    var body: some View {
        if let projection = notifications.visibleProjection(runtimeId), !projection.items.isEmpty || (supported && !projection.complete) {
            let unverified = supported && (projection.verification == "unknown" || !projection.complete || store.connection != .secured)
            ScrollView {
                VStack(spacing: 8) {
                    if projection.items.isEmpty {
                        banner(text: L10n.tr("通知状态待核对"), error: false, recheck: unverified, close: nil)
                    }
                    ForEach(Array(projection.items.enumerated()), id: \.element.id) { index, notice in
                        banner(text: notice.message, error: notice.severity != "info",
                               recheck: index == 0 && (unverified || (supported && notice.verification == "unknown")),
                               close: { store.dismissNotification(runtimeId: runtimeId, notificationId: notice.notificationId) })
                    }
                }.padding(.vertical, 6)
            }.frame(maxHeight: 180).scrollBounceBehavior(.basedOnSize).accessibilityIdentifier("runtime-notifications")
        }
    }

    private func banner(text: String, error: Bool, recheck: Bool, close: (() -> Void)?) -> some View {
        let p = OrbisPalette(scheme)
        return HStack(alignment: .top, spacing: 10) {
            OrbisActionSymbol(systemName: error ? "exclamationmark.circle" : "info.circle")
                .foregroundStyle(error ? p.error : p.secondary).orbisIconBaseline(OrbisTextSize.label)
            VStack(alignment: .leading, spacing: 6) {
                Text(text).font(.orbisLabel()).foregroundStyle(error ? p.error : p.text)
                    .fixedSize(horizontal: false, vertical: true)
                if recheck {
                    HStack(spacing: 10) {
                        Text(L10n.tr("通知状态待核对")).font(.orbisCaption()).foregroundStyle(p.secondary)
                        OrbisMotionButton { notifications.sync(runtimeId: runtimeId) } label: {
                            Label { Text(L10n.tr("重新核对")) } icon: { OrbisActionSymbol(systemName: "arrow.clockwise") }
                                .font(.orbisCaption(.semibold))
                        }.buttonStyle(.plain).foregroundStyle(.tint).disabled(store.connection != .secured)
                    }
                }
            }.frame(maxWidth: .infinity, alignment: .leading)
            if let close {
                OrbisIconButton(symbol: "xmark", label: L10n.tr("关闭通知"), size: 28, action: close)
                    .orbisNested().disabled(store.connection != .secured)
            }
        }.neuSurface(radius: OrbisRadius.control, intensity: 0.6, padding: 12)
    }
}

/// SC84: the same configuration choices as Android, using the shared iOS sheet
/// and selection rows. Submenus keep the composer draft and the current turn intact.
private struct SessionModelConfigurationView: View {
    @EnvironmentObject private var store: OrbisStore
    @EnvironmentObject private var agent: AgentState
    @Environment(\.colorScheme) private var scheme
    @OrbisDismiss private var dismiss
    @State private var setting: String?
    @State private var diagnosticsOpen = false
    let runtime: RuntimeSummary
    private var commands: [SlashCommand] { store.commands[runtime.runtimeId] ?? [] }
    private var command: SlashCommand? { commands.first { $0.name == setting } }
    private func select(_ name: String, _ value: String) {
        guard store.selectedRuntime?.runtimeId == runtime.runtimeId,
              store.selectedRuntime?.sessionId == runtime.sessionId else { return }
        if store.executeSlash(name, args: value) { dismiss() }
    }
    var body: some View {
        let presentation = store.sessionModelPresentation(runtime)
        VStack(spacing: 0) {
            OrbisPageHeader(title: L10n.tr("模型与深度"), closes: true, back: { dismiss() }) {
                OrbisIconButton(symbol: "info.circle", label: L10n.tr("会话信息")) { diagnosticsOpen = true }
            }
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    if presentation.showsCurrent {
                        Text(L10n.tr("本轮使用")).font(.orbisCaption()).foregroundStyle(OrbisPalette(scheme).secondary)
                        Text(presentation.model ?? L10n.tr("模型未确认"))
                            .font(.orbisBody(.semibold)).accessibilityIdentifier("session-current-model")
                        if presentation.current?.thinkingKnown == true {
                            Text(presentation.current?.thinkingLevel ?? L10n.tr("默认深度")).font(.orbisLabel())
                        }
                    }
                    if let title = presentation.selectionTitle {
                        Text(title).font(.orbisCaption()).foregroundStyle(OrbisPalette(scheme).secondary)
                        Text(runtime.model.map { $0.name ?? $0.id } ?? L10n.tr("未确认"))
                            .font(.orbisBody(.semibold)).accessibilityIdentifier("session-selected-model")
                        Text(runtime.thinkingLevel ?? L10n.tr("默认深度")).font(.orbisLabel())
                    }
                    if let failure = store.sessionConfigFailure(runtime.runtimeId) {
                        Text(failure.message).font(.orbisLabel()).foregroundStyle(OrbisPalette(scheme).error)
                        OrbisActionButton(title: L10n.tr("重试")) { select(failure.setting, failure.value) }.disabled(!store.canSend)
                    }
                    ForEach(OperationKinds.configSettings, id: \.self) { name in
                        if let progress = store.configStatus(runtime.runtimeId, setting: name) {
                            Text(L10n.tr("{0}，{1}", progress.label, L10n.matches(progress.mark, source: "切换中") ? L10n.tr("保存中") : progress.mark))
                                .font(.orbisLabel()).foregroundStyle(OrbisPalette(scheme).secondary)
                        }
                    }
                    if presentation.indicator == L10n.tr("未确认") {
                        OrbisActionButton(title: L10n.tr("核对配置")) { agent.subscribe(runtime: runtime, force: true) }.disabled(!store.canSend)
                    }
                    if let command {
                        OrbisActionButton(title: L10n.tr("返回")) { setting = nil }
                        if command.argument?.options?.isEmpty != false {
                            Text(L10n.tr((command.argument?.optionCatalog?.count ?? 0) > 0 ? "加载中…" : "暂无可用选项")).font(.orbisLabel())
                        }
                        ForEach(command.argument?.options ?? []) { option in
                            OrbisChoiceRow(title: L10n.hostText(option.label), subtitle: "",
                                selected: OperationKinds.confirmedValue(runtime, setting: command.name) == option.value) {
                                select(command.name, option.value)
                            }.disabled(!store.canSend).accessibilityIdentifier("session-config-option-" + option.value)
                        }
                    } else {
                        configButton("模型", name: "model")
                        configButton("思考深度", name: OperationKinds.depthCommand(commands))
                    }
                }.padding(20).frame(maxWidth: .infinity, alignment: .leading)
            }.accessibilityIdentifier("session-model-configuration")
        }
        .onChange(of: setting) { old, next in
            if let old { store.cancelMenuOptions(runtimeId: runtime.runtimeId, name: old) }
            if let next { store.loadMenuOptions(runtimeId: runtime.runtimeId, name: next) }
        }
        .onDisappear { if let setting { store.cancelMenuOptions(runtimeId: runtime.runtimeId, name: setting) } }
        .orbisBottomSheet(isPresented: $diagnosticsOpen) { RuntimeInfoView(runtime: runtime).orbisSheet([.large]) }
    }
    private func configButton(_ title: String, name: String?) -> some View {
        OrbisActionButton(title: L10n.tr(title)) { setting = name }
            .disabled(!store.canSend || !commands.contains { $0.name == name && $0.argument?.kind == "select" })
            .accessibilityIdentifier("session-config-" + (name ?? "depth"))
    }
}

private struct RuntimeInfoView: View {
    @EnvironmentObject private var store: OrbisStore
    @EnvironmentObject private var agent: AgentState
    @OrbisDismiss private var dismiss
    let runtime: RuntimeSummary
    private var snapshot: AgentSnapshot? { agent.snapshots[runtime.runtimeId] }
    private func ready(_ name: String) -> Bool { snapshot?.missing[name] == nil && (snapshot?.domains[name]?.availability ?? "ready") == "ready" }
    var body: some View {
        VStack(spacing: 0) {
            OrbisPageHeader(title: L10n.tr("会话信息"), closes: true, back: { dismiss() }) {
                OrbisIconButton(symbol: "arrow.clockwise", label: L10n.tr("核对会话状态")) { agent.subscribe(runtime: runtime, force: true) }.disabled(!store.canSend)
            }
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    StatusSection(title: L10n.tr("模型与上下文")) {
                        StatusFact(label: L10n.tr(runtime.status == "idle" ? "模型" : "后续模型"), value: store.configStatus(runtime.runtimeId, setting: "model").map { $0.label + L10n.tr("（") + $0.mark + L10n.tr("）") }
                                   ?? (ready("model") ? runtime.model?.name ?? runtime.model?.id ?? L10n.tr("未报告") : L10n.tr("状态待核对")))
                        StatusFact(label: L10n.tr("供应商"), value: ready("model") ? runtime.model?.provider ?? L10n.tr("未报告") : L10n.tr("状态待核对"))
                        StatusFact(label: L10n.tr(runtime.status == "idle" ? "思考级别" : "后续思考深度"), value: store.configStatus(runtime.runtimeId, setting: "thinking").map { $0.label + L10n.tr("（") + $0.mark + L10n.tr("）") }
                                   ?? (ready("model") ? runtime.thinkingLevel ?? L10n.tr("来源未报告") : L10n.tr("状态待核对")))
                        StatusFact(label: L10n.tr("上下文"), value: ready("context") ? contextText : L10n.tr("状态待核对"))
                    }
                    StatusSection(title: L10n.tr("执行状态")) {
                        StatusFact(label: L10n.tr("当前状态"), value: ready("execution") ? runtime.presentationTitle : L10n.tr("状态待核对"))
                        if ready("execution"), let execution = snapshot?.domains["execution"]?.value {
                            StatusFact(label: L10n.tr("重试"), value: activity(execution["retry"]))
                            StatusFact(label: L10n.tr("上下文压缩"), value: activity(execution["compaction"]))
                            if let start = execution["turn"]["startedAt"].number {
                                TimelineView(.periodic(from: .now, by: 1)) { context in
                                    let duration = execution["turn"]["durationMs"].number ?? max(0, context.date.timeIntervalSince1970 * 1000 - start)
                                    StatusFact(label: execution["turn"]["durationMs"] == .null ? L10n.tr("本轮已运行") : L10n.tr("本轮耗时"), value: String(format: L10n.tr("%.1f 秒"), duration / 1000))
                                }
                            }
                        }
                    }
                    ForEach((store.commands[runtime.runtimeId] ?? []).filter { ["model", "thinking"].contains($0.name) && $0.argument?.options?.isEmpty == false }) { command in
                        StatusSection(title: command.source == "builtin" ? L10n.hostText(command.description ?? command.name) : command.description ?? command.name) {
                            ForEach(command.argument?.options ?? []) { option in
                                OrbisActionButton(title: option.label) { _ = store.executeSlash(command.name, args: option.value) }.disabled(!store.canSend)
                            }
                        }
                    }
                    StatusSection(title: L10n.tr("状态来源")) {
                        if let snapshot {
                            if let error = snapshot.error { OrbisNotice(text: error, error: true) }
                            ForEach(AgentState.domainNames, id: \.self) { name in
                                StatusFact(label: agentDomainTitle(name), value: snapshot.missing[name] ?? snapshot.domains[name].map { $0.availability == "ready" ? ($0.completeness == "complete" || $0.projectionComplete == true ? L10n.tr("已核对") : L10n.tr("部分状态")) : L10n.tr("当前不可用") } ?? L10n.tr("尚未读取"))
                            }
                        } else { Text(L10n.tr("尚未读取会话状态")).font(.orbisLabel()) }
                    }
                }.padding(20)
            }
        }
    }
    private var contextText: String {
        guard let usage = runtime.contextUsage else { return L10n.tr("来源未报告") }
        var parts: [String] = []
        if let percent = contextUsagePercent(usage) { parts.append(String(format: "%.1f%%", percent)) }
        if let tokens = usage.tokens { parts.append("\(tokens.formatted()) tokens") }
        if let window = usage.contextWindow { parts.append(L10n.tr("窗口 {0}", window.formatted())) }
        return parts.isEmpty ? L10n.tr("来源未报告") : parts.joined(separator: L10n.tr("，"))
    }
    private func activity(_ value: HostJSON) -> String {
        guard value != .null, value.string != "unavailable" else { return L10n.tr("来源尚未提供") }
        let phase = ["idle": L10n.tr("空闲"), "running": L10n.tr("进行中"), "failed": L10n.tr("失败")][value["phase"].string ?? ""] ?? L10n.tr("待核对")
        return [phase, value["attempt"].number.map { L10n.tr("第 {0} 次", Int($0)) }, value["detail"].string].compactMap { $0 }.joined(separator: L10n.tr("，"))
    }
}

private func agentDomainTitle(_ name: String) -> String {
    ["identity": L10n.tr("会话身份"), "availability": L10n.tr("可用性"), "execution": L10n.tr("执行"), "delivery": L10n.tr("消息队列"), "interactions": L10n.tr("交互"), "permissions": L10n.tr("权限"), "model": L10n.tr("模型"), "context": L10n.tr("上下文"), "capabilities": L10n.tr("可用命令"), "resources": L10n.tr("资源"), "providerBinding": L10n.tr("供应商归属"), "workspaceRef": L10n.tr("工作区"), "artifacts": L10n.tr("附件"), "records": L10n.tr("诊断记录")][name] ?? name
}

/// ADR-0062: read-only native task inventory, independent of the main composer state.
struct BackgroundTasksView: View {
    let tasks: BackgroundTaskInventory
    @State private var expanded = false
    @Environment(\.colorScheme) private var scheme
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            OrbisMotionButton { expanded.toggle() } label: {
                HStack(spacing: 8) {
                    OrbisActionSymbol(systemName: expanded ? "chevron.down" : "chevron.right")
                    Text(tasks.panelTitle).font(.orbisCaption(.medium)).lineLimit(2)
                    Spacer(minLength: 0)
                }.frame(minHeight: 48).contentShape(Rectangle())
            }.buttonStyle(.plain).accessibilityIdentifier("background-tasks-toggle")
                .accessibilityValue(expanded ? L10n.tr("已展开") : L10n.tr("已收起"))
            OrbisCollapse(expanded: expanded) {
                ScrollView {
                    VStack(alignment: .leading, spacing: 10) {
                        if let notice = tasks.inventoryNotice {
                            Text(notice).font(.orbisCaption())
                        }
                        ForEach(tasks.items) { task in
                            VStack(alignment: .leading, spacing: 4) {
                                HStack(alignment: .top, spacing: 8) {
                                    Text(task.title.isEmpty ? task.kind : task.title).font(.orbisLabel()).lineLimit(2)
                                    Spacer(minLength: 0)
                                    Text(task.statusTitle).font(.orbisCaption()).fixedSize(horizontal: true, vertical: false)
                                }
                                Text(task.kind).font(.orbisCaption()).foregroundStyle(OrbisPalette(scheme).secondary)
                                if let parentId = task.parentId, let parent = tasks.items.first(where: { $0.id == parentId }) {
                                    Text(L10n.tr("来自：{0}", parent.title)).font(.orbisCaption()).lineLimit(1)
                                }
                            }.accessibilityElement(children: .combine).accessibilityIdentifier("background-task-\(task.id)")
                        }
                    }.frame(maxWidth: .infinity, alignment: .leading).padding(.bottom, 8)
                }.frame(maxHeight: 160)
            }
        }.padding(.horizontal, 16).foregroundStyle(OrbisPalette(scheme).secondary)
    }
}
