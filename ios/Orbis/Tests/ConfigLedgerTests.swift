// Orbis 测试用途（场景与判定见本文件断言）：
// - OPT-07 `config`（V12、V05）（V12、V05）
import Foundation
import Testing
@testable import OrbisCore

/// ADR-0049 §6.7 `config`：模型 / 思考级别条件乐观。Android `ConfigLedgerTest.kt` 与本文件用例一一对应。
@Suite("Model and thinking level through the operation ledger (ADR-0049 §6.7)") @MainActor
struct ConfigLedgerTests {
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
        func event(_ event: [String: Any]) async {
            sequence += 1
            await emit(["type": "runtime.event", "runtimeId": "a", "sequence": sequence, "event": event])
        }
        func ready() async {
            await emit(["type": "device.ready", "modelEpoch": "epoch", "runtimes": [
                ["runtimeId": "a", "sessionId": "session-a", "name": "Agent", "cwd": "/repo", "status": "idle"]
            ]])
            await event(["type": "runtime.capabilities", "capabilities": ["commands": [
                ["name": "model", "source": "builtin", "argument": ["kind": "select", "required": true, "options": [
                    ["value": "model-a", "label": "默认模型"], ["value": "model-b", "label": "快速模型"], ["value": "model-c", "label": "深度模型"]]]],
                ["name": "thinking", "source": "builtin", "argument": ["kind": "select", "required": true, "options": [["value": "high", "label": "高"]]]]
            ]]])
            await model("model-a")
        }
        func model(_ id: String) async {
            await event(["type": "runtime.metadata", "metadata": ["model": ["provider": "openai", "id": id, "name": id]]])
        }
        var configCommands: [[String: Any]] {
            sent.filter { ($0["command"] as? [String: Any])?["type"] as? String == "slash.execute" }
        }
        var userMessages: [[String: Any]] {
            sent.compactMap { $0["command"] as? [String: Any] }.filter { $0["type"] as? String == "user_message" }
        }
        func result(ok: Bool, error: String? = nil) async throws {
            let id = try #require(configCommands.last?["commandId"] as? String)
            var payload: [String: Any] = ["type": "command.result", "commandId": id, "ok": ok]
            if let error { payload["error"] = error }
            await event(payload)
        }
        func answerRead() async throws {
            let request = try #require(sent.last { $0["type"] as? String == "agent.state.request" && $0["scope"] as? String == "device" })
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

    private func setup() async -> Fixture {
        let fixture = Fixture()
        await fixture.transport.ready()
        return fixture
    }

    private func status(_ host: HostConnection) -> String? { host.configStatus("a", setting: "model").map { $0.label + "·" + $0.mark } }

    @Test func choosingShowsTheChoiceAtOnceAndLandsOnConfirmation() async throws {
        let fixture = await setup(); let host = fixture.host
        #expect(host.executeSlash("model", args: "model-b"))
        #expect(status(host) == "快速模型·切换中")
        #expect(fixture.transport.configCommands.last?["command"] as? [String: String] == ["type": "slash.execute", "name": "model", "args": "model-b"])
        try await fixture.transport.result(ok: true)
        #expect(status(host) == "快速模型·切换中")
        await fixture.transport.model("model-b")
        #expect(status(host) == nil)
        #expect(host.runtimes.first?.model?.id == "model-b")
        #expect(host.ledger.operations.isEmpty)
    }

    @Test func aNormalizedConfirmationShowsTheConfirmedValue() async throws {
        let fixture = await setup(); let host = fixture.host
        _ = host.executeSlash("model", args: "model-b")
        try await fixture.transport.result(ok: true)
        await fixture.transport.model("model-b-2026")
        #expect(status(host) == nil)
        #expect(host.runtimes.first?.model?.id == "model-b-2026")
    }

    @Test func aFailureReturnsToTheConfirmedValueAndFailsTheMessagesWaitingForIt() async throws {
        let fixture = await setup(); let host = fixture.host
        _ = host.executeSlash("model", args: "model-b")
        #expect(host.sendMessage("用新模型回答"))
        #expect(host.pendingSends.items.first?.state == .waiting("等待模型切换"))
        try await fixture.transport.result(ok: false, error: "未知模型")
        #expect(status(host) == nil)
        #expect(host.errorMessage == "模型切换未完成：未知模型")
        #expect(host.pendingSends.items.first?.state == .failed("模型切换未完成，消息未发送"))
        #expect(fixture.transport.userMessages.isEmpty)
    }

    @Test func messagesSentBeforeConfirmationWaitAndThenSubmit() async throws {
        let fixture = await setup(); let host = fixture.host
        _ = host.executeSlash("model", args: "model-b")
        _ = host.sendMessage("用新模型回答")
        try await fixture.transport.result(ok: true)
        #expect(fixture.transport.userMessages.isEmpty)
        await fixture.transport.model("model-b")
        #expect(fixture.transport.userMessages.compactMap { $0["text"] as? String } == ["用新模型回答"])
    }

    @Test func consecutiveChoicesSubmitOnlyTheLatest() async throws {
        let fixture = await setup(); let host = fixture.host
        _ = host.executeSlash("model", args: "model-b")
        _ = host.executeSlash("model", args: "model-c")
        #expect(fixture.transport.configCommands.count == 1)
        #expect(status(host) == "深度模型·切换中")
        try await fixture.transport.result(ok: true)
        await fixture.transport.model("model-b")
        #expect(fixture.transport.configCommands.count == 2)
        #expect((fixture.transport.configCommands.last?["command"] as? [String: Any])?["args"] as? String == "model-c")
        #expect(status(host) == "深度模型·切换中")
    }

    @Test func disconnectShowsUnconfirmedAndAnUnchangedConfigFailsAfterReconnect() async throws {
        let fixture = await setup(); let host = fixture.host
        _ = host.executeSlash("model", args: "model-b")
        fixture.transport.state?(.offline, nil)
        #expect(status(host) == "快速模型·未确认")
        host.reconnectSelectedHost()
        await fixture.transport.ready()
        try await fixture.transport.answerRead()
        #expect(status(host) == nil)
        #expect(host.errorMessage == "模型切换未完成：未生效")
    }

    @Test func reconnectWithTheChoiceInEffectLands() async throws {
        let fixture = await setup(); let host = fixture.host
        _ = host.executeSlash("model", args: "model-b")
        fixture.transport.state?(.offline, nil)
        host.reconnectSelectedHost()
        await fixture.transport.emit(["type": "device.ready", "modelEpoch": "epoch", "runtimes": [
            ["runtimeId": "a", "sessionId": "session-a", "name": "Agent", "cwd": "/repo", "status": "idle"]]])
        await fixture.transport.model("model-b")
        #expect(status(host) == nil)
        #expect(host.ledger.operations.isEmpty)
        #expect(host.errorMessage == nil)
    }
}
