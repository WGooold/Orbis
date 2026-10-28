package com.orbising.orbis

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test

class ClaudeIdentityTest {
    @Test fun claudeRuntimesKeepTheirOwnBrand() {
        assertEquals(AgentBrand.Claude, agentBrand("claude"))
        assertEquals("Claude Code", AgentBrand.Claude.title)
        val runtime = RuntimeSummary("claude:session-one", "Claude Code", "/repo", "running", sessionId = "session-one", agentKind = "claude")
        assertFalse(runtime.isCodex)
    }
}
