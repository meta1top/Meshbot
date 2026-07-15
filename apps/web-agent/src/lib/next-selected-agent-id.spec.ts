import { nextSelectedAgentId } from "./next-selected-agent-id";

describe("nextSelectedAgentId", () => {
  // 故意让 remaining[0] 不等于 currentId（"c" 排第一，"a" 排第二）——
  // 避免测试用例因为「巧合排在第一位」而在有 bug 的实现下也碰巧通过。
  const remainingAfterDeletingB = [{ id: "c" }, { id: "a" }];

  it("删除的不是当前选中的 agent 时，当前选中保持不变", () => {
    // 场景：正在和 agent a 对话（current=a），删掉无关的 agent b。
    // 复现 Critical：修复前会被硬切到 remaining[0]（"c"），这里断言必须仍是 "a"。
    expect(nextSelectedAgentId("b", "a", remainingAfterDeletingB)).toBe("a");
  });

  it("删除的就是当前选中的 agent 时，切到剩余列表第一个", () => {
    expect(nextSelectedAgentId("a", "a", [{ id: "c" }])).toBe("c");
  });

  it("删除的就是当前选中的 agent 且剩余列表为空时，返回 null", () => {
    expect(nextSelectedAgentId("a", "a", [])).toBeNull();
  });

  it("currentId 为 null（无当前选中）时，删别的 agent 仍保持 null", () => {
    expect(nextSelectedAgentId("b", null, remainingAfterDeletingB)).toBeNull();
  });
});
