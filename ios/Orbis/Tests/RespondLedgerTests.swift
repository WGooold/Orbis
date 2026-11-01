import Foundation
import Testing
@testable import OrbisCore

/// ADR-0049 §6.5 `respond`：回答审批 / 问卷经操作账本结算。Android `RespondLedgerTest.kt` 与本文件用例一一对应。
@Suite("Interaction responses through the operation ledger (ADR-0049 §6.5)") @MainActor
struct RespondLedgerTests {
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
        nonisolated static func request(_ id: String, kind: String = "confirm", secret: Bool = false) -> [String: Any] {
            var row: [String: Any] = ["runtimeId": "a", "requestId": id, "extensionId": "test", "kind": kind, "title": "允许操作？",
                                      "expiresAt": Int64(Date().timeIntervalSince1970 * 1000) + 600_000]
            if kind == "select" { row["options"] = [["value": "fast", "label": "快速"], ["value": "safe", "label": "稳妥"]] }
            if secret { row["secret"] = true }
            return row
        }
        func snapshot(_ requests: [[String: Any]]) async { await event(["type": "interaction.snapshot", "requests": requests]) }
        var respondIds: [String] {
            sent.filter { ($0["command"] as? [String: Any])?["type"] as? String == "interaction.respond" }.compactMap { $0["commandId"] as? String }
        }
        var reads: [[String: Any]] { sent.filter { $0["type"] as? String == "agent.state.request" && $0["scope"] as? String == "device" } }
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

    private func setup(_ requests: [[String: Any]] = [Transport.request("approval"), Transport.request("pick", kind: "select")]) async
        -> (HostConnection, Transport, Fixture) {
        let fixture = Fixture()
        await fixture.transport.ready()
        await fixture.transport.snapshot(requests)
        return (fixture.host, fixture.transport, fixture)
    }

    private func request(_ host: HostConnection, _ id: String) throws -> InteractionRequest {
        try #require(host.interactions["a"]?.first { $0.requestId == id })
    }
    private func visible(_ host: HostConnection) -> [String] {
        let hidden = host.respondingRequestIds("a")
        return (host.interactions["a"] ?? []).map(\.requestId).filter { !hidden.contains($0) }
    }
    private func reconnect(_ host: HostConnection, _ transport: Transport) async {
        transport.state?(.offline, nil)
        host.reconnectSelectedHost()
        await transport.ready()
    }

    @Test func answeringCollapsesAtOnceAndShowsTheSummaryUntilTheRequestLeaves() async throws {
        let (host, transport, fixture) = await setup(); defer { withExtendedLifetime(fixture) {} }
        #expect(host.respond(try request(host, "approval"), response: ["kind": "confirm", "value": true]))
        #expect(visible(host) == ["pick"])
        #expect(host.interactionStatus("a")?.text == "已允许")
        #expect(host.interactionStatus("a")?.pending == true)
        await transport.event(["type": "command.result", "commandId": try #require(transport.respondIds.last), "ok": true])
        // 成功回执后请求仍在清单里：面板不闪回。
        #expect(visible(host) == ["pick"])
        await transport.event(["type": "interaction.resolved", "requestId": "approval", "source": "remote"])
        #expect(host.ledger.operations.isEmpty)
        #expect(host.interactionStatus("a")?.text == "已允许")
        #expect(host.interactionStatus("a")?.pending == false)
    }

    @Test func freeTextAndSecretsOnlySaySubmitted() async throws {
        let (host, _, fixture) = await setup([Transport.request("pick", kind: "select", secret: true), Transport.request("text", kind: "input")])
        defer { withExtendedLifetime(fixture) {} }
        #expect(host.respond(try request(host, "pick"), response: ["kind": "select", "value": "fast"]))
        #expect(host.interactionStatus("a")?.text == "已提交")
        #expect(OperationKinds.respondSummary(try request(host, "text"), response: ["kind": "input", "value": "秘密"]) == "已提交")
        let (plain, _, other) = await setup(); defer { withExtendedLifetime(other) {} }
        #expect(plain.respond(try request(plain, "pick"), response: ["kind": "select", "value": "safe"]))
        #expect(plain.interactionStatus("a")?.text == "已选择：稳妥")
    }

    @Test func anExplicitFailureBringsThePanelBackWithItsReason() async throws {
        let (host, transport, fixture) = await setup(); defer { withExtendedLifetime(fixture) {} }
        _ = host.respond(try request(host, "approval"), response: ["kind": "confirm", "value": false])
        await transport.event(["type": "command.result", "commandId": try #require(transport.respondIds.last), "ok": false, "error": "校验失败"])
        #expect(visible(host) == ["approval", "pick"])
        #expect(host.interactionStatus("a") == nil)
        #expect(host.errorMessage == "回答未提交：校验失败")
    }

    @Test func aRequestHandledElsewhereShowsTheFactNotOurAnswer() async throws {
        let (host, transport, fixture) = await setup(); defer { withExtendedLifetime(fixture) {} }
        _ = host.respond(try request(host, "approval"), response: ["kind": "confirm", "value": true])
        await transport.event(["type": "interaction.resolved", "requestId": "approval", "source": "local"])
        #expect(host.ledger.operations.isEmpty)
        #expect(host.interactionStatus("a")?.text == "已处理")
    }

    @Test func disconnectShowsUnconfirmed() async throws {
        let (host, transport, fixture) = await setup(); defer { withExtendedLifetime(fixture) {} }
        _ = host.respond(try request(host, "approval"), response: ["kind": "confirm", "value": true])
        transport.state?(.offline, nil)
        #expect(host.interactionStatus("a")?.text == "已允许 · 未确认")
        #expect(visible(host) == ["pick"])
    }

    @Test func reconnectStillPendingRestoresThePanelSilently() async throws {
        let (host, transport, fixture) = await setup(); defer { withExtendedLifetime(fixture) {} }
        _ = host.respond(try request(host, "approval"), response: ["kind": "confirm", "value": true])
        await reconnect(host, transport)
        await transport.snapshot([Transport.request("approval"), Transport.request("pick", kind: "select")])
        try await transport.answerRead()
        #expect(visible(host) == ["approval", "pick"])
        #expect(host.ledger.operations.isEmpty)
        #expect(host.errorMessage == nil)
    }

    @Test func reconnectWithTheRequestGoneShowsHandled() async throws {
        let (host, transport, fixture) = await setup(); defer { withExtendedLifetime(fixture) {} }
        _ = host.respond(try request(host, "approval"), response: ["kind": "confirm", "value": true])
        await reconnect(host, transport)
        await transport.snapshot([Transport.request("pick", kind: "select")])
        #expect(host.ledger.operations.isEmpty)
        #expect(host.interactionStatus("a")?.text == "已处理")
    }

    @Test func aRequestCanOnlyBeAnsweredOnceAtATime() async throws {
        let (host, transport, fixture) = await setup(); defer { withExtendedLifetime(fixture) {} }
        let approval = try request(host, "approval")
        _ = host.respond(approval, response: ["kind": "confirm", "value": true])
        #expect(!host.respond(approval, response: ["kind": "confirm", "value": false]))
        #expect(transport.respondIds.count == 1)
    }

    @Test func noReceiptWithinTheBudgetShowsUnconfirmedAndReads() async throws {
        let (host, transport, fixture) = await setup(); defer { withExtendedLifetime(fixture) {} }
        _ = host.respond(try request(host, "approval"), response: ["kind": "confirm", "value": true])
        let reads = transport.reads.count
        host.advanceLedgerClock(to: Date().addingTimeInterval(61))
        #expect(host.interactionStatus("a")?.text == "已允许 · 未确认")
        #expect(transport.reads.count == reads + 1)
    }
}
