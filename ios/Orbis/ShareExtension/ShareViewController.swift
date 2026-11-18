import SwiftUI
import UIKit

/// This extension only stages and saves local imports. It never starts Orbis or contacts a Host.
final class ShareViewController: UIViewController {
    private var model: ShareImportModel?

    override func viewDidLoad() {
        super.viewDidLoad()
        AppLocalization.shared.configure()
        let model = ShareImportModel(context: extensionContext)
        self.model = model
        let host = UIHostingController(rootView: ShareImportPanel(model: model))
        addChild(host)
        host.view.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(host.view)
        NSLayoutConstraint.activate([
            host.view.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            host.view.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            host.view.topAnchor.constraint(equalTo: view.topAnchor),
            host.view.bottomAnchor.constraint(equalTo: view.bottomAnchor)
        ])
        host.didMove(toParent: self)
        model.load()
    }

    override func viewDidDisappear(_ animated: Bool) {
        super.viewDidDisappear(animated)
        if isBeingDismissed || isMovingFromParent { model?.abandon() }
    }
}

@MainActor private final class ShareImportModel: ObservableObject {
    @Published var text = ""
    @Published private(set) var prepared: ExternalSharePrepared?
    @Published private(set) var loading = true
    @Published private(set) var saving = false
    @Published private(set) var problem: ExternalImportProblem?
    private weak var context: NSExtensionContext?
    private var task: Task<ExternalSharePrepared, Error>?
    private var closed = false

    init(context: NSExtensionContext?) { self.context = context }

    func load() {
        guard let items = context?.inputItems as? [NSExtensionItem], !items.isEmpty else {
            loading = false; problem = .empty; return
        }
        let worker = Task.detached(priority: .userInitiated) {
            try await ExternalShareReader.prepare(items, store: ExternalImportStore.applicationInbox())
        }
        task = worker
        Task { [weak self] in
            let outcome = await worker.result
            guard let self, !self.closed else {
                if case .success(let value) = outcome { await Task.detached { value.discard() }.value }
                return
            }
            self.task = nil; self.loading = false
            switch outcome {
            case .success(let value): self.prepared = value; self.text = value.text ?? ""
            case .failure(let error): self.problem = error as? ExternalImportProblem ?? .unreadable
            }
        }
    }

    func save() {
        guard !saving, !closed, let prepared else { return }
        saving = true; problem = nil
        let body = text
        Task {
            let result = await Task.detached(priority: .userInitiated) { Result { try prepared.save(text: body) } }.value
            saving = false
            switch result {
            case .success:
                closed = true; self.prepared = nil
                context?.completeRequest(returningItems: nil)
            case .failure(let error): problem = error as? ExternalImportProblem ?? .unreadable
            }
        }
    }

    func cancel() {
        guard !saving, !closed else { return }
        abandon()
        context?.cancelRequest(withError: CocoaError(.userCancelled))
    }

    func abandon() {
        guard !closed, !saving else { return }
        closed = true
        task?.cancel(); task = nil
        if let prepared {
            self.prepared = nil
            Task.detached { prepared.discard() }
        }
    }
}

private struct ShareImportPanel: View {
    @ObservedObject var model: ShareImportModel

    var body: some View {
        NavigationStack {
            Form {
                if model.loading { ProgressView(L10n.tr("正在读取…")) }
                if let problem = model.problem { Text(importProblemText(problem)).foregroundStyle(.red) }
                if let prepared = model.prepared {
                    if !prepared.files.isEmpty {
                        Section {
                            ForEach(Array(prepared.files.enumerated()), id: \.offset) { _, file in
                                LabeledContent {
                                    Text(ByteCountFormatter.string(fromByteCount: file.bytes, countStyle: .file))
                                } label: {
                                    Label { Text(file.name) } icon: { Image(systemName: "doc") }
                                }
                            }
                        }
                    }
                    if prepared.text != nil {
                        TextField(L10n.tr("分享文字"), text: $model.text, axis: .vertical)
                            .lineLimit(3...8).disabled(model.saving)
                    }
                }
                if model.saving { ProgressView(L10n.tr("正在处理导入…")) }
            }
            .navigationTitle("Orbis")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(L10n.tr("取消"), action: model.cancel).disabled(model.saving)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(L10n.tr("存入 Orbis"), action: model.save).fontWeight(.semibold)
                        .disabled(model.prepared == nil || model.saving || (model.prepared?.files.isEmpty == true && model.text.allSatisfy(\.isWhitespace)))
                        .accessibilityIdentifier("share-save-to-orbis")
                }
            }
        }
        .interactiveDismissDisabled(model.saving)
        .onDisappear { model.abandon() }
        .environment(\.locale, L10n.locale)
    }
}
