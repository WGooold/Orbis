import Foundation
import CryptoKit
import Security

struct E2ECryptoError: LocalizedError {
    let message: String
    var errorDescription: String? { message }
}

enum E2ECrypto {
    static let keyBytes = 32
    static let nonceBytes = 12

    static func random(_ count: Int = 32) -> Data {
        var bytes = Data(count: count)
        _ = bytes.withUnsafeMutableBytes { SecRandomCopyBytes(kSecRandomDefault, count, $0.baseAddress!) }
        return bytes
    }

    static func constantTimeEqual(_ left: Data, _ right: Data) -> Bool {
        guard left.count == right.count else { return false }
        var diff: UInt8 = 0
        for (a, b) in zip(left, right) { diff |= a ^ b }
        return diff == 0
    }

    static func hkdf(_ ikm: Data, salt: Data, info: String, length: Int = keyBytes) -> Data {
        let ikmKey = SymmetricKey(data: ikm)
        let derived = HKDF<SHA256>.deriveKey(inputKeyMaterial: ikmKey, salt: salt, info: Data(info.utf8), outputByteCount: length)
        return derived.withUnsafeBytes { Data($0) }
    }

    static func hmac(_ key: Data, parts: String...) -> Data {
        let mac = HMAC<SHA256>.authenticationCode(for: Data(parts.joined().utf8), using: SymmetricKey(data: key))
        return Data(mac)
    }

    static func x25519Private(_ raw: Data) throws -> Curve25519.KeyAgreement.PrivateKey {
        guard raw.count == keyBytes else { throw E2ECryptoError(message: "X25519 私钥长度无效") }
        return try Curve25519.KeyAgreement.PrivateKey(rawRepresentation: raw)
    }

    static func sharedSecret(privateKey: Curve25519.KeyAgreement.PrivateKey, peerPublicRaw: Data) throws -> Data {
        guard peerPublicRaw.count == keyBytes else { throw E2ECryptoError(message: "X25519 公钥长度无效") }
        let peer = try Curve25519.KeyAgreement.PublicKey(rawRepresentation: peerPublicRaw)
        let secret = try privateKey.sharedSecretFromKeyAgreement(with: peer)
        let data = secret.withUnsafeBytes { Data($0) }
        guard data.contains(where: { $0 != 0 }) else { throw E2ECryptoError(message: "X25519 输出全零") }
        return data
    }

    static func seal(_ plaintext: Data, key: Data, nonce: Data, aad: Data) throws -> Data {
        guard key.count == keyBytes, nonce.count == nonceBytes else { throw E2ECryptoError(message: "AEAD 参数长度无效") }
        let box = try AES.GCM.seal(plaintext, using: SymmetricKey(data: key), nonce: try AES.GCM.Nonce(data: nonce), authenticating: aad)
        return box.ciphertext + box.tag
    }

    static func open(_ sealed: Data, key: Data, nonce: Data, aad: Data) throws -> Data {
        guard key.count == keyBytes, nonce.count == nonceBytes, sealed.count >= 16 else { throw E2ECryptoError(message: "AEAD 参数无效") }
        let split = sealed.count - 16
        let ciphertext = sealed.prefix(split)
        let tag = sealed.suffix(16)
        let box = try AES.GCM.SealedBox(nonce: AES.GCM.Nonce(data: nonce), ciphertext: Data(ciphertext), tag: Data(tag))
        do { return try AES.GCM.open(box, using: SymmetricKey(data: key), authenticating: aad) }
        catch { throw E2ECryptoError(message: "AEAD 认证失败") }
    }

    static func jsonData(_ value: Any) throws -> Data {
        guard JSONSerialization.isValidJSONObject(value) else { throw E2ECryptoError(message: "JSON 不可编码") }
        return try JSONSerialization.data(withJSONObject: value, options: [])
    }

    static func jsonObject(_ data: Data) throws -> [String: Any] {
        let value = try JSONSerialization.jsonObject(with: data, options: [])
        guard let object = value as? [String: Any] else { throw E2ECryptoError(message: "JSON 不是对象") }
        return object
    }

    static func frameNonce(channel: String, sequence: UInt64) throws -> Data {
        let slot: UInt32
        switch channel { case "ctl": slot = 1; case "msg": slot = 2; case "bulk": slot = 3; default: throw E2ECryptoError(message: "未知 channel") }
        var data = Data()
        data.append(UInt8((slot >> 24) & 0xff)); data.append(UInt8((slot >> 16) & 0xff)); data.append(UInt8((slot >> 8) & 0xff)); data.append(UInt8(slot & 0xff))
        for shift in stride(from: 56, through: 0, by: -8) { data.append(UInt8((sequence >> UInt64(shift)) & 0xff)) }
        return data
    }
}

struct DeviceIdentity {
    let privateKey: Curve25519.KeyAgreement.PrivateKey
    var publicRaw: Data { privateKey.publicKey.rawRepresentation }
    var privateRaw: Data { privateKey.rawRepresentation }
    var publicText: String { Base64URL.encode(publicRaw) }

    static func generate() -> DeviceIdentity { DeviceIdentity(privateKey: Curve25519.KeyAgreement.PrivateKey()) }
    static func load(raw: Data) throws -> DeviceIdentity { DeviceIdentity(privateKey: try E2ECrypto.x25519Private(raw)) }
}
