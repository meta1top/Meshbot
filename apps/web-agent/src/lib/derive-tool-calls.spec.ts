import { deriveToolCalls } from "./derive-tool-calls";

describe("deriveToolCalls", () => {
  it("按消息顺序抽出所有 toolCalls,保留 toolName", () => {
    const msgs = [
      { toolCalls: [{ toolCallId: "a", toolName: "read_logs" }] },
      { toolCalls: undefined },
      {
        toolCalls: [
          { toolCallId: "b", toolName: "grep" },
          { toolCallId: "c", toolName: "read_logs" },
        ],
      },
    ];
    // biome-ignore lint/suspicious/noExplicitAny: 测试构造最小形状
    const out = deriveToolCalls(msgs as any);
    expect(out.map((t) => t.toolCallId)).toEqual(["a", "b", "c"]);
    expect(out.map((t) => t.toolName)).toEqual([
      "read_logs",
      "grep",
      "read_logs",
    ]);
  });
  it("空/无工具消息返回空数组", () => {
    expect(deriveToolCalls([])).toEqual([]);
    // biome-ignore lint/suspicious/noExplicitAny: 测试构造
    expect(deriveToolCalls([{ toolCalls: [] }] as any)).toEqual([]);
  });
});
