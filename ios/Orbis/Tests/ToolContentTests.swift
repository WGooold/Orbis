import Foundation
import Testing
@testable import OrbisCore

@Suite("Tool details and inventory") @MainActor
struct ToolContentTests {
    private var agent: ToolAgent { ToolAgent(hostId: "host", agentKind: "codex", sessionId: "session") }
    private var locator: ToolLocator { ToolLocator(tool: ToolIdentity(agent: agent, toolCallId: "tool-1"), part: "output") }
    private func dictionary<T: Encodable>(_ value: T) throws -> [String: Any] { try JSONSerialization.jsonObject(with: JSONEncoder().encode(value)) as! [String: Any] }
    private func page(_ request: [String: Any], text: String, from: Int64, through: Int64, end: Int64) throws -> [String: Any] {
        var result: [String: Any] = ["type": "session.tool.content.page", "requestId": request["requestId"]!, "runtimeId": "runtime", "locator": try dictionary(locator),
            "read": ["readId": "read", "contentEpoch": "epoch", "throughOffset": end], "format": "text", "representation": "utf8-fragment",
            "fromOffset": from, "throughOffset": through, "availableFromOffset": 0, "availableThroughOffset": end, "observedThroughOffset": end, "contentFinal": true, "text": text, "gaps": []]
        result["nextCursor"] = through < end ? through as Any : NSNull()
        return result
    }
    @Test func detailPagesUseUTF8OffsetsAndFixedReadIdentity() throws {
        let reader = ToolContentReader(); var sent: [[String: Any]] = []
        reader.send = { _, body in sent.append(body); return true }
        reader.open(runtimeId: "runtime", locator: locator)
        #expect(sent.count == 1)
        #expect(sent[0]["maxBytes"] as? Int == 32768)
        reader.consume(try page(sent[0], text: "你", from: 0, through: 3, end: 6), runtimeId: "wrong")
        #expect(reader.text.isEmpty)
        reader.consume(try page(sent[0], text: "你", from: 0, through: 3, end: 6), runtimeId: "runtime")
        #expect(reader.text == "你"); #expect(reader.nextCursor == 3)
        reader.loadNext()
        #expect(sent.last?["offset"] as? Int64 == 3)
        #expect((sent.last?["read"] as? [String: Any])?["readId"] as? String == "read")
        reader.consume(try page(sent.last!, text: "好", from: 3, through: 6, end: 6), runtimeId: "runtime")
        #expect(reader.text == "你好"); #expect(reader.nextCursor == nil)
        reader.close()
        #expect(sent.last?["type"] as? String == "session.tool.content.cancel")
        #expect(reader.locator == nil)
    }
    @Test func wrongByteLengthsAndVersionChangesCannotAppend() throws {
        let reader = ToolContentReader(); var sent: [String: Any] = [:]
        reader.send = { _, body in sent = body; return true }; reader.open(runtimeId: "runtime", locator: locator)
        reader.consume(try page(sent, text: "你", from: 0, through: 1, end: 3), runtimeId: "runtime")
        #expect(reader.text.isEmpty); #expect(reader.error != nil); #expect(!reader.loading)
        reader.close()
    }
    @Test func inventoryRequiresCompleteMatchingPagesBeforePublishing() throws {
        let inventory = ToolInventories(); var sent: [[String: Any]] = []; var covered = false
        inventory.send = { _, command in sent.append(command); return true }; inventory.didCover = { _, _ in covered = true }
        let content = "路径 C:\\repo/file 你好\n"
        let summary: [String: Any] = ["projectionVersion": 1, "tool": try dictionary(locator.tool), "toolName": "read", "phase": "running", "order": 1, "contents": [],
            "inputSummary": ["text": content, "omitted": false, "originalBytes": content.utf8.count]]
        let bytes = try JSONSerialization.data(withJSONObject: summary, options: [.withoutEscapingSlashes]).count
        let reference = ToolReference(projectionVersion: 1, agent: agent, version: ToolVersion(epoch: "inventory", revision: 1), source: ToolSource(epoch: "source", seq: 1), totalCount: 1, summaryBytes: Int64(bytes))
        inventory.require(reference, runtime: "runtime")
        #expect(inventory.visible["runtime"] == nil); #expect(!covered)
        let snapshot = ToolSnapshot(snapshotId: "snapshot", agent: agent, version: reference.version, source: reference.source, totalCount: 1)
        inventory.consume(["type": "session.tools.opened", "requestId": sent.last!["requestId"]!, "runtimeId": "runtime", "snapshot": try dictionary(snapshot)], runtime: "runtime")
        #expect(sent.last?["type"] as? String == "session.tools.read")
        inventory.consume(["type": "session.tools.page", "requestId": sent.last!["requestId"]!, "runtimeId": "runtime", "snapshot": try dictionary(snapshot), "startIndex": 0, "endIndex": 1, "tools": [summary], "nextCursor": NSNull()], runtime: "runtime")
        #expect(inventory.visible["runtime"]?.count == 1); #expect(covered)
        #expect(inventory.covers(reference, runtime: "runtime"))
        let next = ToolReference(projectionVersion: 1, agent: agent, version: ToolVersion(epoch: "inventory", revision: 2), source: ToolSource(epoch: "source", seq: 2), totalCount: 0, summaryBytes: 0)
        inventory.require(next, runtime: "runtime")
        #expect(inventory.visible["runtime"]?.count == 1)
        inventory.clear()
        #expect(inventory.visible.isEmpty)
    }
    @Test func invalidDetailFormatsAndGapsRetireTheRequestWithoutAppending() throws {
        for invalidGap in [false, true] {
            let reader = ToolContentReader(); var request: [String: Any] = [:]
            reader.send = { _, body in request = body; return true }; reader.open(runtimeId: "runtime", locator: locator)
            var response = try page(request, text: "a", from: 0, through: 1, end: 1)
            if invalidGap {
                response["observedThroughOffset"] = 2
                response["gaps"] = [["fromOffset": 1, "throughOffset": 2, "reason": "invented"]]
            } else { response["format"] = "unsupported" }
            reader.consume(response, runtimeId: "runtime")
            #expect(reader.error != nil); #expect(reader.text.isEmpty); #expect(!reader.loading)
            reader.consume(try page(request, text: "a", from: 0, through: 1, end: 1), runtimeId: "runtime")
            #expect(reader.text.isEmpty)
            reader.close()
        }
    }

    @Test func newerCheckpointsKeepTheFixedInventoryReadAndStaleReferencesCannotRollBackIt() throws {
        let inventory = ToolInventories(); var sent: [[String: Any]] = [], covered: [ToolReference] = []
        inventory.send = { _, command in sent.append(command); return true }
        inventory.didCover = { _, reference in covered.append(reference) }
        let first = ToolReference(projectionVersion: 1, agent: agent, version: ToolVersion(epoch: "inventory", revision: 1), source: ToolSource(epoch: "source", seq: 1), totalCount: 0, summaryBytes: 0)
        let second = ToolReference(projectionVersion: 1, agent: agent, version: ToolVersion(epoch: "inventory", revision: 2), source: ToolSource(epoch: "source", seq: 2), totalCount: 0, summaryBytes: 0)
        inventory.require(first, runtime: "runtime"); inventory.require(second, runtime: "runtime")
        #expect(sent.count == 1)
        let firstSnapshot = ToolSnapshot(snapshotId: "first", agent: agent, version: first.version, source: first.source, totalCount: 0)
        inventory.consume(["type": "session.tools.opened", "requestId": sent.last!["requestId"]!, "runtimeId": "runtime", "snapshot": try dictionary(firstSnapshot)], runtime: "runtime")
        inventory.consume(["type": "session.tools.page", "requestId": sent.last!["requestId"]!, "runtimeId": "runtime", "snapshot": try dictionary(firstSnapshot), "startIndex": 0, "endIndex": 0, "tools": [], "nextCursor": NSNull()], runtime: "runtime")
        #expect(sent.last?["type"] as? String == "session.tools.open")
        #expect(covered == [first])
        let count = sent.count
        inventory.require(first, runtime: "runtime")
        #expect(sent.count == count)
        let secondSnapshot = ToolSnapshot(snapshotId: "second", agent: agent, version: second.version, source: second.source, totalCount: 0)
        inventory.consume(["type": "session.tools.opened", "requestId": sent.last!["requestId"]!, "runtimeId": "runtime", "snapshot": try dictionary(secondSnapshot)], runtime: "runtime")
        inventory.consume(["type": "session.tools.page", "requestId": sent.last!["requestId"]!, "runtimeId": "runtime", "snapshot": try dictionary(secondSnapshot), "startIndex": 0, "endIndex": 0, "tools": [], "nextCursor": NSNull()], runtime: "runtime")
        #expect(inventory.covers(second, runtime: "runtime")); #expect(covered == [first, second])
        inventory.clear()
    }

    @Test func removingUnknownToolsDoesNotAdvanceTheConfirmedInventory() throws {
        let inventory = ToolInventories(); var sent: [[String: Any]] = []
        inventory.send = { _, command in sent.append(command); return true }
        let reference = ToolReference(projectionVersion: 1, agent: agent, version: ToolVersion(epoch: "inventory", revision: 1), source: ToolSource(epoch: "source", seq: 1), totalCount: 0, summaryBytes: 0)
        inventory.require(reference, runtime: "runtime")
        let snapshot = ToolSnapshot(snapshotId: "snapshot", agent: agent, version: reference.version, source: reference.source, totalCount: 0)
        inventory.consume(["type": "session.tools.opened", "requestId": sent.last!["requestId"]!, "runtimeId": "runtime", "snapshot": try dictionary(snapshot)], runtime: "runtime")
        inventory.consume(["type": "session.tools.page", "requestId": sent.last!["requestId"]!, "runtimeId": "runtime", "snapshot": try dictionary(snapshot), "startIndex": 0, "endIndex": 0, "tools": [], "nextCursor": NSNull()], runtime: "runtime")
        inventory.consume(["type": "session.tools.patch", "runtimeId": "runtime", "agent": try dictionary(agent), "version": ["epoch": "inventory", "revision": 2], "source": ["epoch": "source", "seq": 2], "baseRevision": 1, "upserts": [], "removes": ["missing"]], runtime: "runtime")
        #expect(inventory.errors["runtime"] != nil); #expect(inventory.covers(reference, runtime: "runtime"))
        inventory.clear()
    }

    private func waitFor(_ condition: () -> Bool) async throws {
        for _ in 0..<200 { if condition() { return }; try await Task.sleep(nanoseconds: 5_000_000) }
        #expect(condition())
    }
    private func exportRoot() -> URL { FileManager.default.temporaryDirectory.appendingPathComponent("orbis-tool-export-" + UUID().uuidString) }

    @Test func toolExportStreamsFixedUTF8PagesToDiskWithoutFillingTheDetailCache() async throws {
        let root = exportRoot(), destination = root.appendingPathComponent("output.txt")
        defer { try? FileManager.default.removeItem(at: root) }
        let reader = ToolContentReader(); var sent: [[String: Any]] = []
        reader.send = { _, request in sent.append(request); return true }; reader.open(runtimeId: "runtime", locator: locator)
        let original = try #require(sent.first?["requestId"] as? String)
        reader.export(to: destination)
        try await waitFor { sent.last?["type"] as? String == "session.tool.content.read" && sent.last?["requestId"] as? String != original }
        let first = try #require(sent.last)
        var response = try page(first, text: "你", from: 0, through: 3, end: 6); response["contentFinal"] = false
        reader.consume(response, runtimeId: "runtime")
        try await waitFor { reader.exportedBytes == 3 && sent.last?["offset"] as? Int64 == 3 }
        #expect(reader.text.isEmpty); #expect(reader.exporting); #expect(!FileManager.default.fileExists(atPath: destination.path))
        let second = try #require(sent.last)
        #expect((second["read"] as? [String: Any])?["readId"] as? String == "read")
        var last = try page(second, text: "好", from: 3, through: 6, end: 6); last["contentFinal"] = false
        reader.consume(last, runtimeId: "runtime")
        try await waitFor { !reader.exporting }
        #expect(reader.exportComplete); #expect(reader.exportedBytes == 6); #expect(!reader.final)
        #expect(reader.exportedPath == destination.path); #expect(reader.text.isEmpty)
        #expect(try String(contentsOf: destination, encoding: .utf8) == "你好")
        reader.close(); #expect(FileManager.default.fileExists(atPath: destination.path))
    }

    @Test func cancellingOrClosingAnExportDeletesItsPartialFileAndRetiresPendingPages() async throws {
        for close in [false, true] {
            let root = exportRoot(), destination = root.appendingPathComponent("cancelled.txt")
            defer { try? FileManager.default.removeItem(at: root) }
            let reader = ToolContentReader(); var sent: [[String: Any]] = []
            reader.send = { _, request in sent.append(request); return true }; reader.open(runtimeId: "runtime", locator: locator)
            let original = sent.first?["requestId"] as? String
            reader.export(to: destination)
            try await waitFor { sent.last?["type"] as? String == "session.tool.content.read" && sent.last?["requestId"] as? String != original }
            reader.consume(try page(sent.last!, text: "a", from: 0, through: 1, end: 2), runtimeId: "runtime")
            try await waitFor { reader.exportedBytes == 1 && sent.last?["offset"] as? Int64 == 1 }
            let late = try page(sent.last!, text: "b", from: 1, through: 2, end: 2)
            if close { reader.close() } else { reader.cancelExport() }
            reader.consume(late, runtimeId: "runtime")
            try await waitFor { ((try? FileManager.default.contentsOfDirectory(atPath: root.path)) ?? []).isEmpty }
            #expect(!reader.exporting); #expect(!reader.exportComplete); #expect(reader.exportedPath == nil)
            #expect(!FileManager.default.fileExists(atPath: destination.path))
        }
    }

    @Test func oversizedOrGappedExportsFailAndPreserveExistingDestinationFiles() async throws {
        for gaps in [false, true] {
            let root = exportRoot(), destination = root.appendingPathComponent("incomplete.txt")
            defer { try? FileManager.default.removeItem(at: root) }
            let reader = ToolContentReader(); var sent: [[String: Any]] = []
            reader.send = { _, request in sent.append(request); return true }; reader.open(runtimeId: "runtime", locator: locator)
            let original = sent.first?["requestId"] as? String
            reader.export(to: destination)
            try await waitFor { sent.last?["type"] as? String == "session.tool.content.read" && sent.last?["requestId"] as? String != original }
            var response = try page(sent.last!, text: "a", from: 0, through: 1, end: gaps ? 1 : ToolContentReader.exportByteLimit + 1)
            if gaps { response["observedThroughOffset"] = 2; response["gaps"] = [["fromOffset": 1, "throughOffset": 2, "reason": "source-missing"]] }
            reader.consume(response, runtimeId: "runtime")
            try await waitFor { !reader.exporting && ((try? FileManager.default.contentsOfDirectory(atPath: root.path)) ?? []).isEmpty }
            #expect(reader.exportError != nil); #expect(!reader.exportComplete); #expect(reader.exportedPath == nil)
        }
        let root = exportRoot(), destination = root.appendingPathComponent("existing.txt")
        defer { try? FileManager.default.removeItem(at: root) }
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        try Data("keep".utf8).write(to: destination)
        let reader = ToolContentReader(); reader.send = { _, _ in true }; reader.open(runtimeId: "runtime", locator: locator)
        reader.export(to: destination); try await waitFor { !reader.exporting }
        #expect(reader.exportError != nil); #expect(try String(contentsOf: destination, encoding: .utf8) == "keep")
        reader.close()
    }

    @Test func pendingExportCancellationAndSourceVersionFailureReleaseTheRead() async throws {
        let root = exportRoot(), firstPath = root.appendingPathComponent("pending.txt"), secondPath = root.appendingPathComponent("version.txt")
        defer { try? FileManager.default.removeItem(at: root) }
        let reader = ToolContentReader(); var sent: [[String: Any]] = []
        reader.send = { _, request in sent.append(request); return true }; reader.open(runtimeId: "runtime", locator: locator)
        let initial = sent.first?["requestId"] as? String
        reader.export(to: firstPath)
        try await waitFor { sent.last?["type"] as? String == "session.tool.content.read" && sent.last?["requestId"] as? String != initial }
        reader.cancelExport()
        #expect(sent.last?["type"] as? String == "session.tool.content.cancel")
        #expect(sent.last?["readId"] as? String == "cancel-pending")
        try await waitFor { ((try? FileManager.default.contentsOfDirectory(atPath: root.path)) ?? []).isEmpty }
        let requestCount = sent.filter { $0["type"] as? String == "session.tool.content.read" }.count
        reader.export(to: secondPath)
        try await waitFor { sent.filter { $0["type"] as? String == "session.tool.content.read" }.count > requestCount }
        reader.consume(try page(sent.last!, text: "a", from: 0, through: 1, end: 2), runtimeId: "runtime")
        try await waitFor { reader.exportedBytes == 1 && sent.last?["offset"] as? Int64 == 1 }
        var changed = try page(sent.last!, text: "b", from: 1, through: 2, end: 2)
        changed["read"] = ["readId": "other", "contentEpoch": "new-version", "throughOffset": 2]
        reader.consume(changed, runtimeId: "runtime")
        try await waitFor { !reader.exporting && ((try? FileManager.default.contentsOfDirectory(atPath: root.path)) ?? []).isEmpty }
        #expect(reader.exportError != nil); #expect(reader.exportedPath == nil); #expect(reader.text.isEmpty)
        reader.close()
    }

    @Test func exportPreservesTheViewerCacheAndResumesAtItsOwnCursor() async throws {
        for cancel in [false, true] {
            let root = exportRoot(), destination = root.appendingPathComponent("output.txt")
            defer { try? FileManager.default.removeItem(at: root) }
            let reader = ToolContentReader(); var sent: [[String: Any]] = []
            reader.send = { _, request in sent.append(request); return true }
            reader.open(runtimeId: "runtime", locator: locator)
            reader.consume(try page(sent.last!, text: "a", from: 0, through: 1, end: 3), runtimeId: "runtime")
            let original = sent.last?["requestId"] as? String
            reader.export(to: destination)
            try await waitFor { sent.last?["type"] as? String == "session.tool.content.read" && sent.last?["requestId"] as? String != original }
            if cancel { reader.cancelExport() }
            else {
                reader.consume(try page(sent.last!, text: "abc", from: 0, through: 3, end: 3), runtimeId: "runtime")
                try await waitFor { reader.exportComplete }
                #expect(try String(contentsOf: destination, encoding: .utf8) == "abc")
            }
            #expect(reader.text == "a"); #expect(reader.throughOffset == 1); #expect(reader.nextCursor == 1)
            reader.loadNext()
            #expect(sent.last?["offset"] as? Int64 == 1)
            #expect(sent.last?["read"] is NSNull)
            reader.consume(try page(sent.last!, text: "bc", from: 1, through: 3, end: 3), runtimeId: "runtime")
            #expect(reader.text == "abc"); #expect(reader.nextCursor == nil)
            reader.close()
        }
    }

}
