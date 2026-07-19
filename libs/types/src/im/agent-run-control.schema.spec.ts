import { AgentRunControlSchema } from "./im.schema";

describe("AgentRunControlSchema", () => {
  it("answer kind 承载结构化 AnswerItem[](含 other)", () => {
    const parsed = AgentRunControlSchema.parse({
      streamId: "s1",
      targetAgentId: "d1",
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
        targetAgentId: "d1",
        sessionId: "sess1",
        kind: "answer",
        toolCallId: "tc1",
        answers: [{ other: "x" }],
      }),
    ).toThrow();
  });
});

describe("AgentRunControl 双寻址", () => {
  const base = {
    targetAgentId: "a1",
    sessionId: "s1",
    kind: "confirm" as const,
    toolCallId: "t1",
    decision: "send" as const,
  };
  it("只带 streamId 通过", () => {
    expect(
      AgentRunControlSchema.safeParse({ ...base, streamId: "st1" }).success,
    ).toBe(true);
  });
  it("只带 watchId 通过（观察者应答）", () => {
    expect(
      AgentRunControlSchema.safeParse({ ...base, watchId: "w1" }).success,
    ).toBe(true);
  });
  it("都不带 / 都带 均被拒", () => {
    expect(AgentRunControlSchema.safeParse(base).success).toBe(false);
    expect(
      AgentRunControlSchema.safeParse({
        ...base,
        streamId: "st1",
        watchId: "w1",
      }).success,
    ).toBe(false);
  });
  it("watchId 携带 interrupt 被拒（打断仍限发起方）", () => {
    expect(
      AgentRunControlSchema.safeParse({
        targetAgentId: "a1",
        sessionId: "s1",
        kind: "interrupt",
        watchId: "w1",
      }).success,
    ).toBe(false);
  });
});
