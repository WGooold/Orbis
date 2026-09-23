package dev.pi.remote

import org.junit.Assert.*
import org.junit.Test

class RuntimePermissionsTest {
    @Test fun `draft persistence removes secret answers but preserves ordinary fields`() {
        val request = PendingInteraction("q", "pi", "questionnaire", "问题", null, emptyList(), null,
            questions = listOf(QuestionnaireQuestion("secret", "Token", emptyList(), secret = true)))
        val value = InteractionDraftValue(answers = mapOf(
            "secret" to QuestionnaireDraft(other = "secret-value"), "normal" to QuestionnaireDraft(other = "D:/repo")), page = 1)
        assertEquals(setOf("normal"), savableInteractionDraft(request, value).answers.keys)
        assertEquals(1, savableInteractionDraft(request, value).page)
        assertEquals("", savableInteractionDraft(request.copy(secret = true), value.copy(input = "secret-value")).input)
    }

    private val reducer = RelayReducer()
    private val initial = RemoteState(
        runtimes = mapOf("codex:a" to RuntimeSummary("codex:a", "Codex", "D:/repo", "idle", "a")),
        selectedRuntimeId = "codex:a",
    )
    private fun event(sequence: Int, body: String) =
        """{"type":"runtime.event","runtimeId":"codex:a","sequence":$sequence,"event":$body}"""

    @Test fun `effective permissions update and explain never without implying full access`() {
        val state = reducer.reduce(initial, event(1, """{"type":"runtime.metadata","metadata":{
            "runtimeId":"codex:a","name":"Codex","cwd":"D:/repo","status":"idle","sessionId":"a",
            "permissions":{"sandbox":"readOnly","approvalPolicy":"never","networkAccess":false,"reviewer":"user"}}}"""))
        val permissions = state.runtimes.getValue("codex:a").permissions!!
        assertEquals("只读沙箱 · 不申请审批", permissionSummary(permissions))
        assertTrue(permissionDetails(permissions).contains("受限操作不会弹出人工批准"))
        assertTrue(permissionDetails(permissions).contains("网络访问：受限"))
        assertNull(state.runtimes.getValue("codex:a").copy(sessionId = "b", permissions = null)
            .carryingComposerStatus(state.runtimes["codex:a"]).permissions)
    }

    @Test fun `reconnect restores submitted approval and local completion clears pending command`() {
        val requested = reducer.reduce(initial, event(1, """{"type":"interaction.snapshot","requests":[{
            "runtimeId":"codex:a","requestId":"approval","extensionId":"codex","title":"批准执行命令",
            "kind":"select","options":[{"value":"0","label":"允许一次"}],"argumentSummary":"Get-ChildItem",
            "submitted":true,"expiresAt":9007199254740991}]}"""))
        val request = requested.conversations.getValue("codex:a").interactions.getValue("approval")
        assertTrue(request.submitted)
        assertEquals("Get-ChildItem", request.argumentSummary)
        val submitting = requested.copy(
            pendingCommands = mapOf("answer" to "codex:a"),
            conversations = mapOf("codex:a" to requested.conversations.getValue("codex:a").copy(
                interactions = mapOf("approval" to request.copy(responseCommandId = "answer")),
            )),
        )
        val resolved = reducer.reduce(submitting, event(2, """{"type":"interaction.resolved","requestId":"approval","source":"local"}"""))
        assertTrue(resolved.conversations.getValue("codex:a").interactions.isEmpty())
        assertTrue(resolved.pendingCommands.isEmpty())
        assertEquals("交互已在电脑端完成", resolved.conversations.getValue("codex:a").interactionNotice)
        val snapshot = reducer.reduce(submitting, event(3, """{"type":"interaction.snapshot","requests":[]}"""))
        assertTrue(snapshot.pendingCommands.isEmpty())
    }

    @Test fun `free text secret questions decode and sandbox errors retain their explanation`() {
        val state = reducer.reduce(initial, event(1, """{"type":"interaction.requested","request":{
            "runtimeId":"codex:a","requestId":"q","extensionId":"codex","title":"回答问题","kind":"questionnaire",
            "expiresAt":9007199254740991,"questions":[{"id":"secret","question":"填写密钥","options":[],"allowOther":true,"secret":true}]}}"""))
        val question = state.conversations.getValue("codex:a").interactions.getValue("q").questions.single()
        assertTrue(question.secret)
        assertEquals(QuestionnaireAnswer("secret", emptyList(), "value"),
            QuestionnaireDraft(otherSelected = true, other = "value").answer(question))
        val failed = reducer.reduce(state, event(2, """{"type":"runtime.error","message":"Windows 沙箱初始化失败，请在电脑端修复后重试","recoverable":true}"""))
        assertTrue(failed.conversations.getValue("codex:a").runtimeError!!.contains("电脑端修复"))
        assertNull(failed.error)
    }
}
