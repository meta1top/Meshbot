import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { AIMessageChunk } from "@langchain/core/messages";
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

const TEST_ACCOUNT = "test-account";

function makeTestServices(testDir: string): {
  ctx: AccountContextService;
  configService: MeshbotConfigService;
  promptService: PromptService;
} {
  const ctx = new AccountContextService();
  const configService = new MeshbotConfigService(
    ctx,
    new AgentContextService(),
  );
  (configService as unknown as Record<string, string>).meshbotDir = testDir;
  const promptService = new PromptService(configService, ctx);
  return { ctx, configService, promptService };
}

/** 构造受测服务及其依赖的小对象图。 */
function makeServices(opts: {
  configService: MeshbotConfigService;
  promptService: PromptService;
  account: AccountContextService;
  fakeModel: unknown;
  toolRegistry?: ToolRegistry;
  eventEmitter?: EventEmitter2;
}): { graphRunner: GraphRunner; threadState: ThreadStateService } {
  const toolRegistry =
    opts.toolRegistry ??
    new ToolRegistry(
      { getProviders: () => [] } as never,
      new AccountContextService(),
      new AgentContextService(),
    );
  const eventEmitter = opts.eventEmitter ?? new EventEmitter2();
  const modelResolver = new ModelResolver(
    opts.account,
    new ModelRunContext(),
    // 测试全程走 overrideProvider（下方），resolveModel() 不会被调用，
    // 这里给个不会命中的占位端口即可。
    { resolveActive: async () => null, resolveById: async () => null },
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
    undefined,
    undefined,
    undefined,
    modelResolver,
  );
  const threadState = new ThreadStateService(accountGraphProvider);
  const graphRunner = new GraphRunner(
    accountGraphProvider,
    modelResolver,
    contextBuilder,
    threadState,
  );
  return { graphRunner, threadState };
}

describe("ThreadStateService.getHistory", () => {
  let testDir: string;
  let ctx: AccountContextService;
  let graphRunner: GraphRunner;
  let threadState: ThreadStateService;

  beforeEach(() => {
    testDir = mkdtempSync(path.join(tmpdir(), "meshbot-thread-state-test-"));
    mkdirSync(path.join(testDir, "prompt"), { recursive: true });
    const { ctx: c, configService, promptService } = makeTestServices(testDir);
    ctx = c;
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

  it("returns history after streamMessage", async () => {
    const threadId = await graphRunner.startSession({ model: "fake" });
    await ctx.run(TEST_ACCOUNT, async () => {
      for await (const _ev of graphRunner.streamMessage(threadId, [
        { id: "pm-1", content: "hi" },
      ])) {
        // 仅消费流以驱动 checkpointer 落盘
      }
    });
    const history = await ctx.run(TEST_ACCOUNT, () =>
      threadState.getHistory(threadId),
    );
    expect(Array.isArray(history)).toBe(true);
    expect(history.length).toBeGreaterThan(0);
  });

  it("streamMessage 用传入 id 构造 HumanMessage 并写入 checkpointer", async () => {
    const threadId = await graphRunner.startSession({ model: "fake" });
    await ctx.run(TEST_ACCOUNT, async () => {
      for await (const _ of graphRunner.streamMessage(threadId, [
        { id: "pm-1", content: "hi" },
      ])) {
        // 消费完
      }
    });
    const history = await ctx.run(TEST_ACCOUNT, () =>
      threadState.getHistory(threadId),
    );
    const userMsg = history.find((m) => m.role === "user");
    expect(userMsg?.id).toBe("pm-1");
  });
});
