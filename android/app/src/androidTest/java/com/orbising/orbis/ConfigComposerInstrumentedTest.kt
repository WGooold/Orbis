package com.orbising.orbis

import android.graphics.Bitmap
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.lifecycle.ViewModelStore
import androidx.test.core.app.ApplicationProvider
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test

/** Production composer + configuration ledger/reducer; only the transport submission is replaced. */
class ConfigComposerInstrumentedTest {
    @get:Rule val compose = createComposeRule()

    @Test fun codexModelSwitchReleasesComposer() = exercise("codex", "model")
    @Test fun codexThinkingSwitchReleasesComposer() = exercise("codex", "thinking")
    @Test fun piModelSwitchReleasesComposer() = exercise("pi", "model")
    @Test fun piThinkingSwitchReleasesComposer() = exercise("pi", "thinking")
    @Test fun choosingTheConfirmedValueDoesNotWaitForAReceipt() = exercise("pi", "model", same = true)
    @Test fun rejectedSwitchKeepsComposerUsableAndShowsTheLedgerError() = exercise("codex", "thinking", rejected = true)
    @Test fun unwrittenSwitchKeepsItsDraftAndSendButton() = exercise("codex", "model", unwritten = true)

    private fun exercise(agent: String, setting: String, same: Boolean = false, rejected: Boolean = false, unwritten: Boolean = false) {
        val app = IsolatedTestApplication(ApplicationProvider.getApplicationContext(), "config-composer-$agent-$setting")
        val owner = ViewModelStore()
        val model = RemoteViewModel(app)
        owner.put("config", model)
        val runtime = RuntimeSummary("config-runtime", agent, "/repo", "idle", "config-session", agentKind = agent,
            model = RuntimeModelInfo("openai", "model-a", "Model A"), thinkingLevel = "low")
        val value = if (setting == "model") { if (same) "model-a" else "model-b" } else "high"
        val command = RuntimeSlashCommand(setting, source = "builtin", argument = RuntimeSlashCommandArgument("select", true,
            options = listOf(RuntimeSlashCommandOption(value, "目标选项"))))
        val displayed = mutableStateOf(RemoteState(hostId = "config-host", e2eReady = true, connection = RelayConnection.ONLINE,
            selectedRuntimeId = runtime.runtimeId, runtimes = mapOf(runtime.runtimeId to runtime),
            capabilities = mapOf(runtime.runtimeId to RuntimeCapabilities(listOf(command)))))
        var submissions = 0
        try {
            compose.setContent { OrbisTheme { ChatScreen(displayed.value, model, executeSlash = { name, args ->
                assertEquals(setting, name)
                assertEquals(value, args)
                submissions++
                when {
                    unwritten -> null
                    same -> OperationKinds.configTarget(runtime.runtimeId, setting)
                    else -> {
                        displayed.value = displayed.value.createConfig("config-command", runtime.runtimeId, setting, value,
                            "目标选项", System.currentTimeMillis()).first.ledgerWritten("config-command", System.currentTimeMillis())
                        "config-command"
                    }
                }
            }) } }
            val field = compose.onNode(hasSetTextAction())
            field.performTextInput("/$setting")
            compose.onNode(hasText("/$setting") and hasClickAction() and !hasSetTextAction()).performClick()
            compose.onNodeWithText("目标选项").performClick()
            compose.onNodeWithContentDescription("发送").performClick()
            compose.runOnIdle { assertEquals(1, submissions) }
            if (!same && !unwritten) {
                // These receipts belong to the ledger, so commandResults remains empty.
                compose.runOnIdle {
                    displayed.value = RelayReducer().reduce(displayed.value,
                        """{"type":"runtime.event","runtimeId":"config-runtime","sequence":1,"event":{"type":"command.result","commandId":"config-command","ok":${!rejected},"error":"切换被拒绝"}}""",
                        channel = "ctl")
                    if (!rejected) {
                        val confirmed = if (setting == "model") runtime.copy(model = RuntimeModelInfo("openai", value, "Model B"))
                            else runtime.copy(thinkingLevel = value)
                        displayed.value = displayed.value.copy(runtimes = mapOf(runtime.runtimeId to confirmed))
                            .ledgerAuthority(OperationKinds.modelDomain(runtime.runtimeId), null, true)
                    }
                    assertNull(displayed.value.configStatus(runtime.runtimeId, setting))
                    assertTrue(displayed.value.commandResults.isEmpty())
                    if (rejected) assertTrue(displayed.value.error.orEmpty().contains("切换被拒绝"))
                }
            }
            compose.onNodeWithContentDescription("发送").assertIsDisplayed()
            if (unwritten) field.assertTextEquals("/$setting $value")
            else {
                assertEquals("", field.fetchSemanticsNode().config[SemanticsProperties.EditableText].text)
                field.performTextInput("继续提问")
                compose.onNodeWithContentDescription("发送").assertIsEnabled()
            }
            val output = File(InstrumentationRegistry.getInstrumentation().targetContext.getExternalFilesDir(null),
                "config-composer-$agent-$setting-$same-$rejected-$unwritten.png")
            output.outputStream().use { compose.onRoot().captureToImage().asAndroidBitmap().compress(Bitmap.CompressFormat.PNG, 100, it) }
        } finally {
            compose.runOnIdle { owner.clear() }
            app.dispose()
        }
    }
}
