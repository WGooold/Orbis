package com.orbising.orbis

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.DocumentsContract
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class AttachmentPickersInstrumentedTest {
    @Test fun filesStartInLocalDocumentsAndCancellationAddsNothing() {
        val picker = LocalDocumentsPicker()
        val intent = picker.createIntent(ApplicationProvider.getApplicationContext<Context>(), arrayOf("*/*"))
        assertEquals(Intent.ACTION_OPEN_DOCUMENT, intent.action)
        assertEquals("content://com.android.externalstorage.documents/document/primary%3ADocuments",
            intent.getParcelableExtra<Uri>(DocumentsContract.EXTRA_INITIAL_URI)?.toString())
        assertTrue(intent.getBooleanExtra(Intent.EXTRA_ALLOW_MULTIPLE, false))
        assertTrue(picker.parseResult(Activity.RESULT_CANCELED, null).isEmpty())
    }
}
