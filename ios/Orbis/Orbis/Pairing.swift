import Foundation

struct DevicePairingSession {
    let nonceD: String
    let pskRoot: Data
    let confirmKey: Data
    let request: [String: Any]

    static func create(qr: PairingQR, deviceId: String, identity: DeviceIdentity, nonce: Data = E2ECrypto.random()) throws -> DevicePairingSession {
        guard nonce.count == 32 else { throw PairingError.invalidQR }
        let hostPub = try Base64URL.decodeFixed(qr.hostPub, bytes: 32, label: "hostPub")
        let psk = try Base64URL.decodeFixed(qr.psk, bytes: 32, label: "psk")
        let shared = try E2ECrypto.sharedSecret(privateKey: identity.privateKey, peerPublicRaw: hostPub)
        let pskRoot = E2ECrypto.hkdf(shared, salt: Data("pi-remote/v2".utf8), info: "root|\(Base64URL.encode(hostPub))\(identity.publicText)")
        let confirm = E2ECrypto.hkdf(psk, salt: pskRoot, info: "pair-confirm|\(Base64URL.encode(hostPub))\(identity.publicText)")
        let nonceD = Base64URL.encode(nonce)
        let mac = E2ECrypto.hmac(confirm, parts: "device|", nonceD)
        let request: [String: Any] = ["type": "pair-request", "devicePub": identity.publicText, "deviceId": deviceId, "nonceD": nonceD, "macD": Base64URL.encode(mac)]
        return DevicePairingSession(nonceD: nonceD, pskRoot: pskRoot, confirmKey: confirm, request: request)
    }

    func verifyAccept(_ body: [String: Any], expectedHostId: String) throws {
        guard body["type"] as? String == "pair-accept",
              let hostId = body["hostId"] as? String, hostId == expectedHostId,
              let nonceH = body["nonceH"] as? String, let macText = body["macH"] as? String else { throw PairingError.handshake("配对响应格式无效或主机身份不匹配") }
        _ = try Base64URL.decodeFixed(nonceH, bytes: 32, label: "nonceH")
        let expected = E2ECrypto.hmac(confirmKey, parts: "host|", nonceD, nonceH)
        let actual = try Base64URL.decode(macText, label: "macH")
        guard E2ECrypto.constantTimeEqual(expected, actual) else { throw PairingError.handshake("配对确认失败：电脑身份不匹配") }
    }
}
