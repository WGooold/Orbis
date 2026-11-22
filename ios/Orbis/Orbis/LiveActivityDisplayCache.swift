import Foundation

/// The extension reads this local-only index at the next ActivityKit render.
/// Keep it small and atomic; never store tokens, credentials, raw session IDs
/// or conversation text other than the already displayed session title.
struct LiveActivityDisplayCache: Codable, Equatable, Sendable {
    struct Input: Equatable, Sendable {
        let hostId: String
        let name: String
        let pairingKey: String
        let pairingRef: String
    }
    struct Title: Codable, Equatable, Sendable {
        let focusKey: String
        let text: String
    }
    struct Host: Codable, Equatable, Sendable {
        let source: NotificationSource
        let pairingRef: String
        var badge: String?
        var titles: [Title]
    }

    private static let maxBytes = 64 * 1024
    var language = "en"
    private(set) var hosts: [String: Host] = [:]

    mutating func reconcile(_ inputs: [Input], language: String) {
        self.language = language
        let sources = NotificationSource.make(inputs.map {
            .init(hostId: $0.hostId, name: $0.name, pairingKey: $0.pairingKey)
        }, language: language)
        let hashes = inputs.map { ($0.hostId, NotificationSource.digest($0.hostId).uppercased()) }
        let old = hosts
        hosts = [:]
        for (input, (_, digest)) in zip(inputs.prefix(64), hashes) {
            guard let source = sources[input.hostId] else { continue }
            var length = 3
            while length < 6 && hashes.contains(where: { $0.0 != input.hostId && $0.1.hasPrefix(digest.prefix(length)) }) { length += 1 }
            hosts[input.hostId] = Host(source: source, pairingRef: input.pairingRef,
                badge: inputs.count > 1 ? String(digest.prefix(length)) : nil,
                titles: old[input.hostId]?.pairingRef == input.pairingRef ? old[input.hostId]?.titles ?? [] : [])
        }
    }

    mutating func merge(_ titles: [Title], hostId: String, pairingRef: String) {
        guard var host = hosts[hostId], host.pairingRef == pairingRef else { return }
        var seen: Set<String> = []
        var merged: [Title] = []
        for title in titles + host.titles {
            guard OrbisLiveActivityState.isDigest(title.focusKey), seen.insert(title.focusKey).inserted,
                  let text = Self.cleanTitle(title.text) else { continue }
            merged.append(Title(focusKey: title.focusKey, text: text))
            if merged.count == 64 { break }
        }
        host.titles = merged
        hosts[hostId] = host
    }

    func presentation(attributes: OrbisLiveActivityAttributes, state: OrbisLiveActivityState, isStale: Bool,
                      fallbackLanguage: String) -> OrbisLiveActivityPresentation {
        let candidate = hosts[attributes.hostId]
        let host = candidate.flatMap { host in
            let matches = attributes.pairingRef.map { $0 == host.pairingRef } ?? (attributes.pairingKey == host.source.pairingKey)
            return matches ? host : nil
        }
        let title = state.focusKey.flatMap { key -> String? in
            if let text = host?.titles.first(where: { $0.focusKey == key })?.text { return text }
            if attributes.pairingRef == nil, candidate == nil || host != nil,
               key == attributes.initialFocusKey, let legacyTitle = attributes.initialTitle { return Self.cleanTitle(legacyTitle) }
            return nil
        }
        return OrbisLiveActivityPresentation(state: state, isStale: isStale,
            language: host == nil ? attributes.language ?? fallbackLanguage : language,
            title: title, hostId: attributes.hostId,
            source: host?.source ?? (candidate == nil ? attributes.source : nil), badge: host?.badge)
    }

    private static func cleanTitle(_ value: String) -> String? {
        // Titles are single-line. Bound the byte size as well as the user-facing
        // length, including emoji, densely combined characters and CJK.
        let clean = value.prefix(160).components(separatedBy: .controlCharacters).joined(separator: " ")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        var text = "", bytes = 0
        for character in clean {
            let size = String(character).utf8.count
            if bytes + size > 256 { break }
            text.append(character); bytes += size
        }
        return text.isEmpty ? nil : text
    }

    static func sharedURL(bundle: Bundle = .main) -> URL? {
        #if os(iOS)
        guard let group = bundle.object(forInfoDictionaryKey: "OrbisLiveActivityAppGroup") as? String,
              !group.isEmpty, !group.contains("$("),
              let folder = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group) else { return nil }
        return folder.appendingPathComponent("activity-display.json")
        #else
        return nil
        #endif
    }

    static func read(from url: URL?) -> Self? {
        guard let url, let handle = try? FileHandle(forReadingFrom: url) else { return nil }
        defer { try? handle.close() }
        // One bounded read; the extension must provide its view synchronously.
        guard let data = try? handle.read(upToCount: maxBytes + 1), data.count <= maxBytes else { return nil }
        return try? JSONDecoder().decode(Self.self, from: data)
    }

    func write(to url: URL, prioritizing hostId: String?) throws {
        var snapshot = self
        let order = hosts.keys.sorted { lhs, rhs in
            if lhs == hostId { return rhs != hostId }
            if rhs == hostId { return false }
            return lhs < rhs
        }
        let encoder = JSONEncoder()
        var data = try encoder.encode(snapshot)
        // Shed old/redundant titles rather than withholding a new pairing or
        // leaking the titles from a removed pairing in the preceding snapshot.
        if data.count > Self.maxBytes {
            var remaining = 96
            for host in order {
                let titles = snapshot.hosts[host]?.titles ?? []
                let count = min(titles.count, remaining)
                snapshot.hosts[host]?.titles = Array(titles.prefix(count))
                remaining -= count
            }
            data = try encoder.encode(snapshot)
        }
        if data.count > Self.maxBytes {
            for host in order { snapshot.hosts[host]?.titles = [] }
            data = try encoder.encode(snapshot)
        }
        #if os(iOS)
        try data.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        #else
        try data.write(to: url, options: .atomic)
        #endif
    }
}
