import Foundation

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
        session.messageCount <= 100_000 && ["pi", "codex", "codexDesktop", "dsh", "claude"].contains(session.agentKind ?? "")
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
