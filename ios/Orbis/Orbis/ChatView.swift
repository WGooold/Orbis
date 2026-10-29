import SwiftUI
import UIKit
import UniformTypeIdentifiers

private struct ChatBottomPreference: PreferenceKey {
    static var defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = nextValue() }
}

private struct ChatRowsPreference: PreferenceKey {
    static var defaultValue: [String: CGRect] = [:]
    static func reduce(value: inout [String: CGRect], nextValue: () -> [String: CGRect]) { value.merge(nextValue(), uniquingKeysWith: { _, next in next }) }
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
    @State private var followsLatest = true
    @State private var hasPositioned = false
    @State private var newestRequest = 0
    @State private var selectedCommand: String?
    @State private var deliveryChoices = false
    @State private var permissionsOpen = false
    @State private var runtimeInfoOpen = false
    @State private var filePickerOpen = false
    @State private var firstVisibleRow: String?
    @State private var historyAnchor: String?
    @State private var topArmed = false
    @FocusState private var composerFocused: Bool

    private var kind: String? { store.agentKind(runtime) }
    /// Claude Code 只能等当前回合结束后提交（没有 Steer），也不能随消息附带文件。
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
            OrbisHeader {
                OrbisIconButton(symbol: "arrow.left", label: "返回", action: onBack)
            } title: {
                VStack(alignment: .leading, spacing: 5) {
                    HStack(spacing: 6) {
                        AgentEmblem(kind: kind, size: 18, recessed: false)
                        Text(agentTitle(kind)).font(.system(size: 12, weight: .semibold)).foregroundStyle(accent)
                        Text(store.displayName(runtime)).font(.system(size: 16, weight: .semibold)).lineLimit(1)
                    }
                    HStack(spacing: 7) {
                        if store.isSyncing { ProgressView().controlSize(.mini) }
                        RuntimeStatusLabel(status: runtime.status)
                        if let model = runtime.model, domainReady("model") {
                            Text(model.name ?? model.id).font(.system(size: 11)).foregroundStyle(OrbisPalette(scheme).secondary).lineLimit(1)
                        }
                    }
                }.onTapGesture(perform: onAlias).accessibilityLabel("\(agentTitle(kind))，\(store.displayName(runtime))，\(runtimeStatusTitle(runtime.status))")
            } trailing: {
                OrbisIconButton(symbol: "info.circle", label: "会话信息") { composerFocused = false; runtimeInfoOpen = true }
                OrbisIconButton(symbol: "clock.arrow.circlepath", label: "历史与分支", action: onHistory)
                OrbisIconButton(symbol: "arrow.down.to.line", label: "下载", action: onDownloads)
            }
            RuntimeNoticesView(runtimeId: runtime.runtimeId).padding(.horizontal, 16)
            conversation
            if store.isViewingCachedSession { cachedComposer } else { composer }
        }.background(OrbisPalette(scheme).base.ignoresSafeArea()).tint(accent)
            .fileImporter(isPresented: $filePickerOpen, allowedContentTypes: [.item], allowsMultipleSelection: true) { result in
                switch result {
                case .success(let urls): transfers.upload(urls: Array(urls.prefix(max(0, 10 - attachments.count))), runtime: runtime)
                case .failure(let error): transfers.error = error.localizedDescription
                }
            }
            .sheet(isPresented: $permissionsOpen) {
                PermissionsView(runtime: runtime).orbisSheet([.medium, .large])
            }
            .sheet(isPresented: $runtimeInfoOpen) { RuntimeInfoView(runtime: runtime).orbisSheet([.large]) }
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

    private var conversation: some View {
        let kind = self.kind
        let presentation = chatPresentation(store.messages)
        return ScrollViewReader { proxy in
            GeometryReader { viewport in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 16) {
                        if store.hasOlderHistory[runtime.runtimeId] == true || store.historyErrors[runtime.runtimeId] != nil {
                            VStack(alignment: .leading, spacing: 8) {
                                HStack {
                                    Text("还有更早的历史").font(.system(size: 12))
                                    Spacer()
                                    if store.historyLoading.contains(runtime.runtimeId) { ProgressView().controlSize(.small) }
                                    else {
                                        OrbisTextButton(title: store.historyErrors[runtime.runtimeId] == nil ? "加载" : "重试", symbol: "arrow.up", tint: accent) { loadOlder() }
                                            .disabled(store.isSyncing || (!store.canSend && !store.isViewingCachedSession))
                                    }
                                }
                                if let error = store.historyErrors[runtime.runtimeId] { Text(error).font(.system(size: 12)).foregroundStyle(OrbisPalette(scheme).error) }
                            }.padding(12).neuSurface(inset: true, radius: 14, intensity: 0.35)
                        }
                        HStack {
                            Text(store.isViewingCachedSession ? "本机缓存" : store.isSyncing ? "正在同步最近消息…" : "最近消息")
                                .font(.system(size: 11)).foregroundStyle(OrbisPalette(scheme).secondary)
                            Spacer()
                            OrbisTextButton(title: "刷新", symbol: "arrow.clockwise", tint: accent) { store.refresh() }
                                .disabled(store.isSyncing || !store.canSend)
                        }.padding(.horizontal, 4)
                        if presentation.messages.isEmpty {
                            OrbisEmptyState(symbol: "bubble.left.and.bubble.right", title: store.isSyncing ? "正在加载会话" : "继续这段会话", detail: store.isSyncing ? nil : "发送消息，或输入 / 选择命令。")
                                .frame(minHeight: max(180, viewport.size.height - 100))
                        }
                        ForEach(chatRows(presentation.messages, turnIdsByMessageId: Dictionary(store.turnTimings.compactMap { timing in timing.messageId.map { ($0, timing.turnId) } }, uniquingKeysWith: { _, last in last }))) { row in
                            ChatMessageRow(row: row, kind: kind, toolResults: presentation.toolResults).id(row.id)
                                .background(GeometryReader { geometry in Color.clear.preference(key: ChatRowsPreference.self, value: [row.id: geometry.frame(in: .named("chat-viewport"))]) })
                        }
                        LiveToolsView(runtime: runtime)
                        Color.clear.frame(height: 1).id("chat-bottom")
                            .background(GeometryReader { geo in Color.clear.preference(key: ChatBottomPreference.self, value: geo.frame(in: .named("chat-viewport")).maxY) })
                    }.padding(.horizontal, 16).padding(.top, 4).padding(.bottom, 20)
                }.coordinateSpace(name: "chat-viewport").scrollDismissesKeyboard(.interactively)
                    .onPreferenceChange(ChatBottomPreference.self) { bottom in
                        guard hasPositioned else { return }
                        followsLatest = bottom <= viewport.size.height + 100
                    }
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
                        if !followsLatest && !store.messages.isEmpty {
                            OrbisIconButton(symbol: "arrow.down", label: "跳到最新消息", tint: accent) { newestRequest += 1 }
                                .padding(16)
                        }
                    }
                    .onChange(of: store.messages) { _, _ in
                        if followsLatest || !hasPositioned {
                            proxy.scrollTo("chat-bottom", anchor: .bottom)
                            hasPositioned = true
                        }
                    }
                    .onChange(of: newestRequest) { _, _ in
                        followsLatest = true; hasPositioned = true
                        withAnimation(reduceMotion ? nil : .easeOut(duration: 0.18)) { proxy.scrollTo("chat-bottom", anchor: .bottom) }
                    }
                    .onChange(of: store.historyPageRevision) { _, _ in
                        if let historyAnchor { proxy.scrollTo(historyAnchor, anchor: .top) }
                        self.historyAnchor = nil
                    }
                    .onChange(of: store.historyLoading.contains(runtime.runtimeId)) { old, loading in
                        if old && !loading && store.historyErrors[runtime.runtimeId] != nil { historyAnchor = nil }
                    }
                    .onChange(of: composerFocused) { _, focused in if focused && followsLatest { newestRequest += 1 } }
                    .onAppear { proxy.scrollTo("chat-bottom", anchor: .bottom); hasPositioned = !store.messages.isEmpty }
            }
        }
    }

    private var cachedComposer: some View {
        VStack(spacing: 10) {
            Text("本机缓存 · 可离线浏览，发送消息前需在电脑继续此会话").font(.system(size: 12)).foregroundStyle(OrbisPalette(scheme).secondary)
            if let session = store.sessions.first(where: { $0.sessionId == runtime.sessionId }) {
                OrbisActionButton(title: "在电脑继续会话", symbol: "play") { store.activate(session) }
                    .disabled(store.connection != .secured || store.activatingSessionId != nil)
            }
        }.padding(16)
    }

    private var composer: some View {
        VStack(spacing: 10) {
            if let percent = contextUsagePercent(runtime.contextUsage), domainReady("context") {
                GeometryReader { geometry in
                    Rectangle().fill(accent.opacity(0.15))
                        .overlay(alignment: .leading) { Rectangle().fill(percent >= 90 ? OrbisPalette(scheme).error : accent).frame(width: geometry.size.width * min(100, max(0, percent)) / 100) }
                }.frame(height: 2).accessibilityLabel("上下文已使用 \(Int(percent))%")
            }
            if store.connection != .secured {
                OrbisNotice(text: "连接恢复后可继续发送，草稿已保留。").padding(.horizontal, 16)
            }
            if let feedback = store.actionFeedback {
                Text(feedback).font(.system(size: 12)).foregroundStyle(OrbisPalette(scheme).secondary)
            }
            QueuedMessagesView(runtimeId: runtime.runtimeId)
            InteractionWorkspaceView(runtimeId: runtime.runtimeId)
            if deliveryChoices {
                HStack(spacing: 12) {
                    OrbisActionButton(title: "Follow-up", tint: accent) { submit(delivery: "followUp") }
                    OrbisActionButton(title: "Steer", tint: accent) { submit(delivery: "steer") }
                }.padding(.horizontal, 16)
            }
            if !slash { HStack(spacing: 12) {
                VStack(alignment: .leading, spacing: 4) {
                    Label(runtime.cwd, systemImage: "folder").lineLimit(1).truncationMode(.middle)
                    Button(action: store.refreshWorkingBranch) {
                        Label(branchTitle, systemImage: "point.3.connected.trianglepath.dotted").lineLimit(1)
                    }.buttonStyle(.plain).accessibilityLabel("刷新 Git 工作分支，" + branchTitle)

                }.font(.system(size: 11, design: .monospaced)).foregroundStyle(OrbisPalette(scheme).secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                if let permissions = runtime.permissionManagement {
                    Button { composerFocused = false; permissionsOpen = true } label: {
                        HStack(spacing: 5) {
                            Image(systemName: "shield.lefthalf.filled")
                            Text(permissions.summary).lineLimit(1)
                            Image(systemName: "chevron.right").font(.system(size: 9))
                        }.font(.system(size: 11)).frame(minHeight: 48)
                            .foregroundStyle(permissions.tone == "problem" ? OrbisPalette(scheme).error : accent)
                    }.buttonStyle(.plain).accessibilityLabel("会话权限：\(permissions.summary)")
                }
            }.padding(.horizontal, 20) }
            AttachmentStrip(runtime: runtime)
            if slash { SlashPickerView(runtime: runtime, selected: $selectedCommand, input: draft, onHistory: onHistory) }
            HStack(alignment: .bottom, spacing: 10) {
                if !claudeComposer {
                    OrbisIconButton(symbol: "paperclip", label: "发送文件到电脑", tint: accent) {
                        composerFocused = false; filePickerOpen = true
                    }.disabled(!store.canSend || transfers.preparing || attachments.count >= 10)
                }
                TextField("发送消息", text: draft, axis: .vertical)
                    .accessibilityIdentifier("chat-composer")
                    .font(.system(size: 15)).lineLimit(1...6).focused($composerFocused)
                    .padding(.horizontal, 14).padding(.vertical, 15).frame(minHeight: 56)
                    .neuSurface(inset: true, radius: 16, intensity: 0.6)
                    .overlay { RoundedRectangle(cornerRadius: 16).stroke(composerFocused ? accent.opacity(0.5) : .clear, lineWidth: 1) }
                if runtime.status == "running" && draft.wrappedValue.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && attachments.isEmpty {
                    OrbisIconButton(symbol: "stop.fill", label: "停止生成", tint: OrbisPalette(scheme).error, action: store.stopRuntime).disabled(!store.canSend)
                } else {
                    OrbisIconButton(symbol: "arrow.up", label: "发送消息", tint: accent) {
                        if runtime.status == "running" && !slash && claudeComposer { submit(delivery: "followUp") }
                        else if runtime.status == "running" && !slash { deliveryChoices.toggle() }
                        else { submit() }
                    }.disabled(!canSubmit)
                }
            }.padding(.horizontal, 12).padding(.bottom, 12)
        }.padding(.top, 8).background(OrbisPalette(scheme).base)
    }

    private func domainReady(_ name: String) -> Bool {
        guard let snapshot = agent.snapshots[runtime.runtimeId] else { return true }
        return snapshot.missing[name] == nil && (snapshot.domains[name]?.availability ?? "ready") == "ready"
    }

    private var branchTitle: String {
        guard let branch = store.workingBranches[runtime.runtimeId], branch.cwd == runtime.cwd, branch.sessionId == runtime.sessionId else { return "分支信息待同步" }
        return branch.branch ?? branch.commit.map { "HEAD · \(String($0.prefix(8)))（分离）" } ?? (branch.loaded ? "未获取到 Git 分支" : "分支信息待同步")
    }

    private func loadOlder() {
        let anchor = firstVisibleRow
        if store.loadOlderHistory() { historyAnchor = anchor; followsLatest = false }
    }

    private func commandArguments(_ command: SlashCommand) -> String {
        String(draft.wrappedValue.dropFirst(command.name.count + 1)).trimmingCharacters(in: .whitespacesAndNewlines)
    }
    private func submit(delivery: String? = nil) {
        guard canSubmit else { return }
        let accepted: Bool
        if slash, let command { accepted = store.executeSlash(command.name, args: commandArguments(command)) }
        else { accepted = store.sendMessage(draft.wrappedValue.isEmpty ? "请查看附件。" : draft.wrappedValue, delivery: delivery, attachmentIds: Set(attachments.map(\.id))) }
        if accepted { transfers.detach(Set(attachments.map(\.id))); draft.wrappedValue = ""; selectedCommand = nil; deliveryChoices = false; newestRequest += 1 }
    }
}

struct ChatMessageRow: View {
    @EnvironmentObject private var store: OrbisStore
    @Environment(\.colorScheme) private var scheme
    @State private var copied = false
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
                        Text(agentTitle(kind)).font(.system(size: 12, weight: .semibold)).foregroundStyle(OrbisPalette(scheme).agent(kind))
                        Spacer(minLength: 8)
                        // 复制整轮回复。不用长按手势：它挂在每条消息上会和滚动、文本选择抢触摸。
                        OrbisIconButton(symbol: copied ? "checkmark" : "doc.on.doc", label: copied ? "已复制" : "复制回复",
                                        tint: copied ? OrbisPalette(scheme).success : nil, size: 26, action: copy)
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
                            .font(.system(size: 11, design: .monospaced)).foregroundStyle(OrbisPalette(scheme).secondary)
                    }
                }
            }.padding(16).frame(maxWidth: row.isUser ? nil : .infinity, alignment: .leading)
                .neuSurface(inset: row.isUser, radius: 20, intensity: row.isUser ? 0.6 : 0.4)
                .accessibilityAction(named: "复制", copy)
            if !row.isUser { Spacer(minLength: 8) }
        }
    }
    private func copy() {
        UIPasteboard.general.string = row.messages.map(\.text).joined(separator: "\n\n")
        copied = true
        Task { @MainActor in
            try? await Task.sleep(nanoseconds: 1_500_000_000)
            copied = false
        }
    }
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
                        Text(content.text ?? "思考中…").font(.system(size: 13)).textSelection(.enabled)
                    }
                case "tool_call", "toolCall":
                    let result = content.toolCallId.flatMap { toolResults[$0] }
                    if let summary = result?.toolSummary ?? content.summary { ToolSummaryView(summary: summary) }
                    else {
                        let live = content.toolCallId == nil && content.arguments == nil && content.text?.isEmpty == false
                        let status = result?.isError == true ? "执行失败" : live ? "参数接收中" : "已完成"
                        CompactDisclosure(title: (content.toolName ?? result?.toolName ?? message.toolName ?? "工具") + " · " + status, symbol: "wrench.and.screwdriver") {
                            VStack(alignment: .leading, spacing: 10) {
                                if let arguments = toolArgumentsText(content), !arguments.isEmpty {
                                    Text(arguments).font(.system(size: 12, design: .monospaced)).textSelection(.enabled)
                                }
                                if let result { Text(fullMessageText(result)).font(.system(size: 12, design: .monospaced)).textSelection(.enabled) }
                            }
                        }
                    }
                case "artifact":
                    if let file = content.artifact {
                        Button { transfers.download(artifact: file) } label: {
                            Label(file.fileName, systemImage: "arrow.down.doc").font(.system(size: 13)).padding(12).frame(maxWidth: .infinity, alignment: .leading)
                        }.buttonStyle(NeuButtonStyle(radius: 12))
                    }
                default:
                    if let text = content.text, !text.isEmpty {
                        if message.role == "user" { Text(text).font(.system(size: 15)).textSelection(.enabled) }
                        else { MarkdownMessage(text: text) }
                    }
                }
            }
            if let truncated = message.content.first(where: { $0.truncated == true }) {
                Text(truncated.originalBytes.map { "有内容因超长被截断（原始 \($0.formatted()) 字节）" } ?? "有内容因超长被截断。")
                    .font(.system(size: 11)).foregroundStyle(OrbisPalette(scheme).secondary)
                OrbisTextButton(title: "查看完整内容", symbol: "doc.text.magnifyingglass") {
                    store.previewEntry(message.messageId)
                    fullEntryId = store.entryPreview?.entryId ?? message.messageId
                    fullOpen = true
                }.disabled(!store.canSend).accessibilityIdentifier("full-entry-" + message.messageId)
                if !store.canSend { Text("连接电脑并继续此会话后可取回完整内容。").font(.system(size: 11)).foregroundStyle(OrbisPalette(scheme).secondary) }
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
            OrbisPageHeader(title: "完整内容", back: { dismiss() }) {
                OrbisIconButton(symbol: "doc.on.doc", label: "复制完整内容") {
                    if let message = preview?.message { UIPasteboard.general.string = fullMessageText(message) }
                }.disabled(preview?.message == nil)
            }
            if preview?.loading == true { ProgressView("正在取回…") }
            if let message = preview?.message {
                ScrollView([.horizontal, .vertical]) {
                    Text(fullMessageText(message)).font(.system(size: 13, design: .monospaced)).textSelection(.enabled)
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

struct CompactDisclosure<Content: View>: View {
    @Environment(\.colorScheme) private var scheme
    let title: String
    let symbol: String
    @ViewBuilder let content: Content
    @State private var expanded = false
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Button { expanded.toggle() } label: {
                HStack(spacing: 8) {
                    Image(systemName: symbol)
                    Text(title).font(.system(size: 12, weight: .medium)).lineLimit(2)
                    Spacer()
                    Image(systemName: expanded ? "chevron.up" : "chevron.down").font(.system(size: 10))
                }.foregroundStyle(OrbisPalette(scheme).secondary).frame(minHeight: 40).contentShape(Rectangle())
            }.buttonStyle(.plain).accessibilityLabel("\(expanded ? "收起" : "展开")\(title)")
            if expanded { content }
        }.padding(.horizontal, 12).padding(.vertical, 4).neuSurface(inset: true, radius: 14, intensity: 0.35)
    }
}

struct ToolSummaryView: View {
    @EnvironmentObject private var store: OrbisStore
    @State private var detailOpen = false
    let summary: ToolSummary
    var body: some View {
        CompactDisclosure(title: "\(summary.toolName) · \(phase)", symbol: summary.isError == true ? "exclamationmark.circle" : "terminal") {
            VStack(alignment: .leading, spacing: 10) {
                if summary.durationMs != nil || summary.exitCode != nil {
                    HStack {
                        if let duration = summary.durationMs { Text(String(format: "耗时 %.1f 秒", Double(duration) / 1000)) }
                        if let code = summary.exitCode { Text("退出码 \(code)") }
                    }.font(.system(size: 11)).foregroundStyle(.secondary)
                }
                ForEach(Array([summary.inputSummary, summary.resultSummary, summary.errorSummary].compactMap { $0 }.enumerated()), id: \.offset) { _, part in
                    Text(part.text).font(.system(size: 12, design: .monospaced)).textSelection(.enabled)
                    if part.omitted { Text("内容已省略，当前显示摘要").font(.system(size: 11)).foregroundStyle(.secondary) }
                }
                if let tool = summary.tool, let runtime = store.selectedRuntime {
                    ForEach(summary.contents, id: \.part) { part in
                        if part.availability != "absent" {
                            OrbisActionButton(title: "查看" + toolPartTitle(part.part), symbol: "doc.text.magnifyingglass") {
                                store.toolContent.open(runtimeId: runtime.runtimeId, locator: ToolLocator(tool: tool, part: part.part)); detailOpen = true
                            }.disabled(!store.canSend || part.readCapability == "none" || !["readable", "pending"].contains(part.availability))
                            if ["temporarily-unavailable", "unrecoverable"].contains(part.availability) {
                                Text(part.availability == "unrecoverable" ? "此部分内容已无法恢复" : "来源暂时无法提供此部分内容").font(.system(size: 11)).foregroundStyle(.secondary)
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
        switch summary.phase { case "started", "running": return "执行中"; case "cancelled": return "已取消"; default: return summary.isError == true ? "失败" : "完成" }
    }
}

struct MarkdownMessage: View {
    @EnvironmentObject private var transfers: FileTransfers
    @Environment(\.colorScheme) private var scheme
    @Environment(\.openURL) private var openURL
    let text: String
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            ForEach(MarkdownCache.blocks(text)) { block in
                switch block.kind {
                case .text:
                    ForEach(MarkdownCache.sections(block.text)) { section in
                        if section.kind == .table { MarkdownTableView(section: section) }
                        else { markdownLine(section.text) }
                    }
                case .code(let language):
                    CodeBlockView(text: block.text, language: language)
                }
            }
        }.font(.system(size: 15)).textSelection(.enabled)
            .environment(\.openURL, OpenURLAction { url in
                if ["http", "https", "mailto"].contains(url.scheme?.lowercased() ?? "") { return .systemAction }
                let path = url.isFileURL ? url.path : url.absoluteString.removingPercentEncoding ?? url.absoluteString
                transfers.download(path: path)
                return .handled
            })
    }
    @ViewBuilder private func markdownLine(_ source: String) -> some View {
        let line = source.trimmingCharacters(in: .whitespaces)
        let indent = source.prefix(while: { $0 == " " || $0 == "\t" }).count
        if line.isEmpty { Spacer().frame(height: 2) }
        else if ["---", "***", "___"].contains(line) { Divider() }
        else if line.hasPrefix("!["), let image = markdownImage(line) { MarkdownImageView(alt: image.0, url: image.1) }
        else if line.hasPrefix("> ") {
            HStack(alignment: .top, spacing: 10) {
                RoundedRectangle(cornerRadius: 1).fill(OrbisPalette(scheme).accent.opacity(0.7)).frame(width: 3)
                inline(String(line.dropFirst(2))).font(.system(size: 14)).frame(maxWidth: .infinity, alignment: .leading)
            }.padding(12).neuSurface(inset: true, radius: 12, intensity: 0.3)
        } else {
            let hashes = line.prefix(while: { $0 == "#" }).count
            if (1...6).contains(hashes), line.dropFirst(hashes).hasPrefix(" ") {
                inline(String(line.dropFirst(hashes + 1))).font(.system(size: hashes == 1 ? 22 : hashes == 2 ? 19 : 16, weight: .semibold))
                    .padding(.top, 4).accessibilityAddTraits(.isHeader)
            } else if line.hasPrefix("- [ ] ") || line.hasPrefix("- [x] ") || line.hasPrefix("- [X] ") {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Image(systemName: line.hasPrefix("- [ ] ") ? "square" : "checkmark.square.fill").font(.system(size: 13))
                    inline(String(line.dropFirst(6)))
                }
            } else if line.hasPrefix("- ") || line.hasPrefix("* ") {
                HStack(alignment: .firstTextBaseline, spacing: 9) { Text("•"); inline(String(line.dropFirst(2))) }.padding(.leading, CGFloat(min(indent, 12)) * 6)
            } else { inline(line) }
        }
    }
    private func markdownImage(_ value: String) -> (String, URL)? {
        guard let close = value.range(of: "]("), value.hasSuffix(")") else { return nil }
        let alt = String(value[value.index(value.startIndex, offsetBy: 2)..<close.lowerBound])
        let target = String(value[close.upperBound..<value.index(before: value.endIndex)]).trimmingCharacters(in: CharacterSet(charactersIn: "<> "))
        guard let url = URL(string: target), ["http", "https"].contains(url.scheme?.lowercased() ?? "") else { return nil }
        return (alt, url)
    }
    private func inline(_ value: String) -> Text { Text(MarkdownCache.inline(value)) }
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
}

private struct CodeBlockView: View {
    @Environment(\.colorScheme) private var scheme
    let text: String
    let language: String
    @State private var copied = false
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text(language.isEmpty ? "代码" : language).font(.system(size: 11, design: .monospaced)).foregroundStyle(OrbisPalette(scheme).secondary)
                Spacer()
                Button { UIPasteboard.general.string = text; copied = true } label: {
                    Label(copied ? "已复制" : "复制", systemImage: copied ? "checkmark" : "doc.on.doc").font(.system(size: 11)).padding(.horizontal, 10).frame(minHeight: 36)
                }.buttonStyle(NeuButtonStyle(radius: 10))
            }
            ScrollView(.horizontal) { Text(text).font(.system(size: 12, design: .monospaced)).fixedSize(horizontal: true, vertical: false).textSelection(.enabled).padding(.bottom, 4) }
        }.padding(12).neuSurface(inset: true, radius: 14, intensity: 0.35)
            .onChange(of: text) { _, _ in copied = false }
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
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 10) {
                if let selected, let command = commands.first(where: { $0.name == selected }), let argument = command.argument {
                    if let hint = argument.hint { Text(hint).font(.system(size: 12)).foregroundStyle(OrbisPalette(scheme).secondary) }
                    ForEach(argument.options ?? []) { option in
                        Button { input = "/\(command.name) \(option.value)" } label: {
                            VStack(alignment: .leading, spacing: 3) {
                                Text(option.label).font(.system(size: 13, weight: .medium))
                                if let description = option.description { Text(description).font(.system(size: 11)).foregroundStyle(OrbisPalette(scheme).secondary).lineLimit(2) }
                            }.frame(maxWidth: .infinity, minHeight: 48, alignment: .leading).padding(.horizontal, 12)
                        }.buttonStyle(NeuButtonStyle(radius: 12))
                    }
                } else {
                    let query = String(input.trimmingCharacters(in: .whitespacesAndNewlines).dropFirst()).lowercased()
                    let filtered = commands.filter { query.isEmpty || $0.name.lowercased().contains(query) }
                    if filtered.isEmpty { Text(commands.isEmpty ? "当前会话尚未提供可用命令" : "没有匹配的命令").font(.system(size: 12)).foregroundStyle(OrbisPalette(scheme).secondary).padding(12) }
                    ForEach(filtered) { command in
                        Button {
                            if command.name == "tree" { input = ""; selected = nil; onHistory() }
                            else { selected = command.name; input = "/" + command.name + (command.argument == nil ? "" : " ") }
                        } label: {
                            HStack(spacing: 10) {
                                Text("/" + command.name).font(.system(size: 13, weight: .semibold, design: .monospaced))
                                Text(command.description ?? "").font(.system(size: 11)).foregroundStyle(OrbisPalette(scheme).secondary).lineLimit(2)
                                Spacer(minLength: 0)
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
        VStack(spacing: 16) {
            OrbisPageHeader(title: "会话权限", back: { dismiss() }) { EmptyView() }
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    if let permissions = store.selectedRuntime?.permissionManagement {
                        Text(permissions.summary).font(.system(size: 17, weight: .semibold))
                        Text(permissions.details).font(.system(size: 13)).foregroundStyle(OrbisPalette(scheme).secondary)
                        ForEach(permissions.settings) { setting in
                            VStack(alignment: .leading, spacing: 12) {
                                Text(setting.label).font(.system(size: 14, weight: .semibold))
                                ForEach(setting.options) { option in
                                    Button { store.updatePermission(settingId: setting.id, value: option.value) } label: {
                                        HStack {
                                            Text(option.label).font(.system(size: 13)).frame(maxWidth: .infinity, alignment: .leading)
                                            if option.value == setting.currentValue { Image(systemName: "checkmark") }
                                        }.padding(14).frame(minHeight: 48)
                                    }.buttonStyle(NeuButtonStyle(selected: option.value == setting.currentValue))
                                        .disabled(!store.canSend || store.selectedRuntime?.status != "idle" || setting.disabledReason != nil || !store.pendingActionIds.isEmpty)
                                }
                                if let reason = setting.disabledReason { Text(reason).font(.system(size: 12)).foregroundStyle(OrbisPalette(scheme).secondary) }
                            }.padding(16).neuSurface()
                        }
                        if runtime.status != "idle" { OrbisNotice(text: "会话空闲时可调整权限。") }
                    }
                }.padding(24)
            }
        }.background(OrbisPalette(scheme).base.ignoresSafeArea())
            .onChange(of: store.selectedRuntimeId) { _, _ in dismiss() }
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
                            Text(MarkdownCache.inline(column < row.count ? row[column] : ""))
                                .font(.system(size: 13, weight: rowIndex == 0 ? .semibold : .regular))
                                .frame(width: 150, alignment: alignment(column)).padding(10)
                                .background(rowIndex == 0 ? OrbisPalette(scheme).outline.opacity(0.25) : .clear)
                                .overlay(alignment: .bottom) { Rectangle().fill(OrbisPalette(scheme).outline).frame(height: 0.5) }
                        }
                    }
                }
            }.padding(4)
        }.neuSurface(inset: true, radius: 14, intensity: 0.35).textSelection(.enabled)
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
                else if phase.error != nil { Label(alt.isEmpty ? "图片未能加载" : alt, systemImage: "photo").font(.system(size: 13)) }
                else { ProgressView().frame(maxWidth: .infinity, minHeight: 80) }
            }
            Link(alt.isEmpty ? "打开图片" : alt, destination: url).font(.system(size: 12))
        }.padding(12).neuSurface(inset: true, radius: 14, intensity: 0.35)
    }
}


struct QueuedMessagesView: View {
    @EnvironmentObject private var store: OrbisStore
    @Environment(\.colorScheme) private var scheme
    let runtimeId: String
    var body: some View {
        let items = store.queuedMessages[runtimeId] ?? []
        if !items.isEmpty {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 12) {
                    ForEach(items) { item in
                        VStack(alignment: .leading, spacing: 6) {
                            HStack {
                                Text((item.delivery == "steer" ? "Steer" : "Follow-up") + " · " + queueStateTitle(item.state)).font(.system(size: 11, weight: .semibold))
                                if item.state == "accepted" {
                                    OrbisTextButton(title: store.pendingQueueCancellations.contains(item.queueId) ? "撤回中…" : "撤回", symbol: "xmark") { _ = store.cancelQueuedMessage(item.queueId) }
                                        .disabled(!store.canSend || store.pendingQueueCancellations.contains(item.queueId)).accessibilityIdentifier("queue-cancel-" + item.queueId)
                                }
                            }
                            Text(item.text).font(.system(size: 12)).lineLimit(3).textSelection(.enabled)
                            if let error = item.error { Text(error).font(.system(size: 11)).foregroundStyle(OrbisPalette(scheme).error) }
                        }.frame(width: 240, alignment: .leading).padding(12).neuSurface(inset: true, radius: 14, intensity: 0.35)
                    }
                }.padding(.horizontal, 16)
            }.frame(maxHeight: 130).accessibilityIdentifier("queued-messages")
        }
    }
}

struct RuntimeNoticesView: View {
    @EnvironmentObject private var store: OrbisStore
    @EnvironmentObject private var notifications: RuntimeNotifications
    let runtimeId: String
    var body: some View {
        if let projection = notifications.projections[runtimeId], !projection.items.isEmpty || !projection.complete {
            ScrollView {
                VStack(alignment: .leading, spacing: 10) {
                if projection.verification == "unknown" || !projection.complete || store.connection != .secured {
                    HStack {
                        Text("通知状态待核对").font(.system(size: 12))
                        Spacer()
                        OrbisTextButton(title: "重新核对", symbol: "arrow.clockwise") { notifications.sync(runtimeId: runtimeId) }.disabled(store.connection != .secured)
                    }
                }
                ForEach(projection.items) { notice in
                    HStack(alignment: .top, spacing: 8) {
                        OrbisNotice(text: notice.message + (notice.verification == "unknown" ? " · 状态待核对" : ""), error: notice.severity != "info")
                        OrbisIconButton(symbol: "xmark", label: "关闭通知", size: 32) { notifications.dismiss(runtimeId: runtimeId, notificationId: notice.notificationId) }.disabled(store.connection != .secured)
                    }
                }
                }
            }.frame(maxHeight: 160).accessibilityIdentifier("runtime-notifications")
        }
    }
}

private struct RuntimeInfoView: View {
    @EnvironmentObject private var store: OrbisStore
    @EnvironmentObject private var agent: AgentState
    @Environment(\.dismiss) private var dismiss
    let runtime: RuntimeSummary
    private var snapshot: AgentSnapshot? { agent.snapshots[runtime.runtimeId] }
    private func ready(_ name: String) -> Bool { snapshot?.missing[name] == nil && (snapshot?.domains[name]?.availability ?? "ready") == "ready" }
    var body: some View {
        VStack(spacing: 0) {
            OrbisPageHeader(title: "会话信息", back: { dismiss() }) {
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
                        } else { Text("尚未读取会话状态").font(.system(size: 13)) }
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
        return parts.isEmpty ? "来源未报告" : parts.joined(separator: " · ")
    }
    private func activity(_ value: HostJSON) -> String {
        guard value != .null, value.string != "unavailable" else { return "来源尚未提供" }
        let phase = ["idle": "空闲", "running": "进行中", "failed": "失败"][value["phase"].string ?? ""] ?? "待核对"
        return [phase, value["attempt"].number.map { "第 \(Int($0)) 次" }, value["detail"].string].compactMap { $0 }.joined(separator: " · ")
    }
}

private func agentDomainTitle(_ name: String) -> String {
    ["identity": "会话身份", "availability": "可用性", "execution": "执行", "delivery": "消息队列", "interactions": "交互", "permissions": "权限", "model": "模型", "context": "上下文", "capabilities": "可用命令", "resources": "资源", "providerBinding": "供应商归属", "workspaceRef": "工作区", "artifacts": "附件", "records": "诊断记录"][name] ?? name
}
