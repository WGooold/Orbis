import SwiftUI

@MainActor final class ExternalImportInboxModel: ObservableObject {
    @Published private(set) var batches: [ExternalImportBatch] = []
    @Published private(set) var selected: UUID?
    @Published private(set) var problem: ExternalImportProblem?
    @Published private(set) var busy = false
    @Published private(set) var delivering: UUID?
    /// OI-08: what the explicit send is waiting on; presentation only.
    @Published private(set) var phase: ExternalImportPhase?
    /// OI-08: the Session confirmed receipt and the local copy already left the inbox.
    @Published private(set) var completed: ExternalImportDestination?
    /// OI-08: a Send tapped in the Share Extension, waiting for its computer to come online.
    @Published private(set) var autoSending: UUID?
    @Published private(set) var recent: ExternalImportTarget? = ExternalImportInboxModel.storedRecent()
    @Published var isOpen = false {
        didSet {
            guard !isOpen else { return }
            completed = nil
            // Closing while it waits is a choice not to send now; the request is spent, the content stays.
            if let id = autoSending { autoSending = nil; Task.detached { try? ExternalImportStore.applicationInbox().clearSendRequest(id) } }
        }
    }
    private var readGeneration = 0
    nonisolated private static let recentKey = "orbis.externalImport.recentTarget"

    nonisolated private static func storedRecent() -> ExternalImportTarget? {
        UserDefaults.standard.data(forKey: recentKey).flatMap { try? JSONDecoder().decode(ExternalImportTarget.self, from: $0) }
    }

    func refresh() {
        guard !busy else { return }
        readGeneration += 1
        let generation = readGeneration
        let keep = delivering
        Task {
            let result = await Task.detached(priority: .utility) {
                Result { () -> [ExternalImportBatch] in
                    let store = try ExternalImportStore.applicationInbox()
                    // Accepted batches leave here too, including ones confirmed by an earlier version.
                    _ = try? store.removeAccepted(keeping: keep)
                    return try store.list()
                }
            }.value
            guard generation == readGeneration else { return }
            if case .success(let entries) = result { batches = entries; resumeRequestedSend(entries) }
            else if isOpen { problem = .unreadable }
        }
    }

    func show() {
        selected = batches.count == 1 ? batches.first?.id : nil; problem = nil; completed = nil; isOpen = true
        refresh()
    }

    func select(_ id: UUID?) { selected = id; problem = nil; completed = nil }

    /// Leaves the completion page: back to remaining items, or out of the sheet when nothing is left.
    func finishCompleted() {
        completed = nil
        if batches.isEmpty { isOpen = false }
    }

    func openDocument(_ url: URL) {
        guard !busy else { isOpen = true; problem = .busy; return }
        selected = nil; problem = nil; completed = nil; isOpen = true
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

    /// One explicit action: bind the chosen Session (replacing an unsent choice) and send.
    func send(_ batch: ExternalImportBatch, to destination: ExternalImportDestination, via connection: HostConnection?, note: String) {
        guard !busy, delivering == nil else { return }
        guard let connection, connection.externalImportRuntime(destination.target) != nil else {
            problem = .targetUnavailable; autoSending = nil; return
        }
        autoSending = nil
        runDelivery(batch, via: connection, initial: .sending) { connection, inbox, phase in
            let bound = try await Task.detached { () -> ExternalImportBatch in
                if batch.sendRequestedAt != nil { try inbox.clearSendRequest(batch.id) }
                if let launch = batch.launch, launch.failed, batch.destination == nil { try inbox.clearFailedLaunch(batch.id, launchId: launch.id) }
                if let old = batch.destination {
                    // A Session created for this content stays its only target.
                    if old.target == destination.target { return try inbox.list().first { $0.id == batch.id } ?? batch }
                    _ = try inbox.unassign(batch.id, from: old.target)
                }
                return try inbox.assign(batch.id, to: destination)
            }.value
            try await connection.sendExternalImport(bound, from: inbox, instruction: note, phase: phase)
        }
    }

    /// Read-only: asks the computer what happened to the original send or launch. Never sends again.
    func recheck(_ batch: ExternalImportBatch, via connection: HostConnection?) {
        runDelivery(batch, via: connection, initial: .checking) { connection, inbox, phase in
            if batch.destination == nil { try await connection.recoverExternalLaunch(batch, in: inbox, phase: phase) }
            else { try await connection.checkExternalImport(batch, in: inbox) }
        }
    }

    func launch(_ batch: ExternalImportBatch, via connection: HostConnection, agent: String, cwd: String, instruction: String) {
        runDelivery(batch, via: connection, initial: .launching) { connection, inbox, phase in
            if let old = batch.destination { _ = try await Task.detached { try inbox.unassign(batch.id, from: old.target) }.value }
            if let launch = batch.launch, launch.failed {
                try await Task.detached { try inbox.clearFailedLaunch(batch.id, launchId: launch.id) }.value
            }
            let fresh = try await Task.detached { try inbox.list().first { $0.id == batch.id } }.value ?? batch
            try await connection.launchExternalImport(fresh, from: inbox, agent: agent, cwd: cwd, instruction: instruction, phase: phase)
        }
    }

    /// The extension's request could not reach its computer in time; it becomes an ordinary bound draft.
    func abandonAutoSend(_ id: UUID) {
        guard autoSending == id else { return }
        autoSending = nil
        if selected == id { problem = .targetUnavailable }
        Task.detached { try? ExternalImportStore.applicationInbox().clearSendRequest(id) }
    }

    /// OI-08: a minimal list the Share Extension can offer; Orbis re-checks everything before sending.
    func saveTargets(_ choices: [ExternalImportChoice]) {
        let snapshot = ExternalImportTargetSnapshot(entries: choices.map {
            .init(destination: $0.destination, agentKind: $0.agentKind, running: $0.running)
        }, recent: recent, savedAt: Date())
        Task.detached(priority: .utility) { try? ExternalImportStore.applicationInbox().saveTargets(snapshot) }
    }

    private func resumeRequestedSend(_ entries: [ExternalImportBatch]) {
        guard autoSending == nil, delivering == nil, !busy,
              let next = ExternalImportAutoSend.next(entries, now: Date()) else { return }
        selected = next.id; problem = nil; completed = nil; autoSending = next.id; isOpen = true
    }

    private func runDelivery(_ batch: ExternalImportBatch, via connection: HostConnection?, initial: ExternalImportPhase,
                             action: @escaping @MainActor (HostConnection, ExternalImportStore, @escaping @MainActor (ExternalImportPhase) -> Void) async throws -> Void) {
        guard !busy, delivering == nil else { return }
        guard let connection else { problem = .targetUnavailable; return }
        delivering = batch.id; phase = initial; problem = nil
        Task {
            do {
                let inbox = try await Task.detached { try ExternalImportStore.applicationInbox() }.value
                try await action(connection, inbox) { next in
                    if self.delivering == batch.id { self.phase = next }
                }
            } catch {
                if selected == batch.id { problem = (error as? ExternalImportProblem) ?? .unreadable }
            }
            let accepted = await Task.detached { (try? ExternalImportStore.applicationInbox().removeAccepted()) ?? [] }.value
            if let done = accepted.first(where: { $0.id == batch.id })?.destination {
                recent = done.target
                if let data = try? JSONEncoder().encode(done.target) { UserDefaults.standard.set(data, forKey: Self.recentKey) }
                if isOpen && selected == batch.id { completed = done; selected = nil; problem = nil }
            }
            delivering = nil; phase = nil
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
            let label = L10n.tr("待发送 · {0}", model.batches.count)
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

/// OI-08: one page — what is being sent, an optional note, which Session — then one Send.
struct ExternalImportInboxView: View {
    private enum Route: Hashable { case main, computers, setup }
    private enum Stage { case compose, awaitingReceipt, awaitingLaunch }

    @ObservedObject var model: ExternalImportInboxModel
    @OrbisDismiss private var dismiss
    @Environment(\.colorScheme) private var scheme
    @EnvironmentObject private var overlay: OrbisOverlay
    @ObservedObject var store: OrbisStore
    /// Opens the confirmed Session after the sheet hands control back.
    var onOpenSession: (ExternalImportTarget) -> Void = { _ in }
    @State private var route: Route = .main
    @State private var setupBack: Route = .main
    @State private var launchHost: String?
    @State private var note = ""
    @State private var choice: ExternalImportTarget?
    @State private var expanded = false
    @FocusState private var noteFocused: Bool

    private var batch: ExternalImportBatch? { model.batches.first { $0.id == model.selected } }
    private var delivering: Bool { batch != nil && model.delivering == batch?.id }
    private var processing: Bool { model.busy || delivering }
    private var actionable: Bool { !model.busy && model.delivering == nil && model.autoSending == nil }
    private var palette: OrbisPalette { OrbisPalette(scheme) }

    private func stage(_ batch: ExternalImportBatch) -> Stage {
        if let receipt = batch.attempt?.receipt, receipt != .failed, receipt != .accepted { return .awaitingReceipt }
        if batch.destination == nil, let launch = batch.launch, !launch.failed { return .awaitingLaunch }
        return .compose
    }

    private var title: String {
        if model.completed != nil { return L10n.tr("已发送") }
        guard batch != nil else { return L10n.tr("待发送") }
        switch route {
        case .main: return L10n.tr("发送到会话")
        case .computers: return L10n.tr("选择电脑")
        case .setup: return L10n.tr("新建会话")
        }
    }

    private var showsBack: Bool {
        model.completed != nil ? !model.batches.isEmpty : route != .main || (batch != nil && model.batches.count > 1)
    }

    private func back() {
        noteFocused = false
        if model.completed != nil { model.finishCompleted(); return }
        switch route {
        case .setup: launchHost = nil; route = setupBack
        case .computers: route = .main
        case .main: model.select(nil)
        }
    }

    /// Live, ordered choices across computers; only the foreground computer's open chat counts as current.
    private var groups: [[ExternalImportChoice]] {
        let choices = store.hosts.flatMap { host in
            host.connection.externalImportChoices().map { choice in
                var choice = choice
                choice.current = choice.current && host.id == store.selectedHostId
                return choice
            }
        }
        return ExternalImportChoice.ordered(choices, recent: model.recent)
    }

    var body: some View {
        VStack(spacing: 0) {
            OrbisHeader {
                if showsBack { OrbisIconButton(symbol: "arrow.left", label: L10n.tr("返回"), compact: true, action: back).disabled(model.busy) }
            } title: {
                OrbisMotionText(title).font(.orbisTitle()).accessibilityAddTraits(.isHeader)
            } trailing: {
                if let batch, route == .main, model.completed == nil {
                    OrbisIconButton(symbol: "trash", label: L10n.tr("删除"), compact: true) { confirmDelete(batch) }
                        .disabled(processing || model.autoSending == batch.id)
                }
                OrbisIconButton(symbol: "xmark", label: L10n.tr("关闭"), compact: true) { dismiss() }
            }
            if processing { ProgressView().frame(maxWidth: .infinity).padding(.vertical, 4).accessibilityLabel(L10n.tr("正在处理…")) }

            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    if let problem = model.problem { OrbisNotice(text: importProblemText(problem), error: true) }
                    if let completed = model.completed { completedView(completed) }
                    else if let batch {
                        switch route {
                        case .main: main(batch)
                        case .computers: computers
                        case .setup: setup(batch)
                        }
                    } else { inbox }
                }
                .frame(maxWidth: 580)
                .padding(20)
                .frame(maxWidth: .infinity, alignment: .top)
            }
            .id(ScrollIdentity(batch: batch?.id, route: route, completed: model.completed?.target))
            .scrollDismissesKeyboard(.interactively)

            footer
        }
        .onChange(of: model.selected, initial: true) { _, _ in
            noteFocused = false
            route = .main
            launchHost = nil
            expanded = false
            note = batch?.note ?? batch?.attempt?.instruction ?? batch?.launch?.instruction ?? ""
            choice = batch?.destination?.target
        }
        .task(id: model.autoSending) { await resumeRequestedSend() }
        .accessibilityIdentifier("external-import-sheet")
    }

    private struct ScrollIdentity: Hashable {
        let batch: UUID?
        let route: Route
        let completed: ExternalImportTarget?
    }

    /// OI-08: Send tapped in the Share Extension runs once its computer is ready; otherwise it waits as a draft.
    private func resumeRequestedSend() async {
        guard let id = model.autoSending, let batch = model.batches.first(where: { $0.id == id }),
              let destination = batch.destination else { return }
        for _ in 0..<60 {
            if let connection = store.connection(for: destination.target.hostId), connection.externalImportRuntime(destination.target) != nil {
                model.send(batch, to: destination, via: connection, note: batch.note ?? "")
                return
            }
            do { try await Task.sleep(for: .milliseconds(500)) } catch { return }
        }
        model.abandonAutoSend(id)
    }

    // MARK: Pages

    @ViewBuilder private var inbox: some View {
        if model.batches.isEmpty && !processing && model.problem == nil {
            OrbisEmptyState(symbol: "tray", title: L10n.tr("没有待发送的内容"))
        }
        if !model.batches.isEmpty {
            VStack(spacing: 10) {
                ForEach(model.batches) { batch in
                    Button(action: { model.select(batch.id) }) {
                        HStack(spacing: 12) {
                            contentIcon(batch, size: 36)
                            VStack(alignment: .leading, spacing: 3) {
                                Text(contentTitle(batch)).font(.orbisBody(.medium)).lineLimit(1)
                                Text(statusLine(batch)).font(.orbisCaption()).foregroundStyle(statusIsError(batch) ? palette.error : palette.secondary).lineLimit(1)
                            }.frame(maxWidth: .infinity, alignment: .leading)
                            Image(systemName: "chevron.right").font(.orbisCaption(.semibold)).foregroundStyle(palette.faint).accessibilityHidden(true)
                        }.padding(.horizontal, 14).padding(.vertical, 10).frame(minHeight: 60).contentShape(Rectangle())
                        .accessibilityElement(children: .combine)
                    }.buttonStyle(NeuButtonStyle(radius: 14)).disabled(model.busy)
                }
            }
        }
    }

    @ViewBuilder private func main(_ batch: ExternalImportBatch) -> some View {
        if !delivering {
            if batch.attempt?.receipt == .failed { OrbisNotice(text: L10n.tr("发送失败"), error: true) }
            if batch.destination == nil, batch.launch?.failed == true { OrbisNotice(text: L10n.tr("新会话没有启动"), error: true) }
        }
        contentCard(batch)
        switch stage(batch) {
        case .awaitingReceipt:
            if let destination = batch.destination {
                targetRow(destination.sessionName, notes: [destination.hostName, directoryTitle(destination.target.cwd)],
                          agent: agent(for: destination.target), selected: true).neuSurface(inset: true, radius: 14)
            }
            if !delivering { status(L10n.tr("未收到电脑确认")) }
        case .awaitingLaunch:
            if let launch = batch.launch {
                targetRow(L10n.tr("新建会话"), notes: [launch.hostName, directoryTitle(launch.cwd)], agent: launch.agent, selected: true)
                    .neuSurface(inset: true, radius: 14)
            }
            if !delivering { status(L10n.tr("未收到新会话确认")) }
        case .compose:
            TextField(L10n.tr("添加说明…"), text: $note, axis: .vertical)
                .font(.orbisBody()).focused($noteFocused).orbisInput(focused: noteFocused)
                .lineLimit(1...4).disabled(processing).accessibilityIdentifier("external-import-note")
            targets(batch)
        }
    }

    @ViewBuilder private func targets(_ batch: ExternalImportBatch) -> some View {
        if batch.launch != nil, let destination = batch.destination {
            // A Session created for this content stays its only target.
            targetRow(destination.sessionName, notes: [destination.hostName, directoryTitle(destination.target.cwd)],
                      agent: agent(for: destination.target), selected: true).neuSurface(inset: true, radius: 14)
        } else {
            let groups = groups
            if groups.isEmpty {
                // The first foreground after sharing races the catalog; empty is not final while a computer is connecting.
                if store.hosts.contains(where: { $0.connection.externalImportConnecting }) {
                    status(L10n.tr("正在连接…"))
                } else {
                    OrbisEmptyState(symbol: "bubble.left.and.bubble.right", title: L10n.tr("暂无可加入的会话"))
                }
            }
            ForEach(groups, id: \.first?.id) { choices in
                if let first = choices.first {
                    VStack(alignment: .leading, spacing: 10) {
                        heading(first.destination.hostName)
                        ForEach(choices) { option in
                            let selected = choice == option.id
                            Button(action: {
                                noteFocused = false
                                choice = selected ? nil : option.id
                            }) {
                                targetRow(option.destination.sessionName,
                                          notes: [directoryTitle(option.destination.target.cwd),
                                                  option.running ? L10n.tr("运行中") : nil,
                                                  option.id == model.recent ? L10n.tr("最近使用") : nil],
                                          agent: option.agentKind, selected: selected)
                            }
                            // Shared selection language: raised at rest, pressed in once chosen.
                            .buttonStyle(NeuButtonStyle(selected: selected, radius: 14)).disabled(!actionable)
                            .accessibilityAddTraits(selected ? .isSelected : [])
                            .accessibilityIdentifier("external-import-target")
                        }
                    }
                }
            }
            Button(action: newSession) {
                HStack(spacing: 12) {
                    Image(systemName: "plus").font(.orbisBody(.semibold)).foregroundStyle(palette.accent).frame(width: 24)
                    Text(L10n.tr("新建会话")).font(.orbisBody(.medium)).frame(maxWidth: .infinity, alignment: .leading)
                    Image(systemName: "chevron.right").font(.orbisCaption(.semibold)).foregroundStyle(palette.faint)
                }.padding(.horizontal, 14).frame(minHeight: 54).contentShape(Rectangle())
            }
            .buttonStyle(NeuButtonStyle(radius: 14)).disabled(!actionable).accessibilityIdentifier("external-import-new-session")
        }
    }

    private func newSession() {
        noteFocused = false
        let hosts = store.hosts.filter { $0.connection.canLaunchExternalImport }
        if hosts.count == 1 { launchHost = hosts[0].id; setupBack = .main; route = .setup }
        else { route = .computers }
    }

    @ViewBuilder private var computers: some View {
        let hosts = store.hosts.filter { $0.connection.canLaunchExternalImport }
        if hosts.isEmpty { OrbisEmptyState(symbol: "desktopcomputer", title: L10n.tr("暂无可用电脑")) }
        else {
            VStack(spacing: 10) {
                ForEach(hosts) { host in
                    Button(action: { launchHost = host.id; setupBack = .computers; route = .setup }) {
                        HStack(spacing: 12) {
                            Image(systemName: "desktopcomputer").foregroundStyle(palette.accent).frame(width: 24)
                            Text(host.name).font(.orbisBody(.medium)).frame(maxWidth: .infinity, alignment: .leading)
                            Image(systemName: "chevron.right").font(.orbisCaption(.semibold)).foregroundStyle(palette.faint)
                        }.padding(.horizontal, 14).frame(minHeight: 54).contentShape(Rectangle())
                    }.buttonStyle(NeuButtonStyle(radius: 14)).disabled(!actionable)
                }
            }
        }
    }

    @ViewBuilder private func setup(_ batch: ExternalImportBatch) -> some View {
        if let launchHost, let host = store.hosts.first(where: { $0.id == launchHost }),
           let owner = store.connection(for: launchHost) {
            heading(host.name)
            SessionDraftView(owner: owner, presetCwd: nil, closeRequest: 0, onSubmitted: { _, _ in },
                             onCancel: { _ in back() }, onImportSubmit: { agent, cwd, first in
                let instruction = [note.trimmingCharacters(in: .whitespacesAndNewlines), first].filter { !$0.isEmpty }.joined(separator: "\n\n")
                self.launchHost = nil; route = .main
                model.launch(batch, via: owner, agent: agent, cwd: cwd, instruction: instruction)
            }).id(launchHost)
        } else { OrbisEmptyState(symbol: "desktopcomputer", title: L10n.tr("暂无可用电脑")) }
    }

    @ViewBuilder private func completedView(_ destination: ExternalImportDestination) -> some View {
        VStack(spacing: 18) {
            Image(systemName: "checkmark.circle.fill").font(.system(size: 52)).foregroundStyle(palette.success)
                .symbolEffect(.bounce, value: destination.target).accessibilityHidden(true)
            targetRow(destination.sessionName, notes: [destination.hostName, directoryTitle(destination.target.cwd)],
                      agent: agent(for: destination.target), selected: false, indicator: false)
                .neuSurface(radius: 14).accessibilityIdentifier("external-import-completed")
        }.frame(maxWidth: .infinity).padding(.top, 16)
    }

    // MARK: Footer

    @ViewBuilder private var footer: some View {
        if let completed = model.completed {
            action(L10n.tr("打开会话"), "bubble.left", id: "external-import-open-session") {
                dismiss()
                onOpenSession(completed.target)
            }
        } else if let batch, route == .main {
            if delivering, let phase = model.phase {
                action(phaseText(phase), nil, id: "external-import-progress", enabled: false) {}
            } else if model.autoSending == batch.id {
                action(L10n.tr("正在连接…"), nil, id: "external-import-progress", enabled: false) {}
            } else {
                switch stage(batch) {
                case .awaitingReceipt, .awaitingLaunch:
                    action(L10n.tr("重新检查"), "arrow.clockwise", id: "external-import-recheck") {
                        model.recheck(batch, via: store.connection(for: batch.destination?.target.hostId ?? batch.launch?.hostId ?? ""))
                    }
                case .compose:
                    if let destination = selectedDestination(batch) {
                        action(L10n.tr("发送到「{0}」", destination.sessionName), "arrow.up", id: "external-import-send") {
                            model.send(batch, to: destination, via: store.connection(for: destination.target.hostId), note: note)
                        }
                    } else {
                        action(L10n.tr("选一个会话"), nil, id: "external-import-send", enabled: false) {}
                    }
                }
            }
        }
    }

    private func selectedDestination(_ batch: ExternalImportBatch) -> ExternalImportDestination? {
        if batch.launch != nil { return batch.destination }
        guard let choice else { return nil }
        return groups.joined().first { $0.id == choice }?.destination
    }

    private func phaseText(_ phase: ExternalImportPhase) -> String {
        switch phase {
        case .uploading(let index, let total): L10n.tr("正在上传 {0}/{1}", index, total)
        case .sending: L10n.tr("正在发送…")
        case .checking: L10n.tr("正在检查…")
        case .launching: L10n.tr("正在创建会话…")
        }
    }

    private func action(_ title: String, _ symbol: String?, id: String, enabled: Bool? = nil,
                        run: @escaping () -> Void) -> some View {
        VStack(spacing: 0) {
            Divider()
            OrbisActionButton(title: title, symbol: symbol) { noteFocused = false; run() }
                .disabled(!(enabled ?? actionable)).accessibilityIdentifier(id)
                .frame(maxWidth: 580).padding(.horizontal, 20).padding(.vertical, 10)
        }
    }

    // MARK: Content

    private func isLink(_ batch: ExternalImportBatch) -> Bool {
        guard batch.files.isEmpty, let text = batch.text?.trimmingCharacters(in: .whitespacesAndNewlines) else { return false }
        return (text.hasPrefix("https://") || text.hasPrefix("http://")) && !text.contains(where: \.isWhitespace)
    }

    private func contentTitle(_ batch: ExternalImportBatch) -> String {
        batch.files.first?.name ?? String((batch.text ?? "").prefix(200))
    }

    private func contentSubtitle(_ batch: ExternalImportBatch) -> String {
        if batch.files.isEmpty { return isLink(batch) ? L10n.tr("链接") : L10n.tr("文字") }
        return L10n.tr("{0} 个文件 · {1}", batch.files.count, byteCount(batch.files.reduce(0) { $0 + $1.bytes }))
    }

    private func contentIcon(_ batch: ExternalImportBatch, size: CGFloat) -> some View {
        Image(systemName: batch.files.isEmpty ? (isLink(batch) ? "link" : "text.alignleft") : "doc.fill")
            .font(.system(size: size * 0.45, weight: .semibold)).foregroundStyle(palette.accent)
            .frame(width: size, height: size)
            .background(palette.accentSoft, in: RoundedRectangle(cornerRadius: size * 0.28, style: .continuous))
            .accessibilityHidden(true)
    }

    private func expandable(_ batch: ExternalImportBatch) -> Bool {
        batch.files.count > 1 || (!batch.files.isEmpty && batch.text != nil) || (batch.files.isEmpty && (batch.text?.count ?? 0) > 90)
    }

    @ViewBuilder private func contentCard(_ batch: ExternalImportBatch) -> some View {
        let canExpand = expandable(batch)
        VStack(alignment: .leading, spacing: 0) {
            OrbisMotionButton(action: { if canExpand { withAnimation(.snappy) { expanded.toggle() } } }) {
                HStack(spacing: 12) {
                    contentIcon(batch, size: 40)
                    VStack(alignment: .leading, spacing: 3) {
                        Text(contentTitle(batch)).font(.orbisBody(.medium)).lineLimit(2).truncationMode(.middle)
                        Text(contentSubtitle(batch)).font(.orbisCaption()).foregroundStyle(palette.secondary)
                    }.frame(maxWidth: .infinity, alignment: .leading)
                    if canExpand {
                        Image(systemName: "chevron.down").font(.orbisCaption(.semibold)).foregroundStyle(palette.faint)
                            .rotationEffect(.degrees(expanded ? 180 : 0)).accessibilityHidden(true)
                    }
                }.padding(14).contentShape(Rectangle()).accessibilityElement(children: .combine)
            }.buttonStyle(.plain).accessibilityIdentifier("external-import-summary")
            if expanded && canExpand {
                Divider().padding(.leading, 66)
                VStack(alignment: .leading, spacing: 10) {
                    ForEach(Array(batch.files.dropFirst().enumerated()), id: \.offset) { _, file in
                        HStack(spacing: 10) {
                            FileNameText(name: file.name).frame(maxWidth: .infinity, alignment: .leading)
                            Text(byteCount(file.bytes)).foregroundStyle(palette.secondary)
                        }.font(.orbisCaption())
                    }
                    if let text = batch.text, !batch.files.isEmpty || text.count > 90 {
                        Text(String(text.prefix(2000)) + (text.count > 2000 ? "…" : ""))
                            .font(.orbisCaption()).foregroundStyle(palette.secondary).textSelection(.enabled)
                    }
                }.padding(.leading, 66).padding(.trailing, 14).padding(.vertical, 12)
            }
        }.neuSurface(radius: 16)
    }

    // MARK: Rows

    private func targetRow(_ title: String, notes: [String?], agent: String?, selected: Bool, indicator: Bool = true) -> some View {
        HStack(spacing: 12) {
            Group {
                if let agent { AgentEmblem(kind: agent, size: 24, recessed: false) }
                else { Image(systemName: "bubble.left").foregroundStyle(palette.accent) }
            }.frame(width: 24).accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 3) {
                Text(title).font(.orbisBody(.medium)).lineLimit(1)
                let line = notes.compactMap { $0 }.joined(separator: " · ")
                if !line.isEmpty { Text(line).font(.orbisCaption()).foregroundStyle(palette.secondary).lineLimit(1) }
            }.frame(maxWidth: .infinity, alignment: .leading)
            if indicator {
                Image(systemName: selected ? "checkmark.circle.fill" : "circle")
                    .font(.system(size: 20, weight: .regular))
                    .foregroundStyle(selected ? palette.accent : palette.faint.opacity(0.55))
                    .accessibilityHidden(true)
            }
        }
        .padding(.horizontal, 14).padding(.vertical, 10).frame(minHeight: 60)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }

    private func agent(for target: ExternalImportTarget) -> String? {
        guard let connection = store.connection(for: target.hostId),
              let runtime = connection.runtimes.first(where: { $0.sessionId == target.sessionId }) else { return nil }
        return connection.agentKind(runtime)
    }

    private func statusLine(_ batch: ExternalImportBatch) -> String {
        if let destination = batch.destination {
            switch batch.attempt?.receipt {
            case .failed: return L10n.tr("{0} · {1}", L10n.tr("发送失败"), destination.sessionName)
            case .pending, .unknown, .unconfirmed: return L10n.tr("{0} · {1}", L10n.tr("未确认"), destination.sessionName)
            default: return L10n.tr("{0} · {1}", L10n.tr("未发送"), destination.sessionName)
            }
        }
        if let launch = batch.launch {
            return launch.failed ? L10n.tr("新会话没有启动") : L10n.tr("{0} · {1}", L10n.tr("新会话未确认"), launch.hostName)
        }
        return contentSubtitle(batch)
    }

    private func statusIsError(_ batch: ExternalImportBatch) -> Bool {
        batch.attempt?.receipt == .failed || (batch.destination == nil && batch.launch?.failed == true)
    }

    private func heading(_ title: String) -> some View {
        Text(title).font(.orbisLabel()).foregroundStyle(palette.secondary).padding(.leading, 4).accessibilityAddTraits(.isHeader)
    }

    private func status(_ text: String) -> some View {
        Label(text, systemImage: "clock").font(.orbisBody()).foregroundStyle(palette.secondary)
    }

    private func confirmDelete(_ batch: ExternalImportBatch) {
        noteFocused = false
        overlay.showDialog(L10n.tr("删除这条内容？"), actions: [
            OrbisDialogAction(title: L10n.tr("取消"), role: .cancel),
            OrbisDialogAction(title: L10n.tr("删除"), role: .destructive) { model.delete(batch.id) }
        ])
    }
}
