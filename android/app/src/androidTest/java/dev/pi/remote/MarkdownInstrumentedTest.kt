package dev.pi.remote

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Surface
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.click
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.unit.dp
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test

class MarkdownInstrumentedTest {
    @get:Rule
    val compose = createComposeRule()

    @Test
    fun wideTableRemainsReadableAndFileLinksWorkInsideScrollableMessage() {
        val downloaded = mutableListOf<String>()
        compose.setContent {
            PiRemoteTheme {
                Surface {
                    Column(Modifier.width(320.dp).verticalScroll(rememberScrollState())) {
                        MarkdownText(
                            """
                                # Rendering check

                                | Agent | Status | Notes | Artifact |
                                | :--- | :---: | :--- | ---: |
                                | Pi | **Ready** | A long cell wraps over multiple lines without truncating its ending | [report][file] |
                                | Codex | *Ready* | ![Preview](http://127.0.0.1:1/missing.png) | none |

                                - [x] finished
                                  > nested **quote**

                                ```text
                                literal **code** with a long line that can scroll horizontally
                                ```

                                [file]: </tmp/My Report (1).txt>
                            """.trimIndent(),
                            downloaded::add,
                        )
                    }
                }
            }
        }
        compose.onNodeWithText("Agent").assertIsDisplayed()
        compose.onNodeWithText("Artifact").performScrollTo().assertIsDisplayed()
        val report = compose.onNodeWithText("report").performScrollTo()
        val layouts = mutableListOf<TextLayoutResult>()
        report.performSemanticsAction(SemanticsActions.GetTextLayoutResult) { it(layouts) }
        // The cell is right-aligned: its center is blank space, not the link's hit target.
        report.performTouchInput { click(layouts.single().getBoundingBox(0).center) }
        compose.runOnIdle { assertEquals(listOf("/tmp/My Report (1).txt"), downloaded) }
        compose.onNodeWithText("A long cell wraps over multiple lines without truncating its ending")
            .performScrollTo().assertIsDisplayed()
        compose.onNodeWithContentDescription("已完成").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("nested quote").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("literal **code** with a long line that can scroll horizontally")
            .performScrollTo().assertIsDisplayed()
    }
}
