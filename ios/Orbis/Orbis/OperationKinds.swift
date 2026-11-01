import Foundation

/// ADR-0049 §7.5：账本里每种操作携带的内容。新增种类只在这里加一个 case。
enum LedgerPayload: Equatable {
    /// 首页关闭会话（`/quit`）。
    case quit(runtimeId: String)
    /// 关闭通知（只影响本设备，ADR-0028 §3）。
    case dismiss(runtimeId: String, hostEpoch: String, notificationId: String)
}

typealias AppLedger = OperationLedger<LedgerPayload>

/// ADR-0049 §7.5 的种类定义：目标、策略、证据和呈现。阶段、断线、期限、作用域和冲突全部由 `OperationLedger` 处理，
/// `HostConnection` 只负责把回执、权威状态和本机事件交给账本。Android `OperationKinds.kt` 与本文件同构。
enum OperationKinds {
    /// 在线列表（`device.ready` 与 `runtime.online` / `runtime.offline`）在账本里的领域名。
    static let runtimesDomain = "runtimes"
    static let quit = "quit"
    static let dismiss = "dismiss"
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

    /// 被拒绝后是否直接删除：列表类（首页卡片、通知横幅）提示后回到原位；内容类保留失败状态等用户处理。
    static func removesOnRejection(_ op: AppLedger.Operation) -> Bool {
        switch op.payload {
        case .quit, .dismiss: return true
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
        case .dismiss: return .none
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
        }
    }

    private static func nonEmpty(_ text: String?) -> String? {
        guard let text, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
        return text
    }
}
