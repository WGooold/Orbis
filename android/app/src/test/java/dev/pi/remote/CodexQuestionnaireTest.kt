package dev.pi.remote

import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class CodexQuestionnaireTest {
    private val reducer = RelayReducer()
    private val request = """{
        "runtimeId":"codex-desktop:a","requestId":"codex-async:question","extensionId":"codex",
        "kind":"questionnaire","title":"Codex 需要你的回答","expiresAt":9007199254740991,
        "questions":[{"id":"0","question":"需要修复哪些端？","allowOther":true,
            "options":[{"value":"0","label":"App 和 Host（推荐）"},{"value":"1","label":"仅 App"}]}]
    }""".trimIndent()

    private fun event(sequence: Int, payload: String) = """{
        "type":"runtime.event","runtimeId":"codex-desktop:a","sequence":$sequence,"event":$payload
    }""".trimIndent()

    @Test
    fun `desktop async questions retain options custom input and unbounded lifetime`() {
        val state = reducer.reduce(RemoteState(), event(1, """{"type":"interaction.requested","request":$request}"""))
        val pending = state.conversations.getValue("codex-desktop:a").interactions.getValue("codex-async:question")
        val question = pending.questions.single()
        assertEquals("需要修复哪些端？", question.question)
        assertEquals(listOf("App 和 Host（推荐）", "仅 App"), question.options.map { it.label })
        assertTrue(question.allowOther)
        assertFalse(interactionHasDeadline(pending))
        // A recommended option does not submit itself; the user must choose explicitly.
        assertEquals(null, QuestionnaireDraft().answer(question))
        assertEquals(QuestionnaireAnswer("0", listOf("1")), QuestionnaireDraft().toggle(question, "1").answer(question))
        val other = QuestionnaireDraft(otherSelected = true, other = "保留当前连接").answer(question)!!
        assertEquals(QuestionnaireAnswer("0", emptyList(), "保留当前连接"), other)
        assertTrue(Json.encodeToString(other).contains("保留当前连接"))
    }

    @Test
    fun `reconnecting restores submitted questions and a desktop answer clears them`() {
        var state = reducer.reduce(RemoteState(), event(1, """{"type":"interaction.requested","request":$request}"""))
        state = reducer.reduce(state.markReconnecting(), event(2,
            """{"type":"interaction.snapshot","requests":[${request.dropLast(1)},"submitted":true}]}"""))
        assertTrue(state.conversations.getValue("codex-desktop:a").interactions.getValue("codex-async:question").submitted)
        state = reducer.reduce(state, event(3,
            """{"type":"interaction.resolved","requestId":"codex-async:question","source":"local"}"""))
        assertTrue(state.conversations.getValue("codex-desktop:a").interactions.isEmpty())
    }
}
