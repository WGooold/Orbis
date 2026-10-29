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
