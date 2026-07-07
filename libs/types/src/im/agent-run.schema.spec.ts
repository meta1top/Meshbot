import { AgentRunControlSchema, AgentRunStartSchema } from "./im.schema";

describe("AgentRunStartSchema", () => {
  it("create 模式可无 sessionId", () => {
    const r = AgentRunStartSchema.parse({
      streamId: "s1",
      targetDeviceId: "dB",
      mode: "create",
      content: "hi",
    });
    expect(r.mode).toBe("create");
  });
  it("append 模式带 sessionId", () => {
    const r = AgentRunStartSchema.parse({
      streamId: "s1",
      targetDeviceId: "dB",
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
        targetDeviceId: "dB",
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
      targetDeviceId: "dB",
      sessionId: "sess1",
      kind: "interrupt",
    });
    expect(r.kind).toBe("interrupt");
  });
  it("confirm 带 toolCallId+decision", () => {
    const r = AgentRunControlSchema.parse({
      streamId: "s1",
      targetDeviceId: "dB",
      sessionId: "sess1",
      kind: "confirm",
      toolCallId: "t1",
      decision: "send",
    });
    expect(r.decision).toBe("send");
  });
});
