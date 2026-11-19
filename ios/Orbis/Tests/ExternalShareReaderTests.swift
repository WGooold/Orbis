import Foundation
import Testing
import UniformTypeIdentifiers
@testable import OrbisCore

@Suite("OI-03 share provider handoff")
struct ExternalShareReaderTests {
    // Share-provider data is transient; it must be copied before publishing, and cancelling must not publish it.
    @Test func copiesProviderFileBeforeExplicitSave() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let source = root.appendingPathComponent("original.pdf")
        let bytes = Data("synthetic document".utf8)
        try bytes.write(to: source)
        let provider = NSItemProvider()
        provider.suggestedName = "memo.pdf"
        provider.registerFileRepresentation(forTypeIdentifier: UTType.pdf.identifier, fileOptions: [], visibility: .all) { completion in
            completion(source, false, nil)
            return nil
        }
        let item = NSExtensionItem()
        item.attributedContentText = NSAttributedString(string: "original caption")
        item.attachments = [provider]
        let inbox = root.appendingPathComponent("inbox")
        let store = ExternalImportStore(root: inbox)
        let prepared = try await ExternalShareReader.prepare([item], store: store)
        defer { prepared.discard() }
        #expect(prepared.text == "original caption")
        #expect(try store.list().isEmpty)
        try FileManager.default.removeItem(at: source)
        let batch = try prepared.save(text: "edited caption")
        #expect(batch.text == "edited caption")
        #expect(batch.files == [.init(name: "memo.pdf", bytes: Int64(bytes.count))])
        #expect(try Data(contentsOf: inbox.appendingPathComponent("ready-\(batch.id.uuidString)/file-0")) == bytes)
    }

    @Test func discardsWholeStageWhenAnItemCannotBeRead() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let store = ExternalImportStore(root: root)
        let item = NSExtensionItem()
        item.attributedContentText = NSAttributedString(string: "do not publish part of this batch")
        item.attachments = [NSItemProvider()]
        await #expect(throws: ExternalImportProblem.unsupported) {
            _ = try await ExternalShareReader.prepare([item], store: store)
        }
        #expect(try store.list().isEmpty)
        #expect(try FileManager.default.contentsOfDirectory(atPath: root.path) == [".lock"])
    }
}
