package com.orbising.orbis

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import kotlinx.serialization.Serializable

@Serializable
data class RuntimeTurnConfiguration(val turnId: String, val model: RuntimeModelInfo? = null,
    val thinkingLevel: String? = null, val thinkingKnown: Boolean = false)

data class SessionConfigFailure(val setting: String, val value: String, val message: String, val sessionId: String?)

internal fun RemoteState.sessionConfigFailure(runtimeId: String) = configFailures[runtimeId]
    ?.takeIf { it.sessionId == runtimes[runtimeId]?.sessionId }

internal data class SessionModelPresentation(val model: String?, val thinking: String?, val indicator: String?,
    val current: RuntimeTurnConfiguration?, val active: Boolean, val supportsCurrent: Boolean = false,
    val selectionTitle: String? = null)

internal fun List<RuntimeSlashCommand>.depthCommand(): String? =
    firstOrNull { it.name == "thinking" }?.name ?: firstOrNull { it.name == "effort" }?.name

/** S52 / SC76: execution, selected configuration and operation progress never substitute for each other. */
internal fun RemoteState.sessionModelPresentation(runtimeId: String): SessionModelPresentation {
    val runtime = runtimes[runtimeId] ?: return SessionModelPresentation(null, null, null, null, false)
    val active = runtime.status in setOf("running", "waiting_local_interaction")
    val modelReady = runtime.domainAvailability["model"] in setOf(null, "ready")
    val executionReady = runtime.domainAvailability["execution"] in setOf(null, "ready")
    val supportsCurrent = runtime.currentTurnConfigurationSupported ?: (runtime.isCodex || runtime.currentTurnConfiguration != null)
    val current = runtime.currentTurnConfiguration?.takeIf {
        supportsCurrent && e2eReady && active && modelReady && executionReady && it.turnId == runtime.executionTurnId
    }
    val progress = OperationKinds.configSettings.mapNotNull { configStatus(runtimeId, it) }
    val different = current?.model?.let { actual -> runtime.model?.let { selected ->
        actual.id != selected.id || actual.provider != selected.provider ||
            current.thinkingKnown && current.thinkingLevel != null && current.thinkingLevel != runtime.thinkingLevel
    } } == true
    val indicator = when {
        progress.any { it.second == L10n.tr("未确认") } -> L10n.tr("未确认")
        progress.isNotEmpty() -> L10n.tr("保存中")
        sessionConfigFailure(runtimeId) != null -> L10n.tr("修改失败")
        different -> L10n.tr(if (runtime.isCodex || runtime.agentKind == "claude") "下轮已设" else "后续已设")
        else -> null
    }
    // Old Hosts cannot provide turn facts. In particular, never copy a selected
    // Codex model on a running transition: it may already be the next selection.
    val showTurn = runtime.status != "idle" && supportsCurrent && (runtime.isCodex || current?.model != null)
    // SC86: duplicate selections disappear only with confirmed native identity
    // and depth. Missing facts retain a neutral selection, never a future-change label.
    val same = current?.model != null && runtime.model != null && !different &&
        current.thinkingKnown && current.thinkingLevel == runtime.thinkingLevel
    val selectionTitle = if (active && showTurn && same) null else L10n.tr(
        if (different) { if (runtime.isCodex || runtime.agentKind == "claude") "下轮使用" else "后续选择" }
        else "当前所选")
    val selectedLabel = runtime.model?.let(::modelLabel)
    // Request facts may omit the catalog label (Pi/Claude). Only the exact
    // provider/id can supply a fallback name; preserve a genuinely different request.
    val currentLabel = current?.model?.let { actual ->
        actual.name?.takeIf(String::isNotBlank)
            ?: runtime.model?.takeIf { it.provider == actual.provider && it.id == actual.id }?.let(::modelLabel)
            ?: modelLabel(actual)
    }
    return SessionModelPresentation(
        model = if (showTurn) currentLabel ?: L10n.tr("模型未确认")
            else if (active && selectedLabel != null) L10n.tr("所选：{0}", selectedLabel) else selectedLabel,
        thinking = if (showTurn) current?.thinkingLevel else runtime.thinkingLevel,
        indicator = indicator, current = current, active = active, supportsCurrent = supportsCurrent, selectionTitle = selectionTitle,
    )
}

@Composable
internal fun SessionModelConfigurationSheet(state: RemoteState, runtimeId: String, onClose: () -> Unit,
    setting: String?, onSettingChange: (String?) -> Unit, onSelect: (String, String) -> String?, onVerify: () -> Unit) {
    val runtime = state.runtimes[runtimeId] ?: return
    val presentation = state.sessionModelPresentation(runtimeId)
    val commands = state.capabilities[runtimeId]?.commands.orEmpty()
    val command = commands.firstOrNull { it.name == setting }
    OrbisChoiceSheet(L10n.tr("模型与深度"), onClose) {
        val commit = LocalModalCommit.current
        fun select(name: String, value: String) {
            if (onSelect(name, value) != null) {
                if (commit != null) commit(onClose) else onClose()
            }
        }
        Column(Modifier.fillMaxWidth().heightIn(max = 440.dp).verticalScroll(rememberScrollState()).testTag("session-model-configuration"),
            verticalArrangement = Arrangement.spacedBy(12.dp)) {
            if (presentation.active && presentation.supportsCurrent && (runtime.isCodex || presentation.current?.model != null)) {
                Text(L10n.tr("本轮使用"), style = MaterialTheme.typography.labelMedium)
                val current = presentation.current
                Text(presentation.model ?: L10n.tr("模型未确认"), Modifier.testTag("session-current-model"))
                if (current?.thinkingKnown == true) Text(current.thinkingLevel ?: L10n.tr("默认深度"))
            }
            presentation.selectionTitle?.let { title ->
                Text(title, style = MaterialTheme.typography.labelMedium)
                Text(runtime.model?.let(::modelLabel) ?: L10n.tr("未确认"), Modifier.testTag("session-selected-model"))
                Text(runtime.thinkingLevel ?: L10n.tr("默认深度"))
            }
            state.sessionConfigFailure(runtimeId)?.let { failure ->
                Text(failure.message, color = MaterialTheme.colorScheme.error)
                NeumorphTextButton(L10n.tr("重试"), enabled = state.e2eReady, dismissOnClick = false,
                    onClick = { select(failure.setting, failure.value) })
            }
            for (name in OperationKinds.configSettings) state.configStatus(runtimeId, name)?.let { (choice, mark) ->
                Text(L10n.tr("{0}，{1}", choice, if (mark == L10n.tr("切换中")) L10n.tr("保存中") else mark),
                    color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            if (presentation.indicator == L10n.tr("未确认")) {
                NeumorphTextButton(L10n.tr("核对配置"), enabled = state.e2eReady, dismissOnClick = false, onClick = onVerify)
            }
            if (command == null) {
                for (name in listOf("model", "thinking")) {
                    val nativeName = if (name == "model") name else commands.depthCommand()
                    val available = commands.firstOrNull { it.name == nativeName }
                    NeumorphTextButton(L10n.tr(if (name == "model") "模型" else "思考深度"),
                        dismissOnClick = false, onClick = { onSettingChange(nativeName) },
                        enabled = state.e2eReady && available?.argument?.kind == "select", modifier = Modifier.fillMaxWidth())
                }
            } else {
                NeumorphTextButton(L10n.tr("返回"), dismissOnClick = false, onClick = { onSettingChange(null) })
                if (command.argument?.options.isNullOrEmpty()) {
                    Text(L10n.tr(if ((command.argument?.optionCatalog?.count ?: 0) > 0) "加载中…" else "暂无可用选项"),
                        color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                command.argument?.options.orEmpty().forEach { option ->
                    NeumorphTextButton(L10n.hostText(option.label),
                        filled = OperationKinds.confirmedValue(runtime, command.name) == option.value,
                        enabled = state.e2eReady, dismissOnClick = false,
                        onClick = { select(command.name, option.value) }, modifier = Modifier.fillMaxWidth())
                }
            }
        }
    }
}
