import { AccountContextService } from "@meshbot/agent";
import { DataSource } from "typeorm";
import { ScopedRepositoryFactory } from "../account/scoped-repository.factory";
import { LlmCall } from "../entities/llm-call.entity";
import { Session } from "../entities/session.entity";
import { SessionMessage } from "../entities/session-message.entity";
import { LlmCallService } from "./llm-call.service";
import { SessionMessageService } from "./session-message.service";

/** 默认测试账号：作用域仓库要求每次调用都处于账号上下文内。 */
const DEFAULT_USER = "test-user";

describe("stats 聚合方法", () => {
  let ds: DataSource;
  let ctx: AccountContextService;
  let scopedFactory: ScopedRepositoryFactory;

  /** 在 DEFAULT_USER 账号上下文内构造作用域 SessionMessageService。 */
  function makeMsgService(): SessionMessageService {
    return new SessionMessageService(
      ds.getRepository(SessionMessage),
      scopedFactory,
      ctx,
    );
  }

  beforeEach(async () => {
    ds = new DataSource({
      type: "better-sqlite3",
      database: ":memory:",
      entities: [Session, SessionMessage, LlmCall],
      synchronize: true,
    });
    await ds.initialize();
    ctx = new AccountContextService();
    scopedFactory = new ScopedRepositoryFactory(ctx);
  });

  afterEach(async () => {
    await ds.destroy();
  });

  it("SessionMessageService.activitySince 按本地日/小时分桶", async () => {
    const repo = ds.getRepository(SessionMessage);
    await repo.insert([
      {
        id: "m1",
        sessionId: "s1",
        cloudUserId: DEFAULT_USER,
        role: "user",
        content: "a",
        reasoning: null,
        toolCalls: null,
        toolCallId: null,
        metadata: null,
        createdAt: new Date(2026, 4, 27, 18, 0),
      },
      {
        id: "m2",
        sessionId: "s1",
        cloudUserId: DEFAULT_USER,
        role: "assistant",
        content: "b",
        reasoning: null,
        toolCalls: null,
        toolCallId: null,
        metadata: null,
        createdAt: new Date(2026, 4, 27, 18, 30),
      },
      {
        id: "m3",
        sessionId: "s1",
        cloudUserId: DEFAULT_USER,
        role: "user",
        content: "c",
        reasoning: null,
        toolCalls: null,
        toolCallId: null,
        metadata: null,
        createdAt: new Date(2026, 4, 26, 9, 0),
      },
    ]);
    const svc = makeMsgService();
    const r = await ctx.run(DEFAULT_USER, () => svc.activitySince(null));
    expect(r.total).toBe(3);
    expect(r.byDate).toEqual([
      { date: "2026-05-26", count: 1 },
      { date: "2026-05-27", count: 2 },
    ]);
    expect(r.byHour[18]).toBe(2);
    expect(r.byHour[9]).toBe(1);
  });

  it("LlmCallService.sumTotalTokensSince / topModelSince", async () => {
    const repo = ds.getRepository(LlmCall);
    await repo.insert([
      {
        sessionId: "s1",
        messageId: "m1",
        cloudUserId: DEFAULT_USER,
        providerType: "openai",
        model: "gpt-4o",
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        reasoningTokens: 0,
        durationMs: 100,
        createdAt: new Date(2026, 4, 27, 18, 0),
      },
      {
        sessionId: "s1",
        messageId: "m2",
        cloudUserId: DEFAULT_USER,
        providerType: "openai",
        model: "gpt-4o",
        inputTokens: 20,
        outputTokens: 10,
        totalTokens: 30,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        reasoningTokens: 0,
        durationMs: 100,
        createdAt: new Date(2026, 4, 27, 18, 5),
      },
      {
        sessionId: "s1",
        messageId: "m3",
        cloudUserId: DEFAULT_USER,
        providerType: "anthropic",
        model: "claude",
        inputTokens: 1,
        outputTokens: 1,
        totalTokens: 2,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        reasoningTokens: 0,
        durationMs: 100,
        createdAt: new Date(2026, 4, 27, 18, 10),
      },
    ]);
    const svc = new LlmCallService(repo, scopedFactory);
    expect(
      await ctx.run(DEFAULT_USER, () => svc.sumTotalTokensSince(null)),
    ).toBe(47);
    expect(await ctx.run(DEFAULT_USER, () => svc.topModelSince(null))).toBe(
      "gpt-4o",
    );
  });

  it("空库：sum=0 / topModel=null / activity 全空", async () => {
    const mSvc = makeMsgService();
    const lSvc = new LlmCallService(ds.getRepository(LlmCall), scopedFactory);
    const a = await ctx.run(DEFAULT_USER, () => mSvc.activitySince(null));
    expect(a).toEqual({
      total: 0,
      byDate: [],
      byHour: Array.from({ length: 24 }, () => 0),
    });
    expect(
      await ctx.run(DEFAULT_USER, () => lSvc.sumTotalTokensSince(null)),
    ).toBe(0);
    expect(
      await ctx.run(DEFAULT_USER, () => lSvc.topModelSince(null)),
    ).toBeNull();
  });
});
