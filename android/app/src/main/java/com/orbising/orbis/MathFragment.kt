package com.orbising.orbis

import android.annotation.SuppressLint
import android.graphics.Color as AndroidColor
import android.webkit.*
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.material3.LocalContentColor
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.graphics.isSpecified
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.LinkInteractionListener
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import java.io.ByteArrayInputStream
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.*

/** Only math-bearing native paragraphs/cells use this local, network-isolated surface. */
@Composable
internal fun MathFragment(html: String, source: AnnotatedString, listener: LinkInteractionListener,
    modifier: Modifier, style: TextStyle, textAlign: TextAlign) {
    val density = LocalDensity.current
    val ink = style.color.takeIf { it.isSpecified } ?: LocalContentColor.current
    val link = MaterialTheme.colorScheme.primary
    val selectable = LocalMessageTextSelectionEnabled.current
    val fontSize = style.fontSize.value * density.fontScale
    var payload by remember { mutableStateOf("") }
    var height by remember { mutableStateOf(1f) }
    var rendered by remember { mutableStateOf(false) }
    var revision by remember { mutableIntStateOf(0) }
    val cursor = LocalRevealCursor.current
    val path = LocalRevealPath.current
    if (cursor != null) {
        SideEffect { cursor.register(path, source.length) }
        DisposableEffect(cursor, path) { onDispose { cursor.unregister(path) } }
    }
    LaunchedEffect(html, fontSize, ink, link, selectable, textAlign, style.fontWeight) {
        val nextRevision = ++revision
        payload = withContext(Dispatchers.Default) { buildJsonObject {
            put("revision", nextRevision); put("html", html); put("fontSize", fontSize)
            put("color", String.format("#%06x", ink.toArgb() and 0xffffff))
            put("linkColor", String.format("#%06x", link.toArgb() and 0xffffff))
            put("selectable", selectable); put("bold", (style.fontWeight ?: FontWeight.Normal) >= FontWeight.SemiBold)
            put("align", when (textAlign) { TextAlign.Center -> "center"; TextAlign.End, TextAlign.Right -> "right"; else -> "left" })
            put("lineHeight", if (style.lineHeight.isSp && style.fontSize.isSp) style.lineHeight.value / style.fontSize.value else 1.5f)
        }.toString() }
    }
    Box(modifier) {
        if (!rendered) StreamingMarkdownText(source, Modifier.fillMaxWidth(), style, textAlign, registerWithCursor = false)
        AndroidView(factory = { context -> IsolatedMathWebView(context) },
            modifier = Modifier.fillMaxWidth().height(if (rendered) height.dp else 1.dp).alpha(if (rendered) 1f else 0f),
            onRelease = { it.release() }, update = { view ->
                view.onSize = { current, measured -> if (current == revision && measured.isFinite() && measured in 1f..32768f) { height = measured; rendered = true } }
                view.onFailure = { rendered = false }
                view.onLink = { target -> if (markdownFileLinkPath(target) != null || markdownExternalLinkUrl(target) != null) listener.onClick(LinkAnnotation.Clickable(target, linkInteractionListener = listener)) }
                view.setOnLongClickListener { !selectable }
                view.reveal(cursor, path, source.length)
                view.submit(payload)
            })
    }
}

@SuppressLint("SetJavaScriptEnabled")
internal class IsolatedMathWebView(context: android.content.Context) : WebView(context) {
    var onSize: (Int, Float) -> Unit = { _, _ -> }
    var onLink: (String) -> Unit = {}
    var onFailure: () -> Unit = {}
    private var ready = false
    private var payload = ""
    private var sent = ""
    private var released = false
    private var failed = false
    private var revealKey = ""
    private var revealJSON = "null"
    init {
        setBackgroundColor(AndroidColor.TRANSPARENT)
        isVerticalScrollBarEnabled = false
        settings.javaScriptEnabled = true
        settings.allowFileAccess = false
        settings.allowContentAccess = false
        settings.domStorageEnabled = false
        settings.mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
        settings.setSupportMultipleWindows(false)
        settings.textZoom = 100
        addJavascriptInterface(object {
            @JavascriptInterface fun postMessage(message: String) {
                if (message.length > 4096) return
                val value = runCatching { Json.parseToJsonElement(message).jsonObject }.getOrNull() ?: return
                post { if (!released && !failed) when (value["type"]?.jsonPrimitive?.content) {
                    "ready" -> { ready = true; send() }
                    "size" -> onSize(value["revision"]?.jsonPrimitive?.intOrNull ?: -1, value["height"]?.jsonPrimitive?.floatOrNull ?: 0f)
                    "link" -> value["value"]?.jsonPrimitive?.contentOrNull?.let(onLink)
                    "failure" -> fail()
                }}
            }
        }, "OrbisMathBridge")
        webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse {
                val uri = request.url
                val path = uri.path.orEmpty().removePrefix("/")
                if (uri.scheme == "https" && uri.host == "appassets.androidplatform.net" && path.startsWith("math/") && !path.contains("..")) {
                    val mime = when (path.substringAfterLast('.')) { "html" -> "text/html"; "js" -> "application/javascript"; "css" -> "text/css"; "woff2" -> "font/woff2"; else -> null }
                    if (mime != null) runCatching { context.assets.open(path) }.getOrNull()?.let { return WebResourceResponse(mime, "UTF-8", it) }
                }
                return WebResourceResponse("text/plain", "UTF-8", 403, "Forbidden", emptyMap(), ByteArrayInputStream(byteArrayOf()))
            }
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean = true
            override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) { if (request.isForMainFrame) fail() }
            override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean { fail(); release(); return true }
        }
        loadUrl("https://appassets.androidplatform.net/math/index.html")
    }
    fun submit(value: String) { payload = value; send() }
    fun reveal(cursor: RevealCursor?, path: List<Int>, length: Int) {
        val base = cursor?.base(path) ?: 0
        val schedule = cursor?.schedule
        val now = cursor?.frame ?: 0
        val key = "$base:$length:${schedule?.known}:${schedule?.settledBelow}"
        if (key == revealKey) return
        revealKey = key
        revealJSON = if (schedule == null || schedule.settledBelow - base >= length) "null" else {
            val from = maxOf(0, length - 128, schedule.settledBelow - base)
            val known = (schedule.known - base).coerceIn(0, length)
            buildJsonObject {
                put("from", from); put("known", known)
                put("delays", JsonArray((from until known).map { offset -> JsonPrimitive((schedule.startTime(base + offset)?.minus(now) ?: -120.0)) }))
            }.toString()
        }
        if (ready && !failed && !released) evaluateJavascript("OrbisMathView.reveal($revealJSON)", null)
    }
    private fun send() {
        if (released || failed || !ready || payload.isEmpty() || payload == sent) return
        sent = payload
        evaluateJavascript("OrbisMathView.update(" + payload + ");OrbisMathView.reveal(" + revealJSON + ")", null)
    }
    private fun fail() { failed = true; onFailure() }
    fun release() {
        if (released) return
        released = true; ready = false
        (parent as? android.view.ViewGroup)?.removeView(this)
        stopLoading(); removeJavascriptInterface("OrbisMathBridge"); destroy()
    }
}
