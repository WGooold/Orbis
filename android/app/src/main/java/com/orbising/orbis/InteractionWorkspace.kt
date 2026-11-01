package com.orbising.orbis

import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.Saver
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.delay
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json

@Composable
@OptIn(ExperimentalMaterial3Api::class)
internal fun SessionControlDialog(title: String, onClose: () -> Unit, content: @Composable ColumnScope.() -> Unit) {
    ModalBottomSheet(
        onDismissRequest = onClose, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        modifier = Modifier.fillMaxHeight(0.94f), dragHandle = null,
        containerColor = MaterialTheme.colorScheme.surface, tonalElevation = 0.dp,
    ) {
        // The sheet consumes its top inset for positioning. Reserve the raw status-bar
        // height as well so an edge-to-edge window cannot place the title under the clock.
        val topInset = WindowInsets.statusBars.asPaddingValues().calculateTopPadding().coerceAtLeast(24.dp)
        Column(Modifier.fillMaxWidth().weight(1f).navigationBarsPadding().imePadding().padding(top = topInset, bottom = 12.dp)) {
            Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(title, Modifier.weight(1f), style = MaterialTheme.typography.titleLarge)
                NeumorphTextButton("收起", onClick = onClose)
            }
            content()
        }
    }
}

@Serializable
internal data class InteractionDraftValue(
    val input: String = "", val values: List<String> = emptyList(),
    val answers: Map<String, QuestionnaireDraft> = emptyMap(), val page: Int = 0,
)

internal class InteractionDraft(initial: InteractionDraftValue = InteractionDraftValue()) {
    var value by mutableStateOf(initial)
}

internal fun savableInteractionDraft(request: PendingInteraction, draft: InteractionDraftValue) = draft.copy(
    input = if (request.secret) "" else draft.input,
    answers = draft.answers.filterKeys { id -> request.questions.none { it.id == id && it.secret } },
)

/** Both agent backends use this workspace. Drafts live outside the dialog and survive collapse. */
@Composable
internal fun InteractionWorkspace(
    requests: List<PendingInteraction>, connected: Boolean,
    pendingCommands: Set<String>, error: String?,
    respondConfirm: (PendingInteraction, Boolean) -> Unit,
    respondValue: (PendingInteraction, String) -> Unit,
    respondValues: (PendingInteraction, List<String>) -> Unit,
    respondQuestionnaire: (PendingInteraction, List<QuestionnaireAnswer>?) -> Unit,
    onCancel: (PendingInteraction) -> Unit,
    /** ADR-0049 §6.5：正在回答的请求立即收起（草稿保留），其他请求直接切到下一项。 */
    responding: Set<String> = emptySet(),
    /** 原位短状态：(文案, 是否处理中, 已结算结果的标识)。 */
    status: Triple<String, Boolean, String?>? = null,
) {
    val allIds = requests.map { it.requestId }.toSet()
    @Suppress("NAME_SHADOWING") val requests = requests.filterNot { it.requestId in responding }
    val latestRequests by rememberUpdatedState(requests)
    val saver = remember {
        Saver<MutableMap<String, InteractionDraft>, String>(
            save = { drafts -> Json.encodeToString(latestRequests.associate { request ->
                request.requestId to savableInteractionDraft(request, drafts[request.requestId]?.value ?: InteractionDraftValue())
            }) },
            restore = { saved -> Json.decodeFromString<Map<String, InteractionDraftValue>>(saved)
                .mapValues { InteractionDraft(it.value) }.toMutableMap() },
        )
    }
    val drafts = rememberSaveable(saver = saver) { mutableMapOf<String, InteractionDraft>() }
    var open by rememberSaveable { mutableStateOf(false) }
    var selectedId by rememberSaveable { mutableStateOf<String?>(null) }
    var seenIds by rememberSaveable { mutableStateOf(emptyList<String>()) }
    val ids = requests.map { it.requestId }
    // 单个确认直接在输入框上方回答，不打开整页面板（与 iOS 一致）；其余交互仍自动展开面板。
    val inlineConfirm = requests.size == 1 && requests[0].kind == "confirm"
    LaunchedEffect(ids) {
        val newRequest = ids.firstOrNull { it !in seenIds }
        if (inlineConfirm) open = false
        else if (newRequest != null) {
            if (!open) selectedId = newRequest
            open = true
        }
        seenIds = ids
        if (ids.isEmpty()) open = false
    }
    // 收起中的请求仍保留草稿：被拒绝后面板回到原位，答案还在。
    LaunchedEffect(allIds) { drafts.keys.retainAll(allIds) }
    val request = requests.find { it.requestId == selectedId } ?: requests.firstOrNull() ?: run {
        InteractionStatus(status)
        return
    }
    if (inlineConfirm) {
        val draft = drafts.getOrPut(request.requestId) { InteractionDraft() }
        InteractionPanel(
            request, request.responseCommandId in pendingCommands, respondConfirm = { respondConfirm(request, it) },
            respondValue = { respondValue(request, it) }, respondValues = { respondValues(request, it) },
            modifier = Modifier.fillMaxWidth(), connected = connected,
            error = if (!connected) "连接已断开，连接后可重试" else request.responseError ?: error,
            draftState = draft, compact = true,
        )
        return
    }
    NeumorphTextButton(
        text = "待处理 ${requests.size} 项，${request.title}", filled = true,
        modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 4.dp), onClick = { open = true },
    )
    if (open) SessionControlDialog("待处理 ${requests.size} 项", onClose = { open = false }) {
        if (requests.size > 1) Row(
            Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = 12.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            requests.forEachIndexed { index, item ->
                NeumorphTextButton("${index + 1}. ${item.title}", filled = item.requestId == request.requestId,
                    onClick = { selectedId = item.requestId })
            }
        }
        val submitting = request.responseCommandId in pendingCommands
        val message = if (!connected) "连接已断开，草稿已保留，连接后可重试" else request.responseError ?: error
        val draft = drafts.getOrPut(request.requestId) { InteractionDraft(InteractionDraftValue(input = request.initialValue.orEmpty())) }
        key(request.requestId) {
            if (request.kind == "questionnaire") QuestionnairePanel(
                request, submitting, message,
                onSubmit = { respondQuestionnaire(request, it) }, onCancel = { respondQuestionnaire(request, null) },
                modifier = Modifier.weight(1f), connected = connected, draftState = draft,
            ) else InteractionPanel(
                request, submitting, respondConfirm = { respondConfirm(request, it) },
                respondValue = { respondValue(request, it) }, respondValues = { respondValues(request, it) },
                modifier = Modifier.weight(1f), connected = connected, error = message, draftState = draft,
                onCancel = { onCancel(request) },
            )
        }
    }
}

/** 原面板位置的覆盖式短状态（V06）：不插入消息行、不推动正文；确认前带轻量处理中标记，结算后约 2.5 秒消失（V16）。 */
@Composable
private fun InteractionStatus(status: Triple<String, Boolean, String?>?) {
    status ?: return
    var hidden by remember(status.third) { mutableStateOf(false) }
    if (status.third != null) LaunchedEffect(status.third) { delay(2_500); hidden = true }
    if (hidden) return
    NeumorphSurface(
        modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 4.dp).testTag("interaction-status"),
        shape = RemoteUi.ControlShape, style = NeumorphStyle.Pressed,
    ) {
        Row(Modifier.fillMaxWidth().heightIn(min = 44.dp).padding(horizontal = 14.dp), verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            if (status.second) CircularProgressIndicator(Modifier.size(16.dp), strokeWidth = 2.dp)
            Text(status.first, style = MaterialTheme.typography.bodyMedium, maxLines = 2)
        }
    }
}
