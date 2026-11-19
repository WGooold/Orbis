import Foundation
import Combine
import Testing
@testable import OrbisCore

private final class MultiHostSecureStore: SecureStorage {
    var hosts: [HostPairing]
    var rejectsSave = false
    init(_ hosts: [HostPairing]) { self.hosts = hosts }
    func deviceIdentity() throws -> DeviceIdentity { .generate() }
    func savePairings(_ pairings: [HostPairing]) throws { if rejectsSave { throw NSError(domain: "SecureStorage", code: 1, userInfo: [NSLocalizedDescriptionKey: "storage unavailable"]) }; hosts = pairings }
    func pairings() -> [HostPairing] { hosts }
}

@MainActor
private final class MultiHostTransport: OrbisTransport {
    var relayTransportKind: RelayTransportKind?
    var relayTransportMode: RelayTransportMode = .auto
    var sent: [[String: Any]] = []
    var binary: [Data] = []
    var allowsExternalImports = true
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
    func sendBinary(_ data: Data) -> Bool { binary.append(data); return true }
    func emit(_ object: [String: Any], channel: String = "ctl") async { receive?(object, channel); await drain?() }
    func ready(imports: Bool = false, status: String = "idle") async {
        await emit(["type": "device.ready", "protocolVersion": orbisProtocolVersion,
                    "hostFeatures": imports ? ["external-import.target-v1"] : [], "runtimes": [[
            "runtimeId": "shared-runtime", "name": "Shared runtime", "cwd": "/repo", "status": status, "sessionId": "shared-session"
        ]]])
    }
    func awaitWire(_ predicate: ([String: Any]) -> Bool) async throws -> [String: Any] {
        for _ in 0..<100 {
            if let frame = sent.first(where: predicate) { return frame }
            try await Task.sleep(for: .milliseconds(10))
        }
        let frame = sent.first(where: predicate)
        return try #require(frame)
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
    // IMPORT-06: target selection stays scoped to authenticated pairing / session / project.
    // Opening the picker or revalidating a row must not send anything to either Host.
    @Test func externalImportDestinationIsNotRetargetedBySelectionOrReconnect() async throws {
        let fixture = try MultiHostFixture(); defer { fixture.cleanup() }
        await fixture.ready()
        let first = try #require(fixture.store.connection(for: "host-1"))
        let second = try #require(fixture.store.connection(for: "host-2"))
        let transport = try #require(fixture.transports["host-1"])
        let otherTransport = try #require(fixture.transports["host-2"])
        let offered = try #require(first.externalImportDestinations().first)
        fixture.store.selectHost("host-2")
        let baseline = (transport.sent.count, otherTransport.sent.count)
        #expect(first.externalImportRuntime(offered.target)?.sessionId == "shared-session")
        #expect(second.externalImportRuntime(offered.target) == nil)
        let wrongProject = ExternalImportTarget(hostId: "host-1", pairingKey: offered.target.pairingKey,
            sessionId: "shared-session", cwd: "/different")
        #expect(first.externalImportRuntime(wrongProject) == nil)
        let oldPairing = ExternalImportTarget(hostId: "host-1", pairingKey: "old-pairing",
            sessionId: "shared-session", cwd: "/repo")
        #expect(first.externalImportRuntime(oldPairing) == nil)
        #expect(transport.sent.count == baseline.0 && otherTransport.sent.count == baseline.1)
        transport.state?(.offline, nil)
        #expect(first.externalImportRuntime(offered.target) == nil)
    }

    // IMPORT-06: no legacy fallback, no early command, exact upload verification,
    // and a read-only recovery after the original command loses its connection.
    @Test func externalImportSendsOnlyAfterVerifiedUploadAndRecoversWithoutReplay() async throws {
        let fixture = try MultiHostFixture(); defer { fixture.cleanup() }
        await fixture.ready()
        let first = try #require(fixture.store.connection(for: "host-1"))
        let transport = try #require(fixture.transports["host-1"])
        let other = try #require(fixture.transports["host-2"])
        let destination = try #require(first.externalImportDestinations().first)
        let inbox = ExternalImportStore(root: fixture.root.appendingPathComponent("inbox"))
        let stage = try inbox.begin(); defer { inbox.discard(stage) }
        let bytes = Data([31, 26, 80, 1])
        let source = fixture.root.appendingPathComponent("from-provider.pdf")
        try bytes.write(to: source)
        let file = try inbox.copy(source, into: stage, index: 0, used: 0)
        let batch = try inbox.assign(inbox.publish(stage, text: "/not-a-command", files: [file]).id, to: destination)
        fixture.store.selectHost("host-2")
        let otherBaseline = other.sent.count
        await #expect(throws: ExternalImportProblem.hostUpgrade) { try await first.sendExternalImport(batch, from: inbox, instruction: "") }
        #expect(try inbox.list() == [batch])
        #expect(!transport.sent.contains { $0["type"] as? String == "file.upload.init" })
        await transport.ready(imports: true, status: "running")
        transport.allowsExternalImports = false
        await #expect(throws: ExternalImportProblem.hostUpgrade) { try await first.sendExternalImport(batch, from: inbox, instruction: "") }
        transport.allowsExternalImports = true
        let delivery = Task { try await first.sendExternalImport(batch, from: inbox, instruction: "") }
        let initFrame = try await transport.awaitWire { $0["type"] as? String == "file.upload.init" }
        #expect((initFrame["importTarget"] as? [String: String])?["sessionId"] == destination.target.sessionId)
        #expect(initFrame["fileName"] as? String == "from-provider.pdf")
        #expect(try inbox.list() == [batch])
        #expect(!transport.commands.contains { $0["type"] as? String == "user_message" })
        await transport.emit(["type": "file.upload.ready", "requestId": try #require(initFrame["requestId"]), "uploadId": "upload-1", "receivedBytes": 0])
        await transport.emit(["type": "file.upload.read", "uploadId": "upload-1", "offset": 0, "length": bytes.count])
        #expect(try ArtifactChunk.decode(#require(transport.binary.last)).bytes == bytes)
        #expect(!transport.commands.contains { $0["type"] as? String == "user_message" })
        await transport.emit(["type": "file.upload.finished", "uploadId": "upload-1", "sha256": try #require(initFrame["sha256"]),
                              "size": bytes.count, "path": "/repo/.orbis-uploads/from-provider.pdf"])
        let sent = try await transport.awaitWire { ($0["command"] as? [String: Any])?["type"] as? String == "user_message" }
        let command = try #require(sent["command"] as? [String: Any])
        let attempt = try #require(inbox.list().first?.attempt)
        #expect(attempt.receipt == .pending)
        #expect(sent["commandId"] as? String == attempt.id.uuidString)
        #expect(command["messageId"] as? String == attempt.id.uuidString)
        #expect(command["delivery"] as? String == "followUp")
        #expect((command["text"] as? String)?.hasSuffix("\n\n/not-a-command") == true)
        #expect(command["attachments"] as? [String] == ["/repo/.orbis-uploads/from-provider.pdf"])
        transport.state?(.offline, nil)
        try await delivery.value
        let waiting = try #require(inbox.list().first)
        #expect(waiting.attempt?.receipt == .unconfirmed)
        await transport.ready()
        await #expect(throws: ExternalImportProblem.targetUnavailable) { try await first.checkExternalImport(waiting, in: inbox) }
        await transport.ready(imports: true)
        let query = Task { try await first.checkExternalImport(waiting, in: inbox) }
        let read = try await transport.awaitWire { $0["type"] as? String == "external-import.result.read" }
        #expect(read["commandId"] as? String == attempt.id.uuidString)
        await transport.emit(["type": "external-import.result", "commandId": attempt.id.uuidString, "runtimeId": attempt.runtimeId,
                              "importTarget": ["sessionId": destination.target.sessionId, "cwd": destination.target.cwd], "status": "accepted"])
        try await query.value
        #expect(try inbox.list().first?.attempt?.receipt == .accepted)
        #expect(transport.commands.filter { $0["type"] as? String == "user_message" }.count == 1)
        #expect(other.sent.count == otherBaseline)
    }

    // IMPORT-07: only the original ready launch can bind the first message, even after a lost reply.
    @Test func externalImportLaunchDoesNotCreateAgainAfterReconnect() async throws {
        let fixture = try MultiHostFixture(); defer { fixture.cleanup() }
        await fixture.ready()
        let connection = try #require(fixture.store.connection(for: "host-1"))
        let transport = try #require(fixture.transports["host-1"])
        let inbox = ExternalImportStore(root: fixture.root.appendingPathComponent("inbox"))
        let stage = try inbox.begin(); defer { inbox.discard(stage) }
        let batch = try inbox.publish(stage, text: "first message", files: [])
        let cwd = "/repo"
        let old = ["runtimeId": "shared-runtime", "name": "Existing", "cwd": cwd, "status": "idle", "sessionId": "old-session", "agentKind": "pi"]
        let new = ["runtimeId": "new-runtime", "name": "New", "cwd": cwd, "status": "idle", "sessionId": "new-session", "agentKind": "pi"]
        func ready(_ runtimes: [[String: String]]) async {
            await transport.emit(["type": "device.ready", "protocolVersion": orbisProtocolVersion,
                "hostFeatures": ["external-import.target-v1"], "sessionConfiguration": 1, "agents": ["pi"], "runtimes": runtimes])
        }
        await ready([old])
        connection.loadSessionConfiguration(agent: "pi", cwd: cwd)
        let config = try await transport.awaitWire { $0["type"] as? String == "session.configuration.read" }
        await transport.emit(["type": "session.configuration.result", "requestId": try #require(config["requestId"]), "agentKind": "pi", "cwd": cwd,
            "binding": "configuration", "revision": 1, "values": [:], "catalog": ["binding": "configuration", "defaults": [:], "models": [], "permissions": []]])
        let creating = Task { try await connection.launchExternalImport(batch, from: inbox, agent: "pi", cwd: cwd, instruction: "") }
        let create = try await transport.awaitWire { $0["type"] as? String == "session.launch" }
        let launch = try #require(inbox.list().first?.launch)
        #expect(create["launchId"] as? String == launch.id)
        await transport.emit(["type": "runtime.online", "runtime": new])
        #expect(try inbox.list().first?.destination == nil)
        #expect(!transport.commands.contains { $0["type"] as? String == "user_message" })
        transport.state?(.offline, nil)
        try await creating.value
        await ready([old, new])
        let saved = try #require(inbox.list().first)
        let recovering = Task { try await connection.recoverExternalLaunch(saved, in: inbox) }
        let read = try await transport.awaitWire { $0["type"] as? String == "session.launch.read" }
        #expect(read["launchId"] as? String == launch.id)
        await transport.emit(["type": "session.launch.result", "requestId": try #require(read["requestId"]), "launchId": launch.id,
            "phase": "ready", "agentKind": "pi", "cwd": cwd, "sessionId": "new-session"])
        let sent = try await transport.awaitWire { ($0["command"] as? [String: Any])?["type"] as? String == "user_message" }
        #expect(sent["runtimeId"] as? String == "new-runtime")
        #expect((sent["importTarget"] as? [String: String])?["sessionId"] == "new-session")
        #expect(transport.sent.filter { $0["type"] as? String == "session.launch" }.count == 1)
        await transport.emit(["type": "runtime.event", "runtimeId": "new-runtime", "event": ["type": "command.result",
            "commandId": try #require(sent["commandId"]), "status": "success", "ok": true]])
        try await recovering.value
        #expect(try inbox.list().first?.attempt?.receipt == .accepted)
    }

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
    // SC92/SC93: an inactive Host keeps confirmed connection conditions without accumulating transient feedback.
    @Test func backgroundHostConditionsSurviveSelectionUntilTheyActuallyResolve() async throws {
        let fixture = try MultiHostFixture(); defer { fixture.cleanup() }
        await fixture.ready()
        let store = fixture.store
        let other = try #require(store.connection(for: "host-2"))
        let transport = try #require(fixture.transports["host-2"])
        await transport.emit(["type": "protocol.error", "code": "unauthorized", "message": "denied"])
        other.presentFeedback(.toast, "background", key: "background-result")
        #expect(store.feedback.banner == nil)
        store.selectHost("host-2")
        #expect(store.feedback.banner?.action == .pair)
        #expect(store.feedback.toast == nil)
        store.dismissFeedbackBanner()
        store.selectHost("host-1"); store.selectHost("host-2")
        #expect(store.feedback.banner == nil)
        transport.state?(.secured, nil)
        await transport.emit(["type": "protocol.error", "code": "unauthorized", "message": "denied"])
        #expect(store.feedback.banner?.action == .pair)
    }

    // SC94: a failed unpair retains its object and its local record after the confirmation's drawer closes.
    @Test func failedUnpairRetainsTheComputerAndItsInlineManagementError() async throws {
        let fixture = try MultiHostFixture(); defer { fixture.cleanup() }
        await fixture.ready()
        fixture.secure.rejectsSave = true
        fixture.store.unpair(hostId: "host-1")
        #expect(fixture.store.pairings.count == 2)
        #expect(fixture.store.pairingError == "storage unavailable")
        #expect(fixture.store.feedback.toast?.text == "storage unavailable")
        #expect(fixture.store.errorMessage == nil)
    }

}
