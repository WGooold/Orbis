import Foundation

/// ADR-0049 §7.5：账本里每种操作携带的内容。新增种类只在这里加一个 case。
enum LedgerPayload: Equatable {
    /// 首页关闭会话（`/quit`）。
    case quit(runtimeId: String)
    /// 关闭通知（只影响本设备，ADR-0028 §3）。
    case dismiss(runtimeId: String, hostEpoch: String, notificationId: String)
    /// 归档 / 取消归档（每张卡片一条）。
    case archive(sessionId: String, agentKind: String, archived: Bool)
    /// 撤回排队消息。
    case queueCancel(runtimeId: String, queueId: String)
    /// 回答审批 / 问卷、取消提问。`summary` 是原位短状态显示的摘要（自由文本与敏感输入只显示“已提交”）。
    case respond(runtimeId: String, requestId: String, summary: String)
    /// 等待前置操作的消息（附件上传、同会话前一条）。写入通道后交给 ADR-0055 的 outbox 结算。
    case send(runtimeId: String, sessionId: String, messageId: String)
}

typealias AppLedger = OperationLedger<LedgerPayload>

/// ADR-0049 §7.5 的种类定义：目标、策略、证据和呈现。阶段、断线、期限、作用域和冲突全部由 `OperationLedger` 处理，
/// `HostConnection` 只负责把回执、权威状态和本机事件交给账本。Android `OperationKinds.kt` 与本文件同构。
enum OperationKinds {
    /// 在线列表（`device.ready` 与 `runtime.online` / `runtime.offline`）在账本里的领域名。
    static let runtimesDomain = "runtimes"
    static let quit = "quit"
    static let dismiss = "dismiss"
    static let archive = "archive"
    /// 会话目录（HostState.catalog / session.list）在账本里的领域名。
    static let catalogDomain = "catalog"
    static let queueCancel = "queueCancel"
    /// 某个 Runtime 的 Host 队列（delivery 领域）在账本里的领域名。
    static func queueDomain(_ runtimeId: String) -> String { "queue:" + runtimeId }
    static let respond = "respond"
    static let send = "send"
    /// `send` 在账本里只经历 `waiting`：前置完成、轮到它时写入通道并交给 outbox，账本随即删除记录。
    static let sendPolicy = AppLedger.Policy(successLands: true, acceptedBudget: AppLedger.receiptBudget, afterSuccess: nil,
                                             whenUnresolved: .unknown, deviceReceipts: true, appliesBeforeLaterReads: false)
    static func sendGroup(_ sessionId: String) -> String { "session:" + sessionId }
    static func uploadPrerequisite(_ uploadId: String) -> String { "upload:" + uploadId }
    /// 某个 Runtime 的交互清单（interactions 领域）在账本里的领域名。
    static func interactionsDomain(_ runtimeId: String) -> String { "interactions:" + runtimeId }

    /// `respond`：成功回执后面板保持收起，直到交互清单不再含该请求（避免闪回），15 秒仍在就转结果不明核对。
    /// 明确失败且请求仍有效时面板回到原位并保留答案；核对后请求仍在则静默恢复面板，已不在则显示“已处理”。
    static let respondPolicy = AppLedger.Policy(
        successLands: false,
        acceptedBudget: AppLedger.receiptBudget,
        afterSuccess: (15, .unknown),
        whenUnresolved: .reject(.init("unresolved", "")),
        deviceReceipts: true,
        appliesBeforeLaterReads: false
    )

    static func respondTarget(runtimeId: String, requestId: String) -> String { "interaction:\(runtimeId):\(requestId)" }

    /// 回答摘要：确认结果、选项名或“已提交”；自由文本与敏感输入不回显（ADR-0049 §6.5）。
    static func respondSummary(_ request: InteractionRequest, response: [String: Any]) -> String {
        let label: (String) -> String = { value in request.options?.first { $0.value == value }?.label ?? value }
        switch response["kind"] as? String {
        case "cancel": return "已取消"
        case "confirm": return response["value"] as? Bool == true ? "已" + (request.confirmLabel ?? "允许") : "已" + (request.cancelLabel ?? "拒绝")
        case "select":
            guard request.secret != true, let value = response["value"] as? String else { return "已提交" }
            return "已选择：" + label(value)
        case "multi-select":
            guard request.secret != true, let values = response["values"] as? [String], !values.isEmpty else { return "已提交" }
            return "已选择：" + values.map(label).joined(separator: "、")
        default: return "已提交"
        }
    }

    /// 正在回答、尚未结算的请求：面板收起（L3），草稿保留。
    static func respondingRequestIds(_ ledger: AppLedger, runtimeId: String) -> Set<String> {
        Set(ledger.operations.compactMap { op in
            guard !op.phase.isSettled, case .respond(let owner, let requestId, _) = op.payload, owner == runtimeId else { return nil }
            return requestId
        })
    }

    /// 原位短状态：确认前带处理中标记；结果不明显示“未确认”。
    static func respondStatus(_ ledger: AppLedger, runtimeId: String) -> (text: String, pending: Bool)? {
        for op in ledger.operations.reversed() {
            guard case .respond(let owner, _, let summary) = op.payload, owner == runtimeId else { continue }
            switch op.phase {
            case .waiting, .sent, .accepted: return (summary, true)
            case .unknown, .unconfirmed: return (summary + " · 未确认", false)
            case .rejected: continue
            }
        }
        return nil
    }

    /// 交互清单对 `respond` 说明了什么：请求已不在即落地；仍在、未被 Host 标为已提交且未见成功回执，是反向证据。
    static func interactionEvidence(_ op: AppLedger.Operation, requests: [InteractionRequest]) -> AppLedger.Evidence {
        guard case .respond(_, let requestId, _) = op.payload else { return .none }
        guard let request = requests.first(where: { $0.requestId == requestId }) else { return .landed }
        return request.submitted == true || op.succeeded ? .none : .notApplied
    }
    /// 某个 Runtime 的通知清单在账本里的领域名：每个 Runtime 的通知快照各自独立。
    static func noticesDomain(_ runtimeId: String) -> String { "notifications:" + runtimeId }
    /// 账本发起的核对读取（L5）使用的 requestId 前缀。
    static let verifyRequestPrefix = "ledger-verify:"

    static let quitStillRunning = AppLedger.Rejection("still_running", "电脑上的会话仍在运行，请稍后重试或在电脑上关闭。")
    static let quitUnconfirmed = AppLedger.Rejection("unconfirmed", "关闭会话未确认：会话仍在运行。")

    /// `quit`：成功回执只表示受理，Runtime 离线才算落地；成功后 15 秒仍在线或结果不明核对后仍在线，都恢复卡片。
    static let quitPolicy = AppLedger.Policy(
        successLands: false,
        acceptedBudget: AppLedger.receiptBudget,
        afterSuccess: (15, .reject(quitStillRunning)),
        whenUnresolved: .reject(quitUnconfirmed),
        deviceReceipts: true,
        appliesBeforeLaterReads: false
    )

    static func quitTarget(_ runtimeId: String) -> String { "runtime:" + runtimeId }

    /// `dismiss`：没有回执；Host 处理关闭时同步生效，之后发起的读取已能反映结果。权威清单仍含它就静默重新显示。
    static let dismissPolicy = AppLedger.Policy(
        successLands: false,
        acceptedBudget: AppLedger.receiptBudget,
        afterSuccess: nil,
        whenUnresolved: .reject(.init("not_dismissed", "")),
        deviceReceipts: false,
        appliesBeforeLaterReads: true
    )

    static func dismissTarget(runtimeId: String, hostEpoch: String, notificationId: String) -> String {
        "notification:\(runtimeId):\(hostEpoch):\(notificationId)"
    }

    /// 本设备已关闭、尚未结算的通知：横幅保持隐藏，包括结果不明期间（L4）。键为 `runtimeId` + NUL + `notificationId`。
    static func hiddenNotificationKeys(_ ledger: AppLedger) -> Set<String> {
        Set(ledger.operations.compactMap { op in
            guard !op.phase.isSettled, case .dismiss(let runtimeId, _, let notificationId) = op.payload else { return nil }
            return runtimeId + "\u{0}" + notificationId
        })
    }

    /// 通知清单对 `dismiss` 说明了什么：清单里已没有它即落地；完整清单仍含它是反向证据（只在因果晚于关闭时采用，L2）。
    static func noticeEvidence(_ op: AppLedger.Operation, projection: RuntimeNoticeProjection?) -> AppLedger.Evidence {
        guard case .dismiss(_, let hostEpoch, let notificationId) = op.payload,
              let projection, projection.hostEpoch == hostEpoch else { return .none }
        guard projection.items.contains(where: { $0.notificationId == notificationId }) else { return .landed }
        return projection.complete ? .notApplied : .none
    }

    static let archiveUnconfirmed = AppLedger.Rejection("unconfirmed", "电脑上的会话目录仍是原状态")

    /// `archive`：同一 requestId 的 `session.archive.changed` 或设备回执 success 表示 Host 已完成原生归档；
    /// 卡片留在目标列表直到目录体现结果（避免目录刷新前闪回），15 秒仍未体现就转结果不明核对。
    /// 带同一 requestId 的 `protocol.error` 为拒绝；核对后目录仍为原状态时恢复并提示。
    static let archivePolicy = AppLedger.Policy(
        successLands: false,
        acceptedBudget: AppLedger.receiptBudget,
        afterSuccess: (15, .unknown),
        whenUnresolved: .reject(archiveUnconfirmed),
        deviceReceipts: true,
        appliesBeforeLaterReads: false
    )

    static func archiveTarget(agentKind: String, sessionId: String) -> String { "session:\(agentKind):\(sessionId)" }

    /// 卡片应显示在哪个列表：未结算的归档操作的目标值叠加在目录上（L3）。
    static func archiveOverrides(_ ledger: AppLedger) -> [String: Bool] {
        Dictionary(ledger.operations.compactMap { op in
            guard !op.phase.isSettled, case .archive(let sessionId, _, let archived) = op.payload else { return nil }
            return (sessionId, archived)
        }, uniquingKeysWith: { _, last in last })
    }

    /// 目录对 `archive` 说明了什么：归档状态已等于目标值即落地；其余交给回执与核对。
    static func catalogEvidence(_ op: AppLedger.Operation, sessions: [String: SessionSummary]) -> AppLedger.Evidence {
        guard case .archive(let sessionId, _, let archived) = op.payload else { return .none }
        return (sessions[sessionId]?.archived == true) == archived ? .landed : .none
    }

    static let queueAlreadyDelivered = AppLedger.Rejection("already_delivered", "消息已交给 Agent")

    /// `queueCancel`：成功回执（`cancelled`）或队列项转为 `cancelled` 即落地；`already_delivered`、`not_cancelable` 等为拒绝。
    /// 结果不明且核对后：仍在队列就静默放回、可再撤回；已不在完整队列中就以权威队列为准不再显示（ADR-0049 §6.3）。
    /// 成功回执后队列项保持退场，直到 Host 队列体现结果（避免闪回），15 秒仍未体现就转结果不明核对。
    static let queueCancelPolicy = AppLedger.Policy(
        successLands: false,
        acceptedBudget: AppLedger.receiptBudget,
        afterSuccess: (15, .unknown),
        whenUnresolved: .reject(.init("not_cancelled", "")),
        deviceReceipts: true,
        appliesBeforeLaterReads: false
    )

    static func queueCancelTarget(runtimeId: String, queueId: String) -> String { "queue:\(runtimeId):\(queueId)" }

    /// 撤回已写入、等待回执的队列项：先按既有移除呈现退场。
    static func cancellingQueueIds(_ ledger: AppLedger, runtimeId: String) -> Set<String> {
        Set(ledger.operations.compactMap { op in
            guard op.phase == .sent || op.phase == .accepted, case .queueCancel(let owner, let queueId) = op.payload, owner == runtimeId else { return nil }
            return queueId
        })
    }

    /// 撤回结果不明：队列项回到原位并标“撤回未确认”，核对前不能再撤回。
    static func unconfirmedQueueIds(_ ledger: AppLedger, runtimeId: String) -> Set<String> {
        Set(ledger.operations.compactMap { op in
            guard op.phase == .unknown || op.phase == .unconfirmed, case .queueCancel(let owner, let queueId) = op.payload, owner == runtimeId else { return nil }
            return queueId
        })
    }

    /// Host 队列对 `queueCancel` 说明了什么：已 `cancelled`，或成功回执后已不在队列中，即落地；
    /// 未见成功回执而仍 `accepted` 是反向证据（只在因果晚于撤回时采用）。
    static func queueEvidence(_ op: AppLedger.Operation, queue: [QueuedMessage]) -> AppLedger.Evidence {
        guard case .queueCancel(_, let queueId) = op.payload else { return .none }
        switch queue.first(where: { $0.queueId == queueId })?.state {
        case "cancelled": return .landed
        case "accepted": return op.succeeded ? .none : .notApplied
        case nil: return op.succeeded ? .landed : .none
        default: return .none
        }
    }

    /// 回执所属的 Runtime：Runtime 级命令的回执只认同一 Runtime 的事件（Host 按 runtimeId + commandId 归属）。
    static func runtimeId(of op: AppLedger.Operation) -> String? {
        switch op.payload {
        case .quit(let runtimeId), .queueCancel(let runtimeId, _), .respond(let runtimeId, _, _), .send(let runtimeId, _, _): return runtimeId
        case .dismiss, .archive: return nil
        }
    }

    /// 被拒绝后是否直接删除：列表类（首页卡片、通知横幅、目录卡片、队列项）提示后回到原位；内容类保留失败状态等用户处理。
    static func removesOnRejection(_ op: AppLedger.Operation) -> Bool {
        switch op.payload {
        case .quit, .dismiss, .archive, .queueCancel, .respond, .send: return true
        }
    }

    /// 首页要隐藏的卡片：未结算的 `quit` 一直保持叠加，包括结果不明期间（L4）。
    static func hiddenRuntimeIds(_ ledger: AppLedger) -> Set<String> {
        Set(ledger.operations.compactMap { op in
            guard !op.phase.isSettled, case .quit(let runtimeId) = op.payload else { return nil }
            return runtimeId
        })
    }

    /// 在线列表对操作说明了什么。只有正向证据：Runtime 已不在列表中即落地；仍在线说明不了“没关”，
    /// 关闭在 Host 上异步完成，交给成功后的期限或结果不明的核对处理。
    static func evidence(_ op: AppLedger.Operation, runtimeIds: Set<String>) -> AppLedger.Evidence {
        switch op.payload {
        case .quit(let runtimeId): return runtimeIds.contains(runtimeId) ? .none : .landed
        case .dismiss, .archive, .queueCancel, .respond, .send: return .none
        }
    }

    /// `command.result` 的回执。`cancelled` / `unconfirmed` 是可能已执行的结果，交给账本按结果不明处理。
    static func receipt(ok: Bool, status: String?, error: String?) -> AppLedger.Receipt {
        if ok { return status == "pending" ? .accepted : .succeeded }
        switch status {
        case "cancelled", "unconfirmed": return .uncertain
        default: return .failed(.init(status ?? "failure", nonEmpty(error) ?? "请重试。"))
        }
    }

    /// 设备作用域 `operations` 领域的值（`{operationId: AgentOperationItem}`）→ 回执。查不到的不出现在结果里。
    static func deviceReceipts(_ value: Any?) -> [String: AppLedger.Receipt] {
        guard let items = value as? [String: Any] else { return [:] }
        var receipts: [String: AppLedger.Receipt] = [:]
        for (id, raw) in items {
            guard let item = raw as? [String: Any], item["operationId"] as? String == id, let state = item["state"] as? String else { continue }
            switch state {
            case "accepted", "pending": receipts[id] = .accepted
            case "success": receipts[id] = .succeeded
            case "cancelled", "unconfirmed": receipts[id] = .uncertain
            default: receipts[id] = .failed(.init(state, nonEmpty(item["detail"] as? String) ?? "请重试。"))
            }
        }
        return receipts
    }

    /// 被拒绝的操作给用户的提示。
    static func message(for op: AppLedger.Operation) -> String? {
        guard case .rejected(let rejection) = op.phase else { return nil }
        switch op.payload {
        case .quit:
            if rejection == quitStillRunning || rejection == quitUnconfirmed { return rejection.reason }
            return "关闭会话未完成：" + rejection.reason
        case .dismiss: return nil // 通知重新显示即说明关闭未生效，不另弹错误（ADR-0049 §6.6）。
        case .archive(_, _, let archived):
            return (archived ? "归档未完成：" : "恢复未完成：") + (rejection.reason.isEmpty ? "请重试" : rejection.reason)
        case .queueCancel:
            // 队列里仍有它就静默放回；已投递时就近说明，消息随权威记录出现在聊天中。
            switch rejection.code {
            case "not_cancelled", "not_applied": return nil
            case "already_delivered": return "撤回未完成：" + queueAlreadyDelivered.reason
            default: return "撤回未完成：" + (rejection.reason.isEmpty ? "请重试" : rejection.reason)
            }
        case .send: return nil // 失败显示在气泡原位（outbox 的失败行）。
        case .respond:
            // 核对后请求仍在：静默恢复面板；明确失败时面板回到原位并说明原因，答案保留。
            switch rejection.code {
            case "unresolved", "not_applied": return nil
            default: return "回答未提交：" + (rejection.reason.isEmpty ? "请重试" : rejection.reason)
            }
        }
    }

    private static func nonEmpty(_ text: String?) -> String? {
        guard let text, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
        return text
    }
}
