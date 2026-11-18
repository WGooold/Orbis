package com.orbising.orbis

import java.io.ByteArrayInputStream
import java.io.File
import java.io.IOException
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class ExternalImportStoreTest {
    @get:Rule val temporary = TemporaryFolder()
    private fun source(name: String, bytes: String) = ImportSource(name) { ByteArrayInputStream(bytes.toByteArray()) }

    // Source bytes and mixed text survive permission loss/process re-open, not just a recorded URI.
    @Test fun publishesOwnCopyAndDeletesByBatchId() {
        val root = temporary.newFolder()
        val store = ExternalImportStore(root)
        val body = "备注\nhttps://example.test/file"
        val batch = store.save(body, listOf(source("../dir/报价单.xlsx", "first"), source("坏\\lab\u202e.pdf", "second")))
        val reopened = ExternalImportStore(root)
        assertEquals(listOf(batch), reopened.list())
        assertEquals(body, batch.text)
        assertEquals(listOf(ImportedFile("报价单.xlsx", 5), ImportedFile("lab.pdf", 6)), batch.files)
        assertEquals("first", File(root, "ready-${batch.id}/file-0").readText())
        assertEquals("second", File(root, "ready-${batch.id}/file-1").readText())
        reopened.delete("../ready-${batch.id}")
        assertEquals(listOf(batch), reopened.list())
        reopened.delete(batch.id)
        assertTrue(reopened.list().isEmpty())
        assertTrue(root.list().orEmpty().isEmpty())
    }

    // A late failed read must not publish the earlier members or leave their private bytes behind.
    @Test fun failedBatchIsNotPublishedAndItsStagingIsRemoved() {
        val root = temporary.newFolder()
        val store = ExternalImportStore(root)
        assertThrows(IOException::class.java) {
            store.save(null, listOf(source("one", "data"), ImportSource("two") { throw IOException() }))
        }
        assertTrue(store.list().isEmpty())
        assertTrue(root.list().orEmpty().isEmpty())
    }

    @Test fun actualBytesCountTowardBatchAndInboxLimits() {
        val root = temporary.newFolder()
        val store = ExternalImportStore(root, batchBytes = 8, inboxBytes = 11)
        val batch = store.save("é", listOf(source("x", "abcd")))
        val full = assertThrows(ImportRejected::class.java) { store.save(null, listOf(source("y", "123456"))) }
        assertEquals(ImportProblem.FULL, full.problem)
        assertEquals(listOf(batch), store.list())
        store.delete(batch.id)
        val limited = assertThrows(ImportRejected::class.java) {
            store.save(null, listOf(source("x", "12345"), source("x", "1234")))
        }
        assertEquals(ImportProblem.LIMIT, limited.problem)
        assertEquals(ImportProblem.LIMIT,
            assertThrows(ImportRejected::class.java) { store.save("界".repeat(100_000), emptyList()) }.problem)
        assertTrue(store.list().isEmpty())
    }

    @Test fun stagingAfterInterruptionIsNotAnItemAndGetsCleanedOnSave() {
        val root = temporary.newFolder()
        File(root, "stage-crashed").mkdir()
        File(root, "stage-crashed/file-0").writeText("partial")
        val store = ExternalImportStore(root)
        assertTrue(store.list().isEmpty())
        repeat(16) { store.save("note $it", emptyList()) }
        assertFalse(File(root, "stage-crashed").exists())
        assertEquals(16, store.list().size)
        assertEquals(ImportProblem.FULL,
            assertThrows(ImportRejected::class.java) { store.save("note 17", emptyList()) }.problem)
    }
}
