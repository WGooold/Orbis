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

    private companion object {
        const val DOMAINS = """[{"domain":"diagnostics","modelEpoch":"model-1","revision":2,"availability":"ready","completeness":"partial","checkedAt":1700000000000,"value":{"records":2,"dropped":1}}]"""
    }
}
