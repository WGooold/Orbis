import Foundation
import Combine

func validToolId(_ value: String) -> Bool { !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && value.utf8.count <= 256 }

struct ToolAgent: Codable, Hashable { let hostId: String; let agentKind: String; let sessionId: String }
struct ToolIdentity: Codable, Hashable { let agent: ToolAgent; let toolCallId: String }
struct ToolPart: Codable, Hashable { let part: String; let format: String; let availability: String; let readCapability: String }
struct ToolLocator: Codable, Hashable { var projectionVersion = 1; let tool: ToolIdentity; let part: String }
struct ToolReadIdentity: Codable, Hashable { let readId: String; let contentEpoch: String; let throughOffset: Int64 }
struct ToolGap: Codable, Hashable { let fromOffset: Int64; let throughOffset: Int64; let reason: String }
struct ToolContentPage: Codable {
    let requestId: String; let runtimeId: String; let locator: ToolLocator; let read: ToolReadIdentity
    let format: String; let representation: String; let fromOffset: Int64; let throughOffset: Int64
    let availableFromOffset: Int64; let availableThroughOffset: Int64; let observedThroughOffset: Int64
    let contentFinal: Bool; let text: String; let nextCursor: Int64?; let gaps: [ToolGap]
}


/// A serial writer keeps exported pages off MainActor and out of the detail cache.
/// Only a fully written fixed range is published at the destination.
private final class ToolExportFile: @unchecked Sendable {
    let destination: URL
    private let temporary: URL
    private let queue = DispatchQueue(label: "orbis.tool-export", qos: .utility)
    private var output: FileHandle?
    private var scoped = false
    private var published = false

    init(destination: URL) {
        self.destination = destination
        temporary = destination.deletingLastPathComponent().appendingPathComponent(".orbis-tool-export-" + UUID().uuidString + ".part")
    }
    private func perform(_ action: @escaping @Sendable () throws -> Void) async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            queue.async { do { try action(); continuation.resume() } catch { continuation.resume(throwing: error) } }
        }
    }
    func prepare() async throws {
        try await perform { [self] in
            guard destination.isFileURL, !FileManager.default.fileExists(atPath: destination.path) else { throw failure("请选择新的导出文件路径。") }
            scoped = destination.startAccessingSecurityScopedResource()
            try FileManager.default.createDirectory(at: destination.deletingLastPathComponent(), withIntermediateDirectories: true)
            guard FileManager.default.createFile(atPath: temporary.path, contents: nil) else { throw failure("无法创建导出文件。") }
            output = try FileHandle(forWritingTo: temporary)
        }
    }
    func append(_ data: Data) async throws {
        try await perform { [self] in
            guard let output else { throw failure("导出已取消。") }
            try output.write(contentsOf: data)
        }
    }
    func finish() async throws {
        try await perform { [self] in
            guard let output else { throw failure("导出已取消。") }
            try output.synchronize(); try output.close(); self.output = nil
            try FileManager.default.moveItem(at: temporary, to: destination); published = true
            if scoped { destination.stopAccessingSecurityScopedResource(); scoped = false }
        }
    }
    func cancel() async throws {
        try await perform { [self] in
            try? output?.close(); output = nil
            defer { if scoped { destination.stopAccessingSecurityScopedResource(); scoped = false } }
            if FileManager.default.fileExists(atPath: temporary.path) { try FileManager.default.removeItem(at: temporary) }
            if published, FileManager.default.fileExists(atPath: destination.path) { try FileManager.default.removeItem(at: destination); published = false }
        }
    }
    private func failure(_ text: String) -> NSError { NSError(domain: "OrbisToolExport", code: 1, userInfo: [NSLocalizedDescriptionKey: text]) }
}

@MainActor
final class ToolContentReader: ObservableObject {
    @Published private(set) var text = ""
    @Published private(set) var loading = false
    @Published private(set) var error: String?
    @Published private(set) var gaps: [ToolGap] = []
    @Published private(set) var nextCursor: Int64?
    @Published private(set) var final = false
    @Published private(set) var discardedPrefix = false
    @Published private(set) var locator: ToolLocator?
    @Published private(set) var throughOffset: Int64 = 0
    @Published private(set) var following = false
    @Published private(set) var retryAfter: Date?
    @Published private(set) var exporting = false
    @Published private(set) var exportedBytes: Int64 = 0
    @Published private(set) var exportComplete = false
    @Published private(set) var exportedPath: String?
    @Published private(set) var exportError: String?
    static let exportByteLimit: Int64 = 64 * 1024 * 1024
    var send: (String, [String: Any]) -> Bool = { _, _ in false }
    private var runtimeId: String?
    private var viewerId = UUID().uuidString
    private var read: ToolReadIdentity?
    private var request: (id: String, offset: Int64)?
    private var timeout: Task<Void, Never>?
    private var followTask: Task<Void, Never>?
    private var lastEpoch: String?
    private var exportFile: ToolExportFile?
    private var exportID: UUID?
    private var exportResumeEpoch: String?

    func open(runtimeId: String, locator: ToolLocator) {
        close(); self.runtimeId = runtimeId; self.locator = locator
        lastEpoch = nil
        exportedBytes = 0; exportComplete = false; exportedPath = nil; exportError = nil
        viewerId = UUID().uuidString; text = ""; gaps = []; throughOffset = 0; final = false; discardedPrefix = false
        load(offset: 0)
    }
    func loadNext() { if !exporting, let nextCursor { load(offset: nextCursor) } }
    func retry() {
        guard !exporting, retryAfter.map({ $0 <= Date() }) ?? true else { return }
        if let nextCursor { load(offset: nextCursor) }
        else { cancelRead(); read = nil; lastEpoch = nil; text = ""; gaps = []; throughOffset = 0; discardedPrefix = false; load(offset: 0) }
    }
    func follow(_ enabled: Bool) {
        following = enabled && !exporting
        followTask?.cancel(); followTask = nil
        if following { scheduleFollow() }
    }
    /// Starts a new fixed read from byte zero. The destination is published only
    /// after every page is validated and written; existing files are preserved.
    func export(to destination: URL) {
        guard !exporting, runtimeId != nil, locator != nil else { return }
        cancelRead(); timeout?.cancel(); request = nil; loading = false; follow(false)
        exportResumeEpoch = lastEpoch
        read = nil; lastEpoch = nil; viewerId = UUID().uuidString
        exportedBytes = 0; exportComplete = false; exportedPath = nil; exportError = nil; error = nil
        let id = UUID(), file = ToolExportFile(destination: destination)
        exportID = id; exportFile = file; exporting = true
        Task { [weak self] in
            do {
                try await file.prepare()
                guard let self, self.exportID == id else { try? await file.cancel(); return }
                self.load(offset: 0)
            } catch {
                guard let self, self.exportID == id else { try? await file.cancel(); return }
                self.abortExport(error.localizedDescription)
            }
        }
    }
    func cancelExport() { abortExport("导出已取消。") }
    private func abortExport(_ message: String?) {
        guard exporting || exportFile != nil else { return }
        let file = exportFile
        cancelRead(); timeout?.cancel(); request = nil; loading = false; following = false
        exportID = nil; exportFile = nil; exporting = false; exportComplete = false
        restoreViewerAfterExport()
        exportError = message
        if let message { error = message }
        Task { [weak self] in
            do { try await file?.cancel() }
            catch { self?.exportError = "未完成的导出文件无法删除：\(error.localizedDescription)" }
        }
    }
    private func writeExportPage(_ page: ToolContentPage) {
        guard let id = exportID, let file = exportFile else { return }
        guard page.gaps.isEmpty else { abortExport("内容存在缺失范围，未导出不完整文件。"); return }
        let bytes = Data(page.text.utf8)
        guard page.read.throughOffset <= Self.exportByteLimit, exportedBytes + Int64(bytes.count) <= Self.exportByteLimit else {
            abortExport("导出达到 64 MiB 上限。"); return
        }
        loading = true
        Task { [weak self] in
            do {
                try await file.append(bytes)
                guard let self, self.exportID == id else { try? await file.cancel(); return }
                self.exportedBytes += Int64(bytes.count); self.loading = false
                if let cursor = page.nextCursor { self.load(offset: cursor) }
                else {
                    try await file.finish()
                    guard self.exportID == id else { try? await file.cancel(); return }
                    self.exportedPath = file.destination.path; self.exportComplete = true; self.exporting = false
                    self.exportFile = nil; self.exportID = nil
                    self.cancelRead()
                    self.restoreViewerAfterExport()
                }
            } catch {
                guard let self, self.exportID == id else { try? await file.cancel(); return }
                self.abortExport(error.localizedDescription)
            }
        }
    }
    private func restoreViewerAfterExport() {
        // The export used a separate fixed read. Keep the bounded detail cache
        // and cursor, then acquire a fresh read when the viewer continues.
        read = nil; request = nil; lastEpoch = exportResumeEpoch; exportResumeEpoch = nil
        viewerId = UUID().uuidString
    }
    private func load(offset: Int64) {
        guard !loading, offset >= 0, let runtimeId, let locator else { return }
        let id = UUID().uuidString
        let readObject: Any = read.map { encode($0) as Any } ?? NSNull()
        let command: [String: Any] = ["type": "session.tool.content.read", "runtimeId": runtimeId, "requestId": id,
            "viewerId": viewerId, "locator": encode(locator), "read": readObject, "offset": offset, "maxBytes": 32768]
        guard send(runtimeId, command) else {
            if exporting { abortExport("内容读取未送达，请连接后重试。") } else { error = "内容读取未送达，请连接后重试。" }
            return
        }
        request = (id, offset); loading = true; error = nil; retryAfter = nil
        timeout?.cancel()
        timeout = Task { [weak self] in
            do { try await Task.sleep(nanoseconds: 30_000_000_000) } catch { return }
            guard let self, self.request?.id == id else { return }
            if self.exporting { self.abortExport("内容读取超时，请重试。") }
            else { self.loading = false; self.request = nil; self.error = "内容读取超时，请重试。"; self.follow(false) }
        }
    }
    func consume(_ event: [String: Any], runtimeId: String) {
        guard runtimeId == self.runtimeId, let request, event["requestId"] as? String == request.id else { return }
        let type = event["type"] as? String
        if type == "session.tool.read.failed" {
            timeout?.cancel(); loading = false; self.request = nil; follow(false)
            error = toolReadFailureTitle(event["reason"] as? String)
            if exporting { abortExport(error) }
            if let ms = (event["retryAfterMs"] as? NSNumber)?.doubleValue { retryAfter = Date().addingTimeInterval(ms / 1000) }
            return
        }
        guard type == "session.tool.content.page", let data = try? JSONSerialization.data(withJSONObject: event),
              data.count <= 65536, let page = try? JSONDecoder().decode(ToolContentPage.self, from: data) else { return }
        guard page.runtimeId == runtimeId, page.locator == locator, page.representation == "utf8-fragment",
              ["text", "json", "media-references"].contains(page.format), page.availableFromOffset >= 0,
              page.fromOffset >= 0, page.throughOffset >= page.fromOffset, page.observedThroughOffset <= 9_007_199_254_740_991,
              page.fromOffset == request.offset, page.throughOffset - page.fromOffset == page.text.utf8.count,
              page.text.utf8.count <= 32768, page.fromOffset >= page.availableFromOffset,
              page.throughOffset <= page.read.throughOffset, page.read.throughOffset <= page.availableThroughOffset,
              page.availableThroughOffset <= page.observedThroughOffset, page.gaps.count <= 32,
              page.nextCursor == (page.throughOffset < page.read.throughOffset ? page.throughOffset : nil),
              page.nextCursor == nil || page.throughOffset > page.fromOffset,
              page.fromOffset >= 0, page.read.throughOffset >= 0, validToolId(page.read.readId), validToolId(page.read.contentEpoch),
              lastEpoch == nil || lastEpoch == page.read.contentEpoch,
              read == nil || read == page.read else {
            rejectPage("内容版本或范围不匹配，请重新打开详情。"); return
        }
        var coverage: Int64 = 0
        for gap in page.gaps {
            if coverage == page.availableFromOffset { coverage = page.availableThroughOffset }
            guard gap.fromOffset == coverage, gap.fromOffset >= 0, gap.fromOffset < gap.throughOffset,
                  gap.throughOffset <= page.observedThroughOffset, ["quota", "expired", "source-missing"].contains(gap.reason),
                  gap.throughOffset <= page.availableFromOffset || gap.fromOffset >= page.availableThroughOffset else {
                rejectPage("内容缺口声明无效。"); return
            }
            coverage = gap.throughOffset
        }
        if coverage == page.availableFromOffset { coverage = page.availableThroughOffset }
        guard coverage == page.observedThroughOffset else { rejectPage("内容范围不完整。"); return }
        timeout?.cancel(); loading = false; self.request = nil; read = page.read
        lastEpoch = page.read.contentEpoch
        if exporting { writeExportPage(page); return }
        if text.utf8.count + page.text.utf8.count > 2 * 1024 * 1024 { text = ""; discardedPrefix = true }
        text += page.text; gaps = page.gaps; nextCursor = page.nextCursor; final = page.contentFinal; throughOffset = page.throughOffset
        if following { scheduleFollow() }
    }
    private func rejectPage(_ message: String) {
        if exporting { abortExport(message); return }
        timeout?.cancel(); request = nil; loading = false; error = message; follow(false)
    }
    private func scheduleFollow() {
        guard following, !loading, error == nil, !final || nextCursor != nil else { return }
        followTask?.cancel()
        followTask = Task { [weak self] in
            do { try await Task.sleep(nanoseconds: 1_500_000_000) } catch { return }
            guard let self, self.following, self.locator != nil else { return }
            if let next = self.nextCursor { self.load(offset: next) }
            else { self.cancelRead(); self.read = nil; self.load(offset: self.throughOffset) }
        }
    }
    private func cancelRead() {
        if let runtimeId, read != nil || request != nil {
            _ = send(runtimeId, ["type": "session.tool.content.cancel", "runtimeId": runtimeId, "requestId": UUID().uuidString, "viewerId": viewerId, "readId": read?.readId ?? "cancel-pending"])
        }
    }
    func close() {
        abortExport(nil)
        cancelRead(); timeout?.cancel(); followTask?.cancel(); following = false; loading = false
        locator = nil; runtimeId = nil; read = nil; request = nil; nextCursor = nil; error = nil; retryAfter = nil
        lastEpoch = nil
    }
    private func encode<T: Encodable>(_ object: T) -> [String: Any] {
        guard let data = try? JSONEncoder().encode(object), let value = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return [:] }
        return value
    }
}

func toolReadFailureTitle(_ reason: String?) -> String {
    switch reason {
    case "busy": return "电脑端读取繁忙，请稍后重试。"
    case "content_expired", "snapshot_expired": return "内容读取已过期，请重新打开详情。"
    case "content_version_invalid": return "内容版本已变化，请重新打开详情。"
    case "content_range_unavailable", "invalid_utf8_offset": return "请求范围不可读取。"
    case "scope_mismatch": return "详情所属会话已变化，请重新打开。"
    case "cancelled": return "详情读取已取消。"
    default: return "来源暂时无法提供这部分内容。"
    }
}
