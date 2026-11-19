package com.orbising.orbis

import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.lifecycle.ViewModelStore
import androidx.test.core.app.ApplicationProvider
import org.junit.Rule
import org.junit.Test

class ExternalImportSheetInstrumentedTest {
    @get:Rule val compose = createComposeRule()

    // OI-07: long content must not hide the next action or expose Send before assignment.
    @Test fun previewAndDestinationPickerHaveIndependentActions() = withSheet { _ ->
        compose.onNodeWithTag("external-import-choose-target").assertIsDisplayed()
        compose.onNodeWithTag("external-import-send").assertDoesNotExist()
        compose.onNodeWithTag("external-import-new-session").assertDoesNotExist()
        compose.onNodeWithTag("external-import-choose-target").performClick()
        compose.onNodeWithTag("external-import-new-session").assertIsDisplayed()
        compose.onNodeWithTag("external-import-send").assertDoesNotExist()
        compose.onNodeWithContentDescription(L10n.tr("返回")).performClick()
        compose.onNodeWithTag("external-import-choose-target").assertIsDisplayed()
    }

    // OI-07: an ambiguous receipt replaces Send with Check, never a second submission.
    @Test fun receiptChangesThePinnedAction() = withSheet { batch ->
        val target = ExternalImportTarget("host-a", "pair-a", "session-a", "/work")
        val assigned = batch.value.copy(destination = ExternalImportDestination(target, "Computer A", "Session A"))
        compose.runOnIdle { batch.value = assigned }
        compose.onNodeWithTag("external-import-send").assertIsDisplayed()
        compose.runOnIdle {
            batch.value = assigned.copy(attempt = ExternalImportAttempt("attempt-a", "runtime-a", ExternalImportReceipt.UNKNOWN))
        }
        compose.onNodeWithTag("external-import-send").assertDoesNotExist()
        compose.onNodeWithText(L10n.tr("核对结果")).assertIsDisplayed()
    }

    private fun withSheet(check: (androidx.compose.runtime.MutableState<ExternalImportBatch>) -> Unit) {
        val app = IsolatedTestApplication(ApplicationProvider.getApplicationContext(), prefix = "external-import-sheet")
        val owner = ViewModelStore()
        val remote = RemoteViewModel(app)
        val model = ExternalImportViewModel(app)
        owner.put("remote", remote)
        owner.put("import", model)
        val batch = mutableStateOf(ExternalImportBatch("shared-content", 0L, "Shared body\n".repeat(100), emptyList()))
        try {
            compose.setContent {
                OrbisTheme { ExternalImportSheet(ExternalImportUi(batches = listOf(batch.value), selected = batch.value.id), model, remote) }
            }
            check(batch)
        } finally {
            compose.runOnIdle { owner.clear() }
            app.dispose()
        }
    }
}
