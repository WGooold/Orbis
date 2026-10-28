import Foundation
import Security

protocol SecureStorage {
    func deviceIdentity() throws -> DeviceIdentity
    func savePairings(_ pairings: [HostPairing]) throws
    func pairings() -> [HostPairing]
}

final class SecureStore: SecureStorage {
    static let shared = SecureStore()
    private let defaultsKey = "orbis.hostPairings"
    private init() {}

    func deviceIdentity() throws -> DeviceIdentity {
        if let raw = try read(service: "device.identity") { return try DeviceIdentity.load(raw: raw) }
        let identity = DeviceIdentity.generate()
        try save(identity.privateRaw, service: "device.identity")
        return identity
    }

    func savePairings(_ pairings: [HostPairing]) throws {
        let data = try JSONEncoder().encode(pairings)
        try save(data, service: defaultsKey)
    }

    func pairings() -> [HostPairing] {
        guard let data = try? read(service: defaultsKey), let value = try? JSONDecoder().decode([HostPairing].self, from: data) else { return [] }
        return value
    }

    private func save(_ data: Data, service: String) throws {
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: service]
        let attributes: [String: Any] = [kSecValueData as String: data, kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly]
        let status = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if status == errSecSuccess { return }
        guard status == errSecItemNotFound,
              SecItemAdd(query.merging(attributes) { $1 } as CFDictionary, nil) == errSecSuccess else {
            throw PairingError.relay("无法保存安全凭据，请解锁设备后重试。")
        }
    }

    private func read(service: String) throws -> Data? {
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: service, kSecReturnData as String: true, kSecMatchLimit as String: kSecMatchLimitOne]
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess else { throw PairingError.relay("无法读取安全凭据，请解锁设备后重新启动 App。") }
        return result as? Data
    }
}
