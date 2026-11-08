package com.orbising.orbis

import android.graphics.Bitmap
import androidx.compose.foundation.layout.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test

/** S34/S35/S37, SC54/SC55/SC56: inspect actual controls without real Host traffic. */
class DesignAlignmentInstrumentedTest {
    @get:Rule val compose = createComposeRule()
    private fun ready(host: String = "design-host") = RemoteState(hostId = host, hostName = "workstation",
        connection = RelayConnection.ONLINE, e2eReady = true, supportedAgents = setOf("codex","claude","dsh","pi"),
        launchableAgents = setOf("codex","claude","dsh","pi"))

    private fun capture(name: String) {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        File(context.getExternalFilesDir(null), "design-$name.png").outputStream().use {
            compose.onRoot().captureToImage().asAndroidBitmap().compress(Bitmap.CompressFormat.PNG,100,it)
        }
    }

    @Test fun protocolSelectionRequiresAnExplicitApplyAndRespectsOfflineDisablement() {
        val choices = mutableListOf<RelayTransportMode>()
        val enabled = mutableStateOf(true)
        compose.setContent { OrbisTheme { ProtocolChoiceSheet(RelayTransportMode.AUTO, enabled.value, {}) { choices += it } } }
        compose.onNodeWithTag("protocol-apply").assertIsNotEnabled()
        compose.onNodeWithTag("relay-mode-QUIC").performClick()
        compose.runOnIdle { assertTrue(choices.isEmpty()) }
        compose.onNodeWithTag("protocol-apply").assertIsEnabled()
        compose.runOnIdle { enabled.value = false }
        compose.onNodeWithTag("protocol-apply").assertIsNotEnabled()
        compose.runOnIdle { enabled.value = true }
        compose.onNodeWithTag("protocol-apply").performClick()
        compose.runOnIdle { assertEquals(listOf(RelayTransportMode.QUIC),choices) }
    }

    @Test fun localDraftKeepsItsTextUntilAFirstSendSucceedsAndUsesTheCurrentHostDirectory() {
        val state = mutableStateOf(ready())
        val open = mutableStateOf(true)
        var accepted = false
        val submissions = mutableListOf<List<String>>()
        compose.setContent { OrbisTheme {
            SessionDraftCard(state.value, open.value, "/Projects/orbis", {}, {}, {}) { kind,cwd,text,_,_ ->
                submissions += listOf(state.value.hostId.orEmpty(),kind,cwd,text); accepted
            }
        } }
        compose.onNodeWithTag("draft-send").assertIsNotEnabled()
        compose.onNodeWithTag("draft-agent-claude").performClick()
        val input = compose.onNode(hasSetTextAction())
        input.performTextInput("第一句话")
        compose.runOnIdle { assertTrue(submissions.isEmpty()) }
        compose.runOnIdle { open.value = false }
        compose.runOnIdle { open.value = true }
        input.assertTextContains("第一句话")
        compose.onNodeWithTag("draft-send").performClick()
        input.assertTextContains("第一句话")
        compose.runOnIdle { assertEquals(listOf("design-host","claude","/Projects/orbis","第一句话"),submissions.single()); accepted = true }
        compose.onNodeWithTag("draft-send").performClick()
        input.assert(SemanticsMatcher.expectValue(androidx.compose.ui.semantics.SemanticsProperties.EditableText, androidx.compose.ui.text.AnnotatedString("")))
        compose.runOnIdle { state.value = ready("other-host") }
        input.assert(SemanticsMatcher.expectValue(androidx.compose.ui.semantics.SemanticsProperties.EditableText, androidx.compose.ui.text.AnnotatedString("")))
        capture("draft-light")
    }

    @Test fun appearanceModesAndBothMaterialsChangeEverySurfaceWithoutChangingSettingsStructure() {
        val oldMode = AppAppearance.mode; val oldMaterial = AppAppearance.material
        try {
            compose.runOnIdle { AppAppearance.selectMode(OrbisAppearanceMode.Light); AppAppearance.selectMaterial(OrbisMaterial.Mist) }
            compose.setContent { OrbisTheme { DesignSettingsScreen(ready(),{},true,{}) } }
            capture("settings-mist-light")
            compose.onNodeWithTag("appearance-dark").performScrollTo().performClick()
            compose.runOnIdle { assertEquals(OrbisAppearanceMode.Dark,AppAppearance.mode) }
            capture("settings-mist-dark")
            compose.onNodeWithTag("appearance-material-sage").performScrollTo().performClick()
            compose.runOnIdle { assertEquals(OrbisMaterial.Sage,AppAppearance.material) }
            capture("settings-sage-dark")
            compose.onNodeWithTag("appearance-light").performScrollTo().performClick()
            capture("settings-sage-light")
            compose.onNodeWithTag("appearance-system").performScrollTo().performClick()
            compose.runOnIdle { assertEquals(OrbisAppearanceMode.System,AppAppearance.mode) }
            compose.onNodeWithTag("settings-protocol").performScrollTo().assertIsDisplayed()
            compose.onNodeWithText("配对信息").assertDoesNotExist()
        } finally { compose.runOnIdle { AppAppearance.selectMode(oldMode); AppAppearance.selectMaterial(oldMaterial) } }
    }
}
