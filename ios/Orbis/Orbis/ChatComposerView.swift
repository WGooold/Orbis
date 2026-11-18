import SwiftUI
import Observation
import PhotosUI
import CoreTransferable
import UniformTypeIdentifiers

@MainActor @Observable
final class ChatComposerFocus {
    var focused = false
}

/// The composer's own copy of a draft, valid while it targets the same session and the store has not
/// written that draft since. Updating `text` in place during normal prose typing keeps the latest
/// value available to submission and programmatic updates without invalidating `ChatComposerView.body`
/// on every character.
@MainActor
private final class ComposerDraftStorage {
    var key = ""
    var revision = -1
    var programmaticRevision = 0
    var measuredHeight = 0
    var text = ""

    func resolve(identity: String, draftRevision: Int, fallback: @autoclosure () -> String) -> String {
        if key == identity && revision == draftRevision { return text }
        let loaded = fallback()
        key = identity
        revision = draftRevision
        text = loaded
        return loaded
    }

    func updateFromUser(identity: String, draftRevision: Int, text: String, height: Int) {
        key = identity
        revision = draftRevision
        self.text = text
        measuredHeight = height
    }

    func updateProgrammatically(identity: String, draftRevision: Int, text: String) {
        key = identity
        revision = draftRevision
        programmaticRevision &+= 1
        self.text = text
    }
}

private struct ComposerDraftPresentation: Equatable {
    let key: String
    let revision: Int
    let programmaticRevision: Int
    let measuredHeight: Int
    let hasText: Bool
    /// Non-nil only when the trimmed draft starts with "/". Normal prose keystrokes
    /// keep this nil so characters after the first do not re-render the composer subtree.
    let slashText: String?

    init(key: String, revision: Int, programmaticRevision: Int, measuredHeight: Int, text: String) {
        self.key = key
        self.revision = revision
        self.programmaticRevision = programmaticRevision
        self.measuredHeight = measuredHeight
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        self.hasText = !trimmed.isEmpty
        self.slashText = trimmed.hasPrefix("/") ? text : nil
    }
}

/// IOS-CHAT-01: editor state and its local presentation belong to this subtree. A keystroke
/// persists through HostConnection without invalidating ChatView's transcript/navigation state.
private struct ChatFileSelection {
    let actions: ChatSessionActions
    let capacity: Int
}

/// Keep the photo as a file. Full-resolution image decoding never belongs on the composer.
private struct ChatPhotoFile: Transferable {
    let url: URL
    var directory: URL { url.deletingLastPathComponent() }

    static var transferRepresentation: some TransferRepresentation {
        FileRepresentation(importedContentType: .image) { received in
            let source = received.file
            return try await Task.detached {
                let directory = FileManager.default.temporaryDirectory.appendingPathComponent("orbis-photo-" + UUID().uuidString)
                try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
                let destination = directory.appendingPathComponent(source.lastPathComponent)
                do { try FileManager.default.copyItem(at: source, to: destination) }
                catch { try? FileManager.default.removeItem(at: directory); throw error }
                return Self(url: destination)
            }.value
        }
    }
}

/// IOS-CHAT-03: every finite row width reaches the same native editor with a
/// definite remaining width and an unspecified height.
private struct ChatComposerRowLayout: Layout {
    struct Measurement {
        let geometry: ChatComposerRowGeometry
        let editorProposal: ProposedViewSize
    }
    typealias Cache = ChatComposerRowCache<Measurement>

    func makeCache(subviews: Subviews) -> Cache { Cache() }

    func updateCache(_ cache: inout Cache, subviews: Subviews) {
        // Text, marked text, intrinsic metrics and environment changes can all
        // invalidate a LayoutSubview. A draft token cannot stand in for this lifecycle.
        cache.invalidate()
        ChatDebugProbes.composerInvalidated()
    }

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout Cache) -> CGSize {
        ChatDebugProbes.composerRequested(proposal)
        return measurement(width: proposal.width, subviews: subviews, cache: &cache)?.geometry.size ?? .zero
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout Cache) {
        guard let measured = measurement(width: bounds.width, subviews: subviews, cache: &cache) else { return }
        let geometry = measured.geometry
        let origin = CGPoint(x: bounds.minX, y: bounds.maxY - geometry.size.height)
        subviews[0].place(at: CGPoint(x: origin.x + geometry.leading.minX, y: origin.y + geometry.leading.minY),
                          anchor: .topLeading, proposal: ProposedViewSize(geometry.leading.size))
        // Preserve the measuring proposal. Pinning the measured height here would
        // send a second, different proposal through the multiline TextField.
        subviews[1].place(at: CGPoint(x: origin.x + geometry.editor.minX, y: origin.y + geometry.editor.minY),
                          anchor: .topLeading, proposal: measured.editorProposal)
        subviews[2].place(at: CGPoint(x: origin.x + geometry.trailing.minX, y: origin.y + geometry.trailing.minY),
                          anchor: .topLeading, proposal: ProposedViewSize(geometry.trailing.size))
        ChatDebugProbes.composerPlaced(geometry, in: bounds, editorProposal: measured.editorProposal)
    }

    private func measurement(width proposedWidth: CGFloat?, subviews: Subviews, cache: inout Cache) -> Measurement? {
        guard subviews.count == 3 else { return nil }
        let width = ChatComposerRowGeometry.finiteWidth(proposedWidth)
        if let measured = cache.value(for: width) {
            ChatDebugProbes.composerCacheHit()
            return measured
        }
        let leading = subviews[0].sizeThatFits(.unspecified)
        let trailing = subviews[2].sizeThatFits(.unspecified)
        // Unspecified/infinite parent-width probes legitimately ask for the native
        // ideal width. Final placement always uses its finite allocated width.
        let editorProposal = ProposedViewSize(width: ChatComposerRowGeometry.editorWidth(in: width, leading: leading, trailing: trailing), height: nil)
        let editor = subviews[1].sizeThatFits(editorProposal)
        ChatDebugProbes.composerMeasured(editorProposal, size: editor)
        let measured = Measurement(geometry: ChatComposerRowGeometry(proposedWidth: width, leading: leading, editor: editor, trailing: trailing),
                                   editorProposal: editorProposal)
        cache.store(measured, for: width)
        return measured
    }
}

struct ChatComposerView: View, Equatable {
    let model: ChatScreenModel
    let actions: ChatSessionActions
    let fallbackRuntime: RuntimeSummary
    private var target: ChatActionContext { actions.target }
    @Environment(\.colorScheme) private var scheme
    @Environment(\.orbisFoldReading) private var foldReading
    let composerFocus: ChatComposerFocus
    let sendFlight: MessageSendFlight
    let onHistory: () -> Void
    let onAcceptedSend: (Set<String>) -> Void
    @State private var selectedCommand: String?
    @State private var deliveryChoices = false
    @State private var permissionsOpen = false
    @State private var attachmentChoices = false
    @State private var filePickerOpen = false
    @State private var photoPickerOpen = false
    @State private var selectedPhotos: [PhotosPickerItem] = []
    @State private var photoSelection: ChatFileSelection?
    @State private var preparingPhotos = false
    @State private var draftStorage = ComposerDraftStorage()
    @State private var draftPresentation: ComposerDraftPresentation?
    @State private var fileSelection: ChatFileSelection?

    private var facts: ChatComposerState { model.composer }
    private var runtime: ChatComposerRuntimeFacts { facts.runtime ?? ChatComposerRuntimeFacts(fallbackRuntime) }
    private var transfers: FileTransfers { target.owner.transfers }
    private var kind: String? { facts.kind }
    private var claudeComposer: Bool { kind == "claude" }
    private var accent: Color { OrbisPalette(scheme).agent(kind) }
    /// PERF-12 / IOS-CHAT-01: typed text belongs to the editor subtree and persists without
    /// invalidating the transcript owner. A store-originated draft (command result, restored copy,
    /// launch) advances `draftRevision` and replaces it.
    private var currentDraft: String {
        let _ = draftPresentation
        return draftStorage.resolve(identity: facts.identity, draftRevision: facts.draftRevision, fallback: actions.draft)
    }
    private var activePresentation: ComposerDraftPresentation {
        let text = currentDraft
        if let draftPresentation, draftPresentation.key == facts.identity,
           draftPresentation.revision == facts.draftRevision {
            return draftPresentation
        }
        return ComposerDraftPresentation(key: facts.identity, revision: facts.draftRevision,
                                         programmaticRevision: draftStorage.programmaticRevision,
                                         measuredHeight: draftStorage.measuredHeight, text: text)
    }
    private var draft: Binding<String> {
        Binding(get: { currentDraft }, set: { setProgrammaticDraft($0) })
    }
    private var hasText: Bool { !currentDraft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
    private var slash: Bool { currentDraft.trimmingCharacters(in: .whitespacesAndNewlines).hasPrefix("/") }
    private var command: SlashCommand? { facts.commands.first { $0.name == selectedCommand } }
    private var attachments: [FileTransfer] {
        facts.attached
    }
    private var canSubmit: Bool {
        // ADR-0049 §6.2：附件还在上传也可以发送，消息先等上传完成；失败或取消的附件需要先处理。
        guard facts.canSend, !facts.preparing, !preparingPhotos, attachments.allSatisfy({ !["failed", "cancelled"].contains($0.status) }),
              hasText || !attachments.isEmpty else { return false }
        if slash {
            guard let command, currentDraft.hasPrefix("/" + command.name), facts.pendingActions.isEmpty else { return false }
            return command.argument?.required != true || !commandArguments(command).isEmpty
        }
        return true
    }

    static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.model === rhs.model && lhs.actions == rhs.actions &&
            lhs.composerFocus === rhs.composerFocus && lhs.sendFlight === rhs.sendFlight
    }
    var body: some View {
        let _ = ChatSchedulingTrace.regionBody(.composer)
        let _ = ChatDebugProbes.rendered(.composer)
        return Group {
            if facts.cached { cachedComposer } else { editor }
        }
    }

    private var editor: some View {
        let p = OrbisPalette(scheme)
        let presentation = activePresentation
        let focused = composerFocus.focused
        return VStack(spacing: 0) {
            InteractionWorkspaceView(model: model, actions: actions, runtimeId: runtime.runtimeId).equatable()
            if let tasks = runtime.backgroundTasks, tasks.visible {
                BackgroundTasksView(tasks: tasks).id("\(runtime.runtimeId):\(runtime.sessionId ?? "")")
            }
            if let percent = contextUsagePercent(runtime.contextUsage), facts.contextReady {
                GeometryReader { geometry in
                    Rectangle().fill(accent.opacity(0.15))
                        .overlay(alignment: .leading) { Rectangle().fill(percent >= 90 ? p.error : accent).frame(width: geometry.size.width * min(100, max(0, percent)) / 100) }
                }.frame(height: 2).accessibilityLabel(L10n.tr("上下文已使用 {0}%", Int(percent)))
            } else { Color.clear.frame(height: 2) }
            QueuedMessagesView(model: model, actions: actions, runtimeId: runtime.runtimeId).equatable()
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
                            guard actions.isCurrent else { return }
                            ChatDebugProbes.advanceViewport()
                            actions.refreshWorkingBranch()
                        } label: {
                            Label { Text(branchTitle) } icon: { OrbisActionSymbol(systemName: "point.3.connected.trianglepath.dotted") }.lineLimit(1)
                        }.buttonStyle(.plain).layoutPriority(1).accessibilityLabel(L10n.tr("刷新 Git 工作分支，") + branchTitle)
                    }.font(.orbisCaption(mono: true)).foregroundStyle(p.secondary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    if let permissions = runtime.permissionManagement {
                        OrbisMotionButton { composerFocus.focused = false; permissionsOpen = true } label: {
                            HStack(spacing: 5) {
                                OrbisActionSymbol(systemName: "shield.lefthalf.filled")
                                Text(L10n.hostSummary(permissions.summary)).lineLimit(1)
                                OrbisActionSymbol(systemName: "chevron.right").imageScale(.small)
                            }.font(.orbisCaption()).frame(minHeight: 32)
                                .foregroundStyle(permissions.tone == "problem" ? p.error : accent)
                                .contentShape(Rectangle().inset(by: -6))
                        }.buttonStyle(.plain).accessibilityLabel(L10n.tr("会话权限：{0}", L10n.hostSummary(permissions.summary)))
                    }
                }.frame(minHeight: 32).padding(.horizontal, 20).padding(.top, 6)
            }
            if let error = facts.inputError { Label(error, systemImage: "exclamationmark.circle").font(.orbisCaption()).foregroundStyle(p.error).frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 20).accessibilityIdentifier("composer-error") }
            if let selectedCommand, let error = facts.menuErrors[selectedCommand] {
                HStack { Label(error, systemImage: "exclamationmark.circle"); OrbisActionButton(title: L10n.tr("重试")) { actions.loadMenuOptions(selectedCommand) } }.font(.orbisCaption()).foregroundStyle(p.error).padding(.horizontal, 20)
            }
            AttachmentStrip(actions: actions, tasks: facts.attached, preparing: facts.preparing || preparingPhotos)
            if slash { SlashPickerView(commands: facts.commands, selected: $selectedCommand, input: draft, onHistory: onHistory).padding(.top, 10) }
            ChatComposerRowLayout {
                OrbisIconButton(symbol: foldReading && focused ? "keyboard.chevron.compact.down" : "paperclip",
                                label: L10n.tr(foldReading && focused ? "收起键盘" : "发送文件到电脑"), tint: accent) {
                    if foldReading && focused { composerFocus.focused = false; return }
                    guard actions.isCurrent else { return }
                    composerFocus.focused = false; attachmentChoices = true
                }.disabled(!(foldReading && focused) && (!facts.canSend || facts.preparing || preparingPhotos || attachments.count >= 10))
                OrbisDraftEditor(text: draft,
                                 focused: Binding(get: { focused }, set: { if composerFocus.focused != $0 { composerFocus.focused = $0 } }),
                                 placeholder: L10n.tr("发给 {0}，/ 命令", agentTitle(kind)),
                                 ink: UIColor(p.text), placeholderInk: UIColor(p.secondary),
                                 tint: UIColor(accent),
                                 font: .monospacedDigitSystemFont(ofSize: OrbisTextSize.body, weight: .regular),
                                 lineFragmentPadding: 0, submitsOnSoftwareReturn: false,
                                 identifier: "chat-composer",
                                 programmaticRevision: facts.draftRevision &+ presentation.programmaticRevision,
                                 measuredHeight: presentation.measuredHeight,
                                 onEdit: { text, marked, height in handleUserDraftEdit(text, marked: marked, height: height) },
                                 onSubmit: handleReturnSubmit,
                                 onCancel: { composerFocus.focused = false })
                    .padding(.horizontal, 16).padding(.vertical, 16)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(minHeight: 56)
                    .orbisField(focused: focused).orbisAnchor(sendFlight.composer)
                if runtime.status == "running" && !hasText && attachments.isEmpty {
                    OrbisIconButton(symbol: "stop.fill", label: L10n.tr("停止生成"), tint: p.error) {
                        if actions.isCurrent, actions.stopRuntime() { OrbisHaptics.commit() }
                    }.disabled(!facts.canSend)
                } else {
                    OrbisIconButton(symbol: "arrow.up", label: L10n.tr("发送消息"), tint: accent) {
                        handleReturnSubmit()
                    }.disabled(!canSubmit)
                }
            }.padding(.horizontal, 12).padding(.top, 6).padding(.bottom, 12)
        }.padding(.top, 4).background(p.base)
            .confirmationDialog(L10n.tr("添加附件"), isPresented: $attachmentChoices, titleVisibility: .hidden) {
                Button(L10n.tr("照片")) {
                    let capacity = max(0, 10 - attachments.count)
                    guard actions.isCurrent, capacity > 0 else { return }
                    photoSelection = ChatFileSelection(actions: actions, capacity: capacity)
                    selectedPhotos = []; photoPickerOpen = true
                }.accessibilityIdentifier("chat-attach-photos")
                Button(L10n.tr("文件")) {
                    guard actions.isCurrent else { return }
                    fileSelection = ChatFileSelection(actions: actions, capacity: max(0, 10 - attachments.count))
                    filePickerOpen = true
                }.accessibilityIdentifier("chat-attach-files")
                Button(L10n.tr("取消"), role: .cancel) {}
            }
            .photosPicker(isPresented: $photoPickerOpen, selection: $selectedPhotos,
                          maxSelectionCount: max(1, photoSelection?.capacity ?? 10), matching: .images,
                          preferredItemEncoding: .compatible)
            .fileImporter(isPresented: $filePickerOpen, allowedContentTypes: [.item], allowsMultipleSelection: true) { result in
                guard let selection = fileSelection else { return }
                fileSelection = nil
                switch result {
                case .success(let urls): selection.actions.upload(urls, capacity: selection.capacity)
                case .failure(let error): selection.actions.uploadFailed(error.localizedDescription)
                }
            }
            .fileDialogDefaultDirectory(FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first)
            .orbisBottomSheet(isPresented: $permissionsOpen) {
                PermissionsView(target: target, runtime: actions.runtime ?? fallbackRuntime).orbisSheet([.large])
            }
            .task(id: command?.argument?.optionCatalog?.id) {
                guard actions.isCurrent, let command, target.runtimeId != nil else { return }
                actions.loadMenuOptions(command.name)
            }
            .task(id: selectedPhotos) { await importPhotos() }
            .onChange(of: facts.identity) { _, _ in
                selectedPhotos = []; photoSelection = nil; preparingPhotos = false
            }
            .onChange(of: selectedCommand) { old, _ in
                if actions.ownsRuntime, let old, target.runtimeId != nil { actions.cancelMenuOptions(old) }
            }
            .onDisappear { if actions.ownsRuntime, let selectedCommand, target.runtimeId != nil { actions.cancelMenuOptions(selectedCommand) } }
            .onChange(of: runtime.status) { _, status in if status != "running" { deliveryChoices = false } }
    }

    private func importPhotos() async {
        let items = selectedPhotos
        guard !items.isEmpty, let selection = photoSelection else { return }
        preparingPhotos = true
        defer {
            if selectedPhotos == items {
                preparingPhotos = false; selectedPhotos = []; photoSelection = nil
            }
        }
        var photos: [ChatPhotoFile] = []
        var handedToUploader = false
        do {
            for item in items.prefix(selection.capacity) {
                try Task.checkCancellation()
                guard selection.actions.isCurrent else { throw CancellationError() }
                guard let photo = try await item.loadTransferable(type: ChatPhotoFile.self) else {
                    throw NSError(domain: "OrbisPhotoImport", code: 1, userInfo: [NSLocalizedDescriptionKey: L10n.tr("无法读取所选照片")])
                }
                photos.append(photo)
            }
            try Task.checkCancellation()
            handedToUploader = selection.actions.upload(photos.map(\.url), capacity: selection.capacity,
                                                        temporarySourceDirectories: photos.map(\.directory))
        } catch {
            if !Task.isCancelled, !(error is CancellationError) { selection.actions.uploadFailed(error.localizedDescription) }
        }
        if !handedToUploader { await FileTransfers.removeTemporaryUploadDirectories(photos.map(\.directory)) }
    }

    private func handleUserDraftEdit(_ text: String, marked: Bool, height: Int) {
        guard actions.isCurrent else { return }
        draftStorage.updateFromUser(identity: target.identity, draftRevision: facts.draftRevision, text: text, height: height)
        actions.editDraft(text, persist: !marked)
        reconcileDraftSideEffects(text)
        let next = ComposerDraftPresentation(key: target.identity, revision: facts.draftRevision,
                                             programmaticRevision: draftStorage.programmaticRevision,
                                             measuredHeight: height, text: text)
        if draftPresentation != next { draftPresentation = next }
    }

    private func setProgrammaticDraft(_ text: String) {
        guard actions.isCurrent else { return }
        draftStorage.updateProgrammatically(identity: target.identity, draftRevision: facts.draftRevision, text: text)
        actions.editDraft(text, persist: true)
        reconcileDraftSideEffects(text)
        draftPresentation = ComposerDraftPresentation(key: target.identity, revision: facts.draftRevision,
                                                      programmaticRevision: draftStorage.programmaticRevision,
                                                      measuredHeight: draftStorage.measuredHeight, text: text)
    }

    private func reconcileDraftSideEffects(_ next: String) {
        if let selectedCommand, !(next == "/" + selectedCommand || next.hasPrefix("/" + selectedCommand + " ")) {
            self.selectedCommand = nil
        }
        if deliveryChoices && next.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            deliveryChoices = false
        }
    }

    private func handleReturnSubmit() {
        guard canSubmit else { return }
        if runtime.status == "running" && !slash && claudeComposer { submit(delivery: "steer") }
        else if runtime.status == "running" && !slash { deliveryChoices.toggle() }
        else { submit() }
    }

    private var cachedComposer: some View {
        VStack(spacing: 10) {
            OrbisStatusWithInfo(title: L10n.tr("本机缓存"), message: L10n.tr("本机缓存，可离线浏览，发送消息前需在电脑继续此会话"))
            if let session = facts.cachedSession {
                OrbisActionButton(title: L10n.tr("在电脑继续会话"), symbol: "play") {
                    if actions.isCurrent { LiveActivityCoordinator.shared.cancelQueuedOpen(); actions.activate(session) }
                }
                    .disabled(facts.connection != .secured || facts.activatingSessionId != nil)
            }
        }.padding(16)
    }

    private var branchTitle: String {
        guard let branch = facts.workingBranch, branch.cwd == runtime.cwd, branch.sessionId == runtime.sessionId else { return L10n.tr("分支信息待同步") }
        return branch.branch ?? branch.commit.map { L10n.tr("{0}（分离 HEAD）", String($0.prefix(8))) } ?? (branch.loaded ? L10n.tr("未获取到 Git 分支") : L10n.tr("分支信息待同步"))
    }

    private func commandArguments(_ command: SlashCommand) -> String {
        String(currentDraft.dropFirst(command.name.count + 1)).trimmingCharacters(in: .whitespacesAndNewlines)
    }
    private func submit(delivery: String? = nil) {
        guard actions.isCurrent, canSubmit else { return }
        let text = currentDraft
        let existing = Set(actions.pendingSends.items.map(\.messageId))
        let accepted: Bool
        // ADR-0049 §6.1：产生对话的 Slash 与消息一样，气泡立即出现、输入框清空。
        let messageSlash = slash && command.map(actions.producesMessage) == true
        if slash, let command { accepted = actions.executeSlash(command.name, args: commandArguments(command), composerDraft: messageSlash ? nil : text) }
        else { accepted = actions.sendMessage(text.isEmpty ? "请查看附件。" : text, delivery: delivery, attachmentIds: Set(attachments.map(\.id))) }
        if accepted {
            onAcceptedSend(existing)
            OrbisHaptics.commit()
            if !slash || messageSlash {
                // 交给消息的附件离开输入框，仍在上传的继续上传（不取消）。
                actions.releaseUploads(Set(attachments.map(\.id))); setProgrammaticDraft(""); selectedCommand = nil
            }
            deliveryChoices = false
        }
    }
}

private struct SlashPickerView: View {
    @Environment(\.colorScheme) private var scheme
    @Environment(\.orbisAppearance) private var visualStyle
    let commands: [SlashCommand]
    @Binding var selected: String?
    @Binding var input: String
    let onHistory: () -> Void
    @State private var contentHeight: CGFloat = 0
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

struct QueuedMessagesView: View, Equatable {
    let model: ChatScreenModel
    let actions: ChatSessionActions
    private var target: ChatActionContext { actions.target }
    @Environment(\.colorScheme) private var scheme
    @Environment(\.orbisAppearance) private var visualStyle
    let runtimeId: String
    static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.model === rhs.model && lhs.actions == rhs.actions && lhs.runtimeId == rhs.runtimeId
    }
    var body: some View {
        let items = model.workspace.queue
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
                    let unconfirmed = model.workspace.queueCancellations.contains(item.queueId)
                    OrbisTextButton(title: unconfirmed ? L10n.tr("撤回未确认") : L10n.tr("撤回"), symbol: "xmark") { if actions.isCurrent { _ = actions.cancelQueuedMessage(item.queueId) } }
                        .disabled(!model.workspace.canSend || unconfirmed).accessibilityIdentifier("queue-cancel-" + item.queueId)
                }
            }
            Text(item.text).font(.orbisCaption()).lineLimit(3).textSelection(.enabled)
            if let error = item.error { Text(error).font(.orbisCaption()).foregroundStyle(OrbisPalette(scheme).error) }
        }.padding(12).neuSurface(inset: true, radius: 12, intensity: 0.4)
    }
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
                        // S60 / SC108: section names only when both kinds are present; the title already names a single kind.
                        let groups = tasks.groups
                        let labelled = !groups.agents.isEmpty && !groups.commands.isEmpty
                        if labelled { sectionLabel(L10n.tr("子代理")) }
                        ForEach(groups.agents) { row(for: $0) }
                        if labelled { sectionLabel(L10n.tr("后台命令")) }
                        ForEach(groups.commands) { row(for: $0) }
                    }.frame(maxWidth: .infinity, alignment: .leading).padding(.bottom, 8)
                }.frame(maxHeight: 160)
            }
        }.padding(.horizontal, 16).foregroundStyle(OrbisPalette(scheme).secondary)
    }

    private func sectionLabel(_ title: String) -> some View {
        Text(title).font(.orbisCaption(.medium)).padding(.top, 2)
    }

    private func row(for row: BackgroundTaskGroups.Row) -> some View {
        let task = row.task
        return VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .top, spacing: 8) {
                Text(task.displayTitle).font(.orbisLabel()).lineLimit(2)
                Spacer(minLength: 0)
                Text(task.statusTitle).font(.orbisCaption()).fixedSize(horizontal: true, vertical: false)
            }
            if task.showsKind {
                Text(task.kindTitle).font(.orbisCaption()).foregroundStyle(OrbisPalette(scheme).secondary)
            }
            // A command under its agent needs no source line; an agent's parent is still named.
            if !row.nested, let parentId = task.parentId, let parent = tasks.items.first(where: { $0.id == parentId }) {
                Text(L10n.tr("来自：{0}", parent.displayTitle)).font(.orbisCaption()).lineLimit(1)
            }
        }.padding(.leading, row.nested ? 16 : 0)
            .accessibilityElement(children: .combine).accessibilityIdentifier("background-task-\(task.id)")
    }
}
