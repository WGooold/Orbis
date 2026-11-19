package com.orbising.orbis

import android.net.Uri
import android.provider.DocumentsContract
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class AttachmentPickersInstrumentedTest {
    @Test fun localDocumentsPickerSeedsPrimaryDocumentsInitialUri() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val intent = LocalDocumentsPicker().createIntent(context, arrayOf("*/*"))
        @Suppress("DEPRECATION")
        val initialUri = intent.getParcelableExtra<Uri>(DocumentsContract.EXTRA_INITIAL_URI)
        assertEquals(localDocumentsInitialUri(), initialUri)
        assertEquals(LOCAL_DOCUMENTS_AUTHORITY, initialUri?.authority)
        assertEquals(LOCAL_DOCUMENTS_DOCUMENT_ID, DocumentsContract.getDocumentId(initialUri))
    }
}
