import Foundation
import Testing
@testable import OrbisCore

@Suite("P2P encrypted Path") @MainActor
struct P2PTransportTests {
    @MainActor private final class Peer: P2PPeer {
        var event: ((P2PPeerEvent) -> Void)?
        var bufferedAmount: UInt64 = 0
        var isDataChannelOpen = false
        var isGatheringComplete = false
        var localDescription: String?
        var sent: [Data] = []
        var offers: [String] = []
        var closes = 0
        var sendSucceeds = true
        func acceptOffer(_ sdp: String) async throws {
            offers.append(sdp)
            // The native callback may precede the setLocalDescription completion.
            isGatheringComplete = true; localDescription = "answer-with-all-candidates"
            event?(.gatheringComplete)
            await Task.yield()
        }
        func send(_ data: Data) -> Bool { if sendSucceeds { sent.append(data) }; return sendSucceeds }
        func close() { closes += 1; isDataChannelOpen = false }
        func inject(_ envelope: Envelope) throws {
            event?(.received(try JSONEncoder().encode(V2Frame(type: "v2.frame", protocolVersion: orbisProtocolVersion, envelope: envelope)), binary: false))
        }
    }
    private let root = Data(repeating: 0x42, count: 32)
    private func transport(_ peer: Peer, grace: UInt64 = 5_000_000_000, timeout: UInt64 = 15_000_000_000) -> P2PTransport {
        P2PTransport(peer: peer, hostId: "host", deviceId: "device", root: root,
                     disconnectGraceNanoseconds: grace, attemptTimeoutNanoseconds: timeout)
    }
    private func authenticate(_ transport: P2PTransport, _ peer: Peer) throws -> E2EChannel {
        peer.isDataChannelOpen = true; peer.event?(.dataChannelOpen)
        let first = try JSONDecoder().decode(V2Frame.self, from: #require(peer.sent.last))
        let hs1 = try E2ECrypto.jsonObject(Base64URL.decode(first.envelope.ct))
        let ePubD = try #require(hs1["ePubD"] as? String), host = DeviceIdentity.generate()
        let shared = try E2ECrypto.sharedSecret(privateKey: host.privateKey, peerPublicRaw: Base64URL.decode(ePubD))
        let h2d = E2ECrypto.hkdf(shared, salt: root, info: "h2d|\(host.publicText)\(ePubD)")
        let d2h = E2ECrypto.hkdf(shared, salt: root, info: "d2h|\(host.publicText)\(ePubD)")
        let body: [String: Any] = ["type": "hs2", "ePubH": host.publicText,
            "macH": Base64URL.encode(E2ECrypto.hmac(h2d, parts: "hs-h|", host.publicText, ePubD))]
        try peer.inject(Envelope(v: 2, hdr: RoutingHeader(k: "hs", room: "host", from: "host", to: "device", n: 0, ch: nil), ct: Base64URL.encode(E2ECrypto.jsonData(body))))
        let last = try JSONDecoder().decode(V2Frame.self, from: #require(peer.sent.last))
        let hs3 = try E2ECrypto.jsonObject(Base64URL.decode(last.envelope.ct))
        #expect(hs3["macD"] as? String == Base64URL.encode(E2ECrypto.hmac(d2h, parts: "hs-d|", host.publicText, ePubD)))
        #expect(transport.isReady)
        return E2EChannel(keys: SessionKeys(hostToDevice: d2h, deviceToHost: h2d))
    }

    @Test func completeICEAnswerIsSentOnceEvenIfGatheringCallbackPrecedesLocalCommit() async throws {
        let peer = Peer(), path = transport(peer)
        defer { path.close() }
        var answers: [[String: Any]] = []
        path.signal = { answers.append($0); return true }
        path.start(); path.acceptOffer("host-offer-with-candidates")
        try await waitUntil { answers.count == 1 }
        peer.event?(.gatheringComplete); path.acceptOffer("duplicate-offer")
        #expect(peer.offers == ["host-offer-with-candidates"])
        #expect(answers.first?["type"] as? String == "p2p.answer")
        #expect(answers.first?["sdp"] as? String == "answer-with-all-candidates")
    }

    @Test func independentHandshakeReplayProtectionFragmentedHistoryBinaryAndPingInteroperate() throws {
        let peer = Peer(), path = transport(peer)
        defer { path.close() }
        let host = try authenticate(path, peer)
        var received: [(Data, String?, Bool)] = []
        path.receive = { received.append(($0, $1, $2)) }
        let payload = Data(String(repeating: "P2P 历史", count: 4000).utf8)
        let history = try host.seal(room: "host", from: "host", to: "device", channel: "msg", payload: payload)
        for piece in EnvelopePieces.fragment(history).reversed() { try peer.inject(piece) }
        try peer.inject(history) // Replay does not duplicate already applied messages.
        #expect(received.count == 1 && received.first?.0 == payload && received.first?.1 == "msg")
        let bytes = Data([0, 1, 0xff, 0x80])
        try peer.inject(host.seal(kind: "bin", room: "host", from: "host", to: "device", channel: "bulk", payload: bytes))
        #expect(received.last?.0 == bytes && received.last?.2 == true)
        try peer.inject(host.seal(kind: "ping", room: "host", from: "host", to: "device", channel: "ctl", payload: bytes))
        let pong = try JSONDecoder().decode(V2Frame.self, from: #require(peer.sent.last))
        #expect(pong.envelope.hdr.k == "ping")
        #expect(try host.open(pong.envelope) == bytes)
        peer.event?(.received(bytes, binary: true))
        #expect(received.count == 2) // Bare transport binary never reaches the file consumer.
    }

    @Test func controlPreemptsBufferedBulkAndAllPiecesRemainOrderedWithinChannel() throws {
        let peer = Peer(), path = transport(peer)
        defer { path.close() }
        let host = try authenticate(path, peer), start = peer.sent.count
        peer.bufferedAmount = 64 * 1024
        let payload = Data(repeating: 7, count: 100_000)
        #expect(path.sendBinary(payload)); #expect(peer.sent.count == start)
        #expect(path.send(["type": "command", "text": "control"]))
        #expect(peer.sent.count == start + 1)
        let command = try JSONDecoder().decode(V2Frame.self, from: #require(peer.sent.last))
        #expect(command.envelope.hdr.ch == "ctl")
        let optionalCommand = try host.open(command.envelope)
        let plainCommand = try #require(optionalCommand)
        #expect(try E2ECrypto.jsonObject(plainCommand)["text"] as? String == "control")
        peer.bufferedAmount = 0; peer.event?(.bufferedAmountChanged)
        let reassembler = EnvelopeReassembler(); var complete: Envelope?
        for bytes in peer.sent.dropFirst(start + 1) {
            #expect(bytes.count < 9 * 1024)
            let piece = try JSONDecoder().decode(V2Frame.self, from: bytes)
            complete = reassembler.accept(piece.envelope) ?? complete
        }
        #expect(try host.open(#require(complete)) == payload)
    }

    @Test func disconnectGraceCanRecoverAndTerminalFailureClosesExactlyOnce() async throws {
        let peer = Peer(), path = transport(peer, grace: 2_000_000)
        _ = try authenticate(path, peer)
        var downs = 0
        path.state = { ready, _ in if !ready { downs += 1 } }
        peer.event?(.disconnected); peer.event?(.connected)
        try await Task.sleep(nanoseconds: 5_000_000)
        #expect(path.isReady && downs == 0)
        peer.event?(.disconnected)
        try await waitUntil { downs == 1 }
        #expect(peer.closes == 1 && !path.isReady)
        peer.event?(.failed("late")); path.close()
        #expect(downs == 1 && peer.closes == 1)
    }

    @Test func negotiationTimeoutWrongRoutingAndUnsentAnswerCannotEstablishAPath() async throws {
        let peer = Peer(), path = transport(peer, timeout: 1_000_000)
        var failure: String?
        path.state = { _, reason in failure = reason }
        path.start()
        try await waitUntil { failure != nil }
        #expect(failure == "p2p.attempt_timeout" && peer.closes == 1)
        let wrong = Peer(), other = transport(wrong)
        wrong.isDataChannelOpen = true; wrong.event?(.dataChannelOpen)
        try wrong.inject(Envelope(v: 2, hdr: RoutingHeader(k: "hs", room: "other-host", from: "other-host", to: "device", n: 0, ch: nil), ct: "AAAA"))
        #expect(wrong.closes == 1 && !other.isReady)
        let failedSignal = Peer(), pending = transport(failedSignal)
        pending.signal = { _ in false }; pending.acceptOffer("offer")
        try await waitUntil { failedSignal.closes == 1 }
        #expect(!pending.isReady)
    }

    @Test func relaySTUNMatchesAndroidOriginAndHandlesIPv6() {
        #expect(RelaySTUN.server("wss://orbising.com/relay") == "stun:45.58.185.226:3478")
        #expect(RelaySTUN.server("wss://ORBISING.COM/relay") == "stun:45.58.185.226:3478")
        #expect(RelaySTUN.server("wss://relay.example.com/relay") == "stun:relay.example.com:3478")
        #expect(RelaySTUN.server("wss://orbising.com.example.com") == "stun:orbising.com.example.com:3478")
        #expect(RelaySTUN.server("ws://[::1]:8787") == "stun:[::1]:3478")
        #expect(RelaySTUN.server("not a URL") == nil)
    }

    private func waitUntil(_ condition: @escaping @MainActor () -> Bool) async throws {
        let deadline = Date().addingTimeInterval(1)
        while !condition() && Date() < deadline { try await Task.sleep(nanoseconds: 1_000_000) }
        try #require(condition())
    }
}
