import { describe, expect, it } from "@jest/globals";
import {
  CreateSessionSchema,
  HistoryResponseSchema,
  PendingMessageStatus,
  RetryResponseSchema,
  RunChunkEventSchema,
  RunUsageEventSchema,
  SESSION_WS_EVENTS,
  SessionStatus,
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

  it("HistoryResponseSchema 含 usage 字段", () => {
    const r = {
      messages: [],
      inflight: null,
      usage: {
        sessionTotals: {
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          reasoningTokens: 0,
          callCount: 0,
        },
        byMessage: {},
      },
    };
    expect(HistoryResponseSchema.parse(r)).toEqual(r);
  });

  it("SESSION_WS_EVENTS.runUsage 常量存在", () => {
    expect(SESSION_WS_EVENTS.runUsage).toBe("run.usage");
  });
});

import {
  CreateSessionResponseSchema,
  SessionDeleteResponseSchema,
  SessionListResponseSchema,
  SessionPatchSchema,
  SessionSummarySchema,
} from "./session";

describe("session schemas — sidebar list", () => {
  it("SessionSummarySchema 通过基本字段", () => {
    const ok = SessionSummarySchema.parse({
      id: "s1",
      title: "hi",
      status: "idle",
      pinned: false,
      pinnedAt: null,
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
