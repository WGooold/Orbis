package dev.pi.remote

import android.content.Context
import android.database.sqlite.SQLiteDatabase
import java.io.File
import java.security.MessageDigest
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.int
import kotlinx.serialization.json.long
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
    fun authoritativeEpochSwitchCorrectsSameIdAndPersistsOwnership() {
        val old = listOf(entry("a", null), entry("b", "a"), entry("c", "b"))
        store.upsert(device, "s", old, "c", source = SessionSourceEpoch("old", 4, true), activateSource = true)
        val corrected = entry("c", "a").copy(timestamp = "corrected")
        store.upsert(device, "s", listOf(corrected), "c", source = SessionSourceEpoch("new", 2, true), activateSource = true)
        assertFalse(store.contains(device, "s", "b"))
        assertFalse(store.hasContinuousCoverage(device, "s", "c"))
        assertEquals("new", store.cacheEpoch(device, "s"))
        store.close()
        store.upsert(device, "s", listOf(entry("a", null), entry("c", "wrong")), source = SessionSourceEpoch("new", 1, true))
        assertEquals(listOf(corrected), store.readEntries(device, "s", listOf("c")))
        assertTrue(store.hasContinuousCoverage(device, "s", "c"))
        assertEquals("c", store.latestLeaf(device, "s"))
        val cached = store.withCacheVersions(device, SessionGraph("s", mapOf("c" to corrected)))
        assertEquals("new", cached.cacheEpoch)
        assertEquals(2L, cached.entryVersions["c"])
    }

    @Test
    fun authoritativeParentCorrectionInvalidatesDescendantCoverageAndPreservesOtherRows() {
        store.upsert(device, "s", listOf(entry("a", null), entry("b", "a"), entry("c", "b")), "c",
            source = SessionSourceEpoch("e", 1, true), activateSource = true)
        store.upsert(device, "s", listOf(entry("b", "gap")), source = SessionSourceEpoch("e", 2, true))
        assertFalse(store.hasContinuousCoverage(device, "s", "c"))
        assertTrue(store.contains(device, "s", "a"))
        assertTrue(store.contains(device, "s", "c"))
        store.upsert(device, "s", listOf(entry("gap", "a")), source = SessionSourceEpoch("e", 3, true))
        assertTrue(store.hasContinuousCoverage(device, "s", "c"))
        assertEquals(listOf("a", "gap", "b", "c"), store.readBranch(device, "s", "c").entries.map { it.entryId })
    }

    @Test
    fun invalidAuthorityAndLostOwnershipRollBackEpochCursorAndCoverage() {
        val root = entry("root", null)
        store.upsert(device, "s", listOf(root), "root", source = SessionSourceEpoch("old", 1, true), activateSource = true)
        assertEquals("cycle_detected", runCatching {
            store.upsert(device, "s", listOf(entry("a", "b"), entry("b", "a")), "b",
                source = SessionSourceEpoch("new", 1, true), activateSource = true)
        }.exceptionOrNull()?.message)
        var checks = 0
        assertEquals("stale_snapshot", runCatching {
            store.upsert(device, "s", emptyList(), source = SessionSourceEpoch("new", 1, true), activateSource = true,
                writeGuard = { ++checks < 3 })
        }.exceptionOrNull()?.message)
        assertEquals("old", store.cacheEpoch(device, "s"))
        assertEquals("root", store.latestLeaf(device, "s"))
        assertTrue(store.hasContinuousCoverage(device, "s", "root"))
        assertEquals(listOf(root), store.readEntries(device, "s", listOf("root")))
    }

    @Test
    fun emptyAuthoritativeCheckpointClearsOnlyItsSession() {
        store.upsert(device, "s", listOf(entry("root", null)), "root", source = SessionSourceEpoch("old", 1, true), activateSource = true)
        store.upsert(device, "other", listOf(entry("other", null)), "other")
        store.upsert(device, "s", emptyList(), source = SessionSourceEpoch("new", 1, true), activateSource = true)
        assertEquals("new", store.cacheEpoch(device, "s"))
        assertEquals(null, store.latestLeaf(device, "s"))
        assertEquals(null, store.continuousLeaf(device, "s"))
        assertFalse(store.contains(device, "s", "root"))
        assertTrue(store.contains(device, "other", "other"))
    }

    @Test
    fun rejectedReadyEpochAndRetiredHistoryNeverWriteDisk() {
        val root = entry("root", null)
        store.upsert(device, "s", listOf(root), "root", source = SessionSourceEpoch("e", 5, true), activateSource = true)
        val conversation = RuntimeConversation(sourceEpoch = "e", sourceSeq = 5, sourceReady = true, retiredSourceEpochs = setOf("old"))
        for ((range, epoch) in listOf("preview" to "future", "history" to "old")) {
            val pending = PendingSessionSync("r", "s", "sync", range, beforeEntryId = "root".takeIf { range == "history" })
            val state = RemoteState(runtimes = mapOf("r" to RuntimeSummary("r", "R", "/", "idle", "s")),
                conversations = mapOf("r" to conversation), sessionSyncCommands = mapOf("cmd" to pending))
            val snapshot = SessionGraphSnapshot("s", "sync", SessionBranchCursor("root"),
                if (range == "history") "prepend" else "replace", listOf(root.copy(timestamp = "wrong")), range = range,
                beforeEntryId = pending.beforeEntryId, source = SessionSourceEpoch(epoch, 99, true),
                checkpoint = SessionCheckpoint("id", SessionBranchCursor("root"), "complete", true), live = SessionLiveState(true))
            assertEquals(emptyList<SessionGraphEntry>(), ingestSessionSnapshot(store, device, "r", "cmd", snapshot, { state }, { true }))
            assertEquals("e", store.cacheEpoch(device, "s"))
            assertEquals(listOf(root), store.readEntries(device, "s", listOf("root")))
        }
    }

    @Test
    fun checkpointAndBufferedCanonicalSuffixCommitAsOneCacheGeneration() {
        val old = entry("obsolete", null)
        store.upsert(device, "s", listOf(old), "obsolete", source = SessionSourceEpoch("old", 1, true), activateSource = true)
        val root = entry("a", null)
        val child = entry("b", "a")
        val patch = SessionPatch(sessionId = "s", source = SessionSourceEpoch("e", 3, true), baseSeq = 2, seq = 3,
            checkpointId = "e:3", head = SessionBranchCursor("b"), headCompleteness = "complete",
            live = SessionLiveState(true), entries = listOf(child))
        val state = RemoteState(runtimes = mapOf("r" to RuntimeSummary("r", "R", "/", "idle", "s")),
            conversations = mapOf("r" to RuntimeConversation(sourceEpoch = "e", sourceReady = false,
                sourcePatchBuffer = mapOf(3L to patch))),
            sessionGraphs = mapOf("s" to SessionGraph("s", mapOf("obsolete" to old), cacheEpoch = "old")),
            sessionSyncCommands = mapOf("cmd" to PendingSessionSync("r", "s", "sync", "preview")))
        val snapshot = SessionGraphSnapshot("s", "sync", SessionBranchCursor("a"), "replace", listOf(root), range = "preview",
            source = SessionSourceEpoch("e", 2, true), checkpoint = SessionCheckpoint("e:2", SessionBranchCursor("a"), "complete", true),
            live = SessionLiveState(true))
        val persisted = ingestSessionSnapshot(store, device, "r", "cmd", snapshot, { state }, { true })!!
        assertEquals(listOf(root, child), persisted)
        assertEquals("e", store.cacheEpoch(device, "s"))
        assertEquals("b", store.latestLeaf(device, "s"))
        assertTrue(store.hasContinuousCoverage(device, "s", "b"))
        assertFalse(store.contains(device, "s", "obsolete"))
        val event = buildJsonObject {
            put("type", "runtime.event"); put("runtimeId", "r"); put("sequence", 1)
            put("event", buildJsonObject {
                (Json.encodeToJsonElement(SessionGraphSnapshot.serializer(), snapshot) as JsonObject).forEach { (key, value) -> put(key, value) }
                put("type", "session.snapshot")
            })
        }
        val reduced = RelayReducer().reduce(state, event.toString(), persisted)
        assertEquals(3L, reduced.conversations.getValue("r").sourceSeq)
        assertEquals("b", reduced.runtimeSessionViews.getValue("r").leafId)
        assertEquals(listOf("a", "b"), reduced.conversations.getValue("r").messages.map { it.messageId })
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

    private fun createVersion4(entries: List<SessionGraphEntry>, leaf: String) {
        createVersion3(entries, leaf)
        SQLiteDatabase.openDatabase(databaseFile().path, null, SQLiteDatabase.OPEN_READWRITE).use { db ->
            db.execSQL("ALTER TABLE session_entries ADD COLUMN verified_depth INTEGER")
            db.execSQL("ALTER TABLE session_entries ADD COLUMN legacy_format INTEGER NOT NULL DEFAULT 0")
            db.execSQL("CREATE TABLE session_sync_progress(session_id TEXT PRIMARY KEY, leaf_id TEXT NOT NULL)")
            db.execSQL("""CREATE TABLE session_legacy_entries(session_id TEXT NOT NULL, entry_id TEXT NOT NULL,
                parent_id TEXT, type TEXT NOT NULL, timestamp TEXT NOT NULL, payload TEXT NOT NULL,
                PRIMARY KEY(session_id, entry_id))""")
            db.execSQL("UPDATE session_entries SET verified_depth = 0 WHERE parent_id IS NULL")
            db.execSQL("INSERT INTO session_sync_progress VALUES ('s', ?)", arrayOf(leaf))
            db.execSQL("INSERT INTO session_turn_timings VALUES ('s', 'turn', ?, 7)",
                arrayOf(Json.encodeToString(TurnTiming("turn", 100, 50, messageId = leaf))))
            db.execSQL("INSERT INTO session_legacy_entries SELECT session_id, entry_id, parent_id, type, timestamp, payload FROM session_entries")
            db.version = 4
        }
    }

    private fun createVersion5(entries: List<SessionGraphEntry>, leaf: String, completedV4Archive: String? = null) {
        createVersion4(entries, leaf)
        SQLiteDatabase.openDatabase(databaseFile().path, null, SQLiteDatabase.OPEN_READWRITE).use { db ->
            db.execSQL("""CREATE TABLE codex_canonical_rebuilds(session_id TEXT PRIMARY KEY,
                prior_database_version INTEGER NOT NULL, archive TEXT, completed_at INTEGER)""")
            if (completedV4Archive != null) db.execSQL(
                "INSERT INTO codex_canonical_rebuilds VALUES ('s', 4, ?, 9)", arrayOf(completedV4Archive))
            db.version = 5
        }
    }

    private fun rebuildArchive(sessionId: String = "s", format: String = "codex-native-item-ids-v2"): JsonObject? {
        store.close()
        return SQLiteDatabase.openDatabase(databaseFile().path, null, SQLiteDatabase.OPEN_READONLY).use { db ->
            db.rawQuery("SELECT archive FROM codex_canonical_rebuilds WHERE session_id = ? AND canonical_format = ?", arrayOf(sessionId, format)).use { c ->
                if (!c.moveToFirst() || c.isNull(0)) null else Json.parseToJsonElement(c.getString(0)).jsonObject
            }
        }
    }

    @Test
    fun version5RebuildPreservesEarlierArchiveAndRehydratesNativeParentsOnce() {
        val priorArchive = buildJsonObject { put("original", "v4 exact archive") }
        val oldUser = entry("item-3", null)
        val sharedTool = entry("exec-native", "item-3")
        createVersion5(listOf(oldUser, sharedTool), "exec-native", priorArchive.toString())
        assertFalse(store.prepareSession(device, "s", "pi"))
        assertEquals(listOf(oldUser, sharedTool), store.readBranch(device, "s", "exec-native").entries)
        assertTrue(store.prepareSession(device, "s", "codex"))
        val archive = rebuildArchive()!!
        assertEquals(5, archive.getValue("priorDatabaseVersion").jsonPrimitive.int)
        assertEquals(2, archive.getValue("entries").jsonArray.size)
        assertEquals(priorArchive, rebuildArchive(format = "codex-native-item-order-v1"))
        val nativeUser = entry("uuid-user", null)
        val nativeTool = sharedTool.copy(parentId = "uuid-user")
        store.upsert(device, "s", listOf(nativeUser, nativeTool), leafId = "exec-native", agentKind = "codex")
        store.close()
        assertFalse(store.prepareSession(device, "s", "codex"))
        assertEquals(listOf(nativeUser, nativeTool), store.readBranch(device, "s", "exec-native").entries)
        assertEquals(archive, rebuildArchive())
        assertEquals(priorArchive, rebuildArchive(format = "codex-native-item-order-v1"))
        assertEquals("entry_conflict", runCatching {
            store.upsert(device, "s", listOf(sharedTool), agentKind = "codex")
        }.exceptionOrNull()?.message)
    }

    @Test
    fun version5InvalidRebuildRollsBackWithoutOverwritingPriorArchive() {
        val priorArchive = buildJsonObject { put("original", "v4") }
        val old = entry("item-1", null)
        createVersion5(listOf(old), "item-1", priorArchive.toString())
        assertEquals("self_parent", runCatching {
            store.upsert(device, "s", listOf(entry("bad", "bad")), agentKind = "codex")
        }.exceptionOrNull()?.message)
        assertEquals(listOf(old), store.readEntries(device, "s", listOf("item-1")))
        assertEquals(null, rebuildArchive())
        assertEquals(priorArchive, rebuildArchive(format = "codex-native-item-order-v1"))
        assertTrue(store.prepareSession(device, "s", "codex"))
        assertFalse(store.prepareSession(device, "s", "codex"))
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
    fun codexRebuildArchivesOriginalAndDoesNotExcuseLaterConflicts() {
        val old = entry("root", null).copy(data = buildJsonObject {
            put("message", buildJsonObject {
                put("messageId", "root"); put("role", "assistant"); put("content", "old body"); put("timestamp", 123L)
            })
        })
        createVersion3(listOf(old), "root")
        assertFalse(store.prepareSession(device, "s", "pi"))
        assertFalse(store.prepareSession(device, "s", "dsh"))
        assertEquals(old, store.readEntries(device, "s", listOf("root")).single())
        assertTrue(store.prepareSession(device, "s", "codex"))
        assertFalse(store.contains(device, "s", "root"))
        assertEquals(null, store.latestLeaf(device, "s"))
        assertEquals(null, store.continuousLeaf(device, "s"))
        val stable = migrateLegacyCodexEntry(old)
        store.upsert(device, "s", listOf(stable), leafId = "root", agentKind = "codex")
        assertFalse(store.prepareSession(device, "s", "codex"))
        assertEquals("entry_conflict", runCatching {
            store.upsert(device, "s", listOf(stable.copy(data = buildJsonObject { put("body", "changed") })), agentKind = "codex")
        }.exceptionOrNull()?.message)
        val archived = rebuildArchive()!!
        assertEquals(3, archived.getValue("priorDatabaseVersion").jsonPrimitive.int)
        val rows = archived.getValue("entries").jsonArray
        assertEquals(1, rows.size)
        assertEquals(old.timestamp, rows.single().jsonObject.getValue("timestamp").jsonPrimitive.content)
        assertEquals(Json.encodeToString(old.data), rows.single().jsonObject.getValue("payload").jsonPrimitive.content)
        assertFalse(store.prepareSession(device, "s", "codex"))
        assertEquals(stable, store.readEntries(device, "s", listOf("root")).single())
        assertEquals("root", store.latestLeaf(device, "s"))
        assertEquals(archived, rebuildArchive())
    }

    @Test
    fun unknownLegacyCodexShapeIsArchivedWithoutInventingANewRepresentation() {
        val old = entry("root", null)
        createVersion3(listOf(old), "root")
        assertTrue(store.prepareSession(device, "s", "codex"))
        assertFalse(store.contains(device, "s", "root"))
        assertEquals(Json.encodeToString(old.data), rebuildArchive()!!.getValue("entries")
            .jsonArray.single().jsonObject.getValue("payload").jsonPrimitive.content)
    }

    @Test
    fun version4RebuildArchivesEvenPreviouslyNonLegacyParentEdgesAndAllMetadata() {
        val old = entry("root", null)
        val tail = entry("tail", "root")
        createVersion4(listOf(old, tail), "tail")
        store.upsert(device, "pi-session", listOf(entry("pi-root", null)), leafId = "pi-root", agentKind = "pi")
        assertTrue(store.prepareSession(device, "s", "codex"))
        assertFalse(store.contains(device, "s", "tail"))
        assertEquals(emptyList<TurnTiming>(), store.readTurnTimings(device, "s"))
        val archived = rebuildArchive()!!
        assertEquals(4, archived.getValue("priorDatabaseVersion").jsonPrimitive.int)
        assertEquals(2, archived.getValue("entries").jsonArray.size)
        assertTrue(archived.getValue("entries").jsonArray.all { it.jsonObject.getValue("legacy_format").jsonPrimitive.int == 0 })
        val archivedTail = archived.getValue("entries").jsonArray.single { it.jsonObject.getValue("entry_id").jsonPrimitive.content == "tail" }
        assertEquals("root", archivedTail.jsonObject.getValue("parent_id").jsonPrimitive.content)
        assertEquals("tail", archived.getValue("cursor").jsonArray.single().jsonObject.getValue("leaf_id").jsonPrimitive.content)
        assertEquals("tail", archived.getValue("coverage").jsonArray.single().jsonObject.getValue("leaf_id").jsonPrimitive.content)
        assertEquals(7L, archived.getValue("timings").jsonArray.single().jsonObject.getValue("updated_at").jsonPrimitive.long)
        assertEquals(2, archived.getValue("legacyEntries").jsonArray.size)
        // Native history can now seed a corrected stable parent for the same ID.
        store.upsert(device, "s", listOf(tail.copy(parentId = null)), leafId = "tail", agentKind = "codex")
        assertEquals(listOf(tail.copy(parentId = null)), store.readBranch(device, "s", "tail").entries)
        assertEquals("pi-root", store.latestLeaf(device, "pi-session"))
        assertEquals(listOf(entry("pi-root", null)), store.readBranch(device, "pi-session", "pi-root").entries)
    }

    @Test
    fun staleRebuildBatchRollsBackArchiveOldGraphTimingAndCoverageTogether() {
        val old = entry("root", null)
        createVersion4(listOf(old), "root")
        var checks = 0
        assertEquals("stale_snapshot", runCatching {
            store.upsert(device, "s", listOf(entry("replacement", null)), leafId = "replacement",
                agentKind = "codex", writeGuard = { ++checks < 3 })
        }.exceptionOrNull()?.message)
        assertEquals(listOf(old), store.readEntries(device, "s", listOf("root")))
        assertFalse(store.contains(device, "s", "replacement"))
        assertEquals("root", store.latestLeaf(device, "s"))
        assertEquals("root", store.continuousLeaf(device, "s"))
        assertEquals(listOf(TurnTiming("turn", 100, 50, messageId = "root")), store.readTurnTimings(device, "s"))
        assertEquals(null, rebuildArchive())
        assertTrue(store.prepareSession(device, "s", "codex"))
        assertFalse(store.prepareSession(device, "s", "codex"))
    }

    @Test
    fun invalidRebuildBatchKeepsPendingMigrationAndOriginalRowsForRetry() {
        val old = entry("root", null)
        createVersion4(listOf(old), "root")
        assertEquals("self_parent", runCatching {
            store.upsert(device, "s", listOf(entry("self", "self")), agentKind = "codex")
        }.exceptionOrNull()?.message)
        assertEquals(null, rebuildArchive())
        assertEquals(listOf(old), store.readEntries(device, "s", listOf("root")))
        store.upsert(device, "s", listOf(entry("replacement", null)), leafId = "replacement", agentKind = "codex")
        assertFalse(store.contains(device, "s", "root"))
        assertEquals("replacement", store.continuousLeaf(device, "s"))
        assertEquals(1, rebuildArchive()!!.getValue("entries").jsonArray.size)
    }

    @Test
    fun brandNewCodexCacheDoesNotScheduleARebuildOnConflicts() {
        val root = entry("root", null)
        store.upsert(device, "s", listOf(root), leafId = "root", agentKind = "codex")
        assertFalse(store.prepareSession(device, "s", "codex"))
        assertEquals("entry_conflict", runCatching {
            store.upsert(device, "s", listOf(root.copy(parentId = "unknown")), agentKind = "codex")
        }.exceptionOrNull()?.message)
        assertEquals(listOf(root), store.readEntries(device, "s", listOf("root")))
        assertEquals(null, rebuildArchive())
    }

    @Test
    fun upgradeLeavesExistingPiAndDshGraphsAndCoverageIntact() {
        val root = entry("root", null)
        createVersion4(listOf(root), "root")
        SQLiteDatabase.openDatabase(databaseFile().path, null, SQLiteDatabase.OPEN_READWRITE).use { db ->
            for (session in listOf("pi", "dsh")) {
                db.execSQL("INSERT INTO session_entries SELECT ?, entry_id, parent_id, type, timestamp, payload, verified_depth, legacy_format FROM session_entries WHERE session_id = 's'", arrayOf(session))
                db.execSQL("INSERT INTO session_cursors VALUES (?, 'root', 0)", arrayOf(session))
                db.execSQL("INSERT INTO session_sync_progress VALUES (?, 'root')", arrayOf(session))
            }
        }
        assertTrue(store.prepareSession(device, "s", "codex"))
        for (kind in listOf("pi", "dsh")) {
            assertFalse(store.prepareSession(device, kind, kind))
            assertEquals(listOf(root), store.readBranch(device, kind, "root").entries)
            assertEquals("root", store.latestLeaf(device, kind))
            assertEquals("root", store.continuousLeaf(device, kind))
            assertEquals(null, rebuildArchive(kind))
        }
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

    @Test
    fun sourceCommitUsesCanonicalTransactionBeforeDisplayAndRejectsCycles() {
        val root = entry("root", null)
        store.upsert(device, "s", listOf(root), leafId = "root", source = SessionSourceEpoch("epoch", 1, true), activateSource = true)
        val state = RemoteState(runtimes = mapOf("r" to RuntimeSummary("r", "R", "/", "running", "s")),
            conversations = mapOf("r" to RuntimeConversation(sourceEpoch = "epoch", sourceSeq = 1)),
            sessionGraphs = mapOf("s" to SessionGraph("s", mapOf("root" to root), cacheEpoch = "epoch")))
        val patch = SessionPatch(sessionId = "s", source = SessionSourceEpoch("epoch", 2, true), baseSeq = 1, seq = 2,
            checkpointId = "epoch:2", head = SessionBranchCursor("result"), headCompleteness = "complete",
            live = SessionLiveState(true), entries = listOf(entry("call", "root"), entry("result", "call")))
        val persisted = ingestSessionPatch(store, device, "r", patch, { state }, { true })
        assertEquals(patch.entries, persisted)
        assertTrue(store.hasContinuousCoverage(device, "s", "result"))
        val conflicted = patch.copy(entries = listOf(entry("new", "result"), entry("root", "new")))
        val failure = runCatching { ingestSessionPatch(store, device, "r", conflicted, { state }, { true }) }
        assertTrue(failure.isFailure)
        assertFalse(store.contains(device, "s", "new"))
        assertEquals(root, store.readEntries(device, "s", listOf("root")).single())
    }

    @Test
    fun staleSourceCommitCannotEnterCanonicalCache() {
        val state = RemoteState(runtimes = mapOf("r" to RuntimeSummary("r", "R", "/", "running", "s")),
            conversations = mapOf("r" to RuntimeConversation(sourceEpoch = "epoch", sourceSeq = 1, retiredSourceEpochs = setOf("retired"))))
        val patch = SessionPatch(sessionId = "s", source = SessionSourceEpoch("epoch", 2, true), baseSeq = 1, seq = 2,
            checkpointId = "epoch:2", head = SessionBranchCursor("new"), headCompleteness = "complete",
            live = SessionLiveState(true), entries = listOf(entry("new", null)))
        assertEquals(null, ingestSessionPatch(store, device, "r", patch, { state }, { false }))
        assertEquals(null, ingestSessionPatch(store, device, "r", patch.copy(sessionId = "other"), { state }, { true }))
        assertEquals(null, ingestSessionPatch(store, device, "r", patch.copy(source = SessionSourceEpoch("retired", 2, true)), { state }, { true }))
        assertEquals(null, ingestSessionPatch(store, device, "r", patch, { state.copy(conversations = mapOf("r" to
            state.conversations.getValue("r").copy(sourceSeq = 2))) }, { true }))
        assertFalse(store.contains(device, "s", "new"))
    }

}
