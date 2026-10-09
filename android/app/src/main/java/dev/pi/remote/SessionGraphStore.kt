package dev.pi.remote

import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import java.io.File
import java.util.ArrayDeque
import java.security.MessageDigest
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

class SessionGraphStoreException(message: String) : IllegalStateException(message)

private val SESSION_GRAPH_CONFLICT_MESSAGES = setOf("entry_conflict", "turn_timing_conflict")

/**
 * Invalid remote batches roll back; accepted source corrections replace stale cached rows.
 */
internal fun isSessionGraphConflict(error: Throwable?): Boolean =
    error is SessionGraphStoreException && error.message in SESSION_GRAPH_CONFLICT_MESSAGES

private const val STALE_SESSION_GRAPH_WRITE = "stale_snapshot"

/**
 * Canonical, session-scoped Entry storage. A branch is a query from a leaf through parent IDs;
 * it is never copied into a separate branch or page record.
 */
class SessionGraphStore(
    context: Context,
    private val json: Json = Json { ignoreUnknownKeys = true },
    directoryName: String = "session-tree-store",
) {
    private val appContext = context.applicationContext
    private val directory = File(appContext.filesDir, directoryName).also {
        require(directoryName.isNotBlank() && '/' !in directoryName && '\\' !in directoryName)
    }
    private val databases = mutableMapOf<String, GraphDatabase>()

    @Synchronized
    fun upsert(
        device: DeviceCredential,
        sessionId: String,
        entries: Collection<SessionGraphEntry>,
        leafId: String? = null,
        turnTimings: Collection<TurnTiming> = emptyList(),
        writeGuard: (() -> Boolean)? = null,
        agentKind: String? = null,
        source: SessionSourceEpoch? = null,
        activateSource: Boolean = false,
    ) {
        if (entries.isEmpty() && leafId == null && turnTimings.isEmpty() && source == null) return
        require(sessionId.isNotBlank()) { "session_id_required" }
        turnTimings.forEach(::validateTurnTiming)
        if (writeGuard?.invoke() == false) throw SessionGraphStoreException(STALE_SESSION_GRAPH_WRITE)
        val database = database(device).writableDatabase
        database.beginTransaction()
        try {
            if (writeGuard?.invoke() == false) throw SessionGraphStoreException(STALE_SESSION_GRAPH_WRITE)
            if (agentKind == "codex") {
                rebuildCodexGraph(database, sessionId)
                migrateCodexRows(database, sessionId)
            }
            if (source != null) {
                require(source.ready) { "source_not_ready" }
                val epoch = cacheEpoch(database, sessionId)
                if (epoch != source.epoch) {
                    require(activateSource) { "source_epoch_not_accepted" }
                    for (table in listOf("session_entries", "session_cursors", "session_turn_timings", "session_sync_progress")) {
                        database.delete(table, "session_id = ?", arrayOf(sessionId))
                    }
                    database.execSQL("INSERT OR REPLACE INTO session_cache_epochs(session_id, epoch) VALUES (?, ?)",
                        arrayOf(sessionId, source.epoch))
                }
            }
            val batch = validateCanonicalEntries(entries, { null })
            val effective = batch.values.map { entry ->
                if (source != null && source.seq < storedSourceSeq(database, sessionId, entry.entryId))
                    find(database, sessionId, entry.entryId) ?: entry else entry
            }
            val received = validateCanonicalEntries(
                effective,
                lookup = { find(database, sessionId, it) },
                parentOf = { id ->
                    // Only the unversioned immutable path can stop at a previously verified
                    // ancestor. Authority corrections must check the complete affected chain.
                    if (source == null && storedDepth(database, sessionId, id) != null) null else storedParent(database, sessionId, id)
                },
                authoritative = source != null,
            )
            val corrected = received.values.any { entry ->
                find(database, sessionId, entry.entryId)?.let { it != entry } == true
            }
            if (corrected) {
                // Parent corrections invalidate every depth derived from the previous graph.
                database.execSQL("UPDATE session_entries SET verified_depth = NULL WHERE session_id = ?", arrayOf(sessionId))
                database.delete("session_sync_progress", "session_id = ?", arrayOf(sessionId))
            }
            for (entry in received.values) {
                val existing = find(database, sessionId, entry.entryId)
                if (existing == entry) {
                    if (source != null) database.execSQL(
                        "UPDATE session_entries SET source_seq = MAX(source_seq, ?) WHERE session_id = ? AND entry_id = ?",
                        arrayOf(source.seq, sessionId, entry.entryId))
                    continue
                }
                database.execSQL(
                    """
                    INSERT OR REPLACE INTO session_entries(
                        session_id, entry_id, parent_id, type, timestamp, payload, legacy_format, source_seq
                    ) VALUES (?, ?, ?, ?, ?, ?, 0, ?)
                    """.trimIndent(),
                    arrayOf<Any?>(
                        sessionId,
                        entry.entryId,
                        entry.parentId,
                        entry.type,
                        entry.timestamp,
                        json.encodeToString(entry.data),
                        source?.seq ?: -1L,
                    ),
                )
            }
            for (timing in turnTimings) {
                val existing = findStoredTiming(database, sessionId, timing.turnId)
                if (source != null && source.seq < storedTimingSourceSeq(database, sessionId, timing.turnId)) continue
                val merged = mergeCanonicalTiming(existing.takeIf { source == null }, timing)
                if (existing == merged) {
                    if (source != null) database.execSQL(
                        "UPDATE session_turn_timings SET source_seq = MAX(source_seq, ?) WHERE session_id = ? AND turn_id = ?",
                        arrayOf(source.seq, sessionId, timing.turnId))
                    continue
                }
                database.execSQL(
                    """
                    INSERT OR REPLACE INTO session_turn_timings(session_id, turn_id, payload, updated_at, source_seq)
                    VALUES (?, ?, ?, ?, ?)
                    """.trimIndent(),
                    arrayOf<Any?>(
                        sessionId,
                        timing.turnId,
                        json.encodeToString(merged),
                        System.currentTimeMillis(),
                        source?.seq ?: -1L,
                    ),
                )
            }
            if (leafId != null) {
                val storedLeaf = findStored(database, sessionId, leafId)
                if (storedLeaf == null) throw SessionGraphStoreException("leaf_not_found")
                val previousLeaf = latestLeaf(device, sessionId)
                if (source != null || previousLeaf == null || !isAncestor(database, sessionId, leafId, previousLeaf)) database.execSQL(
                    """
                    INSERT OR REPLACE INTO session_cursors(session_id, leaf_id, updated_at)
                    VALUES (?, ?, ?)
                    """.trimIndent(),
                    arrayOf<Any?>(sessionId, leafId, System.currentTimeMillis()),
                )
            }
            val coverageIds = if (corrected) database.rawQuery(
                "SELECT entry_id FROM session_entries WHERE session_id = ? AND parent_id IS NULL", arrayOf(sessionId),
            ).use { cursor -> buildList { while (cursor.moveToNext()) add(cursor.getString(0)) } } else received.keys
            promoteCoverage(database, sessionId, coverageIds, leafId)
            if (writeGuard?.invoke() == false) throw SessionGraphStoreException(STALE_SESSION_GRAPH_WRITE)
            database.setTransactionSuccessful()
        } catch (error: IllegalArgumentException) {
            throw SessionGraphStoreException(error.message ?: "invalid_session_entries")
        } finally {
            database.endTransaction()
        }
    }

    /**
     * Reads a root-to-leaf range. If startEntryId is supplied, the range ends at that ancestor;
     * if it is absent, the read stops at maxEntries or the root.
     */
    @Synchronized
    fun readBranch(
        device: DeviceCredential,
        sessionId: String,
        leafId: String?,
        startEntryId: String? = null,
        maxEntries: Int = DEFAULT_MAX_ENTRIES,
        beforeEntryId: String? = null,
    ): SessionGraphRange {
        if (leafId == null || maxEntries <= 0) {
            return SessionGraphRange(
                emptyList(),
                hasOlder = false,
                complete = false,
                status = if (leafId == null) {
                    SessionGraphRangeStatus.LEAF_NOT_FOUND
                } else {
                    SessionGraphRangeStatus.LIMIT_REACHED
                },
            )
        }
        val database = database(device).readableDatabase
        if (beforeEntryId != null) {
            return readOlderBranchRange(
                database = database,
                sessionId = sessionId,
                leafId = leafId,
                beforeEntryId = beforeEntryId,
                maxEntries = maxEntries,
            )
        }
        val path = walkSessionGraphPath(leafId, maxEntries) { entryId ->
            findStored(database, sessionId, entryId)
                ?.toEntry(json)
        }
        if (path.status != SessionGraphRangeStatus.COMPLETE &&
            startEntryId != null &&
            path.entries.none { it.entryId == startEntryId }
        ) {
            return SessionGraphRange(
                path.entries,
                hasOlder = path.entries.isNotEmpty(),
                complete = false,
                status = path.status,
            )
        }
        val selected = selectSessionGraphRange(path.entries, startEntryId)
        return selected.copy(
            complete = path.status == SessionGraphRangeStatus.COMPLETE && selected.complete,
            status = if (path.status == SessionGraphRangeStatus.COMPLETE) selected.status else path.status,
        )
    }

    /**
     * Walks toward a stable boundary while retaining only one requested page. Traversal still
     * tracks IDs for cycle detection, but never materializes the complete branch as Entries.
     */
    private fun readOlderBranchRange(
        database: SQLiteDatabase,
        sessionId: String,
        leafId: String,
        beforeEntryId: String,
        maxEntries: Int,
    ): SessionGraphRange {
        val selectedReverse = ArrayDeque<SessionGraphEntry>(maxEntries.coerceAtLeast(1))
        val visited = mutableSetOf<String>()
        var currentId: String? = leafId
        var traversed = 0
        var foundBoundary = false
        var hasOlder = false
        while (currentId != null && traversed < MAX_TRAVERSAL_ENTRIES) {
            if (!visited.add(currentId)) {
                return SessionGraphRange(
                    entries = selectedReverse.toList().asReversed(),
                    hasOlder = hasOlder,
                    complete = false,
                    status = SessionGraphRangeStatus.CYCLE_DETECTED,
                )
            }
            val entry = findStored(database, sessionId, currentId)?.toEntry(json) ?: return SessionGraphRange(
                entries = selectedReverse.toList().asReversed(),
                hasOlder = foundBoundary,
                complete = false,
                status = if (traversed == 0) SessionGraphRangeStatus.LEAF_NOT_FOUND
                else SessionGraphRangeStatus.MISSING_PARENT,
            )
            if (currentId == beforeEntryId) {
                foundBoundary = true
            } else if (foundBoundary) {
                // Traversal is newest-to-oldest. The first max ancestors after the boundary are
                // the last max entries in the root-to-boundary range.
                if (selectedReverse.size < maxEntries) selectedReverse.addLast(entry)
                else hasOlder = true
                if (selectedReverse.size == maxEntries) return SessionGraphRange(
                    selectedReverse.toList().asReversed(), hasOlder = entry.parentId != null,
                    complete = entry.parentId == null,
                    status = if (entry.parentId == null) SessionGraphRangeStatus.COMPLETE
                        else SessionGraphRangeStatus.OLDER_AVAILABLE,
                )
            }
            currentId = entry.parentId
            traversed += 1
        }
        if (!foundBoundary) {
            return SessionGraphRange(
                entries = emptyList(),
                hasOlder = false,
                complete = false,
                status = if (currentId == null) SessionGraphRangeStatus.RANGE_START_NOT_FOUND
                else SessionGraphRangeStatus.LIMIT_REACHED,
            )
        }
        if (currentId != null && traversed >= MAX_TRAVERSAL_ENTRIES) {
            return SessionGraphRange(
                entries = selectedReverse.toList().asReversed(),
                hasOlder = true,
                complete = false,
                status = SessionGraphRangeStatus.LIMIT_REACHED,
            )
        }
        return SessionGraphRange(
            entries = selectedReverse.toList().asReversed(),
            hasOlder = hasOlder,
            complete = !hasOlder,
            status = if (hasOlder) SessionGraphRangeStatus.OLDER_AVAILABLE
            else SessionGraphRangeStatus.COMPLETE,
        )
    }

    /**
     * Reads exactly the entries that were just persisted. This keeps network snapshots on the
     * persistence-before-projection path without forcing a full branch scan for a bounded batch.
     */
    @Synchronized
    fun readEntries(
        device: DeviceCredential,
        sessionId: String,
        entryIds: Collection<String>,
    ): List<SessionGraphEntry> {
        if (entryIds.isEmpty()) return emptyList()
        val database = database(device).readableDatabase
        return entryIds.map { entryId ->
            findStored(database, sessionId, entryId)
                ?.toEntry(json)
                ?: throw SessionGraphStoreException("entry_not_found")
        }
    }

    /** Reads all timing metadata for a Session; this data is never represented as a graph Entry. */
    @Synchronized
    fun readTurnTimings(device: DeviceCredential, sessionId: String): List<TurnTiming> {
        val database = database(device).readableDatabase
        return database.rawQuery(
            """
            SELECT session_id, turn_id, payload
            FROM session_turn_timings
            WHERE session_id = ?
            ORDER BY updated_at, turn_id
            """.trimIndent(),
            arrayOf(sessionId),
        ).use { cursor ->
            buildList {
                while (cursor.moveToNext()) {
                    add(decodeStoredTiming(cursor))
                }
            }
        }
    }

    /** Explicit local cache removal only; a failed synchronization must never call this. */
    @Synchronized
    fun clearSession(device: DeviceCredential, sessionId: String) {
        if (sessionId.isBlank()) return
        val database = database(device).writableDatabase
        database.beginTransaction()
        try {
            database.delete("session_entries", "session_id = ?", arrayOf(sessionId))
            database.delete("session_cursors", "session_id = ?", arrayOf(sessionId))
            database.delete("session_turn_timings", "session_id = ?", arrayOf(sessionId))
            database.delete("session_sync_progress", "session_id = ?", arrayOf(sessionId))
            database.delete("session_legacy_entries", "session_id = ?", arrayOf(sessionId))
            database.delete("codex_canonical_rebuilds", "session_id = ?", arrayOf(sessionId))
            database.delete("session_cache_epochs", "session_id = ?", arrayOf(sessionId))
            database.setTransactionSuccessful()
        } finally {
            database.endTransaction()
        }
    }

    @Synchronized
    fun latestLeaf(device: DeviceCredential, sessionId: String): String? =
        database(device).readableDatabase.rawQuery(
            """
            SELECT c.leaf_id
            FROM session_cursors c
            JOIN session_entries e
              ON e.session_id = c.session_id AND e.entry_id = c.leaf_id
            WHERE c.session_id = ?
            """.trimIndent(),
            arrayOf(sessionId),
        ).use { cursor ->
            if (cursor.moveToFirst()) cursor.getString(0) else null
        }

    /** Returns true when the old graph was archived; callers must discard its memory projection. */
    @Synchronized
    fun prepareSession(device: DeviceCredential, sessionId: String, agentKind: String?): Boolean {
        if (agentKind != "codex") return false
        val db = database(device).writableDatabase
        db.beginTransaction()
        try {
            val rebuilt = rebuildCodexGraph(db, sessionId)
            migrateCodexRows(db, sessionId)
            db.setTransactionSuccessful()
            return rebuilt
        } catch (error: IllegalArgumentException) {
            throw SessionGraphStoreException(error.message ?: "legacy_codex_shape_unknown")
        } finally {
            db.endTransaction()
        }
    }

    /** Only an explicit database upgrade can schedule this, never an ordinary sync conflict. */
    private fun rebuildCodexGraph(db: SQLiteDatabase, sessionId: String): Boolean {
        val pending = db.rawQuery(
            "SELECT canonical_format, prior_database_version FROM codex_canonical_rebuilds WHERE session_id = ? AND completed_at IS NULL",
            arrayOf(sessionId),
        ).use { cursor -> buildList { while (cursor.moveToNext()) add(cursor.getString(0) to cursor.getInt(1)) } }
        if (pending.isEmpty()) return false
        for ((format, priorVersion) in pending) {
            val archive = buildJsonObject {
                put("targetCanonicalFormat", format)
                put("priorDatabaseVersion", priorVersion)
                put("entries", archiveRows(db, "session_entries", sessionId,
                    listOf("entry_id", "parent_id", "type", "timestamp", "payload", "verified_depth", "legacy_format")))
                put("timings", archiveRows(db, "session_turn_timings", sessionId, listOf("turn_id", "payload", "updated_at")))
                put("cursor", archiveRows(db, "session_cursors", sessionId, listOf("leaf_id", "updated_at")))
                put("coverage", archiveRows(db, "session_sync_progress", sessionId, listOf("leaf_id")))
                put("legacyEntries", archiveRows(db, "session_legacy_entries", sessionId,
                    listOf("entry_id", "parent_id", "type", "timestamp", "payload")))
            }
            // Keep the exact old representation for diagnosis. Native facts, rather than these
            // parent edges, will seed the new canonical cache on the next bounded sync.
            db.execSQL(
                "UPDATE codex_canonical_rebuilds SET archive = ?, completed_at = ? WHERE session_id = ? AND canonical_format = ?",
                arrayOf<Any>(archive.toString(), System.currentTimeMillis(), sessionId, format),
            )
        }
        for (table in listOf("session_entries", "session_turn_timings", "session_cursors", "session_sync_progress")) {
            db.delete(table, "session_id = ?", arrayOf(sessionId))
        }
        return true
    }

    private fun archiveRows(db: SQLiteDatabase, table: String, sessionId: String, columns: List<String>) =
        db.query(table, columns.toTypedArray(), "session_id = ?", arrayOf(sessionId), null, null, null).use { cursor ->
            buildJsonArray {
                while (cursor.moveToNext()) add(buildJsonObject {
                    columns.forEachIndexed { index, name ->
                        put(name, when (cursor.getType(index)) {
                            android.database.Cursor.FIELD_TYPE_NULL -> JsonNull
                            android.database.Cursor.FIELD_TYPE_INTEGER -> JsonPrimitive(cursor.getLong(index))
                            android.database.Cursor.FIELD_TYPE_FLOAT -> JsonPrimitive(cursor.getDouble(index))
                            else -> JsonPrimitive(cursor.getString(index))
                        })
                    }
                })
            }
        }

    @Synchronized
    fun continuousLeaf(device: DeviceCredential, sessionId: String): String? =
        continuousLeaf(database(device).readableDatabase, sessionId)

    @Synchronized
    fun cacheEpoch(device: DeviceCredential, sessionId: String): String? = cacheEpoch(database(device).readableDatabase, sessionId)

    /** Attach persisted ownership when loading a bounded window for offline/reconnected use. */
    @Synchronized
    fun withCacheVersions(device: DeviceCredential, graph: SessionGraph): SessionGraph {
        val db = database(device).readableDatabase
        return graph.copy(cacheEpoch = cacheEpoch(db, graph.sessionId),
            entryVersions = graph.entries.keys.associateWith { storedSourceSeq(db, graph.sessionId, it) },
            timingVersions = graph.turnTimings.keys.associateWith { storedTimingSourceSeq(db, graph.sessionId, it) })
    }

    private fun cacheEpoch(db: SQLiteDatabase, sessionId: String): String? = db.rawQuery(
        "SELECT epoch FROM session_cache_epochs WHERE session_id = ?", arrayOf(sessionId),
    ).use { if (it.moveToFirst()) it.getString(0) else null }

    private fun storedSourceSeq(db: SQLiteDatabase, sessionId: String, id: String): Long = db.rawQuery(
        "SELECT source_seq FROM session_entries WHERE session_id = ? AND entry_id = ?", arrayOf(sessionId, id),
    ).use { if (it.moveToFirst()) it.getLong(0) else -1L }

    private fun storedTimingSourceSeq(db: SQLiteDatabase, sessionId: String, id: String): Long = db.rawQuery(
        "SELECT source_seq FROM session_turn_timings WHERE session_id = ? AND turn_id = ?", arrayOf(sessionId, id),
    ).use { if (it.moveToFirst()) it.getLong(0) else -1L }

    @Synchronized
    fun hasContinuousCoverage(device: DeviceCredential, sessionId: String, leafId: String?): Boolean =
        leafId != null && storedDepth(database(device).readableDatabase, sessionId, leafId) != null

    /** Strip the already cached suffix. The server resolves a common ancestor if the verified
     * frontier belongs to a sibling branch. Existence of the target alone proves nothing. */
    @Synchronized
    fun planCatchUp(device: DeviceCredential, sessionId: String, targetLeafId: String): SessionSyncGap? {
        val db = database(device).readableDatabase
        if (storedDepth(db, sessionId, targetLeafId) != null) return null
        var current = targetLeafId
        val visited = mutableSetOf<String>()
        while (true) {
            if (!visited.add(current)) throw SessionGraphStoreException("cycle_detected")
            val row = db.rawQuery(
                "SELECT parent_id FROM session_entries WHERE session_id = ? AND entry_id = ?",
                arrayOf(sessionId, current),
            ).use { if (it.moveToFirst()) Pair(true, it.getStringOrNull(0)) else Pair(false, null) }
            if (!row.first) return SessionSyncGap(continuousLeaf(db, sessionId), current)
            current = row.second ?: throw SessionGraphStoreException("coverage_inconsistent")
        }
    }

    private fun continuousLeaf(db: SQLiteDatabase, sessionId: String): String? = db.rawQuery(
        "SELECT leaf_id FROM session_sync_progress WHERE session_id = ?",
        arrayOf(sessionId),
    ).use { if (it.moveToFirst()) it.getString(0) else null }

    private fun storedParent(db: SQLiteDatabase, sessionId: String, id: String): String? = db.rawQuery(
        "SELECT parent_id FROM session_entries WHERE session_id = ? AND entry_id = ?",
        arrayOf(sessionId, id),
    ).use { if (it.moveToFirst()) it.getStringOrNull(0) else null }

    private fun storedDepth(db: SQLiteDatabase, sessionId: String, id: String): Int? = db.rawQuery(
        "SELECT verified_depth FROM session_entries WHERE session_id = ? AND entry_id = ?",
        arrayOf(sessionId, id),
    ).use { if (it.moveToFirst() && !it.isNull(0)) it.getInt(0) else null }

    private fun isAncestor(db: SQLiteDatabase, sessionId: String, ancestor: String, leaf: String): Boolean {
        var current: String? = leaf
        val visited = mutableSetOf<String>()
        while (current != null && visited.add(current)) {
            if (current == ancestor) return true
            current = storedParent(db, sessionId, current)
        }
        return false
    }

    /** Called in the writer transaction. Filling a hole also verifies the previously stored
     * suffix, without decoding its payloads or trusting the response's complete/cursor fields. */
    private fun promoteCoverage(db: SQLiteDatabase, sessionId: String, ids: Collection<String>, leafId: String?) {
        val queue = ArrayDeque(ids)
        var candidate: String? = null
        var candidateDepth = -1
        while (queue.isNotEmpty()) {
            val id = queue.removeFirst()
            if (storedDepth(db, sessionId, id) != null) continue
            val parent = storedParent(db, sessionId, id)
            val depth = if (parent == null) 0 else (storedDepth(db, sessionId, parent) ?: continue) + 1
            db.execSQL(
                "UPDATE session_entries SET verified_depth = ? WHERE session_id = ? AND entry_id = ?",
                arrayOf(depth, sessionId, id),
            )
            if (depth > candidateDepth) { candidate = id; candidateDepth = depth }
            db.rawQuery(
                "SELECT entry_id FROM session_entries WHERE session_id = ? AND parent_id = ? AND verified_depth IS NULL",
                arrayOf(sessionId, id),
            ).use { while (it.moveToNext()) queue.addLast(it.getString(0)) }
        }
        if (leafId != null && storedDepth(db, sessionId, leafId) != null &&
            (candidate == null || isAncestor(db, sessionId, candidate, leafId))) candidate = leafId
        val next = candidate ?: return
        val previous = continuousLeaf(db, sessionId)
        // Old history and overlap cannot move a frontier back along its own parent chain.
        if (previous != null && isAncestor(db, sessionId, next, previous)) return
        db.execSQL(
            "INSERT OR REPLACE INTO session_sync_progress(session_id, leaf_id) VALUES (?, ?)",
            arrayOf(sessionId, next),
        )
    }

    private fun migrateCodexRows(db: SQLiteDatabase, sessionId: String) {
        val ids = db.rawQuery(
            "SELECT entry_id FROM session_entries WHERE session_id = ? AND legacy_format = 1",
            arrayOf(sessionId),
        ).use { buildList { while (it.moveToNext()) add(it.getString(0)) } }
        for (id in ids) {
            val old = find(db, sessionId, id) ?: throw SessionGraphStoreException("legacy_codex_shape_unknown")
            val converted = migrateLegacyCodexEntry(old)
            db.execSQL(
                """INSERT INTO session_legacy_entries(session_id, entry_id, parent_id, type, timestamp, payload)
                   SELECT session_id, entry_id, parent_id, type, timestamp, payload FROM session_entries
                   WHERE session_id = ? AND entry_id = ?""",
                arrayOf(sessionId, id),
            )
            db.execSQL(
                "UPDATE session_entries SET timestamp = ?, payload = ?, legacy_format = 0 WHERE session_id = ? AND entry_id = ?",
                arrayOf(converted.timestamp, json.encodeToString(converted.data), sessionId, id),
            )
        }
    }

    /**
     * First user message text from the persisted Session graph, or null if the Session has no
     * local cache or no user message yet. The read is bounded by [MAX_TITLE_SCAN_ENTRIES] so a
     * very long branch does not stall the sidebar; the prefix is enough to surface the user's
     * opening sentence even when the leaf has moved far past it.
     */
    @Synchronized
    fun firstUserMessageTitle(
        device: DeviceCredential,
        sessionId: String,
        json: Json = Json { ignoreUnknownKeys = true },
    ): String? {
        if (sessionId.isBlank()) return null
        val leaf = latestLeaf(device, sessionId) ?: return null
        val range = readBranch(
            device = device,
            sessionId = sessionId,
            leafId = leaf,
            maxEntries = MAX_TITLE_SCAN_ENTRIES,
        )
        if (range.entries.isEmpty()) return null
        return firstUserMessageTitle(projectSessionEntries(range.entries, json))
    }

    @Synchronized
    fun contains(device: DeviceCredential, sessionId: String, entryId: String): Boolean =
        database(device).readableDatabase.rawQuery(
            "SELECT 1 FROM session_entries WHERE session_id = ? AND entry_id = ? LIMIT 1",
            arrayOf(sessionId, entryId),
        ).use { it.moveToFirst() }

    @Synchronized
    fun close() {
        databases.values.forEach(GraphDatabase::close)
        databases.clear()
    }

    @Synchronized
    fun clear() {
        close()
        directory.listFiles()?.forEach(File::delete)
    }

    private fun database(device: DeviceCredential): GraphDatabase {
        directory.mkdirs()
        val identity = cacheIdentity(device)
        return databases.getOrPut(identity) {
            GraphDatabase(appContext, File(directory, "$identity.db").path)
        }
    }

    private fun find(
        database: SQLiteDatabase,
        sessionId: String,
        entryId: String,
    ): SessionGraphEntry? = findStored(database, sessionId, entryId)
        ?.toEntry(json)

    private fun findStored(database: SQLiteDatabase, sessionId: String, entryId: String): StoredEntry? =
        database.rawQuery(
            """
            SELECT session_id, entry_id, parent_id, type, timestamp, payload
            FROM session_entries
            WHERE session_id = ? AND entry_id = ?
            """.trimIndent(),
            arrayOf(sessionId, entryId),
        ).use { cursor ->
            if (!cursor.moveToFirst()) return@use null
            StoredEntry(
                sessionId = cursor.getString(0),
                entryId = cursor.getString(1),
                parentId = cursor.getStringOrNull(2),
                type = cursor.getString(3),
                timestamp = cursor.getString(4),
                payload = cursor.getString(5),
            )
        }

    private fun validateTurnTiming(timing: TurnTiming) {
        require(timing.turnId.isNotBlank()) { "turn_id_required" }
        require(timing.startedAt >= 0L) { "turn_started_at_invalid" }
        require(timing.durationMs == null || timing.durationMs >= 0L) { "turn_duration_invalid" }
    }

    private fun decodeStoredTiming(cursor: android.database.Cursor): TurnTiming =
        json.decodeFromString(cursor.getString(2))

    private fun findStoredTiming(
        database: SQLiteDatabase,
        sessionId: String,
        turnId: String,
    ): TurnTiming? = database.rawQuery(
        "SELECT session_id, turn_id, payload FROM session_turn_timings WHERE session_id = ? AND turn_id = ?",
        arrayOf(sessionId, turnId),
    ).use { cursor ->
        if (!cursor.moveToFirst()) null else json.decodeFromString(cursor.getString(2))
    }

    private fun cacheIdentity(device: DeviceCredential): String = sha256(
        listOf(device.relayUrl, device.deviceId).joinToString("\u0000"),
    )

    private fun sha256(value: String): String = MessageDigest.getInstance("SHA-256")
        .digest(value.toByteArray(Charsets.UTF_8))
        .joinToString("") { byte -> "%02x".format(byte) }

    private data class StoredEntry(
        val sessionId: String,
        val entryId: String,
        val parentId: String?,
        val type: String,
        val timestamp: String,
        val payload: String,
    ) {
        fun toEntry(json: Json): SessionGraphEntry? = runCatching {
            SessionGraphEntry(
                entryId = entryId,
                parentId = parentId,
                type = type,
                timestamp = timestamp,
                data = json.decodeFromString<JsonObject>(payload),
            )
        }.getOrNull()
    }

    private inner class GraphDatabase(
        context: Context,
        name: String,
    ) : SQLiteOpenHelper(context, name, null, DATABASE_VERSION) {
        override fun onCreate(database: SQLiteDatabase) {
            database.execSQL(
                """
                CREATE TABLE session_entries(
                    session_id TEXT NOT NULL,
                    entry_id TEXT NOT NULL,
                    parent_id TEXT,
                    type TEXT NOT NULL,
                    timestamp TEXT NOT NULL,
                    payload TEXT NOT NULL,
                    verified_depth INTEGER,
                    legacy_format INTEGER NOT NULL DEFAULT 0,
                    source_seq INTEGER NOT NULL DEFAULT -1,
                    PRIMARY KEY(session_id, entry_id)
                )
                """.trimIndent(),
            )
            database.execSQL(
                "CREATE INDEX idx_session_entries_parent ON session_entries(session_id, parent_id)",
            )
            database.execSQL(
                """
                CREATE TABLE session_cursors(
                    session_id TEXT PRIMARY KEY,
                    leaf_id TEXT NOT NULL,
                    updated_at INTEGER NOT NULL
                )
                """.trimIndent(),
            )
            database.execSQL(
                """
                CREATE TABLE session_turn_timings(
                    session_id TEXT NOT NULL,
                    turn_id TEXT NOT NULL,
                    payload TEXT NOT NULL,
                    updated_at INTEGER NOT NULL,
                    source_seq INTEGER NOT NULL DEFAULT -1,
                    PRIMARY KEY(session_id, turn_id)
                )
                """.trimIndent(),
            )
            createCoverageTables(database)
            createCodexRebuildTable(database)
            upgradeCodexRebuildTable(database)
            createCacheEpochTable(database)
        }

        override fun onUpgrade(database: SQLiteDatabase, oldVersion: Int, newVersion: Int) {
            if (oldVersion < 2) {
                database.execSQL(
                    """
                    CREATE TABLE IF NOT EXISTS session_cursors(
                        session_id TEXT PRIMARY KEY,
                        leaf_id TEXT NOT NULL,
                        updated_at INTEGER NOT NULL
                    )
                    """.trimIndent(),
                )
            }
            if (oldVersion < 3) {
                database.execSQL(
                    """
                    CREATE TABLE IF NOT EXISTS session_turn_timings(
                        session_id TEXT NOT NULL,
                        turn_id TEXT NOT NULL,
                        payload TEXT NOT NULL,
                        updated_at INTEGER NOT NULL,
                        PRIMARY KEY(session_id, turn_id)
                    )
                    """.trimIndent(),
                )
            }
            if (oldVersion < 4) {
                database.execSQL("ALTER TABLE session_entries ADD COLUMN verified_depth INTEGER")
                database.execSQL("ALTER TABLE session_entries ADD COLUMN legacy_format INTEGER NOT NULL DEFAULT 1")
                createCoverageTables(database)
                val roots = database.rawQuery(
                    "SELECT session_id, entry_id FROM session_entries WHERE parent_id IS NULL", null,
                ).use { buildList { while (it.moveToNext()) add(it.getString(0) to it.getString(1)) } }
                roots.groupBy({ it.first }, { it.second }).forEach { (session, ids) ->
                    promoteCoverage(database, session, ids, null)
                }
            }
            if (oldVersion < 5) {
                createCodexRebuildTable(database)
                // The database did not persist agent kind. Register existing Sessions as
                // candidates, then rebuild only those classified as Codex by prepareSession.
                database.execSQL("""INSERT INTO codex_canonical_rebuilds(session_id, prior_database_version)
                    SELECT session_id, ? FROM session_entries
                    UNION SELECT session_id, ? FROM session_turn_timings
                    UNION SELECT session_id, ? FROM session_cursors
                    UNION SELECT session_id, ? FROM session_sync_progress
                    UNION SELECT session_id, ? FROM session_legacy_entries""",
                    arrayOf(oldVersion, oldVersion, oldVersion, oldVersion, oldVersion))
            }
            if (oldVersion < 6) {
                upgradeCodexRebuildTable(database)
                // Resume used synthesized item IDs even after the v5 order migration.
                // Keep every earlier archive and schedule a separate, explicit format rebuild.
                database.execSQL("""INSERT INTO codex_canonical_rebuilds(session_id, canonical_format, prior_database_version)
                    SELECT session_id, 'codex-native-item-ids-v2', ? FROM session_entries
                    UNION SELECT session_id, 'codex-native-item-ids-v2', ? FROM session_turn_timings
                    UNION SELECT session_id, 'codex-native-item-ids-v2', ? FROM session_cursors
                    UNION SELECT session_id, 'codex-native-item-ids-v2', ? FROM session_sync_progress
                    UNION SELECT session_id, 'codex-native-item-ids-v2', ? FROM session_legacy_entries
                    UNION SELECT session_id, 'codex-native-item-ids-v2', ? FROM codex_canonical_rebuilds WHERE completed_at IS NULL""",
                    arrayOf(oldVersion, oldVersion, oldVersion, oldVersion, oldVersion, oldVersion))
            }
            if (oldVersion < 7) {
                database.execSQL("ALTER TABLE session_entries ADD COLUMN source_seq INTEGER NOT NULL DEFAULT -1")
                database.execSQL("ALTER TABLE session_turn_timings ADD COLUMN source_seq INTEGER NOT NULL DEFAULT -1")
                createCacheEpochTable(database)
            }
        }

        private fun createCacheEpochTable(database: SQLiteDatabase) {
            database.execSQL("CREATE TABLE session_cache_epochs(session_id TEXT PRIMARY KEY, epoch TEXT NOT NULL)")
        }

        private fun upgradeCodexRebuildTable(database: SQLiteDatabase) {
            database.execSQL("ALTER TABLE codex_canonical_rebuilds RENAME TO codex_canonical_rebuilds_v5")
            database.execSQL("""CREATE TABLE codex_canonical_rebuilds(
                session_id TEXT NOT NULL, canonical_format TEXT NOT NULL,
                prior_database_version INTEGER NOT NULL, archive TEXT, completed_at INTEGER,
                PRIMARY KEY(session_id, canonical_format))""")
            database.execSQL("""INSERT INTO codex_canonical_rebuilds
                SELECT session_id, 'codex-native-item-order-v1', prior_database_version, archive, completed_at
                FROM codex_canonical_rebuilds_v5""")
            database.execSQL("DROP TABLE codex_canonical_rebuilds_v5")
        }

        private fun createCodexRebuildTable(database: SQLiteDatabase) {
            database.execSQL("""CREATE TABLE codex_canonical_rebuilds(
                session_id TEXT PRIMARY KEY, prior_database_version INTEGER NOT NULL,
                archive TEXT, completed_at INTEGER)""")
        }

        private fun createCoverageTables(database: SQLiteDatabase) {
            database.execSQL("CREATE TABLE session_sync_progress(session_id TEXT PRIMARY KEY, leaf_id TEXT NOT NULL)")
            database.execSQL("""CREATE TABLE session_legacy_entries(
                session_id TEXT NOT NULL, entry_id TEXT NOT NULL, parent_id TEXT,
                type TEXT NOT NULL, timestamp TEXT NOT NULL, payload TEXT NOT NULL,
                PRIMARY KEY(session_id, entry_id))""")
        }
    }

    private companion object {
        const val DATABASE_VERSION = 7
        const val DEFAULT_MAX_ENTRIES = 2_000
        const val MAX_TRAVERSAL_ENTRIES = 100_000
        const val MAX_TITLE_SCAN_ENTRIES = 2_000
    }
}

private fun android.database.Cursor.getStringOrNull(index: Int): String? =
    if (isNull(index)) null else getString(index)
