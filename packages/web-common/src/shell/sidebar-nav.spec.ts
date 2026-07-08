import { isNavNodeActive, type NavNode } from "./nav-model";

const tree: NavNode = {
  key: "device-1",
  label: "设备1",
  children: [
    { key: "s-1", label: "会话1" },
    { key: "s-2", label: "会话2" },
  ],
};

describe("isNavNodeActive", () => {
  it("自身 key 命中 → true", () => {
    expect(isNavNodeActive({ key: "a", label: "" }, "a")).toBe(true);
  });
  it("子孙 key 命中 → true（用于父节点高亮/展开）", () => {
    expect(isNavNodeActive(tree, "s-2")).toBe(true);
  });
  it("都不命中 → false", () => {
    expect(isNavNodeActive(tree, "s-9")).toBe(false);
  });
  it("activeKey 为空 → false", () => {
    expect(isNavNodeActive(tree, undefined)).toBe(false);
  });
  it("3 层嵌套 a>b>c，从根查 c → true（递归不退化）", () => {
    const deep: NavNode = {
      key: "a",
      label: "a",
      children: [
        { key: "b", label: "b", children: [{ key: "c", label: "c" }] },
      ],
    };
    expect(isNavNodeActive(deep, "c")).toBe(true);
  });
});
