package com.orbising.orbis

import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class CatalogViewReadsTest {
    private val json = Json { encodeDefaults = true; ignoreUnknownKeys = true }
    private class Clock(var time: Long = 0)
    private fun page(request: JsonObject, ids: List<String>, offset: Int = 0, next: String? = "next", total: Int = 2,
                     error: String? = null) = buildJsonObject {
        put("type", "session.catalog.page"); put("requestId", request["requestId"]!!); put("format", "v1"); put("query", request["query"]!!)
        put("page", buildJsonObject {
            put("modelEpoch", "epoch"); put("revision", 1); put("snapshotId", "snapshot"); put("offset", offset); put("totalSessions", total)
            put("sessions", JsonArray(ids.map { buildJsonObject { put("sessionId", it); put("agentKind", "pi") } }))
            put("nextCursor", next?.let(::JsonPrimitive) ?: JsonNull); put("complete", true); put("truncated", false)
            error?.let { put("error", it) }
        })
        put("directoryCount", 1); put("providers", buildJsonArray { add("outside-first-page") }); put("unknownProvider", false); put("providersTruncated", false)
        put("previewsComplete", true)
    }
    private fun enable(loader: CatalogViewReads, sent: List<JsonObject>) {
        loader.connect()
        assertTrue(loader.consume(buildJsonObject { put("type", "session.catalog.capabilities"); put("requestId", sent.last()["requestId"]!!); put("format", "v1") }))
    }

    // SC-01/04: opening and scrolling own demand; a response alone must not download the
    // rest, and neither a closed view nor a replaced query may accept a delayed page.
    @Test fun `pages require visible demand and retain exact query ownership`() {
        val sent = mutableListOf<JsonObject>(); val applied = mutableListOf<CatalogQueryResult>()
        val loader = CatalogViewReads({ sent += it; true }, { result, _ -> applied += result })
        enable(loader, sent); assertEquals(1, sent.size)
        loader.setView(CatalogQuery(text = "needle")); val first = sent.last()
        loader.consume(page(first, listOf("one"))); assertEquals(2, sent.size)
        assertEquals(listOf("outside-first-page"), applied.last().providers)
        loader.needMore(); val second = sent.last(); assertEquals("next", second["cursor"]?.jsonPrimitive?.content)
        loader.needMore(); assertEquals(3, sent.size)
        loader.setView(null); loader.consume(page(second, listOf("two"), 1, null))
        assertEquals(listOf("one"), applied.last().sessions.map { it.sessionId })
        loader.setView(CatalogQuery(text = "different")); assertEquals(JsonNull, sent.last()["cursor"])
        loader.consume(page(first, listOf("late"))); assertEquals(listOf("one"), applied.last().sessions.map { it.sessionId })
    }

    // SC-06: retransmission reuses every fixed parameter and the original 45s deadline.
    @Test fun `one retry and timeout never create fresh page demand`() {
        val clock = Clock(); val sent = mutableListOf<JsonObject>(); var result: CatalogQueryResult? = null
        val loader = CatalogViewReads({ sent += it; true }, { value, _ -> result = value }, { clock.time })
        enable(loader, sent); loader.setView(CatalogQuery()); val request = sent.last()
        clock.time = 20_000; loader.tick(); assertEquals(2, sent.size)
        clock.time = 25_000; loader.tick(); assertEquals(request, sent.last()); assertEquals(3, sent.size)
        clock.time = 45_000; loader.tick(); assertEquals("timeout", result?.error)
        clock.time = 90_000; loader.tick(); loader.needMore(); assertEquals(3, sent.size)
        loader.retryFailed(); assertEquals(4, sent.size)
    }

    @Test fun `changed snapshot recovers once and invalid inventories never commit`() {
        val sent = mutableListOf<JsonObject>(); val applied = mutableListOf<CatalogQueryResult>()
        val loader = CatalogViewReads({ sent += it; true }, { value, _ -> applied += value })
        enable(loader, sent); loader.setView(CatalogQuery())
        loader.consume(page(sent.last(), emptyList(), error = "snapshot_changed")); assertEquals(3, sent.size)
        loader.consume(page(sent.last(), emptyList(), error = "snapshot_changed")); assertEquals(3, sent.size)
        assertEquals("snapshot_changed", applied.last().error)
        loader.retryFailed(); loader.consume(page(sent.last(), listOf("one")))
        loader.needMore(); loader.consume(page(sent.last(), listOf("one"), 1, null))
        assertEquals("invalid_page", applied.last().error)
        assertEquals(listOf("one"), applied.last().sessions.map { it.sessionId })
    }

    @Test fun `a rejected capability keeps the legacy path available without querying`() {
        val sent = mutableListOf<JsonObject>()
        val loader = CatalogViewReads({ sent += it; true }, { _, _ -> fail("unexpected query result") })
        loader.connect(); loader.setView(CatalogQuery(text = "global"))
        loader.consume(buildJsonObject { put("type", "protocol.error"); put("requestId", sent.last()["requestId"]!!); put("code", "unsupported") })
        loader.needMore(); assertFalse(loader.supported); assertEquals(1, sent.size)
    }

    // Continuations reuse first-page metadata; source confirmation alone must not replay it.
    @Test fun `continuations reuse facets and same version confirmation preserves pages`() {
        val sent = mutableListOf<JsonObject>(); var result: CatalogQueryResult? = null
        val loader = CatalogViewReads({ sent += it; true }, { value, _ -> result = value })
        enable(loader, sent); loader.setView(CatalogQuery()); loader.consume(page(sent.last(), listOf("one")))
        loader.sourceChanged("epoch", 1); assertEquals(2, sent.size)
        loader.needMore()
        val second = JsonObject(page(sent.last(), listOf("two"), 1, null).filterKeys { it !in setOf("providers", "unknownProvider", "providersTruncated") })
        loader.consume(second); loader.needMore()
        assertEquals(3, sent.size); assertEquals(listOf("one", "two"), result?.sessions?.map { it.sessionId })
        assertEquals(listOf("outside-first-page"), result?.providers)
        loader.sourceChanged("epoch", 2); assertEquals(4, sent.size); assertEquals(JsonNull, sent.last()["cursor"])
    }
}
