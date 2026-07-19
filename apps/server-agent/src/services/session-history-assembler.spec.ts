import {
  type HistoryAssemblyRow,
  assembleHistoryMessages,
} from "./session-history-assembler";

/** 造一条 assistant 行（带 langchain 原始形态 tool_calls）。 */
function assistantRow(
  calls: Array<{ id: string; name: string; args: unknown }>,
  over: Partial<HistoryAssemblyRow> = {},
): HistoryAssemblyRow {
  return {
    id: "a1",
    role: "assistant",
    content: "",
    toolCalls: JSON.stringify(calls),
    ...over,
  };
}

/** 造一条 role="tool" 结果行。 */
function toolRow(
  toolCallId: string,
  content: string,
  metadata?: string | null,
): HistoryAssemblyRow {
  return {
    id: `t-${toolCallId}`,
    role: "tool",
    content,
    toolCallId,
    metadata: metadata ?? null,
  };
}

describe("assembleHistoryMessages —— 工具调用状态三态", () => {
  it("无对应 tool 行 → running（工具仍在执行 / 结果未落库）", () => {
    const { messages } = assembleHistoryMessages({
      rows: [assistantRow([{ id: "tc1", name: "bash", args: { cmd: "ls" } }])],
      hasMore: false,
    });
    expect(messages[0]?.toolCalls?.[0]?.status).toBe("running");
    expect(messages[0]?.toolCalls?.[0]?.result).toBe("");
  });

  it("tool 行 metadata.ok===false → error（远程曾硬编码成 ok，失败工具显示成成功）", () => {
    const { messages } = assembleHistoryMessages({
      rows: [
        assistantRow([{ id: "tc1", name: "bash", args: {} }]),
        toolRow("tc1", "command not found", JSON.stringify({ ok: false })),
      ],
      hasMore: false,
    });
    expect(messages[0]?.toolCalls?.[0]?.status).toBe("error");
    expect(messages[0]?.toolCalls?.[0]?.result).toBe("command not found");
  });

  it("正常 tool 行 → ok 且 result 取到 tool 行的 content", () => {
    const { messages } = assembleHistoryMessages({
      rows: [
        assistantRow([{ id: "tc1", name: "bash", args: {} }]),
        toolRow("tc1", "file-a\nfile-b", JSON.stringify({ ok: true })),
      ],
      hasMore: false,
    });
    expect(messages[0]?.toolCalls?.[0]?.status).toBe("ok");
    // result 恒空是远程旧路径的第二个症状：工具卡展开后「响应」区永远空的。
    expect(messages[0]?.toolCalls?.[0]?.result).toBe("file-a\nfile-b");
  });

  it("args / name 原样带出（前端 todo_write 等卡片分支靠 args 渲染）", () => {
    const todos = [{ content: "写测试", status: "pending" }];
    const { messages } = assembleHistoryMessages({
      rows: [
        assistantRow([{ id: "tc1", name: "todo_write", args: { todos } }]),
      ],
      hasMore: false,
    });
    expect(messages[0]?.toolCalls?.[0]?.name).toBe("todo_write");
    expect(messages[0]?.toolCalls?.[0]?.args).toEqual({ todos });
  });
});

describe("assembleHistoryMessages —— tool 行过滤与分页", () => {
  it('role="tool" 行被过滤掉（它是结果落库行，不是可展示消息）', () => {
    const { messages } = assembleHistoryMessages({
      rows: [
        { id: "u1", role: "user", content: "跑一下" },
        assistantRow([{ id: "tc1", name: "bash", args: {} }]),
        toolRow("tc1", "done", JSON.stringify({ ok: true })),
      ],
      hasMore: false,
    });
    expect(messages.map((m) => m.id)).toEqual(["u1", "a1"]);
    expect(messages.some((m) => (m.role as string) === "tool")).toBe(false);
  });

  it("hasMore 原样透传：可见消息条数远少于 limit 也不得被反推成 false", () => {
    // 3 条原始行里 2 条是 tool 结果行 → 可见消息只有 1 条，但更早的历史仍在。
    const { messages, hasMore } = assembleHistoryMessages({
      rows: [
        assistantRow([
          { id: "tc1", name: "bash", args: {} },
          { id: "tc2", name: "read", args: {} },
        ]),
        toolRow("tc1", "r1"),
        toolRow("tc2", "r2"),
      ],
      hasMore: true,
    });
    expect(messages).toHaveLength(1);
    expect(hasMore).toBe(true);
  });

  it("hasMore=false 同样原样透传", () => {
    const { hasMore } = assembleHistoryMessages({
      rows: [{ id: "u1", role: "user", content: "hi" }],
      hasMore: false,
    });
    expect(hasMore).toBe(false);
  });
});

describe("assembleHistoryMessages —— subSessionId / 其他字段", () => {
  it("dispatch 工具带出 subSessionId；其他工具不带（远程旧路径全丢）", () => {
    const { messages } = assembleHistoryMessages({
      rows: [
        assistantRow([
          { id: "tc-dispatch", name: "dispatch_subagent", args: {} },
          { id: "tc-bash", name: "bash", args: {} },
        ]),
      ],
      hasMore: false,
      childByToolCallId: new Map([["tc-dispatch", "sub-1"]]),
    });
    const tcs = messages[0]?.toolCalls ?? [];
    expect(tcs.find((t) => t.toolCallId === "tc-dispatch")?.subSessionId).toBe(
      "sub-1",
    );
    expect(
      tcs.find((t) => t.toolCallId === "tc-bash")?.subSessionId,
    ).toBeUndefined();
  });

  it("childByToolCallId 缺省时不抛错，只是不带 subSessionId", () => {
    const { messages } = assembleHistoryMessages({
      rows: [
        assistantRow([
          { id: "tc-dispatch", name: "dispatch_subagent", args: {} },
        ]),
      ],
      hasMore: false,
    });
    expect(messages[0]?.toolCalls?.[0]?.subSessionId).toBeUndefined();
  });

  it("feedback / reasoning / compaction metadata 正确投影", () => {
    const { messages } = assembleHistoryMessages({
      rows: [
        {
          id: "a1",
          role: "assistant",
          content: "答",
          reasoning: "想了想",
          metadata: JSON.stringify({ feedback: "up" }),
        },
        {
          id: "c1",
          role: "system",
          content: "",
          metadata: JSON.stringify({
            kind: "compaction",
            removedCount: 3,
            fromMessageId: "m1",
            toMessageId: "m2",
          }),
        },
      ],
      hasMore: false,
    });
    expect(messages[0]?.feedback).toBe("up");
    expect(messages[0]?.reasoning).toBe("想了想");
    expect(messages[0]?.metadata).toBeNull();
    expect(messages[1]?.metadata?.kind).toBe("compaction");
  });

  it("toolCalls JSON 解析失败 → 退化为无工具的普通消息，不整批抛错", () => {
    const { messages } = assembleHistoryMessages({
      rows: [
        { id: "a1", role: "assistant", content: "x", toolCalls: "{坏的 JSON" },
      ],
      hasMore: false,
    });
    expect(messages).toHaveLength(1);
    expect(messages[0]?.toolCalls).toBeUndefined();
  });
});
