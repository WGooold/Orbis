import Foundation
import Testing
@testable import OrbisCore

@Suite("Relay interoperability") @MainActor
struct RelayTransportTests {
    @Test(.enabled(if: ProcessInfo.processInfo.environment["ORBIS_TEST_NODE"] != nil, "Set ORBIS_TEST_NODE to a Node.js executable for the isolated WebSocket fixture."), arguments: ["", "/relay/"])
    func pairingEncryptedRoundTripHostRestartAndNormalCloseReconnect(_ relayBasePath: String) async throws {
        let node = try #require(ProcessInfo.processInfo.environment["ORBIS_TEST_NODE"])
        let fixture = try #require(Bundle.module.url(forResource: "relay", withExtension: "mjs", subdirectory: "Fixtures"))
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("orbis-ios-test-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: folder) }
        let qrFile = folder.appendingPathComponent("qr.json")
        let process = Process()
        process.executableURL = URL(fileURLWithPath: node)
        process.arguments = [fixture.path, qrFile.path, relayBasePath]
        process.standardOutput = FileHandle.nullDevice
        // Test failures retain Node's protocol diagnostics in the test output.
        process.standardError = FileHandle.standardError
        try process.run()
        defer { if process.isRunning { process.terminate() }; process.waitUntilExit() }
        try await waitUntil { FileManager.default.fileExists(atPath: qrFile.path) }
        let qr = try PairingQR.parse(String(contentsOf: qrFile, encoding: .utf8))
        #expect(qr.relayUrl.hasSuffix(relayBasePath))
        let identity = DeviceIdentity.generate()
        let pairingTransport = RelayTransport()
        let host: HostPairing = try await withCheckedThrowingContinuation { continuation in
            pairingTransport.pair(qr: qr, deviceName: "Isolated Swift test", identity: identity) { continuation.resume(with: $0) }
        }
        #expect(host.hostId == qr.hostId)
        #expect(host.pskRoot.count == 43)
        let transport = RelayTransport()
        // Optional native setup failures must leave the authenticated Relay usable.
        var p2pAttempts = 0
        transport.p2pFactory = { _ in p2pAttempts += 1; throw PairingError.unsupported }
        defer { transport.disconnect() }
        var received: [[String: Any]] = []
        var connection: ConnectionState = .offline
        transport.connect(pairing: host, identity: identity, receive: { message, _ in received.append(message) }, state: { state, _ in connection = state })
        try await waitUntil { connection == .secured && received.contains { $0["type"] as? String == "fixture.ping.echoed" } }
        #expect(received.contains { $0["type"] as? String == "fixture.large" && ($0["text"] as? String)?.count == 20_000 })
        #expect(p2pAttempts >= 1)
        // Exercise outbound fragmentation too, not just inbound history.
        let text = String(repeating: "从 iOS 发出的加密消息", count: 2000)
        #expect(transport.send(["type": "fixture.echo", "text": text]))
        try await waitUntil { received.contains { $0["type"] as? String == "fixture.echoed" } }
        #expect(received.last(where: { $0["type"] as? String == "fixture.echoed" })?["text"] as? String == text)
        #expect(transport.send(["type": "fixture.restart"]))
        try await waitUntil { received.filter { $0["fixtureGeneration"] as? Int == 2 }.count == 1 }
        #expect(connection == .secured)
        #expect(transport.send(["type": "fixture.close"]))
        try await waitUntil { received.filter { $0["fixtureGeneration"] as? Int == 3 }.count == 1 }
        #expect(connection == .secured)
    }

    @Test(.enabled(if: ProcessInfo.processInfo.environment["ORBIS_TEST_NODE"] != nil, "Set ORBIS_TEST_NODE for the isolated LAN fixture."))
    func authenticatedLANDiscoveryHostPathSelectionAndRelayFallback() async throws {
        let node = try #require(ProcessInfo.processInfo.environment["ORBIS_TEST_NODE"])
        let fixture = try #require(Bundle.module.url(forResource: "relay", withExtension: "mjs", subdirectory: "Fixtures"))
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("orbis-ios-lan-test-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: folder) }
        let qrFile = folder.appendingPathComponent("qr.json")
        let process = Process()
        process.executableURL = URL(fileURLWithPath: node)
        process.arguments = [fixture.path, qrFile.path, "", "lan"]
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.standardError
        try process.run()
        defer { if process.isRunning { process.terminate() }; process.waitUntilExit() }
        try await waitUntil { FileManager.default.fileExists(atPath: qrFile.path) }
        let qr = try PairingQR.parse(String(contentsOf: qrFile, encoding: .utf8))
        let identity = DeviceIdentity.generate()
        let pairingTransport = RelayTransport()
        let host: HostPairing = try await withCheckedThrowingContinuation { continuation in
            pairingTransport.pair(qr: qr, deviceName: "Isolated LAN test", identity: identity) { continuation.resume(with: $0) }
        }
        #expect(host.lan.isEmpty) // Direct addresses arrive only through authenticated host.lan.
        let transport = RelayTransport()
        defer { transport.disconnect() }
        var received: [[String: Any]] = []
        var connection: ConnectionState = .offline
        transport.connect(pairing: host, identity: identity, receive: { message, _ in received.append(message) }, state: { state, _ in connection = state })
        try await waitUntil { received.contains { $0["type"] as? String == "device.path" && $0["path"] as? String == "lan" } }
        #expect(received.contains { $0["type"] as? String == "_transport.lan" && ($0["endpoints"] as? [LANEndpoint])?.count == 1 })
        #expect(transport.send(["type": "fixture.echo", "text": "over LAN"]))
        try await waitUntil { received.contains { $0["type"] as? String == "fixture.echoed" && $0["text"] as? String == "over LAN" && $0["path"] as? String == "lan" } }
        #expect(transport.send(["type": "fixture.close-relay"]))
        try await waitUntil { received.contains { $0["type"] as? String == "fixture.relay.closed" } }
        #expect(connection == .secured)
        #expect(transport.send(["type": "fixture.echo", "text": "LAN survives Relay close"]))
        try await waitUntil { received.contains { $0["text"] as? String == "LAN survives Relay close" && $0["path"] as? String == "lan" } }
        // Relay reconnects independently while the selected LAN Path remains usable.
        try await waitUntil { received.contains { ($0["fixtureGeneration"] as? Int ?? 0) >= 3 } }
        #expect(transport.send(["type": "fixture.close-lan"]))
        try await waitUntil { received.contains { $0["type"] as? String == "device.path" && $0["path"] as? String == "relay" } }
        #expect(transport.send(["type": "fixture.echo", "text": "Relay fallback"]))
        try await waitUntil { received.contains { $0["text"] as? String == "Relay fallback" && $0["path"] as? String == "relay" } }
        #expect(connection == .secured)
    }

    #if canImport(WebRTC)
    @Test(.enabled(if: ProcessInfo.processInfo.environment["ORBIS_TEST_NODE"] != nil && ProcessInfo.processInfo.environment["ORBIS_TEST_DATACHANNEL_MODULE"] != nil,
                   "Native loopback needs WebRTC linked and ORBIS_TEST_DATACHANNEL_MODULE pointing to node-datachannel's ESM entry."))
    func nativeWebRTCDataChannelHostSignalingEncryptedTrafficAndPathFallback() async throws {
        let node = try #require(ProcessInfo.processInfo.environment["ORBIS_TEST_NODE"])
        let module = try #require(ProcessInfo.processInfo.environment["ORBIS_TEST_DATACHANNEL_MODULE"])
        let fixture = try #require(Bundle.module.url(forResource: "relay", withExtension: "mjs", subdirectory: "Fixtures"))
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("orbis-ios-p2p-test-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: folder) }
        let qrFile = folder.appendingPathComponent("qr.json")
        let process = Process()
        process.executableURL = URL(fileURLWithPath: node)
        process.arguments = [fixture.path, qrFile.path, "", "p2p", module]
        process.standardOutput = FileHandle.nullDevice; process.standardError = FileHandle.standardError
        try process.run()
        defer { if process.isRunning { process.terminate() }; process.waitUntilExit() }
        try await waitUntil { FileManager.default.fileExists(atPath: qrFile.path) }
        let qr = try PairingQR.parse(String(contentsOf: qrFile, encoding: .utf8)), identity = DeviceIdentity.generate()
        let pairingTransport = RelayTransport()
        let host: HostPairing = try await withCheckedThrowingContinuation { continuation in
            pairingTransport.pair(qr: qr, deviceName: "Native P2P loopback", identity: identity) { continuation.resume(with: $0) }
        }
        let transport = RelayTransport()
        // Loopback needs only host candidates; no external DNS or STUN is used.
        transport.p2pFactory = { _ in try P2PTransport.makeNativePeer(stunServers: []) }
        defer { transport.disconnect() }
        var received: [[String: Any]] = []
        var connection: ConnectionState = .offline
        transport.connect(pairing: host, identity: identity, receive: { message, _ in received.append(message) }, state: { state, _ in connection = state })
        try await waitUntil { received.contains { $0["type"] as? String == "fixture.p2p.ready" } }
        #expect(connection == .secured)
        try await waitUntil { received.contains { $0["type"] as? String == "fixture.p2p.large" && ($0["text"] as? String)?.count == 52_000 } }
        let text = String(repeating: "实际 P2P 加密消息", count: 2000)
        #expect(transport.send(["type": "fixture.echo", "text": text]))
        try await waitUntil { received.contains { $0["text"] as? String == text && $0["path"] as? String == "p2p" } }
        #expect(transport.sendBinary(Data(repeating: 0x42, count: 200_000)))
        try await waitUntil { received.contains { $0["type"] as? String == "fixture.p2p.binary" && $0["bytes"] as? Int == 200_000 } }
        #expect(transport.send(["type": "fixture.close-relay"]))
        try await waitUntil { received.contains { $0["type"] as? String == "fixture.relay.closed" } }
        #expect(connection == .secured)
        #expect(transport.send(["type": "fixture.echo", "text": "P2P survives Relay close"]))
        try await waitUntil { received.contains { $0["text"] as? String == "P2P survives Relay close" && $0["path"] as? String == "p2p" } }
        try await waitUntil { received.contains { ($0["fixtureGeneration"] as? Int ?? 0) >= 2 } }
        #expect(transport.send(["type": "fixture.close-p2p"]))
        try await waitUntil { received.contains { $0["type"] as? String == "fixture.p2p.closed" } }
        #expect(transport.send(["type": "fixture.echo", "text": "Relay fallback after P2P"]))
        try await waitUntil { received.contains { $0["text"] as? String == "Relay fallback after P2P" && $0["path"] as? String == "relay" } }
        #expect(connection == .secured)
    }
    #endif

    @Test(.enabled(if: ProcessInfo.processInfo.environment["ORBIS_TEST_NODE"] != nil, "Two Host loopback needs Node.js."))
    func simultaneousHostsKeepAuthenticatedTrafficAndReconnectsIndependent() async throws {
        try await runTwoHosts(useP2P: false)
    }

    #if canImport(WebRTC)
    @Test(.enabled(if: ProcessInfo.processInfo.environment["ORBIS_TEST_NODE"] != nil && ProcessInfo.processInfo.environment["ORBIS_TEST_DATACHANNEL_MODULE"] != nil,
                   "Two native Host loopback needs WebRTC and node-datachannel."))
    func simultaneousNativePeersKeepFactoryKeysAndPathClosuresIndependent() async throws {
        try await runTwoHosts(useP2P: true)
    }
    #endif

    @Test(.enabled(if: ProcessInfo.processInfo.environment["ORBIS_TEST_NODE"] != nil, "Pairing lifecycle fixture needs Node.js."))
    func cancelledPairingCannotOpenSocketsOrCloseAReplacementConnection() async throws {
        let node = try #require(ProcessInfo.processInfo.environment["ORBIS_TEST_NODE"])
        let fixture = try #require(Bundle.module.url(forResource: "relay", withExtension: "mjs", subdirectory: "Fixtures"))
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("orbis-pair-generation-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: folder) }
        let qrFile = folder.appendingPathComponent("qr.json"), requestFile = folder.appendingPathComponent("requests.txt"), process = Process()
        process.executableURL = URL(fileURLWithPath: node); process.arguments = [fixture.path, qrFile.path]
        var environment = ProcessInfo.processInfo.environment
        environment["ORBIS_FIXTURE_PAIR_DELAY_MS"] = "200"
        environment["ORBIS_FIXTURE_PAIR_REQUEST_FILE"] = requestFile.path
        process.environment = environment
        process.standardOutput = FileHandle.nullDevice; process.standardError = FileHandle.standardError
        try process.run()
        defer { if process.isRunning { process.terminate() }; process.waitUntilExit() }
        try await waitUntil { FileManager.default.fileExists(atPath: qrFile.path) }
        let qr = try PairingQR.parse(String(contentsOf: qrFile, encoding: .utf8)), identity = DeviceIdentity.generate()
        let initial = RelayTransport()
        let host: HostPairing = try await withCheckedThrowingContinuation { continuation in
            initial.pair(qr: qr, deviceName: "initial", identity: identity) { continuation.resume(with: $0) }
        }
        let transport = RelayTransport()
        transport.p2pFactory = { _ in nil }
        defer { transport.disconnect() }
        var failures = 0, successes = 0, echoes = 0
        var state: ConnectionState = .offline
        let completion: (Result<HostPairing, Error>) -> Void = { result in
            switch result { case .success: successes += 1; case .failure: failures += 1 }
        }
        let connect = {
            transport.connect(pairing: host, identity: identity, receive: { message, _ in
                if message["type"] as? String == "fixture.ping.echoed" { echoes += 1 }
            }, state: { value, _ in state = value })
        }
        // Supersede the operation before its HTTP Task even gets the actor.
        transport.pair(qr: qr, deviceName: "superseded", identity: identity, completion: completion)
        connect()
        try await waitUntil { failures == 1 && state == .secured && echoes == 1 }
        #expect(successes == 0)
        // Also cancel an operation already suspended on delayed HTTP, then reuse
        // the transport. Its eventual error must not disconnect the new socket.
        transport.pair(qr: qr, deviceName: "cancelled HTTP", identity: identity, completion: completion)
        try await waitUntil { (try? String(contentsOf: requestFile, encoding: .utf8)) == "2" }
        transport.disconnect(); connect()
        try await waitUntil { failures == 2 && state == .secured && echoes == 2 }
        #expect(successes == 0)
        #expect(transport.send(["type": "fixture.echo", "text": "replacement survives"]))
    }

    private func runTwoHosts(useP2P: Bool) async throws {
        let node = try #require(ProcessInfo.processInfo.environment["ORBIS_TEST_NODE"])
        let fixture = try #require(Bundle.module.url(forResource: "relay", withExtension: "mjs", subdirectory: "Fixtures"))
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("orbis-two-hosts-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: folder) }
        var processes: [Process] = []
        defer { for process in processes { if process.isRunning { process.terminate() }; process.waitUntilExit() } }
        var hosts: [HostPairing] = []
        let identity = DeviceIdentity.generate()
        for name in ["first", "second"] {
            let qrFile = folder.appendingPathComponent(name + ".json"), process = Process()
            process.executableURL = URL(fileURLWithPath: node)
            var arguments = [fixture.path, qrFile.path, "", useP2P ? "p2p" : ""]
            if useP2P { arguments.append(try #require(ProcessInfo.processInfo.environment["ORBIS_TEST_DATACHANNEL_MODULE"])) }
            process.arguments = arguments
            var environment = ProcessInfo.processInfo.environment
            environment["ORBIS_FIXTURE_HOST_ID"] = "host-" + name
            environment["ORBIS_FIXTURE_DEVICE_ID"] = "device-" + name
            process.environment = environment; process.standardOutput = FileHandle.nullDevice; process.standardError = FileHandle.standardError
            try process.run(); processes.append(process)
            try await waitUntil { FileManager.default.fileExists(atPath: qrFile.path) }
            let qr = try PairingQR.parse(String(contentsOf: qrFile, encoding: .utf8)), pairingTransport = RelayTransport()
            let host: HostPairing = try await withCheckedThrowingContinuation { continuation in
                pairingTransport.pair(qr: qr, deviceName: name, identity: identity) { continuation.resume(with: $0) }
            }
            hosts.append(host)
        }
        #expect(hosts[0].hostId != hosts[1].hostId && hosts[0].pskRoot != hosts[1].pskRoot)
        let first = RelayTransport(), second = RelayTransport()
        for transport in [first, second] {
            transport.p2pFactory = { _ in useP2P ? try P2PTransport.makeNativePeer(stunServers: []) : nil }
        }
        defer { first.disconnect(); second.disconnect() }
        var firstMessages: [[String: Any]] = [], secondMessages: [[String: Any]] = []
        var firstState: ConnectionState = .offline, secondState: ConnectionState = .offline
        first.connect(pairing: hosts[0], identity: identity, receive: { message, _ in firstMessages.append(message) }, state: { state, _ in firstState = state })
        second.connect(pairing: hosts[1], identity: identity, receive: { message, _ in secondMessages.append(message) }, state: { state, _ in secondState = state })
        let readyType = useP2P ? "fixture.p2p.ready" : "fixture.ping.echoed"
        try await waitUntil { firstMessages.contains { $0["type"] as? String == readyType } && secondMessages.contains { $0["type"] as? String == readyType } }
        #expect(firstState == .secured && secondState == .secured)
        #expect(first.send(["type": "fixture.echo", "text": "only first"]))
        #expect(second.send(["type": "fixture.echo", "text": "only second"]))
        try await waitUntil { firstMessages.contains { $0["text"] as? String == "only first" } && secondMessages.contains { $0["text"] as? String == "only second" } }
        #expect(!firstMessages.contains { $0["text"] as? String == "only second" })
        #expect(!secondMessages.contains { $0["text"] as? String == "only first" })
        #expect(first.send(["type": useP2P ? "fixture.close-p2p" : "fixture.close"]))
        if useP2P { try await waitUntil { firstMessages.contains { $0["type"] as? String == "fixture.p2p.closed" } } }
        else { try await waitUntil { firstState == .offline } }
        #expect(secondState == .secured)
        #expect(second.send(["type": "fixture.echo", "text": "second survives first path close"]))
        try await waitUntil { secondMessages.contains { $0["text"] as? String == "second survives first path close" && $0["path"] as? String == (useP2P ? "p2p" : "relay") } }
        if !useP2P { try await waitUntil { firstMessages.contains { $0["fixtureGeneration"] as? Int == 2 } } }
        first.disconnect()
        #expect(second.send(["type": "fixture.echo", "text": "second survives first disconnect"]))
        try await waitUntil { secondMessages.contains { $0["text"] as? String == "second survives first disconnect" && $0["path"] as? String == (useP2P ? "p2p" : "relay") } }
        #expect(secondState == .secured)
    }

    private func waitUntil(_ condition: @escaping @MainActor () -> Bool) async throws {
        let deadline = Date().addingTimeInterval(25)
        while !condition() && Date() < deadline { try await Task.sleep(nanoseconds: 20_000_000) }
        try #require(condition(), "Timed out waiting for the local Relay interoperability fixture")
    }
}
