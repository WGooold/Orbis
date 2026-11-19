package com.orbising.orbis

import android.content.ContentResolver
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Process
import android.content.pm.PackageManager
import android.provider.OpenableColumns

internal data class ExternalImportPayload(val text: String?, val files: List<Uri>)

internal fun isExternalImportAction(action: String?): Boolean =
    action == Intent.ACTION_SEND || action == Intent.ACTION_SEND_MULTIPLE || action == Intent.ACTION_VIEW

/** Do not resolve filesystem paths, open links, or traverse nested Intents. */
@Suppress("DEPRECATION") // The old Parcelable accessors also work on Android 8–12; wrong types fail at admission.
internal fun parseExternalImport(intent: Intent): ExternalImportPayload {
    if (!isExternalImportAction(intent.action)) reject(ImportProblem.UNSUPPORTED)
    if (intent.action == Intent.ACTION_VIEW) {
        val uri = intent.data ?: reject(ImportProblem.EMPTY)
        if (uri.scheme != ContentResolver.SCHEME_CONTENT) reject(ImportProblem.UNSUPPORTED)
        return ExternalImportPayload(null, listOf(uri))
    }
    val files = linkedSetOf<Uri>()
    val text = linkedSetOf<String>()
    var textUnits = 0
    fun addText(value: CharSequence?) {
        if (value != null && value.length > 256 * 1024) reject(ImportProblem.LIMIT)
        val body = value?.toString()?.takeUnless(String::isBlank) ?: return
        if (text.add(body)) textUnits += body.length + 2
        if (textUnits - 2 > 256 * 1024) reject(ImportProblem.LIMIT)
    }
    fun addFile(uri: Uri) {
        if (uri.scheme != ContentResolver.SCHEME_CONTENT) reject(ImportProblem.UNSUPPORTED)
        files.add(uri)
        if (files.size > MAX_ATTACHMENTS_PER_MESSAGE) reject(ImportProblem.LIMIT)
    }
    addText(intent.getCharSequenceExtra(Intent.EXTRA_TEXT))
    if (intent.action == Intent.ACTION_SEND_MULTIPLE) {
        intent.getParcelableArrayListExtra<Uri>(Intent.EXTRA_STREAM)?.forEach(::addFile)
    } else {
        intent.getParcelableExtra<Uri>(Intent.EXTRA_STREAM)?.let(::addFile)
    }
    intent.clipData?.let { clip ->
        if (clip.itemCount > 2 * MAX_ATTACHMENTS_PER_MESSAGE) reject(ImportProblem.LIMIT)
        for (index in 0 until clip.itemCount) {
            val item = clip.getItemAt(index)
            val uri = item.uri
            if (uri != null && uri.scheme in setOf("http", "https")) addText(uri.toString())
            else if (uri != null) addFile(uri)
            if (item.text != null) addText(item.text)
        }
    }
    return ExternalImportPayload(text.joinToString("\n\n").ifEmpty { null }, files.toList())
}

internal fun Context.stageExternalImport(store: ExternalImportStore, payload: ExternalImportPayload): ExternalImportBatch =
    store.save(payload.text, payload.files.map { uri ->
        // An explicit grant for this URI is required; never use an unrelated ambient read permission.
        if (checkUriPermission(uri, Process.myPid(), Process.myUid(), Intent.FLAG_GRANT_READ_URI_PERMISSION) !=
            PackageManager.PERMISSION_GRANTED) reject(ImportProblem.UNREADABLE)
        val name = contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { cursor ->
            if (cursor.moveToFirst() && cursor.columnCount > 0) cursor.getString(0) else null
        }
        ImportSource(name) { contentResolver.openInputStream(uri) ?: reject(ImportProblem.UNREADABLE) }
    })
