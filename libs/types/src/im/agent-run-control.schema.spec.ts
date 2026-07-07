import { AgentRunControlSchema } from "./im.schema";

describe("AgentRunControlSchema", () => {
  it("answer kind 承载结构化 AnswerItem[](含 other)", () => {
    const parsed = AgentRunControlSchema.parse({
      streamId: "s1",
      targetDeviceId: "d1",
      sessionId: "sess1",
      kind: "answer",
      toolCallId: "tc1",
      answers: [{ selected: ["A", "B"], other: "自定义" }, { selected: ["X"] }],
    });
    expect(parsed.answers).toEqual([
      { selected: ["A", "B"], other: "自定义" },
      { selected: ["X"] },
    ]);
  });

  it("answers 里缺 selected → 拒", () => {
    expect(() =>
      AgentRunControlSchema.parse({
        streamId: "s1",
        targetDeviceId: "d1",
        sessionId: "sess1",
        kind: "answer",
        toolCallId: "tc1",
        answers: [{ other: "x" }],
      }),
    ).toThrow();
  });
});
