import SwiftUI

@MainActor final class ExternalImportInboxModel: ObservableObject {
    @Published private(set) var batches: [ExternalImportBatch] = []
    @Published private(set) var selected: UUID?
    @Published private(set) var problem: ExternalImportProblem?
    @Published private(set) var busy = false
    @Published private(set) var delivering: UUID?
    @Published var isOpen = false
    private var readGeneration = 0

    func refresh() {
        guard !busy else { return }
        readGeneration += 1
        let generation = readGeneration
        Task {
            let result = await Task.detached(priority: .utility) { Result { try ExternalImportStore.applicationInbox().list() } }.value
            guard generation == readGeneration else { return }
            if case .success(let entries) = result { batches = entries }
            else if isOpen { problem = .unreadable }
        }
    }

    func show() {
        selected = batches.count == 1 ? batches.first?.id : nil; problem = nil; isOpen = true
        refresh()
    }

    func select(_ id: UUID?) { selected = id; problem = nil }

    func assign(_ id: UUID, to destination: ExternalImportDestination, ifCurrent: () -> Bool) {
        guard !busy else { return }
        guard ifCurrent() else { problem = .targetUnavailable; return }
        problem = nil
        perform { try ExternalImportStore.applicationInbox().assign(id, to: destination).id }
    }

    func unassign(_ id: UUID, from target: ExternalImportTarget) {
        guard !busy, delivering != id else { return }
        problem = nil
        perform { try ExternalImportStore.applicationInbox().unassign(id, from: target).id }
    }

    func openDocument(_ url: URL) {
        guard !busy else { isOpen = true; problem = .busy; return }
        selected = nil; problem = nil; isOpen = true
        perform {
            let store = try ExternalImportStore.applicationInbox()
            return try store.importDocument(url).id
        }
    }

    func delete(_ id: UUID) {
        guard !busy, delivering != id else { return }
        problem = nil
        perform { try ExternalImportStore.applicationInbox().delete(id); return nil }
    }

    func deliver(_ batch: ExternalImportBatch, via connection: HostConnection?, instruction: String? = nil) {
        runDelivery(batch, via: connection) { connection, inbox in
            if let instruction { try await connection.sendExternalImport(batch, from: inbox, instruction: instruction) }
            else if batch.destination == nil { try await connection.recoverExternalLaunch(batch, in: inbox) }
            else { try await connection.checkExternalImport(batch, in: inbox) }
        }
    }

    func launch(_ batch: ExternalImportBatch, via connection: HostConnection, agent: String, cwd: String, instruction: String) {
        runDelivery(batch, via: connection) { connection, inbox in
            try await connection.launchExternalImport(batch, from: inbox, agent: agent, cwd: cwd, instruction: instruction)
        }
    }

    func clearFailedLaunch(_ batch: ExternalImportBatch, launch: ExternalImportLaunch) {
        guard !busy, delivering != batch.id else { return }
        perform { try ExternalImportStore.applicationInbox().clearFailedLaunch(batch.id, launchId: launch.id); return batch.id }
    }

    private func runDelivery(_ batch: ExternalImportBatch, via connection: HostConnection?,
                             action: @escaping @MainActor (HostConnection, ExternalImportStore) async throws -> Void) {
        guard !busy, delivering == nil else { return }
        guard let connection else { problem = .targetUnavailable; return }
        delivering = batch.id; problem = nil
        Task {
            do {
                let inbox = try await Task.detached { try ExternalImportStore.applicationInbox() }.value
                try await action(connection, inbox)
            } catch {
                if selected == batch.id { problem = (error as? ExternalImportProblem) ?? .unreadable }
            }
            delivering = nil
            refresh()
        }
    }

    private func perform(_ action: @escaping @Sendable () throws -> UUID?) {
        busy = true
        readGeneration += 1
        Task {
            let (result, snapshot) = await Task.detached(priority: .userInitiated) {
                let result = Result { try action() }
                let snapshot = try? ExternalImportStore.applicationInbox().list()
                return (result, snapshot)
            }.value
            if let snapshot { batches = snapshot }
            busy = false
            switch result {
            case .success(let id): selected = id
            case .failure(let error): problem = (error as? ExternalImportProblem) ?? .unreadable
            }
        }
    }
}

private struct ImportInboxModelKey: EnvironmentKey {
    static let defaultValue: ExternalImportInboxModel? = nil
}

extension EnvironmentValues {
    var orbisImportInbox: ExternalImportInboxModel? {
        get { self[ImportInboxModelKey.self] }
        set { self[ImportInboxModelKey.self] = newValue }
    }
}

struct ExternalImportInboxButton: View {
    var native = false
    @Environment(\.orbisImportInbox) private var model
    var body: some View {
        if let model { ExternalImportInboxControl(model: model, native: native) }
    }
}

private struct ExternalImportInboxControl: View {
    @ObservedObject var model: ExternalImportInboxModel
    @Environment(\.colorScheme) private var scheme
    var native = false
    var body: some View {
        if !model.batches.isEmpty {
            let label = L10n.tr("待导入 · {0}", model.batches.count)
            if native {
                Button(action: model.show) { Label(label, systemImage: "tray") }
                    .accessibilityIdentifier("external-import-inbox")
            } else {
                ZStack(alignment: .topTrailing) {
                    OrbisIconButton(symbol: "tray", label: label, action: model.show)
                        .accessibilityIdentifier("external-import-inbox")
                    Text("\(min(99, model.batches.count))")
                        .font(.system(size: 10, weight: .bold))
                        .foregroundStyle(.white)
                        .padding(.horizontal, 4)
                        .frame(minWidth: 16, minHeight: 16)
                        .background(OrbisPalette(scheme).accent, in: Capsule())
                        .offset(x: -4, y: 4)
                        .allowsHitTesting(false)
                }
            }
        }
    }
}

struct ExternalImportInboxView: View {
    private enum Route: Hashable { case preview, sessions, computers, setup }

    @ObservedObject var model: ExternalImportInboxModel
    @OrbisDismiss private var dismiss
    @Environment(\.colorScheme) private var scheme
    @EnvironmentObject private var overlay: OrbisOverlay
    @ObservedObject var store: OrbisStore
    @State private var route: Route = .preview
    @State private var setupBack: Route = .sessions
    @State private var launchHost: String?
    @State private var instruction = ""
    @State private var payloadExpanded = false
    @FocusState private var instructionFocused: Bool

    private var batch: ExternalImportBatch? { model.batches.first { $0.id == model.selected } }
    private var screen: Route { batch?.destination != nil || batch?.launch != nil ? .preview : route }
    private var actionable: Bool { !model.busy && model.delivering == nil }
    private var processing: Bool { model.busy || (batch != nil && model.delivering == batch?.id) }
    private var palette: OrbisPalette { OrbisPalette(scheme) }

    private func editable(_ batch: ExternalImportBatch) -> Bool {
        batch.destination != nil && (batch.attempt == nil || batch.attempt?.receipt == .failed)
    }

    private var title: String {
        guard let batch else { return L10n.tr("待导入") }
        switch screen {
        case .sessions: return L10n.tr("选择发送目标")
        case .computers: return L10n.tr("选择电脑")
        case .setup: return L10n.tr("新建会话")
        case .preview:
            if batch.attempt?.receipt == .accepted { return L10n.tr("会话已接收") }
            return editable(batch) ? L10n.tr("发送到会话") : L10n.tr("分享内容")
        }
    }

    private func back() {
        instructionFocused = false
        switch screen {
        case .setup: launchHost = nil; route = setupBack
        case .computers: route = .sessions
        case .sessions: route = .preview
        case .preview: model.select(nil)
        }
    }

    var body: some View {
        VStack(spacing: 0) {
            OrbisHeader {
                if batch != nil { OrbisIconButton(symbol: "arrow.left", label: L10n.tr("返回"), compact: true, action: back).disabled(model.busy) }
            } title: {
                OrbisMotionText(title).font(.orbisTitle()).accessibilityAddTraits(.isHeader)
            } trailing: {
                if let batch, screen == .preview {
                    OrbisIconButton(symbol: "trash", label: L10n.tr("删除"), compact: true) { confirmDelete(batch) }
                        .disabled(processing)
                }
                OrbisIconButton(symbol: "xmark", label: L10n.tr("关闭"), compact: true) { dismiss() }
            }
            if processing { ProgressView().frame(maxWidth: .infinity).padding(.vertical, 4).accessibilityLabel(L10n.tr("正在处理导入…")) }

            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    if let problem = model.problem { OrbisNotice(text: importProblemText(problem), error: true) }
                    if let batch {
                        switch screen {
                        case .preview: preview(batch)
                        case .sessions: sessions(batch)
                        case .computers: computers
                        case .setup: setup(batch)
                        }
                    } else { inbox }
                }
                .frame(maxWidth: 580)
                .padding(20)
                .frame(maxWidth: .infinity, alignment: .top)
            }
            .id(ScrollIdentity(batch: batch?.id, screen: screen, target: batch?.destination?.target, launch: batch?.launch?.id))
            .scrollDismissesKeyboard(.interactively)

            if let batch { footer(batch) }
        }
        .onChange(of: model.selected, initial: true) { _, _ in
            instructionFocused = false
            route = .preview
            launchHost = nil
            instruction = batch?.attempt?.instruction ?? batch?.launch?.instruction ?? ""
        }
        .onChange(of: batch?.destination?.target) { _, _ in payloadExpanded = false }
        .onChange(of: model.selected) { _, _ in payloadExpanded = false }
        .accessibilityIdentifier("external-import-sheet")
    }

    private struct ScrollIdentity: Hashable {
        let batch: UUID?
        let screen: Route
        let target: ExternalImportTarget?
        let launch: String?
    }

    @ViewBuilder private var inbox: some View {
        let pending = model.batches.filter { $0.destination == nil && $0.launch == nil }
        let activity = model.batches.filter { $0.destination != nil || $0.launch != nil }
        if pending.isEmpty && activity.isEmpty && !processing && model.problem == nil {
            OrbisEmptyState(symbol: "tray", title: L10n.tr("暂无待导入内容"))
        }
        if !pending.isEmpty { group { batchRows(pending) } }
        if !activity.isEmpty {
            heading(L10n.tr("导入记录"))
            group { batchRows(activity) }
        }
    }

    @ViewBuilder private func batchRows(_ batches: [ExternalImportBatch]) -> some View {
        ForEach(batches) { batch in
            if batch.id != batches.first?.id { Divider() }
            let title = batch.files.first?.name ?? String((batch.text ?? "").prefix(120))
            let receipt = batch.attempt?.receipt
            let subtitle: String = {
                if let target = batch.destination {
                    let status: String
                    switch receipt {
                    case .accepted: status = L10n.tr("已接收")
                    case .failed: status = L10n.tr("失败")
                    case nil: status = L10n.tr("待发送")
                    default: status = L10n.tr("待核对")
                    }
                    return L10n.tr("{0} · {1}", status, target.sessionName)
                }
                if let launch = batch.launch { return L10n.tr("{0} · {1}", launch.failed ? L10n.tr("失败") : L10n.tr("待核对"), launch.hostName) }
                if batch.files.isEmpty { return L10n.tr("分享文字") }
                return L10n.tr("{0} 个文件 · {1}", batch.files.count, byteCount(batch.files.reduce(0) { $0 + $1.bytes }))
            }()
            rowButton(batch.files.isEmpty ? "text.alignleft" : "doc", title, subtitle) { model.select(batch.id) }
                .disabled(model.busy)
        }
    }

    @ViewBuilder private func sessions(_ batch: ExternalImportBatch) -> some View {
        let targets = Dictionary(uniqueKeysWithValues: store.hosts.map { ($0.id, $0.connection.externalImportDestinations()) })
        if targets.values.allSatisfy(\.isEmpty) {
            OrbisEmptyState(symbol: "bubble.left.and.bubble.right", title: L10n.tr("暂无可加入的会话"))
        }
        ForEach(store.hosts) { host in
            if let targets = targets[host.id], !targets.isEmpty {
                VStack(alignment: .leading, spacing: 6) {
                    heading(host.name)
                    group {
                        ForEach(targets) { destination in
                            if destination.id != targets.first?.id { Divider() }
                            rowButton("bubble.left", destination.sessionName, destination.target.cwd) {
                                model.assign(batch.id, to: destination) {
                                    store.connection(for: destination.target.hostId)?.externalImportRuntime(destination.target) != nil
                                }
                            }.disabled(!actionable)
                        }
                    }
                }
            }
        }
    }

    @ViewBuilder private var computers: some View {
        let hosts = store.hosts.filter { $0.connection.canLaunchExternalImport }
        if hosts.isEmpty { OrbisEmptyState(symbol: "desktopcomputer", title: L10n.tr("暂无可用电脑")) }
        else {
            group {
                ForEach(hosts) { host in
                    if host.id != hosts.first?.id { Divider() }
                    rowButton("desktopcomputer", host.name) {
                        launchHost = host.id; setupBack = .computers; route = .setup
                    }.disabled(!actionable)
                }
            }
        }
    }

    @ViewBuilder private func setup(_ batch: ExternalImportBatch) -> some View {
        if let launchHost, let host = store.hosts.first(where: { $0.id == launchHost }),
           let owner = store.connection(for: launchHost) {
            heading(host.name)
            SessionDraftView(owner: owner, presetCwd: nil, closeRequest: 0, onSubmitted: { _, _ in },
                             onCancel: { _ in back() }, onImportSubmit: { agent, cwd, note in
                self.launchHost = nil; route = .preview
                model.launch(batch, via: owner, agent: agent, cwd: cwd, instruction: note)
            }).id(launchHost)
        } else { OrbisEmptyState(symbol: "desktopcomputer", title: L10n.tr("暂无可用电脑")) }
    }

    @ViewBuilder private func preview(_ batch: ExternalImportBatch) -> some View {
        if let destination = batch.destination {
            group {
                let context = L10n.tr("{0} · {1}", destination.hostName, destination.target.cwd)
                if editable(batch) && batch.launch == nil {
                    rowButton("bubble.left", destination.sessionName, context, actionLabel: L10n.tr("更换会话")) {
                        instructionFocused = false
                        route = .sessions
                        model.unassign(batch.id, from: destination.target)
                    }.disabled(!actionable)
                } else { row("bubble.left", destination.sessionName, context) }
            }
            switch batch.attempt?.receipt {
            case .failed: OrbisNotice(text: L10n.tr("发送失败"), error: true)
            case .pending, .unknown, .unconfirmed: status(L10n.tr("发送结果待核对"))
            default: EmptyView()
            }
        } else if let launch = batch.launch {
            group { row("desktopcomputer", launch.hostName, launch.cwd) }
            if launch.failed { OrbisNotice(text: L10n.tr("启动失败"), error: true) }
            else { status(L10n.tr("启动结果待核对")) }
        }
        payload(batch, compact: batch.destination != nil || batch.launch != nil)
        if editable(batch) {
            TextField(L10n.tr("补充要求（可选）"), text: $instruction, axis: .vertical)
                .font(.orbisBody()).focused($instructionFocused).orbisInput(focused: instructionFocused)
                .lineLimit(2...5).disabled(processing)
        }
    }

    @ViewBuilder private func footer(_ batch: ExternalImportBatch) -> some View {
        if screen == .sessions {
            action(L10n.tr("新建会话"), "plus", id: "external-import-new-session") {
                let hosts = store.hosts.filter { $0.connection.canLaunchExternalImport }
                if hosts.count == 1 { launchHost = hosts[0].id; setupBack = .sessions; route = .setup }
                else { route = .computers }
            }
        } else if screen == .preview {
            if let destination = batch.destination {
                if editable(batch) {
                    action(L10n.tr("发送"), "arrow.up", id: "external-import-send") {
                        model.deliver(batch, via: store.connection(for: destination.target.hostId), instruction: instruction)
                    }
                } else if batch.attempt?.receipt != .accepted {
                    action(L10n.tr("核对结果"), "arrow.clockwise") { model.deliver(batch, via: store.connection(for: destination.target.hostId)) }
                }
            } else if let launch = batch.launch {
                if launch.failed {
                    action(L10n.tr("移回待导入"), "tray") { model.clearFailedLaunch(batch, launch: launch) }
                } else {
                    action(L10n.tr("核对结果"), "arrow.clockwise") { model.deliver(batch, via: store.connection(for: launch.hostId)) }
                }
            } else {
                action(L10n.tr("选择发送目标"), "arrow.right", id: "external-import-choose-target") { route = .sessions }
            }
        }
    }

    private func action(_ title: String, _ symbol: String, id: String = "external-import-action", run: @escaping () -> Void) -> some View {
        VStack(spacing: 0) {
            Divider()
            OrbisActionButton(title: title, symbol: symbol) { instructionFocused = false; run() }
                .disabled(!actionable).accessibilityIdentifier(id)
                .frame(maxWidth: 580).padding(.horizontal, 20).padding(.vertical, 10)
        }
    }

    @ViewBuilder private func payload(_ batch: ExternalImportBatch, compact: Bool) -> some View {
        let collapsible = compact || batch.files.count > 3 || (batch.text?.prefix(261).count ?? 0) > 260
        if !compact || payloadExpanded { payloadBody(batch, abbreviated: collapsible && !payloadExpanded) }
        if collapsible {
            group {
                rowButton(payloadExpanded ? "chevron.up" : "paperclip", payloadExpanded ? L10n.tr("收起") : L10n.tr("查看分享内容"),
                          showsChevron: false) { payloadExpanded.toggle() }
            }
        }
    }

    @ViewBuilder private func payloadBody(_ batch: ExternalImportBatch, abbreviated: Bool) -> some View {
        if !batch.files.isEmpty {
            heading(L10n.tr("{0} 个文件", batch.files.count))
            group {
                ForEach(Array((abbreviated ? Array(batch.files.prefix(3)) : batch.files).enumerated()), id: \.offset) { index, file in
                    if index > 0 { Divider() }
                    HStack(spacing: 10) {
                        Image(systemName: "doc").foregroundStyle(palette.accent).accessibilityHidden(true)
                        FileNameText(name: file.name).frame(maxWidth: .infinity, alignment: .leading)
                        Text(byteCount(file.bytes)).foregroundStyle(palette.secondary)
                    }.font(.orbisCaption()).padding(14)
                }
            }
        }
        if let text = batch.text {
            heading(L10n.tr("分享文字"))
            let limit = abbreviated ? 260 : 2000
            group {
                Text(String(text.prefix(limit)) + (text.prefix(limit + 1).count > limit ? "…" : ""))
                    .font(.orbisBody()).textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading).padding(14)
            }
        }
    }

    private func group<Content: View>(@ViewBuilder _ content: () -> Content) -> some View {
        VStack(spacing: 0, content: content).neuSurface(inset: true, radius: 14)
    }

    private func heading(_ title: String) -> some View {
        Text(title).font(.orbisLabel()).foregroundStyle(palette.secondary).accessibilityAddTraits(.isHeader)
    }

    private func rowButton(_ symbol: String, _ title: String, _ subtitle: String? = nil, actionLabel: String? = nil,
                           showsChevron: Bool = true, action: @escaping () -> Void) -> some View {
        OrbisMotionButton(action: action) { row(symbol, title, subtitle, navigates: showsChevron, actionLabel: actionLabel) }
            .buttonStyle(.plain)
    }

    private func row(_ symbol: String, _ title: String, _ subtitle: String? = nil,
                     navigates: Bool = false, actionLabel: String? = nil) -> some View {
        HStack(spacing: 12) {
            Image(systemName: symbol).foregroundStyle(palette.accent).frame(width: 21).accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 3) {
                Text(title).font(.orbisBody(.medium)).lineLimit(2)
                if let subtitle { Text(subtitle).font(.orbisCaption()).foregroundStyle(palette.secondary).lineLimit(2) }
                if let actionLabel { Text(actionLabel).font(.orbisCaption(.semibold)).foregroundStyle(palette.accent) }
            }.frame(maxWidth: .infinity, alignment: .leading)
            if navigates {
                Image(systemName: "chevron.right").font(.orbisCaption(.semibold)).foregroundStyle(palette.faint).accessibilityHidden(true)
            }
        }
        .padding(.horizontal, 14).padding(.vertical, 10).frame(minHeight: 56).contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }

    private func status(_ text: String) -> some View {
        Label(text, systemImage: "clock").font(.orbisBody()).foregroundStyle(palette.secondary)
    }

    private func confirmDelete(_ batch: ExternalImportBatch) {
        instructionFocused = false
        overlay.showDialog(L10n.tr("删除待导入内容？"), actions: [
            OrbisDialogAction(title: L10n.tr("取消"), role: .cancel),
            OrbisDialogAction(title: L10n.tr("删除"), role: .destructive) { model.delete(batch.id) }
        ])
    }
}
