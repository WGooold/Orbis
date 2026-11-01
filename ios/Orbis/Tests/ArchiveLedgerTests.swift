import Foundation
import Testing
@testable import OrbisCore

/// ADR-0049 §6.4 `archive`：归档 / 取消归档经操作账本结算。Android `ArchiveLedgerTest.kt` 与本文件用例一一对应。
@Suite("Session archive through the operation ledger (ADR-0049 §6.4)") @MainActor
struct ArchiveLedgerTests {
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
        func pair(qr: PairingQR, deviceName: String, identity: DeviceIdentity, completion: @escaping (Result<HostPairing, Error>) -> Void) {
            completion(.failure(PairingError.invalidQR))
        }
        func connect(pairing: HostPairing, identity: DeviceIdentity, receive: @escaping ([String: Any], String?) -> Void, state: @escaping (ConnectionState, String?) -> Void) {
            self.receive = receive; self.state = state; state(.connecting, nil)
        }
        func disconnect() {}
        func send(_ object: [String: Any]) -> Bool { sent.append(object); return true }
        func emit(_ object: [String: Any]) async { receive?(object, "ctl"); await drain?() }
        func ready() async { await emit(["type": "device.ready", "modelEpoch": "epoch", "runtimes": []]) }
        /// 回复最近一次 `session.list`：完整目录。
        func catalog(_ archived: [String: Bool]) async throws {
            let request = try #require(sent.last { $0["type"] as? String == "session.list" })
            await emit(["type": "session.list.result", "requestId": request["requestId"]!, "sessions": archived.keys.sorted().map { id in
                ["sessionId": id, "cwd": "/repo", "createdAt": 1, "modifiedAt": 1, "messageCount": 0, "agentKind": "codex", "archived": archived[id]!] as [String: Any]
            }])
        }
        var archiveIds: [String] { sent.filter { $0["type"] as? String == "session.archive" }.compactMap { $0["requestId"] as? String } }
        var reads: [[String: Any]] { sent.filter { $0["type"] as? String == "agent.state.request" && $0["scope"] as? String == "device" } }
        func answerRead(_ receipts: [String: String]) async throws {
            let request = try #require(reads.last)
            let items = Dictionary(uniqueKeysWithValues: receipts.map { id, state in
                (id, ["operationId": id, "runtimeId": "host-1", "requestId": id, "state": state, "at": 1, "detail": "agent_unsupported"] as [String: Any])
            })
            await emit(["type": "agent.state.snapshot", "requestId": request["requestId"]!, "scope": "device", "modelEpoch": "epoch",
                        "domains": [["domain": "operations", "modelEpoch": "epoch", "revision": 1, "availability": "ready",
                                     "completeness": "partial", "checkedAt": 1, "value": items,
                                     "source": ["producer": "host", "sourceId": "host:device-operations", "sourceEpoch": "e", "sourceRevision": 1]]],
                        "missing": [], "truncated": false])
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

    private func setup(_ catalog: [String: Bool] = ["s1": false, "s2": false]) async throws -> (HostConnection, Transport, Fixture) {
        let fixture = Fixture()
        await fixture.transport.ready()
        try await fixture.transport.catalog(catalog)
        return (fixture.host, fixture.transport, fixture)
    }

    private func session(_ host: HostConnection, _ id: String) throws -> SessionSummary {
        try #require(host.sessions.first { $0.sessionId == id })
    }
    private func archived(_ host: HostConnection, _ id: String) -> Bool {
        host.visibleSessions.first { $0.sessionId == id }?.archived == true
    }
    private func reconnect(_ host: HostConnection, _ transport: Transport) async {
        transport.state?(.offline, nil)
        host.reconnectSelectedHost()
        await transport.ready()
    }

    @Test func archiveMovesAtOnceAndLandsOnTheChangeNotice() async throws {
        let (host, transport, fixture) = try await setup(); defer { withExtendedLifetime(fixture) {} }
        host.archive(try session(host, "s1"), archived: true)
        #expect(archived(host, "s1"))
        #expect(host.isArchiving("s1"))
        let id = try #require(transport.archiveIds.last)
        await transport.emit(["type": "session.archive.changed", "requestId": id, "agentKind": "codex", "sessionId": "s1", "archived": true])
        #expect(host.ledger.operations.isEmpty)
        #expect(host.errorMessage == nil)
    }

    @Test func aCatalogAlreadyShowingTheTargetLands() async throws {
        let (host, transport, fixture) = try await setup(); defer { withExtendedLifetime(fixture) {} }
        host.archive(try session(host, "s1"), archived: true)
        host.reconnectSelectedHost() // 只为再发一次 session.list
        await transport.ready()
        try await transport.catalog(["s1": true, "s2": false])
        #expect(host.ledger.operations.isEmpty)
        #expect(archived(host, "s1"))
    }

    @Test func aRejectionReturnsTheCardWithItsReason() async throws {
        let (host, transport, fixture) = try await setup(); defer { withExtendedLifetime(fixture) {} }
        host.archive(try session(host, "s1"), archived: true)
        let id = try #require(transport.archiveIds.last)
        await transport.emit(["type": "protocol.error", "code": "agent_unsupported", "message": "对应的 agent 后端未就绪", "requestId": id])
        #expect(!archived(host, "s1"))
        #expect(host.ledger.operations.isEmpty)
        #expect(host.errorMessage == "归档未完成：对应的 agent 后端未就绪")
        #expect(host.connection == .secured)
    }

    @Test func restoringFromTheArchiveUsesItsOwnWording() async throws {
        let (host, transport, fixture) = try await setup(["s1": true]); defer { withExtendedLifetime(fixture) {} }
        host.archive(try session(host, "s1"), archived: false)
        #expect(!archived(host, "s1"))
        let id = try #require(transport.archiveIds.last)
        await transport.emit(["type": "protocol.error", "code": "failed", "message": "磁盘只读", "requestId": id])
        #expect(archived(host, "s1"))
        #expect(host.errorMessage == "恢复未完成：磁盘只读")
    }

    @Test func disconnectKeepsTheTargetListAndTheDeviceReceiptDecides() async throws {
        let (host, transport, fixture) = try await setup(); defer { withExtendedLifetime(fixture) {} }
        host.archive(try session(host, "s1"), archived: true)
        let id = try #require(transport.archiveIds.last)
        transport.state?(.offline, nil)
        #expect(archived(host, "s1"))
        host.reconnectSelectedHost()
        await transport.ready()
        try await transport.answerRead([id: "success"])
        #expect(host.ledger.operations.isEmpty)
        #expect(host.errorMessage == nil)
    }

    @Test func batchRejectionsAfterReconnectNameTheCount() async throws {
        let (host, transport, fixture) = try await setup(); defer { withExtendedLifetime(fixture) {} }
        host.archive(try session(host, "s1"), archived: true)
        host.archive(try session(host, "s2"), archived: true)
        let ids = transport.archiveIds
        await reconnect(host, transport)
        try await transport.answerRead([ids[0]: "failure", ids[1]: "failure"])
        #expect(!archived(host, "s1") && !archived(host, "s2"))
        #expect(host.errorMessage == "2 个会话归档未完成：agent_unsupported")
    }

    @Test func noReceiptAndTheOldCatalogAfterReconnectRestoreAsUnconfirmed() async throws {
        let (host, transport, fixture) = try await setup(); defer { withExtendedLifetime(fixture) {} }
        host.archive(try session(host, "s1"), archived: true)
        await reconnect(host, transport)
        try await transport.catalog(["s1": false, "s2": false])
        try await transport.answerRead([:])
        #expect(!archived(host, "s1"))
        #expect(host.errorMessage == "归档未完成：电脑上的会话目录仍是原状态")
    }

    @Test func aSecondArchiveOfTheSameSessionIsBlockedUntilSettled() async throws {
        let (host, transport, fixture) = try await setup(); defer { withExtendedLifetime(fixture) {} }
        host.archive(try session(host, "s1"), archived: true)
        host.archive(try session(host, "s1"), archived: false)
        #expect(transport.archiveIds.count == 1)
        #expect(archived(host, "s1"))
    }

    @Test func noReceiptWithinTheBudgetAsksForARead() async throws {
        let (host, transport, fixture) = try await setup(); defer { withExtendedLifetime(fixture) {} }
        host.archive(try session(host, "s1"), archived: true)
        let reads = transport.reads.count
        host.advanceLedgerClock(to: Date().addingTimeInterval(61))
        #expect(transport.reads.count == reads + 1)
        #expect(archived(host, "s1"))
    }
}
