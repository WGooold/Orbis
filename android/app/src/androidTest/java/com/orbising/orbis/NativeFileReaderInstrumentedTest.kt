package com.orbising.orbis

import android.content.ContentValues
import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.pdf.PdfDocument
import android.provider.MediaStore
import android.view.View
import android.view.ViewGroup
import android.webkit.WebView
import androidx.activity.ComponentActivity
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.test.platform.app.InstrumentationRegistry
import java.io.ByteArrayOutputStream
import java.security.MessageDigest
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test

/** SC122 / SC123: native decode and offline reading of a published local download. */
class NativeFileReaderInstrumentedTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    @Test fun readersRenderOnlyBoundedNativeContent() = runBlocking {
        val bitmap = Bitmap.createBitmap(48, 32, Bitmap.Config.ARGB_8888).apply { eraseColor(Color.GREEN) }
        for ((format, output) in listOf(FilePreviewFormat.JPEG to Bitmap.CompressFormat.JPEG, FilePreviewFormat.PNG to Bitmap.CompressFormat.PNG)) {
            val bytes = ByteArrayOutputStream().also { bitmap.compress(output, 90, it) }.toByteArray()
            val image = NativeFileReaderWorker.read(compose.activity, NativeReaderSource.Snapshot(bytes), format, false) as ReaderContent.Image
            assertEquals(48, image.raster.width)
            image.raster.recycle()
        }
        bitmap.recycle()
        val document = PdfDocument()
        val bytes = try {
            for (index in 1..2) {
                val page = document.startPage(PdfDocument.PageInfo.Builder(90, 60, index).create())
                page.canvas.drawColor(if (index == 1) Color.GREEN else Color.BLUE)
                document.finishPage(page)
            }
            ByteArrayOutputStream().also(document::writeTo).toByteArray()
        } finally { document.close() }
        val pdf = NativeFileReaderWorker.read(compose.activity, NativeReaderSource.Snapshot(bytes), FilePreviewFormat.PDF, false) as ReaderContent.Pdf
        try {
            assertEquals(2, pdf.pageCount)
            assertEquals(Color.GREEN, pdf.first.getPixel(30, 30))
            val second = NativeFileReaderWorker.pdfPage(pdf.file, 1)
            assertEquals(Color.BLUE, second.getPixel(30, 30))
            second.recycle()
        } finally { pdf.first.recycle(); NativeFileReaderWorker.release(pdf.file) }
        val text = "{\"mode\":\"<script>read as text</script>\"}"
        val result = NativeFileReaderWorker.read(compose.activity, NativeReaderSource.Snapshot(text.encodeToByteArray()), FilePreviewFormat.TEXT, true)
        assertEquals(ReaderContent.Text(text, false), result)
    }

    @Test fun videoWaitsForThePlayControl() {
        val fixture = InstrumentationRegistry.getInstrumentation().context.assets.open("preview.mp4").use { it.readBytes() }
        compose.setContent { OrbisTheme { NativeFileReader(NativeReaderSource.Snapshot(fixture), FilePreviewFormat.MP4, true, Modifier.fillMaxSize()) } }
        val button = compose.onNodeWithTag("file-preview-play")
        compose.waitUntil(15_000) { compose.onAllNodes(hasTestTag("file-preview-play") and isEnabled()).fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithText(L10n.tr("播放")).assertIsDisplayed()
        compose.onNodeWithTag("native-local-video").assertIsDisplayed()
        compose.runOnIdle { assertFalse(hasWebView(compose.activity.window.decorView)) }
        button.performClick()
        compose.waitUntil(5_000) { compose.onAllNodes(hasText(L10n.tr("暂停"))).fetchSemanticsNodes().isNotEmpty() }
    }

    @Test fun downloadCardOpensLocalCopyEvenWithoutAConnection() {
        val resolver = compose.activity.contentResolver
        val text = "Verified local download"
        val bytes = text.encodeToByteArray()
        val uri = checkNotNull(resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, ContentValues().apply {
            put(MediaStore.Downloads.DISPLAY_NAME, "orbis-selection-fixture.txt")
            put(MediaStore.Downloads.MIME_TYPE, "text/plain")
            put(MediaStore.Downloads.IS_PENDING, 1)
        }))
        try {
            checkNotNull(resolver.openOutputStream(uri)).use { it.write(bytes) }
            resolver.update(uri, ContentValues().apply { put(MediaStore.Downloads.IS_PENDING, 0) }, null, null)
            val hash = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
            val task = ArtifactDownload("done", "host", displayName = "fixture.txt", status = "completed", savedLocation = uri.toString(),
                artifact = RemoteArtifact("fixture", "fixture.txt", "text/plain", bytes.size.toLong(), hash))
            val incomplete = task.copy(taskId = "partial", displayName = "unfinished.txt", status = "downloading")
            val state = RemoteState(hostId = "host", e2eReady = false, downloads = listOf(task, incomplete).associateBy { it.taskId })
            var transfers = 0
            compose.setContent { OrbisTheme {
                DownloadedFileReaderHost(state) { open -> AllDownloadsScreen(state, onBack = {}, onBrowse = {}, onBrowseInto = {}, onBrowseUp = {},
                    onDismissBrowse = {}, onDownload = { transfers++ }, onRetry = { transfers++ }, onCancel = {}, onDelete = {}, onOpen = open) }
            } }
            compose.onNodeWithTag("download-card-partial").performClick()
            compose.onNodeWithTag("download-local-reader").assertDoesNotExist()
            compose.onNodeWithTag("download-card-done").performClick()
            compose.waitUntil(15_000) { compose.onAllNodes(hasText(text)).fetchSemanticsNodes().isNotEmpty() }
            compose.onNodeWithText(text).assertIsDisplayed()
            compose.runOnIdle { assertEquals(0, transfers); assertFalse(hasWebView(compose.activity.window.decorView)) }
        } finally { resolver.delete(uri, null, null) }
    }

    private fun hasWebView(view: View): Boolean = view is WebView || view is ViewGroup &&
        (0 until view.childCount).any { hasWebView(view.getChildAt(it)) }
}
