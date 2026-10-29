import Foundation
import Testing
@testable import OrbisCore

@Suite("Tool inventory failure lifecycle")
@MainActor
struct ToolInventoryFailureTests {
    private func reference(revision: Int64 = 1) -> ToolReference {
        ToolReference(projectionVersion: 1, agent: ToolAgent(hostId: "host", agentKind: "pi", sessionId: "session"),
            version: ToolVersion(epoch: "inventory", revision: revision), source: ToolSource(epoch: "source", seq: revision),
            totalCount: 0, summaryBytes: 0)
    }

    @Test func unsentReadReportsTerminalFailureAndCanRetry() {
        let inventory = ToolInventories()
        var failures: [(String, ToolReference?, String)] = []
        var sent: [[String: Any]] = []
        let target = reference()
        inventory.didFail = { runtime, failed, reason in
            #expect(!inventory.loading.contains(runtime))
            failures.append((runtime, failed, reason))
        }
        inventory.require(target, runtime: "runtime")
        #expect(failures.count == 1)
        #expect(failures.first?.0 == "runtime")
        #expect(failures.first?.1 == target)
        #expect(failures.first?.2.contains("未送达") == true)
        inventory.send = { _, command in sent.append(command); return true }
        inventory.retry("runtime")
        #expect(inventory.loading.contains("runtime"))
        #expect(sent.last?["type"] as? String == "session.tools.open")
        #expect(failures.count == 1)
        inventory.clear()
    }

    @Test func hostFailureUsesLatestDesiredReferenceAndIgnoresDuplicates() throws {
        let inventory = ToolInventories()
        var sent: [[String: Any]] = []
        var failures: [ToolReference?] = []
        inventory.send = { _, command in sent.append(command); return true }
        inventory.didFail = { _, reference, _ in failures.append(reference) }
        inventory.require(reference(), runtime: "runtime")
        let desired = reference(revision: 2)
        inventory.require(desired, runtime: "runtime")
        #expect(sent.count == 1)
        let request = try #require(sent.last?["requestId"] as? String)
        let event: [String: Any] = ["type": "session.tool.read.failed", "requestId": request,
            "runtimeId": "runtime", "reason": "snapshot_expired"]
        inventory.consume(event, runtime: "runtime")
        inventory.consume(event, runtime: "runtime")
        #expect(failures.count == 1)
        #expect(failures.first == desired)
        #expect(!inventory.loading.contains("runtime"))
        inventory.retry("runtime")
        #expect(sent.count == 2)
        let reopened = try #require(sent.last?["reference"] as? [String: Any])
        let version = try #require(reopened["version"] as? [String: Any])
        #expect(version["revision"] as? Int == 2)
        inventory.clear()
    }

    @Test func timeoutNotifiesOwnerOnceAndStopsLoading() async throws {
        let inventory = ToolInventories(readTimeoutNanoseconds: 1_000_000)
        var failures: [(ToolReference?, String)] = []
        inventory.send = { _, _ in true }
        inventory.didFail = { _, reference, reason in failures.append((reference, reason)) }
        let target = reference()
        inventory.require(target, runtime: "runtime")
        let deadline = Date().addingTimeInterval(2)
        while failures.isEmpty && Date() < deadline { try await Task.sleep(nanoseconds: 1_000_000) }
        #expect(failures.count == 1)
        #expect(failures.first?.0 == target)
        #expect(failures.first?.1.contains("超时") == true)
        #expect(!inventory.loading.contains("runtime"))
        inventory.clear()
    }

    @Test func invalidInitialReferenceReportsThatReference() {
        let inventory = ToolInventories()
        var failures: [ToolReference?] = []
        let invalid = reference(revision: 0)
        inventory.didFail = { _, reference, _ in failures.append(reference) }
        inventory.require(invalid, runtime: "runtime")
        #expect(failures.count == 1)
        #expect(failures.first == invalid)
        #expect(!inventory.loading.contains("runtime"))
    }
}
