import { resolveCurrentAgentId } from "./resolve-current-agent";

describe("resolveCurrentAgentId", () => {
  const agents = [{ id: "a1" }, { id: "a2" }];

  it("currentId 为 null 时选中列表第一个", () => {
    expect(resolveCurrentAgentId(agents, null)).toBe("a1");
  });

  it("currentId 指向已删除/不存在的 agent 时回退第一个", () => {
    expect(resolveCurrentAgentId(agents, "gone")).toBe("a1");
  });

  it("currentId 命中列表中的 agent 时保持不变", () => {
    expect(resolveCurrentAgentId(agents, "a2")).toBe("a2");
  });

  it("列表为空时返回 null", () => {
    expect(resolveCurrentAgentId([], "a1")).toBeNull();
    expect(resolveCurrentAgentId([], null)).toBeNull();
  });
});
