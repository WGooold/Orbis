import Foundation
import Testing
@testable import OrbisCore

@Suite("Tool inventory coverage proofs")
@MainActor
struct ToolInventoryCoverageTests {
    private var agent: ToolAgent { ToolAgent(hostId: "host", agentKind: "pi", sessionId: "session") }
    private func dictionary<T: Encodable>(_ value: T) throws -> [String: Any] {
        try #require(JSONSerialization.jsonObject(with: JSONEncoder().encode(value)) as? [String: Any])
    }
    private func summary(_ revision: Int64) -> [String: Any] {
        ["projectionVersion": 1, "tool": ["agent": ["hostId": "host", "agentKind": "pi", "sessionId": "session"], "toolCallId": "tool"],
         "toolName": "shell", "phase": "running", "order": revision, "contents": []]
    }
    private func reference(_ revision: Int64) throws -> ToolReference {
        let bytes = try JSONSerialization.data(withJSONObject: summary(revision), options: [.withoutEscapingSlashes]).count
        return ToolReference(projectionVersion: 1, agent: agent, version: ToolVersion(epoch: "inventory", revision: revision),
            source: ToolSource(epoch: "source", seq: revision), totalCount: 1, summaryBytes: Int64(bytes))
    }
    private func snapshot(_ reference: ToolReference) -> ToolSnapshot {
        ToolSnapshot(snapshotId: "snapshot-\(reference.version.revision)", agent: reference.agent,
            version: reference.version, source: reference.source, totalCount: reference.totalCount)
    }
    private func patch(_ revision: Int64) throws -> [String: Any] {
        ["type": "session.tools.patch", "runtimeId": "runtime", "agent": try dictionary(agent),
         "version": ["epoch": "inventory", "revision": revision], "source": ["epoch": "source", "seq": revision],
         "baseRevision": revision - 1, "upserts": [summary(revision)], "removes": []]
    }
    private func complete(_ inventory: ToolInventories, reference: ToolReference, sent: () -> [[String: Any]]) throws {
        let descriptor = snapshot(reference)
        inventory.consume(["type": "session.tools.opened", "requestId": try #require(sent().last?["requestId"]),
            "runtimeId": "runtime", "snapshot": try dictionary(descriptor)], runtime: "runtime")
        inventory.consume(["type": "session.tools.page", "requestId": try #require(sent().last?["requestId"]),
            "runtimeId": "runtime", "snapshot": try dictionary(descriptor), "startIndex": 0, "endIndex": 1,
            "tools": [summary(reference.version.revision)], "nextCursor": NSNull()], runtime: "runtime")
    }

    @Test func completedSnapshotAndBufferedPatchesEachProveTheirExactReferences() throws {
        let inventory = ToolInventories()
        var sent: [[String: Any]] = [], covered: [ToolReference] = []
        let first = try reference(1), second = try reference(2), third = try reference(3)
        inventory.send = { _, command in sent.append(command); return true }
        inventory.didCover = { runtime, reference in
            // Every proof and the final display state commit before any owner callback.
            #expect(inventory.covers(first, runtime: runtime))
            #expect(inventory.covers(second, runtime: runtime))
            #expect(inventory.covers(third, runtime: runtime))
            #expect(inventory.visible[runtime]?.first?.order == 3)
            #expect(!inventory.loading.contains(runtime))
            covered.append(reference)
        }
        inventory.require(first, runtime: "runtime")
        inventory.require(second, runtime: "runtime")
        inventory.require(third, runtime: "runtime")
        #expect(sent.count == 1)
        inventory.consume(try patch(2), runtime: "runtime")
        inventory.consume(try patch(3), runtime: "runtime")
        try complete(inventory, reference: first) { sent }
        #expect(covered == [first, second, third])
        #expect(sent.count == 2) // One open and its read; no repeated snapshot for newer checkpoints.
        inventory.require(first, runtime: "runtime")
        #expect(sent.count == 2)
        #expect(inventory.visible["runtime"]?.first?.order == 3)
        #expect(covered == [first, second, third])
        inventory.clear()
    }

    @Test func coverageCallbacksCanStartSuccessorReadWithoutStaleStateOverwritingIt() throws {
        let inventory = ToolInventories()
        var sent: [[String: Any]] = [], covered: [ToolReference] = []
        let first = try reference(1), second = try reference(2), third = try reference(3)
        inventory.send = { _, command in sent.append(command); return true }
        inventory.didCover = { _, reference in
            covered.append(reference)
            if reference == first { inventory.require(third, runtime: "runtime") }
        }
        inventory.require(first, runtime: "runtime")
        inventory.require(second, runtime: "runtime")
        inventory.consume(try patch(2), runtime: "runtime")
        try complete(inventory, reference: first) { sent }
        #expect(covered == [first, second])
        #expect(sent.count == 3)
        #expect(inventory.loading.contains("runtime"))
        let successor = try #require(sent.last?["reference"] as? [String: Any])
        let version = try #require(successor["version"] as? [String: Any])
        #expect(version["revision"] as? Int == 3)
        try complete(inventory, reference: third) { sent }
        #expect(covered == [first, second, third])
        #expect(inventory.visible["runtime"]?.first?.order == 3)
        #expect(!inventory.loading.contains("runtime"))
        inventory.clear()
    }

    @Test func proofRetentionIsBoundedAndNeverInfersUnverifiedMetadata() throws {
        let inventory = ToolInventories()
        var sent: [[String: Any]] = []
        inventory.send = { _, command in sent.append(command); return true }
        let first = try reference(1)
        inventory.require(first, runtime: "runtime")
        try complete(inventory, reference: first) { sent }
        for revision in 2...70 { inventory.consume(try patch(Int64(revision)), runtime: "runtime") }
        #expect(!inventory.covers(first, runtime: "runtime"))
        #expect(!inventory.covers(try reference(6), runtime: "runtime"))
        #expect(inventory.covers(try reference(7), runtime: "runtime"))
        let latest = try reference(70)
        #expect(inventory.covers(latest, runtime: "runtime"))
        let forged = ToolReference(projectionVersion: 1, agent: latest.agent, version: latest.version, source: latest.source,
            totalCount: latest.totalCount, summaryBytes: latest.summaryBytes + 1)
        #expect(!inventory.covers(forged, runtime: "runtime"))
        let otherSource = ToolReference(projectionVersion: 1, agent: latest.agent, version: latest.version,
            source: ToolSource(epoch: "other", seq: 70), totalCount: latest.totalCount, summaryBytes: latest.summaryBytes)
        #expect(!inventory.covers(otherSource, runtime: "runtime"))
        #expect(!inventory.covers(latest, runtime: "other-runtime"))
        inventory.clear("runtime")
        #expect(!inventory.covers(latest, runtime: "runtime"))
    }

    @Test func newerChangedNoticeTerminatesReadWhileStaleAndWrongScopeNoticesDoNot() throws {
        let inventory = ToolInventories()
        var sent: [[String: Any]] = [], failures: [ToolReference?] = []
        inventory.send = { _, command in sent.append(command); return true }
        inventory.didFail = { _, reference, _ in failures.append(reference) }
        let first = try reference(1), second = try reference(2)
        inventory.require(first, runtime: "runtime")
        inventory.require(second, runtime: "runtime")
        var notice: [String: Any] = ["type": "session.tools.changed", "runtimeId": "runtime", "agent": try dictionary(agent),
            "version": try dictionary(first.version), "source": try dictionary(first.source)]
        inventory.consume(notice, runtime: "runtime")
        #expect(failures.isEmpty)
        notice["version"] = try dictionary(second.version); notice["source"] = try dictionary(second.source)
        notice["runtimeId"] = "other-runtime"
        inventory.consume(notice, runtime: "runtime")
        #expect(failures.isEmpty)
        notice["runtimeId"] = "runtime"
        inventory.consume(notice, runtime: "runtime")
        #expect(failures.count == 1)
        #expect(failures.first == second)
        #expect(!inventory.loading.contains("runtime"))
        #expect(!inventory.covers(first, runtime: "runtime"))
        inventory.retry("runtime")
        #expect(sent.count == 2)
        try complete(inventory, reference: second) { sent }
        #expect(inventory.covers(second, runtime: "runtime"))
        #expect(!inventory.covers(first, runtime: "runtime"))
        inventory.clear()
    }
}
