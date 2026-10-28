import Foundation

/// Transport pieces contain slices of already encrypted base64url text. Only
/// the completed envelope is authenticated and advances the receive sequence.
enum EnvelopePieces {
    static let maxPieceChars = 8 * 1024

    static func fragment(_ envelope: Envelope, maxChars: Int = maxPieceChars, messageId: String = UUID().uuidString) -> [Envelope] {
        guard ["data", "ping", "bin"].contains(envelope.hdr.k), envelope.ct.utf8.count > maxChars, maxChars > 0 else { return [envelope] }
        let bytes = Array(envelope.ct.utf8)
        return stride(from: 0, to: bytes.count, by: maxChars).enumerated().map { index, offset in
            let end = min(offset + maxChars, bytes.count)
            let header = envelope.hdr
            return Envelope(v: 2, hdr: RoutingHeader(k: "piece", room: header.room, from: header.from, to: header.to,
                n: header.n, ch: header.ch, ik: header.k, mid: messageId, idx: index, last: end == bytes.count),
                ct: String(decoding: bytes[offset..<end], as: UTF8.self))
        }
    }
}

final class EnvelopeReassembler {
    private struct Partial {
        let header: RoutingHeader
        var parts: [Int: String] = [:]
        var total: Int?
        var chars = 0
        var lastSeen: TimeInterval
    }

    private let maxMessages: Int
    private let maxChars: Int
    private let timeout: TimeInterval
    private let now: () -> TimeInterval
    private var partials: [String: Partial] = [:]
    private(set) var bufferedChars = 0
    var pendingMessages: Int { partials.count }

    init(maxMessages: Int = 16, maxChars: Int = 32 * 1024 * 1024, timeout: TimeInterval = 60,
         now: @escaping () -> TimeInterval = { ProcessInfo.processInfo.systemUptime }) {
        self.maxMessages = maxMessages
        self.maxChars = maxChars
        self.timeout = timeout
        self.now = now
    }

    func clear() {
        partials.removeAll()
        bufferedChars = 0
    }

    func accept(_ envelope: Envelope) -> Envelope? {
        guard envelope.hdr.k == "piece" else { return envelope }
        sweep()
        let h = envelope.hdr
        guard envelope.v == 2, let kind = h.ik, ["data", "ping", "bin"].contains(kind),
              let channel = h.ch, ["ctl", "msg", "bulk"].contains(channel),
              let mid = h.mid, !mid.isEmpty, mid.utf8.count <= 128,
              let index = h.idx, (0...1_000_000).contains(index), let last = h.last,
              !envelope.ct.isEmpty, envelope.ct.utf8.count <= EnvelopePieces.maxPieceChars,
              envelope.ct.utf8.allSatisfy({ (65...90).contains($0) || (97...122).contains($0) || (48...57).contains($0) || $0 == 45 || $0 == 95 }) else { return nil }
        let key = "\(h.from)\u{0000}\(mid)"
        let chars = envelope.ct.utf8.count
        if partials[key] == nil {
            while partials.count >= maxMessages || bufferedChars + chars > maxChars {
                guard let oldest = partials.min(by: { $0.value.lastSeen < $1.value.lastSeen })?.key else { return nil }
                drop(oldest)
            }
            partials[key] = Partial(header: h, lastSeen: now())
        }
        guard var partial = partials[key] else { return nil }
        let original = partial.header
        guard original.room == h.room, original.to == h.to, original.n == h.n, original.ik == kind, original.ch == channel,
              partial.total.map({ index < $0 }) ?? true,
              !last || partial.total == nil || partial.total == index + 1,
              !last || partial.parts.keys.allSatisfy({ $0 <= index }) else { drop(key); return nil }
        if let existing = partial.parts[index] {
            if existing != envelope.ct { drop(key) }
            return nil
        }
        guard bufferedChars + chars <= maxChars else { drop(key); return nil }
        partial.parts[index] = envelope.ct
        partial.chars += chars
        partial.lastSeen = now()
        if last { partial.total = index + 1 }
        bufferedChars += chars
        partials[key] = partial
        guard let total = partial.total, partial.parts.count == total else { return nil }
        var slices: [String] = []
        for i in 0..<total {
            guard let slice = partial.parts[i] else { return nil }
            slices.append(slice)
        }
        drop(key)
        return Envelope(v: 2, hdr: RoutingHeader(k: kind, room: h.room, from: h.from, to: h.to, n: h.n, ch: channel), ct: slices.joined())
    }

    func sweep() {
        let expired = partials.filter { now() - $0.value.lastSeen >= timeout }.map(\.key)
        expired.forEach(drop)
    }

    private func drop(_ key: String) {
        if let partial = partials.removeValue(forKey: key) { bufferedChars -= partial.chars }
    }
}
