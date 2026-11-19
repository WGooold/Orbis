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
    @FocusState private var textFocused: Bool

    private var canSave: Bool {
        guard let prepared = model.prepared, !model.saving else { return false }
        return !prepared.files.isEmpty || !model.text.allSatisfy(\.isWhitespace)
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Spacer()
                Button {
                    model.cancel()
                } label: {
                    Image(systemName: "xmark.circle.fill").font(.title2).symbolRenderingMode(.hierarchical)
                        .foregroundStyle(.secondary).frame(width: 48, height: 48)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain).accessibilityLabel(L10n.tr("取消")).disabled(model.saving)
            }.padding(.horizontal, 12)

            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    Label("Orbis", systemImage: "tray.and.arrow.down.fill")
                        .font(.subheadline.weight(.semibold)).foregroundStyle(.secondary)
                    Text(L10n.tr("分享内容")).font(.largeTitle.bold()).accessibilityAddTraits(.isHeader)
                    if model.loading { ProgressView(L10n.tr("正在读取…")) }
                    if let problem = model.problem {
                        Label(importProblemText(problem), systemImage: "exclamationmark.circle")
                            .font(.subheadline).foregroundStyle(.red)
                    }
                    if let prepared = model.prepared {
                        if !prepared.files.isEmpty {
                            VStack(alignment: .leading, spacing: 8) {
                                heading(L10n.tr("{0} 个文件", prepared.files.count))
                                VStack(spacing: 0) {
                                    ForEach(Array(prepared.files.enumerated()), id: \.offset) { index, file in
                                        if index > 0 { Divider().padding(.leading, 44) }
                                        HStack(spacing: 12) {
                                            Image(systemName: "doc").foregroundStyle(.tint).accessibilityHidden(true)
                                            VStack(alignment: .leading, spacing: 3) {
                                                Text(file.name).font(.body.weight(.medium)).lineLimit(2).truncationMode(.middle)
                                                Text(ByteCountFormatter.string(fromByteCount: file.bytes, countStyle: .file))
                                                    .font(.caption).foregroundStyle(.secondary)
                                            }.frame(maxWidth: .infinity, alignment: .leading)
                                        }.padding(14).accessibilityElement(children: .combine)
                                    }
                                }.background(.background, in: RoundedRectangle(cornerRadius: 16))
                            }
                        }
                        if prepared.text != nil {
                            VStack(alignment: .leading, spacing: 8) {
                                heading(L10n.tr("分享文字"))
                                TextField(L10n.tr("分享文字"), text: $model.text, axis: .vertical)
                                    .lineLimit(3...9).focused($textFocused).disabled(model.saving)
                                    .padding(14).background(.background, in: RoundedRectangle(cornerRadius: 16))
                            }
                        }
                    }
                }
                .frame(maxWidth: 540, alignment: .leading).padding(.horizontal, 24).padding(.bottom, 20)
                .frame(maxWidth: .infinity, alignment: .top)
            }.scrollDismissesKeyboard(.interactively)

            if model.prepared != nil {
                Divider()
                VStack(spacing: 8) {
                    Button {
                        textFocused = false
                        model.save()
                    } label: {
                        Group {
                            if model.saving { ProgressView().tint(.white).accessibilityLabel(L10n.tr("正在处理导入…")) }
                            else { Label(L10n.tr("存入 Orbis"), systemImage: "tray.and.arrow.down") }
                        }.frame(maxWidth: .infinity, minHeight: 44)
                    }
                    .buttonStyle(.borderedProminent).buttonBorderShape(.roundedRectangle(radius: 14))
                    .disabled(!canSave).accessibilityIdentifier("share-save-to-orbis")
                    Label(L10n.tr("仅保存到此设备"), systemImage: "lock").font(.caption).foregroundStyle(.secondary)
                }.frame(maxWidth: 540).padding(.horizontal, 24).padding(.vertical, 12)
                .frame(maxWidth: .infinity)
            }
        }
        .background(Color(uiColor: .systemGroupedBackground).ignoresSafeArea())
        .interactiveDismissDisabled(model.saving)
        .onDisappear { model.abandon() }
        .environment(\.locale, L10n.locale)
    }

    private func heading(_ title: String) -> some View {
        Text(title).font(.subheadline.weight(.semibold)).foregroundStyle(.secondary).accessibilityAddTraits(.isHeader)
    }
}
