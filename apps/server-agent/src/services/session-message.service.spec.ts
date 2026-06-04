import { randomUUID } from "node:crypto";
import { NotFoundException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import { DataSource, type Repository } from "typeorm";
import { SessionMessage } from "../entities/session-message.entity";
import { SessionMessageService } from "./session-message.service";

describe("SessionMessageService", () => {
  let ds: DataSource;
  let service: SessionMessageService;

  beforeEach(async () => {
    ds = new DataSource({
      type: "better-sqlite3",
      database: ":memory:",
      entities: [SessionMessage],
      synchronize: true,
    });
    await ds.initialize();
    service = new SessionMessageService(ds.getRepository(SessionMessage));
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
    const row = await ds.getRepository(SessionMessage).findOneBy({ id: "u1" });
    expect(row).toMatchObject({
      id: "u1",
      sessionId: "s1",
      role: "user",
      content: "hi",
      reasoning: null,
    });
  });

  it("recordUser 重复 id 幂等（不抛、不覆盖）", async () => {
    await service.recordUser({ id: "u1", sessionId: "s1", content: "first" });
    await service.recordUser({ id: "u1", sessionId: "s1", content: "second" });
    const row = await ds.getRepository(SessionMessage).findOneBy({ id: "u1" });
    expect(row?.content).toBe("first");
  });

  it("recordAssistant 写入 assistant + reasoning", async () => {
    await service.recordAssistant({
      id: "a1",
      sessionId: "s1",
      content: "你好",
      reasoning: "thinking...",
    });
    const row = await ds.getRepository(SessionMessage).findOneBy({ id: "a1" });
    expect(row).toMatchObject({
      role: "assistant",
      content: "你好",
      reasoning: "thinking...",
    });
  });

  it("recordUser 按调用顺序分配会话内递增 seq（1,2,3）", async () => {
    await service.recordUser({ id: "u1", sessionId: "s1", content: "a" });
    await service.recordUser({ id: "u2", sessionId: "s1", content: "b" });
    await service.recordUser({ id: "u3", sessionId: "s1", content: "c" });
    const rows = await ds
      .getRepository(SessionMessage)
      .find({ where: { sessionId: "s1" }, order: { seq: "ASC" } });
    expect(rows.map((r) => [r.id, r.seq])).toEqual([
      ["u1", 1],
      ["u2", 2],
      ["u3", 3],
    ]);
  });

  it("seq 按 session 独立计数", async () => {
    await service.recordUser({ id: "a1", sessionId: "sA", content: "a" });
    await service.recordUser({ id: "b1", sessionId: "sB", content: "b" });
    await service.recordUser({ id: "a2", sessionId: "sA", content: "c" });
    const a = await ds.getRepository(SessionMessage).findOneBy({ id: "a2" });
    const b = await ds.getRepository(SessionMessage).findOneBy({ id: "b1" });
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
    const a = await ds.getRepository(SessionMessage).findOneBy({ id: "a1" });
    const t = await ds.getRepository(SessionMessage).findOneBy({ id: "tc1" });
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
    const ids = await seed("s1", [
      { role: "user", content: "m1", offsetMs: 0 },
      { role: "assistant", content: "m2", offsetMs: 1 },
      { role: "user", content: "m3", offsetMs: 2 },
      { role: "assistant", content: "m4", offsetMs: 3 },
    ]);
    // before = m3（index 2）→ 应返 [m1, m2]
    const res = await service.listPage("s1", { before: ids[2], limit: 10 });
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
    const aIds = await seed("sA", [
      { role: "user", content: "in-a", offsetMs: 0 },
    ]);
    await seed("sB", [{ role: "user", content: "in-b", offsetMs: 0 }]);
    await expect(
      service.listPage("sB", { before: aIds[0], limit: 10 }),
    ).rejects.toThrow(NotFoundException);
  });

  it("recordToolResult 写入 role=tool 行，id = toolCallId", async () => {
    await service.recordToolResult({
      id: "tc1",
      sessionId: "s1",
      toolCallId: "tc1",
      content: "result text",
    });
    const row = await ds.getRepository(SessionMessage).findOneBy({ id: "tc1" });
    expect(row).toMatchObject({
      id: "tc1",
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
      .findOneBy({ id: "tc-ok" });
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
      .findOneBy({ id: "tc-err" });
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
    const row = await ds.getRepository(SessionMessage).findOneBy({ id: "tc1" });
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
    const row = await ds.getRepository(SessionMessage).findOneBy({ id: "a1" });
    expect(row?.toolCalls).toBe(JSON.stringify(calls));
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

  it("deleteBySession 删该会话全部消息", async () => {
    await service.recordUser({ id: "u1", sessionId: "s1", content: "a" });
    await service.recordUser({ id: "u2", sessionId: "s2", content: "b" });
    await service.deleteBySession("s1");
    const p1 = await service.listPage("s1", { limit: 10 });
    const p2 = await service.listPage("s2", { limit: 10 });
    expect(p1.messages).toHaveLength(0);
    expect(p2.messages).toHaveLength(1);
  });
});

describe("findByIdOrFail / deleteAfter", () => {
  let ds: DataSource;
  let service: SessionMessageService;

  beforeEach(async () => {
    ds = new DataSource({
      type: "better-sqlite3",
      database: ":memory:",
      entities: [SessionMessage],
      synchronize: true,
    });
    await ds.initialize();
    service = new SessionMessageService(ds.getRepository(SessionMessage));
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
    const r = await service.findByIdOrFail("u1");
    expect(r.id).toBe("u1");
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
    const cutoffMsg = await service.findByIdOrFail("u1");
    await service.deleteAfter("s1", cutoffMsg.seq);
    const page = await service.listPage("s1", { limit: 10 });
    expect(page.messages.map((m) => m.id)).toEqual(["u1"]);
  });

  it("deleteAfter 不影响其他 session", async () => {
    await service.recordUser({ id: "x1", sessionId: "s1", content: "x" });
    await service.recordUser({ id: "y1", sessionId: "s2", content: "y" });
    const cutoff = await service.findByIdOrFail("x1");
    await service.deleteAfter("s1", cutoff.seq);
    const p = await service.listPage("s2", { limit: 10 });
    expect(p.messages.map((m) => m.id)).toEqual(["y1"]);
  });
});

describe("SessionMessageService.recordCompactionPlaceholder", () => {
  let service: SessionMessageService;
  let repo: jest.Mocked<Repository<SessionMessage>>;

  /** QueryBuilder 链 mock；values 入参用于断言。 */
  let qb: {
    insert: jest.Mock;
    into: jest.Mock;
    values: jest.Mock;
    setParameter: jest.Mock;
    execute: jest.Mock;
  };

  beforeEach(async () => {
    qb = {
      insert: jest.fn().mockReturnThis(),
      into: jest.fn().mockReturnThis(),
      values: jest.fn().mockReturnThis(),
      setParameter: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue({}),
    };
    repo = {
      findOneBy: jest.fn(),
      createQueryBuilder: jest.fn().mockReturnValue(qb),
    } as unknown as jest.Mocked<Repository<SessionMessage>>;
    const moduleRef = await Test.createTestingModule({
      providers: [
        SessionMessageService,
        { provide: getRepositoryToken(SessionMessage), useValue: repo },
      ],
    }).compile();
    service = moduleRef.get(SessionMessageService);
  });

  it("插入一行 role=system + content=summary + metadata JSON", async () => {
    repo.findOneBy.mockResolvedValue(null);
    await service.recordCompactionPlaceholder({
      id: "comp-1",
      sessionId: "s1",
      summary: "用户问了 X，已尝试 Y",
      removedCount: 5,
      fromMessageId: "m1",
      toMessageId: "m5",
    });
    expect(qb.values).toHaveBeenCalledTimes(1);
    const arg = qb.values.mock.calls[0][0] as Partial<SessionMessage>;
    expect(arg.id).toBe("comp-1");
    expect(arg.sessionId).toBe("s1");
    expect(arg.role).toBe("system");
    expect(arg.content).toBe("用户问了 X，已尝试 Y");
    const meta = JSON.parse(arg.metadata as string);
    expect(meta).toEqual({
      kind: "compaction",
      removedCount: 5,
      fromMessageId: "m1",
      toMessageId: "m5",
    });
  });

  it("id 已存在视为幂等成功，不重复 insert", async () => {
    repo.findOneBy.mockResolvedValue({ id: "comp-1" } as SessionMessage);
    await service.recordCompactionPlaceholder({
      id: "comp-1",
      sessionId: "s1",
      summary: "x",
      removedCount: 1,
      fromMessageId: "a",
      toMessageId: "b",
    });
    expect(qb.values).not.toHaveBeenCalled();
  });
});
