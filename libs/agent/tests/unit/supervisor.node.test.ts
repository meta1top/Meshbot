import { AIMessage, HumanMessage } from "@langchain/core/messages";
import { describe, expect, it, vi } from "vitest";
import { createSupervisorNode } from "../../src/graph/nodes/supervisor.node";

describe("createSupervisorNode", () => {
  it("调用注入的 model 并把 AIMessage 追加到 state", async () => {
    const fakeModel = {
      invoke: vi.fn().mockResolvedValue(new AIMessage("你好")),
    };
    const node = createSupervisorNode(() =>
      Promise.resolve(fakeModel as never),
    );
    const result = await node({ messages: [new HumanMessage("hi")] });
    expect(fakeModel.invoke).toHaveBeenCalledTimes(1);
    expect(result.messages).toHaveLength(1);
    expect((result.messages[0] as AIMessage).content).toBe("你好");
  });
});
