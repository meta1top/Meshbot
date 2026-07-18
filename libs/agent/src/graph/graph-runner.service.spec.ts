import { AIMessageChunk } from "@langchain/core/messages";
import { describe, expect, it, vi } from "vitest";
import type { AccountGraphProvider } from "./account-graph.provider";
import type { ContextBuilder } from "./context-builder";
import { GraphRunner } from "./graph-runner.service";
import type { StreamChunk } from "./graph.types";
import type { ModelResolver } from "./model-resolver.service";
import type { ThreadStateService } from "./thread-state.service";

/**
 * 造一个受控的 `graph.stream()` 返回值：按传入的 `[mode, payload]` 顺序吐。
 * 真实 langgraph 的多 mode 流就是这个形状（见 GraphRunner.runGraphStream）。
 */
function fakeStream(parts: [string, unknown][]) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const p of parts) yield p;
    },
  };
}

/** 装配一个只够跑 `runGraphStream` 的 GraphRunner（其余依赖不会被这条路径触达）。 */
function makeRunner(parts: [string, unknown][]) {
  const graph = { stream: vi.fn().mockResolvedValue(fakeStream(parts)) };
  const accountGraphProvider = {
    accountGraph: () => ({ graph }),
    subAgentGraph: () => ({ graph }),
    // 模型 UUID → 我方雪花：测试里恒等映射即可，只需保证同 UUID 同 sid。
    resolveMessageId: (id: string) => `sid-${id}`,
    deleteMsgIds: vi.fn(),
  } as unknown as AccountGraphProvider;
  const modelResolver = {
    getMeta: () => ({
      providerType: "openai",
      model: "gpt-x",
      modelName: "GPT-X",
    }),
  } as unknown as ModelResolver;
  return new GraphRunner(
    accountGraphProvider,
    modelResolver,
    {} as ContextBuilder,
    {} as ThreadStateService,
  );
}

async function collect(runner: GraphRunner): Promise<StreamChunk[]> {
  const out: StreamChunk[] = [];
  // runGraphStream 是私有方法：这里直接驱动它，避免拉起 contextBuilder /
  // threadState 等与本用例无关的依赖。
  const gen = (
    runner as unknown as {
      runGraphStream: (
        threadId: string,
        input: { messages: [] },
      ) => AsyncGenerator<StreamChunk>;
    }
  ).runGraphStream("t1", { messages: [] });
  for await (const c of gen) out.push(c);
  return out;
}

describe("GraphRunner.runGraphStream 空轮短路", () => {
  it("supervisor 出口 flush 之后的尾随空 chunk 不再产生第二条 assistant_done", async () => {
    const runner = makeRunner([
      // 正常一轮：正文流式产出
      [
        "messages",
        [
          new AIMessageChunk({ id: "m1", content: "你好" }),
          { thread_id: "t1" },
        ],
      ],
      // supervisor 节点 return → 提前 flush 这一轮
      ["updates", { supervisor: {} }],
      // langgraph 尾随的「只带 finish_reason/usage」的空 chunk：
      // 会被当成新一轮重新累积，收尾 flush 时若不短路就是一条全空 assistant
      [
        "messages",
        [
          new AIMessageChunk({
            id: "m1",
            content: "",
            response_metadata: { finish_reason: "stop" },
            usage_metadata: {
              input_tokens: 10,
              output_tokens: 3,
              total_tokens: 13,
            },
          }),
          { thread_id: "t1" },
        ],
      ],
    ]);

    const chunks = await collect(runner);
    const dones = chunks.filter((c) => c.kind === "assistant_done");
    expect(dones).toHaveLength(1);
    expect(dones[0]).toMatchObject({ messageId: "sid-m1", content: "你好" });
    // 空轮虽然不发 assistant_done，但仍要放行 usage —— usage_metadata 恰恰挂在
    // 这条尾随 chunk 上，一并挡掉会丢整轮 token 计量。
    const usages = chunks.filter((c) => c.kind === "usage");
    expect(usages).toHaveLength(1);
    expect(usages[0]).toMatchObject({ messageId: "sid-m1", totalTokens: 13 });
  });

  it("只有 tool_calls、正文为空的决策轮仍然发 assistant_done", async () => {
    const runner = makeRunner([
      [
        "messages",
        [
          new AIMessageChunk({
            id: "m2",
            content: "",
            tool_call_chunks: [
              { index: 0, id: "call-1", name: "read_file", args: '{"p":1}' },
            ],
          }),
          { thread_id: "t1" },
        ],
      ],
    ]);

    const chunks = await collect(runner);
    const dones = chunks.filter((c) => c.kind === "assistant_done");
    expect(dones).toHaveLength(1);
    expect(dones[0]).toMatchObject({ messageId: "sid-m2", content: "" });
    expect(
      (dones[0] as { toolCalls: unknown[] | null }).toolCalls,
    ).toHaveLength(1);
  });

  it("只有 reasoning、正文为空的一轮仍然发 assistant_done", async () => {
    const runner = makeRunner([
      [
        "messages",
        [
          new AIMessageChunk({
            id: "m3",
            content: "",
            additional_kwargs: { reasoning_content: "想一想" },
          }),
          { thread_id: "t1" },
        ],
      ],
    ]);

    const chunks = await collect(runner);
    const dones = chunks.filter((c) => c.kind === "assistant_done");
    expect(dones).toHaveLength(1);
    expect(dones[0]).toMatchObject({ reasoning: "想一想" });
  });
});
