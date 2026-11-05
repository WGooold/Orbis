import Foundation
import Network
import Security
import Testing
@testable import OrbisCore

private final class BusinessQUICDiscovery: URLProtocol {
    static var version = 2
    override class func canInit(with request: URLRequest) -> Bool { request.url?.path == "/v1/transports" }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: nil)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        var quic: [String: Any] = ["port": request.url!.port!, "alpn": "orbis-relay-v2"]
        if Self.version == 3 { quic["historyAlpn"] = "orbis-relay-v3" }
        client?.urlProtocol(self, didLoad: try! JSONSerialization.data(withJSONObject: ["version": 1, "quic": quic]))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

@Suite("Apple three-stream encrypted business and switching", .serialized) @MainActor
struct RelayQUICBusinessTests {
    private func until(_ predicate: () -> Bool) async throws {
        for _ in 0..<300 { if predicate() { return }; try await Task.sleep(nanoseconds: 20_000_000) }
        throw PairingError.relay("Business fixture did not reach expected state")
    }
    @Test(.enabled(if: ProcessInfo.processInfo.environment["ORBIS_QUIC_FIXTURE"] != nil && ProcessInfo.processInfo.environment["ORBIS_TEST_NODE"] != nil), arguments: [false, true], [2, 3])
    func originalPairingEncryptedMessagesFilesRestartAndLANSurviveRelaySwitch(withLAN: Bool, version: Int) async throws {
        let environment = ProcessInfo.processInfo.environment
        BusinessQUICDiscovery.version = version
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("orbis-quic-business-\(UUID())")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: folder) }
        let qrFile = folder.appendingPathComponent("qr.json")
        let script = try #require(Bundle.module.url(forResource: "relay", withExtension: "mjs", subdirectory: "Fixtures"))
        let node = Process(); node.executableURL = URL(fileURLWithPath: try #require(environment["ORBIS_TEST_NODE"]))
        node.environment = environment.merging(["ORBIS_FIXTURE_HISTORY_STREAMS": version == 3 ? "1" : "0"]) { _, new in new }
        node.arguments = [script.path, qrFile.path, "", withLAN ? "lan" : ""]
        node.standardOutput = FileHandle.nullDevice
        try node.run()
        defer { if node.isRunning { node.terminate() }; node.waitUntilExit() }
        try await until { FileManager.default.fileExists(atPath: qrFile.path) }
        let qr = try PairingQR.parse(String(contentsOf: qrFile, encoding: .utf8))
        let identity = DeviceIdentity.generate()
        let pairingTransport = RelayTransport(relayMode: .ws, preferences: nil)
        let host: HostPairing = try await withCheckedThrowingContinuation { continuation in
            pairingTransport.pair(qr: qr, deviceName: "QUIC regression", identity: identity) { continuation.resume(with: $0) }
        }
        let adapter = Process(); adapter.executableURL = URL(fileURLWithPath: try #require(environment["ORBIS_QUIC_FIXTURE"]))
        adapter.arguments = [folder.path, qr.relayUrl + "/v1/device"]
        try adapter.run()
        defer { if adapter.isRunning { adapter.terminate() }; adapter.waitUntilExit() }
        let readyFile = folder.appendingPathComponent("ready.json")
        try await until { FileManager.default.fileExists(atPath: readyFile.path) }
        let metadata = try JSONSerialization.jsonObject(with: Data(contentsOf: readyFile)) as! [String: Int]
        let port = UInt16(try #require(metadata["port"]))
        let cert = try #require(SecCertificateCreateWithData(nil, Data(contentsOf: folder.appendingPathComponent("cert.der")) as CFData))
        let configuration = URLSessionConfiguration.ephemeral; configuration.protocolClasses = [BusinessQUICDiscovery.self]
        let transport = RelayTransport(relayMode: .ws, preferences: nil, makeSocket: { url, mode, opened, closed in
            if mode == .ws { return RelaySocket(url: url, mode: .ws, onOpen: opened, onClose: closed) }
            return RelaySocket(url: URL(string: "wss://localhost:\(port)/v1/device")!, mode: .quic, configuration: configuration,
                makeQUIC: { host, port in
                    let options = NWProtocolQUIC.Options(alpn: [version == 3 ? "orbis-relay-v3" : RelayQUICContract.alpn]); options.isDatagram = true
                    sec_protocol_options_set_tls_server_name(options.securityProtocolOptions, host)
                    sec_protocol_options_set_verify_block(options.securityProtocolOptions, { _, trust, done in
                        let value = sec_trust_copy_ref(trust).takeRetainedValue()
                        SecTrustSetAnchorCertificates(value, [cert] as CFArray); SecTrustSetAnchorCertificatesOnly(value, true)
                        done(SecTrustEvaluateWithError(value, nil))
                    }, DispatchQueue(label: "quic.business.cert"))
                    return NWConnectionGroup(with: NWMultiplexGroup(to: .hostPort(host: "127.0.0.1", port: NWEndpoint.Port(rawValue: port)!)), using: NWParameters(quic: options))
                }, onOpen: opened, onClose: closed)
        })
        defer { transport.disconnect() }
        var received: [[String: Any]] = []
        transport.connect(pairing: host, identity: identity, receive: { message, _ in received.append(message) }, state: { _, _ in })
        try await until { transport.relaySwitchPhase == "active" && received.contains { $0["type"] as? String == "fixture.large" } }
        if withLAN { try await until { received.contains { $0["type"] as? String == "device.path" && $0["path"] as? String == "lan" } } }
        for (index, mode) in [RelayTransportMode.quic, .ws, .quic].enumerated() {
            let oldReady = received.filter { $0["type"] as? String == "device.ready" }.count
            let oldHistory = received.filter { $0["type"] as? String == "fixture.history" }.count
            let oldCatchup = received.filter { $0["type"] as? String == "fixture.catchup" }.count
            transport.setRelayTransportMode(mode)
            try await until { transport.relaySwitchPhase == "active" && transport.relayTransportKind?.rawValue == mode.rawValue && received.filter { $0["type"] as? String == "device.ready" }.count > oldReady }
            if version == 3 && mode == .quic && !withLAN {
                try await until { received.filter { $0["type"] as? String == "fixture.history" }.count > oldHistory && received.filter { $0["type"] as? String == "fixture.catchup" }.count > oldCatchup }
            }
            let text = "round-\(index):" + String(repeating: "密文分片", count: 5000)
            #expect(transport.send(["type": "fixture.echo", "text": text]))
            try await until { received.contains { $0["type"] as? String == "fixture.echoed" && $0["text"] as? String == text } }
            #expect(received.last(where: { $0["type"] as? String == "fixture.echoed" })?["path"] as? String == (withLAN ? "lan" : "relay"))
            let bytes = Data(repeating: UInt8(index + 1), count: 20_000)
            #expect(transport.sendBinary(bytes))
            try await until { received.contains { $0["type"] as? String == "_artifact.chunk" && $0["data"] as? Data == bytes } }
        }
        if !withLAN {
            let oldReady = received.filter { $0["type"] as? String == "device.ready" }.count
            #expect(transport.send(["type": "fixture.restart"]))
            try await until { transport.relaySwitchPhase == "active" && received.filter { $0["type"] as? String == "device.ready" }.count > oldReady }
            #expect(transport.send(["type": "fixture.echo", "text": "new keys"]))
            try await until { received.contains { $0["text"] as? String == "new keys" } }
        }
    }
}
