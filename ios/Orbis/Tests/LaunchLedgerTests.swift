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
        init(root: URL? = nil, localStores: HostLocalStores? = nil) {
            store = OrbisStore(secure: Storage(), transport: transport, preferences: nil, transferRoot: root, localStores: localStores)
            transport.drain = { [weak store] in await store?.waitForPendingEvents() }
        }
    }

    private func setup() async -> Fixture {
        let fixture = Fixture()
        await fixture.transport.ready()
        return fixture
    }

    private func configured(_ fixture: Fixture) async throws {
        await fixture.transport.emit(["type": "device.ready", "modelEpoch": "epoch", "sessionConfiguration": 1, "runtimes": []])
        fixture.host.loadSessionConfiguration(agent: "codex", cwd: "/repo/app")
        let request = try #require(fixture.transport.sent.last)
        await fixture.transport.emit(["type": "session.configuration.result", "requestId": request["requestId"]!, "agentKind": "codex", "cwd": "/repo/app",
            "binding": "fixture", "revision": 0, "values": ["model": "fixture-model", "thinking": "high"],
            "catalog": ["binding": "fixture", "defaults": [:], "models": [["value": "fixture-model", "label": "Fixture", "thinking": [["value": "high", "label": "High"]]]], "permissions": []]])
    }

    // SC73: only the exact configuration request owns its error; command errors
    // remain visible and cannot finish or fail an unrelated configuration read.
    @Test func configurationErrorsRequireTheExactNonemptyRequestIdentity() async throws {
        let fixture = Fixture()
        await fixture.transport.emit(["type": "device.ready", "modelEpoch": "epoch", "sessionConfiguration": 1, "runtimes": []])
        fixture.host.loadSessionConfiguration(agent: "codex", cwd: "/repo/app")
        let id = try #require(fixture.host.sessionConfigurationRequest)
        await fixture.transport.emit(["type": "protocol.error", "commandId": "unrelated-command", "code": "busy", "message": "Agent busy"])
        #expect(fixture.host.errorMessage == "Agent busy")
        #expect(fixture.host.sessionConfigurationRequest == id)
        #expect(fixture.host.sessionConfigurationError == nil)
        await fixture.transport.emit(["type": "protocol.error", "requestId": id, "code": "session_configuration_failed", "message": "catalog unavailable"])
        #expect(fixture.host.sessionConfigurationRequest == nil)
        #expect(fixture.host.sessionConfigurationError == "catalog unavailable")
        #expect(fixture.host.connection == .secured)
    }

    // PERF-08 / SC73: UI admission and draft state stay responsive while the
    // recovery write is blocked; no native launch can overtake that write.
    @Test func configuredLaunchWaitsForBackgroundDurabilityWithoutBlockingUI() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("orbis-launch-io-" + UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let gate = MainThreadWorkGate()
        let fixture = Fixture(root: root, localStores: HostLocalStores(io: HostLocalIO(beforeIO: { gate.work() })))
        try await configured(fixture)
        gate.arm()
        #expect(fixture.host.createSession(agentKind: "codex", cwd: "/repo/app", firstMessage: "preserve me"))
        #expect(await gate.waitEntered())
        #expect(fixture.host.isLaunchPage && fixture.host.pendingSends.items.count == 1)
        #expect(fixture.transport.sent.allSatisfy { $0["type"] as? String != "session.launch" })
        #expect(!fixture.host.createSession(agentKind: "codex", cwd: "/repo/app", firstMessage: "duplicate"))
        gate.release.signal()
        await fixture.store.waitForPendingEvents()
        #expect(fixture.transport.sent.filter { $0["type"] as? String == "session.launch" }.count == 1)
    }

    // Reconnect cancels only the old send continuation, not its accepted durable
    // write. Recovery reads the same ID after that write, without creating twice.
    @Test func reconnectDuringJournalWriteKeepsTheOriginalLaunchIdentity() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("orbis-launch-reconnect-" + UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let gate = MainThreadWorkGate()
        let fixture = Fixture(root: root, localStores: HostLocalStores(io: HostLocalIO(beforeIO: { gate.work() })))
        try await configured(fixture)
        gate.arm()
        #expect(fixture.host.createSession(agentKind: "codex", cwd: "/repo/app", firstMessage: "preserve me"))
        let id = try #require(fixture.host.launching?.requestId)
        #expect(await gate.waitEntered())
        fixture.host.reconnectSelectedHost()
        gate.release.signal()
        await fixture.transport.emit(["type": "device.ready", "modelEpoch": "next", "sessionConfiguration": 1, "runtimes": []])
        #expect(fixture.transport.sent.allSatisfy { $0["type"] as? String != "session.launch" })
        #expect(fixture.transport.sent.last { $0["type"] as? String == "session.launch.read" }?["launchId"] as? String == id)
        #expect(fixture.host.pendingSends.items.count == 1)
    }

    // S51 / SC73: runtime presence alone cannot release a first message. The journal
    // and stable message identity exist before launch, including the crash recovery path.
    @Test func configuredLaunchPersistsBeforeTransportAndWaitsForNativeReadiness() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("orbis-configured-test-" + UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let fixture = Fixture(root: root); try await configured(fixture)
        #expect(fixture.host.createSession(agentKind: "codex", cwd: "/repo/app", firstMessage: "first sentence"))
        await fixture.store.waitForPendingEvents()
        let request = try #require(fixture.transport.sent.last { $0["type"] as? String == "session.launch" })
        let id = try #require(request["launchId"] as? String)
        let file = try #require(FileManager.default.contentsOfDirectory(at: root.appendingPathComponent("ConfiguredLaunches"), includingPropertiesForKeys: nil).first)
        let saved = try #require(JSONSerialization.jsonObject(with: Data(contentsOf: file)) as? [String: Any])
        #expect(saved["firstMessage"] as? String == "first sentence")
        #expect(saved["firstMessageId"] as? String == fixture.host.pendingSends.items.first?.messageId)
        await fixture.transport.online("configured")
        await fixture.transport.emit(["type": "session.launch.result", "requestId": id, "launchId": id, "phase": "configuring", "sessionId": "configured"])
        #expect(fixture.transport.userMessages.isEmpty)
        await fixture.transport.emit(["type": "session.launch.result", "requestId": id, "launchId": id, "phase": "ready", "sessionId": "configured"])
        #expect(fixture.transport.userMessages.count == 1)
        #expect(FileManager.default.fileExists(atPath: file.path))
        #expect(fixture.host.selectedRuntimeId == "rt-configured")
        await fixture.transport.emit(["type": "session.launch.result", "requestId": id, "launchId": id, "phase": "ready", "sessionId": "configured"])
        #expect(fixture.transport.userMessages.count == 1)
    }

    @Test func configuredLaunchReopensWithTheOriginalIdentityAndDoesNotResendTheFirstSentence() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("orbis-configured-recovery-" + UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let original = Fixture(root: root); try await configured(original)
        #expect(original.host.createSession(agentKind: "codex", cwd: "/repo/app", firstMessage: "recover this sentence"))
        await original.store.waitForPendingEvents()
        let request = try #require(original.transport.sent.last { $0["type"] as? String == "session.launch" })
        let id = try #require(request["launchId"] as? String)
        let firstId = original.host.pendingSends.items.first?.messageId
        let recovered = Fixture(root: root)
        await recovered.transport.emit(["type": "device.ready", "modelEpoch": "new-epoch", "sessionConfiguration": 1, "runtimes": []])
        #expect(recovered.transport.sent.contains { $0["type"] as? String == "session.launch.read" && $0["launchId"] as? String == id })
        #expect(recovered.host.pendingSends.items.first?.messageId == firstId)
        #expect(recovered.host.pendingSends.items.first?.text == "recover this sentence")
        await recovered.transport.online("recovered-native")
        await recovered.transport.emit(["type": "session.launch.result", "requestId": id, "launchId": id, "phase": "ready", "sessionId": "recovered-native"])
        #expect(recovered.transport.userMessages.isEmpty)
        #expect(recovered.transport.sent.allSatisfy { $0["type"] as? String != "session.launch" })
    }

    // A final preflight refusal keeps the first sentence recoverable and cannot
    // fall back to legacy creation after the user presses retry or reopens the App.
    @Test func rejectedConfiguredLaunchKeepsItsFirstSentenceAndNeverFallsBackToLegacyCreation() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("orbis-configured-rejected-" + UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let original = Fixture(root: root); try await configured(original)
        #expect(original.host.createSession(agentKind: "codex", cwd: "/repo/app", firstMessage: "preserve rejected sentence"))
        await original.store.waitForPendingEvents()
        let launch = try #require(original.transport.sent.last { $0["type"] as? String == "session.launch" })
        let id = try #require(launch["launchId"] as? String)
        await original.transport.emit(["type": "session.launch.result", "requestId": id, "launchId": id, "phase": "failed", "error": "stale catalog"])
        original.host.retryLaunch()
        #expect(original.transport.activations.isEmpty)
        #expect(original.host.pendingSends.items.first?.state == .failed("会话启动未完成，消息未发送"))
        let recovered = Fixture(root: root)
        await recovered.transport.emit(["type": "device.ready", "modelEpoch": "new-epoch", "sessionConfiguration": 1, "runtimes": []])
        #expect(recovered.host.pendingSends.items.first?.text == "preserve rejected sentence")
        #expect(recovered.host.launching?.failure == "stale catalog")
        #expect(recovered.transport.sent.allSatisfy { !["session.launch", "session.launch.read", "session.activate"].contains($0["type"] as? String ?? "") })
    }

    // S35 / SC55: a first sentence creates one launch and one
    // waiting message under the same placeholder; retrying the gesture cannot duplicate it.
    @Test func firstSentenceStartsOneNamedSessionAndQueuesOneMessage() async throws {
        let fixture = await setup(); let host = fixture.host
        #expect(host.createSession(agentKind: "codex", cwd: "/repo/app", firstMessage: "帮我核对首页交互"))
        #expect(fixture.transport.activations.count == 1)
        #expect(host.launching?.title == "帮我核对首页交互")
        #expect(host.pendingSends.items.count == 1)
        #expect(fixture.transport.userMessages.isEmpty)
        #expect(!host.createSession(agentKind: "codex", cwd: "/repo/app", firstMessage: "重复点击"))
        #expect(fixture.transport.activations.count == 1)
        try await fixture.transport.activated("draft-first")
        await fixture.transport.online("draft-first")
        #expect(fixture.transport.userMessages.count == 1)
        #expect(fixture.transport.userMessages.first?["runtimeId"] as? String == "rt-draft-first")
    }

    // S49 / SC70: empty and whitespace drafts open the same desktop window as the
    // original create action, without an empty user message or duplicate activation.
    @Test(arguments: ["", " \n\t "]) func emptyDraftStartsAWindowWithoutSendingAMessage(text: String) async throws {
        let fixture = await setup(); let host = fixture.host
        #expect(host.createSession(agentKind: "codex", cwd: "/repo/app", firstMessage: text))
        let activation = try #require(fixture.transport.activations.first)
        #expect(activation["spawnMode"] as? String == "tui")
        #expect(activation["target"] as? [String: String] == ["type": "new", "agentKind": "codex", "cwd": "/repo/app"])
        #expect(host.launching?.title == "app")
        #expect(host.pendingSends.items.isEmpty)
        #expect(!host.createSession(agentKind: "codex", cwd: "/repo/app", firstMessage: text))
        #expect(fixture.transport.activations.count == 1)
        try await fixture.transport.activated("empty-draft")
        await fixture.transport.online("empty-draft")
        #expect(host.selectedRuntimeId == "rt-empty-draft")
        #expect(fixture.transport.userMessages.isEmpty)
        #expect(host.pendingSends.items.isEmpty)
    }

    // First-sentence validation must run before a remote activation. Invalid
    // text stays in the owner draft, and correcting it still creates just one session.
    @Test func invalidFirstSentencePreservesDraftWithoutActivating() async throws {
        let fixture = await setup(); let host = fixture.host
        let draft = RuntimeSummary(runtimeId: "local-draft", name: "Draft", cwd: "/repo/app", status: "idle")
        for text in [" /model", String(repeating: "字", count: 100_001)] {
            host.saveDraft(text, for: draft)
            #expect(!host.createSession(agentKind: "codex", cwd: "/repo/app", firstMessage: text))
            #expect(fixture.transport.activations.isEmpty)
            #expect(host.launching == nil)
            #expect(host.pendingSends.items.isEmpty)
            #expect(host.draft(for: draft) == text)
        }
        #expect(host.createSession(agentKind: "codex", cwd: "/repo/app", firstMessage: "正常首句"))
        #expect(fixture.transport.activations.count == 1)
        #expect(host.pendingSends.items.count == 1)
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
