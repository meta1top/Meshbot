import { AIMessageChunk } from "@langchain/core/messages";
import { describe, expect, it } from "vitest";
import { createSupervisorNode } from "./supervisor.node";

function fakeModel(chunks: AIMessageChunk[]) {
  return {
    bindTools() {
      return this;
    },
    async stream() {
      return (async function* () {
        for (const c of chunks) yield c;
      })();
    },
  } as unknown as Awaited<
    ReturnType<import("./supervisor.node").ModelProvider>
  >;
}

describe("createSupervisorNode", () => {
  it("把累加 AIMessage 的 id 替换成 resolveMessageId 返回的雪花", async () => {
    const chunk = new AIMessageChunk({ content: "你好", id: "model-uuid-1" });
    const node = createSupervisorNode(
      async () => fakeModel([chunk]),
      () => [],
      (modelId) => (modelId === "model-uuid-1" ? "900000000000000001" : "x"),
    );
    const out = await node({ messages: [] });
    expect(out.messages?.[0]?.id).toBe("900000000000000001");
  });
});
