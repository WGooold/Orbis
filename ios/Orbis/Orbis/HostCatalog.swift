import Foundation
import CryptoKit

func catalogDirectoryId(_ path: String) -> String { SHA256.hash(data: Data(path.utf8)).map { String(format: "%02x", $0) }.joined() }

struct HostCatalogRequest {
    let id: String
    let cursor: String
    let modelEpoch: String
    let revision: Int64
    let snapshotId: String?
    let offset: Int
}

/// All pages belong to one fixed Host catalog version. A partial inventory never deletes sessions.
struct HostCatalogRange {
    let modelEpoch: String
    let revision: Int64
    let snapshotId: String?
    let value: HostJSON
    var sessions: [SessionSummary]
    var nextCursor: String?
    let totalSessions: Int
    var complete: Bool
    var truncated: Bool
    var seenCursors: Set<String> = []
    var error: String?

    init?(domain: HostDomain) {
        let value = domain.value
        guard value.object != nil, value["sessions"].isArray,
              let sessions: [SessionSummary] = value["sessions"].decoded(),
              let total = value["totalSessions"].integer, total <= Int64(Int.max),
              let truncated = value["truncated"].bool,
              sessions.count <= 2_000, Int64(sessions.count) <= total,
              Set(sessions.map(\.sessionId)).count == sessions.count,
              sessions.allSatisfy(Self.validSession),
              value["nextCursor"] == .null || value["nextCursor"].string?.isEmpty == false else { return nil }
        self.modelEpoch = domain.modelEpoch; self.revision = domain.revision
        self.snapshotId = value["snapshotId"].string; self.value = value; self.sessions = sessions
        self.nextCursor = value["nextCursor"].string; self.totalSessions = Int(total)
        self.complete = domain.completeness == "complete"; self.truncated = truncated
        guard nextCursor == nil || snapshotId?.isEmpty == false,
              nextCursor != nil || truncated || sessions.count == totalSessions else { return nil }
    }

    var completeKinds: Set<String> {
        guard nextCursor == nil, !truncated, error == nil else { return [] }
        return Set(value["backends"].array.compactMap { row in
            row["complete"].bool == true ? row["kind"].string : nil
        })
    }

    func matches(_ request: HostCatalogRequest) -> Bool {
        modelEpoch == request.modelEpoch && revision == request.revision && snapshotId == request.snapshotId &&
        nextCursor == request.cursor && sessions.count == request.offset
    }

    func appending(_ page: HostJSON, request: HostCatalogRequest) -> HostCatalogRange? {
        guard matches(request), page["sessions"].isArray, let entries: [SessionSummary] = page["sessions"].decoded(),
              entries.count <= 200, entries.allSatisfy(Self.validSession),
              let complete = page["complete"].bool, let truncated = page["truncated"].bool,
              page["nextCursor"] == .null || page["nextCursor"].string?.isEmpty == false else { return nil }
        let combined = sessions + entries, next = page["nextCursor"].string
        guard combined.count <= totalSessions, Set(combined.map(\.sessionId)).count == combined.count,
              next == nil || (!entries.isEmpty && next != request.cursor && !seenCursors.contains(next!)),
              next != nil || truncated || combined.count == totalSessions else { return nil }
        var result = self
        result.sessions = combined; result.nextCursor = next; result.complete = complete; result.truncated = truncated
        result.seenCursors.insert(request.cursor)
        return result
    }

    private static func validSession(_ session: SessionSummary) -> Bool {
        !session.sessionId.isEmpty && session.createdAt >= 0 && session.modifiedAt >= 0 && session.messageCount >= 0 &&
        session.messageCount <= 100_000 && ["pi", "codex", "codexDesktop", "dsh", "dshDesktop", "claude"].contains(session.agentKind ?? "")
    }
}


enum HostModelPreparationError: Error { case invalid, baseline }
struct PreparedHostModel {
    let accepted: [String: HostDomain]
    let absent: [String: String]
    let resolved: Set<String>
    let truncated: Bool
    let catalog: HostCatalogRange?
}

/// Decode/validate atomically off the UI actor, including equal-version facts
/// comparisons and catalog row decoding. The owner fences the resulting commit.
actor HostModelPreparationWorker {
    private let beforeWork: (@Sendable () -> Void)?
    init(beforeWork: (@Sendable () -> Void)? = nil) { self.beforeWork = beforeWork }
    private func decode<T: Decodable>(_ raw: [String: Any]) -> T? {
        guard let data = try? JSONSerialization.data(withJSONObject: raw) else { return nil }
        return try? JSONDecoder().decode(T.self, from: data)
    }
    func snapshot(_ message: [String: Any], domains: [String: HostDomain], subscribedDomains: Set<String>,
                  subscriptionFormat: String?, newEpoch: String) throws -> PreparedHostModel {
        beforeWork?()
        guard let rawDomains = message["domains"] as? [[String: Any]], let rawMissing = message["missing"] as? [[String: Any]],
              let isTruncated = message["truncated"] as? Bool else { throw HostModelPreparationError.invalid }
        var decoded: [String: HostDomain] = [:]
        for source in rawDomains {
            let raw: [String: Any]
            do {
                if source["delta"] != nil && subscriptionFormat != "compact-v2" { throw StateDeltas.Failure.invalid }
                guard let expanded = try StateDeltas.expand(source, old: domains[source["domain"] as? String ?? ""], epoch: newEpoch) else { continue }
                raw = expanded
            } catch { throw HostModelPreparationError.baseline }
            guard let domain: HostDomain = decode(raw), domain.valid, domain.modelEpoch == newEpoch,
                  subscribedDomains.contains(domain.domain), decoded[domain.domain] == nil else { throw HostModelPreparationError.invalid }
            decoded[domain.domain] = domain
        }
        var absent: [String: String] = [:]
        for raw in rawMissing {
            guard let name = raw["domain"] as? String, subscribedDomains.contains(name), decoded[name] == nil, absent[name] == nil,
                  let reason = raw["reason"] as? String, ["no_state", "unknown_domain"].contains(reason) else { throw HostModelPreparationError.invalid }
            absent[name] = reason
        }
        let unchanged = message["unchanged"] as? [String] ?? []
        guard unchanged.allSatisfy({ subscribedDomains.contains($0) && decoded[$0] == nil && absent[$0] == nil && domains[$0]?.modelEpoch == newEpoch }) else { throw HostModelPreparationError.invalid }
        var ranges: [String: HostCatalogRange] = [:]
        for domain in decoded.values where domain.domain == "catalog" && domain.availability == "ready" && domain.value["sessions"] != .null {
            guard let range = HostCatalogRange(domain: domain) else { throw HostModelPreparationError.invalid }
            ranges[domain.domain] = range
        }
        var accepted: [String: HostDomain] = [:]
        for (name, incoming) in decoded {
            if let old = domains[name], old.modelEpoch == newEpoch {
                if incoming.revision < old.revision { continue }
                if incoming.revision == old.revision && (!incoming.sameFacts(as: old) || incoming.checkedAt < old.checkedAt) { continue }
            }
            accepted[name] = incoming
        }
        for name in unchanged { if let value = domains[name] { accepted[name] = value } }
        let catalog = accepted["catalog"].flatMap { domain in ranges["catalog"] ?? HostCatalogRange(domain: domain) }
        return PreparedHostModel(accepted: accepted, absent: absent,
            resolved: Set(decoded.keys).union(absent.keys).union(unchanged), truncated: isTruncated, catalog: catalog)
    }
    func page(_ raw: [String: Any], range: HostCatalogRange, request: HostCatalogRequest) -> Result<HostCatalogRange, CatalogPageError> {
        beforeWork?()
        guard let page: HostJSON = decode(raw) else { return .failure(CatalogPageError(reason: "invalid_page")) }
        if let error = page["error"].string { return .failure(CatalogPageError(reason: error)) }
        guard page["modelEpoch"].string == request.modelEpoch, page["revision"].integer == request.revision,
              page["snapshotId"].string == request.snapshotId, page["offset"].integer == Int64(request.offset),
              page["totalSessions"].integer == Int64(range.totalSessions) else {
            return .failure(CatalogPageError(reason: "snapshot_changed"))
        }
        guard let updated = range.appending(page, request: request) else { return .failure(CatalogPageError(reason: "invalid_page")) }
        return .success(updated)
    }
}
struct CatalogPageError: Error { let reason: String }

struct PreparedSessionCatalog {
    let sessions: [SessionSummary]
    let index: [String: SessionSummary]
    let changed: Bool
}
actor SessionCatalogPreparationWorker {
    private let beforeWork: (@Sendable () -> Void)?
    init(beforeWork: (@Sendable () -> Void)? = nil) { self.beforeWork = beforeWork }
    func merge(current: [SessionSummary], incoming: [SessionSummary], completeKinds: Set<String>,
               retained: Set<String>, cacheLoaded: Bool, identity: RuntimeSummary? = nil, replacing: Bool = false) -> PreparedSessionCatalog {
        beforeWork?()
        func prepare(_ sessions: [SessionSummary]) -> PreparedSessionCatalog {
            PreparedSessionCatalog(sessions: sessions,
                index: Dictionary(sessions.map { ($0.sessionId, $0) }, uniquingKeysWith: { first, _ in first }),
                changed: sessions != current)
        }
        if replacing { return prepare(incoming.sorted { $0.modifiedAt > $1.modifiedAt }) }
        if let runtime = identity, let id = runtime.sessionId {
            var sessions = current
            let index = sessions.firstIndex { $0.sessionId == id }
            var entry = index.map { sessions[$0] } ?? SessionSummary(sessionId: id, cwd: runtime.cwd, createdAt: 0, modifiedAt: 0, messageCount: 0)
            entry.name = runtime.sessionName
            if !runtime.cwd.isEmpty { entry.cwd = runtime.cwd }
            entry.agentKind = runtime.agentKind; entry.hostname = runtime.hostname ?? entry.hostname
            if let index { sessions[index] = entry } else { sessions.append(entry) }
            return prepare(sessions)
        }
        var merged = Dictionary(current.filter { !completeKinds.contains($0.agentKind ?? "") || retained.contains($0.sessionId) || !cacheLoaded }
            .map { ($0.sessionId, $0) }, uniquingKeysWith: { _, last in last })
        for item in incoming { merged[item.sessionId] = item }
        let sessions = merged.values.sorted { $0.modifiedAt > $1.modifiedAt }
        return PreparedSessionCatalog(sessions: sessions, index: merged, changed: sessions != current)
    }
    func decode(_ rows: [[String: Any]]) -> [SessionSummary] {
        beforeWork?()
        return rows.compactMap { row in
            guard let data = try? JSONSerialization.data(withJSONObject: row) else { return nil }
            return try? JSONDecoder().decode(SessionSummary.self, from: data)
        }
    }
}

struct CatalogQuery: Codable, Equatable, Hashable {
    var text = ""
    var agentKind: String?
    var archived = false
    var provider = "all"
    var directory: String?
    var wire: [String: Any] { ["text": text, "agentKind": agentKind as Any? ?? NSNull(), "archived": archived, "provider": provider,
        "directory": directory as Any? ?? NSNull()] }
}

struct CatalogQueryResult {
    let query: CatalogQuery
    var range: HostCatalogRange
    let directoryCount: Int
    let providers: [String]
    let unknownProvider: Bool
    let providersTruncated: Bool
    var previewsComplete = false
    var directoryTotals: [String: Int] = [:]
    var loading = false
    var error: String?
}

/// A fixed visible query owns all retries. Timer ticks can settle an existing read but never
/// start new pages; closing the view retires its request identity before any late result.
@MainActor
final class CatalogViewReads {
    private struct Read {
        let id: String
        let query: CatalogQuery
        let cursor: String?
        let started: Date
        var retried = false
    }
    private let send: ([String: Any]) -> Bool
    private let publish: (CatalogQueryResult, [SessionSummary]) -> Void
    private let now: () -> Date
    private var capability: (id: String, at: Date)?
    private(set) var supported = false
    private var visible = false
    private var query: CatalogQuery?
    private(set) var result: CatalogQueryResult?
    private var read: Read?
    private var recoveries = 0
    private var timer: Task<Void, Never>?

    init(send: @escaping ([String: Any]) -> Bool, publish: @escaping (CatalogQueryResult, [SessionSummary]) -> Void,
         now: @escaping () -> Date = Date.init) { self.send = send; self.publish = publish; self.now = now }
    func connect() {
        disconnect()
        if result?.error != nil { result = nil }
        let id = UUID().uuidString; capability = (id, now())
        _ = send(["type": "session.catalog.capabilities.request", "protocolVersion": orbisProtocolVersion, "requestId": id])
        timer = Task { [weak self] in
            while !Task.isCancelled {
                do { try await Task.sleep(nanoseconds: 1_000_000_000) } catch { return }
                self?.tick()
            }
        }
    }
    func disconnect() { timer?.cancel(); timer = nil; supported = false; capability = nil; read = nil }
    func setView(_ value: CatalogQuery?) {
        visible = value != nil
        guard let value else {
            read = nil
            if var old = result, old.loading { old.loading = false; result = old; publish(old, []) }
            return
        }
        if query != value { query = value; result = nil; read = nil; recoveries = 0 }
        if result == nil { needMore() }
    }
    func sourceChanged(epoch: String, revision: Int64) {
        guard let old = result, old.range.modelEpoch != epoch || revision > old.range.revision else { return }
        result = nil; read = nil
        if visible { needMore() }
    }
    func retryFailed() {
        guard result?.error != nil else { return }
        result = nil; read = nil; recoveries = 0
        if visible { needMore() }
    }
    func needMore() {
        guard visible, supported, let query, read == nil, result?.error == nil,
              result == nil || result?.range.nextCursor != nil else { return }
        let pending = Read(id: UUID().uuidString, query: query, cursor: result?.range.nextCursor, started: now())
        read = pending
        if var result { result.loading = true; self.result = result; publish(result, []) }
        if !send(body(pending)) { fail("send_failed") }
    }
    private func body(_ read: Read) -> [String: Any] {
        ["type": "session.catalog.query", "protocolVersion": orbisProtocolVersion, "requestId": read.id, "format": "v1",
         "query": read.query.wire, "cursor": read.cursor as Any? ?? NSNull(), "limit": 100]
    }
    func tick() {
        let time = now()
        if let capability, time.timeIntervalSince(capability.at) >= 20 { self.capability = nil }
        guard var pending = read else { return }
        if time.timeIntervalSince(pending.started) >= 45 { fail("timeout"); return }
        if !pending.retried, time.timeIntervalSince(pending.started) >= 25 {
            pending.retried = true; read = pending
            if !send(body(pending)) { fail("send_failed") }
        }
    }
    @discardableResult
    func consume(_ message: [String: Any]) -> Bool {
        guard let id = message["requestId"] as? String else { return false }
        if id == capability?.id {
            supported = message["type"] as? String == "session.catalog.capabilities" && message["format"] as? String == "v1"
            capability = nil
            if supported && visible { needMore() }
            return true
        }
        if message["type"] as? String == "session.catalog.page", id != read?.id { return true }
        guard let pending = read, pending.id == id else { return false }
        guard visible, pending.query == query else { read = nil; return true }
        guard message["type"] as? String == "session.catalog.page", message["format"] as? String == "v1",
              let raw = message["page"] as? [String: Any], let page: HostJSON = decode(raw) else {
            fail(message["code"] as? String ?? "invalid_page"); return true
        }
        if let error = page["error"].string {
            if error == "snapshot_changed", recoveries == 0 {
                recoveries += 1; read = nil; result = nil; needMore()
            } else { fail(error) }
            return true
        }
        guard let received = message["query"] as? [String: Any], let receivedQuery: CatalogQuery = decode(received), receivedQuery == pending.query,
              let epoch = page["modelEpoch"].string, let revision = page["revision"].integer,
              let snapshot = page["snapshotId"].string, let offset = page["offset"].integer,
              let total = page["totalSessions"].integer, let complete = page["complete"].bool,
              let truncated = page["truncated"].bool, page["sessions"].array.count <= 100,
              let directories = message["directoryCount"] as? Int, directories >= 0,
              let providers = message["providers"] as? [String] ?? result?.providers, providers.count <= 64,
              let unknown = message["unknownProvider"] as? Bool ?? result?.unknownProvider,
              let limited = message["providersTruncated"] as? Bool ?? result?.providersTruncated,
              let previews = message["previewsComplete"] as? Bool else {
            fail("invalid_page"); return true
        }
        let range: HostCatalogRange?
        if let old = result {
            let request = HostCatalogRequest(id: id, cursor: pending.cursor ?? "", modelEpoch: old.range.modelEpoch,
                revision: old.range.revision, snapshotId: old.range.snapshotId, offset: old.range.sessions.count)
            guard epoch == request.modelEpoch, revision == request.revision, snapshot == request.snapshotId,
                  offset == Int64(request.offset), total == Int64(old.range.totalSessions) else { fail("snapshot_changed"); return true }
            range = old.range.appending(page, request: request)
        } else {
            guard offset == 0 else { fail("invalid_page"); return true }
            range = HostCatalogRange(domain: HostDomain(domain: "catalog", modelEpoch: epoch, revision: revision,
                availability: "ready", completeness: complete ? "complete" : "partial",
                source: .init(producer: "host", sourceId: "catalog", sourceEpoch: epoch, sourceRevision: revision), checkedAt: 0,
                value: page, projectionComplete: true))
        }
        guard let range, range.truncated == truncated else { fail("invalid_page"); return true }
        read = nil
        var totals = result?.directoryTotals ?? [:]
        for row in page["sessions"].array {
            if let cwd = row["cwd"].string, let count = row["directoryTotal"].integer { totals[cwd] = Int(count) }
        }
        let updated = CatalogQueryResult(query: pending.query, range: range, directoryCount: directories,
            providers: providers, unknownProvider: unknown, providersTruncated: limited, previewsComplete: previews, directoryTotals: totals)
        result = updated
        let entries: [SessionSummary] = page["sessions"].decoded() ?? []
        publish(updated, entries)
        return true
    }
    private func fail(_ error: String) {
        guard let pending = read else { return }
        read = nil
        if var old = result { old.loading = false; old.error = error; result = old; publish(old, []); return }
        let raw: HostJSON = .object(["sessions": .array([]), "totalSessions": .number(0), "truncated": .bool(true), "nextCursor": .null])
        guard let range = HostCatalogRange(domain: HostDomain(domain: "catalog", modelEpoch: "unconfirmed", revision: 0,
            availability: "unknown", completeness: "unknown", source: .init(producer: "host", sourceId: "catalog", sourceEpoch: "unconfirmed", sourceRevision: 0),
            checkedAt: 0, value: raw, projectionComplete: false)) else { return }
        let failed = CatalogQueryResult(query: pending.query, range: range, directoryCount: 0, providers: [], unknownProvider: false,
            providersTruncated: false, error: error)
        result = failed; publish(failed, [])
    }
    private func decode<T: Decodable>(_ raw: [String: Any]) -> T? {
        guard let data = try? JSONSerialization.data(withJSONObject: raw) else { return nil }
        return try? JSONDecoder().decode(T.self, from: data)
    }
}
