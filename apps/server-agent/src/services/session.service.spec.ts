import { randomUUID } from "node:crypto";
import { ConflictException, NotFoundException } from "@nestjs/common";
import { DataSource } from "typeorm";
import { LlmCall } from "../entities/llm-call.entity";
import { PendingMessage } from "../entities/pending-message.entity";
import { Session } from "../entities/session.entity";
import { SessionMessage } from "../entities/session-message.entity";
import { CheckpointerCleanupService } from "./checkpointer-cleanup.service";
import { LlmCallService } from "./llm-call.service";
import { SessionMessageService } from "./session-message.service";
import { SessionService } from "./session.service";

describe("SessionService", () => {
  let ds: DataSource;
  let service: SessionService;

  beforeEach(async () => {
    ds = new DataSource({
      type: "better-sqlite3",
      database: ":memory:",
      entities: [Session, PendingMessage, LlmCall, SessionMessage],
      synchronize: true,
    });
    await ds.initialize();
    // checkpointer 两张表手工建（生产由集成包自建）
    await ds.query(`
      CREATE TABLE checkpoints (
        thread_id TEXT NOT NULL,
        checkpoint_ns TEXT NOT NULL DEFAULT '',
        checkpoint_id TEXT NOT NULL,
        PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id)
      )
    `);
    await ds.query(`
      CREATE TABLE writes (
        thread_id TEXT NOT NULL,
        checkpoint_ns TEXT NOT NULL DEFAULT '',
        checkpoint_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        idx INTEGER NOT NULL,
        PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id, task_id, idx)
      )
    `);
    const llmCalls = new LlmCallService(ds.getRepository(LlmCall));
    const sessionMessages = new SessionMessageService(
      ds.getRepository(SessionMessage),
    );
    const checkpointer = new CheckpointerCleanupService(ds);
    service = new SessionService(
      ds.getRepository(Session),
      ds.getRepository(PendingMessage),
      llmCalls,
      sessionMessages,
      checkpointer,
    );
    // 暴露给 deleteSession 测试用
    (service as unknown as { __ds: DataSource }).__ds = ds;
  });

  afterEach(async () => {
    await ds.destroy();
  });

  it("createSession 建会话(running) + 写首条 pending 消息", async () => {
    const { sessionId } = await service.createSession({ content: "你好世界" });
    const session = await service.findSessionOrFail(sessionId);
    expect(session.status).toBe("running");
    const pending = await service.listActivePending(sessionId);
    expect(pending).toHaveLength(1);
    expect(pending[0].content).toBe("你好世界");
    expect(pending[0].status).toBe("pending");
  });

  it("createSession 用 content 前 30 字作 title", async () => {
    const long = "a".repeat(50);
    const { sessionId } = await service.createSession({ content: long });
    const session = await service.findSessionOrFail(sessionId);
    expect(session.title).toBe("a".repeat(30));
  });

  it("appendMessage 写 pending 消息并返回 queued 标志", async () => {
    const { sessionId } = await service.createSession({ content: "first" });
    const res = await service.appendMessage(sessionId, {
      messageId: randomUUID(),
      content: "second",
    });
    expect(res.queued).toBe(true);
    const pending = await service.listActivePending(sessionId);
    expect(pending).toHaveLength(2);
  });

  it("claimPending 把 pending 批量转 processing 并返回", async () => {
    const { sessionId } = await service.createSession({ content: "m1" });
    await service.appendMessage(sessionId, {
      messageId: randomUUID(),
      content: "m2",
    });
    const claimed = await service.claimPending(sessionId);
    expect(claimed.map((m) => m.content)).toEqual(["m1", "m2"]);
    const stillActive = await service.listActivePending(sessionId);
    expect(stillActive.every((m) => m.status === "processing")).toBe(true);
  });

  it("markProcessed 把消息转 processed 并写 processed_at", async () => {
    const { sessionId } = await service.createSession({ content: "m1" });
    const claimed = await service.claimPending(sessionId);
    await service.markProcessed(claimed.map((m) => m.id));
    const pending = await service.listActivePending(sessionId);
    expect(pending).toHaveLength(0);
  });

  it("rollbackProcessingToPending 把 processing 退回 pending", async () => {
    const { sessionId } = await service.createSession({ content: "m1" });
    await service.claimPending(sessionId);
    const n = await service.rollbackProcessingToPending();
    expect(n).toBe(1);
    const pending = await service.listActivePending(sessionId);
    expect(pending[0].status).toBe("pending");
  });

  it("findSessionOrFail 对不存在的会话抛 NotFoundException", async () => {
    await expect(service.findSessionOrFail("nonexistent")).rejects.toThrow(
      NotFoundException,
    );
  });

  it("appendMessage 在 idle 会话上返回 queued:false", async () => {
    const { sessionId } = await service.createSession({ content: "m1" });
    await service.setStatus(sessionId, "idle");
    const res = await service.appendMessage(sessionId, {
      messageId: randomUUID(),
      content: "m2",
    });
    expect(res.queued).toBe(false);
  });

  it("markProcessed 写入 processed_at", async () => {
    const { sessionId } = await service.createSession({ content: "m1" });
    const claimed = await service.claimPending(sessionId);
    await service.markProcessed(claimed.map((m) => m.id));
    const repo = ds.getRepository(PendingMessage);
    const row = await repo.findOneBy({ id: claimed[0].id });
    expect(row?.status).toBe("processed");
    expect(row?.processedAt).not.toBeNull();
  });

  it("rollbackToPending 把指定消息退回 pending", async () => {
    const { sessionId } = await service.createSession({ content: "m1" });
    const claimed = await service.claimPending(sessionId);
    await service.rollbackToPending(claimed.map((m) => m.id));
    const active = await service.listActivePending(sessionId);
    expect(active.every((m) => m.status === "pending")).toBe(true);
  });

  it("markFailed 把消息标 failed", async () => {
    const { sessionId } = await service.createSession({ content: "m1" });
    const claimed = await service.claimPending(sessionId);
    await service.markFailed(claimed.map((m) => m.id));
    const active = await service.listActivePending(sessionId);
    expect(active).toHaveLength(1);
    expect(active[0].status).toBe("failed");
  });

  it("listActivePending 包含 failed 状态消息", async () => {
    const { sessionId } = await service.createSession({ content: "m1" });
    const claimed = await service.claimPending(sessionId);
    await service.markFailed(claimed.map((m) => m.id));
    const active = await service.listActivePending(sessionId);
    expect(active.some((m) => m.status === "failed")).toBe(true);
  });

  it("claimFailed 把 failed 消息批量转 processing 并返回", async () => {
    const { sessionId } = await service.createSession({ content: "m1" });
    const claimed = await service.claimPending(sessionId);
    await service.markFailed(claimed.map((m) => m.id));
    const reclaimed = await service.claimFailed(sessionId);
    expect(reclaimed).toHaveLength(1);
    expect(reclaimed[0].status).toBe("processing");
    const active = await service.listActivePending(sessionId);
    expect(active.every((m) => m.status === "processing")).toBe(true);
  });

  it("deletePendingMessage 删 status=pending 返回 content", async () => {
    const { sessionId } = await service.createSession({ content: "m1" });
    const messageId = randomUUID();
    await service.appendMessage(sessionId, { messageId, content: "to delete" });
    const res = await service.deletePendingMessage(sessionId, messageId);
    expect(res).toEqual({ content: "to delete" });
    const remaining = await service.listActivePending(sessionId);
    expect(remaining.find((m) => m.id === messageId)).toBeUndefined();
  });

  it("deletePendingMessage 对 status=processing 抛 ConflictException", async () => {
    const { sessionId } = await service.createSession({ content: "m1" });
    const claimed = await service.claimPending(sessionId);
    expect(claimed[0].status).toBe("processing");
    await expect(
      service.deletePendingMessage(sessionId, claimed[0].id),
    ).rejects.toThrow(ConflictException);
  });

  it("deletePendingMessage 对 status=failed 抛 ConflictException", async () => {
    const { sessionId } = await service.createSession({ content: "m1" });
    const claimed = await service.claimPending(sessionId);
    await service.markFailed([claimed[0].id]);
    await expect(
      service.deletePendingMessage(sessionId, claimed[0].id),
    ).rejects.toThrow(ConflictException);
  });

  it("deletePendingMessage 对 status=processed 抛 ConflictException", async () => {
    const { sessionId } = await service.createSession({ content: "m1" });
    const claimed = await service.claimPending(sessionId);
    await service.markProcessed([claimed[0].id]);
    await expect(
      service.deletePendingMessage(sessionId, claimed[0].id),
    ).rejects.toThrow(ConflictException);
  });

  it("deletePendingMessage 对不存在的 messageId 抛 NotFoundException", async () => {
    const { sessionId } = await service.createSession({ content: "m1" });
    await expect(
      service.deletePendingMessage(sessionId, randomUUID()),
    ).rejects.toThrow(NotFoundException);
  });

  it("deletePendingMessage 跨 session 删抛 NotFoundException（不暴露存在性）", async () => {
    const { sessionId: sA } = await service.createSession({ content: "a" });
    const { sessionId: sB } = await service.createSession({ content: "b" });
    const messageId = randomUUID();
    await service.appendMessage(sB, { messageId, content: "in b" });
    await expect(service.deletePendingMessage(sA, messageId)).rejects.toThrow(
      NotFoundException,
    );
    const stillInB = await service.listActivePending(sB);
    expect(stillInB.find((m) => m.id === messageId)).toBeDefined();
  });

  describe("listAllSorted", () => {
    it("已固定优先；都固定按 pinnedAt desc；未固定按 updatedAt desc", async () => {
      const a = await service.createSession({ content: "A" });
      await new Promise((r) => setTimeout(r, 10));
      const b = await service.createSession({ content: "B" });
      await new Promise((r) => setTimeout(r, 10));
      const c = await service.createSession({ content: "C" });
      await new Promise((r) => setTimeout(r, 10));
      const d = await service.createSession({ content: "D" });

      await service.patch(b.sessionId, { pinned: true });
      await new Promise((r) => setTimeout(r, 10));
      await service.patch(d.sessionId, { pinned: true });

      const rows = await service.listAllSorted();
      const ids = rows.map((s) => s.id);
      expect(ids).toEqual([d.sessionId, b.sessionId, c.sessionId, a.sessionId]);
    });

    it("空列表返 []", async () => {
      const rows = await service.listAllSorted();
      expect(rows).toEqual([]);
    });
  });

  describe("patch", () => {
    it("更新 title", async () => {
      const { sessionId } = await service.createSession({ content: "old" });
      const updated = await service.patch(sessionId, { title: "new title" });
      expect(updated.title).toBe("new title");
    });

    it("pinned=true 写 pinned_at；pinned=false 置 null", async () => {
      const { sessionId } = await service.createSession({ content: "x" });
      let s = await service.patch(sessionId, { pinned: true });
      expect(s.pinnedAt).not.toBeNull();
      s = await service.patch(sessionId, { pinned: false });
      expect(s.pinnedAt).toBeNull();
    });

    it("同时更新 title 和 pinned", async () => {
      const { sessionId } = await service.createSession({ content: "x" });
      const s = await service.patch(sessionId, {
        title: "T",
        pinned: true,
      });
      expect(s.title).toBe("T");
      expect(s.pinnedAt).not.toBeNull();
    });

    it("不存在的 id 抛 NotFoundException", async () => {
      await expect(service.patch("nope", { title: "x" })).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe("deleteSession", () => {
    async function seedAll(sessionId: string): Promise<void> {
      const ds = (service as unknown as { __ds: DataSource }).__ds;
      await ds.query(
        `INSERT INTO session_messages (id, session_id, role, content) VALUES (?, ?, 'user', 'x')`,
        [`msg-${sessionId}`, sessionId],
      );
      await ds.query(
        `INSERT INTO llm_calls (id, session_id, message_id, provider_type, model, input_tokens, output_tokens, total_tokens, cache_read_tokens, cache_creation_tokens, reasoning_tokens, duration_ms) VALUES (?, ?, 'm', 'p', 'mo', 0, 0, 0, 0, 0, 0, 0)`,
        [`call-${sessionId}`, sessionId],
      );
      await ds.query(
        `INSERT INTO checkpoints (thread_id, checkpoint_id) VALUES (?, 'c')`,
        [sessionId],
      );
      await ds.query(
        `INSERT INTO writes (thread_id, checkpoint_id, task_id, idx) VALUES (?, 'c', 't', 0)`,
        [sessionId],
      );
    }
    it("级联删 sessions + pending + session_messages + llm_calls + checkpointer", async () => {
      const { sessionId } = await service.createSession({ content: "x" });
      await seedAll(sessionId);
      await service.deleteSession(sessionId);
      const ds = (service as unknown as { __ds: DataSource }).__ds;
      expect(
        await ds.query(`SELECT 1 FROM sessions WHERE id = ?`, [sessionId]),
      ).toHaveLength(0);
      expect(
        await ds.query(`SELECT 1 FROM pending_messages WHERE session_id = ?`, [
          sessionId,
        ]),
      ).toHaveLength(0);
      expect(
        await ds.query(`SELECT 1 FROM session_messages WHERE session_id = ?`, [
          sessionId,
        ]),
      ).toHaveLength(0);
      expect(
        await ds.query(`SELECT 1 FROM llm_calls WHERE session_id = ?`, [
          sessionId,
        ]),
      ).toHaveLength(0);
      expect(
        await ds.query(`SELECT 1 FROM checkpoints WHERE thread_id = ?`, [
          sessionId,
        ]),
      ).toHaveLength(0);
      expect(
        await ds.query(`SELECT 1 FROM writes WHERE thread_id = ?`, [sessionId]),
      ).toHaveLength(0);
    });

    it("不影响其他 session", async () => {
      const s1 = await service.createSession({ content: "a" });
      const s2 = await service.createSession({ content: "b" });
      await seedAll(s1.sessionId);
      await seedAll(s2.sessionId);
      await service.deleteSession(s1.sessionId);
      const ds = (service as unknown as { __ds: DataSource }).__ds;
      expect(
        await ds.query(`SELECT 1 FROM sessions WHERE id = ?`, [s2.sessionId]),
      ).toHaveLength(1);
    });

    it("不存在 id 抛 NotFoundException", async () => {
      await expect(service.deleteSession("nope")).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe("createSession 返回 SessionSummary", () => {
    it("返 sessionId + session 完整对象", async () => {
      const r = await service.createSession({ content: "hello" });
      expect(r.sessionId).toBeDefined();
      expect(r.session.id).toBe(r.sessionId);
      expect(r.session.title).toBe("hello");
      expect(r.session.status).toBe("running");
      expect(r.session.pinned).toBe(false);
      expect(r.session.pinnedAt).toBeNull();
      expect(typeof r.session.createdAt).toBe("string");
      expect(typeof r.session.updatedAt).toBe("string");
    });
  });
});
