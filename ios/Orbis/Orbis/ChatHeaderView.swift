import SwiftUI

private struct ChatHistoryProgress: View {
    @Environment(\.colorScheme) private var scheme
    @Environment(\.orbisReduceMotion) private var reduceMotion
    @Environment(\.orbisVisualActive) private var visualActive
    let loading: Bool
    let viewport: ChatViewportController
    private enum Phase: Equatable {
        case pull, armed, loading
        var title: String {
            switch self {
            case .pull: L10n.tr("下拉加载历史")
            case .armed: L10n.tr("松手加载")
            case .loading: L10n.tr("正在加载更早的历史…")
            }
        }
    }

    var body: some View {
        let progress = viewport.historyPullVisualProgress
        let phase: Phase = loading ? .loading : progress >= 1 ? .armed : .pull
        let palette = OrbisPalette(scheme)
        let color = phase == .armed ? palette.accent : palette.secondary
        HStack(spacing: 8) {
            ZStack {
                if loading {
                    ProgressView().controlSize(.small).transition(.opacity)
                } else {
                    ZStack {
                        Circle().stroke(palette.secondary.opacity(0.2), lineWidth: 2)
                        Circle().trim(from: 0, to: progress)
                            .stroke(color, style: StrokeStyle(lineWidth: 2, lineCap: .round))
                            .rotationEffect(.degrees(-90))
                            .animation(nil, value: progress)
                        Image(systemName: "arrow.down").font(.system(size: 9, weight: .semibold))
                            .foregroundStyle(color)
                    }.padding(1).transition(.opacity)
                }
            }.frame(width: 18, height: 18).accessibilityHidden(true)
            Text(phase.title).font(.orbisLabel()).foregroundStyle(color)
                .contentTransition(.opacity)
        }
        .padding(.horizontal, 12).padding(.vertical, 8)
        .neuSurface(radius: OrbisRadius.control, intensity: 0.6, concentric: false)
        .animation(reduceMotion || !visualActive ? nil : InteractionMotion.state, value: phase)
        // Position and ring follow the finger, not the discrete phase animation.
        .offset(y: loading || reduceMotion ? 0 : -6 * (1 - progress))
        .opacity(loading ? 1 : 0.65 + 0.35 * progress)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(phase.title)
        .accessibilityIdentifier(loading ? "chat-history-loading" : "chat-history-pull")
    }
}

struct ChatNoticesRegion: View, Equatable {
    let model: ChatScreenModel
    let actions: ChatSessionActions
    let mountToken: UUID
    private var ownsViewport: Bool { model.ownsMount(target: actions.target, token: mountToken) }
    let viewport: ChatViewportController
    let setComposerFocused: (Bool) -> Void
    let onBack: () -> Void
    let retryHistory: () -> Void
    let onReturnToNewSession: () -> Void
    @State private var confirmingEnd = false
    @Environment(\.colorScheme) private var scheme
    @Environment(\.orbisReduceMotion) private var reduceMotion
    @Environment(\.orbisVisualActive) private var visualActive
    static func == (lhs: Self, rhs: Self) -> Bool { lhs.model === rhs.model && lhs.actions == rhs.actions && lhs.mountToken == rhs.mountToken }
    private var showQuestion: Bool { viewport.showQuestionReminder && viewport.readingQuestion != nil }
    private var facts: ChatNoticesState { model.notices }
    private var hasNotices: Bool {
        guard let projection = facts.notice else { return false }
        return !projection.items.isEmpty || (facts.supported && !projection.complete)
    }
    var body: some View {
        let _ = ChatSchedulingTrace.regionBody(.notices)
        let _ = ChatDebugProbes.rendered(.notices)
        Group {
            if let launch = facts.launch, facts.isLaunchPage, launch.failure != nil || launch.unconfirmed {
                let unconfirmed = launch.unconfirmed && !launch.rejected
                VStack(alignment: .leading, spacing: 8) {
                    OrbisStatusWithInfo(title: unconfirmed ? L10n.tr("启动未确认") : L10n.tr("启动失败"),
                        message: launch.failure ?? L10n.tr("启动未确认：电脑端尚未报告会话上线，请稍后在会话列表中查看。"), error: !unconfirmed)
                    ViewThatFits(in: .horizontal) {
                        HStack(spacing: 12) { launchActions(launch) }.fixedSize(horizontal: true, vertical: false)
                        VStack(alignment: .leading, spacing: 8) { launchActions(launch) }
                    }
                }.neuSurface(radius: OrbisRadius.control, intensity: 0.6, padding: 12)
                    .padding(.horizontal, 16).padding(.top, 8)
                    .accessibilityElement(children: .contain).accessibilityIdentifier("launch-notice")
                    .alert(L10n.tr("结束本次等待？"), isPresented: $confirmingEnd) {
                        Button(L10n.tr("结束等待")) { endLaunch(launch.requestId) }
                        Button(L10n.tr("取消"), role: .cancel) {}
                    } message: {
                        Text(L10n.tr("电脑上的会话可能仍在启动。结束等待后首句会保留为草稿；再次创建可能打开另一个会话。"))
                    }
            } else {
                historySlot
            }
        }
    }

    // CHAT-PAGING-07: one overlay slot, with separate visual and interaction lifetimes.
    // Keep the transcript, notices, and the live retry's hit target out of the fade.
    private var historySlot: some View {
        let history = model.transcript
        let loading = history.historyLoading || viewport.awaitingOlderPage
        let progress = loading || viewport.showingHistoryPull
        let retry = !progress && history.hasOlder && history.historyError != nil
        let motion = !reduceMotion && visualActive
        let transition: AnyTransition = motion ? .asymmetric(
            insertion: .offset(y: -6).combined(with: .opacity).animation(InteractionMotion.state),
            removal: .offset(y: -6).combined(with: .opacity).animation(InteractionMotion.exit)
        ) : .identity
        return VStack(spacing: 0) {
            ZStack(alignment: .top) {
                if !progress && !retry {
                    if let message = history.historyError {
                        historyErrorBanner(message: message, canRetry: !history.cached && history.canSend && !history.syncing)
                            .padding(.bottom, hasNotices ? 6 : 0)
                    } else if !hasNotices {
                        Group {
                            if showQuestion, let question = viewport.readingQuestion {
                                questionReminder(question).padding(.horizontal, 16).padding(.top, 6)
                                    .transition(motion ? InteractionMotion.notice : .identity)
                            }
                        }.animation(motion ? InteractionMotion.panel : nil, value: showQuestion)
                            .transition(.identity)
                    }
                }
                Group {
                    if progress {
                        ChatHistoryProgress(loading: loading, viewport: viewport)
                            .padding(.horizontal, 16).padding(.top, 6)
                            .transition(transition)
                    }
                }
                .accessibilityHidden(!progress)
                .allowsHitTesting(false)
                Group {
                    if retry {
                        historyRetry(enabled: !history.syncing && (history.canSend || history.cached))
                            .transition(transition)
                    }
                }
                .accessibilityHidden(!retry)
                .allowsHitTesting(retry)
            }
            .animation(motion ? InteractionMotion.state : nil, value: progress)
            .animation(motion ? InteractionMotion.state : nil, value: retry)
            if hasNotices { runtimeNotices }
        }
        .id(mountToken)
    }
    private var runtimeNotices: some View {
        RuntimeNoticesView(model: model, actions: actions, runtimeId: actions.runtimeId,
                           supported: facts.supported).padding(.horizontal, 16)
    }
    private func historyErrorBanner(message: String, canRetry: Bool) -> some View {
        OrbisNotice(
            text: message,
            error: true,
            trailing: canRetry ? AnyView(OrbisTextButton(title: L10n.tr("重试")) { actions.refresh() }.orbisNested()) : nil
        )
        .padding(.horizontal, 16).padding(.top, 6)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("chat-history-error")
    }
    private func historyRetry(enabled: Bool) -> some View {
        let p = OrbisPalette(scheme)
        return OrbisMotionButton { if ownsViewport { retryHistory() } } label: {
            HStack(spacing: 12) {
                Text(L10n.tr("历史加载失败"))
                    .foregroundStyle(p.error)
                    .lineLimit(1).frame(maxWidth: .infinity, alignment: .leading)
                Text(L10n.tr("重试")).foregroundStyle(.tint).fixedSize(horizontal: true, vertical: false)
            }.font(.orbisLabel()).padding(.horizontal, 14).padding(.vertical, 10).frame(minHeight: 48)
        }.buttonStyle(NeuButtonStyle())
            .disabled(!enabled)
            .accessibilityIdentifier("chat-history-retry")
            .padding(.horizontal, 16).padding(.top, 6)
    }
    @ViewBuilder private func launchActions(_ launch: HostConnection.LaunchState) -> some View {
        if launch.rejected {
            OrbisActionButton(title: L10n.tr("返回新建")) { endLaunch(launch.requestId) }
                .disabled(launch.endingWait).accessibilityIdentifier("launch-abandon")
        } else {
            OrbisActionButton(title: launch.configured ? L10n.tr("核对原启动") : L10n.tr("重试"), symbol: "arrow.clockwise") {
                actions.retryLaunch()
            }.disabled(launch.endingWait).accessibilityIdentifier("launch-retry")
            if launch.canEndConfiguredLaunch {
                OrbisActionButton(title: L10n.tr("结束等待")) { confirmingEnd = true }
                    .disabled(launch.endingWait).accessibilityIdentifier("launch-abandon")
            }
        }
        OrbisActionButton(title: L10n.tr("返回"), action: onBack).accessibilityIdentifier("launch-back")
    }
    private func endLaunch(_ id: String) {
        guard ownsViewport else { return }
        Task { @MainActor in
            if await actions.endConfiguredLaunch(id, mayReturnToDraft: { ownsViewport && model.visualActivity.active }) {
                onReturnToNewSession()
            }
        }
    }
    private func questionReminder(_ question: ChatQuestion) -> some View {
        let p = OrbisPalette(scheme)
        return OrbisMotionButton {
            guard ownsViewport, viewport.showQuestionReminder, viewport.readingQuestion == question else { return }
            setComposerFocused(false)
            ChatDebugProbes.armQuestionPreemption(viewport)
            viewport.update { $0.locateQuestion(question.messageId, bottomDistance: viewport.bottomDistance) }
        } label: {
            HStack(spacing: 12) {
                HStack(spacing: 8) {
                    Text(L10n.tr("最近提问")).font(.orbisCaption(.medium)).foregroundStyle(p.secondary)
                        .lineLimit(1).fixedSize(horizontal: true, vertical: false)
                    Text(question.text).font(.orbisLabel()).foregroundStyle(p.text)
                        .lineLimit(1).multilineTextAlignment(.leading)
                }.frame(maxWidth: .infinity, alignment: .leading)
                OrbisActionSymbol(systemName: "arrow.up.left").font(.orbisLabel(.medium)).foregroundStyle(p.agent(model.shell.kind))
                    .accessibilityHidden(true)
            }.padding(.horizontal, 14).padding(.vertical, 10).frame(minHeight: 48)
        }.buttonStyle(NeuButtonStyle())
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(question.accessibilityLabel)
            .accessibilityHint(L10n.tr("定位到原消息"))
            .accessibilityIdentifier("chat-question-reminder")
            .accessibilityAddTraits(.isButton)
    }


}

struct ChatHeaderView: View, Equatable {
    let model: ChatScreenModel
    let actions: ChatSessionActions
    let fallbackRuntime: RuntimeSummary
    private var target: ChatActionContext { actions.target }

    @Environment(\.colorScheme) private var scheme
    @Environment(\.orbisFoldReading) private var foldReading
    @Environment(\.orbisOpenSessionDirectory) private var openDirectory
    let composerFocus: ChatComposerFocus
    let downloadFlight: DownloadFlight
    let onBack: () -> Void
    let onHistory: () -> Void
    let onDownloads: () -> Void
    @State private var runtimeInfoOpen = false
    private var facts: ChatHeaderState { model.header }
    private var runtime: RuntimeSummary { facts.runtime ?? fallbackRuntime }
    private var kind: String? { facts.kind }
    static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.model === rhs.model && lhs.actions == rhs.actions &&
            lhs.composerFocus === rhs.composerFocus && lhs.downloadFlight === rhs.downloadFlight
    }
    var body: some View {
        let _ = ChatSchedulingTrace.regionBody(.header)
        let _ = ChatDebugProbes.rendered(.header)
        let p = OrbisPalette(scheme)
        let presentation = facts.modelPresentation ?? .make(runtime: runtime, connected: false)
        return OrbisHeader {
            OrbisIconButton(symbol: "arrow.left", label: L10n.tr("返回"), action: onBack)
            if foldReading {
                OrbisIconButton(symbol: "sidebar.left", label: L10n.tr("打开会话目录")) {
                    composerFocus.focused = false
                    openDirectory()
                }.accessibilityIdentifier("fold-reading-directory")
            }
        } title: {
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 6) {
                    AgentEmblem(kind: kind, size: 18, recessed: false)
                    OrbisMotionText(facts.displayName).font(.orbisBody(.semibold)).lineLimit(1)
                }
                HStack(spacing: 8) {
                    if facts.connection == .secured {
                        RuntimeStatusLabel(status: runtime.presentationStatus, syncing: facts.syncing, title: runtime.presentationTitle)
                            .fixedSize(horizontal: true, vertical: false)
                    } else {
                        HStack(spacing: 5) {
                            Circle().fill(facts.connection == .error ? p.error : p.warning)
                                .frame(width: 7, height: 7).frame(width: 14, height: 14)
                            OrbisMotionText(connectionTitle(facts.connection)).font(.orbisCaption()).lineLimit(1)
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
            }.contentShape(Rectangle()).onTapGesture { if actions.isCurrent { composerFocus.focused = false; runtimeInfoOpen = true } }
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(L10n.tr("{0}，{1}，{2}", agentTitle(kind), facts.displayName, facts.connection == .secured ? runtime.presentationTitle : connectionTitle(facts.connection)))
                .modifier(ChatTitleDiagnostics(value: [presentation.model, presentation.thinking, presentation.indicator].compactMap { $0 }.joined(separator: " · ")))
                .accessibilityHint(runtime.agentKind == "opencode" ? L10n.tr("会话配置") : L10n.tr("模型与深度")).accessibilityIdentifier("chat-title")
                .accessibilityAddTraits(.isButton)
        } trailing: {
            OrbisIconButton(symbol: "clock.arrow.circlepath", label: L10n.tr("历史与分支"), action: onHistory)
            OrbisIconButton(symbol: "arrow.down.to.line", label: L10n.tr("下载"), action: onDownloads)
                .downloadFlightTarget(downloadFlight).accessibilityIdentifier("chat-downloads")
        }
        .accessibilityElement(children: .contain).accessibilityIdentifier("chat-navigation-bar")
        .orbisBottomSheet(isPresented: $runtimeInfoOpen) {
            SessionModelConfigurationView(target: target, fallbackRuntime: actions.runtime ?? fallbackRuntime).orbisSheet([.medium, .large])
        }
    }


}

/// Notices float over the top of the transcript. Each one is a single opaque banner that
/// carries its own close action and, when unverified, the re-check action inside it.
struct RuntimeNoticesView: View {
    let model: ChatScreenModel
    let actions: ChatSessionActions
    private var target: ChatActionContext { actions.target }
    @Environment(\.colorScheme) private var scheme
    @Environment(\.orbisAppearance) private var visualStyle
    let runtimeId: String
    /// 只有 Codex（含桌面版）会上报通知来源；其他运行时没有「待核对」可言，不显示核对提示。
    let supported: Bool
    var body: some View {
        if let projection = model.notices.notice, !projection.items.isEmpty || (supported && !projection.complete) {
            let unverified = supported && (projection.verification == "unknown" || !projection.complete || model.notices.connection != .secured)
            ScrollView {
                VStack(spacing: 8) {
                    if projection.items.isEmpty {
                        banner(text: L10n.tr("通知状态待核对"), severity: "info", recheck: unverified, close: nil)
                    }
                    ForEach(Array(projection.items.enumerated()), id: \.element.id) { index, notice in
                        banner(text: notice.displayMessage, severity: notice.displaySeverity,
                               recheck: index == 0 && (unverified || (supported && notice.verification == "unknown")),
                               close: { if actions.isCurrent { actions.dismissNotification(notice.notificationId) } })
                    }
                }.padding(.vertical, 6)
            }.frame(maxHeight: 180).scrollBounceBehavior(.basedOnSize).accessibilityIdentifier("runtime-notifications")
        }
    }

    private func banner(text: String, severity: String, recheck: Bool, close: (() -> Void)?) -> some View {
        let p = OrbisPalette(scheme)
        let tint = severity == "error" ? p.error : severity == "warning" ? p.warning : p.secondary
        let symbol = severity == "error" ? "exclamationmark.circle" : severity == "warning" ? "exclamationmark.triangle" : "info.circle"
        return HStack(alignment: .top, spacing: 10) {
            OrbisActionSymbol(systemName: symbol)
                .foregroundStyle(tint).orbisIconBaseline(OrbisTextSize.label)
            VStack(alignment: .leading, spacing: 6) {
                Text(text).font(.orbisLabel()).foregroundStyle(severity == "info" ? p.text : tint)
                    .fixedSize(horizontal: false, vertical: true)
                if recheck {
                    HStack(spacing: 10) {
                        Text(L10n.tr("通知状态待核对")).font(.orbisCaption()).foregroundStyle(p.secondary)
                        OrbisMotionButton { if actions.isCurrent { actions.syncNotifications() } } label: {
                            Label { Text(L10n.tr("重新核对")) } icon: { OrbisActionSymbol(systemName: "arrow.clockwise") }
                                .font(.orbisCaption(.semibold))
                        }.buttonStyle(.plain).foregroundStyle(.tint).disabled(model.notices.connection != .secured)
                    }
                }
            }.frame(maxWidth: .infinity, alignment: .leading)
            if let close {
                OrbisIconButton(symbol: "xmark", label: L10n.tr("关闭通知"), size: 28, action: close)
                    .orbisNested().disabled(model.notices.connection != .secured)
            }
        }.neuSurface(radius: OrbisRadius.control, intensity: 0.6, padding: 12)
    }
}
