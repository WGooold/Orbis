package dev.pi.remote

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ComposerStatusTest {

    private fun runtime(
        model: RuntimeModelInfo? = null,
        thinkingLevel: String? = null,
        usage: RuntimeContextUsage? = null,
    ) = RuntimeSummary(
        runtimeId = "runtime-a",
        name = "api",
        cwd = "/work/api",
        status = "idle",
        model = model,
        thinkingLevel = thinkingLevel,
        contextUsage = usage,
    )

    @Test
    fun `shows the model name and derived context percentage`() {
        val status = composerStatus(
            runtime(
                model = RuntimeModelInfo("anthropic", "claude-sonnet-4-5", "Claude Sonnet 4.5"),
                usage = RuntimeContextUsage(tokens = 24_600, contextWindow = 200_000, percent = null),
            ),
        )

        assertEquals("Claude Sonnet 4.5", status.modelLabel)
        assertEquals("12% · 24.6k/200k", status.contextLabel)
        assertEquals(0.123f, status.contextProgress!!, 0.001f)
        assertEquals(ContextUsageSeverity.Normal, status.severity)
        assertFalse(status.isEmpty)
    }

    @Test
    fun `falls back to the model id when the catalogue has no display name`() {
        val status = composerStatus(runtime(model = RuntimeModelInfo("llama.cpp", "local-qwen")))
        assertEquals("Local Qwen", status.modelLabel)
        assertNull(status.contextLabel)
        assertNull(status.contextProgress)
    }

    @Test
    fun `prettifies raw model ids into readable labels`() {
        assertEquals("Claude Sonnet 4.5", prettyModelId("claude-sonnet-4-5-20250101"))
        assertEquals("Claude Opus 4.5", prettyModelId("claude-opus-4-5"))
        assertEquals("DeepSeek V4.1 Flash", prettyModelId("deepseek-v4.1-flash"))
        assertEquals("GPT 5 Mini", prettyModelId("gpt-5-mini"))
        assertEquals("Qwen3 Max", prettyModelId("qwen3_max"))
        assertEquals("Llama 3 8B", prettyModelId("llama-3-8b"))
        assertEquals("Local Qwen", prettyModelId("local-qwen"))
        assertEquals("Claude Opus 4.5", prettyModelId("Claude_Opus_4_5_latest"))
        // Catalog names always win over the prettified id.
        assertEquals("Claude Sonnet 4.5", modelLabel(RuntimeModelInfo("anthropic", "claude-sonnet-4-5", "Claude Sonnet 4.5")))
        assertEquals("Local Qwen", modelLabel(RuntimeModelInfo("llama.cpp", "local-qwen")))
    }

    @Test
    fun `treats a reported percentage as authoritative`() {
        val status = composerStatus(
            runtime(usage = RuntimeContextUsage(tokens = 1, contextWindow = 200_000, percent = 42.5)),
        )
        assertEquals("43% · 1/200k", status.contextLabel)
        assertEquals(0.425f, status.contextProgress!!, 0.001f)
    }

    @Test
    fun `escalates the severity as the context fills up`() {
        fun severity(percent: Double) = composerStatus(
            runtime(usage = RuntimeContextUsage(tokens = 1, contextWindow = 100, percent = percent)),
        ).severity

        assertEquals(ContextUsageSeverity.Normal, severity(69.9))
        assertEquals(ContextUsageSeverity.Elevated, severity(70.0))
        assertEquals(ContextUsageSeverity.Elevated, severity(89.9))
        assertEquals(ContextUsageSeverity.Critical, severity(90.0))
        assertEquals(ContextUsageSeverity.Critical, severity(100.0))
    }

    @Test
    fun `hides everything while the runtime has not reported status`() {
        assertTrue(composerStatus(null).isEmpty)
        assertTrue(composerStatus(runtime()).isEmpty)
        // Pi cannot estimate tokens right after compaction, so there is no percentage to show.
        val unknown = composerStatus(
            runtime(
                model = RuntimeModelInfo("openai", "gpt-5", "GPT-5"),
                usage = RuntimeContextUsage(tokens = null, contextWindow = 200_000, percent = null),
            ),
        )
        assertFalse(unknown.isEmpty)
        assertEquals("GPT-5", unknown.modelLabel)
        assertNull(unknown.contextLabel)
        assertNull(unknown.contextProgress)
    }

    @Test
    fun `keeps the last known status when a refresh omits the optional fields`() {
        val previous = runtime(
            model = RuntimeModelInfo("openai", "gpt-5", "GPT-5"),
            thinkingLevel = "high",
            usage = RuntimeContextUsage(tokens = 1_000, contextWindow = 8_000, percent = 12.5),
        )
        val incoming = runtime()

        val merged = incoming.carryingComposerStatus(previous)
        assertEquals(previous.model, merged.model)
        assertEquals(previous.thinkingLevel, merged.thinkingLevel)
        assertEquals(previous.contextUsage, merged.contextUsage)
        // A runtime that has never reported status stays empty rather than inventing one.
        assertTrue(composerStatus(incoming.carryingComposerStatus(null)).isEmpty)
    }

    @Test
    fun `lets a fresh report replace the carried status`() {
        val previous = runtime(
            model = RuntimeModelInfo("openai", "gpt-5", "GPT-5"),
            usage = RuntimeContextUsage(tokens = 1_000, contextWindow = 8_000, percent = 12.5),
        )
        val incoming = runtime(
            model = RuntimeModelInfo("anthropic", "claude-sonnet-4-5", "Claude Sonnet 4.5"),
            usage = RuntimeContextUsage(tokens = 4_000, contextWindow = 8_000, percent = 50.0),
        )

        val merged = incoming.carryingComposerStatus(previous)
        assertEquals("claude-sonnet-4-5", merged.model?.id)
        assertEquals(4_000L, merged.contextUsage?.tokens)
    }

    @Test
    fun `formats the context percentage and token counts for a narrow strip`() {
        assertEquals("<1%", formatContextPercent(0.4))
        assertEquals("0%", formatContextPercent(0.0))
        assertEquals("12%", formatContextPercent(12.3))
        assertEquals("100%", formatContextPercent(99.6))

        assertEquals("0", formatTokenCount(0))
        assertEquals("999", formatTokenCount(999))
        assertEquals("1.0k", formatTokenCount(1_000))
        assertEquals("9.9k", formatTokenCount(9_949))
        assertEquals("24.6k", formatTokenCount(24_600))
        assertEquals("200k", formatTokenCount(200_000))
        assertEquals("1.0M", formatTokenCount(1_000_000))
    }
}
