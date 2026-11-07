package com.orbising.orbis

import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/** FT-G05: page correlation, complete-only apply, cancellation, stale catalogs,
 * repeated cursors and missing page items must never silently select a wrong node. */
class MenuOptionsLoaderTest {
    private val json = Json { ignoreUnknownKeys = true }
    private fun command() = RuntimeSlashCommand("tree", source = "builtin", argument = RuntimeSlashCommandArgument("tree", true,
        optionCatalog = MenuOptionCatalog("catalog", 2)))
    private fun page(request: JsonObject, values: List<String>, cursor: String? = null, error: String? = null) = buildJsonObject {
        put("type", "agent.menu.options.page"); put("requestId", request["requestId"]!!)
        put("runtimeId", request["runtimeId"]!!); put("commandName", request["commandName"]!!); put("catalogId", request["catalogId"]!!)
        put("totalCount", 2); put("nextCursor", cursor?.let(::JsonPrimitive) ?: JsonNull)
        put("options", buildJsonArray { values.forEach { value -> add(buildJsonObject { put("value", value); put("label", value) }) } })
        error?.let { put("error", it) }
    }
    @Test fun `only complete matching catalog is applied and cached options avoid a reread`() {
        val loader = MenuOptionsLoader(); val first = loader.start("runtime", command())!!
        val part = loader.consume(page(first, listOf("exact-1"), "next"), json)!!
        assertNull(part.options); assertNotNull(part.next)
        assertNull(loader.consume(page(first, listOf("late")), json))
        val done = loader.consume(page(part.next!!, listOf("exact-2")), json)!!
        assertEquals(listOf("exact-1", "exact-2"), done.options!!.map { it.value })
        val cached = command().let { it.copy(argument = it.argument!!.copy(options = done.options)) }
        assertNull(loader.start("runtime", cached))
    }
    @Test fun `closing or timing out a selector rejects its late pages`() {
        val loader = MenuOptionsLoader(); val first = loader.start("runtime", command())!!
        loader.cancel(); assertNull(loader.consume(page(first, listOf("exact-1", "exact-2")), json))
        val next = loader.start("another-runtime", command())!!
        assertNull(loader.consume(page(first, listOf("exact-1", "exact-2")), json))
        assertTrue(loader.expire(next["requestId"]!!.jsonPrimitive.content))
        assertNull(loader.consume(page(next, listOf("exact-1", "exact-2")), json))
    }
    @Test fun `incomplete and changed catalogs fail explicitly rather than partially applying`() {
        val loader = MenuOptionsLoader(); val first = loader.start("runtime", command())!!
        assertNotNull(loader.consume(page(first, listOf("one")), json)!!.error)
        val second = loader.start("runtime", command())!!
        assertEquals("catalog_changed", loader.consume(page(second, emptyList(), error = "catalog_changed"), json)!!.error)
    }
}
