import { AgentWatchInboundService } from "./agent-watch-inbound.service";

describe("AgentWatchInboundService", () => {
  const mk = () => {
    const watches = { addWatcher: jest.fn(), removeWatcher: jest.fn() };
    const mirror = { addWatcher: jest.fn(), removeWatcher: jest.fn() };
    const runner = { getInflight: jest.fn().mockReturnValue(null) };
    const agents = { findOrNull: jest.fn() };
    const sessions = { findOrNull: jest.fn() };
    const relay = { emitAgentWatchAccepted: jest.fn() };
    const account = { run: jest.fn((_: string, fn: () => unknown) => fn()) };
    const registry = { bindWatch: jest.fn(), unbindWatch: jest.fn() };
    const svc = new AgentWatchInboundService(
      watches as never,
      mirror as never,
      runner as never,
      agents as never,
      sessions as never,
      relay as never,
      account as never,
      registry as never,
    );
    return { svc, watches, mirror, runner, agents, sessions, relay, registry };
  };

  const startEvt = (over: Record<string, unknown> = {}) => ({
    cloudUserId: "u1",
    forwarded: {
      watchId: "w1",
      localAgentId: "a1",
      scope: "session" as const,
      sessionId: "s1",
      action: "start" as const,
      requesterDeviceId: "user:sock-1",
      ...over,
    },
  });

  it("Agent 未开远程 → 拒绝并回 ok:false", async () => {
    const { svc, agents, watches, relay } = mk();
    agents.findOrNull.mockResolvedValue({ id: "a1", remoteEnabled: false });
    await svc.onAgentWatch(startEvt() as never);
    expect(watches.addWatcher).not.toHaveBeenCalled();
    expect(relay.emitAgentWatchAccepted).toHaveBeenCalledWith("u1", {
      watchId: "w1",
      ok: false,
      reason: "not_found",
    });
  });

  it("Agent 查无 → 拒绝（身份维度同样回 not_found）", async () => {
    const { svc, agents, watches, relay } = mk();
    agents.findOrNull.mockResolvedValue(null);
    await svc.onAgentWatch(startEvt() as never);
    expect(watches.addWatcher).not.toHaveBeenCalled();
    expect(relay.emitAgentWatchAccepted).toHaveBeenCalledWith("u1", {
      watchId: "w1",
      ok: false,
      reason: "not_found",
    });
  });

  it("session scope：被观察会话不归该 Agent → 拒绝（防跳板越权观察）", async () => {
    const { svc, agents, sessions, watches, relay } = mk();
    agents.findOrNull.mockResolvedValue({ id: "a1", remoteEnabled: true });
    sessions.findOrNull.mockResolvedValue({ id: "s1", agentId: "别的Agent" });
    await svc.onAgentWatch(startEvt() as never);
    expect(watches.addWatcher).not.toHaveBeenCalled();
    // 会话归属维度与身份维度必须回不同 reason——合成一条会让排查分不清
    // 「Agent 不可观察」与「问错了会话」。
    expect(relay.emitAgentWatchAccepted).toHaveBeenCalledWith("u1", {
      watchId: "w1",
      ok: false,
      reason: "session_agent_mismatch",
    });
  });

  it("session scope 缺 sessionId → 回 session_agent_mismatch（会话维度）", async () => {
    const { svc, agents, watches, relay } = mk();
    agents.findOrNull.mockResolvedValue({ id: "a1", remoteEnabled: true });
    const evt = startEvt() as never as {
      forwarded: { sessionId?: string | null };
    };
    evt.forwarded.sessionId = null;
    await svc.onAgentWatch(evt as never);
    expect(watches.addWatcher).not.toHaveBeenCalled();
    expect(relay.emitAgentWatchAccepted).toHaveBeenCalledWith("u1", {
      watchId: "w1",
      ok: false,
      reason: "session_agent_mismatch",
    });
  });

  it("session scope 合法 → 登记观察者并回 inflight 快照（D7 中途续上）", async () => {
    const { svc, agents, sessions, runner, watches, relay, registry } = mk();
    agents.findOrNull.mockResolvedValue({ id: "a1", remoteEnabled: true });
    sessions.findOrNull.mockResolvedValue({ id: "s1", agentId: "a1" });
    const inflight = {
      messageId: "m1",
      content: "半截",
      reasoning: "",
      reasoningStartedAt: null,
      toolCalls: [],
      status: "streaming",
    };
    runner.getInflight.mockReturnValue(inflight);
    await svc.onAgentWatch(startEvt() as never);
    expect(watches.addWatcher).toHaveBeenCalledWith("u1", "a1", "s1", "w1");
    // HITL watchId 寻址（Task 16）：session scope 受理必须同步登记 registry。
    expect(registry.bindWatch).toHaveBeenCalledWith("w1", "s1");
    expect(relay.emitAgentWatchAccepted).toHaveBeenCalledWith("u1", {
      watchId: "w1",
      ok: true,
      inflight,
    });
  });

  it("session scope 无活跃 run → inflight 为 null（不是报错）", async () => {
    const { svc, agents, sessions, runner, relay } = mk();
    agents.findOrNull.mockResolvedValue({ id: "a1", remoteEnabled: true });
    sessions.findOrNull.mockResolvedValue({ id: "s1", agentId: "a1" });
    runner.getInflight.mockReturnValue(null);
    await svc.onAgentWatch(startEvt() as never);
    expect(relay.emitAgentWatchAccepted).toHaveBeenCalledWith("u1", {
      watchId: "w1",
      ok: true,
      inflight: null,
    });
  });

  it("agent scope：不查会话、不带 inflight，登记到 AgentWatchMirrorService", async () => {
    const { svc, agents, sessions, watches, mirror, relay, registry } = mk();
    agents.findOrNull.mockResolvedValue({ id: "a1", remoteEnabled: true });
    await svc.onAgentWatch(
      startEvt({ scope: "agent", sessionId: undefined }) as never,
    );
    expect(sessions.findOrNull).not.toHaveBeenCalled();
    expect(watches.addWatcher).not.toHaveBeenCalled(); // Agent 级不走 SessionWatchService
    expect(mirror.addWatcher).toHaveBeenCalledWith("u1", "a1", "w1"); // 而是走 AgentWatchMirrorService
    // Agent 级不涉及 HITL，不登记 registry（HITL 只发生在 session 级）。
    expect(registry.bindWatch).not.toHaveBeenCalled();
    expect(relay.emitAgentWatchAccepted).toHaveBeenCalledWith("u1", {
      watchId: "w1",
      ok: true,
      inflight: null,
    });
  });

  it("action:stop → 两级都注销观察者（不知道是哪级，各自对未知 id 幂等），不回受理包", async () => {
    const { svc, watches, mirror, relay, registry } = mk();
    await svc.onAgentWatch(startEvt({ action: "stop" }) as never);
    expect(watches.removeWatcher).toHaveBeenCalledWith("w1");
    expect(mirror.removeWatcher).toHaveBeenCalledWith("w1");
    // HITL watchId 寻址（Task 16）：stop 必须对称注销 registry 映射，
    // 否则 idle 拆除前这个 watchId 仍能放行 HITL。
    expect(registry.unbindWatch).toHaveBeenCalledWith("w1");
    expect(relay.emitAgentWatchAccepted).not.toHaveBeenCalled();
  });

  it("action:stop 不做鉴权查表（云端断线清理下发，必须无条件生效）", async () => {
    const { svc, agents } = mk();
    await svc.onAgentWatch(startEvt({ action: "stop" }) as never);
    expect(agents.findOrNull).not.toHaveBeenCalled();
  });

  it("内部异常 → 回 ok:false reason:error，不抛出（不炸 relay 监听器）", async () => {
    const { svc, agents, relay } = mk();
    agents.findOrNull.mockRejectedValue(new Error("boom"));
    await expect(
      svc.onAgentWatch(startEvt() as never),
    ).resolves.toBeUndefined();
    expect(relay.emitAgentWatchAccepted).toHaveBeenCalledWith("u1", {
      watchId: "w1",
      ok: false,
      reason: "error",
    });
  });
});
