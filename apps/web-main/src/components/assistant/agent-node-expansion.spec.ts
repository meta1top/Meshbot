import { computeAgentNodeExpansion } from "./agent-node-expansion";

describe("computeAgentNodeExpansion", () => {
  it("在线且期望展开 → 展开且有子节点", () => {
    expect(computeAgentNodeExpansion(true, true)).toEqual({
      defaultOpen: true,
      hasChildren: true,
    });
  });

  it("在线但不期望展开 → 不展开但仍有子节点（可手动点开）", () => {
    expect(computeAgentNodeExpansion(true, false)).toEqual({
      defaultOpen: false,
      hasChildren: true,
    });
  });

  it("离线即使期望展开（如 URL 直达该 Agent）→ 强制不展开、无子节点", () => {
    expect(computeAgentNodeExpansion(false, true)).toEqual({
      defaultOpen: false,
      hasChildren: false,
    });
  });

  it("离线且不期望展开 → 不展开、无子节点", () => {
    expect(computeAgentNodeExpansion(false, false)).toEqual({
      defaultOpen: false,
      hasChildren: false,
    });
  });
});
