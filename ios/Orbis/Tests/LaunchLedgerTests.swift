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
        var accepting = true
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
        func send(_ object: [String: Any]) -> Bool { guard accepting else { return false }; sent.append(object); return true }
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

    private func configured(_ fixture: Fixture, prefersAuto: Bool = false, agent: String = "codex") async throws {
        await fixture.transport.emit(["type": "device.ready", "modelEpoch": "epoch", "sessionConfiguration": 1, "runtimes": [], "hostFeatures": prefersAuto ? ["session.spawn.auto"] : [],
            "agents": [agent], "launchableAgents": [agent]])
        fixture.host.loadSessionConfiguration(agent: agent, cwd: "/repo/app")
        let request = try #require(fixture.transport.sent.last)
        await fixture.transport.emit(["type": "session.configuration.result", "requestId": request["requestId"]!, "agentKind": agent, "cwd": "/repo/app",
            "binding": "fixture", "revision": 0, "values": ["model": "fixture-model", "thinking": "high"],
            "catalog": ["binding": "fixture", "defaults": [:], "models": [["value": "fixture-model", "label": "Fixture", "thinking": [["value": "high", "label": "High"]]]], "permissions": []]])
    }

    @Test(arguments: [false, true]) func defaultSpawnModeFollowsAuthenticatedHostPreference(prefersAuto: Bool) async throws {
        let mode = prefersAuto ? "auto" : "tui"
        let features = prefersAuto ? ["session.spawn.auto"] : []
        let created = Fixture()
        await created.transport.emit(["type": "device.ready", "runtimes": [], "hostFeatures": features])
        #expect(created.host.createSession(agentKind: "codex", cwd: "/repo/app", firstMessage: ""))
        #expect(created.transport.activations.last?["spawnMode"] as? String == mode)

        let resumed = Fixture()
        await resumed.transport.emit(["type": "device.ready", "runtimes": [], "hostFeatures": features])
        resumed.host.activate(SessionSummary(sessionId: "s1", name: "Old session", cwd: "/repo/app", firstMessage: nil,
            createdAt: 1, modifiedAt: 1, messageCount: 1, agentKind: "codex", archived: false))
        #expect(resumed.transport.activations.last?["spawnMode"] as? String == mode)

        let configured = Fixture()
        try await self.configured(configured, prefersAuto: prefersAuto)
        #expect(configured.host.createSession(agentKind: "codex", cwd: "/repo/app", firstMessage: "first message"))
        await configured.store.waitForPendingEvents()
        let launch = try #require(configured.transport.sent.last { $0["type"] as? String == "session.launch" })
        #expect(launch["spawnMode"] as? String == mode)
    }

    // SC73: only the exact configuration request owns its error; command errors
    // remain visible and cannot finish or fail an unrelated configuration read.
    @Test func configurationErrorsRequireTheExactNonemptyRequestIdentity() async throws {
        let fixture = Fixture()
        await fixture.transport.emit(["type": "device.ready", "modelEpoch": "epoch", "sessionConfiguration": 1, "runtimes": []])
        fixture.host.loadSessionConfiguration(agent: "codex", cwd: "/repo/app")
        let id = try #require(fixture.host.sessionConfigurationRequest)
        await fixture.transport.emit(["type": "protocol.error", "commandId": "unrelated-command", "code": "busy", "message": "Agent busy"])
        #expect(fixture.host.errorMessage == nil) // SC94: unowned replies remain diagnostic-only.
        #expect(fixture.host.sessionConfigurationRequest == id)
        #expect(fixture.host.sessionConfigurationError == nil)
        await fixture.transport.emit(["type": "protocol.error", "requestId": id, "code": "session_configuration_failed", "message": "catalog unavailable"])
        #expect(fixture.host.sessionConfigurationRequest == nil)
        #expect(fixture.host.sessionConfigurationError == "catalog unavailable")
        #expect(fixture.host.connection == .secured)
    }

    @Test func rejectedLaunchAllowsANewIdWithoutVerificationOrResending() async throws {
        let fixture = Fixture(); try await configured(fixture)
        #expect(fixture.host.createSession(agentKind: "codex", cwd: "/repo/app", firstMessage: "first"))
        await fixture.store.waitForPendingEvents()
        let id = try #require(fixture.host.launching?.requestId)
        await fixture.transport.emit(["type": "session.launch.result", "requestId": id, "launchId": id, "phase": "failed", "error": "launch unavailable"])
        #expect(fixture.host.launching?.rejected == true)
        fixture.host.stopFollowingLaunch()
        #expect(fixture.host.recoveredLaunchDraft?.text == "first")
        #expect(fixture.host.createSession(agentKind: "codex", cwd: "/repo/app", firstMessage: "second"))
        await fixture.store.waitForPendingEvents()
        let next = try #require(fixture.host.launching?.requestId)
        #expect(next != id)
        #expect(fixture.host.sessionConfigurationError == nil)
        #expect(fixture.host.sessionLaunchError == nil)
        #expect(fixture.host.pendingSends.items.map(\.text) == ["second"])
        #expect(fixture.transport.sent.filter { $0["type"] as? String == "session.launch" }.count == 2)
        #expect(!fixture.transport.sent.contains { $0["type"] as? String == "session.launch.read" })
        #expect(fixture.transport.userMessages.isEmpty)
    }

    @Test func endingUnknownLaunchReturnsADraftAndIgnoresLateReadiness() async throws {
        let fixture = Fixture(); try await configured(fixture)
        #expect(fixture.host.createSession(agentKind: "codex", cwd: "/repo/app", firstMessage: "unsent first"))
        await fixture.store.waitForPendingEvents()
        let id = try #require(fixture.host.launching?.requestId)
        #expect(await !fixture.host.endConfiguredLaunch(id))
        await fixture.transport.emit(["type": "session.launch.result", "launchId": id, "phase": "unknown", "error": "launch timed out"])
        #expect(await !fixture.host.endConfiguredLaunch("stale"))
        #expect(await fixture.host.endConfiguredLaunch(id))
        #expect(fixture.host.launching == nil)
        #expect(fixture.host.pendingSends.items.isEmpty)
        #expect(fixture.host.recoveredLaunchDraft?.text == "unsent first")
        #expect(fixture.host.createSession(agentKind: "codex", cwd: "/repo/app", firstMessage: "new input"))
        await fixture.store.waitForPendingEvents()
        let next = try #require(fixture.host.launching?.requestId)
        await fixture.transport.emit(["type": "session.launch.result", "launchId": id, "phase": "ready", "sessionId": "late-old-session"])
        await fixture.transport.online("late-old-session")
        #expect(fixture.host.launching?.requestId == next)
        #expect(fixture.host.launching?.sessionId == nil)
        #expect(fixture.transport.userMessages.isEmpty)
    }

    // LAUNCH-WAIT-02: failure to save abandonment leaves the same recovery record
    // and first message. A successful explicit retry stops recovery across restart.
    @Test func endWaitWriteFailureKeepsTheOriginalLaunchUntilDurableRetry() async throws {
        let files = FileManager.default
        let root = files.temporaryDirectory.appendingPathComponent("orbis-end-wait-io-" + UUID().uuidString)
        defer { try? files.removeItem(at: root) }
        let fixture = Fixture(root: root); try await configured(fixture)
        #expect(fixture.host.createSession(agentKind: "codex", cwd: "/repo/app", firstMessage: "keep my draft"))
        await fixture.store.waitForPendingEvents()
        let id = try #require(fixture.host.launching?.requestId)
        let firstId = try #require(fixture.host.pendingSends.items.first?.messageId)
        await fixture.transport.emit(["type": "session.launch.result", "launchId": id, "phase": "unknown"])
        let directory = root.appendingPathComponent("ConfiguredLaunches", isDirectory: true)
        let journal = try #require(files.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil).first)
        let original = try Data(contentsOf: journal)
        try files.setAttributes([.posixPermissions: 0o500], ofItemAtPath: directory.path)
        defer { try? files.setAttributes([.posixPermissions: 0o700], ofItemAtPath: directory.path) }

        #expect(await !fixture.host.endConfiguredLaunch(id))
        #expect(fixture.host.launching?.requestId == id)
        #expect(fixture.host.launching?.failure == L10n.tr("无法保存启动恢复记录，请重试"))
        #expect(fixture.host.pendingSends.item(firstId)?.text == "keep my draft")
        #expect(fixture.host.recoveredLaunchDraft == nil)
        await fixture.store.waitForPendingEvents()
        #expect(try Data(contentsOf: journal) == original)

        try files.setAttributes([.posixPermissions: 0o700], ofItemAtPath: directory.path)
        #expect(await fixture.host.endConfiguredLaunch(id))
        #expect(fixture.host.launching == nil)
        #expect(fixture.host.pendingSends.items.isEmpty)
        let restarted = Fixture(root: root)
        try await configured(restarted)
        #expect(restarted.host.recoveredLaunchDraft?.text == "keep my draft")
        #expect(!restarted.transport.sent.contains { $0["type"] as? String == "session.launch.read" })
        await restarted.transport.emit(["type": "session.launch.result", "launchId": id, "phase": "absent"])
        #expect(!restarted.transport.sent.contains { $0["type"] as? String == "session.launch" })
        #expect(restarted.host.createSession(agentKind: "codex", cwd: "/repo/app", firstMessage: "edited draft"))
        #expect(restarted.host.launching?.requestId != id)
        await restarted.store.waitForPendingEvents()
        #expect(restarted.transport.userMessages.isEmpty)
    }

    // LAUNCH-WAIT-02: replies already queued behind an IO write cannot release the
    // first sentence or resend the launch once abandonment has been admitted.
    @Test(arguments: ["ready", "absent"]) func endWaitFencesAResultAlreadyWaitingForDisk(phase: String) async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("orbis-end-wait-late-" + UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let gate = MainThreadWorkGate()
        let fixture = Fixture(root: root, localStores: HostLocalStores(io: HostLocalIO(beforeIO: { gate.work() })))
        try await configured(fixture)
        #expect(fixture.host.createSession(agentKind: "codex", cwd: "/repo/app", firstMessage: "never send me"))
        await fixture.store.waitForPendingEvents()
        let id = try #require(fixture.host.launching?.requestId)
        await fixture.transport.emit(["type": "session.launch.result", "launchId": id, "phase": "unknown"])
        await fixture.transport.online("native-before-confirmation")
        let startCount = fixture.transport.sent.filter { $0["type"] as? String == "session.launch" }.count
        gate.arm()
        fixture.transport.receive?(["type": "session.launch.result", "launchId": id, "phase": phase,
                                    "sessionId": "native-before-confirmation"], "ctl")
        try #require(await gate.waitEntered())
        let ending = Task { await fixture.host.endConfiguredLaunch(id) }
        // Rendezvous with the admitted transition before unblocking the earlier write.
        for _ in 0..<100 where fixture.host.launching?.endingWait != true { await Task.yield() }
        #expect(fixture.host.launching?.endingWait == true)
        #expect(fixture.host.recoveredLaunchDraft == nil)
        #expect(await !fixture.host.endConfiguredLaunch(id))
        if phase == "ready" {
            fixture.host.selectRuntime("rt-native-before-confirmation")
        }
        gate.release.signal()
        #expect(await ending.value == (phase == "absent"))
        await fixture.store.waitForPendingEvents()
        #expect(fixture.host.recoveredLaunchDraft?.text == "never send me")
        #expect(fixture.host.pendingSends.items.isEmpty)
        #expect(fixture.transport.userMessages.isEmpty)
        #expect(fixture.transport.sent.filter { $0["type"] as? String == "session.launch" }.count == startCount)
        if phase == "ready" { #expect(fixture.host.selectedRuntimeId == "rt-native-before-confirmation") }
    }

    // Host rollback can report the ledger record absent after it already supplied
    // a native session identity. Keep verifying that identity; never create again.
    @Test func absentReceiptCannotRecreateAKnownNativeSession() async throws {
        let fixture = Fixture(); try await configured(fixture)
        #expect(fixture.host.createSession(agentKind: "codex", cwd: "/repo/app", firstMessage: "keep waiting"))
        await fixture.store.waitForPendingEvents()
        let id = try #require(fixture.host.launching?.requestId)
        await fixture.transport.emit(["type": "session.launch.result", "launchId": id, "phase": "ready", "sessionId": "known-native"])
        await fixture.transport.emit(["type": "session.launch.result", "launchId": id, "phase": "absent"])
        #expect(fixture.host.launching?.sessionId == "known-native")
        #expect(fixture.host.launching?.unconfirmed == true)
        #expect(fixture.transport.sent.filter { $0["type"] as? String == "session.launch" }.count == 1)
        #expect(fixture.transport.userMessages.isEmpty)
    }

    // A Host rollback does not revive or block the earlier configured request.
    @Test func legacyLaunchCanProceedWithAnUncertainConfiguredRecord() async throws {
        let fixture = Fixture(); try await configured(fixture)
        #expect(fixture.host.createSession(agentKind: "codex", cwd: "/repo/app", firstMessage: "pending draft"))
        await fixture.store.waitForPendingEvents()
        let id = try #require(fixture.host.launching?.requestId)
        await fixture.transport.emit(["type": "session.launch.result", "launchId": id, "phase": "unknown"])
        fixture.host.stopFollowingLaunch()
        await fixture.transport.ready()
        #expect(fixture.host.createSession(agentKind: "codex", cwd: "/repo/app", firstMessage: ""))
        #expect(fixture.transport.activations.count == 1)
        #expect(fixture.host.launching?.requestId != id)
        #expect(fixture.host.pendingSends.items.contains { $0.text == "pending draft" })
        #expect(fixture.transport.userMessages.isEmpty)
    }

    // SC97: invalid first-sentence text may be corrected immediately, without a
    // redundant configuration read or damage to any previously selected runtime.
    @Test func correctingFirstSentenceValidationReusesConfirmedConfiguration() async throws {
        let fixture = Fixture(); try await configured(fixture)
        #expect(!fixture.host.createSession(agentKind: "codex", cwd: "/repo/app", firstMessage: "/invalid"))
        #expect(fixture.host.sessionConfigurationError == nil)
        #expect(fixture.host.sessionLaunchError == L10n.tr("请从命令菜单选择斜杠命令。"))
        fixture.host.clearSessionLaunchValidationError()
        #expect(fixture.host.sessionLaunchError == nil)
        #expect(fixture.host.createSession(agentKind: "codex", cwd: "/repo/app", firstMessage: "valid first sentence"))
    }

    // SC96: Host echoes requestId for version refusals of launch/configuration
    // requests as well as commandId for runtime commands.
    @Test func correlatedVersionRefusalRejectsTheConfiguredLaunchByRequestId() async throws {
        let fixture = Fixture(); try await configured(fixture)
        #expect(fixture.host.createSession(agentKind: "codex", cwd: "/repo/app", firstMessage: "preserve this"))
        await fixture.store.waitForPendingEvents()
        let id = try #require(fixture.host.launching?.requestId)
        #expect(fixture.transport.sent.contains { $0["type"] as? String == "session.launch" && $0["requestId"] as? String == id })
        await fixture.transport.emit(["type": "protocol.error", "requestId": id, "code": "protocol_version_mismatch", "message": "仅支持已实现的协议 18 / 19"])
        #expect(fixture.host.launching?.failure == "仅支持已实现的协议 18 / 19")
        #expect(fixture.host.activatingSessionId == nil)
        #expect(fixture.host.pendingSends.items.first?.state == .failed(L10n.tr("会话启动未完成，消息未发送")))
        #expect(fixture.host.feedback.banner?.action == .update)
    }

    @Test func correlatedVersionRefusalFinishesOnlyItsConfigurationRequest() async throws {
        let fixture = Fixture(); await fixture.transport.ready()
        await fixture.transport.emit(["type": "device.ready", "modelEpoch": "epoch", "sessionConfiguration": 1, "runtimes": []])
        fixture.host.loadSessionConfiguration(agent: "codex", cwd: "/repo/app")
        let id = try #require(fixture.host.sessionConfigurationRequest)
        await fixture.transport.emit(["type": "protocol.error", "requestId": id, "code": "protocol_version_mismatch", "message": "仅支持已实现的协议 18 / 19"])
        #expect(fixture.host.sessionConfigurationRequest == nil)
        #expect(fixture.host.sessionConfigurationError == "仅支持已实现的协议 18 / 19")
        #expect(fixture.host.sessionLaunchError == nil)
        #expect(fixture.host.feedback.banner?.action == .update)
    }

    // SC99: both correlation identities own a result, even when commandId is
    // an in-flight sentence and requestId is a separate configured launch.
    @Test(arguments: ["protocol_version_mismatch", "session_configuration_failed"])
    func rejectionSettlesBothTheCommandAndRequestOwners(code: String) async throws {
        let fixture = Fixture(); try await configured(fixture)
        await fixture.transport.online("source")
        fixture.host.selectRuntime("rt-source")
        #expect(fixture.host.sendMessage("already sending"))
        let send = try #require(fixture.host.pendingSends.items.first)
        #expect(fixture.host.createSession(agentKind: "codex", cwd: "/repo/app", firstMessage: "waiting for launch"))
        await fixture.store.waitForPendingEvents()
        let id = try #require(fixture.host.launching?.requestId)
        await fixture.transport.emit(["type": "protocol.error", "commandId": send.commandId, "requestId": id,
            "code": code, "message": "launch rejected"])
        #expect(fixture.host.launching?.failure == "launch rejected")
        #expect(fixture.host.activatingSessionId == nil)
        #expect(fixture.host.pendingSends.item(send.messageId)?.state == .failed("launch rejected"))
        #expect(fixture.host.pendingSends.items.last?.state == .failed(L10n.tr("会话启动未完成，消息未发送")))
        #expect((fixture.host.feedback.banner != nil) == (code == "protocol_version_mismatch"))
    }

    // SC99: a command-owned close and request-owned launch are independent
    // ledger operations; each receives the explicit rejection exactly once.
    @Test(arguments: ["protocol_version_mismatch", "session_configuration_failed"])
    func rejectionSettlesBothLedgerIdentities(code: String) async throws {
        let fixture = Fixture(); try await configured(fixture)
        await fixture.transport.online("source")
        await fixture.transport.emit(["type": "runtime.event", "runtimeId": "rt-source", "sequence": 1,
            "event": ["type": "runtime.capabilities", "capabilities": ["commands": [["name": "quit", "source": "builtin"]]]]])
        #expect(fixture.host.closeRuntimes(["rt-source"]) == ["rt-source"])
        let commandId = try #require(fixture.transport.sent.last { ($0["command"] as? [String: Any])?["name"] as? String == "quit" }?["commandId"] as? String)
        #expect(fixture.host.createSession(agentKind: "codex", cwd: "/repo/app", firstMessage: ""))
        await fixture.store.waitForPendingEvents()
        let requestId = try #require(fixture.host.launching?.requestId)
        await fixture.transport.emit(["type": "protocol.error", "commandId": commandId, "requestId": requestId,
            "code": code, "message": "operations rejected"])
        #expect(fixture.host.closingRuntimeIds.isEmpty)
        #expect(fixture.host.objectError("rt-source") == L10n.tr("关闭会话未完成：{0}", "operations rejected"))
        #expect(fixture.host.launching?.failure == "operations rejected")
        #expect(fixture.host.activatingSessionId == nil)
    }

    // LAUNCH-FIRST-01: the new-session gesture does not read or present the previous request.
    @Test func laterLaunchDoesNotNavigateToOrReadUnconfirmedLaunch() async throws {
        let fixture = Fixture(); try await configured(fixture)
        #expect(fixture.host.createSession(agentKind: "codex", cwd: "/repo/app", firstMessage: "first"))
        await fixture.store.waitForPendingEvents()
        let id = try #require(fixture.host.launching?.requestId)
        await fixture.transport.emit(["type": "session.launch.result", "launchId": id, "phase": "unknown", "error": "launch unavailable"])
        fixture.host.stopFollowingLaunch()
        #expect(fixture.host.canReviewPreviousLaunch)
        #expect(fixture.host.createSession(agentKind: "codex", cwd: "/repo/app", firstMessage: "second"))
        await fixture.store.waitForPendingEvents()
        #expect(fixture.host.launching?.requestId != id)
        #expect(fixture.host.sessionLaunchError == nil)
        #expect(fixture.transport.sent.allSatisfy { $0["type"] as? String != "session.launch.read" })
        #expect(fixture.transport.userMessages.isEmpty)
    }

    // SC102: a not-connected launch hint is resolved by its own condition, the
    // computer becoming ready again; editing alone does not dismiss it.
    @Test func notConnectedLaunchHintClearsWhenTheComputerIsReadyAgain() async throws {
        let fixture = await setup(); let host = fixture.host
        fixture.transport.accepting = false
        host.createSession(agentKind: "codex", cwd: "/repo/app")
        let hint = L10n.tr("未连接到电脑，连接恢复后可重试。")
        #expect(host.sessionLaunchError == hint)
        host.clearSessionLaunchValidationError()
        #expect(host.sessionLaunchError == hint)
        fixture.transport.accepting = true
        fixture.transport.state?(.offline, nil)
        await fixture.transport.ready()
        #expect(host.sessionLaunchError == nil)
    }

    // SC99: a rejection without a reason keeps each owner's own copy; only the
    // ledger receipt needs the generic sentence.
    @Test func rejectionWithoutReasonKeepsEachOwnersCopy() async throws {
        let fixture = Fixture()
        await fixture.transport.emit(["type": "device.ready", "modelEpoch": "epoch", "sessionConfiguration": 1, "runtimes": []])
        fixture.host.loadSessionConfiguration(agent: "codex", cwd: "/repo/app")
        let configuration = try #require(fixture.host.sessionConfigurationRequest)
        await fixture.transport.emit(["type": "protocol.error", "requestId": configuration, "code": "session_configuration_failed"])
        #expect(fixture.host.sessionConfigurationError == L10n.tr("配置未确认"))
        fixture.host.browseDirectory("/repo")
        let browse = try #require(fixture.host.browse?.requestId)
        await fixture.transport.emit(["type": "protocol.error", "requestId": browse, "code": "cwd_missing"])
        #expect(fixture.host.browse?.error == L10n.tr("目录不可读"))
        await fixture.transport.online("source")
        fixture.host.selectRuntime("rt-source")
        #expect(fixture.host.sendMessage("not accepted"))
        let send = try #require(fixture.host.pendingSends.items.first)
        await fixture.transport.emit(["type": "protocol.error", "commandId": send.commandId, "code": "command_rejected"])
        #expect(fixture.host.pendingSends.item(send.messageId)?.state == .failed(L10n.tr("电脑端没有接受这条消息")))
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
        #expect(fixture.host.createSession(agentKind: "codex", cwd: "/repo/app", firstMessage: "independent input"))
        #expect(fixture.host.pendingSends.items.count == 2)
        #expect(fixture.transport.sent.allSatisfy { $0["type"] as? String != "session.launch" })
        gate.release.signal()
        await fixture.store.waitForPendingEvents()
        let ids = Set(fixture.transport.sent.filter { $0["type"] as? String == "session.launch" }.compactMap { $0["launchId"] as? String })
        #expect(ids.count == 2)
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
        let envelope = try #require(JSONSerialization.jsonObject(with: Data(contentsOf: file)) as? [String: Any])
        let saved = try #require((envelope["records"] as? [String: [String: Any]])?[id])
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

    // LAUNCH-FIRST-01: a late Desktop receipt is applied in the background, and
    // an independently requested launch never waits for the preceding history echo.
    @Test(arguments: [false, true])
    func desktopFirstMessageDoesNotRequireAnotherCreate(runtimeInReady: Bool) async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("orbis-desktop-first-" + UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let fixture = Fixture(root: root)
        try await configured(fixture, agent: "codexDesktop")
        #expect(fixture.host.createSession(agentKind: "codexDesktop", cwd: "/repo/app", firstMessage: "first desktop input"))
        await fixture.store.waitForPendingEvents()
        let first = try #require(fixture.host.launching?.requestId)
        let firstMessage = try #require(fixture.host.pendingSends.items.first?.messageId)
        await fixture.transport.emit(["type": "session.launch.result", "launchId": first, "phase": "unknown"])
        fixture.host.stopFollowingLaunch()
        let revision = fixture.host.activationRevision
        let firstRuntime = ["runtimeId": "codex-desktop:native-first", "sessionId": "native-first", "agentKind": "codexDesktop",
                            "status": "idle", "name": "Codex Desktop", "cwd": "/repo/app"]
        let ready: [String: Any] = ["type": "session.launch.result", "launchId": first, "phase": "ready", "sessionId": "native-first"]
        if !runtimeInReady { await fixture.transport.emit(["type": "runtime.online", "runtime": firstRuntime]) }
        #expect(fixture.transport.userMessages.isEmpty)
        await fixture.transport.emit(ready)
        if runtimeInReady {
            await fixture.transport.emit(["type": "device.ready", "modelEpoch": "epoch", "sessionConfiguration": 1,
                "agents": ["codexDesktop"], "runtimes": [firstRuntime]])
        }
        #expect(fixture.host.activationRevision == revision)
        #expect(fixture.transport.userMessages.map { $0["runtimeId"] as? String } == ["codex-desktop:native-first"])
        #expect(fixture.host.pendingSends.item(firstMessage)?.runtimeId == "codex-desktop:native-first")

        #expect(fixture.host.createSession(agentKind: "codexDesktop", cwd: "/repo/app", firstMessage: "second desktop input"))
        await fixture.store.waitForPendingEvents()
        let second = try #require(fixture.host.launching?.requestId)
        #expect(first != second)
        await fixture.transport.emit(ready)
        #expect(fixture.host.launching?.requestId == second)
        #expect(fixture.transport.userMessages.count == 1)
        await fixture.transport.emit(["type": "runtime.online", "runtime": ["runtimeId": "codex-desktop:native-second", "sessionId": "native-second",
            "agentKind": "codexDesktop", "status": "idle", "name": "Codex Desktop", "cwd": "/repo/app"]])
        await fixture.transport.emit(["type": "session.launch.result", "launchId": second, "phase": "ready", "sessionId": "native-second"])
        #expect(fixture.transport.userMessages.map { $0["runtimeId"] as? String } == ["codex-desktop:native-first", "codex-desktop:native-second"])
        #expect(fixture.host.selectedRuntimeId == "codex-desktop:native-second")
    }

    // LAUNCH-FIRST-01: B can settle while A is still in native create; a later
    // acknowledgement of A never changes B's selection or its outbox.
    @Test(arguments: ["creating", "unknown"])
    func desktopLaunchesAreIndependentBeforeFirstRuntime(firstPhase: String) async throws {
        let fixture = Fixture()
        try await configured(fixture, agent: "codexDesktop")
        #expect(fixture.host.createSession(agentKind: "codexDesktop", cwd: "/repo/app", firstMessage: "old input"))
        await fixture.store.waitForPendingEvents()
        let first = try #require(fixture.host.launching?.requestId)
        await fixture.transport.emit(["type": "session.launch.result", "launchId": first, "phase": firstPhase])
        #expect(fixture.host.createSession(agentKind: "codexDesktop", cwd: "/repo/app", firstMessage: "new input"))
        await fixture.store.waitForPendingEvents()
        let second = try #require(fixture.host.launching?.requestId)
        #expect(first != second)
        #expect(fixture.transport.sent.filter { $0["type"] as? String == "session.launch" }.compactMap { $0["launchId"] as? String } == [first, second])
        #expect(fixture.transport.sent.allSatisfy { $0["type"] as? String != "session.launch.read" })
        func ready(_ request: String, _ thread: String) async {
            await fixture.transport.emit(["type": "runtime.online", "runtime": ["runtimeId": "rt-" + thread, "sessionId": thread,
                "agentKind": "codexDesktop", "name": "Codex Desktop", "cwd": "/repo/app", "status": "idle"]])
            await fixture.transport.emit(["type": "session.launch.result", "launchId": request, "phase": "ready", "sessionId": thread])
        }
        await ready(second, "second")
        #expect(fixture.transport.userMessages.map { $0["runtimeId"] as? String } == ["rt-second"])
        #expect(fixture.host.selectedRuntimeId == "rt-second")
        let revision = fixture.host.activationRevision
        await ready(first, "first")
        #expect(fixture.transport.userMessages.map { $0["runtimeId"] as? String } == ["rt-second", "rt-first"])
        #expect(fixture.transport.userMessages.compactMap { ($0["command"] as? [String: Any])?["text"] as? String } == ["new input", "old input"])
        #expect(fixture.host.selectedRuntimeId == "rt-second")
        #expect(fixture.host.activationRevision == revision)
    }

    // LAUNCH-FIRST-01: relaunch recovers the prior first sentence under its own
    // Runtime while another launch is pending; only a matching history echo removes it.
    @Test func landedDesktopFirstSentenceSurvivesRestartWithoutReplay() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("orbis-desktop-restart-" + UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let original = Fixture(root: root); try await configured(original, agent: "codexDesktop")
        #expect(original.host.createSession(agentKind: "codexDesktop", cwd: "/repo/app", firstMessage: "recover the original input"))
        await original.store.waitForPendingEvents()
        let id = try #require(original.host.launching?.requestId)
        let firstId = try #require(original.host.pendingSends.items.first?.messageId)
        let runtime = ["runtimeId": "rt-first", "sessionId": "native-first", "agentKind": "codexDesktop", "status": "idle", "name": "Desktop", "cwd": "/repo/app"]
        await original.transport.emit(["type": "runtime.online", "runtime": runtime])
        await original.transport.emit(["type": "session.launch.result", "launchId": id, "phase": "ready", "sessionId": "native-first"])
        #expect(original.transport.userMessages.count == 1)
        #expect(original.host.createSession(agentKind: "codexDesktop", cwd: "/repo/app", firstMessage: "a separate input"))
        await original.store.waitForPendingEvents()
        let second = try #require(original.host.launching?.requestId)

        let restarted = Fixture(root: root)
        await restarted.transport.emit(["type": "device.ready", "modelEpoch": "epoch", "sessionConfiguration": 1, "agents": ["codexDesktop"], "runtimes": [runtime]])
        #expect(restarted.host.pendingSends.item(firstId)?.runtimeId == "rt-first")
        #expect(restarted.host.pendingSends.item(firstId)?.state == .unconfirmed)
        #expect(restarted.transport.sent.filter { $0["type"] as? String == "session.launch.read" }.compactMap { $0["launchId"] as? String } == [second])
        #expect(restarted.transport.userMessages.isEmpty)
        await restarted.transport.emit(["type": "runtime.event", "runtimeId": "rt-first", "sequence": 1, "event": ["type": "message.started", "message": [
            "messageId": "native-item", "clientMessageId": firstId, "role": "user", "timestamp": 100,
            "content": [["type": "text", "text": "recover the original input"]],
        ]]])
        #expect(restarted.host.pendingSends.item(firstId) == nil)
        #expect(restarted.host.launching?.requestId == second)
        #expect(restarted.transport.userMessages.isEmpty)
    }

    // OPENCLAW-03: no native defaults are guessed; runtime.online alone cannot release the first sentence.
    @Test func openClawUsesHeadlessJournalAndSendsOnlyAfterMatchingReady() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("orbis-claw-launch-" + UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let fixture = Fixture(root: root)
        await fixture.transport.ready()
        #expect(!fixture.host.createSession(agentKind: "openclaw", cwd: "/repo/app", firstMessage: "hello"))
        #expect(fixture.transport.activations.isEmpty)
        await fixture.transport.emit(["type": "device.ready", "modelEpoch": "epoch", "sessionConfiguration": 1, "runtimes": [],
            "hostFeatures": ["device.features", "agent.openclaw"], "deviceFeatures": ["agent.dshDesktop", "agent.openclaw"],
            "dshDesktop": NSNull(), "agents": ["openclaw"], "launchableAgents": ["openclaw"]])
        fixture.host.loadSessionConfiguration(agent: "openclaw", cwd: "/repo/app")
        let read = try #require(fixture.transport.sent.last { $0["type"] as? String == "session.configuration.read" })
        await fixture.transport.emit(["type": "session.configuration.result", "requestId": read["requestId"]!, "agentKind": "openclaw", "cwd": "/repo/app",
            "binding": "gateway-defaults", "revision": 0, "values": [:],
            "catalog": ["binding": "gateway-defaults", "defaults": [:], "models": [], "permissions": []]])
        #expect(fixture.host.createSession(agentKind: "openclaw", cwd: "/repo/app", firstMessage: "hello"))
        await fixture.store.waitForPendingEvents()
        let launch = try #require(fixture.transport.sent.last { $0["type"] as? String == "session.launch" })
        let id = try #require(launch["launchId"] as? String)
        #expect(launch["spawnMode"] as? String == "headless")
        #expect(launch["binding"] as? String == "gateway-defaults")
        #expect(fixture.transport.activations.isEmpty)
        await fixture.transport.emit(["type": "runtime.online", "runtime": ["runtimeId": "openclaw:runtime", "sessionId": "openclaw:session",
            "name": "OpenClaw", "cwd": "/repo/app", "status": "idle"]])
        await fixture.transport.emit(["type": "session.launch.result", "requestId": id, "launchId": id, "phase": "configuring", "sessionId": "openclaw:session"])
        #expect(fixture.transport.userMessages.isEmpty)
        await fixture.transport.emit(["type": "session.launch.result", "requestId": id, "launchId": id, "phase": "ready",
            "agentKind": "openclaw", "sessionId": "openclaw:session", "spawnMode": "headless"])
        #expect(fixture.transport.userMessages.count == 1)
        #expect(fixture.transport.userMessages.first?["runtimeId"] as? String == "openclaw:runtime")
        #expect(fixture.host.selectedRuntimeId == "openclaw:runtime")
    }

    // OPENCLAW-DRAFT-FEEDBACK-01: safe Host replies and local send failure are distinct,
    // scoped to the current read's directory, and never admit a launch by themselves.
    @Test func openClawConfigurationFeedbackBelongsToTheCurrentRead() async throws {
        let fixture = Fixture()
        await fixture.transport.emit(["type": "device.ready", "modelEpoch": "epoch", "sessionConfiguration": 1, "runtimes": [],
            "hostFeatures": ["device.features", "agent.openclaw"], "deviceFeatures": ["agent.dshDesktop", "agent.openclaw"],
            "dshDesktop": NSNull(), "agents": ["openclaw"], "launchableAgents": ["openclaw"]])
        fixture.transport.accepting = false
        fixture.host.loadSessionConfiguration(agent: "openclaw", cwd: "/repo/app")
        #expect(fixture.host.sessionConfigurationRequest == nil)
        #expect(fixture.host.sessionConfigurationError == L10n.tr("配置请求未发送，请检查连接后重试"))
        fixture.transport.accepting = true
        fixture.host.loadSessionConfiguration(agent: "openclaw", cwd: "/repo/other")
        let id = try #require(fixture.host.sessionConfigurationRequest)
        #expect(fixture.host.openClawConfigurationCwd == "/repo/other")
        let safe = "缺少 OpenClaw Gateway 令牌。请在电脑的 Orbis Host → OpenClaw 填入 Gateway 令牌并应用。"
        func reject(_ request: String, _ detail: String) async {
            await fixture.transport.emit(["type": "protocol.error", "requestId": request,
                "code": "configuration_unavailable", "message": detail])
        }
        await reject("stale", safe)
        #expect(fixture.host.sessionConfigurationRequest == id)
        #expect(fixture.host.sessionConfigurationError == nil)
        await reject(id, safe)
        #expect(fixture.host.sessionConfigurationRequest == nil)
        #expect(fixture.host.sessionConfigurationError == L10n.hostText(safe))
        #expect(!fixture.host.createSession(agentKind: "openclaw", cwd: "/repo/other", firstMessage: "hello"))
        #expect(fixture.transport.sent.allSatisfy { $0["type"] as? String != "session.launch" })
        #expect(fixture.transport.userMessages.isEmpty)
        fixture.host.loadSessionConfiguration(agent: "openclaw", cwd: "/repo/other")
        let retry = try #require(fixture.host.sessionConfigurationRequest)
        await reject(id, safe)
        await fixture.transport.emit(["type": "session.configuration.result", "requestId": retry, "agentKind": "openclaw", "cwd": "/repo/app",
            "binding": "gateway-defaults", "revision": 0, "values": [:],
            "catalog": ["binding": "gateway-defaults", "defaults": [:], "models": [], "permissions": []]])
        #expect(fixture.host.sessionConfigurationRequest == retry)
        #expect(fixture.host.sessionConfiguration == nil)
        await reject(retry, "上游错误 token=fixture-secret")
        #expect(fixture.host.sessionConfigurationError == L10n.tr("电脑端未能确认 OpenClaw 配置，请检查电脑端 Orbis 后重试"))
    }

    // OPENCLAW-DRAFT-FEEDBACK-01: no raw Host details on the launch page, including an exact line followed by debug data.
    @Test func openClawLaunchDisplaysOnlyExactLocalizedHostAdvice() {
        let safe = "缺少 OpenClaw Gateway 令牌。请在电脑的 Orbis Host → OpenClaw 填入 Gateway 令牌并应用。"
        let unconfirmed = "OpenClaw Gateway 未确认这次启动。请先核对原启动和会话列表，不要直接再次创建。"
        func detail(_ value: String?, unconfirmed: Bool) -> String? {
            FeedbackText.openClawInlineLaunchDetail(agent: "openclaw", detail: value, unconfirmed: unconfirmed, language: .english)
        }
        #expect(FeedbackText.openClawInlineLaunchDetail(agent: "codex", detail: safe, unconfirmed: false) == nil)
        #expect(detail(safe, unconfirmed: false) == "OpenClaw Gateway token missing. On your computer, open Orbis Host → OpenClaw, enter the Gateway token, and apply the change.")
        #expect(detail(unconfirmed, unconfirmed: true) == "OpenClaw Gateway did not confirm this launch. Check the previous launch and the session list before creating another session.")
        #expect(detail(unconfirmed + "\n调试数据 fixture-secret", unconfirmed: true) == "Check the previous launch and first message before starting another session.")
        #expect(detail(nil, unconfirmed: true) == "Check the previous launch and first message before starting another session.")
        #expect(detail("内部 OpenClaw 错误 fixture-secret", unconfirmed: false) == "Check the Orbis Host diagnostics on your computer, then return to the new-session draft.")
    }

    // OPENCLAW-DRAFT-DIAGNOSTIC-01: current authenticated backends can explain a source that cannot start.
    @Test func openClawDraftDiagnosticNeedsCurrentAuthenticatedBackendsAndDoesNotGrantLaunchability() async throws {
        let fixture = Fixture()
        let host = fixture.host
        let ready: [String: Any] = ["type": "device.ready", "modelEpoch": "epoch", "sessionConfiguration": 1, "runtimes": [],
            "hostFeatures": ["device.features", "agent.openclaw", "agent.enablement.v1"],
            "deviceFeatures": ["agent.dshDesktop", "agent.openclaw", "agent.enablement.v1"],
            "dshDesktop": NSNull(), "agents": ["codex"], "launchableAgents": ["codex"]]
        await fixture.transport.emit(ready)
        let request = try #require(fixture.transport.sent.last { $0["type"] as? String == "agent.state.request" && $0["scope"] as? String == "host" })
        func snapshot(revision: Int, rows: [[String: Any]], availability: String = "ready", missing: Bool = false) -> [String: Any] {
            let backends: [String: Any] = ["domain": "backends", "modelEpoch": "epoch", "revision": revision, "availability": availability,
                "completeness": "complete", "checkedAt": revision,
                "source": ["producer": "host", "sourceId": "host", "sourceEpoch": "epoch", "sourceRevision": revision],
                "value": ["backends": rows, "agents": ["codex"], "launchableAgents": ["codex"]]]
            return ["type": "agent.state.snapshot", "requestId": request["requestId"]!, "scope": "host", "modelEpoch": "epoch",
                "stateFormat": request["stateFormat"] ?? NSNull(), "domains": missing ? [] : [backends],
                "missing": missing ? [["domain": "backends", "reason": "no_state"]] : [], "truncated": false]
        }
        let action = "OpenClaw Gateway 令牌不匹配。请在电脑的 Orbis Host → OpenClaw 核对令牌并重新应用。"
        let blocked: [String: Any] = ["kind": "openclaw", "ready": false, "reason": action]
        func advice() -> String? { host.openClawDraftDiagnostic(language: .english) }
        let update = snapshot(revision: 1, rows: [blocked])
        #expect(advice() == nil)
        fixture.transport.receive?(update, nil)
        await fixture.store.waitForPendingEvents()
        #expect(advice() == nil)
        await fixture.transport.emit(update)
        #expect(advice() == "The OpenClaw Gateway token does not match. Check the token in Orbis Host → OpenClaw on your computer and apply it again.")
        #expect(host.launchableAgents == ["codex"])
        #expect(!host.canLaunchOpenClaw)
        #expect(!host.createSession(agentKind: "openclaw", cwd: "/repo/app", firstMessage: "not sent"))
        #expect(!fixture.transport.sent.contains { ["session.configuration.read", "session.configuration.save", "session.launch", "session.activate"].contains($0["type"] as? String ?? "") })
        await fixture.transport.emit(snapshot(revision: 2, rows: [], missing: true))
        #expect(advice() == nil)
        await fixture.transport.emit(snapshot(revision: 3, rows: [blocked]))
        #expect(advice() != nil)
        await fixture.transport.emit(snapshot(revision: 4, rows: [blocked], availability: "unavailable"))
        #expect(advice() == nil)
        await fixture.transport.emit(snapshot(revision: 5, rows: [blocked]))
        #expect(advice() != nil)
        await fixture.transport.emit(snapshot(revision: 6, rows: []))
        await fixture.transport.emit(update) // Neither a missing row nor a newer revision can be undone by this old update.
        #expect(advice() == nil)
        await fixture.transport.emit(snapshot(revision: 7, rows: [blocked]))
        #expect(advice() != nil)
        let policy = try #require(fixture.transport.sent.last { $0["type"] as? String == "agent.enablement.read" }?["requestId"])
        await fixture.transport.emit(["type": "agent.enablement.snapshot", "requestId": policy,
            "snapshot": ["revision": 1, "agents": [["kind": "openclaw", "label": "OpenClaw", "enabled": false]]]])
        #expect(host.enabledAgentKinds == [])
        #expect(advice() == nil)
        fixture.transport.state?(.offline, nil)
        #expect(advice() == nil)
        await fixture.transport.emit(ready)
        await fixture.transport.emit(update) // Even the exact old authenticated subscription is retired.
        #expect(advice() == nil)
    }

    @Test func openClawBackendAdviceMapsPairingAndNeverUsesRawSentinels() {
        func row(ready: HostJSON = .bool(false), reason: HostJSON) -> HostJSON {
            .array([.object(["kind": .string("openclaw"), "ready": ready, "reason": reason])])
        }
        let action = "OpenClaw Gateway 令牌不匹配。请在电脑的 Orbis Host → OpenClaw 核对令牌并重新应用。"
        #expect(FeedbackText.openClawBackendAdvice(row(reason: .string(action))) == action)
        #expect(FeedbackText.openClawBackendAdvice(row(reason: .string("pairing_required"))) == "OpenClaw 等待设备批准。请在 OpenClaw 的设备列表批准 Orbis Host，再重新连接 Host。")
        #expect(FeedbackText.openClawBackendAdvice(row(ready: .bool(true), reason: .string(action))) == nil)
        #expect(FeedbackText.openClawBackendAdvice(row(ready: .string("false"), reason: .string(action))) == nil)
        for reason: HostJSON in [.string("starting"), .string("backend_not_ready"), .string(action + "\nfixture-secret"), .null] {
            #expect(FeedbackText.openClawBackendAdvice(row(reason: reason)) == "所选助手尚未就绪，请在电脑端检查")
        }
    }

    // AGY-13: negotiated AGY launches headless; runtime.online alone does not release the first sentence.
    @Test func agyUsesHeadlessJournalAndSendsOnlyAfterMatchingReady() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("orbis-agy-launch-" + UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let fixture = Fixture(root: root)
        await fixture.transport.ready()
        #expect(!fixture.host.createSession(agentKind: "agy", cwd: "/repo/app", firstMessage: "hello"))
        #expect(fixture.transport.activations.isEmpty)
        await fixture.transport.emit(["type": "device.ready", "modelEpoch": "epoch", "sessionConfiguration": 1, "runtimes": [],
            "hostFeatures": ["device.features", "agent.agy"], "deviceFeatures": ["agent.dshDesktop", "agent.agy"],
            "dshDesktop": NSNull(), "agents": ["agy"], "launchableAgents": ["agy"]])
        fixture.host.loadSessionConfiguration(agent: "agy", cwd: "/repo/app")
        let read = try #require(fixture.transport.sent.last { $0["type"] as? String == "session.configuration.read" })
        await fixture.transport.emit(["type": "session.configuration.result", "requestId": read["requestId"]!, "agentKind": "agy", "cwd": "/repo/app",
            "binding": "agy-acp-v1:isolated", "revision": 0, "values": [:],
            "catalog": ["binding": "agy-acp-v1:isolated", "defaults": [:], "models": [], "permissions": []]])
        #expect(fixture.host.createSession(agentKind: "agy", cwd: "/repo/app", firstMessage: "hello"))
        await fixture.store.waitForPendingEvents()
        let launch = try #require(fixture.transport.sent.last { $0["type"] as? String == "session.launch" })
        let id = try #require(launch["launchId"] as? String)
        #expect(launch["spawnMode"] as? String == "headless")
        #expect(launch["binding"] as? String == "agy-acp-v1:isolated")
        #expect(fixture.transport.activations.isEmpty)
        await fixture.transport.emit(["type": "runtime.online", "runtime": ["runtimeId": "agy:session", "sessionId": "agy:session",
            "name": "Antigravity CLI", "cwd": "/repo/app", "status": "idle"]])
        await fixture.transport.emit(["type": "session.launch.result", "requestId": id, "launchId": id, "phase": "configuring", "sessionId": "agy:session"])
        #expect(fixture.transport.userMessages.isEmpty)
        await fixture.transport.emit(["type": "session.launch.result", "requestId": id, "launchId": id, "phase": "ready",
            "agentKind": "agy", "sessionId": "agy:session", "spawnMode": "headless"])
        #expect(fixture.transport.userMessages.count == 1)
        #expect(fixture.transport.userMessages.first?["runtimeId"] as? String == "agy:session")
        #expect(fixture.host.selectedRuntimeId == "agy:session")

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

    // LAUNCH-FIRST-01: checking one ID can suspend; another ID's new receipt
    // must not be replaced by the earlier recovery snapshot on resumption.
    @Test func journalRecoveryKeepsANativeIdentityRecordedWhileCheckingAnotherLaunch() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("orbis-launch-recovery-race-" + UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let gate = MainThreadWorkGate()
        let stores = HostLocalStores(io: HostLocalIO(beforeIO: { gate.work() }))
        let journal = stores.journal(at: root.appendingPathComponent("ConfiguredLaunches/host%2D1.json"))
        await journal.waitLoaded()
        for id in ["older", "newer"] {
            let write = try #require(journal.reserve(["type": "session.launch", "launchId": id,
                "agentKind": "codexDesktop", "cwd": "/repo/app", "following": false]))
            #expect(await write.value)
        }
        let fixture = Fixture(root: root, localStores: stores)
        await fixture.store.waitForPendingEvents()
        gate.arm()
        let recovering = Task { await fixture.transport.emit(["type": "device.ready", "modelEpoch": "epoch",
            "sessionConfiguration": 1, "runtimes": []]) }
        let paused = await gate.waitEntered()
        fixture.transport.receive?(["type": "session.launch.result", "launchId": "older", "phase": "ready", "sessionId": "native-older"], "ctl")
        for _ in 0..<100 where journal.snapshot("older")?["sessionId"] == nil {
            try? await Task.sleep(for: .milliseconds(5))
        }
        #expect(paused && journal.snapshot("older")?["sessionId"] as? String == "native-older")
        gate.release.signal()
        await recovering.value
        #expect(journal.snapshot("older")?["sessionId"] as? String == "native-older")
        await fixture.transport.emit(["type": "session.launch.result", "launchId": "older", "phase": "absent"])
        #expect(fixture.transport.sent.allSatisfy { $0["type"] as? String != "session.launch" })
    }

    // LAUNCH-FIRST-01: delayed cold hydration may check a saved launch, but
    // only an explicit review may leave a newly opened draft or another chat.
    @Test(arguments: ["draft", "live", "cached"])
    func automaticLaunchRecoveryDoesNotReplaceUserSelection(page: String) async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("orbis-launch-selection-" + UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let original = Fixture(root: root)
        try await configured(original, agent: "codexDesktop")
        #expect(original.host.createSession(agentKind: "codexDesktop", cwd: "/repo/app", firstMessage: "old input"))
        await original.store.waitForPendingEvents()
        let id = try #require(original.host.launching?.requestId)

        let fixture = Fixture(root: root)
        let live = ["runtimeId": "rt-open", "sessionId": "open", "agentKind": "codex", "name": "Live", "cwd": "/repo/app", "status": "idle"]
        await fixture.transport.emit(["type": "device.ready", "modelEpoch": "epoch", "runtimes": [live]])
        switch page {
        case "draft": fixture.host.stopFollowingLaunch()
        case "live": fixture.host.selectRuntime("rt-open")
        default:
            #expect(fixture.host.openCachedSession(SessionSummary(sessionId: "saved", name: "Cached", cwd: "/repo/app",
                createdAt: 0, modifiedAt: 0, messageCount: 0, agentKind: "codex")))
        }
        let selection = fixture.host.selectedRuntimeId, revision = fixture.host.activationRevision
        await fixture.transport.emit(["type": "device.ready", "modelEpoch": "epoch", "sessionConfiguration": 1, "runtimes": [live]])
        #expect(fixture.host.selectedRuntimeId == selection)
        #expect(fixture.host.launching == nil)
        #expect(fixture.transport.sent.contains { $0["type"] as? String == "session.launch.read" && $0["launchId"] as? String == id })
        await fixture.transport.emit(["type": "session.launch.result", "launchId": id, "phase": "ready", "sessionId": "native-old"])
        await fixture.transport.emit(["type": "runtime.online", "runtime": ["runtimeId": "rt-native-old", "sessionId": "native-old",
            "agentKind": "codexDesktop", "name": "Codex Desktop", "cwd": "/repo/app", "status": "idle"]])
        #expect(fixture.host.selectedRuntimeId == selection && fixture.host.activationRevision == revision)
        #expect(fixture.transport.userMessages.isEmpty)
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
        #expect(recovered.host.recoveredLaunchDraft?.text == "preserve rejected sentence")
        #expect(recovered.host.pendingSends.items.isEmpty)
        #expect(recovered.host.launching == nil)
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

    @Test(arguments: [false, true])
    func unifiedResumeBindsWaitingSendToTheSelectedStoreBeforeRuntimeEvidence(runtimeArrivesBeforeAcknowledgement: Bool) async throws {
        let fixture = await setup()
        let selectedCatalog = "codex-history:" + String(repeating: "a", count: 64)
        let otherCatalog = "codex-history:" + String(repeating: "b", count: 64)
        func runtime(_ id: String, _ kind: String, _ catalog: String) -> [String: Any] {
            ["runtimeId": id, "sessionId": "same-thread", "name": "Codex", "cwd": "/repo/app",
             "status": "idle", "agentKind": kind, "codexCatalogId": catalog]
        }
        let features = ["device.features", codexUnifiedHistoryFeature]
        await fixture.transport.emit(["type": "device.ready", "modelEpoch": "epoch",
            "hostFeatures": features, "deviceFeatures": features,
            "dshDesktop": NSNull(),
            "agents": ["codex", "codexDesktop"], "launchableAgents": ["codex", "codexDesktop"],
            "runtimes": runtimeArrivesBeforeAcknowledgement
                ? [runtime("codex:same-thread", "codex", otherCatalog), runtime("codex-desktop:selected", "codexDesktop", selectedCatalog)]
                : []])

        let session = SessionSummary(sessionId: selectedCatalog, name: "Codex", cwd: "/repo/app", firstMessage: nil,
            createdAt: 0, modifiedAt: 0, messageCount: 1, agentKind: "codex", archived: false,
            codexLaunchModes: [.desktop, .terminal])
        #expect(fixture.host.codexResumeModes(session) == [.desktop, .terminal])
        if !runtimeArrivesBeforeAcknowledgement {
            fixture.store.activate(session)
            #expect(fixture.transport.activations.isEmpty, "two modes require a choice when the session is not running")
        }
        fixture.store.activate(session, codexLaunchMode: .desktop)
        #expect(fixture.host.sendMessage("resume on desktop"))
        #expect(fixture.transport.userMessages.isEmpty)
        let requestId = try #require(fixture.host.launching?.requestId)

        if !runtimeArrivesBeforeAcknowledgement {
            try await fixture.transport.emit(["type": "session.activated", "requestId": requestId,
                "sessionId": "same-thread", "codexCatalogId": selectedCatalog, "agentKind": "codexDesktop", "spawnMode": "tui"])
            await fixture.transport.emit(["type": "runtime.online", "runtime": runtime("codex:same-thread", "codex", otherCatalog)])
            #expect(fixture.transport.userMessages.isEmpty)
            await fixture.transport.emit(["type": "runtime.online", "runtime": runtime("codex-desktop:selected", "codexDesktop", selectedCatalog)])
        } else {
            try await fixture.transport.emit(["type": "session.activated", "requestId": requestId,
                "sessionId": "same-thread", "codexCatalogId": selectedCatalog, "agentKind": "codexDesktop", "spawnMode": "tui"])
        }

        let sent = try #require(fixture.transport.userMessages.first)
        #expect(fixture.transport.userMessages.count == 1)
        #expect(sent["runtimeId"] as? String == "codex-desktop:selected")
        #expect(fixture.host.pendingSends.items.first?.runtimeId == "codex-desktop:selected")
        #expect(fixture.host.pendingSends.items.first?.sessionId == "same-thread")
        #expect(fixture.host.launching == nil)
    }

    // CODEX-UNIFIED-RESUME-UI-01: a cached composer already on screen must update
    // Continue when a Host backend becomes ready or goes away, without reopening the page.
    @Test(arguments: CodexLaunchMode.allCases)
    func cachedUnifiedResumeSendsOnlyTheReadyMode(_ mode: CodexLaunchMode) async throws {
        let fixture = await setup()
        let features = ["device.features", codexUnifiedHistoryFeature]
        func ready(_ agents: [String]) async {
            await fixture.transport.emit(["type": "device.ready", "modelEpoch": "epoch", "hostFeatures": features,
                "deviceFeatures": features, "dshDesktop": NSNull(), "agents": agents,
                "launchableAgents": ["codex", "codexDesktop"], "runtimes": []])
        }
        await ready([])
        let id = "codex-history:" + String(repeating: "c", count: 64)
        let list = try #require(fixture.transport.sent.last { $0["type"] as? String == "session.list" }?["requestId"] as? String)
        await fixture.transport.emit(["type": "session.list.result", "requestId": list, "sessions": [[
            "sessionId": id, "name": "Cached Codex", "cwd": "/repo/app", "createdAt": 0, "modifiedAt": 0,
            "messageCount": 1, "agentKind": "codex", "archived": false, "codexLaunchModes": ["desktop", "terminal"]
        ]]])
        let session = try #require(fixture.host.sessions.first { $0.sessionId == id })
        #expect(fixture.store.openCachedSession(session))
        await fixture.store.waitForPendingEvents()
        let actions = ChatSessionActions(store: fixture.store, target: .capture(fixture.store))
        let before = fixture.store.chatScreens.composer
        #expect(before.cachedSession?.sessionId == id)
        #expect(before.connection == .secured)
        #expect(before.cachedCodexResumeModes.isEmpty)
        #expect(actions.codexResumeModes(session).isEmpty)

        await ready([mode.agentKind])
        let choices = actions.codexResumeModes(session)
        #expect(choices == [mode])
        let refreshed = fixture.store.chatScreens.composer
        #expect(refreshed.target == before.target)
        #expect(refreshed.connection == before.connection)
        #expect(refreshed.cachedCodexResumeModes == [mode])
        actions.activate(session, codexLaunchMode: mode == .desktop ? .terminal : .desktop)
        #expect(fixture.transport.activations.isEmpty)

        await ready([])
        #expect(fixture.store.chatScreens.composer.target == before.target)
        #expect(fixture.store.chatScreens.composer.cachedCodexResumeModes.isEmpty)
        actions.activate(session, codexLaunchMode: choices.first)
        #expect(fixture.transport.activations.isEmpty)

        await ready([mode.agentKind])
        actions.activate(session, codexLaunchMode: choices.first)

        #expect(fixture.transport.activations.count == 1)
        let request = try #require(fixture.transport.activations.first)
        let target = try #require(request["target"] as? [String: String])
        #expect(target == ["type": "resume", "sessionId": id, "agentKind": "codex"])
        #expect(request["spawnMode"] as? String == "auto")
        #expect(request["codexLaunchMode"] as? String == mode.rawValue)
        await fixture.store.waitForPendingEvents()
    }

    @Test func aFailureShowsInPlaceFailsWaitingMessagesAndCanRetry() async throws {
        let fixture = await setup(); let host = fixture.host
        host.createSession(agentKind: "codex", cwd: "/repo/app")
        _ = host.sendMessage("你好")
        let id = try #require(fixture.transport.activations.last?["requestId"] as? String)
        await fixture.transport.emit(["type": "protocol.error", "code": "agent_unsupported", "message": "对应的 agent 后端未就绪", "requestId": id])
        #expect(host.launching?.failure == "所选助手尚未就绪，请在电脑端检查")
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
