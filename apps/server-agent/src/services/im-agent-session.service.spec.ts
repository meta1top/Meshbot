import { AccountContextService } from "@meshbot/agent";
import { DataSource } from "typeorm";
import { ImAgentSession } from "../entities/im-agent-session.entity";
import { ImAgentSessionService } from "./im-agent-session.service";
import { ScopedRepositoryFactory } from "../account/scoped-repository.factory";

describe("ImAgentSessionService", () => {
  let ds: DataSource;
  let ctx: AccountContextService;
  let service: ImAgentSessionService;

  beforeEach(async () => {
    ds = new DataSource({
      type: "better-sqlite3",
      database: ":memory:",
      entities: [ImAgentSession],
      synchronize: true,
    });
    await ds.initialize();
    ctx = new AccountContextService();
    const rawRepo = ds.getRepository(ImAgentSession);
    const factory = new ScopedRepositoryFactory(ctx);
    service = new ImAgentSessionService(rawRepo, factory);
  });

  afterEach(async () => {
    await ds.destroy();
  });

  it("create 新建会话映射，自动盖章当前账号", async () => {
    const convId = "conv123";
    const sessId = "sess456";
    const result = await ctx.run("user1", () => service.create(convId, sessId));

    expect(result.conversationId).toBe(convId);
    expect(result.sessionId).toBe(sessId);
    expect(result.cloudUserId).toBe("user1");
    expect(result.lastProcessedMessageId).toBeNull();
  });

  it("findByConversation 查到当前账号的映射", async () => {
    const convId = "conv123";
    const sessId = "sess456";
    await ctx.run("user1", () => service.create(convId, sessId));

    const found = await ctx.run("user1", () =>
      service.findByConversation(convId),
    );

    expect(found).toBeTruthy();
    expect(found?.conversationId).toBe(convId);
    expect(found?.sessionId).toBe(sessId);
  });

  it("findByConversation 他账号的映射不可见", async () => {
    const convId = "conv123";
    const sessId = "sess456";
    await ctx.run("user1", () => service.create(convId, sessId));

    const found = await ctx.run("user2", () =>
      service.findByConversation(convId),
    );

    expect(found).toBeNull();
  });

  it("advanceCursor 推进处理游标", async () => {
    const convId = "conv123";
    const sessId = "sess456";
    const msgId = "msg789";

    await ctx.run("user1", () => service.create(convId, sessId));
    await ctx.run("user1", () => service.advanceCursor(convId, msgId));

    const found = await ctx.run("user1", () =>
      service.findByConversation(convId),
    );
    expect(found?.lastProcessedMessageId).toBe(msgId);
  });

  it("getCursor 取处理游标（已设置）", async () => {
    const convId = "conv123";
    const sessId = "sess456";
    const msgId = "msg789";

    await ctx.run("user1", () => service.create(convId, sessId));
    await ctx.run("user1", () => service.advanceCursor(convId, msgId));

    const cursor = await ctx.run("user1", () => service.getCursor(convId));
    expect(cursor).toBe(msgId);
  });

  it("getCursor 未设置游标返回 null", async () => {
    const convId = "conv123";
    const sessId = "sess456";

    await ctx.run("user1", () => service.create(convId, sessId));

    const cursor = await ctx.run("user1", () => service.getCursor(convId));
    expect(cursor).toBeNull();
  });

  it("getCursor 他账号的游标不可见", async () => {
    const convId = "conv123";
    const sessId = "sess456";
    const msgId = "msg789";

    await ctx.run("user1", () => service.create(convId, sessId));
    await ctx.run("user1", () => service.advanceCursor(convId, msgId));

    const cursor = await ctx.run("user2", () => service.getCursor(convId));
    expect(cursor).toBeNull();
  });

  it("advanceCursor 只影响当前账号的映射（账号隔离）", async () => {
    const convId = "conv123";

    // user1 创建映射
    await ctx.run("user1", () => service.create(convId, "sess1"));

    // user2 尝试推进同一个 convId 的游标（应无效）
    await ctx.run("user2", () => service.advanceCursor(convId, "msg_from_u2"));

    // user1 的游标应为 null（未被修改）
    const cursor = await ctx.run("user1", () => service.getCursor(convId));
    expect(cursor).toBeNull();
  });

  it("advanceAppended 推进 append 游标", async () => {
    const convId = "conv123";
    const sessId = "sess456";
    const msgId = "msg789";

    await ctx.run("user1", () => service.create(convId, sessId));
    await ctx.run("user1", () => service.advanceAppended(convId, msgId));

    const appended = await ctx.run("user1", () => service.getAppended(convId));
    expect(appended).toBe(msgId);
  });

  it("getAppended 未设置时返回 null", async () => {
    const convId = "conv123";
    const sessId = "sess456";

    await ctx.run("user1", () => service.create(convId, sessId));

    const appended = await ctx.run("user1", () => service.getAppended(convId));
    expect(appended).toBeNull();
  });

  it("getAppended 他账号的 append 游标不可见", async () => {
    const convId = "conv123";
    const sessId = "sess456";
    const msgId = "msg789";

    await ctx.run("user1", () => service.create(convId, sessId));
    await ctx.run("user1", () => service.advanceAppended(convId, msgId));

    const appended = await ctx.run("user2", () => service.getAppended(convId));
    expect(appended).toBeNull();
  });

  it("append 游标与处理游标相互独立", async () => {
    const convId = "conv123";
    const sessId = "sess456";

    await ctx.run("user1", () => service.create(convId, sessId));
    await ctx.run("user1", () =>
      service.advanceAppended(convId, "msg-appended"),
    );

    // 只推进了 append 游标，处理游标应仍为 null
    const cursor = await ctx.run("user1", () => service.getCursor(convId));
    expect(cursor).toBeNull();
    const appended = await ctx.run("user1", () => service.getAppended(convId));
    expect(appended).toBe("msg-appended");
  });

  it("create 与 findByConversation 一致性", async () => {
    const convId = "conv123";
    const sessId = "sess456";

    const created = await ctx.run("user1", () =>
      service.create(convId, sessId),
    );

    const found = await ctx.run("user1", () =>
      service.findByConversation(convId),
    );

    expect(found?.id).toBe(created.id);
    expect(found?.conversationId).toBe(created.conversationId);
    expect(found?.sessionId).toBe(created.sessionId);
  });
});
