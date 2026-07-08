import {
  AIMessage,
  HumanMessage,
  SystemMessage,
} from "@langchain/core/messages";
import {
  toLangchainMessages,
  toModelParams,
  toOpenAIChunk,
  toOpenAICompletion,
} from "./openai-adapter";

describe("openai-adapter", () => {
  it("system+user 转 langchain 消息", () => {
    const msgs = toLangchainMessages({
      model: "m1",
      messages: [
        { role: "system", content: "you are helpful" },
        { role: "user", content: "hi" },
      ],
    });
    expect(msgs[0]).toBeInstanceOf(SystemMessage);
    expect(msgs[1]).toBeInstanceOf(HumanMessage);
    expect(msgs[1].content).toBe("hi");
  });

  it("AIMessage 转 OpenAI completion 外壳", () => {
    const out = toOpenAICompletion(
      new AIMessage("hello"),
      "m1",
      "cmpl-1",
    ) as any;
    expect(out.object).toBe("chat.completion");
    expect(out.model).toBe("m1");
    expect(out.choices[0].message.role).toBe("assistant");
    expect(out.choices[0].message.content).toBe("hello");
  });

  it("chunk 转 OpenAI 流帧外壳", () => {
    const c = toOpenAIChunk({ content: "he" }, "m1", "cmpl-1") as any;
    expect(c.object).toBe("chat.completion.chunk");
    expect(c.choices[0].delta.content).toBe("he");
  });

  describe("toModelParams", () => {
    it("提取 temperature/max_tokens 为顶层 temperature/maxTokens", () => {
      expect(
        toModelParams({
          model: "m1",
          messages: [],
          temperature: 0.7,
          max_tokens: 256,
        }),
      ).toEqual({ temperature: 0.7, maxTokens: 256 });
    });

    it("未传 temperature/max_tokens → 返回空对象", () => {
      expect(toModelParams({ model: "m1", messages: [] })).toEqual({});
    });

    it("tools 不出现在结果里（走 bindTools，而非顶层参数）", () => {
      const out = toModelParams({
        model: "m1",
        messages: [],
        tools: [{ type: "function", function: { name: "foo" } }],
        temperature: 0.2,
      });
      expect(out).toEqual({ temperature: 0.2 });
      expect(out).not.toHaveProperty("tools");
    });
  });
});
