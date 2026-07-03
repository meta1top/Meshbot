import { randomUUID } from "node:crypto";
import { AccountContextService } from "@meshbot/agent";
import { NotFoundException } from "@nestjs/common";
import { DataSource } from "typeorm";
import { ScopedRepositoryFactory } from "../account/scoped-repository.factory";
import { SessionMessage } from "../entities/session-message.entity";
import { SessionMessageService } from "./session-message.service";

/** 默认测试账号：作用域仓库要求每次调用都处于账号上下文内。 */
const DEFAULT_USER = "test-user";

/**
 * 构建一个自动包账号上下文的 service 代理：每个方法调用都跑在指定账号上下文内，
 * 让既有单测无需逐一改写。隔离测试用 rawService + ctx.run 显式切账号。
 */
function wrapInAccount(
  target: SessionMessageService,
  ctx: AccountContextService,
  user: string,
): SessionMessageService {
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

describe("SessionMessageService", () => {
  let ds: DataSource;
  let ctx: AccountContextService;
  /** 真实 service（不包账号上下文，供 ctx.run 显式包裹的隔离测试用）。 */
  let rawService: SessionMessageService;
  /** 自动包 DEFAULT_USER 账号上下文的 service 代理，供既有单测复用。 */
  let service: SessionMessageService;

  beforeEach(async () => {
    ds = new DataSource({
      type: "better-sqlite3",
      database: ":memory:",
      entities: [SessionMessage],
      synchronize: true,
    });
    await ds.initialize();
    ctx = new AccountContextService();
    const scopedFactory = new ScopedRepositoryFactory(ctx);
    rawService = new SessionMessageService(
      ds.getRepository(SessionMessage),
      scopedFactory,
      ctx,
    );
    service = wrapInAccount(rawService, ctx, DEFAULT_USER);
  });

  afterEach(async () => {
    await ds.destroy();
  });

  /** 给测试生成稳定递增 createdAt：直接绕过 @CreateDateColumn，用 raw insert。 */
  async function seed(
    sessionId: string,
    rows: Array<{
      role: "user" | "assistant";
      content: string;
      offsetMs: number;
    }>,
    user: string = DEFAULT_USER,
  ): Promise<string[]> {
    const base = Date.now();
    const ids: string[] = [];
    let i = 0;
    for (const r of rows) {
      i += 1;
      const id = randomUUID();
      ids.push(id);
      await ds.getRepository(SessionMessage).insert({
        id,
        sessionId,
        cloudUserId: user,
        role: r.role,
        content: r.content,
        reasoning: null,
        toolCalls: null,
        toolCallId: null,
        seq: i,
        createdAt: new Date(base + r.offsetMs),
      });
    }
    return ids;
  }

  it("recordUser 写入 user 消息", async () => {
    await service.recordUser({ id: "u1", sessionId: "s1", content: "hi" });
    const row = await ds
      .getRepository(SessionMessage)
      .findOneBy({ langgraphId: "u1" });
    expect(row).toMatchObject({
      langgraphId: "u1",
      sessionId: "s1",
      cloudUserId: DEFAULT_USER,
      role: "user",
      content: "hi",
      reasoning: null,
    });
  });

  it("recordUser 重复 id 幂等（不抛、不覆盖）", async () => {
    await service.recordUser({ id: "u1", sessionId: "s1", content: "first" });
    await service.recordUser({ id: "u1", sessionId: "s1", content: "second" });
    const row = await ds
      .getRepository(SessionMessage)
      .findOneBy({ langgraphId: "u1" });
    expect(row?.content).toBe("first");
  });

  it("recordAssistant 写入 assistant + reasoning", async () => {
    await service.recordAssistant({
      id: "a1",
      sessionId: "s1",
      content: "你好",
      reasoning: "thinking...",
    });
    const row = await ds
      .getRepository(SessionMessage)
      .findOneBy({ langgraphId: "a1" });
    expect(row).toMatchObject({
      role: "assistant",
      content: "你好",
      reasoning: "thinking...",
    });
  });

  it("recordAssistant：session_messages.id 等于传入的 langgraphId（不再另铸雪花）", async () => {
    await service.recordAssistant({
      id: "900000000000000123",
      sessionId: "s1",
      content: "hi",
      reasoning: null,
    });
    const row = await ds
      .getRepository(SessionMessage)
      .findOneBy({ langgraphId: "900000000000000123" });
    expect(row?.id).toBe("900000000000000123");
  });

  it("recordUser 按调用顺序分配会话内递增 seq（1,2,3）", async () => {
    await service.recordUser({ id: "u1", sessionId: "s1", content: "a" });
    await service.recordUser({ id: "u2", sessionId: "s1", content: "b" });
    await service.recordUser({ id: "u3", sessionId: "s1", content: "c" });
    const rows = await ds
      .getRepository(SessionMessage)
      .find({ where: { sessionId: "s1" }, order: { seq: "ASC" } });
    expect(rows.map((r) => [r.langgraphId, r.seq])).toEqual([
      ["u1", 1],
      ["u2", 2],
      ["u3", 3],
    ]);
  });

  it("seq 按 session 独立计数", async () => {
    await service.recordUser({ id: "a1", sessionId: "sA", content: "a" });
    await service.recordUser({ id: "b1", sessionId: "sB", content: "b" });
    await service.recordUser({ id: "a2", sessionId: "sA", content: "c" });
    const a = await ds
      .getRepository(SessionMessage)
      .findOneBy({ langgraphId: "a2" });
    const b = await ds
      .getRepository(SessionMessage)
      .findOneBy({ langgraphId: "b1" });
    expect(a?.seq).toBe(2);
    expect(b?.seq).toBe(1);
  });

  it("recordAssistant / recordToolResult 也分配 seq（接续 max+1）", async () => {
    await service.recordUser({ id: "u1", sessionId: "s1", content: "q" });
    await service.recordAssistant({
      id: "a1",
      sessionId: "s1",
      content: "ans",
      reasoning: null,
    });
    await service.recordToolResult({
      id: "tc1",
      sessionId: "s1",
      toolCallId: "tc1",
      content: "r",
    });
    const a = await ds
      .getRepository(SessionMessage)
      .findOneBy({ langgraphId: "a1" });
    const t = await ds
      .getRepository(SessionMessage)
      .findOneBy({ langgraphId: "tc1" });
    expect(a?.seq).toBe(2);
    expect(t?.seq).toBe(3);
  });

  it("回归：createdAt 相同也按 seq 稳定排序（修复批量注入时序错乱）", async () => {
    const same = new Date();
    const order = ["m1", "m2", "m3", "m4"];
    // 故意打乱物理插入顺序，但 seq 反映真实 emit 顺序
    for (const content of [order[2], order[0], order[3], order[1]]) {
      const seq = order.indexOf(content) + 1;
      await ds.getRepository(SessionMessage).insert({
        id: randomUUID(),
        sessionId: "s1",
        cloudUserId: DEFAULT_USER,
        role: seq % 2 === 1 ? "user" : "assistant",
        content,
        reasoning: null,
        toolCalls: null,
        toolCallId: null,
        seq,
        createdAt: same,
      });
    }
    const res = await service.listPage("s1", { limit: 10 });
    expect(res.messages.map((m) => m.content)).toEqual(order);
  });

  it("listPage 无 before 返最新 N 条 + hasMore=true（>N 条数据）", async () => {
    await seed("s1", [
      { role: "user", content: "m1", offsetMs: 0 },
      { role: "assistant", content: "m2", offsetMs: 1 },
      { role: "user", content: "m3", offsetMs: 2 },
      { role: "assistant", content: "m4", offsetMs: 3 },
    ]);
    const res = await service.listPage("s1", { limit: 2 });
    expect(res.messages.map((m) => m.content)).toEqual(["m3", "m4"]);
    expect(res.hasMore).toBe(true);
  });

  it("listPage 有 before 返 before 之前的 N 条", async () => {
    const msgIds = await seed("s1", [
      { role: "user", content: "m1", offsetMs: 0 },
      { role: "assistant", content: "m2", offsetMs: 1 },
      { role: "user", content: "m3", offsetMs: 2 },
      { role: "assistant", content: "m4", offsetMs: 3 },
    ]);
    // 从 seed 返回的是随机 UUID，用作 id。listPage 的 before 参数需要 id。
    // before = m3（index 2）→ 应返 [m1, m2]
    const res = await service.listPage("s1", { before: msgIds[2], limit: 10 });
    expect(res.messages.map((m) => m.content)).toEqual(["m1", "m2"]);
    expect(res.hasMore).toBe(false);
  });

  it("listPage hasMore=false 当剩余 <= limit", async () => {
    await seed("s1", [
      { role: "user", content: "m1", offsetMs: 0 },
      { role: "assistant", content: "m2", offsetMs: 1 },
    ]);
    const res = await service.listPage("s1", { limit: 10 });
    expect(res.messages.map((m) => m.content)).toEqual(["m1", "m2"]);
    expect(res.hasMore).toBe(false);
  });

  it("listPage before 指向不属于 session 的 id → NotFoundException（防越权）", async () => {
    const aMsgIds = await seed("sA", [
      { role: "user", content: "in-a", offsetMs: 0 },
    ]);
    await seed("sB", [{ role: "user", content: "in-b", offsetMs: 0 }]);
    await expect(
      service.listPage("sB", { before: aMsgIds[0], limit: 10 }),
    ).rejects.toThrow(NotFoundException);
  });

  it("recordToolResult 写入 role=tool 行，langgraphId = toolCallId", async () => {
    await service.recordToolResult({
      id: "tc1",
      sessionId: "s1",
      toolCallId: "tc1",
      content: "result text",
    });
    const row = await ds
      .getRepository(SessionMessage)
      .findOneBy({ langgraphId: "tc1" });
    expect(row).toMatchObject({
      langgraphId: "tc1",
      sessionId: "s1",
      role: "tool",
      content: "result text",
      toolCallId: "tc1",
    });
  });

  it("recordToolResult ok=true / 缺省 → metadata 为 null（兼容老数据）", async () => {
    await service.recordToolResult({
      id: "tc-ok",
      sessionId: "s1",
      toolCallId: "tc-ok",
      content: "ok result",
      ok: true,
    });
    const row = await ds
      .getRepository(SessionMessage)
      .findOneBy({ langgraphId: "tc-ok" });
    expect(row?.metadata).toBeNull();
  });

  it("recordToolResult ok=false → metadata 写 {ok:false}（前端红色失败态来源）", async () => {
    await service.recordToolResult({
      id: "tc-err",
      sessionId: "s1",
      toolCallId: "tc-err",
      content: "Error: bad args",
      ok: false,
    });
    const row = await ds
      .getRepository(SessionMessage)
      .findOneBy({ langgraphId: "tc-err" });
    expect(row?.metadata).toBe(JSON.stringify({ ok: false }));
  });

  it("recordToolResult 重复 id 幂等", async () => {
    await service.recordToolResult({
      id: "tc1",
      sessionId: "s1",
      toolCallId: "tc1",
      content: "first",
    });
    await service.recordToolResult({
      id: "tc1",
      sessionId: "s1",
      toolCallId: "tc1",
      content: "second",
    });
    const row = await ds
      .getRepository(SessionMessage)
      .findOneBy({ langgraphId: "tc1" });
    expect(row?.content).toBe("first");
  });

  it("recordAssistant 可附带 toolCalls JSON 字符串", async () => {
    const calls = [{ id: "tc1", name: "echo", args: { text: "hi" } }];
    await service.recordAssistant({
      id: "a1",
      sessionId: "s1",
      content: "calling echo",
      reasoning: null,
      toolCalls: JSON.stringify(calls),
    });
    const row = await ds
      .getRepository(SessionMessage)
      .findOneBy({ langgraphId: "a1" });
    expect(row?.toolCalls).toBe(JSON.stringify(calls));
  });

  it("recordCompactionPlaceholder 写 role=system + metadata kind=compaction", async () => {
    await service.recordCompactionPlaceholder({
      id: "comp-1",
      sessionId: "s1",
      summary: "用户问了 X，已尝试 Y",
      removedCount: 5,
      fromMessageId: "m1",
      toMessageId: "m5",
    });
    const row = await ds
      .getRepository(SessionMessage)
      .findOneBy({ langgraphId: "comp-1" });
    expect(row?.role).toBe("system");
    expect(row?.content).toBe("用户问了 X，已尝试 Y");
    expect(row?.cloudUserId).toBe(DEFAULT_USER);
    expect(JSON.parse(row?.metadata as string)).toEqual({
      kind: "compaction",
      removedCount: 5,
      fromMessageId: "m1",
      toMessageId: "m5",
    });
  });

  it("recordCompactionPlaceholder id 已存在视为幂等成功，不重复 insert", async () => {
    await service.recordCompactionPlaceholder({
      id: "comp-1",
      sessionId: "s1",
      summary: "first",
      removedCount: 1,
      fromMessageId: "a",
      toMessageId: "b",
    });
    await service.recordCompactionPlaceholder({
      id: "comp-1",
      sessionId: "s1",
      summary: "second",
      removedCount: 2,
      fromMessageId: "c",
      toMessageId: "d",
    });
    const rows = await ds
      .getRepository(SessionMessage)
      .findBy({ langgraphId: "comp-1" });
    expect(rows).toHaveLength(1);
    expect(rows[0].content).toBe("first");
  });

  it("existingIds 只返回本会话内确实存在的 id", async () => {
    await service.recordUser({ id: "u1", sessionId: "s1", content: "a" });
    await service.recordUser({ id: "u2", sessionId: "s1", content: "b" });
    await service.recordUser({ id: "other", sessionId: "s2", content: "c" });
    const got = await service.existingIds("s1", ["u1", "u2", "nope", "other"]);
    expect([...got].sort()).toEqual(["u1", "u2"]);
  });

  it("existingIds 空入参返回空集合", async () => {
    const got = await service.existingIds("s1", []);
    expect(got.size).toBe(0);
  });

  describe("findLastAssistant", () => {
    it("用例 A：多条消息含 assistant 时返回末条 assistant 的 content", async () => {
      const sessionId = randomUUID();
      await seed(sessionId, [
        { role: "user", content: "第一条用户消息", offsetMs: 0 },
        { role: "assistant", content: "第一条助手回复", offsetMs: 1 },
        { role: "user", content: "第二条用户消息", offsetMs: 2 },
        { role: "assistant", content: "第二条助手回复（末条）", offsetMs: 3 },
      ]);
      const result = await service.findLastAssistant(sessionId);
      expect(result).not.toBeNull();
      expect(result?.content).toBe("第二条助手回复（末条）");
    });

    it("用例 B：会话无 assistant 消息时返回 null", async () => {
      const sessionId = randomUUID();
      await seed(sessionId, [
        { role: "user", content: "只有用户消息", offsetMs: 0 },
      ]);
      const result = await service.findLastAssistant(sessionId);
      expect(result).toBeNull();
    });
  });

  it("updateToolResult 按 toolCallId 重写 tool 行 content，返回受影响行数", async () => {
    const sid = "990000000000000020";
    await service.recordToolResult({
      id: "tc-x",
      sessionId: sid,
      toolCallId: "tc-x",
      content: '{"status":"running"}',
      ok: true,
    });
    const n = await service.updateToolResult(
      "tc-x",
      '{"status":"done","output":"ok"}',
    );
    expect(n).toBe(1);
    const row = await ds
      .getRepository(SessionMessage)
      .findOneBy({ toolCallId: "tc-x" });
    expect(row?.content).toBe('{"status":"done","output":"ok"}');
    expect(await service.updateToolResult("tc-404", "{}")).toBe(0);
  });

  it("deleteBySession 删该会话全部消息", async () => {
    await service.recordUser({ id: "u1", sessionId: "s1", content: "a" });
    await service.recordUser({ id: "u2", sessionId: "s2", content: "b" });
    await service.deleteBySession("s1");
    const p1 = await service.listPage("s1", { limit: 10 });
    const p2 = await service.listPage("s2", { limit: 10 });
    expect(p1.messages).toHaveLength(0);
    expect(p2.messages).toHaveLength(1);
  });

  it("activitySince（since=null）统计本账号全部消息", async () => {
    await service.recordUser({ id: "u1", sessionId: "s1", content: "a" });
    await service.recordUser({ id: "u2", sessionId: "s1", content: "b" });
    const stats = await service.activitySince(null);
    expect(stats.total).toBe(2);
    expect(stats.byDate.reduce((s, c) => s + c.count, 0)).toBe(2);
    expect(stats.byHour.reduce((s, c) => s + c, 0)).toBe(2);
  });

  describe("账号隔离（ScopedRepository）", () => {
    it("两账号同 session 的消息互不可见（getHistory / listPage）", async () => {
      await ctx.run("u1", () =>
        rawService.recordUser({ id: "m-u1", sessionId: "s1", content: "u1" }),
      );
      await ctx.run("u2", () =>
        rawService.recordUser({ id: "m-u2", sessionId: "s1", content: "u2" }),
      );
      const pageU1 = await ctx.run("u1", () =>
        rawService.listPage("s1", { limit: 10 }),
      );
      expect(pageU1.messages.map((m) => m.content)).toEqual(["u1"]);
      const pageU2 = await ctx.run("u2", () =>
        rawService.listPage("s1", { limit: 10 }),
      );
      expect(pageU2.messages.map((m) => m.content)).toEqual(["u2"]);
    });

    it("seq 按账号+会话独立计数（账号 A 的消息不影响账号 B 的 seq）", async () => {
      // u1 在 s1 写 3 条 → seq 1,2,3
      await ctx.run("u1", async () => {
        await rawService.recordUser({
          id: "a1",
          sessionId: "s1",
          content: "1",
        });
        await rawService.recordUser({
          id: "a2",
          sessionId: "s1",
          content: "2",
        });
        await rawService.recordUser({
          id: "a3",
          sessionId: "s1",
          content: "3",
        });
      });
      // u2 在同一个 s1 首次写入 → seq 必须从 1 起，不被 u1 的 3 条带高
      await ctx.run("u2", () =>
        rawService.recordUser({ id: "b1", sessionId: "s1", content: "b1" }),
      );
      const b1 = await ds
        .getRepository(SessionMessage)
        .findOneBy({ langgraphId: "b1" });
      expect(b1?.seq).toBe(1);
      // u1 续写仍接 max+1 = 4
      await ctx.run("u1", () =>
        rawService.recordUser({ id: "a4", sessionId: "s1", content: "4" }),
      );
      const a4 = await ds
        .getRepository(SessionMessage)
        .findOneBy({ langgraphId: "a4" });
      expect(a4?.seq).toBe(4);
    });

    it("跨账号消息不可见：findByIdOrFail 取他人消息抛 NotFound", async () => {
      await ctx.run("u1", () =>
        rawService.recordUser({ id: "owned", sessionId: "s1", content: "x" }),
      );
      const u1Row = await ctx.run("u1", async () => {
        const row = await ds
          .getRepository(SessionMessage)
          .findOneBy({ langgraphId: "owned" });
        if (!row) throw new Error("u1Row not found");
        return row;
      });
      const u1Id = u1Row.id;
      await expect(
        ctx.run("u2", () => rawService.findByIdOrFail(u1Id)),
      ).rejects.toThrow(NotFoundException);
      // 同账号仍可见，确认不是假阴性
      const r = await ctx.run("u1", () => rawService.findByIdOrFail(u1Id));
      expect(r.langgraphId).toBe("owned");
    });

    it("activitySince 只统计本账号消息（两账号不串台）", async () => {
      await ctx.run("u1", async () => {
        await rawService.recordUser({
          id: "a1",
          sessionId: "s1",
          content: "1",
        });
        await rawService.recordUser({
          id: "a2",
          sessionId: "s1",
          content: "2",
        });
      });
      await ctx.run("u2", () =>
        rawService.recordUser({ id: "b1", sessionId: "s1", content: "1" }),
      );
      const u1Stats = await ctx.run("u1", () => rawService.activitySince(null));
      expect(u1Stats.total).toBe(2);
      const u2Stats = await ctx.run("u2", () => rawService.activitySince(null));
      expect(u2Stats.total).toBe(1);
    });

    it("listPage（含 round-up 的 tool 查询）绝不捞回他账号的 tool 行", async () => {
      // u1 同会话：assistant + 其 tool result
      await ctx.run("u1", async () => {
        await rawService.recordAssistant({
          id: "a-u1",
          sessionId: "s1",
          content: "calling",
          reasoning: null,
        });
        await rawService.recordToolResult({
          id: "t-u1",
          sessionId: "s1",
          toolCallId: "t-u1",
          content: "u1 tool",
        });
      });
      // u2: 同会话也有一条 tool 行，账号过滤（含 round-up 子查询的 cloud_user_id）
      // 必须把它挡在 u1 的视图之外。
      await ctx.run("u2", () =>
        rawService.recordToolResult({
          id: "t-u2",
          sessionId: "s1",
          toolCallId: "t-u2",
          content: "u2 tool",
        }),
      );
      const page = await ctx.run("u1", () =>
        rawService.listPage("s1", { limit: 10 }),
      );
      const langgraphIds = page.messages
        .map((m) => m.langgraphId)
        .filter((id) => id !== null);
      expect(langgraphIds.sort()).toEqual(["a-u1", "t-u1"]);
      expect(langgraphIds).not.toContain("t-u2");
    });

    it("无账号上下文调用作用域方法抛错", async () => {
      await expect(
        rawService.recordUser({ id: "x", sessionId: "s1", content: "x" }),
      ).rejects.toThrow();
    });
  });
});

describe("findByIdOrFail / deleteAfter", () => {
  let ds: DataSource;
  let ctx: AccountContextService;
  let service: SessionMessageService;

  beforeEach(async () => {
    ds = new DataSource({
      type: "better-sqlite3",
      database: ":memory:",
      entities: [SessionMessage],
      synchronize: true,
    });
    await ds.initialize();
    ctx = new AccountContextService();
    const scopedFactory = new ScopedRepositoryFactory(ctx);
    const raw = new SessionMessageService(
      ds.getRepository(SessionMessage),
      scopedFactory,
      ctx,
    );
    service = wrapInAccount(raw, ctx, DEFAULT_USER);
  });

  afterEach(async () => {
    await ds.destroy();
  });

  it("findByIdOrFail 不存在抛 NotFoundException", async () => {
    await expect(service.findByIdOrFail("nope")).rejects.toThrow(
      NotFoundException,
    );
  });

  it("findByIdOrFail 存在返回 entity", async () => {
    await service.recordUser({ id: "u1", sessionId: "s1", content: "a" });
    const row = await ds
      .getRepository(SessionMessage)
      .findOneBy({ langgraphId: "u1" });
    if (!row) throw new Error("u1 not found");
    const r = await service.findByIdOrFail(row.id);
    expect(r.langgraphId).toBe("u1");
    expect(r.content).toBe("a");
  });

  it("deleteAfter 删 seq > cutoff 的消息，cutoff 本身保留", async () => {
    await service.recordUser({ id: "u1", sessionId: "s1", content: "A" });
    await service.recordAssistant({
      id: "a1",
      sessionId: "s1",
      content: "B",
      reasoning: null,
    });
    await service.recordUser({ id: "u2", sessionId: "s1", content: "C" });
    const u1Row = await ds
      .getRepository(SessionMessage)
      .findOneBy({ langgraphId: "u1" });
    if (!u1Row) throw new Error("u1 not found");
    const cutoffMsg = await service.findByIdOrFail(u1Row.id);
    await service.deleteAfter("s1", cutoffMsg.seq);
    const page = await service.listPage("s1", { limit: 10 });
    expect(page.messages.map((m) => m.langgraphId)).toEqual(["u1"]);
  });

  it("deleteAfter 不影响其他 session", async () => {
    await service.recordUser({ id: "x1", sessionId: "s1", content: "x" });
    await service.recordUser({ id: "y1", sessionId: "s2", content: "y" });
    const x1Row = await ds
      .getRepository(SessionMessage)
      .findOneBy({ langgraphId: "x1" });
    if (!x1Row) throw new Error("x1 not found");
    const cutoff = await service.findByIdOrFail(x1Row.id);
    await service.deleteAfter("s1", cutoff.seq);
    const p = await service.listPage("s2", { limit: 10 });
    expect(p.messages.map((m) => m.langgraphId)).toEqual(["y1"]);
  });
});
