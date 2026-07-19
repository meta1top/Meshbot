import { computeAgentNodeExpansion } from "./agent-node-expansion";

describe("computeAgentNodeExpansion", () => {
  it("在线且期望展开 → 展开且有子节点，无占位 chevron", () => {
    expect(computeAgentNodeExpansion(true, true)).toEqual({
      defaultOpen: true,
      hasChildren: true,
      chevronPlaceholder: false,
    });
  });

  it("在线但不期望展开 → 不展开但仍有子节点（可手动点开），无占位 chevron", () => {
    expect(computeAgentNodeExpansion(true, false)).toEqual({
      defaultOpen: false,
      hasChildren: true,
      chevronPlaceholder: false,
    });
  });

  it("离线即使期望展开（如 URL 直达该 Agent）→ 强制不展开、无子节点、有占位 chevron", () => {
    expect(computeAgentNodeExpansion(false, true)).toEqual({
      defaultOpen: false,
      hasChildren: false,
      chevronPlaceholder: true,
    });
  });

  it("离线且不期望展开 → 不展开、无子节点、有占位 chevron（左缘仍要对齐）", () => {
    expect(computeAgentNodeExpansion(false, false)).toEqual({
      defaultOpen: false,
      hasChildren: false,
      chevronPlaceholder: true,
    });
  });
});
