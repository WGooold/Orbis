import Foundation

/// ADR-0049：手机已发出、还没在源端记录里落地的一条消息。只在本机内存中存在，
/// 不写入历史缓存、applied baseline 或分页状态；落地后立即删除，此后由权威记录负责显示。
struct PendingSend: Equatable, Identifiable {
    enum State: Equatable {
        case sending
        case accepted
        case queued
        case failed(String)
        /// 断线或 Runtime 离线时还没定论：命令可能已经送达，核对前不允许重新发送。
        case unconfirmed
        /// ADR-0049 §6.2：已在本机创建，等附件上传或同会话前一条，尚未写入通道。断线不改变它。
        case waiting(String)
    }

    let messageId: String
    let commandId: String
    let sessionId: String
    let text: String
    var attachments: [String]
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
    /// A native submission with a lost result requires positive delivery evidence before retry.
    var needsDeliveryEvidence = false
    var submissionConfirmed = false
    /// Retain the recoverable input while the Host queue owns its visible row.
    var queueOwned = false
    /// ADR-0049 §6.2：等待中的附件上传任务；写入通道时换成 Host 路径。
    var uploadIds: [String] = []
    /// ADR-0049 §6.1：由 prompt / skill Slash 产生的消息；重新发送时再次执行这个命令。
    var slashName: String?
    var slashArgs: String?

    var id: String { messageId }
    /// 带 `delivery` 且尚未被接受时，它在队列面板里显示「提交中」。
    var showsInQueue: Bool { delivery != nil && state == .sending && !queueOwned }
}

struct PendingSendOutbox: Equatable {
    static let acceptedIdleGrace: TimeInterval = 15
    private(set) var items: [PendingSend] = []

    var isEmpty: Bool { items.isEmpty }
    var sessionIds: Set<String> { Set(items.map(\.sessionId)) }
    func item(_ messageId: String?) -> PendingSend? { messageId.flatMap { id in items.first { $0.messageId == id } } }
    func owns(commandId: String) -> Bool { items.contains { $0.commandId == commandId } }
    func chatRows(sessionId: String?) -> [PendingSend] {
        items.filter { $0.sessionId == sessionId && !$0.showsInQueue && !$0.queueOwned }.sorted { $0.createdAt < $1.createdAt }
    }
    func queueRows(sessionId: String?) -> [PendingSend] {
        items.filter { $0.sessionId == sessionId && $0.showsInQueue }.sorted { $0.createdAt < $1.createdAt }
    }
    /// 聊天里的本地行已经代表这条消息，Host 队列里的同一项不再重复显示。
    func hidesQueueItem(_ queueId: String) -> Bool { items.contains { $0.messageId == queueId && !$0.showsInQueue && !$0.queueOwned } }

    /// 启动中的会话确认了 Session ID：占位 Session 下的消息转到真实会话（ADR-0049 §6.8）。
    mutating func rebind(sessionId placeholder: String, to sessionId: String) {
        for index in items.indices where items[index].sessionId == placeholder {
            let item = items[index]
            var moved = PendingSend(messageId: item.messageId, commandId: item.commandId, sessionId: sessionId, text: item.text,
                                    attachments: item.attachments, delivery: item.delivery, createdAt: item.createdAt, anchorMessageId: item.anchorMessageId)
            moved.state = item.state; moved.uploadIds = item.uploadIds
            items[index] = moved
        }
    }

    /// 等待中的消息写入通道：换成 Host 附件路径，进入发送中（ADR-0049 §6.2）。
    mutating func startWrite(_ messageId: String, attachments: [String]) {
        guard let index = items.firstIndex(where: { $0.messageId == messageId }), case .waiting = items[index].state else { return }
        items[index].attachments = attachments; items[index].state = .sending
    }
    /// 等待中的前置操作失败：这条消息转失败，原因写明前置操作。
    mutating func failWaiting(_ messageId: String, reason: String) {
        guard let index = items.firstIndex(where: { $0.messageId == messageId }), case .waiting = items[index].state else { return }
        items[index].state = .failed(reason)
    }

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
        if status == "unconfirmed" {
            item.state = .unconfirmed; item.needsDeliveryEvidence = true; item.queueOwned = false; item.settleRevision = nil
        } else if ok {
            if item.needsDeliveryEvidence && status == "pending" { return true }
            if status != "pending" { item.submissionConfirmed = true; item.needsDeliveryEvidence = false }
            if item.state != .accepted { item.state = .accepted; item.acceptedAt = now; item.sawBusy = false; item.settleRevision = nil }
        } else if status == "cancelled" {
            if item.state == .sending || item.state == .accepted || item.state == .queued { item.state = .unconfirmed; item.needsDeliveryEvidence = true; item.queueOwned = false; item.settleRevision = nil }
        } else {
            item.state = .failed(pendingSendFailureText(status: status, error: error))
        }
        items[index] = item
        return true
    }

    /// 传输断开：还没有回执的命令可能已经送达；已被 Host 接受的不受影响。
    mutating func connectionLost() {
        for index in items.indices where items[index].state == .sending {
            items[index].state = .unconfirmed; items[index].needsDeliveryEvidence = true; items[index].settleRevision = nil
        }
    }

    /// Runtime 离线：即使 Host 已接受，消息也可能没有进入 agent。
    mutating func runtimeLost(sessionId: String?) {
        for index in items.indices where items[index].sessionId == sessionId && (items[index].state == .sending || items[index].state == .accepted || items[index].state == .queued) {
            items[index].state = .unconfirmed; items[index].needsDeliveryEvidence = true; items[index].queueOwned = false; items[index].settleRevision = nil
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
            if let host = queued[item.messageId], host.state != "delivered" {
                if host.state == "cancelled" { return nil }
                // Host owns the visible queue row; keep a hidden recovery copy until actual materialization.
                item.queueOwned = item.delivery != nil && host.state == "accepted"
                if host.state == "unconfirmed" {
                    item.state = .unconfirmed; item.needsDeliveryEvidence = true
                } else if host.state == "rejected" {
                    item.state = .failed(host.error ?? L10n.tr("电脑端拒绝了这条消息"))
                } else if host.state == "accepted" || host.state == "not_cancelable" {
                    item.state = .queued; item.acceptedAt = item.acceptedAt ?? now
                }
                item.settleRevision = nil
                return item
            }
            item.queueOwned = false
            if queued[item.messageId]?.state == "delivered" { item.submissionConfirmed = true; item.state = .accepted }
            else if item.state == .queued { item.state = .unconfirmed; item.needsDeliveryEvidence = true }
            if let status, status != "idle", item.state == .accepted || item.state == .unconfirmed { item.sawBusy = true }
            let idle = connected && status == "idle"
            let eligible: Bool
            switch item.state {
            case .accepted: eligible = item.submissionConfirmed && idle && (item.sawBusy || now.timeIntervalSince(item.acceptedAt ?? now) >= Self.acceptedIdleGrace)
            case .unconfirmed: eligible = idle
            case .sending, .queued, .failed, .waiting: eligible = false
            }
            guard eligible else { item.settleRevision = nil; return item }
            guard let started = item.settleRevision else {
                item.settleRevision = revision; needsSync = true
                return item
            }
            guard revision > started else { return item }
            // 源端为准：已接受但无法对应的行退场；未确认的行变为可重发的失败。
            if item.state == .accepted { return nil }
            if item.needsDeliveryEvidence { return item }
            item.state = .failed(L10n.tr("未能确认送达，可以重新发送")); item.settleRevision = nil
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
    if status == "message_id_conflict" { return L10n.tr("消息身份冲突，请重新发送") }
    switch error {
    case "runtime_busy": return L10n.tr("会话正在运行，请选择插入或完成后发送")
    case "claude_steer_unsupported": return L10n.tr("Claude Code 不支持插入当前任务")
    case .some(let text) where !text.isEmpty: return text
    default: return L10n.tr("电脑端没有接受这条消息")
    }
}
