import { HistoryToolCallSchema } from "./session";

describe("HistoryToolCallSchema.subSessionId", () => {
  const base = {
    toolCallId: "tc-1",
    name: "dispatch_subagent",
    args: { task: "调研" },
    status: "running",
    result: "",
  };

  it("无 subSessionId 可解析（向后兼容）", () => {
    const r = HistoryToolCallSchema.parse(base);
    expect(r.subSessionId).toBeUndefined();
  });

  it("带 subSessionId 解析并保留", () => {
    const r = HistoryToolCallSchema.parse({
      ...base,
      subSessionId: "901000000000000001",
    });
    expect(r.subSessionId).toBe("901000000000000001");
  });

  it("subSessionId 非字符串拒绝", () => {
    expect(() =>
      HistoryToolCallSchema.parse({ ...base, subSessionId: 123 }),
    ).toThrow();
  });
});
