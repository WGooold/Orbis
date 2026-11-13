import Foundation
import CoreFoundation
import CryptoKit

/// Immutable inputs captured by the UI owner. Foundation JSON containers are only read here.
struct SessionChatProjectionInput: @unchecked Sendable {
    let event: [String: Any]
    let graph: CachedSessionGraph?
    let excludedEntries: Set<String>
    var messages: [ChatMessage]
    var displayIds: [String: String]
    var aliases: [String: String]
    var liveIds: Set<String>
    var unfinishedIds: Set<String>
    var orders: [String: Int64]
}

struct SessionChatProjectionResult {
    let state: SessionChatProjectionInput
    let toolReference: ToolReference?
    let hasLive: Bool
}

struct CachedPageProjection {
    let graph: CachedSessionGraph
    let messages: [ChatMessage]
    let displayIds: [String: String]
    let timings: [String: SessionTurnTiming]
}

/// JSON model decoding, canonical/live reconciliation and array construction are CPU work.
/// The connection commits this result only after checking its generation and input revision.
actor SessionChatProjectionWorker {
    private let beforeResolve: (@Sendable () -> Void)?
    init(beforeResolve: (@Sendable () -> Void)? = nil) { self.beforeResolve = beforeResolve }

    func install(page: SessionHistoryPage, previousGraph: CachedSessionGraph?, messages: [ChatMessage],
                 displayIds: [String: String], timings: [String: SessionTurnTiming], replacing: Bool) -> CachedPageProjection {
        beforeResolve?()
        var graph = page.graph
        if !replacing, var previous = previousGraph, previous.epoch == page.graph.epoch {
            let retained = Set(previous.path(to: previous.leafId).suffix(256).map(\.entryId)).union(page.entries.map(\.entryId))
            for entry in page.entries where (page.graph.entryVersions[entry.entryId] ?? -1) >= (previous.entryVersions[entry.entryId] ?? -1) {
                previous.entries[entry.entryId] = entry
                previous.entryVersions[entry.entryId] = page.graph.entryVersions[entry.entryId]
            }
            for (id, row) in page.display where (page.graph.displayVersions[id] ?? -1) >= (previous.displayVersions[id] ?? -1) {
                previous.display[id] = row
                previous.displayVersions[id] = page.graph.displayVersions[id]
            }
            previous.entries = previous.entries.filter { retained.contains($0.key) }
            previous.display = previous.display.filter { $0.value.entryId.map(retained.contains) ?? true }
            previous.entryVersions = previous.entryVersions.filter { retained.contains($0.key) }
            previous.displayVersions = previous.displayVersions.filter { retained.contains($0.key) }
            graph = previous
        }
        let older = graph.project(page.entries)
        let ids = Set(older.map(\.messageId)).union(page.entries.compactMap { displayIds[$0.entryId] })
        let merged = replacing ? older : older + messages.filter { !ids.contains($0.messageId) }
        var display = displayIds, timings = timings
        for entry in page.entries { display[entry.entryId] = graph.display[entry.entryId]?.message?.messageId }
        for timing in page.turnTimings { timings[timing.turnId] = timing }
        return CachedPageProjection(graph: graph, messages: merged, displayIds: display, timings: timings)
    }

    func resolve(_ input: SessionChatProjectionInput) -> SessionChatProjectionResult {
        beforeResolve?()
        var state = input
        let event = input.event
        let live = event["live"] as? [String: Any]
        func decode<T: Decodable>(_ object: [String: Any]) -> T? {
            guard let data = try? JSONSerialization.data(withJSONObject: object) else { return nil }
            return try? JSONDecoder().decode(T.self, from: data)
        }
        let reference: ToolReference? = (live?["toolInventory"] as? [String: Any]).flatMap(decode)
        func retired(_ id: String) -> Bool {
            guard let entry = state.aliases[id], let canonical = state.displayIds[entry] else { return false }
            return canonical != id
        }
        if let rows = live?["messages"] as? [[String: Any]] {
            let canonical = Set(state.displayIds.values)
            let next = Set(rows.compactMap { ($0["message"] as? [String: Any])?["messageId"] as? String })
            let previous = state.liveIds
            state.messages.removeAll { previous.contains($0.messageId) && !canonical.contains($0.messageId) && !next.contains($0.messageId) }
            state.liveIds = []; state.unfinishedIds = []; state.orders = [:]
        }
        if let display = event["display"] as? [String: Any], let entries = display["entries"] as? [[String: Any]] {
            var batch = ChatMessageBatch(state.messages)
            for row in entries {
                let entry = row["entryId"] as? String
                if let entry, row["anchor"] as? String != "head", input.excludedEntries.contains(entry) { continue }
                let committed = (entry ?? row["displayId"] as? String).flatMap { input.graph?.display[$0] }
                let message: ChatMessage?
                if let committed { message = committed.message }
                else { message = (row["message"] as? [String: Any]).flatMap(decode) }
                if let entry {
                    if let old = state.displayIds[entry], old != message?.messageId { batch.remove(old) }
                    state.displayIds[entry] = message?.messageId
                }
                if let message { batch.upsert(message) }
            }
            state.messages = batch.messages
            if let boundary = display["windowStart"] as? String, let id = state.displayIds[boundary],
               let index = state.messages.firstIndex(where: { $0.messageId == id }), index > 0 { state.messages.removeFirst(index) }
            let head = Set(entries.filter { $0["anchor"] as? String == "head" }.compactMap { ($0["message"] as? [String: Any])?["messageId"] as? String })
            if !head.isEmpty { state.messages = state.messages.filter { head.contains($0.messageId) } + state.messages.filter { !head.contains($0.messageId) } }
        }
        if let rows = live?["messages"] as? [[String: Any]] {
            var batch = ChatMessageBatch(state.messages)
            for row in rows {
                guard let object = row["message"] as? [String: Any], let message: ChatMessage = decode(object) else { continue }
                if let entry = row["persistedEntryId"] as? String, message.messageId != entry {
                    if state.aliases.count >= 1024 { state.aliases.removeAll() }
                    state.aliases[message.messageId] = entry
                }
                if retired(message.messageId) { batch.remove(message.messageId); continue }
                state.liveIds.insert(message.messageId)
                if row["finished"] as? Bool == false { state.unfinishedIds.insert(message.messageId) }
                if let order = sessionInteger(row["order"]) { state.orders[message.messageId] = order }
                batch.upsert(message)
            }
            state.messages = batch.messages
        }
        if let graph = input.graph, let boundary = graph.windowStart {
            let excluded = Set(graph.path(to: boundary).dropLast().compactMap { state.displayIds[$0.entryId] })
            state.messages.removeAll { excluded.contains($0.messageId) }
        }
        let retiredIds = Set(state.aliases.keys.filter(retired))
        if !retiredIds.isEmpty {
            state.messages.removeAll { retiredIds.contains($0.messageId) }
            state.liveIds.subtract(retiredIds); state.unfinishedIds.subtract(retiredIds)
        }
        return SessionChatProjectionResult(state: state, toolReference: reference, hasLive: live != nil)
    }
}

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
            guard activate else { throw SessionHistoryError.invalid(L10n.tr("历史来源已经改变")) }
            next = CachedSessionGraph(sessionId: sessionId, epoch: incomingEpoch)
        }
        if let incomingEpoch { next.epoch = incomingEpoch }
        let rawEntries = event["entries"] as? [[String: Any]] ?? []
        guard rawEntries.count <= 500 else { throw SessionHistoryError.invalid(L10n.tr("历史页条目超限")) }
        guard rawEntries.allSatisfy({ !($0["type"] as? String ?? "").isEmpty && !($0["timestamp"] as? String ?? "").isEmpty }) else { throw SessionHistoryError.invalid(L10n.tr("历史条目缺少类型或时间")) }
        var received: [String: Entry] = [:]
        for row in rawEntries {
            guard let id = row["entryId"] as? String, !id.isEmpty,
                  row["parentId"] == nil || row["parentId"] is NSNull || row["parentId"] is String,
                  row["parentId"] as? String != id,
                  let data = try? JSONSerialization.data(withJSONObject: row),
                  let value = try? JSONDecoder().decode(RemoteJSONValue.self, from: data) else {
                throw SessionHistoryError.invalid(L10n.tr("历史条目格式无效"))
            }
            let entry = Entry(entryId: id, parentId: row["parentId"] as? String, value: value)
            if let duplicate = received[id], duplicate != entry { throw SessionHistoryError.invalid(L10n.tr("历史条目身份冲突")) }
            received[id] = entry
        }
        for (id, entry) in received where version >= (next.entryVersions[id] ?? -1) {
            next.entries[id] = entry; next.entryVersions[id] = version
        }
        var checked: Set<String> = []
        for id in received.keys {
            var current: String? = id, visiting: Set<String> = []
            while let value = current, !checked.contains(value) {
                guard visiting.insert(value).inserted else { throw SessionHistoryError.invalid(L10n.tr("历史父节点形成循环")) }
                current = next.entries[value]?.parentId
            }
            checked.formUnion(visiting)
        }
        if let batch = event["display"] as? [String: Any], let rows = batch["entries"] as? [[String: Any]] {
            guard sessionInteger(batch["projectionVersion"]) == 3 else { throw SessionHistoryError.invalid(L10n.tr("历史显示投影版本不兼容")) }
            next.displayVersion = 3
            var seen: Set<String> = []
            for row in rows {
                guard let id = (row["entryId"] as? String) ?? (row["displayId"] as? String) else { continue }
                guard seen.insert(id).inserted else { throw SessionHistoryError.invalid(L10n.tr("历史显示条目重复")) }
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
    let historyPrefetch: SessionHistoryPrefetch?
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
