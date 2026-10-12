import {
  InteractionRequestSchema,
  InteractionResponseSchema,
  type InteractionRequest,
  type InteractionResponse,
} from "@pi-remote/protocol";

type Questionnaire = Extract<InteractionRequest, { kind: "questionnaire" }>;
type DshAnswers = { answers: { id: string; selected: string[]; custom?: string }[] };

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Project DSH user-questions/request without losing question details or options. */
export function dshUserQuestionInteraction(
  runtimeId: string,
  requestId: string,
  request: Record<string, unknown>,
): Questionnaire | undefined {
  if (!Array.isArray(request.questions)) return undefined;
  const questions: Record<string, unknown>[] = [];
  const details: string[] = [];
  const ids = new Set<unknown>();
  for (const question of request.questions) {
    if (!record(question) || ids.has(question.id)
      || (question.detail !== undefined && typeof question.detail !== "string")
      || (question.options !== undefined && !Array.isArray(question.options))) return undefined;
    ids.add(question.id);
    const options: Record<string, unknown>[] = [];
    for (const [index, option] of (question.options ?? []).entries()) {
      if (!record(option)) return undefined;
      options.push({ value: String(index), label: option.label, description: option.description });
    }
    questions.push({
      id: question.id,
      question: question.question,
      header: question.header,
      options,
      multiSelect: question.multiSelect,
      allowOther: true,
    });
    if (question.detail !== undefined) {
      details.push([question.header, question.question, question.detail]
        .filter((part) => part !== undefined && part !== "").join("\n\n"));
    }
  }
  const parsed = InteractionRequestSchema.safeParse({
    kind: "questionnaire",
    runtimeId,
    requestId,
    extensionId: "dsh",
    title: "DSH 需要你的回答",
    expiresAt: Number.MAX_SAFE_INTEGER,
    description: details.length ? details.join("\n\n") : undefined,
    questions,
  });
  return parsed.success && parsed.data.kind === "questionnaire" ? parsed.data : undefined;
}

/** Validate a complete response before translating protocol values back to DSH labels. */
export function dshUserQuestionAnswer(
  interaction: Questionnaire,
  response: InteractionResponse,
): DshAnswers {
  const parsed = InteractionResponseSchema.safeParse(response);
  if (!parsed.success || parsed.data.kind !== "questionnaire") {
    throw new Error("请完整回答本次请求中的问题");
  }
  const answers = parsed.data.answers;
  if (answers.length !== interaction.questions.length
    || new Set(answers.map((answer) => answer.id)).size !== answers.length
    || new Set(interaction.questions.map((question) => question.id)).size !== interaction.questions.length) {
    throw new Error("请完整回答本次请求中的问题");
  }
  return { answers: interaction.questions.map((question) => {
    const answer = answers.find((candidate) => candidate.id === question.id);
    if (!answer || answer.notes !== undefined
      || new Set(answer.values).size !== answer.values.length
      || answer.values.some((value) => !question.options.some((option) => option.value === value))) {
      throw new Error("回答包含无效选项");
    }
    const custom = answer.other?.trim();
    if (answer.other !== undefined && (!question.allowOther || !custom)) {
      throw new Error("回答包含无效自定义内容");
    }
    const count = answer.values.length + (custom ? 1 : 0);
    if (count === 0 || (!question.multiSelect && count !== 1)) {
      throw new Error("请选择一个答案或填写内容");
    }
    return {
      id: question.id,
      selected: answer.values.map((value) => question.options.find((option) => option.value === value)!.label),
      ...(custom !== undefined ? { custom } : {}),
    };
  }) };
}
