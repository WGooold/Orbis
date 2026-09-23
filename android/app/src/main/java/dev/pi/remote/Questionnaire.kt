package dev.pi.remote

import kotlinx.serialization.Serializable

@Serializable
data class QuestionnaireQuestion(
    val id: String,
    val question: String,
    val options: List<InteractionOption>,
    val header: String? = null,
    val multiSelect: Boolean = false,
    val allowOther: Boolean = false,
    val allowNotes: Boolean = false,
    val secret: Boolean = false,
)

@Serializable
data class QuestionnaireAnswer(
    val id: String,
    val values: List<String>,
    val other: String? = null,
    val notes: String? = null,
)

@Serializable
internal data class QuestionnaireDraft(
    val values: List<String> = emptyList(),
    val otherSelected: Boolean = false,
    val other: String = "",
    val notes: String = "",
) {
    fun toggle(question: QuestionnaireQuestion, value: String): QuestionnaireDraft =
        if (question.multiSelect) {
            copy(values = if (value in values) values - value else values + value)
        } else copy(values = listOf(value), otherSelected = false)

    fun toggleOther(question: QuestionnaireQuestion): QuestionnaireDraft = copy(
        otherSelected = !otherSelected,
        values = if (!question.multiSelect && !otherSelected) emptyList() else values,
    )

    fun answer(question: QuestionnaireQuestion): QuestionnaireAnswer? {
        val custom = if (otherSelected) other.trim() else null
        if (otherSelected && (!question.allowOther || custom.isNullOrEmpty() || other.length > 4_000)) return null
        if (values.distinct().size != values.size || values.any { value -> question.options.none { it.value == value } }) return null
        val count = values.size + if (otherSelected) 1 else 0
        if (count == 0 || (!question.multiSelect && count != 1)) return null
        if (question.allowNotes && notes.length > 4_000) return null
        return QuestionnaireAnswer(
            id = question.id,
            values = values,
            other = custom,
            notes = notes.trim().takeIf { question.allowNotes && it.isNotEmpty() },
        )
    }
}
