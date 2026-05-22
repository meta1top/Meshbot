import { describe, expect, it } from "@jest/globals";
import {
  CreateSessionSchema,
  PendingMessageStatus,
  RetryResponseSchema,
  RunChunkEventSchema,
  SessionStatus,
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
});
