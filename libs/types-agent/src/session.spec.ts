import { describe, expect, it } from "@jest/globals";
import {
  CreateSessionResponseSchema,
  CreateSessionSchema,
  HistoryResponseSchema,
  PendingMessageStatus,
  RetryResponseSchema,
  RunChunkEventSchema,
  RunCompactionDoneEventSchema,
  RunCompactionErrorEventSchema,
  RunCompactionStartEventSchema,
  RunUsageEventSchema,
  SESSION_WS_EVENTS,
  SessionDeleteResponseSchema,
  SessionListResponseSchema,
  SessionPatchSchema,
  SessionStatus,
  SessionSummarySchema,
  SessionTitleUpdatedEventSchema,
  SessionTotalsSchema,
  SessionUsageSchema,
} from "./session";

describe("session schemas", () => {
  it("CreateSessionSchema 接受非空 content", () => {
    expect(CreateSessionSchema.parse({ content: "hello" })).toEqual({
      content: "hello",
    });
  });

  it("CreateSessionSchema 拒绝空 content", () => {
    expect(() => CreateSessionSchema.parse({ content: "" })).toThrow();
  });

  it("CreateSessionSchema 接受非空 agentId", () => {
    expect(
      CreateSessionSchema.parse({ content: "hello", agentId: "agent-1" }),
    ).toEqual({ content: "hello", agentId: "agent-1" });
  });

  it("CreateSessionSchema 拒绝空字符串 agentId（防止绕过兜底落库空串）", () => {
    expect(() =>
      CreateSessionSchema.parse({ content: "hello", agentId: "" }),
    ).toThrow();
  });

  it("CreateSessionSchema 未传 agentId 时省略该字段（走 Controller 兜底）", () => {
    expect(CreateSessionSchema.parse({ content: "hello" })).toEqual({
      content: "hello",
    });
  });

  it("CreateSessionSchema 接受非空 modelConfigId", () => {
    expect(
      CreateSessionSchema.parse({ content: "hello", modelConfigId: "mc-1" }),
    ).toEqual({ content: "hello", modelConfigId: "mc-1" });
  });

  it("CreateSessionSchema 拒绝空字符串 modelConfigId（防止绕过三级优先级落库空串，缺陷 1）", () => {
    expect(() =>
      CreateSessionSchema.parse({ content: "hello", modelConfigId: "" }),
    ).toThrow();
  });

  it("SessionStatus 枚举包含 idle / running", () => {
    expect(SessionStatus.options).toEqual(["idle", "running"]);
  });

  it("RunChunkEventSchema 校验流式 chunk 载荷", () => {
    const payload = { sessionId: "s1", messageId: "m1", delta: "tok" };
    expect(RunChunkEventSchema.parse(payload)).toEqual(payload);
  });

  it("PendingMessageStatus 包含 failed", () => {
    expect(PendingMessageStatus.options).toEqual([
      "pending",
      "processing",
      "processed",
      "failed",
    ]);
  });

  it("RetryResponseSchema 校验 retried 标志", () => {
    expect(RetryResponseSchema.parse({ retried: true })).toEqual({
      retried: true,
    });
  });

  it("SessionUsageSchema 校验完整 usage 载荷", () => {
    const u = {
      sessionTotals: {
        inputTokens: 100,
        outputTokens: 50,
        totalTokens: 150,
        cacheReadTokens: 10,
        cacheCreationTokens: 5,
        reasoningTokens: 0,
        callCount: 2,
        lastInputTokens: 100,
      },
      byMessage: {
        "msg-1": {
          providerType: "deepseek",
          model: "deepseek-chat",
          inputTokens: 60,
          outputTokens: 30,
          totalTokens: 90,
          cacheReadTokens: 10,
          cacheCreationTokens: 0,
          reasoningTokens: 0,
          durationMs: 1200,
        },
      },
    };
    expect(SessionUsageSchema.parse(u)).toEqual(u);
  });

  it("RunUsageEventSchema 校验 socket 事件载荷", () => {
    const e = {
      sessionId: "s1",
      messageId: "msg-1",
      providerType: "deepseek",
      model: "deepseek-chat",
      inputTokens: 60,
      outputTokens: 30,
      totalTokens: 90,
      cacheReadTokens: 10,
      cacheCreationTokens: 0,
      reasoningTokens: 0,
      durationMs: 1200,
    };
    expect(RunUsageEventSchema.parse(e)).toEqual(e);
  });

  it("HistoryResponseSchema 含分页 + usage 字段", () => {
    const r = {
      messages: [],
      hasMore: false,
      inflight: null,
      sessionTotals: {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        reasoningTokens: 0,
        callCount: 0,
        lastInputTokens: 0,
      },
      byMessage: {},
    };
    expect(HistoryResponseSchema.parse(r)).toEqual(r);
  });

  it("SESSION_WS_EVENTS.runUsage 常量存在", () => {
    expect(SESSION_WS_EVENTS.runUsage).toBe("run.usage");
  });
});

describe("session schemas — sidebar list", () => {
  it("SessionSummarySchema 通过基本字段", () => {
    const ok = SessionSummarySchema.parse({
      id: "s1",
      title: "hi",
      status: "idle",
      pinned: false,
      pinnedAt: null,
      titleGenerated: false,
      modelConfigId: null,
      createdAt: "2026-05-24T00:00:00.000Z",
      updatedAt: "2026-05-24T00:00:00.000Z",
    });
    expect(ok.pinned).toBe(false);
  });

  it("SessionPatchSchema 至少传 title 或 pinned 之一", () => {
    expect(() => SessionPatchSchema.parse({})).toThrow();
    expect(SessionPatchSchema.parse({ title: "x" }).title).toBe("x");
    expect(SessionPatchSchema.parse({ pinned: true }).pinned).toBe(true);
    expect(SessionPatchSchema.parse({ title: "x", pinned: true }).title).toBe(
      "x",
    );
  });

  it("SessionPatchSchema 限制 title 长度 1..200", () => {
    expect(() => SessionPatchSchema.parse({ title: "" })).toThrow();
    expect(() =>
      SessionPatchSchema.parse({ title: "x".repeat(201) }),
    ).toThrow();
  });

  it("SessionPatchSchema 接受非空 modelConfigId", () => {
    expect(
      SessionPatchSchema.parse({ modelConfigId: "mc-1" }).modelConfigId,
    ).toBe("mc-1");
  });

  it("SessionPatchSchema 拒绝空字符串 modelConfigId（防止绕过三级优先级落库空串，缺陷 1）", () => {
    expect(() => SessionPatchSchema.parse({ modelConfigId: "" })).toThrow();
  });

  it("SessionListResponseSchema 是 sessions 数组", () => {
    const ok = SessionListResponseSchema.parse({ sessions: [] });
    expect(ok.sessions).toEqual([]);
  });

  it("CreateSessionResponseSchema 同时带 sessionId 和 session", () => {
    const r = CreateSessionResponseSchema.parse({
      sessionId: "s1",
      session: {
        id: "s1",
        title: "hi",
        status: "running",
        pinned: false,
        pinnedAt: null,
        titleGenerated: false,
        modelConfigId: null,
        createdAt: "2026-05-24T00:00:00.000Z",
        updatedAt: "2026-05-24T00:00:00.000Z",
      },
    });
    expect(r.sessionId).toBe("s1");
  });

  it("SessionDeleteResponseSchema 必须 deleted=true", () => {
    expect(SessionDeleteResponseSchema.parse({ deleted: true }).deleted).toBe(
      true,
    );
    expect(() =>
      SessionDeleteResponseSchema.parse({ deleted: false }),
    ).toThrow();
  });
});

describe("session schemas — title generation", () => {
  it("SessionSummarySchema 含 titleGenerated 字段", () => {
    const ok = SessionSummarySchema.parse({
      id: "s1",
      title: "hi",
      status: "idle",
      pinned: false,
      pinnedAt: null,
      titleGenerated: true,
      modelConfigId: null,
      createdAt: "2026-05-24T00:00:00.000Z",
      updatedAt: "2026-05-24T00:00:00.000Z",
    });
    expect(ok.titleGenerated).toBe(true);
  });

  it("SessionSummarySchema 缺 titleGenerated 直接 reject", () => {
    expect(() =>
      SessionSummarySchema.parse({
        id: "s1",
        title: "hi",
        status: "idle",
        pinned: false,
        pinnedAt: null,
        createdAt: "2026-05-24T00:00:00.000Z",
        updatedAt: "2026-05-24T00:00:00.000Z",
      }),
    ).toThrow();
  });

  it("SessionTitleUpdatedEventSchema 必传 sessionId + title", () => {
    const ok = SessionTitleUpdatedEventSchema.parse({
      sessionId: "s1",
      title: "Title",
    });
    expect(ok).toEqual({ sessionId: "s1", title: "Title" });
    expect(() =>
      SessionTitleUpdatedEventSchema.parse({ sessionId: "s1" }),
    ).toThrow();
  });

  it("SESSION_WS_EVENTS.titleUpdated 常量存在", () => {
    expect(SESSION_WS_EVENTS.titleUpdated).toBe("session.title_updated");
  });
});

describe("Context compaction WS events", () => {
  it("RunCompactionStartEvent: reason 必须是 threshold 或 ctx-exceeded", () => {
    expect(
      RunCompactionStartEventSchema.parse({
        sessionId: "s1",
        reason: "threshold",
      }),
    ).toEqual({ sessionId: "s1", reason: "threshold" });
    expect(() =>
      RunCompactionStartEventSchema.parse({ sessionId: "s1", reason: "bogus" }),
    ).toThrow();
  });

  it("RunCompactionDoneEvent 含 removedCount + summaryPreview", () => {
    const v = RunCompactionDoneEventSchema.parse({
      sessionId: "s1",
      removedCount: 12,
      summaryPreview: "用户问了酒店评价…",
    });
    expect(v.removedCount).toBe(12);
    expect(v.summaryPreview).toBe("用户问了酒店评价…");
  });

  it("RunCompactionErrorEvent 仅 sessionId + error 字符串", () => {
    expect(
      RunCompactionErrorEventSchema.parse({
        sessionId: "s1",
        error: "timeout",
      }),
    ).toEqual({ sessionId: "s1", error: "timeout" });
  });

  it("SESSION_WS_EVENTS 包含三个 compaction 事件名", () => {
    expect(SESSION_WS_EVENTS.runCompactionStart).toBe("run.compaction_start");
    expect(SESSION_WS_EVENTS.runCompactionDone).toBe("run.compaction_done");
    expect(SESSION_WS_EVENTS.runCompactionError).toBe("run.compaction_error");
  });

  it("SessionTotalsSchema 含 lastInputTokens 字段", () => {
    const t = SessionTotalsSchema.parse({
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      reasoningTokens: 0,
      callCount: 1,
      lastInputTokens: 100,
    });
    expect(t.lastInputTokens).toBe(100);
  });
});
