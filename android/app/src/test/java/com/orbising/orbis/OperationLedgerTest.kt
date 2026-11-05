// Orbis 测试用途（场景与判定见本文件断言）：
// - OPT-00 账本核心
package com.orbising.orbis

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/** ADR-0049 §7.4：账本不变量。iOS `OperationLedgerTests` 与本文件用例一一对应。 */
class OperationLedgerTest {
    private val start = 10_000_000L
    private fun at(seconds: Int) = start + seconds * 1_000L

    /** 内容类（消息）：受理后一直等落地，结果不明时保持未确认。 */
    private val content = LedgerPolicy(acceptedBudgetMs = null)
    /** 列表类（首页关闭）：成功后 15 秒仍未落地即恢复；结果不明时恢复原状。 */
    private val list = LedgerPolicy(afterSuccessMs = 15_000, afterSuccess = LedgerTimeout.Reject(LedgerRejection("still_running", "仍在运行")),
        whenUnresolved = LedgerTimeout.Reject(LedgerRejection("unconfirmed", "未确认")))
    /** Host 同步生效且没有设备回执（关闭通知）。 */
    private val sync = LedgerPolicy(whenUnresolved = LedgerTimeout.Reject(LedgerRejection("unconfirmed", "未确认")),
        deviceReceipts = false, appliesBeforeLaterReads = true)
    /** 成功回执即落地（回答、撤回）。 */
    private val lands = LedgerPolicy(successLands = true)

    private var ledger = OperationLedger<String>()

    private fun create(
        id: String, target: String = id, group: String? = null, policy: LedgerPolicy = content, basis: Map<String, Int> = mapOf("d" to 0),
        prerequisites: Set<String> = emptySet(), written: Boolean = true, now: Int = 0,
    ): LedgerCreation<String> {
        val (next, result) = ledger.create(id, "k", target, group, policy = policy, basis = basis, prerequisites = prerequisites,
            payload = id, written = written, now = at(now))
        ledger = next
        return result
    }
    private fun run(step: LedgerStep<String>): List<LedgerEvent<String>> { ledger = step.ledger; return step.events }
    private fun read(): Int = ledger.beginRead().let { (next, id) -> ledger = next; id }
    private fun stamp(seq: Int, read: Int? = null, complete: Boolean = true, domain: String = "d", connection: Int = ledger.connection) =
        LedgerStamp(domain, seq, connection, read, complete)
    private fun authority(stamp: LedgerStamp, evidence: (LedgerOperation<String>) -> LedgerEvidence) = run(ledger.authority(stamp, evidence))
    private fun phase(id: String) = ledger.operation(id)?.phase
    private fun rejected(code: String, reason: String) = LedgerPhase.Rejected(LedgerRejection(code, reason))
    private fun failed(code: String = "x", reason: String = "x") = LedgerReceipt.Failed(LedgerRejection(code, reason))
    private fun readyIds(events: List<LedgerEvent<String>>) = events.filterIsInstance<LedgerEvent.Ready<String>>().map { it.operation.opId }

    // ---- L1 只认身份证据 ----

    @Test fun receiptsMatchOnlyTheirOperationAndConnection() {
        create("a")
        assertTrue(run(ledger.receipt("other", 0, failed(), at(1))).isEmpty())
        assertTrue(run(ledger.receipt("a", 7, failed(), at(1))).isEmpty())
        assertEquals(LedgerPhase.Sent, phase("a"))
        run(ledger.receipt("a", 0, LedgerReceipt.Accepted, at(1)))
        assertEquals(LedgerPhase.Accepted, phase("a"))
    }

    // ---- L2 单调与因果 ----

    @Test fun settledPhasesNeverRevertAndPendingNeverDowngrades() {
        create("a", policy = list)
        run(ledger.receipt("a", 0, LedgerReceipt.Succeeded, at(1)))
        run(ledger.receipt("a", 0, LedgerReceipt.Accepted, at(2)))
        assertEquals(true, ledger.operation("a")?.succeeded)
        run(ledger.receipt("a", 0, failed("busy", "忙"), at(3)))
        assertEquals(rejected("busy", "忙"), phase("a"))
        run(ledger.receipt("a", 0, LedgerReceipt.Succeeded, at(4)))
        authority(stamp(5)) { LedgerEvidence.LANDED }
        assertEquals(rejected("busy", "忙"), phase("a"))
    }

    @Test fun evidenceOlderThanTheBasisIsIgnored() {
        create("a", basis = mapOf("d" to 4))
        assertTrue(authority(stamp(4)) { LedgerEvidence.LANDED }.isEmpty())
        assertTrue(authority(stamp(5, domain = "other")) { LedgerEvidence.LANDED }.isEmpty())
        val pending = ledger.operation("a")!!
        assertEquals(listOf(LedgerEvent.Landed(pending)), authority(stamp(5)) { LedgerEvidence.LANDED })
        assertNull(ledger.operation("a"))
    }

    @Test fun negativeEvidenceMustFollowTheHostsHandling() {
        val early = read()
        create("a", policy = list)
        // Pushed updates and reads issued before the Host finished may predate its handling.
        assertTrue(authority(stamp(1)) { LedgerEvidence.NOT_APPLIED }.isEmpty())
        val beforeResult = read()
        assertTrue(authority(stamp(2, read = beforeResult)) { LedgerEvidence.NOT_APPLIED }.isEmpty())
        run(ledger.receipt("a", 0, LedgerReceipt.Succeeded, at(1)))
        assertTrue(authority(stamp(3, read = early)) { LedgerEvidence.NOT_APPLIED }.isEmpty())
        assertTrue(authority(stamp(4, read = read(), complete = false)) { LedgerEvidence.NOT_APPLIED }.isEmpty())
        assertEquals(LedgerPhase.Accepted, phase("a"))
        val events = authority(stamp(5, read = read())) { LedgerEvidence.NOT_APPLIED }
        assertEquals(1, events.size)
        assertEquals(rejected("not_applied", ""), phase("a"))
    }

    @Test fun synchronousKindsAcceptReadsIssuedAfterTheWrite() {
        val before = read()
        create("dismiss", policy = sync)
        assertTrue(authority(stamp(1, read = before)) { LedgerEvidence.NOT_APPLIED }.isEmpty())
        authority(stamp(2, read = read())) { LedgerEvidence.NOT_APPLIED }
        assertEquals(rejected("not_applied", ""), phase("dismiss"))
    }

    // ---- L4 断线 ----

    @Test fun disconnectTurnsEveryWrittenOperationUnknownAndLeavesWaitingOnes() {
        create("sent")
        create("accepted"); run(ledger.receipt("accepted", 0, LedgerReceipt.Accepted, at(1)))
        create("waiting", prerequisites = setOf("upload"), written = false)
        val events = run(ledger.connectionLost())
        assertEquals(2, events.filterIsInstance<LedgerEvent.Unknown<String>>().size)
        assertEquals(2, events.filterIsInstance<LedgerEvent.Verify<String>>().size)
        assertEquals(LedgerPhase.Unknown, phase("sent"))
        assertEquals(LedgerPhase.Unknown, phase("accepted"))
        assertEquals(LedgerPhase.Waiting, phase("waiting"))
        assertNull(ledger.nextDeadline)
    }

    @Test fun reconnectingWithoutAnExplicitDisconnectStillMarksStragglersUnknown() {
        create("a")
        run(ledger.connected())
        assertEquals(LedgerPhase.Unknown, phase("a"))
        assertEquals(1, ledger.connection)
    }

    // ---- L5 核对 ----

    @Test fun unknownResolvesOnlyAfterBothAuthorityAndDeviceReceipts() {
        create("quit", policy = list)
        run(ledger.connected())
        // The first complete snapshot on the new connection still lists the runtime.
        assertTrue(authority(stamp(1)) { LedgerEvidence.NOT_APPLIED }.isEmpty())
        assertEquals(LedgerPhase.Unknown, phase("quit"))
        val events = run(ledger.deviceReceipts(emptyMap(), ledger.connection, at(2)))
        assertEquals(rejected("unconfirmed", "未确认"), phase("quit"))
        assertEquals(1, events.size)
    }

    @Test fun partialSnapshotsAndOlderConnectionsDoNotVerify() {
        create("quit", policy = list)
        run(ledger.connected())
        run(ledger.deviceReceipts(emptyMap(), ledger.connection, at(1)))
        authority(stamp(1, complete = false)) { LedgerEvidence.NONE }
        assertEquals(LedgerPhase.Unknown, phase("quit"))
        authority(stamp(2, connection = 0)) { LedgerEvidence.NONE }
        assertEquals(LedgerPhase.Unknown, phase("quit"))
        authority(stamp(3)) { LedgerEvidence.NONE }
        assertEquals(rejected("unconfirmed", "未确认"), phase("quit"))
    }

    @Test fun deviceReceiptsSettleOrReattachUnknownOperations() {
        create("answer", policy = lands)
        create("failed")
        create("pending")
        create("missing")
        run(ledger.connected())
        val events = run(ledger.deviceReceipts(mapOf("answer" to LedgerReceipt.Succeeded, "failed" to failed("busy", "忙"),
            "pending" to LedgerReceipt.Accepted), ledger.connection, at(5)))
        assertTrue(events.any { it is LedgerEvent.Landed && it.operation.opId == "answer" })
        assertEquals(rejected("busy", "忙"), phase("failed"))
        assertEquals(LedgerPhase.Accepted, phase("pending"))
        assertEquals(ledger.connection, ledger.operation("pending")?.connection)
        assertEquals(LedgerPhase.Unknown, phase("missing"))
        authority(stamp(1)) { LedgerEvidence.NONE }
        assertEquals(LedgerPhase.Unconfirmed, phase("missing"))
        // Evidence that arrives later still lands an unconfirmed operation.
        authority(stamp(2)) { if (it.opId == "missing") LedgerEvidence.LANDED else LedgerEvidence.NONE }
        assertNull(ledger.operation("missing"))
    }

    @Test fun receiptsStillSettleAfterReconnectButNeverPredateTheWrite() {
        create("late")
        run(ledger.connected())
        // Received on the old connection but handled after reconnect: still this operation's real outcome.
        run(ledger.receipt("late", 0, failed(), at(1)))
        assertEquals(rejected("x", "x"), phase("late"))
        create("fresh")
        assertTrue(run(ledger.receipt("fresh", 0, failed(), at(2))).isEmpty())
        assertEquals(LedgerPhase.Sent, phase("fresh"))
    }

    @Test fun timedOutOperationsVerifyWithAReadIssuedAfterTheTimeout() {
        create("quit", policy = list)
        val stale = read()
        val events = run(ledger.tick(at(61)))
        assertTrue(events.any { it is LedgerEvent.Verify })
        run(ledger.deviceReceipts(emptyMap(), ledger.connection, at(61)))
        assertTrue(authority(stamp(1, read = stale)) { LedgerEvidence.NOT_APPLIED }.isEmpty())
        assertEquals(LedgerPhase.Unknown, phase("quit"))
        authority(stamp(2, read = read())) { LedgerEvidence.NOT_APPLIED }
        assertEquals(rejected("unconfirmed", "未确认"), phase("quit"))
    }

    // ---- L6 不重发 ----

    @Test fun theLedgerNeverAsksToWriteAnOperationTwice() {
        create("a")
        val events = run(ledger.connectionLost()) + run(ledger.connected()) +
            run(ledger.deviceReceipts(emptyMap(), ledger.connection, at(1))) +
            authority(stamp(1)) { LedgerEvidence.NONE } + run(ledger.tick(at(500)))
        assertFalse(events.any { it is LedgerEvent.Ready })
        assertTrue(ledger.ready().isEmpty())
        assertEquals(LedgerPhase.Unconfirmed, phase("a"))
    }

    // ---- L7 作用域 ----

    @Test fun expiredOperationsDisappearAndTheirDependentsFail() {
        create("launch")
        create("send", prerequisites = setOf("launch"), written = false)
        val events = run(ledger.expire { it.opId == "launch" })
        assertEquals("launch", (events.first() as LedgerEvent.Expired).operation.opId)
        assertNull(ledger.operation("launch"))
        assertEquals(rejected("prerequisite", "前置操作已失效"), phase("send"))
    }

    // ---- L8 统一期限 ----

    @Test fun budgetsTurnSilentOperationsUnknownButQueuedMessagesWait() {
        create("silent")
        create("queued"); run(ledger.receipt("queued", 0, LedgerReceipt.Accepted, at(1)))
        create("quit", policy = list); run(ledger.receipt("quit", 0, LedgerReceipt.Succeeded, at(1)))
        assertTrue(run(ledger.tick(at(15))).isEmpty())
        run(ledger.tick(at(16)))
        assertEquals(rejected("still_running", "仍在运行"), phase("quit"))
        run(ledger.tick(at(60)))
        assertEquals(LedgerPhase.Unknown, phase("silent"))
        run(ledger.tick(at(10_000)))
        assertEquals(LedgerPhase.Accepted, phase("queued"))
    }

    // ---- L9 冲突与顺序 ----

    @Test fun oneUnsettledConflictingOperationPerTarget() {
        create("a", target = "runtime:1")
        val conflict = create("b", target = "runtime:1") as? LedgerCreation.Conflict ?: return fail("expected conflict")
        assertEquals("a", conflict.existing.opId)
        assertEquals(LedgerCreation.Duplicate<String>(), create("a", target = "runtime:2"))
        run(ledger.receipt("a", 0, failed(), at(1)))
        assertEquals(LedgerCreation.Created<String>(), create("c", target = "runtime:1"))
    }

    @Test fun groupsWriteInCreationOrder() {
        create("first", group = "s1", prerequisites = setOf("upload"), written = false)
        assertTrue(ledger.blocks("s1"))
        create("second", group = "s1", written = false)
        create("elsewhere", group = "s2", written = false)
        assertEquals(listOf("elsewhere"), ledger.ready().map { it.opId })
        assertEquals(listOf("first"), readyIds(run(ledger.prerequisite("upload", true, ""))))
        assertEquals(listOf("second"), readyIds(run(ledger.written("first", at(1)))))
    }

    @Test fun aFailedPrerequisiteRejectsOnlyItsDependentAndUnblocksTheGroup() {
        create("first", group = "s1", prerequisites = setOf("upload"), written = false)
        create("second", group = "s1", written = false)
        val events = run(ledger.prerequisite("upload", false, "上传失败"))
        assertEquals(rejected("prerequisite", "上传失败"), phase("first"))
        assertEquals(listOf("second"), readyIds(events))
    }

    @Test fun ledgerOperationsCanBePrerequisites() {
        create("model", target = "config:s1:model")
        create("send-1", group = "s1", prerequisites = setOf("model"), written = false)
        create("send-2", group = "s1", written = false)
        val landed = authority(stamp(1)) { if (it.opId == "model") LedgerEvidence.LANDED else LedgerEvidence.NONE }
        assertEquals(listOf("send-1"), readyIds(landed))

        ledger = OperationLedger()
        create("model", target = "config:s1:model")
        create("send-1", group = "s1", prerequisites = setOf("model"), written = false)
        run(ledger.receipt("model", 0, failed("model_unavailable", "模型不可用"), at(1)))
        assertEquals(rejected("prerequisite", "模型不可用"), phase("send-1"))
    }

    // ---- L10 有界 ----

    @Test fun fullLedgersRejectNewOperationsWithoutEvictingUnsettledOnes() {
        ledger = OperationLedger(capacity = 2)
        create("a"); create("b")
        assertEquals(LedgerCreation.Full<String>(), create("c"))
        assertEquals(listOf("a", "b"), ledger.operations.map { it.opId })
        run(ledger.receipt("a", 0, failed(), at(1)))
        assertEquals(LedgerCreation.Created<String>(), create("c"))
    }

    @Test fun localWriteFailuresRejectWaitingOperations() {
        create("a", written = false)
        run(ledger.writeFailed("a", "未连接"))
        assertEquals(rejected("not_sent", "未连接"), phase("a"))
    }

    // ---- 随机事件序列 ----

    /** 固定种子的随机序列：回执乱序与重复、断线重连、旧版本快照、换电脑、期限、前置失败。 */
    @Test fun randomSequencesKeepTheInvariants() {
        for (seed in listOf(1L, 7L, 42L, 2026L, 31337L)) randomSequence(seed)
    }

    private fun randomSequence(seed: Long) {
        val random = SplitMix64(seed.toULong())
        fun next(bound: Int) = (random.next() % bound.toULong()).toInt()
        ledger = OperationLedger(capacity = 12)
        var clock = 0
        var seq = 0
        var created = 0
        val everSettled = mutableSetOf<String>()
        val firstConnection = mutableMapOf<String, Int>()
        val policies = listOf(content, list, sync, lands)

        fun write(events: List<LedgerEvent<String>>) {
            for (event in events) {
                if (event !is LedgerEvent.Ready || ledger.operation(event.operation.opId)?.phase != LedgerPhase.Waiting) continue
                firstConnection[event.operation.opId] = ledger.connection
                write(run(ledger.written(event.operation.opId, at(clock))))
            }
        }
        fun check(step: String) {
            for (op in ledger.operations) {
                if (op.opId in everSettled) assertTrue("$step: ${op.opId} left a settled phase", op.phase.isSettled)
                if (op.phase.isSettled) everSettled += op.opId
                if (op.phase == LedgerPhase.Sent) assertEquals("$step: ${op.opId} was written again", firstConnection[op.opId], op.connection)
                val group = op.group
                if (group != null && op.phase != LedgerPhase.Waiting && !op.phase.isSettled) {
                    val earlier = ledger.operations.takeWhile { it.opId != op.opId }
                    assertFalse("$step: ${op.opId} overtook a waiting one", earlier.any { it.group == group && it.phase == LedgerPhase.Waiting })
                }
            }
        }

        repeat(400) { step ->
            val ids = ledger.operations.map { it.opId }
            fun pick() = if (ids.isEmpty()) "none" else ids[next(ids.size)]
            when (next(11)) {
                0, 1 -> {
                    created += 1
                    val id = "op$created"
                    val group = if (next(2) == 0) "g${next(2)}" else null
                    val prerequisite = if (next(4) == 0) setOf("upload$created") else emptySet()
                    val mustWait = prerequisite.isNotEmpty() || (group != null && ledger.blocks(group))
                    val (nextLedger, result) = ledger.create(id, "k", "t${next(5)}", group, policy = policies[next(4)],
                        basis = mapOf("d" to seq), prerequisites = prerequisite, payload = id, written = !mustWait, now = at(clock))
                    ledger = nextLedger
                    if (result is LedgerCreation.Created && !mustWait) firstConnection[id] = ledger.connection
                }
                2 -> {
                    val receipts = listOf(LedgerReceipt.Accepted, LedgerReceipt.Succeeded, failed(), LedgerReceipt.Uncertain)
                    val connection = if (next(2) == 0) ledger.connection else next(3)
                    run(ledger.receipt(pick(), connection, receipts[next(4)], at(clock)))
                }
                3 -> run(ledger.connectionLost())
                4 -> run(ledger.connected())
                5, 6 -> {
                    seq += 1
                    val read = if (next(2) == 0) read() else null
                    val stale = next(4) == 0
                    val stamp = LedgerStamp("d", if (stale) maxOf(0, seq - 3) else seq, ledger.connection, read, next(3) != 0)
                    val before = ledger
                    val events = authority(stamp) { listOf(LedgerEvidence.LANDED, LedgerEvidence.NOT_APPLIED, LedgerEvidence.NONE)[next(3)] }
                    if (stamp.read == null || !stamp.complete) {
                        // 同一连接上的推送和任何部分结果都不能作为反向证据（L2）。
                        for (event in events) {
                            if (event !is LedgerEvent.Rejected || event.operation.phase != rejected("not_applied", "")) continue
                            if (!stamp.complete || (before.operation(event.operation.opId)?.connection ?: -1) >= stamp.connection) {
                                fail("step $step: ${event.operation.opId} rejected by non-causal evidence")
                            }
                        }
                    }
                    write(events)
                }
                7 -> {
                    clock += next(40)
                    write(run(ledger.tick(at(clock))))
                    for (op in ledger.operations) {
                        if (op.phase != LedgerPhase.Sent && op.phase != LedgerPhase.Accepted) continue
                        op.deadline?.let { assertTrue("step $step: ${op.opId} outlived its deadline", it > at(clock)) }
                    }
                }
                8 -> write(run(ledger.prerequisite("upload${next(maxOf(created, 1)) + 1}", next(3) != 0, "r")))
                9 -> write(run(ledger.deviceReceipts(if (next(2) == 0) emptyMap() else mapOf(pick() to LedgerReceipt.Succeeded),
                    ledger.connection, at(clock))))
                else -> {
                    val target = "t${next(5)}"
                    write(run(ledger.expire { it.target == target && next(3) == 0 }))
                    for (op in ledger.operations.toList()) if (op.phase.isSettled && next(2) == 0) ledger = ledger.remove(op.opId)
                }
            }
            for (op in ledger.ready()) {
                if (ledger.operation(op.opId)?.phase != LedgerPhase.Waiting) continue
                firstConnection[op.opId] = ledger.connection
                write(run(ledger.written(op.opId, at(clock))))
            }
            check("seed $seed step $step")
        }

        // 收尾：重连、读设备回执、读完整状态后，不应再有停在 sent / accepted / unknown 的操作（无回执附着时）。
        run(ledger.connected())
        write(run(ledger.deviceReceipts(emptyMap(), ledger.connection, at(clock))))
        seq += 1
        write(authority(LedgerStamp("d", seq, ledger.connection, read(), true)) { LedgerEvidence.NONE })
        for (op in ledger.operations) {
            val stuck = op.phase == LedgerPhase.Sent || op.phase == LedgerPhase.Accepted || op.phase == LedgerPhase.Unknown
            assertTrue("seed $seed: ${op.opId} stayed ${op.phase} after a full reconnect", !stuck || op.connection == ledger.connection)
        }
        // 叠加可逆：删除全部操作后账本为空，界面只剩权威状态。
        run(ledger.expire { true })
        assertTrue(ledger.operations.isEmpty())
    }
}

/** 可复现的伪随机数（SplitMix64），只用于测试；与 iOS 测试使用同一算法。 */
class SplitMix64(private var state: ULong) {
    fun next(): ULong {
        state += 0x9E3779B97F4A7C15uL
        var z = state
        z = (z xor (z shr 30)) * 0xBF58476D1CE4E5B9uL
        z = (z xor (z shr 27)) * 0x94D049BB133111EBuL
        return z xor (z shr 31)
    }
}
