import Foundation
import Combine

struct TurnFileMetadata: Codable, Hashable, Identifiable {
    let fileId: String
    let path: String
    let oldPath: String?
    let changeKind: String
    let fileKind: String
    let additions: Int?
    let deletions: Int?
    let beforeBytes: Int64?
    let afterBytes: Int64?
    let contentVersion: String
    let detail: String
    var id: String { fileId }
    var name: String { path.split(separator: "/").last.map(String.init) ?? path }
}

struct TurnChangeSummary: Codable, Hashable, Identifiable {
    let projectionVersion: Int
    let agent: ToolAgent
    let reviewTurnId: String
    let sourceTurnIds: [String]
    let changeSetId: String
    let manifestVersion: Int
    let revision: Int
    let anchorEntryId: String?
    let startedAt: Int64
    let finishedAt: Int64?
    let state: String
    let outcome: String
    let coverage: String
    let scope: String
    let attribution: String
    let reasons: [String]
    let fileCount: Int?
    let addedFiles: Int?
    let modifiedFiles: Int?
    let deletedFiles: Int?
    let additions: Int?
    let deletions: Int?
    let preview: [TurnFileMetadata]
    var id: String { changeSetId }
    var versionKey: String { "\(changeSetId):\(manifestVersion)" }
}

private struct TurnChangeListPage: Decodable {
    let agent: ToolAgent; let runtimeId: String; let requestId: String; let summaries: [TurnChangeSummary]; let nextCursor: String?
}
private struct TurnChangeManifestPage: Decodable {
    let agent: ToolAgent; let runtimeId: String; let requestId: String
    let changeSetId: String; let manifestVersion: Int; let files: [TurnFileMetadata]
    let totalCount: Int; let nextCursor: String?
}
private struct TurnFileDetailPage: Decodable {
    let agent: ToolAgent; let runtimeId: String; let requestId: String
    let changeSetId: String; let manifestVersion: Int; let fileId: String; let contentVersion: String
    let viewerId: String; let readId: String; let text: String; let nextCursor: String?; let eof: Bool
}

struct TurnFileManifest {
    var files: [TurnFileMetadata] = []
    var nextCursor: String?
    var started = false
    var complete = false
    var loading = false
    var error: String?
}

struct DiffDisplayLine: Identifiable, Equatable {
    enum Kind { case header, context, addition, deletion, note }
    let id: Int
    let kind: Kind
    let oldLine: Int?
    let newLine: Int?
    let text: String
}

/// Pages may end inside a hunk or a UTF-8 line. Keep the parser state across pages;
/// split exceptionally long lines into bounded display fragments without losing bytes.
struct UnifiedDiffParser {
    private(set) var lines: [DiffDisplayLine] = []
    private var pending = ""
    private var oldLine: Int?
    private var newLine: Int?
    private var continuedKind: DiffDisplayLine.Kind?
    mutating func append(_ text: String, eof: Bool) {
        pending += text
        while let end = pending.unicodeScalars.firstIndex(of: "\n") {
            let line = String(pending.unicodeScalars[..<end])
            pending = String(pending.unicodeScalars[pending.unicodeScalars.index(after: end)...])
            consume(line)
        }
        while pending.utf8.count > 16_384 {
            let split = pending.index(pending.startIndex, offsetBy: min(4096, pending.count))
            let fragment = String(pending[..<split]); pending.removeSubrange(..<split)
            consume(fragment, continues: true)
        }
        if eof && !pending.isEmpty { consume(pending); pending = "" }
    }
    private mutating func consume(_ value: String, continues: Bool = false) {
        if let kind = continuedKind {
            lines.append(.init(id: lines.count, kind: kind, oldLine: nil, newLine: nil, text: value))
            if !continues { continuedKind = nil }
            return
        }
        if value.hasPrefix("@@ "), let range = value.range(of: #"^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@"#, options: .regularExpression) {
            let numbers = value[range].split(whereSeparator: { !$0.isNumber }).compactMap { Int($0) }
            // Parse the two starts separately: optional counts must not become the new start.
            let fields = value[range].split(separator: " ")
            oldLine = fields.count > 2 ? Int(fields[1].dropFirst().split(separator: ",")[0]) : numbers.first
            newLine = fields.count > 2 ? Int(fields[2].dropFirst().split(separator: ",")[0]) : nil
            lines.append(.init(id: lines.count, kind: .header, oldLine: nil, newLine: nil, text: value)); return
        }
        let kind: DiffDisplayLine.Kind
        var old: Int?, new: Int?
        if oldLine != nil, value.hasPrefix("+") { kind = .addition; new = newLine; newLine = newLine.map { $0 + 1 } }
        else if oldLine != nil, value.hasPrefix("-") { kind = .deletion; old = oldLine; oldLine = oldLine.map { $0 + 1 } }
        else if oldLine != nil, value.hasPrefix(" ") {
            kind = .context; old = oldLine; new = newLine; oldLine = oldLine.map { $0 + 1 }; newLine = newLine.map { $0 + 1 }
        } else if value.hasPrefix("\\") { kind = .note }
        else { kind = .header }
        lines.append(.init(id: lines.count, kind: kind, oldLine: old, newLine: new, text: value))
        if continues { continuedKind = kind }
    }
}

struct TurnFileDetail {
    var parser = UnifiedDiffParser()
    var nextCursor: String?
    var eof = false
    var started = false
    var loading = false
    var error: String?
    var bytes = 0
    var limitReached = false
    var scrollLine: Int?
    var readId: String?
    var lines: [DiffDisplayLine] { parser.lines }
}

/// Metadata and detail reads have separate state and lifetimes. Only selectFile(),
/// reached after an explicit open or a settled page transition, can request text.
@MainActor
final class TurnFileChanges: ObservableObject {
    @Published private(set) var summaries: [String: TurnChangeSummary] = [:]
    @Published private(set) var manifests: [String: TurnFileManifest] = [:]
    @Published private(set) var opened: TurnChangeSummary?
    @Published private(set) var selectedFileId: String?
    @Published private(set) var details: [String: TurnFileDetail] = [:]
    @Published private(set) var suspended = false
    var send: (String, [String: Any]) -> Bool = { _, _ in false }
    private(set) var runtimeId: String?
    private var agent: ToolAgent?
    private var queriedEntries: Set<String> = []
    private var queriedTurns: Set<String> = []
    private var viewerId = UUID().uuidString
    private var requests: [String: Request] = [:]
    private var timeouts: [String: Task<Void, Never>] = [:]
    private var visited: [String] = []
    private var readingPositions: [String: Int] = [:]
    private let detailByteLimit = 8 * 1024 * 1024
    private let detailLimitMessage = "已达到此文件 8 MiB 阅读上限，已加载内容仍可查看。"
    private enum Request {
        case list(entries: [String], turns: [String], cursor: String?)
        case manifest(summary: TurnChangeSummary, cursor: String?)
        case detail(summary: TurnChangeSummary, file: TurnFileMetadata, cursor: String?, viewer: String, readId: String?)
    }

    func observe(runtimeId: String, agent: ToolAgent, entryIds: [String], turnIds: [String]) {
        if self.runtimeId != runtimeId || self.agent != agent { clear(); self.runtimeId = runtimeId; self.agent = agent }
        let entries = Set(entryIds.filter(validToolId)).subtracting(queriedEntries)
        let turns = Set(turnIds.filter(validToolId)).subtracting(queriedTurns)
        guard !entries.isEmpty || !turns.isEmpty else { return }
        let sortedEntries = entries.sorted(), sortedTurns = turns.sorted()
        let batches = max((sortedEntries.count + 255) / 256, (sortedTurns.count + 127) / 128)
        for batch in 0..<min(batches, 8) {
            let e = Array(sortedEntries.dropFirst(batch * 256).prefix(256)), t = Array(sortedTurns.dropFirst(batch * 128).prefix(128))
            var command = scope(type: "session.changes.list")
            command["entryIds"] = e; command["turnIds"] = t
            if dispatch(command, request: .list(entries: e, turns: t, cursor: nil)) { queriedEntries.formUnion(e); queriedTurns.formUnion(t) }
        }
    }
    func matching(anchors: Set<String>, turns: Set<String>) -> [TurnChangeSummary] {
        summaries.values.filter { summary in
            guard summary.agent == agent else { return false }
            if let anchor = summary.anchorEntryId { return anchors.contains(anchor) }
            return false // A source turn ID alone does not identify the final displayed entry.
        }.sorted { ($0.startedAt, $0.reviewTurnId) < ($1.startedAt, $1.reviewTurnId) }
    }
    func manifest(_ summary: TurnChangeSummary) -> TurnFileManifest {
        manifests[summary.versionKey] ?? TurnFileManifest(files: summary.preview)
    }
    func loadFiles(_ summary: TurnChangeSummary) {
        guard summary.agent == agent, summary.state == "ready" else { return }
        var state = manifest(summary)
        guard !state.loading, !state.complete else { return }
        let cursor = state.started ? state.nextCursor : nil
        var command = scope(type: "session.changes.read")
        command["changeSetId"] = summary.changeSetId; command["manifestVersion"] = summary.manifestVersion
        command["cursor"] = cursor as Any? ?? NSNull(); command["maxItems"] = 100
        state.loading = true; state.error = nil; manifests[summary.versionKey] = state
        if !dispatch(command, request: .manifest(summary: summary, cursor: cursor)) {
            state.loading = false; state.error = "文件清单未送达，请连接电脑后重试。"; manifests[summary.versionKey] = state
        }
    }
    var viewerFiles: [TurnFileMetadata] { opened.map { manifest($0).files } ?? [] }
    var selectedFile: TurnFileMetadata? { viewerFiles.first { $0.fileId == selectedFileId } }
    func detail(for file: TurnFileMetadata) -> TurnFileDetail {
        let key = detailKey(file)
        var state = details[key] ?? TurnFileDetail(); state.scrollLine = readingPositions[key]; return state
    }
    var currentDetail: TurnFileDetail { selectedFile.map { detail(for: $0) } ?? TurnFileDetail() }
    var newerVersionAvailable: Bool {
        guard let opened, let current = summaries[opened.changeSetId] else { return false }
        return current.manifestVersion != opened.manifestVersion
    }
    func open(_ summary: TurnChangeSummary, fileId: String? = nil) {
        guard summary.agent == agent else { return }
        closeViewer(); opened = summary; suspended = false; viewerId = UUID().uuidString
        let files = manifest(summary).files
        selectedFileId = fileId ?? files.first?.fileId
        if let selectedFileId { selectFile(selectedFileId) }
        if files.isEmpty { loadFiles(summary) }
    }
    func selectFile(_ fileId: String) {
        guard let file = viewerFiles.first(where: { $0.fileId == fileId }), opened != nil else { return }
        cancelDetail(); selectedFileId = fileId; suspended = false
        let key = detailKey(file)
        visited.removeAll { $0 == key }; visited.append(key)
        trimDetailCache(protecting: key)
        if details[key]?.started != true { loadNext() }
    }
    func loadNext() {
        guard !suspended, let summary = opened, let file = selectedFile else { return }
        let key = detailKey(file)
        var state = details[key] ?? TurnFileDetail()
        guard !state.loading, !state.eof, !state.limitReached else { return }
        guard file.detail == "available" else { state.error = turnChangeFailureTitle(file.detail); state.eof = true; details[key] = state; return }
        guard state.bytes < detailByteLimit else { state.limitReached = true; state.error = detailLimitMessage; details[key] = state; return }
        var command = scope(type: "session.change.detail.read")
        command["changeSetId"] = summary.changeSetId; command["manifestVersion"] = summary.manifestVersion
        command["fileId"] = file.fileId; command["contentVersion"] = file.contentVersion
        command["viewerId"] = viewerId; command["readId"] = state.readId as Any? ?? NSNull()
        command["cursor"] = state.nextCursor as Any? ?? NSNull(); command["maxBytes"] = 32_768
        state.loading = true; state.error = nil; details[key] = state
        if !dispatch(command, request: .detail(summary: summary, file: file, cursor: state.nextCursor, viewer: viewerId, readId: state.readId)) {
            state.loading = false; state.error = "差异读取未送达，请连接电脑后重试。"; details[key] = state
        }
    }
    func rememberScroll(_ line: Int?, file: TurnFileMetadata) {
        let key = detailKey(file)
        guard details[key] != nil else { return }
        readingPositions[key] = line
    }
    func suspend() { cancelDetail(); suspended = true }
    func resume() { guard opened != nil else { return }; suspended = false; if currentDetail.lines.isEmpty { loadNext() } }
    func closeViewer() { cancelDetail(); opened = nil; selectedFileId = nil; suspended = false }
    func clear() {
        closeViewer(); timeouts.values.forEach { $0.cancel() }; timeouts = [:]; requests = [:]
        summaries = [:]; manifests = [:]; details = [:]; queriedEntries = []; queriedTurns = []; visited = []; readingPositions = [:]
        runtimeId = nil; agent = nil
    }
    func disconnected() {
        closeViewer()
        for (id, request) in Array(requests) { fail(id, request: request, message: "连接已断开，请重试。") }
        queriedEntries = []; queriedTurns = []
    }

    func consume(_ event: [String: Any], runtimeId: String) {
        guard runtimeId == self.runtimeId, let type = event["type"] as? String else { return }
        if type == "session.changes.updated", let raw = event["summary"] as? [String: Any], let summary: TurnChangeSummary = decode(raw), valid(summary) {
            accept(summary); return
        }
        guard let id = event["requestId"] as? String, let request = requests[id] else { return }
        if type == "session.changes.failed" {
            if event["reason"] as? String == "expired", reopenExpiredDetail(id, request: request) { return }
            fail(id, request: request, message: turnChangeFailureTitle(event["reason"] as? String)); return
        }
        switch request {
        case .list(let entries, let turns, let cursor):
            guard type == "session.changes.summaries", let page: TurnChangeListPage = decode(event), page.agent == agent,
                  page.runtimeId == runtimeId, page.summaries.count <= 128, page.summaries.allSatisfy(valid) else { return }
            guard page.nextCursor == nil || (page.nextCursor != cursor && !page.summaries.isEmpty) else { return }
            finish(id); page.summaries.forEach(accept)
            if let next = page.nextCursor {
                var command = scope(type: "session.changes.list")
                command["entryIds"] = entries; command["turnIds"] = turns; command["cursor"] = next
                _ = dispatch(command, request: .list(entries: entries, turns: turns, cursor: next))
            }
        case .manifest(let summary, let cursor):
            guard type == "session.changes.page", let page: TurnChangeManifestPage = decode(event), page.agent == agent,
                  page.runtimeId == runtimeId, page.changeSetId == summary.changeSetId, page.manifestVersion == summary.manifestVersion,
                  page.files.count <= 100, page.files.allSatisfy(valid), Set(page.files.map(\.id)).count == page.files.count,
                  page.totalCount >= page.files.count, page.nextCursor == nil || (page.nextCursor != cursor && !page.files.isEmpty) else { return }
            var state = manifest(summary)
            let existing = cursor == nil ? [] : state.files
            guard Set(existing.map(\.id)).isDisjoint(with: page.files.map(\.id)), existing.count + page.files.count <= page.totalCount,
                  page.nextCursor != nil || existing.count + page.files.count == page.totalCount else { return }
            finish(id); state.files = existing + page.files; state.nextCursor = page.nextCursor
            state.started = true; state.complete = page.nextCursor == nil; state.loading = false; state.error = nil
            manifests[summary.versionKey] = state
            if opened?.versionKey == summary.versionKey, selectedFileId == nil, let first = state.files.first { selectFile(first.fileId) }
        case .detail(let summary, let file, let cursor, let viewer, _):
            guard type == "session.change.detail.page", let page: TurnFileDetailPage = decode(event), page.agent == agent,
                  page.runtimeId == runtimeId, opened?.versionKey == summary.versionKey, selectedFileId == file.fileId,
                  viewerId == viewer, page.viewerId == viewer, page.changeSetId == summary.changeSetId,
                  page.manifestVersion == summary.manifestVersion, page.fileId == file.fileId, page.contentVersion == file.contentVersion,
                  validToolId(page.readId), page.text.utf8.count <= 32_768,
                  page.eof == (page.nextCursor == nil), page.nextCursor == nil || (page.nextCursor != cursor && !page.text.isEmpty) else { return }
            let key = detailKey(file)
            var state = details[key] ?? TurnFileDetail()
            guard state.readId == nil || state.readId == page.readId else { fail(id, request: request, message: "差异版本不匹配，请重新打开。"); return }
            let pageBytes = page.text.utf8.count
            finish(id)
            guard pageBytes <= detailByteLimit - state.bytes else {
                state.loading = false; state.limitReached = true; state.error = detailLimitMessage; details[key] = state; return
            }
            state.parser.append(page.text, eof: page.eof); state.bytes += pageBytes
            state.nextCursor = page.nextCursor; state.eof = page.eof; state.started = true; state.loading = false; state.error = nil; state.readId = page.readId
            // Evict before publishing this page so observers never see an oversized cache.
            trimDetailCache(protecting: key, additionalBytes: pageBytes)
            details[key] = state
        }
    }
    private func reopenExpiredDetail(_ id: String, request: Request) -> Bool {
        guard case .detail(let summary, let file, let cursor, let viewer, let readId) = request,
              let readId, !suspended, opened?.versionKey == summary.versionKey,
              selectedFileId == file.fileId, selectedFile?.contentVersion == file.contentVersion, viewerId == viewer else { return false }
        let key = detailKey(file)
        guard var state = details[key], state.loading, state.readId == readId, state.nextCursor == cursor else { return false }
        finish(id); state.loading = false; state.readId = nil; state.error = nil; details[key] = state
        // The retry carries no lease, so a second expired response cannot retry again.
        loadNext()
        return true
    }
    private func trimDetailCache(protecting key: String, additionalBytes: Int = 0) {
        while visited.count > 12 || details.values.reduce(0, { $0 + $1.bytes }) + additionalBytes > detailByteLimit {
            guard let index = visited.firstIndex(where: { $0 != key }) else { return }
            let removed = visited.remove(at: index)
            details.removeValue(forKey: removed); readingPositions.removeValue(forKey: removed)
        }
    }
    private func accept(_ summary: TurnChangeSummary) {
        if let current = summaries[summary.changeSetId] {
            guard summary.manifestVersion >= current.manifestVersion, summary.revision >= current.revision else { return }
        }
        summaries[summary.changeSetId] = summary
    }
    private func valid(_ summary: TurnChangeSummary) -> Bool {
        summary.agent == agent && summary.projectionVersion == 1 && validToolId(summary.changeSetId) && validToolId(summary.reviewTurnId) && summary.manifestVersion >= 0 && summary.revision >= 0 && summary.preview.count <= 4 && summary.preview.allSatisfy(valid)
    }
    private func valid(_ file: TurnFileMetadata) -> Bool {
        validToolId(file.fileId) && validToolId(file.contentVersion) && !file.path.isEmpty && file.path.utf8.count <= 16_384 && (file.additions ?? 0) >= 0 && (file.deletions ?? 0) >= 0
    }
    private func scope(type: String) -> [String: Any] {
        ["type": type, "requestId": UUID().uuidString, "runtimeId": runtimeId ?? "", "agent": ["hostId": agent?.hostId ?? "", "agentKind": agent?.agentKind ?? "", "sessionId": agent?.sessionId ?? ""]]
    }
    private func dispatch(_ command: [String: Any], request: Request) -> Bool {
        guard let runtimeId, let id = command["requestId"] as? String, requests.count < 16 else { return false }
        requests[id] = request
        guard send(runtimeId, command) else { requests[id] = nil; return false }
        timeouts[id] = Task { [weak self] in
            do { try await Task.sleep(nanoseconds: 30_000_000_000) } catch { return }
            guard let self, let request = self.requests[id] else { return }
            self.fail(id, request: request, message: "读取超时，请重试。")
        }
        return true
    }
    private func fail(_ id: String, request: Request, message: String) {
        finish(id)
        switch request {
        case .list: queriedEntries = []; queriedTurns = []
        case .manifest(let summary, _): var state = manifest(summary); state.loading = false; state.error = message; manifests[summary.versionKey] = state
        case .detail(_, let file, _, _, _): let key = detailKey(file); var state = details[key] ?? TurnFileDetail(); state.loading = false; state.error = message; details[key] = state
        }
    }
    private func finish(_ id: String) { requests[id] = nil; timeouts.removeValue(forKey: id)?.cancel() }
    private func cancelDetail() {
        guard let runtimeId else { return }
        let outstanding = requests.filter { if case .detail = $0.value { return true }; return false }
        if !outstanding.isEmpty || currentDetail.readId != nil {
            _ = send(runtimeId, ["type": "session.change.detail.cancel", "runtimeId": runtimeId, "requestId": UUID().uuidString,
                "viewerId": viewerId, "readId": currentDetail.readId as Any? ?? NSNull()])
        }
        for (id, request) in outstanding { fail(id, request: request, message: "读取已暂停。") }
        if let file = selectedFile { details[detailKey(file)]?.readId = nil }
        viewerId = UUID().uuidString
    }
    private func detailKey(_ file: TurnFileMetadata) -> String { "\(opened?.versionKey ?? ""):\(file.fileId):\(file.contentVersion)" }
    private func decode<T: Decodable>(_ value: [String: Any]) -> T? {
        guard let data = try? JSONSerialization.data(withJSONObject: value), data.count <= 60 * 1024 else { return nil }
        return try? JSONDecoder().decode(T.self, from: data)
    }
}

func turnChangeFailureTitle(_ reason: String?) -> String {
    switch reason {
    case "binary": return "二进制文件，仅显示变更信息。"
    case "too-large": return "文件超过文本比较上限，仅显示变更信息。"
    case "unsupported": return "此文件类型暂不支持文本差异。"
    case "not-captured": return "此轮未保存可比较的文件版本。"
    case "expired": return "此轮文件版本已超过电脑端保留期限。"
    case "version-mismatch": return "差异版本已更新，请重新打开。"
    case "scope-mismatch": return "详情所属会话已变化，请重新打开。"
    case "busy": return "电脑端正在处理，请稍后重试。"
    default: return "暂时无法读取此轮文件变化。"
    }
}

func turnChangeKindTitle(_ kind: String) -> String {
    ["added": "新增", "modified": "修改", "deleted": "删除", "renamed": "重命名", "type-changed": "类型变化"][kind] ?? "变化"
}

func reviewFileNameParts(_ name: String) -> (stem: String, ext: String) {
    guard !name.isEmpty, !name.hasPrefix(".") || name.dropFirst().contains(".") else { return (name, "") }
    let lower = name.lowercased()
    for ext in [".d.ts", ".d.mts", ".d.cts", ".tar.gz", ".tar.bz2", ".tar.xz", ".test.tsx", ".test.ts", ".spec.tsx", ".spec.ts"] where lower.hasSuffix(ext) && name.count > ext.count {
        let split = name.index(name.endIndex, offsetBy: -ext.count)
        return (String(name[..<split]), String(name[split...]))
    }
    guard let dot = name.lastIndex(of: "."), dot != name.startIndex, dot < name.index(before: name.endIndex) else { return (name, "") }
    return (String(name[..<dot]), String(name[dot...]))
}

func turnChangeScopeTitle(_ scope: String) -> String {
    switch scope {
    case "git-visible-files": return "范围：已跟踪及非忽略文件"
    case "bounded-directory": return "范围：当前目录，已排除缓存"
    default: return "采集范围未确认"
    }
}
