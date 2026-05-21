import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { AIMessage, HumanMessage } from "@langchain/core/messages";
import { describe, expect, it, vi } from "vitest";
import { createSupervisorNode } from "../../src/graph/nodes/supervisor.node";

describe("createSupervisorNode", () => {
  it("调用注入的 model 并把 AIMessage 追加到 state", async () => {
    const fakeModel = {
      invoke: vi.fn().mockResolvedValue(new AIMessage("你好")),
    };
    const node = createSupervisorNode(() =>
      Promise.resolve(fakeModel as unknown as BaseChatModel),
    );
    const result = await node({ messages: [new HumanMessage("hi")] });
    expect(fakeModel.invoke).toHaveBeenCalledTimes(1);
    expect(result.messages).toHaveLength(1);
    expect((result.messages[0] as AIMessage).content).toBe("你好");
    expect(fakeModel.invoke).toHaveBeenCalledWith([
      expect.objectContaining({ content: "hi" }),
    ]);
  });

  it("把完整消息历史传给 model", async () => {
    const fakeModel = {
      invoke: vi.fn().mockResolvedValue(new AIMessage("ok")),
    };
    const node = createSupervisorNode(() =>
      Promise.resolve(fakeModel as unknown as BaseChatModel),
    );
    const messages = [
      new HumanMessage("a"),
      new AIMessage("b"),
      new HumanMessage("c"),
    ];
    await node({ messages });
    expect(fakeModel.invoke).toHaveBeenCalledWith([
      expect.objectContaining({ content: "a" }),
      expect.objectContaining({ content: "b" }),
      expect.objectContaining({ content: "c" }),
    ]);
  });
});
