package com.orbising.orbis

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** ADR-0049: optimistic sends reconcile only through source-declared identity. */
class PendingSendsTest {
    private val start = 1_000_000L
    private val reducer = FixtureRelayReducer()

    private fun send(id: String, session: String = "s1", delivery: String? = null, anchor: String? = null, at: Long = 0) =
        PendingSend(id, "c-$id", session, "text $id", emptyList(), delivery, start + at, anchor)

    private fun message(id: String, role: String = "assistant", client: String? = null) =
        ChatMessage(id, role, listOf(RemoteContent("text", id)), 1, clientMessageId = client)

    private fun Map<String, PendingSend>.observe(
        status: String? = "idle", queue: List<QueuedMessage> = emptyList(), revision: Long = 0, connected: Boolean = true,
        at: Long = 1_000, present: Set<String> = emptySet(),
    ) = reconcile(start + at) { PendingSendObservation(status, queue.associateBy(QueuedMessage::queueId), revision, connected) { it in present } }

    private fun outbox(vararg sends: PendingSend) = sends.associateBy(PendingSend::messageId)

    @Test fun `materializes by either backend identity and never returns`() {
        var pending = outbox(send("pi"), send("codex"))
        pending = pending.observe(present = setOf("pi")).first
        assertEquals(setOf("codex"), pending.keys)
        pending = pending.observe(present = setOf("codex")).first
        assertTrue(pending.isEmpty())
        assertTrue(pending.observe().first.isEmpty())
    }

    @Test fun `anchored rows stay before a reply that arrived first`() {
        val merged = mergePendingSends(listOf(message("a0"), message("reply")),
            listOf(send("u1", anchor = "a0"), send("u2", anchor = "a0", at = 1), send("u3", anchor = "gone", at = 2)))
        assertEquals(listOf("a0", "u1", "u2", "reply", "u3"), merged.map(ChatMessage::messageId))
        assertEquals("user", merged[1].role)
    }

    @Test fun `queue sends hand over to the host queue and chat sends hide it`() {
        var pending = outbox(send("busy", delivery = "followUp"), send("idle"))
        assertEquals(listOf("busy"), pending.queueRows("s1").map(PendingSend::messageId))
        assertEquals(listOf("idle"), pending.chatRows("s1").map(PendingSend::messageId))
        pending = pending.observe(status = "running", queue = listOf(QueuedMessage("busy", "t", "followUp"), QueuedMessage("idle", "t", "followUp"))).first
        assertNull(pending["busy"])
        assertEquals(PendingSendState.Accepted, pending["idle"]?.state)
        assertTrue(pending.hidesQueueItem("idle"))
        pending = pending.observe(status = "running", queue = listOf(QueuedMessage("idle", "t", "followUp", "rejected"))).first
        assertEquals(PendingSendState.Failed("电脑端拒绝了这条消息"), pending["idle"]?.state)
    }

    @Test fun `command results distinguish rejection from unknown delivery`() {
        var pending = outbox(send("ok"), send("busy"), send("lost"), send("sending"))
        pending = pending.withCommandResult("c-ok", CommandResult(true, "pending"), start)
            .withCommandResult("c-busy", CommandResult(false, "failure", error = "runtime_busy"), start)
            .withCommandResult("c-lost", CommandResult(false, "cancelled"), start)
        assertEquals(pending, pending.withCommandResult("other", CommandResult(true), start))
        assertEquals(PendingSendState.Accepted, pending["ok"]?.state)
        assertEquals(PendingSendState.Failed("会话正在运行，请选择插入或完成后发送"), pending["busy"]?.state)
        assertEquals(PendingSendState.Unconfirmed, pending["lost"]?.state)
        pending = pending.connectionLost()
        assertEquals(PendingSendState.Unconfirmed, pending["sending"]?.state)
        assertEquals(PendingSendState.Accepted, pending["ok"]?.state)
        pending = pending.runtimeLost("s1")
        assertEquals(PendingSendState.Unconfirmed, pending["ok"]?.state)
        assertEquals(PendingSendState.Failed("会话正在运行，请选择插入或完成后发送"), pending["busy"]?.state)
    }

    @Test fun `accepted row without identity leaves after the turn and one new authoritative state`() {
        var pending = outbox(send("claude")).withCommandResult("c-claude", CommandResult(true), start)
        var result = pending.observe(revision = 1, at = 2)
        assertTrue(result.second.isEmpty())
        pending = result.first.observe(status = "running", revision = 1, at = 3).first
        assertEquals(true, pending["claude"]?.sawBusy)
        result = pending.observe(revision = 2, at = 4)
        assertEquals(setOf("s1"), result.second)
        result = result.first.observe(revision = 2, at = 5)
        assertTrue(result.second.isEmpty())
        assertTrue("claude" in result.first)
        assertTrue(result.first.observe(revision = 3, at = 6).first.isEmpty())
    }

    @Test fun `accepted row on an idle runtime is checked after the grace period`() {
        val pending = outbox(send("quiet")).withCommandResult("c-quiet", CommandResult(true), start)
        assertTrue(pending.observe(revision = 1, at = PENDING_SEND_ACCEPTED_IDLE_GRACE_MS - 1).second.isEmpty())
        val checking = pending.observe(revision = 1, at = PENDING_SEND_ACCEPTED_IDLE_GRACE_MS + 1)
        assertEquals(setOf("s1"), checking.second)
        assertTrue(checking.first.observe(revision = 2, at = PENDING_SEND_ACCEPTED_IDLE_GRACE_MS + 2).first.isEmpty())
    }

    @Test fun `unconfirmed row waits for an idle source then becomes retryable`() {
        val lost = outbox(send("lost")).connectionLost()
        assertTrue(lost.observe(connected = false).second.isEmpty())
        assertTrue(lost.observe(status = "running", revision = 1).second.isEmpty())
        val checking = lost.observe(revision = 1)
        assertEquals(setOf("s1"), checking.second)
        assertTrue(checking.first.observe(revision = 2, present = setOf("lost")).first.isEmpty())
        assertEquals(PendingSendState.Failed("未能确认送达，可以重新发送"), checking.first.observe(revision = 2).first["lost"]?.state)
    }

    @Test fun `sessions are isolated`() {
        val pending = outbox(send("mine"), send("other", session = "s2"))
        val next = pending.reconcile(start) { session ->
            PendingSendObservation("idle", emptyMap(), 0, true) { id -> session == "s1" && id == "mine" || session == "s2" && id == "nothing" }
        }.first
        assertEquals(setOf("other"), next.keys)
        assertTrue(next.chatRows("s1").isEmpty())
    }

    @Test fun `reducer keeps message receipts on the row and reconciles a declared live message`() {
        val runtime = RuntimeSummary("runtime-a", "Agent", "/repo", "idle", "session-1", agentKind = "pi")
        var state = RemoteState(hostId = "host", selectedRuntimeId = "runtime-a", e2eReady = true, connection = RelayConnection.ONLINE,
            runtimes = mapOf("runtime-a" to runtime),
            pendingSends = outbox(send("app-1", session = "session-1"), send("app-2", session = "session-1")))
        state = reducer.reduce(state, """
          {"type":"runtime.event","runtimeId":"runtime-a","sequence":1,"event":{
            "type":"command.result","commandId":"c-app-2","ok":false,"status":"failure","error":"runtime_busy"}}
        """.trimIndent())
        assertNull("message failures stay on their row", state.error)
        assertEquals(PendingSendState.Failed("会话正在运行，请选择插入或完成后发送"), state.pendingSends["app-2"]?.state)

        // Protocol 14 carries live rows only in source checkpoints; decode one as the reducer does.
        val live = kotlinx.serialization.json.Json { ignoreUnknownKeys = true }.decodeFromString(ChatMessage.serializer(),
            """{"messageId":"live-user","role":"user","clientMessageId":"app-1","content":[{"type":"text","text":"text app-1"}],"timestamp":2000}""")
        assertEquals("app-1", live.clientMessageId)
        state = state.copy(conversations = mapOf("runtime-a" to RuntimeConversation(messages = listOf(live))))
        val reconciled = state.reconcilePendingSends(start).first
        assertEquals(setOf("app-2"), reconciled.pendingSends.keys)

        val offline = reducer.reduce(reconciled.copy(pendingSends = reconciled.pendingSends + ("app-3" to send("app-3", session = "session-1"))),
            """{"type":"runtime.offline","runtimeId":"runtime-a"}""")
        assertEquals(PendingSendState.Unconfirmed, offline.pendingSends["app-3"]?.state)
    }

    @Test fun `a canonical entry that declares the phone send replaces the local row without any live row`() {
        // Codex commits the user item under its native id; started/completed share one coalesced
        // patch, so the phone only ever sees the Entry and its display row (ADR-0049 §2).
        val user = SessionGraphEntry("item-user", null, "message", "1970-01-01T00:00:00.000Z", buildJsonObject {
            put("message", buildJsonObject { put("role", "user"); put("content", "text app-1"); put("clientMessageId", "app-1") })
        })
        val display = DisplayBatch(DISPLAY_PROJECTION_VERSION, listOf(DisplayEntry("item-user", "item-user", "message", "message",
            ChatMessage("item-user", "user", listOf(RemoteContent("text", "text app-1")), 0, clientMessageId = "app-1"))), null)
        val snapshot = SessionGraphSnapshot("session-1", "sync", SessionBranchCursor("item-user"), "replace", listOf(user),
            "preview", "item-user", complete = true, display = display)
        val state = RemoteState(hostId = "host", selectedRuntimeId = "runtime-a", e2eReady = true, connection = RelayConnection.ONLINE,
            runtimes = mapOf("runtime-a" to RuntimeSummary("runtime-a", "Codex", "/repo", "running", "session-1", agentKind = "codex")),
            sessionSyncCommands = mapOf("sync-command" to PendingSessionSync("runtime-a", "session-1", "sync", "preview")),
            pendingSends = outbox(send("app-1", session = "session-1")))
        val payload = buildJsonObject {
            put("type", "runtime.event"); put("runtimeId", "runtime-a"); put("sequence", 1)
            put("event", JsonObject((Json.encodeToJsonElement(SessionGraphSnapshot.serializer(), snapshot) as JsonObject) +
                ("type" to JsonPrimitive("session.snapshot"))))
        }
        // The batch read back from SQLite keeps the Host's display row as written.
        val applied = reducer.reduceSourceSnapshot(state, payload.toString(), CommittedSessionBatch(listOf(user), display))
        val messages = applied.conversations.getValue("runtime-a").messages
        assertEquals(listOf("app-1"), messages.map { it.clientMessageId })

        val reconciled = applied.reconcilePendingSends(start).first
        assertTrue(reconciled.pendingSends.isEmpty())
        assertEquals(listOf("item-user"), mergePendingSends(messages, reconciled.pendingSends.chatRows("session-1")).map { it.messageId })
    }

    @Test fun `queue panel shows submitting rows until the host queue owns them`() {
        val state = RemoteState(runtimes = mapOf("r" to RuntimeSummary("r", "A", "/repo", "running", "s1")),
            conversations = mapOf("r" to RuntimeConversation(queuedMessages = mapOf("idle" to QueuedMessage("idle", "t", "followUp")))),
            pendingSends = outbox(send("busy", delivery = "steer"), send("idle")))
        assertEquals(listOf("busy" to "submitting"), state.queuePanelItems("r").map { it.queueId to it.state })
    }

    @Test fun `closing runtime hides until offline and returns when the computer rejects`() {
        val runtime = RuntimeSummary("runtime-a", "Agent", "/repo", "idle", "session-1")
        val base = RemoteState(e2eReady = true, connection = RelayConnection.ONLINE, runtimes = mapOf("runtime-a" to runtime),
            pendingCommands = mapOf("quit-1" to "runtime-a"), closingRuntimes = mapOf("runtime-a" to ClosingRuntime("quit-1", start)))
        fun result(ok: Boolean) = """
          {"type":"runtime.event","runtimeId":"runtime-a","sequence":1,"event":{
            "type":"command.result","commandId":"quit-1","ok":$ok${if (ok) "" else ""","status":"failure","error":"进程仍在运行""""}}}
        """.trimIndent()
        val accepted = reducer.reduce(base, result(true))
        assertTrue(accepted.closingRuntimes["runtime-a"]?.confirmedAt != null)
        assertNull(accepted.error)
        val offline = reducer.reduce(accepted, """{"type":"runtime.offline","runtimeId":"runtime-a"}""")
        assertTrue(offline.closingRuntimes.isEmpty())

        val rejected = reducer.reduce(base, result(false))
        assertTrue(rejected.closingRuntimes.isEmpty())
        assertEquals("关闭会话未完成：进程仍在运行", rejected.error)
        assertTrue(base.markReconnecting().closingRuntimes.isEmpty())
    }
}
