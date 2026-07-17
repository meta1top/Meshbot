import {
  nextModelOnTargetChange,
  resolveModelConfigForTarget,
  targetKey,
} from "./resolve-model-config-for-target";

const agents = [
  { id: "agent-x", defaultModelConfigId: "model-deepseek-v4-pro" },
  { id: "agent-y", defaultModelConfigId: null },
];

describe("resolveModelConfigForTarget", () => {
  it("选中 Agent 且列表已加载：返回该 Agent 的 defaultModelConfigId", () => {
    expect(
      resolveModelConfigForTarget({ kind: "agent", id: "agent-x" }, agents),
    ).toBe("model-deepseek-v4-pro");
  });

  it("Agent 的 defaultModelConfigId 为 null（跟随账号默认）：原样返回 null 而非 undefined", () => {
    // null 和 undefined 语义不同：null 交给调用方当「账号默认」写入
    // modelConfigId；undefined 是「不要动」，两者绝不能混淆。
    expect(
      resolveModelConfigForTarget({ kind: "agent", id: "agent-y" }, agents),
    ).toBeNull();
  });

  it("target 是设备（非 agent）：返回 undefined，不触碰模型选择器", () => {
    expect(
      resolveModelConfigForTarget({ kind: "device", id: "dev-1" }, agents),
    ).toBeUndefined();
  });

  it("target 为 null（未显式选择）：返回 undefined", () => {
    expect(resolveModelConfigForTarget(null, agents)).toBeUndefined();
  });

  it("agents 尚未加载（undefined，react-query loading）：返回 undefined，不误清空已选模型", () => {
    expect(
      resolveModelConfigForTarget({ kind: "agent", id: "agent-x" }, undefined),
    ).toBeUndefined();
  });

  it("agents 已加载但命中不到该 id（已被删除/竞态）：返回 undefined", () => {
    expect(
      resolveModelConfigForTarget({ kind: "agent", id: "agent-z" }, agents),
    ).toBeUndefined();
  });
});

describe("targetKey", () => {
  it("agent 目标：kind:id", () => {
    expect(targetKey({ kind: "agent", id: "agent-x" })).toBe("agent:agent-x");
  });

  it("设备目标：kind:id", () => {
    expect(targetKey({ kind: "device", id: "dev-1" })).toBe("device:dev-1");
  });

  it("未选择目标：固定 none", () => {
    expect(targetKey(null)).toBe("none");
  });
});

describe("nextModelOnTargetChange（原 bug #8 残留：agents 内容变化不应覆盖用户手选）", () => {
  it("target 身份没变（agents 引用变化触发重跑）：不联动，nextKey 原样透传", () => {
    const result = nextModelOnTargetChange(
      "agent:agent-x",
      { kind: "agent", id: "agent-x" },
      [...agents], // 内容相同但引用不同，模拟别处改了别的 Agent 导致数组重建
    );
    expect(result).toEqual({ nextKey: "agent:agent-x", value: undefined });
  });

  it("首次选中 agent（prevKey=null）：联动成该 Agent 的默认模型", () => {
    const result = nextModelOnTargetChange(
      null,
      { kind: "agent", id: "agent-x" },
      agents,
    );
    expect(result).toEqual({
      nextKey: "agent:agent-x",
      value: "model-deepseek-v4-pro",
    });
  });

  it("真的切了 agent（agent-x -> agent-y）：重新联动，defaultModelConfigId=null 原样写入", () => {
    const result = nextModelOnTargetChange(
      "agent:agent-x",
      { kind: "agent", id: "agent-y" },
      agents,
    );
    expect(result).toEqual({ nextKey: "agent:agent-y", value: null });
  });

  it("切到设备目标：没有默认模型可联动，但 nextKey 仍要更新，避免切回同一 agent 时被误判成没变", () => {
    const afterSwitchToDevice = nextModelOnTargetChange(
      "agent:agent-x",
      { kind: "device", id: "dev-1" },
      agents,
    );
    expect(afterSwitchToDevice).toEqual({
      nextKey: "device:dev-1",
      value: undefined,
    });

    // 再切回 agent-x：因为上一步已经更新了 nextKey，这里必须重新触发联动。
    const backToSameAgent = nextModelOnTargetChange(
      afterSwitchToDevice.nextKey,
      { kind: "agent", id: "agent-x" },
      agents,
    );
    expect(backToSameAgent).toEqual({
      nextKey: "agent:agent-x",
      value: "model-deepseek-v4-pro",
    });
  });

  it("切到未选择目标（null）：同样要更新 nextKey", () => {
    const result = nextModelOnTargetChange("agent:agent-x", null, agents);
    expect(result).toEqual({ nextKey: "none", value: undefined });
  });

  it("切到新 agent 但 agents 尚未加载（undefined）：暂不算已联动，nextKey 原样透传等重试", () => {
    const result = nextModelOnTargetChange(
      null,
      { kind: "agent", id: "agent-x" },
      undefined,
    );
    expect(result).toEqual({ nextKey: null, value: undefined });
  });

  it("agents 未加载场景：下一次 agents 到位后重试，成功联动", () => {
    const pending = nextModelOnTargetChange(
      null,
      { kind: "agent", id: "agent-x" },
      undefined,
    );
    const retried = nextModelOnTargetChange(
      pending.nextKey,
      { kind: "agent", id: "agent-x" },
      agents,
    );
    expect(retried).toEqual({
      nextKey: "agent:agent-x",
      value: "model-deepseek-v4-pro",
    });
  });
});
