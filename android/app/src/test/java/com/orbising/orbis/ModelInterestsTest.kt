package com.orbising.orbis

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** FT-G03: prevent sticky broad subscriptions after a view closes, including a
 * close within the ordinary refresh throttle; independent owners remain active. */
class ModelInterestsTest {
    private fun domains(value: ModelInterests, runtime: String = "r") =
        value.domains(runtime, HOME_AGENT_MODEL_DOMAINS, AGENT_MODEL_DOMAINS)

    @Test fun `home retains decision facts and close target without unused domains`() {
        assertEquals(listOf("identity", "execution", "interactions", "capabilities"), domains(ModelInterests()))
        assertEquals(listOf("identity", "backends", "catalog", "providers"), HOME_HOST_MODEL_DOMAINS)
        val chat = ModelInterests().replacing("r", "chat", CHAT_AGENT_MODEL_DOMAINS.toSet())
        assertTrue(domains(chat).containsAll(listOf("delivery", "model", "context", "permissions")))
        assertFalse(domains(chat).any { it in listOf("records", "resources", "artifacts", "workspaceRef") })
    }

    @Test fun `releasing one owner retains another and cannot affect a different runtime`() {
        val interests = ModelInterests().replacing("r", "chat", CHAT_AGENT_MODEL_DOMAINS.toSet())
            .replacing("r", "inspector", setOf("records")).replacing("other", "chat", setOf("context"))
        val released = interests.replacing("r", "chat", emptySet())
        assertTrue("records" in domains(released))
        assertFalse("context" in domains(released))
        assertTrue("context" in domains(released, "other"))
        assertEquals(HOME_AGENT_MODEL_DOMAINS, domains(released.replacing("r", "inspector", emptySet())))
        assertEquals(HOME_AGENT_MODEL_DOMAINS, domains(ModelInterests())) // a different Host connection
    }

    @Test fun `narrowing a recent subscription bypasses the refresh throttle`() {
        val broad = AgentStateRead("key", "agent", (HOME_AGENT_MODEL_DOMAINS + CHAT_AGENT_MODEL_DOMAINS).toSet(), sentAt = 1_000)
        assertFalse(broad.matchesInterest(HOME_AGENT_MODEL_DOMAINS, 1_001))
        assertTrue(broad.matchesInterest(HOME_AGENT_MODEL_DOMAINS + CHAT_AGENT_MODEL_DOMAINS, 1_001))
        assertFalse(broad.matchesInterest(HOME_AGENT_MODEL_DOMAINS + CHAT_AGENT_MODEL_DOMAINS, 15_000))
    }
}
