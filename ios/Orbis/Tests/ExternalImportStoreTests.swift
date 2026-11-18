import Foundation
import Testing
@testable import OrbisCore

@Suite("OI-02 external document intake")
struct ExternalImportStoreTests {
    private func withRoot(_ run: (URL, URL) throws -> Void) throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        try run(directory, directory.appendingPathComponent("inbox", isDirectory: true))
    }

    // File-provider URLs are not durable. After the source vanishes our own copy must still be readable.
    @Test func copiesThenReopensWithoutOriginalDocument() throws {
        try withRoot { directory, inbox in
            let original = directory.appendingPathComponent("报价单.xlsx")
            let payload = Data([0, 1, 2, 3])
            try payload.write(to: original)
            let batch = try ExternalImportStore(root: inbox).importDocument(original)
            try FileManager.default.removeItem(at: original)
            let reopened = ExternalImportStore(root: inbox)
            #expect(try reopened.list() == [batch])
            #expect(batch.files == [.init(name: "报价单.xlsx", bytes: 4)])
            #expect(try Data(contentsOf: inbox.appendingPathComponent("ready-\(batch.id.uuidString)/file-0")) == payload)
            try reopened.delete(batch.id)
            #expect(try reopened.list().isEmpty)
        }
    }

    // The app and extension can stage concurrently; only unowned staging is reclaimable.
    @Test func doesNotCleanOtherProducerAndNeverListsIncompleteBatch() throws {
        try withRoot { directory, inbox in
            let store = ExternalImportStore(root: inbox)
            let first = try store.begin()
            var abandoned: ExternalImportStage? = try store.begin()
            let orphan = try #require(abandoned?.id)
            #expect(throws: ExternalImportProblem.busy) { _ = try store.begin() }
            #expect(try store.list().isEmpty)
            abandoned = nil
            let next = try store.begin()
            #expect(!FileManager.default.fileExists(atPath: inbox.appendingPathComponent("stage-\(orphan.uuidString)").path))
            let original = directory.appendingPathComponent("a.txt")
            try Data("data".utf8).write(to: original)
            let firstFile = try store.copy(original, name: "../path/\u{202e}a.txt", into: first, index: 0, used: 0)
            let batch = try store.publish(first, text: "https://example.test/file", files: [firstFile])
            #expect(batch.files.first?.name == "a.txt")
            #expect(try store.list() == [batch])
            store.discard(next)
        }
    }

    @Test func refusesNonFilesAndFalseMetadata() throws {
        try withRoot { directory, inbox in
            let store = ExternalImportStore(root: inbox)
            let original = directory.appendingPathComponent("a.txt")
            let link = directory.appendingPathComponent("b.txt")
            try Data("data".utf8).write(to: original)
            try FileManager.default.createSymbolicLink(at: link, withDestinationURL: original)
            let stage = try store.begin()
            defer { store.discard(stage) }
            #expect(throws: ExternalImportProblem.unsupported) {
                _ = try store.copy(URL(string: "https://example.test/a.txt")!, into: stage, index: 0, used: 0)
            }
            for invalid in [directory, link] {
                #expect(throws: ExternalImportProblem.unreadable) { _ = try store.copy(invalid, into: stage, index: 0, used: 0) }
            }
            _ = try store.copy(original, into: stage, index: 0, used: 0)
            #expect(throws: ExternalImportProblem.unreadable) {
                _ = try store.publish(stage, text: nil, files: [.init(name: "a.txt", bytes: 3)])
            }
            #expect(try store.list().isEmpty)
        }
    }

    @Test func enforcesCumulativeBytesAndTextBudget() throws {
        try withRoot { directory, inbox in
            let store = ExternalImportStore(root: inbox, batchBytes: 6, inboxBytes: 8)
            let original = directory.appendingPathComponent("a.txt")
            try Data("data".utf8).write(to: original)
            let first = try store.importDocument(original)
            let stage = try store.begin()
            defer { store.discard(stage) }
            #expect(throws: ExternalImportProblem.limit) { _ = try store.copy(original, into: stage, index: 0, used: 3) }
            #expect(throws: ExternalImportProblem.limit) { _ = try store.publish(stage, text: String(repeating: "界", count: 100_000), files: []) }
            #expect(throws: ExternalImportProblem.full) { _ = try store.publish(stage, text: "12345", files: []) }
            #expect(try store.list() == [first])
        }
    }
}
