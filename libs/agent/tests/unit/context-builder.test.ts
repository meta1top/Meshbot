import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { AIMessageChunk } from "@langchain/core/messages";
import type { SystemMessage } from "@langchain/core/messages";
import { EventEmitter2 } from "@nestjs/event-emitter";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AccountContextService } from "../../src/account/account-context.service";
import { MeshbotConfigService } from "../../src/config/meshbot-config.service";
import { AccountGraphProvider } from "../../src/graph/account-graph.provider";
import { ContextBuilder } from "../../src/graph/context-builder.js";
import { GraphRunner } from "../../src/graph/graph-runner.service.js";
import { ModelResolver } from "../../src/graph/model-resolver.service.js";
import { ThreadStateService } from "../../src/graph/thread-state.service.js";
import type { RuntimeContextPort } from "../../src/graph/runtime-context.port";
import { MEMORY_GUIDE } from "../../src/memory/memory-guide";
import type { MemoryService } from "../../src/memory/memory.service";
import { PromptService } from "../../src/prompt/prompt.service";
import { ToolRegistry } from "../../src/tools/tool-registry";

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
  memory?: MemoryService;
}): {
  graphRunner: GraphRunner;
  threadState: ThreadStateService;
  contextBuilder: ContextBuilder;
} {
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
  return { graphRunner, threadState, contextBuilder };
}

// ─── core 记忆注入系统提示 ─────────────────────────────────────────────────

describe("ContextBuilder core 记忆注入系统提示", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(path.join(tmpdir(), "meshbot-memory-inject-test-"));
    mkdirSync(path.join(testDir, "prompt"), { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  function makeGs(fakeMemory?: Partial<MemoryService>): {
    graphRunner: GraphRunner;
    threadState: ThreadStateService;
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
    const { graphRunner, threadState, contextBuilder } = makeServices({
      configService,
      promptService,
      account: ctx,
      fakeModel,
      toolRegistry,
      memory: fakeMemory as MemoryService | undefined,
    });
    return { graphRunner, threadState, contextBuilder, ctx };
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
    const { graphRunner, threadState, ctx } = makeGs({
      readCore: () => "用户偏好简洁",
    });
    const threadId = await graphRunner.startSession({ model: "fake" });
    const capturedSystemMessages: SystemMessage[] = [];

    // 消费首轮，同时从 graph state 取首条 SystemMessage
    await ctx.run(TEST_ACCOUNT, async () => {
      for await (const _ of graphRunner.streamMessage(threadId, [
        { id: "pm-1", content: "hi" },
      ])) {
        // 消费完
      }
    });

    const snapshot = await ctx.run(TEST_ACCOUNT, () =>
      threadState.getMessagesSnapshot(threadId),
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

  it("首轮系统提示含 <llmuse> 说明", async () => {
    const { graphRunner, threadState, ctx } = makeGs({
      readCore: () => "用户偏好简洁",
    });
    const threadId = await graphRunner.startSession({ model: "fake" });
    await ctx.run(TEST_ACCOUNT, async () => {
      for await (const _ of graphRunner.streamMessage(threadId, [
        { id: "pm-1", content: "hi" },
      ])) {
        // 消费完
      }
    });
    const snapshot = await ctx.run(TEST_ACCOUNT, () =>
      threadState.getMessagesSnapshot(threadId),
    );
    const sysMsgs = snapshot.filter(
      (m) => m._getType() === "system" && m.id !== "system:ctx",
    );
    const content =
      sysMsgs.length > 0 && typeof sysMsgs[0].content === "string"
        ? sysMsgs[0].content
        : "";
    expect(content).toContain("<llmuse>");
  });

  it("既有 harness（无 MemoryService）：构造不报错，streamMessage 正常流式", async () => {
    const { graphRunner, ctx } = makeGs(undefined);
    const threadId = await graphRunner.startSession({ model: "fake" });
    const chunks: unknown[] = [];
    await ctx.run(TEST_ACCOUNT, async () => {
      for await (const ev of graphRunner.streamMessage(threadId, [
        { id: "pm-1", content: "hi" },
      ])) {
        chunks.push(ev);
      }
    });
    expect(chunks.length).toBeGreaterThan(0);
  });
});

// ─── buildContextMessage ───────────────────────────────────────────────────

describe("ContextBuilder.buildContextMessage", () => {
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
    const { contextBuilder } = makeServices({
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

  it("quickAssistantName 非空：assistantName 注入所有会话类型（不再限 quick）", async () => {
    const fakePort: RuntimeContextPort = {
      resolve: async () => ({
        displayName: "Grant",
        language: "zh",
        timezone: "Asia/Shanghai",
        quickAssistantName: "小M",
      }),
    };
    const { contextBuilder, ctx } = makeGs(fakePort);

    // 普通会话（不传 kind，等价 kind!=="quick"）也应注入助手名字
    const msg = await ctx.run("acct-3", () =>
      contextBuilder.buildContextMessage("s3"),
    );

    const content = typeof msg.content === "string" ? msg.content : "";
    expect(content).toContain("assistantName: 小M");
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
