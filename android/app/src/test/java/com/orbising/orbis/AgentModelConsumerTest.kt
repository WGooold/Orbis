package com.orbising.orbis

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

    @Test fun `compaction activity drives presentation without changing execution phase`() {
        var state = receive(initial(), domain("execution", """{"phase":"idle","compaction":{"phase":"running"}}"""))
        var runtime = state.runtimes.getValue("runtime")
        assertEquals("idle", runtime.status)
        assertEquals("compacting", runtime.presentationStatus)
        state = receive(state, domain("execution", """{"phase":"running","compaction":{"phase":"running"}}""", 2))
        runtime = state.runtimes.getValue("runtime")
        assertEquals("running", runtime.status)
        assertEquals("compacting", runtime.presentationStatus)
        assertEquals("compacting", RuntimeSummary("runtime", "Agent", "/repo", "idle", "session").carryingComposerStatus(runtime).presentationStatus)
        assertNull(RuntimeSummary("runtime", "Agent", "/repo", "idle", "other").carryingComposerStatus(runtime).compactionPhase)
        state = receive(state, domain("execution", """{"phase":"waiting_local_interaction","compaction":{"phase":"running"}}""", 3))
        assertEquals("waiting_local_interaction", state.runtimes.getValue("runtime").presentationStatus)
        state = receive(state, domain("execution", """{"phase":"running","compaction":{"phase":"idle"}}""", 4))
        assertEquals("running", state.runtimes.getValue("runtime").presentationStatus)
        state = receive(state, domain("execution", """{"phase":"idle","compaction":{"phase":"failed"}}""", 5))
        assertEquals("failed", state.runtimes.getValue("runtime").compactionPhase)
        assertEquals("idle", state.runtimes.getValue("runtime").presentationStatus)
        state = receive(state, domain("execution", """{"phase":"running","compaction":{"phase":"running"}}""", 6))
        state = receive(state, domain("execution", """{"phase":"idle","compaction":"unavailable"}""", 7))
        assertNull(state.runtimes.getValue("runtime").compactionPhase)
        assertEquals("idle", state.runtimes.getValue("runtime").presentationStatus)
        state = receive(state, domain("execution", """{"phase":"running","compaction":{"phase":"running"}}""", 8))
        state = receive(state, domain("execution", "null", 9, availability = "unknown"))
        assertNull(state.runtimes.getValue("runtime").compactionPhase)
        assertEquals("unknown", state.runtimes.getValue("runtime").presentationStatus)
    }

    @Test fun `home waits for every card and identity updates the persistent catalog projection`() {
        val cached = SessionCatalogEntry("session", cwd = "/old", agentKind = "pi", archived = true,
            hasHistoryCache = true, messageCount = 12, modifiedAt = 100)
        var state = initial().copy(sessions = mapOf("session" to cached))
        assertTrue(state.homeRuntimesLoading)
        assertTrue(state.homeRuntimes.isEmpty())
        state = receive(state, domain("identity", """{"runtimeId":"runtime","sessionId":"session","name":"Agent","cwd":"/repo","status":"idle","agentKind":"pi"}"""))
        assertEquals("/repo", state.sessions.getValue("session").cwd)
        assertEquals("pi", state.sessions.getValue("session").agentKind)
        assertEquals(12, state.sessions.getValue("session").messageCount)
        assertTrue(state.sessions.getValue("session").archived == true)
        state = receive(state, domain("execution", """{"phase":"running"}"""))
        assertTrue(state.homeRuntimes.isEmpty())
        state = receive(state, domain("interactions", "{}"))
        assertFalse(state.homeRuntimesLoading)
        assertEquals("running", state.homeRuntimes.single().status)
        val next = RuntimeSummary("second", "Second", "/repo", "unknown", "other")
        val loading = state.copy(runtimes = state.runtimes + (next.runtimeId to next))
        assertTrue(loading.homeRuntimes.isEmpty())
        assertTrue(next.carryingComposerStatus(state.runtimes.getValue("runtime")).domainAvailability.isEmpty())
        assertEquals(1, loading.copy(runtimes = state.runtimes).homeRuntimes.size)
        assertTrue(RemoteState(connection = RelayConnection.CONNECTING).homeRuntimesLoading)
        assertFalse(RemoteState(connection = RelayConnection.OFFLINE).homeRuntimesLoading)
        val failed = reducer.reduce(initial(), """{"type":"agent.state.snapshot","scope":"agent","requestId":"read",
            "runtimeId":"runtime","sessionId":"session","agentKind":"pi","error":"读取失败"}""", channel = "ctl")
        assertEquals("读取失败", failed.homeRuntimesError)
        assertTrue(failed.homeRuntimes.isEmpty())
    }

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

    @Test fun `new session receives execution on ctl before model on msg and keeps accepting the subscription`() {
        val pending = initial().copy(runtimes = initial().runtimes.mapValues { (_, runtime) -> runtime.copy(status = "unknown") })
        val running = receive(pending, domain("execution", """{"phase":"running"}""", revision = 2))
        assertEquals("running", running.runtimes.getValue("runtime").status)
        assertTrue(running.agentStateRequests.isEmpty())
        val model = reducer.reduce(running, snapshot(domain("model", """{"provider":"p","id":"m"}""")), channel = "msg")
        assertEquals("running", model.runtimes.getValue("runtime").status)
        assertEquals("m", model.runtimes.getValue("runtime").model?.id)
        val idle = receive(model, domain("execution", """{"phase":"idle"}""", revision = 3))
        val stale = reducer.reduce(idle, snapshot(domain("execution", "null", revision = 1, availability = "unknown")), channel = "msg")
        assertEquals("idle", stale.runtimes.getValue("runtime").status)
        assertEquals(setOf("execution", "model"), stale.agentStateSnapshots.values.single().domains.keys)
        assertTrue("read" in stale.agentStateReads)
        assertNull(stale.error)
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

    private fun reconnectWithHostRead(): RemoteState {
        val attached = RemoteState(hostId = "host", e2eReady = true, agentModelEpoch = "epoch")
            .withModelFixture("backends", """{"agents":["pi","codexDesktop"],"launchableAgents":["pi","codexDesktop"],
                "codexDesktop":{"state":"attached","reason":"已接入 Codex 桌面版 app-server"}}""", scope = "host")
        val offline = reducer.reduce(attached, """{"type":"host.offline","hostId":"host"}""")
        assertNull(offline.codexDesktop)
        assertNotNull(offline.agentStateSnapshots["host||"]?.domains?.get("backends"))
        val ready = reducer.reduce(offline, """{"type":"device.ready","protocolVersion":$PROTOCOL_VERSION,
            "deviceId":"device","modelEpoch":"epoch","runtimes":[{"runtimeId":"desktop","name":"Codex 桌面版",
            "cwd":"/repo","status":"idle","sessionId":"session","agentKind":"codexDesktop"}]}""", channel = "ctl")
        return ready.copy(agentStateRequests = setOf("host-read"), agentStateReads = mapOf("host-read" to
            AgentStateRead("host||", "host", setOf("backends"))))
    }

    private fun unchangedHost(requestId: String = "host-read", epoch: String = "epoch", domains: String = "\"backends\"") = """{
        "type":"agent.state.snapshot","protocolVersion":$PROTOCOL_VERSION,"requestId":"$requestId",
        "scope":"host","modelEpoch":"$epoch","domains":[],"missing":[],"truncated":false,"unchanged":[$domains]}"""

    @Test fun `unchanged backends restores desktop attachment after same Host reconnect`() {
        val ready = reconnectWithHostRead()
        assertNull(ready.codexDesktop)
        val restored = reducer.reduce(ready, unchangedHost(), channel = "msg")
        assertEquals("attached", restored.codexDesktop?.state)
        assertEquals("已接入 Codex 桌面版 app-server", restored.codexDesktop?.reason)
        assertEquals("已接入", codexDesktopText(restored.codexDesktop))
        assertEquals(setOf("pi", "codexDesktop"), restored.supportedAgents)
        assertEquals(setOf("pi", "codexDesktop"), restored.launchableAgents)
        assertEquals(ready.agentStateSnapshots["host||"]?.domains?.get("backends"),
            restored.agentStateSnapshots["host||"]?.domains?.get("backends"))
    }

    @Test fun `unchanged does not restore attachment from unregistered reads old epochs or unrelated domains`() {
        val ready = reconnectWithHostRead()
        for (payload in listOf(unchangedHost(requestId = "previous-read"), unchangedHost(epoch = "previous-epoch"),
            unchangedHost(domains = "\"providers\""), unchangedHost(domains = ""))) {
            assertNull(reducer.reduce(ready, payload, channel = "msg").codexDesktop)
        }
        val fresh = reducer.reduce(ready, """{"type":"device.ready","protocolVersion":$PROTOCOL_VERSION,
            "deviceId":"device","modelEpoch":"fresh","runtimes":[]}""", channel = "ctl")
            .copy(agentStateRequests = setOf("host-read"), agentStateReads = ready.agentStateReads)
        assertNull(reducer.reduce(fresh, unchangedHost(epoch = "fresh"), channel = "msg").codexDesktop)
    }

    @Test fun `late unchanged confirmation uses the latest accepted backend version`() {
        val ready = reconnectWithHostRead()
        val closed = ready.withModelFixture("backends", """{"agents":["pi"],"launchableAgents":["pi","codexDesktop"],
            "codexDesktop":{"state":"closed","reason":"Codex 桌面版已关闭"}}""", revision = 2, scope = "host")
        val late = reducer.reduce(closed, unchangedHost(), channel = "msg")
        assertEquals("closed", late.codexDesktop?.state)
        assertEquals(setOf("pi"), late.supportedAgents)
    }

    @Test fun `unchanged agent domains restore same-session fields cleared while Host was offline`() {
        val first = receive(initial(), listOf(domain("execution", """{"phase":"running"}"""),
            domain("model", """{"provider":"p","id":"m","name":"Current model"}""")).joinToString(","))
        val offline = reducer.reduce(first, """{"type":"host.offline","hostId":"host"}""")
        val ready = reducer.reduce(offline, """{"type":"device.ready","protocolVersion":$PROTOCOL_VERSION,
            "deviceId":"device","modelEpoch":"epoch","runtimes":[{"runtimeId":"runtime","name":"Agent",
            "cwd":"/repo","status":"running","sessionId":"session","agentKind":"pi"}]}""", channel = "ctl")
            .copy(agentStateRequests = initial().agentStateRequests, agentStateReads = initial().agentStateReads)
        assertNull(ready.runtimes.getValue("runtime").model)
        val restored = reducer.reduce(ready, """{"type":"agent.state.snapshot","protocolVersion":$PROTOCOL_VERSION,
            "requestId":"read","scope":"agent","runtimeId":"runtime","agentKind":"pi","sessionId":"session",
            "modelEpoch":"epoch","domains":[],"missing":[],"truncated":false,"unchanged":["execution","model"]}""", channel = "msg")
        assertEquals("running", restored.runtimes.getValue("runtime").status)
        assertEquals("m", restored.runtimes.getValue("runtime").model?.id)
    }
}
