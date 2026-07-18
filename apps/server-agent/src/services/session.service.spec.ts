import { randomUUID } from "node:crypto";
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from "@nestjs/common";
import { AccountContextService, ThreadStateService } from "@meshbot/lib-agent";
import type { CreateSessionInput } from "@meshbot/types-agent";
import { DataSource } from "typeorm";
import { ScopedRepositoryFactory } from "../account/scoped-repository.factory";
import { LlmCall } from "../entities/llm-call.entity";
import { PendingMessage } from "../entities/pending-message.entity";
import { Session } from "../entities/session.entity";
import { SessionMessage } from "../entities/session-message.entity";
import { CheckpointerCleanupService } from "./checkpointer-cleanup.service";
import { LlmCallService } from "./llm-call.service";
import { SessionMessageService } from "./session-message.service";
import { SessionService } from "./session.service";

/** 默认测试账号：作用域仓库要求每次调用都处于账号上下文内。 */
const DEFAULT_USER = "test-user";

/**
 * 本文件绝大多数用例不关心「会话归属哪个 Agent」这件事本身（专门测 agentId
 * 行为的用例会显式传值覆盖）；`createSession` 的 `agentId` 变必填后，若要求
 * 全文件几十处既有调用逐一补一个不relevant 的字面量，纯属噪音。故走
 * `service`（自动账号上下文代理）时，Proxy 在 createSession 一处兜底补默认值。
 */
const TEST_AGENT_ID = "test-agent-default";

/**
 * 供 `service`（Proxy）使用的宽松类型：createSession 的 agentId 允许省略
 * （由 Proxy 兜底注入），其余方法签名与真实 SessionService 完全一致。
 */
type ProxiedSessionService = Omit<SessionService, "createSession"> & {
  createSession(
    input: Omit<CreateSessionInput, "agentId"> & { agentId?: string },
  ): ReturnType<SessionService["createSession"]>;
};

describe("SessionService", () => {
  let ds: DataSource;
  let ctx: AccountContextService;
  /** 真实 service（不包账号上下文，供 ctx.run 显式包裹的隔离测试用）。 */
  let rawService: SessionService;
  /**
   * 自动包账号上下文的 service 代理：每个方法调用都跑在 DEFAULT_USER 上下文内，
   * 让既有单测无需逐一改写。隔离测试用 rawService + ctx.run 显式切账号。
   */
  let service: ProxiedSessionService;

  /**
   * 造一条最小 session 行，仅供只关心「父会话必须存在」但不关心其余字段的
   * 测试用——`createSubSession` 会读父会话的 agentId，需要一行真实的父记录
   * （此前这些测试用编造的雪花 id 当父会话 id，parent 本身从未真正建过）。
   */
  async function seedParentSession(id: string): Promise<void> {
    await ds.query(
      `INSERT INTO sessions (id, cloud_user_id, title, agent_id) VALUES (?, ?, 'seed-parent', 'seed-agent')`,
      [id, DEFAULT_USER],
    );
  }

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
    ctx = new AccountContextService();
    const scopedFactory = new ScopedRepositoryFactory(ctx);
    const llmCalls = new LlmCallService(
      ds.getRepository(LlmCall),
      scopedFactory,
    );
    const sessionMessages = new SessionMessageService(
      ds.getRepository(SessionMessage),
      scopedFactory,
      ctx,
    );
    // 假 ThreadStateService：cutMessagesAfter 记调用验证 regenerateAfter；clearThread 同步删
    // checkpoints/writes —— 生产里走该账号 checkpointer 的 better-sqlite3 连接，此处复用
    // ds 底层连接同步删，保持「deleteSession 级联删 checkpointer」断言成立。
    const fakeGraph = {
      __cuts: [] as Array<{ threadId: string; cutoff: string }>,
      async cutMessagesAfter(threadId: string, cutoffMessageId: string) {
        this.__cuts.push({ threadId, cutoff: cutoffMessageId });
      },
      clearThread(threadId: string) {
        const db = (
          ds.driver as unknown as {
            databaseConnection: {
              prepare(sql: string): { run(value: string): void };
            };
          }
        ).databaseConnection;
        db.prepare("DELETE FROM checkpoints WHERE thread_id = ?").run(threadId);
        db.prepare("DELETE FROM writes WHERE thread_id = ?").run(threadId);
      },
    };
    const checkpointer = new CheckpointerCleanupService(
      fakeGraph as unknown as ThreadStateService,
    );
    // 假 ScheduleService：deleteBySession 只记调用，验证 deleteSession 触达 schedules
    const fakeSchedules = {
      __deletions: [] as string[],
      async deleteBySession(sessionId: string) {
        this.__deletions.push(sessionId);
      },
    };
    // 假 ModelConfigService：白名单内的 id 视为存在，其余抛 NotFoundException
    // （真实实现按账号作用域查询，他账号 id 同样命中「不存在」路径）。
    const fakeModelConfigs = {
      __known: new Set<string>(["mc-exists"]),
      async findOneOrFail(id: string) {
        if (!this.__known.has(id)) {
          throw new (require("@nestjs/common").NotFoundException)(
            `ModelConfig ${id} not found`,
          );
        }
        return { id } as never;
      },
    };
    rawService = new SessionService(
      ds.getRepository(Session),
      ds.getRepository(PendingMessage),
      scopedFactory,
      llmCalls,
      sessionMessages,
      checkpointer,
      fakeGraph as unknown as ThreadStateService,
      fakeSchedules as unknown as any,
      fakeModelConfigs as unknown as any,
    );
    // 暴露给 deleteSession / regenerateAfter 测试用
    (
      rawService as unknown as { __ds: DataSource; __graph: typeof fakeGraph }
    ).__ds = ds;
    (
      rawService as unknown as { __ds: DataSource; __graph: typeof fakeGraph }
    ).__graph = fakeGraph;
    // 自动账号上下文代理：方法调用统一跑在 DEFAULT_USER 下，非函数属性透传。
    // createSession 额外兜底：未显式传 agentId 时补一个占位值（见 TEST_AGENT_ID 注释）。
    service = new Proxy(rawService, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          if (
            prop === "createSession" &&
            args[0] &&
            typeof args[0] === "object" &&
            (args[0] as { agentId?: string }).agentId === undefined
          ) {
            args = [
              { ...(args[0] as object), agentId: TEST_AGENT_ID },
              ...args.slice(1),
            ];
          }
          return ctx.run(DEFAULT_USER, () =>
            (value as (...a: unknown[]) => unknown).apply(target, args),
          );
        };
      },
    }) as unknown as ProxiedSessionService;
  });

  afterEach(async () => {
    await ds.destroy();
  });

  it("createSession 带 modelConfigId 落列；不带则为 NULL", async () => {
    const { sessionId } = await service.createSession({
      content: "选模型",
      modelConfigId: "mc-exists",
    });
    const repo = (
      rawService as unknown as { __ds: DataSource }
    ).__ds.getRepository(Session);
    const row = await repo.findOneByOrFail({ id: sessionId });
    expect(row.modelConfigId).toBe("mc-exists");

    const { sessionId: sid2 } = await service.createSession({
      content: "默认",
    });
    const row2 = await repo.findOneByOrFail({ id: sid2 });
    expect(row2.modelConfigId).toBeNull();
  });

  it("patch modelConfigId 合法 → 落列（下一条消息生效的会话级切换）", async () => {
    const { sessionId } = await service.createSession({ content: "hi" });
    await service.patch(sessionId, { modelConfigId: "mc-exists" });
    const repo = (
      rawService as unknown as { __ds: DataSource }
    ).__ds.getRepository(Session);
    const row = await repo.findOneByOrFail({ id: sessionId });
    expect(row.modelConfigId).toBe("mc-exists");
  });

  it("patch modelConfigId 不存在 → NotFoundException 且不落列", async () => {
    const { sessionId } = await service.createSession({ content: "hi" });
    await expect(
      service.patch(sessionId, { modelConfigId: "mc-ghost" }),
    ).rejects.toThrow(/not found/);
    const repo = (
      rawService as unknown as { __ds: DataSource }
    ).__ds.getRepository(Session);
    const row = await repo.findOneByOrFail({ id: sessionId });
    expect(row.modelConfigId).toBeNull();
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

  it("createSession 默认标题剔除 <llmuse> 块", async () => {
    const { sessionId } = await service.createSession({
      content:
        "<llmuse>\n页面: 消息\n会话: Test06 (dm, id=1), 未读 0\n</llmuse>\n你好世界",
    });
    const session = await service.findSessionOrFail(sessionId);
    expect(session.title).toBe("你好世界");
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

  it("listActivePendingWithHistory 标注 inHistory（已入 session_messages 为 true）", async () => {
    const { sessionId } = await service.createSession({ content: "m1" });
    const claimed = await service.claimPending(sessionId);
    await service.markFailed(claimed.map((m) => m.id));
    // 第一条 failed 已落入 session_messages（模拟 run.human 已记录），第二条没有
    const ds = (service as unknown as { __ds: DataSource }).__ds;
    await ds.query(
      `INSERT INTO session_messages (id, langgraph_id, session_id, cloud_user_id, role, content, seq) VALUES (?, ?, ?, ?, 'user', 'm1', 1)`,
      ["hist-1", claimed[0].id, sessionId, DEFAULT_USER],
    );
    const rows = await service.listActivePendingWithHistory(sessionId);
    const target = rows.find((r) => r.id === claimed[0].id);
    expect(target?.inHistory).toBe(true);
    // 再追加一条全新的 pending（未入库）→ inHistory=false
    await service.appendMessage(sessionId, {
      messageId: "fresh-pending",
      content: "fresh",
    });
    const rows2 = await service.listActivePendingWithHistory(sessionId);
    expect(rows2.find((r) => r.id === "fresh-pending")?.inHistory).toBe(false);
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
      const b = await service.createSession({ content: "B" });
      const c = await service.createSession({ content: "C" });
      const d = await service.createSession({ content: "D" });

      // 显式盖确定性时间戳，避免依赖墙钟（SQLite datetime 秒精度 + 同秒内
      // updated_at 相等会让 id desc（随机 UUID）成 tie-breaker，导致 flaky）。
      // b/d 固定：d 的 pinned_at 更晚 → 固定组里 d 在 b 前。
      // a/c 未固定：c 的 updated_at 更晚 → 未固定组里 c 在 a 前。
      const db = (service as unknown as { __ds: DataSource }).__ds;
      await db.query(`UPDATE sessions SET updated_at = ? WHERE id = ?`, [
        "2026-01-01 00:00:01",
        a.sessionId,
      ]);
      await db.query(`UPDATE sessions SET updated_at = ? WHERE id = ?`, [
        "2026-01-01 00:00:02",
        c.sessionId,
      ]);
      await service.patch(b.sessionId, { pinned: true });
      await db.query(`UPDATE sessions SET pinned_at = ? WHERE id = ?`, [
        "2026-01-01 00:00:03",
        b.sessionId,
      ]);
      await service.patch(d.sessionId, { pinned: true });
      await db.query(`UPDATE sessions SET pinned_at = ? WHERE id = ?`, [
        "2026-01-01 00:00:04",
        d.sessionId,
      ]);

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
        `INSERT INTO session_messages (id, session_id, cloud_user_id, role, content) VALUES (?, ?, ?, 'user', 'x')`,
        [`msg-${sessionId}`, sessionId, DEFAULT_USER],
      );
      await ds.query(
        `INSERT INTO llm_calls (id, session_id, cloud_user_id, message_id, provider_type, model, input_tokens, output_tokens, total_tokens, cache_read_tokens, cache_creation_tokens, reasoning_tokens, duration_ms) VALUES (?, ?, ?, 'm', 'p', 'mo', 0, 0, 0, 0, 0, 0, 0)`,
        [`call-${sessionId}`, sessionId, DEFAULT_USER],
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
      expect(r.session.titleGenerated).toBe(false);
      expect(typeof r.session.createdAt).toBe("string");
      expect(typeof r.session.updatedAt).toBe("string");
    });
  });

  describe("agentId —— 会话绑定 Agent", () => {
    it("建会话必须带 agentId，并原样落库", async () => {
      await ctx.run("acct-1", async () => {
        const { sessionId } = await rawService.createSession({
          content: "新会话",
          agentId: "agent-1",
        });
        const found = await rawService.findOrNull(sessionId);
        expect(found?.agentId).toBe("agent-1");
      });
    });

    it("createSession 返回的 SessionSummary 也带 agentId（Task 12：前端按 agent 过滤会话列表用）", async () => {
      await ctx.run("acct-1", async () => {
        const { session } = await rawService.createSession({
          content: "新会话",
          agentId: "agent-2",
        });
        expect(session.agentId).toBe("agent-2");
      });
    });

    it("subagent 子会话继承父会话的 agentId", async () => {
      await ctx.run("acct-1", async () => {
        const parent = await rawService.createSession({
          content: "父",
          agentId: "agent-7",
        });
        const { subSessionId } = await rawService.createSubSession({
          parentSessionId: parent.sessionId,
          parentToolCallId: "tc-1",
          task: "子",
        });
        const child = await rawService.findOrNull(subSessionId);
        expect(child?.agentId).toBe("agent-7");
      });
    });
  });

  describe("patch / patchIfNotGenerated — title generation", () => {
    it("patch({ title }) 同步 mark titleGenerated=true", async () => {
      const { sessionId } = await service.createSession({ content: "old" });
      const before = await service.findSessionOrFail(sessionId);
      expect(before.titleGenerated).toBe(false);
      const after = await service.patch(sessionId, { title: "new title" });
      expect(after.title).toBe("new title");
      expect(after.titleGenerated).toBe(true);
    });

    it("patch({ pinned }) 不改 titleGenerated", async () => {
      const { sessionId } = await service.createSession({ content: "x" });
      const r = await service.patch(sessionId, { pinned: true });
      expect(r.titleGenerated).toBe(false);
    });

    it("patchIfNotGenerated：titleGenerated=false 时生效，返 SessionSummary + mark true", async () => {
      const { sessionId } = await service.createSession({ content: "x" });
      const r = await service.patchIfNotGenerated(sessionId, "LLM 生成");
      expect(r).not.toBeNull();
      expect(r?.title).toBe("LLM 生成");
      expect(r?.titleGenerated).toBe(true);
    });

    it("patchIfNotGenerated：titleGenerated=true 时返 null，不改数据", async () => {
      const { sessionId } = await service.createSession({ content: "x" });
      await service.patch(sessionId, { title: "user 改的" });
      const r = await service.patchIfNotGenerated(sessionId, "LLM 想覆盖");
      expect(r).toBeNull();
      const s = await service.findSessionOrFail(sessionId);
      expect(s.title).toBe("user 改的");
    });
  });

  describe("regenerateAfter", () => {
    async function seedSession(sessionId: string): Promise<void> {
      const ds = (service as unknown as { __ds: DataSource }).__ds;
      await ds.query(
        `INSERT INTO session_messages (id, session_id, cloud_user_id, role, content, seq, created_at) VALUES (?, ?, ?, 'user', '你好', 1, datetime('now', '-3 seconds'))`,
        [`u1-${sessionId}`, sessionId, DEFAULT_USER],
      );
      await ds.query(
        `INSERT INTO session_messages (id, session_id, cloud_user_id, role, content, seq, created_at) VALUES (?, ?, ?, 'assistant', '回复', 2, datetime('now', '-2 seconds'))`,
        [`a1-${sessionId}`, sessionId, DEFAULT_USER],
      );
      await ds.query(
        `INSERT INTO session_messages (id, session_id, cloud_user_id, role, content, seq, created_at) VALUES (?, ?, ?, 'user', '再问', 3, datetime('now', '-1 seconds'))`,
        [`u2-${sessionId}`, sessionId, DEFAULT_USER],
      );
      await ds.query(
        `INSERT INTO llm_calls (id, session_id, cloud_user_id, message_id, provider_type, model, input_tokens, output_tokens, total_tokens, cache_read_tokens, cache_creation_tokens, reasoning_tokens, duration_ms, created_at) VALUES (?, ?, ?, 'a1', 'p', 'm', 1, 1, 2, 0, 0, 0, 1, datetime('now', '-2 seconds'))`,
        [`call-a1-${sessionId}`, sessionId, DEFAULT_USER],
      );
    }

    it("regenerateAfter 删 cutoff 之后所有 session_messages + llm_calls", async () => {
      const { sessionId } = await service.createSession({ content: "x" });
      await seedSession(sessionId);
      await service.regenerateAfter(sessionId, `u1-${sessionId}`);
      const ds = (service as unknown as { __ds: DataSource }).__ds;
      const remain = await ds.query(
        `SELECT id FROM session_messages WHERE session_id = ? ORDER BY created_at`,
        [sessionId],
      );
      expect(remain.map((r: { id: string }) => r.id)).toEqual([
        `u1-${sessionId}`,
      ]);
      const calls = await ds.query(
        `SELECT id FROM llm_calls WHERE session_id = ?`,
        [sessionId],
      );
      expect(calls).toHaveLength(0);
      const graph = (
        service as unknown as {
          __graph: { __cuts: Array<{ threadId: string; cutoff: string }> };
        }
      ).__graph;
      expect(graph.__cuts).toEqual([
        { threadId: sessionId, cutoff: `u1-${sessionId}` },
      ]);
    });

    it("regenerateAfter 不存在 messageId 抛 NotFoundException", async () => {
      const { sessionId } = await service.createSession({ content: "x" });
      await expect(service.regenerateAfter(sessionId, "nope")).rejects.toThrow(
        NotFoundException,
      );
    });

    it("regenerateAfter messageId 不属于该 session 抛 NotFoundException", async () => {
      const a = await service.createSession({ content: "a" });
      const b = await service.createSession({ content: "b" });
      await seedSession(a.sessionId);
      await expect(
        service.regenerateAfter(b.sessionId, `u1-${a.sessionId}`),
      ).rejects.toThrow(NotFoundException);
    });

    it("regenerateAfter role != user 抛 BadRequestException", async () => {
      const { sessionId } = await service.createSession({ content: "x" });
      await seedSession(sessionId);
      await expect(
        service.regenerateAfter(sessionId, `a1-${sessionId}`),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe("createSubSession", () => {
    it("createSubSession 建 subagent 会话并带 parent 关联 + 首条 pending", async () => {
      const parent = await service.createSession({ content: "父任务" });
      const { subSessionId } = await service.createSubSession({
        parentSessionId: parent.sessionId,
        parentToolCallId: "tc-1",
        task: "子任务内容",
        description: "子任务",
      });
      const sub = await service.findOrNull(subSessionId);
      expect(sub?.kind).toBe("subagent");
      expect(sub?.parentSessionId).toBe(parent.sessionId);
      expect(sub?.parentToolCallId).toBe("tc-1");
      const pend = await service.listActivePending(subSessionId);
      expect(pend.map((p) => p.content)).toContain("子任务内容");
    });

    it("listAllSorted 不含 subagent 会话", async () => {
      const parent = await service.createSession({ content: "父" });
      const { subSessionId } = await service.createSubSession({
        parentSessionId: parent.sessionId,
        parentToolCallId: "tc",
        task: "子",
      });
      const all = await service.listAllSorted();
      const ids = all.map((s) => s.id);
      expect(ids).toContain(parent.sessionId);
      expect(ids).not.toContain(subSessionId);
    });

    it("listChildren 按父会话返回子会话 id + parentToolCallId；不含他父的子会话", async () => {
      const parentId = "990000000000000001";
      await seedParentSession(parentId);
      await seedParentSession("990000000000000002");
      expect(await service.listChildren(parentId)).toEqual([]);
      const a = await service.createSubSession({
        parentSessionId: parentId,
        parentToolCallId: "tc-1",
        task: "任务A",
      });
      const b = await service.createSubSession({
        parentSessionId: parentId,
        parentToolCallId: "tc-2",
        task: "任务B",
      });
      await service.createSubSession({
        parentSessionId: "990000000000000002",
        parentToolCallId: "tc-3",
        task: "他父的任务",
      });
      const rows = await service.listChildren(parentId);
      expect(new Map(rows.map((r) => [r.parentToolCallId, r.id]))).toEqual(
        new Map([
          ["tc-1", a.subSessionId],
          ["tc-2", b.subSessionId],
        ]),
      );
    });

    it("createSubSession 可写 background 与 modelConfigId；setBackground 可置回 0", async () => {
      await seedParentSession("990000000000000010");
      const { subSessionId } = await service.createSubSession({
        parentSessionId: "990000000000000010",
        parentToolCallId: "tc-bg",
        task: "后台任务",
        background: true,
        modelConfigId: "mc-1",
      });
      const row = await service.findOrNull(subSessionId);
      expect(row?.background).toBe(1);
      expect(row?.modelConfigId).toBe("mc-1");
      await service.setBackground(subSessionId, false);
      expect((await service.findOrNull(subSessionId))?.background).toBe(0);
    });

    it("缺省 background=0、modelConfigId=null（前台不受影响）", async () => {
      await seedParentSession("990000000000000010");
      const { subSessionId } = await service.createSubSession({
        parentSessionId: "990000000000000010",
        parentToolCallId: "tc-fg",
        task: "前台任务",
      });
      const row = await service.findOrNull(subSessionId);
      expect(row?.background).toBe(0);
      expect(row?.modelConfigId).toBeNull();
    });

    it("并发 3 路 createSubSession（同一父会话）全部成功建出 3 个子会话——不因 SQLite 单连接并发 BEGIN 报错", async () => {
      const parent = await service.createSession({ content: "父任务" });
      const results = await Promise.allSettled([
        service.createSubSession({
          parentSessionId: parent.sessionId,
          parentToolCallId: "tc-a",
          task: "任务A",
        }),
        service.createSubSession({
          parentSessionId: parent.sessionId,
          parentToolCallId: "tc-b",
          task: "任务B",
        }),
        service.createSubSession({
          parentSessionId: parent.sessionId,
          parentToolCallId: "tc-c",
          task: "任务C",
        }),
      ]);
      const rejected = results.filter(
        (r): r is PromiseRejectedResult => r.status === "rejected",
      );
      expect(rejected).toHaveLength(0);
      const fulfilled = results.filter(
        (r): r is PromiseFulfilledResult<{ subSessionId: string }> =>
          r.status === "fulfilled",
      );
      expect(fulfilled).toHaveLength(3);
      const children = await service.listChildren(parent.sessionId);
      expect(children).toHaveLength(3);
    });

    it("listPendingBackgroundSubagentsUnscoped 只返回 background=1 的 subagent 会话（跨账号）", async () => {
      await seedParentSession("990000000000000010");
      const a = await service.createSubSession({
        parentSessionId: "990000000000000010",
        parentToolCallId: "tc-1",
        task: "A",
        background: true,
      });
      await service.createSubSession({
        parentSessionId: "990000000000000010",
        parentToolCallId: "tc-2",
        task: "B",
      });
      const rows = await rawService.listPendingBackgroundSubagentsUnscoped();
      expect(rows.map((r) => r.id)).toContain(a.subSessionId);
      expect(rows.every((r) => r.parentSessionId && r.cloudUserId)).toBe(true);
      expect(rows.find((r) => r.parentToolCallId === "tc-2")).toBeUndefined();
    });
  });

  describe("quick sessions", () => {
    it("createSession(kind='quick') 建的会话不出现在 listAllSorted()", async () => {
      await service.createSession({ content: "临时问题", kind: "quick" });
      const list = await service.listAllSorted();
      expect(list).toHaveLength(0);
    });

    it("listQuickSessions() 只返回 quick 会话", async () => {
      await service.createSession({ content: "正常", kind: "user" });
      const { sessionId } = await service.createSession({
        content: "随手",
        kind: "quick",
      });
      const quick = await service.listQuickSessions();
      expect(quick.map((s) => s.id)).toEqual([sessionId]);
    });

    it("promoteToSidebar() 把 quick 提升为 user，进入 listAllSorted、移出 listQuickSessions", async () => {
      const { sessionId } = await service.createSession({
        content: "随手",
        kind: "quick",
      });
      const summary = await service.promoteToSidebar(sessionId);
      expect(summary.id).toBe(sessionId);
      expect((await service.listAllSorted()).map((s) => s.id)).toContain(
        sessionId,
      );
      expect(await service.listQuickSessions()).toHaveLength(0);
    });
  });

  describe("countCreatedSince", () => {
    it("排除 kind=subagent 会话，user/quick 仍计入", async () => {
      await service.createSession({ content: "u1" });
      await service.createSession({ content: "q1", kind: "quick" });
      const parent = await service.createSession({ content: "父" });
      await service.createSubSession({
        parentSessionId: parent.sessionId,
        parentToolCallId: "tc",
        task: "子任务",
      });
      // parent(user) + u1(user) + q1(quick) = 3；subagent 不计入
      expect(await service.countCreatedSince(null)).toBe(3);
    });

    it("since 有值时按时间过滤，subagent 排除规则仍生效", async () => {
      const parent = await service.createSession({ content: "父" });
      await service.createSubSession({
        parentSessionId: parent.sessionId,
        parentToolCallId: "tc",
        task: "子任务",
      });
      const since = new Date(Date.now() - 60_000);
      // parent 一条 user 会话落在 since 之后；subagent 会话本该落在范围内但被排除
      expect(await service.countCreatedSince(since)).toBe(1);
    });
  });

  describe("listOrphanForegroundSubagentsUnscoped", () => {
    it("只挑 kind=subagent 且 background=0 且仍有活跃 pending 的会话（孤儿）", async () => {
      await seedParentSession("990000000000000030");
      // 正常跑完的前台子会话：pending 已 processed，无活跃条目 → 不是孤儿
      const doneSub = await service.createSubSession({
        parentSessionId: "990000000000000030",
        parentToolCallId: "tc-done",
        task: "已完成",
      });
      const doneClaimed = await service.claimPending(doneSub.subSessionId);
      await service.markProcessed(doneClaimed.map((m) => m.id));

      // 孤儿：前台子会话仍残留活跃 pending（进程重启前未跑完）
      const orphanSub = await service.createSubSession({
        parentSessionId: "990000000000000030",
        parentToolCallId: "tc-orphan",
        task: "孤儿",
      });

      // 后台子会话即使有活跃 pending，background=1 不算前台孤儿
      const bgSub = await service.createSubSession({
        parentSessionId: "990000000000000030",
        parentToolCallId: "tc-bg",
        task: "后台",
        background: true,
      });

      // 普通 user 会话即使有 pending 也不算（kind 过滤）
      await service.createSession({ content: "普通会话" });

      const rows = await rawService.listOrphanForegroundSubagentsUnscoped();
      expect(rows.map((r) => r.id)).toEqual([orphanSub.subSessionId]);
      expect(rows[0].cloudUserId).toBe(DEFAULT_USER);
      expect(rows.map((r) => r.id)).not.toContain(doneSub.subSessionId);
      expect(rows.map((r) => r.id)).not.toContain(bgSub.subSessionId);
    });

    it("无孤儿时返回空数组（零动作零日志的前提）", async () => {
      const parent = await service.createSession({ content: "父" });
      const sub = await service.createSubSession({
        parentSessionId: parent.sessionId,
        parentToolCallId: "tc",
        task: "子",
      });
      const claimed = await service.claimPending(sub.subSessionId);
      await service.markProcessed(claimed.map((m) => m.id));
      const rows = await rawService.listOrphanForegroundSubagentsUnscoped();
      expect(rows).toEqual([]);
    });
  });

  describe("resetRunningToIdle（启动恢复）", () => {
    it("把遗留 running 会话重置为 idle，跨账号全量（无账号上下文可调）", async () => {
      const a = await ctx.run("u1", () =>
        rawService.createSession({ content: "s-u1", agentId: TEST_AGENT_ID }),
      );
      const b = await ctx.run("u2", () =>
        rawService.createSession({ content: "s-u2", agentId: TEST_AGENT_ID }),
      );
      await ctx.run("u1", () => rawService.setStatus(a.sessionId, "running"));
      await ctx.run("u2", () => rawService.setStatus(b.sessionId, "running"));

      // 无账号上下文直接调（模拟 onModuleInit 启动时机）
      expect(await rawService.resetRunningToIdle()).toBe(2);

      const listU1 = await ctx.run("u1", () => rawService.listAllSorted());
      const listU2 = await ctx.run("u2", () => rawService.listAllSorted());
      expect(listU1[0].status).toBe("idle");
      expect(listU2[0].status).toBe("idle");
    });

    it("无遗留 running 时返回 0（零动作零日志的前提）", async () => {
      const s = await service.createSession({ content: "s" });
      await service.setStatus(s.sessionId, "idle");
      expect(await rawService.resetRunningToIdle()).toBe(0);
    });
  });

  describe("账号隔离（ScopedRepository）", () => {
    it("两账号会话互不可见", async () => {
      await ctx.run("u1", () =>
        rawService.createSession({ content: "s-u1", agentId: TEST_AGENT_ID }),
      );
      await ctx.run("u2", () =>
        rawService.createSession({ content: "s-u2", agentId: TEST_AGENT_ID }),
      );
      const listU1 = await ctx.run("u1", () => rawService.listAllSorted());
      expect(listU1).toHaveLength(1);
      expect(listU1[0].title).toBe("s-u1");
      const listU2 = await ctx.run("u2", () => rawService.listAllSorted());
      expect(listU2).toHaveLength(1);
      expect(listU2[0].title).toBe("s-u2");
    });

    it("跨账号取他人 session 返回空", async () => {
      const { sessionId } = await ctx.run("u1", () =>
        rawService.createSession({ content: "s", agentId: TEST_AGENT_ID }),
      );
      expect(
        await ctx.run("u2", () => rawService.findOrNull(sessionId)),
      ).toBeNull();
      // 同账号仍可见，确认不是「都查不到」的假阴性
      expect(
        await ctx.run("u1", () => rawService.findOrNull(sessionId)),
      ).not.toBeNull();
    });

    it("跨账号删他人 pending 消息不生效（NotFound）", async () => {
      const { sessionId } = await ctx.run("u1", () =>
        rawService.createSession({ content: "m1", agentId: TEST_AGENT_ID }),
      );
      const messageId = randomUUID();
      await ctx.run("u1", () =>
        rawService.appendMessage(sessionId, { messageId, content: "owned" }),
      );
      await expect(
        ctx.run("u2", () =>
          rawService.deletePendingMessage(sessionId, messageId),
        ),
      ).rejects.toThrow(NotFoundException);
      // u1 的消息仍在
      const stillThere = await ctx.run("u1", () =>
        rawService.listActivePending(sessionId),
      );
      expect(stillThere.find((m) => m.id === messageId)).toBeDefined();
    });

    it("无账号上下文调用作用域方法抛错", async () => {
      await expect(rawService.listAllSorted()).rejects.toThrow();
    });

    it("findOwner 无账号上下文反查归属账号（系统级，runner/cron 建上下文用）", async () => {
      const { sessionId } = await ctx.run("u1", () =>
        rawService.createSession({ content: "s", agentId: TEST_AGENT_ID }),
      );
      // 故意不包 ctx.run：findOwner 必须能在无账号上下文时跑（证明它是 unscoped）。
      expect(await rawService.findOwner(sessionId)).toBe("u1");
    });

    it("findOwner 未知 sessionId 返回 null", async () => {
      expect(await rawService.findOwner("nonexistent")).toBeNull();
    });

    it("rollbackProcessingToPending 跨账号全量重置（无上下文也可跑）", async () => {
      const u1 = await ctx.run("u1", () =>
        rawService.createSession({ content: "a", agentId: TEST_AGENT_ID }),
      );
      const u2 = await ctx.run("u2", () =>
        rawService.createSession({ content: "b", agentId: TEST_AGENT_ID }),
      );
      await ctx.run("u1", () => rawService.claimPending(u1.sessionId));
      await ctx.run("u2", () => rawService.claimPending(u2.sessionId));
      // 无账号上下文直接调用（模拟 RunnerService.onModuleInit boot 路径）
      const n = await rawService.rollbackProcessingToPending();
      expect(n).toBe(2);
      const a = await ctx.run("u1", () =>
        rawService.listActivePending(u1.sessionId),
      );
      expect(a[0].status).toBe("pending");
      const b = await ctx.run("u2", () =>
        rawService.listActivePending(u2.sessionId),
      );
      expect(b[0].status).toBe("pending");
    });
  });
});
