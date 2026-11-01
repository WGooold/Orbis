package com.orbising.orbis

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * ADR-0049 §6.1–§6.2 `waiting`：附件上传中发送。iOS `WaitingSendTests.swift` 与本文件用例一一对应；
 * [HostConnection] 的写入与上传回调在这里用同样的纯状态函数模拟。
 */
class WaitingSendTest {
    private val runtime = RuntimeSummary("a", "Agent", "/repo", "idle", "session-a")
    private var counter = 0

    private fun upload(id: String, name: String = "hello.txt") =
        UploadTask(taskId = id, runtimeId = "a", sourceUri = "content://$id", displayName = name, size = 11, sha256 = "x", directory = "/repo", status = "uploading")

    private fun setup(vararg uploads: UploadTask) = RemoteState(e2eReady = true, connection = RelayConnection.ONLINE,
        runtimes = mapOf("a" to runtime), uploads = uploads.associateBy(UploadTask::taskId)).ledgerOpenConnection()

    /** 与 HostConnection.sendWhenReady 相同。 */
    private fun send(state: RemoteState, text: String, vararg uploadIds: String): RemoteState {
        val pending = uploadIds.mapNotNull { state.uploads[it] }.filter { it.status != "completed" }
        val (next, creation) = state.createWaitingSend("command-${++counter}", "message-$counter", "a", "session-a", text, null,
            uploadIds.toList(), pending, System.currentTimeMillis())
        assertTrue(creation is LedgerCreation.Created)
        return next
    }

    /** 与 HostConnection.publishUpload 相同：上传结束时交给账本。 */
    private fun settle(state: RemoteState, id: String, path: String? = null, error: String? = null): RemoteState {
        val task = state.uploads.getValue(id)
        val next = if (path != null) task.copy(status = "completed", remotePath = path) else task.copy(status = "failed", error = error)
        return state.copy(uploads = state.uploads + (id to next)).ledgerUploadSettled(id, path != null,
            "附件上传失败：${next.displayName}" + (next.error?.let { "（$it）" } ?: ""))
    }

    /** 与 HostConnection.flushReadySends 相同：依次写入轮到的等待消息，返回写入的正文。 */
    private fun flush(state: RemoteState): Pair<RemoteState, List<String>> {
        var current = state
        val written = mutableListOf<String>()
        while (true) {
            val op = current.readySends().firstOrNull() ?: break
            val payload = op.payload as LedgerPayload.Send
            val sending = current.pendingSends.getValue(payload.messageId)
            val paths = sending.uploadIds.mapNotNull { current.uploads[it]?.remotePath }
            current = current.waitingWritten(op.opId, payload.messageId, "a", paths, System.currentTimeMillis())
            written += sending.text
        }
        return current to written
    }

    private fun state(state: RemoteState, text: String) = state.pendingSends.values.first { it.text == text }.state

    @Test fun theBubbleAppearsAtOnceAndIsWrittenAfterTheUpload() {
        var state = send(setup(upload("u1")), "看看这个", "u1")
        assertEquals(PendingSendState.Waiting("上传中：hello.txt"), state(state, "看看这个"))
        assertTrue(flush(state).second.isEmpty())
        val (written, texts) = flush(settle(state, "u1", path = "/repo/hello.txt"))
        state = written
        assertEquals(listOf("看看这个"), texts)
        assertEquals(PendingSendState.Sending, state(state, "看看这个"))
        assertEquals(listOf("/repo/hello.txt"), state.pendingSends.values.single().attachments)
        assertTrue(state.ledger.operations.isEmpty())
    }

    @Test fun aLaterMessageWaitsBehindTheEarlierOneAndKeepsTheOrder() {
        var state = send(setup(upload("u1")), "第一条", "u1")
        assertTrue(state.ledger.blocks(OperationKinds.sendGroup("session-a")))
        state = send(state, "第二条")
        assertEquals(PendingSendState.Waiting("等待前一条发送"), state(state, "第二条"))
        assertTrue(flush(state).second.isEmpty())
        assertEquals(listOf("第一条", "第二条"), flush(settle(state, "u1", path = "/repo/hello.txt")).second)
    }

    @Test fun anUploadFailureFailsOnlyItsOwnMessage() {
        val state = send(send(setup(upload("u1")), "第一条", "u1"), "第二条")
        val (failed, written) = flush(settle(state, "u1", error = "磁盘已满"))
        assertEquals(PendingSendState.Failed("附件上传失败：hello.txt（磁盘已满）"), state(failed, "第一条"))
        assertEquals(listOf("第二条"), written)
    }

    @Test fun disconnectDoesNotChangeAWaitingMessage() {
        val state = send(setup(upload("u1")), "看看这个", "u1").markReconnecting()
        assertEquals(PendingSendState.Waiting("上传中：hello.txt"), state(state, "看看这个"))
    }

    @Test fun restoringAFailedUploadKeepsItsUploadsForTheComposer() {
        val failed = settle(send(setup(upload("u1")), "看看这个", "u1"), "u1", error = "磁盘已满")
        val send = failed.pendingSends.values.single()
        assertEquals(listOf("u1"), send.uploadIds)
        assertTrue(send.attachments.isEmpty())
    }

    @Test fun aWaitingMessageReturnsToTheComposerAfterTheProcessExits() {
        val draftKey = "draft-key"
        val all = mapOf(draftKey to "已有草稿", waitingDraftKey(draftKey, "m1") to "还没传完", waitingDraftKey(draftKey, "m2") to "仍在等待")
        val (drafts, removed) = restoreWaitingDrafts(all, live = setOf("m2"))
        assertEquals(mapOf(draftKey to "已有草稿\n\n还没传完"), drafts)
        assertEquals(setOf(waitingDraftKey(draftKey, "m1")), removed)
    }
}
