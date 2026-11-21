package com.orbising.orbis

import android.graphics.Bitmap
import android.os.Handler
import android.os.Looper
import java.security.MessageDigest
import java.util.UUID
import java.util.concurrent.CopyOnWriteArrayList
import kotlinx.coroutines.CoroutineScope
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put

/** Answers FILE-PREVIEW-03 web commands the way a Host does: reply, then the range sent with it. */
internal class PreviewTestHost(scope: CoroutineScope) {
    val artifact = UUID.randomUUID().toString()
    val source = ChatFilePreview.Source(artifactId = artifact)
    val sent = CopyOnWriteArrayList<JsonObject>()
    val requested = CopyOnWriteArrayList<String>()
    private val main = Handler(Looper.getMainLooper())
    private val png = Bitmap.createBitmap(4, 4, Bitmap.Config.ARGB_8888).run {
        eraseColor(android.graphics.Color.rgb(0, 128, 0))
        java.io.ByteArrayOutputStream().also { compress(Bitmap.CompressFormat.PNG, 100, it) }.toByteArray()
    }
    val files: MutableMap<String, Pair<ByteArray, String>> = mutableMapOf(
        "report.html" to ("""<!doctype html><html><head><meta name="viewport" content="width=device-width"><title>loading</title>
            <link rel="stylesheet" href="style.css"><link rel="stylesheet" href="https://example.com/remote.css"></head>
            <body><div id="box"></div><img id="local" src="pixel.png"><img src="https://example.com/beacon.png"><script src="app.js"></script></body></html>""".toByteArray() to "text/html; charset=utf-8"),
        "style.css" to (":root{--fill:#008000}#box{background:var(--fill);width:160px;height:80px;display:grid}".toByteArray() to "text/css; charset=utf-8"),
        "pixel.png" to (png to "image/png"),
        "app.js" to ("""document.title = "ran";
            fetch("https://example.com/collect").then(() => { document.title += "|network"; }, () => { document.title += "|blocked"; });
            document.title += typeof RTCPeerConnection === "undefined" ? "|no-rtc" : "|rtc";
            document.getElementById("local").decode().then(() => { document.title += "|img"; }, () => { document.title += "|no-img"; });""".toByteArray() to "text/javascript; charset=utf-8"),
    )
    val preview: ChatFilePreview = ChatFilePreview(scope, "host", { message -> sent.add(message); answer(message); true }, { false })
        .apply { authenticated(true) }

    private fun answer(message: JsonObject) {
        if (message["type"]?.jsonPrimitive?.content != "runtime.command") return
        val command = message.getValue("command").jsonObject
        val web = command["web"]?.jsonObject ?: return
        val id = message.getValue("commandId").jsonPrimitive.content
        val transfer = web.getValue("transferId").jsonPrimitive.content
        val path = web["resource"]?.jsonPrimitive?.content
        if (path != null) requested += path
        main.post {
            val file = files[path ?: "report.html"]
            if (file == null) {
                preview.consume(buildJsonObject {
                    put("type", "file.preview.failed"); put("protocolVersion", PROTOCOL_VERSION); put("runtimeId", "host")
                    put("commandId", id); put("reason", "unavailable")
                })
                return@post
            }
            val body = file.first
            preview.consume(buildJsonObject {
                put("type", "file.preview.started"); put("protocolVersion", PROTOCOL_VERSION); put("runtimeId", "host")
                put("commandId", id); put("transferId", transfer); put("artifactId", artifact); put("format", "web")
                put("size", body.size); put("contentSize", body.size); put("encoding", "identity"); put("mimeType", file.second)
                put("resource", path ?: "report.html")
                put("sha256", MessageDigest.getInstance("SHA-256").digest(body).joinToString("") { "%02x".format(it) })
            })
            preview.consume(ArtifactChunkFrame("host", transfer, 0, body))
        }
    }
}
