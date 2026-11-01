import Foundation
import Testing
@testable import OrbisCore

/// ADR-0049 §6.3 `queueCancel`：撤回排队消息经操作账本结算。Android `QueueCancelLedgerTest.kt` 与本文件用例一一对应。
@Suite("Queued message withdrawal through the operation ledger (ADR-0049 §6.3)") @MainActor
struct QueueCancelLedgerTests {
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
        var sequence = 0
        func pair(qr: PairingQR, deviceName: String, identity: DeviceIdentity, completion: @escaping (Result<HostPairing, Error>) -> Void) {
            completion(.failure(PairingError.invalidQR))
        }
        func connect(pairing: HostPairing, identity: DeviceIdentity, receive: @escaping ([String: Any], String?) -> Void, state: @escaping (ConnectionState, String?) -> Void) {
            self.receive = receive; self.state = state; state(.connecting, nil)
        }
        func disconnect() {}
        func send(_ object: [String: Any]) -> Bool { sent.append(object); return true }
        func emit(_ object: [String: Any]) async { receive?(object, "ctl"); await drain?() }
        func ready() async {
            await emit(["type": "device.ready", "modelEpoch": "epoch", "runtimes": [
                ["runtimeId": "a", "sessionId": "session-a", "name": "Agent", "cwd": "/repo", "status": "running"]
            ]])
        }
        func event(_ event: [String: Any]) async {
            sequence += 1
            await emit(["type": "runtime.event", "runtimeId": "a", "sequence": sequence, "event": event])
        }
        /// Host 队列：queueId -> state。
        func queue(_ items: [String: String], complete: Bool = true) async {
            await event(["type": "delivery.snapshot", "complete": complete, "items": items.keys.sorted().map { id in
                ["queueId": id, "text": "text " + id, "delivery": "followUp", "state": items[id]!]
            }])
        }
        var cancelIds: [String] {
            sent.filter { ($0["command"] as? [String: Any])?["type"] as? String == "user_message.cancel" }.compactMap { $0["commandId"] as? String }
        }
        var reads: [[String: Any]] { sent.filter { $0["type"] as? String == "agent.state.request" && $0["scope"] as? String == "device" } }
        func result(_ id: String, ok: Bool, status: String, error: String? = nil) async {
            var payload: [String: Any] = ["type": "command.result", "commandId": id, "ok": ok, "status": status]
            if let error { payload["error"] = error }
            await event(payload)
        }
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
        await fixture.transport.queue(["q1": "accepted", "q2": "accepted"])
        return (fixture.host, fixture.transport, fixture)
    }

    private func panel(_ host: HostConnection) -> [String] { host.queuePanelItems("a").map(\.queueId) }
    private func reconnect(_ host: HostConnection, _ transport: Transport) async {
        transport.state?(.offline, nil)
        host.reconnectSelectedHost()
        await transport.ready()
    }

    @Test func withdrawLeavesAtOnceAndLandsOnTheCancelledResult() async throws {
        let (host, transport, fixture) = await setup(); defer { withExtendedLifetime(fixture) {} }
        #expect(host.cancelQueuedMessage("q1"))
        #expect(panel(host) == ["q2"])
        await transport.result(try #require(transport.cancelIds.last), ok: true, status: "cancelled")
        // 成功回执后仍等 Host 队列体现结果，队列项不闪回。
        #expect(panel(host) == ["q2"])
        await transport.queue(["q2": "accepted"])
        #expect(host.ledger.operations.isEmpty)
        #expect(panel(host) == ["q2"])
        #expect(host.errorMessage == nil)
    }

    @Test func aCancelledQueueItemLandsWithoutTheResult() async throws {
        let (host, transport, fixture) = await setup(); defer { withExtendedLifetime(fixture) {} }
        _ = host.cancelQueuedMessage("q1")
        await transport.queue(["q1": "cancelled", "q2": "accepted"])
        #expect(host.ledger.operations.isEmpty)
    }

    @Test func alreadyDeliveredStaysOutOfTheQueueAndSaysSo() async throws {
        let (host, transport, fixture) = await setup(); defer { withExtendedLifetime(fixture) {} }
        _ = host.cancelQueuedMessage("q1")
        await transport.result(try #require(transport.cancelIds.last), ok: false, status: "already_delivered", error: "消息已送达或不存在")
        await transport.queue(["q2": "accepted"])
        #expect(panel(host) == ["q2"])
        #expect(host.errorMessage == "撤回未完成：消息已交给 Agent")
    }

    @Test func aDeliveredQueueItemSettlesAsAlreadyDelivered() async throws {
        let (host, transport, fixture) = await setup(); defer { withExtendedLifetime(fixture) {} }
        _ = host.cancelQueuedMessage("q1")
        await transport.queue(["q1": "delivered", "q2": "accepted"])
        #expect(host.ledger.operations.isEmpty)
        #expect(panel(host) == ["q2"])
        #expect(host.errorMessage == "撤回未完成：消息已交给 Agent")
    }

    @Test func notCancelableReturnsTheItemWithItsReason() async throws {
        let (host, transport, fixture) = await setup(); defer { withExtendedLifetime(fixture) {} }
        _ = host.cancelQueuedMessage("q1")
        await transport.result(try #require(transport.cancelIds.last), ok: false, status: "not_cancelable", error: "DSH 不支持撤回排队消息；请使用停止")
        #expect(panel(host) == ["q1", "q2"])
        #expect(host.errorMessage == "撤回未完成：DSH 不支持撤回排队消息；请使用停止")
    }

    @Test func disconnectBringsTheItemBackMarkedUnconfirmed() async throws {
        let (host, transport, fixture) = await setup(); defer { withExtendedLifetime(fixture) {} }
        _ = host.cancelQueuedMessage("q1")
        transport.state?(.offline, nil)
        #expect(panel(host) == ["q1", "q2"])
        #expect(host.unconfirmedQueueCancellations("a") == ["q1"])
        #expect(host.errorMessage == nil)
    }

    @Test func reconnectStillQueuedClearsTheMarkSilently() async throws {
        let (host, transport, fixture) = await setup(); defer { withExtendedLifetime(fixture) {} }
        _ = host.cancelQueuedMessage("q1")
        await reconnect(host, transport)
        await transport.queue(["q1": "accepted", "q2": "accepted"])
        try await transport.answerRead()
        #expect(host.unconfirmedQueueCancellations("a").isEmpty)
        #expect(panel(host) == ["q1", "q2"])
        #expect(host.ledger.operations.isEmpty)
        #expect(host.errorMessage == nil)
    }

    @Test func reconnectWithTheItemCancelledLands() async throws {
        let (host, transport, fixture) = await setup(); defer { withExtendedLifetime(fixture) {} }
        _ = host.cancelQueuedMessage("q1")
        await reconnect(host, transport)
        await transport.queue(["q1": "cancelled", "q2": "accepted"])
        #expect(host.ledger.operations.isEmpty)
        #expect(host.errorMessage == nil)
    }

    @Test func aSecondWithdrawOfTheSameItemIsBlocked() async throws {
        let (host, transport, fixture) = await setup(); defer { withExtendedLifetime(fixture) {} }
        _ = host.cancelQueuedMessage("q1")
        #expect(!host.cancelQueuedMessage("q1"))
        #expect(transport.cancelIds.count == 1)
    }

    @Test func noReceiptWithinTheBudgetMarksItUnconfirmedAndReads() async throws {
        let (host, transport, fixture) = await setup(); defer { withExtendedLifetime(fixture) {} }
        _ = host.cancelQueuedMessage("q1")
        let reads = transport.reads.count
        host.advanceLedgerClock(to: Date().addingTimeInterval(61))
        #expect(host.unconfirmedQueueCancellations("a") == ["q1"])
        #expect(transport.reads.count == reads + 1)
    }
}
