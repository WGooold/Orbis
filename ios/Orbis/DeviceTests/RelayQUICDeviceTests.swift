import Network
import Security
import XCTest
@testable import Orbis

private final class DeviceQUICDiscovery: URLProtocol {
    static var port: UInt16 = 0
    static var version = 2
    override class func canInit(with request: URLRequest) -> Bool { request.url?.path == "/v1/transports" }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: nil)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        var quic: [String: Any] = ["port": Self.port, "alpn": "orbis-relay-v2"]
        if Self.version == 3 { quic["historyAlpn"] = "orbis-relay-v3" }
        client?.urlProtocol(self, didLoad: try! JSONSerialization.data(withJSONObject: ["version": 1, "quic": quic]))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

/// Runs the app's actual adapter inside the iOS test host. The external fixture
/// supplies an ephemeral certificate; no device trust or pairing is changed.
@MainActor final class RelayQUICDeviceTests: XCTestCase {
    private func until(_ label: String, _ predicate: () -> Bool) async throws {
        for _ in 0..<300 {
            if predicate() { return }
            try await Task.sleep(nanoseconds: 20_000_000)
        }
        XCTFail("Timed out: \(label)")
        throw URLError(.timedOut)
    }

    func testEncryptedBusinessSurvivesTransportSwitchesAndKeepsLANOnIOS() async throws {
        try await encryptedBusiness(version: 2)
    }

    func testFiveStreamEncryptedBusinessSurvivesTransportSwitchesAndKeepsLANOnIOS() async throws {
        try await encryptedBusiness(version: 3)
    }

    private func encryptedBusiness(version: Int) async throws {
        DeviceQUICDiscovery.version = version
        let encoded = try XCTUnwrap(ProcessInfo.processInfo.environment["ORBIS_QUIC_BUSINESS_FIXTURES"])
        let fixtures = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(encoded.utf8)) as? [[String: Any]])
            .filter { ($0["version"] as? Int ?? 2) == version }
        XCTAssertEqual(fixtures.count, 2)
        for fixture in fixtures {
            let withLAN = try XCTUnwrap(fixture["lan"] as? Bool)
            let qr = try PairingQR.parse(XCTUnwrap(fixture["qr"] as? String))
            let port = try XCTUnwrap((fixture["port"] as? Int).flatMap(UInt16.init(exactly:)))
            let bytes = try XCTUnwrap((fixture["certificate"] as? String).flatMap { Data(base64Encoded: $0) })
            let certificate = try XCTUnwrap(SecCertificateCreateWithData(nil, bytes as CFData))
            DeviceQUICDiscovery.port = port
            let configuration = URLSessionConfiguration.ephemeral
            configuration.protocolClasses = [DeviceQUICDiscovery.self]
            let identity = DeviceIdentity.generate()
            let pairingTransport = RelayTransport(relayMode: .ws, preferences: nil)
            let host: HostPairing = try await withCheckedThrowingContinuation { continuation in
                pairingTransport.pair(qr: qr, deviceName: "iOS QUIC regression", identity: identity) { continuation.resume(with: $0) }
            }
            let transport = RelayTransport(relayMode: .ws, preferences: nil, makeSocket: { url, mode, opened, closed in
                if mode == .ws { return RelaySocket(url: url, mode: mode, onOpen: opened, onClose: closed) }
                return RelaySocket(url: URL(string: "wss://localhost:\(port)/v1/device")!, mode: .quic, configuration: configuration,
                    makeQUIC: { host, port in
                        let options = NWProtocolQUIC.Options(alpn: [version == 3 ? "orbis-relay-v3" : RelayQUICContract.alpn])
                        options.isDatagram = true
                        sec_protocol_options_set_tls_server_name(options.securityProtocolOptions, host)
                        sec_protocol_options_set_verify_block(options.securityProtocolOptions, { _, trust, complete in
                            let value = sec_trust_copy_ref(trust).takeRetainedValue()
                            SecTrustSetAnchorCertificates(value, [certificate] as CFArray)
                            SecTrustSetAnchorCertificatesOnly(value, true)
                            complete(SecTrustEvaluateWithError(value, nil))
                        }, DispatchQueue(label: "orbis.device-test.business-trust"))
                        return NWConnectionGroup(with: NWMultiplexGroup(to: .hostPort(host: "127.0.0.1", port: NWEndpoint.Port(rawValue: port)!)),
                                                 using: NWParameters(quic: options))
                    }, onOpen: opened, onClose: closed)
            })
            defer { transport.disconnect() }
            var received: [[String: Any]] = []
            transport.connect(pairing: host, identity: identity, receive: { message, _ in received.append(message) }, state: { _, _ in })
            try await until("initial encrypted bootstrap") {
                transport.relaySwitchPhase == "active" && received.contains { $0["type"] as? String == "fixture.large" }
            }
            if withLAN {
                try await until("LAN authentication") { received.contains { $0["type"] as? String == "device.path" && $0["path"] as? String == "lan" } }
            }
            for (index, mode) in [RelayTransportMode.quic, .ws, .quic].enumerated() {
                let oldReady = received.filter { $0["type"] as? String == "device.ready" }.count
                let oldHistory = received.filter { $0["type"] as? String == "fixture.history" }.count
                let oldCatchup = received.filter { $0["type"] as? String == "fixture.catchup" }.count
                transport.setRelayTransportMode(mode)
                try await until("authenticated \(mode.rawValue) handover") {
                    transport.relaySwitchPhase == "active" && transport.relayTransportKind?.rawValue == mode.rawValue &&
                        received.filter { $0["type"] as? String == "device.ready" }.count > oldReady
                }
                if version == 3 && mode == .quic && !withLAN {
                    try await until("independent history and catchup") {
                        received.filter { $0["type"] as? String == "fixture.history" }.count > oldHistory &&
                            received.filter { $0["type"] as? String == "fixture.catchup" }.count > oldCatchup
                    }
                    XCTAssertEqual(received.last { $0["type"] as? String == "fixture.history" }?["text"] as? String,
                                   String(repeating: "历史🙂", count: 6000))
                    XCTAssertEqual(received.last { $0["type"] as? String == "fixture.catchup" }?["text"] as? String,
                                   String(repeating: "补齐🙂", count: 6000))
                }
                let text = "round-\(index):" + String(repeating: "密文分片", count: 5000)
                XCTAssertTrue(transport.send(["type": "fixture.echo", "text": text]))
                try await until("encrypted fragmented reply") { received.contains { $0["type"] as? String == "fixture.echoed" && $0["text"] as? String == text } }
                XCTAssertEqual(received.last(where: { $0["type"] as? String == "fixture.echoed" })?["path"] as? String, withLAN ? "lan" : "relay")
                let binary = Data(repeating: UInt8(index + 1), count: 20_000)
                XCTAssertTrue(transport.sendBinary(binary))
                try await until("encrypted binary reply") { received.contains { $0["type"] as? String == "_artifact.chunk" && $0["data"] as? Data == binary } }
            }
            if !withLAN {
                let oldReady = received.filter { $0["type"] as? String == "device.ready" }.count
                XCTAssertTrue(transport.send(["type": "fixture.restart"]))
                try await until("new handshake") { received.filter { $0["type"] as? String == "device.ready" }.count > oldReady }
                XCTAssertTrue(transport.send(["type": "fixture.echo", "text": "new keys"]))
                try await until("new-key reply") { received.contains { $0["text"] as? String == "new keys" } }
            }
            transport.disconnect()
            pairingTransport.disconnect()
        }
    }

    func testTLSOrderedLanesLargeFrameAndCancellationOnIOS() async throws {
        try await orderedLanes(version: 2)
    }

    func testFiveStreamTLSOrderedLanesLargeFrameAndCancellationOnIOS() async throws {
        try await orderedLanes(version: 3)
    }

    private func orderedLanes(version: Int) async throws {
        let environment = ProcessInfo.processInfo.environment
        let port = try XCTUnwrap(environment["ORBIS_QUIC_PORT"].flatMap(UInt16.init))
        let bytes = try XCTUnwrap(environment["ORBIS_QUIC_CERTIFICATE"].flatMap { Data(base64Encoded: $0) })
        let certificate = try XCTUnwrap(SecCertificateCreateWithData(nil, bytes as CFData))
        DeviceQUICDiscovery.port = port
        DeviceQUICDiscovery.version = version
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [DeviceQUICDiscovery.self]
        func makeSocket(mode: RelayTransportMode, hostname: String = "localhost",
                        opened: @escaping () -> Void, closed: @escaping (Error?) -> Void) -> RelaySocket {
            RelaySocket(url: URL(string: "wss://localhost:\(port)/v1/device")!, mode: mode, configuration: configuration,
                makeQUIC: { _, port in
                    let options = NWProtocolQUIC.Options(alpn: [version == 3 ? "orbis-relay-v3" : RelayQUICContract.alpn])
                    options.isDatagram = true
                    options.direction = .bidirectional
                    sec_protocol_options_set_tls_server_name(options.securityProtocolOptions, hostname)
                    sec_protocol_options_set_verify_block(options.securityProtocolOptions, { _, trust, complete in
                        let value = sec_trust_copy_ref(trust).takeRetainedValue()
                        SecTrustSetAnchorCertificates(value, [certificate] as CFArray)
                        SecTrustSetAnchorCertificatesOnly(value, true)
                        complete(SecTrustEvaluateWithError(value, nil))
                    }, DispatchQueue(label: "orbis.device-test.quic-trust"))
                    return NWConnectionGroup(with: NWMultiplexGroup(to: .hostPort(host: "127.0.0.1", port: NWEndpoint.Port(rawValue: port)!)),
                                             using: NWParameters(quic: options))
                }, onOpen: { _ in opened() }, onClose: { _, error in closed(error) })
        }

        var wrongOpened = false, wrongClosed = false
        let wrong = makeSocket(mode: .quic, hostname: "wrong.invalid", opened: { wrongOpened = true }, closed: { _ in wrongClosed = true })
        wrong.start()
        try await until("wrong hostname rejected") { wrongClosed || wrongOpened }
        XCTAssertFalse(wrongOpened)
        XCTAssertTrue(wrongClosed)
        await wrong.cancelAndWait()

        for mode in [RelayTransportMode.quic, .auto] {
            var opened = 0
            var failure: Error?
            let socket = makeSocket(mode: mode, opened: { opened += 1 }, closed: { failure = $0 ?? URLError(.networkConnectionLost) })
            defer { socket.cancel() }
            socket.start()
            try await until("QUIC preparation") { opened > 0 || failure != nil }
            if let failure { throw failure }
            XCTAssertEqual(opened, 1)
            XCTAssertEqual(socket.kind, .quic)
            let lanes: [RelayLane] = version == 3 ? RelayLane.allCases : [.ctl, .msg, .bulk]
            XCTAssertEqual(socket.supportsHistoryStreams, version == 3)
            XCTAssertEqual(Set(socket.streamIdentifiers), Set((0..<lanes.count).map { UInt64($0 * 4) }))
            socket.setBusinessReady(true)
            for lane in lanes {
                for index in 0..<20 {
                    let body = index == 19 ? String(repeating: "a", count: 256 * 1024) : "你好🌍-\(index)"
                    let text = "{\"type\":\"v2.frame\",\"envelope\":{\"hdr\":{\"k\":\"data\",\"ch\":\"\(lane.rawValue)\"},\"ct\":\"\(body)\"}}"
                    var sent = false
                    var sendError: Error?
                    XCTAssertTrue(socket.send(.string(text), lane: lane) { error in
                        Task { @MainActor in sendError = error; sent = true }
                    })
                    try await until("\(lane.rawValue) send") { sent }
                    if let sendError { throw sendError }
                    var received: Result<RelayMessage, Error>?
                    socket.receive { result in Task { @MainActor in received = result } }
                    try await until("\(lane.rawValue) receive") { received != nil }
                    switch try XCTUnwrap(received).get() {
                    case .string(let reply): XCTAssertEqual(reply, text)
                    case .data: XCTFail("Expected the original JSON text")
                    }
                }
            }
            await socket.cancelAndWait()
            XCTAssertNil(socket.kind)
        }
        var cancelledOpened = false
        let cancelled = makeSocket(mode: .quic, opened: { cancelledOpened = true }, closed: { _ in })
        await cancelled.cancelAndWait()
        cancelled.start()
        try await Task.sleep(nanoseconds: 100_000_000)
        XCTAssertFalse(cancelledOpened)
        XCTAssertNil(cancelled.kind)
    }
}
