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
        selected = nil; problem = nil; isOpen = true
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
    var native = false
    var body: some View {
        if !model.batches.isEmpty {
            let label = L10n.tr("待导入 · {0}", model.batches.count)
            if native {
                Button(action: model.show) { Label(label, systemImage: "tray") }
                    .accessibilityIdentifier("external-import-inbox")
            } else {
                OrbisIconButton(symbol: "tray", label: label, action: model.show)
                    .accessibilityIdentifier("external-import-inbox")
            }
        }
    }
}

struct ExternalImportInboxView: View {
    @ObservedObject var model: ExternalImportInboxModel
    @OrbisDismiss private var dismiss
    @Environment(\.colorScheme) private var scheme
    @EnvironmentObject private var overlay: OrbisOverlay
    let store: OrbisStore
    @State private var targets: [ExternalImportDestination]?
    @State private var instruction = ""
    @State private var choosingComputer = false
    @State private var launchHost: String?

    private var selected: ExternalImportBatch? { model.batches.first { $0.id == model.selected } }
    var body: some View {
        VStack(spacing: 0) {
            OrbisPageHeader(title: L10n.tr(targets == nil ? "待导入" : "选择已有会话"), closes: true, back: { dismiss() }) {
                if selected != nil {
                    OrbisIconButton(symbol: "chevron.left", label: L10n.tr("返回")) {
                        if launchHost != nil { launchHost = nil } else if choosingComputer { choosingComputer = false }
                        else if targets != nil { targets = nil } else { model.select(nil) }
                    }.disabled(model.busy)
                }
            }
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    if let problem = model.problem { OrbisNotice(text: importProblemText(problem), error: true) }
                    if model.busy || (selected != nil && model.delivering == selected?.id) { ProgressView(L10n.tr("正在处理导入…")) }
                    if let selected, let launchHost, let owner = store.connection(for: launchHost) {
                        if let host = store.hosts.first(where: { $0.id == launchHost }) { Text(host.name).font(.orbisLabel()) }
                        SessionDraftView(owner: owner, presetCwd: nil, closeRequest: 0, onSubmitted: { _, _ in },
                                         onCancel: { _ in self.launchHost = nil }, onImportSubmit: { agent, cwd, instruction in
                            self.launchHost = nil; choosingComputer = false
                            model.launch(selected, via: owner, agent: agent, cwd: cwd, instruction: instruction)
                        }).id(launchHost)
                    } else if choosingComputer {
                        let hosts = store.hosts.filter { $0.connection.connection == .secured }
                        if hosts.isEmpty { Text(L10n.tr("暂无可加入的会话")).font(.orbisBody()) }
                        ForEach(hosts) { host in
                            OrbisActionButton(title: host.name) { launchHost = host.id }.disabled(!host.connection.canLaunchExternalImport)
                        }
                    } else if let selected, let targets { targetList(targets, batch: selected) }
                    else if let selected { detail(selected) }
                    else if model.batches.isEmpty && !model.busy && model.problem == nil {
                        Text(L10n.tr("暂无待导入内容")).font(.orbisBody())
                    } else {
                        ForEach(model.batches.filter { $0.destination == nil && $0.launch == nil }, content: batchRow)
                        let drafts = model.batches.filter { $0.destination != nil || $0.launch != nil }
                        if !drafts.isEmpty {
                            Text(L10n.tr("导入草稿")).font(.orbisLabel())
                            ForEach(drafts, content: batchRow)
                        }
                    }
                }.frame(maxWidth: .infinity, alignment: .leading).padding(20)
            }
        }
        .onChange(of: model.selected) { _, _ in targets = nil; choosingComputer = false; launchHost = nil; instruction = selected?.attempt?.instruction ?? selected?.launch?.instruction ?? "" }
        .accessibilityIdentifier("external-import-sheet")
    }

    private func batchRow(_ batch: ExternalImportBatch) -> some View {
        OrbisMotionButton { model.select(batch.id) } label: {
            VStack(alignment: .leading, spacing: 4) {
                Text(batch.files.first?.name ?? String((batch.text ?? "").prefix(120))).font(.orbisBody()).lineLimit(2)
                if let destination = batch.destination {
                    Text(L10n.tr("{0} · {1}", destination.hostName, destination.sessionName)).font(.orbisCaption()).lineLimit(1)
                } else if let launch = batch.launch {
                    Text(L10n.tr("{0} · {1}", launch.hostName, launch.cwd)).font(.orbisCaption()).lineLimit(1)
                } else if !batch.files.isEmpty {
                    Text(L10n.tr("{0} 个文件", batch.files.count)).font(.orbisCaption())
                }
            }.frame(maxWidth: .infinity, alignment: .leading).padding(16)
        }.buttonStyle(NeuButtonStyle()).disabled(model.busy)
    }

    @ViewBuilder private func targetList(_ destinations: [ExternalImportDestination], batch: ExternalImportBatch) -> some View {
        if destinations.isEmpty { Text(L10n.tr("暂无可加入的会话")).font(.orbisBody()) }
        ForEach(destinations) { destination in
            OrbisMotionButton {
                targets = nil
                model.assign(batch.id, to: destination) {
                    store.connection(for: destination.target.hostId)?.externalImportRuntime(destination.target) != nil
                }
            } label: {
                destinationLabel(destination).frame(maxWidth: .infinity, alignment: .leading).padding(16)
            }.buttonStyle(NeuButtonStyle()).disabled(model.busy)
        }
    }

    private func destinationLabel(_ destination: ExternalImportDestination) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(destination.sessionName).font(.orbisBody(.medium))
            Text(L10n.tr("{0} · {1}", destination.hostName, destination.target.cwd)).font(.orbisCaption())
        }
    }

    private func detail(_ batch: ExternalImportBatch) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            if let destination = batch.destination { destinationLabel(destination) }
            ForEach(Array(batch.files.enumerated()), id: \.offset) { _, file in
                VStack(alignment: .leading, spacing: 4) {
                    Text(file.name).font(.orbisBody())
                    Text(byteCount(file.bytes)).font(.orbisCaption())
                }
            }
            if let body = batch.text {
                Text(body.count > 2000 ? String(body.prefix(2000)) + "…" : body).font(.orbisBody()).textSelection(.enabled)
            }
            if let destination = batch.destination {
                let connection = store.connection(for: destination.target.hostId)
                if batch.attempt?.receipt == .accepted {
                    Text(L10n.tr("会话已接收")).font(.orbisLabel())
                } else if batch.attempt != nil && batch.attempt?.receipt != .failed {
                    Text(L10n.tr("发送结果待核对")).font(.orbisLabel())
                    OrbisActionButton(title: L10n.tr("核对结果")) { model.deliver(batch, via: connection) }.disabled(model.busy || model.delivering != nil)
                } else {
                    if batch.attempt?.receipt == .failed { OrbisNotice(text: L10n.tr("发送失败"), error: true) }
                    TextField(L10n.tr("补充要求（可选）"), text: $instruction, axis: .vertical).textFieldStyle(.roundedBorder)
                        .lineLimit(2...5).disabled(model.busy || model.delivering == batch.id)
                    OrbisActionButton(title: L10n.tr("发送")) { model.deliver(batch, via: connection, instruction: instruction) }
                        .disabled(model.busy || model.delivering != nil).accessibilityIdentifier("external-import-send")
                    if batch.launch == nil {
                        OrbisActionButton(title: L10n.tr("移回待导入")) { model.unassign(batch.id, from: destination.target) }.disabled(model.busy || model.delivering == batch.id)
                    }
                }
            } else if let launch = batch.launch {
                Text(L10n.tr("{0} · {1}", launch.hostName, launch.cwd)).font(.orbisCaption())
                Text(L10n.tr(launch.failed ? "启动失败" : "启动结果待核对")).font(.orbisLabel())
                if launch.failed {
                    OrbisActionButton(title: L10n.tr("移回待导入")) { model.clearFailedLaunch(batch, launch: launch) }.disabled(model.delivering != nil)
                } else {
                    OrbisActionButton(title: L10n.tr("核对结果")) { model.deliver(batch, via: store.connection(for: launch.hostId)) }.disabled(model.delivering != nil)
                }
            } else {
                OrbisActionButton(title: L10n.tr("加入会话草稿")) {
                    targets = store.hosts.flatMap { $0.connection.externalImportDestinations() }
                }.disabled(model.busy).accessibilityIdentifier("external-import-choose-target")
                OrbisActionButton(title: L10n.tr("新建会话")) { choosingComputer = true }
                    .disabled(model.busy || model.delivering != nil).accessibilityIdentifier("external-import-new-session")
            }
            Button(L10n.tr("删除")) {
                overlay.showDialog(L10n.tr("删除待导入内容？"), actions: [
                    OrbisDialogAction(title: L10n.tr("取消"), role: .cancel),
                    OrbisDialogAction(title: L10n.tr("删除"), role: .destructive) { model.delete(batch.id) }
                ])
            }.font(.orbisLabel()).foregroundStyle(OrbisPalette(scheme).error).disabled(model.busy || model.delivering == batch.id)
        }
    }
}
