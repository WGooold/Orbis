import Foundation
import UniformTypeIdentifiers

struct ExternalSharePrepared: Sendable {
    let store: ExternalImportStore
    let stage: ExternalImportStage
    let text: String?
    let files: [ExternalImportedFile]

    func save(text: String) throws -> ExternalImportBatch {
        try store.publish(stage, text: text, files: files)
    }

    func discard() { store.discard(stage) }
}

/// Resolve providers off Main. Temporary file representations are copied synchronously
/// *inside* their completion callback, before the system deletes the file.
enum ExternalShareReader {
    private enum Piece { case file(ExternalImportedFile), text(String) }

    static func prepare(_ items: [NSExtensionItem], store: ExternalImportStore) async throws -> ExternalSharePrepared {
        guard items.count <= ExternalImportStore.fileCount * 2 else { throw ExternalImportProblem.limit }
        try Task.checkCancellation()
        let stage = try store.begin()
        do {
            var files: [ExternalImportedFile] = [], text: [String] = [], bytes: Int64 = 0, textBytes = 0, providers = 0
            func append(_ raw: String?) throws {
                guard let value = try ExternalImportStore.checkedText(raw), !text.contains(value) else { return }
                textBytes += value.utf8.count + (text.isEmpty ? 0 : 2)
                guard textBytes <= ExternalImportStore.textBytes else { throw ExternalImportProblem.limit }
                text.append(value)
            }
            for item in items {
                try append(item.attributedContentText?.string)
                for provider in item.attachments ?? [] {
                    try Task.checkCancellation()
                    providers += 1
                    guard providers <= ExternalImportStore.fileCount * 2 else { throw ExternalImportProblem.limit }
                    guard let kind = ExternalShareRepresentation.choose(provider.registeredTypeIdentifiers, suggestedName: provider.suggestedName) else {
                        throw ExternalImportProblem.unsupported
                    }
                    switch try await read(kind, provider: provider, store: store, stage: stage, index: files.count, used: bytes) {
                    case .file(let file): bytes += file.bytes; files.append(file)
                    case .text(let value): try append(value)
                    }
                }
            }
            try Task.checkCancellation()
            guard !text.isEmpty || !files.isEmpty else { throw ExternalImportProblem.empty }
            return ExternalSharePrepared(store: store, stage: stage, text: text.isEmpty ? nil : text.joined(separator: "\n\n"), files: files)
        } catch {
            store.discard(stage)
            throw error
        }
    }

    private static func read(_ kind: ExternalShareRepresentation, provider: NSItemProvider, store: ExternalImportStore,
                             stage: ExternalImportStage, index: Int, used: Int64) async throws -> Piece {
        switch kind {
        case .file(let type):
            let suggestedName = provider.suggestedName
            return try await withCheckedThrowingContinuation { continuation in
                _ = provider.loadFileRepresentation(forTypeIdentifier: type) { url, error in
                    continuation.resume(with: Result {
                        if let error { throw error }
                        guard let url else { throw ExternalImportProblem.unreadable }
                        let name = fileName(suggestedName, url: url, type: type)
                        return .file(try store.copy(url, name: name, into: stage, index: index, used: used))
                    })
                }
            }
        case .fileURL, .link:
            let suggestedName = provider.suggestedName
            return try await withCheckedThrowingContinuation { continuation in
                _ = provider.loadObject(ofClass: NSURL.self) { value, error in
                    continuation.resume(with: Result {
                        if let error { throw error }
                        guard let value = value as? URL else { throw ExternalImportProblem.unreadable }
                        if value.isFileURL {
                            let name = fileName(suggestedName, url: value, type: UTType.fileURL.identifier)
                            return .file(try store.copyOpenedDocument(value, name: name, into: stage, index: index, used: used))
                        }
                        guard kind == .link, ["http", "https"].contains(value.scheme?.lowercased() ?? "") else {
                            throw ExternalImportProblem.unsupported
                        }
                        return .text(value.absoluteString)
                    })
                }
            }
        case .text:
            return try await withCheckedThrowingContinuation { continuation in
                _ = provider.loadObject(ofClass: NSString.self) { value, error in
                    if let error { continuation.resume(throwing: error) }
                    else if let value = value as? String { continuation.resume(returning: .text(value)) }
                    else { continuation.resume(throwing: ExternalImportProblem.unreadable) }
                }
            }
        }
    }

    private static func fileName(_ suggested: String?, url: URL, type: String) -> String {
        guard let suggested, !suggested.isEmpty else { return url.lastPathComponent }
        let name = ExternalImportStore.displayName(suggested)
        guard (name as NSString).pathExtension.isEmpty else { return name }
        let ext = url.pathExtension.isEmpty ? UTType(type)?.preferredFilenameExtension : url.pathExtension
        return ext.map { name + "." + $0 } ?? name
    }
}
