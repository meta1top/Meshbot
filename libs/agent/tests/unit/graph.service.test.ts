import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { AIMessageChunk } from "@langchain/core/messages";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MeshbotConfigService } from "../../src/config/meshbot-config.service";
import { GraphService } from "../../src/graph/graph.service";
import { PromptService } from "../../src/prompt/prompt.service";

describe("GraphService", () => {
  let testDir: string;
  let graphService: GraphService;

  beforeEach(() => {
    testDir = mkdtempSync(path.join(tmpdir(), "meshbot-graph-test-"));
    mkdirSync(path.join(testDir, "prompt"), { recursive: true });
    const configService = new MeshbotConfigService();
    (configService as unknown as Record<string, string>).meshbotDir = testDir;
    const promptService = new PromptService(testDir);
    // fakeModel 用 stream() 逐 token yield AIMessageChunk —— 与 supervisor 节点一致。
    // 每次 stream() 调用产出一个新 id（模拟真实 LLM 每轮回复有独立 id），
    // 单轮内各 chunk 共享同一 id，验证 streamMode:"messages" 管道连通 + messageId 稳定。
    let streamCall = 0;
    const fakeModel = {
      stream: async () => {
        streamCall += 1;
        const msgId = `fake-msg-${streamCall}`;
        async function* gen() {
          yield new AIMessageChunk({ id: msgId, content: "你" });
          yield new AIMessageChunk({
            id: msgId,
            content: "好",
            usage_metadata: {
              input_tokens: 10,
              output_tokens: 2,
              total_tokens: 12,
              input_token_details: { cache_read: 3, cache_creation: 0 },
              output_token_details: { reasoning: 0 },
            },
          });
        }
        return gen();
      },
    };
    graphService = new GraphService(
      configService,
      promptService,
      () => Promise.resolve(fakeModel as never),
      { providerType: "fake", model: "fake-model" },
    );
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("starts a session and returns thread id", async () => {
    const threadId = await graphService.startSession({ model: "gpt-4" });
    expect(typeof threadId).toBe("string");
    expect(threadId.length).toBeGreaterThan(0);
  });

  it("streamMessage 逐 chunk 产出 token 与稳定 messageId", async () => {
    const threadId = await graphService.startSession({ model: "fake" });
    const events: Array<
      | { kind: "chunk"; messageId: string; delta: string }
      | { kind: "usage"; messageId: string }
    > = [];
    for await (const ev of graphService.streamMessage(threadId, [
      { id: "pm-1", content: "hi" },
    ])) {
      events.push(ev);
    }
    const chunks = events.filter(
      (e): e is { kind: "chunk"; messageId: string; delta: string } =>
        e.kind === "chunk",
    );
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.every((c) => c.messageId === chunks[0].messageId)).toBe(true);
    expect(chunks.map((c) => c.delta).join("")).toBe("你好");
  });

  it("streamMessage 末尾 yield usage 事件含 token 明细", async () => {
    const threadId = await graphService.startSession({ model: "fake" });
    // biome-ignore lint/suspicious/noExplicitAny: 测试方便起见用 any 装载事件
    const events: any[] = [];
    for await (const ev of graphService.streamMessage(threadId, [
      { id: "pm-1", content: "hi" },
    ])) {
      events.push(ev);
    }
    const usage = events.find((e) => e.kind === "usage");
    expect(usage).toBeTruthy();
    const firstChunk = events.find((e) => e.kind === "chunk");
    expect(usage.messageId).toBe(firstChunk.messageId);
    expect(usage.inputTokens).toBe(10);
    expect(usage.outputTokens).toBe(2);
    expect(usage.totalTokens).toBe(12);
    expect(usage.cacheReadTokens).toBe(3);
    expect(usage.cacheCreationTokens).toBe(0);
    expect(usage.reasoningTokens).toBe(0);
    expect(usage.providerType).toBe("fake");
    expect(usage.model).toBe("fake-model");
    expect(typeof usage.durationMs).toBe("number");
    expect(usage.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("returns history after streamMessage", async () => {
    const threadId = await graphService.startSession({ model: "fake" });
    for await (const _ev of graphService.streamMessage(threadId, [
      { id: "pm-1", content: "hi" },
    ])) {
      // 仅消费流以驱动 checkpointer 落盘
    }
    const history = await graphService.getHistory(threadId);
    expect(Array.isArray(history)).toBe(true);
    expect(history.length).toBeGreaterThan(0);
  });

  it("streamMessage 用传入 id 构造 HumanMessage 并写入 checkpointer", async () => {
    const threadId = await graphService.startSession({ model: "fake" });
    for await (const _ of graphService.streamMessage(threadId, [
      { id: "pm-1", content: "hi" },
    ])) {
      // 消费完
    }
    const history = await graphService.getHistory(threadId);
    const userMsg = history.find((m) => m.role === "user");
    expect(userMsg?.id).toBe("pm-1");
  });

  it("resumeStream 不加新消息，从现有状态继续流式", async () => {
    const threadId = await graphService.startSession({ model: "fake" });
    for await (const _ of graphService.streamMessage(threadId, [
      { id: "pm-1", content: "hi" },
    ])) {
      // 先跑一轮建立历史
    }
    const before = await graphService.getHistory(threadId);
    const userCountBefore = before.filter((m) => m.role === "user").length;
    const chunks: unknown[] = [];
    for await (const ev of graphService.resumeStream(threadId)) {
      chunks.push(ev);
    }
    const after = await graphService.getHistory(threadId);
    const userCountAfter = after.filter((m) => m.role === "user").length;
    expect(userCountAfter).toBe(userCountBefore);
    expect(chunks.length).toBeGreaterThan(0);
  });
});
