import Foundation
import Network
import Security
import Testing
@testable import OrbisCore

@Suite("Native QUIC wire contract")
struct RelayQUICTests {
    @Test func discoveryRejectsUntrustedShape() {
        func port(_ text: String) -> UInt16? { RelayQUICContract.port(from: Data(text.utf8)) }
        #expect(port(#"{"version":1,"quic":{"port":24443,"alpn":"orbis-relay-v2"}}"#) == 24443)
        for bad in ["0", "65536", "true", "1.5", "\"443\""] {
            #expect(port("{\"version\":1,\"quic\":{\"port\":\(bad),\"alpn\":\"orbis-relay-v2\"}}") == nil)
        }
        #expect(port(#"{"version":true,"quic":{"port":443,"alpn":"orbis-relay-v2"}}"#) == nil)
        #expect(port(#"{"version":1,"quic":null}"#) == nil)
        #expect(port(#"{"version":1,"quic":{"port":443,"alpn":"h3"}}"#) == nil)
    }

    @Test func framesUseUTF8ByteLengthAndEnforceLimits() throws {
        let text = #"{"text":"你好🌍"}"#
        let bytes = try RelayQUICContract.frame(text)
        #expect(RelayQUICContract.length(Data(bytes.prefix(4))) == text.utf8.count)
        #expect(Data(bytes.dropFirst(4)) == Data(text.utf8))
        #expect(RelayQUICContract.length(Data([0, 0, 0, 0])) == nil)
        #expect(RelayQUICContract.length(Data([0, 32, 0, 1])) == nil)
        #expect(RelayQUICContract.length(Data([0, 32, 0, 0])) == 2 * 1024 * 1024)
        #expect(throws: (any Error).self) { try RelayQUICContract.frame("[]") }
        #expect(throws: (any Error).self) { try RelayQUICContract.frame("{\"s\":\"" + String(repeating: "a", count: 2 * 1024 * 1024) + "\"}") }
    }

    @Test func readyIsStrictlyTransportVersionTwoWithRole() {
        #expect(RelayQUICContract.ready(Data(#"{"type":"transport.ready","version":2,"lane":"ctl"}"#.utf8), lane: .ctl))
        for text in [#"{"type":"transport.ready","version":true,"lane":"ctl"}"#, #"{"type":"device.ready","version":2,"lane":"ctl"}"#,
                     #"{"type":"transport.ready","version":1,"lane":"ctl"}"#, #"{"type":"transport.ready","version":2,"lane":"msg"}"#,
                     #"{"type":"transport.ready","version":2,"lane":"ctl","extra":0}"#] {
            #expect(!RelayQUICContract.ready(Data(text.utf8), lane: .ctl))
        }
    }

}

private final class QUICDiscoveryFixture: URLProtocol {
    static var port: UInt16 = 0
    static var version = 2
    override class func canInit(with request: URLRequest) -> Bool { request.url?.path == "/relay/v1/transports" }
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

@Suite("Network.framework native interoperability", .serialized) @MainActor
struct RelayQUICInteropTests {
    @Test(.enabled(if: ProcessInfo.processInfo.environment["ORBIS_QUIC_FIXTURE"] != nil, "Build native/relayquic/testdata/fixture and set ORBIS_QUIC_FIXTURE."), arguments: [RelayTransportMode.auto, .quic], [2, 3])
    func systemQUICExchangesOrderedUnicodeFramesWithGoAdapter(mode: RelayTransportMode, version: Int) async throws {
        let executable = try #require(ProcessInfo.processInfo.environment["ORBIS_QUIC_FIXTURE"])
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("orbis-quic-\(UUID())")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: folder) }
        let process = Process()
        process.executableURL = URL(fileURLWithPath: executable); process.arguments = [folder.path]
        try process.run()
        defer { if process.isRunning { process.terminate() }; process.waitUntilExit() }
        let ready = folder.appendingPathComponent("ready.json")
        for _ in 0..<100 {
            if FileManager.default.fileExists(atPath: ready.path) { break }
            try await Task.sleep(nanoseconds: 20_000_000)
        }
        let metadata = try JSONSerialization.jsonObject(with: Data(contentsOf: ready)) as! [String: Int]
        QUICDiscoveryFixture.version = version
        QUICDiscoveryFixture.port = UInt16(try #require(metadata["port"]))
        let certificate = try #require(SecCertificateCreateWithData(nil, Data(contentsOf: folder.appendingPathComponent("cert.der")) as CFData))
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [QUICDiscoveryFixture.self]
        var opened = 0
        var failure: Error?
        let socket = RelaySocket(url: URL(string: "wss://localhost:9/relay/v1/device")!, mode: mode, configuration: config,
            makeQUIC: { host, port in
                let options = NWProtocolQUIC.Options(alpn: [version == 3 ? "orbis-relay-v3" : RelayQUICContract.alpn])
                options.isDatagram = true
                options.direction = .bidirectional
                sec_protocol_options_set_tls_server_name(options.securityProtocolOptions, host)
                // Trust only this test's ephemeral certificate, retaining hostname / expiry validation.
                sec_protocol_options_set_verify_block(options.securityProtocolOptions, { _, trust, complete in
                    let value = sec_trust_copy_ref(trust).takeRetainedValue()
                    SecTrustSetAnchorCertificates(value, [certificate] as CFArray)
                    SecTrustSetAnchorCertificatesOnly(value, true)
                    complete(SecTrustEvaluateWithError(value, nil))
                }, DispatchQueue(label: "orbis.test.quic.trust"))
                return NWConnectionGroup(with: NWMultiplexGroup(to: .hostPort(host: "127.0.0.1", port: NWEndpoint.Port(rawValue: port)!)), using: NWParameters(quic: options))
            }, onOpen: { _ in opened += 1 }, onClose: { _, error in failure = error ?? URLError(.networkConnectionLost) })
        defer { socket.cancel() }
        socket.start()
        for _ in 0..<150 {
            if opened > 0 || failure != nil { break }
            try await Task.sleep(nanoseconds: 20_000_000)
        }
        if let failure { throw failure }
        #expect(opened == 1)
        #expect(socket.kind == .quic)
        guard opened == 1 else { return }
        let lanes: [RelayLane] = version == 3 ? RelayLane.allCases : [.ctl, .msg, .bulk]
        #expect(socket.supportsHistoryStreams == (version == 3))
        #expect(Set(socket.streamIdentifiers).count == lanes.count)
        #expect(Set(socket.streamIdentifiers) == Set((0..<lanes.count).map { UInt64($0 * 4) }))
        socket.setBusinessReady(true)
        for lane in lanes {
            for index in 0..<20 {
                let text = "{\"type\":\"v2.frame\",\"envelope\":{\"hdr\":{\"k\":\"data\",\"ch\":\"\(lane.rawValue)\"},\"ct\":\"你好🌍-\(index)\"}}"
                try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                    socket.send(.string(text), lane: lane) { error in
                        if let error { continuation.resume(throwing: error) } else { continuation.resume() }
                    }
                }
                let response: RelayMessage = try await withCheckedThrowingContinuation { continuation in
                    socket.receive { continuation.resume(with: $0) }
                }
                if case .string(let echoed) = response { #expect(echoed == text) } else { Issue.record("Expected JSON text") }
            }
        }
        await socket.cancelAndWait()
        #expect(socket.kind == nil)

    }
}

private final class PolicyDiscoveryFixture: URLProtocol {
    static var body = Data()
    static var requests = 0
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        Self.requests += 1
        let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: nil)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Self.body)
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

@MainActor private final class PolicyWebSocket: RelayWebSocket {
    var onOpen: () -> Void = {}
    var onClose: (Error?) -> Void = { _ in }
    var sent: [RelayMessage] = []
    var cancelled = false
    func start() { onOpen() }
    func send(_ message: RelayMessage, completionHandler: @escaping @Sendable (Error?) -> Void) {
        sent.append(message); completionHandler(nil)
    }
    func receive(completionHandler: @escaping @Sendable (Result<RelayMessage, Error>) -> Void) {}
    func cancel() { cancelled = true }
}

@Suite("Relay transport selection", .serialized) @MainActor
struct RelaySelectionTests {
    private func config(port: UInt16? = nil) -> URLSessionConfiguration {
        PolicyDiscoveryFixture.requests = 0
        PolicyDiscoveryFixture.body = Data((port.map {
            "{\"version\":1,\"quic\":{\"port\":\($0),\"alpn\":\"orbis-relay-v2\"}}"
        } ?? "{\"version\":1}").utf8)
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [PolicyDiscoveryFixture.self]
        return config
    }
    private func until(_ predicate: () -> Bool) async throws {
        for _ in 0..<200 {
            if predicate() { return }
            try await Task.sleep(nanoseconds: 20_000_000)
        }
        Issue.record("Transport did not finish within the preparation budget")
    }

    private func expectSend(_ socket: any RelaySocketConnection, text: String = "{}", accepted: Bool) {
        let result = socket.send(.string(text)) { error in
            #expect((error == nil) == accepted)
        }
        #expect(result == accepted)
    }

    @Test func forcedWSSkipsDiscoveryAndNativePreparation() {
        let ws = PolicyWebSocket()
        var opened = 0
        let socket = RelaySocket(url: URL(string: "wss://relay.invalid/relay/v1/device")!, mode: .ws, configuration: config(),
            makeQUIC: { host, port in Issue.record("Must not prepare QUIC"); return RelaySocket.makeConnection(host: host, port: port) },
            makeWebSocket: { _, _, onOpen, onClose in ws.onOpen = onOpen; ws.onClose = onClose; return ws },
            onOpen: { connection in #expect(connection.kind == .ws); opened += 1 }, onClose: { _, _ in Issue.record("Unexpected close") })
        defer { socket.cancel() }
        #expect(socket.kind == nil)
        expectSend(socket, accepted: false)
        socket.start(); socket.start()
        #expect(opened == 1)
        #expect(PolicyDiscoveryFixture.requests == 0)
        #expect(ws.sent.isEmpty) // preparing a transport never authenticates
        expectSend(socket, text: "{\"type\":\"device.authenticate\"}", accepted: true)
        #expect(ws.sent.count == 1)
        socket.cancel(); ws.onOpen(); ws.onClose(URLError(.networkConnectionLost))
        #expect(ws.cancelled); #expect(opened == 1); #expect(socket.kind == nil)
    }

    @Test func forcedQUICRejectsMissingDiscoveryAndInsecureEndpoint() async throws {
        for url in ["ws://127.0.0.1:8787/v1/device", "wss://relay.invalid/relay/v1/device"] {
            var closed = 0; var fallback = 0; var failure: Error?
            let socket = RelaySocket(url: URL(string: url)!, mode: .quic, configuration: config(),
                makeQUIC: { host, port in Issue.record("Must not prepare without discovery"); return RelaySocket.makeConnection(host: host, port: port) },
                makeWebSocket: { _, _, _, _ in fallback += 1; return PolicyWebSocket() },
                onOpen: { _ in Issue.record("Failed forced QUIC must not open") },
                onClose: { _, error in closed += 1; failure = error })
            defer { socket.cancel() }
            socket.start(); try await until { closed > 0 }
            #expect(closed == 1); #expect(failure is RelayConnectionError); #expect(fallback == 0)
            #expect(socket.kind == nil)
            expectSend(socket, accepted: false)
        }
    }

    @Test func automaticModeFallsBackWhenDiscoveryHasNoQUIC() async throws {
        let ws = PolicyWebSocket(); var opened = 0
        let socket = RelaySocket(url: URL(string: "wss://relay.invalid/relay/v1/device")!, configuration: config(),
            makeWebSocket: { _, _, onOpen, onClose in ws.onOpen = onOpen; ws.onClose = onClose; return ws },
            onOpen: { connection in #expect(connection.kind == .ws); opened += 1 },
            onClose: { _, _ in Issue.record("Unexpected close") })
        defer { socket.cancel() }
        socket.start(); try await until { opened > 0 }
        #expect(opened == 1); #expect(ws.sent.isEmpty)
    }

    @Test(arguments: [RelayTransportMode.auto, .quic])
    func failedQUICOnlyFallsBackInAutomaticMode(mode: RelayTransportMode) async throws {
        let ws = PolicyWebSocket(); var opened = 0; var closed = 0; var fallbacks = 0
        let socket = RelaySocket(url: URL(string: "wss://localhost/relay/v1/device")!, mode: mode, configuration: config(port: 9),
            makeQUIC: { _, _ in RelaySocket.makeConnection(host: "127.0.0.1", port: 9) },
            makeWebSocket: { _, _, onOpen, onClose in fallbacks += 1; ws.onOpen = onOpen; ws.onClose = onClose; return ws },
            onOpen: { _ in opened += 1 }, onClose: { _, _ in closed += 1 })
        defer { socket.cancel() }
        socket.start(); try await until { opened + closed > 0 }
        #expect(opened == (mode == .auto ? 1 : 0)); #expect(closed == (mode == .quic ? 1 : 0))
        #expect(fallbacks == (mode == .auto ? 1 : 0)); #expect(ws.sent.isEmpty)
    }

    @Test func cancellationDuringQUICPreparationCannotStartFallback() async throws {
        var preparing = false; var events = 0
        let socket = RelaySocket(url: URL(string: "wss://localhost/relay/v1/device")!, configuration: config(port: 9),
            makeQUIC: { _, _ in preparing = true; return RelaySocket.makeConnection(host: "127.0.0.1", port: 9) },
            makeWebSocket: { _, _, _, _ in events += 1; return PolicyWebSocket() },
            onOpen: { _ in events += 1 }, onClose: { _, _ in events += 1 })
        defer { socket.cancel() }
        socket.start(); try await until { preparing }; socket.cancel()
        try await Task.sleep(nanoseconds: 1_600_000_000)
        #expect(events == 0); #expect(socket.kind == nil)
    }

    @Test func readyWSFailureNeverReplaysOrStartsQUIC() {
        let ws = PolicyWebSocket(); var closed = 0
        let socket = RelaySocket(url: URL(string: "ws://127.0.0.1/v1/device")!, configuration: config(),
            makeQUIC: { host, port in Issue.record("No redial after ready"); return RelaySocket.makeConnection(host: host, port: port) },
            makeWebSocket: { _, _, onOpen, onClose in ws.onOpen = onOpen; ws.onClose = onClose; return ws },
            onOpen: { _ in }, onClose: { _, _ in closed += 1 })
        defer { socket.cancel() }
        socket.start()
        expectSend(socket, text: "{\"opId\":\"once\"}", accepted: true)
        ws.onClose(URLError(.networkConnectionLost)); ws.onClose(nil)
        #expect(closed == 1); #expect(ws.sent.count == 1); #expect(ws.cancelled)
        expectSend(socket, accepted: false)
    }
}
