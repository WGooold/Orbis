package com.orbising.orbis

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Color
import android.view.MotionEvent
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import java.io.ByteArrayInputStream
import java.util.UUID
import java.util.concurrent.atomic.AtomicBoolean
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.OpenInFull
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.layout.boundsInWindow
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import kotlinx.coroutines.delay
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
    LaunchedEffect(preview, session, active) { if (!active && session != null) preview?.closeSession(session) }
    OrbisPageHost(
        open = fullScreenId != null, contentKey = fullScreenId,
        onBack = { fullScreenId?.let { preview?.setFullScreen(it, false) } },
        underlay = { CompositionLocalProvider(LocalFilePreviewActions provides actions) { content() } },
    ) {
        val selection = preview?.selection?.value?.takeIf { it.id == fullScreenId }
        if (preview != null && selection != null) Column(Modifier.fillMaxSize()) {
            Row(Modifier.fillMaxWidth().padding(horizontal = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                NeumorphIconButton(onClick = { preview.setFullScreen(selection.id, false) }, icon = OrbisSymbols.ArrowBack,
                    contentDescription = L10n.tr("返回"), size = 40.dp)
                FileNameText(selection.key.name, Modifier.weight(1f))
            }
            if (active) PreviewBrowser(preview, selection, fullScreen = true,
                modifier = Modifier.weight(1f).fillMaxWidth().testTag("chat-file-preview-reader"))
        }
    }
}

/** File cards collect only their own projection. Opening one never republishes the chat list. */
@Composable
internal fun ChatFilePreviewCard(block: String, source: ChatFilePreview.Source, name: String, download: @Composable () -> Unit) {
    val actions = LocalFilePreviewActions.current
    if (actions == null || ChatFilePreview.format(name) == null) { download(); return }
    val preview = actions.preview
    val key = remember(actions.session, block, source, name) { ChatFilePreview.Key(actions.session, block, source, name) }
    val selection by remember(preview, key) {
        preview.selection.map { it?.takeIf { state -> state.key == key } }.distinctUntilChanged()
    }.collectAsState(null)
    val current = selection
    val active = LocalPageActive.current
    Column(Modifier.fillMaxWidth().then(if (current?.phase == ChatFilePreview.Phase.LOADING) {
        Modifier.onGloballyPositioned { if (it.size.height > 0 && it.boundsInWindow().isEmpty) preview.fileHidden(key, current.id) }
    } else Modifier), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            Box(Modifier.weight(1f)) { download() }
            if (current == null) {
                NeumorphTextButton(L10n.tr("预览"), onClick = { actions.open(key) }, enabled = active,
                    modifier = Modifier.testTag("chat-file-preview-open"))
            } else {
                if (current.phase == ChatFilePreview.Phase.READY) {
                    NeumorphIconButton(onClick = { preview.setFullScreen(current.id, true) }, icon = Icons.Outlined.OpenInFull,
                        contentDescription = L10n.tr("全屏预览"), compact = true, enabled = active,
                        modifier = Modifier.testTag("chat-file-preview-fullscreen"))
                }
                NeumorphIconButton(onClick = { preview.close(key) }, icon = OrbisSymbols.KeyboardArrowDown,
                    contentDescription = L10n.tr("收起"), compact = true, enabled = active,
                    modifier = Modifier.testTag("chat-file-preview-close"))
            }
        }
        if (current != null) {
            var panelVisible by remember(current.id) { mutableStateOf(false) }
            Box(Modifier.fillMaxWidth().height(240.dp).clipToBounds().testTag("chat-file-preview-panel")
                .onGloballyPositioned { panelVisible = !it.boundsInWindow().isEmpty }, contentAlignment = Alignment.Center) {
                when (current.phase) {
                    ChatFilePreview.Phase.LOADING -> CircularProgressIndicator(
                        modifier = Modifier.testTag("chat-file-preview-loading"))
                    ChatFilePreview.Phase.READY -> if (active && panelVisible && !current.fullScreen) {
                        PreviewBrowser(preview, current, fullScreen = false, Modifier.fillMaxSize())
                    }
                    else -> Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        Text(current.phase.label(), style = MaterialTheme.typography.labelMedium)
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

private fun ChatFilePreview.Phase.label() = when (this) {
    ChatFilePreview.Phase.UNAVAILABLE -> L10n.tr("预览不可用")
    ChatFilePreview.Phase.TOO_LARGE -> L10n.tr("文件过大，无法预览")
    ChatFilePreview.Phase.INTERRUPTED -> L10n.tr("预览已中断")
    else -> L10n.tr("此文件无法预览")
}

@Composable
private fun PreviewBrowser(preview: ChatFilePreview, selection: ChatFilePreview.Selection, fullScreen: Boolean, modifier: Modifier) {
    val document = selection.document ?: return
    var loaded by remember(selection.id, fullScreen) { mutableStateOf(false) }
    fun ownsDocument() = preview.selection.value?.let { it.id == selection.id && it.phase == ChatFilePreview.Phase.READY && it.fullScreen == fullScreen } == true
    Box(modifier, contentAlignment = Alignment.Center) {
        AndroidView(
            factory = { context -> FrameLayout(context) },
            modifier = Modifier.fillMaxSize(),
            update = { container ->
                if (ownsDocument() && container.childCount == 0) {
                    val entry = runCatching {
                        PreviewWebOwner.load(container, document, fullScreen, loaded = { loaded = true },
                            failed = { if (ownsDocument()) preview.renderFailed(selection.id) })
                    }
                    if (entry.isFailure) {
                        PreviewWebOwner.release(container)
                        container.post { if (ownsDocument()) preview.renderFailed(selection.id) }
                    }
                }
            },
            onRelease = PreviewWebOwner::release,
        )
        if (!loaded) CircularProgressIndicator()
    }
    LaunchedEffect(selection.id, fullScreen) {
        delay(8_000)
        if (!loaded && ownsDocument()) preview.renderFailed(selection.id)
    }
}

/** One renderer even when Compose mounts the incoming page before releasing the card. UI thread only. */
internal object PreviewWebOwner {
    private var active: FrameLayout? = null

    @SuppressLint("SetJavaScriptEnabled") // Explicitly disabled, along with all page resource access.
    @Suppress("DEPRECATION") // Still disable legacy file-origin and storage settings on supported devices.
    fun load(container: FrameLayout, document: ByteArray, fullScreen: Boolean, loaded: () -> Unit, failed: () -> Unit) {
        active?.let(::release)
        val view = PreviewWebView(container.context, fullScreen)
        active = container
        container.addView(view, FrameLayout.LayoutParams(-1, -1))
        view.setBackgroundColor(Color.WHITE)
        view.settings.apply {
            javaScriptEnabled = false
            javaScriptCanOpenWindowsAutomatically = false
            setSupportMultipleWindows(false)
            blockNetworkLoads = true
            allowFileAccess = false
            allowContentAccess = false
            allowFileAccessFromFileURLs = false
            allowUniversalAccessFromFileURLs = false
            domStorageEnabled = false
            databaseEnabled = false
            loadsImagesAutomatically = false
            mediaPlaybackRequiresUserGesture = true
            cacheMode = android.webkit.WebSettings.LOAD_NO_CACHE
            setSupportZoom(fullScreen)
            builtInZoomControls = fullScreen
            displayZoomControls = false
        }
        view.isFocusable = fullScreen
        view.isVerticalScrollBarEnabled = fullScreen
        view.isHorizontalScrollBarEnabled = fullScreen
        view.setOnLongClickListener { true }
        // The reserved origin is unique to this instance. Its only response comes
        // from memory. The boundary never returns null (network fallback).
        val entry = "https://${UUID.randomUUID()}.orbis-preview.invalid/document"
        val served = AtomicBoolean(false)
        view.webViewClient = object : WebViewClient() {
            private var visualStatePending = false

            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean = true
            override fun shouldOverrideUrlLoading(view: WebView, url: String): Boolean = true
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse {
                if (request.isForMainFrame && request.method == "GET" && request.url.toString() == entry && served.compareAndSet(false, true)) {
                    return WebResourceResponse("text/html", "UTF-8", 200, "OK", mapOf(
                        "Cache-Control" to "no-store",
                        "Content-Security-Policy" to "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
                        "X-Content-Type-Options" to "nosniff",
                    ), ByteArrayInputStream(document))
                }
                return WebResourceResponse("text/plain", "UTF-8", 403, "Blocked", mapOf("Cache-Control" to "no-store"),
                    ByteArrayInputStream(ByteArray(0)))
            }
            override fun onPageFinished(view: WebView, url: String) {
                if (view.parent !== container || url != entry || !served.get() || visualStatePending) return
                visualStatePending = true
                view.postVisualStateCallback(0, object : WebView.VisualStateCallback() {
                    override fun onComplete(requestId: Long) {
                        if (view.parent === container) loaded()
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
        view.loadUrl(entry)
    }

    private fun release(container: FrameLayout, rendererGone: Boolean = false) {
        if (active === container) active = null
        val view = container.getChildAt(0) as? WebView ?: return
        container.removeView(view)
        if (!rendererGone) view.stopLoading()
        view.destroy()
    }

    fun release(container: FrameLayout) = release(container, rendererGone = false)

    private class PreviewWebView(context: Context, private val interactive: Boolean) : WebView(context) {
        override fun onTouchEvent(event: MotionEvent): Boolean = interactive && super.onTouchEvent(event)
    }
}
