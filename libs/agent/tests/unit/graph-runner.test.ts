import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { AIMessageChunk, ToolMessage } from "@langchain/core/messages";
import { ChatGenerationChunk } from "@langchain/core/outputs";
import { EventEmitter2 } from "@nestjs/event-emitter";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { AccountContextService } from "../../src/account/account-context.service";
import { MeshbotConfigService } from "../../src/config/meshbot-config.service";
import { AccountGraphProvider } from "../../src/graph/account-graph.provider";
import { ContextBuilder } from "../../src/graph/context-builder.js";
import { GraphRunner } from "../../src/graph/graph-runner.service.js";
import { ModelResolver } from "../../src/graph/model-resolver.service.js";
import { ModelRunContext } from "../../src/graph/model-run-context.js";
import { ThreadStateService } from "../../src/graph/thread-state.service.js";
import type { RuntimeContextPort } from "../../src/graph/runtime-context.port";
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

/** 构造受测服务及其依赖的小对象图（fake model 经 ModelResolver 注入）。 */
function makeServices(opts: {
  configService: MeshbotConfigService;
  promptService: PromptService;
  account: AccountContextService;
  fakeModel: unknown;
  toolRegistry?: ToolRegistry;
  eventEmitter?: EventEmitter2;
  runtimeContext?: RuntimeContextPort;
}): { graphRunner: GraphRunner; threadState: ThreadStateService } {
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
    new ModelRunContext(),
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
    undefined,
    undefined,
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
  return { graphRunner, threadState };
}

describe("GraphRunner", () => {
  let testDir: string;
  let ctx: AccountContextService;
  let graphRunner: GraphRunner;
  let threadState: ThreadStateService;

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
    ({ graphRunner, threadState } = makeServices({
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
    const threadId = await graphRunner.startSession({ model: "gpt-4" });
    expect(typeof threadId).toBe("string");
    expect(threadId.length).toBeGreaterThan(0);
  });

  it("streamMessage 逐 chunk 产出 token 与稳定 messageId", async () => {
    const threadId = await graphRunner.startSession({ model: "fake" });
    const events: Array<
      | { kind: "chunk"; messageId: string; delta: string }
      | { kind: "usage"; messageId: string }
    > = [];
    await ctx.run(TEST_ACCOUNT, async () => {
      for await (const ev of graphRunner.streamMessage(threadId, [
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
    const threadId = await graphRunner.startSession({ model: "fake" });
    // biome-ignore lint/suspicious/noExplicitAny: 测试方便起见用 any 装载事件
    const events: any[] = [];
    await ctx.run(TEST_ACCOUNT, async () => {
      for await (const ev of graphRunner.streamMessage(threadId, [
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

  it("resumeStream 不加新消息，从现有状态继续流式", async () => {
    const threadId = await graphRunner.startSession({ model: "fake" });
    await ctx.run(TEST_ACCOUNT, async () => {
      for await (const _ of graphRunner.streamMessage(threadId, [
        { id: "pm-1", content: "hi" },
      ])) {
        // 先跑一轮建立历史
      }
    });
    const before = await ctx.run(TEST_ACCOUNT, () =>
      threadState.getHistory(threadId),
    );
    const userCountBefore = before.filter((m) => m.role === "user").length;
    const chunks: unknown[] = [];
    await ctx.run(TEST_ACCOUNT, async () => {
      for await (const ev of graphRunner.resumeStream(threadId)) {
        chunks.push(ev);
      }
    });
    const after = await ctx.run(TEST_ACCOUNT, () =>
      threadState.getHistory(threadId),
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
    const { graphRunner: gr2 } = makeServices({
      configService: cfg2,
      promptService: ps2,
      account: ctx2,
      fakeModel: model2,
      toolRegistry: toolRegistry2,
    });
    const threadId = await gr2.startSession({ model: "fake" });
    const events: Array<{ kind: string; messageId: string; t: number }> = [];
    await ctx2.run(TEST_ACCOUNT, async () => {
      for await (const ev of gr2.streamMessage(threadId, [
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
    const { graphRunner: gr3 } = makeServices({
      configService: cfg3,
      promptService: ps3,
      account: ctx3,
      fakeModel: new ReasoningModel({}),
      toolRegistry: toolRegistry3,
    });
    const threadId = await gr3.startSession({ model: "fake" });
    // biome-ignore lint/suspicious/noExplicitAny: 测试装载事件
    const events: any[] = [];
    await ctx3.run(TEST_ACCOUNT, async () => {
      for await (const ev of gr3.streamMessage(threadId, [
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

describe("GraphRunner system:ctx 刷新不累积", () => {
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

    const { graphRunner: gr, threadState: ts } = makeServices({
      configService,
      promptService,
      account: ctx,
      fakeModel: new SimpleModel({}),
      toolRegistry,
      runtimeContext: fakePort,
    });

    const threadId = await gr.startSession({ model: "fake" });

    // 第一次 streamMessage
    await ctx.run(TEST_ACCOUNT, async () => {
      for await (const _ of gr.streamMessage(threadId, [
        { id: "pm-1", content: "hi" },
      ])) {
        // 消费完
      }
    });

    // 第二次 streamMessage
    await ctx.run(TEST_ACCOUNT, async () => {
      for await (const _ of gr.streamMessage(threadId, [
        { id: "pm-2", content: "hello" },
      ])) {
        // 消费完
      }
    });

    // 直接从 graph state 取消息快照
    const snapshot = await ctx.run(TEST_ACCOUNT, () =>
      ts.getMessagesSnapshot(threadId),
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

// ─── messages 流按 metadata.thread_id 过滤（子图冒泡防护） ────────────────────
//
// 背景：dispatch_subagent 在父图 tools 节点内部同步调用子图，LangGraph 的
// streamMode:"messages" 走 callback 树采集 LLM token —— 子图的 token 事件会
// 冒泡进父图的 stream。runGraphStream 消费时必须按 metadata.thread_id 过滤：
// thread_id 存在且 ≠ 本次 threadId → 丢弃（不产出事件、不触发 flushRound）；
// thread_id 缺失 → fail-open 保留（本图事件缺字段时不误杀）。
// 写侧配套：graph.stream 调用处必须显式传 metadata:{thread_id}——LangGraph 的
// ensureLangGraphConfig 只在 metadata 缺 thread_id 时才从 configurable 回填，
// 子图在父节点 ALS 上下文内调用时会原样继承父的 metadata.thread_id，必须显式盖章。

describe("GraphRunner messages 流按 metadata.thread_id 过滤", () => {
  let testDir: string;
  let ctx: AccountContextService;
  let graphRunner: GraphRunner;

  /** 用可控 parts 序列 stub 掉 pickGraph，直驱 runGraphStream 的消费逻辑。 */
  function stubGraphStream(
    runner: GraphRunner,
    parts: Array<[string, unknown]>,
    captured?: { config?: Record<string, unknown> },
  ): void {
    const fakeGraph = {
      stream: async (_input: unknown, config: Record<string, unknown>) => {
        if (captured) captured.config = config;
        return (async function* () {
          yield* parts;
        })();
      },
      getState: async () => ({ values: { messages: [] } }),
    };
    (runner as unknown as { pickGraph: () => unknown }).pickGraph = () =>
      fakeGraph;
  }

  /** 消费 resumeStream 收集全部事件（resumeStream 直达 runGraphStream，路径最短）。 */
  // biome-ignore lint/suspicious/noExplicitAny: 测试装载事件
  async function collect(threadId: string): Promise<any[]> {
    // biome-ignore lint/suspicious/noExplicitAny: 测试装载事件
    const events: any[] = [];
    await ctx.run(TEST_ACCOUNT, async () => {
      for await (const ev of graphRunner.resumeStream(threadId)) {
        events.push(ev);
      }
    });
    return events;
  }

  beforeEach(() => {
    testDir = mkdtempSync(path.join(tmpdir(), "meshbot-thread-filter-test-"));
    mkdirSync(path.join(testDir, "prompt"), { recursive: true });
    const { ctx: c, configService, promptService } = makeTestServices(testDir);
    ctx = c;
    ({ graphRunner } = makeServices({
      configService,
      promptService,
      account: ctx,
      fakeModel: { stream: async () => (async function* () {})() },
    }));
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("外来 thread_id 的 AIMessageChunk 被整体丢弃：无 chunk/assistant_done/usage", async () => {
    const threadId = await graphRunner.startSession({ model: "fake" });
    stubGraphStream(graphRunner, [
      [
        "messages",
        [
          new AIMessageChunk({
            id: "foreign-1",
            content: "泄",
            usage_metadata: {
              input_tokens: 6813,
              output_tokens: 100,
              total_tokens: 6913,
            },
          }),
          { thread_id: "foreign-thread" },
        ],
      ],
      [
        "messages",
        [
          new AIMessageChunk({ id: "foreign-1", content: "漏" }),
          { thread_id: "foreign-thread" },
        ],
      ],
    ]);
    const events = await collect(threadId);
    expect(events.filter((e) => e.kind === "chunk")).toHaveLength(0);
    expect(events.filter((e) => e.kind === "reasoning")).toHaveLength(0);
    expect(events.filter((e) => e.kind === "tool_call_args")).toHaveLength(0);
    expect(events.filter((e) => e.kind === "assistant_done")).toHaveLength(0);
    expect(events.filter((e) => e.kind === "usage")).toHaveLength(0);
  });

  it("metadata.thread_id === 本次 threadId 的事件照常产出", async () => {
    const threadId = await graphRunner.startSession({ model: "fake" });
    stubGraphStream(graphRunner, [
      [
        "messages",
        [
          new AIMessageChunk({
            id: "own-1",
            content: "好",
            usage_metadata: {
              input_tokens: 10,
              output_tokens: 2,
              total_tokens: 12,
            },
          }),
          { thread_id: threadId },
        ],
      ],
    ]);
    const events = await collect(threadId);
    const chunks = events.filter((e) => e.kind === "chunk");
    expect(chunks).toHaveLength(1);
    expect(chunks[0].delta).toBe("好");
    expect(events.filter((e) => e.kind === "assistant_done")).toHaveLength(1);
    expect(events.filter((e) => e.kind === "usage")).toHaveLength(1);
  });

  it("metadata 缺 thread_id 时 fail-open：事件照常产出", async () => {
    const threadId = await graphRunner.startSession({ model: "fake" });
    stubGraphStream(graphRunner, [
      // metadata 为空对象
      ["messages", [new AIMessageChunk({ id: "own-2", content: "a" }), {}]],
      // metadata 干脆缺位
      ["messages", [new AIMessageChunk({ id: "own-2", content: "b" })]],
    ]);
    const events = await collect(threadId);
    const chunks = events.filter((e) => e.kind === "chunk");
    expect(chunks.map((c) => c.delta)).toEqual(["a", "b"]);
    const dones = events.filter((e) => e.kind === "assistant_done");
    expect(dones).toHaveLength(1);
    expect(dones[0].content).toBe("ab");
  });

  it("轮中出现外来 ToolMessage 不触发 backup-flush：本轮不被截断", async () => {
    const threadId = await graphRunner.startSession({ model: "fake" });
    stubGraphStream(graphRunner, [
      [
        "messages",
        [
          new AIMessageChunk({ id: "own-3", content: "a" }),
          { thread_id: threadId },
        ],
      ],
      // 外来（子图）ToolMessage 混进流中——过滤后不得触发 flushRound
      [
        "messages",
        [
          new ToolMessage({
            tool_call_id: "foreign-tc",
            name: "foreign_tool",
            content: "foreign result",
          }),
          { thread_id: "foreign-thread" },
        ],
      ],
      [
        "messages",
        [
          new AIMessageChunk({ id: "own-3", content: "b" }),
          { thread_id: threadId },
        ],
      ],
    ]);
    const events = await collect(threadId);
    const dones = events.filter((e) => e.kind === "assistant_done");
    // 未修复时：外来 ToolMessage 走 backup-flush → 本轮被切成两条 assistant_done（"a" / "b"）
    expect(dones).toHaveLength(1);
    expect(dones[0].content).toBe("ab");
  });

  it("写侧回归守卫：graph.stream 显式传 metadata.thread_id = 本次 threadId", async () => {
    const threadId = await graphRunner.startSession({ model: "fake" });
    const captured: { config?: Record<string, unknown> } = {};
    stubGraphStream(graphRunner, [], captured);
    await collect(threadId);
    expect(captured.config).toBeTruthy();
    const configurable = captured.config?.configurable as
      | Record<string, unknown>
      | undefined;
    expect(configurable?.thread_id).toBe(threadId);
    // 关键：metadata 也要显式盖章 —— 否则子图在父 tools 节点 ALS 上下文内调用时
    // 会继承父的 metadata.thread_id（ensureLangGraphConfig 仅在缺失时回填）。
    const metadata = captured.config?.metadata as
      | Record<string, unknown>
      | undefined;
    expect(metadata?.thread_id).toBe(threadId);
  });
});
