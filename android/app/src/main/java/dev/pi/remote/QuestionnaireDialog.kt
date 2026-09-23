package dev.pi.remote

import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.Saver
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.delay
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json

private fun emptyQuestionDraft(question: QuestionnaireQuestion) =
    QuestionnaireDraft(otherSelected = question.options.isEmpty() && question.allowOther)

/** One saved draft and one response for the entire questionnaire. */
@Composable
internal fun QuestionnairePanel(
    request: PendingInteraction,
    submitting: Boolean,
    error: String?,
    onSubmit: (List<QuestionnaireAnswer>) -> Unit,
    onCancel: () -> Unit,
    modifier: Modifier = Modifier.fillMaxWidth().height(360.dp),
    connected: Boolean = true,
    draftState: InteractionDraft? = null,
) {
    // Secret answers must not be serialized into Android saved state.
    val draftSaver = remember(request.requestId) {
        Saver<InteractionDraft, String>(
            save = { Json.encodeToString(savableInteractionDraft(request, it.value)) },
            restore = { InteractionDraft(Json.decodeFromString(it)) },
        )
    }
    val localDraft = rememberSaveable(request.requestId, saver = draftSaver) { InteractionDraft() }
    val form = draftState ?: localDraft
    val drafts = form.value.answers
    val page = form.value.page
    val setPage: (Int) -> Unit = { form.value = form.value.copy(page = it) }
    var now by remember(request.requestId) { mutableStateOf(System.currentTimeMillis()) }
    LaunchedEffect(request.requestId, request.expiresAt) {
        if (interactionHasDeadline(request)) {
            while (!isInteractionExpired(request, now)) {
                delay(1_000)
                now = System.currentTimeMillis()
            }
        }
    }
    val expired = isInteractionExpired(request, now)
    val enabled = connected && !submitting && !request.submitted && !expired
    val questions = request.questions
    if (questions.isEmpty()) return
    val current = page.coerceIn(0, questions.lastIndex)
    val question = questions[current]
    val draft = drafts[question.id] ?: emptyQuestionDraft(question)
    val answers = questions.mapNotNull { (drafts[it.id] ?: emptyQuestionDraft(it)).answer(it) }
    val update: (QuestionnaireDraft) -> Unit = { form.value = form.value.copy(answers = drafts + (question.id to it)) }

    Column(
        modifier = modifier
            .padding(horizontal = 12.dp, vertical = 8.dp),
    ) {
        NeumorphSurface(
            modifier = Modifier.fillMaxSize(),
            shape = RemoteUi.CardShape,
        ) {
            Column(Modifier.fillMaxSize().padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                    Text(request.title, modifier = Modifier.weight(1f), style = MaterialTheme.typography.titleLarge)
                    NeumorphTextButton("取消回答", enabled = enabled, onClick = onCancel)
                }
                if (questions.size > 1) {
                    Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        questions.forEachIndexed { index, item ->
                            val answered = answers.any { it.id == item.id }
                            NeumorphTextButton(
                                text = "${index + 1}. ${item.header?.takeIf(String::isNotBlank) ?: "问题"}${if (answered) " ✓" else ""}",
                                filled = current == index,
                                onClick = { setPage(index) },
                            )
                        }
                    }
                }
                Text(
                    "第 ${current + 1} / ${questions.size} 题 · ${if (question.options.isEmpty()) "填写回答" else if (question.multiSelect) "可多选" else "单选"}",
                    style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                key(question.id) {
                    Column(
                        Modifier
                            .weight(1f)
                            .fillMaxWidth()
                            .heightIn(min = 0.dp)
                        .verticalScroll(rememberScrollState())
                        .padding(4.dp),
                        verticalArrangement = Arrangement.spacedBy(12.dp),
                    ) {
                        request.description?.let { Text(it, style = MaterialTheme.typography.bodySmall) }
                        Text(question.question, style = MaterialTheme.typography.titleMedium)
                        question.options.forEach { option ->
                            QuestionnaireOption(
                                label = option.label, description = option.description,
                                selected = option.value in draft.values, multiple = question.multiSelect,
                                enabled = enabled, onClick = { update(draft.toggle(question, option.value)) },
                            )
                        }
                        if (question.allowOther) {
                            if (question.options.isNotEmpty()) QuestionnaireOption(
                                label = "其他答案", description = null, selected = draft.otherSelected,
                                multiple = question.multiSelect, enabled = enabled,
                                onClick = { update(draft.toggleOther(question)) },
                            )
                            if (draft.otherSelected) {
                                OutlinedTextField(
                                    value = draft.other, onValueChange = { update(draft.copy(other = it)) },
                                    modifier = Modifier.fillMaxWidth(), enabled = !submitting && !request.submitted && !expired,
                                    label = { Text(if (question.options.isEmpty()) "填写回答" else "填写其他答案") },
                                    minLines = if (question.secret) 1 else 2, maxLines = if (question.secret) 1 else 5,
                                    visualTransformation = if (question.secret) PasswordVisualTransformation() else VisualTransformation.None,
                                    keyboardOptions = if (question.secret) androidx.compose.foundation.text.KeyboardOptions(keyboardType = androidx.compose.ui.text.input.KeyboardType.Password) else androidx.compose.foundation.text.KeyboardOptions.Default,
                                    isError = draft.other.length > 4_000,
                                    supportingText = { if (draft.other.length > 4_000) Text("最多 4000 个字符") },
                                )
                            }
                        }
                        if (question.allowNotes) {
                            OutlinedTextField(
                                value = draft.notes, onValueChange = { update(draft.copy(notes = it)) },
                                modifier = Modifier.fillMaxWidth(), enabled = enabled,
                                label = { Text("补充说明（可选）") }, minLines = 2, maxLines = 5,
                                isError = draft.notes.length > 4_000,
                                supportingText = { if (draft.notes.length > 4_000) Text("最多 4000 个字符") },
                            )
                        }
                    }
                }
                if (expired) Text("此提问已超时", color = MaterialTheme.colorScheme.error)
                error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
                Text(
                    if (submitting || request.submitted) "已提交，等待电脑确认…" else if (answers.size == questions.size) "答案已填好，可继续修改或提交"
                    else "已回答 ${answers.size} / ${questions.size} 题",
                    style = MaterialTheme.typography.bodySmall,
                    maxLines = 1,
                )
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    if (current > 0) NeumorphTextButton("上一题", onClick = { setPage(current - 1) })
                    if (current < questions.lastIndex) {
                        NeumorphTextButton("下一题", modifier = Modifier.weight(1f), filled = true, onClick = { setPage(current + 1) })
                    } else {
                        NeumorphTextButton(
                            if (submitting) "正在提交…" else "提交答案", modifier = Modifier.weight(1f), filled = true,
                            enabled = enabled && answers.size == questions.size,
                            onClick = { onSubmit(answers) },
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun QuestionnaireOption(
    label: String,
    description: String?,
    selected: Boolean,
    multiple: Boolean,
    enabled: Boolean,
    onClick: () -> Unit,
) {
    val selection = if (multiple) Modifier.toggleable(value = selected, enabled = enabled, role = Role.Checkbox) { onClick() }
    else Modifier.selectable(selected = selected, enabled = enabled, role = Role.RadioButton, onClick = onClick)
    NeumorphSurface(
        modifier = Modifier.fillMaxWidth().then(selection),
        shape = RemoteUi.ControlShape,
        style = if (selected) NeumorphStyle.Pressed else NeumorphStyle.Raised,
        shadowScale = 0.45f,
    ) {
        Row(Modifier.padding(8.dp), verticalAlignment = Alignment.CenterVertically) {
            if (multiple) NeumorphCheckbox(checked = selected, onCheckedChange = null, enabled = enabled)
            else RadioButton(selected = selected, onClick = null, enabled = enabled)
            Column(Modifier.weight(1f).padding(start = 8.dp)) {
                Text(label)
                description?.let { Text(it, style = MaterialTheme.typography.bodySmall) }
            }
        }
    }
}
