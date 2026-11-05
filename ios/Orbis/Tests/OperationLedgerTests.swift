// Orbis 测试用途（场景与判定见本文件断言）：
// - OPT-00 账本核心
import Foundation
import Testing
@testable import OrbisCore

/// ADR-0049 §7.4：账本不变量。Android `OperationLedgerTest` 与本文件用例一一对应。
@Suite("Operation ledger invariants (ADR-0049 §7)")
struct OperationLedgerTests {
    typealias Ledger = OperationLedger<String>
    private let start = Date(timeIntervalSince1970: 10_000)
    private func at(_ seconds: TimeInterval) -> Date { start.addingTimeInterval(seconds) }

    /// 内容类（消息）：受理后一直等落地，结果不明时保持未确认。
    private let content = Ledger.Policy(acceptedBudget: nil)
    /// 列表类（首页关闭）：成功后 15 秒仍未落地即恢复；结果不明时恢复原状。
    private let list = Ledger.Policy(afterSuccess: (15, .reject(.init("still_running", "仍在运行"))),
                                     whenUnresolved: .reject(.init("unconfirmed", "未确认")))
    /// Host 同步生效且没有设备回执（关闭通知）。
    private let sync = Ledger.Policy(whenUnresolved: .reject(.init("unconfirmed", "未确认")), deviceReceipts: false,
                                     appliesBeforeLaterReads: true)
    /// 成功回执即落地（回答、撤回）。
    private let lands = Ledger.Policy(successLands: true, whenUnresolved: .unknown)

    @discardableResult
    private func create(_ ledger: inout Ledger, _ id: String, target: String? = nil, group: String? = nil, policy: Ledger.Policy? = nil,
                        basis: [String: Int] = ["d": 0], prerequisites: Set<String> = [], written: Bool = true, now: TimeInterval = 0) -> Ledger.Creation {
        ledger.create(opId: id, kind: "k", target: target ?? id, group: group, policy: policy ?? content, basis: basis,
                      prerequisites: prerequisites, payload: id, written: written, now: at(now))
    }
    private func stamp(_ ledger: Ledger, seq: Int, read: Int? = nil, complete: Bool = true, domain: String = "d") -> Ledger.Stamp {
        .init(domain: domain, seq: seq, connection: ledger.connection, read: read, complete: complete)
    }
    private func phase(_ ledger: Ledger, _ id: String) -> Ledger.Phase? { ledger.operation(id)?.phase }

    // MARK: L1 只认身份证据

    @Test func receiptsMatchOnlyTheirOperationAndConnection() {
        var ledger = Ledger()
        create(&ledger, "a")
        #expect(ledger.receipt("other", connection: 0, .failed(.init("x", "x")), now: at(1)).isEmpty)
        #expect(ledger.receipt("a", connection: 7, .failed(.init("x", "x")), now: at(1)).isEmpty)
        #expect(phase(ledger, "a") == .sent)
        _ = ledger.receipt("a", connection: 0, .accepted, now: at(1))
        #expect(phase(ledger, "a") == .accepted)
    }

    // MARK: L2 单调与因果

    @Test func settledPhasesNeverRevertAndPendingNeverDowngrades() {
        var ledger = Ledger()
        create(&ledger, "a", policy: list)
        _ = ledger.receipt("a", connection: 0, .succeeded, now: at(1))
        _ = ledger.receipt("a", connection: 0, .accepted, now: at(2))
        #expect(ledger.operation("a")?.succeeded == true)
        _ = ledger.receipt("a", connection: 0, .failed(.init("busy", "忙")), now: at(3))
        #expect(phase(ledger, "a") == .rejected(.init("busy", "忙")))
        _ = ledger.receipt("a", connection: 0, .succeeded, now: at(4))
        _ = ledger.authority(stamp(ledger, seq: 5)) { _ in .landed }
        #expect(phase(ledger, "a") == .rejected(.init("busy", "忙")))
    }

    @Test func evidenceOlderThanTheBasisIsIgnored() {
        var ledger = Ledger()
        create(&ledger, "a", basis: ["d": 4])
        #expect(ledger.authority(stamp(ledger, seq: 4)) { _ in .landed }.isEmpty)
        #expect(ledger.authority(stamp(ledger, seq: 5, domain: "other")) { _ in .landed }.isEmpty)
        let pending = ledger.operation("a")!
        #expect(ledger.authority(stamp(ledger, seq: 5)) { _ in .landed } == [.landed(pending)])
        #expect(ledger.operation("a") == nil)
    }

    @Test func negativeEvidenceMustFollowTheHostsHandling() {
        var ledger = Ledger()
        let early = ledger.beginRead()
        create(&ledger, "a", policy: list)
        // Pushed updates and reads issued before the Host finished may predate its handling.
        #expect(ledger.authority(stamp(ledger, seq: 1)) { _ in .notApplied }.isEmpty)
        let beforeResult = ledger.beginRead()
        #expect(ledger.authority(stamp(ledger, seq: 2, read: beforeResult)) { _ in .notApplied }.isEmpty)
        _ = ledger.receipt("a", connection: 0, .succeeded, now: at(1))
        #expect(ledger.authority(stamp(ledger, seq: 3, read: early)) { _ in .notApplied }.isEmpty)
        #expect(ledger.authority(stamp(ledger, seq: 4, read: ledger.beginRead(), complete: false)) { _ in .notApplied }.isEmpty)
        #expect(phase(ledger, "a") == .accepted)
        let after = ledger.beginRead()
        let events = ledger.authority(stamp(ledger, seq: 5, read: after)) { _ in .notApplied }
        #expect(events.count == 1)
        #expect(phase(ledger, "a") == .rejected(.init("not_applied", "")))
    }

    @Test func synchronousKindsAcceptReadsIssuedAfterTheWrite() {
        var ledger = Ledger()
        let before = ledger.beginRead()
        create(&ledger, "dismiss", policy: sync)
        #expect(ledger.authority(stamp(ledger, seq: 1, read: before)) { _ in .notApplied }.isEmpty)
        let after = ledger.beginRead()
        _ = ledger.authority(stamp(ledger, seq: 2, read: after)) { _ in .notApplied }
        #expect(phase(ledger, "dismiss") == .rejected(.init("not_applied", "")))
    }

    // MARK: L4 断线

    @Test func disconnectTurnsEveryWrittenOperationUnknownAndLeavesWaitingOnes() {
        var ledger = Ledger()
        create(&ledger, "sent")
        create(&ledger, "accepted"); _ = ledger.receipt("accepted", connection: 0, .accepted, now: at(1))
        create(&ledger, "waiting", prerequisites: ["upload"], written: false)
        let events = ledger.connectionLost()
        #expect(events.filter { if case .unknown = $0 { return true }; return false }.count == 2)
        #expect(events.filter { if case .verify = $0 { return true }; return false }.count == 2)
        #expect(phase(ledger, "sent") == .unknown)
        #expect(phase(ledger, "accepted") == .unknown)
        #expect(phase(ledger, "waiting") == .waiting)
        #expect(ledger.nextDeadline == nil)
    }

    @Test func reconnectingWithoutAnExplicitDisconnectStillMarksStragglersUnknown() {
        var ledger = Ledger()
        create(&ledger, "a")
        _ = ledger.connected()
        #expect(phase(ledger, "a") == .unknown)
        #expect(ledger.connection == 1)
    }

    // MARK: L5 核对

    @Test func unknownResolvesOnlyAfterBothAuthorityAndDeviceReceipts() {
        var ledger = Ledger()
        create(&ledger, "quit", policy: list)
        _ = ledger.connected()
        // The first complete snapshot on the new connection still lists the runtime.
        #expect(ledger.authority(stamp(ledger, seq: 1)) { _ in .notApplied }.isEmpty)
        #expect(phase(ledger, "quit") == .unknown)
        let events = ledger.deviceReceipts([:], connection: ledger.connection, now: at(2))
        #expect(phase(ledger, "quit") == .rejected(.init("unconfirmed", "未确认")))
        #expect(events.count == 1)
    }

    @Test func partialSnapshotsAndOlderConnectionsDoNotVerify() {
        var ledger = Ledger()
        create(&ledger, "quit", policy: list)
        _ = ledger.connected()
        _ = ledger.deviceReceipts([:], connection: ledger.connection, now: at(1))
        _ = ledger.authority(stamp(ledger, seq: 1, complete: false)) { _ in .none }
        #expect(phase(ledger, "quit") == .unknown)
        _ = ledger.authority(.init(domain: "d", seq: 2, connection: 0, read: nil, complete: true)) { _ in .none }
        #expect(phase(ledger, "quit") == .unknown)
        _ = ledger.authority(stamp(ledger, seq: 3)) { _ in .none }
        #expect(phase(ledger, "quit") == .rejected(.init("unconfirmed", "未确认")))
    }

    @Test func deviceReceiptsSettleOrReattachUnknownOperations() {
        var ledger = Ledger()
        create(&ledger, "answer", policy: lands)
        create(&ledger, "failed")
        create(&ledger, "pending")
        create(&ledger, "missing")
        _ = ledger.connected()
        let events = ledger.deviceReceipts(["answer": .succeeded, "failed": .failed(.init("busy", "忙")), "pending": .accepted],
                                           connection: ledger.connection, now: at(5))
        #expect(events.contains { if case .landed(let op) = $0 { return op.opId == "answer" }; return false })
        #expect(phase(ledger, "failed") == .rejected(.init("busy", "忙")))
        #expect(phase(ledger, "pending") == .accepted)
        #expect(ledger.operation("pending")?.connection == ledger.connection)
        #expect(phase(ledger, "missing") == .unknown)
        _ = ledger.authority(stamp(ledger, seq: 1)) { _ in .none }
        #expect(phase(ledger, "missing") == .unconfirmed)
        // Evidence that arrives later still lands an unconfirmed operation.
        _ = ledger.authority(stamp(ledger, seq: 2)) { $0.opId == "missing" ? .landed : .none }
        #expect(ledger.operation("missing") == nil)
    }

    @Test func receiptsStillSettleAfterReconnectButNeverPredateTheWrite() {
        var ledger = Ledger()
        create(&ledger, "late")
        _ = ledger.connected()
        // Received on the old connection but handled after reconnect: still this operation's real outcome.
        _ = ledger.receipt("late", connection: 0, .failed(.init("x", "x")), now: at(1))
        #expect(phase(ledger, "late") == .rejected(.init("x", "x")))
        create(&ledger, "fresh")
        #expect(ledger.receipt("fresh", connection: 0, .failed(.init("x", "x")), now: at(2)).isEmpty)
        #expect(phase(ledger, "fresh") == .sent)
    }

    @Test func timedOutOperationsVerifyWithAReadIssuedAfterTheTimeout() {
        var ledger = Ledger()
        create(&ledger, "quit", policy: list)
        let stale = ledger.beginRead()
        let events = ledger.tick(now: at(61))
        #expect(events.contains { if case .verify = $0 { return true }; return false })
        _ = ledger.deviceReceipts([:], connection: ledger.connection, now: at(61))
        #expect(ledger.authority(stamp(ledger, seq: 1, read: stale)) { _ in .notApplied }.isEmpty)
        #expect(phase(ledger, "quit") == .unknown)
        _ = ledger.authority(stamp(ledger, seq: 2, read: ledger.beginRead())) { _ in .notApplied }
        #expect(phase(ledger, "quit") == .rejected(.init("unconfirmed", "未确认")))
    }

    // MARK: L6 不重发

    @Test func theLedgerNeverAsksToWriteAnOperationTwice() {
        var ledger = Ledger()
        create(&ledger, "a")
        var events = ledger.connectionLost() + ledger.connected()
        events += ledger.deviceReceipts([:], connection: ledger.connection, now: at(1))
        events += ledger.authority(stamp(ledger, seq: 1)) { _ in .none }
        events += ledger.tick(now: at(500))
        #expect(!events.contains { if case .ready = $0 { return true }; return false })
        #expect(ledger.ready().isEmpty)
        #expect(phase(ledger, "a") == .unconfirmed)
    }

    // MARK: L7 作用域

    @Test func expiredOperationsDisappearAndTheirDependentsFail() {
        var ledger = Ledger()
        create(&ledger, "launch")
        create(&ledger, "send", prerequisites: ["launch"], written: false)
        let events = ledger.expire { $0.opId == "launch" }
        guard case .expired(let gone) = events.first else { Issue.record("expected expiry first"); return }
        #expect(gone.opId == "launch")
        #expect(ledger.operation("launch") == nil)
        #expect(phase(ledger, "send") == .rejected(.init("prerequisite", "前置操作已失效")))
    }

    // MARK: L8 统一期限

    @Test func budgetsTurnSilentOperationsUnknownButQueuedMessagesWait() {
        var ledger = Ledger()
        create(&ledger, "silent")
        create(&ledger, "queued"); _ = ledger.receipt("queued", connection: 0, .accepted, now: at(1))
        create(&ledger, "quit", policy: list); _ = ledger.receipt("quit", connection: 0, .succeeded, now: at(1))
        #expect(ledger.tick(now: at(15)).isEmpty)
        _ = ledger.tick(now: at(16))
        #expect(phase(ledger, "quit") == .rejected(.init("still_running", "仍在运行")))
        _ = ledger.tick(now: at(60))
        #expect(phase(ledger, "silent") == .unknown)
        _ = ledger.tick(now: at(10_000))
        #expect(phase(ledger, "queued") == .accepted)
    }

    // MARK: L9 冲突与顺序

    @Test func oneUnsettledConflictingOperationPerTarget() {
        var ledger = Ledger()
        create(&ledger, "a", target: "runtime:1")
        guard case .conflict(let existing) = create(&ledger, "b", target: "runtime:1") else { Issue.record("expected conflict"); return }
        #expect(existing.opId == "a")
        #expect(create(&ledger, "a", target: "runtime:2") == .duplicate)
        _ = ledger.receipt("a", connection: 0, .failed(.init("x", "x")), now: at(1))
        #expect(create(&ledger, "c", target: "runtime:1") == .created)
    }

    @Test func groupsWriteInCreationOrder() {
        var ledger = Ledger()
        create(&ledger, "first", group: "s1", prerequisites: ["upload"], written: false)
        #expect(ledger.blocks(group: "s1"))
        create(&ledger, "second", group: "s1", written: false)
        create(&ledger, "elsewhere", group: "s2", written: false)
        #expect(ledger.ready().map(\.opId) == ["elsewhere"])
        let ready = ledger.prerequisite("upload", succeeded: true, reason: "")
        #expect(ready.map { if case .ready(let op) = $0 { return op.opId }; return "" } == ["first"])
        let next = ledger.written("first", now: at(1))
        #expect(next.map { if case .ready(let op) = $0 { return op.opId }; return "" } == ["second"])
    }

    @Test func aFailedPrerequisiteRejectsOnlyItsDependentAndUnblocksTheGroup() {
        var ledger = Ledger()
        create(&ledger, "first", group: "s1", prerequisites: ["upload"], written: false)
        create(&ledger, "second", group: "s1", written: false)
        let events = ledger.prerequisite("upload", succeeded: false, reason: "上传失败")
        #expect(phase(ledger, "first") == .rejected(.init("prerequisite", "上传失败")))
        #expect(events.contains { if case .ready(let op) = $0 { return op.opId == "second" }; return false })
    }

    @Test func ledgerOperationsCanBePrerequisites() {
        var ledger = Ledger()
        create(&ledger, "model", target: "config:s1:model")
        create(&ledger, "send-1", group: "s1", prerequisites: ["model"], written: false)
        create(&ledger, "send-2", group: "s1", written: false)
        let landed = ledger.authority(stamp(ledger, seq: 1)) { $0.opId == "model" ? .landed : .none }
        #expect(landed.contains { if case .ready(let op) = $0 { return op.opId == "send-1" }; return false })

        var failing = Ledger()
        create(&failing, "model", target: "config:s1:model")
        create(&failing, "send-1", group: "s1", prerequisites: ["model"], written: false)
        _ = failing.receipt("model", connection: 0, .failed(.init("model_unavailable", "模型不可用")), now: at(1))
        #expect(phase(failing, "send-1") == .rejected(.init("prerequisite", "模型不可用")))
    }

    // MARK: L10 有界

    @Test func fullLedgersRejectNewOperationsWithoutEvictingUnsettledOnes() {
        var ledger = Ledger(capacity: 2)
        create(&ledger, "a"); create(&ledger, "b")
        #expect(create(&ledger, "c") == .full)
        #expect(ledger.operations.map(\.opId) == ["a", "b"])
        _ = ledger.receipt("a", connection: 0, .failed(.init("x", "x")), now: at(1))
        #expect(create(&ledger, "c") == .created)
    }

    @Test func localWriteFailuresRejectWaitingOperations() {
        var ledger = Ledger()
        create(&ledger, "a", written: false)
        _ = ledger.writeFailed("a", reason: "未连接")
        #expect(phase(ledger, "a") == .rejected(.init("not_sent", "未连接")))
    }

    // MARK: 随机事件序列

    /// 固定种子的随机序列：回执乱序与重复、断线重连、旧版本快照、换电脑、期限、前置失败。
    @Test(arguments: [1, 7, 42, 2026, 31337])
    func randomSequencesKeepTheInvariants(seed: UInt64) {
        var random = SplitMix64(seed: seed)
        var ledger = Ledger(capacity: 12)
        var clock: TimeInterval = 0
        var seq = 0
        var created = 0
        var everSettled: Set<String> = []
        var firstConnection: [String: Int] = [:]
        let policies = [content, list, sync, lands]

        func check(_ step: String) {
            for op in ledger.operations {
                if everSettled.contains(op.opId) { #expect(op.phase.isSettled, "\(step): \(op.opId) left a settled phase") }
                if op.phase.isSettled { everSettled.insert(op.opId) }
                if op.phase == .sent { #expect(op.connection == firstConnection[op.opId], "\(step): \(op.opId) was written again") }
                if let group = op.group, op.phase != .waiting, !op.phase.isSettled {
                    let earlier = ledger.operations.prefix { $0.opId != op.opId }
                    #expect(!earlier.contains { $0.group == group && $0.phase == .waiting }, "\(step): \(op.opId) overtook a waiting one")
                }
            }
        }
        func write(_ events: [Ledger.Event]) {
            for case .ready(let op) in events where ledger.operation(op.opId)?.phase == .waiting {
                firstConnection[op.opId] = ledger.connection
                write(ledger.written(op.opId, now: at(clock)))
            }
        }

        for step in 0..<400 {
            let ids = ledger.operations.map(\.opId)
            let pick = { ids.isEmpty ? "none" : ids[Int(random.next() % UInt64(ids.count))] }
            switch random.next() % 11 {
            case 0, 1:
                created += 1
                let id = "op\(created)"
                let group = random.next() % 2 == 0 ? "g\(random.next() % 2)" : nil
                let prerequisite: Set<String> = random.next() % 4 == 0 ? ["upload\(created)"] : []
                let mustWait = !prerequisite.isEmpty || group.map(ledger.blocks(group:)) == true
                let result = ledger.create(opId: id, kind: "k", target: "t\(random.next() % 5)", group: group,
                                           policy: policies[Int(random.next() % 4)], basis: ["d": seq], prerequisites: prerequisite,
                                           payload: id, written: !mustWait, now: at(clock))
                if result == .created, !mustWait { firstConnection[id] = ledger.connection }
            case 2:
                let receipts: [Ledger.Receipt] = [.accepted, .succeeded, .failed(.init("x", "x")), .uncertain]
                _ = ledger.receipt(pick(), connection: Int(random.next() % 2 == 0 ? UInt64(ledger.connection) : random.next() % 3),
                                   receipts[Int(random.next() % 4)], now: at(clock))
            case 3:
                _ = ledger.connectionLost()
            case 4:
                _ = ledger.connected()
            case 5, 6:
                seq += 1
                let read: Int? = random.next() % 2 == 0 ? ledger.beginRead() : nil
                let stale = random.next() % 4 == 0
                let stamp = Ledger.Stamp(domain: "d", seq: stale ? max(0, seq - 3) : seq, connection: ledger.connection,
                                         read: read, complete: random.next() % 3 != 0)
                let before = ledger
                let events = ledger.authority(stamp) { _ in [Ledger.Evidence.landed, .notApplied, .none][Int(random.next() % 3)] }
                if stamp.read == nil || !stamp.complete {
                    // 同一连接上的推送和任何部分结果都不能作为反向证据（L2）。
                    for case .rejected(let op) in events where op.phase == .rejected(.init("not_applied", ""))
                        && (!stamp.complete || (before.operation(op.opId)?.connection ?? -1) >= stamp.connection) {
                        Issue.record("step \(step): \(op.opId) rejected by non-causal evidence (was \(String(describing: before.operation(op.opId)?.phase)))")
                    }
                }
                write(events)
            case 7:
                clock += Double(random.next() % 40)
                let events = ledger.tick(now: at(clock))
                write(events)
                for op in ledger.operations where op.phase == .sent || op.phase == .accepted {
                    if let deadline = op.deadline { #expect(deadline > at(clock), "step \(step): \(op.opId) outlived its deadline") }
                }
            case 8:
                write(ledger.prerequisite("upload\(Int(random.next() % UInt64(max(created, 1))) + 1)", succeeded: random.next() % 3 != 0, reason: "r"))
            case 9:
                write(ledger.deviceReceipts(random.next() % 2 == 0 ? [:] : [pick(): .succeeded], connection: ledger.connection, now: at(clock)))
            default:
                let target = "t\(random.next() % 5)"
                write(ledger.expire { $0.target == target && random.next() % 3 == 0 })
                for op in ledger.operations where op.phase.isSettled && random.next() % 2 == 0 { ledger.remove(op.opId) }
            }
            write([])
            for op in ledger.ready() where ledger.operation(op.opId)?.phase == .waiting {
                firstConnection[op.opId] = ledger.connection
                write(ledger.written(op.opId, now: at(clock)))
            }
            check("step \(step)")
        }

        // 收尾：重连、读设备回执、读完整状态后，不应再有停在 sent / accepted / unknown 的操作（无回执附着时）。
        _ = ledger.connected()
        write(ledger.deviceReceipts([:], connection: ledger.connection, now: at(clock)))
        seq += 1
        write(ledger.authority(.init(domain: "d", seq: seq, connection: ledger.connection, read: ledger.beginRead(), complete: true)) { _ in .none })
        for op in ledger.operations {
            #expect([.sent, .accepted, .unknown].contains(op.phase) == false || op.connection == ledger.connection,
                    "\(op.opId) stayed \(op.phase) after a full reconnect")
        }
        // 叠加可逆：删除全部操作后账本为空，界面只剩权威状态。
        _ = ledger.expire { _ in true }
        #expect(ledger.operations.isEmpty)
    }
}

/// 可复现的伪随机数（SplitMix64），只用于测试。
struct SplitMix64 {
    private var state: UInt64
    init(seed: UInt64) { state = seed }
    mutating func next() -> UInt64 {
        state &+= 0x9E37_79B9_7F4A_7C15
        var z = state
        z = (z ^ (z >> 30)) &* 0xBF58_476D_1CE4_E5B9
        z = (z ^ (z >> 27)) &* 0x94D0_49BB_1331_11EB
        return z ^ (z >> 31)
    }
}
