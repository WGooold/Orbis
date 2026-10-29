import Foundation
import CoreFoundation
import CryptoKit

extension RemoteJSONValue {
    subscript(_ key: String) -> RemoteJSONValue {
        if case .object(let object) = self { return object[key] ?? .null }
        return .null
    }
    var string: String? { if case .string(let string) = self { return string }; return nil }
}

/// Canonical entries and their Host-produced display interpretation commit together. A cached
/// graph is useful offline, but never establishes a live applied baseline after reconnecting.
struct CachedSessionGraph: Codable {
    struct Entry: Codable, Equatable {
        let entryId: String
        let parentId: String?
        let value: RemoteJSONValue
    }
    struct Display: Codable, Equatable {
        let entryId: String?
        let displayId: String
        let anchor: String?
        let message: ChatMessage?
    }
    let sessionId: String
    var epoch: String?
    var leafId: String?
    var entries: [String: Entry] = [:]
    var display: [String: Display] = [:]
    var entryVersions: [String: Int64] = [:]
    var displayVersions: [String: Int64] = [:]
    var windowStart: String?
    var displayVersion: Int?

    func path(to leaf: String?) -> [Entry] {
        var result: [Entry] = [], visited: Set<String> = [], next = leaf
        while let id = next, visited.insert(id).inserted, let entry = entries[id] {
            result.append(entry); next = entry.parentId
        }
        return result.reversed()
    }
    func project(_ page: [Entry]) -> [ChatMessage] {
        let path = path(to: leafId)
        let windowIndex = windowStart.flatMap { id in path.firstIndex { $0.entryId == id } }
        let excluded = Set(windowIndex.map { path.prefix($0).map(\.entryId) } ?? [])
        let ids = Set(page.map(\.entryId))
        let head = display.values.filter { $0.anchor == "head" && ($0.entryId == nil || ids.contains($0.entryId!)) }.sorted { $0.displayId < $1.displayId }
        let rows = page.filter { !excluded.contains($0.entryId) }.compactMap { display[$0.entryId] }.filter { $0.anchor != "head" }
        var seen: Set<String> = []
        return (head + rows).compactMap(\.message).filter { seen.insert($0.messageId).inserted }
    }
    var messages: [ChatMessage] { project(path(to: leafId)) }

    func merging(_ event: [String: Any], activate: Bool) throws -> CachedSessionGraph {
        var next = self
        let source = event["source"] as? [String: Any]
        let incomingEpoch = source?["epoch"] as? String
        let version = sessionInteger(source?["seq"]) ?? 0
        if let incomingEpoch, let epoch, incomingEpoch != epoch {
            guard activate else { throw SessionHistoryError.invalid("历史来源已经改变") }
            next = CachedSessionGraph(sessionId: sessionId, epoch: incomingEpoch)
        }
        if let incomingEpoch { next.epoch = incomingEpoch }
        let rawEntries = event["entries"] as? [[String: Any]] ?? []
        guard rawEntries.count <= 500 else { throw SessionHistoryError.invalid("历史页条目超限") }
        guard rawEntries.allSatisfy({ !($0["type"] as? String ?? "").isEmpty && !($0["timestamp"] as? String ?? "").isEmpty }) else { throw SessionHistoryError.invalid("历史条目缺少类型或时间") }
        var received: [String: Entry] = [:]
        for row in rawEntries {
            guard let id = row["entryId"] as? String, !id.isEmpty,
                  row["parentId"] == nil || row["parentId"] is NSNull || row["parentId"] is String,
                  row["parentId"] as? String != id,
                  let data = try? JSONSerialization.data(withJSONObject: row),
                  let value = try? JSONDecoder().decode(RemoteJSONValue.self, from: data) else {
                throw SessionHistoryError.invalid("历史条目格式无效")
            }
            let entry = Entry(entryId: id, parentId: row["parentId"] as? String, value: value)
            if let duplicate = received[id], duplicate != entry { throw SessionHistoryError.invalid("历史条目身份冲突") }
            received[id] = entry
        }
        for (id, entry) in received where version >= (next.entryVersions[id] ?? -1) {
            next.entries[id] = entry; next.entryVersions[id] = version
        }
        var checked: Set<String> = []
        for id in received.keys {
            var current: String? = id, visiting: Set<String> = []
            while let value = current, !checked.contains(value) {
                guard visiting.insert(value).inserted else { throw SessionHistoryError.invalid("历史父节点形成循环") }
                current = next.entries[value]?.parentId
            }
            checked.formUnion(visiting)
        }
        if let batch = event["display"] as? [String: Any], let rows = batch["entries"] as? [[String: Any]] {
            guard sessionInteger(batch["projectionVersion"]) == 3 else { throw SessionHistoryError.invalid("历史显示投影版本不兼容") }
            next.displayVersion = 3
            var seen: Set<String> = []
            for row in rows {
                guard let id = (row["entryId"] as? String) ?? (row["displayId"] as? String) else { continue }
                guard seen.insert(id).inserted else { throw SessionHistoryError.invalid("历史显示条目重复") }
                let message: ChatMessage?
                if let raw = row["message"] as? [String: Any] {
                    let data = try JSONSerialization.data(withJSONObject: raw)
                    message = try JSONDecoder().decode(ChatMessage.self, from: data)
                } else { message = nil }
                if version >= (next.displayVersions[id] ?? -1) {
                    next.display[id] = Display(entryId: row["entryId"] as? String, displayId: row["displayId"] as? String ?? id, anchor: row["anchor"] as? String, message: message); next.displayVersions[id] = version
                }
            }
            if activate { next.windowStart = batch["windowStart"] as? String }
        }
        if activate {
            let cursor = (event["head"] as? [String: Any]) ?? (event["cursor"] as? [String: Any])
            if let cursor { next.leafId = cursor["leafId"] as? String }
        }
        return next
    }
}

enum SessionHistoryError: LocalizedError {
    case invalid(String)
    var errorDescription: String? { if case .invalid(let value) = self { return value }; return nil }
}

final class SessionHistoryCache {
    private let root: URL
    init(root: URL) { self.root = root }
    private func hash(_ value: String) -> String { SHA256.hash(data: Data(value.utf8)).map { String(format: "%02x", $0) }.joined() }
    private func directory(_ host: HostPairing) -> URL { root.appendingPathComponent(hash(hostKeyPrefix(host)), isDirectory: true) }
    private func file(_ host: HostPairing, _ sessionId: String) -> URL { directory(host).appendingPathComponent(hash(sessionId) + ".json") }
    func contains(_ host: HostPairing, sessionId: String) -> Bool { FileManager.default.fileExists(atPath: file(host, sessionId).path) }
    func load(_ host: HostPairing, sessionId: String) -> CachedSessionGraph? {
        guard let data = try? Data(contentsOf: file(host, sessionId)), let graph = try? JSONDecoder().decode(CachedSessionGraph.self, from: data), graph.sessionId == sessionId, graph.displayVersion == 3 else { return nil }
        return graph
    }
    func save(_ graph: CachedSessionGraph, host: HostPairing) throws {
        try FileManager.default.createDirectory(at: directory(host), withIntermediateDirectories: true)
        try JSONEncoder().encode(graph).write(to: file(host, graph.sessionId), options: .atomic)
    }
    func remove(_ host: HostPairing) { try? FileManager.default.removeItem(at: directory(host)) }
}

/// Reject coercion of booleans, fractions and values outside the wire's safe integer range.
func sessionInteger(_ value: Any?) -> Int64? {
    guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() else { return nil }
    let value = number.doubleValue
    guard value.isFinite, value >= 0, value <= 9_007_199_254_740_991, value.rounded() == value else { return nil }
    return Int64(value)
}

struct SessionAppliedBaseline: Equatable {
    let epoch: String
    let seq: Int64
    let leaf: String?
    var wire: [String: Any] { ["epoch": epoch, "seq": seq, "head": ["leafId": leaf as Any? ?? NSNull()]] }
}

struct SessionSyncTransaction {
    let runtimeId: String
    let sessionId: String
    let commandId: String
    let range: String
    let boundary: String?
    let leaf: String?
    let command: [String: Any]
    let known: SessionAppliedBaseline?
    var attempts = 1
    var pendingNotices = 0
    var firstSentAt: Date
    var sentAt: Date
    var deadline: Date
    var exhausted = false
}

struct SessionSnapshotReceipt {
    let runtimeId: String
    let sessionId: String
    let fingerprint: String
}
func sessionSnapshotFingerprint(_ event: [String: Any]) -> String? {
    guard let data = try? JSONSerialization.data(withJSONObject: event, options: [.sortedKeys, .withoutEscapingSlashes]) else { return nil }
    return SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
}
