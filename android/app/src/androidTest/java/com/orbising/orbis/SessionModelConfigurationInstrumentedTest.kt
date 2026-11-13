package com.orbising.orbis

import android.graphics.Bitmap
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.width
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.dp
import androidx.lifecycle.ViewModelStore
import androidx.test.core.app.ApplicationProvider
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test

/** S52 / SC76: exercise the production header/sheet without real sessions or transport. */
class SessionModelConfigurationInstrumentedTest {
    @get:Rule val compose = createComposeRule()

    @Test fun runningSelectionIsSeparatedAndComposerDraftSurvives() = exercise(false)
    @Test fun narrowLargeTextKeepsCurrentModelAndChangeEntryAccessible() = exercise(true)

    // SC86: the production sheet must not label an unchanged selection as a future switch.
    @Test fun unchangedAgentSelectionsHaveOnlyOneConfigurationSection() {
        val model = RuntimeModelInfo("p", "model", "Model")
        val runtime = RuntimeSummary("r", "Agent", "/fixture", "running", "s", agentKind = "pi", model = model,
            thinkingLevel = "high", executionTurnId = "turn",
            currentTurnConfiguration = RuntimeTurnConfiguration("turn", model, "high", true))
        val displayed = mutableStateOf(RemoteState(e2eReady = true, runtimes = mapOf("r" to runtime)))
        compose.setContent { OrbisTheme {
            SessionModelConfigurationSheet(displayed.value, "r", {}, null, {}, { _, _ -> null }, {})
        } }
        for (kind in listOf("pi", "codex", "claude", "dsh")) {
            compose.runOnIdle { displayed.value = displayed.value.copy(runtimes = mapOf("r" to runtime.copy(agentKind = kind))) }
            compose.onNodeWithTag("session-current-model").assertTextEquals("Model")
            compose.onNodeWithTag("session-selected-model").assertDoesNotExist()
            compose.onNodeWithText("下轮使用").assertDoesNotExist()
            compose.onNodeWithText("后续选择").assertDoesNotExist()
            compose.onAllNodesWithText("high").assertCountEquals(1)
        }
        capture("unchanged")
    }

    // S56 / SC80: reuse the same sheet for unsupported agents and Claude's native effort command.
    @Test fun selectionOnlySheetRoutesClaudeEffortWithoutAnUnknownCurrentSection() {
        val runtime = RuntimeSummary("r", "Claude Code", "/fixture", "running", "s", agentKind = "claude",
            model = RuntimeModelInfo("claude-code", "actual-id", "Opus"), thinkingLevel = "low",
            currentTurnConfigurationSupported = false, modelSelection = SessionConfigurationValues("opus", "low"))
        val state = RemoteState(e2eReady = true, runtimes = mapOf("r" to runtime), capabilities = mapOf("r" to
            RuntimeCapabilities(listOf(RuntimeSlashCommand("effort", source = "builtin", argument =
                RuntimeSlashCommandArgument("select", true, options = listOf(RuntimeSlashCommandOption("high", "High"))))))))
        val setting = mutableStateOf<String?>(null)
        var submitted: Pair<String, String>? = null
        compose.setContent { OrbisTheme {
            SessionModelConfigurationSheet(state, "r", {}, setting.value, { setting.value = it },
                { name, value -> submitted = name to value; "submitted" }, {})
        } }
        compose.onNodeWithTag("session-current-model").assertDoesNotExist()
        compose.onNodeWithText("核对配置").assertDoesNotExist()
        compose.onNodeWithText("当前所选").assertExists()
        compose.onNodeWithText("思考深度").performScrollTo().assertIsEnabled().performClick()
        compose.runOnIdle { assertEquals("effort", setting.value) }
        compose.onNode(hasText("High") and hasClickAction()).performScrollTo().performClick()
        compose.runOnIdle { assertEquals("effort" to "high", submitted) }
    }

    private fun capture(name: String) {
        val output = File(InstrumentationRegistry.getInstrumentation().targetContext.getExternalFilesDir(null), "turn-config-$name.png")
        output.outputStream().use { compose.onRoot().captureToImage().asAndroidBitmap().compress(Bitmap.CompressFormat.PNG, 100, it) }
    }

    private fun exercise(large: Boolean) {
        val app = IsolatedTestApplication(ApplicationProvider.getApplicationContext(), "turn-config-$large")
        val model = RemoteViewModel(app)
        val owner = ViewModelStore().apply { put("model", model) }
        val a = RuntimeModelInfo("p", "a", "Model A")
        val b = RuntimeModelInfo("p", "b", "Model B")
        val runtime = RuntimeSummary("r", "Codex", "/fixture", "running", "s", agentKind = "codex", model = a,
            thinkingLevel = "low", executionTurnId = "turn", currentTurnConfiguration = RuntimeTurnConfiguration("turn", a, "low", true))
        val displayed = mutableStateOf(RemoteState(hostId = "fixture", e2eReady = true, connection = RelayConnection.ONLINE,
            selectedRuntimeId = "r", runtimes = mapOf("r" to runtime), capabilities = mapOf("r" to RuntimeCapabilities(listOf(
                RuntimeSlashCommand("model", source = "builtin", argument = RuntimeSlashCommandArgument("select", true,
                    options = listOf(RuntimeSlashCommandOption("a", "Model A"), RuntimeSlashCommandOption("b", "Model B")))),
                RuntimeSlashCommand("thinking", source = "builtin", argument = RuntimeSlashCommandArgument("select", true,
                    options = listOf(RuntimeSlashCommandOption("low", "low"), RuntimeSlashCommandOption("high", "high")))))))))
        var submitted: Pair<String, String>? = null
        var sendAccepted = true
        try {
            compose.setContent {
                val density = LocalDensity.current
                CompositionLocalProvider(LocalDensity provides Density(density.density, if (large) 1.5f else 1f), LocalAgentBrand provides AgentBrand.Codex) {
                    OrbisTheme { Box(Modifier.width(if (large) 320.dp else 400.dp)) {
                        ChatScreen(displayed.value, model, executeSlash = { name, value ->
                            submitted = name to value
                            if (sendAccepted) {
                                displayed.value = displayed.value.createConfig("change", "r", name, value, "Model B", 1).first.ledgerWritten("change", 2)
                                "change"
                            } else null
                        })
                    } }
                }
            }
            compose.onNodeWithTag("session-model-indicator", useUnmergedTree = true).assertDoesNotExist()
            compose.onNodeWithText("Model A", useUnmergedTree = true).assertIsDisplayed()
            compose.onNode(hasSetTextAction()).performTextInput("保留这段草稿")
            compose.onNodeWithTag("session-model-entry").performClick()
            compose.onNodeWithTag("session-current-model").assertTextEquals("Model A")
            compose.onNodeWithTag("session-selected-model").assertDoesNotExist()
            compose.onNodeWithText("下轮使用").assertDoesNotExist()
            compose.onNodeWithText("模型", substring = false).performScrollTo().performClick()
            // A synchronous transport refusal keeps the sheet open and the draft intact.
            compose.runOnIdle { sendAccepted = false }
            compose.onNode(hasText("Model B") and hasClickAction()).performScrollTo().performClick()
            compose.onNodeWithTag("session-model-configuration").assertExists()
            compose.runOnIdle { sendAccepted = true }
            compose.onNode(hasText("Model B") and hasClickAction()).performClick()
            compose.waitForIdle()
            compose.runOnIdle { assertEquals("model" to "b", submitted) }
            compose.onNodeWithTag("session-model-indicator", useUnmergedTree = true).assertTextEquals("保存中")
            compose.onNode(hasSetTextAction()).assertTextEquals("保留这段草稿")
            compose.runOnIdle {
                displayed.value = displayed.value.ledgerReceipt("change", LedgerReceipt.Succeeded, 3)
                    .copy(runtimes = mapOf("r" to runtime.copy(model = b, thinkingLevel = "high")))
                    .ledgerAuthority(OperationKinds.modelDomain("r"), null, true)
            }
            compose.onNodeWithTag("session-model-indicator", useUnmergedTree = true).assertTextEquals("下轮已设")
            compose.onNodeWithText("Model A", useUnmergedTree = true).assertIsDisplayed()
            // A visible zero-content ellipsis is not a readable current model.
            for (node in listOf(compose.onNodeWithText("Model A", useUnmergedTree = true),
                compose.onNodeWithTag("session-model-indicator", useUnmergedTree = true))) {
                val layout = mutableListOf<TextLayoutResult>()
                node.performSemanticsAction(SemanticsActions.GetTextLayoutResult) { it(layout) }
                assertFalse("Current model and change marker must remain readable", layout.single().isLineEllipsized(0))
            }
            capture("running-$large")
            compose.onNodeWithTag("session-model-entry").performClick()
            compose.onNodeWithTag("session-current-model").assertTextEquals("Model A")
            compose.onNodeWithTag("session-selected-model").assertTextEquals("Model B")
            // Capture the sheet root; all information remains reachable by scrolling.
            val sheet = File(InstrumentationRegistry.getInstrumentation().targetContext.getExternalFilesDir(null), "turn-config-sheet-$large.png")
            sheet.outputStream().use { compose.onNodeWithTag("session-model-configuration").captureToImage().asAndroidBitmap().compress(Bitmap.CompressFormat.PNG, 100, it) }
            compose.runOnIdle { displayed.value = displayed.value.copy(runtimes = mapOf("r" to runtime)) }
            compose.onNodeWithTag("session-selected-model").assertDoesNotExist()
            compose.onNodeWithText("下轮使用").assertDoesNotExist()
            compose.onNodeWithText("模型", substring = false).performScrollTo().performClick()
            // Choosing the already confirmed value closes through the same success path.
            compose.runOnIdle { sendAccepted = true }
            compose.onNode(hasText("Model A") and hasClickAction() and hasAnyAncestor(hasTestTag("session-model-configuration"))).performScrollTo().performClick()
            compose.runOnIdle {
                displayed.value = displayed.value.copy(ledger = OperationLedger(), runtimes = mapOf("r" to runtime))
            }
            compose.onNodeWithTag("session-model-indicator", useUnmergedTree = true).assertDoesNotExist()
            compose.runOnIdle { displayed.value = displayed.value.copy(runtimes = mapOf("r" to runtime.copy(status = "idle", model = b, thinkingLevel = "high"))) }
            compose.onNodeWithText("Model B", useUnmergedTree = true).assertIsDisplayed()
            compose.onNodeWithTag("session-model-indicator", useUnmergedTree = true).assertDoesNotExist()
            compose.onNode(hasSetTextAction()).assertTextEquals("保留这段草稿")
        } finally {
            compose.runOnIdle { owner.clear() }
            app.dispose()
        }
    }
}
