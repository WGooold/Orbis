import Foundation
import CryptoKit

/// SC111/112: one local source identity across notifications and ActivityKit.
/// Only these display values may be shared with the notification extension.
struct NotificationSource: Codable, Hashable, Sendable {
    let name: String
    let compactName: String
    let badge: String
    let pairingKey: String

    struct Input: Sendable {
        let hostId: String
        let name: String
        let pairingKey: String
    }

    static func digest(_ hostId: String) -> String {
        SHA256.hash(data: Data(hostId.utf8)).map { String(format: "%02x", $0) }.joined()
    }
    static func threadIdentifier(_ hostId: String) -> String { "orbis.host." + digest(hostId) }

    static func fallback(hostId: String, language: String) -> Self {
        let code = String(digest(hostId).prefix(4)).uppercased()
        let name = (language.hasPrefix("zh") ? "电脑 " : "Computer ") + code
        return Self(name: name, compactName: code, badge: code, pairingKey: "")
    }

    static func make(_ inputs: [Input], language: String) -> [String: Self] {
        let cleaned = inputs.map { input in
            let name = input.name.components(separatedBy: .controlCharacters).joined(separator: " ")
                .trimmingCharacters(in: .whitespacesAndNewlines)
            return Input(hostId: input.hostId, name: String(name.prefix(80)), pairingKey: input.pairingKey)
        }
        func key(_ text: String, length: Int) -> String { String(text.prefix(length)).lowercased() }
        var result: [String: Self] = [:]
        for input in cleaned {
            let fallback = fallback(hostId: input.hostId, language: language)
            guard !input.name.isEmpty else {
                result[input.hostId] = Self(name: fallback.name, compactName: fallback.compactName,
                    badge: fallback.badge, pairingKey: input.pairingKey)
                continue
            }
            let peers = cleaned.filter { $0.hostId != input.hostId }
            // Extend the digest if two known Hosts share its short prefix. The
            // identity is stable under ordering and independent of credentials.
            let digest = digest(input.hostId).uppercased()
            var length = 4
            while length < digest.count && peers.contains(where: { Self.digest($0.hostId).uppercased().hasPrefix(String(digest.prefix(length))) }) { length += 1 }
            let code = String(digest.prefix(length))
            let sameName = peers.contains { $0.name.lowercased() == input.name.lowercased() }
            let sameCompact = peers.contains { key($0.name, length: 4) == key(input.name, length: 4) }
            let sameBadge = peers.contains { key($0.name, length: 2) == key(input.name, length: 2) }
            result[input.hostId] = Self(name: sameName ? code + " · " + input.name : input.name,
                compactName: sameCompact ? code : String(input.name.prefix(4)),
                badge: sameBadge ? code : String(input.name.prefix(2)), pairingKey: input.pairingKey)
        }
        return result
    }
}

struct NotificationSourceDirectory: Codable, Equatable, Sendable {
    var language: String
    var hosts: [String: NotificationSource]

    static func sharedURL(bundle: Bundle = .main) -> URL? {
        #if os(iOS)
        guard let group = bundle.object(forInfoDictionaryKey: "OrbisNotificationAppGroup") as? String,
              !group.isEmpty, !group.contains("$("),
              let directory = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group) else { return nil }
        return directory.appendingPathComponent("notification-sources.json")
        #else
        return nil
        #endif
    }

    static func read(from url: URL?) -> Self? {
        guard let url, let values = try? url.resourceValues(forKeys: [.fileSizeKey]),
              let size = values.fileSize, size <= 256 * 1024,
              let data = try? Data(contentsOf: url) else { return nil }
        return try? JSONDecoder().decode(Self.self, from: data)
    }

    func write(to url: URL) throws {
        let data = try JSONEncoder().encode(self)
        try data.write(to: url, options: .atomic)
        #if os(iOS)
        try FileManager.default.setAttributes([.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication], ofItemAtPath: url.path)
        #endif
    }

    func source(hostId: String) -> NotificationSource {
        hosts[hostId] ?? .fallback(hostId: hostId, language: language)
    }
    func body(category: String) -> String {
        if language.hasPrefix("zh") { return category == "approval-requested" ? "有待处理的交互" : "任务已完成" }
        return category == "approval-requested" ? "Interaction needed" : "Task completed"
    }

    struct Alert: Equatable {
        let title: String
        let body: String
        let threadIdentifier: String
    }
    func alert(_ userInfo: [AnyHashable: Any]) -> Alert? {
        guard let payload = userInfo["orbis"] as? [String: Any], payload["v"] as? Int == 1,
              let host = payload["hostId"] as? String, !host.isEmpty, host.utf8.count <= 128,
              let category = payload["category"] as? String,
              ["task-completed", "approval-requested"].contains(category) else { return nil }
        return Alert(title: source(hostId: host).name, body: body(category: category),
            threadIdentifier: NotificationSource.threadIdentifier(host))
    }
}
