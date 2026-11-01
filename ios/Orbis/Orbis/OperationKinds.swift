import Foundation

/// ADR-0049 §7.5：账本里每种操作携带的内容。新增种类只在这里加一个 case。
enum LedgerPayload: Equatable {
    /// 首页关闭会话（`/quit`）。
    case quit(runtimeId: String)
}

typealias AppLedger = OperationLedger<LedgerPayload>

/// ADR-0049 §7.5 的种类定义：目标、策略、证据和呈现。阶段、断线、期限、作用域和冲突全部由 `OperationLedger` 处理，
/// `HostConnection` 只负责把回执、权威状态和本机事件交给账本。Android `OperationKinds.kt` 与本文件同构。
enum OperationKinds {
    /// 在线列表（`device.ready` 与 `runtime.online` / `runtime.offline`）在账本里的领域名。
    static let runtimesDomain = "runtimes"
    static let quit = "quit"
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
            case "cancelled": receipts[id] = .uncertain
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
        }
    }

    private static func nonEmpty(_ text: String?) -> String? {
        guard let text, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
        return text
    }
}
