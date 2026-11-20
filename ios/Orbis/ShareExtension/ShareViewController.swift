import SwiftUI
import UIKit
import UserNotifications

/// This extension stages, saves or binds local imports. It never starts Orbis or contacts a Host:
/// Send records the request and Orbis performs it, with its own checks, on its next foreground.
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
    @Published var note = ""
    @Published var selected: ExternalImportTarget?
    @Published private(set) var prepared: ExternalSharePrepared?
    @Published private(set) var groups: [[ExternalImportChoice]] = []
    @Published private(set) var recent: ExternalImportTarget?
    @Published private(set) var loading = true
    @Published private(set) var saving = false
    @Published private(set) var problem: ExternalImportProblem?
    private weak var context: NSExtensionContext?
    private var task: Task<ExternalSharePrepared, Error>?
    private var closed = false

    init(context: NSExtensionContext?) { self.context = context }

    var choice: ExternalImportChoice? { groups.joined().first { $0.id == selected } }

    func load() {
        guard let items = context?.inputItems as? [NSExtensionItem], !items.isEmpty else {
            loading = false; problem = .empty; return
        }
        Task {
            let snapshot = await Task.detached(priority: .userInitiated) { try? ExternalImportStore.applicationInbox().loadTargets() }.value
            if let snapshot {
                groups = ExternalImportChoice.ordered(snapshot.choices, recent: snapshot.recent)
                recent = snapshot.recent
            }
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
            case .success(let value): self.prepared = value
            case .failure(let error): self.problem = error as? ExternalImportProblem ?? .unreadable
            }
        }
    }

    /// `send` binds the chosen Session and leaves a one-time request; otherwise the content only waits in Orbis.
    func save(send: Bool) {
        guard !saving, !closed, let prepared else { return }
        let request = send ? choice.map { (destination: $0.destination, at: Date()) } : nil
        guard !send || request != nil else { return }
        saving = true; problem = nil
        let note = note
        Task {
            let result = await Task.detached(priority: .userInitiated) {
                Result { try prepared.save(text: prepared.text, note: note, request: request) }
            }.value
            switch result {
            case .success:
                if let destination = request?.destination { await Self.remind(destination) }
                saving = false; closed = true; self.prepared = nil
                context?.completeRequest(returningItems: nil)
            case .failure(let error):
                saving = false
                problem = error as? ExternalImportProblem ?? .unreadable
            }
        }
    }

    /// The only public path back to Orbis: a local notification the user can tap.
    private static func remind(_ destination: ExternalImportDestination) async {
        let center = UNUserNotificationCenter.current()
        let settings = await center.notificationSettings()
        guard [.authorized, .provisional, .ephemeral].contains(settings.authorizationStatus) else { return }
        let content = UNMutableNotificationContent()
        content.body = L10n.tr("轻点完成发送到「{0}」", destination.sessionName)
        content.threadIdentifier = "external-import"
        try? await center.add(UNNotificationRequest(identifier: "external-import-" + UUID().uuidString, content: content, trigger: nil))
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
    @FocusState private var noteFocused: Bool
    @State private var expanded = false

    var body: some View {
        VStack(spacing: 0) {
            ZStack {
                Text(L10n.tr("发送到 Orbis")).font(.headline).accessibilityAddTraits(.isHeader)
                HStack {
                    Button { model.cancel() } label: {
                        Image(systemName: "xmark").font(.body.weight(.semibold)).foregroundStyle(.secondary)
                            .frame(width: 44, height: 44).contentShape(Rectangle())
                    }
                    .buttonStyle(.plain).accessibilityLabel(L10n.tr("取消")).disabled(model.saving)
                    Spacer()
                }
            }.padding(.horizontal, 8).padding(.top, 6)

            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    if model.loading { ProgressView().frame(maxWidth: .infinity).padding(.vertical, 24) }
                    if let problem = model.problem {
                        Label(importProblemText(problem), systemImage: "exclamationmark.circle")
                            .font(.subheadline).foregroundStyle(.red)
                    }
                    if let prepared = model.prepared {
                        content(prepared)
                        TextField(L10n.tr("添加说明…"), text: $model.note, axis: .vertical)
                            .lineLimit(1...4).focused($noteFocused).disabled(model.saving)
                            .padding(.horizontal, 14).padding(.vertical, 12)
                            .background(Color(uiColor: .secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 12))
                        targets
                    }
                }
                .frame(maxWidth: 540, alignment: .leading).padding(.horizontal, 20).padding(.vertical, 12)
                .frame(maxWidth: .infinity, alignment: .top)
            }.scrollDismissesKeyboard(.interactively)

            if model.prepared != nil { footer }
        }
        .background(Color(uiColor: .systemGroupedBackground).ignoresSafeArea())
        .interactiveDismissDisabled(model.saving)
        .onDisappear { model.abandon() }
        .environment(\.locale, L10n.locale)
    }

    @ViewBuilder private func content(_ prepared: ExternalSharePrepared) -> some View {
        let bytes = prepared.files.reduce(0) { $0 + $1.bytes }
        let canExpand = prepared.files.count > 1 || (!prepared.files.isEmpty && prepared.text != nil)
            || (prepared.files.isEmpty && (prepared.text?.count ?? 0) > 90)
        VStack(alignment: .leading, spacing: 0) {
            Button { withAnimation(.snappy) { expanded.toggle() } } label: {
                HStack(spacing: 12) {
                    Image(systemName: prepared.files.isEmpty ? "text.alignleft" : "doc.fill")
                        .font(.title3).foregroundStyle(.tint).frame(width: 40, height: 40)
                        .background(Color.accentColor.opacity(0.12), in: RoundedRectangle(cornerRadius: 10))
                    VStack(alignment: .leading, spacing: 2) {
                        Text(prepared.files.first?.name ?? prepared.text ?? "").font(.body.weight(.medium))
                            .lineLimit(2).truncationMode(.middle).foregroundStyle(.primary)
                        Text(prepared.files.isEmpty ? L10n.tr("文字")
                             : L10n.tr("{0} 个文件 · {1}", prepared.files.count, ByteCountFormatter.string(fromByteCount: bytes, countStyle: .file)))
                            .font(.caption).foregroundStyle(.secondary)
                    }.frame(maxWidth: .infinity, alignment: .leading)
                    if canExpand {
                        Image(systemName: "chevron.down").font(.caption.weight(.semibold)).foregroundStyle(.tertiary)
                            .rotationEffect(.degrees(expanded ? 180 : 0))
                    }
                }.padding(12).contentShape(Rectangle())
            }.buttonStyle(.plain).accessibilityElement(children: .combine)
            if expanded && canExpand {
                Divider().padding(.leading, 64)
                VStack(alignment: .leading, spacing: 8) {
                    ForEach(Array(prepared.files.dropFirst().enumerated()), id: \.offset) { _, file in
                        HStack {
                            Text(file.name).lineLimit(1).truncationMode(.middle)
                            Spacer()
                            Text(ByteCountFormatter.string(fromByteCount: file.bytes, countStyle: .file)).foregroundStyle(.secondary)
                        }.font(.subheadline)
                    }
                    if let text = prepared.text, !prepared.files.isEmpty || text.count > 90 {
                        Text(String(text.prefix(2000))).font(.subheadline).foregroundStyle(.secondary).lineLimit(12)
                    }
                }.padding(.leading, 64).padding([.trailing, .bottom], 12).padding(.top, 8)
            }
        }
        .background(Color(uiColor: .secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 14))
    }

    @ViewBuilder private var targets: some View {
        ForEach(model.groups, id: \.first?.id) { group in
            if let first = group.first {
                VStack(alignment: .leading, spacing: 8) {
                    Text(first.destination.hostName).font(.footnote.weight(.semibold)).foregroundStyle(.secondary)
                        .padding(.leading, 4).accessibilityAddTraits(.isHeader)
                    VStack(spacing: 0) {
                        ForEach(group) { choice in
                            if choice.id != first.id { Divider().padding(.leading, 16) }
                            targetRow(choice)
                        }
                    }.background(Color(uiColor: .secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 14))
                }
            }
        }
    }

    private func targetRow(_ choice: ExternalImportChoice) -> some View {
        let selected = model.selected == choice.id
        let notes = [projectName(choice.destination.target.cwd), choice.running ? L10n.tr("运行中") : nil,
                     choice.id == model.recent ? L10n.tr("最近使用") : nil].compactMap { $0 }
        return Button {
            noteFocused = false
            model.selected = selected ? nil : choice.id
        } label: {
            HStack(spacing: 12) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(choice.destination.sessionName).font(.body).lineLimit(1).foregroundStyle(.primary)
                    Text(notes.joined(separator: " · ")).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                }.frame(maxWidth: .infinity, alignment: .leading)
                Image(systemName: selected ? "checkmark.circle.fill" : "circle")
                    .font(.title3).foregroundStyle(selected ? AnyShapeStyle(.tint) : AnyShapeStyle(.quaternary))
            }.padding(.horizontal, 16).padding(.vertical, 11).frame(minHeight: 52).contentShape(Rectangle())
        }
        .buttonStyle(.plain).disabled(model.saving)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }

    @ViewBuilder private var footer: some View {
        VStack(spacing: 4) {
            if !model.groups.isEmpty {
                Button { noteFocused = false; model.save(send: true) } label: {
                    Group {
                        if model.saving { ProgressView().tint(.white) }
                        else { Text(model.choice.map { L10n.tr("发送到「{0}」", $0.destination.sessionName) } ?? L10n.tr("选择会话")).lineLimit(1) }
                    }.font(.body.weight(.semibold)).frame(maxWidth: .infinity, minHeight: 50)
                }
                .buttonStyle(.borderedProminent).buttonBorderShape(.roundedRectangle(radius: 14))
                .disabled(model.choice == nil || model.saving).accessibilityIdentifier("share-send")
            }
            Button { noteFocused = false; model.save(send: false) } label: {
                Text(L10n.tr("先存入 Orbis")).font(.body.weight(model.groups.isEmpty ? .semibold : .regular))
                    .frame(maxWidth: .infinity, minHeight: 44)
            }
            .buttonStyle(.borderless).disabled(model.saving).accessibilityIdentifier("share-save-to-orbis")
        }
        .frame(maxWidth: 540).padding(.horizontal, 20).padding(.top, 10).padding(.bottom, 6)
        .frame(maxWidth: .infinity)
        .background(.bar)
    }

    private func projectName(_ cwd: String) -> String {
        let trimmed = cwd.trimmingCharacters(in: CharacterSet(charactersIn: "/\\"))
        return trimmed.split(whereSeparator: { $0 == "/" || $0 == "\\" }).last.map(String.init) ?? cwd
    }
}
