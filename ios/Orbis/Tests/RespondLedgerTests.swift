// Orbis 测试用途（场景与判定见本文件断言）：
// - OPT-05 `respond`（V07、V22）（V07、V22）
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
        var acceptsSends = true
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
        func send(_ object: [String: Any]) -> Bool {
            guard acceptsSends else { return false }
            sent.append(object); return true
        }
        func emit(_ object: [String: Any]) async { receive?(object, "ctl"); await drain?() }
        func ready(_ runtimeIds: [String] = ["a"]) async {
            await emit(["type": "device.ready", "modelEpoch": "epoch", "notificationEpoch": "notice-epoch", "runtimes": runtimeIds.map { id in
                ["runtimeId": id, "sessionId": "session-\(id)", "name": "Agent", "cwd": "/repo", "status": "running"]
            }])
        }
        func event(_ event: [String: Any], runtimeId: String = "a") async {
            sequence += 1
            await emit(["type": "runtime.event", "runtimeId": runtimeId, "sequence": sequence, "event": event])
        }
        nonisolated static func request(_ id: String, runtimeId: String = "a", kind: String = "confirm", secret: Bool = false) -> [String: Any] {
            var row: [String: Any] = ["runtimeId": runtimeId, "requestId": id, "extensionId": "test", "kind": kind, "title": "允许操作？",
                                      "expiresAt": Int64(Date().timeIntervalSince1970 * 1000) + 600_000]
            if kind == "select" { row["options"] = [["value": "fast", "label": "快速"], ["value": "safe", "label": "稳妥"]] }
            if secret { row["secret"] = true }
            return row
        }
        func snapshot(_ requests: [[String: Any]], runtimeId: String = "a") async {
            await event(["type": "interaction.snapshot", "requests": requests], runtimeId: runtimeId)
        }
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

    private func request(_ host: HostConnection, _ id: String, runtimeId: String = "a") throws -> InteractionRequest {
        try #require(host.interactions[runtimeId]?.first { $0.requestId == id })
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
        #expect(host.interactionStatus("a")?.text == L10n.tr("正在发送…"))
        #expect(host.interactionStatus("a")?.pending == true)
        let commandId = try #require(transport.respondIds.last)
        await transport.event(["type": "command.result", "commandId": commandId, "ok": true, "status": "pending"])
        #expect(host.interactionStatus("a")?.text == L10n.tr("已提交，等待处理结果…"))
        #expect(host.interactionStatus("a")?.pending == true)
        await transport.event(["type": "command.result", "commandId": commandId, "ok": true])
        // 成功回执后请求仍在清单里：面板不闪回，也不提前显示结果。
        #expect(visible(host) == ["pick"])
        #expect(host.interactionStatus("a")?.text == L10n.tr("已提交，等待处理结果…"))
        await transport.event(["type": "interaction.resolved", "requestId": "approval", "source": "remote"])
        #expect(host.ledger.operations.isEmpty)
        #expect(host.interactionStatus("a")?.text == L10n.tr("已{0}", L10n.tr("允许")))
        #expect(host.interactionStatus("a")?.pending == false)
    }

    @Test func freeTextAndSecretsOnlySaySubmitted() async throws {
        let (host, transport, fixture) = await setup([Transport.request("pick", kind: "select", secret: true), Transport.request("text", kind: "input")])
        defer { withExtendedLifetime(fixture) {} }
        #expect(host.respond(try request(host, "pick"), response: ["kind": "select", "value": "fast"]))
        await transport.event(["type": "command.result", "commandId": try #require(transport.respondIds.last), "ok": true])
        await transport.event(["type": "interaction.resolved", "requestId": "pick", "source": "remote"])
        #expect(host.interactionStatus("a")?.text == L10n.tr("已提交"))
        #expect(OperationKinds.respondSummary(try request(host, "text"), response: ["kind": "input", "value": "秘密"]) == L10n.tr("已提交"))
        let (plain, plainTransport, other) = await setup(); defer { withExtendedLifetime(other) {} }
        #expect(plain.respond(try request(plain, "pick"), response: ["kind": "select", "value": "safe"]))
        await plainTransport.event(["type": "command.result", "commandId": try #require(plainTransport.respondIds.last), "ok": true])
        await plainTransport.event(["type": "interaction.resolved", "requestId": "pick", "source": "remote"])
        #expect(plain.interactionStatus("a")?.text == L10n.tr("已选择：") + "稳妥")
    }

    @Test func anExplicitFailureBringsThePanelBackWithItsReason() async throws {
        let (host, transport, fixture) = await setup(); defer { withExtendedLifetime(fixture) {} }
        #expect(host.respond(try request(host, "approval"), response: ["kind": "confirm", "value": false]))
        await transport.event(["type": "command.result", "commandId": try #require(transport.respondIds.last), "ok": false, "error": "校验失败"])
        #expect(visible(host) == ["approval", "pick"])
        let error = L10n.tr("回答未提交：") + "校验失败"
        #expect(host.interactionErrors == ["a": ["approval": error]])
        #expect(ChatScreenSnapshot(store: fixture.store).interactionErrors == ["approval": error])
        #expect(host.interactionStatus("a") == nil)
        #expect(host.errorMessage == nil)
    }

    // A failed write has no optimistic response; retry and removal affect only the owning request.
    @Test func responseWriteFailuresStayInlineAndPruneByRuntimeAndRequest() async throws {
        let fixture = Fixture(), host = fixture.host, transport = fixture.transport
        await transport.ready(["a", "b"])
        await transport.snapshot([Transport.request("approval"), Transport.request("pick", kind: "select")])
        await transport.snapshot([Transport.request("approval", runtimeId: "b")], runtimeId: "b")
        let approval = try request(host, "approval")
        let pick = try request(host, "pick")
        let otherApproval = try request(host, "approval", runtimeId: "b")
        let confirm: [String: Any] = ["kind": "confirm", "value": true]
        let draft = "Unrelated composer draft"
        let runtime = try #require(host.selectedRuntime)
        host.editDraft(draft, for: runtime)

        transport.acceptsSends = false
        // Seed unrelated feedback so an accidental clear is observable as well as an accidental write.
        #expect(!host.stopRuntime())
        #expect(!host.sendMessage("/unsupported"))
        let composerErrors = host.composerErrors, objectErrors = host.objectErrors
        try #require(composerErrors["a"] != nil && objectErrors["a"] != nil)
        let notSent = L10n.tr("回答未发送，请检查连接后重试")
        #expect(!host.respond(approval, response: confirm))
        #expect(host.interactionErrors == ["a": ["approval": notSent]])
        #expect(!host.respond(pick, response: ["kind": "select", "value": "safe"]))
        #expect(!host.respond(otherApproval, response: confirm))
        #expect(host.interactionErrors == ["a": ["approval": notSent, "pick": notSent], "b": ["approval": notSent]])
        #expect(host.interactionStatus("a") == nil)
        #expect(host.ledger.operations.isEmpty)
        #expect(visible(host) == ["approval", "pick"])
        #expect(transport.respondIds.isEmpty)
        #expect(host.composerErrors == composerErrors && host.objectErrors == objectErrors)
        #expect(host.draft(for: runtime) == draft)

        transport.acceptsSends = true
        #expect(host.respond(approval, response: confirm))
        #expect(host.interactionErrors == ["a": ["pick": notSent], "b": ["approval": notSent]])
        #expect(visible(host) == ["pick"])
        #expect(transport.respondIds.count == 1)

        await transport.snapshot([Transport.request("approval")])
        #expect(host.interactionErrors == ["b": ["approval": notSent]])
        await transport.event(["type": "interaction.cancelled", "requestId": "approval"], runtimeId: "b")
        #expect(host.interactionErrors.isEmpty)
        withExtendedLifetime(fixture) {}
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
        #expect(host.interactionStatus("a")?.text == L10n.tr("回答结果未确认"))
        #expect(host.interactionStatus("a")?.pending == false)
        #expect(visible(host) == ["pick"])
    }

    // The fallback is visible while a sibling occupies the workspace, but not alongside its own short status.
    @Test func uncertainReceiptKeepsItsFallbackWhenAnotherRequestIsVisible() async throws {
        let (host, transport, fixture) = await setup(); defer { withExtendedLifetime(fixture) {} }
        #expect(host.respond(try request(host, "approval"), response: ["kind": "confirm", "value": true]))
        let commandId = try #require(transport.respondIds.last)
        await transport.event(["type": "command.result", "commandId": commandId, "ok": false, "status": "unconfirmed"])
        await transport.emit(["type": "notification.snapshot", "protocolVersion": orbisProtocolVersion, "hostEpoch": "notice-epoch",
            "runtimeId": "a", "sessionId": "session-a", "revision": 1, "complete": true, "verification": "confirmed",
            "notifications": [["notificationId": "fallback", "producerEpoch": "notice-epoch", "code": "interaction.submit",
                "occurrenceId": commandId, "scope": ["requestId": "approval", "commandId": commandId], "severity": "warning",
                "message": "回答结果未确认", "lifecycle": "outcome", "createdAt": 1, "updatedAt": 1, "verification": "confirmed"]]])
        #expect(host.interactionStatus("a")?.requestId == "approval")
        #expect(visible(host) == ["pick"])
        #expect(host.chatNoticeProjection("a", sessionId: "session-a")?.items.map(\.id) == ["fallback"])
        #expect(host.chatNoticeProjection("a", sessionId: "retired") == nil)

        await transport.event(["type": "interaction.cancelled", "requestId": "pick", "reason": "cancelled"])
        #expect(visible(host).isEmpty)
        #expect(host.interactionStatus("a")?.text == L10n.tr("回答结果未确认"))
        #expect(host.chatNoticeProjection("a", sessionId: "session-a")?.items.isEmpty == true)
        #expect(host.notifications.projections["a"]?.items.map(\.id) == ["fallback"])
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
        #expect(host.interactionStatus("a")?.text == L10n.tr("回答结果未确认"))
        #expect(host.interactionStatus("a")?.pending == false)
        #expect(transport.reads.count == reads + 1)
    }
}
