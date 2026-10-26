import { describe, expect, it } from "vitest";
import type { InteractionResponse } from "@orbis/protocol";
import { dshUserQuestionAnswer, dshUserQuestionInteraction } from "./dsh-user-questions.js";

const question = (extra: Record<string, unknown> = {}) => ({
  id: "choice", question: "选择方案", header: "方案", options: [
    { label: "方案 A", description: "保留现有数据" }, { label: "方案 B" },
  ], ...extra,
});
const interaction = (questions = [question()]) => dshUserQuestionInteraction("dsh:session", "request-1", { questions })!;
const response = (answers: unknown): InteractionResponse => ({ kind: "questionnaire", answers } as InteractionResponse);

describe("dshUserQuestionInteraction", () => {
  it("maps IDs, headers, descriptions and indexed options using the existing protocol", () => {
    expect(interaction()).toEqual({
      kind: "questionnaire", runtimeId: "dsh:session", requestId: "request-1", extensionId: "dsh",
      title: "DSH 需要你的回答", expiresAt: Number.MAX_SAFE_INTEGER,
      questions: [{ id: "choice", question: "选择方案", header: "方案", allowOther: true,
        options: [{ value: "0", label: "方案 A", description: "保留现有数据" }, { value: "1", label: "方案 B" }] }],
    });
  });

  it("preserves long Markdown details verbatim and associates each with its question", () => {
    const plan = "# 实施计划\n\n- **验证**现有数据\n\n```ts\nconst plan = true;\n```\n".repeat(500);
    const result = interaction([
      question({ detail: plan }),
      question({ id: "next", header: "下一步", question: "执行吗？", detail: "## 后续\n\n继续执行。", multiSelect: true }),
    ]);
    expect(result.description).toBe(`方案\n\n选择方案\n\n${plan}\n\n下一步\n\n执行吗？\n\n## 后续\n\n继续执行。`);
    expect(result.questions[1]?.multiSelect).toBe(true);
    expect(result.questions[0]).not.toHaveProperty("detail");
  });

  it("supports free text questions with omitted or empty options and absent headers", () => {
    for (const options of [undefined, []]) {
      const result = interaction([question({ options, header: undefined, detail: "详细说明" })]);
      expect(result.questions[0]).toMatchObject({ options: [], allowOther: true });
      expect(result.description).toBe("选择方案\n\n详细说明");
    }
  });

  it.each([
    {}, { questions: null }, { questions: "question" }, { questions: [] }, { questions: [null] },
    { questions: [question(), question()] },
    ...[
      { id: "" }, { id: 1 }, { question: "" }, { question: false }, { header: 1 },
      { detail: {} }, { options: null }, { options: {} }, { options: [null] },
      { options: ["label"] }, { options: [{}] }, { options: [{ label: "" }] },
      { options: [{ label: "ok", description: 1 }] }, { multiSelect: "true" },
    ].map((extra) => ({ questions: [question(extra)] })),
  ])("returns undefined for unsupported or malformed requests: %j", (request) => {
    expect(dshUserQuestionInteraction("runtime", "request", request)).toBeUndefined();
  });

  it.each([
    { id: "x".repeat(257) }, { header: "x".repeat(101) }, { question: "x".repeat(4_001) },
    { options: Array.from({ length: 33 }, () => ({ label: "option" })) },
    { options: [{ label: "x".repeat(513) }] },
    { options: [{ label: "option", description: "x".repeat(4_001) }] },
  ])("rejects protocol overflow without truncation: %j", (extra) => {
    expect(dshUserQuestionInteraction("runtime", "request", { questions: [question(extra)] })).toBeUndefined();
  });

  it("accepts exact protocol capacities and rejects excess questions or missing envelope IDs", () => {
    const questions = Array.from({ length: 16 }, (_, index) => question({
      id: `${index}`.padEnd(256, "x"), header: "h".repeat(100), question: "q".repeat(4_000),
      options: Array.from({ length: 32 }, () => ({ label: "l".repeat(512), description: "d".repeat(4_000) })),
    }));
    expect(interaction(questions).questions).toHaveLength(16);
    expect(dshUserQuestionInteraction("runtime", "request", { questions: [...questions, question()] })).toBeUndefined();
    expect(dshUserQuestionInteraction("", "request", { questions: [question()] })).toBeUndefined();
    expect(dshUserQuestionInteraction("runtime", "", { questions: [question()] })).toBeUndefined();
  });
});

describe("dshUserQuestionAnswer", () => {
  it("maps selected values back to labels and returns answers in request order", () => {
    const request = interaction([question(), question({ id: "text", options: [] })]);
    expect(dshUserQuestionAnswer(request, response([
      { id: "text", values: [], other: "  自定义回答\n第二行  " },
      { id: "choice", values: ["1"] },
    ]))).toEqual({ answers: [
      { id: "choice", selected: ["方案 B"] }, { id: "text", selected: [], custom: "自定义回答\n第二行" },
    ] });
  });

  it("allows multiple selections together with custom text only for multi-select", () => {
    const request = interaction([question({ multiSelect: true })]);
    expect(dshUserQuestionAnswer(request, response([
      { id: "choice", values: ["1", "0"], other: "还有其他方案" },
    ]))).toEqual({ answers: [{ id: "choice", selected: ["方案 B", "方案 A"], custom: "还有其他方案" }] });
  });

  it("allows a custom-only answer for single-select", () => {
    expect(dshUserQuestionAnswer(interaction(), response([{ id: "choice", values: [], other: "不同方案" }])))
      .toEqual({ answers: [{ id: "choice", selected: [], custom: "不同方案" }] });
  });

  it.each([
    [], [{ id: "unknown", values: ["0"] }],
    [{ id: "choice", values: ["0"] }, { id: "choice", values: ["1"] }],
    [{ id: "choice", values: ["2"] }], [{ id: "choice", values: ["00"] }],
    [{ id: "choice", values: ["-1"] }], [{ id: "choice", values: ["方案 A"] }],
    [{ id: "choice", values: ["0", "0"] }], [{ id: "choice", values: ["0", "1"] }],
    [{ id: "choice", values: ["0"], other: "自定义" }], [{ id: "choice", values: [] }],
    [{ id: "choice", values: [], other: " \n " }], [{ id: "choice", values: ["0"], other: "" }],
    [{ id: "choice", values: ["0"], notes: "说明" }], [{ id: "choice", values: ["0"], notes: "" }],
    [{ id: "choice", values: ["0"], notes: " " }], [{ id: "choice", values: [], other: "x".repeat(4_001) }],
    [{ id: "choice", values: [0] }], [{ id: "choice", values: "0" }],
  ].map((answers) => [answers]))("rejects invalid answers: %j", (answers) => {
    expect(() => dshUserQuestionAnswer(interaction(), response(answers))).toThrow();
  });

  it("requires every question exactly once even when answer counts match", () => {
    const request = interaction([question(), question({ id: "second" })]);
    for (const answers of [
      [{ id: "choice", values: ["0"] }],
      [{ id: "choice", values: ["0"] }, { id: "choice", values: ["1"] }],
      [{ id: "choice", values: ["0"] }, { id: "unknown", values: ["1"] }],
    ]) expect(() => dshUserQuestionAnswer(request, response(answers))).toThrow();
  });

  it("rejects duplicate or empty multi-select responses and notes", () => {
    const request = interaction([question({ multiSelect: true })]);
    for (const answer of [
      { id: "choice", values: ["0", "0"] }, { id: "choice", values: [] },
      { id: "choice", values: ["0"], notes: "" },
    ]) expect(() => dshUserQuestionAnswer(request, response([answer]))).toThrow();
  });

  it("rejects other response kinds and disallowed custom answers", () => {
    for (const answer of [{ kind: "cancel" }, { kind: "input", value: "text" }, { kind: "select", value: "0" }] as InteractionResponse[]) {
      expect(() => dshUserQuestionAnswer(interaction(), answer)).toThrow();
    }
    const request = interaction();
    request.questions[0]!.allowOther = false;
    expect(() => dshUserQuestionAnswer(request, response([{ id: "choice", values: [], other: "custom" }]))).toThrow();
  });
});
