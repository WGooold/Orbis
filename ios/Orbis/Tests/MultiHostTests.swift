import Foundation
import Testing
@testable import OrbisCore

private final class MultiHostSecureStore: SecureStorage {
    var hosts: [HostPairing]
    init(_ hosts: [HostPairing]) { self.hosts = hosts }
    func deviceIdentity() throws -> DeviceIdentity { .generate() }
    func savePairings(_ pairings: [HostPairing]) throws { hosts = pairings }
    func pairings() -> [HostPairing] { hosts }
}

@MainActor
private final class MultiHostTransport: OrbisTransport {
    var sent: [[String: Any]] = []
    var connectCount = 0
    var disconnectCount = 0
    var receive: (([String: Any], String?) -> Void)?
    var state: ((ConnectionState, String?) -> Void)?
    var drain: (() async -> Void)?
    func pair(qr: PairingQR, deviceName: String, identity: DeviceIdentity,
              completion: @escaping (Result<HostPairing, Error>) -> Void) { completion(.failure(PairingError.invalidQR)) }
    func connect(pairing: HostPairing, identity: DeviceIdentity, receive: @escaping ([String: Any], String?) -> Void,
                 state: @escaping (ConnectionState, String?) -> Void) {
        connectCount += 1; self.receive = receive; self.state = state; state(.connecting, nil)
    }
    func disconnect() { disconnectCount += 1 }
    func send(_ object: [String: Any]) -> Bool { sent.append(object); return true }
    func emit(_ object: [String: Any], channel: String = "ctl") async { receive?(object, channel); await drain?() }
    func ready() async {
        await emit(["type": "device.ready", "protocolVersion": orbisProtocolVersion, "runtimes": [[
            "runtimeId": "shared-runtime", "name": "Shared runtime", "cwd": "/repo", "status": "idle", "sessionId": "shared-session"
        ]]])
    }
    var commands: [[String: Any]] { sent.compactMap { $0["command"] as? [String: Any] } }
    var lastSync: [String: Any]? { commands.last { $0["type"] as? String == "session.sync" } }
    func snapshot(text: String) async throws {
        let sync = try #require(lastSync)
        let cursor: [String: Any] = ["leafId": "shared-entry"]
        let message: [String: Any] = ["messageId": "shared-message", "role": "assistant", "timestamp": 100,
            "content": [["type": "text", "text": text]]]
        let event: [String: Any] = ["type": "session.snapshot", "sessionId": "shared-session", "syncId": sync["syncId"]!, "mode": "replace",
            "source": ["epoch": "shared-epoch", "seq": 1, "ready": true],
            "entries": [["entryId": "shared-entry", "type": "message", "timestamp": "2026-10-29T00:00:00Z"]],
            "display": ["projectionVersion": 3, "entries": [["entryId": "shared-entry", "message": message]]],
            "cursor": cursor, "checkpoint": ["checkpointId": "shared-checkpoint", "head": cursor, "headCompleteness": "complete", "inventoryComplete": true],
            "rangeStatus": "complete", "live": ["complete": true, "messages": []]]
        await emit(["type": "runtime.event", "runtimeId": "shared-runtime", "sequence": 1, "event": event], channel: "msg")
    }
}

@MainActor
private final class MultiHostFixture {
    let suite = "orbis-multi-host-" + UUID().uuidString
    let root: URL
    let preferences: UserDefaults
    let secure: MultiHostSecureStore
    let transports: [String: MultiHostTransport]
    let store: OrbisStore
    init() throws {
        preferences = try #require(UserDefaults(suiteName: suite))
        root = FileManager.default.temporaryDirectory.appendingPathComponent(suite)
        secure = MultiHostSecureStore((1...2).map { number in
            HostPairing(hostId: "host-\(number)", hostName: "Host \(number)", hostPub: "public-\(number)",
                pskRoot: Base64URL.encode(Data(repeating: UInt8(number), count: 32)),
                relay: RelayCredential(relayUrl: "wss://relay.example", deviceId: "shared-device", credential: "test-\(number)"), lan: [])
        })
        let routes = ["host-1": MultiHostTransport(), "host-2": MultiHostTransport()]
        transports = routes
        store = OrbisStore(secure: secure, preferences: preferences, transferRoot: root, transportFactory: { routes[$0.hostId]! })
        for transport in routes.values { transport.drain = { [weak store] in await store?.waitForPendingEvents() } }
    }
    func ready() async { for id in ["host-1", "host-2"] { await transports[id]!.ready() } }
    func cleanup() {
        for host in store.hosts { host.connection.shutdown() }
        preferences.removePersistentDomain(forName: suite)
        try? FileManager.default.removeItem(at: root)
    }
}

@Suite("Independent always-on Hosts") @MainActor
struct MultiHostTests {
    @Test func closingSelectedRuntimesUsesTheirHostWithoutChangingTheActiveChat() async throws {
        let fixture = try MultiHostFixture(); defer { fixture.cleanup() }
        await fixture.ready()
        let first = try #require(fixture.transports["host-1"])
        let second = try #require(fixture.transports["host-2"])
        await first.emit(["type": "runtime.online", "runtime": [
            "runtimeId": "other-runtime", "name": "Other", "cwd": "/other", "status": "running", "sessionId": "other-session"
        ]])
        for id in ["shared-runtime", "other-runtime"] {
            await first.emit(["type": "runtime.event", "runtimeId": id, "sequence": 2, "event": [
                "type": "runtime.capabilities", "capabilities": ["commands": [["name": "quit", "source": "builtin"]]]
            ]])
        }
        fixture.store.selectRuntime(hostId: "host-2", runtimeId: "shared-runtime")
        let ids: Set<String> = ["shared-runtime", "other-runtime"]
        #expect(fixture.store.closeRuntimes(hostId: "host-1", runtimeIds: ids) == ids)
        let requests = first.sent.filter { ($0["command"] as? [String: Any])?["name"] as? String == "quit" }
        #expect(Set(requests.compactMap { $0["runtimeId"] as? String }) == ids)
        #expect(requests.allSatisfy { ($0["command"] as? [String: Any])?["type"] as? String == "slash.execute" })
        #expect(second.commands.allSatisfy { $0["name"] as? String != "quit" })
        #expect(fixture.store.selectedHostId == "host-2")
        #expect(fixture.store.selectedRuntimeId == "shared-runtime")
        #expect(fixture.store.closeRuntimes(hostId: "host-2", runtimeIds: ["shared-runtime"]).isEmpty)
        first.state?(.offline, nil)
        #expect(fixture.store.closeRuntimes(hostId: "host-1", runtimeIds: ids).isEmpty)
        #expect(first.sent.filter { ($0["command"] as? [String: Any])?["name"] as? String == "quit" }.count == 2)
    }
    @Test func identicalRuntimeAndSessionIDsKeepMessagesStateAndCommandsIsolated() async throws {
        let fixture = try MultiHostFixture(); defer { fixture.cleanup() }
        await fixture.ready()
        let first = try #require(fixture.transports["host-1"])
        let second = try #require(fixture.transports["host-2"])
        try await first.snapshot(text: "History from first Host")
        try await second.snapshot(text: "History from second Host")
        let store = fixture.store
        #expect(store.connection(for: "host-1")?.messages.map(\.text) == ["History from first Host"])
        #expect(store.connection(for: "host-2")?.messages.map(\.text) == ["History from second Host"])
        await second.emit(["type": "runtime.event", "runtimeId": "shared-runtime", "sequence": 2,
            "event": ["type": "runtime.status", "status": "running"]])
        #expect(store.connection(for: "host-1")?.runtimes.first?.status == "idle")
        #expect(store.connection(for: "host-2")?.runtimes.first?.status == "running")
        store.selectRuntime(hostId: "host-1", runtimeId: "shared-runtime")
        #expect(store.sendMessage("To first Host"))
        store.selectRuntime(hostId: "host-2", runtimeId: "shared-runtime")
        #expect(store.sendMessage("To second Host", delivery: "followUp"))
        #expect(first.commands.filter { $0["type"] as? String == "user_message" }.compactMap { $0["text"] as? String } == ["To first Host"])
        #expect(second.commands.filter { $0["type"] as? String == "user_message" }.compactMap { $0["text"] as? String } == ["To second Host"])
        #expect(store.messages.map(\.text) == ["History from second Host"])
    }

    @Test func selectingHostPreservesBothAuthenticatedConnections() async throws {
        let fixture = try MultiHostFixture(); defer { fixture.cleanup() }
        await fixture.ready()
        let initial = fixture.transports.mapValues { ($0.connectCount, $0.disconnectCount) }
        for id in ["host-2", "host-1", "host-2", "host-1"] { fixture.store.selectHost(id) }
        fixture.store.selectRuntime(hostId: "host-2", runtimeId: "shared-runtime")
        for id in ["host-1", "host-2"] {
            let transport = try #require(fixture.transports[id])
            #expect(transport.connectCount == initial[id]?.0)
            #expect(transport.disconnectCount == initial[id]?.1)
            #expect(fixture.store.connection(for: id)?.connection == .secured)
        }
    }

    @Test func draftAndAliasWritesMergeFreshPreferencesAcrossHosts() async throws {
        let fixture = try MultiHostFixture(); defer { fixture.cleanup() }
        await fixture.ready()
        let store = fixture.store
        let first = try #require(store.connection(for: "host-1"))
        let second = try #require(store.connection(for: "host-2"))
        let runtime = try #require(first.runtimes.first)
        first.saveDraft("First draft", for: runtime); first.setAlias("First alias", for: runtime)
        second.saveDraft("Second draft", for: runtime); second.setAlias("Second alias", for: runtime)
        first.saveDraft("First draft revised", for: runtime); first.setAlias("First alias revised", for: runtime)
        let drafts = fixture.preferences.dictionary(forKey: "orbis.sessionDrafts") as? [String: String]
        let aliases = fixture.preferences.dictionary(forKey: "orbis.sessionAliases") as? [String: String]
        for (host, expectedDraft, expectedAlias) in [(fixture.secure.hosts[0], "First draft revised", "First alias revised"), (fixture.secure.hosts[1], "Second draft", "Second alias")] {
            #expect(drafts?[localSessionKey(host: host, runtime: runtime)] == expectedDraft)
            #expect(aliases?[localSessionKey(host: host, runtime: runtime)] == expectedAlias)
            #expect(aliases?[offlineAliasKey(host: host, sessionId: "shared-session")] == expectedAlias)
        }
        #expect(first.draft(for: runtime) == "First draft revised")
        #expect(second.draft(for: runtime) == "Second draft")
    }

    @Test func unpairRemovesOnlyOwningHostDataAndConnection() async throws {
        let fixture = try MultiHostFixture(); defer { fixture.cleanup() }
        await fixture.ready()
        let first = try #require(fixture.store.connection(for: "host-1"))
        let second = try #require(fixture.store.connection(for: "host-2"))
        let runtime = try #require(first.runtimes.first)
        let removed = fixture.secure.hosts[0]
        let surviving = fixture.secure.hosts[1]
        let requestData = try JSONSerialization.data(withJSONObject: ["runtimeId": "shared-runtime", "requestId": "input", "extensionId": "test", "kind": "input", "title": "Input", "expiresAt": 9_999_999_999_999])
        let request = try JSONDecoder().decode(InteractionRequest.self, from: requestData)
        let interactionDrafts = InteractionDraftCache(preferences: fixture.preferences)
        let removedDraftKey = interactionDraftKey(host: removed, sessionId: "shared-session", request: request)
        let survivingDraftKey = interactionDraftKey(host: surviving, sessionId: "shared-session", request: request)
        interactionDrafts.save(InteractionDraftValue(input: "Remove interaction"), for: removedDraftKey, request: request)
        interactionDrafts.save(InteractionDraftValue(input: "Keep interaction"), for: survivingDraftKey, request: request)
        try await fixture.transports["host-1"]!.snapshot(text: "Remove this history")
        try await fixture.transports["host-2"]!.snapshot(text: "Keep this history")
        first.saveDraft("Remove me", for: runtime); first.setAlias("Remove me", for: runtime)
        second.saveDraft("Keep me", for: runtime); second.setAlias("Keep me", for: runtime)
        let disconnects = fixture.transports.mapValues(\.disconnectCount)
        fixture.store.selectHost("host-1")
        fixture.store.unpair(hostId: "host-1")
        await fixture.store.waitForPendingEvents()
        #expect(fixture.secure.hosts.map(\.hostId) == ["host-2"])
        #expect(fixture.store.hosts.map(\.hostId) == ["host-2"])
        #expect(fixture.store.connection(for: "host-1") == nil)
        #expect(fixture.store.selectedHostId == "host-2")
        #expect(second.connection == .secured)
        #expect(fixture.transports["host-1"]!.disconnectCount == disconnects["host-1"]! + 1)
        #expect(fixture.transports["host-2"]!.disconnectCount == disconnects["host-2"])
        let drafts = fixture.preferences.dictionary(forKey: "orbis.sessionDrafts") as? [String: String] ?? [:]
        let aliases = fixture.preferences.dictionary(forKey: "orbis.sessionAliases") as? [String: String] ?? [:]
        #expect(!drafts.keys.contains { $0.hasPrefix(hostKeyPrefix(removed)) })
        #expect(!aliases.keys.contains { $0.hasPrefix(hostKeyPrefix(removed)) })
        #expect(drafts[localSessionKey(host: surviving, runtime: runtime)] == "Keep me")
        #expect(aliases[localSessionKey(host: surviving, runtime: runtime)] == "Keep me")
        #expect(second.draft(for: runtime) == "Keep me")
        let restoredInteractions = InteractionDraftCache(preferences: fixture.preferences)
        #expect(restoredInteractions.value(for: removedDraftKey, request: request).input.isEmpty)
        #expect(restoredInteractions.value(for: survivingDraftKey, request: request).input == "Keep interaction")
        #expect(try await second.historyWorker.listCachedSessions(host: removed).isEmpty)
        #expect(try await second.historyWorker.page(host: surviving, sessionId: "shared-session").messages.map(\.text) == ["Keep this history"])
        #expect(fixture.store.sendMessage("Still connected"))
    }

    @Test func learnedLANEndpointsPersistForTheirOwnHost() async throws {
        let fixture = try MultiHostFixture(); defer { fixture.cleanup() }
        await fixture.ready()
        let firstEndpoints = [LANEndpoint(host: "192.168.1.21", port: 24021)]
        let secondEndpoints = [LANEndpoint(host: "192.168.1.22", port: 24022)]
        // Host two is in the background when Host one publishes its new route.
        fixture.store.selectHost("host-2")
        await fixture.transports["host-1"]!.emit(["type": "_transport.lan", "endpoints": firstEndpoints])
        await fixture.transports["host-2"]!.emit(["type": "_transport.lan", "endpoints": secondEndpoints])
        #expect(fixture.secure.hosts.first { $0.hostId == "host-1" }?.lan == firstEndpoints)
        #expect(fixture.secure.hosts.first { $0.hostId == "host-2" }?.lan == secondEndpoints)
        #expect(fixture.store.connection(for: "host-1")?.selectedHost?.lan == firstEndpoints)
        #expect(fixture.store.connection(for: "host-2")?.selectedHost?.lan == secondEndpoints)
        #expect(fixture.store.hosts.first { $0.hostId == "host-1" }?.pairing.lan == firstEndpoints)
        let restored = OrbisStore(secure: fixture.secure, autoConnect: false, preferences: nil,
            transferRoot: fixture.root.appendingPathComponent("Restored"), transportFactory: { _ in MultiHostTransport() })
        #expect(restored.hosts.first { $0.hostId == "host-1" }?.pairing.lan == firstEndpoints)
        #expect(restored.hosts.first { $0.hostId == "host-2" }?.pairing.lan == secondEndpoints)
        for host in restored.hosts { host.connection.shutdown() }
    }
}
