package com.orbising.orbis

import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class ToolContentTest {
    private val agent = ToolAgent("h", "codex", "s")
    private val json = Json { encodeDefaults = true }
    private val compactJson = Json { encodeDefaults = true; explicitNulls = false }
    private fun tool(id: String = "t", order: Long = 0) = ToolSummary(tool = ToolIdentity(agent, id), toolName = "exec", phase = "running", order = order)
    private fun ref(tools: List<ToolSummary>, revision: Long = 1, seq: Long = revision) = ToolInventoryReference(1, agent,
        ToolVersion("inventory", revision), ToolSource("source", seq), tools.size, tools.sumOf { compactJson.encodeToString(it).toByteArray().size.toLong() })
    private fun start(replica: ToolInventoryReplica, reference: ToolInventoryReference): ToolInventoryReplica {
        val next = replica.require(reference)
        return next.opened(next.requestId!!, ToolInventorySnapshot("snapshot-${reference.version.revision}", agent, reference.version, reference.source, reference.totalCount))
    }
    private fun page(replica: ToolInventoryReplica, tools: List<ToolSummary>, cursor: String? = null) = ToolInventoryPage(
        replica.requestId!!, "r", replica.snapshot!!, replica.incoming.size, replica.incoming.size + tools.size, tools, cursor)

    @Test fun `partial inventory retains old confirmed tools and only exact complete baseline replaces it`() {
        val old = listOf(tool("old")); val current = listOf(tool("a"), tool("b", 1))
        var replica = start(ToolInventoryReplica(), ref(old))
        replica = replica.page(page(replica, old))
        assertTrue(replica.covers(ref(old)))
        replica = start(replica, ref(current, 2))
        replica = replica.page(page(replica, current.take(1), "next"))
        assertEquals(old, replica.tools); assertFalse(replica.covers(ref(current, 2)))
        replica = replica.page(page(replica, current.drop(1)))
        assertTrue(replica.covers(ref(current, 2))); assertEquals(current, replica.tools)
    }
    @Test fun `duplicate wrong scope order or declared byte counts fail without deleting confirmed inventory`() {
        val current = listOf(tool("a"), tool("b", 1)); val reference = ref(current)
        val replica = start(ToolInventoryReplica(tools = listOf(tool("confirmed"))), reference)
        for (bad in listOf(current.reversed(), listOf(tool("a"), tool("a", 1)), current.map { it.copy(tool = it.tool.copy(agent = agent.copy(sessionId = "other"))) })) {
            val failed = replica.page(page(replica, bad)); assertNotNull(failed.error); assertEquals(replica.tools, failed.tools)
        }
        val wrong = start(ToolInventoryReplica(), reference.copy(summaryBytes = reference.summaryBytes + 1))
        assertNotNull(wrong.page(page(wrong, current)).error)
    }
    @Test fun `buffered removal waits for baseline and does not silently substitute a newer dependency`() {
        val current = listOf(tool()); val reference = ref(current)
        var replica = start(ToolInventoryReplica(), reference)
        val patch = ToolInventoryPatch("r", agent, ToolVersion("inventory", 2), ToolSource("source", 2), 1, emptyList(), listOf("t"))
        replica = replica.patch(patch).page(page(replica, current))
        assertTrue(replica.covers(reference)); assertEquals(current, replica.tools); assertEquals(1, replica.buffered.size)
        replica = replica.copy(buffered = emptyList()).patch(patch)
        assertEquals(emptyList<ToolSummary>(), replica.tools); assertFalse(replica.covers(reference)); assertEquals(2L, replica.reference!!.version.revision)
    }
    @Test fun `retired epochs and missing patch revisions cannot mutate the confirmed inventory`() {
        val reference = ref(listOf(tool())); var replica = start(ToolInventoryReplica(), reference)
        replica = replica.page(page(replica, listOf(tool())))
        val gap = ToolInventoryPatch("r", agent, ToolVersion("inventory", 3), ToolSource("source", 3), 2, emptyList(), listOf("t"))
        assertNotNull(replica.patch(gap).error)
        val replaced = reference.copy(version = ToolVersion("new", 1), source = ToolSource("new-source", 1))
        replica = replica.require(replaced)
        assertTrue("inventory" in replica.retired)
        assertNotNull(replica.require(reference).error)
    }
    private fun view() = ToolDetailView("r", tool(), "output").request()
    private fun content(view: ToolDetailView, text: String = "中😀", epoch: String = "content", observed: Long = text.toByteArray().size.toLong()) = ToolContentPage(
        view.requestId!!, "r", view.locator, ToolReadIdentity("read", epoch, view.requestOffset + text.toByteArray().size),
        "text", "utf8-fragment", view.requestOffset, view.requestOffset + text.toByteArray().size, 0,
        view.requestOffset + text.toByteArray().size, observed, false, text, null, emptyList())
    @Test fun `UTF8 byte coordinates and fixed content identity are validated without parsing JSON fragments`() {
        val view = view(); val accepted = view.page(content(view))
        assertEquals(7L, accepted.offset); assertEquals("中😀", accepted.text); assertNull(accepted.error)
        val following = accepted.request(fresh = true)
        assertNotNull(following.page(content(following, "x", epoch = "replacement", observed = 8)).error)
        assertNotNull(view.page(content(view).copy(throughOffset = 2)).error)
        assertNotNull(view.page(content(view).copy(runtimeId = "other")).error)
        assertEquals(view, view.page(content(view).copy(requestId = "late")))
    }
    @Test fun `declared gaps cover every missing suffix and never overlap retained content`() {
        val view = view(); val base = content(view, "abc", observed = 8)
        assertNotNull(view.page(base).error)
        assertNull(view.page(base.copy(gaps = listOf(ToolGap(3, 8, "quota")))).error)
        assertNotNull(view.page(base.copy(gaps = listOf(ToolGap(2, 8, "quota")))).error)
        assertNotNull(view.page(base.copy(gaps = listOf(ToolGap(3, 9, "quota")))).error)
    }
    @Test fun `reconnect stops scheduling while retaining loaded detail text outside chat state`() {
        val detail = view().let { it.page(content(it)) }.copy(follow = true).request(fresh = true)
        val state = RemoteState(toolDetail = detail, toolInventories = mapOf("r" to ToolInventoryReplica()), pendingToolConversations = emptyMap())
        val next = state.markReconnecting()
        assertEquals(detail.text, next.toolDetail!!.text); assertFalse(next.toolDetail!!.follow); assertNull(next.toolDetail!!.requestId)
        assertTrue(next.toolInventories.isEmpty()); assertNotNull(next.toolDetail!!.error)
    }
    @Test fun `orphan historical result still presents its bounded tool summary`() {
        val summary = tool().copy(phase = "finished")
        val presentation = buildConversationPresentation(listOf(ChatMessage("result", "tool", emptyList(), 1, toolCallId = "t", toolSummary = summary)))
        assertEquals(1, presentation.messages.size); assertEquals(summary, presentation.messages[0].content.single().summary)
    }
    @Test fun `chat applied baseline waits for complete inventory while detail pages never advance it`() {
        val reducer = FixtureRelayReducer()
        val initial = RemoteState(hostId = "h", selectedRuntimeId = "r", runtimes = mapOf("r" to RuntimeSummary("r", "R", "/", "running", "s",
            sessionGraphSync = true, agentKind = "codex")), sessionGraphs = mapOf("s" to fixtureGraph("s", emptyList(), cacheEpoch = "source")),
            conversations = mapOf("r" to RuntimeConversation(sourceEpoch = "source", sourceSeq = 1, sourceReady = true, hasLiveSnapshot = true)))
        val reference = ref(listOf(tool()), seq = 2)
        val patch = """{"type":"runtime.event","runtimeId":"r","sequence":2,"event":{"type":"session.patch","sessionId":"s",
          "source":{"epoch":"source","seq":2,"ready":true},"baseSeq":1,"seq":2,"checkpointId":"source:2","head":{"leafId":null},
          "headCompleteness":"complete","live":{"complete":true,"turn":null,"messages":[],"tools":[],"toolInventory":${json.encodeToString(reference)}}}}"""
        var state = reducer.reduce(initial, patch)
        assertEquals(1L, state.conversations.getValue("r").sourceSeq)
        assertEquals(1, state.pendingToolConversations.getValue("r").size)
        val pending = state.toolInventories.getValue("r")
        val snapshot = ToolInventorySnapshot("snapshot", agent, reference.version, reference.source, 1)
        fun envelope(body: String) = """{"type":"runtime.event","runtimeId":"r","sequence":99,"event":$body}"""
        state = reducer.reduce(state, envelope("""{"type":"session.tools.opened","runtimeId":"r","requestId":"${pending.requestId}","snapshot":${json.encodeToString(snapshot)}}"""))
        val replica = state.toolInventories.getValue("r")
        val page = ToolInventoryPage(replica.requestId!!, "r", snapshot, 0, 1, listOf(tool()), null)
        state = reducer.reduce(state, envelope(json.encodeToString(page).dropLast(1) + ",\"type\":\"session.tools.page\"}"))
        assertEquals(2L, state.conversations.getValue("r").sourceSeq)
        assertTrue(state.pendingToolConversations.isEmpty())
        assertEquals("t", state.conversations.getValue("r").messages.last().content.single().toolCallId)
        val detail = view(); state = state.copy(toolDetail = detail)
        val afterDetail = reducer.reduce(state, envelope(json.encodeToString(content(detail)).dropLast(1) + ",\"type\":\"session.tool.content.page\"}"))
        assertEquals(state.conversations, afterDetail.conversations); assertEquals(state.sessionGraphs, afterDetail.sessionGraphs)
        assertEquals("中😀", afterDetail.toolDetail!!.text)
    }
}
