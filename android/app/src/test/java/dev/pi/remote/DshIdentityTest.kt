package dev.pi.remote

import org.junit.Assert.assertEquals
import org.junit.Test

class DshIdentityTest {
    @Test fun identifiesAllThreeBackendsWithoutTreatingDshAsPi() {
        assertEquals("dsh", runtimeAgentKind("dsh:session-one"))
        assertEquals("codex", runtimeAgentKind("codex:session-one"))
        assertEquals("pi", runtimeAgentKind("pi-process-uuid"))
        assertEquals(AgentBrand.DeepSeek, agentBrand("dsh"))
        val runtime = RuntimeSummary("dsh:session-one", "DeepSeek Harness", "D:/work", "idle", sessionId = "dsh:session-one")
        assertEquals("dsh", runtime.agentKind)
        assertEquals(false, runtime.isCodex)
    }
}
