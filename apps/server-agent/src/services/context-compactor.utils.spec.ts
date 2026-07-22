import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import {
  estimateTokens,
  expandToToolBoundary,
  findSplitIndex,
  isContextLengthError,
  serializeForSummary,
} from "./context-compactor.utils";

describe("estimateTokens", () => {
  it("string content：长度 / 4 向上取整", () => {
    const m = new HumanMessage({ id: "h", content: "1234567890" }); // 10 chars
    expect(estimateTokens(m)).toBe(3); // ceil(10/4) = 3
  });

  it("tool_calls 序列化长度参与计算", () => {
    const ai = new AIMessage({
      id: "a",
      content: "",
      tool_calls: [{ id: "t1", name: "bash", args: { cmd: "ls" } }],
    });
    expect(estimateTokens(ai)).toBeGreaterThan(5);
  });

  it("complex content 数组用 JSON.stringify 估", () => {
    const m = new HumanMessage({
      id: "h",
      content: [{ type: "text", text: "hello" }] as never,
    });
    expect(estimateTokens(m)).toBeGreaterThan(0);
  });
});

describe("findSplitIndex", () => {
  it("全部都在预算内 → 0（保留全部）", () => {
    const msgs = [
      new HumanMessage({ id: "1", content: "hi" }),
      new AIMessage({ id: "2", content: "hello" }),
    ];
    expect(findSplitIndex(msgs, 10_000)).toBe(0);
  });

  it("普通切分：从尾部累加直到超预算", () => {
    const msgs = [
      new HumanMessage({ id: "1", content: "a".repeat(40) }), // ~10 token
      new HumanMessage({ id: "2", content: "b".repeat(40) }),
      new HumanMessage({ id: "3", content: "c".repeat(40) }),
    ];
    // budget=15 token：尾部累到 #2（10+10=20 > 15）→ split=2
    expect(findSplitIndex(msgs, 15)).toBe(2);
  });

  it("单条已超预算 → split 落在该条之后（保留它）", () => {
    const msgs = [
      new HumanMessage({ id: "1", content: "a".repeat(40) }),
      new HumanMessage({ id: "2", content: "b".repeat(100) }), // ~25 token
    ];
    expect(findSplitIndex(msgs, 10)).toBe(1);
  });
});

describe("expandToToolBoundary", () => {
  function ai(id: string, calls: { id: string; name: string }[]) {
    return new AIMessage({
      id,
      content: "",
      tool_calls: calls.map((c) => ({ ...c, args: {} })),
    });
  }
  function tool(id: string, callId: string) {
    return new ToolMessage({ id, tool_call_id: callId, content: "result" });
  }

  it("split 干净（无跨界 tool 对）时不动", () => {
    const msgs = [
      ai("a1", [{ id: "t1", name: "x" }]),
      tool("tr1", "t1"),
      new HumanMessage({ id: "h1", content: "next" }),
    ];
    expect(expandToToolBoundary(msgs, 2)).toBe(2);
  });

  it("split 跨开 tool pair：把整对划入 summarize 区", () => {
    const msgs = [ai("a1", [{ id: "t1", name: "x" }]), tool("tr1", "t1")];
    // split=1：keep 区是 ToolMessage 但 owner AIMessage 在 summarize 区
    // → 应扩到 2（整对都进 summarize 区）
    expect(expandToToolBoundary(msgs, 1)).toBe(2);
  });

  it("多 tool_calls 一组：全组进 summarize 区", () => {
    const msgs = [
      ai("a1", [
        { id: "t1", name: "x" },
        { id: "t2", name: "y" },
      ]),
      tool("tr1", "t1"),
      tool("tr2", "t2"),
    ];
    expect(expandToToolBoundary(msgs, 1)).toBe(3);
  });
});

describe("serializeForSummary", () => {
  it("普通消息按 role 前缀拼接", () => {
    const out = serializeForSummary([
      new HumanMessage({ id: "h", content: "hi" }),
      new AIMessage({ id: "a", content: "hello" }),
    ]);
    expect(out).toMatch(/\[user\] hi/);
    expect(out).toMatch(/\[assistant\] hello/);
  });

  it("tool result 长内容截断到 500 字 + [truncated N chars]", () => {
    const longResult = "X".repeat(2000);
    const out = serializeForSummary([
      new ToolMessage({ id: "tr1", tool_call_id: "t1", content: longResult }),
    ]);
    expect(out).toContain("[truncated");
    expect(out.length).toBeLessThan(1000);
  });

  it("tool_calls assistant 输出包含 tool 名 + args", () => {
    const ai = new AIMessage({
      id: "a",
      content: "",
      tool_calls: [{ id: "t1", name: "bash", args: { cmd: "ls -la" } }],
    });
    const out = serializeForSummary([ai]);
    expect(out).toContain("bash");
    expect(out).toMatch(/ls -la|\\"cmd\\"/);
  });
});

describe("isContextLengthError", () => {
  it("OpenAI / DeepSeek 风格 error.code", () => {
    expect(
      isContextLengthError({
        error: { code: "context_length_exceeded" },
      } as never),
    ).toBe(true);
  });

  it("HTTP 400 + message 含 context 字样", () => {
    expect(
      isContextLengthError({
        status: 400,
        message: "context too long",
      } as never),
    ).toBe(true);
  });

  it("Anthropic 风格：prompt is too long", () => {
    expect(
      isContextLengthError({
        error: { type: "invalid_request_error" },
        message: "prompt is too long: 250000 tokens > 200000 maximum",
      } as never),
    ).toBe(true);
  });

  it("Gemini 风格：exceeds the maximum", () => {
    expect(
      isContextLengthError({ message: "input exceeds the maximum" } as never),
    ).toBe(true);
  });

  it("不相关错误返 false", () => {
    expect(isContextLengthError(new Error("network failure"))).toBe(false);
    expect(isContextLengthError({ status: 500 } as never)).toBe(false);
  });
});
