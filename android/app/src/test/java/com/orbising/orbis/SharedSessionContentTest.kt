package com.orbising.orbis

import java.io.File
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/** FT-G07: the same wire fixture as Host/iOS must reconstruct exact bodies;
 * missing applied bases, changed sources and invalid references require recovery. */
class SharedSessionContentTest {
    private fun fixture(): JsonObject {
        val root = generateSequence(File(System.getProperty("user.dir"))) { it.parentFile }
            .first { File(it, "ios/Orbis/Tests/Fixtures/field-transport-session.json").isFile }
        return Json.parseToJsonElement(File(root, "ios/Orbis/Tests/Fixtures/field-transport-session.json").readText()).jsonObject
    }
    @Test fun `shared bodies and Unicode stream append match the complete event exactly`() {
        val f = fixture(); val codec = SharedSessionContent()
        val initial = codec.expand(f.getValue("wireInitial").jsonObject, null, -1)!!
        assertEquals(f["initial"], initial)
        assertNull(codec.expand(f.getValue("wirePatch").jsonObject, "source", 1))
        codec.remember(initial, "source", 1)
        assertEquals(f["patch"], codec.expand(f.getValue("wirePatch").jsonObject, "source", 1))
        assertNull(codec.expand(f.getValue("wirePatch").jsonObject, "source", 2))
        assertNull(codec.expand(f.getValue("wirePatch").jsonObject, "replacement", 1))
        codec.clear(); assertNull(codec.expand(f.getValue("wirePatch").jsonObject, "source", 1))
    }
    @Test fun `invalid references do not modify the received event`() {
        val wire = fixture().getValue("wireInitial").jsonObject
        val shared = wire.getValue("sharedContent").jsonObject
        val invalid = JsonObject(wire + ("sharedContent" to JsonObject(shared + ("references" to JsonArray(listOf(
            buildJsonObject { put("path", JsonArray(listOf(JsonPrimitive("missing")))); put("target", JsonArray(listOf(JsonPrimitive("missing")))) }
        ))))))
        assertNull(SharedSessionContent().expand(invalid, null, -1))
        assertEquals("", wire["event"]!!.jsonObject["live"]!!.jsonObject["messages"]!!.jsonArray[0].jsonObject["message"]!!.jsonObject["content"]!!.jsonArray[0].jsonObject["text"]!!.jsonPrimitive.content)
    }
}
