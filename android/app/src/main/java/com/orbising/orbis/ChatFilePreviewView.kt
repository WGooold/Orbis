package com.orbising.orbis

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.view.MotionEvent
import android.webkit.GeolocationPermissions
import android.webkit.JsPromptResult
import android.webkit.JsResult
import android.webkit.PermissionRequest
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebStorage
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import java.io.ByteArrayInputStream
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Description
import androidx.compose.material.icons.outlined.Image
import androidx.compose.material.icons.outlined.Language
import androidx.compose.material.icons.outlined.Movie
import androidx.compose.material.icons.outlined.OpenInFull
import androidx.compose.material.icons.outlined.PictureAsPdf
import androidx.compose.material.icons.rounded.ExpandLess
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.layout.boundsInWindow
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.flow.map

internal class FilePreviewActions(
    val preview: ChatFilePreview,
    val session: String,
    val open: (ChatFilePreview.Key) -> Unit,
)
internal val LocalFilePreviewActions = staticCompositionLocalOf<FilePreviewActions?> { null }

@Composable
internal fun ChatFilePreviewHost(actions: FilePreviewActions?, content: @Composable () -> Unit) {
    val preview = actions?.preview
    val session = actions?.session
    val active = LocalPageActive.current
    val fullScreenId by remember(preview, session) {
        preview?.selection?.map { state -> state?.takeIf { it.key.session == session && it.fullScreen }?.id }
            ?.distinctUntilChanged() ?: flowOf(null)
    }.collectAsState(initial = null)
    DisposableEffect(preview, session) { onDispose { if (session != null) preview?.closeSession(session) } }
    androidx.compose.runtime.LaunchedEffect(preview, session, active) { if (!active && session != null) preview?.closeSession(session) }
    OrbisPageHost(
        open = fullScreenId != null, contentKey = fullScreenId,
        onBack = { fullScreenId?.let { preview?.setFullScreen(it, false) } },
        underlay = { CompositionLocalProvider(LocalFilePreviewActions provides actions) { content() } },
    ) {
        val selection = preview?.selection?.value?.takeIf { it.id == fullScreenId }
        if (preview != null && selection != null) FilePreviewPage(selection.key.name, onBack = { preview.setFullScreen(selection.id, false) }) {
            if (active) PreviewReader(preview, selection, fullScreen = true, modifier = Modifier.fillMaxSize().testTag("chat-file-preview-reader"))
        }
    }
}

/**
 * FILE-PREVIEW-05: chat and Downloads readers share the ordinary page frame. The page paints its own background from
 * the first entrance frame (the source never shows through) and its header and reader stay inside the system bars.
 */
@Composable
internal fun FilePreviewPage(name: String, onBack: () -> Unit, actions: @Composable RowScope.() -> Unit = {},
    content: @Composable BoxScope.() -> Unit) {
    Scaffold(containerColor = MaterialTheme.colorScheme.background, topBar = {
        RemoteTopAppBar(title = { FileNameText(name, style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.SemiBold) },
            navigationIcon = { NeumorphIconButton(onClick = onBack, icon = OrbisSymbols.ArrowBack, contentDescription = L10n.tr("返回"), size = 40.dp) },
            actions = actions)
    }) { padding ->
        Box(Modifier.fillMaxSize().padding(padding), contentAlignment = Alignment.Center) { content() }
    }
}

/**
 * File cards collect only their own projection. Opening one never republishes the chat list.
 * FILE-PREVIEW-03: tapping the file opens its preview in place; the trailing button saves the original.
 * Without a preview path for this type, [fallback] (the ordinary download card) is shown unchanged.
 */
@Composable
internal fun ChatFilePreviewCard(block: String, source: ChatFilePreview.Source, name: String, allowsPreview: Boolean = true,
    downloading: Boolean = false, downloadTag: String = "message-file-reference", onDownload: () -> Unit, fallback: @Composable () -> Unit) {
    val actions = LocalFilePreviewActions.current
    val format = FilePreviewFormat.fromName(name)
    if (actions == null || !allowsPreview || LocalStreamingText.current || format == null) { fallback(); return }
    val preview = actions.preview
    val availability by preview.availability.collectAsState()
    val key = remember(actions.session, block, source, name) { ChatFilePreview.Key(actions.session, block, source, name) }
    val selection by remember(preview, key) {
        preview.selection.map { it?.takeIf { state -> state.key == key } }.distinctUntilChanged()
    }.collectAsState(null)
    val current = selection
    if (current == null && !(if (format.web) availability.web else availability.native)) { fallback(); return }
    val active = LocalPageActive.current
    val colors = MaterialTheme.colorScheme
    Column(Modifier.fillMaxWidth().then(if (current?.phase == ChatFilePreview.Phase.LOADING) {
        Modifier.onGloballyPositioned { if (it.size.height > 0 && it.boundsInWindow().isEmpty) preview.fileHidden(key, current.id) }
    } else Modifier), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            val label = if (current == null) L10n.tr("预览 {0}", name) else L10n.tr("收起 {0}", name)
            NeumorphSurface(onClick = { if (current == null) actions.open(key) else preview.close(key) }, enabled = active,
                shape = RemoteUi.ControlShape, selectionSelected = current != null,
                modifier = Modifier.weight(1f).semantics { contentDescription = label }
                    .testTag(if (current == null) "chat-file-preview-open" else "chat-file-preview-close")) {
                Row(Modifier.padding(horizontal = 12.dp, vertical = 10.dp), verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Icon(format.icon, contentDescription = null, tint = colors.primary)
                    FileNameText(name, Modifier.weight(1f), fontWeight = FontWeight.SemiBold)
                    preview.knownSize(source)?.let {
                        Text(formatByteCount(it.toLong()), style = MaterialTheme.typography.labelSmall, color = colors.onSurfaceVariant, maxLines = 1)
                    }
                    Icon(if (current == null) OrbisSymbols.KeyboardArrowDown else Icons.Rounded.ExpandLess, contentDescription = null,
                        tint = colors.onSurfaceVariant)
                }
            }
            Box(contentAlignment = Alignment.Center) {
                NeumorphIconButton(onClick = onDownload, icon = OrbisSymbols.Download, contentDescription = L10n.tr("下载原文件"),
                    compact = true, enabled = active && !downloading, modifier = Modifier.testTag(downloadTag))
                if (downloading) CircularProgressIndicator(Modifier.size(16.dp), strokeWidth = 2.dp)
            }
        }
        if (current != null && !(current.phase == ChatFilePreview.Phase.READY && format == FilePreviewFormat.MP4)) {
            var panelVisible by remember(current.id) { mutableStateOf(false) }
            val shape = RemoteUi.ControlShape
            val ready = current.phase == ChatFilePreview.Phase.READY
            // One surface for loading, rendering and the result; a page is white only once it has painted.
            Box(Modifier.fillMaxWidth().height(240.dp).clip(shape).background(colors.surfaceVariant)
                .border(1.dp, colors.outlineVariant, shape)
                .testTag(if (ready) "chat-file-preview-fullscreen" else "chat-file-preview-panel")
                .onGloballyPositioned { panelVisible = !it.boundsInWindow().isEmpty }, contentAlignment = Alignment.Center) {
                when (current.phase) {
                    ChatFilePreview.Phase.LOADING -> Column(horizontalAlignment = Alignment.CenterHorizontally,
                        verticalArrangement = Arrangement.spacedBy(10.dp), modifier = Modifier.testTag("chat-file-preview-loading")
                            .semantics { contentDescription = L10n.tr("正在加载预览") }) {
                        val progress = current.progress
                        if (progress != null && progress.total > 0) {
                            LinearProgressIndicator(progress = { progress.received.toFloat() / progress.total }, Modifier.width(180.dp))
                            Text("${formatByteCount(progress.received.toLong())} / ${formatByteCount(progress.total.toLong())}",
                                style = MaterialTheme.typography.labelSmall, color = colors.onSurfaceVariant)
                        } else CircularProgressIndicator()
                    }
                    ChatFilePreview.Phase.READY -> {
                        val still = current.snapshot
                        if (still != null) Image(still.asImageBitmap(), contentDescription = null, contentScale = ContentScale.Crop,
                            alignment = Alignment.TopCenter, modifier = Modifier.fillMaxSize().testTag("chat-file-preview-snapshot"))
                        else if (active && panelVisible && !current.fullScreen) PreviewReader(preview, current, fullScreen = false, Modifier.fillMaxSize())
                        // Above the reader, so the inline page never takes the tap.
                        Box(Modifier.fillMaxSize().clickable(enabled = active, role = Role.Button,
                            onClickLabel = L10n.tr("全屏预览")) { preview.setFullScreen(current.id, true) })
                        Icon(Icons.Outlined.OpenInFull, contentDescription = null, tint = colors.onSurfaceVariant,
                            modifier = Modifier.align(Alignment.TopEnd).padding(8.dp).size(30.dp)
                                .background(colors.surface.copy(alpha = 0.86f), CircleShape).padding(7.dp))
                    }
                    else -> Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(6.dp),
                        modifier = Modifier.padding(16.dp)) {
                        Text(current.phase.label(format), style = MaterialTheme.typography.labelMedium, color = colors.onSurfaceVariant)
                        if (current.phase == ChatFilePreview.Phase.INTERRUPTED) {
                            NeumorphTextButton(L10n.tr("重试"), onClick = { actions.open(key) }, enabled = active)
                        }
                    }
                }
            }
        }
    }
    val latest by rememberUpdatedState(selection)
    DisposableEffect(preview, key) { onDispose { latest?.let { preview.fileHidden(key, it.id) } } }
}

private val FilePreviewFormat.icon: ImageVector get() = when (this) {
    FilePreviewFormat.HTML -> Icons.Outlined.Language
    FilePreviewFormat.SVG, FilePreviewFormat.JPEG, FilePreviewFormat.PNG -> Icons.Outlined.Image
    FilePreviewFormat.PDF -> Icons.Outlined.PictureAsPdf
    FilePreviewFormat.TEXT, FilePreviewFormat.MARKDOWN -> Icons.Outlined.Description
    FilePreviewFormat.MP4 -> Icons.Outlined.Movie
}

private fun ChatFilePreview.Phase.label(format: FilePreviewFormat) = when (this) {
    ChatFilePreview.Phase.UNAVAILABLE -> L10n.tr("预览不可用")
    ChatFilePreview.Phase.TOO_LARGE -> L10n.tr("超过预览上限 {0}", formatByteCount(format.budget.toLong()))
    ChatFilePreview.Phase.INTERRUPTED -> L10n.tr("预览已中断")
    else -> L10n.tr("此文件无法预览")
}

@Composable
private fun PreviewReader(preview: ChatFilePreview, selection: ChatFilePreview.Selection, fullScreen: Boolean, modifier: Modifier) {
    val format = FilePreviewFormat.fromName(selection.key.name) ?: return
    if (format.web) { if (selection.entry != null) PreviewBrowser(preview, selection, fullScreen, modifier); return }
    val document = selection.document ?: return
    androidx.compose.runtime.key(selection.id, fullScreen) {
        NativeFileReader(NativeReaderSource.Snapshot(document), format, fullScreen, modifier) {
            if (preview.selection.value?.let { it.id == selection.id && it.fullScreen == fullScreen } == true) preview.renderFailed(selection.id)
        }
    }
}

@Composable
private fun PreviewBrowser(preview: ChatFilePreview, selection: ChatFilePreview.Selection, fullScreen: Boolean, modifier: Modifier) {
    val entry = selection.entry ?: return
    var painted by remember(selection.id, fullScreen) { mutableStateOf(false) }
    fun ownsDocument() = preview.selection.value?.let { it.id == selection.id && it.phase == ChatFilePreview.Phase.READY && it.fullScreen == fullScreen } == true
    // An interactive page keeps its horizontal drags; page back starts from the leading edge.
    Box(modifier.contentOwnsHorizontalDrag(fullScreen), contentAlignment = Alignment.Center) {
        AndroidView(
            factory = { context -> FrameLayout(context) },
            modifier = Modifier.fillMaxSize().previewReveal(painted),
            update = { container ->
                if (ownsDocument() && container.childCount == 0) {
                    val entryLoad = runCatching {
                        PreviewWebOwner.load(container, entry, fullScreen, { path, done -> preview.resource(selection.id, path, done) },
                            painted = { painted = true },
                            captured = { image -> if (ownsDocument()) preview.setSnapshot(selection.id, image) },
                            failed = { if (ownsDocument()) preview.renderFailed(selection.id) })
                    }
                    if (entryLoad.isFailure) {
                        PreviewWebOwner.release(container)
                        container.post { if (ownsDocument()) preview.renderFailed(selection.id) }
                    }
                }
            },
            onRelease = PreviewWebOwner::release,
        )
        if (!painted) CircularProgressIndicator()
    }
}

/** The WebView's white canvas stays hidden behind the reader surface until the page paints, then fades in. */
@Composable
internal fun Modifier.previewReveal(painted: Boolean): Modifier {
    val alpha by animateFloatAsState(if (painted) 1f else 0f,
        tween(if (painted) InteractionMotion.duration(InteractionMotion.FadeIn) else 0), label = "preview-reveal")
    return graphicsLayer { this.alpha = alpha }
}

/**
 * FILE-PREVIEW-03. One WebView even when Compose mounts the incoming page before releasing the card. UI thread only.
 * The original page runs with scripts, but every request is answered by [PreviewWebOwner] from the open preview:
 * nothing reaches a network, the App's files or another page, and its storage origin is removed on release.
 */
internal object PreviewWebOwner {
    private var active: FrameLayout? = null
    private val main = Handler(Looper.getMainLooper())
    private val captures = java.util.WeakHashMap<WebView, Runnable>()
    private const val POLICY = "default-src 'self' data: blob:; script-src 'self' 'unsafe-inline' 'unsafe-eval' data: blob:; " +
        "style-src 'self' 'unsafe-inline' data: blob:; img-src 'self' data: blob:; font-src 'self' data:; media-src 'self' data: blob:; " +
        "connect-src 'self' data: blob:; worker-src 'self' blob:; frame-src 'self' data: blob: about:; form-action 'none'; base-uri 'self'"
    /** Peer-to-peer media could reach the network outside request interception; remove it before page scripts run. */
    private const val GUARD = "<script>(()=>{const r=(t,n)=>{try{Object.defineProperty(t,n,{value:undefined,configurable:false,writable:false})}catch(_){}};" +
        "for(const n of [\"RTCPeerConnection\",\"webkitRTCPeerConnection\",\"RTCDataChannel\",\"RTCIceCandidate\",\"RTCSessionDescription\",\"RTCRtpSender\",\"RTCRtpReceiver\"])r(window,n);" +
        "r(Navigator.prototype,\"mediaDevices\");r(Navigator.prototype,\"sendBeacon\")})();</script>"

    /** Insert the guard right after a doctype (keeping standards mode) or before everything else. */
    internal fun guarded(html: ByteArray): ByteArray {
        val head = String(html, 0, minOf(html.size, 512), Charsets.ISO_8859_1)
        val doctype = Regex("^\\uFEFF?\\s*<!doctype[^>]*>", RegexOption.IGNORE_CASE).find(head)?.range?.last?.plus(1) ?: 0
        return html.copyOfRange(0, doctype) + GUARD.toByteArray() + html.copyOfRange(doctype, html.size)
    }

    @SuppressLint("SetJavaScriptEnabled")
    @Suppress("DEPRECATION") // Still disable legacy file-origin and storage settings on supported devices.
    /** [resources] answers a decoded path below the page's site root (any thread); `null` is a 404. */
    fun load(container: FrameLayout, entry: ChatFilePreview.WebResource, fullScreen: Boolean,
             resources: (String, (ChatFilePreview.WebResource?) -> Unit) -> Unit,
             painted: () -> Unit, captured: (Bitmap) -> Unit, failed: () -> Unit) {
        active?.let(::release)
        val view = PreviewWebView(container.context, fullScreen)
        active = container
        container.addView(view, FrameLayout.LayoutParams(-1, -1))
        view.setBackgroundColor(Color.WHITE)
        view.settings.apply {
            javaScriptEnabled = true
            javaScriptCanOpenWindowsAutomatically = false
            setSupportMultipleWindows(false)
            blockNetworkLoads = true
            allowFileAccess = false
            allowContentAccess = false
            allowFileAccessFromFileURLs = false
            allowUniversalAccessFromFileURLs = false
            // Pages commonly read localStorage. The origin is unique to this page and deleted on release.
            domStorageEnabled = true
            databaseEnabled = false
            setGeolocationEnabled(false)
            mediaPlaybackRequiresUserGesture = true
            cacheMode = android.webkit.WebSettings.LOAD_NO_CACHE
            useWideViewPort = true
            loadWithOverviewMode = true
            setSupportZoom(fullScreen)
            builtInZoomControls = fullScreen
            displayZoomControls = false
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) safeBrowsingEnabled = false
        }
        view.isFocusable = fullScreen
        view.isVerticalScrollBarEnabled = fullScreen
        view.isHorizontalScrollBarEnabled = fullScreen
        view.setOnLongClickListener { true }
        val origin = "https://${UUID.randomUUID()}.orbis-preview.invalid"
        val entryUrl = origin + "/" + entry.path.split('/').joinToString("/") { Uri.encode(it) }
        view.tag = origin
        val capture = Runnable {
            if (view.parent !== container || fullScreen || view.width == 0 || view.height == 0) return@Runnable
            runCatching { Bitmap.createBitmap(view.width, view.height, Bitmap.Config.ARGB_8888).also { view.draw(Canvas(it)) } }
                .getOrNull()?.let(captured)
        }
        view.webChromeClient = object : WebChromeClient() {
            override fun onPermissionRequest(request: PermissionRequest) = request.deny()
            override fun onGeolocationPermissionsShowPrompt(origin: String, callback: GeolocationPermissions.Callback) =
                callback.invoke(origin, false, false)
            override fun onJsAlert(view: WebView, url: String, message: String, result: JsResult): Boolean { result.cancel(); return true }
            override fun onJsConfirm(view: WebView, url: String, message: String, result: JsResult): Boolean { result.cancel(); return true }
            override fun onJsPrompt(view: WebView, url: String, message: String, defaultValue: String?, result: JsPromptResult): Boolean {
                result.cancel(); return true
            }
        }
        view.webViewClient = object : WebViewClient() {
            private var finished = false
            private fun document(url: String) = url.substringBefore('#')
            // Links never leave the preview; only jumps within the page are kept.
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean =
                !(request.isForMainFrame && document(request.url.toString()) == entryUrl)
            override fun shouldOverrideUrlLoading(view: WebView, url: String): Boolean = document(url) != entryUrl
            // Called off the UI thread; waiting here delays only this request.
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse {
                val url = request.url
                if (request.method != "GET" || "${url.scheme}://${url.host}" != origin) return response(null)
                // Chromium asks for the site icon by itself; a preview has no tab to show it, so it never costs a Host round trip.
                if (url.path == "/favicon.ico") return response(null)
                val result = AtomicReference<ChatFilePreview.WebResource?>()
                val done = CountDownLatch(1)
                resources(url.path ?: "/") { result.set(it); done.countDown() }
                if (!done.await(60, TimeUnit.SECONDS)) return response(null)
                val resource = result.get() ?: return response(null)
                return response(resource, html = resource === entry && resource.mimeType.startsWith("text/html"))
            }
            override fun onPageCommitVisible(view: WebView, url: String) { if (view.parent === container && fullScreen) painted() }
            override fun onPageFinished(view: WebView, url: String) {
                if (view.parent !== container || document(url) != entryUrl || finished) return
                finished = true
                view.postVisualStateCallback(0, object : WebView.VisualStateCallback() {
                    override fun onComplete(requestId: Long) {
                        if (view.parent !== container) return
                        painted()
                        // Let scripts and web fonts settle before the still image replaces the live view.
                        if (!fullScreen) { main.removeCallbacks(capture); main.postDelayed(capture, 600) }
                    }
                })
            }
            override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
                if (request.isForMainFrame && view.parent === container) failed()
            }
            override fun onReceivedHttpError(view: WebView, request: WebResourceRequest, response: WebResourceResponse) {
                if (request.isForMainFrame && view.parent === container) failed()
            }
            override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
                if (view.parent === container) { release(container, rendererGone = true); failed() }
                return true
            }
        }
        view.loadUrl(entryUrl)
        // A page whose files are slow still gets a card image.
        if (!fullScreen) main.postDelayed(capture, 12_000)
        captures[view] = capture
    }

    private fun response(resource: ChatFilePreview.WebResource?, html: Boolean = false): WebResourceResponse {
        val headers = mutableMapOf("Cache-Control" to "no-store", "X-Content-Type-Options" to "nosniff")
        if (resource == null) return WebResourceResponse("text/plain", "UTF-8", 404, "Not Found", headers, ByteArrayInputStream(ByteArray(0)))
        val mime = resource.mimeType.substringBefore(';').trim()
        val charset = Regex("charset=([\\w-]+)", RegexOption.IGNORE_CASE).find(resource.mimeType)?.groupValues?.get(1)
        if (mime == "text/html" || mime == "image/svg+xml") headers["Content-Security-Policy"] = POLICY
        val body = if (html) guarded(resource.body) else resource.body
        return WebResourceResponse(mime, charset, 200, "OK", headers, ByteArrayInputStream(body))
    }

    private fun release(container: FrameLayout, rendererGone: Boolean = false) {
        if (active === container) active = null
        val view = container.getChildAt(0) as? WebView ?: return
        captures.remove(view)?.let(main::removeCallbacks)
        container.removeView(view)
        (view.tag as? String)?.let { WebStorage.getInstance().deleteOrigin(it) }
        if (!rendererGone) view.stopLoading()
        view.destroy()
    }

    fun release(container: FrameLayout) = release(container, rendererGone = false)

    private class PreviewWebView(context: Context, private val interactive: Boolean) : WebView(context) {
        override fun onTouchEvent(event: MotionEvent): Boolean = interactive && super.onTouchEvent(event)
    }
}
