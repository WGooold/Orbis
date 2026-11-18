import SwiftUI

@MainActor final class ExternalImportInboxModel: ObservableObject {
    @Published private(set) var batches: [ExternalImportBatch] = []
    @Published private(set) var selected: UUID?
    @Published private(set) var problem: ExternalImportProblem?
    @Published private(set) var busy = false
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

    func openDocument(_ url: URL) {
        guard !busy else { isOpen = true; problem = .busy; return }
        selected = nil; problem = nil; isOpen = true
        perform {
            let store = try ExternalImportStore.applicationInbox()
            return try store.importDocument(url).id
        }
    }

    func delete(_ id: UUID) {
        guard !busy else { return }
        problem = nil
        perform { try ExternalImportStore.applicationInbox().delete(id); return nil }
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

    private var selected: ExternalImportBatch? { model.batches.first { $0.id == model.selected } }
    var body: some View {
        VStack(spacing: 0) {
            OrbisPageHeader(title: L10n.tr("待导入"), closes: true, back: { dismiss() }) {
                if selected != nil {
                    OrbisIconButton(symbol: "chevron.left", label: L10n.tr("返回")) { model.select(nil) }
                }
            }
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    if let problem = model.problem { OrbisNotice(text: importProblemText(problem), error: true) }
                    if model.busy { ProgressView(L10n.tr("正在处理导入…")) }
                    if let selected { detail(selected) }
                    else if model.batches.isEmpty && !model.busy && model.problem == nil {
                        Text(L10n.tr("暂无待导入内容")).font(.orbisBody())
                    } else {
                        ForEach(model.batches) { batch in
                            OrbisMotionButton { model.select(batch.id) } label: {
                                VStack(alignment: .leading, spacing: 4) {
                                    Text(batch.files.first?.name ?? String((batch.text ?? "").prefix(120))).font(.orbisBody()).lineLimit(2)
                                    if !batch.files.isEmpty { Text(L10n.tr("{0} 个文件", batch.files.count)).font(.orbisCaption()) }
                                }.frame(maxWidth: .infinity, alignment: .leading).padding(16)
                            }.buttonStyle(NeuButtonStyle())
                        }
                    }
                }.frame(maxWidth: .infinity, alignment: .leading).padding(20)
            }
        }.accessibilityIdentifier("external-import-sheet")
    }
    private func detail(_ batch: ExternalImportBatch) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            ForEach(Array(batch.files.enumerated()), id: \.offset) { _, file in
                VStack(alignment: .leading, spacing: 4) {
                    Text(file.name).font(.orbisBody())
                    Text(byteCount(file.bytes)).font(.orbisCaption())
                }
            }
            if let body = batch.text {
                Text(body.count > 2000 ? String(body.prefix(2000)) + "…" : body).font(.orbisBody()).textSelection(.enabled)
            }
            Button(L10n.tr("删除")) {
                overlay.showDialog(L10n.tr("删除待导入内容？"), actions: [
                    OrbisDialogAction(title: L10n.tr("取消"), role: .cancel),
                    OrbisDialogAction(title: L10n.tr("删除"), role: .destructive) { model.delete(batch.id) }
                ])
            }.font(.orbisLabel()).foregroundStyle(OrbisPalette(scheme).error).disabled(model.busy)
        }
    }
}

func importProblemText(_ problem: ExternalImportProblem) -> String {
    switch problem {
    case .empty: L10n.tr("没有可导入的内容")
    case .unsupported: L10n.tr("不支持此分享内容")
    case .limit: L10n.tr("导入内容超过大小或数量上限")
    case .full: L10n.tr("待导入空间已满")
    case .busy: L10n.tr("已有导入正在进行，请稍后重试")
    case .unreadable: L10n.tr("无法读取导入内容")
    }
}
