import Foundation
import Testing
@testable import OrbisCore

@Suite("Host owned runtime notifications") @MainActor
struct NotificationsTests {
    @MainActor private final class Harness {
        let state = RuntimeNotifications(retryDelaysNanoseconds: [1_000_000, 2_000_000])
        var sent: [[String: Any]] = []
        let runtime = RuntimeSummary(runtimeId: "runtime", name: "Agent", cwd: "/repo", status: "idle", sessionId: "session")
        let other = RuntimeSummary(runtimeId: "other", name: "Agent", cwd: "/other", status: "idle", sessionId: "other-session")
        init() {
            state.send = { [weak self] in self?.sent.append($0); return true }
            connect(); state.ready(epoch: "host-epoch", runtimes: [runtime, other])
        }
        func connect(_ connected: Bool = true, host: String = "host") {
            state.setConnection(HostPairing(hostId: host, hostName: host, hostPub: "pub", pskRoot: "root",
                relay: RelayCredential(relayUrl: "wss://example.test", deviceId: "device", credential: "credential"), lan: []), connected: connected)
        }
        func syncCount(_ runtimeId: String) -> Int {
            sent.filter { $0["type"] as? String == "notification.sync" && $0["runtimeId"] as? String == runtimeId }.count
        }
        func receive(_ revision: Int64, _ notices: [[String: Any]], runtime: String = "runtime", session: String? = "session",
                     epoch: String = "host-epoch", complete: Bool = true, removed: [String] = []) {
            var message: [String: Any] = ["type": "notification.snapshot", "protocolVersion": orbisProtocolVersion,
                "hostEpoch": epoch, "runtimeId": runtime, "revision": revision, "complete": complete,
                "verification": "confirmed", "notifications": notices, "removedNotificationIds": removed]
            message["sessionId"] = session.map { $0 as Any } ?? NSNull()
            #expect(state.consume(message))
        }
    }
    private func notice(_ id: String, outcome: Bool = false) -> [String: Any] {
        var row: [String: Any] = ["notificationId": id, "producerEpoch": "producer", "code": id,
            "occurrenceId": "occurrence", "scope": ["turnId": "turn"], "severity": "warning", "message": id,
            "lifecycle": outcome ? "outcome" : "condition", "createdAt": 1, "updatedAt": 1, "verification": "confirmed"]
        if outcome { row["displayMs"] = 8000; row["expiresAt"] = 9000 }
        return row
    }

    @Test func completeInventoriesRepairLostClearsWithoutChatOrTransportVersions() {
        let h = Harness()
        h.receive(1, [notice("retry"), notice("sandbox")])
        h.receive(7, [notice("sandbox")])
        h.receive(2, [notice("retry")])
        #expect(h.state.projections["runtime"]?.items.map(\.code) == ["sandbox"])
        h.receive(1, [notice("other")], runtime: "other", session: "other-session")
        h.receive(8, [])
        #expect(h.state.projections["runtime"]?.items.isEmpty == true)
        #expect(h.state.projections["other"]?.items.map(\.code) == ["other"])
    }

    @Test func partialInventoriesPreserveConditionsAndOnlyApplyHostRemovalProofs() {
        let h = Harness()
        h.receive(1, [notice("retry"), notice("done", outcome: true)])
        // Even an expired wall-clock timestamp is retained until the Host removes it.
        #expect(h.state.projections["runtime"]?.items.count == 2)
        h.receive(2, [notice("unverified")], complete: false)
        #expect(h.state.projections["runtime"]?.items.map(\.code) == ["retry", "done"])
        #expect(h.state.projections["runtime"]?.verification == "unknown")
        h.receive(3, [], complete: false, removed: ["done"])
        #expect(h.state.projections["runtime"]?.items.map(\.code) == ["retry"])
        h.receive(4, [])
        #expect(h.state.projections["runtime"]?.items.isEmpty == true)
    }

    @Test func authenticatedReadyControlsEpochAndOfflineKeepsLastSessionBinding() {
        let h = Harness()
        h.receive(10, [notice("old")])
        h.receive(99, [], epoch: "unannounced")
        #expect(h.state.projections["runtime"]?.items.count == 1)
        h.state.ready(epoch: "new", runtimes: [h.runtime])
        h.receive(0, [], epoch: "new")
        h.receive(11, [notice("old")])
        #expect(h.state.projections["runtime"]?.items.isEmpty == true)
        h.state.offline(runtimeId: "runtime")
        h.receive(1, [notice("terminal")], epoch: "new")
        #expect(h.state.projections["runtime"]?.items.first?.code == "terminal")
        h.receive(2, [], session: nil, epoch: "new")
        #expect(h.state.projections["runtime"]?.items.isEmpty == true)
        h.connect(host: "different")
        #expect(h.state.projections.isEmpty)
    }

    @Test func sessionChangesAndMalformedInventoriesCannotMutateCommittedFacts() {
        let h = Harness()
        h.receive(1, [notice("valid")])
        h.receive(2, [notice("old-session")], session: "retired")
        h.receive(2, [notice("duplicate"), notice("duplicate")])
        var invalid = notice("condition"); invalid["expiresAt"] = 99
        h.receive(2, [invalid])
        var oversized = notice("oversized"); oversized["message"] = String(repeating: "中", count: 1366)
        h.receive(2, [oversized])
        var invalidTime = notice("time"); invalidTime["updatedAt"] = 0
        h.receive(2, [invalidTime])
        h.receive(2, [notice("both")], removed: ["both"])
        #expect(h.state.projections["runtime"]?.items.map(\.code) == ["valid"])
        var switched = h.runtime; switched.sessionId = "new-session"
        h.state.online(switched)
        h.receive(3, [], session: "new-session", complete: false)
        #expect(h.state.projections["runtime"]?.items.isEmpty == true)
    }

    @Test func retriesAreBoundedAndEqualRevisionReceiptStopsRecovery() async throws {
        let h = Harness()
        try await waitUntil { h.syncCount("runtime") == 3 && h.syncCount("other") == 3 }
        h.receive(1, [notice("active")])
        let start = h.syncCount("runtime")
        h.state.sync(runtimeId: "runtime")
        h.receive(1, [notice("different-but-same-revision")])
        try await Task.sleep(nanoseconds: 15_000_000)
        #expect(h.syncCount("runtime") == start + 1)
        #expect(h.state.projections["runtime"]?.items.map(\.code) == ["active"])
        let disconnectStart = h.syncCount("runtime")
        h.state.sync(runtimeId: "runtime"); h.connect(false)
        try await Task.sleep(nanoseconds: 15_000_000)
        #expect(h.syncCount("runtime") == disconnectStart + 1)
    }

    @Test func dismissRequiresHostProofAndDoesNotRemoveOptimistically() async throws {
        let h = Harness()
        h.receive(1, [notice("condition"), notice("done", outcome: true)])
        h.state.dismiss(runtimeId: "runtime", notificationId: "done")
        let dismissal = h.sent.first { $0["type"] as? String == "notification.dismiss" }
        #expect(dismissal?["hostEpoch"] as? String == "host-epoch")
        #expect(h.state.projections["runtime"]?.items.count == 2)
        h.receive(2, [], complete: false, removed: ["done"])
        #expect(h.state.projections["runtime"]?.items.map(\.code) == ["condition"])
        let start = h.syncCount("runtime")
        // Wait for the independent Runtime to finish its bounded retry schedule.
        // Its sends must not be mistaken for retries of the acknowledged Runtime.
        try await waitUntil { h.syncCount("other") == 3 }
        #expect(h.syncCount("runtime") == start)
    }

    private func waitUntil(_ condition: @escaping @MainActor () -> Bool) async throws {
        let deadline = Date().addingTimeInterval(1)
        while !condition() && Date() < deadline { try await Task.sleep(nanoseconds: 1_000_000) }
        try #require(condition(), "Timed out waiting for the bounded notification retry schedule")
    }
}
