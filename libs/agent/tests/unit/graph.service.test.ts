import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { AIMessageChunk } from "@langchain/core/messages";
import { ChatGenerationChunk } from "@langchain/core/outputs";
import { EventEmitter2 } from "@nestjs/event-emitter";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { MeshbotConfigService } from "../../src/config/meshbot-config.service";
import { GraphService } from "../../src/graph/graph.service";
import { AccountContextService } from "../../src/account/account-context.service";
import { PromptService } from "../../src/prompt/prompt.service";
import { ToolRegistry } from "../../src/tools/tool-registry";
import type { MeshbotTool } from "../../src/tools/tool.types";

describe("GraphService", () => {
  let testDir: string;
  let graphService: GraphService;

  beforeEach(() => {
    testDir = mkdtempSync(path.join(tmpdir(), "meshbot-graph-test-"));
    mkdirSync(path.join(testDir, "prompt"), { recursive: true });
    const configService = new MeshbotConfigService();
    (configService as unknown as Record<string, string>).meshbotDir = testDir;
    const promptService = new PromptService(testDir);
    // 注意：以下 fakeModel 是普通对象，不继承 BaseChatModel，stream() 不经过
    // LangChain 的 callback pipeline。配 streamMode:"messages" 单 mode 时凑合能用，
    // 但 streamMode:["messages","updates"] 多 mode 下不可靠（chunks 不进 messages 流）。
    // 想真测 streamMessage/resumeStream 流式行为，参考下面 TwoRoundModel 用
    // BaseChatModel + _streamResponseChunks 的写法。3 个 pre-existing 挂的用例
    // 是这个限制的后果，独立 issue 跟进。
    //
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
    const toolRegistry = new ToolRegistry(
      { getProviders: () => [] } as never,
      new AccountContextService(),
    );
    const eventEmitter = new EventEmitter2();
    graphService = new GraphService(
      configService,
      promptService,
      toolRegistry,
      eventEmitter,
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

  it("supervisor 节点退出即 flushRound（assistant_done(A) 不等 tool 执行结束）", async () => {
    // 构造一个两轮 ReAct 模型：
    //   轮1 → tool_calls chunk（触发 tools 节点）
    //   轮2 → content chunk（final answer）
    // 时间探针：echoTool sleep 300ms 模拟慢 tool（MCP / 浏览器调用可能 30s+）。
    // 修复前：flush 等 ToolMessage 进 stream（tool resolve 之后）→ adA.t ≥ toolFinishedAt。
    // 修复后：supervisor update 触发立即 flush → adA.t < toolFinishedAt。
    let toolFinishedAt = 0;

    // 正确的 BaseChatModel 子类：_streamResponseChunks 走 LangGraph 回调管道，
    // chunk 才能出现在 streamMode:"messages" 中。
    class TwoRoundModel extends (
      await import("@langchain/core/language_models/chat_models")
    ).BaseChatModel {
      private callCount = 0;
      _llmType() {
        return "two-round-fake";
      }
      async _generate() {
        // 不用 _generate；streaming 走 _streamResponseChunks
        throw new Error("不应走 _generate");
      }
      async *_streamResponseChunks(
        _msgs: unknown,
        _opts: unknown,
        runManager:
          | {
              handleLLMNewToken: (
                t: string,
                i: unknown,
                id: unknown,
                p: unknown,
                tags: unknown,
                fields: unknown,
              ) => Promise<void>;
            }
          | undefined,
      ): AsyncGenerator<ChatGenerationChunk> {
        this.callCount += 1;
        if (this.callCount === 1) {
          // 轮1：tool_calls，无 content
          const chunk = new ChatGenerationChunk({
            message: new AIMessageChunk({
              id: "msg-A",
              content: "",
              tool_calls: [{ id: "tc-A", name: "echo", args: { x: "hi" } }],
            }),
            text: "",
          });
          yield chunk;
          await runManager?.handleLLMNewToken(
            "",
            undefined,
            undefined,
            undefined,
            undefined,
            { chunk },
          );
        } else {
          // 轮2：直接回复（无延迟）
          const chunk = new ChatGenerationChunk({
            message: new AIMessageChunk({ id: "msg-B", content: "好" }),
            text: "好",
          });
          yield chunk;
          await runManager?.handleLLMNewToken(
            "好",
            undefined,
            undefined,
            undefined,
            undefined,
            { chunk },
          );
        }
      }
    }

    const echoTool: MeshbotTool<{ x: string }, string> = {
      name: "echo",
      description: "echo back",
      schema: z.object({ x: z.string() }),
      async execute(args) {
        // 模拟慢 tool（真实场景 MCP / 浏览器调用可能 30s+）
        // 500ms gives ≥495ms margin between flushRound (which fires within ~5ms of supervisor exit) and toolFinishedAt — safe against CI flake.
        await new Promise((r) => setTimeout(r, 500));
        toolFinishedAt = Date.now();
        return `echoed: ${args.x}`;
      },
    };
    const fakeDisc = {
      getProviders: () => [{ instance: echoTool }] as never,
    };
    const toolRegistry2 = new ToolRegistry(
      fakeDisc as never,
      new AccountContextService(),
    );
    toolRegistry2.onModuleInit();
    // echoTool 是纯对象（无 @Tool() 装饰器），onModuleInit 扫不到，需手动注册
    toolRegistry2.register(echoTool);
    const cfg2 = new MeshbotConfigService();
    (cfg2 as unknown as Record<string, string>).meshbotDir = testDir;
    const model2 = new TwoRoundModel({});
    const gs = new GraphService(
      cfg2,
      new PromptService(testDir),
      toolRegistry2,
      new EventEmitter2(),
      () => Promise.resolve(model2 as BaseChatModel),
      { providerType: "fake", model: "fake-model" },
    );
    const threadId = await gs.startSession({ model: "fake" });
    const events: Array<{ kind: string; messageId: string; t: number }> = [];
    for await (const ev of gs.streamMessage(threadId, [
      { id: "pm-1", content: "hi" },
    ])) {
      events.push({
        kind: ev.kind,
        messageId: (ev as { messageId?: string }).messageId ?? "",
        t: Date.now(),
      });
    }
    const adA = events.find(
      (e) => e.kind === "assistant_done" && e.messageId === "msg-A",
    );
    expect(adA).toBeTruthy();
    expect(toolFinishedAt).toBeGreaterThan(0);
    // 关键断言：assistant_done(A) 必须在 tool 完成之前 yield
    // 修复前（仅 ToolMessage 触发）：flush 等 ToolMessage 进 stream（tool resolve 之后）→ adA.t ≥ toolFinishedAt
    // 修复后（supervisor update 触发）：assistant_done 立即 yield，远早于 tool 完成 → adA.t < toolFinishedAt
    expect(adA?.t).toBeLessThan(toolFinishedAt);
  });
});
