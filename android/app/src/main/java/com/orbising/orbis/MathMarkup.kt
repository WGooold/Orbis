package com.orbising.orbis

import android.content.res.AssetManager
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import kotlinx.serialization.json.*
import org.mozilla.javascript.Context
import org.mozilla.javascript.ScriptableObject

internal data class MathToken(val marker: String, val raw: String)
internal data class MathMarkup(val text: String, val prefix: String, val tokens: List<MathToken>, val json: String, val bypass: Boolean = false)

/** Shared deterministic scanner; invoked only by the existing Markdown worker. */
internal object MathMarkupEngine {
    @Volatile private var assets: AssetManager? = null
    private var scope: ScriptableObject? = null
    fun install(value: AssetManager) { assets = value }
    @Synchronized private fun call(expression: String, argument: String): String {
        val context = Context.enter()
        try {
            context.optimizationLevel = -1
            context.languageVersion = Context.VERSION_ES6
            val global = scope ?: context.initSafeStandardObjects().also {
                val stream = assets?.open("math/core.js") ?: javaClass.classLoader!!.getResourceAsStream("math/core.js")
                    ?: error("Bundled math scanner missing")
                context.evaluateString(it, stream.bufferedReader().use { r -> r.readText() }, "math/core.js", 1, null)
                scope = it
            }
            global.put("orbisArgument", global, argument)
            return Context.toString(context.evaluateString(global, expression, "math-call", 1, null))
        } finally { scope?.delete("orbisArgument"); Context.exit() }
    }
    fun protect(text: String): MathMarkup? {
        if (!text.contains('$') && !text.contains("\\(") && !text.contains("\\[") && !text.contains("\\begin{") && !text.contains("math")) return null
        return runCatching {
        val json = call("JSON.stringify(OrbisMath.protect(orbisArgument))", text)
        val result = Json.parseToJsonElement(json).jsonObject
        val tokens = result.getValue("tokens").jsonArray.map {
            MathToken(it.jsonObject.getValue("marker").jsonPrimitive.content, it.jsonObject.getValue("raw").jsonPrimitive.content)
        }
        MathMarkup(result.getValue("text").jsonPrimitive.content, result.getValue("prefix").jsonPrimitive.content, tokens, json, result["bypass"]?.jsonPrimitive?.booleanOrNull == true)
        }.getOrElse { MathMarkup(text, "", emptyList(), "", bypass = true) }
    }
    fun html(text: AnnotatedString, prepared: MathMarkup): String? {
        if (prepared.bypass || !text.text.contains(prepared.prefix)) return null
        val points = sortedSetOf(0, text.length)
        text.spanStyles.forEach { points += it.start; points += it.end }
        val links = text.getStringAnnotations(0, text.length)
        links.forEach { points += it.start; points += it.end }
        val runs = points.zipWithNext().map { (start, end) -> buildJsonObject {
            put("text", text.text.substring(start, end))
            val styles = text.spanStyles.filter { it.start <= start && it.end >= end }.map { it.item }
            put("bold", styles.any { (it.fontWeight ?: FontWeight.Normal) >= FontWeight.SemiBold })
            put("italic", styles.any { it.fontStyle == FontStyle.Italic })
            put("strike", styles.any { it.textDecoration?.contains(TextDecoration.LineThrough) == true })
            put("code", styles.any { it.fontFamily == FontFamily.Monospace })
            links.lastOrNull { it.start <= start && it.end >= end }?.let { put("link", it.item) }
        }}
        val argument = buildJsonObject { put("runs", JsonArray(runs)); put("prepared", Json.parseToJsonElement(prepared.json)) }
        return runCatching {
            val result = Json.parseToJsonElement(call("(function(){var p=JSON.parse(orbisArgument);return JSON.stringify(OrbisMath.inlineHTML(p.runs,p.prepared));})()", argument.toString())).jsonObject
            result.getValue("html").jsonPrimitive.content.takeIf { result.getValue("hasMath").jsonPrimitive.boolean }
        }.getOrNull()
    }
    fun restore(value: AnnotatedString, prepared: MathMarkup): AnnotatedString {
        if (prepared.bypass || !value.text.contains(prepared.prefix)) return value
        val builder = AnnotatedString.Builder()
        var cursor = 0
        while (cursor < value.length) {
            val at = value.text.indexOf(prepared.prefix, cursor)
            if (at < 0) break
            val end = value.text.indexOf('\uE001', at) + 1
            val token = prepared.tokens.firstOrNull { end > at && it.marker == value.text.substring(at, end) } ?: break
            builder.append(value.subSequence(cursor, at))
            val start = builder.length
            builder.append(token.raw)
            value.spanStyles.filter { it.start <= at && it.end >= end }.forEach { builder.addStyle(it.item, start, builder.length) }
            value.getStringAnnotations(at, end).forEach { builder.addStringAnnotation(it.tag, it.item, start, builder.length) }
            cursor = end
        }
        builder.append(value.subSequence(cursor, value.length))
        return builder.toAnnotatedString()
    }
}
