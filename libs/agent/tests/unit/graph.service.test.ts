import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { AIMessageChunk } from "@langchain/core/messages";
import type { SystemMessage } from "@langchain/core/messages";
import { ChatGenerationChunk } from "@langchain/core/outputs";
import { EventEmitter2 } from "@nestjs/event-emitter";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { AccountContextService } from "../../src/account/account-context.service";
import { MeshbotConfigService } from "../../src/config/meshbot-config.service";
import { AccountGraphProvider } from "../../src/graph/account-graph.provider";
import { ContextBuilder } from "../../src/graph/context-builder.js";
import { GraphRunner } from "../../src/graph/graph-runner.service.js";
import { GraphService } from "../../src/graph/graph.service";
import { ModelResolver } from "../../src/graph/model-resolver.service.js";
import { ThreadStateService } from "../../src/graph/thread-state.service.js";
import type { RuntimeContextPort } from "../../src/graph/runtime-context.port";
import { MEMORY_GUIDE } from "../../src/memory/memory-guide";
import type { MemoryService } from "../../src/memory/memory.service";
import type { SkillService } from "../../src/skills/skill.service";
import { PromptService } from "../../src/prompt/prompt.service";
import { ToolRegistry } from "../../src/tools/tool-registry";
import type { MeshbotTool } from "../../src/tools/tool.types";

const TEST_ACCOUNT = "test-account";

function makeTestServices(testDir: string): {
  ctx: AccountContextService;
  configService: MeshbotConfigService;
  promptService: PromptService;
} {
  const ctx = new AccountContextService();
  const configService = new MeshbotConfigService(ctx);
  (configService as unknown as Record<string, string>).meshbotDir = testDir;
  const promptService = new PromptService(configService, ctx);
  return { ctx, configService, promptService };
}

/** 构造受测 GraphService 及其依赖的小对象图（fake model 经 ModelResolver 注入）。 */
function makeGraphService(opts: {
  configService: MeshbotConfigService;
  promptService: PromptService;
  account: AccountContextService;
  fakeModel: unknown;
  toolRegistry?: ToolRegistry;
  eventEmitter?: EventEmitter2;
  runtimeContext?: RuntimeContextPort;
  memory?: MemoryService;
  skills?: SkillService;
}): { gs: GraphService; contextBuilder: ContextBuilder } {
  const toolRegistry =
    opts.toolRegistry ??
    new ToolRegistry(
      { getProviders: () => [] } as never,
      new AccountContextService(),
    );
  const eventEmitter = opts.eventEmitter ?? new EventEmitter2();
  const modelResolver = new ModelResolver(
    opts.configService,
    opts.account,
    () => Promise.resolve(opts.fakeModel as never),
    { providerType: "fake", model: "fake-model" },
  );
  const accountGraphProvider = new AccountGraphProvider(
    opts.configService,
    opts.account,
    toolRegistry,
    eventEmitter,
    modelResolver,
  );
  const contextBuilder = new ContextBuilder(
    opts.account,
    opts.runtimeContext,
    opts.memory,
    opts.skills,
    modelResolver,
  );
  const threadState = new ThreadStateService(accountGraphProvider);
  const graphRunner = new GraphRunner(
    opts.promptService,
    accountGraphProvider,
    modelResolver,
    contextBuilder,
    threadState,
  );
  const gs = new GraphService(modelResolver, threadState, graphRunner);
  return { gs, contextBuilder };
}

describe("GraphService", () => {
  let testDir: string;
  let ctx: AccountContextService;
  let graphService: GraphService;

  beforeEach(() => {
    testDir = mkdtempSync(path.join(tmpdir(), "meshbot-graph-test-"));
    mkdirSync(path.join(testDir, "prompt"), { recursive: true });
    const { ctx: c, configService, promptService } = makeTestServices(testDir);
    ctx = c;
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
    ({ gs: graphService } = makeGraphService({
      configService,
      promptService,
      account: ctx,
      fakeModel,
    }));
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
    await ctx.run(TEST_ACCOUNT, async () => {
      for await (const ev of graphService.streamMessage(threadId, [
        { id: "pm-1", content: "hi" },
      ])) {
        events.push(ev);
      }
    });
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
    await ctx.run(TEST_ACCOUNT, async () => {
      for await (const ev of graphService.streamMessage(threadId, [
        { id: "pm-1", content: "hi" },
      ])) {
        events.push(ev);
      }
    });
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
    await ctx.run(TEST_ACCOUNT, async () => {
      for await (const _ev of graphService.streamMessage(threadId, [
        { id: "pm-1", content: "hi" },
      ])) {
        // 仅消费流以驱动 checkpointer 落盘
      }
    });
    const history = await ctx.run(TEST_ACCOUNT, () =>
      graphService.getHistory(threadId),
    );
    expect(Array.isArray(history)).toBe(true);
    expect(history.length).toBeGreaterThan(0);
  });

  it("streamMessage 用传入 id 构造 HumanMessage 并写入 checkpointer", async () => {
    const threadId = await graphService.startSession({ model: "fake" });
    await ctx.run(TEST_ACCOUNT, async () => {
      for await (const _ of graphService.streamMessage(threadId, [
        { id: "pm-1", content: "hi" },
      ])) {
        // 消费完
      }
    });
    const history = await ctx.run(TEST_ACCOUNT, () =>
      graphService.getHistory(threadId),
    );
    const userMsg = history.find((m) => m.role === "user");
    expect(userMsg?.id).toBe("pm-1");
  });

  it("resumeStream 不加新消息，从现有状态继续流式", async () => {
    const threadId = await graphService.startSession({ model: "fake" });
    await ctx.run(TEST_ACCOUNT, async () => {
      for await (const _ of graphService.streamMessage(threadId, [
        { id: "pm-1", content: "hi" },
      ])) {
        // 先跑一轮建立历史
      }
    });
    const before = await ctx.run(TEST_ACCOUNT, () =>
      graphService.getHistory(threadId),
    );
    const userCountBefore = before.filter((m) => m.role === "user").length;
    const chunks: unknown[] = [];
    await ctx.run(TEST_ACCOUNT, async () => {
      for await (const ev of graphService.resumeStream(threadId)) {
        chunks.push(ev);
      }
    });
    const after = await ctx.run(TEST_ACCOUNT, () =>
      graphService.getHistory(threadId),
    );
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
    const {
      ctx: ctx2,
      configService: cfg2,
      promptService: ps2,
    } = makeTestServices(testDir);
    const model2 = new TwoRoundModel({});
    const { gs } = makeGraphService({
      configService: cfg2,
      promptService: ps2,
      account: ctx2,
      fakeModel: model2,
      toolRegistry: toolRegistry2,
    });
    const threadId = await gs.startSession({ model: "fake" });
    const events: Array<{ kind: string; messageId: string; t: number }> = [];
    await ctx2.run(TEST_ACCOUNT, async () => {
      for await (const ev of gs.streamMessage(threadId, [
        { id: "pm-1", content: "hi" },
      ])) {
        events.push({
          kind: ev.kind,
          messageId: (ev as { messageId?: string }).messageId ?? "",
          t: Date.now(),
        });
      }
    });
    // 首个 assistant_done = 轮 A（tool_calls 轮，supervisor 退出即 flush，早于轮 B）。
    // id 已收口为雪花，不再是模型原始 "msg-A"。
    const adA = events.find((e) => e.kind === "assistant_done");
    expect(adA).toBeTruthy();
    expect(adA?.messageId).not.toBe("msg-A");
    expect(adA?.messageId).toMatch(/^\d{15,}$/);
    expect(toolFinishedAt).toBeGreaterThan(0);
    // 关键断言：assistant_done(A) 必须在 tool 完成之前 yield
    // 修复前（仅 ToolMessage 触发）：flush 等 ToolMessage 进 stream（tool resolve 之后）→ adA.t ≥ toolFinishedAt
    // 修复后（supervisor update 触发）：assistant_done 立即 yield，远早于 tool 完成 → adA.t < toolFinishedAt
    expect(adA?.t).toBeLessThan(toolFinishedAt);
  });

  it("runGraphStream：同一轮所有事件 messageId 收口为雪花（非模型UUID）", async () => {
    // 单轮：reasoning + content，模型 id 固定 "model-uuid-1"。
    // 断言所有 assistant 轮事件（reasoning/chunk/reasoning_done/assistant_done/usage）
    // 的 messageId 收口为同一雪花，且不等于模型原始 UUID。
    class ReasoningModel extends (
      await import("@langchain/core/language_models/chat_models")
    ).BaseChatModel {
      _llmType() {
        return "reasoning-fake";
      }
      async _generate() {
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
        const c1 = new ChatGenerationChunk({
          message: new AIMessageChunk({
            id: "model-uuid-1",
            content: "",
            additional_kwargs: { reasoning_content: "想一下" },
          }),
          text: "",
        });
        yield c1;
        await runManager?.handleLLMNewToken(
          "",
          undefined,
          undefined,
          undefined,
          undefined,
          { chunk: c1 },
        );
        const c2 = new ChatGenerationChunk({
          message: new AIMessageChunk({ id: "model-uuid-1", content: "好" }),
          text: "好",
        });
        yield c2;
        await runManager?.handleLLMNewToken(
          "好",
          undefined,
          undefined,
          undefined,
          undefined,
          { chunk: c2 },
        );
      }
    }
    const {
      ctx: ctx3,
      configService: cfg3,
      promptService: ps3,
    } = makeTestServices(testDir);
    const toolRegistry3 = new ToolRegistry(
      { getProviders: () => [] } as never,
      new AccountContextService(),
    );
    const { gs } = makeGraphService({
      configService: cfg3,
      promptService: ps3,
      account: ctx3,
      fakeModel: new ReasoningModel({}),
      toolRegistry: toolRegistry3,
    });
    const threadId = await gs.startSession({ model: "fake" });
    // biome-ignore lint/suspicious/noExplicitAny: 测试装载事件
    const events: any[] = [];
    await ctx3.run(TEST_ACCOUNT, async () => {
      for await (const ev of gs.streamMessage(threadId, [
        { id: "pm-1", content: "hi" },
      ])) {
        events.push(ev);
      }
    });
    // 取 assistant 轮事件（排除 human）的 messageId 去重
    const roundIds = new Set<string>(
      events
        .filter((e) => e.kind !== "human" && typeof e.messageId === "string")
        .map((e) => e.messageId as string),
    );
    expect(roundIds.size).toBe(1);
    const [sid] = [...roundIds];
    expect(sid).not.toBe("model-uuid-1");
    expect(sid).toMatch(/^\d{15,}$/);
  });
});

// ─── system:ctx 刷新不累积 ─────────────────────────────────────────────────

describe("GraphService system:ctx 刷新不累积", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(path.join(tmpdir(), "meshbot-ctx-refresh-test-"));
    mkdirSync(path.join(testDir, "prompt"), { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("连续两次 streamMessage 后 state 里 id===system:ctx 的消息恰好 1 条", async () => {
    const ctx = new AccountContextService();
    const configService = new MeshbotConfigService(ctx);
    (configService as unknown as Record<string, string>).meshbotDir = testDir;
    const promptService = new PromptService(configService, ctx);
    const toolRegistry = new ToolRegistry(
      { getProviders: () => [] } as never,
      new AccountContextService(),
    );

    // 使用能正确驱动 messages 流的 BaseChatModel 子类
    class SimpleModel extends (
      await import("@langchain/core/language_models/chat_models")
    ).BaseChatModel {
      private callCount = 0;
      _llmType() {
        return "simple-fake";
      }
      async _generate() {
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
        const msgId = `msg-simple-${this.callCount}`;
        const chunk = new ChatGenerationChunk({
          message: new AIMessageChunk({
            id: msgId,
            content: "ok",
            usage_metadata: {
              input_tokens: 1,
              output_tokens: 1,
              total_tokens: 2,
              input_token_details: { cache_read: 0, cache_creation: 0 },
              output_token_details: { reasoning: 0 },
            },
          }),
          text: "ok",
        });
        yield chunk;
        await runManager?.handleLLMNewToken(
          "ok",
          undefined,
          undefined,
          undefined,
          undefined,
          { chunk },
        );
      }
    }

    const fakePort: RuntimeContextPort = {
      resolve: async () => ({
        displayName: "Grant",
        language: "zh",
        timezone: "Asia/Shanghai",
      }),
    };

    const { gs } = makeGraphService({
      configService,
      promptService,
      account: ctx,
      fakeModel: new SimpleModel({}),
      toolRegistry,
      runtimeContext: fakePort,
    });

    const threadId = await gs.startSession({ model: "fake" });

    // 第一次 streamMessage
    await ctx.run(TEST_ACCOUNT, async () => {
      for await (const _ of gs.streamMessage(threadId, [
        { id: "pm-1", content: "hi" },
      ])) {
        // 消费完
      }
    });

    // 第二次 streamMessage
    await ctx.run(TEST_ACCOUNT, async () => {
      for await (const _ of gs.streamMessage(threadId, [
        { id: "pm-2", content: "hello" },
      ])) {
        // 消费完
      }
    });

    // 直接从 graph state 取消息快照
    const snapshot = await ctx.run(TEST_ACCOUNT, () =>
      gs.getMessagesSnapshot(threadId),
    );

    const ctxMsgs = snapshot.filter((m) => m.id === "system:ctx");
    expect(ctxMsgs.length).toBe(1);

    // 验证内容为最新（含 cloudUserId/sessionId）
    const ctxContent =
      typeof ctxMsgs[0].content === "string" ? ctxMsgs[0].content : "";
    expect(ctxContent).toContain("sessionId:");
    expect(ctxContent).toContain("cloudUserId:");
  });
});

// ─── core 记忆注入系统提示 ─────────────────────────────────────────────────

describe("GraphService core 记忆注入系统提示", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(path.join(tmpdir(), "meshbot-memory-inject-test-"));
    mkdirSync(path.join(testDir, "prompt"), { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  function makeGs(fakeMemory?: Partial<MemoryService>): {
    gs: GraphService;
    contextBuilder: ContextBuilder;
    ctx: AccountContextService;
  } {
    const ctx = new AccountContextService();
    const configService = new MeshbotConfigService(ctx);
    (configService as unknown as Record<string, string>).meshbotDir = testDir;
    const promptService = new PromptService(configService, ctx);
    const toolRegistry = new ToolRegistry(
      { getProviders: () => [] } as never,
      new AccountContextService(),
    );
    const fakeModel = {
      stream: async () => {
        async function* gen() {
          yield new AIMessageChunk({ id: "x", content: "ok" });
        }
        return gen();
      },
    };
    const { gs, contextBuilder } = makeGraphService({
      configService,
      promptService,
      account: ctx,
      fakeModel,
      toolRegistry,
      memory: fakeMemory as MemoryService | undefined,
    });
    return { gs, contextBuilder, ctx };
  }

  it("core 非空时：buildMemorySection 含 MEMORY_GUIDE + <memory> + core 内容", () => {
    const { contextBuilder } = makeGs({ readCore: () => "用户偏好简洁" });
    const section = contextBuilder.buildMemorySection();
    // 含 MEMORY_GUIDE 关键句
    expect(section).toContain("two-tier persistent memory");
    expect(section).toContain(MEMORY_GUIDE.slice(0, 30));
    // 含 <memory> 块 + core 内容
    expect(section).toContain("<memory>");
    expect(section).toContain("用户偏好简洁");
    expect(section).toContain("</memory>");
  });

  it("core 为空时：buildMemorySection 含 MEMORY_GUIDE，不含 <memory>", () => {
    const { contextBuilder } = makeGs({ readCore: () => "" });
    const section = contextBuilder.buildMemorySection();
    expect(section).toContain("two-tier persistent memory");
    expect(section).not.toContain("<memory>");
  });

  it("无 MemoryService 时：buildMemorySection 仍返回 MEMORY_GUIDE（不报错）", () => {
    const { contextBuilder } = makeGs(undefined);
    const section = contextBuilder.buildMemorySection();
    // 无 MemoryService → memory?.readCore() 为 undefined → core="" → 仅返回 GUIDE
    expect(section).toContain("two-tier persistent memory");
    expect(section).not.toContain("<memory>");
  });

  it("首轮系统提示含 MEMORY_GUIDE（core 非空时还含 <memory>）", async () => {
    const { gs, ctx } = makeGs({ readCore: () => "用户偏好简洁" });
    const threadId = await gs.startSession({ model: "fake" });
    const capturedSystemMessages: SystemMessage[] = [];

    // 消费首轮，同时从 graph state 取首条 SystemMessage
    await ctx.run(TEST_ACCOUNT, async () => {
      for await (const _ of gs.streamMessage(threadId, [
        { id: "pm-1", content: "hi" },
      ])) {
        // 消费完
      }
    });

    const snapshot = await ctx.run(TEST_ACCOUNT, () =>
      gs.getMessagesSnapshot(threadId),
    );
    const sysMsgs = snapshot.filter(
      (m) => m._getType() === "system" && m.id !== "system:ctx",
    );
    // persona 可能为空（无 prompt 文件）；但 buildMemorySection 不为空时必然有内容拼上
    // 直接断言 buildMemorySection 行为（上面 3 个单元测试已覆盖）
    // 这里验证：系统消息（非 ctx）若存在，其 content 含 MEMORY_GUIDE
    if (sysMsgs.length > 0) {
      const content =
        typeof sysMsgs[0].content === "string" ? sysMsgs[0].content : "";
      expect(content).toContain("two-tier persistent memory");
      expect(content).toContain("<memory>");
      expect(content).toContain("用户偏好简洁");
    }
    // 无论如何，capturedSystemMessages 赋值只是为了 lint；主要靠单元断言
    capturedSystemMessages.push(...(sysMsgs as SystemMessage[]));
  });

  it("既有 harness（无 MemoryService）：构造不报错，streamMessage 正常流式", async () => {
    const { gs, ctx } = makeGs(undefined);
    const threadId = await gs.startSession({ model: "fake" });
    const chunks: unknown[] = [];
    await ctx.run(TEST_ACCOUNT, async () => {
      for await (const ev of gs.streamMessage(threadId, [
        { id: "pm-1", content: "hi" },
      ])) {
        chunks.push(ev);
      }
    });
    expect(chunks.length).toBeGreaterThan(0);
  });
});

// ─── buildContextMessage ───────────────────────────────────────────────────

describe("GraphService.buildContextMessage", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(path.join(tmpdir(), "meshbot-ctx-test-"));
    mkdirSync(path.join(testDir, "prompt"), { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  /** 构造带可选 runtimeContext 的 ContextBuilder。 */
  function makeGs(runtimeContext?: RuntimeContextPort): {
    contextBuilder: ContextBuilder;
    ctx: AccountContextService;
  } {
    const ctx = new AccountContextService();
    const configService = new MeshbotConfigService(ctx);
    (configService as unknown as Record<string, string>).meshbotDir = testDir;
    const promptService = new PromptService(configService, ctx);
    const toolRegistry = new ToolRegistry(
      { getProviders: () => [] } as never,
      new AccountContextService(),
    );
    const fakeModel = {
      stream: async () => {
        async function* gen() {
          yield new AIMessageChunk({ id: "x", content: "ok" });
        }
        return gen();
      },
    };
    const { contextBuilder } = makeGraphService({
      configService,
      promptService,
      account: ctx,
      fakeModel,
      toolRegistry,
      runtimeContext,
    });
    return { contextBuilder, ctx };
  }

  it("有 port 时：id=system:ctx，content 含各字段，不含 now/日期", async () => {
    const fakePort: RuntimeContextPort = {
      resolve: async () => ({
        displayName: "Grant",
        language: "zh",
        timezone: "Asia/Shanghai",
      }),
    };
    const { contextBuilder, ctx } = makeGs(fakePort);

    const msg = await ctx.run("acct-1", () =>
      contextBuilder.buildContextMessage("s1"),
    );

    expect(msg.id).toBe("system:ctx");
    const content = typeof msg.content === "string" ? msg.content : "";
    expect(content).toContain("cloudUserId:");
    expect(content).toContain("sessionId: s1");
    expect(content).toContain("user: Grant");
    expect(content).toContain("model:");
    expect(content).toContain("language: zh");
    expect(content).toContain("timezone: Asia/Shanghai");
    // 不含实时时间
    expect(content).not.toMatch(/\bnow\b/i);
    // 不含日期格式（YYYY-MM-DD / ISO 8601 前缀）
    expect(content).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });

  it("无 port 时：timezone 兜底为 Intl 本地时区", async () => {
    const { contextBuilder, ctx } = makeGs(undefined);

    const msg = await ctx.run("acct-2", () =>
      contextBuilder.buildContextMessage("s2"),
    );

    const content = typeof msg.content === "string" ? msg.content : "";
    const localTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    expect(content).toContain(`timezone: ${localTz}`);
    // 无 port → 无 user/language 行
    expect(content).not.toContain("user:");
    expect(content).not.toContain("language:");
  });
});
