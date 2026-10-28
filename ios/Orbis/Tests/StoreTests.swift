import Foundation
import Testing
@testable import OrbisCore

private final class MemorySecureStore: SecureStorage {
    var hosts: [HostPairing] = [HostPairing(hostId: "host-1", hostName: "Test Host", hostPub: "public-test-key",
        pskRoot: Base64URL.encode(Data(repeating: 1, count: 32)), relay: RelayCredential(relayUrl: "wss://relay.example", deviceId: "device-1", credential: "test-only"), lan: [])]
    func deviceIdentity() throws -> DeviceIdentity { .generate() }
    func savePairings(_ pairings: [HostPairing]) throws { hosts = pairings }
    func pairings() -> [HostPairing] { hosts }
}

@MainActor
private final class TestTransport: OrbisTransport {
    var sent: [[String: Any]] = []
    var acceptsSends = true
    var receive: (([String: Any], String?) -> Void)?
    var state: ((ConnectionState, String?) -> Void)?
    func pair(qr: PairingQR, deviceName: String, identity: DeviceIdentity, completion: @escaping (Result<HostPairing, Error>) -> Void) { completion(.failure(PairingError.invalidQR)) }
    func connect(pairing: HostPairing, identity: DeviceIdentity, receive: @escaping ([String: Any], String?) -> Void, state: @escaping (ConnectionState, String?) -> Void) {
        self.receive = receive; self.state = state; state(.connecting, nil)
    }
    func disconnect() {}
    func send(_ object: [String: Any]) -> Bool { if acceptsSends { sent.append(object) }; return acceptsSends }
    func emit(_ message: [String: Any], channel: String? = "ctl") { receive?(message, channel) }
    var syncCommands: [[String: Any]] { sent.compactMap { $0["command"] as? [String: Any] }.filter { $0["type"] as? String == "session.sync" } }
    func ready(_ runtimes: [[String: Any]]) { emit(["type": "device.ready", "protocolVersion": orbisProtocolVersion, "runtimes": runtimes]) }
    func event(_ payload: [String: Any], runtimeId: String = "a", sequence: Int = 1, channel: String = "msg") {
        emit(["type": "runtime.event", "runtimeId": runtimeId, "sequence": sequence, "event": payload], channel: channel)
    }
}

@Suite("Native app state") @MainActor
struct StoreTests {
    @Test func pathOrderPersistsOfflineAndResendsAfterAuthenticatedReady() throws {
        let key = "orbis-settings-test-" + UUID().uuidString
        let preferences = try #require(UserDefaults(suiteName: key))
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(key)
        defer { preferences.removePersistentDomain(forName: key); try? FileManager.default.removeItem(at: root) }
        let transport = TestTransport()
        let store = OrbisStore(secure: MemorySecureStore(), transport: transport, autoConnect: false, preferences: preferences, transferRoot: root)
        store.setPathPreference(["relay", "relay", "p2p"])
        #expect(store.pathPreference == ["relay", "p2p", "lan"])
        #expect(transport.sent.isEmpty)
        store.connect(hostId: "host-1")
        transport.ready([])
        #expect(transport.sent.contains { $0["type"] as? String == "device.pathPreference" && $0["preference"] as? [String] == store.pathPreference })
        let restored = OrbisStore(secure: MemorySecureStore(), transport: TestTransport(), autoConnect: false, preferences: preferences, transferRoot: root)
        #expect(restored.pathPreference == store.pathPreference)
    }

    @Test func directoryProviderFactsRequireCurrentAuthenticatedRequest() throws {
        let (store, transport) = setup()
        transport.ready([])
        let id = try #require(transport.sent.last { $0["type"] as? String == "session.list" }?["requestId"] as? String)
        transport.emit(["type": "session.list.result", "requestId": "old", "sessions": [],
                        "currentProviders": [["agentKind": "codex", "provider": "wrong"]]])
        #expect(store.currentProviders.isEmpty)
        transport.emit(["type": "session.list.result", "requestId": id, "sessions": [],
                        "currentProviders": [["agentKind": "codex", "provider": "native-a"]]], channel: nil)
        #expect(store.currentProviders.isEmpty)
        transport.emit(["type": "session.list.result", "requestId": id, "sessions": [],
                        "currentProviders": [["agentKind": "codex", "provider": "native-a"]]])
        var session = SessionSummary(sessionId: "different", cwd: "/repo", createdAt: 0, modifiedAt: 0, messageCount: 1, agentKind: "codex")
        session.modelProvider = "native-b"
        #expect(store.providerMismatch(session)?.contains("native-b") == true)
        store.activate(session)
        #expect(!transport.sent.contains { $0["type"] as? String == "session.activate" })
        #expect(store.connection == .secured)
    }
    /// Host 的 runtime 元数据没有 agentKind：Codex / DeepSeek 进程不能被显示成 Pi。
    @Test func runtimeAgentKindIsResolvedWithoutHostField() throws {
        let (store, transport) = setup()
        transport.ready([runtime("codex:thread-1", session: "thread-1"), runtime("dsh:web-2", session: "dsh:web-2"), runtime("6f0d-pi", session: "pi-session")])
        let kinds = { store.runtimes.map { store.agentKind($0) } }
        #expect(kinds() == ["codex", "dsh", nil])
        let id = try #require(transport.sent.last { $0["type"] as? String == "session.list" }?["requestId"] as? String)
        transport.emit(["type": "session.list.result", "requestId": id, "sessions": [
            ["sessionId": "pi-session", "cwd": "/repo", "createdAt": 0, "modifiedAt": 0, "messageCount": 1, "agentKind": "pi"]
        ]])
        #expect(kinds() == ["codex", "dsh", "pi"])
    }
    private func runtime(_ id: String, session: String? = nil) -> [String: Any] {
        ["runtimeId": id, "name": "Agent \(id)", "cwd": "/repo", "status": "idle", "sessionId": session ?? "session-\(id)"]
    }
    private func message(_ id: String, text: String) -> [String: Any] {
        ["messageId": id, "role": "assistant", "timestamp": 100, "content": [["type": "text", "text": text]]]
    }
    private func snapshot(_ sync: [String: Any], text: String) -> [String: Any] {
        ["type": "session.snapshot", "sessionId": sync["sessionId"]!, "syncId": sync["syncId"]!, "mode": "replace",
         "display": ["entries": [["message": message(text, text: text)]]]]
    }
    private func setup() -> (OrbisStore, TestTransport) {
        let transport = TestTransport()
        let store = OrbisStore(secure: MemorySecureStore(), transport: transport, preferences: nil)
        return (store, transport)
    }

    @Test func switchingRuntimesKeepsTheirOwnMessagesAndLoadsSelectedPreview() throws {
        let (store, transport) = setup()
        transport.ready([runtime("a"), runtime("b")])
        #expect(transport.syncCommands.count == 1)
        let first = try #require(transport.syncCommands.last)
        transport.event(snapshot(first, text: "History A"))
        #expect(store.messages.map(\.text) == ["History A"])
        store.selectRuntime("b")
        #expect(store.messages.isEmpty)
        transport.event(snapshot(try #require(transport.syncCommands.last), text: "History B"), runtimeId: "b")
        // A message arriving for the background runtime is cached, not discarded.
        transport.event(["type": "message.finished", "message": message("new-a", text: "Live A")], sequence: 2)
        #expect(store.messages.map(\.text) == ["History B"])
        store.selectRuntime("a")
        #expect(store.messages.map(\.text) == ["History A", "Live A"])
        #expect(store.isSyncing)
        #expect(transport.syncCommands.count == 3)
    }

    @Test func snapshotsAreAcknowledgedAndOldSessionsCannotReplaceNewOnes() throws {
        let (store, transport) = setup()
        transport.ready([runtime("a")])
        let stale = try #require(transport.syncCommands.last)
        transport.event(["type": "runtime.metadata", "metadata": ["sessionId": "new-session"]], sequence: 1, channel: "ctl")
        #expect(store.selectedRuntime?.name == "Agent a")
        #expect(store.selectedRuntime?.sessionId == "new-session")
        transport.event(snapshot(stale, text: "stale"), sequence: 1)
        #expect(store.messages.isEmpty)
        #expect((transport.sent.last?["command"] as? [String: Any])?["result"] as? String == "rejected")
        let current = try #require(transport.syncCommands.last)
        transport.event(snapshot(current, text: "current"), sequence: 2)
        #expect(store.messages.map(\.text) == ["current"])
        #expect((transport.sent.last?["command"] as? [String: Any])?["result"] as? String == "applied")
        #expect(!store.isSyncing)
    }

    @Test func sequencesAreIndependentPerChannelAndResetAfterReconnect() {
        let (store, transport) = setup()
        transport.ready([runtime("a")])
        transport.event(["type": "message.started", "message": message("m", text: "Hello")], sequence: 1)
        transport.event(["type": "runtime.status", "status": "running"], sequence: 10, channel: "ctl")
        transport.event(["type": "message.delta", "messageId": "m", "delta": " world"], sequence: 2)
        transport.event(["type": "message.delta", "messageId": "m", "delta": " duplicate"], sequence: 2)
        #expect(store.messages.first?.text == "Hello world")
        transport.state?(.connecting, nil)
        transport.ready([runtime("a")])
        transport.event(["type": "message.finished", "message": message("m", text: "After restart")], sequence: 1)
        #expect(store.messages.first?.text == "After restart")
    }

    @Test func deltasCanArriveBeforeStartedAndRespectContentIndices() {
        let (store, transport) = setup()
        transport.ready([runtime("a")])
        transport.event(["type": "message.delta", "messageId": "m", "contentType": "thinking", "contentIndex": 1, "delta": "Reasoning"], sequence: 1)
        transport.event(["type": "message.delta", "messageId": "m", "contentType": "text", "contentIndex": 2, "delta": "Answer"], sequence: 2)
        transport.event(["type": "message.delta", "messageId": "m", "contentType": "text", "contentIndex": 2, "delta": " continues"], sequence: 3)
        #expect(store.messages.count == 1)
        #expect(store.messages.first?.content[2].text == "Answer continues")
    }

    @Test func failedSendsDoNotCreateOptimisticMessagesAndSlashCommandsAreExplicit() {
        let (store, transport) = setup()
        transport.ready([runtime("a")])
        transport.acceptsSends = false
        #expect(!store.sendMessage("keep this draft"))
        #expect(store.messages.isEmpty)
        transport.acceptsSends = true
        #expect(!store.sendMessage("/unsupported"))
        #expect(store.errorMessage != nil)
        #expect(store.sendMessage("valid message"))
        #expect(store.messages.first?.text == "valid message")
    }

    @Test func commandFailuresDoNotMarkTheSecureConnectionBroken() {
        let (store, transport) = setup()
        transport.ready([runtime("a")])
        transport.emit(["type": "protocol.error", "commandId": "command-1", "code": "busy", "message": "Agent busy"])
        #expect(store.connection == .secured)
        #expect(store.errorMessage == "Agent busy")
    }

    @Test func activatingAnOnlineSessionDoesNotLaunchADuplicateRuntime() throws {
        let (store, transport) = setup()
        transport.ready([runtime("a"), runtime("b")])
        let session = SessionSummary(sessionId: "session-b", name: "B", cwd: "/repo", firstMessage: nil,
            createdAt: 0, modifiedAt: 0, messageCount: 0, agentKind: "pi", archived: false)
        store.activate(session)
        #expect(store.selectedRuntimeId == "b")
        #expect(!transport.sent.contains { $0["type"] as? String == "session.activate" })
    }

    @Test func oldConnectionCallbacksAndPlaintextHostStateAreIgnored() {
        let (store, transport) = setup()
        let oldReceiver = transport.receive
        store.connect(hostId: "host-1")
        oldReceiver?(["type": "device.ready", "runtimes": [runtime("old")]], "ctl")
        #expect(store.runtimes.isEmpty)
        transport.emit(["type": "device.ready", "runtimes": [runtime("untrusted")]], channel: nil)
        #expect(store.runtimes.isEmpty)
        transport.ready([runtime("a")])
        #expect(store.selectedRuntimeId == "a")
    }

    @Test func authoritativeLiveInventoryReplacesTemporaryMessagesWhenPersisted() throws {
        let (store, transport) = setup()
        transport.ready([runtime("a")])
        let sync = try #require(transport.syncCommands.last)
        var initial = snapshot(sync, text: "History")
        initial["source"] = ["epoch": "epoch-1", "seq": 1, "ready": true]
        initial["live"] = ["complete": true, "messages": [["message": message("temporary", text: "Streaming")]]]
        transport.event(initial)
        #expect(store.messages.map(\.text) == ["History", "Streaming"])
        transport.event(["type": "session.patch", "sessionId": "session-a", "baseSeq": 1,
            "source": ["epoch": "epoch-1", "seq": 2, "ready": true],
            "display": ["entries": [["entryId": "entry-2", "message": message("persisted", text: "Finished")]]],
            "live": ["complete": true, "messages": [["persistedEntryId": "entry-2", "message": message("temporary", text: "Finished")]]]], sequence: 2)
        #expect(store.messages.map(\.text) == ["History", "Finished"])
        #expect(store.messages.map(\.messageId) == ["History", "persisted"])
        // A missing source transition must recover via a preview, never append guessed state.
        transport.event(["type": "session.patch", "sessionId": "session-a", "baseSeq": 5,
            "source": ["epoch": "epoch-1", "seq": 6, "ready": true]], sequence: 3)
        #expect(transport.syncCommands.count == 2)
        #expect(store.isSyncing)
    }
    @Test func draftsAndAliasesSurviveRuntimeNavigationAndFollowSessionIdentity() throws {
        let (store, transport) = setup()
        transport.ready([runtime("a"), runtime("b")])
        let a = try #require(store.selectedRuntime)
        store.saveDraft("保留草稿", for: a)
        store.setAlias(" 手机  别名 ", for: a)
        store.selectRuntime("b")
        #expect(store.draft(for: try #require(store.selectedRuntime)).isEmpty)
        store.selectRuntime("a")
        #expect(store.draft(for: a) == "保留草稿")
        #expect(store.displayName(a) == "手机 别名")
        transport.event(["type": "runtime.metadata", "metadata": ["sessionId": "new-session"]], sequence: 1, channel: "ctl")
        let next = try #require(store.selectedRuntime)
        #expect(store.draft(for: next).isEmpty)
        #expect(store.alias(for: next).isEmpty)
        #expect(store.draft(for: a) == "保留草稿")
    }

    @Test func directoryResponsesAreBoundToTheCurrentRequestAndErrorsStayInline() throws {
        let (store, transport) = setup(); transport.ready([runtime("a")])
        store.browseDirectory("/first")
        let old = try #require(transport.sent.last?["requestId"] as? String)
        store.browseDirectory("/second")
        let current = try #require(transport.sent.last?["requestId"] as? String)
        transport.emit(["type": "session.browse.result", "requestId": old, "path": "/first", "entries": []])
        #expect(store.browse?.path == "/second")
        #expect(store.browse?.loading == true)
        transport.emit(["type": "protocol.error", "requestId": current, "code": "access_denied", "message": "目录不可读"])
        #expect(store.browse?.error == "目录不可读")
        #expect(store.browse?.loading == false)
        #expect(store.errorMessage == nil)
        store.dismissBrowse()
        transport.emit(["type": "session.browse.result", "requestId": current, "path": "/second", "entries": []])
        #expect(store.browse == nil)
    }

    @Test func slashExecutionUsesPublishedCommandsAndTracksFailures() throws {
        let (store, transport) = setup(); transport.ready([runtime("a")])
        #expect(!store.executeSlash("model", args: "missing"))
        transport.event(["type": "runtime.capabilities", "capabilities": ["commands": [
            ["name": "model", "source": "builtin", "argument": ["kind": "select", "required": true, "options": [["value": "m", "label": "Model"]]]]
        ]]], sequence: 1, channel: "ctl")
        #expect(!store.executeSlash("model"))
        #expect(store.executeSlash("model", args: "m"))
        let sent = try #require(transport.sent.last)
        #expect((sent["command"] as? [String: Any])?["type"] as? String == "slash.execute")
        #expect(store.pendingActionIds.count == 1)
        transport.event(["type": "command.result", "commandId": sent["commandId"]!, "ok": false, "error": "模型不可用"], sequence: 2, channel: "ctl")
        #expect(store.pendingActionIds.isEmpty)
        #expect(store.errorMessage == "模型不可用")
    }

    @Test func activationStaysPendingUntilItsRuntimeIsOnline() throws {
        let (store, transport) = setup(); transport.ready([runtime("a")])
        store.createSession(agentKind: "codex", cwd: "/new-project")
        let request = try #require(transport.sent.last?["requestId"] as? String)
        #expect(store.activatingSessionId == "new")
        transport.emit(["type": "session.activated", "requestId": request, "sessionId": "new-session", "agentKind": "codex", "spawnMode": "tui"])
        #expect(store.activatingSessionId == "new-session")
        #expect(store.selectedRuntimeId == "a")
        transport.emit(["type": "runtime.online", "runtime": runtime("new-runtime", session: "new-session")])
        #expect(store.selectedRuntimeId == "new-runtime")
        #expect(store.activatingSessionId == nil)
        #expect(store.activationRevision == 1)
    }

    @Test func gitBranchResponsesCannotOverwriteAnotherSession() throws {
        let (store, transport) = setup(); transport.ready([runtime("a")])
        store.refreshWorkingBranch()
        let request = try #require(transport.sent.last?["requestId"] as? String)
        transport.emit(["type": "runtime.git", "runtimeId": "a", "requestId": request, "sessionId": "wrong", "cwd": "/repo", "branch": "wrong"])
        #expect(store.workingBranches["a"]?.branch == nil)
        transport.emit(["type": "runtime.git", "runtimeId": "a", "requestId": request, "sessionId": "session-a", "cwd": "/repo", "branch": "main"])
        #expect(store.workingBranches["a"]?.branch == "main")
    }

    @Test func interactionsWaitForResolutionRejectDuplicateAndExpiredResponses() throws {
        let (store, transport) = setup(); transport.ready([runtime("a")])
        let request: [String: Any] = ["runtimeId": "a", "requestId": "approval", "extensionId": "test", "kind": "confirm", "title": "允许操作？", "expiresAt": Int64(Date().timeIntervalSince1970 * 1000) + 60000]
        transport.event(["type": "interaction.requested", "request": request], sequence: 1, channel: "ctl")
        let pending = try #require(store.interactions["a"]?.first)
        #expect(store.respond(pending, response: ["kind": "confirm", "value": true]))
        #expect(!store.respond(pending, response: ["kind": "confirm", "value": true]))
        #expect(store.submittingInteractions.contains("approval"))
        let command = try #require(transport.sent.last?["commandId"] as? String)
        transport.event(["type": "command.result", "commandId": command, "ok": true], sequence: 2, channel: "ctl")
        #expect(store.interactions["a"]?.count == 1)
        transport.event(["type": "interaction.resolved", "requestId": "approval", "source": "remote"], sequence: 3, channel: "ctl")
        #expect(store.interactions["a"]?.isEmpty == true)
        #expect(store.submittingInteractions.isEmpty)
        var expired = request; expired["expiresAt"] = 1
        transport.event(["type": "interaction.requested", "request": expired], sequence: 4, channel: "ctl")
        #expect(!store.respond(try #require(store.interactions["a"]?.first), response: ["kind": "confirm", "value": true]))
    }

    @Test func sessionDirectoryIsCachedPerHostUntilUnpaired() throws {
        let key = "orbis-directory-test-" + UUID().uuidString
        let preferences = try #require(UserDefaults(suiteName: key))
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(key)
        defer { preferences.removePersistentDomain(forName: key); try? FileManager.default.removeItem(at: root) }
        let transport = TestTransport()
        let store = OrbisStore(secure: MemorySecureStore(), transport: transport, autoConnect: false, preferences: preferences, transferRoot: root)
        store.connect(hostId: "host-1"); transport.ready([])
        let id = try #require(transport.sent.last { $0["type"] as? String == "session.list" }?["requestId"] as? String)
        transport.emit(["type": "session.list.result", "requestId": id, "sessions": [
            ["sessionId": "cached", "cwd": "/repo", "createdAt": 0, "modifiedAt": 0, "messageCount": 1, "agentKind": "pi"]
        ]])
        let secure = MemorySecureStore()
        let restored = OrbisStore(secure: secure, transport: TestTransport(), autoConnect: false, preferences: preferences, transferRoot: root)
        #expect(restored.sessions.isEmpty)
        restored.connect(hostId: "host-1")
        #expect(restored.sessions.map(\.sessionId) == ["cached"])
        restored.unpair(hostId: "host-1")
        let afterUnpair = OrbisStore(secure: MemorySecureStore(), transport: TestTransport(), autoConnect: false, preferences: preferences, transferRoot: root)
        afterUnpair.connect(hostId: "host-1")
        #expect(afterUnpair.sessions.isEmpty)
    }

    @Test func unpairingClearsOnlyTheSelectedPairingsLocalState() throws {
        let secure = MemorySecureStore()
        secure.hosts.append(HostPairing(hostId: "host-2", hostName: "Second", hostPub: "public-test-key", pskRoot: Base64URL.encode(Data(repeating: 1, count: 32)), relay: RelayCredential(relayUrl: "wss://relay.example", deviceId: "device-2", credential: "test-only"), lan: []))
        let transport = TestTransport(), store = OrbisStore(secure: secure, transport: transport, preferences: nil)
        transport.ready([runtime("a")]); let first = try #require(store.selectedRuntime)
        store.saveDraft("first", for: first); store.setAlias("first alias", for: first)
        store.connect(hostId: "host-2"); transport.ready([runtime("a")]); let second = try #require(store.selectedRuntime)
        #expect(store.draft(for: second).isEmpty)
        store.saveDraft("second", for: second); store.setAlias("second alias", for: second)
        store.unpair(hostId: "host-1")
        #expect(store.draft(for: second) == "second")
        #expect(store.alias(for: second) == "second alias")
        #expect(secure.hosts.map(\.hostId) == ["host-2"])
        store.unpair(hostId: "host-2")
        #expect(store.pairings.isEmpty); #expect(store.drafts.isEmpty); #expect(store.aliases.isEmpty)
        #expect(store.selectedHostId == nil); #expect(store.connection == .offline)
    }

    @Test func olderHistoryPrependsWithoutReplacingLiveMessagesOrAdvancingSource() throws {
        let (store, transport) = setup(); transport.ready([runtime("a")])
        let initial = try #require(transport.syncCommands.last)
        var checkpoint = snapshot(initial, text: "recent")
        checkpoint["entries"] = [["entryId": "e2", "parentId": "e1"]]
        checkpoint["cursor"] = ["leafId": "e3"]
        checkpoint["source"] = ["epoch": "source", "seq": 2, "ready": true]
        checkpoint["hasOlder"] = true
        transport.event(checkpoint)
        transport.event(["type": "message.finished", "message": message("live", text: "live")], sequence: 2)
        #expect(store.loadOlderHistory())
        #expect(!store.loadOlderHistory())
        let history = try #require(transport.syncCommands.last)
        #expect(history["range"] as? String == "history")
        #expect(history["beforeEntryId"] as? String == "e2")
        #expect(history["targetLeafId"] as? String == "e3")
        transport.event(["type": "session.snapshot", "syncId": history["syncId"]!, "sessionId": "session-a", "range": "history", "mode": "prepend", "beforeEntryId": "e2", "targetLeafId": "e3", "entries": [["entryId": "e1"]], "hasOlder": false,
            "source": ["epoch": "source", "seq": 1, "ready": true], "display": ["entries": [["entryId": "e1", "message": message("older", text: "older")]]]], sequence: 3)
        #expect(store.messages.map(\.text) == ["older", "recent", "live"])
        #expect(store.hasOlderHistory["a"] == false)
        #expect(store.historyLoading.isEmpty)
        transport.event(["type": "session.patch", "sessionId": "session-a", "baseSeq": 2, "source": ["epoch": "source", "seq": 3, "ready": true],
            "display": ["entries": [["message": message("new", text: "new")]]]], sequence: 4)
        #expect(store.messages.last?.text == "new")
        #expect(transport.syncCommands.count == 2)
    }

    @Test func invalidToolScopeRejectsSnapshotBeforeReplacingMessages() throws {
        let (store, transport) = setup(); transport.ready([runtime("a")])
        var checkpoint = snapshot(try #require(transport.syncCommands.last), text: "untrusted")
        checkpoint["live"] = ["complete": true, "messages": [], "toolInventory": ["projectionVersion": 1,
            "agent": ["hostId": "another-computer", "agentKind": "codex", "sessionId": "session-a"], "version": ["epoch": "e", "revision": 1], "source": ["epoch": "s", "seq": 1], "totalCount": 0, "summaryBytes": 0]]
        transport.event(checkpoint)
        #expect(store.messages.isEmpty)
        #expect((transport.sent.last?["command"] as? [String: Any])?["result"] as? String == "rejected")
    }

    @Test func stalePreviewCannotRollBackANewerLiveSource() throws {
        let (store, transport) = setup(); transport.ready([runtime("a")])
        var first = snapshot(try #require(transport.syncCommands.last), text: "first")
        first["source"] = ["epoch": "source", "seq": 1, "ready": true]
        transport.event(first)
        store.refresh()
        let refresh = try #require(transport.syncCommands.last)
        transport.event(["type": "session.patch", "sessionId": "session-a", "baseSeq": 1,
            "source": ["epoch": "source", "seq": 2, "ready": true], "display": ["entries": [["message": message("new", text: "new")]]]], sequence: 2)
        var stale = snapshot(refresh, text: "stale")
        stale["source"] = ["epoch": "source", "seq": 1, "ready": true]
        transport.event(stale, sequence: 3)
        #expect(store.messages.map(\.text) == ["first", "new"])
        #expect((transport.sent.last?["command"] as? [String: Any])?["result"] as? String == "rejected")
    }

}
