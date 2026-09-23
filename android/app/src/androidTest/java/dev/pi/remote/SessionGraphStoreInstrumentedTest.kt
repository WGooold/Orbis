package dev.pi.remote

import android.content.Context
import android.database.sqlite.SQLiteDatabase
import java.io.File
import java.security.MessageDigest
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class SessionGraphStoreInstrumentedTest {
    private val context = ApplicationProvider.getApplicationContext<Context>()
    private val directoryName = "session-tree-test-${java.util.UUID.randomUUID()}"
    private val store = SessionGraphStore(context, directoryName = directoryName)

    private fun entry(id: String, parentId: String?) = SessionGraphEntry(
        entryId = id,
        parentId = parentId,
        type = "message",
        timestamp = "2026-01-01T00:00:00.000Z",
        data = buildJsonObject {
            put("message", buildJsonObject {
                put("role", "user")
                put("content", id)
            })
        },
    )
    private val device = DeviceCredential(
        relayUrl = "wss://instrumented-test.example.com",
        deviceId = "session-graph-store-test",
        credential = "test-credential",
    )

    @After
    fun cleanUp() {
        store.clear()
    }

    @Test
    fun persistsAndReadsEntryWithAndroidKeystoreGcm() {
        val entry = SessionGraphEntry(
            entryId = "root",
            parentId = null,
            type = "message",
            timestamp = "2026-01-01T00:00:00.000Z",
            data = buildJsonObject {
                put("message", buildJsonObject {
                    put("role", "user")
                    put("content", "hello")
                })
            },
        )

        store.upsert(device, "session-1", listOf(entry), leafId = entry.entryId)

        val range = store.readBranch(device, "session-1", leafId = entry.entryId)
        assertEquals(listOf(entry), range.entries)
        assertEquals(true, range.complete)
    }

    @Test
    fun sharesCanonicalAncestorsAcrossSiblingBranches() {
        val root = entry("root", null)
        val shared = entry("shared", "root")
        val branchA = entry("branch-a", "shared")
        val branchB = entry("branch-b", "shared")

        store.upsert(device, "session-branches", listOf(root, shared, branchA), leafId = branchA.entryId)
        store.upsert(device, "session-branches", listOf(root, shared, branchB), leafId = branchB.entryId)

        assertEquals(
            listOf("root", "shared", "branch-a"),
            store.readBranch(device, "session-branches", branchA.entryId).entries.map(SessionGraphEntry::entryId),
        )
        assertEquals(
            listOf("root", "shared", "branch-b"),
            store.readBranch(device, "session-branches", branchB.entryId).entries.map(SessionGraphEntry::entryId),
        )
        assertEquals(true, store.contains(device, "session-branches", "shared"))
        assertEquals("branch-b", store.latestLeaf(device, "session-branches"))
    }

    @Test
    fun staleWriteGuardRollsBackEntriesAndCursor() {
        val root = entry("root", null)
        val child = entry("child", "root")
        store.upsert(device, "session-guard", listOf(root), leafId = root.entryId)

        var checks = 0
        val error = runCatching {
            store.upsert(
                device = device,
                sessionId = "session-guard",
                entries = listOf(child),
                leafId = child.entryId,
                writeGuard = { ++checks < 3 },
            )
        }.exceptionOrNull()

        assertEquals("stale_snapshot", error?.message)
        assertTrue(checks >= 3)
        assertFalse(store.contains(device, "session-guard", child.entryId))
        assertEquals("root", store.latestLeaf(device, "session-guard"))
    }

    @Test
    fun readsOlderBoundedRangesWithoutIncludingTheBoundary() {
        val root = entry("root", null)
        val one = entry("one", "root")
        val two = entry("two", "one")
        val three = entry("three", "two")
        store.upsert(device, "session-history", listOf(root, one, two, three), leafId = three.entryId)

        val range = store.readBranch(
            device = device,
            sessionId = "session-history",
            leafId = three.entryId,
            beforeEntryId = three.entryId,
            maxEntries = 2,
        )

        assertEquals(listOf("one", "two"), range.entries.map(SessionGraphEntry::entryId))
        assertEquals(false, range.complete)
        assertEquals(true, range.hasOlder)
        assertEquals(SessionGraphRangeStatus.OLDER_AVAILABLE, range.status)
    }

    @Test
    fun outOfOrderFragmentsShrinkTheGapAndSurviveReopen() {
        val entries = (1..10).map { entry("$it", if (it == 1) null else "${it - 1}") }
        store.upsert(device, "s", entries.take(3), leafId = "3")
        store.upsert(device, "s", entries.takeLast(3), leafId = "10")
        assertEquals("10", store.latestLeaf(device, "s"))
        assertEquals("3", store.continuousLeaf(device, "s"))
        assertFalse(store.hasContinuousCoverage(device, "s", "10"))
        assertEquals(SessionSyncGap("3", "7"), store.planCatchUp(device, "s", "10"))
        store.upsert(device, "s", entries.slice(4..6).reversed())
        assertEquals(SessionSyncGap("3", "4"), store.planCatchUp(device, "s", "10"))
        store.close()
        assertEquals(SessionSyncGap("3", "4"), store.planCatchUp(device, "s", "10"))
        store.upsert(device, "s", listOf(entries[3]))
        assertTrue(store.hasContinuousCoverage(device, "s", "10"))
        assertEquals(null, store.planCatchUp(device, "s", "10"))
        assertEquals("10", store.continuousLeaf(device, "s"))
        store.upsert(device, "s", entries.take(3), leafId = "3")
        assertEquals("10", store.continuousLeaf(device, "s"))
        assertEquals("10", store.latestLeaf(device, "s"))
    }

    @Test
    fun conflictsRollBackTheWholeBatchAndItsCoverage() {
        val root = entry("root", null)
        store.upsert(device, "s", listOf(root), leafId = "root")
        val changes = listOf(
            root.copy(parentId = "different"), root.copy(timestamp = "different"),
            root.copy(type = "different"), entry("root", null).copy(data = buildJsonObject { put("x", 1) }),
        )
        for (conflict in changes) {
            val error = runCatching {
                store.upsert(device, "s", listOf(entry("child", "root"), conflict), leafId = "child")
            }.exceptionOrNull()
            assertEquals("entry_conflict", error?.message)
            assertFalse(store.contains(device, "s", "child"))
            assertEquals("root", store.continuousLeaf(device, "s"))
            assertEquals(listOf(root), store.readEntries(device, "s", listOf("root")))
        }
        assertEquals("entry_conflict", runCatching {
            store.upsert(device, "s", listOf(entry("x", "root"), entry("x", null)))
        }.exceptionOrNull()?.message)
        store.upsert(device, "s", listOf(root, root))
        assertEquals("root", store.continuousLeaf(device, "s"))
    }

    @Test
    fun rejectsCyclesIncludingAPreviouslyMissingParent() {
        assertEquals("self_parent", runCatching {
            store.upsert(device, "s", listOf(entry("self", "self")))
        }.exceptionOrNull()?.message)
        assertEquals("cycle_detected", runCatching {
            store.upsert(device, "s", listOf(entry("a", "b"), entry("b", "a")))
        }.exceptionOrNull()?.message)
        store.upsert(device, "s", listOf(entry("a", "b")), leafId = "a")
        assertEquals("cycle_detected", runCatching {
            store.upsert(device, "s", listOf(entry("b", "c"), entry("c", "a")))
        }.exceptionOrNull()?.message)
        assertFalse(store.contains(device, "s", "b"))
        assertFalse(store.hasContinuousCoverage(device, "s", "a"))
    }

    @Test
    fun timingCompletionIsMonotonicAndConflictRollsBackNodes() {
        val started = TurnTiming("t", 100)
        val completed = started.copy(durationMs = 50, messageId = "root")
        store.upsert(device, "s", listOf(entry("root", null)), turnTimings = listOf(started))
        store.upsert(device, "s", emptyList(), turnTimings = listOf(completed, started))
        assertEquals(listOf(completed), store.readTurnTimings(device, "s"))
        assertEquals("turn_timing_conflict", runCatching {
            store.upsert(device, "s", listOf(entry("child", "root")), leafId = "child",
                turnTimings = listOf(completed.copy(durationMs = 51)))
        }.exceptionOrNull()?.message)
        assertFalse(store.contains(device, "s", "child"))
        assertEquals("root", store.continuousLeaf(device, "s"))
    }

    @Test
    fun commitGuardRollsBackPromotedSuffixAndTiming() {
        store.upsert(device, "s", listOf(entry("tail", "root")), leafId = "tail")
        var checks = 0
        assertEquals("stale_snapshot", runCatching {
            store.upsert(device, "s", listOf(entry("root", null)),
                turnTimings = listOf(TurnTiming("t", 100)), writeGuard = { ++checks < 3 })
        }.exceptionOrNull()?.message)
        store.close()
        assertFalse(store.contains(device, "s", "root"))
        assertFalse(store.hasContinuousCoverage(device, "s", "tail"))
        assertEquals(null, store.continuousLeaf(device, "s"))
        assertEquals(emptyList<TurnTiming>(), store.readTurnTimings(device, "s"))
    }

    private fun databaseFile(): File {
        val identity = MessageDigest.getInstance("SHA-256")
            .digest("${device.relayUrl}\u0000${device.deviceId}".toByteArray(Charsets.UTF_8))
            .joinToString("") { "%02x".format(it) }
        return File(File(context.filesDir, directoryName).also { it.mkdirs() }, "$identity.db")
    }

    private fun createVersion3(entries: List<SessionGraphEntry>, leaf: String) {
        SQLiteDatabase.openOrCreateDatabase(databaseFile(), null).use { db ->
            db.execSQL("""CREATE TABLE session_entries(session_id TEXT NOT NULL, entry_id TEXT NOT NULL,
                parent_id TEXT, type TEXT NOT NULL, timestamp TEXT NOT NULL, payload TEXT NOT NULL,
                PRIMARY KEY(session_id, entry_id))""")
            db.execSQL("CREATE INDEX idx_session_entries_parent ON session_entries(session_id, parent_id)")
            db.execSQL("CREATE TABLE session_cursors(session_id TEXT PRIMARY KEY, leaf_id TEXT NOT NULL, updated_at INTEGER NOT NULL)")
            db.execSQL("CREATE TABLE session_turn_timings(session_id TEXT NOT NULL, turn_id TEXT NOT NULL, payload TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY(session_id, turn_id))")
            entries.forEach { e -> db.execSQL("INSERT INTO session_entries VALUES (?, ?, ?, ?, ?, ?)",
                arrayOf("s", e.entryId, e.parentId, e.type, e.timestamp, Json.encodeToString(e.data))) }
            db.execSQL("INSERT INTO session_cursors VALUES ('s', ?, 0)", arrayOf(leaf))
            db.version = 3
        }
    }

    @Test
    fun upgradeVerifiesLegacyCursorAndPreservesUnconnectedRows() {
        createVersion3(listOf(entry("root", null), entry("tail", "missing")), "tail")
        assertEquals("tail", store.latestLeaf(device, "s"))
        assertEquals("root", store.continuousLeaf(device, "s"))
        assertEquals(SessionSyncGap("root", "missing"), store.planCatchUp(device, "s", "tail"))
        store.close()
        assertTrue(store.contains(device, "s", "tail"))
    }

    @Test
    fun codexMigrationArchivesOriginalAndDoesNotExcuseBodyConflicts() {
        val old = entry("root", null).copy(data = buildJsonObject {
            put("message", buildJsonObject {
                put("messageId", "root"); put("role", "assistant"); put("content", "old body"); put("timestamp", 123L)
            })
        })
        createVersion3(listOf(old), "root")
        store.prepareSession(device, "s", "pi")
        assertEquals(old, store.readEntries(device, "s", listOf("root")).single())
        store.prepareSession(device, "s", "codex")
        val stable = migrateLegacyCodexEntry(old)
        assertEquals(stable, store.readEntries(device, "s", listOf("root")).single())
        store.upsert(device, "s", listOf(stable), agentKind = "codex")
        assertEquals("entry_conflict", runCatching {
            store.upsert(device, "s", listOf(stable.copy(data = buildJsonObject { put("body", "changed") })), agentKind = "codex")
        }.exceptionOrNull()?.message)
        store.close()
        SQLiteDatabase.openDatabase(databaseFile().path, null, SQLiteDatabase.OPEN_READONLY).use { db ->
            db.rawQuery("SELECT timestamp, payload FROM session_legacy_entries", null).use { c ->
                assertTrue(c.moveToFirst())
                assertEquals(old.timestamp, c.getString(0))
                assertEquals(Json.encodeToString(old.data), c.getString(1))
                assertFalse(c.moveToNext())
            }
        }
        assertEquals(stable, store.readEntries(device, "s", listOf("root")).single())
    }

    @Test
    fun unknownLegacyCodexShapePreservesEveryOriginalRow() {
        val old = entry("root", null)
        createVersion3(listOf(old), "root")
        assertEquals("legacy_codex_shape_unknown", runCatching {
            store.prepareSession(device, "s", "codex")
        }.exceptionOrNull()?.message)
        assertEquals(old, store.readEntries(device, "s", listOf("root")).single())
    }

    @Test
    fun allRangesCommitAndOnlyTheRemainingHoleIsRequestedAfterRestart() {
        val entries = (1..10).map { entry("$it", if (it == 1) null else "${it - 1}") }
        store.upsert(device, "s", entries.take(3), leafId = "3")
        var state = RemoteState(runtimes = mapOf("r" to RuntimeSummary("r", "R", "/", "idle", "s", sessionLeafId = "10")))
        val reducer = RelayReducer()
        var sequence = 0L
        fun receive(range: String, batch: List<SessionGraphEntry>, wireTarget: String, before: String? = null) {
            val sync = "sync-${++sequence}"
            val pending = PendingSessionSync("r", "s", sync, range, targetLeafId = "10",
                requestTargetLeafId = wireTarget, beforeEntryId = before)
            state = state.copy(sessionSyncCommands = mapOf(sync to pending), pendingCommands = mapOf(sync to "r"))
            val snapshot = SessionGraphSnapshot("s", sync, SessionBranchCursor(wireTarget),
                if (range == "history") "prepend" else if (range == "preview") "replace" else "append",
                batch, range = range, targetLeafId = wireTarget, beforeEntryId = before, complete = true)
            val committed = ingestSessionSnapshot(store, device, "r", sync, snapshot, { state }, { true })!!
            val payload = buildJsonObject {
                put("type", "runtime.event"); put("runtimeId", "r"); put("sequence", sequence)
                put("event", buildJsonObject {
                    Json.encodeToJsonElement(SessionGraphSnapshot.serializer(), snapshot).let {
                        (it as kotlinx.serialization.json.JsonObject).forEach { (key, value) -> put(key, value) }
                    }
                    put("type", "session.snapshot")
                })
            }.toString()
            state = reducer.reduce(state, payload, committed)
        }
        receive("preview", entries.takeLast(3), "10")
        assertEquals(SessionSyncGap("3", "7"), store.planCatchUp(device, "s", "10"))
        receive("history", entries.slice(4..6), "10", "8")
        store.close()
        assertEquals(SessionSyncGap("3", "4"), store.planCatchUp(device, "s", "10"))
        // This is the actual next wire boundary: no 5..10 entries need downloading again.
        val gap = store.planCatchUp(device, "s", "10")!!
        receive("catchup", listOf(entries[3]), gap.targetLeafId)
        assertEquals(null, store.planCatchUp(device, "s", "10"))
        assertEquals("10", store.latestLeaf(device, "s"))
        assertEquals("10", state.runtimes["r"]?.sessionLeafId)
        assertEquals("10", state.runtimeSessionViews["r"]?.leafId)
        assertEquals((4..10).map(Int::toString), state.conversations["r"]?.messages?.map { it.messageId })
        assertEquals(entries, store.readBranch(device, "s", "10").entries)
    }

    @Test
    fun allRangeOwnershipGuardsPreventLateWritesAndWrongBoundaries() {
        for (range in listOf("preview", "history", "catchup")) {
            val pending = PendingSessionSync("r", "s", "sync", range, "tail", beforeEntryId = "tail".takeIf { range == "history" })
            val snapshot = SessionGraphSnapshot("s", "sync", SessionBranchCursor("tail"),
                if (range == "history") "prepend" else "replace", listOf(entry("root", null)),
                range = range, targetLeafId = "tail", beforeEntryId = pending.beforeEntryId)
            val owned = RemoteState(runtimes = mapOf("r" to RuntimeSummary("r", "R", "/", "idle", "s", sessionLeafId = "tail")),
                sessionSyncCommands = mapOf("command" to pending))
            assertEquals(null, ingestSessionSnapshot(store, device, "r", "command", snapshot, { owned }, { false }))
            assertEquals(null, ingestSessionSnapshot(store, device, "r", "command", snapshot,
                { owned.copy(sessionBranchGenerations = mapOf("r" to 1)) }, { true }))
            assertEquals(null, ingestSessionSnapshot(store, device, "r", "command", snapshot,
                { owned.copy(runtimes = mapOf("r" to owned.runtimes.getValue("r").copy(sessionId = "other"))) }, { true }))
            assertEquals(null, ingestSessionSnapshot(store, device, "r", "command", snapshot.copy(range = "invalid"), { owned }, { true }))
            assertFalse(store.contains(device, "s", "root"))
        }
    }

    @Test
    fun cachedHistoryPageDoesNotRequireOlderMissingAncestors() {
        val entries = (5..10).map { entry("$it", "${it - 1}") }
        store.upsert(device, "s", entries, leafId = "10")
        val bounded = store.readBranch(device, "s", "10", beforeEntryId = "8", maxEntries = 3)
        assertEquals(listOf("5", "6", "7"), bounded.entries.map { it.entryId })
        assertEquals(SessionGraphRangeStatus.OLDER_AVAILABLE, bounded.status)
        val partial = store.readBranch(device, "s", "10", beforeEntryId = "8", maxEntries = 100)
        assertEquals(bounded.entries, partial.entries)
        assertTrue(partial.hasOlder)
        assertEquals(SessionGraphRangeStatus.MISSING_PARENT, partial.status)
    }
}
