package com.orbising.orbis

import kotlinx.serialization.json.*

/** FT-G07: wire cache is usable only at the actually applied source position. */
internal class SharedSessionContent {
    private data class Live(val session: String, val epoch: String, val seq: Long, val value: JsonObject, val bytes: Int)
    private val live = linkedMapOf<String, Live>()
    fun clear() { live.clear() }
    fun expand(envelope: JsonObject, epoch: String?, seq: Long): JsonObject? = runCatching {
        val shared = envelope["sharedContent"] as? JsonObject ?: return@runCatching envelope
        require(shared["format"]?.jsonPrimitive?.content == "shared-v1")
        var event = envelope["event"]!!.jsonObject
        require(event["type"]?.jsonPrimitive?.content in setOf("session.patch", "session.snapshot"))
        shared["liveDelta"]?.jsonObject?.let { delta ->
            val source = event["source"]!!.jsonObject
            val cached = live[envelope["runtimeId"]!!.jsonPrimitive.content] ?: error("missing_live")
            require(event["type"]?.jsonPrimitive?.content == "session.patch" && cached.epoch == epoch && cached.seq == seq &&
                event["sessionId"]?.jsonPrimitive?.content == cached.session && source["epoch"]?.jsonPrimitive?.content == epoch &&
                source["ready"]?.jsonPrimitive?.boolean == true && event["baseSeq"]?.jsonPrimitive?.long == seq &&
                delta["baseRevision"]?.jsonPrimitive?.long == seq)
            event = JsonObject(event + ("live" to StateDeltas.applyEdits(cached.value, delta["operations"]!!.jsonArray)))
        }
        val references = shared["references"]!!.jsonArray
        require(references.size <= 512)
        fun at(path: JsonArray): JsonElement {
            require(path.size <= 32)
            var value: JsonElement = event
            for (part in path) {
                val key = part.jsonPrimitive.content
                value = if (value is JsonArray) { val index = key.toInt(); require(key == index.toString()); value[index] }
                    else value.jsonObject[key] ?: error("reference")
            }
            return value
        }
        for (item in references) {
            val ref = item.jsonObject; val path = ref["path"]!!.jsonArray; val value = at(ref["target"]!!.jsonArray)
            require(value is JsonPrimitive && value.isString && value.content.isNotEmpty() && at(path) == JsonPrimitive(""))
            val edit = buildJsonObject { put("op", "set"); put("path", path); put("value", value) }
            event = StateDeltas.applyEdits(event, JsonArray(listOf(edit))).jsonObject
        }
        require(event.toString().toByteArray(Charsets.UTF_8).size <= 4 * 1024 * 1024)
        JsonObject(envelope - "sharedContent" + ("event" to event))
    }.getOrNull()

    fun remember(envelope: JsonObject, appliedEpoch: String?, appliedSeq: Long) {
        val runtime = envelope["runtimeId"]?.jsonPrimitive?.content ?: return
        val event = envelope["event"] as? JsonObject ?: return
        val source = event["source"] as? JsonObject ?: return
        val value = event["live"] as? JsonObject ?: return
        if (source["epoch"]?.jsonPrimitive?.content != appliedEpoch || source["seq"]?.jsonPrimitive?.long != appliedSeq ||
            source["ready"]?.jsonPrimitive?.boolean != true || value["complete"]?.jsonPrimitive?.boolean != true) return
        val bytes = value.toString().toByteArray(Charsets.UTF_8).size
        if (bytes > 4 * 1024 * 1024) return
        live.remove(runtime)
        live[runtime] = Live(event["sessionId"]!!.jsonPrimitive.content, appliedEpoch ?: return, appliedSeq, value, bytes)
        while (live.size > 64 || live.values.sumOf { it.bytes } > 16 * 1024 * 1024) live.remove(live.keys.first())
    }
}
