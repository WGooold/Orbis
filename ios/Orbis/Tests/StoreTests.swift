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
    var drain: (() async -> Void)?
    var acceptsSends = true
    var receive: (([String: Any], String?) -> Void)?
    var state: ((ConnectionState, String?) -> Void)?
    func pair(qr: PairingQR, deviceName: String, identity: DeviceIdentity, completion: @escaping (Result<HostPairing, Error>) -> Void) { completion(.failure(PairingError.invalidQR)) }
    func connect(pairing: HostPairing, identity: DeviceIdentity, receive: @escaping ([String: Any], String?) -> Void, state: @escaping (ConnectionState, String?) -> Void) {
        self.receive = receive; self.state = state; state(.connecting, nil)
    }
    func disconnect() {}
    func send(_ object: [String: Any]) -> Bool { if acceptsSends { sent.append(object) }; return acceptsSends }
    func emit(_ message: [String: Any], channel: String? = "ctl") async { receive?(message, channel); await drain?() }
    var syncCommands: [[String: Any]] { sent.compactMap { $0["command"] as? [String: Any] }.filter { $0["type"] as? String == "session.sync" } }
    func ready(_ runtimes: [[String: Any]]) async { await emit(["type": "device.ready", "protocolVersion": orbisProtocolVersion, "runtimes": runtimes]) }
    func event(_ payload: [String: Any], runtimeId: String = "a", sequence: Int = 1, channel: String = "msg") async {
        var value = payload
        if ["session.snapshot", "session.patch"].contains(value["type"] as? String ?? "") {
            var display = value["display"] as? [String: Any] ?? ["entries": []]
            var rows = display["entries"] as? [[String: Any]] ?? []
            for index in rows.indices where rows[index]["entryId"] == nil {
                rows[index]["entryId"] = (rows[index]["message"] as? [String: Any])?["messageId"]
            }
            display["entries"] = rows; display["projectionVersion"] = display["projectionVersion"] ?? 3; value["display"] = display
            var entries = value["entries"] as? [[String: Any]] ?? rows.compactMap { row -> [String: Any]? in
                guard let id = row["entryId"] as? String else { return nil }
                return ["entryId": id]
            }
            for index in entries.indices {
                entries[index]["type"] = entries[index]["type"] ?? "message"
                entries[index]["timestamp"] = entries[index]["timestamp"] ?? "2026-10-29T00:00:00Z"
            }
            value["entries"] = entries
            value["source"] = value["source"] ?? ["epoch": "fixture", "seq": 1, "ready": true]
            let source = value["source"] as? [String: Any] ?? [:]
            if value["type"] as? String == "session.snapshot" {
                let cursor = value["cursor"] as? [String: Any] ?? ["leafId": value["targetLeafId"] ?? entries.last?["entryId"] as Any? ?? NSNull()]
                value["cursor"] = cursor
                if !["history", "catchup"].contains(value["range"] as? String ?? "") { value["checkpoint"] = value["checkpoint"] ?? ["checkpointId": "fixture", "head": cursor, "headCompleteness": "complete", "inventoryComplete": true] }
                value["rangeStatus"] = value["rangeStatus"] ?? "complete"
            } else {
                value["seq"] = value["seq"] ?? source["seq"]
                value["headCompleteness"] = value["headCompleteness"] ?? "complete"
            }
            if value["selection"] as? String != "unchanged", !["history", "catchup"].contains(value["range"] as? String ?? "") { value["live"] = value["live"] ?? ["complete": true, "messages": []] }
        }
        await emit(["type": "runtime.event", "runtimeId": runtimeId, "sequence": sequence, "event": value], channel: channel)
    }
}

private final class SingleCommitGate: @unchecked Sendable {
    private let lock = NSLock()
    private var unused = true
    func claim() -> Bool { lock.lock(); defer { lock.unlock() }; guard unused else { return false }; unused = false; return true }
}

@Suite("Native app state") @MainActor
struct StoreTests {
    @Test func pathOrderPersistsOfflineAndResendsAfterAuthenticatedReady() async throws {
        let key = "orbis-settings-test-" + UUID().uuidString
        let preferences = try #require(UserDefaults(suiteName: key))
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(key)
        defer { preferences.removePersistentDomain(forName: key); try? FileManager.default.removeItem(at: root) }
        let transport = TestTransport()
        let store = OrbisStore(secure: MemorySecureStore(), transport: transport, autoConnect: false, preferences: preferences, transferRoot: root)
        transport.drain = { [weak store] in await store?.waitForPendingEvents() }
        store.setPathPreference(["relay", "relay", "p2p"])
        #expect(store.pathPreference == ["relay", "p2p", "lan"])
        #expect(transport.sent.isEmpty)
        store.connect(hostId: "host-1")
        await transport.ready([])
        #expect(transport.sent.contains { $0["type"] as? String == "device.pathPreference" && $0["preference"] as? [String] == store.pathPreference })
        let restored = OrbisStore(secure: MemorySecureStore(), transport: TestTransport(), autoConnect: false, preferences: preferences, transferRoot: root)
        #expect(restored.pathPreference == store.pathPreference)
    }

    @Test func directoryProviderFactsRequireCurrentAuthenticatedRequest() async throws {
        let (store, transport) = setup()
        await transport.ready([])
        let id = try #require(transport.sent.last { $0["type"] as? String == "session.list" }?["requestId"] as? String)
        await transport.emit(["type": "session.list.result", "requestId": "old", "sessions": [],
                        "currentProviders": [["agentKind": "codex", "provider": "wrong"]]])
        #expect(store.currentProviders.isEmpty)
        await transport.emit(["type": "session.list.result", "requestId": id, "sessions": [],
                        "currentProviders": [["agentKind": "codex", "provider": "native-a"]]], channel: nil)
        #expect(store.currentProviders.isEmpty)
        await transport.emit(["type": "session.list.result", "requestId": id, "sessions": [],
                        "currentProviders": [["agentKind": "codex", "provider": "native-a"]]])
        var session = SessionSummary(sessionId: "different", cwd: "/repo", createdAt: 0, modifiedAt: 0, messageCount: 1, agentKind: "codex")
        session.modelProvider = "native-b"
        #expect(store.providerMismatch(session)?.contains("native-b") == true)
        store.activate(session)
        #expect(!transport.sent.contains { $0["type"] as? String == "session.activate" })
        #expect(store.connection == .secured)
    }
    /// Host 的 runtime 元数据没有 agentKind：Codex / DeepSeek 进程不能被显示成 Pi。
    @Test func runtimeAgentKindIsResolvedWithoutHostField() async throws {
        let (store, transport) = setup()
        await transport.ready([runtime("codex:thread-1", session: "thread-1"), runtime("dsh:web-2", session: "dsh:web-2"), runtime("6f0d-pi", session: "pi-session")])
        let kinds = { store.runtimes.map { store.agentKind($0) } }
        #expect(kinds() == ["codex", "dsh", nil])
        let id = try #require(transport.sent.last { $0["type"] as? String == "session.list" }?["requestId"] as? String)
        await transport.emit(["type": "session.list.result", "requestId": id, "sessions": [
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
        transport.drain = { [weak store] in await store?.waitForPendingEvents() }
        return (store, transport)
    }

    @Test func switchingRuntimesKeepsTheirOwnMessagesAndLoadsSelectedPreview() async throws {
        let (store, transport) = setup()
        await transport.ready([runtime("a"), runtime("b")])
        #expect(transport.syncCommands.count == 1)
        let first = try #require(transport.syncCommands.last)
        await transport.event(snapshot(first, text: "History A"))
        #expect(store.messages.map(\.text) == ["History A"])
        store.selectRuntime("b")
        #expect(store.messages.isEmpty)
        await transport.event(snapshot(try #require(transport.syncCommands.last), text: "History B"), runtimeId: "b")
        // A message arriving for the background runtime is cached, not discarded.
        await transport.event(["type": "session.patch", "sessionId": "session-a", "baseSeq": 1, "source": ["epoch": "fixture", "seq": 2, "ready": true], "live": ["complete": true, "messages": [["message": message("new-a", text: "Live A")]]]], sequence: 2)
        #expect(store.messages.map(\.text) == ["History B"])
        store.selectRuntime("a")
        #expect(store.messages.map(\.text) == ["History A", "Live A"])
        #expect(store.isSyncing)
        #expect(transport.syncCommands.count == 3)
    }

    @Test func snapshotsAreAcknowledgedAndOldSessionsCannotReplaceNewOnes() async throws {
        let (store, transport) = setup()
        await transport.ready([runtime("a")])
        let stale = try #require(transport.syncCommands.last)
        await transport.event(["type": "runtime.metadata", "metadata": ["sessionId": "new-session"]], sequence: 1, channel: "ctl")
        #expect(store.selectedRuntime?.name == "Agent a")
        #expect(store.selectedRuntime?.sessionId == "new-session")
        await transport.event(snapshot(stale, text: "stale"), sequence: 1)
        #expect(store.messages.isEmpty)
        #expect((transport.sent.last?["command"] as? [String: Any])?["result"] as? String == "rejected")
        let current = try #require(transport.syncCommands.last)
        await transport.event(snapshot(current, text: "current"), sequence: 2)
        #expect(store.messages.map(\.text) == ["current"])
        #expect((transport.sent.last?["command"] as? [String: Any])?["result"] as? String == "applied")
        #expect(!store.isSyncing)
    }

    @Test func sequencesAreIndependentPerChannelAndResetAfterReconnect() async {
        let (store, transport) = setup()
        await transport.ready([runtime("a")])
        await transport.event(["type": "message.started", "message": message("m", text: "Hello")], sequence: 1)
        #expect(store.streamingMessageIds == ["m"])
        await transport.event(["type": "runtime.status", "status": "running"], sequence: 10, channel: "ctl")
        await transport.event(["type": "message.delta", "messageId": "m", "delta": " world"], sequence: 2)
        await transport.event(["type": "message.delta", "messageId": "m", "delta": " duplicate"], sequence: 2)
        #expect(store.messages.first?.text == "Hello world")
        transport.state?(.connecting, nil)
        await transport.ready([runtime("a")])
        await transport.event(["type": "message.finished", "message": message("m", text: "After restart")], sequence: 1)
        #expect(store.messages.first?.text == "After restart")
        #expect(store.streamingMessageIds.isEmpty)
    }

    @Test func deltasCanArriveBeforeStartedAndRespectContentIndices() async {
        let (store, transport) = setup()
        await transport.ready([runtime("a")])
        await transport.event(["type": "message.delta", "messageId": "m", "contentType": "thinking", "contentIndex": 1, "delta": "Reasoning"], sequence: 1)
        await transport.event(["type": "message.delta", "messageId": "m", "contentType": "text", "contentIndex": 2, "delta": "Answer"], sequence: 2)
        await transport.event(["type": "message.delta", "messageId": "m", "contentType": "text", "contentIndex": 2, "delta": " continues"], sequence: 3)
        #expect(store.messages.count == 1)
        #expect(store.messages.first?.content[2].text == "Answer continues")
    }

    @Test func sentMessagesShowImmediatelyAndReconcileByHostDeclaredIdentity() async throws {
        let (store, transport) = setup()
        await transport.ready([runtime("a")])
        transport.acceptsSends = false
        #expect(!store.sendMessage("keep this draft"))
        #expect(store.messages.isEmpty)
        #expect(store.pendingSends.isEmpty)
        transport.acceptsSends = true
        #expect(!store.sendMessage("/unsupported"))
        #expect(store.errorMessage != nil)
        #expect(store.sendMessage("valid message"))

        let sent = try #require(transport.sent.last { ($0["command"] as? [String: Any])?["type"] as? String == "user_message" })
        let command = try #require(sent["command"] as? [String: Any])
        let clientId = try #require(command["messageId"] as? String)
        // ADR-0049: the local row is visible before any Host event.
        #expect(store.messages.map(\.messageId) == [clientId])
        #expect(store.pendingSends.item(clientId)?.state == .sending)
        await transport.event(["type": "command.result", "commandId": sent["commandId"]!, "ok": true, "status": "success"], sequence: 1)
        #expect(store.pendingSends.item(clientId)?.state == .accepted)
        #expect(store.errorMessage != nil, "the earlier slash error is not replaced by a message receipt")

        // Pi assigns a different streaming ID and declares the phone send with clientMessageId.
        await transport.event(["type": "message.started", "message": [
            "messageId": "host-message-id", "role": "user", "timestamp": 100, "clientMessageId": clientId,
            "content": [["type": "text", "text": "valid message"]],
        ]], sequence: 2)
        #expect(store.messages.map(\.messageId) == ["host-message-id"])
        #expect(store.pendingSends.isEmpty)
        await transport.event(["type": "message.finished", "message": [
            "messageId": "host-message-id", "role": "user", "timestamp": 100,
            "content": [["type": "text", "text": "valid message"]],
        ]], sequence: 3)
        #expect(store.messages.map(\.text) == ["valid message"])

        // Codex returns the App id as the live id.
        #expect(store.sendMessage("codex message"))
        let codexSend = try #require(transport.sent.last { ($0["command"] as? [String: Any])?["type"] as? String == "user_message" })
        let codexCommand = try #require(codexSend["command"] as? [String: Any])
        let codexMessageId = try #require(codexCommand["messageId"] as? String)
        #expect(store.messages.map(\.messageId) == ["host-message-id", codexMessageId])
        await transport.event(["type": "message.started", "message": [
            "messageId": codexMessageId, "role": "user", "timestamp": 101,
            "content": [["type": "text", "text": "codex message"]],
        ]], sequence: 4)
        #expect(store.messages.map(\.text) == ["valid message", "codex message"])
        #expect(store.pendingSends.isEmpty)

        // Identical text without a declared identity is a different message, never the local row.
        #expect(store.sendMessage("valid message"))
        let third = try #require((transport.sent.last { ($0["command"] as? [String: Any])?["type"] as? String == "user_message" })?["command"] as? [String: Any])
        let thirdId = try #require(third["messageId"] as? String)
        await transport.event(["type": "message.finished", "message": [
            "messageId": "another-real-message", "role": "user", "timestamp": 102,
            "content": [["type": "text", "text": "valid message"]],
        ]], sequence: 5)
        #expect(store.messages.map(\.messageId) == ["host-message-id", codexMessageId, thirdId, "another-real-message"])
    }

    @Test func rejectedSendStaysVisibleAndCanBeRestoredOrResent() async throws {
        let (store, transport) = setup()
        await transport.ready([runtime("a")])
        #expect(store.sendMessage("busy now"))
        let sent = try #require(transport.sent.last { ($0["command"] as? [String: Any])?["type"] as? String == "user_message" })
        let id = try #require((sent["command"] as? [String: Any])?["messageId"] as? String)
        await transport.event(["type": "command.result", "commandId": sent["commandId"]!, "ok": false, "status": "failure", "error": "runtime_busy"])
        #expect(store.pendingSends.item(id)?.state == .failed("会话正在运行，请选择插入或完成后发送"))
        #expect(store.errorMessage == nil, "the failure is shown on the row, not as a global banner")
        #expect(store.messages.map(\.messageId) == [id])

        #expect(store.resendPendingSend(id))
        let resent = try #require((transport.sent.last { ($0["command"] as? [String: Any])?["type"] as? String == "user_message" })?["command"] as? [String: Any])
        let newId = try #require(resent["messageId"] as? String)
        #expect(newId != id)
        #expect(store.pendingSends.items.map(\.messageId) == [newId])

        transport.state?(.connecting, nil)
        #expect(store.pendingSends.item(newId)?.state == .unconfirmed)
        #expect(store.restorePendingSend(newId) == "busy now")
        #expect(store.pendingSends.isEmpty)
    }

    @Test func commandFailuresDoNotMarkTheSecureConnectionBroken() async {
        let (store, transport) = setup()
        await transport.ready([runtime("a")])
        await transport.emit(["type": "protocol.error", "commandId": "command-1", "code": "busy", "message": "Agent busy"])
        #expect(store.connection == .secured)
        #expect(store.errorMessage == "Agent busy")
    }

    @Test func activatingAnOnlineSessionDoesNotLaunchADuplicateRuntime() async throws {
        let (store, transport) = setup()
        await transport.ready([runtime("a"), runtime("b")])
        let session = SessionSummary(sessionId: "session-b", name: "B", cwd: "/repo", firstMessage: nil,
            createdAt: 0, modifiedAt: 0, messageCount: 0, agentKind: "pi", archived: false)
        store.activate(session)
        #expect(store.selectedRuntimeId == "b")
        #expect(!transport.sent.contains { $0["type"] as? String == "session.activate" })
    }

    @Test func oldConnectionCallbacksAndPlaintextHostStateAreIgnored() async {
        let (store, transport) = setup()
        let oldReceiver = transport.receive
        store.reconnectSelectedHost()
        oldReceiver?(["type": "device.ready", "runtimes": [runtime("old")]], "ctl")
        #expect(store.runtimes.isEmpty)
        await transport.emit(["type": "device.ready", "runtimes": [runtime("untrusted")]], channel: nil)
        #expect(store.runtimes.isEmpty)
        await transport.ready([runtime("a")])
        #expect(store.selectedRuntimeId == "a")
    }

    @Test func onlyUnfinishedLiveAssistantMessagesEnableStreaming() async throws {
        let (store, transport) = setup()
        await transport.ready([runtime("a")])
        let sync = try #require(transport.syncCommands.last)
        var initial = snapshot(sync, text: "History")
        var user = message("user", text: "Question")
        user["role"] = "user"
        initial["live"] = ["complete": true, "messages": [
            ["message": message("live", text: "Reply"), "finished": false],
            ["message": message("done", text: "Finished reply"), "finished": true],
            ["message": user, "finished": false]
        ]]
        await transport.event(initial)
        #expect(store.streamingMessageIds == ["live"])
        // Completion can change only metadata, with no new text to trigger a view update.
        await transport.event(["type": "session.patch", "sessionId": "session-a", "baseSeq": 1,
            "source": ["epoch": "fixture", "seq": 2, "ready": true],
            "live": ["complete": true, "messages": [
                ["message": message("live", text: "Reply"), "finished": true]
            ]]], sequence: 2)
        #expect(store.messages.map(\.text) == ["History", "Reply"])
        #expect(store.streamingMessageIds.isEmpty)
    }

    @Test func authoritativeLiveInventoryReplacesTemporaryMessagesWhenPersisted() async throws {
        let (store, transport) = setup()
        await transport.ready([runtime("a")])
        let sync = try #require(transport.syncCommands.last)
        var initial = snapshot(sync, text: "History")
        initial["source"] = ["epoch": "epoch-1", "seq": 1, "ready": true]
        initial["live"] = ["complete": true, "messages": [["message": message("temporary", text: "Streaming"), "finished": false]]]
        await transport.event(initial)
        #expect(store.messages.map(\.text) == ["History", "Streaming"])
        #expect(store.streamingMessageIds == ["temporary"])
        await transport.event(["type": "session.patch", "sessionId": "session-a", "baseSeq": 1,
            "source": ["epoch": "epoch-1", "seq": 2, "ready": true],
            "display": ["entries": [["entryId": "entry-2", "message": message("persisted", text: "Finished")]]],
            "live": ["complete": true, "messages": [["persistedEntryId": "entry-2", "message": message("temporary", text: "Finished")]]]], sequence: 2)
        #expect(store.messages.map(\.text) == ["History", "Finished"])
        #expect(store.messages.map(\.messageId) == ["History", "persisted"])
        #expect(store.streamingMessageIds.isEmpty)
        // A missing source transition must recover via a preview, never append guessed state.
        await transport.event(["type": "session.patch", "sessionId": "session-a", "baseSeq": 5,
            "source": ["epoch": "epoch-1", "seq": 6, "ready": true]], sequence: 3)
        #expect(transport.syncCommands.count == 2)
        #expect(store.isSyncing)
    }
    /// Codex 用 App 的 clientId 广播用户消息，落盘 entry 用原生 item id；两者只能靠运行时给的映射合并。
    @Test func lifecycleRowsWithTemporaryIdsRetireOnceTheirEntryIsProjected() async throws {
        let (store, transport) = setup()
        await transport.ready([runtime("a")])
        let sync = try #require(transport.syncCommands.last)
        var initial = snapshot(sync, text: "History")
        initial["source"] = ["epoch": "epoch-1", "seq": 1, "ready": true]
        initial["live"] = ["complete": true, "messages": []]
        await transport.event(initial)
        func user(_ id: String) -> [String: Any] {
            ["messageId": id, "role": "user", "timestamp": 101, "content": [["type": "text", "text": "hello"]]]
        }
        await transport.event(["type": "message.started", "message": user("client-1")], sequence: 2)
        await transport.event(["type": "session.patch", "sessionId": "session-a", "baseSeq": 1,
            "source": ["epoch": "epoch-1", "seq": 2, "ready": true],
            "live": ["complete": true, "messages": [["message": user("native-1")]]]], sequence: 3)
        await transport.event(["type": "message.finished", "message": user("client-1")], sequence: 4)
        await transport.event(["type": "session.patch", "sessionId": "session-a", "baseSeq": 2,
            "source": ["epoch": "epoch-1", "seq": 3, "ready": true],
            "display": ["entries": [["entryId": "native-1", "message": user("native-1")]]],
            "live": ["complete": true, "messages": []]], sequence: 5)
        await transport.event(["type": "turn.finished", "turnId": "turn-1", "startedAt": 100, "durationMs": 1,
            "persistedMessages": [["messageId": "client-1", "entryId": "native-1"]]], sequence: 6)
        #expect(store.messages.map(\.messageId) == ["History", "native-1"])
        // A late lifecycle replay of the retired id must not bring the row back.
        await transport.event(["type": "message.finished", "message": user("client-1")], sequence: 7)
        #expect(store.messages.map(\.messageId) == ["History", "native-1"])

        // Without any mapping, a complete live inventory still retires a lifecycle-only row.
        await transport.event(["type": "message.finished", "message": user("orphan")], sequence: 8)
        #expect(store.messages.map(\.messageId) == ["History", "native-1"])
        await transport.event(["type": "session.patch", "sessionId": "session-a", "baseSeq": 3,
            "source": ["epoch": "epoch-1", "seq": 4, "ready": true],
            "display": ["entries": [["entryId": "native-2", "message": user("native-2")]]],
            "live": ["complete": true, "messages": []]], sequence: 9)
        #expect(store.messages.map(\.messageId) == ["History", "native-1", "native-2"])
    }

    /// Pi/DSH 在提交 entry 的同一版 patch 里去掉流式行；运行中（complete=false）也不能并排显示两行。
    @Test func streamedRowsLeaveWithTheirLiveInventoryWhileTheTurnIsStillRunning() async throws {
        let (store, transport) = setup()
        await transport.ready([runtime("a")])
        let sync = try #require(transport.syncCommands.last)
        var initial = snapshot(sync, text: "History")
        initial["source"] = ["epoch": "epoch-1", "seq": 1, "ready": true]
        initial["live"] = ["complete": true, "messages": []]
        await transport.event(initial)
        func user(_ id: String) -> [String: Any] {
            ["messageId": id, "role": "user", "timestamp": 101, "content": [["type": "text", "text": "hello"]]]
        }
        await transport.event(["type": "session.patch", "sessionId": "session-a", "baseSeq": 1,
            "source": ["epoch": "epoch-1", "seq": 2, "ready": true],
            "live": ["complete": true, "messages": [["message": user("stream-1")]]]], sequence: 2)
        #expect(store.messages.map(\.messageId) == ["History", "stream-1"])
        await transport.event(["type": "session.patch", "sessionId": "session-a", "baseSeq": 2,
            "source": ["epoch": "epoch-1", "seq": 3, "ready": true],
            "display": ["entries": [["entryId": "entry-1", "message": user("entry-1")]]],
            "live": ["complete": true, "messages": [["message": message("reply", text: "Thinking more")]]]], sequence: 3)
        #expect(store.messages.map(\.messageId) == ["History", "entry-1", "reply"])
        #expect(store.messages.map(\.text) == ["History", "hello", "Thinking more"])
    }

    @Test func draftsSurviveRuntimeNavigationAndFollowSessionIdentity() async throws {
        let (store, transport) = setup()
        await transport.ready([runtime("a"), runtime("b")])
        let a = try #require(store.selectedRuntime)
        store.saveDraft("保留草稿", for: a)
        store.selectRuntime("b")
        #expect(store.draft(for: try #require(store.selectedRuntime)).isEmpty)
        store.selectRuntime("a")
        #expect(store.draft(for: a) == "保留草稿")
        #expect(store.displayName(a) == "session-a")
        await transport.event(["type": "runtime.metadata", "metadata": ["sessionId": "new-session"]], sequence: 1, channel: "ctl")
        let next = try #require(store.selectedRuntime)
        #expect(store.draft(for: next).isEmpty)
        #expect(store.draft(for: a) == "保留草稿")
    }

    @Test func directoryResponsesAreBoundToTheCurrentRequestAndErrorsStayInline() async throws {
        let (store, transport) = setup(); await transport.ready([runtime("a")])
        store.browseDirectory("/first")
        let old = try #require(transport.sent.last?["requestId"] as? String)
        store.browseDirectory("/second")
        let current = try #require(transport.sent.last?["requestId"] as? String)
        await transport.emit(["type": "session.browse.result", "requestId": old, "path": "/first", "entries": []])
        #expect(store.browse?.path == "/second")
        #expect(store.browse?.loading == true)
        await transport.emit(["type": "protocol.error", "requestId": current, "code": "access_denied", "message": "目录不可读"])
        #expect(store.browse?.error == "目录不可读")
        #expect(store.browse?.loading == false)
        #expect(store.errorMessage == nil)
        store.dismissBrowse()
        await transport.emit(["type": "session.browse.result", "requestId": current, "path": "/second", "entries": []])
        #expect(store.browse == nil)
    }

    @Test func slashExecutionUsesPublishedCommandsAndTracksFailures() async throws {
        let (store, transport) = setup(); await transport.ready([runtime("a")])
        #expect(!store.executeSlash("model", args: "missing"))
        await transport.event(["type": "runtime.capabilities", "capabilities": ["commands": [
            ["name": "model", "source": "builtin", "argument": ["kind": "select", "required": true, "options": [["value": "m", "label": "Model"]]]]
        ]]], sequence: 1, channel: "ctl")
        #expect(!store.executeSlash("model"))
        #expect(store.executeSlash("model", args: "m"))
        let sent = try #require(transport.sent.last)
        #expect((sent["command"] as? [String: Any])?["type"] as? String == "slash.execute")
        #expect(store.pendingActionIds.count == 1)
        await transport.event(["type": "command.result", "commandId": sent["commandId"]!, "ok": false, "error": "模型不可用"], sequence: 2, channel: "ctl")
        #expect(store.pendingActionIds.isEmpty)
        #expect(store.errorMessage == "模型不可用")
    }

    @Test func messageRewindUsesCanonicalTargetAndRestoresDraftOnlyAfterSuccess() async throws {
        let (store, transport) = setup(); await transport.ready([runtime("a")])
        transport.state?(.secured, nil)
        let selected = try #require(store.selectedRuntime)
        #expect(store.userMessageRewindOptions(for: selected).isEmpty)
        let sync = try #require(transport.syncCommands.last)
        var user = message("display-user", text: "original prompt")
        user["role"] = "user"
        await transport.event([
            "type": "session.snapshot", "sessionId": "session-a", "syncId": sync["syncId"]!, "mode": "replace",
            "display": ["entries": [["entryId": "canonical-user", "message": user]]]
        ])
        let option: [String: Any] = ["value": "canonical-user", "label": "original prompt", "tree": [
            "entryType": "message", "role": "user", "defaultHidden": false, "isCurrent": true, "isOnActivePath": true
        ]]
        await transport.event(["type": "runtime.capabilities", "capabilities": ["commands": [
            ["name": "tree", "source": "builtin", "argument": ["kind": "tree", "required": true, "options": [option]]]
        ]]], sequence: 2, channel: "ctl")
        let target = try #require(store.userMessageRewindOptions(for: selected)["display-user"])
        #expect(target.value == "canonical-user")
        #expect(store.userMessageRewindOptions(for: selected)["canonical-user"] == nil)
        store.saveDraft("existing draft", for: selected)
        #expect(store.moveHistory(to: target, fallbackText: "original prompt"))
        #expect(!store.moveHistory(to: target, fallbackText: "duplicate"))
        let failed = try #require(transport.sent.last)
        #expect((failed["command"] as? [String: Any])?["args"] as? String == "canonical-user")
        #expect(store.draft(for: selected) == "existing draft")
        await transport.event(["type": "command.result", "commandId": failed["commandId"]!, "ok": false, "error": "busy"], sequence: 3, channel: "ctl")
        #expect(store.draft(for: selected) == "existing draft")
        #expect(store.moveHistory(to: target, fallbackText: "original prompt"))
        let succeeded = try #require(transport.sent.last)
        let syncCount = transport.syncCommands.count
        await transport.event(["type": "command.result", "commandId": succeeded["commandId"]!, "ok": true], sequence: 4, channel: "ctl")
        #expect(store.draft(for: selected) == "original prompt")
        #expect(store.historyRevision == 1)
        #expect(transport.syncCommands.count > syncCount)
        await transport.event(["type": "runtime.capabilities", "capabilities": ["commands": []]], sequence: 5, channel: "ctl")
        #expect(store.userMessageRewindOptions(for: selected).isEmpty)
        #expect(!store.moveHistory(to: target))
    }

    @Test func activationStaysPendingUntilItsRuntimeIsOnline() async throws {
        let (store, transport) = setup(); await transport.ready([runtime("a")])
        store.createSession(agentKind: "codex", cwd: "/new-project")
        let request = try #require(transport.sent.last?["requestId"] as? String)
        #expect(store.activatingSessionId == "new")
        await transport.emit(["type": "session.activated", "requestId": request, "sessionId": "new-session", "agentKind": "codex", "spawnMode": "tui"])
        #expect(store.activatingSessionId == "new-session")
        #expect(store.selectedRuntimeId == "a")
        await transport.emit(["type": "runtime.online", "runtime": runtime("new-runtime", session: "new-session")])
        #expect(store.selectedRuntimeId == "new-runtime")
        #expect(store.activatingSessionId == nil)
        #expect(store.activationRevision == 1)
    }

    @Test func gitBranchResponsesCannotOverwriteAnotherSession() async throws {
        let (store, transport) = setup(); await transport.ready([runtime("a")])
        store.refreshWorkingBranch()
        let request = try #require(transport.sent.last?["requestId"] as? String)
        await transport.emit(["type": "runtime.git", "runtimeId": "a", "requestId": request, "sessionId": "wrong", "cwd": "/repo", "branch": "wrong"])
        #expect(store.workingBranches["a"]?.branch == nil)
        await transport.emit(["type": "runtime.git", "runtimeId": "a", "requestId": request, "sessionId": "session-a", "cwd": "/repo", "branch": "main"])
        #expect(store.workingBranches["a"]?.branch == "main")
    }

    @Test func interactionsWaitForResolutionRejectDuplicateAndExpiredResponses() async throws {
        let (store, transport) = setup(); await transport.ready([runtime("a")])
        let request: [String: Any] = ["runtimeId": "a", "requestId": "approval", "extensionId": "test", "kind": "confirm", "title": "允许操作？", "expiresAt": Int64(Date().timeIntervalSince1970 * 1000) + 60000]
        await transport.event(["type": "interaction.requested", "request": request], sequence: 1, channel: "ctl")
        let pending = try #require(store.interactions["a"]?.first)
        #expect(store.respond(pending, response: ["kind": "confirm", "value": true]))
        #expect(!store.respond(pending, response: ["kind": "confirm", "value": true]))
        #expect(store.submittingInteractions.contains("approval"))
        let command = try #require(transport.sent.last?["commandId"] as? String)
        await transport.event(["type": "command.result", "commandId": command, "ok": true], sequence: 2, channel: "ctl")
        #expect(store.interactions["a"]?.count == 1)
        await transport.event(["type": "interaction.resolved", "requestId": "approval", "source": "remote"], sequence: 3, channel: "ctl")
        #expect(store.interactions["a"]?.isEmpty == true)
        #expect(store.submittingInteractions.isEmpty)
        var expired = request; expired["expiresAt"] = 1
        await transport.event(["type": "interaction.requested", "request": expired], sequence: 4, channel: "ctl")
        #expect(!store.respond(try #require(store.interactions["a"]?.first), response: ["kind": "confirm", "value": true]))
    }

    @Test func homeWaitsForCardFactsAndPersistsIdentityBeforeCatalogArrives() async throws {
        let key = "orbis-home-test-" + UUID().uuidString
        let preferences = try #require(UserDefaults(suiteName: key))
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(key)
        defer { preferences.removePersistentDomain(forName: key); try? FileManager.default.removeItem(at: root) }
        let transport = TestTransport()
        let store = OrbisStore(secure: MemorySecureStore(), transport: transport, autoConnect: false, preferences: preferences, transferRoot: root)
        transport.drain = { [weak store] in await store?.waitForPendingEvents() }
        store.connect(hostId: "host-1")
        await transport.ready([runtime("a"), runtime("b")])
        let host = try #require(store.hosts.first?.connection)
        #expect(host.homeRuntimesLoading)
        #expect(host.homeRuntimes.isEmpty)
        func send(_ id: String, _ name: String, _ value: [String: Any]) async throws {
            let request = try #require(transport.sent.last { $0["type"] as? String == "agent.state.request" && $0["runtimeId"] as? String == id })
            await transport.emit(["type": "agent.state.snapshot", "scope": "agent", "requestId": request["requestId"]!,
                "runtimeId": id, "sessionId": "session-" + id, "agentKind": "claude", "modelEpoch": "epoch",
                "domains": [["domain": name, "modelEpoch": "epoch", "revision": 1, "availability": "ready",
                    "completeness": "complete", "checkedAt": 100, "value": value,
                    "source": ["producer": "host", "sourceId": "host-1", "sourceEpoch": "native", "sourceRevision": 1]]],
                "missing": [], "truncated": false])
        }
        for id in ["a", "b"] {
            try await send(id, "identity", ["runtimeId": id, "sessionId": "session-" + id, "name": "Agent",
                "cwd": "/repo", "agentKind": "claude"])
            try await send(id, "execution", ["phase": "running"])
            #expect(host.homeRuntimes.isEmpty)
            try await send(id, "interactions", [:])
            if id == "a" { #expect(host.homeRuntimes.isEmpty) }
        }
        #expect(!host.homeRuntimesLoading)
        #expect(host.homeRuntimes.count == 2)
        #expect(host.homeRuntimes.allSatisfy { $0.agentKind == "claude" && $0.status == "running" })
        let restored = OrbisStore(secure: MemorySecureStore(), transport: TestTransport(), autoConnect: false, preferences: preferences, transferRoot: root)
        restored.connect(hostId: "host-1")
        #expect(Set(restored.sessions.map(\.sessionId)) == ["session-a", "session-b"])
        #expect(restored.sessions.allSatisfy { $0.cwd == "/repo" && $0.agentKind == "claude" })
        await transport.emit(["type": "runtime.online", "runtime": runtime("a", session: "replacement")])
        #expect(host.homeRuntimesLoading)
        #expect(host.homeRuntimes.isEmpty)
    }

    @Test func sessionDirectoryIsCachedPerHostUntilUnpaired() async throws {
        let key = "orbis-directory-test-" + UUID().uuidString
        let preferences = try #require(UserDefaults(suiteName: key))
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(key)
        defer { preferences.removePersistentDomain(forName: key); try? FileManager.default.removeItem(at: root) }
        let transport = TestTransport()
        let store = OrbisStore(secure: MemorySecureStore(), transport: transport, autoConnect: false, preferences: preferences, transferRoot: root)
        transport.drain = { [weak store] in await store?.waitForPendingEvents() }
        store.connect(hostId: "host-1"); await transport.ready([])
        let id = try #require(transport.sent.last { $0["type"] as? String == "session.list" }?["requestId"] as? String)
        await transport.emit(["type": "session.list.result", "requestId": id, "sessions": [
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

    @Test func unpairingClearsOnlyTheSelectedPairingsLocalState() async throws {
        let secure = MemorySecureStore()
        secure.hosts.append(HostPairing(hostId: "host-2", hostName: "Second", hostPub: "public-test-key", pskRoot: Base64URL.encode(Data(repeating: 1, count: 32)), relay: RelayCredential(relayUrl: "wss://relay.example", deviceId: "device-2", credential: "test-only"), lan: []))
        let transport = TestTransport(), other = TestTransport()
        let store = OrbisStore(secure: secure, preferences: nil, transportFactory: { $0.hostId == "host-1" ? transport : other })
        transport.drain = { [weak store] in await store?.waitForPendingEvents() }; other.drain = transport.drain
        await transport.ready([runtime("a")]); let first = try #require(store.selectedRuntime)
        store.saveDraft("first", for: first)
        store.connect(hostId: "host-2"); await other.ready([runtime("a")]); let second = try #require(store.selectedRuntime)
        #expect(store.draft(for: second).isEmpty)
        store.saveDraft("second", for: second)
        store.unpair(hostId: "host-1")
        #expect(store.draft(for: second) == "second")
        #expect(secure.hosts.map(\.hostId) == ["host-2"])
        store.unpair(hostId: "host-2")
        #expect(store.pairings.isEmpty); #expect(store.drafts.isEmpty)
        #expect(store.selectedHostId == nil); #expect(store.connection == .offline)
    }

    @Test func olderHistoryPrependsWithoutReplacingLiveMessagesOrAdvancingSource() async throws {
        let (store, transport) = setup(); await transport.ready([runtime("a")])
        let initial = try #require(transport.syncCommands.last)
        var checkpoint = snapshot(initial, text: "recent")
        checkpoint["entries"] = [["entryId": "e2", "parentId": "e1"], ["entryId": "e3", "parentId": "e2"]]
        checkpoint["display"] = ["entries": [["entryId": "e2", "message": message("recent", text: "recent")], ["entryId": "e3", "message": NSNull()]]]
        checkpoint["cursor"] = ["leafId": "e3"]
        checkpoint["source"] = ["epoch": "source", "seq": 2, "ready": true]
        checkpoint["hasOlder"] = true
        await transport.event(checkpoint)
        await transport.event(["type": "session.patch", "sessionId": "session-a", "baseSeq": 2, "source": ["epoch": "source", "seq": 3, "ready": true], "live": ["complete": true, "messages": [["message": message("live", text: "live")]]]], sequence: 2)
        #expect(store.loadOlderHistory())
        await store.waitForPendingEvents()
        #expect(!store.loadOlderHistory())
        await store.waitForPendingEvents()
        let history = try #require(transport.syncCommands.last)
        #expect(history["range"] as? String == "history")
        #expect(history["beforeEntryId"] as? String == "e2")
        #expect(history["targetLeafId"] as? String == "e3")
        await transport.event(["type": "session.snapshot", "syncId": history["syncId"]!, "sessionId": "session-a", "range": "history", "mode": "prepend", "beforeEntryId": "e2", "targetLeafId": "e3", "entries": [["entryId": "e1"]], "hasOlder": false,
            "source": ["epoch": "source", "seq": 1, "ready": true], "display": ["entries": [["entryId": "e1", "message": message("older", text: "older")]]]], sequence: 3)
        #expect(store.messages.map(\.text) == ["older", "recent", "live"])
        #expect(store.hasOlderHistory["a"] == false)
        #expect(store.historyLoading.isEmpty)
        await transport.event(["type": "session.patch", "sessionId": "session-a", "baseSeq": 3, "source": ["epoch": "source", "seq": 4, "ready": true],
            "display": ["entries": [["message": message("new", text: "new")]]]], sequence: 4)
        #expect(store.messages.last?.text == "new")
        #expect(transport.syncCommands.filter { $0["range"] as? String != "catchup" }.count == 2)
    }

    @Test func invalidToolScopeRejectsSnapshotBeforeReplacingMessages() async throws {
        let (store, transport) = setup(); await transport.ready([runtime("a")])
        var checkpoint = snapshot(try #require(transport.syncCommands.last), text: "untrusted")
        checkpoint["live"] = ["complete": true, "messages": [], "toolInventory": ["projectionVersion": 1,
            "agent": ["hostId": "another-computer", "agentKind": "codex", "sessionId": "session-a"], "version": ["epoch": "e", "revision": 1], "source": ["epoch": "s", "seq": 1], "totalCount": 0, "summaryBytes": 0]]
        await transport.event(checkpoint)
        #expect(store.messages.isEmpty)
        #expect((transport.sent.last?["command"] as? [String: Any])?["result"] as? String == "rejected")
    }

    @Test func stalePreviewCannotRollBackANewerLiveSource() async throws {
        let (store, transport) = setup(); await transport.ready([runtime("a")])
        var first = snapshot(try #require(transport.syncCommands.last), text: "first")
        first["source"] = ["epoch": "source", "seq": 1, "ready": true]
        await transport.event(first)
        store.refresh()
        let refresh = try #require(transport.syncCommands.last)
        await transport.event(["type": "session.patch", "sessionId": "session-a", "baseSeq": 1,
            "source": ["epoch": "source", "seq": 2, "ready": true], "display": ["entries": [["message": message("new", text: "new")]]]], sequence: 2)
        var stale = snapshot(refresh, text: "stale")
        stale["source"] = ["epoch": "source", "seq": 1, "ready": true]
        await transport.event(stale, sequence: 3)
        #expect(store.messages.map(\.text) == ["first", "new"])
        #expect((transport.sent.last?["command"] as? [String: Any])?["result"] as? String == "rejected")
    }

    private func checkpoint(_ sync: [String: Any], ids: [Int], seq: Int = 1, hasOlder: Bool = false) -> [String: Any] {
        let leaf = ids.last.map { "e\($0)" }
        return ["type": "session.snapshot", "sessionId": sync["sessionId"]!, "syncId": sync["syncId"]!,
            "range": "preview", "mode": "replace", "selection": "snapshot", "complete": true,
            "source": ["epoch": "source", "seq": seq, "ready": true], "cursor": ["leafId": leaf as Any? ?? NSNull()],
            "checkpoint": ["checkpointId": "source:\(seq)", "head": ["leafId": leaf as Any? ?? NSNull()], "headCompleteness": "complete", "inventoryComplete": true],
            "entries": ids.map { n in ["entryId": "e\(n)", "parentId": n > 1 ? "e\(n - 1)" as Any : NSNull(), "type": "message", "timestamp": "2026-10-29T00:00:00Z", "data": [:]] as [String: Any] },
            "display": ["projectionVersion": 3, "entries": ids.map { ["entryId": "e\($0)", "message": message("m\($0)", text: "row \($0)")] }],
            "live": ["complete": true, "messages": []], "rangeStatus": hasOlder ? "older_available" : "complete", "hasOlder": hasOlder]
    }

    @Test func syncRetriesReuseImmutableIdentityAndLateResultsRemainCorrelated() async throws {
        let (store, transport) = setup(); await transport.ready([runtime("a")])
        let original = try #require(transport.sent.last { ($0["command"] as? [String: Any])?["type"] as? String == "session.sync" })
        let command = try #require(original["command"] as? [String: Any])
        store.advanceSessionSyncs(now: Date().addingTimeInterval(31))
        let retry = try #require(transport.sent.last { ($0["command"] as? [String: Any])?["type"] as? String == "session.sync" })
        #expect(retry["commandId"] as? String == original["commandId"] as? String)
        #expect(try JSONSerialization.data(withJSONObject: retry["command"]!, options: .sortedKeys) == JSONSerialization.data(withJSONObject: command, options: .sortedKeys))
        store.advanceSessionSyncs(now: Date().addingTimeInterval(151))
        #expect(!store.isSyncing)
        await transport.event(checkpoint(command, ids: [1]))
        #expect(store.messages.map(\.messageId) == ["m1"])
        #expect((transport.sent.last?["command"] as? [String: Any])?["result"] as? String == "applied")
    }

    @Test func pendingLeaseSuppressesBlindRetriesAndIsBoundToRuntime() async throws {
        let (store, transport) = setup(); await transport.ready([runtime("a"), runtime("b")])
        let sync = try #require(transport.syncCommands.last)
        await transport.event(["type": "session.sync.pending", "syncId": sync["syncId"]!, "leaseMs": 120_000], sequence: 1, channel: "ctl")
        store.advanceSessionSyncs(now: Date().addingTimeInterval(61))
        #expect(transport.syncCommands.count == 1)
        #expect(store.isSyncing)
        // Another runtime cannot extend ownership of this transaction.
        await transport.event(["type": "session.sync.pending", "syncId": sync["syncId"]!, "leaseMs": 600_000], runtimeId: "b", sequence: 1, channel: "ctl")
        store.advanceSessionSyncs(now: Date().addingTimeInterval(151))
        #expect(!store.isSyncing)
    }

    @Test func onlyCommittedCompleteCheckpointsCanRequestConditionalState() async throws {
        let (store, transport) = setup(); await transport.ready([runtime("a")])
        await transport.event(checkpoint(try #require(transport.syncCommands.last), ids: [1]))
        store.refresh()
        let sync = try #require(transport.syncCommands.last)
        let known = try #require(sync["knownState"] as? [String: Any])
        #expect(known["seq"] as? Int64 == 1)
        #expect((known["head"] as? [String: Any])?["leafId"] as? String == "e1")
        var unchanged = checkpoint(sync, ids: [1])
        unchanged["mode"] = "append"; unchanged["selection"] = "unchanged"; unchanged["entries"] = []
        unchanged.removeValue(forKey: "live"); unchanged["display"] = ["entries": []]
        await transport.event(unchanged, sequence: 2)
        #expect(store.messages.map(\.messageId) == ["m1"])
        #expect(!store.isSyncing)
        #expect((transport.sent.last?["command"] as? [String: Any])?["result"] as? String == "applied")
        store.refresh()
        var invalid = checkpoint(try #require(transport.syncCommands.last), ids: [3], seq: 2)
        invalid["mode"] = "append"; invalid["selection"] = "delta"
        // e3 depends on e2, so it cannot extend the committed e1 baseline.
        await transport.event(invalid, sequence: 3)
        #expect(store.messages.map(\.messageId) == ["m1"])
        #expect((transport.sent.last?["command"] as? [String: Any])?["result"] as? String == "rejected")
    }

    @Test func cyclicAndNonAdvancingHistoryNeverMutateTheConversation() async throws {
        let (store, transport) = setup(); await transport.ready([runtime("a")])
        await transport.event(checkpoint(try #require(transport.syncCommands.last), ids: [2, 3], hasOlder: true))
        #expect(store.loadOlderHistory())
        await store.waitForPendingEvents()
        let request = try #require(transport.syncCommands.last)
        await transport.event(["type": "session.snapshot", "syncId": request["syncId"]!, "sessionId": "session-a", "range": "history", "mode": "prepend", "beforeEntryId": "e2", "targetLeafId": "e3", "entries": [], "hasOlder": true, "rangeStatus": "older_available"], sequence: 2)
        #expect(store.messages.map(\.messageId) == ["m2", "m3"])
        #expect(store.historyErrors["a"] != nil)
        #expect(store.historyLoading.isEmpty)
        store.refresh()
        var cycle = checkpoint(try #require(transport.syncCommands.last), ids: [4, 5], seq: 2)
        cycle["entries"] = [["entryId": "e4", "parentId": "e5"], ["entryId": "e5", "parentId": "e4"]]
        await transport.event(cycle, sequence: 3)
        #expect(store.messages.map(\.messageId) == ["m2", "m3"])
        #expect((transport.sent.last?["command"] as? [String: Any])?["result"] as? String == "rejected")
    }

    @Test func canonicalHistorySurvivesRelaunchAndUsesCachedAncestorPages() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let firstTransport = TestTransport()
        let first = OrbisStore(secure: MemorySecureStore(), transport: firstTransport, preferences: nil, transferRoot: root)
        firstTransport.drain = { [weak first] in await first?.waitForPendingEvents() }
        await firstTransport.ready([runtime("a")])
        await firstTransport.event(checkpoint(try #require(firstTransport.syncCommands.last), ids: Array(6...35), seq: 5, hasOlder: true))
        #expect(first.loadOlderHistory())
        await first.waitForPendingEvents()
        let history = try #require(firstTransport.syncCommands.last)
        var older = checkpoint(history, ids: Array(1...5), seq: 4)
        older["range"] = "history"; older["mode"] = "prepend"; older.removeValue(forKey: "selection")
        older["beforeEntryId"] = "e6"; older["targetLeafId"] = "e35"; older["cursor"] = ["leafId": "e35"]
        await firstTransport.event(older, sequence: 2)
        #expect(first.messages.count == 35)
        let secondTransport = TestTransport()
        let second = OrbisStore(secure: MemorySecureStore(), transport: secondTransport, preferences: nil, transferRoot: root)
        secondTransport.drain = { [weak second] in await second?.waitForPendingEvents() }
        await secondTransport.ready([runtime("other-runtime", session: "session-a")])
        #expect(second.messages.count == 30)
        #expect(second.messages.first?.messageId == "m6")
        let preview = try #require(secondTransport.syncCommands.last)
        #expect(preview["knownState"] == nil)
        await secondTransport.event(checkpoint(preview, ids: Array(6...35), seq: 5, hasOlder: true), runtimeId: "other-runtime")
        let networkCount = secondTransport.syncCommands.count
        #expect(second.loadOlderHistory())
        await second.waitForPendingEvents()
        #expect(secondTransport.syncCommands.count == networkCount)
        #expect(second.messages.count == 35)
        #expect(second.hasOlderHistory["other-runtime"] == false)
        second.unpair(hostId: "host-1")
        await second.waitForPendingEvents()
        let thirdTransport = TestTransport()
        let third = OrbisStore(secure: MemorySecureStore(), transport: thirdTransport, preferences: nil, transferRoot: root)
        thirdTransport.drain = { [weak third] in await third?.waitForPendingEvents() }
        await thirdTransport.ready([runtime("a")])
        #expect(third.messages.isEmpty)
    }

    @Test func failedDurableCommitRejectsBeforePublishingAnyMessages() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        try Data("block directory creation".utf8).write(to: root.appendingPathComponent("SessionHistory"))
        let transport = TestTransport()
        let observed = OrbisStore(secure: MemorySecureStore(), transport: transport, preferences: nil, transferRoot: root)
        transport.drain = { [weak observed] in await observed?.waitForPendingEvents() }
        await transport.ready([runtime("a")])
        await transport.event(checkpoint(try #require(transport.syncCommands.last), ids: [1]))
        #expect(observed.messages.isEmpty)
        #expect((transport.sent.last?["command"] as? [String: Any])?["result"] as? String == "rejected")
    }

    @Test func overflowRecoveryIsThrottledAndPreservesOutstandingDemand() async throws {
        let (store, transport) = setup(); await transport.ready([runtime("a")])
        let first = try #require(transport.syncCommands.last)
        await transport.emit(["type": "_transport.overflow"])
        await transport.emit(["type": "_transport.overflow"])
        #expect(transport.syncCommands.count == 1)
        await transport.event(checkpoint(first, ids: [1]))
        #expect(transport.syncCommands.count == 2)
        await transport.event(checkpoint(try #require(transport.syncCommands.last), ids: [1]), sequence: 2)
        #expect(!store.isSyncing)
        await transport.emit(["type": "_transport.overflow"])
        #expect(transport.syncCommands.count == 2)
    }

    @Test func manualRetryAfterLocalExhaustionKeepsTheCoordinatorIdentity() async throws {
        let (store, transport) = setup(); await transport.ready([runtime("a")])
        let first = try #require(transport.syncCommands.last)
        store.advanceSessionSyncs(now: Date().addingTimeInterval(151))
        #expect(!store.isSyncing)
        store.refresh()
        #expect(transport.syncCommands.last?["syncId"] as? String == first["syncId"] as? String)
        await transport.event(checkpoint(first, ids: [1]))
        let count = transport.syncCommands.count
        await transport.event(checkpoint(first, ids: [1]), sequence: 2)
        #expect(store.messages.count == 1)
        #expect(transport.syncCommands.count == count)
        #expect((transport.sent.last?["command"] as? [String: Any])?["result"] as? String == "applied")
    }

    @Test func incompleteSourceTransactionsAndLateLifecycleEventsCannotMutateHistory() async throws {
        let (store, transport) = setup(); await transport.ready([runtime("a")])
        await transport.event(checkpoint(try #require(transport.syncCommands.last), ids: [1]))
        await transport.event(["type": "message.delta", "messageId": "m1", "delta": " stale"], sequence: 2)
        #expect(store.messages.first?.text == "row 1")
        await transport.event(["type": "session.patch", "sessionId": "session-a", "baseSeq": 1, "seq": 2,
            "source": ["epoch": "source", "seq": 2, "ready": true], "headCompleteness": "unknown",
            "display": ["entries": [["entryId": "e1", "message": message("m1", text: "invalid")]]],
            "live": ["complete": true, "messages": []]], sequence: 3)
        #expect(store.messages.first?.text == "row 1")
        let pending = try #require(transport.syncCommands.last)
        var missing = checkpoint(pending, ids: [2], seq: 3)
        missing.removeValue(forKey: "source")
        // Bypass the complete fixture helper to exercise the actual missing-source wire boundary.
        await transport.emit(["type": "runtime.event", "runtimeId": "a", "sequence": 4, "event": missing], channel: "msg")
        #expect(store.messages.first?.text == "row 1")
        #expect((transport.sent.last?["command"] as? [String: Any])?["result"] as? String == "rejected")
    }

    @Test func emptyNewSourceEpochReplacesPersistedHistory() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let transport = TestTransport()
        let store = OrbisStore(secure: MemorySecureStore(), transport: transport, preferences: nil, transferRoot: root)
        transport.drain = { [weak store] in await store?.waitForPendingEvents() }
        await transport.ready([runtime("a")])
        await transport.event(checkpoint(try #require(transport.syncCommands.last), ids: [1]))
        store.refresh()
        var empty = checkpoint(try #require(transport.syncCommands.last), ids: [])
        empty["source"] = ["epoch": "replacement", "seq": 1, "ready": true]
        await transport.event(empty, sequence: 2)
        #expect(store.messages.isEmpty)
        let restoredTransport = TestTransport()
        let restored = OrbisStore(secure: MemorySecureStore(), transport: restoredTransport, preferences: nil, transferRoot: root)
        restoredTransport.drain = { [weak restored] in await restored?.waitForPendingEvents() }
        await restoredTransport.ready([runtime("a")])
        #expect(restored.messages.isEmpty)
    }

    @Test func queueCancellationWaitsForAMatchingRuntimeReceiptAndAuthoritativeState() async throws {
        let (store, transport) = setup(); await transport.ready([runtime("a"), runtime("b")])
        await transport.event(["type": "message.queued", "queueId": "queue-1", "text": "later", "delivery": "followUp", "state": "accepted"], channel: "ctl")
        #expect(store.cancelQueuedMessage("queue-1"))
        #expect(!store.cancelQueuedMessage("queue-1"))
        let commandId = try #require(transport.sent.last?["commandId"] as? String)
        #expect((transport.sent.last?["command"] as? [String: Any])?["messageId"] as? String == "queue-1")
        await transport.event(["type": "command.result", "commandId": commandId, "ok": true], runtimeId: "b", sequence: 2, channel: "ctl")
        #expect(store.pendingQueueCancellations.contains("queue-1"))
        await transport.event(["type": "command.result", "commandId": commandId, "ok": true], sequence: 2, channel: "ctl")
        #expect(store.pendingQueueCancellations.isEmpty)
        #expect(store.queuedMessages["a"]?.first?.state == "accepted")
        await transport.event(["type": "message.queued", "queueId": "queue-1", "text": "later", "delivery": "followUp", "state": "cancelled"], sequence: 3, channel: "ctl")
        #expect(store.queuedMessages["a"]?.first?.state == "cancelled")
    }

    @Test func lastSessionSelectionSurvivesRuntimeRoutingChangesWithoutActivation() async throws {
        let key = "orbis-last-session-" + UUID().uuidString
        let preferences = try #require(UserDefaults(suiteName: key))
        defer { preferences.removePersistentDomain(forName: key) }
        let transport = TestTransport()
        let store = OrbisStore(secure: MemorySecureStore(), transport: transport, preferences: preferences)
        transport.drain = { [weak store] in await store?.waitForPendingEvents() }
        await transport.ready([runtime("a"), runtime("b")]); store.selectRuntime("b")
        let restoredTransport = TestTransport()
        let restored = OrbisStore(secure: MemorySecureStore(), transport: restoredTransport, preferences: preferences)
        restoredTransport.drain = { [weak restored] in await restored?.waitForPendingEvents() }
        await restoredTransport.ready([runtime("a"), runtime("reconnected", session: "session-b")])
        #expect(restored.selectedRuntimeId == "reconnected")
        #expect(!restoredTransport.sent.contains { $0["type"] as? String == "session.activate" })
    }

    private func rangeSnapshot(_ request: [String: Any], ids: [Int], seq: Int = 1, complete: Bool = true) -> [String: Any] {
        var result = checkpoint(request, ids: ids, seq: seq)
        result["range"] = request["range"]
        result["mode"] = request["range"] as? String == "history" ? "prepend" : (request["knownLeafId"] == nil ? "replace" : "append")
        result["targetLeafId"] = request["targetLeafId"]
        result["cursor"] = ["leafId": request["targetLeafId"] as Any? ?? NSNull()]
        result["beforeEntryId"] = request["beforeEntryId"]
        result["complete"] = complete
        result["rangeStatus"] = complete ? "complete" : "limit_reached"
        result.removeValue(forKey: "selection"); result.removeValue(forKey: "live"); result.removeValue(forKey: "checkpoint")
        return result
    }

    @Test func fixedTargetCatchupCommitsAncestorsWithoutMovingLiveHead() async throws {
        let (store, transport) = setup(); await transport.ready([runtime("a")])
        await transport.event(checkpoint(try #require(transport.syncCommands.last), ids: [3, 4], hasOlder: true))
        let catchup = try #require(transport.syncCommands.last { $0["range"] as? String == "catchup" })
        #expect(catchup["targetLeafId"] as? String == "e2")
        await transport.event(["type": "session.patch", "sessionId": "session-a", "baseSeq": 1, "seq": 2,
            "source": ["epoch": "source", "seq": 2, "ready": true], "head": ["leafId": "e5"],
            "entries": [["entryId": "e5", "parentId": "e4"]],
            "display": ["entries": [["entryId": "e5", "message": message("m5", text: "row 5")]]]], sequence: 2)
        await transport.event(rangeSnapshot(catchup, ids: [1, 2]), sequence: 3)
        #expect(store.messages.map(\.text) == ["row 3", "row 4", "row 5"])
        let child = try #require(store.connection(for: "host-1"))
        #expect(child.sessionReads.latest(historyKey: "a", kind: .catchup)?.phase == .succeeded)
        store.refresh()
        let known = try #require(transport.syncCommands.last?["knownState"] as? [String: Any])
        #expect(known["seq"] as? Int64 == 2)
        #expect((known["head"] as? [String: Any])?["leafId"] as? String == "e5")
    }

    @Test func historyPageSurvivesLiveAppendAndKeepsTheNewerHead() async throws {
        let (store, transport) = setup(); await transport.ready([runtime("a")])
        await transport.event(checkpoint(try #require(transport.syncCommands.last), ids: [2, 3], hasOlder: true))
        #expect(store.loadOlderHistory()); await store.waitForPendingEvents()
        let history = try #require(transport.syncCommands.last { $0["range"] as? String == "history" })
        await transport.event(["type": "session.patch", "sessionId": "session-a", "baseSeq": 1, "seq": 2,
            "source": ["epoch": "source", "seq": 2, "ready": true], "head": ["leafId": "e4"],
            "entries": [["entryId": "e4", "parentId": "e3"]],
            "display": ["entries": [["entryId": "e4", "message": message("m4", text: "row 4")]]]], sequence: 2)
        await transport.event(rangeSnapshot(history, ids: [1]), sequence: 3)
        #expect(store.messages.map(\.text) == ["row 1", "row 2", "row 3", "row 4"])
        #expect(store.historyErrors["a"] == nil)
        #expect(store.historyLoading.isEmpty)
        store.refresh()
        let known = try #require(transport.syncCommands.last?["knownState"] as? [String: Any])
        #expect((known["head"] as? [String: Any])?["leafId"] as? String == "e4")
    }

    @Test func offlineBranchBrowsingAndPagingNeverActivateOrSendCommands() async throws {
        let (store, transport) = setup(); await transport.ready([runtime("a")])
        await transport.event(checkpoint(try #require(transport.syncCommands.last), ids: [1, 2]))
        store.refresh()
        var branch = checkpoint(try #require(transport.syncCommands.last), ids: [3], seq: 2)
        branch["entries"] = [["entryId": "e3", "parentId": "e1"]]
        await transport.event(branch, sequence: 2)
        transport.state?(.offline, nil)
        let count = transport.sent.count
        let session = SessionSummary(sessionId: "session-a", cwd: "/repo", createdAt: 0, modifiedAt: 0, messageCount: 3)
        #expect(store.openCachedSession(session)); await store.waitForPendingEvents()
        #expect(store.isViewingCachedSession)
        #expect(store.messages.map(\.text) == ["row 1", "row 3"])
        #expect(store.cachedHistoryOptions.contains { $0.value == "e2" })
        store.selectCachedBranch("e2"); await store.waitForPendingEvents()
        #expect(store.messages.map(\.text) == ["row 1", "row 2"])
        #expect(!store.canSend)
        #expect(transport.sent.count == count)
    }

    @Test func pendingNoticesCannotExtendALeaseForever() async throws {
        let (store, transport) = setup(); await transport.ready([runtime("a")])
        let request = try #require(transport.syncCommands.last)
        for sequence in 1...12 {
            await transport.event(["type": "session.sync.pending", "syncId": request["syncId"]!, "leaseMs": 1_000,
                "phase": "processing"], sequence: sequence, channel: "ctl")
        }
        store.advanceSessionSyncs(now: Date().addingTimeInterval(151))
        #expect(!store.isSyncing)
        let child = try #require(store.connection(for: "host-1"))
        #expect(child.sessionReads.latest(historyKey: "a", kind: .source)?.phase == .failed)
    }

    @Test func backgroundCatchupAdvancesAcrossMultipleForwardPages() async throws {
        let (store, transport) = setup(); await transport.ready([runtime("a")])
        await transport.event(checkpoint(try #require(transport.syncCommands.last), ids: [499, 500], hasOlder: true))
        var last = 0
        for page in 0..<4 {
            let request = try #require(transport.syncCommands.last { $0["range"] as? String == "catchup" })
            #expect(request["targetLeafId"] as? String == "e498")
            #expect(request["knownLeafId"] as? String == (last == 0 ? nil : "e\(last)"))
            let end = min(498, last + 128)
            await transport.event(rangeSnapshot(request, ids: Array((last + 1)...end), complete: end == 498), sequence: page + 2)
            last = end
        }
        #expect(transport.syncCommands.filter { $0["range"] as? String == "catchup" }.count == 4)
        let child = try #require(store.connection(for: "host-1"))
        #expect(child.sessionReads.latest(historyKey: "a", kind: .catchup)?.phase == .succeeded)
        #expect(store.messages.map(\.text) == ["row 499", "row 500"])
        #expect(store.loadOlderHistory()); await store.waitForPendingEvents()
        #expect(store.messages.count == 32)
        #expect(store.messages.first?.text == "row 469")
        #expect(transport.syncCommands.filter { $0["range"] as? String == "history" }.isEmpty)
    }

    @Test func toolInventoryFailureRejectsAckAndReleasesSourceRead() async throws {
        let (store, transport) = setup(); await transport.ready([runtime("a")])
        var event = checkpoint(try #require(transport.syncCommands.last), ids: [1])
        event["live"] = ["complete": true, "messages": [], "toolInventory": ["projectionVersion": 1,
            "agent": ["hostId": "host-1", "agentKind": "pi", "sessionId": "session-a"],
            "version": ["epoch": "tools", "revision": 1], "source": ["epoch": "source", "seq": 1],
            "totalCount": 0, "summaryBytes": 0]]
        await transport.event(event)
        #expect(store.isSyncing)
        let command = try #require(transport.sent.compactMap { $0["command"] as? [String: Any] }.last { $0["type"] as? String == "session.tools.open" })
        await transport.event(["type": "session.tool.read.failed", "runtimeId": "a", "requestId": command["requestId"]!, "reason": "snapshot_expired"], sequence: 2)
        #expect(!store.isSyncing)
        let ack = try #require(transport.sent.compactMap { $0["command"] as? [String: Any] }.last { $0["type"] as? String == "session.snapshot.ack" })
        #expect(ack["result"] as? String == "rejected")
        store.refresh()
        #expect(transport.syncCommands.last?["knownState"] == nil)
    }

    @Test func committedTimingsAreScopedToSelectedSession() async throws {
        let (store, transport) = setup(); await transport.ready([runtime("a"), runtime("b")])
        var first = checkpoint(try #require(transport.syncCommands.last), ids: [1])
        first["turnTimings"] = [["turnId": "same-turn", "startedAt": 100, "durationMs": 12, "messageId": "m1"]]
        await transport.event(first)
        #expect(store.turnTimings.first?.durationMs == 12)
        store.selectRuntime("b"); await store.waitForPendingEvents()
        #expect(store.turnTimings.isEmpty)
        var second = checkpoint(try #require(transport.syncCommands.last), ids: [1])
        second["turnTimings"] = [["turnId": "same-turn", "startedAt": 200, "durationMs": 34, "messageId": "m1"]]
        await transport.event(second, runtimeId: "b")
        #expect(store.turnTimings.first?.durationMs == 34)
        store.selectRuntime("a"); await store.waitForPendingEvents()
        #expect(store.turnTimings.first?.durationMs == 12)
    }

    @Test func authenticatedDesktopAvailabilityClearsWhenOmitted() async throws {
        let (store, transport) = setup()
        await transport.emit(["type": "device.ready", "protocolVersion": orbisProtocolVersion, "runtimes": [],
            "codexDesktop": ["state": "closed", "reason": "Open the desktop app"]])
        #expect(store.codexDesktop?.state == "closed")
        #expect(store.codexDesktop?.reason == "Open the desktop app")
        await transport.ready([])
        #expect(store.codexDesktop == nil)
    }

    @Test func byteBoundedHistoryPagesCommitAndContinueInsteadOfFailing() async throws {
        let (store, transport) = setup(); await transport.ready([runtime("a")])
        await transport.event(checkpoint(try #require(transport.syncCommands.last), ids: [40, 41], hasOlder: true))
        #expect(store.loadOlderHistory()); await store.waitForPendingEvents()
        let history = try #require(transport.syncCommands.last { $0["range"] as? String == "history" })
        var page = rangeSnapshot(history, ids: Array(30...39), complete: false)
        page["hasOlder"] = true; page["rangeStatus"] = "older_available"
        await transport.event(page, sequence: 2)
        #expect(store.messages.count == 12)
        #expect(store.messages.first?.text == "row 30")
        #expect(store.historyErrors["a"] == nil)
        #expect(store.hasOlderHistory["a"] == true)
        #expect(store.loadOlderHistory()); await store.waitForPendingEvents()
        let next = try #require(transport.syncCommands.last { $0["range"] as? String == "history" })
        #expect(next["beforeEntryId"] as? String == "e30")
    }

    @Test func compactionWindowOutsideTheBoundedGraphRemovesOldDisplayedMessages() async throws {
        let (store, transport) = setup(); await transport.ready([runtime("a")])
        await transport.event(checkpoint(try #require(transport.syncCommands.last), ids: Array(1...500)))
        var patch: [String: Any] = ["type": "session.patch", "sessionId": "session-a", "baseSeq": 1, "seq": 2,
            "source": ["epoch": "source", "seq": 2, "ready": true], "head": ["leafId": "e500"],
            "entries": [], "display": ["projectionVersion": 3, "windowStart": "e200", "entries": []]]
        await transport.event(patch, sequence: 2)
        #expect(store.messages.count == 301)
        #expect(store.messages.first?.text == "row 200")
        patch["baseSeq"] = 2; patch["seq"] = 3; patch["source"] = ["epoch": "source", "seq": 3, "ready": true]
        patch["display"] = ["projectionVersion": 3, "windowStart": "e220", "entries": [["entryId": "e220", "message": NSNull()]]]
        await transport.event(patch, sequence: 3)
        #expect(store.messages.first?.text == "row 221")
        #expect(!store.messages.contains { $0.text == "row 1" || $0.text == "row 200" })
    }

    @Test func fullEntryRequestsResolveDisplayMessageIdsToCanonicalEntries() async throws {
        let (store, transport) = setup(); await transport.ready([runtime("a")])
        await transport.event(checkpoint(try #require(transport.syncCommands.last), ids: [1]))
        store.previewEntry("m1")
        let request = try #require(transport.sent.last?["command"] as? [String: Any])
        #expect(request["type"] as? String == "session.entry.request")
        #expect(request["entryId"] as? String == "e1")
    }

    @Test func refreshDuringToolInventoryReadWaitsAndVerifiedOldReferenceFinishes() async throws {
        let (store, transport) = setup(); await transport.ready([runtime("a")])
        func tool(_ revision: Int) -> [String: Any] {
            ["projectionVersion": 1, "tool": ["agent": ["hostId": "host-1", "agentKind": "pi", "sessionId": "session-a"], "toolCallId": "call"],
             "toolName": "shell", "phase": "running", "order": revision, "contents": []]
        }
        func reference(_ revision: Int) throws -> [String: Any] {
            ["projectionVersion": 1, "agent": ["hostId": "host-1", "agentKind": "pi", "sessionId": "session-a"],
             "version": ["epoch": "tools", "revision": revision], "source": ["epoch": "source", "seq": revision],
             "totalCount": 1, "summaryBytes": try JSONSerialization.data(withJSONObject: tool(revision), options: [.withoutEscapingSlashes]).count]
        }
        let first = try reference(1), second = try reference(2)
        var event = checkpoint(try #require(transport.syncCommands.last), ids: [1])
        event["live"] = ["complete": true, "messages": [], "toolInventory": first]
        await transport.event(event)
        await transport.event(event, sequence: 2)
        #expect(!transport.sent.compactMap { $0["command"] as? [String: Any] }.contains { $0["type"] as? String == "session.snapshot.ack" && $0["result"] as? String == "rejected" })
        store.refresh()
        #expect(transport.syncCommands.count == 1)
        await transport.event(["type": "session.patch", "sessionId": "session-a", "baseSeq": 1, "seq": 2,
            "source": ["epoch": "source", "seq": 2, "ready": true], "head": ["leafId": "e1"],
            "live": ["complete": true, "messages": [], "toolInventory": second]], sequence: 3)
        await transport.event(["type": "session.tools.patch", "runtimeId": "a", "agent": first["agent"]!,
            "version": second["version"]!, "source": second["source"]!, "baseRevision": 1, "upserts": [tool(2)], "removes": []], sequence: 4)
        let open = try #require(transport.sent.compactMap { $0["command"] as? [String: Any] }.last { $0["type"] as? String == "session.tools.open" })
        let descriptor: [String: Any] = ["snapshotId": "fixed", "agent": first["agent"]!, "version": first["version"]!, "source": first["source"]!, "totalCount": 1]
        await transport.event(["type": "session.tools.opened", "runtimeId": "a", "requestId": open["requestId"]!, "snapshot": descriptor], sequence: 5)
        let read = try #require(transport.sent.compactMap { $0["command"] as? [String: Any] }.last { $0["type"] as? String == "session.tools.read" })
        await transport.event(["type": "session.tools.page", "runtimeId": "a", "requestId": read["requestId"]!, "snapshot": descriptor,
            "startIndex": 0, "endIndex": 1, "tools": [tool(1)], "nextCursor": NSNull()], sequence: 6)
        #expect(transport.syncCommands.count == 2)
        let latest = try #require(transport.syncCommands.last?["knownState"] as? [String: Any])
        #expect(latest["seq"] as? Int64 == 2)
        #expect(transport.sent.compactMap { $0["command"] as? [String: Any] }.contains { $0["type"] as? String == "session.snapshot.ack" && $0["result"] as? String == "applied" })
        let child = try #require(store.connection(for: "host-1"))
        #expect(child.sessionReads.operations.values.contains { $0.kind == .source && $0.phase == .succeeded })
    }

    @Test func reconnectDropsObsoleteToolDependenciesAndRequestsFreshSource() async throws {
        let (store, transport) = setup(); await transport.ready([runtime("a")])
        var event = checkpoint(try #require(transport.syncCommands.last), ids: [1])
        event["live"] = ["complete": true, "messages": [], "toolInventory": ["projectionVersion": 1,
            "agent": ["hostId": "host-1", "agentKind": "pi", "sessionId": "session-a"],
            "version": ["epoch": "tools", "revision": 1], "source": ["epoch": "source", "seq": 1],
            "totalCount": 0, "summaryBytes": 0]]
        await transport.event(event)
        #expect(store.isSyncing)
        transport.state?(.offline, nil)
        await transport.ready([runtime("a")])
        #expect(transport.syncCommands.count == 2)
        #expect(transport.syncCommands.last?["knownState"] == nil)
        await transport.event(checkpoint(try #require(transport.syncCommands.last), ids: [2]), sequence: 1)
        #expect(store.messages.map(\.text) == ["row 2"])
        #expect(!store.isSyncing)
    }

    @Test func unsentHistoryFallbackReleasesLoadingAndCanRetry() async throws {
        let (store, transport) = setup(); await transport.ready([runtime("a")])
        await transport.event(checkpoint(try #require(transport.syncCommands.last), ids: [2, 3], hasOlder: true))
        transport.acceptsSends = false
        #expect(store.loadOlderHistory()); await store.waitForPendingEvents()
        #expect(store.historyLoading.isEmpty)
        #expect(store.historyErrors["a"]?.contains("未送达") == true)
        transport.acceptsSends = true
        #expect(store.loadOlderHistory()); await store.waitForPendingEvents()
        #expect(transport.syncCommands.last?["range"] as? String == "history")
    }

    @Test func runtimeReplacementDuringDiskCommitCannotPublishOrPersistTheOldSnapshot() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let transport = TestTransport(), secure = MemorySecureStore(), gate = SingleCommitGate()
        let replacement = runtime("a")
        let worker = SessionHistoryWorker(root: root.appendingPathComponent("SessionHistory"), beforeCommit: {
            guard gate.claim() else { return }
            let resumed = DispatchSemaphore(value: 0)
            Task { @MainActor in
                transport.receive?(["type": "runtime.offline", "runtimeId": "a"], "ctl")
                transport.receive?(["type": "runtime.online", "runtime": replacement], "ctl")
                resumed.signal()
            }
            _ = resumed.wait(timeout: .now() + 5)
        })
        let pairing = try #require(secure.hosts.first)
        let child = HostConnection(secure: secure, transport: transport, preferences: nil, transferRoot: root,
            initialPairing: pairing, isolated: true, historyWorker: worker)
        transport.drain = { [weak child] in await child?.waitForPendingEvents() }
        await transport.ready([runtime("a")])
        await transport.event(checkpoint(try #require(transport.syncCommands.last), ids: [1]))
        #expect(child.messages.isEmpty)
        #expect(try await worker.entry(host: pairing, sessionId: "session-a", entryId: "e1") == nil)
        #expect(transport.syncCommands.count >= 2)
        var fresh = checkpoint(try #require(transport.syncCommands.last), ids: [2])
        fresh["entries"] = [["entryId": "e2", "parentId": NSNull()]]
        await transport.event(fresh, sequence: 2)
        #expect(child.messages.map(\.text) == ["row 2"])
        #expect(!child.isSyncing)
        child.shutdown()
    }

}
