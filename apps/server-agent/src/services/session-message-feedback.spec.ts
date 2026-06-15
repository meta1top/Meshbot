import { AccountContextService } from "@meshbot/agent";
import { NotFoundException } from "@nestjs/common";
import { DataSource } from "typeorm";
import { ScopedRepositoryFactory } from "../account/scoped-repository.factory";
import { SessionMessage } from "../entities/session-message.entity";
import { SessionMessageService } from "./session-message.service";

/** 默认测试账号：作用域仓库要求每次调用都处于账号上下文内。 */
const DEFAULT_USER = "test-user";

describe("SessionMessageService.setFeedback", () => {
  let ds: DataSource;
  let ctx: AccountContextService;
  let rawSvc: SessionMessageService;
  /** 自动包 DEFAULT_USER 账号上下文的 service 代理。 */
  let svc: SessionMessageService;

  beforeEach(async () => {
    ds = new DataSource({
      type: "better-sqlite3",
      database: ":memory:",
      entities: [SessionMessage],
      synchronize: true,
    });
    await ds.initialize();
    const repo = ds.getRepository(SessionMessage);
    ctx = new AccountContextService();
    const scopedFactory = new ScopedRepositoryFactory(ctx);
    rawSvc = new SessionMessageService(repo, scopedFactory, ctx);
    svc = new Proxy(rawSvc, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (typeof value !== "function") return value;
        return (...args: unknown[]) =>
          ctx.run(DEFAULT_USER, () =>
            (value as (...a: unknown[]) => unknown).apply(target, args),
          );
      },
    });
    await repo.insert({
      id: "a1",
      sessionId: "s1",
      cloudUserId: DEFAULT_USER,
      role: "assistant",
      content: "hi",
      reasoning: null,
      toolCalls: null,
      toolCallId: null,
      metadata: null,
      createdAt: new Date(),
    });
  });

  afterEach(async () => {
    await ds.destroy();
  });

  it("设 up 写入 metadata，置 null 清空", async () => {
    await svc.setFeedback("s1", "a1", "up");
    let row = await svc.findByIdOrFail("a1");
    expect(JSON.parse(row.metadata as string)).toEqual({ feedback: "up" });

    await svc.setFeedback("s1", "a1", null);
    row = await svc.findByIdOrFail("a1");
    expect(row.metadata).toBeNull();
  });

  it("messageId 不属于该 session → NotFound", async () => {
    await expect(svc.setFeedback("other", "a1", "down")).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it("跨账号 setFeedback 不可改他人消息（NotFound）", async () => {
    await expect(
      ctx.run("intruder", () => rawSvc.setFeedback("s1", "a1", "down")),
    ).rejects.toBeInstanceOf(NotFoundException);
    // 原消息 metadata 未被改写
    const row = await svc.findByIdOrFail("a1");
    expect(row.metadata).toBeNull();
  });
});
