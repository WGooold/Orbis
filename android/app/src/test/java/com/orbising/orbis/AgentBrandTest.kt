package com.orbising.orbis

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class AgentBrandTest {
    // AGENT-MARK-01: named agents must not pick up Pi's legacy fallback, and
    // OpenCode selects its own light or dark artwork instead of a tinted glyph.
    @Test fun agentKindsResolveToTheirOwnArtwork() {
        val brands = mapOf(
            "pi" to AgentBrand.Pi, "codex" to AgentBrand.Codex, "codexDesktop" to AgentBrand.Codex,
            "dsh" to AgentBrand.DeepSeek, "dshDesktop" to AgentBrand.DeepSeek, "claude" to AgentBrand.Claude,
            KIMI_CODE_KIND to AgentBrand.Kimi, "openclaw" to AgentBrand.OpenClaw, "hermes" to AgentBrand.Hermes,
            "opencode" to AgentBrand.OpenCode,
        )
        brands.forEach { (kind, brand) -> assertEquals(kind, brand, knownAgentBrand(kind)) }
        assertEquals(R.drawable.ic_agent_kimi, AgentBrand.Kimi.icon)
        assertEquals(R.drawable.ic_agent_kimi, AgentBrand.Kimi.darkIcon)
        assertEquals(R.drawable.ic_agent_opencode, AgentBrand.OpenCode.icon)
        assertEquals(R.drawable.ic_agent_opencode_dark, AgentBrand.OpenCode.darkIcon)
        assertNull(knownAgentBrand("future-agent"))
        assertEquals(AgentBrand.Pi, agentBrand(null))
    }
}
