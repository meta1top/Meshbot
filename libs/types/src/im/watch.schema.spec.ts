import {
  AgentWatchAcceptedSchema,
  AgentWatchForwardedSchema,
  AgentWatchFrameSchema,
  AgentWatchStartSchema,
  AgentWatchStopSchema,
} from "./watch.schema";

describe("watch schema", () => {
  it("agent scope 不需要 sessionId", () => {
    const r = AgentWatchStartSchema.safeParse({
      watchId: "w1",
      targetAgentId: "cloud-a1",
      scope: "agent",
    });
    expect(r.success).toBe(true);
  });

  it("session scope 缺 sessionId 被拒", () => {
    const r = AgentWatchStartSchema.safeParse({
      watchId: "w1",
      targetAgentId: "cloud-a1",
      scope: "session",
    });
    expect(r.success).toBe(false);
  });

  it("session scope 带 sessionId 通过", () => {
    const r = AgentWatchStartSchema.safeParse({
      watchId: "w1",
      targetAgentId: "cloud-a1",
      scope: "session",
      sessionId: "s1",
    });
    expect(r.success).toBe(true);
  });

  it("watchId 空串被拒", () => {
    expect(AgentWatchStopSchema.safeParse({ watchId: "" }).success).toBe(false);
  });

  it("镜像帧带 localAgentId 与 seq", () => {
    const r = AgentWatchFrameSchema.safeParse({
      localAgentId: "local-a1",
      scope: "session",
      sessionId: "s1",
      seq: 1,
      event: "run.chunk",
      payload: { sessionId: "s1", delta: "hi" },
    });
    expect(r.success).toBe(true);
  });

  it("受理回包 ok=false 带 reason", () => {
    const r = AgentWatchAcceptedSchema.safeParse({
      watchId: "w1",
      ok: false,
      reason: "offline",
    });
    expect(r.success).toBe(true);
  });

  it("转发帧带 action 与 localAgentId", () => {
    const r = AgentWatchForwardedSchema.safeParse({
      watchId: "w1",
      localAgentId: "local-a1",
      scope: "agent",
      action: "start",
      requesterDeviceId: "user:sock-1",
    });
    expect(r.success).toBe(true);
  });
});
