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
        defer { transport.disconnect() }
        var received: [[String: Any]] = []
        var connection: ConnectionState = .offline
        transport.connect(pairing: host, identity: identity, receive: { message, _ in received.append(message) }, state: { state, _ in connection = state })
        try await waitUntil { connection == .secured && received.contains { $0["type"] as? String == "fixture.ping.echoed" } }
        #expect(received.contains { $0["type"] as? String == "fixture.large" && ($0["text"] as? String)?.count == 20_000 })
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

    private func waitUntil(_ condition: @escaping @MainActor () -> Bool) async throws {
        let deadline = Date().addingTimeInterval(25)
        while !condition() && Date() < deadline { try await Task.sleep(nanoseconds: 20_000_000) }
        try #require(condition(), "Timed out waiting for the local Relay interoperability fixture")
    }
}
