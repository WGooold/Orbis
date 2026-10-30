import Foundation
import Testing
@testable import OrbisCore

@Suite("Home session loading") @MainActor
struct HomeRuntimeLoadingTests {
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
        func ready(_ runtimes: [[String: Any]]) async {
            await emit(["type": "device.ready", "runtimes": runtimes, "modelEpoch": "epoch"])
        }
        func event(_ event: [String: Any]) async {
            await emit(["type": "runtime.event", "runtimeId": "a", "sequence": 1, "event": event])
        }
    }

    private func runtime(_ id: String = "a", session: String? = nil) -> [String: Any] {
        ["runtimeId": id, "sessionId": session ?? "session-" + id, "name": "Agent", "cwd": "", "status": "unknown"]
    }

    private func setup() -> (OrbisStore, Transport) {
        let transport = Transport()
        let store = OrbisStore(secure: Storage(), transport: transport, preferences: nil)
        transport.drain = { [weak store] in await store?.waitForPendingEvents() }
        return (store, transport)
    }

    private func loadFacts(_ transport: Transport, id: String = "a", names: [String] = AgentState.domainNames,
                           phase: String = "running", title: String? = nil, epoch: String = "epoch",
                           revision: Int = 1, availability: String = "ready") async throws {
        let request = try #require(transport.sent.last {
            $0["type"] as? String == "agent.state.request" && $0["runtimeId"] as? String == id
        })
        let session = try #require(request["sessionId"] as? String)
        let domains: [[String: Any]] = names.map { name in
            let value: Any
            switch name {
            case "identity": value = ["runtimeId": id, "sessionId": session, "name": "Claude Code",
                "cwd": "/repo", "sessionName": title ?? "Verified " + id, "agentKind": "claude"]
            case "execution": value = ["phase": phase]
            case "interactions": value = [String: Any]()
            default: value = NSNull()
            }
            return ["domain": name, "modelEpoch": epoch, "revision": revision,
                "availability": ["identity", "execution", "interactions"].contains(name) ? availability : "unknown",
                "completeness": "complete", "checkedAt": 100, "value": value,
                "source": ["producer": "host", "sourceId": "host-1", "sourceEpoch": "native", "sourceRevision": revision]]
        }
        await transport.emit(["type": "agent.state.snapshot", "scope": "agent", "requestId": request["requestId"]!,
            "runtimeId": id, "sessionId": session, "agentKind": "claude", "modelEpoch": epoch,
            "domains": domains, "missing": [], "truncated": false])
    }

    @Test func repeatedReadyKeepsVerifiedCardFacts() async throws {
        let (store, transport) = setup()
        await transport.ready([runtime()])
        try await loadFacts(transport)
        let host = try #require(store.hosts.first?.connection)
        #expect(!host.homeRuntimesLoading)
        let requests = transport.sent.filter { $0["type"] as? String == "agent.state.request" && $0["scope"] as? String == "agent" }.count

        await transport.ready([runtime()])

        #expect(!host.homeRuntimesLoading)
        #expect(host.homeRuntimes.first?.cwd == "/repo")
        #expect(host.homeRuntimes.first?.status == "running")
        #expect(host.homeRuntimes.first?.agentKind == "claude")
        #expect(transport.sent.filter { $0["type"] as? String == "agent.state.request" && $0["scope"] as? String == "agent" }.count == requests)
    }

    @Test func repeatedOnlineAndLegacyMetadataCannotEraseModelOwnedFacts() async throws {
        let (store, transport) = setup()
        await transport.ready([runtime()])
        try await loadFacts(transport)
        let host = try #require(store.hosts.first?.connection)

        await transport.emit(["type": "runtime.online", "runtime": runtime()])
        #expect(!host.homeRuntimesLoading)
        #expect(host.homeRuntimes.first?.cwd == "/repo")
        #expect(host.homeRuntimes.first?.status == "running")

        await transport.event(["type": "runtime.metadata", "metadata": ["cwd": "", "name": "Agent", "status": "unknown"]])
        #expect(!host.homeRuntimesLoading)
        #expect(host.homeRuntimes.first?.sessionName == "Verified a")
        #expect(host.homeRuntimes.first?.cwd == "/repo")

        await transport.emit(["type": "runtime.online", "runtime": runtime(session: "replacement")])
        #expect(!host.homeRuntimesLoading)
        #expect(host.homeRuntimes.first?.sessionId == "session-a")
        #expect(!host.homeCardIsCurrent(try #require(host.homeCards.first)))
        #expect(host.agentState.snapshots["a"]?.sessionId == "replacement")
        #expect(host.agentState.snapshots["a"]?.domains.isEmpty == true)
    }

    @Test func refreshKeepsVerifiedCardsAndRetriesEveryRuntime() async throws {
        let (store, transport) = setup()
        await transport.ready([runtime(), runtime("b")])
        try await loadFacts(transport)
        try await loadFacts(transport, id: "b")
        let host = try #require(store.hosts.first?.connection)
        let before = transport.sent.count
        #expect(host.homeSyncStatus == .idle)

        store.refresh()

        #expect(!host.homeRuntimesLoading)
        #expect(host.homeRuntimes.count == 2)
        #expect(host.homeRuntimesUpdating)
        #expect(host.homeSyncStatus == .syncing)
        let retried = transport.sent.dropFirst(before).filter { $0["type"] as? String == "agent.state.request" && $0["scope"] as? String == "agent" }
        #expect(Set(retried.compactMap { $0["runtimeId"] as? String }) == ["a", "b"])
        let request = try #require(retried.first)
        await transport.emit(["type": "protocol.error", "requestId": request["requestId"]!, "message": "读取失败"])
        #expect(!host.homeRuntimesLoading)
        #expect(host.homeRuntimes.count == 2)
        #expect(host.homeRuntimesError == "读取失败")
        #expect(host.homeSyncStatus == .failed("读取失败"))
    }

    @Test func missingSessionIdentityHasAnActionableError() async throws {
        let (store, transport) = setup()
        var pending = runtime(); pending.removeValue(forKey: "sessionId")
        await transport.ready([pending])
        let host = try #require(store.hosts.first?.connection)
        #expect(host.homeRuntimesLoading)
        #expect(host.homeRuntimesError == "会话身份尚未就绪，请重新加载")
    }

    @Test func retryRecoversANonSelectedRuntimeAndNewEpochClearsOldFacts() async throws {
        let (store, transport) = setup()
        await transport.ready([runtime(), runtime("b")])
        try await loadFacts(transport)
        let request = try #require(transport.sent.last { $0["type"] as? String == "agent.state.request" && $0["runtimeId"] as? String == "b" })
        await transport.emit(["type": "protocol.error", "requestId": request["requestId"]!, "message": "读取失败"])
        let host = try #require(store.hosts.first?.connection)
        #expect(host.homeRuntimesError == "读取失败")

        store.refresh()
        try await loadFacts(transport)
        try await loadFacts(transport, id: "b")
        #expect(!host.homeRuntimesLoading)
        #expect(host.homeRuntimes.count == 2)

        await transport.emit(["type": "device.ready", "modelEpoch": "replacement-epoch", "runtimes": [runtime()]])
        #expect(!host.homeRuntimesLoading)
        #expect(host.homeRuntimes.count == 2)
        #expect(host.agentState.snapshots["a"]?.domains.isEmpty == true)
        try await loadFacts(transport, epoch: "replacement-epoch")
        #expect(host.homeRuntimes.count == 1)
    }

    @Test func coldStartPublishesOnlyAfterDirectoryAndEveryCardAreComplete() async throws {
        let (store, transport) = setup()
        let host = try #require(store.hosts.first?.connection)
        #expect(host.homePresentation == .preparing)
        transport.state?(.secured, nil)
        #expect(host.homePresentation == .preparing)
        await transport.ready([runtime(), runtime("b")])
        try await loadFacts(transport, names: ["identity", "execution"])
        try await loadFacts(transport, id: "b")
        #expect(host.homePresentation == .preparing)
        #expect(host.homeCards.isEmpty)
        try await loadFacts(transport, names: ["interactions"])
        #expect(!host.homeRuntimesLoading)
        #expect(host.homeCards.count == 2)
        #expect(host.homeCards.allSatisfy { !$0.title.isEmpty && $0.runtime.status == "running" && $0.runtime.cwd == "/repo" })
    }

    @Test func emptyStateRequiresAnAuthenticatedDirectory() async throws {
        let (store, transport) = setup()
        let host = try #require(store.hosts.first?.connection)
        transport.state?(.secured, nil)
        #expect(host.homePresentation == .preparing)
        await transport.ready([])
        #expect(host.homePresentation == .ready([]))
        store.reconnectSelectedHost()
        #expect(host.homePresentation == .ready([]))
        transport.state?(.secured, nil)
        #expect(host.homePresentation == .ready([]))
    }

    @Test func backgroundRefreshCommitsAllCardFieldsTogether() async throws {
        let (store, transport) = setup()
        await transport.ready([runtime(), runtime("b")])
        try await loadFacts(transport)
        try await loadFacts(transport, id: "b")
        let host = try #require(store.hosts.first?.connection)
        let previous = host.homePresentation
        #expect(!host.homeRuntimesUpdating)
        store.refresh()
        #expect(host.homeRuntimesUpdating)
        try await loadFacts(transport, names: ["identity", "execution"], phase: "idle", title: "Updated", revision: 2)
        try await loadFacts(transport, id: "b", phase: "idle", revision: 2)
        #expect(host.homePresentation == previous)
        try await loadFacts(transport, names: ["interactions"], revision: 2)
        #expect(!host.homeRuntimesLoading)
        #expect(host.homeCards.first { $0.id == "a" }?.title == "Updated")
        #expect(host.homeCards.allSatisfy { $0.runtime.status == "idle" })
        #expect(!host.homeRuntimesUpdating)
    }

    @Test func newRuntimeAndReconnectKeepThePreviousCompleteHomepage() async throws {
        let (store, transport) = setup()
        await transport.ready([runtime()])
        try await loadFacts(transport)
        let host = try #require(store.hosts.first?.connection)
        let previous = host.homePresentation
        await transport.emit(["type": "runtime.online", "runtime": runtime("b")])
        #expect(host.homePresentation == previous)
        try await loadFacts(transport, id: "b", names: ["identity", "execution"])
        #expect(host.homePresentation == previous)
        try await loadFacts(transport, id: "b", names: ["interactions"])
        #expect(host.homeCards.count == 2)
        let complete = host.homePresentation
        store.reconnectSelectedHost()
        #expect(host.homePresentation == complete)
        transport.state?(.secured, nil)
        #expect(host.homePresentation == complete)
        await transport.ready([runtime()])
        #expect(host.homePresentation == complete)
        try await loadFacts(transport)
        #expect(host.homeCards.count == 1)
        #expect(!host.homeRuntimesLoading)
    }

    @Test func unknownFactsNeverAppearAsAPartiallyLoadedCard() async throws {
        let (store, transport) = setup()
        await transport.ready([runtime()])
        try await loadFacts(transport, names: ["identity", "interactions"])
        try await loadFacts(transport, names: ["execution"], availability: "unknown")
        let host = try #require(store.hosts.first?.connection)
        #expect(host.homePresentation == .preparing)
        #expect(host.homeRuntimesError != nil)
        try await loadFacts(transport, names: ["execution"], revision: 2)
        #expect(host.homeCards.first?.runtime.status == "running")
    }
}
