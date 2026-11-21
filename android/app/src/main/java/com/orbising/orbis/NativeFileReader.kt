package com.orbising.orbis

import android.widget.FrameLayout
import android.content.ClipData
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Color
import android.graphics.Matrix
import android.graphics.SurfaceTexture
import android.graphics.pdf.PdfRenderer
import android.media.ExifInterface
import android.media.MediaExtractor
import android.media.MediaFormat
import android.media.MediaPlayer
import android.net.Uri
import android.os.Environment
import android.os.Handler
import android.os.HandlerThread
import android.os.Looper
import android.os.ParcelFileDescriptor
import android.view.Surface
import android.view.TextureView
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.Image
import androidx.compose.foundation.gestures.rememberTransformableState
import androidx.compose.foundation.gestures.transformable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Share
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Slider
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.FileProvider
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.currentStateAsState
import java.io.ByteArrayInputStream
import java.io.File
import java.io.InputStream
import java.security.MessageDigest
import java.util.concurrent.Executors
import kotlin.math.max
import kotlin.math.roundToInt
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext

/** FILE-PREVIEW-02: both entry points share a decoder, not a transfer or a WebView. */
internal sealed interface NativeReaderSource {
    data class Snapshot(val bytes: ByteArray) : NativeReaderSource
    data class Download(val uri: Uri, val sha256: String?) : NativeReaderSource
}

internal sealed interface ReaderContent {
    data class Image(val raster: Bitmap) : ReaderContent
    data class Pdf(val file: File, val pageCount: Int, val first: Bitmap) : ReaderContent
    data class Text(val text: String, val truncated: Boolean) : ReaderContent
    data class Video(val file: File, val width: Int, val height: Int) : ReaderContent
}

internal object NativeFileReaderWorker {
    private val decoder = Mutex()
    private var sweptTemporaryFiles = false
    private val deletion = Executors.newSingleThreadExecutor { task -> Thread(task, "file-preview-cleanup").apply { isDaemon = true } }

    fun release(file: File) { deletion.execute { file.delete() } }

    suspend fun read(context: Context, source: NativeReaderSource, format: FilePreviewFormat, fullScreen: Boolean): ReaderContent {
        var temporary: File? = null
        try {
            val content = withContext(Dispatchers.IO) {
                decoder.withLock {
                    ensureActive()
                    check(!format.web)
                    val bytes = when (source) {
                        is NativeReaderSource.Snapshot -> source.bytes
                        is NativeReaderSource.Download -> {
                            val snapshot = checkNotNull(context.contentResolver.openInputStream(source.uri)).use { it.readPreview(format.budget) }
                            source.sha256?.let { expected ->
                                check(MessageDigest.getInstance("SHA-256").digest(snapshot).joinToString("") { "%02x".format(it) } == expected)
                            }
                            snapshot
                        }
                    }
                    check(bytes.size in 1..format.budget && format.matches(bytes))
                    ensureActive()
                    val edge = if (fullScreen) 2048 else 640
                    fun snapshot(suffix: String): File {
                        if (!sweptTemporaryFiles) {
                            sweptTemporaryFiles = true
                            context.cacheDir.listFiles { file -> file.name.startsWith("orbis-preview-") && file.extension in setOf("pdf", "mp4") }
                                ?.forEach { it.delete() }
                        }
                        return File.createTempFile("orbis-preview-", suffix, context.cacheDir).also {
                            temporary = it
                            it.writeBytes(bytes)
                        }
                    }
                    when (format) {
                        FilePreviewFormat.JPEG, FilePreviewFormat.PNG -> ReaderContent.Image(decodeImage(bytes, format, edge))
                        FilePreviewFormat.PDF -> {
                            val file = snapshot(".pdf")
                            pdf(file) { renderer ->
                                check(renderer.pageCount in 1..100)
                                ReaderContent.Pdf(file, renderer.pageCount, render(renderer, 0, edge))
                            }
                        }
                        FilePreviewFormat.TEXT -> {
                            val raw = bytes.toString(Charsets.UTF_8).replace("\r\n", "\n").replace('\r', '\n')
                            val limit = if (fullScreen) 16_384 else 4096
                            val end = raw.offsetByCodePoints(0, minOf(limit, raw.codePointCount(0, raw.length)))
                            val text = raw.take(end).lineSequence().take(250).joinToString("\n")
                            ReaderContent.Text(text, text.length < raw.length)
                        }
                        FilePreviewFormat.MP4 -> {
                            check(fullScreen)
                            val file = snapshot(".mp4")
                            val (width, height) = videoDimensions(file)
                            ReaderContent.Video(file, width, height)
                        }
                        else -> error("unsupported")
                    }
                }
            }
            temporary = null // The reader owns the resulting file (also on background/close).
            return content
        } finally { temporary?.let(::release) }
    }

    private fun decodeImage(bytes: ByteArray, format: FilePreviewFormat, edge: Int): Bitmap {
        val options = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size, options)
        val width = options.outWidth
        val height = options.outHeight
        check(width in 1..8192 && height in 1..8192 && width.toLong() * height <= 16_000_000)
        options.inJustDecodeBounds = false
        options.inSampleSize = 1
        while ((max(width, height) + options.inSampleSize - 1) / options.inSampleSize > edge) options.inSampleSize *= 2
        val decoded = checkNotNull(BitmapFactory.decodeByteArray(bytes, 0, bytes.size, options))
        if (format != FilePreviewFormat.JPEG) return decoded
        val orientation = runCatching {
            ExifInterface(ByteArrayInputStream(bytes)).getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL)
        }.getOrDefault(ExifInterface.ORIENTATION_NORMAL)
        val matrix = Matrix().apply {
            when (orientation) {
                ExifInterface.ORIENTATION_FLIP_HORIZONTAL -> setScale(-1f, 1f)
                ExifInterface.ORIENTATION_FLIP_VERTICAL -> setScale(1f, -1f)
                ExifInterface.ORIENTATION_ROTATE_90 -> setRotate(90f)
                ExifInterface.ORIENTATION_ROTATE_180 -> setRotate(180f)
                ExifInterface.ORIENTATION_ROTATE_270 -> setRotate(270f)
                ExifInterface.ORIENTATION_TRANSPOSE -> { setScale(-1f, 1f); postRotate(270f) }
                ExifInterface.ORIENTATION_TRANSVERSE -> { setScale(-1f, 1f); postRotate(90f) }
            }
        }
        if (matrix.isIdentity) return decoded
        return Bitmap.createBitmap(decoded, 0, 0, decoded.width, decoded.height, matrix, true).also { if (it !== decoded) decoded.recycle() }
    }

    private fun videoDimensions(file: File): Pair<Int, Int> {
        val extractor = MediaExtractor()
        try {
            file.inputStream().use { extractor.setDataSource(it.fd, 0, file.length()) }
            check(extractor.trackCount in 1..16)
            var video: Pair<Int, Int>? = null
            for (i in 0 until extractor.trackCount) {
                val track = extractor.getTrackFormat(i)
                val mime = track.getString(MediaFormat.KEY_MIME).orEmpty()
                if (!mime.startsWith("video/") && !mime.startsWith("audio/")) continue
                check(track.getLong(MediaFormat.KEY_DURATION) in 1..180_000_000L)
                if (mime.startsWith("video/")) {
                    val width = track.getInteger(MediaFormat.KEY_WIDTH)
                    val height = track.getInteger(MediaFormat.KEY_HEIGHT)
                    check(width in 1..1920 && height in 1..1920 && width * height <= 1920 * 1080)
                    val rotated = track.containsKey(MediaFormat.KEY_ROTATION) && track.getInteger(MediaFormat.KEY_ROTATION) % 180 != 0
                    video = video ?: if (rotated) height to width else width to height
                }
            }
            return checkNotNull(video)
        } finally { extractor.release() }
    }

    private fun <T> pdf(file: File, block: (PdfRenderer) -> T): T {
        val fd = ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_READ_ONLY)
        val renderer = try { PdfRenderer(fd) } catch (error: Exception) { fd.close(); throw error }
        return renderer.use(block)
    }

    suspend fun pdfPage(file: File, page: Int): Bitmap = withContext(Dispatchers.IO) {
        decoder.withLock { ensureActive(); pdf(file) { render(it, page, 2048) } }
    }

    private fun render(renderer: PdfRenderer, page: Int, edge: Int): Bitmap = renderer.openPage(page).use { opened ->
        check(opened.width > 0 && opened.height > 0)
        val scale = edge.toDouble() / max(opened.width, opened.height)
        val bitmap = Bitmap.createBitmap((opened.width * scale).roundToInt().coerceAtLeast(1),
            (opened.height * scale).roundToInt().coerceAtLeast(1), Bitmap.Config.ARGB_8888)
        bitmap.eraseColor(Color.WHITE)
        opened.render(bitmap, null, null, PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY)
        bitmap
    }

    private fun InputStream.readPreview(limit: Int): ByteArray {
        val output = java.io.ByteArrayOutputStream()
        val buffer = ByteArray(64 * 1024)
        while (true) {
            val count = read(buffer, 0, minOf(buffer.size, limit + 1 - output.size()))
            if (count < 0) break
            check(count > 0 && output.size() + count <= limit)
            output.write(buffer, 0, count)
        }
        return output.toByteArray()
    }
}

@Composable
internal fun NativeFileReader(source: NativeReaderSource, format: FilePreviewFormat, fullScreen: Boolean,
    modifier: Modifier = Modifier, onFailure: () -> Unit = {}) {
    val context = LocalContext.current.applicationContext
    var content by remember(source, format, fullScreen) { mutableStateOf<ReaderContent?>(null) }
    var failed by remember(source, format, fullScreen) { mutableStateOf(false) }
    val fail = { failed = true; content = null; onFailure() }
    LaunchedEffect(source, format, fullScreen) {
        val result = try { NativeFileReaderWorker.read(context, source, format, fullScreen) }
        catch (_: Exception) { ensureActive(); fail(); return@LaunchedEffect }
        val file = when (result) {
            is ReaderContent.Pdf -> result.file
            is ReaderContent.Video -> result.file
            else -> null
        }
        try {
            ensureActive()
            content = result
            if (file != null) awaitCancellation()
        } finally { file?.let(NativeFileReaderWorker::release) }
    }
    val current = content
    Box(modifier, contentAlignment = Alignment.Center) {
        when (current) {
            is ReaderContent.Image -> PreviewRaster(current.raster, fullScreen)
            is ReaderContent.Pdf -> if (fullScreen) PDFBrowser(current) else PreviewRaster(current.first, false)
            is ReaderContent.Text -> {
                val body: @Composable () -> Unit = {
                    Column(Modifier.fillMaxSize().padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        Text(current.text, fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.bodySmall,
                            maxLines = if (fullScreen) Int.MAX_VALUE else 14)
                        if (fullScreen && current.truncated) Text(L10n.tr("内容已截断"), style = MaterialTheme.typography.labelSmall)
                    }
                }
                if (fullScreen) SelectionContainer { Box(Modifier.fillMaxSize().verticalScroll(rememberScrollState())) { body() } }
                else body()
            }
            is ReaderContent.Video -> LocalVideoReader(current, fail)
            null -> if (failed) Text(L10n.tr("此文件无法预览")) else CircularProgressIndicator()
        }
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun PreviewRaster(bitmap: Bitmap, fullScreen: Boolean) {
    var scale by remember(bitmap) { mutableFloatStateOf(1f) }
    var pan by remember(bitmap) { mutableStateOf(Offset.Zero) }
    var viewport by remember { mutableStateOf(IntSize.Zero) }
    val transform = rememberTransformableState { zoom, change, _ ->
        scale = (scale * zoom).coerceIn(1f, 4f)
        val horizontal = viewport.width * (scale - 1f) / 2f
        val vertical = viewport.height * (scale - 1f) / 2f
        pan = Offset((pan.x + change.x).coerceIn(-horizontal, horizontal), (pan.y + change.y).coerceIn(-vertical, vertical))
    }
    Box(Modifier.fillMaxSize().clipToBounds().padding(8.dp).onSizeChanged { viewport = it }
        .then(if (fullScreen) Modifier.transformable(transform, canPan = { scale > 1f }) else Modifier)) {
        Image(remember(bitmap) { bitmap.asImageBitmap() }, null, Modifier.fillMaxSize().graphicsLayer {
            scaleX = scale; scaleY = scale; translationX = pan.x; translationY = pan.y
        }.testTag("native-file-raster"))
    }
}

@Composable
private fun PDFBrowser(pdf: ReaderContent.Pdf) {
    var page by remember(pdf.file) { mutableIntStateOf(0) }
    var other by remember(pdf.file) { mutableStateOf<Pair<Int, Bitmap>?>(null) }
    var failedPage by remember(pdf.file) { mutableIntStateOf(-1) }
    LaunchedEffect(pdf.file, page) {
        val target = page
        other = null; failedPage = -1
        if (target != 0) {
            try { other = target to NativeFileReaderWorker.pdfPage(pdf.file, target) }
            catch (_: Exception) { ensureActive(); failedPage = target }
        }
    }
    Column(Modifier.fillMaxSize(), horizontalAlignment = Alignment.CenterHorizontally) {
        Box(Modifier.weight(1f).fillMaxWidth(), contentAlignment = Alignment.Center) {
            val image = if (page == 0) pdf.first else other?.takeIf { it.first == page }?.second
            if (image != null) key(page) { PreviewRaster(image, true) }
            else if (failedPage == page) Text(L10n.tr("此文件无法预览")) else CircularProgressIndicator()
        }
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            NeumorphTextButton(L10n.tr("上一页"), onClick = { page-- }, enabled = page > 0)
            Text("${page + 1} / ${pdf.pageCount}", style = MaterialTheme.typography.labelMedium)
            NeumorphTextButton(L10n.tr("下一页"), onClick = { page++ }, enabled = page < pdf.pageCount - 1)
        }
    }
}

private data class Playback(val position: Int = 0, val duration: Int = 0, val playing: Boolean = false)

/** MediaPlayer and its local file descriptor belong to one Looper, never the Compose/UI thread. */
private class LocalPlayback(private val file: File, private val update: (Playback) -> Unit, private val failed: () -> Unit) : TextureView.SurfaceTextureListener {
    private val thread = HandlerThread("orbis-local-video").apply { start() }
    private val worker = Handler(thread.looper)
    private val main = Handler(Looper.getMainLooper())
    private var player: MediaPlayer? = null // worker-only
    private var ready = false
    private var generation = 0 // main-only
    @Volatile private var closed = false
    override fun onSurfaceTextureAvailable(texture: SurfaceTexture, width: Int, height: Int) {
        val surface = Surface(texture)
        val token = ++generation
        worker.post {
            try {
                if (closed) return@post
                releasePlayer()
                val next = MediaPlayer().also { player = it }
                next.setSurface(surface)
                next.setOnPreparedListener { ready = true; report(token) }
                next.setOnCompletionListener { report(token) }
                next.setOnErrorListener { _, _, _ -> main.post { if (!closed && generation == token) failed() }; true }
                file.inputStream().use { next.setDataSource(it.fd, 0, file.length()) }
                next.prepareAsync()
            } catch (_: Exception) { releasePlayer(); main.post { if (!closed && generation == token) failed() } }
            finally { surface.release() }
        }
    }
    override fun onSurfaceTextureSizeChanged(texture: SurfaceTexture, width: Int, height: Int) = Unit
    override fun onSurfaceTextureUpdated(texture: SurfaceTexture) = Unit
    override fun onSurfaceTextureDestroyed(texture: SurfaceTexture): Boolean {
        generation++
        worker.post { releasePlayer() }
        return true
    }
    private fun releasePlayer() { ready = false; player?.release(); player = null }
    private fun report(token: Int) {
        val current = player ?: return
        if (!ready) return
        val state = runCatching { Playback(current.currentPosition, current.duration, current.isPlaying) }.getOrNull() ?: return
        main.post { if (!closed && generation == token) update(state) }
    }
    fun poll() { val token = generation; worker.post { report(token) } }
    fun toggle() {
        val token = generation
        worker.post { if (ready) runCatching { player?.let { if (it.isPlaying) it.pause() else it.start() }; report(token) } }
    }
    fun seek(position: Int) {
        val token = generation
        worker.post { if (ready) runCatching { player?.seekTo(position); report(token) } }
    }
    fun close() {
        closed = true
        worker.post { try { releasePlayer() } finally { thread.quitSafely() } }
    }
}

@Composable
private fun LocalVideoReader(video: ReaderContent.Video, failed: () -> Unit) {
    var playback by remember(video.file) { mutableStateOf(Playback()) }
    var scrub by remember(video.file) { mutableFloatStateOf(-1f) }
    var controller by remember(video.file) { mutableStateOf<LocalPlayback?>(null) }
    DisposableEffect(video.file) {
        val playbackOwner = LocalPlayback(video.file, { playback = it }, failed)
        controller = playbackOwner
        onDispose { playbackOwner.close() }
    }
    val owner = controller
    LaunchedEffect(owner) { if (owner != null) while (true) { owner.poll(); delay(300) } }
    Column(Modifier.fillMaxSize(), horizontalAlignment = Alignment.CenterHorizontally) {
        Box(Modifier.weight(1f).fillMaxWidth(), contentAlignment = Alignment.Center) {
            if (owner != null) AndroidView(factory = { TextureView(it).apply { surfaceTextureListener = owner } },
                modifier = Modifier.aspectRatio(video.width.toFloat() / video.height).testTag("native-local-video"))
        }
        Slider(value = if (scrub >= 0f) scrub else playback.position.toFloat().coerceIn(0f, max(1, playback.duration).toFloat()),
            onValueChange = { scrub = it }, onValueChangeFinished = { if (scrub >= 0f) owner?.seek(scrub.toInt()); scrub = -1f },
            valueRange = 0f..max(1, playback.duration).toFloat(), enabled = playback.duration > 0,
            modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp))
        NeumorphTextButton(if (playback.playing) L10n.tr("暂停") else L10n.tr("播放"), onClick = { owner?.toggle() },
            enabled = playback.duration > 0, modifier = Modifier.testTag("file-preview-play"))
    }
}

@Composable
internal fun DownloadedFileReaderHost(state: RemoteState, content: @Composable (open: (String) -> Unit) -> Unit) {
    var openId by remember(state.hostId) { mutableStateOf<String?>(null) }
    val task = openId?.let { state.downloads[it] }?.takeIf { it.status == "completed" && it.savedLocation != null }
    OrbisPageHost(open = task != null, contentKey = task?.taskId, onBack = { openId = null }, underlay = {
        content { openId = it }
    }) { task?.let { DownloadedFileReaderPage(it, onBack = { openId = null }) } }
}

/** Only completed local store records can supply this input. MediaStore and legacy files share a content URI. */
internal suspend fun ownedDownloadUri(context: Context, task: ArtifactDownload): Uri? = withContext(Dispatchers.IO) {
    if (task.status != "completed") return@withContext null
    val location = task.savedLocation ?: return@withContext null
    runCatching {
        val uri = if (location.startsWith("content://")) {
            Uri.parse(location).also {
                val parts = it.pathSegments
                check(it.authority == "media" && it.query == null && parts.size == 3 && parts[1] == "downloads" &&
                    parts[2].toLongOrNull()?.let { id -> id >= 0 } == true)
            }
        } else {
            val file = File(location)
            val roots = listOfNotNull(context.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS), File(context.filesDir, Environment.DIRECTORY_DOWNLOADS))
            check(file.isFile && roots.any { file.canonicalFile.parentFile == it.canonicalFile })
            FileProvider.getUriForFile(context, "${context.packageName}.downloaded-files", file)
        }
        checkNotNull(context.contentResolver.openFileDescriptor(uri, "r")).close()
        uri
    }.getOrNull()
}

@Composable
internal fun DownloadedFileReaderPage(task: ArtifactDownload, onBack: () -> Unit) {
    val context = LocalContext.current
    val lifecycle by LocalLifecycleOwner.current.lifecycle.currentStateAsState()
    val active = LocalPageActive.current && lifecycle.isAtLeast(Lifecycle.State.STARTED)
    var uri by remember(task.taskId) { mutableStateOf<Uri?>(null) }
    var checked by remember(task.taskId) { mutableStateOf(false) }
    var cannotOpen by remember(task.taskId) { mutableStateOf(false) }
    LaunchedEffect(task.taskId, task.savedLocation) { uri = ownedDownloadUri(context, task); checked = true }
    Column(Modifier.fillMaxSize()) {
        Row(Modifier.fillMaxWidth().padding(horizontal = 6.dp), verticalAlignment = Alignment.CenterVertically) {
            NeumorphIconButton(onClick = onBack, icon = OrbisSymbols.ArrowBack, contentDescription = L10n.tr("返回"), size = 40.dp)
            FileNameText(task.displayName, Modifier.weight(1f))
            uri?.let { local ->
                NeumorphIconButton(onClick = { cannotOpen = !handOffDownload(context, local, task, share = true) },
                    icon = Icons.Outlined.Share, contentDescription = L10n.tr("分享"), compact = true)
            }
        }
        val local = uri
        val kind = FilePreviewFormat.fromName(task.artifact?.fileName ?: task.displayName)
        val format = kind?.takeUnless { it.web }
        Box(Modifier.weight(1f).fillMaxWidth().testTag("download-local-reader"), contentAlignment = Alignment.Center) {
            when {
                !checked -> CircularProgressIndicator()
                local == null -> Text(L10n.tr("此文件无法预览"))
                !active -> Unit
                format != null -> NativeFileReader(NativeReaderSource.Download(local, task.artifact?.sha256), format, true, Modifier.fillMaxSize())
                kind != null -> DownloadedWebPage(local, kind, task.artifact?.sha256, Modifier.fillMaxSize())
                else -> Unit // Original remains available for explicit handoff.
            }
        }
        if (local != null && active) {
            if (cannotOpen) Text(L10n.tr("没有可打开此文件的 App"), Modifier.padding(horizontal = 16.dp), style = MaterialTheme.typography.labelMedium)
            NeumorphTextButton(L10n.tr("用其他 App 打开"), onClick = { cannotOpen = !handOffDownload(context, local, task, share = false) },
                modifier = Modifier.align(Alignment.CenterHorizontally).padding(bottom = 12.dp))
        }
    }
}

/**
 * FILE-PREVIEW-03: a saved page in the same offline reader as chat previews, from a digest-checked copy of the
 * local file. Only the file itself is served; files it references are missing rather than fetched.
 */
@Composable
private fun DownloadedWebPage(uri: Uri, format: FilePreviewFormat, sha256: String?, modifier: Modifier) {
    val context = LocalContext.current
    var page by remember(uri) { mutableStateOf<ChatFilePreview.WebResource?>(null) }
    var failed by remember(uri) { mutableStateOf(false) }
    var painted by remember(uri) { mutableStateOf(false) }
    LaunchedEffect(uri, sha256) {
        page = withContext(Dispatchers.IO) {
            runCatching {
                val bytes = context.contentResolver.openInputStream(uri)!!.use { input ->
                    val buffer = ByteArray(format.budget + 1)
                    var count = 0
                    while (count < buffer.size) { val read = input.read(buffer, count, buffer.size - count); if (read < 0) break; count += read }
                    check(count in 1..format.budget)
                    buffer.copyOf(count)
                }
                val digest = java.security.MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
                check(sha256 == null || digest == sha256)
                val type = if (format == FilePreviewFormat.SVG) "image/svg+xml" else "text/html"
                val utf8 = runCatching { Charsets.UTF_8.newDecoder().decode(java.nio.ByteBuffer.wrap(bytes)) }.isSuccess
                ChatFilePreview.WebResource(if (format == FilePreviewFormat.SVG) "page.svg" else "page.html",
                    if (utf8) "$type; charset=utf-8" else type, bytes, digest)
            }.getOrNull()
        }
        failed = page == null
    }
    val entry = page
    Box(modifier.testTag("downloaded-web-page"), contentAlignment = Alignment.Center) {
        if (failed) Text(L10n.tr("此文件无法预览"))
        else if (entry != null) AndroidView(
            factory = { FrameLayout(it) }, modifier = Modifier.fillMaxSize(),
            update = { container ->
                if (container.childCount == 0) PreviewWebOwner.load(container, entry, fullScreen = true,
                    resources = { path, done -> done(entry.takeIf { path.trimStart('/') == it.path }) },
                    painted = { painted = true }, captured = {}, failed = { failed = true })
            },
            onRelease = PreviewWebOwner::release,
        )
        if (!painted && !failed) CircularProgressIndicator()
    }
}

private fun handOffDownload(context: Context, uri: Uri, task: ArtifactDownload, share: Boolean): Boolean = runCatching {
    val mime = task.artifact?.mimeType?.takeIf { it != "application/octet-stream" }
        ?: android.webkit.MimeTypeMap.getSingleton().getMimeTypeFromExtension(task.displayName.substringAfterLast('.', "").lowercase())
        ?: "application/octet-stream"
    val intent = Intent(if (share) Intent.ACTION_SEND else Intent.ACTION_VIEW).apply {
        if (share) { type = mime; putExtra(Intent.EXTRA_STREAM, uri) } else setDataAndType(uri, mime)
        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        clipData = ClipData.newRawUri(task.displayName, uri)
    }
    check(context.packageManager.queryIntentActivities(intent, android.content.pm.PackageManager.MATCH_DEFAULT_ONLY)
        .any { it.activityInfo.packageName != context.packageName })
    val chooser = Intent.createChooser(intent, null).putExtra(Intent.EXTRA_EXCLUDE_COMPONENTS,
        arrayOf(android.content.ComponentName(context, MainActivity::class.java)))
    context.startActivity(chooser)
}.isSuccess
