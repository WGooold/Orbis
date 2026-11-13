package com.orbising.orbis

import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/** S52 / SC76: status alone never implies a pending model change. Native identity and selection do. */
class SessionModelPresentationTest {
    private val modelA = RuntimeModelInfo("p", "a", "Model A")
    private val modelB = RuntimeModelInfo("p", "b", "Model B")
    private fun runtime(status: String = "running") = RuntimeSummary("r", "Codex", "/repo", status, "s", agentKind = "codex",
        model = modelA, thinkingLevel = "low", executionTurnId = "turn",
        currentTurnConfiguration = RuntimeTurnConfiguration("turn", modelA, "low", true),
        domainAvailability = mapOf("model" to "ready", "execution" to "ready"))
    private fun state(runtime: RuntimeSummary = runtime()) = RemoteState(hostId = "h", e2eReady = true, runtimes = mapOf("r" to runtime))
    private fun presentation(runtime: RuntimeSummary) = state(runtime).sessionModelPresentation("r")

    // SC86: compare native identity, not display names or opaque selection encodings.
    @Test fun unchangedConfigurationsDoNotShowFutureSelectionsAcrossAgents() {
        for ((kind, provider, id, option) in listOf(
            listOf("pi", "deepseek", "deepseek-flash", "deepseek/deepseek-flash"),
            listOf("codex", "openai", "gpt-6.1-sol", "gpt-6.1-sol"),
            listOf("claude", "claude-code", "claude-opus-5-5", "opus"),
            listOf("dsh", "deepseek-official", "deepseek-flash", """{"provider":"deepseek-official","model":"deepseek-flash"}"""))) {
            val actual = RuntimeModelInfo(provider, id)
            val current = RuntimeTurnConfiguration("turn", actual, "high", true)
            val value = runtime().copy(agentKind = kind, model = actual.copy(name = "Display name"), thinkingLevel = "high",
                modelSelection = SessionConfigurationValues(option, "high"), currentTurnConfiguration = current)
            for (status in listOf("running", "waiting_local_interaction")) {
                val view = presentation(value.copy(status = status))
                assertNotNull(view.current); assertNull(view.indicator); assertNull(view.selectionTitle)
            }
            val changed = presentation(value.copy(thinkingLevel = "low"))
            assertEquals(if (kind in listOf("codex", "claude")) "下轮使用" else "后续选择", changed.selectionTitle)
            assertNotNull(changed.indicator)
            assertNull(presentation(value).selectionTitle)
            assertNotNull(presentation(value.copy(model = actual.copy(provider = "other-provider"))).indicator)
            val unknown = value.copy(currentTurnConfiguration = current.copy(thinkingLevel = null, thinkingKnown = false))
            assertNull(presentation(unknown).indicator)
            assertEquals("当前所选", presentation(unknown).selectionTitle)
            val default = value.copy(currentTurnConfiguration = current.copy(thinkingLevel = null))
            assertEquals("当前所选", presentation(default).selectionTitle)
            assertNull(presentation(default.copy(thinkingLevel = null)).selectionTitle)
            assertEquals("当前所选", presentation(value.copy(status = "idle")).selectionTitle)
            assertEquals("当前所选", presentation(value.copy(currentTurnConfiguration = null)).selectionTitle)
        }
    }

    // S56 / SC80: unsupported/legacy adapters report selection, never a guessed current turn.
    @Test fun unsupportedAdaptersHaveAnExplicitSelectionWithoutAnEndlessUnknown() {
        for (kind in listOf("pi", "claude", "dsh")) {
            val runtime = runtime().copy(agentKind = kind, name = kind, currentTurnConfiguration = null,
                currentTurnConfigurationSupported = false)
            val view = presentation(runtime)
            assertEquals("所选：Model A", view.model)
            assertEquals("low", view.thinking)
            assertFalse(view.supportsCurrent)
            assertNull(view.indicator)
            // A bounded native tail may not contain the active request identity yet.
            assertEquals("所选：Model A", presentation(runtime.copy(currentTurnConfigurationSupported = true)).model)
        }
    }

    @Test fun eachNativeOpaqueValueIsUsedForSelectionAndLedgerConfirmation() {
        for ((kind, value, depth) in listOf(Triple("pi", "p/a", "high"), Triple("claude", "opus", "high"),
            Triple("dsh", """{"provider":"p","model":"a"}""", "high"), Triple("dsh", "\"a\"", "\"high\""))) {
            val runtime = runtime().copy(agentKind = kind, modelSelection = SessionConfigurationValues(value, depth))
            assertEquals(value, OperationKinds.confirmedValue(runtime, "model"))
            assertEquals(depth, OperationKinds.confirmedValue(runtime, "effort"))
            val chosen = state(runtime).createConfig("change", "r", "model", value, "Model A", 1).first
            assertEquals(LedgerEvidence.LANDED, OperationKinds.configEvidence(chosen.ledger.operations.single(), runtime))
        }
        assertNull(OperationKinds.confirmedValue(runtime().copy(modelSelection = SessionConfigurationValues()), "model"))
        val unknownAlias = runtime().copy(modelSelection = SessionConfigurationValues())
        val chosen = state(unknownAlias).createConfig("alias", "r", "model", "default", "Default", 1).first.ledgerWritten("alias", 2)
        assertEquals(LedgerEvidence.NONE, OperationKinds.configEvidence(chosen.ledger.operations.single(), unknownAlias))
        val succeeded = chosen.ledgerReceipt("alias", LedgerReceipt.Succeeded, 3)
        assertEquals(LedgerEvidence.LANDED, OperationKinds.configEvidence(succeeded.ledger.operations.single(), unknownAlias))
    }

    @Test fun claudeEffortUsesTheSharedConfigurationLifecycle() {
        assertTrue(OperationKinds.isConfigSetting("effort"))
        assertEquals("effort", listOf(RuntimeSlashCommand("effort", source = "builtin")).depthCommand())
        val chosen = state().createConfig("depth", "r", "effort", "high", "High", 1).first.ledgerWritten("depth", 2)
        assertEquals("保存中", chosen.sessionModelPresentation("r").indicator)
        assertEquals(1, OperationKinds.activeConfigOps(chosen.ledger, "r").size)
        val failed = chosen.ledgerReceipt("depth", LedgerReceipt.Failed(LedgerRejection("refused", "depth refused")), 3)
        assertEquals("effort", failed.sessionConfigFailure("r")?.setting)
        assertEquals("修改失败", failed.sessionModelPresentation("r").indicator)
    }

    @Test fun runningAndWaitingWithoutChangesHaveNoNextIndicator() {
        for (status in listOf("running", "waiting_local_interaction")) {
            val view = presentation(runtime(status))
            assertEquals("Model A", view.model); assertEquals("low", view.thinking); assertNull(view.indicator)
        }
    }
    @Test fun selectedModelAndDepthNeverReplaceCurrentTurnUntilIdle() {
        val selected = runtime().copy(model = modelB, thinkingLevel = "high")
        val running = presentation(selected)
        assertEquals("Model A", running.model); assertEquals("low", running.thinking); assertEquals("下轮已设", running.indicator)
        assertEquals("下轮已设", presentation(runtime().copy(thinkingLevel = "high")).indicator)
        assertNull(presentation(runtime()).indicator)
        val idle = presentation(selected.copy(status = "idle"))
        assertEquals("Model B", idle.model); assertEquals("high", idle.thinking); assertNull(idle.indicator)
    }
    @Test fun midTurnEntryOldHostAndStaleTurnNeverBorrowTheSelectedModel() {
        for (unknown in listOf(runtime().copy(currentTurnConfiguration = null), runtime().copy(executionTurnId = "new"),
            runtime().copy(domainAvailability = mapOf("model" to "unknown")), runtime().copy(status = "unknown"))) {
            val view = presentation(unknown)
            assertEquals("模型未确认", view.model); assertNull(view.thinking); assertNull(view.indicator)
        }
    }
    @Test fun operationProgressAndFailureKeepTheCurrentHeaderAndCanBeRetried() {
        val chosen = state().createConfig("change", "r", "model", "b", "Model B", 1).first.ledgerWritten("change", 2)
        assertEquals("保存中", chosen.sessionModelPresentation("r").indicator)
        assertEquals("Model A", chosen.sessionModelPresentation("r").model)
        val failed = chosen.ledgerReceipt("change", LedgerReceipt.Failed(LedgerRejection("rejected", "fixture refusal")), 3)
        assertEquals("修改失败", failed.sessionModelPresentation("r").indicator)
        assertEquals("b", failed.configFailures["r"]?.value)
        val retry = failed.createConfig("retry", "r", "model", "b", "Model B", 3).first
        assertNull(retry.configFailures["r"])
        assertEquals("保存中", retry.sessionModelPresentation("r").indicator)
        assertNull(failed.copy(runtimes = mapOf("r" to runtime().copy(sessionId = "another"))).sessionModelPresentation("r").indicator)
    }
    @Test fun disconnectedFactsCannotConfirmACurrentTurnOrANextDifference() {
        val offline = state(runtime().copy(model = modelB)).copy(e2eReady = false).sessionModelPresentation("r")
        assertEquals("模型未确认", offline.model); assertNull(offline.thinking); assertNull(offline.indicator)
    }
    @Test fun directoryRefreshPreservesCommittedTurnButReconnectRequiresNewEvidence() {
        val confirmed = runtime()
        val directory = confirmed.copy(executionTurnId = null, currentTurnConfiguration = RuntimeTurnConfiguration("wrong", modelB))
        val refreshed = directory.carryingComposerStatus(confirmed)
        assertEquals(confirmed.currentTurnConfiguration, refreshed.currentTurnConfiguration)
        assertEquals("turn", refreshed.executionTurnId)
        assertNull(directory.copy(sessionId = "other").carryingComposerStatus(confirmed).currentTurnConfiguration)
        val reconnected = state().ledgerOpenConnection().ledgerCloseConnection().ledgerOpenConnection()
        assertEquals("模型未确认", reconnected.sessionModelPresentation("r").model)
        assertNull(reconnected.runtimes["r"]?.executionTurnId)
    }
    @Test fun unconfirmedChoiceIsNotShownAsSavedForNextTurn() {
        val chosen = state().createConfig("change", "r", "thinking", "high", "high", 1).first.ledgerWritten("change", 2)
        val unknown = chosen.withLedgerStep(chosen.ledger.connectionLost())
        assertEquals("未确认", unknown.sessionModelPresentation("r").indicator)
        assertEquals("low", unknown.sessionModelPresentation("r").thinking)
    }
    @Test fun nativeModelDomainCarriesBothValuesAndClearsCurrentOnLegacyReplacement() {
        val json = Json { ignoreUnknownKeys = true }
        val value = json.parseToJsonElement("""{"provider":"p","id":"b","thinkingLevel":"high","currentTurn":{"turnId":"turn","model":{"provider":"p","id":"a","name":"Model A"},"thinkingLevel":"low"}}""")
        fun apply(before: RemoteState, value: JsonElement) = before.applyAgentDomainProjection("r", "s",
            mapOf("model" to AgentStateDomainView("model", "e", 1, "ready", "complete", 0, value)), json) { _, _, _ -> null }
        val projected = apply(state(), value)
        assertEquals("Model A", projected.sessionModelPresentation("r").model)
        assertEquals("下轮已设", projected.sessionModelPresentation("r").indicator)
        val legacy = apply(projected, json.parseToJsonElement("""{"provider":"p","id":"b","thinkingLevel":"high"}"""))
        assertNull(legacy.runtimes["r"]?.currentTurnConfiguration)
        assertEquals("模型未确认", legacy.sessionModelPresentation("r").model)
    }
}
