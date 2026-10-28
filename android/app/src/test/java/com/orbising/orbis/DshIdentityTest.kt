package com.orbising.orbis

import org.junit.Assert.assertEquals
import org.junit.Test

class DshIdentityTest {
    @Test fun identifiesAllThreeBackendsWithoutTreatingDshAsPi() {
        assertEquals(AgentBrand.DeepSeek, agentBrand("dsh"))
        val runtime = RuntimeSummary("opaque-route", "DeepSeek Harness", "D:/work", "idle", sessionId = "session-one", agentKind = "dsh")
        assertEquals("dsh", runtime.agentKind)
        assertEquals(false, runtime.isCodex)
    }
}
