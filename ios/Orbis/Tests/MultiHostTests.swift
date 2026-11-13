import Foundation
import Combine
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
    var relayTransportKind: RelayTransportKind?
    var relayTransportMode: RelayTransportMode = .auto
    var sent: [[String: Any]] = []
    var connectCount = 0
    var disconnectCount = 0
    var receive: (([String: Any], String?) -> Void)?
    var state: ((ConnectionState, String?) -> Void)?
    var drain: (() async -> Void)?
    func setRelayTransportMode(_ mode: RelayTransportMode) { relayTransportMode = mode }
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
    var lastHistoryInterest: [String: Any]? { sent.last { $0["type"] as? String == "session.history.interest" } }
    func enableHistoryWindow() async throws {
        let request = try #require(sent.last { $0["type"] as? String == "session.history.capabilities.request" })
        await emit(["type": "session.history.capabilities", "requestId": request["requestId"]!, "format": "v1", "maxPageBytes": 65536])
    }
    func acceptHistoryInterest(_ request: [String: Any]) async throws {
        let id = try #require(request["requestId"])
        await emit(["type": "session.history.interest.result", "requestId": id, "accepted": true])
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
    // S29 / SC49: all three modes are saved per Host; policy changes retain the live adapter.
    @Test func relayTransportModeIsSavedPerSelectedHostWithoutReplacingTheActiveLink() async throws {
        let fixture = try MultiHostFixture(); defer { fixture.cleanup() }
        let first = try #require(fixture.transports["host-1"])
        let second = try #require(fixture.transports["host-2"])
        first.relayTransportKind = .ws; second.relayTransportKind = .quic
        first.state?(.secured, nil); second.state?(.secured, nil)
        fixture.store.setRelayTransportMode(.quic)
        #expect(first.relayTransportMode == .quic)
        #expect(second.relayTransportMode == .auto)
        #expect(fixture.store.relayTransportKind == .ws)
        fixture.store.setRelayTransportMode(.auto)
        #expect(first.relayTransportMode == .auto)
        fixture.store.selectHost("host-2")
        fixture.store.setRelayTransportMode(.quic)
        #expect(second.relayTransportMode == .quic)
        #expect(first.relayTransportMode == .auto)
        #expect(fixture.store.relayTransportKind == .quic)
    }

    // S28 / SC48: the status page must use the selected Host's live adapter, including a later switch.
    @Test func connectionProtocolUsesTheSelectedHostsActualAdapter() async throws {
        let fixture = try MultiHostFixture(); defer { fixture.cleanup() }
        let first = try #require(fixture.transports["host-1"])
        let second = try #require(fixture.transports["host-2"])
        first.relayTransportKind = .ws; second.relayTransportKind = .quic
        first.state?(.secured, nil); second.state?(.secured, nil)
        #expect(fixture.store.relayTransportKind == .ws)
        fixture.store.selectHost("host-2")
        #expect(fixture.store.relayTransportKind == .quic)
        second.relayTransportKind = .ws
        second.state?(.secured, nil)
        #expect(fixture.store.relayTransportKind == .ws)
    }

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

    // FT-G12-RESUME-01: chat navigation stays mounted across Host switches.
    // The UI-owned visibility follows A→B→A and supersedes each old ACK owner.
    @Test func visibleHistoryInterestFollowsSelectedHostAndRejectsLateAcknowledgements() async throws {
        let fixture = try MultiHostFixture(); defer { fixture.cleanup() }
        await fixture.ready()
        let first = try #require(fixture.transports["host-1"]), second = try #require(fixture.transports["host-2"])
        try await first.snapshot(text: "First"); try await second.snapshot(text: "Second")
        try await first.enableHistoryWindow(); try await second.enableHistoryWindow()
        fixture.store.setHistoryWindowVisible(true)
        let initial = try #require(first.lastHistoryInterest)
        fixture.store.selectHost("host-2")
        let switched = try #require(second.lastHistoryInterest)
        #expect(first.lastHistoryInterest?["runtimeId"] is NSNull)
        #expect(switched["runtimeId"] as? String == "shared-runtime")
        let firstReads = first.commands.count, secondReads = second.commands.count
        try await first.acceptHistoryInterest(initial)
        #expect(first.commands.count == firstReads)
        try await second.acceptHistoryInterest(switched)
        #expect(second.commands.count == secondReads + 1)
        fixture.store.selectHost("host-1")
        let returned = try #require(first.lastHistoryInterest)
        #expect(second.lastHistoryInterest?["runtimeId"] is NSNull)
        #expect(returned["requestId"] as? String != initial["requestId"] as? String)
        try await first.acceptHistoryInterest(initial)
        #expect(first.commands.count == firstReads)
        try await first.acceptHistoryInterest(returned)
        #expect(first.commands.count == firstReads + 1)
        fixture.store.selectHost("host-1")
        try await first.acceptHistoryInterest(returned)
        #expect(first.commands.count == firstReads + 1)
    }

    // ContentView publishes false both off-chat and while the scene is inactive.
    // Switching or unpairing in either state must keep every source window shut.
    @Test func hiddenHistoryInterestStaysClosedAcrossHostSwitchAndUnpair() async throws {
        let fixture = try MultiHostFixture(); defer { fixture.cleanup() }
        await fixture.ready()
        let first = try #require(fixture.transports["host-1"]), second = try #require(fixture.transports["host-2"])
        try await first.enableHistoryWindow(); try await second.enableHistoryWindow()
        fixture.store.selectHost("host-2")
        #expect(first.lastHistoryInterest?["runtimeId"] is NSNull)
        #expect(second.lastHistoryInterest?["runtimeId"] is NSNull)
        fixture.store.setHistoryWindowVisible(true)
        let opened = try #require(second.lastHistoryInterest)
        fixture.store.setHistoryWindowVisible(false)
        fixture.store.selectHost("host-1")
        let before = second.commands.count
        try await second.acceptHistoryInterest(opened)
        #expect(second.commands.count == before)
        fixture.store.unpair(hostId: "host-1")
        await fixture.store.waitForPendingEvents()
        #expect(fixture.store.selectedHostId == "host-2")
        #expect(second.lastHistoryInterest?["runtimeId"] is NSNull)
    }

    // Removing the active Host keeps a visible chat subscribed on its surviving
    // Host; having no selected runtime must remain a closed, legal interest.
    @Test func visibleHistoryTransfersAfterUnpairAndWaitsForARuntime() async throws {
        let fixture = try MultiHostFixture(); defer { fixture.cleanup() }
        let first = try #require(fixture.transports["host-1"]), second = try #require(fixture.transports["host-2"])
        await first.ready()
        await second.emit(["type": "device.ready", "protocolVersion": orbisProtocolVersion, "runtimes": []])
        try await first.enableHistoryWindow(); try await second.enableHistoryWindow()
        fixture.store.setHistoryWindowVisible(true)
        fixture.store.unpair(hostId: "host-1")
        await fixture.store.waitForPendingEvents()
        #expect(fixture.store.selectedHostId == "host-2")
        #expect(fixture.store.selectedRuntimeId == nil)
        #expect(second.lastHistoryInterest?["runtimeId"] is NSNull)
        await second.emit(["type": "runtime.online", "runtime": [
            "runtimeId": "shared-runtime", "name": "Shared runtime", "cwd": "/repo", "status": "idle", "sessionId": "shared-session"
        ]])
        #expect(second.lastHistoryInterest?["runtimeId"] as? String == "shared-runtime")
    }

    @Test func draftWritesMergeFreshPreferencesAcrossHosts() async throws {
        let fixture = try MultiHostFixture(); defer { fixture.cleanup() }
        await fixture.ready()
        let store = fixture.store
        let first = try #require(store.connection(for: "host-1"))
        let second = try #require(store.connection(for: "host-2"))
        let runtime = try #require(first.runtimes.first)
        first.saveDraft("First draft", for: runtime)
        second.saveDraft("Second draft", for: runtime)
        first.saveDraft("First draft revised", for: runtime)
        let drafts = fixture.preferences.dictionary(forKey: "orbis.sessionDrafts") as? [String: String]
        for (host, expectedDraft) in [(fixture.secure.hosts[0], "First draft revised"), (fixture.secure.hosts[1], "Second draft")] {
            #expect(drafts?[localSessionKey(host: host, runtime: runtime)] == expectedDraft)
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
        first.saveDraft("Remove me", for: runtime)
        second.saveDraft("Keep me", for: runtime)
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
        #expect(!drafts.keys.contains { $0.hasPrefix(hostKeyPrefix(removed)) })
        #expect(drafts[localSessionKey(host: surviving, runtime: runtime)] == "Keep me")
        #expect(second.draft(for: runtime) == "Keep me")
        let restoredInteractions = InteractionDraftCache(preferences: fixture.preferences)
        #expect(restoredInteractions.value(for: removedDraftKey, request: request).input.isEmpty)
        #expect(restoredInteractions.value(for: survivingDraftKey, request: request).input == "Keep interaction")
        #expect(try await second.historyWorker.listCachedSessions(host: removed).isEmpty)
        #expect(try await second.historyWorker.page(host: surviving, sessionId: "shared-session").messages.map(\.text) == ["Keep this history"])
        #expect(fixture.store.sendMessage("Still connected"))
    }

    // Real contiguous source patches on a background Host must not repaint the selected UI.
    // Switching still exposes its newest transcript; menu connection changes remain observable.
    @Test func backgroundBodyUpdatesStayScopedAndSwitchKeepsLatestFacts() async throws {
        let fixture = try MultiHostFixture(); defer { fixture.cleanup() }
        await fixture.ready()
        let second = try #require(fixture.transports["host-2"])
        try await second.snapshot(text: "Initial history")
        fixture.store.selectHost("host-1")
        await fixture.store.waitForPendingEvents()
        let home = fixture.store.homeUpdates.revision, directory = fixture.store.directoryUpdates.revision
        var publications = 0
        let observation = fixture.store.objectWillChange.sink { publications += 1 }
        defer { observation.cancel() }
        for sequence in 2...5 {
            let head: [String: Any] = ["leafId": "shared-entry"]
            let event: [String: Any] = ["type": "session.patch", "sessionId": "shared-session", "baseSeq": sequence - 1, "seq": sequence,
                "source": ["epoch": "shared-epoch", "seq": sequence, "ready": true], "head": head, "cursor": head,
                "headCompleteness": "complete", "entries": [], "live": ["complete": true, "messages": [["message": [
                    "messageId": "live", "role": "assistant", "timestamp": 101,
                    "content": [["type": "text", "text": "Chunk \(sequence)"]]], "finished": false, "order": 2]]]]
            await second.emit(["type": "runtime.event", "runtimeId": "shared-runtime", "sequence": sequence, "event": event], channel: "msg")
        }
        await fixture.store.waitForPendingEvents()
        #expect(fixture.store.connection(for: "host-2")?.messages.last?.text == "Chunk 5")
        #expect(publications == 0)
        #expect(fixture.store.homeUpdates.revision == home)
        #expect(fixture.store.directoryUpdates.revision == directory)
        second.state?(.offline, nil)
        await fixture.store.waitForPendingEvents()
        #expect(publications > 0)
        #expect(fixture.store.homeUpdates.revision > home)
        fixture.store.selectHost("host-2")
        #expect(fixture.store.messages.last?.text == "Chunk 5")
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
