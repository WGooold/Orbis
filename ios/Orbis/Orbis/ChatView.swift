import SwiftUI
import UIKit
import UniformTypeIdentifiers

/// Bottom edge of the transcript in the viewport, or nil while the lazy stack has released it.
private struct ChatBottomPreference: PreferenceKey {
    static var defaultValue: CGFloat? = nil
    static func reduce(value: inout CGFloat?, nextValue: () -> CGFloat?) { value = nextValue() ?? value }
}

private struct ChatRowsPreference: PreferenceKey {
    static var defaultValue: [String: CGRect] = [:]
    static func reduce(value: inout [String: CGRect], nextValue: () -> [String: CGRect]) { value.merge(nextValue(), uniquingKeysWith: { _, next in next }) }
}

/// The transcript has exactly one viewport policy: within one line of the bottom it follows
/// new content, any drag stops following at once, and past three lines a jump-to-latest
/// button appears. Nothing else moves the viewport on the reader's behalf.
private enum ChatFollow {
    static let line: CGFloat = 20
    static let bottomID = "chat-bottom"
}

struct ChatView: View {
    @EnvironmentObject private var store: OrbisStore
    @EnvironmentObject private var transfers: FileTransfers
    @EnvironmentObject private var agent: AgentState
    @Environment(\.colorScheme) private var scheme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let runtime: RuntimeSummary
    let onBack: () -> Void
    let onHistory: () -> Void
    let onDownloads: () -> Void
    let onAlias: () -> Void
    @State private var following = true
    @State private var userScrolling = false
    @State private var jumping = false
    @State private var bottomDistance: CGFloat = 0
    @State private var hasPositioned = false
    @State private var selectedCommand: String?
    @State private var deliveryChoices = false
    @State private var permissionsOpen = false
    @State private var runtimeInfoOpen = false
    @State private var aliasAfterInfo = false
    @State private var filePickerOpen = false
    @State private var firstVisibleRow: String?
    @State private var historyAnchor: String?
    @State private var topArmed = false
    @FocusState private var composerFocused: Bool

    private var kind: String? { store.agentKind(runtime) }
    /// Claude Code 只能等当前回合结束后提交（没有 Steer）；附件和其他后端一样以路径交给它。
    private var claudeComposer: Bool { kind == "claude" }
    private var accent: Color { OrbisPalette(scheme).agent(kind) }
    private var draft: Binding<String> { Binding(get: { store.draft(for: runtime) }, set: { store.saveDraft($0, for: runtime) }) }
    private var slash: Bool { draft.wrappedValue.trimmingCharacters(in: .whitespacesAndNewlines).hasPrefix("/") }
    private var command: SlashCommand? { (store.commands[runtime.runtimeId] ?? []).first { $0.name == selectedCommand } }
    private var attachments: [FileTransfer] {
        transfers.currentTasks.filter { $0.direction == "upload" && $0.runtimeId == runtime.runtimeId && $0.sessionId == runtime.sessionId && $0.attached }
    }
    private var canSubmit: Bool {
        guard store.canSend, !transfers.preparing, attachments.allSatisfy({ $0.status == "completed" }),
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
            conversation.overlay(alignment: .top) { RuntimeNoticesView(runtimeId: runtime.runtimeId, supported: ["codex", "codexDesktop"].contains(runtime.agentKind)).padding(.horizontal, 16) }
            if store.isViewingCachedSession { cachedComposer } else { composer }
        }.background(OrbisPalette(scheme).base.ignoresSafeArea()).tint(accent).environment(\.orbisAccent, accent)
            .fileImporter(isPresented: $filePickerOpen, allowedContentTypes: [.item], allowsMultipleSelection: true) { result in
                switch result {
                case .success(let urls): transfers.upload(urls: Array(urls.prefix(max(0, 10 - attachments.count))), runtime: runtime)
                case .failure(let error): transfers.error = error.localizedDescription
                }
            }
            .sheet(isPresented: $permissionsOpen) {
                PermissionsView(runtime: runtime).orbisSheet([.medium, .large])
            }
            .sheet(isPresented: $runtimeInfoOpen, onDismiss: {
                // The alias editor opens only after the info sheet has gone, never on top of it.
                if aliasAfterInfo { aliasAfterInfo = false; onAlias() }
            }) {
                RuntimeInfoView(runtime: runtime) { aliasAfterInfo = true; runtimeInfoOpen = false }.orbisSheet([.large])
            }
            .onChange(of: draft.wrappedValue) { _, next in
                if let selectedCommand, !(next == "/" + selectedCommand || next.hasPrefix("/" + selectedCommand + " ")) { self.selectedCommand = nil }
                if next.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { deliveryChoices = false }
            }
            .task(id: runtime.runtimeId) {
                store.refreshWorkingBranch()
                while !Task.isCancelled {
                    do { try await Task.sleep(nanoseconds: 15_000_000_000) } catch { return }
                    store.refreshWorkingBranch()
                }
            }
            .onChange(of: runtime.status) { _, status in if status != "running" { deliveryChoices = false } }
    }

    private var header: some View {
        let p = OrbisPalette(scheme)
        return OrbisHeader {
            OrbisIconButton(symbol: "arrow.left", label: "返回", action: onBack)
        } title: {
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 6) {
                    AgentEmblem(kind: kind, size: 18, recessed: false)
                    Text(store.displayName(runtime)).font(.orbisBody(.semibold)).lineLimit(1)
                }
                HStack(spacing: 8) {
                    if store.connection == .secured {
                        RuntimeStatusLabel(status: runtime.status)
                    } else {
                        HStack(spacing: 5) {
                            Circle().fill(store.connection == .error ? p.error : p.warning).frame(width: 7, height: 7)
                            Text(connectionTitle(store.connection)).font(.orbisCaption())
                        }.foregroundStyle(p.secondary)
                    }
                    if let model = runtime.model, domainReady("model") {
                        Text(model.name ?? model.id).font(.orbisCaption()).foregroundStyle(p.secondary).lineLimit(1)
                    }
                    // A fixed slot: syncing never pushes the status or model label sideways.
                    ProgressView().controlSize(.mini).opacity(store.isSyncing ? 1 : 0).accessibilityHidden(!store.isSyncing)
                }
            }.contentShape(Rectangle()).onTapGesture { composerFocused = false; runtimeInfoOpen = true }
                .accessibilityElement(children: .ignore)
                .accessibilityLabel("\(agentTitle(kind))，\(store.displayName(runtime))，\(store.connection == .secured ? runtimeStatusTitle(runtime.status) : connectionTitle(store.connection))")
                .accessibilityHint("查看会话信息").accessibilityIdentifier("chat-title")
                .accessibilityAddTraits(.isButton)
        } trailing: {
            OrbisIconButton(symbol: "clock.arrow.circlepath", label: "历史与分支", action: onHistory)
            OrbisIconButton(symbol: "arrow.down.to.line", label: "下载", action: onDownloads)
        }
    }

    private var conversation: some View {
        let kind = self.kind
        let presentation = chatPresentation(store.messages)
        return ScrollViewReader { proxy in
            GeometryReader { viewport in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 16) {
                        transcriptHeader
                        if presentation.messages.isEmpty {
                            OrbisEmptyState(symbol: "bubble.left.and.bubble.right", title: store.isSyncing ? "正在加载会话" : "继续这段会话")
                                .frame(minHeight: max(180, viewport.size.height - 100))
                        }
                        ForEach(chatRows(presentation.messages, turnIdsByMessageId: Dictionary(store.turnTimings.compactMap { timing in timing.messageId.map { ($0, timing.turnId) } }, uniquingKeysWith: { _, last in last }))) { row in
                            ChatMessageRow(row: row, kind: kind, toolResults: presentation.toolResults).id(row.id)
                                .background(GeometryReader { geometry in Color.clear.preference(key: ChatRowsPreference.self, value: [row.id: geometry.frame(in: .named("chat-viewport"))]) })
                        }
                        LiveToolsView(runtime: runtime)
                        Color.clear.frame(height: 20).id(ChatFollow.bottomID)
                            .background(GeometryReader { geo in Color.clear.preference(key: ChatBottomPreference.self, value: geo.frame(in: .named("chat-viewport")).maxY) })
                    }.padding(.horizontal, 16).padding(.top, 4)
                        .background {
                            if #unavailable(iOS 18.0) { LegacyScrollInteraction(onInteraction: userInteractionChanged) }
                        }
                }.coordinateSpace(name: "chat-viewport").scrollDismissesKeyboard(.interactively)
                    .modifier(ChatScrollObserver(viewportHeight: viewport.size.height,
                                                 onDistance: { bottomDistanceChanged($0, proxy: proxy) },
                                                 onInteraction: { userInteractionChanged($0) }))
                    .onPreferenceChange(ChatRowsPreference.self) { frames in
                        firstVisibleRow = frames.filter { $0.value.maxY > 0 && $0.value.minY < viewport.size.height }.min { $0.value.minY < $1.value.minY }?.key
                        let first = presentation.messages.first?.messageId
                        let atTop = first.flatMap { frames[$0] }.map { $0.minY >= -40 && $0.minY < viewport.size.height } ?? false
                        if !atTop { topArmed = hasPositioned }
                        if atTop && topArmed && historyAnchor == nil && !store.isSyncing && !store.historyLoading.contains(runtime.runtimeId) && store.historyErrors[runtime.runtimeId] == nil {
                            topArmed = false; loadOlder()
                        }
                    }
                    .overlay(alignment: .bottomTrailing) {
                        if !following && bottomDistance > ChatFollow.line * 3 && !store.messages.isEmpty {
                            OrbisIconButton(symbol: "arrow.down", label: "跳到最新消息", tint: accent) { jumpToLatest(proxy) }
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
                    .animation(reduceMotion ? nil : .orbisFade, value: !following && bottomDistance > ChatFollow.line * 3)
                    .animation(reduceMotion ? nil : .orbisFade, value: store.actionFeedback)
                    .onChange(of: store.historyPageRevision) { _, _ in
                        if let historyAnchor { proxy.scrollTo(historyAnchor, anchor: .top) }
                        self.historyAnchor = nil
                    }
                    .onChange(of: store.historyLoading.contains(runtime.runtimeId)) { old, loading in
                        if old && !loading && store.historyErrors[runtime.runtimeId] != nil { historyAnchor = nil }
                    }
                    .onAppear { proxy.scrollTo(ChatFollow.bottomID, anchor: .bottom); hasPositioned = !store.messages.isEmpty }
            }
        }
    }

    private var cachedComposer: some View {
        VStack(spacing: 10) {
            Text("本机缓存，可离线浏览，发送消息前需在电脑继续此会话").font(.orbisCaption()).foregroundStyle(OrbisPalette(scheme).secondary)
            if let session = store.sessions.first(where: { $0.sessionId == runtime.sessionId }) {
                OrbisActionButton(title: "在电脑继续会话", symbol: "play") { store.activate(session) }
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
                OrbisTextButton(title: "重试", symbol: "arrow.up", tint: accent, loading: loading) { loadOlder() }.disabled(blocked)
            } else if store.hasOlderHistory[runtime.runtimeId] == true {
                OrbisTextButton(title: "更早的消息", symbol: "arrow.up", tint: accent, loading: loading) { loadOlder() }.disabled(blocked)
                Spacer(minLength: 0)
            } else {
                Spacer(minLength: 0)
            }
            OrbisTextButton(title: "刷新", symbol: "arrow.clockwise", tint: accent, loading: store.isSyncing) { store.refresh() }
                .disabled(store.isSyncing || !store.canSend)
        }.frame(minHeight: 48)
    }

    private func bottomDistanceChanged(_ distance: CGFloat, proxy: ScrollViewProxy) {
        bottomDistance = distance
        if distance.isFinite && !store.messages.isEmpty { hasPositioned = true }
        if jumping {
            if distance <= 0.5 { jumping = false }
            return
        }
        guard !userScrolling else { return }
        if following {
            if distance > 0.5 { proxy.scrollTo(ChatFollow.bottomID, anchor: .bottom) }
        } else if distance <= ChatFollow.line {
            following = true
        }
    }

    private func userInteractionChanged(_ active: Bool) {
        userScrolling = active
        if active {
            following = false; jumping = false
        } else if bottomDistance <= ChatFollow.line {
            following = true
        }
    }

    private func jumpToLatest(_ proxy: ScrollViewProxy) {
        following = true; jumping = true
        withAnimation(reduceMotion ? nil : .smooth(duration: 0.3)) {
            proxy.scrollTo(ChatFollow.bottomID, anchor: .bottom)
        } completion: { jumping = false }
    }

    private var composer: some View {
        let p = OrbisPalette(scheme)
        return VStack(spacing: 0) {
            InteractionWorkspaceView(runtimeId: runtime.runtimeId)
            if let percent = contextUsagePercent(runtime.contextUsage), domainReady("context") {
                GeometryReader { geometry in
                    Rectangle().fill(accent.opacity(0.15))
                        .overlay(alignment: .leading) { Rectangle().fill(percent >= 90 ? p.error : accent).frame(width: geometry.size.width * min(100, max(0, percent)) / 100) }
                }.frame(height: 2).accessibilityLabel("上下文已使用 \(Int(percent))%")
            } else { Color.clear.frame(height: 2) }
            QueuedMessagesView(runtimeId: runtime.runtimeId)
            OrbisCollapse(expanded: deliveryChoices) {
                HStack(spacing: 12) {
                    OrbisActionButton(title: deliveryTitle("followUp"), tint: accent) { submit(delivery: "followUp") }
                    OrbisActionButton(title: deliveryTitle("steer"), tint: accent) { submit(delivery: "steer") }
                }.padding(.horizontal, 16).padding(.top, 10)
            }
            if !slash {
                HStack(spacing: 12) {
                    VStack(alignment: .leading, spacing: 4) {
                        Label(runtime.cwd, systemImage: "folder").lineLimit(1).truncationMode(.middle)
                        Button(action: store.refreshWorkingBranch) {
                            Label(branchTitle, systemImage: "point.3.connected.trianglepath.dotted").lineLimit(1)
                        }.buttonStyle(.plain).accessibilityLabel("刷新 Git 工作分支，" + branchTitle)
                    }.font(.orbisCaption(mono: true)).foregroundStyle(p.secondary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    if let permissions = runtime.permissionManagement {
                        Button { composerFocused = false; permissionsOpen = true } label: {
                            HStack(spacing: 5) {
                                Image(systemName: "shield.lefthalf.filled")
                                Text(permissions.summary).lineLimit(1)
                                Image(systemName: "chevron.right").imageScale(.small)
                            }.font(.orbisCaption()).frame(minHeight: 48)
                                .foregroundStyle(permissions.tone == "problem" ? p.error : accent)
                        }.buttonStyle(.plain).accessibilityLabel("会话权限：\(permissions.summary)")
                    }
                }.padding(.horizontal, 20).padding(.top, 10)
            }
            AttachmentStrip(runtime: runtime)
            if slash { SlashPickerView(runtime: runtime, selected: $selectedCommand, input: draft, onHistory: onHistory).padding(.top, 10) }
            HStack(alignment: .bottom, spacing: 10) {
                OrbisIconButton(symbol: "paperclip", label: "发送文件到电脑", tint: accent) {
                    composerFocused = false; filePickerOpen = true
                }.disabled(!store.canSend || transfers.preparing || attachments.count >= 10)
                TextField("发给 \(agentTitle(kind))，/ 命令", text: draft, axis: .vertical)
                    .accessibilityIdentifier("chat-composer")
                    .font(.orbisBody()).lineLimit(1...6).focused($composerFocused)
                    .padding(.horizontal, 14).padding(.vertical, 15).frame(minHeight: 56)
                    .orbisField(focused: composerFocused)
                if runtime.status == "running" && draft.wrappedValue.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && attachments.isEmpty {
                    OrbisIconButton(symbol: "stop.fill", label: "停止生成", tint: p.error, action: store.stopRuntime).disabled(!store.canSend)
                } else {
                    OrbisIconButton(symbol: "arrow.up", label: "发送消息", tint: accent) {
                        if runtime.status == "running" && !slash && claudeComposer { submit(delivery: "followUp") }
                        else if runtime.status == "running" && !slash { deliveryChoices.toggle() }
                        else { submit() }
                    }.disabled(!canSubmit)
                }
            }.padding(.horizontal, 12).padding(.top, 10).padding(.bottom, 12)
        }.padding(.top, 8).background(p.base)
    }

    private func domainReady(_ name: String) -> Bool {
        guard let snapshot = agent.snapshots[runtime.runtimeId] else { return true }
        return snapshot.missing[name] == nil && (snapshot.domains[name]?.availability ?? "ready") == "ready"
    }

    private var branchTitle: String {
        guard let branch = store.workingBranches[runtime.runtimeId], branch.cwd == runtime.cwd, branch.sessionId == runtime.sessionId else { return "分支信息待同步" }
        return branch.branch ?? branch.commit.map { "\(String($0.prefix(8)))（分离 HEAD）" } ?? (branch.loaded ? "未获取到 Git 分支" : "分支信息待同步")
    }

    private func loadOlder() {
        let anchor = firstVisibleRow
        if store.loadOlderHistory() { historyAnchor = anchor; following = false }
    }

    private func commandArguments(_ command: SlashCommand) -> String {
        String(draft.wrappedValue.dropFirst(command.name.count + 1)).trimmingCharacters(in: .whitespacesAndNewlines)
    }
    private func submit(delivery: String? = nil) {
        guard canSubmit else { return }
        let accepted: Bool
        if slash, let command { accepted = store.executeSlash(command.name, args: commandArguments(command)) }
        else { accepted = store.sendMessage(draft.wrappedValue.isEmpty ? "请查看附件。" : draft.wrappedValue, delivery: delivery, attachmentIds: Set(attachments.map(\.id))) }
        if accepted { transfers.detach(Set(attachments.map(\.id))); draft.wrappedValue = ""; selectedCommand = nil; deliveryChoices = false }
    }
}

/// Reports how far the transcript sits from its bottom edge and when the reader's finger
/// starts or stops moving it. iOS 18 reads the scroll geometry and phase directly.
private struct ChatScrollObserver: ViewModifier {
    let viewportHeight: CGFloat
    let onDistance: (CGFloat) -> Void
    let onInteraction: (Bool) -> Void

    func body(content: Content) -> some View {
        if #available(iOS 18.0, *) {
            content
                .defaultScrollAnchor(.bottom, for: .initialOffset)
                .onScrollGeometryChange(for: CGFloat.self) { geometry in
                    max(0, geometry.contentSize.height + geometry.contentInsets.bottom - geometry.visibleRect.maxY)
                } action: { _, distance in onDistance(distance) }
                .onScrollPhaseChange { _, phase in
                    switch phase {
                    case .tracking, .interacting: onInteraction(true)
                    case .idle: onInteraction(false)
                    default: break
                    }
                }
        } else {
            content
                .onPreferenceChange(ChatBottomPreference.self) { bottom in
                    onDistance(bottom.map { max(0, $0 - viewportHeight) } ?? .infinity)
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

struct ChatMessageRow: View {
    @EnvironmentObject private var store: OrbisStore
    @Environment(\.colorScheme) private var scheme
    let row: ChatRow
    let kind: String?
    var toolResults: [String: ChatMessage] = [:]
    var body: some View {
        HStack(alignment: .top, spacing: 0) {
            if row.isUser { Spacer(minLength: 36) }
            VStack(alignment: .leading, spacing: 12) {
                if !row.isUser {
                    HStack(spacing: 6) {
                        AgentEmblem(kind: kind, size: 17, recessed: false)
                        Text(agentTitle(kind)).font(.orbisCaption(.semibold)).foregroundStyle(OrbisPalette(scheme).agent(kind))
                        Spacer(minLength: 8)
                        // 复制整轮回复。不用长按手势：它挂在每条消息上会和滚动、文本选择抢触摸。
                        OrbisCopyButton(label: "复制回复", size: 26) { copyText }
                            .padding(.vertical, -10)
                    }
                }
                ForEach(row.messages) { message in
                    MessageContentView(message: message, toolResults: toolResults)
                }
                ForEach(store.turnTimings.filter { timing in timing.messageId.map { id in row.messages.contains { $0.messageId == id } } == true }, id: \.turnId) { timing in
                    TimelineView(.periodic(from: .now, by: 1)) { context in
                        let elapsed = timing.durationMs.map(Double.init) ?? max(0, context.date.timeIntervalSince1970 * 1000 - Double(timing.startedAt))
                        Text(String(format: timing.durationMs == nil ? "本轮已运行 %.1f 秒" : "本轮耗时 %.1f 秒", elapsed / 1000))
                            .font(.orbisCaption(mono: true)).foregroundStyle(OrbisPalette(scheme).secondary)
                    }
                }
            }.frame(maxWidth: row.isUser ? nil : .infinity, alignment: .leading)
                .neuSurface(inset: row.isUser, radius: OrbisRadius.card, intensity: row.isUser ? 0.6 : 0.4, padding: OrbisRadius.cardPadding + 2)
                .accessibilityAction(named: "复制") { UIPasteboard.general.string = copyText }
            if !row.isUser { Spacer(minLength: 8) }
        }
    }
    private var copyText: String { row.messages.map(\.text).joined(separator: "\n\n") }
}

private struct MessageContentView: View {
    @EnvironmentObject private var store: OrbisStore
    @EnvironmentObject private var transfers: FileTransfers
    @Environment(\.colorScheme) private var scheme
    @State private var fullOpen = false
    @State private var fullEntryId = ""
    let message: ChatMessage
    var toolResults: [String: ChatMessage] = [:]
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            if let summary = message.toolSummary { ToolSummaryView(summary: summary) }
            ForEach(Array(message.content.enumerated()), id: \.offset) { _, content in
                switch content.type {
                case "thinking":
                    CompactDisclosure(title: "思考过程", symbol: "sparkles") {
                        Text(content.text ?? "思考中…").font(.orbisLabel()).textSelection(.enabled)
                    }
                case "tool_call", "toolCall":
                    let result = content.toolCallId.flatMap { toolResults[$0] }
                    if let summary = result?.toolSummary ?? content.summary { ToolSummaryView(summary: summary) }
                    else {
                        let live = content.toolCallId == nil && content.arguments == nil && content.text?.isEmpty == false
                        let status = result?.isError == true ? "执行失败" : live ? "参数接收中" : "已完成"
                        CompactDisclosure(title: content.toolName ?? result?.toolName ?? message.toolName ?? "工具", detail: status, symbol: "wrench.and.screwdriver") {
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
                        Button { transfers.download(artifact: file) } label: {
                            HStack(spacing: 8) {
                                Image(systemName: "arrow.down.doc")
                                FileNameText(name: file.fileName)
                            }.font(.orbisLabel()).frame(maxWidth: .infinity, minHeight: 44, alignment: .leading).padding(.horizontal, 12)
                        }.buttonStyle(NeuButtonStyle())
                    }
                default:
                    if let text = content.text, !text.isEmpty {
                        if message.role == "user" { Text(text).font(.orbisBody()).textSelection(.enabled) }
                        else { MarkdownMessage(text: text) }
                    }
                }
            }
            if let truncated = message.content.first(where: { $0.truncated == true }) {
                Text(truncated.originalBytes.map { "有内容因超长被截断（原始 \($0.formatted()) 字节）" } ?? "有内容因超长被截断。")
                    .font(.orbisCaption()).foregroundStyle(OrbisPalette(scheme).secondary)
                OrbisTextButton(title: "查看完整内容", symbol: "doc.text.magnifyingglass") {
                    store.previewEntry(message.messageId)
                    fullEntryId = store.entryPreview?.entryId ?? message.messageId
                    fullOpen = true
                }.disabled(!store.canSend).accessibilityIdentifier("full-entry-" + message.messageId)
                if !store.canSend { Text("连接电脑并继续此会话后可取回完整内容。").font(.orbisCaption()).foregroundStyle(OrbisPalette(scheme).secondary) }
            }
            if message.content.isEmpty && message.toolSummary == nil { Text("…").foregroundStyle(OrbisPalette(scheme).secondary) }
        }.foregroundStyle(message.isError == true ? OrbisPalette(scheme).error : OrbisPalette(scheme).text)
            .sheet(isPresented: $fullOpen) { FullMessageView(entryId: fullEntryId).orbisSheet([.large]) }
    }
}

private struct FullMessageView: View {
    @EnvironmentObject private var store: OrbisStore
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var scheme
    let entryId: String
    private var preview: EntryPreview? { store.entryPreview?.entryId == entryId ? store.entryPreview : nil }
    var body: some View {
        VStack(spacing: 16) {
            OrbisPageHeader(title: "完整内容", closes: true, back: { dismiss() }) {
                OrbisIconButton(symbol: "doc.on.doc", label: "复制完整内容") {
                    if let message = preview?.message { UIPasteboard.general.string = fullMessageText(message) }
                }.disabled(preview?.message == nil)
            }
            if preview?.loading == true { ProgressView("正在取回…") }
            if let message = preview?.message {
                ScrollView([.horizontal, .vertical]) {
                    Text(fullMessageText(message)).font(.orbisLabel(mono: true)).textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading).padding(20)
                }
            } else if preview?.loading != true {
                OrbisNotice(text: preview?.error ?? "当前没有可显示的完整内容。", error: true).padding(.horizontal, 20)
                OrbisActionButton(title: "重试", symbol: "arrow.clockwise") { store.previewEntry(entryId) }.disabled(!store.canSend).padding(.horizontal, 20)
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
    let title: String
    var detail: String? = nil
    let symbol: String
    @ViewBuilder let content: Content
    @State private var expanded = false
    var body: some View {
        let p = OrbisPalette(scheme)
        VStack(alignment: .leading, spacing: 0) {
            Button { expanded.toggle() } label: {
                HStack(spacing: 8) {
                    Image(systemName: symbol)
                    Text(title).fontWeight(.medium).foregroundStyle(p.text).lineLimit(2)
                    if let detail { Text(detail).lineLimit(1) }
                    Spacer(minLength: 0)
                    Image(systemName: "chevron.down").imageScale(.small)
                        .rotationEffect(.degrees(expanded ? 180 : 0))
                        .animation(.orbisCollapse, value: expanded)
                }.font(.orbisLabel()).foregroundStyle(p.secondary).frame(minHeight: 40).contentShape(Rectangle())
            }.buttonStyle(.plain).accessibilityLabel("\(expanded ? "收起" : "展开")\(title)\(detail.map { "，" + $0 } ?? "")")
            OrbisCollapse(expanded: expanded) {
                content.frame(maxWidth: .infinity, alignment: .leading).padding(.bottom, 10)
            }
        }.padding(.horizontal, 12).padding(.vertical, 4).neuSurface(inset: true, radius: 14, intensity: 0.35)
    }
}

struct ToolSummaryView: View {
    @EnvironmentObject private var store: OrbisStore
    @Environment(\.colorScheme) private var scheme
    @State private var detailOpen = false
    let summary: ToolSummary
    var body: some View {
        CompactDisclosure(title: summary.toolName, detail: phase, symbol: summary.isError == true ? "exclamationmark.circle" : "wrench.and.screwdriver") {
            VStack(alignment: .leading, spacing: 10) {
                if summary.durationMs != nil || summary.exitCode != nil {
                    HStack {
                        if let duration = summary.durationMs { Text(String(format: "耗时 %.1f 秒", Double(duration) / 1000)) }
                        if let code = summary.exitCode { Text("退出码 \(code)") }
                    }.font(.orbisCaption()).foregroundStyle(.secondary)
                }
                ForEach(Array([summary.inputSummary, summary.resultSummary, summary.errorSummary].compactMap { $0 }.enumerated()), id: \.offset) { _, part in
                    Text(part.text).font(.orbisCaption(mono: true)).textSelection(.enabled)
                    if part.omitted { Text("已省略部分内容").font(.orbisCaption()).foregroundStyle(OrbisPalette(scheme).secondary) }
                }
                if let tool = summary.tool, let runtime = store.selectedRuntime {
                    ForEach(summary.contents, id: \.part) { part in
                        if part.availability != "absent" {
                            OrbisActionButton(title: "查看" + toolPartTitle(part.part), symbol: "doc.text.magnifyingglass") {
                                store.toolContent.open(runtimeId: runtime.runtimeId, locator: ToolLocator(tool: tool, part: part.part)); detailOpen = true
                            }.disabled(!store.canSend || part.readCapability == "none" || !["readable", "pending"].contains(part.availability))
                            if ["temporarily-unavailable", "unrecoverable"].contains(part.availability) {
                                Text(part.availability == "unrecoverable" ? "此部分内容已无法恢复" : "来源暂时无法提供此部分内容").font(.orbisCaption()).foregroundStyle(.secondary)
                            }
                        }
                    }
                }
            }
        }.sheet(isPresented: $detailOpen, onDismiss: { store.toolContent.close() }) {
            ToolDetailView(reader: store.toolContent, title: summary.toolName).orbisSheet([.large])
        }
    }
    private var phase: String {
        switch summary.phase { case "started", "running": return "执行中"; case "cancelled": return "已取消"; default: return summary.isError == true ? "执行失败" : "已完成" }
    }
}

// MARK: - Markdown

/// Streamed characters fade in from blur(6) to sharp over 120 ms, each starting 30 ms after
/// the previous one. Offsets are UTF-16 positions in the message's rendered text.
struct RevealClock: Equatable {
    struct Mark: Equatable {
        let offset: Int
        let time: TimeInterval
    }
    static let duration: TimeInterval = 0.12
    static let stagger: TimeInterval = 0.03
    /// A large chunk compresses its stagger so the text never trails the stream by more than this.
    static let maxDelay: TimeInterval = 0.45
    static let blur: CGFloat = 6

    private(set) var known: Int
    private(set) var marks: [Mark] = []

    init(known: Int) { self.known = known }

    var end: TimeInterval { marks.last.map { $0.time + Self.maxDelay + Self.duration } ?? 0 }
    /// Everything before this offset has settled.
    var settledBelow: Int { marks.first?.offset ?? known }

    func isAnimating(at now: TimeInterval) -> Bool { !marks.isEmpty && now < end }

    mutating func observe(length: Int, at now: TimeInterval) {
        marks.removeAll { now > $0.time + Self.maxDelay + Self.duration }
        if length < known {
            known = length
            marks.removeAll { $0.offset >= length }
        } else if length > known {
            marks.append(Mark(offset: known, time: now))
            known = length
        }
    }

    /// 0 = not shown yet, 1 = settled. Characters past `known` wait for their arrival time.
    func progress(_ offset: Int, at now: TimeInterval) -> Double {
        if offset >= known { return 0 }
        guard let mark = marks.last(where: { $0.offset <= offset }) else { return 1 }
        let delay = min(Double(offset - mark.offset) * Self.stagger, Self.maxDelay)
        return min(max((now - mark.time - delay) / Self.duration, 0), 1)
    }
}

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

private extension Text {
    /// iOS 17 has no text renderer; streamed text simply appears there.
    @ViewBuilder func reveal(_ clock: RevealClock, base: Int, now: TimeInterval) -> some View {
        if #available(iOS 18.0, *) { textRenderer(RevealRenderer(clock: clock, base: base, now: now)) }
        else { self }
    }
}

/// One rendered Markdown row and where its text starts within the whole message.
private struct MarkdownRow: Identifiable {
    enum Kind {
        case spacer, divider
        case text(AttributedString)
        case heading(Int, AttributedString)
        case quote(AttributedString)
        case task(Bool, AttributedString)
        case bullet(Int, AttributedString)
        case image(String, URL)
        case table(MarkdownTextSection)
        case code(String, String)
    }
    let id: String
    let kind: Kind
    let base: Int
    let length: Int
}

struct MarkdownMessage: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @EnvironmentObject private var transfers: FileTransfers
    @Environment(\.colorScheme) private var scheme
    let text: String
    @State private var clock: RevealClock
    @State private var settleTick = 0

    init(text: String) {
        self.text = text
        _clock = State(initialValue: RevealClock(known: MarkdownCache.renderedLength(text)))
    }

    var body: some View {
        let rows = MarkdownCache.rows(text)
        let length = MarkdownCache.renderedLength(text)
        let animating = !reduceMotion && settleTick >= 0 && clock.isAnimating(at: Date().timeIntervalSinceReferenceDate)
        TimelineView(.animation(minimumInterval: nil, paused: !animating)) { context in
            let now = reduceMotion ? TimeInterval.greatestFiniteMagnitude : max(context.date.timeIntervalSinceReferenceDate, Date().timeIntervalSinceReferenceDate)
            VStack(alignment: .leading, spacing: 12) {
                ForEach(rows) { row in rowView(row, now: now) }
            }
        }.font(.orbisBody()).textSelection(.enabled)
            .environment(\.openURL, OpenURLAction { url in
                if ["http", "https", "mailto"].contains(url.scheme?.lowercased() ?? "") { return .systemAction }
                let path = url.isFileURL ? url.path : url.absoluteString.removingPercentEncoding ?? url.absoluteString
                transfers.download(path: path)
                return .handled
            })
            .onChange(of: length) { _, value in clock.observe(length: value, at: Date().timeIntervalSinceReferenceDate) }
            .task(id: clock.end) {
                // Pause the timeline once the last character has settled.
                let wait = clock.end - Date().timeIntervalSinceReferenceDate
                guard wait > 0 else { return }
                try? await Task.sleep(nanoseconds: UInt64((wait + 0.05) * 1_000_000_000))
                settleTick += 1
            }
    }

    @ViewBuilder private func rowView(_ row: MarkdownRow, now: TimeInterval) -> some View {
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
                Text(value).reveal(clock, base: row.base, now: now)
                    .foregroundStyle(p.secondary).frame(maxWidth: .infinity, alignment: .leading)
            }.fixedSize(horizontal: false, vertical: true)
        case .heading(let level, let value):
            Text(value).reveal(clock, base: row.base, now: now)
                .font(level <= 2 ? .orbisTitle() : .orbisBody(.semibold))
                .padding(.top, 4).accessibilityAddTraits(.isHeader)
        case .task(let checked, let value):
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Image(systemName: checked ? "checkmark.square.fill" : "square").orbisIconBaseline(OrbisTextSize.body)
                Text(value).reveal(clock, base: row.base, now: now)
            }
        case .bullet(let indent, let value):
            HStack(alignment: .firstTextBaseline, spacing: 9) {
                Text("•").reveal(clock, base: row.base, now: now)
                Text(value).reveal(clock, base: row.base + 1, now: now)
            }.padding(.leading, CGFloat(min(indent, 12)) * 6)
        case .text(let value):
            Text(value).reveal(clock, base: row.base, now: now)
        }
    }
}

private func markdownImage(_ value: String) -> (String, URL)? {
    guard let close = value.range(of: "]("), value.hasSuffix(")") else { return nil }
    let alt = String(value[value.index(value.startIndex, offsetBy: 2)..<close.lowerBound])
    let target = String(value[close.upperBound..<value.index(before: value.endIndex)]).trimmingCharacters(in: CharacterSet(charactersIn: "<> "))
    guard let url = URL(string: target), ["http", "https"].contains(url.scheme?.lowercased() ?? "") else { return nil }
    return (alt, url)
}

private final class MarkdownCacheEntry<Value> {
    let value: Value
    init(_ value: Value) { self.value = value }
}

/// Markdown 解析结果按原文缓存。每次流式增量都会重绘整页，若每次都重新解析所有可见消息
/// （尤其是逐行 `AttributedString(markdown:)`），主线程会被占满；缓存后只有正在增长的那条要重新解析。
private enum MarkdownCache {
    private static let blockStore = makeStore(MarkdownCacheEntry<[MarkdownBlock]>.self, limit: 300)
    private static let sectionStore = makeStore(MarkdownCacheEntry<[MarkdownTextSection]>.self, limit: 600)
    private static let inlineStore = makeStore(MarkdownCacheEntry<AttributedString>.self, limit: 5000)
    private static let rowStore = makeStore(MarkdownCacheEntry<[MarkdownRow]>.self, limit: 300)

    private static func makeStore<Entry: AnyObject>(_: Entry.Type, limit: Int) -> NSCache<NSString, Entry> {
        let store = NSCache<NSString, Entry>()
        store.countLimit = limit
        return store
    }

    static func blocks(_ text: String) -> [MarkdownBlock] {
        if let hit = blockStore.object(forKey: text as NSString) { return hit.value }
        let value = markdownBlocks(text)
        blockStore.setObject(MarkdownCacheEntry(value), forKey: text as NSString)
        return value
    }

    static func sections(_ text: String) -> [MarkdownTextSection] {
        if let hit = sectionStore.object(forKey: text as NSString) { return hit.value }
        let value = markdownTextSections(text)
        sectionStore.setObject(MarkdownCacheEntry(value), forKey: text as NSString)
        return value
    }

    static func inline(_ text: String) -> AttributedString {
        if let hit = inlineStore.object(forKey: text as NSString) { return hit.value }
        let value = (try? AttributedString(markdown: text, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(text)
        inlineStore.setObject(MarkdownCacheEntry(value), forKey: text as NSString)
        return value
    }

    static func renderedLength(_ text: String) -> Int {
        rows(text).last.map { $0.base + $0.length } ?? 0
    }

    fileprivate static func rows(_ text: String) -> [MarkdownRow] {
        if let hit = rowStore.object(forKey: text as NSString) { return hit.value }
        var rows: [MarkdownRow] = []
        var offset = 0
        func add(_ id: String, _ kind: MarkdownRow.Kind, _ length: Int) {
            rows.append(MarkdownRow(id: id, kind: kind, base: offset, length: length))
            offset += length
        }
        func count(_ value: AttributedString) -> Int { String(value.characters).utf16.count }
        for block in blocks(text) {
            if case .code(let language) = block.kind {
                add("code-\(block.id)", .code(language, block.text), block.text.utf16.count)
                continue
            }
            for section in sections(block.text) {
                let id = "text-\(block.id)-\(section.id)"
                if section.kind == .table { add(id, .table(section), 0); continue }
                let line = section.text.trimmingCharacters(in: .whitespaces)
                let indent = section.text.prefix(while: { $0 == " " || $0 == "\t" }).count
                let hashes = line.prefix(while: { $0 == "#" }).count
                if line.isEmpty { add(id, .spacer, 0) }
                else if ["---", "***", "___"].contains(line) { add(id, .divider, 0) }
                else if line.hasPrefix("!["), let image = markdownImage(line) { add(id, .image(image.0, image.1), 0) }
                else if line.hasPrefix("> ") {
                    let value = inline(String(line.dropFirst(2))); add(id, .quote(value), count(value))
                } else if (1...6).contains(hashes), line.dropFirst(hashes).hasPrefix(" ") {
                    let value = inline(String(line.dropFirst(hashes + 1))); add(id, .heading(hashes, value), count(value))
                } else if line.hasPrefix("- [ ] ") || line.hasPrefix("- [x] ") || line.hasPrefix("- [X] ") {
                    let value = inline(String(line.dropFirst(6))); add(id, .task(!line.hasPrefix("- [ ] "), value), count(value))
                } else if line.hasPrefix("- ") || line.hasPrefix("* ") {
                    let value = inline(String(line.dropFirst(2))); add(id, .bullet(indent, value), count(value) + 1)
                } else {
                    let value = inline(line); add(id, .text(value), count(value))
                }
            }
        }
        rowStore.setObject(MarkdownCacheEntry(rows), forKey: text as NSString)
        return rows
    }
}

private struct CodeBlockView: View {
    @Environment(\.colorScheme) private var scheme
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
                OrbisCopyButton(label: "复制代码", size: 28) { text }
            }.padding(.top, -6).padding(.trailing, -8)
            ScrollView(.horizontal) {
                Text(text).reveal(clock, base: base, now: now)
                    .font(.orbisLabel(mono: true)).fixedSize(horizontal: true, vertical: false).textSelection(.enabled).padding(.bottom, 4)
            }
        }.neuSurface(inset: true, radius: 14, intensity: 0.35, padding: 12)
    }
}

private struct SlashPickerView: View {
    @EnvironmentObject private var store: OrbisStore
    @Environment(\.colorScheme) private var scheme
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
                    if let hint = argument.hint { Text(hint).font(.orbisCaption()).foregroundStyle(p.secondary) }
                    ForEach(argument.options ?? []) { option in
                        Button { input = "/\(command.name) \(option.value)" } label: {
                            VStack(alignment: .leading, spacing: 3) {
                                Text(option.label).font(.orbisLabel(.medium))
                                if let description = option.description { Text(description).font(.orbisCaption()).foregroundStyle(p.secondary).lineLimit(2) }
                            }.frame(maxWidth: .infinity, minHeight: 48, alignment: .leading).padding(.horizontal, 12)
                        }.buttonStyle(NeuButtonStyle(radius: 12))
                    }
                } else {
                    let query = String(input.trimmingCharacters(in: .whitespacesAndNewlines).dropFirst()).lowercased()
                    // Built-in commands first, then by name: the same order as Android.
                    let filtered = commands.filter { query.isEmpty || $0.name.lowercased().contains(query) }
                        .sorted { ($0.source == "builtin" ? 0 : 1, $0.name) < ($1.source == "builtin" ? 0 : 1, $1.name) }
                    if filtered.isEmpty { Text(commands.isEmpty ? "当前会话尚未提供可用命令" : "没有匹配的命令").font(.orbisCaption()).foregroundStyle(p.secondary).padding(12) }
                    ForEach(filtered) { command in
                        Button {
                            if command.name == "tree" { input = ""; selected = nil; onHistory() }
                            else { selected = command.name; input = "/" + command.name + (command.argument == nil ? "" : " ") }
                        } label: {
                            HStack(spacing: 10) {
                                Text("/" + command.name).font(.orbisLabel(.semibold, mono: true))
                                Text(command.description ?? "").font(.orbisCaption()).foregroundStyle(p.secondary).lineLimit(2)
                                Spacer(minLength: 0)
                                // Only a non-built-in source is worth naming; built-ins belong to this agent.
                                if let source = slashSourceTitle(command.source) {
                                    Text(source).font(.orbisCaption()).foregroundStyle(.tint)
                                }
                            }.frame(minHeight: 48).padding(.horizontal, 12)
                        }.buttonStyle(NeuButtonStyle(radius: 12))
                    }
                }
            }.padding(8)
                .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { contentHeight = $0 }
        // A fixed height keeps the conversation, not the picker, absorbing the keyboard's squeeze.
        }.frame(height: min(contentHeight, 180)).scrollBounceBehavior(.basedOnSize).padding(.horizontal, 12)
    }
}

struct PermissionsView: View {
    @EnvironmentObject private var store: OrbisStore
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var scheme
    let runtime: RuntimeSummary
    var body: some View {
        let p = OrbisPalette(scheme)
        VStack(spacing: 16) {
            OrbisPageHeader(title: "会话权限", closes: true, back: { dismiss() }) { EmptyView() }
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    if let permissions = store.selectedRuntime?.permissionManagement {
                        Text(permissions.summary).font(.orbisBody(.semibold))
                        Text(permissions.details).font(.orbisLabel()).foregroundStyle(p.secondary)
                        ForEach(permissions.settings) { setting in
                            VStack(alignment: .leading, spacing: 10) {
                                Text(setting.label).font(.orbisBody(.semibold)).padding(.horizontal, 4)
                                ForEach(setting.options) { option in
                                    Button { store.updatePermission(settingId: setting.id, value: option.value) } label: {
                                        HStack {
                                            Text(option.label).font(.orbisLabel()).frame(maxWidth: .infinity, alignment: .leading)
                                            if option.value == setting.currentValue { Image(systemName: "checkmark").font(.orbisLabel(.semibold)) }
                                        }.padding(.horizontal, 14).frame(minHeight: 48)
                                    }.buttonStyle(NeuButtonStyle(selected: option.value == setting.currentValue))
                                        .disabled(!store.canSend || store.selectedRuntime?.status != "idle" || setting.disabledReason != nil || !store.pendingActionIds.isEmpty)
                                }
                                if let reason = setting.disabledReason { Text(reason).font(.orbisCaption()).foregroundStyle(p.secondary).padding(.horizontal, 4) }
                            }.neuSurface(radius: OrbisRadius.card, padding: OrbisRadius.cardPadding)
                        }
                        if runtime.status != "idle" { OrbisNotice(text: "会话空闲时可调整权限。") }
                    }
                }.padding(24)
            }
        }.background(p.base.ignoresSafeArea())
            .onChange(of: store.selectedRuntimeId) { _, _ in dismiss() }
    }
}

private struct MarkdownTableView: View {
    let section: MarkdownTextSection
    var body: some View {
        ScrollView(.horizontal) {
            Grid(alignment: .topLeading, horizontalSpacing: 0, verticalSpacing: 0) {
                ForEach(Array(section.rows.enumerated()), id: \.offset) { rowIndex, row in
                    GridRow(alignment: .top) {
                        ForEach(Array((section.rows.first ?? []).indices), id: \.self) { column in
                            Text(MarkdownCache.inline(column < row.count ? row[column] : ""))
                                .font(.orbisLabel(rowIndex == 0 ? .semibold : .regular))
                                .frame(width: 150, alignment: alignment(column)).padding(10)
                                .frame(maxHeight: .infinity, alignment: .top)
                                // Rows separate by a lightness step, not by drawn grid lines.
                                .background(OrbisLayerFill(offset: 1, opacity: rowIndex == 0 ? 1 : rowIndex % 2 == 0 ? 0.5 : 0))
                        }
                    }
                }
            }
        }.neuSurface(inset: true, radius: 14, intensity: 0.35).clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous)).textSelection(.enabled)
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
    let alt: String
    let url: URL
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            AsyncImage(url: url) { phase in
                if let image = phase.image { image.resizable().scaledToFit().frame(maxHeight: 280).accessibilityLabel(alt.isEmpty ? "消息图片" : alt) }
                else if phase.error != nil { Label(alt.isEmpty ? "图片未能加载" : alt, systemImage: "photo").font(.orbisLabel()) }
                else { ProgressView().frame(maxWidth: .infinity, minHeight: 80) }
            }
            Link(alt.isEmpty ? "打开图片" : alt, destination: url).font(.orbisCaption())
        }.neuSurface(inset: true, radius: 14, intensity: 0.35, padding: 12)
    }
}


struct QueuedMessagesView: View {
    @EnvironmentObject private var store: OrbisStore
    @Environment(\.colorScheme) private var scheme
    let runtimeId: String
    var body: some View {
        let items = store.queuedMessages[runtimeId] ?? []
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
                Text(deliveryTitle(item.delivery) + "，" + queueStateTitle(item.state)).font(.orbisCaption(.semibold))
                Spacer(minLength: 8)
                if item.state == "accepted" {
                    OrbisTextButton(title: store.pendingQueueCancellations.contains(item.queueId) ? "撤回中…" : "撤回", symbol: "xmark") { _ = store.cancelQueuedMessage(item.queueId) }
                        .disabled(!store.canSend || store.pendingQueueCancellations.contains(item.queueId)).accessibilityIdentifier("queue-cancel-" + item.queueId)
                }
            }
            Text(item.text).font(.orbisCaption()).lineLimit(3).textSelection(.enabled)
            if let error = item.error { Text(error).font(.orbisCaption()).foregroundStyle(OrbisPalette(scheme).error) }
        }.padding(12).neuSurface(inset: true, radius: 14, intensity: 0.35)
    }
}

/// Notices float over the top of the transcript. Each one is a single opaque banner that
/// carries its own close action and, when unverified, the re-check action inside it.
struct RuntimeNoticesView: View {
    @EnvironmentObject private var store: OrbisStore
    @EnvironmentObject private var notifications: RuntimeNotifications
    @Environment(\.colorScheme) private var scheme
    let runtimeId: String
    /// 只有 Codex（含桌面版）会上报通知来源；其他运行时没有「待核对」可言，不显示核对提示。
    let supported: Bool
    var body: some View {
        if let projection = notifications.projections[runtimeId], !projection.items.isEmpty || (supported && !projection.complete) {
            let unverified = supported && (projection.verification == "unknown" || !projection.complete || store.connection != .secured)
            ScrollView {
                VStack(spacing: 8) {
                    if projection.items.isEmpty {
                        banner(text: "通知状态待核对", error: false, recheck: unverified, close: nil)
                    }
                    ForEach(Array(projection.items.enumerated()), id: \.element.id) { index, notice in
                        banner(text: notice.message, error: notice.severity != "info",
                               recheck: index == 0 && (unverified || (supported && notice.verification == "unknown")),
                               close: { notifications.dismiss(runtimeId: runtimeId, notificationId: notice.notificationId) })
                    }
                }.padding(.vertical, 6)
            }.frame(maxHeight: 180).scrollBounceBehavior(.basedOnSize).accessibilityIdentifier("runtime-notifications")
        }
    }

    private func banner(text: String, error: Bool, recheck: Bool, close: (() -> Void)?) -> some View {
        let p = OrbisPalette(scheme)
        return HStack(alignment: .top, spacing: 10) {
            Image(systemName: error ? "exclamationmark.circle" : "info.circle")
                .foregroundStyle(error ? p.error : p.secondary).orbisIconBaseline(OrbisTextSize.label)
            VStack(alignment: .leading, spacing: 6) {
                Text(text).font(.orbisLabel()).foregroundStyle(error ? p.error : p.text)
                    .fixedSize(horizontal: false, vertical: true)
                if recheck {
                    HStack(spacing: 10) {
                        Text("通知状态待核对").font(.orbisCaption()).foregroundStyle(p.secondary)
                        Button { notifications.sync(runtimeId: runtimeId) } label: {
                            Label("重新核对", systemImage: "arrow.clockwise").font(.orbisCaption(.semibold))
                        }.buttonStyle(.plain).foregroundStyle(.tint).disabled(store.connection != .secured)
                    }
                }
            }.frame(maxWidth: .infinity, alignment: .leading)
            if let close {
                OrbisIconButton(symbol: "xmark", label: "关闭通知", size: 28, action: close)
                    .orbisNested().disabled(store.connection != .secured)
            }
        }.neuSurface(radius: OrbisRadius.control, intensity: 0.6, padding: 12)
    }
}

private struct RuntimeInfoView: View {
    @EnvironmentObject private var store: OrbisStore
    @EnvironmentObject private var agent: AgentState
    @Environment(\.dismiss) private var dismiss
    let runtime: RuntimeSummary
    let onAlias: () -> Void
    private var snapshot: AgentSnapshot? { agent.snapshots[runtime.runtimeId] }
    private func ready(_ name: String) -> Bool { snapshot?.missing[name] == nil && (snapshot?.domains[name]?.availability ?? "ready") == "ready" }
    var body: some View {
        VStack(spacing: 0) {
            OrbisPageHeader(title: "会话信息", closes: true, back: { dismiss() }) {
                OrbisIconButton(symbol: "pencil", label: "修改会话别名", action: onAlias)
                OrbisIconButton(symbol: "arrow.clockwise", label: "核对会话状态") { agent.subscribe(runtime: runtime, force: true) }.disabled(!store.canSend)
            }
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    StatusSection(title: "模型与上下文") {
                        StatusFact(label: "模型", value: ready("model") ? runtime.model?.name ?? runtime.model?.id ?? "未报告" : "状态待核对")
                        StatusFact(label: "供应商", value: ready("model") ? runtime.model?.provider ?? "未报告" : "状态待核对")
                        StatusFact(label: "思考级别", value: ready("model") ? runtime.thinkingLevel ?? "来源未报告" : "状态待核对")
                        StatusFact(label: "上下文", value: ready("context") ? contextText : "状态待核对")
                    }
                    StatusSection(title: "执行状态") {
                        StatusFact(label: "当前状态", value: ready("execution") ? runtimeStatusTitle(runtime.status) : "状态待核对")
                        if ready("execution"), let execution = snapshot?.domains["execution"]?.value {
                            StatusFact(label: "重试", value: activity(execution["retry"]))
                            StatusFact(label: "上下文压缩", value: activity(execution["compaction"]))
                            if let start = execution["turn"]["startedAt"].number {
                                TimelineView(.periodic(from: .now, by: 1)) { context in
                                    let duration = execution["turn"]["durationMs"].number ?? max(0, context.date.timeIntervalSince1970 * 1000 - start)
                                    StatusFact(label: execution["turn"]["durationMs"] == .null ? "本轮已运行" : "本轮耗时", value: String(format: "%.1f 秒", duration / 1000))
                                }
                            }
                        }
                    }
                    ForEach((store.commands[runtime.runtimeId] ?? []).filter { ["model", "thinking"].contains($0.name) && $0.argument?.options?.isEmpty == false }) { command in
                        StatusSection(title: command.description ?? command.name) {
                            ForEach(command.argument?.options ?? []) { option in
                                OrbisActionButton(title: option.label) { _ = store.executeSlash(command.name, args: option.value) }.disabled(!store.canSend || !store.pendingActionIds.isEmpty)
                            }
                        }
                    }
                    StatusSection(title: "状态来源") {
                        if let snapshot {
                            if let error = snapshot.error { OrbisNotice(text: error, error: true) }
                            ForEach(AgentState.domainNames, id: \.self) { name in
                                StatusFact(label: agentDomainTitle(name), value: snapshot.missing[name] ?? snapshot.domains[name].map { $0.availability == "ready" ? ($0.completeness == "complete" || $0.projectionComplete == true ? "已核对" : "部分状态") : "当前不可用" } ?? "尚未读取")
                            }
                        } else { Text("尚未读取会话状态").font(.orbisLabel()) }
                    }
                }.padding(20)
            }
        }
    }
    private var contextText: String {
        guard let usage = runtime.contextUsage else { return "来源未报告" }
        var parts: [String] = []
        if let percent = contextUsagePercent(usage) { parts.append(String(format: "%.1f%%", percent)) }
        if let tokens = usage.tokens { parts.append("\(tokens.formatted()) tokens") }
        if let window = usage.contextWindow { parts.append("窗口 \(window.formatted())") }
        return parts.isEmpty ? "来源未报告" : parts.joined(separator: "，")
    }
    private func activity(_ value: HostJSON) -> String {
        guard value != .null, value.string != "unavailable" else { return "来源尚未提供" }
        let phase = ["idle": "空闲", "running": "进行中", "failed": "失败"][value["phase"].string ?? ""] ?? "待核对"
        return [phase, value["attempt"].number.map { "第 \(Int($0)) 次" }, value["detail"].string].compactMap { $0 }.joined(separator: "，")
    }
}

private func agentDomainTitle(_ name: String) -> String {
    ["identity": "会话身份", "availability": "可用性", "execution": "执行", "delivery": "消息队列", "interactions": "交互", "permissions": "权限", "model": "模型", "context": "上下文", "capabilities": "可用命令", "resources": "资源", "providerBinding": "供应商归属", "workspaceRef": "工作区", "artifacts": "附件", "records": "诊断记录"][name] ?? name
}
