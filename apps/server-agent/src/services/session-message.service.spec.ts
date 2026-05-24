import { randomUUID } from "node:crypto";
import { NotFoundException } from "@nestjs/common";
import { DataSource } from "typeorm";
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
    for (const r of rows) {
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

  it("deleteAfter 删 createdAt > cutoff 的消息，cutoff 本身保留", async () => {
    await service.recordUser({ id: "u1", sessionId: "s1", content: "A" });
    await new Promise((r) => setTimeout(r, 10));
    await service.recordAssistant({
      id: "a1",
      sessionId: "s1",
      content: "B",
      reasoning: null,
    });
    await new Promise((r) => setTimeout(r, 10));
    await service.recordUser({ id: "u2", sessionId: "s1", content: "C" });
    const cutoffMsg = await service.findByIdOrFail("u1");
    await service.deleteAfter("s1", cutoffMsg.createdAt);
    const page = await service.listPage("s1", { limit: 10 });
    expect(page.messages.map((m) => m.id)).toEqual(["u1"]);
  });

  it("deleteAfter 不影响其他 session", async () => {
    await service.recordUser({ id: "x1", sessionId: "s1", content: "x" });
    await new Promise((r) => setTimeout(r, 10));
    await service.recordUser({ id: "y1", sessionId: "s2", content: "y" });
    const cutoff = await service.findByIdOrFail("x1");
    await service.deleteAfter("s1", cutoff.createdAt);
    const p = await service.listPage("s2", { limit: 10 });
    expect(p.messages.map((m) => m.id)).toEqual(["y1"]);
  });
});
