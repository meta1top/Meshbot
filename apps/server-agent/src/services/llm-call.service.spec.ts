import { AccountContextService } from "@meshbot/agent";
import { generateSnowflakeId } from "@meshbot/common";
import { DataSource } from "typeorm";
import { ScopedRepositoryFactory } from "../account/scoped-repository.factory";
import { LlmCall } from "../entities/llm-call.entity";
import { LlmCallService } from "./llm-call.service";

/** 默认测试账号：作用域仓库要求每次调用都处于账号上下文内。 */
const DEFAULT_USER = "test-user";

/**
 * 构建一个自动包账号上下文的 service 代理：每个方法调用都跑在指定账号上下文内，
 * 让既有单测无需逐一改写。隔离测试用 rawService + ctx.run 显式切账号。
 */
function wrapInAccount(
  target: LlmCallService,
  ctx: AccountContextService,
  user: string,
): LlmCallService {
  return new Proxy(target, {
    get(t, prop, receiver) {
      const value = Reflect.get(t, prop, receiver);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) =>
        ctx.run(user, () =>
          (value as (...a: unknown[]) => unknown).apply(t, args),
        );
    },
  });
}

/** 辅助函数：向 llm_calls 表直接植入带 cloudUserId 的行（绕过 ALS）。 */
async function seedLlmCall(
  ds: DataSource,
  overrides: Partial<LlmCall> & {
    sessionId: string;
    messageId: string;
    cloudUserId: string;
  },
): Promise<void> {
  await ds.getRepository(LlmCall).insert({
    id: generateSnowflakeId(),
    sessionId: overrides.sessionId,
    messageId: overrides.messageId,
    cloudUserId: overrides.cloudUserId,
    providerType: overrides.providerType ?? "openai",
    model: overrides.model ?? "gpt-4o",
    inputTokens: overrides.inputTokens ?? 10,
    outputTokens: overrides.outputTokens ?? 5,
    totalTokens: overrides.totalTokens ?? 15,
    cacheReadTokens: overrides.cacheReadTokens ?? 0,
    cacheCreationTokens: overrides.cacheCreationTokens ?? 0,
    reasoningTokens: overrides.reasoningTokens ?? 0,
    durationMs: overrides.durationMs ?? 100,
    createdAt: overrides.createdAt ?? new Date(),
  });
}

describe("LlmCallService", () => {
  let ds: DataSource;
  let ctx: AccountContextService;
  /** 真实 service（不包账号上下文，供 ctx.run 显式包裹的隔离测试用）。 */
  let rawService: LlmCallService;
  /** 自动包 DEFAULT_USER 账号上下文的 service 代理，供既有单测复用。 */
  let service: LlmCallService;

  beforeEach(async () => {
    ds = new DataSource({
      type: "better-sqlite3",
      database: ":memory:",
      entities: [LlmCall],
      synchronize: true,
    });
    await ds.initialize();
    ctx = new AccountContextService();
    const scopedFactory = new ScopedRepositoryFactory(ctx);
    rawService = new LlmCallService(ds.getRepository(LlmCall), scopedFactory);
    service = wrapInAccount(rawService, ctx, DEFAULT_USER);
  });

  afterEach(async () => {
    await ds.destroy();
  });

  it("record 落库一行", async () => {
    await service.record({
      sessionId: "s1",
      messageId: "m1",
      providerType: "deepseek",
      model: "deepseek-chat",
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
      cacheReadTokens: 10,
      cacheCreationTokens: 0,
      reasoningTokens: 0,
      durationMs: 1234,
    });
    const rows = await service.listBySession("s1");
    expect(rows).toHaveLength(1);
    expect(rows[0].messageId).toBe("m1");
    expect(rows[0].totalTokens).toBe(150);
  });

  it("getSessionTotals 求和各字段并计算 callCount", async () => {
    await service.record({
      sessionId: "s1",
      messageId: "m1",
      providerType: "deepseek",
      model: "deepseek-chat",
      inputTokens: 60,
      outputTokens: 30,
      totalTokens: 90,
      cacheReadTokens: 10,
      cacheCreationTokens: 5,
      reasoningTokens: 0,
      durationMs: 800,
    });
    await service.record({
      sessionId: "s1",
      messageId: "m2",
      providerType: "deepseek",
      model: "deepseek-chat",
      inputTokens: 80,
      outputTokens: 40,
      totalTokens: 120,
      cacheReadTokens: 20,
      cacheCreationTokens: 0,
      reasoningTokens: 5,
      durationMs: 1000,
    });
    const totals = await service.getSessionTotals("s1");
    expect(totals.inputTokens).toBe(140);
    expect(totals.outputTokens).toBe(70);
    expect(totals.totalTokens).toBe(210);
    expect(totals.cacheReadTokens).toBe(30);
    expect(totals.cacheCreationTokens).toBe(5);
    expect(totals.reasoningTokens).toBe(5);
    expect(totals.callCount).toBe(2);
  });

  it("getSessionTotals 对空会话返回全 0", async () => {
    const totals = await service.getSessionTotals("nonexistent");
    expect(totals).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      reasoningTokens: 0,
      callCount: 0,
      lastInputTokens: 0,
    });
  });

  it("listBySession 按 createdAt 升序", async () => {
    await service.record({
      sessionId: "s1",
      messageId: "m1",
      providerType: "deepseek",
      model: "deepseek-chat",
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      reasoningTokens: 0,
      durationMs: 0,
    });
    await service.record({
      sessionId: "s1",
      messageId: "m2",
      providerType: "deepseek",
      model: "deepseek-chat",
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      reasoningTokens: 0,
      durationMs: 0,
    });
    const rows = await service.listBySession("s1");
    expect(rows.map((r) => r.messageId)).toEqual(["m1", "m2"]);
  });

  it("deleteBySession 删该会话全部记录", async () => {
    await service.record({
      sessionId: "s1",
      messageId: "m1",
      providerType: "p",
      model: "m",
      inputTokens: 1,
      outputTokens: 1,
      totalTokens: 2,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      reasoningTokens: 0,
      durationMs: 1,
    });
    await service.record({
      sessionId: "s2",
      messageId: "m2",
      providerType: "p",
      model: "m",
      inputTokens: 1,
      outputTokens: 1,
      totalTokens: 2,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      reasoningTokens: 0,
      durationMs: 1,
    });
    await service.deleteBySession("s1");
    const remain1 = await service.listBySession("s1");
    const remain2 = await service.listBySession("s2");
    expect(remain1).toHaveLength(0);
    expect(remain2).toHaveLength(1);
  });

  it("deleteAfter 删 createdAt > cutoff 的 LLM 调用", async () => {
    await service.record({
      sessionId: "s1",
      messageId: "m1",
      providerType: "p",
      model: "m",
      inputTokens: 1,
      outputTokens: 1,
      totalTokens: 2,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      reasoningTokens: 0,
      durationMs: 1,
    });
    await new Promise((r) => setTimeout(r, 10));
    const cutoff = new Date();
    await new Promise((r) => setTimeout(r, 10));
    await service.record({
      sessionId: "s1",
      messageId: "m2",
      providerType: "p",
      model: "m",
      inputTokens: 1,
      outputTokens: 1,
      totalTokens: 2,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      reasoningTokens: 0,
      durationMs: 1,
    });
    await service.deleteAfter("s1", cutoff);
    const rows = await service.listBySession("s1");
    expect(rows.map((r) => r.messageId)).toEqual(["m1"]);
  });

  it("无账号上下文调用作用域方法抛错", async () => {
    await expect(
      rawService.record({
        sessionId: "s1",
        messageId: "m1",
        providerType: "p",
        model: "m",
        inputTokens: 1,
        outputTokens: 1,
        totalTokens: 2,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        reasoningTokens: 0,
        durationMs: 1,
      }),
    ).rejects.toThrow();
  });

  describe("账号隔离（ScopedRepository）", () => {
    it("两账号同 session 的 LlmCall 互不可见（listBySession）", async () => {
      await ctx.run("u1", () =>
        rawService.record({
          sessionId: "s1",
          messageId: "m-u1",
          providerType: "p",
          model: "a",
          inputTokens: 10,
          outputTokens: 5,
          totalTokens: 15,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          reasoningTokens: 0,
          durationMs: 100,
        }),
      );
      await ctx.run("u2", () =>
        rawService.record({
          sessionId: "s1",
          messageId: "m-u2",
          providerType: "p",
          model: "b",
          inputTokens: 20,
          outputTokens: 10,
          totalTokens: 30,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          reasoningTokens: 0,
          durationMs: 100,
        }),
      );
      const u1Rows = await ctx.run("u1", () => rawService.listBySession("s1"));
      expect(u1Rows.map((r) => r.messageId)).toEqual(["m-u1"]);
      const u2Rows = await ctx.run("u2", () => rawService.listBySession("s1"));
      expect(u2Rows.map((r) => r.messageId)).toEqual(["m-u2"]);
    });

    it("listByMessageIds 只返回本账号的行（跨账号消息不计入）", async () => {
      await seedLlmCall(ds, {
        sessionId: "s1",
        messageId: "m-u1",
        cloudUserId: "u1",
        totalTokens: 15,
      });
      await seedLlmCall(ds, {
        sessionId: "s1",
        messageId: "m-u2",
        cloudUserId: "u2",
        totalTokens: 30,
      });
      const u1Result = await ctx.run("u1", () =>
        rawService.listByMessageIds(["m-u1", "m-u2"]),
      );
      expect(u1Result.map((r) => r.messageId)).toEqual(["m-u1"]);
      const u2Result = await ctx.run("u2", () =>
        rawService.listByMessageIds(["m-u1", "m-u2"]),
      );
      expect(u2Result.map((r) => r.messageId)).toEqual(["m-u2"]);
    });

    it("sumTotalTokensSince 只统计本账号 token（跨账号不串台）", async () => {
      // u1 有 15+30=45 tokens，u2 有 100 tokens
      await seedLlmCall(ds, {
        sessionId: "s1",
        messageId: "m1",
        cloudUserId: "u1",
        totalTokens: 15,
      });
      await seedLlmCall(ds, {
        sessionId: "s1",
        messageId: "m2",
        cloudUserId: "u1",
        totalTokens: 30,
      });
      await seedLlmCall(ds, {
        sessionId: "s1",
        messageId: "m3",
        cloudUserId: "u2",
        totalTokens: 100,
      });
      const u1Sum = await ctx.run("u1", () =>
        rawService.sumTotalTokensSince(null),
      );
      expect(u1Sum).toBe(45);
      const u2Sum = await ctx.run("u2", () =>
        rawService.sumTotalTokensSince(null),
      );
      expect(u2Sum).toBe(100);
    });

    it("topModelSince 只统计本账号最常用 model（跨账号不污染）", async () => {
      // u1: gpt-4o x2, claude x1 → top = gpt-4o
      await seedLlmCall(ds, {
        sessionId: "s1",
        messageId: "m1",
        cloudUserId: "u1",
        model: "gpt-4o",
      });
      await seedLlmCall(ds, {
        sessionId: "s1",
        messageId: "m2",
        cloudUserId: "u1",
        model: "gpt-4o",
      });
      await seedLlmCall(ds, {
        sessionId: "s1",
        messageId: "m3",
        cloudUserId: "u1",
        model: "claude",
      });
      // u2 使用 claude x3（不应影响 u1 结果）
      await seedLlmCall(ds, {
        sessionId: "s1",
        messageId: "m4",
        cloudUserId: "u2",
        model: "claude",
      });
      await seedLlmCall(ds, {
        sessionId: "s1",
        messageId: "m5",
        cloudUserId: "u2",
        model: "claude",
      });
      await seedLlmCall(ds, {
        sessionId: "s1",
        messageId: "m6",
        cloudUserId: "u2",
        model: "claude",
      });
      const u1Top = await ctx.run("u1", () => rawService.topModelSince(null));
      expect(u1Top).toBe("gpt-4o");
      const u2Top = await ctx.run("u2", () => rawService.topModelSince(null));
      expect(u2Top).toBe("claude");
    });
  });
});

describe("getSessionTotals lastInputTokens", () => {
  let ds: DataSource;
  let ctx: AccountContextService;
  let rawService: LlmCallService;
  let service: LlmCallService;

  beforeEach(async () => {
    ds = new DataSource({
      type: "better-sqlite3",
      database: ":memory:",
      entities: [LlmCall],
      synchronize: true,
    });
    await ds.initialize();
    ctx = new AccountContextService();
    const scopedFactory = new ScopedRepositoryFactory(ctx);
    rawService = new LlmCallService(ds.getRepository(LlmCall), scopedFactory);
    service = wrapInAccount(rawService, ctx, DEFAULT_USER);
  });

  afterEach(async () => {
    await ds.destroy();
  });

  it("空 session 返 lastInputTokens=0", async () => {
    const totals = await service.getSessionTotals("empty-session");
    expect(totals.lastInputTokens).toBe(0);
  });

  it("多条 LlmCall 时 lastInputTokens = 最新 createdAt 那行的 inputTokens", async () => {
    await service.record({
      sessionId: "s1",
      messageId: "m1",
      providerType: "x",
      model: "y",
      inputTokens: 100,
      outputTokens: 10,
      totalTokens: 110,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      reasoningTokens: 0,
      durationMs: 100,
    });
    await new Promise((r) => setTimeout(r, 5)); // 保证 createdAt 不同
    await service.record({
      sessionId: "s1",
      messageId: "m2",
      providerType: "x",
      model: "y",
      inputTokens: 250,
      outputTokens: 20,
      totalTokens: 270,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      reasoningTokens: 0,
      durationMs: 100,
    });
    const totals = await service.getSessionTotals("s1");
    expect(totals.lastInputTokens).toBe(250);
    expect(totals.inputTokens).toBe(350); // sum 仍正确
    expect(totals.callCount).toBe(2);
  });
});

describe("getLastBySession", () => {
  let ds: DataSource;
  let ctx: AccountContextService;
  let rawService: LlmCallService;
  let service: LlmCallService;

  beforeEach(async () => {
    ds = new DataSource({
      type: "better-sqlite3",
      database: ":memory:",
      entities: [LlmCall],
      synchronize: true,
    });
    await ds.initialize();
    ctx = new AccountContextService();
    const scopedFactory = new ScopedRepositoryFactory(ctx);
    rawService = new LlmCallService(ds.getRepository(LlmCall), scopedFactory);
    service = wrapInAccount(rawService, ctx, DEFAULT_USER);
  });

  afterEach(async () => {
    await ds.destroy();
  });

  it("空 session 返 null", async () => {
    expect(await service.getLastBySession("empty")).toBeNull();
  });

  it("有调用时返最新一行", async () => {
    await service.record({
      sessionId: "s2",
      messageId: "m1",
      providerType: "x",
      model: "y",
      inputTokens: 50,
      outputTokens: 5,
      totalTokens: 55,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      reasoningTokens: 0,
      durationMs: 10,
    });
    const row = await service.getLastBySession("s2");
    expect(row?.inputTokens).toBe(50);
  });
});
