import Foundation
import SQLite3
import CryptoKit

struct SessionTurnTiming: Codable, Equatable {
    let turnId: String
    let startedAt: Int64
    let durationMs: Int64?
    let turnIndex: Int64?
    let messageId: String?
    var valid: Bool {
        !turnId.isEmpty && turnId.utf16.count <= 256 && startedAt >= 0 && startedAt <= 9_007_199_254_740_991 &&
        durationMs.map { $0 >= 0 && $0 <= 9_007_199_254_740_991 } != false && turnIndex.map { $0 >= 0 } != false
    }
}

enum SessionHistoryRangeStatus: String, Codable {
    case complete, olderAvailable = "older_available", leafNotFound = "leaf_not_found"
    case rangeStartNotFound = "range_start_not_found", missingParent = "missing_parent"
    case cycleDetected = "cycle_detected", limitReached = "limit_reached"
}

struct SessionHistoryPage {
    let graph: CachedSessionGraph
    let entries: [CachedSessionGraph.Entry]
    let display: [String: CachedSessionGraph.Display]
    let turnTimings: [SessionTurnTiming]
    let hasOlder: Bool
    let complete: Bool
    let status: SessionHistoryRangeStatus
    let displayComplete: Bool
    var targetCovered = false
    var coverageGap: SessionCatchupGap?
    var messages: [ChatMessage] { graph.project(entries) }
}

struct SessionHistoryCommit {
    let graph: CachedSessionGraph
    let page: SessionHistoryPage
    let committedEntries: [CachedSessionGraph.Entry]
    let committedDisplay: [String: CachedSessionGraph.Display]
    let turnTimings: [SessionTurnTiming]
    let epochChanged: Bool
}

struct SessionHistorySummary: Equatable {
    let sessionId: String
    let epoch: String?
    let leafId: String?
    let entryCount: Int
    let modifiedAt: Int64
}
struct SessionHistoryBranch: Equatable {
    let leafId: String
    let message: ChatMessage?
    let timestamp: String?
}

/// Runtime ownership can change without reconnecting the Host. Invalidation is synchronous;
/// the short commit critical section either precedes that change or rejects the old owner.
final class SessionHistoryWriteLease: @unchecked Sendable {
    private let lock = NSLock()
    private var valid = true
    func invalidate() { lock.lock(); valid = false; lock.unlock() }
    func check() throws { try perform {} }
    func perform<T>(_ body: () throws -> T) throws -> T {
        lock.lock(); defer { lock.unlock() }
        guard valid else { throw SessionHistoryError.invalid("会话写入归属已经失效") }
        return try body()
    }
}

/// The UI invalidates a write lease synchronously before changing connection/selection ownership.
/// A transaction checks the same lease at BEGIN and under this lock at COMMIT. Disk work never
/// holds the lock, so cancelling one Host cannot wait behind another Host's history traversal.
private final class SessionHistoryWriteFence: @unchecked Sendable {
    private let lock = NSLock()
    private var generations: [String: UUID] = [:]
    func set(_ generation: UUID, key: String) { lock.lock(); generations[key] = generation; lock.unlock() }
    func invalidate(_ key: String) { lock.lock(); generations[key] = nil; lock.unlock() }
    func perform<T>(_ key: String, generation: UUID, _ body: () throws -> T) throws -> T {
        lock.lock(); defer { lock.unlock() }
        guard generations[key] == generation else { throw SessionHistoryError.invalid("会话读取归属已经失效") }
        return try body()
    }
    func check(_ key: String, generation: UUID) throws { try perform(key, generation: generation) {} }
}

/// SQLite is confined to this actor. Incoming pages update only their rows; reads materialize a
/// bounded parent range and its display/timing rows from one transaction. No full graph is read
/// or rewritten during normal ingestion. The old JSON cache is imported once, off the UI actor.
actor SessionHistoryWorker {
    private let root: URL
    private var database: SessionHistoryDatabase?
    private nonisolated let fence = SessionHistoryWriteFence()
    private let beforeCommit: (@Sendable () -> Void)?
    init(root: URL, beforeCommit: (@Sendable () -> Void)? = nil) { self.root = root; self.beforeCommit = beforeCommit }
    nonisolated func setGeneration(_ generation: UUID, host: HostPairing) { fence.set(generation, key: hostKeyPrefix(host)) }
    nonisolated func invalidate(host: HostPairing) { fence.invalidate(hostKeyPrefix(host)) }
    private func db() throws -> SessionHistoryDatabase {
        if let database { return database }
        let opened = try SessionHistoryDatabase(root: root)
        database = opened; return opened
    }
    func ingest(host: HostPairing, sessionId: String, event: Data, activate: Bool, generation: UUID,
                lease: SessionHistoryWriteLease? = nil, expectedEpoch: String? = nil, limit: Int = 256) throws -> SessionHistoryCommit {
        let key = hostKeyPrefix(host)
        try fence.check(key, generation: generation)
        try lease?.check()
        let database = try db()
        try database.migrateLegacy(host: host, sessionId: sessionId)
        return try database.ingest(key: key, sessionId: sessionId, event: event, activate: activate,
            expectedEpoch: expectedEpoch, limit: limit, beforeCommit: {
                self.beforeCommit?()
                try self.fence.perform(key, generation: generation) {
                    if let lease { try lease.perform { try database.commit() } }
                    else { try database.commit() }
                }
            })
    }
    func page(host: HostPairing, sessionId: String, leafId: String? = nil, beforeEntryId: String? = nil,
              afterEntryId: String? = nil, limit: Int = 30) throws -> SessionHistoryPage {
        let database = try db(); try database.migrateLegacy(host: host, sessionId: sessionId)
        return try database.readTransaction { try database.page(key: hostKeyPrefix(host), sessionId: sessionId,
            leafId: leafId, before: beforeEntryId, after: afterEntryId, limit: limit) }
    }
    func entry(host: HostPairing, sessionId: String, entryId: String) throws -> CachedSessionGraph.Entry? {
        let database = try db(); try database.migrateLegacy(host: host, sessionId: sessionId)
        return try database.entry(key: hostKeyPrefix(host), sessionId: sessionId, id: entryId)?.0
    }
    /// Only canonical ancestors proven to precede the authoritative display window are
    /// excluded. Unknown IDs, including transient live-message IDs, are preserved.
    func excludedDisplayEntries(host: HostPairing, sessionId: String, entryIds: [String]) throws -> Set<String> {
        guard !entryIds.isEmpty else { return [] }
        let database = try db(); try database.migrateLegacy(host: host, sessionId: sessionId)
        return try database.readTransaction {
            try database.excludedDisplayEntries(key: hostKeyPrefix(host), session: sessionId, entryIds: entryIds)
        }
    }
    func hasHistory(host: HostPairing, sessionId: String) throws -> Bool {
        let database = try db(); try database.migrateLegacy(host: host, sessionId: sessionId)
        return try database.metadata(key: hostKeyPrefix(host), sessionId: sessionId) != nil
    }
    func listCachedSessions(host: HostPairing) throws -> [SessionHistorySummary] {
        let database = try db(); try database.migrateLegacyDirectory(host: host)
        return try database.summaries(key: hostKeyPrefix(host))
    }
    func branches(host: HostPairing, sessionId: String, limit: Int = 128) throws -> [SessionHistoryBranch] {
        let database = try db(); try database.migrateLegacy(host: host, sessionId: sessionId)
        return try database.branches(key: hostKeyPrefix(host), sessionId: sessionId, limit: limit)
    }
    func remove(host: HostPairing) throws {
        fence.invalidate(hostKeyPrefix(host))
        let database = try db(); try database.remove(key: hostKeyPrefix(host))
        try? FileManager.default.removeItem(at: root.appendingPathComponent(historyStorageHash(hostKeyPrefix(host))))
    }
}

private func historyStorageHash(_ value: String) -> String { SHA256.hash(data: Data(value.utf8)).map { String(format: "%02x", $0) }.joined() }
private enum HistorySQLValue { case text(String), integer(Int64), blob(Data), null }
private struct SessionHistoryMetadata {
    var epoch: String?
    var leaf: String?
    var window: String?
    var displayVersion: Int?
    var sourceSeq: Int64
    var modifiedAt: Int64
}
private final class SessionHistoryDatabase {
    private let root: URL
    private var connection: OpaquePointer?
    private let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)
    init(root: URL) throws {
        self.root = root
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        guard sqlite3_open_v2(root.appendingPathComponent("history.sqlite3").path, &connection,
            SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_FULLMUTEX, nil) == SQLITE_OK else { throw SessionHistoryError.invalid("历史数据库无法打开") }
        sqlite3_busy_timeout(connection, 5000)
        try execute("PRAGMA journal_mode=WAL")
        try execute("PRAGMA synchronous=FULL")
        try execute("PRAGMA foreign_keys=ON")
        try execute("PRAGMA cache_size=-8192")
        try execute("PRAGMA temp_store=FILE")
        try execute("CREATE TABLE IF NOT EXISTS sessions(host TEXT NOT NULL,session TEXT NOT NULL,epoch TEXT,leaf TEXT,window_start TEXT,display_version INTEGER,source_seq INTEGER NOT NULL DEFAULT -1,modified_at INTEGER NOT NULL,PRIMARY KEY(host,session))")
        try execute("CREATE TABLE IF NOT EXISTS entries(host TEXT NOT NULL,session TEXT NOT NULL,id TEXT NOT NULL,parent TEXT,body BLOB NOT NULL,seq INTEGER NOT NULL,PRIMARY KEY(host,session,id))")
        try execute("CREATE INDEX IF NOT EXISTS entry_parents ON entries(host,session,parent)")
        try execute("CREATE TABLE IF NOT EXISTS display(host TEXT NOT NULL,session TEXT NOT NULL,id TEXT NOT NULL,entry_id TEXT,anchor TEXT,body BLOB NOT NULL,seq INTEGER NOT NULL,PRIMARY KEY(host,session,id))")
        try execute("CREATE INDEX IF NOT EXISTS display_entries ON display(host,session,entry_id)")
        try execute("CREATE TABLE IF NOT EXISTS timings(host TEXT NOT NULL,session TEXT NOT NULL,id TEXT NOT NULL,message_id TEXT,body BLOB NOT NULL,seq INTEGER NOT NULL,PRIMARY KEY(host,session,id))")
        try execute("CREATE INDEX IF NOT EXISTS timing_messages ON timings(host,session,message_id)")
        try execute("CREATE TABLE IF NOT EXISTS retired_epochs(host TEXT NOT NULL,session TEXT NOT NULL,epoch TEXT NOT NULL,PRIMARY KEY(host,session,epoch))")
        try execute("PRAGMA user_version=1")
    }
    deinit { sqlite3_close(connection) }
    private func error() -> Error { SessionHistoryError.invalid("历史数据库操作失败：" + String(cString: sqlite3_errmsg(connection))) }
    private func statement(_ sql: String, _ values: [HistorySQLValue]) throws -> OpaquePointer {
        var prepared: OpaquePointer?
        guard sqlite3_prepare_v2(connection, sql, -1, &prepared, nil) == SQLITE_OK, let prepared else { throw error() }
        do {
            for (index, value) in values.enumerated() {
                let position = Int32(index + 1), code: Int32
                switch value {
                case .text(let string): code = sqlite3_bind_text(prepared, position, string, -1, transient)
                case .integer(let integer): code = sqlite3_bind_int64(prepared, position, integer)
                case .blob(let data): code = data.withUnsafeBytes { sqlite3_bind_blob(prepared, position, $0.baseAddress, Int32(data.count), transient) }
                case .null: code = sqlite3_bind_null(prepared, position)
                }
                guard code == SQLITE_OK else { throw error() }
            }
            return prepared
        } catch { sqlite3_finalize(prepared); throw error }
    }
    private func text(_ stmt: OpaquePointer, _ index: Int32) -> String? {
        guard sqlite3_column_type(stmt, index) != SQLITE_NULL, let pointer = sqlite3_column_text(stmt, index) else { return nil }
        return String(cString: pointer)
    }
    private func blob(_ stmt: OpaquePointer, _ index: Int32) -> Data {
        let count = Int(sqlite3_column_bytes(stmt, index))
        guard count > 0, let pointer = sqlite3_column_blob(stmt, index) else { return Data() }
        return Data(bytes: pointer, count: count)
    }
    private func execute(_ sql: String, _ values: [HistorySQLValue] = []) throws {
        let prepared = try statement(sql, values); defer { sqlite3_finalize(prepared) }
        let code = sqlite3_step(prepared)
        guard code == SQLITE_DONE || code == SQLITE_ROW else { throw error() }
    }
    private func query<T>(_ sql: String, _ values: [HistorySQLValue] = [], row: (OpaquePointer) throws -> T) throws -> [T] {
        let prepared = try statement(sql, values); defer { sqlite3_finalize(prepared) }
        var result: [T] = []
        while true {
            let code = sqlite3_step(prepared)
            if code == SQLITE_DONE { return result }
            guard code == SQLITE_ROW else { throw error() }
            result.append(try row(prepared))
        }
    }
    func readTransaction<T>(_ body: () throws -> T) throws -> T {
        try execute("BEGIN DEFERRED")
        do { let value = try body(); try commit(); return value }
        catch { try? execute("ROLLBACK"); throw error }
    }
    func commit() throws { try execute("COMMIT") }
    func metadata(key: String, sessionId: String) throws -> SessionHistoryMetadata? {
        try query("SELECT epoch,leaf,window_start,display_version,source_seq,modified_at FROM sessions WHERE host=? AND session=?", [.text(key), .text(sessionId)]) { row in
            SessionHistoryMetadata(epoch: text(row, 0), leaf: text(row, 1), window: text(row, 2),
                displayVersion: sqlite3_column_type(row, 3) == SQLITE_NULL ? nil : Int(sqlite3_column_int64(row, 3)),
                sourceSeq: sqlite3_column_int64(row, 4), modifiedAt: sqlite3_column_int64(row, 5))
        }.first
    }
    private func saveMetadata(_ value: SessionHistoryMetadata, key: String, sessionId: String) throws {
        try execute("INSERT OR REPLACE INTO sessions VALUES(?,?,?,?,?,?,?,?)", [.text(key), .text(sessionId), value.epoch.map(HistorySQLValue.text) ?? .null,
            value.leaf.map(HistorySQLValue.text) ?? .null, value.window.map(HistorySQLValue.text) ?? .null,
            value.displayVersion.map { .integer(Int64($0)) } ?? .null, .integer(value.sourceSeq), .integer(value.modifiedAt)])
    }
    func entry(key: String, sessionId: String, id: String) throws -> (CachedSessionGraph.Entry, Int64)? {
        try query("SELECT body,seq FROM entries WHERE host=? AND session=? AND id=?", [.text(key), .text(sessionId), .text(id)]) { row in
            (try JSONDecoder().decode(CachedSessionGraph.Entry.self, from: blob(row, 0)), sqlite3_column_int64(row, 1))
        }.first
    }
    private func display(key: String, sessionId: String, id: String) throws -> (CachedSessionGraph.Display, Int64)? {
        try query("SELECT body,seq FROM display WHERE host=? AND session=? AND id=?", [.text(key), .text(sessionId), .text(id)]) { row in
            (try JSONDecoder().decode(CachedSessionGraph.Display.self, from: blob(row, 0)), sqlite3_column_int64(row, 1))
        }.first
    }
    private func storeEntry(_ value: CachedSessionGraph.Entry, seq: Int64, key: String, session: String) throws {
        try execute("INSERT INTO entries VALUES(?,?,?,?,?,?) ON CONFLICT(host,session,id) DO UPDATE SET parent=excluded.parent,body=excluded.body,seq=excluded.seq WHERE excluded.seq>=entries.seq",
            [.text(key), .text(session), .text(value.entryId), value.parentId.map(HistorySQLValue.text) ?? .null, .blob(try JSONEncoder().encode(value)), .integer(seq)])
    }
    private func storeDisplay(_ value: CachedSessionGraph.Display, seq: Int64, key: String, session: String) throws {
        let id = value.entryId ?? value.displayId
        try execute("INSERT INTO display VALUES(?,?,?,?,?,?,?) ON CONFLICT(host,session,id) DO UPDATE SET entry_id=excluded.entry_id,anchor=excluded.anchor,body=excluded.body,seq=excluded.seq WHERE excluded.seq>=display.seq",
            [.text(key), .text(session), .text(id), value.entryId.map(HistorySQLValue.text) ?? .null, value.anchor.map(HistorySQLValue.text) ?? .null, .blob(try JSONEncoder().encode(value)), .integer(seq)])
    }
    private func storeTiming(_ value: SessionTurnTiming, seq: Int64, key: String, session: String) throws {
        guard value.valid else { throw SessionHistoryError.invalid("回合计时格式无效") }
        try execute("INSERT INTO timings VALUES(?,?,?,?,?,?) ON CONFLICT(host,session,id) DO UPDATE SET message_id=excluded.message_id,body=excluded.body,seq=excluded.seq WHERE excluded.seq>=timings.seq",
            [.text(key), .text(session), .text(value.turnId), value.messageId.map(HistorySQLValue.text) ?? .null, .blob(try JSONEncoder().encode(value)), .integer(seq)])
    }
    private func isDescendant(key: String, session: String, child: String, ancestor: String) throws -> Bool {
        let rows = try query("WITH RECURSIVE ancestry(id,parent) AS (SELECT id,parent FROM entries WHERE host=? AND session=? AND id=? UNION SELECT e.id,e.parent FROM entries e JOIN ancestry a ON e.id=a.parent WHERE e.host=? AND e.session=?) SELECT 1 FROM ancestry WHERE id=? LIMIT 1",
            [.text(key), .text(session), .text(child), .text(key), .text(session), .text(ancestor)]) { _ in true }
        return !rows.isEmpty
    }
    private func validateCycles(key: String, session: String, changed: [String]) throws {
        // Validate the effective (version-filtered) batch in memory once. Only a component's
        // edge into pre-existing SQLite ancestry needs a recursive query; checking every node
        // in a long appended suffix would turn a 500-row transaction into quadratic work.
        var effective: [String: CachedSessionGraph.Entry] = [:]
        for id in changed { effective[id] = try entry(key: key, sessionId: session, id: id)?.0 }
        var checked: Set<String> = []
        for id in changed where !checked.contains(id) {
            var next: String? = id, visiting: Set<String> = []
            while let value = next, !checked.contains(value), let entry = effective[value] {
                guard visiting.insert(value).inserted else { throw SessionHistoryError.invalid("历史父节点形成循环") }
                if let parent = entry.parentId, effective[parent] == nil,
                   try isDescendant(key: key, session: session, child: parent, ancestor: value) { throw SessionHistoryError.invalid("历史父节点形成循环") }
                next = entry.parentId
            }
            checked.formUnion(visiting)
        }
    }
    func ingest(key: String, sessionId: String, event: Data, activate: Bool, expectedEpoch: String?, limit: Int,
                beforeCommit: () throws -> Void) throws -> SessionHistoryCommit {
        guard !sessionId.isEmpty, sessionId.utf16.count <= 256, event.count <= 16 * 1024 * 1024,
              let object = try JSONSerialization.jsonObject(with: event) as? [String: Any],
              let source = object["source"] as? [String: Any], let epoch = source["epoch"] as? String,
              !epoch.isEmpty, epoch.utf16.count <= 256, source["ready"] as? Bool == true,
              let seq = sessionInteger(source["seq"]) else { throw SessionHistoryError.invalid("历史来源或范围无效") }
        // Parse only this bounded packet. Cached parents are checked against SQLite below.
        let incoming = try CachedSessionGraph(sessionId: sessionId).merging(object, activate: activate)
        let timings = try (object["turnTimings"] as? [[String: Any]] ?? []).map { raw -> SessionTurnTiming in
            let value = try JSONDecoder().decode(SessionTurnTiming.self, from: JSONSerialization.data(withJSONObject: raw))
            guard value.valid else { throw SessionHistoryError.invalid("回合计时格式无效") }; return value
        }
        guard timings.count <= 500, Set(timings.map(\.turnId)).count == timings.count else { throw SessionHistoryError.invalid("回合计时重复或超限") }
        try execute("BEGIN IMMEDIATE")
        do {
            let previous = try metadata(key: key, sessionId: sessionId)
            if let expectedEpoch, previous?.epoch != expectedEpoch { throw SessionHistoryError.invalid("历史缓存代次已经改变") }
            let retired = try query("SELECT 1 FROM retired_epochs WHERE host=? AND session=? AND epoch=? LIMIT 1", [.text(key), .text(sessionId), .text(epoch)]) { _ in true }
            guard retired.isEmpty else { throw SessionHistoryError.invalid("历史来源已被替换") }
            let changedEpoch = previous?.epoch != nil && previous?.epoch != epoch
            if activate {
                let live = object["live"] as? [String: Any]
                guard live?["complete"] as? Bool == true else { throw SessionHistoryError.invalid("当前会话清单尚未完整") }
                if object["type"] as? String == "session.patch" {
                    guard previous?.epoch == epoch, let base = sessionInteger(object["baseSeq"]), previous?.sourceSeq == base,
                          seq > base, sessionInteger(object["seq"]) == seq, object["headCompleteness"] as? String == "complete" else { throw SessionHistoryError.invalid("会话更新来源不连续") }
                } else {
                    guard let checkpoint = object["checkpoint"] as? [String: Any], checkpoint["headCompleteness"] as? String == "complete",
                          checkpoint["inventoryComplete"] as? Bool == true,
                          let head = checkpoint["head"] as? [String: Any], let cursor = object["cursor"] as? [String: Any],
                          head["leafId"] as? String == cursor["leafId"] as? String else { throw SessionHistoryError.invalid("会话检查点尚未完整") }
                }
            }
            if changedEpoch {
                guard activate else { throw SessionHistoryError.invalid("历史页不能替换来源") }
                try execute("INSERT OR IGNORE INTO retired_epochs VALUES(?,?,?)", [.text(key), .text(sessionId), .text(previous!.epoch!)])
                for table in ["entries", "display", "timings"] { try execute("DELETE FROM \(table) WHERE host=? AND session=?", [.text(key), .text(sessionId)]) }
            } else if !activate, previous?.epoch != epoch { throw SessionHistoryError.invalid("历史页来源尚未确认") }
            if activate, let previous, previous.epoch == epoch, seq < previous.sourceSeq { throw SessionHistoryError.invalid("历史快照落后于已提交状态") }
            var meta = changedEpoch || previous == nil ? SessionHistoryMetadata(epoch: epoch, sourceSeq: -1, modifiedAt: 0) : previous!
            for entry in incoming.entries.values { try storeEntry(entry, seq: seq, key: key, session: sessionId) }
            try validateCycles(key: key, session: sessionId, changed: Array(incoming.entries.keys))
            if incoming.displayVersion != nil {
                if activate, meta.window != incoming.windowStart { try execute("DELETE FROM display WHERE host=? AND session=? AND entry_id IS NULL", [.text(key), .text(sessionId)]) }
                for value in incoming.display.values where value.entryId != nil || seq >= meta.sourceSeq { try storeDisplay(value, seq: seq, key: key, session: sessionId) }
                meta.displayVersion = 3
                if activate { meta.window = incoming.windowStart }
            }
            for timing in timings { try storeTiming(timing, seq: seq, key: key, session: sessionId) }
            if activate {
                if let cursor = (object["head"] as? [String: Any]) ?? (object["cursor"] as? [String: Any]) { meta.leaf = cursor["leafId"] as? String }
                if let leaf = meta.leaf, try entry(key: key, sessionId: sessionId, id: leaf) == nil { throw SessionHistoryError.invalid("会话头节点尚未提交") }
                meta.sourceSeq = seq
            }
            meta.epoch = epoch; meta.modifiedAt = Int64(Date().timeIntervalSince1970 * 1000)
            try saveMetadata(meta, key: key, sessionId: sessionId)
            let page = try page(key: key, sessionId: sessionId, leafId: meta.leaf, before: nil, after: nil, limit: min(500, max(1, limit)))
            var graph = page.graph, committed: [CachedSessionGraph.Entry] = [], committedDisplay: [String: CachedSessionGraph.Display] = [:]
            let receivedOrder = (object["entries"] as? [[String: Any]] ?? []).compactMap { $0["entryId"] as? String }
            var emitted: Set<String> = []
            for id in receivedOrder where emitted.insert(id).inserted {
                if let stored = try entry(key: key, sessionId: sessionId, id: id) {
                    graph.entries[id] = stored.0; graph.entryVersions[id] = stored.1; committed.append(stored.0)
                }
            }
            for id in incoming.display.keys {
                if let stored = try display(key: key, sessionId: sessionId, id: id) {
                    graph.display[id] = stored.0; graph.displayVersions[id] = stored.1; committedDisplay[id] = stored.0
                }
            }
            let committedTimings = try timings.compactMap { value in try timing(key: key, session: sessionId, id: value.turnId)?.0 }
            try beforeCommit()
            return SessionHistoryCommit(graph: graph, page: page, committedEntries: committed, committedDisplay: committedDisplay,
                turnTimings: committedTimings, epochChanged: changedEpoch)
        } catch { try? execute("ROLLBACK"); throw error }
    }
    private func timing(key: String, session: String, id: String) throws -> (SessionTurnTiming, Int64)? {
        try query("SELECT body,seq FROM timings WHERE host=? AND session=? AND id=?", [.text(key), .text(session), .text(id)]) {
            (try JSONDecoder().decode(SessionTurnTiming.self, from: blob($0, 0)), sqlite3_column_int64($0, 1))
        }.first
    }
    func page(key: String, sessionId: String, leafId: String?, before: String?, after: String?, limit: Int) throws -> SessionHistoryPage {
        let meta = try metadata(key: key, sessionId: sessionId)
        let leaf = leafId ?? meta?.leaf
        var graph = CachedSessionGraph(sessionId: sessionId, epoch: meta?.epoch, leafId: leaf)
        graph.windowStart = meta?.window; graph.displayVersion = meta?.displayVersion
        func result(_ entries: [CachedSessionGraph.Entry], _ status: SessionHistoryRangeStatus, _ hasOlder: Bool, _ complete: Bool) throws -> SessionHistoryPage {
            var timings: [SessionTurnTiming] = []
            for entry in entries {
                if let stored = try display(key: key, sessionId: sessionId, id: entry.entryId) { graph.display[entry.entryId] = stored.0; graph.displayVersions[entry.entryId] = stored.1 }
            }
            let heads = try query("SELECT id,body,seq FROM display WHERE host=? AND session=? AND entry_id IS NULL AND anchor='head' LIMIT 32", [.text(key), .text(sessionId)]) { row in
                (text(row, 0)!, try JSONDecoder().decode(CachedSessionGraph.Display.self, from: blob(row, 1)), sqlite3_column_int64(row, 2))
            }
            for (id, value, seq) in heads { graph.display[id] = value; graph.displayVersions[id] = seq }
            let messageIds = Set(graph.display.values.compactMap { $0.message?.messageId })
            for id in messageIds {
                let matching = try query("SELECT body FROM timings WHERE host=? AND session=? AND message_id=? LIMIT 8", [.text(key), .text(sessionId), .text(id)]) {
                    try JSONDecoder().decode(SessionTurnTiming.self, from: blob($0, 0))
                }
                timings.append(contentsOf: matching)
            }
            var excluded: Set<String> = []
            if let window = meta?.window {
                if let position = entries.firstIndex(where: { $0.entryId == window }) { excluded = Set(entries.prefix(position).map(\.entryId)) }
                else if let latest = entries.last, try isDescendant(key: key, session: sessionId, child: window, ancestor: latest.entryId) { excluded = Set(entries.map(\.entryId)) }
            }
            // Bounded graphs do not contain every ancestor of windowStart; explicitly omit these
            // older display rows so their projection obeys the same SQLite ancestry proof.
            for id in excluded { graph.display[id] = nil }
            let displayComplete = meta?.displayVersion == 3 && entries.allSatisfy { excluded.contains($0.entryId) || graph.display[$0.entryId] != nil }
            var page = SessionHistoryPage(graph: graph, entries: entries, display: graph.display, turnTimings: timings,
                hasOlder: hasOlder, complete: complete, status: status, displayComplete: displayComplete)
            if let leaf {
                let coverage = try coverage(key: key, session: sessionId, leaf: leaf, window: meta?.window)
                page.targetCovered = coverage.0 && meta?.displayVersion == 3
                page.coverageGap = coverage.1
            } else { page.targetCovered = meta != nil }
            return page
        }
        guard limit > 0 else { return try result([], .limitReached, true, false) }
        guard let leaf else { return try result([], meta == nil ? .leafNotFound : .complete, false, meta != nil) }
        guard try entry(key: key, sessionId: sessionId, id: leaf) != nil else { return try result([], .leafNotFound, false, false) }
        var next: String? = leaf
        if let before {
            guard try isDescendant(key: key, session: sessionId, child: leaf, ancestor: before),
                  let boundary = try entry(key: key, sessionId: sessionId, id: before)?.0 else { return try result([], .rangeStartNotFound, false, false) }
            next = boundary.parentId
        }
        var rows: [CachedSessionGraph.Entry] = [], visited: Set<String> = [], status: SessionHistoryRangeStatus = .complete
        var reachedAfter = after == nil
        while let id = next, rows.count < min(500, limit) {
            if id == after { reachedAfter = true; next = nil; break }
            guard visited.insert(id).inserted else { status = .cycleDetected; break }
            guard let stored = try entry(key: key, sessionId: sessionId, id: id) else { status = rows.isEmpty && before == nil ? .leafNotFound : .missingParent; break }
            rows.append(stored.0); graph.entries[id] = stored.0; graph.entryVersions[id] = stored.1; next = stored.0.parentId
        }
        if next == after, after != nil { reachedAfter = true; next = nil }
        if status == .complete, next != nil { status = .olderAvailable }
        if after != nil && !reachedAfter && status == .complete { status = .rangeStartNotFound }
        if after != nil && !reachedAfter && status == .olderAvailable { status = .limitReached }
        return try result(rows.reversed(), status, next != nil, status == .complete && reachedAfter)
    }
    private func coverage(key: String, session: String, leaf: String, window: String?) throws -> (Bool, SessionCatchupGap?) {
        // Recursive sets live inside SQLite's bounded page cache/temp file, not an app-sized
        // graph. UNION terminates even a corrupt cycle and missing parents stay observable.
        let cte = "WITH RECURSIVE path(id,parent) AS (SELECT id,parent FROM entries WHERE host=? AND session=? AND id=? UNION SELECT e.id,e.parent FROM entries e JOIN path p ON e.id=p.parent WHERE e.host=? AND e.session=?), excluded(id,parent) AS (SELECT e.id,e.parent FROM entries e WHERE e.host=? AND e.session=? AND e.id=(SELECT parent FROM entries WHERE host=? AND session=? AND id=?) UNION SELECT e.id,e.parent FROM entries e JOIN excluded x ON e.id=x.parent WHERE e.host=? AND e.session=?) "
        let bindings: [HistorySQLValue] = [.text(key), .text(session), .text(leaf), .text(key), .text(session), .text(key), .text(session), .text(key), .text(session), window.map(HistorySQLValue.text) ?? .null, .text(key), .text(session)]
        let missing = try query(cte + "SELECT p.parent FROM path p WHERE p.parent IS NOT NULL AND NOT EXISTS(SELECT 1 FROM entries e WHERE e.host=? AND e.session=? AND e.id=p.parent) LIMIT 1", bindings + [.text(key), .text(session)]) { text($0, 0)! }.first
        if let missing {
            return (false, SessionCatchupGap(knownLeafId: try continuousLeaf(key: key, session: session, window: window, requireDisplay: false), targetLeafId: missing))
        }
        let root = try query(cte + "SELECT 1 FROM path WHERE parent IS NULL LIMIT 1", bindings) { _ in true }
        guard !root.isEmpty else {
            return (false, SessionCatchupGap(knownLeafId: try continuousLeaf(key: key, session: session, window: window, requireDisplay: false), targetLeafId: leaf))
        }
        let displayGap = try query(cte + "SELECT p.id,p.parent FROM path p WHERE NOT EXISTS(SELECT 1 FROM display d WHERE d.host=? AND d.session=? AND d.entry_id=p.id) AND NOT EXISTS(SELECT 1 FROM excluded x WHERE x.id=p.id) LIMIT 1", bindings + [.text(key), .text(session)]) { (text($0, 0)!, text($0, 1)) }.first
        if let displayGap {
            return (false, SessionCatchupGap(knownLeafId: try continuousLeaf(key: key, session: session, window: window, requireDisplay: true), targetLeafId: displayGap.0))
        }
        return (true, nil)
    }

    /// Catchup pages run from the root toward their requested target. Reusing nil after the
    /// first bounded page would ask the Host for that same prefix forever. A verified frontier
    /// may lie on a sibling branch: the Host resolves its common ancestor with the fixed target.
    /// Canonical holes use canonical coverage because compaction legitimately omits display
    /// rows before its window; after the chain connects, display holes use stricter coverage.
    private func continuousLeaf(key: String, session: String, window: String?, requireDisplay: Bool) throws -> String? {
        let sql = """
            WITH RECURSIVE excluded(id,parent) AS (
                SELECT id,parent FROM entries WHERE host=? AND session=? AND id=(SELECT parent FROM entries WHERE host=? AND session=? AND id=?)
                UNION SELECT e.id,e.parent FROM entries e JOIN excluded x ON e.id=x.parent WHERE e.host=? AND e.session=?
            ), available(id,parent,seq) AS (
                SELECT e.id,e.parent,e.seq FROM entries e WHERE e.host=? AND e.session=? AND
                    (?=0 OR EXISTS(SELECT 1 FROM display d WHERE d.host=e.host AND d.session=e.session AND d.entry_id=e.id)
                        OR EXISTS(SELECT 1 FROM excluded x WHERE x.id=e.id))
            ), continuous(id,depth,seq) AS (
                SELECT id,0,seq FROM available WHERE parent IS NULL
                UNION ALL SELECT e.id,c.depth+1,e.seq FROM available e JOIN continuous c ON e.parent=c.id
            ) SELECT id FROM continuous ORDER BY depth DESC,seq DESC,id LIMIT 1
            """
        return try query(sql, [.text(key), .text(session), .text(key), .text(session), window.map(HistorySQLValue.text) ?? .null,
            .text(key), .text(session), .text(key), .text(session), .integer(requireDisplay ? 1 : 0)]) { text($0, 0)! }.first
    }

    func excludedDisplayEntries(key: String, session: String, entryIds: [String]) throws -> Set<String> {
        guard let window = try metadata(key: key, sessionId: session)?.window else { return [] }
        // Candidate IDs are already bounded by the caller's loaded window. A temporary table
        // avoids SQLite variable limits and traversing a long ancestor chain once per chunk;
        // only matching candidate IDs cross the database boundary.
        try execute("CREATE TEMP TABLE IF NOT EXISTS display_filter_candidates(id TEXT NOT NULL PRIMARY KEY)")
        try execute("DELETE FROM temp.display_filter_candidates")
        defer { try? execute("DELETE FROM temp.display_filter_candidates") }
        let candidates = Array(Set(entryIds))
        for start in stride(from: 0, to: candidates.count, by: 256) {
            let batch = candidates[start..<min(start + 256, candidates.count)]
            let values = Array(repeating: "(?)", count: batch.count).joined(separator: ",")
            try execute("INSERT INTO temp.display_filter_candidates(id) VALUES " + values, batch.map(HistorySQLValue.text))
        }
        let sql = """
            WITH RECURSIVE excluded(id,parent) AS (
                SELECT id,parent FROM entries WHERE host=? AND session=? AND id=(SELECT parent FROM entries WHERE host=? AND session=? AND id=?)
                UNION SELECT e.id,e.parent FROM entries e JOIN excluded x ON e.id=x.parent WHERE e.host=? AND e.session=?
            ) SELECT x.id FROM excluded x JOIN temp.display_filter_candidates c ON c.id=x.id
            """
        return Set(try query(sql, [.text(key), .text(session), .text(key), .text(session), .text(window), .text(key), .text(session)]) { text($0, 0)! })
    }

    func summaries(key: String) throws -> [SessionHistorySummary] {
        try query("SELECT s.session,s.epoch,s.leaf,(SELECT count(*) FROM entries e WHERE e.host=s.host AND e.session=s.session),s.modified_at FROM sessions s WHERE s.host=? ORDER BY s.modified_at DESC", [.text(key)]) {
            SessionHistorySummary(sessionId: text($0, 0)!, epoch: text($0, 1), leafId: text($0, 2), entryCount: Int(sqlite3_column_int64($0, 3)), modifiedAt: sqlite3_column_int64($0, 4))
        }
    }
    func branches(key: String, sessionId: String, limit: Int) throws -> [SessionHistoryBranch] {
        try readTransaction {
            let leaves = try query("SELECT e.id,e.body FROM entries e WHERE e.host=? AND e.session=? AND NOT EXISTS(SELECT 1 FROM entries child WHERE child.host=e.host AND child.session=e.session AND child.parent=e.id) ORDER BY e.seq DESC,e.id LIMIT ?",
                [.text(key), .text(sessionId), .integer(Int64(min(500, max(1, limit))))]) { row in
                    (text(row, 0)!, try JSONDecoder().decode(CachedSessionGraph.Entry.self, from: blob(row, 1)))
                }
            return try leaves.map { id, entry in SessionHistoryBranch(leafId: id, message: try display(key: key, sessionId: sessionId, id: id)?.0.message, timestamp: entry.value["timestamp"].string) }
        }
    }
    func remove(key: String) throws {
        try execute("BEGIN IMMEDIATE")
        do {
            for table in ["entries", "display", "timings", "sessions", "retired_epochs"] { try execute("DELETE FROM \(table) WHERE host=?", [.text(key)]) }
            try commit()
        } catch { try? execute("ROLLBACK"); throw error }
    }
    func migrateLegacyDirectory(host: HostPairing) throws {
        let folder = root.appendingPathComponent(historyStorageHash(hostKeyPrefix(host)))
        guard let files = try? FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: nil) else { return }
        for file in files where file.pathExtension == "json" {
            guard let graph = try? JSONDecoder().decode(CachedSessionGraph.self, from: Data(contentsOf: file)), graph.displayVersion == 3 else { continue }
            try migrateLegacy(host: host, sessionId: graph.sessionId)
        }
    }
    func migrateLegacy(host: HostPairing, sessionId: String) throws {
        let key = hostKeyPrefix(host)
        guard try metadata(key: key, sessionId: sessionId) == nil else { return }
        let file = root.appendingPathComponent(historyStorageHash(key)).appendingPathComponent(historyStorageHash(sessionId) + ".json")
        guard FileManager.default.fileExists(atPath: file.path) else { return }
        let graph = try JSONDecoder().decode(CachedSessionGraph.self, from: Data(contentsOf: file))
        guard graph.sessionId == sessionId, graph.displayVersion == 3 else { return }
        try execute("BEGIN IMMEDIATE")
        do {
            for (id, entry) in graph.entries { try storeEntry(entry, seq: graph.entryVersions[id] ?? 0, key: key, session: sessionId) }
            try validateCycles(key: key, session: sessionId, changed: Array(graph.entries.keys))
            for (id, display) in graph.display { try storeDisplay(display, seq: graph.displayVersions[id] ?? 0, key: key, session: sessionId) }
            let seq = graph.entryVersions.values.max() ?? 0
            try saveMetadata(SessionHistoryMetadata(epoch: graph.epoch, leaf: graph.leafId, window: graph.windowStart, displayVersion: 3, sourceSeq: seq,
                modifiedAt: Int64(Date().timeIntervalSince1970 * 1000)), key: key, sessionId: sessionId)
            try commit()
        } catch { try? execute("ROLLBACK"); throw error }
        try? FileManager.default.moveItem(at: file, to: file.appendingPathExtension("migrated"))
    }
}
