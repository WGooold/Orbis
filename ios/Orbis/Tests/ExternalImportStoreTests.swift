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

    // An import draft has one persistent owner, even when both hosts use the same session ID.
    @Test func assignsWholeBatchOnceAndRestoresTheInboxItem() throws {
        try withRoot { directory, inbox in
            let store = ExternalImportStore(root: inbox)
            let source = directory.appendingPathComponent("report.pdf")
            let bytes = Data([0, 2, 3])
            try bytes.write(to: source)
            let batch = try store.importDocument(source)
            let target = ExternalImportTarget(hostId: "a", pairingKey: "pair-a", sessionId: "same", cwd: "/work")
            let other = ExternalImportTarget(hostId: "b", pairingKey: "pair-b", sessionId: "same", cwd: "/work")
            let destination = ExternalImportDestination(target: target, hostName: "Computer A", sessionName: "Report")
            let assigned = try store.assign(batch.id, to: destination)
            let reopened = ExternalImportStore(root: inbox)
            #expect(assigned.destination == destination)
            #expect(try reopened.list() == [assigned])
            #expect(try reopened.assign(batch.id, to: destination) == assigned)
            #expect(throws: ExternalImportProblem.alreadyAssigned) {
                _ = try reopened.assign(batch.id, to: .init(target: other, hostName: "Computer B", sessionName: "Report"))
            }
            #expect(throws: ExternalImportProblem.targetUnavailable) { _ = try reopened.unassign(batch.id, from: other) }
            #expect(try reopened.unassign(batch.id, from: target) == batch)
            #expect(try Data(contentsOf: inbox.appendingPathComponent("ready-\(batch.id.uuidString)/file-0")) == bytes)
        }
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

    // OI-08: only a Session-confirmed receipt hands a batch over; ambiguous or failed sends must stay recoverable.
    @Test func onlyAcceptedBatchesLeaveTheInbox() throws {
        try withRoot { _, inbox in
            let store = ExternalImportStore(root: inbox)
            let target = ExternalImportTarget(hostId: "a", pairingKey: "pair-a", sessionId: "s", cwd: "/work")
            var byReceipt: [ExternalImportReceipt: UUID] = [:]
            for receipt in [ExternalImportReceipt.pending, .accepted, .failed, .unconfirmed, .unknown] {
                let batch = try store.publish(try store.begin(), text: "body \(receipt)", files: [])
                _ = try store.assign(batch.id, to: .init(target: target, hostName: "Computer A", sessionName: "Session"))
                let attempt = ExternalImportAttempt(id: UUID(), runtimeId: "r", receipt: .pending)
                try store.beginDelivery(batch.id, target: target, attempt: attempt)
                try store.recordDelivery(batch.id, attempt: attempt.id, receipt: receipt)
                byReceipt[receipt] = batch.id
            }
            let accepted = try #require(byReceipt[.accepted])
            #expect(try store.removeAccepted(keeping: accepted).isEmpty)
            #expect(try store.removeAccepted().map(\.id) == [accepted])
            #expect(Set(try ExternalImportStore(root: inbox).list().map(\.id)) == Set(byReceipt.filter { $0.key != .accepted }.values))
        }
    }

    // OI-08: Send from the Share Extension is bound atomically and performed at most once, only while recent.
    @Test func extensionSendRequestIsBoundAndSpentOnce() throws {
        try withRoot { _, inbox in
            let store = ExternalImportStore(root: inbox)
            let destination = ExternalImportDestination(target: .init(hostId: "a", pairingKey: "pair-a", sessionId: "s", cwd: "/w"),
                                                        hostName: "Computer A", sessionName: "Session")
            let now = Date()
            let requested = try store.publish(try store.begin(), text: "https://example.test", files: [], note: "  look  ",
                                              request: (destination, now))
            let saved = try store.publish(try store.begin(), text: "later", files: [], note: " ")
            #expect(requested.destination == destination && requested.sendRequestedAt == now && requested.note == "  look  ")
            #expect(saved.destination == nil && saved.sendRequestedAt == nil && saved.note == nil)
            let listed = try store.list()
            #expect(ExternalImportAutoSend.next(listed, now: now.addingTimeInterval(30))?.id == requested.id)
            #expect(ExternalImportAutoSend.next(listed, now: now.addingTimeInterval(ExternalImportAutoSend.window + 1)) == nil)
            try store.clearSendRequest(requested.id)
            #expect(ExternalImportAutoSend.next(try store.list(), now: now) == nil)
            #expect(try store.list().first { $0.id == requested.id }?.destination == destination)
        }
    }

    // OI-08: manifests written before the note and send-request fields still open; the extension reads only what Orbis saved.
    @Test func readsEarlierManifestsAndTargetSnapshots() throws {
        let legacy = #"{"id":"6F9619FF-8B86-D011-B42D-00C04FC964FF","createdAt":0,"text":"old","files":[]}"#
        let batch = try JSONDecoder().decode(ExternalImportBatch.self, from: Data(legacy.utf8))
        #expect(batch.note == nil && batch.sendRequestedAt == nil && batch.text == "old")
        try withRoot { _, inbox in
            let store = ExternalImportStore(root: inbox)
            #expect(store.loadTargets() == nil)
            let entry = ExternalImportTargetSnapshot.Entry(destination: .init(target: .init(hostId: "a", pairingKey: "p", sessionId: "s", cwd: "/w"),
                                                                              hostName: "A", sessionName: "S"), agentKind: "pi", running: true)
            let snapshot = ExternalImportTargetSnapshot(entries: [entry], recent: entry.destination.target, savedAt: Date(timeIntervalSince1970: 5))
            try store.saveTargets(snapshot)
            #expect(store.loadTargets() == snapshot)
            #expect(try store.list().isEmpty)
        }
    }

    // OI-08: ordering may lift the last target and the open chat, but never drops or merges same-ID sessions across computers.
    @Test func pickerOrderLeadsWithRecentThenOpenChat() {
        func choice(_ host: String, _ session: String, current: Bool = false) -> ExternalImportChoice {
            ExternalImportChoice(destination: .init(target: .init(hostId: host, pairingKey: "pair-" + host, sessionId: session, cwd: "/w"),
                                                    hostName: host, sessionName: session), agentKind: "pi", running: false, current: current)
        }
        let choices = [choice("a", "s1"), choice("a", "s2", current: true), choice("b", "s1"), choice("b", "s3")]
        let names = { (groups: [[ExternalImportChoice]]) in groups.map { $0.map { $0.destination.target.hostId + "/" + $0.destination.target.sessionId } } }
        #expect(names(ExternalImportChoice.ordered(choices, recent: choices[3].destination.target)) == [["b/s3", "b/s1"], ["a/s2", "a/s1"]])
        #expect(names(ExternalImportChoice.ordered(choices.map { var c = $0; c.current = false; return c }, recent: nil)) == [["a/s1", "a/s2"], ["b/s1", "b/s3"]])
    }
}
