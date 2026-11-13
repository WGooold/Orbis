package com.orbising.orbis

import org.junit.Assert.assertEquals
import org.junit.Test

// ADR-0076 DSH-DESKTOP-03: DeepSeek Desktop is a separate entry with its own kind that keeps the
// DeepSeek identity, chosen as a version beside the DeepSeek emblem like Codex terminal / desktop.
class DshDesktopEntryTest {
    @Test
    fun desktopEntryKeepsDeepSeekIdentityAndOwnKind() {
        assertEquals(AgentBrand.DeepSeek, agentBrand("dshDesktop"))
        assertEquals("dsh", agentFamily("dshDesktop"))
        assertEquals("codex", agentFamily("codexDesktop"))
        assertEquals("pi", agentFamily("pi"))
        assertEquals(listOf("dsh", "dshDesktop"), agentVariants("dsh"))
        assertEquals(listOf("claude"), agentVariants("claude"))
        assertEquals(DrawerAgentFilter.DeepSeekDesktop, drawerAgentFilter("dshDesktop"))
    }

    // DeepSeek Desktop sessions activate as headless like Codex Desktop, but the Desktop window is on the computer,
    // so the launch notice must not say the session has no window there.
    @Test
    fun desktopEntriesOwnTheirComputerWindow() {
        assertEquals(true, ownsComputerWindow("dshDesktop"))
        assertEquals(true, ownsComputerWindow("codexDesktop"))
        assertEquals(false, ownsComputerWindow("dsh"))
        assertEquals(false, ownsComputerWindow("codex"))
    }
}
