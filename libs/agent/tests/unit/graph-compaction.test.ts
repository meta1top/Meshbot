import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { AIMessage } from "@langchain/core/messages";
import { EventEmitter2 } from "@nestjs/event-emitter";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AccountContextService } from "../../src/account/account-context.service";
import { AgentContextService } from "../../src/account/agent-context.service";
import { MeshbotConfigService } from "../../src/config/meshbot-config.service";
import { AccountGraphProvider } from "../../src/graph/account-graph.provider";
import { ContextBuilder } from "../../src/graph/context-builder.js";
import { GraphRunner } from "../../src/graph/graph-runner.service.js";
import { ModelResolver } from "../../src/graph/model-resolver.service.js";
import { ModelRunContext } from "../../src/graph/model-run-context.js";
import { ThreadStateService } from "../../src/graph/thread-state.service.js";
import { PromptService } from "../../src/prompt/prompt.service";
import { ToolRegistry } from "../../src/tools/tool-registry";

const TEST_ACCOUNT = "test-compaction-account";

describe("GraphService compaction hooks", () => {
  let testDir: string;
  let ctx: AccountContextService;
  let graphRunner: GraphRunner;
  let threadState: ThreadStateService;
  let modelResolver: ModelResolver;
  let invokeCalls: { messages: { content: string }[]; config: unknown }[];

  beforeEach(() => {
    testDir = mkdtempSync(path.join(tmpdir(), "meshbot-compact-test-"));
    mkdirSync(path.join(testDir, "prompt"), { recursive: true });
    ctx = new AccountContextService();
    const configService = new MeshbotConfigService(
      ctx,
      new AgentContextService(),
    );
    (configService as unknown as Record<string, string>).meshbotDir = testDir;
    const promptService = new PromptService(configService, ctx);
    invokeCalls = [];
    const fakeModel = {
      stream: async () => {
        async function* gen() {
          yield new AIMessage({ id: "fake-a", content: "stream-ack" });
        }
        return gen();
      },
      invoke: async (messages: { content: string }[], config?: unknown) => {
        invokeCalls.push({ messages, config });
        return new AIMessage({ id: "summary-resp", content: "MOCK_SUMMARY" });
      },
    };
    const toolRegistry = new ToolRegistry(
      { getProviders: () => [] } as never,
      new AccountContextService(),
    );
    modelResolver = new ModelResolver(
      configService,
      ctx,
      new ModelRunContext(),
      () => Promise.resolve(fakeModel as never),
      { providerType: "fake", model: "fake-model" },
    );
    const eventEmitter = new EventEmitter2();
    const accountGraphProvider = new AccountGraphProvider(
      configService,
      ctx,
      toolRegistry,
      eventEmitter,
      modelResolver,
    );
    const contextBuilder = new ContextBuilder(ctx);
    threadState = new ThreadStateService(accountGraphProvider);
    graphRunner = new GraphRunner(
      promptService,
      accountGraphProvider,
      modelResolver,
      contextBuilder,
      threadState,
    );
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("getMessagesSnapshot 空 thread 返空数组", async () => {
    const threadId = await graphRunner.startSession({ model: "fake" });
    const msgs = await ctx.run(TEST_ACCOUNT, () =>
      threadState.getMessagesSnapshot(threadId),
    );
    expect(msgs).toEqual([]);
  });

  it("getMessagesSnapshot 在 streamMessage 后返非空", async () => {
    const threadId = await graphRunner.startSession({ model: "fake" });
    await ctx.run(TEST_ACCOUNT, async () => {
      for await (const _ of graphRunner.streamMessage(threadId, [
        { id: "h1", content: "hi" },
      ])) {
        // drain
      }
    });
    const msgs = await ctx.run(TEST_ACCOUNT, () =>
      threadState.getMessagesSnapshot(threadId),
    );
    expect(msgs.length).toBeGreaterThan(0);
  });

  it("summarize 调 model.invoke 传 system + user 并返字符串", async () => {
    const out = await modelResolver.summarize("[user] hi\n[assistant] hello", {
      systemPrompt: "SYS",
      timeoutMs: 1000,
      maxTokens: 100,
    });
    expect(out).toBe("MOCK_SUMMARY");
    expect(invokeCalls).toHaveLength(1);
    expect(invokeCalls[0].messages[0].content).toBe("SYS");
    expect(invokeCalls[0].messages[1].content).toContain("hi");
  });

  it("applyCompaction：摘要排在保留区之前，删掉摘要区、保留区移到摘要后", async () => {
    const threadId = await graphRunner.startSession({ model: "fake" });
    // 跑两轮，制造多条 messages
    await ctx.run(TEST_ACCOUNT, async () => {
      for await (const _ of graphRunner.streamMessage(threadId, [
        { id: "h1", content: "first" },
      ])) {
        // drain
      }
      for await (const _ of graphRunner.streamMessage(threadId, [
        { id: "h2", content: "second" },
      ])) {
        // drain
      }
    });
    const before = await ctx.run(TEST_ACCOUNT, () =>
      threadState.getMessagesSnapshot(threadId),
    );
    // 假设保留最后 2 条，前面的都压缩
    const splitIdx = before.length - 2;
    const toSummarize = before.slice(0, splitIdx);
    const keep = before.slice(splitIdx);
    const removeIds = before
      .map((m) => m.id)
      .filter((id): id is string => typeof id === "string");

    await ctx.run(TEST_ACCOUNT, () =>
      threadState.applyCompaction(threadId, {
        removeIds,
        summaryText: "COMPRESSED_SUMMARY",
        keep,
      }),
    );

    const after = await ctx.run(TEST_ACCOUNT, () =>
      threadState.getMessagesSnapshot(threadId),
    );
    // 恰好一条摘要 SystemMessage
    const summaryIdx = after.findIndex(
      (m) =>
        m._getType() === "system" &&
        typeof m.content === "string" &&
        m.content.includes("COMPRESSED_SUMMARY"),
    );
    expect(summaryIdx).toBeGreaterThanOrEqual(0);
    // 保留区的消息都在摘要之后
    for (const k of keep) {
      const idx = after.findIndex((m) => m.id === k.id);
      expect(idx).toBeGreaterThan(summaryIdx);
    }
    // 被压缩的（不在 keep 里的带 id 消息）不应再出现
    const keepIds = new Set(keep.map((m) => m.id));
    for (const m of toSummarize) {
      if (m.id && !keepIds.has(m.id)) {
        expect(after.find((x) => x.id === m.id)).toBeUndefined();
      }
    }
  });
});
