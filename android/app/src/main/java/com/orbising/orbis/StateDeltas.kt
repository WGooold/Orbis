package com.orbising.orbis

import kotlinx.serialization.json.*

/** FT-G06: reconstruct privately; a missing baseline requests a full read before any projection. */
internal object StateDeltas {
    fun expand(message: JsonObject, snapshot: AgentStateSnapshotView?): JsonObject? = runCatching {
        val rows = message["domains"] as? JsonArray ?: error("domains")
        val expanded = rows.mapNotNull { element ->
            val row = element.jsonObject
            val delta = row["delta"] as? JsonObject ?: return@mapNotNull row
            require(message["stateFormat"]?.jsonPrimitive?.content == "compact-v2")
            val old = snapshot?.takeIf { it.modelEpoch == message["modelEpoch"]?.jsonPrimitive?.content && it.stateFormat == "compact-v2" }
                ?.domains?.get(row["domain"]?.jsonPrimitive?.content) ?: error("baseline")
            val revision = row["revision"]!!.jsonPrimitive.long
            if (revision <= old.revision) return@mapNotNull null
            require(delta["baseRevision"]?.jsonPrimitive?.long == old.revision)
            val source = row["source"]?.jsonObject ?: error("source")
            require(listOf("producer", "sourceId", "sourceEpoch").all { source[it] == old.source?.get(it) })
            val edits = delta["operations"]!!.jsonArray
            require(edits.size in 1..256)
            val value = applyEdits(old.value ?: JsonNull, edits)
            require(value.toString().toByteArray(Charsets.UTF_8).size <= 4 * 1024 * 1024)
            JsonObject(row - "delta" + ("value" to value))
        }
        JsonObject(message + ("domains" to JsonArray(expanded)))
    }.getOrNull()

    fun applyEdits(root: JsonElement, edits: JsonArray): JsonElement {
        require(edits.size in 1..256)
        var value = root
        for (entry in edits) value = apply(value, entry.jsonObject)
        return value
    }

    private fun apply(root: JsonElement, edit: JsonObject): JsonElement {
        val path = edit["path"]!!.jsonArray.map { it.jsonPrimitive.content }
        require(path.size <= 32)
        val op = edit["op"]!!.jsonPrimitive.content
        fun change(value: JsonElement, depth: Int): JsonElement {
            if (depth == path.size) return when (op) {
                "set" -> edit["value"] ?: error("value")
                "append" -> { require(value is JsonPrimitive && value.isString); JsonPrimitive(value.content + edit["text"]!!.jsonPrimitive.content) }
                "splice" -> {
                    val items = value.jsonArray.toMutableList()
                    val index = edit["index"]!!.jsonPrimitive.int
                    val count = edit["deleteCount"]!!.jsonPrimitive.int
                    require(index in 0..items.size && count >= 0 && count <= items.size - index)
                    repeat(count) { items.removeAt(index) }; items.addAll(index, edit["items"]!!.jsonArray); JsonArray(items)
                }
                else -> error("operation")
            }
            val key = path[depth]
            return when (value) {
                is JsonObject -> {
                    val next = value.toMutableMap()
                    if (depth == path.lastIndex && op == "remove") { require(next.containsKey(key)); next.remove(key) }
                    else if (depth == path.lastIndex && op == "set") next[key] = edit["value"] ?: error("value")
                    else next[key] = change(next[key] ?: error("path"), depth + 1)
                    JsonObject(next)
                }
                is JsonArray -> {
                    val index = key.toInt(); require(key == index.toString() && index in value.indices)
                    JsonArray(value.toMutableList().apply { this[index] = change(this[index], depth + 1) })
                }
                else -> error("path")
            }
        }
        return change(root, 0)
    }
}
