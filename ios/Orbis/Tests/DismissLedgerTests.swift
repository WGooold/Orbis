import Foundation
import Testing
@testable import OrbisCore

/// ADR-0049 §6.6 `dismiss`：关闭通知经操作账本结算。Android `DismissLedgerTest.kt` 与本文件用例一一对应。
@Suite("Notification dismissal through the operation ledger (ADR-0049 §6.6)") @MainActor
struct DismissLedgerTests {
    private final class Storage: SecureStorage {
        var hosts = [HostPairing(hostId: "host-1", hostName: "Test Host", hostPub: "test-public-key",
            pskRoot: Base64URL.encode(Data(repeating: 1, count: 32)),
            relay: RelayCredential(relayUrl: "wss://relay.example", deviceId: "test-device", credential: "test-only"), lan: [])]
        func deviceIdentity() throws -> DeviceIdentity { .generate() }
        func savePairings(_ pairings: [HostPairing]) throws { hosts = pairings }
        func pairings() -> [HostPairing] { hosts }
    }

    @MainActor private final class Transport: OrbisTransport {
        var sent: [[String: Any]] = []
        var drain: (() async -> Void)?
        var receive: (([String: Any], String?) -> Void)?
        var state: ((ConnectionState, String?) -> Void)?
        var revision: Int64 = 0
        func pair(qr: PairingQR, deviceName: String, identity: DeviceIdentity, completion: @escaping (Result<HostPairing, Error>) -> Void) {
            completion(.failure(PairingError.invalidQR))
        }
        func connect(pairing: HostPairing, identity: DeviceIdentity, receive: @escaping ([String: Any], String?) -> Void, state: @escaping (ConnectionState, String?) -> Void) {
            self.receive = receive; self.state = state; state(.connecting, nil)
        }
        func disconnect() {}
        func send(_ object: [String: Any]) -> Bool { sent.append(object); return true }
        func emit(_ object: [String: Any]) async { receive?(object, "ctl"); await drain?() }
        func ready(epoch: String = "host-epoch") async {
            await emit(["type": "device.ready", "modelEpoch": "epoch", "notificationEpoch": epoch, "runtimes": [
                ["runtimeId": "a", "sessionId": "session-a", "name": "Agent", "cwd": "/repo", "status": "idle"]
            ]])
        }
        func notices(_ ids: [String], complete: Bool = true, removed: [String] = [], epoch: String = "host-epoch") async {
            revision += 1
            await emit(["type": "notification.snapshot", "protocolVersion": orbisProtocolVersion, "hostEpoch": epoch, "runtimeId": "a",
                        "sessionId": "session-a", "revision": revision, "complete": complete, "verification": "confirmed",
                        "notifications": ids.map { id in
                            ["notificationId": id, "producerEpoch": "producer", "code": id, "occurrenceId": "occurrence",
                             "scope": ["turnId": "turn"], "severity": "warning", "message": id, "lifecycle": "condition",
                             "createdAt": 1, "updatedAt": 1, "verification": "confirmed"] as [String: Any]
                        }, "removedNotificationIds": removed])
        }
        var dismissals: [[String: Any]] { sent.filter { $0["type"] as? String == "notification.dismiss" } }
        var reads: [[String: Any]] { sent.filter { $0["type"] as? String == "agent.state.request" && $0["scope"] as? String == "device" } }
        /// 回复最近一次核对读取（本设备没有关闭类回执）。
        func answerRead() async throws {
            let request = try #require(reads.last)
            await emit(["type": "agent.state.snapshot", "requestId": request["requestId"]!, "scope": "device", "modelEpoch": "epoch",
                        "domains": [], "missing": [["domain": "operations", "reason": "no_state"]], "truncated": false])
        }
    }

    @MainActor private final class Fixture {
        let transport = Transport()
        let store: OrbisStore
        var host: HostConnection { store.activeConnection }
        init() {
            store = OrbisStore(secure: Storage(), transport: transport, preferences: nil)
            transport.drain = { [weak store] in await store?.waitForPendingEvents() }
        }
    }

    private func setup() async -> (HostConnection, Transport, Fixture) {
        let fixture = Fixture()
        await fixture.transport.ready()
        await fixture.transport.notices(["retry", "sandbox"])
        return (fixture.host, fixture.transport, fixture)
    }

    private func visible(_ host: HostConnection) -> [String] {
        host.notifications.visibleProjection("a")?.items.map(\.notificationId) ?? []
    }

    @Test func dismissHidesAtOnceAndLandsOnTheHostRemoval() async throws {
        let (host, transport, fixture) = await setup(); defer { withExtendedLifetime(fixture) {} }
        host.dismissNotification(runtimeId: "a", notificationId: "retry")
        #expect(visible(host) == ["sandbox"])
        #expect(transport.dismissals.last?["hostEpoch"] as? String == "host-epoch")
        await transport.notices(["sandbox"], removed: ["retry"])
        #expect(host.ledger.operations.isEmpty)
        #expect(visible(host) == ["sandbox"])
        #expect(host.errorMessage == nil)
    }

    @Test func aStalePushStillListingItDoesNotBringItBack() async throws {
        let (host, transport, fixture) = await setup(); defer { withExtendedLifetime(fixture) {} }
        host.dismissNotification(runtimeId: "a", notificationId: "retry")
        // 推送可能是 Host 处理关闭之前生成的，不能作为反向证据（L2）。
        await transport.notices(["retry", "sandbox"])
        #expect(visible(host) == ["sandbox"])
        #expect(host.ledger.operations.count == 1)
    }

    @Test func theReadAfterTheDismissStillListingItShowsItAgainSilently() async throws {
        let (host, transport, fixture) = await setup(); defer { withExtendedLifetime(fixture) {} }
        host.dismissNotification(runtimeId: "a", notificationId: "retry")
        await transport.notices(["retry", "sandbox"])
        try await transport.answerRead()
        #expect(visible(host) == ["retry", "sandbox"])
        #expect(host.ledger.operations.isEmpty)
        #expect(host.errorMessage == nil)
    }

    @Test func anIncompleteInventoryIsNotNegativeEvidence() async throws {
        let (host, transport, fixture) = await setup(); defer { withExtendedLifetime(fixture) {} }
        host.dismissNotification(runtimeId: "a", notificationId: "retry")
        await transport.notices(["retry"], complete: false)
        try await transport.answerRead()
        #expect(visible(host) == ["sandbox"])
        #expect(host.ledger.operations.count == 1)
    }

    @Test func disconnectKeepsItHiddenAndTheFirstNewInventoryDecides() async throws {
        let (host, transport, fixture) = await setup(); defer { withExtendedLifetime(fixture) {} }
        host.dismissNotification(runtimeId: "a", notificationId: "retry")
        transport.state?(.offline, nil)
        #expect(visible(host) == ["sandbox"])
        host.reconnectSelectedHost()
        await transport.ready()
        // 旧连接留下的清单不能作证：读取回复先到也不下结论。
        try await transport.answerRead()
        #expect(visible(host) == ["sandbox"])
        await transport.notices(["retry", "sandbox"])
        #expect(visible(host) == ["retry", "sandbox"])
        #expect(host.ledger.operations.isEmpty)
    }

    @Test func reconnectWithTheNoticeGoneLands() async throws {
        let (host, transport, fixture) = await setup(); defer { withExtendedLifetime(fixture) {} }
        host.dismissNotification(runtimeId: "a", notificationId: "retry")
        transport.state?(.offline, nil)
        host.reconnectSelectedHost()
        await transport.ready()
        await transport.notices(["sandbox"])
        #expect(host.ledger.operations.isEmpty)
        #expect(visible(host) == ["sandbox"])
    }

    @Test func aNewHostEpochExpiresTheDismissal() async throws {
        let (host, transport, fixture) = await setup(); defer { withExtendedLifetime(fixture) {} }
        host.dismissNotification(runtimeId: "a", notificationId: "retry")
        transport.state?(.offline, nil)
        host.reconnectSelectedHost()
        await transport.ready(epoch: "restarted")
        #expect(host.ledger.operations.isEmpty)
    }

    @Test func noReceiptWithinTheBudgetReadsAndDecides() async throws {
        let (host, transport, fixture) = await setup(); defer { withExtendedLifetime(fixture) {} }
        host.dismissNotification(runtimeId: "a", notificationId: "retry")
        let reads = transport.reads.count
        host.advanceLedgerClock(to: Date().addingTimeInterval(61))
        #expect(transport.reads.count == reads + 1)
        #expect(visible(host) == ["sandbox"])
        try await transport.answerRead()
        #expect(visible(host) == ["retry", "sandbox"])
    }
}
