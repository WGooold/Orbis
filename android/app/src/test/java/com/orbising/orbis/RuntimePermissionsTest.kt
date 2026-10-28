package com.orbising.orbis

import org.junit.Assert.*
import org.junit.Test

class RuntimePermissionsTest {
    @Test fun `interaction submission failure stays with its request without a duplicate modal`() {
        val request = PendingInteraction("q", "pi", "confirm", "Question", null, emptyList(), null,
            responseCommandId = "answer")
        val state = initial.copy(conversations = mapOf("codex:a" to RuntimeConversation(interactions = mapOf("q" to request))))
        val failed = reducer.reduce(state, event(1, """{"type":"command.result","commandId":"answer","ok":false,
            "status":"failure","error":"interaction_not_pending"}"""))
        assertNull(failed.error)
        assertNotNull(failed.conversations.getValue("codex:a").interactions.getValue("q").responseError)
        val ordinaryFailure = reducer.reduce(failed, event(2, """{"type":"command.result","commandId":"other","ok":false,
            "status":"failure","error":"failed"}"""))
        assertNotNull(ordinaryFailure.error)
    }
    @Test fun `unrelated interactions cannot clear local request rendering failures`() {
        val state = initial.copy(conversations = mapOf("codex:a" to RuntimeConversation(interactionNotices = mapOf("broken" to "Cannot render"))))
        val updated = state.withModelFixture("interactions", """{"other":{"requestId":"other","extensionId":"pi","kind":"confirm","title":"Question","expiresAt":9000}}""")
        assertEquals("Cannot render", updated.conversations.getValue("codex:a").interactionNotice)
        val recovered = updated.withModelFixture("interactions", """{"broken":{"requestId":"broken","extensionId":"pi","kind":"confirm","title":"Question","expiresAt":9000}}""", 2)
        assertNull(recovered.conversations.getValue("codex:a").interactionNotice)
    }
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

    @Test fun `management metadata preserves opaque settings and host presentation`() {
        val state = initial.withModelFixture("permissions", """{"management":{"summary":"Host summary","details":"Host explanation","tone":"unknown", "settings":[{"id":"vendor.setting/42","label":"Host setting","currentValue":"opaque:old","disabledReason":"Host policy","options":[{"value":"opaque:new","label":"New option","description":"Host option detail"}]}]}}""")
        val runtime = state.runtimes.getValue("codex:a")
        val management = runtime.permissionManagement!!
        assertEquals("Host summary", management.summary); assertEquals("Host explanation", management.details)
        assertEquals("unknown", management.tone)
        assertEquals(RuntimePermissionSetting("vendor.setting/42", "Host setting", "opaque:old", "Host policy", listOf(RuntimePermissionOption("opaque:new", "New option", "Host option detail"))), management.settings.single())
        assertNull(runtime.permissions)
        assertEquals(management, runtime.copy(permissionManagement = null).carryingComposerStatus(runtime).permissionManagement)
        assertNull(runtime.copy(sessionId = "b", permissionManagement = null).carryingComposerStatus(runtime).permissionManagement)
    }

    @Test fun `legacy raw permissions do not invent management metadata`() {
        val state = reducer.reduce(initial, event(1, """{"type":"runtime.metadata","metadata":{
            "runtimeId":"codex:a","name":"Codex","cwd":"D:/repo","status":"idle","sessionId":"a",
            "permissions":{"sandbox":"dangerFullAccess","approvalPolicy":"never"}}}"""))
        assertNull(state.runtimes.getValue("codex:a").permissionManagement)
    }

    @Test fun `management decodes unknown current value and optional setting fields`() {
        val state = initial.withModelFixture("permissions", """{"management":{"summary":"Unknown","details":"Not confirmed","tone":"unknown","settings":[{"id":"future.mode","label":"Mode","options":[{"value":"x","label":"X"}]}]}}""")
        val setting = state.runtimes.getValue("codex:a").permissionManagement!!.settings.single()
        assertNull(setting.currentValue); assertNull(setting.disabledReason); assertNull(setting.options.single().description)
    }

    @Test fun `reconnect restores submitted approval and local completion clears pending command`() {
        val requested = initial.withModelFixture("interactions", """{"approval":{"requestId":"approval","extensionId":"codex","title":"Approval","kind":"select","options":[{"value":"0","label":"Allow once"}],"argumentSummary":"Get-ChildItem","submitted":true,"expiresAt":9007199254740991}}""")
        val request = requested.conversations.getValue("codex:a").interactions.getValue("approval")
        assertTrue(request.submitted); assertEquals("Get-ChildItem", request.argumentSummary)
        val submitting = requested.copy(pendingCommands = mapOf("answer" to "codex:a"), conversations = requested.conversations.mapValues { (_, conversation) -> conversation.copy(interactions = mapOf("approval" to request.copy(responseCommandId = "answer"))) })
        val resolved = submitting.withModelFixture("interactions", "{}", 2, completeness = "partial")
        assertTrue(resolved.conversations.getValue("codex:a").interactions.isEmpty()); assertTrue(resolved.pendingCommands.isEmpty())
    }

    @Test fun `free text secret questions decode and sandbox errors retain their explanation`() {
        val state = initial.withModelFixture("interactions", """{"q":{"requestId":"q","extensionId":"codex","title":"Question","kind":"questionnaire","expiresAt":9007199254740991,"questions":[{"id":"secret","question":"Token","options":[],"allowOther":true,"secret":true}]}}""")
        val question = state.conversations.getValue("codex:a").interactions.getValue("q").questions.single()
        assertTrue(question.secret)
        assertEquals(QuestionnaireAnswer("secret", emptyList(), "value"), QuestionnaireDraft(otherSelected = true, other = "value").answer(question))
        val failed = reducer.reduce(state, event(2, """{"type":"runtime.error","message":"Windows sandbox failed","recoverable":true}"""))
        assertTrue(failed.notificationProjections.isEmpty()); assertNull(failed.error)
    }
}
