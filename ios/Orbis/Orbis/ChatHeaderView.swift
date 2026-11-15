import SwiftUI

struct ChatNoticesRegion: View, Equatable {
    let model: ChatScreenModel
    let actions: ChatSessionActions
    let mountToken: UUID
    private var ownsViewport: Bool { actions.isCurrent && model.ownsMount(target: actions.target, token: mountToken) }
    private var target: ChatActionContext { actions.target }
    let viewport: ChatViewportController
    let setComposerFocused: (Bool) -> Void
    let onBack: () -> Void
    @Environment(\.colorScheme) private var scheme
    @Environment(\.orbisReduceMotion) private var reduceMotion
    @Environment(\.orbisVisualActive) private var visualActive
    static func == (lhs: Self, rhs: Self) -> Bool { lhs.model === rhs.model && lhs.actions == rhs.actions && lhs.mountToken == rhs.mountToken }
    private var showQuestion: Bool { viewport.showQuestionReminder && viewport.latestQuestion != nil }
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
                VStack(alignment: .leading, spacing: 8) {
                    OrbisStatusWithInfo(title: L10n.tr(launch.failure != nil ? "启动失败" : "启动未确认"), message: launch.failure ?? L10n.tr("启动未确认：电脑端尚未报告会话上线，请稍后在会话列表中查看。"), error: launch.failure != nil)
                    HStack(spacing: 12) {
                        OrbisActionButton(title: L10n.tr("重试"), symbol: "arrow.clockwise") { if actions.isCurrent { actions.retryLaunch() } }.accessibilityIdentifier("launch-retry")
                        OrbisActionButton(title: L10n.tr("返回"), action: onBack).accessibilityIdentifier("launch-back")
                    }
                }.padding(.horizontal, 16).accessibilityElement(children: .contain).accessibilityIdentifier("launch-notice")
            } else {
                ZStack(alignment: .top) {
                    if showQuestion && !hasNotices, let question = viewport.latestQuestion { questionReminder(question).padding(.horizontal, 16).padding(.top, 6).transition(reduceMotion || !visualActive ? .identity : InteractionMotion.notice) }
                    if hasNotices {
                        RuntimeNoticesView(model: model, actions: actions, runtimeId: actions.runtimeId,
                                           supported: facts.supported).padding(.horizontal, 16)
                    }
                }.animation(reduceMotion || !visualActive ? nil : InteractionMotion.panel, value: showQuestion && !hasNotices)
            }
        }
    }
    private func questionReminder(_ question: ChatQuestion) -> some View {
        let p = OrbisPalette(scheme)
        return OrbisMotionButton {
            guard ownsViewport else { return }
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
            .accessibilityLabel(L10n.tr("最近提问，{0}", question.text))
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
    @FocusState.Binding var composerFocused: Bool
    let downloadFlight: DownloadFlight
    let onBack: () -> Void
    let onHistory: () -> Void
    let onDownloads: () -> Void
    @State private var runtimeInfoOpen = false
    private var facts: ChatHeaderState { model.header }
    private var runtime: RuntimeSummary { facts.runtime ?? fallbackRuntime }
    private var kind: String? { facts.kind }
    static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.model === rhs.model && lhs.actions == rhs.actions && lhs.downloadFlight === rhs.downloadFlight
    }
    var body: some View {
        let _ = ChatSchedulingTrace.regionBody(.header)
        let _ = ChatDebugProbes.rendered(.header)
        let p = OrbisPalette(scheme)
        let presentation = facts.modelPresentation ?? .make(runtime: runtime, connected: false)
        return OrbisHeader {
            OrbisIconButton(symbol: "arrow.left", label: L10n.tr("返回"), action: onBack)
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
            }.contentShape(Rectangle()).onTapGesture { if actions.isCurrent { composerFocused = false; runtimeInfoOpen = true } }
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(L10n.tr("{0}，{1}，{2}", agentTitle(kind), facts.displayName, facts.connection == .secured ? runtime.presentationTitle : connectionTitle(facts.connection)))
                .modifier(ChatTitleDiagnostics(value: [presentation.model, presentation.thinking, presentation.indicator].compactMap { $0 }.joined(separator: " · ")))
                .accessibilityHint(L10n.tr("模型与深度")).accessibilityIdentifier("chat-title")
                .accessibilityAddTraits(.isButton)
        } trailing: {
            OrbisIconButton(symbol: "clock.arrow.circlepath", label: L10n.tr("历史与分支"), action: onHistory)
            OrbisIconButton(symbol: "arrow.down.to.line", label: L10n.tr("下载"), action: onDownloads)
                .downloadFlightTarget(downloadFlight).accessibilityIdentifier("chat-downloads")
        }
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
                        banner(text: L10n.tr("通知状态待核对"), error: false, recheck: unverified, close: nil)
                    }
                    ForEach(Array(projection.items.enumerated()), id: \.element.id) { index, notice in
                        banner(text: notice.message, error: notice.severity != "info",
                               recheck: index == 0 && (unverified || (supported && notice.verification == "unknown")),
                               close: { if actions.isCurrent { actions.dismissNotification(notice.notificationId) } })
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
