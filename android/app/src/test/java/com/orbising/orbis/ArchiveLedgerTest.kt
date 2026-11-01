package com.orbising.orbis

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * ADR-0049 §6.4 `archive`：归档 / 取消归档经操作账本结算。iOS `ArchiveLedgerTests.swift` 与本文件用例一一对应。
 * 目录投影（applyHostDomainProjection）的结尾把完整目录交给账本，这里用同一个入口模拟。
 */
class ArchiveLedgerTest {
    private val reducer = RelayReducer()
    private var counter = 0

    private fun entry(id: String, archived: Boolean) =
        SessionCatalogEntry(sessionId = id, cwd = "/repo", modifiedAt = 1, agentKind = "codex", archived = archived)

    private fun catalog(state: RemoteState, vararg archived: Pair<String, Boolean>): RemoteState =
        state.copy(sessions = archived.associate { (id, value) -> id to entry(id, value) })
            .ledgerAuthority(OperationKinds.CATALOG_DOMAIN, null, true)

    private fun ready(state: RemoteState): RemoteState = reducer.reduce(state,
        """{"type":"device.ready","deviceId":"phone-1","modelEpoch":"epoch","runtimes":[]}""", channel = "ctl")

    private fun setup(): RemoteState =
        catalog(ready(RemoteState(hostId = "host-1", e2eReady = true, connection = RelayConnection.ONLINE)), "s1" to false, "s2" to false)

    /** 与 HostConnection.setSessionArchived 相同：先记入账本，写入通道后登记。 */
    private fun archive(state: RemoteState, sessionId: String, archived: Boolean = true): Pair<RemoteState, String> {
        val requestId = "archive-${++counter}"
        val (created, creation) = state.createArchive(requestId, sessionId, "codex", archived, System.currentTimeMillis())
        assertTrue(creation is LedgerCreation.Created)
        return created.ledgerWritten(requestId, System.currentTimeMillis()) to requestId
    }

    private fun read(state: RemoteState): Pair<RemoteState, String> {
        assertTrue(state.ledgerVerifyWanted && state.ledgerConnectionOpen && state.e2eReady)
        val id = OperationKinds.VERIFY_REQUEST_PREFIX + (++counter)
        return state.beginLedgerRead(id) to id
    }

    private fun answer(state: RemoteState, requestId: String, receipts: Map<String, String>): RemoteState {
        val items = receipts.entries.joinToString(",") { (id, value) ->
            """"$id":{"operationId":"$id","runtimeId":"host-1","requestId":"$id","state":"$value","at":1,"detail":"agent_unsupported"}"""
        }
        return reducer.reduce(state, """{"type":"agent.state.snapshot","requestId":"$requestId","scope":"device","modelEpoch":"epoch",
            "domains":[{"domain":"operations","modelEpoch":"epoch","revision":1,"availability":"ready","completeness":"partial",
            "checkedAt":1,"value":{$items},"source":{"producer":"host","sourceId":"host:device-operations","sourceEpoch":"e","sourceRevision":1}}],
            "missing":[],"truncated":false}""", channel = "ctl")
    }

    private fun archived(state: RemoteState, id: String) = state.sessionsWithLedger()[id]?.archived == true

    private fun reconnect(state: RemoteState) = ready(state.markReconnecting()).copy(e2eReady = true).ledgerOpenConnection()

    @Test fun archiveMovesAtOnceAndLandsOnTheChangeNotice() {
        var (state, id) = archive(setup(), "s1")
        assertTrue(archived(state, "s1"))
        assertEquals(setOf("s1"), state.archivingSessionIds)
        state = reducer.reduce(state, """{"type":"session.archive.changed","requestId":"$id","agentKind":"codex","sessionId":"s1","archived":true}""", channel = "ctl")
        assertTrue(state.ledger.operations.isEmpty())
        assertNull(state.error)
    }

    @Test fun aCatalogAlreadyShowingTheTargetLands() {
        val state = catalog(archive(setup(), "s1").first, "s1" to true, "s2" to false)
        assertTrue(state.ledger.operations.isEmpty())
        assertTrue(archived(state, "s1"))
    }

    @Test fun aRejectionReturnsTheCardWithItsReason() {
        val (archiving, id) = archive(setup(), "s1")
        val state = reducer.reduce(archiving, """{"type":"protocol.error","code":"agent_unsupported","message":"对应的 agent 后端未就绪","requestId":"$id"}""", channel = "ctl")
        assertTrue(!archived(state, "s1"))
        assertTrue(state.ledger.operations.isEmpty())
        assertEquals("归档未完成：对应的 agent 后端未就绪", state.error)
    }

    @Test fun restoringFromTheArchiveUsesItsOwnWording() {
        val start = catalog(setup(), "s1" to true)
        val (restoring, id) = archive(start, "s1", archived = false)
        assertTrue(!archived(restoring, "s1"))
        val state = reducer.reduce(restoring, """{"type":"protocol.error","code":"failed","message":"磁盘只读","requestId":"$id"}""", channel = "ctl")
        assertTrue(archived(state, "s1"))
        assertEquals("恢复未完成：磁盘只读", state.error)
    }

    @Test fun disconnectKeepsTheTargetListAndTheDeviceReceiptDecides() {
        val (archiving, id) = archive(setup(), "s1")
        var state = archiving.markReconnecting()
        assertTrue(archived(state, "s1"))
        state = reconnect(state)
        val (reading, read) = read(state)
        state = answer(reading, read, mapOf(id to "success"))
        assertTrue(state.ledger.operations.isEmpty())
        assertNull(state.error)
    }

    @Test fun batchRejectionsAfterReconnectNameTheCount() {
        val (first, a) = archive(setup(), "s1")
        val (second, b) = archive(first, "s2")
        val (reading, read) = read(reconnect(second))
        val state = answer(reading, read, mapOf(a to "failure", b to "failure"))
        assertTrue(!archived(state, "s1") && !archived(state, "s2"))
        assertEquals("2 个会话归档未完成：agent_unsupported", state.error)
    }

    @Test fun noReceiptAndTheOldCatalogAfterReconnectRestoreAsUnconfirmed() {
        var state = reconnect(archive(setup(), "s1").first)
        state = catalog(state, "s1" to false, "s2" to false)
        val (reading, read) = read(state)
        state = answer(reading, read, emptyMap())
        assertTrue(!archived(state, "s1"))
        assertEquals("归档未完成：电脑上的会话目录仍是原状态", state.error)
    }

    @Test fun aSecondArchiveOfTheSameSessionIsBlockedUntilSettled() {
        val (state, _) = archive(setup(), "s1")
        assertTrue(state.createArchive("again", "s1", "codex", false, System.currentTimeMillis()).second is LedgerCreation.Conflict)
    }

    @Test fun noReceiptWithinTheBudgetAsksForARead() {
        val state = archive(setup(), "s1").first.ledgerTick(System.currentTimeMillis() + 61_000)
        assertTrue(state.ledgerVerifyWanted)
        assertTrue(archived(state, "s1"))
    }
}
