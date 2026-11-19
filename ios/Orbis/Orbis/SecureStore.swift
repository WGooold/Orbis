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
    private let namespace: String
    private init() { namespace = "" }
    #if DEBUG
    init(testNamespace: String) {
        precondition(testNamespace.hasPrefix("orbis.pushqa."))
        namespace = testNamespace + "."
    }
    func clearPushTestingNamespace() {
        guard namespace.hasPrefix("orbis.pushqa.") else { return }
        for name in ["device.identity", defaultsKey, "orbis.pendingPushRemovals", "orbis.liveActivityRegistrations"] {
            let service = namespace + name
            SecItemDelete([kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
                kSecAttrAccount as String: service] as CFDictionary)
        }
    }
    #endif

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

    func pendingPushRemovals() throws -> [PushRegistrationTarget] {
        guard let data = try read(service: "orbis.pendingPushRemovals") else { return [] }
        return try JSONDecoder().decode([PushRegistrationTarget].self, from: data)
    }

    func savePendingPushRemovals(_ targets: [PushRegistrationTarget]) throws {
        try save(JSONEncoder().encode(targets), service: "orbis.pendingPushRemovals")
    }

    func liveActivityRegistrations() throws -> [LiveActivityRegistrationTarget] {
        guard let data = try read(service: "orbis.liveActivityRegistrations") else { return [] }
        return try JSONDecoder().decode([LiveActivityRegistrationTarget].self, from: data)
    }

    func saveLiveActivityRegistrations(_ targets: [LiveActivityRegistrationTarget]) throws {
        try save(JSONEncoder().encode(targets), service: "orbis.liveActivityRegistrations")
    }

    func voiceCleanupAPIConfig() throws -> VoiceCleanupAPIConfig? {
        guard let data = try read(service: "orbis.voiceCleanupAPI.v1") else { return nil }
        return try JSONDecoder().decode(VoiceCleanupAPIConfig.self, from: data)
    }

    func saveVoiceCleanupAPIConfig(_ config: VoiceCleanupAPIConfig?) throws {
        let name = "orbis.voiceCleanupAPI.v1"
        if let config {
            try save(JSONEncoder().encode(config), service: name)
        } else {
            let service = namespace + name
            let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: service]
            let status = SecItemDelete(query as CFDictionary)
            guard status == errSecSuccess || status == errSecItemNotFound else {
                throw PairingError.relay(L10n.tr("无法保存安全凭据，请解锁设备后重试。"))
            }
        }
    }

    private func save(_ data: Data, service: String) throws {
        let service = namespace + service
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: service]
        let attributes: [String: Any] = [kSecValueData as String: data, kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly]
        let status = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if status == errSecSuccess { return }
        guard status == errSecItemNotFound,
              SecItemAdd(query.merging(attributes) { $1 } as CFDictionary, nil) == errSecSuccess else {
            throw PairingError.relay(L10n.tr("无法保存安全凭据，请解锁设备后重试。"))
        }
    }

    private func read(service: String) throws -> Data? {
        let service = namespace + service
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: service, kSecReturnData as String: true, kSecMatchLimit as String: kSecMatchLimitOne]
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess else { throw PairingError.relay(L10n.tr("无法读取安全凭据，请解锁设备后重新启动 App。")) }
        return result as? Data
    }
}
