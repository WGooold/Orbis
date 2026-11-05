// Orbis 测试用途（场景与判定见本文件断言）：
// - OPT-09 prompt / skill Slash（V10）（V10）
import Foundation
import Testing
@testable import OrbisCore

/// ADR-0049 §6.1：产生对话的 Slash（prompt / skill）乐观显示。Android `SlashMessageTest.kt` 与本文件用例一一对应。
@Suite("Prompt and skill slash commands as messages (ADR-0049 §6.1)") @MainActor
struct SlashMessageTests {
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
        func ready(status: String = "idle") async {
            await emit(["type": "device.ready", "modelEpoch": "epoch", "runtimes": [
                ["runtimeId": "a", "sessionId": "session-a", "name": "Agent", "cwd": "/repo", "status": status]]])
            await event(["type": "runtime.capabilities", "capabilities": ["commands": [
                ["name": "review", "source": "prompt", "argument": ["kind": "text", "required": false]],
                ["name": "compact", "source": "builtin"]]]])
        }
        var slashCommands: [[String: Any]] { sent.compactMap { $0["command"] as? [String: Any] }.filter { $0["type"] as? String == "slash.execute" } }
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

    private func setup(status: String = "idle") async -> Fixture {
        let fixture = Fixture()
        await fixture.transport.ready(status: status)
        return fixture
    }

    @Test func aPromptCommandShowsALocalBubbleAndCarriesItsAppId() async throws {
        let fixture = await setup(); let host = fixture.host
        #expect(host.executeSlash("review", args: "src"))
        let row = try #require(host.pendingSends.items.first)
        #expect(row.text == "/review src")
        #expect(row.state == .sending)
        #expect(fixture.transport.slashCommands.last?["messageId"] as? String == row.messageId)
    }

    @Test func aFailedPromptCommandCanBeRunAgainWithANewIdentity() async throws {
        let fixture = await setup(); let host = fixture.host
        _ = host.executeSlash("review", args: "src")
        let first = try #require(host.pendingSends.items.first)
        let command = try #require(fixture.transport.sent.last?["commandId"] as? String)
        await fixture.transport.event(["type": "command.result", "commandId": command, "ok": false, "error": "runtime_busy"])
        #expect({ if case .failed = host.pendingSends.items.first?.state { return true }; return false }())
        #expect(host.resendPendingSend(first.messageId))
        let second = try #require(host.pendingSends.items.first)
        #expect(second.messageId != first.messageId)
        #expect(fixture.transport.slashCommands.last?["messageId"] as? String == second.messageId)
    }

    @Test func aBusyRuntimeKeepsTheProcessingPathWithoutABubble() async throws {
        let fixture = await setup(status: "running"); let host = fixture.host
        #expect(host.executeSlash("review", args: "src"))
        #expect(host.pendingSends.items.isEmpty)
        #expect(fixture.transport.slashCommands.last?["messageId"] == nil)
    }

    @Test func aBuiltinCommandDoesNotShowABubble() async throws {
        let fixture = await setup(); let host = fixture.host
        #expect(host.executeSlash("compact"))
        #expect(host.pendingSends.items.isEmpty)
    }
}
