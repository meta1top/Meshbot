import {
  AgentRunControlSchema,
  AgentRunFrameSchema,
  AgentRunStartSchema,
} from "./im.schema";

describe("AgentRunStartSchema", () => {
  it("create 模式可无 sessionId", () => {
    const r = AgentRunStartSchema.parse({
      streamId: "s1",
      targetAgentId: "dB",
      mode: "create",
      content: "hi",
    });
    expect(r.mode).toBe("create");
  });
  it("append 模式带 sessionId", () => {
    const r = AgentRunStartSchema.parse({
      streamId: "s1",
      targetAgentId: "dB",
      mode: "append",
      sessionId: "sess1",
      content: "hi",
    });
    expect(r.sessionId).toBe("sess1");
  });
  it("拒绝非法 mode", () => {
    expect(() =>
      AgentRunStartSchema.parse({
        streamId: "s1",
        targetAgentId: "dB",
        mode: "x",
        content: "hi",
      }),
    ).toThrow();
  });
});
describe("AgentRunControlSchema", () => {
  it("interrupt 控制帧", () => {
    const r = AgentRunControlSchema.parse({
      streamId: "s1",
      targetAgentId: "dB",
      sessionId: "sess1",
      kind: "interrupt",
    });
    expect(r.kind).toBe("interrupt");
  });
  it("confirm 带 toolCallId+decision", () => {
    const r = AgentRunControlSchema.parse({
      streamId: "s1",
      targetAgentId: "dB",
      sessionId: "sess1",
      kind: "confirm",
      toolCallId: "t1",
      decision: "send",
    });
    expect(r.decision).toBe("send");
  });
});
describe("AgentRunFrame 双寻址", () => {
  const base = {
    requesterDeviceId: "dev-a",
    seq: 1,
    sessionId: "s1",
    event: "run.chunk",
    payload: {},
  };

  it("只带 streamId 通过（自己发起的流）", () => {
    expect(
      AgentRunFrameSchema.safeParse({ ...base, streamId: "st1" }).success,
    ).toBe(true);
  });

  it("只带 watchId 通过（观察的流）", () => {
    expect(
      AgentRunFrameSchema.safeParse({ ...base, watchId: "w1" }).success,
    ).toBe(true);
  });

  it("两个都不带被拒", () => {
    expect(AgentRunFrameSchema.safeParse(base).success).toBe(false);
  });

  it("两个都带被拒（寻址歧义）", () => {
    expect(
      AgentRunFrameSchema.safeParse({ ...base, streamId: "st1", watchId: "w1" })
        .success,
    ).toBe(false);
  });
});
