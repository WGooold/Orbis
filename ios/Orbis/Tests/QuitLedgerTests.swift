// Orbis 测试用途（场景与判定见本文件断言）：
// - OPT-01 `quit`（V11 r27）（V11）
import Foundation
import Testing
@testable import OrbisCore

/// ADR-0049 §7.5 `quit`：首页关闭经操作账本结算。Android `QuitLedgerTest.kt` 与本文件用例一一对应。
@Suite("Home close through the operation ledger (ADR-0049 §7)") @MainActor
struct QuitLedgerTests {
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
        func ready(_ ids: [String]) async {
            await emit(["type": "device.ready", "modelEpoch": "epoch", "runtimes": ids.map {
                ["runtimeId": $0, "sessionId": "session-" + $0, "name": "Agent", "cwd": "/repo", "status": "idle"]
            }])
            for id in ids {
                await event(id, ["type": "runtime.capabilities", "capabilities": ["commands": [["name": "quit", "source": "builtin"]]]])
            }
        }
        func event(_ runtimeId: String, _ event: [String: Any]) async {
            sequence += 1
            await emit(["type": "runtime.event", "runtimeId": runtimeId, "sequence": sequence, "event": event])
        }
        var quitIds: [String] {
            sent.filter { ($0["command"] as? [String: Any])?["name"] as? String == "quit" }.compactMap { $0["commandId"] as? String }
        }
        var verifyReads: [[String: Any]] {
            sent.filter { $0["type"] as? String == "agent.state.request" && $0["scope"] as? String == "device" }
        }
        /// 回复最近一次核对读取：设备私有回执 `operations` 领域。
        func answerVerify(_ receipts: [String: String]) async throws {
            let request = try #require(verifyReads.last)
            let items = Dictionary(uniqueKeysWithValues: receipts.map { id, state in
                (id, ["operationId": id, "runtimeId": "a", "state": state, "at": 1] as [String: Any])
            })
            await emit(["type": "agent.state.snapshot", "requestId": request["requestId"]!, "scope": "device", "modelEpoch": "epoch",
                        "domains": [["domain": "operations", "modelEpoch": "epoch", "revision": 1, "availability": "ready",
                                     "completeness": "partial", "checkedAt": 1, "value": items,
                                     "source": ["producer": "host", "sourceId": "host:device-operations", "sourceEpoch": "e", "sourceRevision": 1]]],
                        "missing": [], "truncated": false])
        }
    }

    /// 持有 `OrbisStore`：只留下 `HostConnection` 时 Store 会被释放，事件就不再被排空。
    @MainActor private final class Fixture {
        let transport = Transport()
        let store: OrbisStore
        var host: HostConnection { store.activeConnection }
        init() {
            store = OrbisStore(secure: Storage(), transport: transport, preferences: nil)
            transport.drain = { [weak store] in await store?.waitForPendingEvents() }
        }
    }

    private func setup(_ ids: [String] = ["a", "b"]) async -> (HostConnection, Transport, Fixture) {
        let fixture = Fixture()
        await fixture.transport.ready(ids)
        return (fixture.host, fixture.transport, fixture)
    }

    private func reconnect(_ host: HostConnection, _ transport: Transport, online ids: [String]) async {
        host.reconnectSelectedHost()
        await transport.ready(ids)
    }

    @Test func closeHidesAtOnceAndLandsWhenTheRuntimeGoesOffline() async throws {
        let (host, transport, fixture) = await setup(); defer { withExtendedLifetime(fixture) {} }
        #expect(host.closeRuntimes(["a"]) == ["a"])
        #expect(host.closingRuntimeIds == ["a"])
        let id = try #require(transport.quitIds.last)
        await transport.event("a", ["type": "command.result", "commandId": id, "ok": true])
        #expect(host.closingRuntimeIds == ["a"])
        await transport.emit(["type": "runtime.offline", "runtimeId": "a"])
        #expect(host.closingRuntimeIds.isEmpty)
        #expect(host.ledger.operations.isEmpty)
        #expect(host.errorMessage == nil)
    }

    @Test func explicitRejectionRestoresTheCardWithItsReason() async throws {
        let (host, transport, fixture) = await setup(); defer { withExtendedLifetime(fixture) {} }
        _ = host.closeRuntimes(["a", "b"])
        let ids = transport.quitIds
        #expect(ids.count == 2)
        await transport.event("a", ["type": "command.result", "commandId": ids[0], "ok": false, "error": "会话正忙"])
        #expect(host.closingRuntimeIds == ["b"])
        #expect(host.errorMessage == "关闭会话未完成：会话正忙")
    }

    @Test func protocolErrorForTheCommandIsARejection() async throws {
        let (host, transport, fixture) = await setup(); defer { withExtendedLifetime(fixture) {} }
        _ = host.closeRuntimes(["a"])
        let id = try #require(transport.quitIds.last)
        await transport.emit(["type": "protocol.error", "code": "runtime_offline", "message": "runtime a 当前没有在本机运行", "commandId": id])
        #expect(host.closingRuntimeIds.isEmpty)
        #expect(host.errorMessage == "关闭会话未完成：runtime a 当前没有在本机运行")
    }

    @Test func acceptedButStillOnlineAfterFifteenSecondsRestores() async throws {
        let (host, transport, fixture) = await setup(); defer { withExtendedLifetime(fixture) {} }
        _ = host.closeRuntimes(["a"])
        let id = try #require(transport.quitIds.last)
        await transport.event("a", ["type": "command.result", "commandId": id, "ok": true])
        host.advanceLedgerClock(to: Date().addingTimeInterval(14))
        #expect(host.closingRuntimeIds == ["a"])
        host.advanceLedgerClock(to: Date().addingTimeInterval(16))
        #expect(host.closingRuntimeIds.isEmpty)
        #expect(host.errorMessage == OperationKinds.quitStillRunning.reason)
    }

    @Test func disconnectKeepsTheCardHiddenWithoutAnError() async throws {
        let (host, transport, fixture) = await setup(); defer { withExtendedLifetime(fixture) {} }
        _ = host.closeRuntimes(["a"])
        transport.state?(.offline, nil)
        #expect(host.closingRuntimeIds == ["a"])
        #expect(host.ledger.operations.first?.phase == .unknown)
        #expect(host.errorMessage == nil)
    }

    @Test func reconnectStillOnlineWithoutReceiptRestoresAsUnconfirmed() async throws {
        let (host, transport, fixture) = await setup(); defer { withExtendedLifetime(fixture) {} }
        _ = host.closeRuntimes(["a"])
        transport.state?(.offline, nil)
        await reconnect(host, transport, online: ["a", "b"])
        // 只有完整在线列表还不够：设备私有回执读回之前不下结论（L5）。
        #expect(host.closingRuntimeIds == ["a"])
        try await transport.answerVerify([:])
        #expect(host.closingRuntimeIds.isEmpty)
        #expect(host.errorMessage == OperationKinds.quitUnconfirmed.reason)
    }

    @Test func reconnectWithTheRuntimeGoneLandsSilently() async throws {
        let (host, transport, fixture) = await setup(); defer { withExtendedLifetime(fixture) {} }
        _ = host.closeRuntimes(["a"])
        transport.state?(.offline, nil)
        await reconnect(host, transport, online: ["b"])
        #expect(host.closingRuntimeIds.isEmpty)
        #expect(host.ledger.operations.isEmpty)
        #expect(host.errorMessage == nil)
    }

    @Test func reconnectReceiptOfSuccessStartsTheFifteenSecondRule() async throws {
        let (host, transport, fixture) = await setup(); defer { withExtendedLifetime(fixture) {} }
        _ = host.closeRuntimes(["a"])
        let id = try #require(transport.quitIds.last)
        transport.state?(.offline, nil)
        await reconnect(host, transport, online: ["a", "b"])
        try await transport.answerVerify([id: "success"])
        #expect(host.closingRuntimeIds == ["a"])
        host.advanceLedgerClock(to: Date().addingTimeInterval(16))
        #expect(host.closingRuntimeIds.isEmpty)
        #expect(host.errorMessage == OperationKinds.quitStillRunning.reason)
    }

    @Test func lateReceiptOnTheNewConnectionStillSettles() async throws {
        let (host, transport, fixture) = await setup(); defer { withExtendedLifetime(fixture) {} }
        _ = host.closeRuntimes(["a"])
        let id = try #require(transport.quitIds.last)
        transport.state?(.offline, nil)
        await reconnect(host, transport, online: ["a", "b"])
        await transport.event("a", ["type": "command.result", "commandId": id, "ok": false, "error": "不支持"])
        #expect(host.closingRuntimeIds.isEmpty)
        #expect(host.errorMessage == "关闭会话未完成：不支持")
    }

    @Test func missingReceiptWithinTheBudgetVerifiesOnTheSameConnection() async throws {
        let (host, transport, fixture) = await setup(); defer { withExtendedLifetime(fixture) {} }
        _ = host.closeRuntimes(["a"])
        let reads = transport.verifyReads.count
        host.advanceLedgerClock(to: Date().addingTimeInterval(61))
        #expect(host.closingRuntimeIds == ["a"])
        #expect(transport.verifyReads.count == reads + 1)
        try await transport.answerVerify([:])
        #expect(host.closingRuntimeIds.isEmpty)
        #expect(host.errorMessage == OperationKinds.quitUnconfirmed.reason)
    }

    @Test func failedVerifyReadStillVerifiesAgainstTheOnlineList() async throws {
        let (host, transport, fixture) = await setup(); defer { withExtendedLifetime(fixture) {} }
        _ = host.closeRuntimes(["a"])
        host.advanceLedgerClock(to: Date().addingTimeInterval(61))
        let request = try #require(transport.verifyReads.last)
        await transport.emit(["type": "protocol.error", "code": "invalid_message", "message": "bad", "requestId": request["requestId"]!])
        #expect(host.closingRuntimeIds.isEmpty)
        #expect(host.errorMessage == OperationKinds.quitUnconfirmed.reason)
        #expect(host.connection == .secured)
    }

    @Test func aRepeatedCloseOfTheSameRuntimeIsNotSentTwice() async throws {
        let (host, transport, fixture) = await setup(); defer { withExtendedLifetime(fixture) {} }
        _ = host.closeRuntimes(["a"])
        #expect(host.closeRuntimes(["a"]) == ["a"])
        #expect(transport.quitIds.count == 1)
    }

    @Test func shutdownExpiresEveryOperationSilently() async throws {
        let (host, _, fixture) = await setup(); defer { withExtendedLifetime(fixture) {} }
        _ = host.closeRuntimes(["a"])
        host.shutdown()
        #expect(host.ledger.operations.isEmpty)
        #expect(host.errorMessage == nil)
    }
}
