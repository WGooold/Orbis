import Foundation

struct SessionKeys: Sendable {
    let hostToDevice: Data
    let deviceToHost: Data
    var historyStreams = false
}

final class DeviceHandshake {
    private let pskRoot: Data
    private let ephemeral: DeviceIdentity
    private let supportsHistoryStreams: Bool
    private(set) var keys: SessionKeys?

    init(pskRoot: Data, ephemeral: DeviceIdentity = .generate(), supportsHistoryStreams: Bool = false) {
        self.supportsHistoryStreams = supportsHistoryStreams
        self.pskRoot = pskRoot
        self.ephemeral = ephemeral
    }
    func hs1() -> [String: Any] { ["type": "hs1", "ePubD": ephemeral.publicText] }

    func accept(_ body: [String: Any]) throws -> [String: Any] {
        guard body["type"] as? String == "hs2",
              let pubText = body["ePubH"] as? String, let macText = body["macH"] as? String else { throw PairingError.handshake(L10n.tr("握手响应格式无效")) }
        let hostPub = try Base64URL.decodeFixed(pubText, bytes: 32, label: "ePubH")
        let shared = try E2ECrypto.sharedSecret(privateKey: ephemeral.privateKey, peerPublicRaw: hostPub)
        var keys = SessionKeys(
            hostToDevice: E2ECrypto.hkdf(shared, salt: pskRoot, info: "h2d|\(pubText)\(ephemeral.publicText)"),
            deviceToHost: E2ECrypto.hkdf(shared, salt: pskRoot, info: "d2h|\(pubText)\(ephemeral.publicText)")
        )
        let expected = E2ECrypto.hmac(keys.hostToDevice, parts: "hs-h|", pubText, ephemeral.publicText)
        guard let actual = try? Base64URL.decode(macText, label: "macH"), E2ECrypto.constantTimeEqual(expected, actual) else { throw PairingError.handshake(L10n.tr("握手认证失败")) }
        if supportsHistoryStreams, body["historyStreams"] != nil {
            let expectedCapability = E2ECrypto.hmac(keys.hostToDevice, parts: "history-streams-v1|", pubText, ephemeral.publicText)
            guard body["historyStreams"] as? String == "v1", let capText = body["historyMac"] as? String,
                  let cap = try? Base64URL.decode(capText, label: "historyMac"), E2ECrypto.constantTimeEqual(expectedCapability, cap) else {
                throw PairingError.handshake("history streams capability authentication failed")
            }
            keys.historyStreams = true
        }
        self.keys = keys
        var result: [String: Any] = ["type": "hs3", "macD": Base64URL.encode(E2ECrypto.hmac(keys.deviceToHost, parts: "hs-d|", pubText, ephemeral.publicText, keys.historyStreams ? "|history-streams-v1" : ""))]
        if keys.historyStreams { result["historyStreams"] = "v1" }
        return result
    }
}

final class E2EChannel {
    let keys: SessionKeys
    private var sendSequences: [String: UInt64] = [:]
    private var receiveSequences: [String: UInt64] = [:]
    // `seal` runs on the socket send queue while `open` runs from URLSession's
    // receive callback. Keep the per-channel sequence maps consistent across
    // those two execution contexts.
    private let lock = NSLock()
    init(keys: SessionKeys) { self.keys = keys }

    func seal(kind: String = "data", room: String, from: String, to: String, channel: String, payload: Data) throws -> Envelope {
        lock.lock(); defer { lock.unlock() }
        guard ["data", "ping", "bin"].contains(kind), (sendSequences[channel] ?? 0) < 9_007_199_254_740_991 else {
            throw E2ECryptoError(message: L10n.tr("加密帧类型或序号无效"))
        }
        try requireNegotiated(channel)
        let n = (sendSequences[channel] ?? 0) + 1
        let hdr = RoutingHeader(k: kind, room: room, from: from, to: to, n: n, ch: channel)
        let sealed = try E2ECrypto.seal(payload, key: keys.deviceToHost, nonce: E2ECrypto.frameNonce(channel: channel, sequence: n), aad: hdr.aad())
        sendSequences[channel] = n
        return Envelope(v: 2, hdr: hdr, ct: Base64URL.encode(sealed))
    }

    private func requireNegotiated(_ channel: String) throws {
        if ["history", "catchup"].contains(channel), !keys.historyStreams { throw E2ECryptoError(message: "history streams were not negotiated") }
    }

    func open(_ envelope: Envelope) throws -> Data? {
        lock.lock(); defer { lock.unlock() }
        guard envelope.v == 2, ["data", "ping", "bin"].contains(envelope.hdr.k), envelope.hdr.n <= 9_007_199_254_740_991 else {
            throw E2ECryptoError(message: L10n.tr("加密帧类型或序号无效"))
        }
        guard let channel = envelope.hdr.ch else { throw PairingError.handshake(L10n.tr("加密帧缺少 channel")) }
        try requireNegotiated(channel)
        let last = receiveSequences[channel] ?? 0
        guard envelope.hdr.n > last else { return nil }
        let sealed = try Base64URL.decode(envelope.ct, label: "ct")
        let plain = try E2ECrypto.open(sealed, key: keys.hostToDevice, nonce: E2ECrypto.frameNonce(channel: channel, sequence: envelope.hdr.n), aad: envelope.hdr.aad())
        receiveSequences[channel] = envelope.hdr.n
        return plain
    }
}
