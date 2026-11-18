import SwiftUI
import UIKit
import UniformTypeIdentifiers
import ImageIO

struct ChatToolPresentation {
    let context: ChatReadContext
    let token: ToolContentReader.PresentationToken
}

struct ChatEntryPresentation {
    let context: ChatReadContext
    let handle: EntryPreviewHandle
}

/// Each presentation has its own overlay owner and immutable cleanup value.
/// Replacing a row's detail retires only that overlay, even if a new one is above it.
private struct ChatToolSheet: View {
    let presentation: ChatToolPresentation
    let title: String
    let onDismiss: () -> Void
    let onReplace: () -> Void
    @State private var open = true
    var body: some View {
        Color.clear.frame(width: 0, height: 0)
            .orbisBottomSheet(isPresented: $open, onDismiss: {
                presentation.context.connection.toolContent.close(expected: presentation.token)
                onDismiss()
            }, retireIndependently: true) {
                ToolDetailView(reader: presentation.context.connection.toolContent,
                    presentation: presentation.token, context: presentation.context, title: title).orbisSheet([.large])
                    .modifier(ChatToolReplacementProbe(token: presentation.token, onReplace: onReplace))
            }
    }
}

private struct ChatEntrySheet: View {
    let presentation: ChatEntryPresentation
    let onDismiss: () -> Void
    @State private var open = true
    var body: some View {
        Color.clear.frame(width: 0, height: 0)
            .orbisBottomSheet(isPresented: $open, onDismiss: {
                presentation.handle.owner.dismissPreview(expected: presentation.handle)
                onDismiss()
            }, retireIndependently: true) {
                FullMessageView(context: presentation.context, initialHandle: presentation.handle).orbisSheet([.large])
            }
    }
}

/// Mount beside the native collection, never inside a reusable cell. The original
/// sheet views keep their immutable token/handle cleanup and replacement guards.
struct ChatTranscriptInteractionHost: View {
    let state: ChatTranscriptInteractionState
    var body: some View {
        ZStack {
            ForEach(state.presentations) { presentation in
                switch presentation.detail {
                case .tool(let value, let title):
                    ChatToolSheet(presentation: value, title: title,
                        onDismiss: { state.dismiss(presentation) },
                        onReplace: { state.replaceTool(presentation) }).id(value.token)
                case .entry(let value):
                    ChatEntrySheet(presentation: value) { state.dismiss(presentation) }
                        .id(value.handle.requestId)
                case .selection(let text):
                    ChatMessageSelectionSheet(text: text) { state.dismiss(presentation) }
                }
            }
        }.frame(width: 0, height: 0)
    }
}

/// Inputs are plain values so an unchanged row is skipped: it does not observe the whole store.
struct ChatMessageRow: View, Equatable {
    @Environment(\.colorScheme) private var scheme
    @Environment(\.orbisAppearance) private var visualStyle
    @Environment(\.chatTranscriptInteractionState) private var interactions
    @State private var localFileChanges = TurnChangeSummaryState()
    // This row also renders in an independent UIHostingConfiguration. New
    // environment dependencies must be forwarded by ChatNativeTranscriptEnvironment.
    let row: ChatRow
    let kind: String?
    var toolResults: [String: ChatMessage] = [:]
    var toolText: [String: PreparedChatToolText] = [:]
    var timings: [SessionTurnTiming] = []
    var changes: TurnFileChanges?
    var readContext: ChatReadContext?
    var changeAnchors: Set<String> = []
    var streamingMessageIds: Set<String> = []
    var replyArrivals: ReplyCardArrivals? = nil
    var rewindOption: RuntimeOption? = nil
    var rewindEnabled = false
    /// ADR-0049：本地待确认发送的状态；权威行为 nil。
    var pending: PendingSend.State? = nil
    var submissionConfirmed = false
    /// ADR-0049 §6.1：本地待发送消息带的附件（上传任务），气泡内显示缩略图 / 文件名与上传进度。
    var uploads: [FileTransfer] = []
    var canResend = false
    var onRewind: (RuntimeOption) -> Void = { _ in }
    var onPending: (PendingSendAction) -> Void = { _ in }
    static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.row.contentRevision == rhs.row.contentRevision && lhs.kind == rhs.kind && lhs.toolResults == rhs.toolResults &&
            lhs.timings == rhs.timings && lhs.changeAnchors == rhs.changeAnchors && lhs.changes === rhs.changes &&
            lhs.readContext == rhs.readContext &&
            lhs.streamingMessageIds == rhs.streamingMessageIds && lhs.rewindOption == rhs.rewindOption &&
            lhs.rewindEnabled == rhs.rewindEnabled && lhs.pending == rhs.pending &&
            lhs.submissionConfirmed == rhs.submissionConfirmed && lhs.uploads == rhs.uploads &&
            lhs.canResend == rhs.canResend
    }
    var body: some View {
        let _ = ChatSchedulingTrace.regionBody(.row)
        let _ = ChatDebugProbes.rendered(.row)
        let rowInteraction = interactions?.row(row.id)
        let fileChanges = rowInteraction?.fileChanges ?? localFileChanges
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
                            MessageContentView(message: message, toolResults: toolResults, streaming: false, readContext: readContext)
                        }
                    } else {
                        let content = assistantCardContent(row.messages)
                        ForEach(content.prose) { message in
                            MessageContentView(message: message, toolResults: toolResults, streaming: streamingMessageIds.contains(message.messageId), readContext: readContext)
                        }
                        if !content.tools.isEmpty { ChatToolGroup(calls: content.tools, results: toolResults, prepared: toolText, readContext: readContext) }
                    }
                    if row.isUser && !uploads.isEmpty { PendingAttachments(tasks: uploads) }
                    if !row.isUser, let changes {
                        TurnChangeCards(changes: changes, context: readContext, state: fileChanges)
                    }
                    ForEach(timings, id: \.turnId) { timing in
                        ChatTurnTimingLabel(timing: timing)
                    }
                }.frame(maxWidth: row.isUser ? nil : .infinity, alignment: .leading)
                    .modifier(ChatMessageSurface(row: row, streaming: !streamingMessageIds.isEmpty, arrivals: replyArrivals))
                    .modifier(ChatUserCopyAccessibility(enabled: row.isUser) { UIPasteboard.general.string = copyText })
                    .messageSendFlightTarget(row.messages.first?.clientMessageId ?? row.id)
                    .modifier(OrbisMessageActions(enabled: row.isUser, id: row.id, text: row.isUser ? copyText : "",
                                                  rewindEnabled: rewindEnabled, rewind: messageRewind))
                if !row.isUser { Spacer(minLength: 8) }
            }
            if row.isUser, let pending, !(pending == .accepted && submissionConfirmed) {
                PendingSendStatus(state: pending, canResend: canResend, rowId: row.id, onAction: onPending)
            }
        }.modifier(ChatAssistantAccessibility(enabled: !row.isUser, id: row.id) { UIPasteboard.general.string = copyText })
            .modifier(TurnChangeSummaryLoader(changes: changes, anchors: changeAnchors, state: fileChanges))
            .environment(\.chatTranscriptRowInteraction, rowInteraction)
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

/// Keep the lazy row's AX boundary outside the reply surface's timeline and clip.
/// Its native text children and copy action retain their own labels and frames.
private struct ChatAssistantAccessibility: ViewModifier {
    let enabled: Bool
    let id: String
    let copy: () -> Void
    func body(content: Content) -> some View {
        if enabled {
            content.accessibilityElement(children: .contain)
                .accessibilityIdentifier("assistant-message-" + id)
                .accessibilityAction(named: L10n.tr("复制"), copy)
        } else { content }
    }
}

private struct ChatUserCopyAccessibility: ViewModifier {
    let enabled: Bool
    let copy: () -> Void
    func body(content: Content) -> some View {
        if enabled { content.accessibilityAction(named: L10n.tr("复制"), copy) }
        else { content }
    }
}

enum PendingSendAction { case resend, restore, discard, check, cancel }

/// ADR-0049 §6.1：等待上传的消息在气泡内显示附件。图片显示缩略图，其他文件显示图标；文件名按 S09 保留扩展名，
/// 下方是与输入框附件条相同的上传状态与进度。只读：重试 / 放回 / 删除在气泡下方的操作区。
private struct PendingAttachments: View {
    @Environment(\.colorScheme) private var scheme
    @Environment(\.orbisAppearance) private var visualStyle
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
    @Environment(\.orbisAppearance) private var visualStyle
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
    @Environment(\.orbisAppearance) private var visualStyle
    let state: PendingSend.State
    let canResend: Bool
    let rowId: String
    let onAction: (PendingSendAction) -> Void
    var body: some View {
        let palette = OrbisPalette(scheme)
        HStack(spacing: 2) {
            switch state {
            case .sending:
                ProgressView().controlSize(.mini).dynamicTypeSize(...DynamicTypeSize.large).frame(width: 28, height: 28)
                Text(L10n.tr("发送中")).font(.orbisCaption()).foregroundStyle(palette.secondary)
            case .accepted:
                OrbisActionSymbol(systemName: "clock").font(.orbisCaption()).foregroundStyle(palette.secondary).frame(width: 28, height: 28)
                Text(L10n.tr("电脑已接收，等待处理")).font(.orbisCaption()).foregroundStyle(palette.secondary)
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
    @Environment(\.chatTranscriptRowInteraction) private var rowInteraction
    let calls: [ChatCardTool]
    let results: [String: ChatMessage]
    let prepared: [String: PreparedChatToolText]
    let readContext: ChatReadContext?
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
        let visible = rowInteraction?.visibleTools ?? self.visible
        if calls.count == 1 {
            MessageContentView(message: calls[0].displayMessage, toolResults: results, preparedTool: prepared[calls[0].id], readContext: readContext)
        } else {
            CompactDisclosure(title: L10n.tr("{0} 次工具调用", calls.count), detail: phase, symbol: "wrench.and.screwdriver", persistenceKey: "tool-group") {
                VStack(alignment: .leading, spacing: 8) {
                    ForEach(Array(calls.prefix(visible))) { call in
                        MessageContentView(message: call.displayMessage, toolResults: results, preparedTool: prepared[call.id], readContext: readContext)
                    }
                    if visible < calls.count {
                        OrbisActionButton(title: L10n.tr("显示更多工具（剩余 {0} 项）", calls.count - visible)) {
                            if let rowInteraction { rowInteraction.visibleTools += chatToolPageSize }
                            else { self.visible += chatToolPageSize }
                        }
                    }
                }
            }.accessibilityIdentifier("chat-tool-group")
        }
    }
}

private struct MessageContentView: View {
    @Environment(\.orbisFileActions) private var fileActions
    @Environment(\.downloadFlight) private var downloadFlight
    @Environment(\.colorScheme) private var scheme
    @Environment(\.orbisAppearance) private var visualStyle
    let message: ChatMessage
    var toolResults: [String: ChatMessage] = [:]
    var streaming = false
    var preparedTool: PreparedChatToolText?
    var readContext: ChatReadContext?
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            if let summary = message.toolSummary {
                ToolSummaryView(summary: summary, readContext: readContext, persistenceKey: "summary:" + message.messageId)
            }
            ForEach(Array(message.content.enumerated()), id: \.offset) { index, content in
                let key = content.toolCallId.map { "call:" + $0 } ?? "\(message.messageId):block:\(index):\(content.type)"
                switch content.type {
                case "thinking":
                    CompactDisclosure(title: L10n.tr("思考过程"), symbol: "sparkles", persistenceKey: key) {
                        Text(content.text ?? L10n.tr("思考中…")).font(.orbisLabel()).textSelection(.enabled)
                    }
                case "tool_call", "toolCall":
                    let result = content.toolCallId.flatMap { toolResults[$0] }
                    if let summary = result?.toolSummary ?? content.summary {
                        ToolSummaryView(summary: summary, readContext: readContext, persistenceKey: key)
                    }
                    else {
                        let live = content.toolCallId == nil && content.arguments == nil && content.text?.isEmpty == false
                        let status = result?.isError == true ? L10n.tr("执行失败") : live ? L10n.tr("参数接收中") : L10n.tr("已完成")
                        CompactDisclosure(title: content.toolName ?? result?.toolName ?? message.toolName ?? L10n.tr("工具"), detail: status, symbol: "wrench.and.screwdriver", persistenceKey: key) {
                            VStack(alignment: .leading, spacing: 10) {
                                if let arguments = preparedTool.map(\.arguments) ?? toolArgumentsText(content), !arguments.isEmpty {
                                    Text(arguments).font(.orbisCaption(mono: true)).textSelection(.enabled)
                                }
                                if let result {
                                    Text(preparedTool?.result ?? fullMessageText(result)).font(.orbisCaption(mono: true)).textSelection(.enabled)
                                }
                            }
                        }
                    }
                case "artifact":
                    if let file = content.artifact {
                        OrbisMotionButton { if fileActions?.download(artifact: file) == true { downloadFlight?.launch() } } label: {
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
            if message.content.contains(where: { $0.truncated == true }) { TruncatedMessageContent(message: message, readContext: readContext) }
            if message.content.isEmpty && message.toolSummary == nil { Text("…").foregroundStyle(OrbisPalette(scheme).secondary) }
        }.foregroundStyle(message.isError == true ? OrbisPalette(scheme).error : OrbisPalette(scheme).text)
    }
}

private struct TruncatedMessageContent: View {
    @Environment(\.colorScheme) private var scheme
    @Environment(\.chatTranscriptInteractionState) private var interactions
    @Environment(\.chatTranscriptRowInteraction) private var rowInteraction
    let message: ChatMessage
    let readContext: ChatReadContext?
    @State private var presentation: ChatEntryPresentation?
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            if let truncated = message.content.first(where: { $0.truncated == true }) {
                OrbisStatusWithInfo(title: L10n.tr("内容已截断"), message:
                    (truncated.originalBytes.map { L10n.tr("有内容因超长被截断（原始 {0} 字节）", $0.formatted()) } ?? L10n.tr("有内容因超长被截断。"))
                    + (readContext?.canRead == true ? "" : "\n" + L10n.tr("连接电脑并继续此会话后可取回完整内容。")))
                OrbisTextButton(title: L10n.tr("查看完整内容"), symbol: "doc.text.magnifyingglass") {
                    guard let readContext, let handle = readContext.openEntry(message.messageId) else { return }
                    let value = ChatEntryPresentation(context: readContext, handle: handle)
                    if let interactions, let rowInteraction {
                        interactions.presentEntry(value, source: .init(rowID: rowInteraction.rowID,
                            contentID: "entry:" + message.messageId))
                    } else { presentation = value }
                }.disabled(readContext?.canRead != true).accessibilityIdentifier("full-entry-" + message.messageId)
            }
        }.background {
            if let presentation {
                ChatEntrySheet(presentation: presentation) {
                    if self.presentation?.handle == presentation.handle { self.presentation = nil }
                }.id(presentation.handle.requestId)
            }
        }
    }
}

private struct FullMessageView: View {
    let context: ChatReadContext
    @ObservedObject private var connection: HostConnection
    @OrbisDismiss private var dismiss
    @OrbisRetire private var retire
    @Environment(\.colorScheme) private var scheme
    @Environment(\.orbisAppearance) private var visualStyle
    @State private var handle: EntryPreviewHandle
    init(context: ChatReadContext, initialHandle: EntryPreviewHandle) {
        self.context = context; _connection = ObservedObject(wrappedValue: initialHandle.owner)
        _handle = State(initialValue: initialHandle)
    }
    private var preview: EntryPreview? { connection.ownsEntryPreview(handle) ? connection.entryPreview : nil }
    var body: some View {
        VStack(spacing: 16) {
            OrbisPageHeader(title: L10n.tr("完整内容"), closes: true, back: {
                if connection.ownsEntryPreview(handle) { dismiss() } else { retire() }
            }) {
                OrbisCopyButton(label: L10n.tr("复制完整内容"), size: 40) {
                    guard let message = preview?.message else { return "" }
                    return fullMessageText(message)
                }.disabled(preview?.message == nil).accessibilityIdentifier("copy-full-entry-" + handle.entryId)
            }
            if preview?.loading == true { ProgressView(L10n.tr("正在取回…")) }
            if let message = preview?.message {
                ScrollView([.horizontal, .vertical]) {
                    Text(fullMessageText(message)).font(.orbisLabel(mono: true)).textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading).padding(20)
                }
            } else if preview?.loading != true {
                OrbisNotice(text: preview?.error ?? L10n.tr("当前没有可显示的完整内容。"), error: true).padding(.horizontal, 20)
                OrbisActionButton(title: L10n.tr("重试"), symbol: "arrow.clockwise") {
                    if let next = context.retryEntry(handle) { handle = next }
                }.disabled(!context.isCurrent || !connection.canSend).padding(.horizontal, 20)
                    .accessibilityIdentifier("full-entry-retry")
            }
            Spacer(minLength: 0)
        }.foregroundStyle(OrbisPalette(scheme).text).background(OrbisPalette(scheme).base.ignoresSafeArea())
            .onDisappear { connection.dismissPreview(expected: handle) }
            .onChange(of: connection.entryPreview?.requestId) { _, _ in
                if !connection.ownsEntryPreview(handle) { retire() }
            }
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
    @Environment(\.orbisAppearance) private var visualStyle
    @Environment(\.orbisReduceMotion) private var reduced
    @Environment(\.chatReadingInteraction) private var readingInteraction
    @Environment(\.chatTranscriptRowInteraction) private var rowInteraction
    let title: String
    var detail: String? = nil
    let symbol: String
    var persistenceKey: String? = nil
    @ViewBuilder let content: () -> Content
    @State private var expanded = false
    var body: some View {
        let p = OrbisPalette(scheme)
        let persisted = persistenceKey.flatMap { rowInteraction?.disclosure($0) }
        let expanded = persisted?.expanded ?? self.expanded
        VStack(alignment: .leading, spacing: 0) {
            OrbisMotionButton {
                readingInteraction()
                if let persisted { persisted.expanded.toggle() }
                else { self.expanded.toggle() }
            } label: {
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
    @Environment(\.colorScheme) private var scheme
    @Environment(\.orbisAppearance) private var visualStyle
    @Environment(\.chatTranscriptInteractionState) private var interactions
    @Environment(\.chatTranscriptRowInteraction) private var rowInteraction
    @State private var presentation: ChatToolPresentation?
    let summary: ToolSummary
    let readContext: ChatReadContext?
    var persistenceKey: String? = nil
    var body: some View {
        let key = persistenceKey ?? summary.tool.map { "call:" + $0.toolCallId } ?? "summary:" + summary.toolName
        CompactDisclosure(title: summary.toolName, detail: phase, symbol: summary.isError == true ? "exclamationmark.circle" : "wrench.and.screwdriver", persistenceKey: "tool-summary:" + key) {
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
                if let tool = summary.tool, let readContext {
                    ForEach(summary.contents, id: \.part) { part in
                        if part.availability != "absent" {
                            OrbisActionButton(title: L10n.tr("查看") + toolPartTitle(part.part), symbol: "doc.text.magnifyingglass") {
                                guard let token = readContext.openTool(ToolLocator(tool: tool, part: part.part)) else { return }
                                let value = ChatToolPresentation(context: readContext, token: token)
                                if let interactions, let rowInteraction {
                                    interactions.presentTool(value, title: summary.toolName,
                                        source: .init(rowID: rowInteraction.rowID, contentID: "tool:" + key))
                                } else { presentation = value }
                            }.disabled(!readContext.canRead || part.readCapability == "none" || !["readable", "pending"].contains(part.availability))
                            if ["temporarily-unavailable", "unrecoverable"].contains(part.availability) {
                                Text(part.availability == "unrecoverable" ? L10n.tr("此部分内容已无法恢复") : L10n.tr("来源暂时无法提供此部分内容")).font(.orbisCaption()).foregroundStyle(.secondary)
                            }
                        }
                    }
                }
            }
        }.background {
            if let presentation {
                ChatToolSheet(presentation: presentation, title: summary.toolName, onDismiss: {
                    if self.presentation?.token == presentation.token { self.presentation = nil }
                }, onReplace: {
                    let reader = presentation.context.connection.toolContent
                    guard reader.isCurrent(presentation.token), let locator = reader.locator,
                          let next = presentation.context.openTool(locator) else { return }
                    self.presentation = ChatToolPresentation(context: presentation.context, token: next)
                }).id(presentation.token)
            }
        }
    }
    private var phase: String {
        switch summary.phase { case "started", "running": return L10n.tr("执行中"); case "cancelled": return L10n.tr("已取消"); default: return summary.isError == true ? L10n.tr("执行失败") : L10n.tr("已完成") }
    }
}

private struct ChatTurnTimingLabel: View {
    let timing: SessionTurnTiming
    @Environment(\.chatVisualActivity) private var activity
    @Environment(\.colorScheme) private var scheme
    var body: some View {
        let active = timing.durationMs == nil ? (activity?.active ?? true) : true
        TimelineView(.animation(minimumInterval: 1, paused: !active || timing.durationMs != nil)) { context in
            let elapsed = timing.durationMs.map(Double.init) ?? max(0, context.date.timeIntervalSince1970 * 1000 - Double(timing.startedAt))
            Text(String(format: timing.durationMs == nil ? L10n.tr("本轮已运行 %.1f 秒") : L10n.tr("本轮耗时 %.1f 秒"), elapsed / 1000))
                .font(.orbisCaption(mono: true)).foregroundStyle(OrbisPalette(scheme).secondary)
        }
    }
}
