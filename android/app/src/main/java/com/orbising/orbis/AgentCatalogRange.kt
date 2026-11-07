package com.orbising.orbis

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull

/** Fixed catalog version, accumulated independently from the committed first-window value. */
data class AgentCatalogRange(
    val modelEpoch: String,
    val revision: Long,
    val snapshotId: String,
    val value: JsonObject,
    val sessions: List<SessionCatalogEntry>,
    val nextCursor: String?,
    val totalSessions: Int,
    val complete: Boolean,
    val truncated: Boolean,
    val seenCursors: Set<String> = emptySet(),
    val error: String? = null,
)

data class AgentCatalogRangeRequest(
    val requestId: String,
    val cursor: String,
    val modelEpoch: String,
    val revision: Long,
    val snapshotId: String,
    val offset: Int,
    val sentAt: Long = System.currentTimeMillis(),
)

internal fun RemoteState.beginCatalogRange(domain: AgentStateDomainView, json: Json): RemoteState {
    if (domain.availability != "ready") return copy(agentCatalogRange = null, agentCatalogRangeRequest = null)
    val value = domain.value as? JsonObject ?: return this
    val snapshotId = value.text("snapshotId") ?: return copy(agentCatalogRange = null, agentCatalogRangeRequest = null)
    val rows = value["sessions"] as? JsonArray ?: return this
    val sessions = runCatching { json.decodeFromJsonElement<List<SessionCatalogEntry>>(rows) }.getOrNull() ?: return this
    val total = value["totalSessions"]?.jsonPrimitive?.intOrNull ?: sessions.size
    val cursor = value.text("nextCursor")
    val old = agentCatalogRange
    if (old?.modelEpoch == domain.modelEpoch && old.revision == domain.revision && old.snapshotId == snapshotId)
        return this
    return copy(agentCatalogRange = AgentCatalogRange(domain.modelEpoch, domain.revision, snapshotId, value, sessions,
        cursor, total, domain.completeness == "complete", value["truncated"]?.jsonPrimitive?.booleanOrNull == true),
        agentCatalogRangeRequest = null)
}

internal fun RemoteState.withAgentCatalogRangePage(message: JsonObject, json: Json): RemoteState {
    val pending = agentCatalogRangeRequest ?: return this
    if (message.text("requestId") != pending.requestId || message.text("scope") != "host" || message.text("domain") != "catalog") return this
    val range = agentCatalogRange ?: return copy(agentCatalogRangeRequest = null)
    if (range.modelEpoch != pending.modelEpoch || range.revision != pending.revision || range.snapshotId != pending.snapshotId ||
        range.nextCursor != pending.cursor || range.sessions.size != pending.offset) return copy(agentCatalogRangeRequest = null)
    val cleared = copy(agentCatalogRangeRequest = null)
    fun rejected(reason: String) = cleared.copy(agentCatalogRange = range.copy(nextCursor = null, error = reason))
    val page = message["page"] as? JsonObject ?: return rejected("invalid_page")
    page.text("error")?.let { return rejected(it) }
    if (page.text("modelEpoch") != pending.modelEpoch || page["revision"]?.jsonPrimitive?.longOrNull != pending.revision ||
        page.text("snapshotId") != pending.snapshotId || page["offset"]?.jsonPrimitive?.intOrNull != pending.offset ||
        page["totalSessions"]?.jsonPrimitive?.intOrNull != range.totalSessions || agentModelEpoch != pending.modelEpoch)
        return rejected("snapshot_changed")
    val rows = page["sessions"] as? JsonArray ?: return rejected("invalid_page")
    val entries = runCatching { json.decodeFromJsonElement<List<SessionCatalogEntry>>(rows) }.getOrNull()
        ?: return rejected("invalid_page")
    val next = page.text("nextCursor")
    val complete = page["complete"]?.jsonPrimitive?.booleanOrNull ?: return rejected("invalid_page")
    val truncated = page["truncated"]?.jsonPrimitive?.booleanOrNull ?: return rejected("invalid_page")
    val combined = range.sessions + entries
    if (entries.size > 200 || combined.size > range.totalSessions || combined.map { it.sessionId }.distinct().size != combined.size ||
        next != null && (entries.isEmpty() || next == pending.cursor || next in range.seenCursors) ||
        next == null && !truncated && combined.size != range.totalSessions)
        return rejected("invalid_page")
    val updated = range.copy(sessions = combined, nextCursor = next, complete = complete,
        truncated = truncated, seenCursors = range.seenCursors + pending.cursor)
    val value = JsonObject(range.value + mapOf("sessions" to JsonArray(combined.map {
        json.encodeToJsonElement(SessionCatalogEntry.serializer(), it)
    }), "nextCursor" to (next?.let(::JsonPrimitive) ?: JsonNull), "truncated" to JsonPrimitive(truncated)))
    val domain = AgentStateDomainView("catalog", range.modelEpoch, range.revision, "ready",
        if (complete) "complete" else "partial", 0, value, projectionComplete = true)
    return cleared.copy(agentCatalogRange = updated).applyHostDomainProjection(mapOf("catalog" to domain), json)
}

private fun JsonObject.text(key: String): String? = (get(key) as? JsonPrimitive)?.contentOrNull

@kotlinx.serialization.Serializable
data class CatalogQuery(val text: String = "", val agentKind: String? = null, val archived: Boolean = false, val provider: String = "all", val directory: String? = null)

internal fun catalogDirectoryId(path: String): String = java.security.MessageDigest.getInstance("SHA-256")
    .digest(path.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }

data class CatalogQueryResult(
    val query: CatalogQuery, val modelEpoch: String, val revision: Long, val snapshotId: String,
    val sessions: List<SessionCatalogEntry>, val totalSessions: Int, val directoryCount: Int,
    val nextCursor: String?, val complete: Boolean, val truncated: Boolean,
    val providers: List<String>, val unknownProvider: Boolean, val providersTruncated: Boolean,
    val previewsComplete: Boolean = false,
    val directoryTotals: Map<String, Int> = emptyMap(),
    val loading: Boolean = false, val error: String? = null,
)

/** One visible query owns its immutable cursor, retries and late responses. IO ticks never
 * create demand; only a view change, source invalidation or viewport request can do that. */
internal class CatalogViewReads(
    private val send: (JsonObject) -> Boolean,
    private val publish: (CatalogQueryResult, List<SessionCatalogEntry>) -> Unit,
    private val now: () -> Long = System::currentTimeMillis,
    private val json: Json = Json { ignoreUnknownKeys = true; encodeDefaults = true },
) {
    private data class Read(val id: String, val query: CatalogQuery, val cursor: String?, val started: Long, var retried: Boolean = false)
    private var capability: Pair<String, Long>? = null
    var supported = false; private set
    private var visible = false
    private var query: CatalogQuery? = null
    private var result: CatalogQueryResult? = null
    private var read: Read? = null
    private var recoveries = 0
    private var cursors = mutableSetOf<String>()

    @Synchronized fun connect() {
        supported = false; read = null
        if (result?.error != null) result = null
        val id = java.util.UUID.randomUUID().toString(); capability = id to now()
        send(kotlinx.serialization.json.buildJsonObject {
            put("type", JsonPrimitive("session.catalog.capabilities.request")); put("protocolVersion", JsonPrimitive(PROTOCOL_VERSION)); put("requestId", JsonPrimitive(id))
        })
    }
    @Synchronized fun setView(value: CatalogQuery?) {
        visible = value != null
        if (value == null) {
            read = null
            result?.takeIf { it.loading }?.let { result = it.copy(loading = false); publish(result!!, emptyList()) }
            return
        }
        if (query != value) { query = value; result = null; read = null; cursors.clear(); recoveries = 0 }
        if (result == null) needMore()
    }
    @Synchronized fun retryFailed() {
        if (result?.error == null) return
        result = null; read = null; cursors.clear(); recoveries = 0
        if (visible) needMore()
    }
    @Synchronized fun sourceChanged(epoch: String?, revision: Long?) {
        val old = result ?: return
        if (epoch == null || revision == null || old.modelEpoch == epoch && revision <= old.revision) return
        result = null; read = null; cursors.clear()
        if (visible) needMore()
    }
    @Synchronized fun needMore() {
        val target = query ?: return
        if (!visible || !supported || read != null || result?.error != null || result != null && result?.nextCursor == null) return
        val pending = Read(java.util.UUID.randomUUID().toString(), target, result?.nextCursor, now())
        read = pending
        result?.let { result = it.copy(loading = true); publish(result!!, emptyList()) }
        if (!send(body(pending))) fail("send_failed")
    }
    private fun body(read: Read) = kotlinx.serialization.json.buildJsonObject {
        put("type", JsonPrimitive("session.catalog.query")); put("protocolVersion", JsonPrimitive(PROTOCOL_VERSION))
        put("requestId", JsonPrimitive(read.id)); put("format", JsonPrimitive("v1")); put("query", json.encodeToJsonElement(CatalogQuery.serializer(), read.query))
        put("cursor", read.cursor?.let(::JsonPrimitive) ?: JsonNull); put("limit", JsonPrimitive(100))
    }
    @Synchronized fun tick() {
        val time = now()
        if (capability?.let { time - it.second >= 20_000 } == true) capability = null
        val pending = read ?: return
        if (time - pending.started >= 45_000) { fail("timeout"); return }
        if (!pending.retried && time - pending.started >= 25_000) {
            pending.retried = true
            if (!send(body(pending))) fail("send_failed")
        }
    }
    @Synchronized fun consume(message: JsonObject): Boolean {
        val id = message.text("requestId") ?: return false
        if (id == capability?.first) {
            supported = message.text("type") == "session.catalog.capabilities" && message.text("format") == "v1"
            capability = null
            if (supported && visible) needMore()
            return true
        }
        if (message.text("type") == "session.catalog.page" && id != read?.id) return true
        val pending = read?.takeIf { it.id == id } ?: return false
        if (!visible || pending.query != query) { read = null; return true }
        if (message.text("type") != "session.catalog.page") { fail(message.text("code") ?: "query_failed"); return true }
        val page = message["page"] as? JsonObject ?: run { fail("invalid_page"); return true }
        val error = page.text("error")
        if (error != null) {
            if (error == "snapshot_changed" && recoveries++ == 0) {
                read = null; result = null; cursors.clear(); needMore()
            } else fail(error)
            return true
        }
        val receivedQuery = runCatching { json.decodeFromJsonElement<CatalogQuery>(message["query"]!!) }.getOrNull()
        val rows = runCatching { json.decodeFromJsonElement<List<SessionCatalogEntry>>(page["sessions"]!!) }.getOrNull()
        val epoch = page.text("modelEpoch"); val revision = page["revision"]?.jsonPrimitive?.longOrNull
        val snapshot = page.text("snapshotId"); val offset = page["offset"]?.jsonPrimitive?.intOrNull
        val total = page["totalSessions"]?.jsonPrimitive?.intOrNull
        val next = page.text("nextCursor"); val old = result
        val combined = (old?.sessions ?: emptyList()) + (rows ?: emptyList())
        val valid = message.text("format") == "v1" && receivedQuery == pending.query && !epoch.isNullOrEmpty() && revision != null && revision >= 0 && !snapshot.isNullOrEmpty() &&
            total != null && offset == (old?.sessions?.size ?: 0) && rows != null && rows.size <= 100 &&
            combined.size <= total && combined.map { it.agentKind to it.sessionId }.distinct().size == combined.size &&
            (old == null || old.modelEpoch == epoch && old.revision == revision && old.snapshotId == snapshot && old.totalSessions == total) &&
            (next == null || rows.isNotEmpty() && next != pending.cursor && next !in cursors) &&
            (next != null || page["truncated"]?.jsonPrimitive?.booleanOrNull == true || combined.size == total)
        if (!valid) { fail("invalid_page"); return true }
        val complete = page["complete"]?.jsonPrimitive?.booleanOrNull
        val truncated = page["truncated"]?.jsonPrimitive?.booleanOrNull
        val directories = message["directoryCount"]?.jsonPrimitive?.intOrNull
        val providers = runCatching { json.decodeFromJsonElement<List<String>>(message["providers"]!!) }.getOrNull() ?: old?.providers
        val unknown = message["unknownProvider"]?.jsonPrimitive?.booleanOrNull ?: old?.unknownProvider
        val limited = message["providersTruncated"]?.jsonPrimitive?.booleanOrNull ?: old?.providersTruncated
        val previews = message["previewsComplete"]?.jsonPrimitive?.booleanOrNull
        if (complete == null || truncated == null || directories == null || providers == null || unknown == null || limited == null || previews == null) {
            fail("invalid_page"); return true
        }
        pending.cursor?.let(cursors::add); read = null
        val totals = old?.directoryTotals.orEmpty() + (page["sessions"] as? JsonArray).orEmpty().mapNotNull { row ->
            val value = row as? JsonObject ?: return@mapNotNull null
            val count = value["directoryTotal"]?.jsonPrimitive?.intOrNull?.takeIf { it >= 0 } ?: return@mapNotNull null
            value.text("cwd")?.let { it to count }
        }
        result = CatalogQueryResult(pending.query, epoch!!, revision!!, snapshot!!, combined, total!!, directories,
            next, complete, truncated, providers, unknown, limited, previewsComplete = previews, directoryTotals = totals)
        publish(result!!, rows!!)
        return true
    }
    private fun fail(error: String) {
        val pending = read ?: return
        read = null
        val old = result ?: CatalogQueryResult(pending.query, "", 0, "", emptyList(), 0, 0, null, false, true, emptyList(), false, false)
        result = old.copy(loading = false, error = error); publish(result!!, emptyList())
    }
}
