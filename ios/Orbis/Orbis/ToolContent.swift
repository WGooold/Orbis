import Foundation
import Combine

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
    var send: (String, [String: Any]) -> Bool = { _, _ in false }
    private var runtimeId: String?
    private var viewerId = UUID().uuidString
    private var read: ToolReadIdentity?
    private var request: (id: String, offset: Int64)?
    private var timeout: Task<Void, Never>?
    private var followTask: Task<Void, Never>?
    private var lastEpoch: String?

    func open(runtimeId: String, locator: ToolLocator) {
        close(); self.runtimeId = runtimeId; self.locator = locator
        lastEpoch = nil
        viewerId = UUID().uuidString; text = ""; gaps = []; throughOffset = 0; final = false; discardedPrefix = false
        load(offset: 0)
    }
    func loadNext() { if let nextCursor { load(offset: nextCursor) } }
    func retry() {
        guard retryAfter.map({ $0 <= Date() }) ?? true else { return }
        if let nextCursor { load(offset: nextCursor) }
        else { cancelRead(); read = nil; lastEpoch = nil; text = ""; gaps = []; throughOffset = 0; discardedPrefix = false; load(offset: 0) }
    }
    func follow(_ enabled: Bool) {
        following = enabled
        followTask?.cancel(); followTask = nil
        if enabled { scheduleFollow() }
    }
    private func load(offset: Int64) {
        guard !loading, let runtimeId, let locator else { return }
        let id = UUID().uuidString
        let readObject: Any = read.map { encode($0) as Any } ?? NSNull()
        let command: [String: Any] = ["type": "session.tool.content.read", "runtimeId": runtimeId, "requestId": id,
            "viewerId": viewerId, "locator": encode(locator), "read": readObject, "offset": offset, "maxBytes": 32768]
        guard send(runtimeId, command) else { error = "内容读取未送达，请连接后重试。"; return }
        request = (id, offset); loading = true; error = nil; retryAfter = nil
        timeout?.cancel()
        timeout = Task { [weak self] in
            do { try await Task.sleep(nanoseconds: 30_000_000_000) } catch { return }
            guard let self, self.request?.id == id else { return }
            self.loading = false; self.error = "内容读取超时，请重试。"; self.follow(false)
        }
    }
    func consume(_ event: [String: Any], runtimeId: String) {
        guard runtimeId == self.runtimeId, let request, event["requestId"] as? String == request.id else { return }
        let type = event["type"] as? String
        if type == "session.tool.read.failed" {
            timeout?.cancel(); loading = false; self.request = nil; follow(false)
            error = toolReadFailureTitle(event["reason"] as? String)
            if let ms = (event["retryAfterMs"] as? NSNumber)?.doubleValue { retryAfter = Date().addingTimeInterval(ms / 1000) }
            return
        }
        guard type == "session.tool.content.page", let data = try? JSONSerialization.data(withJSONObject: event),
              data.count <= 65536, let page = try? JSONDecoder().decode(ToolContentPage.self, from: data) else { return }
        guard page.runtimeId == runtimeId, page.locator == locator, page.representation == "utf8-fragment",
              page.fromOffset == request.offset, page.throughOffset - page.fromOffset == page.text.utf8.count,
              page.text.utf8.count <= 32768, page.fromOffset >= page.availableFromOffset,
              page.throughOffset <= page.read.throughOffset, page.read.throughOffset <= page.availableThroughOffset,
              page.availableThroughOffset <= page.observedThroughOffset, page.gaps.count <= 32,
              page.nextCursor == (page.throughOffset < page.read.throughOffset ? page.throughOffset : nil),
              page.nextCursor == nil || page.throughOffset > page.fromOffset,
              page.fromOffset >= 0, page.read.throughOffset >= 0, !page.read.readId.isEmpty, !page.read.contentEpoch.isEmpty,
              lastEpoch == nil || lastEpoch == page.read.contentEpoch,
              read == nil || read == page.read else {
            timeout?.cancel(); loading = false; error = "内容版本或范围不匹配，请重新打开详情。"; follow(false); return
        }
        var coverage: Int64 = 0
        for gap in page.gaps {
            if coverage == page.availableFromOffset { coverage = page.availableThroughOffset }
            guard gap.fromOffset == coverage, gap.fromOffset < gap.throughOffset, gap.throughOffset <= page.observedThroughOffset else {
                timeout?.cancel(); loading = false; error = "内容缺口声明无效。"; follow(false); return
            }
            coverage = gap.throughOffset
        }
        if coverage == page.availableFromOffset { coverage = page.availableThroughOffset }
        guard coverage == page.observedThroughOffset else { loading = false; error = "内容范围不完整。"; follow(false); return }
        timeout?.cancel(); loading = false; self.request = nil; read = page.read
        lastEpoch = page.read.contentEpoch
        if text.utf8.count + page.text.utf8.count > 2 * 1024 * 1024 { text = ""; discardedPrefix = true }
        text += page.text; gaps = page.gaps; nextCursor = page.nextCursor; final = page.contentFinal; throughOffset = page.throughOffset
        if following { scheduleFollow() }
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
        if let runtimeId, let read {
            _ = send(runtimeId, ["type": "session.tool.content.cancel", "runtimeId": runtimeId, "requestId": UUID().uuidString, "viewerId": viewerId, "readId": read.readId])
        }
    }
    func close() {
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
