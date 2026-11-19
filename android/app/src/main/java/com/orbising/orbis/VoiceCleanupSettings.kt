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
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.serialization.json.*

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun VoiceCleanupSettings(connection: RemoteViewModel, onDismiss: () -> Unit, onSaved: (Boolean) -> Unit) {
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
    var providerMode by remember { mutableStateOf(true) }
    var provider by remember { mutableStateOf<VoiceCleanupProvider?>(null) }
    val hosts by connection.hosts.collectAsState()
    var providersByHost by remember { mutableStateOf<Map<String, List<VoiceCleanupProvider>?>>(emptyMap()) }
    fun hostLabel(hostId: String, fallback: String): String {
        val name = hosts.find { it.hostId == hostId }?.name ?: fallback
        return if (hosts.count { it.name == name } > 1) "$name · $hostId" else name
    }
    var models by remember { mutableStateOf<List<String>>(emptyList()) }
    var choosingProvider by remember { mutableStateOf(false) }
    var choosingModel by remember { mutableStateOf(false) }
    fun config() = if (providerMode) VoiceCleanupApiConfig("", model.trim(), "", provider = provider)
        else VoiceCleanupApiConfig(endpoint.trim(), model.trim(), key.trim(), format.takeIf { custom })
    fun discoverProviders() {
        val targets = hosts
        if (targets.isEmpty()) { feedback = "请先连接已配对的电脑"; return }
        busy = true; feedback = null; providersByHost = emptyMap()
        scope.launch {
            try {
                providersByHost = coroutineScope {
                    targets.map { host -> async {
                        val rows = try { connection.discoverVoiceProviders(host.hostId) }
                        catch (e: CancellationException) { throw e }
                        catch (_: Exception) { null }
                        host.hostId to rows
                    } }.awaitAll().toMap()
                }
                choosingProvider = true
            } finally { busy = false }
        }
    }
    fun discoverModels() {
        val selected = provider
        busy = true; feedback = null; models = emptyList()
        scope.launch {
            try {
                models = if (providerMode) {
                    val reply = connection.requestVoiceProvider(requireNotNull(selected), "models")
                    Json.decodeFromJsonElement<List<String>>(requireNotNull(reply["models"]))
                } else VoiceTextCleanupApi.shared.models(config())
                if (models.isEmpty()) feedback = "没有可用的模型列表，请手动填写模型名称"
                else choosingModel = true
            } catch (e: CancellationException) { throw e }
            catch (_: Exception) { feedback = "没有可用的模型列表，请手动填写模型名称" }
            finally { busy = false }
        }
    }
    LaunchedEffect(store) {
        try {
            store.load()?.let {
                enabled = true; endpoint = it.endpoint; model = it.model; key = it.key
                provider = it.provider; providerMode = it.provider != null
                it.custom?.let { value -> custom = true; format = value }
            }
        } catch (e: CancellationException) { throw e }
        catch (_: Exception) { feedback = "无法读取语音清理配置" }
        finally { loading = false }
    }
    fun act(test: Boolean) {
        val value = config().takeIf { enabled }
        if (enabled && providerMode && provider == null) {
            feedback = "选择供应商"; return
        }
        if (value != null && !VoiceTextCleanupApi.isValid(value)) {
            feedback = "请检查 HTTPS 地址、模型名和请求格式"; example = null; return
        }
        busy = true; feedback = null; example = null
        scope.launch {
            try {
                if (test && value != null) example = if (value.provider != null) {
                    connection.requestVoiceProvider(value.provider, "clean", value.model, VoiceTextCleanupApi.exampleTranscript)["text"]
                        ?.jsonPrimitive?.contentOrNull ?: error("No transcript")
                } else VoiceTextCleanupApi.shared.request(value, VoiceTextCleanupApi.exampleTranscript)
                else { store.save(value); onSaved(value != null) }
            } catch (e: CancellationException) { throw e }
            catch (_: Exception) { feedback = if (test) "测试失败，请检查地址、Key 和返回格式" else "无法保存语音清理配置" }
            finally { busy = false }
        }
    }
    OrbisBottomSheet(onDismissRequest = onDismiss, maxHeightFraction = 0.88f) {
        Row(Modifier.fillMaxWidth().padding(bottom = 12.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(L10n.tr("语音清理"), Modifier.weight(1f), style = MaterialTheme.typography.titleLarge)
            InlineInfoButton(L10n.tr("从已配对电脑选择供应商。只发送本次转写，不发送录音或聊天记录。供应商的 Key 留在所选电脑，手填的 Key 留在手机。"),
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
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    FilterChip(providerMode, { providerMode = true; model = ""; feedback = null; example = null },
                        label = { Text(L10n.tr("电脑供应商")) }, enabled = !busy && !providerMode)
                    FilterChip(!providerMode, { providerMode = false; model = ""; feedback = null; example = null },
                        label = { Text(L10n.tr("手动填写")) }, enabled = !busy && providerMode)
                }
                if (providerMode) {
                    OutlinedButton(onClick = ::discoverProviders, enabled = !busy, modifier = Modifier.fillMaxWidth()) {
                        Text(provider?.let { "${hostLabel(it.hostId, it.hostName)} / ${it.name} · ${it.kind}" } ?: L10n.tr("选择供应商"))
                    }
                } else OutlinedTextField(endpoint, { endpoint = it }, Modifier.fillMaxWidth().testTag("voice-cleanup-endpoint"), enabled = !busy,
                    label = { Text(L10n.tr("API 请求地址")) }, placeholder = { Text("https://example.com/v1/chat/completions") }, singleLine = true,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri, autoCorrectEnabled = false))
                OutlinedTextField(model, { model = it }, Modifier.fillMaxWidth(), enabled = !busy,
                    label = { Text(L10n.tr("模型名称")) }, singleLine = true, keyboardOptions = KeyboardOptions(autoCorrectEnabled = false))
                if (providerMode || !custom) OutlinedButton(onClick = ::discoverModels,
                    enabled = !busy && (if (providerMode) provider != null else endpoint.isNotBlank()), modifier = Modifier.fillMaxWidth()) {
                    Text(L10n.tr("获取模型列表"))
                }
                if (!providerMode) {
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
    if (choosingProvider) OrbisChoiceSheet(title = L10n.tr("选择供应商"), onDismiss = { choosingProvider = false }) {
        Column(Modifier.heightIn(max = 380.dp).verticalScroll(rememberScrollState())) {
            hosts.forEach { host ->
                Text(hostLabel(host.hostId, host.name), style = MaterialTheme.typography.titleSmall,
                    modifier = Modifier.padding(top = 8.dp))
                val providers = providersByHost[host.hostId]
                if (providers.isNullOrEmpty()) {
                    Text(L10n.tr(when {
                        host.state.connection != RelayConnection.ONLINE || !host.state.e2eReady -> "电脑已离线"
                        providers == null -> "无法读取供应商，请检查电脑连接和 Host 版本"
                        else -> "这台电脑没有可用的 API 供应商"
                    }), style = MaterialTheme.typography.bodySmall)
                } else providers.forEach { choice -> TextButton(onClick = {
                    if (provider?.sameSource(choice) != true) model = ""
                    provider = choice; choosingProvider = false; example = null
                }) { Text("${choice.name} · ${choice.kind}") } }
            }
        }
    }
    if (choosingModel) OrbisChoiceSheet(title = L10n.tr("选择模型"), onDismiss = { choosingModel = false }) {
        Column(Modifier.heightIn(max = 380.dp).verticalScroll(rememberScrollState())) {
            models.forEach { choice -> TextButton(onClick = { model = choice; choosingModel = false; example = null }) { Text(choice) } }
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
