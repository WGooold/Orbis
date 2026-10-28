import Foundation
import Testing
@testable import OrbisCore

// Public, deterministic inputs from scripts/e2e-vectors.mjs and the Android
// E2eVectors fixture. No test reads or overwrites the user's Keychain.
private enum Vectors {
    static let devicePrivate = "5dab087e624a8a4b79e17f8b83800ee66f3bb1292618b6fd1c2f8b27ff88e0eb"
    static let hostPublic = "hSDwCYkwp1R0i33ctD73Wg2_Og0mOBr066SpjqqbTmo"
    static let devicePublic = "3p7bfXt9wbTTW2HC7OQ1Nz-DQ8hbeGdNrfx-FG-IK08"
    static let root = "Xc5yaEsPIReHbncWPXU1GrW_YpUGNcpX5p1Zb-9dEwE"
    static let confirm = "-G7rO7iQuhdH7rmm3agDYiIR8XmedYKDmimm7DAlHEE"
    static let nonceH = "MzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzM"
    static let pairMacH = "mhBLskBz0yVpG0VOkZBT9OPYN-VBFtIe8n5lLbbcBOw"
    static let hostEphemeral = "OKtmS9hvd9fma92a4HkpE6lP2LM6EmACfktGwfSITGc"
    static let deviceEphemeral = "_y7kVgHsG2cxDHeQQEWFrmlzMe7hwfjPJBlzHB__Pms"
    static let keyH2D = "-Kwx43HwDDM6EXM8p80AX_mmYwMamhFMm089UZM1rWI"
    static let keyD2H = "a2vzVQwGvTKpwawGTEw6-qEO1HXnUC5P9uTSDTd6WgY"
    static let handshakeMacH = "phYx4BZpBVq0X8qN-_qZ2tMZLobFaYILeNZfd0EDbVA"
    static let handshakeMacD = "Lkw-uItTWBebh0ONoovU7ypS7-2EjpS3Lj5XmOk9TBM"

    static func keys() throws -> SessionKeys {
        SessionKeys(hostToDevice: try Base64URL.decode(keyH2D), deviceToHost: try Base64URL.decode(keyD2H))
    }
    static func identity() throws -> DeviceIdentity {
        let bytes = stride(from: 0, to: devicePrivate.count, by: 2).map { offset -> UInt8 in
            let start = devicePrivate.index(devicePrivate.startIndex, offsetBy: offset)
            return UInt8(devicePrivate[start..<devicePrivate.index(start, offsetBy: 2)], radix: 16)!
        }
        return try DeviceIdentity.load(raw: Data(bytes))
    }
    static func qr(exp: Int64 = Int64(Date().timeIntervalSince1970) + 120) -> PairingQR {
        PairingQR(v: 2, relayUrl: "wss://relay.example", code: "TESTCODE", hostId: "host-1", hostName: "Test Host",
            hostPub: hostPublic, psk: Base64URL.encode(Data(repeating: 0x11, count: 32)), exp: exp)
    }
}

@Suite("Protocol compatibility")
struct ProtocolTests {
    @Test func pairingMatchesNodeAndAndroidVectors() throws {
        let identity = try Vectors.identity()
        #expect(identity.publicText == Vectors.devicePublic)
        let pair = try DevicePairingSession.create(qr: Vectors.qr(), deviceId: "device-1", identity: identity, nonce: Data(repeating: 0x22, count: 32))
        #expect(Base64URL.encode(pair.pskRoot) == Vectors.root)
        #expect(Base64URL.encode(pair.confirmKey) == Vectors.confirm)
        #expect(pair.request["macD"] as? String == "ywudy3_oqEafVQ1k7OtqWzUvrOG9ETuIwgiSAE0Em3c")
        try pair.verifyAccept(["type": "pair-accept", "hostId": "host-1", "nonceH": Vectors.nonceH, "macH": Vectors.pairMacH], expectedHostId: "host-1")
        #expect(throws: (any Error).self) {
            try pair.verifyAccept(["type": "pair-accept", "hostId": "another-host", "nonceH": Vectors.nonceH, "macH": Vectors.pairMacH], expectedHostId: "host-1")
        }
    }

    @Test func handshakeMatchesNodeAndRejectsForgedHost() throws {
        let ephemeral = try DeviceIdentity.load(raw: Data(repeating: 0x44, count: 32))
        let handshake = DeviceHandshake(pskRoot: try Base64URL.decode(Vectors.root), ephemeral: ephemeral)
        #expect(handshake.hs1()["ePubD"] as? String == Vectors.deviceEphemeral)
        let reply = try handshake.accept(["type": "hs2", "ePubH": Vectors.hostEphemeral, "macH": Vectors.handshakeMacH])
        #expect(reply["macD"] as? String == Vectors.handshakeMacD)
        let keys = try #require(handshake.keys)
        #expect(Base64URL.encode(keys.hostToDevice) == Vectors.keyH2D)
        #expect(Base64URL.encode(keys.deviceToHost) == Vectors.keyD2H)
        let forged = DeviceHandshake(pskRoot: try Base64URL.decode(Vectors.root), ephemeral: ephemeral)
        #expect(throws: (any Error).self) { try forged.accept(["type": "hs2", "ePubH": Vectors.hostEphemeral, "macH": Vectors.pairMacH]) }
        #expect(forged.keys == nil)
    }

    @Test func aadAndCiphertextMatchWireVectors() throws {
        let channel = E2EChannel(keys: try Vectors.keys())
        let envelope = try channel.seal(room: "host-1", from: "device-1", to: "host-1", channel: "ctl", payload: Data("{\"type\":\"device.ready\"}".utf8))
        #expect(String(decoding: envelope.hdr.aad(), as: UTF8.self) == "k=data\nroom=host-1\nfrom=device-1\nto=host-1\nch=ctl\nn=1")
        #expect(envelope.ct == "D9kX4K5xUPHFcmADHFlly_cs6SipR2RIN0tzKFh3Q3JA0mvUw7T8")
        #expect(try E2ECrypto.frameNonce(channel: "msg", sequence: 1) == Data([0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 1]))
        let messageEnvelope = try channel.seal(room: "host-1", from: "device-1", to: "host-1", channel: "msg", payload: Data("hello".utf8))
        #expect(messageEnvelope.hdr.n == 1)
    }

    @Test func replayAndTamperingDoNotPoisonReceiveSequences() throws {
        let keys = try Vectors.keys()
        // A host-side channel has the directions reversed.
        let host = E2EChannel(keys: SessionKeys(hostToDevice: keys.deviceToHost, deviceToHost: keys.hostToDevice))
        let device = E2EChannel(keys: keys)
        let first = try host.seal(room: "host-1", from: "host-1", to: "device-1", channel: "ctl", payload: Data("first".utf8))
        let tampered = Envelope(v: 2, hdr: first.hdr, ct: Base64URL.encode(Data(repeating: 7, count: 32)))
        #expect(throws: (any Error).self) { try device.open(tampered) }
        #expect(try device.open(first) == Data("first".utf8))
        #expect(try device.open(first) == nil)
        // A gap is allowed; channels are independent and only authenticated frames advance a high-water mark.
        _ = try host.seal(room: "host-1", from: "host-1", to: "device-1", channel: "ctl", payload: Data("lost".utf8))
        let third = try host.seal(room: "host-1", from: "host-1", to: "device-1", channel: "ctl", payload: Data("third".utf8))
        #expect(try device.open(third) == Data("third".utf8))
        let message = try host.seal(room: "host-1", from: "host-1", to: "device-1", channel: "msg", payload: Data("msg".utf8))
        #expect(try device.open(message) == Data("msg".utf8))
    }

    @Test func piecesReassembleOutOfOrderBeforeAuthentication() throws {
        let keys = try Vectors.keys()
        let host = E2EChannel(keys: SessionKeys(hostToDevice: keys.deviceToHost, deviceToHost: keys.hostToDevice))
        let payload = Data(String(repeating: "你好，Orbis\n", count: 5000).utf8)
        let original = try host.seal(room: "host-1", from: "host-1", to: "device-1", channel: "msg", payload: payload)
        let fragments = EnvelopePieces.fragment(original)
        #expect(fragments.count > 1)
        let receiver = EnvelopeReassembler()
        var completed: Envelope?
        for fragment in fragments.reversed() {
            let wire = try JSONEncoder().encode(fragment)
            completed = receiver.accept(try JSONDecoder().decode(Envelope.self, from: wire)) ?? completed
        }
        #expect(completed == original)
        #expect(receiver.pendingMessages == 0)
        #expect(receiver.bufferedChars == 0)
        #expect(try E2EChannel(keys: keys).open(#require(completed)) == payload)
    }

    @Test func piecesAreBoundedExpireAndRejectConflicts() {
        var time: TimeInterval = 0
        let receiver = EnvelopeReassembler(maxMessages: 2, maxChars: 20, timeout: 5, now: { time })
        func piece(_ mid: String, _ index: Int = 0, _ text: String = "AAAA", _ sequence: UInt64 = 1) -> Envelope {
            Envelope(v: 2, hdr: RoutingHeader(k: "piece", room: "h", from: "h", to: "d", n: sequence, ch: "msg", ik: "data", mid: mid, idx: index, last: false), ct: text)
        }
        #expect(receiver.accept(piece("a")) == nil)
        #expect(receiver.accept(piece("a")) == nil)
        #expect(receiver.bufferedChars == 4)
        #expect(receiver.accept(piece("a", 1, "BBBB", 2)) == nil)
        #expect(receiver.pendingMessages == 0)
        _ = receiver.accept(piece("b")); _ = receiver.accept(piece("c")); _ = receiver.accept(piece("d"))
        #expect(receiver.pendingMessages == 2)
        #expect(receiver.bufferedChars <= 20)
        time = 6
        receiver.sweep()
        #expect(receiver.pendingMessages == 0)
        #expect(receiver.bufferedChars == 0)
    }

    @Test func qrExpiryAndRelayURLsAreValidated() throws {
        let text = String(decoding: try JSONEncoder().encode(Vectors.qr()), as: UTF8.self)
        #expect(try PairingQR.parse(text).hostId == "host-1")
        let expired = String(decoding: try JSONEncoder().encode(Vectors.qr(exp: 1)), as: UTF8.self)
        #expect(throws: (any Error).self) { try PairingQR.parse(expired) }
        #expect(RelayURL.isSupported("wss://relay.example"))
        #expect(RelayURL.isSupported("ws://192.168.1.2:8787"))
        #expect(RelayURL.isSupported("ws://[::1]:8787"))
        #expect(!RelayURL.isSupported("ws://public.example"))
        #expect(!RelayURL.isSupported("wss://user:secret@relay.example"))
        #expect(!RelayURL.isSupported("wss://relay.example/?credential=secret"))
        #expect(RelayURL.endpoint("wss://relay.example/", path: "v1/pairings", webSocket: false)?.absoluteString == "https://relay.example/v1/pairings")
    }

    @Test func pairingAcceptsReverseProxyRelayPathsAndPreservesEndpoints() throws {
        let original = Vectors.qr()
        for base in ["wss://relay.example/relay", "wss://relay.example/relay/"] {
            let qr = PairingQR(v: original.v, relayUrl: base, code: original.code,
                hostId: original.hostId, hostName: original.hostName,
                hostPub: original.hostPub, psk: original.psk, exp: original.exp)
            let text = String(decoding: try JSONEncoder().encode(qr), as: UTF8.self)
            #expect(try PairingQR.parse(text).relayUrl == base)
            #expect(RelayURL.endpoint(base, path: "v1/pairings", webSocket: false)?.absoluteString == "https://relay.example/relay/v1/pairings")
            #expect(RelayURL.endpoint(base, path: "v1/device", webSocket: true)?.absoluteString == "wss://relay.example/relay/v1/device")
        }
        #expect(RelayURL.endpoint("ws://192.168.1.2:8787/nested/relay/", path: "v1/pairings", webSocket: false)?.absoluteString == "http://192.168.1.2:8787/nested/relay/v1/pairings")
        #expect(RelayURL.endpoint("wss://relay.example/team%2Fone/relay", path: "v1/device", webSocket: true)?.absoluteString == "wss://relay.example/team%2Fone/relay/v1/device")
        #expect(!RelayURL.isSupported("ws://public.example/relay"))
        #expect(!RelayURL.isSupported("wss://user:secret@relay.example/relay"))
        #expect(!RelayURL.isSupported("wss://relay.example/relay?credential=secret"))
        #expect(!RelayURL.isSupported("wss://relay.example/relay#fragment"))
    }
}
