// Orbis 测试用途（场景与判定见本文件断言）：
// - OPT-08 `launch`（V12、V10）（V12、V10）
import Foundation
import Testing
@testable import OrbisCore

/// ADR-0049 §6.8 `launch`：新建 / 恢复会话立即进入聊天页。Android `LaunchLedgerTest.kt` 与本文件用例一一对应。
@Suite("Session launch through the operation ledger (ADR-0049 §6.8)") @MainActor
struct LaunchLedgerTests {
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
        var activations: [[String: Any]] { sent.filter { $0["type"] as? String == "session.activate" } }
        var userMessages: [[String: Any]] { sent.filter { ($0["command"] as? [String: Any])?["type"] as? String == "user_message" } }
        func activated(_ sessionId: String) async throws {
            let id = try #require(activations.last?["requestId"] as? String)
            await emit(["type": "session.activated", "requestId": id, "sessionId": sessionId, "agentKind": "codex"])
        }
        func online(_ sessionId: String) async {
            await emit(["type": "runtime.online", "runtime": ["runtimeId": "rt-" + sessionId, "sessionId": sessionId, "name": "Agent", "cwd": "/repo/app", "status": "idle"]])
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

    @Test func resumeEntersTheChatAtOnceShowingStartingAndSwitchesWhenOnline() async throws {
        let fixture = await setup(); let host = fixture.host
        let session = SessionSummary(sessionId: "s1", name: "旧会话", cwd: "/repo/app", firstMessage: nil, createdAt: 1, modifiedAt: 1, messageCount: 3, agentKind: "codex", archived: false)
        let revision = host.activationRevision
        host.activate(session)
        #expect(host.activationRevision > revision)
        #expect(host.selectedRuntime?.status == "starting")
        #expect(host.selectedRuntime?.sessionId == "s1")
        #expect(host.isLaunchPage)
        try await fixture.transport.activated("s1")
        await fixture.transport.online("s1")
        #expect(host.selectedRuntimeId == "rt-s1")
        #expect(host.launching == nil)
        #expect(host.ledger.operations.isEmpty)
    }

    @Test func typingOnTheLaunchPageHandsTheComposerFocusToTheLandedSession() async throws {
        let fixture = await setup(); let host = fixture.host
        let session = SessionSummary(sessionId: "s1", name: "旧会话", cwd: "/repo/app", firstMessage: nil, createdAt: 1, modifiedAt: 1, messageCount: 3, agentKind: "codex", archived: false)
        host.activate(session)
        host.noteComposerFocus(true)
        try await fixture.transport.activated("s1")
        await fixture.transport.online("s1")
        #expect(host.selectedRuntimeId == "rt-s1")
        #expect(host.takeComposerFocus("rt-s1"))
        #expect(!host.takeComposerFocus("rt-s1"), "the handoff is taken once")
        // 不在启动页时的焦点变化不交接。
        host.noteComposerFocus(true)
        host.activate(SessionSummary(sessionId: "s2", name: "另一个", cwd: "/repo/app", firstMessage: nil, createdAt: 1, modifiedAt: 1, messageCount: 1, agentKind: "codex", archived: false))
        host.noteComposerFocus(false)
        try await fixture.transport.activated("s2")
        await fixture.transport.online("s2")
        #expect(!host.takeComposerFocus("rt-s2"))
    }

    @Test func aNewSessionEntersAPlaceholderAndItsDraftMovesOnSuccess() async throws {
        let fixture = await setup(); let host = fixture.host
        host.createSession(agentKind: "codex", cwd: "/repo/app")
        let placeholder = try #require(host.selectedRuntime)
        #expect(placeholder.runtimeId.hasPrefix("launch:"))
        #expect(placeholder.status == "starting")
        #expect(placeholder.name == "app")
        // 顶栏标题走 displayName：不能退回到占位 id（“launch:…”）。
        #expect(host.displayName(placeholder) == "app")
        host.saveDraft("启动时写的草稿", for: placeholder)
        try await fixture.transport.activated("new-1")
        await fixture.transport.online("new-1")
        let runtime = try #require(host.selectedRuntime)
        #expect(runtime.runtimeId == "rt-new-1")
        #expect(host.draft(for: runtime) == "启动时写的草稿")
    }

    @Test func aMessageSentWhileStartingWaitsAndIsSubmittedWhenOnline() async throws {
        let fixture = await setup(); let host = fixture.host
        host.createSession(agentKind: "codex", cwd: "/repo/app")
        #expect(host.sendMessage("你好"))
        #expect(host.pendingSends.items.first?.state == .waiting("等待会话启动"))
        #expect(fixture.transport.userMessages.isEmpty)
        try await fixture.transport.activated("new-1")
        await fixture.transport.online("new-1")
        let written = try #require(fixture.transport.userMessages.last)
        #expect(written["runtimeId"] as? String == "rt-new-1")
        #expect(host.pendingSends.items.first?.sessionId == "new-1")
    }

    /// 真实 Host 先广播 Runtime 上线，再回复同一 requestId 的 session.activated；等待中的消息同样要在上线后写入。
    @Test func aMessageSentWhileStartingIsSubmittedWhenTheRuntimeIsOnlineBeforeTheReply() async throws {
        let fixture = await setup(); let host = fixture.host
        host.createSession(agentKind: "codex", cwd: "/repo/app")
        #expect(host.sendMessage("你好"))
        await fixture.transport.online("new-1")
        #expect(fixture.transport.userMessages.isEmpty, "the Runtime is not known to be this launch yet")
        try await fixture.transport.activated("new-1")
        #expect(host.selectedRuntimeId == "rt-new-1")
        let written = try #require(fixture.transport.userMessages.last)
        #expect(written["runtimeId"] as? String == "rt-new-1")
        #expect(host.pendingSends.items.first?.sessionId == "new-1")
        #expect(host.ledger.operations.isEmpty)
    }

    @Test func aFailureShowsInPlaceFailsWaitingMessagesAndCanRetry() async throws {
        let fixture = await setup(); let host = fixture.host
        host.createSession(agentKind: "codex", cwd: "/repo/app")
        _ = host.sendMessage("你好")
        let id = try #require(fixture.transport.activations.last?["requestId"] as? String)
        await fixture.transport.emit(["type": "protocol.error", "code": "agent_unsupported", "message": "对应的 agent 后端未就绪", "requestId": id])
        #expect(host.launching?.failure == "对应的 agent 后端未就绪")
        #expect(host.selectedRuntime?.status == "error")
        #expect(!host.canSend)
        #expect(host.pendingSends.items.first?.state == .failed("会话启动未完成，消息未发送"))
        host.retryLaunch()
        #expect(fixture.transport.activations.count == 2)
        #expect(host.selectedRuntime?.status == "starting")
    }

    @Test func leavingTheLaunchPageDoesNotPullTheUserBack() async throws {
        let fixture = await setup(); let host = fixture.host
        host.createSession(agentKind: "codex", cwd: "/repo/app")
        host.stopFollowingLaunch()
        let revision = host.activationRevision
        try await fixture.transport.activated("new-1")
        await fixture.transport.online("new-1")
        #expect(host.activationRevision == revision)
        #expect(host.runtimes.contains { $0.runtimeId == "rt-new-1" })
        #expect(host.selectedRuntimeId != "rt-new-1")
        #expect(host.launching == nil)
    }

    @Test func noResultWithinTheBudgetShowsLaunchUnconfirmed() async throws {
        let fixture = await setup(); let host = fixture.host
        host.createSession(agentKind: "codex", cwd: "/repo/app")
        host.advanceLedgerClock(to: Date().addingTimeInterval(61))
        try await fixture.transport.answerRead()
        #expect(host.launching?.unconfirmed == true)
        #expect(host.selectedRuntime?.status == "launch_unconfirmed")
    }
}
