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
}
