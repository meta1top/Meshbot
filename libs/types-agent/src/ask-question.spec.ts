import { describe, expect, it } from "@jest/globals";
import { answerQuestionsSchema, askQuestionSchema } from "./ask-question";

describe("askQuestionSchema", () => {
  it("接受 1 个带选项的问题", () => {
    const p = askQuestionSchema.parse({
      questions: [
        {
          question: "选哪个?",
          options: [{ label: "A" }, { label: "B", description: "乙" }],
          multiSelect: false,
        },
      ],
    });
    expect(p.questions).toHaveLength(1);
    expect(p.questions[0].options[1].description).toBe("乙");
  });
  it("questions 1–4，超出/为空报错", () => {
    expect(() => askQuestionSchema.parse({ questions: [] })).toThrow();
    const five = Array.from({ length: 5 }, () => ({
      question: "q",
      options: [{ label: "A" }],
      multiSelect: false,
    }));
    expect(() => askQuestionSchema.parse({ questions: five })).toThrow();
  });
  it("options 至少 1 项、question 非空", () => {
    expect(() =>
      askQuestionSchema.parse({
        questions: [{ question: "q", options: [], multiSelect: false }],
      }),
    ).toThrow();
    expect(() =>
      askQuestionSchema.parse({
        questions: [
          { question: "", options: [{ label: "A" }], multiSelect: false },
        ],
      }),
    ).toThrow();
  });
});

describe("answerQuestionsSchema", () => {
  it("接受 toolCallId + answers(selected + 可选 other)", () => {
    const p = answerQuestionsSchema.parse({
      toolCallId: "t",
      answers: [{ selected: ["A"], other: "自定义" }, { selected: [] }],
    });
    expect(p.answers[0].selected).toEqual(["A"]);
    expect(p.answers[1].other).toBeUndefined();
  });
  it("缺 toolCallId 报错", () => {
    expect(() => answerQuestionsSchema.parse({ answers: [] })).toThrow();
  });
});
