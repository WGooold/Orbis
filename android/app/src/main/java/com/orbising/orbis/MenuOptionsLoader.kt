package com.orbising.orbis

import java.util.UUID
import kotlinx.serialization.json.*

/** FT-G05: one visible selector owns a fixed catalog read. Closed selectors'
 * late pages cannot replace the next selector; only a complete inventory commits. */
internal class MenuOptionsLoader {
    private data class Read(val runtimeId: String, val name: String, val catalog: MenuOptionCatalog,
        val requestId: String, val items: List<RuntimeSlashCommandOption> = emptyList(), val cursors: Set<String> = emptySet(), val bytes: Int = 0)
    data class Result(val runtimeId: String, val name: String, val catalogId: String,
        val options: List<RuntimeSlashCommandOption>? = null, val next: JsonObject? = null, val error: String? = null)
    private var read: Read? = null
    @Synchronized fun cancel() { read = null }
    @Synchronized fun expire(requestId: String): Boolean {
        if (read?.requestId != requestId) return false
        read = null; return true
    }
    @Synchronized fun start(runtimeId: String, command: RuntimeSlashCommand): JsonObject? {
        val catalog = command.argument?.optionCatalog ?: return null
        if (command.argument.options.size == catalog.count) return null
        if (catalog.count !in 0..100_000 || catalog.id.isBlank()) return null
        if (read?.let { it.runtimeId == runtimeId && it.name == command.name && it.catalog == catalog } == true) return null
        val next = Read(runtimeId, command.name, catalog, UUID.randomUUID().toString())
        read = next
        return request(next, null)
    }
    private fun request(read: Read, cursor: String?): JsonObject = buildJsonObject {
        put("type", "agent.menu.options.read"); put("protocolVersion", PROTOCOL_VERSION); put("requestId", read.requestId)
        put("runtimeId", read.runtimeId); put("commandName", read.name); put("catalogId", read.catalog.id)
        put("cursor", cursor?.let(::JsonPrimitive) ?: JsonNull)
    }
    @Synchronized fun consume(message: JsonObject, json: Json): Result? {
        val current = read ?: return null
        fun string(key: String) = (message[key] as? JsonPrimitive)?.contentOrNull
        if (string("requestId") != current.requestId || string("runtimeId") != current.runtimeId ||
            string("commandName") != current.name || string("catalogId") != current.catalog.id) return null
        val base = Result(current.runtimeId, current.name, current.catalog.id)
        return try {
            string("error")?.let { error(it) }
            require(message["totalCount"]?.jsonPrimitive?.intOrNull == current.catalog.count)
            val page = json.decodeFromJsonElement<List<RuntimeSlashCommandOption>>(message["options"] ?: error("missing_options"))
            require(page.size <= 200)
            val total = current.bytes + message.toString().toByteArray(Charsets.UTF_8).size
            require(total <= 16 * 1024 * 1024)
            val items = current.items + page
            require(items.size <= current.catalog.count)
            val cursor = string("nextCursor")
            if (cursor != null) {
                require(page.isNotEmpty() && cursor !in current.cursors && items.size < current.catalog.count)
                val next = current.copy(items = items, cursors = current.cursors + cursor, bytes = total, requestId = UUID.randomUUID().toString())
                read = next; base.copy(next = request(next, cursor))
            } else {
                require(items.size == current.catalog.count)
                read = null; base.copy(options = items)
            }
        } catch (failure: Exception) { read = null; base.copy(error = failure.message ?: "invalid_options") }
    }
}
