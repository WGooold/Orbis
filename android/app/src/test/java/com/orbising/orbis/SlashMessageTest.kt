package com.orbising.orbis

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * ADR-0049 §6.1：产生对话的 Slash（prompt / skill）乐观显示。iOS `SlashMessageTests.swift` 与本文件对应；
 * 发送与重发在 [HostConnection]，这里覆盖判定规则与本地行的结算。
 */
class SlashMessageTest {
    private val reducer = RelayReducer()
    private val idle = RuntimeSummary("a", "Agent", "/repo", "idle", "session-a")
    private val prompt = RuntimeSlashCommand("review", source = "prompt")

    @Test fun aPromptOrSkillCommandOnAnIdleRuntimeProducesAMessage() {
        assertTrue(OperationKinds.slashProducesMessage(prompt, idle))
        assertTrue(OperationKinds.slashProducesMessage(RuntimeSlashCommand("review", source = "skill"), idle))
    }

    @Test fun aBusyRuntimeKeepsTheProcessingPathWithoutABubble() {
        assertFalse(OperationKinds.slashProducesMessage(prompt, idle.copy(status = "running")))
    }

    @Test fun aBuiltinCommandDoesNotShowABubble() {
        assertFalse(OperationKinds.slashProducesMessage(RuntimeSlashCommand("compact", source = "builtin"), idle))
    }

    @Test fun aFailedPromptCommandStaysAsAFailedRowThatRemembersTheCommand() {
        val row = PendingSend("app-1", "c-1", "session-a", "/review src", emptyList(), null, 1, null, slashName = "review", slashArgs = "src")
        val state = RemoteState(e2eReady = true, connection = RelayConnection.ONLINE, runtimes = mapOf("a" to idle),
            pendingSends = mapOf("app-1" to row))
        val failed = reducer.reduce(state, """{"type":"runtime.event","runtimeId":"a","sequence":1,"event":{"type":"command.result",
            "commandId":"c-1","ok":false,"status":"failure","error":"runtime_busy"}}""", channel = "ctl")
        val send = failed.pendingSends.getValue("app-1")
        assertTrue(send.state is PendingSendState.Failed)
        assertEquals("review" to "src", send.slashName to send.slashArgs)
    }
}
