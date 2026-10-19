package dev.pi.remote

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import org.junit.Assert.*
import org.junit.Test

class AgentModelConsumerTest {
    private val reducer = RelayReducer()
    private fun initial() = RemoteState(hostId = "host", agentModelEpoch = "epoch",
        runtimes = mapOf("runtime" to RuntimeSummary("runtime", "Agent", "/repo", "idle", "session", agentKind = "pi")),
        agentStateRequests = setOf("read"), agentStateReads = mapOf("read" to AgentStateRead(
            "agent|pi|session", "agent", AGENT_MODEL_DOMAINS.toSet(), "runtime", "session", "pi")))

    private fun domain(name: String, value: String, revision: Int = 1, availability: String = "ready",
        completeness: String = "complete", projectionComplete: Boolean = true) = """{
        "domain":"$name","modelEpoch":"epoch","revision":$revision,"availability":"$availability",
        "completeness":"$completeness","checkedAt":100,"projectionComplete":$projectionComplete,"value":$value} """

    private fun snapshot(domains: String, requestId: String = "read", epoch: String = "epoch") = """{
        "type":"agent.state.snapshot","protocolVersion":$PROTOCOL_VERSION,"requestId":"$requestId",
        "scope":"agent","runtimeId":"runtime","agentKind":"pi","sessionId":"session","modelEpoch":"$epoch",
        "domains":[$domains],"missing":[],"truncated":false} """

    private fun receive(state: RemoteState, domains: String) = reducer.reduce(state, snapshot(domains), channel = "ctl")
    private fun interaction(id: String = "question") = """{"requestId":"$id","extensionId":"extension","kind":"select",
        "title":"Choose","expiresAt":9007199254740991,"options":[{"value":"yes","label":"Yes"}]}"""

    @Test fun `current model drives execution model context permissions and complete capability options`() {
        val state = receive(initial(), listOf(
            domain("execution", """{"phase":"waiting_local_interaction","waitingFor":["question"],"retry":"unavailable","compaction":"unavailable"}"""),
            domain("model", """{"provider":"provider","id":"model","name":"Visible model","thinkingLevel":"high"}"""),
            domain("context", """{"tokens":100,"contextWindow":1000,"percent":10.0}"""),
            domain("permissions", """{"management":{"summary":"Host policy","details":"Opaque facts","tone":"restricted","settings":[]}}"""),
            domain("capabilities", """{"model":{"name":"model","source":"builtin","argument":{"kind":"select","required":true,"options":[{"value":"opaque","label":"Choice"}]}}}"""),
        ).joinToString(","))
        val runtime = state.runtimes.getValue("runtime")
        assertEquals("waiting_local_interaction", runtime.status)
        assertEquals("Visible model", runtime.model?.displayName)
        assertEquals("high", runtime.thinkingLevel)
        assertEquals(10.0, runtime.contextUsage?.percent)
        assertEquals("Host policy", runtime.permissionManagement?.summary)
        assertNull(runtime.permissions)
        assertEquals("opaque", state.capabilities.getValue("runtime").commands.single().argument?.options?.single()?.value)
    }

    @Test fun `each domain rejects old versions without deleting unrelated baselines`() {
        val first = receive(initial(), domain("model", """{"provider":"p","id":"new"}""", revision = 3))
        val other = receive(first, domain("context", """{"tokens":20,"contextWindow":100,"percent":20.0}"""))
        val late = receive(other, domain("model", """{"provider":"p","id":"old"}""", revision = 2))
        val duplicateConflict = receive(late, domain("model", """{"provider":"p","id":"conflict"}""", revision = 3))
        assertEquals("new", duplicateConflict.runtimes.getValue("runtime").model?.id)
        assertEquals(setOf("model", "context"), duplicateConflict.agentStateSnapshots.values.single().domains.keys)
        assertEquals(20L, duplicateConflict.runtimes.getValue("runtime").contextUsage?.tokens)
    }

    @Test fun `subscription accepts updates after its first response but ignores unknown request and epoch`() {
        val first = receive(initial(), domain("execution", """{"phase":"running"}"""))
        assertTrue(first.agentStateRequests.isEmpty())
        assertTrue("read" in first.agentStateReads)
        val updated = receive(first, domain("execution", """{"phase":"idle"}""", revision = 2))
        assertEquals("idle", updated.runtimes.getValue("runtime").status)
        assertEquals(updated, reducer.reduce(updated, snapshot(domain("execution", """{"phase":"running"}""", 3), requestId = "old"), channel = "ctl"))
        assertEquals(updated, reducer.reduce(updated, snapshot(domain("execution", """{"phase":"running"}""", 3), epoch = "old"), channel = "ctl"))
        assertEquals(updated, reducer.reduce(updated, snapshot(domain("execution", """{"phase":"running"}""", 3))))
    }

    @Test fun `complete Host projection ends a request even when native coverage remains partial`() {
        val restored = receive(initial(), domain("interactions", """{"question":${interaction()}}""", completeness = "partial"))
        assertEquals("yes", restored.conversations.getValue("runtime").interactions.getValue("question").options.single().value)
        val local = restored.copy(pendingCommands = mapOf("answer" to "runtime"), conversations = restored.conversations.mapValues { (_, conversation) ->
            conversation.copy(interactions = conversation.interactions.mapValues { (_, request) -> request.copy(responseCommandId = "answer", submitted = true) })
        })
        val unknown = receive(local, domain("interactions", "{}", revision = 2, availability = "unknown", completeness = "unknown"))
        assertTrue(unknown.conversations.getValue("runtime").interactions.getValue("question").submitted)
        val ended = receive(unknown, domain("interactions", "{}", revision = 3, completeness = "partial"))
        assertTrue(ended.conversations.getValue("runtime").interactions.isEmpty())
        assertTrue(ended.pendingCommands.isEmpty())
        val stale = receive(ended, domain("interactions", """{"question":${interaction()}}""", revision = 1, completeness = "partial"))
        assertTrue(stale.conversations.getValue("runtime").interactions.isEmpty())
    }

    @Test fun `partial source inventory cannot delete without a complete Host projection`() {
        val first = receive(initial(), domain("interactions", """{"question":${interaction()}}"""))
        val partial = receive(first, domain("interactions", "{}", revision = 2, completeness = "partial", projectionComplete = false))
        assertEquals(setOf("question"), partial.conversations.getValue("runtime").interactions.keys)
    }

    @Test fun `queue delivery and cancellation are restored as facts instead of inferred from message text`() {
        val first = receive(initial(), domain("delivery", """{"queue":{"queueId":"queue","text":"hello","delivery":"steer","state":"accepted"}}"""))
        val cancelled = receive(first, domain("delivery", """{"queue":{"queueId":"queue","text":"hello","delivery":"steer","state":"cancelled"}}""", 2))
        assertEquals("cancelled", cancelled.conversations.getValue("runtime").queuedMessages.getValue("queue").state)
        val delivered = receive(cancelled, domain("delivery", """{"queue":{"queueId":"queue","text":"hello","delivery":"steer","state":"delivered"}}""", 3))
        assertTrue(delivered.conversations.getValue("runtime").queuedMessages.isEmpty())
        assertEquals(setOf("queue"), delivered.conversations.getValue("runtime").deliveredQueueIds)
    }

    @Test fun `command success is a device receipt and does not remove the shared interaction inventory`() {
        val first = receive(initial(), domain("interactions", """{"question":${interaction()}}"""))
        val pending = first.copy(conversations = first.conversations.mapValues { (_, conversation) -> conversation.copy(
            interactions = conversation.interactions.mapValues { (_, request) -> request.copy(responseCommandId = "answer") }) })
        val replied = reducer.reduce(pending, """{"type":"runtime.event","runtimeId":"runtime","sequence":1,
            "event":{"type":"command.result","commandId":"answer","ok":true,"status":"success"}}""")
        assertTrue(replied.conversations.getValue("runtime").interactions.getValue("question").submitted)
        assertNull(replied.conversations.getValue("runtime").interactions.getValue("question").responseCommandId)
    }

    @Test fun `old native lifecycle frames cannot write model domains or rebuild chat state`() {
        var state = initial()
        for ((index, type) in MODEL_OWNED_LEGACY_EVENTS.withIndex()) {
            state = reducer.reduce(state, """{"type":"runtime.event","runtimeId":"runtime","sequence":${index + 1},"event":{"type":"$type"}}""")
        }
        assertEquals(initial().runtimes, state.runtimes)
        assertTrue(state.conversations.isEmpty())
        assertTrue(state.capabilities.isEmpty())
        assertNull(state.error)
    }

    @Test fun `new authenticated model epoch clears old business facts and rejects old subscriptions`() {
        val first = receive(initial(), domain("model", """{"provider":"p","id":"old"}"""))
        val ready = reducer.reduce(first, """{"type":"device.ready","protocolVersion":$PROTOCOL_VERSION,"deviceId":"device",
            "modelEpoch":"new","notificationEpoch":null,"runtimes":[{"runtimeId":"runtime","name":"Agent","cwd":"/repo","status":"running","sessionId":"session"}]}""", channel = "ctl")
        assertEquals("new", ready.agentModelEpoch)
        assertTrue(ready.agentStateReads.isEmpty())
        assertTrue(ready.agentStateSnapshots.isEmpty())
        assertNull(ready.runtimes.getValue("runtime").model)
        assertEquals("unknown", ready.runtimes.getValue("runtime").status)
        assertEquals(ready, reducer.reduce(ready, snapshot(domain("model", """{"provider":"p","id":"old"}""", 9)), channel = "ctl"))
    }
}
