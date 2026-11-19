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
                        .frame(minWidth: 16, height: 16)
                        .background(OrbisPalette(scheme).accent, in: Capsule())
                        .offset(x: -4, y: 4)
                        .allowsHitTesting(false)
                }
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
    @FocusState private var instructionFocused: Bool

    private var selected: ExternalImportBatch? { model.batches.first { $0.id == model.selected } }

    private var pageTitle: String {
        if launchHost != nil { return L10n.tr("新建会话") }
        if choosingComputer { return L10n.tr("选择电脑") }
        if targets != nil { return L10n.tr("选择已有会话") }
        if selected != nil { return L10n.tr("待导入项") }
        return L10n.tr("待导入")
    }

    private var canGoBack: Bool {
        selected != nil || targets != nil || choosingComputer || launchHost != nil
    }

    private func handleBack() {
        if launchHost != nil { launchHost = nil }
        else if choosingComputer { choosingComputer = false }
        else if targets != nil { targets = nil }
        else { model.select(nil) }
    }

    var body: some View {
        let p = OrbisPalette(scheme)
        VStack(spacing: 0) {
            OrbisHeader {
                if canGoBack {
                    OrbisIconButton(symbol: "arrow.left", label: L10n.tr("返回"), action: handleBack)
                        .disabled(model.busy)
                } else {
                    Color.clear.frame(width: 40, height: 40)
                }
            } title: {
                OrbisMotionText(pageTitle).font(.orbisTitle()).lineLimit(1).accessibilityAddTraits(.isHeader)
            } trailing: {
                OrbisIconButton(symbol: "xmark", label: L10n.tr("关闭"), action: { dismiss() })
            }

            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    if let problem = model.problem { OrbisNotice(text: importProblemText(problem), error: true) }
                    if model.busy || (selected != nil && model.delivering == selected?.id) { ProgressView(L10n.tr("正在处理导入…")) }

                    if let selected, let launchHost, let owner = store.connection(for: launchHost) {
                        if let host = store.hosts.first(where: { $0.id == launchHost }) {
                            HStack(spacing: 8) {
                                Image(systemName: "desktopcomputer").foregroundStyle(p.accent)
                                Text(host.name).font(.orbisLabel(.semibold))
                            }
                            .padding(.horizontal, 14)
                            .padding(.vertical, 8)
                            .background(p.inset, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                        }
                        SessionDraftView(owner: owner, presetCwd: nil, closeRequest: 0, onSubmitted: { _, _ in },
                                         onCancel: { _ in self.launchHost = nil }, onImportSubmit: { agent, cwd, instruction in
                            self.launchHost = nil; choosingComputer = false
                            model.launch(selected, via: owner, agent: agent, cwd: cwd, instruction: instruction)
                        }).id(launchHost)
                    } else if choosingComputer {
                        let hosts = store.hosts.filter { $0.connection.connection == .secured }
                        if hosts.isEmpty {
                            OrbisEmptyState(symbol: "desktopcomputer", title: L10n.tr("暂无可加入的会话"))
                        } else {
                            ForEach(hosts) { host in
                                OrbisMotionButton { launchHost = host.id } label: {
                                    HStack(spacing: 12) {
                                        ZStack {
                                            RoundedRectangle(cornerRadius: 10, style: .continuous)
                                                .fill(p.inset)
                                            Image(systemName: "desktopcomputer")
                                                .font(.system(size: 16))
                                                .foregroundStyle(p.accent)
                                        }.frame(width: 38, height: 38)
                                        VStack(alignment: .leading, spacing: 3) {
                                            Text(host.name).font(.orbisBody(.medium))
                                            Text(L10n.tr("已连接")).font(.orbisCaption()).foregroundStyle(p.secondary)
                                        }
                                        Spacer(minLength: 0)
                                        Image(systemName: "chevron.right")
                                            .font(.system(size: 13, weight: .semibold))
                                            .foregroundStyle(p.faint)
                                    }
                                    .frame(maxWidth: .infinity, alignment: .leading)
                                    .padding(14)
                                }
                                .buttonStyle(NeuButtonStyle())
                                .disabled(!host.connection.canLaunchExternalImport)
                            }
                        }
                    } else if let selected, let targets {
                        targetList(targets, batch: selected)
                    } else if let selected {
                        detail(selected)
                    } else if model.batches.isEmpty && !model.busy && model.problem == nil {
                        OrbisEmptyState(symbol: "tray", title: L10n.tr("暂无待导入内容"))
                    } else {
                        let unassigned = model.batches.filter { $0.destination == nil && $0.launch == nil }
                        let drafts = model.batches.filter { $0.destination != nil || $0.launch != nil }

                        if !unassigned.isEmpty {
                            if !drafts.isEmpty {
                                Text(L10n.tr("待导入")).font(.orbisLabel()).foregroundStyle(p.secondary)
                            }
                            ForEach(unassigned, content: batchRow)
                        }

                        if !drafts.isEmpty {
                            Text(L10n.tr("导入草稿")).font(.orbisLabel()).foregroundStyle(p.accent)
                            ForEach(drafts, content: batchRow)
                        }
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(20)
            }
        }
        .onChange(of: model.selected) { _, _ in
            targets = nil
            choosingComputer = false
            launchHost = nil
            instruction = selected?.attempt?.instruction ?? selected?.launch?.instruction ?? ""
        }
        .accessibilityIdentifier("external-import-sheet")
    }

    private func batchRow(_ batch: ExternalImportBatch) -> some View {
        let p = OrbisPalette(scheme)
        let destination = batch.destination
        let launch = batch.launch
        let isDraft = destination != nil || launch != nil
        let hasFiles = !batch.files.isEmpty

        return OrbisMotionButton { model.select(batch.id) } label: {
            HStack(spacing: 12) {
                ZStack {
                    RoundedRectangle(cornerRadius: 10, style: .continuous)
                        .fill(p.inset)
                    Image(systemName: hasFiles ? "doc.fill" : "text.alignleft")
                        .font(.system(size: 16))
                        .foregroundStyle(isDraft ? p.accent : p.secondary)
                }
                .frame(width: 38, height: 38)

                VStack(alignment: .leading, spacing: 3) {
                    Text(batch.files.first?.name ?? String((batch.text ?? "").prefix(120)))
                        .font(.orbisBody(.medium))
                        .lineLimit(1)
                    let subtitle: String = {
                        if let destination { return L10n.tr("{0} · {1}", destination.hostName, destination.sessionName) }
                        if let launch { return L10n.tr("{0} · {1}", launch.hostName, launch.cwd) }
                        if hasFiles { return L10n.tr("{0} 个文件 · {1}", batch.files.count, byteCount(batch.files.reduce(0) { $0 + $1.bytes })) }
                        return byteCount(Int64((batch.text ?? "").utf8.count))
                    }()
                    Text(subtitle)
                        .font(.orbisCaption())
                        .foregroundStyle(p.secondary)
                        .lineLimit(1)
                }
                Spacer(minLength: 0)

                if isDraft {
                    Text(L10n.tr("草稿"))
                        .font(.orbisCaption(.semibold))
                        .foregroundStyle(p.accent)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(p.accent.opacity(0.12), in: RoundedRectangle(cornerRadius: 6, style: .continuous))
                }
                Image(systemName: "chevron.right")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(p.faint)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(14)
        }
        .buttonStyle(NeuButtonStyle())
        .disabled(model.busy)
    }

    @ViewBuilder private func targetList(_ destinations: [ExternalImportDestination], batch: ExternalImportBatch) -> some View {
        let p = OrbisPalette(scheme)
        if destinations.isEmpty {
            OrbisEmptyState(symbol: "bubble.left.and.bubble.right", title: L10n.tr("暂无可加入的会话"))
        } else {
            ForEach(destinations) { destination in
                OrbisMotionButton {
                    targets = nil
                    model.assign(batch.id, to: destination) {
                        store.connection(for: destination.target.hostId)?.externalImportRuntime(destination.target) != nil
                    }
                } label: {
                    HStack(spacing: 12) {
                        ZStack {
                            RoundedRectangle(cornerRadius: 10, style: .continuous)
                                .fill(p.inset)
                            Image(systemName: "bubble.left.and.bubble.right")
                                .font(.system(size: 16))
                                .foregroundStyle(p.accent)
                        }.frame(width: 38, height: 38)
                        VStack(alignment: .leading, spacing: 3) {
                            Text(destination.sessionName).font(.orbisBody(.medium))
                            Text(L10n.tr("{0} · {1}", destination.hostName, destination.target.cwd))
                                .font(.orbisCaption())
                                .foregroundStyle(p.secondary)
                        }
                        Spacer(minLength: 0)
                        Image(systemName: "chevron.right")
                            .font(.system(size: 13, weight: .semibold))
                            .foregroundStyle(p.faint)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(14)
                }
                .buttonStyle(NeuButtonStyle())
                .disabled(model.busy)
            }
        }
    }

    private func detail(_ batch: ExternalImportBatch) -> some View {
        let p = OrbisPalette(scheme)
        return VStack(alignment: .leading, spacing: 14) {
            if !batch.files.isEmpty {
                VStack(alignment: .leading, spacing: 10) {
                    ForEach(Array(batch.files.enumerated()), id: \.offset) { _, file in
                        HStack(spacing: 12) {
                            ZStack {
                                RoundedRectangle(cornerRadius: 8, style: .continuous)
                                    .fill(p.inset)
                                Image(systemName: "doc.fill")
                                    .font(.system(size: 15))
                                    .foregroundStyle(p.accent)
                            }.frame(width: 36, height: 36)
                            VStack(alignment: .leading, spacing: 2) {
                                FileNameText(name: file.name).font(.orbisBody(.medium))
                                Text(byteCount(file.bytes)).font(.orbisCaption()).foregroundStyle(p.secondary)
                            }
                            Spacer(minLength: 0)
                        }
                    }
                }
                .padding(14)
                .neuSurface(inset: false, radius: 16)
            }

            if let body = batch.text {
                Text(body.count > 2000 ? String(body.prefix(2000)) + "…" : body)
                    .font(.orbisBody())
                    .textSelection(.enabled)
                    .padding(14)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .neuSurface(inset: true, radius: 12)
            }

            if let destination = batch.destination {
                HStack(spacing: 12) {
                    ZStack {
                        RoundedRectangle(cornerRadius: 8, style: .continuous)
                            .fill(p.inset)
                        Image(systemName: "bubble.left.and.bubble.right.fill")
                            .font(.system(size: 15))
                            .foregroundStyle(p.accent)
                    }.frame(width: 36, height: 36)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(destination.sessionName).font(.orbisBody(.medium))
                        Text(L10n.tr("{0} · {1}", destination.hostName, destination.target.cwd))
                            .font(.orbisCaption())
                            .foregroundStyle(p.secondary)
                    }
                    Spacer(minLength: 0)
                }
                .padding(14)
                .neuSurface(inset: false, radius: 16)

                let connection = store.connection(for: destination.target.hostId)
                if batch.attempt?.receipt == .accepted {
                    HStack(spacing: 8) {
                        Image(systemName: "checkmark.circle.fill")
                            .foregroundStyle(p.accent)
                        Text(L10n.tr("会话已接收")).font(.orbisLabel(.semibold))
                            .foregroundStyle(p.accent)
                    }.padding(.horizontal, 4)
                } else if batch.attempt != nil && batch.attempt?.receipt != .failed {
                    Text(L10n.tr("发送结果待核对")).font(.orbisBody()).foregroundStyle(p.secondary)
                    OrbisActionButton(title: L10n.tr("核对结果"), symbol: "arrow.clockwise") {
                        model.deliver(batch, via: connection)
                    }.disabled(model.busy || model.delivering != nil)
                } else {
                    if batch.attempt?.receipt == .failed { OrbisNotice(text: L10n.tr("发送失败"), error: true) }
                    TextField(L10n.tr("补充要求（可选）"), text: $instruction, axis: .vertical)
                        .font(.orbisBody())
                        .focused($instructionFocused)
                        .orbisInput(focused: instructionFocused)
                        .lineLimit(2...5)
                        .disabled(model.busy || model.delivering == batch.id)
                    OrbisActionButton(title: L10n.tr("发送"), symbol: "arrow.up") {
                        model.deliver(batch, via: connection, instruction: instruction)
                    }
                    .disabled(model.busy || model.delivering != nil)
                    .accessibilityIdentifier("external-import-send")
                    if batch.launch == nil {
                        HStack {
                            Spacer()
                            OrbisTextButton(title: L10n.tr("移回待导入")) {
                                model.unassign(batch.id, from: destination.target)
                            }
                            .disabled(model.busy || model.delivering == batch.id)
                            Spacer()
                        }
                    }
                }
            } else if let launch = batch.launch {
                HStack(spacing: 12) {
                    ZStack {
                        RoundedRectangle(cornerRadius: 8, style: .continuous)
                            .fill(p.inset)
                        Image(systemName: "desktopcomputer")
                            .font(.system(size: 15))
                            .foregroundStyle(p.accent)
                    }.frame(width: 36, height: 36)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(launch.hostName).font(.orbisBody(.medium))
                        Text(launch.cwd).font(.orbisCaption()).foregroundStyle(p.secondary)
                    }
                    Spacer(minLength: 0)
                }
                .padding(14)
                .neuSurface(inset: false, radius: 16)

                if launch.failed {
                    OrbisNotice(text: L10n.tr("启动失败"), error: true)
                    HStack {
                        Spacer()
                        OrbisTextButton(title: L10n.tr("移回待导入")) {
                            model.clearFailedLaunch(batch, launch: launch)
                        }.disabled(model.delivering != nil)
                        Spacer()
                    }
                } else {
                    Text(L10n.tr("启动结果待核对")).font(.orbisBody()).foregroundStyle(p.secondary)
                    OrbisActionButton(title: L10n.tr("核对结果"), symbol: "arrow.clockwise") {
                        model.deliver(batch, via: store.connection(for: launch.hostId))
                    }.disabled(model.delivering != nil)
                }
            } else {
                VStack(spacing: 10) {
                    OrbisActionButton(title: L10n.tr("加入会话草稿"), symbol: "bubble.left.and.bubble.right") {
                        targets = store.hosts.flatMap { $0.connection.externalImportDestinations() }
                    }
                    .disabled(model.busy)
                    .accessibilityIdentifier("external-import-choose-target")

                    OrbisActionButton(title: L10n.tr("新建会话"), symbol: "plus") {
                        choosingComputer = true
                    }
                    .disabled(model.busy || model.delivering != nil)
                    .accessibilityIdentifier("external-import-new-session")
                }
            }

            HStack {
                Spacer()
                Button(role: .destructive) {
                    overlay.showDialog(L10n.tr("删除待导入内容？"), actions: [
                        OrbisDialogAction(title: L10n.tr("取消"), role: .cancel),
                        OrbisDialogAction(title: L10n.tr("删除"), role: .destructive) { model.delete(batch.id) }
                    ])
                } label: {
                    HStack(spacing: 6) {
                        Image(systemName: "trash")
                        Text(L10n.tr("删除"))
                    }
                    .font(.orbisLabel())
                    .foregroundStyle(p.error)
                    .padding(.vertical, 8)
                    .padding(.horizontal, 16)
                }
                .disabled(model.busy || model.delivering == batch.id)
                Spacer()
            }
            .padding(.top, 4)
        }
    }
}
