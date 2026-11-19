package com.orbising.orbis

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.DocumentsContract
import androidx.activity.result.contract.ActivityResultContracts

internal const val LOCAL_DOCUMENTS_AUTHORITY = "com.android.externalstorage.documents"
internal const val LOCAL_DOCUMENTS_DOCUMENT_ID = "primary:Documents"

internal fun localDocumentsInitialUri(): Uri =
    DocumentsContract.buildDocumentUri(LOCAL_DOCUMENTS_AUTHORITY, LOCAL_DOCUMENTS_DOCUMENT_ID)

internal class LocalDocumentsPicker : ActivityResultContracts.OpenMultipleDocuments() {
    override fun createIntent(context: Context, input: Array<String>): Intent =
        super.createIntent(context, input).apply {
            putExtra(DocumentsContract.EXTRA_INITIAL_URI, localDocumentsInitialUri())
        }
}
