package com.orbising.orbis

import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/** FT-G06: atomic reconstruction, exact array order, explicit deletion and gap recovery boundary. */
class StateDeltasTest {
    private val json = Json
    private fun obj(value: String) = json.parseToJsonElement(value).jsonObject
    private val source = obj("""{"producer":"host","sourceId":"s","sourceEpoch":"native","sourceRevision":1}""")
    private fun baseline() = AgentStateSnapshotView("agent|pi|s", "agent", "read", "epoch", stateFormat = "compact-v2",
        domains = mapOf("interactions" to AgentStateDomainView("interactions", "epoch", 1, "ready", "complete", 1,
            obj("""{"gone":true,"items":[{"id":"a","state":"running"},{"id":"b"}]}"""), true, source)))
    private fun message(base: Int = 1, epoch: String = "epoch", edits: String = """[
        {"op":"remove","path":["gone"]},
        {"op":"set","path":["items","0","state"],"value":"success"},
        {"op":"splice","path":["items"],"index":1,"deleteCount":1,"items":[{"id":"exact"}]}]""") = obj("""{
        "stateFormat":"compact-v2","modelEpoch":"$epoch","domains":[{"domain":"interactions","revision":2,"source":$source,
        "value":null,"delta":{"baseRevision":$base,"operations":$edits}}]}""")
    @Test fun `edits reconstruct privately and duplicates do not apply twice`() {
        val old = baseline()
        val expanded = StateDeltas.expand(message(), old)!!
        assertEquals(obj("""{"items":[{"id":"a","state":"success"},{"id":"exact"}]}"""), expanded["domains"]!!.jsonArray[0].jsonObject["value"])
        assertTrue(old.domains.getValue("interactions").value!!.jsonObject.containsKey("gone"))
        val applied = old.copy(domains = old.domains.mapValues { it.value.copy(revision = 2) })
        assertEquals(0, StateDeltas.expand(message(), applied)!!["domains"]!!.jsonArray.size)
    }
    @Test fun `gaps epoch changes and invalid edits cannot partially mutate baseline`() {
        assertNull(StateDeltas.expand(message(base = 5), baseline()))
        assertNull(StateDeltas.expand(message(epoch = "other"), baseline()))
        assertNull(StateDeltas.expand(message(edits = """[{"op":"remove","path":["gone"]},{"op":"remove","path":["absent"]}]"""), baseline()))
        assertNull(StateDeltas.expand(message(), null))
    }
}
