package com.orbising.orbis

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun VoiceCleanupSettings(onDismiss: () -> Unit, onSaved: (Boolean) -> Unit) {
    val context = LocalContext.current
    val store = remember(context) { VoiceCleanupApiStore(context) }
    val scope = rememberCoroutineScope()
    var loading by remember { mutableStateOf(true) }
    var advancedOpen by remember { mutableStateOf(false) }
    var enabled by remember { mutableStateOf(false) }
    var endpoint by remember { mutableStateOf("") }
    var model by remember { mutableStateOf("") }
    var key by remember { mutableStateOf("") }
    var custom by remember { mutableStateOf(false) }
    var format by remember { mutableStateOf(VoiceCleanupJsonFormat.example) }
    var busy by remember { mutableStateOf(false) }
    var feedback by remember { mutableStateOf<String?>(null) }
    var example by remember { mutableStateOf<String?>(null) }
    fun config() = VoiceCleanupApiConfig(endpoint.trim(), model.trim(), key.trim(), format.takeIf { custom })
    LaunchedEffect(store) {
        try {
            store.load()?.let {
                enabled = true; endpoint = it.endpoint; model = it.model; key = it.key
                it.custom?.let { value -> custom = true; format = value }
            }
        } catch (e: CancellationException) { throw e }
        catch (_: Exception) { feedback = "无法读取语音清理配置" }
        finally { loading = false }
    }
    fun act(test: Boolean) {
        val value = config().takeIf { enabled }
        if (value != null && !VoiceTextCleanupApi.isValid(value)) {
            feedback = "请检查 HTTPS 地址、模型名和请求格式"; example = null; return
        }
        busy = true; feedback = null; example = null
        scope.launch {
            try {
                if (test && value != null) example = VoiceTextCleanupApi.shared.request(value, VoiceTextCleanupApi.exampleTranscript)
                else { store.save(value); onSaved(value != null) }
            } catch (e: CancellationException) { throw e }
            catch (_: Exception) { feedback = if (test) "测试失败，请检查地址、Key 和返回格式" else "无法保存语音清理配置" }
            finally { busy = false }
        }
    }
    OrbisBottomSheet(onDismissRequest = onDismiss, maxHeightFraction = 0.88f) {
        Row(Modifier.fillMaxWidth().padding(bottom = 12.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(L10n.tr("语音清理"), Modifier.weight(1f), style = MaterialTheme.typography.titleLarge)
            InlineInfoButton(L10n.tr("默认在手机上去除明显口癖。开启 API 后只发送本次转写，Key 仅存此设备。关闭并保存会删除 API 配置和 Key。"),
                title = L10n.tr("语音清理"), tag = "voice-cleanup-info")
        }
        Column(Modifier.fillMaxWidth().weight(1f, fill = false).verticalScroll(rememberScrollState()),
            verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                val label = L10n.tr("使用自定义模型 API")
                Text(label, Modifier.weight(1f))
                Switch(checked = enabled, onCheckedChange = { enabled = it; feedback = null; example = null },
                    enabled = !loading && !busy, modifier = Modifier.testTag("voice-cleanup-api-toggle").semantics { contentDescription = label })
            }
            if (loading) LinearProgressIndicator(Modifier.fillMaxWidth())
            if (enabled) {
                OutlinedTextField(endpoint, { endpoint = it }, Modifier.fillMaxWidth().testTag("voice-cleanup-endpoint"), enabled = !busy,
                    label = { Text(L10n.tr("API 请求地址")) }, placeholder = { Text("https://example.com/v1/chat/completions") }, singleLine = true,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri, autoCorrectEnabled = false))
                OutlinedTextField(model, { model = it }, Modifier.fillMaxWidth(), enabled = !busy,
                    label = { Text(L10n.tr("模型名称")) }, singleLine = true, keyboardOptions = KeyboardOptions(autoCorrectEnabled = false))
                OutlinedTextField(key, { key = it }, Modifier.fillMaxWidth(), enabled = !busy,
                    label = { Text(L10n.tr("API Key（可选）")) }, singleLine = true,
                    visualTransformation = PasswordVisualTransformation(), keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password))
                HorizontalDivider()
                TextButton(onClick = { advancedOpen = !advancedOpen }, enabled = !busy, modifier = Modifier.fillMaxWidth()
                    .testTag("voice-cleanup-advanced")) {
                    Text(L10n.tr("高级设置"), modifier = Modifier.weight(1f))
                    Text(if (custom) "JSON" else "Chat Completions", style = MaterialTheme.typography.labelMedium)
                    Spacer(Modifier.width(8.dp))
                    Icon(OrbisSymbols.ChevronRight, null, Modifier.size(16.dp).rotate(if (advancedOpen) 90f else 0f))
                }
                if (advancedOpen) {
                    ToggleRequestFormat(custom, !busy) { custom = it; feedback = null; example = null }
                    if (custom) {
                        OutlinedTextField(format.headers, { format = format.copy(headers = it) }, Modifier.fillMaxWidth(), enabled = !busy,
                            label = { Text(L10n.tr("请求头 JSON")) }, maxLines = 4, keyboardOptions = KeyboardOptions(autoCorrectEnabled = false))
                        OutlinedTextField(format.body, { format = format.copy(body = it) }, Modifier.fillMaxWidth(), enabled = !busy,
                            label = { Text(L10n.tr("请求体 JSON")) }, minLines = 4, maxLines = 8, keyboardOptions = KeyboardOptions(autoCorrectEnabled = false))
                        OutlinedTextField(format.responsePath, { format = format.copy(responsePath = it) }, Modifier.fillMaxWidth(), enabled = !busy,
                            label = { Text(L10n.tr("文本返回路径")) }, placeholder = { Text("/content/0/text") },
                            singleLine = true, keyboardOptions = KeyboardOptions(autoCorrectEnabled = false))
                    }
                }
                OutlinedButton(onClick = { act(true) }, enabled = !busy, modifier = Modifier.fillMaxWidth()) {
                    Text(L10n.tr("用示例文字测试"))
                }
            }
            if (busy) LinearProgressIndicator(Modifier.fillMaxWidth())
            feedback?.let { Text(L10n.tr(it), color = MaterialTheme.colorScheme.error) }
            example?.let { Text(L10n.tr("测试返回"), style = MaterialTheme.typography.labelMedium); Text(it, maxLines = 5) }
        }
        Button(onClick = { act(false) }, enabled = !loading && !busy,
            modifier = Modifier.padding(top = 12.dp, bottom = 8.dp).fillMaxWidth().testTag("voice-cleanup-save")) {
            Text(L10n.tr("保存"))
        }
    }
}

@Composable
private fun ToggleRequestFormat(custom: Boolean, enabled: Boolean, onChange: (Boolean) -> Unit) {
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        val label = L10n.tr("自定义 JSON 请求")
        Text(label, Modifier.weight(1f))
        InlineInfoButton(L10n.tr("请求头用 {{key}}；请求体可用 {{model}}、{{instruction}} 和 {{transcript}}。返回路径示例：/content/0/text。"),
            title = label, tag = "voice-cleanup-format-info")
        Spacer(Modifier.width(8.dp))
        Switch(custom, onChange, enabled = enabled, modifier = Modifier.semantics { contentDescription = label })
    }
}
