package com.orbising.orbis

import java.io.ByteArrayInputStream
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class ExternalImportDeliveryTest {
    @get:Rule val temporary = TemporaryFolder()
    private val target = ExternalImportTarget("host", "pairing", "session", "/project")
    private val destination = ExternalImportDestination(target, "Computer", "Agent")
    private val runtime = RuntimeSummary("runtime", "Agent", target.cwd, "running", target.sessionId)

    // IMPORT-06: receipt of both uploads, a durable identity, and one immutable target precede the command.
    @Test fun waitsForEveryFileAndUsesOnlyReadAfterUnconfirmedSend() = runBlocking {
        val root = temporary.newFolder()
        val inbox = ExternalImportStore(root)
        val saved = inbox.save("/not-a-command", listOf("a.txt", "b.txt").map { name -> ImportSource(name) {
            ByteArrayInputStream(name.toByteArray())
        } })
        val batch = inbox.assign(saved.id, destination)
        val beforeFirstFinish = CompletableDeferred<Unit>()
        val beforeSecondFinish = CompletableDeferred<Unit>()
        val releaseFirst = CompletableDeferred<Unit>()
        val releaseSecond = CompletableDeferred<Unit>()
        val commands = mutableListOf<JsonObject>()
        val delivery = ExternalImportDelivery()
        val attempt = withTimeout(5_000) {
            val sending = async {
                delivery.send(batch, inbox, "", { runtime }, { true }, upload = { source, runtimeId ->
                    assertEquals(runtime.runtimeId, runtimeId)
                    assertEquals(source.metadata.name, source.file.readText())
                    assertEquals(64, ArtifactUploadStore.inspectImport(source).length)
                    if (source.metadata.name == "a.txt") { beforeFirstFinish.complete(Unit); releaseFirst.await() }
                    else { beforeSecondFinish.complete(Unit); releaseSecond.await() }
                    "/project/${source.metadata.name}"
                }, request = { expected, command ->
                    commands += expected.wire(target, command)
                    assertEquals(expected, ExternalImportStore(root).list().single().attempt)
                    assertEquals(ExternalImportReceipt.PENDING, expected.receipt)
                    ExternalImportReceipt.UNCONFIRMED
                })
            }
            beforeFirstFinish.await()
            assertNull(inbox.list().single().attempt)
            releaseFirst.complete(Unit)
            beforeSecondFinish.await()
            assertNull(inbox.list().single().attempt)
            releaseSecond.complete(Unit)
            sending.await()
            val persisted = ExternalImportStore(root).list().single()
            val original = checkNotNull(persisted.attempt)
            assertEquals(ExternalImportReceipt.UNCONFIRMED, original.receipt)
            val resumed = ExternalImportDelivery()
            try {
                resumed.send(persisted, inbox, "", { runtime }, { true }, { _, _ -> error("unexpected upload") }, { _, _ -> error("unexpected replay") })
                fail("unconfirmed delivery must not be resent")
            } catch (error: ImportRejected) { assertEquals(ImportProblem.TARGET_UNAVAILABLE, error.problem) }
            resumed.check(persisted, inbox, { true }) { id, command ->
                assertEquals(original, id)
                assertNull(command)
                commands += id.wire(target, null)
                ExternalImportReceipt.ACCEPTED
            }
            original
        }
        assertEquals(2, commands.size)
        assertEquals("runtime.command", commands.first().importString("type"))
        val command = commands.first()["command"] as JsonObject
        assertEquals(attempt.id, command.importString("messageId"))
        assertEquals("followUp", command.importString("delivery"))
        assertTrue(command.importString("text")!!.endsWith("\n\n/not-a-command"))
        assertEquals(listOf("/project/a.txt", "/project/b.txt"), (command["attachments"] as kotlinx.serialization.json.JsonArray).map { (it as JsonPrimitive).content })
        assertEquals("external-import.result.read", commands.last().importString("type"))
        assertEquals(target.wire(), commands.last()["importTarget"])
        assertEquals(ExternalImportReceipt.ACCEPTED, inbox.list().single().attempt?.receipt)
        inbox.recordDelivery(batch.id, attempt.id, ExternalImportReceipt.UNKNOWN)
        assertEquals(ExternalImportReceipt.ACCEPTED, inbox.list().single().attempt?.receipt)
    }

    // Even a same-protocol Host without the feature or a moved session cannot receive any input.
    @Test fun oldHostAndChangedRuntimeLeaveTheDraftWithoutACommand() = runBlocking {
        val inbox = ExternalImportStore(temporary.newFolder())
        val batch = inbox.assign(inbox.save(null, listOf(ImportSource("notes") { ByteArrayInputStream(byteArrayOf(1)) })).id, destination)
        val delivery = ExternalImportDelivery()
        try {
            delivery.send(batch, inbox, "", { runtime }, { false }, { _, _ -> error("legacy upload") }, { _, _ -> error("legacy fallback") })
            fail("legacy host must be rejected")
        } catch (error: ImportRejected) { assertEquals(ImportProblem.HOST_UPGRADE, error.problem) }
        var active = runtime
        try {
            delivery.send(batch, inbox, "", { active }, { true }, { _, _ -> active = runtime.copy(runtimeId = "replacement"); "/project/file" },
                { _, _ -> error("a changed runtime must not receive the send") })
            fail("changed runtime must be rejected")
        } catch (error: ImportRejected) { assertEquals(ImportProblem.TARGET_UNAVAILABLE, error.problem) }
        assertEquals(batch, inbox.list().single())
    }

    @Test fun checksUploadBytesAndCorrelatesOnlyTheOriginalResult() {
        val upload = UploadTask("task", runtime.runtimeId, target.hostId, "", "data.txt", 3, "hash", "/project")
        fun finish(size: Int, hash: String) = buildJsonObject { put("path", "/project/data.txt"); put("size", size); put("sha256", hash) }
        assertNull(upload.verifiedImportPath(finish(3, "other")))
        assertNull(upload.verifiedImportPath(finish(2, "hash")))
        assertEquals("/project/data.txt", upload.verifiedImportPath(finish(3, "hash")))
        val attempt = ExternalImportAttempt("command", runtime.runtimeId, ExternalImportReceipt.PENDING)
        val result = buildJsonObject {
            put("type", "external-import.result"); put("commandId", "command"); put("runtimeId", runtime.runtimeId)
            put("importTarget", target.wire()); put("status", "accepted")
        }
        assertEquals(true to null, importReceiptFor(result, attempt, target.copy(cwd = "/elsewhere"), query = true))
        assertEquals(true to ExternalImportReceipt.ACCEPTED, importReceiptFor(result, attempt, target, query = true))
        assertEquals(true to null, importReceiptFor(result, attempt, target, query = false))
    }
}
