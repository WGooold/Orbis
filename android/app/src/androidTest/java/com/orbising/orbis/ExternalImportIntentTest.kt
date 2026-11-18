package com.orbising.orbis

import android.content.ClipData
import android.content.Intent
import android.net.Uri
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ExternalImportIntentTest {
    private val one = Uri.parse("content://example.test/import/one")
    private val two = Uri.parse("content://example.test/import/two")

    // Android may mirror EXTRA_STREAM into ClipData. Each URI is imported only once per batch.
    @Test fun multipleStreamsDeduplicateAndKeepClipText() {
        val intent = Intent(Intent.ACTION_SEND_MULTIPLE).putParcelableArrayListExtra(Intent.EXTRA_STREAM, arrayListOf(one, two))
            .putExtra(Intent.EXTRA_TEXT, "note")
        intent.clipData = ClipData.newRawUri("file", one).apply {
            addItem(ClipData.Item("note"))
            addItem(ClipData.Item(Uri.parse("https://example.test/file")))
        }
        assertEquals(ExternalImportPayload("note\n\nhttps://example.test/file", listOf(one, two)), parseExternalImport(intent))
    }

    @Test fun viewOnlyAcceptsContentUrisAndDoesNotFollowLinks() {
        assertEquals(ExternalImportPayload(null, listOf(one)), parseExternalImport(Intent(Intent.ACTION_VIEW, one)))
        listOf("file:///data/file", "https://example.test/file").forEach { unsafe ->
            val result = runCatching { parseExternalImport(Intent(Intent.ACTION_VIEW, Uri.parse(unsafe))) }
            assertEquals(ImportProblem.UNSUPPORTED, (result.exceptionOrNull() as? ImportRejected)?.problem)
        }
    }
}
