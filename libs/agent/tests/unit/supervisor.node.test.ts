import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { AIMessageChunk, HumanMessage } from "@langchain/core/messages";
import { describe, expect, it, vi } from "vitest";
import { createSupervisorNode } from "../../src/graph/nodes/supervisor.node";

/** 构造只暴露 stream() 的 fake model：逐段 yield AIMessageChunk。 */
function fakeStreamingModel(chunks: string[]) {
  return {
    stream: vi.fn(async () => {
      async function* gen() {
        for (const c of chunks) {
          yield new AIMessageChunk({ content: c });
        }
      }
      return gen();
    }),
  } as unknown as BaseChatModel;
}

/** 无 tool 的空 toolsProvider 桩，用于不需要测试 tool binding 的用例。 */
const noTools = () => [];

describe("createSupervisorNode", () => {
  it("调用注入的 model.stream 并把累加后的 AIMessage 追加到 state", async () => {
    const model = fakeStreamingModel(["你", "好"]);
    const node = createSupervisorNode(() => Promise.resolve(model), noTools);
    const result = await node({ messages: [new HumanMessage("hi")] });
    expect(model.stream).toHaveBeenCalledTimes(1);
    expect(result.messages).toHaveLength(1);
    expect(result.messages?.[0].content).toBe("你好");
    expect(model.stream).toHaveBeenCalledWith([
      expect.objectContaining({ content: "hi" }),
    ]);
  });

  it("把完整消息历史传给 model.stream", async () => {
    const model = fakeStreamingModel(["ok"]);
    const node = createSupervisorNode(() => Promise.resolve(model), noTools);
    const messages = [
      new HumanMessage("a"),
      new HumanMessage("b"),
      new HumanMessage("c"),
    ];
    await node({ messages });
    expect(model.stream).toHaveBeenCalledWith([
      expect.objectContaining({ content: "a" }),
      expect.objectContaining({ content: "b" }),
      expect.objectContaining({ content: "c" }),
    ]);
  });

  it("modelProvider 返回空时抛错", async () => {
    const node = createSupervisorNode(
      () => Promise.resolve(null as unknown as BaseChatModel),
      noTools,
    );
    await expect(node({ messages: [new HumanMessage("hi")] })).rejects.toThrow(
      "modelProvider 返回空",
    );
  });

  it("LLM 流未产出任何 chunk 时抛错", async () => {
    const model = fakeStreamingModel([]);
    const node = createSupervisorNode(() => Promise.resolve(model), noTools);
    await expect(node({ messages: [new HumanMessage("hi")] })).rejects.toThrow(
      "未产出任何内容",
    );
  });
});
