import Foundation
import Testing
@testable import OrbisCore

@Suite("Canonical session history")
struct SessionHistoryTests {
    private func row(_ id: String, parent: String? = nil) -> [String: Any] {
        ["entryId": id, "parentId": parent as Any? ?? NSNull(), "type": "message", "timestamp": "2026-10-29T00:00:00Z"]
    }
    private func message(_ id: String) -> [String: Any] {
        ["messageId": id, "role": "assistant", "timestamp": 1, "content": [["type": "text", "text": id]]]
    }
    @Test func canonicalWindowAndHeadAnchorSurviveCacheProjection() throws {
        let event: [String: Any] = ["source": ["epoch": "source", "seq": 1], "cursor": ["leafId": "c"],
            "entries": [row("a"), row("b", parent: "a"), row("c", parent: "b")],
            "display": ["projectionVersion": 3, "windowStart": "b", "entries": [
                ["entryId": "a", "message": message("hidden-old")], ["entryId": "b", "message": NSNull()],
                ["entryId": "c", "message": message("current")], ["entryId": NSNull(), "displayId": "summary", "anchor": "head", "message": message("summary")]]]]
        let graph = try CachedSessionGraph(sessionId: "session").merging(event, activate: true)
        let decoded = try JSONDecoder().decode(CachedSessionGraph.self, from: JSONEncoder().encode(graph))
        #expect(decoded.messages.map(\.messageId) == ["summary", "current"])
        #expect(decoded.displayVersion == 3)
    }
    @Test func olderHistoryCannotRestoreAReplacedDisplayRow() throws {
        let event: [String: Any] = ["source": ["epoch": "source", "seq": 3], "cursor": ["leafId": "a"], "entries": [row("a")],
            "display": ["projectionVersion": 3, "entries": [["entryId": "a", "message": NSNull()]]]]
        let graph = try CachedSessionGraph(sessionId: "session").merging(event, activate: true)
        let older: [String: Any] = ["source": ["epoch": "source", "seq": 2], "entries": [row("a")],
            "display": ["projectionVersion": 3, "entries": [["entryId": "a", "message": message("stale")]]]]
        #expect(try graph.merging(older, activate: false).messages.isEmpty)
        var unsupported = older
        unsupported["display"] = ["projectionVersion": 4, "entries": []]
        #expect(throws: (any Error).self) { try graph.merging(unsupported, activate: false) }
    }
    @Test func wireIntegersDoNotCoerceBooleansFractionsOrUnsafeValues() {
        #expect(sessionInteger(true) == nil)
        #expect(sessionInteger(1.25) == nil)
        #expect(sessionInteger(-1) == nil)
        #expect(sessionInteger(9_007_199_254_740_992 as UInt64) == nil)
        #expect(sessionInteger(42) == 42)
    }

    @Test func canonicalNativeArgumentsPreserveLargeIntegersThroughSQLiteAndGraphCoding() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let native = Data(#"{"entryId":"native","parentId":null,"type":"message","timestamp":"2026-10-29T00:00:00Z","data":{"role":"assistant","content":[{"type":"tool_call","toolCallId":"call","toolName":"native","arguments":{"signed":-9223372036854775808,"unsigned":18446744073709551615,"unsafe":9007199254740993,"fraction":1.25,"values":[true,false,null,"你好",{"id":9007199254740993}]}}]}}"#.utf8)
        let expected = try JSONDecoder().decode(RemoteJSONValue.self, from: native)
        let arguments = expected["data"]["content"]
        if case .array(let content) = arguments {
            #expect(content.first?["arguments"]["unsigned"] == .unsigned(UInt64.max))
            #expect(content.first?["arguments"]["unsafe"] == .integer(9_007_199_254_740_993))
        } else { Issue.record("canonical native content is not an array") }
        var event = try #require(JSONSerialization.jsonObject(with: packet([], leaf: "native")) as? [String: Any])
        event["entries"] = [try #require(JSONSerialization.jsonObject(with: native) as? [String: Any])]
        let wire = try JSONSerialization.data(withJSONObject: event)
        let worker = SessionHistoryWorker(root: root), pairing = host(), generation = UUID()
        worker.setGeneration(generation, host: pairing)
        let committed = try await worker.ingest(host: pairing, sessionId: "s", event: wire, activate: true, generation: generation)
        #expect(committed.committedEntries.first?.value == expected)
        let reopened = SessionHistoryWorker(root: root)
        let persisted = try #require(try await reopened.entry(host: pairing, sessionId: "s", entryId: "native"))
        #expect(persisted.value == expected)
        #expect(persisted.value["type"].string == "message")
        let decoded = try JSONDecoder().decode(CachedSessionGraph.self, from: JSONEncoder().encode(committed.graph))
        #expect(decoded.entries["native"]?.value == expected)
        let encoded = try JSONEncoder().encode(persisted.value)
        let text = try #require(String(data: encoded, encoding: .utf8))
        #expect(text.contains("18446744073709551615"))
        #expect(text.contains("9007199254740993"))
    }

    private func host(_ id: String = "one") -> HostPairing {
        HostPairing(hostId: id, hostName: id, hostPub: "key-" + id, pskRoot: "test", relay: RelayCredential(relayUrl: "wss://relay.example", deviceId: "device-" + id, credential: "test"), lan: [])
    }
    private func packet(_ ids: [Int], epoch: String = "source", seq: Int = 1, leaf: String? = nil, patchBase: Int? = nil) throws -> Data {
        let cursor: [String: Any] = ["leafId": leaf as Any? ?? ids.last.map { "e\($0)" } as Any? ?? NSNull()]
        var event: [String: Any] = ["type": "session.snapshot", "source": ["epoch": epoch, "seq": seq, "ready": true],
            "cursor": cursor, "checkpoint": ["head": cursor, "headCompleteness": "complete", "inventoryComplete": true],
            "live": ["complete": true, "messages": []], "entries": ids.map { row("e\($0)", parent: $0 > 1 ? "e\($0 - 1)" : nil) },
            "display": ["projectionVersion": 3, "entries": ids.map { ["entryId": "e\($0)", "message": message("m\($0)")] }]]
        if let patchBase { event["type"] = "session.patch"; event["baseSeq"] = patchBase; event["seq"] = seq; event["head"] = cursor; event["headCompleteness"] = "complete" }
        return try JSONSerialization.data(withJSONObject: event)
    }
    @Test func sqliteIncrementalPagesStayBoundedAndLateRowsCannotOverwriteNewerFacts() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let worker = SessionHistoryWorker(root: root), pairing = host(), generation = UUID()
        worker.setGeneration(generation, host: pairing)
        let first = try await worker.ingest(host: pairing, sessionId: "s", event: packet(Array(1...500)), activate: true, generation: generation, limit: 64)
        #expect(first.page.entries.count == 64)
        #expect(first.graph.entries.count <= 564)
        let second = try await worker.ingest(host: pairing, sessionId: "s", event: packet(Array(501...1000), seq: 2, patchBase: 1), activate: true, generation: generation, limit: 64)
        #expect(second.page.entries.count == 64)
        #expect(second.page.targetCovered)
        let summaries = try await worker.listCachedSessions(host: pairing)
        #expect(summaries.first?.entryCount == 1000)
        var older = try #require(JSONSerialization.jsonObject(with: packet([10], seq: 0)) as? [String: Any])
        older["display"] = ["projectionVersion": 3, "entries": [["entryId": "e10", "message": message("stale")]]]
        let oldCommit = try await worker.ingest(host: pairing, sessionId: "s", event: JSONSerialization.data(withJSONObject: older), activate: false, generation: generation)
        #expect(oldCommit.committedDisplay["e10"]?.message?.messageId == "m10")
        let page = try await worker.page(host: pairing, sessionId: "s", leafId: "e1000", beforeEntryId: "e937", limit: 30)
        #expect(page.entries.first?.entryId == "e907")
        #expect(page.entries.last?.entryId == "e936")
        #expect(page.graph.entries.count == 30)
        #expect(page.targetCovered)
        #expect(page.displayComplete)
    }

    @Test func sqliteEpochReplacementAndInvalidCorrectionAreAtomic() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let worker = SessionHistoryWorker(root: root), pairing = host(), generation = UUID()
        worker.setGeneration(generation, host: pairing)
        _ = try await worker.ingest(host: pairing, sessionId: "s", event: packet([1, 2]), activate: true, generation: generation)
        var cycle = try #require(JSONSerialization.jsonObject(with: packet([1], seq: 2, leaf: "e2")) as? [String: Any])
        cycle["entries"] = [row("e1", parent: "e2")]
        await #expect(throws: (any Error).self) { try await worker.ingest(host: pairing, sessionId: "s", event: JSONSerialization.data(withJSONObject: cycle), activate: true, generation: generation) }
        #expect(try await worker.page(host: pairing, sessionId: "s").messages.map(\.messageId) == ["m1", "m2"])
        _ = try await worker.ingest(host: pairing, sessionId: "s", event: packet([], epoch: "replacement"), activate: true, generation: generation)
        #expect(try await worker.page(host: pairing, sessionId: "s").messages.isEmpty)
        await #expect(throws: (any Error).self) { try await worker.ingest(host: pairing, sessionId: "s", event: packet([1], seq: 3), activate: true, generation: generation) }
        #expect(try await worker.listCachedSessions(host: pairing).first?.epoch == "replacement")
        let other = host("two")
        #expect(try await !worker.hasHistory(host: other, sessionId: "s"))
    }

    @Test func runtimeWriteLeaseRejectsQueuedWorkAndRollsBackInvalidatedCommit() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let worker = SessionHistoryWorker(root: root), pairing = host(), generation = UUID()
        worker.setGeneration(generation, host: pairing)
        let expired = SessionHistoryWriteLease(); expired.invalidate()
        await #expect(throws: (any Error).self) {
            try await worker.ingest(host: pairing, sessionId: "never-written", event: packet([1]), activate: true, generation: generation, lease: expired)
        }
        #expect(try await !worker.hasHistory(host: pairing, sessionId: "never-written"))

        var baseline = try #require(JSONSerialization.jsonObject(with: packet([1, 2])) as? [String: Any])
        baseline["turnTimings"] = [["turnId": "old-turn", "startedAt": 1, "durationMs": 10, "messageId": "m2"]]
        _ = try await worker.ingest(host: pairing, sessionId: "s", event: JSONSerialization.data(withJSONObject: baseline), activate: true, generation: generation)
        let oldRuntimeLease = SessionHistoryWriteLease()
        let invalidatedAtCommit = SessionHistoryWorker(root: root, beforeCommit: { oldRuntimeLease.invalidate() })
        invalidatedAtCommit.setGeneration(generation, host: pairing)
        var replacement = try #require(JSONSerialization.jsonObject(with: packet([3], epoch: "replacement")) as? [String: Any])
        replacement["turnTimings"] = [["turnId": "new-turn", "startedAt": 2, "durationMs": 20, "messageId": "m3"]]
        // The hook runs after every row, source metadata and epoch retirement have been staged.
        // Runtime replacement at this precise point must reject and roll back the entire write.
        await #expect(throws: (any Error).self) {
            try await invalidatedAtCommit.ingest(host: pairing, sessionId: "s", event: JSONSerialization.data(withJSONObject: replacement), activate: true, generation: generation, lease: oldRuntimeLease)
        }
        let after = try await worker.page(host: pairing, sessionId: "s")
        #expect(after.graph.epoch == "source")
        #expect(after.graph.leafId == "e2")
        #expect(after.messages.map(\.messageId) == ["m1", "m2"])
        #expect(after.turnTimings.map(\.turnId) == ["old-turn"])
        #expect(try await worker.entry(host: pairing, sessionId: "s", entryId: "e3") == nil)
        // A new Runtime with the same IDs owns a fresh lease. The failed epoch switch did not
        // retire its old source, so its legitimate same-epoch continuation remains writable.
        let newRuntimeLease = SessionHistoryWriteLease()
        let resumed = try await worker.ingest(host: pairing, sessionId: "s", event: packet([3], seq: 2, patchBase: 1), activate: true, generation: generation, lease: newRuntimeLease)
        #expect(resumed.page.graph.leafId == "e3")
        #expect(resumed.page.messages.map(\.messageId) == ["m1", "m2", "m3"])
    }

    @Test func sqliteMigrationTimingAndGenerationFencesSurviveReopening() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let pairing = host(), old = SessionHistoryCache(root: root)
        let event = try #require(JSONSerialization.jsonObject(with: packet(Array(1...60))) as? [String: Any])
        try old.save(CachedSessionGraph(sessionId: "s").merging(event, activate: true), host: pairing)
        let worker = SessionHistoryWorker(root: root), generation = UUID()
        worker.setGeneration(generation, host: pairing)
        #expect(try await worker.page(host: pairing, sessionId: "s", limit: 10).entries.count == 10)
        var update = try #require(JSONSerialization.jsonObject(with: packet([61], seq: 2, patchBase: 1)) as? [String: Any])
        update["turnTimings"] = [["turnId": "turn", "startedAt": 10, "durationMs": 20, "messageId": "m61"]]
        _ = try await worker.ingest(host: pairing, sessionId: "s", event: JSONSerialization.data(withJSONObject: update), activate: true, generation: generation)
        let reopened = SessionHistoryWorker(root: root)
        let page = try await reopened.page(host: pairing, sessionId: "s", limit: 5)
        #expect(page.turnTimings.first?.durationMs == 20)
        #expect(page.messages.last?.messageId == "m61")
        worker.setGeneration(UUID(), host: pairing)
        await #expect(throws: (any Error).self) { try await worker.ingest(host: pairing, sessionId: "s", event: packet([62], seq: 3, patchBase: 2), activate: true, generation: generation) }
        #expect(try await reopened.entry(host: pairing, sessionId: "s", entryId: "e62") == nil)
    }

    @Test func boundedForwardCatchupAdvancesThePersistedFrontierUntilTheFixedTargetIsCovered() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let worker = SessionHistoryWorker(root: root), pairing = host(), generation = UUID()
        worker.setGeneration(generation, host: pairing)
        for scenario in ["canonical-hole", "compacted-prefix", "display-hole"] {
            let compacted = scenario == "compacted-prefix"
            var preview = try #require(JSONSerialization.jsonObject(with: packet(Array(480...500))) as? [String: Any])
            if scenario == "display-hole" { preview["entries"] = (1...500).map { row("e\($0)", parent: $0 == 1 ? nil : "e\($0 - 1)") } }
            if compacted {
                var display = try #require(preview["display"] as? [String: Any]); display["windowStart"] = "e480"; preview["display"] = display
            }
            _ = try await worker.ingest(host: pairing, sessionId: scenario, event: JSONSerialization.data(withJSONObject: preview), activate: true, generation: generation)
            var page = try await worker.page(host: pairing, sessionId: scenario, leafId: "e500", limit: 1)
            var responses = 0
            while let gap = page.coverageGap, responses < 5 {
                #expect(!page.targetCovered)
                #expect(gap.targetLeafId == "e479")
                let known = gap.knownLeafId.flatMap { Int($0.dropFirst()) } ?? 0
                #expect(known == responses * 128)
                let end = min(known + 128, 479)
                var event = try #require(JSONSerialization.jsonObject(with: packet(Array((known + 1)...end), leaf: gap.targetLeafId)) as? [String: Any])
                event["range"] = "catchup"; event["mode"] = known == 0 ? "replace" : "append"
                event["targetLeafId"] = gap.targetLeafId; event["hasOlder"] = false
                event["complete"] = end == 479; event["rangeStatus"] = end == 479 ? "complete" : "limit_reached"
                event["checkpoint"] = nil; event["live"] = nil
                if compacted { event["display"] = nil }
                let committed = try await worker.ingest(host: pairing, sessionId: scenario, event: JSONSerialization.data(withJSONObject: event), activate: false, generation: generation, limit: 1)
                #expect(committed.page.graph.leafId == "e500")
                #expect(committed.page.entries.count == 1)
                responses += 1
                // The frontier is derived from persisted rows, independent of the live worker.
                let reopened = SessionHistoryWorker(root: root)
                page = try await reopened.page(host: pairing, sessionId: scenario, leafId: "e500", limit: 1)
            }
            #expect(responses == 4)
            #expect(page.targetCovered)
            #expect(page.coverageGap == nil)
            #expect(try await worker.listCachedSessions(host: pairing).first(where: { $0.sessionId == scenario })?.leafId == "e500")
        }
    }

    @Test func sqliteDisplayExclusionProvesCompactionBeyondTheBoundedGraph() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let worker = SessionHistoryWorker(root: root), pairing = host(), generation = UUID()
        worker.setGeneration(generation, host: pairing)
        _ = try await worker.ingest(host: pairing, sessionId: "s", event: packet(Array(1...500)), activate: true, generation: generation)
        _ = try await worker.ingest(host: pairing, sessionId: "s", event: packet(Array(501...1000), seq: 2, patchBase: 1), activate: true, generation: generation)
        #expect(try await worker.excludedDisplayEntries(host: pairing, sessionId: "s", entryIds: ["e1", "live"]).isEmpty)
        var event = try #require(JSONSerialization.jsonObject(with: packet([1001], seq: 3, patchBase: 2)) as? [String: Any])
        event["display"] = ["projectionVersion": 3, "windowStart": "e300", "entries": [
            ["entryId": "e300", "message": NSNull()], ["entryId": "e1001", "message": message("m1001")]]]
        let committed = try await worker.ingest(host: pairing, sessionId: "s", event: JSONSerialization.data(withJSONObject: event), activate: true, generation: generation, limit: 256)
        #expect(committed.graph.entries["e300"] == nil)
        #expect(committed.committedDisplay["e300"]?.message == nil)
        let candidates = (1...1001).map { "e\($0)" } + ["live", "not-canonical", "e1"]
        let excluded = try await worker.excludedDisplayEntries(host: pairing, sessionId: "s", entryIds: candidates)
        #expect(excluded == Set((1...299).map { "e\($0)" }))
        #expect(!excluded.contains("e300"))
        #expect(!excluded.contains("live"))
        let older = try await worker.page(host: pairing, sessionId: "s", leafId: "e1001", beforeEntryId: "e300", limit: 30)
        #expect(older.entries.count == 30)
        #expect(older.displayComplete)
        #expect(older.messages.isEmpty)
        // Repeated filters neither retain old temporary candidates nor cross namespaces.
        #expect(try await worker.excludedDisplayEntries(host: pairing, sessionId: "s", entryIds: ["e2"]) == ["e2"])
        #expect(try await worker.excludedDisplayEntries(host: pairing, sessionId: "s", entryIds: ["live"]).isEmpty)
        #expect(try await worker.excludedDisplayEntries(host: host("other"), sessionId: "s", entryIds: candidates).isEmpty)
        #expect(try await worker.excludedDisplayEntries(host: pairing, sessionId: "other", entryIds: candidates).isEmpty)

        // An unconnected prefix is not presumed to precede a window. Filling its missing link
        // later makes those same loaded IDs provably excluded, without changing the live head.
        var partial = try #require(JSONSerialization.jsonObject(with: packet([1, 2, 5, 6])) as? [String: Any])
        var display = try #require(partial["display"] as? [String: Any]); display["windowStart"] = "e6"; partial["display"] = display
        _ = try await worker.ingest(host: pairing, sessionId: "gap", event: JSONSerialization.data(withJSONObject: partial), activate: true, generation: generation)
        #expect(try await worker.excludedDisplayEntries(host: pairing, sessionId: "gap", entryIds: ["e1", "e2", "e5", "e6", "live"]) == ["e5"])
        _ = try await worker.ingest(host: pairing, sessionId: "gap", event: packet([3, 4]), activate: false, generation: generation)
        #expect(try await worker.excludedDisplayEntries(host: pairing, sessionId: "gap", entryIds: ["e1", "e2", "e5", "e6", "live"]) == ["e1", "e2", "e5"])
    }

    @Test func logicalReadHandoffPreservesOwnershipAndNewerSourceDemand() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let worker = SessionHistoryWorker(root: root), pairing = host(), generation = UUID()
        worker.setGeneration(generation, host: pairing)
        _ = try await worker.ingest(host: pairing, sessionId: "s", event: packet([2, 3]), activate: true, generation: generation)
        let page = try await worker.page(host: pairing, sessionId: "s", leafId: "e3", beforeEntryId: "e2")
        var reads = SessionReadOperations()
        let owner = SessionReadOwner(hostKey: "host", deviceId: "device", historyKey: "runtime", sessionId: "s", branchGeneration: 1, cacheEpoch: "source", connectionGeneration: generation, selected: true)
        let first = reads.begin(kind: .history, owner: owner, targetLeafId: "e3", beforeEntryId: "e2", id: "history")
        #expect(first.accepted)
        if case .requestHistory(let before, _) = reads.localResult("history", page: page, current: owner) { #expect(before == "e2") } else { Issue.record("missing parent must hand off to remote") }
        #expect(reads.operations["history"]?.phase == .waiting)
        let boundHistory = reads.bindRemote("history", commandId: "wire", current: owner)
        #expect(boundHistory)
        reads.finish("history", phase: .failed, error: "timeout")
        let late = reads.recoverLate("history", commandId: "wire", current: owner, newId: "late")
        let recovered = try #require(late)
        #expect(recovered == "late")
        #expect(reads.operations["history"]?.phase == .failed)
        reads.finish("late", phase: .cancelled)
        reads.requestSource(historyKey: "runtime")
        _ = reads.begin(kind: .source, owner: owner, targetLeafId: "e3", id: "source")
        let boundSource = reads.bindRemote("source", commandId: "source-wire", current: owner)
        #expect(boundSource)
        let newer = reads.requestSource(historyKey: "runtime")
        _ = reads.committedRemoteResult("source", commandId: "source-wire", page: page, current: owner, sourceConfirmed: true)
        #expect(reads.demands["runtime"] == newer)
        reads.finish("source", phase: .failed)
        #expect(reads.operations["source"]?.phase == .succeeded)
    }

}
