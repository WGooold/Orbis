import Foundation
import Testing
@testable import OrbisCore

@MainActor private final class SwitchSocket: RelaySocketConnection {
    let mode: RelayTransportMode
    var kind: RelayTransportKind?
    let opened: (any RelaySocketConnection) -> Void
    let closed: (any RelaySocketConnection, Error?) -> Void
    var sent: [String] = []
    var cancelled = false
    var joined = false
    var holdClose = false
    var closeContinuation: CheckedContinuation<Void, Never>?
    var businessReady = false
    var holdHS3 = false
    var hs3Completion: (@Sendable (Error?) -> Void)?
    var receiver: (@Sendable (Result<RelayMessage, Error>) -> Void)?
    init(_ mode: RelayTransportMode, _ opened: @escaping (any RelaySocketConnection) -> Void,
         _ closed: @escaping (any RelaySocketConnection, Error?) -> Void) {
        self.mode = mode; self.opened = opened; self.closed = closed
    }
    func start() {}
    func ready() { kind = mode == .quic ? .quic : .ws; opened(self) }
    func cancel() { cancelled = true }
    func cancelAndWait() async {
        cancel()
        if holdClose { await withCheckedContinuation { closeContinuation = $0 } }
        joined = true
    }
    func release() { holdClose = false; closeContinuation?.resume(); closeContinuation = nil }
    func send(_ message: RelayMessage, lane: RelayLane, completionHandler: @escaping @Sendable (Error?) -> Void) -> Bool {
        if case .string(let text) = message {
            sent.append(text)
            if holdHS3, let data = text.data(using: .utf8), let frame = try? JSONDecoder().decode(V2Frame.self, from: data),
               frame.envelope.hdr.k == "hs", let plain = try? Base64URL.decode(frame.envelope.ct, label: "test"),
               (try? E2ECrypto.jsonObject(plain)["type"] as? String) == "hs3" {
                hs3Completion = completionHandler; return true
            }
        }
        completionHandler(nil); return true
    }
    func receive(completionHandler: @escaping @Sendable (Result<RelayMessage, Error>) -> Void) { receiver = completionHandler }
    func setBusinessReady(_ ready: Bool) { businessReady = ready }
    var authentications: Int { sent.filter { $0.contains("device.authenticate") }.count }
}

@Suite("Relay-only runtime switching", .serialized) @MainActor
struct RelaySwitchTests {
    private func pairing(_ host: String = "host") -> HostPairing {
        HostPairing(hostId: host, hostName: "test", hostPub: "", pskRoot: Base64URL.encode(Data(repeating: 1, count: 32)),
                    relay: RelayCredential(relayUrl: "wss://relay.invalid", deviceId: "phone", credential: "test"), lan: [])
    }
    private func settle() async { for _ in 0..<30 { await Task.yield() } }

    @Test(arguments: [RelayTransportMode.ws, .quic])
    func prepareFailureCancellationAndRapidChoiceKeepOnlyLatestOwner(initial: RelayTransportMode) async {
        var sockets: [SwitchSocket] = []
        let transport = RelayTransport(relayMode: initial, preferences: nil, makeSocket: { _, mode, opened, closed in
            let socket = SwitchSocket(mode, opened, closed); sockets.append(socket); return socket
        })
        defer { sockets.forEach { $0.release() }; transport.disconnect() }
        transport.connect(pairing: pairing(), identity: .generate(), receive: { _, _ in }, state: { _, _ in })
        let old = sockets[0]; old.ready(); await settle()
        #expect(old.authentications == 1)
        let next: RelayTransportMode = initial == .ws ? .quic : .ws
        transport.setRelayTransportMode(next)
        let failed = sockets[1]
        #expect(failed.sent.isEmpty && !old.cancelled)
        failed.closed(failed, URLError(.cannotConnectToHost))
        #expect(!old.cancelled && transport.relayTransportKind == old.kind)
        #expect(transport.relaySwitchError != nil)
        transport.setRelayTransportMode(next)
        let cancelled = sockets[2]
        transport.setRelayTransportMode(next)
        #expect(sockets.count == 3) // same pending mode is idempotent
        transport.setRelayTransportMode(.auto)
        cancelled.ready(); await settle()
        #expect(cancelled.cancelled && cancelled.sent.isEmpty && !old.cancelled)
        transport.setRelayTransportMode(next)
        let candidate = sockets[3]
        old.holdClose = true; candidate.ready(); await settle()
        #expect(old.cancelled && !old.joined && candidate.sent.isEmpty)
        // Another choice wins while the previous owner's callbacks are draining.
        transport.setRelayTransportMode(initial)
        let winner = sockets[4]; winner.ready(); await settle()
        #expect(winner.sent.isEmpty)
        old.release(); await settle()
        #expect(old.joined && candidate.cancelled && candidate.sent.isEmpty)
        #expect(winner.authentications == 1)
        old.closed(old, URLError(.networkConnectionLost)); candidate.closed(candidate, nil)
        #expect(transport.relayTransportKind == winner.kind)
        #expect(winner.sent.allSatisfy { !$0.contains("opId") })
    }

    @Test func modeIsStoredPerHostAndAnotherHostKeepsItsConnection() async {
        let suite = "orbis-switch-test-\(UUID())"
        let prefs = UserDefaults(suiteName: suite)!
        defer { prefs.removePersistentDomain(forName: suite) }
        var sockets: [SwitchSocket] = []
        let factory: RelayTransport.SocketFactory = { _, mode, opened, closed in
            let socket = SwitchSocket(mode, opened, closed); sockets.append(socket); return socket
        }
        let first = RelayTransport(preferences: prefs, makeSocket: factory)
        let second = RelayTransport(preferences: prefs, makeSocket: factory)
        defer { first.disconnect(); second.disconnect() }
        first.connect(pairing: pairing("a"), identity: .generate(), receive: { _, _ in }, state: { _, _ in })
        second.connect(pairing: pairing("b"), identity: .generate(), receive: { _, _ in }, state: { _, _ in })
        let unrelated = sockets[1]; unrelated.ready(); await settle()
        first.setRelayTransportMode(.quic)
        #expect(!unrelated.cancelled && unrelated.authentications == 1)
        first.disconnect()
        let restored = RelayTransport(preferences: prefs, makeSocket: factory)
        defer { restored.disconnect() }
        restored.connect(pairing: pairing("a"), identity: .generate(), receive: { _, _ in }, state: { _, _ in })
        #expect(sockets.last?.mode == .quic)
        #expect(second.desiredRelayMode == .ws)
    }
    @Test func wsReadinessWaitsForHS3WriteCompletion() async throws {
        var socket: SwitchSocket!
        var secured = 0
        let transport = RelayTransport(relayMode: .ws, preferences: nil, makeSocket: { _, mode, opened, closed in
            socket = SwitchSocket(mode, opened, closed); socket.holdHS3 = true; return socket
        })
        defer { socket.hs3Completion?(URLError(.cancelled)); transport.disconnect() }
        transport.connect(pairing: pairing(), identity: .generate(), receive: { _, _ in }, state: { state, _ in if state == .secured { secured += 1 } })
        socket.ready(); await settle()
        let text = try #require(socket.sent.last)
        let hs1 = try JSONDecoder().decode(V2Frame.self, from: Data(text.utf8)).envelope
        let body = try E2ECrypto.jsonObject(Base64URL.decode(hs1.ct, label: "test.hs1"))
        let devicePublic = try #require(body["ePubD"] as? String)
        let host = DeviceIdentity.generate()
        let shared = try E2ECrypto.sharedSecret(privateKey: host.privateKey, peerPublicRaw: Base64URL.decode(devicePublic, label: "ePubD"))
        let key = E2ECrypto.hkdf(shared, salt: Data(repeating: 1, count: 32), info: "h2d|\(host.publicText)\(devicePublic)")
        let hs2: [String: Any] = ["type": "hs2", "ePubH": host.publicText,
            "macH": Base64URL.encode(E2ECrypto.hmac(key, parts: "hs-h|", host.publicText, devicePublic))]
        let envelope = Envelope(v: 2, hdr: RoutingHeader(k: "hs", room: "host", from: "host", to: "phone", n: 0, ch: nil), ct: Base64URL.encode(try E2ECrypto.jsonData(hs2)))
        let data = try JSONEncoder().encode(V2Frame(type: "v2.frame", protocolVersion: orbisProtocolVersion, envelope: envelope))
        let receive = try #require(socket.receiver); socket.receiver = nil
        receive(.success(.data(data)))
        for _ in 0..<100 { if socket.hs3Completion != nil { break }; try await Task.sleep(nanoseconds: 1_000_000) }
        let completion = try #require(socket.hs3Completion)
        #expect(secured == 0 && !socket.businessReady)
        socket.hs3Completion = nil; completion(nil); await settle()
        #expect(secured == 1 && socket.businessReady)
    }

}
