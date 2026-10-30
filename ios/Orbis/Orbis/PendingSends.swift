import Foundation

/// ADR-0049：手机已发出、还没在源端记录里落地的一条消息。只在本机内存中存在，
/// 不写入历史缓存、applied baseline 或分页状态；落地后立即删除，此后由权威记录负责显示。
struct PendingSend: Equatable, Identifiable {
    enum State: Equatable {
        case sending
        case accepted
        case failed(String)
        /// 断线或 Runtime 离线时还没定论：命令可能已经送达，核对前不允许重新发送。
        case unconfirmed
    }

    let messageId: String
    let commandId: String
    let sessionId: String
    let text: String
    let attachments: [String]
    let delivery: String?
    let createdAt: Date
    /// 创建时最后一条权威消息；本地行插在它后面，助手流先到时顺序仍是「提问 → 回复」。
    let anchorMessageId: String?
    var state: State = .sending
    var acceptedAt: Date?
    /// 接受之后观察到 Runtime 忙过，回到 idle 时这一轮已经结束。
    var sawBusy = false
    /// 兜底核对开始时的权威状态版本；之后再应用一次权威状态才能下结论。
    var settleRevision: Int?

    var id: String { messageId }
    /// 带 `delivery` 且尚未被接受时，它在队列面板里显示「提交中」。
    var showsInQueue: Bool { delivery != nil && state == .sending }
}

struct PendingSendOutbox: Equatable {
    static let acceptedIdleGrace: TimeInterval = 15
    private(set) var items: [PendingSend] = []

    var isEmpty: Bool { items.isEmpty }
    var sessionIds: Set<String> { Set(items.map(\.sessionId)) }
    func item(_ messageId: String?) -> PendingSend? { messageId.flatMap { id in items.first { $0.messageId == id } } }
    func owns(commandId: String) -> Bool { items.contains { $0.commandId == commandId } }
    func chatRows(sessionId: String?) -> [PendingSend] {
        items.filter { $0.sessionId == sessionId && !$0.showsInQueue }.sorted { $0.createdAt < $1.createdAt }
    }
    func queueRows(sessionId: String?) -> [PendingSend] {
        items.filter { $0.sessionId == sessionId && $0.showsInQueue }.sorted { $0.createdAt < $1.createdAt }
    }
    /// 聊天里的本地行已经代表这条消息，Host 队列里的同一项不再重复显示。
    func hidesQueueItem(_ queueId: String) -> Bool { items.contains { $0.messageId == queueId && !$0.showsInQueue && $0.delivery == nil } }

    mutating func add(_ send: PendingSend) {
        items.removeAll { $0.messageId == send.messageId }
        items.append(send)
    }

    @discardableResult
    mutating func remove(_ messageId: String) -> PendingSend? {
        guard let index = items.firstIndex(where: { $0.messageId == messageId }) else { return nil }
        return items.remove(at: index)
    }

    mutating func removeAll() { items = [] }

    /// `cancelled` 由客户端在断线时合成，或表示回合被取消：都不能证明消息没有送达。
    @discardableResult
    mutating func commandResult(_ commandId: String, ok: Bool, status: String?, error: String?, now: Date = Date()) -> Bool {
        guard let index = items.firstIndex(where: { $0.commandId == commandId }) else { return false }
        var item = items[index]
        if ok {
            if item.state != .accepted { item.state = .accepted; item.acceptedAt = now; item.sawBusy = false; item.settleRevision = nil }
        } else if status == "cancelled" {
            if item.state == .sending || item.state == .accepted { item.state = .unconfirmed; item.settleRevision = nil }
        } else {
            item.state = .failed(pendingSendFailureText(status: status, error: error))
        }
        items[index] = item
        return true
    }

    /// 传输断开：还没有回执的命令可能已经送达；已被 Host 接受的不受影响。
    mutating func connectionLost() {
        for index in items.indices where items[index].state == .sending {
            items[index].state = .unconfirmed; items[index].settleRevision = nil
        }
    }

    /// Runtime 离线：即使 Host 已接受，消息也可能没有进入 agent。
    mutating func runtimeLost(sessionId: String?) {
        for index in items.indices where items[index].sessionId == sessionId && (items[index].state == .sending || items[index].state == .accepted) {
            items[index].state = .unconfirmed; items[index].settleRevision = nil
        }
    }

    /// 用源端事实核对一个 Session 的本地行；返回 true 表示兜底核对需要一次新的权威状态。
    /// `status` 为 nil 表示该 Session 当前没有在线 Runtime。
    mutating func reconcile(sessionId: String, status: String?, queue: [QueuedMessage], revision: Int, connected: Bool,
                            now: Date = Date(), isMaterialized: (String) -> Bool) -> Bool {
        var needsSync = false
        let queued = Dictionary(queue.map { ($0.queueId, $0) }, uniquingKeysWith: { _, last in last })
        items = items.compactMap { original in
            guard original.sessionId == sessionId else { return original }
            var item = original
            if isMaterialized(item.messageId) { return nil }
            if let host = queued[item.messageId] {
                // 队列面板里的消息从此由 Host 队列项负责显示、撤回和交付。
                if item.delivery != nil { return nil }
                if host.state == "cancelled" || host.state == "rejected" {
                    item.state = .failed(host.error ?? (host.state == "cancelled" ? "消息已被撤回" : "电脑端拒绝了这条消息"))
                } else if item.state == .sending || item.state == .unconfirmed {
                    item.state = .accepted; item.acceptedAt = item.acceptedAt ?? now
                }
                item.settleRevision = nil
                return item
            }
            if let status, status != "idle", item.state == .accepted || item.state == .unconfirmed { item.sawBusy = true }
            let idle = connected && status == "idle"
            let eligible: Bool
            switch item.state {
            case .accepted: eligible = idle && (item.sawBusy || now.timeIntervalSince(item.acceptedAt ?? now) >= Self.acceptedIdleGrace)
            case .unconfirmed: eligible = idle
            case .sending, .failed: eligible = false
            }
            guard eligible else { item.settleRevision = nil; return item }
            guard let started = item.settleRevision else {
                item.settleRevision = revision; needsSync = true
                return item
            }
            guard revision > started else { return item }
            // 源端为准：已接受但无法对应的行退场；未确认的行变为可重发的失败。
            if item.state == .accepted { return nil }
            item.state = .failed("未能确认送达，可以重新发送"); item.settleRevision = nil
            return item
        }
        return needsSync
    }

    /// 本地行插在锚点之后；锚点已不在列表里时放在末尾。
    static func merge(_ messages: [ChatMessage], pending: [PendingSend]) -> [ChatMessage] {
        guard !pending.isEmpty else { return messages }
        var result = messages
        var insertedAfter: [String: Int] = [:]
        for send in pending {
            let row = ChatMessage(messageId: send.messageId, role: "user", content: [ChatContent(type: "text", text: send.text, toolName: nil, artifact: nil)],
                                  timestamp: Int64(send.createdAt.timeIntervalSince1970 * 1000), isError: nil)
            if let anchor = send.anchorMessageId, let index = insertedAfter[anchor] ?? result.firstIndex(where: { $0.messageId == anchor }) {
                result.insert(row, at: index + 1)
                insertedAfter[anchor] = index + 1
                for (key, value) in insertedAfter where key != anchor && value > index { insertedAfter[key] = value + 1 }
            } else {
                result.append(row)
            }
        }
        return result
    }
}

func pendingSendFailureText(status: String?, error: String?) -> String {
    if status == "message_id_conflict" { return "消息身份冲突，请重新发送" }
    switch error {
    case "runtime_busy": return "会话正在运行，请选择插入或完成后发送"
    case "claude_steer_unsupported": return "Claude Code 不支持插入当前任务"
    case .some(let text) where !text.isEmpty: return text
    default: return "电脑端没有接受这条消息"
    }
}
