package dev.pi.remote

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * App 侧消费 Host 统一状态模型（ADR-0032 issue #10）。
 *
 * 这里断言的是客户端**怎么理解** Host 的应答：缺席必须有原因、坏消息不许留半份、
 * 同一身份的重复读取整份替换——而不是把「没读到」悄悄渲染成「没有」。
 */
class AgentModelStateTest {
    private val reducer = FixtureRelayReducer()

    private fun snapshot(
        domains: String = DOMAINS,
        missing: String = "[]",
        truncated: Boolean = false,
        extra: String = "",
        scope: String = "host",
        protocolVersion: Int = PROTOCOL_VERSION,
    ) = """
        {"type":"agent.state.snapshot","protocolVersion":$protocolVersion,"requestId":"req-1",
         "scope":"$scope","modelEpoch":"model-1","domains":$domains,"missing":$missing,"truncated":$truncated$extra}
    """.trimIndent()

    private fun pending() = RemoteState(agentStateRequests = setOf("req-1"))

    @Test
    fun `Host 作用域的领域连同 envelope 一起存下`() {
        val reduced = reducer.reduce(pending(), snapshot())

        val view = reduced.agentStateSnapshots.values.single()
        assertEquals("host", view.scope)
        assertEquals("model-1", view.modelEpoch)
        assertNull(view.error)
        val domain = view.domains.getValue("diagnostics")
        assertEquals(2L, domain.revision)
        assertEquals("ready", domain.availability)
        assertEquals("partial", domain.completeness)
        assertEquals(1_700_000_000_000L, domain.checkedAt)
        assertEquals("2", (domain.value as JsonObject)["records"]!!.jsonPrimitive.content)
        // 应答到达即销账，否则界面会一直以为还有一次读取在路上。
        assertTrue(reduced.agentStateRequests.isEmpty())
    }

    @Test
    fun `缺席带原因：没状态与名字不认识不是同一件事`() {
        val reduced = reducer.reduce(pending(), snapshot(missing = """[{"domain":"live","reason":"no_state"},{"domain":"nope","reason":"unknown_domain"}]"""))

        val view = reduced.agentStateSnapshots.values.single()
        assertEquals("no_state", view.missing["live"])
        assertEquals("unknown_domain", view.missing["nope"])
        assertEquals(1, view.domains.size)
    }

    @Test
    fun `被字节预算截断时如实标记，不能当基线`() {
        val reduced = reducer.reduce(pending(), snapshot(truncated = true))

        assertTrue(reduced.agentStateSnapshots.values.single().truncated)
    }

    @Test
    fun `Host 明确回错时记错误，而不是当成这个作用域什么都没有`() {
        val reduced = reducer.reduce(pending(), """
            {"type":"agent.state.snapshot","protocolVersion":$PROTOCOL_VERSION,"requestId":"req-1",
             "scope":"agent","modelEpoch":null,"domains":[],"missing":[],"truncated":false,
             "error":"这台电脑没有该会话的状态"}
        """.trimIndent())

        val view = reduced.agentStateSnapshots.values.single()
        assertEquals("agent", view.scope)
        assertEquals("这台电脑没有该会话的状态", view.error)
        assertTrue(view.domains.isEmpty())
        assertTrue(reduced.agentStateRequests.isEmpty())
    }

    @Test
    fun `领域缺 envelope 字段时整份拒绝，不留半份模型`() {
        val reduced = reducer.reduce(pending(), snapshot(
            domains = """[{"domain":"diagnostics","modelEpoch":"model-1","revision":1,"availability":"ready","completeness":"complete","value":null}]""",
        ))

        val view = reduced.agentStateSnapshots.values.single()
        assertNotNull(view.error)
        assertTrue(view.domains.isEmpty())
    }

    @Test
    fun `同一身份的新快照整份替换旧的那份`() {
        val first = reducer.reduce(pending(), snapshot(
            domains = """[{"domain":"diagnostics","modelEpoch":"m","revision":1,"availability":"ready","completeness":"complete","checkedAt":1,"value":null},
                          {"domain":"providers","modelEpoch":"m","revision":1,"availability":"ready","completeness":"partial","checkedAt":1,"value":null}]""",
        ))
        assertEquals(setOf("diagnostics", "providers"), first.agentStateSnapshots.values.single().domains.keys)

        val second = reducer.reduce(first.copy(agentStateRequests = setOf("req-1")), snapshot())

        val view = second.agentStateSnapshots.values.single()
        assertEquals(setOf("diagnostics"), view.domains.keys)
    }

    @Test
    fun `协议版本不匹配的应答仍然被拒绝`() {
        val reduced = reducer.reduce(pending(), snapshot(protocolVersion = PROTOCOL_VERSION - 1))

        assertEquals(PROTOCOL_VERSION_MISMATCH_ERROR, reduced.error)
        assertTrue(reduced.agentStateSnapshots.isEmpty())
    }


    @Test
    fun `状态页口径：还没读、电脑没报、读失败是三件不同的事`() {
        val untouched = RemoteState().diagnosticDirectoryView()
        assertEquals("尚未读取", untouched.text)
        assertEquals(StatusTone.Neutral, untouched.tone)

        val failed = reducer.reduce(pending(), """
            {"type":"agent.state.snapshot","protocolVersion":$PROTOCOL_VERSION,"requestId":"req-1",
             "scope":"host","modelEpoch":null,"domains":[],"missing":[],"truncated":false,"error":"这台电脑没有该会话的状态"}
        """.trimIndent())
        assertEquals(StatusTone.Bad, failed.diagnosticDirectoryView().tone)
        assertTrue(failed.diagnosticDirectoryView().text.startsWith("读取失败"))

        val absent = reducer.reduce(pending(), snapshot(domains = "[]", missing = """[{"domain":"diagnostics","reason":"no_state"}]"""))
        assertEquals("电脑没有报这个领域", absent.diagnosticDirectoryView().text)
        assertEquals(StatusTone.Warn, absent.diagnosticDirectoryView().tone)
    }

    @Test
    fun `目录没有缺口才画成正常，有缺口必须说出来`() {
        val clean = reducer.reduce(pending(), snapshot(domains = CLEAN_DOMAINS))
        assertEquals("2 条记录", clean.diagnosticDirectoryView().text)
        assertEquals(StatusTone.Good, clean.diagnosticDirectoryView().tone)

        // DOMAINS 里淘汰过 1 条、completeness 是 partial：读的人必须知道这不是全部历史。
        val gapped = reducer.reduce(pending(), snapshot())
        assertEquals("2 条记录（已淘汰 1 条）", gapped.diagnosticDirectoryView().text)
        assertEquals(StatusTone.Warn, gapped.diagnosticDirectoryView().tone)

        val truncated = reducer.reduce(pending(), snapshot(domains = CLEAN_DOMAINS, truncated = true))
        assertEquals("2 条记录（清单被截断）", truncated.diagnosticDirectoryView().text)
    }

    @Test
    fun `负载缺条数时明确报错，不画成 0 条`() {
        val broken = reducer.reduce(pending(), snapshot(
            domains = """[{"domain":"diagnostics","modelEpoch":"m","revision":1,"availability":"ready","completeness":"complete","checkedAt":1,"value":"not-an-object"}]""",
        ))

        val view = broken.diagnosticDirectoryView()
        assertEquals("目录格式无法识别", view.text)
        assertEquals(StatusTone.Bad, view.tone)
    }


    @Test
    fun `记录页存下最近一页，并给发出那次请求销账`() {
        val state = RemoteState(diagnosticRequest = DiagnosticRequestView("req-2", 0))
        val reduced = reducer.reduce(state, page())

        val page = reduced.diagnosticPage!!
        assertEquals(1, page.records.size)
        assertEquals("catalog", page.records.single().category)
        assertEquals("error", page.records.single().severity)
        assertNull(page.nextCursor)
        assertNull(reduced.diagnosticRequest)
    }

    @Test
    fun `不是我们那次请求的应答一律丢掉`() {
        val state = RemoteState(diagnosticRequest = DiagnosticRequestView("other", 0))

        val reduced = reducer.reduce(state, page())

        assertNull(reduced.diagnosticPage)
        assertEquals("other", reduced.diagnosticRequest?.requestId)
    }

    @Test
    fun `记录缺字段就整页拒绝，不留半页看着像真的记录`() {
        val state = RemoteState(diagnosticRequest = DiagnosticRequestView("req-2", 0))
        val broken = page(records = """[{"recordId":"r1","category":"catalog","severity":"error"}]""")

        val reduced = reducer.reduce(state, broken)

        val result = reduced.diagnosticPage!!
        assertEquals("记录缺少字段", result.error)
        assertEquals(0, result.records.size)
    }

    @Test
    fun `界面口径：没有回音要说出来，最近一条带缺口也要说`() {
        assertEquals("尚未读取", RemoteState().diagnosticRecordsView().text)

        val waiting = RemoteState(diagnosticRequest = DiagnosticRequestView("req-2", 0))
        assertEquals("读取中…", waiting.diagnosticRecordsView(now = 5_000).text)
        assertEquals("上次读取没有回音", waiting.diagnosticRecordsView(now = 60_000).text)
        assertEquals(StatusTone.Warn, waiting.diagnosticRecordsView(now = 60_000).tone)

        val loaded = reducer.reduce(waiting, page(nextCursor = "r1:9", truncated = true))
        val view = loaded.diagnosticRecordsView()
        assertEquals("catalog read failed（还有更新的没读，有缺口）", view.text)
        assertEquals("catalog", view.detail)
        assertEquals(StatusTone.Bad, view.tone)
    }

    @Test
    fun `记录为空时如实说空，不编一条`() {
        val state = RemoteState(diagnosticRequest = DiagnosticRequestView("req-2", 0))

        val reduced = reducer.reduce(state, page(records = "[]"))

        assertEquals("没有记录", reduced.diagnosticRecordsView().text)
        assertEquals(StatusTone.Neutral, reduced.diagnosticRecordsView().tone)
    }

    private fun page(
        records: String = DEFAULT_RECORD,
        nextCursor: String? = null,
        truncated: Boolean = false,
    ): String {
        val cursor = if (nextCursor == null) "null" else "\"$nextCursor\""
        return """{"type":"diagnostics.page","protocolVersion":$PROTOCOL_VERSION,"requestId":"req-2","page":{"records":$records,"nextCursor":$cursor,"truncated":$truncated}}"""
    }


    @Test
    fun `目录读全时就说读全了`() {
        val reduced = reducer.reduce(pending(), snapshot(domains = CATALOG_COMPLETE))

        val view = reduced.catalogSummaryView()
        assertEquals("12 个会话（2 个后端都读全）", view.text)
        assertEquals(StatusTone.Good, view.tone)
        assertNull(view.detail)
    }

    @Test
    fun `某个后端读取失败时说清是哪个、为什么——缺席不能显示成没有`() {
        val failed = reducer.reduce(pending(), snapshot(domains = CATALOG_PARTIAL))
        val view = failed.catalogSummaryView()

        assertEquals("12 个会话（部分）", view.text)
        assertTrue(view.detail!!.contains("codex"))
        assertTrue(view.detail!!.contains("读取失败"))
        assertEquals(StatusTone.Warn, view.tone)

        val notReady = reducer.reduce(pending(), snapshot(domains = CATALOG_NOT_READY))
        assertTrue(notReady.catalogSummaryView().detail!!.contains("未就绪"))

        val truncated = reducer.reduce(pending(), snapshot(domains = CATALOG_TRUNCATED))
        assertEquals("结果被上限截断", truncated.catalogSummaryView().detail)
    }

    @Test
    fun `还没读到目录时不装作完整`() {
        assertEquals("尚未读取", RemoteState().catalogSummaryView().text)

        val absent = reducer.reduce(pending(), snapshot(domains = "[]", missing = """[{"domain":"catalog","reason":"no_state"}]"""))
        assertEquals("电脑没有报这个领域", absent.catalogSummaryView().text)

        val broken = reducer.reduce(pending(), snapshot(
            domains = """[{"domain":"catalog","modelEpoch":"m","revision":1,"availability":"ready","completeness":"complete","checkedAt":1,"value":{"truncated":false,"backends":[]}}]""",
        ))
        assertEquals(StatusTone.Bad, broken.catalogSummaryView().tone)
        assertEquals("目录缺少总数", broken.catalogSummaryView().text)
    }


    @Test
    fun `没有切换时说的是「Host 未报告」，不是替它断言没有切换`() {
        val reduced = reducer.reduce(pending(), snapshot(domains = PROVIDERS_IDLE))

        val view = reduced.providerSwitchingView()
        assertEquals("Host 未报告进行中的切换", view.text)
        assertEquals("codex: custom、dsh: deepseek", view.detail)
        assertEquals(StatusTone.Neutral, view.tone)
    }

    @Test
    fun `切换进行中时说清是哪个后端——带外的切换手机本来看不见`() {
        val reduced = reducer.reduce(pending(), snapshot(domains = PROVIDERS_SWITCHING))

        val view = reduced.providerSwitchingView()
        assertEquals("正在切换：codex", view.text)
        assertEquals(StatusTone.Warn, view.tone)
    }

    @Test
    fun `缺席、空清单与坏负载都不含糊`() {
        assertEquals("尚未读取", RemoteState().providerSwitchingView().text)

        val absent = reducer.reduce(pending(), snapshot(domains = "[]", missing = """[{"domain":"providers","reason":"no_state"}]"""))
        assertEquals("电脑没有报这个领域", absent.providerSwitchingView().text)

        val empty = reducer.reduce(pending(), snapshot(domains = PROVIDERS_EMPTY))
        assertEquals("电脑没有报任何供应商", empty.providerSwitchingView().text)
        assertEquals(StatusTone.Warn, empty.providerSwitchingView().tone)

        val unknown = reducer.reduce(pending(), snapshot(domains = PROVIDERS_UNKNOWN))
        assertEquals("电脑尚未核对", unknown.providerSwitchingView().text)
        assertEquals(StatusTone.Warn, unknown.providerSwitchingView().tone)

        val broken = reducer.reduce(pending(), snapshot(
            domains = """[{"domain":"providers","modelEpoch":"m","revision":1,"availability":"ready","completeness":"partial","checkedAt":1,"value":{"checkedAt":1}}]""",
        ))
        assertEquals("供应商摘要缺少清单", broken.providerSwitchingView().text)
        assertEquals(StatusTone.Bad, broken.providerSwitchingView().tone)
    }

    private companion object {
        const val DOMAINS = """[{"domain":"diagnostics","modelEpoch":"model-1","revision":2,"availability":"ready","completeness":"partial","checkedAt":1700000000000,"value":{"records":2,"dropped":1}}]"""
        const val CLEAN_DOMAINS = """[{"domain":"diagnostics","modelEpoch":"model-1","revision":3,"availability":"ready","completeness":"complete","checkedAt":1700000000000,"value":{"records":2,"dropped":0,"persistFailures":0}}]"""
        const val DEFAULT_RECORD = """[{"recordId":"r1","category":"catalog","severity":"error","message":"catalog read failed","at":1700000000000}]"""
        const val CATALOG_COMPLETE = """[{"domain":"catalog","modelEpoch":"m","revision":1,"availability":"ready","completeness":"complete","checkedAt":1,"value":{"totalSessions":12,"truncated":false,"backends":[{"kind":"pi","ready":true,"sessions":10,"complete":true,"elapsedMs":5},{"kind":"codex","ready":true,"sessions":2,"complete":true,"elapsedMs":7}],"checkedAt":1}}]"""
        const val CATALOG_PARTIAL = """[{"domain":"catalog","modelEpoch":"m","revision":2,"availability":"ready","completeness":"partial","checkedAt":1,"value":{"totalSessions":12,"truncated":false,"backends":[{"kind":"pi","ready":true,"sessions":10,"complete":true,"elapsedMs":5},{"kind":"codex","ready":true,"sessions":2,"complete":false,"elapsedMs":3000,"error":"thread/list 超时"}],"checkedAt":1}}]"""
        const val CATALOG_NOT_READY = """[{"domain":"catalog","modelEpoch":"m","revision":3,"availability":"ready","completeness":"partial","checkedAt":1,"value":{"totalSessions":10,"truncated":false,"backends":[{"kind":"pi","ready":true,"sessions":10,"complete":true,"elapsedMs":5},{"kind":"codex","ready":false,"sessions":0,"complete":false,"elapsedMs":0}],"checkedAt":1}}]"""
        const val CATALOG_TRUNCATED = """[{"domain":"catalog","modelEpoch":"m","revision":4,"availability":"ready","completeness":"partial","checkedAt":1,"value":{"totalSessions":2000,"truncated":true,"backends":[{"kind":"pi","ready":true,"sessions":2000,"complete":true,"elapsedMs":5}],"checkedAt":1}}]"""
        const val PROVIDERS_IDLE = """[{"domain":"providers","modelEpoch":"m","revision":1,"availability":"ready","completeness":"partial","checkedAt":1,"value":{"providers":[{"agentKind":"codex","current":"custom","profiles":null,"authenticated":null,"switching":null,"usage":{"availability":"unknown","detail":null}},{"agentKind":"dsh","current":"deepseek","profiles":null,"authenticated":null,"switching":null,"usage":{"availability":"unknown","detail":null}}],"checkedAt":1}}]"""
        const val PROVIDERS_SWITCHING = """[{"domain":"providers","modelEpoch":"m","revision":2,"availability":"ready","completeness":"partial","checkedAt":1,"value":{"providers":[{"agentKind":"codex","current":"custom","profiles":null,"authenticated":null,"switching":true,"usage":{"availability":"unknown","detail":null}}],"checkedAt":1}}]"""
        const val PROVIDERS_EMPTY = """[{"domain":"providers","modelEpoch":"m","revision":3,"availability":"ready","completeness":"partial","checkedAt":1,"value":{"providers":[],"checkedAt":1}}]"""
        // Host 在没有摘要时写的是 unknown（不是「没有供应商」），客户端不许把它当成空清单。
        const val PROVIDERS_UNKNOWN = """[{"domain":"providers","modelEpoch":"m","revision":4,"availability":"unknown","completeness":"partial","checkedAt":1,"value":{"providers":[],"checkedAt":1}}]"""
    }
}
