import {
  nextModelOnTargetChange,
  resolveModelConfigForTarget,
} from "./resolve-model-config-for-target";

const agents = [
  { id: "agent-x", defaultModelConfigId: "model-deepseek-v4-pro" },
  { id: "agent-y", defaultModelConfigId: null },
];

describe("resolveModelConfigForTarget", () => {
  it("本机 target 且列表已加载：返回该 Agent 的 defaultModelConfigId", () => {
    expect(
      resolveModelConfigForTarget(
        { scope: "local", agentId: "agent-x" },
        agents,
      ),
    ).toBe("model-deepseek-v4-pro");
  });

  it("defaultModelConfigId 为 null（跟随账号默认）：原样返回 null 而非 undefined", () => {
    expect(
      resolveModelConfigForTarget(
        { scope: "local", agentId: "agent-y" },
        agents,
      ),
    ).toBeNull();
  });

  it("远程 target：无本机默认可联动，返回 undefined，不触碰模型选择器", () => {
    expect(
      resolveModelConfigForTarget(
        { scope: "remote", cloudAgentId: "ra1" },
        agents,
      ),
    ).toBeUndefined();
  });

  it("target 为 null：返回 undefined", () => {
    expect(resolveModelConfigForTarget(null, agents)).toBeUndefined();
  });

  it("agents 尚未加载（undefined）：返回 undefined，不误清空已选模型", () => {
    expect(
      resolveModelConfigForTarget(
        { scope: "local", agentId: "agent-x" },
        undefined,
      ),
    ).toBeUndefined();
  });

  it("命中不到该 id（已删除/竞态）：返回 undefined", () => {
    expect(
      resolveModelConfigForTarget(
        { scope: "local", agentId: "agent-z" },
        agents,
      ),
    ).toBeUndefined();
  });
});

describe("nextModelOnTargetChange", () => {
  it("target 身份没变（agents 引用变化触发重跑）：不联动，nextKey 原样透传", () => {
    expect(
      nextModelOnTargetChange(
        "local:agent-x",
        { scope: "local", agentId: "agent-x" },
        [...agents],
      ),
    ).toEqual({ nextKey: "local:agent-x", value: undefined });
  });

  it("首次选中本机 agent（prevKey=null）：联动成该 Agent 的默认模型", () => {
    expect(
      nextModelOnTargetChange(
        null,
        { scope: "local", agentId: "agent-x" },
        agents,
      ),
    ).toEqual({ nextKey: "local:agent-x", value: "model-deepseek-v4-pro" });
  });

  it("真的切了 agent（x→y）：重新联动，null 原样写入", () => {
    expect(
      nextModelOnTargetChange(
        "local:agent-x",
        { scope: "local", agentId: "agent-y" },
        agents,
      ),
    ).toEqual({ nextKey: "local:agent-y", value: null });
  });

  it("切到远程 target：不联动但 nextKey 更新；再切回同一本机 agent 会重新联动", () => {
    const toRemote = nextModelOnTargetChange(
      "local:agent-x",
      { scope: "remote", cloudAgentId: "ra1" },
      agents,
    );
    expect(toRemote).toEqual({ nextKey: "remote:ra1", value: undefined });

    const back = nextModelOnTargetChange(
      toRemote.nextKey,
      { scope: "local", agentId: "agent-x" },
      agents,
    );
    expect(back).toEqual({
      nextKey: "local:agent-x",
      value: "model-deepseek-v4-pro",
    });
  });

  it("切到 null：nextKey=none，value=undefined", () => {
    expect(nextModelOnTargetChange("local:agent-x", null, agents)).toEqual({
      nextKey: "none",
      value: undefined,
    });
  });

  it("切新 agent 但 agents 尚未加载：暂不算已联动，nextKey 原样透传等重试", () => {
    expect(
      nextModelOnTargetChange(
        null,
        { scope: "local", agentId: "agent-x" },
        undefined,
      ),
    ).toEqual({ nextKey: null, value: undefined });
  });
});
