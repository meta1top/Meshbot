import {
  AIMessage,
  AIMessageChunk,
  HumanMessage,
  SystemMessage,
} from "@langchain/core/messages";
import {
  extractReasoningDelta,
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

  describe("toLangchainMessages · assistant tool_calls（C-1 入站形状转换）", () => {
    it("OpenAI 线格式 tool_calls 转为 langchain 顶层 name/args（object，非字符串）", () => {
      const msgs = toLangchainMessages({
        model: "m1",
        messages: [
          { role: "user", content: "帮我查天气" },
          {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: { name: "foo", arguments: '{"a":1}' },
              },
            ],
          },
          { role: "tool", content: "sunny", tool_call_id: "call_1" },
        ],
      });
      const ai = msgs[1] as AIMessage;
      expect(ai).toBeInstanceOf(AIMessage);
      expect(ai.tool_calls).toHaveLength(1);
      expect(ai.tool_calls?.[0]).toMatchObject({
        id: "call_1",
        name: "foo",
        args: { a: 1 },
      });
    });
  });

  describe("toOpenAICompletion · tool_calls（I-1 出站形状转换）", () => {
    it("langchain shape tool_calls 转回 OpenAI shape（function.arguments 为 JSON 字符串）", () => {
      const ai = new AIMessage({
        content: "",
        tool_calls: [
          { id: "call_1", name: "foo", args: { a: 1 }, type: "tool_call" },
        ],
      });
      const out = toOpenAICompletion(ai, "m1", "cmpl-1") as any;
      expect(out.choices[0].message.tool_calls).toEqual([
        {
          id: "call_1",
          type: "function",
          function: { name: "foo", arguments: JSON.stringify({ a: 1 }) },
        },
      ]);
      expect(out.choices[0].finish_reason).toBe("tool_calls");
    });
  });

  describe("toOpenAICompletion · usage 映射（total_tokens 兜底）", () => {
    it("usage_metadata 无 total_tokens → total 由 input+output 兜底相加", () => {
      const ai = new AIMessage({
        content: "hi",
        // 刻意不传 total_tokens：验证 toOpenAIUsage 的 total_tokens ?? input+output 兜底分支
        usage_metadata: { input_tokens: 5, output_tokens: 3 } as any,
      });
      const out = toOpenAICompletion(ai, "m", "id") as any;
      expect(out.usage).toEqual({
        prompt_tokens: 5,
        completion_tokens: 3,
        total_tokens: 8,
      });
    });
  });

  describe("round trip：OpenAI → langchain → OpenAI（C-1 + I-1 无损）", () => {
    it("name/args/id 往返无损", () => {
      const openaiToolCalls = [
        {
          id: "call_9",
          type: "function",
          function: { name: "bar", arguments: '{"x":"y","n":2}' },
        },
      ];
      const msgs = toLangchainMessages({
        model: "m1",
        messages: [
          { role: "assistant", content: null, tool_calls: openaiToolCalls },
        ],
      });
      const ai = msgs[0] as AIMessage;
      const out = toOpenAICompletion(ai, "m1", "cmpl-2") as any;
      const roundTripped = out.choices[0].message.tool_calls[0];
      expect(roundTripped.id).toBe("call_9");
      expect(roundTripped.function.name).toBe("bar");
      expect(JSON.parse(roundTripped.function.arguments)).toEqual({
        x: "y",
        n: 2,
      });
    });
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
  describe("extractReasoningDelta", () => {
    it("contentBlocks 的 reasoning 优先（Anthropic 形态：仅 blocks 路）", () => {
      const chunk = new AIMessageChunk({
        content: [{ type: "reasoning", reasoning: "想一下" } as never],
      });
      expect(extractReasoningDelta(chunk)).toBe("想一下");
    });

    it("DeepSeek 双路只取 contentBlocks 一路，不重复", () => {
      // ChatDeepSeek 1.1.5 实测：additional_kwargs 与 contentBlocks 同时携带
      const chunk = new AIMessageChunk({
        content: [{ type: "reasoning", reasoning: "想" } as never],
        additional_kwargs: { reasoning_content: "想" },
      });
      expect(extractReasoningDelta(chunk)).toBe("想");
    });

    it("仅 additional_kwargs 路时兜底取用", () => {
      const chunk = new AIMessageChunk({
        content: "",
        additional_kwargs: { reasoning_content: "兜底思考" },
      });
      expect(extractReasoningDelta(chunk)).toBe("兜底思考");
    });

    it("无思考时返回空串", () => {
      expect(extractReasoningDelta(new AIMessageChunk({ content: "hi" }))).toBe(
        "",
      );
    });
  });
});
