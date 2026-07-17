import { resolveModelConfigForTarget } from "./resolve-model-config-for-target";

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
